/* Nightboard '83 — shared pure helpers
   Copyright (C) 2026 Ralf Wissing
   SPDX-License-Identifier: AGPL-3.0-or-later */
(function (root) {
  function instanceHost(url) {
    try { return new URL(url).host; } catch { return ""; }
  }

  function parseInstanceInput(raw) {
    let v = String(raw || "").trim();
    if (!v) return { origin: "", error: "errors.instanceRequired" };
    if (/^https?:$/i.test(v) || /^https?:\/\/$/i.test(v)) {
      return { origin: "", error: "errors.incompleteUrl" };
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^https?:\/\//i.test(v)) {
      return { origin: "", error: "errors.invalidScheme" };
    }
    const candidate = (/^https?:\/\//i.test(v) ? v : "https://" + v).replace(/\/+$/, "");
    let u;
    try {
      u = new URL(candidate);
    } catch {
      return { origin: "", error: "errors.invalidInstanceUrl" };
    }
    if (!u.hostname) {
      return { origin: "", error: "errors.hostnameMissing" };
    }
    const host = u.hostname;
    const isLocalhost = host === "localhost";
    const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
    const isIpv6 = host.includes(":");
    if (!isLocalhost && !isIpv4 && !isIpv6 && !host.includes(".")) {
      return { origin: "", error: "errors.invalidHostname" };
    }
    return { origin: u.origin, error: "" };
  }

  function normalizeInstance(raw) {
    return parseInstanceInput(raw).origin || "";
  }

  function friendlyConnectError(err) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return "errors.offlineFull";
    }
    if (isNetworkError(err)) {
      return "errors.instanceUnreachable";
    }
    const msg = String((err && err.message) || err || "").trim();
    if (!msg || /failed to fetch|networkerror|load failed/i.test(msg)) {
      return "errors.instanceUnreachable";
    }
    return msg;
  }

  function pollIntervalMs(cfg) {
    const raw = cfg && (cfg.poll_minutes ?? cfg.pollMinutes ?? cfg.polling_minutes ?? cfg.poll);
    const minutes = Number(raw);
    if (!Number.isFinite(minutes) || minutes <= 0) return 2 * 60 * 1000;
    const clamped = Math.min(1440, Math.max(0.25, minutes));
    return Math.round(clamped * 60 * 1000);
  }

  function maxCharsFromInstance(data) {
    if (!data || typeof data !== "object") return 0;
    const cfg = data.configuration && data.configuration.statuses;
    const raw = (cfg && cfg.max_characters) ?? data.max_toot_chars ?? data.max_status_chars;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function isNetworkError(err) {
    if (!err) return false;
    if (err.network) return true;
    const msg = String(err.message || err);
    return /failed to fetch|networkerror|load failed|offline|abort/i.test(msg);
  }

  function isMissingStatus(err) {
    if (!err || isNetworkError(err)) return false;
    if (err.status === 404 || err.status === 410) return true;
    const msg = String(err.message || "").toLowerCase();
    return /record not found|status not found|not found|nicht gefunden/.test(msg);
  }

  function idNewer(a, b) {
    if (!a || a === b) return false;
    if (!b) return false;
    const sa = String(a);
    const sb = String(b);
    if (/^\d+$/.test(sa) && /^\d+$/.test(sb)) {
      if (sa.length !== sb.length) return sa.length > sb.length;
      return sa > sb;
    }
    return sa !== sb;
  }

  function relativeAgeLabel(iso, nowMs) {
    const now = nowMs == null ? Date.now() : Number(nowMs);
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t) || !Number.isFinite(now)) return "";
    const d = Math.max(0, (now - t) / 1000);
    if (d < 60) return Math.floor(d) + "s";
    if (d < 5 * 60) return Math.floor(d / 60) + "m";
    if (d < 3600) return Math.floor(d / (5 * 60)) * 5 + "m";
    if (d < 86400) return Math.floor(d / 3600) + "h";
    return Math.floor(d / 86400) + "d";
  }

  function appBaseUrl(loc) {
    loc = loc || (typeof location !== "undefined" ? location : null);
    if (!loc) return "";
    const origin = loc.origin || "";
    let path = String(loc.pathname || "/");
    if (/\/index\.html$/i.test(path)) path = path.replace(/index\.html$/i, "");
    // Directory paths (no "." in final segment) must keep the segment and gain a
    // trailing slash. Only strip a final segment when it looks like a file name.
    if (!path.endsWith("/")) {
      const last = path.split("/").pop() || "";
      if (last.includes(".")) path = path.slice(0, path.length - last.length);
      else path += "/";
    }
    if (!path.startsWith("/")) path = "/" + path;
    if (path !== "/" && !path.endsWith("/")) path += "/";
    return origin + path;
  }

  function tagNameFromHref(href, base) {
    if (!href) return "";
    try {
      const u = new URL(href, base || (typeof location !== "undefined" ? location.href : "https://example.invalid/"));
      const m = u.pathname.match(/\/tags?\/([^/]+)\/?$/i);
      if (m) return decodeURIComponent(m[1]);
    } catch {
      /* ignore */
    }
    return "";
  }

  function mentionAcctFromHref(href, base, localHost) {
    if (!href) return "";
    try {
      const u = new URL(href, base || (typeof location !== "undefined" ? location.href : "https://example.invalid/"));
      let m = u.pathname.match(/\/@([^/]+)\/?$/);
      if (!m) m = u.pathname.match(/\/users\/([^/]+)\/?$/i);
      if (!m) return "";
      let acct = decodeURIComponent(m[1]);
      if (acct.indexOf("@") === -1 && u.host && localHost && u.host.toLowerCase() !== String(localHost).toLowerCase()) {
        acct = acct + "@" + u.host;
      }
      return acct;
    } catch {
      return "";
    }
  }

  function flushPlan(doc, exists) {
    const action = (doc && doc.action) || "create";
    const targetId = (doc && (doc.statusId || (doc.payload && doc.payload.id))) || null;
    if (action === "edit" || action === "delete") {
      if (!targetId) {
        return { error: action === "delete" ? "errors.deleteWithoutStatusId" : "errors.editWithoutStatusId" };
      }
      if (!exists) {
        if (action === "delete") return { done: true };
        return { error: "errors.postGoneEdit" };
      }
      return { method: action === "delete" ? "DELETE" : "PUT", statusId: targetId };
    }
    return { method: "POST" };
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function sanitize(html) {
    if (typeof DOMParser !== "function") return escapeHtml(html || "");
    const doc = new DOMParser().parseFromString("<div>" + (html || "") + "</div>", "text/html");
    const allowed = new Set(["P", "A", "BR", "SPAN", "DEL", "PRE", "CODE", "BLOCKQUOTE", "UL", "OL", "LI", "EM", "STRONG", "B", "I", "IMG"]);
    const walk = (node) => {
      [...node.childNodes].forEach((child) => {
        if (child.nodeType === 1) {
          if (!allowed.has(child.tagName)) {
            const parent = child.parentNode;
            while (child.firstChild) parent.insertBefore(child.firstChild, child);
            parent.removeChild(child);
            return;
          }
          [...child.attributes].forEach((attr) => {
            const n = attr.name.toLowerCase();
            if (child.tagName === "IMG") {
              if (n === "src") {
                if (!/^(https?:)/i.test(String(attr.value || "").trim())) child.removeAttribute(attr.name);
                return;
              }
              if (n === "alt" || n === "class" || n === "title" || n === "width" || n === "height") return;
              child.removeAttribute(attr.name);
              return;
            }
            if (child.tagName === "A" && (n === "href" || n === "rel" || n === "class" || n === "target")) {
              if (n === "href" && !/^(https?:|mailto:|#)/i.test(attr.value)) child.removeAttribute(attr.name);
              return;
            }
            if (n === "class") return;
            child.removeAttribute(attr.name);
          });
          if (child.tagName === "IMG") {
            if (!child.getAttribute("src")) {
              child.remove();
              return;
            }
            child.setAttribute("loading", "lazy");
            child.setAttribute("draggable", "false");
          }
          if (child.tagName === "A") {
            child.setAttribute("target", "_blank");
            child.setAttribute("rel", "noopener noreferrer");
          }
          walk(child);
        } else if (child.nodeType !== 3) {
          child.remove();
        }
      });
    };
    walk(doc.body.firstChild);
    return doc.body.firstChild.innerHTML;
  }


  function pollPercent(votes, total) {
    const v = Number(votes);
    const t = Number(total);
    if (!Number.isFinite(v) || !Number.isFinite(t) || t <= 0 || v <= 0) return 0;
    return Math.round((100 * v) / t);
  }

  function pollTotalVotes(poll) {
    if (!poll || typeof poll !== "object") return 0;
    const n = Number(poll.votes_count);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function pollIsClosed(poll, nowMs) {
    if (!poll || typeof poll !== "object") return true;
    if (poll.expired) return true;
    if (!poll.expires_at) return false;
    const t = new Date(poll.expires_at).getTime();
    if (!Number.isFinite(t)) return false;
    const now = nowMs == null ? Date.now() : Number(nowMs);
    return Number.isFinite(now) && now >= t;
  }

  function pollOwnVotes(poll) {
    if (!poll || !Array.isArray(poll.own_votes)) return [];
    return poll.own_votes
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 0);
  }

  /** True only for a real user vote. Ignores GTS quirk voted:true with empty own_votes and 0 votes. */
  function pollUserVoted(poll) {
    if (!poll || typeof poll !== "object") return false;
    const own = pollOwnVotes(poll);
    if (own.length > 0) return true;
    if (!poll.voted) return false;
    // Spurious after rejected own-poll vote (GTS): voted:true, own_votes:[], votes_count:0
    if (pollTotalVotes(poll) === 0) return false;
    return true;
  }

  /** Compact remaining-time label for future ISO timestamps (mirrors relativeAgeLabel steps). */
  function relativeFutureLabel(iso, nowMs) {
    const now = nowMs == null ? Date.now() : Number(nowMs);
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t) || !Number.isFinite(now)) return "";
    const d = Math.max(0, (t - now) / 1000);
    if (d < 60) return Math.floor(d) + "s";
    if (d < 5 * 60) return Math.floor(d / 60) + "m";
    if (d < 3600) return Math.floor(d / (5 * 60)) * 5 + "m";
    if (d < 86400) return Math.floor(d / 3600) + "h";
    return Math.floor(d / 86400) + "d";
  }

  function applyLangSwitch(cfg, root) {
    const doc = root || (typeof document !== "undefined" ? document : null);
    if (!doc || !doc.querySelectorAll) return;
    const raw = cfg && (cfg.lang_switch ?? cfg.langSwitch ?? cfg.language_switch ?? cfg.showLangSwitch);
    const show = raw === undefined || raw === null ? true : Boolean(raw);
    doc.querySelectorAll(".lang-switch").forEach((el) => {
      el.hidden = !show;
    });
  }

  function federatedEnabled(cfg) {
    const raw = cfg && (cfg.federated ?? cfg.federatedTimeline ?? cfg.federated_timeline ?? cfg.showFederated);
    return raw === undefined || raw === null ? true : Boolean(raw);
  }

  function applyFederatedFlag(cfg, root) {
    const doc = root || (typeof document !== "undefined" ? document : null);
    if (!doc || !doc.querySelectorAll) return;
    const show = federatedEnabled(cfg);
    const col = doc.querySelector('[data-col="federated"]');
    if (col) col.hidden = !show;
    const dock = doc.querySelectorAll('.dock-icon[data-restore="federated"]');
    dock.forEach((el) => { el.hidden = !show; });
  }

  function localEnabled(cfg) {
    const raw = cfg && (cfg.local ?? cfg.localTimeline ?? cfg.local_timeline ?? cfg.showLocal);
    return raw === undefined || raw === null ? true : Boolean(raw);
  }

  function applyLocalFlag(cfg, root) {
    const doc = root || (typeof document !== "undefined" ? document : null);
    if (!doc || !doc.querySelectorAll) return;
    const show = localEnabled(cfg);
    const col = doc.querySelector('[data-col="local"]');
    if (col) col.hidden = !show;
    const dock = doc.querySelectorAll('.dock-icon[data-restore="local"]');
    dock.forEach((el) => { el.hidden = !show; });
  }

  const THEMES = ["default"];

  const THEME_META_COLORS = {
    "default": "#241b2f",
  };

  function normalizeTheme(cfg) {
    const raw = String((cfg && (cfg.theme ?? cfg.skin)) || "").trim().toLowerCase();
    return THEMES.indexOf(raw) !== -1 ? raw : "default";
  }

  function applyTheme(cfg, root) {
    const doc = root || (typeof document !== "undefined" ? document : null);
    if (!doc || !doc.body) return;
    const theme = normalizeTheme(cfg);
    THEMES.forEach((t) => {
      if (t !== "default") doc.body.classList.remove("theme-" + t);
    });
    if (theme !== "default") doc.body.classList.add("theme-" + theme);
    const meta = doc.querySelector('meta[name="theme-color"]');
    if (meta && THEME_META_COLORS[theme]) meta.setAttribute("content", THEME_META_COLORS[theme]);
  }

  const api = {
    instanceHost,
    parseInstanceInput,
    normalizeInstance,
    friendlyConnectError,
    pollIntervalMs,
    maxCharsFromInstance,
    isNetworkError,
    isMissingStatus,
    idNewer,
    relativeAgeLabel,
    relativeFutureLabel,
    pollPercent,
    pollTotalVotes,
    pollIsClosed,
    pollOwnVotes,
    pollUserVoted,
    appBaseUrl,
    tagNameFromHref,
    mentionAcctFromHref,
    flushPlan,
    escapeHtml,
    sanitize,
    applyLangSwitch,
    federatedEnabled,
    applyFederatedFlag,
    localEnabled,
    applyLocalFlag,
    normalizeTheme,
    applyTheme,
    THEMES,
  };

  root.NBCore = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
