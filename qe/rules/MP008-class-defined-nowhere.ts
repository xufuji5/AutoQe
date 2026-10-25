/**
 * MP008 · 组件里用了「组件作用域内谁都没定义」的类（写了等于没写）
 *
 * ## 真实事故形态
 * 模板里一个类名写错一个字母：
 *
 *   <view class="prodcut-card">…</view>      ← wxss 里是 product-card
 *
 * 结果不是报错，而是**什么都没有**：没有样式、没有告警、DevTools 不提示，
 * 页面上就是一块没有边框没有内边距的内容。它比 MP002 更隐蔽——
 * MP002 至少「全局定义了、组件拿不到」，而这里**谁都没定义**，
 * 你去看全局样式会以为「应该生效啊」，因为名字长得太像。
 *
 * 另一类同型：样式写在了**页面**的 wxss 里，而模板被抽成了组件。
 * 页面 wxss 不作用于 `isolated` 组件内部，于是这段样式静默失效。
 *
 * ## 判据
 * 1. `Component(` 文件 + 同目录同名 `.wxml`；
 * 2. 组件声明了 `shared` / `apply-shared` / `addGlobalClass` → **跳过**
 *    （此时页面与全局样式都可能进来，跨文件的事实不可见，报就是猜）；
 * 3. 收集 wxml 静态类名，减去：组件自身 wxss（跟 `@import` 链）、最近祖先 `app.wxss`（跟链）、
 *    `externalClasses`（父组件传入的入口）；
 * 4. 剩下的还要排除**JS 查询锚点**：`this.createSelectorQuery().select('.card')`、
 *    `selectComponent('.card')`、按类名做的自动化测试定位——这些类名没有样式是设计如此。
 *    排除方式：JS 原文（已剥注释、未抹字符串）里出现过这个名字。
 * 5. 仍剩下 → warn。
 *
 * ## 为什么是 warn 不是 error
 * 静态无法区分「忘了定义样式」与「有意留的空类」（占位、语义标记、外部工具按名扫描）。
 * 已经用「JS 是否引用」挡掉最常见的一类，但挡不干净。方向是「少报」。
 *
 * ## 明确不做的两件（父组件不可见）
 * - `virtualHost: true` 时组件根节点不存在，`class` 落到哪儿由父组件决定；
 * - 插槽内容的样式归父组件。
 * 两者都需要看父组件的 wxml/wxss，本判据只有子组件这一侧的事实。写进盲区，不写进判据。
 */

import { maskRegexBodies, maskStringBodies, stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { dirOf, findNearestUp, isMpSource, requireMiniProgram, stripExt } from '../lib/mp-project.ts'
import { classesWithImports, externalClassesOf, globalStylesApply, jsMentionsClass, wxmlStaticClasses } from '../lib/mp-wxml.ts'

const COMPONENT_RE = /\bComponent\s*\(\s*\{/

export const mp08 = toGuard({
  id: 'mp08',
  title: '组件里用了作用域内未定义的类',
  invariants: ['INV-MP-08'],
  code: 'MP008_CLASS_DEFINED_NOWHERE',
  level: 'warn',
  blindSpots: [
    '组件声明了 `shared` / `apply-shared` / `addGlobalClass` 时整条跳过：页面样式也能进来，跨文件事实不可见',
    '`class="{{expr}}"` 与 `class="a {{b}}"` 里的动态部分整条跳过：不猜运行时值',
    '**故意留空的类**（纯语义占位、按类名扫描的外部工具）报告为「JS 未引用」时才报；工具配置在仓外时仍会误报',
    '`virtualHost: true` 的根节点 class 归属不做推理（那要看父组件）',
    '插槽内容的样式归父组件，不在射程',
    '`@import` 只跟 3 层，更深的链会漏',
    '组件自身没有 `.wxss` 文件时，全部静态类名都会落到「未定义」一侧——若工程靠全局样式且未声明 shared，这是真缺陷；若靠编译期注入则误报',
  ],
  impact:
    '类名没有对应样式时不会报错：页面上表现为「少了边框/间距/字号」，看起来像设计没做完，实际是名字对不上或样式写在了页面 wxss 里',
  provenance:
    '外部试点（2026-10）：模板抽成组件后，样式留在页面 wxss 里，组件内静默失效；同批出现类名少一个字母的拼写错误',
  applies(rel) {
    return isMpSource(rel, /\.(?:js|ts)$/)
  },
  notApplicable(ctx: RuleCtx) {
    return requireMiniProgram(ctx)
  },
  analyze(src, rel, ctx): RawHit[] {
    const jsStripped = stripComments(src)
    if (!COMPONENT_RE.test(maskRegexBodies(maskStringBodies(jsStripped)))) return []

    const base = stripExt(rel)
    const wxml = ctx.readFile(`${base}.wxml`)
    if (wxml === null) return []

    // 共享模式：页面 / 全局样式都可能进来，跨文件事实不可见 —— 不猜
    if (globalStylesApply(ctx, base, jsStripped)) return []

    const appWxss = findNearestUp(ctx, dirOf(rel), 'app.wxss')
    if (appWxss === null) return []

    const global = classesWithImports(ctx, appWxss)
    const local = classesWithImports(ctx, `${base}.wxss`)
    const external = externalClassesOf(ctx, base, jsStripped)
    const used = wxmlStaticClasses(wxml)
    const wxmlPath = `${base}.wxml`

    const hits: RawHit[] = []
    for (const [name, at] of used) {
      if (global.has(name) || local.has(name) || external.has(name)) continue
      // JS 查询锚点：没有样式是设计如此，不是缺陷
      if (jsMentionsClass(jsStripped, name)) continue
      hits.push({
        file: wxmlPath,
        line: lineOf(wxml, at),
        message:
          `类 \`${name}\` 在组件作用域内没有任何定义（${base}.wxss、${appWxss}、externalClasses 都没有）：` +
          '这条样式不会生效，页面表现为「少了那段样式」且无任何告警；' +
          '检查是不是拼写错误，或样式写在了页面的 wxss 里（页面样式不进入 isolated 组件）',
        evidence: evidenceOf(wxml, at),
      })
    }
    return hits
  },
  fixtures: [
    {
      name: '类名拼写错误，谁都没定义（该报）',
      expect: 'warn',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'app.wxss': '.page { padding: 24rpx; }\n',
        'components/card/card.js': `Component({ properties: {} })
`,
        'components/card/card.wxml': '<view class="prodcut-card">x</view>\n',
        'components/card/card.wxss': '.product-card { border: 1rpx solid #eee; }\n',
      },
    },
    {
      name: '样式写在页面 wxss 里，组件内不生效（该报）',
      expect: 'warn',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'app.wxss': '.page { padding: 24rpx; }\n',
        'pages/demo/demo.wxss': '.card-title { font-weight: 600; }\n',
        'components/card/card.js': `Component({ properties: {} })
`,
        'components/card/card.wxml': '<view class="card-title">x</view>\n',
        'components/card/card.wxss': '.card { padding: 8rpx; }\n',
      },
    },
    {
      name: '类只在复合选择器里出现（`.corner.new`，算有定义，不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'app.wxss': '.page { padding: 24rpx; }\n',
        'components/card/card.js': `Component({ properties: {} })
`,
        'components/card/card.wxml': '<view class="corner new">x</view>\n',
        'components/card/card.wxss': '.corner { padding: 4rpx; }\n.corner.new { background: var(--primary); }\n',
      },
    },
    {
      name: '类在组件自己的 wxss 里（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'app.wxss': '.page { padding: 24rpx; }\n',
        'components/card/card.js': `Component({ properties: {} })
`,
        'components/card/card.wxml': '<view class="card">x</view>\n',
        'components/card/card.wxss': '.card { border: 1rpx solid #eee; }\n',
      },
    },
    {
      name: '类在全局 wxss 的 @import 链上（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'app.wxss': '@import "./styles/icons.wxss";\n',
        'styles/icons.wxss': '.xi-home { font-size: 32rpx; }\n',
        'components/card/card.js': `Component({ properties: {} })
`,
        'components/card/card.wxml': '<view class="xi-home">x</view>\n',
        'components/card/card.wxss': '.card { padding: 8rpx; }\n',
      },
    },
    {
      name: '类由父组件经 externalClasses 传入（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'app.wxss': '.page { padding: 24rpx; }\n',
        'components/card/card.js': `Component({ externalClasses: ['ext-title'] })
`,
        'components/card/card.json': '{ "component": true, "externalClasses": ["ext-title"] }',
        'components/card/card.wxml': '<view class="ext-title">x</view>\n',
        'components/card/card.wxss': '.card { padding: 8rpx; }\n',
      },
    },
    {
      name: '类名被 JS 当查询锚点（有意留空，不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'app.wxss': '.page { padding: 24rpx; }\n',
        'components/card/card.js': `Component({
  ready() {
    this.createSelectorQuery().select('.measure-box').boundingClientRect(() => {}).exec()
  },
})
`,
        'components/card/card.wxml': '<view class="measure-box">x</view>\n',
        'components/card/card.wxss': '.card { padding: 8rpx; }\n',
      },
    },
    {
      name: '声明了 apply-shared，样式可能来自页面（跳过判据，不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'app.wxss': '.page { padding: 24rpx; }\n',
        'components/card/card.js': `Component({ options: { styleIsolation: 'apply-shared' } })
`,
        'components/card/card.wxml': '<view class="from-page">x</view>\n',
        'components/card/card.wxss': '.card { padding: 8rpx; }\n',
      },
    },
    {
      name: 'class 是动态表达式（整条跳过，不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'app.wxss': '.page { padding: 24rpx; }\n',
        'components/card/card.js': `Component({ properties: {} })
`,
        'components/card/card.wxml': '<view class="card {{tone}}">x</view>\n',
        'components/card/card.wxss': '.card { padding: 8rpx; }\n',
      },
    },
  ],
})
