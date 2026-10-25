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

/** 跳过 `'...'` / `"..."` 字面量（含转义），返回闭合引号之后的位置 */
function skipQuoted(code: string, start: number): number {
  const q = code[start]
  let i = start + 1
  while (i < code.length) {
    if (code[i] === '\\') {
      i += 2
      continue
    }
    if (code[i] === q) return i + 1
    i++
  }
  return i
}

/**
 * 跳过一段模板串（从反引号开始），返回闭合反引号之后的位置。
 * 递归处理 `${...}` 里再出现的模板串 —— 这正是 `Prisma.sql\`... ${Prisma.raw(\`"x"\`)} ...\`` 的形态。
 */
function skipTemplate(code: string, start: number): number {
  let i = start + 1
  while (i < code.length) {
    const c = code[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '`') return i + 1
    if (c === '$' && code[i + 1] === '{') {
      let depth = 1
      i += 2
      while (i < code.length && depth > 0) {
        const d = code[i]
        if (d === '\\') {
          i += 2
          continue
        }
        if (d === '`') {
          i = skipTemplate(code, i)
          continue
        }
        if (d === '"' || d === "'") {
          i = skipQuoted(code, i)
          continue
        }
        if (d === '{') depth++
        else if (d === '}') depth--
        i++
      }
      continue
    }
    i++
  }
  return i
}

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
 *
 * 【2026-10-24】模板体允许**嵌套模板串**：目标仓的 `Prisma.raw(\`"${table}"\`)` 会让
 * 第一版在第一个内层反引号处截断，于是 `UPDATE ${Prisma.raw(...)} SET ... WHERE id = ${id}`
 * 被读成「没有 SET、没有 WHERE」的读查询并报成跨租户读（实测 7 处误报）。
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
  const end = skipTemplate(code, i)
  // 闭合反引号在 end-1；内部内容原样返回（保留 ${} 插值文本，byId 要看到 `${`）
  return code.slice(i + 1, Math.max(i + 1, end - 1))
}

const RAW_RE = /\$(queryRawUnsafe|executeRawUnsafe|queryRaw|executeRaw)\b/g

/**
 * 取调用括号里的**第一个实参**原文（模板串/字符串原样保留，顶层逗号即止）。
 * 用于回答「这个 Unsafe 调用收到的到底是不是拼接串」——只看一眼 `(` 之后的形状会
 * 把 `$executeRawUnsafe(sql, ...params)` 一律当拼接串，而 sql 常常是文件内的常量。
 */
function firstArgText(code: string, parenIndex: number): string | null {
  return argTextAt(code, parenIndex, 0)
}

/** 取调用括号里的第 n 个实参（0 起）原文；越界返回 null */
function argTextAt(code: string, parenIndex: number, n: number): string | null {
  if (code[parenIndex] !== '(') return null
  let i = parenIndex + 1
  let depth = 0
  let idx = 0
  let start = i
  while (i < code.length) {
    const c = code[i]
    if (c === '`') {
      i = skipTemplate(code, i)
      continue
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(code, i)
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return idx === n ? code.slice(start, i).trim() : null
      depth--
    } else if (c === ',' && depth === 0) {
      if (idx === n) return code.slice(start, i).trim()
      idx++
      start = i + 1
    }
    i++
  }
  return null
}

/**
 * 形如 `$executeRawUnsafe(sql, ...params)` 的第一实参若是指向**同文件常量**的标识符，
 * 解出其字面量。解析不出（函数形参、拼接、跨文件导入）返回 null —— 保守地仍判为拼接串。
 *
 * 这条数据流不改变判据方向：常量里出现 `${}` 仍然算注入；只有「常量 + `$1` 占位」这种
 * 已经参数化的写法才放行。首轮实测目标仓 `attackAttempt(sql, params)` 就是因为缺这一步
 * 被整片报成注入。
 */
function resolveIdentifierSql(code: string, argText: string, at: number): string | null {
  const name = argText.trim()
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null
  const re = new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=;]{0,120})?=\\s*`, 'g')
  let last: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    if (m.index >= at) break
    last = m
  }
  if (!last) return null
  const i = last.index + last[0].length
  if (code[i] === '`') return code.slice(i + 1, Math.max(i + 1, skipTemplate(code, i) - 1))
  if (code[i] === '"' || code[i] === "'") return code.slice(i + 1, Math.max(i + 1, skipQuoted(code, i) - 1))
  return null
}

interface FnDecl {
  name: string
  params: string[]
  start: number
  close: number
}

/** 从 `open` 处的 `{` 起做括号配平，返回对应的 `}` 位置（跳过字符串与模板串） */
function braceEnd(code: string, open: number): number {
  let depth = 0
  let i = open
  while (i < code.length) {
    const c = code[i]
    if (c === '`') {
      i = skipTemplate(code, i)
      continue
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(code, i)
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return code.length
}

/**
 * 从 `from` 起找函数体的 `{`。
 * 必须跳过多行返回类型里的对象字面量类型（`): Promise<{ a: string }> {` 的第一个 `{` 是类型不是函数体），
 * 否则会把函数的开括号认在返回类型上，整个参数回溯因为「不在函数体内」而失效。
 */
function bodyStart(code: string, from: number): number | null {
  let i = from
  let angle = 0
  // 类型注解里的 `;`（`Promise<{ a: string; b: number }>`）不是语句结束，不能当退出条件
  const limit = Math.min(code.length, from + 600)
  while (i < limit) {
    const c = code[i]
    if (c === '`') {
      i = skipTemplate(code, i)
      continue
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(code, i)
      continue
    }
    if (c === '<') angle++
    else if (c === '>' && angle > 0) angle--
    else if (c === '{' && angle === 0) return i
    else if (c === ';' && angle === 0) return null
    i++
  }
  return null
}

/** 取 `at` 所在的**最内层**函数声明（含箭头函数），只用于参数回溯 */
function enclosingFunction(code: string, at: number): FnDecl | null {
  const re =
    /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g
  let best: FnDecl | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    if (m.index > at) break
    const name = m[1] ?? m[3]
    if (!name) continue
    const open = bodyStart(code, re.lastIndex)
    if (open === null) continue
    const close = braceEnd(code, open)
    if (open < at && at < close) {
      const raw = (m[2] ?? m[4] ?? '').trim()
      best = {
        name,
        params: raw ? raw.split(',').map((p) => p.replace(/^\.\.\./, '').split(/[?:=]/)[0].trim()) : [],
        start: m.index,
        close,
      }
    }
  }
  return best
}

/**
 * 形参回溯：`sql` 是所在函数的形参时，回到**同文件**的所有调用点取对应实参。
 *
 * 判定方向不变——只有「每个调用点都是无插值字面量（或它的常量）」才返回静态标记；
 * 任一调用点解析不出、或实参本身含 `${}`，整条仍判拼接串。
 * 不追跨文件调用：`sql` 从别的模块传进来时静态确实看不见，仍按不可知处理。
 */
function resolveParamSql(code: string, name: string, at: number, depth: number): string | null {
  if (depth > 3) return null
  const fn = enclosingFunction(code, at)
  if (!fn) return null
  const idx = fn.params.findIndex((p) => p === name)
  if (idx < 0) return null
  const callRe = new RegExp(`\\b${fn.name}\\s*\\(`, 'g')
  let saw = false
  let m: RegExpExecArray | null
  while ((m = callRe.exec(code)) !== null) {
    // 跳过声明处自身与函数体内的递归调用（自助推出结论没有证据）
    if (m.index >= fn.start && m.index <= fn.close) continue
    if (code[m.index - 1] === '.') continue // obj.name(...) 是别的方法，不是这个函数
    let paren = m.index + fn.name.length
    while (paren < code.length && code[paren] !== '(') paren++
    const arg = argTextAt(code, paren, idx)
    if (arg === null) return null
    const resolved = resolveSqlExpr(code, arg, m.index, depth + 1)
    if (resolved === null || resolved.includes('${')) return null
    saw = true
  }
  return saw ? '(static)' : null
}

/** 把实参原文解成 SQL 字面量：字面量 / 同文件常量 / 函数形参（回溯调用点） */
function resolveSqlExpr(code: string, text: string, at: number, depth: number): string | null {
  const t = text.trim()
  if (!t) return null
  if (t.startsWith('`')) return t.slice(1, t.endsWith('`') ? -1 : undefined)
  if (t.startsWith('"') || t.startsWith("'")) return t.slice(1, -1)
  if (!/^[A-Za-z_$][\w$]*$/.test(t)) return null
  const asConst = resolveIdentifierSql(code, t, at)
  if (asConst !== null) return asConst
  return resolveParamSql(code, t, at, depth)
}

/** 补偿/对账类函数名：这些动作本来就要跨租户扫全表（清扫卡住的单、回填、重算） */
const MAINTENANCE_FN = /(reclaim|sweep|scan|cleanup|repair|reconcile|audit|bootstrap|backfill|migrate|rollup|aggregate|refresh)/i
/** 取 `at` 所在函数的函数名（函数声明或类方法），找不到返回空串 */
function enclosingFnName(code: string, at: number): string {
  const head = code.slice(0, at)
  // 行首锚定 + 可选 export/async + 名字 + 参数 + 返回类型 + `{`
  // 不锚行首会把 `await prisma.$queryRaw(...)` 里的 `$queryRaw` 认成函数名。
  const re = /^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?::[^{;]{0,300})?\{/gm
  let m: RegExpExecArray | null
  let last = ''
  while ((m = re.exec(head)) !== null) {
    if (/^(if|for|while|switch|catch|function|return|typeof|new|do|else|try)$/.test(m[1])) continue
    last = m[1]
  }
  return last
}

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
    // 已人工复核的文件：**必须写理由**（空理由不算复核，否则登记制会退化成静音开关）。
    // 存在的唯一原因：租户条件写在变量里（`IN (${Prisma.join(selfIds)})`），静态看不见，
    // 而这类「看不见」不能靠猜——只能由人读一遍并留下为什么。
    const reviewed = (ctx.options.reviewed ?? {}) as Record<string, string>
    if (typeof reviewed[rel] === 'string' && reviewed[rel].trim() !== '') return []
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
          const after = at + m[0].length
          const ahead = code.slice(after, after + 60)
          if (/^\s*\(/.test(ahead) && !/^\s*\(\s*Prisma\./.test(ahead)) {
            const paren = after + ahead.indexOf('(')
            const arg = firstArgText(code, paren)
            // 常量 / 形参回溯：任一调用点解不出静态 SQL，就仍按拼接串处理（保守）。
            const resolved = arg === null ? null : resolveSqlExpr(code, arg, at, 0)
            // 已参数化：SQL 是静态字面量，值走 `$1` 占位与实参。
            if (resolved !== null && !resolved.includes('${')) continue
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
      // DDL 不是「租户数据读写」：ALTER / CREATE INDEX / DROP / TRUNCATE 改的是结构，
      // 没有「哪一行的租户」这回事。目标仓 `lib/db/metadata.ts` 等 7 处曾被报成跨租户读，
      // 原因是 `$executeRaw` 判「无租户列」——它们全是 DDL 或按主键的单行写。
      if (/\b(alter|create\s+(?:table|index|unique|extension|schema)|drop\s+(?:table|index|schema)|truncate|comment\s+on|analyze|vacuum|grant|revoke)\b/.test(lower)) {
        continue
      }
      const hasTenant = tenantKeys.some((k) => lower.includes(k.toLowerCase()))
      if (hasTenant) continue

      // 分档（第一版不分档，在试点 A 上报了 162 处「跨租户」——绝大多数是全站聚合统计，
      // 那是设计意图而不是洞。判据必须能区分「按 id 取单条」和「COUNT(*) 全站」）。
      // 以 select 开头的语句一律按读处理（`SELECT ... FOR UPDATE` 里的 update 不是写语句）
      const isWrite = !/^\s*(?:select|with)\b/i.test(tpl) && /\b(insert\s+into|update|delete\s+from)\b/i.test(tpl)
      // 行定位的键不止 `id`：`WHERE order_id = ${...}` / `WHERE payment_no = ${...}`
      // 同样是精确到行（这些列在 schema 里都是唯一键）。第一版只认裸 `id =`，
      // 于是目标仓里 12 处按业务主键的单行原子更新被判成「无行定位的整表写」。
      const byId = /\bwhere\b[\s\S]*\b"?[\w]*id"?\s*=\s*\$\{/i.test(tpl)
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
        //   · 补偿/对账/回填函数里的全表扫（函数名即声明：reclaim / sweep / reconcile / rollup …）
        const systemFn = /\bpg_\w+|hashtext\s*\(|current_schema\s*\(|set_config\s*\(/i.test(tpl)
        const uniqueKey = /\bwhere\b[\s\S]*\b(openid|union_id|email|phone|mobile|uuid|guid|sn|code|batch_no)\b/i.test(tpl)
        const maintenanceFn = MAINTENANCE_FN.test(enclosingFnName(code, at))
        if (systemFn || uniqueKey || maintenanceFn) continue
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
      name: '嵌套 Prisma.raw 的表名 + 主键单行写（不该报）',
      expect: 'green',
      src: 'await client.$executeRaw(Prisma.sql`\n  UPDATE ${Prisma.raw(`"${table}"`)}\n  SET metadata = ${json}::jsonb\n  WHERE id = ${id}\n`)\n',
    },
    {
      name: '按业务主键 order_id 的单行原子更新（不该报）',
      expect: 'green',
      src: 'const rows = await prisma.$queryRaw`\n  UPDATE payment_records SET metadata = ${m}::jsonb\n  WHERE order_id = ${orderId} AND status = ${s}\n`\n',
    },
    {
      name: 'DDL（不该报）：改的是结构，没有「哪一行的租户」',
      expect: 'green',
      src: 'await prisma.$executeRaw`ALTER TABLE "Order" ADD COLUMN "note" text`\n',
    },
    {
      name: 'DDL 建索引（不该报）',
      expect: 'green',
      src: 'await prisma.$executeRaw`CREATE UNIQUE INDEX IF NOT EXISTS x ON "Order" ("a")`\n',
    },
    {
      name: '已复核且写了理由（不该报）',
      expect: 'green',
      rel: 'app/api/messages/route.ts',
      options: { reviewed: { 'app/api/messages/route.ts': 'selfIds 由会话推导，IN 列表即租户收敛' } },
      src: 'const rows = await prisma.$queryRaw`select peer from messages where peer in (${Prisma.join(selfIds)})`\n',
    },
    {
      name: '复核理由为空不算复核（该报）：登记制不许退化成静音开关',
      expect: 'red',
      rel: 'app/api/messages/route.ts',
      options: { reviewed: { 'app/api/messages/route.ts': '   ' } },
      src: 'const rows = await prisma.$queryRaw`select peer from messages where peer in (${Prisma.join(selfIds)})`\n',
    },
    {
      name: '补偿/对账函数里的全表扫（不该报）：函数名即声明',
      expect: 'green',
      src: 'class Payment {\n  async reclaimStaleClaims(): Promise<number> {\n    const rows = await prisma.$queryRaw`select id from payment_records where status = ${s}`\n    return rows.length\n  }\n}\n',
    },
    {
      name: '普通业务函数里的无边界读（该报）',
      expect: 'red',
      src: 'class Payment {\n  async listRecords(): Promise<number> {\n    const rows = await prisma.$queryRaw`select id from payment_records where status = ${s}`\n    return rows.length\n  }\n}\n',
    },
    {
      name: '平台维已声明（不该报）',
      expect: 'green',
      rel: 'jobs/metrics.ts',
      options: { platformScope: ['jobs/metrics.ts'] },
      src: 'const rows = await prisma.$queryRaw`select count(*) from "Order"`\n',
    },
    {
      name: 'Unsafe 接常量 SQL + $1 占位（不该报：已参数化，旧判据按「非模板即拼接」会假红）',
      expect: 'green',
      src: 'const SQL_UPD = \'UPDATE "Batch" SET "state" = $1 WHERE "id" = $2::uuid\'\nawait tx.$executeRawUnsafe(SQL_UPD, s, id)\n',
    },
    {
      name: 'Unsafe 接插值常量（该报）：常量本身是拼出来的',
      expect: 'red',
      src: 'const SQL_UPD = `UPDATE "Batch" SET "state" = \'${s}\' WHERE "id" = \'${id}\'`\nawait tx.$executeRawUnsafe(SQL_UPD)\n',
    },
    {
      name: 'sql 走函数形参，同文件所有调用点都是常量 + $1（不该报：旧判据看不见实参会整片假红）',
      expect: 'green',
      src: [
        'async function attack(tx: any, sql: string, params: unknown[] = []) {',
        '  return tx.$executeRawUnsafe(sql, ...params)',
        '}',
        'export async function run(tx: any, id: string) {',
        '  await attack(tx, \'UPDATE "Batch" SET "state" = $1 WHERE "id" = $2::uuid\', [id])',
        '  await attack(tx, \'DELETE FROM "Batch" WHERE "id" = $1::uuid\', [id])',
        '}',
      ].join('\n'),
    },
    {
      name: 'sql 走函数形参，但有一个调用点自己拼了字符串（该报）',
      expect: 'red',
      src: [
        'async function attack(tx: any, sql: string) {',
        '  return tx.$executeRawUnsafe(sql)',
        '}',
        'export async function run(tx: any, id: string) {',
        '  await attack(tx, \'DELETE FROM "Batch" WHERE "id" = $1::uuid\')',
        '  await attack(tx, `DELETE FROM "Batch" WHERE "id" = \'${id}\'`)',
        '}',
      ].join('\n'),
    },
    {
      name: 'sql 形参所在函数是多行参数 + 对象类型返回注解（旧判据会把返回类型的 { 当成函数体，回溯失效）',
      expect: 'green',
      src: [
        'async function attack(',
        '  tenantId: string,',
        '  sql: string,',
        '  params: unknown[] = [],',
        '): Promise<{ rejected: boolean; affected: number }> {',
        '  await tx.$executeRaw`SELECT set_config(${tenantId})`',
        '  return (tx as any).$executeRawUnsafe(sql, ...params)',
        '}',
        'export async function run(tx: any, tenantId: string, id: string) {',
        '  await attack(tenantId, \'DELETE FROM "Batch" WHERE "id" = $1::uuid\', [id])',
        '}',
      ].join('\n'),
    },
  ],
})
