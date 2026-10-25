import { prisma } from './client.ts'

// 坏样本（对旧判据）：data 是函数参数，status 的取值静态追不到。
// 旧判据只看到读侧就判 NO_WRITE_PATH；新判据降级为「产生路径未知」warn。
export async function updateTicket(id: string, data: { status: string }): Promise<unknown> {
  return prisma.ticket.update({ where: { id }, data })
}

export function matches(status: string): boolean {
  return status === 'OPEN' || status === 'CLOSED'
}
