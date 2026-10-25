#!/usr/bin/env node
import path from 'node:path'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { loadConfig, mergeConfig, type QeConfig } from './lib/config.ts'
import { readTextSafe, walkFiles } from './lib/fs.ts'
import { registry } from './registry/registry.ts'
import { guards } from './guards/index.ts'
import { countByLevel, formatFinding, summaryLine } from './lib/guard.ts'
import { NotApplicable } from './lib/not-applicable.ts'
import { runSelfTest } from './lib/selftest.ts'
import { CODE_ONLY_SELFTEST } from './lib/code-only.ts'
import { ENGINE_SELFTEST } from './lib/engine-selftest.ts'
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
import { resolveReportDir, displayPath } from './lib/report-path.ts'
import { flushProfile, timeStage } from './lib/profile.ts'
import {
  assertBoundary,
  assertIsolation,
  crossTalkRoots,
  ensureIsolation,
  externalInputs,
  inspectIsolation,
  isolationLine,
  parseIsolationRoots,
  samePath,
  stripProjectEnv,
  type IsolationState,
} from './lib/isolation.ts'
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

/** NEXT 行必须能直接粘回去跑：root 不是当前目录时补 --root；用了外部配置时补 --config（否则重跑会换成默认配置） */
function rootArg(): string {
  const cwd = path.resolve(process.cwd())
  let out = ''
  if (root !== cwd) {
    const rel = path.relative(cwd, root).split(path.sep).join('/')
    out = ` --root "${rel && !rel.startsWith('..') ? rel : root.replace(/\\/g, '/')}"`
  }
  const ext = externalConfigPath()
  if (ext) out += ` --config "${ext.replace(/\\/g, '/')}"`
  return out
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
    else if (command === 'multi') await cmdMulti()
    else if (command === 'skills') await cmdSkills()
    else if (command === 'list') cmdList()
    else {
      console.error(
        `QE_FATAL unknown command: ${command} (available: help / init / doctor / status / triage / waive / run / multi / explain / prompt / report / list / skills / selftest / ratchet-update)`,
      )
      process.exitCode = 2
    }
  } catch (e) {
    console.error(`QE_FATAL ${(e as Error).message}`)
    process.exitCode = 1
  } finally {
    // QE_PROFILE=1 时在命令结束时输出分段耗时；默认关闭时什么也不做
    flushProfile()
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
  const override = externalConfigPath()
  if (!override) {
    configFilePath = null
    isolation = inspectIsolation(root, null)
    assertIsolation(isolation)
    assertBoundary(root, base)
    return base
  }
  const text = await readTextSafe(override)
  if (text === null) throw new Error(`--config 指向的文件不存在：${override}`)
  let parsed: Record<string, never>
  try {
    parsed = JSON.parse(text) as Record<string, never>
  } catch (e) {
    throw new Error(`--config 文件解析失败：${override}：${(e as Error).message}`)
  }
  configFilePath = override
  const config = mergeConfig(base, parsed)
  // 隔离硬门：状态根身份（外部状态不许跨项目复用）+ 配置声明的路径围栏。
  // 放在这里而不是各守卫里：越早拒绝，A 项目的理解越没有机会混进 B 的判定。
  isolation = inspectIsolation(root, override)
  assertIsolation(isolation)
  assertBoundary(root, config)
  return config
}

/** 本次运行的状态根（由 currentConfig 解析）；写状态前必须确保身份就位 */
let isolation: IsolationState | null = null

function requireIsolation(config: QeConfig): IsolationState {
  if (!isolation) throw new Error('QE_ISOLATION_NOT_READY 隔离状态未初始化（配置尚未加载）')
  ensureIsolation(isolation, config)
  return isolation
}

/** 外部配置的绝对路径（`--config` 或 `AUTOQE_CONFIG`）；未指定时为 null */
let configFilePath: string | null = null

function externalConfigPath(): string | null {
  const override = typeof flags.config === 'string' ? flags.config : process.env.AUTOQE_CONFIG
  if (!override) return null
  return path.isAbsolute(override) ? override : path.resolve(root, override)
}

/** 报告落点：`--no-report` / `--out` / 外部配置旁 / config.reportDir / root 默认，单源解析 */
function reportDirFor(config: QeConfig): string | null {
  return resolveReportDir({
    root,
    config,
    configFile: configFilePath ?? externalConfigPath(),
    out: typeof flags.out === 'string' ? flags.out : null,
    noReport: flags['no-report'] === true,
  })
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
  autoqe multi --roots a,b     scan several projects at the same time, one process per project
                               (no shared state: each child gets its own cwd, env and report dir)
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
  --roots <a,b>    with multi: project roots to scan concurrently (one child process each)
  --command <c>    with multi: run / scan / report / triage / status / doctor (default: scan)
  --inherit-env    with multi: keep AUTOQE_CONFIG / AUTOQE_DENYLIST in children (default: stripped)
  --config <file>  overlay a config file on top of <root>/qe.config.json (or set AUTOQE_CONFIG)
                   external config keeps reports beside the config file by default, so the
                   audited repository stays untouched
  --out <dir>      write report/triage to this directory (overrides --config default)
  --no-report      print readings only; write no report or triage files at all
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
  // init 是显式的「把状态根交给这个项目」动作，故允许在已有状态时就地绑定；
  // 运行期（run/report/waive）则相反：没有身份但有状态一律拒绝（INV-ISO-02）。
  const iso = inspectIsolation(root, null)
  const marker = ensureIsolation(iso, undefined, { adopt: true })
  console.log(`INIT root=${root} created=${result.created.length} skipped=${result.skipped.length}`)
  console.log(`INIT project=${marker.id} marker=${path.relative(root, iso.markerFile)}`)
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
  const externalFile = externalConfigPath()
  const hasLocal = existsSync(configFile)
  const hasExternal = externalFile ? existsSync(externalFile) : false
  const hasConfig = hasExternal || hasLocal
  if (externalFile) {
    rows.push(
      `${hasExternal ? 'OK  ' : 'FAIL'} config ${externalFile}${hasExternal ? ' (external overlay; target repo untouched)' : ' missing -> fix --config'}`,
    )
  } else {
    rows.push(`${hasLocal ? 'OK  ' : 'WARN'} config ${hasLocal ? 'qe.config.json' : 'missing -> npx autoqe init'}`)
  }

  // doctor 是诊断入口：隔离违约要显示成 FAIL 行，而不是让命令直接崩掉
  let config: QeConfig
  try {
    config = await currentConfig()
  } catch (e) {
    rows.push(`FAIL isolation ${(e as Error).message}`)
    console.log(rows.join('\n'))
    process.exitCode = 1
    return
  }
  const reportDir = reportDirFor(config)
  rows.push(reportDir ? `OK   report ${displayPath(root, reportDir)}` : 'SKIP report --no-report（只出读数，不落盘）')
  // 跨项目隔离读数：状态根身份没建立时只提示，不在 doctor 里代写（写身份是 init 的显式动作）
  if (isolation) {
    rows.push(
      `${isolation.marker ? 'OK  ' : 'WARN'} isolation mode=${isolation.mode} stateRoot=${isolation.stateRoot} ` +
        `${isolation.marker ? `id=${isolation.marker.id}` : `unbound -> ${cli} init`}`,
    )
    if (externalInputs().length > 0) rows.push(`WARN isolation env=${externalInputs().join(',')}（环境变量跨项目继承，确认指向本项目）`)
  }
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

  const evidenceDirs = config.source.evidenceRoots ?? []
  if (evidenceDirs.length === 0) {
    rows.push('SKIP evidence none -> set source.evidenceRoots (e.g. ["scripts","prisma"]) so seed/import writes count')
  } else {
    let evidenceTotal = 0
    for (const dir of evidenceDirs) {
      if (!existsSync(path.resolve(root, dir))) {
        rows.push(`WARN evidence ${dir} missing -> fix source.evidenceRoots`)
        continue
      }
      const files = await walkFiles(root, dir, { ignore: config.ignore, ext: config.source.extensions })
      evidenceTotal += files.length
    }
    rows.push(
      `OK   evidence ${evidenceDirs.join(',')} files=${evidenceTotal} (write/enum evidence only; not application surface)`,
    )
  }

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

  const spec = config.spec
  if (!spec || spec.docs.length === 0) {
    rows.push(
      'OK   spec docs=none (AQ-ABS skipped: set "spec": { "docs": ["docs/spec"] } to reconcile docs against implementation)',
    )
  } else {
    const found: string[] = []
    const missing: string[] = []
    for (const dir of spec.docs) {
      const abs = path.resolve(root, dir)
      if (existsSync(abs)) found.push(dir)
      else missing.push(dir)
    }
    rows.push(
      `${missing.length > 0 ? 'WARN' : 'OK  '} spec docs=${spec.docs.length} found=[${found.join(',')}]` +
        `${missing.length > 0 ? ` missing=[${missing.join(',')}] -> fix spec.docs or the guard stays skipped` : ''}` +
        `${spec.enforce === true && (spec.docsOwner ?? '').trim() === '' ? ' | enforce=true without docsOwner -> gaps stay candidates' : ''}`,
    )
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
  // 基线是**工具侧状态**，跟着配置走：外部配置模式（--config）下 stateRoot = 配置所在目录，
  // 不是被审计仓根。写/读两侧必须用同一个根，否则「基线永远建不起来」会被读成「零回归」。
  const ratchet = await compareRatchet(requireIsolation(config).stateRoot, readouts)
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
  requireIsolation(config)
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
  const outDir = reportDirFor(config)
  const { jsonFile, mdFile } = await writeTriage(root, result, readouts, applied, cli, locale, outDir)
  console.log(
    jsonFile && mdFile
      ? `TRIAGE_REPORT json=${displayPath(root, jsonFile)} md=${displayPath(root, mdFile)}`
      : 'TRIAGE_REPORT skipped reason="--no-report"（清单已在上方输出，未落盘）',
  )
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
  requireIsolation(config)
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

/**
 * 本进程内的降级读数（`downgrades` 生效了几个 error 条）。
 * 放在模块级是为了让 `QE_RESULT` 能带出去——降级是政策而非缺陷，但**必须能被读到**。
 */
const policyStats = { downgraded: 0 }

async function cmdRun(): Promise<void> {
  const readouts = await execute()
  // execute() 内部已加载配置并完成隔离校验；这里再取一次是为了拿 stateRoot。
  // currentConfig() 是纯读 + 纯校验（loadConfig/inspectIsolation/assertBoundary），重复调用无副作用。
  const stateRoot = requireIsolation(await currentConfig()).stateRoot
  const errors = readouts.reduce((n, r) => n + countByLevel(r.findings, 'error'), 0)
  const warnings = readouts.reduce((n, r) => n + countByLevel(r.findings, 'warn'), 0)
  const skipped = readouts.filter((r) => r.skipped).length
  const skippedReadouts = readouts.filter((r) => r.skipped)
  // 跳过按 code 列出而不再只给一个数字：`skipped=6` 谁都读不出「哪六类射程被关掉了」，
  // 而跳过是不进 errors/warnings 的 —— 一个数字最容易被当成「无害」。
  const skipSummary =
    skippedReadouts.length === 0
      ? '0'
      : `${skippedReadouts.length}[${skippedReadouts.map((r) => `${r.guard}=${r.skipCode ?? '?'}`).join(',')}]`
  console.log(`QE_RESULT guards=${readouts.length} errors=${errors} warnings=${warnings} skipped=${skipSummary} downgraded=${policyStats.downgraded} status=${errors > 0 ? 'red' : warnings > 0 || skippedReadouts.length > 0 ? 'yellow' : 'green'}`)

  const cmp = await compareRatchet(stateRoot, readouts)
  console.log(ratchetLine(cmp))
  for (const r of cmp.regressions) {
    // 三种坏法必须分开说，否则人按同一句文案去修会修错方向：
    //   ① 首次登记（baseline=0）：这类读数基线里本来没有 —— 可能是新判据上线、也可能是
    //      机制迁移（跳过刚被纳入统计）。**它不一定是变差**，但也绝不能顺手 update 抹掉。
    //   ② 跳过变多：射程缩小，读数反而会更好看，与缺陷变多的修法完全相反。
    //   ③ 缺陷变多：最直白的一种。
    const how =
      r.baseline === 0
        ? r.code.startsWith('SKIP:')
          ? `首次登记的跳过（基线无此类，code=${r.code.slice(5)}；先裁决再 update）`
          : '首次登记的读数（基线里没有这一类；先裁决再 update）'
        : r.code.startsWith('SKIP:')
          ? `射程缩小（多关掉一类「不适用」，code=${r.code.slice(5)}）`
          : '缺陷变多'
    console.log(`RATCHET_REGRESSION ${r.key} baseline=${r.baseline} current=${r.current} kind=${how}`)
  }
  for (const r of cmp.improvements) {
    const how = r.code.startsWith('SKIP:') ? '射程恢复' : '债务减少'
    console.log(`RATCHET_IMPROVED ${r.key} baseline=${r.baseline} current=${r.current}（${how}；请跑 qe:ratchet:update 收紧基线）`)
  }
  if (cmp.regressions.length > 0) process.exitCode = 1
  if (errors > 0) process.exitCode = 1
}

/**
 * 并发扫描/修复多个项目：**一个项目一个子进程**。
 *
 * 为什么不是同一个进程里并发跑多个 root：引擎里的配置、隔离身份、报告路径、自证样本落盘
 * 都是「一个进程只装一个项目」的单例。共享进程等于让两个项目共享这些单例，而污染发生时
 * 不会报错——读到的仍是「0 错」。所以并发必须靠**进程边界**，不能靠调用者自觉。
 *
 * 子进程 env 里默认剥掉 AUTOQE_CONFIG / AUTOQE_DENYLIST：这两者会跨项目继承，
 * 而每个项目必须用自己的配置与黑名单。需要继承时显式加 --inherit-env。
 */
async function cmdMulti(): Promise<void> {
  const spec = typeof flags.roots === 'string' ? flags.roots : ''
  const roots = [
    ...new Set(
      spec
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => path.resolve(s)),
    ),
  ]
  if (roots.length === 0) {
    throw new Error('QE_USAGE multi 需要 --roots <dir>[,<dir>...]（例：--roots ../a,../b）')
  }
  if (typeof flags.config === 'string' || process.env.AUTOQE_CONFIG) {
    throw new Error(
      'QE_ISOLATION_MULTI_EXTERNAL_CONFIG multi 不支持 --config / AUTOQE_CONFIG：' +
        '外部配置绑定的是唯一的被审计项目，不能同时服务多个 root。请为每个项目各跑一次，或把配置写进各自的项目根',
    )
  }
  const sub = typeof flags.command === 'string' ? flags.command : 'scan'
  const allowed = new Set(['run', 'scan', 'report', 'triage', 'status', 'doctor'])
  if (!allowed.has(sub)) {
    throw new Error(`QE_USAGE multi --command 只支持 ${[...allowed].join(' / ')}（收到 ${sub}）`)
  }
  const missing = roots.filter((r) => !existsSync(r))
  if (missing.length > 0) throw new Error(`QE_USAGE 以下 root 不存在：${missing.join('、')}`)

  const extra: string[] = []
  if (sub === 'triage' && flags.apply === true) extra.push('--apply')
  if (typeof flags.lang === 'string') extra.push('--lang', flags.lang)
  if (flags.verbose === true) extra.push('--verbose')
  if (flags['no-report'] === true) extra.push('--no-report')

  // 项目级变量一律剥掉（不止 CONFIG/DENYLIST）：按前缀取，未来新增的 AUTOQE_* 自动隔离。
  // 需要继承时显式 --inherit-env —— 引擎不替调用方猜「哪些该继承」。
  const { env, stripped } = stripProjectEnv(process.env, { keep: flags['inherit-env'] === true })
  if (stripped.length > 0) {
    console.log(`MULTI_ENV_STRIPPED ${stripped.join(',')}（每个项目必须用自己的配置/黑名单；需要继承请加 --inherit-env）`)
  }

  const entry = process.argv[1]
  if (!entry) throw new Error('QE_USAGE 无法定位 CLI 入口（process.argv[1] 为空）')

  const results = await Promise.all(roots.map((r) => runChildProject(entry, [sub, '--root', r, ...extra], r, env)))
  for (const r of results) {
    console.log(`\n=== MULTI root=${r.root} exit=${r.code} ===`)
    if (r.stdout) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : r.stdout + '\n')
    if (r.stderr.trim()) process.stderr.write(r.stderr.endsWith('\n') ? r.stderr : r.stderr + '\n')
  }

  // 行为判据：每个子进程的 ISOLATION 读数必须指向自己那个 root，且输出里不得出现别的 root。
  // 这两件事坏了都不会报错——只会「读数照常绿，但 B 的报告里有 A 的路径」。
  let unverified = 0
  let mismatched = 0
  let crossed = 0
  for (const r of results) {
    const printed = parseIsolationRoots(r.stdout)
    if (printed.length === 0) {
      unverified++
      console.log(`MULTI_ISOLATION_UNVERIFIED root=${r.root}（子进程没有输出 ISOLATION 读数：本轮无法证明它扫的是自己）`)
    } else if (printed.some((p) => !samePath(p, r.root))) {
      mismatched++
      console.log(`MULTI_ISOLATION_MISMATCH root=${r.root} printed=${printed.join(',')}（子进程实际 root 与指派的不一致：数据已串）`)
    }
    const others = roots.filter((o) => !samePath(o, r.root))
    const hits = crossTalkRoots(r.root, others, `${r.stdout}\n${r.stderr}`)
    if (hits.length > 0) {
      crossed++
      console.log(`MULTI_CROSS_TALK root=${r.root} 输出里出现另一个项目的路径：${hits.join('、')}（子进程读/写了不属于它的树）`)
    }
  }

  const failed = results.filter((r) => r.code !== 0)
  const isolationOk = mismatched === 0 && crossed === 0
  console.log(
    `\nMULTI_RESULT roots=${roots.length} failed=${failed.length} status=${failed.length > 0 ? 'red' : 'green'} ` +
      `isolation=${unverified === 0 ? 'verified' : `unverified=${unverified}`} crossTalk=${crossed} mismatched=${mismatched}`,
  )
  for (const r of results) {
    const m = /QE_RESULT guards=(\d+) errors=(\d+) warnings=(\d+) skipped=(\d+)/.exec(r.stdout)
    console.log(multiLine(r.root, m, r.code))
  }
  // 串读/错位是**隔离故障**，不是「某个项目有缺陷」：两者都必须让 multi 整体失败
  if (failed.length > 0 || !isolationOk) process.exitCode = 1
}

function multiLine(root: string, m: RegExpExecArray | null, code: number): string {
  if (!m) return `MULTI root=${root} exit=${code}`
  return `MULTI root=${root} errors=${m[2]} warnings=${m[3]} skipped=${m[4]} exit=${code}`
}

interface ChildResult {
  root: string
  code: number
  stdout: string
  stderr: string
}

/** 独立进程跑一个项目：cwd 也切到该项目，子进程任何相对路径都不会落回调用方 */
function runChildProject(
  entry: string,
  args: string[],
  projectRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      stderr += `\nMULTI_TIMEOUT root=${projectRoot}（10 分钟未完成，已终止）\n`
      child.kill()
    }, 10 * 60 * 1000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ root: projectRoot, code: code ?? 1, stdout, stderr })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ root: projectRoot, code: 1, stdout, stderr: stderr + e.message })
    })
  })
}

async function cmdRatchetUpdate(): Promise<void> {
  const readouts = await execute()
  // 写状态前必须过 requireIsolation：它内部 ensureIsolation 会绑定身份，并在「状态根里已有账本
  // 但无身份文件」时直接拒绝（否则等于替不知道哪个项目认账）。
  const stateRoot = requireIsolation(await currentConfig()).stateRoot
  const file = await writeBaseline(stateRoot, readouts, { force: flags.force === true })
  const before = await compareRatchet(stateRoot, readouts)
  console.log(`RATCHET_UPDATED file=${displayPath(root, file)} keys=${Object.keys(before.current).length}`)
}

async function execute(silent = false): Promise<GuardReadout[]> {
  const config = await currentConfig()
  const iso = requireIsolation(config)
  const selected = selectGuards()
  if (selected.length === 0) {
    console.error(`QE_FATAL 未找到匹配 --only=${only} 的守卫`)
    process.exitCode = 2
    return []
  }
  if (!silent) {
    console.log(`QE RUN root=${root} registry=${registry.length} guards=${selected.length}`)
    console.log(isolationLine(iso))
  }
  // 降级读数：本进程内被配置降级的 error 条数（QE_RESULT 里带出去，避免「降级」在读数上隐形）
  policyStats.downgraded = 0
  const readouts: GuardReadout[] = []
  for (const guard of selected) {
    try {
      const { readout, downgraded } = await runWithPolicy(guard, config)
      policyStats.downgraded += downgraded
      readouts.push(readout)
      const result = { findings: readout.findings, scanned: readout.scanned ?? '' }
      if (!silent && verbose) console.log(`DETAIL [${guard.id}] blindSpots=${guard.blindSpots.join('; ')}`)
      if (!silent) {
        // 降级必须可见：否则「本轮 0 错」与「本轮把 159 条错判成警告」在日志上长得一样
        if (downgraded > 0) {
          console.log(`GUARD_DOWNGRADED id=${guard.id} errors=${downgraded}→warn reason="qe.config.json 的 downgrades（误报已实测，见审计报告）"`)
        }
        for (const f of result.findings) {
          if (f.level !== 'info' || verbose) console.log(formatFinding(guard.id, f))
        }
        console.log(summaryLine(guard.id, result))
      }
      if (!silent && countByLevel(result.findings, 'error') > 0) process.exitCode = 1
    } catch (e) {
      if (e instanceof NotApplicable) {
        readouts.push({
          guard: guard.id,
          findings: [],
          scanned: `skipped[${e.code}]: ${e.reason}`,
          skipped: e.reason,
          skipCode: e.code,
        })
        if (!silent) console.log(`GUARD_SUMMARY id=${guard.id} status=skipped code=${e.code} errors=0 warnings=0 reason="${e.reason}"`)
        continue
      }
      throw e
    }
  }
  // 配置键必须精确等于守卫 id（守卫 id 有全名，如 inv01-column-writer）。
  // 写错一个字母就等于「配了但没生效」，而读数上完全看不出来 —— 只能显式报出来。
  // 不做前缀匹配：前缀匹配等于恒真（写 `inv01` 会命中 `inv01-x`，也可能命中不存在的守卫）。
  for (const key of Object.keys(config.downgrades ?? {})) {
    if (!selected.some((g) => g.id === key)) {
      console.log(`POLICY_UNKNOWN_GUARD id=${key}（downgrades 里的键必须精确等于守卫 id；本轮未生效）`)
    }
  }
  return readouts
}

/**
 * 跑一个守卫并施加配置里的降级策略（**唯一**一处施加点，run/ratchet/report 共用）。
 * 判据不知道自己的级别被改过——它只负责找形状；级别是本仓的政策选择。
 */
async function runWithPolicy(
  guard: Guard,
  config: QeConfig,
): Promise<{ readout: GuardReadout; downgraded: number }> {
  const result = await guard.run({ root, config, registry })
  const mode = config.downgrades?.[guard.id]
  if (mode !== 'warn') {
    return { readout: { guard: guard.id, findings: result.findings, scanned: result.scanned }, downgraded: 0 }
  }
  let downgraded = 0
  const findings = result.findings.map((f) => {
    if (f.level !== 'error') return f
    downgraded++
    return { ...f, level: 'warn' as const }
  })
  return { readout: { guard: guard.id, findings, scanned: result.scanned }, downgraded }
}

async function cmdSelftest(): Promise<void> {
  const selected = selectGuards()
  const results = await runSelfTest(selected, registry)
  for (const r of results) {
    console.log(
      `SELFTEST guard=${r.guard} case="${r.caseName}" expect=${r.expect} errors=${r.errors} warnings=${r.warnings} ${r.pass ? 'PASS' : 'FAIL'}${r.detail ? ' reason=' + r.detail : ''}`,
    )
  }
  // 工具自身的自证例：它们不是守卫的 fixture，漏跑不会有任何症状 —— 只能显式挂在这里
  for (const c of CODE_ONLY_SELFTEST) {
    console.log(`SELFTEST lib=code-only case="${c.name}" ${c.ok ? 'PASS' : 'FAIL'}${c.ok ? '' : ' detail=' + JSON.stringify(c.detail)}`)
  }
  for (const c of ENGINE_SELFTEST) {
    console.log(`SELFTEST lib=engine case="${c.name}" ${c.ok ? 'PASS' : 'FAIL'}${c.ok ? '' : ' detail=' + JSON.stringify(c.detail)}`)
  }
  const libFailed = CODE_ONLY_SELFTEST.filter((c) => !c.ok).length + ENGINE_SELFTEST.filter((c) => !c.ok).length
  const total = results.length + CODE_ONLY_SELFTEST.length + ENGINE_SELFTEST.length
  const failed = results.filter((r) => !r.pass).length + libFailed
  console.log(`SELFTEST_RESULT cases=${total} passed=${total - failed} failed=${failed} status=${failed === 0 ? 'green' : 'red'}`)
  if (failed > 0) process.exitCode = 1
}

async function cmdReport(): Promise<void> {
  const selected = selectGuards()
  const selftest = await timeStage('selftest.guards', () => runSelfTest(selected, registry))
  // 报告自带自证，`qe:ci` 不再单独跑一遍 `qe:selftest`（同一次判定，省一遍全量样本）。
  // 工具自身的自证例也在这里跑：它们不是守卫 fixture，漏跑没有任何症状。
  const libCases = [
    ...CODE_ONLY_SELFTEST.map((c) => ({ name: `code-only/${c.name}`, ok: c.ok, detail: JSON.stringify(c.detail) })),
    ...ENGINE_SELFTEST.map((c) => ({ name: `engine/${c.name}`, ok: c.ok, detail: JSON.stringify(c.detail) })),
  ]
  const failedGuards = selftest.filter((r) => !r.pass)
  const failedLib = libCases.filter((c) => !c.ok)
  for (const r of failedGuards) {
    console.log(
      `SELFTEST guard=${r.guard} case="${r.caseName}" expect=${r.expect} errors=${r.errors} warnings=${r.warnings} FAIL${r.detail ? ' reason=' + r.detail : ''}`,
    )
  }
  for (const c of failedLib) console.log(`SELFTEST lib=${c.name} FAIL detail=${c.detail}`)
  const selftestCases = selftest.length + libCases.length
  const selftestFailed = failedGuards.length + failedLib.length
  console.log(
    `SELFTEST_RESULT cases=${selftestCases} passed=${selftestCases - selftestFailed} failed=${selftestFailed} status=${selftestFailed === 0 ? 'green' : 'red'}`,
  )
  if (selftestFailed > 0) process.exitCode = 1
  const config = await currentConfig()
  const iso = requireIsolation(config)
  console.log(isolationLine(iso))
  if (typeof flags.lang === 'string') config.locale = flags.lang === 'zh' ? 'zh' : 'en'
  const readouts: GuardReadout[] = []
  for (const guard of selected) {
    try {
      // 与 run 共用同一个降级施加点：报告与读数的口径必须是同一次判定产物
      const { readout, downgraded } = await timeStage(`guard.${guard.id}`, () => runWithPolicy(guard, config))
      readouts.push(readout)
      if (downgraded > 0) console.log(`GUARD_DOWNGRADED id=${guard.id} errors=${downgraded}→warn reason="qe.config.json 的 downgrades"`)
      console.log(summaryLine(guard.id, { findings: readout.findings, scanned: readout.scanned }))
    } catch (e) {
      if (e instanceof NotApplicable) {
        readouts.push({
          guard: guard.id,
          findings: [],
          scanned: `skipped[${e.code}]: ${e.reason}`,
          skipped: e.reason,
          skipCode: e.code,
        })
        console.log(`GUARD_SUMMARY id=${guard.id} status=skipped code=${e.code} errors=0 warnings=0 reason="${e.reason}"`)
        continue
      }
      throw e
    }
  }
  const outDir = reportDirFor(config)
  const { metrics, jsonFile, mdFile } = await timeStage('report.write', () =>
    writeReport({ root, config, registry, readouts, selftest }, outDir),
  )
  console.log(`METRICS invariants=${metrics.invariants.total} enforced=${metrics.invariants.enforced} partial=${metrics.invariants.partial} open=${metrics.invariants.open} enforcedCoverage=${metrics.enforcedCoverage}% zeroWriter=${metrics.zeroWriter} deadEnum=${metrics.deadEnum} selftest=${metrics.selftest.passed}/${metrics.selftest.cases} skipped=${metrics.skipped} incidents=${metrics.incidents.rate === null ? 'n/a' : metrics.incidents.rate + '%'}`)
  console.log(
    jsonFile && mdFile
      ? `REPORT json=${displayPath(root, jsonFile)} md=${displayPath(root, mdFile)} status=${metrics.status}`
      : `REPORT skipped reason="--no-report" status=${metrics.status}（读数已在上方输出，未落盘）`,
  )
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