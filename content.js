(() => {
  if (window.top !== window.self) return;
  if (window.FBCO_CONTENT_LOADED) return;
  window.FBCO_CONTENT_LOADED = true;
  const UPDATE_DEBOUNCE_MS = 300;
  const API_URL = "https://car-bot.car-bot.workers.dev/analyze";
  const AUTH_STATUS_URL = "https://car-bot.car-bot.workers.dev/auth/status";
  const BILLING_CHECKOUT_URL = "https://car-bot.car-bot.workers.dev/billing/checkout";
  const AUTH_CALLBACK_URL = "https://car-bot.car-bot.workers.dev/auth/callback";
  const AUTH_SIGNUP_URL = "https://car-bot.car-bot.workers.dev/auth/signup";
  const SUPABASE_URL = "https://uluvqqypgdpsxzutojdd.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVsdXZxcXlwZ2Rwc3h6dXRvamRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAwNzY1MDgsImV4cCI6MjA4NTY1MjUwOH0.m49_Y868P0Vpw5vT3SuDDEXbsSN3VT80CMhPWP1HCH8";
  const FREE_LIMIT = 5;
  const AUTH_STORAGE_KEY = "fbco.auth.session.v1";
  const AUTH_EMAIL_KEY = "fbco.auth.email.v1";
  const AUTH_VALIDATED_UNTIL_KEY = "fbco.auth.validated.until.v1";
  const FREE_COUNT_KEY = "fbco.free.count.v1";
  const FREE_KEY_KEY = "fbco.free.snapshot.v1";
  const FREE_DAY_KEY = "fbco.free.day.v1";
  const FREE_SYNC_DAY_KEY = "fbco.free.sync.day.v1";
  const CHECKOUT_PENDING_KEY = "fbco.checkout.pending.v1";
  const AUTH_MODE = "password";
  const NAV_CLEAR_MS = 1500;
  let authHydrationPromise = null;
  let activeAnalyzeController = null;
  if (!window.FBCO_STATE) {
    window.FBCO_STATE = {
      overlayId: "fb-car-overlay-mvp",
      dismissed: false,
      isUserSelecting: false,
      analysisLoading: false,
      analysisError: null,
      lastAnalysis: null,
      lastSnapshotKey: null,
      analysisSeq: 0,
      analysisReady: false,
      lastVehicle: null,
      lastRenderKey: null,
      authSession: null,
      authValidated: false,
      authMessage: "",
      freeCount: 0,
      analysisGated: false
    };
  }
  if (!window.FBCO_storage) {
    window.FBCO_storage = {
      get(key, fallback) {
        try {
          const v = localStorage.getItem(key);
          return v == null ? fallback : JSON.parse(v);
        } catch {
          return fallback;
        }
      },
      set(key, value) {
        try {
          localStorage.setItem(key, JSON.stringify(value));
        } catch {}
      }
    };
  }
  const debounce =
    typeof window.FBCO_debounce === "function"
      ? window.FBCO_debounce
      : (fn, waitMs) => {
          let t = null;
          return function (...args) {
            if (t) clearTimeout(t);
            t = setTimeout(() => fn.apply(this, args), waitMs);
          };
        };

  function isItemPage() {
    return /\/marketplace\/item\//.test(location.pathname);
  }

  function buildSnapshotKey(vehicle) {
    if (!vehicle) return null;
    if (!vehicle.year || !vehicle.make) return null;
    if (window.FBCO_makeSnapshotKey) {
      const key = window.FBCO_makeSnapshotKey(vehicle);
      if (key) return key;
    }
    const normalizeListingId = (url) => {
      if (!url) return "";
      try {
        const u = new URL(url);
        const m = u.pathname.match(/\/marketplace\/item\/(\d+)/);
        return m ? m[1] : u.pathname || "";
      } catch {
        return String(url);
      }
    };
    const norm = (v) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : v ?? "");
    // Include data-completeness flags so the key changes as the page finishes
    // loading — this ensures a fresh analysis is requested once price, mileage,
    // and the seller description all become available.
    return JSON.stringify({
      listing_id: normalizeListingId(vehicle.url),
      url: norm(vehicle.url),
      vin: norm(vehicle.vin),
      year: vehicle.year,
      make: norm(vehicle.make),
      model: norm(vehicle.model),
      trim: norm(vehicle.trim),
      has_price: Boolean(vehicle.price_usd > 0),
      has_mileage: Boolean(vehicle.mileage_miles > 0),
      has_seller: Boolean(vehicle.seller_description)
    });
  }

  function isCompleteAnalysis(data) {
    if (!data) return false;
    const hasSummary = typeof data.summary === "string" && data.summary.trim() && data.summary !== "unknown";
    const hasVerdict =
      typeof data.final_verdict === "string" && data.final_verdict.trim() && data.final_verdict !== "unknown";
    const hasConfidence = Number.isFinite(Number(data.confidence));
    return hasSummary && hasVerdict && hasConfidence;
  }

  function buildAccessInfo(state) {
    const freeCount = loadFreeCount();
    const quotaSynced = isFreeQuotaSyncedToday();
    const storedSession = loadAuthSession();
    const activeSession = state?.authSession?.access_token ? state.authSession : storedSession;
    const validated = Boolean(state?.authValidated);
    return {
      authenticated: Boolean(activeSession?.access_token),
      validated,
      freeCount,
      freeRemaining: validated || quotaSynced ? Math.max(0, FREE_LIMIT - freeCount) : null,
      freeQuotaSynced: quotaSynced,
      email: activeSession?.user?.email || "",
      message: state?.authMessage || "",
      authMode: AUTH_MODE,
      lastEmail: window.FBCO_storage.get(AUTH_EMAIL_KEY, "")
    };
  }

  function loadAuthSession() {
    return window.FBCO_storage.get(AUTH_STORAGE_KEY, null);
  }

  function loadValidatedUntil() {
    const until = Number(window.FBCO_storage.get(AUTH_VALIDATED_UNTIL_KEY, 0)) || 0;
    return until > Date.now() ? until : 0;
  }

  function cacheValidatedState(validated, ttlMs = 12 * 60 * 60 * 1000) {
    const until = validated ? Date.now() + ttlMs : 0;
    window.FBCO_storage.set(AUTH_VALIDATED_UNTIL_KEY, until);
  }

  function normalizeAuthSession(data, prev = null) {
    if (!data?.access_token) return null;
    const expiresAt = Number(data.expires_at);
    const expiresIn = Number(data.expires_in);
    const fallbackPrev = Number(prev?.expires_at);
    const computedExpiresAt = Number.isFinite(expiresAt)
      ? expiresAt
      : Number.isFinite(expiresIn)
      ? Math.floor(Date.now() / 1000) + expiresIn
      : Number.isFinite(fallbackPrev)
      ? fallbackPrev
      : null;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || prev?.refresh_token || null,
      expires_at: computedExpiresAt,
      token_type: data.token_type || prev?.token_type || "bearer",
      user: data.user || prev?.user || null
    };
  }

  function syncAuthToChromeStorage(session) {
    if (!chrome?.storage?.local?.set) return;
    try {
      chrome.storage.local.set({ [AUTH_STORAGE_KEY]: session });
    } catch {
      // ignore
    }
  }

  function saveAuthSession(session) {
    window.FBCO_storage.set(AUTH_STORAGE_KEY, session);
    syncAuthToChromeStorage(session);
  }

  function clearAuthSession() {
    window.FBCO_storage.set(AUTH_STORAGE_KEY, null);
    window.FBCO_storage.set(AUTH_VALIDATED_UNTIL_KEY, 0);
    syncAuthToChromeStorage(null);
  }

  async function hydrateAuthFromChromeStorage() {
    if (authHydrationPromise) return authHydrationPromise;
    authHydrationPromise = (async () => {
      if (!chrome?.storage?.local?.get) return;
      try {
        const data = await new Promise((resolve) => {
          chrome.storage.local.get([AUTH_STORAGE_KEY, AUTH_EMAIL_KEY], (res) => resolve(res || {}));
        });
        if (Object.prototype.hasOwnProperty.call(data, AUTH_STORAGE_KEY)) {
          const hydrated = normalizeAuthSession(data[AUTH_STORAGE_KEY], loadAuthSession());
          window.FBCO_storage.set(AUTH_STORAGE_KEY, hydrated);
          if (window.FBCO_STATE && hydrated?.access_token) {
            window.FBCO_STATE.authSession = hydrated;
          }
        }
        if (Object.prototype.hasOwnProperty.call(data, AUTH_EMAIL_KEY)) {
          window.FBCO_storage.set(AUTH_EMAIL_KEY, data[AUTH_EMAIL_KEY] ?? "");
        }
      } catch {
        // ignore
      }
    })();
    return authHydrationPromise;
  }

  function currentDayStamp() {
    return new Date().toISOString().slice(0, 10);
  }

  function loadFreeCount() {
    const today = currentDayStamp();
    const storedDay = window.FBCO_storage.get(FREE_DAY_KEY, null);
    if (storedDay !== today) {
      window.FBCO_storage.set(FREE_DAY_KEY, today);
      window.FBCO_storage.set(FREE_COUNT_KEY, 0);
      window.FBCO_storage.set(FREE_KEY_KEY, null);
      window.FBCO_storage.set(FREE_SYNC_DAY_KEY, null);
      return 0;
    }
    return Number(window.FBCO_storage.get(FREE_COUNT_KEY, 0)) || 0;
  }

  function saveFreeCount(count) {
    window.FBCO_storage.set(FREE_DAY_KEY, currentDayStamp());
    window.FBCO_storage.set(FREE_COUNT_KEY, count);
  }

  function loadLastFreeKey() {
    return window.FBCO_storage.get(FREE_KEY_KEY, null);
  }

  function saveLastFreeKey(key) {
    window.FBCO_storage.set(FREE_KEY_KEY, key);
  }

  function markFreeQuotaSyncedToday() {
    window.FBCO_storage.set(FREE_SYNC_DAY_KEY, currentDayStamp());
  }

  function isFreeQuotaSyncedToday() {
    return window.FBCO_storage.get(FREE_SYNC_DAY_KEY, null) === currentDayStamp();
  }

  function markCheckoutPending(ms = 2 * 60 * 1000) {
    const until = Date.now() + ms;
    window.FBCO_storage.set(CHECKOUT_PENDING_KEY, until);
    return until;
  }

  function getCheckoutPendingUntil() {
    const until = Number(window.FBCO_storage.get(CHECKOUT_PENDING_KEY, 0)) || 0;
    return until > Date.now() ? until : 0;
  }

  function clearCheckoutPending() {
    window.FBCO_storage.set(CHECKOUT_PENDING_KEY, 0);
  }

  function onAuthSessionChanged() {
    updateAccessState();
    scheduleUpdate();
  }

  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (changes[AUTH_STORAGE_KEY]) {
        window.FBCO_storage.set(AUTH_STORAGE_KEY, changes[AUTH_STORAGE_KEY].newValue ?? null);
        onAuthSessionChanged();
      }
      if (changes[AUTH_EMAIL_KEY]) {
        window.FBCO_storage.set(AUTH_EMAIL_KEY, changes[AUTH_EMAIL_KEY].newValue ?? "");
      }
    });
  }

  async function refreshSession(session) {
    if (!session?.refresh_token) return session;
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    });
    if (!res.ok) return session;
    const data = await res.json();
    const next = normalizeAuthSession(data, session);
    if (!next) return session;
    saveAuthSession(next);
    return next;
  }

  async function getValidSession() {
    await hydrateAuthFromChromeStorage();
    const rawSession = loadAuthSession();
    const session = normalizeAuthSession(rawSession, rawSession);
    if (!session?.access_token) return null;
    if (!session?.expires_at) {
      if (session.refresh_token) return refreshSession(session);
      return session;
    }
    const expiresAtMs = session.expires_at * 1000;
    if (Date.now() + 60_000 < expiresAtMs) return session;
    return refreshSession(session);
  }

  async function sendLoginCode(email) {
    if (!SUPABASE_URL || SUPABASE_URL.includes("YOUR_SUPABASE") || !SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.includes("YOUR_SUPABASE")) {
      throw new Error("Auth not configured");
    }
    if (email) window.FBCO_storage.set(AUTH_EMAIL_KEY, email);
    const res = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email,
        create_user: true,
        email_redirect_to: AUTH_CALLBACK_URL
      })
    });
    if (!res.ok) throw new Error("Unable to send magic link");
  }

  async function verifyLoginCode(email, code) {
    if (!SUPABASE_URL || SUPABASE_URL.includes("YOUR_SUPABASE") || !SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.includes("YOUR_SUPABASE")) {
      throw new Error("Auth not configured");
    }
    const res = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ type: "email", email, token: code })
    });
    if (!res.ok) throw new Error("Invalid code");
    const data = await res.json();
    const session = normalizeAuthSession(data);
    if (!session) throw new Error("Invalid login session");
    saveAuthSession(session);
    return session;
  }

  async function loginWithPassword(email, password) {
    if (!SUPABASE_URL || SUPABASE_URL.includes("YOUR_SUPABASE") || !SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.includes("YOUR_SUPABASE")) {
      throw new Error("Auth not configured");
    }
    if (!email || !password) throw new Error("Email and password required");
    window.FBCO_storage.set(AUTH_EMAIL_KEY, email);
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) throw new Error("Invalid email or password");
    const data = await res.json();
    const session = normalizeAuthSession(data);
    if (!session) throw new Error("Invalid login session");
    saveAuthSession(session);
    return session;
  }

  async function fetchAuthStatus(session) {
    if (!session?.access_token) return { authenticated: false };
    try {
      const res = await fetch(AUTH_STATUS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json"
        }
      });
      if (res.ok) return res.json();
      if (res.status === 401 || res.status === 403) return { authenticated: false, validated: false, hardFail: true };
      return { authenticated: true, validated: null, transient: true };
    } catch {
      return { authenticated: true, validated: null, transient: true };
    }
  }

  function startCheckout(popup, email) {
    const url = new URL(BILLING_CHECKOUT_URL);
    if (email) url.searchParams.set("email", email);
    if (popup && !popup.closed) {
      popup.location = url.toString();
    } else {
      window.open(url.toString(), "_blank", "noopener,noreferrer");
    }
  }

  async function requestAnalysis(vehicle, opts = {}) {
    const state = window.FBCO_STATE;
    if (!vehicle) return;

    const key = buildSnapshotKey(vehicle);
    if (!key) return;

    if (!opts.force && window.FBCO_ANALYZE_INFLIGHT && window.FBCO_ANALYZE_KEY === key) return;
    if (state.analysisLoading && !opts.retry) return;
    if (!opts.force && state.analysisRequestedKey === key) return;
    if (!opts.force && state.lastSnapshotKey === key && state.analysisReady && state.lastAnalysis && !state.analysisError) {
      return;
    }

    const now = Date.now();
    const minIntervalMs = 10000;
    if (state.nextAnalyzeAt && now < state.nextAnalyzeAt) return;
    if (!opts.force && state.lastAnalyzeAt && now - state.lastAnalyzeAt < minIntervalMs) return;

    const session = await getValidSession();
    state.authSession = session;
    if (session?.access_token && loadValidatedUntil()) state.authValidated = true;
    const authStatus = session ? await fetchAuthStatus(session) : { authenticated: false };
    if (authStatus?.validated === true) {
      state.authValidated = true;
      cacheValidatedState(true);
    } else if (authStatus?.validated === false) {
      state.authValidated = false;
      cacheValidatedState(false);
    } else if (!session?.access_token || !loadValidatedUntil()) {
      state.authValidated = false;
    }

    if (!opts.retry) state.analysisRetrying = false;

    state.freeCount = loadFreeCount();
    state.analysisGated = !state.authValidated && state.freeCount >= FREE_LIMIT;
    if (state.analysisGated) {
      state.analysisLoading = false;
      state.analysisReady = true;
      state.analysisError = "Free limit reached. Log in or subscribe to continue.";
      state.analysisErrorAt = Date.now();
      state.loadingPhase = "";
      window.FBCO_updateOverlay(vehicle, {
        loading: false,
        ready: true,
        error: state.analysisError,
        data: state.lastAnalysis,
        loadingText: "",
        access: buildAccessInfo(state),
        gated: state.analysisGated
      });
      return;
    }

    if (
      !opts.force &&
      state.lastSnapshotKey === key &&
      (state.analysisLoading || state.lastAnalysis || state.analysisError)
    ) {
      return;
    }

    const isNewSnapshot = state.lastSnapshotKey && state.lastSnapshotKey !== key;
    state.lastSnapshotKey = key;
    state.analysisRequestedKey = key;
    state.analysisRequestedAt = Date.now();
    state.analysisLoading = true;
    window.FBCO_ANALYZE_INFLIGHT = true;
    window.FBCO_ANALYZE_KEY = key;
    state.loadingPhase = isNewSnapshot ? "Refreshing analysis…" : "Analyzing model…";
    state.analysisError = null;
    state.analysisSeq += 1;
    const seq = state.analysisSeq;

    window.FBCO_updateOverlay(vehicle, {
      loading: true,
      ready: state.analysisReady,
      error: null,
      data: state.lastAnalysis,
      loadingText: state.loadingPhase,
      access: buildAccessInfo(state),
      gated: state.analysisGated
    });

    const phaseTimer = setTimeout(() => {
      if (window.FBCO_STATE.analysisLoading) {
        window.FBCO_STATE.loadingPhase = "Building checklist…";
        window.FBCO_updateOverlay(vehicle, {
          loading: true,
          ready: window.FBCO_STATE.analysisReady,
          error: window.FBCO_STATE.analysisError,
          data: window.FBCO_STATE.lastAnalysis,
          loadingText: window.FBCO_STATE.loadingPhase,
          access: buildAccessInfo(window.FBCO_STATE),
          gated: window.FBCO_STATE.analysisGated
        });
      }
    }, 3500);

    const controller = new AbortController();
    activeAnalyzeController = controller;
    const timeoutId = setTimeout(() => controller.abort(), 35000);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {})
        },
        signal: controller.signal,
        body: JSON.stringify({
        url: vehicle.url,
        source_text: vehicle.source_text,
        year: vehicle.year,
        make: vehicle.make,
        model: vehicle.model,
        trim: vehicle.trim,
        vehicle_type_hint: vehicle.vehicle_type_hint,
        trim_conflict: vehicle.trim_conflict,
        price_usd: vehicle.price_usd,
        mileage_miles: vehicle.mileage_miles,
        transmission: vehicle.transmission,
        drivetrain: vehicle.drivetrain,
        engine: vehicle.engine,
        fuel_type: vehicle.fuel_type,
        exterior_color: vehicle.exterior_color,
        interior_color: vehicle.interior_color,
        mpg_city: vehicle.mpg_city,
        mpg_highway: vehicle.mpg_highway,
        mpg_combined: vehicle.mpg_combined,
        nhtsa_rating: vehicle.nhtsa_rating,
        paid_off: vehicle.paid_off,
        title_status: vehicle.title_status,
        vin: vehicle.vin,
        seller_description: vehicle.seller_description,
        about_items: vehicle.about_items,
        provenance: vehicle.provenance,
        negotiation_points: vehicle.negotiation_points,
        is_vehicle: vehicle.is_vehicle
        })
      });

      if (res.status === 429) {
        let retryAfterSeconds = 10;
        try {
          const body = await res.json();
          retryAfterSeconds = Number(body?.retry_after_seconds) || retryAfterSeconds;
        } catch {
          retryAfterSeconds = Number(res.headers.get("Retry-After")) || retryAfterSeconds;
        }
        state.analysisError = "Rate limited";
        state.analysisErrorAt = Date.now();
        state.analysisReady = true;
        state.analysisRetrying = false;
        state.analysisLoading = false;
        state.loadingPhase = "";
        state.nextAnalyzeAt = Date.now() + Math.max(8, retryAfterSeconds) * 1000;
        window.FBCO_updateOverlay(vehicle, {
          loading: false,
          ready: true,
          error: state.analysisError,
          data: state.lastAnalysis,
          loadingText: "",
          access: buildAccessInfo(state),
          gated: state.analysisGated
        });
        return;
      }
      if (res.status === 402) {
        let msg = "Free limit reached. Log in or subscribe to continue.";
        try {
          const body = await res.json();
          if (typeof body?.error === "string" && body.error.trim()) msg = body.error.trim();
        } catch {}
        saveFreeCount(FREE_LIMIT);
        markFreeQuotaSyncedToday();
        state.freeCount = loadFreeCount();
        state.analysisGated = !state.authValidated && state.freeCount >= FREE_LIMIT;
        state.analysisError = msg;
        state.analysisErrorAt = Date.now();
        state.analysisReady = true;
        state.analysisRetrying = false;
        state.analysisLoading = false;
        state.loadingPhase = "";
        window.FBCO_updateOverlay(vehicle, {
          loading: false,
          ready: true,
          error: state.analysisError,
          data: state.lastAnalysis,
          loadingText: "",
          access: buildAccessInfo(state),
          gated: state.analysisGated
        });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const validatedHeader = res.headers.get("X-User-Validated");
      const freeRemainingHeader = res.headers.get("X-Free-Remaining");
      if (validatedHeader != null) {
        state.authValidated = validatedHeader === "true";
        cacheValidatedState(state.authValidated);
      }

      if (seq !== state.analysisSeq) return;
      state.lastAnalysis = data;
      const complete = isCompleteAnalysis(data);
      state.analysisReady = complete;

      if (!state.authValidated && Number.isFinite(Number(freeRemainingHeader))) {
        const remaining = Math.max(0, Math.min(FREE_LIMIT, Number(freeRemainingHeader)));
        saveFreeCount(FREE_LIMIT - remaining);
        saveLastFreeKey(key);
        markFreeQuotaSyncedToday();
      } else if (!state.authValidated && complete) {
        // Fallback for older backend responses that don't return X-Free-Remaining.
        const freeCount = loadFreeCount();
        const lastKey = loadLastFreeKey();
        if (lastKey !== key) {
          saveFreeCount(freeCount + 1);
          saveLastFreeKey(key);
        }
      }
      const updatedFree = Math.min(FREE_LIMIT, loadFreeCount());
      state.freeCount = updatedFree;
      state.analysisGated = !state.authValidated && updatedFree >= FREE_LIMIT;
      state.lastAnalyzeAt = Date.now();

      if (!complete) {
        state.analysisRetrying = false;
        state.analysisError = "Incomplete response";
        state.analysisErrorAt = Date.now();
        state.analysisReady = true;
      }
    } catch (err) {
      if (seq !== state.analysisSeq) return;
      if (err?.name === "AbortError") {
        state.analysisError = "Request timed out";
      } else {
        state.analysisError = err?.message || "Request failed";
      }
      state.analysisErrorAt = Date.now();
      state.analysisReady = true;
    } finally {
      clearTimeout(timeoutId);
      clearTimeout(phaseTimer);
      if (activeAnalyzeController === controller) activeAnalyzeController = null;
      if (window.FBCO_ANALYZE_KEY === key) {
        window.FBCO_ANALYZE_INFLIGHT = false;
        window.FBCO_ANALYZE_KEY = null;
      }
      if (seq !== state.analysisSeq) return;
      state.analysisLoading = state.analysisRetrying;
      if (!state.analysisRetrying) state.loadingPhase = "";
      window.FBCO_updateOverlay(vehicle, {
        loading: !state.analysisReady,
        ready: state.analysisReady,
        error: state.analysisError,
        data: state.lastAnalysis,
        loadingText: state.loadingPhase,
        access: buildAccessInfo(state),
        gated: state.analysisGated
      });
      // Re-check the snapshot key after analysis completes. If the page finished
      // loading while this request was in-flight (adding price/mileage/seller data),
      // the key will have changed and a fresh full-data analysis will be triggered.
      if (!state.analysisRetrying) scheduleUpdate();
    }
  }

  function interruptActiveAnalysis(reason = "") {
    const state = window.FBCO_STATE;
    if (!state) return;

    if (activeAnalyzeController) {
      try {
        activeAnalyzeController.abort();
      } catch {}
      activeAnalyzeController = null;
    }

    state.analysisSeq += 1;
    state.analysisLoading = false;
    state.analysisRetrying = false;
    state.loadingPhase = "";
    state.analysisRequestedKey = null;
    state.nextAnalyzeAt = 0;
    if (reason) {
      state.analysisError = reason;
      state.analysisErrorAt = Date.now();
      state.analysisReady = true;
    }
    window.FBCO_ANALYZE_INFLIGHT = false;
    window.FBCO_ANALYZE_KEY = null;
  }

  function runUpdate() {
    const state = window.FBCO_STATE;
    if (!state) return;
    if (typeof window.FBCO_extractVehicleSnapshot !== "function" || typeof window.FBCO_updateOverlay !== "function") {
      setTimeout(() => {
        if (window.FBCO_STATE && !window.FBCO_STATE.dismissed) scheduleUpdate();
      }, 300);
      return;
    }

    if (!isItemPage()) {
      window.FBCO_removeOverlay && window.FBCO_removeOverlay();
      return;
    }

    // If user closed overlay, don't recreate it.
    if (state.dismissed) return;

    // Avoid updating while user is selecting text inside overlay
    if (state.isUserSelecting) return;

    window.FBCO_STATE.loadingPhase = "Parsing listing…";
    let vehicle = window.FBCO_extractVehicleSnapshot();
    const suppressVehicle = Number(state.suppressVehicleUntil || 0) > Date.now();

    if (!suppressVehicle && state.lastVehicle) {
      const merged = { ...state.lastVehicle };
      Object.entries(vehicle || {}).forEach(([key, value]) => {
        if (value !== null && value !== undefined && value !== "") merged[key] = value;
      });
      vehicle = merged;
    }
    if (suppressVehicle) {
      vehicle = {};
      state.lastVehicle = null;
    }

    if (vehicle?.year && vehicle?.make) {
      state.lastVehicle = vehicle;
      state.parsePendingSince = null;
      if (typeof state.analysisError === "string" && state.analysisError.includes("Couldn’t read listing details")) {
        state.analysisError = null;
        state.analysisErrorAt = null;
        state.analysisReady = false;
      }
    } else if (!suppressVehicle) {
      if (!state.parsePendingSince) state.parsePendingSince = Date.now();
      const parseWaitMs = Date.now() - state.parsePendingSince;
      if (parseWaitMs > 4500 && !state.analysisLoading) {
        state.analysisLoading = false;
        state.analysisReady = true;
        state.loadingPhase = "";
        state.analysisError = "Couldn’t read listing details yet. Scroll the listing once, then press Refresh.";
        state.analysisErrorAt = Date.now();
      }
    }

    const snapshotKey = vehicle ? buildSnapshotKey(vehicle) : null;
    if (snapshotKey && snapshotKey !== state.lastSnapshotKey) {
      state.analysisError = null;
      state.analysisRetryKey = snapshotKey;
      state.analysisRetryCount = 0;
      state.analysisRetrying = false;
      state.analysisErrorAt = null;
      state.lastAnalysis = null;
      state.analysisReady = false;
      state.analysisRequestedKey = null;
    }

    const access = buildAccessInfo(state);
    const renderKey = JSON.stringify({
      vehicle,
      ready: state.analysisReady,
      error: state.analysisError,
      data: state.lastAnalysis,
      access,
      gated: state.analysisGated,
      clearVehicle: suppressVehicle
    });
    if (renderKey !== state.lastRenderKey) {
      state.lastRenderKey = renderKey;
      window.FBCO_updateOverlay(vehicle, {
        loading: !state.analysisReady,
        ready: state.analysisReady,
        error: state.analysisError,
        data: state.lastAnalysis,
        loadingText: state.loadingPhase,
        access,
        gated: state.analysisGated,
        clearVehicle: suppressVehicle
      });
    }

    if (vehicle?.is_vehicle === false) {
      window.FBCO_removeOverlay && window.FBCO_removeOverlay();
      return;
    }

    if (!suppressVehicle && vehicle?.year && vehicle?.make) {
      if (state.forceAnalysisNext) {
        state.forceAnalysisNext = false;
        requestAnalysis(vehicle, { force: true });
        return;
      }
      requestAnalysis(vehicle);
    }
  }

  function insertMessage(text) {
    const selectors = [
      '[contenteditable="true"][role="textbox"][aria-label*="Message"]',
      '[contenteditable="true"][role="textbox"][aria-label*="mensaje"]',
      'textarea[aria-label*="Message"]',
      'textarea[name="message"]',
      '[contenteditable="true"][role="textbox"]',
      'textarea',
      '[contenteditable="true"]'
    ];
    const candidates = selectors
      .flatMap((s) => Array.from(document.querySelectorAll(s)))
      .filter((el) => !el.closest(`#${window.FBCO_STATE?.overlayId}`))
      .filter((el) => (window.FBCO_isVisible ? window.FBCO_isVisible(el) : true));
    const el = candidates[0];
    if (!el) return false;

    el.focus();

    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const existing = el.value;
      el.value = existing ? existing + "\n" + text : text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }

    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);

      const prefix = el.textContent.trim() ? "\n" : "";
      const node = document.createTextNode(prefix + text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.setEndAfter(node);
      selection.removeAllRanges();
      selection.addRange(range);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prefix + text }));
      return true;
    } catch {
      return false;
    }
  }

  async function updateAccessState() {
    const state = window.FBCO_STATE;
    const prevValidated = Boolean(state.authValidated);
    const prevGated = Boolean(state.analysisGated);
    const session = await getValidSession();
    state.authSession = session;
    if (session?.access_token && loadValidatedUntil()) state.authValidated = true;
    const authStatus = session ? await fetchAuthStatus(session) : { authenticated: false };
    if (authStatus?.validated === true) {
      state.authValidated = true;
      cacheValidatedState(true);
    } else if (authStatus?.validated === false) {
      state.authValidated = false;
      cacheValidatedState(false);
    } else if (!session?.access_token || !loadValidatedUntil()) {
      state.authValidated = false;
    }
    if (state.authValidated) clearCheckoutPending();
    state.freeCount = loadFreeCount();
    state.analysisGated = !state.authValidated && state.freeCount >= FREE_LIMIT;

    // If access just unlocked, force a fresh analysis on current listing.
    if (state.authValidated && (!prevValidated || prevGated)) {
      state.forceAnalysisNext = true;
      state.analysisRequestedKey = null;
      state.analysisError = null;
      state.analysisErrorAt = null;
      if (!state.lastAnalysis) state.analysisReady = false;
    }
  }

  async function resetPassword(email) {
    if (!SUPABASE_URL || SUPABASE_URL.includes("YOUR_SUPABASE") || !SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.includes("YOUR_SUPABASE")) {
      throw new Error("Auth not configured");
    }
    if (!email) throw new Error("Email required");
    const res = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email })
    });
    if (!res.ok) throw new Error("Unable to send reset email");
  }

  window.FBCO_authResetPassword = async function (email) {
    const state = window.FBCO_STATE;
    state.authMessage = "Sending reset email...";
    scheduleUpdate();
    try {
      await resetPassword(email);
      state.authMessage = "Password reset email sent. Check your inbox.";
    } catch (err) {
      state.authMessage = err?.message || "Unable to send reset email.";
    }
    scheduleUpdate();
  };

  window.FBCO_authLogin = async function (email, password) {
    const state = window.FBCO_STATE;
    interruptActiveAnalysis();
    state.authMessage = "Signing in...";
    try {
      const session = await loginWithPassword(email, password);
      state.authSession = session;
      state.authMessage = "Signed in.";
    } catch (err) {
      state.authMessage = err?.message || "Unable to sign in.";
    }
    await updateAccessState();
    // Ensure same-listing re-run after login; avoids stale "empty" analysis cards.
    state.forceAnalysisNext = true;
    state.analysisRequestedKey = null;
    state.analysisError = null;
    state.analysisErrorAt = null;
    if (!state.lastAnalysis) state.analysisReady = false;
    scheduleUpdate();
  };

  window.FBCO_authLogout = async function () {
    interruptActiveAnalysis();
    clearAuthSession();
    const state = window.FBCO_STATE;
    state.authSession = null;
    state.authValidated = false;
    state.authMessage = "Signed out.";
    updateAccessState();
    scheduleUpdate();
  };

  window.FBCO_openSignup = function () {
    window.open(AUTH_SIGNUP_URL, "_blank", "noopener,noreferrer");
  };

  window.FBCO_saveAuthEmail = function (email) {
    const clean = (email || "").toString().trim();
    if (!clean) return;
    window.FBCO_storage.set(AUTH_EMAIL_KEY, clean);
  };

  window.FBCO_startCheckout = async function () {
    const state = window.FBCO_STATE;
    state.authMessage = "";
    const popup = window.open("", "_blank", "noopener,noreferrer");
    state.checkoutPollUntil = markCheckoutPending();
    try {
      const emailInput = document.getElementById("fbco-auth-email")?.value?.trim() || "";
      const email = /\S+@\S+\.\S+/.test(emailInput) ? emailInput : "";
      await getValidSession();
      startCheckout(popup, email);
    } catch (err) {
      if (popup && !popup.closed) popup.close();
      state.authMessage = err?.message || "Unable to start checkout.";
    }
    scheduleCheckoutPoll();
    scheduleUpdate();
  };

  function scheduleCheckoutPoll() {
    const state = window.FBCO_STATE;
    if (!state || state.checkoutPollTimer) return;
    state.checkoutPollTimer = setInterval(async () => {
      const pendingUntil = state.checkoutPollUntil || getCheckoutPendingUntil();
      if (!pendingUntil || Date.now() > pendingUntil) {
        clearInterval(state.checkoutPollTimer);
        state.checkoutPollTimer = null;
        state.checkoutPollUntil = 0;
        clearCheckoutPending();
        return;
      }
      if (state.authValidated) {
        clearInterval(state.checkoutPollTimer);
        state.checkoutPollTimer = null;
        state.checkoutPollUntil = 0;
        clearCheckoutPending();
        return;
      }
      await updateAccessState();
      scheduleUpdate();
    }, 4000);
  }

  window.FBCO_insertMessage = insertMessage;
  window.FBCO_requestRefresh = function () {
    const state = window.FBCO_STATE;
    if (!state) return;
    state.analysisSeq += 1;
    state.lastSnapshotKey = null;
    state.analysisRequestedKey = null;
    state.analysisLoading = false;
    state.analysisError = null;
    state.lastAnalysis = null;
    state.analysisReady = false;
    state.analysisRetrying = false;
    state.lastRenderKey = null;
    state.lastVehicle = null;
    state.loadingPhase = "Parsing listing…";
    state.suppressVehicleUntil = Date.now() + NAV_CLEAR_MS;
    runUpdate();
  };

  const scheduleUpdate = debounce(runUpdate, UPDATE_DEBOUNCE_MS);

  // Initial run
  if (isItemPage() && window.FBCO_updateOverlay) {
    window.FBCO_updateOverlay(
      {},
      {
        loading: true,
        ready: false,
        error: null,
        data: null,
        loadingText: "Parsing listing…",
        access: buildAccessInfo(window.FBCO_STATE || {}),
        gated: Boolean(window.FBCO_STATE?.analysisGated),
        clearVehicle: true
      }
    );
  }
  updateAccessState().finally(() => {
    runUpdate();
    scheduleUpdate();
    setTimeout(() => runUpdate(), 700);
    // Extra passes for slow-loading pages (Facebook often renders content lazily)
    setTimeout(() => scheduleUpdate(), 2500);
    setTimeout(() => scheduleUpdate(), 5000);
  });

  window.addEventListener("pageshow", () => scheduleUpdate());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleUpdate();
  });

  if (getCheckoutPendingUntil()) {
    scheduleCheckoutPoll();
  }

  // FB is SPA: URL changes
  let lastUrl = location.href;
  function clearForNavigation() {
    if (window.FBCO_STATE) {
      window.FBCO_STATE.forceAnalysisNext = true;
      window.FBCO_STATE.dismissed = false;
      window.FBCO_STATE.analysisLoading = false;
      window.FBCO_STATE.analysisError = null;
      window.FBCO_STATE.lastSnapshotKey = null;
      window.FBCO_STATE.analysisRequestedKey = null;
      window.FBCO_STATE.analysisSeq += 1;
      window.FBCO_STATE.analysisReady = false;
      window.FBCO_STATE.lastVehicle = null;
      window.FBCO_STATE.lastAnalysis = null;
      window.FBCO_STATE.lastRenderKey = null;
      window.FBCO_STATE.suppressVehicleUntil = Date.now() + NAV_CLEAR_MS;
      window.FBCO_STATE.loadingPhase = "Parsing listing…";
    }
    window.FBCO_removeOverlay && window.FBCO_removeOverlay();
    if (window.FBCO_updateOverlay) {
      window.FBCO_updateOverlay(
        {},
        {
          loading: true,
          ready: false,
          error: null,
          data: null,
          loadingText: "Parsing listing…",
          access: buildAccessInfo(window.FBCO_STATE || {}),
          gated: Boolean(window.FBCO_STATE?.analysisGated),
          clearVehicle: true
        }
      );
    }
    runUpdate();
    setTimeout(() => runUpdate(), 250);
    setTimeout(() => runUpdate(), 900);
  }

  function onLocationPotentiallyChanged() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    clearForNavigation();
  }

  const originalPushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    const out = originalPushState(...args);
    onLocationPotentiallyChanged();
    return out;
  };

  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    const out = originalReplaceState(...args);
    onLocationPotentiallyChanged();
    return out;
  };

  window.addEventListener("popstate", onLocationPotentiallyChanged);
  window.addEventListener("hashchange", onLocationPotentiallyChanged);

  // DOM churn: schedule updates only (cheap)
  const obs = new MutationObserver(() => scheduleUpdate());
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
