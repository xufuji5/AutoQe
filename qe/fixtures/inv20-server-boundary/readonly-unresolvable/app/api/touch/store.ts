export async function touch(id: string) {
  await prisma.auditTouch.create({ data: { id } })
  return new Response('ok')
}
