type Args = Record<string, unknown>

export const prisma = {
  note: {
    create: async (_args: Args): Promise<unknown> => ({}),
  },
  $executeRawUnsafe: async (_q: string, ..._v: unknown[]): Promise<number> => 0,
}
