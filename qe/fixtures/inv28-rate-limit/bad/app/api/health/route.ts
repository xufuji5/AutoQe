// GET-only 入口不判（读入口限流未纳入射程）
export async function GET() {
  return Response.json({ ok: true })
}
