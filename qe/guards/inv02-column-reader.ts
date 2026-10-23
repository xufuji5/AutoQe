import path from 'node:path'
import { defineGuard, info, warn } from '../lib/guard.ts'
import { scanColumns, scanScope } from '../lib/columns.ts'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/inv02-column-reader')

export const inv02 = defineGuard({
  id: 'inv02-column-reader',
  title: '零读取列（无人读，且未声明存档）',
  invariants: ['INV-CORE-02'],
  blindSpots: [
    '只认 select/where/orderBy/cursor/distinct 的显式键；读结果对象属性（user.title）不在射程',
    '不带 select 的查询视为隐式全列读取，因此只要存在一次全量读，本守卫即放行',
    '派生列（计算字段、视图列）不进入判据',
  ],
  async run(ctx) {
    const scan = await scanColumns(ctx.root, ctx.config)
    const findings = []
    for (const f of scan.fields) {
      if (f.exemptReason || f.archiveDeclared || f.implicitReader) continue
      if (f.readers.length === 0 && f.writers.length > 0) {
        findings.push(
          warn('ZERO_READER', `${f.model}.${f.field} 有写点但全仓无读取者：补读点、删除，或在 schema 注释声明「存档」`, {
            entity: `${f.model}.${f.field}`,
            file: ctx.config.schema.path,
            line: f.line,
          }),
        )
      }
    }
    if (findings.length === 0) findings.push(info('ZERO_READER_CLEAN', '零读取列计数=0'))
    return { findings, scanned: scanScope(scan, ctx.config) }
  },
  selfTest: [
    {
      name: 'good：无 select 的全量读覆盖全部列',
      root: path.join(FIXTURES, 'good'),
      expect: 'green',
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
    {
      name: 'bad：select 只取 id，title/body 无人读',
      root: path.join(FIXTURES, 'bad'),
      expect: 'warn',
      minWarnings: 2,
      config: {
        schema: { provider: 'prisma', path: 'schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['src'], extensions: [] },
      },
    },
  ],
})
