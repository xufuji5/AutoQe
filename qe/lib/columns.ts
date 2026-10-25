import { collectorFor, loadSchema } from './providers.ts'
import type { DataCall } from './providers.ts'
import type { QeConfig } from './config.ts'

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

export interface ColumnScan {
  fields: ColumnFacts[]
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
  const unknownWriterModels = new Set(
    calls.filter((c) => c.kind === 'write' && c.fieldsUnknown).map((c) => c.model),
  )

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
  const system = config.systemFields[field]
  if (system) return system
  return undefined
}

export function scanScope(scan: ColumnScan, config: QeConfig): string {
  const evidence = config.source.evidenceRoots?.length ? ` evidenceDirs=${config.source.evidenceRoots.join(',')} evidenceFiles=${scan.stats.evidenceFiles}` : ''
  return `provider=${config.schema.provider} collector=${config.source.collector} dirs=${config.source.roots.join(',')}${evidence} files=${scan.stats.files} models=${scan.stats.models} fields=${scan.stats.fields} writes=${scan.stats.writeCalls} reads=${scan.stats.readCalls} ignore=${config.ignore.length}`
}
