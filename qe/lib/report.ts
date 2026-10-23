import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readTextSafe } from './fs.ts'
import type { Finding } from './guard.ts'
import type { Invariant } from '../registry/types.ts'
import type { SelfTestCaseResult } from './selftest.ts'
import type { QeConfig } from './config.ts'

export interface GuardReadout {
  guard: string
  findings: Finding[]
  scanned: string
  /** 适配器未配置等不适用原因：不算绿，也不判红 */
  skipped?: string
}

export interface Incident {
  id: string
  title?: string
  inv?: string
  date?: string
}

export interface ReportInput {
  root: string
  config: QeConfig
  registry: Invariant[]
  readouts: GuardReadout[]
  selftest: SelfTestCaseResult[]
}

export interface Metrics {
  status: 'green' | 'yellow' | 'red'
  guards: number
  errors: number
  warnings: number
  skipped: number
  invariants: { total: number; enforced: number; partial: number; open: number }
  enforcedCovered: number
  enforcedCoverage: number
  zeroWriter: number
  deadEnum: number
  selftest: { cases: number; passed: number; failed: number }
  incidents: { total: number; matched: number; rate: number | null }
}

export async function writeReport(input: ReportInput, outDir = 'qe-report'): Promise<{ metrics: Metrics; jsonFile: string; mdFile: string }> {
  const metrics = computeMetrics(input)
  metrics.incidents = await loadIncidentMetrics(input.root, input.config, input.registry)
  const dir = path.join(input.root, outDir)
  await mkdir(dir, { recursive: true })
  const jsonFile = path.join(dir, 'qe-report.json')
  const mdFile = path.join(dir, 'qe-report.md')
  await writeFile(jsonFile, JSON.stringify({ generatedAt: new Date().toISOString(), metrics, guards: input.readouts, selftest: input.selftest }, null, 2), 'utf8')
  await writeFile(mdFile, renderMarkdown(input, metrics), 'utf8')
  return { metrics, jsonFile, mdFile }
}

function computeMetrics(input: ReportInput): Metrics {
  const errors = input.readouts.reduce((n, r) => n + r.findings.filter((f) => f.level === 'error').length, 0)
  const warnings = input.readouts.reduce((n, r) => n + r.findings.filter((f) => f.level === 'warn').length, 0)
  const skipped = input.readouts.filter((r) => r.skipped).length
  const byStatus = (s: string): number => input.registry.filter((i) => i.status === s).length
  const enforced = input.registry.filter((i) => i.status === 'enforced')
  const passingGuards = new Set(input.selftest.filter((s) => s.pass).map((s) => s.guard))
  const covered = enforced.filter((i) => {
    const suffix = (i.guard ?? '').split(':').pop() ?? ''
    if (!suffix) return false
    const owner = input.readouts.find((r) => r.guard.startsWith(suffix))
    return Boolean(owner && passingGuards.has(owner.guard))
  }).length
  const zeroWriter = input.readouts.reduce(
    (n, r) => n + r.findings.filter((f) => f.code === 'ZERO_WRITER').length,
    0,
  )
  const deadEnum = input.readouts.reduce(
    (n, r) => n + r.findings.filter((f) => f.code === 'DEAD_ENUM' || f.code === 'NO_WRITE_PATH').length,
    0,
  )
  const failed = input.selftest.filter((s) => !s.pass).length

  return {
    status: errors > 0 || failed > 0 ? 'red' : warnings > 0 || skipped > 0 ? 'yellow' : 'green',
    guards: input.readouts.length,
    errors,
    warnings,
    skipped,
    invariants: {
      total: input.registry.length,
      enforced: enforced.length,
      partial: byStatus('partial'),
      open: byStatus('open'),
    },
    enforcedCovered: covered,
    enforcedCoverage: enforced.length ? Math.round((covered / enforced.length) * 1000) / 10 : 0,
    zeroWriter,
    deadEnum,
    selftest: {
      cases: input.selftest.length,
      passed: input.selftest.filter((s) => s.pass).length,
      failed,
    },
    incidents: { total: 0, matched: 0, rate: null },
  }
}

export async function loadIncidentMetrics(root: string, config: QeConfig, registry: Invariant[]): Promise<Metrics['incidents']> {
  const text = await readTextSafe(path.join(root, config.ledger))
  if (text === null) return { total: 0, matched: 0, rate: null }
  try {
    const list = JSON.parse(text) as Incident[]
    const ids = new Set(registry.map((i) => i.id))
    const matched = list.filter((i) => i.inv && ids.has(i.inv)).length
    return { total: list.length, matched, rate: list.length ? Math.round((matched / list.length) * 1000) / 10 : null }
  } catch {
    return { total: 0, matched: 0, rate: null }
  }
}

function renderMarkdown(input: ReportInput, m: Metrics): string {
  const zh = input.config.locale !== 'en'
  const t = zh
    ? {
        title: 'AI 质量工程跑批报告',
        generated: '生成时间',
        conclusion: '结论',
        adapters: '适配器',
        repro: '复现命令',
        health: '健康指标',
        metric: '指标',
        reading: '读数',
        criterion: '判据',
        invariants: '不变量条目',
        invCriterion: '稳定态 20–30 条，新增缺陷多数落旧条目',
        coverage: '守卫反证覆盖率',
        coverageCriterion: '=100%，缺一降级',
        zeroWriter: '零写入列',
        zeroWriterCriterion: '→0 并钉住（ratchet 只准变少）',
        deadEnum: '死枚举值',
        deadEnumCriterion: '→0 并钉住',
        incidentRate: '新缺陷落旧条目率',
        notRegistered: '未登记',
        incidentCriterion: '↑（查表动作多于新开条目）',
        guards: '守卫读数',
        guard: '守卫',
        state: '状态',
        scope: '射程（自报）',
        tri: '守卫三态（坏样本反证）',
        testCase: '用例',
        expect: '期望',
        result: '结果',
        readout: '红/黄读数',
        open: 'open 条目复审窗口',
        inv: '不变量',
        reviewBy: '复审日期',
        reason: '理由',
        footer: '读数口径：命令即真源，本报告只是带日期的快照。封面数字与复现输出不符即视为红。',
        statuses: { green: '绿', yellow: '黄（有告警）', red: '红' },
      }
    : {
        title: 'AI Quality Engineering Run Report',
        generated: 'Generated',
        conclusion: 'Conclusion',
        adapters: 'Adapters',
        repro: 'Reproduce',
        health: 'Health metrics',
        metric: 'Metric',
        reading: 'Reading',
        criterion: 'Criterion',
        invariants: 'Invariant entries',
        invCriterion: 'steady state is 20–30; new defects should mostly land on old entries',
        coverage: 'Guard counter-proof coverage',
        coverageCriterion: '=100%; any gap is a downgrade',
        zeroWriter: 'Zero-writer columns',
        zeroWriterCriterion: '→0 and pinned (ratchet may only shrink)',
        deadEnum: 'Dead enum values',
        deadEnumCriterion: '→0 and pinned',
        incidentRate: 'New defects landing on old entries',
        notRegistered: 'not registered',
        incidentCriterion: '↑ (lookup before opening a new entry)',
        guards: 'Guard readings',
        guard: 'Guard',
        state: 'State',
        scope: 'Scope (self-reported)',
        tri: 'Guard three-state (bad-sample counter-proof)',
        testCase: 'Case',
        expect: 'Expect',
        result: 'Result',
        readout: 'red/yellow readout',
        open: 'Open items review window',
        inv: 'Invariant',
        reviewBy: 'Review by',
        reason: 'Reason',
        footer: 'Reading principle: the command is the source of truth; this report is a dated snapshot. Numbers here that disagree with a fresh run are red.',
        statuses: { green: 'green', yellow: 'yellow (warnings)', red: 'red' },
      }
  const now = new Date().toLocaleString(zh ? 'zh-CN' : 'en-GB', { timeZone: 'Asia/Shanghai' })
  const sep = zh ? '：' : ': '
  const br = (s: string): string => (zh ? `（${s}）` : ` (${s})`)
  const statusText = t.statuses[m.status]
  const guardRows = input.readouts
    .map((r) => {
      const e = r.findings.filter((f) => f.level === 'error').length
      const w = r.findings.filter((f) => f.level === 'warn').length
      const state = r.skipped ? 'skipped' : e > 0 ? 'red' : w > 0 ? 'yellow' : 'green'
      return `| ${r.guard} | ${state} | ${e} | ${w} | ${r.scanned} |`
    })
    .join('\n')
  const stRows = input.selftest
    .map((s) => `| ${s.guard} | ${s.caseName} | ${s.expect} | ${s.pass ? 'PASS' : 'FAIL'} | ${s.errors}/${s.warnings} |`)
    .join('\n')
  const openDue = input.registry
    .filter((i) => i.status === 'open' && i.revisitBy)
    .sort((a, b) => (a.revisitBy ?? '').localeCompare(b.revisitBy ?? ''))
    .map((i) => `| ${i.id} | ${i.revisitBy} | ${i.openReason ?? ''} |`)
    .join('\n')

  return `# ${t.title}

- ${t.generated}${sep}${now}
- ${t.conclusion}${sep}**${statusText}**${br(`errors=${m.errors} warnings=${m.warnings} skipped=${m.skipped} selftest=${m.selftest.passed}/${m.selftest.cases}`)}
- ${t.adapters}${sep}schema=${input.config.schema.provider} / collector=${input.config.source.collector}
- ${t.repro}${sep}\`npm run qe:report\`

## ${t.health}

| ${t.metric} | ${t.reading} | ${t.criterion} |
|---|---|---|
| ${t.invariants} | ${m.invariants.total}${br(`enforced ${m.invariants.enforced} / partial ${m.invariants.partial} / open ${m.invariants.open}`)} | ${t.invCriterion} |
| ${t.coverage} | ${m.enforcedCoverage}%${br(`${m.enforcedCovered}/${m.invariants.enforced}`)} | ${t.coverageCriterion} |
| ${t.zeroWriter} | ${m.zeroWriter} | ${t.zeroWriterCriterion} |
| ${t.deadEnum} | ${m.deadEnum} | ${t.deadEnumCriterion} |
| ${t.incidentRate} | ${m.incidents.rate === null ? t.notRegistered : m.incidents.rate + '%'}${br(`${m.incidents.matched}/${m.incidents.total}`)} | ${t.incidentCriterion} |

## ${t.guards}

| ${t.guard} | ${t.state} | errors | warnings | ${t.scope} |
|---|---|---|---|---|
${guardRows || '| - | - | - | - | - |'}

## ${t.tri}

| ${t.guard} | ${t.testCase} | ${t.expect} | ${t.result} | ${t.readout} |
|---|---|---|---|---|
${stRows || '| - | - | - | - | - |'}

## ${t.open}

| ${t.inv} | ${t.reviewBy} | ${t.reason} |
|---|---|---|
${openDue || '| - | - | - |'}

> ${t.footer}
`
}
