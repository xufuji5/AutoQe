/**
 * AQ019 · 中间件静态资源排除规则未转义点：整条路径绕过门禁。
 *
 * ## 缺陷形态
 *
 * 反向代理/中间件的 `matcher` 用正则排除静态资源时，扩展名分组前的那一个点必须写成 `\\.`。
 * 写成 `.` 时它是「任意字符」：任何以「某字符 + svg/png/jpg…」结尾的路径都会被当成静态资源排除，
 * 于是这些路径**连鉴权、限流、IP 白名单都不跑**。
 *
 * 这类写法在源码里几乎看不出来：`.*.(?:svg|png)$` 与 `.*\\.(?:svg|png)$` 只差一个反斜杠，
 * 而它的后果是「今天没有这样的路由所以安全，明天新增一个就可能裸奔」。
 *
 * ## 判据（可复算）
 *
 * 只看两件机器事实：
 *   1. 文件里存在 `matcher: [...]` 配置；
 *   2. 其中某个字符串条目里，**未转义的点**后面紧跟一个「扩展名分组」`(?:svg|png|…)`
 *      （或 `(svg|png|…)`）。扩展名词表由 `rules.aq19.staticExtensions` 追加。
 *
 * 「点是否转义」按**运行期语义**判断：字符串字面量里的源码反斜杠两两配成一个运行期反斜杠，
 * 只有运行期剩奇数个反斜杠时点才真正被转义。源码写 `\\.` 是正确写法；只写一个 `\.` 会在运行期
 * 退化成裸点（字符串把反斜杠吃掉），正是最常见的写错法，必须报。
 */
import { escapeRe, maskRegexBodies, maskStringBodies, matchDelimiter, stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit } from '../lib/rule-guard.ts'

/** 默认扩展名词表：只认「一看就是静态资源」的段，避免把 `(?:api|admin)` 这类路径分组误判；匹配时忽略大小写 */
const DEFAULT_EXTENSIONS = [
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp',
  'css', 'js', 'mjs', 'map', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'webm',
]

/** 取 `matcher: [` 的数组区间（结构面定位，原文取值） */
function matcherArrays(masked: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const re = /\bmatcher\s*:\s*\[/g
  let m: RegExpExecArray | null
  while ((m = re.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1
    const close = matchDelimiter(masked, open)
    if (close > open) out.push([open + 1, close])
  }
  return out
}

/**
 * 未转义的点 + 扩展名分组。
 *
 * 「是否转义」按**运行期语义**判，而不是「源码里前一个字符是反斜杠」：
 * 字符串字面量里的反斜杠两两配成一个运行期反斜杠，源码写 `\\.` 才是「转义点」；
 * 源码只写一个 `\.` 时，字符串值里那个反斜杠被吃掉，运行期退化成裸点 —— 这正是最常见的写错法。
 * 所以：连着 n 个源码反斜杠 → 运行期 floor(n/2) 个；奇数个才表示点被转义。
 */
function hasUnescapedExtDot(value: string, exts: string[]): boolean {
  const alt = exts.map(escapeRe).join('|')
  const re = new RegExp(`\\.\\(\\??:?(?:${alt})(?:\\|(?:${alt}))*\\)`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(value)) !== null) {
    let k = m.index - 1
    let slashes = 0
    while (k >= 0 && value[k] === '\\') {
      slashes += 1
      k -= 1
    }
    // 运行期剩余奇数个反斜杠 → 点被转义；偶数（含 0）→ 裸点
    if (Math.floor(slashes / 2) % 2 === 0) return true
  }
  return false
}

/**
 * 取数组区间里的字符串字面量及**绝对位置**（matcher 条目按定义是字符串；模板/变量不可复算，跳过）。
 * 位置必须随字面量一起返回：同一段 matcher 值在两个数组里重复出现时，按值回查 `indexOf`
 * 会把行号指到另一处，证据就落在了无关行上。
 */
function stringLiteralsAt(text: string, base: number): Array<{ value: string; index: number }> {
  const out: Array<{ value: string; index: number }> = []
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({ value: m[1] ?? m[2] ?? '', index: base + m.index })
  }
  return out
}

export const aq19 = toGuard({
  id: 'aq19',
  title: '中间件静态资源排除规则未转义点（路径绕过门禁）',
  invariants: ['INV-SEC-04'],
  code: 'AQ019_MATCHER_UNESCAPED_DOT',
  blindSpots: [
    '只认 `matcher: [...]` 这种数组配置：`matcher: "/path/:path*"` 单字符串形式、写在常量里再引用（`const M = [...]` / `matcher: M`）、由代码生成 matcher、或把排除规则交给反向代理配置的，不在射程',
    '只看字符串字面量：模板字符串拼接、环境变量注入、运行时构造的 matcher 不可复算，跳过',
    '扩展名词表是有限的（默认 svg/png/jpg…，可用 `rules.aq19.staticExtensions` 追加）：自定义静态资源后缀（例如专有字体/模型格式）不认',
    '只判「点是否转义」这一个字符事实，不判断这条 matcher 究竟覆盖了哪些真实路由；「新增路由后是否裸奔」仍由路由清单类判据回答',
    '正则字面量条目（`matcher: [/…/]`）不在射程：只认字符串条目。正则里单个 `\.` 本身就是正确写法，按字符串的反斜杠奇偶换算会把它误判成裸点，所以宁可跳过',
    '反斜杠奇偶只对字符串字面量成立：由常量、拼接、`new RegExp(…)` 或环境变量注入的 matcher 不可复算，跳过',
  ],
  impact:
    '排除静态资源的 matcher 把 `.` 当任意字符：以「任意字符 + 扩展名」结尾的路径整条跳过中间件，' +
    '鉴权/限流/IP 白名单一并失效。今天恰好没有这种路由，所以它不会被任何人发现；新增一个同形路由即上线裸奔',
  provenance:
    '试点 E（2026-10）：中间件 matcher 的静态资源分组写成 `.*.(?:svg|png|jpeg)$`，当时无同名路由故无实际影响；' +
    '审阅时发现「新增一个以 -png 结尾的后台路径即绕过全部门禁」，而以路径名对照校验的方式只能证明「今天的路由没问题」',
  applies(rel) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|mts)$/.test(rel)) return false
    if (/(^|\/)node_modules\//.test(rel)) return false
    if (/(^|\/)(?:__tests__|fixtures?|__mocks__|testdata)(\/|$)/.test(rel)) return false
    return /(^|\/)(?:middleware|proxy)\.[cm]?[jt]sx?$/.test(rel)
  },
  analyze(src, _rel, ctx): RawHit[] {
    const exts = ((ctx.options.staticExtensions as string[] | undefined) ?? []).filter(Boolean)
    const vocabulary = [...DEFAULT_EXTENSIONS, ...exts]
    // 注释剥离后保留字符串原文：matcher 条目的内容才是有意义的输入
    const code = stripComments(src)
    // 结构取样必须再抹掉正则体：matcher 里的正则字面量可以带未配对的 `]`，
    // 直接配对会把数组区间切在正则内部，后面的字符串条目整段漏扫（静默假绿）。
    const structural = maskRegexBodies(maskStringBodies(code))
    const hits: RawHit[] = []
    for (const [start, end] of matcherArrays(structural)) {
      const segment = code.slice(start, end)
      for (const { value, index } of stringLiteralsAt(segment, start)) {
        if (!hasUnescapedExtDot(value, vocabulary)) continue
        hits.push({
          line: lineOf(src, index),
          message:
            'matcher 里的静态资源排除规则使用了**未转义的点**（`.(?:svg|png…)`）：' +
            '`.` 是任意字符，任何以「某字符 + 扩展名」结尾的路径都会被当作静态资源跳过中间件，' +
            '鉴权/限流/IP 白名单全部失效。把点写成 `\\\\.`，或改为显式路径前缀',
          evidence: evidenceOf(src, index),
        })
      }
    }
    return hits
  },
  fixtures: [
    {
      name: '静态资源分组前用未转义的点（该报）：新增同名路由即绕门禁',
      expect: 'red',
      rel: 'middleware.ts',
      src:
        'export const config = {\n' +
        "  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],\n" +
        '}\n',
    },
    {
      name: '点已转义（不该报）：`\\\\.(?:svg|png)` 是正确写法',
      expect: 'green',
      rel: 'middleware.ts',
      src:
        'export const config = {\n' +
        "  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],\n" +
        '}\n',
    },
    {
      name: '未转义的点后是路径分组而非扩展名（不该报）：`(?:api|admin)` 是上游排除',
      expect: 'green',
      rel: 'src/middleware.ts',
      src:
        'export const config = {\n' +
        "  matcher: ['/((?!.*(?:api|admin)).*)'],\n" +
        '}\n',
    },
    {
      name: '扩展名分组写成大写（该报）：大小写不改变「裸点」的事实',
      expect: 'red',
      rel: 'middleware.ts',
      src:
        'export const config = {\n' +
        "  matcher: ['/((?!.*.(?:SVG|PNG)$).*)'],\n" +
        '}\n',
    },
    {
      name: '字符串里只写一个反斜杠（该报）：运行期退化成裸点',
      expect: 'red',
      rel: 'middleware.ts',
      src:
        'export const config = {\n' +
        "  matcher: ['/((?!.*\\.(?:svg|png)$).*)'],\n" +
        '}\n',
    },
    {
      name: '正则条目里的 `\\]` 不截断 matcher 数组（该报）：结构配对必须先抹正则体',
      expect: 'red',
      rel: 'src/middleware.ts',
      src:
        'export const config = {\n' +
        "  matcher: [/\\]/, '/((?!.*.(?:svg|png)$).*)'],\n" +
        '}\n',
    },
    {
      name: '普通脚本里的同名正则（不该报）：射程只到中间件文件',
      expect: 'green',
      files: {
        'scripts/check-assets.ts': "const re = /.*.(?:svg|png)$/\nexport const ok = re.test('a.png')\n",
        // 样本根必须留一个射程内文件，否则「0 个文件」会让样本以 NotApplicable 失败
        'middleware.ts': "export const config = {\n  matcher: ['/dashboard/:path*'],\n}\n",
      },
    },
  ],
})
