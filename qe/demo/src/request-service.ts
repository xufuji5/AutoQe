import { prisma } from './client.ts'

export async function submitRequest(input: {
  tenantId: string
  amountCents: number
  note?: string
}): Promise<unknown> {
  return prisma.request.create({
    data: {
      tenantId: input.tenantId,
      status: 'DRAFT',
      amountCents: input.amountCents,
      note: input.note,
    },
  })
}

export async function markSubmitted(id: string): Promise<unknown> {
  return prisma.request.update({ where: { id }, data: { status: 'SUBMITTED' } })
}

export async function approve(id: string): Promise<unknown> {
  return prisma.request.update({ where: { id }, data: { status: 'APPROVED' } })
}

export async function close(id: string): Promise<unknown> {
  return prisma.request.update({ where: { id }, data: { status: 'CLOSED' } })
}

export async function archive(id: string): Promise<unknown> {
  return prisma.request.update({ where: { id }, data: { archivedAt: new Date() } })
}

export async function listRequests(tenantId: string): Promise<Array<Record<string, unknown>>> {
  return prisma.request.findMany({ where: { tenantId } })
}
