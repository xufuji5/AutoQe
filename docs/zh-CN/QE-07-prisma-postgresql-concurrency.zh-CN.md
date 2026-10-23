# QE-07 · Prisma + PostgreSQL Concurrency and Constraints

> Chinese edition of [QE-07-prisma-postgresql-concurrency.md](../../QE-07-prisma-postgresql-concurrency.md).

> 覆盖：INV-CORE-01/02/03、INV-CORE-12(open)、INV-DB-01/02(open)
> 守卫：`npm run qe:guard:inv01`、`inv02`、`inv03`；迁移/并发属发版 gate
> 条目单源：[`qe/registry/registry.ts`](../../qe/registry/registry.ts)
> 写码纪律（幂等/原子三件套、跑批、存活率）若目标仓自带 29 号文档，以其为准；**QE 复制包不含 29 号**，此时按本文 §3 执行，不依赖外部文档。

## 1. 并发 bug 的形态：不是「算错」，是「两个都对」

单请求测试永远测不出并发缺陷，因为每个请求单独看都正确。真实缺陷来自两个写者同时通过检查：

```
T1: read balance = 100
T2: read balance = 100
T1: write balance = 90   -- 扣 10
T2: write balance = 90   -- 也扣 10，实际只扣了一次
```

**结论：并发正确性不能靠「用例覆盖」，只能靠约束（唯一键/事务/锁/幂等键）与状态机。**

## 2. 静默出错清单

| # | 会以什么形式静默 | 对应不变量 | 机器/人工判据 |
|---|---|---|---|
| 1 | 先 `findUnique` 判断不存在，再 `create`，并发下两条都插入 | INV-DB-02 | DB 唯一约束 + 冲突分类；静态扫描暂 open |
| 2 | 更新用 `update({ data: { balance: newBalance } })`，丢失并发更新 | INV-DB-01 | 乐观锁 `version` 或原子 `decrement`；人工/评审 |
| 3 | 状态从 `PENDING` 直接改成 `PAID`，两个回调都执行 | INV-CORE-04/12 | 条件更新 `updateMany({ where: { status: 'PENDING' } })` 判影响行数 |
| 4 | 枚举值只加进 schema，没有任何产生路径 | INV-CORE-03 | `DEAD_ENUM`（inv03） |
| 5 | 列建了但没人写，读侧永远拿到 null/默认值 | INV-CORE-01 | `ZERO_WRITER`（inv01） |
| 6 | 软删后按 id 读、计数、导出仍包含已删行 | INV-CORE-05(open) | 读点全家桶巡检；建议统一 `notDeleted` 作用域 |
| 7 | 迁移在开发库手工补过一列，CI 新库重放失败 | INV-CORE-09(open) | 干净副本库重放 gate |

## 3. 约束优先：先让数据库拦，再让代码拦

### 3.1 唯一性

```prisma
model Order {
  id          String   @id @default(cuid())
  tenantId    String
  orderNo     String
  status      OrderStatus @default(PENDING)
  totalCents  Int
  version     Int      @default(0)
  deletedAt   DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([tenantId, orderNo])   // 业务唯一键必须落到 DB
  @@index([tenantId, status, createdAt])
  @@map("orders")
}
```

判据：**任何「先查后插」的业务唯一性，都必须同步存在 `@@unique`。** 代码只负责把唯一冲突翻译成业务错误码，不负责「保证不重复」。

### 3.2 条件更新（状态机）

```ts
const updated = await prisma.order.updateMany({
  where: { id, status: 'PENDING' },
  data: { status: 'PAID', paidAt: new Date() },
})
if (updated.count === 0) throw new ConflictError('ORDER_STATE_CONFLICT')
```

判据：状态迁移必须带「前置状态」谓词，并检查 `count`。裸 `update({ where: { id } })` 视为丢失更新风险。

### 3.3 事务与隔离

```ts
await prisma.$transaction(async (tx) => {
  const rows = await tx.order.updateMany({
    where: { id, status: 'PENDING', version },
    data: { status: 'PAID', version: { increment: 1 } },
  })
  if (rows.count === 0) throw new ConflictError('ORDER_VERSION_CONFLICT')
  await tx.ledger.create({ data: { orderId: id, amountCents, direction: 'IN' } })
})
```

- 资金/库存的「读—判—写」必须同事务。
- 热点行用乐观锁（`version`）或 `SELECT … FOR UPDATE`（Prisma 需 `$queryRaw`）。
- 死锁/序列化失败要**分类重试**（有限次数 + 退避），不能吞掉当成功。

### 3.4 幂等

- 变更入口带 `Idempotency-Key`（inv20 告警）。
- 服务端把 `key + 请求摘要` 写入去重表，唯一键冲突视为「已处理」，返回首次结果。
- 幂等记录与业务写入同事务；否则会留下「键写了、业务没写」的空洞。

## 4. schema 书写判据（AI 生成 schema 时逐条对照）

| 判据 | 原因 | 守卫 |
|---|---|---|
| 每个标量列有写入者，否则删列 | 活表死列会被读成默认值 | inv01 |
| 每个列有读取者，或在 schema 用 `/// @archive` 声明存档 | 无人读的列是历史包袱 | inv02 |
| 枚举每个取值有产生路径 | 死枚举让状态机出现不可达分支 | inv03 |
| 金额用整数分（`Int`/`BigInt`），不用 `Float` | 浮点误差静默累积 | 评审 |
| 时间列统一 `DateTime`，禁止字符串时间 | 时区/排序错误 | 评审 |
| 多租户表带 `tenantId` 且进唯一键/索引 | 越权与串租户 | INV-CORE-08(open) |
| 软删表统一 `deletedAt` + 读侧过滤 | 已删数据复活 | INV-CORE-05(open) |
| 高频查询有对应复合索引 | 慢查询拖垮连接池 | 05 号文档 + 评审 |

## 5. 迁移与连接池

- **迁移链**：CI 用干净库 `prisma migrate deploy` 全量重放；禁止「开发库手工补列」。属发版 gate（INV-CORE-09）。
- **连接池**：Serverless/Next.js 多实例下必须走 PgBouncer 或 `connection_limit` 限制；`PrismaClient` 单例挂全局，避免热重载创建多份（dev 泄漏）。
- **长事务**：禁止在事务内做外部 HTTP 调用；事务持有连接会放大锁等待。
- **索引**：新增 `where`/`orderBy` 组合前先看执行计划；`EXPLAIN` 读数入库到 PR 描述。

## 6. 与 AI 的协作边界

AI 可以写：查询、DTO、错误映射、事务内业务步骤。
AI 不应独自决定：唯一键、状态机迁移表、隔离级别、重试策略、索引——这些属于**边界**，必须由人给出或从 registry 派生。边界缺失时先补边界，不写业务。

## 7. 完成判据

- `GUARD_SUMMARY id=inv01-column-writer status=green`
- `GUARD_SUMMARY id=inv02-column-reader status=green`
- `GUARD_SUMMARY id=inv03-dead-enum status=green`
- 变更写路径：PR 描述里给出「约束 / 事务 / 幂等 / 冲突分类」四项中适用的项。
- 迁移改动：干净库重放通过（发版 gate 记录）。
