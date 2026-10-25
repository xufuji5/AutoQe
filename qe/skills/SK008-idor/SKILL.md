---
id: SK008
title: 按 ID 直取无归属校验（IDOR）
status: rule
rules: [AQ008]
defectClass: 越权访问 / 水平权限
provenance: 试点 A 多租户盘点 + 试点 B 权限矩阵（RLS 之外的应用层归属校验缺口）
question: 这个 id 是请求给的，凭什么认为它属于调用者？
---

# 按 ID 直取无归属校验（IDOR）
## 长什么样

```ts
const record = await prisma.record.findUnique({ where: { id: params.id } })
return Response.json(record)      // ← 把 id 换成别人的，数据就出去了
```

## 为什么功能测试抓不到

测试用的是**自己的** id。功能正确、类型正确、权限「看起来」也对。

## 怎么判

路由文件里，`findUnique({ where: { id } })` 的 where 体内**只有** id 系字段
（没有 `tenantId`/`userId`/`orgId`），且 id 来自请求（`params.id` / `searchParams.get`）。

## 误报边界（决定它只能 report-only）

有些 id 是**公开资源**（公开资产、文章），查到别人写的也算合法。这属于语义不可判定。
正确用法：Report-Only 跑一轮，把核实过的路径写进 `ownershipReviewed`（双向校验），
剩下的才升 Enforce。

## 修复形态

`where: { id, tenantId: session.tenantId }`，或查完显式 `assertOwner(row, session)`。
数据库层 RLS 是第二道，不是第一道。
