/**
 * MP002 · 组件用了「只在全局样式里定义」的类（写了等于没写）
 *
 * ## 真实事故形态
 * 排版类（字号、颜色、间距）集中写在 `app.wxss` 里，页面直接用、一直正常。
 * 后来把这部分结构抽成自定义组件，样式照抄到组件 wxml 上——**看起来完全没变，实际全丢了**：
 * 自定义组件默认 `styleIsolation: isolated`，`app.wxss` 与页面 `wxss` 都不作用于组件内部。
 *
 * 这类事故的贵不在「难看」，在于**没人报错**：类名写得对、样式定义也在、DevTools 不告警，
 * 只有真机上「字号小了一号、颜色淡了」这种说不上是 bug 的现象，靠人眼在两台设备上比对才可能发现。
 *
 * ## 判据（只报能证死的那一种）
 * 对每个 `Component(...)` 文件，取它的同目录同名 `.wxml` / `.wxss` / `.json`：
 * 1. 组件声明了 `styleIsolation: shared|apply-shared` 或 `addGlobalClass: true` → 全局样式**确实**生效，跳过；
 * 2. 收集 wxml 里 `class="…"` 的**静态**类名（含 `{{}}` 的整条跳过：动态值不猜）；
 * 3. 收集组件自己 wxss 定义的类（跟随 `@import` 最多 3 层，含循环保护）；
 * 4. 收集 `externalClasses`（父组件传入的样式入口，不算空类）；
 * 5. 最近祖先 `app.wxss` 里定义、组件自己没定义、也不是 externalClass → **报**。
 *
 * ## 为什么只报「全局有、局部无」
 * 「局部也没有」的类可能是 **JS 查询锚点**（`createSelectorQuery('.js-btn')`）或语义标记，
 * 那种情况下「没样式」是刻意的，报了就是误报。而「全局有」恰好证明写的人**以为**它有样式。
 * 判据只在这个交叉点上说话。
 *
 * ## 为什么挂在 js 上而不是 wxml 上
 * `.wxml` 不在默认扩展名里：判据挂在 js 上，工程不需要改配置就能用。
 * 命中位置（命中行号 + 证据）如实指向 wxml，不指向判据顺路读到的那个 js。
 */

import { maskRegexBodies, maskStringBodies, stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { dirOf, findNearestUp, isMpSource, requireMiniProgram, stripExt } from '../lib/mp-project.ts'
import { classesWithImports, externalClassesOf, globalStylesApply, wxmlStaticClasses } from '../lib/mp-wxml.ts'

const COMPONENT_RE = /\bComponent\s*\(\s*\{/
export const mp02 = toGuard({
  id: 'mp02',
  title: '组件用了只在全局样式里定义的类',
  invariants: ['INV-MP-02'],
  code: 'MP002_ISOLATED_CLASS_DEAD',
  blindSpots: [
    '`class="{{expr}}"` 与 `class="a {{b}}"` 里的动态部分整条跳过：不猜运行时值',
    '「组件自己也没有、全局也没有」的类不报——它与 JS 查询锚点（createSelectorQuery）在源码上不可区分',
    '`@import` 只跟 3 层，更深的链会漏',
    '`virtualHost` / 插槽内容的样式归属不做推理：插槽节点归父组件，样式由父组件给，本判据看不到父组件',
    '页面（`Page`）不在射程：页面本来就继承 app.wxss',
    '样式作用域之外的成因不判：`!important` 覆盖、同权重后定义覆盖、伪元素选择器都不在射程',
  ],
  impact:
    '自定义组件默认 `styleIsolation: isolated`，`app.wxss` 的样式不会作用到组件内部：类名写对了但样式不生效，且没有任何报错',
  provenance:
    '试点 B（2026-10）：把页面结构抽成组件后，集中写在 app.wxss 的排版类在组件里全部失效；DevTools 无告警，真机表现为字号/颜色回落到继承值',
  applies(rel) {
    return isMpSource(rel, /\.(?:js|ts)$/)
  },
  notApplicable(ctx: RuleCtx) {
    return requireMiniProgram(ctx)
  },
  analyze(src, rel, ctx): RawHit[] {
    const jsStripped = stripComments(src)
    const jsCode = maskRegexBodies(maskStringBodies(jsStripped))
    if (!COMPONENT_RE.test(jsCode)) return []

    const base = stripExt(rel)
    const wxml = ctx.readFile(`${base}.wxml`)
    if (wxml === null) return []

    if (globalStylesApply(ctx, base, jsStripped)) return []

    const appWxss = findNearestUp(ctx, dirOf(rel), 'app.wxss')
    if (appWxss === null) return []
    const wxmlPath = `${base}.wxml`
    if (ctx.readFile(appWxss) === null) return []

    // 全局与组件两侧都必须跟 @import 链，否则「全局有、组件无」这个交叉点会漏掉一整类工程
    const global = classesWithImports(ctx, appWxss)
    const local = classesWithImports(ctx, `${base}.wxss`)
    const external = externalClassesOf(ctx, base, jsStripped)
    const used = wxmlStaticClasses(wxml)

    const hits: RawHit[] = []
    for (const [name, at] of used) {
      if (!global.has(name) || local.has(name) || external.has(name)) continue
      hits.push({
        file: wxmlPath,
        line: lineOf(wxml, at),
        message:
          `类 \`${name}\` 只在 ${appWxss} 定义，本组件默认 styleIsolation=isolated → 这条样式在组件里不生效（写了等于没写）；` +
          '要么把样式搬进组件 wxss，要么在组件 json 声明 styleIsolation: apply-shared',
        evidence: evidenceOf(wxml, at),
      })
    }
    return hits
  },
  fixtures: [
    {
      name: '全局样式里的排版类用在组件内（该报）',
      expect: 'red',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'app.wxss': `.muted { color: #999 }
.card { padding: 20rpx }
`,
        'components/card/card.js': 'Component({ properties: {} })\n',
        'components/card/card.json': '{ "component": true }\n',
        'components/card/card.wxml': `<view class="card"><text class="muted">hi</text></view>
`,
        'components/card/card.wxss': `.card { padding: 20rpx }
`,
      },
    },
    {
      name: '全局类定义在 app.wxss 的 @import 链上（该报：只读 app.wxss 本体会看不见）',
      expect: 'red',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'app.wxss': "@import 'styles/icons.wxss';\n",
        'styles/icons.wxss': '.xi { display: inline-block }\n.xi-home { background-image: url(home.png) }\n',
        'components/nav/nav.js': 'Component({})\n',
        'components/nav/nav.wxml': '<view class="xi xi-home"></view>\n',
      },
    },
    {
      name: '组件自己也 @import 了那份图标库（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'app.wxss': "@import 'styles/icons.wxss';\n",
        'styles/icons.wxss': '.xi { display: inline-block }\n.xi-home { background-image: url(home.png) }\n',
        'components/nav/nav.js': 'Component({})\n',
        'components/nav/nav.wxml': '<view class="xi xi-home"></view>\n',
        'components/nav/nav.wxss': "@import '../../styles/icons.wxss';\n",
      },
    },
    {
      name: '声明 apply-shared（全局样式确实生效，不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'app.wxss': '.muted { color: #999 }\n',
        'components/card/card.js': 'Component({ properties: {} })\n',
        'components/card/card.json': '{ "component": true, "styleIsolation": "apply-shared" }\n',
        'components/card/card.wxml': '<text class="muted">hi</text>\n',
        'components/card/card.wxss': '.card { padding: 20rpx }\n',
      },
    },
    {
      name: 'addGlobalClass 声明在 Component options 里（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'app.wxss': '.muted { color: #999 }\n',
        'components/card/card.js': 'Component({ options: { addGlobalClass: true } })\n',
        'components/card/card.wxml': '<text class="muted">hi</text>\n',
      },
    },
    {
      name: '组件自己 wxss 里也定义了同名类（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'app.wxss': '.muted { color: #999 }\n',
        'components/card/card.js': 'Component({})\n',
        'components/card/card.wxml': '<text class="muted">hi</text>\n',
        'components/card/card.wxss': '.muted { color: #666 }\n',
      },
    },
    {
      name: '类由 @import 的 wxss 提供（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'app.wxss': '.muted { color: #999 }\n',
        'components/card/card.js': 'Component({})\n',
        'components/card/card.wxml': '<text class="muted">hi</text>\n',
        'components/card/card.wxss': '@import "./shared.wxss";\n',
        'components/card/shared.wxss': '.muted { color: #666 }\n',
      },
    },
    {
      name: 'externalClasses 由父组件传入（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'app.wxss': '.muted { color: #999 }\n',
        'components/card/card.js': "Component({ externalClasses: ['muted'] })\n",
        'components/card/card.wxml': '<text class="muted">hi</text>\n',
      },
    },
    {
      name: '动态 class 整条跳过（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'app.wxss': '.muted { color: #999 }\n',
        'components/card/card.js': 'Component({})\n',
        'components/card/card.wxml': '<text class="muted {{extra}}">hi</text>\n',
      },
    },
    {
      name: '页面（Page）继承 app.wxss，不在射程（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'app.wxss': '.muted { color: #999 }\n',
        'pages/demo/demo.js': 'Page({ data: {} })\n',
        'pages/demo/demo.wxml': '<text class="muted">hi</text>\n',
      },
    },
    {
      name: '组件自己也没有、全局也没有的类（JS 锚点可能，不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'app.wxss': '.muted { color: #999 }\n',
        'components/card/card.js': 'Component({})\n',
        'components/card/card.wxml': '<text class="js-anchor">hi</text>\n',
      },
    },
  ],
})
