/**
 * AQ029 · className 里的硬编码 arbitrary value（颜色/像素）。
 *
 * ## 缺陷形态
 *
 * AI 生成组件时直接把设计稿/Figma 里的颜色值（#EBEBEB、#555）或像素值（8px、15px）
 * 写进 className 的 Tailwind arbitrary value 语法里，而不是用项目已定义的设计 token
 * （如 border-card-line、text-muted-foreground、rounded-sm）。
 *
 *   - className="border-[#EBEBEB] text-[#555] rounded-[8px]"
 *   - className="text-[15px] leading-[1.75] max-w-[880px]"
 *   - className="hover:bg-[#F0F1F3] hover:text-[#222]"
 *
 * 为什么是幻觉：训练数据里 Tailwind arbitrary value 的写法很"显眼"（方括号 + 精确值），
 * 模型倾向于精确复现这种模式，而"抽象"成 token 是需要理解项目上下文的高阶能力，
 * AI 很少主动做。结果是：改颜色主题要全局替换 #EBEBEB，跨组件样式不一致，
 * 新人不知道项目有 token 系统。
 *
 * 修复方向：将 className 里的 arbitrary value 替换为项目的语义化 token。
 * 项目 globals.css 的 @theme inline 块已将 CSS 变量映射为 Tailwind 可用的类名，
 * 例如 border-card-line、text-ink-1、rounded-sm（= 8px）、text-15（若已扩展）。
 *
 * ## 判据（形态可复算）
 *
 * 1. .tsx/.jsx 文件的 className 属性里出现 [... ] arbitrary value
 * 2. 方括号内的值为颜色值（#hex / rgb / hsl / rgba / hsla）或像素值（数字+px）
 * 3. 排除：SVG 专用类（stroke-[] / fill-[]）、非视觉属性（content-visibility）、
 *    runic 值（如 [&:has([role=checkbox])] 这种选择器）、带 opacity 修饰的（如 bg-[#E6F7F0]/50 暂不扫因为映射复杂）
 *
 * ## 准入标准
 *
 * ✅ 静态可判：正则扫 className 字符串
 * ✅ 跨仓可复现：React/Next.js + Tailwind CSS 项目通用
 * ✅ 有坏样本：skinlab 100+ 处硬编码颜色值、100+ 处硬编码像素值
 * ✅ 误报可控：限定 className 属性 + 颜色/像素模式白名单
 */

import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { stripComments } from '../lib/code-only.ts'
import { lineOf } from '../lib/rule-helpers.ts'

/** className 属性提取：找到 className="..." 或 className='...' 的值 */
function extractClassNames(src: string): Array<{ cls: string; line: number; startPos: number }> {
  const results: Array<{ cls: string; line: number; startPos: number }> = []
  // 双引号 className="..." — 非贪婪匹配，跨行的 className 用单行模式处理
  const dqRe = /className\s*=\s*"([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = dqRe.exec(src)) !== null) {
    results.push({ cls: m[1], line: lineOf(src, m.index), startPos: m.index })
  }
  // 单引号 className='...'
  const sqRe = /className\s*=\s*'([^']*)'/g
  while ((m = sqRe.exec(src)) !== null) {
    results.push({ cls: m[1], line: lineOf(src, m.index), startPos: m.index })
  }
  return results
}

/** 判断方括号里的值是不是颜色值 */
const COLOR_VALUE_RE = /^(#([0-9a-fA-F]{3,8})|rgba?\([^)]+\)|hsla?\([^)]+\)|[a-z]+-[a-z]+-[a-z]+)$/

/** 判断方括号里的值是不是带单位的像素值 */
const PX_VALUE_RE = /^\d+px$/

/** 判断方括号里的值是不是无单位小数（leading 行高专用，如 1.75） */
const UNITLESS_NUMBER_RE = /^\d+(\.\d+)?$/

/** 提取 className 里的所有 Tailwind 类，识别带 arbitrary value 的 */
function findHardcodedValues(className: string): Array<{ fullClass: string; bracketValue: string; type: 'color' | 'px' | 'number' }> {
  const hits: Array<{ fullClass: string; bracketValue: string; type: 'color' | 'px' | 'number' }> = []
  // Tailwind arbitrary value 的正则：前缀 + [值]
  // 例如 border-[#EBEBEB]、text-[15px]、hover:bg-[#F0F1F3]、leading-[1.75]
  const arbitraryRe = /([\w:\-*]+?)\[([^\]]+)\]/g
  let m: RegExpExecArray | null
  while ((m = arbitraryRe.exec(className)) !== null) {
    const prefix = m[1]
    const bracketValue = m[2].trim()
    const fullClass = prefix + '[' + bracketValue + ']'

    // 排除 runic selector：包含 &: 或 @ 或 :has( 等选择器语法
    if (/&|@|:has|:where|:not|:is/.test(bracketValue)) continue
    // 排除 CSS 变量引用 var(...)
    if (/^var\(/.test(bracketValue)) continue
    // 排除 opacity 变体：方括号后紧跟 /数字 （Tailwind 允许 opacity 紧跟 arbitrary value 后）
    const afterBracket = className.slice(m.index + m[0].length, m.index + m[0].length + 5)
    if (/^\/\d+/.test(afterBracket)) continue

    let type: 'color' | 'px' | 'number' | null = null

    if (COLOR_VALUE_RE.test(bracketValue)) {
      type = 'color'
    } else if (PX_VALUE_RE.test(bracketValue)) {
      type = 'px'
    } else if (UNITLESS_NUMBER_RE.test(bracketValue)) {
      type = 'number'
    }

    if (type) {
      hits.push({ fullClass, bracketValue, type })
    }
  }
  return hits
}

/** 启发式过滤：某些 arbitrary value 可能是合理的（如 max-w-[1100px] 这种容器宽度）
 *  我们只扫"视觉属性"上的硬编码：颜色属性（border/text/bg/fill）、字号属性（text-）、
 *  圆角属性（rounded-）、行高字间距（leading/tracking）、ring（focus-visible:ring-）。
 *  不扫尺寸属性（h-/w-/max-w-/min-w-/max-h-），因为容器尺寸经常是设计稿定死的。
 */
/** 视觉属性白名单（不包含 stroke-/fill-，SVG 颜色有独立上下文） */
const VISUAL_PROPERTY_RE = /^(border|bg|text|rounded|leading|tracking|ring|divide|outline|shadow|accent|caret|column-rule|text-decoration)/

function isVisualProperty(fullClass: string): boolean {
  // 去掉 prefix 变体（hover:, focus:, md:, dark:, aria-checked: 等）
  // 找到最后一个 : 后面的部分，看是不是视觉属性
  const mainPart = fullClass.split(':').pop()!
  const prop = mainPart.split('-')[0]
  return VISUAL_PROPERTY_RE.test(prop)
}

function isComponentRel(rel: string): boolean {
  return /\.(tsx|jsx)$/.test(rel) && (rel.startsWith('app/') || rel.startsWith('components/'))
}

export const aq29 = toGuard({
  id: 'aq29',
  title: 'className 硬编码设计值',
  invariants: ['INV-UI-04'],
  blindSpots: [
    '不扫容器尺寸（h-/w-/max-w-/min-w-），因为设计稿定死的宽度经常是有意的',
    '不扫带 opacity 修饰的（如 bg-[#E6F7F0]/50），因为映射到 token + opacity 更复杂',
    '不扫 stroke-/fill-（SVG 颜色），因为 SVG 有独立的颜色上下文',
    '不扫 CSS 变量引用 var(...)，那是正确用法',
  ],
  code: 'AQ029_HARDCODED_ARBITRARY_VALUE',
  level: 'warn',
  impact:
    'AI 生成组件时直接把设计稿里的颜色值（#EBEBEB）或像素值（15px）写进 className 的 Tailwind arbitrary value，而不是用项目已定义的设计 token。改主题色要全局替换、跨组件样式不一致、新人不知道项目有 token 系统。',
  provenance: '2026-10-29 skinlab UI 治理批：marketing/layout.tsx 5 处 border-[#EBEBEB]、' +
    'join/page.tsx 颜色值泛滥、components/merchant/ 下 text-[15px] 20+ 处。globals.css 已定义完整 token 但未被使用。',

  applies(rel) {
    return isComponentRel(rel)
  },

  analyze(src, rel, _ctx: RuleCtx): RawHit[] {
    const code = stripComments(src)
    const hits: RawHit[] = []
    const seenKeys = new Set<string>()

    const classNames = extractClassNames(code)
    for (const { cls, line } of classNames) {
      const hardcoded = findHardcodedValues(cls)
      for (const { fullClass, bracketValue, type } of hardcoded) {
        // 只扫视觉属性（颜色、字号、圆角、行高等）
        if (!isVisualProperty(fullClass)) continue

        const key = `${line}:${fullClass}`
        if (seenKeys.has(key)) continue
        seenKeys.add(key)

        const typeLabel = type === 'color' ? '颜色值' : '像素值'
        hits.push({
          line,
          message: `className 硬编码${typeLabel} [${bracketValue}]（${fullClass}），建议使用项目 token`,
          evidence: fullClass,
        })
      }
    }
    return hits
  },

  fixtures: [
    {
      name: '颜色值 border-[#EBEBEB]（该报）',
      expect: 'warn',
      rel: 'app/marketing/page.tsx',
      src:
        'export default function Home() {\n' +
        '  return <div className="border-b border-[#EBEBEB] bg-white">内容</div>\n' +
        '}\n',
    },
    {
      name: '颜色值 text-[#555]（该报）',
      expect: 'warn',
      rel: 'app/marketing/page.tsx',
      src:
        'export default function Home() {\n' +
        '  return <p className="text-[#555] mt-4">正文</p>\n' +
        '}\n',
    },
    {
      name: '圆角 rounded-[8px]（该报）',
      expect: 'warn',
      rel: 'components/ui/card.tsx',
      src:
        'export function Card() {\n' +
        '  return <div className="rounded-[8px] border border-card-line bg-card">卡片</div>\n' +
        '}\n',
    },
    {
      name: '字号 text-[15px]（该报）',
      expect: 'warn',
      rel: 'components/merchant/sidebar.tsx',
      src:
        'export function Sidebar() {\n' +
        '  return <span className="text-[15px] font-medium">菜单项</span>\n' +
        '}\n',
    },
    {
      name: 'hover 变体 hover:bg-[#F0F1F3]（该报）',
      expect: 'warn',
      rel: 'app/marketing/layout.tsx',
      src:
        'export function Nav() {\n' +
        '  return <Link className="hover:bg-[#F0F1F3] hover:text-[#222]">首页</Link>\n' +
        '}\n',
    },
    {
      name: '正确使用 token border-card-line（不该报）',
      expect: 'green',
      rel: 'components/ui/card.tsx',
      src:
        'export function Card() {\n' +
        '  return <div className="rounded-sm border border-card-line bg-card">卡片</div>\n' +
        '}\n',
    },
    {
      name: '容器尺寸 max-w-[1100px] 不扫（不该报）',
      expect: 'green',
      rel: 'app/marketing/layout.tsx',
      src:
        'export function Layout() {\n' +
        '  return <div className="max-w-[1100px] mx-auto">内容</div>\n' +
        '}\n',
    },
    {
      name: 'SVG stroke 不扫（不该报）',
      expect: 'green',
      rel: 'components/icons.tsx',
      src:
        'export function Icon() {\n' +
        '  return <svg className="stroke-[#00A870] w-6 h-6" />',
    },
    {
      name: '行高 leading-[1.75]（该报）',
      expect: 'warn',
      rel: 'app/marketing/page.tsx',
      src:
        'export default function Home() {\n' +
        '  return <p className="text-lg leading-[1.75] text-foreground">正文段落</p>\n' +
        '}\n',
    },
    {
      name: 'opacity 变体 bg-[#E6F7F0]/50 不扫（不该报）',
      expect: 'green',
      rel: 'components/ui/card.tsx',
      src:
        'export function Card() {\n' +
        '  return <div className="bg-[#E6F7F0]/50">半透明底</div>\n' +
        '}\n',
    },
  ],
})
