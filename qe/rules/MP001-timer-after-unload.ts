/**
 * MP001 · 定时器回调在页面销毁后继续写视图
 *
 * ## 真实事故形态
 * 线上一类崩溃的长相（栈底是指纹）：
 *
 *   TypeError: Cannot read property '__subPageFrameEndTime__' of null
 *     at <anonymous>
 *     at <setInterval callback function>
 *
 * `__subPageFrameEndTime__` 是宿主记在**页面帧**上的内部字段。页面已被 `onUnload` 销毁、
 * 帧记录置 null 之后，仍有一段业务回调在跑并 `setData`，宿主去查这一帧就拿到 null。
 * **报错发生在框架里，成因在业务代码。**
 *
 * 最扎人的地方：出事那批定时器**全都写了 `clearInterval`**。
 * `clearInterval` 只能取消**尚未触发**的后续轮次；已经进入 JS 事件队列的那一次回调照跑，
 * 而它完全可能排在 `onUnload` 之后（用户点返回、或 `redirectTo` 跳走时的同一个 tick）。
 * 所以「清了」不等于「不跑了」——只挂卸载清理，等于给一件必错的事加了道无用的门。
 *
 * ## 判据（不靠命名约定，只看回调能不能跑完）
 * 1. 只在含 `Page(` / `Component(` / `Behavior(` 的文件里判：只有那里的 `this` 才是页面/组件实例；
 * 2. 找**裸**的 `setInterval(` / `setTimeout(`。`x.setInterval(` 这类托管包装不在射程——
 *    它的存活判定在包装内部，本判据看不见，也不需要看；
 * 3. 取第一个实参当回调；是具名引用就回溯一次它的声明体
 *    （`const tick = () => {…}` / `function tick() {…}`）；
 * 4. 回调体里出现 `this.setData(`（**含别名** `that.setData(`，见下）或
 *    `wx.navigateBack/redirectTo/reLaunch/switchTab(` → 这一轮在页面销毁后会真的产生副作用，报；
 * 5. 回调体里先做了存活短路（`if (!this.<flag>) return` / `if (!that.<flag>) return`）→ 不报。
 *
 * ## 为什么要认 `const that = this` 这个别名
 * 小程序里这是**主流写法**，不是边角：ES5 风格、`wx.request` 回调、老代码迁移过来的页面
 * 几乎都先写 `const that = this` 再用 `that.setData`。只认字面 `this` 时，这些页面的定时器
 * 写视图**一条都不报**——实测过（外部试点仓探针：`that.setData` 全绿）。
 * 别名在**整文件**范围收集，因为声明通常在定时器外层；
 * 存活短路也一并认别名，否则「别名 + 正确存活判定」的写法会被误报成红。
 *
 * ## 为什么除别名外不再放宽
 * 项目一旦引入托管写口（`this.$setData`、`this.safeSetData`…）名字就变了，正则自然不再命中——
 * 这正是要的：本判据的射程是「**没有任何存活判定的裸写法**」，不是「所有写视图的地方」。
 * 反过来，谁把托管写口改回裸 `this.setData`，立刻回到射程内。
 * 同理不猜 `this.render()` 这类自定义写视图函数：名字不可枚举，猜就变成误报机器。
 *
 * ## 与「清没清」的区别（本判据存在的理由）
 * 静态 grep 「有没有 clearInterval」在这个形态上是**恒绿**的：出事的代码全都清了。
 * 判据必须问「已在队列里的那一轮回调，页面死了它还跑不跑」。
 */

import { argSpanAt, maskRegexBodies, maskStringBodies, resolveCallbackBody, stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { aliveShortCircuitRe, isMpSource, requireMiniProgram, selfAliasesOf, selfWriteRe } from '../lib/mp-project.ts'

const CTOR_RE = /\b(?:Page|Component|Behavior)\s*\(\s*\{/
const TIMER_RE = /(?<![\w$.])(setInterval|setTimeout)\s*\(/g
const NAV_RE = /\bwx\s*\.\s*(navigateBack|redirectTo|reLaunch|switchTab)\s*\(/

export const mp01 = toGuard({
  id: 'mp01',
  title: '定时器回调在页面销毁后继续写视图',
  invariants: ['INV-MP-01'],
  code: 'MP001_TIMER_NO_ALIVE_CHECK',
  blindSpots: [
    '回调是具名引用且声明形态认不出（高阶函数包装、`useCallback(() => …)`、外部导入的函数）时不判——看不清就不报',
    '普通对象 mixin（`Object.assign(PageOptions, mixin)`）不在射程：它与工具模块按语法不可区分',
    '`setData` 之外的自定义写视图函数（`this.render()`、`this.refreshView()`）不在射程：判据不猜名字',
    '别名只认 `const/let/var X = this` 这一形态；`const that = (this)`、`const that = args.ctx`、参数传入的实例不认',
    '别名按整文件收集、不追踪后续赋值：同一文件里 `that` 若先 `= this` 后又被赋成别的对象，该处可能多报一条',
    '只认单层存活短路 `if (!this.flag) return`；`if (this.dead === true) return`、`if (!isAlive(this)) return` 这类写法会漏',
    '短延时（0~50ms）在「不可能卸载」的路径上也会被报：本判据不判断重叠概率，只看有没有存活判定',
    '不验证 `onUnload` 里到底有没有清定时器（清了也不影响结论，见文件头）',
  ],
  impact:
    '`clearInterval` 挡不住已入队的那一轮回调：页面销毁后仍会 setData，宿主查不到页面帧（典型表现是 `__subPageFrameEndTime__` of null）；导航类调用还会把用户从别的页面拽走',
  provenance:
    '试点 B（2026-10）：线上崩溃栈 `__subPageFrameEndTime__` of null / `<setInterval callback function>`，定位到 5 处定时器——全部写了 clearInterval，无一处做回调内存活判定',
  applies(rel) {
    return isMpSource(rel, /\.(?:js|ts|jsx|tsx|mjs)$/)
  },
  notApplicable(ctx: RuleCtx) {
    return requireMiniProgram(ctx)
  },
  analyze(src, _rel): RawHit[] {
    const code = maskRegexBodies(maskStringBodies(stripComments(src)))
    if (!CTOR_RE.test(code)) return []
    /** 别名按**整文件**收集：`const that = this` 常声明在回调外层、定时器上方 */
    const aliases = selfAliasesOf(code)
    const writeRe = selfWriteRe(aliases)
    const aliveRe = aliveShortCircuitRe(aliases)
    const hits: RawHit[] = []
    let m: RegExpExecArray | null
    TIMER_RE.lastIndex = 0
    while ((m = TIMER_RE.exec(code)) !== null) {
      const kind = m[1]
      const open = m.index + m[0].length - 1
      const arg = argSpanAt(code, open, 0)
      if (arg === null) continue
      const body = resolveCallbackBody(code, arg)
      if (body === null) continue
      const write = writeRe.exec(body)
      const nav = NAV_RE.exec(body)
      if (!write && !nav) continue
      if (aliveRe.test(body)) continue
      const recv = write?.[1] ?? 'this'
      const what = write
        ? `回调写 ${recv}.setData`
        : `回调调用 wx.${nav?.[1] ?? 'navigateTo'}`
      hits.push({
        line: lineOf(src, m.index),
        message:
          `${kind} 的${what}，但回调里没有存活判定：页面 onUnload 之后已入队的那一轮仍会执行` +
          (write ? '（宿主拿到 null 页面帧，典型报错 `__subPageFrameEndTime__` of null）' : '（用户可能在别的页面被拽走）') +
          '；clearInterval 只能挡住后续轮次',
        evidence: evidenceOf(src, m.index),
      })
    }
    return hits
  },
  fixtures: [
    {
      name: '清了定时器但回调写视图（本事故原型，该报）',
      expect: 'red',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  onLoad() {
    this.timer = setInterval(() => {
      this.setData({ now: Date.now() })
    }, 1000)
  },
  onUnload() {
    clearInterval(this.timer)
  },
})
`,
      },
    },
    {
      name: '延时自动返回（页面已销毁仍在导航，该报）',
      expect: 'red',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  submit() {
    wx.showToast({ title: '已提交' })
    setTimeout(() => { wx.navigateBack() }, 1500)
  },
})
`,
      },
    },
    {
      name: '回调是具名引用，回溯到声明体后判出（该报）',
      expect: 'red',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  onShow() {
    const tick = () => { this.setData({ n: this.data.n + 1 }) }
    this.timer = setInterval(tick, 1000)
  },
})
`,
      },
    },
    {
      name: '组件（Component）同样在射程（该报）',
      expect: 'red',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'components/tip/tip.js': `Component({
  ready() {
    this.timer = setTimeout(() => { this.setData({ show: false }) }, 3000)
  },
})
`,
      },
    },
    {
      name: '`const that = this` 别名写视图（小程序主流写法，该报）',
      expect: 'red',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  onLoad() {
    var that = this
    this.timer = setInterval(function () {
      that.setData({ now: Date.now() })
    }, 1000)
  },
  onUnload() {
    clearInterval(this.timer)
  },
})
`,
      },
    },
    {
      name: '别名 + 存活短路（正确写法，不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  onLoad() {
    const that = this
    that.alive = true
    this.timer = setInterval(() => {
      if (!that.alive) return
      that.setData({ now: Date.now() })
    }, 1000)
  },
  onUnload() {
    this.alive = false
    clearInterval(this.timer)
  },
})
`,
      },
    },
    {
      name: '别名只改实例字段，不碰视图（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  onLoad() {
    const self = this
    this.timer = setInterval(() => { self.ticks += 1 }, 1000)
  },
})
`,
      },
    },
    {
      name: '走托管定时器与托管写口（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  onLoad() {
    this.timer = this.$setInterval(() => {
      this.$setData({ now: Date.now() })
    }, 1000)
  },
})
`,
      },
    },
    {
      name: '回调只改实例字段，不碰视图（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  onLoad() {
    this.timer = setInterval(() => { this.ticks += 1 }, 1000)
  },
})
`,
      },
    },
    {
      name: '回调里先做存活短路（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  onLoad() {
    this.alive = true
    this.timer = setInterval(() => {
      if (!this.alive) return
      this.setData({ n: 1 })
    }, 1000)
  },
  onUnload() {
    this.alive = false
    clearInterval(this.timer)
  },
})
`,
      },
    },
    {
      name: 'setData 在 onLoad 里（不在定时器回调内，不该报）',
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
      name: '工具模块（无页面构造体）不在射程（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'utils/poll.js': `module.exports = {
  start() {
    setInterval(() => { this.setData({ n: 1 }) }, 1000)
  },
}
`,
        'pages/demo/demo.js': `Page({ onLoad() {} })
`,
      },
    },
    {
      name: '构建产物目录不在射程（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'miniprogram_npm/dep/index.js': `Page({ onLoad() { setInterval(() => this.setData({}), 1000) } })
`,
        'pages/demo/demo.js': `Page({ onLoad() {} })
`,
      },
    },
  ],
})
