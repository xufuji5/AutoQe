import { prisma } from './client.ts'

// 坏样本（对旧判据）：值既被读、又作为映射表键出现（可能经常量间接产生），
// 旧判据只要见到读就判 NO_WRITE_PATH；新判据降级为 AMBIGUOUS_PATH warn。
export const STATE_LABEL = { PENDING: '待核验' }

export async function findPending(): Promise<unknown> {
  return prisma.cert.findMany({ where: { state: 'PENDING' } })
}
