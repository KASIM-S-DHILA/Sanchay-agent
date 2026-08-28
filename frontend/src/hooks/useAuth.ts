import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "sanchay_auth";
const GUEST_CHOICE_KEY = "sanchay_entry_choice";

interface StoredAuth {
  token: string;
  email: string;
  exp: number; // epoch ms
}

function loadStoredAuth(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAuth;
    if (!parsed.token || !parsed.exp || Date.now() >= parsed.exp) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Email/OTP sign-in on top of the existing guest flow. Nothing here blocks
 * shopping — a shopper with no token is exactly today's guest experience.
 * Signing in reattaches the current session (cart, name, history) to a
 * real account server-side; see migrateGuestSessionToUser.
 *
 * The token is 24h and NOT silently refreshed — Sanchay never re-mints a
 * token without a fresh OTP, so expiry just drops the shopper back to
 * guest-like state (still shopping, just no longer "signed in") rather than
 * inventing a refresh path that would defeat the point of OTP-gating.
 */
export function useAuth() {
  const [auth, setAuth] = useState<StoredAuth | null>(() => loadStoredAuth());
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether the shopper has ever explicitly chosen "Continue as guest" on
  // this device — persisted separately from the token so a guest choice
  // survives reload without needing an account. Signing in later always
  // counts as having chosen, so this and isSignedIn together gate entry.
  const [hasChosenGuest, setHasChosenGuest] = useState<boolean>(
    () => localStorage.getItem(GUEST_CHOICE_KEY) === "1",
  );

  const continueAsGuest = useCallback(() => {
    localStorage.setItem(GUEST_CHOICE_KEY, "1");
    setHasChosenGuest(true);
  }, []);

  // Cross-tab sync — the `storage` event only fires in OTHER tabs/windows,
  // never the one that made the change, so this alone doesn't cause a loop
  // with signOut/verifyOtp's own setAuth calls in the tab that triggered
  // them. Without this, signing out in one tab left every other open tab
  // still showing "signed in" (with a token the backend would still
  // legitimately accept) until that tab was reloaded.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setAuth(loadStoredAuth());
      if (e.key === GUEST_CHOICE_KEY) setHasChosenGuest(localStorage.getItem(GUEST_CHOICE_KEY) === "1");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Passive expiry check — catches a token that expired while the tab sat
  // open, without needing every request to notice a 401 first.
  useEffect(() => {
    if (!auth) return;
    const remaining = auth.exp - Date.now();
    if (remaining <= 0) {
      setAuth(null);
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const t = setTimeout(() => {
      setAuth(null);
      localStorage.removeItem(STORAGE_KEY);
    }, remaining);
    return () => clearTimeout(t);
  }, [auth]);

  const sendOtp = useCallback(async (email: string, turnstileToken?: string): Promise<boolean> => {
    setSending(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, turnstileToken }),
      });
      const j: any = await r.json();
      if (!j.success) {
        setError(j.error ?? "Couldn't send the code");
        return false;
      }
      return true;
    } catch {
      setError("Couldn't send the code — check your connection");
      return false;
    } finally {
      setSending(false);
    }
  }, []);

  /**
   * Returns the session id the backend wants the caller to use going
   * forward, or null on failure. This is NOT always the session id that
   * was passed in: the backend resumes the account's existing active
   * session (from an earlier sign-in, possibly on another device) when
   * one exists, rather than always migrating the caller's current guest
   * session onto the account — see handleAuthOtpVerify. The caller (App.tsx)
   * must adopt whatever comes back here as its new sessionId.
   */
  const verifyOtp = useCallback(async (email: string, code: string, sessionId: string | null): Promise<string | null> => {
    setVerifying(true);
    setError(null);
    try {
      // x-session-id must match the sessionId in the body — the backend
      // uses that header to prove this request actually owns the session
      // being migrated, not just that it knows its id (see
      // handleAuthOtpVerify in src/api/auth.ts).
      const r = await fetch("/api/auth/otp/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(sessionId ? { "x-session-id": sessionId } : {}),
        },
        body: JSON.stringify({ email, code, sessionId }),
      });
      const j: any = await r.json();
      if (!j.success) {
        setError(j.error ?? "Invalid or expired code");
        return null;
      }
      const stored: StoredAuth = {
        token: j.data.token,
        email: j.data.email,
        exp: Date.now() + 24 * 3600 * 1000,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      setAuth(stored);
      return (j.data.sessionId as string | null) ?? sessionId;
    } catch {
      setError("Couldn't verify — check your connection");
      return null;
    } finally {
      setVerifying(false);
    }
  }, []);

  const signOut = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setAuth(null);
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  return {
    isSignedIn: !!auth,
    email: auth?.email ?? null,
    token: auth?.token ?? null,
    sending,
    verifying,
    error,
    sendOtp,
    verifyOtp,
    signOut,
    dismissError,
    hasChosenGuest,
    continueAsGuest,
    hasEnteredApp: !!auth || hasChosenGuest,
  };
}
