import { requireUser } from '@/lib/auth'

// 坏样本：直接 request.json() 进业务，没有任何 schema 校验，也没有可追的 helper。
// 解析请求体不是校验——旧词表里的 `.parse(` 会被 `JSON.parse(` 命中而假绿。
export async function POST(request: Request): Promise<Response> {
  await requireUser()
  const body = await request.json()
  return Response.json({ received: body })
}
