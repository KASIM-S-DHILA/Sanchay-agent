import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { TURNSTILE_SITE_KEY } from "../config";

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: Record<string, unknown>) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

/**
 * Loads the Turnstile widget script once, globally — several AuthGate
 * mounts (e.g. StrictMode's double-render in dev) must not inject the
 * script tag twice.
 */
let turnstileScriptPromise: Promise<void> | null = null;
function loadTurnstileScript(): Promise<void> {
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise((resolve, reject) => {
    if (window.turnstile) return resolve();
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Turnstile script failed to load"));
    document.head.appendChild(script);
  });
  return turnstileScriptPromise;
}

/**
 * Email/OTP sign-in, offered alongside (never instead of) guest shopping.
 * Two steps: enter email → enter the 6-digit code that arrives. Turnstile
 * renders only when TURNSTILE_SITE_KEY is set; until the widget exists for
 * sanchay.store, the form submits without a token and the backend's own
 * (currently unset) TURNSTILE_SECRET_KEY check no-ops accordingly.
 */
export function AuthGate({
  isSignedIn,
  hasChosenGuest,
  email: signedInEmail,
  sending,
  verifying,
  error,
  onSendOtp,
  onVerifyOtp,
  onSignOut,
  onDismissError,
  onContinueAsGuest,
}: {
  isSignedIn: boolean;
  /** Already past the EntryGate as a guest — the topbar has nothing left
   *  to "continue" and should only offer a way to sign in later. */
  hasChosenGuest: boolean;
  email: string | null;
  sending: boolean;
  verifying: boolean;
  error: string | null;
  onSendOtp: (email: string, turnstileToken?: string) => Promise<boolean>;
  onVerifyOtp: (email: string, code: string) => Promise<boolean>;
  onSignOut: () => void;
  onDismissError: () => void;
  onContinueAsGuest: () => void;
}) {
  const [mode, setMode] = useState<"closed" | "email" | "code" | "dismissed">(
    hasChosenGuest ? "dismissed" : "closed",
  );
  const [emailInput, setEmailInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const turnstileRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "email" || !TURNSTILE_SITE_KEY || !turnstileRef.current) return;
    let cancelled = false;
    loadTurnstileScript().then(() => {
      if (cancelled || !window.turnstile || !turnstileRef.current) return;
      widgetIdRef.current = window.turnstile.render(turnstileRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        action: "otp_send",
        callback: (token: string) => setTurnstileToken(token),
      });
    }).catch(() => { /* widget just won't render — send still works without a token */ });
    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [mode]);

  const submitEmail = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const value = emailInput.trim();
      if (!value) return;
      const ok = await onSendOtp(value, turnstileToken ?? undefined);
      if (ok) setMode("code");
      else if (widgetIdRef.current && window.turnstile) window.turnstile.reset(widgetIdRef.current);
    },
    [emailInput, onSendOtp, turnstileToken],
  );

  const submitCode = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const value = codeInput.trim();
      if (value.length !== 6) return;
      const ok = await onVerifyOtp(emailInput.trim(), value);
      if (ok) {
        setMode("closed");
        setCodeInput("");
      }
    },
    [codeInput, emailInput, onVerifyOtp],
  );

  if (isSignedIn) {
    return (
      <div className="auth-gate auth-gate-signed-in">
        <span className="auth-gate-email">Signed in as {signedInEmail}</span>
        <button type="button" className="btn btn-sm" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    );
  }

  if (mode === "dismissed") {
    return (
      <button type="button" className="auth-gate-reopen" onClick={() => setMode("closed")}>
        Sign in
      </button>
    );
  }

  if (mode === "closed") {
    return (
      <div className="auth-gate">
        <button type="button" className="btn btn-sm" onClick={() => setMode("email")}>
          Sign in with email
        </button>
        <button
          type="button"
          className="auth-gate-guest"
          onClick={() => {
            setMode("dismissed");
            onContinueAsGuest();
          }}
        >
          Continue as guest
        </button>
      </div>
    );
  }

  return (
    <div className="auth-gate auth-gate-open">
      {mode === "email" ? (
        <form className="auth-gate-form" onSubmit={submitEmail}>
          <label className="auth-gate-label" htmlFor="auth-email">
            Sign in with email
          </label>
          <input
            id="auth-email"
            className="input"
            type="email"
            required
            autoFocus
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            placeholder="you@example.com"
          />
          {TURNSTILE_SITE_KEY && <div ref={turnstileRef} className="auth-gate-turnstile" />}
          <div className="auth-gate-actions">
            <button type="submit" className="btn btn-sm" disabled={sending || !emailInput.trim()}>
              {sending ? "Sending code" : "Send code"}
            </button>
            <button type="button" className="auth-gate-cancel" onClick={() => setMode("closed")}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <form className="auth-gate-form" onSubmit={submitCode}>
          <label className="auth-gate-label" htmlFor="auth-code">
            Enter the 6-digit code sent to {emailInput.trim()}
          </label>
          <input
            id="auth-code"
            className="input"
            inputMode="numeric"
            required
            autoFocus
            maxLength={6}
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, ""))}
            placeholder="123456"
          />
          <div className="auth-gate-actions">
            <button type="submit" className="btn btn-sm" disabled={verifying || codeInput.length !== 6}>
              {verifying ? "Verifying" : "Verify"}
            </button>
            <button type="button" className="auth-gate-cancel" onClick={() => setMode("email")}>
              Back
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="auth-gate-error" role="alert">
          <span>{error}</span>
          <button type="button" className="note-close" onClick={onDismissError} aria-label="Dismiss">
            ×
          </button>
        </p>
      )}
    </div>
  );
}
