# AutoQe

**Quality engineering for AI-assisted development: turn "rules people are supposed to remember" into
checks that go red on every run. Invariants first, test cases second.**

[![CI](https://github.com/xufuji5/AutoQe/actions/workflows/qe.yml/badge.svg)](https://github.com/xufuji5/AutoQe/actions/workflows/qe.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Repository: https://github.com/xufuji5/AutoQe

## What it does

AutoQe does not run your tests. It looks for the defects tests never enumerate — the ones that compile,
pass lint, and then fail silently in production: a column nobody writes, an endpoint with no real UI
entry, an assertion that can never fail, a build that only works on the author's machine.

The engine is standalone: unzip it anywhere, open that folder in an AI coding tool, and point it at the
projects you want to audit. It never needs to be copied into them.

| Area | Typical defects | Guards |
|---|---|---|
| Data & structure | columns never written or read, dead enum values, reads of a soft-delete table without the predicate | `inv01`–`inv03`, `inv25` |
| Server boundary | entries without auth / validation / idempotency, public routes without a reason, mutating endpoints without a limit | `inv20`, `aq01`, `aq06`, `inv28` |
| Seams & client state | client code importing Prisma/Node, sensitive fields persisted by a store, an endpoint with no UI send point, production code importing mocks | `inv21`, `inv22`, `inv23`, `aq12` |
| Concurrency & consistency | check-then-act, missing tenant predicate, IDOR, missing idempotency key, wrong reading shape, conflict fallback inside a transaction | `aq04`, `aq05`, `aq08`–`aq10`, `aq14` |
| False green | assertions that can never fail, status literals, swallowed errors, hardcoded data | `aq02`, `aq03`, `aq07`, `aq13` |
| Dev-time fake scaffolding | verifiers that ignore their inputs and always pass, self-test scripts hitting real external services without a forced mock, dev gates / catch branches returning hardcoded business data | `aq16`–`aq18` |
| Promises & addressability | documented promises with no enforcement point, idle gates, unregistered guards, assertion targets missing in CI, docs promising unimplemented things | `inv06`, `inv07`, `inv13`, `inv24`, `spec-abs` |
| Delivery | HEAD that cannot build from a clean checkout, tool paths resolved against the CWD | `inv27`, `aq11` |
| Leaks & isolation | local paths, credentials or codewords in files, commit messages or the git index; project state inside the engine | `leak`, `iso01` |
| Mini-program | timer firing after page death, missing isolated styles, `setData` before first render, back at stack depth 1, page not in `app.json`, `tabBar` + `navigateTo`, async write to a dead page, undefined class | `mp01`–`mp08` |

Four rules make it more than a pile of regexes:

1. **Invariants over test cases** — every rule states something that must hold for all instances. It lives in
   `qe/registry/registry.ts` with a status (`enforced` / `partial` / `open`), its blind spots and a review date.
2. **Bad sample first** — a new guard must fail against an independently built bad fixture before it is trusted.
3. **No vacuous green** — a guard that cannot see its subject reports `skipped`, never "0 findings".
4. **Ratchet** — counts per `guard:finding` are frozen and may only go down; a regression fails CI.

Contains 59 invariants (20 `enforced` / 36 `partial` / 3 `open`), 44 guards (15 `inv` + 17 `aq` + 8 `mp` +
spec reconciliation + leak + isolation), 25 pure-function rules, 42 incident-backed knowledge entries and
464 self-test cases. Every rule records the real incident it came from; `open` gaps are listed, not hidden.

## Requirements

- Node.js **>= 22.18** (native TypeScript type stripping; no build step)
- `npm install` once in the engine folder — TypeScript 5.9 is the only runtime dependency (`npx autoqe`
  handles this for you)
- Optional: Prisma 5/6 projects for schema-based guards

## How to use

### A. Open the folder with an AI coding tool (recommended)

1. Download and unzip this repository **to any directory**. The engine does not need to live inside the
   project it audits. Run `npm install` once in that folder, or let the agent do it.
2. Open the folder in Codex / WorkBuddy / Trae / Claude Code, or any agent with terminal access.
3. Tell the agent what to scan, in plain language:

   > Scan `<path/to/project>` with AutoQe. Read `AGENTS.md` first, then init, doctor, run and triage it, and
   > write the audit under `qe-audit/`. Do not change the project's source code.

The agent reads [`AGENTS.md`](AGENTS.md) (the operating protocol) and `QE-00`–`QE-03`, then calls the engine
itself:

```bash
node qe/cli.ts init   --root <project>   # one-time: qe.config.json + QE docs + templates in the target
node qe/cli.ts doctor --root <project>   # pre-flight; prints the next step
node qe/cli.ts run    --root <project>   # all guards → QE_RESULT / GUARD_SUMMARY / RATCHET
node qe/cli.ts triage --root <project>   # fix / decide / record
node qe/cli.ts report --root <project>   # qe-report/qe-report.md
```

Outputs: the mechanical scan is `qe-report/qe-report.md`; the semantic audit is
`qe-audit/<project>-<date>/` (fact baseline, entry inventory, scan log, bug ledger with `file:line`,
release decision). `init` only adds config, QE docs and templates — never source code — and never
overwrites an existing `AGENTS.md`. `AGENTS.md` binds the agent: no "done" without a reading or a ledger
row, no editing the config or baseline to silence a finding, and `skipped` is never reported as passed.

### B. Several projects at once (isolation is built in)

One engine can audit many projects — separately or at the same time — without sharing state: each target
has its own config, identity file, baseline and report, and the engine folder stays stateless. Initialise
each target once (`init --root <project>`), then:

```bash
node qe/cli.ts multi --roots ../shop,../admin   # one child process per project, cwd set to it
```

`multi` fails unless every child proves its own root (`MULTI_ISOLATION_*`) and its output never mentions
another project's path (`MULTI_CROSS_TALK`). To audit a repository you must not modify at all, keep the
state outside it: `node qe/cli.ts run --root <other> --config <state>/qe.config.json` puts identity,
baseline and reports beside that config, not in the audited tree.

### C. CLI only, no AI tool

```bash
cd your-project
npx autoqe init          # qe.config.json + docs + templates; never overwrites an existing AGENTS.md
npx autoqe doctor        # check Node, config, schema, source roots, then print the next step
npx autoqe run --root .  # run every guard

npx autoqe triage --root .                               # fix / decide / record
npx autoqe waive CODE --reason "…" --review-by 2026-12-31
npx autoqe ratchet-update --root .                       # freeze current counts as the baseline
npx autoqe report --root .                               # write qe-report/qe-report.md
```

`npx autoqe explain INV-CORE-01` prints the rule, its defect classes, the guard, the bad sample and the
command that reproduces it. `npx autoqe prompt audit` prints a ready-to-paste prompt with the current
readings embedded.

### D. In this repository (toolkit development)

```bash
npm install
node qe/cli.ts init
npm run qe:selftest   # 464 case-level self-checks
npm run qe            # guards + ratchet comparison
```

Expected reading:

```text
SELFTEST_RESULT cases=464 passed=464 failed=0 status=green
QE_RESULT guards=44 errors=0 warnings=3 skipped=16 status=yellow
RATCHET status=ok regressions=0 improvements=0 unverified=0 tracked=19 new=0 skips=16
```

`skipped=16` is honest, not a failure: `inv23` needs Next.js `api/**/route.*` files, `inv25` / `inv27` /
`inv28` need declared project facts (`softDelete.tables`, `build.command`, `rateLimit.patterns`), `aq09`
needs a declared unique-write entry, `aq17` needs self-test scripts under `scripts/` (this repo scans
`qe/demo/src` only), the eight `mp*` guards need a mini-program root (`app.json`), `spec-abs` needs
`spec.docs`, and `iso01` only applies when the engine is vendored inside the audited root.

## Commands

Every command works as `npx autoqe <cmd>` or as `node <engine>/qe/cli.ts <cmd>`; add `--root <dir>` to point
it at another project.

| Command | Purpose |
|---|---|
| `npx autoqe init` | Scaffold config, docs and templates into a target repository |
| `npx autoqe doctor` | Pre-flight check: Node, config, schema, sources, baseline; prints the next step |
| `npx autoqe run --root .` | Run all guards. `--config <file>` keeps identity/ratchet/reports beside that config |
| `npx autoqe scan` | Run all guards and write `qe-report/qe-report.md` in one shot |
| `npx autoqe status` | Stop-or-continue verdict: gaps, skipped guards, ratchet |
| `npx autoqe triage` | Sort findings into fix / decide / record; writes `qe-report/triage.md` |
| `npx autoqe waive CODE --reason … --review-by …` | Add a time-boxed waiver (`--scope` limits it to a path) |
| `npx autoqe explain INV-CORE-01` | Rule, blind spots, bad sample, reproduction command (`--json` for machines) |
| `npx autoqe prompt audit` | Paste-ready AI prompt with the current readings |
| `npx autoqe report --root .` | Write the Markdown report into the target repository |
| `npx autoqe list` | List invariants with status, guard and statement |
| `npx autoqe ratchet-update --root .` | Freeze counts as the baseline; a partial run is refused (`RATCHET_REFUSE`), `--force` overrides |
| `npx autoqe multi --roots a,b` | One child process per project; fails if isolation cannot be proven |
| `npx autoqe selftest` | Bad-sample verification (counter-proof) |
| `npx autoqe help` | Usage, commands and examples |

In-repo scripts: `npm run qe` (guards + ratchet), `npm run qe:ci` (typecheck + all self-checks + report),
`npm run qe:report`, `npm run qe:triage`, `npm run qe:list`, `npm run typecheck`,
`npm run test:isolation` (cross-project counter-proofs), `npm run test:oracle`, `npm run test:triage`,
`npm run qe:guard:invNN|aqNN|mpNN` (one guard).

## Configuration

Two adapter slots plus policy:

```json
{
  "schema": { "provider": "prisma", "path": "prisma/schema.prisma" },
  "source": { "collector": "ts", "roots": ["src"] },
  "boundaries": { "publicRoutes": [{ "file": "app/api/health/route.ts", "reason": "liveness probe" }] },
  "stores": { "moduleRoots": ["src/features"], "sensitiveKeys": ["token", "password"] },
  "ignore": ["node_modules", "dist"],
  "metaGuards": true
}
```

- Set `schema.provider` / `source.collector` to `none` when a stack does not apply. Dependent guards then
  report `skipped` (yellow) — never green.
- `metaGuards` controls `inv13`. `init` sets it to `false` when the host repository does not vendor `qe/`.
- Newer guards compare against **project facts** declared in their own sections (`coverage`, `softDelete`,
  `errors`, `build`, `rateLimit`). Undeclared ⇒ explicit `skipped`.
- WeChat mini-programs: `npx autoqe run --root <mini-program-repo> --config qe.config.miniprogram.json`.

Every field, default and recipe: [`docs/configuration.md`](docs/configuration.md).

## Cross-project isolation

The engine is reusable across projects; its state is not. Every boundary is a hard error, not a warning:

- A vendored engine directory carries no project state (`iso01`).
- Config-declared state and scan ranges must stay inside `<root>`; a `..` escape fails.
- Every state root has an identity file (`qe.project.json`). State without identity is refused, never adopted.
- `--config <state>/qe.config.json` keeps identity, ratchet and reports beside that config, so a project in
  another folder can be audited without either tree receiving files. Reusing that state for another root
  fails (`QE_ISOLATION_FOREIGN_ROOT`).
- `autoqe multi` crosses process boundaries: one child per project, `cwd` set to it, every `AUTOQE_*` / `QE_*`
  variable stripped, and each child must report its own root (`MULTI_ISOLATION_UNVERIFIED`,
  `MULTI_ISOLATION_MISMATCH`, `MULTI_CROSS_TALK`).

Readings: `ISOLATION mode=… root=… stateRoot=… id=…` on every run;
`ISOLATION_SELFTEST cases=21 passed=21` from `npm run test:isolation`;
`MULTI_RESULT roots=2 failed=0 status=green isolation=verified crossTalk=0 mismatched=0` from `multi`.

## Data hygiene

No secrets, customer data or project names. `leak-project-info` (INV-META-01) fails on local absolute paths,
credential shapes, industry vocabulary, and codewords from an **external** denylist
(`AUTOQE_DENYLIST=/path/to/leak-denylist.txt`). It scans file bodies, commit messages **and** the git index:
a report, audit workspace, export, state identity, waiver, denylist or `.env` that reaches the index fails
with `TRACKED_STATE_FILE`, even when `.gitignore` hid it. A scan that could not run is `warn`
(`INDEX_NOT_SCANNED` / `COMMITS_NOT_SCANNED`) — no conclusion, never "clean".

Boundary: reports, audit workspaces, exports, state identity, waivers and local denylists are **data**
(ignored, refused if tracked). `qe/rules/`, `qe/skills/` and the incident ledger are **knowledge** (tracked).
The public history is a single squashed snapshot with a `noreply` author.

## Documentation

| Doc | Topic |
|---|---|
| [`QE-00-index.md`](QE-00-index.md) | Index, numbering rules, reading paths, copy package |
| `QE-01`–`QE-05` | Method: invariants, mechanized quality, project audit and release decision, nine defect classes, invariant spec |
| `QE-06`–`QE-09` | Stacks: Next.js boundaries, Prisma/PostgreSQL concurrency, adversarial input, Zustand |
| [`docs/configuration.md`](docs/configuration.md) | Every config field, defaults, customization recipes |
| [`docs/ai-agent-workflow.md`](docs/ai-agent-workflow.md) | Working with Codex / Claude Code / WorkBuddy |
| [`AGENTS.md`](AGENTS.md) | Working protocol for coding agents |

Blind spots are printed by `npx autoqe explain <guard>`; `open` invariants are listed by `npm run qe:list`
rather than hidden.

## Contributing

Register the invariant first (even as `open`, with a reason), ship the guard with a bad fixture that fails
for the intended reason, prove addressability (`qe:guard:invNN` alias + self-test case), add a
counter-example whenever scope changes, and never add new violations to the baseline.

```bash
npm run typecheck && npm run qe:selftest && npm run qe
```

## 中文速览

AutoQe 是「不变量优先」的质量工程工具：它不跑测试，而是检查测试枚举不到、且不会报错的结构性缺陷
（零写/零读列、没有界面入口的端点、永不失败的断言、只在作者机器上能构建的 HEAD、软删表漏谓词等）。

- **59 条不变量**（20 enforced / 36 partial / 3 open）、**44 个守卫**、**25 条纯函数规则**、
  **42 条事故知识库**、**464 个坏样本自证**；每条规则都能追到一次真实事故。
- **先红后绿**：新守卫先对坏样本变红才算数；**看不到对象就 `skipped`**，绝不报「0 个问题」。
- **棘轮只降不升**：基线计数只允许下降，回归直接让 CI 变红；没跑到的键报 `unverified`，
  局部运行拒绝写基线（`RATCHET_REFUSE`）。

用法（推荐）：把仓库下载解压到**任意目录** → 用 Codex / WorkBuddy / Trae 等 AI 工具打开该目录 →
直接说一句「扫描 `<项目路径>` 的缺陷」。AI 会读 `AGENTS.md`，自行执行
`init → doctor → run → triage → report`，输出 `qe-report/qe-report.md` 与 `qe-audit/<项目>-<日期>/` 清单；
引擎不必放进被扫描的项目，首次只需在引擎目录执行一次 `npm install`（唯一依赖 typescript）。

隔离已内置：同一个引擎可同时扫描多个项目，配置、身份、基线、报告各归各自项目，
`multi --roots a,b` 一项目一子进程，A 的数据不会进入 B 或引擎目录。仓外只读审计用
`run --root <other> --config <state>/qe.config.json`，被审计仓零落地。
本仓开发：`npm install` → `node qe/cli.ts init` → `npm run qe:selftest` → `npm run qe`。
单条规则：`npx autoqe explain INV-CORE-01`。许可证：MIT。

## License

MIT — see [LICENSE](LICENSE).
