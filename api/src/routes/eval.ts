import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createRemoteJWKSet, jwtVerify, importPKCS8, SignJWT, exportJWK } from "jose";
import { eq, gt, and } from "drizzle-orm";
import { getDb, type Env } from "../db";
import { userEmails, invites, accountLinkTokens } from "../db/schema";

const app = new OpenAPIHono<Env>();

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
    cachedPrivateKey = await importPKCS8(pem, "RS256", { extractable: true });
  }
  return cachedPrivateKey;
}

// POST /evaluate — CF Access calls this with a JWT containing user identity
app.openapi(
  createRoute({
    method: "post",
    path: "/evaluate",
    tags: ["External Evaluation"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ token: z.string() }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Evaluation result",
        content: {
          "application/json": {
            schema: z.object({ token: z.string() }),
          },
        },
      },
      400: { description: "Invalid request" },
    },
  }),
  async (c) => {
    const { token: incomingToken } = c.req.valid("json");
    const db = getDb(c.env.DB);

    try {
      // Verify the incoming JWT signature against CF Access JWKS
      // The eval JWT from CF Access doesn't include iss/aud claims,
      // so only verify the signature — not issuer or audience.
      const jwks = getJWKS(c.env.CF_ACCESS_TEAM_DOMAIN);
      const { payload } = await jwtVerify(incomingToken, jwks);

      const identity = payload.identity as { email?: string } | undefined;
      const email = identity?.email;
      const nonce = payload.nonce as string | undefined;

      if (!email || !nonce) {
        console.log("[eval] Missing fields — email:", email, "nonce:", nonce);
        return c.json({ error: "Missing email or nonce in token" }, 400);
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
      const privateKey = await getPrivateKey(c.env.EXTERNAL_EVAL_PRIVATE_KEY);
      const now = Math.floor(Date.now() / 1000);
      const keyId = c.env.EXTERNAL_EVAL_KEY_ID || "eval-key-1";

      const responseToken = await new SignJWT({
        success: allowed,
        nonce,
      })
        .setProtectedHeader({ alg: "RS256", kid: keyId })
        .setIssuedAt(now)
        .setExpirationTime(now + 60)
        .sign(privateKey);

      return c.json({ token: responseToken }, 200);
    } catch (err: any) {
      console.error("[external-eval] Error:", err.message, err.stack);
      return c.json({ error: "Evaluation failed" }, 400);
    }
  }
);

// GET /keys — returns the public key in JWKS format for CF Access to verify our response
app.openapi(
  createRoute({
    method: "get",
    path: "/keys",
    tags: ["External Evaluation"],
    responses: {
      200: {
        description: "JWKS public keys",
        content: {
          "application/json": {
            schema: z.object({
              keys: z.array(z.record(z.string(), z.unknown())),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    try {
      const privateKey = await getPrivateKey(c.env.EXTERNAL_EVAL_PRIVATE_KEY);
      const publicJwk = await exportJWK(privateKey);
      const keyId = c.env.EXTERNAL_EVAL_KEY_ID || "eval-key-1";

      // Ensure we only expose the public components
      const { d, p, q, dp, dq, qi, ...publicOnly } = publicJwk;

      return c.json(
        {
          keys: [
            {
              ...publicOnly,
              kid: keyId,
              use: "sig",
              alg: "RS256",
            },
          ],
        },
        200
      );
    } catch (err: any) {
      console.error("[external-eval] Keys error:", err.message);
      return c.json({ keys: [] }, 200);
    }
  }
);

export default app;
