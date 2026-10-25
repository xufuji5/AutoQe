# 01 · Entry Inventory

> **中文摘要**：全量入口清单：类型、方法或事件、路径或导出名、文件行，以及鉴权、对象级授权、输入校验、幂等、直接写库。
> 另含公共入口登记、队列/定时/Webhook 与入口覆盖核对。依据 `QE-03` §1.3 / §3-C；入口不全，鉴权与校验检查全部无效。

> Basis: `QE-03` §1.3 / §3-C. **If the entry list is incomplete, every auth and validation check is void.**
> Encoding rules: auth → "yes / no / public (reason)"; validation → "schema name / none"; idempotency → "key mechanism / none / N/A".

| # | Type / 类型 | Method / event / 方法或事件 | Path / export / 路径或导出名 | File:line / 文件:行 | Auth / 鉴权 | Object-level authz / 对象级授权 | Input validation / 输入校验 | Idempotency / 幂等 | Direct DB write / 直接写库 | Notes / 备注 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | HTTP | POST | /api/records | src/app/api/records/route.ts:12 | yes | pending | recordSchema | Idempotency-Key | yes | |
| 2 | | | | | | | | | | |

## Public entry registry / 公共入口登记

| Path / export / 路径或导出 | Why it may be public / 为什么可以公开 | Does the response contain business data? / 返回数据是否含业务信息 | Rate limit / 限流 | Size cap / 体积上限 | Review date / 复审日期 |
|---|---|---|---|---|---|
| | | | | | |

> A public entry with an empty reason = P0. "Internal use" or "temporary" are not valid reasons.

## Queues, schedules, webhooks / 队列、定时与 Webhook

| Entry / 入口 | Trigger source / 触发源 | Auth / signature / 鉴权或签名 | Safe on duplicate consumption? / 重复消费是否安全 | Is failure observable? / 失败是否可观测 | Notes / 备注 |
|---|---|---|---|---|---|
| | | | | | |

## Entry coverage check / 入口覆盖核对

- [ ] Route files listed in full (not sampled)
- [ ] `'use server'` exports listed
- [ ] Queue consumers / cron jobs listed
- [ ] Webhooks listed
- [ ] Ops scripts listed
- [ ] Cross-checked against the build output / framework route table
