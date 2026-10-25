# QE-06 · Next.js Server Boundaries and Module Seams

> Covers: INV-WEB-01/02/03/04, INV-SEC-01, INV-SEAM-01, INV-SEC-02 (open)
> Guards: `npm run qe:guard:inv20` (boundary), `npm run qe:guard:inv21` (seam)
> Single source of entries: [`qe/registry/registry.ts`](qe/registry/registry.ts)

## 1. Why AI modular development always breaks at the seams

When AI generates code module by module in parallel, each module is usually internally consistent, but nobody owns the three cross-module assumptions:

1. **The caller assumes the callee already authenticated; the callee assumes the caller already authenticated** → anonymous requests get through.
2. **The caller assumes the input was already validated; the callee feeds `request.json()` straight into business logic** → malicious payloads pass through.
3. **One module imports another module's internal file directly**; when the other module refactors its file layout, the link breaks silently.
4. **A client component imports a server implementation directly** (Prisma, Node built-ins): the build passes, but it crashes or leaks at runtime.

None of these is "is this test case correct"; each is "does the seam hold unconditionally". The checks therefore belong at the entry and import layers, not inside business functions.

## 2. Silent-failure checklist (confirm each item before starting)

| # | How it fails silently | Machine check |
|---|---|---|
| 1 | A new `POST` route ships without auth, and the test suite runs green because it uses a logged-in session | `ENTRY_NO_AUTH` (inv20) |
| 2 | The frontend does zod validation, the server only calls `request.json()`, and the API can be hit directly, bypassing the UI | `ENTRY_NO_VALIDATE` (inv20) |
| 3 | Double submits or replays create duplicate orders or duplicate debits, while logs look perfectly normal | `MUTATION_NO_IDEMPOTENCY` (inv20, warning) |
| 4 | A "health check" public route is added, then quietly becomes a data exit point | `PUBLIC_NO_REASON` / `PUBLIC_ROUTE_STALE` (inv20) |
| 5 | A `'use client'` file imports `@prisma/client` or `db.ts` | `CLIENT_IMPORTS_SERVER` / `CLIENT_TOUCHES_SERVER` (inv21) |
| 6 | Module A deep-imports module B's internals via `../b/service.ts`; after B refactors, A silently keeps running old logic | `CROSS_MODULE_RELATIVE` (inv21, warning) |

## 3. Standard server entry skeleton

### 3.1 Route Handler (mutating)

```ts
// app/api/records/route.ts
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

Key points:

- The `user` returned by authentication must participate in subsequent data access (object-level authorization); checking "logged in or not" is not enough.
- Validation happens **before entering business logic**, and uses an allowlist schema (no `passthrough()`).
- The idempotency key and the business write must land in the same transaction or the same deduplication table; otherwise the check "passes" without taking effect.
- Response bodies must not echo internal error stacks or every field of an entity.

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

A Server Action is an external entry point too: both authentication and validation are mandatory. `inv20` treats every named export of a `'use server'` file as an entry point.

### 3.3 Public route registration

```jsonc
// qe.config.json
"boundaries": {
  "publicRoutes": [
    { "file": "app/api/health/route.ts", "reason": "Returns a static liveness marker only; no business data, no writes" }
  ]
}
```

An empty reason means unregistered (`PUBLIC_NO_REASON`). A registration whose entry point has been deleted is stale (`PUBLIC_ROUTE_STALE`).

## 4. Module seam protocol (required reading for AI modular work)

1. **A module exposes exactly one public entry point**: `src/features/<module>/index.ts` (or dual entries `server.ts` / `client.ts`).
2. **Cross-module imports may only use**: `@/features/<module>` (public entry point), `@/shared/*`, or package names. `../<other-module>/internal/*` is forbidden.
3. **Client components must not import server implementations**:
   - Forbidden: `@prisma/client`, `server-only`, `next/headers`, `node:*`, `fs`, `path`, `crypto`.
   - Reaching a file that calls `new PrismaClient()` through a relative path also fails (`CLIENT_TOUCHES_SERVER`).
   - `import type` is allowed (types are erased before runtime).
4. **Transform data shapes at the boundary**: DB models never go into client props; use DTOs or serializer functions so `Date`/`Decimal` are not passed directly to client components.
5. **Mark server-only files with `import 'server-only'`**: an extra build-time safety net, and a clear anchor for the seam guard.

## 5. Scope and blind spots of each check (must be self-reported)

| Check | Scope | Blind spot |
|---|---|---|
| `ENTRY_NO_AUTH` | Method exports of `app/**/route.ts`, named exports of `'use server'` | `export default`, `pages/api`, middleware; auth is called but covers only one branch |
| `ENTRY_NO_VALIDATE` | Vocabulary scan of mutating methods / Server Action bodies | Validation misses some fields, `passthrough`, or data is still forwarded after validation |
| `MUTATION_NO_IDEMPOTENCY` | A literal idempotency marker | Whether the dedup table / unique key actually exists |
| `CLIENT_IMPORTS_SERVER` | Direct imports in client files (including `export … from`) | Aliases (`@/`), barrels, dynamic `import()` |
| `CROSS_MODULE_RELATIVE` | Relative cross-module imports under `stores.moduleRoots` | Alias paths, monorepo package boundaries |

Blind spots are not a disclaimer; they are the backlog for the next guard iteration. When capabilities grow, widen the scope first, then update the docs.

## 6. Bad samples (red first, then green)

- `qe/fixtures/inv20-server-boundary/bad`: POST without auth / validation / idempotency + public route with an empty reason → 3 errors.
- `qe/fixtures/inv21-seam-import/bad`: `'use client'` importing Prisma and `db.ts` directly + a deep relative cross-module import → 2 errors / 1 warn.

Before changing a guard, run: `npm run qe:selftest -- --only inv20` (or `node qe/cli.ts selftest --only inv20`).

## 7. Definition of done

- `GUARD_SUMMARY id=inv20-server-boundary status=green`
- `GUARD_SUMMARY id=inv21-seam-import status=green`
- `RATCHET status=ok regressions=0`
- For a new public route: `publicRoutes` has a non-empty reason, and `ENTRY_NO_AUTH` is not triggered.

---

**中文摘要**：Next.js 入口鉴权/校验/幂等、客户端越界与跨模块深导的判据。
