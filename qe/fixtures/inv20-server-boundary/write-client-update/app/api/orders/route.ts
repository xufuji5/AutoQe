export async function POST(request: Request) {
  const session = await getServerSession()
  const body = await request.json()
  const parsed = z.object({ id: z.string() }).safeParse(body)
  if (!parsed.success) return new Response('bad', { status: 400 })
  // 反证：`<client>.<model>.update(` 是库写，剥非库写时绝不能一起剥掉
  await prisma.order.update({ where: { id: parsed.data.id }, data: { status: 'PAID' } })
  return new Response('ok')
}
