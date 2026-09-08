/* Nightboard '83 — local post translation (Bergamot WASM)
   Copyright (C) 2026 Ralf Wissing
   SPDX-License-Identifier: AGPL-3.0-or-later

   Privacy: post text is translated in-browser only. Models/WASM may be
   fetched once and cached locally; text never leaves the device.
*/
(function (root) {
  const MODEL_CACHE = "nightboard83-bergamot-models";
  const ENGINE_BASE = "./assets/bergamot/";
  const REGISTRY_URL = ENGINE_BASE + "registry.json";

  /** Language pairs present in the shipped registry (direct; pivot via en otherwise). */
  const KNOWN_LANGS = ["bg", "cs", "de", "en", "es", "et", "fr", "it", "pt", "ru", "uk"];

  let enginePromise = null;
  let translator = null;
  let unavailableReason = "";
  let registryPairs = null;

  function normalizeLang(code) {
    if (!code) return "";
    const raw = String(code).trim().toLowerCase().replace("_", "-");
    if (!raw || raw === "und" || raw === "zxx" || raw === "null") return "";
    const base = raw.split("-")[0];
    if (base.length !== 2) return "";
    return base;
  }

  function langsEqual(a, b) {
    const x = normalizeLang(a);
    const y = normalizeLang(b);
    return Boolean(x && y && x === y);
  }

  function targetLocale() {
    try {
      if (root.NBI18n && typeof root.NBI18n.getLocale === "function") {
        const loc = normalizeLang(root.NBI18n.getLocale());
        if (loc) return loc;
      }
    } catch {
      /* ignore */
    }
    try {
      const nav = (typeof navigator !== "undefined" && (navigator.languages || [navigator.language])) || [];
      for (let i = 0; i < nav.length; i++) {
        const hit = normalizeLang(nav[i]);
        if (hit) return hit;
      }
    } catch {
      /* ignore */
    }
    return "de";
  }

  /**
   * Lightweight local detect for short social posts when status.language is missing.
   * Prefers DE/EN (Nightboard UI langs); otherwise returns "".
   */
  function detectFromText(text) {
    const s = String(text || "")
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/[@#]\w+/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (s.length < 12) return "";
    if (/[äöüßÄÖÜ]/.test(s)) return "de";
    const lower = s.toLowerCase();
    const deHits = (lower.match(/\b(der|die|das|und|nicht|ich|ist|ein|eine|mit|auf|für|auch|den|dem|von|zu|sich|wir|sie)\b/g) || []).length;
    const enHits = (lower.match(/\b(the|and|is|are|you|that|with|for|this|have|not|was|from|they|will|your)\b/g) || []).length;
    if (deHits >= 2 && deHits > enHits) return "de";
    if (enHits >= 2 && enHits > deHits) return "en";
    if (deHits > enHits && deHits >= 1) return "de";
    if (enHits > deHits && enHits >= 1) return "en";
    return "";
  }

  function resolveSourceLang(statusLanguage, text) {
    const fromStatus = normalizeLang(statusLanguage);
    if (fromStatus) return fromStatus;
    return detectFromText(text);
  }

  function wasmSupported() {
    try {
      if (typeof WebAssembly !== "object" || typeof WebAssembly.instantiate !== "function") return false;
      if (typeof Worker === "undefined") return false;
      const buf = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      if (typeof WebAssembly.validate === "function" && !WebAssembly.validate(buf)) return false;
      return true;
    } catch {
      return false;
    }
  }

  function pairKey(from, to) {
    return normalizeLang(from) + normalizeLang(to);
  }

  async function loadRegistryPairs() {
    if (registryPairs) return registryPairs;
    const set = new Set();
    try {
      const res = await fetch(REGISTRY_URL, { credentials: "omit", cache: "force-cache" });
      if (res.ok) {
        const data = await res.json();
        Object.keys(data || {}).forEach((k) => {
          if (k && k.length === 4) set.add(k);
        });
      }
    } catch {
      /* ignore — fall back to known list */
    }
    if (!set.size) {
      KNOWN_LANGS.forEach((a) => {
        KNOWN_LANGS.forEach((b) => {
          if (a !== b) set.add(a + b);
        });
      });
    }
    registryPairs = set;
    return set;
  }

  async function canTranslatePair(from, to) {
    const a = normalizeLang(from);
    const b = normalizeLang(to);
    if (!a || !b || a === b) return false;
    const pairs = await loadRegistryPairs();
    if (pairs.has(a + b)) return true;
    if (a !== "en" && b !== "en" && pairs.has(a + "en") && pairs.has("en" + b)) return true;
    return false;
  }

  /**
   * Whether the translate control should appear for this post.
   * Sync gate: known source ≠ target. Pair availability checked async on click.
   */
  function shouldOffer(statusLanguage, text, target) {
    const src = resolveSourceLang(statusLanguage, text);
    const tgt = normalizeLang(target) || targetLocale();
    if (!src || !tgt) return false;
    if (src === tgt) return false;
    return true;
  }

  async function openModelCache() {
    if (!("caches" in root)) return null;
    try {
      return await caches.open(MODEL_CACHE);
    } catch {
      return null;
    }
  }

  async function ensureEngine(onProgress) {
    if (translator) return translator;
    if (enginePromise) return enginePromise;
    if (!wasmSupported()) {
      unavailableReason = "wasm";
      const err = new Error("unavailable");
      err.code = "unavailable";
      throw err;
    }
    enginePromise = (async () => {
      if (onProgress) onProgress("downloading");
      const mod = await import(/* webpackIgnore: true */ ENGINE_BASE + "translator.js");
      const { LatencyOptimisedTranslator, TranslatorBacking } = mod;

      class CachedBacking extends TranslatorBacking {
        constructor(options) {
          super(options);
        }
        async fetch(url, checksum, extra) {
          const cache = await openModelCache();
          if (cache) {
            try {
              const hit = await cache.match(url);
              if (hit && hit.ok) return await hit.arrayBuffer();
            } catch {
              /* ignore */
            }
          }
          if (onProgress) onProgress("downloading");
          const buf = await super.fetch(url, checksum, extra);
          if (cache && buf) {
            try {
              await cache.put(
                url,
                new Response(buf.slice(0), {
                  headers: { "Content-Type": "application/octet-stream" },
                })
              );
            } catch {
              /* ignore quota */
            }
          }
          return buf;
        }
      }

      const options = {
        registryUrl: REGISTRY_URL,
        cacheSize: 200,
        downloadTimeout: 120000,
        pivotLanguage: "en",
        onerror: (err) => {
          console.warn("Bergamot worker:", err && err.message ? err.message : err);
        },
      };
      const backing = new CachedBacking(options);
      const tr = new LatencyOptimisedTranslator(options, backing);
      await tr.worker;
      translator = tr;
      return tr;
    })().catch((err) => {
      enginePromise = null;
      unavailableReason = "error";
      throw err;
    });
    return enginePromise;
  }

  async function translate(text, from, to, opts) {
    const src = normalizeLang(from);
    const tgt = normalizeLang(to) || targetLocale();
    const input = String(text || "");
    if (!input.trim()) return "";
    if (!src || !tgt) {
      const err = new Error("unavailable");
      err.code = "unavailable";
      throw err;
    }
    if (src === tgt) return input;
    const ok = await canTranslatePair(src, tgt);
    if (!ok) {
      const err = new Error("unavailable");
      err.code = "unavailable";
      throw err;
    }
    const tr = await ensureEngine(opts && opts.onProgress);
    if (opts && opts.onProgress) opts.onProgress("loading");
    const html = opts && opts.html === true;
    const res = await tr.translate({ from: src, to: tgt, text: input, html: html });
    return (res && res.target && res.target.text) || "";
  }

  function isAvailable() {
    return wasmSupported() && unavailableReason !== "wasm";
  }

  function getUnavailableReason() {
    return unavailableReason;
  }

  const api = {
    normalizeLang,
    langsEqual,
    targetLocale,
    detectFromText,
    resolveSourceLang,
    shouldOffer,
    canTranslatePair,
    wasmSupported,
    isAvailable,
    getUnavailableReason,
    translate,
    ensureEngine,
    KNOWN_LANGS,
    MODEL_CACHE,
  };

  root.NBTranslate = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
