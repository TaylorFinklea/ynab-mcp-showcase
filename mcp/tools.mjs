import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { listPlans, monthCategories, monthReport } from "../local-readonly/read.mjs";
import { listCategories, listReview } from "../local-readonly/review.mjs";
import { categorize } from "../local-readonly/categorize.mjs";

export const SCOPE_READ = "ynab:read";
export const SCOPE_CATEGORIZE = "ynab:categorize";

const OWNER = "owner";
const MONTH = /^\d{4}-(0[1-9]|1[0-2])-01$/;

const MESSAGES = {
  not_configured: "This connector is not set up yet.",
  not_connected: "YNAB is not connected. Connect it on the setup page.",
  reconnect_needed: "YNAB access has expired or was revoked. Reconnect YNAB on the setup page.",
  plan_not_pinned: "No budget plan is pinned yet. Pin a plan on the setup page.",
  busy: "YNAB access is being refreshed. Try again in a moment.",
  rate_limited: "YNAB is rate limiting requests. Try again later.",
  narrow_dates: "Too many transactions. Use a later since_date.",
  invalid_month: "Use the first day of the month, like 2026-11-01.",
  invalid_input: "The input was not valid.",
  not_found: "Nothing was found for that request.",
  retry: "The connection changed during the request. Try again.",
  forbidden: "This connection is read-only. Reconnect and allow categorizing.",
  request_rejected: "The request could not be completed."
};

const CODES = {
  not_authorized: "not_connected",
  reauthorization_required: "reconnect_needed",
  plan_not_pinned: "plan_not_pinned",
  refresh_in_progress: "busy",
  rate_limited: "rate_limited",
  narrow_dates: "narrow_dates",
  too_large: "narrow_dates",
  invalid_month: "invalid_month",
  invalid_items: "invalid_input",
  invalid_type: "invalid_input",
  invalid_limit: "invalid_input",
  invalid_since_date: "invalid_input",
  not_found: "not_found",
  connection_changed: "retry",
  authorization_changed: "retry",
  forbidden: "forbidden"
};

function ok(output) {
  return { structuredContent: output, content: [{ type: "text", text: JSON.stringify(output) }] };
}

function fail(error) {
  const output = { error, message: MESSAGES[error] };
  return { isError: true, structuredContent: output, content: [{ type: "text", text: JSON.stringify(output) }] };
}

// Maps a thrown error to a fixed code. The thrown text is never echoed.
const failFrom = (e) => fail(CODES[e?.message] ?? "request_rejected");

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false };
// SDK-facing inputs are deliberately loose so that every bad input reaches our handler and
// returns the fixed invalid_input code. The real types are enforced by parse() below.
const monthInput = z.unknown().optional().describe("Required string: the first day of the month, like 2026-11-01.");
const monthSchema = z.object({ month: z.string() });
const reportSchema = monthSchema.extend({ category_id: z.string().optional() });
const reviewSchema = z.object({
  type: z.enum(["uncategorized", "unapproved"]),
  since_date: z.string().optional(),
  limit: z.number().int().optional()
});
const itemsSchema = z.object({ items: z.array(z.unknown()) });

function parse(schema, args) {
  const result = schema.safeParse(args);
  if (!result.success) throw Error("invalid_items");
  return result.data;
}

export function buildServer(env, scopes, { fetcher = fetch, clock = Date.now } = {}) {
  const server = new McpServer({ name: "ynab", version: "0.1.0" });
  const canCategorize = scopes.includes(SCOPE_CATEGORIZE);

  // Reads the epoch fresh for every call and runs fn with the proof.
  const guarded = (fn) => async (args) => {
    if (env === null) return fail("not_configured");
    try {
      const proof = { epoch: await env.store.epoch(OWNER) };
      return ok(await fn(args ?? {}, proof, clock()));
    } catch (e) {
      // core access() reports a missing row as reauthorization_required; tell the two cases apart.
      if (e?.message === "reauthorization_required") {
        try { if (!(await env.store.connection(OWNER))) return fail("not_connected"); } catch { /* fall through */ }
      }
      return failFrom(e);
    }
  };

  const requireMonth = (month) => {
    if (typeof month !== "string" || !MONTH.test(month)) throw Error("invalid_month");
  };

  server.registerTool("get_connection", {
    description: "Show whether YNAB is connected and which budget plan is pinned, with its name and currency format.",
    inputSchema: z.object({}),
    annotations: READ_ONLY
  }, async () => {
    if (env === null) return fail("not_configured");
    try {
      const row = await env.store.connection(OWNER);
      if (!row || row.status === "authorizing") return ok({ connected: false, status: "not_connected" });
      if (row.status === "reauthorization_required") return ok({ connected: false, status: "reconnect_needed" });
      if (row.status === "refreshing") return clock() < row.lease ? fail("busy") : ok({ connected: false, status: "reconnect_needed" });
      const pinned = typeof row.plan_id === "string" && row.plan_id !== "" && row.status === "ready";
      if (!pinned) return ok({ connected: true, planPinned: false });
      const proof = { epoch: await env.store.epoch(OWNER) };
      const { plans } = await listPlans(OWNER, env, fetcher, clock(), proof);
      const plan = plans.find((p) => p.id === row.plan_id);
      return ok({ connected: true, planPinned: true, plan: { id: row.plan_id, name: plan?.name ?? null, currencyFormat: plan?.currencyFormat ?? null } });
    } catch (e) {
      if (e?.message === "reauthorization_required") return ok({ connected: false, status: "reconnect_needed" });
      return failFrom(e);
    }
  });

  server.registerTool("get_month_summary", {
    description: "Assigned, activity and available amounts per category for one month, in milliunits plus formatted strings.",
    inputSchema: z.object({ month: monthInput }),
    annotations: READ_ONLY
  }, guarded(async (args, proof, now) => {
    const { month } = parse(monthSchema, args);
    requireMonth(month);
    return monthCategories(OWNER, env, month, fetcher, now, proof);
  }));

  server.registerTool("get_budget_report", {
    description: "Per-category budget status for a month: assigned, net spent, available, target progress. Status is over budget for a negative balance, otherwise unknown. Optionally narrow to one category.",
    inputSchema: z.object({ month: monthInput, category_id: z.unknown().optional().describe("Optional string: return only this category's row.") }),
    annotations: READ_ONLY
  }, guarded(async (args, proof, now) => {
    const { month, category_id } = parse(reportSchema, args);
    requireMonth(month);
    const report = await monthReport(OWNER, env, month, fetcher, now, proof, {});
    if (category_id === undefined) return report;
    const rows = report.rows.filter((r) => r.id === category_id);
    if (rows.length === 0) throw Error("not_found");
    return { ...report, rows };
  }));

  server.registerTool("list_categories", {
    description: "List the pinned plan's category groups and categories with ids, hidden and deleted flags, and whether each can be used by categorize_transactions.",
    inputSchema: z.object({}),
    annotations: READ_ONLY
  }, guarded((_args, proof, now) => listCategories(OWNER, env, fetcher, now, proof)));

  server.registerTool("list_transactions_to_review", {
    description: "List transactions that need review: type is uncategorized or unapproved. since_date defaults to 14 days back; limit defaults to 50 (max 200). Newest first.",
    inputSchema: z.object({
      type: z.unknown().optional().describe("Required string: uncategorized or unapproved."),
      since_date: z.unknown().optional().describe("Optional string: YYYY-MM-DD."),
      limit: z.unknown().optional().describe("Optional integer from 1 to 200.")
    }),
    annotations: READ_ONLY
  }, guarded((args, proof, now) => {
    const { type, since_date, limit } = parse(reviewSchema, args);
    return listReview(OWNER, env, { type, sinceDate: since_date, ...(limit === undefined ? {} : { limit }) }, fetcher, now, proof);
  }));

  server.registerTool("categorize_transactions", {
    description: "Set the category of 1 to 10 transactions and mark them approved. Each item needs transaction_id, category_id and expected (category_id, approved, amount, date, account_id as last shown by list_transactions_to_review). Items that changed since then are skipped, not written.",
    inputSchema: z.object({ items: z.unknown().optional().describe("Required array of 1 to 10 items.") }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ items }) => {
    if (!canCategorize) return fail("forbidden");
    return guarded((args, proof, now) => categorize(OWNER, env, parse(itemsSchema, args).items, fetcher, now, proof))({ items });
  });

  return server;
}
