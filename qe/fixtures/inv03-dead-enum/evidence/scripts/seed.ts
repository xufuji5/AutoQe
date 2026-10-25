import { prisma } from '../src/client.ts'

// 证据目录里的写点：脚本确实会产生这两个状态。
// 旧判据不扫 evidenceRoots，会把它们报成 NO_WRITE_PATH。
export async function seed(): Promise<unknown> {
  await prisma.request.create({ data: { status: 'DRAFT' } })
  return prisma.request.update({ where: { id: 'seed' }, data: { status: 'SUBMITTED' } })
}
