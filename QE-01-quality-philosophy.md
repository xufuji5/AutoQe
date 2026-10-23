# QE-01 · AI Coding Quality Handbook (General Edition v1.0)

> Audience: small and mid-sized teams (1–5 people plus AI) where AI is the main coding force; typical systems are e-commerce, production management (MES/QMS/GMP), and SaaS business systems.
> How to use: chapters 5–9 form a sequential handbook (follow them in order); chapter 8 (the invariant library) and appendix B (the case set) are lookup material; every new project starts with the audit in chapter 10.
> Every criterion in this handbook comes from paid lessons in real repositories (an e-commerce system and a GMP production-management system, measured in 2026-10), not from theoretical reasoning.

---

## 0. Core proposition: quality = constraint density

### 0.1 The physics of AI defects

The optimization target of AI-generated code is "locally reasonable": it compiles, the types check, and it matches the prompt literally. It lacks three capabilities, and defects grow precisely out of these three absences:

| Capability AI lacks | Defect signature | Typical instance |
|---|---|---|
| No concept of a global invariant | A key exists in the API contract with **zero senders**; a column exists in the schema with **zero writers** | The contract key `round/isRetest` has no collection surface; four per-signer columns are alive in the table and dead in practice |
| Bias toward silent success (`catch` / `??` fallbacks "look safer" than throwing) | A failed query renders as an empty state; **the default value becomes the verdict** | A 500 from a missing attachment column is swallowed into "not released"; `?? "pass"` turns a batch check into a default pass |
| Happy path only | Dead branches, fake entry points, whole tables never landed | A "confirm backfill" button points at a channel that does not exist; a remediation table is created and never referenced |

**Corollary 1: tests are enumeration, AI defects are structural — enumeration never catches up with structure.** Add one e2e test per path, and AI fails on path 101. Piling tests onto the cracks is just mopping the floor more often.

**Corollary 2: invariants > use cases.** A use case asks "is this path correct" (one test removes one path from the risk list); an invariant asks "**does this hold for the whole system**" (stated once, it covers every path, every future line of code, including what AI writes tomorrow).

### 0.2 Error cost hierarchy (make errors explode at the cheapest layer)

| Layer | What it catches | Relative cost | Characteristic |
|---|---|---|---|
| L0 Types / schema | Illegal states are unrepresentable | 1× | Broken as soon as AI bypasses it with `as`, `??`, or a cast = the layer is broken |
| L1 Database constraints | RLS, FK, unique indexes, triggers | 5× | Effective for business tables ≠ effective for all tables |
| L2 Contract single source | API key sets, error codes, enums, request bodies | 20× | The high-incidence seam (spec ↔ code ↔ request body, three faces) |
| L3 Invariant guards | One criterion per defect class | 100× | Must ship with its own counter-proof, otherwise it is paper |
| L4 e2e flows | End-to-end smoke | 1000× | Verifies the main chain only; never repeats what guards already block |
| L5 Human review | Semantics, visuals, business judgment | ∞ | Register blind spots; do not pretend they do not exist |

**The whole job of quality control is to drag defects from L4/L5 back into L0–L2.** Tests do not get fewer; they get cheaper.

---

## 1. Overview: the five-gate method

| Gate | Core question | Output | Acceptance line |
|---|---|---|---|
| **① Design gate** | Can this statement be verified by a machine? | Invariant registry + direction-adjudication records | Every invariant has a criterion and a bad sample; missing either one forbids `enforced` |
| **② Architecture gate** | Where will the hole grow — which seam? | Table ownership matrix + dependency direction graph | No structure where "both sides miss it together" |
| **③ Stack gate** | Can this technology constrain AI? | Selection-criteria table + boundary generators | Zero handwritten boundary code |
| **④ Specification gate** | Is the spec a generation source or reference material? | Four-piece module spec set | The spec can feed code generation directly; no reconciliation afterwards |
| **⑤ Test gate** | Do we test properties or enumerate paths? | Guard family + smoke e2e + blind-spot register | All three guard states present; false red and false green equally guilty |

**Discipline: if a layer cannot answer its own core question, the four layers behind it are towers on sand.** The order is the method itself.

---

## 2. Layer 1: design gate — invariants first

### 2.1 The invariant registry (before any feature starts)

Machine-readable (e.g. `scripts/invariants/registry.ts`), discovered automatically by CI, and **not written as a document** — documents drift, while the registry is validated by guards. Each entry has four elements:

```
id        : INV-CORE-07 (unified namespace, see the number-range discipline in 9.3)
statement : one sentence, subject is the system ("every gate must have a UI entry point")
c7        : case reference (incident-ledger ID in the host project; merge source for historical defects)
guard     : guard script path (required for enforced/partial)
badSample : bad-sample description and location (required for enforced; missing it forbids enforced)
status    : enforced (guard + counter-proof + in place) / partial (gap required) / missing (reason + review trigger)
```

**Status semantics (anti-ledger-tampering; copy verbatim)**:
- `enforced` = criterion present + injected bad sample necessarily red + restored necessarily green + actually executed by CI. Missing any of the four demotes the entry.
- `partial` = a guard exists but covers only part of it; **the gap field is mandatory**.
- `missing` = no guard; **the reason is mandatory + a review trigger is mandatory** (90 days, or "review as soon as a new defect appears in the related domain"). **An open entry without a trigger is a permanent waiver slot under a different name.**
- **No coverage threshold.** Any threshold invites the tampering motive of "turn missing into partial to hit the number" — that is turning a ledger into a report card.

**Three actions (do not memorize more)**:
- **A** | AI writes a new column and forgets to wire it → the guard goes red on the spot and names it. Two possible dispositions: add the writer / delete the column. **Never stuff it into a waiver** — waivers only hold items that have been adjudicated and deferred, each with a reason of at least 8 characters.
- **B** | A new defect arrives → the first question is not "what test do we add" but "**which invariant does it violate**": if it falls into an existing entry, extend that guard's scope (do not open a new guard); if it violates none, it is a new class → add an INV, and at the same time provide either a guard or a missing entry with reason + trigger.
- **C** | About to touch schema/migrations (irreversible) → first answer the "five approval questions" (appendix C-2); incomplete answers do not enter the implementation queue.

### 2.2 Direction adjudication discipline

When you find "the spec says X, the code does not" (or the reverse), **force a binary choice: spec wrong → fix the spec; code wrong → fix the code. "Both are right" is forbidden** — fudging turns one real disagreement into two false agreements, and a false agreement is later treated as two real facts during an inspection, audit, or reconciliation.

### 2.3 Every promise needs a throw site

Every sentence in a spec, a comment, or UI copy that says "the system will do X" must either be backed by a throw site, a write site, or a route — or be deleted. **The force of a UI promise = the force of the server**: UI weaker than the server (softened wording) or stronger (promising a button that does not exist) is a defect either way.

### 2.4 Design gate checklist

- [ ] Are the invariants this feature depends on already in the registry? If not → open an INV first
- [ ] Does every `enforced` entry have a bad sample and an archived injection record?
- [ ] Does every `missing`/`partial` entry have a reason + review trigger?
- [ ] Has every "promise sentence" touched by this change been backed or deleted?

---

## 3. Layer 2: architecture gate — make "both sides miss it together" impossible

### 3.1 Four architecture iron laws

1. **One table, one owner module.** Cross-module access goes only through the service layer; direct cross-module access to business tables is forbidden. The owner is responsible for all fields, constraints, and guards of that table.
2. **Dependencies flow one way**: presentation → domain → data. Reverse references are forbidden (the presentation layer must not define domain rules; the domain layer must not import presentation components).
3. **An invariant lives at its cheapest layer**: tenant isolation in the database (RLS), state machines in types + guards, business criteria in the registry, copy in a single-source vocabulary. **If it can sink, it must never float** — floating one layer up multiplies detection cost by 5.
4. **Every cross-module contract registers an owner**: error-code domain, enum domain, state-machine domain, contract domain each have exactly one source of truth. AI does not know that two rules come from the same owner; only a registry entry stops it from writing both (appendix B-10: spec ↔ code copy drifted in 31 places).

### 3.2 Scenario hole map (same skeleton, different fillings)

| Hole position | E-commerce | Production management (GMP/MES) |
|---|---|---|
| Concurrency and money | Overselling, duplicate payment callbacks, multiple promo price versions | Batch-number sequencing colliding with P2002, race on audit-chain sequence numbers |
| Audit and traceability | Operation logs, order trail | Field-level audit + hash chain, signature bound to a snapshot |
| State machine | Order / refund / fulfillment | Four-level review chain, release blocklist |
| Irreversible | Order deletion / refund approval | Migration chain, destruction, adding enum values |
| Compliance wording | Advertising claims / price labels | Regulatory criteria, scenario-specific limits |

**Architecture review asks one question: in this design, at which seam does "both sides miss it together"?** If you cannot answer, the design is not finished.

### 3.3 Architecture gate checklist

- [ ] Can you name the owner module of every table in one breath?
- [ ] Is the dependency graph acyclic, with no reverse edges?
- [ ] Can you say, for every system-level invariant, which layer it lives in and why that layer is cheapest?
- [ ] Does every cross-domain concept (error code / enum / state) have a registered single source?

---

## 4. Layer 3: stack gate — choose technology that can constrain AI

### 4.1 Four selection criteria (ordered by weight)

| Criterion | Why | Counter-example |
|---|---|---|
| **① Constraint expressiveness** | Make illegal states unrepresentable = AI's "reasonable default" becomes a type error | A "flexible" framework where everything needs handwritten validation |
| **② Static analyzability** | Guards live on grep/AST; the more magic, the more fake the criteria | Runtime-dynamic table names, ORM conditions assembled from strings |
| **③ Replayability** | Irreversible operations need a free trial-and-error channel | Migrations with out-of-band manual steps (the lesson of hand-run SQL) |
| **④ Single-source generability** | When boundaries generate code, AI only fills the middle | A handwritten validation function at every site (typing `typeof` 150 times for 150 routes) |

Reference stack: PostgreSQL (RLS / enums / FK / triggers / advisory locks), TypeScript discriminated unions, Prisma + handwritten migrations, zod boundary validation.

### 4.2 Boundary zero-handwriting acceptance line

**The premise of "AI fills the middle, never touches the boundary" is that the boundary really exists and is generated.** The hard acceptance line of the stack gate:

```
schema.prisma ──generate──▶ TS types ──generate──▶ zod validation ──generate──▶ form skeleton / contract docs
                                    │
                                    └── handwritten validation functions are allowed only inside the generator
```

- Input validation for new routes **comes from generation**; `req.json() as X` is forbidden, per-field handwritten `typeof` is forbidden;
- New enums **come from a single definition**; guards and migrations are derived from it;
- The boundary file list goes into a guard: any handwritten validation appearing in a generated zone is red.

### 4.3 Stack gate checklist

- [ ] Can you name the generation source of every boundary class (input / enum / error code / contract) in one breath?
- [ ] Is the repo-wide count of handwritten validation functions converging (with a baseline reading)?
- [ ] Does the migration chain have no out-of-band steps, and can a clean database replay the whole set?
- [ ] Does the database use its constraint expressiveness (RLS / enums / unique indexes) rather than "application-layer self-discipline"?

---

## 5. Layer 4: specification gate — the spec is the generation source

### 5.1 Four-piece module spec (missing one means undelivered)

1. **Field inventory**: every column is annotated with `writer (function name) / reader / archive declaration`. This is the ledger form of the "every column has a writer" invariant — **a field inventory without a "writer" column is refused review**.
2. **State machine**: enum values + legal transitions + **the production path of every value** (which write site, under what condition). An enum value whose production path cannot be written is a dead enum; adjudicate it on the spot (delete the value or add the write site).
3. **Criteria**: gates, blocklists, time limits — **each with a rejection sentence**, and the rejection sentence is grepped back against UI controls (a rejection sentence with no control = an idling gate, appendix B-1).
4. **Acceptance cases**: a decision table that can be converted directly into guards or e2e.

### 5.2 The mechanism that keeps specs from conflicting (meta-discipline beyond the four pieces)

- **Single source of truth (D1)**: a rule has exactly one owner document; every other document may only carry a pointer sentence ("source of truth: X §N") and **must not restate the body**. Restatement always drifts — do not chase the drift, eliminate the structure that produces it.
- **Five-step change process**: ① proposal (recorded in the originating document's revision log) → ② ledger entry → ③ affected documents synchronized in the same batch → ④ all criteria green → ⑤ version number placed in all four locations. **"We'll align later" is forbidden.**
- **Number-range ownership table**: every numbering scheme (error codes / use cases / invariants / acceptance) registers exactly one owner; **check occupancy before taking a new number** (two greps: documents on file + in-flight self-claims).
- **Machine criteria**: any principle scanned more than twice must have an address (a guard or the registry) — "discipline written in a comment equals no discipline".

### 5.3 Specification gate checklist

- [ ] Are all four pieces of this module present? Is the "writer" column of the field inventory filled in?
- [ ] Does every enum value have a production path?
- [ ] Does every criterion have a rejection sentence, and does grepping the rejection sentence find a control?
- [ ] Does this document avoid restating rules from other documents (passes the restatement scan)?
- [ ] Did the change follow the five steps, with affected documents in the same batch?

---

## 6. Layer 5: test gate — test properties, do not enumerate paths

### 6.1 Three-layer pyramid (value split 70/25/5)

| Layer | What it verifies | Share | Iron law |
|---|---|---|---|
| **Invariant guards** | A defect class never holds | 70% | All three states present (see 6.2); bad samples injected independently |
| **e2e smoke** | The main chain works | 25% | Do not re-verify what guards already block; stubs move with the gate |
| **Human spot checks** | Semantics / visuals / blind spots | 5% | Blind spots are registered, not pretended away |

**The only added value of e2e is "cases catch up once a gate lands"**: when the server adds a required gate, every consumption surface (including mini-program / offline queue payloads) must be surveyed in the same batch — finishing the web app ≠ finishing every client.

### 6.2 Three states of a guard (missing one means it is not a guard)

1. **Built**: the criterion code exists and runs. — Proves nothing.
2. **Counter-proven**: injecting a known bad sample **must show red**, and removing it **must show green again**. Keep the record (bad-sample content + red reading + green reading). **A validation script reporting false green is more dangerous than reporting nothing.**
3. **In place**: executed automatically by CI/batch runs, and its exit code participates in the conclusion.

**Guard self-proof triad (against "the guard itself broke")**:
- Parsing 0 objects → throw; **never treat "read 0" as "no problems"**;
- The comparison baseline must actually line up (self-check the match rate between schema keys and database table names; throw when it does not);
- Output must **report its own scope** ("which directories were scanned, who was excluded, and why"); exclusions also leave a trace.

### 6.3 Three disciplines for bad samples

1. **Independent injection**: bad samples are constructed by the reconciling party from the reverse side of the invariant; **the implementer must not build its own** (a guard that generates its own data to test its own gate is permanently green).
2. **One bad sample per criterion**: injection must be red, restoration must be green; record both directions.
3. **A counter-proof is an asset**: freeze the bad sample into the guard (`--self-test` or a fixture) and replay it on every batch run.

### 6.4 False red and false green are equally guilty

- **False green** lets a defect through and makes people believe it was verified (reading 0 objects and reporting green; a scope lagging behind reality and silently passing).
- **False red** burns trust and makes people "fix" things that are not broken — **when a guard reports 33 problems, the first reaction should be "the guard is wrong", not "the code has 33 problems"** (the case where certificate-issuing logic was nearly deleted as dead code).
- Companion rule: **fixtures with a time window must not hard-code absolute dates** (an assertion that was genuinely green will turn red as the calendar moves, which is harder to spot than an always-true assertion).

### 6.5 Test gate checklist

- [ ] Does every guard have a counter-proof record (bad sample + red reading + green reading)?
- [ ] Does every guard report its scan scope and exclusion reasons?
- [ ] Are e2e stubs updated in the same batch as new server-side gates?
- [ ] Are human spot-check blind spots registered (rather than a single sentence "tests pass")?
- [ ] Do batch runs take the exit code of the thing under test (`pipefail` / `PIPESTATUS`)?

---

## 7. AI collaboration protocol (five rules)

1. **AI fills the middle, never touches the boundary.** Boundaries (schema, contracts, enums, error codes, state machines) are generated from a single source; AI writes only the middle business logic. In a system whose boundaries are still handwritten, this rule does not hold — build layer 3 first.
2. **List "where it can fail silently" before starting.** Ask AI, for each feature, to list the points that can silently fail / go false green / have no source, then implement. Its sensitivity to "where false green can happen" is far higher than to "is the feature correct".
3. **Bad samples are injected by the reconciling party** (6.3); AI's self-test results are not accepted on their own.
4. **Fixed acceptance order**: invariant lookup (which INV is violated?) → guards → e2e → human spot checks. **Look up the table before running tests** — lookup takes seconds, tests take minutes.
5. **Every "done" claim from AI must be addressable**: a commit, a guard reading, or a ledger row — at least one of the three. The words "done" are not evidence.

---

## 8. Invariant library

### 8.1 General skeleton INV-CORE-01–15 (merged from two production repositories; copy as a starting point)

| # | Invariant | Criterion form |
|---|---|---|
| 01 | Every column either has a writer or does not exist | Static scan of service write sites + "reads do not count as writes" discrimination |
| 02 | Every column either has a reader or is declared archived | Schema annotation convention + read-site scan |
| 03 | Every enum value has at least one production path | Reverse lookup enum ↔ column ↔ write context |
| 04 | Exactly one copy of each state criterion (a duplicate is red) | Scan for a unique source of state string literals |
| 05 | Every read of a soft-delete table filters (including read-by-id, count, export, trends) | Full-set static scan of read sites + bad samples |
| 06 | Every "will do X" in a spec or comment has a throw site or a ledger entry | Promise list ⇄ grep for throw sites |
| 07 | Every gate has a UI entry, and every rejection word has a control that answers it | Rejection-sentence ranking words ⇄ grep for controls (walk the gate backwards) |
| 08 | Every multi-tenant write carries a tenant predicate; identity/waiver tables are in scope too | Static scan of write sites + in-transaction checks |
| 09 | The migration chain replays wholly on a clean copy and objects do not drift | fresh-copy deploy comparison |
| 10 | New codes are registered first, codes in use have a throw site; the three contract faces (spec / code / request body) match by machine | Registry ⇄ code bidirectional diff |
| 11 | Monetary identities hold per transaction; redundant counters can be recomputed from source tables | Probe reconciliation + recomputation consistency |
| 12 | Write paths must not check-then-act; hot spots have locks and conflict classification | Pattern scan + concurrency probes |
| 13 | A guard on the books must actually run (have an entry) and prove its own scope | Registry validation (the meta-guard of this handbook) |
| 14 | HEAD builds from a clean checkout; all critical files are committed | Clean-worktree compile probe |
| 15 | Mechanism present ≠ in effect: a delivery claim requires an enablement rate > 0 for declarations/templates/guards | Enablement-rate reading (INFO, always present) |

### 8.2 Scenario pack A: e-commerce (append to the skeleton)

- Stock deduction must be CAS (`WHERE stock >= ?`); read-then-write is forbidden
- Idempotency keys across the whole payment/callback chain; a repeated notification never creates a second record
- Refund amounts follow the server-side ledger; client amounts are display-only
- Promo prices are computed from one source; no second discount applied in the frontend
- Coupon redemption is concurrency-atomic; expiry is judged by the server clock
- Hot sequences (order numbers / coupon numbers) use advisory locks or a sequence table; `max+1` is forbidden

### 8.3 Scenario pack B: production management / GMP (append to the skeleton)

- Field-level audit is append-only: DB triggers + application guards + permission revocation, three layers
- Signatures bind to a snapshot taken at signing time; verification recomputes from the snapshot, never reads the live row
- Four-eyes review is hard-rejected server-side: self-review by the same person, double-signing by the same person, and out-of-order steps all return 4xx
- While the release blocklist is not cleared, the approval action is unreachable server-side (not merely a greyed-out button)
- Every enum production path is registered; dead enums are adjudicated on the spot
- Irreversible operations (migration / destruction / adding enum values) go through the five approval questions + a clean-database replay
- Offline late signing is visible: an `offline` flag plus the delay duration always shown; offline is forbidden at L3
- "Mechanism present ≠ in effect" enters the closing reading of every batch

### 8.4 Format for opening a new invariant (one sentence + four elements; all required)

```
INV-XX: <one system-level sentence, subject is the system>
c7     : merge source (historical defect IDs)
guard  : criterion form (how a machine verifies it)
bad    : how the bad sample is built; which red is expected after injection
```

**Pre-check before opening**: can this sentence be phrased with "exists / for all / never"? If not, it is only a use case, not an invariant.

---

## 9. Governance mechanisms

### 9.1 Five ledger disciplines (preventing the ledger itself from rotting)

1. **Counts are reproducible**: every conclusion that carries a count comes with a reproduction command; the command is the source of truth, and the number in the document is only a dated snapshot. **A reproduction command that does not match the entry is red.**
2. **Anchors, not line numbers**: entries use "document + table name / section number", never line numbers (line numbers drift with every edit; a wrong anchor is more dangerous than no anchor).
3. **`open` carries a trigger**: beyond the reason, a review trigger is mandatory; when it comes due and is unhandled, the entry turns red.
4. **Entry ≠ disposition**: deferring an item must also state the closing condition, otherwise it is just moving the defect somewhere else.
5. **Two-pass grep before taking a number**: grep documents on file + in-flight self-claims (code comments claiming a number first cause two batches to reconcile against the same number).

### 9.2 Batch discipline

- **Adjudicate before building**: direction adjudication (fix spec / fix code) comes before construction; never write code first and reconcile the ledger afterwards.
- **Red before green**: on its first day, a new guard must show red against one known bad sample.
- **Closing reconciliation**: before delivering a batch, check every entity field / enum / number range touched by the batch against the schema one by one; even when the conclusion is "zero divergence", write that sentence into the batch record — **not written = the batch is not closed**.
- **Scheduled ≠ done**: any uncommitted "✅" is marked "scheduled claim"; completion readings are commit + guard reading.
- **Two mandatory closing checks**: rerun the current `tsc` reading (never quote the previous round), and classify every red in parallel batches item by item (do not fix other batches, but state whose they are).

### 9.3 Five-step change process (the only way to change any rule)

Proposal (originating document) → ledger entry → affected surfaces synchronized in the same batch → all criteria green → version placed in four locations. Skipping any step means nothing changed.

---

## 10. Rollout roadmap

### 10.1 Step 0: audit an existing system (half a day, ten questions)

1. Is there an invariant registry? If not → establish one in week 1 (copy chapter 8 as a starting point)
2. How many guards exist, and how many have counter-proof records? Sample 5, inject bad samples, see whether they turn red
3. Are there guards/scripts "on disk but with no entry"? (diff `package.json` in both directions)
4. How many zero-writer columns are in the schema? (write-site scan; baseline reading)
5. How many enum values have no production path?
6. Can the migration chain replay wholly on a clean database?
7. Are boundaries (input validation / enums / error codes) generated or handwritten? Baseline the handwritten ratio
8. Do all read sites of soft-delete tables filter (including read-by-id)?
9. Does HEAD build from a clean checkout?
10. Which invariant does each of the last 10 defects violate? (merge-degree test — most should fall into existing entries)

### 10.2 Four-week plan

| Week | Actions | Output |
|---|---|---|
| 1 | Establish the registry (copy the 15-entry skeleton) + audit existing guards with counter-proofs (inject bad samples into 5 sampled guards) + scan for orphan scripts | False-green / false-red list (the first real readings) |
| 2 | Clear the first batch of reds (direction adjudication) + INV-13 reverse comparison + zero-writer column disposition (raw SQL scan first, then data-volume reading, then adjudication) | The registry's first all-green window |
| 3 | Boundary generators (schema → zod → form; cover writes / money / permissions first) | The first block of zero-handwritten boundaries |
| 4 | Complete the four-piece module spec (start with the "writer" column) + triggers for open entries + the five approval questions into the PR template | The first spec that is also a generation source |

### 10.3 Steady state and metrics

- **Steady state = 20–30 invariants.** Most new defects fall into existing entries (a lookup), a few open new ones. **"Dig everything out once" does not mean "no digging later"; it means every dig settles into an invariant.**
- Three health metrics: rate of new defects landing in old entries (↑), guard counter-proof coverage (= 100%), zero-writer / phantom-code counts (→ 0 and pinned).

---

## Appendix A: Glossary

| Term | Definition |
|---|---|
| Invariant | A property that always holds for the system; opposed to "use case" (a path) |
| Guard three states | Built → counter-proven (bad sample must be red) → in place (run automatically by CI) |
| Bad sample | A deliberately constructed input that must turn the criterion red; must be injected independently |
| False green / false red | Reporting pass while the criterion is not working / the criterion hits healthy code |
| Live table, dead column | A column exists in the schema and in migrations, but has no writer anywhere in the database |
| Idling gate | The server-side criterion exists, but the key/control that triggers it does not, so the criterion always takes the empty branch |
| Dead enum | An enum value with no production path at all |
| Phantom rule | The spec or UI claims enforcement, while the real code has no corresponding throw or validation |
| Direction adjudication | The binary discipline "spec wrong → fix the spec / code wrong → fix the code" |
| Five approval questions | Five prerequisite questions before touching schema/migrations (appendix C-2) |

## Appendix B: Case set (15 real cases; each one is the birth certificate of a criterion)

| # | Case | Criterion it produced |
|---|---|---|
| 1 | A supplier-qualification gate queried the audit trail by a key that had no data-entry channel at all — the gate always took the empty branch | Reverse census of idling gates: rejection sentence ⇄ UI control |
| 2 | A three-signature chain was split into four per-signer columns with zero writers across the whole database; the certificate dossier printed a rank string instead of a person's name | Live table, dead column: a column has a writer or it does not exist |
| 3 | The soft-delete column existed, four read paths filtered and five did not — the detail page of a voided row returned it verbatim | Soft-delete read full set (including read-by-id, count, export) |
| 4 | An RLS probe had a misspelled GUC name; every tenant silently received 0 rows with no error | False-zero criterion: a wrong context returning 0 without an error is more dangerous than an error |
| 5 | The error-code guard script was on disk but had no npm entry; the batch always ran green while two copy sites were actually drifting red | Guards on the books must actually run (registry V4) |
| 6 | The first version of the state guard reported 33 "problems"; verification found 12 real gaps — certificate-issuing logic was nearly deleted as dead code | False red and false green are equally guilty: too many reds → suspect the criterion first |
| 7 | A 12-item self-check on issuing certificates ("any red → block") was written in the ledger, with zero calls and zero throws on the issuance path | Phantom rule: every promise must be backed by a throw site |
| 8 | The mandatory device-binding mechanism was built; in the production database `require_equipment` was 2/1398, binding rate ≈ 0 | Mechanism present ≠ in effect: enablement-rate reading goes into the ledger |
| 9 | Three libs were in the working tree but not in HEAD; a clean checkout must fail with TS2307 | HEAD-buildable probe |
| 10 | Error-code copy was written twice, in a 30-volume spec set and in the catalog; reconciling 127 codes showed 31 drifts | Contract single source: no second copy of the body |
| 11 | An inspection guard was "once established, later lost": the ledger kept the first-run number while script / npm / references were all zero | In-place reconciliation (same family as case 5) |
| 12 | The idempotency implementation caught P2002 and kept writing inside the same transaction; the whole transaction rolled back — in the "already exists" round it could not even stop writing | "Idempotent success" and "write failure" cannot share one false |
| 13 | Dead columns are often accompanied by read points: a column read by someone and written by no one — treating reads as writes keeps the criterion green forever | "Reads do not count as writes" discrimination (the load-bearing point of INV-01) |
| 14 | An enum type was never created in the database: table present, column present, any write fails with 42704 — "table exists ≠ table usable" | Migration ↔ schema object-level reconciliation |
| 15 | A leave-request fixture hard-coded absolute dates; ten days later the assertion demanded an error for a state that no longer existed | Time-window fixtures must not hard-code absolute dates |

## Appendix C: Templates

### C-1 Invariant register (one added/revised line)

```
| INV-XX | <one sentence> | c7:[..] | guard:<path> | bad:<sample and expected red> | status:<enforced/partial/missing> | gap/reviewBy:<..> |
```

### C-2 Five approval questions (before touching schema/migrations; incomplete answers do not enter the implementation queue)

1. Are new tables/columns in the RLS and soft-delete lists? (A waiver is also an adjudication, not a default)
2. Who is the writer of each column (function name)? Where are the read sites? Neither → why does it exist?
3. Which INV guards it? If none can, what are the openReason + review trigger?
4. Is the FK cascade direction toward the deleting side or the retaining side? Who depends on that direction?
5. Rollback story: after release, how is it withdrawn? What data does a rollback lose? (The clean-database replay reading is how this question is cashed out)

### C-3 Batch closing checklist

- [ ] Direction adjudication recorded (fix spec / fix code; no fudging)
- [ ] Reconciliation conclusion between touched surfaces and schema written into the batch record (including "zero divergence")
- [ ] Counter-proof record for new guards (bad sample + red/green readings)
- [ ] New codes / new number ranges in three places in the same batch (registry / documents / consumers)
- [ ] `tsc` reading rerun; reds in parallel batches classified by ownership
- [ ] Uncommitted items marked "scheduled claim", not done
- [ ] New debts registered in the ledger with triggers; old triggers handled when due

---

*Handbook v1.0 · 2026-10-22 · every criterion comes from measured readings in two real repositories; start the next revision by appending a case to appendix B.*

---

**中文摘要**：质量 = 约束密度：不变量优先于用例；L0–L5 错误成本层级与五层闸门。
