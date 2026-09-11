/* Nightboard '83 — local post translation (Bergamot WASM)
   Copyright (C) 2026 Ralf Wissing
   SPDX-License-Identifier: AGPL-3.0-or-later

   Privacy: post text is translated in-browser only. Models/WASM may be
   fetched once and cached locally; text never leaves the device.
*/
(function (root) {
  const MODEL_CACHE = "nightboard83-bergamot-models";
  const ENGINE_BASE = "../assets/bergamot/";
  const REGISTRY_URL = ENGINE_BASE + "registry.json";

  /**
   * Direct registry pair keys (from+to, 4 chars) shipped in registry.json.
   * Includes Mozilla Firefox Translations zh/ja (CDN), plus classic Bergamot S3 pairs.
   * Pivot via en covers e.g. de↔es, de↔zh, es↔ja.
   */
  const REGISTRY_PAIR_KEYS = [
    "bgen", "csen", "deen", "enbg", "encs", "ende", "enes", "enet", "enfr", "enit",
    "enja", "enpt", "enru", "enuk", "enzh", "esen", "eten", "fren", "iten", "jaen",
    "pten", "ruen", "uken", "zhen",
  ];

  const KNOWN_LANGS = Array.from(
    new Set(
      REGISTRY_PAIR_KEYS.flatMap((k) => [k.slice(0, 2), k.slice(2, 4)])
    )
  ).sort();

  const FALLBACK_PAIRS = new Set(REGISTRY_PAIR_KEYS);

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

  function codedError(code, message) {
    const err = new Error(message || code);
    err.code = code;
    return err;
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
    registryPairs = set.size ? set : new Set(FALLBACK_PAIRS);
    return registryPairs;
  }

  /**
   * Sync: true when a direct pair or en-pivot path exists in the registry.
   * Uses loaded registry when available, otherwise shipped FALLBACK_PAIRS.
   */
  function canTranslate(from, to) {
    const a = normalizeLang(from);
    const b = normalizeLang(to);
    if (!a || !b || a === b) return false;
    const pairs = registryPairs || FALLBACK_PAIRS;
    if (pairs.has(a + b)) return true;
    if (a !== "en" && b !== "en" && pairs.has(a + "en") && pairs.has("en" + b)) return true;
    return false;
  }

  async function canTranslatePair(from, to) {
    await loadRegistryPairs();
    return canTranslate(from, to);
  }

  /**
   * Whether the translate control should appear for this post.
   * Requires resolved source ≠ UI target AND an actual translation path.
   */
  function shouldOffer(statusLanguage, text, target) {
    const src = resolveSourceLang(statusLanguage, text);
    const tgt = normalizeLang(target) || targetLocale();
    if (!src || !tgt) return false;
    if (src === tgt) return false;
    return canTranslate(src, tgt);
  }

  async function openModelCache() {
    if (!("caches" in root)) return null;
    try {
      return await caches.open(MODEL_CACHE);
    } catch {
      return null;
    }
  }

  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const bytes = new Uint8Array(digest);
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, "0");
    }
    return out;
  }

  /**
   * Bergamot S3 serves models with Content-Encoding: gzip while registry hashes
   * are for the decompressed payload. SRI therefore fails in browsers — we
   * fetch without integrity, gunzip when needed, then verify SHA-256 ourselves.
   */
  async function gunzipIfNeeded(buffer) {
    const u8 = new Uint8Array(buffer);
    if (u8.length < 2 || u8[0] !== 0x1f || u8[1] !== 0x8b) return buffer;
    if (typeof DecompressionStream === "undefined") {
      throw codedError("downloadFailed", "gzip DecompressionStream unavailable");
    }
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).arrayBuffer();
  }

  async function ensureEngine(onProgress) {
    if (translator) return translator;
    if (enginePromise) return enginePromise;
    if (!wasmSupported()) {
      unavailableReason = "wasm";
      throw codedError("unavailable", "unavailable");
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

          const controller = new AbortController();
          const abort = () => controller.abort();
          const timeout = this.downloadTimeout ? setTimeout(abort, this.downloadTimeout) : null;
          try {
            if (extra && extra.signal) extra.signal.addEventListener("abort", abort);
            let response;
            try {
              response = await fetch(url, {
                credentials: "omit",
                signal: controller.signal,
              });
            } catch (netErr) {
              throw codedError("downloadFailed", (netErr && netErr.message) || "downloadFailed");
            }
            if (!response || !response.ok) {
              throw codedError("downloadFailed", "HTTP " + (response && response.status));
            }
            let buf = await response.arrayBuffer();
            try {
              buf = await gunzipIfNeeded(buf);
            } catch (gzErr) {
              if (gzErr && gzErr.code) throw gzErr;
              throw codedError("downloadFailed", (gzErr && gzErr.message) || "gunzipFailed");
            }
            if (checksum) {
              const hex = await sha256Hex(buf);
              if (hex !== String(checksum).toLowerCase()) {
                throw codedError("downloadFailed", "checksum mismatch");
              }
            }
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
          } finally {
            if (timeout) clearTimeout(timeout);
            if (extra && extra.signal) extra.signal.removeEventListener("abort", abort);
          }
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
      if (err && err.code === "unavailable") {
        unavailableReason = "wasm";
      } else {
        unavailableReason = "error";
      }
      if (err && err.code) throw err;
      throw codedError("downloadFailed", (err && err.message) || "downloadFailed");
    });
    return enginePromise;
  }

  async function translate(text, from, to, opts) {
    const src = normalizeLang(from);
    const tgt = normalizeLang(to) || targetLocale();
    const input = String(text || "");
    if (!input.trim()) return "";
    if (!src || !tgt) {
      throw codedError("unavailable", "unavailable");
    }
    if (src === tgt) return input;

    await loadRegistryPairs();
    if (!canTranslate(src, tgt)) {
      throw codedError("unsupportedPair", "unsupportedPair");
    }
    if (!wasmSupported()) {
      unavailableReason = "wasm";
      throw codedError("unavailable", "unavailable");
    }

    try {
      const tr = await ensureEngine(opts && opts.onProgress);
      if (opts && opts.onProgress) opts.onProgress("loading");
      const html = opts && opts.html === true;
      const res = await tr.translate({ from: src, to: tgt, text: input, html: html });
      return (res && res.target && res.target.text) || "";
    } catch (err) {
      if (err && err.code) throw err;
      const msg = String((err && err.message) || err || "");
      if (/wasm|WebAssembly|Worker/i.test(msg)) {
        unavailableReason = "wasm";
        throw codedError("unavailable", msg);
      }
      throw codedError("downloadFailed", msg || "downloadFailed");
    }
  }

  function isAvailable() {
    return wasmSupported() && unavailableReason !== "wasm";
  }

  function getUnavailableReason() {
    return unavailableReason;
  }

  // Warm registry so shouldOffer can use live keys once ready.
  try {
    loadRegistryPairs().catch(() => {});
  } catch {
    /* ignore */
  }

  const api = {
    normalizeLang,
    langsEqual,
    targetLocale,
    detectFromText,
    resolveSourceLang,
    shouldOffer,
    canTranslate,
    canTranslatePair,
    wasmSupported,
    isAvailable,
    getUnavailableReason,
    translate,
    ensureEngine,
    KNOWN_LANGS,
    REGISTRY_PAIR_KEYS,
    MODEL_CACHE,
    pairKey,
  };

  root.NBTranslate = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
