import { useState, useCallback } from "react";

export interface TryOnConsent {
  accepted: boolean;
  accept: () => void;
  decline: () => void;
}

/**
 * In-memory-only try-on consent state — deliberately NOT persisted to
 * localStorage, cookies, or the backend, so a fresh tab/session always
 * re-prompts. Rendered nowhere yet; the future camera feature reads
 * `accepted` before requesting any permission.
 */
export function useTryOnConsent(): TryOnConsent {
  const [accepted, setAccepted] = useState(false);
  const accept = useCallback(() => setAccepted(true), []);
  // Decline keeps `accepted` false (its initial value) — written as an
  // explicit setter rather than a no-op so the modal's "Not now" button
  // has something real to call, and a future "re-ask" flow can reset.
  const decline = useCallback(() => setAccepted(false), []);
  return { accepted, accept, decline };
}
