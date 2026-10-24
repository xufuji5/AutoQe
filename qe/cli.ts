#!/usr/bin/env node
import path from 'node:path'
import { existsSync } from 'node:fs'
import { loadConfig, mergeConfig } from './lib/config.ts'
import { readTextSafe, walkFiles } from './lib/fs.ts'
import { registry } from './registry/registry.ts'
import { guards } from './guards/index.ts'
import { countByLevel, formatFinding, summaryLine } from './lib/guard.ts'
import { NotApplicable } from './lib/not-applicable.ts'
import { runSelfTest } from './lib/selftest.ts'
import { loadIncidentMetrics, writeReport } from './lib/report.ts'
import { compareRatchet, ratchetLine, writeBaseline } from './lib/ratchet.ts'
import { decideStatus, nextStepFor, readBatches } from './lib/status.ts'
import {
  addWaiver,
  applyPackageAliases,
  loadWaivers,
  POLICIES,
  readExternalFindings,
  todayIso,
  triage,
  triageLines,
  writeTriage,
  type Locale,
} from './lib/triage.ts'
import { initProject } from './lib/init.ts'
import { loadSkills, skillsChecklist, skillsTable, validateSkills } from './lib/skills.ts'
import type { GuardReadout } from './lib/report.ts'
import type { Guard } from './lib/guard.ts'

const argv = process.argv.slice(2)
const command = argv[0] && !argv[0].startsWith('--') ? argv.shift()! : 'help'
const flags = parseFlags(argv)
const positional = positionals(argv)
const root = path.resolve(typeof flags.root === 'string' ? flags.root : process.cwd())
const verbose = flags.verbose === true
const only = typeof flags.only === 'string' ? flags.only : undefined
const cli = cliHint()

/** 按实际调用方式给出可复制的下一步：npx 安装 / 直接 node 复制目录 */
function cliHint(): string {
  const entry = process.argv[1] ?? ''
  if (!entry) return 'npx autoqe'
  if (entry.includes('node_modules')) return 'npx autoqe'
  const rel = path.relative(root, entry).split(path.sep).join('/')
  return rel && !rel.startsWith('..') ? `node ${rel}` : `node ${entry}`
}

/** NEXT 行必须能直接粘回去跑：root 不是当前目录时补 --root，否则命令会打在错的仓上 */
function rootArg(): string {
  const cwd = path.resolve(process.cwd())
  if (root === cwd) return ''
  const rel = path.relative(cwd, root).split(path.sep).join('/')
  return ` --root "${rel && !rel.startsWith('..') ? rel : root.replace(/\\/g, '/')}"`
}

void main()

async function main(): Promise<void> {
  try {
    if (flags.help === true) cmdHelp()
    else if (command === 'help') cmdHelp()
    else if (command === 'run') await cmdRun()
    else if (command === 'scan') await cmdReport()
    else if (command === 'init') await cmdInit()
    else if (command === 'doctor') await cmdDoctor()
    else if (command === 'status') await cmdStatus()
    else if (command === 'triage') await cmdTriage()
    else if (command === 'waive') await cmdWaive()
    else if (command === 'explain') cmdExplain()
    else if (command === 'prompt') await cmdPrompt()
    else if (command === 'selftest') await cmdSelftest()
    else if (command === 'report') await cmdReport()
    else if (command === 'ratchet-update') await cmdRatchetUpdate()
    else if (command === 'skills') await cmdSkills()
    else if (command === 'list') cmdList()
    else {
      console.error(
        `QE_FATAL unknown command: ${command} (available: help / init / doctor / status / triage / waive / run / explain / prompt / report / list / skills / selftest / ratchet-update)`,
      )
      process.exitCode = 2
    }
  } catch (e) {
    console.error(`QE_FATAL ${(e as Error).message}`)
    process.exitCode = 1
  }
}

/**
 * 配置解析：目标仓的 `qe.config.json` 为基线，`--config <file>`（或 `AUTOQE_CONFIG`）在上层覆盖。
 *
 * 存在的理由：审计别人的仓不该往人家的仓库里写文件。把「这个仓怎么接」写成引擎这边的一份配置，
 * 就能做到「引擎一份、账本在引擎这边、目标仓零改动」—— 这也是跨项目复用不产生第二份引擎的前提。
 */
async function currentConfig(): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  const base = await loadConfig(root)
  const override = typeof flags.config === 'string' ? flags.config : process.env.AUTOQE_CONFIG
  if (!override) return base
  const file = path.isAbsolute(override) ? override : path.resolve(root, override)
  const text = await readTextSafe(file)
  if (text === null) throw new Error(`--config 指向的文件不存在：${file}`)
  try {
    return mergeConfig(base, JSON.parse(text) as Record<string, never>)
  } catch (e) {
    throw new Error(`--config 文件解析失败：${file}：${(e as Error).message}`)
  }
}

function cmdHelp(): void {
  console.log(`AutoQe — invariant-first quality engineering for AI-assisted projects

USAGE
  autoqe <command> [options]

GETTING STARTED
  autoqe init                  scaffold qe.config.json, QE-00…09, qe/templates into this project
  autoqe doctor                check Node/config/schema/sources/baseline and print the next step
  autoqe status                stop-or-continue verdict from batch output + open gaps + ratchet
  autoqe triage                sort findings into fix / decide / record and write qe-report/triage.md
  autoqe waive CODE            add a waiver (reason + reviewBy required) to qe/waivers.json
  autoqe scan                  run all guards and write qe-report/qe-report.md in one shot
  autoqe run --root .          run all guards
  autoqe explain INV-CORE-01   explain one invariant (or a guard id such as inv22)
  autoqe prompt audit          print a ready-to-paste prompt with the current readings

EVERYDAY COMMANDS
  autoqe skills                list the accident knowledge base (why each rule exists)
  autoqe skills --check        validate it (missing provenance / self-question = error)
  autoqe skills --checklist    print an audit checklist generated from it (do not hand-maintain)
  autoqe list                  list all invariants with status
  autoqe report --root .       write qe-report/qe-report.md
  autoqe ratchet-update        freeze current counts as the baseline (only after human triage)
  autoqe selftest              counter-proof: every bad sample must fail for the intended reason

OPTIONS
  --root <dir>     target project root (default: current directory)
  --config <file>  overlay a config file on top of <root>/qe.config.json (or set AUTOQE_CONFIG)
                   lets you audit a repository without writing anything into it
  --only <id>      run a single guard, e.g. --only inv22
  --verbose        print blind spots and info-level findings
  --json           machine-readable output (explain, list)
  --apply          with triage: apply mechanical, additive fixes only (package aliases)
  --from <json>    with triage: read findings from a file instead of running guards
  --from-report <json>
                   with triage: read the guards block of a qe-report.json
  --reason <text>  with waive: why this finding is intentionally left alone (required)
  --review-by <date>
                   with waive: YYYY-MM-DD when the waiver must be re-adjudicated (required)
  --scope <path>   with waive: only suppress findings under this path prefix
  --lang <en|zh>   human-facing output language for triage / status / report (default: config.locale, else en)
  --force          overwrite files during init
  --help           show this help

EXAMPLES
  npx autoqe init && npx autoqe doctor && npx autoqe run --root .
  npx autoqe explain inv22 --json
  npx autoqe prompt fix --root . > prompt.txt

Docs: QE-00-index.md (map), QE-03 (audit playbook), docs/ai-agent-workflow.md (Codex/Claude Code/WorkBuddy).
`)
}

async function cmdInit(): Promise<void> {
  const result = await initProject(root, { force: flags.force === true })
  console.log(`INIT root=${root} created=${result.created.length} skipped=${result.skipped.length}`)
  for (const file of result.created) console.log(`  + ${path.relative(root, file)}`)
  for (const file of result.skipped) console.log(`  = ${path.relative(root, file)} (exists; use --force to overwrite)`)
  if (result.agentsMerged) {
    console.log('NOTE AGENTS.md already exists: wrote AGENTS.autoqe.md instead. Merge it by hand; never overwrite host rules.')
  }
  if (!result.schemaPath) {
    console.log('NOTE no Prisma schema found: schema.provider=none (schema-dependent guards will be skipped). Set schema.path after adding Prisma.')
  }
  console.log(`NOTE source.roots=${result.sourceRoots.join(',')} (edit qe.config.json if your code lives elsewhere)`)
  console.log('NEXT 1) edit qe.config.json: schema.path / source.roots / boundaries.publicRoutes / stores.moduleRoots')
  console.log(`NEXT 2) ${cli} run${rootArg()}`)
  console.log('NEXT 3) give AGENTS.md + QE-00-index.md to your AI agent and run the audit per QE-03')
}

async function cmdDoctor(): Promise<void> {
  const rows: string[] = []
  const node = process.versions.node
  const [major, minor] = node.split('.').map(Number)
  const nodeOk = major > 22 || (major === 22 && Number(minor) >= 18)
  rows.push(`DOCTOR root=${root} node=v${node}`)
  rows.push(`${nodeOk ? 'OK  ' : 'FAIL'} node >= 22.18`)

  const configFile = path.join(root, 'qe.config.json')
  const hasConfig = existsSync(configFile)
  rows.push(`${hasConfig ? 'OK  ' : 'WARN'} config ${hasConfig ? 'qe.config.json' : 'missing -> npx autoqe init'}`)

  const config = await currentConfig()
  const schemaFile = path.resolve(root, config.schema.path)
  if (config.schema.provider === 'none') {
    rows.push('SKIP schema provider=none (schema-dependent guards will be skipped)')
  } else {
    const text = await readTextSafe(schemaFile)
    if (text === null) {
      rows.push(`FAIL schema ${config.schema.path} missing -> fix schema.path or set provider=none`)
    } else {
      const models = (text.match(/^\s*model\s+\w+/gm) ?? []).length
      rows.push(`OK   schema ${config.schema.path} models=${models}`)
    }
  }

  let sourceTotal = 0
  for (const dir of config.source.roots) {
    if (!existsSync(path.resolve(root, dir))) {
      rows.push(`FAIL source ${dir} missing -> edit source.roots in qe.config.json`)
      continue
    }
    const files = await walkFiles(root, dir, { ignore: config.ignore, ext: config.source.extensions })
    sourceTotal += files.length
    rows.push(`${files.length > 0 ? 'OK  ' : 'WARN'} source ${dir} files=${files.length}`)
  }
  rows.push(`${sourceTotal > 0 ? 'OK  ' : 'WARN'} source total=${sourceTotal} files (collector=${config.source.collector})`)

  const contractsFile = path.resolve(root, config.contracts)
  const contractsText = await readTextSafe(contractsFile)
  if (contractsText === null) {
    rows.push(`WARN contracts ${config.contracts} missing -> inv06/inv07 will stay red`)
  } else {
    try {
      const parsed = JSON.parse(contractsText) as { promises?: unknown[]; gates?: unknown[] }
      rows.push(
        `OK   contracts ${config.contracts} promises=${parsed.promises?.length ?? 0} gates=${parsed.gates?.length ?? 0}`,
      )
    } catch {
      rows.push(`WARN contracts ${config.contracts} is not valid JSON`)
    }
  }

  const waiversFile = path.resolve(root, config.waivers)
  if (!existsSync(waiversFile)) {
    rows.push(`OK   waivers ${config.waivers} none (created by \`${cli} waive <CODE> --reason ... --review-by ...\`)`)
  } else {
    try {
      const store = await loadWaivers(root, config)
      const state = store.issues.length > 0 ? 'WARN' : 'OK  '
      rows.push(
        `${state} waivers ${config.waivers} entries=${store.waivers.length} invalid=${store.issues.length}${store.issues.length > 0 ? ' -> fix or delete those entries; they suppress nothing' : ''}`,
      )
    } catch (e) {
      rows.push(`FAIL waivers ${config.waivers} ${(e as Error).message}`)
    }
  }

  const ratchetFile = path.join(root, 'qe', 'ratchet.json')
  const hasRatchet = existsSync(ratchetFile)
  rows.push(`${hasRatchet ? 'OK  ' : 'WARN'} ratchet ${hasRatchet ? 'qe/ratchet.json' : 'missing -> npx autoqe ratchet-update'}`)

  const byStatus = (status: string): number => registry.filter((i) => i.status === status).length
  rows.push(
    `OK   guards=${guards.length} invariants=${registry.length} (enforced=${byStatus('enforced')} partial=${byStatus('partial')} open=${byStatus('open')})`,
  )

  console.log(rows.join('\n'))
  console.log(`NEXT ${cli} run${rootArg()}`)
  console.log(`     ${cli} explain INV-CORE-01`)
  console.log(`     ${cli} prompt audit${rootArg()} > prompt.txt`)
  if (!nodeOk || !hasConfig) process.exitCode = 1
}

async function cmdStatus(): Promise<void> {
  const config = await currentConfig()
  const locale: Locale = (typeof flags.lang === 'string' ? flags.lang : config.locale) === 'zh' ? 'zh' : 'en'
  const readouts = await execute(true)
  const ratchet = await compareRatchet(root, readouts)
  const batches = await readBatches(root, config)
  const incidents = await loadIncidentMetrics(root, config, registry)
  const today = new Date().toLocaleDateString('sv-SE')
  const verdict = decideStatus({ registry, readouts, ratchet, batches, today, auditDir: config.auditDir, locale })
  const errors = readouts.reduce((n, r) => n + countByLevel(r.findings, 'error'), 0)
  const warnings = readouts.reduce((n, r) => n + countByLevel(r.findings, 'warn'), 0)
  const skipped = readouts.filter((r) => r.skipped)
  const byStatus = (status: string): number => registry.filter((i) => i.status === status).length
  const openIds = registry.filter((i) => i.status === 'open').map((i) => i.id)
  const next = nextStepFor(verdict.decision, cli, locale, rootArg())

  if (flags.json === true) {
    console.log(
      JSON.stringify(
        {
          root,
          date: today,
          decision: verdict.decision,
          reason: verdict.reason,
          invariants: {
            total: registry.length,
            enforced: byStatus('enforced'),
            partial: byStatus('partial'),
            open: byStatus('open'),
            due: verdict.dueInvariants,
          },
          guards: { total: readouts.length, errors, warnings, skipped: skipped.length },
          ratchet: {
            present: ratchet.present,
            regressions: ratchet.regressions.length,
            improvements: ratchet.improvements.length,
            tracked: Object.keys(ratchet.current).length,
          },
          incidents,
          batches,
          residuals: verdict.residuals,
          next,
        },
        null,
        2,
      ),
    )
    if (verdict.decision === 'REPAIR') process.exitCode = 1
    return
  }

  const judged = batches.filter((b) => b.ledgerFound)
  const batchText =
    judged.length === 0
      ? 'batches=0'
      : `batches=${judged.length} ` +
        judged
          .slice(-6)
          .map((b) => `${b.date || b.dir}:${b.trueHoles}`)
          .join(' ')
  const openText = openIds.length <= 8 ? openIds.join(',') : `${openIds.slice(0, 8).join(',')},+${openIds.length - 8}`

  const lines = [
    `STATUS root=${root} date=${today}`,
    `READING invariants=${registry.length} enforced=${byStatus('enforced')} partial=${byStatus('partial')} open=${byStatus('open')} due=${verdict.dueInvariants.length}`,
    `READING guards=${readouts.length} errors=${errors} warnings=${warnings} skipped=${skipped.length}`,
    ratchetLine(ratchet),
    `READING incidents total=${incidents.total} matched=${incidents.matched} rate=${incidents.rate === null ? 'n/a' : incidents.rate + '%'}`,
    `READING ${batchText}`,
    `DECISION ${verdict.decision} reason="${verdict.reason}"`,
    `RESIDUAL open=${openIds.length} [${openText}] skipped=${skipped.length}`,
    ...skipped.map((r) => `RESIDUAL skipped ${r.guard}${locale === 'zh' ? '：' : ': '}${r.skipped}`),
    `NEXT ${next}`,
  ]
  console.log(lines.join('\n'))
  if (verdict.decision === 'REPAIR') process.exitCode = 1
}

async function cmdTriage(): Promise<void> {
  const config = await currentConfig()
  const external = typeof flags['from-report'] === 'string' ? flags['from-report'] : typeof flags.from === 'string' ? flags.from : undefined
  const readouts = external ? await readExternalFindings(path.resolve(root, external)) : await execute(true)
  let applied: string[] = []
  if (flags.apply === true && !external) {
    applied = await applyPackageAliases(root, config, registry)
  }
  const { waivers, issues } = await loadWaivers(root, config)
  const result = triage(readouts, { waivers, waiverIssues: issues, waiverFile: config.waivers })
  const locale: Locale = (typeof flags.lang === 'string' ? flags.lang : config.locale) === 'zh' ? 'zh' : 'en'
  if (external) console.log(`TRIAGE_SOURCE file=${path.relative(root, path.resolve(root, external))} readouts=${readouts.length}`)
  for (const line of triageLines(result, locale)) console.log(line)
  if (flags.apply === true && external) {
    console.log('TRIAGE_NOTE apply-skipped: --apply needs the live guards; external findings are judged read-only')
  }
  if (flags.apply === true && !external) {
    console.log(`TRIAGE_APPLIED aliases=${applied.length}${applied.length ? ' [' + applied.join(',') + ']' : ''}`)
  }
  const { jsonFile, mdFile } = await writeTriage(root, result, readouts, applied, cli, locale)
  console.log(`TRIAGE_REPORT json=${path.relative(root, jsonFile)} md=${path.relative(root, mdFile)}`)
  const next =
    locale === 'zh'
      ? `TRIAGE_NEXT ${result.fix + result.decide > 0 ? `从「今天只做这些」开始，处置完跑 ${cli} triage${rootArg()} 复核` : `没有待办；用 ${cli} run${rootArg()} 做一次全量复核`}`
      : `TRIAGE_NEXT ${result.fix + result.decide > 0 ? `start from "Today's list"; re-run ${cli} triage${rootArg()} after the batch` : `nothing actionable; re-check with ${cli} run${rootArg()}`}`
  console.log(next)
}

async function cmdWaive(): Promise<void> {
  const code = positional[0]
  if (!code) {
    console.error('QE_FATAL waive needs a finding code: autoqe waive ZERO_WRITER --reason "..." --review-by YYYY-MM-DD')
    process.exitCode = 2
    return
  }
  const config = await currentConfig()
  const { file, waiver } = await addWaiver(root, config, {
    code,
    reason: typeof flags.reason === 'string' ? flags.reason : '',
    reviewBy: typeof flags['review-by'] === 'string' ? flags['review-by'] : '',
    scope: typeof flags.scope === 'string' ? flags.scope : undefined,
    today: todayIso(),
  })
  console.log(
    `WAIVE_ADDED code=${waiver.code} reviewBy=${waiver.reviewBy}${waiver.scope ? ' scope=' + waiver.scope : ''} file=${path.relative(root, file)}`,
  )
  if (!POLICIES[code]) {
    console.log(
      `WAIVE_WARN code=${code} is not a registered disposition: triage keeps treating it as decide, and the waiver only suppresses if a guard emits this exact code`,
    )
  }
  console.log(`NEXT ${cli} triage${rootArg()}   # the finding stays visible as TRIAGE_WAIVED until reviewBy passes`)
}

function cmdExplain(): void {
  const key = positional[0]
  if (!key) {
    console.error('QE_FATAL explain needs an id: INV-CORE-01 or inv22')
    process.exitCode = 2
    return
  }
  const lower = key.toLowerCase()
  const inv = registry.find(
    (i) =>
      i.id.toLowerCase() === lower ||
      (i.guard ?? '').toLowerCase() === lower ||
      (i.guard ?? '').toLowerCase().endsWith(`:${lower}`),
  )
  if (!inv) {
    console.error(`QE_FATAL no invariant matches "${key}" (try: ${cli} list)`)
    process.exitCode = 2
    return
  }
  const publicEntry = { ...inv } as Record<string, unknown>
  delete publicEntry.c7
  if (flags.json === true) {
    console.log(JSON.stringify(publicEntry, null, 2))
    return
  }
  const guardId = inv.guard?.split(':').pop()
  const lines = [
    `${inv.id} [${inv.status}]`,
    `  rule: ${inv.statement}`,
    `  defect classes: ${inv.defectClasses.join(', ')}`,
    `  guard: ${inv.guard ?? '-'}`,
    `  bad sample: ${inv.badSample ?? '-'}`,
    inv.gap ? `  gap: ${inv.gap}` : '',
    inv.openReason ? `  open reason: ${inv.openReason}` : '',
    inv.revisitBy ? `  revisit by: ${inv.revisitBy}` : '',
    '  docs: QE-05-invariant-spec.md (lifecycle), QE-00-index.md (map)',
    guardId
      ? `  run: ${cli} run --root . --only ${guardId} --verbose`
      : '  run: no automated guard; manual review only',
  ].filter(Boolean)
  console.log(lines.join('\n'))
}

async function cmdPrompt(): Promise<void> {
  const task = (positional[0] ?? 'audit').toLowerCase()
  const tasks: Record<string, string> = {
    audit:
      'Run the QE-03 S0–S4 playbook on this repository. Create qe-audit/<project>-<date>/ and fill ' +
      '00-fact-baseline.md, 01-entry-inventory.md, 02-scan-log.md, 03-bug-ledger.md ' +
      '(P0–P3, evidence level E0–E3, file:line for every row), and 04-release-decision.md ' +
      '(12 gates, one conclusion per gate). Finish with a go / conditional / no-go decision.',
    fix:
      'Read qe-audit/<project>-<date>/03-bug-ledger.md and fix only the P0 rows in this batch. ' +
      'For each row: name the violated INV-*, change the code, add or update a bad sample when a guard ' +
      `is involved, then rerun \`${cli} run --root .\` and paste the new readings. Do not touch P1/P2 rows.`,
    review:
      'Review the current diff against the invariant registry. For every changed file, list which INV-* ' +
      `applies and whether the change violates it. Run \`${cli} run --root .\` and explain every ` +
      'error and warning. Do not modify code in this step.',
  }
  if (!tasks[task]) {
    console.error(`QE_FATAL prompt task must be one of: ${Object.keys(tasks).join(' / ')}`)
    process.exitCode = 2
    return
  }

  const readouts = await execute(true)
  const errors = readouts.reduce((n, r) => n + countByLevel(r.findings, 'error'), 0)
  const warnings = readouts.reduce((n, r) => n + countByLevel(r.findings, 'warn'), 0)
  const skipped = readouts.filter((r) => r.skipped).length
  const status = errors > 0 ? 'red' : warnings > 0 || skipped > 0 ? 'yellow' : 'green'
  const findings = readouts.flatMap((r) =>
    r.findings.filter((f) => f.level !== 'info').map((f) => `- [${r.guard}] ${formatFinding(r.guard, f)}`),
  )
  const project = path.basename(root)
  const text = `# AutoQe ${task} task

Repository: ${root}
Project: ${project}

## Facts (from \`${cli} run --root .\` — do not contradict or soften)
QE_RESULT guards=${readouts.length} errors=${errors} warnings=${warnings} skipped=${skipped} status=${status}
${findings.length > 0 ? findings.join('\n') : '- no error/warning findings'}

## Read first
- AGENTS.md
- QE-00-index.md
- QE-03-project-audit-and-release-gate.md
- docs/ai-agent-workflow.md (if present)

## Task
${tasks[task]}

## Rules
- Every finding needs evidence: file:line, a command reading, or a ledger row (E0–E3).
- Never claim "done" or "green" without an addressable reading.
- Skipped guards stay skipped; never report them as passed.
- Do not edit qe.config.json, qe.contracts.json, or qe/ratchet.json to silence findings.
- Ask before any irreversible action.
`
  console.log(text)
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

async function execute(silent = false): Promise<GuardReadout[]> {
  const config = await currentConfig()
  const selected = selectGuards()
  if (selected.length === 0) {
    console.error(`QE_FATAL 未找到匹配 --only=${only} 的守卫`)
    process.exitCode = 2
    return []
  }
  if (!silent) console.log(`QE RUN root=${root} registry=${registry.length} guards=${selected.length}`)
  const readouts: GuardReadout[] = []
  for (const guard of selected) {
    try {
      const result = await guard.run({ root, config, registry })
      readouts.push({ guard: guard.id, findings: result.findings, scanned: result.scanned })
      if (!silent && verbose) console.log(`DETAIL [${guard.id}] blindSpots=${guard.blindSpots.join('; ')}`)
      if (!silent) {
        for (const f of result.findings) {
          if (f.level !== 'info' || verbose) console.log(formatFinding(guard.id, f))
        }
        console.log(summaryLine(guard.id, result))
      }
      if (!silent && countByLevel(result.findings, 'error') > 0) process.exitCode = 1
    } catch (e) {
      if (e instanceof NotApplicable) {
        readouts.push({ guard: guard.id, findings: [], scanned: `skipped: ${e.message}`, skipped: e.message })
        if (!silent) console.log(`GUARD_SUMMARY id=${guard.id} status=skipped errors=0 warnings=0 reason="${e.message}"`)
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
  const config = await currentConfig()
  if (typeof flags.lang === 'string') config.locale = flags.lang === 'zh' ? 'zh' : 'en'
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

/**
 * 事故知识库入口。三种用法对应三种消费方式：
 *   列出（谁、哪类、连哪条规则）／校验（缺出处、缺自省问题）／生成清单（立项与复盘当场用）。
 */
async function cmdSkills(): Promise<void> {
  const dir = path.join(import.meta.dirname, 'skills')
  const skills = await loadSkills(dir)
  if (skills.length === 0) {
    console.error(`QE_FATAL 知识库为空：${dir}（0 条不等于没有问题）`)
    process.exitCode = 1
    return
  }
  if (flags.checklist === true) {
    console.log(skillsChecklist(skills))
    return
  }
  const { errors, warnings } = validateSkills(skills)
  if (flags.check === true) {
    for (const w of warnings) console.log(`WARN ${w}`)
    for (const e of errors) console.log(`ERROR ${e}`)
    console.log(`SKILLS total=${skills.length} errors=${errors.length} warnings=${warnings.length}`)
    if (errors.length > 0) process.exitCode = 1
    return
  }
  console.log(skillsTable(skills))
  console.log(`SKILLS total=${skills.length}（--check 校验形状 / --checklist 生成审计清单）`)
}

function cmdList(): void {
  const publicRegistry = registry.map((i) => {
    const entry = { ...i } as Record<string, unknown>
    delete entry.c7
    return entry
  })
  if (flags.json === true) {
    console.log(JSON.stringify(publicRegistry, null, 2))
    return
  }
  const rows = registry.map((i) => `${i.status.padEnd(8)} ${i.id.padEnd(12)} ${(i.guard ?? '-').padEnd(16)} ${i.statement}`)
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

function positionals(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      if (!a.includes('=') && args[i + 1] && !args[i + 1].startsWith('--')) i++
      continue
    }
    out.push(a)
  }
  return out
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
