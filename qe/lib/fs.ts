import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export interface WalkOptions {
  ignore: string[]
  ext?: string[]
}

/**
 * 递归枚举文件。忽略规则同时匹配目录名与相对路径前缀。
 * 返回绝对路径，按字典序排序（保证读数可复现）。
 */
export async function walkFiles(root: string, dir: string, opts: WalkOptions): Promise<string[]> {
  const start = path.isAbsolute(dir) ? dir : path.join(root, dir)
  const out: string[] = []

  async function rec(current: string): Promise<void> {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      const rel = path.relative(root, abs).split(path.sep).join('/')
      const ignored = opts.ignore.some((rule) => {
        const clean = rule.replace(/\/+$/, '')
        return entry.name === clean || rel === clean || rel.startsWith(clean + '/')
      })
      if (ignored) continue
      if (entry.isDirectory()) await rec(abs)
      else if (!opts.ext || opts.ext.some((x) => entry.name.endsWith(x))) out.push(abs)
    }
  }

  await rec(start)
  return out.sort()
}

export async function readText(file: string): Promise<string> {
  return readFile(file, 'utf8')
}

export async function readTextSafe(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

export function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/')
}
