/**
 * 规格表抽取器（缺失型缺陷的地基）。
 *
 * 为什么需要它：缺失型缺陷的 oracle 在文档里（文档承诺了端点/字段/模型，代码里没有），
 * 但文档是散文与表格混写的。把散文当表格，会一次生产几十条假红——2026-10-24 那份
 * `spec-coverage.json` 就是反例：`join`、`enant`（tenant 掉了首字母）被判成「缺失字段」，
 * `IconAlert`、`TrendLine`（图标/曲线组件名）被判成「缺失 model」，缺失率 51%。
 * 假红的代价不是「多看几眼」，是人把这条判据关掉——比不扫更糟。
 *
 * 因此本抽取器只在**能确定表头语义**的表格上取声明：
 *   1. 只认 markdown 表格行（`| a | b |`）；散文、代码块一律不解析；
 *   2. 表头必须显式声明这是 模型 / 字段 / 端点 表（词表匹配，见 COLUMN_WORDS）；
 *   3. 字段表必须有模型上下文（表内有「模型」列，或最近的标题里出现 PascalCase 名）；
 *      没有上下文就整表忽略——「猜模型」是下一批假红的来源；
 *   4. 单元格必须是**完整标识符**（绝不从长句里截子串，`enant` 正是截取产生的）。
 * 被忽略的表格计入 `ignoredTables`，是读数不是静默：抽不到声明 ≠ 没有缺失。
 *
 * 本文件是纯函数（无 I/O），坏样本见 `scripts/verify-spec-tables.ts`。
 */

export interface SpecModelClaim {
  kind: 'model'
  name: string
  doc: string
  line: number
}

export interface SpecFieldClaim {
  kind: 'field'
  model: string
  field: string
  doc: string
  line: number
}

export interface SpecEndpointClaim {
  kind: 'endpoint'
  path: string
  doc: string
  line: number
}

export type SpecClaim = SpecModelClaim | SpecFieldClaim | SpecEndpointClaim

export interface SpecParseResult {
  claims: SpecClaim[]
  /** 解析过（表头可识别）的表格数 */
  tables: number
  /** 有表格行但表头不可识别、被整表跳过的表格数 */
  ignoredTables: number
}

/** 表头词表：只认这些词，避免把「| 图标 | 用途 |」当成模型表 */
const COLUMN_WORDS = {
  model: /^(模型|实体|model|entity)$/i,
  field: /^(字段|字段名|属性|列名|field|column|property)$/i,
  endpoint: /^(端点|接口|路由|路径|endpoint|route|path|api)$/i,
}

const MODEL_RE = /^[A-Z][A-Za-z0-9]{2,39}$/
const FIELD_RE = /^[a-z][A-Za-z0-9]{1,39}$/
const HEADING_MODEL_RE = /\b([A-Z][A-Za-z0-9]{2,39})\b/g
const SEPARATOR_RE = /^:?-{3,}:?$/

/** 去掉单元格里的排版装饰（加粗/代码/斜体），保留内容 */
function cleanCell(raw: string): string {
  return raw
    .trim()
    .replace(/^\*+|\*+$/g, '')
    .replace(/^`+|`+$/g, '')
    .replace(/^\*+|\*+$/g, '')
    .trim()
}

function splitRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return null
  const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  return cells.length >= 2 ? cells : null
}

function isSeparator(cells: string[]): boolean {
  return cells.every((c) => SEPARATOR_RE.test(c.replace(/\s/g, '')))
}

function headerKind(cells: string[]): { kind: 'model' | 'field' | 'endpoint'; modelCol: number; fieldCol: number; endpointCol: number } | null {
  const modelCol = cells.findIndex((c) => COLUMN_WORDS.model.test(cleanCell(c)))
  const fieldCol = cells.findIndex((c) => COLUMN_WORDS.field.test(cleanCell(c)))
  const endpointCol = cells.findIndex((c) => COLUMN_WORDS.endpoint.test(cleanCell(c)))
  // 优先级：端点 > 字段 > 模型。`| 模型 | 字段 | 说明 |` 是字段表（模型列提供上下文）。
  if (endpointCol >= 0) return { kind: 'endpoint', modelCol, fieldCol, endpointCol }
  if (fieldCol >= 0) return { kind: 'field', modelCol, fieldCol, endpointCol }
  if (modelCol >= 0) return { kind: 'model', modelCol, fieldCol, endpointCol }
  return null
}

/** 标题里最后一个 PascalCase 名（`### 3.2 Tenant（租户）` → Tenant） */
function modelFromHeading(heading: string): string | null {
  let found: string | null = null
  HEADING_MODEL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = HEADING_MODEL_RE.exec(heading)) !== null) {
    if (MODEL_RE.test(m[1])) found = m[1]
  }
  return found
}

/**
 * 从单元格取端点路径。只接受「整格就是路径」或「整格是一个反引号包裹的路径」，
 * 不做句内搜索——散文里提到的 `/api/x` 不是承诺。
 */
function endpointOf(cell: string): string | null {
  const trimmed = cell.trim()
  const quoted = /^`(\/[^`\s]*)`$/.exec(trimmed)
  const candidate = quoted ? quoted[1] : trimmed
  if (!/^\/[A-Za-z0-9_\-/:[\]]*$/.test(candidate)) return null
  if (candidate === '/') return null
  return normalizeEndpoint(candidate)
}

/** `:id` 与 `[id]` 视为同一段，便于与文件路由比对 */
export function normalizeEndpoint(p: string): string {
  const noQuery = p.split('?')[0].replace(/\/+$/, '')
  return noQuery.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '[$1]')
}

export function parseSpecDoc(md: string, doc: string): SpecParseResult {
  const claims: SpecClaim[] = []
  const lines = md.split(/\r?\n/)
  let inFence = false
  let heading = ''
  let kind: ReturnType<typeof headerKind> = null
  let tableActive = false
  let ignoredTables = 0
  let tables = 0
  // 一张表在「第一次看到数据行」时才计一次数，避免分隔行算两次
  let tableCounted = false

  const finishTable = (): void => {
    tableActive = false
    kind = null
    tableCounted = false
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      finishTable()
      continue
    }
    if (inFence) continue

    const headingMatch = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
    if (headingMatch) {
      heading = headingMatch[2]
      finishTable()
      continue
    }

    const cells = splitRow(line)
    if (!cells) {
      if (line.trim() !== '') finishTable()
      continue
    }
    if (isSeparator(cells)) continue

    if (!tableActive) {
      tableActive = true
      kind = headerKind(cells)
      if (kind) {
        tables++
        tableCounted = true
      }
      continue // 这一行是表头，不是数据
    }
    if (!kind) {
      if (!tableCounted) {
        ignoredTables++
        tableCounted = true
      }
      continue
    }

    const lineNo = i + 1
    if (kind.kind === 'model') {
      const token = cleanCell(cells[kind.modelCol] ?? '')
      if (MODEL_RE.test(token)) claims.push({ kind: 'model', name: token, doc, line: lineNo })
      continue
    }

    if (kind.kind === 'field') {
      const fieldCell = kind.fieldCol === 0 ? cells[0] ?? '' : cells[kind.fieldCol] ?? ''
      const field = cleanCell(fieldCell)
      if (!FIELD_RE.test(field)) continue
      const modelCell = kind.modelCol >= 0 ? cleanCell(cells[kind.modelCol] ?? '') : ''
      const model = MODEL_RE.test(modelCell) ? modelCell : modelFromHeading(heading)
      // 没有模型上下文 → 不猜（猜测是假红的主要来源）
      if (!model) continue
      claims.push({ kind: 'field', model, field, doc, line: lineNo })
      continue
    }

    const endpointCell = kind.endpointCol === 0 ? cells[0] ?? '' : cells[kind.endpointCol] ?? ''
    const path = endpointOf(endpointCell)
    if (path) claims.push({ kind: 'endpoint', path, doc, line: lineNo })
  }

  return { claims, tables, ignoredTables }
}

export interface SpecReality {
  /** schema 里真实存在的 model 名 */
  models: Set<string>
  /** model → 真实列名 */
  fields: Map<string, Set<string>>
  /** 已实现的端点（已 normalizeEndpoint） */
  endpoints: Set<string>
}

export interface SpecGap {
  claim: SpecClaim
  missing: 'model' | 'field' | 'endpoint'
}

/**
 * 声明 × 现实 的对账（纯函数）。
 * 只出缺口列表；是 error 还是 info 由调用方按「oracle 是否被守卫」决定——
 * 抽取器无权把候选升级成红。
 */
export function compareClaims(claims: SpecClaim[], reality: SpecReality): SpecGap[] {
  const gaps: SpecGap[] = []
  for (const c of claims) {
    if (c.kind === 'model') {
      if (!reality.models.has(c.name)) gaps.push({ claim: c, missing: 'model' })
    } else if (c.kind === 'endpoint') {
      if (!reality.endpoints.has(c.path)) gaps.push({ claim: c, missing: 'endpoint' })
    } else {
      const cols = reality.fields.get(c.model)
      // 模型本身不存在时，字段缺口是模型缺口的重复计数 —— 只报模型那条
      if (!cols) continue
      if (!cols.has(c.field)) gaps.push({ claim: c, missing: 'field' })
    }
  }
  return gaps
}
