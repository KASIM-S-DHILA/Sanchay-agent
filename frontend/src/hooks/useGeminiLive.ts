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
        description: "Add exact catalog id to cart. 1-99 qty.",
        parameters: { type: "object", properties: { product_id: { type: "string" }, quantity: { type: "integer" } }, required: ["product_id"] },
      },
      {
        name: "remove_from_cart",
        description: "Remove/decrement from cart.",
        parameters: { type: "object", properties: { product_id: { type: "string" }, quantity: { type: "integer" } }, required: ["product_id"] },
      },
      { name: "get_cart", description: "Get cart summary.", parameters: { type: "object", properties: {}, required: [] } },
      { name: "checkout", description: "Create Razorpay order.", parameters: { type: "object", properties: {}, required: [] } },
      { name: "get_order_status", description: "Check order.", parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] } },
      {
        name: "check_payment_status",
        description:
          "Check whether the shopper has a payment currently in progress (created a Razorpay order but hasn't finished paying yet). Call this if they ask 'is my payment pending', 'did my payment go through', 'how much time do I have left to pay', or similar — do NOT call checkout again just to answer this. Returns whether one exists, how much is due, how many seconds remain before the reservation expires, and whether their last attempt failed.",
        parameters: { type: "object", properties: {}, required: [] },
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

async function sanchayFetch(path: string, sessionId: string, body: Record<string, unknown> = {}) {
  const r = await fetch(`${SANCHAY_BASE}${path}`, {
    method: "POST",
    headers: { "x-session-id": sessionId, "Content-Type": "application/json" },
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
export function useGeminiLive(onCheckoutSuccess?: (orderId: string, amount: number) => void) {
  const [callState, setCallState] = useState<CallState>("idle");
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
   *  by handleTool/fetchKnownName, cleared by stopCall. Never anything else. */
  const activeSessionIdRef = useRef<string | null>(null);
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
    for (const fc of toolCall.functionCalls ?? []) {
      let out: any = { success: false, error: "unknown" };
      try {
        if (fc.name === "search_catalog") out = await sanchayFetch("/api/catalog", sid, { q: String(fc.args?.query ?? ""), limit: Number(fc.args?.limit) || 5 });
        else if (fc.name === "add_to_cart") out = await sanchayFetch("/api/cart/add", sid, { product_id: String(fc.args?.product_id), quantity: Number(fc.args?.quantity) || 1 });
        else if (fc.name === "remove_from_cart") {
          const b: any = { product_id: String(fc.args?.product_id) };
          if (fc.args?.quantity) b.quantity = Number(fc.args.quantity);
          out = await sanchayFetch("/api/cart/remove", sid, b);
        } else if (fc.name === "get_cart") out = await sanchayFetch("/api/cart", sid, {});
        else if (fc.name === "checkout") {
          out = await sanchayFetch("/api/checkout", sid, {});
          const d: any = (out as any).data;
          if (d?.orderId && onCheckoutSuccess) onCheckoutSuccess(d.orderId, d.amount);
        } else if (fc.name === "get_order_status") out = await sanchayFetch(`/api/order/${String(fc.args?.order_id)}`, sid, {});
        else if (fc.name === "check_payment_status") {
          // /api/cart already computes pendingOrder (see getPendingOrder in
          // src/api/logic.ts) fresh on every read — reused here rather than
          // adding a dedicated endpoint for the same data.
          const cartOut: any = await sanchayFetch("/api/cart", sid, {});
          const pending = cartOut?.data?.pendingOrder ?? null;
          out = pending
            ? {
              success: true,
              data: {
                hasPendingPayment: true,
                amountDue: pending.amountPaise,
                expiresInSeconds: pending.expiresInSeconds,
                lastAttemptFailed: pending.lastAttemptFailed,
              },
            }
            : { success: true, data: { hasPendingPayment: false } };
        }
        else if (fc.name === "save_user_name") {
          const nameArg = String(fc.args?.name ?? "").trim();
          out = nameArg
            ? await sanchayFetch("/api/user/name", sid, { name: nameArg })
            : { success: false, error: "save_user_name called with no name — ask the shopper for their name first" };
        } else if (fc.name === "set_budget") {
          const clear = fc.args?.clear === true;
          out = clear
            ? await sanchayFetch("/api/session/budget", sid, { clear: true })
            : await sanchayFetch("/api/session/budget", sid, { budget: Number(fc.args?.rupees) });
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
      const [knownName, historySummary, token] = await Promise.all([
        fetchKnownName(sessionId),
        fetchHistorySummary(sessionId),
        tokenPromise,
      ]);
      const greetInstruction = knownName
        ? `Greet now in Hindi as instructed, using the name ${knownName}.`
        : "Greet now in Hindi as instructed.";
      const toolsAndBudgetLine =
        "Tools: search_catalog, add_to_cart, remove_from_cart, get_cart, checkout, get_order_status, check_payment_status, save_user_name, set_budget. Search first, speak price_display ₹, respect budget. If the shopper states or changes a spending cap out loud, call set_budget — a budget is only for THIS visit, never remembered for next time even if they're signed in, so never claim it will carry over. If they ask to remove a cap, call set_budget with clear=true. If they ask about a payment already in progress, call check_payment_status instead of checkout again — a checkout order is held for 15 minutes; after that it's released and a fresh checkout is needed.";
      // Purely background context, never something to announce unprompted
      // — mentioning a past purchase should feel like a shopkeeper who
      // remembers a regular, not a recitation of records. Use it only if
      // it's naturally relevant (e.g. they ask "what did I buy last time",
      // or it helps a cross-sell/recommendation land better).
      const historyLine = historySummary
        ? ` ${historySummary} Only bring this up if it's naturally relevant — never announce it unprompted at the start of the call.`
        : "";
      const systemInstruction = knownName
        ? `You are Sanchay, warm Indian shopping assistant. This shopper's name is ${knownName} — greet FIRST in Hindi using it, e.g. 'Namaste ${knownName}! Sanchay mein aapka swagat hai — bataiye kya dekhna chahenge?' Do NOT ask for their name again, you already know it. Then detect user's language and continue in that language. Be concise 1-2 sentences. ${toolsAndBudgetLine}${historyLine}`
        : `You are Sanchay, warm Indian shopping assistant. Greet FIRST in Hindi: 'Namaste! Sanchay mein aapka swagat hai — bataiye kya dekhna chahenge? Aapka naam kya hai?' If you don't know name, ask once and MUST call save_user_name with first name they give before continuing. Then detect user's language and continue in that language. Be concise 1-2 sentences. ${toolsAndBudgetLine}${historyLine}`;
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

  return {
    callState, transcripts, error, micLevel, agentLevel,
    startCall, stopCall, dismissError, prefetchToken,
  };
}
