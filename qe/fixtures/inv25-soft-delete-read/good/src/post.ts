import { prisma } from './client.ts'

export async function listPosts() {
  return prisma.post.findMany({ where: { deletedAt: null } })
}

export async function getPost(id: string) {
  return prisma.post.findUnique({ where: { id, deletedAt: null } })
}

export async function countPosts() {
  return prisma.post.count({ where: { deletedAt: null } })
}
