export async function POST(request: Request) {
  const session = await getServerSession()
  const body = await request.json()
  const parsed = z.object({ take: z.number().optional() }).safeParse(body)
  if (!parsed.success) return new Response('bad', { status: 400 })
  // 只读出口：POST 只承载查询载荷，不产生任何写入
  const rows = await db.exportLedger.findMany({ take: parsed.data.take })
  return new Response(JSON.stringify(rows))
}
