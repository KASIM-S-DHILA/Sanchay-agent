"""
Sanchay Gemini Live agent — conversational in-app checkout.

Live API docs: https://docs.sarvam.ai/api/integration/build-voice-agent-with-live-kit
Migrated from Sarvam WSS + LiveKit room to Gemini Live (WSS 16k in / 24k out).
Commerce stays on Sanchay REST (x-session-id).

Tools are synchronous function calls (Gemini 3.1 Flash Live). Client must
manually send FunctionResponse via session.send_tool_response.

Run:
  pip install google-genai python-dotenv httpx
  cp .env.example .env  # fill GEMINI_API_KEY
  python agent.py  # console text loop; for audio see live API WSS example
"""
import asyncio
import json
import logging
import os
import uuid

import httpx
from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()
load_dotenv(".env.local")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("sanchay-gemini")

SANCHAY_BASE = os.getenv("SANCHAY_API_BASE", "https://sanchay.kasimdhila80.workers.dev")
GEMINI_KEY = os.getenv("GEMINI_API_KEY", "")

if not GEMINI_KEY:
    logger.warning("GEMINI_API_KEY not set — set it in gemini-agent/.env")

# One Sanchay D1 session per Gemini Live session
sanchay_session_id: str | None = None

async def ensure_session() -> str:
    global sanchay_session_id
    if sanchay_session_id:
        return sanchay_session_id
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(f"{SANCHAY_BASE}/api/session/start", json={"user_email": f"gemini-{uuid.uuid4().hex[:6]}@live.local"})
        data = r.json()
        sid = data.get("data", {}).get("sessionId") or data.get("sessionId") or f"gemini-{uuid.uuid4()}"
        sanchay_session_id = sid
        logger.info("sanchay session %s", sid)
        return sid

async def sanchay_fetch(path: str, body: dict | None = None):
    sid = await ensure_session()
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(f"{SANCHAY_BASE}{path}", json=body or {}, headers={"x-session-id": sid, "Content-Type": "application/json"})
        try:
            return r.json()
        except Exception:
            return {"success": False, "error": f"HTTP {r.status_code}", "raw": r.text[:500]}

# ---- Sanchay tool impls (called by Gemini function_calls) ----
async def search_catalog(query: str, limit: int = 5):
    return await sanchay_fetch("/api/catalog", {"q": query, "limit": limit})

async def add_to_cart(product_id: str, quantity: int = 1):
    return await sanchay_fetch("/api/cart/add", {"product_id": product_id, "quantity": quantity})

async def remove_from_cart(product_id: str, quantity: int = 0):
    body: dict = {"product_id": product_id}
    if quantity and quantity > 0:
        body["quantity"] = quantity
    return await sanchay_fetch("/api/cart/remove", body)

async def get_cart():
    return await sanchay_fetch("/api/cart", {})

async def checkout():
    return await sanchay_fetch("/api/checkout", {})

async def get_order_status(order_id: str):
    return await sanchay_fetch(f"/api/order/{order_id}", {})

TOOL_HANDLERS = {
    "search_catalog": search_catalog,
    "add_to_cart": add_to_cart,
    "remove_from_cart": remove_from_cart,
    "get_cart": get_cart,
    "checkout": checkout,
    "get_order_status": get_order_status,
}

# Gemini function declarations — must match handlers above
function_declarations = [
    {
        "name": "search_catalog",
        "description": "Search the apparel catalog. Always call first when shopper mentions a product type. Returns price_display for speech.",
        "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "Free text like 'gray hoodie'"}, "limit": {"type": "integer", "description": "1-20 default 5"}}, "required": ["query"]},
    },
    {
        "name": "add_to_cart",
        "description": "Add exact catalog id to cart. Enforces stock + budget (bounded). Quantity 1-99.",
        "parameters": {"type": "object", "properties": {"product_id": {"type": "string"}, "quantity": {"type": "integer"}}, "required": ["product_id"]},
    },
    {
        "name": "remove_from_cart",
        "description": "Remove/decrement product from cart. Omit quantity to delete whole line.",
        "parameters": {"type": "object", "properties": {"product_id": {"type": "string"}, "quantity": {"type": "integer"}}, "required": ["product_id"]},
    },
    {
        "name": "get_cart",
        "description": "Get current cart summary (items, total_display, count). Call before checkout or when asked cart/total.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "checkout",
        "description": "Create Razorpay order for current cart. Gated — only after shopper says buy/checkout and cart confirmed. Idempotent.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "get_order_status",
        "description": "Check order status by orderId from checkout.",
        "parameters": {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]},
    },
]

SYSTEM_INSTRUCTION = """
You are Sanchay, a warm Indian shopping assistant. Speak Hindi/English as shopper speaks, 1-2 sentences.
You have commerce tools: search_catalog, add_to_cart, remove_from_cart, get_cart, checkout, get_order_status.
Rules: search first, never invent ids/prices, speak price_display (₹) not paise, respect budgetRemaining, explain and suggest alternative if exceeds.
Checkout is gated: confirm cart via get_cart then call checkout, tell orderId and amount_display.
Every money action is bounded (stock/budget), gated (confirm before checkout), explainable, and logged.
"""

async def main():
    client = genai.Client(api_key=GEMINI_KEY)
    model = "gemini-3.1-flash-live-preview"
    tools = [{"function_declarations": function_declarations}]
    config = {"response_modalities": ["AUDIO"], "tools": tools, "system_instruction": SYSTEM_INSTRUCTION}

    logger.info("connecting to Gemini Live %s", model)
    async with client.aio.live.connect(model=model, config=config) as session:
        # Console text loop — for full audio, stream 16k PCM via session.send_realtime_input()
        print("Sanchay Gemini Live ready. Type message or 'quit'.")
        while True:
            try:
                prompt = await asyncio.to_thread(input, "you: ")
            except (EOFError, KeyboardInterrupt):
                break
            if not prompt or prompt.lower() in ("quit", "exit"):
                break
            await session.send_client_content(turns={"parts": [{"text": prompt}]})

            async for response in session.receive():
                if response.data is not None:
                    # Audio bytes (24k PCM) — write to file or play via pyaudio
                    pass
                if response.tool_call:
                    f_responses = []
                    for fc in response.tool_call.function_calls:
                        handler = TOOL_HANDLERS.get(fc.name)
                        args = fc.args or {}
                        logger.info("tool %s %s", fc.name, args)
                        try:
                            result = await handler(**args) if handler else {"error": f"unknown tool {fc.name}"}
                        except Exception as e:
                            result = {"success": False, "error": str(e)}
                        f_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": json.dumps(result)[:4000]}))
                    await session.send_tool_response(function_responses=f_responses)
                if response.server_content and getattr(response.server_content, "turn_complete", False):
                    break

if __name__ == "__main__":
    asyncio.run(main())
