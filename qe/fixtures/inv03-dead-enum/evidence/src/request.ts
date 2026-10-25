import { prisma } from './client.ts'

// 应用面只读：产生路径在 scripts/seed.ts（证据目录）里。
export async function listRequests(): Promise<unknown> {
  return prisma.request.findMany({ where: { status: 'DRAFT' } })
}
