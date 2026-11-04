/**
 * AQ026 · 短标签位塞长文案。
 *
 * ## 缺陷形态
 *
 * 短标签位（button/Hint/Disclosure summary/title 属性/p/span 等）
 * 本应承载 ≤20 字的帮助文本，实际塞了 30-80 字的完整段落：
 *
 *   - <Hint>80 字收款账户说明</Hint>
 *   - <Disclosure summary="费率 / 排序加成 / 担保划付"> 内 <p>83 字权益叙事</p>
 *   - <p title="36 字补录占位说明">  title 本应 ≤15 字的 tooltip
 *   - SectionCard hint 属性直接塞 80 字字符串
 *
 * 修复方向：短位只留核心信息（1 句话），细节挪到折叠/弹窗/CMS。
 * title 属性最多 15 字，超过应换 icon + onClick。
 *
 * ## 判据（形态可复算）
 *
 * 1. JSX 标签内字符串字面量中文字数 > 阈值（短位 20、title 15）
 * 2. 标签类型属于短位：Hint / Disclosure summary / title 属性 / button / p / span
 * 3. 排除：页面主体长段（FAQ answer、marketing 正文）、注释、三元表达式短分支
 *
 * ## 准入标准
 *
 * ✅ 静态可判：正则 + 中文字数计数
 * ✅ 跨仓可复现：React/Next.js 项目通用
 * ✅ 有坏样本：skinlab gold-upgrade-panel(83字) + account Hint(80字) + nmpa title(36字)
 * ✅ 误报可控：短位标签白名单 + 字数门槛
 */

import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { stripComments, maskStringBodies } from '../lib/code-only.ts'
import { lineOf } from '../lib/rule-helpers.ts'

/** 短位标签/属性白名单 */
const SHORT_TAGS = ['button', 'summary', 'hint', 'title', 'label', 'placeholder', 'alertdescription', 'p', 'span', 'disclosure']
/** 短位标签内字符串阈值（中文字数） */
const SHORT_TAG_CN_THRESHOLD = 20
/** title 属性阈值（更严） */
const TITLE_CN_THRESHOLD = 15

/** 计算中文字符数 */
function cnCount(text: string): number {
  const m = text.match(/[\u4e00-\u9fa5]/g)
  return m ? m.length : 0
}

/** 提取 JSX 中的所有候选文案串：
 *  1. 属性值 "..." 和 '...'
 *  2. JSX 文本节点 >...<
 *  3. 三元表达式里的 '...' 和 "..."
 * 返回每个文案 + 行数 + 所在的 JSX 标签名（向前找最近的 <Tag 或 Tag=）
 */
function extractStringLiterals(src: string): Array<{ text: string; line: number; tagContext: string }> {
  const results: Array<{ text: string; line: number; tagContext: string }> = []
  const seen = new Set<string>()

  // 标签名缓存：向前找最近的标签名 或 属性名
  const tagBefore = (pos: number): string => {
    const before = src.slice(Math.max(0, pos - 120), pos)
    // 先找属性名：xxx="..." 形态 — 属性值前面的属性名
    const attrMatch = before.match(/(\w+)\s*=\s*["'`]\s*$/)
    if (attrMatch) return attrMatch[1].toLowerCase()
    // 再找标签名：<Tag 或 <Tag>
    const tagMatch = before.match(/<\/?(\w+)[\s>]/)
    return tagMatch ? tagMatch[1].toLowerCase() : 'unknown'
  }

  // 1. 双引号属性/字面量
  const dqRe = /"([^"\\\n]{3,})"/g
  let m: RegExpExecArray | null
  while ((m = dqRe.exec(src)) !== null) {
    const text = m[1]
    const key = `dq:${m.index}`
    if (seen.has(key)) continue
    seen.add(key)
    // 排除标签名本身
    const beforeTag = tagBefore(m.index)
    results.push({ text, line: lineOf(src, m.index), tagContext: beforeTag })
  }

  // 2. 单引号（三元表达式/普通字面量）
  const sqRe = /'([^'\\\n]{3,})'/g
  while ((m = sqRe.exec(src)) !== null) {
    const text = m[1]
    const key = `sq:${m.index}`
    if (seen.has(key)) continue
    seen.add(key)
    const beforeTag = tagBefore(m.index)
    results.push({ text, line: lineOf(src, m.index), tagContext: beforeTag })
  }

  // 3. JSX 文本节点：> 非空内容 <（内容含中文才算候选，纯 ASCII 跳过）
  const jsxTextRe = />([^<>]*[\u4e00-\u9fa5][^<>]*)</g
  while ((m = jsxTextRe.exec(src)) !== null) {
    const text = m[1].trim()
    if (text.length < 3) continue
    const key = `jt:${m.index}`
    if (seen.has(key)) continue
    seen.add(key)
    const beforeTag = tagBefore(m.index)
    results.push({ text, line: lineOf(src, m.index), tagContext: beforeTag })
  }

  return results
}

function isComponentRel(rel: string): boolean {
  return /\.(tsx|jsx)$/.test(rel) && (rel.startsWith('app/') || rel.startsWith('components/'))
}

export const aq26 = toGuard({
  id: 'aq26',
  title: '短标签位塞长文案',
  invariants: ['INV-UI-01'],
  blindSpots: [
    '不扫 FAQ 数组（JOIN_FAQ 是设计事实，迁移 CMS 是独立任务）',
    '三元表达式短分支（条件 ? "长文案A" : "长文案B"）两条分支各自命中',
    '反引号模板字符串里的文案（只扫双引号）',
  ],
  code: 'AQ026_LONG_COPY_IN_SHORT_SLOT',
  level: 'warn',
  impact:
    '短标签位（Hint/Dclosure/title/p/button）本应承载 ≤20 字帮助文本，实际塞了 30-80 字完整段落，增加心智负担。短位只留核心信息（1 句话），细节挪到折叠/弹窗。',
  provenance: '2026-10-29 skinlab UI 优化批：gold-upgrade-panel.tsx Disclosure 内 83 字 p 标签、' +
    'account/page.tsx Hint 组件 80 字、admin/nmpa title 属性 36 字。',

  applies(rel) {
    return isComponentRel(rel)
  },

  analyze(src, rel, _ctx: RuleCtx): RawHit[] {
    if (!/[\u4e00-\u9fa5]/.test(src)) return [] // 无中文直接跳过
    const code = stripComments(src)
    const hits: RawHit[] = []

    const literals = extractStringLiterals(code)
    for (const lit of literals) {
      const cn = cnCount(lit.text)
      if (cn === 0) continue

      // 短位标签检查
      const lowerTag = lit.tagContext.toLowerCase()
      if (lowerTag.includes('title') && cn > TITLE_CN_THRESHOLD) {
        hits.push({
          line: lit.line,
          message: `title 属性塞了 ${cn} 中文字（阈值 ${TITLE_CN_THRESHOLD}），tooltip 本应 ≤15 字`,
          evidence: lit.text.slice(0, 30) + (lit.text.length > 30 ? '...' : ''),
        })
      } else if (SHORT_TAGS.some((t) => lowerTag.includes(t.toLowerCase())) && cn > SHORT_TAG_CN_THRESHOLD) {
        hits.push({
          line: lit.line,
          message: `短位 ${lit.tagContext} 塞了 ${cn} 中文字（阈值 ${SHORT_TAG_CN_THRESHOLD}）`,
          evidence: lit.text.slice(0, 30) + (lit.text.length > 30 ? '...' : ''),
        })
      }
    }
    return hits
  },

  fixtures: [
    {
      name: 'Hint 组件塞 50 字（该报）',
      expect: 'warn',
      rel: 'app/merchant/account/page.tsx',
      src:
        'export default function Account() {\n' +
        '  return <Hint label="分账收款账户说明">绑定即向微信发起接收方校验，成功才落库；后可换绑。货款直达你的微信商户号，平台不经手。</Hint>\n' +
        '}\n',
    },
    {
      name: 'Disclosure summary 塞 35 字（该报）',
      expect: 'warn',
      rel: 'app/merchant/gold-panel.tsx',
      src:
        'export function GoldPanel() {\n' +
        '  return <Disclosure summary="费率 0.6% 单笔保底 0.3 元客单五十以上按全额生效计算方式" title="金牌权益" />\n' +
        '}\n',
    },
    {
      name: 'title 属性塞 36 字（该报）',
      expect: 'warn',
      rel: 'app/admin/page.tsx',
      src:
        'export default function Admin() {\n' +
        '  return <p title="主体信息在平台设置维护营业执照住所地质量安全负责人缺省时报告内含补录占位">报告说明</p>\n' +
        '}\n',
    },
    {
      name: '短文案正常（不该报）',
      expect: 'green',
      rel: 'app/merchant/account/page.tsx',
      src:
        'export default function Account() {\n' +
        '  return <Hint label="收款账户">绑定微信商户号</Hint>\n' +
        '}\n',
    },
    {
      name: 'button 塞长文案（该报）',
      expect: 'warn',
      rel: 'app/admin/page.tsx',
      src:
        'export default function Admin() {\n' +
        '  return <button onClick={() => {}}>平台代你向微信申请特约商户审核通过后自动回填商户号</button>\n' +
        '}\n',
    },
  ],
})
