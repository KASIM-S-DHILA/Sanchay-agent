import { useState, useRef, useCallback, useEffect } from "react";

type CallState = "idle" | "connecting" | "listening" | "speaking";

export interface TranscriptEntry {
  role: "user" | "agent";
  text: string;
}

/** How long a level reading survives without a fresh audio chunk before it
 *  starts decaying toward silence. Chunks arrive roughly every 32ms while
 *  audio flows, so 140ms is comfortably past "still talking". */
const LEVEL_DECAY_MS = 140;
const LEVEL_TICK_MS = 70;

/** Int16 PCM → 0..1 loudness. Scaled by 3 because conversational speech sits
 *  well below full scale; without it the meter barely moves at normal volume. */
function rmsLevel(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  // Sample rather than sum every frame — a chunk is ~500 samples and this
  // runs on every chunk on the main thread.
  const step = pcm.length > 256 ? Math.floor(pcm.length / 256) : 1;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < pcm.length; i += step) {
    const v = pcm[i] / 0x8000;
    sum += v * v;
    n++;
  }
  return Math.min(1, Math.sqrt(sum / n) * 3);
}

export function useVoiceCall(onCheckoutSuccess?: (orderId: string, amount: number) => void) {
  const [callState, setCallState] = useState<CallState>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Measured amplitude of the audio actually flowing, in each direction. The
  // UI meter is driven by these rather than by a keyframe loop, so silence
  // looks like silence.
  const [micLevel, setMicLevel] = useState(0);
  const [agentLevel, setAgentLevel] = useState(0);
  const historyLoadedForRef = useRef<string | null>(null);

  /**
   * Hydrates the tape with previously-saved turns for a session — used both
   * when the voice bridge adopts/confirms a session id, and can be called
   * directly by the host app if it already knows the session id (e.g. the
   * browser started a session before any call happened). Only fetches
   * once per session id to avoid re-fetching on every re-render.
   */
  const loadTranscriptHistory = useCallback(async (sid: string) => {
    if (!sid || historyLoadedForRef.current === sid) return;
    historyLoadedForRef.current = sid;
    try {
      const res = await fetch(`/api/voice/transcript?session_id=${encodeURIComponent(sid)}`, {
        headers: { "x-session-id": sid },
      });
      if (res.status !== 200) return;
      const data: any = await res.json();
      const turns: { role: "user" | "agent"; text: string }[] = data?.data?.turns ?? [];
      if (turns.length === 0) return;
      // Prepend saved history ahead of anything already live in this tab —
      // history is always older than in-memory turns from the current call.
      setTranscripts((prev) => [...turns.slice(-20), ...prev].slice(-20));
    } catch {
      // Best-effort hydration — a failed fetch just means the tape starts
      // empty, same as before this feature existed.
    }
  }, []);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const playTimeRef = useRef(0);
  const speakTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByUserRef = useRef(false);

  // Level plumbing: chunks write to the refs, one shared interval publishes to
  // React state and decays toward zero. Setting state per chunk would re-render
  // ~30x/sec per direction.
  const micRef = useRef(0);
  const agentRef = useRef(0);
  const micAtRef = useRef(0);
  const agentAtRef = useRef(0);
  const levelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopLevelPump = useCallback(() => {
    if (levelTimerRef.current) {
      clearInterval(levelTimerRef.current);
      levelTimerRef.current = null;
    }
    micRef.current = 0;
    agentRef.current = 0;
    setMicLevel(0);
    setAgentLevel(0);
  }, []);

  const startLevelPump = useCallback(() => {
    if (levelTimerRef.current) return;
    levelTimerRef.current = setInterval(() => {
      const now = Date.now();
      if (now - micAtRef.current > LEVEL_DECAY_MS) micRef.current *= 0.55;
      if (now - agentAtRef.current > LEVEL_DECAY_MS) agentRef.current *= 0.55;
      if (micRef.current < 0.01) micRef.current = 0;
      if (agentRef.current < 0.01) agentRef.current = 0;
      setMicLevel(micRef.current);
      setAgentLevel(agentRef.current);
    }, LEVEL_TICK_MS);
  }, []);

  const cleanupAudio = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    workletRef.current?.disconnect();
    workletRef.current = null;
    try { audioCtxRef.current?.close(); } catch { }
    audioCtxRef.current = null;
    if (speakTimerRef.current) {
      clearTimeout(speakTimerRef.current);
      speakTimerRef.current = null;
    }
    stopLevelPump();
    // Let playback context drain naturally
  }, [stopLevelPump]);

  const stopCall = useCallback(() => {
    closedByUserRef.current = true;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop" }));
    }
    wsRef.current?.close();
    cleanupAudio();
    setCallState("idle");
  }, [cleanupAudio]);

  const playPcmChunk = useCallback(async (data: ArrayBuffer) => {
    // Lazy-create a playback context at Sarvam's output rate (22050 Hz —
    // declared via output_sample_rate on the signed WS URL)
    if (!playCtxRef.current) {
      playCtxRef.current = new AudioContext({ sampleRate: 22050 });
      playTimeRef.current = playCtxRef.current.currentTime;
    }
    const ctx = playCtxRef.current;

    const pcm = new Int16Array(data);
    if (pcm.length === 0) return;

    agentRef.current = Math.max(agentRef.current, rmsLevel(pcm));
    agentAtRef.current = Date.now();

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
  }, []);

  /**
   * Opens the bridge socket, then the mic. Deliberately never throws: every
   * failure path lands in `error` with a message that says what to do next.
   * (Previously a denied mic permission rejected out of here unhandled, which
   * left callState stuck on "connecting" forever with nothing on screen.)
   */
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
            void loadTranscriptHistory(msg.session_id);
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
            setError(msg.message ?? "The counter hit a problem. Try starting the call again.");
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
      setError("Couldn't reach the counter. Check your connection and try again.");
      setCallState("idle");
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WS open timeout")), 15000);
        ws.addEventListener("open", () => { clearTimeout(timer); resolve(); });
        ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WS error")); });
      });
    } catch {
      setError("Couldn't reach the counter. Check your connection and try again.");
      setCallState("idle");
      try { ws.close(); } catch { }
      cleanupAudio();
      return;
    }

    // 2. Mic capture — AudioWorklet PCM 16kHz mono
    try {
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
        micRef.current = rmsLevel(new Int16Array(buf));
        micAtRef.current = Date.now();
        if (ws.readyState === WebSocket.OPEN) ws.send(buf);
      };
      ctx.createMediaStreamSource(stream).connect(worklet);
      // Don't connect worklet to destination (no local feedback loop)
    } catch (e) {
      // Name the actual obstacle — a blocked mic and a missing mic need
      // different things from the person reading this.
      const name = (e as { name?: string } | null)?.name;
      setError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone access is blocked. Allow the mic for this site in your browser, then start the call again."
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "No microphone found. Connect one and start the call again."
            : "Couldn't open the microphone. Close anything else using it and try again.",
      );
      try { ws.close(); } catch { }
      cleanupAudio();
      setCallState("idle");
      return;
    }

    startLevelPump();
    setCallState("listening");
  }, [cleanupAudio, onCheckoutSuccess, loadTranscriptHistory, playPcmChunk, startLevelPump]);

  const dismissError = useCallback(() => setError(null), []);

  useEffect(() => {
    return () => {
      closedByUserRef.current = true;
      wsRef.current?.close();
      cleanupAudio();
    };
  }, [cleanupAudio]);

  return {
    callState,
    sessionId,
    transcripts,
    error,
    micLevel,
    agentLevel,
    startCall,
    stopCall,
    dismissError,
    loadTranscriptHistory,
  };
}
