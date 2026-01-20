(() => {
  // Shared state holder
  window.FBCO_STATE = {
    overlayId: "fb-car-overlay-mvp",
    isUserSelecting: false
  };

  window.FBCO_isVisible = function (el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  window.FBCO_debounce = function (fn, waitMs) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), waitMs);
    };
  };

  window.FBCO_copyToClipboard = async function (text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    }
  };

  window.FBCO_formatUSD = function (n) {
    if (n == null) return null;
    return `$${Number(n).toLocaleString("en-US")}`;
  };

  window.FBCO_formatMiles = function (n) {
    if (n == null) return null;
    return `${Number(n).toLocaleString("en-US")} miles`;
  };

  window.FBCO_parsePriceUSD = function (text) {
    if (!text) return null;
    const cleaned = text.replace(/\s/g, "");
    const m = cleaned.match(/^\$?\d{1,3}(?:,\d{3})*(?:\.\d{2})?$/);
    if (!m) return null;
    const num = Number(cleaned.replace("$", "").replace(/,/g, ""));
    return Number.isFinite(num) ? num : null;
  };

  window.FBCO_extractCurrencyFromText = function (text) {
    if (!text) return null;
    const m = text.match(/\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/);
    return m ? m[0] : null;
  };

  window.FBCO_hasLineThrough = function (el) {
    // Walk up a few levels: FB often applies line-through at parent spans
    let cur = el;
    for (let i = 0; i < 5; i++) {
      if (!cur) break;
      const td = window.getComputedStyle(cur).textDecorationLine || "";
      if (td.includes("line-through")) return true;
      cur = cur.parentElement;
    }
    return false;
  };

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
      } catch {
        // ignore
      }
    }
  };
})();
