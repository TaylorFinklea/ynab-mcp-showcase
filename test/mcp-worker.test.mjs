import { createExecutionContext, env } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isOwner, redirectAllowed } from "../mcp/access.mjs";
import { createYnabMcpWorker } from "../mcp/worker.mjs";
import { SCOPE_CATEGORIZE, SCOPE_READ } from "../mcp/tools.mjs";
import { resetDb, seedConnection, ynabFetcher } from "./fixtures.mjs";

const ORIGIN = "https://fictional.example";
const TEAM = "https://unit-test.cloudflareaccess.com";
const AUD = "test-audience";
const OWNER = "owner@example.test";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

let privateKey;
let accessKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  accessKey = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" }] });
});
beforeEach(resetDb);

const accessJwt = (email = OWNER, audience = AUD) =>
  new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(TEAM).setAudience(audience).setIssuedAt().setExpirationTime("5 minutes").sign(privateKey);

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}
const cookiesFrom = (response) => response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

function newWorker(fetcher = ynabFetcher({})) {
  const worker = createYnabMcpWorker({ accessKey, fetcher });
  const fetch = (request) => worker.fetch(request, { ...env }, createExecutionContext());
  return { fetch, fetcher };
}

async function register(fetch) {
  const response = await fetch(new Request(`${ORIGIN}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" })
  }));
  expect(response.status).toBe(201);
  return (await response.json()).client_id;
}

const authorizeUrl = (clientId, challenge) => {
  const url = new URL(`${ORIGIN}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: CALLBACK, scope: "openid email offline_access",
    state: "state-123", code_challenge: challenge, code_challenge_method: "S256", resource: `${ORIGIN}/mcp`
  }).toString();
  return url.toString();
};

async function authorize(fetch, allowCategorize) {
  const clientId = await register(fetch);
  const { verifier, challenge } = await pkce();
  const jwt = await accessJwt();
  const consent = await fetch(new Request(authorizeUrl(clientId, challenge), { headers: { "Cf-Access-Jwt-Assertion": jwt } }));
  expect(consent.status).toBe(200);
  const html = await consent.text();
  expect(html).toContain("Read your budget");
  expect(html).toContain("Categorize and approve transactions");
  expect(html).toMatch(/name="scope" value="ynab:categorize"(?![^>]*checked)/);
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  expect(handle).toBeTruthy();
  const form = new URLSearchParams({ handle, decision: "approve" });
  if (allowCategorize) form.append("scope", SCOPE_CATEGORIZE);
  const approved = await fetch(new Request(`${ORIGIN}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "Cf-Access-Jwt-Assertion": jwt, cookie: cookiesFrom(consent), origin: ORIGIN },
    body: form.toString()
  }));
  expect(approved.status).toBe(302);
  const location = new URL(approved.headers.get("location"));
  expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
  const code = location.searchParams.get("code");
  expect(code).toBeTruthy();
  const token = await fetch(new Request(`${ORIGIN}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier, resource: `${ORIGIN}/mcp` }).toString()
  }));
  expect(token.status).toBe(200);
  return token.json();
}

async function connectClient(fetch, accessToken) {
  const client = new Client({ name: "ynab-mcp-worker-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${accessToken}`);
      headers.set("host", new URL(ORIGIN).host);
      return fetch(new Request(input, { ...init, headers }));
    }
  }));
  return client;
}

const rows = async () => {
  const count = async (table) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM " + table).first()).n;
  return { epochs: await count("owner_epochs"), flows: await count("oauth_flows"), connections: await count("connections") };
};

const withJwt = async (path, init = {}, jwt) => new Request(ORIGIN + path, { ...init, headers: { "Cf-Access-Jwt-Assertion": jwt ?? (await accessJwt()), ...init.headers } });

async function setupPage(fetch) {
  const response = await fetch(await withJwt("/setup"));
  const html = await response.text();
  const cookie = cookiesFrom(response);
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  return { response, html, cookie, csrf };
}

async function setupPost(fetch, path, fields, { cookie, origin = ORIGIN, type = "application/x-www-form-urlencoded", jwt } = {}) {
  return fetch(await withJwt(path, {
    method: "POST",
    headers: { "content-type": type, origin, ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields).toString()
  }, jwt));
}

describe("Access helpers", () => {
  const config = { teamDomain: TEAM, audience: AUD, ownerEmail: OWNER };
  const req = (jwt) => new Request(`${ORIGIN}/authorize`, { headers: jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {} });
  it("isOwner accepts the owner only", async () => {
    expect(await isOwner(req(await accessJwt()), config, accessKey)).toBe(true);
    expect(await isOwner(req(await accessJwt("someone@example.test")), config, accessKey)).toBe(false);
    expect(await isOwner(req(await accessJwt(OWNER, "other")), config, accessKey)).toBe(false);
    expect(await isOwner(req(), config, accessKey)).toBe(false);
  });
  it("redirectAllowed checks https and exact host", () => {
    const hosts = ["claude.ai", "claude.com"];
    expect(redirectAllowed(CALLBACK, hosts)).toBe(true);
    expect(redirectAllowed("http://claude.ai/x", hosts)).toBe(false);
    expect(redirectAllowed("https://claude.ai.evil.example/x", hosts)).toBe(false);
    expect(redirectAllowed("nonsense", hosts)).toBe(false);
  });
});

describe("YNAB MCP worker", () => {
  it("authorize requires owner Access JWT", async () => {
    const { fetch } = newWorker();
    const clientId = await register(fetch);
    const { challenge } = await pkce();
    const url = authorizeUrl(clientId, challenge);
    expect((await fetch(new Request(url))).status).toBe(403);
    expect((await fetch(new Request(url, { headers: { "Cf-Access-Jwt-Assertion": await accessJwt("someone@example.test") } }))).status).toBe(403);
    expect((await fetch(new Request(url, { headers: { "Cf-Access-Jwt-Assertion": await accessJwt(OWNER, "other-audience") } }))).status).toBe(403);
  });

  it("full OAuth flow with read scope lists tools; categorize forbidden", async () => {
    await seedConnection(env);
    const { fetch, fetcher } = newWorker();
    const tokens = await authorize(fetch, false);
    expect(tokens.scope.split(" ")).toEqual([SCOPE_READ]);
    const client = await connectClient(fetch, tokens.access_token);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toHaveLength(6);
      expect(names).toContain("categorize_transactions");
      const r = await client.callTool({ name: "categorize_transactions", arguments: { items: [] } });
      expect(r.isError).toBe(true);
      expect(r.structuredContent.error).toBe("forbidden");
    } finally { await client.close(); }
    expect(fetcher.calls).toEqual([]);
  });

  it("categorize scope granted only when box checked", async () => {
    const { fetch } = newWorker();
    expect((await authorize(fetch, true)).scope.split(" ").sort()).toEqual([SCOPE_CATEGORIZE, SCOPE_READ]);
    expect((await authorize(fetch, false)).scope.split(" ")).toEqual([SCOPE_READ]);
  });

  it("with no connection every tool returns not_connected with zero fetches", async () => {
    const { fetch, fetcher } = newWorker();
    const client = await connectClient(fetch, (await authorize(fetch, true)).access_token);
    try {
      expect((await client.callTool({ name: "get_connection", arguments: {} })).structuredContent).toEqual({ connected: false, status: "not_connected" });
      const calls = [["get_month_summary", { month: "2026-11-01" }], ["list_categories", {}], ["categorize_transactions", { items: [{ transaction_id: "t1", category_id: "cat1", expected: { category_id: null, approved: false, amount: -1000, date: "2026-11-10", account_id: "a1" } }] }]];
      for (const [name, args] of calls) {
        const r = await client.callTool({ name, arguments: args });
        expect(r.isError).toBe(true);
        expect(r.structuredContent.error).toBe("not_connected");
        expect(r.structuredContent.message).toBe("YNAB is not connected. Connect it on the setup page.");
      }
      await seedConnection(env, { status: "reauthorization_required" });
      expect((await client.callTool({ name: "list_categories", arguments: {} })).structuredContent.error).toBe("reconnect_needed");
    } finally { await client.close(); }
    expect(fetcher.calls).toEqual([]);
  });

  it("mcp without bearer is 401; unknown path 404; root 200", async () => {
    const { fetch } = newWorker();
    expect((await fetch(new Request(`${ORIGIN}/mcp`, { method: "POST" }))).status).toBe(401);
    expect((await fetch(new Request(`${ORIGIN}/nope`))).status).toBe(404);
    expect((await fetch(new Request(`${ORIGIN}/`))).status).toBe(200);
  });
});

describe("setup pages", () => {
  it("setup requires Access", async () => {
    const { fetch } = newWorker();
    expect((await fetch(new Request(`${ORIGIN}/setup`))).status).toBe(403);
    expect((await fetch(await withJwt("/setup", {}, await accessJwt("someone@example.test")))).status).toBe(403);
    expect((await fetch(new Request(`${ORIGIN}/setup/connect`, { method: "POST" }))).status).toBe(403);
    expect((await fetch(new Request(`${ORIGIN}/setup/disconnect`, { method: "POST" }))).status).toBe(403);
    expect(await rows()).toEqual({ epochs: 0, flows: 0, connections: 0 });
  });

  it("setup page sets a csrf cookie and embeds the same value", async () => {
    const { fetch } = newWorker();
    const { response, html, csrf } = await setupPage(fetch);
    expect(response.status).toBe(200);
    // form-action also governs the 303 from /setup/connect to YNAB.
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self' https://app.ynab.com;");
    // no-referrer makes browsers send Origin: null on the form POST, which the Origin check rejects.
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(csrf).toBeTruthy();
    const setCookie = response.headers.getSetCookie()[0];
    expect(setCookie).toContain(`__Host-ynab-csrf=${csrf}`);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(html).toContain("Not connected");
  });

  it("setup POST rejects missing csrf, mismatched csrf, wrong Origin and extra form keys with no store change", async () => {
    const { fetch, fetcher } = newWorker();
    const { cookie, csrf } = await setupPage(fetch);
    for (const path of ["/setup/connect", "/setup/disconnect"]) {
      expect((await setupPost(fetch, path, {}, { cookie })).status).toBe(400);
      expect((await setupPost(fetch, path, { csrf: "wrong" }, { cookie })).status).toBe(403);
      expect((await setupPost(fetch, path, { csrf })).status).toBe(403);
      expect((await setupPost(fetch, path, { csrf }, { cookie, origin: "https://evil.example" })).status).toBe(403);
      expect((await setupPost(fetch, path, { csrf, extra: "1" }, { cookie })).status).toBe(400);
      expect((await setupPost(fetch, path, { csrf }, { cookie, type: "application/json" })).status).toBe(400);
      expect((await setupPost(fetch, path, { csrf, pad: "x".repeat(5000) }, { cookie })).status).toBe(400);
    }
    expect((await setupPost(fetch, "/setup/plan", { csrf }, { cookie })).status).toBe(400);
    expect((await setupPost(fetch, "/setup/plan", { csrf, planId: "p", extra: "1" }, { cookie })).status).toBe(400);
    expect(await rows()).toEqual({ epochs: 0, flows: 0, connections: 0 });
    expect(fetcher.calls).toEqual([]);
  });

  it("setup connect redirects to app.ynab.com with configured callback and no scope", async () => {
    const { fetch, fetcher } = newWorker();
    const { cookie, csrf } = await setupPage(fetch);
    const response = await setupPost(fetch, "/setup/connect", { csrf }, { cookie });
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location"));
    expect(`${location.origin}${location.pathname}`).toBe("https://app.ynab.com/oauth/authorize");
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/oauth/callback`);
    expect(location.searchParams.get("client_id")).toBe("fictional-client");
    expect(location.searchParams.has("scope")).toBe(false);
    expect(response.headers.getSetCookie().some((c) => c.startsWith("__Host-ynab-flow="))).toBe(true);
    expect((await rows()).flows).toBe(1);
    expect(fetcher.calls).toEqual([]);
  });

  it("YNAB callback exchanges the code and stores an unvalidated connection", async () => {
    const token = { token_type: "Bearer", access_token: "fictional-access", refresh_token: "fictional-refresh", expires_in: 7200 };
    const { fetch, fetcher } = newWorker(ynabFetcher({ "POST https://app.ynab.com/oauth/token": token }));
    const { cookie, csrf } = await setupPage(fetch);
    const connect = await setupPost(fetch, "/setup/connect", { csrf }, { cookie });
    const state = new URL(connect.headers.get("location")).searchParams.get("state");
    const callback = await fetch(new Request(`${ORIGIN}/oauth/callback?state=${state}&code=fictional-code`, { headers: { cookie: cookiesFrom(connect) } }));
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(`${ORIGIN}/setup`);
    expect(fetcher.calls.map((c) => c.method + " " + c.url)).toEqual(["POST https://app.ynab.com/oauth/token"]);
    const row = await env.DB.prepare("SELECT status FROM connections WHERE owner='owner'").first();
    expect(row).toEqual({ status: "authorized_unvalidated" });
  });

  it("setup connect is refused once a connection exists", async () => {
    await seedConnection(env);
    const { fetch } = newWorker();
    const { cookie, csrf } = await setupPage(fetch);
    const response = await setupPost(fetch, "/setup/connect", { csrf }, { cookie });
    expect(response.status).toBe(400);
    expect((await rows()).flows).toBe(0);
  });

  it("setup plan picker escapes names and pinning goes through selectPlan", async () => {
    await seedConnection(env, { status: "authorized_unvalidated", pinned: false });
    const plans = { data: { plans: [{ id: "fictional-plan", name: "<b>Fictional & Co</b>", currency_format: null }] } };
    const { fetch, fetcher } = newWorker(ynabFetcher({ "GET /plans": plans }));
    const { html, cookie, csrf } = await setupPage(fetch);
    expect(html).toContain("&lt;b&gt;Fictional &amp; Co&lt;/b&gt;");
    expect(html).not.toContain("<b>Fictional");
    expect(html).toContain('name="planId"');
    const response = await setupPost(fetch, "/setup/plan", { csrf, planId: "fictional-plan" }, { cookie });
    expect(response.status).toBe(303);
    const row = await env.DB.prepare("SELECT status, plan_id FROM connections WHERE owner='owner'").first();
    expect(row).toEqual({ status: "ready", plan_id: "fictional-plan" });
    expect(fetcher.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("setup disconnect bumps epoch and clears connection", async () => {
    await seedConnection(env);
    const { fetch } = newWorker();
    const { cookie, csrf } = await setupPage(fetch);
    const response = await setupPost(fetch, "/setup/disconnect", { csrf }, { cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ localDisconnected: true, providerRevocationVerified: false });
    const after = await rows();
    expect(after.connections).toBe(0);
    expect((await env.DB.prepare("SELECT epoch FROM owner_epochs WHERE owner='owner'").first()).epoch).toBe(1);
  });

  it("setup reports not configured without secrets", async () => {
    const worker = createYnabMcpWorker({ accessKey });
    const response = await worker.fetch(await withJwt("/setup"), { ...env, YNAB_CLIENT_SECRET: "" }, createExecutionContext());
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Not configured.");
  });
});

describe("OAuth callback", () => {
  it("callback reachable without Access but rejects without flow cookie", async () => {
    const { fetch, fetcher } = newWorker();
    const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const response = await fetch(new Request(`${ORIGIN}/oauth/callback?state=${state}&code=fictional-code`));
    expect(response.status).toBe(400);
    expect(fetcher.calls).toEqual([]);
  });

  it("callback on a different origin is rejected with no fetch and leaves the flow", async () => {
    const { fetch, fetcher } = newWorker();
    const { cookie, csrf } = await setupPage(fetch);
    const started = await setupPost(fetch, "/setup/connect", { csrf }, { cookie });
    const state = new URL(started.headers.get("location")).searchParams.get("state");
    const flowCookie = started.headers.getSetCookie()[0].split(";")[0];
    const response = await fetch(new Request(`https://other.example/oauth/callback?state=${state}&code=fictional-code`, { headers: { cookie: flowCookie } }));
    expect(response.status).toBe(400);
    expect(fetcher.calls).toEqual([]);
    expect((await rows()).flows).toBe(1);
  });
});

describe("open registration controls", () => {
  const EVIL = "https://evil.example/cb";
  async function registerWith(fetch, extra) {
    const response = await fetch(new Request(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none", ...extra })
    }));
    expect(response.status).toBe(201);
    return (await response.json()).client_id;
  }
  const authUrl = (clientId, challenge, redirect) => authorizeUrl(clientId, challenge).replace(encodeURIComponent(CALLBACK), encodeURIComponent(redirect));
  const noEvilLocation = (response) => expect(response.headers.get("location") ?? "").not.toContain("evil.example");

  it("GET /authorize for a hostile redirect_uri is refused with no redirect", async () => {
    const { fetch } = newWorker();
    const clientId = await registerWith(fetch, { redirect_uris: [EVIL] });
    const { challenge } = await pkce();
    const response = await fetch(new Request(authUrl(clientId, challenge, EVIL), { headers: { "Cf-Access-Jwt-Assertion": await accessJwt() } }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    noEvilLocation(response);
  });

  it("POST /authorize approve and deny for a hostile redirect_uri never redirect there", async () => {
    // Obtain a valid handle for the allowed client, then register-hostile flows are exercised via a second client.
    const { fetch } = newWorker();
    const jwt = await accessJwt();
    // The consent page itself is refused for the hostile client, so a handle cannot be minted; a forged handle must also fail.
    const clientId = await registerWith(fetch, { redirect_uris: [EVIL] });
    const { challenge } = await pkce();
    const consent = await fetch(new Request(authUrl(clientId, challenge, EVIL), { headers: { "Cf-Access-Jwt-Assertion": jwt } }));
    expect(consent.status).toBeGreaterThanOrEqual(400);
    for (const decision of ["approve", "deny"]) {
      const response = await fetch(new Request(`${ORIGIN}/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "Cf-Access-Jwt-Assertion": jwt, origin: ORIGIN },
        body: new URLSearchParams({ handle: "forged-handle", decision }).toString()
      }));
      expect(response.status).toBeGreaterThanOrEqual(400);
      noEvilLocation(response);
    }
  });

  it("POST /authorize without an Access JWT is 403", async () => {
    const { fetch } = newWorker();
    const response = await fetch(new Request(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      body: new URLSearchParams({ handle: "x", decision: "approve" }).toString()
    }));
    expect(response.status).toBe(403);
  });

  it("deny redirects only to an allowed host", async () => {
    const { fetch } = newWorker();
    const clientId = await register(fetch);
    const { challenge } = await pkce();
    const jwt = await accessJwt();
    const consent = await fetch(new Request(authorizeUrl(clientId, challenge), { headers: { "Cf-Access-Jwt-Assertion": jwt } }));
    const handle = (await consent.text()).match(/name="handle" value="([^"]+)"/)?.[1];
    const denied = await fetch(new Request(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "Cf-Access-Jwt-Assertion": jwt, cookie: cookiesFrom(consent), origin: ORIGIN },
      body: new URLSearchParams({ handle, decision: "deny" }).toString()
    }));
    expect(denied.status).toBe(302);
    expect(new URL(denied.headers.get("location")).host).toBe("claude.ai");
  });

  it("a hostile client_name is escaped on the consent page", async () => {
    const { fetch } = newWorker();
    const clientId = await registerWith(fetch, { client_name: "<script>alert(1)</script>" });
    const { challenge } = await pkce();
    const consent = await fetch(new Request(authorizeUrl(clientId, challenge), { headers: { "Cf-Access-Jwt-Assertion": await accessJwt() } }));
    expect(consent.status).toBe(200);
    const html = await consent.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("a URL-shaped client_id causes no outbound fetch", async () => {
    const { fetch } = newWorker();
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (...args) => { calls.push(String(args[0]?.url ?? args[0])); return new Response("{}", { status: 404 }); };
    try {
      const { challenge } = await pkce();
      const response = await fetch(new Request(authorizeUrl("https://cimd.example/client.json", challenge), { headers: { "Cf-Access-Jwt-Assertion": await accessJwt() } }));
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(calls.filter((u) => u.includes("cimd.example"))).toEqual([]);
    } finally {
      globalThis.fetch = real;
    }
  });
});
