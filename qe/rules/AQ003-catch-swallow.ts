/**
 * AQ003 · 异常被吞（空 catch / 只打日志不处置）
 *
 * ## 为什么这是病，而且是最贵的一类
 * 吞掉的异常不会消失，它会变成**数据不一致**：写一半的订单、没回滚的库存、
 * 没发出去的退款通知。几个月后表现为「对账差 X 笔」，而那时没人能定位到那个 catch。
 *
 * 判据只看「catch 体内最强的收口动作」，四档：
 *   - 空体 / 只有注释            → hit（high）
 *   - 只有 console.* / logger.*  → hit（medium）—— 记录不等于处置
 *   - 有 return 兜底值但无上报    → 不报（这是合法的降级，语义对不对由行为探针管）
 *   - 有 throw / 上报 / 事务回滚  → 不报
 *
 * ## 误报边界（首轮实测教训，2026-10-24）
 * `catch { return null }` 是**刻意**的降级（例如「查不到」），静态判据无法区分
 * 「查不到」与「真出错」—— 这正是行为探针（fault-inject）的射程，不是本规则的。
 *
 * 第一版只按「catch 体形态」判，在试点 A 上报了 122 处，绝大多数是**读路径的合法降级**：
 * 读 marker 文件失败就回退到空值（备份尚未执行过）—— 那完全正确。
 * 真正贵的是**写路径**上的吞异常：写一半的订单、没回滚的库存 —— 那才是数据不一致的来源。
 *
 * 所以第二版加了前置条件：**try 体里必须有写操作**，否则不报。
 * 判据从「catch 长什么样」变成「catch 吞掉的是不是一次写」。
 */
import { stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'

/** 写操作特征（try 体里出现即视为写路径） */
const WRITE_SIGNAL =
  /\b(create|createMany|update|updateMany|upsert|delete|deleteMany|save|insert|INSERT|UPDATE|DELETE|transaction|\$executeRaw|publish|dispatch|send|commit|charge|refund|grant|revoke)\b/

/**
 * 取 catch 之前那个 try 的块体（catch 前面可以是 `} catch`，中间可能有 else/finally）。
 * 找不到返回 null —— 那时按「无法判定是否写路径」处理，**不报**（宁少不多）。
 */
export function precedingTryBody(code: string, catchIndex: number): string | null {
  // 从 catch 往回找第一个非空白的 `}`
  let i = catchIndex - 1
  while (i >= 0 && /\s/.test(code[i])) i--
  if (code[i] !== '}') return null
  // 反向平衡找到配对的 `{`
  let depth = 0
  let open = -1
  for (let j = i; j >= 0; j--) {
    if (code[j] === '}') depth++
    else if (code[j] === '{') {
      depth--
      if (depth === 0) {
        open = j
        break
      }
    }
  }
  if (open < 0) return null
  // 该 `{` 前面应当是 try（容忍 `try` 与 `{` 之间空白/换行）
  const back = code.slice(Math.max(0, open - 40), open)
  if (!/\btry\s*$/.test(back)) return null
  return code.slice(open + 1, i)
}

/** 从 `{` 位置取配对块内容（不含花括号）；找不到返回 null */
export function blockAfter(code: string, openBrace: number): { start: number; end: number; body: string } | null {
  if (code[openBrace] !== '{') return null
  let depth = 0
  for (let i = openBrace; i < code.length; i++) {
    const c = code[i]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return { start: openBrace + 1, end: i, body: code.slice(openBrace + 1, i) }
    }
  }
  return null
}

/** 去掉块内的字符串与嵌套结构，只看顶层语句形态（粗略但足够） */
function digest(body: string): string {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//'))
    .join('\n')
}

const CATCH_RE = /\bcatch\s*(?:\([^)]*\))?\s*\{/g

const SWALLOW_ACTIONS =
  /\b(throw|reject|Report|report|alert|notify|rollback|\$transaction|Sentry|captureException|logger\.error|console\.error|ApiError|HttpError)\b/

export const aq03 = toGuard({
  id: 'aq03',
  title: '异常被吞（空 catch / 只打日志）',
  invariants: ['INV-CORE-17'],
  code: 'AQ003_SWALLOWED_ERROR',
  blindSpots: [
      '只看 catch 体内最强的动作，不判断被吞的异常该不该被吞（`catch { return null }` 常是刻意降级）',
      '跨函数收口（错误在调用者处被处理）不可见——本规则会算作已处置，可能漏报',
      '未 await 的 promise 拒斥（unhandledRejection）不属 catch 形态，不在射程',
    ],
  impact: '异常不消失而是变成数据不一致：写一半的订单、没回滚的库存，几个月后表现为对账差账',
  provenance: "外部试点 A 的 catch 分级守卫（按「catch 体内最强的收口动作」定级）+ 外部试点 B（2026-10）多次「回滚失败被吞」事故",
  applies(rel) {
    return /\.(ts|tsx|js|mjs|mts)$/.test(rel) && !/\.(test|spec)\./.test(rel)
  },
  analyze(src, rel): RawHit[] {
    const code = stripComments(src)
    const hits: RawHit[] = []
    let m: RegExpExecArray | null
    CATCH_RE.lastIndex = 0
    while ((m = CATCH_RE.exec(code)) !== null) {
      const open = code.indexOf('{', m.index)
      const block = blockAfter(code, open)
      if (!block) continue

      // 前置条件：catch 吞掉的是不是一次**写**。读路径的回退（marker 不存在 → 空值）是正确写法，
      // 把它当洞会让规则在首轮就淹掉真问题。
      const tryBody = precedingTryBody(code, m.index)
      const isWrite = tryBody !== null && WRITE_SIGNAL.test(tryBody)

      // 原文块体（index 与剥注释版一致：stripComments 保留长度与换行）
      const rawBlock = blockAfter(src, open)
      const hasReasonComment = rawBlock !== null && /\/\/|\/\*/.test(rawBlock.body)

      const body = digest(block.body)
      if (body === '') {
        if (hasReasonComment) continue // 写了理由的刻意降级
        if (!isWrite) continue // 读路径空 catch：合法回退
        hits.push({
          line: lineOf(src, m.index),
          evidence: evidenceOf(src, m.index),
          impact: '写路径上的空 catch：异常被彻底丢弃，写了一半没人知道',
        })
        continue
      }
      const hasAction = SWALLOW_ACTIONS.test(body)
      // 只有日志、没有任何上报/抛出/回滚
      const onlyLog = !hasAction && /^(console|logger|log)\./.test(body.split('\n')[0] ?? '')
      if (onlyLog && isWrite) {
        hits.push({
          line: lineOf(src, m.index),
          evidence: evidenceOf(src, m.index),
          impact: '写路径的 catch 只打日志，没有任何上报/抛出/回滚：日志没人看，事故靠事后对账发现',
        })
      }
    }
    return hits
  },
  fixtures: [
    {
      name: '空 catch（该报）',
      expect: 'red',
      src: `try { await save() } catch (e) { }\n`,
    },
    {
      name: '写路径 catch 无参数空体（该报）',
      expect: 'red',
      src: `try { await save() } catch {\n}\n`,
    },
    {
      name: '写路径空 catch 但写了理由（不该报）',
      expect: 'green',
      src: `try { await save() } catch {\n  // 幂等重复写入，忽略\n}\n`,
    },
    {
      name: '读路径空 catch（不该报）',
      expect: 'green',
      src: `try {\n  const raw = readFileSync(marker, 'utf8')\n} catch {\n}\n`,
    },
    {
      name: '只打日志（该报）',
      expect: 'red',
      src: `try { await save() } catch (e) {\n  console.log('failed', e)\n}\n`,
    },
    {
      name: '抛出（不该报）',
      expect: 'green',
      src: `try { await save() } catch (e) {\n  throw new Error('save failed', { cause: e })\n}\n`,
    },
    {
      name: '上报后降级（不该报）',
      expect: 'green',
      src: `try { await save() } catch (e) {\n  reportError(e)\n  return { ok: false }\n}\n`,
    },
    {
      name: '事务回滚（不该报）',
      expect: 'green',
      src: `try { await tx.commit() } catch (e) {\n  await tx.rollback()\n  throw e\n}\n`,
    },
  ],
})
