type Args = Record<string, unknown>

const note = {
  create: async (_args: Args): Promise<unknown> => ({}),
}

export async function getClient(): Promise<{ note: typeof note }> {
  return { note }
}
