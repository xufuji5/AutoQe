# QE-09 · Zustand Client State

> Chinese edition of [QE-09-zustand-state.md](../../QE-09-zustand-state.md).

> 覆盖：INV-FE-01、INV-FE-02
> 守卫：`npm run qe:guard:inv22`
> 条目单源：[`qe/registry/registry.ts`](../../qe/registry/registry.ts)

## 1. Zustand 的三类静默 bug

1. **落盘泄漏**：`persist` 把 token/密码写进 localStorage，XSS 后一条脚本读走，日志无异常。
2. **结构漂移**：字段改名后旧 localStorage 数据仍在，hydration 后字段是 `undefined`，界面显示空白但不报错。
3. **职责错位**：把服务端数据（业务列表、用户资料）复制进 Zustand，缓存与 DB 各自演化，出现「刷新才对」。

判据分别对应：`partialize` 白名单（INV-FE-01）、`partialize` 存在 + `version`（INV-FE-02）、store 只存视图状态（评审）。

## 2. 静默出错清单

| # | 会以什么形式静默 | 判据 |
|---|---|---|
| 1 | `persist` 未写 `partialize`，整个 state 落盘 | `PERSIST_WITHOUT_PARTIALIZE`（inv22 告警） |
| 2 | `partialize` 里保留 `token`/`password`/`apiKey` | `PERSIST_SENSITIVE`（inv22 判红） |
| 3 | `partialize: (s) => s` 或 `({ ...state })`，等同未裁剪 | `PERSIST_FULL_STATE`（inv22 告警） |
| 4 | 无 `version`，结构变化后旧数据错位 | `PERSIST_NO_VERSION`（inv22 告警） |
| 5 | 把 Prisma 实体/Date/Decimal 直接放进 store | 序列化失真；评审 |
| 6 | 把服务端列表复制进 store，多处各自刷新 | 缓存漂移；评审（建议 TanStack Query） |

## 3. 标准写法

```ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface RequestFilterState {
  keyword: string
  setKeyword: (v: string) => void
}

export const useRequestFilterStore = create<RequestFilterState>()(
  persist(
    (set) => ({
      keyword: '',
      setKeyword: (keyword) => set({ keyword }),
    }),
    {
      name: 'request-filters',
      version: 1,                                   // INV-FE-02
      partialize: (s) => ({ keyword: s.keyword }), // INV-FE-01：白名单
      migrate: (persisted, oldVersion) => {         // 旧结构兜底
        if (oldVersion < 1) return { keyword: '' }
        return persisted as RequestFilterState
      },
    },
  ),
)
```

要点：

- `partialize` 用**显式白名单**，不要 `{ ...state, token: undefined }` 这类黑名单。
- `version` 与 `migrate` 成对出现；只加 `version` 不写 `migrate` 等于把旧数据当新结构用。
- 鉴权令牌走 httpOnly cookie；store 里最多存 `userId` 这类非敏感标识（用于 UI 展示）。
- 服务端数据用请求库缓存（TanStack Query/SWR）；Zustand 只存「跨页面共享的纯 UI 状态」。

## 4. 判据的射程与盲区

| 判据 | 射程 | 盲区 |
|---|---|---|
| `PERSIST_SENSITIVE` | 文件顶层 `persist()` 调用、`partialize` 初识器文本命中敏感键 | 嵌套对象里的值、变量拼接、`localStorage.setItem` 手写 |
| `PERSIST_WITHOUT_PARTIALIZE` | 字面量配置对象 | 工厂函数、动态展开、配置在别的模块 |
| `PERSIST_NO_VERSION` | 实参里是否有 `version` 属性 | 只检查存在性，不校验 `migrate` 正确性 |
| `PERSIST_FULL_STATE` | `=> state` / `...state` | 等价写法（如 `Object.assign({}, state)`）可能漏判 |

新增写法若落在盲区，先在守卫里补判据，再写业务；不要用「守卫没报」当作安全证明。

## 5. 坏样本

- `qe/fixtures/inv22-zustand-store/bad/src/stores/auth-store.ts`：`partialize` 落盘 `token` → 1 error。
- `qe/fixtures/inv22-zustand-store/bad/src/stores/filter-store.ts`：无 `partialize`、无 `version` → 2 warnings。

先红后绿：改守卫必须先让这两个样本见红。

## 6. 施工完成判据

- `GUARD_SUMMARY id=inv22-zustand-store status=green`
- 每个 `persist` 都有：`name`、`version`、`migrate`（结构变更时）、`partialize` 白名单。
- 新增敏感字段：在 `qe.config.json` 的 `stores.sensitiveKeys` 登记（词表是仓级资产）。
- 服务端数据未复制进 store（PR 描述说明数据来源与刷新策略）。
