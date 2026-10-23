import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { Finding } from './guard.ts'
import type { GuardReadout } from './report.ts'
import type { QeConfig } from './config.ts'
import type { Invariant } from '../registry/types.ts'

/**
 * 处置政策单源：每个判据代码只有一个处置倾向。
 * fix    = 唯一正确动作（机械可判）
 * decide = 有 2–3 个方案，必须人裁决（第一条是推荐）
 * record = 不影响运行，备案即可（写理由 + 复审日期）
 * 未登记的代码一律 decide：默认不允许「自动备案」。
 *
 * Single source of disposition. fix = one mechanically correct action;
 * decide = 2–3 defensible options (first one recommended); record = traceability only.
 * Unregistered codes always fall to decide — never auto-waived.
 */
export type Disposition = 'fix' | 'decide' | 'record'
export type Locale = 'en' | 'zh'

export interface L10n {
  en: string
  zh: string
}

const L = (en: string, zh: string): L10n => ({ en, zh })

export interface Policy {
  disposition: Disposition
  meaning: L10n
  action: L10n
  options?: L10n[]
  auto?: 'package-alias'
}

export const POLICIES: Record<string, Policy> = {
  ALIAS_MISSING: {
    disposition: 'fix',
    meaning: L(
      'The invariant registers a guard alias that does not exist in package.json — it looks enforced but never runs.',
      '不变量登记了守卫别名，但 package.json 里没有这条脚本 → 标注在位却跑不到。',
    ),
    action: L(
      'Add the alias to package.json scripts (--apply can append it).',
      '把别名补进 package.json scripts（可用 --apply 自动追加）。',
    ),
    auto: 'package-alias',
  },
  PERSIST_NO_VERSION: {
    disposition: 'fix',
    meaning: L(
      'zustand persist has no version — old localStorage data silently mismatches after a shape change.',
      'zustand persist 没有 version → 结构变更后旧 localStorage 数据会静默错位。',
    ),
    action: L(
      'Append `version: 1` to the persist options; additive, no behavior change.',
      '在 persist 的选项对象里追加 `version: 1`；纯追加，不改变现有行为。',
    ),
  },
  ZERO_WRITER: {
    disposition: 'decide',
    meaning: L(
      'The column exists in the schema but no code writes it — readers always get the default.',
      'schema 里有这一列，但全仓没有任何代码写它 → 读的人永远拿到默认值。',
    ),
    action: L(
      'Add the writer at the business write site.',
      '补写入者，在产生该业务动作的写点里赋值。',
    ),
    options: [
      L('A Add a writer (recommended)', 'A 补写入者（推荐）'),
      L('B Drop the column once nothing needs it', 'B 删列：确认无人需要'),
      L('C Record it as deprecated with a reason and expiry', 'C 备案：列已废弃但暂不能删，写理由 + 到期日'),
    ],
  },
  ZERO_READER: {
    disposition: 'decide',
    meaning: L(
      'The column is written but never read — storage without a consumer.',
      '列有写点但全仓没人读 → 存了也不用，通常是历史包袱。',
    ),
    action: L('Add the read site (report / export / detail page).', '补读点（报表/导出/详情页）。'),
    options: [
      L('A Add the read site (recommended)', 'A 补读点（推荐）'),
      L('B Annotate the schema with `/// @archive`', 'B schema 注释加 `/// @archive` 声明存档'),
      L('C Drop the column', 'C 删列'),
    ],
  },
  DEAD_ENUM: {
    disposition: 'decide',
    meaning: L(
      'The enum value never appears anywhere — a state that can never be reached.',
      '枚举值全仓零出现 → 状态机里有一段永远走不到。',
    ),
    action: L('Remove the value once the business no longer needs it.', '删值（确认业务不再需要）。'),
    options: [
      L('A Remove the value (recommended)', 'A 删值（推荐）'),
      L('B Add a write site: which entry produces it, under what condition', 'B 补写点：说明哪个入口、什么条件会产生它'),
      L('C Record it as retained with an expiry', 'C 备案：保留并登记到期日'),
    ],
  },
  NO_WRITE_PATH: {
    disposition: 'decide',
    meaning: L(
      'The value appears only on the read side; nothing produces it — the reader looks at a state that can never be written.',
      '枚举值只在读侧出现，没有任何产生路径 → 读的是一个永远不会被写入的状态。',
    ),
    action: L(
      'Add a production path; if the state is not intended, remove the value.',
      '补写点；若业务确实不产生该状态，删值。',
    ),
    options: [
      L('A Add a write site (recommended)', 'A 补写点（推荐）'),
      L('B Remove the value', 'B 删值'),
      L('C Record it as retained with an expiry', 'C 备案：保留并登记到期日'),
    ],
  },
  AMBIGUOUS_PATH: {
    disposition: 'decide',
    meaning: L(
      'The value appears only in non-read / non-write contexts (types, constants, comments) — production cannot be confirmed mechanically.',
      '枚举值只在非写非读上下文出现（类型/常量/注释），产生路径无法机器确认。',
    ),
    action: L(
      'Confirm who writes it; if nobody does, treat it as a dead enum.',
      '人工确认它由谁写；确认不到就按死枚举处理。',
    ),
    options: [
      L('A Confirm the write site and register it (recommended)', 'A 确认写点并补登记（推荐）'),
      L('B Treat it as DEAD_ENUM and remove the value', 'B 按 DEAD_ENUM 删值'),
    ],
  },
  GHOST_PROMISE: {
    disposition: 'decide',
    meaning: L(
      'A spec, comment or UI claim promises behavior with no throw site in source — a ghost rule.',
      '规范/注释/文案承诺了系统会做的事，源码里没有对应抛错点 → 幽灵规则。',
    ),
    action: L(
      'Add the throw site so the promise has code behind it.',
      '补抛错点，让承诺有源码背书。',
    ),
    options: [
      L('A Add the throw site (recommended)', 'A 补抛错点（推荐）'),
      L('B Remove the claim', 'B 改文案：删掉做不到的承诺'),
      L('C Remove it from contracts and record the adjudication', 'C 从 contracts 摘除并记录裁决'),
    ],
  },
  PROMISE_STALE: {
    disposition: 'decide',
    meaning: L(
      'The contract ledger points at a claim sentence that no longer exists — registration and reality have drifted apart.',
      '契约台账指向的承诺句已经不在出处 → 登记与现实脱节。',
    ),
    action: L('Re-register the source or remove the entry.', '重新登记出处或删除条目。'),
    options: [
      L('A Update the source (recommended)', 'A 更新出处（推荐）'),
      L('B Remove the entry and record why', 'B 删除条目并记录原因'),
    ],
  },
  PROMISE_SOURCE_MISSING: {
    disposition: 'decide',
    meaning: L(
      'The file the contract ledger points at no longer exists — the promise cannot be checked.',
      '契约台账指向的文件已不存在 → 承诺无从核对。',
    ),
    action: L('Fix the source or remove the entry.', '修正出处或删除条目。'),
    options: [
      L('A Fix the source (recommended)', 'A 修正出处（推荐）'),
      L('B Remove the entry and record why', 'B 删除条目并记录原因'),
    ],
  },
  GHOST_GATE: {
    disposition: 'decide',
    meaning: L(
      'The UI has a control but the server has no criterion — the constraint is only cosmetic.',
      '界面有控件，服务端没有判据 → 界面承诺的约束后端不执行。',
    ),
    action: L('Add the server-side criterion.', '补服务端判据。'),
    options: [
      L('A Add the criterion (recommended)', 'A 补服务端判据（推荐）'),
      L('B Remove the control and its copy', 'B 移除控件与对应文案'),
    ],
  },
  DEAD_GATE: {
    disposition: 'decide',
    meaning: L(
      'The server criterion exists but no UI entry reaches it — the gate always runs an empty branch.',
      '服务端有判据，界面没有入口 → 判据永远走空分支。',
    ),
    action: L('Add the UI entry.', '补界面入口。'),
    options: [
      L('A Add the control (recommended)', 'A 补界面控件（推荐）'),
      L('B Delete the gate and record the adjudication', 'B 删除该闸并登记裁决'),
    ],
  },
  ENTRY_NO_AUTH: {
    disposition: 'decide',
    meaning: L(
      'The server entry has no auth criterion — anonymous requests can reach it.',
      '服务端入口没有鉴权判据 → 匿名请求可以直接打。',
    ),
    action: L('Add an auth criterion.', '补鉴权判据。'),
    options: [
      L('A Add auth (recommended)', 'A 补鉴权（推荐）'),
      L('B If it is genuinely public, register it with a written reason', 'B 若确为公共入口，登记 publicRoutes 并写理由'),
    ],
  },
  ENTRY_NO_VALIDATE: {
    disposition: 'decide',
    meaning: L(
      'The entry hands the request body straight to business code — malformed or hostile bodies pass through.',
      '变更入口直接把请求体交给业务 → 畸形/恶意体可穿透。',
    ),
    action: L('Validate with a schema at the entry.', '在入口做 schema 校验。'),
    options: [
      L('A Add schema validation (recommended)', 'A 补 schema 校验（推荐）'),
      L('B Parse once at the entry and return 400 from a single helper', 'B 入口内集中解析一次并返回 400（单源 helper）'),
    ],
  },
  MUTATION_NO_IDEMPOTENCY: {
    disposition: 'decide',
    meaning: L(
      'The mutation entry has no idempotency marker — double submits and replays execute twice.',
      '变更入口没有幂等标记 → 双提交/重放会重复执行。',
    ),
    action: L('Add an Idempotency-Key and a dedupe store.', '补 Idempotency-Key + 去重表。'),
    options: [
      L('A Add an idempotency key (recommended)', 'A 补幂等键（推荐）'),
      L('B Record it as naturally idempotent with a reason and expiry', 'B 备案：该动作天然幂等，写理由 + 到期日'),
    ],
  },
  PUBLIC_NO_REASON: {
    disposition: 'decide',
    meaning: L(
      'Registered as a public route with no reason — an indefinite waiver slot.',
      '登记为公共路由但没写理由 → 等同永久豁免槽。',
    ),
    action: L('Write the reason.', '补理由。'),
    options: [
      L('A Write the reason (recommended)', 'A 补理由（推荐）'),
      L('B Remove the public registration and add auth', 'B 取消公共登记并补鉴权'),
    ],
  },
  PUBLIC_ROUTE_STALE: {
    disposition: 'decide',
    meaning: L(
      'The public-route registration matches no entry — the registration is stale.',
      '公共路由登记没有命中任何入口 → 登记过期。',
    ),
    action: L('Remove the stale registration.', '删除过期登记。'),
    options: [
      L('A Remove it (recommended)', 'A 删除过期登记（推荐）'),
      L('B Fix the path', 'B 修正路径'),
    ],
  },
  CLIENT_IMPORTS_SERVER: {
    disposition: 'decide',
    meaning: L(
      'A client component imports a server module — server code and secrets may enter the bundle.',
      '客户端组件 import 了服务端模块 → 服务端代码与密钥有进包风险。',
    ),
    action: L('Call through an API instead.', '改为通过 API 调用。'),
    options: [
      L('A Call through the API (recommended)', 'A 改走 API（推荐）'),
      L('B Import pure types only (import type)', 'B 只导入纯类型（import type）'),
      L('C Move shared logic into a shared module', 'C 共用逻辑下沉到 shared'),
    ],
  },
  CLIENT_TOUCHES_SERVER: {
    disposition: 'decide',
    meaning: L(
      'The client reaches server implementation through a relay module — a leaking seam.',
      '客户端经中转模块触达服务端实现 → 接缝泄漏。',
    ),
    action: L('Cut the chain and call the API.', '断开链路，改走 API。'),
    options: [
      L('A Cut the chain (recommended)', 'A 断开链路（推荐）'),
      L('B Split the relay into client and shared halves', 'B 把中转模块拆成 client/shared 两份'),
    ],
  },
  CROSS_MODULE_RELATIVE: {
    disposition: 'decide',
    meaning: L(
      'A relative deep import crosses a module boundary — the boundary is void and a refactor will silently pick up stale logic.',
      '跨模块用相对路径深导 → 模块边界失效，重构后会静默拿到旧逻辑。',
    ),
    action: L('Go through the public entry or an alias.', '改走公开入口或别名。'),
    options: [
      L('A Use the public entry (recommended)', 'A 改走公开入口（推荐）'),
      L('B If it is genuine internal collaboration, register the module surface', 'B 若确为内部协作，登记模块公开面'),
    ],
  },
  PERSIST_SENSITIVE: {
    disposition: 'decide',
    meaning: L(
      'Sensitive fields live inside the persist scope — they are written to localStorage.',
      'persist 作用域里有敏感字段 → 会随 state 写进 localStorage。',
    ),
    action: L('Remove sensitive fields from state; keep them server-side.', '从 state 移除敏感字段，改由服务端持有。'),
    options: [
      L('A Keep them server-side (recommended)', 'A 改为服务端持有（推荐）'),
      L('B Keep them in memory but out of the partialize allowlist', 'B 保留在内存但不进 partialize 白名单'),
      L('C Encrypt before persisting (highest cost)', 'C 加密后落盘（成本最高）'),
    ],
  },
  PERSIST_WITHOUT_PARTIALIZE: {
    disposition: 'decide',
    meaning: L(
      'persist has no partialize — the entire state is serialized to storage.',
      'persist 没有 partialize → 整个 state 会被序列化落盘。',
    ),
    action: L('Write a partialize allowlist with only the necessary fields.', '写 partialize 白名单，只落盘必要字段。'),
    options: [
      L('A Write the allowlist (recommended)', 'A 写白名单（推荐）'),
      L('B Do not persist; drop persist entirely', 'B 不持久化，删掉 persist'),
    ],
  },
  PERSIST_FULL_STATE: {
    disposition: 'decide',
    meaning: L(
      'partialize returns the whole state — equivalent to no trimming at all.',
      'partialize 返回整个 state → 等同于没裁剪。',
    ),
    action: L('List only the fields that must persist.', '只列需要落盘的字段。'),
    options: [
      L('A List only the necessary fields (recommended)', 'A 只列必要字段（推荐）'),
      L('B Drop persist', 'B 删掉 persist'),
    ],
  },
  REGISTRY_NO_GUARD: {
    disposition: 'decide',
    meaning: L(
      'The invariant claims a guard but registers no alias — it never runs.',
      '不变量声称有守卫，但没登记别名 → 跑不到。',
    ),
    action: L('Add the guard alias.', '补守卫别名。'),
    options: [
      L('A Add the alias (recommended)', 'A 补别名（推荐）'),
      L('B Downgrade to open with a written reason', 'B 降级为 open 并写理由'),
    ],
  },
  REGISTRY_NO_BAD_SAMPLE: {
    disposition: 'decide',
    meaning: L(
      'An enforced entry has no bad sample — there is no counter-proof, so it may not claim enforced.',
      'enforced 条目没有坏样本 → 没有反证，不许标在位。',
    ),
    action: L('Add the bad sample.', '补坏样本。'),
    options: [
      L('A Add the bad sample (recommended)', 'A 补坏样本（推荐）'),
      L('B Downgrade to partial and record the gap', 'B 降级为 partial 并写缺口'),
    ],
  },
  REGISTRY_NO_GAP: {
    disposition: 'decide',
    meaning: L(
      'A partial entry states no gap — its coverage is invisible.',
      'partial 条目没写缺口 → 射程不可见。',
    ),
    action: L('Write the gap and the review date.', '补写缺口与复审日期。'),
    options: [
      L('A Write the gap (recommended)', 'A 补缺口说明（推荐）'),
      L('B If it is actually enforced, add a bad sample and upgrade', 'B 若实为 enforced，补坏样本并升级'),
    ],
  },
  REGISTRY_OPEN_UNTRIAGED: {
    disposition: 'decide',
    meaning: L(
      'An open entry has no reason or review trigger — no record means red.',
      'open 条目缺理由或复审触发器 → 无账即红。',
    ),
    action: L('Write the reason and revisitBy.', '补理由 + revisitBy。'),
    options: [
      L('A Write the reason and review date (recommended)', 'A 补理由与复审日期（推荐）'),
      L('B Remove the entry if it no longer applies', 'B 若已不适用则删条目'),
    ],
  },
  REVISIT_OVERDUE: {
    disposition: 'decide',
    meaning: L(
      'The review date has passed with no decision — the gap is overdue.',
      '复审日期已过但未处理 → 缺口已过期。',
    ),
    action: L('Review it now and update the conclusion.', '现在复审并更新结论。'),
    options: [
      L('A Review now (recommended)', 'A 现在复审（推荐）'),
      L('B Reschedule and write why it is deferred', 'B 重新定期并写清为什么推迟'),
    ],
  },
  BAD_DEFECT_CLASS: {
    disposition: 'decide',
    meaning: L(
      'defectClasses is outside the established nine classes — a tenth class was invented.',
      'defectClasses 不在既有九类之内 → 发明了第十类。',
    ),
    action: L('Normalize to one of the nine classes.', '归一到九类。'),
    options: [
      L('A Normalize to the nine classes (recommended)', 'A 归一到九类（推荐）'),
      L('B If it is genuinely new, change the QE-04 taxonomy first', 'B 若确为新类，先改 QE-04 分类再登记'),
    ],
  },
  BAD_PATTERN: {
    disposition: 'decide',
    meaning: L(
      'A configured regular expression is invalid — the criterion never actually ran.',
      '配置里的正则写错 → 判据从未真正生效。',
    ),
    action: L('Fix the regex and run selftest.', '修正正则并跑 selftest。'),
    options: [
      L('A Fix the regex (recommended)', 'A 修正正则（推荐）'),
      L('B Remove the contract entry and judge it elsewhere', 'B 从 contracts 摘除该条，改由其他载体判'),
    ],
  },
  CONTRACTS_MISSING: {
    disposition: 'decide',
    meaning: L(
      'The contract ledger is not configured — promises and gates have nowhere to register, so the guard idles.',
      '契约台账未配置 → 承诺/闸清单无处登记，守卫空转。',
    ),
    action: L('Configure contracts and register the lists.', '配置 contracts 并登记清单。'),
    options: [
      L('A Configure and register (recommended)', 'A 配置并登记（推荐）'),
      L('B If this project truly has none, record N/A and downgrade', 'B 本项目确实不用，记录 N/A 并降级条目'),
    ],
  },
  EMPTY_SCAN: {
    disposition: 'decide',
    meaning: L(
      'Zero objects were scanned — an empty set is vacuously true, not green.',
      '扫到 0 个对象 → 空集恒真，这不是绿。',
    ),
    action: L('Fix schema.path / source.roots.', '修正 schema.path / source.roots。'),
    options: [
      L('A Fix the scan scope (recommended)', 'A 修正扫描范围（推荐）'),
      L('B Record N/A and downgrade the entry', 'B 记录 N/A 并降级条目'),
    ],
  },
  EMPTY_EXEMPTION: {
    disposition: 'decide',
    meaning: L(
      'An exemption carries no reason — an indefinite waiver slot.',
      '豁免没有理由 → 等同永久豁免槽。',
    ),
    action: L('Write the reason.', '补理由。'),
    options: [
      L('A Write the reason (recommended)', 'A 补理由（推荐）'),
      L('B Revoke the exemption', 'B 撤销豁免'),
    ],
  },
  NO_GATES: {
    disposition: 'decide',
    meaning: L('The gate list is empty — the guard idles.', '闸清单为空 → 守卫空转。'),
    action: L('Register the gate list.', '登记闸清单。'),
    options: [
      L('A Register the gates (recommended)', 'A 登记闸清单（推荐）'),
      L('B Record N/A', 'B 记录 N/A'),
    ],
  },
  NO_PROMISES: {
    disposition: 'decide',
    meaning: L('The promise list is empty — the guard idles.', '承诺清单为空 → 守卫空转。'),
    action: L('Register the promise sentences.', '登记承诺句。'),
    options: [
      L('A Register the promises (recommended)', 'A 登记承诺句（推荐）'),
      L('B Record N/A', 'B 记录 N/A'),
    ],
  },
  SCRIPT_TARGET_MISSING: {
    disposition: 'decide',
    meaning: L(
      'A script alias points at a file that does not exist.',
      '脚本别名指向不存在的文件。',
    ),
    action: L('Fix the path or remove the alias.', '修正路径或删除别名。'),
    options: [
      L('A Fix the path (recommended)', 'A 修正路径（推荐）'),
      L('B Remove the alias', 'B 删除别名'),
    ],
  },
  PACKAGE_MISSING: {
    disposition: 'decide',
    meaning: L(
      'package.json was not found — aliases and scripts cannot be verified.',
      'package.json 找不到 → 别名与脚本无法核对。',
    ),
    action: L('Fix the packageJson path.', '修正 packageJson 路径。'),
    options: [
      L('A Fix the path (recommended)', 'A 修正路径（推荐）'),
      L('B If this is not an npm project, record N/A', 'B 确认不是 npm 项目，记录 N/A'),
    ],
  },
  PACKAGE_BAD: {
    disposition: 'decide',
    meaning: L(
      'package.json does not parse — aliases and scripts cannot be verified.',
      'package.json 解析失败 → 别名与脚本无法核对。',
    ),
    action: L('Fix the JSON.', '修好 JSON。'),
    options: [
      L('A Fix the JSON (recommended)', 'A 修复 JSON（推荐）'),
      L('B If this is not an npm project, record N/A', 'B 确认不是 npm 项目，记录 N/A'),
    ],
  },
  UNWIRED_SCRIPT: {
    disposition: 'record',
    meaning: L(
      'A script exists on disk with no npm entry — no runtime impact, it is just hard to find.',
      '盘上有脚本但没有任何 npm 入口 → 不影响运行，只是找不着。',
    ),
    action: L(
      'Do not fix. Record: file + why it is kept + review date; schedule deletion if abandoned.',
      '不修。备案：文件 + 保留原因 + 复审日期；若确认废弃，排期删除。',
    ),
  },
  ORPHAN_GUARD: {
    disposition: 'record',
    meaning: L(
      'The guard file is not referenced by guards/index.ts — it never executes.',
      '守卫文件没有被 guards/index.ts 引用 → 它不会执行。',
    ),
    action: L(
      'Do not fix. Record: file + why it is kept; schedule deletion if abandoned.',
      '不修。备案：文件 + 为什么留着；若为废弃守卫，排期删除。',
    ),
  },
}

const UNKNOWN_POLICY: Policy = {
  disposition: 'decide',
  meaning: L(
    'Unregistered finding code: AutoQe has no disposition for it.',
    '未登记的判据代码：AutoQe 没有它的处置意见。',
  ),
  action: L(
    'Adjudicate by hand; never waive it automatically.',
    '人工裁决，不得直接备案。',
  ),
  options: [
    L('A Map it to the nearest invariant and submit a disposition (recommended)', 'A 归到最近的不变量并提交处置意见（推荐）'),
    L('B If the criterion itself is wrong, fix the guard not the business code', 'B 若判据本身有误，修守卫而不是修业务'),
  ],
}

export interface TriageGroup {
  code: string
  level: Finding['level']
  policy: Policy
  findings: Finding[]
}

export interface TriageResult {
  groups: TriageGroup[]
  fix: number
  decide: number
  record: number
  unknown: string[]
  skipped: number
}

export function triage(readouts: GuardReadout[]): TriageResult {
  const byCode = new Map<string, TriageGroup>()
  for (const readout of readouts) {
    for (const f of readout.findings) {
      if (f.level === 'info') continue
      const policy = POLICIES[f.code] ?? UNKNOWN_POLICY
      const group = byCode.get(f.code) ?? { code: f.code, level: f.level, policy, findings: [] }
      if (f.level === 'error') group.level = 'error'
      group.findings.push(f)
      byCode.set(f.code, group)
    }
  }
  const rank: Record<Disposition, number> = { fix: 0, decide: 1, record: 2 }
  const groups = [...byCode.values()].sort((a, b) => {
    const diff = rank[a.policy.disposition] - rank[b.policy.disposition]
    if (diff !== 0) return diff
    if (a.level !== b.level) return a.level === 'error' ? -1 : 1
    return b.findings.length - a.findings.length
  })
  return {
    groups,
    fix: groups.filter((g) => g.policy.disposition === 'fix').length,
    decide: groups.filter((g) => g.policy.disposition === 'decide').length,
    record: groups.filter((g) => g.policy.disposition === 'record').length,
    unknown: groups.filter((g) => !POLICIES[g.code]).map((g) => g.code),
    skipped: readouts.filter((r) => r.skipped).length,
  }
}

const fmt = (value: L10n, locale: Locale): string => value[locale]

export function triageLines(result: TriageResult, locale: Locale = 'en'): string[] {
  const zh = locale === 'zh'
  const lines: string[] = []
  const total = result.fix + result.decide + result.record
  lines.push(`TRIAGE actionable=${total} fix=${result.fix} decide=${result.decide} record=${result.record} skipped=${result.skipped} locale=${locale}`)
  if (result.skipped > 0) {
    lines.push(
      zh
        ? `TRIAGE_NOTE skipped=${result.skipped}：跳过的守卫不是通过，不能据此判断无缺陷。`
        : `TRIAGE_NOTE skipped=${result.skipped}: a skipped guard is not a pass and cannot prove the project clean.`,
    )
  }
  if (total === 0) {
    lines.push(
      zh
        ? 'TRIAGE_NOTE 本次没有产出任何待处置项；空集不等于无缺陷（先看射程与 skipped）。'
        : 'TRIAGE_NOTE no actionable findings this run; an empty set is not proof of safety (check scope and skipped first).',
    )
  }
  for (const g of result.groups) {
    const where = g.findings
      .slice(0, 3)
      .map((f) => (f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : f.entity ?? ''))
      .filter(Boolean)
      .join(', ')
    if (g.policy.disposition === 'fix') {
      const auto = g.policy.auto ? ' auto=yes' : ' auto=no(patch)'
      lines.push(`TRIAGE_FIX code=${g.code} count=${g.findings.length}${auto} do=${fmt(g.policy.action, locale)}${where ? ' at=' + where : ''}`)
    } else if (g.policy.disposition === 'decide') {
      const options = (g.policy.options ?? []).map((o) => fmt(o, locale)).join(' | ')
      lines.push(
        `TRIAGE_DECIDE code=${g.code} count=${g.findings.length} recommend=${fmt(g.policy.action, locale)}${options ? ' options=' + options : ''}${where ? ' at=' + where : ''}`,
      )
    } else {
      lines.push(`TRIAGE_RECORD code=${g.code} count=${g.findings.length} reason=${fmt(g.policy.meaning, locale)}`)
    }
  }
  todayList(result, locale).forEach((item, i) => lines.push(`TRIAGE_TODAY ${i + 1}) ${item}`))
  return lines
}

export function todayList(result: TriageResult, locale: Locale = 'en', cap = 5): string[] {
  const zh = locale === 'zh'
  return result.groups
    .filter((g) => g.policy.disposition !== 'record')
    .slice(0, cap)
    .map((g) => {
      const count = g.findings.length > 1 ? (zh ? `（${g.findings.length} 处）` : ` (${g.findings.length} sites)`) : ''
      return `[${g.code}] ${fmt(g.policy.action, locale)}${count}`
    })
}

export async function writeTriage(
  root: string,
  result: TriageResult,
  readouts: GuardReadout[],
  applied: string[],
  cli: string,
  locale: Locale = 'en',
  outDir = 'qe-report',
): Promise<{ jsonFile: string; mdFile: string }> {
  const dir = path.join(root, outDir)
  await mkdir(dir, { recursive: true })
  const jsonFile = path.join(dir, 'triage.json')
  const mdFile = path.join(dir, 'triage.md')
  await writeFile(jsonFile, JSON.stringify({ generatedAt: new Date().toISOString(), locale, applied, result, readouts }, null, 2), 'utf8')
  await writeFile(mdFile, renderTriageMarkdown(result, readouts, applied, cli, locale), 'utf8')
  return { jsonFile, mdFile }
}

export function renderTriageMarkdown(
  result: TriageResult,
  readouts: GuardReadout[],
  applied: string[],
  cli: string,
  locale: Locale = 'en',
): string {
  const zh = locale === 'zh'
  const now = new Date().toLocaleString(zh ? 'zh-CN' : 'en-US', { timeZone: 'Asia/Shanghai' })
  const total = result.fix + result.decide + result.record
  const today = todayList(result, locale)
  const text = zh
    ? {
        title: '处置清单（Triage）',
        generated: '生成时间',
        conclusion: '结论',
        fix: '直接改',
        decide: '需要你选',
        record: '备案',
        skipped: '跳过守卫',
        regen: '复验命令',
        today: '今天只做这些',
        noToday: '无（本次没有 fix/decide 级待办）',
        applied: '本次 `--apply` 已自动追加别名',
        s1: '1. 直接改（唯一正确动作）',
        s2: '2. 需要你选（每项已给推荐）',
        s3: '3. 备案即可（不修，只留账）',
        none: '无。',
        what: '它是什么',
        recommend: '推荐动作',
        recordAction: '备案',
        options: '可选',
        draft: '备案草稿（粘贴到 qe/ledger/incidents.json）',
        skippedGuards: '跳过的守卫',
        scope: '口径：本清单只对本次实际扫到的 findings 负责；0 项 ≠ 无缺陷。处置政策单源在 `qe/lib/triage.ts`，未登记的代码一律进入「需要你选」，不会被自动备案。',
      }
    : {
        title: 'Triage — what to do next',
        generated: 'Generated',
        conclusion: 'Conclusion',
        fix: 'fix',
        decide: 'decide',
        record: 'record',
        skipped: 'skipped guards',
        regen: 'Re-run',
        today: "Today's list",
        noToday: 'Nothing (no fix/decide items this run)',
        applied: '`--apply` appended aliases',
        s1: '1. Fix now (one correct action)',
        s2: '2. Decide (options with a recommendation)',
        s3: '3. Record only (no code change)',
        none: 'None.',
        what: 'What it is',
        recommend: 'Recommended',
        recordAction: 'Record',
        options: 'Options',
        draft: 'Waiver draft (paste into qe/ledger/incidents.json)',
        skippedGuards: 'Skipped guards',
        scope:
          'Scope: this list covers only the findings from this run; 0 items is not proof of safety. The disposition table lives in `qe/lib/triage.ts`; unregistered codes always fall to decide and are never auto-waived.',
      }
  const section = (title: string, disposition: Disposition): string => {
    const groups = result.groups.filter((g) => g.policy.disposition === disposition)
    if (groups.length === 0) return `## ${title}\n\n${text.none}\n`
    const body = groups
      .map((g) => {
        const locs = g.findings
          .slice(0, 5)
          .map((f) => `  - ${f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : f.entity ?? ''} ${f.message}`)
          .join('\n')
        const extra = g.policy.options?.length
          ? `\n- ${text.options}: ${g.policy.options.map((o) => fmt(o, locale)).join(zh ? '；' : '; ')}`
          : ''
        const lead = disposition === 'record' ? text.recordAction : text.recommend
        return `### ${g.code} (${g.findings.length}, ${g.level})\n\n- ${text.what}: ${fmt(g.policy.meaning, locale)}\n- ${lead}: ${fmt(g.policy.action, locale)}${extra}\n${locs}`
      })
      .join('\n\n')
    return `## ${title}\n\n${body}\n`
  }
  const skipped = readouts
    .filter((r) => r.skipped)
    .map((r) => `- ${r.guard}: ${r.skipped}`)
    .join('\n')
  const recordDraft = result.groups
    .filter((g) => g.policy.disposition === 'record')
    .map((g) =>
      JSON.stringify(
        { id: `C-${g.code}`, title: `${g.code}: ${g.findings.length}`, why: fmt(g.policy.meaning, locale), reviewBy: 'TODO-YYYY-MM-DD' },
        null,
        2,
      ),
    )
    .join('\n')

  return `# ${text.title}

- ${text.generated}: ${now}
- ${text.conclusion}: ${total} = **${text.fix} ${result.fix}** / **${text.decide} ${result.decide}** / **${text.record} ${result.record}**
- ${text.skipped}: ${result.skipped}
- ${text.regen}: \`${cli} run --root .\`

## ${text.today}

${today.length ? today.map((t, i) => `${i + 1}. ${t}`).join('\n') : text.noToday}

${applied.length ? `> ${text.applied}: ${applied.join(', ')}\n` : ''}
${section(text.s1, 'fix')}
${section(text.s2, 'decide')}
${section(text.s3, 'record')}

## ${text.draft}

\`\`\`json
${recordDraft || '[]'}
\`\`\`

## ${text.skippedGuards}

${skipped || text.none}

> ${text.scope}
`
}

/**
 * 只做「纯追加、可回退」的自动修复：把 registry 里缺失的守卫别名补进 package.json。
 * 不碰业务源码。返回实际追加的别名。
 */
export async function applyPackageAliases(root: string, config: QeConfig, registry: Invariant[]): Promise<string[]> {
  const pkgPath = path.resolve(root, config.packageJson)
  const raw = await readFile(pkgPath, 'utf8')
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string> }
  const scripts = pkg.scripts ?? {}
  const added: string[] = []
  for (const inv of registry) {
    if (!inv.guard || inv.guard in scripts) continue
    if (inv.status !== 'enforced' && inv.status !== 'partial') continue
    const suffix = inv.guard.split(':').pop()
    if (!suffix) continue
    scripts[inv.guard] = `node qe/cli.ts run --only ${suffix}`
    added.push(inv.guard)
  }
  if (added.length > 0) {
    pkg.scripts = scripts
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  }
  return added
}
