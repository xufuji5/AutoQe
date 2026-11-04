/**
 * AQ032 · 同一目录树下 ≥2 个 Server Component 直接 await auth()/getSession()。
 *
 * ## 缺陷形态
 *
 * 在 Next.js App Router 里：
 *
 *   // app/[admin]/layout.tsx
 *   const session = await auth()     // 跑一次 auth()
 *
 *   // app/[admin]/accounts/page.tsx
 *   const session = await auth()     // 又跑一次 auth()（同一请求里）
 *
 *   // app/[admin]/audit/page.tsx
 *   const session = await auth()     // 第三次...
 *
 * [项目 A] admin/ 目录下 layout + 9 个 page 都这样 → 同一请求里 auth() 跑 10 次。
 * auth() 底层要查 JWT/读 session cookie + 可能查 DB 校验 → 这 10 次不是便宜的操作。
 *
 * ## 解法
 *
 *   // 方案 A：layout 统一调一次，通过 props 下发
 *   // app/[admin]/layout.tsx
 *   const session = await auth()     // 只跑这一次
 *   return <AdminLayout session={session}>{children}</AdminLayout>
 *
 *   // app/[admin]/accounts/page.tsx （变成 Client Component 或从父组件拿 session）
 *   const role = props.session?.user?.role
 *
 *   // 方案 B：用 React cache 包一层（如果 auth() 能进 cache 就更简洁）
 *   // 注意：NextAuth 的 auth() 是 runtime API，不一定能直接进 cache()
 *
 * ## 判据
 *
 * 1. 扫所有 layout.tsx / page.tsx Server Component 文件
 * 2. 找 `await auth()` / `await getSession()` / `const xxx = await auth()` 形态的裸调用
 * 3. 按"目录子树"分组：app/[admin]/layout.tsx 和 app/admin 下的 page.tsx 算同一子树
 * 4. 同一子树里 auth() 出现 ≥2 次 → warn
 * 5. 同一子树里只有 layout 有 auth()（page 没有）→ 放行（正确模式）
 *
 * ## 准入标准
 *
 * ✅ 静态可判：正则 + 路径分组
 * ✅ 跨仓可复现：Next.js App Router 项目通用
 * ✅ 有坏样本：[项目 A] admin/ layout + 9 page 全裸调 auth()
 * ✅ 误报可控：只认 `await auth(` 精确形态 + 目录子树分组 ≥2
 */

import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { stripComments } from '../lib/code-only.ts'
import { lineOf } from '../lib/rule-helpers.ts'

/** 直接在 Server Component 里裸调 auth()/getSession() — 不是通过 lib/ 导出函数 */
const BARE_AUTH_CALL = /\bawait\s+(auth|getSession|getSessionUserId|getCurrentUser|getAuth|clerkAuth)\s*\(/g

function isServerComponent(rel: string): boolean {
  if (!rel.startsWith('app/')) return false
  if (rel.endsWith('/route.ts') || rel.endsWith('/route.js')) return false
  if (/\/(?:layout|page|error|loading|template|default)\.(tsx?|jsx?)$/.test(rel)) return true
  return false
}

/** 归组：找 rel 最近的祖先 layout.tsx 所在目录。
 *  app/[admin]/layout.tsx → app/admin
 *  app/[admin]/users/page.tsx → app/admin（最近的 layout 根）
 *  app/[admin]/users/sub/page.tsx → app/[admin]/users（如果那层有 layout）
 *  app/api/xxx/route.ts → null（API 路由不归组）
 */
function findLayoutRoot(rel: string, allFiles: Set<string>): string | null {
  // API 路由不归组（天然是独立请求边界）
  if (/\/route\.(ts|js)$/.test(rel)) return null

  // 从 rel 往上找每一层目录，看有没有 layout.tsx
  let parts = rel.split('/')
  // 从最后一层往上走（去掉文件名）
  while (parts.length > 1) {
    parts = parts.slice(0, -1)
    const layoutFile = parts.join('/') + '/layout.tsx'
    const layoutFileAlt = parts.join('/') + '/layout.jsx'
    if (allFiles.has(layoutFile) || allFiles.has(layoutFileAlt)) {
      return parts.join('/')
    }
  }
  return null
}

export const aq32 = toGuard({
  id: 'aq32',
  title: 'Server Component 树内重复 auth() 调用',
  invariants: ['INV-PERF-03'],
  code: 'AQ032_DUPLICATE_AUTH_IN_TREE',
  level: 'warn',
  impact:
    '同一 Next.js App Router 子树内多个 layout/page 直接 await auth()，' +
    '同一次 HTTP 请求里 auth() 会被重复执行（通常涉及 JWT 验证 + session 查 DB）。' +
    '正确模式是 layout 统一调一次通过 props 下发，或用 React.cache() 包一层。',
  provenance: '2026-10-29 [项目 A] admin/ 治理：admin/layout.tsx + 9 个 page.tsx 全部裸调 await auth() → 同请求 10 次 auth() 执行。',

  applies(rel) {
    // 只对第一个 Server Component 文件返回 true，其余短路 → 性能优化 + 避免重复报告
    return isServerComponent(rel)
  },

  analyze(_src, rel, ctx: RuleCtx): RawHit[] {
    // 全局短路：只在"第一份" Server Component 文件上跑分析
    // 否则 300 个文件每个都扫全量 → O(N²) + 重复报告同一命中 N 次
    const serverFiles = ctx.files.filter(isServerComponent).sort()
    if (serverFiles.length === 0) return []
    if (rel !== serverFiles[0]) return []
    // ---- 第一段：扫所有 layout/page，收集每个文件里裸调 auth() 的次数和位置 ----
    type AuthSite = { rel: string; line: number; fn: string; layoutRoot: string | null }
    const sites: AuthSite[] = []
    const allFiles = new Set(ctx.files)

    for (const file of ctx.files) {
      if (!isServerComponent(file)) continue
      const rawSrc = ctx.readFile(file)
      if (!rawSrc) continue
      const layoutRoot = findLayoutRoot(file, allFiles)

      // 直接在 rawSrc 上匹配（不用 stripComments），因为 lineOf 需要和正则同一份字符串
      // await auth() 不会真的写在注释里，漏注释里的 false positive 可接受
      let m: RegExpExecArray | null
      BARE_AUTH_CALL.lastIndex = 0
      while ((m = BARE_AUTH_CALL.exec(rawSrc)) !== null) {
        sites.push({
          rel: file,
          line: lineOf(rawSrc, m.index),
          fn: m[1],
          layoutRoot,
        })
      }
    }

    if (sites.length === 0) return []

    // ---- 第二段：按 layoutRoot 分组（null 的不归组，API 路由各自独立） ----
    const byRoot = new Map<string, AuthSite[]>()
    for (const s of sites) {
      if (!s.layoutRoot) continue  // API 路由或无 layout 祖先，不归组
      if (!byRoot.has(s.layoutRoot)) byRoot.set(s.layoutRoot, [])
      byRoot.get(s.layoutRoot)!.push(s)
    }

    // ---- 第三段：layoutRoot 下 ≥2 个文件 → 每个 layoutRoot 只报 1 次（第一个 auth() 位置） ----
    const hits: RawHit[] = []
    for (const [root, treeSites] of byRoot) {
      const uniqueFiles = new Set(treeSites.map((s) => s.rel))
      if (uniqueFiles.size < 2) continue

      // 找这个 layoutRoot 里 auth() 出现最早的 site（最小 line）
      const firstSite = treeSites.reduce((prev, curr) => (curr.line < prev.line ? curr : prev))

      hits.push({
        line: firstSite.line,
        file: firstSite.rel,  // 关键：指明命中实际在哪个文件
        message:
          `\`${root}\` 子树里 ${uniqueFiles.size} 个 Server Component 都裸调 await ${firstSite.fn}() — ` +
          `同请求里身份鉴权跑 ${uniqueFiles.size} 次。` +
          '建议只在顶层 layout 调一次，通过 props 下发。' +
          `（${[...uniqueFiles].join(', ')}）`,
        evidence: `${root} × ${uniqueFiles.size} files → await ${firstSite.fn}()`,
      })
    }
    return hits
  },

  fixtures: [
    {
      name: 'layout + 2 page 都裸调 auth()（该报）',
      expect: 'warn',
      files: {
        'app/[admin]/layout.tsx':
          "import { auth } from '@/auth'\n" +
          'export default async function AdminLayout({ children }: { children: React.ReactNode }) {\n' +
          '  const session = await auth()\n' +
          '  return <div>{children}</div>\n' +
          '}\n',
        'app/[admin]/users/page.tsx':
          "import { auth } from '@/auth'\n" +
          'export default async function UsersPage() {\n' +
          '  const session = await auth()\n' +
          '  return <div>users</div>\n' +
          '}\n',
        'app/[admin]/orders/page.tsx':
          "import { auth } from '@/auth'\n" +
          'export default async function OrdersPage() {\n' +
          '  const session = await auth()\n' +
          '  return <div>orders</div>\n' +
          '}\n',
      },
    },
    {
      name: '只有 layout 调 auth()，page 通过 props 拿（不该报）',
      expect: 'green',
      files: {
        'app/[admin]/layout.tsx':
          "import { auth } from '@/auth'\n" +
          'export default async function AdminLayout({ children }: { children: React.ReactNode }) {\n' +
          '  const session = await auth()\n' +
          '  return <AdminShell session={session}>{children}</AdminShell>\n' +
          '}\n',
        'app/[admin]/users/page.tsx':
          'import { AdminShell } from "../_components/admin-shell"\n' +
          'export default function UsersPage() {\n' +
          '  return <div>users</div>\n' +
          '}\n',
      },
    },
    {
      name: '两个不同子树各只有 1 个 auth()（不该报：不同子树各自独立）',
      expect: 'green',
      files: {
        'app/[admin]/layout.tsx':
          "import { auth } from '@/auth'\n" +
          'export default async function AdminLayout({ children }: { children: React.ReactNode }) {\n' +
          '  const session = await auth()\n' +
          '  return <div>{children}</div>\n' +
          '}\n',
        'app/[feature]/layout.tsx':
          "import { auth } from '@/auth'\n" +
          'export default async function MerchantLayout({ children }: { children: React.ReactNode }) {\n' +
          '  const session = await auth()\n' +
          '  return <div>{children}</div>\n' +
          '}\n',
      },
    },
  ],
})
