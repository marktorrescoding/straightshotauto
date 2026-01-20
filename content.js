(() => {
  const UPDATE_DEBOUNCE_MS = 900;

  function runUpdate() {
    const state = window.FBCO_STATE;
    if (!state) return;

    // If user closed overlay, don't recreate it.
    if (state.dismissed) return;

    // Avoid updating while user is selecting text inside overlay
    if (state.isUserSelecting) return;

    const vehicle = window.FBCO_extractVehicleSnapshot();
    window.FBCO_updateOverlay(vehicle);
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

      scheduleUpdate();
    }
  }, 1000);

  // DOM churn: schedule updates only (cheap)
  const obs = new MutationObserver(() => scheduleUpdate());
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
