// 坏样本：变更型入口没有任何已登记限流形态
export async function POST(req: Request) {
  const body = await req.json()
  return Response.json({ ok: true, body })
}
