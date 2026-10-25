/**
 * 变更型服务端入口的速率/体积上限（INV-SEC-02）——候选级（warn-only）。
 *
 * 为什么只出候选：限流/体积上限可能落在 route 文件、中间件链、边缘网关三层中的
 * 任何一层，静态扫描只能看见 route 文件。「文件里没见到限流形态」不等于没有限流
 * （网关在射程外），所以本守卫是**对账入口**而不是判官：
 *   - 项目把实际生效的限流形态登记进 config.rateLimit.patterns（子串，如
 *     'rateLimit('、'withLimiter'、'@limit'），route 文件命中任一即视为覆盖；
 *   - 网关/边缘统一做的仓：patterns 里登记一条「在 route 文件里必然出现的痕迹」
 *     （如统一 import 的 wrapper），否则本守卫的候选会长期常亮——那就是登记失职。
 *
 * 未登记 patterns = 本判据没有事实来源，显式 NotApplicable，不装绿。
 */

import path from 'node:path'
import { defineGuard, info, warn } from '../lib/guard.ts'
import type { Finding } from '../lib/guard.ts'
import type { QeConfig, RateLimitConfig } from '../lib/config.ts'
import { defaultSourceExtensions } from '../lib/config.ts'
import { readText, walkFiles } from '../lib/fs.ts'
import { NotApplicable } from '../lib/not-applicable.ts'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/inv28-rate-limit')

type ConfigPatch = Partial<QeConfig>

const MUTATION_EXPORT = /export\s+(?:async\s+)?(?:function\s+|const\s+)(?:POST|PUT|PATCH|DELETE)\b/

export const inv28 = defineGuard({
  id: 'inv28-rate-limit',
  title: '变更型服务端入口的速率/体积上限（候选级）',
  invariants: ['INV-SEC-02'],
  blindSpots: [
    '只看得见 route 文件：边缘网关/CDN 层的限流不可见，只能靠 patterns 登记它在 route 层的痕迹',
    'GET（读入口）不判：滥用面同样存在，但体积上限主要卡变更型；读入口限流未纳入',
    '子串匹配不校验语义：rateLimit( 被注释掉也算命中（注释里的形态是假覆盖，需人工抽查）',
    'server actions（非 route 文件）不在射程',
  ],
  async run(ctx) {
    const rl = ctx.config.rateLimit
    if (!rl || rl.patterns.length === 0) {
      throw new NotApplicable(
        'RATELIMIT_UNDECLARED',
        '未登记限流形态（config.rateLimit.patterns）：速率/体积上限本轮未检查——这不是干净',
      )
    }
    const blanks = rl.patterns.filter((p) => !p.trim())
    const patterns = rl.patterns.filter((p) => p.trim())
    const routeRoots = rl.routeRoots?.length ? rl.routeRoots : ['app', 'src/app']
    const extensions = ctx.config.source.extensions.length ? ctx.config.source.extensions : defaultSourceExtensions
    const batches = await Promise.all(routeRoots.map((dir) => walkFiles(ctx.root, dir, { ignore: ctx.config.ignore, ext: extensions })))
    const routeFiles = [...new Set(batches.flat())]
      .map((f) => path.relative(ctx.root, f).split(path.sep).join('/'))
      .filter((rel) => rel.includes('/api/') && /(^|\/)route\.(?:ts|tsx|js|jsx)$/.test(rel))
      .sort()

    const findings: Finding[] = []
    for (const _ of blanks) {
      findings.push(warn('RATELIMIT_PATTERN_BLANK', 'rateLimit.patterns 里有空形态：登记占位等同豁免槽，删或补全'))
    }
    if (routeFiles.length === 0) {
      findings.push(
        warn('RATE_LIMIT_ZERO_ROUTES', `路由根 ${routeRoots.join('/')} 下扫到 0 个 route 文件：空集恒真不算绿（无服务端入口的仓应关掉本判据而非享受绿灯）`),
      )
      return { findings, scanned: `routeFiles=0 patterns=${patterns.length}` }
    }

    let mutations = 0
    let covered = 0
    let unverified = 0
    for (const rel of routeFiles) {
      const text = await readText(path.join(ctx.root, rel))
      if (!MUTATION_EXPORT.test(text)) continue
      mutations++
      if (patterns.some((p) => text.includes(p))) {
        covered++
      } else {
        unverified++
        findings.push(
          warn(
            'RATE_LIMIT_UNVERIFIED',
            `${rel} 有变更型入口但未命中任何已登记限流形态：若在网关/中间件统一做，把 route 层可见的痕迹登记进 config.rateLimit.patterns`,
            { file: rel },
          ),
        )
      }
    }
    if (unverified === 0) {
      findings.push(info('RATE_LIMIT_CLEAN', `变更型 route ${mutations} 个全部命中已登记限流形态（route 文件共 ${routeFiles.length} 个）`))
    }
    return {
      findings,
      scanned: `routeFiles=${routeFiles.length} mutations=${mutations} covered=${covered} unverified=${unverified} patterns=${patterns.length}`,
    }
  },
  selfTest: [
    {
      name: 'good：POST 入口命中已登记限流形态',
      root: path.join(FIXTURES, 'good'),
      expect: 'green',
      config: { rateLimit: { patterns: ['rateLimit('] } } as ConfigPatch,
    },
    {
      name: 'warn：POST 入口未命中限流形态（GET-only 入口不判）',
      root: path.join(FIXTURES, 'bad'),
      expect: 'warn',
      minWarnings: 1,
      maxWarnings: 1,
      config: { rateLimit: { patterns: ['rateLimit('] } } as ConfigPatch,
    },
    {
      name: 'warn：路由根下 0 个 route 文件（空集恒真不是绿）',
      root: path.join(FIXTURES, 'empty'),
      expect: 'warn',
      minWarnings: 1,
      maxWarnings: 1,
      config: { rateLimit: { patterns: ['rateLimit('] } } as ConfigPatch,
    },
  ],
})
