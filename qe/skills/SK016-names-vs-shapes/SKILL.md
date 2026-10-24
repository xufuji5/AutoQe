---
id: SK016
title: 靠「列名字」判行为，换一个项目就错一半
status: rule
rules: [AQ006]
defectClass: 判据失效 / 名册必然列不全
provenance: 2026-10-24 首轮外部试跑：AQ006 第一版列 auth/requireAuth/assertAdmin，试点 A 152 处全误报；结构判定后 21→13
question: 这条判据认识的是「这个名字」，还是「这种形状」？
---

# 靠「列名字」判行为，换一个项目就错一半

## 两次血案，同一条规则

**第一次（试点 A）**：AQ006 名单里只有 `auth / getServerSession / requireAuth / assertAdmin`。
试点 A的鉴权入口叫 `requirePermission(request, 'analytics.view')` —— 直接报 **152 处裸奔**，全误报。

**第二次（加宽名单之后）**：加进了 `requirePermission`，命中降到 21。
一看，主力守卫叫 `requireMerchant(...)`，还有一档写法是：

```ts
const { selfId } = await resolveSelfIdSet(req)
if (!selfId) return apiError('AUTH_REQUIRED', '未登录')
```

`requireMerchant` 不在名单里；`AUTH_REQUIRED` 也不在（`\bauth\b` 匹配不到
`AUTH_REQUIRED`，因为下划线是单词字符）。

## 为什么「再往名单里加一个」是错的解法

加 `requireMerchant` 之后，下一个项目会叫 `assertStaffAccess` / `ensureSession` /
`withTenantScope`。**名字是无穷的，形状是有限的。**

## 结构判定：动词 + 受保护对象

```
GUARD_VERB = require|assert|ensure|check|guard|with|verify
GUARD_NOUN = Auth|Admin|User|Member|Merchant|Role|Permission|Session|Scope|
             Access|Owner|Identity|Principal|Token|Signature|Login|Privilege|Actor|Tenant
两个条件同时成立 = 守卫调用
```

- `requireMerchant` / `assertAdminAccess` / `ensureSession` / `withMerchantScope` → 是
- `requireEnv` / `assertValid` / `ensureDir` / `checkFormat` → 不是（名词不在受保护对象里）

再加一条**行为证据**：文件里返回 `AUTH_REQUIRED / UNAUTHENTICATED / FORBIDDEN` 这类
错误码的，必然是鉴权感知的 —— 这比函数名更可靠，因为它是**实际行为**。

## 反证必须留

```
requireMerchant(...)              → 不该报（结构判据要认得出没见过的名字）
apiError('AUTH_REQUIRED', ...)    → 不该报（行为证据）
assertValid(body) 但无鉴权         → 必须报（证明结构判据没被 assert* 骗过）
```

第三条是关键：没有它，这条规则会退化成「只要调了 assert 就当有鉴权」——恒绿。

## 怎么问

- 这条判据认识的是名字还是形状？
- 我把被判定对象的注释里提到的名字全换掉，它还能认出来吗？
- 它的反例里，有没有一个「看起来像但不该算」的样本？
