import path from 'node:path'
import { readFile } from 'node:fs/promises'

export interface BoundaryConfig {
  authPatterns: string[]
  validatePatterns: string[]
  mutationMethods: string[]
  publicRoutes: { file: string; reason: string }[]
}

export interface StoreConfig {
  moduleRoots: string[]
  sensitiveKeys: string[]
}

export interface QeConfig {
  /** schema 来源。provider=none 表示该仓无 schema，依赖 schema 的守卫显式跳过（不报绿） */
  schema: { provider: string; path: string; clientNames: string[] }
  /** 源码采集器。collector=none 表示不采源码（只跑不依赖代码的守卫） */
  source: { collector: string; roots: string[]; extensions: string[] }
  ignore: string[]
  /** 框架托管字段：允许无业务写点，但必须写明理由（理由即审计口径） */
  systemFields: Record<string, string>
  /** 逐字段豁免：理由必填，禁止空理由 */
  fieldExemptions: { model: string; field: string; reason: string }[]
  contracts: string
  scriptsDirs: string[]
  guardsDir: string
  packageJson: string
  ledger: string
  /** 备案载体：record 级发现的理由 + 复审日期；过期即失效（不再压制发现） */
  waivers: string
  /** 审计批次工作区（QE-03 产物），status 用它计算真洞产出曲线 */
  auditDir: string
  /** 面向人读的输出语言（triage 报告与提示词）；机器读数行始终英文 */
  locale?: 'en' | 'zh'
  /** Next.js 服务端边界判据（可覆盖默认词表） */
  boundaries?: Partial<BoundaryConfig>
  /** 前端模块边界与敏感字段词表 */
  stores?: Partial<StoreConfig>
  /**
   * 是否校验本仓内置的守卫装配（inv13：别名、坏样本、孤儿守卫）。
   * CLI 模式下守卫在 npm 包里，本仓没有 qe/guards，应设为 false。
   */
  metaGuards?: boolean
}

export const defaultSourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

export const defaultConfig: QeConfig = {
  schema: { provider: 'prisma', path: 'prisma/schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
  source: { collector: 'ts', roots: ['src'], extensions: defaultSourceExtensions },
  ignore: ['node_modules', 'dist', 'build', '.next', 'coverage', '.git', 'qe/fixtures', 'qe-report'],
  systemFields: {
    id: '框架生成',
    createdAt: '框架生成',
    updatedAt: '框架生成',
    deletedAt: '软删助手统一写入',
  },
  fieldExemptions: [],
  contracts: 'qe.contracts.json',
  scriptsDirs: ['scripts'],
  guardsDir: 'qe/guards',
  packageJson: 'package.json',
  ledger: 'qe/ledger/incidents.json',
  waivers: 'qe/waivers.json',
  auditDir: 'qe-audit',
  locale: 'en',
  metaGuards: true,
}

/** 深度合并嵌套配置块（schema/source/systemFields），数组整体替换 */
export function mergeConfig(base: QeConfig, patch?: Partial<QeConfig>): QeConfig {
  if (!patch) return { ...base }
  return {
    ...base,
    ...patch,
    schema: { ...base.schema, ...(patch.schema ?? {}) },
    source: { ...base.source, ...(patch.source ?? {}) },
    systemFields: { ...base.systemFields, ...(patch.systemFields ?? {}) },
    boundaries: { ...base.boundaries, ...(patch.boundaries ?? {}) },
    stores: { ...base.stores, ...(patch.stores ?? {}) },
  }
}

export async function loadConfig(root: string): Promise<QeConfig> {
  const file = path.join(root, 'qe.config.json')
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return withSelfIgnore(root, { ...defaultConfig })
  }
  try {
    return withSelfIgnore(root, mergeConfig(defaultConfig, JSON.parse(raw) as Partial<QeConfig>))
  } catch (e) {
    throw new Error(`qe.config.json 解析失败：${(e as Error).message}`)
  }
}

/** copy-in 模式：包目录若在目标仓内，自动排除它，避免扫描到工具本身 */
function withSelfIgnore(root: string, config: QeConfig): QeConfig {
  const packageRoot = path.resolve(import.meta.dirname, '..', '..')
  const rel = path.relative(root, packageRoot).split(path.sep).join('/')
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || config.ignore.includes(rel)) return config
  return { ...config, ignore: [...config.ignore, rel] }
}
