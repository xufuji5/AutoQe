/**
 * 从 schema 快照里提炼「判据要用的事实」。
 *
 * 单源纪律：schema 只经 `parsePrisma` 解析一次，各规则**不许**自己再写一遍正则去读
 * prisma/schema.prisma —— 两份解析器的下一站是两份答案。
 *
 * 这里只做纯派生：输入 SchemaSnapshot，输出两个集合。可在自证里直接喂假快照单测。
 */

import type { SchemaSnapshot } from './providers.ts'

export interface SchemaFacts {
  /**
   * 全部 enum 取值。状态字面量判据的唯一来源。
   * 加一个新状态的人必须改 schema，于是判据自动跟上；靠人工登记表则永远慢一步。
   */
  stateValues: Set<string>
  /** 小写模型名 → 唯一键清单（每项「逗号连接的字段名」，如 'tenantId,email'） */
  uniqueKeys: Map<string, string[]>
  /** enum 名 → 取值（需要区分「哪个 enum」的规则用） */
  enums: Map<string, string[]>
  /** schema 是否真的读到了（false 时依赖 schema 的判据必须显式声明未生效，不许报绿） */
  loaded: boolean
}

export const EMPTY_FACTS: SchemaFacts = {
  stateValues: new Set(),
  uniqueKeys: new Map(),
  enums: new Map(),
  loaded: false,
}

export function factsFrom(snapshot: SchemaSnapshot): SchemaFacts {
  const stateValues = new Set<string>()
  const enums = new Map<string, string[]>()
  for (const e of snapshot.enums) {
    const values = e.values.map((v) => v.name)
    enums.set(e.name, values)
    for (const v of values) stateValues.add(v)
  }
  const uniqueKeys = new Map<string, string[]>()
  for (const m of snapshot.models) {
    // 模型名按小写收敛：schema 里是 `ProcessStep`，代码里是 `tx.processStep`，
    // 大小写差异是最容易写出「一半命中、一半漏」的地方。
    uniqueKeys.set(m.name.toLowerCase(), [...m.uniques])
  }
  return { stateValues, uniqueKeys, enums, loaded: snapshot.enums.length > 0 || snapshot.models.length > 0 }
}

/**
 * 从迁移 SQL 里提取真实存在的唯一索引：
 * Prisma schema 表达不了部分唯一索引，但 DB 里确实有（如 `WHERE status='pending'`）。
 * 只看 `CREATE UNIQUE INDEX ... ON "table" (...)` 与 `ALTER TABLE ... UNIQUE (...)`。
 * 返回 modelName(lower) → 唯一键清单；解析失败不抛错（迁移语法差异不该让判据崩）。
 */
export function parseMigrationUniqueIndexes(
  sql: string,
  tableToModel: Map<string, string>,
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const push = (table: string, columns: string): void => {
    const model = tableToModel.get(table) ?? table.toLowerCase()
    const cols = [...columns.matchAll(/"?([A-Za-z_][\w]*)"?/g)].map((m) => m[1]).filter(Boolean)
    if (cols.length === 0) return
    const list = out.get(model.toLowerCase()) ?? []
    list.push(cols.join(','))
    out.set(model.toLowerCase(), list)
  }
  const createRe = /CREATE\s+UNIQUE\s+INDEX[\s\S]*?\bON\s+"?([A-Za-z_][\w.]*)"?\s*(?:USING\s+\w+\s*)?\(([^)]*)\)/gi
  let m: RegExpExecArray | null
  while ((m = createRe.exec(sql)) !== null) push(m[1], m[2])
  const alterRe = /ALTER\s+TABLE\s+(?:ONLY\s+)?"?([A-Za-z_][\w.]*)"?\s+ADD\s+CONSTRAINT[\s\S]*?\bUNIQUE\s*\(([^)]*)\)/gi
  while ((m = alterRe.exec(sql)) !== null) push(m[1], m[2])
  return out
}

/** 该模型是否有唯一键覆盖给定字段集（子集匹配：键里含齐这些字段即算有） */
export function hasUniqueOver(keys: string[] | undefined, fields: string[]): boolean {
  if (!keys || keys.length === 0) return false
  return keys.some((k) => {
    const parts = k.split(',').map((s) => s.trim())
    return fields.every((f) => parts.includes(f))
  })
}
