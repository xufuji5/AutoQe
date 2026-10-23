import { prisma } from './client.ts'

export async function createNote(title: string, body: string): Promise<unknown> {
  return prisma.note.create({ data: { title, body } })
}

// 坏样本：select 只取 id，title/body 有写无读
export async function listNotes(): Promise<Array<Record<string, unknown>>> {
  return prisma.note.findMany({ select: { id: true } })
}
