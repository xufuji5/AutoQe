/**
 * INV-ISO-02 / INV-ISO-03 的反证：跨项目隔离必须是**行为**，不是文档承诺。
 *
 * 每个用例都用两棵不同的临时项目树（A / B）在同一进程里跑，
 * 断言「A 的配置、状态、缓存、样本落盘」都不会进入 B 的判定。
 * 任何一条失败都意味着引擎开始把 A 的理解带进 B——那正是本仓库最贵的缺陷类。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { defaultConfig } from '../qe/lib/config.ts'
import {
  assertBoundary,
  assertIsolation,
  crossTalkRoots,
  ensureIsolation,
  inspectIsolation,
  isInside,
  parseIsolationRoots,
  processTempRoot,
  stripProjectEnv,
} from '../qe/lib/isolation.ts'
import { leakProjectInfo } from '../qe/guards/leak-project-info.ts'
import { loadTsSources } from '../qe/lib/ts-collector.ts'

const tmp = await mkdtemp(path.join(os.tmpdir(), 'autoqe-iso-'))
let cases = 0

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn()
  cases++
  console.log(`OK ${name}`)
}

async function tree(name: string, relFile = 'src/thing.ts', body = 'export const x = 1\n'): Promise<string> {
  const dir = path.join(tmp, name)
  const file = path.join(dir, ...relFile.split('/'))
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, body, 'utf8')
  return dir
}

/**
 * 把一棵临时树变成「可独立运行的项目」：自己的 qe.config.json + 自己的 package.json。
 *
 * `metaGuards: false` 是宿主项目的正常形态——守卫装在 npm 包里，宿主仓没有 qe/guards，
 * inv13 不该要求宿主在每个 package.json 里登记全部 55 条别名。
 */
async function makePseudoProject(dir: string, name: string): Promise<void> {
  const config = {
    schema: { provider: 'none' },
    source: { collector: 'ts', roots: ['src'], extensions: ['.ts'] },
    metaGuards: false,
  }
  await writeFile(path.join(dir, 'qe.config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await writeFile(path.join(dir, 'package.json'), `${JSON.stringify({ name }, null, 2)}\n`, 'utf8')
}

/* ---------------- INV-ISO-02：状态路径围栏 ---------------- */

await check('状态路径逃出 root：waivers=../another-project/... 直接拒绝', () => {
  const root = path.join(tmp, 'escape-waivers')
  assert.throws(
    () => assertBoundary(root, { ...defaultConfig, waivers: '../another-project/qe.waivers.json' }),
    /QE_ISOLATION_STATE_ESCAPE/,
  )
})

await check('扫描范围逃出 root：source.roots=["../another-project/src"] 直接拒绝', () => {
  const root = path.join(tmp, 'escape-src')
  assert.throws(
    () =>
      assertBoundary(root, {
        ...defaultConfig,
        source: { collector: 'ts', roots: ['../another-project/src'], extensions: ['.ts'] },
      }),
    /QE_ISOLATION_STATE_ESCAPE/,
  )
})

await check('合法配置（全部在 root 内）不被误伤', () => {
  assert.doesNotThrow(() =>
    assertBoundary(path.join(tmp, 'ok-root'), {
      ...defaultConfig,
      source: { collector: 'ts', roots: ['src', 'app'], extensions: ['.ts'] },
    }),
  )
})

await check('有状态但无身份：拒绝自动认领（先跑的人不能定义账本归属）', async () => {
  const root = await tree('unbound')
  await mkdir(path.join(root, 'qe'), { recursive: true })
  await writeFile(path.join(root, 'qe', 'ratchet.json'), '{"version":1,"counts":{}}\n', 'utf8')
  assert.throws(() => ensureIsolation(inspectIsolation(root, null)), /QE_ISOLATION_UNBOUND/)
})

await check('显式绑定后身份可读；再跑不会重复生成', async () => {
  const root = await tree('adopted')
  await mkdir(path.join(root, 'qe'), { recursive: true })
  await writeFile(path.join(root, 'qe', 'ratchet.json'), '{"version":1,"counts":{}}\n', 'utf8')
  const first = ensureIsolation(inspectIsolation(root, null), undefined, { adopt: true })
  assert.ok(first.id.length > 0)
  assertIsolation(inspectIsolation(root, null))
  const again = ensureIsolation(inspectIsolation(root, null))
  assert.equal(again.id, first.id, '身份必须稳定，不能每次运行重新生成')
})

await check('外部状态换项目复用：A 的账本拒绝被判给 B', async () => {
  const a = await tree('ext-a')
  const b = await tree('ext-b')
  const extDir = path.join(tmp, 'ext-state')
  await mkdir(extDir, { recursive: true })
  const cfg = path.join(extDir, 'qe.config.json')
  await writeFile(cfg, '{}\n', 'utf8')
  ensureIsolation(inspectIsolation(a, cfg))
  assertIsolation(inspectIsolation(a, cfg))
  assert.throws(() => assertIsolation(inspectIsolation(b, cfg)), /QE_ISOLATION_FOREIGN_ROOT/)
})

await check('状态模式被两套根同时认领：拒绝', async () => {
  const root = await tree('mode-clash')
  ensureIsolation(inspectIsolation(root, null))
  assert.throws(
    () => assertIsolation(inspectIsolation(root, path.join(root, 'qe.config.json'))),
    /QE_ISOLATION_MODE_MISMATCH/,
  )
})

await check('整仓当模板拷走：换了项目名还带着 A 的配置/基线 → 拒绝', async () => {
  const a = await tree('pkg-a')
  const b = await tree('pkg-b')
  await writeFile(path.join(a, 'package.json'), '{"name":"alpha-project"}\n', 'utf8')
  await writeFile(path.join(b, 'package.json'), '{"name":"beta-project"}\n', 'utf8')
  ensureIsolation(inspectIsolation(a, null))
  await copyFile(path.join(a, 'qe.project.json'), path.join(b, 'qe.project.json'))
  assert.throws(() => assertIsolation(inspectIsolation(b, null)), /QE_ISOLATION_PROJECT_MISMATCH/)
})

await check('无 package.json 的工程：项目名不作为拒绝证据（不制造假红）', async () => {
  const a = await tree('pkg-none-a')
  const b = await tree('pkg-none-b')
  await writeFile(path.join(a, 'package.json'), '{"name":"alpha-project"}\n', 'utf8')
  ensureIsolation(inspectIsolation(a, null))
  await copyFile(path.join(a, 'qe.project.json'), path.join(b, 'qe.project.json'))
  assertIsolation(inspectIsolation(b, null))
})

await check('显式 init 才允许重新绑定：模板拷贝后 init 换新身份，运行期仍拒绝', async () => {
  const a = await tree('rebind-a')
  const b = await tree('rebind-b')
  await writeFile(path.join(a, 'package.json'), '{"name":"alpha-project"}\n', 'utf8')
  await writeFile(path.join(b, 'package.json'), '{"name":"beta-project"}\n', 'utf8')
  ensureIsolation(inspectIsolation(a, null))
  await copyFile(path.join(a, 'qe.project.json'), path.join(b, 'qe.project.json'))
  assert.throws(() => assertIsolation(inspectIsolation(b, null)), /QE_ISOLATION_PROJECT_MISMATCH/)
  const rebound = ensureIsolation(inspectIsolation(b, null), undefined, { adopt: true })
  assert.notEqual(rebound.id, readMarkerId(path.join(a, 'qe.project.json')), '重新绑定必须换新身份')
  assertIsolation(inspectIsolation(b, null))
})

function readMarkerId(file: string): string {
  return JSON.parse(readFileSync(file, 'utf8')).id as string
}

/* ---------------- INV-ISO-03：运行期产物与缓存 ---------------- */

await check('规则样本落盘在进程级临时目录，不在项目内、也不在引擎目录内', async () => {
  const root = await tree('temp-check')
  const temp = processTempRoot()
  const engine = path.resolve(import.meta.dirname, '..')
  assert.ok(isInside(path.resolve(os.tmpdir()), temp), '临时根必须落在系统临时目录')
  assert.ok(!isInside(root, temp), '临时根不得落在目标项目内')
  assert.ok(!isInside(engine, temp), '临时根不得落在引擎目录内')
})

await check('A 的 denylist 配置不会粘到 B 上（同一进程顺序扫描）', async () => {
  const a = await tree('leak-a', 'src/thing.ts', 'export const codename = "acmecodeword"\n')
  const b = await tree('leak-b', 'src/thing.ts', 'export const codename = "acmecodeword"\n')
  await mkdir(path.join(a, 'qe'), { recursive: true })
  await writeFile(path.join(a, 'qe', 'deny.txt'), 'acmecodeword\n', 'utf8')

  const saved = process.env.AUTOQE_DENYLIST
  delete process.env.AUTOQE_DENYLIST
  try {
    const configA = {
      ...defaultConfig,
      source: { collector: 'ts', roots: ['src'], extensions: ['.ts'] },
      leak: { selfAudit: true, denylist: 'qe/deny.txt', domainVocab: false },
    }
    const configB = {
      ...defaultConfig,
      source: { collector: 'ts', roots: ['src'], extensions: ['.ts'] },
      leak: { selfAudit: true, domainVocab: false },
    }
    const ra = await leakProjectInfo.run({ root: a, config: configA, registry: [] })
    const rb = await leakProjectInfo.run({ root: b, config: configB, registry: [] })
    assert.ok(ra.findings.some((f) => f.code === 'PROJECT_CODEWORD'), 'A 必须命中自己的黑名单')
    assert.ok(!rb.findings.some((f) => f.code === 'PROJECT_CODEWORD'), 'B 不得继承 A 的黑名单')
  } finally {
    if (saved === undefined) delete process.env.AUTOQE_DENYLIST
    else process.env.AUTOQE_DENYLIST = saved
  }
})

await check('AST 缓存绑定 root：扫完 A 再扫 B，B 只看到自己的文件', async () => {
  const a = await tree('cache-a', 'src/a.ts', 'export const fromA = 1\n')
  const b = await tree('cache-b', 'src/b.ts', 'export const fromB = 1\n')
  const config = { ...defaultConfig, source: { collector: 'ts', roots: ['src'], extensions: ['.ts'] }, ignore: [] }
  assert.deepEqual((await loadTsSources(a, config)).map((f) => f.rel), ['src/a.ts'])
  assert.deepEqual((await loadTsSources(b, config)).map((f) => f.rel), ['src/b.ts'])
  assert.deepEqual((await loadTsSources(a, config)).map((f) => f.rel), ['src/a.ts'])
})

/* ---------------- INV-ISO-04：并发（同一个 Workbuddy 同时处理多个项目） ---------------- */

await check('同一进程并发扫两棵树：AST 缓存分表，结果不交叉', async () => {
  const a = await tree('par-cache-a', 'src/a.ts', 'export const fromA = 1\n')
  const b = await tree('par-cache-b', 'src/b.ts', 'export const fromB = 1\n')
  const config = { ...defaultConfig, source: { collector: 'ts', roots: ['src'], extensions: ['.ts'] }, ignore: [] }
  const [sa, sb] = await Promise.all([loadTsSources(a, config), loadTsSources(b, config)])
  assert.deepEqual(sa.map((f) => f.rel), ['src/a.ts'])
  assert.deepEqual(sb.map((f) => f.rel), ['src/b.ts'])
})

await check('并发两个进程扫两个项目：各自只看到自己的 root 与缺陷', async () => {
  const dirty = await tree(
    'proc-dirty',
    'src/x.ts',
    'export async function f(db: any) {\n  try { await db.update({ id: 1 }) } catch {}\n}\n',
  )
  const clean = await tree('proc-clean', 'src/x.ts', 'export const clean = 1\n')
  const entry = path.resolve(import.meta.dirname, '..', 'qe', 'cli.ts')
  const [rd, rc] = await Promise.all([
    runCli(entry, ['run', '--root', dirty, '--only', 'aq03', '--no-report'], dirty),
    runCli(entry, ['run', '--root', clean, '--only', 'aq03', '--no-report'], clean),
  ])
  assert.match(rd.stdout, /QE_RESULT guards=1 errors=1/, 'A 有吞异常缺陷必须红')
  assert.match(rc.stdout, /QE_RESULT guards=1 errors=0/, 'B 干净必须绿')
  assert.equal(rd.code, 1)
  assert.equal(rc.code, 0)
  assert.ok(rd.stdout.includes(`root=${dirty}`), 'A 的读数必须指向 A')
  assert.ok(!rd.stdout.includes(clean), 'A 的读数里不得出现 B 的路径')
  assert.ok(!rc.stdout.includes(dirty), 'B 的读数里不得出现 A 的路径')
  assert.equal(existsSync(path.join(dirty, 'qe', '.fixtures-generated')), false, '样本不得落进项目根')
  assert.equal(existsSync(path.join(clean, 'qe', '.fixtures-generated')), false)
})

await check('multi 并发编排：两个项目一起跑，结果按 root 分开报告', async () => {
  const dirty = await tree(
    'multi-dirty',
    'src/x.ts',
    'export async function f(db: any) {\n  try { await db.update({ id: 1 }) } catch {}\n}\n',
  )
  const clean = await tree('multi-clean', 'src/x.ts', 'export const clean = 1\n')
  // 两棵树各自带**自己的**配置与项目身份：multi 不允许子进程继承调用方的配置，
  // 所以这里必须模拟「两个真实项目」，而不是「同一个项目的两份拷贝」。
  await makePseudoProject(dirty, 'multi-dirty')
  await makePseudoProject(clean, 'multi-clean')
  const entry = path.resolve(import.meta.dirname, '..', 'qe', 'cli.ts')
  const out = await runCli(entry, ['multi', '--roots', `${dirty},${clean}`, '--command', 'run', '--no-report'], tmp)
  assert.match(out.stdout, /MULTI_RESULT roots=2 failed=1 status=red/)
  assert.match(out.stdout, /isolation=verified crossTalk=0 mismatched=0/, '每个子进程必须输出自己的 ISOLATION 读数且无串读')
  assert.match(out.stdout, new RegExp(`MULTI root=${escapeRe(dirty)} errors=\\d+`), 'A 必须有独立读数')
  assert.match(out.stdout, new RegExp(`MULTI root=${escapeRe(clean)} errors=0`), 'B 必须有独立读数')
  assert.equal(out.code, 1, '有项目失败时 multi 必须整体失败（不许把红平均成绿）')
})

/* ---------------- INV-ISO-04：隔离证明本身可判 ---------------- */

await check('项目级环境变量按前缀剥掉：AUTOQE_* / QE_* 全部不进子进程（新变量自动覆盖）', () => {
  const { env, stripped } = stripProjectEnv({
    PATH: '/usr/bin',
    HOME: '/home/u',
    AUTOQE_CONFIG: '/a/qe.config.json',
    AUTOQE_DENYLIST: '/a/deny.txt',
    AUTOQE_FUTURE_CHANNEL: 'x',
    QE_PROFILE: '1',
  })
  assert.equal(env.AUTOQE_CONFIG, undefined)
  assert.equal(env.AUTOQE_DENYLIST, undefined)
  assert.equal(env.AUTOQE_FUTURE_CHANNEL, undefined, '未来新增的 AUTOQE_* 也必须被剥掉，不能靠改清单')
  assert.equal(env.QE_PROFILE, undefined)
  assert.equal(env.PATH, '/usr/bin', '非项目级变量必须原样保留')
  assert.equal(env.HOME, '/home/u')
  assert.deepEqual(stripped, ['AUTOQE_CONFIG', 'AUTOQE_DENYLIST', 'AUTOQE_FUTURE_CHANNEL', 'QE_PROFILE'])
})

await check('--inherit-env 是显式选择：keep 时一个都不剥', () => {
  const { env, stripped } = stripProjectEnv({ PATH: '/x', AUTOQE_CONFIG: '/a.json' }, { keep: true })
  assert.equal(env.AUTOQE_CONFIG, '/a.json')
  assert.deepEqual(stripped, [])
})

await check('串读检测：输出里出现另一个项目的 root 即命中', () => {
  const a = path.join(tmp, 'cross-a')
  const b = path.join(tmp, 'cross-b')
  assert.deepEqual(crossTalkRoots(a, [b], `DETAIL ${b}/src/x.ts:3 ZERO_WRITER`), [b])
  assert.deepEqual(crossTalkRoots(a, [b], `DETAIL ${a}/src/x.ts:3 ZERO_WRITER`), [])
})

await check('串读检测：前缀与嵌套子目录都不误判（否则判据变假红）', () => {
  const a = path.join(tmp, 'prefix-a')
  const b = path.join(tmp, 'prefix-a-2')
  // 站在 b 的视角找 a：文本里只有 b，但 b 的目录名以 a 为前缀 → 不得命中
  assert.deepEqual(crossTalkRoots(b, [a], `see ${b}/src/x.ts`), [], '路径前缀不得算命中')
  const child = path.join(tmp, 'nested-child')
  assert.deepEqual(crossTalkRoots(tmp, [child], `legit ${child}/src/x.ts`), [], '扫父项目时出现子目录路径是合法的')
})

await check('ISOLATION 读数可解析：root 含空格也能取全（否则 multi 判据变假红）', () => {
  const line = 'ISOLATION mode=project root=C:/A B/proj stateRoot=C:/A B/proj id=abcd1234 env=none'
  assert.deepEqual(parseIsolationRoots(line), ['C:/A B/proj'])
})

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 跑一次真实 CLI（独立进程），cwd 切到目标项目 */
function runCli(entry: string, args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      env: { ...process.env, AUTOQE_CONFIG: '', AUTOQE_DENYLIST: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8')
    })
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
    })
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.on('error', (e) => resolve({ code: 1, stdout, stderr: stderr + e.message }))
  })
}

console.log(`ISOLATION_SELFTEST cases=${cases} passed=${cases}`)
