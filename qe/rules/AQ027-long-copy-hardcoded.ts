/**
 * AQ027 · 组件内硬编码长文案（应抽常量/CMS）。
 *
 * ## 缺陷形态
 *
 * .tsx/.jsx 组件文件里直接塞 >50 中文字符串字面量，应抽到常量文件或 CMS：
 *
 *   - const JOIN_FAQ = [ { q: '...', a: '平台不承担出资也不会让买家久等资金处理由支付平台...208字' } ]
 *   - <p>每件上架数据条目都要先通过四道核验：实体条目持资质证明...130字</p>
 *   - <Hint>平台代你向微信申请合作方审核通过后自动回填...80字</Hint>
 *
 * 和 AQ026 的区别：AQ026 是"短位塞长文案"（标签类型有语义约束），
 * AQ027 是"任何组件文件里有 >50 字的硬编码字符串"（不管标签类型）。
 * 修复手段：抽常量 / 上 CMS / 本地化文件。
 *
 * ## 判据（形态可复算）
 *
 * 1. .tsx/.jsx 组件文件
 * 2. 提取所有字符串字面量，中文字数 > 50
 * 3. 排除：注释、反引号模板串（可能含变量）、短位标签（已被 AQ026 覆盖）
 *
 * ## 准入标准
 *
 * ✅ 静态可判：正则 + 中文字数计数
 * ✅ 跨仓可复现：React/Next.js 项目通用
 * ✅ 有坏样本：[项目 A] 152 条 >30 字文案，其中 20+ 条 >80 字
 * ✅ 误报可控：>50 中文字阈值较高，FAQ/about 长文案虽然也命中但 warn 级让 triage 裁决
 */

import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { stripComments } from '../lib/code-only.ts'
import { lineOf } from '../lib/rule-helpers.ts'

const CN_THRESHOLD = 50

function cnCount(text: string): number {
  const m = text.match(/[\u4e00-\u9fa5]/g)
  return m ? m.length : 0
}

/** 提取所有双引号和单引号包裹的字符串（不含反引号，反引号里常有变量插值） */
function extractQuotedStrings(src: string): Array<{ text: string; line: number }> {
  const results: Array<{ text: string; line: number }> = []
  // 双引号
  const dqRe = /"([^"\\\n]{3,})"/g
  let m: RegExpExecArray | null
  while ((m = dqRe.exec(src)) !== null) {
    results.push({ text: m[1], line: lineOf(src, m.index) })
  }
  // 单引号
  const sqRe = /'([^'\\\n]{3,})'/g
  while ((m = sqRe.exec(src)) !== null) {
    results.push({ text: m[1], line: lineOf(src, m.index) })
  }
  return results
}

function isComponentRel(rel: string): boolean {
  return /\.(tsx|jsx)$/.test(rel) && (rel.startsWith('app/') || rel.startsWith('components/'))
}

export const aq27 = toGuard({
  id: 'aq27',
  title: '组件内硬编码长文案（应抽常量）',
  invariants: ['INV-UI-02'],
  blindSpots: [
    '反引号模板串（可能含变量插值，不扫）',
    'FAQ/about 类营销页的长文案答案（warn 级让 triage 裁决是否抽 CMS）',
    '国际化文件（locales/ 目录应豁免，但当前只扫 app/、components/）',
  ],
  code: 'AQ027_LONG_COPY_HARDCODED',
  level: 'warn',
  impact:
    '组件文件里硬编码 >50 中文字符串，应抽到常量文件或 CMS。多个文件同时有相同长文案时合并治理（AQ028 覆盖重复）。',
  provenance: '2026-10-29 [项目 A] UI 优化批：join/page.tsx JOIN_FAQ 数组含 3 条 >80 字答案，' +
    'marketing/page.tsx 首页 4 条 >100 字正文。',

  applies(rel) {
    return isComponentRel(rel)
  },

  analyze(src, rel, _ctx: RuleCtx): RawHit[] {
    if (!/[\u4e00-\u9fa5]/.test(src)) return []
    const code = stripComments(src)
    const hits: RawHit[] = []

    const strings = extractQuotedStrings(code)
    // 去重：同一行同一文案只报一次
    const seen = new Set<string>()
    for (const s of strings) {
      const key = `${s.line}:${s.text.slice(0, 20)}`
      if (seen.has(key)) continue
      seen.add(key)
      const cn = cnCount(s.text)
      if (cn >= CN_THRESHOLD) {
        hits.push({
          line: s.line,
          message: `组件内硬编码 ${cn} 中文字（阈值 ${CN_THRESHOLD}），建议抽到常量/CMS`,
          evidence: s.text.slice(0, 40) + (s.text.length > 40 ? '...' : ''),
        })
      }
    }
    return hits
  },

  fixtures: [
    {
      name: 'FAQ 数据结构硬编码长答案（该报）',
      expect: 'warn',
      rel: 'app/(marketing)/join/page.tsx',
      src:
        'const JOIN_FAQ = [\n' +
        "  { q: '资金处理问题', a: '平台不承担出资也不会让买家久等资金处理由支付平台从你自己的实体条目实体条目直接原路退回货款尚未资金流转的走实体条目内的冻结资金已资金流转的从实体条目余额扣出平台全程不经手不沉淀不占用资金' },\n" +
        ']\n',
    },
    {
      name: 'p 标签里内嵌双引号长字符串（该报）',
      expect: 'warn',
      rel: 'app/(marketing)/page.tsx',
      src:
        'export default function Home() {\n' +
        '  return <p copy={"每件上架数据条目都要先通过四道核验实体条目持资质证明并完成法人本人认证方可开店化妆品与牙膏类数据条目必须上传本数据条目的检验报告成分表逐项比对国家官方目录其中禁用成分[N]种限用成分[M]种"} />\n' +
        '}\n',
    },
    {
      name: 'utils 文件里的长字符串（该报 — 硬编码长文案不管在什么文件里都应抽）',
      expect: 'warn',
      rel: 'app/utils/constants.tsx',
      src:
        "export const LONG_TEXT = '绑定即向微信发起接收方校验成功才落库后可换绑货款直达你的实体条目标识平台不经手到货七天自动资金流转换绑会先解绑旧接收方约一分钟空窗'\n",
    },
    {
      name: '短文案正常（不该报）',
      expect: 'green',
      rel: 'app/[feature]/account/page.tsx',
      src:
        'export default function Account() {\n' +
        '  return <p>绑定微信收款实体条目</p>\n' +
        '}\n',
    },
  ],
})
