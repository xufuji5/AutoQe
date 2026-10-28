import { createVerify } from 'node:crypto'

/** 模块级集合：声明在函数体之外，`.delete(` 仍不是库写 */
const breakers = new Map<string, number>()

function isBroken(key: string): boolean {
  const until = breakers.get(key)
  if (!until) return false
  if (Date.now() >= until) {
    breakers.delete(key)
    return false
  }
  return true
}

export async function POST(request: Request) {
  const session = await getServerSession()
  const body = await request.json()
  const parsed = z.object({ sig: z.string() }).safeParse(body)
  if (!parsed.success) return new Response('bad', { status: 400 })
  // 只读出口：签名校验是纯计算；Map/Headers 是集合键操作，都不是库写
  // 反证：注释里出现 `.update(` / `.delete(` 也只是文字，不算写痕迹
  const verifier = createVerify('RSA-SHA256')
  const signatureOk = verifier.update(parsed.data.sig).verify(publicKey, parsed.data.sig, 'base64')
  const cache = new Map<string, number>()
  cache.set('hits', 1)
  cache.delete('hits')
  const headers = new Headers(request.headers)
  headers.delete('x-internal')
  const broken = isBroken(parsed.data.sig)
  const rows = await db.exportLedger.findMany({ where: { signatureOk, broken } })
  return new Response(JSON.stringify(rows))
}
