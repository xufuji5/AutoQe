# Intake Form · <feature name>

> **中文摘要**：开工前必填：需求评审五问（违反/新增哪条 INV、在哪一层拦、有无不可逆动作、反例）、静默出错清单（≥3 条）、触及面清单、方向裁决与可寻址的完成声明。
> 未填完不许开工；判据条目单源为 `qe/registry/registry.ts`。

> Do not start until this form is complete. Criteria ownership: `qe/registry/registry.ts` (single source of entries).

## 1. Five intake questions

| # | Question / 问题 | Answer / 答案 |
|---|---|---|
| Q1 | Which existing invariants does this feature **violate**? (list every INV ID) / 这个功能**违反**了哪几条已有不变量？ | |
| Q2 | Which invariant does it **add**? If none, why not? / **新增**了哪条不变量？ | |
| Q3 | At which layer is it blocked (L0 type / L1 DB / L2 contract / L3 guard / L4 e2e / L5 human)? Why not lower? / 在哪一层拦？ | |
| Q4 | Are there irreversible actions? (drop column / backfill / pre-deduction / outbound call / migration) / 有没有不可逆动作？ | |
| Q5 | What is the counterexample? (if you cannot write one, it is not an invariant) / 反例是什么？ | |

## 2. Silent-failure list (list first, code later; ≥3 items)

| # | In what form can it fail silently / produce false green / have no provenance? / 会以什么形式静默失败 / 假绿 / 无来源 | How will you make it explode at the cheapest layer? / 打算怎么让它在便宜的层爆炸 |
|---|---|---|
| 1 | | |
| 2 | | |
| 3 | | |

## 3. Blast-radius list

| Type / 类型 | Items (tables / columns / enum values / contract keys / gates + controls) / 清单 | Guards / 对应守卫 |
|---|---|---|
| Columns / 列 | | inv01 / inv02 |
| Enums / 枚举 | | inv03 |
| Promise sentences / 承诺句 | | inv06 |
| Gates / 闸 | | inv07 |
| New guards / 新守卫 | | inv13 |

## 4. Direction adjudication

- When "the spec says X, the code does not", pick exactly one: **spec is wrong → fix the spec / code is wrong → fix the code**. "Both are right" is forbidden.
- Adjudication record / 裁决记录：

## 5. Done declaration (addressable)

- Commit:
- Guard reading (`GUARD_SUMMARY` line) / 守卫读数：
- Ledger row / 台账行：
