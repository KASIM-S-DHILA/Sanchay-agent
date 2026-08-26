// ponytail: throwaway — connect, interaction_start, log ALL inbound msgs
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const env = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const KEY = env.SARVAM_API_KEY;
const BASE = "https://apps.sarvam.ai/api/app-runtime/";
const ORG = "01a03bee-645e-7af9-9269-781d232fdd47";
const WSP = "01a03bee-6465-785a-8a1d-56032e094e67";
const APP = "Conversatio-2de22e7c-7bd0";

async function attempt(label, headers = {}, extraStartFields = {}, urlExtra = "") {
  const res = await fetch(`${BASE}orgs/${ORG}/workspaces/${WSP}/apps/${APP}/url?interaction_type=call${urlExtra}`, {
    headers: { "X-API-Key": KEY },
  });
  const body = await res.text();
  let signed;
  try { signed = JSON.parse(body).url; } catch { return `${label}: url-req failed ${res.status} ${body.slice(0, 100)}`; }
  console.log(`${label}: signed →`, signed.slice(signed.indexOf("/version"), signed.indexOf("/version") + 30));
  const u = new URL(signed);
  u.searchParams.set("interaction_type", "call");
  u.searchParams.set("user_identifier", "diag-user");
  u.searchParams.set("user_identifier_type", "custom");
  u.searchParams.set("input_sample_rate", "16000");
  u.searchParams.set("output_sample_rate", "22050");

  return new Promise((resolve) => {
    const ws = new WebSocket(u.toString(), { headers });
    let msgs = [];
    const t0 = Date.now();
    const t = setTimeout(() => { resolve(`${label}: timeout(15s) — msgs=${JSON.stringify(msgs).slice(0, 300)}`); try { ws.terminate(); } catch {} }, 15000);
    ws.on("open", () => {
      console.log(`${label}: OPEN @${Date.now() - t0}ms`);
      const startMsg = { type: "client.action.interaction_start", origin: "client", timestamp: Date.now() / 1000 };
      if (!extraStartFields.omitAgentVars) startMsg.agent_variables = {};
      for (const [k, v] of Object.entries(extraStartFields)) {
        if (k !== "omitAgentVars") startMsg[k] = v;
      }
      ws.send(JSON.stringify(startMsg));
      // Stream client audio; variant controlled via extraStartFields
      const samplesPerChunk = extraStartFields.samples || 480;
      const intervalMs = extraStartFields.interval ?? 25;
      const useNoise = !!extraStartFields.noise;
      let n = 0;
      const startStream = () => {
        console.log(`${label}: streaming ${samplesPerChunk}smpl/${intervalMs}ms noise=${useNoise}`);
        const iv = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          let buf;
          if (useNoise) {
            buf = Buffer.alloc(samplesPerChunk * 2);
            for (let i = 0; i < samplesPerChunk; i++) buf.writeInt16LE(((i * 7919) % 7) - 3, i * 2); // ±3 amplitude
          } else {
            buf = Buffer.alloc(samplesPerChunk * 2);
          }
          ws.send(JSON.stringify({ type: "client.media.audio_chunk", origin: "client", timestamp: Date.now() / 1000, format: "audio/wav", sample_rate: 16000, audio_base64: buf.toString("base64") }));
          n++;
        }, intervalMs);
        ws.on("close", () => clearInterval(iv));
      };
      if (extraStartFields.audioDelayMs) setTimeout(startStream, extraStartFields.audioDelayMs);
      else startStream();
    });
    ws.on("message", (d, isBin) => {
      if (isBin) { msgs.push(`bin:${d.length}`); return; }
      try {
        const m = JSON.parse(String(d));
        msgs.push(m.type);
        if (m.type === "server.media.audio_chunk") {
          if (!attempt._ac) attempt._ac = 0;
          if ((++attempt._ac) % 20 === 1) console.log(`${label}: AUDIO chunk #${attempt._ac} status=${m.status} b64len=${(m.audio_base64||"").length} @${Date.now() - t0}ms`);
        } else {
          console.log(`${label}: MSG ${JSON.stringify(m).slice(0, 200)} @${Date.now() - t0}ms`);
        }
      } catch { msgs.push("nonjson"); }
    });
    ws.on("close", (c, r) => { clearTimeout(t); resolve(`${label}: CLOSE ${c} reason="${r}" @${Date.now() - t0}ms msgs=${JSON.stringify(msgs.slice(0, 10))}… total=${msgs.length}`); });
    ws.on("error", (e) => { clearTimeout(t); resolve(`${label}: ERR ${e.message}`); });
  });
}

console.log("cooling down 10s…");
await new Promise((r) => setTimeout(r, 10000));
attempt._ac = 0;
console.log(await attempt("noise-floor", {}, { noise: true }));
await new Promise((r) => setTimeout(r, 5000));
attempt._ac = 0;
console.log(await attempt("big-slow", {}, { samples: 1280, interval: 75 }));
