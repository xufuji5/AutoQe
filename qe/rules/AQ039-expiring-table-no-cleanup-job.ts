/**
 * AQ039 · 表有 expiresAt/保留期语义字段但无清理 cron job。
 *
 * ## 缺陷形态
 *
 * 报告 v1.0 §2.3 列出了 8 张需要清理 cron 的表:
 *
 *   idempotency_tokens — expiresAt < now, 每日
 *   queue_jobs         — 终态 7 天, 每日
 *   notification_attempts — 终态 30 天, 每日
 *   error_events       — 1 年, 每周
 *   messages           — 180 天, 每周
 *   compliance_check_records — 1 年, 每周
 *   audit_logs         — 3 年 (合规), 归档而非删除
 *   exposures          — 90 天 detach 到归档表, 每月
 *
 * skinlab 实查: exposures 有清理 (nightly-ranking.ts:1529 deleteMany), 但 idempotency_token、
 * queue_jobs、error_events、compliance_check_records、audit_logs 只有 scripts/smoke 里
 * 按需删除, jobs/ 目录下没有定期清理 cron.
 *
 * ## 判据
 *
 * 1. 扫 schema.prisma 找有 expiresAt/expires_at/validUntil/valid_until 字段的 Model
 * 2. 扫 jobs/ 下所有 .ts 文件找对这些表的 deleteMany / 类似清理调用
 * 3. 有 expiresAt 但无清理 job -> INFO (提示级, 由人决定是否需要)
 *
 * 排除:
 *   - Model 名在注释里写了 "无清理 job" / "不需要清理" 的显式声明
 *   - audits / 审计日志类 (合规要求保留 >1 年)
 */

import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import path from 'node:path'

/** 从 schema 里找有 expiresAt/validUntil 等语义字段的 Model */
function findExpiringModels(schemaSrc: string): Array<{ model: string; fields: string[]; line: number; comment: string }> {
  const results: Array<{ model: string; fields: string[]; line: number; comment: string }> = []
  const lines = schemaSrc.split('\n')

  const EXPIRY_FIELDS = /\b(expiresAt|expiredAt|expiry|validUntil|valid_until|expires_at|deadlineAt)\b/i
  // 注释里显式写了不要清理
  const NO_CLEANUP_HINT = /无清理\s*(job|cron)?|不需要清理|不删只归档|合规要求保留|永久保留|只增不改|量可控/i

  let currentModel: string | null = null
  let braceDepth = 0
  let beforeComment = '' // model 声明前的注释块

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const line = rawLine.trim()

    if (!currentModel) {
      // model 声明前的注释块收集
      if (line.startsWith('//') || line.startsWith('///')) {
        beforeComment += line + '\n'
        continue
      }
      if (!line) continue

      const modelM = line.match(/^model\s+([A-Za-z_][\w]*)\s*\{/)
      if (modelM) {
        currentModel = modelM[1]
        braceDepth = 1
        beforeComment = beforeComment.trim()
        continue
      }
      // 非 model 声明 → 清空前注释
      beforeComment = ''
      continue
    }

    // 在 model 内部
    if (line.includes('}')) {
      braceDepth--
      if (braceDepth === 0) {
        currentModel = null
        beforeComment = ''
        continue
      }
    }
    // 字段行
    const fieldMatch = line.match(/^([A-Za-z_][\w]*)\s+(.+)/)
    if (fieldMatch) {
      const fieldName = fieldMatch[1]
      if (EXPIRY_FIELDS.test(fieldName)) {
        // 这个 model 有 expiresAt
        const existing = results.find((r) => r.model === currentModel)
        if (existing) existing.fields.push(fieldName)
        else {
          results.push({
            model: currentModel,
            fields: [fieldName],
            line: i + 1,
            comment: beforeComment,
          })
        }
      }
    }
  }

  // 过滤: 注释里显式说了不清理的 (合规审计日志等)
  return results.filter((r) => !NO_CLEANUP_HINT.test(r.comment))
}

/** 从 jobs/ 目录扫每个 Model 有没有 deleteMany/清理 */
function findCleanupJobs(
  ctx: RuleCtx,
  modelNames: string[],
): Map<string, Array<{ file: string; snippet: string }>> {
  const result = new Map<string, Array<{ file: string; snippet: string }>>()
  const lcMap = new Map(modelNames.map((n) => [n.toLowerCase(), n]))

  for (const fileRel of ctx.files) {
    if (!/(^|\/)jobs\//.test(fileRel)) continue
    if (!/\.(ts|tsx|js|jsx)$/.test(fileRel)) continue

    const src = ctx.readFile(fileRel)
    if (!src) continue

    for (const modelName of modelNames) {
      // prisma.Model.deleteMany / prisma.Model.delete / prisma.Model.updateMany
      const pat = new RegExp(
        String.raw`prisma\.${modelName}\.(deleteMany|delete|updateMany)\b` +
        `|prisma\.${modelName.toLowerCase()}\.(deleteMany|delete|updateMany)\b`,
        'g',
      )
      let m
      while ((m = pat.exec(src)) !== null) {
        const arr = result.get(modelName) ?? []
        arr.push({ file: fileRel, snippet: m[0] })
        result.set(modelName, arr)
      }
    }
  }

  return result
}

export const aq39 = toGuard({
  id: 'aq39',
  title: '有 expiresAt/validUntil 的高增长表，但 jobs/ 目录下无清理 cron',
  invariants: ['INV-PERF-10'],
  code: 'AQ039_EXPIRING_TABLE_NO_CLEANUP',
  level: 'info',
  impact:
    'Schema 里有 expiresAt/validUntil 字段的表（意味着数据会过期），但 jobs/ 目录下没有定期清理的 cron — ' +
    '一年后可能是几百万行，任何时间窗查询都会变慢，那时再做就是在线手术。' +
    '提示级：有些表可能确实不需要清理（量可控），由人决定。',
  provenance: '2026-10-29 skinlab DB 优化包 v1.0 §2.3: 8 张表需要清理 cron，' +
    '实查 exposures 有清理但 idempotency_token / queue_jobs / error_events / compliance_check_records / audit_logs 都没有.',

  applies() { return true },

  analyze(_src, _rel, ctx: RuleCtx): RawHit[] {
    if (ctx.config.schema?.provider !== 'prisma') return []

    const k = '_aq39Ran' as const
    if ((ctx as any)[k]) return []
    ;(ctx as any)[k] = true

    const schemaPath = ctx.config.schema?.path
    if (!schemaPath) return []
    const schemaAbs = path.resolve(ctx.root, schemaPath)
    const schemaSrc = ctx.readFile(schemaAbs) ?? ctx.readFile(schemaPath)
    if (!schemaSrc) return []

    const expiringModels = findExpiringModels(schemaSrc)
    if (expiringModels.length === 0) return []

    const modelNames = expiringModels.map((m) => m.model)
    const cleanupJobs = findCleanupJobs(ctx, modelNames)

    const hits: RawHit[] = []
    for (const m of expiringModels) {
      const jobs = cleanupJobs.get(m.model) ?? []
      if (jobs.length > 0) continue // 有清理

      hits.push({
        line: m.line,
        file: schemaPath,
        message:
          `Model \`${m.model}\` 有过期字段 [${m.fields.join(', ')}] 表示数据有生命周期，` +
          `但 jobs/ 目录下找不到定期清理它的 cron — ` +
          `长期积累可能导致查询退化. 建议: 在 jobs/ 下加一条 deleteMany cutoff 清理.`,
        evidence: `expiresAt 字段 [${m.fields.join(', ')}] + 零清理 job`,
      })
    }

    return hits
  },

  fixtures: [
    {
      name: '占位 -- 跨文件守卫需项目级实扫验证',
      expect: 'skip',
      rel: 'README.md',
      src: '',
    },
  ],
})
