# YNAB connector setup

Deployed and checked live on 2026-11-19; see "Live verification" at the end. You do every step that touches an account; nothing below is automated. Design and gates: `.docs/ai/decision-mcp.md`.

The `ynab-mcp` Worker lets Duet (Claude) read your YNAB budget and, if you allow it, categorize and approve transactions. The YNAB token it stores has **full access** (YNAB offers only read-only or full access); the only limit is this Worker's code. Use a new D1 database, never the `ynab-private-bridge-mock` one, so real tokens never share a database with test rows.

Your deploy config lives in `mcp/wrangler.json`, which Git ignores so your hostname, email and Access details stay out of the repository. Create it with `cp mcp/wrangler.example.json mcp/wrangler.json`; its placeholders read `REPLACE_AT_DEPLOY` or use `example.com`. Fill them in on your machine; do not paste secrets anywhere.

1. **You do this: choose the hostname.** Either a `workers.dev` hostname (if Cloudflare Access can protect it; then set `"workers_dev": true` in `mcp/wrangler.json`, which ships as `false`, and delete the example `routes` entry) or a custom domain (add a route or custom domain for it in `mcp/wrangler.json`), which goes through the `cloudflare-dns` OpenTofu repo, never by hand. Settle this before step 8, because the YNAB callback depends on it. Write it down as `<origin>` (for example `https://host.example`, no trailing slash).
2. **You do this: create the D1 database and the KV namespace.** Name the database `ynab-mcp`; the KV name is up to you. Note the D1 `database_id` and the KV `id`.
3. **You do this: apply the schema.** Run `migrations/0001_init.sql` against the new D1 database (`npx wrangler d1 migrations apply ynab-mcp --remote -c mcp/wrangler.json` once the config has the `database_id`, or the dashboard console). The `-c` matters: without it wrangler reads the root probe config.
4. **You do this: create the Access application.** Zero Trust, Access, Applications, Self-hosted. Cover only the paths `/authorize` and `/setup` (and `/setup/*`) on the hostname. Policy: Allow, include Emails equal to your email. Copy the application's AUD tag. Do not protect the whole hostname: Claude's servers call `/token`, `/register` and `/mcp` without a browser, and YNAB calls `/oauth/callback`.
5. **You do this: fill in `mcp/wrangler.json`** (copied from `mcp/wrangler.example.json`). Set the D1 `database_id`, the KV `id`, `PUBLIC_ORIGIN` (= `<origin>`), the custom-domain route `pattern` (if you chose one), `OWNER_EMAIL`, `ACCESS_TEAM_DOMAIN` (like `https://yourteam.cloudflareaccess.com`) and `ACCESS_AUD`. Leave `ALLOWED_REDIRECT_HOSTS` as `claude.ai,claude.com`.
6. **You do this: approve the deploy.** Run `npm ci && npm test`, then `npx wrangler deploy -c mcp/wrangler.json`. `compatibility_date` here and in `vitest.config.mjs` are kept equal; bump both together only after upgrading wrangler/workerd and re-running `npm test`. Check that `<origin>/` answers, that `<origin>/setup` shows the Access login in a private window, and that `POST <origin>/mcp` without a token is 401.
7. **You do this: connect claude.ai with YNAB not yet connected.** In claude.ai's plugins page, Add, Add custom connector, URL `<origin>/mcp`. The URL must end in `/mcp`: with the bare origin, claude.ai sends MCP requests to `/`, which only returns a text page, and it reports a connection error after sign-in. Sign in through Access and approve on the consent page (leave "Categorize and approve transactions" unchecked for now). Ask Duet for the connection status: expect `not_configured`, because the YNAB secrets come in step 9. Every other YNAB tool returns the same at this point; that is expected.
8. **You do this: register the YNAB OAuth app.** In YNAB Developer Settings, create an OAuth application with the redirect URI exactly `<origin>/oauth/callback` and full access. Review YNAB's terms yourself.
9. **You do this: set the secrets** `YNAB_CLIENT_ID`, `YNAB_CLIENT_SECRET` and `VAULT_KEY` in Cloudflare's secret settings (dashboard, or `npx wrangler secret put NAME -c mcp/wrangler.json`). `VAULT_KEY` is 32 random bytes, base64url-encoded. Never type them into chat or commit them. Then open `<origin>/setup`, choose Connect YNAB and authorize on YNAB.
10. **You do this: set `categorize_transactions` to "Needs approval"** in claude.ai's connector tool permissions. That prompt is your confirmation step for every write. Use Manual mode for chats where Duet categorizes: in Auto mode claude.ai may run the tool without asking. Do this before categorizing is ever allowed, so the first write is already gated.
11. **You do this: run the live write check on a throwaway plan.** Create a throwaway YNAB plan (not your real budget), pin it on the setup page, then categorize a few throwaway transactions through Duet. Allow categorizing for this check (reconnect Claude if needed), and use Manual mode so the approval prompt shows. Confirm:
    - (a) A categorize PATCH leaves memo, cleared, flag and payee unchanged.
    - (b) Whether YNAB transactions carry `amount_formatted`. The review list's `amountFormatted` is `null` if they do not.
    - (c) The CPU time of `list_transactions_to_review` on a real-size list stays under the Free plan's 10 ms. Local measurement was about 5 ms for a 1.9 MiB fixture.
    - Also that splits and transfers are refused.
12. **You do this: pin the real plan.** On the setup page choose Disconnect, then Connect YNAB again and pin your real plan. Disconnect removes only the local copy of the token; also revoke the app in YNAB's Authorized Applications.

## Turning it off

Disconnect on `<origin>/setup`, remove the connector in claude.ai, revoke the app in YNAB, and/or delete the Worker. To revoke every Claude grant, delete and recreate the KV namespace.

`/register` is open (dynamic client registration), so stray client records can accumulate in KV. Deleting and recreating the KV namespace clears them along with all grants. claude.ai connects with dynamic client registration; client ID metadata documents (CIMD) are off by design so the Worker never fetches a client-supplied URL.

## Live verification

Checked on 2026-11-19 against claude.ai and the real budget (Worker version `a7f92eee`). Step 11 was run in part, on one real transaction instead of a throwaway plan: (a) and (b) were checked; (c) only as the Worker-wide figures below; splits and transfers were not tried.

- Access login, the YNAB OAuth exchange, plan pinning and the claude.ai connector (dynamic client registration, consent with categorize) all work.
- Reads work. YNAB transactions carry `amount_formatted`, so `amountFormatted` is filled in; YNAB formats it without a thousands separator (`-$5213.50`).
- One categorize call, approved through the "Needs approval" prompt in Manual mode, returned `updated`. It kept the transaction's existing category, so the check proves the approval write; YNAB showed it approved in that category, with memo, cleared, flag and payee unchanged.
- CPU time across all Worker requests in the session (not `list_transactions_to_review` alone): median 475 µs, P99 8.06 ms, and the dashboard counted 0 requests over the CPU limit. The P99 margin is small, so recheck on a larger review list.
- YNAB marks ordinary groups such as Bills and Expenses `internal`, so a group's `internal` flag no longer refuses its categories; the category's own `internal` flag does. A category in an internal group without an explicit `internal` flag is still refused, and the hidden, deleted and Credit Card Payments refusals are unchanged (see `categoryAllowed`).

Not yet checked live: that splits and transfers are refused (covered by tests only).
