import { z } from 'zod'
import { requireUser } from '@/lib/auth'

const orderSchema = z.object({ totalCents: z.number().int().positive() })

export async function POST(request: Request): Promise<Response> {
  const user = await requireUser()
  const body = orderSchema.parse(await request.json())
  const idempotencyKey = request.headers.get('Idempotency-Key')
  if (!idempotencyKey) return Response.json({ error: 'MISSING_KEY' }, { status: 400 })
  return Response.json({ owner: user.id, body })
}

export async function GET(): Promise<Response> {
  await requireUser()
  return Response.json([])
}
