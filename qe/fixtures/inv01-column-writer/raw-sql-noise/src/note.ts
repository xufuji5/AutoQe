import { prisma } from './client.ts'

/**
 * 坏样本（对旧判据）：下面每一种形态都**不是**写点，但旧判据按「命中点之后 600 字符窗口」
 * 取词，会把注释、字符串素材与只读 `$queryRaw` 都算成原生写：
 *   prisma.$executeRawUnsafe(`DELETE FROM "Note"`)
 *   prisma.$queryRaw`SELECT …` 之后的字符串里只要出现 UPDATE / DELETE 就被并进窗口。
 *
 * 新判据要求「token 在代码面」且「DML 出现在该调用的实参里」，本文件应当判绿。
 */
export async function createNote(title: string, body: string): Promise<unknown> {
  // 行注释里的写字样：prisma.$executeRawUnsafe(`DELETE FROM "Note"`)
  const snippet = 'prisma.$executeRawUnsafe(`DELETE FROM "Note"`)'
  const template = `prisma.$executeRaw\`DELETE FROM "Note"\``
  const rows = await prisma.$queryRaw`SELECT id, title, body FROM "Note"`
  const hint = "UPDATE Note SET title = 'x'"
  void snippet
  void template
  void rows
  void hint
  return prisma.note.create({ data: { title, body } })
}
