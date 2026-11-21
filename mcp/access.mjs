import { createRemoteJWKSet, jwtVerify } from "jose";

const jwksCache = new Map();

function remoteJwks(teamDomain) {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain));
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

// True only for the owner's Cloudflare Access token. Access should protect /authorize and /setup;
// this is the second check in case that policy is ever loosened or bypassed.
// config: { teamDomain, audience, ownerEmail }. getKey defaults to the team's remote JWKS.
export async function isOwner(request, config, getKey = remoteJwks(config.teamDomain)) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, getKey, {
      issuer: config.teamDomain.replace(/\/$/, ""),
      audience: config.audience,
      algorithms: ["RS256"]
    });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    return email !== "" && email === config.ownerEmail.trim().toLowerCase();
  } catch {
    return false;
  }
}

// Only these redirect hosts may receive an authorization code.
export function redirectAllowed(redirectUri, allowedHosts) {
  let url;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  return url.protocol === "https:" && allowedHosts.includes(url.hostname.toLowerCase());
}
