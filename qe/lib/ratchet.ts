/**
 * Ratchet 基线：每个「守卫 + finding code」的 error/warn 计数只准降，不准升。
 * D6：新违规不许塞进基线；基线只能由 `qe:ratchet:update` 在人工裁决后重写。
 *
 * ## 一切路径参数都是 `stateRoot`，不是被审计仓的 root
 *
 * 这两者**在外部配置模式下不相等**（`qe/lib/isolation.ts`：`stateRoot = dirname(configFile)`），
 * 而本模块早前收的是 `root` ⇒ 基线写进了被审计仓。后果不是「多一个文件」：
 *   ① 被审计仓的 `.gitignore` 必须为它开例外才活得过一次 `git clean`，而这条例外又会让人
 *      误以为基线是本仓资产（实际是工具侧状态，跟着工具走）；
 *   ② 同一台机器上两个项目若用同一个外部配置，就会共用一份基线 —— 这正是 isolation
 *      模块头注点名要防的事（「绝不写目标项目根，否则同一台机器上的两个项目共用一份落盘」）。
 * 参数一律叫 `stateRoot` 而不是 `root`：名字是唯一成本最低的判据，叫 `root` 时每个调用方
 * 都会理所当然地传 `root`（本模块自己就先这么用了很久）。
 */

import path from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import type { GuardReadout } from './report.ts'

/** 相对 **stateRoot**（不是项目 root），与 `config.waivers` / `config.ledger` 同级 */
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
  /**
   * 基线里有、但**本轮没跑**的那个守卫名下的键。
   *
   * 为什么必须单列：`run --only dev` 只跑一个守卫时，其余键的 current 全是 0 ——
   * 把它们算进 improvements，报告会打印一屏「已改善，请跑 ratchet:update」，
   * 于是「只跑了一个守卫」被读成「债务清完了」。未测 ≠ 修好了，也 ≠ 变差了。
   */
  unverified: string[]
  current: Record<string, number>
  /** 基线里登记了多少条键（`tracked` 的分母：只写「当前多少条」会漏掉没跑的那些） */
  baselineKeys: number
  /** 当前出现、基线里没有的键（新债/新判据；不是回归，但也不许无声） */
  newKeys: number
}

/** 基线键 → 守卫名（键形如 `guard:CODE`；守卫 id 不含冒号） */
export function guardOf(key: string): string {
  const idx = key.indexOf(':')
  return idx < 0 ? key : key.slice(0, idx)
}

export interface CoverageSplit {
  /** 本轮真跑过的守卫名下的键：可以判回归/改善 */
  verified: string[]
  /** 本轮没跑的守卫名下的键：既不能算回归也不能算改善 */
  unverified: string[]
}

/**
 * 按「本轮跑了哪些守卫」切分基线键。纯函数，自证例在 engine-selftest。
 * 空集语义：`ranGuards` 为空时全部 unverified —— 一条都没跑，不许自证。
 */
export function splitByCoverage(baselineKeys: string[], ranGuards: Iterable<string>): CoverageSplit {
  const ran = new Set(ranGuards)
  const verified: string[] = []
  const unverified: string[] = []
  for (const key of [...baselineKeys].sort()) {
    if (ran.has(guardOf(key))) verified.push(key)
    else unverified.push(key)
  }
  return { verified, unverified }
}

/**
 * 只计 error/warn；info 是读数不是缺陷。
 *
 * **跳过也计数**，键形如 `<guard>:SKIP:<code>`。理由是本文件头那句「只准降不准升」
 * 对跳过同样成立、而现状是反的：一条判据把射程关掉之后 findings 直接消失 ⇒
 * 读数只会更好看。实测（某试点仓一轮）：`skipped=6` 只以数字形式出现，没人能回答
 * 「6 个是什么」；基线里也完全看不到它，于是「射程缩了一寸」这件事全程无感。
 *
 * 用 `SKIP:` 中间段而不是塞进 code 前缀：`guardOf()` 取第一个冒号前，中间段既不会
 * 破坏它，又能让「这是跳过不是缺陷」在原始 JSON 里一眼可辨（人读基线时不至于把它
 * 当成一条待修的 warn）。
 */
export function currentCounts(readouts: GuardReadout[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const r of readouts) {
    for (const f of r.findings) {
      if (f.level === 'info') continue
      const key = `${r.guard}:${f.code}`
      counts[key] = (counts[key] ?? 0) + 1
    }
    if (r.skipCode) {
      const key = `${r.guard}:SKIP:${r.skipCode}`
      counts[key] = (counts[key] ?? 0) + 1
    }
  }
  return counts
}

export async function readBaseline(stateRoot: string): Promise<RatchetBaseline | null> {
  try {
    const text = await readFile(path.join(stateRoot, RATCHET_FILE), 'utf8')
    const parsed = JSON.parse(text) as Partial<RatchetBaseline>
    if (!parsed || typeof parsed.counts !== 'object' || !parsed.counts) return null
    return { version: 1, updatedAt: parsed.updatedAt ?? '', counts: parsed.counts }
  } catch {
    return null
  }
}

/**
 * 冻结当前读数为基线。
 *
 * **拒绝在没有覆盖到全部既有键时重写**：`run --only X && ratchet-update` 会把没跑的守卫
 * 的债一次性抹成 0（写盘前 `keys=` 还是漂亮数字），而且撤销不了 —— 旧基线只剩在 git 里。
 * 这一类「工具给了个看起来成功的输出」比报错危险得多，所以缺覆盖就抛 QE_FATAL，
 * 要抹掉历史就显式 `--force`（真删了守卫时才该用）。
 */
export async function writeBaseline(
  stateRoot: string,
  readouts: GuardReadout[],
  opts: { force?: boolean } = {},
): Promise<string> {
  const baseline = await readBaseline(stateRoot)
  const { unverified } = splitByCoverage(
    baseline ? Object.keys(baseline.counts) : [],
    readouts.map((r) => r.guard),
  )
  if (unverified.length > 0 && !opts.force) {
    const sample = unverified.slice(0, 5).join(', ')
    throw new Error(
      `RATCHET_REFUSE 本轮只跑到 ${new Set(readouts.map((r) => r.guard)).size} 个守卫，` +
        `而基线里有 ${unverified.length} 条读数所在的守卫没跑（${sample}${unverified.length > 5 ? ' …' : ''}）。` +
        `照此重写等于把这些债一次性抹成 0。跑全量再 update；确认要丢弃这些记录时加 --force。`,
    )
  }
  const file = path.join(stateRoot, RATCHET_FILE)
  await mkdir(path.dirname(file), { recursive: true })
  const next: RatchetBaseline = {
    version: 1,
    updatedAt: new Date().toISOString(),
    counts: currentCounts(readouts),
  }
  await writeFile(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return file
}

export async function compareRatchet(stateRoot: string, readouts: GuardReadout[]): Promise<RatchetComparison> {
  const baseline = await readBaseline(stateRoot)
  const current = currentCounts(readouts)
  if (!baseline) {
    return {
      present: false,
      regressions: [],
      improvements: [],
      unverified: [],
      current,
      baselineKeys: 0,
      newKeys: Object.keys(current).length,
    }
  }
  const { verified, unverified } = splitByCoverage(
    Object.keys(baseline.counts),
    readouts.map((r) => r.guard),
  )
  const regressions: RatchetRegression[] = []
  const improvements: RatchetRegression[] = []
  // 只比「本轮真跑过」的键：未测的键不参与回归/改善判定（见 unverified 的理由）
  const keys = new Set([...verified, ...Object.keys(current)])
  for (const key of [...keys].sort()) {
    const base = baseline.counts[key] ?? 0
    const now = current[key] ?? 0
    if (now === base) continue
    const row = { key, guard: guardOf(key), code: key.slice(guardOf(key).length + 1), baseline: base, current: now }
    if (now > base) regressions.push(row)
    else improvements.push(row)
  }
  return {
    present: true,
    regressions,
    improvements,
    unverified,
    current,
    baselineKeys: Object.keys(baseline.counts).length,
    newKeys: Object.keys(current).filter((k) => !(k in baseline.counts)).length,
  }
}

export function ratchetLine(cmp: RatchetComparison): string {
  // partial 是必须区分的第四态：`--only` 少跑守卫时 regressions 恒为 0，
  // 单看 ok / regressed 会把「没比」读成「比过了且没变差」。
  const status = !cmp.present
    ? 'missing'
    : cmp.regressions.length > 0
      ? 'regressed'
      : cmp.unverified.length > 0
        ? 'partial'
        : 'ok'
  // tracked 给基线分母、new 给「基线外新增」，两者与 unverified 相加才能对账：
  // 只打「当前 N 条」时，`--only` 少跑的那些守卫在读数上完全消失。
  // skips 单列：跳过与缺陷共用一套键空间，不给个分项的话「tracked=12」看不出
  // 其中几条其实是「射程被关掉」，而这两类该用完全不同的动作处理。
  const skips = Object.keys(cmp.current).filter((k) => k.includes(':SKIP:')).length
  return `RATCHET status=${status} regressions=${cmp.regressions.length} improvements=${cmp.improvements.length} unverified=${cmp.unverified.length} tracked=${cmp.baselineKeys} new=${cmp.newKeys} skips=${skips}`
}
