/**
 * AQ005 · 原生 SQL 缺租户收敛 / 拼接注入
 *
 * ## 两种洞，一条规则抓不住就得分两条判据
 *   ① **跨租户读**：`$queryRaw` 写了 `WHERE id = ${id}`，忘了 `tenantId`。
 *      单租户测试永远绿；上线后 A 公司能看到 B 公司的单据。这是 IDOR 的 SQL 版。
 *   ② **注入**：`$queryRawUnsafe(\`... WHERE name = '${name}'\`)` —— 参数直接进字符串。
 *
 * 判据因此分两档：
 *   - `$queryRawUnsafe` / `$executeRawUnsafe` 且模板里出现 `${` 插值 → high（注入）
 *   - `$queryRaw` / `$executeRaw` 模板里没有声明过的租户列 → high（跨租户）
 *
 * ## 误报边界
 * 平台维查询（统计全站、跑批）本来就不带租户。这类用 `options.platformScope` 按文件声明，
 * 双向校验：声明了但代码已不是该形态，引擎报 `exempt-drift`。
 * 另外 `SELECT 1`、`SELECT now()` 这种健康检查不碰业务表 —— 用 `options.trivial` 正则放过。
 */
import { stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'

const DEFAULT_TENANT_KEYS = ['tenantId', 'tenant_id', 'merchantId', 'merchant_id', 'orgId', 'org_id', 'companyId', 'shopId', 'entityId']

/**
 * 取 `$queryRaw` 系列调用后面那个**模板串**的内容。
 *
 * 必须精确，否则判据会把「参数化模板」误当成「字符串拼接」——首轮实测就把
 * `$queryRawUnsafe(\`select ... \`, $1)` 这一整片参数化写法报成了注入。
 *
 * 接受的形态：
 *   `$queryRaw\`...\``
 *   `$queryRaw<T>\`...\``
 *   `$queryRawUnsafe(\`...\`, ...params)`
 *   `$executeRaw(Prisma.sql\`...\`)`
 * 其它（`$queryRawUnsafe(sqlString, params)`）= 拼接串，返回 null。
 */
function templateAfter(code: string, index: number): string | null {
  let i = index
  const skipWs = () => {
    while (i < code.length && /\s/.test(code[i])) i++
  }
  skipWs()
  if (code[i] === '<') {
    let depth = 0
    while (i < code.length) {
      if (code[i] === '<') depth++
      else if (code[i] === '>') {
        depth--
        if (depth === 0) {
          i++
          break
        }
      }
      i++
    }
    skipWs()
  }
  if (code[i] === '(') {
    i++
    skipWs()
    // `(Prisma.sql`...`)` / `(Prisma.raw`...`)`
    const m = /^Prisma\.(?:sql|raw)\b/.exec(code.slice(i, i + 16))
    if (m) {
      i += m[0].length
      skipWs()
      if (code[i] === '(') {
        i++
        skipWs()
      }
    }
  }
  if (code[i] !== '`') return null
  let j = i + 1
  while (j < code.length) {
    if (code[j] === '\\') {
      j += 2
      continue
    }
    if (code[j] === '`') return code.slice(i + 1, j)
    j++
  }
  return null
}

const RAW_RE = /\$(queryRawUnsafe|executeRawUnsafe|queryRaw|executeRaw)\b/g

export const aq05 = toGuard({
  id: 'aq05',
  title: '原生 SQL 缺租户收敛 / 拼接注入',
  invariants: ['INV-CORE-08'],
  code: 'AQ005_RAW_SQL_SCOPE',
  blindSpots: [
      '只判模板串里有没有租户列；把租户条件拼进字符串变量时不可见',
      '启用数据库层 RLS 的仓需声明 `rlsEnforced: true`，此时本规则只报注入类',
      'SQL 语义不解析：CTE、子查询、视图内的租户收敛不判定',
    ],
  impact: '单租户测试全绿，多租户上线后 A 能看到 B 的数据；Unsafe + 插值 = 直接注入',
  provenance: "外部试点 B（2026-10）的原生 SQL 扫描器（该项目主要数据通路是手写 SQL）+ 外部试点 A 的多租户盘点",
  applies(rel) {
    if (!/\.(ts|tsx|mjs|mts)$/.test(rel)) return false
    if (/\.(test|spec)\./.test(rel)) return false
    // 运维脚本/一次性清理不属于应用层租户审计（首轮实测：清理脚本里的
    // `DELETE FROM ${table} WHERE tenant_id = $1` 被整片误报成跨租户写）。
    if (/(^|\/)(scripts|tools|prisma)\//.test(rel)) return false
    return true
  },
  analyze(src, rel, ctx: RuleCtx): RawHit[] {
    const platformScope = (ctx.options.platformScope ?? []) as string[]
    if (platformScope.includes(rel)) return []
    const tenantKeys = ((ctx.options.tenantKeys as string[] | undefined) ?? DEFAULT_TENANT_KEYS).map((k) =>
      k.toLowerCase(),
    )
    const trivialRe = new RegExp(
      (ctx.options.trivial as string) ?? '^\\s*(?:SELECT|select)\\s+(?:1|now\\(\\)|version\\(\\))',
    )

    const code = stripComments(src)
    const rlsEnforced = ctx.options.rlsEnforced === true
    const hits: RawHit[] = []
    let m: RegExpExecArray | null
    RAW_RE.lastIndex = 0
    while ((m = RAW_RE.exec(code)) !== null) {
      const kind = m[1]
      const at = m.index
      const tpl = templateAfter(code, at + m[0].length)
      if (tpl === null) {
        // `$queryRawUnsafe(sqlString)` —— 传的是变量/拼接串，连模板都没有，注入风险最高
        if (kind.endsWith('Unsafe')) {
          const ahead = code.slice(at + m[0].length, at + m[0].length + 60)
          if (/^\s*\(/.test(ahead) && !/^\s*\(\s*Prisma\./.test(ahead)) {
            hits.push({
              line: lineOf(src, at),
              evidence: evidenceOf(src, at),
              impact: `$${kind} 接收拼接字符串而不是模板：参数未经参数化，构成 SQL 注入`,
            })
          }
        }
        continue
      }
      if (trivialRe.test(tpl)) continue

      // 项目若在数据库层启用 RLS（如 `app.current_tenant` + 行级策略），
      // 应用层 SQL 不带租户列是**设计**而不是洞 —— 此时只保留注入判据。
      if (rlsEnforced && !kind.endsWith('Unsafe')) continue

      if (kind.endsWith('Unsafe') && tpl.includes('${')) {
        hits.push({
          line: lineOf(src, at),
          evidence: evidenceOf(src, at),
          impact: `$${kind} 模板里直接插值变量：参数未经参数化，构成 SQL 注入`,
        })
        continue
      }

      const lower = tpl.toLowerCase()
      const hasTenant = tenantKeys.some((k) => lower.includes(k.toLowerCase()))
      if (hasTenant) continue

      // 分档（第一版不分档，在试点 A 上报了 162 处「跨租户」——绝大多数是全站聚合统计，
      // 那是设计意图而不是洞。判据必须能区分「按 id 取单条」和「COUNT(*) 全站」）。
      const isWrite = /\b(insert\s+into|update\s+[\w".]+\s+set|delete\s+from)\b/i.test(tpl)
      const byId = /\bwhere\b[\s\S]*\b"?id"?\s*=\s*\$\{/i.test(tpl)
      const aggregate = /\b(count|sum|avg|min|max)\s*\(/i.test(tpl)

      if (isWrite) {
        // 写语句分两种：
        //   · `WHERE id = ${...}` 精确单条写 → 租户收敛通常由**前置查询**保证（静态看不见那一步），
        //     属于越权（AQ008）的射程，不是租户扫描的射程。首轮实测在跑批作业上报了整片误报。
        //   · 无边界的批量写（无 WHERE，或 WHERE 不含 id）→ 真危险，一次改全表。
        if (!byId) {
          hits.push({
            line: lineOf(src, at),
            evidence: evidenceOf(src, at),
            impact: `$${kind} 的写语句没有按行定位也没有租户收敛列：一次可能改到整表/其它租户`,
          })
        }
        continue
      }
      if (byId) {
        // 中置信：`${order.id}` 这类参数往往来自**已鉴权**的上下文（前面查过租户），
        // 静态判据看不见那一步。首轮实测在试点 A 上 127 处里绝大多数属于这一类，
        // 所以它默认**不输出**，要用请显式开 reportById —— 否则真注入会被噪声淹掉。
        if (ctx.options.reportById === true) {
          hits.push({
            line: lineOf(src, at),
            evidence: evidenceOf(src, at),
            impact: `$${kind} 按 id 取单条但没有租户收敛列：若该 id 来自请求参数，即跨租户越权读`,
          })
        }
        continue
      }
      if (!aggregate) {
        // 只对「业务查询」判定。以下形态不是业务读写，不报：
        //   · advisory lock / 系统函数（pg_advisory_xact_lock、hashtext）
        //   · 按全局唯一键查（openid / email / phone / uuid / sn / code）—— 这类键本身就跨租户唯一
        const systemFn = /\bpg_\w+|hashtext\s*\(|current_schema\s*\(|set_config\s*\(/i.test(tpl)
        const uniqueKey = /\bwhere\b[\s\S]*\b(openid|union_id|email|phone|mobile|uuid|guid|sn|code|batch_no)\b/i.test(tpl)
        if (systemFn || uniqueKey) continue
        hits.push({
          line: lineOf(src, at),
          evidence: evidenceOf(src, at),
          impact: `$${kind} 无租户条件也不是显式聚合：若这是业务查询，可能读到其它租户数据`,
        })
      }
      // 全站聚合（COUNT/SUM/GROUP BY）不报：这是设计意图，由 platformScope 声明管理
    }
    return hits
  },
  fixtures: [
    {
      name: 'Unsafe 拼接（该报）',
      expect: 'red',
      src: 'const rows = await prisma.$queryRawUnsafe(`select * from "Order" where id = ${id}`)\n',
    },
    {
      name: '缺租户列（该报，需显式开 reportById）',
      expect: 'red',
      options: { reportById: true },
      src: 'const rows = await prisma.$queryRaw`select * from "Batch" where id = ${id}`\n',
    },
    {
      name: '带租户列（不该报）',
      expect: 'green',
      src: 'const rows = await prisma.$queryRaw`select * from "Batch" where id = ${id} and "tenantId" = ${tid}`\n',
    },
    {
      name: '健康检查（不该报）',
      expect: 'green',
      src: 'await prisma.$queryRaw`select 1`\n',
    },
    {
      name: '全站聚合无租户列（不该报）',
      expect: 'green',
      src: 'const rows = await prisma.$queryRaw`select count(*) from "Order" where "paidAt" > ${t}`\n',
    },
    {
      name: '按 id 的精确写（不该报，租户收敛由前置查询保证）',
      expect: 'green',
      src: 'await prisma.$executeRaw`update "Batch" set "state" = ${s} where "id" = ${id}`\n',
    },
    {
      name: '无边界的批量写（该报）',
      expect: 'red',
      src: 'await prisma.$executeRaw`delete from "Batch" where "state" = ${s}`\n',
    },
    {
      name: '平台维已声明（不该报）',
      expect: 'green',
      rel: 'jobs/metrics.ts',
      options: { platformScope: ['jobs/metrics.ts'] },
      src: 'const rows = await prisma.$queryRaw`select count(*) from "Order"`\n',
    },
  ],
})
