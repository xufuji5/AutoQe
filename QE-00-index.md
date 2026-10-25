# QE-00 · Document Index and Reading Order

> This file is the only entry point into the documentation system. The **single source of truth for invariant entries** remains [`qe/registry/registry.ts`](qe/registry/registry.ts); the **single source of truth for readings** is the command output (`GUARD_SUMMARY` / `QE_RESULT` / `RATCHET`). Documents carry method, vocabulary, and pointers only.

> Full Chinese editions: `docs/zh-CN/` (QE-04 excluded — contains internal case histories).

## 0. Positioning: an external audit sheet, not an upgrade kit

This package answers "what should a repository without a guard system check at a minimum", **not** "every repository should be swapped onto this guard system". When adopting it, keep three rules:

1. **Do not replace.** If the host project already has stricter guards or processes, keep them as they are; this package only adds the problems it **did not think of**, never a wholesale replacement.
2. **Take the questions, not the shape.** What you actually carry away is "which gaps got asked about". The source tool's finding codes, `Finding[]` structure, and report layout are not imported into the host project.
3. **Re-verify on the host project's own carriers.** Every absorbed item must land as a criterion in the host project's own guards, tests, or processes, and must yield one re-checkable reading (`GUARD_SUMMARY`, a test assertion, or a ledger row).

> Self-check reading (reference implementation, current): 27 invariants, enforced 10 / partial 5 / open 12. The **44.4% open rate is this package's own admitted weakness, not the host project's status**. Before auditing with this package, run `npm run qe:list` to see which entries apply to that project, then talk about absorption.
> Absorption plan template: [`qe/templates/project-audit/05-gap-absorption-plan.md`](qe/templates/project-audit/05-gap-absorption-plan.md).

## 1. Numbering rules

**The only rule: the root directory holds only the `QE-XX` series and `AGENTS.md`; project-specific business-domain documents are kept separate and never interleaved with the QE series.**

| Number | Meaning | Included in the copy package |
|---|---|---|
| `QE-00` | Master index (this file) | Yes |
| `QE-01` ~ `QE-05` | Method layer: philosophy / mechanism / general audit / audit methodology / invariant specification | Yes |
| `QE-06` ~ `QE-09` | Stack-specific criteria: Next.js boundaries / Prisma concurrency / adversarial input / Zustand | Yes |

> Business-domain specifications are project-specific: they keep whatever numbering the host project already uses and are **not** shipped in this package. Their numbering is often referenced across repositories, so renumbering them would break links; keeping them physically separate from the QE series avoids visual confusion.

**Old number → new number**

| Old location | New location |
|---|---|
| `AI编程质量控制手册-v1.0.md` | `QE-01-quality-philosophy.md` |
| `docs/50-机制化质量-ratchet与AI分模块协作.md` | `QE-02-mechanized-quality.md` |
| (new) | `QE-03-project-audit-and-release-gate.md` |
| `58-审计方法论.md` | `QE-04-audit-methodology.md` |
| `61-不变量规范.md` | `QE-05-invariant-spec.md` |
| `docs/10-Next.js服务端边界与模块接缝.md` / `QE-10-…` | `QE-06-nextjs-boundary-and-seams.md` |
| `docs/20-Prisma-PostgreSQL并发与约束.md` / `QE-11-…` | `QE-07-prisma-postgresql-concurrency.md` |
| `docs/30-对抗与恶意输入.md` / `QE-12-…` | `QE-08-adversarial-input.md` |
| `docs/40-Zustand前端状态.md` / `QE-13-…` | `QE-09-zustand-state.md` |
| `00-文档总索引.md` | `QE-00-index.md` |

## 2. Full catalog and when to read it

| Number | File | Role | When to read | Machine criteria |
|---|---|---|---|---|
| QE-00 | This file | Index / division of labor / reading order | First time entering | — |
| QE-01 | [QE-01-quality-philosophy](QE-01-quality-philosophy.md) | Quality worldview, five collaboration protocols, constraint density | Before work starts, team alignment | — |
| QE-02 | [QE-02-mechanized-quality](QE-02-mechanized-quality.md) | Ratchet, defect classification, AI module-by-module protocol | Start of each iteration / adding a guard | inv13, ratchet |
| QE-03 | [QE-03-project-audit-and-release-gate](QE-03-project-audit-and-release-gate.md) | **General audit work sheet**: turn an existing project into a bug baseline plus a release verdict | Taking over any existing project / before release | Works with all guards |
| QE-04 | [QE-04-audit-methodology](QE-04-audit-methodology.md) | Nine root-cause classes, origin of the audit and ratchet mechanisms | Defect classification / retrospectives | — |
| QE-05 | [QE-05-invariant-spec](QE-05-invariant-spec.md) | Invariant three-state model, layers, single-source discipline | Adding / adjudicating invariants | — |
| QE-06 | [QE-06-nextjs-boundary-and-seams](QE-06-nextjs-boundary-and-seams.md) | Entry auth / validation / idempotency, client-side boundary bypass, cross-module deep imports | Writing route handlers / server actions / module boundaries | inv20, inv21 |
| QE-07 | [QE-07-prisma-postgresql-concurrency](QE-07-prisma-postgresql-concurrency.md) | Unique constraints, transactions, optimistic locking, idempotency, migrations | Changing schema / writing concurrent paths | inv01, inv02, inv03 |
| QE-08 | [QE-08-adversarial-input](QE-08-adversarial-input.md) | Threat model, four boundaries, resource ceilings, output redaction | External interfaces / security review | inv20, inv21, inv22 |
| QE-09 | [QE-09-zustand-state](QE-09-zustand-state.md) | Persist boundaries, version migration, state responsibility | Adding a store / persistence | inv22 |
| AGENTS | [AGENTS.md](AGENTS.md) | Coding-agent working protocol (mandatory) | Every time work starts | All |

**Business-domain documents (not copied, numbering kept as-is in the host project)**

The reference implementation also carries project-specific specs for schema/API/frontend-state/database conventions, high-concurrency and async jobs, back-office operations, agent access, and cross-system data. They are not part of this package. The host project should keep its own equivalents, link them from its own index, and treat them as out of scope here.

## 3. Three reading paths

**A. Connecting a repository for the first time**
`AGENTS.md` → `QE-01` → `QE-02` → `QE-03` (run the audit) → `QE-06~09` (pick by stack) → the corresponding domain docs.

**B. Taking over an existing project that must ship soon**
`QE-03` is the main work sheet: establish a factual baseline, run the quick scan, dig into the seven main lines, then walk the release gate.
Jump to `QE-06~09` for stack-specific questions; use `QE-04` for defect classification; use `QE-05` for invariant status.

**C. Daily iteration, adding a module**
The four pre-work checklists in `AGENTS.md` → the ratchet and module protocol in `QE-02` → the guards matching the change type → `npm run qe:ci`.

## 4. Single-source discipline (drift prevention)

1. Invariant entries live only in `qe/registry/registry.ts`; entry content appearing in a document counts as drift.
2. The nine defect-class terms live only in `QE-04` §1; this index only references them.
3. The three-state semantics of invariants live only in `QE-05`; this index only references them.
4. For batch-job coding discipline (idempotency / atomicity triad): if the host project has no equivalent high-concurrency spec, follow `QE-07` §3.
5. A report is a dated snapshot; the command output is the source of truth.

## 5. Common commands

```bash
npm run qe                  # all guards + ratchet (exit code 1 when red)
npm run qe:selftest        # bad-sample counter-proof (19 cases)
npm run qe:report          # generate qe-report/qe-report.md
npm run qe:list            # registry three-state and gaps
npm run qe:guard:inv20     # server-side boundary
npm run qe:guard:inv21     # client/server seam
npm run qe:guard:inv22     # Zustand persist
npm run qe:ratchet:update  # tighten the baseline after human adjudication
npm run qe:ci              # commit gate
```

## 6. "Done" declaration template

> Change: <one sentence>
> Invariants: <INV-ID violated / added>
> Guard reading: `GUARD_SUMMARY id=… status=…` or `QE_RESULT …`
> Baseline: `RATCHET status=ok regressions=0`
> Bad sample: `SELFTEST guard=… case=… expect=red … PASS`
> Not yet committed: <mark as "scheduled", never as done>

> The legacy entry link (`README §6`) points to section 6 of this file.

## 7. Copying into other projects (QE copy package)

### 7.1 Copy checklist

| Category | Files / directories | Notes |
|---|---|---|
| **Required (method layer)** | `QE-00-index.md`, `QE-01` ~ `QE-09` | The body of the package: index + method layer + stack-specific criteria, with a continuous numbering and no gaps |
| **Optional (automation)** | `qe/`, `qe.config.json`, the `qe:*` scripts in `package.json`, `tsconfig.qe.json`, `.github/workflows/qe.yml` | You can audit manually per QE-03 without them; `tsconfig.qe.json` is standalone, **do not overwrite the host project's tsconfig** |
| **Merge (do not overwrite)** | `AGENTS.md` | If the host project already has collaboration rules, merge only "five protocols / construction guard table / gates / forbidden actions" |
| **Do not copy** | project-specific business-domain specs, `qe/demo/`, `qe-report/`, `qe-audit/` | Business-domain specs belong to the host project; demo and historical reports pollute readings |
| **Baseline** | `qe/ratchet.json` | Generated by the host project's first `qe:ratchet:update`; **do not copy this package's baseline** |

> **Directory constraint**: `QE-00` ~ `QE-09` and `qe/` must sit **at the same level, in the host project's root** (as in the reference implementation), otherwise the relative `qe/...` links in the documents break. If the host project insists on `docs/quality/`, prefix every link with `../../` after copying.

### 7.2 Landing in the host project (once per project)

1. Copy the "required + optional" items from 7.1 into the host project root; handle `AGENTS.md` by merging.
2. Edit `qe.config.json`: `schema.path`, `source.roots`, `boundaries.publicRoutes`, `stores.moduleRoots/sensitiveKeys`, `ignore`.
3. `npm run qe:selftest` (expect 19/19) → `npm run qe` (first real reading) → adjudicate existing red items → `npm run qe:ratchet:update`.
4. Create the audit workspace: copy `qe/templates/project-audit/` to `qe-audit/<project>-<date>/`.
5. Run S0→S4 per `QE-03`, and write the results into the workspace's five files (baseline / entry inventory / scan log / bug ledger / release verdict).
6. When the verdict is "not releasable", the P0 ledger becomes the input for the next fix batch; after fixing, rerun `npm run qe:ci`, re-verify, and update the ledger.
7. If the audit brings in an external checklist, fill in `05-gap-absorption-plan.md` (the problem in its original wording + applicability + own carrier + acceptance reading); mark stricter existing guards as "already have" and do not replace them.
8. Archiving: `qe-audit/` keeps conclusions and evidence only; never commit build artifacts, raw logs, or keys.

### 7.3 Fixed artifacts of a per-project audit

```text
qe-audit/
  <project>-<YYYY-MM-DD>/
    00-fact-baseline.md          # build/startup/migration/env vars/total entry points
    01-entry-inventory.md        # routes/actions/queues/webhooks/scripts
    02-scan-log.md               # 15-item quick scan + seven-line deep dive
    03-bug-ledger.md             # P0–P3 + evidence level + fix/re-verification
    04-release-decision.md       # 12 gates + verdict + rollback plan
    05-gap-absorption-plan.md    # filled when an external checklist is adopted: verbatim problem / applicability / own carrier / reading
```

Templates live in `qe/templates/project-audit/`. The first five files must all be present before any release verdict is allowed; the sixth is required only when an external checklist is adopted.

### 7.4 Boundaries when several projects run in parallel

- Each project has its own `qe.config.json` and `qe/ratchet.json`; never share one baseline.
- The method layer is shared (upgrade by replacing the whole `QE-*` set); business-domain docs are maintained per project.
- An audit report states only "facts about this project". Defects common to several projects are promoted into the nine classes of `QE-04` or into registry entries, not copied into every report.

---

**中文摘要**：QE 文档体系的唯一入口：编号规则、全量目录、三条阅读路径与可复制包清单。
