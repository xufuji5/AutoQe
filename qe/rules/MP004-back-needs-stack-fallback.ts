/**
 * MP004 · `wx.navigateBack` 没有栈底兜底
 *
 * ## 真实事故形态
 * 「提交成功 → showToast → 800ms 后自动返回」是最常见的一段代码。它在**正常路径**上没问题：
 * 用户从列表点进来，栈深 ≥ 2，`navigateBack` 顺利退回列表。
 *
 * 出事的是另外两条入口：
 *   - **分享卡片/扫码直达**：直接落在这一页，页面栈深度为 1；
 *   - **`reLaunch` 之后**：栈被重置，深度同样为 1。
 *
 * `navigateBack` 在栈底调用不会抛错、也不会中断执行——它只是**失败**（`fail` 回调里给一个
 * `navigateBack:fail cannot navigate back at first page`）。没有 `fail` 兜底时，用户看到的是
 * 「提示说成功了，然后停在一个已经提交完的表单页上，什么也没发生」。
 * 这类问题在测试里永远测不出来：测试都是从列表点进去的。
 *
 * ## 判据
 * 1. 找 `wx.navigateBack(`；
 * 2. 实参里出现 `fail:` / `fail(` → 已有兜底，放过；
 * 3. 前 400 字符内出现 `getCurrentPages()` 且其后 160 字符内出现 `.length` → 已有栈深判断，放过；
 * 4. 其余 → warn（不是 error：绝大多数调用点在「从列表点进来」的路径上确实安全，
 *    本判据只能证明「它没防另一条入口」，不能证明那条入口存在）。
 *
 * ## 为什么是 warn 而不是 error
 * 「有没有分享落地」是产品事实，不在源码里。判据在这里能给的最强结论是
 * 「这条返回在栈底会静默失败，且没有兜底」——值得看一眼，不足以判死。
 * 想升级成 error 的项目，做法是给每个入口补 `fail` / 栈深判断，而不是把本判据调红。
 */

import { maskRegexBodies, maskStringBodies, matchDelimiter, stripComments } from '../lib/code-only.ts'
import { evidenceOf, lineOf } from '../lib/rule-helpers.ts'
import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { isMpSource, requireMiniProgram } from '../lib/mp-project.ts'

const NAV_BACK_RE = /wx\s*\.\s*navigateBack\s*\(/g
const HAS_FAIL_RE = /\bfail\s*[:(]/
const STACK_PAGES_RE = /getCurrentPages\s*\(\s*\)/g

/** 调用点往前这么多字符内找栈深判断（约 10 行，够覆盖 `const pages = …` 到调用点） */
const LOOKBACK = 400
/** 找到 `getCurrentPages()` 之后，多远内必须出现 `.length` 才算真的判了深度 */
const LENGTH_WINDOW = 160

function hasStackDepthCheck(code: string, at: number): boolean {
  const from = Math.max(0, at - LOOKBACK)
  const window = code.slice(from, at)
  STACK_PAGES_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = STACK_PAGES_RE.exec(window)) !== null) {
    const after = window.slice(m.index + m[0].length, m.index + m[0].length + LENGTH_WINDOW)
    if (after.includes('.length')) return true
  }
  return false
}

export const mp04 = toGuard({
  id: 'mp04',
  title: 'navigateBack 没有栈底兜底',
  level: 'warn',
  invariants: ['INV-MP-04'],
  code: 'MP004_BACK_NO_STACK_FALLBACK',
  blindSpots: [
    '目标页有没有分享落地/扫码直达入口是产品事实，源码里看不见：本判据只说明「栈底会静默失败且无兜底」',
    '`fail` 兜底里干了什么不判（`fail: () => {}` 空实现同样算「有兜底」）',
    '栈深判断只认前 400 字符内的 `getCurrentPages().length`；更远的、封装在别的函数里的、用 `wx.getEnterOptionsSync` 判断入口类型的都不算',
    '集中封装的返回函数（内部做了栈深判断）只在封装处判一次：调用点用的是封装名，不在射程',
    '`delta` 大于 1 时目标是否越界不判',
  ],
  impact:
    '页面栈深度为 1（分享落地、扫码直达、reLaunch 之后）时 navigateBack 静默失败：不抛错、不中断，用户停在原地，看起来像「点了没反应」',
  provenance: '试点 B（2026-10）：分享卡片直达提交页后提交成功，自动返回必然失败，用户停在已完成页且无任何反应',
  applies(rel) {
    return isMpSource(rel, /\.(?:js|ts)$/)
  },
  notApplicable(ctx: RuleCtx) {
    return requireMiniProgram(ctx)
  },
  analyze(src): RawHit[] {
    const code = maskRegexBodies(maskStringBodies(stripComments(src)))
    const hits: RawHit[] = []
    let m: RegExpExecArray | null
    NAV_BACK_RE.lastIndex = 0
    while ((m = NAV_BACK_RE.exec(code)) !== null) {
      const open = m.index + m[0].length - 1
      const close = matchDelimiter(code, open)
      if (close < 0) continue
      const args = code.slice(open, close + 1)
      if (HAS_FAIL_RE.test(args)) continue
      if (hasStackDepthCheck(code, m.index)) continue
      hits.push({
        line: lineOf(src, m.index),
        message:
          'wx.navigateBack 既没有 fail 兜底，也没有 getCurrentPages().length 判断：栈深为 1 时（分享落地/扫码直达/reLaunch 之后）静默失败，用户停在原地；补 fail → switchTab 兜底，或先判栈深',
        evidence: evidenceOf(src, m.index),
      })
    }
    return hits
  },
  fixtures: [
    {
      name: '裸 navigateBack（该提示）',
      expect: 'warn',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  done() {
    wx.showToast({ title: '已提交' })
    setTimeout(function () { wx.navigateBack() }, 800)
  },
})
`,
      },
    },
    {
      name: '带了 fail 兜底（不该提示）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  done() {
    wx.navigateBack({ delta: 1, fail: function () { wx.switchTab({ url: '/pages/index/index' }) } })
  },
})
`,
      },
    },
    {
      name: '先判了栈深（不该提示）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  done() {
    const pages = getCurrentPages()
    if (pages.length > 1) wx.navigateBack()
    else wx.switchTab({ url: '/pages/index/index' })
  },
})
`,
      },
    },
    {
      name: '走封装好的安全返回（调用点不出现 wx.navigateBack，不该提示）',
      expect: 'green',
      files: {
        'app.json': '{ "pages": ["pages/demo/demo"] }',
        'pages/demo/demo.js': `Page({
  done() {
    this.$back()
  },
})
`,
      },
    },
  ],
})
