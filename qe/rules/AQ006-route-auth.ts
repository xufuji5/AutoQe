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
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'

const METHOD_RE = /^\s*export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm

/**
 * 鉴权入口名册。这一栏**必然列不全** —— 它是「常见形态」而不是「完整集合」。
 *
 * 首轮实测（试点 A 152 处误报）证明：靠列名字判鉴权，换一个项目就全错
 * （`requirePermission` / `requireMerchantScope` / `cronSecretMatches` 都不在名单里）。
 *
 * 所以第二版改成**两级判据**：
 *   ① 精确名单（上面的常用名）；
 *   ② **词干匹配**：handler 里 `await X(...)` 的 X 名含鉴权语义词干
 *      （auth / session / permission / scope / guard / token / jwt / signature / secret / credential / login / admin）。
 *
 * ②会漏（叫 `checkAccess()` 的判不出来），但漏的方向是「少报」；宁可漏也不要把
 * 137 个有鉴权的路由写成「裸奔」—— 那会让整条规则失去信用，然后被关掉。
 * 项目可用 `authPatterns` / `authModules` 补。
 */
const AUTH_RE =
  /\b(auth|getServerSession|getSession|currentUser|getCurrentUser|requireUser|requireAuth|requireAdmin|requireRole|requirePermission|hasPermission|checkPermission|assertAdmin|assertPermission|verifyAdmin|isAdmin|adminGuard|withAuth|verifyToken|verifySignature|validateSession|authorize|guard)\b/

/** 鉴权语义词干（二级判据）。刻意不含 member/owner/tenant —— 那些是业务词，会大面积误判。 */
const AUTH_WORD =
  /(auth|session|permission|perms|role|scope|guard|token|jwt|signature|secret|credential|login|admin|acl|rbac|privilege|identity|principal)/i

/**
 * 三级判据：**动词 + 名词**的结构判定（首轮外部试跑撞出来的第二条硬教训）。
 *
 * 只靠列名字必然漏：试点 A 的主力守卫叫 `requireMerchant(...)`，
 * 而名单里只有 requireAuth/requireUser/requirePermission —— 于是 21 个有鉴权的路由
 * 被报成「裸奔」。加一个 `requireMerchant` 进去只是把这个问题推到下一个项目。
 *
 * 结构与语言无关：守卫调用的形状是「使令动词 + 受保护对象」。
 *   requireMerchant / assertAdminAccess / ensureSession / withMerchantScope  → 是守卫
 *   requireEnv / assertValid / ensureDir / checkFormat                      → 不是守卫（名词不在受保护对象里）
 * 两个条件必须**同时**成立，这既认得出新名字，又不会被 `assertValid` 骗过。
 */
const GUARD_VERB_RE = /^(?:require|assert|ensure|check|guard|with|verify)[A-Z][\w$]*$/
const GUARD_NOUN_RE =
  /(Auth|Admin|User|Member|Merchant|Role|Permission|Perms?|Session|Scope|Access|Owner|Identity|Principal|Token|Signature|Login|Guard|Privilege|Actor|Tenant)/

/** 显式返回这些错误码的路由，必然是鉴权感知的（试点 A 的主力写法） */
const AUTH_ERROR_CODE_RE = /\b(AUTH_REQUIRED|UNAUTHENTICATED|UNAUTHORIZED|NOT_LOGGED_IN|FORBIDDEN|SESSION_EXPIRED)\b/

/** 取 `await foo(` / `foo(` 的函数名，喂给词干判据 */
const CALL_NAME_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g

/**
 * 四级判据：「鉴权在领域 helper 里」的**结构**形态。
 *
 * 目标仓的鉴权入口常常收下整个 request 再自己决定怎么认人：
 *   `const merchant = await resolveMerchant(request)` → `if (!merchant) return apiError(...)`
 *   `const ctx = await getMerchantAccessContext(req)` → 后续按 ctx 分支
 *   `const result = await sendHighRiskSmsCode(request, permission)` → `if (!result.ok) return ...`
 * 这些函数名千奇百怪（resolve / get / send），但形状一样：**请求对象进、判定结果出、判空即拒**。
 *
 * 为什么不看函数名：见文件头 —— 列名字只是把问题推到下一个项目。这里只看形状。
 * 代价：`parseBody(req)` 后 `if (!body) return 400` 也会被认成鉴权（漏报方向，可接受，
 * 且这类文件通常另有真实鉴权或已进 publicPaths）。
 */
function hasAuthHelperShape(codes: string): boolean {
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+[\w$.]+\(\s*(?:request|req)\s*[,)]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(codes)) !== null) {
    const bound = m[1]
    const after = codes.slice(m.index, m.index + 1200)
    const guard = new RegExp(`if\\s*\\(\\s*!\\s*${bound}(?:\\.\\w+)?\\b`)
    if (guard.test(after)) return true
    // `if (!result.ok)` / `if (result.error)` 同样是否定式判定
    if (new RegExp(`if\\s*\\(\\s*!\\s*${bound}\\.\\w+`).test(after)) return true
  }
  return false
}

function hasAuthCall(codes: string, extra: readonly RegExp[]): boolean {
  if (AUTH_RE.test(codes)) return true
  if (AUTH_ERROR_CODE_RE.test(codes)) return true
  if (extra.some((re) => re.test(codes))) return true
  if (hasAuthHelperShape(codes)) return true
  // 二级：任一被调用（await 或直接）的函数名含鉴权词干
  CALL_NAME_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CALL_NAME_RE.exec(codes)) !== null) {
    const name = m[1]
    if (name.length < 4) continue
    if (AUTH_WORD.test(name)) return true
    if (GUARD_VERB_RE.test(name) && GUARD_NOUN_RE.test(name)) return true
  }
  return false
}

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

    // 鉴权关键词在**全文**出现即算（含 import 与 middleware 注入）
    const extraPatterns = ((ctx.options.authPatterns as string[] | undefined) ?? []).map((p) => new RegExp(p))
    const authModules = (ctx.options.authModules as string[] | undefined) ?? []
    const importedFromAuthModule = authModules.some((mod) =>
      new RegExp(`from\\s+['"][^'"]*${mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(codes),
    )
    if (importedFromAuthModule || hasAuthCall(codes, extraPatterns)) return []

    const declared = [
      ...DEFAULT_PUBLIC,
      ...((ctx.options.publicPaths as string[] | undefined) ?? []),
    ]
    // 前缀必须落在**目录边界**上：`app/api/auth/` 不该命中 `app/api/auth-evil/route.ts`。
    // 第一版是裸 `rel.startsWith(p)` —— 那正是本仓库另一条判据（假绿锚点）抓的病：
    // 用前缀匹配当安全边界，该拒绝的请求被放过。
    const covers = (p: string): boolean => {
      if (p.startsWith('^')) return new RegExp(p).test(rel)
      const base = p.replace(/\/$/, '')
      return rel === base || rel.startsWith(base + '/') || rel.startsWith(base + '.')
    }
    if (declared.some(covers)) return []

    // 中间件统一鉴权的前缀（如 proxy.ts 对 `/api/admin` 全线做 IP 白名单 + 会话 + 角色校验）。
    // 本规则看不到中间件，只能靠声明；声明必须是**前缀**且只影响该前缀，不许写成项目根。
    const mwProtected = ((ctx.options.middlewareProtected as string[] | undefined) ?? [])
    if (mwProtected.some(covers)) return []

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
