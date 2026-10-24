---
id: SK004
title: 先查后写（check-then-act 竞态）
status: rule
rules: [AQ004]
defectClass: 并发 A 类 / 状态与库存竞态
provenance: 试点 A concurrency-patterns baseline（每轮 probe 都撞出「2 路恰串行」假绿）+ 试点 B 批号/库存扣减事故
question: 这个「先查存在再创建」的路径，两个请求同时进来会发生什么？
---

# 先查后写（check-then-act 竞态）
## 长什么样

```ts
const found = await prisma.user.findUnique({ where: { email } })
if (found) return found
return prisma.user.create({ data: { email } })     // ← 两个请求都走这条
```

## 为什么贵

唯一约束挡住 → 用户看到 500。
没唯一约束 → **两条重复记录，不报错**（更坏：账面干净，数据错）。
库存/余额版本是直接卖超或透支。

## 怎么判

同一文件内，`findUnique|findFirst|findOne` 之后 40 行内出现**同一模型**的 `.create(`，
且区间里没有：`upsert` / `$transaction` / `P2002` / `@unique` / `FOR UPDATE`。

⚠️ 一个已踩的坑：**不能把裸 `unique` 当守卫** —— `findUnique` 自己就含这个词，
会让规则把自己的查询判成「已保护」，永久假绿。本规则第一版就是这样。

## 修复形态

`upsert`，或捕获 P2002 后回查，或事务内 `SELECT ... FOR UPDATE`。
