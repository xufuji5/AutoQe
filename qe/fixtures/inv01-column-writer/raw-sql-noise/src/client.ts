type Args = Record<string, unknown>

export const prisma = {
  note: {
    create: async (_args: Args): Promise<unknown> => ({}),
  },
  // 只读原生调用：`$queryRaw` 里是 SELECT，不是写点
  $queryRaw: async (_q: TemplateStringsArray, ..._v: unknown[]): Promise<unknown[]> => [],
  $executeRaw: async (_q: TemplateStringsArray, ..._v: unknown[]): Promise<number> => 0,
}
