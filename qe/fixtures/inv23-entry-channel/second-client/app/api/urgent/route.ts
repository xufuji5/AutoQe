export async function POST(request: Request): Promise<Response> {
  const body = await request.json()
  return Response.json({ ok: Boolean(body) })
}
