import * as store from './store'

export async function POST(request: Request) {
  const session = await getServerSession()
  const body = await request.json()
  const parsed = z.object({ id: z.string() }).safeParse(body)
  if (!parsed.success) return new Response('bad', { status: 400 })
  // 命名空间导入：`store.touch` 静态不可解，入口体本身看不到写 → 不得因此判为只读
  return store.touch(parsed.data.id)
}
