// ponytail: throwaway — find which WS handshake variant Sarvam accepts
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

async function getSignedUrl() {
  const res = await fetch(`${BASE}orgs/${ORG}/workspaces/${WSP}/apps/${APP}/url?interaction_type=call`, {
    headers: { "X-API-Key": KEY },
  });
  return (await res.json()).url;
}

function tryConnect(label, url, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    const done = (r) => { try { ws.terminate(); } catch {} resolve(`${label}: ${r}`); };
    const t = setTimeout(() => done("TIMEOUT"), 6000);
    ws.on("unexpected-response", (_q, res2) => { clearTimeout(t); done(`REJECT ${res2.statusCode}`); });
    ws.on("open", () => { clearTimeout(t); done("OPEN ✓"); });
    ws.on("error", (e) => { clearTimeout(t); done(`error ${e.message.slice(0, 60)}`); });
  });
}

const variants = [
  ["bare", {}],
  ["?interaction_type=call", {}],
  ["?interaction_type+user_id(custom)", {}],
  ["?interaction_type+user_id(email)", {}],
  ["origin localhost", { Origin: "http://localhost:8787" }],
  ["apikey header", { "X-API-Key": KEY }],
];

for (const [label, headers] of variants) {
  const base = await getSignedUrl();
  let url = `${base}?interaction_type=call`;
  if (label.includes("user_id")) url += `&user_identifier=test%40example.com&user_identifier_type=${label.includes("email") ? "email" : "custom"}`;
  console.log(await tryConnect(label, url, headers));
}
