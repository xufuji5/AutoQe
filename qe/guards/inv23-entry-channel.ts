import path from 'node:path'
import ts from 'typescript'
import { defineGuard, err, info, warn } from '../lib/guard.ts'
import { NotApplicable } from '../lib/not-applicable.ts'
import { readTextSafe, rel, walkFiles } from '../lib/fs.ts'
import { escapeRe, stripComments } from '../lib/code-only.ts'
import { exportedFunctions } from '../lib/ast-utils.ts'
import type { Finding } from '../lib/guard.ts'

/**
 * 界面入口覆盖：服务端写能力必须对应一个真实的请求发送点。
 *
 * ## 为什么需要这条判据
 *
 * 规范型 AI 开发最常见的漏法是「建了服务端、忘了界面」：route handler 写了、
 * service 写了、e2e 脚本也打了，于是「接口有调用者」这条判据全绿 —— 但用户点不到。
 * 旧判据的假绿来源是语料太宽：`scripts/` 里的 e2e 脚本、注释里提到路径、路由文件自身
 * 的字符串，都能把「有调用者」这条判活。本守卫把语料收窄到**界面面**（app 非 api + components），
 * 并按「写方法」逐端点计数。
 *
 * ## 纪律
 *
 * - `app/api/**` 恒排除：路由文件提到自己的路径不算入口。
 * - 先剥注释再匹配：注释里写「待接入 /api/x」不能顶替表单。
 * - 找不到入口只有两种正当解释：外部渠道（登记在 `coverage.externalPrefixes` / `boundaries.publicRoutes`）
 *   或已登记的暂缺（`coverage.knownNoEntry`，理由与复审日期必填）。
 * - 登记了但界面已经能点到 = 登记过期（红），不能把过期登记留成永久豁免。
 *
 * ## 盲区（必须如实写进 blindSpots）
 *
 * 只判「同一文件里同时出现端点路径字面量与请求发送调用」。分支级（同一路径不同 body 走不同
 * 业务）、方法错配（路径调 GET 但服务端只有 POST 语义）、运行时拼接的路径、中央 api client
 * 把路径收到别处的情况都看不见。
 */

const FIXTURES = path.join(import.meta.dirname, '../fixtures/inv23-entry-channel')

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const DEFAULT_ROUTE_ROOTS = ['app', 'src/app']
const DEFAULT_UI_ROOTS = ['app', 'components']
const ROUTE_BASENAME = /^(?:.+\/)?route\.[cm]?[jt]sx?$/
const API_SEGMENT = '/api/'

/**
 * 请求发送点形状。只认会真的发出 HTTP 的调用：
 * `fetch(`、`axios(` / `axios.post(`、`navigator.sendBeacon(`，以及项目常见的 JSON 封装。
 * 不认 `link href`、`router.push`、`<a href>` —— 它们只换页面，不会打到 route handler。
 *
 * ## 为什么词表必须可由配置追加（2026-10-25 实测）
 *
 * 第一版把「请求发送点」写成一张**作者想到的**名字表。试点仓实测漏了两类：
 *   - `apiJson<T>("/api/x", …)` —— 泛型实参夹在名字和 `(` 之间，`\s*[.(]` 根本不匹配；
 *   - 小程序侧的 `request({ url: '/api/x' })` —— 名字压根不在表里。
 * 这两处都让真实入口被判成「用户点不到」，而读数行只显示「无入口 N 条」。
 * 词表是**项目事实**，不是工具事实，所以由 `coverage.requestCallAdditions` 声明（理由必填）；
 * 判据代码只负责「拼进同一张表 + 空理由不算声明」。
 */
const REQUEST_CALL_SOURCE =
  '\\b(?:fetch|axios|apiFetch|requestJson|postJson|putJson|patchJson|deleteJson|sendJson|sendBeacon)\\s*[.(]'

/**
 * 第二类语料：同一仓的第二个客户端（小程序 / 独立 SPA / RN）。
 *
 * `coverage.uiRoots` 只能扩展**同一个**语料（共用 `source.extensions`、共用请求词表），
 * 而第二个客户端往往三样全不同：扩展名（`.js`）、请求形态（`wx.request`）、目录。
 * 把它们塞进 `source.extensions` 会顺带让依赖源码面的守卫去扫客户端代码 —— 那是改判据射程换假绿。
 */
interface UiCorpus {
  name: string
  roots: string[]
  extensions?: string[]
  requestCall?: string
}

/** 动态末段登记：末段在调用侧是变量，字面量前缀只能证到上一段为止 */
interface DynamicTail {
  endpoint: string
  evidence: string
  reason: string
}

/**
 * 第二种取证形态：路径被赋给「入口语义」的名字（`endpoint="..."` / `url = "..."`），
 * 由共享组件在别处发出请求。
 *
 * 为什么必须认这一形态：本仓的签署/作废面板是单源的，页面只传 `endpoint`，
 * fetch 在共享组件里 —— 只看「同文件 fetch」会把一批真实入口判成「用户点不到」。
 * 代价是可能把「定义了一张路由表但没人点」认成入口，已写入盲区。
 */
const ENDPOINT_CONTEXT = /(?:endpoint|action|url|path|apiPath|href|src|route)\s*[:=]\s*(?:\{\s*)?["'`]$/

function isEndpointContext(code: string, at: number): boolean {
  return ENDPOINT_CONTEXT.test(code.slice(Math.max(0, at - 48), at))
}

interface RouteEntry {
  rel: string
  endpoint: string
  method: string
  line: number
}

interface KnownNoEntry {
  route: string
  methods?: string[]
  reason: string
  reviewBy?: string
}

interface ExternalPrefix {
  prefix: string
  reason: string
}

function endpointOf(routeRoot: string, relFile: string): string | null {
  if (!relFile.startsWith(routeRoot + '/')) return null
  const rest = relFile.slice(routeRoot.length)
  if (!rest.startsWith(API_SEGMENT)) return null
  const at = rest.lastIndexOf('/route.')
  if (at < 0) return null
  return rest.slice(0, at) || '/'
}

/**
 * 端点路径 → 界面侧可命中的字面量形态。
 * 动态段 `[id]` / `[...slug]` 在调用侧会写成 `/api/x/${id}` 或具体值，统一按「一个路径段」匹配；
 * 结尾要求紧跟引号/反引号/查询串/空白，避免 `/api/export` 把 `/api/export/analysis` 吃掉。
 *
 * 结尾集合必须包含 `$`：模板串里拼接查询串是最常见写法（`` fetch(`/api/auth/captcha${q}`) ``），
 * 而端点本身已经到尽头 —— 少这一个字符，整类真实入口都判不到（本仓实测 6 处）。
 */
function pathMatcher(endpoint: string): RegExp {
  let src = ''
  for (const seg of endpoint.split('/').filter(Boolean)) {
    if (/^\[\[?\.\.\./.test(seg)) src += '/.+'
    else if (/^\[\[?/.test(seg)) src += '/[^/\'"`\\s]+'
    else src += '/' + escapeRe(seg)
  }
  return new RegExp(src + '(?=[\'"`?#$\\s]|$)', 'g')
}

function methodsIn(file: string, text: string): { name: string; line: number }[] {
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TS,
  )
  return exportedFunctions(sf)
    .map((fn) => ({ name: fn.name.toUpperCase(), line: fn.line }))
    .filter((m) => HTTP_METHODS.has(m.name))
}

function methodList(entry: KnownNoEntry): string[] | null {
  if (!entry.methods?.length) return null
  return entry.methods.map((m) => m.toUpperCase())
}

function publicRuleMatches(
  relFile: string,
  method: string,
  rule: { file: string; methods?: string[] },
): boolean {
  const fileHit = relFile === rule.file || relFile.endsWith('/' + rule.file)
  if (!fileHit) return false
  return !rule.methods?.length || rule.methods.map((m) => m.toUpperCase()).includes(method)
}

export const inv23 = defineGuard({
  id: 'inv23-entry-channel',
  title: '界面入口覆盖（服务端写能力 ↔ 请求发送点）',
  invariants: ['INV-WEB-07'],
  blindSpots: [
    '只判「同一文件里同时出现端点路径字面量与请求发送调用」，不判分支级（同一路径不同 body 走不同业务分支）',
    '不判方法错配：路径被 fetch 到但调用的是 GET，服务端只有 POST 语义时看不见',
    '路径必须是字面量或模板串；运行时拼接（变量、路由表、中央 api client 把路径收在别处）不在射程。末段在调用侧是变量的形态须在 coverage.dynamicTail 逐条举证登记，未登记即不在射程',
    '不判「入口是否可达」：组件存在但没有任何页面引用它，仍算有入口',
    '路径赋给 endpoint/url/action 等名字时算入口（共享组件代发请求）；只定义未点击的路由常量也会被认成入口',
    '只判写入方法（POST/PUT/PATCH/DELETE）；GET 端点可能由服务端/外部调用，不参与本判据',
    '请求发送点靠词表识别（默认 fetch/axios/… + coverage.requestCallAdditions）；用未声明的私有封装发请求会被判成「无入口」——这是「词表是项目事实」的代价，代价写在词表声明处',
  ],
  async run(ctx) {
    const coverage = ctx.config.coverage ?? {}
    const routeRoots = coverage.routeRoots?.length ? coverage.routeRoots : DEFAULT_ROUTE_ROOTS
    const uiRoots = coverage.uiRoots?.length ? coverage.uiRoots : DEFAULT_UI_ROOTS
    const known = (coverage.knownNoEntry ?? []) as KnownNoEntry[]
    const external = (coverage.externalPrefixes ?? []) as ExternalPrefix[]
    const publicRoutes = ctx.config.boundaries?.publicRoutes ?? []

    const findings: Finding[] = []

    // —— 请求发送点词表：默认 + 项目追加（空理由不算声明） ——
    const callSources = [REQUEST_CALL_SOURCE]
    for (const add of coverage.requestCallAdditions ?? []) {
      if (!add.pattern?.trim()) {
        findings.push(err('REQUEST_CALL_BAD_DECL', 'coverage.requestCallAdditions 有一条空 pattern：空声明不产生词表项'))
        continue
      }
      if (!add.reason?.trim()) {
        findings.push(
          err(
            'REQUEST_CALL_NO_REASON',
            `coverage.requestCallAdditions 的 ${add.pattern} 未写理由：加词表等于扩判据射程，必须说明「这个封装就是这个仓唯一的请求发送点」`,
          ),
        )
        continue
      }
      try {
        new RegExp(add.pattern)
      } catch {
        findings.push(err('REQUEST_CALL_BAD_DECL', `coverage.requestCallAdditions 的 ${add.pattern} 不是合法正则`))
        continue
      }
      callSources.push(add.pattern)
    }
    const defaultCall = new RegExp(callSources.join('|'))

    const routeFiles: { rel: string; abs: string; endpoint: string }[] = []
    for (const routeRoot of routeRoots) {
      for (const abs of await walkFiles(ctx.root, routeRoot, { ignore: ctx.config.ignore, ext: ctx.config.source.extensions })) {
        const relFile = rel(ctx.root, abs)
        if (!ROUTE_BASENAME.test(relFile)) continue
        const endpoint = endpointOf(routeRoot, relFile)
        if (!endpoint) continue
        routeFiles.push({ rel: relFile, abs, endpoint })
      }
    }
    if (routeFiles.length === 0) {
      throw new NotApplicable(
        'NO_ROUTE_FILES',
        `未在 ${routeRoots.join(',')} 下发现 api/**/route.*：本仓库不适用入口覆盖判据，不报绿`,
      )
    }

    const routes: RouteEntry[] = []
    for (const route of routeFiles) {
      const text = await readTextSafe(route.abs)
      if (text === null) continue
      for (const m of methodsIn(route.abs, text)) {
        routes.push({ rel: route.rel, endpoint: route.endpoint, method: m.name, line: m.line })
      }
    }
    const writeRoutes = routes.filter((r) => WRITE_METHODS.has(r.method))

    // 界面语料：默认语料（app 去掉 app/api + components）**外加**项目声明的第二个客户端。
    // 路由文件自身不能给自己作证；同一文件只归一个语料（先到先得），避免两套词表互相顶替。
    const corpora: { name: string; roots: string[]; ext: string[]; call: RegExp }[] = [
      { name: 'default', roots: uiRoots, ext: ctx.config.source.extensions, call: defaultCall },
    ]
    for (const extra of coverage.uiCorpora ?? []) {
      if (!extra.name?.trim() || !extra.roots?.length) {
        findings.push(
          err('UI_CORPUS_BAD_DECL', 'coverage.uiCorpora 有一条缺 name 或 roots：第二个客户端语料必须可指认、可定位'),
        )
        continue
      }
      if (!extra.reason?.trim()) {
        findings.push(
          err(
            'UI_CORPUS_NO_REASON',
            `coverage.uiCorpora 的 ${extra.name} 未写理由：多认一份语料等于多一批「有入口」的证据，必须说明它是同一产品的哪个客户端`,
          ),
        )
        continue
      }
      corpora.push({
        name: extra.name,
        roots: extra.roots,
        ext: extra.extensions?.length ? extra.extensions : ctx.config.source.extensions,
        call: extra.requestCall?.trim() ? new RegExp(extra.requestCall) : defaultCall,
      })
    }

    const corpusOf = new Map<string, { name: string; call: RegExp }>()
    for (const corpus of corpora) {
      for (const uiRoot of corpus.roots) {
        for (const abs of await walkFiles(ctx.root, uiRoot, { ignore: ctx.config.ignore, ext: corpus.ext })) {
          const relFile = rel(ctx.root, abs)
          if (routeRoots.some((rt) => relFile.startsWith(rt + API_SEGMENT))) continue
          if (corpusOf.has(abs)) continue
          corpusOf.set(abs, { name: corpus.name, call: corpus.call })
        }
      }
    }
    const sortedUi = [...corpusOf.keys()].sort()

    // 前缀证据登记表：endpoint → 首个命中「静态前缀/${」的调用侧位置
    const prefixEvidence = new Map<string, { file: string; line: number }>()
    const called = new Set<string>()
    // 动态末段自动取证（2026-10-28）：字面量证不到 ≠ 界面没有。语料里若存在
    // 「<静态前缀>/${」形态的模板串，至少证明界面在向该资源族发请求、末段由变量决定
    // ——此时降为 warn（UI_EVIDENCE_DYNAMIC_TAIL，提示去补 dynamicTail 登记），
    // 只有连前缀证据都没有时才 err。缺登记与真无入口是两种结论，不许混成一条红。
    const prefixMatchers = new Map<string, RegExp>()
    // 永不空返回：静态段不足 2 的端点映射到永不匹配的正则（(?!)），调用侧免判空
    const prefixOf = (endpoint: string): RegExp => {
      if (prefixMatchers.has(endpoint)) return prefixMatchers.get(endpoint)!
      const staticSegs: string[] = []
      for (const seg of endpoint.split('/').filter(Boolean)) {
        if (seg.startsWith('[')) break
        staticSegs.push(seg)
      }
      if (staticSegs.length < 2) {
        prefixMatchers.set(endpoint, new RegExp('(?!)'))
        return prefixMatchers.get(endpoint)!
      }
      const re = new RegExp(escapeRe('/' + staticSegs.join('/')) + '/\\$\\{', 'g')
      prefixMatchers.set(endpoint, re)
      return re
    }
    const matchers = new Map<string, RegExp>()
    const fileCounts = new Map<string, number>()
    let requestFiles = 0
    for (const abs of sortedUi) {
      const text = await readTextSafe(abs)
      if (text === null) continue
      const code = stripComments(text)
      const corpus = corpusOf.get(abs)!
      fileCounts.set(corpus.name, (fileCounts.get(corpus.name) ?? 0) + 1)
      const hasCall = corpus.call.test(code)
      if (hasCall) requestFiles++
      for (const route of writeRoutes) {
        if (called.has(route.endpoint)) continue
        let matcher = matchers.get(route.endpoint)
        if (!matcher) {
          matcher = pathMatcher(route.endpoint)
          matchers.set(route.endpoint, matcher)
        }
        matcher.lastIndex = 0
        let m: RegExpExecArray | null
        let hit = false
        while ((m = matcher.exec(code)) !== null) {
          if (m[0].length === 0) matcher.lastIndex++
          if (hasCall || isEndpointContext(code, m.index)) {
            called.add(route.endpoint)
            hit = true
            break
          }
        }
        if (hit) continue
        // 前缀取证：只对还没被任何语料命中的端点做，命中一次就够（首个证据文件）
        if (prefixEvidence.has(route.endpoint)) continue
        const pRe = prefixOf(route.endpoint)
        pRe.lastIndex = 0
        const p = pRe.exec(code)
        if (p !== null && (hasCall || isEndpointContext(code, p.index))) {
          prefixEvidence.set(route.endpoint, {
            file: rel(ctx.root, abs),
            line: code.slice(0, p.index).split('\n').length,
          })
        }
      }
    }

    // —— 动态末段登记：末段在调用侧是变量，字面量只能证到「静态前缀 + /${」 ——
    const dynamicTail = coverage.dynamicTail ?? []
    for (const d of dynamicTail) {
      if (!d.endpoint?.trim()) {
        findings.push(err('DYNAMIC_TAIL_BAD_DECL', 'coverage.dynamicTail 有一条缺 endpoint'))
        continue
      }
      if (!d.reason?.trim()) {
        findings.push(err('DYNAMIC_TAIL_NO_REASON', `dynamicTail 登记 ${d.endpoint} 未写理由：空理由不是举证`))
        continue
      }
      if (!routes.some((r) => r.endpoint === d.endpoint)) {
        findings.push(warn('DYNAMIC_TAIL_STALE', `dynamicTail 登记 ${d.endpoint} 未命中任何路由（登记过期）`))
        continue
      }
      if (called.has(d.endpoint)) {
        findings.push(
          err('DYNAMIC_TAIL_STALE', `dynamicTail 登记 ${d.endpoint}，但界面已能静态命中该路径：删除该登记（登记过期）`),
        )
        continue
      }
      // 字面量前缀：端点开头连续的静态段。只剩 /api 时任何调用都能作证，不许当证据。
      // 阈值取 2（`/api/<资源>`）：再短就退化成「仓里有 fetch 就算入口」；
      // 再长会把 `/api/ticket/[id]/resolve` 这类真实形状挡在外面，而它恰恰是最典型的一种。
      const staticSegs: string[] = []
      for (const seg of d.endpoint.split('/').filter(Boolean)) {
        if (seg.startsWith('[')) break
        staticSegs.push(seg)
      }
      if (staticSegs.length < 2) {
        findings.push(
          err(
            'DYNAMIC_TAIL_TOO_BROAD',
            `dynamicTail 登记 ${d.endpoint} 的静态前缀只有 /${staticSegs.join('/')}（不足 2 段）：这么短的前缀任何调用都能作证，等于没有判据`,
          ),
        )
        continue
      }
      const raw = await readTextSafe(path.resolve(ctx.root, d.evidence))
      if (raw === null) {
        findings.push(
          err(
            'DYNAMIC_TAIL_NO_EVIDENCE',
            `dynamicTail 登记 ${d.endpoint} 的证据文件 ${d.evidence} 读不到：举证必须指向真实存在的发送点`,
          ),
        )
        continue
      }
      const want = new RegExp(escapeRe('/' + staticSegs.join('/')) + '/\\$\\{')
      if (!want.test(stripComments(raw))) {
        findings.push(
          err(
            'DYNAMIC_TAIL_NOT_BACKED',
            `dynamicTail 登记的 ${d.endpoint} 在 ${d.evidence} 里找不到「/${staticSegs.join('/')}/` + '${' + `…」这样的发送点：声明的证据不成立`,
            { file: d.evidence, entity: d.endpoint },
          ),
        )
        continue
      }
      called.add(d.endpoint)
    }

    const knownHit = new Set<KnownNoEntry>()
    const externalHit = new Set<ExternalPrefix>()

    const knownFor = (route: string, method: string): KnownNoEntry | undefined =>
      known.find((k) => k.route === route && (!methodList(k) || methodList(k)!.includes(method)))
    const externalFor = (route: string): ExternalPrefix | undefined =>
      external.find(
        (e) => route === e.prefix || route.startsWith(e.prefix.endsWith('/') ? e.prefix : e.prefix + '/'),
      )

    for (const entry of writeRoutes) {
      const publicRule = publicRoutes.find((r) => publicRuleMatches(entry.rel, entry.method, r))
      const knownRule = knownFor(entry.endpoint, entry.method)
      const externalRule = externalFor(entry.endpoint)
      if (knownRule) knownHit.add(knownRule)
      if (externalRule) externalHit.add(externalRule)

      if (knownRule && !knownRule.reason.trim()) {
        findings.push(
          err('ENTRY_EXEMPT_NO_REASON', `${entry.rel}#${entry.method} 登记为「无界面入口」但未写理由：空理由不是豁免`, {
            file: entry.rel,
            line: entry.line,
            entity: entry.endpoint,
          }),
        )
        continue
      }
      if (knownRule && !knownRule.reviewBy?.trim()) {
        findings.push(
          warn('ENTRY_EXEMPT_NO_REVIEW', `${entry.rel}#${entry.method} 的暂缺登记未写复审日期（reviewBy）：会变成永久豁免`, {
            file: entry.rel,
            line: entry.line,
            entity: entry.endpoint,
          }),
        )
      }
      const exempt = Boolean(publicRule || knownRule || externalRule)
      if (!called.has(entry.endpoint) && !exempt) {
        const ev = prefixEvidence.get(entry.endpoint)
        if (ev) {
          findings.push(
            warn(
              'ENTRY_UI_DYNAMIC_TAIL',
              `${entry.rel}#${entry.method} ${entry.endpoint} 的末段在调用侧由变量决定（${ev.file}:${ev.line} 只能证到静态前缀）：按登记义务补 coverage.dynamicTail 举证，未登记前只降为 warn 不冒红`,
              { file: entry.rel, line: entry.line, entity: entry.endpoint },
            ),
          )
        } else {
          findings.push(
            err(
              'ENTRY_NO_UI',
              `${entry.rel}#${entry.method} ${entry.endpoint} 在界面语料中无任何请求发送点：用户点不到，功能等于未交付`,
              { file: entry.rel, line: entry.line, entity: entry.endpoint },
            ),
          )
        }
      }
    }

    // 登记过期：整端点登记了「无界面入口」，但界面已经能点到 —— 豁免必须撤销。
    // 精确到方法的登记不做此项：界面语料是路径级，分不清调的是 GET 还是 POST（盲区已声明）。
    for (const k of knownHit) {
      if (methodList(k)) continue
      const route = routes.find((r) => r.endpoint === k.route)
      if (!route) {
        findings.push(warn('ENTRY_EXEMPT_STALE', `knownNoEntry 登记 ${k.route} 未命中任何路由（登记过期）`))
        continue
      }
      if (called.has(k.route)) {
        findings.push(
          err('ENTRY_EXEMPT_STALE', `${k.route} 已登记为「无界面入口」，但界面已出现请求发送点：删除该登记`, {
            file: route.rel,
            entity: k.route,
          }),
        )
      }
    }
    for (const k of known) {
      if (knownHit.has(k)) continue
      if (!routes.some((r) => r.endpoint === k.route)) {
        findings.push(warn('ENTRY_EXEMPT_STALE', `knownNoEntry 登记 ${k.route} 未命中任何路由（登记过期）`))
      } else if (!k.reason.trim()) {
        findings.push(warn('ENTRY_EXEMPT_NO_REASON', `knownNoEntry 登记 ${k.route} 未覆盖任何写方法，且理由为空`))
      }
    }
    for (const e of external) {
      if (!e.reason.trim()) {
        findings.push(err('ENTRY_EXEMPT_NO_REASON', `externalPrefixes 登记 ${e.prefix} 未写理由：空理由不是豁免`))
      }
      if (!externalHit.has(e)) {
        findings.push(warn('ENTRY_EXEMPT_STALE', `externalPrefixes 登记 ${e.prefix} 未命中任何端点（登记过期）`))
      }
    }

    if (findings.length === 0) {
      findings.push(
        info(
          'ENTRY_CHANNEL_CLEAN',
          `写端点 ${writeRoutes.length} 个均有界面请求发送点或已登记外部渠道`,
        ),
      )
    }
    return {
      findings,
      scanned: `routes=${routeFiles.length} methods=${routes.length} writeEndpoints=${writeRoutes.length} uiFiles=${sortedUi.length}(${[...fileCounts].map(([k, v]) => `${k}:${v}`).join('+')}) requestFiles=${requestFiles} called=${called.size}(dynamicTail=${dynamicTail.length} dynamicEvidence=${prefixEvidence.size}) knownNoEntry=${known.length} external=${external.length} public=${publicRoutes.length}`,
    }
  },
  selfTest: [
    {
      name: 'good：写端点有界面请求点，GET 端点不参与判定',
      root: path.join(FIXTURES, 'good'),
      expect: 'green',
      maxErrors: 0,
      maxWarnings: 0,
    },
    {
      name: 'bad：服务端有 POST、界面无任何请求点',
      root: path.join(FIXTURES, 'bad'),
      expect: 'red',
      minErrors: 1,
      maxWarnings: 0,
    },
    {
      name: 'bad：只在注释里提到路径，不算界面入口（防旧判据的假绿）',
      root: path.join(FIXTURES, 'comment'),
      expect: 'red',
      minErrors: 1,
      maxWarnings: 0,
    },
    {
      name: 'bad：整端点登记了暂缺，但界面已经能点到（登记过期）',
      root: path.join(FIXTURES, 'stale'),
      expect: 'red',
      minErrors: 1,
      maxWarnings: 0,
      config: {
        coverage: {
          knownNoEntry: [{ route: '/api/recall', reason: '暂未排期', reviewBy: '2026-12-31' }],
        },
      },
    },
    {
      name: 'bad：暂缺登记理由为空（空理由不是豁免）',
      root: path.join(FIXTURES, 'exempt-empty'),
      expect: 'red',
      minErrors: 1,
      maxWarnings: 0,
      config: {
        coverage: {
          knownNoEntry: [{ route: '/api/support', reason: '', reviewBy: '2026-12-31' }],
        },
      },
    },
    {
      name: 'good：外部渠道按前缀登记（监管来函直连）',
      root: path.join(FIXTURES, 'external'),
      expect: 'green',
      maxErrors: 0,
      maxWarnings: 0,
      config: {
        coverage: {
          externalPrefixes: [{ prefix: '/api/support', reason: '监管来函外部渠道：x-ops-token 直连，无界面录入' }],
        },
      },
    },
    {
      name: 'good：路径经 endpoint prop 交给单源面板代发请求（不算用户点不到）',
      root: path.join(FIXTURES, 'shared-prop'),
      expect: 'green',
      maxErrors: 0,
      maxWarnings: 0,
    },
    {
      name: 'good：公开路由已逐条登记理由（外部扫码器调用）',
      root: path.join(FIXTURES, 'public'),
      expect: 'green',
      maxErrors: 0,
      maxWarnings: 0,
      config: {
        boundaries: {
          publicRoutes: [{ file: 'app/api/trace/[code]/route.ts', reason: '公开追溯回调：外部扫码器调用，不承载录入' }],
        },
      },
    },
    {
      name: 'good：按方法登记暂缺（同文件 GET 有界面、POST 仅外部）',
      root: path.join(FIXTURES, 'known-method'),
      expect: 'green',
      maxErrors: 0,
      maxWarnings: 0,
      config: {
        coverage: {
          knownNoEntry: [{ route: '/api/support', methods: ['POST'], reason: '仅 POST 为监管直连', reviewBy: '2026-12-31' }],
        },
      },
    },
    {
      // 反证：结尾集合少了 `$` 时，本用例红（本仓 2026-10-25 实测 6 处真实入口被判无入口）
      name: 'good：模板串里紧跟 ${} 拼查询串仍算入口（结尾集合必须含 $）',
      root: path.join(FIXTURES, 'template-query'),
      expect: 'green',
      maxErrors: 0,
      maxWarnings: 0,
    },
    {
      // 反证：不加词表时本用例红 —— 私有封装的名字不在默认表里
      name: 'good：项目自有请求封装（泛型实参夹在名字与括号之间）经词表追加后算入口',
      root: path.join(FIXTURES, 'custom-call'),
      expect: 'green',
      maxErrors: 0,
      maxWarnings: 0,
      config: {
        coverage: {
          requestCallAdditions: [
            { pattern: '\\bapiJson\\b', reason: '本仓唯一的前端请求封装（泛型实参夹在名字与括号之间，默认词表匹配不到）' },
          ],
        },
      },
    },
    {
      name: 'bad：词表追加项没写理由（加射程不给理由不算声明）',
      root: path.join(FIXTURES, 'custom-call'),
      expect: 'red',
      minErrors: 1,
      config: {
        coverage: { requestCallAdditions: [{ pattern: '\\bapiJson\\b', reason: '' }] },
      },
    },
    {
      // 反证：不声明 uiCorpora 时本用例红（第二个客户端的 .js + wx.request 都不在默认语料里）
      name: 'good：第二个客户端语料（小程序 .js + wx.request）登记后算入口',
      root: path.join(FIXTURES, 'second-client'),
      expect: 'green',
      maxErrors: 0,
      maxWarnings: 0,
      config: {
        coverage: {
          uiCorpora: [
            {
              name: 'miniprogram',
              roots: ['client'],
              extensions: ['.js'],
              requestCall: '\\bwx\\.request\\s*\\(',
              reason: '同一产品的小程序客户端：页面是 .js，发请求走 wx.request',
            },
          ],
        },
      },
    },
    {
      name: 'bad：第二个客户端语料没写理由',
      root: path.join(FIXTURES, 'second-client'),
      expect: 'red',
      minErrors: 1,
      config: {
        coverage: { uiCorpora: [{ name: 'miniprogram', roots: ['client'], reason: '' }] },
      },
    },
    {
      // 反证：不登记 dynamicTail 时本用例红（末段是变量，静态看不见）
      name: 'good：动态末段经举证登记（证据文件里确有 <静态前缀>/${ 形态）后算入口',
      root: path.join(FIXTURES, 'dynamic-tail'),
      expect: 'green',
      maxErrors: 0,
      maxWarnings: 0,
      config: {
        coverage: {
          dynamicTail: [
            {
              endpoint: '/api/ticket/[id]/resolve',
              evidence: 'components/action-bar.tsx',
              reason: '操作栏按运行时 action 变量拼末段：resolve/close/reopen 三个动作共用一行 fetch',
            },
          ],
        },
      },
    },
    {
      name: 'bad：动态末段登记的证据文件里没有那个发送点形状（举证不成立）',
      root: path.join(FIXTURES, 'dynamic-tail'),
      expect: 'red',
      minErrors: 1,
      config: {
        coverage: {
          dynamicTail: [
            { endpoint: '/api/ticket/[id]/resolve', evidence: 'components/nothing.tsx', reason: '凭记忆登记' },
          ],
        },
      },
    },
    {
      name: 'bad：动态末段登记没写理由',
      root: path.join(FIXTURES, 'dynamic-tail'),
      expect: 'red',
      minErrors: 1,
      config: {
        coverage: {
          dynamicTail: [{ endpoint: '/api/ticket/[id]/resolve', evidence: 'components/action-bar.tsx', reason: '' }],
        },
      },
    },
    {
      // D1 翻面（2026-10-28）：不登记 dynamicTail 时旧实现判红（ENTRY_NO_UI），但语料里
      // 明明有「/api/ticket/${…}/」前缀证据 —— 「缺登记」与「真无入口」是两种结论。
      // 新实现：有前缀证据 → warn（UI_EVIDENCE_DYNAMIC_TAIL）；反证 = 旧实现这里是 error。
      name: 'warn：动态末段未登记但语料有静态前缀证据 → 降 warn（旧实现判红）',
      root: path.join(FIXTURES, 'dynamic-tail'),
      expect: 'warn',
      minWarnings: 1,
      maxErrors: 0,
    },
  ],
})
