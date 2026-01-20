(() => {
  function getListingTitleText() {
    let text =
      document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() ||
      (document.title || "").trim() ||
      "";

    text = text.replace(/^Marketplace\s*-\s*/i, "");
    text = text.replace(/\s*\|\s*Facebook\s*$/i, "");
    text = text.replace(/\s+for\s+sale.*$/i, "");

    return text.trim();
  }

  function parseYearMakeModel(text) {
    const m = text.match(
      /\b((?:19|20)\d{2})\b\s+([A-Za-z0-9]+)(?:\s+([A-Za-z0-9]+))?(?:\s+([A-Za-z0-9]+))?/
    );
    if (!m) return null;

    const year = m[1];
    const make = m[2];
    const model = [m[3], m[4]].filter(Boolean).join(" ").trim();

    return {
      year,
      make,
      model: model || null,
      normalized: [year, make, model].filter(Boolean).join(" ").trim()
    };
  }

  function getTitleAnchorTop() {
    const h1 = Array.from(document.querySelectorAll("h1")).find(window.FBCO_isVisible);
    if (h1) return h1.getBoundingClientRect().top;

    const main = document.querySelector('[role="main"]');
    if (main && window.FBCO_isVisible(main)) return main.getBoundingClientRect().top;

    return 0;
  }

  function findPriceText() {
    const anchorTop = getTitleAnchorTop();

    const els = Array.from(document.querySelectorAll("span, div"))
      .filter(window.FBCO_isVisible)
      .slice(0, 5000);

    const candidates = [];
    for (const el of els) {
      const t = (el.innerText || "").trim();
      if (!t || t.length > 40) continue;

      const cur = window.FBCO_extractCurrencyFromText(t);
      if (!cur) continue;

      const value = window.FBCO_parsePriceUSD(cur);
      if (value == null || value < 100) continue;

      const rect = el.getBoundingClientRect();
      const yDist = Math.abs(rect.top - anchorTop);

      // CRITICAL: only consider prices near the title area.
      // This avoids “$4,200/month” etc elsewhere on the page.
      if (yDist > 650) continue;

      const fs = parseFloat(window.getComputedStyle(el).fontSize || "0") || 0;
      const fw = window.getComputedStyle(el).fontWeight || "400";
      const weight = Number.isFinite(Number(fw)) ? Number(fw) : fw.includes("bold") ? 700 : 400;

      const struck = window.FBCO_hasLineThrough(el);

      candidates.push({ text: cur, value, fontSize: fs, weight, yDist, struck });
    }

    if (!candidates.length) return null;

    // Strongly prefer non-struck (current price vs old price)
    const nonStruck = candidates.filter((c) => !c.struck);
    const pool0 = nonStruck.length ? nonStruck : candidates;

    // If there are multiple prices near the title, listing price is usually the max.
    // (This avoids picking a smaller “fee/payment” even near the title.)
    const maxVal = Math.max(...pool0.map((c) => c.value));
    const filtered = pool0.filter((c) => c.value >= maxVal * 0.8);
    const pool = filtered.length ? filtered : pool0;

    function score(c) {
      const fontScore = c.fontSize * 2.0 + c.weight / 250;
      const proximityScore = -c.yDist / 120;
      const magnitudeScore = Math.log10(c.value + 1) * 4.0;
      return fontScore + proximityScore + magnitudeScore;
    }

    pool.sort((a, b) => score(b) - score(a));
    return pool[0].text || null;
  }

  function extractMileageFromTextBlock(text) {
    if (!text) return null;

    let m =
      text.match(/\b(\d{1,3}(?:,\d{3})+)\s*(miles|mile|mi)\b/i) ||
      text.match(/\b(\d{5,6})\s*(miles|mile|mi)\b/i);

    if (m) {
      const miles = Number(m[1].replace(/,/g, ""));
      return Number.isFinite(miles) ? { mileage_text: m[0], mileage_miles: miles } : null;
    }

    m =
      text.match(/\b(\d{2,3})\s*k\s*(miles|mile|mi)\b/i) ||
      text.match(/\b(\d{2,3})k\s*(miles|mile|mi)\b/i);

    if (m) {
      const miles = Number(m[1]) * 1000;
      return Number.isFinite(miles) ? { mileage_text: m[0], mileage_miles: miles } : null;
    }

    m = text.match(/\bMileage\b[^0-9]{0,10}(\d{1,3}(?:,\d{3})+|\d{5,6})\b/i);
    if (m) {
      const miles = Number(m[1].replace(/,/g, ""));
      return Number.isFinite(miles) ? { mileage_text: `Mileage ${m[1]}`, mileage_miles: miles } : null;
    }

    return null;
  }

  function findSectionTextByHeading(headingRegex) {
    const els = Array.from(document.querySelectorAll("span, div, h1, h2, h3"))
      .filter(window.FBCO_isVisible)
      .slice(0, 5000);

    const headingEl = els.find((el) => {
      const t = (el.innerText || "").trim();
      return t && t.length <= 40 && headingRegex.test(t);
    });

    if (!headingEl) return null;

    let container = headingEl;
    for (let i = 0; i < 4; i++) {
      if (!container.parentElement) break;
      container = container.parentElement;
      const txt = (container.innerText || "").trim();
      if (txt && txt.length > 50) return txt;
    }

    return (headingEl.parentElement?.innerText || "").trim() || null;
  }

  function findMileage() {
    const detailsText =
      findSectionTextByHeading(/^Details$/i) || findSectionTextByHeading(/^Vehicle\s+details$/i);
    const fromDetails = extractMileageFromTextBlock(detailsText);
    if (fromDetails) return fromDetails;

    const descText =
      findSectionTextByHeading(/^Description$/i) || findSectionTextByHeading(/^About\s+this\s+vehicle$/i);
    const fromDesc = extractMileageFromTextBlock(descText);
    if (fromDesc) return fromDesc;

    const nodes = Array.from(document.querySelectorAll("span, div"))
      .filter(window.FBCO_isVisible)
      .slice(0, 1400);

    for (const el of nodes) {
      const t = (el.innerText || "").trim();
      if (!t || t.length > 220) continue;
      const found = extractMileageFromTextBlock(t);
      if (found) return found;
    }

    return { mileage_text: null, mileage_miles: null };
  }

  window.FBCO_extractVehicleSnapshot = function () {
    const raw = getListingTitleText();
    const parsed = parseYearMakeModel(raw);

    const price_text = findPriceText();
    const price_usd = window.FBCO_parsePriceUSD(price_text);

    const mileage = findMileage();

    return {
      url: location.href,
      source_text: raw || null,
      year: parsed?.year || null,
      make: parsed?.make || null,
      model: parsed?.model || null,
      normalized: parsed?.normalized || null,
      price_text: price_text || null,
      price_usd: price_usd != null ? price_usd : null,
      mileage_text: mileage.mileage_text,
      mileage_miles: mileage.mileage_miles
    };
  };
})();
