// 坏样本（对旧判据）：这里只在注释里提到服务端实现（new PrismaClient / @prisma/client），
// 实际代码没有任何服务端依赖。旧判据直接匹配原文 → 假红；新判据先剥注释再判代码面。
// 真实服务端会 new PrismaClient()，本样本刻意只保留文字描述。
export function serverValue(): string {
  return 'ok'
}
