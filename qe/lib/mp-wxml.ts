/**
 * wxml / wxss 静态解析（小程序专属）
 *
 * 为什么单独一层：MP002（全局类被隔离掉）、MP008（类名谁都没定义）问的是**同一份事实**
 * ——「这个组件里，某个类名到底能不能拿到样式」。两边各写一份 class 解析，必然在
 * 「`{{}}` 动态值跳不跳」「`@import` 跟几层」上分叉，然后两份读数对不上账。
 *
 * 解析原则：
 * - 只读**静态**写出的类名：`class="a {{b}}"` 整条跳过，不猜运行时值；
 * - 去注释但**保留字符串**：路径、字体名在引号里，抹掉会让 `url()` 解析错位；
 * - wxss 的类必须跟 `@import` 链：真实工程把全局样式拆成多个文件，
 *   只读本体得到的往往是**空集**——判据安静返回 0 命中，那不是没问题，是没看见。
 */

import { escapeRe, maskStringBodies } from './code-only.ts'
import { dirOf, parseJsonLoose, pick, resolveRel } from './mp-project.ts'
import type { RuleCtx } from './rule-guard.ts'

/**
 * 类选择器：**只在选择器位置上取**，不是全文扫。
 *
 * 为什么要分位置：`.corner.new { }` 这类复合选择器里的 `new` 也是被定义的类，
 * 而「按边界字符判断」根本取不到它（`.new` 前面是字母 `r`）——实测踩过：
 * 一个仓把修饰类全写成 `.corner.new` / `.nav-btn.pressed`，判据把 7 个**有样式**的类
 * 报成「谁都没定义」，纯误报。
 *
 * 反过来，全文扫又会把 `url(a.png)` 里的 `.png`、`@import "x.wxss"` 里的 `.wxss`
 * 当成类名。前者靠「只取选择器段」排除，后者靠掩掉字符串排除——
 * 两件事一起做，才既不漏也不误报。
 */
const CLASS_SEL_RE = /\.([_a-zA-Z][-\w]*)/g
const CLASS_ATTR_RE = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const IMPORT_RE = /@import\s+(?:url\()?\s*(?:"([^"]+)"|'([^']+)')/g
const ISOLATION_JS_RE = /\bstyleIsolation\s*:\s*['"]([\w-]+)['"]/
const ADD_GLOBAL_JS_RE = /\baddGlobalClass\s*:\s*true\b/
const EXTERNAL_JS_RE = /\bexternalClasses\s*:\s*\[([^\]]*)\]/

/** 去注释但**保留字符串**（引号内容原样留下） */
export function stripWxComments(text: string): string {
  let out = ''
  let i = 0
  let quote = ''
  while (i < text.length) {
    const c = text[i]
    if (quote !== '') {
      out += c
      if (c === quote) quote = ''
      i += 1
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      out += c
      i += 1
      continue
    }
    if (c === '<' && text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4)
      const stop = end < 0 ? text.length : end + 3
      out += text.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? text.length : end + 2
      out += text.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
      continue
    }
    out += c
    i += 1
  }
  return out
}

/**
 * wxss 里定义的类名。
 *
 * 切分方式：以 `{` / `}` 为界，取每个 `{` 之前的**选择器段**。
 * 这样 `@media { .a { } }` 这种嵌套里的 `.a` 也能取到（不跳过整个块），
 * 而声明体（`background: url(a.png)`）永远不在选择器段里。
 */
export function wxssClasses(css: string): Set<string> {
  const out = new Set<string>()
  // 掩掉字符串：`@import "x.wxss"` 的扩展名不是类名（长度保留，偏移不变）
  const text = maskStringBodies(stripWxComments(css))
  let segStart = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c !== '{' && c !== '}') continue
    if (c === '{') {
      const selector = text.slice(segStart, i)
      let m: RegExpExecArray | null
      CLASS_SEL_RE.lastIndex = 0
      while ((m = CLASS_SEL_RE.exec(selector)) !== null) out.add(m[1])
    }
    segStart = i + 1
  }
  return out
}

/** wxml 里静态写出的类名 → 首次出现位置（`{{}}` 里的整条跳过） */
export function wxmlStaticClasses(wxml: string): Map<string, number> {
  const out = new Map<string, number>()
  const text = stripWxComments(wxml)
  let m: RegExpExecArray | null
  CLASS_ATTR_RE.lastIndex = 0
  while ((m = CLASS_ATTR_RE.exec(text)) !== null) {
    const value = m[1] ?? m[2] ?? ''
    if (value.includes('{{')) continue
    const at = m.index
    for (const token of value.split(/\s+/)) {
      if (token === '') continue
      if (!out.has(token)) out.set(token, at)
    }
  }
  return out
}

/** 某个 wxss 及其 `@import` 链上定义的全部类（深度 3、带环保护） */
export function classesWithImports(
  ctx: RuleCtx,
  wxssPath: string,
  seen = new Set<string>(),
  depth = 0,
): Set<string> {
  const out = new Set<string>()
  if (depth > 3 || seen.has(wxssPath)) return out
  seen.add(wxssPath)
  const css = ctx.readFile(wxssPath)
  if (css === null) return out
  for (const c of wxssClasses(css)) out.add(c)
  const text = stripWxComments(css)
  let m: RegExpExecArray | null
  IMPORT_RE.lastIndex = 0
  while ((m = IMPORT_RE.exec(text)) !== null) {
    const target = m[1] ?? m[2] ?? ''
    if (target === '' || /^(https?:)?\/\//.test(target)) continue
    const resolved = resolveRel(dirOf(wxssPath), target)
    if (resolved === null) continue
    for (const c of classesWithImports(ctx, resolved, seen, depth + 1)) out.add(c)
  }
  return out
}

/**
 * 组件是否声明了「全局样式可以进来」。
 *
 * `jsStripped` 必须是**只剥注释、没抹字符串**的原文：`styleIsolation: 'shared'` 的取值
 * 就在字符串里，抹过字符串的代码面上只剩空白，正则永远匹配不到——那会把「已声明共享」
 * 判成「没声明」，也就是把合法的写法判红。
 */
export function globalStylesApply(ctx: RuleCtx, base: string, jsStripped: string): boolean {
  const json = ctx.readFile(`${base}.json`)
  if (json !== null) {
    const cfg = parseJsonLoose(json)
    if (cfg !== null) {
      const iso = pick(cfg, 'styleIsolation')
      if (iso === 'shared' || iso === 'apply-shared') return true
      if (pick(cfg, 'addGlobalClass') === true) return true
      const compIso = pick(cfg, 'component', 'styleIsolation')
      if (compIso === 'shared' || compIso === 'apply-shared') return true
    }
  }
  const iso = ISOLATION_JS_RE.exec(jsStripped)
  if (iso && (iso[1] === 'shared' || iso[1] === 'apply-shared')) return true
  return ADD_GLOBAL_JS_RE.test(jsStripped)
}

/** 父组件传入的样式入口（同样必须读未抹字符串的原文：类名就在字符串里） */
export function externalClassesOf(ctx: RuleCtx, base: string, jsStripped: string): Set<string> {
  const out = new Set<string>()
  const json = ctx.readFile(`${base}.json`)
  if (json !== null) {
    const cfg = parseJsonLoose(json)
    const list = pick(cfg, 'externalClasses')
    if (Array.isArray(list)) for (const item of list) if (typeof item === 'string') out.add(item)
  }
  const m = EXTERNAL_JS_RE.exec(jsStripped)
  if (m) {
    const re = /['"]([^'"]+)['"]/g
    let q: RegExpExecArray | null
    while ((q = re.exec(m[1])) !== null) out.add(q[1])
  }
  return out
}

/**
 * JS 里是否提到过某个类名——决定「这个类名是不是 JS 的查询锚点」。
 *
 * 组件 wxml 上的类名可以是纯语义占位：`this.createSelectorQuery().select('.card')`
 * 量高度、自动化测试按类名定位。这类类名没有样式是**设计如此**，不是缺陷。
 * 判据必须先排除它们，否则会把「有意的空类」全判成 bug。
 */
export function jsMentionsClass(jsStripped: string, name: string): boolean {
  if (name.length < 2) return true
  return new RegExp(`[.\\w-]${escapeRe(name)}\\b`).test(jsStripped) || jsStripped.includes(`'${name}'`) || jsStripped.includes(`"${name}"`)
}
