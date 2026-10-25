import path from 'node:path'
import { defineGuard, err, info, warn } from '../lib/guard.ts'
import { loadContracts } from '../lib/contracts.ts'
import { findPattern } from '../lib/search.ts'
import { readTextSafe } from '../lib/fs.ts'
import { NotApplicable } from '../lib/not-applicable.ts'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/inv06-promise-backing')

export const inv06 = defineGuard({
  id: 'inv06-promise-backing',
  title: '幽灵规则：承诺句没有抛错点/写点背书',
  invariants: ['INV-CORE-06'],
  blindSpots: [
    '承诺句必须先在 qe.contracts.json 登记；未登记的承诺句不在射程（登记制本身由复审流程兜底）',
    '背书判据是正则命中，不校验语义是否真的拦住',
    '只扫配置的源码根目录，文档/迁移里的抛错点不计入',
  ],
  async run(ctx) {
    const contracts = await loadContracts(ctx.root, ctx.config)
    if (!contracts) {
      // 台账未配置 = 本判据没有事实来源，**不是缺陷**。
      // 报 error 的后果实测过：目标仓没跑过 init，于是每轮顶两条红，把真洞的读数淹掉。
      // 诚实的状态是 skipped（「本轮未检查」），它计入 skipped 而不是 errors。
      throw new NotApplicable(
        'CONTRACTS_MISSING',
        `契约台账未配置：${ctx.config.contracts}（承诺句无处登记 ⇒ 本轮未检查；先跑 qe init 建台账）`,
      )
    }
    const findings = []
    for (const p of contracts.promises) {
      const sourceText = await readTextSafe(path.join(ctx.root, p.source.file))
      if (sourceText === null) {
        findings.push(err('PROMISE_SOURCE_MISSING', `${p.id} 指向的承诺出处不存在：${p.source.file}（登记已过期）`, { entity: p.id, file: p.source.file }))
        continue
      }
      const claim = p.source.contains?.trim() || p.claim
      if (!sourceText.includes(claim)) {
        findings.push(
          err('PROMISE_STALE', `${p.id} 的承诺句已不在出处：${p.source.file}（册面漂移或已删句，须重新裁决）`, {
            entity: p.id,
            file: p.source.file,
          }),
        )
        continue
      }
      const result = await findPattern(ctx.root, p.backing.roots, p.backing.pattern, ctx.config)
      if (result.regexError) {
        findings.push(err('BAD_PATTERN', `${p.id} 的背书正则有误：${result.regexError}`, { entity: p.id }))
        continue
      }
      if (!result.matched) {
        findings.push(
          err('GHOST_PROMISE', `${p.id}「${p.claim}」全仓无背书（pattern=${p.backing.pattern}，扫 ${result.files} 文件）：幽灵规则`, {
            entity: p.id,
          }),
        )
      }
    }
    if (contracts.promises.length === 0) {
      findings.push(warn('NO_PROMISES', '契约台账里没有承诺句：守卫空转（空集恒真）'))
    } else if (findings.length === 0) {
      findings.push(info('PROMISE_CLEAN', `承诺句 ${contracts.promises.length} 条，全部有背书`))
    }
    return {
      findings,
      scanned: `promises=${contracts.promises.length} roots=${contracts.promises.map((p) => p.backing.roots.join('+')).join(',') || '-'}`,
    }
  },
  selfTest: [
    { name: 'good：承诺句与抛错点一一对应', root: path.join(FIXTURES, 'good'), expect: 'green' },
    { name: 'bad：册面有承诺、源码无背书', root: path.join(FIXTURES, 'bad'), expect: 'red', minErrors: 1 },
  ],
})
