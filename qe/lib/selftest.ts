import { defaultConfig, mergeConfig } from './config.ts'
import { registry as defaultRegistry } from '../registry/registry.ts'
import { NotApplicable } from './not-applicable.ts'
import type { Guard, GuardCase } from './guard.ts'

export interface SelfTestCaseResult {
  guard: string
  title: string
  caseName: string
  expect: string
  pass: boolean
  errors: number
  warnings: number
  infos: number
  detail?: string
}

export async function runSelfTest(
  guards: Guard[],
  registry = defaultRegistry,
): Promise<SelfTestCaseResult[]> {
  const results: SelfTestCaseResult[] = []

  for (const guard of guards) {
    if (!guard.selfTest || guard.selfTest.length === 0) {
      results.push({
        guard: guard.id,
        title: guard.title,
        caseName: '(missing)',
        expect: '-',
        pass: false,
        errors: 0,
        warnings: 0,
        infos: 0,
        detail: '无坏样本：不满足守卫三态（建成/反证/在位）',
      })
      continue
    }
    for (const c of guard.selfTest) {
      const config = mergeConfig(defaultConfig, c.config)
      const ctx = { root: c.root, config, registry: c.registry ?? registry }
      let errors = 0
      let warnings = 0
      let infos = 0
      let detail: string | undefined
      let skipCode: string | undefined
      try {
        const result = await guard.run(ctx)
        errors = result.findings.filter((f) => f.level === 'error').length
        warnings = result.findings.filter((f) => f.level === 'warn').length
        infos = result.findings.filter((f) => f.level === 'info').length
      } catch (e) {
        detail = (e as Error).message
        if (e instanceof NotApplicable) skipCode = e.code
      }
      // `expect: 'skip'` 是唯一把 NotApplicable 当通过的期望：断言「这里该跳过」本身
      // 就是一条判据（射程为 0 时必须走 NotApplicable，而不是给一个空集恒真的绿）。
      // 其余期望遇到 NotApplicable 一律 FAIL —— 否则「把射程关掉」就能让任何坏样本变绿。
      if (c.expect === 'skip') {
        const pass = skipCode !== undefined
        detail = pass ? `skip:${skipCode}` : (detail ?? `expect=skip 但守卫未抛 NotApplicable（errors=${errors} warnings=${warnings}）`)
        results.push({
          guard: guard.id,
          title: guard.title,
          caseName: c.name,
          expect: c.expect,
          pass,
          errors,
          warnings,
          infos,
          detail,
        })
        continue
      }
      const pass = detail === undefined && expectationMet(c, errors, warnings, infos)
      results.push({
        guard: guard.id,
        title: guard.title,
        caseName: c.name,
        expect: c.expect,
        pass,
        errors,
        warnings,
        infos,
        detail,
      })
    }
  }
  return results
}

function expectationMet(c: GuardCase, errors: number, warnings: number, infos: number): boolean {
  if (c.minErrors !== undefined && errors < c.minErrors) return false
  if (c.minWarnings !== undefined && warnings < c.minWarnings) return false
  if (c.minInfos !== undefined && infos < c.minInfos) return false
  // 上限：判据过松（射程误宽/白名单误加）只会让读数变大，`min*` 抓不到这类退化
  if (c.maxErrors !== undefined && errors > c.maxErrors) return false
  if (c.maxWarnings !== undefined && warnings > c.maxWarnings) return false
  if (c.maxInfos !== undefined && infos > c.maxInfos) return false
  if (c.expect === 'red') return errors > 0
  if (c.expect === 'warn') return errors === 0 && warnings > 0
  if (c.expect === 'info') return errors === 0 && warnings === 0 && infos > 0
  return errors === 0 && warnings === 0
}
