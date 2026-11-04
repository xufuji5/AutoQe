/**
 * AQ034 · Server Component 顶层 new Date()/Date.now() 破坏 ISR prerender。
 *
 * ## 缺陷形态
 *
 * Next.js App Router 的 Server Component 在 ISR / static prerender 场景下
 * 会被构建期执行 + 重验证执行。如果组件**顶层**（模块作用域，不在函数内）
 * 有 `new Date()` 或 `Date.now()`：
 *
 *   // app/products/[id]/page.tsx （顶层代码）
 *   const now = new Date()              // ← 模块加载时就执行
 *   const yesterday = new Date(Date.now() - 86400000)
 *   const cacheKey = `${productId}-${now.getTime()}`
 *
 * 每次 ISR 重验证都会得到**不同的时间戳** → 破坏 ISR 缓存效率，
 * 还可能导致 prerender 时新 Date() 拿不到真实时间（构建期）。
 *
 * 正确做法：时间值应该在**请求级函数内部**获取：
 *   async function Page() {
 *     const now = new Date()   // ← 请求开始时才执行
 *     ...
 *   }
 *
 * ## 判据
 *
 * 1. Server Component 文件（app/ 目录下的 layout/page/error/loading 文件）
 * 2. 顶层（不在任何函数/块内）出现 `new Date(` 或 `Date.now()`
 * 3. 排除 jobs/ / scripts/ / lib/ — 只扫 Server Component
 */

import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { stripComments } from '../lib/code-only.ts'
import { lineOf } from '../lib/rule-helpers.ts'

const SERVER_COMPONENT_RE = /\/(?:layout|page|error|loading|template|default)\.(tsx?|jsx?)$/

function isServerComponent(rel: string): boolean {
  if (!rel.startsWith('app/')) return false
  return SERVER_COMPONENT_RE.test(rel)
}

/** 提取所有"顶层"（不在 { ... } 花括号块内）的 new Date(...) / Date.now(...) */
function findTopLevelDateCalls(src: string): Array<{ at: number; text: string }> {
  const results: Array<{ at: number; text: string }> = []
  // 粗策略：逐行扫描，跳过花括号块内的
  const lines = src.split('\n')
  let depth = 0
  let inTemplate = false
  let inString: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // 跳过模板串和字符串
    for (let j = 0; j < line.length; j++) {
      const c = line[j]
      if (inTemplate) { if (c === '`' && line[j - 1] !== '\\') inTemplate = false; continue }
      if (inString) { if (c === inString && line[j - 1] !== '\\') inString = null; continue }
      if (c === '`') { inTemplate = true; continue }
      if (c === '"' || c === "'") { inString = c; continue }
      if (c === '{') depth++
      else if (c === '}') { if (depth > 0) depth-- }
    }

    // 顶层行：depth === 0
    if (depth === 0) {
      // 找 new Date( / Date.now(
      const newDateRe = /\bnew\s+Date\s*\(/g
      let m: RegExpExecArray | null
      while ((m = newDateRe.exec(line)) !== null) {
        results.push({
          at: src.indexOf(line) + m.index,
          text: 'new Date(...)',
        })
      }
      const dateNowRe = /\bDate\.now\s*\(/g
      while ((m = dateNowRe.exec(line)) !== null) {
        results.push({
          at: src.indexOf(line) + m.index,
          text: 'Date.now()',
        })
      }
    }
  }
  return results
}

export const aq34 = toGuard({
  id: 'aq34',
  title: 'Server Component 顶层 new Date() 破坏 ISR prerender',
  invariants: ['INV-PERF-05'],
  code: 'AQ034_TOP_LEVEL_DATE_IN_SERVER_COMPONENT',
  level: 'warn',
  impact:
    'Server Component 顶层（模块作用域）new Date()/Date.now() 会在每次 ISR 重验证时得到不同值，' +
    '破坏缓存效率；构建期 prerender 时 new Date() 可能拿到不可预期的值。' +
    '正确做法：时间值应该在 async 函数组件的请求级内部获取。',
  provenance: '2026-10-29 skinlab 性能批附录六：/join/apply page 顶层 new Date() 导致 Next prerender 错误。',

  applies(rel) {
    return isServerComponent(rel)
  },

  analyze(src, rel, _ctx: RuleCtx): RawHit[] {
    // 先 strip 注释再扫，避免 JSDoc 里的 new Date() 误报
    const code = stripComments(src)
    const rawHits = findTopLevelDateCalls(code)
    if (rawHits.length === 0) return []

    const hits: RawHit[] = []
    const seen = new Set<number>()
    for (const h of rawHits) {
      if (seen.has(h.at)) continue
      seen.add(h.at)
      hits.push({
        line: lineOf(code, h.at),
        message:
          `\`${rel}\` 顶层 ${h.text} — 模块加载时就执行，ISR 重验证每次都不同。` +
          '应在 async 函数组件内部获取时间值。',
        evidence: h.text,
      })
    }
    return hits
  },

  fixtures: [
    {
      name: 'page 顶层 new Date()（该报）',
      expect: 'warn',
      rel: 'app/products/[id]/page.tsx',
      src:
        'const now = new Date()\n' +
        'const cacheKey = `product-${now.getTime()}`\n' +
        'async function Page() {\n' +
        '  return <div>cache: {cacheKey}</div>\n' +
        '}\n',
    },
    {
      name: '函数内 new Date()（不该报：请求级执行正确）',
      expect: 'green',
      rel: 'app/products/[id]/page.tsx',
      src:
        'async function Page() {\n' +
        '  const now = new Date()\n' +
        '  return <div>now: {now.toISOString()}</div>\n' +
        '}\n',
    },
    {
      name: '顶层 const 导出 Date 常量（该报：也是模块加载时执行）',
      expect: 'warn',
      rel: 'app/analytics/page.tsx',
      src:
        'const START = new Date("2024-01-01")\n' +
        'async function Page() {\n' +
        '  return <div>{START}</div>\n' +
        '}\n',
    },
  ],
})
