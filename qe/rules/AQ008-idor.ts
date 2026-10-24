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
 * 这条的误报率天然高：有些接口的 id 是**公开资源**（商品、文章），查到别人写的也算合法。
 * 这属于「语义不可判定」—— 静态判据只能提示「这里需要人看一句」。
 * 所以它的正确用法是：Report-Only 跑一轮，把真 IDOR 的路径写进各项目的
 * `ownershipReviewed` 名单（双向校验），剩下的才升级为 Enforce。
 */
import { stripComments } from '../lib/code-only.ts'
import { evidenceOf, isRouteFile, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'

const FIND_RE = /findUnique\s*\(\s*\{\s*where\s*:\s*\{([^}]*)\}/g
const OWNER_COL = /\b(tenantId|tenant_id|merchantId|orgId|companyId|shopId|ownerId|userId|userId_tenantId)\b/
const FROM_REQUEST = /\b(params\.id|params\[|searchParams\.get|query\.id|body\.id|body\.data\.id|input\.id)\b/

export const aq08 = toGuard({
  id: 'aq08',
  title: '按 ID 直取无归属校验（IDOR）',
  invariants: ['INV-SEC-03'],
  code: 'AQ008_IDOR',
  blindSpots: [
      '「这个 id 属于调用者吗」语义上不可判定：公开资源（商品、文章）按 id 直取是合法的',
      '只判 where 体内是否带归属列；查完再 `assertOwner()` 的写法不可见，需列入 `ownershipReviewed`',
      '不判嵌套关联（`include: { order: true }`）是否越权',
    ],
  impact: '把请求里的 id 换成别人的就能读到别人的数据；功能测试永远绿（测的是自己的数据）',
  provenance: "外部试点 A 的多租户盘点 + 外部试点 B（2026-10）的权限矩阵回填（数据库 RLS 之外的应用层归属校验缺口）",
  applies(rel) {
    return isRouteFile(rel)
  },
  analyze(src, rel, ctx: RuleCtx): RawHit[] {
    const reviewed = (ctx.options.ownershipReviewed ?? []) as string[]
    if (reviewed.includes(rel)) return []

    const code = stripComments(src)
    if (!FROM_REQUEST.test(code)) return []

    const hits: RawHit[] = []
    let m: RegExpExecArray | null
    FIND_RE.lastIndex = 0
    while ((m = FIND_RE.exec(code)) !== null) {
      const whereBody = m[1]
      const fields = whereBody
        .split(',')
        .map((s) => s.split(':')[0].trim())
        .filter(Boolean)
      const onlyId = fields.length > 0 && fields.every((f) => f === 'id' || f.endsWith('_id') || f === 'id_' )
      if (!onlyId) continue
      if (OWNER_COL.test(whereBody)) continue
      hits.push({
        line: lineOf(src, m.index),
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
      rel: 'app/api/orders/[id]/route.ts',
      src: `export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const order = await prisma.order.findUnique({ where: { id: params.id } })
  return Response.json(order)
}
`,
    },
    {
      name: '带租户收敛（不该报）',
      expect: 'green',
      rel: 'app/api/orders/[id]/route.ts',
      src: `export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const order = await prisma.order.findUnique({ where: { id: params.id, tenantId: session.tenantId } })
  return Response.json(order)
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
