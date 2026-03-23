import { createMiddleware } from "hono/factory";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import type { Env, AuthUser } from "../db";
import { getDb } from "../db";
import { users, serviceIdentities } from "../db/schema";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJWKS(teamDomain: string) {
  if (!jwksCache.has(teamDomain)) {
    const url = new URL(`https://${teamDomain}/cdn-cgi/access/certs`);
    jwksCache.set(teamDomain, createRemoteJWKSet(url));
  }
  return jwksCache.get(teamDomain)!;
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

    const subject = payload.sub;
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

    // 2. Human user — look up by email, auto-create if first login
    const email = payload.email as string | undefined;
    if (!email) return null;

    const userRows = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (userRows.length) {
      return {
        id: userRows[0].id,
        email: userRows[0].email,
        name: userRows[0].name,
        role: userRows[0].role,
      };
    }

    // First login — provision the user
    const isBootstrapAdmin = bootstrapAdminEmail && email === bootstrapAdminEmail;
    const anyUser = await db.select({ id: users.id }).from(users).limit(1);
    const role = isBootstrapAdmin || anyUser.length === 0 ? "admin" : "viewer";
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const name = (payload.name as string | undefined) || email.split("@")[0];

    await db.insert(users).values({ id, email, name, role, createdAt: now, updatedAt: now });

    return { id, email, name, role };
  } catch {
    return null;
  }
}

async function authenticateDevUser(
  email: string,
  db: ReturnType<typeof getDb>,
  bootstrapAdminEmail?: string
): Promise<AuthUser | null> {
  const userRows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (userRows.length) {
    return { id: userRows[0].id, email: userRows[0].email, name: userRows[0].name, role: userRows[0].role };
  }
  const isBootstrapAdmin = bootstrapAdminEmail && email === bootstrapAdminEmail;
  const anyUser = await db.select({ id: users.id }).from(users).limit(1);
  const role = isBootstrapAdmin || anyUser.length === 0 ? "admin" : "viewer";
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const name = email.split("@")[0];
  await db.insert(users).values({ id, email, name, role, createdAt: now, updatedAt: now });
  return { id, email, name, role };
}

export const authMiddleware = createMiddleware<Env>(async (c, next) => {
  const db = getDb(c.env.DB);

  const cfJwt = c.req.header("Cf-Access-Jwt-Assertion");
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
      const user = await authenticateDevUser(devEmail, db, c.env.BOOTSTRAP_ADMIN_EMAIL);
      if (user) {
        c.set("user", user);
        return next();
      }
    }
  }

  return c.json({ error: "Unauthorized" }, 401);
});
