/**
 * AQ031 · Prisma 读调用缺 select → 拉全列（含 Text/Json 重列）。
 *
 * ## 缺陷形态
 *
 * AI 写 Prisma 查询时几乎从不加 select：
 *
 *   const orders = await prisma.Order.findMany({ where: { merchantId } })
 *
 * Prisma 默认 fetch **所有列**。如果 Order 表有 `@db.Text`（description）或 `Json`（metadata），
 * 这些大列每次都要从 DB 拉过网络、反序列化进内存——列表页可能只展示 orderNo + status。
 *
 * [项目 A] 的 [产品表]：[column]（@db.Text）、description（@db.Text）、[column]（Json）、
 * [column]（Json）。任何 findMany / findFirst / findUnique 不加 select 都会把这些 Blob 拉过来。
 *
 * ## 判据
 *
 * 1. prisma.Model.findMany/findFirst/findUnique 调用无 select / select: { _count: true }
 * 2. 同 Model 在 schema 里有 Text / Json / Blob 类型的字段
 * 3. 排除：findUnique 后立即更新（`const row = await findUnique; await update`）—— 更新会重新 fetch 不必双拉
 *
 * ## 为什么是 AI 幻觉
 *
 * AI 写代码时默认"拿全量再挑自己需要的"，因为这样最不容易漏。
 * 人写久了会本能地加 select，但 AI 需要明确的规范才能学会。
 */

import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { stripComments } from '../lib/code-only.ts'
import { lineOf } from '../lib/rule-helpers.ts'

/** 从 `prisma.Model.findMany({ ... })` 粗提取：方法名、有没有 select、Model */
function extractPrismaReads(src: string): Array<{ model: string; method: string; at: number; hasSelect: boolean }> {
  const results: Array<{ model: string; method: string; at: number; hasSelect: boolean }> = []
  const RE = /(?:prisma|db|client|tx)\.([A-Za-z_][\w]*)\.(findMany|findFirst|findUnique|findRaw)\b/g
  let m: RegExpExecArray | null
  while ((m = RE.exec(src)) !== null) {
    const model = m[1]
    const method = m[2]
    const at = m.index
    // 从 method 后面找 (，配平括号，看里面有没有 select:
    const parenOpen = src.indexOf('(', at + m[0].length - 1)
    if (parenOpen < 0) { results.push({ model, method, at, hasSelect: false }); continue }
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
    if (parenClose < 0) { results.push({ model, method, at, hasSelect: false }); continue }
    const body = src.slice(parenOpen, parenClose)
    // 检查有没有 select: 或 select = （允许换行和缩进）
    const hasSelect = /\bselect\s*:/.test(body)
    results.push({ model, method, at, hasSelect })
  }
  return results
}

/** Schema 里哪些 Model 有 Text/Json/Blob 重列 */
function findHeavyModels(schema: { models: Array<{ name: string; fields: Array<{ type: string; attrs?: string }> }> }): Set<string> {
  const heavy = new Set<string>()
  const heavyTypeRe = /Json|Text|Blob|Bytes|String\s*\?\s*@db\.(Text|Json)/i
  for (const model of schema.models) {
    for (const f of model.fields) {
      if (heavyTypeRe.test(f.type) || heavyTypeRe.test(f.attrs ?? '')) {
        heavy.add(model.name)
        break
      }
    }
  }
  return heavy
}

function isComponentRel(rel: string): boolean {
  return /\.(ts|tsx|js|jsx)$/.test(rel) && !(rel.includes('node_modules') || rel.includes('.test.') || rel.includes('.spec.'))
}

export const aq31 = toGuard({
  id: 'aq31',
  title: 'Prisma 读调用缺 select → 拉全列',
  invariants: ['INV-DB-02'],
  code: 'AQ031_PRISMA_READ_NO_SELECT',
  level: 'warn',
  impact:
    'findMany/findFirst/findUnique 不加 select → Prisma 拉全列，含 Text/Json Blob 字段时 I/O 爆炸。' +
    '列表页只展示 2-3 列却拉了 20 列里的 description、metadata 大字段。',
  provenance: '2026-10-29 [项目 A] 回顾：Product schema 有 [column](@db.Text)/description(@db.Text)/' +
    '[column](Json)/[column](Json)，任何 findMany 不加 select 都会拉过来。',

  applies(rel) {
    return isComponentRel(rel)
  },

  analyze(src, rel, ctx: RuleCtx): RawHit[] {
    // schema 交叉（可选）—— 有 schema 时过滤，只报 Model 有重列的；无 schema 时全报 findMany 无 select
    const schema = (ctx as unknown as { facts?: { schema?: { models: Array<{ name: string; fields: Array<{ type: string; attrs?: string }> }> } } }).facts?.schema

    const code = stripComments(src)
    const hits: RawHit[] = []
    const reads = extractPrismaReads(code)

    // 只处理 findMany（列表页最容易拉全列）
    const listReads = reads.filter((r) => r.method === 'findMany')
    if (listReads.length === 0) return []

    const heavyModels = schema ? findHeavyModels(schema) : null

    for (const read of listReads) {
      if (read.hasSelect) continue

      if (heavyModels && heavyModels.size > 0 && !heavyModels.has(read.model)) continue
      // 有 schema 且 Model 无重列 → 跳过；无 schema → 全报（保守策略）

      let modelHint = ''
      if (heavyModels && heavyModels.has(read.model)) {
        modelHint = `（${read.model} schema 含 Text/Json 重列）`
      } else {
        modelHint = '（列表页 findMany 建议只 select 需要的列）'
      }

      hits.push({
        line: lineOf(src, read.at),
        message: `prisma.${read.model}.findMany() 无 select → 拉全列${modelHint}`,
        evidence: `prisma.${read.model}.findMany({ ... })`,
      })
    }

    return hits
  },

  fixtures: [
    {
      name: 'findMany 无 select（该报）',
      expect: 'warn',
      rel: 'lib/products/list.ts',
      src:
        'async function listProducts(client: PrismaClient) {\n' +
        '  const products = await client.Product.findMany({ where: { merchantId } })\n' +
        '  return products.map(p => ({ id: p.id, name: p.name }))\n' +
        '}\n',
    },
    {
      name: 'findMany 有 select（不该报）',
      expect: 'green',
      rel: 'lib/products/list.ts',
      src:
        'async function listProducts(client: PrismaClient) {\n' +
        '  const products = await client.Product.findMany({\n' +
        '    where: { merchantId },\n' +
        '    select: { id: true, name: true, price: true },\n' +
        '  })\n' +
        '  return products\n' +
        '}\n',
    },
  ],
})
