import path from 'node:path'
import { defineGuard, err, info, warn } from '../lib/guard.ts'
import { NotApplicable } from '../lib/not-applicable.ts'
import { collectorFor } from '../lib/providers.ts'
import { hasDirective, importSpecs, requireTs, resolveRelativeImport, sfOf } from '../lib/ast-utils.ts'
import type { SourceFileInfo } from '../lib/providers.ts'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/inv21-seam-import')

const DEFAULT_MODULES = ['src/features', 'src/modules']
/** 客户端/边缘运行时不可触达的包与内建模块 */
const SERVER_ONLY_SPECS: { test: RegExp; why: string }[] = [
  { test: /^server-only$/, why: 'server-only 标记' },
  { test: /^@prisma\/client(\/|$)/, why: 'Prisma Client' },
  { test: /^next\/headers$/, why: 'next/headers' },
  { test: /^next\/server$/, why: 'next/server' },
  { test: /^node:/, why: 'node 内建模块' },
  { test: /^(fs|path|crypto)(\/|$)/, why: 'node 内建模块' },
]
const SERVERISH_TEXT = ['new PrismaClient', '@prisma/client', "from 'server-only'", '"server-only"']

export const inv21 = defineGuard({
  id: 'inv21-seam-import',
  title: '客户端/服务端接缝与跨模块深导入',
  invariants: ['INV-SEC-01', 'INV-SEAM-01'],
  blindSpots: [
    '只解析相对路径导入；@/ 等 tsconfig 别名、barrel 再导出、动态 import() 不在射程',
    '服务端判定基于目标文件文本（PrismaClient / server-only），不做完整依赖图传播',
    '跨模块判定按 stores.moduleRoots 的目录前缀，未配置的目录不参与',
    'import type 已放行（类型擦除后不进运行时），因此类型层耦合不判红',
  ],
  async run(ctx) {
    requireTs(ctx.config)
    const sources = await collectorFor(ctx.config).loadSources(ctx.root, ctx.config)
    if (sources.length === 0) {
      throw new NotApplicable(`source.roots=${ctx.config.source.roots.join(',')} 下 0 个文件：接缝判据不适用`)
    }
    const byRel = new Map<string, SourceFileInfo>(sources.map((s) => [s.rel, s]))
    const known = new Set(byRel.keys())
    const moduleRoots = ctx.config.stores?.moduleRoots?.length ? ctx.config.stores.moduleRoots : DEFAULT_MODULES
    const findings = []
    let clientFiles = 0
    let importCount = 0
    let crossModule = 0

    for (const src of sources) {
      const sf = sfOf(src)
      const isClient = hasDirective(sf, 'use client')
      if (isClient) clientFiles++
      const imports = importSpecs(sf)
      importCount += imports.length

      for (const imp of imports) {
        if (imp.typeOnly) continue
        if (isClient) {
          const block = SERVER_ONLY_SPECS.find((b) => b.test.test(imp.spec))
          if (block) {
            findings.push(
              err('CLIENT_IMPORTS_SERVER', `${src.rel}:${imp.line} 客户端组件导入 ${imp.spec}（${block.why}）：服务端代码会被打进客户端包`, {
                file: src.rel,
                line: imp.line,
                entity: imp.spec,
              }),
            )
          }
          const targetRel = resolveRelativeImport(src.rel, imp.spec, known)
          const target = targetRel ? byRel.get(targetRel) : undefined
          if (target && SERVERISH_TEXT.some((t) => target.text.includes(t))) {
            findings.push(
              err('CLIENT_TOUCHES_SERVER', `${src.rel}:${imp.line} 客户端组件经 ${imp.spec} 触达服务端实现（${target.rel}）：接缝泄漏`, {
                file: src.rel,
                line: imp.line,
                entity: target.rel,
              }),
            )
          }
        }

        const targetRel = resolveRelativeImport(src.rel, imp.spec, known)
        if (!targetRel) continue
        const fromModule = moduleDirOf(src.rel, moduleRoots)
        const toModule = moduleDirOf(targetRel, moduleRoots)
        if (fromModule && toModule && fromModule !== toModule) {
          crossModule++
          findings.push(
            warn('CROSS_MODULE_RELATIVE', `${src.rel}:${imp.line} 用相对路径跨模块导入 ${imp.spec}（应走公开入口或别名）`, {
              file: src.rel,
              line: imp.line,
              entity: `${fromModule} -> ${toModule}`,
            }),
          )
        }
      }
    }

    if (findings.length === 0) {
      findings.push(info('SEAM_CLEAN', `客户端文件 ${clientFiles} 个，导入 ${importCount} 条，无跨层/跨模块泄漏`))
    }
    return {
      findings,
      scanned: `files=${sources.length} clientFiles=${clientFiles} imports=${importCount} crossModule=${crossModule} modules=${moduleRoots.join('+')}`,
    }
  },
  selfTest: [
    {
      name: 'good：类型导入放行、模块内相对导入放行',
      root: path.join(FIXTURES, 'good'),
      expect: 'green',
      config: { source: { collector: 'ts', roots: ['src'], extensions: [] } },
    },
    {
      name: 'bad：客户端直连 Prisma + 跨模块相对深导入',
      root: path.join(FIXTURES, 'bad'),
      expect: 'red',
      minErrors: 2,
      minWarnings: 1,
      config: { source: { collector: 'ts', roots: ['src'], extensions: [] } },
    },
  ],
})

/** 文件所属模块目录：moduleRoots/<module> 的第一层 */
function moduleDirOf(rel: string, moduleRoots: string[]): string | null {
  for (const root of moduleRoots) {
    const clean = root.replace(/\/+$/, '')
    if (rel === clean || !rel.startsWith(clean + '/')) continue
    const rest = rel.slice(clean.length + 1)
    const seg = rest.split('/')[0]
    if (!seg || !rest.includes('/')) return null
    return `${clean}/${seg}`
  }
  return null
}
