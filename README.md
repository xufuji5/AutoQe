# AutoQe

**Quality Engineering for AI-assisted software development — invariants first, tests second.**

[![CI](https://github.com/xufuji5/AutoQe/actions/workflows/qe.yml/badge.svg)](https://github.com/xufuji5/AutoQe/actions/workflows/qe.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Repository: https://github.com/xufuji5/AutoQe

## What it is

AutoQe turns a team's audit methodology into executable checkers. Every rule is an **invariant**: a
statement that must hold for *every* instance, not just the paths a test happened to enumerate.

The repository has three layers:

1. **A registry** (`qe/registry/registry.ts`) — the single source of truth for every invariant, including
   its status (`enforced` / `partial` / `open`), guards, blind spots, and review date.
2. **Guards** (`qe/guards/*.ts`) — static scanners that emit findings and fail on `errors > 0`.
3. **A project audit playbook** (`QE-03`) — a stack-agnostic checklist to assess any existing codebase,
   produce a reproducible bug ledger, and decide whether it can ship.

## What it is **not**

- It is **not** an upgrade pack. If your project already has stronger guards, keep them. AutoQe only supplies
  questions you may not have asked yet.
- It is **not** a test generator. It does not replace e2e, contract tests, or load tests.
- It **does not** claim full coverage. Every guard declares its scope and blind spots, and `open`
  invariants are listed explicitly rather than hidden.

## Core ideas

| Idea | Meaning |
|---|---|
| Invariants > test cases | A test asks "is this path correct?" An invariant asks "does this hold for everything?" |
| Single source | Rules live in the registry; documents and reports only point to it |
| Bad sample first | A new guard must fail against an independently constructed bad fixture before it is trusted |
| Three states | `enforced` (guarded and gated), `partial` (guarded, incomplete scope), `open` (documented gap with reason and review date) |
| Ratchet | Findings per `guard:finding` may only go down; a regression fails CI |
| No vacuous green | Scanning zero objects is never a pass — it is `skipped` or an error |

## What's inside

| Area | Contents |
|---|---|
| Registry | 27 invariants — 10 `enforced`, 5 `partial`, 12 `open` |
| Guards | 9 scanners: `inv01`, `inv02`, `inv03`, `inv06`, `inv07`, `inv13`, `inv20`, `inv21`, `inv22` |
| Self-test | 19 good/bad fixture cases (`npm run qe:selftest`) |
| Adapters | Prisma schema provider, TypeScript AST call collector |
| Gates | `npm run qe` (guards + ratchet), `npm run qe:ci` (typecheck + self-test + guards + report) |
| CLI | `npx autoqe init` scaffolds a project; `npx autoqe run --root .` audits it without copying any source |
| Audit playbook | `QE-03`: S0 baseline → S1 quick scan → S2 seven tracks → S3 triage → S4 twelve release gates |
| Templates | Project audit workspace (6 files), intake form, bad-sample register, batch closeout form, approval five questions |

## Requirements

- Node.js **>= 22.18** (native TypeScript type stripping; no build step)
- TypeScript 5.9 (used for type checking and AST parsing only)
- Optional: Prisma 5/6 projects for schema-based guards
- CI: GitHub Actions — [`.github/workflows/qe.yml`](.github/workflows/qe.yml) runs typecheck, self-test, guards and the report on every push and pull request

```bash
npm install
```

## Quick start

### A. Copy the folder into your project (zero install, easiest for AI tools)

This is the simplest path if you drive the scan with Codex / Claude Code / WorkBuddy.

```bash
# 1. copy this whole folder into the target project root, e.g. your-app/autoqe/
# 2. from the target project root:
node autoqe/qe/cli.ts init          # write qe.config.json + docs; never overwrites AGENTS.md
node autoqe/qe/cli.ts doctor        # confirm Node / schema / source roots before scanning
node autoqe/qe/cli.ts scan          # all guards + qe-report/qe-report.md in one shot
node autoqe/qe/cli.ts prompt audit --root . > prompt.txt   # paste into your AI tool
```

- If your project already has `typescript` in `node_modules`, nothing to install. Otherwise run
  `npm install --prefix autoqe` once.
- The copied folder is excluded from scanning automatically, so even `source.roots: ["."]` will not audit
  the tool itself.
- `init` runs once; `scan` is the repeatable command (guards + report). Then hand `prompt.txt` to the agent
  and ask it to write `qe-audit/<project>-<date>/` per `QE-03`.
- Give the agent these files, in this order: `README.md` → `AGENTS.md` → `QE-00-index.md` →
  `QE-03-project-audit-and-release-gate.md` → `prompt.txt`.

### B. As a CLI (recommended for existing projects)

```bash
cd your-project
npx autoqe init         # write qe.config.json, QE-00…09, qe/templates, qe.contracts.json
npx autoqe doctor       # check Node/config/schema/sources/baseline, then print the next step
npx autoqe run --root . # run all guards against this project
```

Not sure what a finding means? `npx autoqe explain INV-CORE-01` prints the rule, its defect classes, the
guard, the bad sample and the exact command to reproduce it. `npx autoqe prompt audit` prints a ready-to-paste
prompt with the current readings already embedded, for Codex / Claude Code / WorkBuddy.

`init` detects `prisma/schema.prisma` and `src` / `app` automatically. It never overwrites an existing
`AGENTS.md` — it writes `AGENTS.autoqe.md` instead so you can merge the rules by hand. Use `--force` to
overwrite files created by a previous `init`. No global install is needed. The npm package ships compiled
JavaScript, so `npx` works out of the box; Node >= 22.18 is required by `package.json` (and needed when you
run the TypeScript sources directly in vendored mode).

### C. Inside this repository (toolkit development)

```bash
npm install
npm run qe:selftest   # 19 fixture cases must pass (each "bad" case must fail for the right reason)
npm run qe            # run all guards, then compare against the ratchet baseline
npm run qe:report     # write qe-report/qe-report.md (a dated snapshot, never the source of truth)
npm run qe:list       # list invariants with status, guards, open reasons
```

Expected output shape:

```text
SELFTEST_RESULT cases=19 passed=19 failed=0 status=green
QE_RESULT guards=9 errors=0 warnings=0 skipped=0 status=green
RATCHET status=ok regressions=0 improvements=0 tracked=0
```

## Commands

| Command | Purpose |
|---|---|
| `npx autoqe help` | Usage, commands and examples (also the default when no command is given) |
| `npx autoqe init` | Scaffold config, docs and templates into a target repository |
| `npx autoqe doctor` | Pre-flight check: Node, config, schema, source roots, contracts, ratchet; prints the next step |
| `npx autoqe status` | Stop-or-continue verdict: batch true-hole output, open gaps, skipped guards, ratchet |
| `npx autoqe triage` | Sort findings into **fix / decide / record**; writes `qe-report/triage.md` with a capped today list and a waiver draft |
| `npx autoqe triage --apply` | Apply only additive mechanical fixes (missing guard aliases in `package.json`), never source code |
| `npx autoqe triage --from <json>` | Triage findings produced elsewhere (`Finding[]`, `{ findings }`, `{ guards }`) without re-running guards |
| `npx autoqe triage --lang zh` | Human-facing output in Chinese for `triage`, `status` and `report`; `locale` in `qe.config.json` sets the default |
| `npx autoqe waive CODE` | Add a waiver to `qe/waivers.json`; `--reason` and `--review-by YYYY-MM-DD` are required, `--scope` limits it to a path |
| `npx autoqe scan` | Run all guards and write `qe-report/qe-report.md` in one shot |
| `npx autoqe run --root .` | Run all guards against the target repository |
| `npx autoqe explain INV-CORE-01` | Explain one invariant or guard (`inv22`, `qe:guard:inv22` also work); `--json` for machines |
| `npx autoqe prompt audit\|fix\|review` | Print a paste-ready AI prompt with the current readings embedded |
| `npx autoqe report --root .` | Write the Markdown report into the target repository |
| `npx autoqe list [--json]` | List invariants with status, guard and statement |
| `npx autoqe ratchet-update --root .` | Freeze the current counts as the baseline (only after human triage) |
| `npx autoqe selftest` | Bad-sample verification (counter-proof) |
| `npm run qe` | All guards + ratchet comparison (non-zero exit on regression) |
| `npm run qe:selftest` | Bad-sample verification |
| `npm run qe:report` | Generate the Markdown report |
| `npm run qe:triage` | Generate the fix / decide / record disposition list |
| `npm run test:triage` | Policy self-check: every emitted finding code has a disposition; unknown codes never auto-waive |
| `npm run qe:list` | Show the registry and its gaps |
| `npm run qe:guard:invNN` | Run a single guard (`inv01`…`inv22`) |
| `npm run qe:ratchet:update` | Tighten the baseline after a deliberate decision |
| `npm run qe:ci` | typecheck + self-test + guards + triage self-check + report |
| `npm run typecheck` | Type-check the toolkit (`tsconfig.qe.json`) |

## Repository layout

```text
.
├── QE-00-index.md                 # Documentation entry point (EN)
├── QE-01…QE-09                    # Method + stack-specific playbooks (EN, Chinese summary at top)
├── docs/zh-CN/                    # Full Chinese editions (archive)
├── AGENTS.md                      # Working protocol for coding agents
├── qe/
│   ├── cli.ts                     # init / doctor / status / scan / run / explain / prompt / report / list / selftest / ratchet-update
│   ├── guards/                    # One file per guard
│   ├── lib/                       # Config, providers, AST utils, ratchet
│   ├── registry/registry.ts       # Single source of truth for invariants
│   ├── fixtures/                  # Good/bad samples per guard
│   ├── demo/                      # Minimal integration example
│   └── templates/                 # Intake / bad-sample / closeout / project-audit templates
├── qe.config.json                 # Adapter and boundary configuration
├── tsconfig.qe.json               # Independent from the host repo's tsconfig
└── qe/ratchet.json                # Baseline counts (per project)
```

## Guard catalog

| ID | Guard | What it catches | Invariants |
|---|---|---|---|
| `inv01` | Column writer | Columns that are never written | INV-CORE-01 |
| `inv02` | Column reader | Columns that are never read | INV-CORE-02 |
| `inv03` | Dead enum | Enum values with no producing path | INV-CORE-03 |
| `inv06` | Promise backing | Documented promises with no enforcement point | INV-CORE-06 |
| `inv07` | Idle gate | Gates with server checks but no UI control (or vice versa) | INV-CORE-07 |
| `inv13` | Addressable | Guards not registered, aliased, or without bad samples | INV-CORE-13 |
| `inv20` | Server boundary | Entries without auth/validation/idempotency; public routes without reason | INV-WEB-01…04 |
| `inv21` | Seam import | Client code reaching Prisma/Node, cross-module deep imports | INV-SEC-01, INV-SEAM-01 |
| `inv22` | Zustand store | Sensitive fields persisted, missing `partialize`, missing `version` | INV-FE-01…02 |

## Configuration

`qe.config.json` has two adapter slots and a few policy sections:

```json
{
  "schema": { "provider": "prisma", "path": "prisma/schema.prisma" },
  "source": { "collector": "ts", "roots": ["src"] },
  "boundaries": {
    "publicRoutes": [{ "file": "app/api/health/route.ts", "reason": "liveness probe" }]
  },
  "stores": {
    "moduleRoots": ["src/features", "src/modules"],
    "sensitiveKeys": ["token", "password", "secret"]
  },
  "ignore": ["node_modules", "dist"],
  "contracts": "qe.contracts.json",
  "metaGuards": false
}
```

- Set `schema.provider` / `source.collector` to `none` when a stack is not applicable.
  Dependent guards then report **`skipped`** (yellow) — never green.
- `metaGuards` controls `inv13` (guard aliases, bad samples, orphan guard files). `npx autoqe init` sets it
  to `false` because the host repository does not vendor `qe/guards`; keep `true` when you copy `qe/` into the repo.
- Adapters are registered in `qe/lib/providers.ts`. Add a new stack by implementing
  `SchemaProvider` or `CallCollector`; guards do not change.

Every field (default value, meaning, when to change it) plus recipes — scan a different tree, exempt a field,
register a public route, add a local guard or a new adapter — are in
[`docs/configuration.md`](docs/configuration.md).

## Using AutoQe in another repository

### Option A — CLI (nothing copied)

1. `cd <project> && npx autoqe init`
2. Edit `qe.config.json`: `schema.path`, `source.roots`, `boundaries.publicRoutes`, `stores.moduleRoots`.
3. `npx autoqe run --root .` for the first reading; triage findings, then
   `npx autoqe ratchet-update --root .` to freeze the baseline.
4. `npx autoqe report --root .` writes `qe-report/` inside the project.
5. Copy `qe/templates/project-audit/` to `qe-audit/<project>-<date>/` and run the `QE-03` playbook
   with your AI agent (see [`docs/ai-agent-workflow.md`](docs/ai-agent-workflow.md)).

### Option B — vendored (offline, no npm)

1. Copy `QE-00`…`QE-09`, `qe/`, `qe.config.json`, `tsconfig.qe.json`, and the `qe:*` scripts.
   Do **not** copy `qe/ratchet.json`, `qe-report/`, or `qe-audit/`.
2. Point `schema.path` and `source.roots` at the host repository.
3. Run `npm run qe:selftest` (expect 19/19), then `npm run qe` for the first real reading.
4. Triage existing findings, then freeze the baseline with `npm run qe:ratchet:update`.
5. Copy `qe/templates/project-audit/` to `qe-audit/<project>-<date>/` and run the `QE-03` playbook.

> Treat AutoQe as an **external checklist**: absorb the questions, not the tool's finding codes or report shape.
> If the host project already has stronger guards, mark the item "already covered" instead of replacing it.
> See `QE-00` §0 and `qe/templates/project-audit/05-gap-absorption-plan.md`.

## Documentation

| Doc | Topic |
|---|---|
| `QE-00-index.md` | Index, numbering rules, reading paths, copy package |
| `QE-01` | Quality philosophy: invariants over test cases |
| `QE-02` | Mechanized quality: ratchet and multi-module AI collaboration |
| `QE-03` | Project audit and release decision (S0–S4, 12 gates) |
| `QE-04` | Audit methodology: nine defect classes |
| `QE-05` | Invariant specification: definition, layers, lifecycle |
| `QE-06` | Next.js server boundaries and module seams |
| `QE-07` | Prisma + PostgreSQL concurrency and constraints |
| `QE-08` | Adversarial and malicious input |
| `QE-09` | Zustand client state and persistence |
| [`docs/ai-agent-workflow.md`](docs/ai-agent-workflow.md) | Using AutoQe with Codex, Claude Code, WorkBuddy (prompts and guardrails) |
| [`docs/configuration.md`](docs/configuration.md) | Every config field, defaults, and customization recipes |
| `AGENTS.md` | Working protocol for coding agents |

Each English document carries a one-line Chinese summary (中文摘要) at the end; full Chinese editions live in
`docs/zh-CN/`. The Chinese edition of `QE-04` is not published — it contains internal case histories;
only the redacted English edition ships.

## Contributing

Issues and pull requests are welcome on GitHub. Please keep the five rules below.

1. **Register first.** Add the invariant to `qe/registry/registry.ts` (even as `open` with a reason).
2. **Write the guard.** New guards must ship with a bad fixture that fails for the intended reason.
3. **Prove addressability.** Add a `qe:guard:invNN` alias and a self-test case.
4. **Do not widen silently.** If a guard's scope changes, add a counter-example that still fails.
5. **Ratchet only down.** Never add new violations to the baseline.

```bash
npm run typecheck && npm run qe:selftest && npm run qe
```

## Data hygiene

- No secrets, credentials, customer data, or internal business specifications belong in this repository.
- Internal business specifications are excluded via `.gitignore` and are not part of the public package.
- Reports in `qe-report/` and audit workspaces in `qe-audit/` are local artifacts and are ignored.

## 中文说明

AutoQe 是「不变量优先」的质量工程工具箱：把缺陷拦在设计层，而不是靠用例枚举。内置 27 条不变量、
9 个静态守卫、19 个坏样本自证与只降不升的 ratchet 基线，并提供一套通用的项目体检与上线判定作业单。
它适合作为**外部体检清单**引入已有项目，**不替代**项目原有的守卫体系；内置 Prisma schema 与 TypeScript AST
适配器，其他技术栈通过适配器接入。两种用法：`npx autoqe init` 后跑 `npx autoqe run --root .`；或把 `qe/`
复制进项目后用 `npm run qe`。许可证：MIT。

## License

MIT — see [LICENSE](LICENSE).
