---
id: SK006
title: 路由导出但无鉴权
status: rule
rules: [AQ006]
defectClass: 鉴权缺失 / 后台裸奔
provenance: 试点 A api-ownership 登记表（每条都是「新加的 route 忘了走 admin 校验」）+ 试点 B 权限矩阵回填
question: 这个新加的接口，谁能调？答案写在哪一行代码里？
---

# 路由导出但无鉴权
## 为什么单列这一条

它是唯一一种**测试全绿、类型全对、功能正常**的致命缺陷。
handler 是纯函数，谁都能调；没有任何静态检查会因为它报错。
一旦发生，就是整个后台对外裸奔。

## 怎么判

文件是 `route.ts` / `pages/api/*`，导出了 HTTP 方法，
但全文没有：`auth()` / `getServerSession` / `currentUser` / `requireUser` /
`requireAuth` / `assertAdmin` / `checkPermission` / `withAuth` / `verifySignature`…

## 误报边界（决定这条规则活不活）

三类合法公开端点必须**显式声明**，不能靠「看起来像」：
1. 健康检查/探活（`/health`、`/ping`）
2. 协议回调（webhook、支付回调、OAuth 回调）—— 靠签名而非 session
3. 登录/注册/验证码入口本身

写进 `publicPaths`。**宁可让人多写一行声明，也不要让规则自己猜** ——
猜错的代价是漏掉一个真裸奔的接口。

## 修复形态

统一 `withAuth(handler, { role: 'admin' })` 包装，让「有没有鉴权」在函数签名上就可见。
