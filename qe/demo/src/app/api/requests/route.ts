import { z } from 'zod'

const requestSchema = z.object({ amountCents: z.number().int().positive() })

async function requireUser(): Promise<{ id: string }> {
  return { id: 'demo-user' }
}

export async function POST(request: Request): Promise<Response> {
  const user = await requireUser()
  const body = requestSchema.parse(await request.json())
  const idempotencyKey = request.headers.get('Idempotency-Key')
  if (!idempotencyKey) return Response.json({ error: 'MISSING_KEY' }, { status: 400 })
  return Response.json({ owner: user.id, body })
}
