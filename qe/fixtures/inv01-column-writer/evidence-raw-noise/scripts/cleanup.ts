import { prisma } from '../src/client.ts'

/**
 * 坏样本（对旧判据）：evidenceRoots 里的造数脚本按动态表名循环删除，
 * 归属不到任何模型。旧判据把它报成「应用面写入覆盖未知」候选（warn），
 * 让每个验收脚本都刷一条待人工复核。
 *
 * 新判据：可归属的写点照常计入覆盖未知；归属不到模型的**证据面**写点不出候选。
 */
export async function purge(tenantId: string, tables: string[]): Promise<void> {
  for (const t of tables) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${t} WHERE tenant_id = $1::uuid`, tenantId)
  }
}
