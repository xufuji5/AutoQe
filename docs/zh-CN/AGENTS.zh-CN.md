# AGENTS.md — AI Coding Quality Collaboration Protocol (Chinese edition)

> Chinese edition of [AGENTS.md](../../AGENTS.md).

> 本文件是给编码 Agent 的作业协议，不是参考资料。
> 验收口径：**AI 的每个「已完成」必须可寻址**（commit / 守卫读数 / 台账行，三者至少一）。「已完成」三个字不构成证据。
> 文档入口是 [`QE-00-index.zh-CN.md`](QE-00-index.zh-CN.md)；栈专用判据见 `QE-06~09`，通用项目体检与上线判定见 `QE-03`。文档只写方法与指针，条目不变量单源仍是 `qe/registry/registry.ts`。

## 0. 一句话

质量 = 约束密度：**不变量 > 用例**。用例问「这条路径对不对」，不变量问「这件事是否恒成立」。
测试是枚举，AI 的缺陷是结构性的——枚举永远追不上结构。所以先立约束，再写业务，最后才跑测。

## 1. 五条协作协议

1. **AI 填中间，不碰边界。** schema、契约、枚举、错误码、状态机由单源生成；AI 只写中间业务逻辑。边界还是手写的，先补边界生成器。
2. **先出「哪里会静默出错」清单再动手。** 每个功能开工前，先列可能静默失败 / 假绿 / 无来源的点（至少 3 条），再实现。
3. **坏样本由对账方注入。** AI 自测结果不单独采信；守卫必须能对独立构造的坏样本见红。
4. **验收顺序固定**：不变量查表（违反第几条 INV？）→ 守卫 → e2e → 人工抽检。先查表（秒级）后跑测（分钟级）。
5. **完成声明可寻址**：commit、`GUARD_SUMMARY` 读数、台账行，至少给一个。

## 2. 开工前（缺一不开工）

- [ ] 立项单填完五问：违反哪条 INV / 新增哪条 INV / 在哪一层拦（L0–L5）/ 有无不可逆动作 / 反例是什么
- [ ] 静默出错清单（≥3 条，逐条写「会以什么形式静默」）
- [ ] 触及面清单：表 / 列 / 枚举值 / 契约键 / 闸与控件
- [ ] **接缝清单**：本模块被谁调用、调用谁、公开入口（`index.ts`）是什么、跨模块导入走哪条路径
- 模板：`qe/templates/立项单.md`

## 3. 施工中（改动类型 → 必跑的守卫）

| 改动 | 必做 | 守卫 |
|---|---|---|
| 新增/修改列 | 写明写入者函数名；或删列 | `inv01`（零写列） |
| 新增读点 | 确认 select/where 覆盖，或声明 `/// @archive` | `inv02`（零读列） |
| 新增枚举值 | 写出产生路径（哪个写点、什么条件） | `inv03`（死枚举） |
| 新增承诺句（规范/注释/界面文案） | 在 `qe.contracts.json` 登记 + 抛错点 | `inv06`（幽灵规则） |
| 新增闸/拒收句 | 登记 gate：服务端判据 + 界面控件 | `inv07`（空转闸） |
| 新增服务端入口（route handler / server action） | 鉴权 + schema 校验；变更入口带幂等键；公共路由写理由 | `inv20`（服务端边界） |
| 新增客户端文件 / 跨模块导入 | 不触达 Prisma/node/server-only；跨模块走公开入口 | `inv21`（接缝） |
| 新增 Zustand persist | `partialize` 白名单 + `version`；敏感键不落盘 | `inv22`（前端状态） |
| 新增守卫 | 注册表登记 + package.json 别名 + 坏样本 | `inv13`（可寻址） |

纪律：**先红后绿**（新守卫第一天必须对坏样本见红）；**先裁后建**（册错改册、码错改码，禁「两边都对」）；**只降不升**（`qe/ratchet.json` 计数基线只准收紧，新违规不得入基线）。

## 4. 提交 / 发版门禁

```bash
npm run qe:ci      # typecheck + 坏样本反证 + 守卫 + 报告
npm run qe         # 守卫 + ratchet 比对（RATCHET status=ok 才可宣称只降不升）
```

- 报告读数在 `qe-report/qe-report.md`（命令即真源，报告只是带日期的快照）。
- 红项逐条分型：本批引入 / 存量 / 并行批（非本批不代改，但要说清归属）。
- 未 commit 的项一律标「排期声明」，不标完成。
- 基线变更只能走 `npm run qe:ratchet:update`，并在提交信息写「key / 旧值 / 新值 / 理由」。

## 5. 禁止动作（历史上都发生过）

- `--no-verify` 跳过钩子；把新违规塞进 baseline（D6：ratchet 只准变少）
- 没有判据就标 `enforced`；`open` 不写理由 / 不写复审触发器（无账即红）
- 在文档里维护第二份不变量清单（条目单源 = `qe/registry/registry.ts`）
- 把环境/时段敏感读数写进 CI 断言（D7）
- 守卫扫到 0 个对象就报绿（D1：空集恒真 = 假绿）

## 6. 接入一个真实仓（三步）

1. 按 [`QE-00-index.zh-CN.md`](QE-00-index.zh-CN.md) §7 复制 QE 复制包：`QE-00` ~ `QE-09` 全部方法层文档 + `qe/` + `qe.config.json` + `package.json` 的 `qe:*` + `tsconfig.qe.json`。`AGENTS.md` 只合并、不覆盖目标仓已有规则；`tsconfig.qe.json` 独立使用，不要覆盖目标仓 `tsconfig.json`；`业务域/`、`qe/ratchet.json`、`qe/demo/`、`qe-report/` 不要复制。
2. 改 `qe.config.json`：
   - `schema.provider`：`prisma`（内置）或 `none`；`schema.path` 指向 schema 文件
   - `source.collector`：`ts`（内置）或 `none`；`source.roots` / `source.extensions` 指向源码
   - `boundaries`：鉴权/校验词表、变更方法、`publicRoutes`（每条理由必填）
   - `stores`：`moduleRoots`（模块边界目录）、`sensitiveKeys`（禁落盘字段）
   - 其余：`ignore`、`contracts`、`systemFields`、`fieldExemptions`（理由必填）
3. 先跑 `npm run qe:selftest`（应 19/19 绿），再跑 `npm run qe` 拿第一份真实读数；对存量红项走方向裁决，不许用豁免掩盖。
4. 首次接入后 `npm run qe:ratchet:update` 固化基线（此后只准降）。

**适配器语义**：`provider=none` 或 `collector=none` 时，依赖 schema/源码的守卫输出 `status=skipped`（整批转黄），**不报绿**。
换栈只需实现 `SchemaProvider` 或 `CallCollector`（[providers.ts](../../qe/lib/providers.ts)）并在同文件 `registerSchemaProvider` / `registerCollector` 一行注册，内核守卫不用改。
内置只有 Prisma + TS 两件适配器，其余栈按需新增，禁止预先写「未来适配器」。

环境：Node ≥ 22.18（原生 TS 类型剥离，无需构建）、TypeScript 5.9、Prisma 5/6。
