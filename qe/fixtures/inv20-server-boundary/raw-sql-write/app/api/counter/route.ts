export async function POST(request: Request) {
  const session = await getServerSession()
  const body = await request.json()
  const parsed = z.object({ n: z.number() }).safeParse(body)
  if (!parsed.success) return new Response('bad', { status: 400 })
  // 真·raw SQL 写（自增式，双提交会重复累加）：`$executeRaw` 里带 DML 必须仍算写
  await db.$executeRaw`UPDATE counter SET n = n + ${parsed.data.n} WHERE id = 1`
  return new Response('ok')
}
