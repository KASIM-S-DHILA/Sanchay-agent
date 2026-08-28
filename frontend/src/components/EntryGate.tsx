import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { TURNSTILE_SITE_KEY } from "../config";

/**
 * Blocks the whole app until the shopper makes an explicit choice: sign in
 * with email, or continue as guest. Nothing behind this — voice, shelf,
 * checkout — is reachable until one of those happens. The choice (guest or
 * signed-in) is then remembered on this device (see useAuth's
 * hasChosenGuest/hasEnteredApp), so this gate only ever appears once per
 * device unless the shopper explicitly signs out AND clears that choice.
 *
 * Shares Turnstile wiring with the topbar's compact AuthGate (used later
 * for signing in after guest entry, or signing out) — kept as a separate
 * component rather than a shared render path because the two have
 * different layouts (full-screen modal vs. inline topbar widget) and
 * different available actions (this one always offers "continue as
 * guest"; the topbar one only offers sign-in/sign-out).
 */
export function EntryGate({
  sending,
  verifying,
  error,
  onSendOtp,
  onVerifyOtp,
  onDismissError,
  onContinueAsGuest,
}: {
  sending: boolean;
  verifying: boolean;
  error: string | null;
  onSendOtp: (email: string, turnstileToken?: string) => Promise<boolean>;
  onVerifyOtp: (email: string, code: string) => Promise<boolean>;
  onDismissError: () => void;
  onContinueAsGuest: () => void;
}) {
  const [mode, setMode] = useState<"choose" | "email" | "code">("choose");
  const [emailInput, setEmailInput] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const turnstileRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "email" || !TURNSTILE_SITE_KEY || !turnstileRef.current) return;
    let cancelled = false;
    const w = window as any;
    const load = (): Promise<void> => {
      if (w.turnstile) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const existing = document.querySelector('script[src*="turnstile"]');
        if (existing) {
          existing.addEventListener("load", () => resolve());
          return;
        }
        const script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
        script.async = true;
        script.defer = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Turnstile script failed to load"));
        document.head.appendChild(script);
      });
    };
    load().then(() => {
      if (cancelled || !w.turnstile || !turnstileRef.current) return;
      widgetIdRef.current = w.turnstile.render(turnstileRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        action: "otp_send",
        callback: (token: string) => setTurnstileToken(token),
      });
    }).catch(() => { /* widget just won't render — send still works without a token */ });
    return () => {
      cancelled = true;
      if (widgetIdRef.current && w.turnstile) {
        w.turnstile.remove(widgetIdRef.current);
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
      else if (widgetIdRef.current && (window as any).turnstile) (window as any).turnstile.reset(widgetIdRef.current);
    },
    [emailInput, onSendOtp, turnstileToken],
  );

  const submitCode = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const value = codeInput.trim();
      if (value.length !== 6) return;
      // Signing in here counts as entering the app — verifyOtp success is
      // reflected by the parent's isSignedIn flipping true, which unmounts
      // this gate on its own; no separate "entered" call needed.
      await onVerifyOtp(emailInput.trim(), value);
    },
    [codeInput, emailInput, onVerifyOtp],
  );

  return (
    <div className="entry-gate" role="dialog" aria-modal="true" aria-label="Sign in or continue as guest">
      <div className="entry-gate-card">
        <div className="entry-gate-mark">
          <h1 className="mark-name">Sanchay</h1>
          <span className="mark-role">the counter that listens</span>
        </div>

        {mode === "choose" && (
          <>
            <p className="entry-gate-lead">Sign in to keep your cart and history across visits, or shop now as a guest.</p>
            <div className="entry-gate-actions">
              <button type="button" className="btn pay-btn" onClick={() => setMode("email")}>
                Sign in with email
              </button>
              <button type="button" className="entry-gate-guest" onClick={onContinueAsGuest}>
                Continue as guest
              </button>
            </div>
          </>
        )}

        {mode === "email" && (
          <form className="entry-gate-form" onSubmit={submitEmail}>
            <label className="auth-gate-label" htmlFor="entry-email">
              Enter your email
            </label>
            <input
              id="entry-email"
              className="input"
              type="email"
              required
              autoFocus
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              placeholder="you@example.com"
            />
            {TURNSTILE_SITE_KEY && <div ref={turnstileRef} className="auth-gate-turnstile" />}
            <div className="entry-gate-actions">
              <button type="submit" className="btn pay-btn" disabled={sending || !emailInput.trim()}>
                {sending ? "Sending code" : "Send code"}
              </button>
              <button type="button" className="auth-gate-cancel" onClick={() => setMode("choose")}>
                Back
              </button>
            </div>
          </form>
        )}

        {mode === "code" && (
          <form className="entry-gate-form" onSubmit={submitCode}>
            <label className="auth-gate-label" htmlFor="entry-code">
              Enter the 6-digit code sent to {emailInput.trim()}
            </label>
            <input
              id="entry-code"
              className="input"
              inputMode="numeric"
              required
              autoFocus
              maxLength={6}
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, ""))}
              placeholder="123456"
            />
            <div className="entry-gate-actions">
              <button type="submit" className="btn pay-btn" disabled={verifying || codeInput.length !== 6}>
                {verifying ? "Verifying" : "Verify"}
              </button>
              <button type="button" className="auth-gate-cancel" onClick={() => setMode("email")}>
                Back
              </button>
            </div>
          </form>
        )}

        {error && (
          <p className="auth-gate-error entry-gate-error-inline" role="alert">
            <span>{error}</span>
            <button type="button" className="note-close" onClick={onDismissError} aria-label="Dismiss">
              ×
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
