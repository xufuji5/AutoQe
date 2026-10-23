import path from 'node:path'
import { defineGuard, err, info, warn } from '../lib/guard.ts'
import { DEFECT_CLASSES } from '../registry/types.ts'
import { readTextSafe, rel, walkFiles } from '../lib/fs.ts'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/inv13-addressable')

const SCRIPT_FILE = /(?:^|[\s&|])(?:node|tsx|ts-node|bun)\s+(?:--[\w-]+\s+)*([^\s"'&|]+\.(?:ts|js|mjs|cjs))/g

export const inv13 = defineGuard({
  id: 'inv13-addressable',
  title: '守卫在册必须被跑到（入口/别名/坏样本/复审）',
  invariants: ['INV-CORE-13'],
  blindSpots: [
    '只校验 npm 别名的「存在性」，不校验它是否在 CI 中被调用',
    '不解析 shell 管道与嵌套引号，复杂命令可能漏检',
    'registry 是 TS 模块，本守卫读到的是运行时加载结果，不校验源文件格式',
  ],
  async run(ctx) {
    const pkgText = await readTextSafe(path.join(ctx.root, ctx.config.packageJson))
    if (pkgText === null) {
      return {
        findings: [err('PACKAGE_MISSING', `package.json 未找到：${ctx.config.packageJson}`, { file: ctx.config.packageJson })],
        scanned: 'scripts=0 registry=0',
      }
    }
    let scripts: Record<string, string>
    try {
      scripts = (JSON.parse(pkgText) as { scripts?: Record<string, string> }).scripts ?? {}
    } catch (e) {
      return {
        findings: [err('PACKAGE_BAD', `package.json 解析失败：${(e as Error).message}`, { file: ctx.config.packageJson })],
        scanned: 'scripts=0 registry=0',
      }
    }
    const findings = []
    const now = Date.now()

    for (const inv of ctx.registry) {
      if (inv.defectClasses.length === 0 || inv.defectClasses.some((c) => !DEFECT_CLASSES.includes(c))) {
        findings.push(err('BAD_DEFECT_CLASS', `${inv.id} 的 defectClasses 未归一到 58 号九类（禁止发明第十类）`, { entity: inv.id }))
      }
      if (inv.status === 'enforced' || inv.status === 'partial') {
        if (!inv.guard) findings.push(err('REGISTRY_NO_GUARD', `${inv.id} 标 ${inv.status} 但未登记守卫别名`, { entity: inv.id }))
        else if (!(inv.guard in scripts)) {
          findings.push(err('ALIAS_MISSING', `${inv.id} 的守卫别名 ${inv.guard} 不在 package.json scripts（在册但跑不到）`, { entity: inv.id }))
        }
      }
      if (inv.status === 'enforced' && !inv.badSample) {
        findings.push(err('REGISTRY_NO_BAD_SAMPLE', `${inv.id} 标 enforced 但无坏样本（缺反证不许标在位）`, { entity: inv.id }))
      }
      if (inv.status === 'partial' && !inv.gap) {
        findings.push(err('REGISTRY_NO_GAP', `${inv.id} 标 partial 但未写缺口`, { entity: inv.id }))
      }
      if (inv.status === 'open') {
        if (!inv.openReason || !inv.revisitBy) {
          findings.push(err('REGISTRY_OPEN_UNTRIAGED', `${inv.id} 标 open 但缺理由或复审触发器（无账即红）`, { entity: inv.id }))
        } else if (Date.parse(inv.revisitBy) < now) {
          findings.push(err('REVISIT_OVERDUE', `${inv.id} 的复审日期 ${inv.revisitBy} 已过，未处理转红`, { entity: inv.id }))
        }
      }
    }

    const referenced = new Set<string>()
    for (const [name, command] of Object.entries(scripts)) {
      SCRIPT_FILE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = SCRIPT_FILE.exec(command)) !== null) {
        const target = m[1]
        referenced.add(target)
        referenced.add(path.normalize(target))
        const text = await readTextSafe(path.join(ctx.root, target))
        if (text === null) {
          findings.push(err('SCRIPT_TARGET_MISSING', `${name} 指向不存在的文件 ${target}`, { file: target }))
        }
      }
    }

    let scriptFiles = 0
    for (const dir of ctx.config.scriptsDirs) {
      const files = await walkFiles(ctx.root, dir, { ignore: ctx.config.ignore, ext: ['.ts', '.js', '.mjs', '.cjs'] })
      scriptFiles += files.length
      for (const file of files) {
        const r = rel(ctx.root, file)
        if (!referenced.has(r) && !referenced.has(path.normalize(r))) {
          findings.push(warn('UNWIRED_SCRIPT', `${r} 在盘无入口（package.json 无任何脚本引用）`, { file: r }))
        }
      }
    }

    const guardFiles = await walkFiles(ctx.root, ctx.config.guardsDir, { ignore: ctx.config.ignore, ext: ['.ts'] })
    const indexText = (await readTextSafe(path.join(ctx.root, ctx.config.guardsDir, 'index.ts'))) ?? ''
    for (const file of guardFiles) {
      const base = path.basename(file)
      if (base === 'index.ts') continue
      if (!indexText.includes(base)) {
        findings.push(warn('ORPHAN_GUARD', `${rel(ctx.root, file)} 未被 ${ctx.config.guardsDir}/index.ts 引用`, { file: rel(ctx.root, file) }))
      }
    }

    if (findings.length === 0) {
      findings.push(info('ADDRESSABLE_CLEAN', `registry ${ctx.registry.length} 条、别名 ${Object.keys(scripts).length} 个，全部可寻址`))
    }
    return {
      findings,
      scanned: `registry=${ctx.registry.length} scripts=${Object.keys(scripts).length} scriptFiles=${scriptFiles} guardFiles=${guardFiles.length}`,
    }
  },
  selfTest: [
    {
      name: 'good：别名可寻址、无孤儿脚本',
      root: path.join(FIXTURES, 'good'),
      expect: 'green',
      config: { packageJson: 'package.json', guardsDir: 'guards', scriptsDirs: ['scripts'] },
      registry: [
        {
          id: 'INV-T-01',
          statement: '测试条目：守卫别名必须可寻址',
          defectClasses: ['登记制失效'],
          guard: 'qe:ok',
          badSample: 'fixture',
          status: 'enforced',
        },
      ],
    },
    {
      name: 'bad：别名指向缺失文件 + 孤儿脚本/守卫',
      root: path.join(FIXTURES, 'bad'),
      expect: 'red',
      minErrors: 1,
      minWarnings: 2,
      config: { packageJson: 'package.json', guardsDir: 'guards', scriptsDirs: ['scripts'] },
      registry: [
        {
          id: 'INV-T-01',
          statement: '测试条目：守卫别名必须可寻址',
          defectClasses: ['登记制失效'],
          guard: 'qe:bad',
          badSample: 'fixture',
          status: 'enforced',
        },
      ],
    },
  ],
})
