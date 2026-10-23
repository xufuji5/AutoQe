# Five Approval Questions · <table / migration name>

> **中文摘要**：动 schema 或迁移（不可逆）前必答五问：名单、写入者、守卫、级联、回滚；答不全不进实施队列。
> 下半节给出判据形态：删列读数、回填快照、物化列时效、外呼可撤销、迁移链零漂移。

> Must be answered before touching schema or migrations (irreversible). An incomplete form does not enter the implementation queue.

1. **Roster / 名单**: Are the new table/columns on the RLS and soft-delete roster? (An exemption is an adjudication, not a default.)
2. **Writers / 写入者**: Who is the writer for each column (function name)? Where are the read sites? If neither exists, why does the column exist?
3. **Guards / 守卫**: Which INV guards it? If none can, what are the `openReason` and the review trigger?
4. **Cascade / 级联**: Does the FK cascade delete or preserve? Who depends on that direction?
5. **Rollback / 回滚**: How do you withdraw it after release? What data is lost on rollback? What is the replay reading on a clean database?

## Criterion form / 判据形态

- A column-drop decision must attach the reading "this column is entirely empty **and** the table has rows"; a reading from an empty table is not proof.
- Backfills must land "snapshot column + capture timestamp"; never overwrite the original field and pass it off as historical fact.
- Materialized columns must state two timings: how long until an allow takes effect, and how long until a revoke takes effect (the latter is risk control, not performance).
- Outbound calls (SMS / push / payout): idempotency key + revocable window + visible failure (failures must land in the ledger).
- Migration chain: an applied `migration.sql` cannot change by a single byte; schema and applied migration objects must have zero drift.
