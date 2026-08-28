/**
 * Single place to swap payment credentials.
 *
 * Razorpay key ids are public by design — they're embedded in every browser
 * checkout — so this is safe in the bundle. The secret never leaves the
 * Worker. When the merchant account changes, this one line changes.
 */
export const RAZORPAY_KEY_ID = "rzp_test_TTAxFYmg1Iipgl";

/**
 * Cloudflare Turnstile sitekey for the OTP sign-in gate. Empty until a real
 * widget is created for sanchay.store (see AuthGate) — the widget script
 * simply doesn't render without one, and the backend already treats
 * TURNSTILE_SECRET_KEY as optional, so sign-in still works end-to-end while
 * this is unset. It is safe to hardcode here once set: Turnstile sitekeys,
 * like Razorpay key ids, are public and meant to ship in the browser.
 */
export const TURNSTILE_SITE_KEY = "";

/** Paise → "₹1,240". One formatter, so no two surfaces round differently. */
export const rupees = (paise: number): string =>
  `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
