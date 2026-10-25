import ts from 'typescript'
import path from 'node:path'
import { readText, rel, walkFiles } from './fs.ts'
import { defaultSourceExtensions } from './config.ts'
import { recordStage } from './profile.ts'
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

/**
 * 进程内文件缓存：inv03 / inv20 / inv21 / inv22 各自调用一次 loadSources，
 * 不缓存就要把同一批文件读四遍、解析四遍。同一进程内文件不会变，按绝对路径缓存即可。
 * 只共享 text 与 ast（守卫只读），每次仍返回新的 SourceFileInfo 数组。
 *
 * 跨项目隔离（INV-ISO-03/04）：缓存**按 root 分表**。
 * 不用「一个全局 owner，换 root 就清空」——那在并发扫两个项目时会互相把对方的缓存清掉，
 * 一次 `Promise.all` 就能让两个项目的解析交错。分表之后，并发与顺序执行的结果完全一致。
 * 缓存也不许写盘（磁盘缓存会跨进程存活，等于把 A 的文件带进 B）。
 */
const caches = new Map<string, Map<string, { text: string; ast: ts.SourceFile }>>()

/** 单进程最多同时保留几个项目的 AST（本项目模型是一项目一进程，这里只防误用） */
const MAX_ROOT_CACHES = 8

function cacheFor(root: string): Map<string, { text: string; ast: ts.SourceFile }> {
  const owner = path.resolve(root)
  let cache = caches.get(owner)
  if (cache) return cache
  if (caches.size >= MAX_ROOT_CACHES) {
    const oldest = caches.keys().next().value
    if (oldest !== undefined) caches.delete(oldest)
  }
  cache = new Map()
  caches.set(owner, cache)
  return cache
}

async function loadDirs(root: string, config: QeConfig, dirs: string[]): Promise<SourceFileInfo[]> {
  const cache = cacheFor(root)
  const extensions = config.source.extensions.length ? config.source.extensions : defaultSourceExtensions
  const batches = await Promise.all(
    dirs.map((dir) => walkFiles(root, dir, { ignore: config.ignore, ext: extensions })),
  )
  const files = [...new Set(batches.flat())].sort()
  const tStart = performance.now()
  let readMs = 0
  let parseMs = 0
  let cacheHits = 0
  const out: SourceFileInfo[] = []
  for (const file of files) {
    const cached = cache.get(file)
    if (cached) {
      cacheHits++
      out.push({ file, rel: rel(root, file), text: cached.text, ast: cached.ast })
      continue
    }
    const tRead = performance.now()
    const text = await readText(file)
    readMs += performance.now() - tRead
    const tParse = performance.now()
    const ast = createSourceFile(file, text)
    parseMs += performance.now() - tParse
    cache.set(file, { text, ast })
    out.push({ file, rel: rel(root, file), text, ast })
  }
  recordStage('collect.read', readMs, { files: files.length, hits: cacheHits })
  recordStage('collect.parse', parseMs, { files: files.length, hits: cacheHits })
  recordStage('collect.total', performance.now() - tStart, { files: files.length, hits: cacheHits })
  return out
}

export async function loadTsSources(root: string, config: QeConfig): Promise<SourceFileInfo[]> {
  return loadDirs(root, config, config.source.roots)
}

/**
 * 证据目录：种子/导入/巡检脚本里的写点和枚举使用是真的证据，
 * 但它们不是应用面（不参与路由鉴权、客户端边界等判据）。
 */
export async function loadEvidenceSources(root: string, config: QeConfig): Promise<SourceFileInfo[]> {
  const dirs = config.source.evidenceRoots ?? []
  if (dirs.length === 0) return []
  return loadDirs(root, config, dirs)
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
    // `{ data }` 简写：值就是同名标识符，必须能追到变量定义，否则写点会被漏掉
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name
  }
  return undefined
}

/**
 * 同一文件内的变量初始化表达式（只做一轮本地数据流，不做类型推理）。
 *
 * 必须按「名字 → 多个声明」保存：同一文件里 `const identity = …` 常出现多次（不同函数各自一份），
 * 用平铺 Map 会被最后一个声明覆盖 —— 实测把注册写点解析成了租户开通写点的字段表。
 */
export interface VarInit {
  pos: number
  expr: ts.Expression
}

export type InitEnv = Map<string, VarInit[]>

export function initializerEnv(sf: ts.SourceFile): InitEnv {
  const env: InitEnv = new Map()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const list = env.get(node.name.text) ?? []
      list.push({ pos: node.pos, expr: node.initializer })
      env.set(node.name.text, list)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return env
}

/** 取引用位置之前最近的一次声明（近似词法作用域：同一函数内重名时按先后取最近的） */
function lookupInit(env: InitEnv, name: string, at: number): ts.Expression | undefined {
  const list = env.get(name)
  if (!list) return undefined
  let best: VarInit | undefined
  for (const v of list) {
    if (v.pos <= at && (!best || v.pos > best.pos)) best = v
  }
  return best?.expr
}

export interface ResolvedKeys {
  keys: string[]
  /** 出现无法解析的标识符/展开/函数返回值：字段覆盖未知，不能据此判「零写入」 */
  unknown: boolean
}

function unwrap(expr: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    return unwrap(expr.expression)
  }
  return expr
}

/**
 * 解析写入 data 的字段键：支持对象字面量、本地 const、展开、数组、三元表达式。
 * 追不到的部分标记 unknown，由判据降级为「覆盖未知」而不是「零写入」。
 */
export function resolveObjectKeys(
  input: ts.Expression | undefined,
  env: InitEnv,
  seen = new Set<string>(),
): ResolvedKeys {
  if (!input) return { keys: [], unknown: false }
  const at = input.pos
  const expr = unwrap(input)
  if (ts.isObjectLiteralExpression(expr)) {
    const keys: string[] = []
    let unknown = false
    for (const p of expr.properties) {
      if (ts.isSpreadAssignment(p)) {
        const r = resolveObjectKeys(p.expression, env, seen)
        keys.push(...r.keys)
        unknown ||= r.unknown
        continue
      }
      const name = propName(p)
      if (name) keys.push(name)
      else unknown = true
    }
    return { keys: [...new Set(keys)], unknown }
  }
  if (ts.isIdentifier(expr)) {
    if (seen.has(expr.text)) return { keys: [], unknown: true }
    const init = lookupInit(env, expr.text, at)
    if (!init) return { keys: [], unknown: true }
    return resolveObjectKeys(init, env, new Set(seen).add(expr.text))
  }
  if (ts.isArrayLiteralExpression(expr)) {
    const keys: string[] = []
    let unknown = false
    for (const e of expr.elements) {
      if (ts.isSpreadElement(e)) {
        unknown = true
        continue
      }
      const r = resolveObjectKeys(e, env, seen)
      keys.push(...r.keys)
      unknown ||= r.unknown
    }
    return { keys: [...new Set(keys)], unknown }
  }
  if (ts.isConditionalExpression(expr)) {
    const a = resolveObjectKeys(expr.whenTrue, env, seen)
    const b = resolveObjectKeys(expr.whenFalse, env, seen)
    return { keys: [...new Set([...a.keys, ...b.keys])], unknown: a.unknown || b.unknown }
  }
  return { keys: [], unknown: true }
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

/** 去掉括号/断言/await，露出真正的接收者节点（`(await getClient())` → `getClient()`） */
function unwrapReceiver(node: ts.Expression): ts.Expression {
  let cur: ts.Expression = node
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isAwaitExpression(cur)
  ) {
    cur = cur.expression
  }
  return cur
}

/** 接收者名字：标识符 / 属性访问末端 / 函数调用名（`getClient()`、`ctx.getClient()`） */
function receiverName(node: ts.Expression): string {
  const expr = unwrapReceiver(node)
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) return expr.name.text
  if (ts.isCallExpression(expr)) {
    const callee = unwrapReceiver(expr.expression)
    if (ts.isIdentifier(callee)) return callee.text
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text
  }
  return ''
}

/** 识别 <client>.<model>.<method>(...) 形状；client 名单来自 config.schema.clientNames */
function clientMethod(call: ts.CallExpression, clientNames: string[]): { model: string; method: string } | null {
  const expr = call.expression
  if (!ts.isPropertyAccessExpression(expr)) return null
  const method = expr.name.text
  const target = expr.expression
  if (!ts.isPropertyAccessExpression(target)) return null
  const model = target.name.text
  const clientName = receiverName(target.expression)
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

  const visit = (node: ts.Node, sf: ts.SourceFile, file: string, env: InitEnv): void => {
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
          let fieldsUnknown = false
          if (isWrite) {
            if (found.method === 'upsert') {
              const create = resolveObjectKeys(obj ? getProp(obj, 'create') : undefined, env)
              const update = resolveObjectKeys(obj ? getProp(obj, 'update') : undefined, env)
              fields = [...new Set([...create.keys, ...update.keys])]
              fieldsUnknown = create.unknown || update.unknown
            } else {
              const resolved = resolveObjectKeys(obj ? getProp(obj, 'data') : undefined, env)
              fields = resolved.keys
              fieldsUnknown = resolved.unknown
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
            fieldsUnknown,
          })
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, sf, file, env))
  }

  for (const src of sources) {
    const sf = sfOf(src)
    visit(sf, sf, src.rel, initializerEnv(sf))
  }
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
      } else {
        // 枚举值也常写成对象键/映射表键（`{ banned_chem: {...} }`），
        // 只认字符串字面量会把这类合法使用判成「死枚举」。
        const parent = ancestors[ancestors.length - 1]
        const isObjectMember =
          parent &&
          ts.isObjectLiteralExpression(parent) &&
          (ts.isPropertyAssignment(node) ||
            ts.isShorthandPropertyAssignment(node) ||
            ts.isMethodDeclaration(node) ||
            ts.isGetAccessorDeclaration(node) ||
            ts.isSetAccessorDeclaration(node))
        if (isObjectMember) {
          const key = propName(node as ts.ObjectLiteralElementLike)
          const owners = key ? valueToEnums.get(key) : undefined
          if (owners) {
            const context = classifyContext(ancestors, clientNames)
            for (const enumName of owners) push(enumName, key, context, src.rel, lineOf(sf, node))
          }
        }
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
  loadEvidenceSources,
  collectCalls,
  collectEnumUsages,
}
