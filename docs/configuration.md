# Configuration and customization

AutoQe reads one file: `qe.config.json` at the project root. Everything else — guards, invariants,
report format — ships inside the package and should be customized only through this file plus, when you
really need it, your own guards in `qe/guards/`.

Run `npx autoqe doctor` after every edit. It prints `OK / WARN / FAIL / SKIP` per block and ends with the
next command to run.

中文摘要：`qe.config.json` 是唯一配置入口；本文列出每个字段的默认值、含义、何时修改，以及常见定制配方（扫描范围、敏感字段、公共路由、字段豁免、新增不变量/守卫/适配器）。

---

## 1. Minimal file

`npx autoqe init` writes this. Edit it in place; keep it in version control.

```json
{
  "schema":  { "provider": "prisma", "path": "prisma/schema.prisma", "clientNames": ["prisma", "db", "tx"] },
  "source":  { "collector": "ts", "roots": ["src"], "extensions": [".ts", ".tsx"] },
  "ignore":  ["node_modules", "dist", "build", ".next", "coverage", ".git", "qe/templates", "qe-report"],
  "systemFields": { "id": "framework-generated", "createdAt": "framework-generated", "updatedAt": "framework-generated", "deletedAt": "written only by the soft-delete helper" },
  "fieldExemptions": [],
  "contracts": "qe.contracts.json",
  "boundaries": { "publicRoutes": [] },
  "stores": { "moduleRoots": ["src/features", "src/modules"], "sensitiveKeys": ["password", "accessToken", "refreshToken", "token", "secret"] },
  "scriptsDirs": ["scripts"],
  "guardsDir": "qe/guards",
  "packageJson": "package.json",
  "ledger": "qe/ledger/incidents.json",
  "waivers": "qe/waivers.json",
  "metaGuards": false
}
```

Missing keys fall back to the defaults below. Unknown keys are ignored — a typo fails silently, so
`doctor` is the check that catches it (it reports the schema/source counts it actually resolved).

---

## 2. Field reference

### `schema` — where the data model comes from

| Field | Default | Meaning | Change when |
|---|---|---|---|
| `provider` | `prisma` | Schema adapter. `prisma` \| `none` | No Prisma in the repo → `none`. Guards that need a model emit `status=skipped` (yellow, never green). |
| `path` | `prisma/schema.prisma` | Path to the schema file, relative to root | Your schema lives elsewhere (`src/prisma/…`, `db/schema.prisma`). |
| `clientNames` | `["prisma","db","tx"]` | Identifier names treated as a DB client when scanning code | You alias the client differently (`pg`, `knex`, `database`). |

`provider=none` does not turn guards off silently: `autoqe run` prints `GUARD_SUMMARY … status=skipped`
for `inv01`, `inv02`, `inv03` and the batch counts as yellow. That is deliberate — an empty scan is not a pass.

### `source` — what code is scanned

| Field | Default | Meaning | Change when |
|---|---|---|---|
| `collector` | `ts` | Source collector. `ts` \| `none` | The repo is not TypeScript/JavaScript → `none`. |
| `roots` | `["src"]` | Directories walked for source files | Code lives in `app/`, `packages/*/src`, `server/`, … |
| `extensions` | `[".ts",".tsx",".mts",".cts",".js",".jsx",".mjs",".cjs"]` | File suffixes that count as source | Monorepo with `.vue` or similar wrappers |

Monorepo example:

```json
"source": { "collector": "ts", "roots": ["apps/web/src", "apps/api/src", "packages/*/src"] }
```

`doctor` prints `source <dir> files=<n>` per root, so a glob that resolves to 0 files shows up immediately
(0 files is a `WARN`, not an `OK`).

### `ignore` — what is never scanned

Directory names or root-relative prefixes. Default:
`node_modules`, `dist`, `build`, `.next`, `coverage`, `.git`, `qe/fixtures`, `qe-report`.

Add your own generated or vendored trees (`generated`, `vendor`, `storybook-static`). Do **not** add your
business directories here to make findings disappear — that is hiding, and QE-03 treats it as a red finding
in review.

### `systemFields` — columns allowed to have no business writer

`{ "columnName": "reason" }`. Defaults: `id`, `createdAt`, `updatedAt`, `deletedAt`.

The reason string is the audit trail (`inv01` reads it). Add framework-managed columns such as
`tenantId` written by a middleware you can point to, or `searchVector` maintained by a trigger. Every entry
must name the mechanism that writes it.

### `fieldExemptions` — per-model, per-field exceptions

Shape: `{ "model": "User", "field": "avatarUrl", "reason": "read by the marketing site through a view" }`.

Use it only when a field is genuinely written or read outside the scanned tree. `reason` is mandatory;
an empty reason is itself a finding. Exemptions are not a substitute for widening `source.roots`.

Model-wide form: `{ "model": "Account", "field": "*", "reason": "written by @auth/prisma-adapter at runtime" }`.
Reserve it for models whose writer lives inside a dependency (adapters, ORM hooks) where no `data` key is
visible in your source; the reason must name the mechanism. `model: "*"` is accepted but should stay rare.

### `contracts` — promise and gate registry

Path to a JSON file created by `init` as `{ "promises": [], "gates": [], "errorCatalog": [] }`.
**Default: unset (`""`).** Unset means "this repository has no registry": `inv06`, `inv07` and `inv26`
report `skipped`, and `inv24` does not treat the path as an assertion target — it is not a defect.
Declare the path only when you actually maintain the registry (e.g. `"contracts": "qe.contracts.json"`).

- `promises[]` backs `inv06`: every "the system will do X" sentence in specs/comments must have a throw site
  or write site. Entry fields: `id`, `claim`, `source { file, contains }`, `backing { pattern, roots }`.
- `gates[]` backs `inv07`: every server-side rejection rule needs a UI control, and every UI control needs a
  server-side rule.
- `errorCatalog[]` backs `inv26`: error codes in use must have a throw site and vice versa.

When the path is declared but the file is missing, `inv06`/`inv07`/`inv26` still report `skipped`
(`CONTRACTS_MISSING`) — and `inv24` reports `ASSERT_TARGET_MISSING`, because a declared path that does not
exist means the criterion is judging a void.

### `boundaries` — Next.js server boundary vocabulary

| Field | Default | Meaning |
|---|---|---|
| `authPatterns` | built-in list | Regex-ish tokens that count as an auth check (session lookup, `requireUser`, `auth()`, …) |
| `validatePatterns` | built-in list | Tokens that count as input validation (`z.object`, `.parse(`, `.safeParse(`, `validate(`, `parseBody`…). `JSON.parse(` is explicitly not a hit |
| `mutationMethods` | `POST`, `PUT`, `PATCH`, `DELETE` | HTTP methods treated as mutations (auth + validation when the entry reads a request body) |
| `idempotencyEvidence` | built-in list | Extra tokens that count as server-side idempotency evidence (`pg_advisory`, `.upsert(`, `.updateMany(`, `skipDuplicates`, `P2002`, `ON CONFLICT`, `idempot` are built in). Add repo-specific mechanisms here (e.g. `transition(`, `mapUnique`) |
| `idempotencyDepth` | `2` | How many hops to follow from the entry into imported service functions when looking for idempotency evidence. `0` disables cross-file evidence (entry-body tokens only) |
| `auditWriteCalls` | built-in list | Extra names of trace-only helpers (audit / deny-path logging; `logAccessDeny`, `writeAuditEvent`, `recordAuditEvent`, `appendAudit`, `logAccess` are built in). Writes inside these bodies are not business writes — a second denial log is not a duplicated side effect — so they are split into the `audit-trace` bucket instead of the duplicate-risk buckets. They still prevent the `MUTATION_READONLY` exemption: a trace write is a write, and only a human can confirm there is no business write |
| `publicRoutes` | `[]` | `{ "file": "app/api/health/route.ts", "reason": "liveness probe, read-only" }[]` |

Backs `INV-WEB-01…04`. Three rules that are easy to get wrong:

1. A `publicRoutes` entry with an empty `reason` is a finding, not a pass — "空理由等同未登记".
2. `authPatterns` match tokens, not semantics. If your auth helper is named something unusual, add it here;
   otherwise a protected route looks unprotected.
3. Validation is only required for entries that actually read a request body
   (`request.json()` / `formData()` / `text()`); `DELETE` and action-style `POST` without a body have no input
   to validate. A same-file helper called from the entry can prove validation (one hop); cross-file helpers
   downgrade the finding to `VALIDATE_NOT_PROVEN` (warn). Idempotency keys are required for `POST`/`PUT`/`PATCH`
   only — `DELETE` is idempotent by definition. An entry whose resolvable scope (entry body + same-file helpers +
   imported service functions, bounded by `idempotencyDepth`) contains **no write call at all** — including no
   trace-only write — is reported as info `MUTATION_READONLY` instead of a warning; a read-only entry has no second
   side effect to dedupe. When the only visible write is a trace write (`auditWriteCalls`), the finding stays a
   warning but its triage tier becomes `audit-trace`.
   Unresolvable local imports, namespace imports (`import * as svc`) and an exhausted depth all keep the warning:
   an exemption has to be proven, never assumed. Third-party packages (`next/headers`, `zod`) do not count as
   "unresolvable" — they are outside the scan tree by definition.

### `stores` — client state boundaries

| Field | Default | Meaning |
|---|---|---|
| `moduleRoots` | `["src/features","src/modules"]` | Directories treated as module boundaries (`INV-SEAM-01`) |
| `sensitiveKeys` | `password`, `accessToken`, `refreshToken`, `token`, `secret` | Field names that must never be persisted (`INV-FE-01`) |

Add your own credential-like names (`apiKey`, `sessionId`, `privateKey`). Matching is on the persisted key
name, so an obfuscated key escapes the check — name persisted keys literally.

### `spec` — spec-to-implementation reconciliation (`INV-SPEC-01`)

The defect class that static analysis is structurally blind to: **code that was never written**. A doc that
promises a model, a field or an endpoint leaves no reference behind — so no compiler, lint or test will ever
report it. The doc library is the only oracle for this family, which is why it is opt-in and candidate-tier by
default.

| Field | Default | Meaning |
|---|---|---|
| `docs` | `[]` | Directories holding the spec (`.md`). Empty = not configured; the guard reports `skipped` (yellow), never green |
| `extensions` | `[".md"]` | File extensions parsed as spec docs |
| `routeRoots` | `["src/app","app"]` | Next.js App Router roots used to enumerate implemented endpoints |
| `enforce` | `false` | Promote gaps to errors. Requires `docsOwner` |
| `docsOwner` | — | Who keeps docs in sync with code. Without it, `enforce: true` is a config defect (`SPEC_ENFORCE_NO_OWNER`) and gaps stay candidates |

Only **markdown tables** with an explicit `Model` / `Field` / `Endpoint` header count. Prose such as "the system
records the tenant code" is not a claim — it has no machine-checkable shape. A field table without model context
(a `Model` column or a `### 3.2 Tenant` heading) is ignored as a whole. Matching is on whole cells, never on
substrings (`tenant` inside a sentence never becomes a model; `enant` never becomes a field).

```json
"spec": { "docs": ["docs/spec"], "routeRoots": ["src/app"], "enforce": false }
```

Output is capped: at most 10 gaps are listed, plus one `SPEC_GAP_TRUNCATED` note. Sixty-five "missing models" is
a stale spec baseline, not sixty-five defects — align the baseline first, then triage what remains.

### Repo-plumbing fields

| Field | Default | Meaning |
|---|---|---|
| `scriptsDirs` | `["scripts"]` | Where guard scripts live, used by `inv13` |
| `guardsDir` | `qe/guards` | Where local guards live, used by `inv13` |
| `packageJson` | `package.json` | Manifest checked for guard aliases (`inv13`) |
| `ledger` | `qe/ledger/incidents.json` | Incident ledger read by the report |
| `waivers` | `qe/waivers.json` | Waiver store read by `triage`: a finding is suppressed only while its entry has a reason and a `reviewBy` that has not passed |
| `auditDir` | `qe-audit` | Batch workspace read by `autoqe status` (expects `<batch>/03-bug-ledger.md`) |
| `locale` | `en` | Language of the human-facing output — `triage`, `status` reasons, `qe-report.md` (`en` / `zh`); machine readings stay English |
| `metaGuards` | `true` | Whether to audit this repo's own guard wiring (`inv13`) |

**`metaGuards` is `false` in CLI mode.** When guards live in `node_modules/autoqe`, the host has no
`qe:guard:*` aliases and no `qe/guards/` directory; `inv13` would report a false red. `init` sets it to
`false` for this reason. Set it back to `true` only if you vendor the guards into the repo (Option B in the
README) and register the aliases.

---

## 3. Recipes

### Scan a different part of the tree

```json
"source": { "collector": "ts", "roots": ["app", "src", "lib"] }
```

Then `npx autoqe doctor` — each root must print `files>0`.

### Treat a column as framework-managed

```json
"systemFields": { "publicId": "generated by the before-insert trigger in migrations/0007" }
```

### Exempt one field

```json
"fieldExemptions": [{ "model": "Invoice", "field": "pdfPath", "reason": "written by the PDF worker in services/pdf" }]
```

### Record a finding as knowingly accepted (and make it expire)

A waiver suppresses a finding, but only while it is valid. Never edit the file by hand — the CLI rejects
empty reasons and dates in the past:

```bash
npx autoqe waive ZERO_WRITER --reason "column kept for a migration window" --review-by 2026-12-31
npx autoqe waive ZERO_WRITER --reason "legacy area only" --review-by 2026-12-31 --scope src/legacy
```

The entry lands in `qe/waivers.json`:

```json
[{ "code": "ZERO_WRITER", "reason": "column kept for a migration window", "reviewBy": "2026-12-31", "addedAt": "2026-10-23" }]
```

Behaviour is deliberately asymmetric: a valid waiver removes the finding from the three buckets but keeps it
visible as `TRIAGE_WAIVED`; an expired one suppresses nothing and turns itself into a `WAIVER_EXPIRED`
decide item; an entry with no reason or an unparseable `reviewBy` is `WAIVER_INVALID` and suppresses nothing.
There is no "permanent waiver" state.

### Triage findings produced elsewhere

`triage` does not have to run the guards itself. Point it at a JSON file — a previous report, another
scanner's export, or a hand-written list:

```bash
npx autoqe triage --from qe-report/qe-report.json        # { "guards": [...] } is auto-detected
npx autoqe triage --from-report qe-report/qe-report.json # same file, explicit report shape
npx autoqe triage --from findings.json                   # Finding[] or { "findings": [...] }
```

Malformed entries abort with the offending index (`…findings[3]: level must be error / warn / info`).
Silently dropping them would turn a red reading green, so the loader refuses instead.

### Make a route public (and stay honest about it)

```json
"boundaries": {
  "publicRoutes": [{ "file": "app/api/webhooks/stripe/route.ts", "reason": "signature-verified webhook; auth is HMAC, not session" }]
}
```

### Protect routes that use a house auth helper

```json
"boundaries": { "authPatterns": ["getServerSession", "requireUser", "withAuth", "assertOrgMember"] }
```

### Never persist a token

```json
"stores": { "sensitiveKeys": ["password","accessToken","refreshToken","token","secret","apiKey","sessionId"] }
```

### Add a local guard (vendored mode only)

1. Create `qe/guards/inv30-my-rule.ts` exporting a `Guard` (same shape as the shipped ones).
2. Register it in `qe/guards/index.ts`.
3. Add an invariant entry in `qe/registry/registry.ts` with `guard`, `badSample`, `status`.
4. Create `qe/fixtures/inv30-my-rule/bad` — it must trip the guard for the intended reason before the guard
   is accepted (`npx autoqe selftest`).
5. Add the alias `"qe:guard:inv30": "node qe/cli.ts run --only inv30"` to `package.json`.

Red before green is not optional: a guard that has never seen a bad sample is a guess.

### Add a new stack adapter

Implement `SchemaProvider` or `CallCollector` in `qe/lib/providers.ts` and register it with one line in
`registerSchemaProvider` / `registerCollector`. Core guards stay untouched — that is the entire point of the
adapter layer. Then set `schema.provider` or `source.collector` to your new name.

### Where is the invariant registry in CLI mode?

`node_modules/autoqe/qe/registry/registry.ts` (also copied into `dist/` at pack time). Read it; do not edit
it — local edits vanish on the next `npm install`. To change an invariant for your org, copy the registry into
your repo and run vendored (README Option B), or open a PR upstream.

---

## 4. Discipline

- One config file, one source of truth. No per-guard config files.
- Never edit `qe.contracts.json` or `qe/ratchet.json` to silence a finding; fix the code or record an
  exemption with a reason.
- Baselines move only through `npx autoqe ratchet-update`, with "key / old / new / reason" in the commit
  message. The ratchet may only tighten.
- After any config change: `npx autoqe doctor && npx autoqe run --root .` and paste the readings.

---

## 5. Profiling

Set `QE_PROFILE=1` to print one `QE_PROFILE stage=<name> ms=<n>` line per stage. It is off by default and
changes no reading, exit code, or report content.

```bash
QE_PROFILE=1 npx autoqe report --root .
```

Useful stages: `selftest.guards`, `collect.read`, `collect.parse`, `collect.total` (with `files` / `hits`),
`guard.<id>`, `report.write`. Measure before changing parsers or compilers — on this repository AST parsing
is ~0.2s while typecheck is ~5.8s, so replacing the parser buys nothing at this size.

---

## 6. Cross-project isolation

The engine is reusable across projects by design; project state is not. Six boundaries are enforced in
code, not by convention:

| Boundary | Code | Failure mode |
|---|---|---|
| Vendored engine is stateless | `iso01` guard | An engine directory containing `qe.config.json` / `qe/ratchet.json` / `qe/waivers.json` / `qe.contracts.json` / `qe-report/` / `qe-audit/` / generated fixtures fails the scan |
| State cannot escape the root | `assertBoundary` in `qe/lib/isolation.ts` | `contracts`, `waivers`, `ledger`, `auditDir`, `reportDir`, `source.roots`, `source.evidenceRoots`, `spec.docs`, `stores.moduleRoots` resolving outside `<root>` → `QE_ISOLATION_STATE_ESCAPE` |
| State root has an identity | `<stateRoot>/qe.project.json` | State present without a marker → `QE_ISOLATION_UNBOUND`; marker mode mismatch → `QE_ISOLATION_MODE_MISMATCH`; marker `boundProject` ≠ current `package.json` name → `QE_ISOLATION_PROJECT_MISMATCH` |
| External state is bound to one project | marker `boundRoot` | Reusing a `--config` directory for another `--root` → `QE_ISOLATION_FOREIGN_ROOT` |
| Runtime is per-process | `processTempRoot` in `isolation.ts` | Rule fixtures live in a `mkdtemp` dir removed on exit; nothing is written to the engine directory |
| Concurrency crosses processes | `autoqe multi` in `cli.ts`, `cacheFor` in `ts-collector.ts` | `multi --roots a,b` spawns one child per project (`cwd` = that project) and strips `AUTOQE_CONFIG` / `AUTOQE_DENYLIST` unless `--inherit-env`; combining `multi` with `--config` / `AUTOQE_CONFIG` → `QE_ISOLATION_MULTI_EXTERNAL_CONFIG`. The AST cache is a table keyed by absolute root, so two roots cannot evict or cross-read each other |

`qe.project.json` is written by `autoqe init` (and by the first state-writing command when no state exists
yet). It contains a random `id`, the mode, and — for external configs — the audited root. Commit it: it is
project identity, not a secret, and it never contains absolute paths in `project` mode.

What this does **not** isolate: methodology (`qe/registry`, `qe/rules`, `qe/skills`, docs). That sharing is
the point. If you need a second, stricter ruleset for project B, copy the registry and run vendored
(README Option B) — do not point project B's config at project A's state files.

Reset an identity only deliberately: delete `<stateRoot>/qe.project.json` and re-run `autoqe init`. In
external mode that unbinds the state directory; never do it to "make the error go away".

Residual cases (documented, not hidden):

- Methodology (`qe/registry`, `qe/rules`, `qe/skills`) is shared by design. That is the feature.
- A full clone that also replaces `package.json` with A's name is indistinguishable from A itself. When
  forking a project, run `autoqe init` once to rebind; do not carry the old marker forward.
- `AUTOQE_DENYLIST` exported in the shell applies to every project it runs in. It is printed in the
  `ISOLATION` reading but not rejected, because a denylist can only *add* findings — it can never hide a
  defect. If it fires in the wrong project, unset it.


