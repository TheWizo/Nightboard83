(function (root) {
  function instanceHost(url) {
    try { return new URL(url).host; } catch { return ""; }
  }

  function normalizeInstance(raw) {
    let v = String(raw || "").trim();
    if (!v) return "";
    v = v.replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(v)) v = "https://" + v;
    try {
      const u = new URL(v);
      if (!u.hostname) return "";
      return u.origin;
    } catch {
      return "";
    }
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

  function appBaseUrl(loc) {
    loc = loc || (typeof location !== "undefined" ? location : null);
    if (!loc) return "";
    const origin = loc.origin || "";
    let path = String(loc.pathname || "/");
    if (/\/index\.html$/i.test(path)) path = path.replace(/index\.html$/i, "");
    if (!path.endsWith("/")) path = path.replace(/\/[^/]*$/, "/");
    if (!path.startsWith("/")) path = "/" + path;
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
        return { error: action === "delete" ? "Löschen ohne Status-ID" : "Bearbeitung ohne Status-ID" };
      }
      if (!exists) {
        if (action === "delete") return { done: true };
        return { error: "Post existiert nicht mehr — Bearbeitung nicht gesendet." };
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

  const api = {
    instanceHost,
    normalizeInstance,
    pollIntervalMs,
    maxCharsFromInstance,
    isNetworkError,
    isMissingStatus,
    idNewer,
    appBaseUrl,
    tagNameFromHref,
    mentionAcctFromHref,
    flushPlan,
    escapeHtml,
    sanitize,
  };

  root.NBCore = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
