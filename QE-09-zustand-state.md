# QE-09 · Zustand Client State

> Covers: INV-FE-01, INV-FE-02
> Guard: `npm run qe:guard:inv22`
> Single source for entries: [`qe/registry/registry.ts`](qe/registry/registry.ts)

## 1. Three classes of silent Zustand bugs

1. **Persistence leak**: `persist` writes the token/password into localStorage; one script after an XSS reads it, and the logs show nothing.
2. **Structural drift**: after a field rename, the old localStorage data remains; after hydration the field is `undefined` and the UI renders blank without throwing.
3. **Misplaced responsibility**: server data (business lists, user profiles) is copied into Zustand; cache and database evolve independently, producing "correct only after a refresh".

The criteria map respectively to: a `partialize` allowlist (INV-FE-01), `partialize` present + `version` (INV-FE-02), and a store that holds view state only (review).

## 2. Silent-failure checklist

| # | How it fails silently | Criterion |
|---|---|---|
| 1 | `persist` without `partialize`; the entire state is persisted | `PERSIST_WITHOUT_PARTIALIZE` (inv22 warning) |
| 2 | `partialize` keeps `token`/`password`/`apiKey` | `PERSIST_SENSITIVE` (inv22 error) |
| 3 | `partialize: (s) => s` or `({ ...state })` — equivalent to no trimming at all | `PERSIST_FULL_STATE` (inv22 warning) |
| 4 | No `version`; old data maps to the wrong shape after a structural change | `PERSIST_NO_VERSION` (inv22 warning) |
| 5 | Prisma entities / `Date` / `Decimal` placed directly into the store | Serialization loss; review |
| 6 | Server lists copied into the store and refreshed in several places | Cache drift; review (TanStack Query recommended) |

## 3. Canonical form

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
      partialize: (s) => ({ keyword: s.keyword }), // INV-FE-01: allowlist
      migrate: (persisted, oldVersion) => {         // fallback for the old shape
        if (oldVersion < 1) return { keyword: '' }
        return persisted as RequestFilterState
      },
    },
  ),
)
```

Key points:

- `partialize` uses an **explicit allowlist**; do not use a denylist such as `{ ...state, token: undefined }`.
- `version` and `migrate` come as a pair; adding `version` without `migrate` means treating old data as if it had the new shape.
- Auth credentials belong in httpOnly cookies; the store keeps at most non-sensitive identifiers such as `userId` (for UI display).
- Server data belongs in a request cache (TanStack Query/SWR); Zustand holds only "pure UI state shared across pages".

## 4. Scope and blind spots of each criterion

| Criterion | Scope | Blind spot |
|---|---|---|
| `PERSIST_SENSITIVE` | Top-level `persist()` calls in a file; sensitive keys matched in the `partialize` initializer text | Values inside nested objects, concatenated variables, hand-written `localStorage.setItem` |
| `PERSIST_WITHOUT_PARTIALIZE` | Literal configuration objects | Factory functions, dynamic spreads, configuration defined in another module |
| `PERSIST_NO_VERSION` | Whether the arguments carry a `version` property | Checks presence only; does not verify that `migrate` is correct |
| `PERSIST_FULL_STATE` | `=> state` / `...state` | Equivalent forms (e.g. `Object.assign({}, state)`) may slip through |

If a new pattern falls into a blind spot, extend the guard first and write the feature afterwards; never treat "the guard reported nothing" as proof of safety.

## 5. Bad samples

- `qe/fixtures/inv22-zustand-store/bad/src/stores/auth-store.ts`: `partialize` persists `token` → 1 error.
- `qe/fixtures/inv22-zustand-store/bad/src/stores/filter-store.ts`: no `partialize`, no `version` → 2 warnings.

Red first, green after: any change to the guard must first make these two samples fail.

## 6. Definition of done

- `GUARD_SUMMARY id=inv22-zustand-store status=green`
- Every `persist` has: `name`, `version`, `migrate` (on structural change), and a `partialize` allowlist.
- New sensitive fields: register them in `stores.sensitiveKeys` in `qe.config.json` (the wordlist is a project-level asset).
- No server data copied into the store (the PR description states the data source and the refresh strategy).

---

**中文摘要**：Zustand persist 的落盘边界、version/migrate 与状态职责。
