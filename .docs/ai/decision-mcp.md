# Decision: YNAB MCP connector for Duet

Date: 2026-11-19. Status: approved; built locally, not deployed.

## Intent

Duet (Claude) goes through Taylor's YNAB budget **with Taylor**: reads the month, budget status and
transactions waiting for review, then categorizes and approves those transactions as they agree on
them. It must work from claude.ai and the Claude phone app, not only this Mac.

## Goals

- A remote MCP connector Taylor adds to claude.ai as a custom connector.
- Read tools: the pinned plan, month summary, budget report with per-category status, the category
  list, and transactions needing review.
- One write tool: set a transaction's category and mark it approved. Nothing else.
- Only Taylor can authorize the connector, and only Taylor can connect YNAB.
- Built and tested against fictional data first. Live use comes later, through Taylor's manual gates.

## Non-goals

- Creating, deleting, splitting or importing transactions. Changing amounts, dates, accounts,
  payees, memos, cleared status or flags. Assigning money to categories, moving money, or editing
  targets.
- A local stdio server. Remote only.
- Supporting more than one YNAB plan at a time. One plan stays pinned; changing it needs a
  disconnect, as today.
- Keeping the ChatGPT-site handoff path (see "Retired").

## Anti-goals (failure even if it works)

- Any code path that can send YNAB a field other than `id`, `category_id` and `approved` on a write.
- A write that lands on a transaction that changed after Duet showed it to Taylor, without saying so.
- A transaction silently becoming unapproved, or approved without the category Taylor agreed.
- Tokens, client secrets or vault keys in source, logs, tool output or chat.
- Any outbound traffic other than to `api.ynab.com` and `app.ynab.com` (OAuth), plus Cloudflare
  Access's JWKS for verifying the owner.

## This reverses an earlier decision

The 2026-11-14 decision made the bridge read-only, and `core.mjs` still enforces that
(`scope: 'read-only'`, `enabled()` requires `writesEnabled === false`, `write()` always throws).
Taylor decided on 2026-11-19 that Duet must be able to categorize and approve. Consequences:

- **YNAB OAuth has only two scopes: read-only and full access.** Categorizing needs full access,
  so the stored token can change or delete anything in the budget. The limit comes only from this
  Worker's code: one write route, one field allowlist, tests that prove it.
- **YNAB has no conditional update** (no ETag or compare-and-swap). The guard below narrows the
  race window but cannot close it. If Taylor edits the same transaction in the YNAB app at the
  same moment, one change wins. This is accepted and documented, not solved.
- **`approved` defaults to false when omitted** (OpenAPI 1.91.0, `SaveTransactionWithOptionalFields`:
  "If not supplied, transaction will be unapproved by default"). Every write therefore sends
  `approved: true` explicitly. That removes the earlier "omitted approved" ambiguity for this tool.
- **Still unverified:** that a PATCH with only `id`, `category_id` and `approved` leaves memo,
  cleared, flag and payee untouched. The spec marks the fields optional but does not say. This is a
  live gate (see "Gates").

## Approaches considered

All three use the same front end: a Worker serving MCP at `/mcp` over Streamable HTTP, using the
hearth-mcp pattern (`@cloudflare/workers-oauth-provider`, Cloudflare Access on `/authorize`
allowing only Taylor's email, stateless MCP handler).

- **A. Separate sign-ins (chosen by Taylor, 2026-11-19).** Claude signs in to the Worker. YNAB is
  connected once on an owner-only setup page behind the same Access policy. Reuses the existing
  encrypted D1 token vault, refresh locking, plan pinning and disconnect, with their tests.
  Reconnecting Claude does not touch YNAB, and YNAB can be disconnected without touching Claude.
- **B. Chained sign-in.** Claude's `/authorize` goes straight on to YNAB OAuth, and the YNAB token
  lives in the Claude grant's props. One consent flow, but it discards the vault, refresh and
  disconnect code; refreshing YNAB means rewriting grant props; every new Claude grant re-grants
  full YNAB access. Not chosen.
- **Dropped:** Cloudflare Access alone (claude.ai connectors need OAuth); a YNAB personal access
  token (full access, pasted rather than granted and revocable); two Workers for read and write (two
  YNAB app registrations for little added safety).

## Design

### Components (one Worker)

| Path | Who reaches it | Purpose |
|------|----------------|---------|
| `/mcp` | Claude, with a bearer token from the OAuth provider | MCP tools |
| `/authorize` | Taylor's browser, behind Access | Claude consent page (hearth pattern) |
| `/token`, `/register`, `/.well-known/*` | Claude | Handled by `workers-oauth-provider` |
| `/setup/*` | Taylor's browser, behind Access | Connect YNAB, pin plan, disconnect |
| `/oauth/callback` | YNAB redirect | Existing PKCE callback in `core.mjs` |

- **Claude ↔ Worker:** `workers-oauth-provider` with grants stored in a new KV namespace. The
  consent page verifies the `Cf-Access-Jwt-Assertion` JWT (as `hearthops/mcp/access.ts` does) and
  checks the email equals the configured owner. Redirect hosts are allowlisted to Claude's.
- **MCP scopes:** `ynab:read` and `ynab:categorize`. The consent page shows both; Taylor can grant
  read alone. Without `ynab:categorize`, the write tool returns a "read-only connection" error, as
  Hearth does.
- **Worker ↔ YNAB:** the existing `core.mjs` flow (S256 PKCE, encrypted verifier, AES-GCM token
  vault in D1, refresh with lease/CAS) with `scope` changed from `read-only` to full access.
  `/setup/*` replaces the ChatGPT-site handoff as the browser entry point, keeping HttpOnly session
  and CSRF.
- **Authority per MCP request:** the OAuth provider has proved the caller is the owner. The handler
  reads the owner's current D1 epoch and passes `{epoch}` as the proof to the existing read
  functions, so a disconnect or reconnect during a request still aborts it.

### Tools

Reads (`ynab:read`, `readOnlyHint: true`):

- `get_connection` — whether YNAB is connected, the pinned plan's id and name, and the currency
  format. No tokens.
- `get_month_summary(month)` — wraps `monthCategories`. Amounts in milliunits plus formatted
  strings.
- `get_budget_report(month, category_id?)` — wraps `monthReport`; per-category status from
  `projection.mjs`. An optional `category_id` narrows it to one row (this is "category status").
  Ships with empty `limits` and `roles` (Taylor, 2026-11-19): status is "over budget" for a
  negative balance and "unknown" otherwise. Assigned, spent, available and target progress are
  still reported. Storing per-category limits is a possible later addition, not part of this
  build.
- `list_categories` — category groups and categories for the pinned plan: ids, names, hidden and
  deleted flags. Duet needs this to pick a category id.
- `list_transactions_to_review(type, since_date?, limit?)` — `type` is `uncategorized` or
  `unapproved` (YNAB's own filter). Default `since_date` is 14 days back; `limit` defaults to 50,
  max 200. Returns per transaction: id, date, amount, payee name, memo, account name, category id
  and name, approved, cleared, and whether it is a split or transfer.

Write (`ynab:categorize`, `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`):

- `categorize_transactions(items)` — 1 to 10 items. Each item:
  `{transaction_id, category_id, expected: {category_id, approved, amount, date, account_id}}`,
  where `expected` is what Duet showed Taylor.

  Steps:
  1. Validate ids, and check `category_id` exists in the pinned plan, is not deleted or hidden,
     and is not a credit card payment category.
  2. Re-read each transaction (GET). Skip it with reason `changed` if any `expected` field differs,
     or if it is deleted, a split, or a transfer.
  3. Send one PATCH to `/plans/{plan_id}/transactions` with only
     `{id, category_id, approved: true}` per remaining item.
  4. Check the response: each returned transaction has the requested `category_id` and
     `approved: true`. Anything else is reported as `uncertain` with what YNAB returned.
  5. Return per item: `updated`, `skipped` (with reason) or `uncertain`.

  Approving a transaction that is already categorized correctly is the same call, with
  `category_id` equal to the current one.

### Write containment

- One function builds every outbound write request. It accepts only the allowlisted shape, the
  method `PATCH` and the single path `/plans/{pinned}/transactions`. Every other fetch is `GET`.
  `core.mjs`'s `write()` is replaced by this one function, not loosened in general.
- The YNAB fetcher keeps fixed hosts, `redirect: 'error'`, timeouts and bounded response sizes.
- The Claude tool-approval prompt is Taylor's confirmation step. The setup notes tell Taylor to set
  `categorize_transactions` to "always ask" in claude.ai.

### Data and privacy

- Tool output contains budget data (that is the point), never tokens, grant ids or keys.
- Logs: no request or response bodies and no query strings; `redact_query_string` stays on, logpush
  stays off. Errors are coded (`request_rejected`, `changed`, `uncertain`) without provider bodies.
- Rate: YNAB allows 200 requests per hour per token. A report costs 3 GETs; a categorize batch
  costs 1 to 10 GETs plus 1 PATCH. Errors from a 429 are passed back as `rate_limited`.

### Retired

The ChatGPT-site handoff (`browser.mjs` mint/redeem, the hard-coded `*.chatgpt.site` origin,
ECDSA-signed `/auth/context`, `/handoff/*` and `/read/*` routes) is not part of the new Worker.
It was never deployed. ChatGPT can later use the same `/mcp` connector if Taylor wants.

## Dependencies

`@cloudflare/workers-oauth-provider`, the MCP server SDK (as in hearthops: `agents` for
`createMcpHandler`, or `@modelcontextprotocol/sdk`), `jose`, `zod`. All MIT or Apache-2.0 (the `@modelcontextprotocol/*` packages are Apache-2.0). Pin exact versions
matching hearthops where possible. This adds the repo's first `package.json`.

## Cloudflare changes this will need (each needs Taylor's approval at the time)

- A KV namespace for OAuth grants.
- An Access application on `/authorize` and `/setup/*`, allowing only Taylor's email.
- Whether Access can protect the existing `*.workers.dev` hostname, or a custom hostname is needed.
  A custom hostname goes through the `cloudflare-dns` OpenTofu repo, never by hand.
- Worker secrets set by Taylor: YNAB client id and secret, vault key. Verified for presence only.
- Redeploying the Worker (currently the disabled probe).

## Gates before live use

The owner's manual steps are in `mcp/SETUP.md`. The gates are:

1. All tests pass against fictional fixtures, including the write-containment tests below.
2. Independent review (Terra and Claude Code, per AGENTS.md) of the final revision.
3. Taylor registers the YNAB OAuth app with the exact callback and **full access**, and provisions
   secrets himself.
4. Live write check on a throwaway YNAB plan Taylor creates (not the real budget): PATCH with
   only `id`, `category_id`, `approved` leaves memo, cleared, flag and payee unchanged; split and
   transfer refusals hold.
5. Only then pin the real plan.

## Tests (fictional data only, `node --test`)

- The tool list is exactly the six tools above, with the stated scopes and annotations.
- A read-scope grant cannot call `categorize_transactions`.
- Across every tool, the mock fetcher sees only GETs plus the one PATCH path, and every PATCH body
  has only `id`, `category_id` and `approved: true`.
- Changed, split, transfer, deleted, hidden-category and credit-card-payment cases are skipped
  without a PATCH.
- An unexpected PATCH response is reported as `uncertain`.
- Tool output never contains the fictional token, client secret or vault key.
- `/authorize` and `/setup/*` reject requests without a valid owner Access JWT.
- The existing 35 tests still pass, or are retired along with the ChatGPT-site path and say so.

## Calls made after the builder check (Claude's calls, 2026-11-19; Taylor can override)

- **Hostname and names.** `ORIGIN` (and so the YNAB callback) becomes a configured var, not a
  constant. Callback, `/setup/*` and origin checks accept only that origin. The real connector gets
  a new Worker and a new D1 database, not the `ynab-private-bridge-mock` ones, so real tokens never
  share a database with fictional test rows. The probe stays as it is. The hostname (workers.dev
  with Access, or a custom domain through `cloudflare-dns`) is Taylor's choice at deploy time and
  must be settled before the YNAB app registration.
- **End-to-end before YNAB.** No fictional-YNAB mode in production code. After the first approved
  deploy, Taylor connects claude.ai with YNAB still unconnected. That exercises Access, Claude
  OAuth, scopes and the tool list, and every YNAB tool returns `not_connected`. Real YNAB starts at
  gate 3.
- **`/setup/*` authority.** Verify the Access JWT on every `/setup/*` request (Access sends it on
  each one) and keep CSRF on every POST form. The handoff-minted session, ECDSA signing, nonces and
  the `publicKey` and `writesEnabled === false` requirements in `enabled()` go away with the
  ChatGPT-site path. Tests tied only to those are retired, and the commit says which.
- **Token contention and reconnects.** Each tool call acquires the YNAB token once, before any
  provider call. A held refresh lease returns a retryable `busy` error. An expired or revoked grant
  returns `reconnect_needed`. `categorize_transactions` sends its PATCH only after every
  precheck succeeds, so a failure never leaves a half-written batch.
- **Transaction lists.** YNAB has no limit parameter, so `limit` truncates on the Worker: newest
  first, with a `more_available` flag. The default window is 14 days (not 30). The response cap is
  2 MiB; over that, the tool fails with `narrow_dates`. The Free plan's CPU limit for parsing large
  responses is checked in tests on a large fixture.
- **Refusal rules, fail closed:**
  - Transfer: `transfer_account_id` is set.
  - Split: `subtransactions` is non-empty, or the category name is "Split".
  - Disallowed target category: any internal category except "Inflow: Ready to Assign", which is
    allowed so income can be categorized. Also any category in the "Credit Card Payments" group, or
    any hidden or deleted category.
  - Any shape the code doesn't recognize is skipped with reason `unsupported`.
- **Code style.** Extend the existing `.mjs` in place without restyling it, and keep `node --test`
  unless the OAuth provider forces another runner.

## Left to the builder

- TypeScript or plain `.mjs`. The repo is plain ESM with `node:test`; hearthops is TypeScript with
  vitest.
- How to run `workers-oauth-provider` under tests (hearthops uses the Cloudflare vitest plugin).
- The exact structure of tool output, within the fields listed above.
- Whether `/setup/*` reuses `router.mjs` or gets a small new module.
