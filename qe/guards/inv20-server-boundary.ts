import path from 'node:path'
import { defineGuard, err, info, warn } from '../lib/guard.ts'
import { NotApplicable } from '../lib/not-applicable.ts'
import { collectorFor } from '../lib/providers.ts'
import { bodyTextOf, exportedFunctions, hasDirective, requireTs, sfOf } from '../lib/ast-utils.ts'
import type { ExportedFunction } from '../lib/ast-utils.ts'
import type { SourceFileInfo } from '../lib/providers.ts'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/inv20-server-boundary')

/** 默认词表可被 qe.config.json 的 boundaries 覆盖（仓级词表与通用词表分离） */
const DEFAULT_AUTH = [
  'getServerSession',
  'currentUser',
  'requireAuth',
  'requireUser',
  'assertAuth',
  'assertUser',
  'getSession',
  'withAuth',
  'session.user',
]
const DEFAULT_VALIDATE = ['z.object', 'safeParse', '.parse(', 'validate(', 'parseBody', "'zod'", '"zod"']
const DEFAULT_MUTATION = ['POST', 'PUT', 'PATCH', 'DELETE']
const IDEMPOTENCY = ['Idempotency-Key', 'idempotencyKey', 'idempotent', 'requestId', 'dedupe']
const ROUTE_FILE = /(^|\/)app\/(?:.+\/)?route\.[cm]?[jt]sx?$/
const METHODS = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/

interface Entry {
  rel: string
  line: number
  name: string
  kind: 'route' | 'action'
  mutation: boolean
}

export const inv20 = defineGuard({
  id: 'inv20-server-boundary',
  title: 'Next.js 服务端入口边界（鉴权 / 校验 / 幂等）',
  invariants: ['INV-WEB-01', 'INV-WEB-02', 'INV-WEB-03', 'INV-WEB-04'],
  blindSpots: [
    "只认 app/**/route.ts 的方法导出与 'use server' 文件的具名导出；export default、pages/api、middleware 不在射程",
    '鉴权/校验是函数体词表命中，不校验判据是否覆盖全部分支（有校验但只在一条路径生效仍算绿）',
    '幂等只认字面标记，未验证服务端去重实现与 DB 唯一键是否真的存在',
    '公共路由按 qe.config.json 的 boundaries.publicRoutes 登记，未登记的公共入口仍会被判红',
  ],
  async run(ctx) {
    requireTs(ctx.config)
    const sources = await collectorFor(ctx.config).loadSources(ctx.root, ctx.config)
    const authPatterns = ctx.config.boundaries?.authPatterns?.length ? ctx.config.boundaries.authPatterns : DEFAULT_AUTH
    const validatePatterns = ctx.config.boundaries?.validatePatterns?.length
      ? ctx.config.boundaries.validatePatterns
      : DEFAULT_VALIDATE
    const mutationMethods = ctx.config.boundaries?.mutationMethods?.length
      ? ctx.config.boundaries.mutationMethods
      : DEFAULT_MUTATION
    const publicRoutes = ctx.config.boundaries?.publicRoutes ?? []

    const entries: { entry: Entry; fn: ExportedFunction; sf: SourceFileInfo }[] = []
    for (const src of sources) {
      const sf = sfOf(src)
      if (ROUTE_FILE.test(src.rel)) {
        for (const fn of exportedFunctions(sf)) {
          const method = fn.name.toUpperCase()
          if (!METHODS.test(method)) continue
          entries.push({
            entry: {
              rel: src.rel,
              line: fn.line,
              name: method,
              kind: 'route',
              mutation: mutationMethods.includes(method),
            },
            fn,
            sf: src,
          })
        }
        continue
      }
      if (hasDirective(sf, 'use server')) {
        for (const fn of exportedFunctions(sf)) {
          entries.push({
            entry: { rel: src.rel, line: fn.line, name: fn.name, kind: 'action', mutation: true },
            fn,
            sf: src,
          })
        }
      }
    }

    if (entries.length === 0) {
      throw new NotApplicable('NO_SERVER_ENTRY', '未发现 Next.js 服务端入口（app/**/route.ts 或 use server）：本守卫不适用，不报绿')
    }

    const findings = []
    const matchedPublic = new Set<string>()
    for (const { entry, fn, sf } of entries) {
      const body = bodyTextOf(fn, sfOf(sf))
      // 登记可精确到方法：同一文件里匿名面（能力发现 GET）与鉴权面（写入 POST）并存时，
      // 整文件豁免会把鉴权面的覆盖一起丢掉，那是把判据关掉而不是把误报消掉。
      const publicRule = publicRoutes.find(
        (r) =>
          (entry.rel === r.file || entry.rel.endsWith('/' + r.file)) &&
          (!r.methods?.length || r.methods.map((m) => m.toUpperCase()).includes(entry.name)),
      )
      const isPublic = Boolean(publicRule)
      if (publicRule) {
        matchedPublic.add(publicRule.file)
        if (!publicRule.reason.trim()) {
          findings.push(
            err('PUBLIC_NO_REASON', `${entry.rel} 登记为公共路由但未写理由：豁免必须写明理由`, {
              file: entry.rel,
              line: entry.line,
              entity: entry.name,
            }),
          )
        }
      }
      if (!isPublic && !authPatterns.some((p) => body.includes(p))) {
        findings.push(
          err('ENTRY_NO_AUTH', `${entry.rel}#${entry.name} 无鉴权判据（词表 ${authPatterns.length} 条均未命中）：对抗环境下即匿名可打`, {
            file: entry.rel,
            line: entry.line,
            entity: entry.name,
          }),
        )
      }
      if (entry.mutation && !validatePatterns.some((p) => body.includes(p))) {
        findings.push(
          err('ENTRY_NO_VALIDATE', `${entry.rel}#${entry.name} 变更入口未对输入做 schema 校验：恶意体可直接进业务`, {
            file: entry.rel,
            line: entry.line,
            entity: entry.name,
          }),
        )
      }
      if (entry.kind === 'route' && entry.mutation && !IDEMPOTENCY.some((p) => body.includes(p))) {
        findings.push(
          warn('MUTATION_NO_IDEMPOTENCY', `${entry.rel}#${entry.name} 变更入口无幂等标记：双提交/重放会重复扣减`, {
            file: entry.rel,
            line: entry.line,
            entity: entry.name,
          }),
        )
      }
    }
    for (const rule of publicRoutes) {
      if (!matchedPublic.has(rule.file)) {
        findings.push(warn('PUBLIC_ROUTE_STALE', `公共路由登记 ${rule.file} 未命中任何入口（登记过期）`, { file: rule.file }))
      }
    }

    if (findings.length === 0) {
      findings.push(info('BOUNDARY_CLEAN', `服务端入口 ${entries.length} 个，鉴权/校验/幂等齐全`))
    }
    return {
      findings,
      scanned: `files=${sources.length} entries=${entries.length} routes=${entries.filter((e) => e.entry.kind === 'route').length} actions=${entries.filter((e) => e.entry.kind === 'action').length} public=${publicRoutes.length}`,
    }
  },
  selfTest: [
    {
      name: 'good：入口带鉴权 + 校验 + 幂等键',
      root: path.join(FIXTURES, 'good'),
      expect: 'green',
      config: { source: { collector: 'ts', roots: ['app'], extensions: [] } },
    },
    {
      name: 'bad：变更入口无鉴权/校验/幂等 + 公共路由空理由',
      root: path.join(FIXTURES, 'bad'),
      expect: 'red',
      minErrors: 3,
      minWarnings: 1,
      config: {
        source: { collector: 'ts', roots: ['app'], extensions: [] },
        boundaries: {
          publicRoutes: [{ file: 'app/api/public/route.ts', reason: '' }],
        },
      },
    },
    {
      name: 'good：公共登记精确到方法（GET 匿名、POST 鉴权），整文件豁免的旧判据会漏掉 POST',
      root: path.join(FIXTURES, 'partial'),
      expect: 'green',
      config: {
        source: { collector: 'ts', roots: ['app'], extensions: [] },
        boundaries: {
          publicRoutes: [
            { file: 'app/api/mixed/route.ts', reason: '能力发现面：只返回服务名与工具清单，不含租户数据', methods: ['GET'] },
          ],
        },
      },
    },
  ],
})
