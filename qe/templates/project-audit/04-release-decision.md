# 04 · Release Decision

> **中文摘要**：上线判定：逐条给出 12 道 Gate 的判据、结果与证据，结论只能是「可上线 / 有条件上线 / 不可上线」，并附有条件项、回滚方案、遗留风险与上线后 24–72h 观察。
> 依据 `QE-03` §5；12 道 Gate 未逐条给出证据，不得写结论。

> Basis: `QE-03` §5. **Without evidence for each of the 12 gates, no conclusion may be written.**
> The verdict can only be: go / conditional go / no-go.

## 1. Basic information / 基本信息

- Project / version / commit / 项目与版本：
- Audit date / 体检日期：
- Decision owner / on-call owner / 决策人与值守人：
- Planned release window / 计划上线窗口：
- Rollback trigger conditions (error rate / latency / money variance / queue backlog) / 回滚触发条件：

## 2. Gate results / Gate 结果

| Gate | Criterion / 判据 | Result (yes / no / N/A) / 结果 | Evidence / 证据 |
|---|---|---|---|
| G1 Buildable / 可构建 | Build succeeds in a clean environment | | |
| G2 Migratable / 可迁移 | Full migration succeeds on an empty database | | |
| G3 P0 cleared / P0 清零 | Ledger P0 = 0 | | |
| G4 P1 handled / P1 有处置 | Fixed or exempted in writing | | |
| G5 Permission matrix / 权限矩阵 | Every entry has an identity check + privilege-escalation case | | |
| G6 Core-path e2e / 核心路径 e2e | All core flows pass | | |
| G7 Data constraints / 数据约束 | Evidence for applicable unique keys / transactions / idempotency | | |
| G8 Security baseline / 安全基线 | Secrets / high-risk dependencies / output leakage | | |
| G9 Resource ceilings / 资源上限 | Size / pagination / rate limits | | |
| G10 Observability / 可观测 | Dashboard + alert recipients | | |
| G11 Rollback / 可回滚 | Application rollback + data compensation drill | | |
| G12 Production smoke / 生产冒烟 | Smoke test passes in an isomorphic environment | | |

## 3. Verdict / 结论

- Verdict / 结论：**go / conditional go / no-go**
- Basis (cite gates and ledger IDs) / 结论依据：
- Blocking items if "no-go" / 若不可上线，阻断项：

## 4. Conditional items (only G4 / G9 / G10 may be conditional) / 有条件项

| Condition / 条件 | Monitoring metric / 监控指标 | Threshold / 阈值 | Decision owner / 决策人 | Expiry / 失效时间 |
|---|---|---|---|---|
| | | | | |

## 5. Rollback plan / 回滚方案

- Application rollback: version / command / estimated duration
- Data rollback or compensation: steps / owner
- Switches: feature-switch inventory and how to turn them off
- Canary: percentage / observation window / promotion conditions
- Backups: location / date of the most recent restore drill

## 6. Residual risks / 遗留风险

| Risk / 风险 | Blast radius / 影响面 | Why accepted / 为什么接受 | Compensating control / 补偿措施 | Re-assessment date / 复评日期 |
|---|---|---|---|---|
| | | | | |

## 7. Post-release observation (24–72 h) / 上线后观察

| Metric / 指标 | Baseline / 基线 | Alert threshold / 告警阈值 | Observation / 观察结果 |
|---|---|---|---|
| Error rate / 错误率 | | | |
| P95 latency / P95 时延 | | | |
| Queue backlog / 队列积压 | | | |
| Money / asset balance variance / 资金与资产余额差异 | | | |
| Key business volume / 关键业务量 | | | |

## 8. Sign-off / 签署

| Role / 角色 | Name / 姓名 | Verdict / 结论 | Date / 日期 |
|---|---|---|---|
| Audit executor / 体检执行 | | | |
| Technical owner / 技术负责人 | | | |
| Business owner / 业务负责人 | | | |
