/**
 * 报告落点单源：CLI `--out` / `--no-report` / 外部 `--config` / `config.reportDir` 的唯一解析处。
 *
 * ## 为什么必须有这一层
 *
 * 审计别人的仓时最贵的事故不是「扫出多少条」，而是**往被审计仓里写文件**：
 * 一旦默认落点仍是 `<root>/qe-report`，`--config` 那句「不往被审计仓写任何文件」就是假的，
 * 而且这种假承诺不会以报错的形式出现（文件静静地建在那里）。
 *
 * 优先级（高 → 低）：
 *   1. `--no-report`      → null（只出读数，不落盘）
 *   2. `--out <dir>`       → 绝对路径原样用；相对路径按当前工作目录解析（调用方显式指定就该尊重）
 *   3. 外部 `--config`     → `<配置文件目录>/qe-report`（可被 config.reportDir 覆盖，相对配置目录）
 *   4. `config.reportDir`  → 绝对路径原样用；相对路径按目标 root 解析
 *   5. 默认               → `<root>/qe-report`
 */

import path from 'node:path'
import type { QeConfig } from './config.ts'

export interface ReportLocationInput {
  root: string
  config: QeConfig
  /** 外部 --config / AUTOQE_CONFIG 的绝对路径；未使用外部配置时为 null */
  configFile?: string | null
  /** CLI --out */
  out?: string | null
  /** CLI --no-report */
  noReport?: boolean
  /** 相对 --out 的解析基准；默认 process.cwd()（仅测试需要固定它） */
  cwd?: string
}

export function resolveReportDir(input: ReportLocationInput): string | null {
  if (input.noReport) return null
  if (input.out && input.out.trim()) {
    const out = input.out.trim()
    return path.isAbsolute(out) ? path.normalize(out) : path.resolve(input.cwd ?? process.cwd(), out)
  }
  const rel = input.config.reportDir
  if (input.configFile) {
    const base = path.dirname(input.configFile)
    if (rel && path.isAbsolute(rel)) return path.normalize(rel)
    return path.join(base, rel && rel.trim() ? rel : 'qe-report')
  }
  if (rel && rel.trim()) {
    return path.isAbsolute(rel) ? path.normalize(rel) : path.join(input.root, rel)
  }
  return path.join(input.root, 'qe-report')
}

/** 落点展示：root 内的路径给相对路径（可粘贴），root 外给绝对路径（避免 `..\..\` 噪声） */
export function displayPath(root: string, file: string): string {
  const rel = path.relative(root, file).split(path.sep).join('/')
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel
  return file.split(path.sep).join('/')
}
