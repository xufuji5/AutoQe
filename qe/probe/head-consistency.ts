/**
 * 三投影一致性（磁盘 / 索引 / HEAD）：回答「这个结论对哪个树成立」。
 *
 * 抽取自 试点 A `scripts/invariants/commit-readiness.ts` 的投影抽象。
 *
 * ## 为什么这不是 git 技巧，而是判据可信度问题
 *
 * 同一份代码有三个投影：
 *   - **磁盘**：tsc / 全部 smoke / 静态扫描看的是这个；
 *   - **索引**：`git commit` 真正提交的是这个；
 *   - **HEAD**：干净检出会不会红看的是这个 —— 发版前唯一必须成立的那条。
 *
 * 三者两两不等，于是出现三类真实事故：
 *   ① 迁移写在磁盘、没入索引 → 磁盘全绿，提交后 HEAD 缺这段迁移（H1）；
 *   ② 索引里已 add、忘了 commit → 本机绿，别人拉下来红（H2）；
 *   ③ 工作树有未提交改动时跑扫描，把「我本地改了没保存到分支」当成「系统没问题」（H3）。
 *
 * ## 纪律
 * 任何门禁回答「绿了」之前，先问「它看哪个树」。本模块把这个问题变成可打印的事实，
 * 而不是靠人记得。
 */
import { execFileSync } from 'node:child_process'

export type ProjectionName = 'disk' | 'index' | 'HEAD'

export type GitState = {
  /** 是否在 git 工作区内 */
  isRepo: boolean
  /** HEAD 相对路径全集（无 HEAD 时为空） */
  head: Set<string>
  /** 索引相对路径全集 */
  index: Set<string>
  /** 工作树改动（含未跟踪），相对路径 → 状态 */
  dirty: Map<string, string>
  /** 当前分支名或 detached 描述 */
  branch: string
  /** HEAD commit sha（短） */
  sha: string
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function splitZ(s: string): string[] {
  return s.split('\0').filter(Boolean)
}

export function readGitState(root: string): GitState {
  try {
    git(root, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    return { isRepo: false, head: new Set(), index: new Set(), dirty: new Map(), branch: '(not a repo)', sha: '' }
  }

  const head = new Set<string>()
  try {
    for (const p of splitZ(git(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']))) head.add(p)
  } catch {
    /* 空仓库：HEAD 不存在 */
  }

  const index = new Set(splitZ(git(root, ['ls-files', '-z'])))

  const dirty = new Map<string, string>()
  // --porcelain -z：`XY path` 后跟 NUL；重命名会是 `R  new\0old\0`，这里按两段吞
  const raw = splitZ(git(root, ['status', '--porcelain', '-z']))
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]
    const code = line.slice(0, 2)
    const path = line.slice(3)
    dirty.set(path, code.trim())
    if (code.startsWith('R') || code.startsWith('C')) i++ // 吞掉 origin path
  }

  let branch = '(detached)'
  try {
    branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  } catch {
    /* 空仓库 */
  }
  let sha = ''
  try {
    sha = git(root, ['rev-parse', '--short', 'HEAD']).trim()
  } catch {
    /* 空仓库 */
  }

  return { isRepo: true, head, index, dirty, branch, sha }
}

export type ConsistencyFinding = {
  /** H1 = 磁盘有索引没有；H2 = 索引有 HEAD 没有；H3 = 工作树脏 */
  kind: 'H1' | 'H2' | 'H3'
  path: string
  detail: string
}

/**
 * 通用三投影检查。
 *
 * @param watch 需要「必须已入库」的路径判定器（例如迁移文件、registry 文件）。
 *              空数组时只做 H3（脏工作树）报告。
 */
export function checkConsistency(
  state: GitState,
  diskFiles: readonly string[],
  watch?: (rel: string) => boolean,
): ConsistencyFinding[] {
  const out: ConsistencyFinding[] = []
  const diskSet = new Set(diskFiles)

  if (watch) {
    for (const f of diskFiles) {
      if (!watch(f)) continue
      if (!state.index.has(f)) {
        out.push({ kind: 'H1', path: f, detail: '在磁盘、不在索引（提交后 HEAD 会缺这个文件）' })
      }
    }
    for (const f of state.index) {
      if (watch(f) && !state.head.has(f)) {
        out.push({ kind: 'H2', path: f, detail: '在索引、不在 HEAD（已 add 未 commit；别人拉下来会红）' })
      }
    }
  }

  const dirtyWatched = watch
    ? [...state.dirty.keys()].filter((p) => watch(p) && (diskSet.has(p) || state.index.has(p)))
    : []
  for (const p of dirtyWatched) {
    out.push({ kind: 'H3', path: p, detail: `工作树有未提交改动（${state.dirty.get(p)}）：本次扫描结论不代表 HEAD` })
  }

  return out
}

/** 一行事实，供报告头部打印 —— 「这次扫描看的是哪个树」必须是可见的，不是可推断的 */
export function describeGitState(s: GitState): string {
  if (!s.isRepo) return '非 git 仓库：结论只对当前磁盘成立（无 HEAD 可比）'
  const parts = [
    `分支 ${s.branch}`,
    `HEAD ${s.sha || '(empty)'}`,
    `HEAD ${s.head.size} 文件`,
    `索引 ${s.index.size} 文件`,
    `工作树脏 ${s.dirty.size} 处`,
  ]
  return parts.join(' / ')
}
