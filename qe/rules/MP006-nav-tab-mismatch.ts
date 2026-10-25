/**
 * MP006 · 跳转 API 与 tabBar 页类型不匹配
 *
 * ## 真实事故形态
 * `app.json` 的 `tabBar.list` 里登记了「首页 / 消息 / 我的」三页。某次改版把「消息」也放进了 tabBar，
 * 但代码里原本从首页跳消息写的是 `wx.navigateTo`。于是：
 *
 *   - 编译通过、lint 通过、DevTools 里手点**也能跳**（工具不拦）；
 *   - 真机上 `navigateTo:fail can not navigateTo a tabbar page` —— 用户点了没反应。
 *
 * 反向同型：把「消息」从 tabBar 移除后，代码里仍用 `wx.switchTab` 跳它，
 * 真机 `switchTab:fail can not switch no-tabBar page`。两处都是「页在、代码对、只有真机不跳」。
 *
 * ## 为什么这是独立判据（而不是 MP005 的一条分支）
 * MP005 问的是「这个路径在注册表里吗」，两边都注册的页它一定放过；
 * 本判据问的是「**路径对了，但打开方式错了**吗」。同一个 app.json、不同的问题，
 * 一条判据只说一件事——混在一起，命中就说不清该改路径还是该改 API。
 *
 * ## 判据
 * 1. 读最近祖先 `app.json`，取 `tabBar.list[].pagePath` 集合（**唯一**真相源，与 MP005 共用）；
 * 2. 找 `wx.<api>({ url })` 的字面量 url（变量拼接 / 模板串跳过：不猜运行时值）；
 * 3. `navigateTo` / `redirectTo` 指向 tab 页 → error（必须 switchTab / reLaunch）；
 * 4. `switchTab` 指向非 tab 页 → error（switchTab 只能去 tab 页）；
 * 5. `reLaunch` 两向都合法：它本来就能去任意页（含 tab 页）。
 *
 * ## 为什么不判「tabBar 数量超限 / 图标缺失」
 * 那些在编译期或 DevTools 里就报出来，不会走到线上。本判据只收「能过所有检查、只在真机失败」的那类。
 */

import { maskRegexBodies, maskStringBodies, matchDelimiter, stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import {
  appJsonRoutes,
  dirOf,
  findNearestUp,
  isMpSource,
  normalizeMpPath,
  requireMiniProgram,
  resolveRel,
  stripExt,
} from '../lib/mp-project.ts'

/** 四个跳转 API 一起抓：判据要按「目标页类型 × API」配对判，分开写会漏一半 */
const NAV_CALL_RE = /wx\s*\.\s*(navigateTo|redirectTo|switchTab|reLaunch)\s*\(\s*\{/g
const URL_KEY_RE = /\burl\s*:\s*/g

/** 只能打开「非 tab 页」的 API */
const NON_TAB_ONLY = new Set(['navigateTo', 'redirectTo'])

export const mp06 = toGuard({
  id: 'mp06',
  title: '跳转 API 与 tabBar 页类型不匹配',
  invariants: ['INV-MP-06'],
  code: 'MP006_NAV_TAB_MISMATCH',
  blindSpots: [
    '`url` 由变量拼接或模板串插值时跳过：不猜运行时值',
    '`tabBar` 由插件或运行时动态改写时不可见：只认 `app.json` 的静态声明',
    '自定义 tabBar（`tabBar.custom: true`）仍按 `list[].pagePath` 判——`list` 缺失时本判据不报（没有事实来源）',
    '只判跳转 API 的对象字面量写法；参数由变量传入时不可见',
    '「tab 页用 navigateTo 会被工具放过」这一条依赖真机行为，DevTools 不报错；判据不模拟运行时，只按声明判',
  ],
  impact:
    '`navigateTo` 打 tabBar 页、`switchTab` 打非 tab 页：开发者工具里手点可能能跳，真机上必定失败且只有一句 fail 日志，用户看到的是「点了没反应」',
  provenance:
    '外部试点（2026-10）：改版把页面并进 tabBar 后，代码里仍是 `navigateTo`，工具里正常、真机上点不动；反向的 `switchTab` 打非 tab 页同批出现',
  applies(rel) {
    return isMpSource(rel, /\.(?:js|ts)$/)
  },
  notApplicable(ctx: RuleCtx) {
    return requireMiniProgram(ctx)
  },
  analyze(src, rel, ctx): RawHit[] {
    const stripped = stripComments(src)
    const masked = maskRegexBodies(maskStringBodies(stripped))
    if (!/wx\s*\.\s*(?:navigateTo|redirectTo|switchTab|reLaunch)\s*\(/.test(masked)) return []

    const appJsonPath = findNearestUp(ctx, dirOf(rel), 'app.json')
    if (appJsonPath === null) return []
    const appJsonText = ctx.readFile(appJsonPath)
    if (appJsonText === null) return []
    const routes = appJsonRoutes(appJsonText)
    if (routes === null) return []

    // 工程根与基准路径必须与注册表同源（注册表就写在这个 app.json 里），
    // 用配置里的候选根会在 `repo/miniprogram/app.json` 这类布局上多算一层前缀。
    const mpRoot = dirOf(appJsonPath)
    const relInRoot = mpRoot === '' ? rel : rel.slice(mpRoot.length + 1)
    const currentPage = stripExt(relInRoot)

    const hits: RawHit[] = []
    let m: RegExpExecArray | null
    NAV_CALL_RE.lastIndex = 0
    while ((m = NAV_CALL_RE.exec(masked)) !== null) {
      const api = m[1]
      const braceAt = m.index + m[0].length - 1
      const end = matchDelimiter(masked, braceAt)
      if (end < 0) continue
      const objMasked = masked.slice(braceAt, end + 1)
      URL_KEY_RE.lastIndex = 0
      const urlKey = URL_KEY_RE.exec(objMasked)
      if (!urlKey) continue
      const litAt = braceAt + urlKey.index + urlKey[0].length
      // 掩码后字符串内容变空白，字面量只能从原文同偏移处读（两边长度一致）
      const quote = stripped[litAt]
      if (quote !== "'" && quote !== '"' && quote !== '`') continue
      const closeAt = stripped.indexOf(quote, litAt + 1)
      if (closeAt < 0) continue
      const raw = stripped.slice(litAt + 1, closeAt)
      if (raw === '') continue
      if (quote === '`' && raw.includes('${')) continue
      if (/^\s*(?:\+|\.)/.test(stripped.slice(closeAt + 1, closeAt + 12))) continue
      if (/^plugin:\/\//.test(raw)) continue

      const target = normalizeMpPath(raw.startsWith('/') ? raw : resolveRel(dirOf(currentPage), raw) ?? raw)
      const isTab = routes.tabs.has(target)
      const line = lineOf(src, m.index)

      if (NON_TAB_ONLY.has(api) && isTab) {
        hits.push({
          line,
          message:
            `wx.${api} 的目标 \`${raw}\` 是 tabBar 页面（${appJsonPath} 的 tabBar.list）：` +
            `真机报 \`${api}:fail can not navigateTo a tabbar page\`，用户点了没反应；改用 wx.switchTab 或 wx.reLaunch`,
          evidence: evidenceOf(src, m.index),
        })
        continue
      }
      if (api === 'switchTab' && !isTab) {
        hits.push({
          line,
          message:
            routes.tabs.size === 0
              ? `wx.switchTab 的目标 \`${raw}\`：本工程 ${appJsonPath} 没有配置 tabBar，switchTab 必定失败；改用 wx.navigateTo / wx.redirectTo`
              : `wx.switchTab 的目标 \`${raw}\` 不是 tabBar 页面（${appJsonPath} 的 tabBar.list 里没有它）：` +
                '真机报 `switchTab:fail can not switch no-tabBar page`；改用 wx.navigateTo / wx.redirectTo',
          evidence: evidenceOf(src, m.index),
        })
      }
    }
    return hits
  },
  fixtures: [
    {
      name: 'navigateTo 打到 tab 页（该报）',
      expect: 'red',
      files: {
        'app.json': `{
  "pages": ["pages/home/home", "pages/msg/msg"],
  "tabBar": { "list": [{ "pagePath": "pages/home/home" }, { "pagePath": "pages/msg/msg" }] }
}`,
        'pages/detail/detail.js': `Page({
  openMsg() {
    wx.navigateTo({ url: '/pages/msg/msg' })
  },
})
`,
      },
    },
    {
      name: 'redirectTo 打到 tab 页（该报）',
      expect: 'red',
      files: {
        'app.json': `{
  "pages": ["pages/home/home"],
  "tabBar": { "list": [{ "pagePath": "pages/home/home" }] }
}`,
        'pages/login/login.js': `Page({
  afterLogin() {
    wx.redirectTo({ url: '/pages/home/home' })
  },
})
`,
      },
    },
    {
      name: 'switchTab 打到非 tab 页（该报）',
      expect: 'red',
      files: {
        'app.json': `{
  "pages": ["pages/home/home", "pages/detail/detail"],
  "tabBar": { "list": [{ "pagePath": "pages/home/home" }] }
}`,
        'pages/home/home.js': `Page({
  goDetail() {
    wx.switchTab({ url: '/pages/detail/detail' })
  },
})
`,
      },
    },
    {
      name: '工程没有 tabBar 配置却调 switchTab（该报）',
      expect: 'red',
      files: {
        'app.json': '{ "pages": ["pages/home/home"] }',
        'pages/home/home.js': `Page({
  go() {
    wx.switchTab({ url: '/pages/home/home' })
  },
})
`,
      },
    },
    {
      name: 'switchTab 打到 tab 页（正确用法，不该报）',
      expect: 'green',
      files: {
        'app.json': `{
  "pages": ["pages/home/home", "pages/msg/msg"],
  "tabBar": { "list": [{ "pagePath": "pages/home/home" }, { "pagePath": "pages/msg/msg" }] }
}`,
        'pages/detail/detail.js': `Page({
  openMsg() {
    wx.switchTab({ url: '/pages/msg/msg' })
  },
})
`,
      },
    },
    {
      name: 'navigateTo 打到非 tab 页（正确用法，不该报）',
      expect: 'green',
      files: {
        'app.json': `{
  "pages": ["pages/home/home", "pages/detail/detail"],
  "tabBar": { "list": [{ "pagePath": "pages/home/home" }] }
}`,
        'pages/home/home.js': `Page({
  goDetail() {
    wx.navigateTo({ url: '/pages/detail/detail?id=1' })
  },
})
`,
      },
    },
    {
      name: 'reLaunch 两向都合法（不该报）',
      expect: 'green',
      files: {
        'app.json': `{
  "pages": ["pages/home/home", "pages/detail/detail"],
  "tabBar": { "list": [{ "pagePath": "pages/home/home" }] }
}`,
        'pages/detail/detail.js': `Page({
  home() { wx.reLaunch({ url: '/pages/home/home' }) },
  detail() { wx.reLaunch({ url: '/pages/detail/detail' }) },
})
`,
      },
    },
    {
      name: 'url 由变量拼装（不猜运行时值，不该报）',
      expect: 'green',
      files: {
        'app.json': `{
  "pages": ["pages/home/home", "pages/msg/msg"],
  "tabBar": { "list": [{ "pagePath": "pages/home/home" }] }
}`,
        'pages/home/home.js': `Page({
  go(name) {
    wx.navigateTo({ url: '/pages/msg/' + name })
    wx.navigateTo({ url: \`/pages/\${name}/index\` })
  },
})
`,
      },
    },
    {
      name: '分包页在 tabBar 里（路径带 root，该报）',
      expect: 'red',
      files: {
        'app.json': `{
  "pages": ["pages/home/home"],
  "subPackages": [{ "root": "pkg", "pages": ["msg/msg"] }],
  "tabBar": { "list": [{ "pagePath": "pages/home/home" }, { "pagePath": "pkg/msg/msg" }] }
}`,
        'pages/home/home.js': `Page({
  openMsg() {
    wx.navigateTo({ url: '/pkg/msg/msg' })
  },
})
`,
      },
    },
  ],
})
