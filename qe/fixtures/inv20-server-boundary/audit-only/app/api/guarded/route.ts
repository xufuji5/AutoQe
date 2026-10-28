import { checkAccess } from './guard'
import { tenantRead } from './store'

export async function POST(request: Request) {
  const session = await getServerSession()
  const body = await request.json()
  const parsed = z.object({ batchId: z.string() }).safeParse(body)
  if (!parsed.success) return new Response('bad', { status: 400 })
  // 只读出口 + 权限校验：射程内唯一的 DB 写是 checkAccess 拒绝路径的留痕（auditEvent），
  // 不是业务写 —— 必须判 audit-trace，不许报成「双提交会真落两份」
  checkAccess(session.user, parsed.data.batchId)
  const rows = await tenantRead(session, (tx) => tx.batch.findMany({ where: { id: parsed.data.batchId } }))
  return new Response(JSON.stringify(rows))
}
