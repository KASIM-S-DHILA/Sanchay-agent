import { useCallback, useEffect, useRef, useState } from "react";
import { GoogleGenAI, Modality } from "@google/genai";

// ponytail: 16k mic → Gemini Live 24k out, tool use synchronous per docs
type CallState = "idle" | "connecting" | "listening" | "speaking";
export interface Transcript { role: "user" | "agent"; text: string; }

const SANCHAY_BASE = ""; // same origin — Worker proxies to Sanchay D1
const MODEL = "gemini-3.1-flash-live-preview";

// Sanchay function declarations — mirrors src/api/tools (AGENT_TOOL_SCHEMAS)
const sanchayTools = [
  {
    functionDeclarations: [
      {
        name: "search_catalog",
        description: "Search apparel catalog. Always call first on product mentions. Returns price_display.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Free text like 'gray hoodie'" },
            limit: { type: "integer", description: "1-20 default 5" },
          },
          required: ["query"],
        },
      },
      {
        name: "add_to_cart",
        description: "Add exact catalog id to cart. 1-99 qty.",
        parameters: {
          type: "object",
          properties: {
            product_id: { type: "string", description: "Id from search_catalog, e.g. HOODIE-GRAY-001" },
            quantity: { type: "integer", description: "1-99 default 1" },
          },
          required: ["product_id"],
        },
      },
      {
        name: "remove_from_cart",
        description: "Remove/decrement from cart. Omit quantity to delete whole line.",
        parameters: {
          type: "object",
          properties: {
            product_id: { type: "string" },
            quantity: { type: "integer" },
          },
          required: ["product_id"],
        },
      },
      {
        name: "get_cart",
        description: "Get cart summary (items, total_display, count).",
        parameters: { type: "object", properties: {}, required: [] },
      },
      {
        name: "checkout",
        description: "Create Razorpay order. Gated — only after confirmation.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      {
        name: "get_order_status",
        description: "Check order by orderId from checkout.",
        parameters: {
          type: "object",
          properties: { order_id: { type: "string" } },
          required: ["order_id"],
        },
      },
    ],
  },
];

async function sanchayFetch(
  path: string,
  sessionId: string,
  body: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const r = await fetch(`${SANCHAY_BASE}${path}`, {
    method: "POST",
    headers: { "x-session-id": sessionId, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await r.json()) as Record<string, unknown>;
}

export function useGeminiLive(
  sessionId: string | null,
  onCheckoutSuccess?: (orderId: string, amount: number) => void
) {
  const [callState, setCallState] = useState<CallState>("idle");
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [micLevel] = useState(0);
  const [agentLevel] = useState(0);

  const sessionRef = useRef<any>(null);
  const sanchaySidRef = useRef<string | null>(sessionId);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playCtxRef = useRef<AudioContext | null>(null);
  const playTimeRef = useRef(0);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const speakTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioQueueRef = useRef<ArrayBuffer[]>([]);

  // Keep Sanchay session in sync with prop
  useEffect(() => {
    sanchaySidRef.current = sessionId;
  }, [sessionId]);

  const ensureSanchaySession = useCallback(async (): Promise<string> => {
    if (sanchaySidRef.current) return sanchaySidRef.current;
    const r = await fetch(`${SANCHAY_BASE}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_email: `gemini-${Date.now()}@live.local` }),
    });
    const data: any = await r.json();
    const sid = data.data?.sessionId as string;
    sanchaySidRef.current = sid;
    return sid;
  }, []);

  const playPcmChunk = useCallback(async (base64: string) => {
    // Gemini output is 24k PCM per spec
    if (!playCtxRef.current) {
      playCtxRef.current = new AudioContext({ sampleRate: 24000 });
      playTimeRef.current = playCtxRef.current.currentTime;
    }
    const ctx = playCtxRef.current;
    if (ctx.state === "suspended") await ctx.resume();
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const pcm = new Int16Array(bytes.buffer);
    if (pcm.length === 0) return;
    const float = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) float[i] = pcm[i] / 0x8000;
    const buf = ctx.createBuffer(1, float.length, 24000);
    buf.getChannelData(0).set(float);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const when = Math.max(playTimeRef.current, ctx.currentTime);
    src.start(when);
    playTimeRef.current = when + buf.duration;
    setCallState("speaking");
    if (speakTimerRef.current) clearTimeout(speakTimerRef.current);
    speakTimerRef.current = setTimeout(() => setCallState("listening"), 900);
  }, []);

  const handleToolCall = useCallback(
    async (toolCall: any, session: any) => {
      const sid = await ensureSanchaySession();
      const responses: any[] = [];
      for (const fc of toolCall.functionCalls ?? []) {
        const name: string = fc.name;
        const args: Record<string, unknown> = fc.args ?? {};
        let result: Record<string, unknown> = { success: false, error: "unknown tool" };
        try {
          if (name === "search_catalog") result = await sanchayFetch("/api/catalog", sid, { q: String(args.query ?? ""), limit: Number(args.limit) || 5 });
          else if (name === "add_to_cart") result = await sanchayFetch("/api/cart/add", sid, { product_id: String(args.product_id), quantity: Number(args.quantity) || 1 });
          else if (name === "remove_from_cart") {
            const b: Record<string, unknown> = { product_id: String(args.product_id) };
            if (args.quantity) b.quantity = Number(args.quantity);
            result = await sanchayFetch("/api/cart/remove", sid, b);
          } else if (name === "get_cart") result = await sanchayFetch("/api/cart", sid, {});
          else if (name === "checkout") {
            result = await sanchayFetch("/api/checkout", sid, {});
            const d: any = (result as any).data;
            if (d?.orderId && d?.amount && onCheckoutSuccess) onCheckoutSuccess(d.orderId, d.amount);
          } else if (name === "get_order_status") result = await sanchayFetch(`/api/order/${String(args.order_id)}`, sid, {});
        } catch (e: any) {
          result = { success: false, error: String(e?.message ?? e) };
        }
        responses.push({ id: fc.id, name: fc.name, response: { result: JSON.stringify(result).slice(0, 4000) } });
      }
      // REQUIRED: manual send_tool_response — Gemini Live does not auto-handle
      session.sendToolResponse({ functionResponses: responses });
    },
    [ensureSanchaySession, onCheckoutSuccess]
  );

  const startCall = useCallback(async () => {
    setError(null);
    setCallState("connecting");
    try {
      const sid = await ensureSanchaySession();

      // 1. Ephemeral token from Worker (server holds GEMINI_API_KEY)
      const tokenRes = await fetch(`${SANCHAY_BASE}/api/gemini/token`, { method: "POST" });
      const tokenData: any = await tokenRes.json();
      if (!tokenData.success) throw new Error(tokenData.error ?? "Token creation failed");
      const tokenName: string = tokenData.data.token; // "auth_tokens/xxx"

      // 2. Connect Live API with token as apiKey, v1alpha
      const ai = new GoogleGenAI({ apiKey: tokenName, httpOptions: { apiVersion: "v1alpha" } } as any);

      const session: any = await (ai as any).live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: {
            parts: [
              {
                text:
                  "You are Sanchay, a warm Indian shopping assistant. Speak Hindi/English as shopper speaks, 1-2 sentences. " +
                  "You have tools: search_catalog, add_to_cart, remove_from_cart, get_cart, checkout, get_order_status. " +
                  "Search first, never invent ids, speak price_display (₹) not paise, respect budgetRemaining, gated checkout.",
              },
            ],
          },
          tools: sanchayTools,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setCallState("listening");
          },
          onmessage: async (msg: any) => {
            const content = msg.serverContent;
            if (!content) {
              if (msg.toolCall) await handleToolCall(msg.toolCall, session);
              return;
            }
            // Tool call can also be in serverContent? Handle both
            if ((msg as any).toolCall) await handleToolCall((msg as any).toolCall, session);

            // Process ALL parts — audio + transcript in same event
            if (content.modelTurn?.parts) {
              for (const part of content.modelTurn.parts) {
                if (part.inlineData?.data) {
                  await playPcmChunk(part.inlineData.data as string);
                }
                if (part.text) {
                  setTranscripts((prev) => [...prev.slice(-20), { role: "agent", text: part.text }]);
                }
              }
            }
            if (content.inputTranscription?.text) {
              setTranscripts((prev) => [...prev.slice(-20), { role: "user", text: content.inputTranscription.text }]);
            }
            if (content.outputTranscription?.text) {
              setTranscripts((prev) => [...prev.slice(-20), { role: "agent", text: content.outputTranscription.text }]);
            }
            if (content.interrupted) {
              // Clear playback queue on interruption
              audioQueueRef.current = [];
              if (playCtxRef.current) playTimeRef.current = playCtxRef.current.currentTime;
            }
            if (msg.toolCall) await handleToolCall(msg.toolCall, session);
          },
          onerror: (e: any) => {
            setError(e?.message ?? "Live API error");
            setCallState("idle");
          },
          onclose: () => setCallState("idle"),
        },
      });

      sessionRef.current = session;

      // 3. Mic capture — 16k PCM little-endian
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const ctx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = ctx;
      await ctx.audioWorklet.addModule("/pcm-worklet.js");
      const worklet = new AudioWorkletNode(ctx, "pcm-capture");
      workletRef.current = worklet;
      worklet.port.onmessage = (e: MessageEvent) => {
        const buf = e.data as ArrayBuffer;
        if (!buf || buf.byteLength === 0) return;
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        // send_realtime_input for audio — not send_client_content
        session.sendRealtimeInput({ audio: { data: b64, mimeType: "audio/pcm;rate=16000" } });
      };
      ctx.createMediaStreamSource(stream).connect(worklet);
      setCallState("listening");
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setCallState("idle");
    }
  }, [ensureSanchaySession, handleToolCall, playPcmChunk]);

  const stopCall = useCallback(() => {
    try { sessionRef.current?.close(); } catch {}
    sessionRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
    if (playCtxRef.current) {
      try { playCtxRef.current.close(); } catch {}
      playCtxRef.current = null;
    }
    workletRef.current = null;
    if (speakTimerRef.current) clearTimeout(speakTimerRef.current);
    setCallState("idle");
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  useEffect(() => () => stopCall(), [stopCall]);

  // Compat with old VoiceDock/useVoiceCall shape — App expects sessionId field
  const sessionIdCompat = sanchaySidRef.current ?? sessionId ?? null;

  return {
    callState,
    transcripts,
    error,
    micLevel,
    agentLevel,
    sessionId: sessionIdCompat,
    startCall: startCall as unknown as (sid?: string, email?: string) => Promise<void>,
    stopCall,
    dismissError,
    sanchaySessionId: sanchaySidRef.current,
  };
}
