/**
 * 幂等缺口的落表分档（P0-2）坏样本：先红后绿。
 *
 * 分档回答的是一个具体问题：这条 `MUTATION_NO_IDEMPOTENCY` 到底是
 *   · 双提交会**真落两份**（目标表没有唯一键，或唯一键含可空列 —— PG 里 NULL 互不相等），
 *   · 还是只会**撞库报 P2002**（有全非空唯一键，缺的只是 409 映射）。
 *
 * 两类处置成本差一个量级，判错方向的代价是「把真脏数据当 500 放过」。
 * 这里把每条判据的反证固定下来；任何一条翻绿都要先过这些用例。
 */
import assert from 'node:assert/strict'
import type { SchemaFacts } from '../qe/lib/schema-facts.ts'
import { DUPLICATE_RISK_LABEL, EMPTY_FACTS, classifyDuplicateRisk, parseWriteTables } from '../qe/lib/schema-facts.ts'

let cases = 0
const check = (name: string, fn: () => void): void => {
  try {
    fn()
    cases++
    console.log(`  PASS ${name}`)
  } catch (e) {
    console.error(`  FAIL ${name}\n        ${(e as Error).message.split('\n')[0]}`)
    process.exitCode = 1
  }
}

interface ModelStub {
  /** 唯一键清单：每项是逗号连接字段名，如 'tenantId,code' */
  unique?: string[]
  /** 可为空（且非关系/非列表）的字段名 */
  optional?: string[]
}

/** 造一份最小 schema 事实；模型名按 schema 的写法给，内部自己收敛小写 */
function facts(models: Record<string, ModelStub>): SchemaFacts {
  const entries = Object.entries(models)
  return {
    stateValues: new Set(),
    uniqueKeys: new Map(entries.map(([m, v]) => [m.toLowerCase(), v.unique ?? []])),
    optionalFields: new Map(entries.map(([m, v]) => [m.toLowerCase(), new Set(v.optional ?? [])])),
    // 模型名与表名在测试里同形（真实 schema 的 @@map 由 factsFrom 负责，不在纯函数射程）
    modelByTable: new Map(entries.map(([m]) => [m.toLowerCase(), m.toLowerCase()])),
    enums: new Map(),
    loaded: entries.length > 0,
  }
}

/* ---------- 重复证据档：双提交会真落两份 ---------- */

check('目标表无任何唯一约束 ⇒ duplicate-evidence', () => {
  const v = classifyDuplicateRisk(['Clearing'], facts({ Clearing: { unique: [] } }))
  assert.equal(v.risk, 'duplicate-evidence')
  assert.match(v.because, /clearing.*无任何唯一约束/)
})

check('唯一键含可空列（sopVersion 为 NULL 时 NULL 互不相等）⇒ duplicate-evidence', () => {
  const v = classifyDuplicateRisk(
    ['ProcessStep'],
    facts({ ProcessStep: { unique: ['tenantId,batchId,stepNo,sopVersion'], optional: ['sopVersion'] } }),
  )
  assert.equal(v.risk, 'duplicate-evidence', `because=${v.because}`)
  assert.match(v.because, /sopVersion/)
})

check('可空列不在唯一键里时不影响判定（只在键内的可空列才算漏洞）', () => {
  const v = classifyDuplicateRisk(
    ['Batch'],
    facts({ Batch: { unique: ['tenantId,code'], optional: ['remark'] } }),
  )
  assert.equal(v.risk, 'unique-key-500', `because=${v.because}`)
})

/* ---------- 500 档：唯一键会挡，缺的只是错误映射 ---------- */

check('全非空唯一键 ⇒ unique-key-500', () => {
  const v = classifyDuplicateRisk(['Batch'], facts({ Batch: { unique: ['tenantId,code'] } }))
  assert.equal(v.risk, 'unique-key-500')
  assert.match(v.because, /tenantId,code/)
})

check('多个唯一键：只要有一个全非空 ⇒ unique-key-500（不因另一个含可空列降档）', () => {
  const v = classifyDuplicateRisk(
    ['ProcessStep'],
    facts({
      ProcessStep: {
        unique: ['tenantId,batchId,stepNo,sopVersion', 'tenantId,stepKey'],
        optional: ['sopVersion'],
      },
    }),
  )
  assert.equal(v.risk, 'unique-key-500', `because=${v.because}`)
})

/* ---------- 不可判定档：看不见就说看不见 ---------- */

check('模型名大小写/重复项收敛后判一条（不对同一张表重复出依据）', () => {
  const v = classifyDuplicateRisk(['Batch', 'batch', 'BATCH'], facts({ Batch: { unique: ['tenantId,code'] } }))
  assert.equal(v.risk, 'unique-key-500')
  assert.equal(v.because.split('；').length, 1, `去重失效：${v.because}`)
})

check('落表解析不出模型名 ⇒ target-unknown（不当成「无唯一键」）', () => {
  const v = classifyDuplicateRisk([], facts({ Batch: { unique: ['tenantId,code'] } }))
  assert.equal(v.risk, 'target-unknown')
})

check('模型名不在 schema 里 ⇒ target-unknown（名字拼错不等于没有唯一键）', () => {
  const v = classifyDuplicateRisk(['NotAModel'], facts({ Batch: { unique: ['tenantId,code'] } }))
  assert.equal(v.risk, 'target-unknown', `because=${v.because}`)
  assert.match(v.because, /不在 schema 模型表里/)
})

check('schema 未加载 ⇒ schema-missing（不猜成任何一档）', () => {
  const v = classifyDuplicateRisk(['Batch'], EMPTY_FACTS)
  assert.equal(v.risk, 'schema-missing')
})

/* ---------- 多模型聚合 ---------- */

check('多模型一脏一净 ⇒ 取最坏 duplicate-evidence', () => {
  const v = classifyDuplicateRisk(
    ['Batch', 'Clearing'],
    facts({ Batch: { unique: ['tenantId,code'] }, Clearing: { unique: [] } }),
  )
  assert.equal(v.risk, 'duplicate-evidence', `because=${v.because}`)
  assert.match(v.because, /batch/)
  assert.match(v.because, /clearing/)
})

check('多模型都干净 ⇒ 仍判 500，不因还有一张看不穿的表而降档', () => {
  const v = classifyDuplicateRisk(
    ['Batch', 'NotAModel'],
    facts({ Batch: { unique: ['tenantId,code'] } }),
  )
  assert.equal(v.risk, 'unique-key-500', `because=${v.because}`)
})

/* ---------- 写痕迹未出现档：看不见 ≠ 没有，但也不能报成 raw SQL 不可判定 ---------- */

check('射程里一条写痕迹都没有 ⇒ write-unseen（不报 target-unknown 把人引去翻不存在的 SQL）', () => {
  const v = classifyDuplicateRisk([], facts({ Batch: { unique: ['tenantId,code'] } }), false)
  assert.equal(v.risk, 'write-unseen', `because=${v.because}`)
  assert.match(v.because, /看不见 ≠ 没有/)
})

check('write-unseen 优先于 schema-missing：schema 没读到时也先如实说「没看到写」', () => {
  const v = classifyDuplicateRisk([], EMPTY_FACTS, false)
  assert.equal(v.risk, 'write-unseen')
})

/* ---------- 留痕写档：拒绝路径的审计写不是业务写 ---------- */

check('只见留痕写（audit 为唯一可见写）⇒ audit-trace，不报成 duplicate-evidence', () => {
  const v = classifyDuplicateRisk([], facts({ AuditEvent: { unique: [] } }), false, true)
  assert.equal(v.risk, 'audit-trace', `because=${v.because}`)
  assert.match(v.because, /留痕/)
  assert.match(DUPLICATE_RISK_LABEL['audit-trace'], /留痕/)
})

check('没有留痕写时仍报 write-unseen（audit-trace 不许扩大成万能兜底）', () => {
  const v = classifyDuplicateRisk([], facts({ AuditEvent: { unique: [] } }), false, false)
  assert.equal(v.risk, 'write-unseen')
})

/* ---------- 命名风格归一：同一约束不许报两遍、可空列不许漏 ---------- */

check('同一约束的 prisma 写法与迁移写法只报一次（camelCase / snake_case 同签名）', () => {
  const v = classifyDuplicateRisk(
    ['BrandRef'],
    facts({ BrandRef: { unique: ['tenantId,code', 'tenant_id, code'] } }),
  )
  assert.equal(v.risk, 'unique-key-500', `because=${v.because}`)
  assert.ok(!/tenant_id, ?code/.test(v.because), `同一约束被报两遍：${v.because}`)
})

check('迁移写法（snake_case）的唯一键含可空列 ⇒ duplicate-evidence（归一后可空列仍查得到）', () => {
  const v = classifyDuplicateRisk(
    ['ProcessStep'],
    facts({ ProcessStep: { unique: ['tenant_id, batch_id, step_no, sop_version'], optional: ['sopVersion'] } }),
  )
  assert.equal(v.risk, 'duplicate-evidence', `because=${v.because}`)
})

check('错误收口层提示只出现一次（不随每个模型重复三遍）', () => {
  const v = classifyDuplicateRisk(
    ['A', 'B', 'C'],
    facts({
      A: { unique: ['tenantId,code'] },
      B: { unique: ['tenant_id,name'] },
      C: { unique: ['tenant_id,key'] },
    }),
  )
  const n = v.because.split('需人工确认').length - 1
  assert.equal(n, 1, `提示重复 ${n} 次：${v.because}`)
})

/* ---------- raw SQL 落表：字面量表名可解析，动态表名不可 ---------- */

check('raw SQL 抽表：`UPDATE ops_snapshot SET …` ⇒ ops_snapshot', () => {
  assert.deepEqual(parseWriteTables('UPDATE ops_snapshot\n SET tenant_total = ${cols.n}, raw_json = ${x}::jsonb'), [
    'ops_snapshot',
  ])
})

check('raw SQL 抽表：`INSERT INTO "audit_event" (...)` ⇒ audit_event（引号剥掉）', () => {
  assert.deepEqual(parseWriteTables('INSERT INTO "audit_event" ("id", "action") VALUES ($1, $2)'), ['audit_event'])
})

check('raw SQL 抽表：`DELETE FROM public.foo WHERE …` ⇒ foo（schema 前缀剥掉）', () => {
  assert.deepEqual(parseWriteTables('DELETE FROM public.foo WHERE id = $1'), ['foo'])
})

check('raw SQL 抽表：`SELECT set_config(...)` 是 RLS 上下文，抽不出写表', () => {
  assert.deepEqual(parseWriteTables("SELECT set_config('app.current_tenant', $1, true)"), [])
})

check('raw SQL 抽表：动态表名 `UPDATE ${table} SET …` 抽不出（保持不可判定）', () => {
  assert.deepEqual(parseWriteTables('UPDATE ${table} SET a = 1'), [])
})

check('raw SQL 抽表：`ON CONFLICT DO UPDATE SET` 不许把 SET 关键字当表名', () => {
  assert.deepEqual(parseWriteTables('INSERT INTO "t" (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET x = 1'), ['t'])
})

check('raw SQL 表名经 modelByTable 换回模型名后仍按唯一键分档', () => {
  const sf = facts({ Batch: { unique: ['tenantId,code'] } })
  const tables = parseWriteTables('UPDATE batch SET name = $1 WHERE id = $2').map((t) => sf.modelByTable.get(t.toLowerCase()) ?? t)
  const v = classifyDuplicateRisk(tables, sf)
  assert.equal(v.risk, 'unique-key-500', `because=${v.because}`)
})

/* ---------- 标签完整性 ---------- */

check('六种分档都有中文标签（报告里不许出现裸英文键）', () => {
  const keys = [
    'duplicate-evidence',
    'unique-key-500',
    'target-unknown',
    'write-unseen',
    'audit-trace',
    'schema-missing',
  ] as const
  for (const key of keys) {
    assert.ok(DUPLICATE_RISK_LABEL[key], `缺标签：${key}`)
    assert.notEqual(DUPLICATE_RISK_LABEL[key], key)
  }
})

/**
 * 反证：标签**不得**断言「未映射为 409」。
 * 错误收口层（`errorResponse` 一类壳层函数）通常在入口射程之外 —— coschain 的 14 条
 * `unique-key-500` 实测全部已映射成 E-300/409，静态看不见不等于不存在。
 * 断言错方向会把「已收口」误报成「待修」，让人白改一遍代码。
 */
check('unique-key-500 标签不得断言「未映射 / 缺映射」', () => {
  const label = DUPLICATE_RISK_LABEL['unique-key-500']
  assert.ok(!/未映射|缺.{0,2}映射/.test(label), `标签仍在断言未映射：${label}`)
  assert.match(label, /看不见|人工确认/, `标签必须说明「静态看不见」：${label}`)
})

check('unique-key-500 的依据文案只说「会撞库」，不说「需映射 409」', () => {
  const v = classifyDuplicateRisk(['Batch'], facts({ Batch: { unique: ['tenantId,code'] } }))
  assert.ok(!/需映射\s*409/.test(v.because), `依据仍在下结论：${v.because}`)
  assert.match(v.because, /需人工确认/)
})

console.log(`IDEM_TRIAGE passed=${cases} failed=${process.exitCode ? 'yes' : 0}`)
