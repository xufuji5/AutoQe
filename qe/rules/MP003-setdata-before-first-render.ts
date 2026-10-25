/**
 * MP003 · `attached` / `created` 里同步写视图（首渲染前 setData）
 *
 * ## 真实事故形态
 * 自定义组件的 `attached` 生命周期在**首渲染之前**执行。在那里同步 `setData`，
 * 视图层还没准备好接收更新，宿主会抛：
 *
 *   webviewScriptError: Expected updated data but get first rendering data
 *
 * 它在真机上是**必现**的，在 DevTools 上却常被吞掉（只在某些基础库版本打印），
 * 于是它活到线上：表现为组件首屏字段恒为初始值、或干脆整块白掉。
 *
 * 高发位置是自定义 tabBar：有三处来源（页面 onShow、组件 attached、全局状态回调）
 * 各自调一次 `setData`，其中 attached 那一路就是把错误打进控制台的那一路。
 *
 * ## 判据
 * 1. 只在 `Component(` **或 `Behavior(`** 文件里判（`Page` 的 `onLoad` 之后才首渲染，不在此列）；
 * 2. 找成员 `attached` / `created`（含 `lifetimes: { … }` 里的写法），取出函数体；
 * 3. 体内**同一语句内**出现 `this.setData(`，且这段文字里没有 `=>` / `function`
 *    （即它不是某个回调的参数）→ 报。
 *
 * ## 为什么 `Behavior(` 也必须在射程内
 * Behavior 顶层可以直接写 `created` / `attached`，宿主会把它**并入组件生命周期**，
 * 执行时序与组件自己写的那个完全相同——同样在首渲染之前。漏掉 Behavior 文件，
 * 等于「把缺陷挪进 behavior 就查不到了」，而 behaviors 恰恰是把公共逻辑抽出去的常规做法。
 * （组件 `methods` 里被 behavior 调用的方法仍不判：那是运行时调用关系，静态看不见。）
 *
 * ## 第 3 条的取舍
 * 「同一语句内没有回调标记」是「直接调用」的语法近似。它放过 `wx.nextTick(() => this.setData(…))`
 * 与 `then(() => this.setData(…))`——那两类本来就是**正确**写法（延后到首渲染之后）。
 * 换来的盲区是：`if (x) this.setData(…)` 这类**该报**的写法在 `x` 里带箭头函数时会被放过
 * （`if (list.some(i => i.ok)) this.setData(…)`）。方向是「少报」，不会误红。
 *
 * ## 为什么不用「深度 0」
 * 深度 0 会把 `if (x) { this.setData(…) }` 判成「不在直接位置」——块不是函数，
 * 那里同步执行，照样炸。深度分不出「块」与「函数体」，语句边界才分得出。
 */

import { bodyAfterParen, maskRegexBodies, maskStringBodies, matchDelimiter, stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { isMpSource, requireMiniProgram, selfAliasesOf, selfWriteRe } from '../lib/mp-project.ts'

const CTOR_RE = /\b(?:Component|Behavior)\s*\(\s*\{/
/** 成员位置的生命周期键：排除 `this.attached(` 与被调用的同名函数 */
const LIFECYCLE_RE = /(?<![\w$.])(attached|created)\b/g

/** 从生命周期键之后取出函数体；形态认不出返回 null（→ 不报） */
export function lifecycleBody(code: string, keyEnd: number): string | null {
  let j = keyEnd
  const skipWs = () => {
    while (j < code.length && /\s/.test(code[j])) j++
  }
  skipWs()
  if (code[j] === ':') {
    j++
    skipWs()
  }
  if (code.startsWith('function', j)) {
    j += 8
    skipWs()
  }
  // 具名函数表达式：`function _ready(...)`
  if (j < code.length && /[\w$]/.test(code[j])) {
    while (j < code.length && /[\w$]/.test(code[j])) j++
    skipWs()
  }
  if (code[j] !== '(') return null
  const close = matchDelimiter(code, j)
  if (close < 0) return null
  return bodyAfterParen(code, close + 1)
}

/**
 * 体内「同一语句内、且不在回调参数里」的写视图偏移量。
 * 语句边界按花括号深度 0 处的 `;` 与 `}` 判定。
 *
 * 写视图的接收者不一定是字面 `this`：`attached() { const that = this; that.setData(…) }`
 * 在老代码里很常见。别名由 `selfWriteRe` 单源给出——**同一个事实不在两个判据里写两遍**。
 */
export function directSetDataAt(body: string, aliases: string[] = []): number[] {
  const out: number[] = []
  /** 写视图起点 → 命中长度（预扫一遍：别在字符循环里再跑正则） */
  const writeAt = new Map<number, number>()
  const scan = selfWriteRe(aliases, true)
  let w: RegExpExecArray | null
  while ((w = scan.exec(body)) !== null) writeAt.set(w.index, w[0].length)
  if (writeAt.size === 0) return out

  let depth = 0
  let stmtStart = 0
  let i = 0
  while (i < body.length) {
    const c = body[i]
    if (c === '{') {
      depth++
      i++
      continue
    }
    if (c === '}') {
      depth = Math.max(0, depth - 1)
      if (depth === 0) stmtStart = i + 1
      i++
      continue
    }
    if (c === ';' && depth === 0) {
      stmtStart = i + 1
      i++
      continue
    }
    const len = writeAt.get(i)
    if (len !== undefined) {
      const segment = body.slice(stmtStart, i)
      if (!/=>|\bfunction\b/.test(segment)) out.push(i)
      i += len
      continue
    }
    i++
  }
  return out
}

export const mp03 = toGuard({
  id: 'mp03',
  title: 'attached / created 里同步 setData',
  invariants: ['INV-MP-03'],
  code: 'MP003_SETDATA_BEFORE_FIRST_RENDER',
  blindSpots: [
    '只认 `this.setData(` 与 `const that = this` 这类别名；托管写口（`this.$setData`）不在射程——托管层有没有延后到 ready，本判据看不见',
    '别名只认 `const/let/var X = this`；参数传入的实例、`const that = (this)` 不认',
    '`if (cond) this.setData(…)` 里 cond 含箭头函数时会被放过（语句内的回调近似判据把 `=>` 当作「非直接」）',
    '`Behavior(` 文件自身的 `created` / `attached` 已在射程；但「组件 `methods` 里的方法被 behavior 调用」这种运行时调用关系不判（静态看不见）',
    '`Page` 的 `onLoad`/`onReady` 不判（页面首渲染时序与组件不同，混在一起会把正确的写法判红）',
    '`attached` 里 await 之后才 setData 的写法不判：异步恢复点算不算首渲染前，静态不可知',
  ],
  impact:
    '首渲染前 setData：视图层尚未准备好接收更新，宿主抛 `webviewScriptError: Expected updated data but get first rendering data`，真机必现、DevTools 常被吞',
  provenance:
    '试点 B（2026-10）：自定义 tabBar 的三个 setData 来源之一在 attached 里，真机首屏报 Expected updated data but get first rendering data',
  applies(rel) {
    return isMpSource(rel, /\.(?:js|ts)$/)
  },
  notApplicable(ctx: RuleCtx) {
    return requireMiniProgram(ctx)
  },
  analyze(src): RawHit[] {
    const code = maskRegexBodies(maskStringBodies(stripComments(src)))
    if (!CTOR_RE.test(code)) return []
    const aliases = selfAliasesOf(code)
    const hits: RawHit[] = []
    let m: RegExpExecArray | null
    LIFECYCLE_RE.lastIndex = 0
    while ((m = LIFECYCLE_RE.exec(code)) !== null) {
      const key = m[1]
      const body = lifecycleBody(code, m.index + m[0].length)
      if (body === null) continue
      for (const at of directSetDataAt(body, aliases)) {
        // 体内偏移 → 源码偏移：找出 body 在 code 中的起点
        const bodyStart = code.indexOf(body, m.index)
        const srcAt = bodyStart < 0 ? m.index : bodyStart + at
        hits.push({
          line: lineOf(src, srcAt),
          message:
            key === 'attached'
              ? '`attached` 里同步 setData：此时首渲染尚未完成，宿主报 `webviewScriptError: Expected updated data but get first rendering data`；应挪到 `ready`，或用 wx.nextTick 延后'
              : '`created` 里同步 setData：该阶段数据尚未注入视图层，setData 不生效（部分基础库直接报错）；应挪到 attached 之后的 ready',
          evidence: evidenceOf(src, srcAt),
        })
      }
    }
    return hits
  },
  fixtures: [
    {
      name: 'attached 里直接 setData（该报）',
      expect: 'red',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'components/tip/tip.js': `Component({
  attached() {
    this.setData({ ready: true })
  },
})
`,
      },
    },
    {
      name: 'lifetimes.attached 里直接 setData（该报）',
      expect: 'red',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'components/tip/tip.js': `Component({
  lifetimes: {
    attached() {
      this.setData({ ready: true })
    },
  },
})
`,
      },
    },
    {
      name: 'created 里直接 setData（该报）',
      expect: 'red',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'components/tip/tip.js': `Component({
  created: function () {
    this.setData({ ready: true })
  },
})
`,
      },
    },
    {
      name: 'if 块里的 setData 仍是同步（该报）',
      expect: 'red',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'components/tip/tip.js': `Component({
  attached() {
    if (this.data.mode === 'x') { this.setData({ ready: true }) }
  },
})
`,
      },
    },
    {
      name: '用 wx.nextTick 延后到首渲染后（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'components/tip/tip.js': `Component({
  attached() {
    wx.nextTick(() => { this.setData({ ready: true }) })
  },
})
`,
      },
    },
    {
      name: 'attached 只调方法，不直接写视图（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'components/tip/tip.js': `Component({
  attached() {
    this.load()
  },
  load() {
    this.setData({ ready: true })
  },
})
`,
      },
    },
    {
      name: '页面 onLoad 里 setData 是正确时序（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  onLoad() {
    this.setData({ ready: true })
  },
})
`,
      },
    },
    {
      name: '走托管写口（本判据不猜它有没有延后，不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'components/tip/tip.js': `Component({
  attached() {
    this.$setData({ ready: true })
  },
})
`,
      },
    },
    {
      name: 'attached 里用 `const that = this` 别名写视图（该报）',
      expect: 'red',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'components/tip/tip.js': `Component({
  attached() {
    var that = this
    that.setData({ ready: true })
  },
})
`,
      },
    },
    {
      name: 'attached 里别名 + 延后到首渲染后（正确写法，不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'components/tip/tip.js': `Component({
  attached() {
    const that = this
    wx.nextTick(() => that.setData({ ready: true }))
  },
})
`,
      },
    },
    {
      name: 'Behavior 顶层的 attached 里 setData（并入组件生命周期，该报）',
      expect: 'red',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'behaviors/track.js': `module.exports = Behavior({
  attached() {
    this.setData({ tracked: true })
  },
})
`,
      },
    },
    {
      name: 'Behavior 里只有 methods，没有生命周期（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'behaviors/track.js': `module.exports = Behavior({
  methods: {
    ping() { this.setData({ ok: true }) },
  },
})
`,
      },
    },
    {
      name: 'attached 里的异步回调写视图（不是同步，不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'components/tip/tip.js': `Component({
  attached() {
    this.load().then(() => this.setData({ ready: true }))
  },
})
`,
      },
    },
  ],
})
