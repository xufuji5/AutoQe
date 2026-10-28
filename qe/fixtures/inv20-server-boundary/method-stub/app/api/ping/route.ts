/**
 * 静态探活面：返回编译期常量，不读任何请求字段（与服务端 cron 探活同形态）。
 */
export function GET() {
  return Response.json({ ok: true, message: 'ping' })
}
