type Args = Record<string, unknown>

export const prisma = {
  post: {
    findMany: async (_args?: Args): Promise<Array<Record<string, unknown>>> => [],
    findUnique: async (_args: Args): Promise<unknown> => null,
  },
}
