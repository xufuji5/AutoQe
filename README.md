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
4. **A rule layer + an accident knowledge base** (`qe/rules/`, `qe/skills/`) — rules are pure functions
   (`analyze(src, rel) → hits`) so that the counter-example lives *in the same file* as the judgment;
   the knowledge base records which real incident produced each rule, and prints itself as an audit
   checklist (`autoqe skills --checklist`). A rule without a recorded incident is a rule invented for an
   attacker who does not exist.

## What it is **not**

- It is **not** an upgrade pack. If your project already has stronger guards, keep them. AutoQe only supplies
  questions you may not have asked yet.
- It is **not** a test generator. It does not replace e2e, contract tests, or load tests.
- It **does not** claim full coverage. Every guard declares its scope and blind spots, and `open`
  invariants are listed explicitly rather than hidden.

## What's new

This release turns several former "promises" into machine-checkable judgments:

| Feature | What changed |
|---|---|
| **Coverage-aware ratchet** | A baseline key whose guard did not run this round is reported as `unverified` — never as an improvement. `ratchet-update` refuses a partial run (`RATCHET_REFUSE`); bypassing that requires an explicit `--force`. `status` gains a fifth verdict: `INSUFFICIENT-COVERAGE` |
| **Five entry channels** | `inv13` no longer treats `package.json` as the only entry: script aliases, orchestration `.sh` references, imports (including side-effect imports), `join()`-built paths passed to a child process, and runner-discovered files all count — over **git-tracked** files only. Registry-side (`metaGuards`) and addressable-side judgments are now separate, so auditing a repository that does not vendor `qe/` no longer produces false alarms |
| **New guards** | `inv23` entry coverage (an endpoint must have a real UI send point), `inv24` an assertion target must be committable (exists **and** tracked **and** not ignored), `inv25` soft-delete read predicate, `inv26` error catalog ↔ thrown codes, `inv27` HEAD builds from a clean checkout, `inv28` rate/size limits on mutating endpoints (candidate only) |
| **Skip codes enter the ratchet** | Narrowing a guard's scope now produces a `<guard>:SKIP:<code>` key. Previously, turning a whole class of subjects into "not applicable" made findings disappear with no regression signal |
| **Index plane for leaks** | Data hygiene also scans `git ls-files`: a report, audit workspace, export, state identity, waiver, denylist or `.env` that reaches the **index** (e.g. after `git add -f`) fails with `TRACKED_STATE_FILE`, even when `.gitignore` hid it from the working tree |
| **Self-test level caps** | Fixtures accept `maxErrors` / `maxWarnings` / `maxInfos`, so a "good" sample cannot pass while emitting an unexpected volume of findings at the wrong level |
| **External state mode** | `run --root <other> --config <state>/qe.config.json` anchors identity, ratchet and reports at the config's directory (`stateRoot`), so auditing a project in another folder leaves both that repository and the engine directory untouched. The marker binds the state to the audited root; pointing it at a different root fails (`QE_ISOLATION_FOREIGN_ROOT`) |

## Cross-project isolation

The engine is meant to be reused across projects — that is its strongest feature. The same property is
its biggest hazard: A project's config, ratchet baseline, waivers, reports and generated fixtures can
silently follow the engine into B, so B's "0 errors" carries A's judgment. Isolation is therefore a
**design constraint**, not a usage convention (INV-ISO-01/02/03/04):

| Boundary | What is enforced |
|---|---|
| Engine is stateless | A vendored engine directory must not contain any project state; `iso01` fails if it does |
| State stays in its root | Config-declared state and scan ranges (`contracts`, `waivers`, `ledger`, `auditDir`, `reportDir`, `source.roots`, `spec.docs`, `stores.moduleRoots`) may not escape `<root>` via `..`; an escape is a hard error |
| State has an identity | `<stateRoot>/qe.project.json` identifies the state root. State without identity is refused, never auto-adopted. External state (`--config`) is bound to the audited root, so reusing it for another project fails |
| Template copies are detected | The marker also binds `package.json`'s `name`; copying a whole repository as a template into a differently named project fails instead of inheriting A's config and baseline |
| Auditing another folder leaves it untouched | External state (`--config <state>/qe.config.json`) puts `qe.project.json`, the ratchet baseline and reports beside that config, never in the audited repository and never in the engine directory. The marker binds the state to the audited root, so reusing it on a different root fails (`QE_ISOLATION_FOREIGN_ROOT`) |
| Runtime is per-process | Rule self-test fixtures go to a per-process `mkdtemp` directory that is deleted on exit; nothing is written to the engine directory and no disk cache survives the process |
| Cache is per-root | The AST cache is a table keyed by absolute root: scanning A and B in the same process cannot return B's file for A's query (and parallel scans cannot evict each other) |
| Concurrency crosses processes | `autoqe multi --roots a,b` starts **one child process per project**, sets `cwd` to that project root, and strips every `AUTOQE_*` / `QE_*` environment variable by default (new project-scoped variables are covered without editing a list). Shared config, identity and report paths are process singletons, so in-process concurrency is not offered at all |
| Isolation is proven, not promised | Every `multi` child must print its own `ISOLATION mode=… root=…` reading; `multi` fails if a child reports a different root or if its output mentions another project's path (`MULTI_ISOLATION_UNVERIFIED` / `MULTI_ISOLATION_MISMATCH` / `MULTI_CROSS_TALK`) |

Machine-readable readings: `ISOLATION mode=… root=… stateRoot=… id=… env=…` on every run,
`ISOLATION_SELFTEST cases=… passed=…` from `npm run test:isolation`, and
`MULTI_RESULT roots=… failed=… status=… isolation=… crossTalk=… mismatched=…` plus one
`MULTI root=… errors=…` line per project from `autoqe multi`. The isolation self-test scans two
different project trees in one process (sequentially **and** in parallel via `Promise.all`), spawns
two CLI processes at once, and runs `multi` over both trees — asserting that A's denylist, AST cache,
state and findings never reach B.

Exercised end to end on two independent project trees and one external production repository:

| Claim | Evidence |
|---|---|
| A repository in another folder is analyzed without being cloned or modified | `run --root <other> --config <state>/qe.config.json --only inv13` read ~156 scripts / 219 script files and reported 68 `UNWIRED_SCRIPT` findings; the audited tree received no state, report or cache |
| The audited project's data never enters the engine repository | After all scans, `git status` in the engine repo is empty and a full-tree search for the test markers returns 0; `qe.project.json` exists only under each project's `stateRoot`, with distinct ids |
| Concurrent projects cannot read each other | `MULTI_RESULT roots=2 failed=0 status=green isolation=verified crossTalk=0 mismatched=0`; project A's reading is identical alone and inside `multi` (`errors=0 warnings=2 skipped=25`); `ISOLATION_SELFTEST cases=21 passed=21` |

> 中文摘要：引擎可以跨项目复用，但**项目数据绝不可以**。四条硬边界：内置引擎目录无状态；状态与扫描范围只能落在本项目根内（`..` 逃逸直接报错）；状态根有身份文件，外部状态绑定被审计项目，换项目复用直接拒绝；运行期产物落进程级临时目录，AST 缓存按 root 分表。同一个 WorkBuddy 同时处理多个项目时只走**进程边界**（`autoqe multi`：一项目一子进程、cwd 切到项目根、默认剥掉全部 `AUTOQE_*`/`QE_*` 环境变量），并且每个子进程必须自报 root 读数、输出里不得出现别的项目路径——隔离是**行为判据**，不是文档承诺。仓外项目用 `--config` 审计时，身份、基线与报告锚在配置文件旁，被审计仓与引擎目录都零落地；实测并发读数 `isolation=verified crossTalk=0 mismatched=0`，单独跑与并发跑读数一致，隔离反证 21/21。

## Core ideas

| Idea | Meaning |
|---|---|
| Invariants > test cases | A test asks "is this path correct?" An invariant asks "does this hold for everything?" |
| Single source | Rules live in the registry; documents and reports only point to it |
| Bad sample first | A new guard must fail against an independently constructed bad fixture before it is trusted |
| Three states | `enforced` (guarded and gated), `partial` (guarded, incomplete scope), `open` (documented gap with reason and review date) |
| Ratchet | Findings per `guard:finding` may only go down; a regression fails CI. Untested keys are `unverified`, not improvements, and a partial run may not rewrite the baseline |
| No vacuous green | Scanning zero objects is never a pass — it is `skipped` or an error |
| Committable assertions | Every path a guard asserts about must exist **and** be git-tracked (`inv24`): a judgment over an ignored or absent file is green on a dev machine and red in CI |
| Data is not knowledge | Reports, audit workspaces, exports, state identity, waivers and local denylists are data — ignored and refused inside the index. Rules, skills and the incident ledger are knowledge — tracked and reviewed |
| Oracle first | Every judgment names its truth source. A rule without an entry in `qe/registry/rule-oracles.ts` refuses to run; a `human`-tier judgment (truth lives in docs, intent or environment) may only emit candidates, never errors |
| Isolation by construction | Methodology is shared across projects; project state never is. Every boundary is a hard error, not a warning |

## What's inside

| Area | Contents |
|---|---|
| Registry | 56 invariants — 23 `enforced`, 30 `partial`, 3 `open` |
| Guards | 40 scanners: 15 `inv*` (schema/AST/entry/build) + 14 `aq*` + 8 `mp*` (mini-program) + `spec-abs` + `leak-project-info` + `iso01` |
| Rules | `qe/rules/` — 22 pure-function judgments, each with its counter-examples inline and an oracle declaration in `qe/registry/rule-oracles.ts` |
| Knowledge base | `qe/skills/` — 42 entries, each tied to a real incident; generates the audit checklist |
| Probes | `qe/probe/` — runtime probes (fault injection, concurrency, three projections). Not guards: they need a running app |
| Self-test | 393 cases: guard fixtures + self-checks of the shared scanners (`npm run qe:selftest`; the report runs the same set once and prints `SELFTEST_RESULT`) |
| Adapters | Prisma schema provider, TypeScript AST call collector |
| Gates | `npm run qe` (guards + ratchet), `npm run qe:ci` (typecheck + guards + report; the report includes the self-test) |
| CLI | `npx autoqe init` scaffolds a project; `npx autoqe run --root .` audits it without copying any source; `QE_PROFILE=1` prints per-stage timings |
| Audit playbook | `QE-03`: S0 baseline → S1 quick scan → S2 seven tracks → S3 triage → S4 twelve release gates |
| Templates | Project audit workspace (6 files), intake form, bad-sample register, batch closeout form, approval five questions |

## Requirements

- Node.js **>= 22.18** (native TypeScript type stripping; no build step)
- TypeScript 5.9 (used for type checking and AST parsing only)
- Optional: Prisma 5/6 projects for schema-based guards
- CI: GitHub Actions — [`.github/workflows/qe.yml`](.github/workflows/qe.yml) runs typecheck, guards and the report (which runs the self-test) on every push and pull request

```bash
npm install
```

Fresh checkout: run `node qe/cli.ts init` once before `npm run qe:ci`. `qe.project.json` is local state
and is deliberately not committed; a checkout that has a baseline but no identity is refused
(`QE_ISOLATION_UNBOUND`) instead of silently adopting someone else's ledger. The same goes for
audit output (`qe-report/`, `qe-audit/`), waivers, contracts and local denylists — all ignored,
so even a wrong isolation guess cannot put another project's data into git history.

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
- Copy **code only**: the engine folder must not carry `qe.config.json`, `qe/ratchet.json`,
  `qe/waivers.json`, `qe.contracts.json`, `qe-report/` or generated fixtures from another project.
  `iso01` fails the scan if it finds any of them, so a contaminated copy cannot pass silently.
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
npm run qe:selftest   # 393 case-level self-checks must pass (each "bad" case must fail for the right reason)
npm run test:isolation # 21 cross-project isolation counter-proofs (two project trees, one process, incl. parallel + multi)
npm run test:triage   # every emitted finding code must have a disposition
npm run test:oracle   # every rule must name a truth source; human-tier judgments may not emit errors
npm run qe            # run all guards, then compare against the ratchet baseline
npm run qe:report     # write qe-report/qe-report.md (a dated snapshot, never the source of truth)
npm run qe:list       # list invariants with status, guards, open reasons
```

Expected output shape:

```text
SELFTEST_RESULT cases=393 passed=393 failed=0 status=green
QE_RESULT guards=40 errors=0 warnings=2 skipped=15 status=yellow
RATCHET status=ok regressions=0 improvements=0 unverified=0 tracked=17 new=0 skips=15
ISOLATION_SELFTEST cases=21 passed=21
```

`skipped=15` is the honest reading, not a failure: `inv23` needs Next.js `api/**/route.*` files, `inv25` /
`inv27` / `inv28` need the project facts they compare against (`softDelete.tables`, `build.command`,
`rateLimit.patterns`), `aq09` needs a declared unique-write entry, the eight `mp*` guards need a
mini-program root (`app.json`), `spec-abs` needs `spec.docs`, and `iso01` only applies when the engine is
vendored inside the audited root. `unverified=0` means the baseline keys all belong to guards that ran this
round — a partial run reports them as `unverified` instead of pretending they improved. A guard that cannot
see its subject says so and does **not** report "0 findings".

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
| `npx autoqe run --root .` | Run all guards against the target repository. With `--config <file>`, identity, ratchet and reports stay beside that config, so a project in another folder can be audited without receiving any files |
| `npx autoqe multi --roots a,b [--command run\|scan\|report\|triage\|status\|doctor]` | Scan/fix several projects at once: **one child process per project** (cwd = that project, every `AUTOQE_*` / `QE_*` env var stripped by default). Fails as a whole if any project fails **or if isolation cannot be proven** (child reports another root / output mentions another project's path). `--inherit-env` keeps the caller's environment as-is |
| `npx autoqe explain INV-CORE-01` | Explain one invariant or guard (`inv28`, `qe:guard:inv28` also work); `--json` for machines |
| `npx autoqe prompt audit\|fix\|review` | Print a paste-ready AI prompt with the current readings embedded |
| `npx autoqe report --root .` | Write the Markdown report into the target repository |
| `npx autoqe list [--json]` | List invariants with status, guard and statement |
| `npx autoqe ratchet-update --root .` | Freeze the current counts as the baseline. Refuses (`RATCHET_REFUSE`) when this round did not run every guard whose keys are in the baseline — otherwise untested debt would be erased. `--force` is the explicit "discard those records" override |
| `npx autoqe selftest` | Bad-sample verification (counter-proof) |
| `npm run qe` | All guards + ratchet comparison (non-zero exit on regression) |
| `npm run qe:selftest` | Bad-sample verification |
| `npm run qe:report` | Generate the Markdown report |
| `npm run qe:triage` | Generate the fix / decide / record disposition list |
| `npm run test:triage` | Policy self-check: every emitted finding code has a disposition; unknown codes never auto-waive |
| `npm run test:isolation` | Cross-project isolation counter-proofs (two trees, one process, parallel + `multi`) |
| `npm run test:oracle` | Oracle self-check: every rule has a truth source; `human`-tier judgments may not emit errors |
| `npm run qe:list` | Show the registry and its gaps |
| `npm run qe:guard:invNN` | Run a single guard (`inv01`…`inv28`; the registry keeps only the ids that carry a judgment) |
| `npm run qe:guard:aqNN` | Run a single rule scanner (`aq01`…`aq14`) |
| `npm run qe:guard:mpNN` | Run a single mini-program guard (`mp01`…`mp08`) |
| `npm run qe:ratchet:update` | Tighten the baseline after a deliberate decision (same coverage refusal as the CLI) |
| `npm run qe:ci` | typecheck + invariants + skills + triage self-check + isolation + spec + oracle + report |
| `npm run typecheck` | Type-check the toolkit (`tsconfig.qe.json`) |

## Mini-program (WeChat) support

Mini-program defects have a property that ordinary static checks miss: **almost none of them throw.**
The build passes, lint passes, the DevTools renders the page you just created, and the bug only shows up on a
real device as "the styling vanished", "the tap did nothing", or "the panel is blank". The eight `mp*` guards
target exactly that class — each one names a **precondition that lives outside the line of code that looks
wrong**:

| Guard | Invariant | What it actually asks |
|---|---|---|
| `mp01` | INV-MP-01 | The timer callback will run *some time later* — will the page still be alive when it does? (`clearInterval` cannot cancel a callback already in the event queue) |
| `mp02` | INV-MP-02 | A class used inside a component must be defined **in that component's own style scope** — global styles do not enter an `isolated` component |
| `mp03` | INV-MP-03 | `setData` before the first render never lands (`Expected updated data but get first rendering data`) |
| `mp04` | INV-MP-04 | A back navigation that lands on a stack of depth 1 fails **silently** — no throw, no message |
| `mp05` | INV-MP-05 | A page that isn't in `app.json` opens fine in DevTools and always fails on a real device |
| `mp06` | INV-MP-06 | The path is registered and the call compiles — but the page is a **tabBar** page, so `navigateTo` fails on device (`switchTab` is the same trap in reverse) |
| `mp07` | INV-MP-07 | A network / Promise / `await` continuation writes the view: if the page died in that gap, the write lands on a destroyed instance (warn level — the *absence* of a liveness check is what is provable) |
| `mp08` | INV-MP-08 | A class name in the template that **nobody defines in the component's scope** — a one-letter typo, or styles left behind in a page's wxss (warn level) |

`mp01` and `mp03` resolve the receiver **alias** (`const that = this`, `var _this = this`, `let self = this`),
because that idiom is the norm in ES5-era pages and in `wx.request` callbacks. A judgement that only matches the
literal `this` reports **green** on those pages — that is a false negative, not a clean bill of health. The
liveness short-circuit is resolved through the alias too, so an existing `if (!that.alive) return` is not
re-flagged as a defect.

```bash
npx autoqe run --root /path/to/your-miniprogram-repo \
  --config qe.config.miniprogram.json --only mp01
```

The preset (`qe.config.miniprogram.json`) sets `source.extensions` to `["js","ts"]` on purpose: `.wxml` /
`.wxss` are **read on demand** by the guards (they are siblings of the file being analysed), never walked as
source. Scanning templates as scripts would feed every other guard a pile of false positives.

Two things the preset will not do for you:

- **Point `source.roots` at your source directory** (default `miniprogram`). If the project root *is* the
  mini-program root, use `["."]`.
- **Declare `rules.mp*.mpRoots`** only when the project marker (`app.json`) sits somewhere unusual. Without a
  marker the guards report `skipped` with the list of paths they tried — never a silent green.

What they cannot see is written into each guard's `blindSpots` and printed by `npx autoqe explain mp01`:
dynamically built routes, callbacks passed as externally imported references, JS query-anchor classes, and any
lifecycle indirection through `behaviors`. Those stay on the human checklist.

## Repository layout

```text
.
├── QE-00-index.md                 # Documentation entry point (EN)
├── QE-01…QE-09                    # Method + stack-specific playbooks (EN, Chinese summary at top)
├── docs/zh-CN/                    # Full Chinese editions (archive)
├── AGENTS.md                      # Working protocol for coding agents
├── qe/
│   ├── cli.ts                     # init / doctor / status / scan / run / explain / prompt / report / list / skills / selftest / ratchet-update
│   ├── guards/                    # One file per guard (schema/AST-based)
│   ├── rules/                     # Pure-function judgments + inline counter-examples
│   ├── skills/                    # Accident knowledge base (why each rule exists)
│   ├── probe/                     # Runtime probes (not wired into `run` — they need a live app)
│   ├── lib/                       # Config, providers, AST utils, ratchet, rule→guard adapter
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
| `inv23` | Entry coverage | A mutating endpoint with no real UI send point — annotated comments, e2e scripts and the route file itself do not count as entry | INV-WEB-07 |
| `inv24` | Committable assertions | A config-declared assertion target that is missing, git-ignored, or untracked (green here, red in a clean checkout) | INV-META-03 |
| `inv25` | Soft-delete read | Reads of a declared soft-delete table without the soft-delete predicate (list / count / export / trend) | INV-CORE-05 |
| `inv26` | Error catalog | Registered codes nobody throws (ghost) and thrown codes nobody registered (wild) | INV-CORE-10 |
| `inv27` | Clean checkout | HEAD cannot build in a throwaway `git worktree` because the build leans on uncommitted local files | INV-CORE-14 |
| `inv28` | Rate / size limits | A mutating endpoint file with no registered limiter or body-limit shape (candidate, `warn`; a gateway outside the file is out of scope) | INV-SEC-02 |
| `aq01` | Bare body parse | `request.json()` reaching business code without a 4xx cover | INV-WEB-05 |
| `aq02` | Status literal | `status === 'X'` copies of a state machine (ratchet, `warn`) | INV-CORE-04 |
| `aq03` | Swallowed error | Empty `catch`, or `catch` that only logs | INV-CORE-17 |
| `aq04` | Check-then-act | read → null-check → create, when the table has no unique key | INV-CORE-12, INV-DB-01/02 |
| `aq05` | Raw SQL scope | Hand-written SQL without a tenant predicate, or `Unsafe` with interpolation | INV-CORE-08 |
| `aq06` | Route auth | Route handlers with no auth call (structural detection, not a name list) | INV-WEB-06 |
| `aq07` | Fake green | Assertions that can never fail (7 shapes) | INV-CORE-18 |
| `aq08` | IDOR | `findUnique({ where: { id } })` fed from the request, no ownership predicate | INV-SEC-03 |
| `aq09` | Dedupe key | Writes with no idempotency key on a table the caller declares as unique-write | INV-DB-03 |
| `aq10` | Reading shape | SQL whose result object cannot match the field names the caller reads | INV-CORE-19 |
| `aq11` | Tool path | Tool/script paths resolved against the CWD or a hardcoded absolute prefix | INV-CORE-20 |
| `aq12` | Mock reachable | Production code importing mock/seed/fixture modules, outside a dev gate | INV-RES-01 |
| `aq13` | Hardcoded data | A rendered object array with no fetch anywhere in the file (candidate, `warn`) | INV-RES-02 |
| `aq14` | Tx-scoped fallback | Unique-conflict fallback (read-back / idempotent return) written *inside* the `$transaction` callback — aborted tx | INV-DB-04 |
| `spec` | Spec reconciliation | Models/fields/endpoints promised by docs but never implemented (candidate by default) | INV-SPEC-01 |
| `leak` | Project-info leak | Local absolute paths, credential shapes, industry vocabulary, denylisted codewords — in file bodies, commit messages **and** the git index (state/report/export files must never be tracked) | INV-META-01 |

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

Newer guards compare against **project facts**, so they declare their own sections. The rule is the same
for all of them: undeclared ⇒ explicit `skipped`, never green.

```json
{
  "coverage": {
    "uiCorpora": [{ "name": "admin-ui", "roots": ["src/app", "src/components"], "reason": "where users click" }],
    "requestCallAdditions": [{ "pattern": "apiJson<", "reason": "house API client" }],
    "dynamicTail": [{ "endpoint": "/api/items/${id}/${action}", "evidence": "src/app/items/actions.ts", "reason": "tail is a variable" }],
    "knownNoEntry": [{ "route": "/api/x", "reason": "server-only, no UI planned", "reviewBy": "2026-12-31" }],
    "externalPrefixes": [{ "prefix": "/api/webhook/", "reason": "third-party callback" }]
  },
  "softDelete": { "tables": ["Order"], "column": "deletedAt" },
  "errors": { "throwPattern": "throw new AppError\\('([A-Z_]+)'" },
  "build": { "command": "npm run build" },
  "rateLimit": { "patterns": ["rateLimit(", "withLimiter"] }
}
```

- `coverage` (`inv23`): the UI-side send points. `dynamicTail.evidence` and `knownNoEntry` are **evidence, not
  waivers** — an entry that a UI can now statically reach is red (stale registration).
- `softDelete` (`inv25`): table + column. If one middleware injects the filter everywhere, say so with
  `softDelete.middleware.reason` (the reason is mandatory; an empty one is just a waiver slot).
- `errors` (`inv26`): the catalog itself lives in `contracts.errorCatalog`; `errors.throwPattern` is the
  repository's throw shape (one capture group = the code) and enables the reverse direction. Without it the
  reverse scan is explicitly unchecked (`info`), not silently green.
- `build` (`inv27`): the build command executed inside a throwaway `git worktree`. It proves "builds from a
  clean checkout **on this machine**"; CI runs the same command for cross-machine consistency.
- `rateLimit` (`inv28`): registered limiter / body-limit shapes, matched as substrings in route files. This
  guard emits **candidates only** — a gateway in front of the app is outside its scope by construction.

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
3. Run `npm run qe:selftest` (expect 393/393), then `npm run qe` for the first real reading.
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

No secrets, credentials, customer data, or internal business specifications belong in this repository.
Internal business specifications are excluded via `.gitignore` and are not part of the public package.
Reports in `qe-report/` and audit workspaces in `qe-audit/` are local artifacts and are ignored.

This is enforced, not promised — `leak-project-info` (INV-META-01) fails the build on:

- local absolute paths (`C://Users//…`, `/Users/…`) — they leak account names and directory layout;
- credential shapes (API keys, tokens, private-key blocks, connection strings with a password);
- industry business vocabulary — examples must use neutral entities (`request` / `asset` / `record`)
  instead of any one vertical's nouns (the built-in list is retail/trade; extend it via the denylist
  for other industries, or switch it off with `leak.domainVocab: false`);
- project codewords listed in a **denylist that lives outside this repository**.

The denylist is external by design: writing `forbidden: project-a` into the repo would register that
name in plaintext. Point at it with an environment variable so the file never enters version control:

```bash
AUTOQE_DENYLIST=/path/to/leak-denylist.txt npx autoqe run --only leak --root .
# one term per line; `term => replacement hint` is also accepted; `#` starts a comment
```

With no denylist configured the guard says so (`DENYLIST_EMPTY`, a warning) instead of reporting a
comfortable zero: it verified the three structural classes, not the codewords.

The path / credential / codeword checks also run over **commit messages** (`git log`); the industry
vocabulary check is file-only, since history is immutable and the rule governs shipped examples, not
historical wording.
The second one is the unrecoverable one — a codeword in a commit message is not in any file, and
deleting the file later does not remove it from history. The reading distinguishes three states on purpose:

| Situation | Reading | Why |
|---|---|---|
| not a git tree / not the repo root / empty repo | `COMMITS_NONE` (info) | there genuinely are no commits in scope — an empty set, not an unchecked one |
| a repo, but `git log` failed | `COMMITS_NOT_SCANNED` (warn) | **no conclusion** — must not be mistaken for clean |
| scanned | `scanned=… commits=N commitLines=M` | the count is part of the reading, so 0 findings has a denominator |

### Data must not enter the index (second layer)

`.gitignore` only hides **untracked** files. One `git add -f`, or a `.gitignore` edited around, and the
report is in the index — and once committed it is in history for everyone who clones. So the guard also
runs `git ls-files` and fails on any of these reaching the index:

| Reading | Meaning |
|---|---|
| `TRACKED_STATE_FILE` (error) | A report / audit workspace / one-off export / state identity (`qe.project.json`) / waiver / runtime contracts / local denylist / `.env` / log / local database file is tracked. `.gitignore` cannot save it at this point |
| `INDEX_NOT_SCANNED` (warn) | `git ls-files` failed — this plane has **no conclusion**, it is not clean |
| `scanned=… index=N trackedState=0` | The index was read and the count is part of the reading, so a zero has a denominator |

The boundary is **data vs knowledge**, not "everything generated":

| Kind | Examples | Policy |
|---|---|---|
| Data (per-project, per-machine) | `qe-report/`, `qe-audit/`, `reports/`, `scan-*.txt`, `triage-*.txt`, `qe.project.json`, `qe.waivers.json`, `qe.contracts.json` at the state root, `denylist.local.txt`, `.env*`, `*.log`, `*.db` | ignored **and** refused if tracked; demo/fixture copies of the same names are fine |
| Knowledge (reusable across projects) | `qe/rules/`, `qe/skills/`, `qe/ledger/incidents.json`, `qe/ratchet.json` for the engine itself | tracked and reviewed — this is what the toolkit is for |

### Public history

This repository's public history is a **single squashed snapshot**; earlier revisions are not preserved.
Commits use a `noreply` author address, so the published history carries no real email. If you fork it and
contribute back, keep the same discipline: no project data in commits, no project names in commit messages.

## 中文说明

AutoQe 是「不变量优先」的质量工程工具箱：把缺陷拦在设计层，而不是靠用例枚举。内置 56 条不变量
（23 条 enforced / 30 条 partial / 3 条 open）、40 个静态扫描器（15 个 schema/AST/入口/构建守卫 +
14 条 AQ 规则 + 8 条小程序规则 + 规格对账 + 泄漏审计 + 内置引擎隔离）、22 条纯函数规则与 42 条事故知识库、
393 个坏样本自证，以及只降不升的 ratchet 基线，并提供一套通用的项目体检与上线判定作业单。

本轮新增的能力：

- **棘轮覆盖语义**：只跑部分守卫时，未跑的基线键落进 `unverified`，绝不算「已改善」；
  `ratchet-update` 在未跑全时拒绝写入（`RATCHET_REFUSE`），要丢弃记录必须显式 `--force`；
  `status` 增加第五态 `INSUFFICIENT-COVERAGE`。
- **入口五通道**：`package.json` 别名、编排 `.sh` 引用、import（含纯副作用 import）、
  `join()` 拼接后喂子进程、runner 发现制；且只认 git 跟踪文件。`inv13` 的 registry 面与
  addressable 面已拆开，审计未内置 `qe/` 的仓库不再误报。
- **新增 6 条守卫**：`inv23` 界面入口覆盖、`inv24` 断言对象必须是可提交物、`inv25` 软删读点谓词、
  `inv26` 错误码册 ↔ 抛错点、`inv27` HEAD 干净检出可构建、`inv28` 变更型入口速率/体积上限（仅候选）。
- **跳过进棘轮**：把一类对象判成「不适用」会留下 `<guard>:SKIP:<code>` 键，射程缩小不再无声无息。
- **泄漏索引面**：除文件正文与提交信息外，还扫 `git ls-files`——`.gitignore` 只挡未跟踪文件，
  一次 `git add -f` 后数据文件进索引即红（`TRACKED_STATE_FILE`）。
- **自测级别上限**：夹具支持 `maxErrors` / `maxWarnings` / `maxInfos`，坏样本不会因为「级别不对但数量多」混过去。
- **外部状态模式**：`--config` 让身份、基线与报告落在配置文件旁（`stateRoot`），被审计仓与引擎目录都不落文件；
  同一份状态换 root 复用直接拒绝（`QE_ISOLATION_FOREIGN_ROOT`）。

数据与经验的边界固定为：报告、审计工作区、一次性导出、状态身份、豁免与黑名单是**数据**
（忽略，且进索引即红）；`qe/rules/`、`qe/skills/`、`qe/ledger/incidents.json` 是**经验**（保留跟踪）。
规则层（`qe/rules/`）是纯函数，反证与判据写在同一个文件里；知识库（`qe/skills/`）记录每条规则是哪次真实
事故泛化来的，`npx autoqe skills --checklist` 直接生成立项审计清单。
它适合作为**外部体检清单**引入已有项目，**不替代**项目原有的守卫体系；内置 Prisma schema 与 TypeScript AST
适配器，其他技术栈通过适配器接入。两种用法：`npx autoqe init` 后跑 `npx autoqe run --root .`；或把 `qe/`
复制进项目后用 `npm run qe`。许可证：MIT。

## License

MIT — see [LICENSE](LICENSE).
