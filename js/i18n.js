/* Nightboard '83 — UI i18n (DE/EN)
   Copyright (C) 2026 Ralf Wissing
   SPDX-License-Identifier: AGPL-3.0-or-later

   String catalogs live in i18n/de.json and i18n/en.json (dot keys, camelCase leaves).
   Technical Writers: edit those JSON files; keep keys stable. DE is the content source.
*/
(function (root) {
  const SUPPORTED = ["de", "en"];
  const DEFAULT_LOCALE = "de";
  const LS_KEY = "nightboard83.locale";

  const catalogs = { de: null, en: null };
  let locale = DEFAULT_LOCALE;
  let loaded = false;

  function isSupported(code) {
    return SUPPORTED.indexOf(code) !== -1;
  }

  function normalizeLocale(code) {
    const raw = String(code || "").trim().toLowerCase();
    if (!raw) return "";
    if (isSupported(raw)) return raw;
    const base = raw.split("-")[0];
    return isSupported(base) ? base : "";
  }

  function detect() {
    try {
      const fromLs = normalizeLocale(localStorage.getItem(LS_KEY) || "");
      if (fromLs) return fromLs;
    } catch {
      /* ignore */
    }
    try {
      const nav = (typeof navigator !== "undefined" && (navigator.languages || [navigator.language])) || [];
      for (let i = 0; i < nav.length; i++) {
        const hit = normalizeLocale(nav[i]);
        if (hit) return hit;
      }
    } catch {
      /* ignore */
    }
    return DEFAULT_LOCALE;
  }

  function lookup(key, loc) {
    const cat = catalogs[loc];
    if (!cat) return "";
    const v = cat[key];
    return typeof v === "string" ? v : "";
  }

  function resolveKey(key, vars) {
    let k = key;
    if (vars && Object.prototype.hasOwnProperty.call(vars, "count")) {
      const n = Number(vars.count);
      const plural = n === 1 ? key + ".one" : key + ".other";
      if (lookup(plural, locale) || lookup(plural, "en") || lookup(plural, "de")) {
        k = plural;
      }
    }
    return (
      lookup(k, locale) ||
      lookup(k, "en") ||
      lookup(k, "de") ||
      ""
    );
  }

  function interpolate(str, vars) {
    if (!vars) return str;
    return String(str).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => {
      if (!Object.prototype.hasOwnProperty.call(vars, name)) return "{" + name + "}";
      const v = vars[name];
      return v == null ? "" : String(v);
    });
  }

  function t(key, vars) {
    if (!key) return "";
    const raw = resolveKey(key, vars);
    if (!raw) return String(key);
    return interpolate(raw, vars);
  }

  function setAttr(el, name, value) {
    if (!el || value == null) return;
    el.setAttribute(name, value);
  }

  function applyElement(el) {
    if (!el || el.nodeType !== 1) return;
    const key = el.getAttribute("data-i18n");
    if (key) {
      const html = el.getAttribute("data-i18n-html");
      const val = t(key);
      if (html === "1" || html === "true") el.innerHTML = val;
      else el.textContent = val;
    }
    const titleKey = el.getAttribute("data-i18n-title");
    if (titleKey) setAttr(el, "title", t(titleKey));
    const ariaKey = el.getAttribute("data-i18n-aria");
    if (ariaKey) setAttr(el, "aria-label", t(ariaKey));
    const phKey = el.getAttribute("data-i18n-placeholder");
    if (phKey) setAttr(el, "placeholder", t(phKey));
  }

  function applyDom(rootEl) {
    const root = rootEl || (typeof document !== "undefined" ? document : null);
    if (!root || !root.querySelectorAll) return;
    const nodes = root.querySelectorAll("[data-i18n], [data-i18n-title], [data-i18n-aria], [data-i18n-placeholder]");
    nodes.forEach(applyElement);
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.lang = locale;
    }
    paintLangSwitch();
  }

  function paintLangSwitch() {
    if (typeof document === "undefined") return;
    document.querySelectorAll("[data-lang]").forEach((btn) => {
      const code = btn.getAttribute("data-lang");
      const on = code === locale;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", String(on));
    });
  }

  function setLocale(code, opts) {
    const next = normalizeLocale(code) || DEFAULT_LOCALE;
    const persist = !opts || opts.persist !== false;
    locale = next;
    if (persist) {
      try {
        localStorage.setItem(LS_KEY, locale);
      } catch {
        /* ignore */
      }
    }
    applyDom();
    if (typeof document !== "undefined") {
      try {
        document.dispatchEvent(new CustomEvent("nb:locale", { detail: { locale } }));
      } catch {
        /* ignore */
      }
    }
    return locale;
  }

  function getLocale() {
    return locale;
  }

  async function fetchCatalog(code) {
    const url = "./i18n/" + code + ".json";
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("i18n catalog " + code + " HTTP " + res.status);
    const data = await res.json();
    if (!data || typeof data !== "object") throw new Error("i18n catalog " + code + " invalid");
    catalogs[code] = data;
  }

  async function load() {
    await Promise.all([fetchCatalog("de"), fetchCatalog("en")]);
    loaded = true;
    return true;
  }

  function isReady() {
    return loaded;
  }

  /** For tests: inject catalogs without fetch. */
  function _setCatalogs(de, en) {
    catalogs.de = de || {};
    catalogs.en = en || {};
    loaded = true;
  }

  const api = {
    SUPPORTED,
    DEFAULT_LOCALE,
    LS_KEY,
    t,
    setLocale,
    getLocale,
    detect,
    load,
    applyDom,
    isReady,
    _setCatalogs,
  };

  root.NBI18n = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
