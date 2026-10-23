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
}

export interface ColumnScan {
  fields: ColumnFacts[]
  stats: {
    models: number
    fields: number
    files: number
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
  const calls = collector.collectCalls(sources, schema, config)

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
      })
    }
  }

  return {
    fields,
    stats: {
      models: schema.models.length,
      fields: fields.length,
      files: sources.length,
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
  return `provider=${config.schema.provider} collector=${config.source.collector} dirs=${config.source.roots.join(',')} files=${scan.stats.files} models=${scan.stats.models} fields=${scan.stats.fields} writes=${scan.stats.writeCalls} reads=${scan.stats.readCalls} ignore=${config.ignore.length}`
}
