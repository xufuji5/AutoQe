# Using AutoQe with AI Coding Agents (Codex, Claude Code, WorkBuddy)

AutoQe splits quality work into two parts that must not be mixed:

| Layer | Who does it | What it produces | Can it claim "green"? |
|---|---|---|---|
| Mechanical checks | `npx autoqe run` | `GUARD_SUMMARY` / `QE_RESULT` / `RATCHET` readings | Yes — only the command can |
| Semantic audit | Codex / Claude Code / WorkBuddy | S0–S4 audit, bug ledger, release decision | No — a model's opinion is never a reading |
| Adjudication | Human | Which findings to fix, which gaps to accept, baseline updates | Yes — with a written reason |

The rule is simple: **the agent proposes, the CLI proves, the human decides.**

## 1. The loop

```bash
# once per project
cd your-project
npx autoqe init
npx autoqe doctor              # catches missing config/schema/source roots before they become false findings

# every round
npx autoqe run --root .        # 1. deterministic facts
npx autoqe triage --root .     # 2. split facts into fix / decide / record (today list ≤ 5)
npx autoqe prompt audit        # 3. prints the facts + task + rules as one paste-ready prompt
# 4. the agent writes qe-audit/<project>-<date>/*.md with file:line evidence
# 5. fix a batch, run again, compare RATCHET
# 6. after the batch, ask the stop criterion instead of deciding by feel
npx autoqe status --root .     # CONTINUE-MINING / STOP-MINING / REPAIR / ADJUDICATE
```

`autoqe prompt` runs the guards silently and embeds the current `QE_RESULT` line plus every non-info
finding into the prompt, so the model never has to re-interpret a pasted summary. Tasks: `audit`, `fix`,
`review`. Redirect it to a file when your tool cannot run commands:

```bash
npx autoqe prompt audit --root . > prompt.txt
```

`autoqe triage` answers "what do I do next" without a meeting. It writes `qe-report/triage.md` with:

- **fix** — one mechanically correct action (the only bucket `--apply` may touch, and only for additive package-alias edits);
- **decide** — 2–3 options with a recommendation; a human picks one;
- **record** — traceability only, no runtime risk; produces a waiver draft with `reviewBy`.

Unregistered finding codes always land in **decide**, never in **record**. The today list is capped at five,
so the output is a finishable queue rather than a second backlog. `npm run test:triage` fails when a guard
emits a code with no disposition, which keeps the judgment layer in sync with the guard layer.

`init` writes `qe.config.json`, `QE-00`…`QE-09`, `qe/templates/`, `qe.contracts.json`, and `AGENTS.md`
(or `AGENTS.autoqe.md` if the project already has one — merge it by hand, never overwrite host rules).

First run on an untouched project is often **yellow**: schema-dependent guards are `skipped`,
`inv06`/`inv07` warn because the contract ledger is empty. That is honest, not a failure. Register
promises and gates as you adopt them; never edit the config just to turn yellow into green.

## 2. Codex CLI

Codex discovers `AGENTS.md` automatically from the repository root.

```bash
cd your-project
codex
```

Paste this as the first message:

```text
Read AGENTS.md, QE-00-index.md, QE-03-project-audit-and-release-gate.md and QE-04-audit-methodology.md.

Then run: npx autoqe run --root .
Treat every QE_RESULT / GUARD_SUMMARY / RATCHET line as a fact. Do not re-interpret or soften it.

Audit this repository with the QE-03 playbook (S0 baseline -> S1 quick scan -> S2 seven tracks ->
S3 triage -> S4 release gates). Create qe-audit/<project>-<today>/ and fill:
00-fact-baseline.md, 01-entry-inventory.md, 02-scan-log.md, 03-bug-ledger.md, 04-release-decision.md.

Rules:
- Every finding needs evidence: file:line, a command output, or a reading. Mark its evidence level E0-E3.
- Never write "done" or "passed" without an addressable artifact (command reading, ledger row, commit).
- Do not edit qe.config.json, qe.contracts.json, or qe/ratchet.json to silence findings.
- If a guard is skipped, record it as skipped (yellow), never as passed.
```

Codex will run commands itself. Keep approval on for anything outside the repository.

## 3. Claude Code

Claude Code loads `CLAUDE.md`, not `AGENTS.md`. Create a one-line bridge in the project root:

```md
@AGENTS.md
@QE-00-index.md
```

Then run `claude` in the project root. Allow the CLI once so it does not ask every round:

```text
/permissions  ->  allow  Bash(npx autoqe:*)
```

Prompt (same content as Codex, plus the audit output rules):

```text
Run `npx autoqe run --root .` first and keep the raw output.
Then apply QE-03 S0-S4 to this repository and write the five audit files under qe-audit/<project>-<date>/.
Follow AGENTS.md strictly: no done claim without a command reading or a ledger row.
Do not modify qe.config.json or qe/ratchet.json. List every skipped guard as skipped.
```

Claude Code can also keep a persistent instruction in `CLAUDE.md`:

```md
@AGENTS.md
@QE-00-index.md

Before any quality claim, run `npx autoqe run --root .` and quote its QE_RESULT line.
```

## 4. WorkBuddy / IDE agents with project rules

WorkBuddy-style agents usually read one of: `AGENTS.md`, a project-rules panel, or a tool-specific
rules file. `npx autoqe init` already places `AGENTS.md` and all `QE-*` documents at the root.

Setup:

1. Point the agent's project rules at `AGENTS.md` and `QE-00-index.md` (import them, or paste both).
2. Make sure the agent has terminal access, then use the same prompt as Codex.
3. If the tool cannot run commands, run `npx autoqe run --root .` yourself and paste the output into
   the chat before asking for the audit.

Minimal prompt that works with any chat-style agent:

```text
You are auditing this repository. Read AGENTS.md and QE-00-index.md first.

Facts from the deterministic CLI (do not contradict them):
<paste the full output of: npx autoqe run --root .>

Task: follow QE-03 (S0-S4) and produce:
- qe-audit/<project>-<date>/00-fact-baseline.md
- 01-entry-inventory.md
- 02-scan-log.md
- 03-bug-ledger.md (P0-P3, evidence level E0-E3, file:line for every row)
- 04-release-decision.md (12 gates, one conclusion per gate)

Constraints: no green without a reading; skipped stays skipped; do not edit qe.config.json,
qe.contracts.json, or qe/ratchet.json; ask before any irreversible action.
```

## 5. Three ready-made prompts

You do not have to write these by hand: `npx autoqe prompt audit|fix|review --root .` prints each of them
with the current readings already embedded. Use the sections below when you want to adapt the wording.

### 5.1 Full audit (first pass)

Use the prompt in section 2 or 4. Expected output: five audit files plus a list of P0 items.

### 5.2 Fix one batch from the ledger

```text
Read qe-audit/<project>-<date>/03-bug-ledger.md. Fix only the rows marked P0 in this batch.
For each row: state which invariant (INV-*) it violates, change the code, add or update a bad sample
if a guard is involved, then run `npx autoqe run --root .` and paste the new readings.
Do not touch P1/P2 rows. Do not change the baseline.
```

### 5.3 Explain a red guard before touching code

Start with `npx autoqe explain <INV-* or invNN>` — it prints the rule, defect classes, guard, bad sample and
the exact reproduce command, so the agent does not guess why a guard is red.

```text
Run `npx autoqe run --root . --only <invNN>` and explain every finding:
what the guard checks, why this code violates it, and the two possible fixes (fix code vs. register a
justified exemption). Do not edit any file yet.
```

## 6. Guardrails (non-negotiable)

1. **Only the CLI can say green.** A model saying "looks good" is not a reading.
2. **Skipped is yellow.** `provider=none` / `collector=none` / zero scanned objects never become green.
3. **No silencing.** Editing `qe.config.json`, adding `fieldExemptions`, or stuffing counts into
   `qe/ratchet.json` requires a written reason and a review trigger.
4. **Bad sample first.** New guard → bad fixture fails for the intended reason → then it may be trusted.
5. **Ratchet only down.** Baseline updates happen only through `npx autoqe ratchet-update --root .`
   after human adjudication, and the commit message records key / old / new / reason.

## 7. Windows notes

```powershell
npx autoqe init
npx autoqe doctor
npx autoqe run --root .
npx autoqe report --root .
```

If `npx` is blocked by policy, run the compiled entry directly:

```powershell
node node_modules\autoqe\dist\cli.js run --root .
```

---

**中文摘要**：把机械判定交给 `npx autoqe run`，把语义审计交给 Codex / Claude Code / WorkBuddy，
人只做裁决；模型不得自证绿灯，skipped 永远算黄，基线只降不升。
