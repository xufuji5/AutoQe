import { prisma } from './client.ts'

declare function buildWhere(): Record<string, unknown>

// 过滤条件由函数返回值构造：静态不可证是否带 deletedAt → warn 候选
export async function dynamicPosts() {
  return prisma.post.findMany({ where: buildWhere() })
}
