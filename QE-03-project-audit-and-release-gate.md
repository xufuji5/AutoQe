# QE-03 · Project Audit and Release Gate

> **Purpose**: a **business-agnostic** work order. Point it at any existing project (not limited to Next.js or Prisma) and, within half a day, establish a factual baseline, assemble a reproducible bug list, and issue an accountable go/no-go decision.
> **Companions**: stack-specific criteria in `QE-06`–`QE-09`; defect classification in `QE-04`; invariant lifecycle in `QE-05`; automated guards in `AGENTS.md`.
> **Outputs**: **bug ledger + release decision report** (templates under `qe/templates/project-audit/`). Every conclusion must carry evidence; "the code looks fine to me" is not a conclusion.

## 0. How to use

| Stage | Time box | Output | Exit condition |
|---|---|---|---|
| S0 Fact baseline | 30–60 min | Runnable record, command list, environment-variable list | Builds and starts in a clean environment (or the failure point is documented) |
| S1 Quick scan | 60–90 min | List of suspicious points (unrated) | Every entry point / write path has been scanned once |
| S2 Deep dive | 2–4 h | Reproduced bugs + evidence levels | All P0/P1 have evidence or a documented reason for exclusion |
| S3 Rating and fixing | As needed | Fix PR + regression fixture | Every fix has re-verification evidence |
| S4 Release decision | 30 min | Decision report | All 12 gates have a verdict |

**Three principles**

1. **Evidence first**: a conclusion without command output, reproduction steps, or a test assertion is marked "unverified" and does not count toward the release decision.
2. **Breadth before depth**: scan every entry point and write path first, then pick high-risk areas to dig into; do not dive straight into the first suspicious point.
3. **Order by impact**: data corruption, privilege escalation, and money errors outrank code style; anything that can fail *silently* outranks anything that fails loudly.

## 0.1 Landing in the target project

1. Copy the "AutoQe adoption bundle" to the target repository root as described in `QE-00-index.md` §7 (documents sit next to `qe/`).
2. Copy `qe/templates/project-audit/` to `qe-audit/<project>-<date>/`.
3. Fill in five files along S0→S4: `00-fact-baseline`, `01-entry-inventory`, `02-scan-log`, `03-bug-ledger`, `04-release-decision`.
4. If any of the five files is missing, no release conclusion may be issued; the verdict must cite gate results and bug IDs.
5. If the audit adopts an external checklist (a generic audit pack, a third-party report), fill in `05-gap-absorption-plan.md`: for each item record applicability, the local artifact that carries it, and the acceptance reading; "not applicable" or "rejected" must come with a reason. Template: `qe/templates/project-audit/05-gap-absorption-plan.md`.

> One workspace per project; do not copy the previous project's ledger in as template content.
> An external checklist supplies problems, not conclusions: when the host project already has a stricter guard for an item, mark it "already present" — do not replace it with the external form just to "absorb" it.

## 1. S0 · Establish the factual baseline

### 1.1 Repository and runtime

| Check | How | Record |
|---|---|---|
| Directories and module boundaries | List top-level directories, entry directories, shared directories | Module inventory (who depends on whom) |
| Dependencies and lock file | Check that a lock file exists and is consistent | Package manager and version |
| Build | Run the commands documented in the repository, in a clean environment | Success/failure + first error |
| Type / static checks | `typecheck` / `lint` | Error count (not "is it configured") |
| Tests | Run the full suite; record passed/skipped/duration | Core paths covered |
| Startup | Start per the README, hit the health check | Startup time, health endpoint |
| Database | Can migrations replay onto an empty database? | Integrity of the migration chain |

> A failing build, unreplayable migrations, or a 404 health check — any one of these is an immediate P0; deeper analysis can wait.

### 1.2 Environment and configuration

- List every environment variable read by the code and diff it against `.env.example` / the deployment config; a missing one means "it explodes on deploy".
- Check the direction of defaults: security-relevant settings (auth keys, rate limits, feature switches) must **fail closed** when absent — never default to allow.
- Check for secrets committed to the repository: `rg -n "(api[_-]?key|secret|token|password)\s*[:=]\s*['\"][^'\"]{8,}"` — a hit is P0.
- Check whether `.env*` is under version control, and whether the client bundle leaks server variables (misuse of `NEXT_PUBLIC_` / `VITE_` prefixes).

### 1.3 Entry inventory (the skeleton for every later check)

List every place "the outside can get in", in one table:

| Type | Examples | Count |
|---|---|---|
| HTTP routes | route handlers, controllers, routers | |
| Server actions | `'use server'` exports | |
| Queue consumers | workers, consumers, cron | |
| Webhooks | payment / third-party callbacks | |
| CLI / scripts | ops scripts, migration scripts | |
| Agent / MCP channels | tool-call entry points | |

> If the entry inventory is incomplete, every downstream auth and validation check is worthless. **Enumerate first, judge second.**

## 2. S1 · Quick scan (high-yield patterns)

> Commands are shown with ripgrep; substitute equivalent patterns for other languages. A hit is only "suspicious" — it must be re-checked in S2.

| # | Scan item | Command / method | What counts as suspicious | Default level |
|---|---|---|---|---|
| 1 | Missing authorization on entry points | For each entry, does the function body perform an authorization check? | Only checks "logged in", no object-level check, public entry not registered | P0/P1 |
| 2 | Unvalidated input | `rg -n "request\.json\(\)\|req\.body\|ctx\.request"` then look nearby for schema/validate | Body flows straight into business logic / the ORM | P0 |
| 3 | Dangerous execution | `rg -n "eval\(\|new Function\|child_process\|execSync\|\$queryRawUnsafe\|\$executeRawUnsafe"` | User input concatenated into the executable string | P0 |
| 4 | XSS sinks | `rg -n "dangerouslySetInnerHTML\|v-html\|innerHTML\s*="` | Unsanitized rich text / user input | P0/P1 |
| 5 | Client boundary escape | `rg -l "use client"` then inspect imports: `@prisma/client\|server-only\|next/headers\|node:\|fs\|path\|crypto` | Client code imports server-side implementation directly | P0 |
| 6 | Check-then-insert | `rg -n "findUnique\|findFirst\|exists\("` near `create` | No unique constraint as backstop | P1 |
| 7 | Bare updates | `rg -n "\.update\(\{\s*where:\s*\{\s*id"` / `save()` | No precondition on state or version | P0/P1 |
| 8 | Sensitive data persisted | `rg -n "persist\(\|localStorage\.setItem\|sessionStorage"` | Tokens/passwords/ID numbers written to persistence | P0 |
| 9 | Swallowed errors | `rg -n "catch\s*(\([^)]*\))?\s*\{\s*\}"` / only `console.log`, never rethrow | Failure recorded as success | P1 |
| 10 | Public entry points | For every unauthenticated entry ask "why may this be public?" | No reason, returns business data | P0 |
| 11 | Bare state-machine transitions | Updates near `rg -n "status\s*[:=]"` | No precondition predicate, affected-row count ignored | P0 |
| 12 | Migration drift | Run all migrations on an empty database; diff schema against the live DB | Failure / hand-patched columns / missing indexes | P0 |
| 13 | Dependency vulnerabilities | `npm audit --omit=dev` / `pip-audit` / `govulncheck` | High severity and exploitable | P1 |
| 14 | Observability gaps | Look for logging / error reporting / health checks / request IDs | None at all, or only `console.log` | P1 |
| 15 | Resource caps | Body limits, pagination caps, file size, rate limits | No cap, or `take/limit` passed straight through | P1 |

**Scan-log format**: `file:line → suspicious point → why it is suspicious → how to verify`. Do not write fixes at this stage.

## 3. S2 · Deep dive along seven tracks

Execute each track as "check → criterion → evidence → default level". Tick applicable items; write "N/A + reason" for inapplicable ones.

### A. Buildable and releasable

| ID | Check | Criterion | Evidence | Level |
|---|---|---|---|---|
| A1 | Builds in a clean environment | No machine-local cache, no vendored dependencies | Build log | P0 |
| A2 | Healthy at startup | Health endpoint reports dependency status (DB/cache) | curl output | P0 |
| A3 | Complete config, fail-closed | Refuses to start or serve when security configuration is missing | Startup log | P0 |
| A4 | Migrations replayable | Full migration on an empty database succeeds | Migration log | P0 |
| A5 | Smoke script | Core path runnable with a single command | Script output | P1 |

### B. Data and migrations

| ID | Check | Criterion | Evidence | Level |
|---|---|---|---|---|
| B1 | Schema matches the database | `migrate status` shows no drift | Command output | P0 |
| B2 | Business unique keys enforced in the database | Every check-then-insert has a unique index behind it | Schema + conflict test | P0 |
| B3 | No zero-write columns / dead enums | Every column has a writer; every enum value has a producer | Static scan (QE-07) | P1 |
| B4 | Soft-delete coverage on the read side | Lists, details, counts, and exports all filter | Read-site inventory | P1 |
| B5 | Money and precision | Integer minor units; no floating-point accumulation | Schema + code | P0 |
| B6 | Backup and restore | Backups exist **and a restore has actually been rehearsed** | Restore record | P0 |

### C. Permissions and boundaries

| ID | Check | Criterion | Evidence | Level |
|---|---|---|---|---|
| C1 | Complete entry inventory | Routes/actions/queues/webhooks all listed | Inventory cross-checked against code | P0 |
| C2 | Every entry has an identity check | Every unauthenticated entry has a written reason | Entry table | P0 |
| C3 | Object-level authorization | Not just "logged in", but "does this row belong to this principal" | Escalation test cases | P0 |
| C4 | Schema validation on mutating entries | Allow-list, range/length caps | Crafted-request tests | P0 |
| C5 | Client never touches the server | No Prisma/node/server-only imports | Build output + static scan | P0 |
| C6 | Cross-module access only via public entry points | No deep relative imports into another module's internals | Import graph | P1 |
| C7 | Public routes registered with a reason | Reason non-empty, no expired registration | Config table | P1 |

### D. Concurrency and idempotency

| ID | Check | Criterion | Evidence | Level |
|---|---|---|---|---|
| D1 | Read–decide–write in one transaction | Money/stock/quota paths | Code + concurrency test | P0 |
| D2 | Optimistic lock or conditional update | Carries `version`/precondition, checks affected rows | Conflict test cases | P0 |
| D3 | Idempotent mutating entries | `Idempotency-Key` + dedup table in the same transaction | Replay test | P0 |
| D4 | Safe queue redelivery | Consumers idempotent, or at-least-once is tolerable | Redelivery test | P1 |
| D5 | Bounded and classified retries | Finite attempts, backoff, dead-letter queue | Config + logs | P1 |
| D6 | No external calls inside long transactions | No HTTP/file/queue work inside a transaction | Code scan | P1 |

### E. Adversarial input and resources

| ID | Check | Criterion | Evidence | Level |
|---|---|---|---|---|
| E1 | Request body limits | Enforced at gateway or framework layer | Oversized request test | P1 |
| E2 | Rate limiting | Login/submit/search/export | Load test or config | P1 |
| E3 | Pagination caps | `take/limit` has a hard ceiling | Oversized page request | P1 |
| E4 | No output leakage | No stack traces, SQL, internal paths, or full-row dumps | Error response samples | P0 |
| E5 | Log redaction | No plaintext tokens, phone numbers, ID numbers, card numbers | Log samples | P0 |
| E6 | Upload safety | Type/size limits, storage isolation, scanning | Malicious file test | P1 |
| E7 | Dependencies and images | High-severity findings have a disposition record | Audit output | P1 |

### F. Frontend state and experience

| ID | Check | Criterion | Evidence | Level |
|---|---|---|---|---|
| F1 | Persistence allow-list | Sensitive fields never persisted; explicit `partialize` | Browser storage inspection | P0 |
| F2 | Version migration | `version` and `migrate` come as a pair | Old-data injection test | P1 |
| F3 | Server data stays out of global stores | Request-library cache / explicit invalidation policy | Code + refresh test | P1 |
| F4 | Hydration consistency | No flicker or layout shift on first paint | Screen recording / console | P1 |
| F5 | Error boundaries and empty states | API failures degrade gracefully, no white screen | Network-off test | P1 |
| F6 | Double-submit protection | Disabled button / idempotency key | Rapid-click test | P1 |

### G. Observability and rollback

| ID | Check | Criterion | Evidence | Level |
|---|---|---|---|---|
| G1 | Structured logs | Request ID, user, error code, duration | Log samples | P1 |
| G2 | Metrics and alerts | Error rate/latency/queue backlog/DB connections | Dashboard screenshot | P1 |
| G3 | Error-code contract | External error codes stable and searchable | Contract table | P1 |
| G4 | Flags and progressive rollout | New features can be switched off; rollout by user/percentage | Flag inventory | P1 |
| G5 | Rollback scripts | Application rollback + data rollback/compensation | Rehearsal record | P0 |
| G6 | Runbooks | Common failures have steps and owners | Documentation | P1 |

## 4. S3 · Reproduce, rate, and fix

### 4.1 Evidence levels

| Level | Meaning | Usable for the release decision |
|---|---|---|
| E0 | Static suspicion (code/config) | Only "to be verified"; **cannot on its own justify a P0** |
| E1 | Reproduced by a unit test / crafted case | Yes |
| E2 | Reproduced at integration / API level | Yes |
| E3 | Reproduced in a real or production-shadow environment | Yes, highest priority |

> E0 is a lead, not a defect verdict. The release decision only accepts E1–E3.

### 4.2 Severity definitions

| Level | Criteria | Examples | Release handling |
|---|---|---|---|
| P0 | Data corruption / money error / privilege escalation / cannot start / cannot roll back | Duplicate charges, anonymous full-table reads, failed migration | **Must be zero** |
| P1 | Core path unavailable, or exploitable under specific conditions | Intermittent login failure, escalation requiring certain parameters, queue backlog | Fix, or written waiver + monitoring + deadline |
| P2 | Edge cases, performance regressions, UX issues | Slow large pages, missing empty states | May be scheduled; must be logged |
| P3 | Code quality / maintainability | Duplicated code, naming | Non-blocking |

### 4.3 Bug ledger fields (paste-ready)

| Field | Requirement |
|---|---|
| ID | `BUG-<module>-<seq>` |
| Title | One sentence: "under what condition, what happens" |
| Module/entry | file:line + entry name |
| Symptom | What the user or system observes |
| Root cause | Which constraint is violated (reference an INV-ID or a check ID) |
| Evidence | Level E0–E3 + reproduction command / fixture path |
| Severity | P0–P3 |
| Blast radius | Users / data volume / money / compliance |
| Fix | PR / commit |
| Re-verification | Regression fixture + reading |
| Status | Open / in progress / re-verified / waived (with reason and expiry) |

### 4.4 Fixing discipline

1. **Add the criterion before touching the code**: anything expressible as a guard or test must first be seen red against the old code, then fixed to green.
2. **Change one class of thing at a time**: do not refactor opportunistically inside a concurrency fix.
3. **Every fix needs a counterexample**: the bad fixture is built by someone other than the implementer; after the fix it must still exist and flip red→green.
4. **The baseline only tightens**: each legacy defect fixed is one fewer; new violations must never enter the baseline (QE-02).
5. **Irreversible actions**: dropping columns, rewriting historical data, or rotating keys requires a backup and a rollback rehearsal first.

## 5. S4 · Release decision (12 hard gates)

> If any gate is "no" without a written waiver, the only admissible verdicts are "no go" or "conditional go".

| Gate | Criterion | Evidence | Verdict |
|---|---|---|---|
| G1 Buildable | Clean-environment build succeeds | CI log | |
| G2 Migratable | Full migration on an empty database succeeds | Migration log | |
| G3 P0 cleared | Ledger P0 = 0 | Ledger | |
| G4 P1 dispositioned | Fixed, or waived (reason + monitoring + expiry + owner) | Ledger | |
| G5 Permission matrix | Every entry in the table has an identity check; escalation cases pass | Test cases | |
| G6 Core-path e2e | Login → core business → payment/submit → query all pass | e2e report | |
| G7 Data constraints | All four applicable items (unique keys / transactions / idempotency) have evidence | Code + tests | |
| G8 Security baseline | Secret scan clean, no known high severity, no output leakage | Scan output | |
| G9 Resource caps | Body size / pagination / rate limit applicable items configured or explained | Config | |
| G10 Observability | Error rate / latency / backlog dashboards + alert recipients | Screenshots | |
| G11 Rollback | Application rollback + data compensation rehearsal passed | Rehearsal record | |
| G12 Production smoke | Smoke passed in a production-equivalent environment | Smoke output | |

**Verdict outputs**

- **Go**: G1–G12 are all "yes".
- **Conditional go**: only G4/G9/G10 may be "conditional", and each must state: the condition, the monitored metric, the decision owner, and the expiry.
- **No go**: any of G1/G2/G3/G5/G6/G7/G8/G11 is "no".

> "Ship it and watch" is not a verdict, it is a gamble. If you must take the risk, write down the blast radius, the rollback trigger, and the on-call owner.

## 6. Common false greens (rule each one out)

| False green | Why it misleads | How to rule it out |
|---|---|---|
| Guard reports green after scanning 0 objects | Vacuous truth | Check the `scanned=` count; 0 objects must be skipped or an error |
| Tests cover only the happy path | Error branches never execute | Build failure / escalation / replay cases |
| It runs on my machine | Depends on local cache and hand-made data | Clean environment + empty database |
| Tests have no assertions | Running through is not being correct | Inspect assertions and failure injection |
| Logs show no anomalies | Errors swallowed or never recorded | Inject a failure and check observability |
| All mocks pass | Real contracts drift | Contract tests / joint debugging |
| Authorization disabled in the test environment | Only production exposes it | Keep environments isomorphic |
| The database has seed data | Masks migration and constraint problems | Replay on an empty database |
| Only the HTTP entries were reviewed | Queues/schedulers/webhooks uncovered | Reconcile against the entry inventory |

## 7. One-page checklist (printable)

**S0**: build □ typecheck □ tests □ startup □ health □ migration replay □ environment variables □ secrets committed □ entry inventory □
**S1**: authorization □ validation □ dangerous execution □ XSS □ client boundary escape □ check-then-insert □ bare updates □ sensitive persistence □ swallowed errors □ public entries □ state machines □ migration drift □ dependency vulnerabilities □ observability □ resource caps □
**S2**: A1–A5 □ B1–B6 □ C1–C7 □ D1–D6 □ E1–E7 □ F1–F6 □ G1–G6 □
**S3**: P0 ledger □ every item has E1–E3 □ every fix has a counterexample □ baseline went down □
**S4**: G1–G12 □ decision report □ rollback rehearsal □ on-call owner □

## 8. Delivery templates

### 8.1 Bug ledger (Markdown)

```markdown
| ID | Title | Entry/File | Root cause (INV/check) | Evidence | Severity | Impact | Fix | Re-verification | Status |
|---|---|---|---|---|---|---|---|---|---|
| BUG-RECORD-01 | Duplicate submission creates two records | app/api/records/route.ts:POST | INV-WEB-03 / D3 | E2 replay script | P0 | Money | #123 | Regression case passes | Re-verified |
```

### 8.2 Release decision report (Markdown)

```markdown
# Release decision · <project> · <date>
Verdict: go / conditional go / no go
Scope: <version/commit>

## Gate results
| Gate | Result | Evidence |
|---|---|---|
| G1 Buildable | Yes | CI #... |

## P0/P1 ledger
<link or table>

## Conditional items
| Condition | Monitored metric | Decision owner | Expiry |
|---|---|---|---|

## Rollback plan
Application rollback: <command/version>
Data rollback/compensation: <steps>
Trigger: <error rate / money discrepancy / latency threshold>
On-call owner: <name / contact>

## Residual risk
<State explicitly what risk was accepted, why, and when it will be re-evaluated>
```

## 9. Working with automated guards

| Audit item | Automated (this toolkit) | Still manual |
|---|---|---|
| C2/C3 Authorization | `inv20` checks "does it exist" | Whether object-level authorization is complete |
| C4 Validation | `inv20` checks "is there schema validation" | Whether ranges and allow-lists are correct |
| C5 Client boundary escape | `inv21` | Aliases / barrels / dynamic imports |
| C6 Cross-module access | `inv21` (relative paths) | Aliases and package boundaries |
| B3 Zero-write columns / dead enums | `inv01` / `inv03` | Whether the semantics are correct |
| D3 Idempotency | `inv20` warns | Whether dedup is persisted, in the same transaction |
| F1/F2 Persistence | `inv22` | Correctness of the migration function |
| Baseline regression | `ratchet` | Whether the verdict is sound |

> Automation covers **shape**, not **meaning**. `green` does not mean "safe"; it means "this one criterion was not violated".

## 10. Wrap-up

- The ledger and the decision report must be independently reproducible by the next person: commands, versions, environment, and data state written out in full.
- Every waiver has an expiry; an expired waiver automatically returns to P1.
- For 24–72 hours after release, review via the G10 dashboards: error rate, latency, queue backlog, money/inventory discrepancies; any anomaly triggers the rollback conditions.

### 10.1 When to stop mining (the graduation criterion)

Mining has an economic endpoint. Do not decide it by feel; read it:

```bash
npx autoqe status --root .
# DECISION STOP-MINING reason="last two batches produced 1 / 0 true holes (<1 for two batches)"
```

| Verdict | Trigger | What to do |
|---|---|---|
| `REPAIR` | any guard error or ratchet regression | fix first; adding audit batches now hides the red |
| `ADJUDICATE` | an `open` invariant passed its `revisitBy` | upgrade / renew with a reason / move to runtime compensation |
| `STOP-MINING` | last two batch ledgers each produced **< 1 true hole** | switch from mining to runtime netting |
| `INSUFFICIENT-HISTORY` | fewer than two judged ledgers | an empty or single-batch history never proves "keep going" |
| `CONTINUE-MINING` | output still ≥ 1 true hole per batch | run the next batch and record it |

**True hole** = a ledger row whose severity is exactly `P0`/`P1` and whose evidence is `E1`–`E3`.
`E0` rows are leads and are reported separately; they never inflate the curve.

On `STOP-MINING`, move the remaining risk to reconstruction and monitoring: reconciliation invariants
(ledger / counter / balance), alerting-channel self-check, canary rollout, and a weekly reconciliation probe.
Record the accepted residual risk in the release decision (section 8) so the next person knows what was
deliberately not mined.

### 10.2 The triage layer: fix / decide / record

A findings list is not a work plan. Every non-info finding must land in exactly one bucket, so the next
actor (human or AI) never has to invent a priority:

| Bucket | Meaning | Who acts | Output |
|---|---|---|---|
| **fix** | one mechanically correct action exists | the tool, or anyone | exact action; `--apply` only for additive, reversible edits (guard aliases) |
| **decide** | 2–3 defensible options with different trade-offs | a human | recommended option + alternatives |
| **record** | does not affect runtime; only traceability is missing | nobody | waiver: reason + `reviewBy` written into `qe/waivers.json` |

```bash
npx autoqe triage --root .
# TRIAGE actionable=3 fix=1 decide=2 record=0 waived=0 waiverIssues=0 skipped=0
# TRIAGE_TODAY 1) [MUTATION_NO_IDEMPOTENCY] impact=money effort=L ...
npx autoqe triage --from-report qe-report/qe-report.json   # same judgment over an existing report
npx autoqe waive UNWIRED_SCRIPT --reason "kept for ops" --review-by 2026-12-31
```

Rules that make the layer trustworthy:

1. **Unknown codes are `decide`, never `record`.** An unregistered finding cannot be silently waived.
2. **`fix` means one answer.** If two reasonable actions exist, it is `decide` — even if one looks obvious.
3. **`record` never hides a runtime risk.** It is for traceability gaps (unwired scripts, orphan guards), not for defects.
4. **The today list is capped (5) and ordered by ROI.** Findings sort by disposition, then impact
   (`money` > `auth`/`pii` > `data` > `trace`), then effort (`S` < `M` < `L`), so the queue starts with the
   expensive-to-ignore, cheap-to-fix items.
5. **Zero findings ≠ safe.** `skipped` and scanned-object counts are printed next to the result; an empty set never prints a pass.
6. **A waiver is a dated liability, not a delete key.** It suppresses a finding only while its entry carries a
   reason and an unexpired `reviewBy`; the suppressed finding still shows as `TRIAGE_WAIVED`. An expired entry
   suppresses nothing and surfaces as `WAIVER_EXPIRED`; a malformed one is `WAIVER_INVALID` and suppresses
   nothing. There is no permanent waiver.

The policy table is a single source in `qe/lib/triage.ts`; `npm run test:triage` fails when a guard emits
a code without a disposition, so the judgment layer cannot silently fall behind the guard layer.

---

**中文摘要**：通用体检作业单：S0 事实基线 → S1 快扫 → S2 深挖 → S3 定级 → S4 十二道上线闸。
