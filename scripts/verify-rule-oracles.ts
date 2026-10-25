/**
 * oracle 声明制的自证（先红后绿）。
 *
 * 纪律：一个「校验器」若只跑在真实表上，它红了也说不清是表坏了还是校验器坏了。
 * 所以这里先用**合成的坏表**逐条钉住每个判据（每条都必须红），再用真实表跑一次（必须绿）。
 *
 * 输出单行机器读数：`RULE_ORACLES passed=N failed=0`
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { Guard } from '../qe/lib/guard.ts'
import type { Invariant } from '../qe/registry/types.ts'
import { registry } from '../qe/registry/registry.ts'
import { RULE_ORACLES, type RuleOracle } from '../qe/registry/rule-oracles.ts'
import { validateOracles, type OracleIssue, type RuleLevel } from '../qe/lib/rule-oracle-check.ts'

const ROOT = path.join(import.meta.dirname, '..')
const RULES_DIR = path.join(ROOT, 'qe/rules')
const TODAY = new Date().toISOString().slice(0, 10)

let cases = 0
function check(name: string, fn: () => void): void {
  cases++
  try {
    fn()
    console.log(`OK ${name}`)
  } catch (e) {
    console.error(`FAIL ${name}`)
    throw e
  }
}

/** 合成 registry：只用于验证校验器本身 */
const FAKE_REGISTRY: Invariant[] = [
  { id: 'INV-OK', statement: '已强制', defectClasses: ['隐性陷阱'], status: 'enforced', guard: 'x', badSample: 'x' },
  { id: 'INV-LOOSE', statement: '只部分', defectClasses: ['隐性陷阱'], status: 'partial', gap: 'x' },
]

const GOOD: RuleOracle = {
  source: 'schema 的 enum 取值清单 × 全仓字面量出现位置',
  kind: 'machine',
  guardedBy: ['INV-OK'],
}

function run(oracles: Record<string, RuleOracle>, levels: Record<string, RuleLevel>, cap = 3): OracleIssue[] {
  return validateOracles({ oracles, ruleLevels: levels, registry: FAKE_REGISTRY, today: '2026-10-25', humanCap: cap })
}

const HUMAN_OK: RuleOracle = {
  source: '文档库的字段表 × 实现里的录入框位置',
  kind: 'human',
  guardedBy: ['INV-OK'],
  promoteBy: '2027-03-31',
  why: '文档是否已过期需要人裁决',
}

/* ---------- 坏样本：每条判据都必须能红 ---------- */
check('未登记 oracle 的规则必须红（ORACLE_MISSING）', () => {
  const issues = run({}, { r1: 'error' })
  assert.deepEqual(issues.map((i) => i.code), ['ORACLE_MISSING'])
})

check('oracle 表里的死条目必须红（ORACLE_DEAD）', () => {
  const issues = run({ r1: GOOD, ghost: GOOD }, { r1: 'error' })
  assert.deepEqual(issues.map((i) => i.code), ['ORACLE_DEAD'])
})

check('human 档声明 error 必须红（ORACLE_HUMAN_AS_ERROR）', () => {
  const issues = run({ r1: HUMAN_OK }, { r1: 'error' })
  assert.ok(issues.some((i) => i.code === 'ORACLE_HUMAN_AS_ERROR'), JSON.stringify(issues))
})

check('human 档缺 why 必须红（ORACLE_HUMAN_NO_WHY）', () => {
  const issues = run({ r1: { ...HUMAN_OK, why: '' } }, { r1: 'warn' })
  assert.ok(issues.some((i) => i.code === 'ORACLE_HUMAN_NO_WHY'), JSON.stringify(issues))
})

check('human 档缺升级期限必须红（ORACLE_HUMAN_NO_PROMOTE）', () => {
  const issues = run({ r1: { ...HUMAN_OK, promoteBy: undefined } }, { r1: 'warn' })
  assert.ok(issues.some((i) => i.code === 'ORACLE_HUMAN_NO_PROMOTE'), JSON.stringify(issues))
})

check('human 档升级期限已过必须红（ORACLE_PROMOTE_OVERDUE）', () => {
  const issues = run({ r1: { ...HUMAN_OK, promoteBy: '2026-01-01' } }, { r1: 'warn' })
  assert.ok(issues.some((i) => i.code === 'ORACLE_PROMOTE_OVERDUE'), JSON.stringify(issues))
})

check('human 档没写谁守载体必须红（ORACLE_HUMAN_NO_GUARD）', () => {
  const issues = run({ r1: { ...HUMAN_OK, guardedBy: [] } }, { r1: 'warn' })
  assert.ok(issues.some((i) => i.code === 'ORACLE_HUMAN_NO_GUARD'), JSON.stringify(issues))
})

check('human 档的载体守卫不是 enforced 必须红（ORACLE_GUARD_NOT_ENFORCED）', () => {
  const issues = run({ r1: { ...HUMAN_OK, guardedBy: ['INV-LOOSE'] } }, { r1: 'warn' })
  assert.ok(issues.some((i) => i.code === 'ORACLE_GUARD_NOT_ENFORCED'), JSON.stringify(issues))
})

check('guardedBy 指向不存在的不变量必须红（ORACLE_GUARD_UNKNOWN）', () => {
  const issues = run({ r1: { ...GOOD, guardedBy: ['INV-NOPE'] } }, { r1: 'error' })
  assert.ok(issues.some((i) => i.code === 'ORACLE_GUARD_UNKNOWN'), JSON.stringify(issues))
})

check('不可复算的来源表述必须红（ORACLE_VAGUE_SOURCE）', () => {
  const issues = run({ r1: { ...GOOD, source: '按经验判断，一般来说没问题' } }, { r1: 'error' })
  assert.ok(issues.some((i) => i.code === 'ORACLE_VAGUE_SOURCE'), JSON.stringify(issues))
})

check('human 候选池超上限必须红（ORACLE_HUMAN_POOL_OVERFLOW）', () => {
  const issues = run(
    { a: HUMAN_OK, b: HUMAN_OK, c: HUMAN_OK, d: HUMAN_OK },
    { a: 'warn', b: 'warn', c: 'warn', d: 'warn' },
  )
  assert.ok(issues.some((i) => i.code === 'ORACLE_HUMAN_POOL_OVERFLOW'), JSON.stringify(issues))
})

check('断言非转移：把 one 档改名不改语义时，不该凭空变红', () => {
  const issues = run({ r1: GOOD }, { r1: 'error' })
  assert.deepEqual(issues, [])
})

/* ---------- 真实表：必须绿 ---------- */

interface LoadedRule {
  file: string
  guard: Guard
}

async function loadRules(): Promise<LoadedRule[]> {
  const files = readdirSync(RULES_DIR).filter((f) => /^(?:AQ|MP)\d{3}-.+\.ts$/.test(f)).sort()
  const out: LoadedRule[] = []
  for (const f of files) {
    const mod = (await import(pathToFileURL(path.join(RULES_DIR, f)).href)) as Record<string, unknown>
    for (const v of Object.values(mod)) {
      if (!v || typeof v !== 'object') continue
      const g = v as Guard
      if (typeof g.run === 'function' && Array.isArray(g.blindSpots) && typeof g.id === 'string') {
        out.push({ file: f, guard: g })
        break
      }
    }
  }
  return out
}

const loaded = await loadRules()
const rules = loaded.map((l) => l.guard)
const ruleLevels: Record<string, RuleLevel> = {}
for (const g of rules) ruleLevels[g.id] = g.level ?? 'error'

check(`规则文件已全部加载（发现 ${rules.length} 条）`, () => {
  assert.ok(rules.length >= 21, `只加载到 ${rules.length} 条规则：文件命名或导出形状变了`)
})

check(`真实表自证：${rules.length} 条规则全部有合法 oracle（每条都答得出真值来源）`, () => {
  const issues = validateOracles({ oracles: RULE_ORACLES, ruleLevels, registry, today: TODAY, humanCap: 3 })
  assert.deepEqual(issues, [], JSON.stringify(issues, null, 2))
})

check('机器对账：每个规则文件都在 guards/index.ts 里被引用（两处清单不许漂移）', () => {
  const index = readFileSync(path.join(ROOT, 'qe/guards/index.ts'), 'utf8')
  const missing = loaded.filter((l) => !index.includes(`'../rules/${l.file}'`)).map((l) => l.file)
  assert.deepEqual(missing, [], `未被 index 引用的规则文件：${missing.join(',')}`)
})

check('human 档数量在候选池上限内（不允许候选池偷偷扩张）', () => {
  const human = Object.entries(RULE_ORACLES).filter(([, o]) => o.kind === 'human')
  assert.ok(human.length <= 3, `human 档 ${human.length} 条：${human.map(([k]) => k).join(',')}`)
})

console.log(`RULE_ORACLES passed=${cases} failed=${process.exitCode ? 'yes' : 0}`)
