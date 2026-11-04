/**
 * AQ033 · async Server Component 绕过 page ISR（直调外部 HTTP API）。
 *
 * ## 缺陷形态
 *
 * Next.js App Router 的 `export const revalidate = 3600` / `export const dynamic = 'force-static'`
 * 只对 **整个 page** 的 ISR 生效——page 级 revalidate **不影响子组件里的直接 async/await**。
 * 如果子 Server Component 直接 await 外部 HTTP API（微信出码、支付签名、第三方服务），
 * 即使 page 被 ISR 缓存了，这个子组件每次仍会重新执行、重新发 HTTP 请求。
 *
 * skinlab 真实案例：首页 scan-card.tsx 是 async Server Component，每次首页请求都同步等
 * 两次微信 API 往返（先 getAccessToken 再 getwxacodeunlimit）——生产 TTFB 2.9s 完全耗在这。
 * 讽刺的是根 page.tsx 写了注释"出码每小时重算一次（ISR）"，但 ScanCard 没走 ISR。
 *
 * ## 解法
 *
 * 子组件内部用 unstable_cache 包装外部 API 调用，和 page revalidate 一致的 TTL：
 *   const getCachedMarketingQr = unstable_cache(async (page, scene, envVersion) => { ... }, key, { revalidate: 3600 })
 *
 * ## 判据
 *
 * 1. 文件是 Server Component（app/ 目录下的 layout/page/error/loading/template 文件）
 * 2. 是 async 函数组件（export default async function ... / async function ScanCard）
 * 3. 函数体里有 await 调用
 * 4. 函数体没有 unstable_cache / cache 包装
 * 5. 函数体没有 Prisma 读操作（Prisma 读已被 AQ023 覆盖）
 * 6. 函数体没有 import from 'next/cache' 或 cache from 'react'
 *    → 这说明开发者**还没意识到需要缓存外部 API**
 */

import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { stripComments } from '../lib/code-only.ts'
import { lineOf } from '../lib/rule-helpers.ts'

// 放宽：app/ 下所有 .tsx（非 .client.tsx、非 route.ts）都是 Server Component
const PRISMA_OPS = /\b(?:prisma|db|client|tx)\.[a-z][\w]*\.(findFirst|findUnique|findMany|findRaw|count|aggregate|groupBy|create|createMany|update|updateMany|delete|deleteMany|upsert|queryRaw|executeRaw)\b/
const CACHE_WRAPPED = /\b(unstable_cache|React\.cache|from ['"]next\/cache['"]|from ['"]react['"]|\bcache\s*\()/
const IS_ASYNC_COMPONENT = /export\s+default\s+async\s+function\s+\w+|export\s+async\s+function\s+\w+|async\s+function\s+\w+\s*\(/
// Server Component 自身代码里直调外部 HTTP API（不是通过 lib/ 间接调）
// 注意：Node 原生 TS 剥离器不支持 /x flag，所以用 new RegExp 字符串拼接
const DIRECT_EXTERNAL_API = new RegExp(
  [
    String.raw`\bawait\s+fetch\s*\(`,
    String.raw`\bawait\s+axios\.`,
    String.raw`\bawait\s+(?:getWxacodeUnlimit|getAccessToken|getPaySign|callWechat|callWxpay|wxpay[A-Z]\w*|wechat[A-Z]\w*|wx[A-Z]\w*)\s*\(`,
    String.raw`\bawait\s+(?:https?Request|httpClient|cos\.|qiniu\.|aliyun\.|smsService|sendSms)\s*\(`,
  ].join('|'),
)

function isServerComponent(rel: string): boolean {
  if (!rel.startsWith('app/')) return false
  if (/\.client\.(tsx?|jsx?)$/.test(rel)) return false  // Client Component 放行
  if (/\/route\.(ts|js)$/.test(rel)) return false         // API Route handler：不走 ISR，unstable_cache 语义不同
  return /\.(tsx?|jsx?)$/.test(rel)
}

export const aq33 = toGuard({
  id: 'aq33',
  title: 'async Server Component 绕过 ISR（直调外部 API）',
  invariants: ['INV-PERF-04'],
  code: 'AQ033_UNCACHED_EXTERNAL_API_IN_SERVER_COMPONENT',
  level: 'warn',
  impact:
    'Next.js 的 export const revalidate 只对整个 page 生效，不影响子组件里的直接 async/await。' +
    '如果子 Server Component 直接 await 外部 HTTP API，即使 page 被 ISR 缓存了，这个子组件每次仍会重发请求。' +
    '解法：子组件内部用 unstable_cache 包装外部 API 调用。',
  provenance: '2026-10-29 skinlab 性能批根因：scan-card.tsx 是 async Server Component，' +
    '每次首页请求同步等两次微信 API 往返（getAccessToken + getwxacodeunlimit），' +
    '生产 TTFB 2.9s 完全耗在这里。page.tsx 写了 revalidate=3600 但子组件绕过了。',

  applies(rel) {
    return isServerComponent(rel)
  },

  analyze(src, rel, _ctx: RuleCtx): RawHit[] {
    const code = stripComments(src)
    const hits: RawHit[] = []

    // 必须是 async Server Component
    if (!IS_ASYNC_COMPONENT.test(code)) return []
    // 必须直调外部 HTTP API（不是通过 lib/ 间接调身份函数）
    if (!DIRECT_EXTERNAL_API.test(code)) return []
    // 有 Prisma 读操作的 → 放行（AQ023 已覆盖）
    if (PRISMA_OPS.test(code)) return []
    // 已经有 cache 包装 → 放行
    if (CACHE_WRAPPED.test(code)) return []
    // import next/cache 或 cache from react → 放行（开发者已意识到需要缓存）
    if (/from\s+['"]next\/cache['"]/.test(code)) return []
    if (/import\s*\{\s*cache\s*\}\s*from\s+['"]react['"]/.test(code)) return []

    // 命中了
    // 找第一个 async function 的位置
    const fnM = code.match(/async\s+function\s+(\w+)/)
    const line = fnM ? lineOf(src, fnM.index) : 1

    // 看能不能识别 page.tsx 上有没有 revalidate
    const hasRevalidate = /export\s+const\s+revalidate\s*=/.test(code)

    hits.push({
      line,
      message:
        `\`${rel}\` 是 async Server Component，内部直调了外部 HTTP API ` +
        `（fetch/axios/微信/支付宝 等），但没包 unstable_cache。` +
        (hasRevalidate
          ? ` 根 page.tsx 声明了 revalidate，但这对子组件无效 — 每次请求仍会重发外部 API。`
          : ` 建议用 unstable_cache 包装外部 API 调用，TTL 与 page revalidate 一致。`),
      evidence: fnM ? `async function ${fnM[1]}(...) — 直调外部 API 无 unstable_cache` : 'async Server Component',
    })

    return hits
  },

  fixtures: [
    {
      name: 'async Server Component 直调外部 HTTP（该报）',
      expect: 'warn',
      rel: 'app/marketing/_components/scan-card.tsx',
      src:
        'async function ScanCard() {\n' +
        '  const buf = await getWxacodeUnlimit("pages/index/index", "home")\n' +
        '  const dataUri = wxacodeDataUri(buf)\n' +
        '  return <img src={dataUri} alt="" />\n' +
        '}\n',
    },
    {
      name: '已包 unstable_cache（不该报）',
      expect: 'green',
      rel: 'app/marketing/_components/scan-card.tsx',
      src:
        'import { unstable_cache } from "next/cache"\n' +
        'const getCachedQr = unstable_cache(async () => {\n' +
        '  return await getWxacodeUnlimit("pages/index/index", "home")\n' +
        '}, ["mini-home"], { revalidate: 3600 })\n' +
        'async function ScanCard() {\n' +
        '  const qr = await getCachedQr()\n' +
        '  return <img src={qr} alt="" />\n' +
        '}\n',
    },
    {
      name: 'async Server Component 调 Prisma（不该报：AQ023 覆盖）',
      expect: 'green',
      rel: 'app/merchant/layout.tsx',
      src:
        'async function MerchantLayout() {\n' +
        '  const merchant = await prisma.merchant.findFirst({ where: { ownerUserId: "x" } })\n' +
        '  return <div>{merchant?.name}</div>\n' +
        '}\n',
    },
    {
      name: 'sync Server Component（不该报：没有 await 绕过 ISR）',
      expect: 'green',
      rel: 'app/marketing/layout.tsx',
      src:
        'export default function MarketingLayout({ children }: { children: React.ReactNode }) {\n' +
        '  return <div>{children}</div>\n' +
        '}\n',
    },
    {
      name: 'async Server Component 只调 React.cache 包装的函数（不该报）',
      expect: 'green',
      rel: 'app/admin/layout.tsx',
      src:
        "import { cache } from 'react'\n" +
        'const getAdmin = cache(async () => {\n' +
        '  return await prisma.user.findFirst({ where: { role: "admin" } })\n' +
        '})\n' +
        'async function AdminLayout() {\n' +
        '  const admin = await getAdmin()\n' +
        '  return <div>{admin?.name}</div>\n' +
        '}\n',
    },
  ],
})
