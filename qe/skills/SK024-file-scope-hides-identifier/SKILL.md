---
id: SK024
title: 文件级判据要精确到标识符，否则一个文件一个结论
status: rule
rules: [AQ008, AQ005]
defectClass: 接缝 / 证据不足
provenance: 2026-10-24 外部试点 C：IDOR 判据在 8 条剩余命中里 4 条是「文件里别处出现了请求参数」，被查的 id 其实来自已鉴权实体或会话推导
question: 这条判据的输入是「整个文件」还是「这个表达式」？如果是文件，文件里还有几个同名不同源的变量？
---

# 文件级判据要精确到标识符

## 血案

一条 IDOR 判据的射程判定是文件级的：

```ts
if (!FROM_REQUEST.test(code)) return []   // 文件里出现过 params.id / searchParams.get 就算
```

于是同一个文件里，**任何** `findUnique({ where: { id } })` 都被当成「id 来自请求」。
目标仓的两个典型：

```ts
// ① 消息页：peerId 由会话推导（resolvePeer(cursor)），文件里另有 searchParams.get 是给游标用的
const peer = await prisma.profile.findUnique({ where: { id: peerId } })

// ② 详情页：record.id 是前面已经断言过归属的实体
const record = await prisma.record.findUnique({ where: { id: params.id } })
if (record.userId !== auth.user!.id) return FORBIDDEN
const fresh = await prisma.record.findUnique({ where: { id: record.id } })
```

两条都被报成「任何人都能换 id 读到别人的数据」。判据的注释还写着
「查完再 assertOwner 的写法不可见」—— 其实往下读 40 行就可见。

## 判据纪律

1. 射程判断（这个文件可能相关吗）可以是文件级；**结论判断必须精确到标识符**。
   从 `where: { id }` 里取出那个 id 的**表达式**（`id` / `id: foo` / `id: order.id`），
   再回溯它的赋值来源。
2. 成员表达式（`order.id`、`session.userId`）不来自请求 —— 除非它就是 `params.id`。
3. 变量要回溯赋值右值：`const specId = searchParams.get('specId')` 才算；
   `const peerId = resolvePeer(cursor)` 不算。解构 `const { id } = await params` 算。
4. 「查完再校验」不是不可见，是**判据没往下读**。同文件命中点后 N 行的
   `x.userId !== y.id` / `FORBIDDEN` / `assertOwner(` 足以否决这条命中。
5. 平台运营面（后台）跨主体取数是设计，不是越权 —— 用前缀声明，不要默认放行整仓。

## 反证

```
where: { id: params.id } + 后面无校验        → 报
where: { id: params.id } + 后面断言归属      → 不报
where: { id: order.id }（已鉴权实体）        → 不报
const peerId = resolvePeer(...); where:{id:peerId} → 不报
const specId = searchParams.get(...); where:{id:specId} → 报
```

## 怎么问

- 这个 id 变量，往上三行是谁赋的值？
- 如果是请求参数，查完之后有没有一行在比较它和当前主体？
- 同一个文件里还有几个叫 id 的东西？我的判据分得清它们吗？
