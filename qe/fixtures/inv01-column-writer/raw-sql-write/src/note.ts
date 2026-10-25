import { prisma } from './client.ts'

// 好样本（对旧判据）：title/body 由原生 SQL 写入，Prisma Client 的 data 键里看不到。
// 新判据按「DML + 表名」把该表标成写入覆盖未知（warn），不判死列。
export async function createNote(title: string, body: string): Promise<number> {
  return prisma.$executeRaw`INSERT INTO "Note" ("id", "title", "body") VALUES (gen_random_uuid(), ${title}, ${body})`
}
