import { prisma } from './client.ts'

export async function createNote(title: string, body: string): Promise<unknown> {
  return prisma.note.create({ data: { title, body } })
}
