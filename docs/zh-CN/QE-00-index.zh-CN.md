# QE-00 · Document Index and Reading Order (Chinese edition)

> Chinese edition of [QE-00-index.md](../../QE-00-index.md).

> 本文件是文档体系的唯一入口。**条目不变量单源**仍是 [`qe/registry/registry.ts`](../../qe/registry/registry.ts)；
> **读数单源**是命令输出（`GUARD_SUMMARY` / `QE_RESULT` / `RATCHET`）。文档只写方法、词汇与指针。

## 0. 定位：外部卷子，不是升级包

本包回答的是「一个没有守卫体系的仓，最低限度该检查什么」，**不是**「所有仓都该换成这套守卫」。落地时守三条：

1. **不替换**：目标仓已有更严的守卫/流程时，原样保留；本包只补它**没想到**的问题，不做整体替换。
2. **只取问题，不取形态**：真正带走的是「问出了什么缺口」；来源工具的问题码、`Finding[]` 结构、报告排版都不带入目标仓。
3. **用目标仓载体复核**：每吸收一项，必须在目标仓自己的守卫/测试/流程里落成判据，并给出一条可复核读数（`GUARD_SUMMARY`、测试断言或台账行）。

> 自检口径（本仓当前）：27 条不变量，enforced 10 / partial 5 / open 12。**open 率 44.4% 是本包的自述短板，不是目标仓的现状**；用本包体检时先跑 `npm run qe:list` 看哪些条目在该仓适用，再谈吸收。
> 吸收计划模板：[`qe/templates/project-audit/05-gap-absorption-plan.md`](../../qe/templates/project-audit/05-gap-absorption-plan.md)。

## 1. 编号规则

**唯一规则：根目录只放 `QE-XX` 序列与 `AGENTS.md`；业务域文档一律放进 `业务域/`，不再与 QE 序列混排。**

| 编号 | 含义 | 是否进复制包 |
|---|---|---|
| `QE-00` | 总索引（本文件） | 是 |
| `QE-01` ~ `QE-05` | 方法层：哲学 / 机制 / 通用体检 / 审计方法论 / 不变量规范 | 是 |
| `QE-06` ~ `QE-09` | 栈专用判据：Next.js 边界 / Prisma 并发 / 对抗输入 / Zustand | 是 |
| `业务域/05、29、44、48、53、59、60` | 产品域规范（沿用原仓编号，不重编） | 否 |

> 业务域文档不重编的原因：它们被外部仓（04/15/25/37/38 等）大量引用，属跨仓共享编号域；改号会断链。
> 但它们与 QE 序列**不再同级**，物理隔离在 `业务域/`，视觉上不会混淆。

**旧号 → 新号对照**

| 旧位置 | 新位置 |
|---|---|
| `AI编程质量控制手册-v1.0.md` | `QE-01-quality-philosophy.zh-CN.md` |
| `docs/50-机制化质量-ratchet与AI分模块协作.md` | `QE-02-mechanized-quality.zh-CN.md` |
| （新增） | `QE-03-project-audit-and-release-gate.zh-CN.md` |
| `58-审计方法论.md` | `QE-04-audit-methodology.zh-CN.md` |
| `61-不变量规范.md` | `QE-05-invariant-spec.zh-CN.md` |
| `docs/10-Next.js服务端边界与模块接缝.md` / `QE-10-…` | `QE-06-nextjs-boundary-and-seams.zh-CN.md` |
| `docs/20-Prisma-PostgreSQL并发与约束.md` / `QE-11-…` | `QE-07-prisma-postgresql-concurrency.zh-CN.md` |
| `docs/30-对抗与恶意输入.md` / `QE-12-…` | `QE-08-adversarial-input.zh-CN.md` |
| `docs/40-Zustand前端状态.md` / `QE-13-…` | `QE-09-zustand-state.zh-CN.md` |
| `00-文档总索引.md` | `QE-00-index.zh-CN.md` |
| `05/29/44/48/53/59/60-*.md`（根目录） | `业务域/` 同名文件，编号不变 |

## 2. 全量目录与阅读时机

| 编号 | 文件 | 角色 | 什么时候读 | 机器判据 |
|---|---|---|---|---|
| QE-00 | 本文件 | 索引 / 分工 / 阅读顺序 | 第一次进入 | — |
| QE-01 | [QE-01-质量哲学与不变量优先](QE-01-quality-philosophy.zh-CN.md) | 质量观、五条协作协议、约束密度 | 开工前，团队对齐 | — |
| QE-02 | [QE-02-机制化质量-ratchet与AI分模块协作](QE-02-mechanized-quality.zh-CN.md) | ratchet、缺陷分型、AI 分模块协议 | 每个迭代开始 / 新增守卫时 | inv13、ratchet |
| QE-03 | [QE-03-通用项目体检与上线判定](QE-03-project-audit-and-release-gate.zh-CN.md) | **通用体检作业单**：从现有项目快速整理 bug + 上线判定 | 接手任何现有项目 / 上线前 | 可配合全部守卫 |
| QE-04 | [QE-04-审计方法论](QE-04-audit-methodology.zh-CN.md) | 九类病根、审计与 ratchet 机制来源 | 缺陷分型 / 复盘 | — |
| QE-05 | [QE-05-不变量规范](QE-05-invariant-spec.zh-CN.md) | 不变量三态、层级、单源纪律 | 新增 / 裁决不变量时 | — |
| QE-06 | [QE-06-Next.js服务端边界与模块接缝](QE-06-nextjs-boundary-and-seams.zh-CN.md) | 入口鉴权/校验/幂等、客户端越界、跨模块深导 | 写 route handler / server action / 模块边界时 | inv20、inv21 |
| QE-07 | [QE-07-Prisma-PostgreSQL并发与约束](QE-07-prisma-postgresql-concurrency.zh-CN.md) | 唯一约束、事务、乐观锁、幂等、迁移 | 改 schema / 写并发路径时 | inv01、inv02、inv03 |
| QE-08 | [QE-08-对抗与恶意输入](QE-08-adversarial-input.zh-CN.md) | 威胁模型、四道边界、资源上限、输出脱敏 | 对外接口 / 安全评审 | inv20、inv21、inv22 |
| QE-09 | [QE-09-Zustand前端状态](QE-09-zustand-state.zh-CN.md) | persist 落盘边界、版本迁移、状态职责 | 新增 store / 持久化时 | inv22 |
| AGENTS | [AGENTS.md](../../AGENTS.md) | 编码 Agent 作业协议（强制） | 每次开工 | 全部 |

**业务域文档（不参与复制，编号沿用原仓）**

| 编号 | 文件 | 角色 |
|---|---|---|
| 05 | `业务域/05-配套技术规范.md` | 产品级技术规范（Schema / API / 前端状态 / 数据库） |
| 29 | `业务域/29-高并发与异步任务规范.md` | 幂等与原子三件套、跑批、存活率 |
| 44 | `业务域/44-平台后台规范.md` | 后台权限、节奏、挂账 |
| 48 | `业务域/48-Agent接入规范.md` | Agent/MCP 通道与 key 白名单 |
| 53 | `业务域/53-系统提升.md` | 系统性提升清单 |
| 59 | `业务域/59-跨系统数据规范.md` | 跨系统只读/鉴权/缓存/词表 |
| 60 | `业务域/60-支付双轨方案-服务商特约商户与直连自营.md` | 支付双轨 |

> 业务域文档不随开源包发布（见 `.gitignore`），此处仅保留文件名作为指针。

## 3. 三条阅读路径

**A. 第一次接入一个仓**
`AGENTS.md` → `QE-01` → `QE-02` → `QE-03`（跑体检）→ `QE-06~09`（按栈取舍）→ 对应领域文档。

**B. 接手一个现有项目、要尽快上线**
`QE-03` 是主作业单：先建事实基线，再做快速扫描，深挖七条主线，最后走上线 gate。
遇到具体栈问题时跳 `QE-06~09`；缺陷分型查 `QE-04`；不变量状态查 `QE-05`。

**C. 日常迭代新增模块**
`AGENTS.md` 开工前四张清单 → `QE-02` 的 ratchet 与分模块协议 → 改动类型对应的守卫 → `npm run qe:ci`。

## 4. 单源纪律（防漂移）

1. 不变量条目只在 `qe/registry/registry.ts`；文档出现条目内容即视为漂移。
2. 缺陷九类词汇只在 `QE-04` §一；本目录只引用。
3. 不变量三态语义只在 `QE-05`；本目录只引用。
4. 跑批写码纪律（幂等/原子三件套）若目标仓无 `业务域/29`，按 `QE-07` §3 执行。
5. 报告是带日期的快照，命令输出才是真源。

## 5. 常用命令

```bash
npm run qe                  # 全部守卫 + ratchet（红则退出码 1）
npm run qe:selftest        # 坏样本反证（19 例）
npm run qe:report          # 生成 qe-report/qe-report.md
npm run qe:list            # 注册表三态与缺口
npm run qe:guard:inv20     # 服务端边界
npm run qe:guard:inv21     # 客户端/服务端接缝
npm run qe:guard:inv22     # Zustand persist
npm run qe:ratchet:update  # 人工裁决后收紧基线
npm run qe:ci              # 提交门禁
```

## 6. 「已完成」声明模板

> 改动：<一句话>
> 不变量：<违反/新增的 INV-ID>
> 守卫读数：`GUARD_SUMMARY id=… status=…` 或 `QE_RESULT …`
> 基线：`RATCHET status=ok regressions=0`
> 坏样本：`SELFTEST guard=… case=… expect=red … PASS`
> 未入库项：<标「排期声明」，不标完成>

> 旧版入口链接（`README §6`）指的就是本文件的第 6 节。

## 7. 复制到其他项目（QE 复制包）

### 7.1 复制清单

| 类别 | 文件/目录 | 说明 |
|---|---|---|
| **必需（方法层）** | `QE-00-index.zh-CN.md`、`QE-01` ~ `QE-09` | 复制包主体：索引 + 方法层 + 栈专用判据，编号连续无缺口 |
| **可选（自动化）** | `qe/`、`qe.config.json`、`package.json` 的 `qe:*`、`tsconfig.qe.json`、`.github/workflows/qe.yml` | 不接入也能按 QE-03 人工体检；`tsconfig.qe.json` 独立存在，**不要覆盖目标仓的 tsconfig** |
| **合并（不要覆盖）** | `AGENTS.md` | 目标仓已有协作规则时，只合并「五条协议 / 施工守卫表 / 门禁 / 禁止动作」 |
| **不要复制** | `业务域/` 整个目录、`qe/demo/`、`qe-report/`、`qe-audit/` | 业务域规范随目标仓自身；demo 与历史报告会污染读数 |
| **基线** | `qe/ratchet.json` | 目标仓首次 `qe:ratchet:update` 生成，**不要复制本仓基线** |

> **目录约束**：`QE-00` ~ `QE-09` 与 `qe/` 必须**同级放在目标仓根目录**（本仓即如此），否则文档里的 `qe/...` 相对链接会失效。若目标仓坚持放 `docs/quality/`，复制后需把链接统一加 `../../`。

### 7.2 目标仓落地（每个项目一次）

1. 复制 7.1 的「必需 + 可选」到目标仓根目录；`AGENTS.md` 按合并方式处理。
2. 改 `qe.config.json`：`schema.path`、`source.roots`、`boundaries.publicRoutes`、`stores.moduleRoots/sensitiveKeys`、`ignore`。
3. `npm run qe:selftest`（应 19/19）→ `npm run qe`（第一份真实读数）→ 对存量红项做方向裁决 → `npm run qe:ratchet:update`。
4. 建体检工作区：复制 `qe/templates/project-audit/` 到 `qe-audit/<项目名>-<日期>/`。
5. 按 `QE-03` 跑 S0→S4，把结果写进工作区的五份文件（基线 / 入口清单 / 扫描记录 / Bug 台账 / 上线判定）。
6. 判定为「不可上线」时，P0 台账就是下一批修复的输入；修完重跑 `npm run qe:ci`，复验后更新台账。
7. 若体检引入外部清单，填 `05-gap-absorption-plan.md`（问题原话 + 适用性 + 自有载体 + 验收读数）；已有更严守卫的标「已有」，不替换。
8. 归档：`qe-audit/` 只保留结论与证据，不提交构建产物、日志原文、密钥。

### 7.3 逐个项目分析的固定产物

```text
qe-audit/
  <项目名>-<YYYY-MM-DD>/
    00-fact-baseline.md      # 构建/启动/迁移/环境变量/入口总数
    01-entry-inventory.md      # 路由/action/队列/webhook/脚本
    02-scan-log.md      # 15 项快扫 + 七条主线深挖
    03-bug-ledger.md       # P0–P3 + 证据等级 + 修复/复验
    04-release-decision.md      # 12 道 Gate + 结论 + 回滚方案
    05-gap-absorption-plan.md  # 引入外部清单时填：问题原话 / 适用性 / 自有载体 / 读数
```

模板见 `qe/templates/project-audit/`。前五个文件不齐，不允许给出上线结论；第 6 个文件仅在引入外部清单时必填。

### 7.4 多项目并行时的边界

- 每个项目独立 `qe.config.json` 与 `qe/ratchet.json`；不要共用一份基线。
- 文档方法层共用一份（升级时整体替换 `QE-*`），业务域文档各自维护。
- 体检报告只写「本项目的事实」，跨项目共性缺陷升到 `QE-04` 的九类或 registry 条目，不复制到每个报告里。

