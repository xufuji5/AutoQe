# AGENTS.md — AI Coding Quality Collaboration Protocol (mandatory in this repository)

> This file is a working protocol for coding agents, not background reading.
> Acceptance rule: **every "done" an AI claims must be addressable** (a commit, a guard reading, or a ledger row — at least one). The word "done" alone is not evidence.
> Documentation entry point: [`QE-00-index.md`](QE-00-index.md); stack-specific criteria: `QE-06`–`QE-09`; general project audit and release decision: `QE-03`. Documents carry method and pointers only; the single source of invariant entries remains [`qe/registry/registry.ts`](qe/registry/registry.ts).

## 0. In one sentence

Quality = constraint density: **invariants > test cases**. A test case asks "is this path correct?"; an invariant asks "does this hold always?".
Tests enumerate; AI defects are structural, and enumeration never catches up with structure. So: establish constraints first, write business logic second, run tests last.

## 1. Five collaboration protocols

1. **AI fills the middle; never touch the boundaries.** Schema, contracts, enums, error codes, and state machines are generated from a single source; the AI writes only the middle business logic. If a boundary is still handwritten, build the boundary generator first.
2. **List "where it can fail silently" before writing any code.** Before starting a feature, list the points that could fail silently / produce false green / have no provenance (at least 3), then implement.
3. **Bad samples are injected by the reconciler.** AI self-test results are not accepted on their own; a guard must turn red on an independently constructed bad sample.
4. **Fixed acceptance order**: invariant lookup (which INV is violated?) → guards → e2e → human spot check. Lookup first (seconds), tests later (minutes).
5. **Done claims are addressable**: a commit, a `GUARD_SUMMARY` reading, or a ledger row — at least one.

## 2. Before work starts (no checklist, no start)

- [ ] Intake form with all five questions answered: which INV is violated / which INV is added / at which layer it is blocked (L0–L5) / any irreversible action / what the counterexample is
- [ ] Silent-failure list (≥3 items, each stating *how* it fails silently)
- [ ] Blast-radius list: tables / columns / enum values / contract keys / gates and their UI controls
- [ ] **Seam list**: who calls this module, what it calls, what the public entry (`index.ts`) is, which path cross-module imports take
- Template: `qe/templates/intake.md`

## 3. During construction (change type → guards that must run)

| Change / 改动 | Required action / 必做 | Guard / 守卫 |
|---|---|---|
| Add or modify a column / 新增或修改列 | Name the writer function; or drop the column | `inv01` (zero-write column / 零写列) |
| Add a read site / 新增读点 | Confirm `select`/`where` coverage, or declare `/// @archive` | `inv02` (zero-read column / 零读列) |
| Add an enum value / 新增枚举值 | Document the production path (which write site, under what condition) | `inv03` (dead enum / 死枚举) |
| Add a promise sentence / 新增承诺句 (spec, comment, UI copy) | Register it in `qe.contracts.json` + add a throw site | `inv06` (ghost rule / 幽灵规则) |
| Add a gate or rejection sentence / 新增闸或拒收句 | Register the gate: server-side criterion + UI control | `inv07` (idle gate / 空转闸) |
| Add a server entry (route handler / server action) / 新增服务端入口 | Auth + schema validation; mutation entries carry an idempotency key; public routes need a written reason | `inv20` (server boundary / 服务端边界) |
| Add a client file or cross-module import / 新增客户端文件或跨模块导入 | No Prisma / node / server-only imports; cross-module imports go through the public entry | `inv21` (seams / 接缝) |
| Add Zustand persist / 新增 Zustand persist | `partialize` allowlist + `version`; sensitive keys never persisted | `inv22` (frontend state / 前端状态) |
| Add a guard / 新增守卫 | Registry entry + `package.json` alias + bad sample | `inv13` (addressable / 可寻址) |

Discipline: **red before green** (a new guard must turn red on a bad sample on day one); **adjudicate before building** (spec wrong → fix the spec; code wrong → fix the code; "both are right" is forbidden); **only tighten** (count baselines in `qe/ratchet.json` may only shrink; new violations must never enter the baseline).

## 4. Commit / release gate

```bash
npm run qe:ci      # typecheck + bad-sample counter-proof + guards + report
npm run qe         # guards + ratchet diff (claim "only tightened" only when RATCHET status=ok)
```

- Readings live in `qe-report/qe-report.md` (the command is the source of truth; the report is just a dated snapshot).
- Classify every red item: introduced by this batch / pre-existing / parallel batch (do not fix another batch's items, but state clearly who owns them).
- Anything not committed is marked "scheduled", never "done".
- Baseline changes go only through `npm run qe:ratchet:update`, with "key / old value / new value / reason" in the commit message.

## 5. Prohibited actions (all of these have happened)

- Skipping hooks with `--no-verify`; stuffing new violations into the baseline (D6: the ratchet may only shrink)
- Marking an entry `enforced` without a criterion; writing `open` without a reason or a review trigger (no record = red)
- Maintaining a second invariant list in documentation (entries have a single source: `qe/registry/registry.ts`)
- Putting environment- or time-sensitive readings into CI assertions (D7)
- Reporting green when a guard scanned 0 objects (D1: an empty set is vacuously true = false green)

## 6. Adopting into a real repository (three steps)

**CLI shortcut**: `cd <repo> && npx autoqe init && npx autoqe run --root .` — nothing is copied except documents,
templates and `qe.config.json`; guards stay in the npm package. The steps below describe vendored adoption.

1. Follow [`QE-00-index.md`](QE-00-index.md) §7 to copy the AutoQe adoption bundle: all method-layer documents `QE-00`–`QE-09` + `qe/` + `qe.config.json` + the `qe:*` scripts from `package.json` + `tsconfig.qe.json`. Merge `AGENTS.md`; never overwrite rules the target repository already has. Use `tsconfig.qe.json` as a separate file and do not overwrite the target's `tsconfig.json`. Do not copy `业务域/` (the host project's equivalent spec), `qe/ratchet.json`, `qe/demo/`, `qe-report/`, or `qe-audit/`.
2. Edit `qe.config.json`:
   - `schema.provider`: `prisma` (built in) or `none`; `schema.path` points at the schema file
   - `source.collector`: `ts` (built in) or `none`; `source.roots` / `source.extensions` point at the source tree
   - `boundaries`: auth/validation vocabulary, mutation methods, `publicRoutes` (every entry needs a reason)
   - `stores`: `moduleRoots` (module boundary directories), `sensitiveKeys` (fields that must never be persisted)
   - Everything else: `ignore`, `contracts`, `systemFields`, `fieldExemptions` (reason required)
3. Run `npm run qe:selftest` first (should be 19/19 green), then `npm run qe` to get the first real reading. Adjudicate pre-existing red items on direction; never hide them behind exemptions.
4. After the first adoption, run `npm run qe:ratchet:update` to freeze the baseline (only tightening is allowed afterwards).

**Adapter semantics**: when `provider=none` or `collector=none`, guards that depend on schema or source emit `status=skipped` (the batch turns yellow) — they never report green.
To switch stacks, implement a `SchemaProvider` or `CallCollector` (see [providers.ts](qe/lib/providers.ts)) and register it with one line in `registerSchemaProvider` / `registerCollector` in the same file; core guards stay untouched.
Only two adapters are built in — Prisma and TS. Add others as needed; do not pre-write "future adapters".

Environment: Node ≥ 22.18 (native TS type stripping, no build step), TypeScript 5.9, Prisma 5/6.

---

**中文摘要**：本文件是编码 Agent 的强制作业协议：五条协作协议、开工前四清单、改动→守卫表、双门禁与可寻址的完成声明。
