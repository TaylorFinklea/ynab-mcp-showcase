import { OAuthProvider, AuthorizationError, insufficientScope } from "@cloudflare/workers-oauth-provider";
import { callback } from "../local-readonly/core.mjs";
import { isOwner, redirectAllowed } from "./access.mjs";
import { consentPage, escapeHtml } from "./consent.mjs";
import { coreEnv } from "./core-env.mjs";
import { handleMcp } from "./handler.mjs";
import { handleSetup } from "./setup.mjs";
import { SCOPE_CATEGORIZE, SCOPE_READ } from "./tools.mjs";

const OWNER_ID = "owner";
const NOT_ALLOWED = "This connector only signs in to Claude.";

const normalizedOwner = (env) => env.OWNER_EMAIL.trim().toLowerCase();
const accessConfig = (env) => ({ teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD, ownerEmail: normalizedOwner(env) });
const text = (body, status) => new Response(escapeHtml(body), { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

function mcpHandler(options) {
  return {
    async fetch(request, env, ctx) {
      if (ctx.props?.userId !== OWNER_ID) return new Response("Forbidden", { status: 403 });
      if (!ctx.auth.scope.includes(SCOPE_READ)) return insufficientScope(ctx.auth, [SCOPE_READ]);
      return handleMcp(request, await coreEnv(env), ctx.auth.scope, { fetcher: options.fetcher, clock: options.clock });
    }
  };
}

function defaultHandler(options) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === "/") return text("YNAB MCP connector. Add /mcp to Claude as a custom connector.", 200);
      if (url.pathname === "/setup" || url.pathname.startsWith("/setup/")) {
        return handleSetup(request, await coreEnv(env), accessConfig(env), options);
      }
      // No Access check: the flow state and cookie protect the callback.
      if (url.pathname === "/oauth/callback" && request.method === "GET") {
        const core = await coreEnv(env);
        if (!core) return text("Not configured.", 503);
        return callback(request, core, options.fetcher ?? fetch, (options.clock ?? Date.now)());
      }
      if (url.pathname !== "/authorize") return text("Not found", 404);

      if (!(await isOwner(request, accessConfig(env), options.accessKey))) return text("Only the owner can authorize this connector.", 403);

      const oauth = env.OAUTH_PROVIDER;
      const allowedHosts = env.ALLOWED_REDIRECT_HOSTS.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
      try {
        if (request.method === "GET") {
          const authRequest = await oauth.parseAuthRequest(request);
          if (!redirectAllowed(authRequest.redirectUri, allowedHosts)) return text(NOT_ALLOWED, 400);
          const details = await oauth.describeConsent(authRequest);
          const consent = await oauth.beginConsent(authRequest);
          consent.headers.set("Content-Type", "text/html; charset=utf-8");
          // form-action also governs the redirect after the POST, so the allowed redirect hosts must be listed.
          const formTargets = ["'self'", ...allowedHosts.map((h) => `https://${h}`)].join(" ");
          consent.headers.set("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action ${formTargets}; frame-ancestors 'none'`);
          return new Response(consentPage(details, consent.handle), { headers: consent.headers });
        }

        if (request.method === "POST") {
          const form = await request.formData();
          const handle = String(form.get("handle") ?? "");
          if (form.get("decision") !== "approve") {
            const denied = await oauth.denyConsent(request, handle);
            if (!redirectAllowed(denied.request.redirectUri, allowedHosts)) return text(NOT_ALLOWED, 400);
            return new Response(null, { status: 302, headers: denied.headers });
          }
          const picked = form.getAll("scope").map(String);
          const scope = [SCOPE_READ, ...(picked.includes(SCOPE_CATEGORIZE) ? [SCOPE_CATEGORIZE] : [])];
          const approved = await oauth.approveConsent(request, handle, { scope });
          if (!redirectAllowed(approved.request.redirectUri, allowedHosts)) return text(NOT_ALLOWED, 400);
          const { redirectTo } = await oauth.completeAuthorization({
            request: approved.request,
            userId: OWNER_ID,
            metadata: {},
            scope,
            props: { userId: OWNER_ID }
          });
          approved.headers.set("Location", redirectTo);
          return new Response(null, { status: 302, headers: approved.headers });
        }
        return text("Method not allowed", 405);
      } catch (error) {
        if (error instanceof AuthorizationError && error.redirectTo && redirectAllowed(error.redirectTo, allowedHosts)) {
          return Response.redirect(error.redirectTo, 302);
        }
        if (error instanceof AuthorizationError) return text(error.description, 400);
        throw error;
      }
    }
  };
}

function buildProvider(origin, options) {
  return new OAuthProvider({
    apiRoute: "/mcp",
    apiHandler: mcpHandler(options),
    defaultHandler: defaultHandler(options),
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    // openid, email and offline_access are accepted so clients that ask for them aren't refused;
    // they grant nothing. The granted scope always comes from the consent decision.
    scopesSupported: [SCOPE_READ, SCOPE_CATEGORIZE, "openid", "email", "offline_access"],
    requiredScopes: [SCOPE_READ],
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
    clientIdMetadataDocumentEnabled: false,
    accessTokenTTL: 60 * 60
  });
}

// options: { accessKey, fetcher, clock } for tests; production uses the defaults.
export function createYnabMcpWorker(options = {}) {
  // resourceMetadata needs the public origin, which only exists at request time.
  let provider;
  let providerOrigin;
  return {
    fetch(request, env, ctx) {
      if (!provider || providerOrigin !== env.PUBLIC_ORIGIN) {
        provider = buildProvider(env.PUBLIC_ORIGIN, options);
        providerOrigin = env.PUBLIC_ORIGIN;
      }
      // A fresh object per request: the library stores helpers on env.
      return provider.fetch(request, { ...env }, ctx);
    }
  };
}

export default createYnabMcpWorker();
