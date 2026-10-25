import { prisma } from './client.ts'

// 坏样本 1：无参调用＝全表读（含已删行）
export async function allPosts() {
  return prisma.post.findMany()
}

// 坏样本 2：全字面量 where 但没有 deletedAt
export async function publishedPosts() {
  return prisma.post.findMany({ where: { published: true } })
}

// 坏样本 3：按 id 读没带软删谓词（已删行照样被读出）
export async function getPost(id: string) {
  return prisma.post.findUnique({ where: { id } })
}
