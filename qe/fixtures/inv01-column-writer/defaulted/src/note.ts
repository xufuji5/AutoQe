import { prisma } from './client.ts'

// 活列但有 DB 默认值：occurredAt 由 @default(now()) 产出，业务代码不必显式写。
// 旧判据只认 Prisma data 键，会把它报成「活表死列」。
export async function createEvent(title: string): Promise<unknown> {
  return prisma.event.create({ data: { title } })
}
