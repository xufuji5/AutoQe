'use client'

import type { PrismaClient } from '@prisma/client'
import { Button } from './button.tsx'

export function Panel(props: { db: PrismaClient }): string {
  return Button() + String(props.db)
}
