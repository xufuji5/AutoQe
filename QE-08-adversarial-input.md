# QE-08 · Adversarial and Malicious Input

> Covers: INV-WEB-02/04, INV-SEC-01/02, INV-FE-01
> Guards: `inv20` (boundary), `inv21` (seam), `inv22` (client persistence)
> Single source for entries: [`qe/registry/registry.ts`](qe/registry/registry.ts)

## 1. Threat model (write it down before discussing quality)

| Attacker | Capability | Primary goal |
|---|---|---|
| Anonymous internet | Craft arbitrary bodies, headers, and paths | Unauthorized reads, endpoint flooding, injection |
| Authenticated ordinary user | Tamper with parameters, replay requests, swap tenant IDs | Horizontal privilege escalation, duplicate submissions |
| Hostile client environment | Read localStorage, tamper with stores | Steal tokens, forge state |
| Internal misuse / AI-generated code | Call internal functions directly, bypass the entry point | Unauthenticated paths, validation gaps |

Criteria must live in a **layer that cannot be bypassed** (server entry point, database constraints) — never only in the UI or the client store.

## 2. Silent-failure checklist

| # | How it fails silently | Criterion |
|---|---|---|
| 1 | Auth checks only "is logged in", never "is this record yours" | Object-level authorization; `ENTRY_NO_AUTH` catches only "no auth at all" |
| 2 | The UI runs zod validation, the server takes the body as-is | `ENTRY_NO_VALIDATE` (inv20) |
| 3 | No request-body size limit; a 10 MB JSON body exhausts memory | INV-SEC-02(open): middleware/gateway limit |
| 4 | No rate limiting on login/submit; scripts can hammer them | INV-SEC-02(open): rate limiting |
| 5 | Missing idempotency key; replayed requests double-decrement | `MUTATION_NO_IDEMPOTENCY` (inv20 warning) |
| 6 | Error responses return stack traces/SQL/internal IDs | Review + unified error mapping |
| 7 | Token persisted by Zustand persist; one XSS script reads it | `PERSIST_SENSITIVE` (inv22 error) |
| 8 | Client component imports `db.ts`; connection string and query logic land in the bundle | `CLIENT_TOUCHES_SERVER` (inv21 error) |

## 3. The four boundaries

### 3.1 Entry: authentication + validation + idempotency

```ts
export async function POST(request: Request): Promise<Response> {
  const user = await requireUser()                       // 1. identity
  const body = input.parse(await request.json())         // 2. shape/range
  assertOwner(user, body.tenantId)                       // 3. object-level authorization
  const key = request.headers.get('Idempotency-Key')     // 4. replay
  if (!key) return badRequest('MISSING_KEY')
  return Response.json(await withIdempotency(key, () => handle(user, body)))
}
```

Skip any one of the four steps and some real-world scenario will slip through silently. `inv20` machine-checks 1, 2, and 4; 3 needs review, because "is this yours" is business semantics.

### 3.2 Input: allowlist, not denylist

- Schemas use `.strict()` (or zod's default stripping); never `passthrough()`.
- Put bounds on numeric values (amounts, page size, array length).
- Cap string length; sanitize rich text in a separate path instead of mixing it into ordinary fields.
- Enums accept allowlisted values only; never pass arbitrary strings into `where`.

### 3.3 Resources: size / rate / depth

- Request-body limit (Next.js route layer or gateway): keep it at or below 1 MB; file uploads go through a separate channel.
- Rate limiting per user / per IP: login, submit, export, search.
- Hard cap on pagination (e.g. `take <= 100`); never pass `take` straight through to Prisma.
- Cap on recursion/nesting depth (especially GraphQL or tree-shaped imports).

The above falls under INV-SEC-02(open): the host project must register "which layer enforces the cap + the command that reads it". Once registered, the invariant moves to `partial`.

### 3.4 Output: leak nothing

- Unified error codes (see `qe.contracts.json`); never return stack traces, SQL, or internal paths.
- Serialize through DTO allowlists; never `JSON.stringify(entity)` straight out.
- Log redaction: tokens, phone numbers, national IDs, and card numbers never appear in plaintext.

## 4. Client-side adversarial concerns

- **Never trust client state**: role/permission fields in Zustand are for UI display only; the server re-decides on every request.
- **Never persist sensitive fields**: use a `partialize` allowlist and keep tokens in httpOnly cookies (`inv22`).
- **Never put server objects into the store**: DB model changes silently break hydration; store the minimal view state.
- **CSRF / same-origin**: with cookie-based auth, mutating requests need SameSite plus token validation; `inv20` does not cover this — it is a review item.

## 5. Where machine criteria end and human criteria begin

| Machine-checkable | Review / exercise only |
|---|---|
| Whether an auth call exists | Whether auth covers every branch, and whether it is object-level |
| Whether schema validation exists | Whether validation really constrains the range, and whether it is strict |
| Whether an idempotency marker exists | Whether deduplication hits the database, and whether it is in the same transaction |
| Whether the client talks to the server directly | Whether privilege-escalation paths can be composed |
| Whether sensitive fields are persisted | What can actually be exfiltrated after an XSS |
| Whether public routes are registered | Whether public routes leak business data |

**Do not dress human judgment up as a machine criterion.** A `green` from `inv20` means only "the entry's shape is complete"; it does not mean privilege escalation is impossible.

## 6. Definition of done

- `inv20` / `inv21` / `inv22` all green, and every new public route has a non-empty reason.
- New mutating endpoints: the four boundaries (identity / shape / ownership / idempotency) are ticked off item by item in the PR description.
- New rate limits or size caps: register the read command in `qe.config.json` or the project-level mechanism list (INV-SEC-02).
- At least one penetration/privilege-escalation case is constructed by someone **other than the implementer** (bad samples are injected by the counterparty).

---

**中文摘要**：对抗输入的四道边界（入口/输入/资源/输出）与静默出错路径。
