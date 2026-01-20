(() => {
  const UPDATE_DEBOUNCE_MS = 900;
  const API_URL = "https://car-bot.car-bot.workers.dev/analyze";

  function isItemPage() {
    return /\/marketplace\/item\//.test(location.pathname);
  }

  function buildSnapshotKey(vehicle) {
    if (!vehicle) return null;
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

  async function requestAnalysis(vehicle) {
    const state = window.FBCO_STATE;
    if (!vehicle) return;

    const key = buildSnapshotKey(vehicle);
    if (!key) return;

    if (state.lastSnapshotKey === key && (state.analysisLoading || state.lastAnalysis || state.analysisError)) {
      return;
    }

    state.lastSnapshotKey = key;
    state.analysisLoading = true;
    if (!state.analysisReady) {
      state.analysisReady = false;
      state.lastAnalysis = null;
    }
    state.analysisError = null;
    state.analysisSeq += 1;
    const seq = state.analysisSeq;

    window.FBCO_updateOverlay(vehicle, {
      loading: !state.analysisReady,
      ready: state.analysisReady,
      error: null,
      data: null
    });

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      state.analysisReady = true;
    } catch (err) {
      if (seq !== state.analysisSeq) return;
      state.analysisError = err?.message || "Request failed";
      state.analysisReady = true;
    } finally {
      if (seq !== state.analysisSeq) return;
      state.analysisLoading = false;
      window.FBCO_updateOverlay(vehicle, {
        loading: !state.analysisReady,
        ready: state.analysisReady,
        error: state.analysisError,
        data: state.lastAnalysis
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
        data: state.lastAnalysis
      });
    }

    if (vehicle?.is_vehicle === false) {
      window.FBCO_removeOverlay && window.FBCO_removeOverlay();
      return;
    }

    if (vehicle?.year && vehicle?.make) {
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

  const scheduleUpdate = window.FBCO_debounce(runUpdate, UPDATE_DEBOUNCE_MS);

  // Initial run
  scheduleUpdate();

  // FB is SPA: URL changes
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;

      // New listing / navigation: allow overlay again
      if (window.FBCO_STATE) window.FBCO_STATE.dismissed = false;
      if (window.FBCO_STATE) {
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
