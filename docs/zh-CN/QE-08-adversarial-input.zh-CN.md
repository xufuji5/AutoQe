# QE-08 · Adversarial and Malicious Input

> Chinese edition of [QE-08-adversarial-input.md](../../QE-08-adversarial-input.md).

> 覆盖：INV-WEB-02/04、INV-SEC-01/02、INV-FE-01
> 守卫：`inv20`（边界）、`inv21`（接缝）、`inv22`（前端落盘）
> 条目单源：[`qe/registry/registry.ts`](../../qe/registry/registry.ts)

## 1. 威胁模型（先写清，再谈质量）

| 攻击者 | 能力 | 主要目标 |
|---|---|---|
| 匿名公网 | 任意构造请求体/头/路径 | 越权读、刷接口、注入 |
| 已登录普通用户 | 改请求参数、重放、切租户 id | 横向越权、重复领券/下单 |
| 恶意前端环境 | 读 localStorage、篡改 store | 窃取 token、伪造状态 |
| 内部误用/AI 生成代码 | 直接调用内部函数、绕过入口 | 无鉴权路径、校验缺口 |

判据必须落在**不可绕过的层**（服务端入口、DB 约束），不能只落在 UI 或客户端 store。

## 2. 静默出错清单

| # | 会以什么形式静默 | 判据 |
|---|---|---|
| 1 | 鉴权只判断「已登录」，不判断「这条数据是不是你的」 | 对象级授权；`ENTRY_NO_AUTH` 只能兜住「完全没鉴权」 |
| 2 | UI 做了 zod 校验，服务端直接收 body | `ENTRY_NO_VALIDATE`（inv20） |
| 3 | 请求体无体积上限，10MB JSON 打满内存 | INV-SEC-02(open)：middleware/网关上限 |
| 4 | 登录/下单接口无限流，脚本可刷 | INV-SEC-02(open)：速率限制 |
| 5 | 幂等键缺失，重放请求重复扣减 | `MUTATION_NO_IDEMPOTENCY`（inv20 告警） |
| 6 | 错误响应回传堆栈/SQL/内部 id | 评审 + 统一错误映射 |
| 7 | token 被 Zustand persist 落盘，XSS 直接读走 | `PERSIST_SENSITIVE`（inv22 判红） |
| 8 | 客户端组件 import 了 `db.ts`，连接串/查询逻辑进 bundle | `CLIENT_TOUCHES_SERVER`（inv21 判红） |

## 3. 四道边界

### 3.1 入口：鉴权 + 校验 + 幂等

```ts
export async function POST(request: Request): Promise<Response> {
  const user = await requireUser()                       // 1. 身份
  const body = input.parse(await request.json())         // 2. 形状/范围
  assertOwner(user, body.tenantId)                       // 3. 对象级授权
  const key = request.headers.get('Idempotency-Key')     // 4. 重放
  if (!key) return badRequest('MISSING_KEY')
  return Response.json(await withIdempotency(key, () => handle(user, body)))
}
```

四步缺一，都会在某个真实场景下静默放行。`inv20` 能机器判 1/2/4，3 需要评审（因为「是不是你的」是业务语义）。

### 3.2 输入：白名单而不是黑名单

- schema 用 `.strict()`（或 zod 默认剥离），禁止 `passthrough()`。
- 数值给上下限（金额、分页大小、数组长度）。
- 字符串给长度上限；富文本单独做消毒，不混在普通字段。
- 枚举只接受白名单值，不透传任意字符串进 `where`。

### 3.3 资源：体积 / 频率 / 深度

- 请求体上限（Next.js route 层或网关）：建议 1MB 以内，文件上传走独立通道。
- 每用户/每 IP 限流：登录、下单、导出、搜索。
- 分页强制上限（如 `take <= 100`）；禁止把 `take` 直接透传给 Prisma。
- 递归/嵌套深度上限（尤其 GraphQL 或树形导入）。

以上属 INV-SEC-02(open)：需按仓登记「上限落在哪一层 + 读数命令」，登记后转 partial。

### 3.4 输出：不泄漏

- 统一错误码（见 `qe.contracts.json`），不返回堆栈、SQL、内部路径。
- DTO 白名单序列化，禁止 `JSON.stringify(entity)` 直出。
- 日志脱敏：token、手机号、身份证、卡号不打明文。

## 4. 客户端侧的对抗

- **不信任客户端状态**：Zustand 里的角色/权限字段只能用于 UI 展示，服务端每次重新判定。
- **不落盘敏感字段**：`partialize` 白名单，token 留在 httpOnly cookie（`inv22`）。
- **不把服务端对象塞进 store**：DB 模型变化会静默破坏 hydration；存最小视图状态。
- **CSRF/同源**：Cookie 鉴权时变更请求需 SameSite + token 校验；`inv20` 不覆盖，属评审项。

## 5. 机器判据与人工判据的分界

| 能机器判 | 只能人工/演练 |
|---|---|
| 有没有鉴权调用 | 鉴权是否覆盖所有分支、是否对象级 |
| 有没有 schema 校验 | 校验是否真的限制范围、是否 strict |
| 有没有幂等标记 | 去重是否落库、是否同事务 |
| 客户端是否直连服务端 | 越权路径是否可组合出来 |
| 敏感字段是否落盘 | XSS 后实际可取走什么 |
| 是否有公共路由登记 | 公共路由是否泄漏业务数据 |

**别把人工判据伪装成机器判据。** `inv20` 的 `green` 只代表「入口形状齐全」，不代表「不可越权」。

## 6. 施工完成判据

- `inv20` / `inv21` / `inv22` 全绿，且新增公共路由有非空理由。
- 新增变更接口：四道边界（身份/形状/归属/幂等）在 PR 描述逐条勾选。
- 新增限流/体积上限：在 `qe.config.json` 或仓级机制清单登记读数命令（INV-SEC-02）。
- 渗透/越权用例至少一条由**非实现者**构造（坏样本由对账方注入）。
