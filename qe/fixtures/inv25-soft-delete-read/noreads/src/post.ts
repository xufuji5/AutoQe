import { prisma } from './client.ts'

// 只有写点，没有任何读点：守卫应报 SOFTDELETE_ZERO_READS（空集恒真不是绿）
export async function createPost(title: string) {
  return prisma.post.create({ data: { title } })
}
