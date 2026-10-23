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
import type { Invariant } from '../registry/types.ts'

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
}): StatusVerdict {
  const errors = input.readouts.reduce((n, r) => n + countByLevel(r.findings, 'error'), 0)
  const regressions = input.ratchet.regressions.length
  const dueInvariants = input.registry
    .filter((i) => i.status === 'open' && i.revisitBy && i.revisitBy <= input.today)
    .map((i) => i.id)
  const open = input.registry.filter((i) => i.status === 'open')
  const skipped = input.readouts.filter((r) => r.skipped)

  const residuals = [
    ...open.map((i) => `${i.id} open：${i.openReason ?? '无理由'}`),
    ...skipped.map((r) => `${r.guard} skipped：${r.skipped}`),
  ]

  if (errors > 0 || regressions > 0) {
    return {
      decision: 'REPAIR',
      reason: `guards error=${errors}, ratchet regressions=${regressions}：先修复，再谈是否继续挖`,
      dueInvariants,
      residuals,
    }
  }
  if (dueInvariants.length > 0) {
    return {
      decision: 'ADJUDICATE',
      reason: `open 不变量已到复审期：${dueInvariants.join(', ')}（逾期不裁决，open 就变成挂账）`,
      dueInvariants,
      residuals,
    }
  }

  const judged = input.batches.filter((b) => b.ledgerFound)
  if (judged.length === 0) {
    return {
      decision: 'INSUFFICIENT-HISTORY',
      reason: `没有可判的批次台账（${input.auditDir} 下找不到 03-bug-ledger.md）：空集不能证明「可以继续」`,
      dueInvariants,
      residuals,
    }
  }
  if (judged.length === 1) {
    return {
      decision: 'INSUFFICIENT-HISTORY',
      reason: `只有 1 批可判（${judged[0].dir} trueHoles=${judged[0].trueHoles}）：持续两批的判据还不成立`,
      dueInvariants,
      residuals,
    }
  }

  const last = judged[judged.length - 1]
  const prev = judged[judged.length - 2]
  if (last.trueHoles < 1 && prev.trueHoles < 1) {
    return {
      decision: 'STOP-MINING',
      reason: `最近两批真洞产出 ${prev.trueHoles} / ${last.trueHoles}（<1 且持续两批）：停止新增审计批，转运行态布网`,
      dueInvariants,
      residuals,
    }
  }
  return {
    decision: 'CONTINUE-MINING',
    reason: `最近两批真洞产出 ${prev.trueHoles} / ${last.trueHoles}：产出曲线还没到终点`,
    dueInvariants,
    residuals,
  }
}

export function nextStepFor(decision: StatusDecision, cli = 'npx autoqe'): string {
  switch (decision) {
    case 'REPAIR':
      return `先跑 ${cli} run --root . --verbose，修掉 error 与 ratchet 回归；不要新增审计批`
    case 'ADJUDICATE':
      return '逐条裁决到期的 open 不变量：升 enforced / 续期并写理由 / 转运行态补偿'
    case 'STOP-MINING':
      return '切换到运行态布网：对账不变量 + 告警通道自检 + 灰度放量；见 QE-03 §10.1'
    case 'CONTINUE-MINING':
      return `继续下一批 QE-03 审计；每批结束跑 ${cli} status 记录真洞产出`
    case 'INSUFFICIENT-HISTORY':
      return '先按 QE-03 跑一批审计，把 03-bug-ledger.md 放进 qe-audit/<project>-<date>/；至少两批后本判据才生效'
  }
}
