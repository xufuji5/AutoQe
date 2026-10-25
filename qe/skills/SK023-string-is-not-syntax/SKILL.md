---
id: SK023
title: 在字符串里找语法，等于给自己造了一个恒真入口
status: rule
rules: [AQ007]
defectClass: 测试方法论 / 假绿
provenance: 2026-10-24 外部试点 C：`assert('复用序列 [false,true,true]', ...)` 被「常量真断言」误报，正则吃到的是消息里的 `,true,`
question: 这条判据的匹配，有可能命中字符串内容吗？命中了以后还分得清是真语法吗？
---

# 在字符串里找语法，等于给自己造了一个恒真入口

## 血案

一条元判据找「恒真断言」，正则是：

```ts
/\bassert\s*\(\s*[^,)]+,\s*true\s*[,)]/g
```

目标仓有一行：

```ts
suite.assert('复用序列符合预期 [false,true,true,false]', JSON.stringify(x.reused) === '[...]', x.reused)
```

`[^,)]+` 一路吃到消息串里的 `…[false`，然后 `,true,` 正好接上 —— **判定第二个实参是
字面量 `true`**。实际上第二个实参是一次严格的字符串相等比较，会红。

同一天还有一处：`assert(msg, idx >= 0)` 里 `idx = lines.findIndex(...)`。
`findIndex` 找不到返回 **-1**，所以 `>= 0` 是正常判据；判据把「计数 ≥0」的规则
套在它身上，报成恒真。**「≥0 恒真」只对计数成立，对索引不成立。**

## 判据纪律

1. 断言类判据必须按**实参位置**解析：先在抹掉字符串内容的面（`maskStringBodies`）
   上定位 `assert(`，用括号配对 + 顶层逗号切出实参，再回原文取每个实参的文本。
   不能在整行上跑正则 —— 那一行里有消息、有表达式、有注释。
2. `needStrings: true`（要看字符串字面量本身）与「在字符串里找语法」是两件事：
   前者是「我要判断这个实参是不是字符串」，后者是「我在消息文案里找代码形状」。
3. 「计数 ≥ 0 恒真」要限定左值是计数表达式（`length` / `count` / `size` / `total`）；
   `findIndex` / `indexOf` 返回 `-1`，不是计数。
4. 一条断言**能不能红**要看上下文：
   - 紧邻 `await` 的 `assert(true)` —— 调用抛错会让用例 CRASH，它不是假绿，只是冗余；
   - `try { assert(msg, true) } catch { assert(msg, false) }` —— 成对写法能红，不是假绿。
   判据若不分这两类，会把「写得对」的守卫报成「假绿」，然后逼人删掉它们。

## 反证

```
assert('用户能登录', true)                          → 报
assert('复用序列 [false,true,true]', a === '[...]')  → 不报（字符串里的 ,true,）
assert('索引存在', findIndex(...) >= 0)              → 不报（-1 是可能的）
assert('文件数', files.length >= 0)                  → 报
try { assert('可解析', true) } catch { assert('可解析', false) } → 不报
await tx.$executeRawUnsafe(ddl); assert('建索引成功', true)      → 不报
```

## 怎么问

- 这个正则会在消息文案、SQL、模板串里命中吗？命中了以后，你怎么区分真假？
- 这条断言的左值，找不到时返回什么？0 还是 -1？
- 如果这条 assert 真的恒真，前面的 `await` 抛错时用例是什么颜色？
