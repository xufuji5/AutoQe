'use client'

import { PrismaClient } from '@prisma/client'
import { db } from './db.ts'

export function Panel(): string {
  return String(PrismaClient) + String(db)
}
