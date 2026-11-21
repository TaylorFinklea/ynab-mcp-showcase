import { D1Store } from '../local-readonly/d1-store.mjs';

const fromB64url = (s) => Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));

// Builds the core environment from Worker bindings, or null when anything required is missing.
export async function coreEnv(workerEnv) {
  const { YNAB_CLIENT_ID: clientId, YNAB_CLIENT_SECRET: clientSecret, VAULT_KEY, PUBLIC_ORIGIN: origin } = workerEnv ?? {};
  if (!clientId || !clientSecret || !VAULT_KEY || !origin) return null;
  let raw;
  try { raw = fromB64url(VAULT_KEY); } catch { return null; }
  if (raw.length !== 32) return null;
  const vaultKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { enabled: true, owner: 'owner', origin, clientId, clientSecret, vaultKey, store: new D1Store(workerEnv.DB) };
}
