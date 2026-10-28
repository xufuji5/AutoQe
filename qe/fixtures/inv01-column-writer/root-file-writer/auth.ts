import { prisma } from './src/client.ts'

/**
 * NextAuth v5 约定：auth.ts 放仓根，不在任何 source.roots 目录里。
 * 唯一的 title/body 写点在这里 —— 旧引擎（只认 roots 目录）会把这两列判成零写入。
 * 反证样本：source.files 不声明本文件时，本 fixture 必须红（零写入判死列）。
 */
export async function saveNote(id: string, title: string, body: string): Promise<void> {
  await prisma.note.upsert({
    where: { id },
    create: { id, title, body },
    update: { body },
  })
}
