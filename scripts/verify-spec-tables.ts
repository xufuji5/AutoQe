/**
 * 规格表抽取器的坏样本（先红后绿）。
 *
 * 这里每一条都对应一次真实假红（2026-10-24 的 spec-coverage.json）：
 *   join / enant（tenant 掉首字母） → 被判成缺失字段
 *   IconAlert / TrendLine           → 被判成缺失 model
 *   散文里的 /api/...               → 被判成缺失端点
 * 抽取器必须先证明自己不会被这些噪声骗到，才配拿去对账。
 */
import assert from 'node:assert/strict'
import { compareClaims, normalizeEndpoint, parseSpecDoc } from '../qe/lib/spec-tables.ts'

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

const count = (r: ReturnType<typeof parseSpecDoc>, kind: string): number => r.claims.filter((c) => c.kind === kind).length

/* ---------- 噪声：散文 ---------- */

check('散文里的 tenant / join / enant 不产生任何声明', () => {
  const md = [
    '# 租户设置',
    '',
    '租户（tenant）需要填写统一社会信用代码，并 join 到工厂表。',
    '字段 enant 缺首字母时是笔误，不是字段声明。',
    '前端会请求 /api/tenants 获取列表。',
  ].join('\n')
  const r = parseSpecDoc(md, 'docs/tenant.md')
  assert.equal(r.claims.length, 0, `散文被当成了表格：${JSON.stringify(r.claims)}`)
  assert.equal(r.tables, 0)
})

check('散文即使写成「字段：unifiedSocialCode」也不是表格声明', () => {
  const r = parseSpecDoc('模型：Tenant\n字段：unifiedSocialCode\n', 'docs/x.md')
  assert.equal(r.claims.length, 0)
})

/* ---------- 噪声：表头不是规格表 ---------- */

check('「| 图标 | 用途 |」表里的 IconAlert / TrendLine 不算 model', () => {
  const md = ['| 图标 | 用途 |', '|---|---|', '| IconAlert | 警告 |', '| TrendLine | 趋势 |', '| BatchBar | 批次条 |'].join('\n')
  const r = parseSpecDoc(md, 'docs/ui.md')
  assert.equal(count(r, 'model'), 0, `图标名被当成 model：${JSON.stringify(r.claims)}`)
  assert.equal(r.tables, 0)
  assert.equal(r.ignoredTables, 1, '被忽略的表格必须计数，不能静默')
})

check('代码块里的表格不解析（示例不是承诺）', () => {
  const md = ['```markdown', '| 模型 | 说明 |', '|---|---|', '| Ghost | 示例 |', '```'].join('\n')
  const r = parseSpecDoc(md, 'docs/example.md')
  assert.equal(r.claims.length, 0)
})

/* ---------- 正样本 ---------- */

check('模型表取到完整标识符，装饰符被剥离', () => {
  const md = ['| 模型 | 说明 |', '|---|---|', '| `Request` | 请求 |', '| **Widget** | 部件 |'].join('\n')
  const r = parseSpecDoc(md, 'docs/models.md')
  assert.deepEqual(r.claims.map((c) => (c.kind === 'model' ? c.name : '')).filter(Boolean), ['Request', 'Widget'])
  assert.equal(r.claims[0].doc, 'docs/models.md')
  assert.equal(r.claims[0].line, 3)
})

check('字段表：表内「模型」列提供上下文', () => {
  const md = ['| 模型 | 字段 | 类型 |', '|---|---|---|', '| Request | `title` | String |', '| Request | `ghost` | String |'].join('\n')
  const r = parseSpecDoc(md, 'docs/fields.md')
  assert.equal(count(r, 'field'), 2)
  assert.deepEqual(r.claims.map((c) => (c.kind === 'field' ? `${c.model}.${c.field}` : '')).filter(Boolean), [
    'Request.title',
    'Request.ghost',
  ])
})

check('字段表：最近的标题提供模型上下文', () => {
  const md = ['### 3.2 Tenant（租户）', '', '| 字段 | 类型 |', '|---|---|', '| `name` | String |', '|---|---|', '| `code` | String |'].join('\n')
  const r = parseSpecDoc(md, 'docs/tenant-fields.md')
  assert.equal(count(r, 'field'), 2, `字段数不对：${JSON.stringify(r.claims)}`)
  assert.ok(r.claims.every((c) => c.kind === 'field' && c.model === 'Tenant'))
})

check('字段表没有模型上下文 → 整表忽略，不猜', () => {
  const md = ['| 字段 | 说明 |', '|---|---|', '| `title` | 标题 |'].join('\n')
  const r = parseSpecDoc(md, 'docs/orphan.md')
  assert.equal(r.claims.length, 0)
})

check('完整格子里的 enant 会作为声明取出（是否缺失交给对账，不由抽取器定性）', () => {
  const md = ['### Tenant', '', '| 字段 | 说明 |', '|---|---|', '| `enant` | 笔误 |'].join('\n')
  const r = parseSpecDoc(md, 'docs/typo.md')
  assert.equal(count(r, 'field'), 1)
  assert.equal((r.claims[0] as { field: string }).field, 'enant')
})

check('端点表：整格路径与 `:id` 归一化', () => {
  const md = ['| 端点 | 方法 |', '|---|---|', '| `/api/requests` | GET |', '| `/api/requests/:id` | GET |', '| /api/records | POST |'].join('\n')
  const r = parseSpecDoc(md, 'docs/api.md')
  assert.equal(count(r, 'endpoint'), 3)
  assert.ok(r.claims.some((c) => c.kind === 'endpoint' && c.path === '/api/requests/[id]'))
})

check('端点表里的散文（含空格 / 中文）不取', () => {
  const md = ['| 端点 | 说明 |', '|---|---|', '| 见 /api/requests 一节 | 散文 |', '| — | 暂无 |'].join('\n')
  const r = parseSpecDoc(md, 'docs/api2.md')
  assert.equal(count(r, 'endpoint'), 0)
})

/* ---------- 对账 ---------- */

check('对账：模型不存在时不再重复报它的字段缺口', () => {
  const md = [
    '| 模型 | 说明 |',
    '|---|---|',
    '| Ghost | 幽灵 |',
    '',
    '### Ghost',
    '',
    '| 字段 | 类型 |',
    '|---|---|',
    '| `alpha` | String |',
    '| `beta` | String |',
  ].join('\n')
  const claims = parseSpecDoc(md, 'docs/x.md')
  assert.equal(claims.claims.length, 3, `抽取数不对：${JSON.stringify(claims.claims)}`)
  const gaps = compareClaims(claims.claims, { models: new Set(['Request']), fields: new Map(), endpoints: new Set() })
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].missing, 'model')
})

check('对账：真实存在的模型/字段/端点为零缺口', () => {
  const md = ['| 端点 | 方法 |', '|---|---|', '| `/api/requests` | GET |', '', '| 模型 | 说明 |', '|---|---|', '| Request | 请求 |', '', '### Request', '', '| 字段 | 类型 |', '|---|---|', '| `title` | String |'].join('\n')
  const claims = parseSpecDoc(md, 'docs/all.md')
  const gaps = compareClaims(claims.claims, {
    models: new Set(['Request']),
    fields: new Map([['Request', new Set(['title'])]]),
    endpoints: new Set(['/api/requests']),
  })
  assert.equal(gaps.length, 0, `误报：${JSON.stringify(gaps)}`)
})

check('对账：重建 2026-10-24 的噪声文档，缺口必须为 0', () => {
  const md = [
    '# 界面组件',
    '',
    '| 图标 | 用途 |',
    '|---|---|',
    '| IconAlert | 警告 |',
    '| TrendLine | 趋势 |',
    '| BatchBar | 批次条 |',
    '',
    '# 字段说明',
    '',
    '列表里 join 了两张表，字段 enant 是 tenant 的笔误。',
    '接口 /api/none 只是举例。',
  ].join('\n')
  const r = parseSpecDoc(md, 'docs/noise.md')
  assert.equal(r.claims.length, 0)
  assert.equal(compareClaims(r.claims, { models: new Set(), fields: new Map(), endpoints: new Set() }).length, 0)
})

check('归一化：参数段与尾斜杠', () => {
  assert.equal(normalizeEndpoint('/api/requests/:id/'), '/api/requests/[id]')
  assert.equal(normalizeEndpoint('/api/requests/'), '/api/requests')
})

check('确定性：同一输入两次结果完全一致', () => {
  const md = ['| 模型 | 字段 |', '|---|---|', '| Request | `title` |'].join('\n')
  const a = JSON.stringify(parseSpecDoc(md, 'docs/x.md'))
  const b = JSON.stringify(parseSpecDoc(md, 'docs/x.md'))
  assert.equal(a, b)
})

console.log(`SPEC_TABLES passed=${cases} failed=${process.exitCode ? 'yes' : 0}`)
