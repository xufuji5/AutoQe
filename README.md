# QE Toolkit

**Quality Engineering for AI-assisted software development — invariants first, tests second.**

## What it is

QE Toolkit turns a team's audit methodology into executable checkers. Every rule is an **invariant**: a
statement that must hold for *every* instance, not just the paths a test happened to enumerate.

The repository has three layers:

1. **A registry** (`qe/registry/registry.ts`) — the single source of truth for every invariant, including
   its status (`enforced` / `partial` / `open`), guards, blind spots, and review date.
2. **Guards** (`qe/guards/*.ts`) — static scanners that emit findings and fail on `errors > 0`.
3. **A project audit playbook** (`QE-03`) — a stack-agnostic checklist to assess any existing codebase,
   produce a reproducible bug ledger, and decide whether it can ship.

## What it is **not**

- It is **not** an upgrade pack. If your project already has stronger guards, keep them. QE only supplies
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

```bash
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
| `npm run qe` | All guards + ratchet comparison (non-zero exit on regression) |
| `npm run qe:selftest` | Bad-sample verification |
| `npm run qe:report` | Generate the Markdown report |
| `npm run qe:list` | Show the registry and its gaps |
| `npm run qe:guard:invNN` | Run a single guard (`inv01`…`inv22`) |
| `npm run qe:ratchet:update` | Tighten the baseline after a deliberate decision |
| `npm run qe:ci` | typecheck + self-test + guards + report |
| `npm run typecheck` | Type-check the toolkit (`tsconfig.qe.json`) |

## Repository layout

```text
.
├── QE-00-index.md                 # Documentation entry point (EN)
├── QE-01…QE-09                    # Method + stack-specific playbooks (EN, Chinese summary at top)
├── docs/zh-CN/                    # Full Chinese editions (archive)
├── AGENTS.md                      # Working protocol for coding agents
├── qe/
│   ├── cli.ts                     # run / selftest / report / ratchet-update / list
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
  "contracts": "qe.contracts.json"
}
```

- Set `schema.provider` / `source.collector` to `none` when a stack is not applicable.
  Dependent guards then report **`skipped`** (yellow) — never green.
- Adapters are registered in `qe/lib/providers.ts`. Add a new stack by implementing
  `SchemaProvider` or `CallCollector`; guards do not change.

## Using QE in another repository

1. Copy `QE-00`…`QE-09`, `qe/`, `qe.config.json`, `tsconfig.qe.json`, and the `qe:*` scripts.
   Do **not** copy `qe/ratchet.json`, `qe-report/`, or `qe-audit/`.
2. Point `schema.path` and `source.roots` at the host repository.
3. Run `npm run qe:selftest` (expect 19/19), then `npm run qe` for the first real reading.
4. Triage existing findings, then freeze the baseline with `npm run qe:ratchet:update`.
5. Copy `qe/templates/project-audit/` to `qe-audit/<project>-<date>/` and run the `QE-03` playbook.

> Treat QE as an **external checklist**: absorb the questions, not the tool's finding codes or report shape.
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

QE Toolkit 是「不变量优先」的质量工程工具箱：把缺陷拦在设计层，而不是靠用例枚举。内置 27 条不变量、
9 个静态守卫、19 个坏样本自证与只降不升的 ratchet 基线，并提供一套通用的项目体检与上线判定作业单。
它适合作为**外部体检清单**引入已有项目，**不替代**项目原有的守卫体系；内置 Prisma schema 与 TypeScript AST
适配器，其他技术栈通过适配器接入。许可证：MIT。

## License

MIT — see [LICENSE](LICENSE).
