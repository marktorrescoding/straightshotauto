const SYSTEM_PROMPT =
  "You analyze used car listings and return a concise, structured JSON response for a buyer. " +
  "Be specific to the exact year/make/model and avoid generic advice. " +
  "Common issues must be relevant to that year/generation (no broad make-wide issues). " +
  "If data is missing, make conservative assumptions and mention it in notes. " +
  "Return only valid JSON.";

const CACHE_TTL_SECONDS = 60 * 60 * 24;
const CACHE_VERSION = "v2";
const RATE_MIN_INTERVAL_MS = 5000;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_REQUESTS = 30;

const rateState = new Map();

function corsHeaders(origin) {
  const allowOrigin = origin || "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  };
}

function jsonResponse(body, origin, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, s-maxage=${CACHE_TTL_SECONDS}`,
      ...corsHeaders(origin)
    }
  });
}

function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateState.get(ip) || { last: 0, recent: [] };

  // Hard minimum interval
  if (entry.last && now - entry.last < RATE_MIN_INTERVAL_MS) {
    return { ok: false, retryAfterMs: RATE_MIN_INTERVAL_MS - (now - entry.last) };
  }

  // Sliding window
  entry.recent = entry.recent.filter((t) => now - t < RATE_WINDOW_MS);
  if (entry.recent.length >= RATE_MAX_REQUESTS) {
    const earliest = entry.recent[0];
    return { ok: false, retryAfterMs: RATE_WINDOW_MS - (now - earliest) };
  }

  entry.last = now;
  entry.recent.push(now);
  rateState.set(ip, entry);
  return { ok: true };
}

async function hashString(input) {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname !== "/analyze") {
      return jsonResponse({ error: "Not found" }, origin, 404);
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, origin, 405);
    }

    let payload = null;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, origin, 400);
    }

    const snapshot = {
      url: payload?.url || null,
      source_text: payload?.source_text || null,
      year: payload?.year || null,
      make: payload?.make || null,
      model: payload?.model || null,
      price_usd: payload?.price_usd ?? null,
      mileage_miles: payload?.mileage_miles ?? null,
      seller_description: payload?.seller_description || null,
      about_items: payload?.about_items || []
    };

    if (!snapshot.year || !snapshot.make) {
      return jsonResponse(
        {
          error: "Missing required fields",
          required: ["year", "make"]
        },
        origin,
        400
      );
    }

    const snapshotKey = await hashString(JSON.stringify(snapshot));
    const cacheKey = new Request(`https://cache.car-bot.local/analyze/${CACHE_VERSION}/${snapshotKey}`);
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const withCors = new Response(cached.body, cached);
      withCors.headers.set("Access-Control-Allow-Origin", origin || "*");
      withCors.headers.set("X-Cache", "HIT");
      return withCors;
    }

    const ip = getClientIp(request);
    const rate = checkRateLimit(ip);
    if (!rate.ok) {
      const retryAfter = Math.max(1, Math.ceil((rate.retryAfterMs || 0) / 1000));
      return new Response(
        JSON.stringify({ error: "Rate limited", retry_after_seconds: retryAfter }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(retryAfter),
            ...corsHeaders(origin)
          }
        }
      );
    }

    if (!env.OPENAI_API_KEY) {
      return jsonResponse({ error: "Server missing OPENAI_API_KEY" }, origin, 500);
    }

    const userPrompt = [
      "Vehicle snapshot:",
      JSON.stringify(snapshot, null, 2),
      "",
      "Return JSON with keys:",
      "summary (string),",
      "common_issues (array of {issue, severity, estimated_cost}),",
      "upsides (array of strings),",
      "inspection_checklist (array of strings),",
      "buyer_questions (array of strings),",
      "market_value_estimate (string, e.g. \"$18,000–$21,000\"),",
      "price_opinion (string),",
      "overall_score (number 0-100),",
      "risk_flags (array of strings),",
      "tags (array of emoji-labeled short strings),",
      "confidence (number 0-1),",
      "notes (string, optional).",
      "",
      "Overall score guidance (0-100):",
      "0-14 = ❌ No, 15-34 = ⚠️ Risky, 35-54 = ⚖️ Fair, 55-71 = 👍 Good, 72-87 = 💎 Great, 88-100 = 🚀 Steal.",
      "Use price vs mileage, known issues, title status, and missing info to pick a score.",
      "Tag examples: 🔧 Money pit in disguise, 🚨 Fixer-upper (emphasis on fixer), ⚠️ Budget for repairs, ✅ Mechanically reasonable, 💪 Known for going forever, 🏆 Buy it and forget about it.",
      "If there is a strong case to negotiate, add one extra buyer question prefixed with \"$\" that suggests a reasonable offer based on needed repairs or red flags.",
      "Do not replace other questions. If referencing issues not stated by the seller, explicitly say they are common for this year/model and make the question conditional (e.g., \"If you know about X...\").",
      "Inspection checks must be DIY-friendly (what an average buyer can do on-site without tools): test drive behavior, listen for noises, check lights, inspect fluids, check for leaks, check tires/brakes visually, verify warning lights.",
      "Buyer questions must be specific to the seller's description; avoid generic questions already answered.",
      "Do not ask about clutch replacement or major repairs unless the seller text indicates a problem or heavy wear.",
      "If electrical issues are mentioned, ask targeted follow-ups (e.g., which codes, how often, any diagnostics done).",
      "Common issues should be listed only if they are explicitly mentioned by the seller or are well-known for that exact year/generation. If unsure, omit.",
      "Negotiation questions must cite seller-provided issues or clearly state they are common for this year/model with typical mileage context.",
      "If the seller did not mention the issue, the negotiation question must include the context in the question itself (e.g., \"On a 2012 Pilot, transmission issues can show up around 140k+ miles; if that applies here, would you consider...\")."
    ].join("\n");

    const openaiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.3,
        text: { format: { type: "json_object" } },
        input: [
          { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
          { role: "user", content: [{ type: "input_text", text: userPrompt }] }
        ]
      })
    });

    const rawText = await openaiRes.text();
    if (!openaiRes.ok) {
      return jsonResponse(
        { error: "OpenAI error", status: openaiRes.status, details: rawText },
        origin,
        502
      );
    }

    let data = null;
    try {
      data = JSON.parse(rawText);
    } catch {
      return jsonResponse(
        { error: "OpenAI response not JSON", details: rawText.slice(0, 2000) },
        origin,
        502
      );
    }

    const text =
      data?.output_text ||
      data?.output?.[0]?.content?.[0]?.text ||
      data?.output?.[0]?.content?.[0]?.text?.value ||
      "";

    try {
      const parsed = JSON.parse(text);
      if (!Number.isFinite(Number(parsed?.overall_score)) && Number.isFinite(Number(parsed?.confidence))) {
        parsed.overall_score = Math.round(Number(parsed.confidence) * 100);
      }
      const res = jsonResponse(parsed, origin, 200);
      res.headers.set("X-Cache", "MISS");
      ctx?.waitUntil?.(cache.put(cacheKey, res.clone()));
      return res;
    } catch {
      return jsonResponse(
        {
          error: "Failed to parse model response",
          raw: text,
          debug: { has_output_text: Boolean(data?.output_text) }
        },
        origin,
        502
      );
    }
  }
};
