/**
 * AQ014 · 并发冲突的兜底写在事务体内（事务已中止，回读只会再失败）
 *
 * ## 真实事故形态
 *
 * 一个余额/账本类写入口，并发防重靠数据库唯一索引，兜底写在「撞索引之后」：
 *
 * ```ts
 * // 幂等快路：先查有没有，没有就建（并发下两人同时查到空 —— 快路不存在）
 * const dup = await tx.ledger.findUnique({ where: { refType_refId_action: key } })
 * if (dup) return { applied: false }
 * return prisma.$transaction(async (tx) => {
 *   try {
 *     await tx.ledger.create({ data: key })
 *     return { applied: true }
 *   } catch (err) {
 *     if (!isUniqueViolation(err)) throw err
 *     const again = await tx.ledger.findUnique({ where: { refType_refId_action: key } })  // ← 永远不会成功
 *     return { applied: false, entryId: again.id }
 *   }
 * })
 * ```
 *
 * 输家确实被唯一索引挡住了，但 `catch` 里的回读**必然再抛一次**：
 * PostgreSQL 的规定是「一条语句出错后，事务进入 aborted 状态，后续任何语句都返回 25P02
 * `current transaction is aborted`」。于是原本的兜底动作把 P2002 换成了另一个错，
 * 一起冒成 500。调用方若是支付网关回调 —— 见 500 就重试，重试又撞同一个键 ——
 * **死循环式 500**，账面上永远差那一笔。
 *
 * ## 为什么这条判据必须单独存在
 *
 * 同仓的 AQ004 只要求「窗口内出现过 P2002 / isUniqueViolation 之类的词」就判为已保护。
 * 词表是对的，**层级是错的**：`catch` 写在事务回调里时，那个词一个不少地都在，
 * 于是 AQ004 判绿 —— 假绿。判据看不见的缺陷比没判据更贵，因为它同时关掉了人的怀疑。
 * 所以这里不扩充 AQ004 的词表（那会让它更绿），而是新增一条判「层级」的规则。
 *
 * ## 判据（两条，都在事务回调区间内找 catch 块）
 *
 * | 形态 | 结论 |
 * |---|---|
 * | catch 体内再次出现事务句柄（`tx.`） | 红 —— 无论它想干什么，事务已 aborted |
 * | catch 体内有唯一冲突词表，且**不只是重抛** | 红 —— 兜底动作落在事务内 |
 * | catch 体内只有 `throw`（条件重抛也算） | 不报 —— 它没打算在事务里做事 |
 * | catch 在事务回调**外层** | 不报 —— 这正是修复形态 |
 *
 * ## 修复形态
 *
 * 把 `try { return prisma.$transaction(...) } catch (err) { … }` 搬到事务**外面**：
 * 事务失败后事务已结束，此时用**普通客户端**（不是 `tx`）回读，才能读到赢家那一行。
 *
 * ## 为什么用「区间包含」而不是「向后 N 行」
 *
 * 行窗在嵌套结构上必错：一个 40 行窗口能从事务回调里跨到外面那层 catch，
 * 也能从不含事务的文件里跨进来。区间由括号配对算出，与缩进/行数无关。
 * 认不出回调边界（具名函数引用、参数解构）时**不报** —— 看不清不等于有缺陷。
 */
import { braceBody, escapeRe, maskStringBodies, matchDelimiter, stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'

/** 交互式事务入口。数组形态（`$transaction([a, b])`）没有回调，不含 catch，自然不报名 */
const TX_RE = /\$transaction\s*\(/g
/** catch 子句（含裸 `catch {`） */
const CATCH_RE = /\bcatch\s*(?:\([^)]*\))?\s*\{/g
/**
 * 唯一冲突词表：**只用来判「这个 catch 想兜底」**，不用来判「有保护」。
 * 与 AQ004 的词表刻意不同源：那边是「有没有提到」，这边是「提到之后做了什么」。
 */
const UNIQUE_VOCAB =
  /(P2002|isUniqueViolation|uniqueViolation|UniqueConstraintError|23505|ON\s+CONFLICT|duplicate key|23505|唯一约束|唯一键冲突)/i

/** 从 `$transaction(` 的实参里取回调的参数名（事务句柄）；认不出返回 null */
function handleName(arg: string): string | null {
  const forms = [
    /^\s*(?:async\s*)?\(\s*([A-Za-z_$][\w$]*)/, // async (tx) => / (tx) =>
    /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/, // async tx => / tx =>
    /^\s*(?:async\s+)?function\s*[\w$]*\s*\(\s*([A-Za-z_$][\w$]*)/, // function (tx) {
  ]
  for (const f of forms) {
    const m = f.exec(arg)
    if (m) return m[1]
  }
  return null
}

/** 跳过空白后的下标 */
function skipWs(code: string, i: number): number {
  let k = i
  while (k < code.length && /\s/.test(code[k])) k++
  return k
}

/**
 * catch 体是否**只是重抛**：把 `throw …` 语句与 `if (…)` 头去掉后，剩下的只有括号/分号/空白。
 * 那就是纯重抛，事务内做这件事无害（错误照样冒到外层，由外层兜底）。
 *
 * ## 为什么不能用「行首是不是 throw」判
 *
 * 最常见的重抛写法是**带括号块的条件重抛**：
 *
 * ```ts
 * catch (err) {
 *   if (!isUniqueViolation(err)) {
 *     throw err
 *   }
 * }
 * ```
 *
 * 逐行判会把 `if (…) {` 那一行当成「非重抛内容」，于是在**正确代码**上判红。
 * 实测：本规则第一版 8 个自证例里有 1 个这样红掉 —— 而那一例正是修复后的标准形态。
 * 判据过严的代价不是「多几条误报」，是**教人把判据改松**（下一个人会直接把整条规则关掉）。
 * 所以这里按语句形态削，不按行。
 *
 * 已知代价：多行 `throw new Error(\n  someIdent,\n)` 的续行里若有标识符，会被当成动作 → 偏红。
 * 这种形态在「唯一冲突兜底」的 catch 里几乎不存在（兜底是回读 + 幂等返回，不是构造富错误对象）。
 */
function rethrowOnly(body: string): boolean {
  const rest = body
    .replace(/\bthrow\b[^\n;]*/g, ' ') // throw 语句（到分号或行尾；字符串已被掩码，不会吃掉代码）
    .replace(/\bif\s*\([^)]*\)/g, ' ') // if 头：条件本身不构成动作
    .replace(/\belse\b/g, ' ')
    .replace(/[{}();,]/g, ' ')
    .replace(/\s+/g, '')
  return rest === ''
}

type TxRange = { start: number; end: number; handle: string; openParen: number }

/** 收集全部「内联块体」事务回调的区间（绝对偏移，闭开区间） */
export function txCallbackRanges(code: string): TxRange[] {
  const out: TxRange[] = []
  TX_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TX_RE.exec(code)) !== null) {
    const openParen = m.index + m[0].length - 1
    const closeParen = matchDelimiter(code, openParen)
    if (closeParen < 0) continue
    const argStart = openParen + 1
    // 必须是箭头函数：`$transaction([a, b])` / `$transaction(fn)` 具名引用都跳过
    const arrowAt = code.indexOf('=>', argStart)
    if (arrowAt < 0 || arrowAt > closeParen) continue
    const braceAt = skipWs(code, arrowAt + 2)
    if (code[braceAt] !== '{') continue // 表达式体没有块，不存在 catch
    const body = braceBody(code, braceAt)
    if (body === null) continue
    const handle = handleName(code.slice(argStart, arrowAt))
    if (!handle) continue // 参数解构 / 认不出句柄名 → 不判（盲区）
    out.push({ start: braceAt + 1, end: braceAt + 1 + body.length, handle, openParen })
  }
  return out
}

export const aq14 = toGuard({
  id: 'aq14',
  title: '并发冲突的兜底写在事务体内（事务已中止）',
  invariants: ['INV-DB-04', 'INV-DB-01'],
  code: 'AQ014_TX_SCOPED_FALLBACK',
  blindSpots: [
    '只认内联块体回调 `$transaction(async (tx) => { … })`；回调抽成具名函数、或参数解构（`async ({ tx })`）时不判定',
    '不判「兜底在事务外、但读的是事务内已写入但未提交的数据」这类顺序问题（那是另一条不变量）',
    '嵌套事务按最外层区间判，内层区间不单独报；`$transaction` 被包在自定义包装器里时看不到边界',
    '多行 `throw new Error(…)` 的续行若含标识符，会被当成「非重抛内容」→ 偏红（宁可多报一句）',
  ],
  impact:
    '兜底写在事务内 = 没有兜底：P2002 之后事务已 aborted，回读再抛 25P02，冒成 500；调用方（支付回调/队列）见 500 重试又撞同一个键 → 循环失败',
  provenance:
    '外部试点 D（2026-10-25）：资金账本唯一写入口的幂等快路在并发下不存在，输家撞唯一索引后把 P2002 冒成 500；修复时必须把 catch 移到事务外层，事务内回读实测报 `current transaction is aborted`',
  applies(rel) {
    return /\.(ts|tsx|js|mjs|mts|cjs)$/.test(rel)
  },
  analyze(src, _rel, _ctx: RuleCtx): RawHit[] {
    // 结构判定用抹掉字符串内容的代码面：SQL 与错误文案里的括号/大括号不得参与配对
    const code = maskStringBodies(stripComments(src))
    const ranges = txCallbackRanges(code)
    if (ranges.length === 0) return []
    const hits: RawHit[] = []
    const seen = new Set<number>()
    CATCH_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = CATCH_RE.exec(code)) !== null) {
      const outer = ranges.find((r) => m !== null && m.index > r.start && m.index < r.end)
      if (!outer) continue
      const braceAt = m.index + m[0].length - 1
      const body = braceBody(code, braceAt)
      if (body === null) continue
      const usesHandle = new RegExp(`\\b${escapeRe(outer.handle)}\\s*\\.`).test(body)
      const wantsFallback = UNIQUE_VOCAB.test(body) && !rethrowOnly(body)
      if (!usesHandle && !wantsFallback) continue
      if (seen.has(m.index)) continue
      seen.add(m.index)
      hits.push({
        line: lineOf(src, m.index),
        evidence: evidenceOf(src, m.index),
        impact: usesHandle
          ? `catch 在 $transaction 回调内仍然使用事务句柄 ${outer.handle}：语句级错误后事务已 aborted（25P02），事务内任何回读/写入都会再抛一次`
          : '唯一冲突的兜底动作写在 $transaction 回调内：P2002 之后事务已 aborted，兜底必须移到事务外层并用普通客户端回读',
      })
    }
    return hits
  },
  fixtures: [
    {
      name: '事务内回读幂等行（该报：最贵的一种）',
      expect: 'red',
      src: `export async function postEntry(key: EntryKey) {
  return prisma.$transaction(async (tx) => {
    try {
      await tx.ledger.create({ data: key })
      return { applied: true, entryId: null }
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      const again = await tx.ledger.findUnique({ where: { refType_refId_action: key } })
      return { applied: false, entryId: again.id }
    }
  })
}
`,
    },
    {
      name: '事务内兜底但不碰句柄（该报：只是换了个错而已）',
      expect: 'red',
      src: `await prisma.$transaction(async (tx) => {
  try {
    await tx.signal.create({ data: { dedupeKey: key } })
    return true
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    return false
  }
})
`,
    },
    {
      name: '兜底移到事务外层（不该报：这就是修复形态）',
      expect: 'green',
      src: `let out
try {
  out = await prisma.$transaction(async (tx) => {
    await tx.ledger.create({ data: key })
    return { applied: true, entryId: null }
  })
} catch (err) {
  if (!isUniqueViolation(err)) throw err
  const dup = await prisma.ledger.findUnique({ where: { refType_refId_action: key } })
  out = { applied: false, entryId: dup?.id ?? null }
}
return out
`,
    },
    {
      name: '事务内只重抛（不该报：它没打算在事务里做事）',
      expect: 'green',
      src: `await prisma.$transaction(async (tx) => {
  try {
    await tx.order.update({ where: { id }, data: { status: 'paid' } })
  } catch (err) {
    throw err
  }
})
`,
    },
    {
      name: '条件重抛且无回读（不该报）',
      expect: 'green',
      src: `await prisma.$transaction(async (tx) => {
  try {
    await tx.stock.update({ where: { id }, data: { sold: { increment: 1 } } })
  } catch (err) {
    if (!isUniqueViolation(err)) {
      throw err
    }
  }
})
`,
    },
    {
      name: '数组形态事务（不该报：没有回调）',
      expect: 'green',
      src: `await prisma.$transaction([
  prisma.order.update({ where: { id }, data: { status: 'paid' } }),
  prisma.stock.update({ where: { id }, data: { sold: { increment: 1 } } }),
])
`,
    },
    {
      name: '事务内吞掉非唯一错误（不该报：那是 AQ003 的射程）',
      expect: 'green',
      src: `await prisma.$transaction(async (tx) => {
  try {
    await tx.cache.delete({ where: { key } })
  } catch (err) {
    console.error('cache purge failed', err)
  }
})
`,
    },
    {
      name: '参数解构的事务回调（不该报：边界认不出，按盲区放过）',
      expect: 'green',
      src: `await prisma.$transaction(async ({ tx }) => {
  try {
    await tx.ledger.create({ data: key })
  } catch (err) {
    const again = await tx.ledger.findUnique({ where: { id: key } })
    return again
  }
})
`,
    },
  ],
})
