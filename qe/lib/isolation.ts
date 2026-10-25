/**
 * 跨项目隔离（INV-ISO-01/02/03）。
 *
 * AutoQe 最强的地方是**同一套引擎能扫任何项目**；最危险的地方也在这里：
 * 引擎跨项目时，A 项目的配置、基线、备案、样本落盘很容易被 B 项目继承，
 * 于是 B 的「绿」里混着 A 的判断——而且这种污染不会以报错的形式出现。
 *
 * 所以隔离必须是**设计约束**，不是使用纪律：
 *
 *  1. 运行期产物（规则自证样本）只落**进程级临时目录**（`mkdtemp`），进程退出即删。
 *     绝不写引擎目录，也绝不写目标项目根——否则同一台机器上的两个项目共用一份落盘。
 *  2. 配置声明的状态路径（契约/备案/台账/审计区/报告区/扫描范围）必须落在**项目 root 内**；
 *     `..` 逃逸一律拒绝。A 项目的状态文件不许被 B 项目的配置引用。
 *  3. 状态根有身份文件 `<stateRoot>/qe.project.json`。外部配置模式（`--config`）下
 *     身份还绑定**被审计 root**：同一份外部状态换个项目复用 → 直接拒绝，不是警告。
 *
 * 纪律：本模块只做判定与拒绝，不静默修正。任何「自动把 A 的配置改造成 B 的」都会
 * 让污染重新变得不可见——那正是本模块存在的理由。
 */

import path from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import type { QeConfig } from './config.ts'

/** 项目身份文件名（落在状态根，不落引擎目录） */
export const STATE_MARKER = 'qe.project.json'

/** 状态根模式：project = 状态就在目标仓内；external = 状态在外部配置旁 */
export type IsolationMode = 'project' | 'external'

export interface ProjectMarker {
  version: 1
  /** 状态根身份。随机生成，跨机器/路径不变；拷贝目录时会跟着走，但**不会**跟着引擎子目录走 */
  id: string
  mode: IsolationMode
  /** 仅 external：这份状态属于哪个被审计 root（绝对路径，已规范化） */
  boundRoot?: string
  /** 仅 project：绑定时的 package.json name。整仓当模板拷走时，用它识别「换了项目还带着旧判断」 */
  boundProject?: string
  boundAt: string
}

export interface IsolationState {
  root: string
  mode: IsolationMode
  /** 状态根：外部配置模式 = 配置文件所在目录；否则 = 项目 root */
  stateRoot: string
  markerFile: string
  marker: ProjectMarker | null
}

/** 项目状态载体（缺身份就不许被信任） */
const KNOWN_STATE = ['qe/ratchet.json', 'qe/waivers.json', 'qe.contracts.json', 'qe/ledger/incidents.json']

function norm(p: string): string {
  const abs = path.resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/** 目标是否在 root 内（含 root 自身） */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(norm(root), norm(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 状态根解析：外部配置的状态跟着配置走，避免往被审计仓写文件 */
export function inspectIsolation(root: string, configFile: string | null): IsolationState {
  const mode: IsolationMode = configFile ? 'external' : 'project'
  const stateRoot = configFile ? path.dirname(path.resolve(configFile)) : path.resolve(root)
  const markerFile = path.join(stateRoot, STATE_MARKER)
  return { root: path.resolve(root), mode, stateRoot, markerFile, marker: readMarker(markerFile) }
}

export function readMarker(file: string): ProjectMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ProjectMarker>
    if (!parsed || parsed.version !== 1 || typeof parsed.id !== 'string' || !parsed.id) return null
    if (parsed.mode !== 'project' && parsed.mode !== 'external') return null
    return {
      version: 1,
      id: parsed.id,
      mode: parsed.mode,
      boundRoot: parsed.boundRoot,
      boundProject: typeof parsed.boundProject === 'string' ? parsed.boundProject : undefined,
      boundAt: parsed.boundAt ?? '',
    }
  } catch {
    return null
  }
}

/** 读目录下 package.json 的 name（没有/坏了就是 null——那不构成证据，不据此拒绝） */
function packageName(dir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown }
    return typeof parsed.name === 'string' && parsed.name ? parsed.name : null
  } catch {
    return null
  }
}

function writeMarker(file: string, mode: IsolationMode, boundRoot?: string): ProjectMarker {
  const marker: ProjectMarker = {
    version: 1,
    id: randomUUID(),
    mode,
    ...(mode === 'external'
      ? { boundRoot: norm(boundRoot ?? '') }
      : { boundProject: packageName(path.dirname(file)) ?? undefined }),
    boundAt: new Date().toISOString(),
  }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(marker, null, 2) + '\n', 'utf8')
  return marker
}

/**
 * 身份校验（只读，不创建）。
 *
 * 拒绝的两种情形：
 *  - 外部状态根换了一个被审计 root → A 的账本被判给 B；
 *  - 状态模式变了（project ↔ external）→ 同一批状态被两套根同时认领。
 */
export function assertIsolation(iso: IsolationState): void {
  if (!iso.marker) return
  if (iso.marker.mode !== iso.mode) {
    throw new Error(
      `QE_ISOLATION_MODE_MISMATCH ${iso.markerFile} 登记为 mode=${iso.marker.mode}，本次是 mode=${iso.mode}；` +
        '同一份状态不许被两种状态根同时认领（确认归属后删除该文件重新绑定）',
    )
  }
  if (iso.mode === 'external' && norm(iso.marker.boundRoot ?? '') !== norm(iso.root)) {
    throw new Error(
      `QE_ISOLATION_FOREIGN_ROOT ${iso.markerFile} 绑定的是另一个项目：${iso.marker.boundRoot}（本次 root=${iso.root}）；` +
        '外部状态不许跨项目复用——请为该项目单独建一份配置与状态目录',
    )
  }
  // 整仓当模板拷走：路径变了、目录名变了，但 package.json name 是最稳的项目指纹（CI 检出目录不影响它）
  if (iso.mode === 'project' && iso.marker.boundProject) {
    const current = packageName(iso.root)
    if (current && current !== iso.marker.boundProject) {
      throw new Error(
        `QE_ISOLATION_PROJECT_MISMATCH ${iso.markerFile} 绑定的项目是 ${iso.marker.boundProject}，当前项目是 ${current}；` +
          '这份配置/基线/备案来自另一个项目（模板整仓拷贝），不能直接沿用。确认归属后跑 `autoqe init` 重新绑定，或换掉旧状态',
      )
    }
  }
}

/** 项目状态是否已经存在（用于「有状态但无身份」的拒绝） */
export function hasProjectState(iso: IsolationState, config?: QeConfig): boolean {
  for (const rel of KNOWN_STATE) {
    if (existsSync(path.join(iso.root, ...rel.split('/')))) return true
    if (existsSync(path.join(iso.stateRoot, ...rel.split('/')))) return true
  }
  for (const dir of [config?.auditDir, config?.reportDir]) {
    if (dir && existsSync(path.resolve(iso.root, dir))) return true
    if (dir && existsSync(path.resolve(iso.stateRoot, dir))) return true
  }
  if (config && existsSync(path.resolve(iso.root, config.contracts))) return true
  if (config && existsSync(path.resolve(iso.root, config.waivers))) return true
  return false
}

/**
 * 身份就位（写命令调用）。
 *
 * 没有身份但已有状态 → **拒绝**，不自动认领：自动认领等于「谁先跑谁定义这份账本属于谁」，
 * 那正是跨项目污染最安静的入口。让人显式确认（`init` 或删除旧状态）。
 */
export function ensureIsolation(iso: IsolationState, config?: QeConfig, opts: { adopt?: boolean } = {}): ProjectMarker {
  if (iso.marker) {
    if (!opts.adopt) return iso.marker
    // init 是显式重新绑定：身份与当前项目不符时重写，而不是把错误留到下一次运行
    try {
      assertIsolation(iso)
      return iso.marker
    } catch {
      iso.marker = writeMarker(iso.markerFile, iso.mode, iso.root)
      return iso.marker
    }
  }
  if (!opts.adopt && hasProjectState(iso, config)) {
    throw new Error(
      `QE_ISOLATION_UNBOUND ${iso.stateRoot} 里已有项目状态（ratchet/waivers/contracts/report/audit），` +
        `但没有身份文件 ${STATE_MARKER}；无法判断这份账本属于哪个项目。` +
        `确认归属后跑 \`autoqe init\` 绑定，或删除旧状态后重跑`,
    )
  }
  iso.marker = writeMarker(iso.markerFile, iso.mode, iso.root)
  return iso.marker
}

/**
 * 配置声明的路径必须留在项目 root 内。
 *
 * 这不是「防呆」：`contracts: "../A/qe.contracts.json"` 会让 B 的 inv06/inv07 拿 A 的契约判 B 的代码，
 * 而报告上只会显示「0 错」。同理 `source.roots: ["../A/src"]` 等于直接扫另一个项目。
 */
export interface BoundaryViolation {
  label: string
  value: string
}

export function boundaryViolations(root: string, config: QeConfig): BoundaryViolation[] {
  const checks: { label: string; value: string }[] = [
    { label: 'contracts', value: config.contracts },
    { label: 'waivers', value: config.waivers },
    { label: 'ledger', value: config.ledger },
    { label: 'auditDir', value: config.auditDir },
    ...(config.reportDir ? [{ label: 'reportDir', value: config.reportDir }] : []),
    ...config.source.roots.map((v, i) => ({ label: `source.roots[${i}]`, value: v })),
    ...(config.source.evidenceRoots ?? []).map((v, i) => ({ label: `source.evidenceRoots[${i}]`, value: v })),
    ...(config.spec?.docs ?? []).map((v, i) => ({ label: `spec.docs[${i}]`, value: v })),
    ...(config.stores?.moduleRoots ?? []).map((v, i) => ({ label: `stores.moduleRoots[${i}]`, value: v })),
  ]
  return checks.filter((c) => {
    if (!c.value || !c.value.trim()) return false
    const abs = path.isAbsolute(c.value) ? path.normalize(c.value) : path.resolve(root, c.value)
    return !isInside(root, abs)
  })
}

export function assertBoundary(root: string, config: QeConfig): void {
  const bad = boundaryViolations(root, config)
  if (bad.length === 0) return
  throw new Error(
    `QE_ISOLATION_STATE_ESCAPE 以下路径逃出了项目 root（${path.resolve(root)}）：` +
      bad.map((b) => `${b.label}=${b.value}`).join('、') +
      '；项目状态与扫描范围只能在本项目内，禁止引用另一个项目（那是把 A 的判断带进 B）',
  )
}

let tempRoot: string | null = null
let tempCleaned = false

/**
 * 进程级临时根：一次进程一个随机目录，进程退出即删。
 *
 * 「进程级」是隔离的关键：同一台机器同时跑 A/B 两个项目时，两边的样本目录不同名；
 * 换到进程外就没有可继承的东西。禁止改成固定的磁盘路径（那正是本次要封死的通道）。
 */
export function processTempRoot(prefix = 'autoqe-run-'): string {
  if (tempRoot) return tempRoot
  tempRoot = mkdtempSync(path.join(tmpdir(), prefix))
  process.once('exit', () => {
    if (tempCleaned || !tempRoot) return
    tempCleaned = true
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // 退出清理失败不改变判定结果；临时目录会由系统回收
    }
  })
  return tempRoot
}

/** 本次进程用到的外部输入（只做读数，不做规则判定） */
export function externalInputs(): string[] {
  const out: string[] = []
  if (process.env.AUTOQE_CONFIG) out.push(`AUTOQE_CONFIG=${process.env.AUTOQE_CONFIG}`)
  if (process.env.AUTOQE_DENYLIST) out.push(`AUTOQE_DENYLIST=${process.env.AUTOQE_DENYLIST}`)
  return out
}

/**
 * 项目级环境变量的前缀。
 *
 * 为什么不是只剥 `AUTOQE_CONFIG` / `AUTOQE_DENYLIST`：漏掉一个前缀就漏掉一条通道，
 * 而新的 `AUTOQE_*` 变量会随功能增长不断出现（黑名单、外部状态、临时根…）。
 * 判据按**前缀**取，新增变量自动被隔离，不依赖某个人记得来改这份清单。
 *
 * `QE_` 只用于进程级开关（如 QE_PROFILE），同样不该从调用方粘到子进程：
 * 否则「本次是不是在 profile」会跨项目继承，读数解释权被调用环境带走。
 */
const PROJECT_ENV_PREFIXES = ['AUTOQE_', 'QE_'] as const

/**
 * 从环境里剥掉项目级变量。返回剥掉的键（排序后），供读数行展示。
 *
 * 默认**全部剥掉**；只有显式 `keep: true`（`multi --inherit-env`）才保留。
 * 保留的是调用方明确要的继承，不是引擎替它猜的。
 */
export function stripProjectEnv(
  env: NodeJS.ProcessEnv,
  opts: { keep?: boolean } = {},
): { env: NodeJS.ProcessEnv; stripped: string[] } {
  const out: NodeJS.ProcessEnv = { ...env }
  if (opts.keep) return { env: out, stripped: [] }
  const stripped: string[] = []
  for (const key of Object.keys(out)) {
    if (PROJECT_ENV_PREFIXES.some((p) => key.startsWith(p))) {
      delete out[key]
      stripped.push(key)
    }
  }
  return { env: out, stripped: stripped.sort() }
}

/** 路径比较口径：绝对化 + 分隔符统一 + Windows 大小写不敏感 */
export function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b)
}

/** 供文本匹配用的路径形态：正斜杠、小写（Windows） */
function displayForm(p: string): string {
  const abs = norm(path.resolve(p))
  return abs.split(path.sep).join('/')
}

/**
 * 跨项目串读检测：子进程输出里出现了**另一个项目**的 root 路径。
 *
 * 这是「数据不会串通」的行为判据，而不是文档承诺。触发场景真实存在：
 * 子进程继承了调用方的 cwd/env、报告写到共享目录、某个 helper 缓存了上一轮 root。
 * 这些缺陷都不会报错——读数照样「0 错」，只是 B 的报告里出现了 A 的路径。
 *
 * 边界处理：
 *  - 另一个 root 是**自己 root 的子目录**时跳过：扫父项目的输出里合法地会出现子目录路径
 *    （嵌套项目本身应避免，但不能据此判成串读）；
 *  - 前缀不算命中：`/x/proj` 不得因 `/x/proj-2` 被误判（要求路径后是分隔符/引号/空白/结尾）。
 */
export function crossTalkRoots(ownRoot: string, otherRoots: string[], text: string): string[] {
  const hay = (process.platform === 'win32' ? text.toLowerCase() : text).split('\\').join('/')
  const hits: string[] = []
  for (const other of otherRoots) {
    if (samePath(ownRoot, other)) continue
    if (isInside(ownRoot, other)) continue // 自己范围内的子路径，合法
    const needle = displayForm(other)
    let from = 0
    while (from <= hay.length) {
      const idx = hay.indexOf(needle, from)
      if (idx < 0) break
      const next = hay[idx + needle.length]
      if (next === undefined || !/[a-z0-9._-]/i.test(next)) {
        hits.push(other)
        break
      }
      from = idx + 1
    }
  }
  return hits
}

/**
 * 从子进程输出里取 `ISOLATION` 读数行的 root。
 *
 * 用 `root=(.+) stateRoot=`（贪婪）而不是 `root=(\S+)`：Windows 路径可以含空格，
 * 按空白切会把路径切碎，读出来的 root 永远对不上——那会让本判据变成假红。
 * 贪婪匹配会停在**最后一个** ` stateRoot=`（真正的分隔符），root 自身含该片段属病态路径。
 */
export function parseIsolationRoots(stdout: string): string[] {
  return [...stdout.matchAll(/^ISOLATION mode=\S+ root=(.+) stateRoot=/gm)].map((m) => m[1].trim())
}


/** `ISOLATION` 机器读数：隔离状态必须可被读到，否则「隔离了」与「没隔离」在日志上一样 */
export function isolationLine(iso: IsolationState): string {
  const ext = externalInputs()
  const marker = iso.marker ? `id=${iso.marker.id.slice(0, 8)}` : 'id=unbound'
  return (
    `ISOLATION mode=${iso.mode} root=${iso.root} stateRoot=${iso.stateRoot} ${marker} ` +
    `env=${ext.length === 0 ? 'none' : ext.join(',')}`
  )
}
