import { prisma } from './client.ts'

export async function createRequest(): Promise<unknown> {
  return prisma.request.create({ data: { status: 'DRAFT' } })
}

export async function markSubmitted(id: string): Promise<unknown> {
  return prisma.request.update({ where: { id }, data: { status: 'SUBMITTED' } })
}

// 坏样本：APPROVED 只在读侧出现，CLOSED 全仓零出现
export async function findApproved(): Promise<unknown> {
  return prisma.request.findMany({ where: { status: 'APPROVED' } })
}
