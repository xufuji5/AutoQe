import type { QeConfig } from './config.ts'
import type { Invariant } from '../registry/types.ts'

export type FindingLevel = 'error' | 'warn' | 'info'

export interface Finding {
  level: FindingLevel
  code: string
  message: string
  file?: string
  line?: number
  entity?: string
}

export interface GuardContext {
  root: string
  config: QeConfig
  registry: Invariant[]
}

export interface GuardResult {
  findings: Finding[]
  /** 自报射程（D10）：扫了什么、排除了谁，必须可复现 */
  scanned: string
}

export interface GuardCase {
  name: string
  root: string
  /** red = 必须有 error；warn = 无 error 但必须有 warn；green = 两无 */
  expect: 'red' | 'warn' | 'green'
  minErrors?: number
  minWarnings?: number
  config?: Partial<QeConfig>
  registry?: Invariant[]
}

export interface Guard {
  id: string
  title: string
  invariants: string[]
  /** 看不见什么（盲区声明，缺一视为射程造假） */
  blindSpots: string[]
  run(ctx: GuardContext): Promise<GuardResult>
  selfTest?: GuardCase[]
}

export function defineGuard(g: Guard): Guard {
  return g
}

export function err(code: string, message: string, extra: Partial<Finding> = {}): Finding {
  return { level: 'error', code, message, ...extra }
}

export function warn(code: string, message: string, extra: Partial<Finding> = {}): Finding {
  return { level: 'warn', code, message, ...extra }
}

export function info(code: string, message: string, extra: Partial<Finding> = {}): Finding {
  return { level: 'info', code, message, ...extra }
}

export function countByLevel(findings: Finding[], level: FindingLevel): number {
  return findings.filter((f) => f.level === level).length
}

export function formatFinding(guardId: string, f: Finding): string {
  const loc = f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : ''
  return `${f.level.toUpperCase()} [${guardId}] ${f.code} ${loc ? loc + ' ' : ''}${f.message}`
}

/** D5：一个守卫只打一行 GUARD_SUMMARY，业务读数走 DETAIL */
export function summaryLine(guardId: string, result: GuardResult): string {
  const errors = countByLevel(result.findings, 'error')
  const warnings = countByLevel(result.findings, 'warn')
  const status = errors > 0 ? 'red' : warnings > 0 ? 'yellow' : 'green'
  return `GUARD_SUMMARY id=${guardId} status=${status} errors=${errors} warnings=${warnings} scanned=${result.scanned}`
}
