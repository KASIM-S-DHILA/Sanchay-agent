import { useState, useRef, useCallback, useEffect } from "react";

type CallState = "idle" | "connecting" | "listening" | "speaking";

export interface TranscriptEntry {
  role: "user" | "agent";
  text: string;
}

interface ToolExecutedMsg {
  tool: string;
  result: { success?: boolean; data?: { orderId?: string; amount?: number; paymentUrl?: string } };
}

export function useVoiceCall(onCheckoutSuccess?: (orderId: string, amount: number) => void) {
  const [callState, setCallState] = useState<CallState>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const playTimeRef = useRef(0);
  const speakTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByUserRef = useRef(false);

  const cleanupAudio = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    workletRef.current?.disconnect();
    workletRef.current = null;
    try { audioCtxRef.current?.close(); } catch { }
    audioCtxRef.current = null;
    // Let playback context drain naturally
  }, []);

  const stopCall = useCallback(() => {
    closedByUserRef.current = true;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop" }));
    }
    wsRef.current?.close();
    cleanupAudio();
    setCallState("idle");
  }, [cleanupAudio]);

  const startCall = useCallback(async (existingSessionId?: string | null, email?: string) => {
    setError(null);
    setCallState("connecting");
    closedByUserRef.current = false;

    // 1. WebSocket to Worker bridge — pass the browser's existing session
    // (if any) so voice reuses the same cart/audit/budget session instead
    // of the bridge minting a second, disconnected one.
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = new URL(`${proto}//${window.location.host}/voice`);
    if (existingSessionId) wsUrl.searchParams.set("session_id", existingSessionId);
    if (email) wsUrl.searchParams.set("email", email);
    const ws = new WebSocket(wsUrl.toString());
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onmessage = async (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        // Raw Int16 PCM audio → schedule playback
        await playPcmChunk(event.data);
        // Speaking while chunks flow; back to listening after a short gap
        setCallState("speaking");
        if (speakTimerRef.current) clearTimeout(speakTimerRef.current);
        speakTimerRef.current = setTimeout(() => setCallState("listening"), 900);
        return;
      }
      try {
        const msg = JSON.parse(String(event.data));
        switch (msg.type) {
          case "session_id":
            setSessionId(msg.session_id);
            break;
          case "state":
            if (msg.state === "listening" || msg.state === "speaking") {
              setCallState(msg.state);
            }
            break;
          case "transcript":
            if (msg.text) {
              setTranscripts((prev) => [...prev.slice(-20), { role: "user", text: msg.text }]);
            }
            break;
          case "agent_text":
            if (msg.text) {
              setTranscripts((prev) => [...prev.slice(-20), { role: "agent", text: msg.text }]);
            }
            break;
          case "tool_executed":
            // Tool executed in-process — audit trail updated server-side
            break;
          case "checkout_ready": {
            // Voice checkout succeeded — trigger Razorpay modal
            const orderId = msg.orderId as string;
            const amount = msg.amount as number;
            if (orderId && amount && onCheckoutSuccess) {
              onCheckoutSuccess(orderId, amount);
            }
            break;
          }
          case "error":
            setError(msg.message ?? "Voice error");
            break;
          case "call_ended":
            setCallState("idle");
            break;
        }
      } catch { }
    };

    ws.onclose = () => {
      cleanupAudio();
      setCallState("idle");
    };
    ws.onerror = () => {
      setError("WebSocket connection failed");
      setCallState("idle");
    };

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WS open timeout")), 15000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WS error")); });
    });

    // 2. Mic capture — AudioWorklet PCM 16kHz mono
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
      if (ws.readyState === WebSocket.OPEN) ws.send(e.data as ArrayBuffer);
    };
    ctx.createMediaStreamSource(stream).connect(worklet);
    // Don't connect worklet to destination (no local feedback loop)

    setCallState("listening");
  }, [cleanupAudio, onCheckoutSuccess]);

  const playPcmChunk = async (data: ArrayBuffer) => {
    // Lazy-create a playback context at Sarvam's output rate (22050 Hz —
    // declared via output_sample_rate on the signed WS URL)
    if (!playCtxRef.current) {
      playCtxRef.current = new AudioContext({ sampleRate: 22050 });
      playTimeRef.current = playCtxRef.current.currentTime;
    }
    const ctx = playCtxRef.current;

    const pcm = new Int16Array(data);
    if (pcm.length === 0) return;
    const float32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) float32[i] = pcm[i] / 0x8000;

    const buffer = ctx.createBuffer(1, float32.length, ctx.sampleRate);
    buffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    // Sequential scheduling to avoid overlap
    playTimeRef.current = Math.max(playTimeRef.current, ctx.currentTime);
    source.start(playTimeRef.current);
    playTimeRef.current += buffer.duration;

    // Drain back to LISTENING when playback queue empties
    setTimeout(() => {
      if (playCtxRef.current && ctx.currentTime >= playTimeRef.current - 0.05) {
        setCallState((s) => (s === "speaking" ? "listening" : s));
      }
    }, (buffer.duration * 1000) | 0);
  };

  useEffect(() => {
    return () => {
      closedByUserRef.current = true;
      wsRef.current?.close();
      cleanupAudio();
    };
  }, [cleanupAudio]);

  return { callState, sessionId, transcripts, error, startCall, stopCall };
}
