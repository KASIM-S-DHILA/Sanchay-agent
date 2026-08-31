import { useCallback, useEffect, useRef, useState } from "react";
import { GoogleGenAI, Modality } from "@google/genai";

// Clean Gemini Live hook — 16k mic → 24k speaker, tool use, Hindi greeting first
type CallState = "idle" | "connecting" | "listening" | "speaking";
export interface Transcript { role: "user" | "agent"; text: string; }

const SANCHAY_BASE = "";
const MODEL = "gemini-3.1-flash-live-preview";

const sanchayTools = [
  {
    functionDeclarations: [
      {
        name: "search_catalog",
        description: "Search apparel catalog. Always call first on product mentions.",
        parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] },
      },
      {
        name: "add_to_cart",
        description: "Add exact catalog id to cart. 1-99 qty. If this product had a floating detail window open, it closes automatically once added. If the result includes remainingOpenWindows (other products still open in their own windows), ask the shopper what they want to do with those — add them too, or close them — never silently leave them open with no mention, and never close them yourself without being told to.",
        parameters: { type: "object", properties: { product_id: { type: "string" }, quantity: { type: "integer" } }, required: ["product_id"] },
      },
      {
        name: "remove_from_cart",
        description: "Remove/decrement from cart.",
        parameters: { type: "object", properties: { product_id: { type: "string" }, quantity: { type: "integer" } }, required: ["product_id"] },
      },
      { name: "get_cart", description: "Get cart summary.", parameters: { type: "object", properties: {}, required: [] } },
      {
        name: "checkout",
        description:
          "Creates the Razorpay order for the current cart. IMPORTANT: this does NOT open the payment window itself — browsers block a payment popup triggered by voice/code with no real click behind it, so after this succeeds you must tell the shopper the order is ready and ask them to tap the 'Resume payment' button that appears on screen to open it. Never claim the payment window has opened, is open, or is loading — it is not, and won't be until they tap that button themselves.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      { name: "get_order_status", description: "Look up ONE specific order by its exact order_id — only useful if the shopper already has that id in hand (e.g. from an email or receipt), which is rare; never ask them to recall or read out an order id themselves. For 'did I pay', 'what have I bought', 'show my order history', or anything about past orders in general, use check_account_profile instead — it lists their recent orders with no id needed.", parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] } },
      {
        name: "check_account_profile",
        description:
          "Get the signed-in shopper's own account profile: name, email, member-since date, lifetime order count and total spend, favorite categories (derived from what they've actually bought), and up to 10 recent paid orders — no order_id needed. This is the RIGHT tool for 'did my payment go through', 'have I paid before', 'what have I bought', 'show my order history', or any question about past orders in general — do NOT ask the shopper for an order id or reach for get_order_status for these; almost nobody remembers an order id, and this tool needs none. Call this ONLY when they explicitly ask about their history, spending, past orders, or preferences — never volunteer this unprompted, and never recite the full order list back unless they ask for detail; a short natural mention is enough. Also useful silently: if they're browsing and favoriteCategories suggests a strong pattern (e.g. mostly jackets), you may lean the search_catalog query toward that when it's ambiguous what they want — but never state you're doing this or that you're 'checking their data' for a plain product search. Requires sign-in; if not signed in, it returns success:false and you should ask them to sign in first.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      {
        name: "check_payment_status",
        description:
          "Check the status of the shopper's MOST RECENT single checkout — whether it's currently pending, already succeeded, or expired. Call this for 'is my payment pending', 'did THAT payment go through', 'how much time do I have left to pay', right after a checkout — do NOT call checkout again just to answer this. For questions about order history in general ('what have I bought', 'show my past orders', 'have I paid before' with no specific recent checkout in mind), use check_account_profile instead. If hasPendingPayment is true: a payment is in progress — amountDue/expiresInSeconds/lastAttemptFailed describe it. If hasPendingPayment is false: check alreadyPaid — true means their most recent order was successfully paid (tell them so, do not say the payment failed), false with expired:true means their last reservation ran out unpaid (offer to check out again), false with neither set means they haven't checked out at all yet.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      {
        name: "show_product_detail",
        description:
          "Opens a bigger, more detailed floating window for one or more products the shopper wants a closer look at — e.g. 'show me that one', 'let me see the blue jacket bigger', or after they pick something to compare. Pass exact product ids from a recent search_catalog result, never invented ones. Up to 4 windows can be open at once; reopening something already open just brings it to the front, never a duplicate or an error. If the cap is already full, the result's skippedAtCap lists what couldn't open and openProductNames lists everything currently open — tell the shopper what's open and ask them to either pick one of those or close something first (say 'close the first one' etc.), never just silently retry.",
        parameters: {
          type: "object",
          properties: { product_ids: { type: "array", items: { type: "string" } } },
          required: ["product_ids"],
        },
      },
      {
        name: "close_product_detail",
        description: "Closes ONE specific open product-detail window, leaving any others exactly as they are. Use when the shopper says 'close that one' / 'close the jacket' while others may still be open — never use this to close everything. Pass the EXACT product_id from when that window was opened (the ids you used in your own show_product_detail call). If the shopper wants MULTIPLE windows closed, call this once per window with its own exact id, one call per product — never guess an id you're unsure of. On failure the result includes exactly which ids are still open right now — if you're not certain which one the shopper means, ask them rather than guessing, since a wrong id either closes nothing (and tells you so) or closes the wrong window.",
        parameters: { type: "object", properties: { product_id: { type: "string" } }, required: ["product_id"] },
      },
      {
        name: "close_all_product_details",
        description: "Closes every open product-detail window at once and returns to the plain shelf view. Use for 'close all of these', 'go back to the counter', 'hide those windows' — not for closing just one.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      {
        name: "describe_product_images",
        description:
          "Look at a product's actual photo(s) and describe or answer a question about what's visibly in them (color, material, pattern, details like buttons/collar/pockets) — call this for 'what does it look like', 'does it have a collar', 'which one is darker', or similar visual questions. Omit product_ids to describe whatever detail window(s) are CURRENTLY OPEN on screen (the normal case — the shopper is already looking at it, so don't ask them to repeat an id). Only pass explicit product_ids when nothing is open yet, e.g. describing something straight from search results. Pass `question` with their exact visual question when they asked one, so the answer is specific rather than a generic description. Fails clearly if nothing is open and no ids were given — in that case, ask what they'd like to see, or search/open something first.",
        parameters: {
          type: "object",
          properties: {
            product_ids: { type: "array", items: { type: "string" } },
            question: { type: "string" },
          },
          required: [],
        },
      },
      { name: "save_user_name", description: "Save or correct shopper's first name. Call once when asked, or again only if they explicitly correct it.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
      {
        name: "set_budget",
        description:
          "Set, change, or remove the shopper's spending cap for THIS visit only — it never carries over to a future visit, even if they're signed in. Call whenever they state or change a budget out loud (e.g. 'keep me under 2000 rupees', 'actually make it 3000'). To remove an existing cap entirely (e.g. 'no limit', 'remove my budget'), call with clear=true and omit rupees. Fails if the number given is already below what's in the cart — explain the shortfall and offer to remove something or raise the budget.",
        parameters: {
          type: "object",
          properties: {
            rupees: { type: "number", description: "Budget in rupees (not paise). Omit when clear=true." },
            clear: { type: "boolean", description: "true to remove the cap entirely instead of setting a number." },
          },
          required: [],
        },
      },
    ],
  },
];

async function sanchayFetch(
  path: string,
  sessionId: string,
  body: Record<string, unknown> = {},
  authToken?: string | null,
) {
  const r = await fetch(`${SANCHAY_BASE}${path}`, {
    method: "POST",
    headers: {
      "x-session-id": sessionId,
      "Content-Type": "application/json",
      // Without this, every voice-triggered call (checkout in particular)
      // looked identical to a guest request server-side — handleCheckout
      // requires a verified bearer token, not just sessions.user_id, so a
      // genuinely signed-in shopper asking the agent to check out was
      // rejected with "sign in first" even though they already had.
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return (await r.json()) as Record<string, unknown>;
}

/**
 * Looks up whatever name is already on file for this session (persisted
 * against sessions.user_id — see handleSaveName in src/api/user.ts), so a
 * returning or already-signed-in shopper is greeted by name instead of
 * asked again. Best-effort: any failure here just means the greeting falls
 * back to asking, exactly like today.
 */
async function fetchKnownName(sessionId: string): Promise<string | null> {
  try {
    const r = await fetch(`${SANCHAY_BASE}/api/user/name`, {
      method: "GET",
      headers: { "x-session-id": sessionId },
    });
    const j: any = await r.json();
    return j?.success ? (j.data?.name ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Builds a short natural-language summary of the account's last 2 paid
 * orders (see getPurchaseHistory in src/api/logic.ts) for injection into
 * the system instruction — e.g. "They previously bought: Black Hoodie,
 * Blue Jeans." Returns null (never an empty/awkward string) when there's
 * nothing to report: a guest session, a first-time buyer, or the fetch
 * itself failing all look the same to the caller — omit the line entirely
 * rather than have Gemini say something like "you have no history yet",
 * which reads as strange for a shopper who's simply new.
 */
async function fetchHistorySummary(sessionId: string): Promise<string | null> {
  try {
    const r = await fetch(`${SANCHAY_BASE}/api/session/history`, {
      method: "GET",
      headers: { "x-session-id": sessionId },
    });
    const j: any = await r.json();
    if (!j?.success) return null;
    const orders: { items: { name: string; quantity: number }[] }[] = j.data?.orders ?? [];
    if (!Array.isArray(orders) || orders.length === 0) return null;
    const names = orders
      .flatMap((o) => o.items.map((i) => i.name))
      .filter(Boolean)
      .slice(0, 4); // a couple of orders' worth of item names — enough to sound specific, not a recitation
    if (names.length === 0) return null;
    return `They previously bought: ${names.join(", ")}.`;
  } catch {
    return null;
  }
}

/**
 * Same idea as fetchHistorySummary, but for products the shopper LOOKED AT
 * (via a floating detail window that stayed open past the dwell debounce —
 * see logViewedProduct in src/api/logic.ts) without buying. Meaningful even
 * for a returning guest session (viewed_products is session_id-scoped, not
 * account-scoped) — e.g. sign-in resumes the SAME session on a later call
 * (see handleAuthOtpVerify), so this can carry real signal across calls
 * even without an account. Never volunteer this unprompted, same rule as
 * the purchase-history line — it's a "shopkeeper who remembers what you
 * looked at" cue for a natural pitch-back, not a recitation.
 */
async function fetchViewedSummary(sessionId: string): Promise<string | null> {
  try {
    const r = await fetch(`${SANCHAY_BASE}/api/viewed-products`, {
      method: "GET",
      headers: { "x-session-id": sessionId },
    });
    const j: any = await r.json();
    if (!j?.success) return null;
    const viewed: { name: string }[] = j.data?.viewed ?? [];
    if (!Array.isArray(viewed) || viewed.length === 0) return null;
    const names = viewed.map((v) => v.name).filter(Boolean).slice(0, 4);
    if (names.length === 0) return null;
    return `Earlier this visit they looked closely at: ${names.join(", ")} (without buying yet).`;
  } catch {
    return null;
  }
}

/**
 * Session ownership: this hook holds NO session state of its own. Earlier
 * versions kept an internal `sanchaySidRef` that was independently seeded
 * from a `sessionId` prop, occasionally minted its OWN session when empty,
 * and was read back out via a returned `sessionId`/`sanchaySessionId` for
 * App.tsx to "adopt" — three different places a session id could live,
 * which could and did drift out of sync (a stale id surviving in one place
 * after being cleared in another, silently resurrecting an ended session
 * on sign-out, or a fresh call racing a not-yet-created session). App.tsx
 * is now the ONLY place a session id is created, stored, or invalidated.
 * This hook receives it as a plain argument to startCall() and holds it in
 * `activeSessionIdRef` for the lifetime of exactly one call — set when the
 * call starts, cleared when it stops, never persisted or reused across
 * calls, never independently fetched or created.
 */
export interface ProductWindowsController {
  openProducts: (products: { productId: string; name: string; description: string; price: number; price_display: string; category: string; stock: number; image_url: string | null }[]) => { opened: string[]; skippedAtCap: string[]; openProductNames: string[] };
  closeProduct: (productId: string) => string | null;
  closeAll: () => void;
  setVisionDescription: (productId: string, text: string) => void;
  getOpenProductIds: () => string[];
}

export function useGeminiLive(
  onCheckoutSuccess?: (orderId: string, amount: number) => void,
  productWindows?: ProductWindowsController,
) {
  // Read via a ref, not a direct closure dependency — App.tsx's
  // useProductWindows() returns a fresh object each render (its individual
  // functions are useCallback-stabilized, but the containing object isn't),
  // and handleTool below is itself memoized; depending on the object
  // directly would either recreate handleTool every render or, worse, let
  // handleTool silently close over a stale productWindows from whenever it
  // was last recreated. Same pattern as authTokenRef.
  const productWindowsRef = useRef<ProductWindowsController | undefined>(productWindows);
  productWindowsRef.current = productWindows;
  const [callState, setCallState] = useState<CallState>("idle");
  // True while the mic is deliberately held (shopper tapped Pause) — the
  // WebSocket connection and all session context (cart, name, everything
  // already discussed) stay fully intact; only the outgoing audio stream
  // stops. See pauseCall/resumeCall below.
  const [isPaused, setIsPaused] = useState(false);
  const pausedRef = useRef(false);
  /** The bearer token for whoever is signed in right now, if anyone — read
   *  by handleTool on every tool call so voice-triggered requests (checkout
   *  especially) carry the same proof of sign-in the browser's own fetches
   *  do. Updated live via setAuthToken (exposed below), NOT tied to
   *  call start/stop, since a shopper can sign in or out mid-call. */
  const authTokenRef = useRef<string | null>(null);
  const setAuthToken = useCallback((token: string | null) => {
    authTokenRef.current = token;
  }, []);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [agentLevel, setAgentLevel] = useState(0);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const agentAnalyserRef = useRef<AnalyserNode | null>(null);
  const levelIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const smoothedMicRef = useRef(0);
  const smoothedAgentRef = useRef(0);
  const callStateRef = useRef<CallState>("idle");

  const sessionRef = useRef<any>(null);
  /** The session id THIS call is using — set at the top of startCall, read
   *  by handleTool/fetchKnownName, cleared by stopCall. Also kept in sync
   *  mid-call via setActiveSessionId (see below) — see that comment for
   *  why a call already in progress must not keep using a session id
   *  App.tsx has since moved past (e.g. sign-in reattaching to a
   *  different session while the shopper is still talking). */
  const activeSessionIdRef = useRef<string | null>(null);
  /**
   * Keeps activeSessionIdRef in sync with whatever session id App.tsx is
   * currently using, for the DURATION of an already-live call — not just
   * the value startCall was invoked with.
   *
   * Without this, signing in mid-call (a completely normal flow: ask to
   * check out, get told to sign in, sign in without ending the call, ask
   * to check out again) left every subsequent tool call in that same call
   * still targeting the OLD session id — checkout and check_payment_status
   * kept getting rejected against a session that, from the server's point
   * of view, the shopper had already moved on from, no matter what
   * auth.token said. The shopper sees this as "the agent says I'm not
   * signed in / can't check my payment, even though I clearly signed in
   * and paid" — exactly because the voice layer never learned the app had
   * switched sessions underneath it.
   */
  const setActiveSessionId = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = sessionId;
  }, []);
  /** Whether the most recent transcript entry for this role is still being
   *  appended to (true) or is a finished turn (false) — see
   *  appendTranscriptDelta. Reset on start/stop so a leftover "open" turn
   *  from a call that just ended can't merge into the next call's first
   *  chunk. */
  const openUserTurnRef = useRef(false);
  const openAgentTurnRef = useRef(false);
  /** Holds the latest merged text for whichever turn is open, updated
   *  synchronously on every chunk — setTranscripts (a React render) only
   *  fires on a throttle against this, not on every chunk. Gemini can
   *  stream several small transcription deltas per second; re-rendering
   *  on each one competes with the mic AudioWorkletNode's port.onmessage
   *  callback for main-thread time (both run there), which can delay
   *  outgoing mic audio and, in turn, delay Gemini's own turn-detection
   *  and response — perceived as the whole conversation getting slower. */
  const pendingTranscriptRef = useRef<Transcript | null>(null);
  const transcriptFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasGreetedRef = useRef(false);
  const prefetchedRef = useRef<{ token: string; exp: number } | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playCtxRef = useRef<AudioContext | null>(null);
  const playTimeRef = useRef(0);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const speakTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { callStateRef.current = callState; }, [callState]);

  /** Byte time-domain data → 0..1 loudness. Centers on 128 (silence), same
   *  scaling factor as the legacy RMS meter so both hooks feel consistent. */
  const analyserLevel = useCallback((analyser: AnalyserNode, buf: Uint8Array<ArrayBuffer>): number => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / buf.length) * 3);
  }, []);

  const stopLevelPump = useCallback(() => {
    if (levelIntervalRef.current) {
      clearInterval(levelIntervalRef.current);
      levelIntervalRef.current = null;
    }
    smoothedMicRef.current = 0;
    smoothedAgentRef.current = 0;
    setMicLevel(0);
    setAgentLevel(0);
  }, []);

  const startLevelPump = useCallback(() => {
    if (levelIntervalRef.current) return;
    const micBuf = new Uint8Array(256);
    const agentBuf = new Uint8Array(256);
    levelIntervalRef.current = setInterval(() => {
      const speaking = callStateRef.current === "speaking";
      // Mic tap sits upstream of any turn-taking logic, so while the agent
      // is speaking we mute the published mic level rather than trust the
      // raw analyser — avoids the wave reacting to AEC leakage/room bleed.
      const rawMic = micAnalyserRef.current && !speaking ? analyserLevel(micAnalyserRef.current, micBuf) : 0;
      const rawAgent = agentAnalyserRef.current ? analyserLevel(agentAnalyserRef.current, agentBuf) : 0;
      smoothedMicRef.current = smoothedMicRef.current * 0.7 + rawMic * 0.3;
      smoothedAgentRef.current = smoothedAgentRef.current * 0.7 + rawAgent * 0.3;
      setMicLevel(smoothedMicRef.current < 0.01 ? 0 : smoothedMicRef.current);
      setAgentLevel(smoothedAgentRef.current < 0.01 ? 0 : smoothedAgentRef.current);
    }, 70);
  }, [analyserLevel]);

  const prefetchToken = useCallback(async () => {
    if (prefetchedRef.current && Date.now() < prefetchedRef.current.exp - 10000) return;
    try {
      const r = await fetch(`${SANCHAY_BASE}/api/gemini/token`, { method: "POST" });
      const j: any = await r.json();
      if (j.success) prefetchedRef.current = { token: j.data.token, exp: new Date(j.data.newSessionExpireTime).getTime() };
    } catch { }
  }, []);

  useEffect(() => {
    prefetchToken();
    const onVis = () => { if (document.visibilityState === "visible") prefetchToken(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [prefetchToken]);

  const playPcm = useCallback(async (b64: string) => {
    if (!playCtxRef.current) {
      playCtxRef.current = new AudioContext({ sampleRate: 24000 });
      playTimeRef.current = playCtxRef.current.currentTime;
    }
    const ctx = playCtxRef.current;
    if (ctx.state === "suspended") await ctx.resume();
    if (!agentAnalyserRef.current) {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.connect(ctx.destination);
      agentAnalyserRef.current = analyser;
    }
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const pcm = new Int16Array(bytes.buffer);
    if (!pcm.length) return;
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 0x8000;
    const buf = ctx.createBuffer(1, f.length, 24000);
    buf.getChannelData(0).set(f);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(agentAnalyserRef.current);
    const when = Math.max(playTimeRef.current, ctx.currentTime);
    src.start(when);
    playTimeRef.current = when + buf.duration;
    setCallState("speaking");
    if (speakTimerRef.current) clearTimeout(speakTimerRef.current);
    speakTimerRef.current = setTimeout(() => setCallState("listening"), 900);
  }, []);

  /**
   * Gemini streams transcription as a sequence of small chunks per event,
   * not one event per full sentence — treating each chunk as its own
   * transcript entry (the previous behavior) put one word/fragment on its
   * own line. This merges consecutive same-role chunks into a single
   * growing entry, and only starts a new entry when the speaking role
   * switches (a fresh utterance) or turnComplete/interrupted closes the
   * turn (see the onmessage handler below).
   *
   * Defensive against either streaming style the API might send: if a
   * chunk already contains the previous text as a prefix (cumulative
   * growing text) it replaces rather than concatenates; otherwise
   * (incremental delta) it appends. This means the merge is correct
   * whichever style is actually in effect, rather than assuming one.
   */
  /** Actually commits pendingTranscriptRef to React state — the only place
   *  setTranscripts is called from the streaming path. Runs at most every
   *  80ms (see appendTranscriptDelta), not per chunk. */
  const flushTranscript = useCallback(() => {
    transcriptFlushTimerRef.current = null;
    const pending = pendingTranscriptRef.current;
    if (!pending) return;
    setTranscripts(prev => {
      const last = prev[prev.length - 1];
      if (last && last.role === pending.role && (pending.role === "user" ? openUserTurnRef : openAgentTurnRef).current) {
        return [...prev.slice(0, -1), pending].slice(-20);
      }
      // Defensive dedup: if the "new line" about to be pushed is
      // identical to the line immediately before it (same role, same
      // text), skip it rather than show the same sentence twice — this
      // can happen if a turn's closing flush and its next turn's opening
      // chunk race, or if Gemini re-sends a final transcription that
      // duplicates what was already fully flushed.
      if (last && last.role === pending.role && last.text === pending.text) return prev;
      return [...prev, pending].slice(-20);
    });
  }, []);

  const appendTranscriptDelta = useCallback((role: "user" | "agent", delta: string) => {
    if (!delta) return; // an empty chunk must never create a stray blank line
    const openRef = role === "user" ? openUserTurnRef : openAgentTurnRef;
    const otherRef = role === "user" ? openAgentTurnRef : openUserTurnRef;
    const currentText = pendingTranscriptRef.current?.role === role ? pendingTranscriptRef.current.text : "";
    const merged = openRef.current
      ? (delta.startsWith(currentText) ? delta : currentText + delta)
      : delta;
    pendingTranscriptRef.current = { role, text: merged };
    openRef.current = true;
    // A turn switching speaker implies the other role's utterance is done
    // — without this, a user chunk arriving after an agent turn could
    // otherwise still see openAgentTurnRef as stale-true from a much
    // earlier turn and wrongly merge into it later.
    otherRef.current = false;
    // Throttled, not per-chunk: Gemini can stream several transcription
    // deltas per second, and a React re-render on every single one
    // competes with the mic worklet's port.onmessage for main-thread
    // time, which can delay outgoing mic audio and make the whole
    // conversation feel laggy. 80ms is fast enough that the transcript
    // still reads as live, not fast enough to re-render on every chunk.
    if (!transcriptFlushTimerRef.current) {
      transcriptFlushTimerRef.current = setTimeout(flushTranscript, 80);
    }
  }, [flushTranscript]);

  const handleTool = useCallback(async (toolCall: any, session: any) => {
    const sid = activeSessionIdRef.current;
    const res: any[] = [];
    if (!sid) {
      // No session to act against — every tool call fails identically
      // rather than sending requests with a literal "null" session id.
      for (const fc of toolCall.functionCalls ?? []) {
        res.push({ id: fc.id, name: fc.name, response: { result: JSON.stringify({ success: false, error: "No active session" }) } });
      }
      session.sendToolResponse({ functionResponses: res });
      return;
    }
    const authToken = authTokenRef.current;
    for (const fc of toolCall.functionCalls ?? []) {
      let out: any = { success: false, error: "unknown" };
      try {
        if (fc.name === "search_catalog") out = await sanchayFetch("/api/catalog", sid, { q: String(fc.args?.query ?? ""), limit: Number(fc.args?.limit) || 5 }, authToken);
        else if (fc.name === "add_to_cart") {
          const productId = String(fc.args?.product_id ?? "");
          out = await sanchayFetch("/api/cart/add", sid, { product_id: productId, quantity: Number(fc.args?.quantity) || 1 }, authToken);
          const pw = productWindowsRef.current;
          if ((out as any)?.success && pw) {
            // A floating detail window for exactly this product has done
            // its job (the shopper decided: add it) — close it rather than
            // leaving it sitting open next to a bill that already reflects
            // the decision. Any OTHER still-open windows are deliberately
            // left alone but surfaced back to the model as
            // remainingOpenWindows, so the agent can ask whether the
            // shopper wants those added too or closed — never silently
            // decide either way on their behalf.
            pw.closeProduct(productId);
            const remaining = pw.getOpenProductIds();
            if (remaining.length > 0) {
              (out as any).data = { ...(out as any).data, remainingOpenWindows: remaining };
            }
          }
        }
        else if (fc.name === "remove_from_cart") {
          const b: any = { product_id: String(fc.args?.product_id) };
          if (fc.args?.quantity) b.quantity = Number(fc.args.quantity);
          out = await sanchayFetch("/api/cart/remove", sid, b, authToken);
        } else if (fc.name === "get_cart") out = await sanchayFetch("/api/cart", sid, {}, authToken);
        else if (fc.name === "checkout") {
          out = await sanchayFetch("/api/checkout", sid, {}, authToken);
          const d: any = (out as any).data;
          if (d?.orderId && onCheckoutSuccess) onCheckoutSuccess(d.orderId, d.amount);
        } else if (fc.name === "get_order_status") out = await sanchayFetch(`/api/order/${String(fc.args?.order_id)}`, sid, {}, authToken);
        else if (fc.name === "check_account_profile") {
          // GET, not POST — sanchayFetch is POST-only, so this is a plain
          // fetch with the same auth headers rather than reusing the helper.
          const r = await fetch(`${SANCHAY_BASE}/api/account/profile`, {
            headers: {
              "x-session-id": sid,
              ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            },
          });
          out = await r.json();
        }
        else if (fc.name === "check_payment_status") {
          // /api/cart already computes pendingOrder + lastOrder (see
          // getPendingOrder/getMostRecentOrder in src/api/logic.ts) fresh
          // on every read — reused here rather than adding a dedicated
          // endpoint for the same data.
          //
          // pendingOrder alone is ambiguous: once a payment succeeds it
          // correctly becomes null (nothing left to resume), but that
          // reads identically to "never checked out" or "reservation
          // expired" — with no further signal the model had no honest
          // basis to answer "did I pay?" except "no", even right after a
          // real successful payment. lastOrder (the most recent order of
          // ANY status) resolves that.
          const cartOut: any = await sanchayFetch("/api/cart", sid, {}, authToken);
          const pending = cartOut?.data?.pendingOrder ?? null;
          const lastOrder = cartOut?.data?.lastOrder ?? null;
          if (pending) {
            out = {
              success: true,
              data: {
                hasPendingPayment: true,
                amountDue: pending.amountPaise,
                expiresInSeconds: pending.expiresInSeconds,
                lastAttemptFailed: pending.lastAttemptFailed,
              },
            };
          } else if (lastOrder?.status === "paid") {
            out = { success: true, data: { hasPendingPayment: false, alreadyPaid: true, amountPaid: lastOrder.amountPaise } };
          } else if (lastOrder?.status === "cancelled") {
            out = { success: true, data: { hasPendingPayment: false, alreadyPaid: false, expired: true } };
          } else {
            out = { success: true, data: { hasPendingPayment: false, alreadyPaid: false } };
          }
        }
        else if (fc.name === "show_product_detail") {
          const pw = productWindowsRef.current;
          const rawIds = Array.isArray(fc.args?.product_ids) ? fc.args.product_ids.map((v: unknown) => String(v)) : [];
          if (!pw) out = { success: false, error: "Product windows are unavailable right now." };
          else if (rawIds.length === 0) out = { success: false, error: "product_ids is required — pass at least one exact id from a recent search." };
          else {
            const lookup: any = await sanchayFetch("/api/product-details", sid, { product_ids: rawIds }, authToken);
            if (!lookup?.success) out = lookup;
            else {
              const { opened, skippedAtCap, openProductNames } = pw.openProducts(lookup.data.products);
              out = {
                success: true,
                data: {
                  opened,
                  notFound: lookup.data.notFound,
                  skippedAtCap,
                  openProductNames,
                  atCap: skippedAtCap.length > 0,
                },
              };
            }
          }
        } else if (fc.name === "close_product_detail") {
          const pw = productWindowsRef.current;
          const productId = String(fc.args?.product_id ?? "").trim();
          if (!pw) out = { success: false, error: "Product windows are unavailable right now." };
          else if (!productId) out = { success: false, error: "product_id is required." };
          else {
            const closedId = pw.closeProduct(productId);
            out = closedId
              ? { success: true, data: { closedProductId: closedId } }
              : {
                success: false,
                error: `No open window matched "${productId}" — nothing was closed. Currently open: ${pw.getOpenProductIds().join(", ") || "none"}. Use one of those exact ids, or ask the shopper which one they mean if it's ambiguous.`,
              };
          }
        } else if (fc.name === "close_all_product_details") {
          const pw = productWindowsRef.current;
          if (!pw) out = { success: false, error: "Product windows are unavailable right now." };
          else {
            pw.closeAll();
            out = { success: true };
          }
        } else if (fc.name === "describe_product_images") {
          const pw = productWindowsRef.current;
          const explicitIds = Array.isArray(fc.args?.product_ids) ? fc.args.product_ids.map((v: unknown) => String(v)) : [];
          const question = typeof fc.args?.question === "string" ? fc.args.question : undefined;
          const idsToUse = explicitIds.length > 0 ? explicitIds : (pw?.getOpenProductIds() ?? []);
          if (idsToUse.length === 0) {
            out = { success: false, error: "Nothing to describe — no product ids were given and no product windows are open. Search for or open something first." };
          } else {
            out = await sanchayFetch("/api/describe-products", sid, { product_ids: idsToUse, question }, authToken);
            const d: any = out;
            // Thread the description into whichever open window(s) it was
            // actually about, so the detail window itself shows it too —
            // not just spoken aloud once and then gone.
            if (d?.success && pw) {
              for (const pid of d.data?.describedProductIds ?? []) {
                pw.setVisionDescription(pid, d.data.description);
              }
            }
          }
        }
        else if (fc.name === "save_user_name") {
          const nameArg = String(fc.args?.name ?? "").trim();
          out = nameArg
            ? await sanchayFetch("/api/user/name", sid, { name: nameArg }, authToken)
            : { success: false, error: "save_user_name called with no name — ask the shopper for their name first" };
        } else if (fc.name === "set_budget") {
          const clear = fc.args?.clear === true;
          out = clear
            ? await sanchayFetch("/api/session/budget", sid, { clear: true }, authToken)
            : await sanchayFetch("/api/session/budget", sid, { budget: Number(fc.args?.rupees) }, authToken);
        }
      } catch (e: any) { out = { success: false, error: String(e) }; }
      // Tool calls otherwise fail silently from the shopper's (and
      // developer's) point of view — Gemini gets the {success:false} back
      // and may still respond conversationally without surfacing the real
      // failure. Logging every call/args/result makes that diagnosable
      // instead of a mystery every time.
      if (out?.success === false) console.warn(`[gemini tool] ${fc.name} failed:`, fc.args, out);
      else console.debug(`[gemini tool] ${fc.name} ok:`, fc.args, out);
      res.push({ id: fc.id, name: fc.name, response: { result: JSON.stringify(out).slice(0, 4000) } });
    }
    session.sendToolResponse({ functionResponses: res });
  }, [onCheckoutSuccess]);

  const startCall = useCallback(async (sessionId: string) => {
    setError(null);
    hasGreetedRef.current = false;
    pausedRef.current = false;
    setIsPaused(false);
    setCallState("connecting");
    if (!sessionId) {
      // No silent no-op — a caller that starts a call with no session is a
      // bug in the caller (App.tsx's startTalking), not a recoverable
      // runtime state, and should be visible rather than swallowed.
      setError("No active session — can't start a call");
      setCallState("idle");
      return;
    }
    // Set immediately, synchronously, before anything async — this is the
    // ONE moment activeSessionIdRef is ever written, and it holds exactly
    // what the caller passed, nothing looked up or defaulted.
    activeSessionIdRef.current = sessionId;
    // A fresh call must never merge its first transcript chunk into
    // whatever turn was still "open" when the previous call ended.
    openUserTurnRef.current = false;
    openAgentTurnRef.current = false;
    pendingTranscriptRef.current = null;
    if (transcriptFlushTimerRef.current) { clearTimeout(transcriptFlushTimerRef.current); transcriptFlushTimerRef.current = null; }
    try {
      // Parallelize Gemini token fetch + known-name lookup — both are pure
      // reads against a session App.tsx has already confirmed is valid.
      const tokenPromise = (async () => {
        if (prefetchedRef.current && Date.now() < prefetchedRef.current.exp - 5000) {
          const t = prefetchedRef.current.token;
          prefetchedRef.current = null;
          return t;
        }
        const r = await fetch(`${SANCHAY_BASE}/api/gemini/token`, { method: "POST" });
        const j: any = await r.json();
        if (!j.success) throw new Error(j.error);
        return j.data.token as string;
      })();
      const [knownName, historySummary, viewedSummary, token] = await Promise.all([
        fetchKnownName(sessionId),
        fetchHistorySummary(sessionId),
        fetchViewedSummary(sessionId),
        tokenPromise,
      ]);
      const greetInstruction = knownName
        ? `Greet now in Hindi as instructed, using the name ${knownName}.`
        : "Greet now in Hindi as instructed.";
      const toolsAndBudgetLine =
        "Tools: search_catalog, add_to_cart, remove_from_cart, get_cart, checkout, get_order_status, check_payment_status, check_account_profile, show_product_detail, close_product_detail, close_all_product_details, describe_product_images, save_user_name, set_budget. Search first, speak price_display ₹, respect budget. If the shopper states or changes a spending cap out loud, call set_budget — a budget is only for THIS visit, never remembered for next time even if they're signed in, so never claim it will carry over. If they ask to remove a cap, call set_budget with clear=true. If they ask about a payment already in progress, call check_payment_status instead of checkout again — a checkout order is held for 15 minutes; after that it's released and a fresh checkout is needed. For 'did I pay before' / 'what have I bought' / order history in general, call check_account_profile — it needs no order id, so NEVER ask the shopper for an order id (almost nobody remembers one); only use get_order_status if they already volunteer a specific id themselves. Checkout requires being signed in — browsing and adding to cart work fine as a guest, but calling checkout will fail with success:false if they haven't signed in yet (get_cart's isSignedIn field tells you this in advance). If that happens, tell them their cart is saved and ask them to sign in from the panel on screen, then try checkout again — never say the cart was lost. checkout succeeding does NOT open the payment window — tell them to tap 'Resume payment' on screen to open it, never claim it's already open.";
      // Purely background context, never something to announce unprompted
      // — mentioning a past purchase should feel like a shopkeeper who
      // remembers a regular, not a recitation of records. Use it only if
      // it's naturally relevant (e.g. they ask "what did I buy last time",
      // or it helps a cross-sell/recommendation land better).
      const historyLine = historySummary
        ? ` ${historySummary} Only bring this up if it's naturally relevant — never announce it unprompted at the start of the call.`
        : "";
      const viewedLine = viewedSummary
        ? ` ${viewedSummary} Only bring this up if it's naturally relevant (e.g. they seem undecided, or ask what they were just looking at) — never announce it unprompted, and never make them feel watched.`
        : "";
      const systemInstruction = knownName
        ? `You are Sanchay, warm Indian shopping assistant. This shopper's name is ${knownName} — greet FIRST in Hindi using it, e.g. 'Namaste ${knownName}! Sanchay mein aapka swagat hai — bataiye kya dekhna chahenge?' Do NOT ask for their name again, you already know it. Then detect user's language and continue in that language. Be concise 1-2 sentences. ${toolsAndBudgetLine}${historyLine}${viewedLine}`
        : `You are Sanchay, warm Indian shopping assistant. Greet FIRST in Hindi: 'Namaste! Sanchay mein aapka swagat hai — bataiye kya dekhna chahenge? Aapka naam kya hai?' If you don't know name, ask once and MUST call save_user_name with first name they give before continuing. Then detect user's language and continue in that language. Be concise 1-2 sentences. ${toolsAndBudgetLine}${historyLine}${viewedLine}`;
      const ai = new GoogleGenAI({ apiKey: token!, httpOptions: { apiVersion: "v1alpha" } } as any);
      const session: any = await (ai as any).live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: { parts: [{ text: systemInstruction }] },
          tools: sanchayTools,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setCallState("connecting");
            if (!hasGreetedRef.current) {
              try {
                session.sendRealtimeInput({ text: greetInstruction });
                hasGreetedRef.current = true;
              } catch { }
            }
          },
          onmessage: async (msg: any) => {
            const isSetup = (msg as any).setupComplete || msg.serverContent?.setupComplete || (msg as any).type === "setupComplete";
            if (isSetup && !hasGreetedRef.current) {
              try {
                session.sendRealtimeInput({ text: greetInstruction });
                hasGreetedRef.current = true;
              } catch { }
              return;
            }
            // Exactly once per message — a message carrying BOTH toolCall
            // and serverContent used to run handleTool up to three times
            // over (this check, repeated further down, and once more at
            // the end of this branch), meaning add_to_cart/checkout/
            // set_budget could each execute multiple times for a single
            // spoken action, not just log multiple times. Handled once
            // here; serverContent (audio/transcripts) still processes
            // independently below in case a message ever carries both.
            if (msg.toolCall) await handleTool(msg.toolCall, session);
            const c = msg.serverContent;
            if (!c) return;
            if (c.modelTurn?.parts) {
              for (const p of c.modelTurn.parts) {
                if (p.inlineData?.data) await playPcm(p.inlineData.data);
                // Deliberately NOT feeding p.text into the transcript.
                // With outputAudioTranscription configured (below),
                // outputTranscription.text is the authoritative transcript
                // source — modelTurn.parts[].text is a second, independent
                // representation of the same speech that can occasionally
                // arrive too, with different chunk boundaries. Merging both
                // into one accumulator caused the same sentence to appear
                // twice when their chunks didn't line up as clean prefixes
                // of each other.
              }
            }
            if (c.inputTranscription?.text) appendTranscriptDelta("user", c.inputTranscription.text);
            if (c.outputTranscription?.text) appendTranscriptDelta("agent", c.outputTranscription.text);
            // turnComplete closes out whichever side just finished — the
            // NEXT chunk for that role must start a fresh entry rather
            // than keep appending to a turn that's actually over (e.g. two
            // separate things the shopper says shouldn't run together on
            // one line just because both were transcribed as "user").
            if (c.turnComplete) {
              // Flush WHILE the turn is still marked open — flushTranscript
              // itself reads openUserTurnRef/openAgentTurnRef to decide
              // "append to the last line" vs "push a new line". Clearing
              // the flag before this flush made every finished turn's
              // final flush see the flag already false and push a
              // duplicate second entry instead of merging into the one
              // built up during the throttled flushes.
              if (transcriptFlushTimerRef.current) { clearTimeout(transcriptFlushTimerRef.current); }
              flushTranscript();
              openUserTurnRef.current = false;
              openAgentTurnRef.current = false;
            }
            if (c.interrupted) {
              if (playCtxRef.current) playTimeRef.current = playCtxRef.current.currentTime;
              // An interruption ends the agent's turn early (cut off
              // mid-sentence) — same ordering fix as turnComplete above.
              if (transcriptFlushTimerRef.current) { clearTimeout(transcriptFlushTimerRef.current); }
              flushTranscript();
              openAgentTurnRef.current = false;
            }
          },
          onerror: (e: any) => { setError(e?.message ?? "Live error"); setCallState("idle"); },
          onclose: () => setCallState("idle"),
        },
      });
      sessionRef.current = session;
      setTimeout(() => {
        if (!hasGreetedRef.current && sessionRef.current) {
          try {
            session.sendRealtimeInput({ text: greetInstruction });
            hasGreetedRef.current = true;
          } catch { }
        }
      }, 1200);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      streamRef.current = stream;
      const ctx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = ctx;
      if (ctx.state === "suspended") await ctx.resume();
      await ctx.audioWorklet.addModule("/pcm-worklet.js");
      const w = new AudioWorkletNode(ctx, "pcm-capture");
      workletRef.current = w;
      w.port.onmessage = (e: MessageEvent) => {
        if (pausedRef.current) return; // mic frames dropped entirely while paused — nothing sent to Gemini
        const b = e.data as ArrayBuffer;
        if (!b?.byteLength) return;
        const b64 = btoa(String.fromCharCode(...new Uint8Array(b)));
        session.sendRealtimeInput({ audio: { data: b64, mimeType: "audio/pcm;rate=16000" } });
      };
      const micSource = ctx.createMediaStreamSource(stream);
      micSource.connect(w);
      const micAnalyser = ctx.createAnalyser();
      micAnalyser.fftSize = 256;
      // Read-only tap — never connected to destination, so it can't create
      // a local feedback loop.
      micSource.connect(micAnalyser);
      micAnalyserRef.current = micAnalyser;
      startLevelPump();
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setCallState("idle");
    }
  }, [handleTool, playPcm, startLevelPump]);

  const stopCall = useCallback(() => {
    hasGreetedRef.current = false;
    pausedRef.current = false;
    setIsPaused(false);
    try { sessionRef.current?.close(); } catch { }
    sessionRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    try { audioCtxRef.current?.close(); } catch { }
    audioCtxRef.current = null;
    try { playCtxRef.current?.close(); } catch { }
    playCtxRef.current = null;
    workletRef.current = null;
    micAnalyserRef.current = null;
    agentAnalyserRef.current = null;
    stopLevelPump();
    if (speakTimerRef.current) clearTimeout(speakTimerRef.current);
    setCallState("idle");
    openUserTurnRef.current = false;
    openAgentTurnRef.current = false;
    pendingTranscriptRef.current = null;
    if (transcriptFlushTimerRef.current) { clearTimeout(transcriptFlushTimerRef.current); transcriptFlushTimerRef.current = null; }
    // Ends this call's claim on the session it was using. This hook holds
    // no session state between calls — the next startCall() always
    // receives a fresh session id argument from App.tsx, the single owner
    // of session identity, rather than this ref persisting or being read
    // back out by the caller.
    activeSessionIdRef.current = null;
  }, [stopLevelPump]);

  const dismissError = useCallback(() => setError(null), []);
  useEffect(() => () => stopCall(), [stopCall]);

  /**
   * Pauses the mic without ending the call — the WebSocket connection and
   * everything Gemini already knows (cart contents, name, prior turns) stay
   * exactly as they are. Two things happen, both reversible instantly:
   *  1. The actual MediaStreamTrack is disabled (not just its data dropped
   *     in the worklet callback) — a disabled track outputs silence to
   *     every downstream tap, so the mic level meter correctly reads zero
   *     while paused rather than visibly moving with no audio actually
   *     being sent, which would look broken.
   *  2. audioStreamEnd is sent, per Gemini's own guidance for pausing an
   *     audio stream for more than ~1s — it flushes any partial audio
   *     already buffered server-side so a resumed stream starts clean
   *     rather than replaying a stale fragment.
   * Does nothing to the agent's own in-flight speech — if it's mid-sentence
   * when paused, it finishes naturally; pausing only stops NEW input from
   * being sent, so no new turn starts until resumeCall.
   */
  const pauseCall = useCallback(() => {
    if (!sessionRef.current || pausedRef.current) return;
    pausedRef.current = true;
    setIsPaused(true);
    streamRef.current?.getAudioTracks().forEach((t) => { t.enabled = false; });
    try { sessionRef.current.sendRealtimeInput({ audioStreamEnd: true }); } catch { }
  }, []);

  const resumeCall = useCallback(() => {
    if (!sessionRef.current || !pausedRef.current) return;
    pausedRef.current = false;
    setIsPaused(false);
    streamRef.current?.getAudioTracks().forEach((t) => { t.enabled = true; });
    // No explicit "resume" message exists or is needed — per Gemini's docs,
    // the client can resume sending audio data at any time; the very next
    // worklet frame (now unblocked by pausedRef being false) does that.
  }, []);

  return {
    callState, transcripts, error, micLevel, agentLevel, isPaused,
    startCall, stopCall, pauseCall, resumeCall, dismissError, prefetchToken, setAuthToken, setActiveSessionId,
  };
}
