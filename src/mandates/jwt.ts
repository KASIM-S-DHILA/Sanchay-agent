import { SignJWT, jwtVerify, generateKeyPair, importJWK, exportJWK, importPKCS8 } from "jose";
import type { Env } from "../types";

const ALG = "ES256";
const MANDATE_KEY_ID = "mandate-es256";

interface CachedKeys {
  privateKey: any;
  publicKey: any;
}

let cached: CachedKeys | null = null;
let cachedPromise: Promise<CachedKeys> | null = null;

async function getKeyPair(env: Env): Promise<CachedKeys> {
  if (cached) return cached;
  if (cachedPromise) return cachedPromise;

  cachedPromise = (async (): Promise<CachedKeys> => {
    // 1. Try env JWT_SIGNING_KEY as JWK JSON
    const raw = env.JWT_SIGNING_KEY?.trim();
    if (raw) {
      try {
        const jwk = JSON.parse(raw);
        if (jwk.kty === "EC" && jwk.crv === "P-256") {
          const privateKey = (await importJWK(jwk, ALG)) as any;
          // Derive public JWK by stripping private part
          const { d, ...publicJwk } = jwk;
          // If public parts missing, export from private key
          let publicKey: any;
          if (publicJwk.x && publicJwk.y) {
            publicKey = (await importJWK(publicJwk, ALG)) as any;
          } else {
            const exported = await exportJWK(privateKey as any);
            const { d: _d, ...pub } = exported as any;
            publicKey = (await importJWK(pub, ALG)) as any;
          }
          cached = { privateKey: privateKey as any, publicKey };
          return cached!;
        }
        if (jwk.kty === "oct") {
          // HS256 fallback — though spec says ES256, support oct for testing
          const privateKey = (await importJWK(jwk, "HS256")) as any;
          const publicKey = privateKey; // symmetric
          cached = { privateKey, publicKey } as any;
          return cached!;
        }
      } catch {
        // not a valid JWK, fall through
      }

      // Try PKCS8 PEM
      if (raw.includes("BEGIN PRIVATE KEY") || raw.includes("BEGIN EC PRIVATE KEY")) {
        try {
          const privateKey = await importPKCS8(raw, ALG);
          // For PEM we don't have public readily; generate and cache ephemeral for verify
          // Try to export and re-import public
          try {
            const jwk = await exportJWK(privateKey as any);
            const { d, ...pub } = jwk as any;
            const publicKey = (await importJWK(pub, ALG)) as any;
            cached = { privateKey, publicKey };
            return cached!;
          } catch {
            cached = { privateKey, publicKey: privateKey };
            return cached!;
          }
        } catch {}
      }
    }

    // 2. Try D1 persisted key
    try {
      if (env.DB) {
        await env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS app_keys (id TEXT PRIMARY KEY, jwk TEXT NOT NULL, created_at TEXT)`
        ).run();
        const row = await env.DB.prepare(`SELECT jwk FROM app_keys WHERE id = ?`)
          .bind(MANDATE_KEY_ID)
          .first<{ jwk: string }>();
        if (row?.jwk) {
          const jwk = JSON.parse(row.jwk);
          const privateKey = (await importJWK(jwk, ALG)) as any;
          const { d, ...pub } = jwk as any;
          let publicKey: any;
          if (pub.x && pub.y) {
            publicKey = (await importJWK(pub, ALG)) as any;
          } else {
            const exported = await exportJWK(privateKey as any);
            const { d: _d, ...pub2 } = exported as any;
            publicKey = (await importJWK(pub2, ALG)) as any;
          }
          cached = { privateKey, publicKey };
          return cached!;
        }
      }
    } catch {}

    // 3. Fallback: generate ephemeral ES256 keypair
    const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
    cached = { privateKey, publicKey } as any;

    // Persist for future isolates
    try {
      if (env.DB) {
        const jwk = await exportJWK(privateKey);
        await env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS app_keys (id TEXT PRIMARY KEY, jwk TEXT NOT NULL, created_at TEXT)`
        ).run();
        await env.DB.prepare(`INSERT OR IGNORE INTO app_keys (id, jwk, created_at) VALUES (?, ?, ?)`)
          .bind(MANDATE_KEY_ID, JSON.stringify(jwk), new Date().toISOString())
          .run();
      }
    } catch {}

    return cached!;
  })();

  const result = await cachedPromise;
  cached = result;
  return result;
}

export async function issueIntentMandate(
  env: Env,
  sessionId: string,
  budgetValuePaise: number,
  span: string
): Promise<string> {
  const { privateKey } = await getKeyPair(env);
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600;

  const jwt = await new SignJWT({ intent: "budget", value: budgetValuePaise, span })
    .setProtectedHeader({ alg: ALG })
    .setSubject(sessionId)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(privateKey);

  // Ensure D1 table exists and store mandate
  try {
    if (env.DB) {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS intent_mandates (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          jwt TEXT,
          budget_value INTEGER,
          span TEXT,
          created_at TEXT,
          expires_at TEXT
        )`
      ).run();

      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(exp * 1000).toISOString();

      await env.DB.prepare(
        `INSERT INTO intent_mandates (id, session_id, jwt, budget_value, span, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(id, sessionId, jwt, budgetValuePaise, span, createdAt, expiresAt)
        .run();
    }
  } catch (e) {
    console.error("Failed to store intent mandate", e);
  }

  return jwt;
}

export async function verifyMandate(
  env: Env,
  token: string
): Promise<{ sub: string; intent: string; value?: number }> {
  const { publicKey, privateKey } = await getKeyPair(env);
  // Try public key first, fallback to private (symmetric case)
  let payload: any;
  try {
    const verified = await jwtVerify(token, publicKey, { algorithms: [ALG, "HS256"] });
    payload = verified.payload;
  } catch {
    const verified = await jwtVerify(token, privateKey, { algorithms: [ALG, "HS256"] });
    payload = verified.payload;
  }

  return {
    sub: payload.sub as string,
    intent: payload.intent as string,
    value: payload.value as number | undefined,
  };
}

// For testing: reset cache
export function __resetMandateKeysForTest() {
  cached = null;
  cachedPromise = null;
}
