import type { Env } from "../types";

/**
 * Reassigns a guest session onto a real, OTP-verified account and merges
 * whatever preference history the guest had accumulated.
 *
 * Context this has to work with: sessions started via useGeminiLive's
 * ensureSession() are never truly anonymous — they're created with a
 * disposable placeholder email (`gemini-<ts>@live.local`, see
 * startSession in api/logic.ts) which becomes sessions.user_id and doubles
 * as the user_preferences.user_id key for that "guest". Signing in mid-shop
 * means reattaching that session to the real account's email instead, so
 * this session's cart (already keyed by session_id, unaffected either way)
 * and any preference history recorded under the placeholder don't just
 * evaporate.
 *
 * No-ops safely if the session doesn't exist, already belongs to this
 * user, or if there's nothing to merge — never throws for "nothing to do".
 */
export async function migrateGuestSessionToUser(
  env: Env,
  sessionId: string,
  newUserId: string,
): Promise<void> {
  const session = await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ user_id: string | null }>();
  if (!session) return;

  const oldUserId = session.user_id;
  if (oldUserId === newUserId) return;

  await env.DB.prepare("UPDATE sessions SET user_id = ? WHERE id = ?").bind(newUserId, sessionId).run();

  if (!oldUserId) return;

  const oldPrefs = await env.DB.prepare(
    "SELECT previous_products, purchase_history, name FROM user_preferences WHERE user_id = ?",
  )
    .bind(oldUserId)
    .first<{
      previous_products: string | null;
      purchase_history: string | null;
      name: string | null;
    }>();
  if (!oldPrefs) return;

  const newPrefs = await env.DB.prepare(
    "SELECT previous_products, purchase_history, name FROM user_preferences WHERE user_id = ?",
  )
    .bind(newUserId)
    .first<{ previous_products: string | null; purchase_history: string | null; name: string | null }>();

  const mergeArrays = (a: string | null, b: string | null): string[] => {
    const parse = (s: string | null): string[] => {
      try { return JSON.parse(s || "[]"); } catch { return []; }
    };
    return [...new Set([...parse(a), ...parse(b)])];
  };

  const mergedProducts = mergeArrays(oldPrefs.previous_products, newPrefs?.previous_products ?? null);
  const mergedHistory = mergeArrays(oldPrefs.purchase_history, newPrefs?.purchase_history ?? null);
  // Prefer whatever name is already on the real account; only fall back to
  // the guest-session name if the account doesn't have one yet.
  const mergedName = newPrefs?.name ?? oldPrefs.name ?? null;

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, name, previous_products, purchase_history, session_count, last_active, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       name = COALESCE(excluded.name, user_preferences.name),
       previous_products = excluded.previous_products,
       purchase_history = excluded.purchase_history,
       updated_at = excluded.updated_at`,
  )
    .bind(
      newUserId,
      mergedName,
      JSON.stringify(mergedProducts),
      JSON.stringify(mergedHistory),
      now,
      now,
    )
    .run();
}
