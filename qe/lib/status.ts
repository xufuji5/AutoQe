/**
 * 停止判据（毕业判据）：把"还要不要继续挖"从感觉变成读数。
 *
 * 判据来自 QE-03 §10.1：
 *   每批真洞产出 < 1 且连续两批 ⇒ 停止新增审计批，转运行态布网。
 *
 * 真洞口径：台账里 severity 恰为 P0/P1、且证据等级为 E1–E3 的行。
 * E0 只是线索，不能计入（与 QE-03 §4.1 一致）。
 *
 * 空集不许自证：没有批次记录或只有一批时，返回 INSUFFICIENT-HISTORY，不返回"可以继续"。
 */

import path from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { readTextSafe } from './fs.ts'
import { countByLevel } from './guard.ts'
import type { QeConfig } from './config.ts'
import type { GuardReadout } from './report.ts'
import type { RatchetComparison } from './ratchet.ts'
import { RATCHET_FILE } from './ratchet.ts'
import type { Invariant } from '../registry/types.ts'
import type { Locale } from './triage.ts'

export interface BatchSummary {
  /** 相对 root 的目录 */
  dir: string
  /** 批次日期（目录名里的 YYYY-MM-DD；取不到则为空） */
  date: string
  /** P0/P1 且证据 E1–E3 */
  trueHoles: number
  /** P0/P1 但证据不足（E0 / 未填），只作线索 */
  unverified: number
  p0: number
  p1: number
  /** 目录存在但没有 03-bug-ledger.md，不参与判定 */
  ledgerFound: boolean
}

export type StatusDecision =
  | 'REPAIR'
  | 'ADJUDICATE'
  | 'STOP-MINING'
  | 'CONTINUE-MINING'
  | 'INSUFFICIENT-HISTORY'
  | 'INSUFFICIENT-BASELINE'
  | 'INSUFFICIENT-COVERAGE'

export interface StatusVerdict {
  decision: StatusDecision
  reason: string
  dueInvariants: string[]
  residuals: string[]
}

const DATE_RE = /(\d{4}-\d{2}-\d{2})/
const SEVERITY_RE = /^P[0-3]$/
const EVIDENCE_RE = /^E[0-3]$/

function cells(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return []
  const parts = trimmed.split('|')
  return parts.slice(1, parts.length - 1).map((c) => c.trim())
}

/** 从一份 03-bug-ledger.md 里数真洞；模板行（BUG-XXX-01 / P0–P3）一律不计 */
export function countLedger(text: string): { p0: number; p1: number; trueHoles: number; unverified: number } {
  let p0 = 0
  let p1 = 0
  let unverified = 0
  for (const line of text.split(/\r?\n/)) {
    const row = cells(line)
    if (row.length < 4) continue
    const id = row[0]
    if (!/^BUG[-_A-Z0-9]/i.test(id) || /XXX/i.test(id)) continue
    const severity = row.find((c) => SEVERITY_RE.test(c))
    if (!severity) continue
    const evidence = row.find((c) => EVIDENCE_RE.test(c))
    const verified = evidence !== undefined && evidence !== 'E0'
    if (severity === 'P0') p0++
    else if (severity === 'P1') p1++
    else continue
    if (verified) continue
    unverified++
  }
  return { p0, p1, trueHoles: p0 + p1 - unverified, unverified }
}

export async function readBatches(root: string, config: QeConfig): Promise<BatchSummary[]> {
  const base = path.join(root, config.auditDir)
  let entries
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch {
    return []
  }
  const out: BatchSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = `${config.auditDir}/${entry.name}`
    const text = await readTextSafe(path.join(base, entry.name, '03-bug-ledger.md'))
    const dateMatch = entry.name.match(DATE_RE)
    if (text === null) {
      out.push({ dir, date: dateMatch?.[1] ?? '', trueHoles: 0, unverified: 0, p0: 0, p1: 0, ledgerFound: false })
      continue
    }
    const counted = countLedger(text)
    let date = dateMatch?.[1] ?? ''
    if (!date) {
      // 目录名没带日期时用台账 mtime 兜底，避免"最新一批"被排到最旧
      try {
        const st = await stat(path.join(base, entry.name, '03-bug-ledger.md'))
        date = new Date(st.mtime).toISOString().slice(0, 10)
      } catch {
        date = ''
      }
    }
    out.push({ dir, date, ledgerFound: true, ...counted })
  }
  return out.sort((a, b) => (a.date === b.date ? a.dir.localeCompare(b.dir) : a.date.localeCompare(b.date)))
}

export function decideStatus(input: {
  registry: Invariant[]
  readouts: GuardReadout[]
  ratchet: RatchetComparison
  batches: BatchSummary[]
  today: string
  auditDir: string
  locale?: Locale
}): StatusVerdict {
  const zh = input.locale === 'zh'
  const errors = input.readouts.reduce((n, r) => n + countByLevel(r.findings, 'error'), 0)
  const regressions = input.ratchet.regressions.length
  const dueInvariants = input.registry
    .filter((i) => i.status === 'open' && i.revisitBy && i.revisitBy <= input.today)
    .map((i) => i.id)
  const open = input.registry.filter((i) => i.status === 'open')
  const skipped = input.readouts.filter((r) => r.skipped)

  const residuals = [
    ...open.map((i) => `${i.id} open${zh ? '：' : ': '}${i.openReason ?? (zh ? '无理由' : 'no reason')}`),
    ...skipped.map((r) => `${r.guard} skipped${zh ? '：' : ': '}${r.skipped}`),
  ]

  if (errors > 0 || regressions > 0) {
    return {
      decision: 'REPAIR',
      reason: zh
        ? `guards error=${errors}, ratchet regressions=${regressions}：先修复，再谈是否继续挖`
        : `guards error=${errors}, ratchet regressions=${regressions}: repair first, then decide whether to keep mining`,
      dueInvariants,
      residuals,
    }
  }
  /**
   * 基线缺失 = 「只准收缩」这条纪律**根本没生效**，不是「零回归」。
   *
   * 事故模型：`compareRatchet` 对不存在的基线返回 `present:false, regressions:[]`，
   * 本函数只看 `regressions.length`，于是「从未初始化」与「跑完零回归」在读数上完全同形。
   * 债务从 0 涨到 100 也只打印 `regressions=0`，唯一的痕迹是报告里一行 `RATCHET status=missing`。
   *
   * 为什么判 REPAIR 而不判这里：`ratchet-update` 必须在人工 triage **之后**跑，
   * 判红会训练人「见红就 update」，那等于把当前债务（含新增的）一次性冻结成基线 —— 比不建基线更糟。
   * 所以取「不阻断、也不算绿」的第三态，与 `INSUFFICIENT-HISTORY` 同构：空集不许自证。
   *
   * 优先级放在 ADJUDICATE 之前：基线缺口使所有「没变差」的结论都不可信，它比「有项到期」更基础。
   */
  if (!input.ratchet.present) {
    return {
      decision: 'INSUFFICIENT-BASELINE',
      reason: zh
        ? `找不到 ${RATCHET_FILE}：只准收缩未生效，当前 ${Object.keys(input.ratchet.current).length} 条读数没有基线可比 —— 「零回归」此时不代表「没变差」`
        : `no ${RATCHET_FILE}: the shrink-only rule is inactive; ${Object.keys(input.ratchet.current).length} tracked readouts have no baseline, so "zero regressions" does not mean "nothing got worse"`,
      dueInvariants,
      residuals,
    }
  }
  /**
   * 第三个缺口：基线在、但本轮没跑全。
   *
   * `run --only X` 之后其余键的 current 全是 0 —— 在补上 unverified 之前，那会被读成
   * 「改善」，报告直接打印「请跑 ratchet:update」。若照着跑，债就被一次性抹掉了。
   * 未测既不是修好也不是变差，所以与 INSUFFICIENT-BASELINE 同构：不阻断，但绝不算绿。
   */
  if (input.ratchet.unverified.length > 0) {
    return {
      decision: 'INSUFFICIENT-COVERAGE',
      reason: zh
        ? `本轮没跑全：基线里 ${input.ratchet.unverified.length} 条读数所在的守卫未执行（${input.ratchet.unverified.slice(0, 3).join(', ')}${input.ratchet.unverified.length > 3 ? ' …' : ''}）—— 未测既不算回归也不算修好`
        : `${input.ratchet.unverified.length} baseline readouts belong to guards that did not run this round (${input.ratchet.unverified.slice(0, 3).join(', ')}${input.ratchet.unverified.length > 3 ? ' …' : ''}): untested is neither a regression nor a fix`,
      dueInvariants,
      residuals,
    }
  }
  if (dueInvariants.length > 0) {
    return {
      decision: 'ADJUDICATE',
      reason: zh
        ? `open 不变量已到复审期：${dueInvariants.join(', ')}（逾期不裁决，open 就变成挂账）`
        : `open invariants are past their review date: ${dueInvariants.join(', ')} (an overdue open item is an unowned liability)`,
      dueInvariants,
      residuals,
    }
  }

  const judged = input.batches.filter((b) => b.ledgerFound)
  if (judged.length === 0) {
    return {
      decision: 'INSUFFICIENT-HISTORY',
      reason: zh
        ? `没有可判的批次台账（${input.auditDir} 下找不到 03-bug-ledger.md）：空集不能证明「可以继续」`
        : `no judgeable batch ledger (no 03-bug-ledger.md under ${input.auditDir}): an empty set cannot prove 'keep going'`,
      dueInvariants,
      residuals,
    }
  }
  if (judged.length === 1) {
    return {
      decision: 'INSUFFICIENT-HISTORY',
      reason: zh
        ? `只有 1 批可判（${judged[0].dir} trueHoles=${judged[0].trueHoles}）：持续两批的判据还不成立`
        : `only 1 judgeable batch (${judged[0].dir} trueHoles=${judged[0].trueHoles}): the two-batch criterion is not met yet`,
      dueInvariants,
      residuals,
    }
  }

  const last = judged[judged.length - 1]
  const prev = judged[judged.length - 2]
  if (last.trueHoles < 1 && prev.trueHoles < 1) {
    return {
      decision: 'STOP-MINING',
      reason: zh
        ? `最近两批真洞产出 ${prev.trueHoles} / ${last.trueHoles}（<1 且持续两批）：停止新增审计批，转运行态布网`
        : `last two batches yielded ${prev.trueHoles} / ${last.trueHoles} true holes (<1 for two batches): stop new audit batches, move to runtime coverage`,
      dueInvariants,
      residuals,
    }
  }
  return {
    decision: 'CONTINUE-MINING',
    reason: zh
      ? `最近两批真洞产出 ${prev.trueHoles} / ${last.trueHoles}：产出曲线还没到终点`
      : `last two batches yielded ${prev.trueHoles} / ${last.trueHoles}: the yield curve has not flattened yet`,
    dueInvariants,
    residuals,
  }
}

export function nextStepFor(decision: StatusDecision, cli = 'npx autoqe', locale: Locale = 'en', rootArg = ''): string {
  const zh = locale === 'zh'
  switch (decision) {
    case 'REPAIR':
      return zh
        ? `先跑 ${cli} run${rootArg} --verbose，修掉 error 与 ratchet 回归；不要新增审计批`
        : `run ${cli} run${rootArg} --verbose and clear errors and ratchet regressions first; do not open a new audit batch`
    case 'ADJUDICATE':
      return zh
        ? '逐条裁决到期的 open 不变量：升 enforced / 续期并写理由 / 转运行态补偿'
        : 'adjudicate each due open invariant: promote to enforced / renew with a written reason / compensate at runtime'
    case 'STOP-MINING':
      return zh
        ? '切换到运行态布网：对账不变量 + 告警通道自检 + 灰度放量；见 QE-03 §10.1'
        : 'switch to runtime coverage: reconciliation invariants + alert-channel self-check + staged rollout (QE-03 §10.1)'
    case 'CONTINUE-MINING':
      return zh
        ? `继续下一批 QE-03 审计；每批结束跑 ${cli} status 记录真洞产出`
        : `open the next QE-03 audit batch; run ${cli} status after each batch to record the true-hole yield`
    case 'INSUFFICIENT-HISTORY':
      return zh
        ? '先按 QE-03 跑一批审计，把 03-bug-ledger.md 放进 qe-audit/<project>-<date>/；至少两批后本判据才生效'
        : 'run one QE-03 audit batch and drop 03-bug-ledger.md into qe-audit/<project>-<date>/; this criterion needs at least two batches'
    case 'INSUFFICIENT-BASELINE':
      return zh
        ? `逐条裁决当前读数（真缺陷→修，假阳性→改判据），**裁决完之后**再跑 ${cli} ratchet-update${rootArg} 冻结基线；先 update 会连新增的债一起冻结`
        : `triage every current readout first (true defect -> fix, false positive -> fix the rule), then run ${cli} ratchet-update${rootArg} to freeze the baseline; updating before triage freezes the new debt too`
    case 'INSUFFICIENT-COVERAGE':
      return zh
        ? `跑全量（去掉 --only）再判：${cli} run${rootArg}；本轮没跑到的守卫既不会变红也不会被修`
        : `run the full guard set (drop --only) before judging: ${cli} run${rootArg}; guards that did not run can neither go red nor get fixed`
  }
}
