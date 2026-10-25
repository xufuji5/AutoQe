/**
 * AQ003 · 异常被吞（空 catch / 只打日志不处置）
 *
 * ## 为什么这是病，而且是最贵的一类
 * 吞掉的异常不会消失，它会变成**数据不一致**：写一半的请求、没回滚的资产准备、
 * 没发出去的通知。几个月后表现为「对账差 X 笔」，而那时没人能定位到那个 catch。
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
 * 真正贵的是**写路径**上的吞异常：写一半的请求、没回滚的资产准备 —— 那才是数据不一致的来源。
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

/**
 * 抹掉所有 `logger.*(...)` / `console.*(...)` 调用（含跨行的对象实参），返回剩下的代码。
 *
 * 为什么必须真的「删调用」而不是「看第一行」：第一版用 `body.split('\n')[0]` 判断，
 * 于是 `logger.warn({...})` + `return { ok: false }` 这种**记录+降级**的写法会被报成
 * 「只打日志」——文件头明写「有 return 兜底值不报」，实现却没看第二行。
 * 目标仓实测 36 条里绝大多数正是这一形态。
 */
function withoutLogCalls(body: string): string {
  let out = ''
  let i = 0
  const re = /\b(?:logger|console|log)\.[a-z]+\s*\(/g
  while (i < body.length) {
    re.lastIndex = i
    const m = re.exec(body)
    if (!m) {
      out += body.slice(i)
      break
    }
    out += body.slice(i, m.index)
    // 从 `(` 起括号配对跳过整个调用
    let depth = 0
    let j = m.index + m[0].length - 1
    for (; j < body.length; j++) {
      if (body[j] === '(') depth++
      else if (body[j] === ')') {
        depth--
        if (depth === 0) {
          j++
          break
        }
      }
    }
    i = j
  }
  return out.replace(/[;\s]*/g, '')
}

const CATCH_RE = /\bcatch\s*(?:\([^)]*\))?\s*\{/g

/**
 * 「观测面」写操作：待办信号、审计日志、留证记录、幂等锚。
 *
 * 这些写失败**本身没有更上一层的收口手段**——再抛只会让主流程崩，而丢掉的东西
 * 恰恰是「观测数据」。判据抓的是「业务数据写了一半没人知道」，不是「日志写不进去」。
 * 目标仓实测：8 条剩余命中里有 4 条是这类（写 adminSignal 失败 → logger.error），
 * 把它们算成吞异常，等于要求「记日志失败时必须把主流程也带崩」。
 */
const OBSERVED_MODELS = new Set(['adminSignal', 'auditLog', 'complianceCheckRecord', 'idempotencyToken'])

/**
 * 走**单源写口**落观测面信号（signal.ts 导出的三个函数）。
 *
 * 为什么必须单独认：`WRITE_CALL_RE` 只匹配 `<model>.<op>(` 的**裸写**形态，
 * 而规范化之后仓库纪律要求「禁裸 adminSignal.create，一律走 raiseSignal」。
 * 于是「照规矩改」的那一版反而匹配不到任何 target ⇒ 从 OBSERVED_MODELS 豁免里掉出来 ⇒ 报红。
 * 实测（2026-10-25）：同一文件同一 catch，裸写版 aq03 绿、单源版 aq03 红 ——
 * **判据把「遵守单源」判成了缺陷**，这类判据会逼人回退到违反纪律的写法。
 * 语义上 raiseSignal 就是写 adminSignal（且更强：内部已吞 P2002），必须同等豁免。
 */
const SIGNAL_WRITER_RE = /\b(?:raiseSignal|raiseSignalInTx|tryRaiseSignal)\s*\(/

const WRITE_CALL_RE = /\.(\w+)\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g

/** try 体里**只**写了观测面模型（至少一处写；有业务表写则返回 false） */
function writesOnlyObserved(tryBody: string): boolean {
  WRITE_CALL_RE.lastIndex = 0
  const targets: string[] = []
  let m: RegExpExecArray | null
  while ((m = WRITE_CALL_RE.exec(tryBody)) !== null) targets.push(m[1])
  if (targets.length === 0) {
    // 没有裸写形态：调了单源信号写口，且没有业务表写 ⇒ 与裸写 adminSignal 同属观测面。
    // （有业务表写时 targets 非空，会走到下面 every() 而返回 false —— 分支不会漏。）
    return SIGNAL_WRITER_RE.test(tryBody)
  }
  return targets.every((t) => OBSERVED_MODELS.has(t))
}

// 「收口动作」= 真的把异常交给了别人（抛出/回滚/上报平台/业务告警）。
// **日志不在此列**：日志是给自己看的，事故不会因为写进日志而被处置。
// 第一版把 logger.error 也算收口，于是「只打一行 error 日志」的写路径反而判绿——
// 那是本规则最该抓的形态，却因为它自己写了 error 而豁免。
const SWALLOW_ACTIONS =
  /\b(throw|reject|Report|report|alert|notify|rollback|\$transaction|Sentry|captureException|ApiError|HttpError|raiseSignal|tryRaiseSignal)\b/

export const aq03 = toGuard({
  id: 'aq03',
  title: '异常被吞（空 catch / 只打日志）',
  invariants: ['INV-CORE-17'],
  code: 'AQ003_SWALLOWED_ERROR',
  blindSpots: [
      '只看 catch 体内最强的动作，不判断被吞的异常该不该被吞（`catch { return null }` 常是刻意降级）',
      '跨函数收口（错误在调用者处被处理）不可见——本规则会算作已处置，可能漏报',
      '未 await 的 promise 拒斥（unhandledRejection）不属 catch 形态，不在射程',
      '**业务表写失败 + `logger.warn/info` + 无其他动作 → 判绿**：判据把 warn/info 读作「已知且可容忍」的声明。这是降误报的代价，不是覆盖。真要判它，需要「下游有没有重收敛机制」的信息，静态判据拿不到（同 _writesOnlyObserved_ 的推理）。',
    ],
  impact: '异常不消失而是变成数据不一致：写一半的请求、没回滚的资产准备，几个月后表现为对账差账',
  provenance: "外部试点 A 的 catch 分级守卫（按「catch 体内最强的收口动作」定级）+ 外部试点 B（2026-10）多次「回滚失败被吞」事故",
  applies(rel) {
    if (!/\.(ts|tsx|js|mjs|mts)$/.test(rel)) return false
    if (/\.(test|spec)\./.test(rel)) return false
    // 探针/种子脚本**制造状态**，它们的 catch 就是在断言「这一步该失败」，
    // 打成 error 日志是探针自己的留痕，不是业务写路径的吞异常。
    // 与 aq02/aq09 的取舍同一理由：把探针拉进来只会让读数失真。
    if (/(^|\/)(smoke|seed|fixture|mock|probe)[\w.-]*\.(ts|tsx|js|mjs|mts)$/i.test(rel)) return false
    if (/(^|\/)(__tests__|e2e|fixtures|mocks|seeds)\//.test(rel)) return false
    return true
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
      // 只写观测面（信号/审计/留证/幂等锚）的 try：失败时没有更上一层的收口手段
      const observedOnly = tryBody !== null && writesOnlyObserved(tryBody)

      // 原文块体（index 与剥注释版一致：stripComments 保留长度与换行）
      const rawBlock = blockAfter(src, open)
      const hasReasonComment = rawBlock !== null && /\/\/|\/\*/.test(rawBlock.body)

      const body = digest(block.body)
      if (body === '') {
        if (hasReasonComment) continue // 写了理由的刻意降级
        if (!isWrite) continue // 读路径空 catch：合法回退
        if (observedOnly) continue // 观测面写失败：上层无法收口
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
      if (!onlyLog || !isWrite) continue
      if (observedOnly) continue // 观测面写失败：再抛只会带崩主流程，丢的恰恰是观测数据
      // 【2026-10-24】判据的第二刀：日志之外还有没有别的语句。
      //
      // 文件头承诺「有 return 兜底值但无上报 → 不报（合法的降级）」，但第一版只看
      // 第一行是不是日志调用，于是 `logger.warn({...}); return { ok: false }` 全被报红。
      // 目标仓 36 条里，抽 5 条有 4 条是「记录 + 降级」：解析失败返回 ok:false、
      // 通知失败让主流程继续、补偿槽清理失败但主操作已提交。把这类算成吞异常，
      // 等于要求每个 catch 都 throw —— 那会让「通知失败」把主流程也带崩。
      const rest = withoutLogCalls(block.body)
      if (rest !== '') continue // 日志之后还有动作（return/赋值/状态写）= 已声明降级
      // 只剩日志时再分档：**error 级是「自称事故却没有收口动作」**（自相矛盾，报）；
      // warn/info 是「已知且可容忍」，这是设计选择，不是吞异常。
      if (!/\b(logger|console)\.error\s*\(/.test(block.body)) continue
      hits.push({
        line: lineOf(src, m.index),
        evidence: evidenceOf(src, m.index),
        impact: '写路径的 catch 只打 error 日志、没有任何上报/抛出/回滚：日志没人看，事故靠事后对账发现',
      })
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
      name: '只打 error 日志（该报）',
      expect: 'red',
      src: `try { await save() } catch (e) {\n  console.error('failed', e)\n}\n`,
    },
    {
      name: '只打 warn 日志（不该报）：warn 是「已知且可容忍」的声明',
      expect: 'green',
      src: `try { await save() } catch (e) {\n  logger.warn({ msg: 'notify_failed', error: e.message })\n}\n`,
    },
    {
      name: 'error 日志后有降级返回值（不该报）',
      expect: 'green',
      src: `try { await save() } catch (e) {\n  logger.error({ msg: 'save_failed' })\n  return { ok: false }\n}\n`,
    },
    {
      name: 'warn 日志后有状态写（不该报）：记录 + 降级',
      expect: 'green',
      src: `try { await tx.update({ where: { id }, data: { s: 1 } }) } catch (e) {\n  logger.warn({ msg: 'x' })\n  state = 'pending'\n}\n`,
    },
    {
      name: '只写观测面（adminSignal）失败打日志（不该报）：没有更上一层的收口手段',
      expect: 'green',
      src: `try { await prisma.adminSignal.create({ data: { queue: 'X' } }) } catch (e) {\n  logger.error({ msg: 'signal_failed' })\n}\n`,
    },
    {
      name: '观测面 + 业务表混合写，失败只打日志（该报）',
      expect: 'red',
      src: `try {\n  await prisma.record.create({ data: { id } })\n  await prisma.adminSignal.create({ data: { queue: 'X' } })\n} catch (e) {\n  logger.error({ msg: 'failed' })\n}\n`,
    },
    {
      name: '写业务表失败只打日志（该报）',
      expect: 'red',
      src: `try { await prisma.record.update({ where: { id }, data: { s } }) } catch (e) {\n  logger.error({ msg: 'failed' })\n}\n`,
    },
    {
      name: '抛出（不该报）',
      expect: 'green',
      src: `try { await save() } catch (e) {\n  throw new Error('save failed', { cause: e })\n}\n`,
    },
    {
      // 2026-10-24：项目侧把「落一条待办信号」当作写路径失败的标准收口动作
      // （`raiseSignal` 写 admin_signals 待办队列，运维在待办中心能看到并处理）。
      // 这不是「只打日志」——日志没人读，待办有人结单。词表缺它会把整套收口打成噪音。
      name: 'error 日志 + 落待办信号（不该报）：待办是收口动作，不是日志',
      expect: 'green',
      src: `try { await prisma.record.update({ where: { id }, data: { s } }) } catch (e) {\n  logger.error({ msg: 'failed' })\n  await raiseSignal({ queue: 'X', dedupeKey: 'X:1', title: 'retry me' })\n}\n`,
    },
    {
      // 反证：只有日志、没有收口，仍必须报——防止词表把 raiseSignal 加宽成「任何含 signal 的调用」
      name: 'error 日志 + 只读信号（getSignal，不是收口）（该报）',
      expect: 'red',
      src: `try { await prisma.record.update({ where: { id }, data: { s } }) } catch (e) {\n  logger.error({ msg: 'failed', has: getSignal(e) })\n}\n`,
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
    {
      // 对照组：裸写 adminSignal 一直是豁免的（OBSERVED_MODELS 直接命中）
      name: '裸写 adminSignal + 只打日志（不该报）：观测面写，无更上一层收口手段',
      expect: 'green',
      src: `try { await prisma.adminSignal.create({ data: { queue: 'X' } }) } catch (e) {\n  logger.error({ msg: 'signal_failed' })\n}\n`,
    },
    {
      // 【2026-10-25 修】单源写口与裸写必须同等豁免：仓库纪律要求「禁裸 create，走 raiseSignal」，
      // 判据若只认裸写，就会把「照规矩改」的那一版判红 —— 判据逼人违反单源。
      name: '走单源写口 raiseSignal + 只打日志（不该报）：与裸写 adminSignal 同语义',
      expect: 'green',
      src: `try {\n  await raiseSignal({ queue: 'X', dedupeKey: 'X:1', title: 't' })\n} catch (e) {\n  logger.error({ msg: 'signal_failed' })\n}\n`,
    },
    {
      // 反证：单源写口不能变成「任何含 signal 的写都能豁免」——只要同一 try 里写了业务表，仍必须报
      name: '业务表写 + 单源信号写口 + 只打日志（该报）：业务数据写了一半才是真洞',
      expect: 'red',
      src: `try {\n  await prisma.order.update({ where: { id }, data: { s } })\n  await raiseSignalInTx(tx, { queue: 'X', dedupeKey: 'X:1', title: 't' })\n} catch (e) {\n  logger.error({ msg: 'failed' })\n}\n`,
    },
    {
      // 反证：只是名字里带 signal 的读取（getSignal）不算写口
      name: '业务表写 + getSignal 读取（不是写口）+ 只打日志（该报）',
      expect: 'red',
      src: `try {\n  await prisma.order.update({ where: { id }, data: { s } })\n  const cur = getSignal(id)\n} catch (e) {\n  logger.error({ msg: 'failed' })\n}\n`,
    },
  ],
})
