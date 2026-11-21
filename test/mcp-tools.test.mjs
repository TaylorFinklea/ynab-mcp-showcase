import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { B, connect, resetDb, seedConnection, ynabFetcher } from "./fixtures.mjs";
import { SCOPE_CATEGORIZE, SCOPE_READ } from "../mcp/tools.mjs";

const READ = [SCOPE_READ];
const ALL = [SCOPE_READ, SCOPE_CATEGORIZE];
const P = "/plans/fictional-plan";

const cat = (id, name, extra = {}) => ({ id, name, category_group_id: "g1", budgeted: 100000, activity: -40000, balance: 60000, ...extra });
const month = (m, categories) => ({ data: { month: { month: m, categories } } });
const groups = { data: { category_groups: [{ id: "g1", name: "Bills", categories: [{ id: "cat1", name: "Rent" }, { id: "cat2", name: "Food" }] }] } };
const plans = { data: { plans: [{ id: "fictional-plan", name: "Fictional Budget", currency_format: { iso_code: "USD", decimal_digits: 2, decimal_separator: ".", symbol_first: true, group_separator: ",", currency_symbol: "$", display_symbol: true } }] } };
const tx = (id, extra = {}) => ({ id, date: "2026-11-10", amount: -1000, account_id: "a1", category_id: null, approved: false, ...extra });
const expected = { category_id: null, approved: false, amount: -1000, date: "2026-11-10", account_id: "a1" };

const reportRoutes = () => ({
  ["GET " + P + "/months/2026-11-01"]: month("2026-11-01", [cat("cat1", "Rent"), cat("cat2", "Food", { balance: -5 })]),
  ["GET " + P + "/months/2026-10-01"]: month("2026-10-01", [cat("cat1", "Rent"), cat("cat2", "Food")]),
  ["GET " + P + "/categories"]: groups
});

const call = async (client, name, args = {}) => client.callTool({ name, arguments: args });
async function withClient(scopes, fetcher, fn, core) {
  const client = await connect(scopes, { fetcher }, core);
  try { return await fn(client); } finally { await client.close(); }
}

beforeEach(resetDb);

describe("YNAB MCP tools", () => {
  it("lists exactly six tools with annotations", async () => {
    await withClient(ALL, ynabFetcher({}), async (client) => {
      const tools = (await client.listTools()).tools;
      expect(tools.map((t) => t.name).sort()).toEqual(["categorize_transactions", "get_budget_report", "get_connection", "get_month_summary", "list_categories", "list_transactions_to_review"]);
      for (const t of tools) {
        if (t.name === "categorize_transactions") expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
        else expect(t.annotations.readOnlyHint).toBe(true);
      }
    });
  });

  it("read scope cannot categorize and makes no call", async () => {
    await seedConnection(env);
    const f = ynabFetcher({});
    await withClient(READ, f, async (client) => {
      const r = await call(client, "categorize_transactions", { items: [{ transaction_id: "t1", category_id: "cat1", expected }] });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toEqual({ error: "forbidden", message: "This connection is read-only. Reconnect and allow categorizing." });
    });
    expect(f.calls).toEqual([]);
    expect(await env.DB.prepare("SELECT epoch FROM owner_epochs").all().then((x) => x.results)).toEqual([]);
  });

  it("missing secrets give not_configured", async () => {
    const f = ynabFetcher({});
    await withClient(ALL, f, async (client) => {
      for (const name of ["get_connection", "list_categories"]) {
        const r = await call(client, name);
        expect(r.isError).toBe(true);
        expect(r.structuredContent.error).toBe("not_configured");
      }
      const r = await call(client, "categorize_transactions", { items: [] });
      expect(r.structuredContent.error).toBe("not_configured");
    }, null);
    expect(f.calls).toEqual([]);
    const { coreEnv } = await import("../mcp/core-env.mjs");
    expect(await coreEnv({ ...env, YNAB_CLIENT_SECRET: "" })).toBeNull();
    expect(await coreEnv({ ...env, VAULT_KEY: "short" })).toBeNull();
    expect(await coreEnv({ ...env, PUBLIC_ORIGIN: undefined })).toBeNull();
    expect((await coreEnv(env)).owner).toBe("owner");
  });

  it("get_connection states", async () => {
    const f = ynabFetcher({ ["GET /plans"]: plans });
    await withClient(READ, f, async (client) => {
      expect((await call(client, "get_connection")).structuredContent).toEqual({ connected: false, status: "not_connected" });

      await seedConnection(env, { status: "reauthorization_required" });
      expect((await call(client, "get_connection")).structuredContent).toEqual({ connected: false, status: "reconnect_needed" });

      await resetDb();
      await seedConnection(env, { status: "authorized_unvalidated", pinned: false });
      expect((await call(client, "get_connection")).structuredContent).toEqual({ connected: true, planPinned: false });
      expect(f.calls).toEqual([]);

      await resetDb();
      await seedConnection(env);
      const r = (await call(client, "get_connection")).structuredContent;
      expect(r).toMatchObject({ connected: true, planPinned: true, plan: { id: "fictional-plan", name: "Fictional Budget", currencyFormat: { iso_code: "USD" } } });
    });
  });

  it.each(["2026-11", "November 2026", "2026-11-15", "2026-13-01"])("month format %s rejected with zero calls", async (bad) => {
    await seedConnection(env);
    const f = ynabFetcher({});
    await withClient(READ, f, async (client) => {
      for (const name of ["get_month_summary", "get_budget_report"]) {
        const r = await call(client, name, { month: bad });
        expect(r.isError).toBe(true);
        expect(r.structuredContent).toEqual({ error: "invalid_month", message: "Use the first day of the month, like 2026-11-01." });
      }
    });
    expect(f.calls).toEqual([]);
  });

  it.each([
    ["get_month_summary", {}],
    ["get_month_summary", { month: 202611 }],
    ["get_budget_report", {}],
    ["get_budget_report", { month: "2026-11-01", category_id: 5 }],
    ["list_transactions_to_review", { type: "unapproved", limit: "ten" }],
    ["list_transactions_to_review", { type: "all" }],
    ["list_transactions_to_review", {}],
    ["categorize_transactions", { items: "x" }],
    ["categorize_transactions", {}]
  ])("%s with mistyped input %j returns invalid_input with zero calls", async (name, args) => {
    await seedConnection(env);
    const f = ynabFetcher({});
    await withClient(ALL, f, async (client) => {
      const r = await call(client, name, args);
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toEqual({ error: "invalid_input", message: "The input was not valid." });
    });
    expect(f.calls).toEqual([]);
  });

  it("budget report filters by category and 404s unknown", async () => {
    await seedConnection(env);
    await withClient(READ, ynabFetcher(reportRoutes()), async (client) => {
      const all = (await call(client, "get_budget_report", { month: "2026-11-01" })).structuredContent;
      expect(all.rows.map((r) => r.id)).toEqual(["cat1", "cat2"]);
      const one = (await call(client, "get_budget_report", { month: "2026-11-01", category_id: "cat2" })).structuredContent;
      expect(one.rows.map((r) => r.id)).toEqual(["cat2"]);
      const missing = await call(client, "get_budget_report", { month: "2026-11-01", category_id: "nope" });
      expect(missing.isError).toBe(true);
      expect(missing.structuredContent.error).toBe("not_found");
    });
  });

  it("categorize through MCP updates and approves", async () => {
    await seedConnection(env);
    const f = ynabFetcher({
      ["GET " + P + "/categories"]: groups,
      ["GET " + P + "/transactions/t1"]: { data: { transaction: tx("t1") } },
      ["PATCH " + P + "/transactions"]: (url, init) => ({ data: { transactions: JSON.parse(init.body).transactions } })
    });
    await withClient(ALL, f, async (client) => {
      const r = await call(client, "categorize_transactions", { items: [{ transaction_id: "t1", category_id: "cat1", expected }] });
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toEqual({ planId: "fictional-plan", results: [{ transactionId: "t1", outcome: "updated" }] });
      const bad = await call(client, "categorize_transactions", { items: [] });
      expect(bad.structuredContent.error).toBe("invalid_input");
    });
    const patch = f.calls.filter((c) => c.method === "PATCH");
    expect(patch.length).toBe(1);
    expect(JSON.parse(patch[0].body)).toEqual({ transactions: [{ id: "t1", category_id: "cat1", approved: true }] });
  });

  it("refresh_in_progress maps to busy", async () => {
    await seedConnection(env);
    await env.DB.prepare("UPDATE connections SET status='refreshing', lease=? WHERE owner='owner'").bind(Date.now() + 60000).run();
    const f = ynabFetcher({});
    await withClient(ALL, f, async (client) => {
      for (const [name, args] of [["list_categories", {}], ["get_connection", {}]]) {
        const r = await call(client, name, args);
        expect(r.isError).toBe(true);
        expect(r.structuredContent).toEqual({ error: "busy", message: "YNAB access is being refreshed. Try again in a moment." });
      }
    });
    expect(f.calls).toEqual([]);
  });

  it("unlisted failures become request_rejected without echoing text", async () => {
    await seedConnection(env);
    const f = ynabFetcher({ ["GET " + P + "/categories"]: () => { throw Error("fictional-secret-detail"); } });
    await withClient(READ, f, async (client) => {
      const r = await call(client, "list_categories");
      expect(r.structuredContent).toEqual({ error: "request_rejected", message: "The request could not be completed." });
      expect(JSON.stringify(r)).not.toContain("fictional-secret-detail");
    });
  });

  it("no output contains secrets", async () => {
    await seedConnection(env);
    const f = ynabFetcher({
      ["GET /plans"]: plans,
      ...reportRoutes(),
      ["GET " + P + "/transactions?type=unapproved&since_date=" + new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10)]: { data: { transactions: [tx("t1")] } },
      ["GET " + P + "/transactions/t1"]: { data: { transaction: tx("t1") } },
      ["PATCH " + P + "/transactions"]: (url, init) => ({ data: { transactions: JSON.parse(init.body).transactions } })
    });
    let out = "";
    await withClient(ALL, f, async (client) => {
      const calls = [
        ["get_connection", {}], ["get_month_summary", { month: "2026-11-01" }], ["get_budget_report", { month: "2026-11-01" }],
        ["list_categories", {}], ["list_transactions_to_review", { type: "unapproved" }],
        ["categorize_transactions", { items: [{ transaction_id: "t1", category_id: "cat1", expected }] }],
        ["list_transactions_to_review", { type: "bogus" }], ["get_budget_report", { month: "bad" }]
      ];
      for (const [name, args] of calls) out += JSON.stringify(await call(client, name, args));
    });
    expect(out).toContain("Fictional Budget");
    expect(out).toContain('"outcome":"updated"');
    for (const secret of ["fictional-access", "fictional-refresh", "fictional-client-secret", env.VAULT_KEY]) expect(out).not.toContain(secret);
    expect(f.calls.every((c) => c.method === "GET" || c.method === "PATCH")).toBe(true);
  });
});
