import { requireUser } from '@/lib/auth'

// 好样本：动作型 POST 不读请求体（只触发一次作业），没有输入可供校验。
// 旧判据按 mutation 方法一律要求 schema 校验，目标仓里 28 个这类入口全被报红。
export async function POST(request: Request): Promise<Response> {
  await requireUser()
  const idempotencyKey = request.headers.get('Idempotency-Key')
  if (!idempotencyKey) return Response.json({ error: 'MISSING_KEY' }, { status: 400 })
  return Response.json({ queued: true })
}
