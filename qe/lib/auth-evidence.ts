/**
 * 「这个入口有鉴权」的**唯一**判据来源。
 *
 * ## 为什么必须单源
 *
 * 同一个概念曾经有两套判据：`rules/AQ006` 用四层结构判定（名字 + 词干 + 错误码 + helper 形态），
 * `guards/inv20` 只做子串命中。结果是在真实仓里，同一条路由 `aq06` 判绿、`inv20` 判红——
 * 人要同时相信两个互相矛盾的读数，最后只能把其中一个关掉。
 *
 * 更贵的是配置：`aq06` 读 `rules.aq06.authPatterns` / `publicPaths`，`inv20` 读
 * `boundaries.authPatterns` / `publicRoutes`。同一件事写两遍，改一边忘一边就变成
 * 「某些路由按 aq06 算公开、按 inv20 算裸奔」。
 *
 * 现在两边都走 `hasAuthEvidence()`，词表都走 `authVocabulary()`：
 *   - 规范位置是 `boundaries.authPatterns` / `boundaries.publicRoutes`（有类型、有理由字段）；
 *   - `rules.aq06.*` 保留为**回落**（老配置不强制迁移，但两边只要有一份即可）。
 *
 * ## 判据的分层与代价
 *
 * 列名字永远列不全（外部试点：152 处「裸奔」全是误报，主力守卫叫 requirePermission）。
 * 所以四层叠加，宁可**少报**也不把已鉴权路由报成裸奔：
 *   ① 常见名 + 项目词表；② 鉴权错误码；③ 词干（auth/session/permission/...）；
 *   ④ 结构：使令动词 + 受保护名词，或「request 进、判空即拒」的领域 helper 形态。
 *
 * ④ 的代价写在调用方的 blindSpots 里：`parseBody(req)` 后 `if (!body) return 400` 也会被认成鉴权
 * （漏报方向）。这是有意接受的：把真实鉴权报成裸奔，这条判据会先失去信用、然后被关掉。
 */

import type { QeConfig } from './config.ts'

/** 常见鉴权入口名（字面/正则混写，供内置判据使用） */
const AUTH_LITERAL_RE =
  /\b(auth|getServerSession|getSession|currentUser|getCurrentUser|requireUser|requireAuth|requireAdmin|requireRole|requirePermission|hasPermission|checkPermission|assertAdmin|assertPermission|verifyAdmin|isAdmin|adminGuard|withAuth|verifyToken|verifySignature|validateSession|authorize|guard)\b/

/** 鉴权语义词干（二级判据）。刻意不含 member/owner/tenant —— 那些是业务词，会大面积误判。 */
const AUTH_WORD =
  /(auth|session|permission|perms|role|scope|guard|token|jwt|signature|secret|credential|login|admin|acl|rbac|privilege|identity|principal)/i

/**
 * 三级判据：**动词 + 名词**的结构判定。
 *
 * `requireMerchant` / `assertAdminAccess` / `ensureSession` / `withMerchantScope` → 是守卫；
 * `requireEnv` / `assertValid` / `ensureDir` / `checkFormat` → 不是（名词不在受保护对象里）。
 */
const GUARD_VERB_RE = /^(?:require|assert|ensure|check|guard|with|verify)[A-Z][\w$]*$/
const GUARD_NOUN_RE =
  /(Auth|Admin|User|Member|Merchant|Role|Permission|Perms?|Session|Scope|Access|Owner|Identity|Principal|Token|Signature|Login|Guard|Privilege|Actor|Tenant)/

/** 显式返回这些错误码的入口，必然是鉴权感知的 */
const AUTH_ERROR_CODE_RE = /\b(AUTH_REQUIRED|UNAUTHENTICATED|UNAUTHORIZED|UNAUTHORIZED_|NOT_LOGGED_IN|FORBIDDEN|SESSION_EXPIRED|CRON_UNAUTHORIZED|AGENT_UNAUTHORIZED)\b/

/** 取 `await foo(` / `foo(` 的函数名，喂给词干判据 */
const CALL_NAME_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g

/**
 * 四级判据：「鉴权在领域 helper 里」的**结构**形态。
 *
 *   `const merchant = await resolveMerchant(request)` → `if (!merchant) return apiError(...)`
 *   `const result = await sendHighRiskSmsCode(request, permission)` → `if (!result.ok) return ...`
 *
 * 只看形状，不看名字 —— 列名字只是把问题推到下一个项目。
 */
function hasAuthHelperShape(codes: string): boolean {
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+[\w$.]+\(\s*(?:request|req)\s*[,)]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(codes)) !== null) {
    const bound = m[1]
    const after = codes.slice(m.index, m.index + 1200)
    if (new RegExp(`if\\s*\\(\\s*!\\s*${bound}(?:\\.\\w+)?\\b`).test(after)) return true
    if (new RegExp(`if\\s*\\(\\s*!\\s*${bound}\\.\\w+`).test(after)) return true
  }
  return false
}

/** 项目词表项：先按子串（绝大多数项目写的是名字），再按正则（老 aq06 配置） */
function patternHit(text: string, p: string): boolean {
  if (text.includes(p)) return true
  try {
    return new RegExp(p).test(text)
  } catch {
    return false
  }
}

export interface AuthEvidenceOptions {
  /** 项目声明词表（boundaries.authPatterns / rules.aq06.authPatterns） */
  patterns?: readonly string[]
  /** 鉴权模块的路径片段（`from '@/lib/auth'` 即算）。只给文件级判据用 */
  authModules?: readonly string[]
  /** 用于 authModules 匹配的整段文件文本（含 import） */
  importsText?: string
}

/**
 * 判定一段代码里是否有鉴权证据。
 *
 * 调用方必须保证 `text` 已剥注释（注释里写一句「这里要鉴权」不能当证据），
 * 且只传入**可静态解析**的射程（入口体 / 同文件一跳 helper）；跨文件/封装在依赖里的
 * 判定静态不可见时，调用方降级为未证明，不要把「猜」写成「证」。
 */
export function hasAuthEvidence(text: string, opts: AuthEvidenceOptions = {}): boolean {
  if (AUTH_LITERAL_RE.test(text)) return true
  if (AUTH_ERROR_CODE_RE.test(text)) return true
  for (const p of opts.patterns ?? []) {
    if (p.trim() && patternHit(text, p)) return true
  }
  if (opts.authModules?.length && opts.importsText) {
    for (const mod of opts.authModules) {
      const safe = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`from\\s+['"][^'"]*${safe}`).test(opts.importsText)) return true
    }
  }
  if (hasAuthHelperShape(text)) return true
  CALL_NAME_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CALL_NAME_RE.exec(text)) !== null) {
    const name = m[1]
    if (name.length < 4) continue
    if (AUTH_WORD.test(name)) return true
    if (GUARD_VERB_RE.test(name) && GUARD_NOUN_RE.test(name)) return true
  }
  return false
}

export interface AuthVocabulary {
  /** 鉴权词表（boundaries 优先，rules.aq06 回落，最后是内置常见名） */
  patterns: string[]
  /** 鉴权模块路径片段 */
  authModules: string[]
  /** 公共路由：`methods` 缺省 = 整文件公开 */
  publicRoutes: { file: string; methods?: string[] }[]
  /** 中间件统一鉴权的前缀 */
  middlewareProtected: string[]
}

/**
 * 鉴权词表的**唯一**解析入口（aq06 与 inv20 共用）。
 *
 * 优先级：`boundaries.*`（规范位置，有类型与理由字段）> `rules.aq06.*`（老位置，回落）。
 * 两边都写时以 boundaries 为准 —— 否则同一份项目事实又会出现两个答案。
 */
export function authVocabulary(config: QeConfig): AuthVocabulary {
  const ruleOpts = (config.rules?.aq06 ?? {}) as Record<string, unknown>
  const legacyPatterns = Array.isArray(ruleOpts.authPatterns) ? (ruleOpts.authPatterns as string[]) : []
  const bPatterns = config.boundaries?.authPatterns ?? []
  const patterns = bPatterns.length > 0 ? bPatterns : legacyPatterns

  const legacyPublic = Array.isArray(ruleOpts.publicPaths) ? (ruleOpts.publicPaths as string[]) : []
  const bPublic = config.boundaries?.publicRoutes ?? []
  const publicRoutes: { file: string; methods?: string[] }[] =
    bPublic.length > 0
      ? bPublic
          .filter((r) => r && typeof r.file === 'string')
          .map((r) => ({ file: r.file, methods: r.methods }))
      : legacyPublic
          .filter((p): p is string => typeof p === 'string')
          .map((p) => ({ file: p }))

  return {
    patterns,
    authModules: Array.isArray(ruleOpts.authModules) ? (ruleOpts.authModules as string[]) : [],
    publicRoutes,
    middlewareProtected: Array.isArray(ruleOpts.middlewareProtected)
      ? (ruleOpts.middlewareProtected as string[])
      : [],
  }
}

/**
 * 路径声明是否覆盖该路由文件。前缀必须落在**目录边界**上：
 * `app/api/auth/` 不该命中 `app/api/auth-evil/route.ts`（裸 startsWith 是假绿锚点）。
 */
export function routePathCovers(declared: string, rel: string): boolean {
  if (declared.startsWith('^')) {
    try {
      return new RegExp(declared).test(rel)
    } catch {
      return false
    }
  }
  const base = declared.replace(/\/$/, '')
  return rel === base || rel.startsWith(base + '/') || rel.startsWith(base + '.')
}

/**
 * 该文件导出的这些方法是否**全部**被公共路由登记覆盖。
 *
 * 按方法判而不是按文件判：同一文件里匿名面（能力发现 GET）与鉴权面（写入 POST）并存时，
 * 整文件豁免会把鉴权面的覆盖一起丢掉——那是把判据关掉，不是把误报消掉。
 */
export function allMethodsDeclaredPublic(
  rel: string,
  methods: readonly string[],
  routes: readonly { file: string; methods?: string[] }[],
): boolean {
  if (methods.length === 0) return false
  return methods.every((m) =>
    routes.some(
      (r) =>
        routePathCovers(r.file, rel) &&
        (!r.methods?.length || r.methods.map((x) => x.toUpperCase()).includes(m.toUpperCase())),
    ),
  )
}
