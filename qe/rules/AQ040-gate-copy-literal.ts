/**
 * AQ040 · 闸类错误码的文案不得硬编码书名号枚举（必须来自单源函数）。
 *
 * ## 缺陷形态
 *
 * 同一个准入闸错误码（`*_REQUIRED` 一族）在多个服务端入口各自抛出，文案各自手写：
 *
 *   // route A
 *   return apiError('AGREEMENTS_REQUIRED', '请阅读并同意《用户服务协议》《隐私政策》《纠纷处理与赔付规范》')
 *   // route B（半年后新增的入口）
 *   return apiError('AGREEMENTS_REQUIRED', '需阅读并同意《用户服务协议》《隐私政策》')
 *
 * 后果不只是措辞漂移：协议清单是会加的（本例真实事故——硬编码串漏了第四份文件），
 * 每个硬编码点都是一处「改一处忘三处」的定时炸弹。闸文案的正确形态是**调用单源函数**
 * （如协议矩阵的 `missingConsentText(merchant, level)`），清单变化时所有入口自动跟随。
 *
 * ## 判据
 *
 * 1. 剥注释后（注释里的字面量不参与，历史教训：注释骗过正向判据）扫 `apiError('<CODE>', <字面量>)`
 * 2. CODE 属配置码表（`options.codes`）或默认命中 `*_REQUIRED` 后缀（准入闸一族）
 * 3. 第二实参是字符串字面量（'/"/` 三种引号）且含 **≥2 对**书名号《》（枚举清单才是漂移病灶：
 *    单一文档名的闸文案措辞本就随上下文不同，收进来只会制造误报——真仓首跑实测 4 条全是单文档名）→ 命中
 * 4. 第二实参是标识符/函数调用（单源函数）→ 放行
 *
 * ## 准入标准
 *
 * ✅ 静态可判：正则 + 引号配对
 * ✅ 跨仓可复现：`*_REQUIRED` 后缀是通用准入闸命名；特例用 `options.codes` 声明
 * ✅ 有坏样本：外部试点 2026-11-03——准入闸错误码在 5 处入口各自硬编码协议书名号串，漏一份且文案互相漂移
 * ✅ 误报可控：剥注释 + 只看第一实参为全大写错误码的调用 + 必须含《》；配置码表可精确圈定
 */

import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { stripComments } from '../lib/code-only.ts'
import { lineOf } from '../lib/rule-helpers.ts'

/** apiError(<CODE>, …) 调用头：第一实参必须是全大写蛇形错误码（排除普通函数恰好同名） */
const CALL_HEAD = /\bapiError\s*\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*,/g

/** 第二实参的字符串字面量（'/"/` 三种引号；非贪婪配对同引号） */
const STRING_ARG = /^\s*(['"`])((?:(?!\1)[\s\S])*)\1/

function options_codes(options: Record<string, unknown>): string[] {
  const raw = options.codes
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string') : []
}

/** 枚举阈值（默认 2 对书名号）；暴露为 options.minPairs 是为了用夹具钉住阈值判别力 */
function options_minPairs(options: Record<string, unknown>): number {
  const raw = options.minPairs
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : 2
}

export const aq40 = toGuard({
  id: 'aq40',
  title: '闸类错误文案硬编码书名号枚举（须走单源函数）',
  invariants: ['INV-UI-05'],
  blindSpots: [
    '只认 apiError 一族发射器（可在 options.emitters 扩展）；自定义响应包装器的闸文案不在射程',
    '第二实参若先赋给中间变量再传入（两跳），静态看不见字面量——由文案漂移审计类判据兜底',
    '码表默认按 *_REQUIRED 后缀圈定：不带该后缀的闸码必须显式写进 options.codes，否则放行',
  ],
  code: 'AQ040_GATE_COPY_LITERAL',
  level: 'warn',
  impact:
    '准入闸错误码的文案是硬编码的书名号枚举串：清单一旦增减（加一份规则文件、改一次叫法），' +
    '这里就会漏改并与其他入口口径分裂。应改调单源文案函数（如协议矩阵的 missingConsentText），清单变化全端自动跟随。',
  provenance: '2026-11-03 外部试点准入闸治理：同一准入闸错误码在 5 处服务端入口各自硬编码协议书名号串，其中漏了一份文件且三处措辞互不一致。',

  applies(rel) {
    return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel)
  },

  analyze(_rawSrc, rel, ctx: RuleCtx): RawHit[] {
    const codes = options_codes(ctx.options)
    const minPairs = options_minPairs(ctx.options)
    const emitters = Array.isArray(ctx.options.emitters)
      ? (ctx.options.emitters as unknown[]).filter((e): e is string => typeof e === 'string')
      : ['apiError']
    const src = stripComments(_rawSrc)
    if (!emitters.some((e) => src.includes(e))) return []

    const hits: RawHit[] = []
    for (const emitter of emitters) {
      const head = new RegExp(`\\b${emitter}\\s*\\(\\s*['"]([A-Z][A-Z0-9_]{2,})['"]\\s*,`, 'g')
      let m: RegExpExecArray | null
      while ((m = head.exec(src)) !== null) {
        const code = m[1]
        const isGate = codes.includes(code) || (codes.length === 0 && /_REQUIRED$/.test(code))
        if (!isGate) continue
        const arg = src.slice(m.index + m[0].length)
        const sm = STRING_ARG.exec(arg)
        if (!sm) continue // 标识符/函数调用/模板插值单源 → 放行
        const text = sm[2]
        // 枚举判据：≥ minPairs 对书名号才算清单枚举；单一文档名的闸文案措辞随上下文各异，不算漂移病灶
        if ((text.match(/《/g) ?? []).length < minPairs) continue
        hits.push({
          line: lineOf(src, m.index),
          message:
            `\`${code}\` 的闸文案是硬编码书名号枚举（${text.slice(0, 40)}${text.length > 40 ? '…' : ''}）。` +
            '改调单源文案函数，协议/规则清单变化时本入口自动跟随，不再出现「改一处忘三处」。',
          evidence: text.trim(),
        })
      }
    }
    return hits
  },

  fixtures: [
    {
      name: '闸文案硬编码书名号枚举（该报）',
      expect: 'warn',
      files: {
        'app/api/join/route.ts':
          "import { apiError } from '@/lib/apierror'\n" +
          'export async function POST() {\n' +
          "  return apiError('AGREEMENTS_REQUIRED', '请阅读并同意《用户服务协议》《隐私政策》《纠纷处理与赔付规范》')\n" +
          '}\n',
        'app/api/upgrade/route.ts':
          "import { apiError } from '@/lib/apierror'\n" +
          'export async function POST() {\n' +
          "  return apiError('AGREEMENTS_REQUIRED', '需阅读并同意《用户服务协议》《隐私政策》')\n" +
          '}\n',
      },
    },
    {
      name: '文案来自单源函数调用（不该报）',
      expect: 'green',
      files: {
        'app/api/join/route.ts':
          "import { apiError } from '@/lib/apierror'\n" +
          "import { missingConsentText } from '@/lib/legal/consent-gate'\n" +
          'export async function POST() {\n' +
          "  return apiError('AGREEMENTS_REQUIRED', missingConsentText(null, 'trial'))\n" +
          '}\n',
      },
    },
    {
      name: '非闸码的消息引用文档名（默认码表外，不该报）',
      expect: 'green',
      files: {
        'app/api/doc/route.ts':
          "import { apiError } from '@/lib/apierror'\n" +
          'export async function GET() {\n' +
          "  return apiError('DOC_ARCHIVED', '该文档已归档，见《归档索引》')\n" +
          '}\n',
      },
    },
    {
      name: '同形态只出现在注释里（剥注释后不该报）',
      expect: 'green',
      files: {
        'app/api/join/route.ts':
          "import { apiError } from '@/lib/apierror'\n" +
          "// return apiError('AGREEMENTS_REQUIRED', '旧文案《用户服务协议》《隐私政策》')\n" +
          'export async function POST() {\n' +
          "  return apiError('AGREEMENTS_REQUIRED', missingConsentText(null, 'trial'))\n" +
          '}\n',
      },
    },
    {
      name: '闸文案只引用单一文档名（措辞随上下文，不该报）',
      expect: 'green',
      files: {
        'app/api/certs/route.ts':
          "import { apiError } from '@/lib/apierror'\n" +
          'export async function POST() {\n' +
          "  return apiError('PERSONAL_AUTH_REQUIRED', '需先勾选同意《个人信息处理授权书》后再上传')\n" +
          '}\n',
      },
    },
    {
      // 阈值判别力钉子（2026-11-03 复审批）：minPairs=1 ⇒ 同一份单文档名源码变红。
      // 若有人把默认阈值改成 1，本夹具当场红——「收紧放过了什么」立刻可见。
      name: '阈值判别力·反证 A：minPairs=1 时单文档名也报（证明 ≥2 的下界真的在起作用）',
      expect: 'warn',
      options: { minPairs: 1 },
      files: {
        'app/api/certs/route.ts':
          "import { apiError } from '@/lib/apierror'\n" +
          'export async function POST() {\n' +
          "  return apiError('PERSONAL_AUTH_REQUIRED', '需先勾选同意《个人信息处理授权书》后再上传')\n" +
          '}\n',
      },
    },
    {
      // 阈值判别力钉子（上界）：minPairs=3 ⇒ 双文档名枚举放行。
      // 若有人把默认阈值改成 3，默认码表下的双文档名夹具（第 1 条）会从红变绿——
      // 那条夹具的 expect=warn 会当场红，本条则是改 3 后唯一仍绿的路径（双文档名恰好压线）。
      name: '阈值判别力·反证 B：minPairs=3 时双文档名枚举放行（证明阈值不是恒报）',
      expect: 'green',
      options: { minPairs: 3 },
      files: {
        'app/api/upgrade/route.ts':
          "import { apiError } from '@/lib/apierror'\n" +
          'export async function POST() {\n' +
          "  return apiError('AGREEMENTS_REQUIRED', '需阅读并同意《用户服务协议》《隐私政策》')\n" +
          '}\n',
      },
    },
    {
      name: 'options.codes 圈定自定义闸码（该报）',
      expect: 'warn',
      options: { codes: ['CONSENT_GATE'] },
      files: {
        'app/api/join/route.ts':
          "import { apiError } from '@/lib/apierror'\n" +
          'export async function POST() {\n' +
          "  return apiError('CONSENT_GATE', '请先同意《平台规则》《隐私政策》')\n" +
          '}\n',
      },
    },
  ],
})
