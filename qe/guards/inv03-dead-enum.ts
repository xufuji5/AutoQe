import path from 'node:path'
import { collectorFor, loadSchema } from '../lib/providers.ts'
import { defineGuard, err, info, warn } from '../lib/guard.ts'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/inv03-dead-enum')

export const inv03 = defineGuard({
  id: 'inv03-dead-enum',
  title: '死枚举：枚举值没有产生路径',
  invariants: ['INV-CORE-03'],
  blindSpots: [
    '只认字符串字面量与 EnumName.VALUE 两种写法；通过常量拼接、配置表、DB 默认值产生的值会被误判',
    '「产生路径」按写调用的 data 键 + 直接赋值为准，不算迁移默认值',
    '跨枚举同名值按枚举分别统计',
  ],
  async run(ctx) {
    const schema = await loadSchema(ctx.root, ctx.config)
    const collector = collectorFor(ctx.config)
    const sources = await collector.loadSources(ctx.root, ctx.config)
    const usages = collector.collectEnumUsages(sources, schema, ctx.config)
    const findings = []

    for (const e of schema.enums) {
      for (const v of e.values) {
        const hits = usages.filter((u) => u.enumName === e.name && u.value === v.name)
        const writes = hits.filter((h) => h.context === 'write')
        const reads = hits.filter((h) => h.context === 'read')
        const others = hits.filter((h) => h.context === 'other')
        if (writes.length > 0) continue
        if (reads.length > 0) {
          findings.push(
            err('NO_WRITE_PATH', `${e.name}.${v.name} 只有读侧出现（${reads[0].file}:${reads[0].line}），没有产生路径：补写点或删值`, {
              entity: `${e.name}.${v.name}`,
              file: reads[0].file,
              line: reads[0].line,
            }),
          )
        } else if (others.length > 0) {
          findings.push(
            warn('AMBIGUOUS_PATH', `${e.name}.${v.name} 只在非写非读上下文出现（${others[0].file}:${others[0].line}），需人工确认产生路径`, {
              entity: `${e.name}.${v.name}`,
              file: others[0].file,
              line: others[0].line,
            }),
          )
        } else {
          findings.push(
            err('DEAD_ENUM', `${e.name}.${v.name} 全仓零出现：死枚举，当场裁决（删值或补写点）`, {
              entity: `${e.name}.${v.name}`,
              file: ctx.config.schema.path,
              line: v.line,
            }),
          )
        }
      }
    }

    const valueCount = schema.enums.reduce((n, e) => n + e.values.length, 0)
    if (valueCount === 0) findings.push(info('NO_ENUM', 'schema 中未发现枚举'))
    else if (findings.length === 0) {
      findings.push(info('DEAD_ENUM_CLEAN', `死枚举计数=0（枚举 ${schema.enums.length} 个、取值 ${valueCount} 个）`))
    }
    return {
      findings,
      scanned: `provider=${ctx.config.schema.provider} collector=${ctx.config.source.collector} enums=${schema.enums.length} values=${valueCount} files=${sources.length} usageSites=${usages.length}`,
    }
  },
  selfTest: [
    {
      name: 'good：每个取值都有写点',
      root: path.join(FIXTURES, 'good'),
      expect: 'green',
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
    {
      name: 'bad：CANCELLED 零出现、SHIPPED 只有读侧',
      root: path.join(FIXTURES, 'bad'),
      expect: 'red',
      minErrors: 2,
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
  ],
})
