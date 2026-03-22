import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import type { Env, AuthUser } from "../db";
import { getDb } from "../db";
import { users, serviceIdentities } from "../db/schema";

// Cache JWKS keyset per team domain
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJWKS(teamDomain: string) {
  if (!jwksCache.has(teamDomain)) {
    const url = new URL(`https://${teamDomain}/cdn-cgi/access/certs`);
    jwksCache.set(teamDomain, createRemoteJWKSet(url));
  }
  return jwksCache.get(teamDomain)!;
}

/**
 * Verify CF Access JWT and resolve to app user via service_identities mapping.
 */
async function authenticateCFAccess(
  jwt: string,
  teamDomain: string,
  audienceTag: string,
  db: ReturnType<typeof getDb>
): Promise<AuthUser | null> {
  try {
    const jwks = getJWKS(teamDomain);
    const { payload } = await jwtVerify(jwt, jwks, {
      issuer: `https://${teamDomain}`,
      audience: audienceTag,
    });

    const subject = payload.sub;
    if (!subject) return null;

    // Look up service identity → user mapping
    const rows = await db
      .select({
        userId: serviceIdentities.userId,
        userName: users.name,
        userEmail: users.email,
        userRole: users.role,
      })
      .from(serviceIdentities)
      .innerJoin(users, eq(serviceIdentities.userId, users.id))
      .where(eq(serviceIdentities.cfAccessSubject, subject))
      .limit(1);

    if (!rows.length) return null;

    return {
      id: rows[0].userId,
      email: rows[0].userEmail,
      name: rows[0].userName,
      role: rows[0].userRole,
    };
  } catch {
    return null;
  }
}

/**
 * Verify app-issued JWT (for frontend users).
 */
async function authenticateAppToken(
  token: string,
  secret: string,
  db: ReturnType<typeof getDb>
): Promise<AuthUser | null> {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key);
    const userId = payload.sub;
    if (!userId) return null;

    const rows = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!rows.length) return null;

    return {
      id: rows[0].id,
      email: rows[0].email,
      name: rows[0].name,
      role: rows[0].role,
    };
  } catch {
    return null;
  }
}

export const authMiddleware = createMiddleware<Env>(async (c, next) => {
  const db = getDb(c.env.DB);

  // 1. Try CF Access JWT (service tokens)
  const cfJwt = c.req.header("CF-Access-Jwt-Assertion");
  if (cfJwt && c.env.CF_ACCESS_TEAM_DOMAIN && c.env.CF_ACCESS_AUDIENCE) {
    const user = await authenticateCFAccess(
      cfJwt,
      c.env.CF_ACCESS_TEAM_DOMAIN,
      c.env.CF_ACCESS_AUDIENCE,
      db
    );
    if (user) {
      c.set("user", user);
      return next();
    }
  }

  // 2. Try app Bearer token (frontend users)
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ") && c.env.JWT_SECRET) {
    const token = authHeader.slice(7);
    const user = await authenticateAppToken(token, c.env.JWT_SECRET, db);
    if (user) {
      c.set("user", user);
      return next();
    }
  }

  return c.json({ error: "Unauthorized" }, 401);
});

/**
 * Middleware that skips auth — used for public routes like /auth/login.
 */
export const publicRoute = createMiddleware<Env>(async (_c, next) => {
  await next();
});
