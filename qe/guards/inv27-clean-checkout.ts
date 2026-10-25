/**
 * HEAD 从干净检出可构建（INV-CORE-14）。
 *
 * 真实事故（2026-10-25，本仓前置批）：工作树绿、HEAD 脏——构建依赖了未提交的本地
 * 文件，任何人干净 clone 都跑不起来，而开发机上读数全绿。「关键件全部入库」只有在
 * 干净副本里才能被证明。
 *
 * 判据：git worktree 拉出 HEAD 的临时干净副本，在副本里跑仓级声明的 build 命令
 * （config.build.command），非零退出即红。未声明 build 命令 = 本判据没有事实来源，
 * 显式 NotApplicable，不装绿。
 *
 * 定位：发版 gate。环境敏感（D7）——本机 env/全局工具会渗进读数，所以它证明的是
 * 「在这台机器上干净检出可构建」；跨机一致性由 CI 的同一条命令兜底。
 */

import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { defineGuard, err, info, warn } from '../lib/guard.ts'
import type { Finding } from '../lib/guard.ts'
import type { QeConfig, CleanBuildConfig } from '../lib/config.ts'
import { NotApplicable } from '../lib/not-applicable.ts'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

type ConfigPatch = Partial<QeConfig>

function git(root: string, args: string[]): { status: number; stdout: string; stderr: string } | null {
  try {
    const r = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    if (r.error || r.status === null) return null
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  } catch {
    return null
  }
}

export const inv27 = defineGuard({
  id: 'inv27-clean-checkout',
  title: 'HEAD 从干净检出可构建（关键件全部入库）',
  invariants: ['INV-CORE-14'],
  blindSpots: [
    '依赖安装不在射程：build 命令若不自带 install，worktree 里没有 node_modules 会失败——命令声明要端到端',
    '只证明 HEAD 可构建；工作树里未提交的改动不参与（这正是判据目的）',
    '环境敏感（D7）：本机 env、全局工具、凭据会渗进结果；跨机一致性由 CI 跑同一条命令兜底',
    '不校验构建产物的正确性，只校验构建命令退出码',
  ],
  async run(ctx) {
    const build = ctx.config.build
    if (!build?.command?.trim()) {
      throw new NotApplicable(
        'BUILD_UNDECLARED',
        '未声明 config.build.command：干净检出可构建性本轮未检查——这不是干净',
      )
    }
    const probe = git(ctx.root, ['rev-parse', '--is-inside-work-tree'])
    if (probe === null || probe.status !== 0 || probe.stdout.trim() !== 'true') {
      throw new NotApplicable('GIT_UNAVAILABLE', '干净副本必须问 git：当前目录不在 git 工作树内或 git 不可用（没有结论，不是干净）')
    }

    const timeoutSec = Math.min(900, Math.max(30, build.timeoutSec ?? 300))
    const dir = await mkdtemp(path.join(os.tmpdir(), 'qe-clean-'))
    const findings: Finding[] = []
    try {
      const add = git(ctx.root, ['worktree', 'add', '--detach', dir, 'HEAD'])
      if (add === null || add.status !== 0) {
        findings.push(err('WORKTREE_FAIL', `git worktree add 失败：${add?.stderr.trim() || 'git 不可用'}——无法证明干净检出`))
        return { findings, scanned: 'worktree=add-failed' }
      }
      const r = spawnSync(build.command, {
        shell: true,
        cwd: dir,
        timeout: timeoutSec * 1000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        findings.push(
          err('CLEAN_BUILD_TIMEOUT', `干净检出构建超时（>${timeoutSec}s）：${build.command}`, { entity: 'HEAD' }),
        )
      } else if (r.error) {
        findings.push(err('CLEAN_BUILD_SPAWN_FAIL', `构建命令无法启动：${r.error.message}`, { entity: 'HEAD' }))
      } else if (r.status !== 0) {
        const tail = ((r.stderr || '') + (r.stdout || '')).trim().slice(-400)
        findings.push(
          err(
            'CLEAN_BUILD_FAIL',
            `干净检出（HEAD 的 worktree，无未提交文件）构建失败，退出码 ${r.status}：${build.command}\n输出尾部：${tail}`,
            { entity: 'HEAD' },
          ),
        )
      } else {
        findings.push(info('CLEAN_BUILD_OK', `干净检出构建通过（command=${build.command}，timeout=${timeoutSec}s）`))
      }
      return { findings, scanned: `worktree=HEAD command="${build.command}" timeout=${timeoutSec}s` }
    } finally {
      const remove = git(ctx.root, ['worktree', 'remove', '--force', dir])
      if (remove === null || remove.status !== 0) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
        findings.push(warn('WORKTREE_LEFTOVER', `worktree 清理失败，残留 ${dir}：后续 worktree 列表可能被污染，人工核`))
      }
    }
  },
  selfTest: [
    {
      // 本仓是 git 工作树，node -e 恒成功：证明机制（worktree 拉取 + 执行 + 判退出码）成立
      name: 'good：干净检出跑恒真构建命令',
      root: REPO_ROOT,
      expect: 'green',
      config: { build: { command: 'node -e "process.exit(0)"', timeoutSec: 60 } } as ConfigPatch,
    },
    {
      name: 'bad：干净检出跑恒败构建命令（退出码 7 必须红）',
      root: REPO_ROOT,
      expect: 'red',
      minErrors: 1,
      maxErrors: 1,
      config: { build: { command: 'node -e "process.exit(7)"', timeoutSec: 60 } } as ConfigPatch,
    },
  ],
})
