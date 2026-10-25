/**
 * MP007 · 异步边界之后写视图，没有存活判定
 *
 * ## 真实事故形态
 * 页面发起一次网络请求，用户等不及点了返回（弱网下这是常态）。请求 3 秒后才回来，
 * 回调里那句 `this.setData({ list })` 照常执行 —— 它拿到的是一个已经销毁的页面实例：
 *
 *   - 轻则控制台一条 `setData 渲染层未找到` / `__subPageFrameEndTime__` of null；
 *   - 重则在 `success` 里继续 `wx.navigateTo`，把用户从**别的页面**拽走。
 *
 * 与 MP001（定时器）是**同一个病根的两个出口**：都有一段时间差，都在差里假设对象还活着。
 * 区别只在「谁在等」——定时器等的是时钟，这里等的是 I/O 或 Promise。
 *
 * ## 判据
 * 1. 圈出**异步边界区域**（三类）：
 *    - `wx.<api>({ … })` 的选项对象整体：里面能写语句的地方只可能是 success/fail/complete 之类的回调，
 *      所以「对象里出现写视图」就等价于「回调里写视图」；
 *    - `.then( … )` / `.catch( … )` / `.finally( … )` 的内联回调体；
 *    - 含 `await` 的 `async` 函数体（恢复点之后的一切都在「页面可能已销毁」的时段里）。
 * 2. 区域内出现写视图（`this.setData` 及其别名）→ 候选；
 * 3. 区域内有存活短路（`if (!this.alive) return`，含别名）→ 放过；
 * 4. 同一个区域只报一次（报**第一处**写视图，避免一个回调刷十条）。
 *
 * ## 为什么级别是 warn 而不是 error
 * 「异步回来时页面还在不在」静态不可知：同一个写法，在停留 10 秒的列表页里几乎不出事，
 * 在 0.5 秒就返回的确认页里必出事。判据能确定的是「这里没有判定」，不能确定「这次会炸」。
 * 报成 error 会把大量正确代码判红，那是把判据变成噪音源；warn 的语义是「值得看一眼」。
 *
 * ## 为什么不按 API 白名单收窄
 * 白名单会腐化（新增 I/O API 就漏），而且漏的正好是新的高频 API。
 * 这里按**结构**判（有没有异步边界、有没有存活判定），不按名字判。
 */

import { maskRegexBodies, maskStringBodies, matchDelimiter, stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { aliveShortCircuitRe, isMpSource, requireMiniProgram, selfAliasesOf, selfWriteRe } from '../lib/mp-project.ts'

const CTOR_RE = /\b(?:Page|Component|Behavior)\s*\(\s*\{/

/**
 * 构造函数被高阶函数包裹的写法：`Page(guardPage({ … }))` / `Component(guardComponent({ … }))`。
 *
 * ## 为什么必须单独认（2026-10 试点 B 实测的假绿）
 *
 * 上一条正则只认 `Page({`，于是「页面被生命周期守卫包装」这一形态**整文件不被分析**：
 * 同一个文件、同一段 `request().then(() => this.setData(...))`，注册形式从 `Page({`
 * 改成 `Page(guardPage({`，读数就从 `1 warning` 变成 `green`。这不是缺陷被修掉了，
 * 是判据看不见它了 —— 而「看不见」和「没问题」在报告上长得一模一样。
 *
 * 试点 B 的触发很具体：项目为了让「页面销毁后不再写视图」成立，把 17 个页面统一改成
 * guard 包装 + 在守卫里接管原生 setData。改完之后 MP007 全绿，但这批文件的异步写一处没动。
 * 若此后有人只包 guard 而没接管 setData（或换了个不接管 setData 的守卫），MP007 也不会再提醒。
 *
 * ## 认出之后怎么办
 *
 * 认出来是为了**继续分析**，不是为了放过：写视图仍按原判据判（区域 + 存活短路）。
 * 「包了 guard」本身不算存活判定 —— 那是守卫的承诺，不是这段代码的证据。
 * 守卫是否真的接管了 setData，由项目侧的行为判据（本例：test:mp:lifecycle A10）证明，
 * 两条判据各管一段：本条管「这段代码有没有写视图的存活意识」，
 * A10 管「包了守卫之后原生 setData 会不会被拦」。不合并，因为合并后任一条失效都无人发现。
 */
const CTOR_WRAPPED_RE = /\b(?:Page|Component|Behavior)\s*\(\s*[A-Za-z_$][\w$]*\s*\(\s*\{/
const WX_CALL_RE = /\bwx\s*\.\s*[A-Za-z_$][\w$]*\s*\(/g
const THEN_RE = /\.\s*(?:then|catch|finally)\s*\(/g
/** `async (a) => {` / `async function f(a) {` / `async f(a) {`（方法简写） */
const ASYNC_HEAD_RE = /\basync\s*(?:function\b[^()]*)?[A-Za-z_$\w]*\s*\([^()]*\)\s*(?:=>\s*)?\{/g
const AWAIT_RE = /\bawait\b/

interface Span {
  start: number
  end: number
}

/**
 * `from` 位置（应指向括号之后）的函数体区间；不是内联函数返回 null。
 *
 * 必须覆盖全部四种内联写法，少一种就漏一整类回调：
 *   `success: (res) => { … }`   带括号参数的箭头（最常见，也最容易被正则漏掉）
 *   `success: res => { … }`     单参数无括号
 *   `success: function (res) { … }`
 *   `success(res) { … }`        方法简写
 * 裸标识符（`success: api.onOk`）返回 null：声明体不在本文件，看不清就不报。
 */
function inlineBodySpan(code: string, from: number): Span | null {
  let i = from
  const skipWs = () => {
    while (i < code.length && /\s/.test(code[i])) i++
  }
  skipWs()
  if (code.startsWith('async', i) && !/[\w$]/.test(code[i + 5] ?? '')) {
    i += 5
    skipWs()
  }
  if (code.startsWith('function', i) && !/[\w$]/.test(code[i + 8] ?? '')) {
    i += 8
    skipWs()
    while (i < code.length && /[\w$]/.test(code[i])) i++ // 函数名
    skipWs()
  }
  if (code[i] === '(') {
    const close = matchDelimiter(code, i)
    if (close < 0) return null
    i = close + 1
    skipWs()
  }
  if (code.startsWith('=>', i)) {
    i += 2
    skipWs()
  }
  if (code[i] !== '{') return null
  const end = matchDelimiter(code, i)
  return end < 0 ? null : { start: i, end }
}

export const mp07 = toGuard({
  id: 'mp07',
  title: '异步边界之后写视图（无存活判定）',
  invariants: ['INV-MP-07'],
  code: 'MP007_ASYNC_WRITE_NO_LIVENESS',
  level: 'warn',
  blindSpots: [
    '回调是**外部导入**的具名函数（`success: api.onOk`）时不判：声明体不在本文件，看不清就不报',
    '存活判定只认 `if (!x.flag) return` 这类短路；`if (x.dead) return`、`isAlive(this)` 封装形态会漏',
    '区域内任一处有存活短路就放过整个区域：一个回调里两段写视图、只护了一段时，漏报第二段',
    '`Promise` 被 `await` 之外的方式消费（`Promise.all(...).then` 分叉、事件总线、`setTimeout` 包装）时，边界可能落在判据圈外',
    '不判「该不该在这里写视图」：同步就该写的地方本判据不介入，只看「有没有判定」',
    '级别是 warn：静态判不出「这次会不会真炸」，只有「这里没有判定」是确定的',
    '**包了生命周期守卫不等于做了存活判定**：本判据只把 `Page(guardPage({` 认成「注册点」，不推断那个守卫做了什么。守卫是否接管了 `setData` 由项目侧行为判据证明（如 `test:mp:lifecycle` A10），两条各管一段，不合并——合并后任一条失效都无人发现',
  ],
  impact:
    '异步回调在页面销毁后仍会执行：轻则 `setData` 打到已销毁实例（控制台报错、首屏字段错乱），重则在回调里导航，把用户从别的页面拽走',
  provenance:
    '外部试点（2026-10）：弱网下点返回，`wx.request` 的 success 回调仍执行并 `navigateTo`，用户被从目标页弹走；同批发现 `await` 之后写视图一律没有存活判定',
  applies(rel) {
    return isMpSource(rel, /\.(?:js|ts)$/)
  },
  notApplicable(ctx: RuleCtx) {
    return requireMiniProgram(ctx)
  },
  analyze(src): RawHit[] {
    const code = maskRegexBodies(maskStringBodies(stripComments(src)))
    if (!CTOR_RE.test(code) && !CTOR_WRAPPED_RE.test(code)) return []
    const aliases = selfAliasesOf(code)
    const writeRe = selfWriteRe(aliases, true)
    const aliveRe = aliveShortCircuitRe(aliases)

    // 先把所有写视图位置收进来，再按区域过滤：区域只用来回答「这处写在不在异步时段里」
    const writes: number[] = []
    let w: RegExpExecArray | null
    writeRe.lastIndex = 0
    while ((w = writeRe.exec(code)) !== null) writes.push(w.index)
    if (writes.length === 0) return []

    const regions: Span[] = []
    let m: RegExpExecArray | null

    // ① wx.<api>({ … })：选项对象里能有语句的地方只可能是回调
    WX_CALL_RE.lastIndex = 0
    while ((m = WX_CALL_RE.exec(code)) !== null) {
      const open = m.index + m[0].length - 1
      let i = open + 1
      while (i < code.length && /\s/.test(code[i])) i++
      if (code[i] !== '{') continue
      const end = matchDelimiter(code, i)
      if (end > 0) regions.push({ start: i, end })
    }

    // ② .then / .catch / .finally 的内联回调体
    THEN_RE.lastIndex = 0
    while ((m = THEN_RE.exec(code)) !== null) {
      const open = m.index + m[0].length - 1
      const span = inlineBodySpan(code, open + 1)
      if (span) regions.push(span)
    }

    // ③ 含 await 的 async 函数体
    ASYNC_HEAD_RE.lastIndex = 0
    while ((m = ASYNC_HEAD_RE.exec(code)) !== null) {
      const braceAt = m.index + m[0].length - 1
      const end = matchDelimiter(code, braceAt)
      if (end < 0) continue
      if (AWAIT_RE.test(code.slice(braceAt, end + 1))) regions.push({ start: braceAt, end })
    }

    const sites: number[] = []
    const reported = new Set<number>()
    for (const at of writes) {
      const region = regions.find((r) => at > r.start && at < r.end)
      if (!region) continue
      if (reported.has(region.start)) continue
      // 存活判定认整段区域：宁可少报一处，也不要因为「另一段护了」而漏掉没护的那一段
      const regionText = code.slice(region.start, region.end + 1)
      if (aliveRe.test(regionText)) continue
      reported.add(region.start)
      sites.push(at)
    }
    if (sites.length === 0) return []

    // 按**文件**聚合，不按命中点逐条报。
    // 实测（外部试点，24 个源文件）：逐条报会出 46 条黄，一半以上是同一个页面里的第 2、3、4 处。
    // 可处理的单位是「这个页面有没有做存活判定」，不是「第 47 行有没有」——
    // 一条把行号列全，信息一点没少，噪音降一个量级。逐条报的结局是人把整条判据关掉。
    const lines = sites.map((at) => lineOf(src, at)).sort((a, b) => a - b)
    const MAX_SHOW = 8
    const shown = lines.slice(0, MAX_SHOW).join('、')
    return [
      {
        line: lines[0],
        message:
          `本文件有 ${sites.length} 处写视图发生在异步边界之后（行 ${shown}${lines.length > MAX_SHOW ? ' …' : ''}），` +
          '这些区域里都没有存活判定：页面在这段时间里被销毁时，回调仍会执行并写到已销毁的实例上' +
          '（轻则控制台报错、首屏字段错乱，重则把用户从别的页面拽走）；' +
          '在写之前先判存活（`if (!this.xxx) return`），并在 onUnload 里把标志置 false',
        evidence: evidenceOf(src, sites[0]),
      },
    ]
  },
  fixtures: [
    {
      name: 'wx.request 的 success 里写视图（该报）',
      expect: 'warn',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  onLoad() {
    wx.request({
      url: '/api/list',
      success: (res) => {
        this.setData({ list: res.data })
      },
    })
  },
})
`,
      },
    },
    {
      name: '.then 回调里写视图（该报）',
      expect: 'warn',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  load() {
    api.getList().then((list) => {
      this.setData({ list })
    })
  },
})
`,
      },
    },
    {
      name: 'await 恢复点之后写视图（该报）',
      expect: 'warn',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  async load() {
    const list = await api.getList()
    this.setData({ list })
  },
})
`,
      },
    },
    {
      name: '别名写在 success 里（该报，文案要写真实接收者）',
      expect: 'warn',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  load() {
    const that = this
    wx.getLocation({
      type: 'gcj02',
      success(res) {
        that.setData({ lat: res.latitude })
      },
    })
  },
})
`,
      },
    },
    {
      name: 'success 里先做存活短路（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  onLoad() {
    this.alive = true
    wx.request({
      url: '/api/list',
      success: (res) => {
        if (!this.alive) return
        this.setData({ list: res.data })
      },
    })
  },
  onUnload() {
    this.alive = false
  },
})
`,
      },
    },
    {
      name: 'await 之后先判存活（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  async load() {
    const list = await api.getList()
    if (!this.alive) return
    this.setData({ list })
  },
})
`,
      },
    },
    {
      name: '异步回调只改实例字段（不写视图，不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  load() {
    wx.request({
      url: '/api/list',
      success: (res) => {
        this.cache = res.data
      },
    })
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
        'utils/api.js': `module.exports = {
  get(cb) {
    wx.request({ url: '/x', success: cb })
  },
}
`,
        'pages/demo/demo.js': `Page({ onLoad() {} })
`,
      },
    },
    {
      // 这一条钉的是 CTOR_WRAPPED_RE：把注册形式从 `Page({` 改成 `Page(guardPage({`
      // 之后，同一个缺陷必须**继续被报**。它是上面那段「试点 B 假绿」的可执行版本——
      // 反证方向是唯一的：删掉 CTOR_WRAPPED_RE，本条立刻从 warn 变 green，其余七条全绿不动。
      name: '构造函数被 guard 包裹后，异步写视图仍然该报（包 guard ≠ 做了存活判定）',
      expect: 'warn',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'utils/lifecycle.js': `const guardPage = (o) => o
module.exports = { guardPage }
`,
        'pages/demo/demo.js': `const { guardPage } = require('../../utils/lifecycle')
Page(guardPage({
  load() {
    api.getList().then((list) => {
      this.setData({ list })
    })
  },
}))
`,
      },
    },
    {
      // 配对的反证：同一个包裹形态 + 真做了存活短路 ⇒ 必须 green。
      // 两条一起才证明「认出包裹形式」没有把判据变成恒红。
      name: '构造函数被 guard 包裹且回调里判了存活（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'utils/lifecycle.js': `const guardPage = (o) => o
module.exports = { guardPage }
`,
        'pages/demo/demo.js': `const { guardPage } = require('../../utils/lifecycle')
Page(guardPage({
  load() {
    api.getList().then((list) => {
      if (!this.alive) return
      this.setData({ list })
    })
  },
  onUnload() {
    this.alive = false
  },
}))
`,
      },
    },
    {
      // Component 侧不能漏：`Component(guardComponent({` 是同一批改造的另一半。
      name: 'Component 被 guard 包裹后，observers 里的异步写视图该报',
      expect: 'warn',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'utils/lifecycle.js': `const guardComponent = (o) => o
module.exports = { guardComponent }
`,
        'components/demo/demo.js': `const { guardComponent } = require('../../utils/lifecycle')
Component(guardComponent({
  properties: {},
  attached() {
    wx.getStorage({
      key: 'k',
      success: (res) => {
        this.setData({ k: res.data })
      },
    })
  },
}))
`,
      },
    },
  ],
})
