import { createAccount } from './service'

export async function POST(request: Request) {
  const session = await getServerSession()
  const body = await request.json()
  const parsed = z.object({ name: z.string() }).safeParse(body)
  if (!parsed.success) return new Response('bad', { status: 400 })
  return createAccount(parsed.data)
}
