const SYSTEM_PROMPT =
  [
    "You are an experienced used-car evaluator and mechanic.",
    "Your job: help a buyer decide whether to buy a specific used car listing.",
    "Be direct, practical, and specific to the exact year/make/model + mileage + seller notes.",
    "",
    "Hard rules:",
    "- Do NOT invent facts (recalls, failures, pricing) if you are not confident. Use 'unknown' or omit that issue.",
    "- Do NOT assume CVT. Only mention CVT-related risks if that year/model is actually known to use a CVT.",
    "- Do NOT label something a 'well-known issue' unless you are highly confident for that exact year/generation.",
    "- Calibrate for brand/platform: a high-mileage Toyota is not automatically end-of-life; some vehicles routinely exceed 200k+.",
    "- Keep the verdict aligned with the score (e.g., do not say 'walk away' with a 'Fair/Good' score).",
    "- If data is missing (trim/engine/transmission/drivetrain/service history), explicitly state how uncertainty affects confidence.",
    "",
    "Output MUST be valid JSON that matches the schema exactly. No markdown, no extra keys."
  ].join("\n");

const CACHE_TTL_SECONDS = 60 * 60 * 24;
const CACHE_VERSION = "v5"; // bump version so old cache doesn't pollute results
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

  if (entry.last && now - entry.last < RATE_MIN_INTERVAL_MS) {
    return { ok: false, retryAfterMs: RATE_MIN_INTERVAL_MS - (now - entry.last) };
  }

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

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

function asString(v, fallback = "unknown") {
  if (typeof v === "string" && v.trim()) return v.trim();
  return fallback;
}

function asNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function verdictFromScore(score) {
  if (!Number.isFinite(score)) return "unknown";
  if (score <= 14) return "❌ No";
  if (score <= 34) return "⚠️ Risky";
  if (score <= 54) return "⚖️ Fair";
  if (score <= 71) return "👍 Good";
  if (score <= 87) return "💎 Great";
  return "🚀 Steal";
}

/**
 * Coerce/fill required output so UI doesn't break even if the model slips.
 * Also enforces some consistency constraints.
 */
function coerceAndFill(raw, snapshot) {
  const out = {};

  out.summary = asString(raw.summary);
  out.year_model_reputation = asString(raw.year_model_reputation);

  out.expected_maintenance_near_term = asArray(raw.expected_maintenance_near_term).map((x) => ({
    item: asString(x?.item),
    typical_mileage_range: asString(x?.typical_mileage_range),
    why_it_matters: asString(x?.why_it_matters),
    estimated_cost_diy: asString(x?.estimated_cost_diy),
    estimated_cost_shop: asString(x?.estimated_cost_shop)
  }));

  out.common_issues = asArray(raw.common_issues).map((x) => ({
    issue: asString(x?.issue),
    typical_failure_mileage: asString(x?.typical_failure_mileage),
    severity: asString(x?.severity),
    estimated_cost_diy: asString(x?.estimated_cost_diy),
    estimated_cost_shop: asString(x?.estimated_cost_shop)
  }));
  out.wear_items = asArray(raw.wear_items).map((x) => ({
    item: asString(x?.item),
    typical_mileage_range: asString(x?.typical_mileage_range),
    why_it_matters: asString(x?.why_it_matters),
    estimated_cost_diy: asString(x?.estimated_cost_diy),
    estimated_cost_shop: asString(x?.estimated_cost_shop)
  }));

  out.remaining_lifespan_estimate = asString(raw.remaining_lifespan_estimate);
  out.market_value_estimate = asString(raw.market_value_estimate);
  out.price_opinion = asString(raw.price_opinion);

  out.mechanical_skill_required = asString(raw.mechanical_skill_required);
  out.daily_driver_vs_project = asString(raw.daily_driver_vs_project);

  out.upsides = asArray(raw.upsides).map((s) => asString(s)).filter((s) => s !== "unknown");
  out.inspection_checklist = asArray(raw.inspection_checklist).map((s) => asString(s));
  out.buyer_questions = asArray(raw.buyer_questions).map((s) => asString(s));

  out.risk_flags = asArray(raw.risk_flags).map((s) => asString(s));
  out.deal_breakers = asArray(raw.deal_breakers).map((s) => asString(s));
  out.tags = asArray(raw.tags).map((s) => asString(s)).slice(0, 6);

  out.confidence = clamp(asNumber(raw.confidence, 0.5), 0, 1);

  // Score: prefer model score, else derive from confidence (but don't overwrite a valid score)
  let score = asNumber(raw.overall_score, null);
  if (score == null) score = Math.round(out.confidence * 100);
  out.overall_score = clamp(Math.round(score), 0, 100);

  out.final_verdict = asString(raw.final_verdict);

  // Ensure verdict/score consistency if model gives something contradictory
  // (We don't rewrite the entire verdict, but we can add a clarifier.)
  const scoreBand = verdictFromScore(out.overall_score);
  const verdictLower = (out.final_verdict || "").toLowerCase();
  const saysWalkAway = verdictLower.includes("walk away") || verdictLower.includes("avoid");
  const saysBuy =
    verdictLower.includes("buy") || verdictLower.includes("good deal") || verdictLower.includes("worth it");

  if (saysWalkAway && out.overall_score >= 55) {
    out.final_verdict = `${out.final_verdict} (Note: score suggests ${scoreBand}; if walking away, specify the deal-breaker found during inspection.)`;
  } else if (saysBuy && out.overall_score <= 34) {
    out.final_verdict = `${out.final_verdict} (Note: score suggests ${scoreBand}; if buying anyway, it should be only at a steep discount and with clear acceptance of risk.)`;
  }

  out.notes = asString(raw.notes, "");

  // Small helpful note when key fields are missing
  const missing = [];
  if (!snapshot?.price_usd) missing.push("price");
  if (!snapshot?.mileage_miles) missing.push("mileage");
  if (!snapshot?.seller_description) missing.push("seller_description");
  if (missing.length) {
    const m = `Missing listing info: ${missing.join(", ")}. This reduces confidence.`;
    out.notes = out.notes ? `${out.notes} ${m}` : m;
  }

  return out;
}

const RESPONSE_SCHEMA = {
  name: "used_car_analysis",
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "summary",
      "year_model_reputation",
      "expected_maintenance_near_term",
      "common_issues",
      "wear_items",
      "remaining_lifespan_estimate",
      "market_value_estimate",
      "price_opinion",
      "mechanical_skill_required",
      "daily_driver_vs_project",
      "upsides",
      "inspection_checklist",
      "buyer_questions",
      "overall_score",
      "risk_flags",
      "deal_breakers",
      "tags",
      "final_verdict",
      "confidence",
      "notes"
    ],
    properties: {
      summary: { type: "string" },
      year_model_reputation: { type: "string" },
      expected_maintenance_near_term: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["item", "typical_mileage_range", "why_it_matters", "estimated_cost_diy", "estimated_cost_shop"],
          properties: {
            item: { type: "string" },
            typical_mileage_range: { type: "string" },
            why_it_matters: { type: "string" },
            estimated_cost_diy: { type: "string" },
            estimated_cost_shop: { type: "string" }
          }
        }
      },
      common_issues: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["issue", "typical_failure_mileage", "severity", "estimated_cost_diy", "estimated_cost_shop"],
          properties: {
            issue: { type: "string" },
            typical_failure_mileage: { type: "string" },
            severity: { type: "string" },
            estimated_cost_diy: { type: "string" },
            estimated_cost_shop: { type: "string" }
          }
        }
      },
      wear_items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["item", "typical_mileage_range", "why_it_matters", "estimated_cost_diy", "estimated_cost_shop"],
          properties: {
            item: { type: "string" },
            typical_mileage_range: { type: "string" },
            why_it_matters: { type: "string" },
            estimated_cost_diy: { type: "string" },
            estimated_cost_shop: { type: "string" }
          }
        }
      },
      remaining_lifespan_estimate: { type: "string" },
      market_value_estimate: { type: "string" },
      price_opinion: { type: "string" },
      mechanical_skill_required: { type: "string" },
      daily_driver_vs_project: { type: "string" },
      upsides: { type: "array", items: { type: "string" } },
      inspection_checklist: { type: "array", items: { type: "string" } },
      buyer_questions: { type: "array", items: { type: "string" } },
      overall_score: { type: "number" },
      risk_flags: { type: "array", items: { type: "string" } },
      deal_breakers: { type: "array", items: { type: "string" } },
      tags: { type: "array", items: { type: "string" } },
      final_verdict: { type: "string" },
      confidence: { type: "number" },
      notes: { type: "string" }
    }
  }
};

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
      return jsonResponse({ error: "Missing required fields", required: ["year", "make"] }, origin, 400);
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
      return new Response(JSON.stringify({ error: "Rate limited", retry_after_seconds: retryAfter }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(retryAfter),
          ...corsHeaders(origin)
        }
      });
    }

    if (!env.OPENAI_API_KEY) {
      return jsonResponse({ error: "Server missing OPENAI_API_KEY" }, origin, 500);
    }

    // Prompt: forces specificity + practical guidance + avoids CVT assumptions
    const userPrompt = [
      "Analyze this used car listing snapshot and decide whether a buyer should purchase it.",
      "Be specific to THIS year/make/model and this mileage/price. Avoid generic advice.",
      "Write like an experienced mechanic advising a friend who will actually spend money.",
      "",
      "Snapshot JSON:",
      JSON.stringify(snapshot, null, 2),
      "",
      "Requirements:",
      "- Give a clear recommendation: buy / conditional buy / avoid, and explain the reason in plain language.",
      "- Calibrate for the make/platform: high-mileage Toyotas are not automatically end-of-life; some platforms are.",
      "- Provide a realistic 6–18 month maintenance outlook at this mileage (not generic).",
      "- COMMON ISSUES: only include items you are highly confident apply to this exact year/generation/engine family.",
      "- Do NOT label generic wear items (brakes, tires, suspension wear) as common issues. Put them under wear_items.",
      "- If no platform-known issues are highly confident, common_issues should be an empty array.",
      "- Do NOT mention CVT-related issues unless this exact year/model is known to use a CVT.",
      "",
      "Costs:",
      "- estimated_cost_diy and estimated_cost_shop must be realistic ranges like \"$150–$300\" (not single numbers).",
      "",
      "Buyer questions (IMPORTANT):",
      "- Must be specific to this listing and known platform risks.",
      "- Do NOT ask generic questions like 'Any issues?' or 'Any accidents?' unless title/history is unclear and you explain why it matters.",
      "",
      "Deal-breakers:",
      "- Include 3–6 deal_breakers: specific symptoms/findings that should make the buyer walk away immediately.",
      "",
      "Mileage wording:",
      "- For durable platforms (e.g., 4Runner, Land Cruiser, some Honda/Toyota trucks), 100k–120k is mid-life, not 'high mileage'.",
      "- Use language like 'service interval due' or 'maintenance history matters' instead of 'high mileage' when appropriate.",
      "",
      "Lifespan framing (REQUIRED):",
      "- remaining_lifespan_estimate MUST include Best-case / Average-case / Worst-case.",
      "- Each case must state the assumption in parentheses.",
      "- If listing includes an active symptom, Worst-case MUST assume it is a major root cause and be materially shorter.",
      "- Prefer miles + time when possible (e.g., \"20k–60k miles / 1–3 years\").",
      "",
      "Buyer questions format (REQUIRED):",
      "- Provide 4–7 questions.",
      "- At least 2 questions MUST name a specific component/system (e.g., PTU, water pump, steering rack, turbo, diff, transfer case).",
      "- Do NOT include generic questions like 'Any issues?' or 'Any accidents?' unless title/history is missing and you explain why it matters.",
      "- Each question must include a short why-it-matters note in parentheses (4–8 words).",
      "  Example: \"Has the PTU fluid ever been changed? (AWD failure point)\"",
      "",
      "Engine specificity (REQUIRED):",
      "- If engine/variant is unknown and materially affects reliability, explicitly state how each plausible engine changes risk.",
      "- Example: \"If 3.5L EcoBoost: timing chain/turbo risk increases after 120k; if 5.0L V8: valvetrain/oil consumption more relevant.\"",
      "- Use this uncertainty to adjust confidence and risk_flags.",
      "",
      "Common issues empty handling:",
      "- If common_issues is empty, briefly explain why in year_model_reputation or notes.",
      "",
      "Completed service handling:",
      "- If the seller explicitly states a service was completed recently, reflect that and shift focus to the NEXT interval.",
      "",
      "Risk flags format (REQUIRED):",
      "- Provide 3–6 risk_flags.",
      "- Each risk flag MUST include (a) the component/system and (b) the consequence (cost/safety/driveability).",
      "- Avoid vague flags like 'high mileage' unless paired with a consequence.",
      "  Example: \"195k miles + AWD → PTU wear risk ($800–$2,000)\"",
      "",
      "Score/verdict consistency rules:",
      "- If final_verdict says 'walk away' or 'avoid', overall_score MUST be <= 34 unless you name exactly one deal-breaker that must be confirmed.",
      "- If overall_score >= 55, final_verdict MUST NOT say 'walk away'—it must be a conditional buy at worst.",
      "",
      "Output must match the JSON schema exactly. No extra keys."
    ].join("\n");

    // Use JSON schema to improve structure reliability
    const openaiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.25,
        text: {
          format: {
            type: "json_schema",
            name: RESPONSE_SCHEMA.name,
            schema: RESPONSE_SCHEMA.schema
          }
        },
        input: [
          { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
          { role: "user", content: [{ type: "input_text", text: userPrompt }] }
        ]
      })
    });

    const rawText = await openaiRes.text();
    if (!openaiRes.ok) {
      return jsonResponse({ error: "OpenAI error", status: openaiRes.status, details: rawText }, origin, 502);
    }

    let data = null;
    try {
      data = JSON.parse(rawText);
    } catch {
      return jsonResponse({ error: "OpenAI response not JSON", details: rawText.slice(0, 2000) }, origin, 502);
    }

    // Responses API: prefer output_text; else fallback to first text content
    const content = data?.output?.[0]?.content || [];
    const text =
      data?.output_text ||
      content.find((c) => c?.type === "output_text")?.text ||
      content[0]?.text ||
      "";

    let parsed = null;
    try {
      parsed = JSON.parse(String(text));
    } catch {
      return jsonResponse({ error: "Failed to parse model response", raw: String(text).slice(0, 4000) }, origin, 502);
    }

    const final = coerceAndFill(parsed, snapshot);
    const res = jsonResponse(final, origin, 200);
    res.headers.set("X-Cache", "MISS");

    ctx?.waitUntil?.(cache.put(cacheKey, res.clone()));
    return res;
  }
};
