import { prisma } from './client.ts'

// Note 有完整写点；Ghost 全表只读不写 —— 应聚合为一条 MODEL_UNUSED，而不是逐字段刷
export async function createNote(title: string): Promise<unknown> {
  return prisma.note.create({ data: { title } })
}

export async function listGhosts(): Promise<unknown[]> {
  return prisma.ghost.findMany({})
}
