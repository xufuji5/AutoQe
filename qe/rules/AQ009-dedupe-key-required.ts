/**
 * AQ009 · 唯一写入口被旁路（漏解重键 = 部分唯一索引失效）
 *
 * ## 真实事故形态
 * 某个模型（待办信号、告警、通知锚…）加了一条**部分唯一索引**：
 *   `UNIQUE (dedupe_key) WHERE status IN ('open','claimed') AND dedupe_key IS NOT NULL`
 * 期待「同键只留一条在途行」。但索引只对**写了键**的行生效：
 * 不传键 → 键为 NULL → 行落在索引之外 → 并发建两条都成功，而且是**静默**的
 * （没有 500、没有日志、只有待办中心多一条重复条目）。
 *
 * 于是正确性完全不取决于「有没有这条索引」，而取决于「每个写入点有没有记得传键」。
 * 这正是**约定型防线**的典型死法：写入口单源（`raiseSignal`）注释里写着「禁裸 create」，
 * 实测全仓 N 个文件直接 `model.create`，只有少数几个传了键 —— 单源只覆盖了它自己。
 *
 * ## 判据（可机械判定，不含任何名字猜测）
 * 1. 项目在 `rules.aq09.uniqueWrites` 里声明「哪些模型有唯一写入口、入口叫什么、靠哪个字段保护」：
 *      [{ "model": "adminSignal", "entry": "raiseSignal", "protectField": "dedupeKey" }]
 *    —— 声明放配置而不是判据里，因为「哪个模型该去重」是业务事实，跨项目不可移植；
 *    引擎这侧只提供形状。
 * 2. 扫射程内所有 `x.<model>.create({ data: {…} })`（含 `tx.`/`db.` 等委托别名）。
 * 3. `data` 是**对象字面量**且不含 `protectField` → error（这条写点失去兜底）。
 *
 * ## 为什么只认字面量
 * `data` 由变量拼装（`const data = {...}; create({ data })`）时看不见里面有没有键。
 * 静态判据看不见就说不看见 —— 报它等于把「看不清」当成「有缺陷」，是另一种假红；
 * 漏报的那一半写进 blindSpots，由人来核（清单式复核，不是「已检查 0 处」）。
 *
 * ## 为什么不用函数名豁免入口自身
 * 入口函数体内一定写了 `protectField`（否则入口自己就是缺陷），所以「字面量里有键」这一条
 * 天然放行入口；反过来，谁把入口改成 `data: input` 这种变量传递，本规则立刻报红——
 * 那不是误报，是入口真的把兜底丢了。
 */
import { braceBody, maskStringBodies, stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'

interface UniqueWriteDecl {
  /** Prisma 委托名（如 adminSignal），大小写不敏感；也接受模型名写法 */
  model: string
  /** 唯一写入口名（仅用于文案，判据不看它） */
  entry: string
  /** 保护字段（如 dedupeKey）：写入时必须显式出现 */
  protectField: string
}

const CREATE_RE = /([A-Za-z_$][\w$]*)\s*\.\s*(?:create|createMany)\s*\(/g
const DATA_RE = /\bdata\s*:\s*/

function declsOf(ctx: RuleCtx): UniqueWriteDecl[] {
  const raw = ctx.options.uniqueWrites
  if (!Array.isArray(raw)) return []
  return raw
    .filter((d): d is UniqueWriteDecl => !!d && typeof d === 'object')
    .filter((d) => typeof d.model === 'string' && typeof d.protectField === 'string')
}

export const aq09 = toGuard({
  id: 'aq09',
  title: '唯一写入口被旁路（漏解重键）',
  invariants: ['INV-DB-03'],
  code: 'AQ009_DEDUPE_KEY_MISSING',
  blindSpots: [
    '`data` 由变量拼装时看不见是否带键（本规则不报，需人工核）',
    '`createMany` 的数组字面量、`upsert`、`$executeRaw` 写入不在射程',
    '「该模型是否真的需要去重」是业务判断：未在配置声明唯一写入口的模型完全不判（不是绿，是未检查）',
    '键的取值是否稳定（同一业务事实是否落在同一个键上）不可静态判定，只看有没有写',
  ],
  impact:
    '部分唯一索引只对写了键的行生效：漏键的写点在并发下静默双写（不报错，重复条目），单源入口形同虚设',
  provenance:
    '外部试点 A（2026-10）：在途去重键只落地 3 个域，18 个文件直接 `model.create` 其中 15 个不传键；同批同形态的跑批锚位重复推送',
  applies(rel) {
    if (!/\.(ts|tsx|js|mjs|mts)$/.test(rel)) return false
    // 测试/探针/种子脚本不在射程：它们**制造状态**（要一条指定形态的信号来跑断言），
    // 不是业务写点。首轮在目标仓试跑时这类贡献了 42 条里的 17 条——噪声会把真旁路淹掉。
    // 文件名按「分段」判（`-test.` / `.spec.` / `smoke-*.ts` / `seed-*.ts`）：
    // 子串判会误伤 `attestation.ts` 这种含 "test" 的真业务文件。
    const base = rel.split('/').pop() ?? ''
    if (/(^|[-_.])(smoke|seed|seeds|fixture|fixtures|mock|mocks|probe|test|spec)([-_.]|$)/i.test(base)) return false
    if (/(^|\/)(__tests__|e2e|fixtures|mocks|seeds|test)\//.test(rel)) return false
    return true
  },
  notApplicable(ctx) {
    if (declsOf(ctx).length === 0) {
      return {
        code: 'UNIQUE_WRITES_UNSET',
        reason: '未声明唯一写入口（rules.aq09.uniqueWrites）：本轮未检查，0 命中≠无缺陷',
      }
    }
    return null
  },
  analyze(src, _rel, ctx: RuleCtx): RawHit[] {
    const decls = declsOf(ctx)
    if (decls.length === 0) return []
    const code = maskStringBodies(stripComments(src))
    const hits: RawHit[] = []
    let m: RegExpExecArray | null
    CREATE_RE.lastIndex = 0
    while ((m = CREATE_RE.exec(code)) !== null) {
      const model = m[1]
      const decl = decls.find((d) => d.model.toLowerCase() === model.toLowerCase())
      if (!decl) continue
      // 跳过类型声明/注释残留的假调用（`adminSignal.create(` 出现在函数签名里极其罕见，不额外处理）
      const open = code.indexOf('(', m.index)
      const dataAt = DATA_RE.exec(code.slice(open, open + 400))
      if (!dataAt) continue // createMany 的 `data: [...]` 或写法里没有 data —— 属射程外
      const dataStart = open + dataAt.index + dataAt[0].length
      // 只认对象字面量：`data` 后面的第一个非空白字符必须是 `{`
      const first = code.slice(dataStart).match(/^\s*/)?.[0].length ?? 0
      if (code[dataStart + first] !== '{') continue
      const body = braceBody(code, dataStart + first)
      if (body === null) continue
      // 展开运算（`...base`）可能携带键：看不清，不报
      if (body.includes('...')) continue
      const fieldRe = new RegExp(`\\b${decl.protectField.replace(/[$]/g, '\\$')}\\s*:`)
      if (fieldRe.test(body)) continue
      hits.push({
        line: lineOf(src, m.index),
        message: `${model}.create 未写 ${decl.protectField}：该行落在部分唯一索引之外，等于没有去重（唯一写入口应是 ${decl.entry}）`,
        evidence: evidenceOf(src, m.index),
      })
    }
    return hits
  },
  fixtures: [
    {
      name: '裸 create 不传解重键（该报）',
      expect: 'red',
      options: { uniqueWrites: [{ model: 'adminSignal', entry: 'raiseSignal', protectField: 'dedupeKey' }] },
      src: `export async function notifyFreeze(tenantId: string) {
  await prisma.adminSignal.create({
    data: { queue: 'FREEZE', tenantId, severity: 'critical', title: '待确认' },
  })
}
`,
    },
    {
      name: '事务客户端同样算旁路（该报）',
      expect: 'red',
      options: { uniqueWrites: [{ model: 'adminSignal', entry: 'raiseSignal', protectField: 'dedupeKey' }] },
      src: `await tx.adminSignal.create({ data: { queue: 'FREEZE', tenantId } })
`,
    },
    {
      name: '走唯一入口（入口内部写了键，不该报）',
      expect: 'green',
      options: { uniqueWrites: [{ model: 'adminSignal', entry: 'raiseSignal', protectField: 'dedupeKey' }] },
      src: `export async function raiseSignal(input: { queue: string; dedupeKey: string | null }) {
  await prisma.adminSignal.create({
    data: { queue: input.queue, dedupeKey: input.dedupeKey },
  })
}
`,
    },
    {
      name: '显式声明不去重（写 null，是决定不是遗漏，不该报）',
      expect: 'green',
      options: { uniqueWrites: [{ model: 'adminSignal', entry: 'raiseSignal', protectField: 'dedupeKey' }] },
      src: `await prisma.adminSignal.create({ data: { queue: 'NOTICE', dedupeKey: null, title: '一次性说明' } })
`,
    },
    {
      name: '未声明的模型（本规则不看，不该报）',
      expect: 'green',
      options: { uniqueWrites: [{ model: 'adminSignal', entry: 'raiseSignal', protectField: 'dedupeKey' }] },
      src: `await prisma.auditLog.create({ data: { action: 'x', reason: 'y' } })
`,
    },
    {
      name: 'data 由变量拼装（本规则看不见，不报）',
      expect: 'green',
      options: { uniqueWrites: [{ model: 'adminSignal', entry: 'raiseSignal', protectField: 'dedupeKey' }] },
      src: `const data = buildSignal(input)
await prisma.adminSignal.create({ data })
`,
    },
  ],
})
