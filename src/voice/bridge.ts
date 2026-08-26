import type { Env } from "../types";
import { startSession, endSession, getVoiceAgentVariables } from "../api/logic";
import { validateSessionId } from "../middleware/session";

/**
 * Voice WebSocket bridge (Level 3).
 *
 * Protocol notes reverse-engineered from sarvam-conv-ai-sdk dist source
 * AND verified empirically against the live gateway (scripts/diag-sarvam.mjs):
 * - Signed-URL handshake: GET {SARVAM_BASE}/orgs/{org}/workspaces/{ws}/apps/{app}/url
 *   ?interaction_type=call with X-API-Key header → { url: <wss url>, reference_id }
 * - WS connect REQUIRES query params on the signed URL, else 403:
 *   interaction_type=call & user_identifier & user_identifier_type
 *   (input_sample_rate/output_sample_rate also appended by the SDK)
 * - All client messages carry origin:"client" (LOWERCASE — "CLIENT" kills the
 *   session silently) and audio chunks format:"audio/wav" (NOT "LINEAR16" —
 *   wrong string aborts the session on first chunk)
 * - First WS message: client.action.interaction_start
 * - Audio: JSON envelopes with base64 LINEAR16 PCM —
 *   out: {type:"client.media.audio_chunk", origin:"client", timestamp,
 *         audio_base64, format:"audio/wav", sample_rate}
 *   in:  {type:"server.media.audio_chunk", audio_base64, format, sample_rate,
 *         status:"pending"|"completed"}
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
  // origin MUST be lowercase "client" — MsgOrigin.CLIENT = "client"; uppercase
  // gets the session silently killed by the gateway before interaction_connect
  return JSON.stringify({ origin: "client", timestamp: Date.now() / 1000, ...obj });
}

/**
 * Persists one transcript turn so the conversation can be reviewed after
 * the call ends or the page reloads — see GET /api/voice/transcript. Never
 * allowed to break the live call: failures are logged and swallowed, same
 * pattern as every other best-effort write in this bridge.
 */
async function saveTranscriptTurn(env: Env, sessionId: string, role: "user" | "agent", text: string): Promise<void> {
  if (!text) return;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS voice_transcripts (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL)`,
    ).run();
    await env.DB.prepare(
      "INSERT INTO voice_transcripts (id, session_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), sessionId, role, text, new Date().toISOString())
      .run();
  } catch (e) {
    console.error("saveTranscriptTurn failed:", e);
  }
}

export async function handleVoiceWebSocket(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }

  const url = new URL(request.url);
  const email = url.searchParams.get("email") ?? "";
  const requestedSessionId = url.searchParams.get("session_id");

  // Reuse the browser's existing session if it's still valid, so voice and
  // the REST/cart UI share one session (same cart, budget, audit trail).
  // Only fall back to minting a new session when none was supplied or it's
  // no longer valid — never silently fork a second session out from under
  // an active browser tab.
  const existing = await validateSessionId(env, requestedSessionId);
  let sessionId: string;
  let ownsSession: boolean;
  if (existing) {
    sessionId = existing.id;
    ownsSession = false;
  } else {
    const started = await startSession(env, { user_email: email || undefined });
    sessionId = started.sessionId;
    ownsSession = true;
  }

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
    // Only end sessions the bridge itself created — a session reused from
    // the browser must stay alive for cart polling/checkout after the call.
    if (ownsSession) {
      try { await endSession(env, sessionId); } catch { }
    }
    try { sarvam?.close(); } catch { }
    try { browser.close(); } catch { }
  };

  try {
    // 1) Get a time-limited signed WebSocket URL (API key stays server-side)
    const signedUrlRes = await fetch(
      `${SARVAM_BASE}orgs/${ORG_ID}/workspaces/${WORKSPACE_ID}/apps/${APP_ID}/url?interaction_type=call`,
      { headers: { "X-API-Key": env.SARVAM_API_KEY } },
    );
    if (!signedUrlRes.ok) {
      const detail = (await signedUrlRes.text()).slice(0, 300);
      console.error("sarvam signed-url failed:", signedUrlRes.status, detail);
      browser.send(JSON.stringify({
        type: "error",
        message: `Sarvam auth failed (${signedUrlRes.status}). Check the SARVAM_API_KEY secret on the Worker.`,
      }));
      await cleanup();
      // Complete the upgrade even though the call can't proceed. Returning a
      // 502 here instead would fail the WebSocket handshake, and the browser
      // would discard the message just sent — leaving the shopper with a bare
      // "connection failed" and no way to know the key was the problem.
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const signedBody = await signedUrlRes.text();
    let signedUrl: string;
    try {
      signedUrl = JSON.parse(signedBody).url;
    } catch {
      console.error("sarvam signed-url unexpected body:", signedBody.slice(0, 300));
      browser.send(JSON.stringify({ type: "error", message: "Sarvam returned an unexpected response." }));
      await cleanup();
      // Upgrade anyway, so the message above actually reaches the browser.
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    // Mirror the SDK: interaction_type + user_identifier(+type) are REQUIRED
    // query params on the WS connect URL — without them the gateway 403s.
    // Verified empirically: bare/+interaction_type → 403; adding
    // user_identifier+user_identifier_type → 101.
    const wsUrl = new URL(signedUrl);
    wsUrl.searchParams.set("interaction_type", "call");
    wsUrl.searchParams.set("user_identifier", sessionId);
    wsUrl.searchParams.set("user_identifier_type", "custom");
    wsUrl.searchParams.set("input_sample_rate", "16000");
    wsUrl.searchParams.set("output_sample_rate", "22050");

    // 2) Resolve agent_variables BEFORE opening the upstream socket.
    //
    // These must ride on interaction_start, which the protocol requires to be
    // the first message on the connection. Fetching them inside the open
    // handler (as a .then, since Workers listeners can't be async) raced
    // against the browser's mic audio: getVoiceAgentVariables makes up to four
    // D1 queries, and the browser starts streaming as soon as it sees
    // "listening", so audio could reach Sarvam first. When it did, the
    // interaction began with no agent_variables — meaning no session_id — so
    // the agent's tool calls carried an empty x-session-id and every
    // cart/checkout tool 401'd. search_catalog kept working throughout because
    // it's the one tool that doesn't require a session, which made the failure
    // look like "the agent can't add to cart" rather than an auth problem.
    //
    // Awaiting here costs a few ms before the socket opens and removes the
    // race outright.
    let agentVariables: Record<string, string>;
    try {
      agentVariables = await getVoiceAgentVariables(env, sessionId);
    } catch (e) {
      console.error("getVoiceAgentVariables failed, starting with empty vars:", e);
      agentVariables = { session_id: sessionId, cart_id: sessionId };
    }

    // 3) Connect upstream
    sarvam = new WebSocket(wsUrl.toString());
    sarvam.addEventListener("open", () => {
      // interaction_start is sent synchronously, so it is guaranteed to be the
      // first frame. Only once it's away do we let the browser start talking.
      if (sarvam && sarvam.readyState === WebSocket.OPEN) {
        sarvam.send(sarvamMsg({
          type: "client.action.interaction_start",
          agent_variables: agentVariables,
        }));
      }
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
          case "server.media.text_chunk": {
            const agentText = msg.text ?? msg.content ?? "";
            if (browser.readyState === WebSocket.OPEN) {
              browser.send(JSON.stringify({ type: "agent_text", text: agentText }));
            }
            void saveTranscriptTurn(env, sessionId, "agent", agentText);
            break;
          }
          case "server.event.transcription": {
            const userText = msg.transcript ?? msg.text ?? "";
            if (browser.readyState === WebSocket.OPEN) {
              browser.send(JSON.stringify({
                type: "transcript",
                role: "user",
                text: userText,
              }));
            }
            void saveTranscriptTurn(env, sessionId, "user", userText);
            break;
          }
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
          case "server.action.interaction_connected":
            // Sarvam confirming the interaction is live. We already told the
            // browser "listening" optimistically on open, so there's nothing to
            // change — logged because its absence is a useful signal that
            // interaction_start never landed.
            console.log("sarvam interaction_connected");
            break;
          case "server.event.tool_call":
            // Tools execute on Sarvam's side against our HTTP endpoints, so
            // there's nothing to run here. Logged so a tool the agent *tried*
            // is visible even when the resulting HTTP call never arrives (an
            // auth rejection, a bad product_id, a wrong URL in the dashboard).
            console.log(
              "sarvam tool_call:",
              msg.tool_name ?? msg.name ?? "unknown",
              JSON.stringify(msg.parameters ?? msg.params ?? {}).slice(0, 300),
            );
            break;
          case "server.action.interaction_end":
            browser.send(JSON.stringify({ type: "call_ended" }));
            cleanup();
            break;
          default:
            // Never silently swallow an unknown frame — a protocol addition on
            // Sarvam's side should show up in the logs, not vanish.
            console.log("sarvam unhandled message type:", msg.type);
            break;
        }
      } catch (e) {
        console.error("sarvam message parse error:", e);
      }
    });

    sarvam.addEventListener("close", (event: any) => {
      console.error("sarvam ws closed:", event?.code, event?.reason, "wasOpen:", sarvam?.readyState);
      if (!closed) {
        browser.send(JSON.stringify({ type: "call_ended" }));
      }
      cleanup();
    });
    sarvam.addEventListener("error", (event: any) => {
      console.error("sarvam ws error:", event?.message ?? event);
      if (!closed) {
        browser.send(JSON.stringify({ type: "error", message: "Upstream connection error" }));
        cleanup();
      }
    });

    // ---- Browser → Sarvam -------------------------------------------------
    browser.addEventListener("message", async (event) => {
      if (closed) return;
      try {
        // Normalize incoming data — workerd may deliver binary frames as
        // ArrayBuffer, Blob, or TypedArray depending on runtime/version
        let bin: ArrayBuffer | null = null;
        const d = event.data;
        if (d instanceof ArrayBuffer) {
          bin = d;
        } else if (typeof Blob !== "undefined" && d instanceof Blob) {
          bin = await d.arrayBuffer();
        } else if (d && typeof d === "object" && "byteLength" in (d as object) && "buffer" in (d as object)) {
          // TypedArray view over a buffer
          const view = d as unknown as Uint8Array;
          bin = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
        }

        if (bin) {
          if (bin.byteLength > 0 && sarvam && sarvam.readyState === WebSocket.OPEN) {
            const b64 = arrayBufferToBase64(bin);
            sarvam.send(sarvamMsg({
              type: "client.media.audio_chunk",
              format: "audio/wav",
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





