'use client'

// 坏样本：别名导入在旧判据里解析不到目标文件，于是整条接缝泄漏被判绿。
import { db } from '@/lib/db'

export function Card(): string {
  return String(db)
}
