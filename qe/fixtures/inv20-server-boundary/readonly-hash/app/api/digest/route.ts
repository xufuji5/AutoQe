import { createHash } from 'node:crypto'

function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export async function POST(request: Request) {
  const session = await getServerSession()
  const body = await request.json()
  const parsed = z.object({ name: z.string() }).safeParse(body)
  if (!parsed.success) return new Response('bad', { status: 400 })
  // 只读出口：`$executeRaw` 只设 RLS 上下文（SELECT），`createHash().update()` 是摘要计算，两者都不是库写
  await db.$executeRaw`SELECT set_config('app.current_tenant', ${parsed.data.name}, true)`
  const digest = sha256Of(Buffer.from(parsed.data.name))
  const rows = await db.exportLedger.findMany({ where: { digest } })
  return new Response(JSON.stringify(rows))
}
