# 05 · Gap Absorption Plan

> **中文摘要**：把外部审计或通用清单问出来的问题，逐条吸收进本项目自有载体（守卫 / 断言 / CI / 台账），只取问题不取形态。
> 每行需给出适用性、判定、自有载体与验收读数；空表不得声称「已吸收外部审计」。

> Purpose: absorb the questions raised by an **external audit or generic checklist** into this project's own carriers. The external tool is only an exam sheet; once absorbed, the tool is not kept.
> Basis: `QE-00` §0 (positioning). **Take the questions, not the shape**: the source tool's finding codes, `Finding[]` structure, and report layout are not imported into this project.
> Output: this table plus an acceptance reading for every row. While the table is empty, you may not claim "the external audit has been absorbed".

## 1. Absorption discipline (missing any one means not absorbed) / 吸收纪律

1. **Decide applicability first**: inapplicable items need a written reason (e.g. this project has no queues and no outbound writes); blanks are not allowed.
2. **Look at the current state first**: state the guards or processes this project already has; if an existing one is stricter, mark it "already present, do not rebuild".
3. **The carrier must be an artifact this project owns**: a guard, an assertion suite, a CI step, or a ledger process. Never cite the external tool's finding code as this project's criterion.
4. **One reading per item**: `GUARD_SUMMARY`, a test pass count, a CI step name, or a ledger row — at least one.
5. **Raising an item into the invariant set must pass admission**: an external item that wants to become an `INV-*` here must first pass the four admission checks in `QE-05` §2 and be registered in the registry; no verbal intake.

## 2. Gap table / 缺口表

| Gap ID / 缺口编号 | Source (checklist name + date) / 来源 | Original wording / 问题原话 | Current state here (command / file) / 本项目现状 | Applicability / 适用性 | Decision / 判定 | Carrier (owned) / 载体 | Batch / 批次 | Acceptance reading / 验收读数 | Owner / 负责人 | Status / 状态 |
|---|---|---|---|---|---|---|---|---|---|---|
| GAP-01 | | | | applicable / not applicable (reason) | absorbed / already present / rejected (reason) | guard / assertion suite / CI / process | P0–P2 | | | open / in progress / accepted / rejected |

Field notes / 字段说明：

- **Original wording / 问题原话**: keep the external checklist's original phrasing; do not rewrite it into your own vocabulary — rewriting loses the value of the outsider's perspective.
- **Applicability / 适用性**: applicable only if it relates to this project's architecture; otherwise write "this project has no such surface" with evidence (e.g. "no queue consumers: `rg -l "consumer|cron" src` returns 0").
- **Decision / 判定**: `already present` means this project covers it more strictly and only needs evidence; `rejected` requires a reason and a review trigger.
- **Batch / 批次**: P0 do now (zero cost / high risk), P1 this iteration, P2 scheduled.
- **Status / 状态**: mark `accepted` only when the acceptance reading has a value.

## 3. Common external gap types (for reference, not a mandatory checklist) / 常见外部缺口类型

| Type / 类型 | Typical question / 典型问法 | Common carrier here / 本项目常见载体 |
|---|---|---|
| Entry enumeration completeness / 入口枚举完整性 | Are all the ways in listed? | Entry inventory + server-boundary guard |
| Resource ceilings / 资源上限 | Are there hard limits on body / pagination / file / rate? | Gateway configuration + guard vocabulary |
| Re-runnable counter-proof / 反证可复跑 | Can a second person reproduce the guard's bad sample as red? | Bad-sample fixtures + `qe:selftest` |
| CI gate / CI 门禁 | Do these checks run on every commit? | CI workflow + `qe:ci` |
| Single-source readings / 读数单源 | Do the numbers in the report come from a command? | `GUARD_SUMMARY` / `QE_RESULT` |
| Release artifact / 上线判定物 | Is there a signable verdict plus a rollback plan? | `04-release-decision.md` + rollback drill records |

## 4. Closeout check / 收尾检查

- [ ] Every row has all four: applicability, decision, carrier, reading status
- [ ] Rows marked `already present` cite this project's guard or process file/command
- [ ] Rows marked `rejected` carry a reason and a review date
- [ ] No external finding code has been written into a project criterion
- [ ] After absorption, this project's `npm run qe` (or equivalent gate) reading changed and has been archived
