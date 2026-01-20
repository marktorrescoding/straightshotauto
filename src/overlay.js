(() => {
  const { overlayId } = window.FBCO_STATE;

  window.FBCO_STATE.dismissed = false;

  const STORE_KEY = "fbco.overlay.state.v6";
  const DEFAULT_STATE = {
    top: 16,
    left: null,
    right: 16,
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
    if (el) el.remove();
  }

  function ensureOverlay() {
    if (window.FBCO_STATE.dismissed) return null;

    let root = document.getElementById(overlayId);
    if (root) return root;

    const state = loadOverlayState();

    root = document.createElement("div");
    root.id = overlayId;

    root.innerHTML = `
      <!-- Full panel -->
      <div class="fbco-panel" id="fbco-panel">
        <div class="fbco-header" id="fbco-drag-handle">
          <div class="fbco-title">Car Snapshot</div>
          <div class="fbco-actions">
            <button id="fbco-minimize" class="fbco-icon-btn" type="button" title="Minimize">–</button>
            <button id="fbco-close" class="fbco-icon-btn" type="button" title="Close">×</button>
          </div>
        </div>

        <div class="fbco-body" id="fbco-body">
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

          <div class="fbco-section-title">Analysis</div>

          <div class="fbco-row fbco-row-wide">
            <div class="fbco-label">Status</div>
            <div class="fbco-val"><span id="fbco-analysis-status" class="fbco-value">Waiting…</span></div>
          </div>

          <div class="fbco-row fbco-row-wide">
            <div class="fbco-label">Summary</div>
            <div class="fbco-val"><span id="fbco-analysis-summary" class="fbco-value">(none)</span></div>
          </div>

          <div class="fbco-block">
            <div class="fbco-label">Common issues</div>
            <ul id="fbco-analysis-issues" class="fbco-list"></ul>
          </div>

          <div class="fbco-block">
            <div class="fbco-label">Upsides</div>
            <ul id="fbco-analysis-upsides" class="fbco-list"></ul>
          </div>

          <div class="fbco-block">
            <div class="fbco-label">Inspection checks</div>
            <ul id="fbco-analysis-checklist" class="fbco-list"></ul>
          </div>

          <div class="fbco-block">
            <div class="fbco-label">Price opinion</div>
            <div id="fbco-analysis-price" class="fbco-value">(none)</div>
          </div>

          <div class="fbco-block">
            <div class="fbco-label">Risk flags</div>
            <ul id="fbco-analysis-risks" class="fbco-list"></ul>
          </div>
        </div>
      </div>

      <!-- Minimized icon -->
      <button class="fbco-mini" id="fbco-mini" type="button" title="Show car info" aria-label="Show car info">
        <span class="fbco-mini-icon" aria-hidden="true">🚗</span>
      </button>
    `;

    document.body.appendChild(root);

    // Only stop propagation for non-pointer events.
    // Pointer events are used for drag and must work reliably.
    ["click", "dblclick", "contextmenu", "keydown", "keyup"].forEach((evt) => {
      root.addEventListener(evt, (e) => e.stopPropagation(), false);
    });

    // Selecting value pills pauses updates
    root.addEventListener("pointerdown", (e) => {
      const t = e.target;
      if (t && t.classList && t.classList.contains("fbco-value")) {
        window.FBCO_STATE.isUserSelecting = true;
      } else {
        window.FBCO_STATE.isUserSelecting = false;
      }
    });

    window.addEventListener(
      "pointerup",
      () => {
        window.FBCO_STATE.isUserSelecting = false;
      },
      true
    );
    window.addEventListener(
      "pointercancel",
      () => {
        window.FBCO_STATE.isUserSelecting = false;
      },
      true
    );

    // Close
    root.querySelector("#fbco-close")?.addEventListener("click", (e) => {
      e.stopPropagation();
      window.FBCO_STATE.dismissed = true;
      removeOverlay();
    });

    // Minimize (icon mode)
    root.querySelector("#fbco-minimize")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const st = loadOverlayState();
      st.minimized = true;
      saveOverlayState(st);
      applyOverlayState(root, st);
    });

    // Restore from icon
    root.querySelector("#fbco-mini")?.addEventListener("click", (e) => {
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
    });

    // Drag: allow dragging in both modes (use header when open, icon when minimized)
    installPointerDrag(root);

    // Persist resize only when not minimized
    installResizePersistence(root);

    applyOverlayState(root, state);

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
  }

  function installResizePersistence(root) {
    let lastW = Math.round(root.getBoundingClientRect().width);
    let lastH = Math.round(root.getBoundingClientRect().height);

    setInterval(() => {
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
  }

  function stringifyIssue(issue) {
    if (!issue) return null;
    if (typeof issue === "string") return issue;
    const parts = [];
    if (issue.issue) parts.push(issue.issue);
    if (issue.severity) parts.push(`Severity: ${issue.severity}`);
    if (issue.estimated_cost) parts.push(`Cost: ${issue.estimated_cost}`);
    if (issue.cost_range) parts.push(`Cost: ${issue.cost_range}`);
    return parts.length ? parts.join(" • ") : null;
  }

  function renderList(el, items, mapFn) {
    if (!el) return;
    el.innerHTML = "";
    if (!items || !items.length) {
      const li = document.createElement("li");
      li.className = "fbco-empty";
      li.textContent = "Not available";
      el.appendChild(li);
      return;
    }
    items.forEach((item) => {
      const text = mapFn ? mapFn(item) : typeof item === "string" ? item : JSON.stringify(item);
      if (!text) return;
      const li = document.createElement("li");
      li.textContent = text;
      el.appendChild(li);
    });
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
    const statusEl = document.getElementById("fbco-analysis-status");
    const summaryEl = document.getElementById("fbco-analysis-summary");
    const issuesEl = document.getElementById("fbco-analysis-issues");
    const upsidesEl = document.getElementById("fbco-analysis-upsides");
    const checklistEl = document.getElementById("fbco-analysis-checklist");
    const priceEl = document.getElementById("fbco-analysis-price");
    const risksEl = document.getElementById("fbco-analysis-risks");

    if (parsedValEl) parsedValEl.textContent = vehicle.normalized || "Not found";
    if (rawValEl) rawValEl.textContent = vehicle.source_text || "(not found)";
    if (priceValEl) priceValEl.textContent = window.FBCO_formatUSD(vehicle.price_usd) || "Not found";
    if (mileageValEl) mileageValEl.textContent = window.FBCO_formatMiles(vehicle.mileage_miles) || "Not found";

    const loading = analysisState?.loading;
    const error = analysisState?.error;
    const data = analysisState?.data;

    if (statusEl) {
      if (!vehicle?.year || !vehicle?.make) {
        statusEl.textContent = "Need year + make";
      } else if (loading) {
        statusEl.textContent = "Analyzing…";
      } else if (error) {
        statusEl.textContent = `Error: ${error}`;
      } else if (data) {
        statusEl.textContent = "Ready";
      } else {
        statusEl.textContent = "Waiting…";
      }
    }

    if (summaryEl) summaryEl.textContent = data?.summary || "(none)";

    renderList(issuesEl, data?.common_issues, stringifyIssue);
    renderList(upsidesEl, data?.upsides);
    renderList(checklistEl, data?.inspection_checklist);
    renderList(risksEl, data?.risk_flags);
    if (priceEl) priceEl.textContent = data?.price_opinion || "(none)";
  };
})();
