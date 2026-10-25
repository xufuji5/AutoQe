import { z } from 'zod'
import { requireUser } from '@/lib/auth'

const pingSchema = z.object({ client: z.string() })

/** 匿名能力发现（等价 MCP GET）：不含任何业务数据 */
export async function GET(): Promise<Response> {
  return Response.json({ name: 'sample', tools: [] })
}

export async function POST(request: Request): Promise<Response> {
  await requireUser()
  const body = pingSchema.parse(await request.json())
  const idempotencyKey = request.headers.get('Idempotency-Key')
  if (!idempotencyKey) return Response.json({ error: 'MISSING_KEY' }, { status: 400 })
  return Response.json({ data: body })
}
