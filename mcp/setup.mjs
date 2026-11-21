import { begin, random } from "../local-readonly/core.mjs";
import { listPlans, selectPlan } from "../local-readonly/read.mjs";
import { isOwner } from "./access.mjs";
import { escapeHtml } from "./consent.mjs";

const OWNER = "owner";
const CSRF_COOKIE = "__Host-ynab-csrf";
const FORM_TYPE = "application/x-www-form-urlencoded";
const MAX_FORM_BYTES = 4096;
// form-action also governs the redirect after the POST, and /setup/connect redirects to YNAB.
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://app.ynab.com; frame-ancestors 'none'; base-uri 'none'";
const BASE_HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };

const plain = (body, status, extra = {}) =>
  new Response(body, { status, headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...extra } });
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { ...BASE_HEADERS, "Content-Type": "application/json" } });

class Reject extends Error {
  constructor(status) { super("rejected"); this.status = status; }
}

async function readForm(request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== FORM_TYPE) throw new Reject(400);
  const reader = request.body?.getReader();
  const parts = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_FORM_BYTES) throw new Reject(400);
        parts.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

function exactKeys(form, keys) {
  const seen = [...form.keys()];
  if (seen.length !== keys.length || keys.some((k) => form.getAll(k).length !== 1)) throw new Reject(400);
}

function csrfCookie(request) {
  const found = (request.headers.get("cookie") ?? "").split(";").map((v) => v.trim()).filter((v) => v.startsWith(CSRF_COOKIE + "="));
  return found.length === 1 ? found[0].slice(CSRF_COOKIE.length + 1) : null;
}

const STATUS_TEXT = {
  authorizing: "Connection in progress or interrupted. Disconnect to start over.",
  authorized_unvalidated: "YNAB authorized. Choose the budget plan to pin.",
  ready: "Connected, plan pinned.",
  refreshing: "Connected, refreshing access.",
  reauthorization_required: "YNAB access expired or was revoked. Disconnect, then connect again."
};

async function page(env, fetcher, clock) {
  const row = await env.store.connection(OWNER);
  const csrf = random();
  const form = (action, body, label) =>
    `<form method="post" action="${action}"><input type="hidden" name="csrf" value="${csrf}">${body}<button>${label}</button></form>`;
  let plans = "";
  if (row?.status === "authorized_unvalidated") {
    let listed = [];
    try { listed = (await listPlans(OWNER, env, fetcher, clock(), { epoch: await env.store.epoch(OWNER) })).plans; } catch { /* Disconnect stays available. */ }
    plans = listed.length
      ? form("/setup/plan", `<select name="planId">${listed.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("")}</select>`, "Pin plan")
      : "<p>Could not list plans. Try again, or disconnect.</p>";
  }
  const body = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>YNAB connector setup</title>
<style>body{font:16px system-ui;max-width:32rem;margin:2rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem;margin:.5rem 0}</style>
<h1>YNAB connector setup</h1>
<p>${row ? escapeHtml(STATUS_TEXT[row.status] ?? "Unknown state.") : "Not connected."}</p>
${row ? "" : form("/setup/connect", "", "Connect YNAB")}
${plans}
${row ? form("/setup/disconnect", "", "Disconnect") : ""}`;
  return new Response(body, {
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": CSP,
      // With no-referrer, browsers send Origin: null on this page's form POSTs and the Origin check rejects them.
      "Referrer-Policy": "same-origin",
      // __Host- cookies must use Path=/.
      "Set-Cookie": `${CSRF_COOKIE}=${csrf}; Path=/; Secure; HttpOnly; SameSite=Strict`
    }
  });
}

// access: { teamDomain, audience, ownerEmail }; env: core environment or null.
export async function handleSetup(request, env, access, deps = {}) {
  const { fetcher = fetch, clock = Date.now, accessKey } = deps;
  if (!(await isOwner(request, access, accessKey))) return plain("Forbidden", 403);
  if (!env) return plain("Not configured.", 503);
  const url = new URL(request.url);

  try {
    if (request.method === "GET" && url.pathname === "/setup") return await page(env, fetcher, clock);
    const routes = { "/setup/connect": ["csrf"], "/setup/plan": ["csrf", "planId"], "/setup/disconnect": ["csrf"] };
    const keys = routes[url.pathname];
    if (request.method !== "POST" || !keys) return plain("Not found", 404);

    if (request.headers.get("origin") !== env.origin) throw new Reject(403);
    const form = await readForm(request);
    exactKeys(form, keys);
    const cookie = csrfCookie(request);
    if (!cookie || form.get("csrf") !== cookie) throw new Reject(403);

    const epoch = await env.store.epoch(OWNER);
    if (url.pathname === "/setup/connect") {
      const start = await begin(OWNER, env, clock(), { epoch });
      return new Response(null, { status: 303, headers: { ...BASE_HEADERS, Location: start.location, "Set-Cookie": start.cookie } });
    }
    if (url.pathname === "/setup/plan") {
      await selectPlan(OWNER, env, form.get("planId"), fetcher, clock(), { epoch });
      return new Response(null, { status: 303, headers: { ...BASE_HEADERS, Location: env.origin + "/setup" } });
    }
    await env.store.disconnect(OWNER);
    return json({ localDisconnected: !(await env.store.connection(OWNER)), providerRevocationVerified: false });
  } catch (error) {
    return plain("Request rejected.", error instanceof Reject ? error.status : 400);
  }
}
