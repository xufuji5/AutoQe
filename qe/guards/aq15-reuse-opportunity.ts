/**
 * AQ15 · 跨文件重复代码块（复用机会）
 *
 * ## 判据
 *
 * 在全部 source roots 里滑动窗口找「相同 >=3 次的代码块」：
 *   - 相同窗口出现 >=3 个不同文件 → WARN
 *   - 相同窗口只在 1~2 个文件出现 → 不报（阈值下不制造噪声）
 *   - import / export 语句行、纯空白行、注释行 → 剔除后再哈希（样板代码不算重复）
 *
 * ## 为什么是 WARN 不是 ERROR
 *
 * 重复代码不等于缺陷：route.ts 的 handle() 包装正是刻意统一的样板，
 * 业务逻辑模板化也常常是好事（读着一致、改有规矩）。
 * 本条只做「读数」——让你看见仓里哪些块被 >=3 处粘贴过，
 * 人工判断哪些值得抽共用、哪些保持原地不动。
 *
 * ## 阈值
 *
 * 默认 minLines=20, minOccurrences=3，可在 config.rules.aq15 覆盖：
 *   rules.aq15 = { minLines: 40, minOccurrences: 4 }
 *
 * ## 盲区
 *
 *  - 只做精确行序列匹配：变量名/格式不同的相似代码认不出来（那需要 AST 结构比对，成本 >=10x）
 *  - 窗口按行计数、按「已剔除样板后的有效行」对齐：两个文件样板行数不同时有效行偏移也不同
 *  - 单行 import/export 已剔除，但多行 import 内部的成员列表还是样板
 *  - 不扫有效行 < minLines x 2 的文件（route.ts 等样板密集型通常通不过这道门槛）
 */

import path from 'node:path'
import { defineGuard, info, warn, type Finding } from '../lib/guard.ts'
import { NotApplicable } from '../lib/not-applicable.ts'
import { maskStringBodies, stripComments } from '../lib/code-only.ts'
import { readTextSafe, rel, walkFiles } from '../lib/fs.ts'
import { defaultSourceExtensions } from '../lib/config.ts'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/aq15-duplicate')

/** 默认阈值：20 行有效代码 × 3 个文件 */
const DEFAULT_MIN_LINES = 20
const DEFAULT_MIN_OCCURRENCES = 3

/** 从源码归一化成可哈希的行序列 */
function normalizeLines(src: string): string[] {
  // 先抹掉字符串（避免 SQL/JSON 里的换行污染行切分），再去注释，最后去 import/export/空行
  const stripped = stripComments(maskStringBodies(src))
  return stripped
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^(import|export)\b/.test(l))
    .filter((l) => !/^[{}();,]$/.test(l)) // 孤立的结构行（可能来自 mask 后的残留）
    .filter((l) => !/^\/\//.test(l)) // stripComments 可能没清干净单行注释
}

/** FNV-1a 32-bit 哈希（足够分桶，不撞就好） */
function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = (h * 0x01000193) | 0
  }
  return h >>> 0
}

interface WindowHit {
  hash: number
  rel: string // 相对 root 的路径
  startLine: number // 原始源码的起始行（1-based，0 表示该窗口从文件第 1 行开始）
}

interface DuplicateGroup {
  hash: number
  lines: string[] // 该哈希对应的有效行内容
  hits: WindowHit[]
}

/** 把滑窗命中按哈希分桶，再按「跨不同文件数」筛出重复组 */
function groupWindows(allWindows: WindowHit[], linesByRel: Map<string, string[]>): DuplicateGroup[] {
  const byHash = new Map<number, WindowHit[]>()
  for (const w of allWindows) {
    const bucket = byHash.get(w.hash) ?? []
    bucket.push(w)
    byHash.set(w.hash, bucket)
  }
  const out: DuplicateGroup[] = []
  for (const [hash, hits] of byHash) {
    const uniqueFiles = new Set(hits.map((h) => h.rel))
    if (uniqueFiles.size < DEFAULT_MIN_OCCURRENCES) continue
    // 提取窗口内容（从第一个 hit 取，因为同 hash 内容相同）
    const first = hits[0]
    const srcLines = linesByRel.get(first.rel) ?? []
    const start = first.startLine
    const lines = srcLines.slice(start, start + DEFAULT_MIN_LINES)
    out.push({ hash, lines, hits })
  }
  return out
}

/**
 * 同一文件里的窗口命中可能互相重叠（滑窗 step=1 的必然结果）。
 * 把同文件里重叠的命中合并成一条——避免 25 行重复块报 6 条 warn。
 */
function dedupeWithinFile(group: DuplicateGroup): WindowHit[] {
  const byFile = new Map<string, WindowHit[]>()
  for (const h of group.hits) {
    const arr = byFile.get(h.rel) ?? []
    arr.push(h)
    byFile.set(h.rel, arr)
  }
  const deduped: WindowHit[] = []
  for (const [, hits] of byFile) {
    hits.sort((a, b) => a.startLine - b.startLine)
    let merged: WindowHit | null = null
    for (const h of hits) {
      if (merged && h.startLine <= merged.startLine + DEFAULT_MIN_LINES - 1) {
        continue // 与已合并窗口重叠 → 跳过
      }
      deduped.push(h)
      merged = h
    }
  }
  return deduped
}

export const aq15 = defineGuard({
  id: 'aq15',
  title: '跨文件重复代码块（≥3 处粘贴的机会）',
  invariants: ['INV-META-06'],
  blindSpots: [
    '只做精确行序列匹配：变量名/格式不同的相似代码认不出来（AST 结构比对成本 ≥10×）',
    'import/export/注释/空行已剔除，但多行 import 的成员列表还是样板；对象字面量里的键序列也会被当成重复',
    '窗口按「有效行」对齐，不按原始行：两个文件样板行数不同时认不出',
    '不扫有效行 < minLines×2 的文件（route.ts 等样板密集型通常通不过这道门槛）',
    'minOccurrences 只数不同文件：同一文件里重复 10 次不报错（内部提取是另一回事）',
  ],
  async run(ctx) {
    const options = (ctx.config.rules?.['aq15'] ?? {}) as Record<string, unknown>
    const minLines = typeof options.minLines === 'number' ? options.minLines : DEFAULT_MIN_LINES
    const minOccurrences = typeof options.minOccurrences === 'number' ? options.minOccurrences : DEFAULT_MIN_OCCURRENCES

    const ignore = [...new Set([...(ctx.config.ignore ?? []), 'node_modules', 'dist', 'build', '.next', 'coverage', '.git', 'qe/fixtures', 'qe-report'])]
    const exts = ctx.config.source.extensions ?? defaultSourceExtensions
    const roots = ctx.config.source.roots

    const allWindows: WindowHit[] = []
    const linesByRel = new Map<string, string[]>()
    let totalFiles = 0
    let walkedFiles = 0
    let totalEffectiveLines = 0

    for (const rootDir of roots) {
      const files = await walkFiles(ctx.root, rootDir, { ignore, ext: exts })
      walkedFiles += files.length
      for (const file of files) {
        const text = await readTextSafe(file)
        if (text === null) continue
        const relPath = rel(ctx.root, file)
        const norm = normalizeLines(text)
        if (norm.length < minLines * 2) continue // 太短：样板密集型文件直接跳过
        linesByRel.set(relPath, norm)
        totalFiles++
        totalEffectiveLines += norm.length
        // 滑窗 step = 1，覆盖所有可能的起始位置
        for (let i = 0; i <= norm.length - minLines; i++) {
          const window = norm.slice(i, i + minLines).join('\n')
          const hash = fnv1a(window)
          allWindows.push({ hash, rel: relPath, startLine: i })
        }
      }
    }

    // D1：空集不许报绿。walkedFiles=0 = 射程里一个文件都没有（roots 写错/extensions
    // 不匹配），本判据整个没跑 → NotApplicable，不许伪装成「干净」；
    // walkedFiles>0 但 qualifying=0 = 文件都在但全部低于 minLines×2 有效行门槛，
    // 这也是「没扫到」而非「没重复」，warn 出来说明，不许静默 CLEAN。
    if (walkedFiles === 0) {
      throw new NotApplicable(
        'AQ15_NO_SOURCE_FILES',
        `source.roots=${roots.join(',')} 下未发现任何 ${exts.join(',')} 文件：本判据没有射程，不报绿`,
      )
    }

    // 覆盖配置的阈值（groupWindows 里用常量，这里直接读 options）
    // 注意：上面 groupWindows 用了 DEFAULT_MIN_OCCURRENCES，我们在下方重新按 options 过滤
    const groups: DuplicateGroup[] = []
    const byHash = new Map<number, WindowHit[]>()
    for (const w of allWindows) {
      const bucket = byHash.get(w.hash) ?? []
      bucket.push(w)
      byHash.set(w.hash, bucket)
    }
    for (const [hash, hits] of byHash) {
      const uniqueFiles = new Set(hits.map((h) => h.rel))
      if (uniqueFiles.size < minOccurrences) continue
      const first = hits[0]
      const srcLines = linesByRel.get(first.rel) ?? []
      const lines = srcLines.slice(first.startLine, first.startLine + minLines)
      groups.push({ hash, lines, hits })
    }

    // 按跨文件数降序（最值得复用的放前面）
    groups.sort((a, b) => {
      const diff = new Set(b.hits.map((h) => h.rel)).size - new Set(a.hits.map((h) => h.rel)).size
      if (diff !== 0) return diff
      return b.lines.length - a.lines.length
    })

    const findings: Finding[] = []
    const seenHashes = new Set<number>()
    for (const g of groups) {
      if (seenHashes.has(g.hash)) continue
      seenHashes.add(g.hash)
      const deduped = dedupeWithinFile(g)
      const uniqueFiles = [...new Set(deduped.map((h) => h.rel))]
      const preview = g.lines.slice(0, 3).join(' / ') + (g.lines.length > 3 ? ' …' : '')
      const fileList = uniqueFiles.slice(0, 5).join(', ') + (uniqueFiles.length > 5 ? ` 等 ${uniqueFiles.length} 处` : '')
      findings.push(
        warn(
          'DUPLICATE_BLOCK',
          `${minLines} 行代码块在 ${uniqueFiles.length} 个文件里出现（${fileList}）：「${preview}」——可考虑抽共用函数或组件`,
          { file: deduped[0].rel, line: deduped[0].startLine + 1 },
        ),
      )
    }

    if (totalFiles === 0) {
      findings.push(
        warn(
          'AQ15_NO_EFFECTIVE_FILES',
          `扫描 ${walkedFiles} 个文件，但全部低于 ${minLines * 2} 有效行门槛（样板密集型被跳过）：本判据实际没扫到内容，读数不是「干净」`,
        ),
      )
    } else if (findings.length === 0) {
      findings.push(
        info(
          'CLEAN',
          `扫描 ${totalFiles} 个文件（${totalEffectiveLines} 有效行），未发现 ≥${minLines} 行 × ≥${minOccurrences} 个文件的重复块`,
        ),
      )
    }

    return {
      findings,
      scanned: `walked=${walkedFiles} files=${totalFiles} effectiveLines=${totalEffectiveLines} minLines=${minLines} minOccurrences=${minOccurrences} windows=${allWindows.length}`,
    }
  },
  selfTest: [
    {
      // 反证：同一段代码被 3 个文件粘贴时必须报（阈值降到 10 行，样本保持可读）
      name: 'warn：同一代码块出现在 3 个文件里',
      root: path.join(FIXTURES, 'bad'),
      expect: 'warn',
      minWarnings: 1,
      maxErrors: 0,
      config: { source: { collector: 'ts', roots: ['src'], extensions: defaultSourceExtensions }, rules: { aq15: { minLines: 10, minOccurrences: 3 } } },
    },
    {
      // 反证的另一侧：只出现在 2 个文件时不报（阈值下不制造噪声）
      name: 'good：同一代码块只出现在 2 个文件（阈值下不报）',
      root: path.join(FIXTURES, 'good'),
      expect: 'green',
      config: { source: { collector: 'ts', roots: ['src'], extensions: defaultSourceExtensions }, rules: { aq15: { minLines: 10, minOccurrences: 3 } } },
    },
    {
      // D1 空集翻面（2026-10-28）：文件都在但全部低于 minLines×2 门槛 = 没扫到，不是干净。
      // 旧实现这里报 CLEAN info（files=0 也报绿），引擎自扫 demo 夹层时整面假绿。
      name: 'warn：全部文件低于有效行门槛时不再报 CLEAN（空集不报绿）',
      root: path.join(FIXTURES, 'small'),
      expect: 'warn',
      minWarnings: 1,
      maxErrors: 0,
      config: { source: { collector: 'ts', roots: ['src'], extensions: defaultSourceExtensions }, rules: { aq15: { minLines: 20, minOccurrences: 3 } } },
    },
  ],
})
