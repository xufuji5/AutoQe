/**
 * AQ025 · async Server Component 里 Promise.all 之后的独立 await（无依赖关系）。
 *
 * ## 缺陷形态
 *
 * ```tsx
 * export default async function DashboardPage() {
 *   const [a, b] = await Promise.all([
 *     prisma.order.count({ ... }),
 *     prisma.product.findMany({ ... }),
 *   ])
 *   // ← 这里：merchantInsight() 不依赖 a/b 的任何变量
 *   const insight = await merchantInsight(merchant.id)  // 串行阻塞了 Promise.all 全部完成后才开始
 *   ...
 * }
 * ```
 *
 * 把 `merchantInsight()` 挪进 Promise.all 里，就能让它和 24 个查询**完全并发**。
 *
 * ## 判据（简化 MVP）
 *
 * 在一个 async 函数体里：
 * 1. 找到 `await Promise.all(` 块。
 * 2. 找到它之后紧跟的独立 `await xxx(` 语句（间隔 ≤5 行，且之间没有分支/循环结构）。
 * 3. 验证后面的 await 实参**不引用** Promise.all 解构出来的变量。
 * 4. 命中 → warn。
 *
 * ## 准入标准
 *
 * ✅ 静态可判：结构识别 + 变量引用追踪
 * ✅ 跨仓可复现：Next.js App Router 项目通用
 * ✅ 有坏样本：skinlab dashboard page 的 merchantInsight
 * ✅ 误报可控：只在 Promise.all 后 ≤5 行 + 变量不引用 + 函数体在同一文件射程内
 *
 * ## 盲区（已知）
 *
 * 真正精确的"依赖图"需要完整 TypeScript AST。当前 MVP 只覆盖：
 * - 简单解构 `const [a, b, c] = await Promise.all([...])`
 * - 紧接着 `const xxx = await yyy(z)` 且 z 不含 a/b/c
 * 跨 helper 函数的隐式依赖不在射程。
 */

import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { stripComments, maskStringBodies } from '../lib/code-only.ts'
import { lineOf } from '../lib/rule-helpers.ts'

function isServerComponentOrPage(rel: string): boolean {
  if (!rel.endsWith('.ts') && !rel.endsWith('.tsx')) return false
  return /^(?:app|pages)\//.test(rel) || rel.startsWith('lib/')
}

/** 找一个 async 函数体边界（简化：从 export async function/const NAME = async 开始） */
function findAsyncFunctionBodies(src: string): Array<{ start: number; end: number; line: number }> {
  const results: Array<{ start: number; end: number; line: number }> = []
  const ASYNC_SIG = /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\w+|(?:export\s+)?const\s+\w+\s*=\s*async/g
  let m: RegExpExecArray | null
  while ((m = ASYNC_SIG.exec(src)) !== null) {
    let open = src.indexOf('{', m.index)
    if (open < 0) continue
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) {
          results.push({ start: open, end: i + 1, line: lineOf(src, m.index) })
          break
        }
      }
    }
  }
  return results
}

/** 提取 Promise.all 解构出来的变量名 */
function extractPromiseAllBindings(body: string): Set<string> {
  const bindings = new Set<string>()
  const re = /const\s*\[([^\]]+)\]\s*=\s*await\s*Promise\.all\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const names = m[1].split(',').map((n) => n.trim().split(/[=?:]/)[0].trim())
    for (const n of names) if (n) bindings.add(n)
  }
  return bindings
}

/** 找 Promise.all 结束位置（从 Promise.all( 开始找平衡的 )） */
function findPromiseAllEnd(body: string, startIdx: number): number {
  // startIdx 指向 "Promise" — 往前挪到 "await " 位置
  let paren = body.indexOf('(', startIdx)
  if (paren < 0) return -1
  let depth = 0
  for (let i = paren; i < body.length; i++) {
    if (body[i] === '(') depth++
    else if (body[i] === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 检查一段代码里有没有引用某些变量名（按标识符边界） */
function referencesVars(code: string, vars: Set<string>): boolean {
  for (const v of vars) {
    if (new RegExp(`\\b${v}\\b`).test(code)) return true
  }
  return false
}

export const aq25 = toGuard({
  id: 'aq25',
  title: 'Promise.all 之后独立 await（可挪进并发）',
  invariants: ['INV-PERF-03'],
  blindSpots: [
    '依赖图只看直接解构变量引用，helper 函数隐式依赖（如 merchantInsight 内部用了 a）不在射程',
    '只识别 `const [a, b] = await Promise.all([...])` 形态；`const { a, b } = await Promise.all([...])` 解构不在射程',
    '没有排除 Promise.all 之后有 return 分支或条件分支的情况（理论上可以挪但语义变复杂时不建议）',
    'maskStringBodies 会处理字符串，但不处理注释字符串 — stripComments 会先处理注释',
  ],
  code: 'AQ025_SERIAL_AFTER_PROMISE_ALL',
  level: 'warn',
  impact:
    'Promise.all 之后有独立 await 没放进并发块。移进去可减少一次串行等待。',
  provenance: '2026-10-29 Web3 团长后台性能批：dashboard page 的 merchantInsight() ' +
    'Promise.all 之后单独 await，挪进去让 25 条查询全部并发。',

  applies(rel) {
    return isServerComponentOrPage(rel)
  },

  analyze(src, rel, _ctx: RuleCtx): RawHit[] {
    if (!/async\s+(?:function|\()/.test(src) && !/=\s*async\s*\(/.test(src)) return []
    const code = maskStringBodies(stripComments(src))
    const hits: RawHit[] = []

    for (const { start, end } of findAsyncFunctionBodies(src)) {
      const fnCode = code.slice(start, end)
      const bindings = extractPromiseAllBindings(fnCode)
      if (bindings.size === 0) continue

      // 找 Promise.all 的所有位置
      const PROMISE_ALL = /await\s+Promise\.all\s*\(/g
      let m: RegExpExecArray | null
      while ((m = PROMISE_ALL.exec(fnCode)) !== null) {
        const paEnd = findPromiseAllEnd(fnCode, m.index + 'await '.length)
        if (paEnd < 0) continue

        // 向后扫 ≤5 行，找独立 await
        const after = fnCode.slice(paEnd)
        const linesAfter = after.split('\n').slice(0, 6) // Promise.all 结束后 + 5 行
        const scanRegion = linesAfter.join('\n')

        const STANDALONE_AWAIT = /await\s+([A-Za-z_]\w*)\s*\(/g
        let am: RegExpExecArray | null
        while ((am = STANDALONE_AWAIT.exec(scanRegion)) !== null) {
          const awaitFn = am[1]
          // 检查这条 await 的参数部分有没有引用 Promise.all 解构变量
          const awaitLineMatch = scanRegion.slice(am.index).match(/await\s+\w+\s*\(([^)]*)\)/)
          const argText = awaitLineMatch?.[1] ?? ''
          if (!referencesVars(argText, bindings)) {
            hits.push({
              line: lineOf(src, start + paEnd + am.index),
              message:
                `\`${awaitFn}()\` 在 Promise.all 之后独立 await，但参数不依赖解构变量 ` +
                `（${[...bindings].join(', ')}）。挪进 Promise.all 可减少一次串行等待。`,
              evidence: awaitFn,
            })
          }
        }
      }
    }
    return hits
  },

  fixtures: [
    {
      name: 'async 函数里：merchantInsight 可挪进 Promise.all（该报）',
      expect: 'warn',
      files: {
        'app/merchant/dashboard/page.ts':
          'export async function dashboardApi(params) {\n' +
          '  const merchantId = "m1"\n' +
          '  const [orderCount, productCount] = await Promise.all([\n' +
          '    1, 2,\n' +
          '  ])\n' +
          '  const insight = await merchantInsight(merchantId)\n' +
          '  return { insight }\n' +
          '}\n',
      },
    },
    {
      name: '依赖解构变量的后续 await（不该报 — 需要串行）',
      expect: 'green',
      rel: 'app/merchant/dashboard/page.tsx',
      src:
        "import { prisma } from '@/lib/prisma'\n" +
        'export default async function DashboardPage() {\n' +
        '  const [merchantId] = await Promise.all([\n' +
        '    Promise.resolve("m1"),\n' +
        '  ])\n' +
        '  const orders = await prisma.order.count({ where: { merchantId } })\n' +
        '  return <div>{orders}</div>\n' +
        '}\n',
    },
    {
      name: 'Promise.all 结束后直接 return（不该报）',
      expect: 'green',
      rel: 'app/merchant/dashboard/page.tsx',
      src:
        "import { prisma } from '@/lib/prisma'\n" +
        'export default async function DashboardPage() {\n' +
        '  const [a, b] = await Promise.all([\n' +
        '    prisma.order.count(),\n' +
        '    prisma.product.count(),\n' +
        '  ])\n' +
        '  return <div>{a + b}</div>\n' +
        '}\n',
    },
  ],
})
