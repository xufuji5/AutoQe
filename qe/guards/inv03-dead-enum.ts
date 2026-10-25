import path from 'node:path'
import { collectorFor, loadSchema } from '../lib/providers.ts'
import { defineGuard, err, info, warn } from '../lib/guard.ts'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/inv03-dead-enum')

export const inv03 = defineGuard({
  id: 'inv03-dead-enum',
  title: '死枚举：枚举值没有产生路径',
  invariants: ['INV-CORE-03'],
  blindSpots: [
    '认字符串字面量、EnumName.VALUE、对象键/映射表键；通过常量拼接、跨文件常量/配置、DB 默认值产生的值仍会被误判',
    '「产生路径」按写调用的 data 键 + 直接赋值为准，不算迁移默认值；data 经变量/参数传入时降级为「产生路径未知」warn，不判死值',
    '证据目录（scripts/seeds）里的写点算产生路径，但不参与应用面判据',
    '跨枚举同名值按枚举分别统计',
  ],
  async run(ctx) {
    const schema = await loadSchema(ctx.root, ctx.config)
    const collector = collectorFor(ctx.config)
    const sources = await collector.loadSources(ctx.root, ctx.config)
    const evidence = collector.loadEvidenceSources ? await collector.loadEvidenceSources(ctx.root, ctx.config) : []
    const all = [...sources, ...evidence.filter((e) => !sources.some((s) => s.rel === e.rel))]
    const usages = collector.collectEnumUsages(all, schema, ctx.config)
    const calls = collector.collectCalls(all, schema, ctx.config)
    // 写调用的 data 若经变量/函数参数传入，字段覆盖未知：该模型上的枚举值可能就在那里产生，
    // 不能据「字面量里没见到写」判死值（外部试点 A 的角色码、状态机都有这类写点）。
    const unknownWriterModels = new Set(
      calls.filter((c) => c.kind === 'write' && c.fieldsUnknown).map((c) => c.model),
    )
    const enumNames = new Set(schema.enums.map((e) => e.name))
    const enumModels = new Map<string, Set<string>>()
    for (const m of schema.models) {
      for (const f of m.fields) {
        if (!enumNames.has(f.type)) continue
        const set = enumModels.get(f.type) ?? new Set<string>()
        set.add(m.name)
        enumModels.set(f.type, set)
      }
    }
    const findings = []

    for (const e of schema.enums) {
      for (const v of e.values) {
        const hits = usages.filter((u) => u.enumName === e.name && u.value === v.name)
        const writes = hits.filter((h) => h.context === 'write')
        const reads = hits.filter((h) => h.context === 'read')
        const others = hits.filter((h) => h.context === 'other')
        if (writes.length > 0) continue
        const models = enumModels.get(e.name)
        const writeShapeUnknown = models ? [...models].some((m) => unknownWriterModels.has(m)) : false
        if (reads.length > 0) {
          if (writeShapeUnknown) {
            findings.push(
              warn(
                'WRITE_PATH_UNKNOWN',
                `${e.name}.${v.name} 只在读侧出现（${reads[0].file}:${reads[0].line}），但该枚举所在模型的写点有字段无法静态解析：产生路径未知，不判死值（需人工复核）`,
                { entity: `${e.name}.${v.name}`, file: reads[0].file, line: reads[0].line },
              ),
            )
          } else if (others.length > 0) {
            // 同一个值既被读、又出现在映射表/常量数组这类非读写上下文：
            // 产生路径可能经跨文件常量（外部试点 A 的 CORE_ROLE_CODES 就是这种），不能判死
            findings.push(
              warn(
                'AMBIGUOUS_PATH',
                `${e.name}.${v.name} 有读侧使用，也出现在非写非读上下文（${others[0].file}:${others[0].line}）：产生路径可能经常量间接产生，需人工确认`,
                { entity: `${e.name}.${v.name}`, file: others[0].file, line: others[0].line },
              ),
            )
          } else {
            findings.push(
              err('NO_WRITE_PATH', `${e.name}.${v.name} 只有读侧出现（${reads[0].file}:${reads[0].line}），没有产生路径：补写点或删值`, {
                entity: `${e.name}.${v.name}`,
                file: reads[0].file,
                line: reads[0].line,
              }),
            )
          }
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
    if (valueCount === 0) {
      findings.push(
        warn('NO_ENUM', 'schema 中未发现枚举：本判据本轮无检查对象（0 对象≠已检查）；若本项目本就不用枚举，登记 N/A 并忽略', {
          file: ctx.config.schema.path,
        }),
      )
    } else if (findings.length === 0) {
      findings.push(info('DEAD_ENUM_CLEAN', `死枚举计数=0（枚举 ${schema.enums.length} 个、取值 ${valueCount} 个）`))
    }
    return {
      findings,
      scanned: `provider=${ctx.config.schema.provider} collector=${ctx.config.source.collector} enums=${schema.enums.length} values=${valueCount} files=${all.length} evidenceFiles=${evidence.length} usageSites=${usages.length}`,
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
      name: 'warn：schema 无任何枚举时报 warn 不许假绿（0 对象≠已检查）',
      root: path.join(FIXTURES, 'no-enum'),
      expect: 'warn',
      minWarnings: 1,
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
    {
      name: 'bad：CLOSED 零出现、APPROVED 只有读侧',
      root: path.join(FIXTURES, 'bad'),
      expect: 'red',
      minErrors: 2,
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
    {
      name: 'good：证据目录 scripts 里的写点算产生路径（旧判据会误报死枚举）',
      root: path.join(FIXTURES, 'evidence'),
      expect: 'green',
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [], evidenceRoots: ['scripts'] },
      },
    },
    {
      name: 'warn：枚举值写成对象键时不再判死枚举（旧判据会误报 DEAD_ENUM）',
      root: path.join(FIXTURES, 'object-key'),
      expect: 'warn',
      minWarnings: 1,
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
    {
      name: 'warn：写入 data 走函数参数时降级为「产生路径未知」（旧判据会判 NO_WRITE_PATH）',
      root: path.join(FIXTURES, 'unknown-write'),
      expect: 'warn',
      minWarnings: 2,
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
    {
      name: 'warn：值既被读又作为映射表键（可能经常量间接产生；旧判据判 NO_WRITE_PATH）',
      root: path.join(FIXTURES, 'read-and-key'),
      expect: 'warn',
      minWarnings: 1,
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
  ],
})
