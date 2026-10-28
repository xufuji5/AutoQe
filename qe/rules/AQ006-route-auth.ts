/**
 * AQ006 · 路由导出但无鉴权
 *
 * ## 为什么单列这一条
 * 「忘记加鉴权」是唯一一种**测试全绿、类型全对、功能正常**的致命缺陷。
 * 没有任何静态检查会因为它报错：handler 是纯函数，谁都能调。
 * 而它一旦发生，就是整个后台对外裸奔。
 *
 * ## 判据
 * 文件是 Next App Router 的 `route.ts`（或 pages/api），导出了 HTTP 方法（GET/POST/…），
 * 但整个文件里没有任何一个鉴权入口调用：
 *   auth() / getServerSession / getSession / currentUser / requireUser / requireAuth /
 *   verifyToken / assertAdmin / checkPermission / withAuth …
 *
 * ## 误报边界（这条规则的误报率决定它活不活）
 * 三类合法公开端点必须显式声明，不能靠「看起来像」：
 *   ① 健康检查 / 探活（/health、/ping）
 *   ② 协议回调（webhook、支付回调、第三方 OAuth 回调）—— 它们靠签名而非 session
 *   ③ 登录/注册/验证码入口本身
 * 用 `options.publicPaths`（正则数组）声明；未声明即判红。**宁可让人多写一行声明，
 * 也不要让规则自己猜** —— 猜错的代价是漏掉一个真裸奔的接口。
 *
 * ## 判据本身也会漏（首轮实测教训，2026-10-24）
 *
 * 第一版只列了 `auth / getServerSession / requireAuth / assertAdmin` 一小组名字，
 * 在试点 A 上直接报 **152 处「裸奔」——全是误报**：该项目的鉴权入口叫
 * `requirePermission(request, 'analytics.view')`。名字没列举到，不等于没有鉴权。
 *
 * 所以本规则允许项目补 `authPatterns`（正则数组），并且 runtime 做**适配性自检**：
 * 若一条规则命中了超过半数的适用文件，报告会标「判据不适配」，而不是把它当 152 个洞。
 */
import { stripComments } from '../lib/code-only.ts'
import { isRouteFile, lineOf } from '../lib/rule-helpers.ts'
import { allMethodsDeclaredPublic, authVocabulary, hasAuthEvidence, routePathCovers } from '../lib/auth-evidence.ts'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'

const METHOD_RE = /^\s*export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm

const DEFAULT_PUBLIC = [
  'app/api/health/route',
  'app/api/ping/route',
  'app/api/auth/',
  'app/api/webhook',
  'app/api/callback',
  'pages/api/health',
]

export const aq06 = toGuard({
  id: 'aq06',
  title: '路由导出但无鉴权',
  invariants: ['INV-WEB-01'],
  code: 'AQ006_NO_AUTH',
  blindSpots: [
      '鉴权由中间件统一注入时本规则看不见——此处必然误报，必须把该前缀写进 `publicPaths` 并写明理由',
      '只认「函数调用形态」的守卫；从上下文对象取权限位（`ctx.user.role` 判空）的写法可能漏判',
      '协议回调靠签名而非会话，语义上无法与「裸奔」区分，只能逐条声明',
    ],
  impact: '测试全绿、类型全对、功能正常，但整个后台对外裸奔——唯一不会被任何检查拦住的高危缺陷',
  provenance: "外部试点 A（2026-10）的接口归属登记表——每一条都是「新加的 route 忘了走鉴权」；首轮跨项目试跑把 21 个已鉴权路由报成裸奔，由此改为结构判定",
  applies(rel) {
    return isRouteFile(rel)
  },
  analyze(src, rel, ctx: RuleCtx): RawHit[] {
    const codes = stripComments(src)
    const methods: Array<{ name: string; index: number }> = []
    let m: RegExpExecArray | null
    METHOD_RE.lastIndex = 0
    while ((m = METHOD_RE.exec(codes)) !== null) methods.push({ name: m[1], index: m.index })
    if (methods.length === 0) return []

    // 鉴权词表/公共路由与 inv20 同源（lib/auth-evidence.ts）：同一概念不许有两个答案。
    // 项目把词表写在 boundaries.* 即可，不必再维护一份 rules.aq06.*。
    const vocab = authVocabulary(ctx.config)

    // 鉴权关键词在**全文**出现即算（含 import 与 middleware 注入）
    if (hasAuthEvidence(codes, { patterns: vocab.patterns, authModules: vocab.authModules, importsText: codes })) {
      return []
    }

    // 公共路由登记**按方法**判：整文件豁免会把同文件里鉴权面（写入 POST）的覆盖一起丢掉。
    const declared = [...DEFAULT_PUBLIC.map((file) => ({ file })), ...vocab.publicRoutes]
    if (allMethodsDeclaredPublic(rel, methods.map((x) => x.name), declared)) return []

    // 中间件统一鉴权的前缀（如 proxy.ts 对 `/api/admin` 全线做 IP 白名单 + 会话 + 角色校验）。
    // 本规则看不到中间件，只能靠声明；声明必须是**前缀**且只影响该前缀，不许写成项目根。
    if (vocab.middlewareProtected.some((p) => routePathCovers(p, rel))) return []

    return [
      {
        line: lineOf(src, methods[0].index),
        evidence: `export ${methods.map((x) => x.name).join('/')} —— ${rel}`,
        impact: `导出了 ${methods.map((x) => x.name).join('/')} 但文件内没有任何鉴权调用；若是公开端点请在 publicPaths 声明`,
      },
    ]
  },
  fixtures: [
    {
      name: '守卫名是 requireMerchant（结构判据该认，不该报）',
      expect: 'green',
      rel: 'app/api/merchant/pay/route.ts',
      src: `import { requireMerchant } from '@/lib/merchant/session'
export async function POST(req: Request) {
  const m = await requireMerchant(req)
  return Response.json({ ok: m.id })
}
`,
    },
    {
      name: '返回 AUTH_REQUIRED 错误码（该认，不该报）',
      expect: 'green',
      rel: 'app/api/messages/route.ts',
      src: `export async function GET(req: Request) {
  const self = await resolveSelfIdSet(req)
  if (!self.selfId) return apiError('AUTH_REQUIRED', '未登录')
  return Response.json({ ok: true })
}
`,
    },
    {
      name: '只有 assertValid 入参校验（不是鉴权，必须报）',
      expect: 'red',
      rel: 'app/api/records/route.ts',
      src: `export async function POST(req: Request) {
  const body = await req.json()
  assertValid(body)
  return Response.json({ ok: true })
}
`,
    },
    {
      name: '裸奔的 GET（该报）',
      expect: 'red',
      rel: 'app/api/records/route.ts',
      src: `export async function GET() {\n  return Response.json(await listRecords())\n}\n`,
    },
    {
      name: '有 auth（不该报）',
      expect: 'green',
      rel: 'app/api/records/route.ts',
      src: `import { auth } from '@/auth'\nexport async function GET() {\n  const s = await auth()\n  if (!s) return new Response('401', { status: 401 })\n  return Response.json({})\n}\n`,
    },
    {
      name: '鉴权在领域 helper：request 进、判空即拒（不该报）',
      expect: 'green',
      rel: 'app/api/tenant/apply/route.ts',
      src: `import { resolveTenant } from '@/lib/tenant/session'
export async function POST(request: Request) {
  const tenant = await resolveTenant(request)
  if (!tenant) return apiError('TENANT_NOT_FOUND', '请先完成租户开通')
  return Response.json({ ok: true })
}
`,
    },
    {
      name: '鉴权 helper 返回 result.ok（不该报）',
      expect: 'green',
      rel: 'app/api/admin/sms/send/route.ts',
      src: `import { sendHighRiskSmsCode } from '@/lib/admin/high-risk'
export async function POST(request: Request) {
  const result = await sendHighRiskSmsCode(request, 'user.block')
  if (!result.ok) return apiError(result.error.code, result.error.message)
  return Response.json({ ok: true })
}
`,
    },
    {
      name: '前缀不越界：auth-evil 不该被 app/api/auth/ 放过（该报）',
      expect: 'red',
      rel: 'app/api/auth-evil/route.ts',
      src: `export async function GET() {\n  return Response.json({ ok: true })\n}\n`,
    },
    {
      name: '中间件保护前缀已声明（不该报）',
      expect: 'green',
      rel: 'app/api/admin/users/route.ts',
      options: { middlewareProtected: ['app/api/admin/'] },
      src: `export async function GET() {\n  return Response.json(await listUsers())\n}\n`,
    },
    {
      name: '健康检查（不该报）',
      expect: 'green',
      rel: 'app/api/health/route.ts',
      src: `export async function GET() {\n  return Response.json({ ok: true })\n}\n`,
    },
    {
      // 多文件样本：证明「不是 route 文件就不进射程」，同时保证本样本的射程非空
      name: '非 route 文件不进射程（配一个已鉴权路由，保证射程非空）',
      expect: 'green',
      files: {
        'lib/records.ts': `export async function GET() {\n  return Response.json({})\n}\n`,
        'app/api/records/route.ts': `import { auth } from '@/auth'\nexport async function GET() {\n  if (!(await auth())) return new Response('401', { status: 401 })\n  return Response.json({})\n}\n`,
      },
    },
  ],
})
