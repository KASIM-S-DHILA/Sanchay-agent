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
      { name: "save_user_name", description: "Save shopper's first name after asking. Call once.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
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

export function useGeminiLive(sessionId: string | null, onCheckoutSuccess?: (orderId: string, amount: number) => void) {
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
  const sanchaySidRef = useRef<string | null>(sessionId);
  const hasGreetedRef = useRef(false);
  const prefetchedRef = useRef<{ token: string; exp: number } | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playCtxRef = useRef<AudioContext | null>(null);
  const playTimeRef = useRef(0);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const speakTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { sanchaySidRef.current = sessionId; }, [sessionId]);
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

  const ensureSession = useCallback(async () => {
    if (sanchaySidRef.current) return sanchaySidRef.current;
    const r = await fetch(`${SANCHAY_BASE}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_email: `gemini-${Date.now()}@live.local` }),
    });
    const j: any = await r.json();
    const sid = j.data?.sessionId as string;
    sanchaySidRef.current = sid;
    return sid;
  }, []);

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

  const handleTool = useCallback(async (toolCall: any, session: any) => {
    const sid = await ensureSession();
    const res: any[] = [];
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
        else if (fc.name === "save_user_name") out = await sanchayFetch("/api/user/name", sid, { name: String(fc.args?.name ?? "") });
      } catch (e: any) { out = { success: false, error: String(e) }; }
      res.push({ id: fc.id, name: fc.name, response: { result: JSON.stringify(out).slice(0, 4000) } });
    }
    session.sendToolResponse({ functionResponses: res });
  }, [ensureSession, onCheckoutSuccess]);

  const startCall = useCallback(async () => {
    setError(null);
    hasGreetedRef.current = false;
    setCallState("connecting");
    try {
      // Parallelize Sanchay session + Gemini token — saves ~600ms vs sequential
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
      const [sid, token] = await Promise.all([ensureSession(), tokenPromise]);
      const ai = new GoogleGenAI({ apiKey: token!, httpOptions: { apiVersion: "v1alpha" } } as any);
      const session: any = await (ai as any).live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: { parts: [{ text: "You are Sanchay, warm Indian shopping assistant. Greet FIRST in Hindi: 'Namaste! Sanchay mein aapka swagat hai — bataiye kya dekhna chahenge? Aapka naam kya hai?' If you don't know name, ask once and MUST call save_user_name with first name they give before continuing. Then detect user's language and continue in that language. Be concise 1-2 sentences. Tools: search_catalog, add_to_cart, remove_from_cart, get_cart, checkout, get_order_status, save_user_name. Search first, speak price_display ₹, respect budget." }] },
          tools: sanchayTools,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setCallState("connecting");
            if (!hasGreetedRef.current) {
              try {
                session.sendRealtimeInput({ text: "Greet now in Hindi as instructed." });
                hasGreetedRef.current = true;
              } catch { }
            }
          },
          onmessage: async (msg: any) => {
            const isSetup = (msg as any).setupComplete || msg.serverContent?.setupComplete || (msg as any).type === "setupComplete";
            if (isSetup && !hasGreetedRef.current) {
              try {
                session.sendRealtimeInput({ text: "Greet now in Hindi as instructed." });
                hasGreetedRef.current = true;
              } catch { }
              return;
            }
            if (msg.toolCall) await handleTool(msg.toolCall, session);
            const c = msg.serverContent;
            if (!c) return;
            if ((msg as any).toolCall) await handleTool((msg as any).toolCall, session);
            if (c.modelTurn?.parts) {
              for (const p of c.modelTurn.parts) {
                if (p.inlineData?.data) await playPcm(p.inlineData.data);
                if (p.text) setTranscripts(prev => [...prev.slice(-20), { role: "agent", text: p.text }]);
              }
            }
            if (c.inputTranscription?.text) setTranscripts(prev => [...prev.slice(-20), { role: "user", text: c.inputTranscription.text }]);
            if (c.outputTranscription?.text) setTranscripts(prev => [...prev.slice(-20), { role: "agent", text: c.outputTranscription.text }]);
            if (c.interrupted) { if (playCtxRef.current) playTimeRef.current = playCtxRef.current.currentTime; }
            if (msg.toolCall) await handleTool(msg.toolCall, session);
          },
          onerror: (e: any) => { setError(e?.message ?? "Live error"); setCallState("idle"); },
          onclose: () => setCallState("idle"),
        },
      });
      sessionRef.current = session;
      setTimeout(() => {
        if (!hasGreetedRef.current && sessionRef.current) {
          try {
            session.sendRealtimeInput({ text: "Greet now in Hindi as instructed." });
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
  }, [ensureSession, handleTool, playPcm, startLevelPump]);

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
  }, [stopLevelPump]);

  const dismissError = useCallback(() => setError(null), []);
  useEffect(() => () => stopCall(), [stopCall]);

  return {
    callState, transcripts, error, micLevel, agentLevel,
    sessionId: sanchaySidRef.current ?? sessionId ?? null,
    startCall: startCall as unknown as (sid?: string, email?: string) => Promise<void>,
    stopCall, dismissError, prefetchToken, sanchaySessionId: sanchaySidRef.current,
  };
}
