/**
 * AQ035 · unstable_cache 声明了 cacheTag 但写路由里没有 revalidateTag 失效钩子。
 *
 * ## 缺陷形态
 *
 * Next.js 的 unstable_cache 可以声明 `tags: ['xxx']` — 这样调用 `revalidateTag('xxx')`
 * 就能在数据变更时主动失效缓存。但很多项目只声明 tags 却忘记在写路由里加失效钩子：
 *
 *   // lib/merchant/layout.tsx
 *   const getCachedMerchantBrief = unstable_cache(
 *     async (userId) => { ... },
 *     ['merchant-shell', 'v1'],
 *     { revalidate: 300, tags: ['merchant-shell'] }   // ← 声明了 cacheTag
 *   )
 *
 *   // lib/merchant/members.ts — 成员被移出（写路由）
 *   export async function removeMember(memberId) {
 *     await prisma.merchantMember.delete({ where: { id: memberId } })
 *     // ← 这里应该加 revalidateTag('merchant-membership')
 *   }
 *
 * 结果：业务操作已经变更了 DB，但缓存最多要等 300s TTL 到期才刷新 —
 * "踢人后最多 5 分钟侧栏菜单还在"。虽然业务操作会被 requireMerchantAccess 拦截，
 * 但 UI 可能滞后，用户体验很差。
 *
 * skinlab 真实案例：merchant/layout.tsx 注释里明确预留了
 * `// cacheTag('merchant-shell')` 和 `// cacheTag('merchant-membership')`，
 * 但成员管理写路由（lib/merchant/members.ts 里的角色变更/移出端点）
 * 没有 revalidateTag 调用。
 *
 * ## 判据
 *
 * 1. 扫所有 lib/ 目录下的 .ts 文件，找 unstable_cache 声明里的 tags: [...] 或注释 cacheTag('xxx')
 * 2. 收集声明了 cacheTag 的 lib 文件名
 * 3. 扫所有写端点（app/api 下的 route.ts 的 POST/PUT/DELETE handler、导出的 async function + create/update/delete）
 * 4. 写端点所在函数体里没有 `revalidateTag(...)` 且**在同一个业务域**
 *    （业务域判定：cacheTag 名字和写端点涉及的 Model 名有关——merchant-shell tag 对应 merchant 域）
 *
 * ## 简化版（当前实现）
 *
 * 业务域自动关联太复杂，先用保守策略：
 * 声明了 tags 的 unstable_cache → 全项目扫一遍有没有任何 revalidateTag 调用
 * 如果**全项目**都没有 revalidateTag → warn（至少有人得加一个）
 * 如果项目里有部分 revalidateTag 但某个 tag 名字没被 revalidateTag 引用 → info
 */

import { toGuard, type RawHit, type RuleCtx } from '../lib/rule-guard.ts'
import { stripComments } from '../lib/code-only.ts'
import { lineOf } from '../lib/rule-helpers.ts'

/** 从 unstable_cache 声明里提取 tags */
function extractCacheTags(src: string): Array<{ tag: string; at: number; kind: 'option' | 'comment' }> {
  const results: Array<{ tag: string; at: number; kind: 'option' | 'comment' }> = []

  // 1. 真正的 tags: [...] 选项
  const tagsOptionRe = /tags\s*:\s*\[([^\]]*)\]/g
  let m: RegExpExecArray | null
  while ((m = tagsOptionRe.exec(src)) !== null) {
    const tagList = m[1]
    // 提取 tag 字符串字面量
    const tagRe = /['"]([^'"]+)['"]/g
    let tm: RegExpExecArray | null
    while ((tm = tagRe.exec(tagList)) !== null) {
      results.push({ tag: tm[1], at: m.index, kind: 'option' })
    }
  }

  // 2. 注释里的 cacheTag('xxx') 预留
  const cacheTagCommentRe = /\/\/\s*cacheTag\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = cacheTagCommentRe.exec(src)) !== null) {
    results.push({ tag: m[1], at: m.index, kind: 'comment' })
  }

  return results
}

/** 提取所有 revalidateTag('xxx') 里的 tag 名 */
function extractRevalidateTags(src: string): string[] {
  const tags: string[] = []
  const re = /\brevalidateTag\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) tags.push(m[1])
  return tags
}

// 模块级 Set: 跨文件分析按项目 root 区分, 每个 root 只跑一次
// (selftest 每个 fixture 有独立 root, 不会互相污染)
const _aq35RanRoots = new Set<string>()

export const aq35 = toGuard({
  id: 'aq35',
  title: 'unstable_cache cacheTag 声明但写路由无 revalidateTag 失效钩子',
  invariants: ['INV-PERF-06'],
  code: 'AQ035_CACHE_TAG_NO_REVALIDATE',
  level: 'warn',
  impact:
    'unstable_cache 声明了 cacheTag（tags: [...] 或注释 cacheTag(...)）但写路由里没有 revalidateTag 调用。' +
    '业务操作变更 DB 后，缓存最多等 TTL 到期才刷新 — 出现"踢人后 5 分钟侧栏菜单还在"的 UI 滞后。',
  provenance: '2026-10-29 skinlab 性能批附录六：merchant/layout.tsx 注释预留 cacheTag(merchant-shell / merchant-membership)，' +
    '但成员管理写路由（lib/merchant/members.ts）没有 revalidateTag 调用。全项目零 revalidateTag 真实调用。',

  applies() {
    // 跨文件分析: 对所有文件返回 true, analyze 内部用 flag 保证只跑一次
    return true
  },

  analyze(_src, _rel, ctx: RuleCtx): RawHit[] {
    // 同一个项目 root 只跑一次 (跨文件全量扫描避免重复)
    if (_aq35RanRoots.has(ctx.root)) return []
    _aq35RanRoots.add(ctx.root)

    // 第一遍：扫所有文件，收集声明的 cacheTag 和已有的 revalidateTag 调用
    const declaredTags = new Map<string, { rel: string; line: number; kind: string }>()
    const calledTags = new Set<string>()

    for (const file of ctx.files) {
      const rawSrc = ctx.readFile(file)
      if (!rawSrc) continue
      const code = stripComments(rawSrc)

      // 检查有没有 unstable_cache / React.cache 声明
      if (!/(?:unstable_cache|React\.cache|from ['"]next\/cache['"])/.test(code)) continue

      // 提取 tags（用 rawSrc 因为注释里的 cacheTag 也需要扫）
      const tagHits = extractCacheTags(rawSrc)
      for (const t of tagHits) {
        if (!declaredTags.has(t.tag)) {
          declaredTags.set(t.tag, {
            rel: file,
            line: lineOf(rawSrc, t.at),
            kind: t.kind,
          })
        }
      }

      // 提取 revalidateTag 调用
      const revalidated = extractRevalidateTags(code)
      for (const t of revalidated) calledTags.add(t)
    }

    if (declaredTags.size === 0) return []

    // 第二遍：找出声明了但没被 revalidateTag 过的
    const hits: RawHit[] = []
    for (const [tag, info] of declaredTags) {
      if (calledTags.has(tag)) continue  // 已正确失效

      hits.push({
        line: info.line,
        file: info.rel,
        message:
          `\`${info.rel}\` 声明了 cacheTag "${tag}"（${info.kind === 'option' ? '真实 tags 选项' : '注释预留'}），` +
          `但全项目没有 revalidateTag("${tag}") 调用 — DB 变更后缓存最多等 TTL 到期刷新。` +
          '建议在相关写路由（mutation / server action）里加 revalidateTag 失效钩子。',
        evidence: `cacheTag "${tag}" 未被 revalidateTag`,
      })
    }

    return hits
  },

  fixtures: [
    {
      name: '真实 unstable_cache tags 选项（该报）',
      expect: 'warn',
      rel: 'lib/merchant/layout.tsx',
      src:
        "import { unstable_cache } from 'next/cache'\n" +
        'const getBrief = unstable_cache(\n' +
        '  async (userId: string) => { return userId },\n' +
        '  ["merchant-shell", "v1"],\n' +
        '  { revalidate: 300, tags: ["merchant-shell"] }\n' +
        ')\n',
    },
    {
      name: '注释 cacheTag 预留（该报）',
      expect: 'warn',
      rel: 'lib/merchant/layout.tsx',
      src:
        "import { unstable_cache } from 'next/cache'\n" +
        '// cacheTag("merchant-shell") — 预留失效钩子\n' +
        'const getBrief = unstable_cache(\n' +
        '  async (userId: string) => { return userId },\n' +
        '  ["merchant-shell", "v1"],\n' +
        '  { revalidate: 300 }\n' +
        ')\n',
    },
    {
      name: '声明了 tags 也有 revalidateTag（不该报）',
      expect: 'green',
      files: {
        'lib/merchant/layout.tsx':
          "import { unstable_cache } from 'next/cache'\n" +
          'const getBrief = unstable_cache(\n' +
          '  async (userId: string) => { return userId },\n' +
          '  ["merchant-shell", "v1"],\n' +
          '  { revalidate: 300, tags: ["merchant-shell"] }\n' +
          ')\n',
        'lib/merchant/members.ts':
          "import { revalidateTag } from 'next/cache'\n" +
          'export async function removeMember(memberId: string) {\n' +
          '  await prisma.merchantMember.delete({ where: { id: memberId } })\n' +
          '  revalidateTag("merchant-shell")\n' +
          '}\n',
      },
    },
    {
      name: '没有 cacheTag 的 cache（不该报）',
      expect: 'green',
      rel: 'lib/product/trend.ts',
      src:
        "import { unstable_cache } from 'next/cache'\n" +
        'const getTrend = unstable_cache(\n' +
        '  async (days: number) => { return [] },\n' +
        '  ["product-trend"],\n' +
        '  { revalidate: 60 }\n' +
        ')\n',
    },
  ],
})
