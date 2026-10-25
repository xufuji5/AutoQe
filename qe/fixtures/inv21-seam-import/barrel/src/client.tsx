'use client'

// 坏样本：barrel 再导出链把服务端实现带进客户端；旧判据只看直接导入目标 → 判绿。
import { serverValue } from './ui.ts'

export function Panel(): string {
  return serverValue()
}
