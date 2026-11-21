# YNAB MCP Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A remote MCP connector Worker that lets Duet read Taylor's YNAB plan, and categorize and approve transactions, tested only against fictional data.

**Architecture:** One new Worker (`mcp/`) wraps `@cloudflare/workers-oauth-provider` (Claude sign-in, Access-gated `/authorize`) around a stateless MCP handler. It reuses `local-readonly/` for the YNAB OAuth vault, reads and refresh. The ChatGPT-site path is removed, and authority becomes epoch-only. A new `categorize.mjs` holds the only YNAB write.

**Tech Stack:** Plain ESM `.mjs` (existing style, extended in place without restyling), Node 26 `node:test` for pure modules, vitest with `@cloudflare/vitest-plugin` (workerd) for anything importing the OAuth provider or MCP handler.

**Spec:** `.docs/ai/decision-mcp.md` (approved 2026-11-19). Read it before any task.

## Global Constraints

- No deploys, no `wrangler` commands other than `deploy --dry-run`, no Cloudflare resource creation, no YNAB registration. The root `worker.mjs`, `wrangler.json` and `schema.sql` (the deployed probe) are not modified.
- Fictional data only. Fixture secrets are literal strings beginning `fictional-`. Keys are generated in memory per test.
- Outbound hosts: `https://api.ynab.com/v1`, `https://app.ynab.com/oauth/token`, and the Access team domain's `/cdn-cgi/access/certs`. Every YNAB fetch uses `redirect: 'error'` and `AbortSignal.timeout(15000)`.
- The only YNAB write is a `PATCH` to `/plans/{pinned}/transactions`, with each element exactly `{id, category_id, approved: true}`.
- Dependencies are exact versions matching hearthops, all MIT: `@cloudflare/workers-oauth-provider@1.2.4`, `@modelcontextprotocol/server@2.3.1`, `agents@0.31.0`, `jose@6.2.13`, `zod@4.6.7`; dev: `@modelcontextprotocol/client@2.3.1`, `@cloudflare/vitest-plugin@1.4.10`, `vitest@4.1.12`, `wrangler@4.155.0`.
- MCP scopes: `ynab:read`, `ynab:categorize`. Owner id inside core and grant props: `'owner'`.
- Never log or return request bodies, tokens, client secrets, vault keys or grant ids. Errors returned to Claude are codes from Task 4's table.
- Commit after each task, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.

## Review Focus

1. Claude passes a month as `2026-11` or `November 2026`. Expect `invalid_month` with the required format in the message, and zero provider calls. (Task 4)
2. A transaction in the batch was deleted in YNAB since it was listed (GET returns 404). Expect that item `skipped: not_found` while the rest proceed. (Task 3)
3. The same transaction id appears twice in one batch, or an item has `category_id: null`. Expect `invalid_items` for the whole call, with zero provider calls. (Task 3)
4. The PATCH response omits one of the sent transactions. Expect that item `uncertain` and the others `updated`. (Task 3)
5. The token needs a refresh at the start of a categorize call while a parallel read holds the refresh lease. Expect `busy`, with no transaction GET and no PATCH. (Task 3)

---

### Task 1: Retarget core to configured origin, full access and epoch-only authority

**Files:**
- Create: `package.json`, `migrations/0001_init.sql`
- Modify: `local-readonly/core.mjs`, `local-readonly/d1-store.mjs`, `local-readonly/mock-store.mjs`, `local-readonly/read.mjs`, `local-readonly/test.mjs`, `local-readonly/d1-test.mjs`, `local-readonly/README.md`
- Delete: `local-readonly/browser.mjs`, `local-readonly/router.mjs`, `local-readonly/schema.sql`

**Interfaces:**
- Produces:
  - `enabled(env)` requires `env.enabled===true`, `clientId`, `clientSecret`, `vaultKey`, `owner`, `store`, and `origin` (an `https:` origin string with no path). `publicKey` and `writesEnabled` are no longer read.
  - `callbackURL(env) -> string`, equal to `env.origin + '/oauth/callback'`.
  - `authorizationURL(clientId, redirectUri, state, challenge) -> string`. It has no `scope` parameter, which gives full access.
  - `begin(owner, env, now, proof)`, where `proof = {epoch}`. It stores the flow via `store.putFlowForEpoch(owner, flow, epoch) -> Promise<boolean>`, or `putFlow` when `env.mockOnly`.
  - `callback(request, env, fetcher, now)` accepts only `env.origin`. Its `clean()` redirect goes to `env.origin + '/setup'`.
  - `D1Store` methods `lockRefresh` and `pin` accept only `{epoch}` proofs.
  - `D1Store.disconnect(owner)` bumps the epoch and deletes `oauth_flows` and `connections` rows.
  - `D1Store.purgeExpired(now)` only touches `oauth_flows`.
  - `MockStore` gains `epoch(owner)` and `putFlowForEpoch`.
  - `migrations/0001_init.sql` holds tables `oauth_flows`, `connections` and `owner_epochs`, with columns unchanged from the deleted schema.
  - `package.json`: `{"type":"module","private":true,"license":"MIT"}` with script `"test:node": "node --test test.mjs local-readonly/*test.mjs"`.
- Removed: `authenticate`, `signingInput`, `write`, and every handoff, nonce or session store method. `read.mjs` `authority()` keeps only the epoch branch.

- [ ] **Step 1: Update tests first**
  - In `local-readonly/test.mjs`:
    - Fixtures gain `origin: 'https://fictional.example'` and drop `publicKey` and `writesEnabled`.
    - Replace `'read-only provider scope and single-use callback'` with `'full-access authorization has no scope and uses configured callback'`. Assert `f.u.searchParams.has('scope') === false` and `f.u.searchParams.get('redirect_uri') === 'https://fictional.example/oauth/callback'`. Keep the single-use assertions.
    - `'disabled configuration and writes reject'` becomes `'disabled configuration rejects'`. It asserts `enabled({})` throws, and that a full fixture minus `origin` throws.
    - Delete `'signed request binds identity path body and nonce, not Site headers'`.
  - In `local-readonly/d1-test.mjs`:
    - Read `migrations/0001_init.sql`.
    - Delete the tests for SQL nonce uniqueness, browser handoff, signed context, router handoff, session-bound disconnect and post-OAuth UI.
    - Replace `'flow start revalidates browser session atomically after disconnect'` with `'flow start conditioned on epoch: disconnect after epoch read stores no flow'`. Read the epoch, call `store.disconnect`, then `begin(owner, env, now, {epoch})` rejects, and `store.flow(owner)` is `null`.
    - Convert `'old authority cannot read reconnected plan or pin it'` and `'stale epoch cannot acquire refresh on new connection'` to `{epoch}` proofs only.

- [ ] **Step 2: Run to verify failures**

  Run: `node --test local-readonly/*test.mjs`
  Expected: FAIL on the new origin, scope and epoch tests.

- [ ] **Step 3: Implement the interface changes above, and delete the retired files**

- [ ] **Step 4: Run all node tests**

  Run: `npm run test:node`
  Expected: PASS. Record the new test count. The probe tests in the root `test.mjs` are unchanged and pass.

- [ ] **Step 5: Update the README and commit**
  - `local-readonly/README.md` replaces its first two sections with a pointer to `.docs/ai/decision-mcp.md`, and states that the bridge is no longer read-only.
  - The commit message lists each retired test by name.

---

### Task 2: Reads for review: categories, transactions and formatted amounts

**Files:**
- Create: `local-readonly/review.mjs`, `local-readonly/review-test.mjs`
- Modify: `local-readonly/read.mjs`, `local-readonly/core.mjs` (`readBounded`, `categoryProjection`)

**Interfaces:**
- Consumes: the Task 1 core, with `access(owner, env, fetcher, now, {epoch})`.
- Produces:
  - `read.mjs`:
    - Exports `get(path, token, fetcher, maxBytes = 1048576)`. HTTP 404 throws `not_found`, 429 throws `rate_limited`, any other non-OK throws `provider_read_failed`, and a body over `maxBytes` throws `too_large`. In core, `readBounded`'s overflow error becomes `too_large`.
    - Exports `authority` and `unchanged`.
  - `listPlans` items gain `currencyFormat`. That is `{iso_code, decimal_digits, decimal_separator, symbol_first, group_separator, currency_symbol, display_symbol}` copied when `iso_code` is a string of 8 characters or fewer; otherwise `null`.
  - `categoryProjection` rows gain `assignedFormatted`, `activityFormatted` and `availableFormatted`. Each comes from the matching `*_formatted` field when that field is a string of 64 characters or fewer; otherwise `null`.
  - `review.mjs`:
    - `categoryAllowed(category, group) -> boolean`. It is false when either the category or the group is `deleted` or `hidden`, when the group name is `'Credit Card Payments'`, or when the category is `internal` and its name is not `'Inflow: Ready to Assign'`. A group's `internal` flag alone does not refuse: YNAB sets it on ordinary groups such as Bills and Expenses. In an `internal` group, a category whose own `internal` flag is missing or not a boolean is refused.
    - `transactionShape(t) -> 'ok'|'deleted'|'split'|'transfer'|'unsupported'`:
      - `deleted` when `t.deleted === true`.
      - `split` when `subtransactions` is a non-empty array or `category_name === 'Split'`.
      - `transfer` when `transfer_account_id` is a non-null string.
      - `unsupported` when `id`, `date`, `account_id` or `amount` (a safe integer) is missing or malformed.
    - `listCategories(owner, env, fetcher, now, proof) -> {planId, groups: [{id, name, hidden, deleted, internal, categories: [{id, name, hidden, deleted, internal, categorizable}]}]}`. It makes a GET to `/plans/{plan}/categories`. Fail with `provider_response` beyond 1000 groups or 5000 categories.
    - `listReview(owner, env, {type, sinceDate, limit}, fetcher, now, proof) -> {planId, type, sinceDate, moreAvailable, transactions: [...]}`:
      - It makes a GET to `/plans/{plan}/transactions?type=…&since_date=…` with `maxBytes` of 2097152 (2 MiB). An overflow throws `narrow_dates`.
      - `type` is `'uncategorized'` or `'unapproved'`.
      - `sinceDate` must be a `YYYY-MM-DD` date no later than today. It defaults to the UTC date 14 days before `now`.
      - `limit` is an integer from 1 to 200, defaulting to 50.
      - Results are sorted by `date` descending, then `id`, and truncated to `limit`.
      - Each item is `{id, date, amount, amountFormatted, payeeName, memo, accountId, accountName, categoryId, categoryName, approved, cleared, isSplit, isTransfer}`.
  - Every function checks `authority` and `unchanged` after each provider read, as `monthReport` does.

- [ ] **Step 1: Write failing tests in `review-test.mjs`**
  - Use `MockStore`, a sealed fictional token, a pinned plan `'fictional-plan'`, and a recording mock fetcher.
  - `'categoryAllowed table'`:
    - Allowed: ordinary; `Inflow: Ready to Assign` with `internal: true`; an ordinary category in an `internal: true` group.
    - Refused: hidden, deleted, hidden group, `Credit Card Payments` group, any other internal category.
  - `'transactionShape table'`:
    - Returns `deleted`, `split` (by subtransactions or by name), `transfer` and `unsupported` (missing amount; amount `1.5`).
    - An ordinary transaction returns `ok`.
  - `'listReview builds exact URL and defaults'`:
    - With `now = Date.UTC(2026,10,19)`, the fetched URL equals `https://api.ynab.com/v1/plans/fictional-plan/transactions?type=unapproved&since_date=2026-11-05`.
    - The method is `GET`.
  - `'listReview sorts newest first and flags more'`: 3 fixtures with `limit: 2` give the two newest and `moreAvailable === true`.
  - `'listReview over 2 MiB fails narrow_dates'`.
  - `'listReview rejects future sinceDate, bad type, limit 0 and 201 with no fetch'`.
  - `'listCategories marks categorizable with categoryAllowed'`.
  - `'get maps 404, 429 and other errors'`.
  - `'listPlans currencyFormat copied and bounded'`.
  - `'categoryProjection passes formatted strings and drops long ones'`.
  - `'listReview handles a 1.9 MiB fixture'`. Log the parse and sort duration and put it in the commit message. Over 10 ms (the Workers Free CPU limit) gets flagged for the live check in `mcp/SETUP.md`.

- [ ] **Step 2: Run to verify failures**

  Run: `node --test local-readonly/review-test.mjs`
  Expected: FAIL (module missing).

- [ ] **Step 3: Implement the interfaces above**

- [ ] **Step 4: Run all node tests**

  Run: `npm run test:node`
  Expected: PASS.

- [ ] **Step 5: Commit**

---

### Task 3: The categorize-and-approve write

**Files:**
- Create: `local-readonly/categorize.mjs`, `local-readonly/categorize-test.mjs`

**Interfaces:**
- Consumes: `get`, `authority`, `unchanged` (`read.mjs`); `access` and `jsonBounded` (`core.mjs`); `categoryAllowed` and `transactionShape` (`review.mjs`).
- Produces:
  - `writeRequest(planId, updates, token) -> {url, init}`:
    - `updates` is an array of `{id, category_id}`.
    - The URL is `https://api.ynab.com/v1/plans/${planId}/transactions`.
    - `init` is `{method: 'PATCH', redirect: 'error', signal: AbortSignal.timeout(15000), headers: {Authorization, 'Content-Type': 'application/json'}, body}`.
    - The body is `JSON.stringify({transactions: updates.map(u => ({id: u.id, category_id: u.category_id, approved: true}))})`.
    - It is the only code in the repo that builds a non-GET YNAB request.
  - `categorize(owner, env, items, fetcher, now, proof) -> {planId, results: [{transactionId, outcome, reason?, returned?}]}`:
    - Each item is `{transaction_id, category_id, expected: {category_id: string|null, approved: boolean, amount: int, date: 'YYYY-MM-DD', account_id: string}}`.
    - Throws `invalid_items` (before any fetch) when:
      - the array has fewer than 1 or more than 10 items;
      - a transaction id is duplicated;
      - an id fails `/^[a-zA-Z0-9-]{1,128}$/`;
      - `category_id` is not such a string;
      - `expected` is malformed.
    - Order:
      1. `authority`
      2. `access` (once)
      3. Plan pinned, else `plan_not_pinned`.
      4. A GET for categories, building the allowed set with `categoryAllowed`. A disallowed or missing target is skipped as `category_not_allowed`.
      5. A GET for each remaining transaction, `/plans/{plan}/transactions/{id}`, with `authority` and `unchanged` after each. A 404 is skipped as `not_found`. A `transactionShape` other than `ok` is skipped with that shape as the reason. Any `expected` field differing from the fetched value is skipped as `changed`.
      6. `authority` and `unchanged`.
      7. If any item remains: one PATCH via `writeRequest`, then the response is read with `jsonBounded(r, 1048576)`.
    - Outcomes per sent item:
      - `updated` when the response's `data.transactions` contains the id with the requested `category_id` and `approved === true`.
      - Otherwise `uncertain`, with `returned: {category_id, approved}` when present.
      - A non-OK response, a thrown fetch or a parse failure makes every sent item `uncertain`.
    - Errors other than 404 during steps 1 to 6 propagate: `reauthorization_required`, `refresh_in_progress`, `rate_limited`, `connection_changed`, `authorization_changed`, `provider_read_failed`. No PATCH is sent.

- [ ] **Step 1: Write failing tests in `categorize-test.mjs`**
  - Use a recording fetcher. After every test, `assertOnlyAllowedCalls(calls)` checks that each call is a GET, or a PATCH to exactly `https://api.ynab.com/v1/plans/fictional-plan/transactions`. Every PATCH body element must have keys exactly `['approved', 'category_id', 'id']` with `approved === true`.
  - `'writeRequest shape'`: deep-equal the body for two updates. The method is `PATCH` and the redirect is `error`.
  - `'happy path updates and approves'`:
    - Two items give two `updated`.
    - There is exactly one PATCH.
    - The calls are 1 categories GET, 2 transaction GETs and 1 PATCH, in that order.
  - `'changed amount, date, account, category or approved is skipped, no PATCH'`. Loop over each field.
  - `'split, transfer, deleted and unsupported skipped with reason'`.
  - `'hidden, credit card payment and internal categories skipped; Ready to Assign allowed'`.
  - `'deleted-in-YNAB transaction 404 skipped not_found, others updated'` (Review Focus 2).
  - `'invalid_items with zero calls'`: 0 items, 11 items, a duplicate id, `category_id: null`, missing `expected` (Review Focus 3).
  - `'PATCH response missing one id marks it uncertain'` (Review Focus 4).
  - `'PATCH 500 and PATCH throw mark all sent uncertain'`.
  - `'refresh lease held gives refresh_in_progress with no transaction GET or PATCH'` (Review Focus 5). Seal an expired token and pre-lock the connection in `MockStore`.
  - `'disconnect after transaction GET aborts before PATCH'`. Use the fetcher hook to call `store.disconnect`. Expect a rejection and zero PATCH calls.
  - `'429 on a transaction GET aborts with rate_limited, no PATCH'`.

- [ ] **Step 2: Run to verify failures**

  Run: `node --test local-readonly/categorize-test.mjs`
  Expected: FAIL (module missing).

- [ ] **Step 3: Implement `categorize.mjs`**

- [ ] **Step 4: Run all node tests**

  Run: `npm run test:node`
  Expected: PASS.

- [ ] **Step 5: Check that the write builder is the only one**

  Run: `grep -rnE "method:'(POST|PUT|PATCH|DELETE)'|method: '(POST|PUT|PATCH|DELETE)'" local-readonly mcp --include=*.mjs | grep -v test`
  Expected: only the `PATCH` in `categorize.mjs` and the `POST` to `app.ynab.com/oauth/token` in `core.mjs`.

- [ ] **Step 6: Commit**

---

### Task 4: MCP tools and handler

**Files:**
- Create: `mcp/tools.mjs`, `mcp/handler.mjs`, `mcp/core-env.mjs`, `vitest.config.mjs`, `test/mcp-tools.test.mjs`, `test/fixtures.mjs`
- Modify: `package.json` (dependencies, `allowScripts` as in hearthops, scripts `"test:workers": "vitest run"` and `"test": "npm run test:node && npm run test:workers"`)

**Interfaces:**
- Consumes:
  - `listPlans`, `monthCategories`, `monthReport` (`read.mjs`)
  - `listCategories`, `listReview` (`review.mjs`)
  - `categorize` (`categorize.mjs`)
  - `D1Store`
- Produces:
  - `core-env.mjs`: `coreEnv(workerEnv) -> Promise<object|null>`.
    - Returns `null` unless `YNAB_CLIENT_ID`, `YNAB_CLIENT_SECRET`, `VAULT_KEY` and `PUBLIC_ORIGIN` are all non-empty.
    - `VAULT_KEY` is base64url for 32 bytes, imported as non-extractable AES-GCM.
    - Otherwise it returns `{enabled: true, owner: 'owner', origin: PUBLIC_ORIGIN, clientId, clientSecret, vaultKey, store: new D1Store(workerEnv.DB)}`.
  - `tools.mjs`:
    - Exports `SCOPE_READ = 'ynab:read'`, `SCOPE_CATEGORIZE = 'ynab:categorize'`, and `buildServer(env, scopes, {fetcher, clock}) -> McpServer`.
    - Each tool reads the epoch fresh and passes `{epoch}`.
    - Output uses hearthops' `ok` and `fail` helpers (`structuredContent` plus JSON text).
  - `handler.mjs`: `handleMcp(request, env, scopes, deps) -> Promise<Response>`. This is the hearthops `mcp/handler.ts` port, with `route: '/mcp'`, `legacy: 'stateless'` and `cache-control: no-store`.

Tools (zod inputs; annotations as in the spec):

| Tool | Scope | Input | Calls |
|------|-------|-------|-------|
| `get_connection` | read | none | `store.connection`. If ready and pinned, `listPlans` to find the name and `currencyFormat`. |
| `get_month_summary` | read | `month` | `monthCategories` |
| `get_budget_report` | read | `month`, `category_id?` | `monthReport` with `definitions = {}`. Filter `rows` by `category_id`; no row gives `not_found`. |
| `list_categories` | read | none | `listCategories` |
| `list_transactions_to_review` | read | `type`, `since_date?`, `limit?` | `listReview` |
| `categorize_transactions` | categorize | `items` | `categorize` |

- `month` must match `^\d{4}-(0[1-9]|1[0-2])-01$`. The invalid message is `Use the first day of the month, like 2026-11-01.`
- `get_connection` output:
  - `{connected: false, status: 'not_connected'}` when there is no row.
  - `{connected: false, status: 'reconnect_needed'}` for `reauthorization_required`.
  - `{connected: true, planPinned: false}`.
  - `{connected: true, planPinned: true, plan: {id, name, currencyFormat}}`.
- Without `ynab:categorize`, `categorize_transactions` returns `forbidden` with `This connection is read-only. Reconnect and allow categorizing.` and makes no call.

Error code mapping (thrown message → code):

| Thrown message | Code |
|----------------|------|
| `env === null` | `not_configured` |
| `not_authorized`, no connection | `not_connected` |
| `reauthorization_required` | `reconnect_needed` |
| `plan_not_pinned` | `plan_not_pinned` |
| `refresh_in_progress` | `busy` |
| `rate_limited` | `rate_limited` |
| `narrow_dates`, `too_large` | `narrow_dates` |
| `invalid_month` | `invalid_month` |
| `invalid_items`, zod failure | `invalid_input` |
| `not_found` | `not_found` |
| `connection_changed`, `authorization_changed` | `retry` |
| anything else | `request_rejected` |

Messages are fixed strings; never echo the thrown text.

- [ ] **Step 1: Install pinned dependencies and confirm licenses**

  Run: `npm install --save-exact <deps> && npm install --save-exact -D <devDeps>` (versions from Global Constraints).
  Then run: `node -e "for (const p of ['@cloudflare/workers-oauth-provider','@modelcontextprotocol/server','agents','jose','zod']) console.log(p, require('./node_modules/'+p+'/package.json').license)"`
  Expected: every line ends in `MIT`. Stop and report anything else.

- [ ] **Step 2: Write `vitest.config.mjs` and `test/fixtures.mjs`**
  - `vitest.config.mjs` follows hearthops `vitest.config.ts`: D1 `DB` with `migrations/`, KV `OAUTH_KV`, compat flags `nodejs_compat` and `global_fetch_strictly_public`, and fictional bindings: `PUBLIC_ORIGIN='https://fictional.example'`, `YNAB_CLIENT_ID='fictional-client'`, `YNAB_CLIENT_SECRET='fictional-client-secret'`, a generated `VAULT_KEY`, `OWNER_EMAIL='owner@example.test'`, `ACCESS_TEAM_DOMAIN='https://unit-test.cloudflareaccess.com'`, `ACCESS_AUD='test-audience'` and `ALLOWED_REDIRECT_HOSTS='claude.ai,claude.com'`.
  - `fixtures.mjs` exports `seedConnection(env, {planId})`, which seals `{access: 'fictional-access', refresh: 'fictional-refresh'}` into a ready, pinned row. It also exports `ynabFetcher(routes)`, a recording fetcher, and `connect(scopes, deps)`, an MCP client over `handleMcp` modelled on `connect()` in `hearthops/test/mcp-tools.test.ts`.

- [ ] **Step 3: Write failing tests in `test/mcp-tools.test.mjs`**
  - `'lists exactly six tools with annotations'`: sorted names equal the six above. `readOnlyHint` is true for the five reads. `categorize_transactions` has `readOnlyHint: false`, `destructiveHint: false` and `idempotentHint: true`.
  - `'read scope cannot categorize and makes no call'`.
  - `'missing secrets give not_configured'`.
  - `'get_connection states'`: not connected; reconnect needed; pinned, with the name and currency from a fictional `/plans`.
  - `'month formats rejected with zero calls'` (Review Focus 1): `2026-11`, `November 2026`, `2026-11-15`, `2026-13-01`.
  - `'budget report filters by category and 404s unknown'`.
  - `'categorize through MCP updates and approves'`.
  - `'refresh_in_progress maps to busy'`.
  - `'no output contains secrets'`: run every tool; the concatenated JSON contains none of `fictional-access`, `fictional-refresh`, `fictional-client-secret` or the `VAULT_KEY` value.

- [ ] **Step 4: Run to verify failures**

  Run: `npx vitest run test/mcp-tools.test.mjs`
  Expected: FAIL (modules missing).

- [ ] **Step 5: Implement `core-env.mjs`, `tools.mjs` and `handler.mjs`**

- [ ] **Step 6: Run the full suite**

  Run: `npm test`
  Expected: PASS.

- [ ] **Step 7: Commit, including `package-lock.json`**

---

### Task 5: Worker entry, Access, consent, setup pages and owner checklist

**Files:**
- Create: `mcp/worker.mjs`, `mcp/access.mjs`, `mcp/consent.mjs`, `mcp/setup.mjs`, `mcp/wrangler.json`, `mcp/SETUP.md`, `test/mcp-worker.test.mjs`
- Modify: `.docs/ai/decision-mcp.md` (status line only: `Status: approved; built locally, not deployed.`)

**Interfaces:**
- Consumes: `begin`, `callback`, `callbackURL` (core); `listPlans`, `selectPlan` (read); `coreEnv`, `handleMcp`, `SCOPE_READ`, `SCOPE_CATEGORIZE`.
- Produces:
  - `access.mjs`: `isOwner(request, {teamDomain, audience, ownerEmail}, getKey?) -> Promise<boolean>` and `redirectAllowed(uri, hosts) -> boolean`. Both are line-for-line ports of `hearthops/mcp/access.ts`.
  - `consent.mjs`: `consentPage(details, handle) -> string`, a port of `hearthops/mcp/consent.ts`.
    - "Read your budget" is always granted.
    - The checkbox `scope=ynab:categorize` is labelled `Categorize and approve transactions` and is unchecked by default.
  - `setup.mjs`: `handleSetup(request, env, workerEnv, deps) -> Promise<Response>`.
    - Every request must pass `isOwner`, else 403. `env === null` gives 503 `Not configured.`
    - `GET /setup` shows the status, a connect button, a plan picker (when the status is `authorized_unvalidated`) and a disconnect button. It escapes provider names as the deleted `router.mjs` did and sets the same CSP.
    - `GET /setup` also sets the cookie `__Host-ynab-csrf=<random>; Path=/setup; Secure; HttpOnly; SameSite=Strict`, and embeds the same value in each form.
    - `POST /setup/connect`, `/setup/plan` and `/setup/disconnect` each require all of:
      - `Origin` equal to `env.origin`
      - `application/x-www-form-urlencoded` of 4096 bytes or less
      - exact form keys (`csrf`, or `csrf` and `planId`)
      - the `csrf` field equal to the cookie
    - Each then reads the epoch fresh. `connect` responds 303 to `begin(...).location` with the flow cookie. `plan` calls `selectPlan`. `disconnect` calls `store.disconnect` and returns `{localDisconnected: true, providerRevocationVerified: false}`.
  - `worker.mjs`: `createYnabMcpWorker({accessKey, fetcher, clock}) -> ExportedHandler`, with the default export `createYnabMcpWorker()`. It follows the structure of `hearthops/mcp/worker.ts`:
    - `scopesSupported` is `[SCOPE_READ, SCOPE_CATEGORIZE, 'openid', 'email', 'offline_access']`, and `requiredScopes` is `[SCOPE_READ]`.
    - The KV binding is `OAUTH_KV` directly.
    - The API handler rejects `props.userId !== 'owner'` with 403.
    - The default handler routes `/`, `/authorize` (Access plus consent), `/setup*` (to `handleSetup`) and `GET /oauth/callback` (to `callback`, with no Access check; state and cookie protect it). Everything else is 404.
  - `mcp/wrangler.json`:
    - `name: 'ynab-mcp'`, `main: 'worker.mjs'`, `compatibility_date: '2026-11-19'`, flags `nodejs_compat` and `global_fetch_strictly_public`.
    - `workers_dev: false`, `preview_urls: false`, `logpush: false`.
    - Observability matches the root `wrangler.json`, including `redact_query_string: true`.
    - D1 `DB` and KV `OAUTH_KV` ids are `"REPLACE_AT_DEPLOY"`. Vars `PUBLIC_ORIGIN`, `OWNER_EMAIL`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are `"REPLACE_AT_DEPLOY"`. `ALLOWED_REDIRECT_HOSTS` is `'claude.ai,claude.com'`.
    - No routes.
  - `mcp/SETUP.md`: Taylor's manual checklist, each step marked "you do this".
    1. Choose the hostname.
    2. Create the D1 database and the KV namespace.
    3. Apply `migrations/0001_init.sql`.
    4. Create the Access application for `/authorize` and `/setup`.
    5. Fill in the config.
    6. Approve the deploy.
    7. Connect claude.ai with YNAB not yet connected; expect `not_connected`.
    8. Register the YNAB OAuth app with the exact callback `<origin>/oauth/callback` and full access.
    9. Set the secrets `YNAB_CLIENT_ID`, `YNAB_CLIENT_SECRET` and `VAULT_KEY` in Cloudflare secret settings (never in chat).
    10. Run the live write check on a throwaway plan.
    11. Pin the real plan.
    12. Set `categorize_transactions` to "always ask" in claude.ai.

- [ ] **Step 1: Write failing tests in `test/mcp-worker.test.mjs`**
  - Use a local JWKS, as `hearthops/test/mcp-auth.test.ts` does.
  - `'authorize requires owner Access JWT'`: no JWT, a wrong email and a wrong audience each give 403.
  - `'full OAuth flow with read scope lists tools; categorize forbidden'`: follow the register, authorize, approve and token sequence from `mcp-auth.test.ts`.
  - `'categorize scope granted only when box checked'`.
  - `'setup requires Access'`.
  - `'setup POST rejects missing csrf, mismatched csrf, wrong Origin and extra form keys with no store change'`.
  - `'setup connect redirects to app.ynab.com with configured callback and no scope'`.
  - `'setup disconnect bumps epoch and clears connection'`.
  - `'callback reachable without Access but rejects without flow cookie'`: expect 400 and zero fetches.
  - `'mcp without bearer is 401; unknown path 404'`.

- [ ] **Step 2: Run to verify failures**

  Run: `npx vitest run test/mcp-worker.test.mjs`
  Expected: FAIL.

- [ ] **Step 3: Implement `access.mjs`, `consent.mjs`, `setup.mjs`, `worker.mjs`, `mcp/wrangler.json` and `mcp/SETUP.md`**

- [ ] **Step 4: Full verification**
  - Run: `npm test`
    Expected: all pass.
  - Run: `npx wrangler deploy --dry-run -c mcp/wrangler.json --outdir /tmp/ynab-mcp-dry`
    Expected: the bundle builds, with no upload.
  - Run: `git diff 82defbc -- . ':!package-lock.json' | grep -iE 'token|secret|key' | grep -viE 'fictional|REPLACE_AT_DEPLOY|vaultKey|VAULT_KEY|refresh_token|access_token|token_type|getKey|tokenEndpoint|accessTokenTTL'`
    Expected: no real credential values. Review any remaining lines by hand.
  - Run: `git diff 82defbc -- worker.mjs wrangler.json schema.sql`
    Expected: empty (the probe is untouched).

- [ ] **Step 5: Update the decision doc status and commit**
