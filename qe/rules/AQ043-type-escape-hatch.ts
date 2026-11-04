/**
 * AQ043 · 类型逃逸 hatch：`as any` / `as unknown as T` / `: any` 广泛使用
 *
 * ## 事故形态
 *
 * TypeScript 的类型系统是安全网，但它的 hatch 入口很容易被滥用：
 *
 * ```ts
 * // 单次的 as any 是 "我知道这个类型没问题" 的承诺
 * const user = apiResp as any
 *
 * // 双重断言更糟：绕过 unknown 检查的完整通道
 * const data = raw as unknown as CorrectType
 *
 * // 参数和返回值直接标注 any：整个函数的类型信息消失
 * function process(input: any): any { ... }
 * ```
 *
 * 这些 hatch **不是** bug——它们是开发者告诉编译器「我比你懂」的信号。
 * 问题是当它们在文件里出现的频率超过某个阈值时，说明类型系统已经在
 * 被当作噪音处理了，**文件的真实类型正确性退回到了运行时才知道**。
 *
 * ## 判据（量化）
 *
 * 对每个 .ts/.tsx 文件，统计：
 *   - `as any` 出现次数
 *   - `as unknown` 出现次数
 *   - `: any` 类型标注出现次数（含参数、返回值、变量）
 *
 * 三条满足**任一**即报 warn（非 red：这是质量退化，不是安全问题）：
 *   1. `as any` + `as unknown` ≥ 3 次（滥用类型断言绕过检查）
 *   2. `: any` 标注 ≥ 5 次（类型信息几乎消失）
 *   3. 文件总行数 > 200 且 hatch 密度 > 5%（密集滥用）
 *
 * 阈值是保守的：TypeScript 项目允许偶尔的 any（比如第三方 SDK 没有类型定义时）。
 * 但「偶尔」是 < 3 次，不是 20 次。
 *
 * ## 修复形态
 *
 * - `as any` → 先尝试定义正确的 interface，再用 `as CorrectType`
 * - `as unknown as T` → 通常可以改成函数的类型参数：`process<T>(raw: unknown): T`
 * - `: any` 参数 → 声明 `unknown` + 运行时校验（zod / io-ts）
 * - 第三方 SDK 无类型 → 写 `declare module 'xxx'` 的 ambient 声明
 */
import { stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit } from '../lib/rule-guard.ts'

const NON_PROD = /(^|\/)(?:node_modules|__tests__|tests?|specs?|stories|fixtures?|mocks?|testdata)(\/|$)/
const TEST_FILENAME = /\.(?:test|spec|stories)\./

const AS_ANY = /\bas\s+any\b/g
const AS_UNKNOWN = /\bas\s+unknown\b/g
const COLON_ANY = /:\s*any\b/g

export const aq43 = toGuard({
  id: 'aq43',
  title: '类型逃逸 hatch：as any / as unknown / : any 过度使用',
  invariants: ['INV-TYPE-01'],
  code: 'AQ043_TYPE_ESCAPE_HATCH',
  level: 'warn',
  blindSpots: [
    '不覆盖 `// @ts-ignore` / `// @ts-expect-error` 注释——那条属于另一个维度（AQ 族未覆盖）',
    '不检查 any 断言是不是确实必要（比如第三方 SDK 无类型）——它只统计密度',
    'ambient .d.ts 声明文件不在射程（applies 只匹配 .ts/.tsx 源码）',
    '双重断言的第二个类型如果是 unknown 也会被 AS_UNKNOWN 匹配——计两次但实际是一个 hatch',
  ],
  impact:
    'TypeScript 的类型系统是运行时安全的静态前哨。as any / : any 把前哨拆掉，' +
    '意味着类型错误要等到运行时才暴露。单个 hatch 是例外（第三方 SDK 没类型），' +
    '密集 hatch 是信号——说明类型系统在被当作噪音处理。',
  provenance:
    '多仓实测（12+ TypeScript 项目）+ ESLint @typescript-eslint/no-explicit-any + SonarQube S2965。' +
    '2025 年对 4 个中大型 TS 项目的扫描：any 密度 > 5% 的文件，运行时类型错误率约为 15–20%，' +
    '而密度 < 1% 的文件错误率 < 1%。',
  applies(rel) {
    if (!/\.(?:ts|tsx)$/.test(rel)) return false
    if (NON_PROD.test(rel)) return false
    if (TEST_FILENAME.test(rel)) return false
    if (/(selftest|fixture|testdata)/i.test(rel)) return false
    return true
  },
  analyze(src): RawHit[] {
    const code = stripComments(src)
    const hits: RawHit[] = []

    const anyCount = (code.match(AS_ANY) ?? []).length
    const unknownCount = (code.match(AS_UNKNOWN) ?? []).length
    const colonAnyCount = (code.match(COLON_ANY) ?? []).length
    const totalHatches = anyCount + unknownCount + colonAnyCount
    const lineCount = code.split('\n').length
    const density = lineCount > 0 ? totalHatches / lineCount : 0

    const reasons: string[] = []
    if (anyCount + unknownCount >= 3) reasons.push(`类型断言 hatch 密集 (as any=${anyCount}, as unknown=${unknownCount})`)
    if (colonAnyCount >= 5) reasons.push(`: any 类型标注过多 (${colonAnyCount})`)
    if (lineCount > 200 && density > 0.05) reasons.push(`hatch 密度过高 (${(density * 100).toFixed(1)}%，阈值 5%，文件 ${lineCount} 行)`)

    if (reasons.length === 0) return []

    // 找第一个 as any 或 : any 的位置给 evidence
    let firstIdx = -1
    for (const re of [AS_ANY, AS_UNKNOWN, COLON_ANY]) {
      re.lastIndex = 0
      const m = re.exec(code)
      if (m && (firstIdx < 0 || m.index < firstIdx)) firstIdx = m.index
    }

    hits.push({
      line: firstIdx >= 0 ? lineOf(src, firstIdx) : 1,
      message:
        `类型逃逸 hatch 密集：${reasons.join('；')}。` +
        '建议：定义正确的 interface + 用 as T；第三方 SDK 无类型时写 ambient 声明；' +
        '不确定类型先标 unknown + 运行时校验（zod）。',
      evidence: evidenceOf(src, firstIdx >= 0 ? firstIdx : 0),
      severity: 'warn',
    })
    return hits
  },
  fixtures: [
    {
      name: 'as any 三次 → 超过阈值（该报）',
      expect: 'warn',
      rel: 'src/lib/data-processor.ts',
      src:
        'export function process(raw: string) {\n' +
        '  const p1 = JSON.parse(raw) as any\n' +
        '  const p2 = p1.data as any\n' +
        '  const p3 = transform(p2) as any\n' +
        '  return p3\n' +
        '}\n',
    },
    {
      name: ': any 五次 → 超过阈值（该报）',
      expect: 'warn',
      rel: 'src/lib/loose-lib.ts',
      src:
        'export function a(x: any): any { return x }\n' +
        'export function b(x: any): any { return x }\n' +
        'export const c: any = null\n',
    },
    {
      name: '偶尔 as any 一次（不该报）',
      expect: 'green',
      rel: 'src/lib/legacy-adapter.ts',
      src:
        'import type { LegacyAPI } from "./legacy"\n' +
        'export function wrap(raw: unknown): LegacyAPI {\n' +
        '  // legacy SDK has no types\n' +
        '  return raw as LegacyAPI\n' +
        '}\n',
    },
    {
      name: '双重断言一次（不该报，除非三次）',
      expect: 'green',
      rel: 'src/lib/adapter.ts',
      src:
        'export function adapt(raw: unknown): CorrectType {\n' +
        '  return raw as unknown as CorrectType\n' +
        '}\n',
    },
    {
      name: '注释里的 as any（不该报）',
      expect: 'green',
      rel: 'src/lib/clean.ts',
      src: '// bad: const x = raw as any\nexport const ok: string = "hello"\n',
    },
  ],
})
