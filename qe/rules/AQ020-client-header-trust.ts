/**
 * AQ020 · 安全决策使用客户端可控请求头（可伪造的输入当成了身份）。
 *
 * ## 缺陷形态
 *
 * 取「客户端 IP」的 helper 只读请求头，例如：
 *
 * ```ts
 * export function getClientIp(req: Request): string {
 *   const forwarded = req.headers.get('x-forwarded-for')
 *   return forwarded?.split(',')[0]?.trim() ?? 'unknown'
 * }
 * ```
 *
 * 这些头（`x-forwarded-for` / `x-real-ip` / `x-client-ip` / `cf-connecting-ip`…）
 * 在**没有可信代理剥离入站同名头**的部署里，就是调用方随手能改的字符串。
 * 一旦拿它做限流键、IP 白名单、审计归属或「同 IP 去重」，攻击者换一个头值就换了一个身份：
 *
 * - 限流按 IP 计数 → 每个请求换一个头值，限流等于不存在；
 * - IP 白名单 → 头值写成白名单地址即通过；
 * - 审计归属 → 记录里的来源 IP 可以任意指定。
 *
 * 它不报错、不告警，读数上所有请求都「来自不同的 IP」，看起来只是流量分散。
 *
 * ## 判据（可复算，不靠词表猜意图）
 *
 * 1. 找**名字带独立 `ip` 词元**的函数（`getClientIp` / `clientIp` / `remoteIp` / `ipOf`…）；
 * 2. 函数体里出现客户端可控头的读取（`.headers.get('x-…')` / `.headers['x-…']` / `.get('x-…')`）；
 * 3. 函数体内没有任何**不可伪造来源**的证据，则报。
 *
 * 不可伪造来源的证据（任一即放过）：
 * - 传输层/平台地址：`request.ip` / `req.ip` / `ctx.ip` / `…socket.remoteAddress` / `ipAddress(`；
 * - 可信代理声明：函数体内出现 `trustProxy` / `trustedProxy` / `trustedProxies` 词元，或模块级声明
 *   （`const/let/var <marker>`、`<marker>:` / `<marker>=`）。可用 `rules.aq20.trustedProxyMarkers` 追加封装名。
 *
 * ## 两个头互相印证不算证据
 *
 * 读 `x-real-ip` 与 `x-forwarded-for` 再比较，是这类 helper 里常见的「加固」写法，但它并不改变
 * 两个头都来自**同一个不可信信道**这个事实：调用方把两个值写成一样即可通过，比对只能暴露
 * 代理配置不一致，不能建立身份。把「两源一致」当放过条件，本身就是一种防线幻觉，故不采信。
 * 要么读平台注入的地址，要么要求可信代理覆盖入站头并留下声明。
 *
 * ## 为什么是 warn
 *
 * 「这个头在本仓的部署里是否已被网关剥离」是运行期/部署面的事实，源码看不出来。
 * 机器能证死的只有「安全语义的函数把可伪造头当成了来源」，不能证死「这个头在本环境不可伪造」。
 * 所以固定出候选：triage 时问一句「入站的同名头有没有被可信代理覆盖」。
 */
import { escapeRe, maskStringBodies, matchDelimiter, stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'

/** 客户端可控请求头：可由调用方任意填写（项目专用头用 rules.aq20.clientHeaders 追加） */
const DEFAULT_CLIENT_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'x-client-ip',
  'cf-connecting-ip',
  'true-client-ip',
  'fastly-client-ip',
  'x-vercel-forwarded-for',
  'forwarded',
]

/** 不可伪造来源：传输层地址或平台注入的地址 */
const PLATFORM_IP =
  /\b(?:req|request|event|ctx|context)\s*\.\s*ip\b|\bremoteAddress\b|\bipAddress\s*\(/

/** 可信代理声明：出现即认为「入站头已被覆盖」这一部署事实由项目担保 */
const DEFAULT_TRUST_MARKERS = ['trustProxy', 'trustedProxy', 'TRUST_PROXY', 'trustedProxies']

/** Express/Koa 系的声明式写法：`app.set('trust proxy', …)` / `app.enable('trust proxy')` */
const TRUST_PROXY_CALL = /\.\s*(?:set|enable)\s*\(\s*(['"])trust\s+proxy\1/

/**
 * 可信代理证据。
 *
 * 只认三种机器事实：
 *   1. 函数体内出现标记**词元**（`\b` 边界，`untrustedProxy` / `notTrustedProxy` 不算）；
 *   2. 模块级声明（`const/let/var <marker>`、`<marker>:` / `<marker>=`）；
 *   3. 框架的声明式调用（`set/enable('trust proxy')`）。
 *
 * 旧实现用 `code.includes(marker)` 整文件子串匹配：同文件里任何一处（哪怕别的函数、
 * 甚至 `assertTrustedProxy()` 这种名字）都会豁免所有 IP 函数，是一条假绿。
 */
function trustEvidence(markers: string[], body: string, code: string): boolean {
  if (TRUST_PROXY_CALL.test(code)) return true
  if (markers.length === 0) return false
  const alt = markers.map(escapeRe).join('|')
  if (new RegExp(`\\b(?:${alt})\\b`).test(body)) return true
  return new RegExp(`\\b(?:const|let|var)\\s+(?:${alt})\\b|\\b(?:${alt})\\b\\s*[:=]`).test(code)
}

const NON_PROD = /(^|\/)(?:__tests__|tests?|specs?|stories|fixtures?|mocks?|testdata)(\/|$)/
const TEST_FILENAME = /\.(?:test|spec)\./

/** 标识符拆词：camelCase / kebab / snake 都拆成小写词元 */
function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\-\s]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean)
}

/**
 * 名字是否表示「IP 语义」。
 *
 * 只认独立 `ip` 词元：`skip` / `ship` / `description` 里虽然含字面 `ip`，但词元不是 `ip`，
 * 不能因为子串命中就把整个文件当安全模块。
 */
function isIpLike(name: string): boolean {
  const tokens = nameTokens(name)
  return tokens.includes('ip') || tokens.includes('ipaddr') || tokens.includes('ipaddress')
}

/** 函数声明 / 函数表达式 / 箭头函数的函数体区间（只看有花括号体的，或箭头后的单行表达式体） */
function functionSpans(masked: string): Array<{ name: string; open: number; close: number }> {
  const out: Array<{ name: string; open: number; close: number }> = []
  const seen = new Set<number>()
  const push = (name: string, start: number, end: number): void => {
    if (end <= start || seen.has(start)) return
    seen.add(start)
    out.push({ name, open: start, close: end })
  }
  /**
   * 找函数体花括号。
   *
   * 返回类型里可能有对象字面量（`function f(req): { ip: string } { … }`），此时首个 `{`
   * 属于类型而不是函数体。若它闭合后的下一个非空白字符仍是 `{`，后者才是函数体；
   * 否则把类型体当函数体会让整段业务代码失扫（静默假绿）。
   */
  const bracedFrom = (afterParen: number): [number, number] | null => {
    let brace = masked.indexOf('{', afterParen + 1)
    if (brace < 0) return null
    let close = matchDelimiter(masked, brace)
    if (close < 0) return null
    let k = close + 1
    while (k < masked.length && /\s/.test(masked[k])) k++
    if (masked[k] === '{') {
      brace = k
      close = matchDelimiter(masked, brace)
      if (close < 0) return null
    }
    return [brace + 1, close]
  }

  // function name(…)
  const FN = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g
  // const name = [async] function (…)
  const FN_EXPR = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s+)?function\b[^(]*\(/g
  // const name = [async] (…) =>
  const ARROW = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s+)?\(/g

  for (const re of [FN, FN_EXPR]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(masked)) !== null) {
      const parenClose = matchDelimiter(masked, m.index + m[0].length - 1)
      if (parenClose < 0) continue
      const span = bracedFrom(parenClose)
      if (span) push(m[1], span[0], span[1])
    }
  }

  ARROW.lastIndex = 0
  let am: RegExpExecArray | null
  while ((am = ARROW.exec(masked)) !== null) {
    const parenClose = matchDelimiter(masked, am.index + am[0].length - 1)
    if (parenClose < 0) continue
    let i = parenClose + 1
    while (i < masked.length && /\s/.test(masked[i])) i++
    if (masked[i] === ':') {
      const arrow = masked.indexOf('=>', i)
      if (arrow < 0) continue
      i = arrow
    }
    if (!masked.startsWith('=>', i)) continue
    i += 2
    while (i < masked.length && /\s/.test(masked[i])) i++
    if (masked[i] === '{') {
      const close = matchDelimiter(masked, i)
      if (close >= 0) push(am[1], i + 1, close)
      continue
    }
    const nl = masked.indexOf('\n', i)
    push(am[1], i, nl < 0 ? masked.length : nl)
  }
  return out
}

/**
 * 客户端头读取：`.headers.get('x-…')` / `.headers['x-…']` / `.get('x-…')`。
 *
 * 名称要从**未掩码**的代码面取（`maskStringBodies` 会把头名抹成空白），
 * 位置则用掩码面校验「这一处确实是调用结构而不是字符串里的描述文字」——
 * 两者逐字符等长，偏移可直接互用。
 */
function headerReads(
  code: string,
  masked: string,
  headers: string[],
): Array<{ index: number; name: string }> {
  const out: Array<{ index: number; name: string }> = []
  const wanted = new Set(headers.map((h) => h.toLowerCase()))
  const accepted: Array<[number, number]> = []
  const res: RegExp[] = [
    /\.headers\s*\.\s*get\s*\(\s*(['"`])([^'"`]+)\1\s*\)/gi,
    /\.headers\s*\[\s*(['"`])([^'"`]+)\1\s*\]/gi,
    /\.get\s*\(\s*(['"`])([^'"`]+)\1\s*\)/gi,
  ]
  for (const re of res) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(code)) !== null) {
      // 掩码面对应位置不是点 → 这段文字在字符串/注释里，不是调用
      if (masked[m.index] !== '.') continue
      // 后两条模式会命中前一条的子串（`.headers.get` 里也含 `.get`）：落在已接受区间内的不再计
      if (accepted.some(([a, b]) => m !== null && m.index >= a && m.index < b)) continue
      const name = m[2].trim().toLowerCase()
      if (!wanted.has(name)) continue
      accepted.push([m.index, m.index + m[0].length])
      out.push({ index: m.index, name })
    }
  }
  return out
}

export const aq20 = toGuard({
  id: 'aq20',
  title: '安全决策使用客户端可控请求头（可伪造输入当身份）',
  invariants: ['INV-SEC-05'],
  code: 'AQ020_CLIENT_HEADER_TRUST',
  level: 'warn',
  blindSpots: [
    '射程只到「函数名里含独立 `ip` 词元」的函数：`rateLimitKey` / `getIdentity` / `getActor` 这类同样用头做安全决策的命名不认（需要项目侧追加词表时，应另开规则而不是放宽本条的命名判据）',
    '只认函数声明与 `const x = (…) =>` 两种载体；类方法、对象方法、导出默认匿名函数、以及把取值抽到另一函数再调用的形态不可见',
    '「不可伪造来源」只认 `request.ip` / `req.ip` / `ctx.ip` / `remoteAddress` / `ipAddress(` 与可信代理标记：项目自定义的 `resolveTrustedIp()` 需用 `rules.aq20.trustedProxyMarkers` 声明，否则仍报',
    '可信代理证据只认函数体内出现标记词元，或模块级声明（`const/let/var <marker>`、`<marker>:`/`<marker>=`）：别的函数里出现同名标识符、或在注释/字符串里出现的文字都不豁免',
    '两个客户端头互相印证（读两个头再比较）不是放过条件：两个值都可被调用方自行写成一样，它只暴露代理配置不一致，不建立身份',
    '平台地址与客户端头混用（例如「平台地址 ?? 头」这类回落链）仍按「有不可伪造来源」放过：本条不判断头值是否只在平台地址为空时才生效，这种写法在平台地址可能缺失的运行时里同样让头单独成为身份，需 triage 单独确认',
    '只做词法与跨度取样：`headers.get` 的接收者不校验，`URLSearchParams.get("forwarded")` 这类同名查询参数也会被计成头读取（候选，由 triage 排除）',
    '「部署侧是否已剥离入站同名头」是运行期/网关事实，源码不可复算：命中一律是候选，triage 时回答该头在本环境可否伪造',
    '不判断头值是否真的被用于限流/白名单/审计（那是数据流）：本文件里出现安全语义函数 + 头读取即出候选',
  ],
  impact:
    '安全语义函数把客户端可控请求头当成来源 IP：调用方改一个头值就换了身份——' +
    '限流按 IP 计数等于不存在，IP 白名单可被直接通过，审计里的来源 IP 可以任意指定；' +
    '这一切不报错、不告警，只在读数上表现为「请求来自很多不同 IP」',
  provenance:
    '试点 E（2026-10）：限流与后台 IP 白名单共用同一个 `getClientIp`，只解析 `x-forwarded-for` 的第一段；' +
    '审阅时确认入站同名头没有被代理覆盖，于是任意头值即可换身份。该 helper 自身有单测且全绿——错的不是函数，是「头属于谁」这个前提',
  applies(rel) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|mts)$/.test(rel)) return false
    if (/(^|\/)node_modules\//.test(rel)) return false
    if (NON_PROD.test(rel) || TEST_FILENAME.test(rel)) return false
    return !/(selftest|fixture|testdata)/i.test(rel)
  },
  analyze(src, _rel, ctx: RuleCtx): RawHit[] {
    const code = stripComments(src)
    const masked = maskStringBodies(code)
    const extraHeaders = ((ctx.options.clientHeaders as string[] | undefined) ?? []).filter(Boolean)
    const headers = [...DEFAULT_CLIENT_HEADERS, ...extraHeaders]
    const markers = [
      ...DEFAULT_TRUST_MARKERS,
      ...(((ctx.options.trustedProxyMarkers as string[] | undefined) ?? []).filter(Boolean)),
    ]

    const reads = headerReads(code, masked, headers)
    if (reads.length === 0) return []

    const hits: RawHit[] = []
    for (const span of functionSpans(masked)) {
      if (!isIpLike(span.name)) continue
      const body = masked.slice(span.open, span.close)
      const inBody = reads.filter((r) => r.index > span.open && r.index < span.close)
      if (inBody.length === 0) continue
      // 不可伪造来源：传输层地址 / 平台注入的地址 / 项目声明的可信代理
      if (PLATFORM_IP.test(body) || trustEvidence(markers, body, code)) continue

      for (const r of inBody) {
        hits.push({
          line: lineOf(src, r.index),
          message:
            `安全语义函数 \`${span.name}\` 从客户端可控头 \`${r.name}\` 取来源地址，` +
            '且函数体内既没有传输层地址、也没有可信代理声明：' +
            '调用方改一个头值就换了身份（限流/白名单/审计归属全部失效）。' +
            '改为读平台注入的地址，或要求可信代理覆盖入站头并登记 trustProxy',
          evidence: evidenceOf(src, r.index),
        })
      }
    }
    return hits
  },
  fixtures: [
    {
      name: '只解析 x-forwarded-for 当客户端 IP（该报）：改头值即换身份',
      expect: 'warn',
      rel: 'src/lib/request-ip.ts',
      src:
        'export function getClientIp(req: Request): string {\n' +
        "  const forwarded = req.headers.get('x-forwarded-for')\n" +
        "  return forwarded?.split(',')[0]?.trim() ?? 'unknown'\n" +
        '}\n',
    },
    {
      name: '优先读 x-real-ip（该报）：同名头由调用方自带',
      expect: 'warn',
      rel: 'src/lib/client-ip.ts',
      src:
        'export function clientIp(request: Request): string {\n' +
        "  return request.headers.get('x-real-ip') ?? 'unknown'\n" +
        '}\n',
    },
    {
      name: '两个头互相印证（该报）：两个头都可被调用方改写，比对不建立身份',
      expect: 'warn',
      rel: 'src/lib/request-ip.ts',
      src:
        'export function getClientIp(req: Request): string {\n' +
        "  const real = req.headers.get('x-real-ip')\n" +
        "  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()\n" +
        '  if (real && forwarded && real !== forwarded) return \'unknown\'\n' +
        "  return real ?? forwarded ?? 'unknown'\n" +
        '}\n',
    },
    {
      name: '函数内声明可信代理（不该报）：入站头已由代理覆盖这一事实有人担保',
      expect: 'green',
      rel: 'src/lib/request-ip.ts',
      src:
        'export function getClientIp(req: Request, trustedProxies: string[]): string {\n' +
        '  if (trustedProxies.length === 0) return \'unknown\'\n' +
        "  return req.headers.get('x-forwarded-for')?.split(',')[0] ?? 'unknown'\n" +
        '}\n',
    },
    {
      name: '同文件另一函数提到 trustProxy（该报）：作用域外的声明不豁免本函数',
      expect: 'warn',
      rel: 'src/lib/request-ip.ts',
      src:
        'function trustProxyEnabled(req: Request): boolean {\n' +
        "  return req.headers.get('x-forwarded-for') === '1'\n" +
        '}\n' +
        'export function getClientIp(req: Request): string {\n' +
        "  return req.headers.get('x-forwarded-for') ?? 'unknown'\n" +
        '}\n',
    },
    {
      name: '返回类型里带对象字面量（该报）：首个花括号是类型，不是函数体',
      expect: 'warn',
      rel: 'src/lib/request-ip.ts',
      src:
        'export function getClientIp(req: Request): { ip: string } {\n' +
        "  return { ip: req.headers.get('x-real-ip') ?? 'unknown' }\n" +
        '}\n',
    },
    {
      name: 'Express 的 trust proxy 声明（不该报）：入站头已由代理覆盖',
      expect: 'green',
      rel: 'src/lib/request-ip.ts',
      src:
        "app.set('trust proxy', 1)\n" +
        'export function getClientIp(req: Request): string {\n' +
        "  return req.headers.get('x-forwarded-for') ?? 'unknown'\n" +
        '}\n',
    },
    {
      name: '只用平台注入的 request.ip（不该报）：不可伪造来源',
      expect: 'green',
      rel: 'src/lib/request-ip.ts',
      src:
        'type EdgeRequest = Request & { ip?: string }\n' +
        'export function getClientIp(request: EdgeRequest): string {\n' +
        "  return request.ip ?? 'unknown'\n" +
        '}\n',
    },
    {
      name: '非 IP 语义的函数读头（不该报）：射程只到 IP 词元',
      expect: 'green',
      rel: 'src/lib/headers.ts',
      src:
        'export function getForwardedHost(req: Request): string {\n' +
        "  return req.headers.get('x-forwarded-for') ?? 'unknown'\n" +
        '}\n',
    },
  ],
})
