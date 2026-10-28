import { exports } from "cloudflare:workers";

/** Origin used for all test requests; the Worker only looks at the path. */
export const TEST_ORIGIN = "https://example.test";

export type TestFetch = ((path: string, init?: RequestInit) => Promise<Response>) & {
  get(path: string, init?: RequestInit): Promise<Response>;
  delete(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, body?: unknown, init?: RequestInit): Promise<Response>;
  put(path: string, body?: unknown, init?: RequestInit): Promise<Response>;
};

function makeFetch(baseHeaders: Record<string, string>): TestFetch {
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    for (const [k, v] of Object.entries(baseHeaders)) if (!headers.has(k)) headers.set(k, v);
    const url = /^https?:\/\//.test(path) ? path : TEST_ORIGIN + (path.startsWith("/") ? path : `/${path}`);
    return exports.default.fetch(new Request(url, { ...init, headers }));
  };
  const withBody = (method: string) => (path: string, body?: unknown, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    return call(path, {
      ...init,
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  };
  return Object.assign(call, {
    get: (path: string, init: RequestInit = {}) => call(path, { ...init, method: "GET" }),
    delete: (path: string, init: RequestInit = {}) => call(path, { ...init, method: "DELETE" }),
    post: withBody("POST"),
    put: withBody("PUT"),
  });
}

/**
 * Fetch wrapper that authenticates as `email` through the DEV_MODE X-Dev-User-Email bypass
 * and dispatches to the real Worker default export (so `/api/...` prefix stripping applies).
 * Paths may be given with or without `/api`; e.g. asUser(e).get("/api/trips").
 * The user must exist (seedUser) or the Worker returns 401.
 */
export function asUser(email: string): TestFetch {
  return makeFetch({ "X-Dev-User-Email": email });
}

/** Same wrapper with no auth headers. */
export function anonymous(): TestFetch {
  return makeFetch({});
}
