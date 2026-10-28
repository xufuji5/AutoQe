/**
 * AQ018 · 假数据兜底：dev 门控或异常分支直接返回写死的业务数据。
 *
 * ## 事故形态
 *
 * 接口还没接通（或本地没有凭证）时，AI 最省力的写法是在门控里塞一份写死的数据：
 *
 * ```ts
 * if (process.env.NODE_ENV !== 'production') {
 *   return [{ id: 1, name: '示例 A' }, { id: 2, name: '示例 B' }]
 * }
 * ```
 *
 * 以及更容易上线的一种——**异常兜底返回一份像真的数据**：
 *
 * ```ts
 * try { return await loadOrders() } catch { return [{ id: 0, name: '暂无' }] }
 * ```
 *
 * 两者都不会报错：页面有内容、接口有返回、类型正确。真正的问题是**数据来源不可归因**：
 * 接口挂了、鉴权配错了、环境变量漏了，界面照样显示「有数据」，于是没人去查。
 * 这一族缺陷最后都表现成「对账对不上，但线上看起来一切正常」。
 *
 * ## 判据（形态可复算）
 *
 * A. `if (<dev 门控>)` 的分支体里 `return` 一个字面量数组（≥2 项，或单条 ≥2 字段的记录）
 *    或字面量对象（≥2 个键且含数据字段），直接报；
 * B. `catch { … }` 体里没有 `throw`，却 `return` 上述字面量数据，直接报。
 *
 * 空值兜底（`return []` / `null` / `{ ok: false }`）**不报**：那是诚实降级，
 * 页面会进空态，问题能被看见——与「拿假数据把空态盖住」是两件事。
 *
 * ## 为什么是 warn
 *
 * dev 门控里的演示数据、离线模式下的本地缓存都可能合法。机器能证死的只有形态
 * （「这里确实返回了一份写死的数据」），不能证死意图（「这份数据是不是故意留的」）。
 * 所以本条固定出候选：triaged 时问一句「这份数据在接口挂掉时会不会被当成真数据」。
 * 要升级成 error，必须先给出可复算的判据（例如「本文件没有任何取数入口」），
 * 那是另一条规则。
 */
import { splitArgs, stripComments, maskStringBodies } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit } from '../lib/rule-guard.ts'

/** dev 门控：命中即认为「这段分支只应在开发环境跑」 */
const DEV_GATE =
  /(?:NODE_ENV\s*!==?\s*['"]production['"]|NODE_ENV\s*===?\s*['"]development['"]|import\.meta\.env\.DEV\b|\b__DEV__\b|\bisDev\b|\bdevMode\b|!\s*isProd\b|!\s*prod\b)/

/** 数据型键：对象兜底必须含其中之一，避免把配置/错误对象当成数据 */
const DATA_KEY = /['"]?(?:items|rows|list|data|records|users|products|orders|entries|result)['"]?\s*:/

const NON_PROD = /(^|\/)(?:__tests__|tests?|specs?|stories|fixtures?|mocks?|testdata)(\/|$)/
const TEST_FILENAME = /\.(?:test|spec|stories)\./

/** 从 `open` 处配对到同名闭合符；不配对返回 -1（看不清就不报） */
function matchDelim(code: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
  const closer = pairs[code[open]]
  if (!closer) return -1
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === code[open]) depth++
    else if (code[i] === closer) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 分支体里是否 `return` 了一份写死的数据。
 *
 * `masked` 用于结构（字符串里的括号/逗号不参与），`raw` 用于读键名与字段名。
 * 两者逐字符等长，偏移可直接互换。
 */
function returnsLiteralData(masked: string, raw: string): boolean {
  const re = /\breturn\s*([\[{])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1
    const close = matchDelim(masked, open)
    if (close < 0) continue
    const items = splitArgs(masked.slice(open + 1, close)).filter((s) => s.trim() !== '')
    if (masked[open] === '[') {
      if (items.length >= 2) return true
      // 单条记录（`[{ id: 1, name: '示例' }]`）同样是假数据：要求对象至少两个字段
      if (items.length === 1 && items[0].trim().startsWith('{')) {
        const objOpen = masked.indexOf('{', open + 1)
        const objClose = objOpen < 0 ? -1 : matchDelim(masked, objOpen)
        if (objClose > 0) {
          const fields = splitArgs(masked.slice(objOpen + 1, objClose)).filter((s) => s.trim() !== '')
          if (fields.length >= 2) return true
        }
      }
      continue
    }
    if (items.length < 2) continue
    const literal = raw.slice(open, close + 1)
    if (DATA_KEY.test(literal)) return true
  }
  return false
}

/** 取 `{` 体的掩码/原文两份（掩码用于结构，原文用于读键名） */
function bracedBody(masked: string, raw: string, open: number): { masked: string; raw: string } | null {
  const close = matchDelim(masked, open)
  if (close < 0) return null
  return { masked: masked.slice(open + 1, close), raw: raw.slice(open + 1, close) }
}

export const aq18 = toGuard({
  id: 'aq18',
  title: '假数据兜底（dev 门控 / 异常分支直接返回写死数据）',
  invariants: ['INV-RES-05'],
  code: 'AQ018_DEV_DATA_FALLBACK',
  level: 'warn',
  blindSpots: [
    '只认 `if (<dev 门控>)` 与 `catch { … }` 两种载体；三元表达式、`??`、`||`、`switch` 分支里的写死数据不可见',
    '门控词表是有限的（NODE_ENV / import.meta.env.DEV / isDev / !isProd…）：自定义环境变量（`APP_ENV !== "prod"`）不认',
    '数据判定看「字面量数组 ≥2 项 / 单条 ≥2 字段记录」或「字面量对象 ≥2 键且含数据字段」：变量拼接、先赋常量再 return 都不在射程',
    'catch 里只要出现 `throw` 就放过——但 `throw` 也可能写在另一条分支里，静态不做可达性分析',
    '不判断这份数据在运行时是否真的会被展示（那需要数据流）；本条只出候选，由人回答「接口挂掉时它会不会被当成真数据」',
    'dev 门控在构建期被常量折叠而整段删除的工程，本条命中也是候选，不是缺陷',
  ],
  impact:
    '门控/兜底分支直接返回写死的业务数据：接口失败、鉴权配错或环境变量漏配时，界面照样「有数据」，' +
    '问题被假数据盖住；这类缺陷最终都表现成「线上看起来正常，对账对不上」',
  provenance:
    '试点 B（2026-10）：列表页在 dev 门控里返回三条示例数据，接口 401 时页面仍显示三条；另一次是 catch 里返回一份写死的记录列表，把「网关超时」显示成了「有一条待处理」',
  applies(rel) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|mts)$/.test(rel)) return false
    if (/(^|\/)node_modules\//.test(rel)) return false
    if (NON_PROD.test(rel) || TEST_FILENAME.test(rel)) return false
    if (/(selftest|fixture|testdata)/i.test(rel)) return false
    return true
  },
  analyze(src): RawHit[] {
    const raw = stripComments(src)
    const masked = maskStringBodies(raw)
    const hits: RawHit[] = []

    // ── A. dev 门控内直接 return 写死数据 ─────────────────────────────
    const IF = /\bif\s*\(/g
    let m: RegExpExecArray | null
    while ((m = IF.exec(masked)) !== null) {
      const open = m.index + m[0].length - 1
      const close = matchDelim(masked, open)
      if (close < 0) continue
      const cond = raw.slice(open + 1, close)
      if (!DEV_GATE.test(cond)) continue

      // 分支体：带花括号取体内；单语句取到行尾
      let bodyStart = close + 1
      while (bodyStart < masked.length && /\s/.test(masked[bodyStart])) bodyStart++
      let body: { masked: string; raw: string } | null = null
      if (masked[bodyStart] === '{') {
        body = bracedBody(masked, raw, bodyStart)
      } else {
        let end = masked.indexOf('\n', bodyStart)
        if (end < 0) end = masked.length
        body = { masked: masked.slice(bodyStart, end), raw: raw.slice(bodyStart, end) }
      }
      if (!body) continue
      if (!returnsLiteralData(body.masked, body.raw)) continue

      hits.push({
        line: lineOf(src, m.index),
        message:
          `dev 门控（\`${cond.trim().slice(0, 60)}\`）分支直接返回写死的数据：` +
          '门控写错、构建期常量折叠失效或环境变量漏配时，这份假数据会进入生产，' +
          '把「接口没通/鉴权配错」伪装成「有数据」。删除兜底数据，让它走真实的空态或报错',
        evidence: evidenceOf(src, m.index),
      })
    }

    // ── B. catch 里没有 throw，却 return 写死数据 ─────────────────────
    const CATCH = /\bcatch\s*(?:\([^)]*\))?\s*\{/g
    while ((m = CATCH.exec(masked)) !== null) {
      const open = m.index + m[0].length - 1
      const body = bracedBody(masked, raw, open)
      if (!body) continue
      if (/\bthrow\b/.test(body.masked)) continue
      if (!returnsLiteralData(body.masked, body.raw)) continue

      hits.push({
        line: lineOf(src, m.index),
        message:
          'catch 分支没有重抛，却返回一份写死的业务数据：接口失败/超时时，调用方拿到的是「看起来正常」的数据，' +
          '错误被吞掉、页面不进空态、也没人收到告警。请重抛、返回明确的错误结构，或返回真正的空值',
        evidence: evidenceOf(src, m.index),
      })
    }

    return hits
  },
  fixtures: [
    {
      name: 'dev 门控返回写死列表（该报）',
      expect: 'warn',
      rel: 'src/app/items/page.tsx',
      src:
        "export async function load() {\n" +
        "  if (process.env.NODE_ENV !== 'production') {\n" +
        "    return [{ id: 1, name: '示例 A' }, { id: 2, name: '示例 B' }]\n" +
        '  }\n' +
        "  return fetch('/api/items').then((r) => r.json())\n" +
        '}\n',
    },
    {
      name: '自定义生产标志的反向门控（该报）：isProd 漏配就是生产假数据',
      expect: 'warn',
      rel: 'src/lib/orders.ts',
      src:
        'export function loadOrders() {\n' +
        "  if (!isProd) return [{ id: 1, title: '记录 A' }, { id: 2, title: '记录 B' }]\n" +
        '  return callApi()\n' +
        '}\n',
    },
    {
      name: 'catch 返回写死数据（该报）',
      expect: 'warn',
      rel: 'src/lib/report.ts',
      src:
        'export async function load() {\n' +
        '  try {\n' +
        '    return await callApi()\n' +
        '  } catch {\n' +
        "    return [{ id: 0, name: '暂无' }]\n" +
        '  }\n' +
        '}\n',
    },
    {
      name: 'catch 返回假成功对象（该报）',
      expect: 'warn',
      rel: 'src/lib/pay.ts',
      src:
        'export async function charge() {\n' +
        '  try { return await gateway() } catch { return { ok: true, items: [] } }\n' +
        '}\n',
    },
    {
      name: '空值兜底（不该报）：空态能被看见',
      expect: 'green',
      rel: 'src/lib/report.ts',
      src:
        'export async function load() {\n' +
        '  try { return await callApi() } catch { return [] }\n' +
        '}\n',
    },
    {
      name: '错误结构兜底（不该报）：明确告诉调用方失败',
      expect: 'green',
      rel: 'src/lib/pay.ts',
      src:
        'export async function charge() {\n' +
        "  try { return await gateway() } catch { return { ok: false, code: 'GATEWAY_FAILED' } }\n" +
        '}\n',
    },
    {
      name: 'catch 重抛（不该报）',
      expect: 'green',
      rel: 'src/lib/pay.ts',
      src:
        'export async function charge() {\n' +
        '  try { return await gateway() } catch (e) {\n' +
        '    throw new Error(String(e))\n' +
        '  }\n' +
        '}\n',
    },
    {
      name: '普通条件（不是 dev 门控）（不该报）',
      expect: 'green',
      rel: 'src/lib/items.ts',
      src:
        'export function pick(items: Item[]) {\n' +
        "  if (items.length === 0) return [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]\n" +
        '  return items\n' +
        '}\n',
    },
    {
      name: '生产分支返回数据（不该报）：门控判的是生产而非开发',
      expect: 'green',
      rel: 'src/lib/items.ts',
      src:
        "export function load() {\n  if (process.env.NODE_ENV === 'production') return [{ id: 1 }, { id: 2 }]\n  return devOnly()\n}\n",
    },
    {
      name: '注释里的兜底（不该报）：去注释先于解析',
      expect: 'green',
      rel: 'src/lib/items.ts',
      src:
        "// if (!isProd) return [{ id: 1 }, { id: 2 }]\n" +
        'export const ok = true\n',
    },
  ],
})
