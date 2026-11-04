/**
 * AQ038 · Prisma DATABASE_URL 缺 connection_limit 显式配置。
 *
 * ## 缺陷形态
 *
 * Prisma Client 默认 `connection_limit = 5`（每个实例）。Next.js 生产启动 2-3 个 cluster worker
 * + cron scheduler + queue worker = 约 6 个独立 PrismaClient 实例 → 峰值 30 连接。
 * PostgreSQL 默认 max_connections=100 够使，但不显式配置就没留余地。
 *
 * [项目 A] 真实案例：.env.example 里
 *   DATABASE_URL="postgresql://[host]:[port]/[dbname]?schema=public"
 * 没有 connection_limit 参数，依赖 Prisma 默认值。
 *
 * ## 判据
 *
 * 1. 读项目的 .env / .env.example / .env.production（任意一个存在即可）
 * 2. 提取 DATABASE_URL 的值（从 `DATABASE_URL=` 后引号里的内容）
 * 3. URL 里检查 `connection_limit=N` 查询参数
 * 4. 没有 → WARN（显式建议 connection_limit=10，6 worker 峰值 60 留 40 余量）
 *
 * DIRECT_URL 不影响 Prisma Client 连接池，不检查。
 */

import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'

const ENV_FILES = ['.env', '.env.example', '.env.production', '.env.local']

/** 从 .env 内容里提取 KEY=value（引号或无引号） */
function extractEnvVar(content: string, key: string): string | null {
  const re = new RegExp(`^${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s#;]*))`, 'm')
  const m = content.match(re)
  if (!m) return null
  return m[1] ?? m[2] ?? m[3] ?? null
}

/** 从 postgres://... URL 里检查 query param */
function hasQueryParam(url: string, param: string): boolean {
  const qIdx = url.indexOf('?')
  if (qIdx < 0) return false
  const query = url.slice(qIdx + 1)
  return new RegExp(`(?:^|&)${param}=`).test(query)
}

// 模块级 Set: 跨文件分析按项目 root 区分, 每个 root 只跑一次
const _aq38RanRoots = new Set<string>()

export const aq38 = toGuard({
  id: 'aq38',
  title: 'Prisma DATABASE_URL 缺 connection_limit 显式配置',
  invariants: ['INV-PERF-08'],
  code: 'AQ038_DB_URL_NO_CONNECTION_LIMIT',
  level: 'warn',
  impact:
    'Prisma Client 默认 connection_limit=5（每个实例）。Next.js 生产多 worker + cron + queue = ' +
    '多实例并发，连接数不可控。建议 DATABASE_URL 加 connection_limit=10&pool_timeout=20 显式配置。',
  provenance: '2026-10-29 [项目 A] DB 诊断报告四·2：.env.example DATABASE_URL 无 connection_limit 参数。',

  applies() {
    // 跨文件分析: 对所有文件返回 true, analyze 内部用 flag 保证只跑一次
    return true
  },

  analyze(_src, _rel, ctx: RuleCtx): RawHit[] {
    // 同一个项目 root 只跑一次
    if (_aq38RanRoots.has(ctx.root)) return []
    _aq38RanRoots.add(ctx.root)

    const hits: RawHit[] = []

    // 需要 schema.provider === prisma 才检查
    if (ctx.config.schema?.provider !== 'prisma') return []

    let foundEnvFile: string | null = null
    let dbUrl: string | null = null
    let limit: string | null = null

    for (const envName of ENV_FILES) {
      const content = ctx.readFile(envName)
      if (!content) continue
      const url = extractEnvVar(content, 'DATABASE_URL')
      if (!url) continue
      foundEnvFile = envName
      dbUrl = url
      if (hasQueryParam(url, 'connection_limit')) {
        limit = url.match(/[?&]connection_limit=(\d+)/)?.[1] ?? null
      }
      break // 找到第一个有 DATABASE_URL 的 env 文件就停
    }

    if (!foundEnvFile || !dbUrl) {
      // 没找到 DATABASE_URL —— 不红不绿，跳过（可能是纯 SQL 项目或用 ORM）
      return []
    }

    if (!limit) {
      hits.push({
        line: 1,
        file: foundEnvFile,
        message:
          `${foundEnvFile} 里的 DATABASE_URL 没显式 connection_limit 参数。` +
          `Prisma Client 默认 5/实例，多 worker 下连接数不可控。` +
          `建议在连接串末尾加 connection_limit=10&pool_timeout=20 查询参数`,
        evidence: `DATABASE_URL="${dbUrl}" — 无 connection_limit`,
      })
    } else if (parseInt(limit, 10) < 5) {
      // 连接数太低
      hits.push({
        line: 1,
        file: foundEnvFile,
        message:
          `${foundEnvFile} 里的 DATABASE_URL connection_limit=${limit} 太低（< 5）。` +
          `Next.js 多 worker 容易耗尽连接。建议至少 connection_limit=10。`,
        evidence: `connection_limit=${limit}（低于 5）`,
      })
    }

    return hits
  },

  fixtures: [
    // 跨文件守卫 (.env 文件): selftest 无法模拟 ctx.readFile(".env")
    // 正确性通过项目级实扫验证 ([项目 A] .env 无 connection_limit → 正确报 1 WARN).
    {
      name: '占位 -- 跨文件守卫需项目级实扫验证',
      expect: 'skip',
      rel: 'README.md',
      src: '',
    },
  ],
})
