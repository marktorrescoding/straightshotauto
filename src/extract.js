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

  // Drivetrain/trim tokens that are never a vehicle make
  const DRIVETRAIN_TOKEN = /^(AWD|4WD|FWD|RWD|2WD|4x4|4X4)$/i;

  function parseYearMakeModel(text) {
    const m = text.match(
      /\b((?:19|20)\d{2})\b\s+([A-Za-z0-9]+)(?:\s+([A-Za-z0-9-]+))?(?:\s+([A-Za-z0-9-]+))?(?:\s+([A-Za-z0-9-]+))?/
    );

    // If the parsed make looks like a drivetrain descriptor (e.g. "2014 AWD" from
    // "Toyota RAV4 2014 AWD"), check if there is real make/model content before the year.
    if (!m || DRIVETRAIN_TOKEN.test(m[2])) {
      const yearMatch = text.match(/\b((?:19|20)\d{2})\b/);
      if (yearMatch) {
        const beforeYear = text.slice(0, yearMatch.index).trim();
        if (beforeYear) {
          const parts = beforeYear.split(/\s+/).filter(Boolean);
          if (parts.length >= 1 && /^[A-Za-z]/.test(parts[0])) {
            const year = yearMatch[1];
            const make = parts[0];
            const model = parts.slice(1).join(" ").trim() || null;
            return {
              year,
              make,
              model: model || null,
              normalized: [year, make, model].filter(Boolean).join(" ").trim()
            };
          }
        }
      }
    }

    if (!m) return null;

    const year = m[1];
    const make = m[2];
    const model = [m[3], m[4], m[5]].filter(Boolean).join(" ").trim();

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

    const els = getCachedEls();

    function extractAllCurrency(text) {
      if (!text) return [];
      const matches = text.match(/\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g);
      return matches || [];
    }

    const candidates = [];
    for (const el of els) {
      const t = (el.innerText || "").trim();
      if (!t || t.length > 40) continue;

      const curs = extractAllCurrency(t);
      if (!curs.length) continue;

      const rect = el.getBoundingClientRect();
      const yDist = Math.abs(rect.top - anchorTop);

      // CRITICAL: only consider prices near the title area.
      // This avoids “$4,200/month” etc elsewhere on the page.
      if (yDist > 650) continue;

      const fs = parseFloat(window.getComputedStyle(el).fontSize || "0") || 0;
      const fw = window.getComputedStyle(el).fontWeight || "400";
      const weight = Number.isFinite(Number(fw)) ? Number(fw) : fw.includes("bold") ? 700 : 400;

      const struck = window.FBCO_hasLineThrough(el);

      for (const cur of curs) {
        const value = window.FBCO_parsePriceUSD(cur);
        if (value == null || value < 100) continue;
        candidates.push({ text: cur, value, fontSize: fs, weight, yDist, struck });
      }
    }

    if (!candidates.length) return null;

    // Strongly prefer non-struck (current price vs old price)
    const nonStruck = candidates.filter((c) => !c.struck);
    const pool0 = nonStruck.length ? nonStruck : candidates;

    // If there are multiple prices near the title, prefer the smaller one
    // when they look like an original/discount pair.
    const maxFont = Math.max(...pool0.map((c) => c.fontSize));
    const nearTitle = pool0.filter((c) => c.yDist <= 200 && Math.abs(c.fontSize - maxFont) <= 3);
    const pool =
      nearTitle.length >= 2
        ? nearTitle
        : (() => {
            const maxVal = Math.max(...pool0.map((c) => c.value));
            const filtered = pool0.filter((c) => c.value >= maxVal * 0.8);
            return filtered.length ? filtered : pool0;
          })();

    function score(c) {
      const fontScore = c.fontSize * 2.0 + c.weight / 250;
      const proximityScore = -c.yDist / 120;
      const magnitudeScore = Math.log10(c.value + 1) * 4.0;
      return fontScore + proximityScore + magnitudeScore;
    }

    if (pool.length >= 2) {
      const maxVal = Math.max(...pool.map((c) => c.value));
      const minVal = Math.min(...pool.map((c) => c.value));
      if (minVal / maxVal >= 0.7) {
        const min = pool.reduce((best, c) => (c.value < best.value ? c : best), pool[0]);
        return min.text || null;
      }
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
      text.match(/\b(\d{2,3})\s*k\s*(miles|mile|mi|millas)\b/i) ||
      text.match(/\b(\d{2,3})k\s*(miles|mile|mi|millas)\b/i);

    if (m) {
      const miles = Number(m[1]) * 1000;
      return Number.isFinite(miles) ? { mileage_text: m[0], mileage_miles: miles } : null;
    }

    m =
      text.match(/\bMileage\b[^0-9]{0,10}(\d{1,3}(?:,\d{3})+|\d{5,6})\b/i) ||
      text.match(/\b(\d{1,3}(?:,\d{3})+|\d{5,6})\s*millas\b/i);
    if (m) {
      const miles = Number(m[1].replace(/,/g, ""));
      return Number.isFinite(miles) ? { mileage_text: `Mileage ${m[1]}`, mileage_miles: miles } : null;
    }

    return null;
  }

  function findSectionByHeading(headingRegex) {
    const els = getCachedEls();

    const headingEl = els.find((el) => {
      const t = (el.innerText || "").trim();
      return t && t.length <= 40 && headingRegex.test(t);
    });

    if (!headingEl) return { text: null, container: null };

    let container = headingEl;
    for (let i = 0; i < 4; i++) {
      if (!container.parentElement) break;
      container = container.parentElement;
      const txt = (container.innerText || "").trim();
      if (txt && txt.length > 50) return { text: txt, container };
    }

    const fallbackText = (headingEl.parentElement?.innerText || "").trim() || null;
    return { text: fallbackText, container: headingEl.parentElement || null };
  }

  function findSectionTextByHeading(headingRegex) {
    return findSectionByHeading(headingRegex).text;
  }

  function findSectionContainerByHeading(headingRegex) {
    return findSectionByHeading(headingRegex).container;
  }

  function getSelectedCategoryLabel() {
    const selectors = [
      '[aria-current="page"]',
      '[aria-current="true"]',
      '[aria-selected="true"]',
      '[role="option"][aria-selected="true"]'
    ];
    const els = selectors.flatMap((s) => Array.from(document.querySelectorAll(s)));
    for (const el of els) {
      if (!window.FBCO_isVisible(el)) continue;
      const t = (el.innerText || "").trim();
      if (t && t.length <= 40) return t;
    }
    return null;
  }

  function isVehicleCategory(label) {
    if (!label) return false;
    return (
      /^Vehicles$/i.test(label) ||
      /^Cars\s*&\s*Trucks$/i.test(label) ||
      /^Vehicle$/i.test(label)
    );
  }

  function hasVehicleSignals() {
    const headings = getCachedEls();

    return headings.some((el) => {
      const t = (el.innerText || "").trim();
      if (!t) return false;
      return (
        /^About\s+this\s+vehicle$/i.test(t) ||
        /^Vehicle\s+details$/i.test(t) ||
        /^Vehicle$/i.test(t) ||
        /^Cars\s*&\s*Trucks$/i.test(t)
      );
    });
  }

  function parseTransmission(text) {
    if (!text) return null;
    if (/automatic/i.test(text)) return "Automatic";
    if (/automatica|automatico/i.test(text)) return "Automatic";
    if (/\bmanual\b/i.test(text)) return "Manual";
    if (/manual\b/i.test(text)) return "Manual";
    if (/\bCVT\b/i.test(text)) return "CVT";
    if (/dual[-\s]?clutch/i.test(text)) return "Dual-clutch";
    if (/semi[-\s]?automatic/i.test(text)) return "Semi-automatic";
    return null;
  }

  function parseDrivetrain(text) {
    if (!text) return null;
    const t = String(text).toLowerCase();
    if (/\bfx4\b/.test(t)) return "4WD";
    if (/\b(2|two)\s*[-\s]?\s*wheel\s*[-\s]?\s*drive\b/.test(t)) return "2WD";
    if (/\b(4|four)\s*[-\s]?\s*wheel\s*[-\s]?\s*drive\b/.test(t)) return "4WD";

    const m = t.match(/\b(4x4|4wd|awd|fwd|rwd|2wd)\b/);
    if (!m) return null;
    const v = m[1].toUpperCase();
    if (v === "4X4") return "4x4";
    return v;
  }

  function parseColors(text) {
    if (!text) return {};
    const out = {};
    const ext = text.match(/Exterior\s+color:\s*([^·\n]+)(?:\s*·|\s*$)/i);
    const intr = text.match(/Interior\s+color:\s*([^·\n]+)(?:\s*·|\s*$)/i);
    if (ext) out.exterior_color = ext[1].trim();
    if (intr) out.interior_color = intr[1].trim();
    return out;
  }

  function parseNhtsaRating(text) {
    if (!text) return null;
    const m = text.match(/(\d(?:\.\d)?)\s*\/\s*5\s*overall\s*nhtsa/i);
    return m ? Number(m[1]) : null;
  }

  function parseMpg(text) {
    if (!text) return {};
    const out = {};
    const city = text.match(/(\d+(?:\.\d+)?)\s*MPG\s*city/i);
    const highway = text.match(/(\d+(?:\.\d+)?)\s*MPG\s*highway/i);
    const combined = text.match(/(\d+(?:\.\d+)?)\s*MPG\s*combined/i);
    if (city) out.mpg_city = Number(city[1]);
    if (highway) out.mpg_highway = Number(highway[1]);
    if (combined) out.mpg_combined = Number(combined[1]);
    return out;
  }

  function parseFuelType(text) {
    if (!text) return null;
    const m = text.match(/Fuel\s+type:\s*([A-Za-z][A-Za-z\s-]+)$/i);
    if (m) return m[1].trim();
    if (/\bgasoline\b/i.test(text)) return "Gasoline";
    if (/\bgasolina\b/i.test(text)) return "Gasoline";
    if (/\bdiesel\b/i.test(text)) return "Diesel";
    if (/\bhybrid\b/i.test(text)) return "Hybrid";
    if (/\bhibrid[oa]\b/i.test(text)) return "Hybrid";
    if (/\belectric\b/i.test(text)) return "Electric";
    if (/\belectrico\b/i.test(text)) return "Electric";
    return null;
  }

  function parseEngine(text) {
    if (!text) return null;
    const t = String(text);
    const l = t.toLowerCase();
    if (/3\.5\s*(l|liter)?\s*eco\s*boost|3\.5\s*eb|3\.5l?\s*ecoboost/i.test(l)) return "3.5L EcoBoost";
    if (/2\.7\s*(l|liter)?\s*eco\s*boost|2\.7l?\s*ecoboost/i.test(l)) return "2.7L EcoBoost";
    if (/5\.0\s*(l|liter)?\s*(v8|coyote)?/i.test(l)) return "5.0L V8";
    if (/3\.5\s*(l|liter)?\s*v6/i.test(l)) return "3.5L V6";
    if (/3\.6\s*(l|liter)?\s*v6/i.test(l)) return "3.6L V6";
    if (/2\.0\s*(l|liter)?\s*t|2\.0t/i.test(l)) return "2.0L Turbo";
    const m = t.match(/\b(\d\.\d)\s*(l|liter)\b/i);
    if (m) return `${m[1]}L`;
    return null;
  }

  function parsePaidOff(text) {
    if (!text) return null;
    if (/\b(money|loan|financing)\s+(is\s+)?still\s+owed\b/i.test(text)) return false;
    if (/\b(still owed|financing remaining|loan balance|payoff)\b/i.test(text)) return false;
    if (/not\s+paid\s+off/i.test(text)) return false;
    if (/paid\s+off/i.test(text)) return true;
    return null;
  }

  function parseVin(text) {
    if (!text) return null;
    const labeled = text.match(/\bVIN\b[:#]?\s*([A-HJ-NPR-Z0-9]{17})\b/i);
    if (labeled) return labeled[1].toUpperCase();
    return null;
  }

  function parseVinFallback(text) {
    if (!text) return null;
    const all = String(text);
    const matches = [...all.matchAll(/\b([A-HJ-NPR-Z0-9]{17})\b/g)];
    if (!matches.length) return null;
    for (const m of matches) {
      const idx = m.index || 0;
      const near = all.slice(Math.max(0, idx - 30), Math.min(all.length, idx + 30)).toLowerCase();
      if (/\bvin\b|vehicle identification/.test(near)) return m[1].toUpperCase();
    }
    return matches[0][1].toUpperCase();
  }

  function getPageWideText() {
    const parts = [];
    if (document.title) parts.push(document.title);
    const bodyText = document.body?.innerText || "";
    if (bodyText) parts.push(bodyText);
    const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute("content");
    if (metaDesc) parts.push(metaDesc);
    return parts.join("\n");
  }

  function parseTitleStatus(text) {
    if (!text) return null;

    if (/\b(no title|without title|missing title|lost title|can'?t get title)\b/i.test(text)) return "no_title";

    // Clean title must be checked BEFORE salvage/rebuilt — sellers often write
    // "clean title (no salvage, rebuilt...)" which would otherwise false-match "salvage"
    if (/\bclean\s+title\b/i.test(text)) return "clean_seller_claimed";
    if (/\bt[ií]tulo\s+limpio\b/i.test(text) || /\btitulo\s+limpio\b/i.test(text)) return "clean_seller_claimed";

    // Require salvage/rebuilt not to be negated (e.g. "no salvage history")
    if (/salvage|salvamento/i.test(text) && !/\bno\s+(salvage|salvamento)/i.test(text)) return "salvage";
    if (/rebuilt|rebuild|reconstructed|reconstruido/i.test(text) && !/\bno\s+(rebuilt|rebuild)/i.test(text)) return "rebuilt";
    if (/lien|gravamen/i.test(text)) return "lien";

    return null;
  }

  function inferTitleStatusNotMentioned(sellerText, aboutText, rawTitle) {
    const combined = [sellerText, aboutText, rawTitle].filter(Boolean).join("\n");
    if (!combined) return null;
    if (/\b(title|t[ií]tulo|salvage|salvamento|rebuilt|reconstruido|lien|gravamen)\b/i.test(combined)) {
      return null;
    }
    return "unknown_not_mentioned";
  }

  function parseTrim(text) {
    if (!text) return null;
    const t = String(text);
    // Multi-word trims first (most specific, avoids partial matches)
    const multi = t.match(
      /\b(TRD\s+Pro|TRD\s+Off[-\s]Road|TRD\s+Sport|King\s+Ranch|High\s+Country|1794\s+Edition|EX[-\s]L|Pro[-\s]4X|Lone\s+Star)\b/i
    );
    if (multi) return multi[1].replace(/\s+/g, " ").trim();
    // Single-word trims
    const single = t.match(
      /\b(SR5|TRD|Lariat|Laramie|Raptor|Rubicon|Sahara|Denali|AT4|Z71|Rebel|Limited|Platinum|Premier|Touring|Wildstrack|Tradesman|XLT|SLT|LTZ|LT|LS|XLE|XSE|SL|SV|EX|Sport|SE|LE|LX|GT)\b/i
    );
    return single ? single[1].toUpperCase() : null;
  }

  function inferVehicleTypeHint(text) {
    const t = (text || "").toLowerCase();
    if (/\b(truck|pickup|tundra|f-150|silverado|ram)\b/.test(t)) return "truck";
    if (/\b(suv|fj|4runner|tahoe|suburban|wrangler)\b/.test(t)) return "suv";
    if (/\b(crossover|rav4|cr-v|escape|rogue)\b/.test(t)) return "crossover";
    return null;
  }

  function parseAboutVehicleText(text) {
    const out = {
      transmission: null,
      drivetrain: null,
      fuel_type: null,
      exterior_color: null,
      interior_color: null,
      nhtsa_rating: null,
      mpg_city: null,
      mpg_highway: null,
      mpg_combined: null,
      paid_off: null,
      about_items: []
    };

    if (!text) return out;

    const lines = text
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);

    for (const line of lines) {
      if (line.length < 2) continue;

      out.about_items.push(line);

      if (!out.transmission) {
        const t = parseTransmission(line);
        if (t) out.transmission = t;
      }

      if (!out.drivetrain) {
        const d = parseDrivetrain(line);
        if (d) out.drivetrain = d;
      }

      if (!out.fuel_type) {
        const f = parseFuelType(line);
        if (f) out.fuel_type = f;
      }

      if (out.paid_off == null) {
        const p = parsePaidOff(line);
        if (p != null) out.paid_off = p;
      }

      if (!out.nhtsa_rating) {
        const r = parseNhtsaRating(line);
        if (r != null) out.nhtsa_rating = r;
      }

      if (!out.exterior_color || !out.interior_color) {
        const c = parseColors(line);
        if (c.exterior_color && !out.exterior_color) out.exterior_color = c.exterior_color;
        if (c.interior_color && !out.interior_color) out.interior_color = c.interior_color;
      }

      const mpg = parseMpg(line);
      if (mpg.mpg_city != null && out.mpg_city == null) out.mpg_city = mpg.mpg_city;
      if (mpg.mpg_highway != null && out.mpg_highway == null) out.mpg_highway = mpg.mpg_highway;
      if (mpg.mpg_combined != null && out.mpg_combined == null) out.mpg_combined = mpg.mpg_combined;
    }

    return out;
  }

  function buildNegotiationPoints(v) {
    const pts = [];
    if (!v.title_status) pts.push("Title status not stated — ask if clean/salvage/rebuilt.");
    if (!v.drivetrain) pts.push("Drivetrain not stated — confirm 2WD vs 4WD.");
    if (v.mileage_miles && v.mileage_miles >= 150000) {
      pts.push("High mileage — request maintenance records + pre-purchase inspection.");
    }
    if (!v.vin) pts.push("VIN not listed — ask for VIN to run history check.");
    return pts.slice(0, 6);
  }

  function normalizeSellerDescription(text) {
    if (!text) return null;
    const cleaned = text.replace(/\s+\n/g, "\n").trim();
    if (!cleaned) return null;
    return cleaned.length > 4000 ? `${cleaned.slice(0, 4000)}…` : cleaned;
  }

  let sellerSeeMoreClicked = false;
  function expandSellerDescription() {
    if (sellerSeeMoreClicked) return false;
    const container =
      findSectionContainerByHeading(/^Seller'?s\s+description$/i) ||
      findSectionContainerByHeading(/^Description$/i);
    if (!container) return false;

    const candidates = Array.from(container.querySelectorAll("button, a, span, div"));
    const target = candidates.find((el) => {
      const t = (el.innerText || "").trim();
      if (!t || t.length > 20) return false;
      return /^See more$/i.test(t);
    });
    if (!target) return false;
    target.click();
    sellerSeeMoreClicked = true;
    return true;
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

    const nodes = getCachedEls();

    for (const el of nodes) {
      const t = (el.innerText || "").trim();
      if (!t || t.length > 220) continue;
      const found = extractMileageFromTextBlock(t);
      if (found) return found;
    }

    return { mileage_text: null, mileage_miles: null };
  }

  // Cached per-extraction visible elements list. Reset at the start of each
  // FBCO_extractVehicleSnapshot call to avoid 5–6 expensive full-page DOM scans.
  let _cachedEls = null;
  function getCachedEls() {
    if (!_cachedEls) {
      _cachedEls = Array.from(document.querySelectorAll("span, div, h1, h2, h3"))
        .slice(0, 5000)
        .filter(window.FBCO_isVisible);
    }
    return _cachedEls;
  }

  window.FBCO_extractVehicleSnapshot = function () {
    _cachedEls = null; // reset cache so each extraction sees the current DOM
    // Expand seller description once so we can capture full text on next pass.
    expandSellerDescription();
    const raw = getListingTitleText();
    const parsed = parseYearMakeModel(raw);

    const price_text = findPriceText();
    const price_usd = window.FBCO_parsePriceUSD(price_text);

    const mileage = findMileage();

    const aboutText = findSectionTextByHeading(/^About\s+this\s+vehicle$/i);
    const about = parseAboutVehicleText(aboutText);

    const sellerText =
      findSectionTextByHeading(/^Seller'?s\s+description$/i) ||
      findSectionTextByHeading(/^Description$/i);
    const seller_description = normalizeSellerDescription(sellerText);

    const pageText = getPageWideText();
    const vinFromSeller = parseVin(sellerText);
    const vinFromAbout = parseVin(aboutText);
    const vinFromRaw = parseVin(raw);
    const vinFromPage = parseVin(pageText) || parseVinFallback(pageText);
    const vin = vinFromSeller || vinFromAbout || vinFromRaw || vinFromPage || null;
    const titleFromSeller = parseTitleStatus(sellerText);
    const titleFromAbout = parseTitleStatus(aboutText);
    const titleFromRaw = parseTitleStatus(raw);
    let title_status = titleFromSeller || titleFromAbout || titleFromRaw || null;
    if (!title_status) {
      title_status = inferTitleStatusNotMentioned(sellerText, aboutText, raw);
    }

    const sellerDrivetrain = parseDrivetrain(sellerText);
    const sellerTransmission = parseTransmission(sellerText);
    const sellerEngine = parseEngine(sellerText);
    const titleDrivetrain = parseDrivetrain(raw);
    const titleEngine = parseEngine(raw);
    const descDrivetrain = about.drivetrain || sellerDrivetrain || titleDrivetrain;
    const descTransmission = about.transmission || sellerTransmission;
    const descEngine = sellerEngine || titleEngine;
    const descFuel = about.fuel_type || parseFuelType(sellerText);
    const descColors = parseColors(sellerText);
    const descMpg = parseMpg(sellerText);
    const descNhtsa = about.nhtsa_rating || parseNhtsaRating(sellerText);

    const selectedCategory = getSelectedCategoryLabel();
    const categoryIsVehicle = selectedCategory ? isVehicleCategory(selectedCategory) : null;
    const signalVehicle = hasVehicleSignals();
    const vehicleStatus = categoryIsVehicle === null ? (signalVehicle ? true : null) : categoryIsVehicle;

    const trimFromTitle = parseTrim(raw);
    const trimFromSeller = parseTrim(sellerText);
    const trimFromAbout = parseTrim(aboutText);
    const trim = trimFromTitle || trimFromSeller || trimFromAbout;
    const trim_conflict =
      (trimFromTitle && trimFromSeller && trimFromTitle !== trimFromSeller) ||
      (trimFromTitle && trimFromAbout && trimFromTitle !== trimFromAbout) ||
      (trimFromSeller && trimFromAbout && trimFromSeller !== trimFromAbout) ||
      false;
    const provenance = {
      title_status_source: titleFromSeller
        ? "seller_description"
        : titleFromAbout
          ? "about_vehicle"
          : titleFromRaw
            ? "title"
            : null,
      drivetrain_source: about.drivetrain
        ? "about_vehicle"
        : sellerDrivetrain
          ? "seller_description"
          : titleDrivetrain
            ? "title"
            : null,
      transmission_source: about.transmission ? "about_vehicle" : sellerTransmission ? "seller_description" : null
      ,
      engine_source: sellerEngine ? "seller_description" : titleEngine ? "title" : null,
      vin_source: vinFromSeller
        ? "seller_description"
        : vinFromAbout
          ? "about_vehicle"
          : vinFromRaw
            ? "title"
            : vinFromPage
              ? "page_text"
              : null
    };

    const negotiation_points = buildNegotiationPoints({
      title_status,
      drivetrain: descDrivetrain,
      mileage_miles: mileage.mileage_miles,
      vin
    });
    const vehicle_type_hint = inferVehicleTypeHint(raw || "") || null;

    return {
      url: location.href,
      source_text: raw || null,
      year: parsed?.year || null,
      make: parsed?.make || null,
      model: parsed?.model || null,
      trim: trim || null,
      trim_conflict,
      normalized: parsed?.normalized || null,
      price_text: price_text || null,
      price_usd: price_usd != null ? price_usd : null,
      mileage_text: mileage.mileage_text,
      mileage_miles: mileage.mileage_miles,
      is_vehicle: vehicleStatus,
      transmission: descTransmission || null,
      drivetrain: descDrivetrain || null,
      engine: descEngine || null,
      fuel_type: descFuel || null,
      exterior_color: about.exterior_color || descColors.exterior_color || null,
      interior_color: about.interior_color || descColors.interior_color || null,
      mpg_city: about.mpg_city ?? descMpg.mpg_city ?? null,
      mpg_highway: about.mpg_highway ?? descMpg.mpg_highway ?? null,
      mpg_combined: about.mpg_combined ?? descMpg.mpg_combined ?? null,
      nhtsa_rating: descNhtsa ?? null,
      paid_off: about.paid_off ?? null,
      title_status: title_status || null,
      vin: vin || null,
      seller_description: seller_description || null,
      about_items: about.about_items || [],
      provenance,
      negotiation_points,
      vehicle_type_hint
    };
  };
})();
