(() => {
  const { overlayId } = window.FBCO_STATE;

  window.FBCO_STATE.dismissed = false;

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
  window.FBCO_removeOverlay = removeOverlay;

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
          <div class="fbco-title">
            <img id="fbco-title-icon" class="fbco-title-icon" alt="Car Spotter" />
            <span>Car Spotter</span>
          </div>
          <div class="fbco-actions">
            <button id="fbco-minimize" class="fbco-icon-btn" type="button" title="Minimize">–</button>
            <button id="fbco-close" class="fbco-icon-btn" type="button" title="Close">×</button>
          </div>
        </div>

        <div class="fbco-body" id="fbco-body">
          <div class="fbco-loading" id="fbco-loading">
            <div class="fbco-loading-track" aria-hidden="true">
              <span class="fbco-loading-car">🚗</span>
            </div>
            <div class="fbco-loading-text">Analyzing…</div>
          </div>

          <div class="fbco-vehicle-title" id="fbco-vehicle-title">—</div>

          <div class="fbco-spectrum fbco-spectrum-top">
            <div class="fbco-spectrum-header">
              <div class="fbco-spectrum-label">Overall rating</div>
              <div id="fbco-score-value" class="fbco-score-value">--</div>
            </div>
            <div class="fbco-spectrum-bar">
              <div id="fbco-spectrum-marker" class="fbco-spectrum-marker"></div>
            </div>
            <div class="fbco-spectrum-scale">
              <span>❌ No</span>
              <span>⚠️ Risky</span>
              <span>⚖️ Fair</span>
              <span>👍 Good</span>
              <span>💎 Great</span>
              <span>🚀 Steal</span>
            </div>
          </div>

          <div class="fbco-block">
            <div class="fbco-label">Summary</div>
            <div id="fbco-summary" class="fbco-text">(none)</div>
          </div>

          <div class="fbco-block">
            <div class="fbco-label">Final verdict</div>
            <div id="fbco-final-verdict" class="fbco-text">(none)</div>
          </div>

          <div class="fbco-block">
            <div class="fbco-label">Year/model reputation</div>
            <div id="fbco-year-rep" class="fbco-text">(none)</div>
          </div>

          <div class="fbco-block">
            <div class="fbco-label">Remaining lifespan</div>
            <div id="fbco-lifespan" class="fbco-text">(none)</div>
          </div>

          <div class="fbco-block">
            <div class="fbco-label">Daily vs project</div>
            <div id="fbco-daily-project" class="fbco-text">(none)</div>
          </div>

          <div class="fbco-block">
            <div class="fbco-label">Mechanical skill</div>
            <div id="fbco-skill" class="fbco-text">(none)</div>
          </div>

          <div class="fbco-block">
            <div id="fbco-analysis-tags" class="fbco-tags"></div>
          </div>

          <div class="fbco-block">
            <div class="fbco-label">Likely maintenance</div>
            <ul id="fbco-analysis-maintenance" class="fbco-list"></ul>
          </div>

          <div class="fbco-block">
            <div class="fbco-label">Common issues</div>
            <ul id="fbco-analysis-issues" class="fbco-list"></ul>
          </div>

          <div class="fbco-block">
            <div class="fbco-label">Wear items to expect</div>
            <ul id="fbco-analysis-wear" class="fbco-list"></ul>
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
            <div class="fbco-label">Buyer questions</div>
            <ul id="fbco-analysis-questions" class="fbco-list fbco-list-pill"></ul>
          </div>

          <div class="fbco-block">
            <div class="fbco-label">Market value</div>
            <div id="fbco-analysis-market" class="fbco-value">(estimate)</div>
          </div>

          <div class="fbco-block">
            <div class="fbco-label">Price opinion</div>
            <div id="fbco-analysis-price" class="fbco-value">(none)</div>
          </div>

          <div class="fbco-block">
            <div class="fbco-label">Deal breakers</div>
            <ul id="fbco-analysis-dealbreakers" class="fbco-list"></ul>
          </div>

          <div class="fbco-block">
            <div class="fbco-label">Risk flags</div>
            <ul id="fbco-analysis-risks" class="fbco-list"></ul>
          </div>

          <div class="fbco-divider"></div>

          <div class="fbco-section-header">
            <button id="fbco-details-toggle" class="fbco-link-btn" type="button">Show</button>
            <div class="fbco-section-title">Listing details</div>
          </div>

          <div id="fbco-details-section" class="fbco-collapsible" data-collapsed="1">
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
        const iconUrl = runtime.getURL("assets/icon48.png");
        if (titleIcon) titleIcon.src = iconUrl;
        if (miniIcon) miniIcon.src = iconUrl;
      } catch {
        // Extension context can be invalidated during reloads; ignore and continue.
      }
    };
    setIcons();

    // Only stop propagation for non-pointer events.
    // Pointer events are used for drag and must work reliably.
    ["click", "dblclick", "contextmenu", "keydown", "keyup"].forEach((evt) => {
      root.addEventListener(evt, (e) => e.stopPropagation(), false);
    });

    root.addEventListener("click", (e) => {
      const target = e.target;
      if (!target) return;
      const btn = target.closest("[data-fbco-message]");
      if (!btn) return;
      const message = btn.dataset.fbcoMessage;
      if (!message) return;
      window.FBCO_insertMessage && window.FBCO_insertMessage(message);
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

    const detailsToggle = root.querySelector("#fbco-details-toggle");
    const detailsSection = root.querySelector("#fbco-details-section");
    if (detailsToggle && detailsSection) {
      detailsToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const collapsed = detailsSection.dataset.collapsed !== "0";
        detailsSection.dataset.collapsed = collapsed ? "0" : "1";
        detailsToggle.textContent = collapsed ? "Hide" : "Show";
      });
    }

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

  function renderList(el, items, mapFn, opts) {
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
      const span = document.createElement("span");
      span.className = "fbco-tag fbco-tag-empty";
      span.textContent = "None";
      el.appendChild(span);
      return;
    }
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
    if (score < 15) return "❌ No";
    if (score < 35) return "⚠️ Risky";
    if (score < 55) return "⚖️ Fair";
    if (score < 72) return "👍 Good";
    if (score < 88) return "💎 Great";
    return "🚀 Steal";
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
    const vehicleTitleEl = document.getElementById("fbco-vehicle-title");
    const issuesEl = document.getElementById("fbco-analysis-issues");
    const wearEl = document.getElementById("fbco-analysis-wear");
    const upsidesEl = document.getElementById("fbco-analysis-upsides");
    const checklistEl = document.getElementById("fbco-analysis-checklist");
    const questionsEl = document.getElementById("fbco-analysis-questions");
    const priceEl = document.getElementById("fbco-analysis-price");
    const dealBreakersEl = document.getElementById("fbco-analysis-dealbreakers");
    const risksEl = document.getElementById("fbco-analysis-risks");
    const scoreValEl = document.getElementById("fbco-score-value");
    const scoreMarkerEl = document.getElementById("fbco-spectrum-marker");
    const tagsEl = document.getElementById("fbco-analysis-tags");
    const marketEl = document.getElementById("fbco-analysis-market");
    const maintenanceEl = document.getElementById("fbco-analysis-maintenance");
    const finalVerdictEl = document.getElementById("fbco-final-verdict");
    const yearRepEl = document.getElementById("fbco-year-rep");
    const lifespanEl = document.getElementById("fbco-lifespan");
    const dailyProjectEl = document.getElementById("fbco-daily-project");
    const skillEl = document.getElementById("fbco-skill");

    if (parsedValEl) parsedValEl.textContent = vehicle.normalized || "Not found";
    if (rawValEl) rawValEl.textContent = vehicle.source_text || "(not found)";
    if (priceValEl) priceValEl.textContent = window.FBCO_formatUSD(vehicle.price_usd) || "Not found";
    if (mileageValEl) mileageValEl.textContent = window.FBCO_formatMiles(vehicle.mileage_miles) || "Not found";
    if (transmissionEl) transmissionEl.textContent = vehicle.transmission || "Not found";
    if (drivetrainEl) drivetrainEl.textContent = vehicle.drivetrain || "Not found";
    if (fuelEl) fuelEl.textContent = vehicle.fuel_type || "Not found";
    if (colorsEl) {
      const colors = [vehicle.exterior_color, vehicle.interior_color].filter(Boolean);
      colorsEl.textContent = colors.length ? colors.join(" / ") : "Not found";
    }
    if (mpgEl) {
      const mpgParts = [];
      if (vehicle.mpg_city != null) mpgParts.push(`${vehicle.mpg_city} city`);
      if (vehicle.mpg_highway != null) mpgParts.push(`${vehicle.mpg_highway} hwy`);
      if (vehicle.mpg_combined != null) mpgParts.push(`${vehicle.mpg_combined} comb`);
      mpgEl.textContent = mpgParts.length ? mpgParts.join(" · ") : "Not found";
    }
    if (nhtsaEl) nhtsaEl.textContent = vehicle.nhtsa_rating != null ? `${vehicle.nhtsa_rating}/5` : "Not found";
    if (titleStatusEl) titleStatusEl.textContent = vehicle.title_status || "Not found";
    if (paidOffEl) {
      if (vehicle.paid_off == null) {
        paidOffEl.textContent = "Not found";
      } else {
        paidOffEl.textContent = vehicle.paid_off ? "Yes" : "No";
      }
    }
    if (vinEl) vinEl.textContent = vehicle.vin || "Not found";
    if (sellerNotesEl) sellerNotesEl.textContent = vehicle.seller_description || "Not found";

    const loading = analysisState?.loading;
    const error = analysisState?.error;
    const data = analysisState?.data;

    const busy = Boolean(loading);
    root.dataset.loading = busy ? "1" : "0";

    if (summaryEl) summaryEl.textContent = data?.summary || "(none)";
    if (finalVerdictEl) finalVerdictEl.textContent = data?.final_verdict || "(none)";
    if (yearRepEl) yearRepEl.textContent = data?.year_model_reputation || "(none)";
    if (lifespanEl) lifespanEl.textContent = data?.remaining_lifespan_estimate || "(none)";
    if (dailyProjectEl) dailyProjectEl.textContent = data?.daily_driver_vs_project || "(none)";
    if (skillEl) skillEl.textContent = data?.mechanical_skill_required || "(none)";
    if (vehicleTitleEl) {
      if (vehicle?.year && vehicle?.make) {
        const name = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ");
        const price = vehicle.price_usd ? window.FBCO_formatUSD(vehicle.price_usd) : null;
        const miles = vehicle.mileage_miles ? window.FBCO_formatMiles(vehicle.mileage_miles) : null;
        const extras = [price, miles].filter(Boolean).join(" • ");
        vehicleTitleEl.textContent = extras ? `${name} (${extras})` : name;
      } else {
        vehicleTitleEl.textContent = "—";
      }
    }

    renderList(maintenanceEl, data?.expected_maintenance_near_term, stringifyMaintenance);
    renderList(issuesEl, data?.common_issues, stringifyIssue);
    renderList(wearEl, data?.wear_items, stringifyMaintenance);
    renderList(upsidesEl, data?.upsides);
    renderList(checklistEl, data?.inspection_checklist);
    renderList(questionsEl, data?.buyer_questions, null, { clickable: true });
    renderList(dealBreakersEl, data?.deal_breakers);
    renderList(risksEl, data?.risk_flags);
    renderTags(tagsEl, data?.tags);
    if (marketEl) marketEl.textContent = data?.market_value_estimate || "(estimate)";
    if (priceEl) priceEl.textContent = data?.price_opinion || "(none)";

    if (scoreValEl && scoreMarkerEl) {
      const score = Number.isFinite(Number(data?.overall_score))
        ? Number(data?.overall_score)
        : Number.isFinite(Number(data?.score))
        ? Number(data?.score)
        : null;
      if (score == null) {
        scoreValEl.textContent = busy ? "…" : "--";
        scoreMarkerEl.style.left = "0%";
      } else {
        const clamped = Math.min(100, Math.max(0, score));
        const label = scoreLabel(clamped);
        scoreValEl.textContent = label ? `${label} (${clamped}/100)` : `${clamped}/100`;
        scoreMarkerEl.style.left = `${clamped}%`;
      }
    }
  };
})();
