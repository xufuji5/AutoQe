import { prisma } from './client.ts'

export async function createOrder(): Promise<unknown> {
  return prisma.order.create({ data: { status: 'PENDING' } })
}

export async function pay(id: string): Promise<unknown> {
  return prisma.order.update({ where: { id }, data: { status: 'PAID' } })
}

export async function ship(id: string): Promise<unknown> {
  return prisma.order.update({ where: { id }, data: { status: 'SHIPPED' } })
}
