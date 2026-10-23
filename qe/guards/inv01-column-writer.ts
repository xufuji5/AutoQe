import path from 'node:path'
import { defineGuard, err, info, warn } from '../lib/guard.ts'
import { scanColumns, scanScope } from '../lib/columns.ts'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/inv01-column-writer')

export const inv01 = defineGuard({
  id: 'inv01-column-writer',
  title: '零写入列（活表死列）',
  invariants: ['INV-CORE-01'],
  blindSpots: [
    '只统计 Prisma Client 的 create/createMany/update/upsert 的 data 键；$executeRaw 等原生 SQL 写入不可见',
    '嵌套写（items: { create: [...] }）、DB 触发器、DB 默认值不算业务写点',
    '同名但不同 model 的字段按 model 维度隔离，不做类型推理',
  ],
  async run(ctx) {
    const scan = await scanColumns(ctx.root, ctx.config)
    const findings = []
    for (const f of scan.fields) {
      const entity = `${f.model}.${f.field}`
      if (f.exemptReason === '__EMPTY_REASON__') {
        findings.push(
          err('EMPTY_EXEMPTION', `${entity} 的豁免理由为空：豁免必须写明理由，否则等同永久豁免槽`, {
            entity,
            file: ctx.config.schema.path,
            line: f.line,
          }),
        )
        continue
      }
      if (f.exemptReason) continue
      if (f.writers.length === 0) {
        findings.push(
          err('ZERO_WRITER', `${entity}（列 ${f.column}）全仓零写入者：补写入者或删列`, {
            entity,
            file: ctx.config.schema.path,
            line: f.line,
          }),
        )
      }
    }
    if (scan.fields.length === 0) {
      findings.push(err('EMPTY_SCAN', 'schema 解析到 0 个标量字段：判据空集恒真，视为射程失效'))
    } else if (findings.length === 0) {
      findings.push(info('ZERO_WRITER_CLEAN', `零写入列计数=0（标量字段 ${scan.fields.length} 个）`))
    }
    return { findings, scanned: scanScope(scan, ctx.config) }
  },
  selfTest: [
    {
      name: 'good：所有字段都有写点',
      root: path.join(FIXTURES, 'good'),
      expect: 'green',
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
    {
      name: 'bad：body 列零写入',
      root: path.join(FIXTURES, 'bad'),
      expect: 'red',
      minErrors: 1,
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
  ],
})
