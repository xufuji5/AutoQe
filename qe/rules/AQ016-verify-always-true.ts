/**
 * AQ016 · 假闸门：校验函数不读入参，直接返回「通过」。
 *
 * ## 事故形态
 *
 * 高危操作（短信二次验证、权限判定、金额校验）都有一句「系统会校验 X」。
 * AI 为了让流程先跑通，把校验写成：
 *
 * ```ts
 * export function verifyHighRiskSms(phone: string, code: string) {
 *   return { ok: true }
 * }
 * ```
 *
 * 它不报错、类型也对、调用方拿到的永远是「通过」；**真正的闸门不存在**。
 * 更隐蔽的一档是墙面已经写好了：「高危表里漏登记这个业务」，于是校验函数
 * 连被调用时都提前返回 `ok:true`，前端采集的验证码全部白采。
 *
 * ## 判据（三件事同时成立才报）
 *
 * 1. 函数名以校验动词开头（`verify` / `validate` / `check` / `assert` / `ensure` /
 *    `enforce` / `authorize` / `authenticate`，且动词后必须是大写、下划线、数字或结尾——
 *    `checkout` 不算）；
 * 2. 函数**有形参**（零参函数多半是探活/常量查询，见盲区）；
 * 3. 函数体第一个有效语句就是 `return true` / `return { ok: true, … }`，
 *    且函数体**从未出现任何一个形参名**。
 *
 * 三条都是可从源码复算的事实，不需要理解业务。第 3 条的后半句是关键：
 * 只要函数读了任何一个入参，它就可能是真校验（哪怕只判了一个字段），本条不猜。
 *
 * ## 为什么不判「返回值是不是写死的」
 *
 * `return { ok: true }` 本身合法（健康探针、空实现）。贵的是**签了名却不看输入**：
 * 那意味着调用方以为自己在被校验，实际每次都被放行。判据只在这个交叉点上说话。
 *
 * ## 修复形态
 *
 * 要么把校验写实（读入参、失败给 `{ ok: false, reason }`），要么删掉这个函数并让
 * 调用方显式标注「无校验」——**空函数比假函数诚实**。
 */
import { bodyAfterParen, escapeRe, matchDelimiter, maskRegexBodies, maskStringBodies, parenBody, splitArgs, stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit } from '../lib/rule-guard.ts'

/** 校验动词前缀：动词后必须是大写、下划线、数字或名字结束（`checkout` 不是校验器） */
const VERIFIER_NAME = /^(?:verify|validate|check|assert|ensure|enforce|authorize|authenticate)(?:$|[A-Z_$0-9])/

/** 通过语义的键：对象里出现任意一个 `key: true` 即视为「无条件通过」 */
const PASS_KEY = /\b(?:ok|okay|success|valid|allowed|passed|verified)\s*:\s*true\b/

/** 类型词：形参名提取时排除（它们出现在注解里，不是入参） */
const TYPE_WORDS = new Set([
  'string', 'number', 'boolean', 'unknown', 'any', 'void', 'never', 'object', 'symbol', 'bigint',
  'true', 'false', 'null', 'undefined', 'Promise', 'Record', 'Partial', 'Readonly', 'Array',
  'Date', 'Buffer', 'Request', 'Response', 'NextRequest', 'NextResponse', 'Session', 'User',
])

const NON_PROD = /(^|\/)(?:__tests__|tests?|specs?|stories|fixtures?|mocks?|testdata)(\/|$)/
const TEST_FILENAME = /\.(?:test|spec|stories)\./

/**
 * 形参名清单。只取注解/默认值之前的标识符；解构参数（`{ phone, code }`）取花括号内的名字。
 *
 * 注解里的 `<string, number>` 会被顶层逗号切开，尾部片段只可能带出类型名——
 * 由 TYPE_WORDS 过滤；残留的类型名只会让「形参未被读取」更难成立（偏保守，不产生假红）。
 */
function paramNames(params: string): string[] {
  const out = new Set<string>()
  for (const raw of splitArgs(params)) {
    let arg = raw.trim()
    if (!arg) continue
    const eq = arg.indexOf('=')
    if (eq >= 0) arg = arg.slice(0, eq)
    const colon = arg.indexOf(':')
    if (colon >= 0) arg = arg.slice(0, colon)
    for (const id of arg.match(/[A-Za-z_$][\w$]*/g) ?? []) {
      if (TYPE_WORDS.has(id)) continue
      out.add(id)
    }
  }
  return [...out]
}

/**
 * 函数体首句是否「无条件返回通过」。
 *
 * 两种载体：
 *   - 块体：`{ return true }` / `{ return { ok: true } }`（取 return 后的表达式，只取第一句）
 *   - 箭头表达式体：`(x) => true` / `(x) => ({ ok: true })`（`bodyAfterParen` 返回的就是表达式）
 */
function returnsPassLiteral(body: string): boolean {
  const t = body.trim()
  if (t === '') return false
  let expr: string
  const m = /^return\b([\s\S]*)$/.exec(t)
  if (m) {
    const rest = m[1].trim()
    if (rest === '') return false
    const opener = rest[0]
    if (opener === '(' || opener === '{' || opener === '[') {
      const close = matchDelimiter(rest, 0)
      if (close < 0) return false
      expr = rest.slice(0, close + 1)
    } else {
      // 基本量：只取第一句（后面可能还有不可达语句）
      expr = rest.split(';')[0].split('\n')[0].trim()
    }
  } else {
    expr = t
  }
  expr = expr.replace(/\s+as\s+const$/, '').trim()
  // `=> ({ ok: true })`：箭头函数的表达式体常被多包一层圆括号
  if (expr.startsWith('(') && expr.endsWith(')')) expr = expr.slice(1, -1).trim()
  if (/^true\b/.test(expr)) return true
  if (expr.startsWith('{') && expr.endsWith('}')) return PASS_KEY.test(expr)
  return false
}

function readsAnyParam(body: string, names: string[]): boolean {
  return names.some((n) => new RegExp(`\\b${escapeRe(n)}\\b`).test(body))
}

/** 声明点：`function name(` / `const name = (` / `const name = x =>` */
const DECLS: Array<{ re: RegExp; singleParam?: boolean }> = [
  { re: /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g },
  { re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b[^(]*)?\(/g },
  { re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?([A-Za-z_$][\w$]*)\s*=>/g, singleParam: true },
]

export const aq16 = toGuard({
  id: 'aq16',
  title: '假闸门：校验函数不读入参、恒返回通过',
  invariants: ['INV-RES-04'],
  code: 'AQ016_VERIFY_ALWAYS_TRUE',
  blindSpots: [
    '只认函数声明与 `const x = (…) =>` 两种载体；对象方法、类方法、装饰器包装后的校验器不可见',
    '只认「首个有效语句就是 return 字面通过」；先做无关赋值、再读入参的写法不在射程（那需要数据流）',
    '零参函数一律不报：`checkHealth() { return true }` 是合法的探活，不是假闸门',
    '函数体读了任一形参即放过：`verify(x)` 只判 `x != null` 也会被当成真校验（判据不评价校验强度）',
    '跨文件的「调用方以为有校验」不可见：本规则只看函数自身读没读入参',
    '名字不以校验动词开头的空实现不报（`guard2()`、`precheck()` 会漏）',
  ],
  impact:
    '签名里收着入参、函数体却从不读它，直接返回 `true` / `{ ok: true }`：调用方以为每次都在被校验，实际每次都被放行。' +
    '这类假闸门不报错、类型正确、单测也过——它把「高危操作的二次验证」变成一句注释',
  provenance:
    '试点 D（2026-10）：高危打款路由的「短信二次验证」函数首行直接 `return { ok: true }`；更早一次是权限校验返回 `{ authorized: false }` 却由调用方忽略返回值。两处都表现为「闸门在代码里存在，在运行时不存在」',
  applies(rel) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|mts)$/.test(rel)) return false
    if (/(^|\/)node_modules\//.test(rel)) return false
    if (/(^|\/)(?:__tests__|tests?|specs?|stories|fixtures?|mocks?|testdata)(\/|$)/.test(rel)) return false
    if (TEST_FILENAME.test(rel)) return false
    if (/(selftest|fixture|testdata)/i.test(rel)) return false
    return true
  },
  analyze(src): RawHit[] {
    const code = maskRegexBodies(maskStringBodies(stripComments(src)))
    const hits: RawHit[] = []
    const seen = new Set<number>()

    for (const { re, singleParam } of DECLS) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(code)) !== null) {
        const name = m[1]
        if (!VERIFIER_NAME.test(name)) continue
        if (seen.has(m.index)) continue

        let params: string
        let body: string | null
        if (singleParam) {
          params = m[2]
          body = bodyAfterParen(code, m.index + m[0].length)
        } else {
          const open = m.index + m[0].length - 1
          const close = matchDelimiter(code, open)
          if (close < 0) continue
          params = parenBody(code, open) ?? ''
          body = bodyAfterParen(code, close + 1)
        }
        if (!body) continue

        const names = paramNames(params)
        if (names.length === 0) continue
        if (!returnsPassLiteral(body)) continue
        if (readsAnyParam(body, names)) continue

        seen.add(m.index)
        hits.push({
          line: lineOf(src, m.index),
          message:
            `\`${name}\` 收 ${names.length} 个入参（${names.join(', ')}）却在首个语句无条件返回「通过」：` +
            '调用方以为这是闸门，实际每次都被放行。请读入参并给出失败分支；确实没有校验可做时删掉该函数，' +
            '让调用方显式标注「无校验」——空函数比假函数诚实',
          evidence: evidenceOf(src, m.index),
        })
      }
    }
    return hits
  },
  fixtures: [
    {
      name: '短信二次验证首行直接通过（该报）',
      expect: 'red',
      rel: 'src/lib/high-risk-sms.ts',
      src:
        'export function verifyHighRiskSms(phone: string, code: string) {\n' +
        '  return { ok: true }\n' +
        '}\n',
    },
    {
      name: '权限校验恒返回 true（该报）',
      expect: 'red',
      rel: 'src/lib/permission.ts',
      src:
        'export function checkPermission(userId: string, action: string) {\n' +
        '  return true\n' +
        '}\n',
    },
    {
      name: '箭头函数返回通过对象（该报）',
      expect: 'red',
      rel: 'src/lib/deposit.ts',
      src: 'export const validateDeposit = (txnId: string) => ({ ok: true, verified: true })\n',
    },
    {
      name: '单参箭头恒真（该报）',
      expect: 'red',
      rel: 'src/lib/id.ts',
      src: 'export const checkId = (id) => true\n',
    },
    {
      name: '读入参的真校验（不该报）',
      expect: 'green',
      rel: 'src/lib/sms.ts',
      src:
        'export function verifyCode(input: string) {\n' +
        '  return input === expectedCode()\n' +
        '}\n',
    },
    {
      name: '先判后通过（不该报）：首个语句是 if',
      expect: 'green',
      rel: 'src/lib/permission.ts',
      src:
        'export function checkPermission(user: { active: boolean }) {\n' +
        '  if (!user.active) return { ok: false, reason: "inactive" }\n' +
        '  return { ok: true }\n' +
        '}\n',
    },
    {
      name: '零参探活（不该报）：这不是闸门',
      expect: 'green',
      rel: 'src/lib/health.ts',
      src: 'export function checkHealth() {\n  return true\n}\n',
    },
    {
      name: '非校验动词的空实现（不该报）：本条不评价普通函数',
      expect: 'green',
      rel: 'src/lib/loader.ts',
      src: 'export function loadThing(id: string) {\n  return true\n}\n',
    },
    {
      name: '名字只是动词前缀的普通函数（不该报）：checkout 不是 verify',
      expect: 'green',
      rel: 'src/lib/checkout.ts',
      src: 'export function checkout(cartId: string) {\n  return true\n}\n',
    },
    {
      name: '注释里的假实现（不该报）：去注释先于解析',
      expect: 'green',
      rel: 'src/lib/sms.ts',
      src:
        '// 旧写法：verifyHighRiskSms(phone, code) { return { ok: true } }\n' +
        'export const ok = true\n',
    },
  ],
})
