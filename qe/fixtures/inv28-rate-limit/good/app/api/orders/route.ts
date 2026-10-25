import { rateLimit } from './limit.ts'

export async function POST(req: Request) {
  await rateLimit(req)
  return Response.json({ ok: true })
}
