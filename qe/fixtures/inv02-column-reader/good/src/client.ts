type Args = Record<string, unknown>

export const prisma = {
  note: {
    create: async (_args: Args): Promise<unknown> => ({}),
    findMany: async (_args: Args): Promise<Array<Record<string, unknown>>> => [],
  },
}
