import { prisma } from './client.ts'

// 好样本：写入值先放在本地 const 里、或经展开传入 —— 旧判据只看对象字面量，
// 会把这里的 title/body 判成「零写入」。
const createData = { title: 'a', body: 'b' }

export async function createNote(): Promise<unknown> {
  return prisma.note.create({ data: createData })
}

const patch = { body: 'c' }

export async function updateNote(id: string): Promise<unknown> {
  return prisma.note.update({ where: { id }, data: { ...patch } })
}
