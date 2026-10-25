import { prisma } from './client.ts'

// body 列没有任何写点，也没出现在任何 .tsx 里：冗余列（提示档），不是用户可见的空栏
export async function createNote(title: string): Promise<unknown> {
  return prisma.note.create({ data: { title } })
}
