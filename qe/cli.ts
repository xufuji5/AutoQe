#!/usr/bin/env node
import path from 'node:path'
import { loadConfig } from './lib/config.ts'
import { registry } from './registry/registry.ts'
import { guards } from './guards/index.ts'
import { countByLevel, formatFinding, summaryLine } from './lib/guard.ts'
import { NotApplicable } from './lib/not-applicable.ts'
import { runSelfTest } from './lib/selftest.ts'
import { writeReport } from './lib/report.ts'
import { compareRatchet, ratchetLine, writeBaseline } from './lib/ratchet.ts'
import type { GuardReadout } from './lib/report.ts'
import type { Guard } from './lib/guard.ts'

const argv = process.argv.slice(2)
const command = argv[0] && !argv[0].startsWith('--') ? argv.shift()! : 'run'
const flags = parseFlags(argv)
const root = path.resolve(typeof flags.root === 'string' ? flags.root : process.cwd())
const verbose = flags.verbose === true
const only = typeof flags.only === 'string' ? flags.only : undefined

void main()

async function main(): Promise<void> {
  try {
    if (command === 'run') await cmdRun()
    else if (command === 'selftest') await cmdSelftest()
    else if (command === 'report') await cmdReport()
    else if (command === 'ratchet-update') await cmdRatchetUpdate()
    else if (command === 'list') cmdList()
    else {
      console.error(`QE_FATAL 未知命令：${command}（可用：run / selftest / report / ratchet-update / list）`)
      process.exitCode = 2
    }
  } catch (e) {
    console.error(`QE_FATAL ${(e as Error).message}`)
    process.exitCode = 1
  }
}

async function cmdRun(): Promise<void> {
  const readouts = await execute()
  const errors = readouts.reduce((n, r) => n + countByLevel(r.findings, 'error'), 0)
  const warnings = readouts.reduce((n, r) => n + countByLevel(r.findings, 'warn'), 0)
  const skipped = readouts.filter((r) => r.skipped).length
  console.log(`QE_RESULT guards=${readouts.length} errors=${errors} warnings=${warnings} skipped=${skipped} status=${errors > 0 ? 'red' : warnings > 0 || skipped > 0 ? 'yellow' : 'green'}`)

  const cmp = await compareRatchet(root, readouts)
  console.log(ratchetLine(cmp))
  for (const r of cmp.regressions) {
    console.log(`RATCHET_REGRESSION ${r.key} baseline=${r.baseline} current=${r.current}`)
  }
  for (const r of cmp.improvements) {
    console.log(`RATCHET_IMPROVED ${r.key} baseline=${r.baseline} current=${r.current}（请跑 qe:ratchet:update 收紧基线）`)
  }
  if (cmp.regressions.length > 0) process.exitCode = 1
  if (errors > 0) process.exitCode = 1
}

async function cmdRatchetUpdate(): Promise<void> {
  const readouts = await execute()
  const file = await writeBaseline(root, readouts)
  const before = await compareRatchet(root, readouts)
  console.log(`RATCHET_UPDATED file=${path.relative(root, file)} keys=${Object.keys(before.current).length}`)
}

async function execute(): Promise<GuardReadout[]> {
  const config = await loadConfig(root)
  const selected = selectGuards()
  if (selected.length === 0) {
    console.error(`QE_FATAL 未找到匹配 --only=${only} 的守卫`)
    process.exitCode = 2
    return []
  }
  console.log(`QE RUN root=${root} registry=${registry.length} guards=${selected.length}`)
  const readouts: GuardReadout[] = []
  for (const guard of selected) {
    try {
      const result = await guard.run({ root, config, registry })
      readouts.push({ guard: guard.id, findings: result.findings, scanned: result.scanned })
      if (verbose) console.log(`DETAIL [${guard.id}] blindSpots=${guard.blindSpots.join('; ')}`)
      for (const f of result.findings) {
        if (f.level !== 'info' || verbose) console.log(formatFinding(guard.id, f))
      }
      console.log(summaryLine(guard.id, result))
      if (countByLevel(result.findings, 'error') > 0) process.exitCode = 1
    } catch (e) {
      if (e instanceof NotApplicable) {
        readouts.push({ guard: guard.id, findings: [], scanned: `skipped: ${e.message}`, skipped: e.message })
        console.log(`GUARD_SUMMARY id=${guard.id} status=skipped errors=0 warnings=0 reason="${e.message}"`)
        continue
      }
      throw e
    }
  }
  return readouts
}

async function cmdSelftest(): Promise<void> {
  const selected = selectGuards()
  const results = await runSelfTest(selected, registry)
  for (const r of results) {
    console.log(
      `SELFTEST guard=${r.guard} case="${r.caseName}" expect=${r.expect} errors=${r.errors} warnings=${r.warnings} ${r.pass ? 'PASS' : 'FAIL'}${r.detail ? ' reason=' + r.detail : ''}`,
    )
  }
  const failed = results.filter((r) => !r.pass).length
  console.log(`SELFTEST_RESULT cases=${results.length} passed=${results.length - failed} failed=${failed} status=${failed === 0 ? 'green' : 'red'}`)
  if (failed > 0) process.exitCode = 1
}

async function cmdReport(): Promise<void> {
  const selected = selectGuards()
  const selftest = await runSelfTest(selected, registry)
  const config = await loadConfig(root)
  const readouts: GuardReadout[] = []
  for (const guard of selected) {
    try {
      const result = await guard.run({ root, config, registry })
      readouts.push({ guard: guard.id, findings: result.findings, scanned: result.scanned })
      console.log(summaryLine(guard.id, result))
    } catch (e) {
      if (e instanceof NotApplicable) {
        readouts.push({ guard: guard.id, findings: [], scanned: `skipped: ${e.message}`, skipped: e.message })
        console.log(`GUARD_SUMMARY id=${guard.id} status=skipped errors=0 warnings=0 reason="${e.message}"`)
        continue
      }
      throw e
    }
  }
  const { metrics, jsonFile, mdFile } = await writeReport({ root, config, registry, readouts, selftest })
  console.log(`METRICS invariants=${metrics.invariants.total} enforced=${metrics.invariants.enforced} partial=${metrics.invariants.partial} open=${metrics.invariants.open} enforcedCoverage=${metrics.enforcedCoverage}% zeroWriter=${metrics.zeroWriter} deadEnum=${metrics.deadEnum} selftest=${metrics.selftest.passed}/${metrics.selftest.cases} skipped=${metrics.skipped} incidents=${metrics.incidents.rate === null ? 'n/a' : metrics.incidents.rate + '%'}`)
  console.log(`REPORT json=${path.relative(root, jsonFile)} md=${path.relative(root, mdFile)} status=${metrics.status}`)
  if (metrics.status === 'red') process.exitCode = 1
}

function cmdList(): void {
  const rows = registry.map((i) => `${i.status.padEnd(8)} ${i.id.padEnd(12)} ${i.guard ?? '-'.padEnd(16)} ${i.statement}`)
  console.log(rows.join('\n'))
  console.log(
    `REGISTRY total=${registry.length} enforced=${registry.filter((i) => i.status === 'enforced').length} partial=${registry.filter((i) => i.status === 'partial').length} open=${registry.filter((i) => i.status === 'open').length}`,
  )
}

function selectGuards(): Guard[] {
  if (!only) return guards
  const selected = guards.filter((g) => g.id.startsWith(only) || g.invariants.some((i) => i.toLowerCase().includes(only.toLowerCase())))
  return selected
}

function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq > -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1)
    } else if (args[i + 1] && !args[i + 1].startsWith('--')) {
      out[a.slice(2)] = args[i + 1]
      i++
    } else {
      out[a.slice(2)] = true
    }
  }
  return out
}
