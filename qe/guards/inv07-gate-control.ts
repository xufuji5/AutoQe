import path from 'node:path'
import { defineGuard, err, info, warn } from '../lib/guard.ts'
import { loadContracts } from '../lib/contracts.ts'
import { NotApplicable } from '../lib/not-applicable.ts'
import { findPattern } from '../lib/search.ts'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/inv07-gate-control')

export const inv07 = defineGuard({
  id: 'inv07-gate-control',
  title: '空转闸：拒收判据没有界面入口，或控件没有服务端判据',
  invariants: ['INV-CORE-07'],
  blindSpots: [
    '只验「判据存在 / 控件存在」字符串，不验控件是否可达、是否真的提交该字段',
    '闸清单来自 qe.contracts.json，未登记的闸不在射程',
    '移动端/离线队列等消费端需在各仓 AC 配置里列入 roots 才能覆盖',
  ],
  async run(ctx) {
    const contracts = await loadContracts(ctx.root, ctx.config)
    if (!contracts) {
      // 同 inv06：台账缺失是「没有事实来源」，不是缺陷（实测目标仓每轮因此白顶一条红）
      throw new NotApplicable(
        'CONTRACTS_MISSING',
        `契约台账未配置：${ctx.config.contracts}（闸清单无处登记 ⇒ 本轮未检查；先跑 qe init 建台账）`,
      )
    }
    const findings = []
    for (const g of contracts.gates) {
      const server = await findPattern(ctx.root, g.server.roots, g.server.pattern, ctx.config)
      const control = await findPattern(ctx.root, g.control.roots, g.control.pattern, ctx.config)
      if (server.regexError || control.regexError) {
        findings.push(err('BAD_PATTERN', `${g.id} 的判据正则有误：${server.regexError ?? control.regexError}`, { entity: g.id }))
        continue
      }
      if (!server.matched) {
        findings.push(
          err('GHOST_GATE', `${g.id}「${g.reject}」有界面控件但服务端无判据（pattern=${g.server.pattern}）：界面承诺的力 ≠ 服务端的力`, {
            entity: g.id,
          }),
        )
      }
      if (!control.matched) {
        findings.push(
          err('DEAD_GATE', `${g.id}「${g.reject}」服务端有判据但界面无入口（pattern=${g.control.pattern}）：判据永远走空分支`, {
            entity: g.id,
          }),
        )
      }
    }
    if (contracts.gates.length === 0) {
      findings.push(warn('NO_GATES', '闸清单为空：守卫空转（空集恒真）'))
    } else if (findings.length === 0) {
      findings.push(info('GATE_CLEAN', `闸 ${contracts.gates.length} 道，界面入口与服务端判据齐全`))
    }
    return {
      findings,
      scanned: `gates=${contracts.gates.length} serverRoots=${contracts.gates.map((g) => g.server.roots.join('+')).join(',') || '-'} controlRoots=${contracts.gates.map((g) => g.control.roots.join('+')).join(',') || '-'}`,
    }
  },
  selfTest: [
    // 契约台账默认未配置（空串）：用例必须显式声明自己的台账，否则本判据按设计 skipped。
    { name: 'good：两道闸的判据与控件齐全', root: path.join(FIXTURES, 'good'), expect: 'green', config: { contracts: 'qe.contracts.json' } },
    { name: 'bad：一闸无控件、一闸无判据', root: path.join(FIXTURES, 'bad'), expect: 'red', minErrors: 2, config: { contracts: 'qe.contracts.json' } },
  ],
})
