import type { QeConfig } from './config.ts'
import { NotApplicable } from './not-applicable.ts'
import { prismaSchemaProvider } from './prisma.ts'
import { tsCollector } from './ts-collector.ts'

/** ---------- 与 ORM / 语言无关的数据结构 ---------- */

export interface SchemaField {
  name: string
  column: string
  type: string
  isRelation: boolean
  isList: boolean
  optional: boolean
  attrs: string
  comment: string
  line: number
}

export interface SchemaModel {
  name: string
  table: string
  fields: SchemaField[]
  line: number
}

export interface SchemaEnumValue {
  name: string
  line: number
}

export interface SchemaEnum {
  name: string
  values: SchemaEnumValue[]
  line: number
}

export interface SchemaSnapshot {
  models: SchemaModel[]
  enums: SchemaEnum[]
}

export interface DataCall {
  kind: 'write' | 'read'
  model: string
  method: string
  file: string
  line: number
  fields: string[]
  hasSelect: boolean
}

export interface EnumUsage {
  enumName: string
  value: string
  context: 'write' | 'read' | 'other'
  file: string
  line: number
}

export interface SourceFileInfo {
  file: string
  rel: string
  text: string
  /** 采集器私有 AST，其他实现可忽略 */
  ast?: unknown
}

/** ---------- 适配器接口 ---------- */

export interface SchemaProvider {
  id: string
  load(root: string, config: QeConfig): Promise<SchemaSnapshot>
}

export interface CallCollector {
  id: string
  loadSources(root: string, config: QeConfig): Promise<SourceFileInfo[]>
  collectCalls(sources: SourceFileInfo[], schema: SchemaSnapshot, config: QeConfig): DataCall[]
  collectEnumUsages(sources: SourceFileInfo[], schema: SchemaSnapshot, config: QeConfig): EnumUsage[]
}

/** ---------- 注册表（新增栈支持时只加注册，不改内核） ---------- */

const schemaProviders = new Map<string, SchemaProvider>()
const collectors = new Map<string, CallCollector>()

export function registerSchemaProvider(provider: SchemaProvider): void {
  schemaProviders.set(provider.id, provider)
}

export function registerCollector(collector: CallCollector): void {
  collectors.set(collector.id, collector)
}

export function listSchemaProviders(): string[] {
  return [...schemaProviders.keys()]
}

export function listCollectors(): string[] {
  return [...collectors.keys()]
}

export async function loadSchema(root: string, config: QeConfig): Promise<SchemaSnapshot> {
  if (config.schema.provider === 'none') {
    throw new NotApplicable('schema.provider=none：本仓未声明 schema，依赖 schema 的守卫不适用')
  }
  const provider = schemaProviders.get(config.schema.provider)
  if (!provider) {
    throw new Error(`未注册的 schema provider：${config.schema.provider}（可用：${listSchemaProviders().join(', ')}）`)
  }
  return provider.load(root, config)
}

export function collectorFor(config: QeConfig): CallCollector {
  if (config.source.collector === 'none') {
    throw new NotApplicable('source.collector=none：本仓未配置源码采集器')
  }
  const collector = collectors.get(config.source.collector)
  if (!collector) {
    throw new Error(`未注册的源码采集器：${config.source.collector}（可用：${listCollectors().join(', ')}）`)
  }
  return collector
}

registerSchemaProvider(prismaSchemaProvider)
registerCollector(tsCollector)
