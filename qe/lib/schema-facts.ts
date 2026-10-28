/**
 * 从 schema 快照里提炼「判据要用的事实」。
 *
 * 单源纪律：schema 只经 `parsePrisma` 解析一次，各规则**不许**自己再写一遍正则去读
 * prisma/schema.prisma —— 两份解析器的下一站是两份答案。
 *
 * 这里只做纯派生：输入 SchemaSnapshot，输出两个集合。可在自证里直接喂假快照单测。
 */

import type { SchemaSnapshot } from './providers.ts'

export interface SchemaFacts {
  /**
   * 全部 enum 取值。状态字面量判据的唯一来源。
   * 加一个新状态的人必须改 schema，于是判据自动跟上；靠人工登记表则永远慢一步。
   */
  stateValues: Set<string>
  /** 小写模型名 → 唯一键清单（每项「逗号连接的字段名」，如 'tenantId,email'） */
  uniqueKeys: Map<string, string[]>
  /**
   * 小写模型名 → 可为空的字段名集合。
   *
   * 单独留一栏的理由：唯一键**含可空列时挡不住双写**——PG 里 NULL 互不相等，
   * `@@unique([tenantId, productId, stepNo, sopVersion])` 在 `sopVersion IS NULL` 时
   * 两条一模一样的行都能插进去。只看「有没有唯一键」会把这种表判成「会撞库」。
   */
  optionalFields: Map<string, Set<string>>
  /**
   * 表名（`@@map` 后的真实表名，小写）→ 小写模型名。
   *
   * raw SQL 只写得出表名（`UPDATE ops_snapshot SET ...`），要落到「这张表挡不挡双写」
   * 就得先换回 Prisma 模型名去查唯一键。换不回来（表不在 schema 里）时保持「不可判定」。
   */
  modelByTable: Map<string, string>
  /** enum 名 → 取值（需要区分「哪个 enum」的规则用） */
  enums: Map<string, string[]>
  /** schema 是否真的读到了（false 时依赖 schema 的判据必须显式声明未生效，不许报绿） */
  loaded: boolean
}

export const EMPTY_FACTS: SchemaFacts = {
  stateValues: new Set(),
  uniqueKeys: new Map(),
  optionalFields: new Map(),
  modelByTable: new Map(),
  enums: new Map(),
  loaded: false,
}

export function factsFrom(snapshot: SchemaSnapshot): SchemaFacts {
  const stateValues = new Set<string>()
  const enums = new Map<string, string[]>()
  for (const e of snapshot.enums) {
    const values = e.values.map((v) => v.name)
    enums.set(e.name, values)
    for (const v of values) stateValues.add(v)
  }
  const uniqueKeys = new Map<string, string[]>()
  const optionalFields = new Map<string, Set<string>>()
  const modelByTable = new Map<string, string>()
  for (const m of snapshot.models) {
    // 模型名按小写收敛：schema 里是 `ProcessStep`，代码里是 `tx.processStep`，
    // 大小写差异是最容易写出「一半命中、一半漏」的地方。
    uniqueKeys.set(m.name.toLowerCase(), [...m.uniques])
    optionalFields.set(
      m.name.toLowerCase(),
      new Set(m.fields.filter((f) => f.optional && !f.isRelation && !f.isList).map((f) => f.name)),
    )
    modelByTable.set(m.table.toLowerCase(), m.name.toLowerCase())
  }
  return {
    stateValues,
    uniqueKeys,
    optionalFields,
    modelByTable,
    enums,
    loaded: snapshot.enums.length > 0 || snapshot.models.length > 0,
  }
}

/**
 * 从迁移 SQL 里提取真实存在的唯一索引：
 * Prisma schema 表达不了部分唯一索引，但 DB 里确实有（如 `WHERE status='pending'`）。
 * 只看 `CREATE UNIQUE INDEX ... ON "table" (...)` 与 `ALTER TABLE ... UNIQUE (...)`。
 * 返回 modelName(lower) → 唯一键清单；解析失败不抛错（迁移语法差异不该让判据崩）。
 */
export function parseMigrationUniqueIndexes(
  sql: string,
  tableToModel: Map<string, string>,
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const push = (table: string, columns: string): void => {
    const model = tableToModel.get(table) ?? table.toLowerCase()
    const cols = [...columns.matchAll(/"?([A-Za-z_][\w]*)"?/g)].map((m) => m[1]).filter(Boolean)
    if (cols.length === 0) return
    const list = out.get(model.toLowerCase()) ?? []
    list.push(cols.join(','))
    out.set(model.toLowerCase(), list)
  }
  const createRe = /CREATE\s+UNIQUE\s+INDEX[\s\S]*?\bON\s+"?([A-Za-z_][\w.]*)"?\s*(?:USING\s+\w+\s*)?\(([^)]*)\)/gi
  let m: RegExpExecArray | null
  while ((m = createRe.exec(sql)) !== null) push(m[1], m[2])
  const alterRe = /ALTER\s+TABLE\s+(?:ONLY\s+)?"?([A-Za-z_][\w.]*)"?\s+ADD\s+CONSTRAINT[\s\S]*?\bUNIQUE\s*\(([^)]*)\)/gi
  while ((m = alterRe.exec(sql)) !== null) push(m[1], m[2])
  return out
}

/** 该模型是否有唯一键覆盖给定字段集（子集匹配：键里含齐这些字段即算有） */
export function hasUniqueOver(keys: string[] | undefined, fields: string[]): boolean {
  if (!keys || keys.length === 0) return false
  return keys.some((k) => {
    const parts = k.split(',').map((s) => s.trim())
    return fields.every((f) => parts.includes(f))
  })
}

/**
 * 从 raw SQL 文本里抽「写目标表名」。
 *
 * 只认字面量表名：`INSERT INTO t` / `UPDATE t SET` / `DELETE FROM t` / `TRUNCATE t`。
 * 表名前的 schema 前缀（`public.foo`）与引号一并剥掉，返回原样大小写（查询时收敛小写）。
 *
 * 三条反证钉在自证里（`scripts/verify-idem-triage.ts`）：
 *   · `SELECT set_config('app.current_tenant', ...)` —— RLS 上下文，不是写，抽不出表名；
 *   · `UPDATE ${table} SET ...` —— 动态表名，静态看不见，抽不出（保持「不可判定」）；
 *   · `ON CONFLICT DO UPDATE SET` —— `UPDATE` 后面跟的是 `SET` 关键字而非表名，不许把 SET 当表。
 */
export function parseWriteTables(sql: string): string[] {
  const ident = String.raw`(?:"?([A-Za-z_][\w$]*)"?\s*\.\s*)?"?([A-Za-z_][\w$]*)"?`
  const patterns = [
    new RegExp(String.raw`\bINSERT\s+INTO\s+(?:ONLY\s+)?${ident}`, 'gi'),
    new RegExp(String.raw`\bUPDATE\s+(?:ONLY\s+)?${ident}\s+SET\b`, 'gi'),
    new RegExp(String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?${ident}`, 'gi'),
    new RegExp(String.raw`\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?${ident}`, 'gi'),
  ]
  const out: string[] = []
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(sql)) !== null) {
      const table = m[2]
      if (table && !out.includes(table)) out.push(table)
    }
  }
  return out
}

/**
 * 字段名归一：schema 里是 camelCase，迁移 SQL 里是 snake_case，同一列会以两种写法出现。
 * 唯一键去重与可空列比对都必须先归一到同一形态，否则
 *   · 同一约束被报两遍（`tenantId,code` / `tenant_id,code`）——噪声；
 *   · 迁移形式的键**永远查不到可空列**（可空集合里只有 camelCase）——方向判错。
 */
function snakeOf(field: string): string {
  return field
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
}

/** 唯一键签名：字段集合相同即视为同一约束（与书写顺序、命名风格无关） */
function keySignature(key: string): string {
  return key
    .split(',')
    .map(snakeOf)
    .filter(Boolean)
    .sort()
    .join(',')
}

/** 幂等缺口的落表分档：双提交到底会「真落两份」还是「撞库 500」 */
export type DuplicateRisk =
  | 'duplicate-evidence'
  | 'unique-key-500'
  | 'target-unknown'
  | 'write-unseen'
  | 'audit-trace'
  | 'schema-missing'

export interface DuplicateVerdict {
  risk: DuplicateRisk
  /** 人话依据：命中了哪张表、哪个唯一键、哪一列可空 */
  because: string
}

export const DUPLICATE_RISK_LABEL: Record<DuplicateRisk, string> = {
  'duplicate-evidence': '重复证据风险（双提交会真落两份）',
  // 不得断言「未映射为 409」：错误收口层（`errorResponse` 一类壳层函数）通常在射程之外，
  // 静态看不见 ≠ 不存在。实测 coschain 的 14 条全部已由 `lib/errors.ts` 映射成 E-300/409。
  'unique-key-500': '并发冲突（唯一键会挡；是否已由错误收口层映射为 409，静态射程看不见）',
  'target-unknown': '落表不可判定（raw SQL / 动态表名）',
  // 射程里一条写痕迹都没看到、但存在静态不可见处：没有「落表」可判，也不许当只读豁免
  'write-unseen': '写痕迹未出现（射程内有静态不可见处，不当作只读豁免）',
  // 唯一可见写落在审计/拒绝路径（`logAccessDeny` 一类）：多一条留痕不是业务重复，但留痕本身仍是写
  'audit-trace': '仅见留痕写（审计/拒绝路径，非业务写；是否真无业务写需人工确认）',
  'schema-missing': '分档不可用（schema 未加载）',
}

/**
 * 按 schema 事实给「确证写库、缺幂等护闸」的入口分档。
 *
 * 判据只有两句话：
 *   · 目标表**没有任何唯一约束**，或唯一键**含可空列**（PG 里 NULL 互不相等）⇒ 双提交真落两份；
 *   · 只要有一个唯一键是全非空列 ⇒ 双提交会撞库报 P2002，缺的只是错误映射。
 *
 * `targets` 只能由调用方给「静态可解析的 Prisma 模型名」；给不出时一律
 * `target-unknown`，**不当成「无唯一键」**——把看不见说成没有，是另一种假绿。
 * 同理：模型名解析出来了但 schema 里根本没这个模型（写成别的 client 方法 / 名字拼错），
 * 也不能按「无唯一键」算重复证据。
 *
 * `sawWrite=false`（射程里一条写痕迹都没有、只是存在不可见处）时直接判 `write-unseen`：
 * 此时根本不存在「落表」，按 raw SQL / 动态表名报 target-unknown 会把人引去翻不存在的 SQL。
 * 若此时唯一可见写是留痕（`sawAuditWrite=true`，审计/拒绝路径），判 `audit-trace`：
 * 多一条 deny 日志不是业务重复，但也不能据此豁免（留痕本身仍是写）。
 */
export function classifyDuplicateRisk(
  targets: string[],
  facts: SchemaFacts,
  sawWrite = true,
  sawAuditWrite = false,
): DuplicateVerdict {
  if (!sawWrite) {
    if (sawAuditWrite) {
      return {
        risk: 'audit-trace',
        because: '射程内只见留痕写（审计/拒绝路径），未见业务写：留痕重复不是业务重复，但是否真无业务写需人工确认',
      }
    }
    return {
      risk: 'write-unseen',
      because: '射程内未见任何写调用（含 raw SQL），但存在静态不可见处：看不见 ≠ 没有，不当作只读豁免',
    }
  }
  if (!facts.loaded) {
    return { risk: 'schema-missing', because: 'schema 未加载：分档无事实来源（不猜）' }
  }
  const models = [...new Set(targets.map((t) => t.toLowerCase()))].sort()
  if (models.length === 0) {
    return {
      risk: 'target-unknown',
      because: '写痕迹里没有可解析的 Prisma 模型名（raw SQL / 动态表名 / 非标准 client 名）',
    }
  }
  const notes: string[] = []
  let risk: DuplicateRisk = 'unique-key-500'
  let sawKnownModel = false
  let sawUnknownModel = false
  for (const m of models) {
    if (!facts.uniqueKeys.has(m)) {
      notes.push(`${m} 不在 schema 模型表里（名字拼错或非 Prisma 模型）`)
      sawUnknownModel = true
      continue
    }
    sawKnownModel = true
    const keys = facts.uniqueKeys.get(m) ?? []
    if (keys.length === 0) {
      notes.push(`${m} 无任何唯一约束`)
      risk = 'duplicate-evidence'
      continue
    }
    // 同一约束会以 prisma 写法与迁移 SQL 写法各出现一次：按字段集合去重，只报一次
    const seen = new Set<string>()
    const collapsed: string[] = []
    for (const k of keys) {
      const sig = keySignature(k)
      if (!sig || seen.has(sig)) continue
      seen.add(sig)
      collapsed.push(k)
    }
    // 可空集合是 camelCase，迁移形式的键是 snake_case：比对前统一归一，否则可空列永远查不到
    const nullable = new Set([...(facts.optionalFields.get(m) ?? new Set<string>())].map(snakeOf))
    const effective = collapsed.filter((k) => k.split(',').map(snakeOf).every((f) => !nullable.has(f)))
    if (effective.length === 0) {
      notes.push(`${m} 的唯一键 ${collapsed.join(' / ')} 全含可空列（NULL 互不相等 ⇒ 挡不住双写）`)
      risk = 'duplicate-evidence'
    } else {
      notes.push(`${m} 的唯一键 ${effective.join(' / ')} 会撞库（P2002）`)
    }
  }
  // 只有「一个能判的模型都没有」时才降成不可判定；已证实的唯一键冲突不因旁边有看不穿的表而消失
  if (risk !== 'duplicate-evidence' && !sawKnownModel && sawUnknownModel) risk = 'target-unknown'
  // 收口层在射程外：这句提示全局说一次，不随每个模型重复（否则一行告警里同一句出现三四遍）
  const caution = risk === 'unique-key-500' ? '，是否已被错误收口层映射为 409 需人工确认（静态射程看不见）' : ''
  return { risk, because: `${[...new Set(notes)].join('；')}${caution}` }
}
