/**
 * 引擎自身的自证例（不是守卫的 fixture）。
 *
 * 这些工具函数一旦错了，所有用它们的判据会一起错，而且错得安静：
 *   - 迁移唯一索引解析少了 → 「DB 已挡双写」的表被报成竞态（假红）
 *   - 报告落点解析错了 → 审计别人的仓时把文件写进人家仓库（假承诺）
 *
 * 纪律：新增工具函数必须同时给出「坏样本先红」的反证；`autoqe selftest` 会跑本表。
 */

import path from 'node:path'
import type { SelfCase } from './code-only.ts'
import { hasUniqueOver, parseMigrationUniqueIndexes } from './schema-facts.ts'
import { currentCounts, guardOf, splitByCoverage } from './ratchet.ts'
import { resolveReportDir } from './report-path.ts'
import { stateFilesInIndex } from './repo-hygiene.ts'
import { defaultConfig } from './config.ts'

const tableToModel = new Map([
  ['User', 'User'],
  ['Order', 'Order'],
])

const MIGRATION_SQL = `
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "Order_created_idx" ON "Order"("createdAt");
CREATE UNIQUE INDEX "Order_pending_key" ON "Order"("tenantId", "code") WHERE status = 'pending';
ALTER TABLE "User" ADD CONSTRAINT "User_phone_key" UNIQUE ("phone");
`

export const ENGINE_SELFTEST: SelfCase[] = (() => {
  const cases: SelfCase[] = []
  const push = (name: string, ok: boolean, detail?: unknown) => cases.push({ name, ok, detail })

  const parsed = parseMigrationUniqueIndexes(MIGRATION_SQL, tableToModel)

  push(
    '迁移 SQL：CREATE UNIQUE INDEX 能落到对应 model',
    hasUniqueOver(parsed.get('user'), ['email']),
    parsed.get('user'),
  )
  push(
    '迁移 SQL：ALTER TABLE ADD CONSTRAINT UNIQUE 能落到对应 model',
    hasUniqueOver(parsed.get('user'), ['phone']),
    parsed.get('user'),
  )
  push(
    '迁移 SQL：部分唯一索引（WHERE 条件）也算唯一键',
    hasUniqueOver(parsed.get('order'), ['tenantId', 'code']),
    parsed.get('order'),
  )
  push(
    '迁移 SQL：普通 CREATE INDEX 不得算唯一约束（否则竞态会被静默放过）',
    !hasUniqueOver(parsed.get('order'), ['createdAt']),
    parsed.get('order'),
  )
  push('迁移 SQL：空输入返回空表，不抛错', parseMigrationUniqueIndexes('', tableToModel).size === 0)

  const root = path.resolve('/tmp/qe-root')
  const cfg = { ...defaultConfig }

  push(
    '报告落点：无参数时落在 <root>/qe-report',
    resolveReportDir({ root, config: cfg, configFile: null }) === path.join(root, 'qe-report'),
  )
  push(
    '报告落点：外部 --config 默认落在配置文件旁，不写被审计仓',
    resolveReportDir({ root, config: cfg, configFile: path.resolve('/tmp/engine/qe.config.external.json') }) ===
      path.join(path.resolve('/tmp/engine'), 'qe-report'),
  )
  push(
    '报告落点：config.reportDir 相对外部配置目录解析',
    resolveReportDir({
      root,
      config: { ...cfg, reportDir: 'reports/external' },
      configFile: path.resolve('/tmp/engine/qe.config.external.json'),
    }) === path.join(path.resolve('/tmp/engine'), 'reports/external'),
  )
  push(
    '报告落点：config.reportDir 相对 root 解析（未用外部配置时）',
    resolveReportDir({ root, config: { ...cfg, reportDir: 'out/qe' }, configFile: null }) ===
      path.join(root, 'out/qe'),
  )
  push(
    '报告落点：--out 绝对路径原样使用',
    resolveReportDir({ root, config: cfg, configFile: null, out: path.resolve('/tmp/out/abs') }) ===
      path.resolve('/tmp/out/abs'),
  )
  push(
    '报告落点：--out 相对路径按 cwd 解析（显式指定就该尊重）',
    resolveReportDir({ root, config: cfg, configFile: null, out: 'rel/out', cwd: path.resolve('/tmp/cwd') }) ===
      path.join(path.resolve('/tmp/cwd'), 'rel/out'),
  )
  push(
    '报告落点：--no-report 优先于一切（返回 null，不落盘）',
    resolveReportDir({
      root,
      config: cfg,
      configFile: path.resolve('/tmp/engine/qe.config.external.json'),
      out: path.resolve('/tmp/out/abs'),
      noReport: true,
    }) === null,
  )

  // ── ratchet 覆盖切分：未测 ≠ 修好 ───────────────────────────────────────────
  // 反证形态：`--only inv13` 只跑一个守卫时，基线里别的键必须落进 unverified，
  // 而不是落进 verified（落错就变成报告上「已改善，请跑 ratchet-update」）。
  {
    const base = ['inv13:a', 'inv13:b', 'inv20:c']
    const one = splitByCoverage(base, ['inv13'])
    push('ratchet 覆盖：只跑 inv13 时 inv20 的键进 unverified', one.unverified.join(',') === 'inv20:c', one)
    push('ratchet 覆盖：跑过的守卫的键仍在 verified', one.verified.join(',') === 'inv13:a,inv13:b', one)
    const none = splitByCoverage(base, [])
    push('ratchet 覆盖：一个守卫都没跑 ⇒ 全部 unverified（空集不许自证）', none.verified.length === 0 && none.unverified.length === 3, none)
    const all = splitByCoverage(base, ['inv13', 'inv20'])
    push('ratchet 覆盖：跑全量 ⇒ unverified 为空', all.unverified.length === 0 && all.verified.length === 3, all)
    push('ratchet 键解析：code 里带冒号也只按第一个冒号切守卫名', guardOf('inv20:MUTATION_NO_IDEMPOTENCY:X') === 'inv20')
    push('ratchet 键解析：没有冒号的键自成守卫名（不返回空串）', guardOf('lonely') === 'lonely')
  }

  // ── 跳过进棘轮：射程缩小必须和缺陷变多一样算回归 ─────────────────────────────
  //
  // 反证形态（这是本轮引擎最贵的教训）：跳过是一个**单向**旋钮 —— 判据每关掉一类
  // 「不适用」，它的 findings 就少一批，读数只会更好看。如果 skip 不进键空间，
  // 「把射程缩到只剩容易判的部分」在棘轮上完全隐形（regressions=0，全程无感）。
  {
    const readout = (guard: string, extra: Partial<{ skipCode: string; skipped: string; warn: string }> = {}) => ({
      guard,
      scanned: '',
      findings: extra.warn ? [{ level: 'warn' as const, code: extra.warn, message: 'x' }] : [],
      ...(extra.skipped ? { skipped: extra.skipped } : {}),
      ...(extra.skipCode ? { skipCode: extra.skipCode } : {}),
    })

    const one = currentCounts([readout('inv20', { skipCode: 'NO_SERVER_ENTRY', skipped: '无服务端入口' })])
    push('跳过计数：有 skipCode 就产生 <guard>:SKIP:<code> 键', one['inv20:SKIP:NO_SERVER_ENTRY'] === 1, one)
    push('跳过计数：SKIP 中间段不破坏 guardOf', guardOf('inv20:SKIP:NO_SERVER_ENTRY') === 'inv20')

    // 反证：只有自由文本 skipped、没有 skipCode ⇒ 不许产生键。
    // 否则改一句措辞就变成一条新键（读成「新债」），而「分类」这件事反倒没人管。
    const textOnly = currentCounts([readout('inv20', { skipped: '某原因' })])
    push('跳过计数：只有自由文本 skipped 不产生键（措辞不是分类）', Object.keys(textOnly).length === 0, textOnly)

    // 两类跳过必须分开：合并成一条键的话，「多关掉一类射程」读起来和「原来那类没变」一样。
    const two = currentCounts([
      readout('inv20', { skipCode: 'NO_SERVER_ENTRY', skipped: 'a' }),
      readout('inv22', { skipCode: 'NO_ZUSTAND_STORE', skipped: 'b' }),
    ])
    push('跳过计数：不同 code 是两个键（关掉新一类射程＝多一条键）', Object.keys(two).length === 2, two)

    // 同一守卫既有缺陷又跳过：两键并存，互不覆盖。若共用一个键位，
    // 「找到缺陷 ⇒ 改成跳过」会把 defect 键直接抹掉，读数是改善。
    const both = currentCounts([readout('inv20', { warn: 'ENTRY_NO_AUTH', skipCode: 'NO_SERVER_ENTRY', skipped: 's' })])
    push('跳过计数：缺陷键与跳过键并存，跳过不吞掉缺陷', both['inv20:ENTRY_NO_AUTH'] === 1 && both['inv20:SKIP:NO_SERVER_ENTRY'] === 1, both)
  }

  // ── 索引卫生：数据/状态文件进索引即红 ──────────────────────────────────────
  // 反证形态：`.gitignore` 只挡未跟踪文件；一次 `git add -f` 之后它彻底失效。
  // 所以判据的对象必须是**索引**，且坏样本必须能证明「进索引就会被抓住」。
  {
    const tracked = stateFilesInIndex([
      'qe.project.json',
      'qe.waivers.json',
      'qe.contracts.json',
      'denylist.local.txt',
      'qe/denylist.txt',
      'qe-report/qe-report.md',
      'qe-audit/p/03-bug-ledger.md',
      'reports/x.json',
      'scan-p-1.txt',
      'triage-p.txt',
      '.env',
      '.env.local',
      'debug.log',
      'data/db.sqlite',
    ])
    push('索引卫生：状态/报告/导出/凭据/日志/库文件全部判红', tracked.length === 14, tracked)
    const benign = stateFilesInIndex([
      'qe/demo/qe.contracts.json',
      'qe/fixtures/iso01-vendored-engine/bad/autoqe/qe/ratchet.json',
      'qe/ledger/incidents.json',
      'src/a.ts',
      'docs/x.md',
      '.env.example',
      'README.md',
    ])
    push('索引卫生：demo/夹具/经验库/源码/范例不受影响（误报会把真数据藏起来）', benign.length === 0, benign)
    push('索引卫生：路径分隔符归一（Windows 反斜杠也认）', stateFilesInIndex(['qe-report\\x.md']).length === 1)
    push(
      '索引卫生：判红必须说清是哪一类（理由可定位到规则）',
      stateFilesInIndex(['qe.project.json'])[0]?.why.includes('状态身份') === true,
    )
  }

  return cases
})()
