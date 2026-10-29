import { env } from "cloudflare:workers";
import { getDb } from "../../src/db";

/** Drizzle client bound to the per-file test D1. */
export function testDb() {
  return getDb(env.DB);
}

/** Tables never wiped: migration bookkeeping and SQLite/D1 internals. */
function isInternalTable(name: string): boolean {
  return name === "d1_migrations" || name.startsWith("sqlite_") || name.startsWith("_cf_");
}

/**
 * KV bindings are detected by their workerd prototype name. Duck typing is unsafe here:
 * the pool's RPC Fetcher bindings answer any property access with a callable stub.
 */
function isKvNamespace(value: unknown): value is KVNamespace {
  if (typeof value !== "object" || value === null) return false;
  return Object.getPrototypeOf(value)?.constructor?.name === "KvNamespace";
}

/**
 * Delete every row from every application table and every key from every KV binding.
 * Foreign keys are deferred for the batch, so delete order does not matter.
 */
export async function resetStorage(): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).all<{ name: string }>();
  const tables = results.map((r) => r.name).filter((n) => !isInternalTable(n));
  if (tables.length) {
    await env.DB.batch([
      env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
      ...tables.map((t) => env.DB.prepare(`DELETE FROM "${t.replace(/"/g, '""')}"`)),
    ]);
  }

  for (const binding of Object.values(env as unknown as Record<string, unknown>)) {
    if (!isKvNamespace(binding)) continue;
    let cursor: string | undefined;
    do {
      const page: KVNamespaceListResult<unknown, string> = await binding.list({ cursor });
      await Promise.all(page.keys.map((k) => binding.delete(k.name)));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
}
