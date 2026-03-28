import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import type { Env, AuthUser, CfIdentity } from "../db";
import { getDb } from "../db";
import { users, userEmails, serviceIdentities } from "../db/schema";

export { findUserByEmail, createUserWithEmail };

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJWKS(teamDomain: string) {
  if (!jwksCache.has(teamDomain)) {
    const url = new URL(`https://${teamDomain}/cdn-cgi/access/certs`);
    jwksCache.set(teamDomain, createRemoteJWKSet(url));
  }
  return jwksCache.get(teamDomain)!;
}

/** Look up a user by any of their linked emails */
async function findUserByEmail(
  db: ReturnType<typeof getDb>,
  email: string
): Promise<AuthUser | null> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
    })
    .from(userEmails)
    .innerJoin(users, eq(userEmails.userId, users.id))
    .where(eq(userEmails.email, email))
    .limit(1);

  return rows.length ? rows[0] : null;
}

/** Create a new user and their primary email entry */
async function createUserWithEmail(
  db: ReturnType<typeof getDb>,
  email: string,
  name: string,
  bootstrapAdminEmail?: string
): Promise<AuthUser> {
  const isBootstrapAdmin = bootstrapAdminEmail && email === bootstrapAdminEmail;
  const anyUser = await db.select({ id: users.id }).from(users).limit(1);
  const role = isBootstrapAdmin || anyUser.length === 0 ? "admin" : "viewer";
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  await db.insert(users).values({ id, email, name, role, createdAt: now, updatedAt: now });
  await db.insert(userEmails).values({
    id: crypto.randomUUID(),
    userId: id,
    email,
    isPrimary: true,
    createdAt: now,
  });

  return { id, email, name, role };
}

async function authenticateCFAccess(
  jwt: string,
  teamDomain: string,
  audienceTag: string,
  db: ReturnType<typeof getDb>,
  bootstrapAdminEmail?: string
): Promise<AuthUser | null> {
  try {
    const jwks = getJWKS(teamDomain);
    const { payload } = await jwtVerify(jwt, jwks, {
      issuer: `https://${teamDomain}`,
      audience: audienceTag,
    });

    // For service tokens, CF Access sets sub to "" and uses common_name instead
    const subject = (payload.sub as string) || (payload.common_name as string);
    if (!subject) return null;

    // 1. Check service identity mapping (for CF Access service tokens)
    const serviceRows = await db
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

    if (serviceRows.length) {
      return {
        id: serviceRows[0].userId,
        email: serviceRows[0].userEmail,
        name: serviceRows[0].userName,
        role: serviceRows[0].userRole,
      };
    }

    // 2. Human user — look up by any linked email (no auto-creation)
    const email = payload.email as string | undefined;
    if (!email) return null;

    return findUserByEmail(db, email);
  } catch {
    return null;
  }
}

async function authenticateDevUser(
  email: string,
  db: ReturnType<typeof getDb>,
): Promise<AuthUser | null> {
  return findUserByEmail(db, email);
}

export const authMiddleware = createMiddleware<Env>(async (c, next) => {
  const db = getDb(c.env.DB);

  const cfJwt = c.req.header("Cf-Access-Jwt-Assertion") || getCookie(c, "CF_Authorization");
  if (cfJwt && c.env.CF_ACCESS_TEAM_DOMAIN && c.env.CF_ACCESS_AUDIENCE) {
    const user = await authenticateCFAccess(
      cfJwt,
      c.env.CF_ACCESS_TEAM_DOMAIN,
      c.env.CF_ACCESS_AUDIENCE,
      db,
      c.env.BOOTSTRAP_ADMIN_EMAIL
    );
    if (user) {
      c.set("user", user);
      return next();
    }
  }

  // Dev-only bypass: accept X-Dev-User-Email header when DEV_MODE is set
  if (c.env.DEV_MODE) {
    const devEmail = c.req.header("X-Dev-User-Email");
    if (devEmail) {
      const user = await authenticateDevUser(devEmail, db);
      if (user) {
        c.set("user", user);
        return next();
      }
    }
  }

  return c.json({ error: "Unauthorized" }, 401);
});

/**
 * Lighter middleware that verifies the CF Access JWT and extracts email/name
 * but does NOT require the user to exist in the DB.
 * Sets c.var.cfIdentity with { email, name }.
 * Also sets c.var.user if the user happens to exist.
 */
export const jwtOnlyMiddleware = createMiddleware<Env>(async (c, next) => {
  const db = getDb(c.env.DB);

  const cfJwt = c.req.header("Cf-Access-Jwt-Assertion") || getCookie(c, "CF_Authorization");
  if (cfJwt && c.env.CF_ACCESS_TEAM_DOMAIN && c.env.CF_ACCESS_AUDIENCE) {
    try {
      const jwks = getJWKS(c.env.CF_ACCESS_TEAM_DOMAIN);
      const { payload } = await jwtVerify(cfJwt, jwks, {
        issuer: `https://${c.env.CF_ACCESS_TEAM_DOMAIN}`,
        audience: c.env.CF_ACCESS_AUDIENCE,
      });

      const email = payload.email as string | undefined;
      if (!email) return c.json({ error: "Unauthorized" }, 401);

      const name = (payload.name as string | undefined) || email.split("@")[0];
      c.set("cfIdentity", { email, name });

      // Also resolve user if they exist
      const existing = await findUserByEmail(db, email);
      if (existing) {
        c.set("user", existing);
      }

      return next();
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  // Dev-only bypass
  if (c.env.DEV_MODE) {
    const devEmail = c.req.header("X-Dev-User-Email");
    if (devEmail) {
      const name = devEmail.split("@")[0];
      c.set("cfIdentity", { email: devEmail, name });

      const existing = await findUserByEmail(db, devEmail);
      if (existing) {
        c.set("user", existing);
      }

      return next();
    }
  }

  return c.json({ error: "Unauthorized" }, 401);
});
