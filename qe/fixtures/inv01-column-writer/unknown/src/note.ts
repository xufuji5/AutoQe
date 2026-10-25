import { prisma } from './client.ts'

// 坏样本（对旧判据）：data 是函数参数，静态追不到字段。
// 新判据只降级为「覆盖未知」warn，不判死列 —— 判死列会逼人写假字段。
export async function createNote(data: { title: string; body: string }): Promise<unknown> {
  return prisma.note.create({ data })
}
