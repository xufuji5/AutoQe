import path from 'node:path'
import { defineGuard, err, info, warn } from '../lib/guard.ts'
import { scanColumns, scanScope } from '../lib/columns.ts'
import { readTextSafe, walkFiles } from '../lib/fs.ts'
import type { GuardContext } from '../lib/guard.ts'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/inv01-column-writer')

/** 任何页面都会出现的通用列名：用作「UI 可见」提示时只会制造噪音 */
const GENERIC_FIELD = /^(id|tenantId|userId|batchId|status|type|name|code|version|createdAt|updatedAt|deletedAt)$/

/**
 * 「这个字段名在页面层出现过吗」的名字级索引（.tsx 里的标识符计数）。
 * 只用来给死列分档，不做模型归属推断——用来回答「用户看不看得到这个空栏」，
 * 而不是「哪一行渲染了它」。同名跨模型的字段可能被误判为可见，属已知代价，已写入盲区。
 */
async function uiMentionIndex(ctx: GuardContext): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  const ext = ctx.config.source.extensions.length ? ctx.config.source.extensions : ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs']
  for (const dir of ctx.config.source.roots) {
    const files = await walkFiles(ctx.root, dir, { ignore: ctx.config.ignore, ext })
    for (const file of files) {
      if (!file.endsWith('.tsx')) continue
      const text = await readTextSafe(file)
      if (!text) continue
      for (const token of new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
        map.set(token, (map.get(token) ?? 0) + 1)
      }
    }
  }
  return map
}

export const inv01 = defineGuard({
  id: 'inv01-column-writer',
  title: '零写入列（活表死列）',
  invariants: ['INV-CORE-01'],
  blindSpots: [
    'Prisma Client 的 create/update 键认全；$executeRaw/$queryRaw 只按「DML + 表名」归属到模型并降级为「写入覆盖未知」，列级写入仍不可见',
    '归属不到模型的原生 SQL 写点只出 RAW_WRITE_UNATTRIBUTED 候选（warn），不判死列；候选只报应用面，evidenceRoots 的造数脚本不出候选',
    '依赖内部（PrismaAdapter 等）在运行期写入的模型，需用 fieldExemptions 的 field="*" 声明（理由必填）',
    '有 @default / @updatedAt 的列不判零写入（DB 侧有值来源）；默认值导致状态永不推进属 inv03 射程',
    '嵌套写（items: { create: [...] }）、DB 触发器不算业务写点',
    '同名但不同 model 的字段按 model 维度隔离，不做类型推理',
    'data 走函数返回值/跨文件构造时无法解析，标为「覆盖未知」并降级为 warn（不判死列）',
    '「UI 可见」按字段名在 .tsx 里出现判定（名字级，不做模型归属）；同名跨模型字段可能误判为可见',
  ],
  async run(ctx) {
    const scan = await scanColumns(ctx.root, ctx.config)
    const ui = await uiMentionIndex(ctx)
    const findings = []
    const uncertain = new Map<string, number>()
    const live = new Map<string, typeof scan.fields>()
    for (const f of scan.fields) {
      const entity = `${f.model}.${f.field}`
      if (f.exemptReason === '__EMPTY_REASON__') {
        findings.push(
          err('EMPTY_EXEMPTION', `${entity} 的豁免理由为空：豁免必须写明理由，否则等同永久豁免槽`, {
            entity,
            file: ctx.config.schema.path,
            line: f.line,
          }),
        )
        continue
      }
      if (f.exemptReason) continue
      // 有 DB 默认值的列不是「死列」：@default(now()) / @updatedAt 由数据库填值，
      // 业务代码不显式写属正常（旧判据把它计入零写入，目标仓实测 33/130 属这一类）。
      // 注意：默认值让状态停在某一值不走，属 inv03 死枚举的射程，不在这里重复计。
      if (f.defaulted) continue
      const bucket = live.get(f.model) ?? []
      bucket.push(f)
      live.set(f.model, bucket)
    }

    for (const [model, fields] of live) {
      const written = fields.some((f) => f.writers.length > 0)
      const unknown = fields.some((f) => f.unknownWriter)
      // 整表零写入：逐字段刷 N 条只会把真正的「用户可见空栏」淹掉，
      // 合成一条并列出列名，信息不丢、噪声从 N 降到 1。
      if (!written && !unknown) {
        const names = fields.map((f) => f.field)
        // 通用名（tenantId/status/...）在任何页面都会出现，放进「UI 可见」只会制造噪音，
        // 聚合档只提示有辨识度的列名。
        const visible = names.filter((n) => ui.has(n) && !GENERIC_FIELD.test(n))
        const shown = names.slice(0, 8).join('/') + (names.length > 8 ? ` 等 ${names.length} 列` : '')
        findings.push(
          err(
            'MODEL_UNUSED',
            `${model} 全模型零写入（${fields.length} 列：${shown}）${
              visible.length ? `；其中 ${visible.slice(0, 5).join('/')} 在 UI 里出现` : ''
            }：整表未接入，补写入链路或删表`,
            { entity: model, file: ctx.config.schema.path, line: fields[0].line },
          ),
        )
        continue
      }
      for (const f of fields) {
        if (f.writers.length > 0) continue
        if (f.unknownWriter) {
          uncertain.set(f.model, (uncertain.get(f.model) ?? 0) + 1)
          continue
        }
        const entity = `${f.model}.${f.field}`
        // 分档：页面在渲染 = 用户直接看到空栏（红）；页面没用到 = 冗余列（黄，可排期删）。
        if (ui.has(f.field)) {
          findings.push(
            err('ZERO_WRITER_RENDERED', `${entity}（列 ${f.column}）全仓零写入者但在页面出现：用户会看到永远空栏，补写入者或隐藏该栏`, {
              entity,
              file: ctx.config.schema.path,
              line: f.line,
            }),
          )
        } else {
          findings.push(
            warn('ZERO_WRITER_UNUSED', `${entity}（列 ${f.column}）全仓零写入者且页面未使用：冗余列，删列或声明存档`, {
              entity,
              file: ctx.config.schema.path,
              line: f.line,
            }),
          )
        }
      }
    }
    for (const [model, count] of uncertain) {
      findings.push(
        warn(
          'WRITE_COVERAGE_UNKNOWN',
          `${model} 有 ${count} 个标量字段的写入经变量/函数参数/展开/原生 SQL 传入，静态无法确认：按覆盖未知处理（需人工复核，不判死列）`,
          { entity: model, file: ctx.config.schema.path },
        ),
      )
    }
    // 原生 SQL 写点归属不到模型时只剩候选：没有表名就无法判断哪张表的哪一列，
    // 判死列会逼人删掉真实写入链路。evidenceRoots（测试/运维脚本）的写点是造数动作，
    // 不参与产品写入面候选（可归属的写点仍计入覆盖未知，见 columns.ts）。
    for (const raw of scan.rawWrites.filter((r) => r.models.length === 0 && !r.evidence)) {
      findings.push(
        warn(
          'RAW_WRITE_UNATTRIBUTED',
          `${raw.file}:${raw.line} 原生 SQL 写入（${raw.snippet}）无法归属到 schema 里的模型：写入覆盖未知，需人工复核`,
          { file: raw.file, line: raw.line },
        ),
      )
    }
    if (scan.fields.length === 0) {
      findings.push(err('EMPTY_SCAN', 'schema 解析到 0 个标量字段：判据空集恒真，视为射程失效'))
    } else if (findings.length === 0) {
      findings.push(info('ZERO_WRITER_CLEAN', `零写入列计数=0（标量字段 ${scan.fields.length} 个）`))
    }
    return { findings, scanned: scanScope(scan, ctx.config) }
  },
  selfTest: [
    {
      name: 'good：所有字段都有写点',
      root: path.join(FIXTURES, 'good'),
      expect: 'green',
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
    {
      name: 'bad：body 列零写入',
      root: path.join(FIXTURES, 'bad'),
      expect: 'red',
      minErrors: 1,
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
    {
      name: 'good：本地 const/展开写入可解析（旧判据会误报 body 零写入）',
      root: path.join(FIXTURES, 'spread'),
      expect: 'green',
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
    {
      name: 'warn：函数参数写入不可解析时降级为覆盖未知（旧判据会误报 ZERO_WRITER）',
      root: path.join(FIXTURES, 'unknown'),
      expect: 'warn',
      minWarnings: 1,
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
    {
      name: 'good：客户端由函数返回（await getClient()）也能识别写点（旧判据只认 prisma. 标识符）',
      root: path.join(FIXTURES, 'await-client'),
      expect: 'green',
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['getClient'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
    {
      name: 'good：同名变量按引用位置取最近声明（旧判据会被后一个声明覆盖）',
      root: path.join(FIXTURES, 'shadow'),
      expect: 'green',
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
    {
      name: 'good：有 DB 默认值的列不算死列（旧判据会把 @default(now()) 列报成零写入）',
      root: path.join(FIXTURES, 'defaulted'),
      expect: 'green',
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
    {
      name: 'warn：body 列零写入且页面未使用（旧判据一律按红报，会与「用户可见空栏」混在一起）',
      root: path.join(FIXTURES, 'unused-column'),
      expect: 'warn',
      minWarnings: 1,
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
    {
      name: 'red：整表零写入聚合为一条 MODEL_UNUSED（旧判据逐字段刷 N 条）',
      root: path.join(FIXTURES, 'model-unused'),
      expect: 'red',
      minErrors: 1,
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
    {
      name: 'warn：原生 SQL 写入按表名归属到模型，降级为覆盖未知（旧判据判死列）',
      root: path.join(FIXTURES, 'raw-sql-write'),
      expect: 'warn',
      minWarnings: 1,
      maxErrors: 0,
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
    {
      name: 'good：注释/字符串素材/只读 queryRaw 里的原生写字样不算写点（旧判据按窗口取词会出假候选）',
      root: path.join(FIXTURES, 'raw-sql-noise'),
      expect: 'green',
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
    {
      name: 'good：evidenceRoots 里的动态表名造数写点不出「应用面写入覆盖未知」候选（旧判据逐脚本刷 warn）',
      root: path.join(FIXTURES, 'evidence-raw-noise'),
      expect: 'green',
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], evidenceRoots: ['scripts'], extensions: [] },
      },
    },
    {
      name: 'good：适配器模型用 field="*" 模型级豁免（理由必填），旧判据会整表判死列',
      root: path.join(FIXTURES, 'adapter-model'),
      expect: 'green',
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
        fieldExemptions: [
          { model: 'Account', field: '*', reason: '由 @auth/prisma-adapter 在运行期写入，源码内无 data 键' },
        ],
      },
    },
  ],
})
