import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  addWaiver,
  loadWaivers,
  POLICY_META,
  POLICIES,
  readExternalFindings,
  renderTriageMarkdown,
  todayList,
  triage,
  triageLines,
} from '../qe/lib/triage.ts'
import { defaultConfig } from '../qe/lib/config.ts'
import type { Finding } from '../qe/lib/guard.ts'
import type { GuardReadout } from '../qe/lib/report.ts'

const finding = (code: string, level: Finding['level'] = 'error'): Finding => ({ code, level, message: code, entity: 'sample' })
const readout = (findings: Finding[], skipped?: string): GuardReadout => ({ guard: 'sample', findings, scanned: '1', skipped })

let cases = 0
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn()
  cases++
  console.log(`OK ${name}`)
}

await check('ZERO_WRITER 进入「需要你选」而不是直接改', () => {
  const r = triage([readout([finding('ZERO_WRITER')])])
  assert.deepEqual([r.fix, r.decide, r.record], [0, 1, 0])
  assert.ok(r.groups[0].policy.options!.length >= 2, 'decide 必须给多方案')
})

await check('PERSIST_NO_VERSION 进入「直接改」且不自动落盘', () => {
  const r = triage([readout([finding('PERSIST_NO_VERSION')])])
  assert.equal(r.fix, 1)
  assert.equal(r.groups[0].policy.auto, undefined, '源码改动不得自动执行')
})

await check('ALIAS_MISSING 是唯一可 --apply 的自动项', () => {
  const r = triage([readout([finding('ALIAS_MISSING')])])
  assert.equal(r.groups[0].policy.auto, 'package-alias')
})

await check('UNWIRED_SCRIPT 只备案，且不进「今天只做这些」', () => {
  const r = triage([readout([finding('UNWIRED_SCRIPT', 'warn')])])
  assert.equal(r.record, 1)
  assert.equal(todayList(r).length, 0)
})

await check('未登记代码默认进入「需要你选」，绝不自动备案', () => {
  const r = triage([readout([finding('MYSTERY_CODE')])])
  assert.equal(r.decide, 1)
  assert.equal(r.record, 0)
  assert.deepEqual(r.unknown, ['MYSTERY_CODE'])
})

await check('空集给 0 项，不产出任何「通过」文本', () => {
  const r = triage([])
  assert.equal(r.fix + r.decide + r.record, 0)
})

await check('info 级发现不产生待办', () => {
  const r = triage([readout([finding('ZERO_WRITER', 'info')])])
  assert.equal(r.fix + r.decide + r.record, 0)
})

await check('处置政策表自身合法', () => {
  for (const [code, p] of Object.entries(POLICIES)) {
    if (p.disposition === 'decide') assert.ok((p.options?.length ?? 0) >= 2, `${code} 必须给至少两个方案`)
    if (p.disposition === 'record') assert.equal(p.options, undefined, `${code} 是备案项，不应给方案`)
    if (p.auto) assert.equal(p.disposition, 'fix', `${code} 只有 fix 才允许自动执行`)
  }
})

await check('每条政策都有完整双语，且英文侧无中文', () => {
  const cjk = /[\u4e00-\u9fff]/
  for (const [code, p] of Object.entries(POLICIES)) {
    assert.ok(p.meaning.en.trim() && p.meaning.zh.trim(), `${code} meaning 缺语言`)
    assert.ok(p.action.en.trim() && p.action.zh.trim(), `${code} action 缺语言`)
    assert.ok(!cjk.test(p.meaning.en), `${code} 英文 meaning 混入中文`)
    assert.ok(!cjk.test(p.action.en), `${code} 英文 action 混入中文`)
    for (const o of p.options ?? []) {
      assert.ok(o.en.trim() && o.zh.trim(), `${code} 选项缺语言`)
      assert.ok(!cjk.test(o.en), `${code} 英文选项混入中文`)
    }
  }
})

await check('en 输出无中文，zh 输出有中文', () => {
  const r = triage([readout([finding('ZERO_WRITER')])])
  const en = triageLines(r, 'en').join('\n')
  const zh = triageLines(r, 'zh').join('\n')
  const cjk = /[\u4e00-\u9fff]/
  assert.ok(!cjk.test(en), 'en 输出混入中文')
  assert.ok(cjk.test(zh), 'zh 输出没有中文')
  assert.ok(!cjk.test(renderTriageMarkdown(r, [], [], 'node qe/cli.ts', 'en')), '英文报告混入中文')
  assert.ok(renderTriageMarkdown(r, [], [], 'node qe/cli.ts', 'zh').includes('处置清单'), '中文报告标题缺失')
})

await check('守卫实际抛出的代码全部有处置意见（射程不是空的）', async () => {
  const dir = path.join(import.meta.dirname, '..', 'qe', 'guards')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.ts') && !f.startsWith('index'))
  const missing = new Set<string>()
  let scanned = 0
  for (const file of files) {
    const text = await readFile(path.join(dir, file), 'utf8')
    for (const m of text.matchAll(/\b(err|warn|info)\(\s*'([A-Z0-9_]+)'/g)) {
      scanned++
      if (m[1] === 'info') continue
      if (!POLICIES[m[2]]) missing.add(m[2])
    }
  }
  assert.ok(scanned > 0, '没有扫到任何判据代码 = 空集恒真')
  assert.equal(missing.size, 0, `缺少处置意见：${[...missing].join(', ')}`)
})

/* ---------------- P0-1：外部 findings 输入 ---------------- */

const tmp = await mkdtemp(path.join(os.tmpdir(), 'autoqe-triage-'))
const writeJson = async (name: string, value: unknown): Promise<string> => {
  const file = path.join(tmp, name)
  await writeFile(file, JSON.stringify(value), 'utf8')
  return file
}

await check('外部输入：裸 Finding[] 可读，缺 level 直接报错不静默丢弃', async () => {
  const good = await writeJson('findings.json', [finding('ZERO_WRITER'), { code: 'DEAD_ENUM', level: 'warn', message: 'x' }])
  const readouts = await readExternalFindings(good)
  assert.equal(readouts.length, 1)
  assert.equal(readouts[0].findings.length, 2)
  const bad = await writeJson('bad.json', [{ code: 'ZERO_WRITER' }])
  await assert.rejects(() => readExternalFindings(bad), /level/)
})

await check('外部输入：qe-report.json 的 guards 块可直读，形状不认识时报错', async () => {
  const report = await writeJson('qe-report.json', {
    metrics: {},
    guards: [{ guard: 'inv01', findings: [finding('ZERO_WRITER')], scanned: '3 models' }],
  })
  const readouts = await readExternalFindings(report)
  assert.equal(readouts[0].guard, 'inv01')
  assert.equal(readouts[0].findings[0].code, 'ZERO_WRITER')
  const wrong = await writeJson('wrong.json', { hello: 'world' })
  await assert.rejects(() => readExternalFindings(wrong), /findings/)
  await assert.rejects(() => readExternalFindings(path.join(tmp, 'missing.json')), /找不到/)
})

await check('外部输入可进入同一套三桶分类', async () => {
  const file = await writeJson('mix.json', { findings: [finding('MUTATION_NO_IDEMPOTENCY'), finding('UNWIRED_SCRIPT', 'warn')] })
  const r = triage(await readExternalFindings(file))
  assert.equal(r.decide, 1)
  assert.equal(r.record, 1)
})

/* ---------------- P0-2：备案载体 ---------------- */

await check('有效备案压制发现，但仍出现在报告里（TRIAGE_WAIVED）', () => {
  const waiver = { code: 'ZERO_WRITER', reason: 'column kept for a migration window', reviewBy: '2099-01-01' }
  const r = triage([readout([finding('ZERO_WRITER')])], { waivers: [waiver], today: '2026-10-23' })
  assert.equal(r.fix + r.decide + r.record, 0)
  assert.equal(r.waived.length, 1)
  const line = triageLines(r, 'en').find((l) => l.startsWith('TRIAGE_WAIVED'))
  assert.ok(line && line.includes('code=ZERO_WRITER'), '被压制的发现必须仍可见')
})

await check('过期备案不压制，自己变成 WAIVER_EXPIRED 待办', () => {
  const waiver = { code: 'ZERO_WRITER', reason: 'migration window', reviewBy: '2026-01-01' }
  const r = triage([readout([finding('ZERO_WRITER')])], { waivers: [waiver], today: '2026-10-23' })
  assert.equal(r.waived.length, 0)
  const codes = r.groups.map((g) => g.code).sort()
  assert.deepEqual(codes, ['WAIVER_EXPIRED', 'ZERO_WRITER'])
  assert.equal(r.groups.find((g) => g.code === 'WAIVER_EXPIRED')!.policy.disposition, 'decide')
})

await check('过期备案即使不再命中任何发现，也要冒出来要求复审', () => {
  const waiver = { code: 'DEAD_ENUM', reason: 'retained', reviewBy: '2026-01-01' }
  const r = triage([], { waivers: [waiver], today: '2026-10-23' })
  assert.equal(r.groups.length, 1)
  assert.equal(r.groups[0].code, 'WAIVER_EXPIRED')
})

await check('非法备案条目（缺理由 / 日期非法）不压制任何发现，报 WAIVER_INVALID', async () => {
  const file = path.join(tmp, 'waivers-bad.json')
  await writeFile(
    file,
    JSON.stringify([
      { code: 'ZERO_WRITER', reason: '', reviewBy: '2099-01-01' },
      { code: 'ZERO_WRITER', reason: 'ok', reviewBy: '2099-13-01' },
    ]),
    'utf8',
  )
  const store = await loadWaivers(tmp, { ...defaultConfig, waivers: path.relative(tmp, file) })
  assert.equal(store.waivers.length, 0)
  assert.equal(store.issues.length, 2)
  const r = triage([readout([finding('ZERO_WRITER')])], { waivers: store.waivers, waiverIssues: store.issues, today: '2026-10-23' })
  assert.equal(r.waived.length, 0)
  assert.equal(r.groups.find((g) => g.code === 'ZERO_WRITER')!.findings.length, 1)
  assert.ok(r.groups.find((g) => g.code === 'WAIVER_INVALID'), '非法条目必须报出来')
})

await check('scope 只压制该路径前缀下的发现', () => {
  const waiver = { code: 'ZERO_WRITER', reason: 'legacy area', reviewBy: '2099-01-01', scope: 'src/legacy' }
  const readouts = [readout([{ ...finding('ZERO_WRITER'), file: 'src/legacy/a.ts' }, { ...finding('ZERO_WRITER'), file: 'src/new/b.ts' }])]
  const r = triage(readouts, { waivers: [waiver], today: '2026-10-23' })
  assert.equal(r.waived.length, 1)
  assert.equal(r.groups.find((g) => g.code === 'ZERO_WRITER')!.findings.length, 1)
})

await check('waive 写入拒绝空理由与过期日期，合法写入落盘且可再读', async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), 'autoqe-waive-'))
  const config = { ...defaultConfig, waivers: 'qe/waivers.json' }
  await assert.rejects(() => addWaiver(project, config, { code: 'ZERO_WRITER', reason: '  ', reviewBy: '2099-01-01', today: '2026-10-23' }), /理由/)
  await assert.rejects(() => addWaiver(project, config, { code: 'ZERO_WRITER', reason: 'x', reviewBy: '2026-01-01', today: '2026-10-23' }), /早于今天/)
  await assert.rejects(() => addWaiver(project, config, { code: 'ZERO_WRITER', reason: 'x', reviewBy: '2026-02-30', today: '2026-10-23' }), /YYYY-MM-DD/)
  const { waiver } = await addWaiver(project, config, { code: 'ZERO_WRITER', reason: 'kept for migration', reviewBy: '2026-12-31', today: '2026-10-23' })
  assert.equal(waiver.reviewBy, '2026-12-31')
  const store = await loadWaivers(project, config)
  assert.equal(store.waivers.length, 1)
  assert.equal(store.issues.length, 0)
})

/* ---------------- P0-3：影响面 / 成本排序 ---------------- */

await check('today list 按影响面降序、同影响面按成本升序，且只取前 5', () => {
  const r = triage([
    readout([finding('ZERO_READER'), finding('ENTRY_NO_VALIDATE'), finding('MUTATION_NO_IDEMPOTENCY'), finding('CROSS_MODULE_RELATIVE')]),
  ])
  const order = r.groups.map((g) => g.code)
  assert.equal(order[0], 'MUTATION_NO_IDEMPOTENCY', '资金影响面必须排第一')
  assert.ok(order.indexOf('ENTRY_NO_VALIDATE') < order.indexOf('ZERO_READER'), 'data 必须排在 trace 之前')
  assert.ok(order.indexOf('CROSS_MODULE_RELATIVE') < order.indexOf('ZERO_READER'), '同为 data 时低成本优先')
  const today = todayList(r)
  assert.ok(today.length <= 5)
  assert.ok(today[0].includes('impact=money') && today[0].includes('effort=L'), 'today list 必须带影响面与成本')
})

await check('POLICY_META 与 POLICIES 无漂移，且每条都有合法 impact/effort', () => {
  const impacts = new Set(['money', 'auth', 'pii', 'data', 'trace'])
  const efforts = new Set(['S', 'M', 'L'])
  for (const [code, meta] of Object.entries(POLICY_META)) {
    assert.ok(POLICIES[code], `POLICY_META 里的 ${code} 没有处置意见`)
    assert.ok(impacts.has(meta.impact), `${code} impact 非法`)
    assert.ok(efforts.has(meta.effort), `${code} effort 非法`)
  }
  for (const g of triage([readout([finding('MYSTERY_CODE')])]).groups) {
    assert.ok(impacts.has(g.impact) && efforts.has(g.effort), `${g.code} 没有合法影响面/成本`)
  }
})

console.log(`TRIAGE_SELFTEST cases=${cases} passed=${cases}`)
