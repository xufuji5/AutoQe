/**
 * 判据的断言对象必须是可提交物（INV-META-03）。
 *
 * 真实事故（2026-10-25，本仓）：两个一次性诊断脚本含本机绝对路径与外部项目代号，
 * 未提交也未被 gitignore，leak 守卫当场报红 5 条。同族的反面形态更阴：
 * 判据扫描一个被 gitignore 的路径——开发机上文件存在所以绿，CI 干净检出时文件
 * 不存在所以红；或更糟：两边都绿，因为扫描空集恒真（D1）。
 *
 * 所以「断言对象指向哪」本身要被判：config 里声明的每个断言对象路径
 * （schema.path / source.roots / contracts / spec.docs / stores.moduleRoots）必须
 *   1. 存在——否则判据在虚空上空转；
 *   2. 未被 git 忽略——否则它根本不是可提交物，开发机/CI 各说各话；
 *   3. 已被 git 跟踪（目录则至少含一个被跟踪文件）——存在但没入库，与 2 同病。
 *
 * 三条都必须问 git，所以非 git 工作树 / git 不可用时整条不适用（NotApplicable），
 * 不许假绿。判定顺序即上列顺序：missing 不依赖 git 也照此报，保证三档语义不混。
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { stat } from 'node:fs/promises'
import { defineGuard, err, info } from '../lib/guard.ts'
import type { Finding } from '../lib/guard.ts'
import type { QeConfig } from '../lib/config.ts'
import { NotApplicable } from '../lib/not-applicable.ts'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const FIXTURES = path.join(import.meta.dirname, '../fixtures/inv24-assert-target')

interface Target {
  /** 配置里的声明位（进 finding.entity，便于定位是哪一条配置） */
  label: string
  rel: string
}

/**
 * 收集 config 声明的断言对象路径。provider/collector=none 时对应路径不参与
 * （声明了「没有」就不许再判它指向哪——否则把正当声明判成缺陷）。
 */
function collectTargets(config: QeConfig): Target[] {
  const out: Target[] = []
  if (config.schema.provider !== 'none') out.push({ label: 'schema.path', rel: config.schema.path })
  if (config.source.collector !== 'none') {
    config.source.roots.forEach((rel, i) => out.push({ label: `source.roots[${i}]`, rel }))
  }
  if (config.contracts.trim()) out.push({ label: 'contracts', rel: config.contracts })
  ;(config.spec?.docs ?? []).forEach((rel, i) => out.push({ label: `spec.docs[${i}]`, rel }))
  ;(config.stores?.moduleRoots ?? []).forEach((rel, i) => out.push({ label: `stores.moduleRoots[${i}]`, rel }))
  return out
}

interface GitReply {
  status: number
  stdout: string
}

/** 跑一条 git 命令并保留退出码；git 不存在 / 超时 / 启动失败返回 null（= 没结论，不许当干净） */
function git(root: string, args: string[]): GitReply | null {
  try {
    const r = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    if (r.error || r.status === null) return null
    return { status: r.status, stdout: r.stdout ?? '' }
  } catch {
    return null
  }
}

const GIT_UNAVAILABLE = () =>
  new NotApplicable(
    'GIT_UNAVAILABLE',
    '判定「被忽略/未跟踪」必须问 git，而当前目录不在 git 工作树内或 git 不可用：本判据没有结论（不是干净）',
  )

export const inv24 = defineGuard({
  id: 'inv24-assert-target',
  title: '判据的断言对象必须是可提交物（存在 / 未被忽略 / 已被跟踪）',
  invariants: ['INV-META-03'],
  blindSpots: [
    '只覆盖 qe.config.json 的声明位（schema.path / source.roots / contracts / spec.docs / stores.moduleRoots）；qe/rules/ 规则层的内联夹具是字符串不是路径，不在射程',
    'qe/probe 运行时探针的断言对象在运行期才知道，不在射程',
    '目录只查「目录自身是否被忽略 + 是否至少有一个被跟踪文件」；目录内部个别文件被忽略不逐层展开（check-ignore 全量递归的读数噪声大于收益）',
    'UNTRACKED 一档无法用静态夹具自证（提交进仓的文件必然已被跟踪），自证用 .git（恒存在、恒零跟踪）替代——形状相同，语义换成「目录里没有任何可提交物」',
    'check-ignore 读的是工作树里的 .gitignore：.gitignore 自身未提交时规则仍生效，但「.gitignore 本身是不是可提交物」不在本判据射程',
  ],
  async run(ctx) {
    const probe = git(ctx.root, ['rev-parse', '--is-inside-work-tree'])
    if (probe === null || probe.status !== 0 || probe.stdout.trim() !== 'true') throw GIT_UNAVAILABLE()

    const targets = collectTargets(ctx.config)
    if (targets.length === 0) {
      return {
        findings: [err('EMPTY_SCAN', 'config 没有声明任何断言对象路径（provider/collector 均为 none 且 contracts/spec/stores 未配置）：本守卫空转，空集恒真不算绿')],
        scanned: 'targets=0',
      }
    }

    const findings: Finding[] = []
    let missing = 0
    let ignored = 0
    let untracked = 0
    let ok = 0

    for (const t of targets) {
      const st = await stat(path.resolve(ctx.root, t.rel)).catch(() => null)
      if (st === null) {
        missing++
        findings.push(
          err('ASSERT_TARGET_MISSING', `${t.label} 指向不存在的路径 ${t.rel}：判据在虚空上空转（扫空集恒真＝假绿）`, { entity: t.label }),
        )
        continue
      }
      const posixRel = t.rel.split(path.sep).join('/')
      const ig = git(ctx.root, ['check-ignore', '-q', '--', posixRel])
      if (ig === null || (ig.status !== 0 && ig.status !== 1)) throw GIT_UNAVAILABLE()
      if (ig.status === 0) {
        ignored++
        findings.push(
          err(
            'ASSERT_ON_IGNORED',
            `${t.label} 指向被 git 忽略的路径 ${t.rel}：它在开发机上存在（恒绿）、在干净检出里不存在（恒红或扫空集假绿）——断言对象必须可提交`,
            { entity: t.label },
          ),
        )
        continue
      }
      const tracked = git(ctx.root, ['ls-files', '--cached', '--', posixRel])
      if (tracked === null || tracked.status !== 0) throw GIT_UNAVAILABLE()
      if (tracked.stdout.trim() === '') {
        untracked++
        findings.push(
          err(
            'ASSERT_ON_UNTRACKED',
            `${t.label} 指向存在但未被 git 跟踪的${st.isDirectory() ? '目录（其中没有任何已入库文件）' : '文件'} ${t.rel}：提交不了的东西当判据对象，干净检出即空转`,
            { entity: t.label },
          ),
        )
        continue
      }
      ok++
    }

    if (findings.length === 0) {
      findings.push(info('ASSERT_TARGET_CLEAN', `${targets.length} 个断言对象路径全部存在、未被忽略、已被 git 跟踪`))
    }
    return {
      findings,
      scanned: `targets=${targets.length} ok=${ok} missing=${missing} ignored=${ignored} untracked=${untracked} [${targets.map((t) => t.label).join(', ')}]`,
    }
  },
  selfTest: [
    {
      // 本仓真实状态即 green 证据：config 声明的断言对象全部已入库。
      // 不用合成夹具装 green——夹具文件在提交前本身就是未跟踪的，装出来的 green 恰好是本判据要抓的形态。
      name: 'good：本仓 config 的断言对象（demo schema/src/contracts）全部可提交',
      root: REPO_ROOT,
      expect: 'green',
      config: {
        schema: { provider: 'prisma', path: 'qe/demo/prisma/schema.prisma', clientNames: ['prisma', 'db', 'tx'] },
        source: { collector: 'ts', roots: ['qe/demo/src'], extensions: [] },
        contracts: 'qe/demo/qe.contracts.json',
      },
    },
    {
      name: 'bad：schema.path 指向不存在的路径（判据空转）',
      root: path.join(FIXTURES, 'bad-missing'),
      expect: 'red',
      minErrors: 1,
      config: {
        schema: { provider: 'prisma', path: 'no/such/schema.prisma', clientNames: [] },
        source: { collector: 'none', roots: [], extensions: [] },
        contracts: 'qe.contracts.json',
      },
    },
    {
      // .gitignore 在工作树里即生效（与自身是否入库无关），所以本用例在提交前也能红
      name: 'bad：schema.path 落在 .gitignore 覆盖的目录里（开发机恒绿/CI 恒红的原型）',
      root: path.join(FIXTURES, 'bad-ignored'),
      expect: 'red',
      minErrors: 1,
      config: {
        schema: { provider: 'prisma', path: 'ignored-target/schema.prisma', clientNames: [] },
        source: { collector: 'none', roots: [], extensions: [] },
        contracts: 'qe.contracts.json',
      },
    },
    {
      // 未跟踪无法做成静态夹具（入库即被跟踪）。.git 恒存在、恒零跟踪，且在不带 .git 的
      // 分发形态（npm 包）里退化为 ASSERT_TARGET_MISSING——两种形态都是 red，读数稳定。
      name: 'bad：断言对象存在但没有任何已入库文件（.git 恒为零跟踪目录）',
      root: REPO_ROOT,
      expect: 'red',
      minErrors: 1,
      maxErrors: 1,
      config: {
        schema: { provider: 'prisma', path: '.git', clientNames: [] },
        source: { collector: 'none', roots: [], extensions: [] },
        contracts: 'qe/demo/qe.contracts.json',
      },
    },
  ],
})
