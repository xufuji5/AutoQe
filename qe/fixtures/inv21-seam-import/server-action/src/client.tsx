'use client'

// 合法样本：导入服务端动作模块不是接缝泄漏（RPC 边界，客户端只拿桩）。
import { saveNote } from './action.ts'

export function Panel(): string {
  return String(saveNote)
}
