/**
 * AQ008 · 按 ID 直取无归属校验（IDOR）
 *
 * ## 形态
 * handler 从 URL / body 拿 `id`，直接 `findUnique({ where: { id } })` 返回给调用方。
 * 攻击者把 id 换成别人的，数据就出去了。功能测试永远是绿的（测试用的是自己的数据）。
 *
 * ## 判据
 * 1. 文件是路由文件；
 * 2. 出现 `findUnique({ where: { id } })` 且 where 体内**只有** id 系字段（没有
 *    tenantId / userId / orgId / companyId 等归属列）；
 * 3. 且 id 来自请求（文件里出现 `params.id` / `searchParams.get` / `body.id` / `query.id`）。
 *
 * ## 为什么默认 report-only
 * 这条的误报率天然高：有些接口的 id 是**公开资源**（公开资产、文章），查到别人写的也算合法。
 * 这属于「语义不可判定」—— 静态判据只能提示「这里需要人看一句」。
 * 所以它的正确用法是：Report-Only 跑一轮，把真 IDOR 的路径写进各项目的
 * `ownershipReviewed` 名单（双向校验），剩下的才升级为 Enforce。
 */
import { stripComments } from '../lib/code-only.ts'
import { evidenceOf, isRouteFile, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'

const FIND_RE = /\b(\w+)\.findUnique\s*\(\s*\{\s*where\s*:\s*\{([^}]*)\}/g
const OWNER_COL = /\b(tenantId|tenant_id|merchantId|orgId|companyId|shopId|ownerId|userId|userId_tenantId)\b/
const FROM_REQUEST = /\b(params\.id|params\[|searchParams\.get|query\.id|body\.id|body\.data\.id|input\.id)\b/

/**
 * 查询之后紧跟的**归属断言**（目标仓 31 条里最主要的一类误报）。
 * 形态：`if (record.userId !== auth.user!.id) return apiError('FORBIDDEN')`。
 * 判据原本只看 where 子句，因为「查完再判」在静态上确实不可见 —— 但**同一文件往下读 40 行就可见了**。
 * 这不是语义猜测，是把「本可以读到的那一行」读进来。
 */
const OWNER_ASSERT =
  /\.(userId|merchantId|orgId|companyId|ownerId|tenantId)\s*(?:!==|===|!=|==)\s*|(?:\bassertOwner\b|\bFORBIDDEN\b|\bNOT_OWNER\b|\bPERMISSION_DENIED\b)/
/** `select` 只要了元数据（时间/主键）→ 没有内容可越权 */
const META_FIELDS = /^(id|createdAt|updatedAt|deletedAt|count|_count)$/

/**
 * `where: { id }` 里那个 id **具体来自哪里**。
 *
 * 第一版是文件级判断：只要文件里出现过 `searchParams.get`，全文件的 findUnique 都算「id 来自请求」。
 * 目标仓实测这是最大的一股误报：消息页把 `peerId`（由会话推导，不是请求参数）当请求 id 报，
 * 详情页把 `record.id`（已鉴权实体）当请求 id 报 —— 8 条里 4 条是这么来的。
 *
 * 判据必须精确到**标识符**：`record.id` 是成员表达式（不来自请求），
 * `specId` 要回溯它的赋值右值，`const { id } = await params` 是解构。
 */
function idComesFromRequest(code: string, ident: string): boolean {
  if (ident.includes('.')) return /\bparams\./.test(ident)
  const esc = ident.replace(/[$]/g, '\\$')
  // `const { id } = await params` / `const { id: orderId } = await params`
  if (new RegExp(`const\\s*\\{[^}]*\\b${esc}\\b[^}]*\\}\\s*=\\s*await\\s+params\\b`).test(code)) return true
  const assign = new RegExp(`(?:const|let|var)\\s+${esc}\\s*=\\s*([^\\n;]+)`, 'g')
  let mm: RegExpExecArray | null
  while ((mm = assign.exec(code)) !== null) {
    const rhs = mm[1]
    if (/\bparams\.|params\[|searchParams\.get|nextUrl\.searchParams|body\.|input\.|query\./.test(rhs)) return true
  }
  return false
}

export const aq08 = toGuard({
  id: 'aq08',
  title: '按 ID 直取无归属校验（IDOR）',
  invariants: ['INV-SEC-03'],
  code: 'AQ008_IDOR',
  blindSpots: [
      '「这个 id 属于调用者吗」语义上不可判定：公开资源（公开资产、文章）按 id 直取是合法的，需在 `publicModels` 声明',
      '归属断言只在命中点之后 40 行窗口内可见；断言写在调用者里（跨函数）仍会漏判',
      '窗口内任何一处 FORBIDDEN 都会让本处放过——同一文件里有多条不相干权限校验时会漏报',
      '不判嵌套关联（`include: { record: true }`）是否越权',
    ],
  impact: '把请求里的 id 换成别人的就能读到别人的数据；功能测试永远绿（测的是自己的数据）',
  provenance: "外部试点 A 的多租户盘点 + 外部试点 B（2026-10）的权限矩阵回填（数据库 RLS 之外的应用层归属校验缺口）",
  applies(rel) {
    return isRouteFile(rel)
  },
  analyze(src, rel, ctx: RuleCtx): RawHit[] {
    // 已复核名单支持两种写法：`string[]`（旧）与 `{ [rel]: 理由 }`（新）。
    // 新写法要求理由非空——空理由不算复核，否则登记制退化成静音开关（与 aq05.reviewed 同规矩）。
    const reviewed = ctx.options.ownershipReviewed ?? []
    if (Array.isArray(reviewed)) {
      if ((reviewed as string[]).includes(rel)) return []
    } else {
      const map = reviewed as Record<string, string>
      if (typeof map[rel] === 'string' && map[rel].trim() !== '') return []
    }
    // 平台运营面（后台）跨租户取数是设计：管理员的任务就是处置任意租户的数据。
    // 这一栏必须在配置里声明前缀，不许默认放行整个仓。
    const covers = (p: string): boolean => {
      const base = p.replace(/\/$/, '')
      return rel === base || rel.startsWith(base + '/') || rel.startsWith(base + '.')
    }
    const platformPrefixes = ((ctx.options.platformPrefixes as string[] | undefined) ?? [])
    if (platformPrefixes.some(covers)) return []

    const publicModels = ((ctx.options.publicModels as string[] | undefined) ?? []).map((m) => m.toLowerCase())
    const windowLines = Number(ctx.options.ownerWindowLines ?? 40)

    const code = stripComments(src)
    if (!FROM_REQUEST.test(code)) return []
    const lines = code.split('\n')

    const hits: RawHit[] = []
    let m: RegExpExecArray | null
    FIND_RE.lastIndex = 0
    while ((m = FIND_RE.exec(code)) !== null) {
      const model = m[1]
      if (publicModels.includes(model.toLowerCase())) continue
      const whereBody = m[2]
      const pairs = whereBody
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const idx = s.indexOf(':')
          return idx === -1
            ? { field: s.trim(), expr: s.trim() }
            : { field: s.slice(0, idx).trim(), expr: s.slice(idx + 1).trim() }
        })
      const fields = pairs.map((p) => p.field)
      const onlyId = fields.length > 0 && fields.every((f) => f === 'id' || f.endsWith('_id') || f === 'id_' )
      if (!onlyId) continue
      if (OWNER_COL.test(whereBody)) continue
      // id 必须**真的来自请求**才可能是越权：`{ id: order.id }` 里的 order 是前面已鉴权的实体
      const idExpr = pairs.find((p) => p.field === 'id')?.expr ?? 'id'
      if (!idComesFromRequest(code, idExpr)) continue

      const atLine = lineOf(src, m.index)
      const after = lines.slice(atLine - 1, atLine - 1 + windowLines).join('\n')
      // ① 查完当场断言归属 → 不是洞（目标仓 orders/shop-payment/after-sale 全是这一形态）
      if (OWNER_ASSERT.test(after)) continue
      // ② select 只要元数据 → 没有内容可越权（会话轮询锚点只取 createdAt 是典型）
      const sel = /select\s*:\s*\{([^}]*)\}/.exec(after)
      if (sel) {
        const picked = sel[1]
          .split(',')
          .map((s) => s.split(':')[0].trim())
          .filter(Boolean)
        if (picked.length > 0 && picked.every((f) => META_FIELDS.test(f))) continue
      }

      hits.push({
        line: atLine,
        evidence: evidenceOf(src, m.index),
        impact: `findUnique 只按 id 查（where: { ${fields.join(', ')} }），未带归属列：任何人都能换 id 读到别人的数据`,
      })
    }
    return hits
  },
  fixtures: [
    {
      name: '按 id 直取（该报）',
      expect: 'red',
      rel: 'app/api/records/[id]/route.ts',
      src: `export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const record = await prisma.record.findUnique({ where: { id: params.id } })
  return Response.json(record)
}
`,
    },
    {
      name: 'id 是已鉴权实体（record.id），不是请求参数（不该报）',
      expect: 'green',
      rel: 'app/api/records/[id]/detail/route.ts',
      src: `export async function POST(req: Request, { params }: { params: { id: string } }) {
  const record = await prisma.record.findUnique({ where: { id: params.id }, select: { userId: true } })
  if (record!.userId !== auth.user!.id) return apiError('FORBIDDEN', '无权操作')
  const fresh = await prisma.record.findUnique({ where: { id: record!.id }, select: { status: true } })
  return Response.json(fresh)
}
`,
    },
    {
      name: 'id 由会话推导（peerId），文件里另有 searchParams 也不算（不该报）',
      expect: 'green',
      rel: 'app/api/messages/route.ts',
      src: `export async function GET(req: Request) {
  const cursor = new URL(req.url).searchParams.get('cursor')
  const peerId = resolvePeer(cursor)
  const peer = await prisma.profile.findUnique({ where: { id: peerId }, select: { name: true } })
  return Response.json(peer)
}
`,
    },
    {
      name: '反证：id 来自 searchParams（该报）',
      expect: 'red',
      rel: 'app/api/items/preview/route.ts',
      src: `export async function GET(req: Request) {
  const itemId = new URL(req.url).searchParams.get('itemId') ?? ''
  const item = await prisma.item.findUnique({ where: { id: itemId } })
  return Response.json(item)
}
`,
    },
    {
      name: '查完当场断言归属（不该报）',
      expect: 'green',
      rel: 'app/api/records/[id]/route.ts',
      src: `export async function GET(_r: Request, { params }: { params: { id: string } }) {
  const record = await prisma.record.findUnique({ where: { id: params.id } })
  if (!record) return apiError('RECORD_NOT_FOUND', '记录不存在')
  if (record.userId !== auth.user!.id) return apiError('FORBIDDEN', '无权操作该记录')
  return Response.json(record)
}
`,
    },
    {
      name: 'select 只取元数据（不该报）：没有内容可越权',
      expect: 'green',
      rel: 'app/api/messages/route.ts',
      src: `export async function GET(req: Request) {
  const afterId = new URL(req.url).searchParams.get('afterId')
  const anchor = await prisma.message.findUnique({ where: { id: afterId }, select: { createdAt: true } })
  return Response.json(anchor)
}
`,
    },
    {
      name: '公开资源模型已声明（不该报）',
      expect: 'green',
      rel: 'app/api/links/route.ts',
      options: { publicModels: ['document'] },
      src: `export async function POST(req: Request) {
  const { documentId } = await req.json()
  const document = await prisma.document.findUnique({ where: { id: documentId }, select: { id: true } })
  return Response.json(document)
}
`,
    },
    {
      name: '平台运营面前缀（不该报）',
      expect: 'green',
      rel: 'app/api/admin/users/[id]/restrict/route.ts',
      options: { platformPrefixes: ['app/api/admin/'] },
      src: `export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await prisma.user.findUnique({ where: { id: params.id } })
  return Response.json(user)
}
`,
    },
    {
      name: 'select 取了内容又没有归属断言（该报）',
      expect: 'red',
      rel: 'app/api/records/[id]/route.ts',
      src: `export async function GET(_r: Request, { params }: { params: { id: string } }) {
  const record = await prisma.record.findUnique({ where: { id: params.id }, select: { userId: true, content: true } })
  return Response.json(record)
}
`,
    },
    {
      name: '带租户收敛（不该报）',
      expect: 'green',
      rel: 'app/api/records/[id]/route.ts',
      src: `export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const record = await prisma.record.findUnique({ where: { id: params.id, tenantId: session.tenantId } })
  return Response.json(record)
}
`,
    },
    {
      name: 'id 不来自请求（不该报）',
      expect: 'green',
      rel: 'app/api/me/route.ts',
      src: `export async function GET() {
  const id = await currentUserId()
  const user = await prisma.user.findUnique({ where: { id } })
  return Response.json(user)
}
`,
    },
    {
      name: '复合键（不该报）',
      expect: 'green',
      rel: 'app/api/accounts/[id]/route.ts',
      src: `export async function GET(_r: Request, { params }: { params: { id: string } }) {
  const x = await prisma.account.findUnique({ where: { id: params.id, orgId: params.orgId } })
  return Response.json(x)
}
`,
    },
  ],
})
