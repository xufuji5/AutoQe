function cronSecretMatches(req: Request): boolean {
  const secret = req.headers.get('x-cron-secret')
  return Boolean(secret) && secret === process.env.CRON_SECRET
}

export async function GET(req: Request) {
  if (!cronSecretMatches(req)) return new Response('unauthorized', { status: 401 })
  return Response.json({ ok: true })
}
