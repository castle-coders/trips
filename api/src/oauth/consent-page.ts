/**
 * Consent page HTML for `GET /authorize` (TDD 7.2, PRD 5.3).
 *
 * Plain HTML with inline CSS, no framework, no script. Every string that can come from the
 * client (name, domain, redirect host, scope names) is escaped with `escapeHtml`, because DCR
 * and CIMD let any client choose them (`ConsentDescription` doc comment).
 *
 * Owned by the consent target.
 */
import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { SCOPES_SUPPORTED } from "./provider";
import { escapeHtml, renderPage } from "./http";

/** Plain-language labels for every supported scope (PRD 5.3). */
const SCOPE_LABELS: Readonly<Record<string, string>> = {
  "trips:read": "View your trips, itineraries and expenses",
  "trips:write": "Create and update trips, itineraries and expenses — never delete",
  offline_access: "Stay connected when you are not using the app, e.g. scheduled routines",
};

/** Checked by default. `trips:write` stays unchecked (TDD 13, design default). */
const DEFAULT_CHECKED: ReadonlySet<string> = new Set(["trips:read", "offline_access"]);

/**
 * The scopes the page offers: those the client requested that this server supports, in the
 * server's canonical order, unknown scopes ignored. When the client requested none of them
 * (the `scope` parameter is optional, RFC 6749 3.3), the server's full supported set is offered
 * instead, with the same defaults, so the user can still grant access.
 *
 * `POST /authorize` recomputes this from the stored request and never grants anything outside it.
 */
export function offeredScopes(requested: readonly string[]): string[] {
  const asked = new Set(requested);
  const offered = SCOPES_SUPPORTED.filter((s) => asked.has(s));
  return offered.length > 0 ? offered : [...SCOPES_SUPPORTED];
}

export interface ConsentPageInput {
  description: ConsentDescription;
  handle: string;
  /** The requested scopes, from the parsed `AuthRequest`. */
  requestedScopes: readonly string[];
  /** Shown above the form, e.g. when the user approved with no scope ticked. Plain text. */
  notice?: string;
}

const PAGE_CSS = `<style>
  .client { font-size: 1.1rem; font-weight: 600; word-break: break-word; }
  .meta { margin: 0.25rem 0 1rem; }
  .meta dt { color: #57606a; font-size: 0.85rem; margin-top: 0.5rem; }
  .meta dd { margin: 0; word-break: break-all; }
  .note { background: #fff8c5; border: 1px solid #d4a72c; border-radius: 8px; padding: 0.6rem 0.8rem; font-size: 0.9rem; }
  .warn { background: #ffebe9; border: 1px solid #cf222e; border-radius: 8px; padding: 0.75rem 0.9rem; font-weight: 600; }
  fieldset { border: 1px solid #d0d7de; border-radius: 8px; margin: 1rem 0; padding: 0.5rem 0.9rem 0.75rem; }
  legend { font-weight: 600; padding: 0 0.3rem; }
  label.scope { display: flex; gap: 0.6rem; align-items: flex-start; margin: 0.6rem 0; cursor: pointer; }
  label.scope input { margin-top: 0.25rem; }
  .code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; color: #57606a; }
  .actions { display: flex; gap: 0.75rem; margin-top: 1.25rem; }
  button { font: inherit; padding: 0.55rem 1.2rem; border-radius: 8px; border: 1px solid #d0d7de; cursor: pointer; }
  button.approve { background: #1f883d; border-color: #1f883d; color: #fff; }
  button.deny { background: #f6f8fa; color: #1f2328; }
</style>`;

function scopeCheckbox(scope: string): string {
  const label = SCOPE_LABELS[scope] ?? scope;
  const checked = DEFAULT_CHECKED.has(scope) ? " checked" : "";
  const value = escapeHtml(scope);
  return `<label class="scope"><input type="checkbox" name="scope" value="${value}"${checked}>
<span>${escapeHtml(label)}<br><span class="code">${value}</span></span></label>`;
}

/** Full consent page HTML. All dynamic values are escaped here. */
export function renderConsentPage(input: ConsentPageInput): string {
  const { description, handle, requestedScopes, notice } = input;
  const clientName = escapeHtml(description.clientName);
  const redirectHost = escapeHtml(description.redirectHost);

  const identity = description.clientDomain
    ? `<dt>Published by</dt><dd>${escapeHtml(description.clientDomain)}</dd>`
    : "";
  const selfRegistered = description.clientDomain
    ? ""
    : `<p class="note">Self-registered app — Trips cannot verify who runs it. The name above is what the app calls itself.</p>`;
  const loopback = description.redirectIsLoopback
    ? `<p class="warn">Warning: this sends access to a program running on your computer. Only continue if you just started this connection yourself, for example from a command-line tool.</p>`
    : "";
  const noticeHtml = notice ? `<p class="warn">${escapeHtml(notice)}</p>` : "";

  const checkboxes = offeredScopes(requestedScopes).map(scopeCheckbox).join("\n");

  const body = `${PAGE_CSS}
<h1>Connect an app to Trips</h1>
<p class="client">${clientName}</p>
<p>wants access to your Trips account.</p>
<dl class="meta">
${identity}
<dt>After you approve, you will be sent to</dt><dd>${redirectHost}</dd>
</dl>
${selfRegistered}
${loopback}
${noticeHtml}
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<fieldset>
<legend>Allow this app to</legend>
${checkboxes}
</fieldset>
<p class="muted">The app can never delete anything. You will sign in with your usual Trips account next. You can disconnect the app at any time from your profile page in Trips.</p>
<div class="actions">
<button type="submit" name="decision" value="approve" class="approve">Approve</button>
<button type="submit" name="decision" value="deny" class="deny">Deny</button>
</div>
</form>`;

  return renderPage("Connect an app to Trips", body);
}
