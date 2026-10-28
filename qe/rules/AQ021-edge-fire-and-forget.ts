/**
 * AQ021 · Edge / Serverless handler 里 fire-and-forget：空 catch 的异步副作用不会被平台保活。
 *
 * ## 缺陷形态
 *
 * 请求处理函数里「顺手记一笔审计/埋点」最省力的写法是把 Promise 丢在那里：
 *
 * ```ts
 * export const runtime = 'edge'
 * export async function POST(request: Request) {
 *   writeAudit(request.url).catch(() => {})
 *   return new Response('ok')
 * }
 * ```
 *
 * 在长驻进程里它还能跑完；在 Edge / Serverless 运行时，**响应返回后执行上下文可能立刻被回收**，
 * 这个 Promise 既不 `await`、也没交给 `waitUntil`，于是：
 *
 * - 审计/埋点/通知在多数请求里根本没写进去（数据缺口没有任何报错）；
 * - 写失败被空 catch 吞掉，外面看到的是「请求成功了」。
 *
 * 它不报错、日志里也没有异常，只有对账时才会发现「有些请求没有审计记录」。
 *
 * ## 判据（形态可复算）
 *
 * 1. 文件具备 Edge / Serverless 能力证据：`runtime = 'edge'`、`config.runtime = 'edge'`、
 *    出现 `ExecutionContext` 类型，或文件里用了 `waitUntil(`；
 * 2. 存在 `.catch(<空处理>)`：处理体是空块、`undefined`/`null`/`void 0`，或解析到空函数；
 * 3. 该调用既不是 `await` 的、也不是 `return` 的、也没有被 `waitUntil(…)` 包住。
 *
 * 三条同时成立才报。「空处理」是必要条件：`catch((e) => log(e))` 至少有痕迹，
 * 由 AQ003（写路径异常必须处置）回答，不在这里重复。
 *
 * ## 为什么是 warn
 *
 * 「这个运行时会不会真的不等它」与部署平台、运行时版本、请求生命周期有关，源码看不出来。
 * 机器能证死的只有形态（空 catch + 无保活）；所以固定出候选。
 * 修复方向是明确的：把副作用交给 `waitUntil`，或 `await` 它并对失败做处置。
 */
import { argSpanAt, maskStringBodies, matchDelimiter, resolveCallbackBody, stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit } from '../lib/rule-guard.ts'

/** Edge / Serverless 能力证据（任一出现即认为本文件运行在可回收上下文里；`g` 用于逐条校验落点） */
const EDGE_EVIDENCE: RegExp[] = [
  /export\s+const\s+runtime\s*=\s*(['"])edge\1/g,
  /\bruntime\s*:\s*(['"])edge\1/g,
  /\bExecutionContext\b/g,
  /\bwaitUntil\s*\(/g,
]

/**
 * 能力证据必须落在**代码面**：字符串里的同名文字（日志文案、文档说明）不算证据。
 * 掩码面与原文逐字符等长，落点字符相同即说明这一处不是字符串体。
 */
function hasEdgeEvidence(code: string, masked: string): boolean {
  for (const re of EDGE_EVIDENCE) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(code)) !== null) {
      if (masked[m.index] === code[m.index]) return true
    }
  }
  return false
}

const NON_PROD = /(^|\/)(?:__tests__|tests?|specs?|stories|fixtures?|mocks?|testdata)(\/|$)/
const TEST_FILENAME = /\.(?:test|spec)\./

/** 判「空处理体」：只接受确实什么都不做的 handler（允许外层花括号与结尾分号） */
function isEmptyBody(body: string): boolean {
  let t = body.replace(/\s+/g, '')
  if (t.startsWith('{') && t.endsWith('}')) t = t.slice(1, -1)
  if (t.endsWith(';')) t = t.slice(0, -1)
  return (
    t === '' ||
    t === 'undefined' ||
    t === 'null' ||
    t === 'void0' ||
    t === 'return' ||
    t === 'returnundefined' ||
    t === 'returnnull' ||
    t === 'returnvoid0'
  )
}

/** `.catch(…)` 的实参是否为空处理（内联箭头/函数表达式，或可解析到空函数的具名引用） */
function noopCatchArg(masked: string, arg: string): boolean {
  const t = arg.trim()
  if (t === '') return false
  const arrow = /^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=()[\]{}\n]+)?=>\s*([\s\S]*)$/.exec(t)
  if (arrow) {
    const tail = arrow[1].replace(/\s+/g, '')
    if (tail === '{}') return true
    return isEmptyBody(arrow[1])
  }
  const fn = /^function\b[^(]*\([^)]*\)\s*\{([\s\S]*)\}$/.exec(t)
  if (fn) return isEmptyBody(fn[1])
  if (/^[A-Za-z_$][\w$]*$/.test(t)) {
    const body = resolveCallbackBody(masked, t)
    return body !== null && isEmptyBody(body)
  }
  return false
}

/**
 * 取 `.catch` 所在**语句**的起始位置。
 *
 * 语句链可以跨行，续行的特征是「该行第一个非空白字符是 `.` 或 `?.`」。
 * 旧实现用「上一行是否以 `; } ) ] 引号` 收尾」判语句边界：`.then(cb)` 收尾的续行恰好以 `)`
 * 结尾，于是被切成两条语句，`await` 留在被切掉的上一段里，多行链一律误报为未保活。
 */
function chainStart(masked: string, at: number): number {
  let start = masked.lastIndexOf('\n', at - 1) + 1
  while (start > 0) {
    const lineHead = masked.slice(start, at + 1).trimStart()
    if (!lineHead.startsWith('.') && !lineHead.startsWith('?.')) break
    const prev = masked.lastIndexOf('\n', start - 2) + 1
    if (prev >= start) break
    start = prev
  }
  return start
}

/**
 * 从 `.catch` 处向前找最近的、尚未闭合的调用括号，返回被调用者名。
 *
 * 用它替代「在切片里找 `waitUntil(` 并数括号」：`waitUntil(` 可以与 `.catch` 分处不同行，
 * 只要语句被换行切开，旧做法就看不到外层的 `waitUntil`，把已保活的调用误报出来。
 * 反向扫描时用括号深度跳过已闭合的内层调用，遇到语句边界（`; { }`）停止。
 */
function enclosingCallee(masked: string, at: number): string {
  let depth = 0
  for (let k = at - 1; k >= 0; k--) {
    const c = masked[k]
    if (c === ')') depth++
    else if (c === '(') {
      if (depth === 0) {
        const before = masked.slice(Math.max(0, k - 60), k).trimEnd()
        const m = /([A-Za-z_$][\w$]*)\s*$/.exec(before)
        return m ? m[1] : ''
      }
      depth--
    } else if (depth === 0 && (c === ';' || c === '{' || c === '}')) {
      break
    }
  }
  return ''
}

export const aq21 = toGuard({
  id: 'aq21',
  title: 'Edge/Serverless handler 里的 fire-and-forget（空 catch 且未交给 waitUntil）',
  invariants: ['INV-SEC-06'],
  code: 'AQ021_EDGE_FIRE_AND_FORGET',
  level: 'warn',
  blindSpots: [
    '射程只到「文件里有 Edge/Serverless 能力证据」的文件：`runtime = "edge"`、`config.runtime = "edge"`、`ExecutionContext`、或出现 `waitUntil(`。普通 Node 服务端文件不判（长驻进程里丢 Promise 也可能合法）',
    '能力证据必须落在代码面：字符串/日志文案里的 `runtime: \'edge\'`、`ExecutionContext` 不算证据（旧实现会把文件头字符串里的说明当成 capability）',
    '只认 `.catch(<空处理>)` 这一形态：只有 `.then(…)` 没有 catch、`void promise`（不带 catch）、或在 `Promise.all` 里被收走的写法不在射程',
    '空处理只认内联空箭头/空函数、`undefined`/`null`/`void 0`、以及同文件可解析到空函数的具名引用；跨文件导入的空 handler、经包装器生成的回调看不见',
    '保活判定只认 `await` / `return` / `waitUntil(…)` 三种词法包裹：先在变量里存 Promise、稍后再 await、或经自定义 `runAfterResponse()` 包装的形态不在射程',
    '不判断这个副作用是否真的会在响应后被回收（运行时与部署平台事实）；命中一律是候选',
    '不做数据流：即使调用点被 await，也不证明它写的那张表/那条日志真的落库',
  ],
  impact:
    'Edge/Serverless 请求处理里用空 catch 丢掉异步副作用：响应返回后执行上下文可能立刻被回收，' +
    '审计/埋点/通知没有写进去，失败又被空 catch 吞掉；外面只看到「请求成功」，' +
    '数据缺口要等对账时才被发现',
  provenance:
    '试点 E（2026-10）：Edge middleware 里写审计的 Promise 以 `.catch(() => {})` 结尾，未交给 waitUntil；' +
    '压测后审计表记录数只有请求数的三分之一，日志与响应码全部正常。修复前后静态判据都能复算出同一个结论',
  applies(rel) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|mts)$/.test(rel)) return false
    if (/(^|\/)node_modules\//.test(rel)) return false
    if (NON_PROD.test(rel) || TEST_FILENAME.test(rel)) return false
    return !/(selftest|fixture|testdata)/i.test(rel)
  },
  analyze(src): RawHit[] {
    const code = stripComments(src)
    const masked = maskStringBodies(code)
    if (!hasEdgeEvidence(code, masked)) return []

    const hits: RawHit[] = []
    const CATCH = /\.catch\s*\(/g
    let m: RegExpExecArray | null
    while ((m = CATCH.exec(masked)) !== null) {
      const open = m.index + m[0].length - 1
      const arg = argSpanAt(masked, open, 0)
      if (arg === null) continue
      if (!noopCatchArg(masked, arg)) continue

      const start = chainStart(masked, m.index)
      const region = masked.slice(start, m.index)
      const head = region.trimStart()
      // 保活：await / return / waitUntil(…) 包住
      if (/^await\s/.test(head)) continue
      if (/^return\s/.test(head)) continue
      if (enclosingCallee(masked, m.index) === 'waitUntil') continue

      hits.push({
        line: lineOf(src, m.index),
        message:
          'Edge/Serverless 处理里的异步副作用以空 catch 结尾，既没有 await、也没有交给 waitUntil：' +
          '响应返回后执行上下文可能立刻被回收，这次写入/通知不会完成，失败也不会留下任何痕迹。' +
          '请改为 `ctx.waitUntil(promise)`（并对失败做处置），或 `await` 它',
        evidence: evidenceOf(src, m.index),
      })
    }
    return hits
  },
  fixtures: [
    {
      name: 'Edge handler 里 .catch(() => {}) 丢 Promise（该报）：响应后上下文即回收',
      expect: 'warn',
      rel: 'app/api/audit/route.ts',
      src:
        "export const runtime = 'edge'\n" +
        'export async function POST(request: Request): Promise<Response> {\n' +
        '  writeAudit(request.url).catch(() => {})\n' +
        "  return new Response('ok')\n" +
        '}\n' +
        'declare function writeAudit(url: string): Promise<void>\n',
    },
    {
      name: '显式 fire-and-forget（void … .catch）也是该报形态',
      expect: 'warn',
      rel: 'app/api/audit/route.ts',
      src:
        "export const runtime = 'edge'\n" +
        'export async function POST(request: Request): Promise<Response> {\n' +
        '  void writeAudit(request.url).catch(() => undefined)\n' +
        "  return new Response('ok')\n" +
        '}\n' +
        'declare function writeAudit(url: string): Promise<void>\n',
    },
    {
      name: '交给 waitUntil（不该报）：平台负责保活',
      expect: 'green',
      rel: 'app/api/audit/route.ts',
      src:
        "export const runtime = 'edge'\n" +
        'type Ctx = { waitUntil(p: Promise<unknown>): void }\n' +
        'export async function POST(request: Request, ctx: Ctx): Promise<Response> {\n' +
        '  ctx.waitUntil(writeAudit(request.url).catch(() => {}))\n' +
        "  return new Response('ok')\n" +
        '}\n' +
        'declare function writeAudit(url: string): Promise<void>\n',
    },
    {
      name: 'await 之后才返回（不该报）：失败会进入响应路径',
      expect: 'green',
      rel: 'app/api/audit/route.ts',
      src:
        "export const runtime = 'edge'\n" +
        'export async function POST(request: Request): Promise<Response> {\n' +
        '  await writeAudit(request.url).catch(() => {})\n' +
        "  return new Response('ok')\n" +
        '}\n' +
        'declare function writeAudit(url: string): Promise<void>\n',
    },
    {
      name: '带返回类型的空 catch 回调（该报）：`(): void => {}` 同样是空处理',
      expect: 'warn',
      rel: 'app/api/audit/route.ts',
      src:
        "export const runtime = 'edge'\n" +
        'export async function POST(request: Request): Promise<Response> {\n' +
        '  writeAudit(request.url).catch((e: unknown): void => {})\n' +
        "  return new Response('ok')\n" +
        '}\n' +
        'declare function writeAudit(url: string): Promise<void>\n',
    },
    {
      name: '能力证据只出现在字符串里（不该报）：日志文案不是运行时能力',
      expect: 'green',
      rel: 'src/lib/audit.ts',
      src:
        'const note = "runtime: \'edge\'"\n' +
        'export function record(url: string): void {\n' +
        '  writeAudit(url).catch(() => {})\n' +
        '}\n' +
        'declare function writeAudit(url: string): Promise<void>\n',
    },
    {
      name: 'await 的多行链（不该报）：`.then(…)` 续行不切断语句',
      expect: 'green',
      rel: 'app/api/audit/route.ts',
      src:
        "export const runtime = 'edge'\n" +
        'export async function POST(request: Request): Promise<Response> {\n' +
        '  await fetch(request.url)\n' +
        '    .then((r) => r.json())\n' +
        '    .catch(() => {})\n' +
        "  return new Response('ok')\n" +
        '}\n',
    },
    {
      name: 'waitUntil 跨行包裹（不该报）：外层括号才是保活证据',
      expect: 'green',
      rel: 'app/api/audit/route.ts',
      src:
        "export const runtime = 'edge'\n" +
        'type Ctx = { waitUntil(p: Promise<unknown>): void }\n' +
        'export async function POST(request: Request, ctx: Ctx): Promise<Response> {\n' +
        '  ctx.waitUntil(\n' +
        '    writeAudit(request.url).catch(() => {})\n' +
        '  )\n' +
        "  return new Response('ok')\n" +
        '}\n' +
        'declare function writeAudit(url: string): Promise<void>\n',
    },
    {
      name: '未 await 的多行链（该报）：续行不改变「没有保活」',
      expect: 'warn',
      rel: 'app/api/audit/route.ts',
      src:
        "export const runtime = 'edge'\n" +
        'export async function POST(request: Request): Promise<Response> {\n' +
        "  fetch('/audit')\n" +
        '    .then((r) => r.json())\n' +
        '    .catch(() => {})\n' +
        "  return new Response('ok')\n" +
        '}\n',
    },
    {
      name: '`return;` 结尾的空块（该报）：块里只有一条空 return 仍是空处理',
      expect: 'warn',
      rel: 'app/api/audit/route.ts',
      src:
        "export const runtime = 'edge'\n" +
        'export async function POST(request: Request): Promise<Response> {\n' +
        '  writeAudit(request.url).catch(() => { return; })\n' +
        "  return new Response('ok')\n" +
        '}\n' +
        'declare function writeAudit(url: string): Promise<void>\n',
    },
    {
      name: '非 Edge 的 Node 文件（不该报）：射程只到具备 edge 能力的文件',
      expect: 'green',
      rel: 'src/lib/audit.ts',
      src:
        'export function record(url: string): void {\n' +
        '  writeAudit(url).catch(() => {})\n' +
        '}\n' +
        'declare function writeAudit(url: string): Promise<void>\n',
    },
  ],
})
