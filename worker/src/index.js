const SYSTEM_PROMPT =
  [
    "You are an experienced used-car evaluator and mechanic.",
    "Return ONLY valid JSON matching the provided schema. No markdown. No extra keys.",
    "",
    "Truthfulness rules:",
    "- Never invent facts. If unsure, use 'unknown' or omit by using empty arrays where allowed.",
    "- Never claim clean title unless seller text explicitly states it.",
    "- Never assume CVT or platform-wide 'well-known issues' unless you are highly confident for this exact year/generation/powertrain.",
    "",
    "Classification rules:",
    "- 'common_issues' = only highly confident platform/generation issues (not tires/brakes/wear). If not sure, return [].",
    "- Wear items (tires/brakes/suspension wear) go in 'wear_items', not 'common_issues'.",
    "",
    "Consistency rules:",
    "- Keep verdict aligned with score band.",
    "- Missing key data must reduce confidence and be called out in notes."
  ].join("\n");

const CACHE_TTL_SECONDS = 60 * 60 * 24;
const CACHE_VERSION = "v7"; // bumped because lifespan output is now model-driven with anchors
const RATE_MIN_INTERVAL_MS = 0;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_REQUESTS = 120;

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

function normalizeText(value) {
  return (value || "").toString().toLowerCase();
}

function getAuthToken(request) {
  const header = request.headers.get("Authorization") || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return null;
}

async function fetchSupabaseUser(token, env) {
  if (!token) return null;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: env.SUPABASE_ANON_KEY
    }
  });
  if (!res.ok) return null;
  return res.json();
}

async function supabaseAdminRequest(path, env, options = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!res.ok) return null;
  if (res.status === 204) return {};
  return res.json();
}

async function fetchSupabaseUserByEmail(email, env) {
  if (!email) return null;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const res = await fetch(
    `${env.SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (Array.isArray(data?.users)) return data.users[0] || null;
  if (Array.isArray(data)) return data[0] || null;
  return data?.user || null;
}

async function createSupabaseUserForEmail(email, env) {
  if (!email) return null;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email, email_confirm: true })
  });
  if (!res.ok) return null;
  return res.json();
}

async function findOrCreateSupabaseUserByEmail(email, env) {
  let user = await fetchSupabaseUserByEmail(email, env);
  if (user?.id) return user;
  user = await createSupabaseUserForEmail(email, env);
  if (user?.id) return user;
  return null;
}

async function getSubscriptionRecord(userId, env) {
  if (!userId) return null;
  const path = `/rest/v1/subscriptions?user_id=eq.${userId}&select=user_id,status,plan,updated_at,stripe_customer_id&order=updated_at.desc&limit=1`;
  const data = await supabaseAdminRequest(path, env);
  return Array.isArray(data) ? data[0] : null;
}

function isSubscriptionActive(record) {
  const status = normalizeText(record?.status);
  return status === "active" || status === "trialing";
}

async function stripeRequest(env, path, body) {
  if (!env.STRIPE_SECRET_KEY) {
    return { ok: false, status: 500, error: "Missing STRIPE_SECRET_KEY" };
  }
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: data?.error?.message || "Stripe request failed",
      raw: data
    };
  }
  return { ok: true, status: res.status, data };
}

function hexFromBuffer(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyStripeSignature(payload, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const parts = signatureHeader.split(",").map((p) => p.trim());
  const timestampPart = parts.find((p) => p.startsWith("t="));
  const sigPart = parts.find((p) => p.startsWith("v1="));
  if (!timestampPart || !sigPart) return false;

  const timestamp = timestampPart.split("=")[1];
  const signature = sigPart.split("=")[1];
  const signedPayload = `${timestamp}.${payload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  return hexFromBuffer(mac) === signature;
}

function deriveTitleStatus(snapshot) {
  const explicit = snapshot?.title_status;
  if (explicit) return normalizeText(explicit);
  return "unknown";
}

function hasServiceRecordsClaim(snapshot) {
  const text = normalizeText([snapshot?.seller_description, snapshot?.source_text].join(" "));
  return /(full service records|service records|dealer maintained|maintenance records)/i.test(text);
}

function scrubCleanTitle(text) {
  if (!text) return text;
  return text.replace(/clean title/gi, "title status not stated");
}

function ensureTitleConsistency(out, snapshot) {
  const titleStatus = deriveTitleStatus(snapshot);
  if (titleStatus === "unknown") {
    out.summary = scrubCleanTitle(out.summary);
    out.final_verdict = scrubCleanTitle(out.final_verdict);
    out.notes = scrubCleanTitle(out.notes);
  }
  if (titleStatus === "rebuilt" || titleStatus === "lien") {
    const flag =
      titleStatus === "rebuilt"
        ? "Rebuilt/salvage title -> insurance/resale risk"
        : "Lien on title -> transfer/financing risk";
    if (!out.risk_flags.some((f) => normalizeText(f).includes("title"))) {
      out.risk_flags.unshift(flag);
    }
  }
  return titleStatus;
}

function replaceTimingBelt(items) {
  return items.map((item) => {
    if (typeof item === "string" && /timing belt/i.test(item)) {
      return "Timing chain / valve clearance (verify engine timing system)";
    }
    if (item?.item && /timing belt/i.test(item.item)) {
      return {
        ...item,
        item: "Timing chain / valve clearance (verify engine timing system)"
      };
    }
    return item;
  });
}

function fixKnownMaintenance(out, snapshot) {
  const make = (snapshot?.make || "").toLowerCase();
  const model = (snapshot?.model || "").toLowerCase();
  const year = Number(snapshot?.year);
  const isCrv2002to2006 = make === "honda" && model.includes("cr-v") && year >= 2002 && year <= 2006;
  if (isCrv2002to2006) {
    out.expected_maintenance_near_term = replaceTimingBelt(out.expected_maintenance_near_term);
    out.wear_items = replaceTimingBelt(out.wear_items);
  }
}

function applyExtremeMileageCaps(out, snapshot) {
  const miles = Number(snapshot?.mileage_miles);
  if (!Number.isFinite(miles) || miles < 250000) return;
  const hasRecords = hasServiceRecordsClaim(snapshot);
  if (!hasRecords && out.confidence > 0.75) out.confidence = 0.75;
  if (!(hasRecords && out.confidence >= 0.85) && out.overall_score > 45) {
    out.overall_score = 45;
  }
}

function hasActiveSymptom(snapshot) {
  const text = normalizeText(
    [snapshot?.seller_description, snapshot?.source_text, ...(snapshot?.about_items || [])].join(" ")
  );
  if (!text) return false;

  const symptom = /(grind|grinding|slip|slipping|overheat|overheating|misfire|check engine|engine light|leak|smoke|smoking|knock|clunk|stall|stalls|no start|won't start)/i;
  const context = /(engine|transmission|coolant|radiator|oil|power steering|brake|axle|diff|differential|transfer case|4wd|awd|starter|alternator|battery|fuel|exhaust|cv|drivetrain)/i;

  if (!symptom.test(text)) return false;
  if (!context.test(text)) return false;

  if (/(tear|torn)\b/i.test(text) && !/(leak|stall|no start|overheat|misfire|knock|slip|grind|smoke)/i.test(text)) {
    return false;
  }

  return true;
}

function currentYear() {
  return new Date().getFullYear();
}

function hasRecentMaintenanceClaim(snapshot) {
  const text = normalizeText(
    [snapshot?.seller_description, snapshot?.source_text, ...(snapshot?.about_items || [])].join(" ")
  );
  return /(recent maintenance|within the last|last \d+\s*(months?|weeks?)|fresh oil change|new brake pads|full tune-?up|brand new tires|new tires|new (thermostat|water pump|radiator|starter|alternator|battery))/i.test(
    text
  );
}

function parseMiles(text) {
  const t = (text || "").toLowerCase().replace(/,/g, "");
  const m = t.match(/(\d+(\.\d+)?)\s*(k)?\s*miles?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[3] ? Math.round(n * 1000) : Math.round(n);
}

function parseTimeMonths(text) {
  const t = (text || "").toLowerCase();
  const mm = t.match(/(\d+(\.\d+)?)\s*(\+)?\s*months?/);
  if (mm) return Math.round(Number(mm[1]));
  const yy = t.match(/(\d+(\.\d+)?)\s*(\+)?\s*years?/);
  if (yy) return Math.round(Number(yy[1]) * 12);
  return null;
}

function parseRange(line) {
  const parts = String(line || "").split("(")[0];
  const [lhs, rhs] = parts.split("/").map((s) => (s || "").trim());
  const miles = parseMiles(lhs);
  const months = parseTimeMonths(rhs);
  return { miles, months };
}

function extractCaseLine(s, label) {
  const re = new RegExp(`${label}\\s*:\\s*([^\\n]*)`, "i");
  const m = String(s || "").match(re);
  return m ? `${label}: ${m[1].trim()}` : null;
}

function extractAssumption(line) {
  const m = String(line || "").match(/\(([^)]+)\)\s*$/);
  return m ? m[1].trim() : "";
}

function formatMiles(miles) {
  if (!Number.isFinite(miles)) return "unknown";
  if (miles >= 1000) return `${Math.round(miles / 1000)}k miles`;
  return `${Math.round(miles)} miles`;
}

function formatMonths(months) {
  if (!Number.isFinite(months)) return "unknown";
  const yrs = months / 12;
  if (months < 18) return `${Math.round(months)} months`;
  const rounded = Math.round(yrs * 2) / 2;
  return `${rounded} years`;
}

function clampInt(n, min, max) {
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function durabilityBucket(snapshot) {
  const make = normalizeText(snapshot?.make);
  const model = normalizeText(snapshot?.model);
  const truckish =
    /(tacoma|4runner|land cruiser|sequoia|tundra|hilux|gx|lx)/i.test(model) ||
    make === "toyota" ||
    (make === "honda" && /(cr-v|pilot|ridgeline)/i.test(model));

  const jeepis = make === "jeep";
  const euro = /(bmw|mercedes|mercedes-benz|audi|vw|volkswagen|mini)/i.test(make);

  if (truckish) return "durable";
  if (euro) return "complex";
  if (jeepis) return "mixed";
  return "normal";
}

function isTruckOrTruckBased(snapshot) {
  const make = normalizeText(snapshot?.make);
  const model = normalizeText(snapshot?.model);
  const source = normalizeText([snapshot?.source_text, snapshot?.seller_description].join(" "));

  const truckModels =
    /(tacoma|tundra|4runner|sequoia|land cruiser|gx|lx|hilux|frontier|titan|ranger|f-?150|f-?250|silverado|sierra|ram|colorado|canyon)/i;

  const listingSaysPickupOrTruck = /(pickup|truck)\b/i.test(source);
  const isJeepTruckish = make === "jeep" && /(wrangler|gladiator)/i.test(model);

  return truckModels.test(model) || listingSaysPickupOrTruck || isJeepTruckish;
}

function scrubUnsupportedDrivetrainQuestion(q, snapshot) {
  const s = normalizeText(q);
  if (!s) return q;

  if (isTruckOrTruckBased(snapshot) && /(fwd|awd)/i.test(s) && /(is it|fwd or awd|awd or fwd)/i.test(s)) {
    return "Is it 2WD or 4WD, and does 4HI/4LO engage smoothly? (transfer case/actuator cost)";
  }
  return q;
}

function scrubTimingBeltQuestion(q, snapshot) {
  const make = normalizeText(snapshot?.make);
  const model = normalizeText(snapshot?.model);
  const s = normalizeText(q);

  const likelyTimingChainToyotaTruck =
    make === "toyota" && /(tacoma|tundra|4runner|sequoia|land cruiser|gx|lx)/i.test(model);

  if (likelyTimingChainToyotaTruck && /timing belt/i.test(s)) {
    return "Any timing chain rattle on cold start? (chain/tensioner wear signal)";
  }

  if (/timing belt/i.test(s)) {
    return "Does this engine use a timing belt or chain, and is timing service documented? (avoids wrong maintenance)";
  }

  return q;
}

function lifespanBandAnchors(bucket, milesNow) {
  const m = Number.isFinite(milesNow) ? milesNow : 150000;

  if (bucket === "durable") {
    if (m < 60000) return { best: 160000, avg: 120000, worst: 30000 };
    if (m < 120000) return { best: 120000, avg: 80000, worst: 20000 };
    if (m < 180000) return { best: 80000, avg: 50000, worst: 15000 };
    return { best: 50000, avg: 30000, worst: 10000 };
  }

  if (bucket === "complex") {
    if (m < 60000) return { best: 110000, avg: 80000, worst: 20000 };
    if (m < 120000) return { best: 80000, avg: 50000, worst: 15000 };
    if (m < 180000) return { best: 45000, avg: 25000, worst: 12000 };
    return { best: 25000, avg: 15000, worst: 10000 };
  }

  if (bucket === "mixed") {
    if (m < 60000) return { best: 130000, avg: 95000, worst: 25000 };
    if (m < 120000) return { best: 95000, avg: 65000, worst: 20000 };
    if (m < 180000) return { best: 60000, avg: 35000, worst: 15000 };
    return { best: 35000, avg: 20000, worst: 10000 };
  }

  if (m < 60000) return { best: 140000, avg: 105000, worst: 25000 };
  if (m < 120000) return { best: 105000, avg: 70000, worst: 20000 };
  if (m < 180000) return { best: 65000, avg: 40000, worst: 15000 };
  return { best: 40000, avg: 25000, worst: 10000 };
}

function milesToYearsRounded(miles, annualMiles) {
  if (!Number.isFinite(miles) || !Number.isFinite(annualMiles) || annualMiles <= 0) return null;
  const yrs = miles / annualMiles;
  return Math.round(yrs * 2) / 2;
}

function buildLifespanAnchorsForPrompt(snapshot) {
  const milesNow = asNumber(snapshot?.mileage_miles, null);
  const bucket = durabilityBucket(snapshot);
  const annual = annualMilesAssumption(snapshot, bucket);

  const anchors = lifespanBandAnchors(bucket, milesNow);

  const titleStatus = deriveTitleStatus(snapshot);
  const missingPowertrain = !snapshot?.engine || !snapshot?.transmission;
  const missingDrivetrain = !snapshot?.drivetrain;

  let penalty = 0;
  if (missingPowertrain) penalty += 0.12;
  if (missingDrivetrain) penalty += 0.05;
  if (titleStatus === "unknown") penalty += 0.06;
  if (titleStatus === "rebuilt") penalty += 0.2;
  if (titleStatus === "lien") penalty += 0.1;
  penalty = Math.min(0.35, penalty);

  const adj = (x) => Math.max(10000, Math.round(x * (1 - penalty)));

  const bestMiles = adj(anchors.best);
  const avgMiles = adj(anchors.avg);
  const worstMiles = Math.max(10000, adj(anchors.worst));

  const bestYears = milesToYearsRounded(bestMiles, annual);
  const avgYears = milesToYearsRounded(avgMiles, annual);
  const worstYears = milesToYearsRounded(worstMiles, annual);

  return {
    platform_bucket: bucket,
    annual_miles_assumption: annual,
    remaining_miles_anchors: {
      best_case: bestMiles,
      average_case: avgMiles,
      worst_case: worstMiles
    },
    time_anchors_years: {
      best_case: bestYears,
      average_case: avgYears,
      worst_case: worstYears
    },
    guidance:
      "Use these as a starting point for remaining_lifespan_estimate. Shorten worst-case materially only if an active symptom exists. " +
      "If service records are strong, you may move toward best-case; if history is unclear, stay near average."
  };
}

function annualMilesAssumption(snapshot, bucket) {
  const text = normalizeText([snapshot?.seller_description, snapshot?.source_text].join(" "));
  const lowUse = /(weekend|rarely|seldom|garaged|in town|in-town|short trips)/i.test(text);
  if (lowUse) return 9000;

  if (bucket === "durable") return 12000;
  if (bucket === "complex") return 10000;
  return 11000;
}

function targetEndMileage(bucket) {
  if (bucket === "durable") return 250000;
  if (bucket === "mixed") return 200000;
  if (bucket === "complex") return 170000;
  return 200000;
}

function buildLifespanEstimate(out, snapshot) {
  const milesNow = asNumber(snapshot?.mileage_miles, null);
  const m = Number.isFinite(milesNow) ? milesNow : 150000;

  const symptom = hasActiveSymptom(snapshot);
  const bucket = durabilityBucket(snapshot);
  const recentMaint = hasRecentMaintenanceClaim(snapshot);
  const records = hasServiceRecordsClaim(snapshot);
  const titleStatus = deriveTitleStatus(snapshot);

  const missingPowertrain = !snapshot?.engine || !snapshot?.transmission;
  const missingDrivetrain = !snapshot?.drivetrain;
  const infoPenalty = (missingPowertrain ? 0.15 : 0) + (missingDrivetrain ? 0.05 : 0);
  const titlePenalty =
    titleStatus === "rebuilt" ? 0.25 : titleStatus === "lien" ? 0.1 : titleStatus === "unknown" ? 0.08 : 0;
  const symptomPenalty = symptom ? 0.45 : 0;
  const penalty = Math.min(
    0.75,
    infoPenalty + titlePenalty + symptomPenalty + (records ? -0.1 : 0) + (recentMaint ? -0.05 : 0)
  );

  const end = targetEndMileage(bucket);
  let avgMiles = Math.max(12000, end - m);
  avgMiles = Math.max(5000, Math.round(avgMiles * (1 - penalty)));

  let bestMiles = Math.round(avgMiles * (records || recentMaint ? 1.25 : 1.15));
  let worstMiles = Math.round(avgMiles * (symptom ? 0.25 : 0.55));

  if (!symptom) {
    worstMiles = Math.max(worstMiles, 10000);
  } else {
    worstMiles = Math.min(worstMiles, 5000);
  }

  if (m >= 250000) {
    bestMiles = Math.min(bestMiles, 30000);
    avgMiles = Math.min(avgMiles, 20000);
    worstMiles = Math.min(worstMiles, symptom ? 3000 : 10000);
  }

  const annual = annualMilesAssumption(snapshot, bucket);
  const milesToMonths = (mi) => Math.round((mi / Math.max(6000, annual)) * 12);

  let avgMonths = milesToMonths(avgMiles);
  let bestMonths = milesToMonths(bestMiles);
  let worstMonths = milesToMonths(worstMiles);

  if (!symptom) {
    worstMonths = Math.max(worstMonths, 12);
  } else {
    worstMonths = Math.min(worstMonths, 3);
  }

  bestMiles = Math.max(bestMiles, avgMiles);
  worstMiles = Math.min(worstMiles, avgMiles);

  bestMonths = Math.max(bestMonths, avgMonths);
  worstMonths = Math.min(worstMonths, avgMonths);

  bestMiles = clampInt(bestMiles, 0, 150000) ?? bestMiles;
  avgMiles = clampInt(avgMiles, 0, bestMiles) ?? avgMiles;
  worstMiles = clampInt(worstMiles, 0, avgMiles) ?? worstMiles;

  bestMonths = clampInt(bestMonths, 0, 180) ?? bestMonths;
  avgMonths = clampInt(avgMonths, 0, bestMonths) ?? avgMonths;
  worstMonths = clampInt(worstMonths, 0, avgMonths) ?? worstMonths;

  const bestAssump = records
    ? "well-maintained + records"
    : recentMaint
      ? "well-maintained + recent service"
      : "well-maintained";
  const avgAssump = "typical upkeep at this mileage";
  const worstAssump = symptom ? "active symptom is major fault" : "deferred maintenance/hidden issues";

  out.remaining_lifespan_estimate =
    `Best-case: ${formatMiles(bestMiles)} / ${formatMonths(bestMonths)} (${bestAssump})\n` +
    `Average-case: ${formatMiles(avgMiles)} / ${formatMonths(avgMonths)} (${avgAssump})\n` +
    `Worst-case: ${formatMiles(worstMiles)} / ${formatMonths(worstMonths)} (${worstAssump})`;
}

function normalizeLifespanEstimate(out, snapshot) {
  const s = out.remaining_lifespan_estimate;
  if (!s) return;

  const bestLine = extractCaseLine(s, "Best-case");
  const avgLine = extractCaseLine(s, "Average-case");
  const worstLine = extractCaseLine(s, "Worst-case");

  const symptom = hasActiveSymptom(snapshot);

  if (!symptom && /active symptom/i.test(s)) {
    out.remaining_lifespan_estimate = s.replace(/active symptom[^)\n]*/gi, "deferred maintenance/hidden issues");
  }

  const parsed = {
    best: { ...parseRange(bestLine), assumption: extractAssumption(bestLine) },
    avg: { ...parseRange(avgLine), assumption: extractAssumption(avgLine) },
    worst: { ...parseRange(worstLine), assumption: extractAssumption(worstLine) }
  };

  const parseOk =
    Number.isFinite(parsed.best.miles) &&
    Number.isFinite(parsed.avg.miles) &&
    Number.isFinite(parsed.worst.miles) &&
    Number.isFinite(parsed.best.months) &&
    Number.isFinite(parsed.avg.months) &&
    Number.isFinite(parsed.worst.months);

  if (!parseOk) return;

  let bestMiles = parsed.best.miles;
  let avgMiles = parsed.avg.miles;
  let worstMiles = parsed.worst.miles;

  let bestMonths = parsed.best.months;
  let avgMonths = parsed.avg.months;
  let worstMonths = parsed.worst.months;

  avgMiles = Math.min(avgMiles, bestMiles);
  worstMiles = Math.min(worstMiles, avgMiles);
  avgMonths = Math.min(avgMonths, bestMonths);
  worstMonths = Math.min(worstMonths, avgMonths);

  if (!symptom) {
    worstMiles = Math.max(worstMiles, 10000);
    worstMonths = Math.max(worstMonths, 12);
  }

  out.remaining_lifespan_estimate =
    `Best-case: ${formatMiles(bestMiles)} / ${formatMonths(bestMonths)} (${parsed.best.assumption || "well-maintained"})\n` +
    `Average-case: ${formatMiles(avgMiles)} / ${formatMonths(avgMonths)} (${parsed.avg.assumption || "typical upkeep"})\n` +
    `Worst-case: ${formatMiles(worstMiles)} / ${formatMonths(worstMonths)} (${parsed.worst.assumption || (symptom ? "active symptom is major fault" : "deferred maintenance/hidden issues")})`;
}

function ensureBuyerQuestions(out, snapshot, titleStatus) {
  const sellerText = normalizeText(snapshot?.seller_description);
  const mileage = Number(snapshot?.mileage_miles);
  const genericRe = /(any issues|any accidents|accident history|issues\?)/i;
  const componentRe =
    /(engine|transmission|trans\b|turbo|timing|diff|differential|transfer case|ptu|steering|rack|suspension|strut|ball joint|alternator|battery|a\/c|ac\b|coolant|radiator|oil|brake|drivetrain|4wd|awd)/i;

  const ensureWhy = (q) => (/\([^)]+\)\s*$/.test(q) ? q : `${q} (why it matters)`);
  const isComponentSpecific = (q) => componentRe.test(q);
  const seen = new Set();
  const addUnique = (list, q) => {
    const key = normalizeText(q);
    if (!key || seen.has(key)) return;
    seen.add(key);
    list.push(ensureWhy(q));
  };

  const base = asArray(out.buyer_questions)
    .map((q) => asString(q, ""))
    .filter((q) => q && !genericRe.test(q));

  const list = [];
  base.forEach((q) => addUnique(list, q));

  const candidates = [];
  const make = normalizeText(snapshot?.make);
  if (!snapshot?.drivetrain) {
    if (isTruckOrTruckBased(snapshot)) {
      candidates.push("Is it 2WD or 4WD, and does 4HI/4LO engage smoothly? (transfer case/actuator cost)");
    } else {
      const example = make.includes("mercedes") ? " (e.g., 4MATIC)" : "";
      candidates.push(`Is it FWD or AWD${example}? (changes maintenance/traction)`);
    }
  }
  if (!snapshot?.transmission || !snapshot?.engine) {
    candidates.push("Which transmission/engine is it exactly? (changes risk profile)");
  }
  if (/new brake pads/i.test(sellerText)) {
    candidates.push("Were rotors resurfaced/replaced with the pads? (prevents vibration)");
    candidates.push("Has brake fluid been flushed recently? (moisture corrosion risk)");
  }
  if (/brand new|new tires|continental/i.test(sellerText)) {
    candidates.push("Any alignment done after tire install? (prevents uneven wear)");
  }
  if (sellerText.includes("ac") || sellerText.includes("a/c")) {
    candidates.push("Does the A/C blow cold at idle? (compressor/charge check)");
  }
  if (Number.isFinite(mileage) && mileage > 120000) {
    candidates.push("If automatic, when was the transmission fluid serviced? (120k+ wear item)");
  }
  if (titleStatus === "unknown") {
    candidates.push("Can you provide VIN + title status details? (history/resale impact)");
  }
  candidates.push("Any oil leaks after a warm idle? (hidden engine wear)");
  candidates.push("Any drivetrain noises on turns/accel? (axle/diff wear)");

  // Ensure at least 2 component-specific questions.
  let componentCount = list.filter(isComponentSpecific).length;
  for (const q of candidates) {
    if (list.length >= 7) break;
    if (componentCount >= 2) break;
    if (isComponentSpecific(q)) {
      addUnique(list, q);
      componentCount += 1;
    }
  }
  for (const q of candidates) {
    if (list.length >= 7) break;
    addUnique(list, q);
  }
  while (list.length < 4) addUnique(list, "Any warning lights or stored codes? (hidden faults)");

  out.buyer_questions = list
    .slice(0, 7)
    .map((q) => scrubUnsupportedDrivetrainQuestion(q, snapshot))
    .map((q) => scrubTimingBeltQuestion(q, snapshot));
}

function sharpenRiskFlags(out, snapshot, titleStatus) {
  const flags = asArray(out.risk_flags).map((f) => asString(f, "")).filter(Boolean);
  const updated = [];
  const vagueHighMileage = /high mileage/i;

  for (const flag of flags) {
    if (vagueHighMileage.test(flag) && !/->|\$|cost|risk/i.test(flag)) {
      updated.push("High mileage -> drivetrain/engine wear risk ($unknown)");
      continue;
    }
    if (!/\$/i.test(flag)) {
      updated.push(`${flag} ($unknown)`);
      continue;
    }
    updated.push(flag);
  }

  const derived = [];
  if (titleStatus === "unknown") {
    derived.push("Title status unknown -> resale/insurance uncertainty ($unknown)");
  }
  if (!snapshot?.drivetrain) {
    derived.push("Drivetrain unknown -> parts/maintenance mismatch risk ($unknown)");
  }
  if (!snapshot?.transmission) {
    derived.push("Transmission unknown -> service/repair risk ($unknown)");
  }
  if (!snapshot?.seller_description) {
    derived.push("Limited history -> deferred maintenance risk ($unknown)");
  }

  const combined = [...updated, ...derived];
  out.risk_flags = combined.slice(0, 6).filter(Boolean);
  while (out.risk_flags.length < 3) {
    out.risk_flags.push("Inspection findings unknown -> hidden repair risk ($unknown)");
  }
}

function groundReputation(out) {
  const rep = out.year_model_reputation || "";
  if (!rep) return;
  if (/no (single )?(major )?platform-wide (deal-breaker )?issues|no major issues|no known issues/i.test(rep)) {
    out.year_model_reputation =
      "Reputation depends heavily on maintenance and powertrain condition for this specific listing; verify engine/trans/drivetrain details and service history.";
  }
}

function fixWearItemCosts(out, snapshot) {
  const sellerText = normalizeText(snapshot?.seller_description);
  const hasNewTires = /new tires|brand new tires|continental tires|tires w\/ warranty|tires with warranty/i.test(
    sellerText
  );

  out.wear_items = asArray(out.wear_items).map((x) => {
    if (!x?.item) return x;
    if (!/tire/i.test(x.item)) return x;

    if (hasNewTires) {
      return {
        ...x,
        item: x.item,
        estimated_cost_diy: "$0–$50 (rotate/inspect only)",
        estimated_cost_shop: "$40–$120"
      };
    }

    return {
      ...x,
      estimated_cost_diy: "$500–$1,000 (set of 4)",
      estimated_cost_shop: "$700–$1,300"
    };
  });
}

function applyCompletedServiceOverrides(out, snapshot) {
  const t = normalizeText([snapshot?.seller_description, snapshot?.source_text, ...(snapshot?.about_items || [])].join(" "));

  const hasNewTires =
    /(brand new|new)\s+(tires|tyres)/i.test(t) ||
    /(continental)\s+(pro contact|procontact)/i.test(t) ||
    /(same ones it came with)/i.test(t);

  const hasNewPads = /(new|brand new)\s+brake\s+pads/i.test(t) || /(fresh)\s+brake\s+pads/i.test(t);
  const hasFreshOil = /(fresh)\s+oil\s+change|oil\s+change\s*(done|completed)?/i.test(t);
  const hasTuneUp = /(full\s+tune-?up|tune-?up)/i.test(t);

  out.wear_items = asArray(out.wear_items).map((x) => {
    if (!x?.item) return x;
    const item = normalizeText(x.item);

    if (hasNewTires && /tire|tyre/.test(item)) {
      return {
        ...x,
        item: "Tires (new per seller — verify receipt/date)",
        typical_mileage_range: "Now",
        why_it_matters: "Confirms install + correct spec",
        estimated_cost_diy: "$0–$50 (inspect/rotate only)",
        estimated_cost_shop: "$40–$120"
      };
    }

    if (hasNewPads && /brake\s*pads?/.test(item)) {
      return {
        ...x,
        item: "Brake pads (new per seller — verify receipt/date)",
        typical_mileage_range: "Now",
        why_it_matters: "Confirms quality + proper bedding",
        estimated_cost_diy: "$0–$50 (inspect only)",
        estimated_cost_shop: "$50–$150"
      };
    }

    return x;
  });

  const dropIf = (s, re) => re.test(normalizeText(s));
  out.risk_flags = asArray(out.risk_flags)
    .map((s) => asString(s, ""))
    .filter(Boolean)
    .filter((rf) => {
      if (hasNewTires && dropIf(rf, /(tire|tyre).*(replace|replacement|needed soon|due)/i)) return false;
      if (hasNewPads && dropIf(rf, /(brake).*(pads?).*(replace|replacement|needed soon|due)/i)) return false;
      return true;
    });

  const addChecklist = (line) => {
    const key = normalizeText(line);
    const exists = asArray(out.inspection_checklist).some((x) => normalizeText(x) === key);
    if (!exists) out.inspection_checklist.unshift(line);
  };

  if (hasNewTires) addChecklist("Verify tire install date/receipt + check even wear (confirms alignment/suspension)");
  if (hasNewPads) addChecklist("Verify brake pad/rotor condition + test for pulsation (quality of brake job)");
  if (hasFreshOil) addChecklist("Confirm oil type/spec + look for leaks after warm idle (baseline health)");
  if (hasTuneUp) addChecklist("Ask what ‘tune-up’ included (plugs/filters/fluids) and verify receipts");

  const ensureQuestion = (q) => {
    const key = normalizeText(q);
    if (!asArray(out.buyer_questions).some((x) => normalizeText(x) === key)) out.buyer_questions.push(q);
  };

  if (hasNewTires) ensureQuestion("Do you have the tire invoice and install date? (confirms warranty/spec)");
  if (hasNewPads) ensureQuestion("Were rotors resurfaced/replaced with the pads? (prevents vibration)");
  if (hasTuneUp) ensureQuestion("What did the ‘full tune-up’ include exactly? (avoids vague claims)");

  out.buyer_questions = asArray(out.buyer_questions).slice(0, 7);
}

function dropGenericOilChangeFromNearTerm(out, snapshot) {
  const sellerText = normalizeText([snapshot?.seller_description, snapshot?.source_text].join(" "));
  const sellerMentionsFreshOil = /(fresh)\s+oil\s+change|oil\s+change\s*(done|completed|recent)/i.test(sellerText);

  const items = asArray(out.expected_maintenance_near_term);
  if (!items.length || sellerMentionsFreshOil) return;

  const isGenericOil = (x) => {
    const item = normalizeText(x?.item);
    const why = normalizeText(x?.why_it_matters);
    const range = normalizeText(x?.typical_mileage_range);
    return /oil\s+change/.test(item) || /5,?000|7,?500/.test(range) || /engine longevity/.test(why);
  };

  const kept = items.filter((x) => !isGenericOil(x));
  if (kept.length >= 1) out.expected_maintenance_near_term = kept;
}

function replaceSpeculativeCELMaintenance(out, snapshot) {
  if (!hasActiveSymptom(snapshot)) return;

  const replaceIfSpeculative = (arr) =>
    asArray(arr).map((x) => {
      const item = asString(x?.item, "");
      const why = asString(x?.why_it_matters, "");
      const looksLikeGuess = /o2\s*sensor/i.test(item) || /engine light/i.test(why) || /may indicate/i.test(why);
      if (!looksLikeGuess) return x;

      return {
        ...x,
        item: "Scan CEL codes + diagnose root cause",
        typical_mileage_range: "Now",
        why_it_matters: "Determines if fault is minor vs major",
        estimated_cost_diy: "$0–$50",
        estimated_cost_shop: "$100–$200"
      };
    });

  out.expected_maintenance_near_term = replaceIfSpeculative(out.expected_maintenance_near_term);
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

  // Still read from model, but we overwrite with deterministic builder.
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
  const confidenceScore = Math.round(out.confidence * 100);
  if (score == null) score = confidenceScore;
  score = clamp(Math.round(score), 0, 100);
  if (Number.isFinite(score) && Math.abs(score - confidenceScore) >= 40) {
    score = confidenceScore;
  }
  out.overall_score = score;

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

  const derivedTitleStatus = ensureTitleConsistency(out, snapshot);
  fixKnownMaintenance(out, snapshot);
  replaceSpeculativeCELMaintenance(out, snapshot);
  fixWearItemCosts(out, snapshot);
  applyCompletedServiceOverrides(out, snapshot);
  dropGenericOilChangeFromNearTerm(out, snapshot);
  ensureBuyerQuestions(out, snapshot, derivedTitleStatus);
  sharpenRiskFlags(out, snapshot, derivedTitleStatus);
  groundReputation(out);
  normalizeLifespanEstimate(out, snapshot);
  applyExtremeMileageCaps(out, snapshot);

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
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }

      if (url.pathname === "/stripe/webhook") {
        if (request.method !== "POST") {
          return jsonResponse({ error: "Method not allowed" }, origin, 405);
        }
        const signature = request.headers.get("Stripe-Signature");
        const payloadText = await request.text();
        const verified = await verifyStripeSignature(payloadText, signature, env.STRIPE_WEBHOOK_SECRET);
        if (!verified) return jsonResponse({ error: "Invalid signature" }, origin, 400);

        let event = null;
        try {
          event = JSON.parse(payloadText);
        } catch {
          return jsonResponse({ error: "Invalid webhook payload" }, origin, 400);
        }

        const eventType = event?.type || "";
        const dataObject = event?.data?.object || {};
        let userId = dataObject?.client_reference_id || dataObject?.metadata?.user_id || null;
        if (!userId) {
          const email = dataObject?.customer_details?.email || dataObject?.customer_email || null;
          const user = await findOrCreateSupabaseUserByEmail(email, env);
          userId = user?.id || null;
        }

        if (userId) {
          const status = dataObject?.status || dataObject?.subscription_status || "unknown";
          const stripeCustomerId = dataObject?.customer || dataObject?.customer_id || null;
          await supabaseAdminRequest("/rest/v1/subscriptions", env, {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates" },
            body: JSON.stringify({
              user_id: userId,
              status,
              plan: "monthly",
              stripe_customer_id: stripeCustomerId,
              updated_at: new Date().toISOString()
            })
          });
        }

        return jsonResponse({ received: true, type: eventType }, origin, 200);
      }

      if (url.pathname === "/auth/status") {
        if (request.method !== "POST") {
          return jsonResponse({ error: "Method not allowed" }, origin, 405);
        }
        const token = getAuthToken(request);
        const user = await fetchSupabaseUser(token, env);
        if (!user) return jsonResponse({ authenticated: false }, origin, 200);
        const sub = await getSubscriptionRecord(user.id, env);
        const validated = isSubscriptionActive(sub);
        return jsonResponse(
          {
            authenticated: true,
            validated,
            user_id: user.id,
            email: user.email || "unknown",
            subscription_status: sub?.status || "unknown"
          },
          origin,
          200
        );
      }

      if (url.pathname === "/billing/checkout") {
        const token = getAuthToken(request);
        const user = token ? await fetchSupabaseUser(token, env) : null;

        let email = "";
        if (request.method === "GET") {
          email = (url.searchParams.get("email") || "").toString().trim();
        } else if (request.method === "POST") {
          let payload = null;
          try {
            payload = await request.json();
          } catch {
            payload = null;
          }
          email = (payload?.email || "").toString().trim();
        } else {
          return jsonResponse({ error: "Method not allowed" }, origin, 405);
        }

        if (!env.STRIPE_PRICE_ID || !env.STRIPE_SUCCESS_URL || !env.STRIPE_CANCEL_URL) {
          return jsonResponse({ error: "Billing not configured" }, origin, 500);
        }

        let resolvedUserId = user?.id || null;
        if (!resolvedUserId && email) {
          const emailUser = await findOrCreateSupabaseUserByEmail(email, env);
          resolvedUserId = emailUser?.id || null;
        }

        const body = new URLSearchParams({
          mode: "subscription",
          "line_items[0][price]": env.STRIPE_PRICE_ID,
          "line_items[0][quantity]": "1",
          success_url: env.STRIPE_SUCCESS_URL,
          cancel_url: env.STRIPE_CANCEL_URL,
          ...(resolvedUserId ? { client_reference_id: resolvedUserId } : {}),
          ...(user?.email || email ? { customer_email: user?.email || email } : {})
        });
        const sessionRes = await stripeRequest(env, "checkout/sessions", body);
        if (!sessionRes?.ok) {
          return jsonResponse(
            { error: sessionRes?.error || "Unable to create checkout", stripe_status: sessionRes?.status },
            origin,
            502
          );
        }
        const session = sessionRes.data;
        if (!session?.url) return jsonResponse({ error: "Unable to create checkout" }, origin, 502);
        if (request.method === "GET") {
          return Response.redirect(session.url, 303);
        }
        return jsonResponse({ url: session.url }, origin, 200);
      }

      if (url.pathname === "/billing/portal") {
        if (request.method !== "POST") {
          return jsonResponse({ error: "Method not allowed" }, origin, 405);
        }
        const token = getAuthToken(request);
        const user = await fetchSupabaseUser(token, env);
        if (!user) return jsonResponse({ error: "Unauthorized" }, origin, 401);
        const sub = await getSubscriptionRecord(user.id, env);
        const customerId = sub?.stripe_customer_id;
        if (!customerId || !env.STRIPE_SUCCESS_URL) {
          return jsonResponse({ error: "Billing not configured" }, origin, 500);
        }
        const body = new URLSearchParams({
          customer: customerId,
          return_url: env.STRIPE_SUCCESS_URL
        });
        const sessionRes = await stripeRequest(env, "billing_portal/sessions", body);
        if (!sessionRes?.ok) {
          return jsonResponse(
            { error: sessionRes?.error || "Unable to create portal session", stripe_status: sessionRes?.status },
            origin,
            502
          );
        }
        const session = sessionRes.data;
        if (!session?.url) return jsonResponse({ error: "Unable to create portal session" }, origin, 502);
        return jsonResponse({ url: session.url }, origin, 200);
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
        trim: payload?.trim || null,
        trim_conflict: payload?.trim_conflict ?? null,
        vehicle_type_hint: payload?.vehicle_type_hint || null,
        drivetrain: payload?.drivetrain || null,
        transmission: payload?.transmission || null,
        engine: payload?.engine || null,
        title_status: payload?.title_status || null,
        owners: payload?.owners ?? null,
        price_usd: payload?.price_usd ?? null,
        mileage_miles: payload?.mileage_miles ?? null,
        vin: payload?.vin || null,
        seller_description: payload?.seller_description || null,
        about_items: payload?.about_items || [],
        provenance: payload?.provenance || null,
        negotiation_points: payload?.negotiation_points || []
      };

      const authToken = getAuthToken(request);
      const authUser = await fetchSupabaseUser(authToken, env);
      const authSub = authUser ? await getSubscriptionRecord(authUser.id, env) : null;
      const authValidated = isSubscriptionActive(authSub);

      if (!snapshot.year || !snapshot.make) {
        return jsonResponse({ error: "Missing required fields", required: ["year", "make"] }, origin, 400);
      }

      const lifespanAnchors = buildLifespanAnchorsForPrompt(snapshot);

      const cacheSeed = snapshot.url || snapshot.vin || JSON.stringify(snapshot);
      const snapshotKey = await hashString(String(cacheSeed));
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

      const facts = {
        year: snapshot.year,
        make: snapshot.make,
        model: snapshot.model,
        trim: snapshot.trim,
        price_usd: snapshot.price_usd,
        mileage_miles: snapshot.mileage_miles,
        drivetrain: snapshot.drivetrain,
        transmission: snapshot.transmission,
        title_status: snapshot.title_status,
        seller_claims: snapshot.seller_description
      };

      // Prompt: keep focused on this listing and structured outputs
      const userPrompt = [
        "Evaluate this used car listing snapshot for a buyer.",
        "Be specific. Do not contradict the canonical facts.",
        "",
        "Canonical facts (do not contradict):",
        JSON.stringify(facts, null, 2),
        "",
        "Field requirements (follow exactly):",
        "- summary: 2–4 sentences using listing facts.",
        "- year_model_reputation: 1–3 sentences; if uncertain about platform specifics, say so.",
        "- expected_maintenance_near_term: 3–6 items with cost ranges.",
        "- common_issues: [] unless highly confident for this exact year/generation/powertrain.",
        "- wear_items: 2–4 items; if seller claims new wear items, say 'verify receipt/date'.",
        "- remaining_lifespan_estimate: exactly 3 lines (Best/Average/Worst), each with (assumption).",
        "- risk_flags: 3–6; each includes subsystem + consequence + ($range or $unknown).",
        "- buyer_questions: 4–7; each has (why it matters); at least 2 component-specific.",
        "- deal_breakers: 3–6 concrete inspection/test-drive findings.",
        "- tags: 3–6 short tags.",
        "",
        "Confidence rubric:",
        "- 0.85–1.00 only if powertrain + title + records are clear.",
        "- 0.65–0.84 if powertrain known but history unclear.",
        "- 0.45–0.64 if powertrain or title is unknown.",
        "- <=0.44 if >=250k miles or active symptoms.",
        "",
        "Snapshot JSON:",
        JSON.stringify(snapshot, null, 2),
        "",
        "Lifespan anchors (calibration reference):",
        JSON.stringify(lifespanAnchors, null, 2)
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
          temperature: 0.15,
          max_output_tokens: 1600,
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
      res.headers.set("X-User-Validated", authValidated ? "true" : "false");
      if (authUser?.id) res.headers.set("X-User-Id", authUser.id);

      ctx?.waitUntil?.(cache.put(cacheKey, res.clone()));
      return res;
    } catch (err) {
      return jsonResponse(
        {
          error: "Unhandled error",
          details: err?.message || String(err || "unknown")
        },
        origin,
        500
      );
    }
  }
};
