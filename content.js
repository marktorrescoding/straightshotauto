(() => {
  const UPDATE_DEBOUNCE_MS = 900;
  const API_URL = "https://car-bot.car-bot.workers.dev/analyze";

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
    state.analysisError = null;
    state.lastAnalysis = null;
    state.analysisSeq += 1;
    const seq = state.analysisSeq;

    window.FBCO_updateOverlay(vehicle, {
      loading: true,
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
        about_items: vehicle.about_items
      })
    });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (seq !== state.analysisSeq) return;
      state.lastAnalysis = data;
    } catch (err) {
      if (seq !== state.analysisSeq) return;
      state.analysisError = err?.message || "Request failed";
    } finally {
      if (seq !== state.analysisSeq) return;
      state.analysisLoading = false;
      window.FBCO_updateOverlay(vehicle, {
        loading: state.analysisLoading,
        error: state.analysisError,
        data: state.lastAnalysis
      });
    }
  }

  function runUpdate() {
    const state = window.FBCO_STATE;
    if (!state) return;

    // If user closed overlay, don't recreate it.
    if (state.dismissed) return;

    // Avoid updating while user is selecting text inside overlay
    if (state.isUserSelecting) return;

    const vehicle = window.FBCO_extractVehicleSnapshot();
    window.FBCO_updateOverlay(vehicle, {
      loading: state.analysisLoading,
      error: state.analysisError,
      data: state.lastAnalysis
    });

    if (vehicle?.year && vehicle?.make) {
      requestAnalysis(vehicle);
    }
  }

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
      }

      scheduleUpdate();
    }
  }, 1000);

  // DOM churn: schedule updates only (cheap)
  const obs = new MutationObserver(() => scheduleUpdate());
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
