import { getClient } from './client.ts'

// 坏样本（对旧判据）：客户端由函数返回，接收者是 `(await getClient())`，
// 旧判据只认 `prisma.` 标识符 → 整张表被判零写入。
export async function createNote(): Promise<unknown> {
  return (await getClient()).note.create({ data: { title: 'a', body: 'b' } })
}
