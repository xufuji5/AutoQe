import { prisma } from './client.ts'

export async function createRequest(): Promise<unknown> {
  return prisma.request.create({ data: { status: 'DRAFT' } })
}

export async function markSubmitted(id: string): Promise<unknown> {
  return prisma.request.update({ where: { id }, data: { status: 'SUBMITTED' } })
}

export async function approve(id: string): Promise<unknown> {
  return prisma.request.update({ where: { id }, data: { status: 'APPROVED' } })
}
