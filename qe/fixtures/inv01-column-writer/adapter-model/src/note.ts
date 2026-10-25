import { prisma } from './client.ts'

// 依赖适配器模型：Account 由 @auth/prisma-adapter 在运行期写入（createUser/updateUser），
// 源码里看不到 data 键。field: "*" 的模型级豁免（理由必填）应让本用例全绿。
export async function findAccount(userId: string): Promise<unknown> {
  return prisma.account.findUnique({ where: { userId } })
}
