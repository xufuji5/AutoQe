export const prisma = {
  account: {
    // 读点存在，写点由依赖（PrismaAdapter）在运行期完成，静态不可见
    findUnique: async (_args?: unknown): Promise<unknown> => null,
  },
}
