/**
 * AQ004 · 先查后写（check-then-act 竞态）
 *
 * ## 真实事故形态
 * `findUnique` 判存在 → `create`。两个请求同时进来，都查到「不存在」，都创建。
 * 唯一约束能挡住的话是 500（用户看到报错），没唯一的表就是两条重复记录（更坏：不报错）。
 * 更贵的版本是库存/余额：查到 1 件 → 判断够 → 扣减，两个请求各扣 1 件，卖超。
 *
 * ## 判据
 * 同一文件内，A 处调用 `<x>.findUnique|findFirst|findOne`（记录模型），
 * 其后 40 行内出现同一模型的 `.create(` —— 且这段区间里**没有**：
 *   - `upsert`
 *   - `$transaction` / `BEGIN` / `forUpdate` / `lock`
 *   - `P2002`（唯一冲突捕获）
 *   - 唯一约束相关的中文/英文说明（`唯一`/`unique`/`onConflict`）
 *
 * ## 为什么 40 行
 * 这个数字是从实战来的：判据太宽（整函数）会把「查 A 表、建 B 表」算成竞态；
 * 太窄（同一行）会漏掉中间夹着校验的常见写法。40 行是覆盖率与误报的折中，
 * 写在配置里（`windowLines`），不同项目可以调 —— 但**不许按文件设例外**。
 * ## 首轮外部试跑撞出来的误报（试点 B 55 处 → 收紧后剩个位数）
 * 初版只要求「同一模型 find 过、又在 40 行内 create 过」，于是把**导入器**判成了竞态：
 *   `const step = await processStep.findFirst({ where: { tenantId, productId, stepNo } })`
 *   后面紧跟 `processStep.create(...)` —— 这是「按业务键查上一个工序，再建下一个工序」，
 *   **查到的结果根本没被用来决定要不要 create**，并发下也不会双写。
 * 竞态的必要条件是「**判空结果驱动了写入**」，所以判据必须抓到那个变量名，
 * 并要求区间内出现 `if (<var>)` / `if (!<var>)`。抓不到变量名一律不报（宁可少报也不瞎报）。
 */
import { maskStringBodies, stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf, modelUniquesOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'

const READ_RE = /\b([A-Za-z_$][\w$]*)\.(findUnique|findFirst|findOne|findById)\s*\(/g
/** 该 find 的结果被赋给了谁：`const found = await prisma.user.findUnique(`（`before` 里含 `prisma.user.` 前缀） */
const ASSIGN_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[\w$.]*$/
// 注意：不能把裸 `unique` 算作守卫——`findUnique` 自己就含这个词，
// 那会让「先查后建」永远被自己的查询判成「已保护」（本规则第一版就这样假绿过）。
const GUARD_RE =
  /(upsert|\$transaction|P2002|onConflict|ON\s+CONFLICT|FOR\s+UPDATE|forUpdate|@@unique|@unique|唯一约束|unique constraint|duplicate)/i

export const aq04 = toGuard({
  id: 'aq04',
  title: '先查后写（check-then-act 竞态）',
  invariants: ['INV-CORE-12', 'INV-DB-01', 'INV-DB-02'],
  code: 'AQ004_CHECK_THEN_ACT',
  blindSpots: [
      '只判「同一文件内 先查 → 判空 → 建」；跨文件、跨服务的判空写入不可见',
      '不判并发热点的锁与冲突分类（属运行期探针射程，静态判据只会猜）',
      '目标表有唯一约束时默认不报（并发会撞库报错，属另一类缺陷），可用 `ignoreUniqueConstraints` 覆盖',
    ],
  impact: '并发下双写：唯一约束挡住变 500，没约束的表留下两条重复记录（不报错，更坏）',
  provenance: "外部试点 A 的并发基线（每轮探针都撞出「2 路请求恰好串行」的假绿）+ 外部试点 B（2026-10）的批号/库存扣减事故",
  applies(rel) {
    return /\.(ts|tsx|js|mjs|mts)$/.test(rel) && !/\.(test|spec)\./.test(rel)
  },
  analyze(src, rel, ctx: RuleCtx): RawHit[] {
    const windowLines = Number(ctx.options.windowLines ?? 40)
    const code = maskStringBodies(stripComments(src))
    const hits: RawHit[] = []
    const lines = code.split('\n')
    let m: RegExpExecArray | null
    READ_RE.lastIndex = 0
    while ((m = READ_RE.exec(code)) !== null) {
      const model = m[1]
      if (model === 'tx' || model === 'db' || model === 'prisma' || model === 'this') continue
      // 抓「查到的结果被赋给谁」——没有赋值就没有「判空驱动写入」，不算竞态
      const lineStart = code.lastIndexOf('\n', m.index) + 1
      const before = code.slice(lineStart, m.index).replace(/\s+/g, ' ')
      const assign = ASSIGN_RE.exec(before)
      if (!assign) continue
      const bound = assign[1]
      const atLine = lineOf(src, m.index)
      const from = atLine - 1
      const to = Math.min(lines.length, from + windowLines)
      const window = lines.slice(from, to).join('\n')
      const createRe = new RegExp(`\\b${model.replace(/[$]/g, '\\$')}\\.(create|createMany)\\s*\\(`)
      if (!createRe.test(window)) continue
      // 必要条件：这个变量被单独判过空（`if (!found)` / `if (found) return`）
      const emptyCheckRe = new RegExp(`\\bif\\s*\\(\\s*!?\\s*${bound.replace(/[$]/g, '\\$')}\\b[^)]*\\)`)
      if (!emptyCheckRe.test(window)) continue
      if (GUARD_RE.test(window)) continue
      // 目标表有唯一约束 ⇒ 并发双写被数据库挡住（表现是 500，不是静默两条记录）。
      // 这仍然是个问题，但它**不是本规则要抓的那一类**（本规则抓静默双写）。
      // 试点 B 试跑实证：同一仓里两张形状相同的表，一张有复合唯一键（租户 + 业务键 + 版本），
      // 另一张没有 —— 它们在代码里长得一模一样，只有 schema 能区分。
      const declared = (ctx.options.uniqueModels ?? []) as string[]
      const hasUnique = declared.includes(model) || (modelUniquesOf(ctx).get(model.toLowerCase())?.length ?? 0) > 0
      if (hasUnique && ctx.options.ignoreUniqueConstraints !== true) continue
      // where 里出现复合唯一键（`tenantId_code` / `orgId_batchNo` 这种 `a_b:` 形态）说明
      // 表上已有唯一约束：并发写会被数据库挡住（表现是 500，不是双写），不属于本规则射程。
      if (/\b[a-zA-Z]\w*_[a-zA-Z]\w*\s*:/.test(window)) continue
      hits.push({
        line: atLine,
        evidence: evidenceOf(src, m.index),
        impact: `先 findUnique 再 ${model}.create，区间内无 upsert/事务/唯一冲突处理：并发下会双写`,
      })
    }
    return hits
  },
  fixtures: [
    {
      name: '先查后建（该报）',
      expect: 'red',
      src: `async function ensureUser(email: string) {
  const found = await prisma.user.findUnique({ where: { email } })
  if (found) return found
  return prisma.user.create({ data: { email } })
}
`,
    },
    {
      name: 'upsert（不该报）',
      expect: 'green',
      src: `async function ensureUser(email: string) {
  const found = await prisma.user.findUnique({ where: { email } })
  if (found) return found
  return prisma.user.upsert({ where: { email }, create: { email }, update: {} })
}
`,
    },
    {
      name: '捕获 P2002（不该报）',
      expect: 'green',
      src: `async function ensureUser(email: string) {
  const found = await prisma.user.findUnique({ where: { email } })
  if (found) return found
  try {
    return await prisma.user.create({ data: { email } })
  } catch (e) {
    if (isP2002(e)) return prisma.user.findUnique({ where: { email } })
    throw e
  }
}
`,
    },
    {
      name: '目标表有唯一约束（并发会撞 500，不该报）',
      expect: 'green',
      options: { uniqueModels: ['user'] },
      src: `async function ensureUser(email: string) {
  const found = await prisma.user.findUnique({ where: { email } })
  if (!found) await prisma.user.create({ data: { email } })
  return found
}
`,
    },
    {
      name: '按业务键查上一个再建下一个（不该报）',
      expect: 'green',
      src: `async function nextStep(productId: string, stepNo: number) {
  const prev = await prisma.processStep.findFirst({ where: { productId, stepNo: stepNo - 1 } })
  return prisma.processStep.create({ data: { productId, stepNo, note: prev?.note } })
}
`,
    },
    {
      name: '查到就直接 create（没判空驱动写入，不该报）',
      expect: 'green',
      src: `const existing = await prisma.batch.findUnique({ where: { id } })
await prisma.batch.create({ data: { id, copyFrom: existing!.id } })
`,
    },
    {
      name: '查 A 建 B（不该报）',
      expect: 'green',
      src: `const user = await prisma.user.findUnique({ where: { id } })
await prisma.auditLog.create({ data: { userId: user!.id } })
`,
    },
  ],
})
