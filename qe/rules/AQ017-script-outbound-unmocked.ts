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
import { argSpanAt, matchDelimiter, maskStringBodies, stripComments } from '../lib/code-only.ts'
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

function isLocalHost(host: string): boolean {
  return LOCAL_HOST.test(host.trim())
}

/** 从调用实参判断地址归属：local = 可证本机/相对；external = 可证外网；unknown = 看不清 */
function addressClass(arg: string): 'local' | 'external' | 'unknown' {
  const t = arg.trim()
  const lit = /^(['"])([\s\S]*?)\1$/.exec(t)
  if (lit) {
    const url = lit[2]
    if (RELATIVE.test(url)) return 'local'
    const host = /^https?:\/\/([^/?#]+)/i.exec(url)
    if (!host) return 'unknown'
    return isLocalHost(host[1]) ? 'local' : 'external'
  }
  const tpl = /^`([\s\S]*?)`$/.exec(t)
  if (tpl) {
    const host = /^https?:\/\/([^/`]*)/i.exec(tpl[1])
    if (host && !host[1].includes('${')) return isLocalHost(host[1]) ? 'local' : 'external'
    return 'unknown'
  }
  return 'unknown'
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

export const aq17 = toGuard({
  id: 'aq17',
  title: '自测脚本真出网（未强制 mock 环境）',
  invariants: ['INV-RES-03'],
  code: 'AQ017_SCRIPT_OUTBOUND_UNMOCKED',
  blindSpots: [
    '只扫 `scripts/`、`tools/`、`ci/` 下、文件名以自测动词开头的文件；其它脚本里的真实出网不在射程',
    '「强制 mock」只认 import 说明符包含 `force-mock-env`（或配置的模块名）：脚本自行修改 `process.env`、由 npm script 预置环境变量、或经 wrapper 间接生效的 mock 不可见',
    '出网调用只认 `fetch` / `axios` / `https.request` 与支付类 SDK 的顶层 import：项目自封装的 `payClient.transfer()`、经服务模块间接出网不可见',
    '地址是变量/函数返回值时按 unknown 报（宁可多报一条，也不把真出网当本机）；`http://` 字面量主机解析只做字符串判断',
    '本地 dev server 与相对地址一律放过：那是正确用法，不是外部副作用',
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
        const cls = addressClass(code.slice(open + 1, open + 1 + arg.length))
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
      name: '配置了项目自己的 mock 模块名（不该报）',
      expect: 'green',
      rel: 'scripts/smoke-pay.ts',
      src: "import './lib/offline-gateway.ts'\nexport const res = await fetch('https://pay.example.com/charge')\n",
      options: { mockEnvImport: ['offline-gateway'] },
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
