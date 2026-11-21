import { env } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { coreEnv } from "../mcp/core-env.mjs";
import { handleMcp } from "../mcp/handler.mjs";
import { seal } from "../local-readonly/core.mjs";

export const B = "https://api.ynab.com/v1";
export const NOW = Date.now();

export async function resetDb() {
  await env.DB.batch(["connections", "oauth_flows", "owner_epochs"].map((t) => env.DB.prepare("DELETE FROM " + t)));
}

// Seals fictional tokens into a ready, pinned connection row.
export async function seedConnection(workerEnv, { planId = "fictional-plan", status = "ready", pinned = true } = {}) {
  const core = await coreEnv(workerEnv);
  const payload = await seal({ access: "fictional-access", refresh: "fictional-refresh", expires: Date.now() + 3600000 }, core.vaultKey, "tokens:owner");
  await workerEnv.DB.prepare("INSERT INTO connections(owner,id,status,payload,plan_id) VALUES('owner',?,?,?,?)")
    .bind("fictional-connection", status, payload, pinned ? planId : null).run();
}

// Recording fetcher. routes maps "METHOD path" (path after /v1) to a value or function(url, init).
// A number is a bare status, an object is JSON.
export function ynabFetcher(routes) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const method = init.method ?? "GET";
    // Real fetch builds a Request, and workerd rejects init options it does not support (such as redirect: "error").
    new Request(url, init);
    calls.push({ url, method, body: init.body });
    const route = routes[method + " " + String(url).replace(B, "")];
    if (route === undefined) throw Error("unexpected " + method + " " + url);
    const value = typeof route === "function" ? await route(url, init) : route;
    if (value instanceof Response) return value;
    if (typeof value === "number") return new Response("{}", { status: value });
    return Response.json(value);
  };
  fetcher.calls = calls;
  return fetcher;
}

// MCP client over handleMcp. The env defaults to the configured core environment.
export async function connect(scopes, deps, core) {
  const coreEnvValue = core === undefined ? await coreEnv(env) : core;
  const client = new Client({ name: "ynab-mcp-tools-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(init?.headers);
      headers.set("host", new URL(url).host);
      return handleMcp(new Request(input, { ...init, headers }), coreEnvValue, scopes, deps);
    }
  });
  await client.connect(transport);
  return client;
}
