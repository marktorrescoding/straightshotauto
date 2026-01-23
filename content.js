(() => {
  const UPDATE_DEBOUNCE_MS = 900;
  const API_URL = "https://car-bot.car-bot.workers.dev/analyze";

  function isItemPage() {
    return /\/marketplace\/item\//.test(location.pathname);
  }

  function buildSnapshotKey(vehicle) {
    if (!vehicle) return null;
    if (!vehicle.year || !vehicle.make) return null;
    return JSON.stringify({
      url: vehicle.url,
      year: vehicle.year,
      make: vehicle.make,
      model: vehicle.model,
      price_usd: vehicle.price_usd,
      mileage_miles: vehicle.mileage_miles,
      source_text: vehicle.source_text,
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
      seller_description: vehicle.seller_description
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

  async function requestAnalysis(vehicle, opts = {}) {
    const state = window.FBCO_STATE;
    if (!vehicle) return;

    const key = buildSnapshotKey(vehicle);
    if (!key) return;

    state.analysisRetrying = false;

    if (
      !opts.force &&
      state.lastSnapshotKey === key &&
      (state.analysisLoading || state.lastAnalysis || state.analysisError)
    ) {
      return;
    }

    const isNewSnapshot = state.lastSnapshotKey && state.lastSnapshotKey !== key;
    state.lastSnapshotKey = key;
    state.analysisLoading = true;
    state.loadingPhase = "Analyzing model…";
    if (isNewSnapshot) {
      state.analysisReady = false;
      state.lastAnalysis = null;
    }
    state.analysisError = null;
    state.analysisSeq += 1;
    const seq = state.analysisSeq;

    window.FBCO_updateOverlay(vehicle, {
      loading: true,
      ready: state.analysisReady,
      error: null,
      data: state.lastAnalysis,
      loadingText: state.loadingPhase
    });

    const phaseTimer = setTimeout(() => {
      if (window.FBCO_STATE.analysisLoading) {
        window.FBCO_STATE.loadingPhase = "Building checklist…";
        window.FBCO_updateOverlay(vehicle, {
          loading: true,
          ready: window.FBCO_STATE.analysisReady,
          error: window.FBCO_STATE.analysisError,
          data: window.FBCO_STATE.lastAnalysis,
          loadingText: window.FBCO_STATE.loadingPhase
        });
      }
    }, 3500);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          url: vehicle.url,
          source_text: vehicle.source_text,
          year: vehicle.year,
        make: vehicle.make,
        model: vehicle.model,
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
        is_vehicle: vehicle.is_vehicle
        })
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (seq !== state.analysisSeq) return;
      state.lastAnalysis = data;
      const complete = isCompleteAnalysis(data);
      state.analysisReady = complete;

      if (!complete) {
        const retryKey = key;
        if (state.analysisRetryKey !== retryKey) {
          state.analysisRetryKey = retryKey;
          state.analysisRetryCount = 0;
        }
        state.analysisRetryCount = (state.analysisRetryCount || 0) + 1;
        if (state.analysisRetryCount <= 4) {
          state.analysisRetrying = true;
          state.loadingPhase = "Retrying analysis…";
          setTimeout(() => {
            requestAnalysis(vehicle, { force: true });
          }, 1200);
        } else {
          state.analysisRetrying = false;
          state.analysisError = "Incomplete response";
          state.analysisErrorAt = Date.now();
          state.analysisReady = true;
        }
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
      window.FBCO_updateOverlay(vehicle, {
        loading: !state.analysisReady,
        ready: state.analysisReady,
        error: state.analysisError,
        data: state.lastAnalysis,
        loadingText: state.loadingPhase
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

    if (state.lastVehicle) {
      const merged = { ...state.lastVehicle };
      Object.entries(vehicle || {}).forEach(([key, value]) => {
        if (value !== null && value !== undefined && value !== "") merged[key] = value;
      });
      vehicle = merged;
    }

    if (vehicle?.year && vehicle?.make) {
      state.lastVehicle = vehicle;
    }

    const snapshotKey = vehicle ? buildSnapshotKey(vehicle) : null;
    if (snapshotKey && snapshotKey !== state.lastSnapshotKey) {
      state.analysisReady = false;
      state.analysisError = null;
      state.lastAnalysis = null;
      state.analysisRetryKey = snapshotKey;
      state.analysisRetryCount = 0;
      state.analysisRetrying = false;
      state.analysisErrorAt = null;
      state.analysisLoading = true;
      state.loadingPhase = "Analyzing model…";
      state.lastRenderKey = null;
    }

    const renderKey = JSON.stringify({
      vehicle,
      ready: state.analysisReady,
      error: state.analysisError,
      data: state.lastAnalysis
    });
    if (renderKey !== state.lastRenderKey) {
      state.lastRenderKey = renderKey;
      window.FBCO_updateOverlay(vehicle, {
        loading: !state.analysisReady,
        ready: state.analysisReady,
        error: state.analysisError,
        data: state.lastAnalysis,
        loadingText: state.loadingPhase
      });
    }

    if (vehicle?.is_vehicle === false) {
      window.FBCO_removeOverlay && window.FBCO_removeOverlay();
      return;
    }

    if (vehicle?.year && vehicle?.make) {
      if (state.analysisError && !state.lastAnalysis && !state.analysisLoading) {
        const lastErrAt = state.analysisErrorAt || 0;
        if (Date.now() - lastErrAt > 4000) {
          state.analysisError = null;
          state.analysisReady = false;
          state.analysisLoading = true;
          state.loadingPhase = "Retrying analysis…";
          requestAnalysis(vehicle, { force: true });
          return;
        }
      }
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

  window.FBCO_insertMessage = insertMessage;
  window.FBCO_requestRefresh = function () {
    const state = window.FBCO_STATE;
    if (!state) return;
    state.analysisSeq += 1;
    state.lastSnapshotKey = null;
    state.analysisLoading = false;
    state.analysisError = null;
    state.lastAnalysis = null;
    state.analysisReady = false;
    state.analysisRetrying = false;
    state.lastRenderKey = null;
    state.lastVehicle = null;
    state.loadingPhase = "Parsing listing…";
    runUpdate();
  };

  const scheduleUpdate = window.FBCO_debounce(runUpdate, UPDATE_DEBOUNCE_MS);

  // Initial run
  scheduleUpdate();

  window.addEventListener("pageshow", () => scheduleUpdate());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleUpdate();
  });

  // FB is SPA: URL changes
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;

      if (window.FBCO_STATE) {
        window.FBCO_STATE.forceAnalysisNext = true;
        window.FBCO_STATE.dismissed = false;
        window.FBCO_STATE.analysisLoading = false;
        window.FBCO_STATE.analysisError = null;
        window.FBCO_STATE.lastAnalysis = null;
        window.FBCO_STATE.lastSnapshotKey = null;
        window.FBCO_STATE.analysisSeq += 1;
        window.FBCO_STATE.analysisReady = false;
        window.FBCO_STATE.lastVehicle = null;
        window.FBCO_STATE.lastRenderKey = null;
      }

      window.FBCO_removeOverlay && window.FBCO_removeOverlay();
      scheduleUpdate();
    }
  }, 1000);

  // DOM churn: schedule updates only (cheap)
  const obs = new MutationObserver(() => scheduleUpdate());
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
