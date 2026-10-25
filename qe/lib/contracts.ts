import path from 'node:path'
import { readTextSafe } from './fs.ts'
import type { QeConfig } from './config.ts'

export interface PromiseEntry {
  id: string
  claim: string
  source: { file: string; contains?: string }
  backing: { roots: string[]; pattern: string }
}

export interface GateEntry {
  id: string
  reject: string
  server: { roots: string[]; pattern: string }
  control: { roots: string[]; pattern: string }
}

export interface Contracts {
  promises: PromiseEntry[]
  gates: GateEntry[]
  /** 错误码登记（INV-CORE-10）：在用码必有抛错点；未登记而抛出的码由 inv26 反向对拍 */
  errorCatalog: string[]
}

export async function loadContracts(root: string, config: QeConfig): Promise<Contracts | null> {
  const text = await readTextSafe(path.join(root, config.contracts))
  if (text === null) return null
  const parsed = JSON.parse(text) as Partial<Contracts>
  return {
    promises: Array.isArray(parsed.promises) ? parsed.promises : [],
    gates: Array.isArray(parsed.gates) ? parsed.gates : [],
    errorCatalog: Array.isArray(parsed.errorCatalog) ? parsed.errorCatalog : [],
  }
}
