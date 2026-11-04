/**
 * AQ028 · 跨组件重复文案（应抽常量复用）。
 *
 * ## 缺陷形态
 *
 * 同一个 10-50 中文字的提示文案被 3+ 个组件文件复制粘贴，
 * 修改时要改 N 处、漏改即出现前后不一致：
 *
 *   - "图形验证码已使用，请按新图重新输入" — 4 处（join/apply-form、login、phone-rebind、merchant/login）
 *   - "请先阅读并同意《用户服务协议》《隐私政策》《纠纷处理与赔付规范》" — 3 处（join/apply-form、onboarding-flow、onboarding-resume）
 *   - "获取图形验证码失败，请检查网络连接" — 3 处
 *
 * 修复方向：抽成共享常量（如 `lib/copy.ts` 或 i18n 键值），一处改全局生效。
 *
 * ## 判据（形态可复算）
 *
 * 1. 遍历 ctx.files 中所有 .tsx/.jsx 组件文件（app/ 和 components/）
 * 2. 提取每个文件里的 10-50 中文字字符串字面量（排除 FAQ 长答案、注释、反引号模板串）
 * 3. 统计每条文案在多少个文件中出现
 * 4. ≥3 个文件 → warn
 *
 * 用 RuleCtx.files 跨文件分析（框架已扩展支持）。
 */

import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { stripComments } from '../lib/code-only.ts'
import { lineOf } from '../lib/rule-helpers.ts'

const CN_MIN = 10
const CN_MAX = 50 // 只扫中等长度文案，长 FAQ 答案不归此类治理
const FILE_THRESHOLD = 3

function cnCount(text: string): number {
  const m = text.match(/[\u4e00-\u9fa5]/g)
  return m ? m.length : 0
}

function isComponentRel(rel: string): boolean {
  return /\.(tsx|jsx)$/.test(rel) && (rel.startsWith('app/') || rel.startsWith('components/'))
}

export const aq28 = toGuard({
  id: 'aq28',
  title: '跨组件重复文案（应抽常量）',
  invariants: ['INV-UI-03'],
  blindSpots: [
    '只扫 app/ 和 components/ 下的 .tsx/.jsx；lib/ 下的常量文件间重复不归此类',
    '反引号模板串不扫（含变量插值，文案主体可能每次不同）',
    'FAQ/about 类 50+ 字长答案不扫（归 AQ027 治理，且 >50 字文案重复概率低）',
    'API route 间的共用短信/站内信模板不归此类（文案有业务上下文差异）',
    '三元表达式（A ? "文案" : "另一文案"）分支各自计入',
  ],
  code: 'AQ028_DUPLICATE_COPY_ACROSS_COMPONENTS',
  level: 'warn',
  impact:
    '同一 10-50 中文字文案在 3+ 组件文件中复制粘贴。修改时要改 N 处、漏改即出现前后不一致。抽成共享常量（如 lib/copy.ts）一处改全局生效。',
  provenance: '2026-10-29 skinlab UI 优化批：7 组 ≥3 处重复文案（图形验证码提示、协议同意文案、换绑手机号说明、支付通道维护、认证过期、网络错误等）。',

  applies(_rel) {
    return true // 跨文件分析，analyze 里自己过滤
  },

  // 模块级缓存：同一次 run() 内对 700+ 文件只跑一次完整分析
  _cache: new Map<string, RawHit[]>(),

  analyze(_src, _rel, ctx: RuleCtx): RawHit[] {
    // 收集所有组件文件
    const componentFiles = ctx.files.filter(isComponentRel)
    if (componentFiles.length < 3) return []

    // 大项目才缓存（fixture 里文件少直接算）
    let cacheKey = ''
    if (componentFiles.length >= 10) {
      cacheKey = `${ctx.root}:${componentFiles.slice().sort().join(',')}`
      const cached = (this as any)._cache.get(cacheKey)
      if (cached) return cached
    }

    // 提取每个文件里中等长度的中文字符串
    // Map<文案, { file: line }> — 用 Map 保证 key 去重，值里保留首次出现位置
    const copyMap = new Map<string, { file: string; line: number; files: Set<string> }>()

    for (const file of componentFiles) {
      const src = ctx.readFile(file)
      if (!src) continue
      const code = stripComments(src)
      const dqRe = /"([^"\\\n]{5,})"/g
      let m: RegExpExecArray | null
      const seenInFile = new Set<string>()
      while ((m = dqRe.exec(code)) !== null) {
        const text = m[1]
        const cn = cnCount(text)
        if (cn < CN_MIN || cn > CN_MAX) continue
        if (seenInFile.has(text)) continue
        seenInFile.add(text)
        if (!copyMap.has(text)) {
          copyMap.set(text, { file, line: lineOf(src, m.index), files: new Set<string>([file]) })
        } else {
          copyMap.get(text)!.files.add(file)
        }
      }
    }

    const hits: RawHit[] = []
    for (const [text, info] of copyMap) {
      if (info.files.size >= FILE_THRESHOLD) {
        hits.push({
          line: info.line,
          message:
            `相同文案在 ${info.files.size} 个组件出现（${[...info.files].join(', ')}），` +
            '建议抽成共享常量复用',
          evidence: text,
        })
      }
    }
    if (cacheKey) (this as any)._cache.set(cacheKey, hits)
    return hits
  },

  fixtures: [
    {
      name: '相同协议文案 3 个组件（该报）',
      expect: 'warn',
      files: {
        'app/join/apply-form.tsx':
          'export default function Apply() {\n' +
          '  const AGREEMENT = "请先阅读并同意用户服务协议隐私政策纠纷处理与赔付规范后再提交"\n' +
          '  return <Checkbox label={AGREEMENT}>同意</Checkbox>\n' +
          '}\n',
        'app/join/onboarding-flow.tsx':
          'export default function Onboarding() {\n' +
          '  const AGREEMENT = "请先阅读并同意用户服务协议隐私政策纠纷处理与赔付规范后再提交"\n' +
          '  return <AlertDescription>{AGREEMENT}</AlertDescription>\n' +
          '}\n',
        'app/join/onboarding-resume.tsx':
          'export default function Resume() {\n' +
          '  const AGREEMENT = "请先阅读并同意用户服务协议隐私政策纠纷处理与赔付规范后再提交"\n' +
          '  return <Checkbox label={AGREEMENT}>同意</Checkbox>\n' +
          '}\n',
      },
    },
    {
      name: '只有 2 个组件相同（不该报）',
      expect: 'green',
      files: {
        'app/join/page-a.tsx':
          'export default function A() {\n' +
          '  return <p>获取图形验证码失败请检查网络连接</p>\n' +
          '}\n',
        'app/join/page-b.tsx':
          'export default function B() {\n' +
          '  return <p>获取图形验证码失败请检查网络连接</p>\n' +
          '}\n',
      },
    },
    {
      name: '不同文案（不该报）',
      expect: 'green',
      files: {
        'app/a.tsx': "export default function A() { return <p>欢迎加入</p> }\n",
        'app/b.tsx': "export default function B() { return <p>创建店铺</p> }\n",
        'app/c.tsx': "export default function C() { return <p>提交审核</p> }\n",
      },
    },
    {
      name: 'FAQ 长答案虽然重复但 >50 字不在射程（不该报 — 归 AQ027）',
      expect: 'green',
      files: {
        'app/join/page.tsx':
          'const FAQ_A = { a: "退款由微信支付从你自己的商户账户直接原路退回货款尚未结算的走账户内的冻结资金已结算的从账户余额扣出平台全程不经手不沉淀不占用资金" }\n',
        'app/help/page.tsx':
          'const FAQ_B = { a: "退款由微信支付从你自己的商户账户直接原路退回货款尚未结算的走账户内的冻结资金已结算的从账户余额扣出平台全程不经手不沉淀不占用资金" }\n',
        'app/admin/page.tsx':
          'const FAQ_C = { a: "退款由微信支付从你自己的商户账户直接原路退回货款尚未结算的走账户内的冻结资金已结算的从账户余额扣出平台全程不经手不沉淀不占用资金" }\n',
      },
    },
  ],
})
