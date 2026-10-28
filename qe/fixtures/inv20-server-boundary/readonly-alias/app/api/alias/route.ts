import { readOnly } from './store'

export async function POST(request: Request) {
  const session = await getServerSession()
  const body = await request.json()
  const parsed = z.object({ tenantId: z.string() }).safeParse(body)
  if (!parsed.success) return new Response('bad', { status: 400 })
  // 只读出口：走的是导出别名（`export const readOnly = readRows`），应当可判只读豁免
  const rows = await readOnly({ batch: { findMany: async () => [] } }, parsed.data.tenantId)
  return new Response(JSON.stringify(rows))
}
