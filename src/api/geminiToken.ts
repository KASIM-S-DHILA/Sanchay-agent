import type { Env } from "../types";

export async function handleGeminiToken(request: Request, env: Env): Promise<Response> {
  if (!env.GEMINI_API_KEY || env.GEMINI_API_KEY === "your_gemini_api_key_here") {
    return Response.json(
      { success: false, error: "GEMINI_API_KEY not configured on server" },
      { status: 500 }
    );
  }

  // Ephemeral token is v1alpha only, short-lived: 30m session, 1m to start
  const now = new Date();
  const expireTime = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  const newSessionExpireTime = new Date(now.getTime() + 60 * 1000).toISOString();

  // Unlocked token — client can set any LiveConnectConfig (model, tools, systemInstruction)
  // For locked token, add liveConnectConstraints: { model, config: { responseModalities, sessionResumption } }
  const body = {
    uses: 1,
    expireTime,
    newSessionExpireTime,
  };

  const res = await fetch("https://generativelanguage.googleapis.com/v1alpha/auth_tokens", {
    method: "POST",
    headers: {
      "x-goog-api-key": env.GEMINI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    return Response.json(
      { success: false, error: json.error?.message || `Token creation failed: ${res.status}`, details: json },
      { status: res.status }
    );
  }

  // SDK returns { name: "auth_tokens/xxx", ... } — client uses name as apiKey with v1alpha
  const token = json.name || json.token?.name || json.token;
  if (!token) {
    return Response.json({ success: false, error: "No token name in response", details: json }, { status: 500 });
  }

  return Response.json({
    success: true,
    data: {
      token, // e.g. "auth_tokens/abc123"
      expireTime: json.expireTime || expireTime,
      newSessionExpireTime: json.newSessionExpireTime || newSessionExpireTime,
    },
  });
}
