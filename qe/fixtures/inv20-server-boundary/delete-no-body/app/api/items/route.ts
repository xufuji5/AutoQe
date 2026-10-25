import { requireUser } from '@/lib/auth'

// 好样本：DELETE 不读请求体，没有输入可供 schema 校验。
// 旧判据按方法一律要求校验，会把它报成 ENTRY_NO_VALIDATE。
export async function DELETE(request: Request): Promise<Response> {
  const user = await requireUser()
  const id = new URL(request.url).searchParams.get('id')
  return Response.json({ deleted: id, by: user.id })
}
