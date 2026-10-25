/**
 * oracle 声明的校验器（纯函数，无 I/O）。
 *
 * 分两段用：
 *   - `checkRuleOracle`：`toGuard` 在**导入期**调用，只做「不通过就不许跑」的硬门；
 *   - `validateOracles`：`scripts/verify-rule-oracles.ts` 调用，做全表 + registry 引用 + 期限的软门。
 *
 * 两段共用同一份判据，避免「脚本说合格、运行时又放行」的两份答案。
 */

import type { Invariant } from '../registry/types.ts'
import type { RuleOracle } from '../registry/rule-oracles.ts'

export type RuleLevel = 'error' | 'warn' | 'info'

export interface OracleIssue {
  rule: string
  code: string
  message: string
}

/** 模糊来源词：出现即视为「不可复算的口头依据」 */
const VAGUE = ['经验', '惯例', '一般来说', '一般来说', '通常认为', '感觉', '应该没问题', '约定俗成']

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function isIso(d: string): boolean {
  if (!ISO_DATE.test(d)) return false
  const t = Date.parse(d)
  return !Number.isNaN(t)
}

/** 单条规则的硬门（导入期）：缺声明、human 档却标 error —— 两种都不许跑 */
export function checkRuleOracle(id: string, oracle: RuleOracle | undefined, level: RuleLevel): OracleIssue[] {
  const out: OracleIssue[] = []
  if (!oracle) {
    out.push({
      rule: id,
      code: 'ORACLE_MISSING',
      message: `规则 ${id} 未在 qe/registry/rule-oracles.ts 登记 oracle：答不出真值来源的判据不许跑`,
    })
    return out
  }
  if (oracle.kind === 'human' && level === 'error') {
    out.push({
      rule: id,
      code: 'ORACLE_HUMAN_AS_ERROR',
      message: `规则 ${id} 的 oracle 是 human（真值在人脑/环境里），却声明 level=error：机器只能出候选，不许升级成红`,
    })
  }
  return out
}

/** 全表软门（CI）：结构、期限、registry 引用、候选池上限 */
export function validateOracles(opts: {
  oracles: Record<string, RuleOracle>
  ruleLevels: Record<string, RuleLevel>
  registry: Invariant[]
  /** 注入「今天」，保证校验器可复现 */
  today: string
  /** 候选池上限：超过这个数说明「待裁决」又在堆积 */
  humanCap?: number
}): OracleIssue[] {
  const { oracles, ruleLevels, registry, today } = opts
  const cap = opts.humanCap ?? 3
  const issues: OracleIssue[] = []
  const byId = new Map(registry.map((i) => [i.id, i]))

  for (const id of Object.keys(ruleLevels)) {
    if (!oracles[id]) {
      issues.push({ rule: id, code: 'ORACLE_MISSING', message: `规则 ${id} 没有 oracle 声明` })
    }
  }

  let humanCount = 0
  for (const [id, o] of Object.entries(oracles)) {
    if (!(id in ruleLevels)) {
      issues.push({ rule: id, code: 'ORACLE_DEAD', message: `oracle 表登记了不存在的规则 ${id}（死条目）` })
      continue
    }
    const level = ruleLevels[id]
    const source = o.source.trim()
    if (source.length < 12) {
      issues.push({ rule: id, code: 'ORACLE_NO_SOURCE', message: `oracle.source 过短（${source.length} 字符）：写不出可复算的事实来源` })
    }
    const vague = VAGUE.find((v) => source.includes(v))
    if (vague) {
      issues.push({ rule: id, code: 'ORACLE_VAGUE_SOURCE', message: `oracle.source 含不可复算的表述「${vague}」：换成人能复算的事实` })
    }
    if (o.kind !== 'machine' && o.kind !== 'human') {
      issues.push({ rule: id, code: 'ORACLE_BAD_KIND', message: `oracle.kind=${String(o.kind)} 非法（只允许 machine / human）` })
      continue
    }

    for (const ref of o.guardedBy) {
      const inv = byId.get(ref)
      if (!inv) {
        issues.push({ rule: id, code: 'ORACLE_GUARD_UNKNOWN', message: `guardedBy 指向不存在的不变量 ${ref}` })
      } else if (o.kind === 'human' && inv.status !== 'enforced') {
        issues.push({
          rule: id,
          code: 'ORACLE_GUARD_NOT_ENFORCED',
          message: `human 档的 oracle 载体由 ${ref} 守，但它是 ${inv.status}：载体自己没人守，没资格评价别人`,
        })
      }
    }

    if (o.kind === 'human') {
      humanCount++
      if (level === 'error') {
        issues.push({ rule: id, code: 'ORACLE_HUMAN_AS_ERROR', message: `human 档规则 ${id} 声明了 error：只允许 warn/info` })
      }
      if (o.guardedBy.length === 0) {
        issues.push({ rule: id, code: 'ORACLE_HUMAN_NO_GUARD', message: `human 档必须写明谁守 oracle 载体（guardedBy）` })
      }
      if (!o.why || o.why.trim().length < 8) {
        issues.push({ rule: id, code: 'ORACLE_HUMAN_NO_WHY', message: `human 档必须写 why：缺哪块事实、由谁裁决` })
      }
      if (!o.promoteBy || !isIso(o.promoteBy)) {
        issues.push({ rule: id, code: 'ORACLE_HUMAN_NO_PROMOTE', message: `human 档必须写合法 promoteBy（YYYY-MM-DD）` })
      } else if (Date.parse(o.promoteBy) < Date.parse(today)) {
        issues.push({
          rule: id,
          code: 'ORACLE_PROMOTE_OVERDUE',
          message: `human 档的升级期限 ${o.promoteBy} 已过（今天 ${today}）：到期未升级即红`,
        })
      }
    }
  }

  if (humanCount > cap) {
    issues.push({
      rule: '(pool)',
      code: 'ORACLE_HUMAN_POOL_OVERFLOW',
      message: `human 档候选池 ${humanCount} 条，超过上限 ${cap}：候选池会变成第二个人工待办池`,
    })
  }

  return issues
}
