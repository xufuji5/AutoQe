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
    const moduleDirs = new Set<string>()

    for (const src of sources) {
      const sf = sfOf(src)
      const isClient = hasDirective(sf, 'use client')
      if (isClient) clientFiles++
      const ownModule = moduleDirOf(src.rel, moduleRoots)
      if (ownModule) moduleDirs.add(ownModule)
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
        // 只判**相对路径**跨模块导入：判据自己的文案是「应走公开入口或别名」，
        // 那别名导入就不能同时被判红。第一版把两者都报，在真实仓里制造了 1433 条
        // 「用相对路径跨模块导入 @/lib/…」——文案与判据互相矛盾，整条判据因此失去信用。
        if (!imp.spec.startsWith('.')) continue
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

    // 一个模块都没解析出来 = 跨模块面**没有对象**，此时任何「0 命中」都不是干净，是空集恒真。
    // 只有客户端/服务端面真的报了东西才返回 findings；否则显式跳过（D1：空集不许报绿）。
    if (findings.length === 0 && moduleDirs.size === 0) {
      throw new NotApplicable(
        'NO_MODULE_ROOTS_FOUND',
        `stores.moduleRoots=${moduleRoots.join(',')} 下解析到 0 个模块：跨模块面不适用（客户端/服务端面已扫 ${clientFiles} 个客户端文件、${importCount} 条导入，未发现泄漏）`,
      )
    }
    if (findings.length === 0) {
      findings.push(info('SEAM_CLEAN', `客户端文件 ${clientFiles} 个，导入 ${importCount} 条，跨模块 ${moduleDirs.size} 个模块，无跨层/跨模块泄漏`))
    }
    return {
      findings,
      scanned: `files=${sources.length} clientFiles=${clientFiles} imports=${importCount} crossModule=${crossModule} modules=${moduleRoots.join('+')} resolvedModules=${moduleDirs.size}`,
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
      // 本样本只验客户端/服务端面；模块根显式声明，避免「0 个模块」触发不适用（空集不许报绿）
      config: { source: { collector: 'ts', roots: ['src'], extensions: [] }, stores: { moduleRoots: ['src'] } },
    },
    {
      name: 'bad：客户端经 tsconfig paths 别名触达服务端实现（旧判据解析不到别名）',
      root: path.join(FIXTURES, 'alias'),
      expect: 'red',
      minErrors: 1,
      // 同时钉住「别名跨模块不算相对路径跨模块」：旧判据会在这里多报一条 CROSS_MODULE_RELATIVE，
      // 而判据自己的文案写着「应走公开入口或别名」——文案与判据互相矛盾。
      maxWarnings: 0,
      config: { source: { collector: 'ts', roots: ['src'], extensions: [] }, stores: { moduleRoots: ['src'] } },
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
      // 同上：显式声明模块根，保证「跨模块面」有对象可判
      config: { source: { collector: 'ts', roots: ['src'], extensions: [] }, stores: { moduleRoots: ['src'] } },
    },
    {
      // 反证 D1：模块根解析出 0 个模块时，0 命中是**空集恒真**，必须 skipped 而不是 green。
      // 旧判据在这里返回 SEAM_CLEAN（绿），于是「模块根配错」在读数上与「真的没跨模块导入」一模一样。
      name: 'skip：moduleRoots 下 0 个模块时显式不适用（旧判据在这里假绿）',
      root: path.join(FIXTURES, 'comment'),
      expect: 'skip',
      config: { source: { collector: 'ts', roots: ['src'], extensions: [] }, stores: { moduleRoots: ['src/features', 'src/modules'] } },
    },
  ],
})

/**
 * 文件所属模块目录：moduleRoots/<module> 的第一层。
 *
 * 根目录下的**直接子文件**归属模块根本身（`lib/db.ts` → `lib`）：公共入口/共用工具
 * 常平铺在模块根，把它们判成「不在任何模块」会让跨模块判据漏掉一批真实深导入。
 */
function moduleDirOf(rel: string, moduleRoots: string[]): string | null {
  for (const root of moduleRoots) {
    const clean = root.replace(/\/+$/, '')
    if (rel === clean || !rel.startsWith(clean + '/')) continue
    const rest = rel.slice(clean.length + 1)
    const seg = rest.split('/')[0]
    if (!seg) return null
    if (!rest.includes('/')) return clean
    return `${clean}/${seg}`
  }
  return null
}
