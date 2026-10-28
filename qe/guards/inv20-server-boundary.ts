import path from 'node:path'
import ts from 'typescript'
import { defineGuard, err, info, warn } from '../lib/guard.ts'
import { NotApplicable } from '../lib/not-applicable.ts'
import { collectorFor } from '../lib/providers.ts'
import { bodyTextOf, exportedFunctions, hasDirective, loadAliasConfig, requireTs, resolveImport, sfOf } from '../lib/ast-utils.ts'
import type { ExportedFunction } from '../lib/ast-utils.ts'
import type { SourceFileInfo } from '../lib/providers.ts'
import { loadSchemaFacts } from '../lib/rule-guard.ts'
import { authVocabulary, hasAuthEvidence } from '../lib/auth-evidence.ts'
import { classifyDuplicateRisk, DUPLICATE_RISK_LABEL, parseWriteTables } from '../lib/schema-facts.ts'
import type { SchemaFacts } from '../lib/schema-facts.ts'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/inv20-server-boundary')

/**
 * 入口体 + 同文件一跳 helper 体：鉴权常写在 `authUser(req)` / `loadOwned(req, id)` 这类
 * 同文件封装里。只给入口体判，会把「鉴权在隔壁 20 行」的路由报成裸奔（真实仓实测）。
 *
 * 只做一跳、只认本文件：封装在依赖里的鉴权静态不可见，继续追等于把「猜」写成「证」。
 */
function authScopeText(body: string, sf: ts.SourceFile): string {
  const helpers = localFunctionBodies(sf)
  const parts = [body]
  for (const name of calledNames(body)) {
    const helper = helpers.get(name)
    if (helper) parts.push(helper)
  }
  return parts.join('\n')
}
/**
 * 校验词表。
 *
 * 旧词表含 `'.parse('` 与 `'zod'`：前者会被 `JSON.parse(` 命中（解析 ≠ 校验），
 * 后者会被 `import { z } from 'zod'` 命中（引入库 ≠ 对输入校验），两条都会把
 * 「完全没校验」的入口判成绿。现在 `.parse(` 单独用否定后视排除 `JSON.parse`，
 * `'zod'` 已移出默认词表。
 */
const DEFAULT_VALIDATE = ['.parse(', '.parseAsync(', '.safeParse(', 'z.object', 'validate(', 'parseBody']
const DEFAULT_MUTATION = ['POST', 'PUT', 'PATCH', 'DELETE']
/** 幂等只对可能被重复提交的创建/更新方法要求；DELETE 天然幂等，动作型 POST 除外 */
const IDEMPOTENT_METHODS = ['POST', 'PUT', 'PATCH']
const IDEMPOTENCY = ['Idempotency-Key', 'idempotencyKey', 'idempotent', 'requestId', 'dedupe']
/**
 * 服务层幂等证据词表（默认）。这些词是「重复提交不会产生第二份副作用」的静态痕迹：
 * 咨询锁串行化 / 唯一键 upsert / 条件更新 CAS / 冲突码映射 / 内容寻址去重。
 * 仓级特有写法（如自研 `beginIdempotent`）走 `boundaries.idempotencyEvidence` 追加。
 */
const DEFAULT_IDEMPOTENCY_EVIDENCE = [
  'pg_advisory',
  'advisory_xact_lock',
  '.upsert(',
  '.updateMany(',
  'skipDuplicates',
  'P2002',
  'ON CONFLICT',
  'ON CONFLICT DO NOTHING',
  'idempot',
]
/**
 * 写证据词表：回答「这个变更入口到底有没有副作用」。
 * 只有整条可解析射程（入口体 + 同文件 helper + 服务函数）**完全**没有写痕迹时，
 * 才把幂等要求降为 info（`MUTATION_READONLY`）——没写就没有第二份副作用可去重。
 * 射程上任何静态不可见处（命名空间导入、解析不到的导入、找不到具名导出）都按
 * 「可能有写」处理，仍报未证明：豁免必须能证明，不能靠猜。
 */
const WRITE_CALLS = [
  '.create(',
  '.createMany(',
  '.update(',
  '.updateMany(',
  '.upsert(',
  '.delete(',
  '.deleteMany(',
  '.execute(',
  'transition(',
]
/**
 * raw SQL 的执行形态单独判（不在 WRITE_CALLS 里按子串算）：
 * `$executeRaw` 是「执行任意 SQL」，租户事务第一句 `SELECT set_config('app.current_tenant', …)`
 * 也走它——按调用名一律算写，会把所有带 RLS 上下文的只读入口顶成「有写痕迹」。
 */
const RAW_EXEC_UNSAFE = /\$(?:executeRawUnsafe)\s*\(|\bExecuteRawUnsafe\s*\(/
const RAW_EXEC_DYNAMIC = /\$executeRaw\s*\(/
const RAW_EXEC_TAGGED = /\$executeRaw\s*`/
/**
 * 摘要计算里的 `.update(` 不是库写：`createHash('sha256').update(buf).digest('hex')` 是纯计算，
 * 按子串匹配会被当成「更新一行」。只剥离「哈希工厂调用后紧跟 .update(」这一形态，
 * 其余 `.update(` 仍按写算（宁可漏剥，不可错剥）。
 */
const HASH_CHAIN = /\b(?:createHash|createHmac)\s*\([^)]*\)\s*\.\s*update\s*\(/g
/**
 * 留痕写（审计 / 拒绝路径）的函数名。
 *
 * 这类函数体里的 `.create(` 是安全留痕：权限校验失败时也会写一条 deny 日志，
 * 双提交多一条留痕不是「重复扣减」。把它们与业务写混在一起，会把
 * 「唯一可见写是拒绝日志」的入口报成「重复证据风险（auditevent 无唯一约束）」——
 * 方向反了，还把人引去改根本不存在的业务写。
 *
 * 也不能因此判只读：留痕本身仍是写，入口是否真的无业务写需人工确认（判 `audit-trace`）。
 * 仓级特有封装走 `boundaries.auditWriteCalls` 追加。
 */
const DEFAULT_AUDIT_WRITE_CALLS = ['logAccessDeny', 'writeAuditEvent', 'recordAuditEvent', 'appendAudit', 'logAccess']
const WRITE_SQL = [/INSERT\s+INTO/i, /DELETE\s+FROM/i, /UPDATE\s+[A-Za-z_"`]/, /CREATE\s+(?:TABLE|INDEX|UNIQUE)/i]
/**
 * 写痕迹里的 Prisma 调用形态：`<client>.<model>.<writeMethod>(`。
 *
 * 这是「落表分档」的唯一入口：只有解析得出模型名，才能去 schema 事实里查这张表挡不挡双写。
 * client 名走 `config.schema.clientNames`（默认 `prisma / db / tx`），仓里换别名就在配置里补。
 */
const WRITE_METHODS = ['create', 'createMany', 'upsert', 'update', 'updateMany', 'delete', 'deleteMany']
function writeTargetRe(clientNames: string[]): RegExp {
  const names = (clientNames.length > 0 ? clientNames : ['prisma', 'db', 'tx']).map((n) =>
    n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  )
  return new RegExp(`\\b(?:${names.join('|')})\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\.\\s*(?:${WRITE_METHODS.join('|')})\\s*\\(`, 'g')
}
const ROUTE_FILE = /(^|\/)app\/(?:.+\/)?route\.[cm]?[jt]sx?$/
const METHODS = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/
/** 真正读取请求体的调用：`Response.json(` 不算 */
const REQUEST_BODY_READ = /\b(?:request|req)\s*\.\s*(?:json|formData|text|arrayBuffer|blob)\s*\(/
const CALL_NAME = /\b([A-Za-z_$][\w$]*)\s*\(/g

interface Entry {
  rel: string
  line: number
  name: string
  kind: 'route' | 'action'
  mutation: boolean
}

/**
 * 静态方法桩 / 探活面：入口体只有一条 `return`，返回值**完全由字面量构成**
 * （`new Response(null, { status: 405, headers: { Allow: 'POST' } })` 或
 * `Response.json({ ok: true })`）。
 *
 * 这种 handler 的响应与调用者身份无关：不读请求输入、不引用任何标识符，
 * 鉴权在它身上没有可守的对象。真实仓实测：`GET` 405 桩与 cron 探活被旧判据
 * 判成「匿名可打」，这类误报会让「裸奔」这个词失去信用。
 *
 * 反证约束（必须可证）：返回值里出现任何标识符（import 的常量、`process.env`）
 * 一律不算桩——那可能把静态敏感内容抄进响应，仍按 ENTRY_NO_AUTH 判。
 */
function literalOnly(node: ts.Node): boolean {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node)) return true
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) {
    return true
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) return ts.isNumericLiteral(node.operand)
  if (ts.isArrayLiteralExpression(node)) return node.elements.every(literalOnly)
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every((p) => ts.isPropertyAssignment(p) && literalOnly(p.initializer))
  }
  return false
}

function staticResponse(expr: ts.Expression): boolean {
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression
    if (!ts.isPropertyAccessExpression(callee)) return false
    if (!ts.isIdentifier(callee.expression) || callee.expression.text !== 'Response' || callee.name.text !== 'json') return false
    if (expr.arguments.length < 1 || expr.arguments.length > 2) return false
    return literalOnly(expr.arguments[0]) && (expr.arguments.length === 1 || literalOnly(expr.arguments[1]))
  }
  if (ts.isNewExpression(expr)) {
    const cls = expr.expression
    if (!ts.isIdentifier(cls) || cls.text !== 'Response' || expr.arguments?.length !== 2) return false
    return literalOnly(expr.arguments[0]) && literalOnly(expr.arguments[1])
  }
  return false
}

function staticStubEntry(fn: ExportedFunction): boolean {
  let body: ts.Block | undefined
  if (ts.isFunctionDeclaration(fn.node)) {
    body = fn.node.body
  } else if (fn.node.initializer && (ts.isArrowFunction(fn.node.initializer) || ts.isFunctionExpression(fn.node.initializer))) {
    const init = fn.node.initializer
    if (ts.isBlock(init.body)) body = init.body
  }
  if (!body) return false
  const stmts = body.statements.filter((s) => !ts.isEmptyStatement(s))
  if (stmts.length !== 1) return false
  const only = stmts[0]
  return ts.isReturnStatement(only) && only.expression !== undefined && staticResponse(only.expression)
}

/** `.parse(` 命中 `JSON.parse(` 时不算校验（解析请求体是读入，不是校验输入） */
function validationHit(text: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p === '.parse(') {
      if (/(?<!JSON)\.parse\(/.test(text)) return true
      continue
    }
    if (text.includes(p)) return true
  }
  return false
}

/**
 * 同文件一跳 helper 追踪：入口体里调了本文件的具名函数，就看那个函数体里有没有校验词。
 * 只做一跳——跨文件/封装在依赖里的校验静态不可见，继续追会把「猜」写成「证」。
 */
function localFunctionBodies(sf: ts.SourceFile): Map<string, string> {
  const map = new Map<string, string>()
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      map.set(stmt.name.text, stmt.body.getText(sf))
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          map.set(decl.name.text, decl.initializer.getText(sf))
        }
      }
    }
  }
  return map
}

function calledNames(body: string): string[] {
  const out = new Set<string>()
  let m: RegExpExecArray | null
  CALL_NAME.lastIndex = 0
  while ((m = CALL_NAME.exec(body)) !== null) out.add(m[1])
  return [...out]
}

/** 入口文件的非类型导入：本地名 → 模块说明符（类型导入运行时不存在，不参与取证） */
function importBindings(sf: ts.SourceFile): Map<string, string> {
  const map = new Map<string, string>()
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const clause = stmt.importClause
    if (!clause || clause.isTypeOnly) continue
    const spec = stmt.moduleSpecifier.text
    if (clause.name) map.set(clause.name.text, spec)
    const named = clause.namedBindings
    if (!named) continue
    if (ts.isNamedImports(named)) {
      for (const el of named.elements) {
        if (!el.isTypeOnly) map.set(el.name.text, spec)
      }
    }
  }
  return map
}

interface EvidenceScope {
  sources: Map<string, SourceFileInfo>
  known: Set<string>
  aliases: ReturnType<typeof loadAliasConfig>
  evidence: string[]
}

/**
 * 服务层幂等取证：从入口体里调用的**导入函数**出发，沿导出函数体找证据词。
 * 只跟「具名调用 → 具名导出」这一种形态：命名空间导入（`svc.fn()`）、高阶包装、
 * 动态 require 静态不可见，直接判为未证明（不猜）。
 * 返回形如 `lib/services/ncr.ts#createNcr(pg_advisory)` 的证据链，空数组 = 未证明。
 */
function serviceEvidence(
  body: string,
  rel: string,
  sf: ts.SourceFile,
  scope: EvidenceScope,
  depth: number,
  visited: Set<string>,
): string[] {
  if (depth <= 0) return []
  const bindings = importBindings(sf)
  const hits: string[] = []
  for (const name of calledNames(body)) {
    const spec = bindings.get(name)
    if (!spec) continue
    const targetRel = resolveImport(rel, spec, scope.known, scope.aliases)
    if (!targetRel) continue
    const target = scope.sources.get(targetRel)
    if (!target) continue
    const key = `${targetRel}#${name}`
    if (visited.has(key)) continue
    visited.add(key)
    const targetSf = sfOf(target)
    const fn = exportedFunctions(targetSf).find((f) => f.name === name) ?? aliasTarget(targetSf, name)
    if (!fn) continue
    const fnBody = bodyTextOf(fn, targetSf)
    const direct = scope.evidence.filter((p) => fnBody.includes(p))
    if (direct.length > 0) {
      hits.push(`${targetRel}#${name}(${direct.join(',')})`)
    } else if (depth > 1) {
      hits.push(...serviceEvidence(fnBody, targetRel, targetSf, scope, depth - 1, visited))
    }
  }
  return hits
}

/**
 * 该模块说明符是否落在被扫描的仓内（相对导入或 tsconfig 别名）。
 * 第三方包（`next/headers`、`zod`…）本来就在静态射程之外，其内部是否写库不可见是
 * 已知盲区，不能因此把每个入口都判成「不可解」——那会让只读豁免永不生效。
 */
function isLocalSpec(spec: string, aliases: ReturnType<typeof loadAliasConfig>): boolean {
  if (spec.startsWith('.')) return true
  if (!aliases) return false
  return aliases.rules.some((rule) => {
    const star = rule.pattern.indexOf('*')
    return star < 0 ? spec === rule.pattern : spec.startsWith(rule.pattern.slice(0, star))
  })
}

interface WriteVerdict {
  /** 命中的写痕迹（形如 `lib/services/ncr.ts#createNcr(.create()`），空 = 未见写 */
  hits: string[]
  /** 静态可解析的 Prisma 模型名（小写前原样）；空 = 落表不可判定，不许当成「无唯一键」 */
  targets: string[]
  /** 留痕写（审计 / 拒绝路径）的命中；不参与业务分档，但足以否定「只读豁免」 */
  auditHits: string[]
  /** 留痕写落在的目标模型名 */
  auditTargets: string[]
  /** raw SQL 里抽出的写目标表名（可能不是 Prisma 模型）：只在报告里据实列出，不参与分档 */
  sqlTables: string[]
  /** 射程上存在静态不可见处：此时「没看到写」不能证明「没有写」，不得豁免 */
  unresolved: boolean
  /** 不可解处的来源（诊断用） */
  why: string[]
}

/**
 * 导出别名追踪：`export const tenantRead: typeof tenantTx = tenantTx` 是变量声明而非函数声明，
 * `exportedFunctions` 抓不到 ⇒ 调用方被判 `no-export`（假盲区）。别名指向同文件真实函数时
 * 可见性并没有丢，应当跟进去看；只跟**一跳同文件别名**，不做跨文件链式追踪（越追越像猜）。
 */
function aliasTarget(sf: ts.SourceFile, name: string): ExportedFunction | null {
  const all = exportedFunctions(sf)
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined
    if (!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== name) continue
      const init = decl.initializer
      if (!init || !ts.isIdentifier(init)) continue
      const target = all.find((f) => f.name === init.text)
      if (target) return target
    }
  }
  return null
}

/**
 * 副作用取证：射程与 `serviceEvidence` 完全一致（入口体 → 同文件 helper → 导入服务函数），
 * 但找的是写痕迹而不是幂等证据。用于区分「只读出口假阳性」与「真·变更入口裸写」。
 */
function writeEvidence(
  body: string,
  rel: string,
  sf: ts.SourceFile,
  scope: EvidenceScope,
  depth: number,
  visited: Set<string>,
  helpers: Map<string, string>,
  targetRe: RegExp,
  facts: SchemaFacts,
  auditCalls: string[],
): WriteVerdict {
  const hits: string[] = []
  const targets = new Set<string>()
  /** 留痕写单独收：它们仍是写（不据此豁免），但不参与业务分档 */
  const auditHits: string[] = []
  const auditTargets = new Set<string>()
  const sqlTables = new Set<string>()
  const why: string[] = []
  let unresolved = false
  const scan = (text: string, label: string, audit = false): void => {
    // 先剥离摘要计算的假写，再按词表扫（`$executeRaw` 不再按调用名算写，见 RAW_EXEC_* 注释）
    const clean = text.replace(HASH_CHAIN, 'HASH_UPDATE(')
    const local = WRITE_CALLS.filter((p) => clean.includes(p))
    if (local.length > 0) (audit ? auditHits : hits).push(`${label}(${local.join(',')})`)
    // raw SQL：字面量表名可解析 → 换回 Prisma 模型名；换不回来就只据实列表名
    const dml = WRITE_SQL.some((re) => re.test(clean))
    if (RAW_EXEC_UNSAFE.test(clean)) (audit ? auditHits : hits).push(`${label}(RAW_UNSAFE)`)
    else if (RAW_EXEC_DYNAMIC.test(clean)) (audit ? auditHits : hits).push(`${label}(RAW_DYNAMIC)`)
    else if (RAW_EXEC_TAGGED.test(clean) && dml) (audit ? auditHits : hits).push(`${label}(RAW_SQL)`)
    const modelSink = audit ? auditTargets : targets
    for (const table of parseWriteTables(clean)) {
      const model = facts.modelByTable.get(table.toLowerCase())
      if (model) modelSink.add(model)
      else sqlTables.add(table)
    }
    targetRe.lastIndex = 0
    let tm: RegExpExecArray | null
    while ((tm = targetRe.exec(clean)) !== null) modelSink.add(tm[1])
  }
  scan(body, `${rel}#body`)
  const bindings = importBindings(sf)
  for (const name of calledNames(body)) {
    if (bindings.has(name)) continue
    const helper = helpers.get(name)
    if (helper) scan(helper, `${rel}#${name}`)
  }
  // 命名空间导入（`import * as svc`）的成员调用静态不可解 → 不能证明无写
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue
    const named = stmt.importClause?.namedBindings
    if (
      named &&
      ts.isNamespaceImport(named) &&
      body.includes(`${named.name.text}.`) &&
      isLocalSpec(stmt.moduleSpecifier.text, scope.aliases)
    ) {
      unresolved = true
      why.push(`namespace:${named.name.text}`)
    }
  }
  if (depth <= 0) {
    // 关掉跨文件取证时，入口体里调用的**仓内**导入函数一律视为「可能写」：看不见就不能证明没有
    for (const name of calledNames(body)) {
      const spec = bindings.get(name)
      if (!spec || !isLocalSpec(spec, scope.aliases)) continue
      unresolved = true
      why.push(`depth0:${name}`)
    }
    return {
      hits,
      targets: [...targets],
      auditHits,
      auditTargets: [...auditTargets],
      sqlTables: [...sqlTables],
      unresolved,
      why,
    }
  }
  for (const name of calledNames(body)) {
    const spec = bindings.get(name)
    if (!spec) continue
    // 第三方包：射程外，不作为「不可见」计入（见 isLocalSpec 注释）
    if (!isLocalSpec(spec, scope.aliases)) continue
    const targetRel = resolveImport(rel, spec, scope.known, scope.aliases)
    const target = targetRel ? scope.sources.get(targetRel) : undefined
    const key = `${targetRel ?? spec}#${name}`
    if (visited.has(key)) continue
    visited.add(key)
    // 导入解析不到源码、或目标模块里找不到同名导出（barrel/重导出/依赖内实现）→ 不可见
    if (!target || !targetRel) {
      unresolved = true
      why.push(`unresolved-import:${name}<${spec}>`)
      continue
    }
    const targetSf = sfOf(target)
    const fn = exportedFunctions(targetSf).find((f) => f.name === name) ?? aliasTarget(targetSf, name)
    if (!fn) {
      unresolved = true
      why.push(`no-export:${targetRel}#${name}`)
      continue
    }
    const fnBody = bodyTextOf(fn, targetSf)
    const label = `${targetRel}#${name}${fn.name === name ? '' : `=${fn.name}`}`
    // 留痕写：只扫它自己的函数体（拒绝路径的写是安全留痕），不计入业务目标，也不据此要求幂等
    if (auditCalls.includes(name)) {
      scan(fnBody, label, true)
      continue
    }
    scan(fnBody, label)
    const nested = writeEvidence(
      fnBody,
      targetRel,
      targetSf,
      scope,
      depth - 1,
      visited,
      localFunctionBodies(targetSf),
      targetRe,
      facts,
      auditCalls,
    )
    hits.push(...nested.hits)
    auditHits.push(...nested.auditHits)
    for (const t of nested.targets) targets.add(t)
    for (const t of nested.auditTargets) auditTargets.add(t)
    for (const t of nested.sqlTables) sqlTables.add(t)
    why.push(...nested.why)
    if (nested.unresolved) unresolved = true
  }
  return {
    hits,
    targets: [...targets],
    auditHits,
    auditTargets: [...auditTargets],
    sqlTables: [...sqlTables],
    unresolved,
    why,
  }
}

export const inv20 = defineGuard({
  id: 'inv20-server-boundary',
  title: 'Next.js 服务端入口边界（鉴权 / 校验 / 幂等）',
  invariants: ['INV-WEB-01', 'INV-WEB-02', 'INV-WEB-03', 'INV-WEB-04'],
  blindSpots: [
    "只认 app/**/route.ts 的方法导出与 'use server' 文件的具名导出；export default、pages/api、middleware 不在射程",
    '鉴权/校验是函数体词表命中，不校验判据是否覆盖全部分支（有校验但只在一条路径生效仍算绿）',
    '校验只对「直接读取请求体」的变更入口要求；DELETE / 动作型 POST 不读体时不判（没有输入可供校验）',
    '同文件一跳 helper 可给校验作证；跨文件 helper、封装在依赖里的校验不可见，此时降为 VALIDATE_NOT_PROVEN 提示（不冒红）',
    '词表已排除 `JSON.parse`（解析 ≠ 校验）；项目自有校验封装需在 boundaries.validatePatterns 追加',
    '幂等先查入口体字面标记；未命中时按「入口调用的导入函数」做服务层证据词表取证（默认两跳）',
    '服务层取证只认证据词在导出函数体里出现，不证明该锁键/唯一键真的覆盖本次竞争面（锁键选错仍会漏）',
    '命名空间导入（`svc.fn()`）、高阶包装、动态 require 不可见，仍判为未证明',
    '只读豁免（MUTATION_READONLY）依据「同射程内无写痕迹」，不证明服务函数内部的依赖（第三方 SDK、ORM 钩子、触发器）是否真的没写；射程内出现不可解导入时一律不豁免',
    '公共路由按 qe.config.json 的 boundaries.publicRoutes 登记，未登记的公共入口仍会被判红',
    '静态桩判据只认「入口体单条 return + 返回值纯字面量」：返回值引用任何标识符（import 的常量、process.env）仍按裸奔判，宁可多报一句也不放过静态抄出的敏感内容',
    "落表分档认两种写目标：`<client>.<model>.<write>(`（client 名取 schema.clientNames）与 raw SQL 字面量表名（`INSERT INTO t` / `UPDATE t SET` / `DELETE FROM t`，表名经 schema 的 `@@map` 换回模型名）；动态表名（`UPDATE ${table}`）、表不在 schema 里、非标准 client 名一律报「落表不可判定」，不当成「无唯一键」",
    "`$executeRaw` 按 SQL 内容判写：模板字面量里有 DML/DDL 才算写（`SELECT set_config(…)` 这类 RLS 上下文不算），参数化 `$executeRaw(sql)`/`$executeRawUnsafe` 因 SQL 可能在别处拼而保守算写；`createHash(…).update(…)` 属摘要计算，剥掉后不计写",
    '分档只答「双提交会真落两份 / 只会撞库 500 / 落表不可判定 / 写痕迹未出现 / 只见留痕写」，不改变缺口本身的存在性；raw SQL 写非 Prisma 表（如运营侧单例快照）时只据实列表名，是否幂等需人工裁定',
    "留痕写（`logAccessDeny` / `writeAuditEvent` 一类）单独收：它们足以否定只读豁免，但不参与业务分档——多一条 deny 日志不是业务重复。仓级封装走 `boundaries.auditWriteCalls` 追加",
    '导出别名（`export const read = write`）只跟一跳同文件别名；跨文件别名链、barrel 重导出仍按不可解处理，不猜',
    '分档里的唯一键按字段集合去重（prisma 的 camelCase 与迁移 SQL 的 snake_case 视为同一约束），可空列比对也先归一命名风格',
  ],
  async run(ctx) {
    requireTs(ctx.config)
    const sources = await collectorFor(ctx.config).loadSources(ctx.root, ctx.config)
    // 鉴权词表与公共路由与 aq06 同源（lib/auth-evidence.ts）：同一概念只有一个答案。
    const authVocab = authVocabulary(ctx.config)
    const validatePatterns = ctx.config.boundaries?.validatePatterns?.length
      ? ctx.config.boundaries.validatePatterns
      : DEFAULT_VALIDATE
    const mutationMethods = ctx.config.boundaries?.mutationMethods?.length
      ? ctx.config.boundaries.mutationMethods
      : DEFAULT_MUTATION
    /**
     * 公共路由登记：只接受 `{ file, reason }` 形状。
     * 形状错了（例如写成字符串数组）必须点名，不能把 undefined 拼进文案——那会让
     * 「配置写错了」看起来像「登记过期了」，读的人会去改登记而不是改形状。
     */
    const publicRoutes = (ctx.config.boundaries?.publicRoutes ?? []).filter(
      (r): r is { file: string; reason: string; methods?: string[] } =>
        Boolean(r) && typeof (r as { file?: unknown }).file === 'string',
    )
    const badPublicShapes = (ctx.config.boundaries?.publicRoutes?.length ?? 0) - publicRoutes.length
    /** 服务层幂等取证：仓级词表追加到通用词表之上；`idempotencyDepth=0` 关闭跨文件取证 */
    const evidencePatterns = ctx.config.boundaries?.idempotencyEvidence?.length
      ? [...DEFAULT_IDEMPOTENCY_EVIDENCE, ...ctx.config.boundaries.idempotencyEvidence]
      : DEFAULT_IDEMPOTENCY_EVIDENCE
    const evidenceDepth = ctx.config.boundaries?.idempotencyDepth ?? 2
    /** 留痕写函数名：仓级追加到默认词表（`logAccessDeny` 一类拒绝路径写不算业务写） */
    const auditCalls = ctx.config.boundaries?.auditWriteCalls?.length
      ? [...DEFAULT_AUDIT_WRITE_CALLS, ...ctx.config.boundaries.auditWriteCalls]
      : DEFAULT_AUDIT_WRITE_CALLS
    const sourcesByRel = new Map(sources.map((s) => [s.rel, s]))
    const evidenceScope: EvidenceScope = {
      sources: sourcesByRel,
      known: new Set(sourcesByRel.keys()),
      aliases: loadAliasConfig(ctx.root),
      evidence: evidencePatterns,
    }
    let idemMarker = 0
    let idemDelegated = 0
    let idemUnproven = 0
    let idemReadOnly = 0
    /**
     * 落表分档：同一份 schema 事实只加载一次、模型名正则只编译一次，逐入口复用。
     * 分档不改变判据结论（仍是一条 warn），只回答「这条缺口到底会真落两份，还是只会撞库 500」。
     */
    const facts = await loadSchemaFacts(ctx.root, ctx.config)
    const writeTarget = writeTargetRe(ctx.config.schema.clientNames)
    let triageDup = 0
    let triage500 = 0
    let triageUnknown = 0
    let triageUnseen = 0
    let triageAudit = 0
    let triageSchema = 0

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
    if (badPublicShapes > 0) {
      findings.push(
        err(
          'PUBLIC_ROUTE_SHAPE',
          `boundaries.publicRoutes 有 ${badPublicShapes} 条不是 { file, reason } 对象（例如写成了纯字符串）：公共路由登记无效，未经登记的路由仍按裸奔判`,
          { file: 'qe.config.json' },
        ),
      )
    }
    const matchedPublic = new Set<string>()
    let methodStubs = 0
    for (const { entry, fn, sf } of entries) {
      const ast = sfOf(sf)
      const body = bodyTextOf(fn, ast)
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
      // 桩先判：入口体只有一条字面量 return，没有请求输入也没有副作用，
      // 后面三类判据（鉴权/校验/幂等）对它都不成立。必须放在公共登记之后：
      // 已登记的公共桩仍要算 matchedPublic，否则会被读成「登记过期」。
      if (entry.kind === 'route' && staticStubEntry(fn)) {
        methodStubs++
        findings.push(
          info('ENTRY_STATIC_METHOD', `${entry.rel}#${entry.name} 是静态方法桩/探活面（入口体只有一条字面量 return，不读请求输入）：鉴权/校验/幂等判据不适用`, {
            file: entry.rel,
            line: entry.line,
            entity: entry.name,
          }),
        )
        continue
      }
      if (!isPublic && !hasAuthEvidence(authScopeText(body, ast), { patterns: authVocab.patterns })) {
        findings.push(
          err('ENTRY_NO_AUTH', `${entry.rel}#${entry.name} 无鉴权判据（入口体+同文件一跳 helper 均未命中鉴权词表 ${authVocab.patterns.length} 条）：对抗环境下即匿名可打`, {
            file: entry.rel,
            line: entry.line,
            entity: entry.name,
          }),
        )
      }

      // 校验只看「直接读取请求体」的变更入口：DELETE / 动作型 POST 没有输入可用，
      // 按方法一律要求校验就是拿不存在的东西判红（目标仓 43 条误报的主体）。
      const readsBody = REQUEST_BODY_READ.test(body)
      if (entry.mutation && readsBody) {
        const helpers = localFunctionBodies(ast)
        const helperNames = calledNames(body).filter((n) => n !== entry.name && helpers.has(n))
        const helperValidates = helperNames.some((n) => validationHit(helpers.get(n) ?? '', validatePatterns))
        const validated = validationHit(body, validatePatterns) || helperValidates
        if (!validated) {
          if (helperNames.length > 0) {
            findings.push(
              warn(
                'VALIDATE_NOT_PROVEN',
                `${entry.rel}#${entry.name} 直接读取请求体，同文件 helper ${helperNames.join('/')} 未能证明校验：判据只做一跳追踪，请确认 helper 内做过 schema 校验或在入口内校验`,
                { file: entry.rel, line: entry.line, entity: entry.name },
              ),
            )
          } else {
            findings.push(
              err('ENTRY_NO_VALIDATE', `${entry.rel}#${entry.name} 变更入口直接读取请求体且无 schema 校验：恶意体可直接进业务`, {
                file: entry.rel,
                line: entry.line,
                entity: entry.name,
              }),
            )
          }
        }
      }

      if (entry.kind === 'route' && IDEMPOTENT_METHODS.includes(entry.name)) {
        const hasMarker = IDEMPOTENCY.some((p) => body.includes(p))
        if (hasMarker) idemMarker++
        else {
          /**
           * 取证顺序：入口体自身的锁/CAS 词 → 同文件 helper → 跨文件一跳（可配跳数）。
           * 三层都不命中才算未证明——把护闸写在入口内联的函数里，与写在服务层等价。
           */
          const helpers = localFunctionBodies(ast)
          const helperNames = calledNames(body).filter((n) => n !== entry.name && helpers.has(n))
          const localHits = evidencePatterns.filter((p) => body.includes(p))
          const helperHits = helperNames.filter((n) => evidencePatterns.some((p) => (helpers.get(n) ?? '').includes(p)))
          const delegated =
            evidenceDepth === 0 ? [] : serviceEvidence(body, entry.rel, ast, evidenceScope, evidenceDepth, new Set())
          if (localHits.length > 0 || helperHits.length > 0 || delegated.length > 0) idemDelegated++
          else {
            // 幂等未证明 ⇒ 再问一次「到底有没有写」：只读出口没有第二份副作用可去重，
            // 按幂等判红是拿不存在的风险判红（导出/解析/钻取类入口的主体误报）。
            const writes = writeEvidence(
              body,
              entry.rel,
              ast,
              evidenceScope,
              evidenceDepth,
              new Set(),
              helpers,
              writeTarget,
              facts,
              auditCalls,
            )
            // 只读豁免要求「射程内一条写都没有」，留痕写也不行：留痕仍是写，只是不参与业务分档
            if (!writes.unresolved && writes.hits.length === 0 && writes.auditHits.length === 0) {
              idemReadOnly++
              findings.push(
                info(
                  'MUTATION_READONLY',
                  `${entry.rel}#${entry.name} 入口体/同文件 helper/服务函数（depth=${evidenceDepth}）均无写调用：无第二份副作用可去重，幂等要求不适用`,
                  { file: entry.rel, line: entry.line, entity: entry.name },
                ),
              )
            } else {
              idemUnproven++
              const businessSeen = writes.hits.length > 0
              const auditSeen = writes.auditHits.length > 0
              const why = businessSeen
                ? `已见写痕迹 ${writes.hits.slice(0, 3).join(' ')}`
                : auditSeen
                  ? `仅见留痕写 ${writes.auditHits.slice(0, 3).join(' ')}`
                  : `射程内有静态不可见处 ${writes.why.slice(0, 3).join(' ')}`
              /**
               * 分档只在「确实看到了写」时才有意义：射程里一条写痕迹都没有（hits 空）却报
               * `target-unknown`，会把人引去翻根本不存在的 raw SQL。
               * 只有留痕写时单独判 `audit-trace`：多一条 deny 日志不是业务重复，但也不豁免。
               */
              const verdict = classifyDuplicateRisk(writes.targets, facts, businessSeen, auditSeen)
              if (verdict.risk === 'duplicate-evidence') triageDup++
              else if (verdict.risk === 'unique-key-500') triage500++
              else if (verdict.risk === 'target-unknown') triageUnknown++
              else if (verdict.risk === 'write-unseen') triageUnseen++
              else if (verdict.risk === 'audit-trace') triageAudit++
              else triageSchema++
              // raw SQL 抽出了表名但 schema 里没有对应 Prisma 模型：据实列出，供人工核对
              const rawTables =
                writes.sqlTables.length > 0 ? `【raw SQL 目标表：${writes.sqlTables.join(',')}（schema 里无对应 Prisma 模型）】` : ''
              const head = businessSeen ? `变更入口既有写痕迹（${why}）` : `变更入口未见业务写（${why}）`
              findings.push(
                warn(
                  'MUTATION_NO_IDEMPOTENCY',
                  `${entry.rel}#${entry.name} ${head}，又无幂等标记、入口体/同文件 helper/一跳服务函数也未见锁/唯一键/CAS 证据：双提交/重放会重复扣减【分档：${DUPLICATE_RISK_LABEL[verdict.risk]}；${verdict.because}】${rawTables}`,
                  { file: entry.rel, line: entry.line, entity: entry.name },
                ),
              )
            }
          }
        }
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
      scanned: `files=${sources.length} entries=${entries.length} routes=${entries.filter((e) => e.entry.kind === 'route').length} actions=${entries.filter((e) => e.entry.kind === 'action').length} public=${publicRoutes.length} stubs=${methodStubs} idem=marker${idemMarker}/delegate${idemDelegated}/readonly${idemReadOnly}/unproven${idemUnproven} idemTriage=dup${triageDup}/500${triage500}/unknown${triageUnknown}/unseen${triageUnseen}/audit${triageAudit}/schema${triageSchema}`,
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
    {
      name: 'good：DELETE 不读请求体时不再要求 schema 校验（旧判据按方法一律报 ENTRY_NO_VALIDATE）',
      root: path.join(FIXTURES, 'delete-no-body'),
      expect: 'green',
      config: { source: { collector: 'ts', roots: ['app'], extensions: [] } },
    },
    {
      name: 'good：动作型 POST 不读请求体时只查鉴权与幂等（旧判据把 28 个无体入口报成无校验）',
      root: path.join(FIXTURES, 'raw-post-no-body'),
      expect: 'green',
      config: { source: { collector: 'ts', roots: ['app'], extensions: [] } },
    },
    {
      name: 'good：同文件一跳 helper 做了 schema 校验（旧判据只扫入口函数体，会误报）',
      root: path.join(FIXTURES, 'helper-delegated'),
      expect: 'green',
      config: { source: { collector: 'ts', roots: ['app'], extensions: [] } },
    },
    {
      name: 'red：直接 request.json() 进业务且无校验、无 helper（解析请求体不是校验）',
      root: path.join(FIXTURES, 'direct-json-unchecked'),
      expect: 'red',
      minErrors: 1,
      config: { source: { collector: 'ts', roots: ['app'], extensions: [] } },
    },
    {
      name: 'good：入口无字面幂等标记，但一跳服务函数有咨询锁 + upsert（旧判据会误报无幂等）',
      root: path.join(FIXTURES, 'service-evidence-good'),
      expect: 'green',
      config: { source: { collector: 'ts', roots: ['app'], extensions: [] } },
    },
    {
      name: 'warn：入口无字面标记，一跳服务函数只有裸 create（服务层也无证据 → 必须报未证明）',
      root: path.join(FIXTURES, 'service-evidence-bad'),
      expect: 'warn',
      minWarnings: 1,
      maxWarnings: 1,
      config: { source: { collector: 'ts', roots: ['app'], extensions: [] } },
    },
    {
      name: 'warn：关掉跨文件取证（idempotencyDepth=0）后，有服务层护闸也退回字面标记判据',
      root: path.join(FIXTURES, 'service-evidence-good'),
      expect: 'warn',
      minWarnings: 1,
      maxWarnings: 1,
      config: { source: { collector: 'ts', roots: ['app'], extensions: [] }, boundaries: { idempotencyDepth: 0 } },
    },
    {
      name: 'good：POST 只读出口（只查库不写库）不再要求幂等（旧判据按方法一律报 MUTATION_NO_IDEMPOTENCY）',
      root: path.join(FIXTURES, 'readonly-post'),
      expect: 'green',
      config: { source: { collector: 'ts', roots: ['app'], extensions: [] } },
    },
    {
      name: 'warn：入口体只看到命名空间导入的成员调用（静态不可解），不得据此判为只读豁免',
      root: path.join(FIXTURES, 'readonly-unresolvable'),
      expect: 'warn',
      minWarnings: 1,
      maxWarnings: 1,
      config: { source: { collector: 'ts', roots: ['app'], extensions: [] } },
    },
    {
      name: 'good：`$executeRaw` 只设 RLS 上下文 + `createHash().update()` 摘要计算，都不算写（旧判据报未证明）',
      root: path.join(FIXTURES, 'readonly-hash'),
      expect: 'green',
      config: { source: { collector: 'ts', roots: ['app'], extensions: [] } },
    },
    {
      name: 'warn：`$executeRaw` 里带 DML 字面量（自增累加）仍算真写，不得被 RLS 上下文的豁免带成只读',
      root: path.join(FIXTURES, 'raw-sql-write'),
      expect: 'warn',
      minWarnings: 1,
      maxWarnings: 1,
      config: { source: { collector: 'ts', roots: ['app'], extensions: [] } },
    },
    {
      name: 'warn：唯一可见写是拒绝路径的留痕（logAccessDeny → auditEvent）⇒ audit-trace，不报成重复证据',
      root: path.join(FIXTURES, 'audit-only'),
      expect: 'warn',
      minWarnings: 1,
      maxWarnings: 1,
      config: { source: { collector: 'ts', roots: ['app'], extensions: [] } },
    },
    {
      name: 'good：导出别名（`export const readOnly = readRows`）不再被判 no-export，只读出口照常豁免',
      root: path.join(FIXTURES, 'readonly-alias'),
      expect: 'green',
      config: { source: { collector: 'ts', roots: ['app'], extensions: [] } },
    },
    {
      // 真实仓（cron 路由）实测：鉴权写在同文件 helper 里，旧判据只看入口体 → 判裸奔。
      name: 'good：鉴权在同文件一跳 helper（cronSecretMatches）里也算有鉴权（旧判据只扫入口体）',
      root: path.join(FIXTURES, 'auth-helper'),
      expect: 'green',
      config: { source: { collector: 'ts', roots: ['app'], extensions: [] } },
    },
    {
      // 真实仓（messages 路由）实测：鉴权失败靠错误码表达，没有 auth/session 这类名字。
      name: 'good：入口返回 AUTH_REQUIRED 错误码也算有鉴权（旧判据只认名字）',
      root: path.join(FIXTURES, 'auth-error-code'),
      expect: 'green',
      config: { source: { collector: 'ts', roots: ['app'], extensions: [] } },
    },
    {
      // 反证 D1：形状错了不许静默失效——旧代码把字符串数组读成 { file: undefined }，
      // 公共登记整块无效却只报「登记过期」，读的人会去改登记而不是改形状。
      name: 'red：publicRoutes 写成字符串数组 → PUBLIC_ROUTE_SHAPE（不是「登记过期」）',
      root: path.join(FIXTURES, 'public-shape'),
      expect: 'red',
      minErrors: 1,
      maxErrors: 1,
      maxWarnings: 0,
      config: {
        source: { collector: 'ts', roots: ['app'], extensions: [] },
        boundaries: { publicRoutes: ['app/api/legacy/route.ts'] as unknown as { file: string; reason: string }[] },
      },
    },
    {
      // 真实仓实测：405 方法桩与静态探活 GET 被旧判据判成「匿名可打」。
      // 它们的响应完全由字面量构成、不读请求输入，鉴权在它身上没有可守的东西。
      name: 'good：405 方法桩与静态探活 GET 不按裸奔判（旧判据报 ENTRY_NO_AUTH）',
      root: path.join(FIXTURES, 'method-stub'),
      expect: 'green',
      minInfos: 2,
      config: { source: { collector: 'ts', roots: ['app'], extensions: [] } },
    },
    {
      // 桩判据的反面：返回值里出现标识符（import 的常量 / process.env）就不可证，仍按裸奔报。
      name: 'red：GET 返回 import 进来的常量 → 不是可证的静态桩，仍判 ENTRY_NO_AUTH',
      root: path.join(FIXTURES, 'static-identifier'),
      expect: 'red',
      minErrors: 1,
      maxErrors: 1,
      maxWarnings: 0,
      config: { source: { collector: 'ts', roots: ['app'], extensions: [] } },
    },
  ],
})
