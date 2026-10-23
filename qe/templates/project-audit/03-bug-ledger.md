# 03 · Bug Ledger

> **中文摘要**：Bug 台账：汇总、逐条缺陷（根因对应 INV 或检查项、证据等级 E0–E3、复现、定级 P0–P3）、豁免登记、复验记录、归属分型与可上升为不变量的共性问题。
> 依据 `QE-03` §4；E0 只是线索，不能单独判级；P0/P1 必须有 E1–E3 证据。

> Basis: `QE-03` §4. **E0 is only a lead and cannot justify a severity on its own; P0/P1 require E1–E3 evidence.**
> Severity: P0 data corruption / money / privilege escalation / cannot start / cannot roll back; P1 core path unavailable or conditionally exploitable; P2 edge / performance / experience; P3 code quality.

## 1. Summary / 汇总

| Severity / 等级 | Count / 数量 | Fixed / 已修复 | Re-verified / 已复验 | Exempted (with expiry) / 豁免（含到期日） |
|---|---|---|---|---|
| P0 | | | | |
| P1 | | | | |
| P2 | | | | |
| P3 | | | | |

## 2. Ledger / 台账

| ID | Title / 标题 | Module / entry / 模块或入口 | Symptom / 现象 | Root cause (INV / check item) / 根因 | Evidence level / 证据等级 | Reproduction / 复现方式 | Severity / 等级 | Blast radius / 影响面 | Fix / 修复 | Re-verify / 复验 | Status / 状态 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| BUG-XXX-01 | | | | | E0–E3 | | P0–P3 | | | | open / fixing / verified / exempted |

## 3. Exemption register (an exemption without an expiry date is unapproved) / 豁免登记

| ID | Reason for exemption / 豁免理由 | Compensating control / 补偿措施 | Monitoring metric / 监控指标 | Approver / 批准人 | Expiry / 到期日 | Review result / 复审结果 |
|---|---|---|---|---|---|---|
| | | | | | | |

## 4. Re-verification record / 复验记录

| ID | Fix commit / 修复 commit | Counterexample / regression case / 反例或回归用例 | Reading before fix / 修复前读数 | Reading after fix / 修复后读数 | Re-verified by / 复验人 |
|---|---|---|---|---|---|
| | | | | | |

## 5. Ownership classification / 归属分型

| Category / 类别 | Count / 数量 | Explanation / 说明 |
|---|---|---|
| Introduced by this batch / 本批引入 | | |
| Pre-existing / 存量 | | |
| Parallel batch (not this one) / 并行批 | | Do not fix them here, but name the owner |

## 6. Recurring problems (candidates for an invariant / guard) / 共性问题

| Recurring defect / 重复出现的缺陷 | Occurrences / 出现次数 | Proposed entry / guard / 建议条目或守卫 | Registered? / 是否已登记 |
|---|---|---|---|
| | | | |
