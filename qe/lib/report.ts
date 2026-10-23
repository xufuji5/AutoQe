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
  const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  const statusText = m.status === 'green' ? '绿' : m.status === 'yellow' ? '黄（有告警）' : '红'
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

  return `# AI 质量工程跑批报告

- 生成时间：${now}
- 结论：**${statusText}**（errors=${m.errors} warnings=${m.warnings} skipped=${m.skipped} selftest=${m.selftest.passed}/${m.selftest.cases}）
- 适配器：schema=${input.config.schema.provider} / collector=${input.config.source.collector}
- 复现命令：\`npm run qe:report\`

## 健康指标

| 指标 | 读数 | 判据 |
|---|---|---|
| 不变量条目 | ${m.invariants.total}（enforced ${m.invariants.enforced} / partial ${m.invariants.partial} / open ${m.invariants.open}） | 稳定态 20–30 条，新增缺陷多数落旧条目 |
| 守卫反证覆盖率 | ${m.enforcedCoverage}%（${m.enforcedCovered}/${m.invariants.enforced}） | =100%，缺一降级 |
| 零写入列 | ${m.zeroWriter} | →0 并钉住（ratchet 只准变少） |
| 死枚举值 | ${m.deadEnum} | →0 并钉住 |
| 新缺陷落旧条目率 | ${m.incidents.rate === null ? '未登记' : m.incidents.rate + '%'}（${m.incidents.matched}/${m.incidents.total}） | ↑（查表动作多于新开条目） |

## 守卫读数

| 守卫 | 状态 | errors | warnings | 射程（自报） |
|---|---|---|---|---|
${guardRows || '| - | - | - | - | - |'}

## 守卫三态（坏样本反证）

| 守卫 | 用例 | 期望 | 结果 | 红/黄读数 |
|---|---|---|---|---|
${stRows || '| - | - | - | - | - |'}

## open 条目复审窗口

| 不变量 | 复审日期 | 理由 |
|---|---|---|
${openDue || '| - | - | - |'}

> 读数口径：命令即真源，本报告只是带日期的快照。封面数字与复现输出不符即视为红。
`
}
