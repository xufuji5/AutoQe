# QE-02 · Mechanized Quality: Ratchet and AI Module-by-Module Collaboration

> Covers: INV-CORE-13/14/15/16
> Commands: `npm run qe` (includes ratchet), `npm run qe:selftest`, `npm run qe:report`
> Entry single source: [`qe/registry/registry.ts`](qe/registry/registry.ts)

## 1. Why "fewer bugs each round" needs mechanism, not more effort

If you rely on people remembering a bug list, the defect count grows linearly with the number of modules; if you rely on mechanism, the count is held down by **constraints**:

- **Invariants** answer "does this always hold"; use cases only answer "is this path correct".
- **Guards** turn invariants into executable criteria; gaps are stated explicitly as `partial/open`, never disguised as coverage.
- The **ratchet baseline** makes a fixed defect unable to come back for any reason: counts may only go down.
- The **registry's landing rate** pushes new defects into existing entries first, so the number of entries stabilizes (20–30) instead of opening a new one every time.

## 2. Current mechanism readings (2026-10-23)

| Metric | Reading | Criterion |
|---|---|---|
| Invariant entries | 27 (enforced 10 / partial 5 / open 12) | Steady state 20–30 |
| Guards | 9 | Every enforced/partial entry has an alias |
| Bad-sample cases | 19/19 PASS | Red cases must actually be red |
| Counter-proof coverage | 100% | Every enforced entry has a guard + bad sample |
| Ratchet baseline | `qe/ratchet.json` (keys=0; no existing-defect readings at present) | Any new error/warn is a regression |
| New-defect landing rate | 75% (3/4) | ↑ |

> These numbers are a snapshot that moves with the commands; take the output of `npm run qe:report` as authoritative. A report that disagrees with the command counts as red.

## 3. Ratchet rules (D6)

> Mechanism source: [QE-04-audit-methodology](QE-04-audit-methodology.md) §6.3 "Gate form: ratchet (only down, never up)". This document only states how it is implemented in the reference implementation.

1. Baseline file: `qe/ratchet.json`; keys are `<guard-id>:<finding-code>`, values are error+warn counts.
2. `npm run qe` compares automatically:
   - `RATCHET status=ok`: no regression.
   - `RATCHET status=regressed` + `RATCHET_REGRESSION …`: exit code 1, counted as red.
   - `RATCHET status=missing`: the baseline has not been established (first connection); not judged red, but you must not claim "only down".
3. `npm run qe:ratchet:update` is allowed in only two situations:
   - an existing defect has completed direction adjudication (spec wrong → fix spec / code wrong → fix code) and **the count has genuinely dropped**;
   - a new guard or new finding code has been manually confirmed as a reasonable baseline.
4. **Forbidden**: stuffing this batch's new violations into the baseline; marking defects from `open` entries as "known" and then updating the baseline.
5. After tightening the baseline, write one "adjudication record" line in the commit message or the ledger: `key / old value / new value / adjudicator / reason`.

## 4. AI module-by-module collaboration protocol

### 4.1 Before work starts (skip one and do not start)

- [ ] Five questions on the work order: which INV is violated / which INV is added / at which layer it is blocked (entry / service / DB / UI) / is there an irreversible action / what is the counter-example
- [ ] A silent-failure list with at least 3 items, each stating "in what form it fails silently"
- [ ] A seam list: who calls this module, whom it calls, what the public entry (`index.ts`) is, which path cross-module imports take
- [ ] Touched surfaces: tables / columns / enum values / contract keys / gates and controls (check the existing registry entries first)

### 4.2 During construction

- Boundaries first: schema, enums, error codes, state machines, and module public entries are generated from a single source; AI writes only the middle business logic.
- New column: state the writer's function name, or delete the column (inv01).
- New enum value: state its production path (which write site, under what condition) (inv03).
- New promise sentence (spec / comment / UI copy): register it in `qe.contracts.json` + add a throw site (inv06).
- New server-side entry: authentication and validation are mandatory; mutating entries are idempotent (inv20).
- New client file: reaching server-side implementation is forbidden; cross-module access goes through public entries (inv21).
- New persist: `partialize` allowlist + `version` (inv22).

### 4.3 Closing

- Run `npm run qe:ci` and read `GUARD_SUMMARY` / `QE_RESULT` / `RATCHET` / `REPORT` item by item.
- Classify reds: **introduced by this batch / pre-existing / parallel batch**. Do not fix other batches, but state ownership clearly.
- Mark uncommitted items as "scheduled claim", not done.

## 5. Defect classification and ownership (the nine classes of QE-04)

`defectClasses` may only take: drift, seam, registration failure, built but not wired, hidden trap, insufficient evidence, test methodology, concurrency correctness, defense illusion.

- A new defect first asks "which class is this, and is there already an entry"; if it can land in an old entry, do not open a new one.
- A new entry must provide all of: `status`, `guard` (enforced/partial), `badSample` (enforced), `gap` (partial), `openReason` + `revisitBy` (open).
- An `open` review date must be ≤ 90 days; when overdue and unhandled, `REVISIT_OVERDUE` turns red (inv13).

## 6. Fixed steps for adding a guard

1. Create `invNN-*.ts` under `qe/guards/`; `defineGuard` must state `id/title/invariants/blindSpots/run/selfTest`.
2. Create `qe/fixtures/invNN-*/{good,bad}`: the bad case must be constructible independently and must not depend on the implementer's code.
3. Register it in `qe/guards/index.ts` (otherwise inv13 reports `ORPHAN_GUARD`).
4. Add `qe:guard:invNN` to `package.json` (otherwise `ALIAS_MISSING`).
5. Add the registry entry: `enforced` must carry `badSample`; `partial` must carry `gap`.
6. `npm run qe:selftest`: see the bad sample go red first, then the good one go green; finally `npm run qe` + `qe:ratchet:update` (if the baseline is reasonable).

## 7. Metric definitions (report basis)

| Metric | Definition | Target |
|---|---|---|
| enforcedCoverage | Enforced entries with a guard and a passing bad sample (selftest PASS) / total enforced entries | 100% |
| zeroWriter | `ZERO_WRITER` count | 0, pinned by ratchet |
| deadEnum | `DEAD_ENUM` + `NO_WRITE_PATH` count | 0, pinned by ratchet |
| skipped | Guards explicitly skipped because an adapter is not configured or the scope does not apply | Never green; state the reason |
| Landing rate | Share of ledger defects that match a registry ID | ↑ |
| RATCHET | Regression count | 0 |

## 8. Completion declaration (must be addressable)

> The words "done" are not evidence. Provide at least one:
> - a commit hash;
> - a `GUARD_SUMMARY` / `QE_RESULT` / `RATCHET` reading;
> - a ledger row (`qe/ledger/incidents.json`).

Template: see [Index §6](QE-00-index.md).

---

**中文摘要**：用 ratchet 基线保证修过的缺陷不再回来，并给出 AI 分模块协作协议。
