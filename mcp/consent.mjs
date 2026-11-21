import { SCOPE_CATEGORIZE } from "./tools.mjs";

export const escapeHtml = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

// The approval page for /authorize. Reading is always granted; categorizing is an opt-in box that
// starts unchecked. Every string from the client is escaped.
export function consentPage(details, handle) {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Allow ${name}?</title>
<style>body{font:16px system-ui;max-width:32rem;margin:2rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}</style>
<h1>Allow ${name} to use your YNAB budget?</h1>
<p>${origin} Access goes to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
<p><strong>Read your budget</strong>: always granted. It can read categories, budget status and transactions.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <p><label><input type="checkbox" name="scope" value="${SCOPE_CATEGORIZE}"> Categorize and approve transactions</label></p>
  <p><button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></p>
</form>`;
}
