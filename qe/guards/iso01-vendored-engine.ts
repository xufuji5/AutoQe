/**
 * INV-ISO-01：内置（拷贝进项目）的引擎目录必须**无状态**。
 *
 * 事故模型：把引擎目录从 A 项目复制到 B 项目时，若 A 的 `qe.config.json` / `qe/ratchet.json` /
 * `qe/waivers.json` / 报告目录跟着走，B 就会用 A 的配置与基线判自己的代码。
 * 这种继承不报错、不显形，只会让 B 的「0 错」里混着 A 的判断。
 *
 * 射程：root 内能找到 `<engine>/qe/cli.ts` 的目录（排除 root 自身——那说明当前仓就是引擎开发仓，
 * 它的状态属于本项目，合法）。node_modules / dist / .git 等构建与依赖目录不在射程。
 */

import path from 'node:path'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { defineGuard, err } from '../lib/guard.ts'
import { NotApplicable } from '../lib/not-applicable.ts'

const FIXTURES = path.join(import.meta.dirname, '../fixtures/iso01-vendored-engine')

/** 引擎目录里一旦出现这些，就是「项目数据被带进来」 */
const FORBIDDEN = [
  'qe.config.json',
  'qe.contracts.json',
  'qe.project.json',
  'qe/ratchet.json',
  'qe/waivers.json',
  'qe/ledger/incidents.json',
  'qe-report',
  'qe-audit',
  'qe/.fixtures-generated',
  '.fixtures-generated',
]

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage'])

/** 找 root 内所有「引擎副本」目录：判定只看 `<dir>/qe/cli.ts` 是否存在 */
async function engineDirs(root: string): Promise<string[]> {
  const out: string[] = []
  async function rec(dir: string, depth: number): Promise<void> {
    if (depth > 5) return
    if (existsSync(path.join(dir, 'qe', 'cli.ts'))) {
      out.push(dir)
      return // 不再往引擎内部找第二份
    }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
      await rec(path.join(dir, entry.name), depth + 1)
    }
  }
  await rec(root, 0)
  return out
}

const rel = (root: string, file: string): string => path.relative(root, file).split(path.sep).join('/')

export const iso01 = defineGuard({
  id: 'iso01-vendored-engine',
  title: '内置引擎目录无状态（跨项目复制时不携带任何项目数据）',
  invariants: ['INV-ISO-01'],
  blindSpots: [
    '只认 `<dir>/qe/cli.ts` 形态的引擎目录；编译后只留 dist 的副本不在射程',
    '只看状态文件是否存在，不判断内容归属（内容归属由 qe.project.json 身份校验负责）',
    'node_modules 内的包副本按依赖管理处理，不在射程',
  ],
  async run(ctx) {
    const engines = (await engineDirs(ctx.root)).filter((dir) => path.resolve(dir) !== path.resolve(ctx.root))
    if (engines.length === 0) {
      throw new NotApplicable('NO_VENDORED_ENGINE', 'root 内无内置引擎副本（npx / 引擎开发仓模式），无副本可查')
    }
    const findings = []
    for (const engine of engines) {
      for (const name of FORBIDDEN) {
        const file = path.join(engine, ...name.split('/'))
        if (!existsSync(file)) continue
        findings.push(
          err(
            'ENGINE_STATE_CARRIED',
            `内置引擎目录携带项目状态 ${name}：复制/复用引擎时会把它带进下一个项目（删掉该文件；状态属于项目根，不属于引擎）`,
            { file: rel(ctx.root, file), entity: rel(ctx.root, engine) },
          ),
        )
      }
    }
    return {
      findings,
      scanned: `engines=${engines.length} forbidden=${FORBIDDEN.length}`,
    }
  },
  selfTest: [
    {
      name: 'good：内置引擎只有代码，无项目状态',
      root: path.join(FIXTURES, 'good'),
      expect: 'green',
    },
    {
      name: 'bad：内置引擎里带着 ratchet 与 config（跨项目复制即污染）',
      root: path.join(FIXTURES, 'bad'),
      expect: 'red',
      minErrors: 2,
    },
  ],
})
