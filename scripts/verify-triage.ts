import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { POLICIES, renderTriageMarkdown, todayList, triage, triageLines } from '../qe/lib/triage.ts'
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

console.log(`TRIAGE_SELFTEST cases=${cases} passed=${cases}`)
