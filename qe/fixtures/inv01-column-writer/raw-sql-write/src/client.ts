export const prisma = {
  // 原生 SQL 写入口：真实写入，但不经过 data 键，旧判据完全看不见。
  $executeRaw: async (_q: TemplateStringsArray, ..._v: unknown[]): Promise<number> => 0,
}
