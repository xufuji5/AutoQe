type Args = Record<string, unknown>

/** 示例仓的最小 Prisma 替身：只为让守卫有可解析的调用形状 */
export const prisma = {
  order: {
    create: async (_args: Args): Promise<unknown> => ({}),
    update: async (_args: Args): Promise<unknown> => ({}),
    findMany: async (_args: Args): Promise<Array<Record<string, unknown>>> => [],
  },
}
