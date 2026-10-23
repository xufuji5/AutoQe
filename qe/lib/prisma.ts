/**
 * Prisma 适配器：schema 最小解析器 + SchemaProvider 实现。
 * 只依赖与 ORM 无关的 providers 类型；其他栈（DDL / Drizzle / TypeORM）按同构接口另写 provider 即可。
 * 盲区：不支持复杂表达式求值；多行属性按单行处理。
 */

import path from 'node:path'
import { readTextSafe } from './fs.ts'
import type { QeConfig } from './config.ts'
import type {
  SchemaEnum,
  SchemaEnumValue,
  SchemaField,
  SchemaModel,
  SchemaProvider,
  SchemaSnapshot,
} from './providers.ts'

const BLOCK_START = /^\s*(model|enum)\s+([A-Za-z_]\w*)\s*\{/
const FIELD = /^\s*([A-Za-z_]\w*)\s+([A-Za-z_][\w.]*)(\[\])?(\?)?\s*(.*)$/

export function parsePrisma(text: string): SchemaSnapshot {
  const lines = text.split(/\r?\n/)
  const modelNames = new Set<string>()

  // 第一趟：先收集 model 名，供关系判定使用
  for (const line of lines) {
    const m = BLOCK_START.exec(line)
    if (m && m[1] === 'model') modelNames.add(m[2])
  }

  const models: SchemaModel[] = []
  const enums: SchemaEnum[] = []
  let current: { kind: 'model' | 'enum'; name: string; line: number; body: string[] } | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!current) {
      const m = BLOCK_START.exec(line)
      if (m) {
        current = { kind: m[1] as 'model' | 'enum', name: m[2], line: i + 1, body: [] }
      }
      continue
    }
    if (/^\s*\}\s*$/.test(line)) {
      finishBlock(current, models, enums, modelNames)
      current = null
      continue
    }
    current.body.push(line)
  }
  if (current) finishBlock(current, models, enums, modelNames)

  return { models, enums }
}

function finishBlock(
  block: { kind: 'model' | 'enum'; name: string; line: number; body: string[] },
  models: SchemaModel[],
  enums: SchemaEnum[],
  modelNames: Set<string>,
): void {
  const offset = block.line
  if (block.kind === 'enum') {
    const values: SchemaEnumValue[] = []
    block.body.forEach((raw, idx) => {
      const line = raw.trim()
      if (!line || line.startsWith('//') || line.startsWith('@@')) return
      const m = /^([A-Za-z_]\w*)/.exec(line)
      if (m) values.push({ name: m[1], line: offset + idx + 1 })
    })
    enums.push({ name: block.name, values, line: block.line })
    return
  }

  let table = block.name
  const fields: SchemaField[] = []
  let pendingComment = ''
  block.body.forEach((raw, idx) => {
    const lineNo = offset + idx + 1
    const trimmed = raw.trim()
    if (!trimmed) return
    if (trimmed.startsWith('///')) {
      pendingComment = (pendingComment ? pendingComment + ' ' : '') + trimmed.replace(/^\/\/\/\s?/, '')
      return
    }
    if (trimmed.startsWith('//')) return
    if (trimmed.startsWith('@@map')) {
      const m = /@@map\("([^"]+)"\)/.exec(trimmed)
      if (m) table = m[1]
      pendingComment = ''
      return
    }
    if (trimmed.startsWith('@@')) {
      pendingComment = ''
      return
    }
    const m = FIELD.exec(raw)
    if (!m) {
      pendingComment = ''
      return
    }
    const [, name, baseType, listMark, optional, rest] = m
    const inlineComment = /\/\/\/\s?(.*)$/.exec(rest)?.[1] ?? ''
    const comment = [pendingComment, inlineComment].filter(Boolean).join(' ').trim()
    pendingComment = ''
    const isList = Boolean(listMark)
    const isRelation = Boolean(rest.includes('@relation')) || modelNames.has(baseType)
    const mapMatch = /@map\("([^"]+)"\)/.exec(rest)
    fields.push({
      name,
      column: mapMatch ? mapMatch[1] : name,
      type: baseType,
      isRelation,
      isList,
      optional: Boolean(optional),
      attrs: rest.trim(),
      comment,
      line: lineNo,
    })
  })

  if (!fields.length) return
  models.push({ name: block.name, table, fields, line: block.line })
}

export const prismaSchemaProvider: SchemaProvider = {
  id: 'prisma',
  async load(root: string, config: QeConfig): Promise<SchemaSnapshot> {
    const file = path.isAbsolute(config.schema.path) ? config.schema.path : path.join(root, config.schema.path)
    const text = await readTextSafe(file)
    if (text === null) {
      throw new Error(`Prisma schema 未找到：${config.schema.path}（路径不对时判据会空集恒真，故直接报错）`)
    }
    const schema = parsePrisma(text)
    if (schema.models.length === 0) {
      throw new Error(`Prisma schema 解析到 0 个 model：${config.schema.path}（读到 0 个不等于没有问题）`)
    }
    return schema
  },
}
