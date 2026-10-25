/**
 * 规则 → 守卫 的适配层（**唯一**一条转换路径）。
 *
 * 仓库里有两类判据：
 *   ① 原生守卫（`guards/inv*.ts`）：自己拿到 root/config 去解析 schema、扫 AST；
 *   ② 规则（`rules/aq*.ts`）：纯函数 `analyze(src, rel, ctx) → hits`，与文件系统无关。
 *
 * 规则之所以长成纯函数，是为了让「反证」能写成同文件里的字符串样本：
 * 判据与坏样本相邻，改判据时不可能忘记同步反证（这正是本项目历史上最常出的事故）。
 * 本适配层负责把纯函数接到 `Guard` 接口上，代价是这一层——而不是每个规则各写一遍 walk/read/报告。
 *
 * 纪律：
 *  - 射程内 0 个文件 → 抛 NotApplicable，**不许**返回空 findings（零检查会被读成零缺陷）；
 *  - 规则自身抛错 → 记一条 error，不许静默跳过（否则该文件实际没被检查，却是绿的）。
 */

import path from 'node:path'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { QeConfig } from './config.ts'
import { err, info, warn, type Finding, type Guard, type GuardCase } from './guard.ts'
import { NotApplicable, SKIP_CODE_EMPTY_SCOPE, SKIP_CODE_UNCLASSIFIED } from './not-applicable.ts'
import { prismaSchemaProvider } from './prisma.ts'
import { readTextSafe, walkFiles } from './fs.ts'
import { defaultSourceExtensions } from './config.ts'
import { EMPTY_FACTS, factsFrom, parseMigrationUniqueIndexes, type SchemaFacts } from './schema-facts.ts'
import { checkRuleOracle } from './rule-oracle-check.ts'
import { processTempRoot } from './isolation.ts'
import { RULE_ORACLES } from '../registry/rule-oracles.ts'

export interface RawHit {
  line: number
  /** 本次命中的具体说明；缺省用规则的 impact（这类规则只有一种成因时不必重复写字） */
  message?: string
  /** 命中处原文片段：triage 时人不打开文件也能判真假 */
  evidence?: string
  /** 覆盖规则级 impact（同一条规则有多种成因时用） */
  impact?: string
  /**
   * 命中实际所在的文件（相对 root）。缺省=被分析的那个文件。
   *
   * 存在的理由：有些判据**读 A 文件、判 B 文件**（例如「组件 js 的配置 × 组件 wxml 的用法」）。
   * 那时把行号挂在 A 上就是把读的人送到错误位置，而错位的行号比没有行号更贵。
   */
  file?: string
}

export interface RuleCtx {
  root: string
  /** 该规则的选项：`qe.config.json` 的 `rules[ruleId]`（误报只许在这里解决，不许改判据） */
  options: Record<string, unknown>
  facts: SchemaFacts
  /** 读项目内文件（相对 root）；不存在返回 null */
  readFile(rel: string): string | null
}

export interface RuleFixture {
  name: string
  /** red = 必须至少 1 条 error；warn = 无 error 但必须有 warn；info = 无红无黄但必须有 info；green = 一条都不许有 */
  expect: 'red' | 'warn' | 'info' | 'green'
  /** 单文件样本的源码；与 `files` 二选一（必须给一个） */
  src?: string
  /** 样本落盘位置（相对样本根）。依赖路径的规则必须给，例如 'app/api/x/route.ts' */
  rel?: string
  /**
   * 多文件样本：`{ 'app/api/records/route.ts': '...' }`。
   * 单文件样本用 `src` + `rel` 即可；但「本规则不该看这类文件」的样本必须配一个射程内文件，
   * 否则样本根的射程为空，判据会以「0 个文件」失败——那不是判据的错，是样本不成立。
   */
  files?: Record<string, string>
  options?: Record<string, unknown>
}

export interface RuleSpec {
  id: string
  title: string
  invariants: string[]
  blindSpots: string[]
  /** finding code（按规则聚合棘轮读数用） */
  code: string
  /**
   * 违规级别。error = 必须修；warn = 值得看一眼但可能合法；info = 只做读数，不占红黄预算。
   * 一条规则只有一个级别：同一条规则里「有时是错、有时不是」说明它其实是两条规则。
   */
  level?: 'error' | 'warn' | 'info'
  /** 默认说明（未给 message 的命中用它） */
  impact: string
  /**
   * 出处：这条判据是哪次真实事故泛化出来的。
   * **只写匿名化的项目代号与时间**——本仓库要能直接公开，此处禁止出现项目名、
   * 业务名、内部系统名（由 `guards/leak-project-info.ts` 机器校验）。
   */
  provenance: string
  applies(rel: string): boolean
  /**
   * 前置条件不满足 → 返回原因（本轮未检查）。返回 null 表示适用。
   *
   * 想给跳过分类（进棘轮键）就返回 `{ code, reason }`；只写字符串会统一落
   * `AQ_NOT_CLASSIFIED`，那时「加了哪一类跳过」在棘轮上看不出区别。
   */
  notApplicable?(ctx: RuleCtx): string | { code: string; reason: string } | null
  analyze(src: string, rel: string, ctx: RuleCtx): RawHit[]
  fixtures: RuleFixture[]
}

/**
 * 规则样本的落盘根：**进程级临时目录**，判据文本才是真相源，这里只是它的可执行副本。
 *
 * 不许落回 `qe/.fixtures-generated`：那是引擎目录里的固定路径，同一台机器上的两个项目会共用，
 * A 项目的样本残片能出现在 B 项目的扫描里——跨项目污染最隐蔽的一条通道（INV-ISO-01）。
 */
export function fixtureRoot(ruleId: string): string {
  return path.join(processTempRoot('autoqe-fixtures-'), ruleId)
}

function materialize(spec: RuleSpec): GuardCase[] {
  const base = fixtureRoot(spec.id)
  const cases: GuardCase[] = []
  spec.fixtures.forEach((fx, i) => {
    const dir = path.join(base, `case-${i + 1}`)
    rmSync(dir, { recursive: true, force: true })
    if (fx.files === undefined && typeof fx.src !== 'string') {
      throw new Error(`规则 ${spec.id} 的样本「${fx.name}」既没有 src 也没有 files：样本不成立`)
    }
    const entries: Record<string, string> = fx.files ?? { [fx.rel ?? 'src/sample.ts']: fx.src as string }
    for (const [rel, src] of Object.entries(entries)) {
      const file = path.join(dir, ...rel.split('/'))
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, src, 'utf8')
    }
    const label = Object.keys(entries).join(' + ')
    cases.push({
      name: `${fx.name}（${label}）`,
      root: dir,
      expect: fx.expect,
      config: {
        schema: { provider: 'none', path: '__no_schema__.prisma', clientNames: [] },
        source: { collector: 'none', roots: ['.'], extensions: defaultSourceExtensions },
        rules: { [spec.id]: fx.options ?? {} },
      },
    })
  })
  return cases
}

async function loadFacts(root: string, config: QeConfig): Promise<SchemaFacts> {
  if (config.schema.provider === 'none') return EMPTY_FACTS
  try {
    const snapshot = await prismaSchemaProvider.load(root, config)
    const facts = factsFrom(snapshot)
    // Prisma schema 表达不了部分唯一索引（WHERE 条件），但迁移 SQL 里有。
    // 不读迁移会把「DB 已挡双写」的表判成竞态（外部试点实测量级：交接班/批次号一类）。
    if (config.schema.provider === 'prisma') {
      const migrationsDir = path.posix.join(path.posix.dirname(config.schema.path), 'migrations')
      const tableToModel = new Map(snapshot.models.map((m) => [m.table, m.name]))
      for (const file of await walkFiles(root, migrationsDir, { ignore: config.ignore, ext: ['.sql'] })) {
        const sql = await readTextSafe(file)
        if (!sql) continue
        for (const [model, keys] of parseMigrationUniqueIndexes(sql, tableToModel)) {
          const list = facts.uniqueKeys.get(model) ?? []
          facts.uniqueKeys.set(model, [...new Set([...list, ...keys])])
        }
      }
    }
    return facts
  } catch {
    // schema 缺失不是「没有缺陷」，是「判据没有事实来源」——由各规则 notApplicable 显式声明。
    return EMPTY_FACTS
  }
}

async function collectFiles(root: string, config: QeConfig): Promise<string[]> {
  const out: string[] = []
  for (const dir of config.source.roots) {
    const files = await walkFiles(root, dir, { ignore: config.ignore, ext: config.source.extensions })
    for (const f of files) out.push(path.relative(root, f).split(path.sep).join('/'))
  }
  return [...new Set(out)].sort()
}

export function toGuard(spec: RuleSpec): Guard {
  // 导入期硬门：没有 oracle 声明、或 human 档却标 error 的规则，连跑都不许跑。
  // 放在这里而不是 CI 里，是为了让「忘了登记」在第一次 import 时就炸，而不是等有人去看报告。
  const oracle = RULE_ORACLES[spec.id]
  const issues = checkRuleOracle(spec.id, oracle, spec.level ?? 'error')
  if (issues.length > 0) {
    throw new Error(`规则声明不合法（${spec.id}）：\n${issues.map((i) => `  - ${i.code} ${i.message}`).join('\n')}`)
  }
  let cachedCases: GuardCase[] | null = null
  return {
    id: spec.id,
    title: spec.title,
    invariants: spec.invariants,
    blindSpots: spec.blindSpots,
    oracle,
    level: spec.level ?? 'error',
    async run(ctx) {
      const facts = await loadFacts(ctx.root, ctx.config)
      const options = (ctx.config.rules?.[spec.id] ?? {}) as Record<string, unknown>
      const ruleCtx: RuleCtx = {
        root: ctx.root,
        options,
        facts,
        // 同步读：规则是纯函数，签名里不该出现 Promise；每规则每文件调用 0~2 次，代价可忽略
        readFile: (rel) => {
          try {
            return readFileSync(path.join(ctx.root, rel), 'utf8')
          } catch {
            return null
          }
        },
      }

      // 规则自己声明的不适用原因（自由文本）。分类留了升级口：返回值是对象时用它给的 code，
      // 只写字符串则统一落 AQ_NOT_CLASSIFIED —— 后者集中出现本身就是待办信号，
      // 按规则 id 派生 code 会让「射程条件还只写在散文里」显得已经分好类了。
      const declared = spec.notApplicable?.(ruleCtx) ?? null
      if (declared) {
        throw typeof declared === 'string'
          ? new NotApplicable(SKIP_CODE_UNCLASSIFIED, declared)
          : new NotApplicable(declared.code, declared.reason)
      }

      const files = (await collectFiles(ctx.root, ctx.config)).filter((rel) => spec.applies(rel))
      if (files.length === 0) {
        throw new NotApplicable(
          SKIP_CODE_EMPTY_SCOPE,
          `射程内 0 个文件（roots=${ctx.config.source.roots.join(',')}）：0 命中不代表无缺陷`,
        )
      }

      const findings: Finding[] = []
      let checked = 0
      for (const rel of files) {
        const src = await readTextSafe(path.join(ctx.root, rel))
        if (src === null) continue
        checked++
        let hits: RawHit[]
        try {
          hits = spec.analyze(src, rel, ruleCtx)
        } catch (e) {
          findings.push(
            err(`${spec.code}_CRASH`, `判据在此文件上抛错，该文件实际未被检查：${(e as Error).message}`, {
              file: rel,
            }),
          )
          continue
        }
        for (const h of hits) {
          const text = [h.message ?? h.impact ?? spec.impact, h.evidence ? `｜证据：${h.evidence}` : ''].join('')
          const extra = { file: h.file ?? rel, line: h.line }
          const level = spec.level ?? 'error'
          findings.push(level === 'warn' ? warn(spec.code, text, extra) : level === 'info' ? info(spec.code, text, extra) : err(spec.code, text, extra))
        }
      }

      if (findings.length === 0) {
        findings.push(info(`${spec.code}_CLEAN`, `${checked}/${files.length} 文件已检查，0 命中`))
      }
      return { findings, scanned: `files=${checked}/${files.length} roots=${ctx.config.source.roots.join(',')}` }
    },
    // GuardCase 需要真实目录，故在首次取用时落盘（不在模块导入时做副作用）
    get selfTest() {
      if (cachedCases === null) cachedCases = materialize(spec)
      return cachedCases
    },
  }
}
