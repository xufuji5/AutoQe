---
id: SK020
title: 声称「按在途状态去重」的 findFirst 不是去重
status: rule
rules: [AQ004, AQ009]
defectClass: 并发 / 静默重复
provenance: 2026-10-24 外部试跑：试点 C 一处待办信号的注释声称「去重防重复推送」，DB 兜底键在该写点为 NULL，索引管不到
question: 这个「去重」的兜底在哪一层？如果只在应用层，那并发的第二个请求凭什么被挡住？
---

# 声称「按在途状态去重」的 findFirst 不是去重

## 血案

一处业务待办在跨阈值时落库，注释写得很确定：

> 待办按业务主体的 open/claimed 行去重，防重复推送

代码：

```ts
const openExists = await db.signal.findFirst({
  where: { queue: 'X', subjectId, status: { in: ['open', 'claimed'] } },
})
if (!openExists) await db.signal.create({ data: { queue: 'X', subjectId, ... } })
```

而这张表的在途去重索引是**部分唯一索引**，只对「去重键」非空的行生效：

```sql
CREATE UNIQUE INDEX ... ON signals(dedupe_key)
  WHERE status IN ('open','claimed') AND dedupe_key IS NOT NULL;
```

该写点**没有写去重键** ⇒ 行落在索引外面 ⇒ 索引对它是空气。
两个不同业务事件并发跨线（各自 sourceId 天然不同、互不阻塞），双方都读到空，
双方都建成功 —— 这不是理论，迁移脚本自己的注释就写着「跑批与手工重跑重叠时尤其明显」。

## 判据纪律

1. 「查了再建」只有在**建的那条语句会失败**时才是并发安全的：
   唯一键必须被**同一个写点**写入，且在冲突时接住唯一冲突错误码走「已存在」分支。
2. 部分唯一索引（`WHERE status IN (...)`）比普通唯一更危险：
   它的生效条件与写入值耦合，写入方少传一列就静默退出索引 —— 谁也不知道。
3. 因此「表上有唯一索引」不能作为 check-then-act 的豁免条件。
   豁免条件是：**索引列与这条 create 出现在同一处代码里**。
   判据能做的检查：索引列（如去重键）出现在这条 create 的 data 里吗？
   没出现 ⇒ 索引不覆盖该写点 ⇒ 仍是查后建。
4. 项目若声明了「唯一写入口」（一个负责生成键并接住冲突的错误码的 helper），
   则任何绕过它直接 `model.create` 的地方都失去兜底 —— 这属于「单源被旁路」，
   不是「风格不统一」。审计要先数「旁路数 / 总写点数」，再逐点判断是否真的需要去重。
5. 上面第 3、4 条已机检（`aq09`）：在 `rules.aq09.uniqueWrites` 声明
   `{ model, entry, protectField }` 后，任何 `model.create({ data: {…} })` 的对象字面量里
   没有 `protectField` 就是 error。**只认字面量**：`data` 由变量拼装时判据看不见，
   那部分仍要人核（这是本条的盲区，不是「已检查 0 处」）。

## 反证

```
写点带唯一键 + 接住冲突错误码   → 不报（机制真的在）
写点不写唯一键                  → 必须报（索引管不到）
表上没有任何唯一约束            → 必须报
```

## 怎么问

- 并发第二个请求，会撞到哪条约束？说出约束名，以及它覆盖的那一列。
- 那一列，这条 create 写了吗？
- 如果写入方在 `if (existing)` 里，那么 `existing` 是何时被别的事务看见的？
