(() => {
  if (window.top !== window.self) return;
  if (window.FBCO_CONTENT_LOADED) return;
  window.FBCO_CONTENT_LOADED = true;
  const UPDATE_DEBOUNCE_MS = 900;
  const API_URL = "https://car-bot.car-bot.workers.dev/analyze";
  const AUTH_STATUS_URL = "https://car-bot.car-bot.workers.dev/auth/status";
  const BILLING_CHECKOUT_URL = "https://car-bot.car-bot.workers.dev/billing/checkout";
  const AUTH_CALLBACK_URL = "https://car-bot.car-bot.workers.dev/auth/callback";
  const AUTH_SIGNUP_URL = "https://car-bot.car-bot.workers.dev/auth/signup";
  const SUPABASE_URL = "https://uluvqqypgdpsxzutojdd.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVsdXZxcXlwZ2Rwc3h6dXRvamRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAwNzY1MDgsImV4cCI6MjA4NTY1MjUwOH0.m49_Y868P0Vpw5vT3SuDDEXbsSN3VT80CMhPWP1HCH8";
  const FREE_LIMIT = 1;
  const AUTH_STORAGE_KEY = "fbco.auth.session.v1";
  const AUTH_EMAIL_KEY = "fbco.auth.email.v1";
  const FREE_COUNT_KEY = "fbco.free.count.v1";
  const FREE_KEY_KEY = "fbco.free.snapshot.v1";
  const FREE_DAY_KEY = "fbco.free.day.v1";
  const CHECKOUT_PENDING_KEY = "fbco.checkout.pending.v1";
  const AUTH_MODE = "password";
  const NAV_CLEAR_MS = 1500;
  let authHydrationPromise = null;

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
    return JSON.stringify({
      listing_id: normalizeListingId(vehicle.url),
      url: norm(vehicle.url),
      vin: norm(vehicle.vin),
      year: vehicle.year,
      make: norm(vehicle.make),
      model: norm(vehicle.model),
      trim: norm(vehicle.trim)
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
    return {
      authenticated: Boolean(state?.authSession?.access_token),
      validated: Boolean(state?.authValidated),
      freeCount,
      freeRemaining: Math.max(0, FREE_LIMIT - freeCount),
      email: state?.authSession?.user?.email || "",
      message: state?.authMessage || "",
      authMode: AUTH_MODE,
      lastEmail: window.FBCO_storage.get(AUTH_EMAIL_KEY, "")
    };
  }

  function loadAuthSession() {
    return window.FBCO_storage.get(AUTH_STORAGE_KEY, null);
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
          window.FBCO_storage.set(AUTH_STORAGE_KEY, data[AUTH_STORAGE_KEY] ?? null);
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
    const res = await fetch(AUTH_STATUS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json"
      }
    });
    if (!res.ok) return { authenticated: false };
    return res.json();
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

    const now = Date.now();
    const minIntervalMs = 10000;
    if (state.nextAnalyzeAt && now < state.nextAnalyzeAt) return;
    if (!opts.force && state.lastAnalyzeAt && now - state.lastAnalyzeAt < minIntervalMs) return;

    const session = await getValidSession();
    state.authSession = session;
    const authStatus = session ? await fetchAuthStatus(session) : { authenticated: false };
    state.authValidated = Boolean(authStatus?.validated);

    if (!opts.retry) state.analysisRetrying = false;

    state.freeCount = loadFreeCount();
    state.analysisGated = !state.authValidated && state.freeCount >= FREE_LIMIT;
    if (state.analysisGated) {
      state.analysisLoading = false;
      state.analysisReady = true;
      state.analysisError = "Free limit reached. Log in or subscribe to continue.";
      state.analysisErrorAt = Date.now();
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
        state.nextAnalyzeAt = Date.now() + Math.max(8, retryAfterSeconds) * 1000;
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const validatedHeader = res.headers.get("X-User-Validated");
      if (validatedHeader != null) {
        state.authValidated = validatedHeader === "true";
      }

      if (seq !== state.analysisSeq) return;
      state.lastAnalysis = data;
      const complete = isCompleteAnalysis(data);
      state.analysisReady = complete;

      const freeCount = loadFreeCount();
      const lastKey = loadLastFreeKey();
      if (!state.authValidated && complete) {
        if (lastKey !== key) {
          saveFreeCount(freeCount + 1);
          saveLastFreeKey(key);
        }
      }
      const updatedFree = loadFreeCount();
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
      if (seq !== state.analysisSeq) return;
      state.analysisLoading = state.analysisRetrying;
      if (!state.analysisRetrying) {
        state.loadingPhase = "";
      }
      clearTimeout(timeoutId);
      clearTimeout(phaseTimer);
      window.FBCO_ANALYZE_INFLIGHT = false;
      if (window.FBCO_ANALYZE_KEY === key) window.FBCO_ANALYZE_KEY = null;
      window.FBCO_updateOverlay(vehicle, {
        loading: !state.analysisReady,
        ready: state.analysisReady,
        error: state.analysisError,
        data: state.lastAnalysis,
        loadingText: state.loadingPhase,
        access: buildAccessInfo(state),
        gated: state.analysisGated
      });
    }
  }

  function runUpdate() {
    const state = window.FBCO_STATE;
    if (!state) return;

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
      el.value = text;
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

      el.textContent = text;
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" })
      );
      return true;
    } catch {
      document.execCommand("insertText", false, text);
      return true;
    }
  }

  async function updateAccessState() {
    const state = window.FBCO_STATE;
    const session = await getValidSession();
    state.authSession = session;
    const authStatus = session ? await fetchAuthStatus(session) : { authenticated: false };
    state.authValidated = Boolean(authStatus?.validated);
    if (state.authValidated) clearCheckoutPending();
    state.freeCount = loadFreeCount();
    state.analysisGated = !state.authValidated && state.freeCount >= FREE_LIMIT;
  }

  window.FBCO_authLogin = async function (email, password) {
    const state = window.FBCO_STATE;
    state.authMessage = "Signing in...";
    try {
      const session = await loginWithPassword(email, password);
      state.authSession = session;
      state.authMessage = "Signed in.";
    } catch (err) {
      state.authMessage = err?.message || "Unable to sign in.";
    }
    await updateAccessState();
    scheduleUpdate();
  };

  window.FBCO_authLogout = async function () {
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

  const scheduleUpdate = window.FBCO_debounce(runUpdate, UPDATE_DEBOUNCE_MS);

  // Initial run
  updateAccessState().finally(() => scheduleUpdate());

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
    }
    window.FBCO_removeOverlay && window.FBCO_removeOverlay();
    runUpdate();
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
  setInterval(onLocationPotentiallyChanged, 250);

  // DOM churn: schedule updates only (cheap)
  const obs = new MutationObserver(() => scheduleUpdate());
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
