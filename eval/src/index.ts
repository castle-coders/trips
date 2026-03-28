import { createRemoteJWKSet, jwtVerify, importPKCS8, SignJWT, exportJWK } from "jose";
import { drizzle } from "drizzle-orm/d1";
import { eq, gt, and } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

// Minimal schema — only the tables we need for evaluation
const userEmails = sqliteTable("user_emails", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  email: text("email").notNull(),
  isPrimary: text("is_primary").notNull(),
  createdAt: text("created_at").notNull(),
});

const invites = sqliteTable("invites", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  expiresAt: text("expires_at").notNull(),
});

const accountLinkTokens = sqliteTable("account_link_tokens", {
  id: text("id").primaryKey(),
  expiresAt: text("expires_at").notNull(),
});

interface Env {
  DB: D1Database;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUDIENCE: string;
  EXTERNAL_EVAL_PRIVATE_KEY: string;
  EXTERNAL_EVAL_KEY_ID?: string;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJWKS(teamDomain: string) {
  if (!jwksCache.has(teamDomain)) {
    const url = new URL(`https://${teamDomain}/cdn-cgi/access/certs`);
    jwksCache.set(teamDomain, createRemoteJWKSet(url));
  }
  return jwksCache.get(teamDomain)!;
}

let cachedPrivateKey: CryptoKey | null = null;

async function getPrivateKey(pem: string): Promise<CryptoKey> {
  if (!cachedPrivateKey) {
    cachedPrivateKey = await importPKCS8(pem, "RS256");
  }
  return cachedPrivateKey;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleEvaluate(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ token: string }>();
  if (!body?.token) {
    return json({ error: "Missing token" }, 400);
  }

  const db = drizzle(env.DB);

  try {
    // Verify the incoming CF Access JWT
    const jwks = getJWKS(env.CF_ACCESS_TEAM_DOMAIN);
    const { payload } = await jwtVerify(body.token, jwks, {
      issuer: `https://${env.CF_ACCESS_TEAM_DOMAIN}`,
      audience: env.CF_ACCESS_AUDIENCE,
    });

    const email = payload.email as string | undefined;
    const nonce = payload.nonce as string | undefined;

    if (!email || !nonce) {
      return json({ error: "Missing email or nonce in token" }, 400);
    }

    let allowed = false;

    // Check 1: Is this a known user email?
    const knownEmail = await db
      .select({ email: userEmails.email })
      .from(userEmails)
      .where(eq(userEmails.email, email))
      .limit(1);

    if (knownEmail.length > 0) {
      allowed = true;
    }

    // Check 2: Are there any active pending invites?
    if (!allowed) {
      const now = new Date().toISOString();
      const pendingInvites = await db
        .select({ id: invites.id })
        .from(invites)
        .where(and(eq(invites.status, "pending"), gt(invites.expiresAt, now)))
        .limit(1);

      if (pendingInvites.length > 0) {
        allowed = true;
      }
    }

    // Check 3: Are there any active account link tokens?
    if (!allowed) {
      const now = new Date().toISOString();
      const activeTokens = await db
        .select({ id: accountLinkTokens.id })
        .from(accountLinkTokens)
        .where(gt(accountLinkTokens.expiresAt, now))
        .limit(1);

      if (activeTokens.length > 0) {
        allowed = true;
      }
    }

    // Sign the response
    const privateKey = await getPrivateKey(env.EXTERNAL_EVAL_PRIVATE_KEY);
    const now = Math.floor(Date.now() / 1000);
    const keyId = env.EXTERNAL_EVAL_KEY_ID || "eval-key-1";

    const responseToken = await new SignJWT({
      success: allowed,
      nonce,
    })
      .setProtectedHeader({ alg: "RS256", kid: keyId })
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(privateKey);

    return json({ token: responseToken });
  } catch (err: any) {
    console.error("[external-eval] Error:", err.message, err.stack);
    return json({ error: "Evaluation failed" }, 400);
  }
}

async function handleKeys(env: Env): Promise<Response> {
  try {
    const privateKey = await getPrivateKey(env.EXTERNAL_EVAL_PRIVATE_KEY);
    const publicJwk = await exportJWK(privateKey);
    const keyId = env.EXTERNAL_EVAL_KEY_ID || "eval-key-1";

    // Strip private key components — only expose the public key
    const { d, p, q, dp, dq, qi, ...publicOnly } = publicJwk;

    return json({
      keys: [
        {
          ...publicOnly,
          kid: keyId,
          use: "sig",
          alg: "RS256",
        },
      ],
    });
  } catch (err: any) {
    console.error("[external-eval] Keys error:", err.message);
    return json({ keys: [] });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/evaluate") {
      return handleEvaluate(request, env);
    }

    if (request.method === "GET" && url.pathname === "/keys") {
      return handleKeys(env);
    }

    return json({ error: "Not found" }, 404);
  },
};
