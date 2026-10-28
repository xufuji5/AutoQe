export async function POST(request: Request): Promise<Response> {
  const body = await request.json()
  // 坏样本：裸 create 无幂等，同一请求重放会落两行
  await db.order.create({ data: body })
  return Response.json({ received: body })
}
