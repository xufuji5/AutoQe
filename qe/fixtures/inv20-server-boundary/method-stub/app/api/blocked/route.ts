/**
 * 405 方法桩：Next.js 项目常见写法（本路由只接受 POST，GET 显式拒绝）。
 * 响应与调用者身份无关 —— 没有请求输入，鉴权在它身上没有可守的东西。
 */
export function GET() {
  return new Response(null, { status: 405, headers: { Allow: 'POST' } })
}
