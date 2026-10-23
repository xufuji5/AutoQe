# QE-07 · Prisma + PostgreSQL Concurrency and Constraints

> Covers: INV-CORE-01/02/03, INV-CORE-12 (open), INV-DB-01/02 (open)
> Guards: `npm run qe:guard:inv01`, `inv02`, `inv03`; migrations and concurrency are part of the release gate
> Single source of entries: [`qe/registry/registry.ts`](qe/registry/registry.ts)
> If the host project already ships its own equivalent spec for coding discipline (the idempotency/atomicity triad, batch runs, survival rate), that spec takes precedence. The QE copy pack does not include it, so follow §3 here and do not depend on external documents.

## 1. The shape of a concurrency bug: not "computed wrong", but "both are right"

Single-request tests can never catch concurrency defects, because each request looks correct in isolation. Real defects come from two writers passing the check at the same time:

```
T1: read balance = 100
T2: read balance = 100
T1: write balance = 90   -- debit 10
T2: write balance = 90   -- also debits 10, but only one debit actually happened
```

**Conclusion: concurrency correctness cannot rely on "test coverage"; it can only rely on constraints (unique keys / transactions / locks / idempotency keys) and state machines.**

## 2. Silent-failure checklist

| # | How it fails silently | Invariant | Machine / human check |
|---|---|---|---|
| 1 | `findUnique` says the row is absent, then `create` runs; under concurrency both rows get inserted | INV-DB-02 | DB unique constraint + conflict classification; static scan currently open |
| 2 | Updates use `update({ data: { balance: newBalance } })`, losing concurrent updates | INV-DB-01 | Optimistic locking with `version` or atomic `decrement`; human review |
| 3 | Status goes from `PENDING` straight to `PAID`, and both callbacks execute | INV-CORE-04/12 | Conditional update `updateMany({ where: { status: 'PENDING' } })` plus affected-row count |
| 4 | An enum value is added to the schema but has no path that produces it | INV-CORE-03 | `DEAD_ENUM` (inv03) |
| 5 | A column exists but nobody writes it; reads always get null or the default | INV-CORE-01 | `ZERO_WRITER` (inv01) |
| 6 | After a soft delete, reads by id, counts, and exports still include deleted rows | INV-CORE-05 (open) | Full sweep of read sites; adopt a shared `notDeleted` scope |
| 7 | A column was patched manually in the dev database, and replaying migrations on a fresh CI database fails | INV-CORE-09 (open) | Clean-copy database replay gate |

## 3. Constraints first: let the database stop it, then let the code stop it

### 3.1 Uniqueness

```prisma
model Order {
  id          String   @id @default(cuid())
  tenantId    String
  orderNo     String
  status      OrderStatus @default(PENDING)
  totalCents  Int
  version     Int      @default(0)
  deletedAt   DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([tenantId, orderNo])   // business uniqueness must live in the DB
  @@index([tenantId, status, createdAt])
  @@map("orders")
}
```

Criterion: **any business uniqueness enforced by "check then insert" must also exist as `@@unique` in the database.** Code is only responsible for translating unique conflicts into business error codes; it is not responsible for "guaranteeing no duplicates".

### 3.2 Conditional update (state machine)

```ts
const updated = await prisma.order.updateMany({
  where: { id, status: 'PENDING' },
  data: { status: 'PAID', paidAt: new Date() },
})
if (updated.count === 0) throw new ConflictError('ORDER_STATE_CONFLICT')
```

Criterion: a state transition must carry a "precondition state" predicate and must check `count`. A bare `update({ where: { id } })` is treated as a lost-update risk.

### 3.3 Transactions and isolation

```ts
await prisma.$transaction(async (tx) => {
  const rows = await tx.order.updateMany({
    where: { id, status: 'PENDING', version },
    data: { status: 'PAID', version: { increment: 1 } },
  })
  if (rows.count === 0) throw new ConflictError('ORDER_VERSION_CONFLICT')
  await tx.ledger.create({ data: { orderId: id, amountCents, direction: 'IN' } })
})
```

- Read–judge–write for money and inventory must share one transaction.
- Hot rows use optimistic locking (`version`) or `SELECT … FOR UPDATE` (in Prisma this requires `$queryRaw`).
- Deadlocks and serialization failures must be **classified and retried** (bounded attempts + backoff); never swallow them as success.

### 3.4 Idempotency

- Mutation entry points carry an `Idempotency-Key` (inv20 warning).
- The server writes `key + request digest` into a deduplication table; a unique-key conflict means "already processed", and the first result is returned.
- Idempotency records share the transaction with the business write; otherwise you leave a hole where "the key was written but the business was not".

## 4. Schema-authoring criteria (check each one when AI generates a schema)

| Criterion | Why | Guard |
|---|---|---|
| Every scalar column has a writer; otherwise drop the column | A live table with dead columns gets read as defaults | inv01 |
| Every column has a reader, or is declared as archived with `/// @archive` in the schema | Columns nobody reads are historical baggage | inv02 |
| Every enum value has a path that produces it | Dead enum values create unreachable state-machine branches | inv03 |
| Money uses integer cents (`Int`/`BigInt`), never `Float` | Floating-point errors accumulate silently | Review |
| Time columns are always `DateTime`; string timestamps are forbidden | Timezone and sorting errors | Review |
| Multi-tenant tables carry `tenantId` and include it in unique keys / indexes | Cross-tenant access | INV-CORE-08 (open) |
| Soft-delete tables use `deletedAt` + read-side filtering | Deleted data comes back to life | INV-CORE-05 (open) |
| High-frequency queries have matching composite indexes | Slow queries exhaust the connection pool | QE-05-invariant-spec.md + review |

## 5. Migrations and connection pooling

- **Migration chain**: CI replays the full chain with `prisma migrate deploy` against a clean database; manually patching columns in the dev database is forbidden. This is part of the release gate (INV-CORE-09).
- **Connection pool**: under serverless or multi-instance Next.js, route through PgBouncer or cap connections with `connection_limit`; keep a single `PrismaClient` instance on the global object so hot reloads do not create duplicates (dev leaks).
- **Long transactions**: no external HTTP calls inside a transaction; holding a connection amplifies lock waits.
- **Indexes**: check the execution plan before adding a `where`/`orderBy` combination; put `EXPLAIN` readings in the PR description.

## 6. Collaboration boundary with AI

AI may write: queries, DTOs, error mapping, and business steps inside a transaction.
AI must not decide alone: unique keys, state-machine transition tables, isolation levels, retry policies, indexes. These are **boundaries** and must come from a human or be derived from the registry. When a boundary is missing, define the boundary first; do not write business logic.

## 7. Definition of done

- `GUARD_SUMMARY id=inv01-column-writer status=green`
- `GUARD_SUMMARY id=inv02-column-reader status=green`
- `GUARD_SUMMARY id=inv03-dead-enum status=green`
- For a mutated write path: the PR description states which of "constraint / transaction / idempotency / conflict classification" apply.
- For a migration change: clean-database replay passes (recorded by the release gate).

---

**中文摘要**：并发正确性靠约束：唯一约束、条件更新、事务、幂等键与迁移零漂移。
