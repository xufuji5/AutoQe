type Args = Record<string, unknown>

export const prisma = {
  note: {
    create: async (_args: Args): Promise<unknown> => ({}),
  },
  ghost: {
    // 只读不写：整表没有任何写点
    findMany: async (_args?: Args): Promise<unknown[]> => [],
  },
}
