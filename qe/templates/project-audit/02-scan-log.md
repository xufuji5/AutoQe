# 02 · Scan Log

> **中文摘要**：记录十五项高收益快扫与 A–G 七条深挖主线的命中、证据与结论；命中只是线索，只有 E1–E3 才能进入 Bug 台账。
> 记录格式「文件:行 → 可疑点 → 为什么可疑 → 验证方式 → 结论」；末节放自动化读数与排除记录，`skipped` 必须写原因。

> Basis: `QE-03` §2 and §3. A hit is only a lead; **only E1–E3 may enter the bug ledger.**
> Record format: `file:line → suspicious point → why suspicious → how verified → conclusion (excluded / promoted to BUG-xx)`.

## 1. Quick scan (15 items) / 快速扫描

| # | Scan item / 扫描项 | Command / method / 命令或方法 | Hits / 命中数 | Conclusion / ledger / 结论或转台账 |
|---|---|---|---|---|
| 1 | Entry auth gaps / 入口鉴权缺口 | Walk each row of `01-entry-inventory.md` through the function body | | |
| 2 | Unvalidated input / 输入未校验 | `rg -n "request\.json\(\)\|req\.body\|ctx\.request"` | | |
| 3 | Dangerous execution / 危险执行 | `rg -n "eval\(\|new Function\|child_process\|execSync"` | | |
| 4 | XSS sinks / XSS 注入点 | `rg -n "dangerouslySetInnerHTML\|v-html\|innerHTML\s*="` | | |
| 5 | Client-side overreach / 客户端越界 | `rg -l "use client"` + import check | | |
| 6 | Check-then-insert / 先查后插 | `rg -n "findUnique\|findFirst\|exists\("` | | |
| 7 | Bare updates / 裸更新 | `rg -n "\.update\(\{\s*where"` / `save()` | | |
| 8 | Sensitive persistence / 敏感落盘 | `rg -n "persist\(\|localStorage\.setItem"` | | |
| 9 | Swallowed errors / 吞错 | `rg -n "catch\s*(\([^)]*\))?\s*\{\s*\}"` | | |
| 10 | Public entries / 公共入口 | Interrogate every unauthenticated entry one by one | | |
| 11 | Bare state-machine transitions / 状态机裸迁移 | `update` near `rg -n "status\s*[:=]"` | | |
| 12 | Migration drift / 迁移漂移 | Full migration on an empty DB + schema diff | | |
| 13 | Dependency vulnerabilities / 依赖漏洞 | `npm audit --omit=dev` / equivalent | | |
| 14 | Observability gaps / 可观测缺口 | Logs / error reporting / health checks / request IDs | | |
| 15 | Resource ceilings / 资源上限 | Body / pagination / file / rate-limit configuration | | |

## 2. Deep-dive log (fill applicable items only; write N/A + reason otherwise) / 深挖记录

### A Runnable and releasable / 可运行与可发布
| ID | Conclusion / 结论 | Evidence (command / log) / 证据 | Ledger / 转台账 |
|---|---|---|---|
| A1–A5 | | | |

### B Data and migrations / 数据与迁移
| ID | Conclusion / 结论 | Evidence / 证据 | Ledger / 转台账 |
|---|---|---|---|
| B1–B6 | | | |

### C Permissions and boundaries / 权限与边界
| ID | Conclusion / 结论 | Evidence / 证据 | Ledger / 转台账 |
|---|---|---|---|
| C1–C7 | | | |

### D Concurrency and idempotency / 并发与幂等
| ID | Conclusion / 结论 | Evidence / 证据 | Ledger / 转台账 |
|---|---|---|---|
| D1–D6 | | | |

### E Adversarial input and resources / 对抗与资源
| ID | Conclusion / 结论 | Evidence / 证据 | Ledger / 转台账 |
|---|---|---|---|
| E1–E7 | | | |

### F Frontend state and experience / 前端状态与体验
| ID | Conclusion / 结论 | Evidence / 证据 | Ledger / 转台账 |
|---|---|---|---|
| F1–F6 | | | |

### G Observability and rollback / 可观测与回滚
| ID | Conclusion / 结论 | Evidence / 证据 | Ledger / 转台账 |
|---|---|---|---|
| G1–G6 | | | |

## 3. Automated readings (if qe is wired in) / 自动化读数

```text
GUARD_SUMMARY id=... status=... errors=... warnings=... scanned=...
QE_RESULT ...
RATCHET ...
SELFTEST_RESULT ...
```

- A guard at `green` only means its shape criteria are not violated; it does not mean semantics are correct.
- `skipped` requires a written reason and must never be counted as green.

## 4. Exclusion record (prevents repeated false positives) / 排除记录

| Lead / 线索 | Why excluded / 排除理由 | Basis (code / test / environment) / 依据 | Excluded by / 排除人 |
|---|---|---|---|
| | | | |
