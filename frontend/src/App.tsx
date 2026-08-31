import { useState, useCallback, useEffect, useRef } from "react";
import { ActivityLog } from "./components/ActivityLog";
import { AuthGate } from "./components/AuthGate";
import { EntryGate } from "./components/EntryGate";
import { Bill, type BillItem, type PaymentState } from "./components/Bill";
import { CrossSell, type CrossSellSuggestion } from "./components/CrossSell";
import { Shelf, type ShelfSource } from "./components/Shelf";
import type { CatalogProduct } from "./components/ProductCard";
import { VoiceDock } from "./components/VoiceDock";
import { useAuditFeed } from "./hooks/useAuditFeed";
import { useAuth } from "./hooks/useAuth";
import { useGeminiLive } from "./hooks/useGeminiLive";
import { useProductWindows } from "./hooks/useProductWindows";
import { ProductDetailWindows } from "./components/ProductDetailWindows";
import { RAZORPAY_KEY_ID, rupees } from "./config";

interface CartData {
  items: BillItem[];
  total: number;
  count: number;
  budgetRemaining?: number | null;
  youMightAlsoLike?: CrossSellSuggestion[];
  pendingOrder?: {
    orderId: string;
    amountPaise: number;
    paymentUrl: string | null;
    expiresInSeconds: number;
    lastAttemptFailed: boolean;
  } | null;
  // Set server-side from sessions.user_id (see getCart in src/api/logic.ts)
  // — false for guest browsing, true only after a real sign-in. Used to
  // gate the Pay button: checkout is rejected server-side for a guest
  // regardless of what the UI shows, but showing that as a disabled button
  // with an explanation is far better than letting them click Pay and
  // learn about the requirement from a surprise error.
  isSignedIn?: boolean;
}

interface Note {
  id: number;
  tone: "ok" | "warn" | "error";
  text: string;
}

declare global {
  interface Window {
    Razorpay: any;
  }
}

const SESSION_STORAGE_KEY = "sanchay_session_id";

/** The catalog returns `id` when listing and `productId` when searching. */
function normalizeProducts(raw: any[]): CatalogProduct[] {
  return raw.map((p) => ({
    id: p.id ?? p.productId,
    name: p.name,
    price: p.price,
    price_display: p.price_display,
    category: p.category,
    stock: typeof p.stock === "number" ? p.stock : 1,
    image_url: p.image_url ?? null,
    description: p.description,
  }));
}

export default function App() {
  const [email, setEmail] = useState("");
  // Persisted across reload — without this, every reload silently started
  // a brand-new anonymous session (a fresh gemini-<ts>@live.local user_id),
  // orphaning whatever cart/name/history the shopper had, even if they were
  // signed in. The session is validated against the backend on load (see
  // the effect below); an expired/invalid stored id just falls back to
  // starting fresh, same as having none.
  const [sessionId, setSessionId] = useState<string | null>(() => localStorage.getItem(SESSION_STORAGE_KEY));
  const [cart, setCart] = useState<CartData | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [view, setView] = useState<"shop" | "bill">("shop");

  const [shelfQuery, setShelfQuery] = useState("");
  const [shelfSource, setShelfSource] = useState<ShelfSource>("default");
  const [shelfProducts, setShelfProducts] = useState<CatalogProduct[]>([]);
  const [shelfLoading, setShelfLoading] = useState(true);
  const [shelfError, setShelfError] = useState<string | null>(null);

  const [addingProductId, setAddingProductId] = useState<string | null>(null);
  const [justAddedId, setJustAddedId] = useState<string | null>(null);
  const [payment, setPayment] = useState<PaymentState | null>(null);
  /** Mirrors `payment` for callbacks that must stay identity-stable across
   *  renders — see openVoiceCheckout, which the voice tool dispatcher holds
   *  for the whole call. */
  const paymentRef = useRef<PaymentState | null>(null);
  paymentRef.current = payment;
  const [checkoutBusy, setCheckoutBusy] = useState(false);

  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;

  // Single sync point for persisting sessionId — every setSessionId call
  // above (ensureSession, sign-out, session validation) reaches storage
  // through this instead of each needing its own write.
  useEffect(() => {
    if (sessionId) localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
    else localStorage.removeItem(SESSION_STORAGE_KEY);
  }, [sessionId]);

  const auth = useAuth();
  const authTokenRef = useRef<string | null>(null);
  authTokenRef.current = auth.token;
  const noteSeq = useRef(0);
  const handledEventsRef = useRef<Set<string>>(new Set());
  // The audit feed returns the session's FULL history on every poll, not
  // just new rows — on a fresh page load (or after a reload) the very
  // first poll can carry a checkout event from minutes/hours ago that was
  // already paid or already abandoned. Without this guard, that first poll
  // reopened the Razorpay modal for it every single time. The fix: whatever
  // is already sitting in the feed the first time we see it (per session)
  // is marked handled silently, with no side effects — only events that
  // show up in a LATER poll (i.e. genuinely happened during this page's
  // lifetime) are acted on.
  const auditFeedInitializedRef = useRef<string | null>(null);
  // Queries this browser issued, so a catalog lookup we caused isn't mistaken
  // for one the agent caused when it comes back around on the audit feed.
  const ownQueriesRef = useRef<Map<string, number>>(new Map());
  const justAddedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const note = useCallback((text: string, tone: Note["tone"] = "warn") => {
    const id = ++noteSeq.current;
    setNotes((prev) => [...prev.slice(-2), { id, tone, text }]);
    setTimeout(() => setNotes((prev) => prev.filter((n) => n.id !== id)), 9000);
  }, []);

  const dismissNote = (id: number) => setNotes((prev) => prev.filter((n) => n.id !== id));

  const api = useCallback(async (path: string, init?: RequestInit) => {
    const sid = sessionIdRef.current;
    const token = authTokenRef.current;
    const res = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(sid ? { "x-session-id": sid } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
    return res.json() as Promise<any>;
  }, []);

  // — Session ————————————————————————————————————————————————————————
  // Tracks the in-flight validation of whatever sessionId was restored
  // from storage on mount (see the effect below) — ensureSession awaits
  // this before trusting sessionIdRef.current, closing a race where a
  // stale/expired session id (still sitting in the ref because validation
  // hadn't resolved yet) got handed to a voice call or cart action, which
  // then 401ed on every single request against it instead of silently
  // starting fresh. null once resolved; also null if there was nothing
  // to validate (no stored session at all).
  const sessionValidationRef = useRef<Promise<void> | null>(null);

  // One entry point. Anything that needs a counter opens one rather than
  // telling the shopper to go and press a different button first.
  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (sessionValidationRef.current) await sessionValidationRef.current;
    if (sessionIdRef.current) return sessionIdRef.current;
    // A signed-in shopper's fresh session should start already tied to
    // their real account, not the separate "keep a copy of this bill"
    // field — otherwise every new session (e.g. after a stored session id
    // was cleared or expired) would orphan itself from their name/history
    // even though they're signed in.
    const startEmail = auth.email ?? email.trim() ?? null;
    const data = await api("/api/session/start", {
      method: "POST",
      body: JSON.stringify({ user_email: startEmail || null }),
    });
    if (data?.success) {
      sessionIdRef.current = data.data.sessionId;
      setSessionId(data.data.sessionId);
      return data.data.sessionId;
    }
    note(data?.error ?? "Couldn't open a counter. Reload and try again.", "error");
    return null;
  }, [api, auth.email, email, note]);

  // Validates whatever session id was restored from storage — a stale one
  // (expired, or ended via sign-out on another device/tab) must not sit
  // around looking valid while every real call against it 401s. On
  // failure, clear it so the next ensureSession() call starts fresh rather
  // than silently reusing a dead id forever. ensureSession awaits this
  // promise before reading sessionIdRef, so nothing can act on the stale
  // id in the window between mount and this check resolving.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    sessionValidationRef.current = (async () => {
      const data = await api("/api/cart");
      if (!cancelled && data?.success === false) {
        sessionIdRef.current = null;
        setSessionId(null);
      }
      sessionValidationRef.current = null;
    })();
    return () => { cancelled = true; };
    // Runs once per mount against whatever sessionId was restored from
    // storage — not on every sessionId change, which would re-validate a
    // session this same tab just created moments ago.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // — Shelf ——————————————————————————————————————————————————————————
  const searchShelf = useCallback(
    async (query: string) => {
      setShelfLoading(true);
      setShelfError(null);
      ownQueriesRef.current.set(query, Date.now());
      try {
        const data = await api(`/api/catalog?q=${encodeURIComponent(query)}`);
        if (data?.success) {
          setShelfProducts(normalizeProducts(data.data?.products ?? []));
          setShelfQuery(query);
          setShelfSource(query ? "you" : "default");
        } else {
          setShelfError(data?.error ?? "The shelf didn't load");
        }
      } catch {
        setShelfError("The shelf didn't load");
      } finally {
        setShelfLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void searchShelf("");
    // Initial load only — later loads are user- or agent-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // — Tab visibility ————————————————————————————————————————————————
  // Feeds the polling gate below: a backgrounded tab can't show a
  // shopper anything anyway, so there's no reason to keep asking the
  // backend for updates while it's hidden.
  const [tabVisible, setTabVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const onVisibility = () => setTabVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const refreshCart = useCallback(async () => {
    const data = await api("/api/cart");
    if (data?.success) setCart(data.data);
  }, [api]);

  // Restores the "resume payment" banner on reload. `payment` is plain
  // React state — it doesn't survive a reload, so without this a shopper
  // who started paying, closed the tab, and came back sees a bare cart
  // with no indication an order is already in flight (clicking Pay again
  // is actually safe — checkoutCart's idempotency reuses the same order —
  // but nothing on screen says so). Only acts once per pending order id,
  // and never overrides an already-"paid" local state (e.g. if this same
  // tab just confirmed payment moments before the next 3s poll lands).
  const restoredPendingOrderRef = useRef<string | null>(null);
  useEffect(() => {
    const pending = cart?.pendingOrder;
    if (pending) {
      if (restoredPendingOrderRef.current === pending.orderId) return;
      setPayment((prev) => {
        if (prev?.stage === "paid") return prev;
        if (prev?.orderId === pending.orderId) return prev;
        // A reload can't tell whether Razorpay was ever actually opened
        // before the page went away, so this can't honestly claim
        // "dismissed" (which specifically means a real modal was closed) —
        // awaiting_tap makes no claim about what happened before reload,
        // just that a tap is needed to continue.
        return { orderId: pending.orderId, amount: pending.amountPaise, stage: "awaiting_tap" };
      });
      restoredPendingOrderRef.current = pending.orderId;
      return;
    }
    // No pending order left server-side (reconcileExpiredOrders runs on
    // every /api/cart read, so this fires within ~3s of the 15-minute
    // window closing). If the bill is still showing a "waiting"/"dismissed"
    // banner for that now-expired order, clear it — the order is
    // `cancelled` and stock is back on the shelf, so nothing left to wait
    // for. A `paid` banner is never cleared this way: it survives because
    // it isn't a pendingOrder anymore anyway once paid.
    if (restoredPendingOrderRef.current) {
      restoredPendingOrderRef.current = null;
      setPayment((prev) => (prev && prev.stage !== "paid" ? null : prev));
    }
  }, [cart?.pendingOrder]);

  // — Payment ————————————————————————————————————————————————————————
  /** Razorpay's handler fires the moment the shopper finishes, but the order
   *  isn't `paid` until our webhook lands. Poll briefly rather than either
   *  claiming success early or leaving the bill in limbo. */
  const confirmPayment = useCallback(
    async (orderId: string) => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const data = await api(`/api/order/${orderId}`);
        if (data?.success && data.data?.status === "paid") {
          setPayment({ orderId, amount: data.data.amount ?? 0, stage: "paid" });
          void refreshCart();
          note("Payment confirmed. The bill is settled.", "ok");
          return;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      note(
        "Payment went through but confirmation is still coming back. The bill updates itself the moment it lands.",
        "warn",
      );
    },
    [api, note, refreshCart],
  );

  /** The order id whose Razorpay instance is live on screen right now.
   *  Constructing a SECOND window.Razorpay for an order that already has
   *  one open tears the first one down, and the teardown fires that first
   *  instance's own `ondismiss` — which is exactly how "you closed the
   *  payment window" appeared for a shopper who never touched anything.
   *  Two independent paths could both reach openRazorpay for the same
   *  checkout (the voice tool-call response and the /api/audit poll that
   *  later reports the same checkout), so the guard lives here rather than
   *  in either caller. Cleared on dismiss/paid so a genuine reopen works. */
  const openOrderRef = useRef<string | null>(null);

  const openRazorpay = useCallback(
    (orderId: string, amountPaise: number) => {
      if (!window.Razorpay) {
        note("The payment window couldn't load. Check your connection and try again.", "error");
        return;
      }
      if (openOrderRef.current === orderId) return; // already on screen — never double-construct
      openOrderRef.current = orderId;
      setPayment({ orderId, amount: amountPaise, stage: "pending" });
      const rzp = new window.Razorpay({
        key: RAZORPAY_KEY_ID,
        order_id: orderId,
        amount: amountPaise,
        currency: "INR",
        name: "Sanchay",
        description: "Voice counter bill",
        handler: () => {
          openOrderRef.current = null; // window is gone; a retry may legitimately reopen
          void confirmPayment(orderId);
        },
        modal: {
          // Closing the window is a normal thing to do, not an error. Say what
          // it means and leave a way back in.
          ondismiss: () => {
            openOrderRef.current = null; // genuinely closed — allow a real reopen
            setPayment((prev) =>
              prev && prev.orderId === orderId && prev.stage !== "paid"
                ? { ...prev, stage: "dismissed" }
                : prev,
            );
            note("Payment window closed. Nothing was charged — your bill is exactly as it was.", "warn");
          },
        },
      });
      rzp.open();
    },
    [confirmPayment, note],
  );

  const resumePayment = useCallback(() => {
    if (payment && payment.stage !== "paid") openRazorpay(payment.orderId, payment.amount);
  }, [payment, openRazorpay]);

  /**
   * Voice-triggered checkout completion — opens the payment window itself,
   * which is the whole point of asking out loud: "check me out" should
   * finish with a payment window on screen, not with homework.
   *
   * This deliberately DOES call openRazorpay from a Gemini Live tool-call
   * response (a WebSocket message handler, no click on the call stack).
   * That's fine: Razorpay Standard Checkout injects an iframe overlay into
   * this page, and injecting DOM is not gesture-gated by browsers — only
   * real popups (window.open), fullscreen, audio playback and clipboard
   * are. An earlier version primed a "tap to pay" button here instead,
   * on the theory that a missing gesture was blocking the modal. The real
   * cause was a double-construct: the /api/audit poll reported the same
   * checkout a beat later and called openRazorpay AGAIN for that order,
   * and building a second Razorpay instance tore the first one down —
   * firing the first instance's ondismiss, which surfaced as "you closed
   * the payment window" to a shopper who had touched nothing. openRazorpay
   * now guards that (openOrderRef), so this can open directly and the
   * audit path can no longer fight it.
   *
   * Fallback if a browser ever does refuse: openRazorpay leaves the bill
   * in `pending`, whose banner offers "Reopen payment window" — a real tap
   * that always works. Nothing is lost, and the order already exists
   * server-side either way.
   */
  const openVoiceCheckout = useCallback(
    (orderId: string, amountPaise: number) => {
      // Reads payment through a ref, not the `payment` value, so this
      // callback's identity never changes — useGeminiLive captures it in
      // its tool-dispatch closure for the life of a call, and a callback
      // that gets recreated on every payment state change risks that
      // closure holding a stale copy mid-conversation.
      const current = paymentRef.current;
      if (current?.orderId === orderId && current.stage === "paid") return;
      openRazorpay(orderId, amountPaise);
    },
    [openRazorpay],
  );

  // — Auth ————————————————————————————————————————————————————————————
  // A session is opened first if none exists yet, so signing in before ever
  // talking or shopping still has something to attach to. The backend
  // decides whether to reattach THAT session to the account or resume an
  // already-active one from an earlier sign-in (see handleAuthOtpVerify) —
  // either way, whatever session id it returns becomes the session going
  // forward, replacing whatever was here before.
  const handleVerifyOtp = useCallback(
    async (verifyEmail: string, code: string): Promise<boolean> => {
      const sid = await ensureSession();
      const resolvedSessionId = await auth.verifyOtp(verifyEmail, code, sid);
      if (!resolvedSessionId) return false;
      if (resolvedSessionId !== sessionIdRef.current) {
        sessionIdRef.current = resolvedSessionId;
        setSessionId(resolvedSessionId);
        setCart(null); // stale cart from whatever session was active before
      }
      note(`Signed in as ${verifyEmail}`, "ok");
      return true;
    },
    [auth, ensureSession, note],
  );

  const handlePay = useCallback(async () => {
    const sid = await ensureSession();
    if (!sid) return;
    setCheckoutBusy(true);
    try {
      const data = await api("/api/checkout", { method: "POST" });
      if (data?.success && data.data?.orderId) {
        openRazorpay(data.data.orderId, data.data.amount);
      } else {
        // Every gate the Worker enforces — cap, stock, merchant ceiling —
        // arrives here as a sentence. Show it verbatim.
        note(data?.error ?? "Checkout didn't go through.", "warn");
        void refreshCart();
      }
    } finally {
      setCheckoutBusy(false);
    }
  }, [api, ensureSession, note, openRazorpay, refreshCart]);

  // — Floating product-detail windows — single source of truth shared by
  // voice tool calls (show_product_detail etc., wired into useGeminiLive
  // below) and manual clicks (the X button, "Add" inside a window).
  // Auto-closes whenever sessionId changes (sign-in/sign-out), see the
  // hook's own effect.
  const productWindows = useProductWindows(sessionId, api);

  // — Voice — Gemini Live (ephemeral token + 16k→24k PCM + tool calling).
  // App.tsx is the ONLY owner of session identity — the hook takes a
  // session id as a plain argument to startCall and never creates, caches,
  // or hands one back. No "adopt session" reconciliation needed: there is
  // only ever one copy of the session id to begin with.
  const voice = useGeminiLive(openVoiceCheckout, productWindows);

  // Whether it's worth polling at all right now: only while a call is
  // actually live (idle means nothing but the shopper's own manual
  // clicks — which already update state directly — can change anything)
  // AND the tab is visible (a hidden tab can't show updates anyway). This
  // is the fix for the CPU-limit incident where one tab left open with no
  // call running polled /api/cart and /api/audit every 3s indefinitely.
  const pollingActive = voice.callState !== "idle" && tabVisible;

  // — Cart ———————————————————————————————————————————————————————————
  useEffect(() => {
    if (!sessionId || !pollingActive) return;
    let cancelled = false;
    const load = async () => {
      const data = await api("/api/cart");
      if (!cancelled && data?.success) setCart(data.data);
    };
    void load(); // catch up immediately whenever polling turns back on
    const timer = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, api, pollingActive]);

  // Keeps the voice hook's own copy of the bearer token in sync with
  // auth.token on every change (sign-in, sign-out, or a token refresh) —
  // without this, a shopper who signs in mid-call still has every
  // voice-triggered request (checkout especially) go out with no
  // Authorization header, so the agent reports "you're not signed in"
  // even though they just did.
  useEffect(() => {
    voice.setAuthToken(auth.token);
  }, [auth.token, voice.setAuthToken]);

  // Same reasoning as the auth-token sync above, for session id: signing
  // in mid-call reattaches to a different session (see handleAuthOtpVerify
  // resuming an existing session rather than always keeping the caller's
  // current one) — without this, an already-live voice call kept issuing
  // every subsequent tool call (checkout, check_payment_status, etc.)
  // against the OLD session id, which the server now considers unrelated
  // to the shopper's actual signed-in identity.
  useEffect(() => {
    voice.setActiveSessionId(sessionId);
  }, [sessionId, voice.setActiveSessionId]);

  // Sign-out has to end the session server-side too, not just drop the
  // token — otherwise the shopper keeps talking/shopping on the exact same
  // session (still attributed to their real account's user_id in
  // sessions/user_preferences) even though the UI now claims "signed out".
  // Clearing sessionId here means the next thing that needs a counter
  // (ensureSession) opens a genuinely fresh anonymous one.
  const handleSignOut = useCallback(() => {
    voice.stopCall();
    const sid = sessionIdRef.current;
    if (sid) void api("/api/session/end", { method: "POST" }).catch(() => { });
    sessionIdRef.current = null;
    setSessionId(null);
    setCart(null);
    auth.signOut();
    note("Signed out. Starting a fresh guest session.", "ok");
  }, [api, auth, note, voice]);

  const startTalking = useCallback(async () => {
    const sid = await ensureSession();
    if (!sid) return;
    void voice.startCall(sid);
  }, [ensureSession, voice]);

  // — Adding ——————————————————————————————————————————————————————————
  const handleAddToCart = useCallback(
    async (productId: string) => {
      const sid = await ensureSession();
      if (!sid) return;
      setAddingProductId(productId);
      try {
        const data = await api("/api/cart/add", {
          method: "POST",
          body: JSON.stringify({ product_id: productId, quantity: 1 }),
        });
        if (data?.success) {
          setCart(data.data);
          setJustAddedId(productId);
          if (justAddedTimerRef.current) clearTimeout(justAddedTimerRef.current);
          justAddedTimerRef.current = setTimeout(() => setJustAddedId(null), 2600);
          // A floating detail window for this exact product has now done
          // its job — decided — so it closes itself rather than sitting
          // open next to a bill that already reflects the decision. Any
          // OTHER open windows are left untouched — see the matching
          // add_to_cart dispatch in useGeminiLive.ts for why those are
          // surfaced to the agent as a question, not auto-closed too.
          productWindows.closeProduct(productId);
        } else {
          note(data?.error ?? "Couldn't add that to the bill.", "warn");
        }
      } finally {
        setAddingProductId(null);
      }
    },
    [api, ensureSession, note, productWindows],
  );

  const handleClearBudget = useCallback(async (): Promise<boolean> => {
    const sid = await ensureSession();
    if (!sid) return false;
    const data = await api("/api/session/budget", {
      method: "POST",
      body: JSON.stringify({ clear: true }),
    });
    if (data?.success) {
      note("Cap removed for this visit. Nothing to watch against anymore.", "ok");
      void refreshCart();
      return true;
    }
    note(data?.error ?? "Couldn't remove that cap.", "warn");
    return false;
  }, [api, ensureSession, note, refreshCart]);

  const handleSetBudget = useCallback(
    async (rupeeValue: number): Promise<boolean> => {
      const sid = await ensureSession();
      if (!sid) return false;
      const data = await api("/api/session/budget", {
        method: "POST",
        body: JSON.stringify({ budget: rupeeValue }),
      });
      if (data?.success) {
        note(`Cap set at ${rupees(data.data.budget)} for this visit. Nothing can push the bill past it.`, "ok");
        void refreshCart();
        return true;
      }
      note(data?.error ?? "Couldn't set that cap.", "warn");
      return false;
    },
    [api, ensureSession, note, refreshCart],
  );

  // — Audit feed: one poller, several consumers ————————————————————————
  const { events, loaded: auditFeedLoaded } = useAuditFeed(sessionId, pollingActive);

  useEffect(() => {
    // Wait for the FIRST real fetch to resolve before deciding anything is
    // "history" — events is [] both before that fetch and for a genuinely
    // empty new session, and reacting to the pre-fetch [] used to consume
    // this one-time guard on nothing, letting the real first batch (the
    // session's actual full history) get treated as brand new instead —
    // which is exactly what reopened the Razorpay modal for an
    // already-paid order after a reload.
    if (!auditFeedLoaded) return;
    // First real poll after a (re)load / session switch: the feed already
    // contains this session's whole history. Mark it all handled without
    // acting on any of it — only events arriving on a poll AFTER this one
    // are new enough to react to (e.g. auto-opening the Razorpay modal).
    if (auditFeedInitializedRef.current !== sessionId) {
      auditFeedInitializedRef.current = sessionId;
      for (const e of events) handledEventsRef.current.add(e.id);
      return;
    }
    for (const e of events) {
      if (handledEventsRef.current.has(e.id)) continue;
      handledEventsRef.current.add(e.id);

      const body: any = e.response ?? {};
      const data = body.data ?? body;

      // Checkout discovered via the audit poll. In this tab that's usually
      // a checkout THIS tab already opened a window for (openVoiceCheckout
      // fired the moment the tool call returned, a beat before this poll
      // reports the same thing) — so this deliberately only records the
      // pending state and never opens a window itself.
      //
      // That matters: this used to call openRazorpay directly, and for a
      // voice checkout both paths reached it for the same order. Building a
      // second window.Razorpay for an order that already has one open tears
      // the first down, and the teardown fires the FIRST instance's
      // ondismiss — surfacing as "you closed the payment window" to a
      // shopper who had touched nothing. openRazorpay now guards against
      // double-construction anyway (openOrderRef), but there's still no
      // reason for a background poll to be in the business of opening
      // payment windows, so it doesn't.
      //
      // Recording the state is still worth doing: it covers the case where
      // the checkout genuinely didn't come from this tab (another tab, or a
      // reload mid-flight), leaving a bill that offers a real tap to open.
      if (e.endpoint === "/api/checkout" && e.status === "ok" && data?.orderId && data?.amount) {
        setPayment((prev) =>
          prev && prev.orderId === data.orderId && prev.stage === "paid"
            ? prev // already paid — never regress to "pending" for a stale event
            : { orderId: data.orderId, amount: data.amount, stage: "awaiting_tap" },
        );
        continue;
      }

      // A catalog lookup the AGENT ran — mirror it onto the shelf so the
      // screen answers the same question the shopper just asked out loud.
      if (e.endpoint === "/api/catalog" && e.status === "ok" && Array.isArray(data?.products)) {
        const query: string = typeof data.query === "string" ? data.query : "";
        const ourAt = ownQueriesRef.current.get(query);
        if (ourAt && Date.now() - ourAt < 10000) continue; // this one was ours
        setShelfProducts(normalizeProducts(data.products));
        setShelfQuery(query);
        setShelfSource("agent");
        setShelfLoading(false);
        setShelfError(null);
      }
    }
  }, [events, sessionId, auditFeedLoaded]);

  const items = cart?.items ?? [];
  const total = cart?.total ?? 0;
  const count = cart?.count ?? 0;
  const budgetRemaining = cart?.budgetRemaining ?? null;
  const cap = budgetRemaining === null ? null : total + budgetRemaining;

  if (!auth.hasEnteredApp) {
    return (
      <EntryGate
        sending={auth.sending}
        verifying={auth.verifying}
        error={auth.error}
        onSendOtp={auth.sendOtp}
        onVerifyOtp={handleVerifyOtp}
        onDismissError={auth.dismissError}
        onContinueAsGuest={auth.continueAsGuest}
      />
    );
  }

  return (
    <div className="counter">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="mark">
            <h1 className="mark-name">Sanchay</h1>
            <span className="mark-role">the counter that listens</span>
          </div>
          <div className="topbar-facts">
            <div className="fact">
              <span className="fact-label">Counter</span>
              <span className="fact-value">
                {sessionId ? sessionId.slice(0, 6).toUpperCase() : "not open"}
              </span>
            </div>
            <div className="fact">
              <span className="fact-label">On the bill</span>
              <span className="fact-value">
                {count} {count === 1 ? "piece" : "pieces"} · {rupees(total)}
              </span>
            </div>
            <div className="fact">
              <span className="fact-label">Cap</span>
              <span className={`fact-value ${cap !== null && budgetRemaining === 0 ? "is-over" : ""}`}>
                {cap === null ? "none set" : `${rupees(budgetRemaining ?? 0)} left`}
              </span>
            </div>
          </div>
          <AuthGate
            isSignedIn={auth.isSignedIn}
            hasChosenGuest={auth.hasChosenGuest}
            email={auth.email}
            sending={auth.sending}
            verifying={auth.verifying}
            error={auth.error}
            onSendOtp={auth.sendOtp}
            onVerifyOtp={handleVerifyOtp}
            onSignOut={handleSignOut}
            onDismissError={auth.dismissError}
            onContinueAsGuest={auth.continueAsGuest}
          />
        </div>
      </header>

      <main className="workspace" data-view={view}>
        <div className="work">
          <VoiceDock
            callState={voice.callState}
            transcripts={voice.transcripts}
            error={voice.error}
            micLevel={voice.micLevel}
            agentLevel={voice.agentLevel}
            isPaused={voice.isPaused}
            onStart={() => void startTalking()}
            onStop={voice.stopCall}
            onPause={voice.pauseCall}
            onResume={voice.resumeCall}
            onDismissError={voice.dismissError}
            onTry={(q) => void searchShelf(q)}
          />

          {/* Narrow screens only (see styles.css). Plain toggle buttons rather
              than a role="tab" set — a half-wired tab pattern reads worse to a
              screen reader than an honest pair of buttons. */}
          <div className="tabs">
            <button
              type="button"
              className={`tab ${view === "shop" ? "is-on" : ""}`}
              aria-pressed={view === "shop"}
              onClick={() => setView("shop")}
            >
              Shelf
            </button>
            <button
              type="button"
              className={`tab ${view === "bill" ? "is-on" : ""}`}
              aria-pressed={view === "bill"}
              onClick={() => setView("bill")}
            >
              Bill {count > 0 && `· ${rupees(total)}`}
            </button>
          </div>

          <div className="work-panels">
            <Shelf
              query={shelfQuery}
              source={shelfSource}
              products={shelfProducts}
              loading={shelfLoading}
              error={shelfError}
              onSearch={(q) => void searchShelf(q)}
              onAdd={(id) => void handleAddToCart(id)}
              addingId={addingProductId}
              justAddedId={justAddedId}
            />
            {items.length > 0 && (
              <CrossSell
                suggestions={cart?.youMightAlsoLike ?? []}
                onAdd={(id) => void handleAddToCart(id)}
                addingId={addingProductId}
                justAddedId={justAddedId}
              />
            )}
          </div>
        </div>

        <aside className="rail">
          <Bill
            sessionId={sessionId}
            items={items}
            total={total}
            count={count}
            budgetRemaining={budgetRemaining}
            payment={payment}
            pendingOrder={cart?.pendingOrder ?? null}
            isSignedIn={cart?.isSignedIn}
            busy={checkoutBusy}
            email={email}
            onEmailChange={setEmail}
            onSetBudget={handleSetBudget}
            onClearBudget={handleClearBudget}
            onPay={() => void handlePay()}
            onResumePayment={resumePayment}
          />
          {sessionId && <ActivityLog events={events} />}
        </aside>
      </main>

      <ProductDetailWindows
        windows={productWindows.windows}
        onClose={productWindows.closeProduct}
        onCloseAll={productWindows.closeAll}
        onFocus={productWindows.bringToFront}
        onAdd={(id) => void handleAddToCart(id)}
        addingId={addingProductId}
        justAddedId={justAddedId}
        isCallLive={voice.callState === "listening" || voice.callState === "speaking"}
        isPaused={voice.isPaused}
        onPause={voice.pauseCall}
        onResume={voice.resumeCall}
      />

      {notes.length > 0 && (
        <div className="notes" aria-live="polite">
          {notes.map((n) => (
            <div key={n.id} className={`note is-${n.tone}`} role={n.tone === "error" ? "alert" : undefined}>
              <span className="note-text">{n.text}</span>
              <button
                type="button"
                className="note-close"
                onClick={() => dismissNote(n.id)}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
