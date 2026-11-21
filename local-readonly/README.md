# YNAB bridge core (local only)

The design and current scope live in `.docs/ai/decision-mcp.md`. The bridge is no longer read-only: it requests full YNAB access (no OAuth scope) and authority is epoch-only. The ChatGPT-site browser path (signed requests, handoffs, browser sessions, router) has been removed. The schema is now `migrations/0001_init.sql`.

All files here are LOCAL ONLY; nothing is deployed. Test keys are ephemeral in-memory mocks and provider responses are fictional.

Official projection references: YNAB live OpenAPI v1.91.0 https://api.ynab.com/papi/open_api_spec.yaml ; targets https://support.ynab.com/how-to-use-targets-rk5kkI9ks ; rollover https://support.ynab.com/en_us/when-the-month-rolls-over-a-guide-rkyyd6qC9 . Sources reviewed by research worker 2026-11-15. All amounts are integer milliunits, not assumed USD. Cash overspending reduces next Ready to Assign; credit overspending becomes debt. Card-payment activity needs explicit role classification to avoid double counting purchases. Multiple provider GETs are NOT an atomic snapshot.

Gates before live use and the owner's deploy steps: `.docs/ai/decision-mcp.md` ("Gates before live use") and `mcp/SETUP.md`. Nothing is activated.
