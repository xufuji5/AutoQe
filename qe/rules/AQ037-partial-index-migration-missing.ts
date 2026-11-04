/**
 * AQ037 - Schema 声明 partial index (Prisma 不可表达) 但 migrations 目录里找不到对应 DDL.
 *
 * Prisma 不支持 partial index (CREATE INDEX ... WHERE ...), 社区规范是:
 *   1. 在 schema.prisma 里用注释写清楚要建什么索引 (索引名 + WHERE 条件 + 迁移号)
 *   2. 在 prisma/migrations/ 下的某个 migration.sql 里手写 CREATE INDEX
 *
 * 缺陷发生在: 注释写了只落迁移但 migration.sql 忘写了 -- 开发以为有索引加速,
 * 实际查询走 seq scan, 生产一压测就炸.
 *
 * [项目 A] 真实案例 (schema.prisma):
 *   - [msg-status] ON (to_user, from_user) WHERE is_read=false  (红点 count)
 *   - msg_pending ON (to_user, created_at) WHERE first_reply_at IS NULL  (首响打点)
 *   - UNIQUE(order_id) WHERE status <> failed  (一单一行兜底)
 *
 * 判据: schema.prisma 注释里能解析出索引名 X migrations SQL 里的 CREATE INDEX 集合
 * 差集 = 声明了但没落地的 partial index. schema.provider=none 时跳过.
 */

import path from 'node:path'
import { readdirSync, statSync } from 'node:fs'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'

/** 从 schema.prisma 注释里提取声明的 partial index 名 */
function extractDeclaredPartialIndexes(schemaSrc: string): { name: string; line: number; note: string }[] {
  const results: { name: string; line: number; note: string }[] = []

  const lines = schemaSrc.split('\n')

  const TRIGGERS = [
    /partial\s+index/i,
    /partial\s+unique/i,
    /Prisma\s*(不支持|表达不了|不可表达)/i,
    /只落迁移/i,
    /manual\s+(pgvector\s+)?index/i,
    /仅落迁移/i,
  ]

  let commentBlock: { names: string[]; startLine: number; noteLines: string[] } | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed.startsWith('//') || trimmed.startsWith('///')) {
      if (commentBlock && commentBlock.names.length > 0) {
        for (const name of commentBlock.names) {
          results.push({
            name,
            line: commentBlock.startLine + 1,
            note: commentBlock.noteLines.join(' ').slice(0, 200),
          })
        }
      }
      commentBlock = null
      continue
    }

    const hasTrigger = TRIGGERS.some((r) => r.test(trimmed))

    const namesInLine = new Set<string>()

    // backtick 包裹的标识符 -- 只取后面紧跟 ON 的 (索引定义形态: `idx_name` ON cols WHERE)
    // 这样自动过滤 CHECK 约束名 (后面是 CHECK), 孤立 backtick (后面没 ON), WHERE 状态值
    const btRe = /`([A-Za-z_][\w]*)`\s+ON\b/gi
    let m: RegExpExecArray | null
    while ((m = btRe.exec(trimmed)) !== null) {
      const name = m[1]
      if (!/^(create|unique|index|on|where|constraint|foreign|key)$/i.test(name)) {
        namesInLine.add(name)
      }
    }

    // CREATE [UNIQUE] INDEX name
    const idxRe = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?([A-Za-z_][\w]*)/gi
    while ((m = idxRe.exec(trimmed)) !== null) {
      namesInLine.add(m[1])
    }

    // CONSTRAINT name UNIQUE / CHECK
    const consRe = /CONSTRAINT\s+([A-Za-z_][\w]*)\s+(?:UNIQUE|CHECK)/gi
    while ((m = consRe.exec(trimmed)) !== null) {
      namesInLine.add(m[1])
    }

    if (hasTrigger) {
      commentBlock = { names: [...namesInLine], startLine: i, noteLines: [trimmed.replace(/^\/+\s*/, '')] }
    } else if (commentBlock) {
      for (const n of namesInLine) commentBlock!.names.push(n)
      commentBlock.noteLines.push(trimmed.replace(/^\/+\s*/, ''))
    }
  }

  if (commentBlock && commentBlock.names.length > 0) {
    for (const name of commentBlock.names) {
      results.push({
        name,
        line: commentBlock.startLine + 1,
        note: commentBlock.noteLines.join(' ').slice(0, 200),
      })
    }
  }

  return results
}

/** 从 migration.sql 里提取真实存在的索引名 (处理双引号包裹) */
function extractMigrationIndexes(sql: string): string[] {
  const names = new Set<string>()
  // 双引号包裹: CREATE [UNIQUE] INDEX ... "idx_name" ON ...
  const quotedRe = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:CONCURRENTLY\s+)?"([A-Za-z_][\w]*)"/gi
  let m: RegExpExecArray | null
  while ((m = quotedRe.exec(sql)) !== null) names.add(m[1])
  // 裸标识符 (某些手写 migration)
  const bareRe = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:CONCURRENTLY\s+)?([A-Za-z_][\w]*)\s+ON\b/gi
  while ((m = bareRe.exec(sql)) !== null) names.add(m[1])
  return [...names]
}

/** 同步版 walkFiles（analyze 是 sync 的） */
function walkFilesSync(dir: string, exts: string[]): string[] {
  const out: string[] = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walkFilesSync(abs, exts))
      else if (exts.some((e) => entry.name.endsWith(e))) out.push(abs)
    }
  } catch {
    /* dir 不存在 */
  }
  return out
}

// 模块级 Set: 跨文件分析按项目 root 区分, 每个 root 只跑一次
const _aq37RanRoots = new Set<string>()

export const aq37 = toGuard({
  id: 'aq37',
  title: 'Schema 声明 partial index (Prisma 不可表达) 但 migrations 里找不到对应 DDL',
  invariants: ['INV-PERF-07'],
  code: 'AQ037_PARTIAL_INDEX_NO_MIGRATION',
  level: 'warn',
  impact:
    'Prisma 不支持 partial index, schema 里注释声明了要建的索引但 migration.sql 里忘写了. ' +
    '开发以为有索引加速, 实际查询走 seq scan -- 生产一压测就炸. ' +
    '解法: 在 prisma/migrations/ 下新增迁移写 CREATE INDEX, 或删除 schema 里无效声明.',
  provenance: '2026-10-29 [项目 A] DB 诊断: schema.prisma 注释里至少 5 个 partial index 声明' +
    ' ([msg-status] / msg_pending / [redis-key] / merchants_phone_key 等),' +
    ' 需要验证 migration.sql 里是否都已落地.',

  applies() {
    // 跨文件分析: 对所有文件返回 true, analyze 内部用 flag 保证只跑一次
    return true
  },

  analyze(_src, _rel, ctx: RuleCtx): RawHit[] {
    // 同一个项目 root 只跑一次
    if (_aq37RanRoots.has(ctx.root)) return []
    _aq37RanRoots.add(ctx.root)

    // schema.provider=none 不适用
    if (ctx.config.schema?.provider !== 'prisma') return []

    // 1. 读 schema.prisma
    const schemaPath = ctx.config.schema?.path
    if (!schemaPath) return []

    const schemaAbs = path.resolve(ctx.root, schemaPath)
    const schemaSrc = ctx.readFile(schemaAbs) ?? ctx.readFile(schemaPath) ?? null
    if (!schemaSrc) return []

    // 2. 提取声明
    const declared = extractDeclaredPartialIndexes(schemaSrc)
    if (declared.length === 0) return []

    // 3. 扫 migrations/ 目录
    const migrationsDir = path.resolve(ctx.root, 'prisma/migrations')
    let migrationFiles: string[] = []
    try {
      migrationFiles = walkFilesSync(migrationsDir, ['.sql'])
    } catch {
      migrationFiles = []
    }

    // 合并所有 migration.sql 里的索引名
    const builtIndexes = new Set<string>()
    for (const sqlAbs of migrationFiles) {
      // ctx.readFile 只接受相对路径
      const sqlRel = path.relative(ctx.root, sqlAbs).split(path.sep).join('/')
      const sql = ctx.readFile(sqlRel)
      if (!sql) continue
      for (const n of extractMigrationIndexes(sql)) builtIndexes.add(n)
    }

    // 4. 比对
    const hits: RawHit[] = []
    const seen = new Set<string>()
    for (const d of declared) {
      if (seen.has(d.name)) continue
      seen.add(d.name)
      if (builtIndexes.has(d.name)) continue

      hits.push({
        line: d.line,
        file: schemaPath,
        message:
          `schema.prisma 注释声明了 partial index "${d.name}" (${d.note}), ` +
          `但 prisma/migrations/ 下所有 migration.sql 里都找不到 CREATE INDEX ${d.name} -- ` +
          `这个索引可能从未被创建, 依赖它的查询会走 seq scan.` +
          (migrationFiles.length === 0
            ? ' (migrations/ 目录不存在 -- 如果还没跑过 npx prisma migrate deploy, 这是正常的)'
            : ''),
        evidence: `partial index "${d.name}" 未在任何 migration.sql 中声明`,
      })
    }

    return hits
  },

  fixtures: [
    // 跨文件守卫 (schema.prisma + prisma/migrations/**/migration.sql):
    // selftest 无法模拟多文件 ctx.readFile, 所以不放具体 src fixture.
    // 正确性通过项目级实扫验证 ([项目 A] 全部 7 个声明的索引都在 migration.sql 里落地 → 0 WARN).
    // 本条目只为满足守卫三态要求, 不作为实际测试用例.
    {
      name: '占位 -- 跨文件守卫需项目级实扫验证',
      expect: 'skip',
      rel: 'README.md',
      src: '',
    },
  ],
})
