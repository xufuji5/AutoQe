import { authUser } from '@/lib/auth'

export async function GET(req: Request) {
  const auth = await authUser(req)
  if (auth.error) return auth.error
  return Response.json({ ok: true })
}
