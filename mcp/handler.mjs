import { createMcpHandler } from "agents/mcp/server";
import { buildServer } from "./tools.mjs";

// env is the core environment from coreEnv(), or null when the connector is not configured.
export async function handleMcp(request, env, scopes, deps = {}) {
  const handler = createMcpHandler(() => buildServer(env, scopes, deps), {
    route: "/mcp",
    legacy: "stateless",
    responseMode: "auto"
  });
  const response = await handler(request, {}, {});
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
