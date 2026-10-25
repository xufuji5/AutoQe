import { existsSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { NotApplicable } from './not-applicable.ts'
import type { QeConfig } from './config.ts'
import type { SourceFileInfo } from './providers.ts'

/** Next.js 类守卫依赖 TS AST：采集器不是 ts 时显式跳过，不报绿 */
export function requireTs(config: QeConfig): void {
  if (config.source.collector !== 'ts') {
    throw new NotApplicable('COLLECTOR_NOT_TS', `source.collector=${config.source.collector}：本守卫仅支持 TS/TSX 采集器`)
  }
}

export function sfOf(src: SourceFileInfo): ts.SourceFile {
  return src.ast as ts.SourceFile
}

export function hasDirective(sf: ts.SourceFile, directive: 'use client' | 'use server'): boolean {
  for (const stmt of sf.statements) {
    if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) {
      if (stmt.expression.text === directive) return true
      continue
    }
    break
  }
  return false
}

export interface ImportSpec {
  spec: string
  line: number
  /** import type / export type：类型擦除后不进运行时，接缝判据必须放行 */
  typeOnly: boolean
}

export function importSpecs(sf: ts.SourceFile): ImportSpec[] {
  const out: ImportSpec[] = []
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      out.push({
        spec: stmt.moduleSpecifier.text,
        line: sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1,
        typeOnly: stmt.importClause?.isTypeOnly ?? false,
      })
    }
    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      out.push({
        spec: stmt.moduleSpecifier.text,
        line: sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1,
        typeOnly: stmt.isTypeOnly,
      })
    }
  }
  return out
}

export interface AliasRule {
  pattern: string
  target: string
  base: string
}

export interface AliasConfig {
  root: string
  rules: AliasRule[]
}

/**
 * 读 tsconfig/jsconfig 的 paths 别名（不展开 extends，够用于 `@/*` 这类主流写法）。
 * 无 baseUrl 时按 TS 4.1+ 语义相对 tsconfig 所在目录解析。
 */
export function loadAliasConfig(root: string): AliasConfig | null {
  const file = ['tsconfig.json', 'jsconfig.json'].map((f) => path.join(root, f)).find((f) => existsSync(f))
  if (!file) return null
  const read = ts.readConfigFile(file, ts.sys.readFile)
  if (read.error) return null
  const opts = (read.config?.compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> }
  if (!opts.paths || typeof opts.paths !== 'object') return null
  const base = path.resolve(path.dirname(file), opts.baseUrl ?? '.')
  const rules: AliasRule[] = []
  for (const [pattern, targets] of Object.entries(opts.paths)) {
    if (!Array.isArray(targets)) continue
    for (const target of targets) {
      if (typeof target === 'string') rules.push({ pattern, target, base })
    }
  }
  return rules.length > 0 ? { root, rules } : null
}

function candidatePaths(joined: string): string[] {
  return [joined, `${joined}.ts`, `${joined}.tsx`, `${joined}.js`, `${joined}.jsx`, `${joined}/index.ts`, `${joined}/index.tsx`]
}

/** 解析 tsconfig paths 别名；只返回能在已知源文件里落地的那一个 */
export function resolveAliasImport(
  spec: string,
  known: Set<string>,
  aliases: AliasConfig | null,
): string | null {
  if (!aliases) return null
  for (const rule of aliases.rules) {
    const star = rule.pattern.indexOf('*')
    let captured = ''
    if (star >= 0) {
      const pre = rule.pattern.slice(0, star)
      const post = rule.pattern.slice(star + 1)
      if (!spec.startsWith(pre) || !spec.endsWith(post) || spec.length < pre.length + post.length) continue
      captured = spec.slice(pre.length, spec.length - post.length)
    } else {
      if (spec !== rule.pattern) continue
    }
    const abs = path.resolve(rule.base, rule.target.replace('*', captured))
    const joined = path.relative(aliases.root, abs).split(path.sep).join('/')
    if (joined.startsWith('..')) continue
    const hit = candidatePaths(joined).find((c) => known.has(c))
    if (hit) return hit
  }
  return null
}

/** 相对导入 + tsconfig 别名导入的统一入口 */
export function resolveImport(
  fromRel: string,
  spec: string,
  known: Set<string>,
  aliases: AliasConfig | null,
): string | null {
  if (spec.startsWith('.')) return resolveRelativeImport(fromRel, spec, known)
  return resolveAliasImport(spec, known, aliases)
}

/** 把相对导入解析成源文件相对路径；无法确定时返回候选路径，供调用方判定 */
export function resolveRelativeImport(fromRel: string, spec: string, known: Set<string>): string | null {
  if (!spec.startsWith('.')) return null
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec))
  const candidates = [
    joined,
    `${joined}.ts`,
    `${joined}.tsx`,
    `${joined}.js`,
    `${joined}.jsx`,
    `${joined}/index.ts`,
    `${joined}/index.tsx`,
  ]
  return candidates.find((c) => known.has(c)) ?? joined
}

export interface ExportedFunction {
  name: string
  node: ts.FunctionDeclaration | ts.VariableDeclaration
  line: number
}

/** 抓取 export function / export const X = async (...) 两种常见入口写法 */
export function exportedFunctions(sf: ts.SourceFile): ExportedFunction[] {
  const out: ExportedFunction[] = []
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExport(stmt)) {
      out.push({
        name: stmt.name.text,
        node: stmt,
        line: sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1,
      })
    }
    if (ts.isVariableStatement(stmt) && hasExport(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer && isFunctionLike(decl.initializer)) {
          out.push({
            name: decl.name.text,
            node: decl,
            line: sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1,
          })
        }
      }
    }
  }
  return out
}

function hasExport(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  return Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
}

function isFunctionLike(node: ts.Expression): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node)
}

/** 取函数体文本做词表匹配（保守：只看调用形状，不做类型推断） */
export function bodyTextOf(fn: ExportedFunction, sf: ts.SourceFile): string {
  if (ts.isFunctionDeclaration(fn.node) && fn.node.body) return fn.node.body.getText(sf)
  if (ts.isVariableDeclaration(fn.node) && fn.node.initializer && isFunctionLike(fn.node.initializer)) {
    return fn.node.initializer.getText(sf)
  }
  return fn.node.getText(sf)
}
