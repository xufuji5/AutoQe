/**
 * 小程序工程的结构助手（纯函数 + 只读 `ctx.readFile`）。
 *
 * ## 为什么需要「先证明这是个小程序工程」
 * 引擎对非小程序仓也会把 `.js` 交给这些规则。若规则只是「扫不到就返回 0 命中」，
 * 在一个 Next.js 仓上它会输出「N 个文件已检查，0 命中」——那是**把未检查读成没有缺陷**，
 * 是本项目最不可接受的假绿。
 *
 * 所以每条小程序规则都有同一个前置：工程里有 `app.json`（或 `project.config.json`）。
 * 找不到就 `NotApplicable`，读数如实写「本轮未检查」。
 *
 * ## 为什么用「向上找最近的 app.json」
 * 小程序把 `app.json` 视为工程根标记，样式与页面注册都按它解析。
 * 分包里的文件离根很远，但往上找一定能找到；找不到说明它不在任何小程序工程里。
 */

import { escapeRe } from './code-only.ts'
import type { RuleCtx } from './rule-guard.ts'

/** 工程根标记（任一存在即认为是小程序工程） */
const ROOT_MARKERS = ['app.json', 'project.config.json']

/** 候选根：`rules.mpX.mpRoots` 可覆盖；默认覆盖三种常见布局（根即工程 / 独立子目录 / src 下） */
function candidateRoots(ctx: RuleCtx): string[] {
  const declared = ctx.options.mpRoots
  if (Array.isArray(declared) && declared.length > 0) {
    return declared.filter((r): r is string => typeof r === 'string')
  }
  return ['', 'miniprogram', 'mp', 'src']
}

function joinRel(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`
}

/** 工程根目录（相对 ctx.root，根即工程时返回 ''）；不是小程序工程返回 null */
export function findMiniProgramRoot(ctx: RuleCtx): string | null {
  for (const dir of candidateRoots(ctx)) {
    for (const marker of ROOT_MARKERS) {
      if (ctx.readFile(joinRel(dir, marker)) !== null) return dir
    }
  }
  return null
}

/**
 * 前置判据：不是小程序工程时返回原因（→ 本轮未检查）。返回 null 表示适用。
 *
 * **返回带 code 的对象**（而不是裸字符串）：八个 mp 规则共用这一个前置，
 * 裸字符串会让它们在棘轮里各记一条 `AQ_NOT_CLASSIFIED` —— 读起来像「八件不同的事各关了一类射程」，
 * 而事实是**一件事**（这不是小程序工程）关掉了八条判据。同一个判定必须给出同一个 code，
 * 否则「同一前提空转了哪些判据」这个最有用的问题在读数上问不出来。
 */
export function requireMiniProgram(ctx: RuleCtx): { code: string; reason: string } | null {
  if (findMiniProgramRoot(ctx) !== null) return null
  const tried = candidateRoots(ctx)
    .flatMap((d) => ROOT_MARKERS.map((m) => joinRel(d, m)))
    .join(', ')
  return {
    code: 'MP_PROJECT_NOT_FOUND',
    reason: `未发现小程序工程标记（试过 ${tried}）：本轮未检查，0 命中≠无缺陷。工程根不在默认位置时用 rules.*.mpRoots 声明`,
  }
}

/** 目录 `dir` 下某文件的相对路径；找不到返回 null */
export function sibling(dir: string, name: string): string {
  return joinRel(dir, name)
}

/**
 * 从 `dir` 起向上找最近的同名文件（小程序按「最近祖先」解析 app.json / app.wxss）。
 * `dir` 为空串或已到根时只试根。
 */
export function findNearestUp(ctx: RuleCtx, dir: string, name: string): string | null {
  let d = dir
  for (;;) {
    const p = joinRel(d, name)
    if (ctx.readFile(p) !== null) return p
    if (d === '') return null
    const cut = d.lastIndexOf('/')
    d = cut < 0 ? '' : d.slice(0, cut)
  }
}

/** 文件 `rel` 所在目录（无目录时返回 ''） */
export function dirOf(rel: string): string {
  const cut = rel.lastIndexOf('/')
  return cut < 0 ? '' : rel.slice(0, cut)
}

/** 去掉扩展名 */
export function stripExt(rel: string): string {
  const cut = rel.lastIndexOf('.')
  return cut <= 0 ? rel : rel.slice(0, cut)
}

/** 相对路径解析（POSIX 语义，`..` 可上溯）；越界时返回 null */
export function resolveRel(baseDir: string, target: string): string | null {
  const segs = baseDir === '' ? [] : baseDir.split('/')
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (segs.length === 0) return null
      segs.pop()
      continue
    }
    segs.push(part)
  }
  return segs.join('/')
}

/**
 * 宽松 JSON 解析：小程序配置里偶有尾逗号与注释（不同版本工具链宽容度不一）。
 * 解析失败返回 null —— 调用方据此**不报**：读不懂配置不等于配置错了。
 */
export function parseJsonLoose(text: string): unknown {
  const cleaned = text
    .replace(/^\uFEFF/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1')
  try {
    return JSON.parse(cleaned)
  } catch {
    return null
  }
}

/** 按点路径取值，任一段不是对象就返回 undefined */
export function pick(root: unknown, ...keys: string[]): unknown {
  let cur = root
  for (const key of keys) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/** 目录名是否是构建产物（不该被判据当源码） */
export function isGeneratedDir(rel: string): boolean {
  return /(^|\/)(miniprogram_npm|node_modules|dist|build)\//.test(rel)
}

/** 是否是小程序源码文件（扩展名 + 非构建产物） */
export function isMpSource(rel: string, re: RegExp): boolean {
  if (!re.test(rel)) return false
  return !isGeneratedDir(rel)
}

/* ─────────────────────────── app.json 路由事实 ───────────────────────────
 *
 * `app.json` 是**唯一**的路由真相源：页面在不在注册表里、某个页是不是 tabBar 页，
 * 都只能从这一份文件读出。判据各写一套解析的结果是：今天 MP005 认 subPackages、
 * 明天 MP006 不认，两份读数对不上。
 */

/** 路径规范化：去前导斜杠、去 query/hash、去脚本扩展名 */
export function normalizeMpPath(raw: string): string {
  return raw
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/^\/+/, '')
    .replace(/\.(?:js|ts|html)$/, '')
}

export interface AppJsonRoutes {
  /** `pages` + `subPackages[].root+pages` + `tabBar.list[].pagePath` 的并集 */
  all: Set<string>
  /** `tabBar.list[].pagePath`：这些页**只能**用 switchTab / reLaunch 打开 */
  tabs: Set<string>
}

/** 解析 `app.json` 的路由事实；文本读不懂返回 null（读不懂配置不等于配置错了） */
export function appJsonRoutes(text: string): AppJsonRoutes | null {
  const cfg = parseJsonLoose(text)
  if (cfg === null || typeof cfg !== 'object') return null
  const all = new Set<string>()
  const tabs = new Set<string>()

  const pages = pick(cfg, 'pages')
  if (Array.isArray(pages)) {
    for (const p of pages) if (typeof p === 'string') all.add(normalizeMpPath(p))
  }
  for (const key of ['subPackages', 'subpackages']) {
    const packs = pick(cfg, key)
    if (!Array.isArray(packs)) continue
    for (const pack of packs) {
      if (pack === null || typeof pack !== 'object') continue
      const root = pick(pack, 'root')
      const subPages = pick(pack, 'pages')
      if (typeof root !== 'string' || !Array.isArray(subPages)) continue
      for (const p of subPages) {
        if (typeof p === 'string') all.add(normalizeMpPath(`${root}/${p}`))
      }
    }
  }
  const tabList = pick(cfg, 'tabBar', 'list')
  if (Array.isArray(tabList)) {
    for (const item of tabList) {
      const p = pick(item, 'pagePath')
      if (typeof p !== 'string') continue
      const norm = normalizeMpPath(p)
      all.add(norm)
      tabs.add(norm)
    }
  }
  return { all, tabs }
}

/* ─────────────────────────── 实例别名（`const that = this`） ───────────────────────────
 *
 * 小程序里这是**主流写法**，不是边角：ES5 风格、`wx.request` 回调、从老代码迁过来的页面
 * 几乎都先写 `const that = this`，再用 `that.setData`。
 *
 * 只认字面 `this` 的判据在这类页面上会**全绿**——实测过（外部试点仓探针：
 * `that.setData` 一条不报，同一份代码改成 `this.setData` 立刻报）。这属于伪阴性：
 * 判据没有说「没检查」，它说「检查了，没问题」。
 *
 * 所以「认 `this` 的所有判据」都必须走这里，而不是各自写 `\\bthis\\s*\\.`：
 * **同一个事实（这处写的是页面实例）在两个判据里必须是同一个定义**，
 * 否则今天 mp01 认得、明天 mp03 认不得，读数是分叉的。
 */

/** 收集文件里声明为 `this` 的别名（去重，保持出现顺序）；按整文件收集，声明常在回调外层 */
export function selfAliasesOf(code: string): string[] {
  const out = new Set<string>()
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*this\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) out.add(m[1])
  return [...out]
}

/** `this` 及其别名的正则片段；无别名时就是 `this` */
export function selfExpr(aliases: string[]): string {
  return ['this', ...aliases].map(escapeRe).join('|')
}

/**
 * `this.setData(` / `that.setData(`（第 1 组是**接收者**，第 2 组是方法名）。
 * `$setData` / `safeSetData` 都不匹配——托管写口名字一变就出射程，这是要的。
 * `global` 用于需要遍历全部命中位置的判据（如按偏移判语句归属）。
 */
export function selfWriteRe(aliases: string[], global = false): RegExp {
  return new RegExp(`\\b(${selfExpr(aliases)})\\s*\\.\\s*(?!\\$)(setData)\\s*\\(`, global ? 'g' : '')
}

/**
 * 回调内的存活短路：`if (!this.alive) return` / `if (!that[ALIVE]) { return }`。
 * 别名一并认——否则「别名 + 正确存活判定」的写法会被判成违规，那是把修好的代码判红。
 */
export function aliveShortCircuitRe(aliases: string[]): RegExp {
  return new RegExp(
    `\\bif\\s*\\(\\s*!\\s*(?:${selfExpr(aliases)})\\s*(?:\\.\\s*[\\w$]+|\\[[^\\]]*\\])\\s*\\)\\s*\\{?\\s*return\\b`,
  )
}

