/**
 * AQ023 · 导出的异步 DB 读函数未包 React cache，且被多处 Server Component 调用。
 *
 * 泛化后三种命中形态（从轻到重）：
 *
 *   1. 基础形态（warn）：2+ Server Component 调同一个 async DB 读函数 + 未包 cache
 *      skinlab 样本：getMerchantAccessContext 被 layout + store/page 双调（已修）
 *
 *   2. 时间参数形态（info → 已有 warn 基础上追加提示）：
 *      函数签名带 date/day/today/period 等时间形参 → 建议 memoize + 短 TTL
 *      （例如 adminDemandSignals(days) 每次用 days=30，短 TTL 可合并 2+ 次调用）
 *
 *   3. 身份获取形态（warn）：函数体含 auth()/getSession()/getUserFromRequest()
 *      → 身份函数应是 request 级 cache 的首要目标
 *      skinlab admin/layout.tsx + 9 个 page.tsx 都直接 auth() → 同请求跑 10 次
 *
 * 解法：export const X = cache(async () => { ... })。
 * 同请求内 N→1 次 DB 往返。
 *
 * 关于 auth() 的特殊说明：Next.js 的 auth() 是 runtime API（读取 Request cookies/headers），
 * 不能直接进 React.cache()——但应该由 **最顶层 layout** 调一次后通过 props 传给 page，
 * 或者用 getAuthUserId()（返回 userId 的纯函数版本）包 cache。
 *
 * ## 判据（形态可复算）
 *
 * 1. 遍历 ctx.files：找出所有 lib/ 和 jobs/ 下 .ts 文件里导出的 async 函数，
 *    函数体含 Prisma 读操作 + 未包 cache(。
 * 2. 再次遍历：在 app/ 下 layout/page 数每个候选被调次数。
 * 3. 命中形态：
 *    - 2+ 调用 → warn（基础形态）
 *    - 时间形参 + 1+ 调用 → info（建议短 TTL memoize）
 *    - 身份获取 + 1+ 调用 → warn（身份函数必须 cache）
 */

import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { stripComments } from '../lib/code-only.ts'
import { lineOf } from '../lib/rule-helpers.ts'

/** Prisma 只读操作（不含 create/update/delete/write/upsert） */
const PRISMA_READ_OPS = /\.(findUnique|findFirst|findMany|count|aggregate|groupBy|findRaw|queryRawUnsafe?)\s*\(/
const CACHE_WRAPPER = /\bcache\s*\(/
const REACT_CACHE_IMPORT = /from\s+['"](?:react|next\/cache)['"]/

/** 函数签名模式 */
const EXPORTED_ASYNC_FN = /export\s+(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)\s*=\s*async(?:\s*\()/g

/** 时间形参关键词（函数签名里的参数名或类型里含这些词） */
const TIME_PARAM_KEYWORDS = /\b(date|day|days|today|yesterday|period|periodStart|periodEnd|range|window|startOf|endOf|since|until|from|to|week|month|quarter|year|hour|minute|second|timestamp|YYYY|MMDD|time)\b/i

/** 身份获取操作（函数体里出现这些调用 → 身份函数） */
const AUTH_OPS = /\b(?:auth|getSession\w*|getUser\w*|getSessionUserId|authenticateAgent|getUserFromRequest|getCurrentUser|clerkAuth|nextAuth|getAuth)\s*\(/

interface ReadFnCandidate {
  name: string
  file: string
  line: number
  wrappedInCache: boolean
  hasTimeParam: boolean   // 函数签名里有 date/day/period 等时间形参
  isAuthFn: boolean      // 函数体含 auth()/getSession() 等身份获取
  signature: string       // 函数签名（用于检测时间形参）
}

/** 提取从第一个 { 开始的函数体 */
function extractFunctionBody(src: string, startHint: number): string {
  // 找到 async 或 function 关键字后第一个 {
  let open = src.indexOf('{', startHint)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return ''
}

function isLibSource(rel: string): boolean {
  if (!rel.endsWith('.ts')) return false
  if (rel.includes('/node_modules/')) return false
  if (/(^|\/)(?:config|schema|next\.config)\./.test(rel)) return false
  return rel.startsWith('lib/') || rel.startsWith('jobs/')
}

function isServerComponent(rel: string): boolean {
  if (!rel.startsWith('app/')) return false
  if (rel.endsWith('/route.ts') || rel.endsWith('/route.js')) return false // 排除 route handler
  if (/\/(?:layout|page|error|loading|template|default)\.(tsx?|jsx?)$/.test(rel)) return true
  return false
}

export const aq23 = toGuard({
  id: 'aq23',
  title: '导出的异步 DB 读函数未缓存',
  invariants: ['INV-PERF-01'],
  blindSpots: [
    '不判原生 guard（inv20）已经覆盖的路由 handler 内部身份缓存',
    '只认 lib/jobs 目录下的导出 async 函数，helper 层藏在 app/_lib 里不会被扫',
    '函数体只有 Prisma aggregate 的 select 不含字段时（`_count: true` 也应算读操作，但词表已覆盖）',
    'Next 16 的 "use cache" 指令（新语法）不在射程 — 当前只认 cache() 包裹',
  ],
  code: 'AQ023_UNCACHED_SERVER_READ',
  level: 'warn',
  impact:
    '同一请求里 2+ 个 Server Component 调同一条异步 DB 读函数，但函数没包 React.cache()。' +
    'Next App Router 每次路由切换重跑 Server Component 树，这份查询会被重复执行。',
  provenance: '2026-10-29 Web3 团长后台性能批：lib/merchant/members.ts getMerchantAccessContext ' +
    '被 app/merchant/layout.tsx 和 app/merchant/store/page.tsx 同时调用，每次切换 2 次 DB 往返 → 包 React.cache 合并。',

  applies(rel) {
    // 射程：lib/jobs 的导出函数 + app 的 Server Component（我们需要同时看两者，
    // 但 analyze 只拿单文件，这里用 ctx.files 跨文件分析）
    return isLibSource(rel) || isServerComponent(rel)
  },

  analyze(_src, _rel, ctx: RuleCtx): RawHit[] {
    // ---- 第一段：扫 lib/jobs，收集候选 async DB 读函数 ----
    const candidates: ReadFnCandidate[] = []
    for (const file of ctx.files) {
      if (!isLibSource(file)) continue
      const rawSrc = ctx.readFile(file)
      if (!rawSrc) continue
      const code = stripComments(rawSrc)
      if (!PRISMA_READ_OPS.test(code)) continue

      let m: RegExpExecArray | null
      EXPORTED_ASYNC_FN.lastIndex = 0
      while ((m = EXPORTED_ASYNC_FN.exec(code)) !== null) {
        const name = m[1] ?? m[2]
        if (!name) continue
        const hintStart = m[1] !== undefined ? m.index : code.indexOf('async', m.index)
        const body = extractFunctionBody(code, hintStart)
        if (!body) continue
        if (!PRISMA_READ_OPS.test(body)) continue
        const wrapped = CACHE_WRAPPER.test(body) || CACHE_WRAPPER.test(stripComments(rawSrc))

        // 提取函数签名（从 function/const 关键字到第一个 {）
        const sigEnd = code.indexOf('{', hintStart)
        const signature = sigEnd > 0 ? code.slice(hintStart, sigEnd) : ''

        candidates.push({
          name, file, line: lineOf(rawSrc, m.index), wrappedInCache: wrapped,
          hasTimeParam: TIME_PARAM_KEYWORDS.test(signature),
          isAuthFn: AUTH_OPS.test(body),
          signature,
        })
      }
    }

    if (candidates.length === 0) return []

    // ---- 第二段：扫 app/**/layout|page，数每个候选被调几次 ----
    const callers: Record<string, string[]> = Object.fromEntries(candidates.map((c) => [c.name, []]))
    for (const file of ctx.files) {
      if (!isServerComponent(file)) continue
      const src = ctx.readFile(file)
      if (!src) continue
      const code = stripComments(src)
      for (const c of candidates) {
        const identifierRe = new RegExp(`\\b${c.name}\\s*\\(`, 'g')
        if (identifierRe.test(code)) callers[c.name].push(file)
      }
    }

    // ---- 第三段：分三种命中形态 ----
    const hits: RawHit[] = []
    for (const c of candidates) {
      if (c.wrappedInCache) continue
      const sites = callers[c.name]

      // 形态 3：身份获取函数 — 任何调用数都 warn
      if (c.isAuthFn && sites.length >= 1) {
        hits.push({
          line: c.line,
          message:
            `\`${c.name}\` 内含 auth()/getSession() 等身份获取，` +
            `被 ${sites.length} 个 Server Component 调用 — 身份函数必须包 React.cache()。` +
            '注意：auth() 是 runtime API 不能进 cache()，建议改用 getSessionUserId() 版本或 layout 统一调一次通过 props 下发。',
          evidence: `${c.name}（身份函数）被 ${sites.length} 处调用`,
        })
        continue
      }

      // 形态 1：基础形态 — 2+ 调用 warn
      if (sites.length >= 2) {
        hits.push({
          line: c.line,
          message:
            `\`${c.name}\` 被 ${sites.length} 个 Server Component 调用（${sites.join(', ')}），` +
            '但函数体没包 React.cache()。同一请求内 DB 查询会被重复执行。',
          evidence: c.name,
        })
        continue
      }

      // 形态 2：时间参数 + 1+ 调用 → info（建议短 TTL memoize）
      if (c.hasTimeParam && sites.length >= 1) {
        hits.push({
          line: c.line,
          message:
            `\`${c.name}${c.signature.match(/\([^)]+\)/)?.[0] ?? '(...)'}\` 带时间形参，` +
            `即使目前只有 ${sites.length} 处调用，同一日期窗口可能被反复请求 → 建议用 unstable_cache 包短 TTL（如 300s）。`,
          evidence: `${c.name}（时间参数：${c.signature.match(/\([^)]+\)/)?.[0] ?? '(...)'}）`,
        })
      }
    }
    return hits
  },

  fixtures: [
    {
      name: 'lib 导出 async DB 读，layout + page 双调用未缓存（该报）',
      expect: 'warn',
      files: {
        'lib/merchant/members.ts':
          "import { prisma } from '@/lib/prisma'\n" +
          'export async function getMerchantAccessContext() {\n' +
          '  return await prisma.merchantMember.findFirst({ where: { userId: "x" } })\n' +
          '}\n',
        'app/merchant/layout.tsx':
          "import { getMerchantAccessContext } from '@/lib/merchant/members'\n" +
          'export default async function Layout({ children }: { children: React.ReactNode }) {\n' +
          '  const ctx = await getMerchantAccessContext()\n' +
          '  return <div>{children}</div>\n' +
          '}\n',
        'app/merchant/store/page.tsx':
          "import { getMerchantAccessContext } from '@/lib/merchant/members'\n" +
          'export default async function StorePage() {\n' +
          '  const ctx = await getMerchantAccessContext()\n' +
          '  return <div>{ctx?.merchant.name}</div>\n' +
          '}\n',
      },
    },
    {
      name: '已包 React.cache()（不该报）',
      expect: 'green',
      files: {
        'lib/merchant/members.ts':
          "import { cache } from 'react'\nimport { prisma } from '@/lib/prisma'\n" +
          'export const getMerchantAccessContext = cache(async () => {\n' +
          '  return await prisma.merchantMember.findFirst({ where: { userId: "x" } })\n' +
          '})\n',
        'app/merchant/layout.tsx':
          "import { getMerchantAccessContext } from '@/lib/merchant/members'\n" +
          'export default async function Layout({ children }: { children: React.ReactNode }) {\n' +
          '  const ctx = await getMerchantAccessContext()\n' +
          '  return <div>{children}</div>\n' +
          '}\n',
        'app/merchant/store/page.tsx':
          "import { getMerchantAccessContext } from '@/lib/merchant/members'\n" +
          'export default async function StorePage() {\n' +
          '  const ctx = await getMerchantAccessContext()\n' +
          '  return <div>{ctx?.merchant.name}</div>\n' +
          '}\n',
      },
    },
    {
      name: '只被 1 个 Server Component 调用（不该报）',
      expect: 'green',
      files: {
        'lib/merchant/members.ts':
          "import { prisma } from '@/lib/prisma'\n" +
          'export async function onlyOneCaller() {\n' +
          '  return await prisma.merchant.findFirst({ where: { id: "x" } })\n' +
          '}\n',
        'app/merchant/layout.tsx':
          "import { onlyOneCaller } from '@/lib/merchant/members'\n" +
          'export default async function Layout({ children }: { children: React.ReactNode }) {\n' +
          '  const ctx = await onlyOneCaller()\n' +
          '  return <div>{children}</div>\n' +
          '}\n',
      },
    },
    {
      name: '时间参数 + 1 处调用（warn，建议短 TTL memoize）',
      expect: 'warn',
      files: {
        'lib/analytics/trend.ts':
          "import { prisma } from '@/lib/prisma'\n" +
          'export async function trendDaily(days: number) {\n' +
          '  return await prisma.order.findMany({ where: { createdAt: { gte: new Date(Date.now() - days * 86400_000) } } })\n' +
          '}\n',
        'app/admin/dashboard/page.tsx':
          "import { trendDaily } from '@/lib/analytics/trend'\n" +
          'export default async function Dashboard() {\n' +
          '  const data = await trendDaily(30)\n' +
          '  return <div>{data.length}</div>\n' +
          '}\n',
      },
    },
    {
      name: '身份函数含 auth() + 被调用（warn）',
      expect: 'warn',
      files: {
        'lib/auth/session.ts':
          "import { auth } from '@/auth'\nimport { prisma } from '@/lib/prisma'\n" +
          'export async function getUserFromSession() {\n' +
          '  const session = await auth()\n' +
          '  return await prisma.user.findUnique({ where: { id: session?.user?.id } })\n' +
          '}\n',
        'app/admin/layout.tsx':
          "import { getUserFromSession } from '@/lib/auth/session'\n" +
          'export default async function AdminLayout({ children }: { children: React.ReactNode }) {\n' +
          '  const user = await getUserFromSession()\n' +
          '  return <div>{children}</div>\n' +
          '}\n',
      },
    },
    {
      name: '身份函数已包 cache（不该报）',
      expect: 'green',
      files: {
        'lib/auth/session.ts':
          "import { cache } from 'react'\nimport { auth } from '@/auth'\nimport { prisma } from '@/lib/prisma'\n" +
          'export const getUserFromSession = cache(async () => {\n' +
          '  const session = await auth()\n' +
          '  return await prisma.user.findUnique({ where: { id: session?.user?.id } })\n' +
          '})\n',
        'app/admin/layout.tsx':
          "import { getUserFromSession } from '@/lib/auth/session'\n" +
          'export default async function AdminLayout({ children }: { children: React.ReactNode }) {\n' +
          '  const user = await getUserFromSession()\n' +
          '  return <div>{children}</div>\n' +
          '}\n',
      },
    },
    {
      name: '函数里只写不读（不该报） — Prisma write ops 不在词表里',
      expect: 'green',
      files: {
        'lib/audit/log.ts':
          "import { prisma } from '@/lib/prisma'\n" +
          'export async function writeAudit() {\n' +
          '  await prisma.auditLog.create({ data: { action: "x" } })\n' +
          '}\n',
        'app/merchant/layout.tsx':
          "import { writeAudit } from '@/lib/audit/log'\n" +
          'export default async function Layout({ children }: { children: React.ReactNode }) {\n' +
          '  await writeAudit()\n' +
          '  return <div>{children}</div>\n' +
          '}\n',
        'app/merchant/store/page.tsx':
          "import { writeAudit } from '@/lib/audit/log'\n" +
          'export default async function StorePage() {\n' +
          '  await writeAudit()\n' +
          '  return <div>ok</div>\n' +
          '}\n',
      },
    },
  ],
})
