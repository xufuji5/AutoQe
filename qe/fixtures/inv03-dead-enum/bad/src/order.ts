import { prisma } from './client.ts'

export async function createOrder(): Promise<unknown> {
  return prisma.order.create({ data: { status: 'PENDING' } })
}

export async function pay(id: string): Promise<unknown> {
  return prisma.order.update({ where: { id }, data: { status: 'PAID' } })
}

// 坏样本：SHIPPED 只在读侧出现，CANCELLED 全仓零出现
export async function findShipped(): Promise<unknown> {
  return prisma.order.findMany({ where: { status: 'SHIPPED' } })
}
