/**
 * Single place to swap payment credentials.
 *
 * Razorpay key ids are public by design — they're embedded in every browser
 * checkout — so this is safe in the bundle. The secret never leaves the
 * Worker. When the merchant account changes, this one line changes.
 */
export const RAZORPAY_KEY_ID = "rzp_test_TTAxFYmg1Iipgl";

/** Paise → "₹1,240". One formatter, so no two surfaces round differently. */
export const rupees = (paise: number): string =>
  `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
