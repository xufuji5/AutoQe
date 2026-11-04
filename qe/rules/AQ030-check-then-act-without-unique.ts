/**
 * AQ030 · findFirst + create 竞态：无唯一约束时并发会静默重复。
 *
 * ## 缺陷形态
 *
 * AI 写"先查后建"很自然：
 *   const existing = await prisma.Task.findFirst({ where: { eventId, reason } })
 *   if (!existing) await prisma.Task.create({ data: { eventId, reason } })
 *
 * 但 findFirst 只在单线程里"看不见"，两个并发请求都 findFirst=null → 同时 create → 静默两条。
 * **唯一能原子防重的是 DB 层的 @unique / @@unique**——应用层先查后建是竞态条件。
 *
 * [项目 A] 真实案例：[Model].[method] 原为 findFirst+create，
 * 上线后发现静默重复 → 加 @@unique([eventId, reason]) 换 upsert。
 *
 * ## 判据
 *
 * 源码级（正则 + 函数体配平）：同函数体内出现 `prisma.Model.findFirst/findUnique`
 * 和 `prisma.Model.create`（不含 upsert/createMany/update）。
 *
 * schema 交叉（有 schema 时才做）：如果 findFirst 的 where 字段集合已经覆盖了
 * 某个唯一约束 → 放行（那是正确的 find-or-fallback 模式）。
 *
 * upsert 放行：upsert 本身就是原子的 find-or-create。
 */

import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { stripComments } from '../lib/code-only.ts'
import { lineOf } from '../lib/rule-helpers.ts'

/** 提取 `prisma.Model.method` 或 `client.Model.method` 形态的 Prisma 调用 */
const PRISMA_CALL_RE = /(prisma|db|client|tx)\.([A-Za-z_][\w]*)\.(findFirst|findUnique|findMany|create|upsert|createMany|update|delete)\b/g

/** 从 `findFirst/findUnique({ where: { a, b, c } })` 里粗提取 where 字段名 */
function extractWhereFields(src: string, callPos: number): string[] {
  // 从 callPos 往后找 (，然后配平括号，找 where: { ... } 里的顶层标识符
  const parenOpen = src.indexOf('(', callPos)
  if (parenOpen < 0) return []
  let depth = 0
  let i = parenOpen
  let parenClose = -1
  while (i < src.length) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
    else if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) { parenClose = i; break }
    }
    i++
  }
  if (parenClose < 0) return []
  const callBody = src.slice(parenOpen, parenClose)

  // 找 where: { ... }
  const whereMatch = callBody.match(/\bwhere\s*:\s*\{([^}]*)\}/)
  if (!whereMatch) return []
  const inner = whereMatch[1]
  // 提取顶层 key（跳过嵌套对象里的 key）
  const fields: string[] = []
  let braceDepth = 0
  let current = ''
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c === '{') braceDepth++
    else if (c === '}') braceDepth--
    else if (braceDepth === 0) {
      if (/[A-Za-z_]/.test(c) && current === '') current = c
      else if (/[A-Za-z0-9_]/.test(c)) current += c
      else if (current && /[:\s,]/.test(c)) {
        if (current && /[A-Za-z_]/.test(current[0])) fields.push(current)
        current = ''
      }
    }
  }
  if (current && /[A-Za-z_]/.test(current[0])) fields.push(current)
  return fields
}

/** 配平花括号：从 { 的位置找对应的 } */
function findBraceEnd(src: string, openPos: number): number {
  let depth = 0
  let i = openPos
  while (i < src.length) {
    const c = src[i]
    if (c === '`') {
      // 跳过模板串
      i++
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') i += 2
        else i++
      }
    } else if (c === '"' || c === "'") {
      const q = c
      i++
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i += 2
        else i++
      }
    } else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return src.length
}

/** 给定一个位置，找它所在的函数体范围（含 { 和 }） */
function enclosingFunctionBody(src: string, at: number): { start: number; end: number } | null {
  // 向前找 "{"，然后反推是不是函数体开始
  let i = at
  while (i >= 0) {
    if (src[i] === '{') {
      // 检查这个 { 前面几行是不是函数声明
      const before = src.slice(Math.max(0, i - 200), i).trim()
      if (/\b(?:async\s+)?function\s+\w+\s*\([^)]*\)\s*$/.test(before) ||
          /(?:const|let)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*$/.test(before)) {
        return { start: i, end: findBraceEnd(src, i) }
      }
    }
    i--
  }
  return null
}

/** 检查字段集合是否覆盖某个 unique 约束（有 schema 时才调用） */
function coversUnique(fields: string[], uniques: string[]): boolean {
  const fieldSet = new Set(fields.map((f) => f.toLowerCase()))
  for (const u of uniques) {
    const cols = u.split(',').map((c) => c.trim().toLowerCase())
    if (cols.every((c) => fieldSet.has(c))) return true
  }
  return false
}

function isComponentRel(rel: string): boolean {
  return /\.(ts|tsx|js|jsx)$/.test(rel)
}

/** 提取 `prisma.Model.findFirst/findUnique` 里的 where 条件类型（含时间窗口判断） */
function whereIsTimeWindow(src: string, callPos: number): boolean {
  // 从 callPos 往后找 (，配平括号
  const parenOpen = src.indexOf('(', callPos)
  if (parenOpen < 0) return false
  let depth = 0
  let i = parenOpen
  let parenClose = -1
  while (i < src.length) {
    const c = src[i]
    if (c === '`') { i++; while (i < src.length && src[i] !== '`') { if (src[i] === '\\') i += 2; else i++ } }
    else if (c === '"' || c === "'") { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i += 2; else i++ } }
    else if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) { parenClose = i; break } }
    i++
  }
  if (parenClose < 0) return false
  const body = src.slice(parenOpen, parenClose)
  // 判断 where 里有没有 createdAt/updatedAt + gte/lt/gt/lte 组合（频控模式）
  return /createdAt|updatedAt|expiresAt/.test(body) && /\b(gte|gt|lt|lte)\b/.test(body)
}

export const aq30 = toGuard({
  id: 'aq30',
  title: '先查后建无唯一约束 → 并发重复风险',
  invariants: ['INV-DB-01'],
  code: 'AQ030_CHECK_THEN_ACT_NO_UNIQUE',
  level: 'warn',
  impact:
    '两个并发请求同时 findFirst 返回 null → 同时 create → 静默两条重复行。' +
    '唯一能原子防重的是 DB 层 @unique/@@unique。应用层先查后建是竞态条件。',
  provenance: '2026-10-29 [项目 A] 回顾：[Model].[method] 原 findFirst+create，' +
    '发现静默重复才加 @@unique([eventId, reason]) 换 upsert。',

  applies(rel) {
    return isComponentRel(rel)
  },

  analyze(src, rel, ctx: RuleCtx): RawHit[] {
    const code = stripComments(src)
    const hits: RawHit[] = []

    // 收集所有 prisma 调用 + 位置 + 函数体
    interface CallInfo {
      prefix: string  // prisma / tx / client / db
      model: string
      method: string
      at: number
      whereFields: string[]
      isTx: boolean   // prefix === 'tx' → 在事务里
      isRateLimit: boolean  // where 里有时间窗口（频控模式，不是"查有没有"）
      funcStart: number
      funcEnd: number
    }
    const calls: CallInfo[] = []
    let m: RegExpExecArray | null
    PRISMA_CALL_RE.lastIndex = 0
    while ((m = PRISMA_CALL_RE.exec(code)) !== null) {
      const prefix = m[1]   // prisma / tx / client / db
      const model = m[2]
      const method = m[3]
      const at = m.index
      const body = enclosingFunctionBody(code, at)
      if (!body) continue
      if (method === 'upsert' || method === 'createMany') continue
      const whereFields = method === 'findFirst' || method === 'findUnique'
        ? extractWhereFields(code, at)
        : []
      const isRateLimit = method === 'findFirst' || method === 'findUnique'
        ? whereIsTimeWindow(code, at)
        : false
      calls.push({
        prefix, model, method, at, whereFields,
        isTx: prefix === 'tx',
        isRateLimit,
        funcStart: body.start, funcEnd: body.end,
      })
    }

    // 按函数体分组
    const byBody = new Map<number, CallInfo[]>()
    for (const c of calls) {
      const key = c.funcStart
      if (!byBody.has(key)) byBody.set(key, [])
      byBody.get(key)!.push(c)
    }

    // schema 交叉（可选）
    const modelUniques = new Map<string, string[]>()
    const schema = (ctx as unknown as { facts?: { schema?: { models: Array<{ name: string; uniques: string[] }> } } }).facts?.schema
    if (schema) {
      for (const m of schema.models) modelUniques.set(m.name, m.uniques)
    }

    // 每个函数体：找 findFirst/findUnique + create 同模型配对
    for (const [, bodyCalls] of byBody) {
      const reads = bodyCalls.filter((c) => c.method === 'findFirst' || c.method === 'findUnique')
      const writes = bodyCalls.filter((c) => c.method === 'create')

      for (const read of reads) {
        // 频控模式（where 里有 createdAt/expiresAt + gte/lt）→ 跳过，不是"查有没有再建"
        if (read.isRateLimit) continue

        const sameModelCreate = writes.find((w) => w.model === read.model)
        if (!sameModelCreate) continue

        let message = `findFirst + create ${read.model} → 并发竞态`
        let evidence = `prisma.${read.model}.${read.method} + prisma.${read.model}.create`

        // 如果有 schema，尝试精确判定
        const uniques = modelUniques.get(read.model)
        if (uniques && uniques.length > 0) {
          if (read.whereFields.length > 0 && coversUnique(read.whereFields, uniques)) {
            // findFirst 的 where 已经覆盖唯一约束 → 放行（那是 find-or-fallback 模式）
            continue
          }
          message = `findFirst + create ${read.model}，where [${read.whereFields.join(',')}] 不覆盖任何唯一约束（Schema.uniques=[${uniques.join(' | ')}])`
        } else {
          message = `findFirst + create ${read.model} — 建议在 schema 上补 @unique/@@unique 或改用 upsert`
        }

        hits.push({
          line: lineOf(src, read.at),
          message,
          evidence,
        })
      }
    }

    return hits
  },

  fixtures: [
    {
      name: 'findFirst + create 同模型（该报）',
      expect: 'warn',
      rel: 'lib/notify/task.ts',
      src:
        'async function ensureTask(client: PrismaClient, eventId: string, reason: string) {\n' +
        '  const existing = await client.Task.findFirst({ where: { eventId, reason } })\n' +
        '  if (!existing) {\n' +
        '    await client.Task.create({ data: { eventId, reason } })\n' +
        '  }\n' +
        '}\n',
    },
    {
      name: 'upsert（不该报：原子操作）',
      expect: 'green',
      rel: 'lib/notify/task.ts',
      src:
        'async function ensureTask(client: PrismaClient, eventId: string, reason: string) {\n' +
        '  await client.Task.upsert({\n' +
        '    where: { eventId_reason: { eventId, reason } },\n' +
        '    update: {},\n' +
        '    create: { eventId, reason },\n' +
        '  })\n' +
        '}\n',
    },
    {
      name: '跨模型 findFirst + create（不该报：查 A 建 B 不是竞态）',
      expect: 'green',
      rel: 'lib/order/sync.ts',
      src:
        'async function syncOrder(client: PrismaClient, userId: string, orderData: any) {\n' +
        '  const user = await client.User.findUnique({ where: { id: userId } })\n' +
        '  if (user) {\n' +
        '    await client.Order.create({ data: orderData })\n' +
        '  }\n' +
        '}\n',
    },
  ],
})
