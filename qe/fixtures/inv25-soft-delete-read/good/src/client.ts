type Args = Record<string, unknown>

export const prisma = {
  post: {
    create: async (_args: Args): Promise<unknown> => ({}),
    findMany: async (_args?: Args): Promise<Array<Record<string, unknown>>> => [],
    findUnique: async (_args: Args): Promise<unknown> => null,
    count: async (_args?: Args): Promise<number> => 0,
  },
}
