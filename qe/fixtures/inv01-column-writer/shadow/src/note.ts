import { prisma } from './client.ts'

// 坏样本（对旧判据）：同一个文件里两个函数各有一个 `const identity`。
// 平铺「名字 → 表达式」的 Map 会被后一个覆盖，于是前一个写点被解析成后一个的字段，
// phone / adminName 被误判零写入。按引用位置取最近声明才是对的。
export async function first(): Promise<unknown> {
  const identity = { phone: '13800000000', adminName: '张三' }
  return prisma.profile.create({ data: identity })
}

export async function second(): Promise<unknown> {
  const identity = { blockedNote: 'not-a-column' }
  return prisma.profile.update({ where: { id: 'x' }, data: identity })
}
