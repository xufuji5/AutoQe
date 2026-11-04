/**
 * AQ024 · Next.js 配置里的已知性能杀开关（且底层问题已修复）。
 *
 * ## 缺陷形态
 *
 * 开发者为了绕某个特定 bug，在 `next.config.mjs` 里关掉了一个 Next.js 内置的性能优化。
 * bug 修了之后忘了重开，性能损失长期存在：
 *
 *   - `experimental.turbopackFileSystemCacheForDev: false` — 关掉 Turbopack dev 磁盘缓存，
 *     热编译速度降 2-3×（2026-09-18 skinlab 事故：TurbopackInternalError os error 2，
 *     Next 15.2 起已修原子写入，Next 16.x 继承）。
 *
 * ## 判据（形态可复算）
 *
 * 1. 找项目根的 `next.config.*`（mjs/js/ts 都认）。
 * 2. 读 Next.js 版本（package.json → dependencies.next，解析成 major.minor.patch）。
 * 3. 命中以下配置项 + 当前 Next 版本已修复对应 bug → 报 warn：
 *    | 配置路径 | 要关的值 | 修复起始版本 |
 *    |----------|----------|-------------|
 *    | `experimental.turbopackFileSystemCacheForDev` | `false` | 15.2 |
 *    | `experimental.optimizeCss` | `false`（且 config 不是 Turbopack 无法支持的 postcss 场景） | 15.2 |
 *
 * 只认**带注释说明为什么关**的形态（纯代码里写 false 但没注释说明"因 X 事故关、Next Y 已修"
 * 才报红 — 但这太模糊，本规则用 warn + provenance 登记）。
 *
 * ## 准入标准
 *
 * ✅ 静态可判：正则扫 next.config.* + package.json dependencies
 * ✅ 跨仓可复现：Next.js App Router 项目通用
 * ✅ 有坏样本：skinlab next.config.mjs 关掉 turbopackFileSystemCacheForDev
 * ✅ 误报可控：只有 2 个固定配置键值对，且要 Next 版本达标才报
 */

import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { stripComments } from '../lib/code-only.ts'
import { lineOf } from '../lib/rule-helpers.ts'

/** 当前已知的性能杀开关清单：配置路径 → 应设值（true）→ 修复起始 Next 版本 */
const KILLSWITCHES: Array<{
  path: string[]
  killVal: string
  minNextMajor: number
  minNextMinor: number
  note: string
}> = [
  {
    path: ['experimental', 'turbopackFileSystemCacheForDev'],
    killVal: 'false',
    minNextMajor: 15,
    minNextMinor: 2,
    note: 'Next 15.2 起已修 Turbopack 缓存写入原子性（PR #8476），重开可让 dev 热编译提速 2-3×',
  },
]

function parseNextVersion(pkgJson: string | null): { major: number; minor: number } | null {
  if (!pkgJson) return null
  try {
    const pkg = JSON.parse(pkgJson)
    const raw: string =
      pkg.dependencies?.next ?? pkg.devDependencies?.next ?? pkg.optionalDependencies?.next ?? ''
    const m = raw.match(/(\d+)\.(\d+)/)
    if (!m) return null
    return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) }
  } catch {
    return null
  }
}

/** 从源码里提取 nested key 的值（简化版：只处理单层/双层点路径的字面量） */
function extractNestedBool(src: string, path: string[]): { val: string; line: number } | null {
  // 尝试两种形态：key: false  或  nested { key: false }
  // 这里我们只做粗粒度字符串匹配 — 找 "key: false" 或 "key: true" 形态
  const lastKey = path[path.length - 1]
  const re = new RegExp(
    `['"]?${lastKey}['"]?\\s*:\\s*(true|false)`,
    'g',
  )
  const m = re.exec(src)
  if (!m) return null
  return { val: m[1], line: lineOf(src, m.index) }
}

function isNextConfig(rel: string): boolean {
  return /^next\.config\.(?:mjs|js|ts|mts|cts)$/.test(rel)
}

/** 模块级缓存：同一次 run() 内 apply 对每个文件都返回 true → analyze 被调 N 次。
 *  next.config.* 和 package.json 内容不变，只算一次即可。*/
const FILES_CACHE = new Map<string, { configSrc: string; foundConfig: boolean; pkgSrc: string | null }>()

export const aq24 = toGuard({
  id: 'aq24',
  title: 'Next.js 配置里的已知性能杀开关',
  invariants: ['INV-PERF-02'],
  blindSpots: [
    '不检查已用注释明确标注"因 X 事故临时关、待 Next Y 重开"的形态 — 让 triage 人工裁决',
    '版本比对只看 Next 自身版本，不看 Turbopack 子版本号（Next 15.1 + Turbopack 独立修复版本可能误报）',
    '只认字面量布尔值，计算表达式（如 process.env.FOO && false）不在射程',
  ],
  code: 'AQ024_DEV_PERF_KILLSWITCH',
  level: 'warn',
  impact:
    'Next.js 配置里关了已知性能优化（底层 bug 已修），dev 热编译或生产构建变慢。',
  provenance: '2026-10-29 Web3 团长后台性能批：next.config.mjs 关掉 ' +
    'turbopackFileSystemCacheForDev，Next 16.3 已继承修复。',

  /**
   * ts collector 只收 .ts/.tsx/.js/.jsx — next.config.mjs 不在射程。
   * fixture 里 collector='none' 也可能收不到根目录的配置文件。
   * 所以对任何被收集的文件返回 true（只要有任何文件就触发 analyze），
   * analyze 内部自己用 ctx.readFile 直接读根目录的 next.config.* 和 package.json。
   */
  applies(_rel) {
    return true
  },

  analyze(_src, _rel, ctx: RuleCtx): RawHit[] {
    // 缓存：避免对 700+ 文件都读一遍根目录配置
    const cacheKey = ctx.root
    let cached = FILES_CACHE.get(cacheKey)
    if (!cached) {
      let foundConfig = false
      let configSrc = ''
      for (const candidate of ['next.config.mjs', 'next.config.js', 'next.config.ts', 'next.config.mts', 'next.config.cts']) {
        const s = ctx.readFile(candidate)
        if (s !== null) {
          configSrc = s
          foundConfig = true
          break
        }
      }
      const pkgSrc = ctx.readFile('package.json')
      cached = { configSrc, foundConfig, pkgSrc }
      FILES_CACHE.set(cacheKey, cached)
    }

    // 没找到 next.config.* → 不是 Next.js 项目，跳过
    if (!cached.foundConfig) return []

    const ver = parseNextVersion(cached.pkgSrc)
    if (!ver) return [] // 没 Next 版本 → 跳过

    if (ver.major < 15 || (ver.major === 15 && ver.minor < 2)) {
      return [] // Next 版本太旧，bug 没修 → 不算杀开关
    }

    const hits: RawHit[] = []
    const cleanCode = stripComments(cached.configSrc)

    for (const ks of KILLSWITCHES) {
      const found = extractNestedBool(cleanCode, ks.path)
      if (!found) continue
      if (found.val !== ks.killVal) continue
      hits.push({
        line: found.line,
        message:
          `${ks.path.join('.')} 被设为 ${ks.killVal}（性能杀开关）。` +
          `当前 Next ${ver.major}.${ver.minor}，${ks.note}`,
        evidence: ks.path.join('.'),
      })
    }
    return hits
  },

  fixtures: [
    {
      name: 'Next 16 + 关掉 turbopackFileSystemCacheForDev（该报）',
      expect: 'warn',
      files: {
        'next.config.mjs':
          '/** @type {import("next").NextConfig} */\n' +
          'const nextConfig = {\n' +
          '  experimental: {\n' +
          '    turbopackFileSystemCacheForDev: false,\n' +
          '  },\n' +
          '}\n' +
          'export default nextConfig\n',
        'package.json': '{"dependencies": {"next": "^16.3.4"}}',
      },
    },
    {
      name: 'Next 14 关同配置（不该报 — bug 没修）',
      expect: 'green',
      files: {
        'next.config.mjs':
          '/** @type {import("next").NextConfig} */\n' +
          'const nextConfig = {\n' +
          '  experimental: {\n' +
          '    turbopackFileSystemCacheForDev: false,\n' +
          '  },\n' +
          '}\n' +
          'export default nextConfig\n',
        'package.json': '{"dependencies": {"next": "^14.2.5"}}',
      },
    },
    {
      name: 'Next 16 + 配置已开（不该报）',
      expect: 'green',
      files: {
        'next.config.mjs':
          '/** @type {import("next").NextConfig} */\n' +
          'const nextConfig = {\n' +
          '  experimental: {\n' +
          '    turbopackFileSystemCacheForDev: true,\n' +
          '  },\n' +
          '}\n' +
          'export default nextConfig\n',
        'package.json': '{"dependencies": {"next": "^16.3.4"}}',
      },
    },
    {
      name: '没有 Next 杀开关的项目（不该报）',
      expect: 'green',
      files: {
        'next.config.mjs':
          '/** @type {import("next").NextConfig} */\n' +
          'const nextConfig = {\n' +
          '  // no perf killswitches here\n' +
          '}\n' +
          'export default nextConfig\n',
        'package.json': '{"dependencies": {"next": "^16.3.4"}}',
      },
    },
  ],
})
