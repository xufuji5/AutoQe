/**
 * Ratchet 基线：每个「守卫 + finding code」的 error/warn 计数只准降，不准升。
 * D6：新违规不许塞进基线；基线只能由 `qe:ratchet:update` 在人工裁决后重写。
 */

import path from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import type { GuardReadout } from './report.ts'

export const RATCHET_FILE = 'qe/ratchet.json'

export interface RatchetBaseline {
  version: 1
  updatedAt: string
  counts: Record<string, number>
}

export interface RatchetRegression {
  key: string
  guard: string
  code: string
  baseline: number
  current: number
}

export interface RatchetComparison {
  present: boolean
  regressions: RatchetRegression[]
  improvements: RatchetRegression[]
  current: Record<string, number>
}

/** 只计 error/warn；info 是读数不是缺陷 */
export function currentCounts(readouts: GuardReadout[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const r of readouts) {
    for (const f of r.findings) {
      if (f.level === 'info') continue
      const key = `${r.guard}:${f.code}`
      counts[key] = (counts[key] ?? 0) + 1
    }
  }
  return counts
}

export async function readBaseline(root: string): Promise<RatchetBaseline | null> {
  try {
    const text = await readFile(path.join(root, RATCHET_FILE), 'utf8')
    const parsed = JSON.parse(text) as Partial<RatchetBaseline>
    if (!parsed || typeof parsed.counts !== 'object' || !parsed.counts) return null
    return { version: 1, updatedAt: parsed.updatedAt ?? '', counts: parsed.counts }
  } catch {
    return null
  }
}

export async function writeBaseline(root: string, readouts: GuardReadout[]): Promise<string> {
  const file = path.join(root, RATCHET_FILE)
  await mkdir(path.dirname(file), { recursive: true })
  const baseline: RatchetBaseline = {
    version: 1,
    updatedAt: new Date().toISOString(),
    counts: currentCounts(readouts),
  }
  await writeFile(file, JSON.stringify(baseline, null, 2) + '\n', 'utf8')
  return file
}

export async function compareRatchet(root: string, readouts: GuardReadout[]): Promise<RatchetComparison> {
  const baseline = await readBaseline(root)
  const current = currentCounts(readouts)
  if (!baseline) return { present: false, regressions: [], improvements: [], current }
  const regressions: RatchetRegression[] = []
  const improvements: RatchetRegression[] = []
  const keys = new Set([...Object.keys(baseline.counts), ...Object.keys(current)])
  for (const key of [...keys].sort()) {
    const base = baseline.counts[key] ?? 0
    const now = current[key] ?? 0
    if (now === base) continue
    const idx = key.indexOf(':')
    const row = { key, guard: key.slice(0, idx), code: key.slice(idx + 1), baseline: base, current: now }
    if (now > base) regressions.push(row)
    else improvements.push(row)
  }
  return { present: true, regressions, improvements, current }
}

export function ratchetLine(cmp: RatchetComparison): string {
  const status = !cmp.present ? 'missing' : cmp.regressions.length > 0 ? 'regressed' : 'ok'
  return `RATCHET status=${status} regressions=${cmp.regressions.length} improvements=${cmp.improvements.length} tracked=${Object.keys(cmp.current).length}`
}
