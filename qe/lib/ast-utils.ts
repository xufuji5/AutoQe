import path from 'node:path'
import ts from 'typescript'
import { NotApplicable } from './not-applicable.ts'
import type { QeConfig } from './config.ts'
import type { SourceFileInfo } from './providers.ts'

/** Next.js 类守卫依赖 TS AST：采集器不是 ts 时显式跳过，不报绿 */
export function requireTs(config: QeConfig): void {
  if (config.source.collector !== 'ts') {
    throw new NotApplicable(`source.collector=${config.source.collector}：本守卫仅支持 TS/TSX 采集器`)
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
