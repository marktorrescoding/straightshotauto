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
const CACHE_VERSION = "v17"; // bump for AWD inference, sparse listing flag, reputation/deal-breaker prompt fixes
const FREE_DAILY_LIMIT = 5;
const RATE_MIN_INTERVAL_MS = 0;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_REQUESTS = 120;

const rateState = new Map();
const inFlight = new Map();

async function dedupe(key, fn) {
  const existing = inFlight.get(key);
  // Each caller must get its own clone: multiple handlers returning the same
  // Response object would share a single body stream, causing Cloudflare to
  // generate a no-CORS 500 when the second handler tries to send an already-
  // consumed body.
  if (existing) return (await existing).clone();

  const p = (async () => {
    try {
      return await fn();
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, p);
  return (await p).clone();
}

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

function htmlResponse(html, origin, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
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

function utcDayStampNow() {
  return new Date().toISOString().slice(0, 10);
}

function parseFreeUsageRecord(raw) {
  if (!raw) return { count: 0, seen_snapshot_keys: [] };
  try {
    const parsed = JSON.parse(raw);
    const count = Number.isFinite(Number(parsed?.count)) ? Math.max(0, Number(parsed.count)) : 0;
    const seen = Array.isArray(parsed?.seen_snapshot_keys)
      ? parsed.seen_snapshot_keys.map((x) => String(x || "")).filter(Boolean).slice(0, 100)
      : [];
    return { count, seen_snapshot_keys: seen };
  } catch {
    return { count: 0, seen_snapshot_keys: [] };
  }
}

async function consumeFreeAnalysisSlot(request, cache, snapshotKey) {
  const ip = getClientIp(request);
  const ua = (request.headers.get("User-Agent") || "").slice(0, 180);
  const bucketSource = `${utcDayStampNow()}|${ip}|${ua}`;
  const bucketHash = await hashString(bucketSource);
  const usageReq = new Request(`https://quota.car-bot.local/free/${bucketHash}`);

  const existing = await cache.match(usageReq);
  const record = parseFreeUsageRecord(existing ? await existing.text() : "");

  if (record.seen_snapshot_keys.includes(snapshotKey)) {
    return { ok: true, remaining: Math.max(0, FREE_DAILY_LIMIT - record.count), count: record.count };
  }

  if (record.count >= FREE_DAILY_LIMIT) {
    return { ok: false, remaining: 0, count: record.count };
  }

  const nextCount = record.count + 1;
  const seenSet = new Set(record.seen_snapshot_keys);
  seenSet.add(snapshotKey);
  const nextRecord = {
    count: nextCount,
    seen_snapshot_keys: Array.from(seenSet).slice(-100)
  };

  await cache.put(
    usageReq,
    new Response(JSON.stringify(nextRecord), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=172800"
      }
    })
  );

  return { ok: true, remaining: Math.max(0, FREE_DAILY_LIMIT - nextCount), count: nextCount };
}

function freeLimitResponse(origin, requestId, snapshotKey) {
  return new Response(
    JSON.stringify({
      error: "Free limit reached. Log in or subscribe to continue.",
      code: "free_limit_reached",
      free_limit: FREE_DAILY_LIMIT,
      free_remaining: 0
    }),
    {
      status: 402,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(origin),
        "X-Request-Id": requestId,
        "X-Snapshot-Key": snapshotKey.slice(0, 12),
        "X-User-Validated": "false",
        "X-Free-Remaining": "0"
      }
    }
  );
}

async function hashString(input) {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeKeyString(value) {
  if (typeof value !== "string") return value ?? null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed || null;
}

function normalizeKeyArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => normalizeKeyString(v)).filter(Boolean).sort();
}

function normalizeListingId(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/marketplace\/item\/(\d+)/);
    return m ? m[1] : u.pathname || "";
  } catch {
    return String(url);
  }
}

function canonicalSnapshot(snapshot) {
  const listingId = normalizeListingId(snapshot?.url);
  return {
    listing_id: listingId || null,
    vin: normalizeKeyString(snapshot?.vin),
    year: snapshot?.year ?? null,
    make: normalizeKeyString(snapshot?.make),
    model: normalizeKeyString(snapshot?.model),
    trim: normalizeKeyString(snapshot?.trim),
    drivetrain: normalizeKeyString(snapshot?.drivetrain),
    transmission: normalizeKeyString(snapshot?.transmission),
    engine: normalizeKeyString(snapshot?.engine),
    price_usd: snapshot?.price_usd ?? null,
    mileage_miles: snapshot?.mileage_miles ?? null,
    seller_description: normalizeKeyString(snapshot?.seller_description),
    about_items: normalizeKeyArray(snapshot?.about_items)
  };
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

function stripLeadingDecorators(text) {
  const s = asString(text, "");
  return s
    .replace(/^[\s\-*•]+/, "")
    .replace(
      /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]+\s*/u,
      ""
    )
    .trim();
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

function letterGradeFromScore(score) {
  if (!Number.isFinite(score)) return "N/A";
  if (score >= 92) return "A+";
  if (score >= 88) return "A";
  if (score >= 84) return "A-";
  if (score >= 79) return "B+";
  if (score >= 75) return "B";
  if (score >= 72) return "B-";
  if (score >= 65) return "C+";
  if (score >= 60) return "C";
  if (score >= 55) return "C-";
  if (score >= 45) return "D+";
  if (score >= 40) return "D";
  if (score >= 35) return "D-";
  return "F";
}

function riskLevelFromScore(score) {
  if (!Number.isFinite(score)) return "Unknown";
  if (score <= 25) return "Very high";
  if (score <= 45) return "High";
  if (score <= 65) return "Moderate";
  if (score <= 80) return "Low to moderate";
  return "Low";
}

function normalizeText(value) {
  return (value || "").toString().toLowerCase();
}

function semanticTopicKey(text) {
  const t = normalizeText(text).replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (/\bvin\b|\bhistory check\b/.test(t)) return "vin_history";
  if (/\btitle\b|\blien\b|\bsalvage\b|\brebuilt\b/.test(t)) return "title_status";
  if (/\bdrivetrain\b|\b2wd\b|\b4wd\b|\b4x4\b|\bawd\b|\bfwd\b|\brwd\b|\b4hi\b|\b4lo\b/.test(t)) return "drivetrain";
  if (/\btransmission\b|\bcvt\b|\btrans fluid\b/.test(t)) return "transmission";
  if (/\bengine\b|\boil leak\b|\bwarm idle\b/.test(t)) return "engine_health";
  if (/\becoboost\b|\bcam phaser\b|\btiming chain\b|\bturbo\b|\bboost leak\b|\bintercooler\b/.test(t)) {
    return "forced_induction";
  }
  if (/\blevel\b|\blift\b|\b33\b|\b35\b|\bcv axle\b|\bball joint\b|\bwheel bearing\b|\balignment\b/.test(t)) {
    return "suspension_mods";
  }
  if (/\bcanopy\b|\btopper\b|\bbed rail\b|\bwater leak\b/.test(t)) return "canopy_fitment";
  if (/\bled\b|\blight bar\b|\bwiring\b|\bfuse\b|\brelay\b/.test(t)) return "electrical_mods";
  if (/\brecords?\b|\bservice history\b|\breceipts?\b|\bmaintenance history\b/.test(t)) return "service_records";
  if (/\bmileage\b|\bhigh mileage\b/.test(t)) return "high_mileage";
  return t
    .replace(/\(\$[^)]*\)/g, "")
    .replace(/\(\s*[^)]*why[^)]*\)/g, "")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeBySemanticTopic(items, max = 7) {
  const seen = new Set();
  const out = [];
  for (const raw of asArray(items)) {
    const item = asString(raw, "");
    if (!item) continue;
    const key = semanticTopicKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

function sourceBlob(snapshot) {
  return normalizeText([snapshot?.source_text, snapshot?.seller_description, ...(snapshot?.about_items || [])].join(" "));
}

function inferredDrivetrain(snapshot) {
  if (snapshot?.drivetrain) return snapshot.drivetrain;
  const t = sourceBlob(snapshot);
  const make = normalizeText(snapshot?.make);
  const model = normalizeText(snapshot?.model);
  if (/\bfx4\b/.test(t)) return "4WD";
  if (/\b4x4\b|\b4wd\b/.test(t)) return "4WD";
  if (/\bawd\b/.test(t)) return "AWD";
  if (/\bfwd\b/.test(t)) return "FWD";
  if (/\brwd\b/.test(t)) return "RWD";
  if (/\b2wd\b/.test(t)) return "2WD";
  if (make === "lexus" && /\bgx\b/.test(model)) return "4WD (inferred)";
  // Makes/models that are inherently AWD/4WD — suppresses false "drivetrain unknown" flags
  if (make === "land rover") return "AWD (inferred)";
  if (make === "subaru" && !/\bbrz\b/.test(model)) return "AWD (inferred)";
  if (make === "lamborghini") return "AWD (inferred)";
  if (make === "ferrari" && /\bawd\b|\bff\b|\bgtc4\b/.test(model)) return "AWD (inferred)";
  return null;
}

function inferredTransmission(snapshot) {
  if (snapshot?.transmission) return snapshot.transmission;
  const t = sourceBlob(snapshot);
  if (/\bautomatic\b/.test(t)) return "Automatic";
  if (/\bmanual\b/.test(t)) return "Manual";
  if (/\bcvt\b/.test(t)) return "CVT";
  return null;
}

function inferredEngine(snapshot) {
  if (snapshot?.engine) return snapshot.engine;
  const t = sourceBlob(snapshot);
  if (/3\.5\s*(l|liter)?\s*eco\s*boost|3\.5\s*eb|3\.5l?\s*ecoboost/.test(t)) return "3.5L EcoBoost";
  if (/2\.7\s*(l|liter)?\s*eco\s*boost|2\.7l?\s*ecoboost/.test(t)) return "2.7L EcoBoost";
  if (/5\.0\s*(l|liter)?\s*(v8|coyote)?/.test(t)) return "5.0L V8";
  if (/3\.5\s*(l|liter)?\s*v6/.test(t)) return "3.5L V6";
  return null;
}

function sourceConfidence(source, hasValue) {
  if (!hasValue) return 0;
  if (source === "about_vehicle") return 0.95;
  if (source === "title") return 0.88;
  if (source === "seller_description") return 0.8;
  if (source === "derived") return 0.68;
  return 0.75;
}

function excerptAround(text, pattern, radius = 55) {
  if (!text || !pattern) return null;
  const m = String(text).match(pattern);
  if (!m || m.index == null) return null;
  const start = Math.max(0, m.index - radius);
  const end = Math.min(String(text).length, m.index + m[0].length + radius);
  return String(text)
    .slice(start, end)
    .replace(/\s+/g, " ")
    .trim();
}

function detectOwnerCountClaim(snapshot) {
  const text = sourceBlob(snapshot);
  const m = text.match(/\b(\d{1,2})\s*owner(s)?\b/i);
  return m ? Number(m[1]) : null;
}

function detectAccidentClaim(snapshot) {
  const text = sourceBlob(snapshot);
  if (/\bno accidents?\b/i.test(text)) return "no_accidents_claimed";
  if (/\baccident(s)?\b/i.test(text)) return "accident_mentioned";
  return null;
}

function detectRecordsClaim(snapshot) {
  return hasServiceRecordsClaim(snapshot) ? "records_claimed" : null;
}

function detectModificationSignals(snapshot) {
  const text = sourceBlob(snapshot);
  const patterns = [
    { key: "lift_or_level", re: /(level(\s|-)?kit|lift|rough country|coilover)/i },
    { key: "oversized_tires", re: /\b33("|”|in(ch)?)?\b|\b35("|”|in(ch)?)?\b/i },
    { key: "aftermarket_wheels", re: /(aftermarket wheels|krank wheels|fuel wheels)/i },
    { key: "canopy_or_topper", re: /(are\s+canopy|canopy|camper shell|topper)/i },
    { key: "intake_or_spacer", re: /(cold air intake|throttle body spacer)/i },
    { key: "drivetrain_mod", re: /(extended cv|yukon rear end|re-?gear)/i }
  ];
  return patterns.filter((p) => p.re.test(text)).map((p) => p.key);
}

function buildNormalizedFacts(snapshot) {
  const textBlob = [snapshot?.source_text, snapshot?.seller_description, ...(snapshot?.about_items || [])]
    .filter(Boolean)
    .join("\n");

  const drive = inferredDrivetrain(snapshot);
  const trans = inferredTransmission(snapshot);
  const engine = inferredEngine(snapshot);
  const ownerCount = detectOwnerCountClaim(snapshot);
  const accidentClaim = detectAccidentClaim(snapshot);
  const recordsClaim = detectRecordsClaim(snapshot);
  const modSignals = detectModificationSignals(snapshot);

  const fact = (value, source, evidencePattern = null, explicitEvidence = null) => {
    const hasValue = hasKnownValue(value);
    return {
      value: hasValue ? value : null,
      source: hasValue ? source || "derived" : null,
      confidence: sourceConfidence(source || "derived", hasValue),
      evidence: hasValue ? explicitEvidence || excerptAround(textBlob, evidencePattern) || null : null
    };
  };

  const drivelineSource =
    snapshot?.provenance?.drivetrain_source || (drive && !snapshot?.drivetrain ? "derived" : null);
  const transSource =
    snapshot?.provenance?.transmission_source || (trans && !snapshot?.transmission ? "derived" : null);
  const titleSource = snapshot?.provenance?.title_status_source || null;

  return {
    year: fact(snapshot?.year, "title", /\b(19|20)\d{2}\b/i),
    make: fact(snapshot?.make, "title", /\b[a-z0-9-]+\b/i),
    model: fact(snapshot?.model, "title"),
    trim: fact(snapshot?.trim, "title"),
    price_usd: fact(snapshot?.price_usd, "title", /\$\s?\d[\d,]*/i, snapshot?.price_usd ? formatUsdWhole(snapshot.price_usd) : null),
    mileage_miles: fact(
      snapshot?.mileage_miles,
      "title",
      /\b\d{1,3}(,\d{3})+\s*(miles|mi)\b/i,
      snapshot?.mileage_miles ? `${Number(snapshot.mileage_miles).toLocaleString("en-US")} miles` : null
    ),
    transmission: fact(trans, transSource, /\b(automatic|manual|cvt)\b/i),
    drivetrain: fact(drive, drivelineSource, /\b(awd|4wd|4x4|fwd|rwd|2wd|fx4)\b/i),
    engine: fact(engine, snapshot?.provenance?.engine_source || (engine && !snapshot?.engine ? "derived" : null), /\b(\d\.\d\s*(l|liter).{0,20}(ecoboost|v6|v8)|ecoboost)\b/i),
    fuel_type: fact(snapshot?.fuel_type, "about_vehicle", /\bfuel type:\s*[a-z]+/i),
    title_status: fact(snapshot?.title_status, titleSource, /\b(clean title|salvage|rebuilt|lien|title)\b/i),
    vin: fact(snapshot?.vin, "seller_description", /\bvin\b[:#]?\s*[a-hj-npr-z0-9]{11,17}\b/i),
    owner_count_claimed: fact(ownerCount, "seller_description", /\b\d+\s*owner(s)?\b/i),
    accident_claimed: fact(accidentClaim, "seller_description", /\b(no accidents?|accident)\b/i),
    records_claimed: fact(recordsClaim, recordsClaim ? "seller_description" : null, /(service records|maintenance records|ford pass)/i),
    modifications_detected: fact(modSignals, modSignals.length ? "derived" : null)
  };
}

function computeEvidenceCoverage(snapshot) {
  const drive = inferredDrivetrain(snapshot);
  const trans = inferredTransmission(snapshot);
  const engine = inferredEngine(snapshot);
  const records = detectRecordsClaim(snapshot);
  const hasAbout = Array.isArray(snapshot?.about_items) && snapshot.about_items.length > 0;

  const weights = [
    { ok: hasKnownValue(snapshot?.year) && hasKnownValue(snapshot?.make) && hasKnownValue(snapshot?.model), w: 0.16 },
    { ok: hasKnownValue(snapshot?.price_usd), w: 0.1 },
    { ok: hasKnownValue(snapshot?.mileage_miles), w: 0.1 },
    { ok: hasKnownValue(trans), w: 0.08 },
    { ok: hasKnownValue(drive), w: 0.08 },
    { ok: hasKnownValue(engine), w: 0.07 },
    { ok: hasKnownValue(snapshot?.title_status), w: 0.1 },
    { ok: hasKnownValue(snapshot?.vin), w: 0.1 },
    { ok: hasKnownValue(snapshot?.seller_description), w: 0.08 },
    { ok: hasAbout, w: 0.05 },
    { ok: hasKnownValue(snapshot?.fuel_type), w: 0.04 },
    { ok: hasKnownValue(snapshot?.nhtsa_rating) || hasKnownValue(snapshot?.mpg_city), w: 0.02 },
    { ok: Boolean(records), w: 0.02 }
  ];

  let score = 0;
  weights.forEach((x) => {
    if (x.ok) score += x.w;
  });
  return clamp(score, 0.2, 0.98);
}

function computeHeuristicDecisionScore(snapshot, out) {
  let score = 68;
  const miles = asNumber(snapshot?.mileage_miles, null);
  const title = deriveTitleStatus(snapshot);
  const hasVin = hasKnownValue(snapshot?.vin);
  const hasRecords = Boolean(detectRecordsClaim(snapshot));
  const drive = inferredDrivetrain(snapshot);
  const modified = hasHeavyModificationSignals(snapshot);

  if (Number.isFinite(miles)) {
    if (miles >= 250000) score -= 20;
    else if (miles >= 200000) score -= 15;
    else if (miles >= 160000) score -= 8;
    else if (miles >= 120000) score -= 6;
    else if (miles <= 60000) score += 6;
  } else {
    score -= 4;
  }

  if (title === "unknown") score -= 6;
  if (title === "no_title") score -= 35;
  if (title === "lien") score -= 8;
  if (title === "rebuilt") score -= 18;
  if (title === "clean") score += 2;
  if (!hasVin) score -= 2;
  if (!drive) score -= 2;
  if (hasRecords) score += 4;
  if (modified) score -= 3;

  return clamp(Math.round(score), 0, 100);
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

async function syncSubscriptionFromStripeByEmail(user, env) {
  const userId = user?.id || null;
  const email = normalizeText(user?.email);
  if (!userId || !email || !env.STRIPE_SECRET_KEY) return null;

  const customersRes = await stripeGetRequest(env, `customers?email=${encodeURIComponent(email)}&limit=5`);
  if (!customersRes?.ok) return null;
  const customers = Array.isArray(customersRes?.data?.data) ? customersRes.data.data : [];
  if (!customers.length) return null;

  for (const customer of customers) {
    const customerId = customer?.id || null;
    if (!customerId) continue;
    const subsRes = await stripeGetRequest(
      env,
      `subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=5`
    );
    if (!subsRes?.ok) continue;
    const subs = Array.isArray(subsRes?.data?.data) ? subsRes.data.data : [];
    const active = subs.find((s) => {
      const st = normalizeText(s?.status);
      return st === "active" || st === "trialing";
    });
    if (!active) continue;

    const status = normalizeText(active?.status) || "active";
    await supabaseAdminRequest("/rest/v1/subscriptions", env, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        user_id: userId,
        status,
        plan: "monthly",
        stripe_customer_id: customerId,
        updated_at: new Date().toISOString()
      })
    });
    return {
      user_id: userId,
      status,
      plan: "monthly",
      stripe_customer_id: customerId,
      updated_at: new Date().toISOString()
    };
  }

  return null;
}

async function resolveSubscriptionRecord(user, env) {
  if (!user?.id) return null;
  const existing = await getSubscriptionRecord(user.id, env);
  if (isSubscriptionActive(existing)) return existing;
  const synced = await syncSubscriptionFromStripeByEmail(user, env);
  if (synced) return synced;
  return existing;
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

async function stripeGetRequest(env, path) {
  if (!env.STRIPE_SECRET_KEY) {
    return { ok: false, status: 500, error: "Missing STRIPE_SECRET_KEY" };
  }
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    }
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
  const explicit = normalizeText(snapshot?.title_status);
  const text = sourceBlob(snapshot);
  if (explicit) {
    if (explicit.includes("no_title")) return "no_title";
    if (explicit.includes("clean")) return "clean";
    if (explicit.includes("salvage")) {
      // Guard against false parse: "clean title (no salvage, rebuilt...)" can fool
      // the content script into returning "salvage". If the listing text clearly says
      // "clean title" and "no salvage" without "salvage title", trust the text.
      const sellerText = normalizeText(snapshot?.seller_description || "");
      const hasClearCleanClaim = /\bclean\s+title\b/i.test(sellerText);
      const hasNoSalvage = /\bno\s+salvage\b/i.test(sellerText);
      const hasSalvageTitle = /\bsalvage\s+title\b/i.test(sellerText);
      if (hasClearCleanClaim && hasNoSalvage && !hasSalvageTitle) return "clean";
      return "salvage";
    }
    if (explicit.includes("rebuilt") || explicit.includes("rebuild")) return "rebuilt";
    if (explicit.includes("lien")) return "lien";
    if (explicit.includes("unknown")) return "unknown";
    return explicit;
  }
  if (/\b(no title|without title|missing title|lost title|cant get title|can'?t get title)\b/i.test(text)) {
    return "no_title";
  }
  return "unknown";
}

function hasServiceRecordsClaim(snapshot) {
  const text = normalizeText([snapshot?.seller_description, snapshot?.source_text].join(" "));
  return /(full service records|service records|dealer maintained|maintenance records|work done includes|work includes|done at \d+k?|done by [a-z]|receipts? available|has receipts?|have receipts?|documented service|service history|maintenance history|shop records?)/i.test(text);
}

function scrubCleanTitle(text) {
  if (!text) return text;
  return text.replace(/clean title/gi, "title status not stated");
}

function hasKnownValue(value) {
  if (value == null) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function splitSentences(text) {
  if (!text || typeof text !== "string") return [];
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function removeFalseMissingClaims(text, checks) {
  const sentences = splitSentences(text);
  if (!sentences.length) return text || "";
  const kept = sentences.filter((s) => !checks.some((check) => check.when && check.pattern.test(s)));
  return kept.join(" ").trim();
}

function enforceFactConsistency(out, snapshot) {
  const hasPrice = hasKnownValue(snapshot?.price_usd);
  const hasMileage = hasKnownValue(snapshot?.mileage_miles);
  const hasDrivetrain = hasKnownValue(snapshot?.drivetrain);
  const hasTransmission = hasKnownValue(snapshot?.transmission);
  const hasEngine = hasKnownValue(inferredEngine(snapshot));
  const hasSellerDescription = hasKnownValue(snapshot?.seller_description);
  const hasRecords = Boolean(detectRecordsClaim(snapshot));

  const checks = [
    {
      when: hasPrice,
      pattern: /(price|asking price).*(missing|not provided|not listed|unknown|not mentioned)|missing listing info:.*price/i
    },
    {
      when: hasMileage,
      pattern:
        /(mileage|miles).*(missing|not provided|not listed|unknown|not mentioned)|missing listing info:.*mileage/i
    },
    {
      when: hasDrivetrain,
      pattern:
        /(drivetrain|2wd|4wd|awd|fwd).*(missing|not provided|unknown|not mentioned)|missing listing info:.*drivetrain/i
    },
    {
      when: hasTransmission,
      pattern:
        /(transmission|automatic|manual|cvt).*(missing|not provided|unknown|not mentioned)|missing listing info:.*transmission/i
    },
    {
      when: hasEngine,
      pattern: /(engine|motor|powertrain).*(missing|not provided|unknown|not mentioned)|missing listing info:.*engine/i
    },
    {
      when: hasSellerDescription,
      pattern: /(seller description|seller notes|description).*(missing|not provided|unknown)|missing listing info:.*seller_description/i
    },
    {
      when: hasRecords,
      pattern: /(lack of detailed service history|maintenance history unknown|no maintenance records)/i
    }
  ];

  out.summary = removeFalseMissingClaims(out.summary, checks);
  out.notes = removeFalseMissingClaims(out.notes, checks);

  out.risk_flags = (out.risk_flags || []).filter((flag) => {
    const s = String(flag || "");
    if (hasPrice && /(no|unknown|missing).*(price|asking)/i.test(s)) return false;
    if (hasMileage && /(no|unknown|missing).*(mileage|miles)/i.test(s)) return false;
    if (hasDrivetrain && /(unknown|missing).*(drivetrain|2wd|4wd|awd|fwd)/i.test(s)) return false;
    if (hasTransmission && /(unknown|missing).*(transmission|automatic|manual|cvt)/i.test(s)) return false;
    if (hasEngine && /(unknown|missing).*(engine|motor|powertrain)/i.test(s)) return false;
    if (hasRecords && /(lack of .*service history|maintenance records unknown|no maintenance records)/i.test(s)) return false;
    return true;
  });

  out.buyer_questions = (out.buyer_questions || []).filter((q) => {
    const s = normalizeText(q);
    if (hasDrivetrain && /what is the drivetrain|is it 2wd or 4wd\?/i.test(s)) return false;
    if (hasTransmission && /which transmission|what transmission/i.test(s)) return false;
    if (hasEngine && /which .*engine|what .*engine/i.test(s)) return false;
    return true;
  });
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
  return /(recent maintenance|within the last|last \d+\s*(months?|weeks?)|fresh oil change|oil changes?|all fluids? (just )?changed|fluids? changed|new brake pads|full tune-?up|brand new tires|new tires|new (thermostat|water pump|radiator|starter|alternator|battery)|alternator replaced|new alternator|maf sensor|mass air(flow)? sensor|valve cover gasket|head gasket|transmission flush|trans flush|trans fluid flush|coolant flush|power steering flush|brake fluid flush|differential fluid|transfer case fluid)/i.test(
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
  const drive = inferredDrivetrain(snapshot);
  const trans = inferredTransmission(snapshot);
  const engine = inferredEngine(snapshot);
  const allText = sourceBlob(snapshot);
  const isEV = /electric|hybrid/i.test(snapshot?.fuel_type || "") ||
    /\b(tesla|leaf|bolt|id\.?4|ioniq|rivian|lucid|polestar|model [s3xy])\b/i.test(allText);
  const ecoBoost = /ecoboost/i.test(engine || allText);
  const liftOrLevel = /(level(\s|-)?kit|lift|rough country|coilover|extended cv)/i.test(allText);
  const oversizedTires = /\b33("|”|in(ch)?)?\b|\b35("|”|in(ch)?)?\b/.test(allText);
  const fx4 = /\bfx4\b/i.test(allText);
  const genericRe = /(any issues|any accidents|accident history|issues\?)/i;
  const componentRe =
    /(engine|transmission|trans\b|turbo|timing|diff|differential|transfer case|ptu|steering|rack|suspension|strut|ball joint|alternator|battery|a\/c|ac\b|coolant|radiator|oil|brake|drivetrain|4wd|awd)/i;

  const ensureWhy = (q) => (/\([^)]+\)\s*$/.test(q) ? q : `${q} (why it matters)`);
  const isComponentSpecific = (q) => componentRe.test(q);
  const seen = new Set();
  const addUnique = (list, q) => {
    const key = semanticTopicKey(q);
    if (!key || seen.has(key)) return;
    seen.add(key);
    list.push(ensureWhy(q));
  };

  const iceOnlyRe = /oil\s+leak|warm\s+idle|timing\s+belt|timing\s+chain|cam\s+phaser|head\s+gasket|coolant\s+flush|transmission\s+fluid|trans\s+fluid|oil\s+change/i;
  const base = asArray(out.buyer_questions)
    .map((q) => asString(q, ""))
    .filter((q) => q && q.includes("?") && !genericRe.test(q))
    .filter((q) => !isEV || !iceOnlyRe.test(q));

  const list = [];
  base.forEach((q) => addUnique(list, q));
  const hasDrivetrainTopic = () => list.some((q) => /(drivetrain|2wd|4wd|awd|fwd|4hi|4lo)/i.test(q));

  const candidates = [];
  const make = normalizeText(snapshot?.make);
  if (!drive && !hasDrivetrainTopic()) {
    if (isTruckOrTruckBased(snapshot)) {
      candidates.push("Is it 2WD or 4WD, and does 4HI/4LO engage smoothly? (transfer case/actuator cost)");
    } else {
      const example = make.includes("mercedes") ? " (e.g., 4MATIC)" : "";
      candidates.push(`Is it FWD or AWD${example}? (changes maintenance/traction)`);
    }
  }
  if (!isEV && (!trans || !engine)) {
    candidates.push("Which transmission/engine is it exactly? (changes risk profile)");
  }
  if (ecoBoost) {
    candidates.push("Any timing chain or cam phaser rattle on cold start? (EcoBoost wear signal)");
    candidates.push("Any turbo replacement, boost leak, or intercooler moisture history? (forced-induction risk)");
  }
  if (liftOrLevel || oversizedTires) {
    candidates.push("Was the level/lift kit professionally installed with alignment records? (front-end wear risk)");
    candidates.push("Any CV axle, ball joint, or wheel-bearing work since tire/lift install? (suspension load)");
  }
  if (fx4) {
    candidates.push("Does 4HI/4LO engage smoothly, and when were transfer case/diff fluids serviced? (FX4 upkeep)");
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
  if (!isEV && Number.isFinite(mileage) && mileage > 120000) {
    candidates.push("If automatic, when was the transmission fluid serviced? (120k+ wear item)");
  }
  if (titleStatus === "unknown") {
    candidates.push("Can you provide VIN + title status details? (history/resale impact)");
  }
  if (isEV) {
    candidates.push("What does the battery health report show? (range and degradation — request Tesla app screenshot)");
    candidates.push("Has the vehicle been in any charging incidents or deep discharges? (battery longevity)");
  } else {
    candidates.push("Any oil leaks after a warm idle? (hidden engine wear)");
    candidates.push("Any drivetrain noises on turns/accel? (axle/diff wear)");
  }

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

  out.buyer_questions = dedupeBySemanticTopic(
    list
    .slice(0, 7)
    .map((q) => scrubUnsupportedDrivetrainQuestion(q, snapshot))
    .map((q) => scrubTimingBeltQuestion(q, snapshot)),
    7
  );
}

function sharpenRiskFlags(out, snapshot, titleStatus) {
  const drive = inferredDrivetrain(snapshot);
  const trans = inferredTransmission(snapshot);
  const engine = inferredEngine(snapshot);
  const text = sourceBlob(snapshot);
  const ecoBoost = /ecoboost/i.test(engine || text);
  const liftOrLevel = /(level(\s|-)?kit|lift|rough country|coilover|extended cv)/i.test(text);
  const oversizedTires = /\b33(“|”|in(ch)?)?\b|\b35(“|”|in(ch)?)?\b/.test(text);
  const canopy = /\b(are\s+canopy|canopy|camper shell|topper)\b/i.test(text);
  const lightingMods = /(led (light )?bar|fog\/flood lights?|hood (and )?roof mounts?|aux(iliary)? lighting)/i.test(text);
  const miles = asNumber(snapshot?.mileage_miles, null);
  const make = normalizeText(snapshot?.make);
  const model = normalizeText(snapshot?.model);
  const year = asNumber(snapshot?.year, null);
  const flags = asArray(out.risk_flags).map((f) => asString(f, "")).filter(Boolean);
  const updated = [];
  const vagueHighMileage = /high mileage/i;

  // Normalize separators and strip ($unknown) cost placeholders from AI-generated flags
  const normalizeFlag = (f) => f
    .replace(/\s*\(\$unknown\)/gi, "")
    .replace(/ ?\-> ?/g, " — ")
    .replace(/\s+\+\s*/g, " — ")   // handles both " + " and trailing " +"
    .replace(/\s*—\s*$/, "")
    .trim();

  for (const flag of flags) {
    if (vagueHighMileage.test(flag) && !/—|->|\$|cost|risk/i.test(flag)) {
      updated.push("High mileage — drivetrain and engine wear risk increases significantly");
      continue;
    }
    updated.push(normalizeFlag(flag));
  }

  const derived = [];
  if (titleStatus === "unknown") {
    derived.push("Title status not stated — verify before purchase; affects resale and insurance");
  }
  const hasDrivetrainUnknownFlag = updated.some((x) => /(unknown|not stated).*(drivetrain|2wd|4wd|awd|fwd)/i.test(x));
  if (!drive && !hasDrivetrainUnknownFlag) {
    derived.push("Drivetrain not stated — confirm 2WD vs 4WD/AWD before purchase");
  }
  if (!trans) {
    derived.push("Transmission not stated — ask seller and factor into maintenance planning");
  }
  const sellerDescLen = asString(snapshot?.seller_description, "").trim().length;
  if (!sellerDescLen) {
    derived.push("No seller description — limited history visibility; inspection is essential");
  } else if (sellerDescLen < 80) {
    derived.push("Sparse seller description — very little history detail for this vehicle; pre-purchase inspection by a specialist is essential");
  }
  if (ecoBoost && Number.isFinite(miles) && miles >= 120000) {
    derived.push("High-mile EcoBoost — turbo/cam-phaser/timing chain wear risk ($1,500–$4,000)");
  }
  if ((liftOrLevel || oversizedTires) && Number.isFinite(miles)) {
    derived.push("Lift/oversize tires — accelerated CV/ball-joint/wheel-bearing wear ($300–$1,200)");
  }
  if (canopy) {
    derived.push("Canopy/topper fitted — inspect bed rails and seal for water intrusion ($150–$800)");
  }
  if (lightingMods) {
    derived.push("Aftermarket lighting — inspect wiring/fuse/relay quality ($100–$800)");
  }
  // Very high mileage deserves a specific deterministic flag
  if (Number.isFinite(miles) && miles >= 250000) {
    derived.push(`Very high mileage (${Math.round(miles).toLocaleString("en-US")} miles) — inspect drivetrain, cooling, and suspension thoroughly`);
  }
  // 2005–2011 Tacoma known frame rust settlement issue
  const isTacomaFrameRisk = make === "toyota" && /tacoma/i.test(model) && Number.isFinite(year) && year >= 2005 && year <= 2011;
  if (isTacomaFrameRisk) {
    derived.push("2005–2011 Tacoma known frame rust issue — inspect frame underside for perforation before purchase");
  }

  // Derived flags are better-worded; put them first so they win deduplication
  const deduped = dedupeBySemanticTopic([...derived, ...updated], 6);
  out.risk_flags = deduped.slice(0, 6).filter((f) => {
    if (!f) return false;
    // Drop stale AI flags that say title is unknown/not stated when we actually know the title status
    if (titleStatus && /\btitle\s*(status\s*)?(not\s+stated|unknown|unverified)/i.test(f)) return false;
    // Drop stale AI flags about unknown mileage when mileage is actually known
    if (Number.isFinite(miles) && miles > 0 && /\bmileage[:\s]*(unknown|not\s+provided|not\s+stated)/i.test(f)) return false;
    return true;
  });
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
        estimated_cost: "$0–$50 DIY / $40–$120 shop (rotate/inspect only)"
      };
    }

    return {
      ...x,
      estimated_cost: "$500–$1,000 DIY / $700–$1,300 shop (set of 4)"
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
  const hasFluidsChanged = /(all fluids? (just )?changed|fluids? (just )?changed|fresh fluid service)/i.test(t);
  const hasTransFlush = /(transmission flush|trans flush|trans fluid flush|transmission fluid (changed|replaced|flushed)|new transmission fluid)/i.test(t);
  const hasCoolantFlush = /(coolant flush|coolant (changed|replaced|flushed)|new coolant)/i.test(t);
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
        estimated_cost: "$0–$50 DIY / $40–$120 shop (inspect/rotate only)"
      };
    }

    if (hasNewPads && /brake\s*pads?/.test(item)) {
      return {
        ...x,
        item: "Brake pads (new per seller — verify receipt/date)",
        typical_mileage_range: "Now",
        why_it_matters: "Confirms quality + proper bedding",
        estimated_cost: "$0–$50 DIY / $50–$150 shop (inspect only)"
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
  if (hasFluidsChanged) addChecklist("Verify recent fluid service receipts (transmission, transfer case, differentials)");
  if (hasTransFlush && !hasFluidsChanged) addChecklist("Ask for transmission flush receipt + check fluid color on dipstick (confirms quality of service)");
  if (hasCoolantFlush) addChecklist("Verify coolant flush receipt + check for milky residue on cap (confirms no head gasket issues)");
  if (hasTuneUp) addChecklist("Ask what ‘tune-up’ included (plugs/filters/fluids) and verify receipts");

  const ensureQuestion = (q) => {
    const key = normalizeText(q);
    if (!asArray(out.buyer_questions).some((x) => normalizeText(x) === key)) out.buyer_questions.push(q);
  };

  if (hasNewTires) ensureQuestion("Do you have the tire invoice and install date? (confirms warranty/spec)");
  if (hasNewPads) ensureQuestion("Were rotors resurfaced/replaced with the pads? (prevents vibration)");
  if (hasTuneUp) ensureQuestion("What did the ‘full tune-up’ include exactly? (avoids vague claims)");
  if (hasFluidsChanged) ensureQuestion("Do you have receipts for the recent fluid service? (confirms drivetrain maintenance)");
  if (hasTransFlush && !hasFluidsChanged) ensureQuestion("Do you have the transmission flush receipt? (confirms service quality and date)");

  out.buyer_questions = asArray(out.buyer_questions).slice(0, 7);

  if (hasFluidsChanged) {
    out.expected_maintenance_near_term = asArray(out.expected_maintenance_near_term).filter((x) => {
      const item = normalizeText(x?.item);
      return !/(transmission fluid|transfer case|differential fluid|driveline fluids)/i.test(item);
    });
  } else if (hasTransFlush) {
    out.expected_maintenance_near_term = asArray(out.expected_maintenance_near_term).filter((x) => {
      const item = normalizeText(x?.item);
      return !/(transmission fluid|transmission flush|trans flush)/i.test(item);
    });
  }
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
        estimated_cost: "$0–$50 DIY / $100–$200 shop"
      };
    });

  out.expected_maintenance_near_term = replaceIfSpeculative(out.expected_maintenance_near_term);
}

function ensureSpecificMaintenance(out, snapshot) {
  const text = sourceBlob(snapshot);
  const engine = inferredEngine(snapshot);
  const drive = inferredDrivetrain(snapshot);
  const miles = asNumber(snapshot?.mileage_miles, null);
  const ecoBoost = /ecoboost/i.test(engine || text);
  const fx4Or4wd = /\bfx4\b/i.test(text) || /\b4wd\b|\b4x4\b/i.test(normalizeText(drive || ""));
  const hasFluidsChanged = /(all fluids? (just )?changed|fluids? (just )?changed|fresh fluid service)/i.test(text);
  const liftOrOversize =
    /(level(\s|-)?kit|lift|rough country|coilover|extended cv)/i.test(text) ||
    /\b33("|”|in(ch)?)?\b|\b35("|”|in(ch)?)?\b/.test(text);

  const addItem = (item) => {
    const key = normalizeText(item.item);
    const existing = asArray(out.expected_maintenance_near_term).some(
      (x) => normalizeText(x?.item).includes(key) || key.includes(normalizeText(x?.item))
    );
    if (!existing) out.expected_maintenance_near_term.unshift(item);
  };

  if (ecoBoost && Number.isFinite(miles) && miles >= 100000) {
    addItem({
      item: "Turbo/intercooler hose + boost system inspection",
      typical_mileage_range: "Now",
      why_it_matters: "High-mile forced induction can hide expensive leaks/wear",
      estimated_cost: "$50–$200 DIY / $200–$600 shop"
    });
    addItem({
      item: "Timing chain/cam phaser cold-start noise inspection",
      typical_mileage_range: "Now",
      why_it_matters: "Early wear can become major repair",
      estimated_cost: "$0–$100 DIY / $150–$350 shop (diagnostic)"
    });
  }

  if (fx4Or4wd && !hasFluidsChanged) {
    addItem({
      item: "Transfer case + front/rear differential fluid service",
      typical_mileage_range: "Now",
      why_it_matters: "4WD driveline fluids are key at higher mileage",
      estimated_cost: "$120–$250 DIY / $250–$500 shop"
    });
  }

  if (liftOrOversize) {
    addItem({
      item: "Front-end/CV/ball-joint inspection + alignment verification",
      typical_mileage_range: "Now",
      why_it_matters: "Lift and larger tires increase front suspension stress",
      estimated_cost: "$0–$120 DIY / $150–$450 shop"
    });
  }

  out.expected_maintenance_near_term = asArray(out.expected_maintenance_near_term).slice(0, 6);
}

function normalizeVerdictTone(out, snapshot) {
  const score = asNumber(out?.overall_score, null);
  if (!Number.isFinite(score)) return;

  const grade = letterGradeFromScore(score);
  const title = deriveTitleStatus(snapshot);
  const hasVin = hasKnownValue(snapshot?.vin);
  const hasDrive = hasKnownValue(inferredDrivetrain(snapshot));
  const miles = asNumber(snapshot?.mileage_miles, null);
  const reasons = [];
  if (Number.isFinite(miles) && miles >= 200000) reasons.push(`very high mileage (${Math.round(miles).toLocaleString("en-US")} mi)`);
  else if (Number.isFinite(miles) && miles >= 150000) reasons.push(`high mileage (${Math.round(miles).toLocaleString("en-US")} mi)`);
  if (title === "no_title") reasons.push("no title is disclosed");
  else if (title === "rebuilt") reasons.push("rebuilt title risk");
  else if (title === "lien") reasons.push("lien/title transfer risk");

  const priceOpinion = asString(out?.price_opinion, "");
  const above = priceOpinion.match(/above fair range by about (\$[\d,]+)/i);
  const below = priceOpinion.match(/below fair range by about (\$[\d,]+)/i);
  const overAsk = priceOpinion.match(/over ask by about (\$[\d,]+)/i);
  if (above) reasons.push(`asking is above fair value by about ${above[1]}`);
  else if (overAsk) reasons.push(`asking is above target by about ${overAsk[1]}`);
  else if (below) reasons.push(`asking is below fair value by about ${below[1]}`);

  const uncertainty = [];
  if (title === "unknown") uncertainty.push("title is unverified");
  if (!hasVin) uncertainty.push("VIN is missing");
  if (!hasDrive) uncertainty.push("drivetrain is unconfirmed");

  const primary = reasons.slice(0, 2);
  if (!primary.length) primary.push("overall listing risk and condition uncertainty");
  const reasonText = `Grade ${grade} reflects ${primary.join(" and ")}.`;

  const uncertaintyText = uncertainty.length ? ` Missing info: ${uncertainty.join("; ")}.` : "";

  let actionText = "Conditional buy — proceed only after inspection and records verification.";
  if (score <= 34) actionText = "High risk — likely pass unless steep discount and clean inspection.";
  else if (score >= 80) actionText = "Buy candidate — still verify VIN/history and inspection.";
  else if (score >= 60) actionText = "Conditional buy — reasonable candidate if inspection and history check out.";

  out.final_verdict = `${reasonText}${uncertaintyText} ${actionText}`;
}

function buildDeterministicSummary(out, snapshot) {
  const year = snapshot?.year;
  const make = asString(snapshot?.make, "").toUpperCase();
  const model = asString(snapshot?.model, "").toUpperCase();
  const rawAsk = asNumber(snapshot?.price_usd, null);
  const ask = rawAsk != null && rawAsk > 0 ? rawAsk : null;
  const rawMiles = asNumber(snapshot?.mileage_miles, null);
  const miles = rawMiles != null && rawMiles > 0 ? rawMiles : null;
  const title = deriveTitleStatus(snapshot);
  const band = ask && miles ? computeValuationBand(snapshot, out) : null;

  const subject = [year, make, model].filter(Boolean).join(" ").trim() || "This vehicle";
  const priceText = ask ? formatUsdWhole(ask) : "price not listed";
  const milesText = miles ? `${Math.round(miles).toLocaleString("en-US")} miles` : "mileage not listed";
  const facts = `${subject} is listed at ${priceText} with ${milesText}${
    title === "clean" ? " and seller-claimed clean title" : ""
  }.`;

  let priceLine = "";
  if (!ask || !miles) {
    priceLine = "Price and mileage not fully extracted — check listing details before making an offer.";
  } else if (band) {
    const PRICE_NEAR_TOL = 0.08;
    const overBand = ask > band.fair_high ? ask - band.fair_high : 0;
    const underBand = ask < band.fair_low ? band.fair_low - ask : 0;
    if (overBand / band.fair_mid > PRICE_NEAR_TOL) {
      priceLine = `Asking price is above estimated fair value by about ${formatUsdWhole(overBand)}.`;
    } else if (underBand / band.fair_mid > PRICE_NEAR_TOL) {
      priceLine = `Asking price is below estimated fair value by about ${formatUsdWhole(underBand)}.`;
    } else {
      priceLine = `Asking price is near estimated fair range (${formatUsdWhole(band.fair_low)}–${formatUsdWhole(
        band.fair_high
      )}).`;
    }
  } else {
    priceLine = "Pricing appears in line with the estimated range.";
  }

  const expectations = [];
  if (miles != null && miles >= 150000) expectations.push("expect higher wear-item and drivetrain maintenance costs");
  else if (miles != null && miles <= 60000) expectations.push("mileage is low for age");
  if (!hasKnownValue(snapshot?.vin)) expectations.push("request VIN for a history check before committing");
  if (!hasKnownValue(inferredDrivetrain(snapshot))) expectations.push("confirm drivetrain (2WD vs 4WD)");
  if (!snapshot?.seller_description) expectations.push("sparse listing — inspection and history check carry more weight");

  const expectationLine = expectations.length
    ? `Buyer note: ${expectations.slice(0, 2).join("; ")}.`
    : "Confirm maintenance records and inspection results before purchase.";

  out.summary = [facts, priceLine, expectationLine].filter(Boolean).join(" ");
}

function formatUsdWhole(n) {
  if (!Number.isFinite(n)) return "$unknown";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function hasHeavyModificationSignals(snapshot) {
  const text = sourceBlob(snapshot);
  return /(lift|leveling kit|rough country|coilover|spacer|cold air intake|throttle body spacer|aftermarket wheels|krank wheels|extended cv|yukon rear end|re-gear|regear|tuned|tune|straight pipe|cat-?back|headers)/i.test(
    text
  );
}

function marketRetentionAdjustment(snapshot) {
  const make = normalizeText(snapshot?.make);
  const model = normalizeText(snapshot?.model);

  // Negative values reduce discount (stronger resale retention).
  if (make === "toyota" || make === "lexus") {
    if (/(rav4|4runner|tacoma|tundra|sequoia|gx|rx|highlander)/.test(model)) return -0.03;
    return -0.02;
  }
  if (make === "honda" || make === "acura") {
    if (/(cr-v|crv|pilot|ridgeline|mdx|rdx)/.test(model)) return -0.02;
    return -0.01;
  }
  if (make === "mazda" || make === "subaru") return -0.01;
  if (make === "jeep" && /(liberty|compass|patriot)/.test(model)) return 0.01;
  return 0;
}

function computeValuationBand(snapshot, out) {
  const ask = asNumber(snapshot?.price_usd, null);
  if (!Number.isFinite(ask) || ask <= 0) return null;

  const miles = asNumber(snapshot?.mileage_miles, null);
  const conf = clamp(asNumber(out?.confidence, 0.5), 0, 1);
  const titleStatus = deriveTitleStatus(snapshot);
  const hasVin = hasKnownValue(snapshot?.vin);
  const modified = hasHeavyModificationSignals(snapshot);
  const drive = inferredDrivetrain(snapshot);
  const trans = inferredTransmission(snapshot);
  const engine = inferredEngine(snapshot);
  const retentionAdj = marketRetentionAdjustment(snapshot);

  let discount = 0;

  if (Number.isFinite(miles)) {
    if (miles >= 250000) discount += 0.14;
    else if (miles >= 200000) discount += 0.1;
    else if (miles >= 160000) discount += 0.07;
    else if (miles >= 120000) discount += 0.04;
    else if (miles >= 90000) discount += 0.02;
  } else {
    discount += 0.02;
  }

  if (titleStatus === "unknown") discount += 0.05;
  else if (titleStatus === "lien") discount += 0.09;
  else if (titleStatus === "rebuilt") discount += 0.2;
  else if (titleStatus === "no_title") discount += 0.35;

  if (!drive) discount += 0.01;
  if (!trans) discount += 0.005;
  if (!engine) discount += 0.005;
  if (!snapshot?.seller_description) discount += 0.015;
  if (!hasVin) discount += 0.01;
  if (modified) discount += 0.02;

  discount += retentionAdj;

  const discountCap = titleStatus === "no_title" ? 0.6 : 0.28;
  discount = clamp(discount, -0.08, discountCap);

  const fairMid = Math.max(500, Math.round(ask * (1 - discount)));
  const spreadPct = clamp(0.07 + (1 - conf) * 0.06 + (modified ? 0.01 : 0), 0.06, 0.13);
  const spread = Math.max(500, Math.round(fairMid * spreadPct));
  const fairLow = Math.max(500, fairMid - spread);
  const fairHigh = Math.max(fairLow, fairMid + spread);

  return {
    ask,
    fair_low: fairLow,
    fair_mid: fairMid,
    fair_high: fairHigh
  };
}

function applyDeterministicValuationBand(out, snapshot) {
  const band = computeValuationBand(snapshot, out);
  if (!band) return;

  const structured = `fair_low=${formatUsdWhole(band.fair_low)}, fair_mid=${formatUsdWhole(
    band.fair_mid
  )}, fair_high=${formatUsdWhole(band.fair_high)}`;
  const ask = band.ask;

  // Only call out deviation if it's meaningfully outside the band (>8% of fair_mid).
  // Differences under that threshold are within market variability and should read as "near fair range".
  const PRICE_NEAR_TOL = 0.08;
  let priceCall = "near fair range";
  if (ask > band.fair_high && (ask - band.fair_high) / band.fair_mid > PRICE_NEAR_TOL)
    priceCall = `above fair range by about ${formatUsdWhole(ask - band.fair_high)}`;
  else if (ask < band.fair_low && (band.fair_low - ask) / band.fair_mid > PRICE_NEAR_TOL)
    priceCall = `below fair range by about ${formatUsdWhole(band.fair_low - ask)}`;

  out.market_value_estimate = `Fair value band: ${formatUsdWhole(band.fair_low)}–${formatUsdWhole(
    band.fair_high
  )} (mid ${formatUsdWhole(band.fair_mid)}).`;
  out.price_opinion = `Deterministic valuation target: ${structured}. Asking ${formatUsdWhole(
    ask
  )} is ${priceCall}.`;

  if (!Number.isFinite(out.overall_score)) return;

  // Deal-context scoring: grade should reflect how good/bad the listing price is.
  const overPct = band.fair_high > 0 ? (ask - band.fair_high) / band.fair_high : 0;
  const underPct = band.fair_low > 0 ? (band.fair_low - ask) / band.fair_low : 0;

  let delta = 0;
  if (underPct > 0) {
    if (underPct >= 0.4) delta += 30;
    else if (underPct >= 0.25) delta += 22;
    else if (underPct >= 0.15) delta += 15;
    else if (underPct >= 0.08) delta += 9;
    else if (underPct >= 0.03) delta += 4;
  } else if (overPct > 0) {
    if (overPct >= 0.3) delta -= 20;
    else if (overPct >= 0.2) delta -= 14;
    else if (overPct >= 0.12) delta -= 9;
    else if (overPct >= 0.05) delta -= 5;
    else if (overPct >= 0.02) delta -= 2;
  }

  out.deal_adjustment = delta;
  out.overall_score = clamp(Math.round(out.overall_score + delta), 0, 100);
}

/**
 * Inject deterministic upsides when seller description signals quality
 * that the model may miss (OE parts, named shops, itemized receipts, etc.)
 */
function ensureUpsides(out, snapshot) {
  const t = normalizeText([snapshot?.seller_description, snapshot?.source_text, ...(snapshot?.about_items || [])].join(" "));

  const addUpside = (text) => {
    const key = normalizeText(text);
    if (!asArray(out.upsides).some((u) => normalizeText(u) === key)) {
      out.upsides.push(text);
    }
  };

  // OE / OEM parts mentioned by brand
  if (/(oem|o\.e\.|o\.e\.m\.|denso|bosch|ac delco|acdelco|gates|aisin|genuine toyota|genuine honda|genuine ford|factory part)/i.test(t)) {
    addUpside("OEM/OE parts used — reduces risk of premature failure from aftermarket substitutes");
  }

  // Named repair shop (not just "shop" or "mechanic")
  if (/\b[A-Z][a-z]+ (automotive|auto|garage|motors?|service|repair)\b/.test(snapshot?.seller_description || "")) {
    addUpside("Work performed at named shop — paper trail and potential warranty on labor");
  }

  // Itemized maintenance history (multiple specific services listed)
  const serviceKeywords = [
    /maf\s+sensor|mass air(flow)?/i,
    /valve cover gasket/i,
    /alternator/i,
    /transmission flush|trans flush/i,
    /coolant flush/i,
    /timing (belt|chain)/i,
    /water pump/i,
    /spark plugs?/i,
    /struts?|shocks?/i,
    /serpentine belt/i,
  ];
  const matchedServices = serviceKeywords.filter((re) => re.test(t));
  if (matchedServices.length >= 2) {
    addUpside("Seller provides itemized maintenance history — above average transparency for private-party listing");
  }

  // Receipts mentioned
  if (/(receipts? available|have receipts?|has receipts?|can provide receipts?|will send receipts?)/i.test(t)) {
    addUpside("Seller claims receipts available — request copies before purchase");
  }
}

/**
 * Detect seller-disclosed needs (e.g. "needs new alternator") and inject
 * them as risk flags and near-term maintenance items so the AI can't miss them.
 */
function detectSellerDisclosedNeeds(out, snapshot) {
  const raw = asString(snapshot?.seller_description, "") + " " + asArray(snapshot?.about_items).join(" ");
  const t = normalizeText(raw);
  if (!t) return;

  const needs = [
    { re: /needs?\s+(a\s+)?(new\s+)?alternator/i,         flag: "Seller reports alternator needs replacement",                   item: "Alternator replacement (seller-disclosed)", cost: "$80–$200 DIY / $250–$500 shop" },
    { re: /needs?\s+(a\s+)?(new\s+)?transmission/i,        flag: "Seller reports transmission needs replacement",                 item: "Transmission replacement (seller-disclosed)", cost: "$500–$1,500 DIY / $1,500–$4,000 shop" },
    { re: /needs?\s+(a\s+)?(new\s+)?engine/i,              flag: "Seller reports engine needs replacement",                       item: "Engine replacement (seller-disclosed)", cost: "$1,000–$3,000 DIY / $3,000–$8,000 shop" },
    { re: /needs?\s+(a\s+)?(new\s+)?timing\s+(belt|chain)/i, flag: "Seller reports timing belt/chain needs service",              item: "Timing belt/chain (seller-disclosed)", cost: "$200–$400 DIY / $500–$1,200 shop" },
    { re: /needs?\s+(a\s+)?(new\s+)?water\s+pump/i,        flag: "Seller reports water pump needs replacement",                   item: "Water pump (seller-disclosed)", cost: "$80–$150 DIY / $200–$500 shop" },
    { re: /needs?\s+(a\s+)?(new\s+)?catalytic\s+conv/i,    flag: "Seller reports catalytic converter needs replacement",          item: "Catalytic converter (seller-disclosed)", cost: "$150–$600 DIY / $500–$2,000 shop" },
    { re: /needs?\s+(a\s+)?(new\s+)?head\s+gasket/i,       flag: "Seller reports head gasket needs replacement — major repair",   item: "Head gasket (seller-disclosed)", cost: "$300–$800 DIY / $1,000–$2,500 shop" },
    { re: /needs?\s+(a\s+)?(new\s+)?radiator/i,            flag: "Seller reports radiator needs replacement",                    item: "Radiator (seller-disclosed)", cost: "$100–$300 DIY / $300–$700 shop" },
    { re: /needs?\s+(some\s+)?(body\s+work|bodywork|paint)/i, flag: "Seller reports body work or paint needed",                   item: null, cost: null },
    { re: /needs?\s+(a\s+)?(new\s+)?(ac|a\/c|air conditioning)\s*(compressor|recharge|regas|recharge)?/i, flag: "Seller reports A/C needs service", item: "A/C service (seller-disclosed)", cost: "$50–$150 DIY / $150–$600 shop" },
    { re: /needs?\s+(work|repair|fixing|attention)/i,       flag: "Seller discloses car needs work — inspect carefully for specifics", item: null, cost: null },
  ];

  for (const { re, flag, item, cost } of needs) {
    if (!re.test(t)) continue;

    // Add as risk flag if not already present
    const flagKey = normalizeText(flag);
    if (!asArray(out.risk_flags).some((f) => normalizeText(f) === flagKey)) {
      out.risk_flags.unshift(flag);
    }

    // Add to near-term maintenance if specific enough
    if (item) {
      const itemKey = normalizeText(item);
      const alreadyInMaintenance = asArray(out.expected_maintenance_near_term).some(
        (x) => normalizeText(x?.item) === itemKey
      );
      if (!alreadyInMaintenance) {
        out.expected_maintenance_near_term.unshift({
          item,
          typical_mileage_range: "Now (seller-disclosed need)",
          why_it_matters: "Seller explicitly states this needs to be done — negotiate price accordingly",
          estimated_cost: cost || "—"
        });
      }
    }
  }

  // Flat-tow history detection
  // Sellers sometimes disclose the car was towed behind an RV/RC for many miles —
  // this creates specific transfer case and driveline wear that the AI can miss.
  const flatTowRe = /tow(?:ed|ing)?\s+behind\s+(?:r[cv]|an?\s+r[cv]|motorhome|motor\s*home|class\s*[abc])|flat[\s-]tow(?:ed|ing)?|\btoad\s+vehicle/i;
  if (flatTowRe.test(t)) {
    const milesM = t.match(/(\d+)\s*k\s*miles?/) || t.match(/(\d+),000\s*miles?.*(?:flat|tow)/i);
    const towDesc = milesM ? `~${milesM[1]}k miles` : "an unknown mileage";
    if (!asArray(out.risk_flags).some((f) => /flat.?tow/i.test(f))) {
      out.risk_flags.unshift(
        `Vehicle was flat-towed for ${towDesc} per seller — inspect transfer case engagement, front driveshaft, and transmission for abnormal wear ($unknown)`
      );
    }
    if (!asArray(out.buyer_questions).some((q) => /flat.?tow|transfer case/i.test(q))) {
      out.buyer_questions.push(
        "Was the transfer case in neutral while flat-towed? (incorrect setting causes major driveline damage)"
      );
    }
    if (!asArray(out.inspection_checklist).some((c) => /flat.?tow|transfer case.*engag/i.test(c))) {
      out.inspection_checklist.push(
        "Engage all 4WD modes and transfer case positions — listen for grinding or difficulty engaging (flat-tow wear check)"
      );
    }
  }

  // Trim risk flags to cap
  out.risk_flags = out.risk_flags.slice(0, 8);
}

/**
 * Filter generic AI boilerplate from deal breakers.
 * These belong in the inspection checklist, not deal breakers.
 */
function injectKnownVehicleDealBreakers(out, snapshot) {
  const make = normalizeText(snapshot?.make);
  const model = normalizeText(snapshot?.model);
  const year = asNumber(snapshot?.year, null);

  // 2005–2011 Tacoma is covered under Toyota's frame rust settlement
  const isTacomaFrameRisk = make === "toyota" && /tacoma/i.test(model) && Number.isFinite(year) && year >= 2005 && year <= 2011;
  if (isTacomaFrameRisk) {
    const alreadyHasFrame = asArray(out.deal_breakers).some((d) => /frame.*rust|rust.*frame/i.test(asString(d, "")));
    if (!alreadyHasFrame) {
      out.deal_breakers = [
        "Frame perforation or severe rust — check Toyota's frame rust settlement; reject if structural integrity is compromised",
        ...asArray(out.deal_breakers)
      ];
    }
  }
}

function filterGenericDealBreakers(out, snapshot) {
  const drive = inferredDrivetrain(snapshot);
  const hasCarfax = /carfax/i.test(normalizeText(snapshot?.seller_description || ""));

  const GENERIC_PATTERNS = [
    /found during inspection/i,
    /during test drive/i,
    /significant rust or body damage/i,
    /unexplained mechanical/i,
    /lack of documentation/i,
    /inconsistent maintenance records/i,
    // Drop "unverified drivetrain" if drivetrain is actually known
    ...(drive ? [/unverified drivetrain|drivetrain.*unverif|drivetrain.*unknown|unknown.*drivetrain/i] : []),
    // Drop "missing VIN" if seller mentions Carfax (implies VIN available)
    ...(hasCarfax ? [/missing\s+vin|vin.*not.*available|no\s+vin/i] : []),
  ];
  out.deal_breakers = asArray(out.deal_breakers).filter(
    (s) => !GENERIC_PATTERNS.some((p) => p.test(asString(s, "")))
  );
}

/**
 * Coerce/fill required output so UI doesn't break even if the model slips.
 * Also enforces some consistency constraints.
 */
function coerceAndFill(raw, snapshot) {
  const out = {};

  out.summary = asString(raw.summary);
  out.year_model_reputation = asString(raw.year_model_reputation);

  const mergeCost = (x) => {
    if (x?.estimated_cost) return stripLeadingDecorators(asString(x.estimated_cost));
    const diy = asString(x?.estimated_cost_diy);
    const shop = asString(x?.estimated_cost_shop);
    if (diy && shop) return `${diy} DIY / ${shop} shop`;
    return diy || shop || "";
  };

  out.expected_maintenance_near_term = asArray(raw.expected_maintenance_near_term).map((x) => ({
    item: stripLeadingDecorators(asString(x?.item)),
    typical_mileage_range: stripLeadingDecorators(asString(x?.typical_mileage_range)),
    why_it_matters: stripLeadingDecorators(asString(x?.why_it_matters)),
    estimated_cost: mergeCost(x)
  }));

  out.common_issues = asArray(raw.common_issues).map((x) => ({
    issue: stripLeadingDecorators(asString(x?.issue)),
    typical_failure_mileage: stripLeadingDecorators(asString(x?.typical_failure_mileage)),
    severity: stripLeadingDecorators(asString(x?.severity)),
    estimated_cost: mergeCost(x)
  }));
  out.wear_items = asArray(raw.wear_items).map((x) => ({
    item: stripLeadingDecorators(asString(x?.item)),
    typical_mileage_range: stripLeadingDecorators(asString(x?.typical_mileage_range)),
    why_it_matters: stripLeadingDecorators(asString(x?.why_it_matters)),
    estimated_cost: mergeCost(x)
  }));

  // Still read from model, but we overwrite with deterministic builder.
  out.remaining_lifespan_estimate = asString(raw.remaining_lifespan_estimate);
  out.market_value_estimate = asString(raw.market_value_estimate);
  out.price_opinion = asString(raw.price_opinion);

  out.mechanical_skill_required = asString(raw.mechanical_skill_required);
  out.daily_driver_vs_project = asString(raw.daily_driver_vs_project);

  out.upsides = asArray(raw.upsides)
    .map((s) => stripLeadingDecorators(s))
    .filter((s) => s && s !== "unknown");
  out.inspection_checklist = asArray(raw.inspection_checklist).map((s) => stripLeadingDecorators(s));
  out.buyer_questions = asArray(raw.buyer_questions).map((s) => stripLeadingDecorators(s));

  out.risk_flags = asArray(raw.risk_flags).map((s) => stripLeadingDecorators(s));
  out.deal_breakers = asArray(raw.deal_breakers).map((s) => stripLeadingDecorators(s));
  out.tags = asArray(raw.tags).map((s) => asString(s)).slice(0, 6);

  const evidenceCoverage = computeEvidenceCoverage(snapshot);
  out.confidence = clamp(evidenceCoverage, 0, 1);

  // Score: use deterministic heuristic so grade/verdict behavior is stable and explainable.
  const heuristicScore = computeHeuristicDecisionScore(snapshot, out);
  let score = heuristicScore;
  if (deriveTitleStatus(snapshot) === "no_title") score = Math.min(score, 24);
  score = clamp(Math.round(score), 0, 100);
  out.risk_score_base = score;
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
  if (!snapshot?.price_usd || Number(snapshot.price_usd) <= 0) missing.push("price");
  if (!snapshot?.mileage_miles || Number(snapshot.mileage_miles) <= 0) missing.push("mileage");
  if (!snapshot?.seller_description) missing.push("seller description");
  if (missing.length) {
    const m = `Listing info not fully captured: ${missing.join(", ")}. Check the listing directly and refresh to re-analyze if data has loaded.`;
    out.notes = out.notes ? `${out.notes} ${m}` : m;
  }

  const derivedTitleStatus = ensureTitleConsistency(out, snapshot);
  fixKnownMaintenance(out, snapshot);
  replaceSpeculativeCELMaintenance(out, snapshot);
  fixWearItemCosts(out, snapshot);
  applyCompletedServiceOverrides(out, snapshot);
  ensureUpsides(out, snapshot);
  dropGenericOilChangeFromNearTerm(out, snapshot);
  ensureSpecificMaintenance(out, snapshot);
  detectSellerDisclosedNeeds(out, snapshot);
  ensureBuyerQuestions(out, snapshot, derivedTitleStatus);
  sharpenRiskFlags(out, snapshot, derivedTitleStatus);
  injectKnownVehicleDealBreakers(out, snapshot);
  filterGenericDealBreakers(out, snapshot);
  groundReputation(out);
  normalizeLifespanEstimate(out, snapshot);
  applyExtremeMileageCaps(out, snapshot);
  enforceFactConsistency(out, snapshot);
  applyDeterministicValuationBand(out, snapshot);
  buildDeterministicSummary(out, snapshot);
  out.deal_grade = letterGradeFromScore(out.overall_score);
  out.risk_level = riskLevelFromScore(asNumber(out.risk_score_base, out.overall_score));
  normalizeVerdictTone(out, snapshot);

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
          required: ["item", "typical_mileage_range", "why_it_matters", "estimated_cost"],
          properties: {
            item: { type: "string" },
            typical_mileage_range: { type: "string" },
            why_it_matters: { type: "string" },
            estimated_cost: { type: "string" }
          }
        }
      },
      common_issues: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["issue", "typical_failure_mileage", "severity", "estimated_cost"],
          properties: {
            issue: { type: "string" },
            typical_failure_mileage: { type: "string" },
            severity: { type: "string" },
            estimated_cost: { type: "string" }
          }
        }
      },
      wear_items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["item", "typical_mileage_range", "why_it_matters", "estimated_cost"],
          properties: {
            item: { type: "string" },
            typical_mileage_range: { type: "string" },
            why_it_matters: { type: "string" },
            estimated_cost: { type: "string" }
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
          let status = "unknown";
          if (eventType.startsWith("customer.subscription.")) {
            status = dataObject?.status || "unknown";
          } else if (eventType === "checkout.session.completed") {
            // dataObject.status = "complete" (session status), not a subscription status.
            // Default to "active" since checkout.session.completed means payment succeeded.
            status = "active";
            if (dataObject?.subscription && env.STRIPE_SECRET_KEY) {
              const subRes = await stripeGetRequest(env, `subscriptions/${dataObject.subscription}`);
              if (subRes?.ok && subRes?.data?.status) status = subRes.data.status;
            }
          } else {
            status = dataObject?.subscription_status || dataObject?.status || "unknown";
          }
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

      if (url.pathname === "/") {
        const html =
          "<!doctype html>" +
          "<html><head><meta charset=\"utf-8\"><title>StraightShotAuto</title></head>" +
          "<body style=\"font-family:system-ui, -apple-system, sans-serif; padding:24px;\">" +
          "<h2>StraightShotAuto</h2>" +
          "<p>Sign-in received. You can close this tab and return to Facebook Marketplace.</p>" +
          "</body></html>";
        return new Response(html, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            ...corsHeaders(origin)
          }
        });
      }

      if (url.pathname === "/auth/callback") {
        const html =
          "<!doctype html>" +
          "<html><head><meta charset=\"utf-8\"><title>StraightShotAuto</title></head>" +
          "<body style=\"font-family:system-ui, -apple-system, sans-serif; padding:24px;\">" +
          "<h2>StraightShotAuto</h2>" +
          "<p>Sign-in received. You can close this tab and return to Facebook Marketplace.</p>" +
          "</body></html>";
        return htmlResponse(html, origin, 200);
      }

      if (url.pathname === "/success") {
        const html =
          "<!doctype html>" +
          "<html><head><meta charset=\"utf-8\"><title>StraightShotAuto</title></head>" +
          "<body style=\"font-family:system-ui, -apple-system, sans-serif; padding:24px; background:#f7f6f2;\">" +
          "<div style=\"max-width:640px; margin:10vh auto; background:#fff; border:1px solid #e6e2d8; padding:24px; border-radius:12px;\">" +
          "<h2 style=\"margin:0 0 8px; font-size:22px;\">Payment successful</h2>" +
          "<p style=\"margin:0; font-size:15px; line-height:1.5;\">Your subscription is active. You can close this tab and return to Facebook Marketplace.</p>" +
          "<p style=\"margin-top:12px; color:#6b6b6b;\">StraightShotAuto</p>" +
          "</div></body></html>";
        return htmlResponse(html, origin, 200);
      }

      if (url.pathname === "/cancel") {
        const html =
          "<!doctype html>" +
          "<html><head><meta charset=\"utf-8\"><title>StraightShotAuto</title></head>" +
          "<body style=\"font-family:system-ui, -apple-system, sans-serif; padding:24px; background:#f7f6f2;\">" +
          "<div style=\"max-width:640px; margin:10vh auto; background:#fff; border:1px solid #e6e2d8; padding:24px; border-radius:12px;\">" +
          "<h2 style=\"margin:0 0 8px; font-size:22px;\">Payment canceled</h2>" +
          "<p style=\"margin:0; font-size:15px; line-height:1.5;\">No charges were made. You can close this tab and return to Facebook Marketplace.</p>" +
          "<p style=\"margin-top:12px; color:#6b6b6b;\">StraightShotAuto</p>" +
          "</div></body></html>";
        return htmlResponse(html, origin, 200);
      }

      if (url.pathname === "/auth/signup") {
        if (request.method === "GET") {
          const html =
            "<!doctype html>" +
            "<html><head><meta charset=\"utf-8\"><title>StraightShotAuto</title></head>" +
            "<body style=\"font-family:system-ui, -apple-system, sans-serif; padding:24px; max-width:520px;\">" +
            "<h2>StraightShotAuto</h2>" +
            "<p>Create your account.</p>" +
            "<form id=\"signup-form\">" +
            "<label>Email<br><input type=\"email\" id=\"email\" required style=\"width:100%; padding:8px; margin:6px 0;\"></label>" +
            "<label>Password<br><input type=\"password\" id=\"password\" required minlength=\"6\" style=\"width:100%; padding:8px; margin:6px 0;\"></label>" +
            "<button type=\"submit\" style=\"padding:10px 14px;\">Create account</button>" +
            "</form>" +
            "<p id=\"msg\" style=\"margin-top:12px;\"></p>" +
            "<script>" +
            "const form=document.getElementById('signup-form');" +
            "const msg=document.getElementById('msg');" +
            "form.addEventListener('submit', async (e)=>{" +
            "e.preventDefault();" +
            "msg.textContent='Creating account…';" +
            "const email=document.getElementById('email').value.trim();" +
            "const password=document.getElementById('password').value;" +
            "const res=await fetch('/auth/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});" +
            "const data=await res.json().catch(()=>({}));" +
            "if(!res.ok){msg.textContent=data?.error||'Unable to create account';return;}" +
            "msg.textContent='Account created. You can close this tab and log in from the extension.';" +
            "});" +
            "</script>" +
            "</body></html>";
          return new Response(html, {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              ...corsHeaders(origin)
            }
          });
        }
        if (request.method !== "POST") {
          return jsonResponse({ error: "Method not allowed" }, origin, 405);
        }
        let body = null;
        try {
          body = await request.json();
        } catch {
          body = null;
        }
        const email = (body?.email || "").toString().trim();
        const password = (body?.password || "").toString();
        if (!email || !password) {
          return jsonResponse({ error: "Email and password required" }, origin, 400);
        }
        if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
          return jsonResponse({ error: "Auth not configured" }, origin, 500);
        }
        const res = await fetch(`${env.SUPABASE_URL}/auth/v1/signup`, {
          method: "POST",
          headers: {
            apikey: env.SUPABASE_ANON_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ email, password })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          return jsonResponse({ error: data?.msg || data?.error_description || "Signup failed" }, origin, 400);
        }
        return jsonResponse({ ok: true }, origin, 200);
      }

      if (url.pathname === "/auth/status") {
        if (request.method !== "POST") {
          return jsonResponse({ error: "Method not allowed" }, origin, 405);
        }
        const token = getAuthToken(request);
        const user = await fetchSupabaseUser(token, env);
        if (!user) return jsonResponse({ authenticated: false }, origin, 200);
        const sub = await resolveSubscriptionRecord(user, env);
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

        let resolvedUserId = user?.id || null;
        if (!resolvedUserId && email) {
          const emailUser = await findOrCreateSupabaseUserByEmail(email, env);
          resolvedUserId = emailUser?.id || null;
        }

        const paymentLink = (env.STRIPE_PAYMENT_LINK || "").toString().trim();
        if (paymentLink) {
          try {
            const checkoutUrl = new URL(paymentLink);
            const checkoutEmail = (user?.email || email || "").toString().trim();
            if (checkoutEmail) checkoutUrl.searchParams.set("prefilled_email", checkoutEmail);
            if (resolvedUserId) checkoutUrl.searchParams.set("client_reference_id", resolvedUserId);
            if (request.method === "GET") {
              return Response.redirect(checkoutUrl.toString(), 303);
            }
            return jsonResponse({ url: checkoutUrl.toString() }, origin, 200);
          } catch {
            return jsonResponse({ error: "Invalid STRIPE_PAYMENT_LINK" }, origin, 500);
          }
        }

        if (!env.STRIPE_PRICE_ID || !env.STRIPE_SUCCESS_URL || !env.STRIPE_CANCEL_URL) {
          return jsonResponse({ error: "Billing not configured" }, origin, 500);
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
        const makePortalSession = (cid) =>
          stripeRequest(env, "billing_portal/sessions", new URLSearchParams({
            customer: cid,
            return_url: env.STRIPE_SUCCESS_URL
          }));

        let sessionRes = await makePortalSession(customerId);

        // If Stripe doesn't know this customer ID (test/live mode mismatch or stale ID),
        // look up the real customer by email and retry once.
        if (!sessionRes?.ok && /no such customer/i.test(sessionRes?.error || "")) {
          const email = user.email;
          if (email) {
            const listRes = await stripeGetRequest(env, `customers?email=${encodeURIComponent(email)}&limit=1`);
            const freshId = listRes?.data?.data?.[0]?.id;
            if (freshId && freshId !== customerId) {
              await supabaseAdminRequest("/rest/v1/subscriptions", env, {
                method: "POST",
                headers: { Prefer: "resolution=merge-duplicates" },
                body: JSON.stringify({ user_id: user.id, stripe_customer_id: freshId, updated_at: new Date().toISOString() })
              });
              sessionRes = await makePortalSession(freshId);
            }
          }
        }

        if (!sessionRes?.ok) {
          return jsonResponse(
            { error: sessionRes?.error || "Unable to create portal session" },
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

      const requestId =
        (typeof crypto?.randomUUID === "function" && crypto.randomUUID()) ||
        `req_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;

      const lifespanAnchors = buildLifespanAnchorsForPrompt(snapshot);

      const canon = canonicalSnapshot(snapshot);
      const snapshotKey = await hashString(JSON.stringify(canon));
      const cacheKey = new Request(`https://cache.car-bot.local/analyze/${CACHE_VERSION}/${snapshotKey}`);
      const cache = caches.default;

      const cached = await cache.match(cacheKey);
      if (cached) {
        let freeQuota = null;
        if (!authValidated) {
          freeQuota = await consumeFreeAnalysisSlot(request, cache, snapshotKey);
          if (!freeQuota.ok) return freeLimitResponse(origin, requestId, snapshotKey);
        }
        const withCors = new Response(cached.body, cached);
        withCors.headers.set("Access-Control-Allow-Origin", origin || "*");
        withCors.headers.set("X-Cache", "HIT");
        withCors.headers.set("X-Dedupe", "CACHE_HIT");
        withCors.headers.set("X-Request-Id", requestId);
        withCors.headers.set("X-Snapshot-Key", snapshotKey.slice(0, 12));
        withCors.headers.set("X-User-Validated", authValidated ? "true" : "false");
        if (!authValidated && freeQuota) withCors.headers.set("X-Free-Remaining", String(freeQuota.remaining));
        return withCors;
      }

      return await dedupe(snapshotKey, async () => {
        const cached2 = await cache.match(cacheKey);
        if (cached2) {
          let freeQuota = null;
          if (!authValidated) {
            freeQuota = await consumeFreeAnalysisSlot(request, cache, snapshotKey);
            if (!freeQuota.ok) return freeLimitResponse(origin, requestId, snapshotKey);
          }
          const withCors = new Response(cached2.body, cached2);
          withCors.headers.set("Access-Control-Allow-Origin", origin || "*");
          withCors.headers.set("X-Cache", "HIT");
          withCors.headers.set("X-Dedupe", "LOCK_HIT");
          withCors.headers.set("X-Request-Id", requestId);
          withCors.headers.set("X-Snapshot-Key", snapshotKey.slice(0, 12));
          withCors.headers.set("X-User-Validated", authValidated ? "true" : "false");
          if (!authValidated && freeQuota) withCors.headers.set("X-Free-Remaining", String(freeQuota.remaining));
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
              ...corsHeaders(origin),
              "X-Request-Id": requestId,
              "X-Snapshot-Key": snapshotKey.slice(0, 12),
              "X-Dedupe": "LOCK_MISS"
            }
          });
        }

        if (!env.OPENAI_API_KEY) {
          return jsonResponse({ error: "Server missing OPENAI_API_KEY" }, origin, 500);
        }

        const normalizedFacts = buildNormalizedFacts(snapshot);
        const facts = {
          year: normalizedFacts.year.value,
          make: normalizedFacts.make.value,
          model: normalizedFacts.model.value,
          trim: normalizedFacts.trim.value,
          price_usd: normalizedFacts.price_usd.value,
          mileage_miles: normalizedFacts.mileage_miles.value,
          drivetrain: normalizedFacts.drivetrain.value,
          transmission: normalizedFacts.transmission.value,
          engine: normalizedFacts.engine.value,
          title_status: normalizedFacts.title_status.value,
          owner_count_claimed: normalizedFacts.owner_count_claimed.value,
          accident_claimed: normalizedFacts.accident_claimed.value,
          records_claimed: normalizedFacts.records_claimed.value,
          modifications_detected: normalizedFacts.modifications_detected.value,
          seller_claims: snapshot.seller_description
        };

        // Prompt: keep focused on this listing and structured outputs
        const userPrompt = [
          "Evaluate this used car listing snapshot for a buyer.",
          "Be specific. Do not contradict the canonical facts.",
          "Do not claim a field is missing if canonical facts include a value for it.",
          "If canonical facts conflict with free-form listing text, trust canonical facts.",
          "Only mark a field unknown when normalized_facts.<field>.value is null.",
          "If a fact source is 'derived', you may use it but label it as inferred in wording.",
          "",
          "Canonical facts (do not contradict):",
          JSON.stringify(facts, null, 2),
          "",
          "Normalized facts with provenance/confidence/evidence:",
          JSON.stringify(normalizedFacts, null, 2),
          "",
          "Field requirements (follow exactly):",
          "- summary: 2–4 sentences using listing facts.",
          "- year_model_reputation: 1–3 sentences specific to this exact year and powertrain. Name the top 2–3 known failure modes with the mileage range they occur (e.g. 'LR3 4.4L AJ-V8: valley gasket coolant leak at 80k–120k miles; air suspension compressor fails near 100k–150k miles'). Never write 'reliability depends on maintenance', 'generally robust', or other generic filler — if you do not know specific failure modes for this exact powertrain, say so explicitly.",
          "- expected_maintenance_near_term: only items genuinely applicable at this mileage/vehicle, up to 6; cost as a single string e.g. '$80–$200 DIY / $250–$500 shop'.",
          "- common_issues: [] unless highly confident for this exact year/generation/powertrain.",
          "- wear_items: only items that are actually relevant to this vehicle; if seller claims new wear items, say 'verify receipt/date'; cost as a single string e.g. '$500–$1,000 DIY / $700–$1,300 shop'.",
          "- remaining_lifespan_estimate: exactly 3 lines (Best/Average/Worst) expressed as additional miles remaining — NOT calendar years. Format: 'Best: 80,000–100,000 more miles (assumption)'. Calibrate against the lifespan anchors provided.",
          "- risk_flags: only real, specific risks for this listing — no generic filler, no minimum count; each includes subsystem + consequence + ($range or $unknown).",
          "- buyer_questions: 4–7 relevant questions; each has (why it matters); at least 2 component-specific.",
          "- deal_breakers: only observable inspection or test-drive findings that would make you walk away — written as symptoms, not abstract risks (e.g. 'Air suspension drops overnight — compressor or airbag failure ($1,500–$3,000)', 'Smoke from exhaust under load — engine or head gasket'). Not: 'Possible air suspension issues'. No minimum count.",
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
            model: "gpt-4o",
            temperature: 0.15,
            max_output_tokens: 3500,
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
        let freeQuota = null;
        if (!authValidated) {
          freeQuota = await consumeFreeAnalysisSlot(request, cache, snapshotKey);
          if (!freeQuota.ok) return freeLimitResponse(origin, requestId, snapshotKey);
        }
        const res = jsonResponse(final, origin, 200);
        res.headers.set("X-Cache", "MISS");
        res.headers.set("X-Dedupe", "LOCK_MISS");
        res.headers.set("X-Request-Id", requestId);
        res.headers.set("X-Snapshot-Key", snapshotKey.slice(0, 12));
        res.headers.set("X-User-Validated", authValidated ? "true" : "false");
        if (!authValidated && freeQuota) res.headers.set("X-Free-Remaining", String(freeQuota.remaining));
        if (authUser?.id) res.headers.set("X-User-Id", authUser.id);

        ctx?.waitUntil?.(cache.put(cacheKey, res.clone()));
        return res;
      });
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
