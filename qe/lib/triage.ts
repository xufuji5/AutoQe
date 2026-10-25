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
export type Impact = 'money' | 'auth' | 'pii' | 'data' | 'trace'
export type Effort = 'S' | 'M' | 'L'

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
  impact?: Impact
  effort?: Effort
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
  ZERO_WRITER_RENDERED: {
    disposition: 'decide',
    meaning: L(
      'No code writes this column, yet a page renders it — the user sees a permanently empty field.',
      '全仓没有写点，但页面在渲染这一列 → 用户看到的是永远空的那一栏。',
    ),
    action: L(
      'Either add the writer, or stop rendering the field until it is implemented.',
      '二选一：补写入者，或在功能落地前先不渲染该栏。',
    ),
    options: [
      L('A Add the writer (recommended)', 'A 补写入者（推荐）'),
      L('B Hide the field in the UI until implemented', 'B 页面先隐藏该栏'),
      L('C Drop the column', 'C 删列'),
    ],
  },
  ZERO_WRITER_UNUSED: {
    disposition: 'decide',
    meaning: L(
      'No writer and no page uses this column — redundant schema, invisible to users.',
      '没有写点、页面也没用到 → 冗余列，用户不可见。',
    ),
    action: L('Drop the column, or mark it archived in the schema.', '删列，或在 schema 注释里声明存档。'),
    options: [
      L('A Drop the column (recommended)', 'A 删列（推荐）'),
      L('B Annotate with `/// @archive`', 'B schema 注释加 `/// @archive`'),
    ],
  },
  MODEL_UNUSED: {
    disposition: 'decide',
    meaning: L(
      'The whole table has no write path — either the module never shipped, or it was left half-built.',
      '整张表没有任何写点 → 模块没落地，或只建到一半。',
    ),
    action: L(
      'Decide whether the module is still planned: if not, drop the table; if yes, register it as pending with a milestone.',
      '先定模块去留：不做了就删表；要做就登记为待落地并挂里程碑，别让它继续按「活表」出现在报表里。',
    ),
    options: [
      L('A Drop the table', 'A 删表'),
      L('B Register as pending with a milestone', 'B 登记待落地 + 里程碑'),
    ],
  },
  WRITE_COVERAGE_UNKNOWN: {
    disposition: 'decide',
    meaning: L(
      'The write goes through a variable / function parameter / spread, so which columns get written cannot be resolved statically.',
      '写入 data 经变量/函数参数/展开传入，静态解析不出到底写了哪些列。',
    ),
    action: L(
      'Inline the data object literal at the write site, or list the columns next to it for manual review.',
      '把 data 收敛成写点处的对象字面量；确实要动态拼时，在旁边写明覆盖了哪些列，供人工复核。',
    ),
    options: [
      L('A Inline the data literal (recommended)', 'A 收敛成字面量（推荐）'),
      L('B Keep it dynamic and annotate the covered columns', 'B 保留动态，注明覆盖列'),
    ],
  },
  WRITE_PATH_UNKNOWN: {
    disposition: 'record',
    meaning: L(
      'The enum value appears on the read side only, but the model write site cannot be resolved, so "no producer" is not proven.',
      '枚举值只在读侧出现，但该模型的写点字段不可解析 → 「没有产生路径」没被证实。',
    ),
    action: L('Resolve the write data shape, then re-judge.', '把写点的 data 形态收敛后再判；在此之前按未知处理。'),
  },
  CLIENT_TRANSITIVE_SERVER: {
    disposition: 'decide',
    meaning: L(
      'A client component reaches server code through a barrel/re-export chain — one hop away from the boundary.',
      '客户端组件经 barrel/再导出链间接依赖到服务端实现 → 隔一跳就是接缝泄漏。',
    ),
    action: L(
      'Import the type only (`import type`), or move the value into a client-safe module / server action.',
      '改成 `import type` 只取类型，或把值挪到客户端安全的模块 / 走 server action。',
    ),
    options: [
      L('A Import type only', 'A 只导入类型'),
      L('B Move to a client-safe module or server action', 'B 挪到客户端安全模块或 server action'),
    ],
  },
  LOCAL_PATH: {
    disposition: 'fix',
    meaning: L(
      'A machine-local absolute path leaked into shipped text — meaningless to anyone else and reveals the host layout.',
      '对外文本里出现本机绝对路径 → 别人机器上无效，还暴露主机目录结构。',
    ),
    action: L('Replace with a relative path or a placeholder value.', '换成相对路径或示例值。'),
    options: [L('A Replace with a relative path', 'A 换相对路径')],
  },
  SECRET_SHAPE: {
    disposition: 'fix',
    meaning: L(
      'A string matches a credential shape (key/token/password) — a real secret must never live in the repo.',
      '字符串形态像凭据（key/token/password）→ 真凭据不允许出现在仓库里。',
    ),
    action: L('Move it to .env and reference it by name.', '挪到 .env，代码里只引用变量名。'),
    options: [L('A Move to .env', 'A 挪到 .env')],
  },
  PROJECT_CODEWORD: {
    disposition: 'fix',
    meaning: L(
      'An internal project codename appears in text that may be published.',
      '出现内部项目代号，而这段文本可能对外。',
    ),
    action: L('Replace with a neutral codename.', '换成中性代号（如 外部试点 A/B）。'),
    options: [L('A Replace with a neutral codename', 'A 换中性代号')],
  },
  DOMAIN_VOCAB: {
    disposition: 'fix',
    meaning: L(
      "An example or document uses one vertical industry's business nouns, which makes the generic tool read as bound to that industry.",
      '示例/文档里用了某个垂直行业的业务实体名，会让通用工具被读成行业绑定。',
    ),
    action: L(
      'Replace with a neutral entity (request / asset / record). If the repo is intentionally industry-specific, turn this class off with `leak.domainVocab: false`.',
      '换成中性实体（请求 / 资产 / 记录）；确属行业专用仓库时用 `leak.domainVocab: false` 关闭本档。',
    ),
    options: [L('A Replace with neutral entities', 'A 换中性实体')],
  },
  DENYLIST_EMPTY: {
    disposition: 'record',
    meaning: L(
      'The project-codename denylist is empty, so that half of the check did not run — a green here would be a false green.',
      '项目代号黑名单为空 → 该判据这一半没跑，此时的绿是假绿。',
    ),
    action: L('Configure `leak.denylist` or AUTOQE_DENYLIST.', '配置 `leak.denylist` 或 AUTOQE_DENYLIST。'),
  },
  COMMITS_NOT_SCANNED: {
    disposition: 'record',
    meaning: L(
      'The commit-message half of the leak check could not run (git log failed), so this session has no conclusion there — absence of findings is not a clean result.',
      '提交信息面这一档没跑成（git log 失败）→ 本轮在该面上没有结论，没有命中不等于干净。',
    ),
    action: L(
      'Do not fix. Record: why git was unavailable (not a repo / no git binary) + review date; re-run with git available before publishing.',
      '不修。备案：git 不可用的原因（非仓库/无 git）+ 复审日期；对外发布前在 git 可用的环境重跑一次。',
    ),
  },
  INDEX_NOT_SCANNED: {
    disposition: 'record',
    meaning: L(
      'The index half of the hygiene check could not run (git ls-files failed), so this session has no conclusion there — absence of findings is not a clean result.',
      '索引面这一档没跑成（git ls-files 失败）→ 本轮在该面上没有结论，没有命中不等于干净。',
    ),
    action: L(
      'Do not fix. Record: why git was unavailable + review date; re-run with git available before publishing.',
      '不修。备案：git 不可用的原因 + 复审日期；对外发布前在 git 可用的环境重跑一次。',
    ),
  },
  TRACKED_STATE_FILE: {
    disposition: 'fix',
    meaning: L(
      'A report/state/data file is tracked by git. .gitignore only stops untracked files, so once it is in the index every future commit keeps it — and history cannot be cleaned by deleting the file.',
      '报告/状态/数据文件已被 git 跟踪。`.gitignore` 只挡未跟踪文件，一旦进了索引，之后每次提交都带着它 —— 删文件也删不掉历史。',
    ),
    action: L(
      'Remove it from the index with `git rm --cached`, confirm .gitignore covers the path, then commit. Keep the file on disk if it is still in use.',
      '先 `git rm --cached` 移出索引，确认 `.gitignore` 覆盖该路径后再提交；文件仍在使用就保留在磁盘上。',
    ),
    options: [L('A Remove from index and ignore the path', 'A 移出索引并忽略该路径')],
  },
  ENGINE_STATE_CARRIED: {
    disposition: 'fix',
    meaning: L(
      'A vendored engine directory carries project state (config / ratchet / waivers / report / generated fixtures). Copying that folder into another project imports the previous project’s judgment.',
      '内置引擎目录里带着项目状态（配置/基线/备案/报告/样本落盘）。把这层目录复制到下一个项目，就把上一个项目的判断一起带进去了。',
    ),
    action: L(
      'Delete the listed state files from the engine directory; state belongs to the project root, never to the engine. Then re-run to confirm the copy is stateless.',
      '删掉引擎目录里的这些状态文件；状态属于项目根，不属于引擎。删完重跑确认这份副本无状态。',
    ),
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
  ASSERT_TARGET_MISSING: {
    disposition: 'decide',
    meaning: L(
      'A configured assertion target (schema.path / source.roots / contracts / spec.docs / stores.moduleRoots) points at a path that does not exist — the criterion scans a void, and an empty set is vacuously green.',
      '配置声明的断言对象路径不存在 → 判据在虚空上空转，空集恒真被读成绿。',
    ),
    action: L('Point the config entry at the real path, or drop the declaration.', '把该配置项指向真实路径，或删掉这条声明。'),
    options: [
      L('A Fix the path in qe.config.json (recommended)', 'A 修正 qe.config.json 里的路径（推荐）'),
      L('B The target is genuinely absent: remove the declaration (or set provider/collector=none)', 'B 对象确实不存在：删掉声明（或把 provider/collector 设为 none）'),
    ],
  },
  ASSERT_ON_IGNORED: {
    disposition: 'fix',
    meaning: L(
      'An assertion target is git-ignored: present on the dev machine (always green), absent in a clean CI checkout (always red, or vacuously green on an empty scan).',
      '断言对象被 git 忽略 → 开发机上存在（恒绿）、干净检出时不存在（恒红或扫空集假绿）。',
    ),
    action: L(
      'Assertion targets must be committable: un-ignore and commit the target, or point the criterion at a tracked path.',
      '断言对象必须可提交：解除忽略并入库，或把判据指向已跟踪路径。',
    ),
    options: [
      L('A Point the criterion at a committable path (recommended)', 'A 把判据指向可提交路径（推荐）'),
      L('B Un-ignore the target and commit it', 'B 解除忽略并把目标入库'),
    ],
  },
  ASSERT_ON_UNTRACKED: {
    disposition: 'fix',
    meaning: L(
      'An assertion target exists but is not tracked by git — it cannot be committed, so a clean checkout turns the criterion into an empty scan.',
      '断言对象存在但未被 git 跟踪 → 它提交不了，干净检出后判据变成扫空集。',
    ),
    action: L('git add the target (or the files under the directory).', '把目标（或目录下的文件）git add 入库。'),
    options: [
      L('A Commit the target (recommended)', 'A 把目标入库（推荐）'),
      L('B Point the criterion at an already tracked path', 'B 把判据改指已跟踪路径'),
    ],
  },
  NO_ENUM: {
    disposition: 'decide',
    meaning: L(
      'The schema declares no enums — the dead-enum guard had nothing to check this round.',
      'schema 无任何枚举 → 死枚举判据本轮没有检查对象（0 对象≠已检查）。',
    ),
    action: L('Confirm whether this project uses enums at all.', '确认本项目是否使用枚举。'),
    options: [
      L('A Project does not use enums — record N/A (recommended)', 'A 本项目不用枚举，记录 N/A（推荐）'),
      L('B Enums exist elsewhere — fix schema.path', 'B 枚举在别处，修正 schema.path'),
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
  /* ---------- 入口可寻址：人工类/动态发现必须自带举证（inv13） ---------- */
  DISCOVERY_NO_REASON: {
    disposition: 'fix',
    meaning: L(
      'A dynamic-discovery glob has no reason — an empty reason is an exemption slot renamed.',
      '动态发现声明没写理由 → 空理由就是把豁免槽换个名字。',
    ),
    action: L('Write the reason on the addressableDiscovery entry.', '在 addressableDiscovery 条目上补理由。'),
  },
  MANUAL_CLASS_NO_REASON: {
    disposition: 'fix',
    meaning: L(
      'A manually-run class has no reason — nobody can tell why these files are exempt from entry checks.',
      '人工类声明没写理由 → 没人知道这些文件凭什么不参与入口判定。',
    ),
    action: L('Write the reason on the manualClasses entry.', '在 manualClasses 条目上补理由。'),
  },
  MANUAL_CLASS_NO_RUNBOOK_DECL: {
    disposition: 'fix',
    meaning: L(
      'A manually-run class declares no howToRun — with no run path it is just dead code with a label.',
      '人工类声明没给 howToRun → 没有运行路径，它只是带标签的死代码。',
    ),
    action: L('Add howToRun with the real command prefix people use.', '补 howToRun：写人真正会执行的那条命令前缀。'),
  },
  MANUAL_CLASS_NO_RUNBOOK: {
    disposition: 'fix',
    meaning: L(
      'The declared howToRun cannot be glued into any command that actually appears in the file.',
      '登记的 howToRun 与文件里真实写着的命令拼不上 → 声明是编的。',
    ),
    action: L(
      'Correct howToRun, or add the missing command to the file; the declaration must match reality.',
      '改对 howToRun，或在文件里补上那条命令；声明必须与事实一致。',
    ),
  },
  DISCOVERY_GLOB_GHOST: {
    disposition: 'fix',
    meaning: L(
      'A dynamic-discovery glob matches zero files — a permanent empty exemption slot.',
      '动态发现声明的 glob 一个文件都没命中 → 永久空豁免槽。',
    ),
    action: L('Fix the glob or remove the declaration.', '改对 glob 或删掉这条声明。'),
  },
  MANUAL_CLASS_GLOB_GHOST: {
    disposition: 'fix',
    meaning: L(
      'A manual class glob matches zero files — a permanent empty exemption slot.',
      '人工类声明的 glob 一个文件都没命中 → 永久空豁免槽。',
    ),
    action: L('Fix the glob or remove the declaration.', '改对 glob 或删掉这条声明。'),
  },
  /* ---------- 入口覆盖：界面是否有请求发送点（inv23） ---------- */
  ENTRY_EXEMPT_NO_REASON: {
    disposition: 'fix',
    meaning: L(
      'A "no UI entry" registration has no reason — an empty reason is not an exemption.',
      '「无界面入口」登记没写理由 → 空理由不是豁免。',
    ),
    action: L('Write the reason, or delete the registration.', '补理由，或删掉这条登记。'),
  },
  ENTRY_EXEMPT_NO_REVIEW: {
    disposition: 'fix',
    meaning: L(
      'A temporary no-UI registration has no reviewBy — it will become permanent.',
      '暂缺登记没写复审日期 reviewBy → 它会变成永久豁免。',
    ),
    action: L('Add reviewBy (YYYY-MM-DD).', '补 reviewBy（YYYY-MM-DD）。'),
  },
  ENTRY_NO_UI: {
    disposition: 'decide',
    meaning: L(
      'A mutating server entry is never called from the UI and is not registered as external.',
      '服务端写入口在界面没有任何请求发送点，也没有登记为外部渠道。',
    ),
    action: L('Add the UI request point, or register the entry with a reason.', '补界面请求点，或登记为外部渠道并写理由。'),
    options: [
      L('A Wire the UI to it (recommended)', 'A 在界面接上（推荐）'),
      L('B Register as external with a reason', 'B 登记为外部渠道（写理由）'),
      L('C Remove the unused endpoint', 'C 删掉没人用的端点'),
    ],
  },
  ENTRY_EXEMPT_STALE: {
    disposition: 'fix',
    meaning: L(
      'A "no UI entry" registration no longer matches reality (route gone, or the UI now calls it).',
      '「无界面入口」登记与现实不符：路由已不存在，或界面已经能点到。',
    ),
    action: L('Delete the stale registration.', '删掉过期的登记。'),
  },
  /* ---------- 入口覆盖的举证式登记（inv23：coverage / dynamicTail） ---------- */
  REQUEST_CALL_BAD_DECL: {
    disposition: 'fix',
    meaning: L(
      'A requestCallAdditions entry is empty or not a valid regex — it contributes nothing to the vocabulary.',
      'coverage.requestCallAdditions 有一条空 pattern 或非法正则 → 它不产生任何词表项。',
    ),
    action: L('Fix or remove the declaration.', '改对或删掉这条声明。'),
  },
  REQUEST_CALL_NO_REASON: {
    disposition: 'fix',
    meaning: L(
      'A requestCallAdditions entry has no reason — an unexplained addition cannot be reviewed.',
      'coverage.requestCallAdditions 有一条没写理由 → 无法复审的扩展项。',
    ),
    action: L('Write the reason, or remove the declaration.', '补理由，或删掉这条声明。'),
  },
  UI_CORPUS_BAD_DECL: {
    disposition: 'fix',
    meaning: L(
      'A uiCorpora entry is missing name or roots — an extra client corpus must be identifiable and locatable.',
      'coverage.uiCorpora 有一条缺 name 或 roots → 第二个客户端语料必须可指认、可定位。',
    ),
    action: L('Add name and roots, or remove the entry.', '补 name 与 roots，或删掉这条。'),
  },
  UI_CORPUS_NO_REASON: {
    disposition: 'fix',
    meaning: L(
      'An extra UI corpus has no reason — nobody can tell why it is scanned.',
      '额外的界面语料没写理由 → 没人知道为什么要扫它。',
    ),
    action: L('Write the reason, or remove the corpus.', '补理由，或删掉这条语料。'),
  },
  DYNAMIC_TAIL_BAD_DECL: {
    disposition: 'fix',
    meaning: L(
      'A dynamicTail entry has no endpoint — the declaration cannot be matched to anything.',
      'coverage.dynamicTail 有一条缺 endpoint → 这条登记无法与任何路由对上。',
    ),
    action: L('Add the endpoint, or remove the entry.', '补 endpoint，或删掉这条。'),
  },
  DYNAMIC_TAIL_NO_REASON: {
    disposition: 'fix',
    meaning: L(
      'A dynamicTail registration has no reason — an empty reason is not evidence.',
      'dynamicTail 登记没写理由 → 空理由不是举证。',
    ),
    action: L('Write the reason explaining why the tail is a runtime variable.', '补理由：说明末段为什么在调用侧是变量。'),
  },
  DYNAMIC_TAIL_STALE: {
    disposition: 'fix',
    meaning: L(
      'A dynamicTail registration is stale: the route is gone, or the UI can now hit the path statically.',
      'dynamicTail 登记过期：路由已不存在，或界面已能静态命中该路径。',
    ),
    action: L('Delete the stale registration.', '删掉过期的登记。'),
  },
  DYNAMIC_TAIL_TOO_BROAD: {
    disposition: 'fix',
    meaning: L(
      'The static prefix of a dynamicTail registration has fewer than 3 segments — any call could "prove" it.',
      'dynamicTail 登记的静态前缀不足 3 段 → 这么短的前缀任何调用都能作证，等于没有判据。',
    ),
    action: L('Register a narrower endpoint, or replace it with a real call site.', '登记更窄的端点，或改成真实发送点。'),
  },
  DYNAMIC_TAIL_NO_EVIDENCE: {
    disposition: 'fix',
    meaning: L(
      'The evidence file of a dynamicTail registration cannot be read — the proof points at nothing.',
      'dynamicTail 登记的证据文件读不到 → 举证指向了不存在的地方。',
    ),
    action: L('Fix the evidence path, or remove the registration.', '修正 evidence 路径，或删掉这条登记。'),
  },
  DYNAMIC_TAIL_NOT_BACKED: {
    disposition: 'fix',
    meaning: L(
      'The evidence file does not contain the declared send site — the registration is not backed.',
      '证据文件里找不到声明的发送点 → 这条登记不成立。',
    ),
    action: L('Point evidence at the real call site, or remove the registration.', '把 evidence 指向真实发送点，或删掉这条登记。'),
  },
  /* ---------- 软删读点（inv25） ---------- */
  SOFTDELETE_MIDDLEWARE_NO_REASON: {
    disposition: 'fix',
    meaning: L(
      'Global middleware is declared to inject the soft-delete filter, but the reason is empty.',
      '声明了全局中间件统一注入软删过滤，但理由为空。',
    ),
    action: L('Write the reason, or drop the middleware declaration.', '补理由，或删掉这条中间件声明。'),
  },
  SOFTDELETE_TABLE_UNKNOWN: {
    disposition: 'fix',
    meaning: L(
      'A registered soft-delete table does not exist in the schema — registration drift.',
      '登记的软删表在 schema 里不存在 → 登记漂移或拼写错误，判据在这条上一直空转。',
    ),
    action: L('Fix the table name in config.softDelete.tables.', '修正 config.softDelete.tables 里的表名。'),
  },
  SOFTDELETE_COLUMN_MISSING: {
    disposition: 'fix',
    meaning: L(
      'A registered soft-delete table has no soft-delete column — registration drift.',
      '登记的软删表里没有软删列 → 登记与 schema 漂移。',
    ),
    action: L('Fix the column name or the table registration.', '修正软删列名或换掉这条表登记。'),
  },
  SOFTDELETE_ZERO_READS: {
    disposition: 'decide',
    meaning: L(
      'Registered soft-delete tables produced zero detected reads — the registration may be stale, or reads use an unrecognised form.',
      '登记的软删表一个读点都没识别到 → 登记可能过时，或读点用了判据不认识的形式。',
    ),
    action: L('Confirm the tables are still read, or drop the stale registration.', '确认这些表仍有读点，或删掉过时登记。'),
    options: [
      L('A Confirm reads exist and the form is unrecognised', 'A 确认有读点，判据形态没覆盖'),
      L('B Drop the stale registration', 'B 删掉过时登记'),
    ],
  },
  SOFTDELETE_READ_UNFILTERED: {
    disposition: 'fix',
    impact: 'data',
    meaning: L(
      'A read of a soft-delete table provably lacks the soft-delete predicate — deleted rows leak into lists/counts/exports.',
      '软删表的读点可证没有软删谓词 → 已删除的行会漏进列表/计数/导出。',
    ),
    action: L('Add the soft-delete predicate to the where clause.', '在 where 条件里补上软删谓词。'),
  },
  SOFTDELETE_FILTER_UNKNOWN: {
    disposition: 'decide',
    impact: 'data',
    meaning: L(
      'The read arguments are not literal — static analysis cannot prove the predicate is present or absent.',
      '读点参数含变量/展开，静态不可证谓词有没有加。',
    ),
    action: L('Check by hand; if filtered, rewrite as a literal or record the intent.', '人工核：确认已过滤可改成可证形态，或记录意图。'),
    options: [
      L('A Verified filtered — record it', 'A 确认已过滤 → 备案'),
      L('B Actually unfiltered — fix it', 'B 确实没过滤 → 修复'),
    ],
  },
  /* ---------- 错误码册（inv26） ---------- */
  ERROR_CODE_BLANK: {
    disposition: 'fix',
    meaning: L('The error catalog contains a blank entry — a placeholder is an exemption slot.', '错误码册里有空码 → 登记占位等同豁免槽。'),
    action: L('Fill it in or remove it.', '补全或删掉。'),
  },
  NO_CATALOG: {
    disposition: 'decide',
    meaning: L(
      'The error catalog is empty and no throwPattern is configured — code/catalog comparison is vacuous.',
      '错误码册为空且未配 throwPattern → 错误码对拍空转（空集恒真）。',
    ),
    action: L('Fill the catalog, or configure errors.throwPattern.', '补册，或配置 errors.throwPattern。'),
    options: [
      L('A Fill errorCatalog', 'A 补 errorCatalog'),
      L('B Configure errors.throwPattern', 'B 配置 errors.throwPattern'),
    ],
  },
  DEAD_ERROR_CODE: {
    disposition: 'decide',
    meaning: L(
      'The code is registered but nothing throws it — either the enforcement point is missing or the code is retired.',
      '错误码登记在册但全仓无人抛 → 要么缺抛错点，要么该退役。',
    ),
    action: L('Add the throw site, or remove the code from the catalog.', '补抛错点，或从册面移除。'),
    options: [
      L('A Add the missing throw site', 'A 补抛错点'),
      L('B Retire the code', 'B 退役该码'),
    ],
  },
  BAD_THROW_PATTERN: {
    disposition: 'fix',
    meaning: L('errors.throwPattern is not a valid regular expression.', 'errors.throwPattern 不是合法正则。'),
    action: L('Fix the pattern; it must have exactly one capture group for the code.', '修好正则：必须有一个捕获组取出错误码。'),
  },
  UNREGISTERED_ERROR_CODE: {
    disposition: 'fix',
    meaning: L(
      'A thrown error code is not in the catalog — register first, then throw.',
      '抛出的错误码未登记进册 → 野生码；先登记再抛。',
    ),
    action: L('Add the code to errorCatalog.', '把该码补进 errorCatalog。'),
  },
  THROW_SCAN_EMPTY: {
    disposition: 'decide',
    meaning: L(
      'The reverse comparison scanned zero source files — an empty set is not green.',
      '反向对拍扫到 0 个源文件 → 空集恒真，不算绿。',
    ),
    action: L('Fix errors.roots / source.roots, or turn the check off explicitly.', '修正 roots 配置，或显式关掉本判据。'),
    options: [
      L('A Fix the roots so source files are covered', 'A 修正 roots，让源文件进入射程'),
      L('B No source files exist — turn the check off', 'B 本仓确实无源文件 → 显式关掉本判据'),
    ],
  },
  /* ---------- 干净检出构建（inv27） ---------- */
  WORKTREE_FAIL: {
    disposition: 'decide',
    meaning: L(
      'git worktree add failed — a clean checkout cannot be proven (git missing or repository state broken).',
      'git worktree add 失败 → 无法证明干净检出（git 不可用或仓库状态异常）。',
    ),
    action: L('Fix the git environment, or declare build.command unset when this gate is not applicable.', '修好 git 环境；本 gate 不适用时不要声明 build.command。'),
    options: [
      L('A Fix the git environment so a clean checkout can be created', 'A 修好 git 环境，让干净检出可创建'),
      L('B This repo does not run this gate — leave build.command unset', 'B 本仓不跑这道 gate → 不声明 build.command'),
    ],
  },
  CLEAN_BUILD_TIMEOUT: {
    disposition: 'decide',
    meaning: L('The build exceeded config.build.timeoutSec in a clean checkout.', '干净检出里的构建超过 config.build.timeoutSec。'),
    action: L('Raise timeoutSec, or fix the slow build.', '调高 timeoutSec，或修构建耗时。'),
    options: [
      L('A Raise config.build.timeoutSec', 'A 调高 config.build.timeoutSec'),
      L('B Fix the slow build so it fits the budget', 'B 修构建耗时，让它落回预算内'),
    ],
  },
  CLEAN_BUILD_SPAWN_FAIL: {
    disposition: 'fix',
    meaning: L('config.build.command could not be started — likely a wrong command or missing binary.', 'config.build.command 无法启动 → 命令写错或缺可执行文件。'),
    action: L('Fix the command in config.build.', '修正 config.build 里的命令。'),
  },
  CLEAN_BUILD_FAIL: {
    disposition: 'fix',
    meaning: L(
      'HEAD does not build from a clean checkout — a fresh clone would fail for everyone.',
      'HEAD 从干净检出构建失败 → 任何人新克隆都跑不起来。',
    ),
    action: L('Fix the build, or commit the missing files.', '修构建，或把缺失文件入库。'),
  },
  WORKTREE_LEFTOVER: {
    disposition: 'record',
    meaning: L(
      'The temporary worktree could not be removed — later worktree listings may be polluted.',
      '临时 worktree 清理失败 → 后续 worktree 列表可能被污染。',
    ),
    action: L('Do not fix. Record it and remove the directory by hand.', '不修。备案并人工删除该目录。'),
  },
  /* ---------- 限流/体积上限（inv28，候选级 warn-only） ---------- */
  RATELIMIT_PATTERN_BLANK: {
    disposition: 'fix',
    meaning: L('rateLimit.patterns contains a blank entry — a placeholder is an exemption slot.', 'rateLimit.patterns 里有空形态 → 登记占位等同豁免槽。'),
    action: L('Fill it in or remove it.', '补全或删掉。'),
  },
  RATE_LIMIT_ZERO_ROUTES: {
    disposition: 'decide',
    meaning: L(
      'Zero route files were found under the route roots — an empty set is not green.',
      '路由根下扫到 0 个 route 文件 → 空集恒真，不算绿。',
    ),
    action: L('Fix routeRoots, or turn this check off for repos without server entries.', '修正 routeRoots；没有服务端入口的仓应显式关掉本判据。'),
    options: [
      L('A Fix routeRoots so route files are covered', 'A 修正 routeRoots，让 route 文件进入射程'),
      L('B No server entries in this repo — turn the check off', 'B 本仓无服务端入口 → 显式关掉本判据'),
    ],
  },
  RATE_LIMIT_UNVERIFIED: {
    disposition: 'decide',
    meaning: L(
      'A mutating entry shows no registered rate/size limit form — limits may live in a gateway that static analysis cannot see.',
      '变更型入口未命中任何已登记限流形态 → 上限可能做在网关，静态看不见。',
    ),
    action: L('Register the visible form, or document the gateway-level policy.', '登记 route 层可见形态，或写明网关统一策略。'),
    options: [
      L('A Add a route-level limit (recommended)', 'A 在 route 层补限流（推荐）'),
      L('B Register the gateway pattern with a reason', 'B 登记网关形态并写理由'),
    ],
  },
  /* ---------- 缺失族（AQ-ABS）：文档是 oracle，缺口要人裁决哪边过期 ---------- */
  SPEC_MODEL_MISSING: {
    disposition: 'decide',
    impact: 'data',
    effort: 'M',
    meaning: L(
      'The spec promises a model that the schema does not have: either the spec is stale or the model was never built.',
      '文档承诺了一个模型，schema 里没有：要么规格过期，要么模型没建。',
    ),
    action: L('Pick a side; the two are not the same defect.', '先定边：这两种不是同一个缺陷。'),
    options: [
      L('A Build the model (spec is current) (recommended)', 'A 补模型（规格仍有效，推荐）'),
      L('B Mark the spec row as deprecated', 'B 把规格那一行标为已废弃'),
    ],
  },
  SPEC_FIELD_MISSING: {
    disposition: 'decide',
    impact: 'data',
    effort: 'S',
    meaning: L(
      'A promised field is absent: no reference exists anywhere, so no compiler or test will ever report it.',
      '文档承诺的字段不存在：全仓没有任何引用，所以编译器与测试永远不会报它。',
    ),
    action: L('Add the field, or drop it from the spec.', '补字段，或从规格里删掉。'),
    options: [
      L('A Add the field to schema (spec is current) (recommended)', 'A 在 schema 补字段（规格仍有效，推荐）'),
      L('B Drop the row from the spec', 'B 从规格里删掉该行'),
    ],
  },
  SPEC_ENDPOINT_MISSING: {
    disposition: 'decide',
    impact: 'data',
    effort: 'M',
    meaning: L(
      'A promised endpoint has no route file: callers will get 404, or the doc is stale.',
      '文档承诺的端点没有对应 route 文件：调用方会拿到 404，或文档过期。',
    ),
    action: L('Check who calls it before deciding.', '先确认有没有调用方，再决定。'),
    options: [
      L('A Add the route (has callers) (recommended)', 'A 补路由（确有调用方，推荐）'),
      L('B Delete the endpoint section from the spec', 'B 从规格中删掉该接口'),
    ],
  },
  SPEC_NO_CLAIMS: {
    disposition: 'decide',
    impact: 'trace',
    effort: 'S',
    meaning: L(
      'Docs were parsed but produced zero claims: either the tables use unknown headers, or the docs carry no spec. Empty set is not a pass.',
      '文档解析出 0 条声明：要么表头写法不在词表内，要么这些文档不承载规格。空集不等于通过。',
    ),
    action: L('Align the table headers, or remove the dir from spec.docs.', '对齐表头词表，或把该目录移出 spec.docs。'),
    options: [
      L('A Align the table headers with the word list (recommended)', 'A 对齐表头词表（推荐）'),
      L('B These docs are not a spec: drop them from spec.docs', 'B 这些文档不是规格：从 spec.docs 移除'),
    ],
  },
  SPEC_SCHEMA_UNAVAILABLE: {
    disposition: 'decide',
    impact: 'trace',
    effort: 'S',
    meaning: L(
      'Schema could not be read, so the model/field half was not reconciled this round (no conclusion, not clean).',
      '读不到 schema → 模型/字段这一半本轮没对账（没结论，不是干净）。',
    ),
    action: L('Fix the schema path or declare provider=none.', '修正 schema 路径，或声明 provider=none。'),
    options: [
      L('A Fix config.schema.path (recommended)', 'A 修正 config.schema.path（推荐）'),
      L('B This repo has no schema: set provider=none', 'B 该仓没有 schema：设 provider=none'),
    ],
  },
  SPEC_NO_ROUTES: {
    disposition: 'decide',
    impact: 'trace',
    effort: 'S',
    meaning: L(
      'No route.* files found under routeRoots, so the endpoint half was not reconciled (no conclusion, not clean).',
      'routeRoots 下没有 route.* 文件 → 端点这一半本轮没对账（没结论，不是干净）。',
    ),
    action: L('Declare the real route roots, or drop endpoint claims.', '声明真实的路由根，或放弃端点对账。'),
    options: [
      L('A Set spec.routeRoots to the real app dir (recommended)', 'A 把 spec.routeRoots 指向真实 app 目录（推荐）'),
      L('B This repo has no App Router: ignore endpoints', 'B 该仓没有 App Router：不对账端点'),
    ],
  },
  SPEC_ENFORCE_NO_OWNER: {
    disposition: 'decide',
    impact: 'trace',
    effort: 'S',
    meaning: L(
      'enforce=true without docsOwner: the spec library has no owner keeping it in sync, so gaps cannot be treated as errors.',
      'enforce=true 却没写 docsOwner：文档库没人负责同步，缺口不能当 error。',
    ),
    action: L('Either name the owner or stop enforcing.', '要么指名 owner，要么取消强制。'),
    options: [
      L('A Name docsOwner and keep enforce (recommended)', 'A 写上 docsOwner 并保留强制（推荐）'),
      L('B Set enforce=false: keep gaps as candidates', 'B 设 enforce=false：缺口只做候选'),
    ],
  },
  SPEC_GAP_TRUNCATED: {
    disposition: 'record',
    impact: 'trace',
    effort: 'M',
    meaning: L(
      'Too many gaps to list one by one — that many gaps usually means the spec baseline is stale, not that 65 models are missing.',
      '缺口多到不能逐条展开——这个量级通常是文档基线过期，而不是真缺 65 个模型。',
    ),
    action: L(
      'Do not fix per item. Record: align the spec baseline (doc version vs current requirement), then re-run; only then triage the remaining gaps.',
      '不逐条修。备案：先对齐规格基线（文档版本 vs 当前需求）再重跑；剩下的缺口才进 triage。',
    ),
  },

  /* ---------- 残留族（AQ-RES）：开发痕迹没清干净 ---------- */
  AQ012_MOCK_REACHABLE: {
    disposition: 'decide',
    impact: 'data',
    effort: 'S',
    meaning: L(
      'Production code imports a mock/seed/fixture module: it ships, it renders, and nothing errors.',
      '生产源码引用了 mock/seed/fixture 模块：它会一起打包、一起渲染，而且不报任何错。',
    ),
    action: L('Remove the reference, or move it behind an explicit dev gate.', '删掉引用，或移到显式 dev 门控内。'),
    options: [
      L('A Delete the import (the API is already wired) (recommended)', 'A 删除这条 import（接口已接通，推荐）'),
      L('B Keep it behind a dev gate with a comment', 'B 保留，但放进 dev 门控并注明用途'),
    ],
  },
  AQ013_HARDCODED_DATASOURCE: {
    disposition: 'decide',
    impact: 'data',
    effort: 'M',
    meaning: L(
      'A hardcoded object array is rendered directly, with no fetch in the file: placeholder data or a legitimate constant — only a human can tell.',
      '写死对象数组被直接渲染，且本文件没有取数入口：是占位数据还是合法常量，只有人能判。',
    ),
    action: L('Decide whether the API is the source of truth for this page.', '先确认这个页面的真数据来源是不是接口。'),
    options: [
      L('A Placeholder: delete it and wire the API (recommended)', 'A 占位数据：删掉并接入接口（推荐）'),
      L('B Legitimate constant: record it with a reason + review date', 'B 合法常量：备案理由与复审日期'),
    ],
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

POLICIES.WAIVER_EXPIRED = {
  disposition: 'decide',
  meaning: L(
    'A waiver passed its review date but is still suppressing a finding.',
    '备案已过复审日期，却仍在压制一条发现。',
  ),
  action: L('Re-adjudicate now: fix it, renew the waiver, or delete the entry.', '现在重新裁决：修掉、续期或删条目。'),
  options: [
    L('A Fix the finding and remove the waiver (recommended)', 'A 修掉发现并删除备案（推荐）'),
    L('B Renew with a new review date and a written justification', 'B 续期：写新的复审日期与续期理由'),
  ],
  impact: 'trace',
  effort: 'S',
}

POLICIES.WAIVER_INVALID = {
  disposition: 'decide',
  meaning: L(
    'A waiver entry is missing a reason or a valid reviewBy date, so it cannot suppress anything.',
    '备案条目缺理由或复审日期非法，因此不能压制任何发现。',
  ),
  action: L('Fix the waiver entry or delete it.', '修正该备案条目或删除它。'),
  options: [
    L('A Complete reason + reviewBy (recommended)', 'A 补全理由 + 复审日期（推荐）'),
    L('B Delete the malformed entry', 'B 删除这条非法条目'),
  ],
  impact: 'trace',
  effort: 'S',
}

/**
 * 影响面与成本的单源补充表。未列出的代码按 trace / M 处理。
 * Impact/effort for codes where the default (trace / M) understates the risk.
 */
export const POLICY_META: Record<string, { impact: Impact; effort: Effort }> = {
  MUTATION_NO_IDEMPOTENCY: { impact: 'money', effort: 'L' },
  ENTRY_NO_AUTH: { impact: 'auth', effort: 'L' },
  PERSIST_SENSITIVE: { impact: 'pii', effort: 'L' },
  CLIENT_IMPORTS_SERVER: { impact: 'pii', effort: 'L' },
  CLIENT_TOUCHES_SERVER: { impact: 'pii', effort: 'M' },
  PERSIST_WITHOUT_PARTIALIZE: { impact: 'pii', effort: 'M' },
  PERSIST_FULL_STATE: { impact: 'pii', effort: 'M' },
  PUBLIC_NO_REASON: { impact: 'auth', effort: 'M' },
  ENTRY_NO_VALIDATE: { impact: 'data', effort: 'M' },
  ZERO_WRITER: { impact: 'data', effort: 'M' },
  ZERO_WRITER_RENDERED: { impact: 'data', effort: 'M' },
  ZERO_WRITER_UNUSED: { impact: 'data', effort: 'S' },
  MODEL_UNUSED: { impact: 'data', effort: 'M' },
  DEAD_ENUM: { impact: 'data', effort: 'M' },
  NO_WRITE_PATH: { impact: 'data', effort: 'M' },
  AMBIGUOUS_PATH: { impact: 'data', effort: 'M' },
  GHOST_PROMISE: { impact: 'data', effort: 'M' },
  GHOST_GATE: { impact: 'data', effort: 'M' },
  CROSS_MODULE_RELATIVE: { impact: 'data', effort: 'S' },
  ZERO_READER: { impact: 'trace', effort: 'S' },
  DEAD_GATE: { impact: 'trace', effort: 'S' },
  PUBLIC_ROUTE_STALE: { impact: 'trace', effort: 'S' },
  ALIAS_MISSING: { impact: 'trace', effort: 'S' },
  PERSIST_NO_VERSION: { impact: 'data', effort: 'S' },
  WAIVER_EXPIRED: { impact: 'trace', effort: 'S' },
  WAIVER_INVALID: { impact: 'trace', effort: 'S' },
  INDEX_NOT_SCANNED: { impact: 'trace', effort: 'S' },
  TRACKED_STATE_FILE: { impact: 'data', effort: 'S' },
  ENGINE_STATE_CARRIED: { impact: 'data', effort: 'S' },
  ASSERT_TARGET_MISSING: { impact: 'trace', effort: 'S' },
  ASSERT_ON_IGNORED: { impact: 'trace', effort: 'S' },
  ASSERT_ON_UNTRACKED: { impact: 'trace', effort: 'S' },
}

const IMPACT_WEIGHT: Record<Impact, number> = { money: 5, auth: 4, pii: 4, data: 3, trace: 1 }
const EFFORT_WEIGHT: Record<Effort, number> = { S: 1, M: 2, L: 3 }

export function metaOf(code: string, policy: Policy): { impact: Impact; effort: Effort } {
  const meta = POLICY_META[code] ?? { impact: policy.impact ?? 'trace', effort: policy.effort ?? 'M' }
  return { impact: policy.impact ?? meta.impact, effort: policy.effort ?? meta.effort }
}

export interface TriageGroup {
  code: string
  level: Finding['level']
  policy: Policy
  findings: Finding[]
  impact: Impact
  effort: Effort
}

/**
 * 备案条目。载体是 qe/waivers.json（config.waivers）。
 * 只有 reason 非空 + reviewBy 是合法日期时才算有效；到期后自动失效，不再压制发现。
 */
export interface Waiver {
  code: string
  reason: string
  reviewBy: string
  /** 只压制该路径前缀下的发现；留空表示全仓 */
  scope?: string
  addedAt?: string
}

export interface WaiverIssue {
  index: number
  entry: unknown
  problem: string
}

export interface WaiverStore {
  waivers: Waiver[]
  issues: WaiverIssue[]
}

export interface WaivedFinding {
  finding: Finding
  waiver: Waiver
}

export interface TriageOptions {
  waivers?: Waiver[]
  waiverIssues?: WaiverIssue[]
  /** 用于判定备案是否到期；默认今天（UTC 日期） */
  today?: string
  waiverFile?: string
}

export interface TriageResult {
  groups: TriageGroup[]
  fix: number
  decide: number
  record: number
  unknown: string[]
  skipped: number
  /** 被有效备案压制的发现：不出现在三桶里，但仍在报告里可见 */
  waived: WaivedFinding[]
  /** 非法备案条目数（缺理由 / 日期非法） */
  waiverIssues: number
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

const waiverFilePath = (root: string, config: QeConfig): string => path.resolve(root, config.waivers)

/** 读备案载体。文件不存在 = 没有备案；JSON 结构不对 = 直接报错，不静默吞掉。 */
export async function loadWaivers(root: string, config: QeConfig): Promise<WaiverStore> {
  let raw: string
  try {
    raw = await readFile(waiverFilePath(root, config), 'utf8')
  } catch {
    return { waivers: [], issues: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`${config.waivers} 解析失败：${(e as Error).message}`)
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { waivers?: unknown } | null)?.waivers
  if (!Array.isArray(list)) throw new Error(`${config.waivers} 必须是数组，或 { "waivers": [...] }`)

  const waivers: Waiver[] = []
  const issues: WaiverIssue[] = []
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      issues.push({ index, entry, problem: 'entry is not an object' })
      return
    }
    const candidate = entry as Partial<Waiver>
    if (typeof candidate.code !== 'string' || !candidate.code.trim()) {
      issues.push({ index, entry, problem: 'code is missing' })
      return
    }
    if (typeof candidate.reason !== 'string' || !candidate.reason.trim()) {
      issues.push({ index, entry, problem: 'reason is missing or empty' })
      return
    }
    if (!isIsoDate(candidate.reviewBy)) {
      issues.push({ index, entry, problem: 'reviewBy is not a valid YYYY-MM-DD date' })
      return
    }
    waivers.push({
      code: candidate.code.trim(),
      reason: candidate.reason.trim(),
      reviewBy: candidate.reviewBy,
      ...(typeof candidate.scope === 'string' && candidate.scope.trim() ? { scope: candidate.scope.trim() } : {}),
      ...(typeof candidate.addedAt === 'string' ? { addedAt: candidate.addedAt } : {}),
    })
  })
  return { waivers, issues }
}

/** 追加一条备案。理由必填、复审日期必须合法且不早于今天；非法条目存在时拒绝写入。 */
export async function addWaiver(
  root: string,
  config: QeConfig,
  input: { code: string; reason: string; reviewBy: string; scope?: string; today?: string },
): Promise<{ file: string; waiver: Waiver }> {
  const code = input.code.trim()
  if (!code) throw new Error('waive 需要判据代码：autoqe waive ZERO_WRITER --reason "..." --review-by YYYY-MM-DD')
  if (!input.reason.trim()) throw new Error('waive 必须写理由（--reason）：空理由的备案等同永久豁免槽')
  if (!isIsoDate(input.reviewBy)) {
    throw new Error(`--review-by 必须是合法日期 YYYY-MM-DD，收到 "${input.reviewBy}"`)
  }
  const today = input.today ?? todayIso()
  if (input.reviewBy < today) {
    throw new Error(`--review-by ${input.reviewBy} 早于今天 ${today}：过期备案不压制任何发现`)
  }
  const store = await loadWaivers(root, config)
  if (store.issues.length > 0) {
    throw new Error(`${config.waivers} 里已有 ${store.issues.length} 条非法条目，先修好再加新备案`)
  }
  const waiver: Waiver = {
    code,
    reason: input.reason.trim(),
    reviewBy: input.reviewBy,
    addedAt: today,
    ...(input.scope?.trim() ? { scope: input.scope.trim() } : {}),
  }
  const file = waiverFilePath(root, config)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify([...store.waivers, waiver], null, 2) + '\n', 'utf8')
  return { file, waiver }
}

export function triage(readouts: GuardReadout[], options: TriageOptions = {}): TriageResult {
  const today = options.today ?? todayIso()
  const waiverFile = options.waiverFile ?? 'qe/waivers.json'
  const byCode = new Map<string, TriageGroup>()

  const push = (f: Finding): void => {
    const policy = POLICIES[f.code] ?? UNKNOWN_POLICY
    const meta = metaOf(f.code, policy)
    const group = byCode.get(f.code) ?? {
      code: f.code,
      level: f.level,
      policy,
      findings: [],
      impact: meta.impact,
      effort: meta.effort,
    }
    if (f.level === 'error') group.level = 'error'
    group.findings.push(f)
    byCode.set(f.code, group)
  }

  const active: Waiver[] = []
  const expired: Waiver[] = []
  for (const w of options.waivers ?? []) (w.reviewBy >= today ? active : expired).push(w)
  const matches = (w: Waiver, f: Finding): boolean => w.code === f.code && (!w.scope || (f.file ?? '').startsWith(w.scope))

  const waived: WaivedFinding[] = []
  for (const readout of readouts) {
    for (const f of readout.findings) {
      if (f.level === 'info') continue
      const hit = active.find((w) => matches(w, f))
      if (hit) {
        waived.push({ finding: f, waiver: hit })
        continue
      }
      push(f)
    }
  }

  // 过期备案不再压制，且必须自己冒出来要求复审（没命中的也算）。
  for (const w of expired) {
    push({
      code: 'WAIVER_EXPIRED',
      level: 'error',
      file: waiverFile,
      entity: w.code,
      message: `waiver for ${w.code} expired on ${w.reviewBy}; it no longer suppresses anything`,
    })
  }
  for (const issue of options.waiverIssues ?? []) {
    push({
      code: 'WAIVER_INVALID',
      level: 'error',
      file: waiverFile,
      entity: `entry#${issue.index}`,
      message: `waiver entry #${issue.index}: ${issue.problem}`,
    })
  }

  const rank: Record<Disposition, number> = { fix: 0, decide: 1, record: 2 }
  const groups = [...byCode.values()].sort((a, b) => {
    const disposition = rank[a.policy.disposition] - rank[b.policy.disposition]
    if (disposition !== 0) return disposition
    const impact = IMPACT_WEIGHT[b.impact] - IMPACT_WEIGHT[a.impact]
    if (impact !== 0) return impact
    const effort = EFFORT_WEIGHT[a.effort] - EFFORT_WEIGHT[b.effort]
    if (effort !== 0) return effort
    if (a.level !== b.level) return a.level === 'error' ? -1 : 1
    if (a.findings.length !== b.findings.length) return b.findings.length - a.findings.length
    return a.code.localeCompare(b.code)
  })

  return {
    groups,
    fix: groups.filter((g) => g.policy.disposition === 'fix').length,
    decide: groups.filter((g) => g.policy.disposition === 'decide').length,
    record: groups.filter((g) => g.policy.disposition === 'record').length,
    unknown: groups.filter((g) => !POLICIES[g.code]).map((g) => g.code),
    skipped: readouts.filter((r) => r.skipped).length,
    waived,
    waiverIssues: (options.waiverIssues ?? []).length,
  }
}

const fmt = (value: L10n, locale: Locale): string => value[locale]

export function triageLines(result: TriageResult, locale: Locale = 'en'): string[] {
  const zh = locale === 'zh'
  const lines: string[] = []
  const total = result.fix + result.decide + result.record
  lines.push(
    `TRIAGE actionable=${total} fix=${result.fix} decide=${result.decide} record=${result.record} waived=${result.waived.length} waiverIssues=${result.waiverIssues} skipped=${result.skipped} locale=${locale}`,
  )
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
    const rank = `impact=${g.impact} effort=${g.effort}`
    if (g.policy.disposition === 'fix') {
      const auto = g.policy.auto ? ' auto=yes' : ' auto=no(patch)'
      lines.push(
        `TRIAGE_FIX code=${g.code} count=${g.findings.length}${auto} ${rank} do=${fmt(g.policy.action, locale)}${where ? ' at=' + where : ''}`,
      )
    } else if (g.policy.disposition === 'decide') {
      const options = (g.policy.options ?? []).map((o) => fmt(o, locale)).join(' | ')
      lines.push(
        `TRIAGE_DECIDE code=${g.code} count=${g.findings.length} ${rank} recommend=${fmt(g.policy.action, locale)}${options ? ' options=' + options : ''}${where ? ' at=' + where : ''}`,
      )
    } else {
      lines.push(`TRIAGE_RECORD code=${g.code} count=${g.findings.length} ${rank} reason=${fmt(g.policy.meaning, locale)}`)
    }
  }

  const waivedByCode = new Map<string, { waiver: Waiver; count: number }>()
  for (const item of result.waived) {
    const key = `${item.waiver.code}@${item.waiver.reviewBy}@${item.waiver.scope ?? '*'}`
    const entry = waivedByCode.get(key) ?? { waiver: item.waiver, count: 0 }
    entry.count++
    waivedByCode.set(key, entry)
  }
  for (const { waiver, count } of waivedByCode.values()) {
    lines.push(
      `TRIAGE_WAIVED code=${waiver.code} count=${count} reviewBy=${waiver.reviewBy}${waiver.scope ? ' scope=' + waiver.scope : ''} reason="${waiver.reason.replace(/"/g, "'")}"`,
    )
  }
  if (result.waiverIssues > 0) {
    lines.push(
      zh
        ? `TRIAGE_NOTE waiverIssues=${result.waiverIssues}：备案条目缺理由或复审日期非法，它们不压制任何发现。`
        : `TRIAGE_NOTE waiverIssues=${result.waiverIssues}: malformed waiver entries suppress nothing.`,
    )
  }

  todayList(result, locale).forEach((item, i) => lines.push(`TRIAGE_TODAY ${i + 1}) ${item}`))
  return lines
}

/**
 * 今天只做这些：fix/decide 按 disposition → 影响面降序 → 成本升序取前 cap 条。
 * 目的不是列全，而是给一个今天能做完的队列。
 */
export function todayList(result: TriageResult, locale: Locale = 'en', cap = 5): string[] {
  const zh = locale === 'zh'
  return result.groups
    .filter((g) => g.policy.disposition !== 'record')
    .slice(0, cap)
    .map((g) => {
      const count = g.findings.length > 1 ? (zh ? `（${g.findings.length} 处）` : ` (${g.findings.length} sites)`) : ''
      return `[${g.code}] impact=${g.impact} effort=${g.effort} ${fmt(g.policy.action, locale)}${count}`
    })
}

/**
 * 读外部 findings（P0-1）：别的扫描器 / 上一轮 qe-report.json / 人工导出的 JSON。
 * 支持四种形状：Finding[]、{ findings }、{ guards }、{ readouts }。
 * 字段不合法的条目直接抛错并指明第几条 —— 不静默丢弃（丢弃会把红读成绿）。
 */
export async function readExternalFindings(file: string): Promise<GuardReadout[]> {
  const resolved = path.resolve(file)
  let raw: string
  try {
    raw = await readFile(resolved, 'utf8')
  } catch {
    throw new Error(`找不到 findings 文件：${resolved}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`${resolved} 不是合法 JSON：${(e as Error).message}`)
  }
  return normalizeReadouts(parsed, resolved)
}

const LEVELS = new Set(['error', 'warn', 'info'])

function normalizeReadouts(parsed: unknown, label: string): GuardReadout[] {
  if (Array.isArray(parsed)) {
    const looksLikeReadouts = parsed.every((item) => item && typeof item === 'object' && 'guard' in item && 'findings' in item)
    if (!looksLikeReadouts && parsed.some((item) => item && typeof item === 'object' && 'findings' in item)) {
      throw new Error(`${label}: 不能把 readouts 与裸 findings 混在同一个数组里`)
    }
    return looksLikeReadouts
      ? parsed.map((item, i) => toReadout(item, `${label}[${i}]`))
      : [{ guard: `external:${path.basename(label)}`, findings: parsed.map((f, i) => toFinding(f, `${label}[${i}]`)), scanned: `external ${parsed.length}` }]
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${label}: 顶层必须是数组或对象`)
  }
  const box = parsed as { findings?: unknown; guards?: unknown; readouts?: unknown }
  const readouts = box.guards ?? box.readouts
  if (Array.isArray(readouts)) return readouts.map((item, i) => toReadout(item, `${label}.${box.guards ? 'guards' : 'readouts'}[${i}]`))
  if (Array.isArray(box.findings)) {
    return [
      {
        guard: `external:${path.basename(label)}`,
        findings: box.findings.map((f, i) => toFinding(f, `${label}.findings[${i}]`)),
        scanned: `external ${box.findings.length}`,
      },
    ]
  }
  throw new Error(`${label}: 需要 Finding[]、{ findings }、{ guards } 或 { readouts }`)
}

function toReadout(value: unknown, label: string): GuardReadout {
  const r = value as Partial<GuardReadout> | null
  if (!r || typeof r !== 'object') throw new Error(`${label}: readout 必须是对象`)
  if (typeof r.guard !== 'string' || !r.guard.trim()) throw new Error(`${label}: 缺少 guard 字段`)
  if (!Array.isArray(r.findings)) throw new Error(`${label}: findings 必须是数组`)
  return {
    guard: r.guard,
    findings: r.findings.map((f, i) => toFinding(f, `${label}.findings[${i}]`)),
    scanned: typeof r.scanned === 'string' ? r.scanned : `external ${r.findings.length}`,
    ...(typeof r.skipped === 'string' ? { skipped: r.skipped } : {}),
  }
}

function toFinding(value: unknown, label: string): Finding {
  const f = value as Partial<Finding> | null
  if (!f || typeof f !== 'object') throw new Error(`${label}: finding 必须是对象`)
  if (typeof f.code !== 'string' || !f.code.trim()) throw new Error(`${label}: 缺少 code`)
  if (typeof f.level !== 'string' || !LEVELS.has(f.level)) throw new Error(`${label}: level 必须是 error / warn / info`)
  return {
    code: f.code,
    level: f.level as Finding['level'],
    message: typeof f.message === 'string' ? f.message : f.code,
    ...(typeof f.file === 'string' ? { file: f.file } : {}),
    ...(typeof f.line === 'number' ? { line: f.line } : {}),
    ...(typeof f.entity === 'string' ? { entity: f.entity } : {}),
  }
}

export async function writeTriage(
  root: string,
  result: TriageResult,
  readouts: GuardReadout[],
  applied: string[],
  cli: string,
  locale: Locale = 'en',
  outDir: string | null = 'qe-report',
): Promise<{ jsonFile: string | null; mdFile: string | null }> {
  // null = --no-report：清单照打，文件不落盘
  if (!outDir) return { jsonFile: null, mdFile: null }
  const dir = path.isAbsolute(outDir) ? outDir : path.join(root, outDir)
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
        waived: '已被备案压制',
        skipped: '跳过守卫',
        regen: '复验命令',
        today: '今天只做这些',
        noToday: '无（本次没有 fix/decide 级待办）',
        applied: '本次 `--apply` 已自动追加别名',
        s1: '1. 直接改（唯一正确动作）',
        s2: '2. 需要你选（每项已给推荐）',
        s3: '3. 备案即可（不修，只留账）',
        s4: '4. 已备案（不压制后仍需在报告里可见）',
        none: '无。',
        what: '它是什么',
        recommend: '推荐动作',
        recordAction: '备案',
        options: '可选',
        impact: '影响面',
        effort: '成本',
        draft: '备案草稿（用 `autoqe waive <CODE> --reason ... --review-by ...` 写入 qe/waivers.json）',
        skippedGuards: '跳过的守卫',
        scope:
          '口径：本清单只对本次实际扫到的 findings 负责；0 项 ≠ 无缺陷。处置政策单源在 `qe/lib/triage.ts`，未登记的代码一律进入「需要你选」，不会被自动备案。备案只在 qe/waivers.json 里且未过期时压制发现；过期条目不压制，并自己变成 WAIVER_EXPIRED 待办。',
      }
    : {
        title: 'Triage — what to do next',
        generated: 'Generated',
        conclusion: 'Conclusion',
        fix: 'fix',
        decide: 'decide',
        record: 'record',
        waived: 'suppressed by waivers',
        skipped: 'skipped guards',
        regen: 'Re-run',
        today: "Today's list",
        noToday: 'Nothing (no fix/decide items this run)',
        applied: '`--apply` appended aliases',
        s1: '1. Fix now (one correct action)',
        s2: '2. Decide (options with a recommendation)',
        s3: '3. Record only (no code change)',
        s4: '4. Waived (still visible after suppression)',
        none: 'None.',
        what: 'What it is',
        recommend: 'Recommended',
        recordAction: 'Record',
        options: 'Options',
        impact: 'Impact',
        effort: 'Effort',
        draft: 'Waiver draft (write it with `autoqe waive <CODE> --reason ... --review-by ...` into qe/waivers.json)',
        skippedGuards: 'Skipped guards',
        scope:
          'Scope: this list covers only the findings from this run; 0 items is not proof of safety. The disposition table lives in `qe/lib/triage.ts`; unregistered codes always fall to decide and are never auto-waived. A waiver suppresses findings only while it is in qe/waivers.json and not past reviewBy; expired entries suppress nothing and surface as WAIVER_EXPIRED.',
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
        return `### ${g.code} (${g.findings.length}, ${g.level}, ${text.impact}=${g.impact}, ${text.effort}=${g.effort})\n\n- ${text.what}: ${fmt(g.policy.meaning, locale)}\n- ${lead}: ${fmt(g.policy.action, locale)}${extra}\n${locs}`
      })
      .join('\n\n')
    return `## ${title}\n\n${body}\n`
  }
  const waivedBody = result.waived.length
    ? [...new Map(result.waived.map((w) => [`${w.waiver.code}@${w.waiver.reviewBy}`, w])).values()]
        .map((w) => `- ${w.waiver.code}: ${w.waiver.reason} (reviewBy ${w.waiver.reviewBy}${w.waiver.scope ? `, scope ${w.waiver.scope}` : ''})`)
        .join('\n')
    : text.none
  const skipped = readouts
    .filter((r) => r.skipped)
    .map((r) => `- ${r.guard}: ${r.skipped}`)
    .join('\n')
  const recordDraft = result.groups
    .filter((g) => g.policy.disposition === 'record')
    .map((g) =>
      JSON.stringify(
        { code: g.code, reason: `${fmt(g.policy.meaning, locale)} (${g.findings.length})`, reviewBy: 'TODO-YYYY-MM-DD' },
        null,
        2,
      ),
    )
    .join('\n')

  return `# ${text.title}

- ${text.generated}: ${now}
- ${text.conclusion}: ${total} = **${text.fix} ${result.fix}** / **${text.decide} ${result.decide}** / **${text.record} ${result.record}** / **${text.waived} ${result.waived.length}**
- ${text.skipped}: ${result.skipped}
- ${text.regen}: \`${cli} run --root .\`

## ${text.today}

${today.length ? today.map((t, i) => `${i + 1}. ${t}`).join('\n') : text.noToday}

${applied.length ? `> ${text.applied}: ${applied.join(', ')}\n` : ''}
${section(text.s1, 'fix')}
${section(text.s2, 'decide')}
${section(text.s3, 'record')}
## ${text.s4}

${waivedBody}

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
