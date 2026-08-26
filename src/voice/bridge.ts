import type { Env } from "../types";
import { startSession, endSession } from "../api/logic";

/**
 * Voice WebSocket bridge (Level 3).
 *
 * Protocol notes reverse-engineered from sarvam-conv-ai-sdk dist source:
 * - Signed-URL handshake: GET {SARVAM_BASE}/orgs/{org}/workspaces/{ws}/apps/{app}/url
 *   ?interaction_type=call with X-API-Key header → { url: <wss url>, reference_id }
 * - First WS message: client.action.interaction_start (origin CLIENT,
 *   timestamp seconds, agent_variables)
 * - Audio: JSON envelopes with base64 LINEAR16 PCM —
 *   out: {type:"client.media.audio_chunk", origin:"CLIENT", timestamp,
 *         audio_base64, format:"LINEAR16", sample_rate}
 *   in:  {type:"server.media.audio_chunk", audio_base64, format, sample_rate,
 *         status:"ONGOING"|"COMPLETED"}
 * - Keepalive: respond to server.system.ping with client.system.pong
 *   (+ event_id echo)
 * - Transcripts/state: server.event.transcription,
 *   server.event.state_transition, server.action.interaction_end
 *
 * Tool calls do NOT travel over this socket. Sarvam executes tools by making
 * HTTPS calls to the registered /api/* endpoints, which are already audited
 * in api_call_log — so no interception is needed here.
 */

const SARVAM_BASE = "https://apps.sarvam.ai/api/app-runtime/";
const ORG_ID = "01a03bee-645e-7af9-9269-781d232fdd47";
const WORKSPACE_ID = "01a03bee-6465-785a-8a1d-56032e094e67";
const APP_ID = "Conversatio-2de22e7c-7bd0";

function sarvamMsg(obj: Record<string, unknown>): string {
  return JSON.stringify({ origin: "CLIENT", timestamp: Date.now() / 1000, ...obj });
}

export async function handleVoiceWebSocket(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }

  const url = new URL(request.url);
  const email = url.searchParams.get("email") ?? "";

  // Sanchay session for this voice call
  const { sessionId } = await startSession(env, { user_email: email || undefined });

  const pair = new WebSocketPair();
  const browser = pair[1]; // Workers API: pair[0]=client (returned), pair[1]=server
  browser.accept();

  // Tell the browser which session owns this call
  browser.send(JSON.stringify({ type: "session_id", session_id: sessionId }));

  let sarvam: WebSocket | null = null;
  let closed = false;

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    try { await endSession(env, sessionId); } catch {}
    try { sarvam?.close(); } catch {}
    try { browser.close(); } catch {}
  };

  try {
    // 1) Get a time-limited signed WebSocket URL (API key stays server-side)
    const signedUrlRes = await fetch(
      `${SARVAM_BASE}orgs/${ORG_ID}/workspaces/${WORKSPACE_ID}/apps/${APP_ID}/url?interaction_type=call&user_identifier=${encodeURIComponent(sessionId)}`,
      { headers: { "X-API-Key": env.SARVAM_API_KEY } },
    );
    if (!signedUrlRes.ok) {
      browser.send(JSON.stringify({
        type: "error",
        message: `Sarvam auth failed (${signedUrlRes.status}). Check SARVAM_API_KEY.`,
      }));
      await cleanup();
      return new Response("Sarvam auth failed", { status: 502 });
    }
    const { url: signedUrl }: { url: string } = await signedUrlRes.json();

    // 2) Connect upstream
    sarvam = new WebSocket(signedUrl);
    sarvam.addEventListener("open", () => {
      // 3) interaction_start — first message after open
      sarvam!.send(sarvamMsg({
        type: "client.action.interaction_start",
        agent_variables: {
          session_id: sessionId,
          user_email: email || undefined,
        },
      }));
      browser.send(JSON.stringify({ type: "state", state: "listening" }));
    });

    // ---- Sarvam → Browser -------------------------------------------------
    sarvam.addEventListener("message", (event: any) => {
      try {
        const msg = JSON.parse(typeof event.data === "string" ? event.data : "");
        switch (msg.type) {
          case "server.media.audio_chunk":
            if (msg.audio_base64) {
              // Decode base64 → raw PCM bytes for the browser
              const raw = Uint8Array.from(atob(msg.audio_base64), (ch) => ch.charCodeAt(0));
              if (browser.readyState === WebSocket.OPEN) browser.send(raw.buffer);
            }
            break;
          case "server.media.text":
          case "server.media.text_chunk":
            if (browser.readyState === WebSocket.OPEN) {
              browser.send(JSON.stringify({ type: "agent_text", text: msg.text ?? msg.content ?? "" }));
            }
            break;
          case "server.event.transcription":
            if (browser.readyState === WebSocket.OPEN) {
              browser.send(JSON.stringify({
                type: "transcript",
                role: "user",
                text: msg.transcript ?? msg.text ?? "",
              }));
            }
            break;
          case "server.event.state_transition":
            if (browser.readyState === WebSocket.OPEN) {
              browser.send(JSON.stringify({ type: "state", state: msg.state ?? "" }));
            }
            break;
          case "server.system.ping":
            if (sarvam && sarvam.readyState === WebSocket.OPEN) {
              sarvam.send(sarvamMsg({ type: "client.system.pong", event_id: msg.event_id }));
            }
            break;
          case "server.action.interaction_end":
            browser.send(JSON.stringify({ type: "call_ended" }));
            cleanup();
            break;
          default:
            break; // unknown types ignored
        }
      } catch (e) {
        console.error("sarvam message parse error:", e);
      }
    });

    sarvam.addEventListener("close", () => {
      if (!closed) {
        browser.send(JSON.stringify({ type: "call_ended" }));
      }
      cleanup();
    });
    sarvam.addEventListener("error", () => {
      if (!closed) {
        browser.send(JSON.stringify({ type: "error", message: "Upstream connection error" }));
        cleanup();
      }
    });

    // ---- Browser → Sarvam -------------------------------------------------
    browser.addEventListener("message", async (event) => {
      if (closed) return;
      try {
        if (event.data instanceof ArrayBuffer) {
          // Raw PCM chunk from browser mic → wrap into Sarvam envelope
          if (sarvam && sarvam.readyState === WebSocket.OPEN) {
            const b64 = arrayBufferToBase64(event.data);
            sarvam.send(sarvamMsg({
              type: "client.media.audio_chunk",
              format: "LINEAR16",
              sample_rate: 16000,
              audio_base64: b64,
            }));
          }
          return;
        }

        const msg = JSON.parse(String(event.data));
        if (msg.type === "stop") {
          if (sarvam && sarvam.readyState === WebSocket.OPEN) {
            sarvam.send(sarvamMsg({ type: "client.action.interaction_end" }));
          }
          await cleanup();
        }
      } catch (e) {
        console.error("browser message error:", e);
      }
    });

    browser.addEventListener("close", () => {
      cleanup();
    });
  } catch (e) {
    console.error("voice bridge setup failed:", e);
    browser.send(JSON.stringify({
      type: "error",
      message: "Voice bridge failed to start. Check SARVAM_API_KEY.",
    }));
    await cleanup();
  }

  return new Response(null, { status: 101, webSocket: pair[0] });
}



function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}





