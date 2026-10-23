import path from 'node:path'
import { readText, walkFiles } from './fs.ts'
import { defaultSourceExtensions } from './config.ts'
import type { QeConfig } from './config.ts'

export interface PatternHit {
  file: string
  line: number
}

export interface PatternResult {
  matched: boolean
  files: number
  hits: PatternHit[]
  regexError?: string
}

/** 在指定根目录内做一次带行号的正则扫描；空集不返回 matched=true（D1） */
export async function findPattern(
  root: string,
  roots: string[],
  pattern: string,
  config: QeConfig,
): Promise<PatternResult> {
  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch (e) {
    return { matched: false, files: 0, hits: [], regexError: (e as Error).message }
  }
  const extensions = config.source.extensions.length ? config.source.extensions : defaultSourceExtensions
  const batches = await Promise.all(
    roots.map((dir) => walkFiles(root, dir, { ignore: config.ignore, ext: extensions })),
  )
  const files = [...new Set(batches.flat())].sort()
  const hits: PatternHit[] = []
  for (const file of files) {
    const text = await readText(file)
    text.split(/\r?\n/).forEach((line, idx) => {
      if (regex.test(line)) hits.push({ file: path.relative(root, file).split(path.sep).join('/'), line: idx + 1 })
    })
  }
  return { matched: hits.length > 0, files: files.length, hits }
}
