import path from 'node:path'
import { defineGuard, err, info, warn } from '../lib/guard.ts'
import { NotApplicable } from '../lib/not-applicable.ts'
import { collectorFor } from '../lib/providers.ts'
import {
  hasDirective,
  importSpecs,
  loadAliasConfig,
  requireTs,
  resolveImport,
  sfOf,
} from '../lib/ast-utils.ts'
import { stripComments } from '../lib/code-only.ts'
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
/**
 * 服务端实现特征：先剥注释，只认代码形态。
 * 旧实现直接在原文里找 `@prisma/client`，把「注释里描述这个包」的文件判成服务端实现
 * （外部试点 A 基线：components/ui.tsx 的注释触发 13 条假红）。
 */
function serverishText(text: string): boolean {
  const code = stripComments(text)
  return (
    /\bnew\s+PrismaClient\b/.test(code) ||
    /\brequire\s*\(\s*['"]@prisma\/client(\/|['"])/.test(code) ||
    /\bfrom\s+['"]server-only['"]/.test(code)
  )
}

export const inv21 = defineGuard({
  id: 'inv21-seam-import',
  title: '客户端/服务端接缝与跨模块深导入',
  invariants: ['INV-SEC-01', 'INV-SEAM-01'],
  blindSpots: [
    '相对路径与 tsconfig/jsconfig paths 别名可解析；barrel 再导出最多追 4 层，动态 import() 不在射程',
    '服务端判定基于代码面文本（new PrismaClient / require / server-only），不做完整类型级依赖图；直接目标判 error，隔 hop 判 warn（打包器可摇树）',
    'use-server 模块是 RPC 边界，导入它不算泄漏',
    '跨模块判定按 stores.moduleRoots 的目录前缀，未配置的目录不参与',
    'import type 已放行（类型擦除后不进运行时），因此类型层耦合不判红',
  ],
  async run(ctx) {
    requireTs(ctx.config)
    const sources = await collectorFor(ctx.config).loadSources(ctx.root, ctx.config)
    if (sources.length === 0) {
      throw new NotApplicable('SOURCE_ROOTS_EMPTY', `source.roots=${ctx.config.source.roots.join(',')} 下 0 个文件：接缝判据不适用`)
    }
    const byRel = new Map<string, SourceFileInfo>(sources.map((s) => [s.rel, s]))
    const known = new Set(byRel.keys())
    const aliases = loadAliasConfig(ctx.root)
    const serverCache = new Map<string, boolean>()
    /** 目标文件或其 barrel 再导出链是否触达服务端实现（最多 4 层，防环） */
    const reachesServer = (targetRel: string, depth: number, stack: Set<string>): boolean => {
      const cached = serverCache.get(targetRel)
      if (cached !== undefined) return cached
      const src = byRel.get(targetRel)
      if (!src) return false
      // 'use server' 模块是 RPC 边界：客户端只拿到可调用桩，不会把实现打进包
      if (hasDirective(sfOf(src), 'use server')) {
        serverCache.set(targetRel, false)
        return false
      }
      if (serverishText(src.text)) {
        serverCache.set(targetRel, true)
        return true
      }
      if (depth <= 0) return false
      for (const imp of importSpecs(sfOf(src))) {
        if (imp.typeOnly) continue
        if (SERVER_ONLY_SPECS.some((b) => b.test.test(imp.spec))) {
          serverCache.set(targetRel, true)
          return true
        }
        const next = resolveImport(targetRel, imp.spec, known, aliases)
        if (!next || stack.has(next)) continue
        stack.add(next)
        const hit = reachesServer(next, depth - 1, stack)
        stack.delete(next)
        if (hit) {
          serverCache.set(targetRel, true)
          return true
        }
      }
      serverCache.set(targetRel, false)
      return false
    }
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
        const targetRel = resolveImport(src.rel, imp.spec, known, aliases)
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
          } else if (targetRel && reachesServer(targetRel, 4, new Set([src.rel]))) {
            const direct = byRel.get(targetRel)
            // 直接目标就是服务端实现 → 铁定泄漏；隔 hop 才触达 → 打包器可能摇树，降为 warn 待人工确认
            const isDirect = direct ? serverishText(direct.text) : false
            const message = `${src.rel}:${imp.line} 客户端组件经 ${imp.spec} 触达服务端实现（${targetRel}）：${isDirect ? '接缝泄漏' : '间接依赖链含服务端模块（打包器可摇树，需人工确认）'}`
            if (isDirect) {
              findings.push(err('CLIENT_TOUCHES_SERVER', message, { file: src.rel, line: imp.line, entity: targetRel }))
            } else {
              findings.push(warn('CLIENT_TRANSITIVE_SERVER', message, { file: src.rel, line: imp.line, entity: targetRel }))
            }
          }
        }

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
    {
      name: 'good：目标文件只在注释里提到服务端实现（旧判据按原文匹配会假红）',
      root: path.join(FIXTURES, 'comment'),
      expect: 'green',
      config: { source: { collector: 'ts', roots: ['src'], extensions: [] } },
    },
    {
      name: 'bad：客户端经 tsconfig paths 别名触达服务端实现（旧判据解析不到别名）',
      root: path.join(FIXTURES, 'alias'),
      expect: 'red',
      minErrors: 1,
      config: { source: { collector: 'ts', roots: ['src'], extensions: [] } },
    },
    {
      name: 'warn：客户端经 barrel 再导出链触达服务端实现（旧判据只看直接目标；隔 hop 降为 warn）',
      root: path.join(FIXTURES, 'barrel'),
      expect: 'warn',
      minWarnings: 1,
      config: { source: { collector: 'ts', roots: ['src'], extensions: [] } },
    },
    {
      name: 'good：客户端导入 use-server 动作模块不算接缝泄漏（RPC 边界）',
      root: path.join(FIXTURES, 'server-action'),
      expect: 'green',
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
