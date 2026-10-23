import ts from 'typescript'
import { readText, rel, walkFiles } from './fs.ts'
import { defaultSourceExtensions } from './config.ts'
import type { QeConfig } from './config.ts'
import type {
  CallCollector,
  DataCall,
  EnumUsage,
  SchemaEnum,
  SchemaSnapshot,
  SourceFileInfo,
} from './providers.ts'

export const WRITE_METHODS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
])

export const READ_METHODS = new Set([
  'findMany',
  'findFirst',
  'findUnique',
  'findFirstOrThrow',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
])

export async function loadTsSources(root: string, config: QeConfig): Promise<SourceFileInfo[]> {
  const extensions = config.source.extensions.length ? config.source.extensions : defaultSourceExtensions
  const batches = await Promise.all(
    config.source.roots.map((dir) => walkFiles(root, dir, { ignore: config.ignore, ext: extensions })),
  )
  const files = [...new Set(batches.flat())].sort()
  const out: SourceFileInfo[] = []
  for (const file of files) {
    const text = await readText(file)
    out.push({ file, rel: rel(root, file), text, ast: createSourceFile(file, text) })
  }
  return out
}

function createSourceFile(file: string, text: string): ts.SourceFile {
  const kind = file.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : file.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : /\.(ts|mts|cts)$/.test(file)
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JS
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
}

function sfOf(src: SourceFileInfo): ts.SourceFile {
  return src.ast as ts.SourceFile
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function propName(p: ts.ObjectLiteralElementLike): string {
  const n = p.name
  if (!n) return ''
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) return n.text
  if (ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text
  if (ts.isComputedPropertyName(n) && ts.isStringLiteral(n.expression)) return n.expression.text
  return ''
}

function getProp(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && propName(p) === name) return p.initializer
  }
  return undefined
}

function keysOf(expr: ts.Expression | undefined): string[] {
  if (!expr) return []
  if (ts.isObjectLiteralExpression(expr)) return expr.properties.map(propName).filter(Boolean)
  if (ts.isArrayLiteralExpression(expr)) {
    const all = expr.elements.flatMap((e) => keysOf(e))
    return [...new Set(all)]
  }
  return []
}

/** 识别 <client>.<model>.<method>(...) 形状；client 名单来自 config.schema.clientNames */
function clientMethod(call: ts.CallExpression, clientNames: string[]): { model: string; method: string } | null {
  const expr = call.expression
  if (!ts.isPropertyAccessExpression(expr)) return null
  const method = expr.name.text
  const target = expr.expression
  if (!ts.isPropertyAccessExpression(target)) return null
  const model = target.name.text
  const base = target.expression
  let clientName = ''
  if (ts.isIdentifier(base)) clientName = base.text
  else if (ts.isPropertyAccessExpression(base) && ts.isIdentifier(base.name)) clientName = base.name.text
  if (!clientNames.includes(clientName)) return null
  return { model, method }
}

export function collectCalls(sources: SourceFileInfo[], schema: SchemaSnapshot, config: QeConfig): DataCall[] {
  const clientNames = config.schema.clientNames
  const byKey = new Map<string, string>()
  for (const m of schema.models) {
    byKey.set(m.name.charAt(0).toLowerCase() + m.name.slice(1), m.name)
    byKey.set(m.name.toLowerCase(), m.name)
  }
  const calls: DataCall[] = []

  const visit = (node: ts.Node, sf: ts.SourceFile, file: string): void => {
    if (ts.isCallExpression(node)) {
      const found = clientMethod(node, clientNames)
      if (found) {
        const modelName = byKey.get(found.model) ?? byKey.get(found.model.toLowerCase())
        const isWrite = WRITE_METHODS.has(found.method)
        const isRead = READ_METHODS.has(found.method)
        if (modelName && (isWrite || isRead)) {
          const arg = node.arguments[0]
          const obj = arg && ts.isObjectLiteralExpression(arg) ? arg : undefined
          let fields: string[] = []
          let hasSelect = false
          if (isWrite) {
            if (found.method === 'upsert') {
              fields = [
                ...new Set([
                  ...keysOf(obj ? getProp(obj, 'create') : undefined),
                  ...keysOf(obj ? getProp(obj, 'update') : undefined),
                ]),
              ]
            } else {
              fields = keysOf(obj ? getProp(obj, 'data') : undefined)
            }
          } else if (obj) {
            const select = getProp(obj, 'select')
            hasSelect = Boolean(select)
            fields = [
              ...new Set([
                ...keysOf(select),
                ...keysOf(getProp(obj, 'where')),
                ...keysOf(getProp(obj, 'orderBy')),
                ...keysOf(getProp(obj, 'cursor')),
                ...keysOf(getProp(obj, 'distinct')),
              ]),
            ]
          }
          calls.push({
            kind: isWrite ? 'write' : 'read',
            model: modelName,
            method: found.method,
            file,
            line: lineOf(sf, node),
            fields,
            hasSelect,
          })
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, sf, file))
  }

  for (const src of sources) visit(sfOf(src), sfOf(src), src.rel)
  return calls
}

export function collectEnumUsages(
  sources: SourceFileInfo[],
  schema: SchemaSnapshot,
  config: QeConfig,
): EnumUsage[] {
  const clientNames = config.schema.clientNames
  const valueToEnums = new Map<string, string[]>()
  const enumValueSets = new Map<string, Set<string>>()
  for (const e of schema.enums) {
    const set = new Set<string>()
    for (const v of e.values) {
      set.add(v.name)
      const list = valueToEnums.get(v.name) ?? []
      list.push(e.name)
      valueToEnums.set(v.name, list)
    }
    enumValueSets.set(e.name, set)
  }

  const out: EnumUsage[] = []
  const seen = new Set<string>()
  const push = (
    enumName: string,
    value: string,
    context: 'write' | 'read' | 'other',
    file: string,
    line: number,
  ): void => {
    const key = `${file}:${line}:${enumName}:${value}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ enumName, value, context, file, line })
  }

  for (const src of sources) {
    const sf = sfOf(src)
    const visit = (node: ts.Node, ancestors: ts.Node[]): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const owners = valueToEnums.get(node.text)
        if (owners) {
          const context = classifyContext(ancestors, clientNames)
          for (const enumName of owners) push(enumName, node.text, context, src.rel, lineOf(sf, node))
        }
      } else if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        enumValueSets.get(node.expression.text)?.has(node.name.text)
      ) {
        push(node.expression.text, node.name.text, classifyContext(ancestors, clientNames), src.rel, lineOf(sf, node))
      }
      ts.forEachChild(node, (child) => visit(child, [...ancestors, node]))
    }
    visit(sf, [])
  }
  return out
}

function classifyContext(ancestors: ts.Node[], clientNames: string[]): 'write' | 'read' | 'other' {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i]
    if (ts.isCallExpression(a)) {
      const found = clientMethod(a, clientNames)
      if (found) {
        if (WRITE_METHODS.has(found.method)) return 'write'
        if (READ_METHODS.has(found.method)) return 'read'
      }
    }
    if (ts.isObjectLiteralExpression(a) && i > 0) {
      const parent = ancestors[i - 1]
      if (ts.isPropertyAssignment(parent)) {
        const name = propName(parent)
        if (name === 'where' || name === 'having' || name === 'select' || name === 'orderBy') return 'read'
      }
    }
    if (ts.isBinaryExpression(a)) {
      const op = a.operatorToken.kind
      if (op === ts.SyntaxKind.EqualsToken) return 'write'
      if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken
      ) {
        return 'read'
      }
    }
    if (ts.isCaseClause(a) || ts.isIfStatement(a) || ts.isSwitchStatement(a)) return 'read'
    if (ts.isReturnStatement(a)) return 'other'
  }
  return 'other'
}

export const tsCollector: CallCollector = {
  id: 'ts',
  loadSources: loadTsSources,
  collectCalls,
  collectEnumUsages,
}
