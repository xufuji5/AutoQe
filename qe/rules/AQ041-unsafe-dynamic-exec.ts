/**
 * AQ041 · 不安全执行入口：eval / new Function / setTimeout(string) / setInterval(string)
 *
 * ## 事故形态
 *
 * JavaScript 的动态执行入口接受字符串形式的代码，在生产环境打开任意一条都会让应用
 * 暴露给注入攻击链：
 *
 * ```ts
 * // 用户的 post.content 直接进了 eval
 * const formatted = eval(userPost.template)
 *
 * // setTimeout 字符串形式等于一次 eval
 * setTimeout('doSomething()', 1000)
 * ```
 *
 * 这些 API 的存在是为了解决极少数框架（jsonp、动态模块加载器）的边缘场景；
 * 业务代码直接用它们，意味着要么把动态性暴露给了攻击者，要么架构上已经走到了绝境——
 * 这两条都是 QA 必须拦下的信号。
 *
 * ## 判据
 *
 * 1. 文件不在 node_modules、测试/演示目录、fixture 目录；
 * 2. 源码（去注释后）出现以下任一模式：
 *    - `eval(` — 函数调用
 *    - `new Function(` — 动态构造函数
 *    - `setTimeout('string'` / `setTimeout("string"` — 字符串形式的计时器
 *    - `setInterval('string'` / `setInterval("string"`
 *
 * 框架特例（如 Vite 的 `new Function(source)` 用于插件内部）不在业务源码射程内，
 * 由 applies() 的路径过滤排除 node_modules。
 *
 * ## 修复形态
 *
 * - `eval(expr)` → 解析后直接执行：`const result = parser.parseAndRun(expr)`
 * - `new Function(src)` → 用数据驱动：`const handler = handlers[name]`
 * - `setTimeout(string)` → 用函数形式：`setTimeout(() => doSomething(), delay)`
 */
import { stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit } from '../lib/rule-guard.ts'

const NON_PROD = /(^|\/)(?:node_modules|__tests__|tests?|specs?|stories|fixtures?|mocks?|testdata)(\/|$)/
const TEST_FILENAME = /\.(?:test|spec|stories)\./

const PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\beval\s*\(/g, label: 'eval(...) — 直接执行字符串代码' },
  { re: /\bnew\s+Function\s*\(/g, label: 'new Function(...) — 动态构造函数' },
  { re: /\bsetTimeout\s*\(\s*['"`]/g, label: "setTimeout('string') — 字符串形式计时器" },
  { re: /\bsetInterval\s*\(\s*['"`]/g, label: "setInterval('string') — 字符串形式计时器" },
]

export const aq41 = toGuard({
  id: 'aq41',
  title: '不安全动态执行入口：eval / new Function / 字符串形式计时器',
  invariants: ['INV-SEC-10'],
  code: 'AQ041_UNSAFE_DYNAMIC_EXEC',
  blindSpots: [
    '正则字符串里的 eval 字面量会误报（极少；去注释已处理大部分）',
    '动态拼接调用 `(name[op])(arg)` 的反射调用不在射程——那是另一类风险（AQ 族未覆盖）',
    'Vite/Rspack 插件内部使用 new Function 不在射程（applies() 排除了 node_modules）',
    'Function 构造函数带显式参数的形式也报：它和 new Function 本质相同',
  ],
  impact:
    'eval/new Function/字符串形式 setTimeout 都会把应用暴露给代码注入链。' +
    '一旦攻击者能控制传入字符串的任何一环（URL 参数、POST body、第三方内容），' +
    '等于获得了完整的执行环境。这类 API 在业务代码中出现，说明要么是架构走到了绝境，' +
    '要么是开发者没有意识到字符串会被当作代码执行。',
  provenance:
    '多仓实测（Web 框架、后台服务、Next.js App Router 项目共 5+ 仓）+ SonarQube/ESLint 社区共识：' +
    'no-eval、no-new-func、no-implied-eval 三条规则在主流 linter 里均默认开启。' +
    '2025-2026 期间多起真实 CVE 直接源于 eval 用户输入。',
  applies(rel) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(rel)) return false
    if (NON_PROD.test(rel)) return false
    if (TEST_FILENAME.test(rel)) return false
    if (/(selftest|fixture|testdata)/i.test(rel)) return false
    return true
  },
  analyze(src): RawHit[] {
    const code = stripComments(src)
    const hits: RawHit[] = []

    for (const { re, label } of PATTERNS) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(code)) !== null) {
        hits.push({
          line: lineOf(src, m.index),
          message: `不安全动态执行入口：${label}。请用数据驱动的替代方案（handlers[name]）或函数形式计时器。`,
          evidence: evidenceOf(src, m.index),
        })
      }
    }
    return hits
  },
  fixtures: [
    {
      name: 'eval 用户内容（该报）',
      expect: 'red',
      rel: 'src/lib/template-render.ts',
      src:
        'export function render(userContent: string) {\n' +
        '  return eval(userContent)\n' +
        '}\n',
    },
    {
      name: 'new Function 动态构造（该报）',
      expect: 'red',
      rel: 'src/lib/handler.ts',
      src:
        'export function createHandler(src: string) {\n' +
        '  return new Function(src)\n' +
        '}\n',
    },
    {
      name: 'setTimeout 字符串形式（该报）',
      expect: 'red',
      rel: 'src/app/page.tsx',
      src:
        "export default function Page() {\n" +
        "  setTimeout('console.log(1)', 1000)\n" +
        "}\n",
    },
    {
      name: 'setInterval 字符串形式（该报）',
      expect: 'red',
      rel: 'src/lib/poll.ts',
      src: "setInterval('tick()', 5000)\n",
    },
    {
      name: 'setTimeout 函数形式（不该报）',
      expect: 'green',
      rel: 'src/app/page.tsx',
      src:
        "export default function Page() {\n" +
        "  setTimeout(() => doSomething(), 1000)\n" +
        "}\n",
    },
    {
      name: 'setInterval 函数形式（不该报）',
      expect: 'green',
      rel: 'src/lib/poll.ts',
      src: 'setInterval(tick, 5000)\n',
    },
    {
      name: 'eval 在注释里（不该报）',
      expect: 'green',
      rel: 'src/lib/template-render.ts',
      src: '// export function render(x) { return eval(x) }\nexport const ok = true\n',
    },
    {
      name: 'new Function 在示例里（不该报）',
      expect: 'green',
      rel: 'src/lib/example-legacy.ts',
      src: '// example: const fn = new Function("return 1")\nexport const ok = true\n',
    },
  ],
})
