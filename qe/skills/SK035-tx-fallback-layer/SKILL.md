---
id: SK035
title: 兜底写在事务里：事务已被中止，回读只会再失败一次
status: rule
rules: [AQ014, AQ004]
defectClass: 并发正确性 / 防线幻觉
provenance: 2026-10-25 外部试点 D：账本类写入口的幂等快路在并发下不存在，输家撞唯一索引后 500；第一次修复把回读写在事务内，实测报 current transaction is aborted
question: 这个 catch 在事务里还是事务外？它里面用到的还是那个事务句柄吗？
---

# 兜底写在事务里：事务已被中止

## 血案

一个「靠唯一索引防重」的账本写入，结构是这样的：

```ts
const existing = await tx.findUnique({ where: { 业务键 } })
if (existing) return { applied: false }        // 幂等快路
...
await tx.create({ data: 业务键 })               // 输家在这里撞 P2002
```

并发时两个请求同时查到空，快路**不存在**。输家撞上唯一索引，P2002 冒出去变成 500。
调用方是支付网关回调：**见 500 就重试**，重试还是撞同一个键 —— 循环式 500，
账面永远差那一笔，而对账报表看不出「有一笔被拒了」，只看到「就是没有」。

第一次修复长这样（看着很对，实际上更坏）：

```ts
return prisma.$transaction(async (tx) => {
  try {
    await tx.create({ data: 业务键 })
    return { applied: true }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    const again = await tx.findUnique({ where: { 业务键 } })   // ← 必然再抛
    return { applied: false, entryId: again.id }
  }
})
```

PostgreSQL 的规则：**一条语句出错后事务进入 aborted 状态**，后续任何语句返回
`25P02 current transaction is aborted`。于是「兜底」把 P2002 换成了 25P02，
照样 500、照样重试。修复前是「没有兜底」，修复后是「兜底保证失败」——
两者的线上表现完全一样。

## 判据纪律

1. **层级是判据的一部分**。「这个文件里有 P2002 处理」不是保护，
   「这个 catch 在事务回调**外面**」才是保护。
2. `catch` 体内只要还出现事务句柄（`tx.`），就是错的 —— 无论它想读、想写、想日志化。
3. 纯重抛的 catch 无害（`catch { throw err }`、`if (!e) throw e` 都算），不要把它算成兜底。
4. 兜底动作 = 回读赢家行 + 幂等返回。它必须用**普通客户端**（`prisma.`）而不是 `tx`：
   事务已经结束，此时的回读是一次新事务，能看到赢家已提交的行。
5. 唯一约束保护的是**数据**，不是**响应**。「表上有唯一键所以并发安全」这句话只对了一半：
   数据确实不会双写，但输家拿到的是 500。对网关回调/队列消费者，500 = 无限重试。

## 反证

```
catch 在事务内 + 体内 tx.findUnique        → 红（必然 25P02）
catch 在事务内 + 只有 isUniqueViolation + return → 红（换了个错而已）
catch 在事务外 + prisma.findUnique        → 不红（修复形态）
catch 在事务内 + 只有 throw               → 不红（纯重抛）
$transaction([a, b]) 数组形态              → 不红（没有回调，没有 catch）
```

## 怎么问

- 这个 catch 的**开括号**在 `$transaction` 的回调里，还是在它的 `.catch`/外层 `try` 里？
- catch 里第一个 `await` 用的是 `tx` 还是 `prisma`？
- 这个写入口的调用方是谁？它 500 之后会重试吗？重试会撞同一个键吗？
