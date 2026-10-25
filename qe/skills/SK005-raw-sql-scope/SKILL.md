---
id: SK005
title: 原生 SQL 缺租户收敛 / 拼接注入
status: rule
rules: [AQ005]
defectClass: 跨租户越权 / SQL 注入
provenance: 试点 B scripts/lib/raw-sql-scan.ts（原生 SQL 是主要数据通路）+ 试点 A 多租户盘点
question: 每一句手写 SQL，租户条件写在 where 里还是指望调用方记得？
---

# 原生 SQL 缺租户收敛 / 拼接注入
## 两种洞，两个判据

```ts
// ① 跨租户读：单租户测试永远绿，上线后 A 看到 B 的单子
await prisma.$queryRaw`select * from "Batch" where id = ${id}`

// ② 注入：参数直接拼进字符串
await prisma.$queryRawUnsafe(`select * from "Order" where id = ${id}`)
```

## 怎么判

- `$queryRawUnsafe` / `$executeRawUnsafe` + 模板里有 `${` → high（注入）
- `$queryRaw` / `$executeRaw` 模板里没有租户列（`tenantId`/`merchantId`/`orgId`…）→ high（跨租户）

## 误报边界

平台维查询（全站统计、跑批）本来就不带租户。按文件声明 `platformScope`，双向校验。
`select 1` / `select now()` 这类健康检查用 `trivial` 正则放过。

## 修复形态

参数化（`$queryRaw` 模板本身是参数化的，问题在租户条件）+ 强制带收敛列；
平台维查询走**单独的、有名字的**入口，而不是随手写一句不带 where 的 SQL。
