# QE-04 · Audit Methodology: Nine Defect Classes

> **Status**: living document, no version suffix.
> **Positioning**: single source for the defect taxonomy (definitions, typical failures, remedies). The mandatory action checklist lives in [QE-00-index.md](QE-00-index.md); evidence grading for assertions lives in [QE-03-project-audit-and-release-gate.md](QE-03-project-audit-and-release-gate.md); ex-ante invariant design (definition, stopping layer, retirement, irreversible actions) lives in [QE-05-invariant-spec.md](QE-05-invariant-spec.md).
> **Reuse note**: this document grew out of an audit of a real product repository. "The reference implementation's scripts" refers to that repository's tooling; substitute equivalents when adopting it. Class definitions and criteria forms carry over unchanged.
> **Boundary**: never maintain a second invariant list here. Entries are single-sourced in [`qe/registry/registry.ts`](qe/registry/registry.ts) and rendered by `npm run qe:list`. Every `defectClass` in the registry must map to one of the nine classes below; an invented extra class is rejected by `inv13`.

## 1. The nine classes at a glance

| # | Class | Prevalence and risk | One-line definition | Remedy (mechanism) |
|---|---|---|---|---|
| 1 | Drift | Most frequent | The same fact is described in two or more places, and no mechanism keeps the descriptions synchronized | Single-source discipline + consumer inventory + discovery-based drift check |
| 2 | Seam | Not the most frequent, but the most dangerous; every critical finding lands here | Two individually correct modules whose protocol at the boundary does not line up | Centralize invariants: in-lock transactions, conditional atomics, scope × account-kind matrix, value-set imports |
| 3 | Registry failure | The most stubborn; keeps recurring | The lock and the gate exist, but the lock's list is maintained by hand and a human forgets | Discovery-based registration (aliases and bare tests found automatically) + compile-time enum lock + critical write-site roster |
| 4 | Built but not wired | Defense in name only | The design exists and the code is written, but the last hop was never connected | Wire every guard to a call site + runtime smoke proof + "a comment cheque must be cashed or booked as debt" |
| 5 | Latent trap | Works here, explodes elsewhere | The toolchain and behavior produce zero local errors and only surface in another environment | Verify tracked files with `git ls-files` in the release checklist + repo-wide ignored-file audit + clean-clone test |
| 6 | Insufficient evidence | A single sample is used to make a population claim | The evidence cannot support the weight of the conclusion | Pre-declare the evidence threshold; distribution claims require population-level or statistically adequate sampling |
| 7 | Test methodology | False green, stale assertion, wrong probe placement | The assertion itself is wrong, so green does not prove correctness | Mandatory negative controls + consumer inventory (assertions are consumers too) + probes inside `try` + a projection layer that distinguishes selected from derived columns |
| 8 | Concurrency correctness | Several holes per domain; write paths are commonly affected | A timing defect that appears when two individually correct writers arrive together (check-then-act, read-modify-write, reserve-without-release) | Four-rule static scan + ratchet baseline + at-least-8-way barrier probes |
| 9 | Defense illusion | One finding is high severity, and it invalidates every defense built above it | The defense has the right shape, but an automated attacker's cost is approximately zero, or the defense is itself the attack surface | Four-question cost accounting + zero-cost path elimination + every defense states what it does not block |

Read this table as a routing table: when a finding appears, name its class before discussing a fix. A finding that fits none of the nine is either not yet understood or evidence that the taxonomy needs a deliberate extension. It is not a licence to invent a class quietly.

## 2. Class by class: definition, typical failure, remedy

### 2.1 Drift

**Definition.** The same fact is described in two or more places, and no mechanism keeps the descriptions synchronized.

**Typical failure.** Two documents disagree about the same limit; a specification says a decision is still open while the code has already shipped it; a generated artifact is edited by hand and then overwritten by the next generation. Each copy is locally consistent, which is why nobody notices.

**Remedy.** Every fact has exactly one authoritative home, and every consumer points to it. A consumer inventory rule forces each new consumer to declare its source. A drift detector compares the sources automatically instead of asking reviewers to remember. Generated artifacts are regenerated, never edited.

### 2.2 Seam

**Definition.** Two individually correct modules whose protocol at the boundary does not line up.

**Typical failure.** Five shapes recur:

- **Transaction boundary.** A two-phase transition is split across two transactions, and a failure between phases leaves no compensating leg.
- **Cross-process race.** A background job and a user-triggered flow act on the same row without a shared claim.
- **Permission matrix.** An authorization check is correct for one account kind and silently permissive for another.
- **Status predicate fork.** One guard reads a derived flag while the single source of truth is a status set; legacy rows diverge between the two.
- **Entry-path bypass.** A second trigger (HTTP endpoint, queue, cron) skips the re-entrancy protection of the main entry.

**Remedy.** Centralize invariants: state transitions complete inside one transaction or one lock, conditional updates carry their predicate, permission is expressed as a scope × account-kind matrix, and status value sets are imported from one module. At intake, require a seam protocol draft covering four vectors: permission matrix, transaction boundary, status criteria single source, and entry inventory. Missing any vector blocks implementation.

### 2.3 Registry failure

**Definition.** The lock and the gate exist, but the lock's list is maintained by hand, and a human forgets to update it.

**Typical failure.** A new test alias is not added to the runner's list and silently never runs; a test file never enters the gate at all; an enum lock enumerates strings, so a newly added value passes through; a new privileged writer is absent from the roster. The mechanism looks present and is silently incomplete.

**Remedy.** Make registration a side effect of defining the thing rather than a human action: aliases and bare test files are discovered automatically, enums are locked at compile time, and critical write sites are discovered from the model. Positive evidence matters: a roster guard that catches real new writers on its first live runs is a working mechanism, not decoration.

### 2.4 Built but not wired

**Definition.** The design exists and the code is written, but the last hop was never connected, so the facility is ornamental.

**Typical failure.** A guard has zero production call sites; a client calls an endpoint that was never implemented; a column exists but production never writes it, so the funnel reads zero forever; a comment promises behavior the code never implemented. The last case is the expensive one: comments are cheques, and an uncashed cheque becomes a defect the moment a consumer relies on it.

**Remedy.** Wire every defense into a call site and prove it at runtime with a smoke probe. Adopt the rule that a comment cheque must be cashed or booked as debt, with an owner and a trigger.

### 2.5 Latent trap

**Definition.** The entire toolchain and behavior produce zero errors locally, and the problem only appears in another environment.

**Typical failure.** An unanchored ignore pattern hides production files and documentation; migrations exist locally but are never committed; sandbox restrictions make tests fail only on one machine; a suite fails in a full run but passes alone because of database residue. Locally everything is green; a clean clone is missing files.

**Remedy.** Verify tracked files with `git ls-files` in the release checklist, audit ignored files across the repository, and run a clean-clone test. Environment-specific readings must not become CI assertions, because they encode the machine rather than the code.

### 2.6 Insufficient evidence

**Definition.** The evidence cannot support the weight of the conclusion.

**Typical failure.** A single smoke run is used to claim a distribution is healthy, and a later population-level run shows that most cases exceed the limit. Or a checklist confirms a dozen items on the specification surface while the seam surface is full of holes.

**Remedy.** Pre-declare the evidence threshold for the claim. A statement about a distribution requires population-level or statistically adequate sampling, not one convenient point. Move the audit from "the checklist is complete" to "the seams have been examined".

### 2.7 Test methodology

**Definition.** The assertion itself is wrong, stale, or placed where it cannot observe the behavior, so green does not prove correctness.

**Typical failure.** A cross-assertion with no negative control passes even when the parameter is not wired; a contract changes but the assertion keeps the old shape; a debug probe sits after `finally` and asserts on already-cleaned data; a derived column is masked by its own whitelist.

**Remedy.** Negative controls are mandatory. Inventory assertions as consumers of the contract. Put probes inside `try`. Make the projection layer distinguish selected columns from derived columns. A test that cannot fail for the intended reason is not evidence.

### 2.8 Concurrency correctness

**Definition.** A timing defect that appears when two individually correct writers arrive at the same resource at the same moment.

The first seven classes assume a single writer. A concurrency defect is not drift, not an unaligned seam protocol, and not a wrong assertion; it is the timing between two writers that are each locally correct. Per-domain manual probing does not converge: defects cluster by write-path family, and a repository has many such paths.

**Three systemic root causes.**

1. **The default idiom produced by code generation is wrong.** Check-then-act, `update` followed by `if (!updated)`, `findFirst` followed by `create`, reserve-without-release, and read-modify-write are one family. Any write path that has not been reviewed specifically from a concurrency angle is likely to contain one of them.
2. **The verification system assumes a single thread.** No gate fires N concurrent requests at the same resource. `Promise.all` with two requests often serializes them; when timing is staggered, the race window is never hit. A green gate is not proof of concurrency correctness.
3. **Prior hardening covers replay, not concurrency.** Binding a token to a scope prevents using the same token twice; it does not prevent two different requests from consuming it simultaneously. Each domain's hardening stops at the hole found that day.

**Mechanism: scan for the pattern family.**

| Rule | Pattern | Why it is a bug |
|---|---|---|
| A1 | `update()` return value checked for null | The ORM throws when no row matches instead of returning null, so the guard is dead code |
| A2 | `update()` with a composite `where` | Semantics rely on an exception instead of an affected-row count; "lost the race" and "real failure" are indistinguishable |
| B1 | `findFirst` existence check, then `create` | Check-then-act; without a unique constraint both inserts succeed; with a constraint but no conflict handling the loser becomes a 500 |
| C1 | A database counter is reserved before an external call and not released on failure | The quota burns until the circuit breaker trips and the whole surface goes down |
| C2 | An in-process sliding window is reserved before the call and not released on failure | Users are throttled for requests that never happened |
| D1 | `data: { x: row.x + 1 }`, including indirect forms | Read-modify-write loses updates; an attempt limit records fewer attempts than actually occurred |

Three implementation requirements, each learned the hard way:

- **Constraint facts must include the migration layer.** A schema file may not express a partial unique index. A scanner that reads only the schema reports database-protected paths as holes. Parse `CREATE UNIQUE INDEX` statements, including their `WHERE` predicates, from migrations and attach them to the model.
- **Known safe forms must be explicitly exempted.** Compare-and-set with an affected-row count, atomic increment, reservation inside a transaction (rollback-able), check-then-act inside an advisory lock, bulk insert with duplicate skipping, and `create` with a unique-violation catch. Otherwise noise teaches reviewers to ignore the scanner.
- **The detector must self-test on the gate's default path every run.** A broken detector reports zero findings, which is the most dangerous false green. Include negative fixtures that must not be reported.

**Ratchet.** Legacy debt cannot be cleared in one batch, so neither "all green or fail" nor a blanket exemption is acceptable. Each baseline entry carries a mandatory reason and one of two statuses: `debt` (confirmed hole, to be fixed) or `safe` (adjudicated safe, with the mechanism named). Three conditions are red: a hit not in the baseline (a new hole); a baseline entry that is no longer found (stale, and fixing it requires deleting the entry); an entry with an empty reason. Counts may only go down.

**Probe discipline.** At least 8 workers are released on the same tick by a barrier, so the first I/O lands in the same event-loop tick. Financial, credential, inventory, and state-transition write paths all start at 8, with multiple rounds. Pair every positive assertion with negative controls: "exactly one winner" must be paired with "the second sequential attempt must fail" and "a single caller must succeed", otherwise an implementation that always returns false also passes. A new probe must fail against the old implementation before it is accepted. Database probes clean up after themselves with tag-scoped cleanup and assert that cleanup succeeded.

**Rule E candidate.** "Read, then write, in the same function" is a separate sub-form that rules A–D cannot see. Static reading looks fine: there is a `WHERE`, a condition, an idempotency key. What is missing is mutual exclusion between the two I/O operations: the snapshot read at the start can be invalidated by another writer, while the later write still admits it. Proposed rule: if a `SELECT`ed value is used as a predicate in a later `UPDATE ... WHERE`, that value must also appear in the `WHERE`; otherwise the write is conditioned on a stale snapshot.

**Convergence.** Debt zero; every high-risk write path has a committed at-least-8-way probe; one full regression is green. After that, new code is covered by scan rules plus a probe template rather than by manual review. Which paths are high-risk remains an adjudication matter, not something the scanner decides.

**Relationship to the other classes.** The distribution of concurrency defects is scannable because it is one idiom family, so rule enumeration is better than per-domain probing. This does not replace surgical audit. Whether a unique constraint is semantically right, or whether a counter is a quota rather than bookkeeping, are business decisions. The machine can present the complete list and force the decision into the open; the baseline reason is the record of that decision.

### 2.9 Defense illusion

**Definition.** The defense has the correct shape, but its actual cost to an automated attacker is approximately zero, or the defense itself has become an attack surface.

This class removes an assumption shared by the first eight: that the defense is effective and only its seam, timing, or registration is wrong. It is worse than a concurrency hole. A concurrency hole means "the defense has a hole"; a defense illusion means "the defense does not exist, but looks as if it does", and every quota, circuit breaker, or rate limit built on top of it is defending nothing.

| Form | Typical instance | Why static scanning misses it |
|---|---|---|
| **Transparent defense** | A CAPTCHA rendered as literal text in the response body, so a one-line regular expression passes every challenge | Generation, expiry, and one-time consumption all exist; the defense hands the answer to the attacker |
| **Defense becomes attack surface** | A global rate limit that an attacker can trip with a handful of requests, denying service to every legitimate user | The limiter works as designed; triggering it costs the attacker less than the attack gains |
| **Wrong defense object** | A one-time-code attempt counter keyed by an identifier the attacker knows, so anyone can exhaust a victim's attempts | Counting, invalidation, and compare-and-set all exist; the attacker chooses the identity the defense keys on |

**Four questions per defense.**

1. **What does one attempt cost the attacker?** If it is free, the defense is red; do not ask the remaining questions.
2. **Does the defense's output contain the answer?** Check the response body, error text, length, timing, and rendering method.
3. **When triggered, does it also hurt legitimate users?** State what it blocks and what it does not block. A circuit breaker that also blocks verification of already-issued credentials converts a defense into an outage.
4. **Who chooses the object the defense keys on?** If the key is attacker-controlled, bind it to a credential the attacker cannot choose: a nonce, a session, or a signature.

One-line criterion: **when the attacker decides who can trigger the defense, its strength equals the attacker's cost, not your implementation quality.**

**Convergence.** Every public write entry (unauthenticated or weakly authenticated) has one "attacker cost per attempt" line in the threat model; zero-cost paths are eliminated; every defense documents its collateral damage and what it does not block, with a guard that keeps that statement honest.

**Why this belongs to methodology, not to a security specification.** Its criterion is cost, not implementation, and it applies across authentication, notification, value transfer, and session domains. Written as a checklist it gets ticked, and the defining property of this class is precisely that the code looks entirely correct.

### 2.10 Beyond the nine classes: seven deeper questions

The first nine classes ask "is this code correct?". After they are suppressed, the remaining incidents sit in four assumptions: everything succeeded; every step was legitimate; each domain is independent; the stored data is still self-consistent. The deeper audit does not add another coding rule; it replaces the question seven times.

| New question | Axis |
|---|---|
| Is this code correct **under failure** (request sent, response lost, late, or duplicated)? | Failure injection |
| How much can a **rational bad actor** earn from this flow while passing every gate? | Economic abuse |
| Can two **individually low-risk** holes be chained into one attack? | Combinatorial attack |
| Does the stored data **right now** still satisfy the ledger identities? | Reconciliation invariants |
| What happens if this cron **silently stops for three days**? | Time surface |
| Does this endpoint trust an **identifier supplied by the caller**? | Permission and input surface |
| What did our audit **not see**? | Meta-audit |

Three design principles apply to all seven:

- **Ledgers, graphs, and coverage maps are not detectors.** They do not judge code; they judge the completeness of conclusions. A machine can check that every flow was counted, every chain was adjudicated, and every cell was seen. It cannot check whether the adjudication was right.
- **External facts have no code anchor.** Demanding one normalizes the wrong thing. Record the source and the party bearing the cost instead.
- **Domain-level and surface-level blind spots are different.** A single guard on one surface does not clear the whole domain. Chains must be enumerated automatically; a hand-maintained list always loses exactly the entry nobody thought of.

## 3. The audit process

1. **Pre-work.** List at least three ways the feature can fail silently, each with the form the silence takes. List the touch surface (tables, columns, enum values, contract keys, gates, controls), the seam inventory (who calls this module, what it calls, its public entry, and the cross-module import path), which invariant is violated or added, which layer stops it, whether any action is irreversible, and what the counter-example is.
2. **Classify before fixing.** Name the defect class. A finding that fits none of the nine is not yet understood; do not start coding around it.
3. **Check in a fixed order.** Invariant table first (seconds), then guards (minutes), then e2e, then manual sampling. Reversing the order spends minutes to learn what a table could have answered in seconds.
4. **Design the criterion and the bad fixture before the fix.** The bad sample is constructed independently of the implementation. The author's own green is not accepted as proof.
5. **Mechanize and ratchet.** Register the invariant, wire the guard into the gate, add the alias, add the self-test case, and only then freeze a baseline. A mechanism that depends on someone remembering is still class 3.
6. **Declare blind spots and convergence.** Every class has stop conditions. State what the round did not see, then stop when the conditions are met instead of digging indefinitely.

## 4. Criteria discipline

### 4.1 Invariants over test cases

A use case asks "is this path correct?". An invariant asks "does this statement hold for every instance?". Tests enumerate; structural defects outrun enumeration. A codebase can have thousands of green tests and still violate the same invariant in a path nobody wrote a test for.

### 4.2 What makes a criterion admissible

A criterion is admissible only when it has all six properties:

- **Anchored**: it names the invariant it protects, not just the symptom.
- **Falsifiable**: there is a bad fixture that makes it red for the intended reason.
- **Recomputable**: the command that produces the number and its group counts are recorded. A hand-counted total is not evidence.
- **Scoped**: it states what it covers and what it does not.
- **Non-vacuous**: scanning zero objects is `skipped` or an error, never green. Vacuous truth over an empty set is the most common way a gate lies.
- **Addressable**: it is registered, aliased, self-tested, and reached by the default gate.

### 4.3 Bad fixtures and negative controls

A guard is not trusted until it fails against a bad sample constructed independently of the implementation, by someone other than the author. An author's own green is not accepted as proof. Self-tests must include both directions: the good fixture stays green, the bad fixture goes red, and the reason for the red is the intended one. Injection tests follow the same loop: inject a defect, observe red, restore, observe green. A probe that passes against the old implementation proves nothing; it must be run against the old code first.

### 4.4 Common false greens and how to falsify them

| False green | Why it passes | Falsification |
|---|---|---|
| Two-way concurrency "passed" | The two requests were serialized by scheduling | Use an at-least-8-way barrier on the same tick, with multiple rounds |
| Both sides of an assertion are equal | The parameter was never wired; the assertion is a tautology | Add a negative control: unwire the parameter and require red |
| The probe passes against the old implementation | The probe asserts an implementation detail, not the invariant | Run the probe on the old code before accepting it |
| The detector reports zero findings | The detector is broken, or it scanned zero objects | Positive and negative self-test fixtures on the default path; non-vacuity rule |
| A single sample is green | A distribution was never measured | Population-level or statistically adequate sampling, declared in advance |
| A hand-counted total is green | A group was missed; the total simply got smaller | Emit a machine summary with a group roster; a missing or empty group is red |
| An exemption table is always true | The registry claims a check that was later deleted | Grep for the guard or predicate; its absence is red |
| A guard exists but never runs | The alias was never registered | Discover aliases automatically; discovery, not a maintained list |
| The defense is shaped correctly | The answer is in the response, or the trigger is free | Cost accounting: one attempt must cost the attacker something |

### 4.5 Criteria judge invariants, not implementations

A criterion written against the current implementation becomes insensitive to the exact change it was meant to catch. A probe that asserts "compensation implies no shipment row" can stay green when the stage predicate changes, while a probe that asserts "value has left the account implies the case must be closed" catches it. This is why probes name invariants.

It also implies a review rule: after a fix, re-check the neighboring faces against the same invariant table. Verifying only that the original symptom disappeared is how a fix creates the next hole. "Admission strict, closure wide" is the same idea on closure paths: once value has already left, ask "will continuing mis-record the books?" rather than "do the original admission conditions still hold?".

### 4.6 Measurement discipline

- **Numbers before prose.** Run the command, paste the raw summary line, then write the conclusion. If the order is reversed, every later baseline is paying interest on a conclusion written before verification.
- **Counts come from the measuring program.** Each guard emits a machine-readable summary with its group roster. A missing group or a group with zero assertions is red. A pure total cannot reveal that a whole scenario was skipped, because the only symptom is a smaller number that is still green.
- **One authoritative count.** If the same guard produces two numbers, eliminate the second value rather than writing a convention about which one to quote. A convention is a registry rule in disguise.
- **Each number belongs to one action.** In a paragraph with several numbers, attach each one to the action it modifies. Do not take a paragraph-level total.
- **When numbers disagree, assume your measurement is wrong first.** Before accusing anyone of a false claim, measure twice with two independent methods: total against group detail, or a different execution path. A number you cannot reproduce is not grounds for an accusation.
- **Reports quote, they do not retell.** Quote the raw summary line. A retold count is unfalsifiable and starts the next drift investigation.

### 4.7 Conventions are not mechanisms

Every rule that says "remember to use X rather than Y" is waiting for its first failure. If a second value can be eliminated, eliminate it. The test is simple: if the fix is "add a sentence of explanation", it is probably not finished. A real fix makes the wrong form impossible to express.

The same logic applies to process shortcuts that require memory: a fast mode that must be remembered not to skip, a correction stored where nobody looks, an exemption that requires remembering to write a reason. Each is class 3 wearing different clothes.

### 4.8 Parking decisions

Not every fork can be decided by the implementer. Parking a decision is legitimate, but only with three parts: **a business sentence** (who is affected, and the cost of not doing it), **a default technical proposal**, and **a reopening trigger** (what condition reopens the decision). An item missing any part is not admitted; execute the default.

Classify by who bears the risk, not by how important the item sounds:

| Class | Test | Disposition |
|---|---|---|
| A: human decision | Changes a customer promise, ownership of money, or the severity of an irreversible action | Technical side supplies the default and its cost; does not write code unilaterally |
| B: default plus ratification | One side is clearly more reasonable, but implementation has business side effects | Implement the default; the owner ratifies or overthrows it afterwards, and an overthrow must record the original reason, the rebuttal, and the replacement exit |
| C: downgrade and park | Doing it now means building a defense against an attacker who does not exist | Collect data or observe offline; open a project when the first case appears |
| D: engineering queue | No business meaning at all | Never enters the parking ledger; schedule it directly |

If you cannot write the business sentence, the item is class D.

Two further rules apply before parking. **Second-order effects:** when fixing one hole raises another system's threshold, walk every consumer of the changed label and compute the cost for each. Compute the upper bound of the blocking period first, then decide whether to relax the gate or make the wait visible. Do not relax a state set merely to make the text look better; that reopens the hole just closed. **Reverse drift:** when the engine changes and the public text does not follow, that is drift in the opposite direction. The fix direction is text follows engine, never the reverse. An earlier "we chose not to" is a decision, not a fact; overturning it requires all three of the original reason, the rebuttal, and the replacement exit.

### 4.9 Exhaustiveness and blind spots

- **In-flight set and terminal set are two separate enumerations.** A missing in-flight state is a gate leak: the flow can be bypassed. A missing terminal state is a cooldown or idempotency failure: the flow can be replayed. Enumerate as a matrix of state × gate, not as a list of queries.
- **The application filter and the index must be widened in the same batch.** Changing only the index leaves the sequential path open; changing only the application leaves the concurrent path open. An index expansion needs a historical cleanup leg, or `CREATE UNIQUE INDEX` blocks deployment on the first production run.
- **Exemptions are decisions, not amnesia.** An exempt domain must state why it should have no guard. A guard appearing in an exempt domain is red, because the exemption was wrong.
- **A dangling public reference is a promise not kept.** "The published limit" must point to a carrying page and paragraph. If it cannot, the reference is dangling, and any number rendered there must come from config in one direction, never be copied by hand.
- **External facts have no code anchor.** For facts owned outside the codebase, record the source and the party bearing the cost; requiring a grep anchor would normalize the wrong thing.

### 4.10 Detector self-testing

Detectors have false greens too: a regular expression that fails on a different line ending, a key match that is case-sensitive, a line-level scan that misses a value propagated through a variable, a criterion pointed at the wrong table. The failures are not symmetric. A syntax error is caught by the database; an ordering error is caught by generated data; a **semantic** error surfaces as "the alert fires on a pile of legitimate data", which teaches everyone to ignore the alert.

Every detector therefore ships with positive and negative fixtures on the default path. Noise is a defect with the same severity as a miss, because it destroys the credibility of the gate.

## 5. Ratchet

A ratchet is a count that may only decrease. It exists because legacy debt cannot be fixed in one batch, and because both alternatives are worse: "all green or fail" hides debt, and a broad exemption hides it permanently.

**Each baseline entry carries:**

- a stable key (guard and finding identity),
- a count,
- a status: `debt` (confirmed, to be fixed) or `safe` (adjudicated safe),
- a mandatory reason; for `safe`, the reason names the mechanism, not a feeling,
- an owner and a review trigger.

**Three conditions are red:**

1. A hit that is not in the baseline: a new hole, or an old entry that drifted. Fail immediately.
2. A baseline entry that is no longer found: stale. Fixing a hole requires deleting its entry; the baseline is monotone and may not be kept alive by exemption.
3. An entry with an empty reason: red. "Add it to the allowlist first" is not a decision.

**Changing the baseline** goes through the designated command, and the commit message records the key, the old value, the new value, and the reason. New violations never enter the baseline. Lowering is automatic; raising requires a recorded decision and is treated as a regression.

**Scope.** Ratchets apply to findings per guard and finding, to blind-spot counts, to per-file noisy-log counts, and to exemption tables. In every case the rule is the same: deliberate shrinkage, no silent growth.

**Convergence follows from the ratchet.** When debt reaches zero, the class is mechanically suppressed; new code is held by the scanner and the fixture, not by review attention. A ratchet that never converges is either measuring the wrong thing or has become a place to park work.

## 6. Lifecycle and maturity

### 6.1 The audit front moves upward

The classes are not a flat list; they have a suppression order. Once drift and dead wiring are held by mechanisms, new findings concentrate at module boundaries. Once boundaries are held, findings move to timing and to the semantics of the defense itself.

The trajectory is: **"are the documents right?" → "is the code built?" → "are the boundaries right?" → "is the defense real?"** A lower layer that is locked by a mechanism stops producing findings; the defect population migrates to the next layer. This is why auditing only the current layer eventually looks clean while the system is not.

### 6.2 Maturity stages

| Stage | Practice | What it can see | What it cannot see |
|---|---|---|---|
| 1. Reactive | Fix individual cases as they appear | The symptom in front of you | Recurrence; the same root cause elsewhere |
| 2. Checklist | Enumerate items and tick them | Known categories | Seams and combinations not on the list |
| 3. Discovery-based registry | Registration is a side effect; guards are wired; bad fixtures exist | Whether the mechanism is present and addressable | Whether the criteria are correct |
| 4. Ratchet and invariant centralization | Counts only fall; invariants sit at boundaries; probes cover high-risk paths | Regressions and boundary protocol drift | Failure behavior, cost, and data consistency |
| 5. Cost-aware adversarial and continuous reconciliation | Attacker cost accounting, deeper audit axes, hourly ledger identities, meta-audit | What automated abuse and accumulated drift can do | What production traffic will still reveal |

The stages are cumulative. A team at stage 5 still needs the checklist, but it no longer treats the checklist as the audit.

### 6.3 Lifecycle of a defect class

A class matures through the same path as a single defect: **case → rule → detector → ratchet → zero → template**. The last step matters. Once a rule is stable, it becomes a template question in intake and review, and the original case history is no longer needed. The methodology survives; the anecdote retires.

### 6.4 Stop conditions and the last net

Every class has convergence criteria. Typical forms: debt zero; unknown or unclassified equal to zero; every high-risk write path has a committed probe; every public write entry has a cost line; every ledger identity runs continuously and a drift freezes the relevant write path; a full regression is green.

Stop when the criteria are met. Digging without a criterion converts audit into an infinite backlog and makes the next round indistinguishable from the current one.

No audit sees everything. The final net is **reconciliation invariants**: identities that must hold at any instant, run on a schedule, with drift routed to alerting and to a write-path freeze. They do not replace the classes; they cover the paths nobody wrote a guard for. Production traffic remains the only test that observes what the audit could not.

## 7. Anti-pattern list

**Process**

- Bypassing hooks or gates with `--no-verify` or an equivalent escape.
- Putting a new violation into the baseline instead of fixing it or registering it as `open` with a reason.
- Marking an invariant `enforced` without a criterion, or leaving it `open` without a reason and a review trigger.
- Maintaining a second invariant list in a document. The registry is the single source.
- Writing environment- or time-sensitive readings into CI assertions.
- Reporting green when the guard scanned zero objects. An empty set makes every universal statement true.

**Criteria**

- Accepting a criterion because the author's own test is green.
- Using a probabilistic assertion ("run it a hundred times and see") when a deterministic interleaving can be constructed.
- Accepting a probe that also passes against the old implementation.
- Judging an implementation detail instead of the invariant.
- Keeping a criterion after its contract changed, without updating the shape of the assertion.
- Treating noise as acceptable. An alert that fires on legitimate data trains everyone to ignore it.

**Registration and wiring**

- Relying on a hand-maintained alias list, roster, or enum. That is class 3 by construction.
- Building a guard that is never called from production or from the default gate.
- Approving a registry table that cannot be falsified by code. A table that is always true is worse than no table, because it stops reviewers from reading the code.
- Adding a defense without stating what it does not block.

**Measurement**

- Hand-counting a total and quoting it in a report.
- Quoting a number without the command and the group breakdown that produced it.
- Writing a convention ("compare against this field, not that one") instead of eliminating the second value.
- Accusing a teammate of a false claim on the basis of one measurement. Measure twice, with two methods, first.
- Reporting numbers before they exist.

**Repair**

- Widening an application-layer filter without the index, or the index without the application-layer filter.
- Changing one of two rulers that measure the same fact. Both must change in the same batch.
- Relaxing a gate to make the text look consistent. The text follows the engine.
- Verifying only that the original symptom disappeared, without re-checking the neighboring faces against the invariant table.
- Fixing a hole and declaring the whole chain blocked when only one leg was cut.
- Treating an exemption as a place to forget rather than a decision with a reason and a trigger.

## 8. Revision history

- Initial publication: 2026-10.
- Added concurrency correctness as class 8, with the rule family, ratchet semantics, and probe discipline.
- Added defense illusion as class 9, with four-question cost accounting and zero-cost path elimination.
- Added the seven deeper audit axes: failure injection, economic abuse, combinatorial attack, reconciliation invariants, time surface, permission and input surface, and meta-audit.
- Added criteria discipline: admissibility, negative controls, false-green falsification, measurement rules, parking decisions, and stop conditions.
- Editorial pass for public release: internal case identifiers, product-specific details, and internal metric readings removed; case histories compressed into generalized lessons. Definitions and criteria forms unchanged.

---

**中文摘要**：把反复出现的缺陷归并为九类病根，是缺陷分类的词汇单源。
