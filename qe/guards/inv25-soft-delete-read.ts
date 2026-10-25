/**
 * 软删表的一切读点都要带软删谓词（INV-CORE-05）。
 *
 * 这类缺陷失败得无声：查询照常返回，只是多给了已删除的行——列表、计数、导出、趋势
 * 全部「看起来对」，直到对账或客诉把数对出来。靠人肉记得加过滤，每条新查询都是一次
 * 掷硬币，所以读点判据必须机器化。
 *
 * 判据（对 config.softDelete.tables 登记的每张表）：
 *   1. 采集器实见 where 键含软删列 → 放行；
 *   2. 调用无参数（findMany()）→ 可证未过滤，红；
 *   3. 参数为全字面量且不含软删列 → 可证未过滤，红；
 *   4. 参数含变量/展开/函数调用 → 静态不可证，warn 候选（人工核）；
 *   5. 参数文本里出现软删列名 → 保守放行（谓词拼在变量里也算有证据）。
 *
 * 全局中间件统一注入（$extends 等）的仓：登记 softDelete.middleware.reason 后逐读点
 * 判据关闭——理由必填，空理由等同豁免槽。
 */

import path from 'node:path'
import { defineGuard, err, info, warn } from '../lib/guard.ts'
import type { Finding } from '../lib/guard.ts'
import type { QeConfig, SoftDeleteConfig } from '../lib/config.ts'
import { loadSchema, collectorFor } from '../lib/providers.ts'
import { readTextSafe } from '../lib/fs.ts'
import { NotApplicable } from '../lib/not-applicable.ts'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/inv25-soft-delete-read')

type ConfigPatch = Partial<QeConfig>

/**
 * 从调用行起做定界扫描：取第一个 '(' 到配平 ')' 之间的文本。
 * 无参调用返回 ''；窗口内找不到起点或未配平返回 null（解析失败，不许当干净）。
 * 字符串字面量里的括号会干扰配平——配不平就走 null（warn 候选），方向保守（不假红）。
 */
function callArgsText(lines: string[], startLine: number): string | null {
  let depth = 0
  let started = false
  let out = ''
  const last = Math.min(lines.length, startLine - 1 + 80)
  for (let i = startLine - 1; i < last; i++) {
    for (const ch of lines[i]) {
      if (!started) {
        if (ch === '(') {
          started = true
          depth = 1
        }
        continue
      }
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) return out
      }
      out += ch
    }
    if (started) out += '\n'
  }
  return null
}

/**
 * 参数是否「全字面量」：剥掉字符串后，凡可能藏键的形态都不可证——
 * 展开（...x）、函数调用（build()）、值位置的标识符（where: w）、
 * 结构键的 shorthand（{ where }）。嵌套 shorthand（{ where: { id } } 的 id）
 * 只是标量值，藏不了键，仍算字面量。
 */
function isProvablyLiteral(args: string): boolean {
  if (args.includes('...')) return false
  const s = args.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''")
  if (/[A-Za-z_$][\w$]*\s*\(/.test(s)) return false
  if (/:\s*(?!(?:true|false|null|undefined)\b)[A-Za-z_$][\w$]*\s*[,}\)]/.test(s)) return false
  if (/[{,]\s*(?:where|include|select)\s*[,}]/.test(s)) return false
  return true
}

export const inv25 = defineGuard({
  id: 'inv25-soft-delete-read',
  title: '软删表读点必须带软删谓词（含按 id 读、计数、导出、趋势）',
  invariants: ['INV-CORE-05'],
  blindSpots: [
    '只认 <client>.<model>.<readMethod>(...) 直调形状；封装成 helper 的读点、原始 SQL、视图/CTE 不在射程',
    '「参数含变量/展开」只出 warn 候选，是否真带谓词需人工核（宁可漏报不假红）',
    '字符串字面量里含括号导致配平失败时按「解析失败 warn」处理，不判未过滤',
    '声明 middleware 统一过滤后逐读点判据关闭；中间件是否真的注入、是否覆盖全部读法，不在射程',
    '关联读取（include/select 嵌套软删表）不判：只判顶层调用',
  ],
  async run(ctx) {
    const sd = ctx.config.softDelete
    if (!sd) {
      throw new NotApplicable(
        'SOFTDELETE_UNDECLARED',
        '未登记软删表清单（config.softDelete.tables）：软删读点本轮未检查——这不是干净',
      )
    }
    const column = sd.column?.trim() || 'deletedAt'
    if (sd.middleware) {
      if (!sd.middleware.reason?.trim()) {
        return {
          findings: [
            err('SOFTDELETE_MIDDLEWARE_NO_REASON', '声明了全局中间件统一过滤但理由为空：空理由等同豁免槽'),
          ],
          scanned: `tables=${sd.tables.length} middleware=declared-no-reason`,
        }
      }
      return {
        findings: [
          info(
            'SOFTDELETE_GLOBAL_MIDDLEWARE',
            `宣称软删过滤由全局中间件统一注入（理由：${sd.middleware.reason}）；逐读点判据关闭，中间件有效性不在射程`,
          ),
        ],
        scanned: `tables=${sd.tables.length} middleware=declared`,
      }
    }
    if (sd.tables.length === 0) {
      return {
        findings: [info('SOFTDELETE_NONE_DECLARED', '显式声明本仓无软删表（tables=[]）：判据不适用，但不空转报绿')],
        scanned: 'tables=0',
      }
    }

    const schema = await loadSchema(ctx.root, ctx.config)
    const collector = collectorFor(ctx.config)
    const sources = await collector.loadSources(ctx.root, ctx.config)
    const calls = collector.collectCalls(sources, schema, ctx.config)

    const findings: Finding[] = []
    const models = new Map(schema.models.map((m) => [m.name, m]))
    const validTables = new Set<string>()
    for (const t of sd.tables) {
      const m = models.get(t)
      if (!m) {
        findings.push(
          err('SOFTDELETE_TABLE_UNKNOWN', `登记的软删表 ${t} 在 schema 里不存在：登记漂移或拼写错误，判据在这条上一直空转`, { entity: t }),
        )
        continue
      }
      if (!m.fields.some((f) => f.name === column)) {
        findings.push(
          err('SOFTDELETE_COLUMN_MISSING', `${t} 没有 ${column} 列：登记了软删表但模型里没有软删列，登记与 schema 漂移`, { entity: t }),
        )
        continue
      }
      validTables.add(t)
    }

    const reads = calls.filter((c) => c.kind === 'read' && validTables.has(c.model))
    if (validTables.size > 0 && reads.length === 0) {
      findings.push(
        warn(
          'SOFTDELETE_ZERO_READS',
          `${[...validTables].join('/')} 在全仓 0 个读点：空集恒真不算绿——人工确认是「真没人读」还是采集漏了`,
        ),
      )
    }

    let unfiltered = 0
    let unknown = 0
    let ok = 0
    for (const c of reads) {
      if (c.fields.includes(column)) {
        ok++
        continue
      }
      const text = await readTextSafe(path.join(ctx.root, c.file))
      const args = text === null ? null : callArgsText(text.split(/\r?\n/), c.line)
      if (args !== null && args !== '' && args.includes(column)) {
        // 谓词拼在变量/嵌套结构里：文本出现列名即保守放行
        ok++
        continue
      }
      if (args === '') {
        unfiltered++
        findings.push(
          err(
            'SOFTDELETE_READ_UNFILTERED',
            `${c.model}.${c.method}() 无参调用＝全表读（含已删行）：软删表读点必须带 ${column} 谓词`,
            { file: c.file, line: c.line, entity: `${c.model}.${c.method}` },
          ),
        )
        continue
      }
      if (args !== null && isProvablyLiteral(args)) {
        unfiltered++
        findings.push(
          err(
            'SOFTDELETE_READ_UNFILTERED',
            `${c.model}.${c.method} 的参数全字面量且不含 ${column} 谓词：可证未过滤，软删行会漏进结果`,
            { file: c.file, line: c.line, entity: `${c.model}.${c.method}` },
          ),
        )
        continue
      }
      unknown++
      findings.push(
        warn(
          'SOFTDELETE_FILTER_UNKNOWN',
          `${c.model}.${c.method} 的过滤条件含变量/展开/函数调用${args === null ? '（或参数解析失败）' : ''}，静态不可证是否带 ${column}：人工核`,
          { file: c.file, line: c.line, entity: `${c.model}.${c.method}` },
        ),
      )
    }

    if (findings.length === 0) {
      findings.push(info('SOFTDELETE_CLEAN', `软删表读点 ${reads.length} 个，全部带 ${column} 谓词`))
    }
    return {
      findings,
      scanned: `tables=${sd.tables.length} column=${column} reads=${reads.length} ok=${ok} unfiltered=${unfiltered} unknown=${unknown}`,
    }
  },
  selfTest: [
    {
      name: 'good：findMany/findUnique/count 全部带 deletedAt 谓词',
      root: path.join(FIXTURES, 'good'),
      expect: 'green',
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
        softDelete: { tables: ['Post'] },
      } as ConfigPatch,
    },
    {
      name: 'bad：无参全表读 + 字面量 where 无软删列 + findUnique 只按 id',
      root: path.join(FIXTURES, 'bad'),
      expect: 'red',
      minErrors: 3,
      maxErrors: 3,
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
        softDelete: { tables: ['Post'] },
      } as ConfigPatch,
    },
    {
      name: 'warn：where 由函数返回值构造，静态不可证',
      root: path.join(FIXTURES, 'unknown'),
      expect: 'warn',
      minWarnings: 1,
      maxWarnings: 1,
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
        softDelete: { tables: ['Post'] },
      } as ConfigPatch,
    },
    {
      name: 'warn：登记的软删表全仓 0 读点（空集恒真不是绿）',
      root: path.join(FIXTURES, 'noreads'),
      expect: 'warn',
      minWarnings: 1,
      maxWarnings: 1,
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
        softDelete: { tables: ['Post'] },
      } as ConfigPatch,
    },
    {
      name: 'bad：声明了全局中间件但理由为空（豁免槽）',
      root: path.join(FIXTURES, 'good'),
      expect: 'red',
      minErrors: 1,
      maxErrors: 1,
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
        softDelete: { tables: ['Post'], middleware: { reason: ' ' } },
      } as ConfigPatch,
    },
    {
      name: 'bad：登记的表在 schema 里不存在（登记漂移）',
      root: path.join(FIXTURES, 'good'),
      expect: 'red',
      minErrors: 1,
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
        softDelete: { tables: ['Ghost'] },
      } as ConfigPatch,
    },
  ],
})
