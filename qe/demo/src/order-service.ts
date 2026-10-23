import { prisma } from './client.ts'

export async function placeOrder(input: {
  tenantId: string
  totalCents: number
  buyerNote?: string
}): Promise<unknown> {
  return prisma.order.create({
    data: {
      tenantId: input.tenantId,
      status: 'PENDING',
      totalCents: input.totalCents,
      buyerNote: input.buyerNote,
    },
  })
}

export async function pay(id: string): Promise<unknown> {
  return prisma.order.update({ where: { id }, data: { status: 'PAID' } })
}

export async function ship(id: string): Promise<unknown> {
  return prisma.order.update({ where: { id }, data: { status: 'SHIPPED' } })
}

export async function complete(id: string): Promise<unknown> {
  return prisma.order.update({ where: { id }, data: { status: 'COMPLETED' } })
}

export async function archive(id: string): Promise<unknown> {
  return prisma.order.update({ where: { id }, data: { archivedAt: new Date() } })
}

export async function listOrders(tenantId: string): Promise<Array<Record<string, unknown>>> {
  return prisma.order.findMany({ where: { tenantId } })
}
