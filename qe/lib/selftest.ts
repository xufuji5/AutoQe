import { defaultConfig, mergeConfig } from './config.ts'
import { registry as defaultRegistry } from '../registry/registry.ts'
import type { Guard, GuardCase } from './guard.ts'

export interface SelfTestCaseResult {
  guard: string
  title: string
  caseName: string
  expect: string
  pass: boolean
  errors: number
  warnings: number
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
        detail: '无坏样本：不满足守卫三态（建成/反证/在位）',
      })
      continue
    }
    for (const c of guard.selfTest) {
      const config = mergeConfig(defaultConfig, c.config)
      const ctx = { root: c.root, config, registry: c.registry ?? registry }
      let errors = 0
      let warnings = 0
      let detail: string | undefined
      try {
        const result = await guard.run(ctx)
        errors = result.findings.filter((f) => f.level === 'error').length
        warnings = result.findings.filter((f) => f.level === 'warn').length
      } catch (e) {
        detail = (e as Error).message
      }
      const pass = detail === undefined && expectationMet(c, errors, warnings)
      results.push({
        guard: guard.id,
        title: guard.title,
        caseName: c.name,
        expect: c.expect,
        pass,
        errors,
        warnings,
        detail,
      })
    }
  }
  return results
}

function expectationMet(c: GuardCase, errors: number, warnings: number): boolean {
  if (c.minErrors !== undefined && errors < c.minErrors) return false
  if (c.minWarnings !== undefined && warnings < c.minWarnings) return false
  if (c.expect === 'red') return errors > 0
  if (c.expect === 'warn') return errors === 0 && warnings > 0
  return errors === 0 && warnings === 0
}
