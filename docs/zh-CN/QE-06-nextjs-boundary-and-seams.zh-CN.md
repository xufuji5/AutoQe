# QE-06 · Next.js Server Boundaries and Module Seams

> Chinese edition of [QE-06-nextjs-boundary-and-seams.md](../../QE-06-nextjs-boundary-and-seams.md).

> 覆盖：INV-WEB-01/02/03/04、INV-SEC-01、INV-SEAM-01、INV-SEC-02(open)
> 守卫：`npm run qe:guard:inv20`（边界）、`npm run qe:guard:inv21`（接缝）
> 条目单源：[`qe/registry/registry.ts`](../../qe/registry/registry.ts)

## 1. 为什么 AI 分模块开发一定在「缝」上出错

AI 按模块并行生成代码时，每个模块内部往往自洽，但跨模块的三个假设没人负责：

1. **调用方假设被调方已经鉴权**，被调方假设调用方已经鉴权 → 匿名可打。
2. **调用方假设入参已被校验**，被调方直接 `request.json()` 进业务 → 恶意体穿透。
3. **一个模块直接引用另一个模块的内部文件**，对方重构文件路径时静默断链。
4. **客户端组件直接 import 服务端实现**（Prisma、node 内建），构建能过、运行时炸或泄漏。

这四类都不是「某条用例对不对」，而是「接缝是否恒成立」。所以判据放在入口与导入层，不放在业务函数里。

## 2. 静默出错清单（开工前逐条确认）

| # | 会以什么形式静默 | 机器判据 |
|---|---|---|
| 1 | 新加一个 `POST` route，忘了鉴权，测试用登录态跑全绿 | `ENTRY_NO_AUTH`（inv20） |
| 2 | 前端做了 zod 校验，服务端只 `request.json()`，绕过 UI 直接打接口 | `ENTRY_NO_VALIDATE`（inv20） |
| 3 | 双提交/重放导致重复下单、重复扣减，日志看起来一切正常 | `MUTATION_NO_IDEMPOTENCY`（inv20，告警） |
| 4 | 为了「健康检查」加了公共路由，后来变成数据出口 | `PUBLIC_NO_REASON` / `PUBLIC_ROUTE_STALE`（inv20） |
| 5 | `'use client'` 文件 import 了 `@prisma/client` 或 `db.ts` | `CLIENT_IMPORTS_SERVER` / `CLIENT_TOUCHES_SERVER`（inv21） |
| 6 | 模块 A 用 `../b/service.ts` 深导模块 B 内部，B 重构后 A 静默拿到旧逻辑 | `CROSS_MODULE_RELATIVE`（inv21，告警） |

## 3. 服务端入口标准骨架

### 3.1 Route Handler（变更型）

```ts
// app/api/orders/route.ts
import { z } from 'zod'
import { requireUser } from '@/server/auth'
import { withIdempotency } from '@/server/idempotency'

const input = z.object({
  totalCents: z.number().int().positive().max(10_000_000),
})

export async function POST(request: Request): Promise<Response> {
  const user = await requireUser()                    // INV-WEB-01
  const body = input.parse(await request.json())      // INV-WEB-02
  const key = request.headers.get('Idempotency-Key')  // INV-WEB-03
  if (!key) return Response.json({ error: 'MISSING_KEY' }, { status: 400 })
  const result = await withIdempotency(key, () => createOrder(user.id, body))
  return Response.json(result)
}
```

要点：

- 鉴权返回的 `user` 必须参与后续数据访问（对象级授权），不能只判断「有没有登录」。
- 校验在**进入业务之前**，且使用白名单 schema（禁止 `passthrough()`）。
- 幂等键与业务写入在同一事务或同一去重表内落库，否则「检查了但没生效」。
- 返回体不回传内部错误栈与实体全字段。

### 3.2 Server Action

```ts
'use server'
import { z } from 'zod'
import { requireUser } from '@/server/auth'

const input = z.object({ totalCents: z.number().int().positive() })

export async function createOrder(formData: FormData): Promise<void> {
  const user = await requireUser()
  const body = input.parse({ totalCents: Number(formData.get('totalCents')) })
  await createOrderFor(user.id, body)
}
```

Server Action 同样是对外入口：鉴权、校验缺一不可。`inv20` 把 `'use server'` 文件的每个具名导出视为入口。

### 3.3 公共路由登记

```jsonc
// qe.config.json
"boundaries": {
  "publicRoutes": [
    { "file": "app/api/health/route.ts", "reason": "只返回静态存活标记，无业务数据，无写操作" }
  ]
}
```

理由为空 = 未登记（`PUBLIC_NO_REASON`）。登记了但入口已删 = 登记过期（`PUBLIC_ROUTE_STALE`）。

## 4. 模块接缝协议（AI 分模块必读）

1. **一个模块只暴露一个公开入口**：`src/features/<module>/index.ts`（或 `server.ts` / `client.ts` 双入口）。
2. **跨模块只允许**：`@/features/<module>`（公开入口）、`@/shared/*`、包名。禁止 `../<other-module>/internal/*`。
3. **客户端组件不得 import 服务端实现**：
   - 禁止 `@prisma/client`、`server-only`、`next/headers`、`node:*`、`fs`、`path`、`crypto`。
   - 经相对路径间接触达 `new PrismaClient()` 的文件同样判红（`CLIENT_TOUCHES_SERVER`）。
   - `import type` 放行（类型擦除后不进运行时）。
4. **数据形状在边界处转换**：DB 模型不进客户端 props；用 DTO/序列化函数，避免把 Date/Decimal 直接传给 client component。
5. **服务端专属文件加 `import 'server-only'`**：多一层构建期保险，也让接缝守卫有明确锚点。

## 5. 判据的射程与盲区（必须自报）

| 判据 | 射程 | 盲区 |
|---|---|---|
| `ENTRY_NO_AUTH` | `app/**/route.ts` 的方法导出、`'use server'` 的具名导出 | `export default`、`pages/api`、middleware；有鉴权调用但只覆盖一条分支 |
| `ENTRY_NO_VALIDATE` | 变更方法/Server Action 的函数体词表 | 校验未覆盖全部字段、`passthrough`、校验后仍透传 |
| `MUTATION_NO_IDEMPOTENCY` | 字面幂等标记 | 去重表/唯一键是否真的存在 |
| `CLIENT_IMPORTS_SERVER` | 客户端文件的直接 import（含 `export … from`） | 别名（`@/`）、barrel、动态 `import()` |
| `CROSS_MODULE_RELATIVE` | `stores.moduleRoots` 下的相对跨模块导入 | 别名路径、monorepo 包边界 |

盲区不是免责声明，是下一轮守卫的待办。新增能力时先扩射程，再改文档。

## 6. 坏样本（先红后绿）

- `qe/fixtures/inv20-server-boundary/bad`：POST 无鉴权/无校验/无幂等 + 公共路由空理由 → 3 errors。
- `qe/fixtures/inv21-seam-import/bad`：`'use client'` 直连 Prisma 与 `db.ts` + 跨模块相对深导 → 2 errors / 1 warn。

改守卫前先跑：`npm run qe:selftest -- --only inv20`（或直接 `node qe/cli.ts selftest --only inv20`）。

## 7. 施工完成判据

- `GUARD_SUMMARY id=inv20-server-boundary status=green`
- `GUARD_SUMMARY id=inv21-seam-import status=green`
- `RATCHET status=ok regressions=0`
- 新增公共路由：`publicRoutes` 有非空理由，且 `ENTRY_NO_AUTH` 未被触发。
