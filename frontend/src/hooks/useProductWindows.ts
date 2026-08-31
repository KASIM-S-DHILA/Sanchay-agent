import { useCallback, useEffect, useRef, useState } from "react";

export interface ProductWindowData {
  productId: string;
  name: string;
  description: string;
  price: number;
  price_display: string;
  category: string;
  stock: number;
  image_url: string | null;
  /** Bumped by bringToFront; highest wins the CSS z-index. */
  z: number;
  /** Filled in once describe_product_images has actually been run for this
   *  product — lets the detail window show Gemini's own description
   *  alongside the catalog description, without a second fetch. */
  visionDescription: string | null;
}

export const MAX_OPEN_WINDOWS = 4;
// A window that closes before this elapses never counts as "seen" — a
// misfire (double-tap, or the model opening then immediately closing to
// correct a wrong product_id) must not get logged and later pitched back
// to the shopper as something they genuinely looked at.
const MIN_DWELL_MS = 3000;

type Api = (path: string, init?: RequestInit) => Promise<any>;

/**
 * Single source of truth for which floating product-detail windows are
 * open — shared by voice tool calls (show_product_detail /
 * close_product_detail / close_all_product_details in useGeminiLive.ts)
 * AND manual clicks (the X button, clicking a shelf card's "view" action),
 * so the two paths can never drift into disagreeing about what's on
 * screen. Cap is enforced here, once, regardless of caller.
 */
export function useProductWindows(sessionId: string | null, api: Api) {
  const [windows, setWindows] = useState<ProductWindowData[]>([]);
  const windowsRef = useRef<ProductWindowData[]>([]);
  windowsRef.current = windows;
  const nextZRef = useRef(1);
  // One dwell timer per currently-open product — cleared on close before
  // it fires, so an early close never logs a "seen".
  const dwellTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const logViewedIfStillOpen = useCallback((productId: string) => {
    dwellTimersRef.current.delete(productId);
    if (!windowsRef.current.some((w) => w.productId === productId)) return; // closed before dwell elapsed
    void api("/api/viewed-products", { method: "POST", body: JSON.stringify({ product_id: productId }) }).catch(() => { });
  }, [api]);

  const bringToFront = useCallback((productId: string) => {
    setWindows((prev) => {
      if (!prev.some((w) => w.productId === productId)) return prev;
      const z = ++nextZRef.current;
      return prev.map((w) => (w.productId === productId ? { ...w, z } : w));
    });
  }, []);

  /**
   * Closes one open window by product id — self-heals a slightly-wrong id
   * the SAME way add_to_cart/remove_from_cart already do against a source
   * of truth (there: the cart / last search cache; here: what's actually
   * open), instead of an exact-match-only filter that silently no-ops on
   * anything else while the caller (close_product_detail in
   * useGeminiLive.ts) still reported success. That combination — no
   * self-heal AND no failure signal — meant a wrong/mismatched id from the
   * model closed nothing, told the model it worked, and gave it no reason
   * to reconsider which window it actually meant; any window that closed
   * "by mistake" was really the model sending an id for a different
   * product than the shopper meant, with no feedback loop to catch it.
   *
   * Returns the productId that was ACTUALLY closed (may differ from the
   * one passed in, if resolved by name), or null if nothing matched at
   * all — the caller uses this to give the model an honest result instead
   * of an unconditional success.
   */
  const closeProduct = useCallback((productId: string): string | null => {
    const current = windowsRef.current;
    const normalizeId = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]/g, "");
    const normalizeName = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
    const target = normalizeId(productId);
    const targetName = normalizeName(productId);

    const match =
      current.find((w) => w.productId === productId) ??
      current.find((w) => normalizeId(w.productId) === target) ??
      current.find((w) => normalizeName(w.name) === targetName);

    if (!match) return null;

    const resolvedId = match.productId;
    const timer = dwellTimersRef.current.get(resolvedId);
    if (timer) {
      clearTimeout(timer);
      dwellTimersRef.current.delete(resolvedId); // never logged — closed before dwell elapsed
    }
    setWindows((prev) => prev.filter((w) => w.productId !== resolvedId));
    return resolvedId;
  }, []);

  const closeAll = useCallback(() => {
    for (const timer of dwellTimersRef.current.values()) clearTimeout(timer);
    dwellTimersRef.current.clear();
    setWindows([]);
  }, []);

  /**
   * Opens one or more products as floating windows. Returns what actually
   * happened so a voice tool caller can report it back honestly:
   *  - opened: ids that are now open (newly opened OR already-open-and-
   *    brought-to-front — reopening something already on screen is never
   *    a failure, and never consumes a second slot)
   *  - skippedAtCap: ids that couldn't open because the cap was already
   *    reached by OTHER products — never silently evicted; the caller
   *    (the model) is expected to offer the shopper a choice: close
   *    something first, or pick from what's already open.
   *  - openProductNames: every product currently open after this call,
   *    for the model to read out when at cap.
   */
  const openProducts = useCallback(
    (
      products: { productId: string; name: string; description: string; price: number; price_display: string; category: string; stock: number; image_url: string | null }[],
    ): { opened: string[]; skippedAtCap: string[]; openProductNames: string[] } => {
      const opened: string[] = [];
      const skippedAtCap: string[] = [];
      // Read/mutated INSIDE the updater (guaranteed to run before this
      // function returns, since setWindows's updater executes synchronously
      // as part of computing the eager state here — not merely relying on
      // windowsRef being refreshed by the time this call returns).
      let finalNames: string[] = [];

      setWindows((prev) => {
        let current = prev;
        for (const p of products) {
          const existingIdx = current.findIndex((w) => w.productId === p.productId);
          if (existingIdx !== -1) {
            // Already open — bring to front, not a new slot, not a duplicate.
            const z = ++nextZRef.current;
            current = current.map((w) => (w.productId === p.productId ? { ...w, z } : w));
            opened.push(p.productId);
            continue;
          }
          if (current.length >= MAX_OPEN_WINDOWS) {
            skippedAtCap.push(p.productId);
            continue;
          }
          const z = ++nextZRef.current;
          current = [...current, { ...p, z, visionDescription: null }];
          opened.push(p.productId);

          const timer = setTimeout(() => logViewedIfStillOpen(p.productId), MIN_DWELL_MS);
          dwellTimersRef.current.set(p.productId, timer);
        }
        windowsRef.current = current;
        finalNames = current.map((w) => w.name);
        return current;
      });

      return { opened, skippedAtCap, openProductNames: finalNames };
    },
    [logViewedIfStillOpen],
  );

  const setVisionDescription = useCallback((productId: string, text: string) => {
    setWindows((prev) => prev.map((w) => (w.productId === productId ? { ...w, visionDescription: text } : w)));
  }, []);

  /** Stable read of "what's open right now" for describe_product_images'
   *  default-to-open-windows path — reads the ref, not React state, so it
   *  reflects the truth at call time even inside a tool-call closure that
   *  captured this function long before the call actually runs. */
  const getOpenProductIds = useCallback((): string[] => windowsRef.current.map((w) => w.productId), []);

  // Session ending (sign-out) or switching (a fresh session id, e.g. after
  // sign-in migrates onto a different session) leaves every open window
  // pointing at a session whose cart/Add-to-Cart button no longer means
  // anything for THIS window's data — closing them avoids a stale,
  // half-broken-looking window surviving past the session it belonged to.
  // Runs on sessionId changing at all, not just becoming null, since
  // sign-in/sign-out in this app can swap to a genuinely different session
  // id without ever passing through a null in between.
  const prevSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId;
      closeAll();
    }
  }, [sessionId, closeAll]);

  return {
    windows,
    openProducts,
    closeProduct,
    closeAll,
    bringToFront,
    setVisionDescription,
    getOpenProductIds,
  };
}
