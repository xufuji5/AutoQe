# QE-05 · Invariant Specification (Invariant-First: Block Defects at the Design Layer)

> **Date**: first published 2026-10-22 ｜ **Position**: the single source of method for the invariant system (a living document; no version suffix)
> **In one sentence**: when a feature is proposed, answer "which invariant does this violate or add?" — not, after the code is written, "which tests should we add?"
>
> **Why it exists**: this document set already contains [QE-04 audit methodology](QE-04-audit-methodology.md) (how to **find** defects after the fact, across nine root-cause classes) and [QE-04 §5](QE-04-audit-methodology.md) (criterion-shape discipline D1–D12: how to write assertions that are not self-soothing). It did **not** contain a specification for how invariants are **defined**, which layer enforces them, and when they are retired. The consequences were immediate: criteria were invented batch by batch, their shapes diverged wildly (vacuous truth, decisions recorded but never executed, environment readings asserted in CI), and there was **no single source for the classification vocabulary** — an audit found a "reconciliation invariant (class thirteen)" registered while QE-04 defines only nine classes. Class thirteen had been invented out of thin air.
>
> **Division of labor with QE-04 (no copying between the two)**: this document owns the **front end** (designing defects out); QE-04 owns the **back end** (how a defect that already happened is classified and traced to its root cause). Both share the same classification table, with vocabulary single-sourced in QE-04 §1. **The item list is not written here**: the item single source is [`qe/registry/registry.ts`](qe/registry/registry.ts) (machine-readable, 27 entries); the human-readable mirror is the output of `npm run qe:list`.

---

## 1. Why invariants belong in the design spec (not the test spec)

The cost of handling a defect rises with the **layer at which it is found**, and that layer is **fixed at design time**:

| Layer | Where it blocks | What it catches | What it cannot catch | Carrier in this toolkit |
|---|---|---|---|---|
| L0 Type / schema | While writing code | Misspelled keys, missing fields, mixed types | Semantic errors, missing writers | TypeScript, `prisma/schema.prisma` |
| L1 DB constraints | At write time | Uniqueness, not-null, foreign keys, ranges | Cross-row identities, ordering | unique / partial unique / CHECK / FK in migrations |
| L2 Contract | At the call boundary | Request/response shape, error-code semantics | Internal state machines, concurrency | The target project's error-code module (e.g. `lib/apierror.ts`) |
| L3 Invariant criteria | At commit time (static scans / readings) | Whole-repo scans proving "a class of fact simply does not hold" | Runtime behavior, external systems | `qe/guards/*`, `npm run qe` |
| L4 Smoke / e2e | While running | Path behavior, races, cross-module timing | "Paths nobody has written" | The target project's e2e / smoke scripts |
| L5 Manual inspection | After release | Judgment, trade-offs, the outside world | A performer whose probability is zero | Runbooks, weekly audits |

Three hard rules:

1. **If it can be expressed at L1, never push it down to L3.** Database constraints are the only layer that *cannot* be violated — it does not depend on anyone remembering to run the gate. If you cannot write the L1 constraint, the design document must state why the constraint layer cannot express it; otherwise it counts as a design gap.
2. **If it can be expressed at L3, never leave it to L5.** Manual inspection is an executor with probability zero. A case from the reference implementation: dead-letter alerting read `status = 'failed'`, yet nothing anywhere in the codebase ever wrote that value; two operational channels sat empty for months, sustained by the belief that "someone will look".
3. **Once a layer is fixed, it must not drift with the implementation.** Writing the same fact as a check at L0/L1/L2 is drift (QE-04 class one). This specification designates where each check lives; a check written anywhere else is a copy.

---

## 2. What counts as an invariant (four admission criteria)

An invariant is not "an important rule"; it is a **universal proposition that can be mechanically judged true or false**. Miss any of the four and it does not enter the registry:

| # | Admission criterion | What it looks like when unmet |
|---|---|---|
| I1 | **Mechanically decidable**: either it can scan the source or it can query the database; if neither, it does not count | "The page should look good", "the code should be clean" |
| I2 | **Counterexample constructible**: you can name an input that necessarily violates it | "It should not fail" — if you cannot construct a counterexample, it has no content |
| I3 | **Implementation-independent**: it states a business fact, not how some function is written | "Must call `settle()`" — that is an implementation constraint that dies with the rewrite |
| I4 | **Violation has a business consequence**: you can say what breaks | "Fields should have comments" — nobody is harmed when it breaks |

**Four classes that are rejected outright**: style preferences / performance targets without a threshold ("make it fast" only qualifies once written as a P95 threshold) / one-off checks (an action performed once is a task, not an invariant) / soft statements built on "should" or "where possible".

A qualifying example: `Every column either has a writer or does not exist (there is no third state)` — universal, scannable, with a counterexample (add a column and never wire it) and a clear consequence (the column stays NULL forever and the read side is always empty).

---

## 3. From requirement to criterion (five review questions)

Any new feature, field, state, or entry point **must ship with answers to these five questions in its proposal** (failing to answer means the requirement is not thought through, not that the criteria are insufficient):

| # | Question | What to do when there is no answer |
|---|---|---|
| Q1 | Which existing invariants does this feature **violate**? (list INV IDs one by one) | Violation → change the design first; do not route around it with `open` |
| Q2 | Which invariant does it **add**? If none, why not? | No addition means either the feature has no constraints (most likely an oversight) or the constraints are hidden inside the implementation |
| Q3 | Which layer blocks it (L0–L5)? Why not a lower layer? | See the three hard rules in §1 |
| Q4 | Does it contain an **irreversible action**? | Yes → must follow §4; the design document gives readings and the undo action |
| Q5 | What is the **counterexample**? | Cannot write one → I2 fails, so this is not an invariant |

How to execute Q1: the 27 entries in `qe/registry/registry.ts` are the current full set. Read each `statement` and `defectClasses` and list the ones this change could break in the proposal. **This is a design action, not a check action** — doing it before writing code is a different thing from appending a "checklist" afterwards.

---

## 4. Irreversible actions and their design obligations (the hardest section of this spec)

"An action is irreversible" means **it cannot be repaired by code afterwards**. Five classes have been confirmed; each carries a design-time obligation:

| Class | Where it is irreversible | Required at design time |
|---|---|---|
| **Drop a column / table / change field semantics** | Columns can be re-added; data cannot. Changed semantics turn old data into a lie | ① a reading proving "the column is entirely empty and its table has rows" (an empty-table reading is not proof) ② confirmation that no consumer remains (including documents and assertions) ③ the five approval questions for the migration batch |
| **Data backfill** | A backfill can only sample "current values", and current values ≠ historical facts | Backfilled values are **fabricated**; they must be stored in a "snapshot column + collection timestamp" rather than overwriting the original field |
| **Reservation / freeze / materialized columns** | Materialization is copying, and undoing it has a window | **Both timings must be written down**: how long until the release takes effect and how long until the undo takes effect (the latter is a risk-control question, not a performance one); the column comment must state the dimensional semantics (which dimensions are included, whether entry-only) |
| **Outbound calls (SMS / push / payout)** | Once sent, it cannot be recalled | Idempotency key + revocable window + visible failure (failures must be recorded in the ledger, not merely logged) |
| **Migration chain** | An applied `migration.sql` cannot change by a single byte (P3008) | Every field change gets a newly hand-written migration; the object sets in the schema and the migration chain must have zero drift |

Criterion shape: every invariant that covers an irreversible action **must have a pre-action reading criterion** — whether the action may be performed is answered by readings, not by human memory. Reference implementation: the `decision` group of `test:invariants-columns` requires that any column scheduled for deletion has a reading showing that the column is entirely empty while its table has rows, and the `volume-gate` group requires every column awaiting adjudication to have a reading file. **A missing reading is itself red.**

---

## 5. Criterion-shape discipline (D1–D12)

The distance between "wrote a criterion" and "wrote an effective criterion" is where the reference implementation paid its tuition. Each of the twelve rules below carries its own case history. Evidence levels for assertions follow [QE-03 §4.1](QE-03-project-audit-and-release-gate.md) (E0 is only a lead and cannot justify a severity on its own), so they are not repeated here.

| # | Discipline | Case history / rationale |
|---|---|---|
| D1 | **No vacuous truth**: a criterion that holds on an empty set/table is false green; fixtures and preconditions must be asserted too | A smoke test asserting "zero-write columns = 0" on an empty table is always green |
| D2 | **Counterexample injection**: a new criterion must first run against the old implementation and be seen red | Widening a criterion's scope is itself a false-green entry point; any widening needs a counterexample fixture (e.g. "CREATE SCHEMA without DROP must still be red") |
| D3 | **Strip comments before static checks**: a hit inside a comment is not an implementation | A naive grep against a negative assertion gets fed green by its own comments |
| D4 | **Single source**: criteria, definitions, thresholds, copy, and comments exist in exactly one place; mirrors need a per-input comparison guard | A comment says "default true" while the migration uses NULL — comments are part of the single source too |
| D5 | **One guard prints exactly one `GUARD_SUMMARY` line**: business readings go to `GUARD_DETAIL` | Two lines make the summary count the same guard twice, after which no number can be trusted |
| D6 | **The ratchet only tightens**: new violations must not go straight into the baseline; fix or delete them | The baseline is a ledger of existing debt, not a waiver switch; "put it in the baseline" launders new debt into old debt |
| D7 | **Environment/time-sensitive readings never enter CI**: use aliases without the `test:` prefix | In-repo readings vary with the environment; writing the numbers into CI turns environment differences into false red |
| D8 | **Cleanup belongs in `finally`; exit via `exitCode`, not `process.exit()`** | `catch` does not cover fatal errors, and `process.exit()` skips `finally` |
| D9 | **Drop differential assertions when noise ≥ signal; keep observation** | Do not tune thresholds toward green — tuning a threshold makes the criterion adapt to the defect |
| D10 | **Every scope must declare its blind spot**: the criterion file header states what it cannot see | Without a declared blind spot, readers assume it covers everything |
| D11 | **Every decision has a deadline and every execution retires**: verdicts carry `decidedAt`/`dueBy`; overdue execution is red; once executed, remove it from the ledger | "There is a decision" was once treated as "it is handled"; `decision: 'delete'` could sit in the baseline forever while the gate stayed green |
| D12 | **Observer constraints: never throw / throttle / stable fingerprint; in-memory circuit breakers must leave a trace** | Observability code that throws drags the main flow down, which manufactures a new incident |

---

## 6. Lifecycle (three states + review + expiry)

An invariant is not "done once registered"; it has its own life cycle. **The state single source is the `status` field in `registry.ts`**:

| State | Meaning | Admission obligation |
|---|---|---|
| `enforced` | Has guards and sits inside the gate; a violation is red | Guard aliases must be addressable (the `addressable` group of `test:invariants`) |
| `partial` | Has guards, but the scope is incomplete | Must write `gap` (what is missing) and `next` (how to close it); "partially covered" alone is not acceptable |
| `open` | **Not currently enforceable** | Must write `openReason` (why it cannot be enforced / who can decide) + `revisitBy` (review date) |

Three hard rules:

1. **What cannot be enforced must not go invisible**: never delete such an entry merely because no criterion exists. An `open` entry with an account is not red; **no account is red** — this is the core criterion of `test:invariants`.
2. **Review window ≤ 90 days**: a `revisitBy` past its window must be reset, and the reset must leave a trace that a review actually happened (even a one-character change proves someone really read it).
3. **Status only upgrades on evidence**: `open → partial → enforced`, each step needs guard aliases; never flip to `enforced` because "we think it is close enough".

**Correct order for adding one**: register it in `registry.ts` first (even as `status: 'open'` with a reason) → then write the guard → finally change `status`. The reverse order turns "this rule exists" into a verbal fact.

---

## 7. Division of labor with other specs (preventing a second truth)

| Document | Owns | **Does not own** |
|---|---|---|
| **QE-05, this document** | Definition, admission, layering, lifecycle of invariants; design obligations for irreversible actions | The concrete item list; concrete criterion implementations |
| [QE-04 audit methodology](QE-04-audit-methodology.md) | **Post-hoc** classification and root cause (nine classes); the single source of classification vocabulary | What to do at design time |
| [QE-03 project audit](QE-03-project-audit-and-release-gate.md) §4.1 / §6 | Evidence levels (E0–E3) and common false greens | How invariants are defined and retired |
| The host project's equivalent spec (per-domain technical invariants: schema / API / batch jobs / money) | Concrete technical invariants per domain | Invariant methodology |
| The target project's error-code spec | Error-code value set and registration discipline (= the domain implementation of INV-13) | — |
| [`qe/registry/registry.ts`](qe/registry/registry.ts) | **Item single source** (machine-readable, with status/guards/openReason) | Method descriptions |

**Hard rule: neither this document nor QE-04 may copy the item list.** Items live only in the registry; documents carry method, vocabulary, and pointers. Copying a list creates a second truth that is bound to rot — the reference implementation learned this when a widely repeated claim about its ledger size did not match what was actually registered.

Machine backstop: `inv13` verifies three things — ① this document exists and is registered in QE-00 §2 (no orphan document); ② every `INV-xx` referenced here exists in the registry (no dead pointers); ③ every `defectClasses` entry in the registry has at least one element that maps onto one of QE-04's nine classes (so that no newly invented "class thirteen" can appear again).

---

## 8. Three-layer adoption checklist

| Layer | Action | Criterion |
|---|---|---|
| **Proposal** | Five questions (§3) + irreversible-action obligations (§4) + seam protocol (QE-06) | The proposal contains INV IDs and counterexamples |
| **Development** | New or modified invariants enter the registry first; criteria obey D1–D12 | `test:invariants` (addressable / reasons required / review window) |
| **Commit / release** | Run all gates (`test:`-prefixed aliases enter the gate automatically) | `run-all-tests` fully green + `tsc --noEmit` 0 |

**Forbidden actions** (all of which have happened): skipping hooks with `--no-verify` / pushing new violations into the baseline / labelling "no criterion" as `enforced` / maintaining a second item list in documentation / asserting environment readings in CI.

---

## 9. Anti-patterns (what should not become an invariant)

Invariants have a cost (writing criteria, maintaining a baseline, running the gate on every change). The following four classes should not enter the registry:

1. **Style and copy preferences** — no business consequence; I4 in §2 does not hold.
2. **Optional optimizations** — "could be faster" is not a constraint unless a P95 threshold and a measurement method are given.
3. **Wording that requires human judgment** — "the copy should be tasteful" cannot be mechanically judged.
4. **One-off checks** — a script that should run once before a release is a task list, not an invariant.

The test: **ask "what loss does violating it cause, and who is harmed?"** If you cannot name the harmed party, it should not enter the registry.

---

## Revision history

| Version | Date | Content |
|---|---|---|
| v1 | 2026-10-22 | First publication. Established the four admission criteria (I1–I4), the six-layer interception cost model with three hard rules, the five review questions, design obligations for five classes of irreversible actions, criterion-shape discipline D1–D12, the three-state lifecycle with a review window, the single-source division across QE-04 / QE-00 / the host project spec / the registry, the three-layer adoption checklist, and the anti-pattern list. Machine backstop `test:invariants-doc` (orphan documents / dead pointers / classification vocabulary). Evidence base: a real audit batch in the reference implementation (zero-write columns decreasing after remediation, hundreds of error codes, hundreds of smoke scripts, decision items recorded but never executed, and a `status = 'failed'` value that nothing in the codebase wrote) |

---

**中文摘要**：不变量怎么定、在哪一层拦、何时退役；条目单源在 registry。
