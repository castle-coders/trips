/**
 * OAuth client display-name resolution shared by the grant endpoints (`grants.ts`) and the
 * MCP `apiHandler` (`provider.ts`), which writes the name into audit rows (AUDIT_PRD 6.6).
 *
 * Library facts relied on (1.2.4, read from dist): `lookupClient` returns the stored record for a
 * dynamically or statically registered client, but for a Client ID Metadata Document URL it
 * fetches the document over the network on every call. Nothing here ever does that: CIMD
 * clients resolve to `null` without a lookup. A failed or missing lookup is also `null`.
 */
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export function isCimdClientId(clientId: string): boolean {
  return /^https?:\/\//i.test(clientId);
}

/** Memo of in-flight or settled lookups keyed by client id, so N uses of one client cost one lookup. */
export type ClientNameCache = Map<string, Promise<string | null>>;

/** The client's registered `client_name`, or `null` for unknown, deleted or CIMD clients. */
export function lookupClientName(api: OAuthHelpers, cache: ClientNameCache, clientId: string): Promise<string | null> {
  let hit = cache.get(clientId);
  if (!hit) {
    hit = isCimdClientId(clientId)
      ? Promise.resolve(null)
      : api.lookupClient(clientId).then(
          (c) => c?.clientName ?? null,
          () => null,
        );
    cache.set(clientId, hit);
  }
  return hit;
}
