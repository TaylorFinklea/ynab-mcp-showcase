# Actual D1 fictional verification — 2026-11-15 ~03:15–03:17 UTC

Only approved database ynab-private-bridge-mock (4bb94bfa-a8db-4284-a0a3-bb896a87c66e), existing Wrangler authentication. Seven isolated probe_ tables added; original fictional_probe preserved. No production schema migration, real data, secrets, new credentials, Worker deployment, routes, permissions or paid plan changes.

Passed and read back eight CHECK-backed assertions:
- nonce uniqueness
- old epoch rejected
- OAuth flow consumed once
- refresh lock acquired under current epoch
- stale refresh cannot overwrite a reconnected generation
- old browser session cannot create flow
- old browser session cannot pin plan
- old epoch cannot mint handoff

One deliberately failed import inserted fictional-rollback-marker then violated CHECK(passed=1). Import failed as intended; separate read verified marker count0 and prior eight assertions intact. This proves rollback of the tested CLI import transaction, NOT Worker DB.batch JavaScript/result handling.

Actual D1 UPDATE RETURNING returned owner fictional-owner, id new-connection, status ready, payload fictional-refreshed-envelope and plan new-plan after exact conditional update. Two concurrently launched nonce INSERT OR IGNORE commands produced changes1 and changes0, both success. Original fictional_probe readback remained fictional-only/not-connected. Database approximately82KB; fixture state retained for audit.

Worker deployment list unchanged: final version ecf3898d-d7c5-4142-9af5-f93407925fe5, deployed02:54Z. HTTP health explicitly disabled; POST /handoff/mint405. No data/auth endpoint newly exposed.35 independent local tests (including ephemeral in-memory signing keys) passed again; no real OAuth/provider calls.

Remaining: deploy-time D1 binding/batch API compatibility, actual browser/Site signing integration, telemetry privacy and approved secure provisioning. SQL primitive tests do not establish the full authenticated bridge. No live-activation endorsement.

Independent read-only review verified all8 assertions, one concurrent nonce and zero rollback markers with zero writes. SQL fixture scope confirmed probe_ only.
