'use server'

import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

// 合法形态：'use server' 模块是 RPC 边界，客户端只能拿到可调用桩。
export async function saveNote(): Promise<number> {
  return (await db.note.count()) as number
}
