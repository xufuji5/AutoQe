export async function GET(req: Request) {
  const self = await resolveSelfIdSet(req)
  if (!self.selfId) return Response.json({ error: 'AUTH_REQUIRED' }, { status: 401 })
  return Response.json({ ok: true })
}
