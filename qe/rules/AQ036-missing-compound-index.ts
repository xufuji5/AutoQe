/**
 * AQ036 · Prisma where 条件组合无匹配 @@index — 提示需要复合索引。
 *
 * ## 缺陷形态
 *
 * 报告 v1.0 §2.1 指出 Order 表 GMV 时间窗查询 `where: { merchantId, paidAt: { gte } }` 高频出现
 * 但 schema 只有 @@index([merchantId, status]) 和单独 @@index([paidAt])，没有 [merchantId, paidAt] 复合索引。
 * PG 只能用两个单列索引 bitmap AND，而复合索引可以 index-only scan 快速定位商户时间窗。
 *
 * skinlab 已验证的真实命中 (schema.prisma):
 *   - Order 表有 [merchantId, status] 和单独 [paidAt], 但 GMV 聚合查询 where: { merchantId, paidAt: { gte } }
 *   - catalog.ts:499 / wallet-ledger.ts:184 / dashboard-insight.ts:126 三处
 *
 * ## 判据
 *
 * 1. 解析 schema.prisma 拿到每个 Model 的 @@index 声明（字段列表）
 * 2. 扫描代码里 Prisma 查询的 where 条件组合（merchantId + paidAt/status/createdAt）
 * 3. 对每处 where 收集"等值 + 范围"字段集合
 * 4. 检查 schema 里有没有覆盖这些字段前导列的复合索引
 * 5. 没有 → 提示「考虑建 [merchantId, paidAt] 复合索引」
 *
 * ## 精度原则
 *
 * 静态分析无法知道查询频率/数据量，所以不报 WARN 只报 INFO —— 告诉开发者"这个查询模式没有对应索引"，
 * 由人决定是否需要加。过度建索引拖慢写路径是另一种缺陷。
 */

import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { stripComments } from '../lib/code-only.ts'
import { lineOf } from '../lib/rule-helpers.ts'
import path from 'node:path'

// 常见复合索引需求模板: 这些字段组合在电商系统里出现必有索引
// (merchantId + 时间窗) / (status + 时间窗) / (merchantId + status)
// 精确匹配 schema 里是否存在覆盖前导列的复合索引

/** 从 schema.prisma 解析每个 Model 的 @@index 字段列表 (正确处理字符串里的括号) */
function parseSchemaIndexes(schemaSrc: string): Map<string, string[][]> {
  const result = new Map<string, string[][]>()

  let i = 0
  const L = schemaSrc.length
  let currentModel: string | null = null
  let braceDepth = 0

  // 逐字符, 跳过字符串里的括号
  while (i < L) {
    const c = schemaSrc[i]

    // 跳过字符串
    if (c === '"' || c === "'") {
      const q = c
      i++
      while (i < L && schemaSrc[i] !== q) { if (schemaSrc[i] === '\\') i += 2; else i++ }
      i++
      continue
    }
    // 跳过反引号
    if (c === '`') {
      i++
      while (i < L && schemaSrc[i] !== '`') i++
      i++
      continue
    }
    // 跳过行注释
    if (c === '/' && schemaSrc[i + 1] === '/') {
      while (i < L && schemaSrc[i] !== '\n') i++
      continue
    }
    // 跳过块注释
    if (c === '/' && schemaSrc[i + 1] === '*') {
      i += 2
      while (i < L && !(schemaSrc[i] === '*' && schemaSrc[i + 1] === '/')) i++
      i += 2
      continue
    }

    // model Xxx {
    if (!currentModel && /[A-Za-z_]/.test(c)) {
      const rest = schemaSrc.slice(i, i + 80)
      const m = rest.match(/^model\s+([A-Za-z_][\w]*)\s*\{/)
      if (m) {
        currentModel = m[1]
        braceDepth = 1
        i += m[0].length
        continue
      }
    }

    if (c === '{') braceDepth++
    else if (c === '}') {
      braceDepth--
      if (braceDepth === 0 && currentModel) {
        currentModel = null
      }
    }

    // @@index([field1, field2]) — 只在 currentModel 里
    if (currentModel && c === '@' && schemaSrc.slice(i, i + 7) === '@index(') {
      // 找 [ 到 ]
      const open = schemaSrc.indexOf('[', i)
      const close = schemaSrc.indexOf(']', open)
      if (open > 0 && close > 0) {
        const fieldsRaw = schemaSrc.slice(open + 1, close)
        const fields = fieldsRaw
          .split(',')
          .map((f) => f.trim())
          .map((f) => f.replace(/\(sort:\s*(?:Asc|Desc)\)/i, '').trim())
          .filter(Boolean)
        if (!result.has(currentModel)) result.set(currentModel, [])
        result.get(currentModel)!.push(fields)
        // 同时存小写 key (Prisma 客户端里模型名是小写驼峰)
        const lcKey = currentModel.charAt(0).toLowerCase() + currentModel.slice(1)
        if (!result.has(lcKey)) result.set(lcKey, [])
        result.get(lcKey)!.push(fields)
      }
    }

    i++
  }

  return result
}

/** 按顶层逗号切分 (不切到嵌套 { [ 里的逗号) */
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i))
      start = i + 1
    }
  }
  parts.push(s.slice(start))
  return parts
}

/** 一个 where 对象里出现的字段集合（粗解析） */
function extractWhereFields(src: string, searchFrom: number): Array<{ model: string; fields: Set<string>; whereText: string; at: number }> {
  const results: Array<{ model: string; fields: Set<string>; whereText: string; at: number }> = []

  // prisma.Model.findMany/findFirst/findUnique/aggregate/count/findRaw({ ... where: { ... } })
  const RE = /(?:prisma|db|client|tx)\.([A-Za-z_][\w]*)\.(findMany|findFirst|findUnique|aggregate|count|groupBy|findRaw)\b/g
  let m: RegExpExecArray | null

  while ((m = RE.exec(src)) !== null) {
    const at = m.index
    const model = m[1]

    // 找后面的 ( ... ), 配平括号
    const parenOpen = src.indexOf('(', at + m[0].length - 1)
    if (parenOpen < 0) continue
    let depth = 0
    let i = parenOpen
    let parenClose = -1
    while (i < src.length) {
      const c = src[i]
      if (c === '`') { i++; while (i < src.length && src[i] !== '`') i++ }
      else if (c === '"' || c === "'") { const q = c; i++; while (i < src.length && src[i] !== q) i++ }
      else if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '(') depth++
      else if (c === ')') { depth--; if (depth === 0) { parenClose = i; break } }
      i++
    }
    if (parenClose < 0) continue

    const body = src.slice(parenOpen, parenClose)

    // 找 where: { ... }, 配平
    const whereIdx = body.indexOf('where')
    if (whereIdx < 0) continue
    const colonIdx = body.indexOf(':', whereIdx)
    if (colonIdx < 0) continue
    let j = colonIdx + 1
    while (j < body.length && body[j] !== '{') j++
    if (j >= body.length) continue
    const whereStart = j
    let wdepth = 0
    let whereEnd = -1
    for (; j < body.length; j++) {
      if (body[j] === '{') wdepth++
      else if (body[j] === '}') { wdepth--; if (wdepth === 0) { whereEnd = j + 1; break } }
    }
    if (whereEnd < 0) continue
    let whereBody = body.slice(whereStart, whereEnd)

    // 剥掉 { ... } 外层花括号
    const mOuter = whereBody.match(/^\s*\{\s*([\s\S]*?)\s*\}\s*$/)
    if (mOuter) whereBody = mOuter[1].trim()

    // 提取顶层字段名
    const fieldNames = new Set<string>()

    // 有冒号的: status: { in: [...] }
    const keyRe = /(?:^|,)\s*([A-Za-z_][\w]*)\s*:/gm
    let km
    while ((km = keyRe.exec(whereBody)) !== null) {
      fieldNames.add(km[1])
    }

    // ES6 shorthand: { merchantId, paidAt } — 没有冒号, 直接标识符
    // 必须从剥掉 { } 后的 top-level commas 提取
    const commas = splitTopLevelCommas(whereBody)
    for (const piece of commas) {
      const trimmed = piece.trim()
      if (!trimmed) continue
      // 只匹配纯标识符 (无冒号无空格无点)
      if (trimmed.includes(':') || trimmed.includes('.') || trimmed.includes(' ')) continue
      const m2 = trimmed.match(/^([A-Za-z_][\w]*)$/)
      if (m2) fieldNames.add(m2[1])
    }

    // 过滤掉 Prisma 操作符: in/notIn/gte/lte/gt/lt/equals/contains/startsWith/endsWith
    // 这些是嵌套值, 不是顶层 where 字段
    const OPS = new Set(['in', 'notIn', 'gte', 'lte', 'gt', 'lt', 'equals', 'contains', 'startsWith', 'endsWith', 'like', 'not', 'has', 'every', 'some', 'none'])
    for (const f of fieldNames) if (OPS.has(f)) fieldNames.delete(f)

    // 过滤 relation 字段（has 嵌套 select/include）——这些不是 where 过滤条件
    // 简化: 把明显是嵌套对象但不含 gte/in 等操作符的 key 也收进来, 由开发者判断

    results.push({ model, fields: fieldNames, whereText: whereBody, at })
  }

  return results
}

/** 检查 schema 里有没有复合索引覆盖 where 字段 (前导列匹配 + 覆盖度判定) */
function hasCoveringIndex(schemaIndexes: string[][], whereFields: Set<string>): boolean {
  if (schemaIndexes.length === 0) return false
  const whereList = [...whereFields]
  const whereCount = whereList.length

  // 对于 where 有 N 个字段, 需要至少一个索引:
  //   - 复合索引前 N 列全部命中 (索引覆盖全部 where 字段 - 最好)
  //   - 或者索引覆盖所有 "等值条件" 字段 + 至少一个范围条件字段
  // 简化规则: 只要所有 where 字段都被某个索引的前导列覆盖就算.
  // 如果 where 有 3 个字段而某个复合索引只覆盖了其中 2 个前导列, 那第 3 个需要回表过滤 -- 不完全覆盖.

  for (const idxFields of schemaIndexes) {
    // 索引包含所有 where 字段 (作为前导列或非前导列都算 -- Prisma 默认不强制顺序)
    // 简化检查: where 字段 ⊆ 索引字段
    const allCovered = whereList.every((w) => idxFields.includes(w))
    if (allCovered) {
      // 但还得有至少 2 个前导列命中 (否则单列索引 + 单列索引 bitmap AND 就够了)
      let leadingMatch = 0
      for (const f of idxFields) {
        if (whereFields.has(f)) leadingMatch++
        else break
      }
      if (leadingMatch >= 2) return true
      // 单列 where 被单列索引覆盖也可以
      if (whereCount === 1 && idxFields.includes(whereList[0])) return true
    }
  }
  return false
}

/** 把 Prisma 模型名小写化（schema @@index 字段也是小写 camelCase） */
function lc(s: string): string { return s.charAt(0).toLowerCase() + s.slice(1) }

export const aq36 = toGuard({
  id: 'aq36',
  title: 'Prisma where 条件组合无匹配 @@index — 提示需要复合索引',
  invariants: ['INV-PERF-09'],
  code: 'AQ036_WHERE_NO_COVERING_INDEX',
  level: 'info',
  impact:
    'Prisma where 里同时过滤 merchantId + paidAt 等多个字段，但 schema 里没有覆盖这些前导列的复合索引。' +
    'PG 只能走 bitmap AND 多个单列索引或 seq scan — GMV 时间窗查询慢。' +
    '提示级：静态分析无法判定查询频率，由人决定是否加索引（过度建索引拖写路径是另一种缺陷）。',
  provenance: '2026-10-29 skinlab DB 优化包 v1.0 §2.1: Order 表 GMV 查询 where: { merchantId, paidAt } 至少 5 处，' +
    '当前只有 [merchantId, status] + 单独 [paidAt]，缺 [merchantId, paidAt] 复合索引。',

  applies() { return true },

  analyze(_src, _rel, ctx: RuleCtx): RawHit[] {
    if (ctx.config.schema?.provider !== 'prisma') return []

    // 只跑一次
    const k = '_aq36Ran' as const
    if ((ctx as any)[k]) return []
    ;(ctx as any)[k] = true

    // 读 schema.prisma
    const schemaPath = ctx.config.schema?.path
    if (!schemaPath) return []
    const schemaAbs = path.resolve(ctx.root, schemaPath)
    const schemaSrc = ctx.readFile(schemaAbs) ?? ctx.readFile(schemaPath)
    if (!schemaSrc) return []

    const modelIndexes = parseSchemaIndexes(stripComments(schemaSrc))

    const hits: RawHit[] = []
    const seen = new Set<string>() // dedup: 同一 where 组合 + model 只报一次

    for (const fileRel of ctx.files) {
      if (!/\.(ts|tsx|js|jsx)$/.test(fileRel)) continue
      if (/node_modules|\.next|scripts\//.test(fileRel)) continue

      const raw = ctx.readFile(fileRel)
      if (!raw) continue
      const src = stripComments(raw)

      const whereCalls = extractWhereFields(src, 0)
      for (const call of whereCalls) {
        // 只关心多字段 where
        if (call.fields.size < 2) continue
        const modelLC = lc(call.model)
        const indexes = modelIndexes.get(call.model) ?? modelIndexes.get(modelLC) ?? []
        if (indexes.length === 0) continue

        // 有复合索引覆盖 → 跳过
        if (hasCoveringIndex(indexes, call.fields)) continue

        // 没有覆盖 → 提示
        const key = `${call.model}|${[...call.fields].sort().join(',')}`
        if (seen.has(key)) continue
        seen.add(key)

        const line = lineOf(src, call.at)
        hits.push({
          line,
          file: fileRel,
          message:
            `\`${call.model}\` where 同时过滤 [${[...call.fields].join(', ')}]，` +
            `但 schema 里没有覆盖这些前导列的复合索引 — ` +
            `现有 @@index: ${indexes.map((i) => `[${i.join(', ')}]`).join(' ')}. ` +
            `考虑建 @@index([${[...call.fields].join(', ')}]) 或确认当前查询频率不足以需要索引。`,
          evidence: `where: { ${[...call.fields].join(', ')} } — 无覆盖复合索引`,
        })
      }
    }

    return hits
  },

  fixtures: [
    // 跨文件守卫 (schema.prisma + 业务代码) — selftest 无法模拟多文件 ctx.readFile
    {
      name: '占位 -- 跨文件守卫需项目级实扫验证',
      expect: 'skip',
      rel: 'README.md',
      src: '',
    },
  ],
})
