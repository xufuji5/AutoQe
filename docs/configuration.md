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

### `contracts` — promise and gate registry

Path to a JSON file (default `qe.contracts.json`) created by `init` as
`{ "promises": [], "gates": [] }`.

- `promises[]` backs `inv06`: every "the system will do X" sentence in specs/comments must have a throw site
  or write site. Entry fields: `id`, `claim`, `source { file, contains }`, `backing { pattern, roots }`.
- `gates[]` backs `inv07`: every server-side rejection rule needs a UI control, and every UI control needs a
  server-side rule.

If the file is missing, `inv06`/`inv07` report errors, not green. Add one entry per promise; the sentence
itself stays in your spec, the entry is the machine-readable pointer to it.

### `boundaries` — Next.js server boundary vocabulary

| Field | Default | Meaning |
|---|---|---|
| `authPatterns` | built-in list | Regex-ish tokens that count as an auth check (session lookup, `requireUser`, `auth()`, …) |
| `validatePatterns` | built-in list | Tokens that count as input validation (`z.parse`, `schema.validate`, `safeParse`, …) |
| `mutationMethods` | `POST`, `PUT`, `PATCH`, `DELETE` | HTTP methods that must carry an idempotency key |
| `publicRoutes` | `[]` | `{ "file": "app/api/health/route.ts", "reason": "liveness probe, read-only" }[]` |

Backs `INV-WEB-01…04`. Two rules that are easy to get wrong:

1. A `publicRoutes` entry with an empty `reason` is a finding, not a pass — "空理由等同未登记".
2. `authPatterns` match tokens, not semantics. If your auth helper is named something unusual, add it here;
   otherwise a protected route looks unprotected.

### `stores` — client state boundaries

| Field | Default | Meaning |
|---|---|---|
| `moduleRoots` | `["src/features","src/modules"]` | Directories treated as module boundaries (`INV-SEAM-01`) |
| `sensitiveKeys` | `password`, `accessToken`, `refreshToken`, `token`, `secret` | Field names that must never be persisted (`INV-FE-01`) |

Add your own credential-like names (`apiKey`, `sessionId`, `privateKey`). Matching is on the persisted key
name, so an obfuscated key escapes the check — name persisted keys literally.

### Repo-plumbing fields

| Field | Default | Meaning |
|---|---|---|
| `scriptsDirs` | `["scripts"]` | Where guard scripts live, used by `inv13` |
| `guardsDir` | `qe/guards` | Where local guards live, used by `inv13` |
| `packageJson` | `package.json` | Manifest checked for guard aliases (`inv13`) |
| `ledger` | `qe/ledger/incidents.json` | Incident ledger read by the report |
| `auditDir` | `qe-audit` | Batch workspace read by `autoqe status` (expects `<batch>/03-bug-ledger.md`) |
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
