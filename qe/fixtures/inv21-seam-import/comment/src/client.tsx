'use client'

import { serverValue } from './server.ts'

export function Panel(): string {
  return serverValue()
}
