import { prisma } from './client.ts'

// 坏样本：schema 有 body 列，但全仓没有任何写点（活表死列）
export async function createNote(title: string): Promise<unknown> {
  return prisma.note.create({ data: { title } })
}

export async function updateNote(id: string, title: string): Promise<unknown> {
  return prisma.note.update({ where: { id }, data: { title } })
}
