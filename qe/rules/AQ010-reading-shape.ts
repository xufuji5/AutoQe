/**
 * AQ010 · 读数形状（查询结果的输出列名必须唯一可寻址）
 *
 * ## 真实事故形态
 *
 * 对账脚本要同时取「分子」和「分母」，最自然的写法是：
 *
 * ```ts
 * const rows = await prisma.$queryRaw`
 *   SELECT COUNT(*)::int, COUNT(*)::int FROM ...`
 * const [cur, base] = Object.values(rows[0])
 * ```
 *
 * PostgreSQL 给**没有别名**的聚合列起的名字就是函数名（`count`），两列同名。
 * 到了 JS 侧（Prisma 行对象 / `JSON.parse` / 任何「按列名建对象」的驱动）就只剩一个键，
 * 后一个覆盖前一个。于是：
 *
 * - **读数变错**：`0 / 19` 显示成 `19`；
 * - **不报错**：SQL 合法、类型合法、object 也非空；
 * - **没人发现**：错的方向还是「看起来更合理」的那一侧（分母没了，只剩分子）。
 *
 * 这类缺陷的贵不在算错，在于**它长得像成功**。同一批里它连过了两轮人工复核。
 *
 * ## 判据（只报能证死的那一种）
 *
 * 对每个 SQL 字符串里的每个 SELECT 列表，算每一项的**输出列名**，同名即报：
 *
 * | 项 | 输出名 | 来源 |
 * |---|---|---|
 * | `COUNT(*)::int` | `count` | 函数名（无别名时 PG 的行为） |
 * | `a.id` | `id` | 末段标识符 |
 * | `x AS total` | `total` | 显式别名 |
 * | `COUNT(*) cnt` | `cnt` | 隐式别名 |
 * | `0` / `CASE … END` | `?column?` | 不可寻址 → **不参与比较** |
 *
 * ## 为什么 `?column?` 不报
 *
 * `SELECT 1, 2` 是合法的探测写法，两列都叫 `?column?` 但没人按键取值。
 * 把不可寻址的项也纳入同名判定，会让规则在「连库探活」这种代码上天天响，
 * 而那种代码不可能改。**判据只在自己的交叉点上说话**：名字可寻址、且撞了。
 *
 * ## 为什么不能靠「按位置取值」补救
 *
 * `Object.values(row)` 依赖属性顺序，而这顺序由驱动决定、且上述覆盖发生在更早的一层
 * （键都不存在了，位置信息已经丢了）。所以正确修法只有一条：**每个列都显式 AS 一个不同的名字**。
 */
import { splitArgs, stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit } from '../lib/rule-guard.ts'

/** SQL 所在的字符串字面量。模板串允许跨行；引号串不允许（JS 本来也不允许） */
const SQL_LITERALS: RegExp[] = [
  /`(?:[^`\\]|\\[\s\S])*`/g,
  /'(?:[^'\\\n]|\\[\s\S])*'/g,
  /"(?:[^"\\\n]|\\[\s\S])*"/g,
]

/** SELECT 列表的终止词（顶层出现即结束） */
const LIST_STOP = /^(?:from|where|group\s+by|order\s+by|limit|union|having|offset|window|fetch|for\s+update|into)\b/i

/** 表达式尾部**不是**别名的一部分的关键字 */
const NOT_ALIAS = new Set([
  'end', 'null', 'true', 'false', 'asc', 'desc', 'then', 'else', 'and', 'or', 'not', 'interval', 'distinct',
])

/** 尾部的类型转换：`::int` / `::text` / `::numeric(10, 2)` / `::int[]` */
const TAIL_CAST = /\s*::\s*[A-Za-z_]\w*(?:\s*\([^)]*\))?(?:\s*\[\s*\])?\s*$/

const EXPLICIT_ALIAS = /\s+as\s+"?([A-Za-z_][\w$]*)"?\s*$/i
const IMPLICIT_ALIAS = /\s+"?([A-Za-z_][\w$]*)"?\s*$/
const PURE_COLUMN = /^(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)$/
const PURE_CALL = /^([A-Za-z_]\w*)\s*\([\s\S]*\)$/

/**
 * 这个 SELECT 是不是一条写语句的来源子句（`INSERT INTO … SELECT` / `CREATE TABLE … AS SELECT` /
 * `UPDATE … SET x = (SELECT …)`）。
 *
 * 为什么必须排除：写语句的**结果集不进对象**——目标列由 `INSERT INTO t (a, b, …)` 的列表指定，
 * `SELECT` 里两个 `SUM(...)` 都叫 `sum` 完全无害。真实仓库上第一版没排这一条，
 * 7 条命中里 7 条都是 rollup 的 `INSERT … SELECT`，全是误报。
 *
 * 判「包住它的最近一个 DML 头」而不是「前面出现过 insert」：一个模板里可能有多条语句
 * （`INSERT …; SELECT COUNT(*), COUNT(*)`），后者才是真缺陷，`;` 是分界。
 */
function isWriteSource(sql: string, at: number): boolean {
  const head = /\b(?:insert\s+into|create\s+(?:temp\s+)?table|update\s+[A-Za-z_][\w.]*\s+set|delete\s+from)\b/gi
  let last = -1
  let m: RegExpExecArray | null
  while ((m = head.exec(sql)) !== null) {
    if (m.index >= at) break
    last = m.index
  }
  if (last < 0) return false
  return !sql.slice(last, at).includes(';')
}

/** 顶层（括号外）SELECT 列表的结束位置 */
function listEnd(sql: string, from: number): number {  let depth = 0
  for (let i = from; i < sql.length; i++) {
    const c = sql[i]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') {
      if (depth === 0) return i
      depth--
    } else if (c === ';' && depth === 0) return i
    else if (depth === 0 && /[A-Za-z]/.test(c)) {
      const prev = i === from ? ' ' : sql[i - 1]
      if (/[\s)]/.test(prev) && LIST_STOP.test(sql.slice(i))) return i
    }
  }
  return sql.length
}

/**
 * 一项的输出列名。返回 null 表示「不可寻址」（常量、CASE、带运算符的表达式）——
 * 这类项在 PG 里都叫 `?column?`，按键取值的人从来取不到它们，所以不参与同名判定。
 */
function outputName(rawItem: string): string | null {
  let t = rawItem.trim()
  if (t === '') return null
  t = t.replace(TAIL_CAST, '').trim()

  const explicit = EXPLICIT_ALIAS.exec(t)
  if (explicit) return explicit[1].toLowerCase()

  const implicit = IMPLICIT_ALIAS.exec(t)
  if (implicit && !NOT_ALIAS.has(implicit[1].toLowerCase())) {
    // `a.id` 的 `id` 前面是 `.`：那是列引用的一部分，不是别名
    const at = t.length - implicit[0].length
    const before = at > 0 ? t[at - 1] : ''
    if (before !== '.' && !/^\s*$/.test(implicit[0].slice(0, implicit[0].length - implicit[1].length))) {
      return implicit[1].toLowerCase()
    }
  }

  const col = PURE_COLUMN.exec(t)
  if (col) return col[1].toLowerCase()

  const call = PURE_CALL.exec(t)
  if (call) return call[1].toLowerCase()

  return null
}

/** 一个 SELECT 列表里出现的同名输出列 */
function duplicateNames(list: string): Array<{ name: string; count: number; items: string[] }> {
  const body = list.replace(/^\s*distinct(?:\s+on\s*\([^)]*\))?/i, '')
  const byName = new Map<string, string[]>()
  for (const item of splitArgs(body)) {
    const name = outputName(item)
    if (name === null) continue
    byName.set(name, [...(byName.get(name) ?? []), item.trim()])
  }
  return [...byName.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([name, items]) => ({ name, count: items.length, items }))
}

export const aq10 = toGuard({
  id: 'aq10',
  title: '查询结果列名重复（对象化后互相覆盖）',
  invariants: ['INV-CORE-19'],
  code: 'AQ010_DUP_OUTPUT_COLUMN',
  blindSpots: [
    '只判**同一个** SELECT 列表内部的重名；UNION 两半各自重名（合法）不报，跨 UNION 的同名也不报',
    '不可寻址的项（常量 `0`、`CASE … END`、含运算符的表达式）在 PG 里都叫 `?column?`，刻意不参与比较：`SELECT 1, 2` 是合法探测，报了也改不动',
    '`SELECT *` / `t.*` 无法静态展开，整段跳过',
    '写语句的来源子句（`INSERT … SELECT` / `CREATE TABLE … AS SELECT` / `UPDATE … SET x = (SELECT …)`）整段跳过：目标列由写语句指定，列名不进结果对象——不加这条时真实仓库上的命中 7/7 全是这一类误报',
    'SQL 只从**字符串字面量**里读：拼接（"SELECT " + cols）、变量、.sql 文件、ORM 的 query builder 都不在射程',
    '模板串插值 `${...}` 被折叠成一个占位符，插值内部若含逗号，切分位置可能整体偏移（结果一般是不报，不会误报）',
    '不判「列名重复是否真的被按键读取」：SQL 合法但读数错，正是本条要抓的形态；反过来只关心位置取值的人也会被报，属已知误报面',
  ],
  impact:
    'PostgreSQL 给无别名聚合列起名就是函数名：两列 `COUNT(*)` 都叫 `count`，行对象化（Prisma / JSON / ORM 映射）时后一个覆盖前一个。读数静默变错、不抛错，且错的方向常是「看起来更合理」的那一侧',
  provenance:
    '试点 C（2026-10）：对账脚本用两条未别名的 COUNT 同时取分子与分母，对象化后同名键互相覆盖，读数从「0 / 19」显示成「19」；连续两轮人工复核都没发现，直到用另一条 SQL 交叉验算才暴露',
  applies(rel) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|mts)$/.test(rel)) return false
    if (/(^|\/)node_modules\//.test(rel)) return false
    if (/(selftest|fixture|testdata)/i.test(rel)) return false
    return true
  },
  analyze(src): RawHit[] {
    const code = stripComments(src)
    const hits: RawHit[] = []
    for (const re of SQL_LITERALS) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(code)) !== null) {
        const literal = m[0]
        if (!/\bselect\b/i.test(literal)) continue
        const bodyStart = m.index + 1
        // 插值折叠成一个字符：`${}` 里的逗号会把列表切错位，折叠后长度信息不再使用，
        // 所以行号仍按 bodyStart + 段内偏移算——两者必须同源，否则命中位置会漂。
        const sql = literal
          .slice(1, -1)
          .replace(/\$\{[\s\S]*?\}/g, '§')

        for (const sel of sql.matchAll(/\bselect\b/gi)) {
          const at = sel.index ?? 0
          if (isWriteSource(sql, at)) continue
          const from = at + sel[0].length
          const list = sql.slice(from, listEnd(sql, from))
          const dups = duplicateNames(list)
          for (const d of dups) {
            hits.push({
              line: lineOf(src, bodyStart + from),
              message:
                `SELECT 里有 ${d.count} 个列的输出名都是 \`${d.name}\`（${d.items.join(' ｜ ')}）：` +
                '结果行对象化后同名键互相覆盖，读数会静默变错且不抛错；给每一列显式 AS 一个不同的名字',
              evidence: `SELECT${list.trim().slice(0, 120)}`,
            })
          }
        }
      }
    }
    return hits
  },
  fixtures: [
    {
      name: '两条未别名的 COUNT（该报）：分子分母同叫 count，覆盖后只剩一个数',
      expect: 'red',
      src: 'const rows = await prisma.$queryRaw`SELECT COUNT(*)::int, COUNT(*)::int FROM products`\n',
    },
    {
      name: '显式 AS 撞名（该报）：一个来自别名、一个来自列名',
      expect: 'red',
      src: 'const sql = `SELECT a.id AS total, b.total FROM a JOIN b ON b.a_id = a.id`\n',
    },
    {
      name: '两条纯列引用同名（该报）：a.id 与 b.id 都落到 id',
      expect: 'red',
      src: 'const rows = await prisma.$queryRaw`SELECT a.id, b.id FROM a JOIN b ON b.a_id = a.id`\n',
    },
    {
      name: '分子分母都显式别名（不该报）：这是本条的修复形态',
      expect: 'green',
      src: 'const rows = await prisma.$queryRaw`SELECT COUNT(*)::int AS cur, 0::int AS base FROM products`\n',
    },
    {
      name: '两个不同函数（不该报）：count 与 sum 名字本来就不同',
      expect: 'green',
      src: 'const rows = await prisma.$queryRaw`SELECT COUNT(*)::int, SUM(price)::int FROM orders`\n',
    },
    {
      name: '常量探测（不该报）：SELECT 1, 2 都是 ?column?，不可寻址，不参与比较',
      expect: 'green',
      src: 'const r = await prisma.$queryRaw`SELECT 1, 2`\n',
    },
    {
      name: 'SELECT * 与 t.*（不该报）：无法静态展开，整段跳过',
      expect: 'green',
      src: 'const rows = await prisma.$queryRaw`SELECT p.*, s.* FROM products p JOIN specs s ON s.pid = p.id`\n',
    },
    {
      name: '注释里的 SQL（不该报）：去注释先于解析',
      expect: 'green',
      src: '// 旧写法：SELECT COUNT(*)::int, COUNT(*)::int FROM t 曾让读数变成 19\nconst x = 1\n',
    },
    {
      name: 'UNION 两半各自合法（不该报）：各自的 SELECT 列表内部不重名',
      expect: 'green',
      src: 'const s = `SELECT COUNT(*) AS n FROM a UNION ALL SELECT COUNT(*) AS n FROM b`\n',
    },
    {
      name: 'CASE 与常量（不该报）：都是 ?column?，不参与比较',
      expect: 'green',
      src: 'const s = `SELECT CASE WHEN a > 0 THEN 1 ELSE 0 END, 0 FROM t`\n',
    },
    {
      name: 'INSERT INTO … SELECT（不该报）：写语句的结果不进对象，目标列由 INSERT 列表指定',
      expect: 'green',
      src: 'const s = `INSERT INTO rollup (a, b) SELECT SUM(x), SUM(y) FROM t`\n',
    },
    {
      name: 'CREATE TABLE … AS SELECT（不该报）：同上，列名由目标表定',
      expect: 'green',
      src: 'const s = `CREATE TEMP TABLE snap AS SELECT COUNT(*), COUNT(*) FROM t`\n',
    },
    {
      name: '写语句之后另起一条查询（该报）：`;` 是分界，后面这条会进对象',
      expect: 'red',
      src: 'const s = `INSERT INTO t (a) SELECT 1; SELECT COUNT(*)::int, COUNT(*)::int FROM t`\n',
    },
  ],
})
