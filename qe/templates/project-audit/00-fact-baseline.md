# 00 · Fact Baseline

> **中文摘要**：体检第 0 步：记录仓库与环境、构建与运行、环境变量、入口规模、体检范围与排除项、初始 P0 线索。
> 依据 `QE-03` §1；本文件没有记录的事实，后续所有结论都视为未验证。构建失败、迁移不可重放、健康检查不可用，任一成立直接记 P0。

> Project: <project name> | Version / commit: <hash> | Audit date: <YYYY-MM-DD> | Auditor: <name>
> Basis: `QE-03` §1. **Any fact not recorded in this file makes every later conclusion unverified.**

## 1. Repository and environment / 仓库与环境

| Item / 项 | Record / 记录 |
|---|---|
| Repository path / 仓库路径 | |
| Branch / commit / 分支与 commit | |
| Package manager / version / 包管理器与版本 | |
| Runtime / version / 运行时与版本 | |
| Database / version / 数据库与版本 | |
| Deployment shape / 部署形态 | Single host / container / serverless / other |
| Environment (for this audit) / 环境 | Local / staging / production shadow |

## 2. Build and run / 构建与运行

| Check / 检查 | Command / 命令 | Result / 结果 | First error / duration / 首个错误或耗时 |
|---|---|---|---|
| Install dependencies / 安装依赖 | | success / failure | |
| Build / 构建 | | success / failure | |
| Type check / 类型检查 | | error count: | |
| Lint | | error count: | |
| Unit / integration tests / 单元与集成测试 | | passed / skipped / duration | |
| Start / 启动 | | success / failure / duration | |
| Health check / 健康检查 | `curl <url>` | status code / dependency status | |
| Migration replay on empty DB / 空库迁移重放 | | success / failure | |

> Build failure, non-replayable migrations, or an unusable health check: any one of these is an immediate P0.

## 3. Environment variables / 环境变量

| Variable / 变量 | Read site in code / 代码读取处 | `.env.example` | Behavior when missing (fail-open / closed) / 缺失时行为 | Notes / 备注 |
|---|---|---|---|---|
| | | present / absent | | |

- Is `.env*` committed? yes / no
- Frontend-readable variables (`NEXT_PUBLIC_` / `VITE_`) inventory and risk: / 前端可读变量清单与风险：

## 4. Entry scale / 入口规模

| Type / 类型 | Count / 数量 | Notes / 备注 |
|---|---|---|
| HTTP routes / HTTP 路由 | | |
| Server Actions | | |
| Queue consumers / scheduled jobs / 队列消费者与定时任务 | | |
| Webhooks | | |
| CLI / ops scripts / CLI 与运维脚本 | | |
| Agent / MCP channels / Agent 与 MCP 通道 | | |

## 5. Audit scope and exclusions / 体检范围与排除项

- Modules covered / 覆盖模块：
- Modules not covered and why / 未覆盖模块及原因：
- Unavailable environments or data / 不可用环境或数据：
- Checks deliberately skipped this time / 本次不做的检查：

## 6. Initial P0 leads / 初始 P0 线索

| Lead / 线索 | Evidence / 证据 | Status (unverified / reproduced) / 状态（待验证 / 已复现） |
|---|---|---|
| | | |
