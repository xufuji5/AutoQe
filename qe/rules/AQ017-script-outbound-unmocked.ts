/**
 * AQ017 · 自测脚本「真出网」：冒烟脚本没有强制 mock 环境，直接打真实外部接口。
 *
 * ## 事故形态
 *
 * 一个仓的冒烟/红队脚本本来应该只验内部逻辑，但它们**没有把支付/短信网关换成桩**，
 * 于是每次 CI 或本地跑一遍就真的打一次外部接口：
 *
 * - 出账脚本打真实出账网关（返回 400 无效凭证），崩溃发生在真正的对账断言之前，
 *   后面 8 条静态对账一条都没跑，而脚本的 `finally` 照样打印「清理完成」；
 * - 支付脚本打真实订阅消息接口，跑一次就发一条真实消息；
 * - 「用 mock」写在文档里、写在注释里，唯独没有写进 import。
 *
 * 这类脚本的危险不在于报错，而在于**真金/真消息的副作用**，以及「崩溃即跳过后续判据」
 * 造成的假绿——脚本红了，人会去修脚本；脚本绿了，没人知道它到底验了什么。
 *
 * ## 判据（两件事同时成立才报）
 *
 * 1. 文件是**自测脚本**：位于 `scripts/`（或 `tools/`、`ci/`）目录，且文件名以
 *    `smoke` / `test` / `e2e` / `verify` / `check` / `redteam` / `selftest` / `probe` 开头；
 * 2. 文件里存在**真实出网**形态，且没有引入强制 mock 环境的模块：
 *    - `fetch(...)` / `axios...(...)` / `https.request(...)` 的地址是绝对 `http(s)` 且主机不是
 *      本机（`localhost` / `127.0.0.1` / `[::1]` / `0.0.0.0`），或地址是变量/模板而无法证明是本机；
 *    - 引入了支付类 SDK（`wechatpay` / `wxpay` / `tenpay` / `alipay` / `stripe` / `paypal`，
 *      或用 `rules.aq17.outboundImports` 追加）。
 *
 * 「强制 mock」的判定只看 import 说明符包含 `force-mock-env`（可用
 * `rules.aq17.mockEnvImport` 改成项目自己的模块名）。文档里写「已 mock」不算——
 * 判据要的是可执行的那一行。
 *
 * ## 为什么相对地址与本机地址放过
 *
 * 冒烟脚本打自己的 dev server（`http://127.0.0.1:3000/api/x` 或 `/api/x`）是**正确**用法：
 * 它验的是本仓的接口，不会产生外部副作用。把这类一起报红，规则会在第一个项目上被关掉。
 *
 * ## 修复形态
 *
 * 在脚本**第一行**（早于任何业务 import 的副作用）引入强制 mock 环境模块，
 * 由它把所有网关地址/密钥切到桩；或把地址改成显式参数并默认本机。
 */
import { argSpanAt, escapeRe, matchDelimiter, maskStringBodies, stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'

/** 自测脚本的文件名前缀：先收窄射程，避免把部署/迁移脚本一起算进来 */
const SELF_TEST_NAME = /^(?:smoke|test|e2e|verify|check|redteam|selftest|probe)[-_]?/i

/** 出网调用家族 */
const CALLS: RegExp[] = [
  /\bfetch\s*\(/g,
  /\baxios(?:\.[A-Za-z]+)?\s*\(/g,
  /\b(?:https?|undici)\.(?:request|get)\s*\(/g,
]

/** 内置支付类 SDK（包名形态可复算）；项目可追加 */
const PAYMENT_PKG = /^(?:wechatpay|wechat-pay|wxpay|tenpay|alipay|stripe|paypal)(?:[-/]|$)/i

/** 本机主机名：这些地址的外部副作用为零 */
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(?::\d+)?$/i

/** 相对地址（`/api/x`）打的是自身服务 */
const RELATIVE = /^\//

/** 地址字面量里的本机主机（含 `||` 默认值：`process.env.X || 'http://localhost:3001'`） */
const LOCAL_LITERAL = /(?:^|[^\w.-])(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?/i
const EXTERNAL_LITERAL = /https?:\/\/([^/'"`\s]+)/i

/** 保留/不可路由域名：请求必然失败在解析阶段，不产生外部副作用 */
const NON_ROUTABLE = /(?:^|\.)(?:example\.(?:com|net|org)|invalid|test)$/i

function isLocalHost(host: string): boolean {
  return LOCAL_HOST.test(host.trim())
}

/** 打这个主机不会产生真实外部副作用（本机或保留域名） */
function noSideEffect(host: string): boolean {
  const h = host.trim()
  return isLocalHost(h) || NON_ROUTABLE.test(h)
}

/**
 * 同文件一跳解析：`const BASE = …` / `let BASE = …`。
 *
 * 冒烟脚本普遍写成 `const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3001'`，
 * 直接把「地址是变量」判成外部会在每个真实仓里刷出几十条误报。
 * 只做一跳：找不到声明就返回 null（看不清 → unknown）。
 */
function declaredInit(code: string, name: string): string | null {
  const re = new RegExp(`\\b(?:const|let|var)\\s+${escapeRe(name)}\\s*(?::[^=\\n]+)?=\\s*([^\\n;]*)`)
  const m = re.exec(code)
  return m ? m[1] : null
}

/** 表达式里是否出现本机/外部字面量；两者都没有 = 看不清 */
function literalClass(expr: string): 'local' | 'external' | 'unknown' {
  if (LOCAL_LITERAL.test(expr)) return 'local'
  const ext = EXTERNAL_LITERAL.exec(expr)
  if (ext) return noSideEffect(ext[1]) ? 'local' : 'external'
  return 'unknown'
}

/** 从实参里的标识符追声明，判断它最终指向哪里（最多三跳，防环） */
function traceClass(code: string, arg: string, depth = 0): 'local' | 'external' | 'unknown' {
  let out: 'local' | 'external' | 'unknown' = 'unknown'
  for (const name of arg.match(/[A-Za-z_$][\w$]*/g) ?? []) {
    const init = declaredInit(code, name)
    if (init === null) continue
    const cls = literalClass(init)
    if (cls === 'local') return 'local'
    if (cls === 'external') out = 'external'
    else if (depth < 3) {
      const sub = traceClass(code, init, depth + 1)
      if (sub === 'local') return 'local'
      if (sub === 'external') out = 'external'
    }
  }
  return out
}

/** 从调用实参判断地址归属：local = 可证本机/相对/保留域名；external = 可证外网；unknown = 看不清 */
function addressClass(arg: string, code: string): 'local' | 'external' | 'unknown' {
  const t = arg.trim()
  const lit = /^(['"])([\s\S]*?)\1$/.exec(t)
  if (lit) {
    const url = lit[2]
    if (RELATIVE.test(url)) return 'local'
    const host = /^https?:\/\/([^/?#]+)/i.exec(url)
    if (!host) return 'unknown'
    return noSideEffect(host[1]) ? 'local' : 'external'
  }
  const tpl = /^`([\s\S]*?)`$/.exec(t)
  if (tpl) {
    const host = /^https?:\/\/([^/`]*)/i.exec(tpl[1])
    if (host) {
      const h = host[1]
      if (noSideEffect(h)) return 'local'
      // 主机里含 `${bucket}.cos.${region}.vendor.com` 这类片段：去掉变量后仍能看出公网域名后缀
      const literalPart = h.replace(/\$\{[^}]*\}/g, '').trim()
      if (/\.[a-z]{2,}(?::\d+)?$/i.test(literalPart)) return 'external'
    }
    return traceClass(code, tpl[1])
  }
  return traceClass(code, t)
}

/** 取 import / require / 动态 import 的说明符（注释里的伪 import 不算；同一行的 import/from 只算一次） */
function specsOf(code: string): Array<{ spec: string; index: number }> {
  const out: Array<{ spec: string; index: number }> = []
  const seen = new Set<string>()
  const res: RegExp[] = [
    /\bimport\s*(['"])([^'"]+)\1/g,
    /\bfrom\s*(['"])([^'"]+)\1/g,
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  ]
  for (const re of res) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(code)) !== null) {
      // `import x from 'y'` 会被前两条正则各命中一次：同一行同一说明符只保留第一处
      const key = `${lineOf(code, m.index)}:${m[2]}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ spec: m[2], index: m.index })
    }
  }
  return out
}

/**
 * 同文件 fetch 垫片：`globalThis.fetch = (async (input, init) => { … })`。
 *
 * 冒烟脚本常把真实出网关在垫片里（例如只拦自己的 COS 桶），随后用 `globalThis.fetch`
 * 打这个桶——那是零真实网络的本地桩，不是「真出网」。旧判据只认 force-mock-env import，
 * 把这类垫片调用一起报红（真实仓实测 2 条 error 全是垫片）。
 *
 * 豁免必须能证明「这个主机会被垫片截住」，所以只认垫片函数体里按 URL 前缀/全等分流的变量：
 *   `u.startsWith(`${GATE_ORIGIN}/`)` / `u === `${GATE_ORIGIN}``
 * 并且只豁免**地址以该变量开头**的调用；同一文件里打其它真实主机的 fetch 仍报红。
 */
const SHIM_ASSIGN = /(?:globalThis|global|window)\s*\.\s*fetch\s*=/g
const SHIM_GUARDS = [
  /startsWith\s*\(\s*`[^`]*?\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g,
  /===\s*`[^`]*?\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g,
]

function shimGuardedHosts(code: string, masked: string): Set<string> {
  const out = new Set<string>()
  SHIM_ASSIGN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SHIM_ASSIGN.exec(masked)) !== null) {
    const arrow = masked.indexOf('=>', m.index)
    if (arrow < 0) continue
    const brace = masked.indexOf('{', arrow)
    if (brace < 0) continue
    const end = matchDelimiter(masked, brace)
    if (end < 0) continue
    const body = code.slice(brace, end + 1)
    for (const re of SHIM_GUARDS) {
      re.lastIndex = 0
      let g: RegExpExecArray | null
      while ((g = re.exec(body)) !== null) out.add(g[1])
    }
  }
  return out
}

/** 被调地址是否以垫片分流的主机开头（直接模板，或同文件一跳 `const url = `${HOST}/…``） */
function shimHostOf(arg: string, code: string, hosts: Set<string>): boolean {
  if (hosts.size === 0) return false
  const t = arg.trim()
  const direct = /^`\s*\$\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(t)
  if (direct && hosts.has(direct[1])) return true
  if (/^[A-Za-z_$][\w$]*$/.test(t)) {
    const init = declaredInit(code, t)
    const hop = init ? /^\s*`\s*\$\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(init) : null
    if (hop && hosts.has(hop[1])) return true
  }
  return false
}

/**
 * 显式真连通开关：`const live = process.env.COS_LIVE === '1' && …`。
 *
 * 真连通若**默认关闭、且只在 `if (live)` 分支里调用**，脚本正常跑一遍并不出网——
 * 这是显式 opt-in，不是「跑一次就打一次真实接口」。旧判据把函数体里的 fetch 一起报红。
 *
 * 豁免射程只到「`if (live)` 的块」与「块内被调用函数体」：
 * 定义了 live 变量但无条件调用 runLive() 时，射程为空，仍按真出网报（反证见 fixtures）。
 */
const LIVE_GATE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\.[A-Za-z0-9_]*(?:_LIVE|_REAL)\s*===\s*(['"])1\2/g
const CALLED = /\b([A-Za-z_$][\w$]*)\s*\(/g

/** 同文件函数体区间：`function name(` / `const name = (…) => {` */
function functionBodySpan(masked: string, name: string): [number, number] | null {
  const decl = new RegExp(
    `(?:\\bfunction\\s+${escapeRe(name)}\\s*\\()|(?:\\b(?:const|let|var)\\s+${escapeRe(name)}\\s*=\\s*(?:async\\s*)?(?:function\\s*\\(|(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>))`,
    'g',
  )
  const m = decl.exec(masked)
  if (!m) return null
  const brace = masked.indexOf('{', m.index + m[0].length)
  if (brace < 0) return null
  const end = matchDelimiter(masked, brace)
  return end < 0 ? null : [brace, end]
}

function liveOptInScopes(code: string, masked: string): Array<[number, number]> {
  const gates = new Set<string>()
  LIVE_GATE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LIVE_GATE.exec(code)) !== null) gates.add(m[1])
  const spans: Array<[number, number]> = []
  for (const gate of gates) {
    const ifRe = new RegExp(`\\bif\\s*\\(\\s*${escapeRe(gate)}\\s*\\)\\s*\\{`, 'g')
    let im: RegExpExecArray | null
    while ((im = ifRe.exec(masked)) !== null) {
      const open = im.index + im[0].lastIndexOf('{')
      const end = matchDelimiter(masked, open)
      if (end < 0) continue
      spans.push([open, end])
      const block = masked.slice(open + 1, end)
      CALLED.lastIndex = 0
      let cm: RegExpExecArray | null
      while ((cm = CALLED.exec(block)) !== null) {
        const fn = functionBodySpan(masked, cm[1])
        if (fn) spans.push(fn)
      }
    }
  }
  return spans
}

function insideSpans(spans: Array<[number, number]>, index: number): boolean {
  return spans.some(([a, b]) => index >= a && index <= b)
}

export const aq17 = toGuard({
  id: 'aq17',
  title: '自测脚本真出网（未强制 mock 环境）',
  invariants: ['INV-RES-03'],
  code: 'AQ017_SCRIPT_OUTBOUND_UNMOCKED',
  blindSpots: [
    '射程 = `source.roots` ∪ `scriptsDirs` 下、文件名以自测动词开头的文件；其它位置的脚本不扫',
    '「强制 mock」只认 import 说明符包含 `force-mock-env`（或配置的模块名）：脚本自行修改 `process.env`、由 npm script 预置环境变量、或经 wrapper 间接生效的 mock 不可见',
    '出网调用只认 `fetch` / `axios` / `https.request` 与支付类 SDK 的顶层 import：项目自封装的 `payClient.transfer()`、经服务模块间接出网不可见',
    '地址是变量时只做**同文件一跳**声明解析（`const BASE = process.env.X || "http://127.0.0.1:3001"` 判本机）；跨文件、环境注入、函数返回的地址按 unknown 报',
    '地址是变量/函数返回值且一跳内看不到任何主机字面量时按 unknown 报（宁可多报一条，也不把真出网当本机）；`http://` 字面量主机解析只做字符串判断',
    '本地 dev server 与相对地址一律放过：那是正确用法，不是外部副作用',
    '同文件 fetch 垫片只认 `globalThis/global/window.fetch = (…) => { … }` 且函数体内按 `startsWith(`${VAR}…`)` / `=== `${VAR}`` 分流：垫片用正则/URL 解析器分流、或分流变量在别处拼接时看不见，仍按真出网报',
    '垫片豁免只覆盖地址**以该分流变量开头**的调用；同一文件打其它真实主机的 fetch 仍报（见反证样本）',
    '显式 live opt-in 只认 `const live = process.env.X_LIVE === "1"`（或 `_REAL`）且调用位于 `if (live) { … }` 块或其块内直接调用的同文件函数体：`if (process.env.X_LIVE === "1")` 直接判、经 wrapper 间接调用、`&&` 链里调用不可见，仍按真出网报',
    '不做运行期验证：本规则证明「代码里没有强制 mock 的入口」，不证明跑起来一定不出网',
  ],
  impact:
    '冒烟/红队脚本没有强制 mock 环境就打真实外部接口：跑一次就产生真实出账/真实消息/真实短信；' +
    '崩溃往往发生在后面的对账断言之前，脚本自己打印「清理完成」，把「没验到」伪装成「验过了」',
  provenance:
    '试点 D（2026-10）：三条冒烟脚本缺 force-mock-env，真实调用出账与订阅消息网关；其中一条崩溃发生在脏账 E2E 之前，后面 8 面静态对账一条没跑，finally 仍打印清理完成',
  applies(rel) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|mts)$/.test(rel)) return false
    if (/(^|\/)node_modules\//.test(rel)) return false
    if (/(^|\/)(?:__tests__|fixtures?|__mocks__|testdata)(\/|$)/.test(rel)) return false
    if (!/(^|\/)(?:scripts|tools|ci)\//.test(rel)) return false
    const base = (rel.split('/').pop() ?? '').replace(/\.\w+$/, '')
    return SELF_TEST_NAME.test(base)
  },
  /** 自测脚本按定义不在源码树里：射程补上 `scriptsDirs`（默认 `scripts`），其它规则不受影响 */
  extraRoots(ctx) {
    const dirs = ctx.config.scriptsDirs ?? ['scripts']
    return dirs.filter((d) => typeof d === 'string' && d !== '' && !d.includes('..'))
  },
  analyze(src, _rel, ctx: RuleCtx): RawHit[] {
    const code = stripComments(src)
    const masked = maskStringBodies(code)
    const specs = specsOf(code)

    const mockImports = (ctx.options.mockEnvImport as string[] | undefined) ?? ['force-mock-env']
    if (specs.some((s) => mockImports.some((p) => p !== '' && s.spec.includes(p)))) return []

    const extraPkgs = ((ctx.options.outboundImports as string[] | undefined) ?? []).filter(Boolean)
    const isOutboundPkg = (spec: string): boolean =>
      PAYMENT_PKG.test(spec.replace(/^[./]+/, '')) || extraPkgs.some((p) => spec.includes(p))

    const hits: RawHit[] = []
    const seen = new Set<number>()
    // 同文件可证的「不出网」形态：fetch 垫片分流的主机、显式 live opt-in 分支
    const shimHosts = shimGuardedHosts(code, masked)
    const liveScopes = liveOptInScopes(code, masked)

    for (const s of specs) {
      if (!isOutboundPkg(s.spec) || seen.has(s.index)) continue
      seen.add(s.index)
      hits.push({
        line: lineOf(src, s.index),
        message:
          `自测脚本引入了支付/外部服务 SDK \`${s.spec}\`，却没有引入强制 mock 环境模块：` +
          '每跑一次就可能产生真实出账或真实消息。请在脚本最早处引入 mock 环境模块（或把它加进 rules.aq17.mockEnvImport）',
        evidence: evidenceOf(src, s.index),
      })
    }

    for (const re of CALLS) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(masked)) !== null) {
        const open = m.index + m[0].length - 1
        const close = matchDelimiter(masked, open)
        if (close < 0) continue
        // 实参取**原文**（要读字符串字面量的内容），结构位置取掩码面（字符串里的逗号不切分）
        const arg = argSpanAt(masked, open, 0)
        if (arg === null) continue
        const argText = code.slice(open + 1, open + 1 + arg.length)
        // 垫片截住的主机：地址以垫片分流变量开头 → 零真实网络
        if (shimHostOf(argText, code, shimHosts)) continue
        // 显式 opt-in：调用位于 `if (live)` 块或其调用函数体内 → 默认不跑
        if (insideSpans(liveScopes, m.index)) continue
        const cls = addressClass(argText, code)
        if (cls === 'local') continue
        if (seen.has(m.index)) continue
        seen.add(m.index)
        hits.push({
          line: lineOf(src, m.index),
          message:
            (cls === 'external'
              ? '自测脚本直接调用外部 http(s) 地址'
              : '自测脚本的出网地址无法证明是本机（变量/模板），按外部调用处理') +
            '，且没有引入强制 mock 环境模块：跑一次就可能产生真实副作用。' +
            '改为本机地址，或在脚本最早处引入 mock 环境模块',
          evidence: evidenceOf(src, m.index),
        })
      }
    }
    return hits
  },
  fixtures: [
    {
      name: '冒烟脚本直连真实支付网关（该报）',
      expect: 'red',
      rel: 'scripts/smoke-pay-once.ts',
      src:
        'export async function run() {\n' +
        "  const res = await fetch('https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi', { method: 'POST' })\n" +
        '  return res.json()\n' +
        '}\n',
    },
    {
      name: '地址来自变量（该报）：无法证明是本机',
      expect: 'red',
      rel: 'scripts/smoke-ledger-reconcile.ts',
      src:
        'const gateway = process.env.PAY_GATEWAY\n' +
        'export async function refund() {\n' +
        '  return fetch(`${gateway}/v3/refund`)\n' +
        '}\n',
    },
    {
      name: '引入支付 SDK（该报）：导入即代表真出网能力',
      expect: 'red',
      rel: 'scripts/smoke-refund.ts',
      src:
        "import { Wechatpay } from 'wechatpay-node-v3'\n" +
        'export const client = new Wechatpay({})\n',
    },
    {
      name: '已引入强制 mock 环境（不该报）',
      expect: 'green',
      rel: 'scripts/smoke-refund.ts',
      src:
        "import './lib/force-mock-env.ts'\n" +
        "import { Wechatpay } from 'wechatpay-node-v3'\n" +
        "export const res = await fetch('https://api.mch.weixin.qq.com/v3/refund')\n",
    },
    {
      name: '只打本机 dev server（不该报）：这是脚本的正确用法',
      expect: 'green',
      rel: 'scripts/smoke-admin-gate.ts',
      src:
        "export const res = await fetch('http://127.0.0.1:3000/api/admin/gate', { method: 'POST' })\n" +
        "export const rel = await fetch('/api/health')\n",
    },
    {
      name: '本机地址由变量提供、默认值含本机主机（不该报）：真实仓 72 条误报的固化样本',
      expect: 'green',
      rel: 'scripts/smoke-skin-test-limit.ts',
      src:
        "const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3001'\n" +
        'const res = await fetch(`${BASE}/api/records`)\n' +
        'export const json = await res.json()\n',
    },
    {
      name: '地址经两层变量最终落到本机（不该报）：`const url = `${BASE}/…``',
      expect: 'green',
      rel: 'scripts/smoke-feed.ts',
      src:
        "const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3001'\n" +
        'export async function probe() {\n' +
        '  const url = `${BASE}/api/feed?limit=10`\n' +
        '  return fetch(url)\n' +
        '}\n',
    },
    {
      name: '保留域名（不该报）：解析阶段就失败，没有外部副作用',
      expect: 'green',
      rel: 'scripts/smoke-dependency-fault.ts',
      src: "await fetch('https://not-declared.example.invalid/probe')\n",
    },
    {
      name: '模板主机去掉变量后仍是公网域名（该报）：真实对象存储',
      expect: 'red',
      rel: 'scripts/smoke-aftersale-cleanup.ts',
      src:
        "const bucket = process.env.ASSET_BUCKET\n" +
        'const origin = `https://${bucket}.blob.cdn-endpoint.net`\n' +
        'await fetch(`${origin}/probe.jpg`, { method: "DELETE" })\n',
    },
    {
      name: '配置了项目自己的 mock 模块名（不该报）',
      expect: 'green',
      rel: 'scripts/smoke-pay.ts',
      src: "import './lib/offline-gateway.ts'\nexport const res = await fetch('https://pay.example.com/charge')\n",
      options: { mockEnvImport: ['offline-gateway'] },
    },
    {
      name: '同文件 fetch 垫片只拦自己的桶（不该报）：跑一遍零真实网络',
      expect: 'green',
      rel: 'scripts/smoke-aftersale-a1-cleanup.ts',
      src:
        'const GATE_ORIGIN = `https://${GATE_BUCKET}.cos.${GATE_REGION}.myqcloud.com`\n' +
        'const realFetch = globalThis.fetch\n' +
        'globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {\n' +
        '  const u = typeof input === \'string\' ? input : String(input)\n' +
        '  if (u.startsWith(`${GATE_ORIGIN}/`)) return new Response(\'\', { status: 200 })\n' +
        '  return realFetch(input as never, init as never)\n' +
        '}) as typeof fetch\n' +
        'export const res = await globalThis.fetch(`${GATE_ORIGIN}/aftersale/x.jpg`, { method: \'DELETE\' })\n',
    },
    {
      // 反证：垫片有，但同一文件另打真实主机——垫片挡不住它，必须报。
      name: '有 fetch 垫片但另打真实支付网关（该报）：垫片只覆盖自己的桶',
      expect: 'red',
      rel: 'scripts/smoke-aftersale-a1-cleanup.ts',
      src:
        'const GATE_ORIGIN = `https://${GATE_BUCKET}.cos.${GATE_REGION}.myqcloud.com`\n' +
        'const realFetch = globalThis.fetch\n' +
        'globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {\n' +
        '  const u = typeof input === \'string\' ? input : String(input)\n' +
        '  if (u.startsWith(`${GATE_ORIGIN}/`)) return new Response(\'\', { status: 200 })\n' +
        '  return realFetch(input as never, init as never)\n' +
        '}) as typeof fetch\n' +
        'await globalThis.fetch(`${GATE_ORIGIN}/aftersale/x.jpg`, { method: \'DELETE\' })\n' +
        'await fetch(\'https://api.mch.weixin.qq.com/v3/pay\', { method: \'POST\' })\n',
    },
    {
      name: '真连通默认关闭、只在 if (live) 分支调用（不该报）：显式 opt-in',
      expect: 'green',
      rel: 'scripts/smoke-cos-sign.ts',
      src:
        "const live = process.env.COS_LIVE === '1' && cosConfigured()\n" +
        'if (live) {\n' +
        '  void runLive()\n' +
        '}\n' +
        'export async function runLive(): Promise<void> {\n' +
        "  const put = await fetch('https://bucket.cos.ap-shanghai.myqcloud.com/x.jpg', { method: 'PUT' })\n" +
        '  return put.body\n' +
        '}\n',
    },
    {
      // 反证：定义了 live 变量却无条件调用——那不是 opt-in，跑一遍就出网。
      name: '有 live 变量但无条件调用真连通函数（该报）：默认不跑才叫 opt-in',
      expect: 'red',
      rel: 'scripts/smoke-cos-sign.ts',
      src:
        "const live = process.env.COS_LIVE === '1' && cosConfigured()\n" +
        'void runLive()\n' +
        'export async function runLive(): Promise<void> {\n' +
        "  await fetch('https://bucket.cos.ap-shanghai.myqcloud.com/x.jpg', { method: 'PUT' })\n" +
        '}\n' +
        "export const gate = live\n",
    },
    {
      name: '非自测脚本的部署脚本（不该报）：射程只到自测脚本',
      expect: 'green',
      files: {
        'scripts/deploy.ts': "export const res = await fetch('https://deploy.example.com/hook', { method: 'POST' })\n",
        // 样本根必须留一个射程内文件，否则「0 个文件」会让样本以 NotApplicable 失败
        'scripts/smoke-local.ts': "export const res = await fetch('http://localhost:3000/health')\n",
      },
    },
    {
      name: '源码目录里的外部调用（不该报）：自测脚本之外不在射程',
      expect: 'green',
      files: {
        'src/lib/pay.ts': "export const res = await fetch('https://api.mch.weixin.qq.com/v3/pay')\n",
        'scripts/smoke-local.ts': "export const ok = true\n",
      },
    },
  ],
})
