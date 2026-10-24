---
id: SK001
title: 请求体解析未兜底
status: rule
rules: [AQ001]
defectClass: 请求体解析 / 错误封面缺失
provenance: 试点 A 2026-10 全仓盘点（25 处裸解析，11 处完全无兜底）
question: 每个读取请求体的入口，畸形 JSON 时返回的是 400 还是 500？
---

# 请求体解析未兜底
## 长什么样

```ts
export async function POST(request: Request) {
  const body = await request.json()   // ← 客户端发坏数据时这里抛 SyntaxError
  return Response.json({ ok: body.id })
}
```

## 为什么贵

它不报错、不告警，只是**偶发 500**。日志里只有 `Unexpected token`，
归因不到接口（500 是框架给的封面，不是业务的）。用户看到的是白屏或「系统错误」。

## 怎么判

看 `request.json()` / `req.json()` / `request.text()` 的调用点：
- 在 `try{}catch` 体内 → 有兜底
- 紧跟 `.catch()` → 有兜底
- 在 helper（`parseJsonObject`）里 → 有兜底（调用点根本不会出现裸调用）

## 误报边界

协议自有端点（JSON-RPC、签名 webhook）**必须**返回协议规定的错误体，
不能换成项目统一信封。这类按文件声明 `protocolOwned`，且**双向校验**：
声明了但代码已不是该形态 → 报 `exempt-drift`，逼人删声明。

## 修复形态

统一走 helper，返回 `{ ok, value }` 或抛业务错误码：

```ts
const parsed = await parseJsonObject(request)
if (!parsed.ok) return apiError('BAD_REQUEST', 400)
```
