/**
 * 缺失族 AQ-ABS · 规格 → 实现对账。
 *
 * ## 这一族为什么必须单独存在
 *
 * 静态扫描的全部判据都在问「写出来的代码对不对」；而实践中代价最高的一类缺陷是
 * **根本没有写出来的代码**：文档承诺了 `Tenant` 模型、承诺了「统一社会信用代码」字段、
 * 承诺了 `/api/tenants` 端点，代码里没有。它在类型系统里完全合法——因为没有任何东西引用它，
 * 所以没有任何编译器、lint、测试会报错。
 *
 * 这类缺陷的检测器不在代码里，**在文档库里**。文档库就是这一族的 oracle。
 *
 * ## oracle 的资格（为什么默认只出候选）
 *
 * 文档会过期。拿一份 2026-09 的需求文档去量 2026-10 的代码，会得到 65 个「缺失」——
 * 其中大部分是需求变更后文档没改，不是代码没写。所以：
 *   - 本守卫默认 `level: warn`，输出**候选**，由人按「这条规格还有效吗」裁决；
 *   - 只有配置显式写了 `spec.docsOwner`（谁负责文档与实现同步）才允许 `enforce: true` 升级为 error；
 *     没写 owner 就升级，等于拿一把没人校准的尺子量人（配置缺陷 `SPEC_ENFORCE_NO_OWNER` 会单独报出来）。
 *
 * ## 抽取器的纪律（在 qe/lib/spec-tables.ts）
 *
 * 只认 markdown 表格行；表头必须显式声明 `模型 / 字段 / 端点`；字段表必须有模型上下文；
 * 单元格必须是完整标识符。只因判据太松而红的样本，已经在 `scripts/verify-spec-tables.ts`
 * 的 16 个坏样本里钉住（散文里的 `tenant`、截断的 `enant`、图标表里的 `IconAlert`…）。
 *
 * ## 射程
 *
 * - 模型/字段：Prisma schema（`schema.provider=none` 或读不到时整档跳过并**明确报出来**，不报绿）；
 * - 端点：Next.js App Router 的 `route.*` 文件名（路由组 `(group)` 与动态段 `[id]` 按框架语义归一）；
 * - 不判：字段的「录入框/接口/展示页三处齐」、流程节点、权限矩阵——留待后续批次。
 */
import path from 'node:path'
import { readText, rel, walkFiles } from '../lib/fs.ts'
import { prismaSchemaProvider } from '../lib/prisma.ts'
import { defineGuard, err, info, warn } from '../lib/guard.ts'
import { NotApplicable } from '../lib/not-applicable.ts'
import {
  compareClaims,
  normalizeEndpoint,
  parseSpecDoc,
  type SpecClaim,
  type SpecGap,
  type SpecReality,
} from '../lib/spec-tables.ts'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/spec-abs')
/** 单轮最多展开的缺口条数：65 条「缺失」是文档过期，不是 65 个缺陷 */
const MAX_DETAIL = 10

/**
 * Next.js App Router：`app/a/(grp)/b/[id]/route.ts` → `/a/b/[id]`。
 * 路由组在 URL 里不出现——这是框架语义，不是我们的约定。
 */
function endpointOf(relPath: string, routeRoot: string): string | null {
  const prefix = routeRoot.replace(/^\.?\//, '').replace(/\/+$/, '')
  if (prefix && !relPath.startsWith(prefix + '/')) return null
  const rest = prefix ? relPath.slice(prefix.length + 1) : relPath
  const ROUTE_FILE = /(^|\/)route\.(?:ts|tsx|js|jsx|mts)$/
  if (!ROUTE_FILE.test(rest)) return null
  const dir = rest.replace(/route\.(?:ts|tsx|js|jsx|mts)$/, '').replace(/\/+$/, '')
  const segs = dir.split('/').filter((s) => s !== '' && !/^\(.+\)$/.test(s))
  return normalizeEndpoint('/' + segs.join('/'))
}

export const specAbs = defineGuard({
  id: 'spec-abs',
  title: '缺失：文档承诺的模型 / 字段 / 端点，实现里有没有',
  invariants: ['INV-SPEC-01'],
  blindSpots: [
    'oracle 是文档库：文档过期时会把「需求已改」误报成「代码没写」，故默认只出候选（warn）',
    '只认 markdown 表格里的显式声明：散文里的承诺（「系统会记录统一社会信用代码」）、图片、原型稿不可见',
    '字段只对到 Prisma schema；「录入框 / 接口 / 展示页三处齐」不判',
    '端点只认 Next.js App Router 的 `route.*` 文件；Pages Router、Express 挂载、网关转发、外部服务不判',
    '流程节点、权限矩阵、状态机迁移不在射程',
    '模型不存在时其字段缺口不重复计入（只报模型那一条），避免同一根因刷屏',
  ],
  async run(ctx) {
    const spec = ctx.config.spec
    if (!spec || spec.docs.length === 0) {
      throw new NotApplicable(
        'SPEC_DOCS_UNSET',
        '未配置规格文档目录（spec.docs 为空）⇒ 缺失族本轮没有 oracle，未检查（不是干净）',
      )
    }

    const strict = spec.enforce === true && (spec.docsOwner ?? '').trim() !== ''
    const findings = []
    if (spec.enforce === true && (spec.docsOwner ?? '').trim() === '') {
      findings.push(
        err(
          'SPEC_ENFORCE_NO_OWNER',
          'spec.enforce=true 但没写 spec.docsOwner：文档库没人负责同步，就把它升级成 error 等于拿一把没人校准的尺子量人；本守卫已降级为候选',
        ),
      )
    }

    /* ---------- 1. 解析文档库 ---------- */
    const exts = spec.extensions ?? ['.md']
    const files = new Set<string>()
    for (const dir of spec.docs) {
      for (const f of await walkFiles(ctx.root, dir, { ignore: ctx.config.ignore, ext: exts })) files.add(f)
    }
    const docs = [...files].sort()
    if (docs.length === 0) {
      throw new NotApplicable('SPEC_DOCS_EMPTY', `spec.docs=${spec.docs.join(',')} 下没有文档（${exts.join('/')}）⇒ 本轮未检查`)
    }

    const claims: SpecClaim[] = []
    let tables = 0
    let ignoredTables = 0
    for (const file of docs) {
      const parsed = parseSpecDoc(await readText(file), rel(ctx.root, file))
      claims.push(...parsed.claims)
      tables += parsed.tables
      ignoredTables += parsed.ignoredTables
    }

    if (claims.length === 0) {
      findings.push(
        warn(
          'SPEC_NO_CLAIMS',
          `扫了 ${docs.length} 篇文档、${tables} 张可识别表格，得到 0 条规格声明：` +
            '要么文档里没有「模型/字段/端点」表，要么表头写法不在词表内。**空集恒真不等于对账通过**',
        ),
      )
      return { findings, scanned: `docs=${docs.length} tables=${tables} ignored=${ignoredTables} claims=0` }
    }

    /* ---------- 2. 采集现实 ---------- */
    const reality: SpecReality = { models: new Set(), fields: new Map(), endpoints: new Set() }
    let schemaOk = false
    if (ctx.config.schema.provider !== 'none') {
      try {
        const snap = await prismaSchemaProvider.load(ctx.root, ctx.config)
        for (const m of snap.models) {
          reality.models.add(m.name)
          const cols = new Set<string>()
          for (const f of m.fields) {
            cols.add(f.name)
            cols.add(f.name.toLowerCase())
            cols.add(f.column)
            cols.add(f.column.toLowerCase())
          }
          reality.fields.set(m.name, cols)
          reality.fields.set(m.name.toLowerCase(), cols)
        }
        schemaOk = true
      } catch {
        schemaOk = false
      }
    }
    if (!schemaOk) {
      findings.push(
        warn(
          'SPEC_SCHEMA_UNAVAILABLE',
          `读不到 schema（provider=${ctx.config.schema.provider}, path=${ctx.config.schema.path}）⇒ 模型/字段这一半本轮没对账（不代表一致）`,
        ),
      )
    }

    const routeRoots = spec.routeRoots ?? ['src/app', 'app']
    const routeFiles = new Set<string>()
    for (const root of routeRoots) {
      for (const f of await walkFiles(ctx.root, root, { ignore: ctx.config.ignore })) {
        if (/(^|\/)route\.(?:ts|tsx|js|jsx|mts)$/.test(f.split(path.sep).join('/'))) routeFiles.add(f)
      }
    }
    for (const f of routeFiles) {
      const rp = rel(ctx.root, f)
      for (const root of routeRoots) {
        const ep = endpointOf(rp, root)
        if (ep) reality.endpoints.add(ep)
      }
    }
    if (reality.endpoints.size === 0) {
      findings.push(
        warn(
          'SPEC_NO_ROUTES',
          `在 ${routeRoots.join(',')} 下没找到任何 route.* 文件 ⇒ 端点这一半本轮没对账（不代表一致）`,
        ),
      )
    }

    /* ---------- 3. 对账 ---------- */
    const checkable = claims.filter((c) => {
      if (c.kind === 'endpoint') return reality.endpoints.size > 0
      return schemaOk
    })
    const skipped = claims.length - checkable.length
    const gaps = compareClaims(checkable, reality)

    const detail = gaps.slice(0, MAX_DETAIL)
    for (const g of detail) findings.push(gapFinding(g, strict))
    if (gaps.length > detail.length) {
      findings.push(
        warn(
          'SPEC_GAP_TRUNCATED',
          `另有 ${gaps.length - detail.length} 条缺口未逐条展开。缺口这么多通常说明**文档过期**而不是代码缺 65 个模型：` +
            '先确认规格基线（文档版本 vs 当前需求），再谈补齐',
        ),
      )
    }
    if (gaps.length === 0) {
      findings.push(
        info(
          'SPEC_MATCH',
          `${docs.length} 篇文档 / ${claims.length} 条声明与实现一致（模型 ${reality.models.size}、端点 ${reality.endpoints.size}）`,
        ),
      )
    }

    const summary = strict ? 'enforced' : 'candidate'
    return {
      findings,
      scanned:
        `docs=${docs.length} tables=${tables} ignored=${ignoredTables} claims=${claims.length} ` +
        `checked=${checkable.length} skipped=${skipped} gaps=${gaps.length} models=${reality.models.size} ` +
        `endpoints=${reality.endpoints.size} mode=${summary}`,
    }
  },
  selfTest: [
    {
      name: 'good：文档声明的模型/字段/端点都有实现',
      root: path.join(FIXTURES, 'good'),
      expect: 'green',
      config: { spec: { docs: ['docs'] } },
    },
    {
      name: 'bad：文档承诺的模型、字段、端点三处都缺',
      root: path.join(FIXTURES, 'bad'),
      expect: 'warn',
      minWarnings: 3,
      config: { spec: { docs: ['docs'] } },
    },
    {
      name: 'bad：enforce 却没写 owner，必须单独报配置缺陷',
      root: path.join(FIXTURES, 'bad'),
      expect: 'red',
      minErrors: 1,
      config: { spec: { docs: ['docs'], enforce: true } },
    },
  ],
})

function gapFinding(g: SpecGap, strict: boolean) {
  const lvl = strict ? err : warn
  if (g.claim.kind === 'model') {
    return lvl(
      'SPEC_MODEL_MISSING',
      `文档 ${g.claim.doc}:${g.claim.line} 承诺模型 \`${g.claim.name}\`，schema 里没有：要么补模型，要么把这条规格标为已废弃`,
      { entity: g.claim.name },
    )
  }
  if (g.claim.kind === 'field') {
    return lvl(
      'SPEC_FIELD_MISSING',
      `文档 ${g.claim.doc}:${g.claim.line} 承诺 \`${g.claim.model}.${g.claim.field}\`，schema 里没有该字段：字段是缺失型缺陷最典型的形态（没有任何引用，因此没有编译错误）`,
      { entity: `${g.claim.model}.${g.claim.field}` },
    )
  }
  return lvl(
    'SPEC_ENDPOINT_MISSING',
    `文档 ${g.claim.doc}:${g.claim.line} 承诺端点 \`${g.claim.path}\`，App Router 里没有对应 route.* 文件：要么补路由，要么删掉这条接口约定`,
    { entity: g.claim.path },
  )
}
