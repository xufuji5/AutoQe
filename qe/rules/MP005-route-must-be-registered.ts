/**
 * MP005 · 跳转目标没有在 `app.json` 里注册
 *
 * ## 真实事故形态
 * 新增一个页面目录（`.js/.json/.wxml/.wxss` 四件套齐了，开发者工具里也能直接打开它），
 * 但忘了往 `app.json` 的 `pages` 里加一行。代码侧一切正常：
 *
 *   - 编译通过、类型检查通过、lint 通过；
 *   - 从「当前页」直接打开这个页面路径，DevTools 能渲染（工具按文件路径找得到）；
 *   - 只有**真机上通过 `wx.navigateTo` 跳转**时必然失败：`navigateTo:fail page "…" is not found`。
 *
 * 分包页面更隐蔽：`subPackages[].root` 会把相对路径拼成 `/root/xxx`，
 * 注册串与代码里的字面量差一个 `root` 前缀就找不到，而两处都是对的、只是不匹配。
 *
 * ## 判据
 * 1. 找 `wx.navigateTo|redirectTo|reLaunch|switchTab({ … })` 的对象字面量；
 * 2. 取 `url:` 的**字面量**（模板串/变量拼接跳过：不猜运行时值）；
 * 3. 去掉 query 与 hash，把相对路径按「当前页所在目录」解析成绝对路径；
 * 4. 与 `app.json` 的 `pages` + `subPackages[].pages`（拼 root）+ `tabBar.list[].pagePath` 比对；
 * 5. 不在集合里 → error（这不是风格问题：真机上必定跳不过去）。
 *
 * ## 为什么必须读最近祖先的 app.json
 * 分包里的文件离工程根很远，但注册表只有工程根那一份。
 * 「就近读」比「按配置写死路径」稳：工程换布局时判据不用改。
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

const NAV_CALL_RE = /wx\s*\.\s*(navigateTo|redirectTo|reLaunch|switchTab)\s*\(\s*\{/g
const URL_KEY_RE = /\burl\s*:\s*/

export const mp05 = toGuard({
  id: 'mp05',
  title: '跳转目标未在 app.json 注册',
  invariants: ['INV-MP-05'],
  code: 'MP005_ROUTE_NOT_REGISTERED',
  blindSpots: [
    '`url` 由变量拼接或模板串插值时跳过：不猜运行时值',
    '只判跳转 API 的对象字面量写法；`wx.navigateTo` 的参数由变量传入时不可见',
    '`app.json` 解析失败时整条规则不报（读不懂配置不等于配置错了）',
    '`navigateTo` 打到 tabBar 页面（运行时另一个错）不判：那是「该用 switchTab」的问题，另一条判据',
    '插件的自定义页面（`plugin://`）跳过：不在本工程注册表里',
  ],
  impact:
    '`app.json` 没注册的路径，开发者工具按文件名能打开，但真机 `wx.navigateTo` 必定失败（`page … is not found`）',
  provenance:
    '试点 B（2026-10）：新增页面四件套齐备但漏登记 `pages`，工具里手点能开、真机跳转全失败；同类问题在分包 root 前缀上又犯一次',
  applies(rel) {
    return isMpSource(rel, /\.(?:js|ts)$/)
  },
  notApplicable(ctx: RuleCtx) {
    return requireMiniProgram(ctx)
  },
  analyze(src, rel, ctx): RawHit[] {
    const stripped = stripComments(src)
    const masked = maskRegexBodies(maskStringBodies(stripped))
    const hits: RawHit[] = []

    const appJsonPath = findNearestUp(ctx, dirOf(rel), 'app.json')
    if (appJsonPath === null) return []
    const appJsonText = ctx.readFile(appJsonPath)
    if (appJsonText === null) return []
    const routes = appJsonRoutes(appJsonText)
    if (routes === null) return []
    const registered = routes.all

    // 工程根 = 最近祖先 app.json 所在目录。用它而不是配置里的候选根：
    // 页面路径的基准与注册表必须来自同一个事实（注册表就写在这个 app.json 里），
    // 换成「配置声明的根」会在 `repo/miniprogram/app.json` 这类布局上多算一层前缀，全是假红。
    const mpRoot = dirOf(appJsonPath)
    const relInRoot = mpRoot === '' ? rel : rel.slice(mpRoot.length + 1)
    const currentPage = stripExt(relInRoot)

    let m: RegExpExecArray | null
    NAV_CALL_RE.lastIndex = 0
    while ((m = NAV_CALL_RE.exec(masked)) !== null) {
      const braceAt = m.index + m[0].length - 1
      const end = matchDelimiter(masked, braceAt)
      if (end < 0) continue
      const objMasked = masked.slice(braceAt, end + 1)
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
      // 动态值一律跳过：模板串插值、字符串拼接（`'/pages/x?id=' + id`）
      if (quote === '`' && raw.includes('${')) continue
      if (/^\s*(?:\+|\.)/.test(stripped.slice(closeAt + 1, closeAt + 12))) continue
      if (/^plugin:\/\//.test(raw)) continue

      const target = normalizeMpPath(raw.startsWith('/') ? raw : resolveRel(dirOf(currentPage), raw) ?? raw)
      if (registered.has(target)) continue
      hits.push({
        line: lineOf(src, m.index),
        message:
          `wx.${m[1]} 的目标 \`${raw}\`（解析为 \`/${target}\`）不在 ${appJsonPath} 的 pages / subPackages 里：` +
          '开发者工具按文件路径能打开，真机上这条跳转必定失败',
        evidence: evidenceOf(src, m.index),
      })
    }
    return hits
  },
  fixtures: [
    {
      name: '跳转目标未注册（该报）',
      expect: 'red',
      files: {
        'app.json': '{ "pages": ["pages/index/index"] }',
        'pages/index/index.js': `Page({
  go() {
    wx.navigateTo({ url: '/pages/detail/detail' })
  },
})
`,
      },
    },
    {
      name: '分包页面漏拼 root 前缀（该报）',
      expect: 'red',
      files: {
        'app.json': '{ "pages": ["pages/index/index"], "subPackages": [{ "root": "pkg/order", "pages": ["detail/detail"] }] }',
        'pkg/order/list/list.js': `Page({
  go() {
    wx.navigateTo({ url: '/detail/detail' })
  },
})
`,
      },
    },
    {
      name: '已注册（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/index/index", "pages/detail/detail"] }',
        'pages/index/index.js': `Page({
  go() {
    wx.navigateTo({ url: '/pages/detail/detail?id=1' })
  },
})
`,
      },
    },
    {
      name: '相对路径按当前页目录解析（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/index/index", "pages/b/b"] }',
        'pages/index/index.js': `Page({
  go() {
    wx.navigateTo({ url: '../b/b' })
  },
})
`,
      },
    },
    {
      name: '工程在 miniprogram/ 子目录，基准取 app.json 所在目录（不该报）',
      expect: 'green',
      files: {
        'miniprogram/app.json': '{ "pages": ["pages/index/index", "pages/detail/detail"] }',
        'miniprogram/pages/index/index.js': `Page({
  go() {
    wx.navigateTo({ url: '/pages/detail/detail' })
  },
})
`,
      },
    },
    {
      name: 'url 由变量拼装（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/index/index"] }',
        'pages/index/index.js': `Page({
  go(id) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + id })
  },
})
`,
      },
    },
    {
      name: '插件页面（不该报）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/index/index"] }',
        'pages/index/index.js': `Page({
  go() {
    wx.navigateTo({ url: 'plugin://myPlugin/index' })
  },
})
`,
      },
    },
  ],
})
