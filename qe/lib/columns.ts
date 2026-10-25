import { collectorFor, loadSchema } from './providers.ts'
import type { DataCall, SchemaSnapshot, SourceFileInfo } from './providers.ts'
import type { QeConfig } from './config.ts'
import { escapeRe, maskStringBodies, matchDelimiter, stripComments } from './code-only.ts'

export interface ColumnFacts {
  model: string
  table: string
  field: string
  column: string
  type: string
  line: number
  writers: DataCall[]
  readers: DataCall[]
  exemptReason?: string
  archiveDeclared: boolean
  implicitReader: boolean
  /** 该列有 DB 侧值来源（@default / @updatedAt）：不是「死列」，业务代码不显式写属正常 */
  defaulted: boolean
  /** 该模型存在「字段覆盖未知」的写入调用：无已知写者的字段不能判死列 */
  unknownWriter: boolean
}

/** 原生 SQL 写点：Prisma Client 之外的真实写入，按表名/模型名归属 */
export interface RawWrite {
  file: string
  line: number
  /** 命中的 model；空 = 无法归属（只出候选，不判死列也不报绿） */
  models: string[]
  /** 来自 evidenceRoots（测试/运维脚本）：写点是造数动作而非产品写入面，归属不到模型时不出候选 */
  evidence?: boolean
  snippet: string
}

export interface ColumnScan {
  fields: ColumnFacts[]
  rawWrites: RawWrite[]
  stats: {
    models: number
    fields: number
    files: number
    evidenceFiles: number
    writeCalls: number
    readCalls: number
  }
}

/**
 * 列写读分析：只依赖 SchemaProvider + CallCollector，与 ORM / 语言无关。
 * provider=none 或 collector=none 时抛 NotApplicable，由调用方显式跳过（不报绿）。
 */
export async function scanColumns(root: string, config: QeConfig): Promise<ColumnScan> {
  const schema = await loadSchema(root, config)
  const collector = collectorFor(config)
  const sources = await collector.loadSources(root, config)
  const evidence = collector.loadEvidenceSources ? await collector.loadEvidenceSources(root, config) : []
  const evidenceOnly = evidence.filter((e) => !sources.some((s) => s.rel === e.rel))
  const calls = collector.collectCalls([...sources, ...evidenceOnly], schema, config)
  const rawWrites = detectRawWrites([...sources, ...evidenceOnly], schema, new Set(evidenceOnly.map((e) => e.rel)))
  const unknownWriterModels = new Set(
    calls.filter((c) => c.kind === 'write' && c.fieldsUnknown).map((c) => c.model),
  )
  // 原生 SQL 写点按表名归属：归到某个 model 就把它标成「写入覆盖未知」，
  // 该模型的字段不许判死列（`$executeRaw` 里的列清单静态解析不可靠）。
  for (const raw of rawWrites) for (const model of raw.models) unknownWriterModels.add(model)

  const fields: ColumnFacts[] = []
  for (const model of schema.models) {
    const modelCalls = calls.filter((c) => c.model === model.name)
    for (const field of model.fields) {
      if (field.isRelation || field.isList) continue
      const exemptReason = exemptionFor(model.name, field.name, config)
      const writers = modelCalls.filter((c) => c.kind === 'write' && c.fields.includes(field.name))
      const readers = modelCalls.filter((c) => c.kind === 'read' && c.fields.includes(field.name))
      const implicitReader = modelCalls.some((c) => c.kind === 'read' && !c.hasSelect)
      fields.push({
        model: model.name,
        table: model.table,
        field: field.name,
        column: field.column,
        type: field.type,
        line: field.line,
        writers,
        readers,
        exemptReason,
        archiveDeclared: /@archive|存档/.test(field.comment),
        implicitReader,
        defaulted: /@default|@updatedAt/.test(field.attrs),
        unknownWriter: unknownWriterModels.has(model.name),
      })
    }
  }

  return {
    fields,
    rawWrites,
    stats: {
      models: schema.models.length,
      fields: fields.length,
      files: sources.length + evidenceOnly.length,
      evidenceFiles: evidenceOnly.length,
      writeCalls: calls.filter((c) => c.kind === 'write').length,
      readCalls: calls.filter((c) => c.kind === 'read').length,
    },
  }
}

function exemptionFor(model: string, field: string, config: QeConfig): string | undefined {
  const exact = config.fieldExemptions.find((e) => e.field === field && (e.model === model || e.model === '*'))
  if (exact) return exact.reason?.trim() || '__EMPTY_REASON__'
  // 模型级豁免（field: '*'）：给 PrismaAdapter 这类「运行期由依赖写入」的模型用。
  // 理由同样必填——整模型免检的面积最大，空理由更是不可接受的豁免槽。
  const modelWide = config.fieldExemptions.find((e) => e.field === '*' && (e.model === model || e.model === '*'))
  if (modelWide) return modelWide.reason?.trim() || '__EMPTY_REASON__'
  const system = config.systemFields[field]
  if (system) return system
  return undefined
}

const RAW_CALL = /\$(?:executeRawUnsafe|executeRaw|queryRawUnsafe|queryRaw)\b/g
/** 只有含 DML 语句的原生调用才算写点：`$queryRaw` 里只写 SELECT 时是读 */
const SQL_DML = /\b(?:insert\s+into|update|delete\s+from|alter\s+table|truncate)\b/i

/**
 * 取原生调用的**实参原文**：标签模板取到反引号闭合，括号形式取到配对圆括号，字符串实参取到引号闭合。
 * 认不出（不配对 / 后面不是实参）返回 `null` —— 看不清不等于有写。
 *
 * 为什么必须按实参取词而不是取命中点之后的一段窗口：
 * `$queryRaw\`SELECT …\`` 之后 600 字符内完全可能还有别的语句的 `DELETE`，
 * 窗口取词会把**读调用**算成写点（实测 `probe-migsum.mjs` / e2e 的 COUNT_SQL 两条假候选）。
 */
function rawStatementAt(code: string, masked: string, from: number): string | null {
  let i = from
  const skipWs = () => {
    while (i < code.length && /\s/.test(masked[i])) i++
  }
  skipWs()
  // 泛型实参（`$queryRawUnsafe<{ n: string }[]>(…)`）先跳过，否则后面仍按实参解析
  if (masked[i] === '<') {
    let depth = 0
    for (; i < masked.length; i++) {
      if (masked[i] === '<') depth++
      else if (masked[i] === '>') {
        depth--
        if (depth === 0) {
          i++
          break
        }
      }
    }
    skipWs()
  }
  const ch = masked[i]
  if (ch === '(') {
    const end = matchDelimiter(masked, i)
    return end < 0 ? null : code.slice(i + 1, end)
  }
  if (ch === '`' || ch === "'" || ch === '"') {
    let j = i + 1
    while (j < masked.length && masked[j] !== ch) j++
    return j >= masked.length ? null : code.slice(i + 1, j)
  }
  return null
}

/**
 * 原生 SQL 写点识别（INV-CORE-01 的已知盲区）：
 * `$executeRaw` / `$queryRaw` 的写入不在 Prisma Client 的 data 键里，旧判据完全看不见。
 * 这里只按「DML 动词 + 表名/模型名出现在同一实参里」做归属；归属不到就只出候选，
 * 绝不据此判死列——没看清不等于没有写。
 *
 * 两道排除（都是实测过的假候选来源，见 `qe/fixtures/inv01-column-writer/raw-sql-noise`）：
 *  · **注释里的写字样是描述**：`stripComments` 保留长度与换行，命中索引仍对得上原文；
 *  · **字符串/模板串里的写字样是素材**（例如判据自己取样片段）：`maskStringBodies` 把内容抹成空白，
 *    命中起点落在空白处即说明这个 token 本身就在字符串里，不是调用点。
 *
 * 归属不到模型的写点只在**应用面**出候选（`evidence` 标记由守卫侧过滤）：evidenceRoots
 * （测试/运维脚本）的写点是造数动作，天然按动态表名循环（`for (const t of [...]) DELETE FROM ${t}`），
 * 报成「需人工复核的写入覆盖」只会把台账淹没；它们的可归属写点仍照常计入 `unknownWriterModels`
 * （零写入列判定不受影响）。
 */
function detectRawWrites(sources: SourceFileInfo[], schema: SchemaSnapshot, evidenceRels = new Set<string>()): RawWrite[] {
  const out: RawWrite[] = []
  const candidates = schema.models.map((m) => ({
    name: m.name,
    res: [...new Set([m.name, m.table])].map((c) => new RegExp(`\\b${escapeRe(c)}\\b`, 'i')),
  }))
  for (const src of sources) {
    const code = stripComments(src.text)
    const masked = maskStringBodies(code)
    RAW_CALL.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = RAW_CALL.exec(code)) !== null) {
      if (masked[m.index] !== '$') continue
      const stmt = rawStatementAt(code, masked, m.index + m[0].length)
      if (stmt === null || !SQL_DML.test(stmt)) continue
      const models = candidates.filter((c) => c.res.some((re) => re.test(stmt))).map((c) => c.name)
      out.push({
        file: src.rel,
        line: code.slice(0, m.index).split('\n').length,
        models,
        evidence: evidenceRels.has(src.rel),
        snippet: stmt.slice(0, 120).replace(/\s+/g, ' ').trim(),
      })
    }
  }
  return out
}

export function scanScope(scan: ColumnScan, config: QeConfig): string {
  const evidence = config.source.evidenceRoots?.length ? ` evidenceDirs=${config.source.evidenceRoots.join(',')} evidenceFiles=${scan.stats.evidenceFiles}` : ''
  return `provider=${config.schema.provider} collector=${config.source.collector} dirs=${config.source.roots.join(',')}${evidence} files=${scan.stats.files} models=${scan.stats.models} fields=${scan.stats.fields} writes=${scan.stats.writeCalls} reads=${scan.stats.readCalls} rawWrites=${scan.rawWrites.length} ignore=${config.ignore.length}`
}
