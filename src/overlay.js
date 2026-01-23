(() => {
  const { overlayId } = window.FBCO_STATE;

  const STORE_KEY = "fbco.overlay.state.v6";
  const DEFAULT_STATE = {
    top: 16,
    left: 16,
    right: null,
    width: 360,
    height: 200,
    minimized: false
  };

  const MIN_W = 280;
  const MIN_H = 140;

  function loadOverlayState() {
    const saved = window.FBCO_storage.get(STORE_KEY, null);
    const st = { ...DEFAULT_STATE, ...(saved || {}) };

    // sanitize
    st.width = Math.max(MIN_W, st.width || DEFAULT_STATE.width);
    st.height = Math.max(MIN_H, st.height || DEFAULT_STATE.height);

    return st;
  }

  function saveOverlayState(state) {
    window.FBCO_storage.set(STORE_KEY, state);
  }

  function applyOverlayState(root, state) {
    const maxW = Math.max(MIN_W, window.innerWidth - 24);
    const maxH = Math.max(MIN_H, window.innerHeight - 24);

    state.width = clamp(state.width, MIN_W, maxW);
    state.height = clamp(state.height, MIN_H, maxH);

    root.style.top = `${state.top}px`;

    if (state.left == null) {
      root.style.left = "auto";
      root.style.right = `${state.right ?? 16}px`;
    } else {
      root.style.right = "auto";
      root.style.left = `${state.left}px`;
    }

    // Toggle minimized UI via data attribute
    root.dataset.minimized = state.minimized ? "1" : "0";

    if (state.minimized) {
      // icon mode: fixed small footprint
      root.style.width = "56px";
      root.style.height = "56px";
      root.style.resize = "none";
      root.style.overflow = "visible";
    } else {
      root.style.width = `${state.width}px`;
      root.style.height = `${state.height}px`;
      root.style.resize = "both";
      root.style.overflow = "auto";
    }
  }

  function clamp(n, min, max) {
    return Math.min(Math.max(n, min), max);
  }

  function removeOverlay() {
    const el = document.getElementById(overlayId);
    if (window.FBCO_STATE._cleanupFns) {
      window.FBCO_STATE._cleanupFns.forEach((fn) => {
        try {
          fn();
        } catch {}
      });
      window.FBCO_STATE._cleanupFns = null;
    }
    if (el) el.remove();
  }
  window.FBCO_removeOverlay = removeOverlay;

  function ensureOverlay() {
    if (window.FBCO_STATE.dismissed) return null;

    let root = document.getElementById(overlayId);
    if (root) return root;

    const state = loadOverlayState();

    root = document.createElement("div");
    root.id = overlayId;

    root.innerHTML = `
      <div class="fbco-panel" id="fbco-panel" role="dialog" aria-label="Car Spotter">
        <div class="fbco-header" id="fbco-drag-handle">
          <div class="fbco-title">
            <img id="fbco-title-icon" class="fbco-title-icon" alt="Car Spotter" />
            <div class="fbco-title-text">
              <div class="fbco-title-name">StraightShot Auto</div>
              <div class="fbco-title-sub">Used car snapshot</div>
            </div>
          </div>
          <div class="fbco-actions">
            <button id="fbco-refresh" class="fbco-icon-btn" type="button" aria-label="Refresh" title="Refresh">↻</button>
            <button id="fbco-minimize" class="fbco-icon-btn" type="button" aria-label="Minimize" title="Minimize">–</button>
            <button id="fbco-close" class="fbco-icon-btn" type="button" aria-label="Close" title="Close">×</button>
          </div>
        </div>

        <div class="fbco-body" id="fbco-body">
          <div class="fbco-loading" id="fbco-loading">
            <div class="fbco-loading-spinner" aria-hidden="true"></div>
            <div class="fbco-loading-text" id="fbco-loading-text">Analyzing…</div>
          </div>

          <div class="fbco-error" id="fbco-error" role="status" aria-live="polite"></div>

          <div class="fbco-card fbco-card-primary" id="fbco-summary-card">
            <div class="fbco-card-header">
              <div class="fbco-vehicle-title" id="fbco-vehicle-title">—</div>
              <div class="fbco-badges">
                <span id="fbco-score-badge" class="fbco-badge">--</span>
                <span id="fbco-confidence-badge" class="fbco-badge fbco-badge-muted">--</span>
                <span id="fbco-verdict-badge" class="fbco-badge fbco-badge-muted">Verdict</span>
              </div>
            </div>
            <div class="fbco-meta-row">
              <div class="fbco-meta-item">
                <span>Price</span>
                <strong id="fbco-meta-price">—</strong>
              </div>
              <div class="fbco-meta-item">
                <span>Mileage</span>
                <strong id="fbco-meta-mileage">—</strong>
              </div>
              <div class="fbco-meta-item">
                <span>Title</span>
                <strong id="fbco-meta-title-status">—</strong>
              </div>
            </div>
            <div class="fbco-assumption" id="fbco-assumption">
              This assessment assumes no major undisclosed damage. A pre-purchase inspection is still recommended.
            </div>
            <div class="fbco-summary-block" id="fbco-summary-block">
              <div class="fbco-section-label">Summary</div>
              <div id="fbco-summary" class="fbco-text">—</div>
            </div>
            <div class="fbco-summary-block" id="fbco-verdict-block">
              <div class="fbco-section-label">Final verdict</div>
              <div id="fbco-final-verdict" class="fbco-text">—</div>
            </div>
          </div>

          <div class="fbco-tags" id="fbco-analysis-tags"></div>

          <div class="fbco-accordion" id="fbco-acc-overview">
            <button class="fbco-accordion-toggle" type="button" data-target="fbco-overview-body" aria-expanded="false">
              <span>Overview</span>
              <span class="fbco-accordion-icon">▾</span>
            </button>
            <div id="fbco-overview-body" class="fbco-accordion-body" hidden>
              <div class="fbco-kv" id="fbco-kv-rep">
                <span>Year/model reputation</span>
                <div id="fbco-year-rep" class="fbco-text">—</div>
              </div>
              <div class="fbco-kv" id="fbco-kv-lifespan">
                <span>Remaining lifespan</span>
                <div id="fbco-lifespan" class="fbco-text">—</div>
              </div>
              <div class="fbco-kv" id="fbco-kv-daily">
                <span>Daily vs project</span>
                <div id="fbco-daily-project" class="fbco-text">—</div>
              </div>
              <div class="fbco-kv" id="fbco-kv-skill">
                <span>Mechanical skill</span>
                <div id="fbco-skill" class="fbco-text">—</div>
              </div>
              <div class="fbco-kv" id="fbco-notes-block">
                <span>Notes</span>
                <div id="fbco-notes" class="fbco-text">—</div>
              </div>
            </div>
          </div>

          <div class="fbco-accordion" id="fbco-acc-maintenance">
            <button class="fbco-accordion-toggle" type="button" data-target="fbco-maintenance-body" aria-expanded="true">
              <span>Likely maintenance (6–18 months)</span>
              <span class="fbco-accordion-icon">▾</span>
            </button>
            <div id="fbco-maintenance-body" class="fbco-accordion-body">
              <ul id="fbco-analysis-maintenance" class="fbco-list"></ul>
            </div>
          </div>

          <div class="fbco-accordion" id="fbco-acc-common">
            <button class="fbco-accordion-toggle" type="button" data-target="fbco-common-body" aria-expanded="false">
              <span>Common issues</span>
              <span class="fbco-accordion-icon">▾</span>
            </button>
            <div id="fbco-common-body" class="fbco-accordion-body" hidden>
              <ul id="fbco-analysis-issues" class="fbco-list"></ul>
            </div>
          </div>

          <div class="fbco-accordion" id="fbco-acc-wear">
            <button class="fbco-accordion-toggle" type="button" data-target="fbco-wear-body" aria-expanded="false">
              <span>Wear items</span>
              <span class="fbco-accordion-icon">▾</span>
            </button>
            <div id="fbco-wear-body" class="fbco-accordion-body" hidden>
              <ul id="fbco-analysis-wear" class="fbco-list"></ul>
            </div>
          </div>

          <div class="fbco-accordion" id="fbco-acc-upsides">
            <button class="fbco-accordion-toggle" type="button" data-target="fbco-upsides-body" aria-expanded="false">
              <span>✅ Upsides</span>
              <span class="fbco-accordion-icon">▾</span>
            </button>
            <div id="fbco-upsides-body" class="fbco-accordion-body" hidden>
              <ul id="fbco-analysis-upsides" class="fbco-list fbco-list-good"></ul>
            </div>
          </div>

          <div class="fbco-accordion" id="fbco-acc-risk">
            <button class="fbco-accordion-toggle" type="button" data-target="fbco-risk-body" aria-expanded="false">
              <span>⚠️ Risk flags</span>
              <span class="fbco-accordion-icon">▾</span>
            </button>
            <div id="fbco-risk-body" class="fbco-accordion-body" hidden>
              <ul id="fbco-analysis-risks" class="fbco-list fbco-list-risk"></ul>
            </div>
          </div>

          <div class="fbco-accordion" id="fbco-acc-deal">
            <button class="fbco-accordion-toggle" type="button" data-target="fbco-deal-body" aria-expanded="false">
              <span>🛑 Deal breakers</span>
              <span class="fbco-accordion-icon">▾</span>
            </button>
            <div id="fbco-deal-body" class="fbco-accordion-body" hidden>
              <ul id="fbco-analysis-dealbreakers" class="fbco-list fbco-list-deal"></ul>
            </div>
          </div>

          <div class="fbco-accordion" id="fbco-acc-inspection">
            <button class="fbco-accordion-toggle" type="button" data-target="fbco-inspection-body" aria-expanded="false">
              <span>Inspection checklist</span>
              <span class="fbco-accordion-icon">▾</span>
            </button>
            <div id="fbco-inspection-body" class="fbco-accordion-body" hidden>
              <ul id="fbco-analysis-checklist" class="fbco-list"></ul>
            </div>
          </div>

          <div class="fbco-accordion" id="fbco-acc-questions">
            <button class="fbco-accordion-toggle" type="button" data-target="fbco-questions-body" aria-expanded="false">
              <span>Buyer questions</span>
              <span class="fbco-accordion-icon">▾</span>
            </button>
            <div id="fbco-questions-body" class="fbco-accordion-body" hidden>
              <ul id="fbco-analysis-questions" class="fbco-list fbco-list-pill"></ul>
            </div>
          </div>

          <div class="fbco-accordion" id="fbco-acc-market">
            <button class="fbco-accordion-toggle" type="button" data-target="fbco-market-body" aria-expanded="false">
              <span>Market value & price opinion</span>
              <span class="fbco-accordion-icon">▾</span>
            </button>
            <div id="fbco-market-body" class="fbco-accordion-body" hidden>
              <div class="fbco-kv">
                <span>Market value</span>
                <div id="fbco-analysis-market" class="fbco-text">—</div>
              </div>
              <div class="fbco-kv">
                <span>Price opinion</span>
                <div id="fbco-analysis-price" class="fbco-text">—</div>
              </div>
            </div>
          </div>

          <div class="fbco-accordion" id="fbco-acc-details">
            <button class="fbco-accordion-toggle" type="button" data-target="fbco-details-body" aria-expanded="false">
              <span>Listing details</span>
              <span class="fbco-accordion-icon">▾</span>
            </button>
            <div id="fbco-details-body" class="fbco-accordion-body" hidden>
            <div class="fbco-row">
              <div class="fbco-label">Parsed</div>
              <div class="fbco-val"><span id="fbco-parsed-value" class="fbco-value">Detecting…</span></div>
            </div>

            <div class="fbco-row">
              <div class="fbco-label">Price</div>
              <div class="fbco-val"><span id="fbco-price-value" class="fbco-value">Detecting…</span></div>
            </div>

            <div class="fbco-row">
              <div class="fbco-label">Mileage</div>
              <div class="fbco-val"><span id="fbco-mileage-value" class="fbco-value">Detecting…</span></div>
            </div>

            <div class="fbco-row fbco-row-wide">
              <div class="fbco-label">Source</div>
              <div class="fbco-val"><span id="fbco-raw-value" class="fbco-value">(not found)</span></div>
            </div>

            <div class="fbco-divider"></div>

            <div class="fbco-row">
              <div class="fbco-label">Transmission</div>
              <div class="fbco-val"><span id="fbco-transmission" class="fbco-value">(not found)</span></div>
            </div>

            <div class="fbco-row">
              <div class="fbco-label">Drivetrain</div>
              <div class="fbco-val"><span id="fbco-drivetrain" class="fbco-value">(not found)</span></div>
            </div>

            <div class="fbco-row">
              <div class="fbco-label">Fuel</div>
              <div class="fbco-val"><span id="fbco-fuel" class="fbco-value">(not found)</span></div>
            </div>

            <div class="fbco-row">
              <div class="fbco-label">Colors</div>
              <div class="fbco-val"><span id="fbco-colors" class="fbco-value">(not found)</span></div>
            </div>

            <div class="fbco-row">
              <div class="fbco-label">MPG</div>
              <div class="fbco-val"><span id="fbco-mpg" class="fbco-value">(not found)</span></div>
            </div>

            <div class="fbco-row">
              <div class="fbco-label">NHTSA</div>
              <div class="fbco-val"><span id="fbco-nhtsa" class="fbco-value">(not found)</span></div>
            </div>

            <div class="fbco-row">
              <div class="fbco-label">Title</div>
              <div class="fbco-val"><span id="fbco-title-status" class="fbco-value">(not found)</span></div>
            </div>

            <div class="fbco-row">
              <div class="fbco-label">Paid off</div>
              <div class="fbco-val"><span id="fbco-paid-off" class="fbco-value">(not found)</span></div>
            </div>

            <div class="fbco-row">
              <div class="fbco-label">VIN</div>
              <div class="fbco-val"><span id="fbco-vin" class="fbco-value">(not found)</span></div>
            </div>

            <div class="fbco-block">
              <div class="fbco-label">Seller notes</div>
              <div id="fbco-seller-notes" class="fbco-note">(not found)</div>
            </div>
          </div>

          <div class="fbco-disclaimer">
            For safety and financial decisions, do your own research and inspection.
          </div>
        </div>
      </div>

      <!-- Minimized icon -->
      <button class="fbco-mini" id="fbco-mini" type="button" title="Show car info" aria-label="Show car info">
        <img id="fbco-mini-icon" class="fbco-mini-icon" alt="Car Spotter" />
      </button>
    `;

    document.body.appendChild(root);

    const titleIcon = root.querySelector("#fbco-title-icon");
    const miniIcon = root.querySelector("#fbco-mini-icon");
    const setIcons = () => {
      try {
        const runtime = globalThis.chrome?.runtime;
        if (!runtime?.getURL) return;
        const iconUrl = runtime.getURL("assets/icon128.png");
        if (titleIcon) titleIcon.src = iconUrl;
        if (miniIcon) miniIcon.src = iconUrl;
      } catch {
        // Extension context can be invalidated during reloads; ignore and continue.
      }
    };
    setIcons();

    const cleanupFns = [];

    // Only stop propagation for non-pointer events.
    // Pointer events are used for drag and must work reliably.
    ["click", "dblclick", "contextmenu", "keydown", "keyup"].forEach((evt) => {
      const handler = (e) => e.stopPropagation();
      root.addEventListener(evt, handler, false);
      cleanupFns.push(() => root.removeEventListener(evt, handler, false));
    });

    const clickHandler = (e) => {
      const target = e.target;
      if (!target) return;
      const btn = target.closest("[data-fbco-message]");
      if (!btn) return;
      const message = btn.dataset.fbcoMessage;
      if (!message) return;
      window.FBCO_insertMessage && window.FBCO_insertMessage(message);
    };
    root.addEventListener("click", clickHandler);
    cleanupFns.push(() => root.removeEventListener("click", clickHandler));

    // Selecting value pills pauses updates
    const pointerDownHandler = (e) => {
      const t = e.target;
      if (t && t.classList && t.classList.contains("fbco-value")) {
        window.FBCO_STATE.isUserSelecting = true;
      } else {
        window.FBCO_STATE.isUserSelecting = false;
      }
    };
    root.addEventListener("pointerdown", pointerDownHandler);
    cleanupFns.push(() => root.removeEventListener("pointerdown", pointerDownHandler));

    const pointerUpHandler = () => {
      window.FBCO_STATE.isUserSelecting = false;
    };
    window.addEventListener("pointerup", pointerUpHandler, true);
    window.addEventListener("pointercancel", pointerUpHandler, true);
    cleanupFns.push(() => window.removeEventListener("pointerup", pointerUpHandler, true));
    cleanupFns.push(() => window.removeEventListener("pointercancel", pointerUpHandler, true));

    // Close
    const closeBtn = root.querySelector("#fbco-close");
    const onClose = (e) => {
      e.stopPropagation();
      window.FBCO_STATE.dismissed = true;
      removeOverlay();
    };
    closeBtn?.addEventListener("click", onClose);
    if (closeBtn) cleanupFns.push(() => closeBtn.removeEventListener("click", onClose));

    // Minimize (icon mode)
    const minimizeBtn = root.querySelector("#fbco-minimize");
    const onMinimize = (e) => {
      e.stopPropagation();
      const st = loadOverlayState();
      st.minimized = true;
      saveOverlayState(st);
      applyOverlayState(root, st);
    };
    minimizeBtn?.addEventListener("click", onMinimize);
    if (minimizeBtn) cleanupFns.push(() => minimizeBtn.removeEventListener("click", onMinimize));

    const refreshBtn = root.querySelector("#fbco-refresh");
    const onRefresh = (e) => {
      e.stopPropagation();
      window.FBCO_requestRefresh && window.FBCO_requestRefresh();
    };
    refreshBtn?.addEventListener("click", onRefresh);
    if (refreshBtn) cleanupFns.push(() => refreshBtn.removeEventListener("click", onRefresh));

    const accordionToggles = Array.from(root.querySelectorAll(".fbco-accordion-toggle"));
    accordionToggles.forEach((btn) => {
      const targetId = btn.getAttribute("data-target");
      if (!targetId) return;
      const body = root.querySelector(`#${targetId}`);
      if (!body) return;
      const setOpen = (open) => {
        body.hidden = !open;
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        const icon = btn.querySelector(".fbco-accordion-icon");
        if (icon) icon.textContent = open ? "▴" : "▾";
      };
      setOpen(btn.getAttribute("aria-expanded") === "true");
      const onToggle = (e) => {
        e.stopPropagation();
        const open = btn.getAttribute("aria-expanded") !== "true";
        setOpen(open);
      };
      btn.addEventListener("click", onToggle);
      cleanupFns.push(() => btn.removeEventListener("click", onToggle));
    });

    // Restore from icon
    const miniBtn = root.querySelector("#fbco-mini");
    const onRestore = (e) => {
      e.stopPropagation();
      const st = loadOverlayState();
      st.minimized = false;
      saveOverlayState(st);
      applyOverlayState(root, st);

      // Force a refresh of values immediately on restore
      const v = window.FBCO_extractVehicleSnapshot();
      window.FBCO_updateOverlay(v, {
        loading: window.FBCO_STATE.analysisLoading,
        error: window.FBCO_STATE.analysisError,
        data: window.FBCO_STATE.lastAnalysis
      });
    };
    miniBtn?.addEventListener("click", onRestore);
    if (miniBtn) cleanupFns.push(() => miniBtn.removeEventListener("click", onRestore));

    // Drag: allow dragging in both modes (use header when open, icon when minimized)
    const dragCleanup = installPointerDrag(root);
    const resizeCleanup = installResizePersistence(root);
    if (dragCleanup) cleanupFns.push(dragCleanup);
    if (resizeCleanup) cleanupFns.push(resizeCleanup);

    applyOverlayState(root, state);
    window.FBCO_STATE._cleanupFns = cleanupFns;

    return root;
  }

  function installPointerDrag(root) {
    const handle = root.querySelector("#fbco-drag-handle");
    const miniBtn = root.querySelector("#fbco-mini");

    // Active drag target depends on state
    function getDragTarget() {
      const st = loadOverlayState();
      return st.minimized ? miniBtn : handle;
    }

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startTop = 0;
    let startLeft = 0;
    let activeTarget = null;

    function onPointerDown(e) {
      // left click only
      if (e.button !== 0) return;

      // If full mode and clicking buttons, don't drag
      if (!loadOverlayState().minimized) {
        if (e.target && e.target.closest && e.target.closest("button")) return;
      }

      activeTarget = getDragTarget();
      if (!activeTarget) return;

      dragging = true;

      const rect = root.getBoundingClientRect();
      startTop = rect.top;
      startLeft = rect.left;

      startX = e.clientX;
      startY = e.clientY;

      activeTarget.setPointerCapture(e.pointerId);
      document.body.style.userSelect = "none";
    }

    function onPointerMove(e) {
      if (!dragging) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const newTop = clamp(startTop + dy, 8, Math.max(8, window.innerHeight - 60));
      const newLeft = clamp(startLeft + dx, 8, Math.max(8, window.innerWidth - 60));

      const st = loadOverlayState();
      st.top = Math.round(newTop);
      st.left = Math.round(newLeft);
      st.right = null;

      saveOverlayState(st);
      applyOverlayState(root, st);
    }

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;

      try {
        activeTarget && activeTarget.releasePointerCapture(e.pointerId);
      } catch {}

      activeTarget = null;
      document.body.style.userSelect = "";
      window.FBCO_STATE.isUserSelecting = false;
    }

    // Attach listeners to both potential drag targets
    if (handle) {
      handle.style.cursor = "move";
      handle.addEventListener("pointerdown", onPointerDown);
      handle.addEventListener("pointermove", onPointerMove);
      handle.addEventListener("pointerup", endDrag);
      handle.addEventListener("pointercancel", endDrag);
    }

    if (miniBtn) {
      miniBtn.style.cursor = "move";
      miniBtn.addEventListener("pointerdown", onPointerDown);
      miniBtn.addEventListener("pointermove", onPointerMove);
      miniBtn.addEventListener("pointerup", endDrag);
      miniBtn.addEventListener("pointercancel", endDrag);
    }

    // Extra safety
    window.addEventListener("pointerup", endDrag, true);
    window.addEventListener("pointercancel", endDrag, true);

    return () => {
      if (handle) {
        handle.removeEventListener("pointerdown", onPointerDown);
        handle.removeEventListener("pointermove", onPointerMove);
        handle.removeEventListener("pointerup", endDrag);
        handle.removeEventListener("pointercancel", endDrag);
      }
      if (miniBtn) {
        miniBtn.removeEventListener("pointerdown", onPointerDown);
        miniBtn.removeEventListener("pointermove", onPointerMove);
        miniBtn.removeEventListener("pointerup", endDrag);
        miniBtn.removeEventListener("pointercancel", endDrag);
      }
      window.removeEventListener("pointerup", endDrag, true);
      window.removeEventListener("pointercancel", endDrag, true);
    };
  }

  function installResizePersistence(root) {
    let lastW = Math.round(root.getBoundingClientRect().width);
    let lastH = Math.round(root.getBoundingClientRect().height);

    const intervalId = setInterval(() => {
      if (!document.getElementById(overlayId)) return;

      const st = loadOverlayState();
      if (st.minimized) return;

      const rect = root.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);

      if (Math.abs(w - lastW) >= 6 || Math.abs(h - lastH) >= 6) {
        lastW = w;
        lastH = h;

        st.width = Math.max(MIN_W, w);
        st.height = Math.max(MIN_H, h);

        saveOverlayState(st);
        applyOverlayState(root, st);
      }
    }, 600);

    return () => clearInterval(intervalId);
  }


  function stringifyIssue(issue) {
    if (!issue) return null;
    if (typeof issue === "string") return issue;
    const parts = [];
    if (issue.issue) parts.push(issue.issue);
    if (issue.typical_failure_mileage) parts.push(`Mileage: ${issue.typical_failure_mileage}`);
    if (issue.severity) parts.push(`Severity: ${issue.severity}`);
    if (issue.estimated_cost_diy) parts.push(`DIY: ${issue.estimated_cost_diy}`);
    if (issue.estimated_cost_shop) parts.push(`Shop: ${issue.estimated_cost_shop}`);
    if (issue.estimated_cost) parts.push(`Cost: ${issue.estimated_cost}`);
    if (issue.cost_range) parts.push(`Cost: ${issue.cost_range}`);
    return parts.length ? parts.join(" • ") : null;
  }

  function stringifyMaintenance(item) {
    if (!item) return null;
    if (typeof item === "string") return item;
    const parts = [];
    if (item.item) parts.push(item.item);
    if (item.typical_mileage_range) parts.push(`Mileage: ${item.typical_mileage_range}`);
    if (item.why_it_matters) parts.push(item.why_it_matters);
    if (item.estimated_cost_diy) parts.push(`DIY: ${item.estimated_cost_diy}`);
    if (item.estimated_cost_shop) parts.push(`Shop: ${item.estimated_cost_shop}`);
    return parts.length ? parts.join(" • ") : null;
  }

  function setVisible(el, visible) {
    if (!el) return;
    el.style.display = visible ? "" : "none";
  }

  function isMeaningfulText(value) {
    if (value == null) return false;
    const trimmed = String(value).trim();
    if (!trimmed) return false;
    return !["(none)", "—", "unknown", "not found", "not available"].includes(trimmed.toLowerCase());
  }

  function setText(el, value, wrapper) {
    const text = isMeaningfulText(value) ? String(value).trim() : "";
    if (el) el.textContent = text || "—";
    if (wrapper) setVisible(wrapper, Boolean(text));
    return Boolean(text);
  }

  function setTextAlways(el, value, wrapper) {
    const text = isMeaningfulText(value) ? String(value).trim() : "";
    if (el) el.textContent = text || "—";
    if (wrapper) setVisible(wrapper, true);
    return Boolean(text);
  }

  function renderList(el, items, mapFn, opts) {
    if (!el) return;
    el.innerHTML = "";
    if (!items || !items.length) {
      setVisible(opts?.wrapper, false);
      return;
    }
    setVisible(opts?.wrapper, true);
    items.forEach((item) => {
      const text = mapFn ? mapFn(item) : typeof item === "string" ? item : JSON.stringify(item);
      if (!text) return;
      const li = document.createElement("li");
      if (opts?.clickable) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "fbco-btn-chip";
        let displayText = text;
        let messageText = text;
        let showDollar = false;
        if (text.startsWith("💵")) {
          displayText = text.replace(/^💵\s*/, "");
          messageText = displayText;
          showDollar = true;
        } else if (text.startsWith("$")) {
          displayText = text.replace(/^\$\s*/, "");
          messageText = displayText;
          showDollar = true;
        }
        if (showDollar) {
          const icon = document.createElement("span");
          icon.className = "fbco-chip-icon";
          icon.textContent = "$";
          btn.appendChild(icon);
        }
        const label = document.createElement("span");
        label.textContent = displayText;
        btn.appendChild(label);
        btn.dataset.fbcoMessage = messageText;
        li.appendChild(btn);
      } else {
        li.textContent = text;
      }
      el.appendChild(li);
    });
  }

  function renderTags(el, items) {
    if (!el) return;
    el.innerHTML = "";
    if (!items || !items.length) {
      setVisible(el, false);
      return;
    }
    setVisible(el, true);
    items.forEach((item) => {
      if (!item) return;
      const span = document.createElement("span");
      span.className = "fbco-tag";
      span.textContent = item;
      el.appendChild(span);
    });
  }

  function scoreLabel(score) {
    if (score == null) return null;
    if (score < 15) return { label: "❌ No", tone: "no" };
    if (score < 35) return { label: "⚠️ Risky", tone: "risky" };
    if (score < 55) return { label: "⚖️ Fair", tone: "fair" };
    if (score < 72) return { label: "👍 Good", tone: "good" };
    if (score < 88) return { label: "💎 Great", tone: "great" };
    return { label: "🚀 Steal", tone: "steal" };
  }

  window.FBCO_updateOverlay = function (vehicle, analysisState) {
    const root = ensureOverlay();
    if (!root) return;

    const st = loadOverlayState();
    applyOverlayState(root, st);

    // If minimized, don't waste time updating hidden DOM
    if (st.minimized) return;

    const parsedValEl = document.getElementById("fbco-parsed-value");
    const rawValEl = document.getElementById("fbco-raw-value");
    const priceValEl = document.getElementById("fbco-price-value");
    const mileageValEl = document.getElementById("fbco-mileage-value");
    const transmissionEl = document.getElementById("fbco-transmission");
    const drivetrainEl = document.getElementById("fbco-drivetrain");
    const fuelEl = document.getElementById("fbco-fuel");
    const colorsEl = document.getElementById("fbco-colors");
    const mpgEl = document.getElementById("fbco-mpg");
    const nhtsaEl = document.getElementById("fbco-nhtsa");
    const titleStatusEl = document.getElementById("fbco-title-status");
    const paidOffEl = document.getElementById("fbco-paid-off");
    const vinEl = document.getElementById("fbco-vin");
    const sellerNotesEl = document.getElementById("fbco-seller-notes");
    const summaryEl = document.getElementById("fbco-summary");
    const summaryBlock = document.getElementById("fbco-summary-block");
    const verdictBlock = document.getElementById("fbco-verdict-block");
    const vehicleTitleEl = document.getElementById("fbco-vehicle-title");
    const metaPriceEl = document.getElementById("fbco-meta-price");
    const metaMileageEl = document.getElementById("fbco-meta-mileage");
    const metaTitleEl = document.getElementById("fbco-meta-title-status");
    const issuesEl = document.getElementById("fbco-analysis-issues");
    const upsidesEl = document.getElementById("fbco-analysis-upsides");
    const wearEl = document.getElementById("fbco-analysis-wear");
    const checklistEl = document.getElementById("fbco-analysis-checklist");
    const questionsEl = document.getElementById("fbco-analysis-questions");
    const priceEl = document.getElementById("fbco-analysis-price");
    const dealBreakersEl = document.getElementById("fbco-analysis-dealbreakers");
    const risksEl = document.getElementById("fbco-analysis-risks");
    const scoreBadgeEl = document.getElementById("fbco-score-badge");
    const confidenceBadgeEl = document.getElementById("fbco-confidence-badge");
    const verdictBadgeEl = document.getElementById("fbco-verdict-badge");
    const tagsEl = document.getElementById("fbco-analysis-tags");
    const marketEl = document.getElementById("fbco-analysis-market");
    const maintenanceEl = document.getElementById("fbco-analysis-maintenance");
    const finalVerdictEl = document.getElementById("fbco-final-verdict");
    const yearRepEl = document.getElementById("fbco-year-rep");
    const lifespanEl = document.getElementById("fbco-lifespan");
    const dailyProjectEl = document.getElementById("fbco-daily-project");
    const skillEl = document.getElementById("fbco-skill");
    const notesEl = document.getElementById("fbco-notes");
    const notesBlock = document.getElementById("fbco-notes-block");
    const repBlock = document.getElementById("fbco-kv-rep");
    const lifespanBlock = document.getElementById("fbco-kv-lifespan");
    const dailyBlock = document.getElementById("fbco-kv-daily");
    const skillBlock = document.getElementById("fbco-kv-skill");

    const accOverview = document.getElementById("fbco-acc-overview");
    const accUpsides = document.getElementById("fbco-acc-upsides");
    const accMaintenance = document.getElementById("fbco-acc-maintenance");
    const accCommon = document.getElementById("fbco-acc-common");
    const accWear = document.getElementById("fbco-acc-wear");
    const accRisk = document.getElementById("fbco-acc-risk");
    const accDeal = document.getElementById("fbco-acc-deal");
    const accInspection = document.getElementById("fbco-acc-inspection");
    const accQuestions = document.getElementById("fbco-acc-questions");
    const accMarket = document.getElementById("fbco-acc-market");
    const accDetails = document.getElementById("fbco-acc-details");

    if (parsedValEl) parsedValEl.textContent = vehicle.normalized || "—";
    if (rawValEl) rawValEl.textContent = vehicle.source_text || "—";
    if (priceValEl) priceValEl.textContent = window.FBCO_formatUSD(vehicle.price_usd) || "—";
    if (mileageValEl) mileageValEl.textContent = window.FBCO_formatMiles(vehicle.mileage_miles) || "—";
    if (transmissionEl) transmissionEl.textContent = vehicle.transmission || "—";
    if (drivetrainEl) drivetrainEl.textContent = vehicle.drivetrain || "—";
    if (fuelEl) fuelEl.textContent = vehicle.fuel_type || "—";
    if (colorsEl) {
      const colors = [vehicle.exterior_color, vehicle.interior_color].filter(Boolean);
      colorsEl.textContent = colors.length ? colors.join(" / ") : "—";
    }
    if (mpgEl) {
      const mpgParts = [];
      if (vehicle.mpg_city != null) mpgParts.push(`${vehicle.mpg_city} city`);
      if (vehicle.mpg_highway != null) mpgParts.push(`${vehicle.mpg_highway} hwy`);
      if (vehicle.mpg_combined != null) mpgParts.push(`${vehicle.mpg_combined} comb`);
      mpgEl.textContent = mpgParts.length ? mpgParts.join(" · ") : "—";
    }
    if (nhtsaEl) nhtsaEl.textContent = vehicle.nhtsa_rating != null ? `${vehicle.nhtsa_rating}/5` : "—";
    if (titleStatusEl) titleStatusEl.textContent = vehicle.title_status || "—";
    if (paidOffEl) {
      if (vehicle.paid_off == null) {
        paidOffEl.textContent = "—";
      } else {
        paidOffEl.textContent = vehicle.paid_off ? "Yes" : "No";
      }
    }
    if (vinEl) vinEl.textContent = vehicle.vin || "—";
    if (sellerNotesEl) sellerNotesEl.textContent = vehicle.seller_description || "—";

    const loading = analysisState?.loading;
    const error = analysisState?.error;
    const data = analysisState?.data;
    const loadingText = analysisState?.loadingText;
    const ready = analysisState?.ready;

    const busy = !ready;
    root.dataset.loading = busy ? "1" : "0";
    const loadingTextEl = document.getElementById("fbco-loading-text");
    if (loadingTextEl) loadingTextEl.textContent = loadingText || "Analyzing…";
    if (busy) {
      const errorEl = document.getElementById("fbco-error");
      if (errorEl) setVisible(errorEl, false);
      return;
    }

    const errorEl = document.getElementById("fbco-error");
    if (errorEl) {
      if (error) {
        errorEl.textContent = `Unable to analyze listing: ${error}. Try refresh.`;
        setVisible(errorEl, true);
      } else {
        setVisible(errorEl, false);
      }
    }

    setTextAlways(summaryEl, data?.summary, summaryBlock);
    setTextAlways(finalVerdictEl, data?.final_verdict, verdictBlock);
    const repShown = setText(yearRepEl, data?.year_model_reputation, repBlock);
    const lifespanShown = setText(lifespanEl, data?.remaining_lifespan_estimate, lifespanBlock);
    const dailyShown = setText(dailyProjectEl, data?.daily_driver_vs_project, dailyBlock);
    const skillShown = setText(skillEl, data?.mechanical_skill_required, skillBlock);
    const notesShown = setText(notesEl, data?.notes, notesBlock);
    if (vehicleTitleEl) {
      if (vehicle?.year && vehicle?.make) {
        const name = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ");
        vehicleTitleEl.textContent = name;
      } else {
        vehicleTitleEl.textContent = "Vehicle";
      }
    }

    if (metaPriceEl) metaPriceEl.textContent = window.FBCO_formatUSD(vehicle.price_usd) || "—";
    if (metaMileageEl) metaMileageEl.textContent = window.FBCO_formatMiles(vehicle.mileage_miles) || "—";
    if (metaTitleEl) {
      if (vehicle.title_status) {
        metaTitleEl.textContent = vehicle.title_status;
        metaTitleEl.classList.remove("fbco-muted");
      } else {
        metaTitleEl.textContent = "Unknown status";
        metaTitleEl.classList.add("fbco-muted");
      }
    }

    renderList(maintenanceEl, data?.expected_maintenance_near_term, stringifyMaintenance, {
      wrapper: accMaintenance
    });
    renderList(upsidesEl, data?.upsides, null, { wrapper: accUpsides });
    renderList(issuesEl, data?.common_issues, stringifyIssue, { wrapper: accCommon });
    renderList(wearEl, data?.wear_items, stringifyMaintenance, { wrapper: accWear });
    renderList(checklistEl, data?.inspection_checklist, null, { wrapper: accInspection });
    renderList(questionsEl, data?.buyer_questions, null, { clickable: true, wrapper: accQuestions });
    renderList(dealBreakersEl, data?.deal_breakers, null, { wrapper: accDeal });
    renderList(risksEl, data?.risk_flags, null, { wrapper: accRisk });
    renderTags(tagsEl, data?.tags);

    const marketText = isMeaningfulText(data?.market_value_estimate) ? data?.market_value_estimate : "";
    const priceText = isMeaningfulText(data?.price_opinion) ? data?.price_opinion : "";
    if (marketEl) marketEl.textContent = marketText || "—";
    if (priceEl) priceEl.textContent = priceText || "—";
    setVisible(accMarket, Boolean(marketText || priceText));

    const score = Number.isFinite(Number(data?.overall_score))
      ? Number(data?.overall_score)
      : Number.isFinite(Number(data?.score))
      ? Number(data?.score)
      : null;
    if (scoreBadgeEl) {
      if (score == null) {
        scoreBadgeEl.textContent = busy ? "…" : "--";
        scoreBadgeEl.className = "fbco-badge fbco-badge-muted";
      } else {
        const clamped = Math.min(100, Math.max(0, score));
        const meta = scoreLabel(clamped);
        scoreBadgeEl.textContent = meta ? `${meta.label} (${clamped})` : `${clamped}/100`;
        scoreBadgeEl.className = `fbco-badge fbco-badge-${meta?.tone || "muted"}`;
      }
    }

    const conf =
      Number.isFinite(Number(data?.confidence)) ? Math.round(Number(data?.confidence) * 100) : null;
    if (confidenceBadgeEl) {
      confidenceBadgeEl.textContent = conf == null ? "Confidence --" : `Confidence ${conf}%`;
    }

    if (verdictBadgeEl) {
      const verdictText = typeof data?.final_verdict === "string" ? data.final_verdict.toLowerCase() : "";
      if (verdictText.includes("conditional")) {
        verdictBadgeEl.textContent = "Conditional buy";
        verdictBadgeEl.className = "fbco-badge fbco-badge-fair";
      } else if (verdictText.includes("avoid") || verdictText.includes("walk away")) {
        verdictBadgeEl.textContent = "Avoid";
        verdictBadgeEl.className = "fbco-badge fbco-badge-no";
      } else if (verdictText.includes("buy")) {
        verdictBadgeEl.textContent = "Buy";
        verdictBadgeEl.className = "fbco-badge fbco-badge-good";
      } else {
        verdictBadgeEl.textContent = "Verdict";
        verdictBadgeEl.className = "fbco-badge fbco-badge-muted";
      }
    }

    const overviewVisible = repShown || lifespanShown || dailyShown || skillShown || notesShown;
    setVisible(accOverview, overviewVisible);
    setVisible(accDetails, true);
  };
})();
