# QE-02 · Mechanized Quality: Ratchet and AI Module-by-Module Collaboration

> Chinese edition of [QE-02-mechanized-quality.md](../../QE-02-mechanized-quality.md).

> 覆盖：INV-CORE-13/14/15/16
> 命令：`npm run qe`（含 ratchet）、`npm run qe:selftest`、`npm run qe:report`
> 条目单源：[`qe/registry/registry.ts`](../../qe/registry/registry.ts)

## 1. 为什么「bug 越修越少」需要机制，而不是更努力

靠人记 bug 清单，缺陷数会随模块数线性增长；靠机制，缺陷数会被**约束**压住：

- **不变量**回答「这件事是否恒成立」，用例只回答「这条路径对不对」。
- **守卫**把不变量变成可执行判据，缺口用 `partial/open` 明示，不假装覆盖。
- **ratchet 基线**让「修过的缺陷」不能以任何理由回来：计数只准降。
- **注册表落旧率**让新缺陷优先归到已有条目，条目数趋稳（20–30 条），而不是每次新开一条。

## 2. 当前机制读数（2026-10-23）

| 指标 | 读数 | 判据 |
|---|---|---|
| 不变量条目 | 27（enforced 10 / partial 5 / open 12） | 稳定态 20–30 条 |
| 守卫 | 9 | 每个 enforced/partial 条目都有别名 |
| 坏样本用例 | 19/19 PASS | red 用例必须真红 |
| 反证覆盖率 | 100% | enforced 条目全部有守卫 + 坏样本 |
| ratchet 基线 | `qe/ratchet.json`（keys=0，当前无存量缺陷读数） | 任何新增 error/warn 即回归 |
| 新缺陷落旧条目率 | 75%（3/4） | ↑ |

> 以上数字是随命令变化的快照；以 `npm run qe:report` 的输出为准。报告与命令不符即视为红。

## 3. ratchet 规则（D6）

> 机制来源：[QE-04-审计方法论](QE-04-audit-methodology.zh-CN.md) §6.3「门禁形态：ratchet（只准变少，不准变多）」。本文只写本仓的落地口径。

1. 基线文件：`qe/ratchet.json`，键为 `<guard-id>:<finding-code>`，值为 error+warn 计数。
2. `npm run qe` 自动比对：
   - `RATCHET status=ok`：无回归。
   - `RATCHET status=regressed` + `RATCHET_REGRESSION …`：退出码 1，视为红。
   - `RATCHET status=missing`：基线未建立（首次接入），不判红，但不得宣称「只降不升」。
3. 只有两种情况允许 `npm run qe:ratchet:update`：
   - 存量缺陷已完成方向裁决（册错改册 / 码错改码），且**计数确实下降**；
   - 新增守卫/新 finding code 被人工确认为合理基线。
4. **禁止**：把本批新违规塞进基线；把 `open` 条目的缺陷标成「已知」后更新基线。
5. 收紧基线后，必须在提交信息或台账里写一行「裁决记录」：`key / 旧值 / 新值 / 裁决人 / 理由`。

## 4. AI 分模块协作协议

### 4.1 开工前（缺一不开工）

- [ ] 立项单五问：违反哪条 INV / 新增哪条 INV / 在哪一层拦（入口/服务/DB/UI）/ 有无不可逆动作 / 反例是什么
- [ ] 静默出错清单 ≥3 条，逐条写「会以什么形式静默」
- [ ] 接缝清单：本模块被谁调用、调用谁、公开入口是什么、跨模块导入走哪条路径
- [ ] 触及面：表/列/枚举值/契约键/闸与控件（对照 registry 的现有条目先查表）

### 4.2 施工中

- 边界先立：schema、枚举、错误码、状态机、模块公开入口由单源生成，AI 只写中间业务。
- 新增列：写明写入者函数名，或删列（inv01）。
- 新增枚举值：写出产生路径（哪个写点、什么条件）（inv03）。
- 新增承诺句（规范/注释/界面文案）：在 `qe.contracts.json` 登记 + 抛错点（inv06）。
- 新增服务端入口：鉴权、校验必填；变更入口幂等（inv20）。
- 新增客户端文件：禁止触达服务端实现；跨模块走公开入口（inv21）。
- 新增 persist：`partialize` 白名单 + `version`（inv22）。

### 4.3 收尾

- 跑 `npm run qe:ci`，逐项读 `GUARD_SUMMARY` / `QE_RESULT` / `RATCHET` / `REPORT`。
- 红项分型：**本批引入 / 存量 / 并行批**。非本批不代改，但要说清归属。
- 未 commit 的项标「排期声明」，不标完成。

## 5. 缺陷分型与归属（QE-04九类）

`defectClasses` 只能取：漂移、接缝、登记制失效、建了没接线、隐性陷阱、证据不足、测试方法论、并发正确性、防线幻觉。

- 新缺陷先问「属于哪一类、是否已有条目」；能落到旧条目就不新开。
- 新增条目必须同时给：`status`、`guard`（enforced/partial）、`badSample`（enforced）、`gap`（partial）、`openReason` + `revisitBy`（open）。
- `open` 复审日期 ≤90 天，过期未处理 `REVISIT_OVERDUE` 判红（inv13）。

## 6. 新增一个守卫的固定动作

1. 在 `qe/guards/` 建 `invNN-*.ts`，`defineGuard` 写清 `id/title/invariants/blindSpots/run/selfTest`。
2. 建 `qe/fixtures/invNN-*/{good,bad}`：bad 必须能被独立构造，且不依赖实现者的代码。
3. 在 `qe/guards/index.ts` 登记（否则 inv13 报 `ORPHAN_GUARD`）。
4. 在 `package.json` 加 `qe:guard:invNN`（否则 `ALIAS_MISSING`）。
5. registry 加条目：enforced 必须配 `badSample`；partial 必须写 `gap`。
6. `npm run qe:selftest` 先看到坏样本红，再看到 good 绿；最后 `npm run qe` + `qe:ratchet:update`（如基线合理）。

## 7. 指标定义（报告口径）

| 指标 | 定义 | 目标 |
|---|---|---|
| enforcedCoverage | 有守卫且坏样本通过（selftest PASS）的 enforced 条目 / enforced 总数 | 100% |
| zeroWriter | `ZERO_WRITER` 计数 | 0 并 ratchet 钉住 |
| deadEnum | `DEAD_ENUM` + `NO_WRITE_PATH` 计数 | 0 并 ratchet 钉住 |
| skipped | 适配器未配置/射程不适用而显式跳过的守卫数 | 不报绿；说明原因 |
| 落旧条目率 | 台账缺陷能匹配 registry ID 的比例 | ↑ |
| RATCHET | 回归计数 | 0 |

## 8. 完成声明（必须可寻址）

> 「已完成」三个字不构成证据。至少给一个：
> - commit hash；
> - `GUARD_SUMMARY` / `QE_RESULT` / `RATCHET` 读数；
> - 台账行（`qe/ledger/incidents.json`）。

模板见 [总索引 §6](QE-00-index.zh-CN.md)。
