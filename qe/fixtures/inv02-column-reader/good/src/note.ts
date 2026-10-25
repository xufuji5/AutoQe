import { prisma } from './client.ts'

export async function createNote(title: string, body: string): Promise<unknown> {
  return prisma.note.create({ data: { title, body } })
}

// 无 select：隐式全列读取
export async function listNotes(): Promise<Array<Record<string, unknown>>> {
  return prisma.note.findMany({})
}
