import { z } from 'zod'
import { requireUser } from '@/lib/auth'

const orderSchema = z.object({ totalCents: z.number().int().positive() })

// 同文件 helper：校验写在入口函数体外面。
// 旧判据只扫入口函数体字面量，会把它报成「无校验」。
async function validateOrder(payload: unknown): Promise<{ totalCents: number }> {
  return orderSchema.parse(payload)
}

export async function POST(request: Request): Promise<Response> {
  await requireUser()
  const body = await validateOrder(await request.json())
  const idempotencyKey = request.headers.get('Idempotency-Key')
  if (!idempotencyKey) return Response.json({ error: 'MISSING_KEY' }, { status: 400 })
  return Response.json({ body })
}
