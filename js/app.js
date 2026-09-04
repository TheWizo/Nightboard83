(() => {
  let INSTANCE = "";
  let POLL_MS = 2 * 60 * 1000;
  const SCOPES = "read write follow push";
  const OOB = "urn:ietf:wg:oauth:2.0:oob";
  const COLS = ["home", "local", "notifications"];
  const LS = {
    app: "nightboard83.app",
    token: "nightboard83.token",
    me: "nightboard83.me",
    instance: "nightboard83.instance",
    collapsed: "nightboard83.collapsed",
  };

  const $ = (id) => document.getElementById(id);

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

  function paintInstanceLabel(host) {
    const el = $("instance-label");
    if (el) el.textContent = host || "";
  }

  function setInstance(url, persist) {
    INSTANCE = url || "";
    const host = instanceHost(INSTANCE);
    paintInstanceLabel(host);
    const input = $("instance-input");
    if (input && host && document.activeElement !== input) input.value = host;
    if (persist && INSTANCE) localStorage.setItem(LS.instance, INSTANCE);
  }

  function applyInstanceFromInput() {
    const url = normalizeInstance($("instance-input") ? $("instance-input").value : "");
    if (!url) return "";
    const prev = localStorage.getItem(LS.instance) || "";
    if (prev && prev !== url) localStorage.removeItem(LS.app);
    setInstance(url, true);
    return url;
  }

  async function loadConfig() {
    try {
      const res = await fetch("./config.json", { cache: "no-store" });
      if (!res.ok) return {};
      const data = await res.json();
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  }

  function pollIntervalMs(cfg) {
    const raw = cfg && (cfg.poll_minutes ?? cfg.pollMinutes ?? cfg.polling_minutes ?? cfg.poll);
    const minutes = Number(raw);
    if (!Number.isFinite(minutes) || minutes <= 0) return 2 * 60 * 1000;
    const clamped = Math.min(1440, Math.max(0.25, minutes));
    return Math.round(clamped * 60 * 1000);
  }

  async function initInstance() {
    const cfg = await loadConfig();
    const fromLs = normalizeInstance(localStorage.getItem(LS.instance) || "");
    const fromCfg = normalizeInstance(cfg.instance || cfg.url || cfg.host || "");
    setInstance(fromLs || fromCfg, Boolean(fromLs));
    POLL_MS = pollIntervalMs(cfg);
  }
  const state = {
    token: localStorage.getItem(LS.token) || "",
    me: null,
    timelines: {
      home: { items: [], maxId: null, loading: false, done: false },
      local: { items: [], maxId: null, loading: false, done: false },
      notifications: { items: [], maxId: null, loading: false, done: false },
    },
    replyTo: null,
    expandedCol: null,
    collapsed: { home: true, local: true, notifications: true },
    colBusy: false,
    threadRootId: null,
    threadReplyTo: null,
    threadById: new Map(),
    pollTimer: null,
    conn: "unknown",
    carrierTimer: null,
    flushing: false,
    mediaView: null,
  };

  function api(path, opts = {}) {
    const headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
    if (state.token) headers.Authorization = "Bearer " + state.token;
    if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== "string") {
      headers["Content-Type"] = "application/json";
      opts = Object.assign({}, opts, { body: JSON.stringify(opts.body) });
    }
    return fetch(INSTANCE + path, Object.assign({ headers }, opts)).then(
      async (res) => {
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        if (!res.ok) {
          const msg = (data && (data.error || data.error_description)) || res.statusText;
          throw new Error(msg);
        }
        return data;
      },
      (err) => {
        const wrap = err instanceof Error ? err : new Error(String(err || "Failed to fetch"));
        wrap.network = true;
        throw wrap;
      }
    );
  }

  function isNetworkError(err) {
    if (!err) return false;
    if (err.network) return true;
    const msg = String(err.message || err);
    return /failed to fetch|networkerror|load failed|offline|abort/i.test(msg);
  }

  function statusSnapshot(status) {
    if (!status) return null;
    const s = status.reblog || status;
    return {
      id: s.id,
      created_at: s.created_at,
      content: s.content,
      spoiler_text: s.spoiler_text,
      account: s.account,
      media_attachments: s.media_attachments || [],
      mentions: s.mentions || [],
      url: s.url,
      visibility: s.visibility,
      replies_count: s.replies_count,
    };
  }

  function paintConn(kind, text) {
    const el = $("conn-status");
    if (!el) return;
    el.textContent = text;
    el.className = "conn-status " + kind;
  }

  function finishCarrierLost() {
    state.carrierTimer = null;
    if (state.conn !== "carrier-lost") return;
    state.conn = "offline";
    paintConn("is-offline", " - not connected");
  }

  function setConn(next) {
    if (next === "offline" && state.conn === "online") {
      state.conn = "carrier-lost";
      paintConn("is-carrier-lost", " - §$%&?$ CARRIER LOST");
      if (state.carrierTimer) clearTimeout(state.carrierTimer);
      state.carrierTimer = setTimeout(finishCarrierLost, 30000);
      return;
    }
    if (next === "offline" && state.conn === "carrier-lost") return;
    if (next === state.conn) return;
    if (next === "online") {
      if (state.carrierTimer) {
        clearTimeout(state.carrierTimer);
        state.carrierTimer = null;
      }
      state.conn = "online";
      paintConn("is-connected", " - connected");
      tryFlushOutbox();
      return;
    }
    if (next === "offline") {
      if (state.carrierTimer) {
        clearTimeout(state.carrierTimer);
        state.carrierTimer = null;
      }
      state.conn = "offline";
      paintConn("is-offline", " - not connected");
    }
  }

  async function probeConn() {
    if (!INSTANCE) {
      setConn("offline");
      return;
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(INSTANCE + "/api/v1/instance", { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(timer);
      setConn(res.ok ? "online" : "offline");
    } catch {
      setConn("offline");
    }
  }

  function startConnWatch() {
    window.addEventListener("online", () => probeConn());
    window.addEventListener("offline", () => setConn("offline"));
    setInterval(probeConn, 20000);
    if (navigator.onLine) setConn("online");
    else setConn("offline");
    probeConn();
  }

  async function refreshOutboxBadge() {
    const btn = $("btn-outbox");
    if (!btn) return;
    if (!state.token || !window.RetroDB) {
      btn.hidden = true;
      return;
    }
    const list = await RetroDB.listOutbox();
    const n = list.length;
    $("outbox-count").textContent = String(n);
    btn.hidden = n === 0;
    btn.setAttribute("aria-label", "Postausgang (" + n + ")");
  }

  async function publishStatus(payload, context) {
    if (state.conn === "online") {
      try {
        return await api("/api/v1/statuses", { method: "POST", body: payload });
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        setConn("offline");
      }
    }
    if (!window.RetroDB) throw new Error("Offline-Speicher nicht verfügbar");
    await RetroDB.enqueue({ payload, context: context || null });
    await refreshOutboxBadge();
    return { queued: true };
  }

  async function tryFlushOutbox() {
    if (state.flushing || state.conn !== "online" || !state.token || !window.RetroDB) return;
    state.flushing = true;
    let sent = 0;
    try {
      const docs = await RetroDB.listOutbox();
      for (const doc of docs) {
        try {
          await api("/api/v1/statuses", { method: "POST", body: doc.payload });
          await RetroDB.removeOutbox(doc._id);
          sent += 1;
        } catch (err) {
          if (isNetworkError(err)) {
            setConn("offline");
            break;
          }
          await RetroDB.updateOutbox(doc._id, { error: err.message });
        }
      }
    } finally {
      state.flushing = false;
      await refreshOutboxBadge();
      if ($("outbox-dialog").open) openOutbox();
      if (sent) {
        loadTimeline("home", true);
        loadTimeline("local", true);
      }
    }
  }

  function renderOutboxList(docs) {
    if (!docs.length) return "<p class='empty'>Postausgang leer.</p>";
    return docs
      .map((doc) => {
        const ctx = doc.context && doc.context.status;
        const isReply = Boolean(doc.payload && doc.payload.in_reply_to_id);
        const contextHtml =
          isReply && ctx
            ? `<div class="outbox-context"><p class="hint">Antwort auf</p>${statusHtml(ctx, { hideActions: true })}</div>`
            : isReply
              ? `<p class="hint">Antwort auf Post ${escapeHtml(doc.payload.in_reply_to_id)}</p>`
              : `<p class="hint">Neuer Post</p>`;
        return `<article class="outbox-item" data-outbox-id="${escapeHtml(doc._id)}">
          ${contextHtml}
          <textarea class="outbox-edit" maxlength="5000">${escapeHtml(doc.payload.status || "")}</textarea>
          <div class="outbox-actions">
            <button type="button" data-outbox-save="${escapeHtml(doc._id)}">Speichern</button>
            <button type="button" class="danger" data-outbox-del="${escapeHtml(doc._id)}">Löschen</button>
          </div>
          ${doc.error ? `<p class="error">${escapeHtml(doc.error)}</p>` : `<p class="hint">Wartet auf Versand</p>`}
        </article>`;
      })
      .join("");
  }

  async function openOutbox() {
    const dlg = $("outbox-dialog");
    $("outbox-body").innerHTML = "<p class='hint'>Lade Postausgang…</p>";
    if (!dlg.open) dlg.showModal();
    const docs = window.RetroDB ? await RetroDB.listOutbox() : [];
    $("outbox-body").innerHTML = renderOutboxList(docs);
    if (window.RetroDB) RetroDB.hydrateMedia($("outbox-body"));
  }

  function loadMeCached() {
    try { state.me = JSON.parse(localStorage.getItem(LS.me) || "null"); } catch { state.me = null; }
  }

  function setLoggedIn(on) {
    $("login-panel").hidden = on;
    $("columns").hidden = !on;
    $("btn-login").hidden = on;
    $("btn-logout").hidden = !on;
    $("btn-compose").hidden = !on;
    $("btn-search").hidden = !on;
    $("btn-profile").hidden = !on;
    $("app").classList.toggle("is-logged-in", on);
    refreshOutboxBadge();
    if (on) {
      state.collapsed = readCollapsed();
      paintCollapsed();
    } else {
      const dock = $("col-dock");
      if (dock) dock.hidden = true;
      const logo = $("desktop-logo");
      if (logo) logo.hidden = true;
    }
  }

  async function ensureApp() {
    const cached = localStorage.getItem(LS.app);
    if (cached) {
      try {
        const app = JSON.parse(cached);
        if (app && app.client_id && app._instance === INSTANCE) return app;
      } catch { /* re-register */ }
    }
    const body = new URLSearchParams({
      client_name: "Nightboard '83",
      redirect_uris: OOB,
      scopes: SCOPES,
      website: INSTANCE,
    });
    const app = await fetch(INSTANCE + "/api/v1/apps", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    }).then(async (r) => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "App-Registrierung fehlgeschlagen");
      return data;
    });
    app._instance = INSTANCE;
    localStorage.setItem(LS.app, JSON.stringify(app));
    return app;
  }

  async function startOAuth() {
    try {
      if (!applyInstanceFromInput()) {
        $("login-status").textContent = "Bitte eine gültige Instanz eintragen.";
        return;
      }
      $("login-status").textContent = "App wird registriert…";
      const app = await ensureApp();
      const url =
        INSTANCE +
        "/oauth/authorize?" +
        new URLSearchParams({
          client_id: app.client_id,
          redirect_uri: OOB,
          response_type: "code",
          scope: SCOPES,
        }).toString();
      window.open(url, "_blank", "noopener");
      $("login-status").textContent = "Im neuen Tab freigeben, Code hier einfügen.";
    } catch (err) {
      $("login-status").textContent = err.message;
    }
  }

  async function exchangeCode() {
    const code = $("oauth-code").value.trim();
    if (!code) {
      $("login-status").textContent = "Bitte Code einfügen.";
      return;
    }
    try {
      if (!applyInstanceFromInput()) {
        $("login-status").textContent = "Bitte eine gültige Instanz eintragen.";
        return;
      }
      const app = await ensureApp();
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: app.client_id,
        client_secret: app.client_secret,
        redirect_uri: OOB,
        code,
        scope: SCOPES,
      });
      const token = await fetch(INSTANCE + "/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
      }).then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error_description || data.error || "Token fehlgeschlagen");
        return data;
      });
      state.token = token.access_token;
      localStorage.setItem(LS.token, state.token);
      await refreshMe();
      $("login-status").textContent = "Verbunden.";
      bootApp();
    } catch (err) {
      $("login-status").textContent = err.message;
    }
  }

  async function refreshMe() {
    state.me = await api("/api/v1/accounts/verify_credentials");
    localStorage.setItem(LS.me, JSON.stringify(state.me));
  }

  function logout() {
    state.token = "";
    state.me = null;
    localStorage.removeItem(LS.token);
    localStorage.removeItem(LS.me);
    setColumnExpanded(null);
    state.colBusy = false;
    closeThread();
    stopPolling();
    setLoggedIn(false);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function sanitize(html) {
    const doc = new DOMParser().parseFromString("<div>" + (html || "") + "</div>", "text/html");
    const allowed = new Set(["P", "A", "BR", "SPAN", "DEL", "PRE", "CODE", "BLOCKQUOTE", "UL", "OL", "LI", "EM", "STRONG", "B", "I"]);
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
            if (child.tagName === "A" && (n === "href" || n === "rel" || n === "class" || n === "target")) {
              if (n === "href" && !/^(https?:|mailto:|#)/i.test(attr.value)) child.removeAttribute(attr.name);
              return;
            }
            if (n === "class") return;
            child.removeAttribute(attr.name);
          });
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

  function relTime(iso) {
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return Math.max(0, Math.floor(d)) + "s";
    if (d < 3600) return Math.floor(d / 60) + "m";
    if (d < 86400) return Math.floor(d / 3600) + "h";
    return Math.floor(d / 86400) + "d";
  }

  function accountLine(acct) {
    const id = escapeHtml(acct.id);
    return (
      `<button type="button" class="acct-open" data-acct-open="${id}">` +
      `<img class="avatar" alt="" src="${escapeHtml(acct.avatar_static || acct.avatar || "")}" />` +
      `<div class="who">` +
      `<div class="display">${escapeHtml(acct.display_name || acct.username)}</div>` +
      `<div class="acct">@${escapeHtml(acct.acct)} · <span class="time"></span></div>` +
      `</div>` +
      `</button>`
    );
  }

  function mediaBlock(status) {
    const atts = status.media_attachments || [];
    if (!atts.length) return "";
    return (
      `<div class="media">` +
      atts
        .map((m) => {
          const type = m.type || "image";
          const preview = m.preview_url || m.url || "";
          const full = m.url || m.remote_url || preview;
          const alt = m.description || "";
          const play = type === "video" || type === "gifv" || type === "audio";
          const label = type === "video" || type === "gifv" ? "Video anzeigen" : type === "audio" ? "Audio anzeigen" : "Bild anzeigen";
          const img = preview && type !== "audio"
            ? `<img alt="${escapeHtml(alt)}" loading="lazy" src="${escapeHtml(preview)}" />`
            : `<span class="media-thumb-fallback" aria-hidden="true">${type === "audio" ? "♪" : "▣"}</span>`;
          return `<button type="button" class="media-thumb" data-media-open title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" data-media-url="${escapeHtml(full)}" data-media-preview="${escapeHtml(preview)}" data-media-type="${escapeHtml(type)}" data-media-alt="${escapeHtml(alt)}">${img}${play ? `<span class="media-play" aria-hidden="true">▶</span>` : ""}</button>`;
        })
        .join("") +
      `</div>`
    );
  }

  function statusHtml(status, opts = {}) {
    const boosted = status.reblog ? status : null;
    const s = status.reblog || status;
    const cw = s.spoiler_text
      ? `<div class="cw"><strong>${escapeHtml(s.spoiler_text)}</strong><br /><button type="button" data-act="cw">CW zeigen</button></div>`
      : "";
    const body = `<div class="content"${s.spoiler_text ? " hidden" : ""}>${sanitize(s.content)}</div>`;
    const boostLine = boosted
      ? `<div class="boost-line">↻ <button type="button" class="acct-open-inline" data-acct-open="${escapeHtml(boosted.account.id)}">${escapeHtml(boosted.account.display_name || boosted.account.username)}</button> boosted</div>`
      : "";
    const extraClass = opts.root ? " is-thread-root" : "";
    return `<article class="status${extraClass}" data-id="${escapeHtml(s.id)}" data-acct="${escapeHtml(s.account.id)}">
      ${boostLine}
      <div class="status-head">${accountLine(s.account)}</div>
      ${cw}${body}${mediaBlock(s)}
      ${opts.hideActions ? "" : `<div class="actions">
        <button type="button" data-act="reply">↩ ${s.replies_count || 0}</button>
        <button type="button" data-act="boost" class="${s.reblogged ? "on-boost" : ""}">↻ ${s.reblogs_count || 0}</button>
        <button type="button" data-act="fav" class="${s.favourited ? "on-fav" : ""}">★ ${s.favourites_count || 0}</button>
        <button type="button" data-act="open">Profil</button>
      </div>`}
    </article>`;
  }

  function paintTime(root, iso) {
    const el = root.querySelector(".time");
    if (el) el.textContent = relTime(iso);
  }

  function renderStatusList(el, items, emptyText) {
    if (!items.length) {
      el.innerHTML = `<div class="empty">${escapeHtml(emptyText)}</div>`;
      return;
    }
    el.innerHTML = items.map((s) => statusHtml(s)).join("");
    [...el.querySelectorAll(".status")].forEach((node, i) => {
      const s = items[i].reblog || items[i];
      paintTime(node, s.created_at);
    });
    if (window.RetroDB) RetroDB.hydrateMedia(el);
  }

  function noticeHtml(n) {
    const kind = {
      follow: "folgt dir",
      follow_request: "möchte folgen",
      mention: "hat dich erwähnt",
      reblog: "hat geboostet",
      favourite: "hat favorisiert",
      poll: "Umfrage beendet",
      status: "neuer Post",
      update: "Post bearbeitet",
    }[n.type] || n.type;
    const status = n.status ? statusHtml(n.status) : "";
    return `<div class="notice" data-acct="${escapeHtml(n.account.id)}">
      <div class="notif-kind"><button type="button" class="acct-open-inline" data-acct-open="${escapeHtml(n.account.id)}">${escapeHtml(n.account.acct)}</button> ${kind}</div>
      <div class="status-head">${accountLine(n.account)}</div>
      ${status}
    </div>`;
  }

  function renderNotifications(el, items) {
    if (!items.length) {
      el.innerHTML = `<div class="empty">Keine Notifications.</div>`;
      return;
    }
    el.innerHTML = items.map((n) => noticeHtml(n)).join("");
    [...el.children].forEach((node, i) => paintTime(node, items[i].created_at));
    if (window.RetroDB) RetroDB.hydrateMedia(el);
  }

  async function loadTimeline(name, reset) {
    const t = state.timelines[name];
    if (t.loading || (t.done && !reset)) return;
    t.loading = true;
    const el = $(name + "-body");
    if (reset) {
      t.items = [];
      t.maxId = null;
      t.done = false;
      el.innerHTML = `<div class="empty">Lade…</div>`;
    }
    try {
      let path;
      if (name === "home") path = "/api/v1/timelines/home?limit=30";
      else if (name === "local") path = "/api/v1/timelines/public?local=true&limit=30";
      else path = "/api/v1/notifications?limit=30";
      if (t.maxId) path += "&max_id=" + encodeURIComponent(t.maxId);
      const batch = await api(path);
      if (!batch.length) t.done = true;
      else {
        t.items = t.items.concat(batch);
        t.maxId = batch[batch.length - 1].id;
      }
      if (name === "notifications") renderNotifications(el, t.items);
      else renderStatusList(el, t.items, "Noch keine Posts.");
      if (window.RetroDB) {
        RetroDB.saveTimeline(name, t.items);
        t.items.forEach((it) => {
          RetroDB.cacheItemMedia(it);
          const inner = it.reblog || it;
          if (inner && inner.id && !it.type) RetroDB.saveStatus(inner);
          if (it.status) RetroDB.saveStatus(it.status);
        });
      }
    } catch (err) {
      if (window.RetroDB) {
        const cached = await RetroDB.loadTimeline(name);
        if (cached.length) {
          t.items = cached;
          t.maxId = cached[cached.length - 1].id;
          t.done = false;
          if (name === "notifications") renderNotifications(el, t.items);
          else renderStatusList(el, t.items, "Noch keine Posts.");
          return;
        }
      }
      el.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
    } finally {
      t.loading = false;
    }
  }

  function bindColumnScroll(name) {
    const el = $(name + "-body");
    el.addEventListener("scroll", () => {
      if (el.scrollTop + el.clientHeight > el.scrollHeight - 200) loadTimeline(name, false);
    });
  }

  function detailWindowOpen() {
    const thread = $("thread-dialog");
    const overlay = $("overlay-dialog");
    const outbox = $("outbox-dialog");
    return (thread && thread.open) || (overlay && overlay.open) || (outbox && outbox.open);
  }

  function timelinePath(name, extra) {
    let path;
    if (name === "home") path = "/api/v1/timelines/home?limit=30";
    else if (name === "local") path = "/api/v1/timelines/public?local=true&limit=30";
    else path = "/api/v1/notifications?limit=30";
    if (extra) path += extra;
    return path;
  }

  function prependTicker(name, fresh) {
    const el = $(name + "-body");
    if (!el) return;
    const placeholder = el.querySelector(".empty, .error");
    if (placeholder) placeholder.remove();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pinScroll = el.scrollTop > 24;
    const prevHeight = el.scrollHeight;
    const nodes = fresh.map((item) => {
      const wrap = document.createElement("div");
      if (name === "notifications") wrap.innerHTML = noticeHtml(item);
      else wrap.innerHTML = statusHtml(item);
      const node = wrap.firstElementChild;
      const timed = item.reblog || item;
      paintTime(node, timed.created_at);
      return node;
    });
    nodes.slice().reverse().forEach((node, revI) => {
      if (!reduce) {
        node.classList.add("is-ticker");
        node.style.animationDelay = revI * 0.16 + "s";
        node.addEventListener(
          "animationend",
          () => {
            node.classList.remove("is-ticker");
            node.style.animationDelay = "";
          },
          { once: true }
        );
      }
      el.insertBefore(node, el.firstChild);
    });
    if (pinScroll) el.scrollTop = el.scrollHeight - prevHeight + el.scrollTop;
    if (window.RetroDB) RetroDB.hydrateMedia(el);
  }

  async function fetchNewer(name) {
    const t = state.timelines[name];
    if (!t || t.loading || !t.items.length) return;
    const sinceId = t.items[0] && t.items[0].id;
    if (!sinceId) return;
    try {
      const batch = await api(timelinePath(name, "&since_id=" + encodeURIComponent(sinceId)));
      if (!Array.isArray(batch) || !batch.length) return;
      const known = new Set(t.items.map((s) => s.id));
      const fresh = batch.filter((s) => s && s.id && !known.has(s.id));
      if (!fresh.length) return;
      t.items = fresh.concat(t.items);
      prependTicker(name, fresh);
      if (window.RetroDB) {
        RetroDB.saveTimeline(name, t.items);
        fresh.forEach((it) => {
          RetroDB.cacheItemMedia(it);
          const inner = it.reblog || it;
          if (inner && inner.id && !it.type) RetroDB.saveStatus(inner);
          if (it.status) RetroDB.saveStatus(it.status);
        });
      }
    } catch {
      /* keep current list */
    }
  }

  async function pollNewPosts() {
    if (!state.token || detailWindowOpen() || document.hidden) return;
    await Promise.all([fetchNewer("home"), fetchNewer("local"), fetchNewer("notifications")]);
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(pollNewPosts, POLL_MS);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function setColumnExpanded(name) {
    const next = name && name === state.expandedCol ? null : name || null;
    if (next && state.collapsed[next]) return;
    state.expandedCol = next;
    $("columns").classList.toggle("is-expanded", Boolean(next));
    document.querySelectorAll(".col").forEach((col) => {
      const id = col.getAttribute("data-col");
      const on = Boolean(next) && id === next;
      col.classList.toggle("is-expanded", on);
      const btn = col.querySelector("[data-expand]");
      if (!btn) return;
      btn.setAttribute("aria-pressed", String(on));
      btn.title = on ? "Verkleinern" : "Vollbild";
      btn.setAttribute("aria-label", on ? id + " verkleinern" : id + " auf Vollbild");
      btn.textContent = on ? "⤡" : "⤢";
    });
  }

  function allCollapsed() {
    return { home: true, local: true, notifications: true };
  }

  function readCollapsed() {
    const raw = localStorage.getItem(LS.collapsed);
    if (raw == null) {
      localStorage.setItem(LS.collapsed, JSON.stringify(COLS));
      return allCollapsed();
    }
    const out = { home: false, local: false, notifications: false };
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach((id) => {
          if (id in out) out[id] = true;
        });
        return out;
      }
    } catch { /* default all minimized */ }
    return allCollapsed();
  }

  function saveCollapsed() {
    localStorage.setItem(LS.collapsed, JSON.stringify(COLS.filter((id) => state.collapsed[id])));
  }

  function colEl(name) {
    return document.querySelector('.col[data-col="' + name + '"]');
  }

  function dockBtn(name) {
    return document.querySelector('.dock-icon[data-restore="' + name + '"]');
  }

  function paintCollapsed() {
    const logged = $("app").classList.contains("is-logged-in");
    const visible = COLS.filter((id) => !state.collapsed[id]);
    COLS.forEach((id) => {
      const col = colEl(id);
      if (!col) return;
      col.classList.toggle("is-collapsed", Boolean(state.collapsed[id]));
      col.classList.toggle("is-last-visible", visible.length > 0 && visible[visible.length - 1] === id);
    });
    const cols = $("columns");
    if (cols) {
      cols.classList.toggle("is-empty", logged && visible.length === 0);
      cols.classList.toggle("has-dock", logged && visible.length < COLS.length);
    }
    const logo = $("desktop-logo");
    if (logo) logo.hidden = !(logged && visible.length === 0);
    const dock = $("col-dock");
    if (dock) {
      dock.hidden = !(logged && visible.length < COLS.length);
      COLS.forEach((id) => {
        const btn = dockBtn(id);
        if (btn) btn.hidden = !state.collapsed[id];
      });
    }
  }

  function asRect(r) {
    if (!r) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function lerpRect(a, b, t) {
    return {
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      w: lerp(a.w, b.w, t),
      h: lerp(a.h, b.h, t),
    };
  }

  function reduceMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function tosZoom(fromElRect, toElRect) {
    if (reduceMotion()) return Promise.resolve();
    const from = asRect(fromElRect);
    const to = asRect(toElRect);
    const canvas = $("tos-zoom");
    const app = $("app");
    if (!canvas || !app) return Promise.resolve();
    const origin = app.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(origin.width * dpr));
    canvas.height = Math.max(1, Math.round(origin.height * dpr));
    const ctx = canvas.getContext("2d");
    canvas.classList.add("is-on");
    const local = (r) => ({ x: r.x - origin.left, y: r.y - origin.top, w: r.w, h: r.h });
    const a = local(from);
    const b = local(to);
    const steps = 12;
    const stepMs = 24;
    return new Promise((resolve) => {
      const finish = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.classList.remove("is-on");
        resolve();
      };
      const drawBox = (r) => {
        const x = Math.round(r.x * dpr) + 0.5;
        const y = Math.round(r.y * dpr) + 0.5;
        const w = Math.max(2, Math.round(r.w * dpr));
        const h = Math.max(2, Math.round(r.h * dpr));
        ctx.strokeRect(x, y, w, h);
        if (w > 8 * dpr && h > 8 * dpr) {
          ctx.strokeRect(x + 2 * dpr, y + 2 * dpr, w - 4 * dpr, h - 4 * dpr);
        }
      };
      let i = 0;
      const frame = () => {
        i += 1;
        const step = i / steps;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = "#d8ffe8";
        ctx.lineWidth = Math.max(2, Math.round(2 * dpr));
        for (let k = 2; k >= 0; k -= 1) {
          drawBox(lerpRect(a, b, Math.max(0, step - k / steps)));
        }
        if (i < steps) setTimeout(frame, stepMs);
        else finish();
      };
      frame();
    });
  }

  async function collapseCol(name) {
    if (state.colBusy || !COLS.includes(name) || state.collapsed[name]) return;
    const col = colEl(name);
    if (!col) return;
    state.colBusy = true;
    try {
      const from = col.getBoundingClientRect();
      const dock = $("col-dock");
      const btn = dockBtn(name);
      if (dock) dock.hidden = false;
      if (btn) {
        btn.hidden = false;
        btn.style.visibility = "hidden";
      }
      const to = btn ? btn.getBoundingClientRect() : from;
      await tosZoom(from, to);
      if (state.expandedCol) setColumnExpanded(null);
      state.collapsed[name] = true;
      saveCollapsed();
      if (btn) btn.style.visibility = "";
      paintCollapsed();
    } finally {
      state.colBusy = false;
    }
  }

  async function restoreCol(name) {
    if (state.colBusy || !COLS.includes(name) || !state.collapsed[name]) return;
    state.colBusy = true;
    try {
      const btn = dockBtn(name);
      const from = btn ? btn.getBoundingClientRect() : null;
      const wasEmpty = COLS.every((id) => state.collapsed[id]);
      state.collapsed[name] = false;
      paintCollapsed();
      const logo = $("desktop-logo");
      if (wasEmpty && logo) logo.hidden = false;
      const col = colEl(name);
      if (col) col.style.opacity = "0";
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const to = col ? col.getBoundingClientRect() : from;
      await tosZoom(from, to);
      if (col) col.style.opacity = "";
      if (wasEmpty && logo) logo.hidden = true;
      saveCollapsed();
    } finally {
      state.colBusy = false;
    }
  }

  function unwrapStatus(status) {
    return status && status.reblog ? status.reblog : status;
  }

  function asStatusList(value) {
    if (!value) return [];
    const list = Array.isArray(value) ? value : [];
    return list.map(unwrapStatus).filter((s) => s && s.id && s.account);
  }

  function collectTimelineReplies(rootId) {
    const byId = new Map();
    const add = (s) => {
      const inner = unwrapStatus(s);
      if (inner && inner.id && inner.account) byId.set(inner.id, inner);
    };
    Object.keys(state.timelines).forEach((name) => {
      (state.timelines[name].items || []).forEach((item) => {
        if (item && item.type && item.account) add(item.status);
        else add(item);
      });
    });
    const out = [];
    byId.forEach((s) => {
      if (s.id === rootId) return;
      let pid = s.in_reply_to_id;
      const seen = new Set();
      while (pid && !seen.has(pid)) {
        seen.add(pid);
        if (pid === rootId) {
          out.push(s);
          return;
        }
        const parent = byId.get(pid);
        pid = parent && parent.in_reply_to_id;
      }
    });
    return out;
  }

  function mergeStatuses(base, extra) {
    const byId = new Map();
    asStatusList(base).concat(asStatusList(extra)).forEach((s) => byId.set(s.id, s));
    return [...byId.values()];
  }

  function replyDepth(status, byId, rootId) {
    let depth = 0;
    let pid = status.in_reply_to_id;
    const seen = new Set();
    while (pid && pid !== rootId && !seen.has(pid) && depth < 12) {
      seen.add(pid);
      depth += 1;
      const parent = byId.get(pid);
      if (!parent) break;
      pid = parent.in_reply_to_id;
    }
    return depth;
  }

  function paintThreadTimes(root, statuses) {
    const byId = new Map(statuses.map((s) => [s.id, s]));
    [...root.querySelectorAll(".status")].forEach((node) => {
      const s = byId.get(node.getAttribute("data-id"));
      if (s) paintTime(node, s.created_at);
    });
  }

  function isSelfAcct(acct) {
    if (!state.me || !acct) return false;
    const a = String(acct).toLowerCase();
    const me = String(state.me.acct || "").toLowerCase();
    const user = String(state.me.username || "").toLowerCase();
    if (a === me || a === user) return true;
    let host = "";
    try { host = new URL(INSTANCE).host.toLowerCase(); } catch { host = ""; }
    if (host && (a === user + "@" + host || a === me + "@" + host)) return true;
    return false;
  }

  function replyMentionAccts(status) {
    const accts = [];
    const seen = new Set();
    const add = (acct) => {
      if (!acct || isSelfAcct(acct)) return;
      const key = String(acct).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      accts.push(acct);
    };
    if (status && status.account) add(status.account.acct);
    (status && status.mentions ? status.mentions : []).forEach((m) => add(m.acct || m.username));
    return accts;
  }

  function mentionPrefix(status) {
    const accts = replyMentionAccts(status);
    return accts.length ? accts.map((a) => "@" + a).join(" ") : "";
  }

  function textHasMention(text, acct) {
    const tokens = (String(text).toLowerCase().match(/@[^\s]+/g) || []).map((t) => t.slice(1));
    const want = String(acct).toLowerCase();
    if (tokens.indexOf(want) !== -1) return true;
    const local = want.split("@")[0];
    let host = "";
    try { host = new URL(INSTANCE).host.toLowerCase(); } catch { host = ""; }
    if (host && want === local + "@" + host && tokens.indexOf(local) !== -1) return true;
    if (host && want.indexOf("@") === -1 && tokens.indexOf(want + "@" + host) !== -1) return true;
    return false;
  }

  function ensureReplyMentions(text, status) {
    const accts = replyMentionAccts(status);
    const missing = accts.filter((acct) => !textHasMention(text, acct));
    if (!missing.length) return text;
    return missing.map((a) => "@" + a).join(" ") + " " + text;
  }

  function selectThreadReply(id) {
    const s = state.threadById.get(id);
    if (!s) return;
    const prev = state.threadReplyTo;
    state.threadReplyTo = s;
    const prefix = mentionPrefix(s);
    $("thread-reply-to").textContent = prefix
      ? "Antwort an " + prefix
      : "Antwort an @" + (s.account.acct || s.account.username);
    document.querySelectorAll("#thread-body .status").forEach((n) => {
      n.classList.toggle("is-reply-target", n.getAttribute("data-id") === id);
    });
    const ta = $("thread-reply-text");
    const mention = prefix ? prefix + " " : "";
    const prevMention = prev ? mentionPrefix(prev) : "";
    const trimmed = ta.value.trim();
    if (!trimmed || trimmed === prevMention) ta.value = mention;
    $("thread-reply-count").textContent = "noch " + (5000 - ta.value.length);
  }

  function renderThreadView(status, context) {
    const root = unwrapStatus(status);
    const ancestors = asStatusList(context && context.ancestors);
    const descendants = mergeStatuses(context && context.descendants, collectTimelineReplies(root.id));
    state.threadById = new Map();
    ancestors.forEach((s) => state.threadById.set(s.id, s));
    state.threadById.set(root.id, root);
    descendants.forEach((s) => state.threadById.set(s.id, s));
    const ancestorHtml = ancestors.length
      ? `<div class="thread-ancestors">${ancestors.map((s) => statusHtml(s)).join("")}</div>`
      : "";
    let repliesHtml;
    if (descendants.length) {
      repliesHtml =
        `<div class="thread-replies">` +
        descendants
          .map((s) => {
            const depth = replyDepth(s, state.threadById, root.id);
            return `<div class="thread-branch" style="margin-left:${depth * 14}px">${statusHtml(s)}</div>`;
          })
          .join("") +
        `</div>`;
    } else {
      const n = root.replies_count || 0;
      const remote = root.url
        ? ` <a href="${escapeHtml(root.url)}" target="_blank" rel="noopener noreferrer">Original öffnen</a>`
        : "";
      repliesHtml =
        n > 0
          ? `<div class="thread-replies-empty">Lokal keine Antworten geladen (${n} gemeldet).${remote}</div>`
          : `<div class="thread-replies-empty">Noch keine Antworten.</div>`;
    }
    $("thread-body").innerHTML =
      ancestorHtml +
      `<div class="thread-root">${statusHtml(root, { root: true })}</div>` +
      repliesHtml;
    paintThreadTimes($("thread-body"), ancestors.concat([root], descendants));
    if (window.RetroDB) {
      RetroDB.hydrateMedia($("thread-body"));
      [root].concat(ancestors, descendants).forEach((s) => {
        RetroDB.saveStatus(s);
        RetroDB.cacheItemMedia(s);
      });
    }
    $("thread-title").textContent = "Thread · " + (root.account.acct || "Post");
    if (!$("thread-reply-form").hidden) {
      const keepId = (state.threadReplyTo && state.threadById.has(state.threadReplyTo.id) && state.threadReplyTo.id) || root.id;
      selectThreadReply(keepId);
    }
  }

  async function cachedThreadContext(id) {
    if (!window.RetroDB) return null;
    const status = unwrapStatus(await RetroDB.loadStatus(id));
    if (!status) return null;
    const all = await RetroDB.allCachedStatuses();
    const byId = new Map();
    all.forEach((s) => {
      const inner = unwrapStatus(s);
      if (inner && inner.id) byId.set(inner.id, inner);
    });
    const ancestors = [];
    let pid = status.in_reply_to_id;
    const seen = new Set();
    while (pid && !seen.has(pid) && byId.has(pid)) {
      seen.add(pid);
      const parent = byId.get(pid);
      ancestors.unshift(parent);
      pid = parent.in_reply_to_id;
    }
    const descendants = [];
    byId.forEach((s) => {
      if (s.id === status.id) return;
      let p = s.in_reply_to_id;
      const hop = new Set();
      while (p && !hop.has(p)) {
        hop.add(p);
        if (p === status.id) {
          descendants.push(s);
          return;
        }
        const parent = byId.get(p);
        p = parent && parent.in_reply_to_id;
      }
    });
    return { status, context: { ancestors, descendants } };
  }

  async function loadThreadContext(id) {
    const path = "/api/v1/statuses/" + encodeURIComponent(id);
    try {
      const status = unwrapStatus(await api(path));
      let context = { ancestors: [], descendants: [] };
      try {
        context = (await api(path + "/context")) || context;
      } catch {
        context = { ancestors: [], descendants: [] };
      }
      context.ancestors = asStatusList(context.ancestors);
      context.descendants = asStatusList(context.descendants);
      const needsRemote =
        !context.descendants.length && (status.replies_count || 0) > 0 && status.url;
      if (needsRemote && state.conn === "online") {
        try {
          await api("/api/v2/search?q=" + encodeURIComponent(status.url) + "&resolve=true");
          const again = await api(path + "/context");
          context.ancestors = asStatusList(again && again.ancestors);
          context.descendants = asStatusList(again && again.descendants);
        } catch {
          /* keep first context */
        }
      }
      return { status, context };
    } catch (err) {
      const cached = await cachedThreadContext(id);
      if (cached) return cached;
      throw err;
    }
  }

  async function openThread(id, opts = {}) {
    if ($("thread-dialog").open && threadDraftPending() && id !== state.threadRootId) {
      const discard = await askDiscardReply();
      if (!discard) return;
    }
    const dlg = $("thread-dialog");
    state.threadRootId = id;
    $("thread-title").textContent = "Thread";
    $("thread-body").innerHTML = "<p class='hint'>Lade Thread…</p>";
    $("thread-reply-status").textContent = "";
    if (!opts.keepDraft) {
      if (opts.focusReply) {
        $("thread-reply-text").value = "";
        $("thread-reply-count").textContent = "noch 5000";
        $("thread-reply-status").textContent = "";
        state.threadReplyTo = null;
      } else {
        hideReplyComposer();
      }
    }
    if (!dlg.open) dlg.showModal();
    try {
      const { status, context } = await loadThreadContext(id);
      renderThreadView(status, context);
      if (opts.focusReply) openReplyComposer(id);
    } catch (err) {
      $("thread-body").innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
    }
  }

  function threadDraftPending() {
    const raw = $("thread-reply-text").value.trim();
    if (!raw) return false;
    const expected = state.threadReplyTo ? mentionPrefix(state.threadReplyTo) : "";
    if (expected && raw === expected) return false;
    return true;
  }

  function askDiscardReply() {
    return new Promise((resolve) => {
      const dlg = $("confirm-dialog");
      const finish = (yes) => {
        $("confirm-yes").onclick = null;
        $("confirm-no").onclick = null;
        dlg.oncancel = null;
        if (dlg.open) dlg.close();
        resolve(yes);
      };
      $("confirm-yes").onclick = () => finish(true);
      $("confirm-no").onclick = () => finish(false);
      dlg.oncancel = (ev) => {
        ev.preventDefault();
        finish(false);
      };
      dlg.showModal();
    });
  }

  function hideReplyComposer() {
    $("thread-reply-form").hidden = true;
    $("thread-reply-text").value = "";
    $("thread-reply-status").textContent = "";
    $("thread-reply-count").textContent = "noch 5000";
    $("thread-reply-to").textContent = "";
    document.querySelectorAll("#thread-body .status").forEach((n) => {
      n.classList.remove("is-reply-target");
    });
    state.threadReplyTo = null;
  }

  function openReplyComposer(id) {
    $("thread-reply-form").hidden = false;
    selectThreadReply(id);
    $("thread-reply-text").focus();
  }

  async function requestCloseReplyComposer() {
    if (threadDraftPending()) {
      const discard = await askDiscardReply();
      if (!discard) {
        $("thread-reply-text").focus();
        return false;
      }
    }
    hideReplyComposer();
    return true;
  }

  function closeThread() {
    hideReplyComposer();
    state.threadRootId = null;
    state.threadById = new Map();
    if ($("confirm-dialog").open) $("confirm-dialog").close();
    if ($("thread-dialog").open) $("thread-dialog").close();
  }

  async function requestCloseThread() {
    if (threadDraftPending()) {
      const discard = await askDiscardReply();
      if (!discard) {
        $("thread-reply-text").focus();
        return;
      }
    }
    closeThread();
  }

  async function actOnStatus(id, act, btn) {
    try {
      if (act === "fav") {
        const on = btn.classList.contains("on-fav");
        const s = await api(`/api/v1/statuses/${id}/${on ? "unfavourite" : "favourite"}`, { method: "POST" });
        btn.classList.toggle("on-fav", s.favourited);
        btn.textContent = "★ " + (s.favourites_count || 0);
      } else if (act === "boost") {
        const on = btn.classList.contains("on-boost");
        const s = await api(`/api/v1/statuses/${id}/${on ? "unreblog" : "reblog"}`, { method: "POST" });
        btn.classList.toggle("on-boost", s.reblogged);
        btn.textContent = "↻ " + (s.reblogs_count || 0);
      } else if (act === "reply") {
        if ($("thread-dialog").open && state.threadById.has(id)) {
          openReplyComposer(id);
          return;
        }
        openThread(id, { focusReply: true });
      }
    } catch (err) {
      alert(err.message);
    }
  }

  function mediaFilename(url, type) {
    try {
      const path = new URL(url, location.href).pathname;
      const base = decodeURIComponent(path.split("/").filter(Boolean).pop() || "");
      if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return base;
    } catch { /* ignore */ }
    const ext = type === "video" || type === "gifv" ? "mp4" : type === "audio" ? "mp3" : "jpg";
    return "nightboard-media." + ext;
  }

  function mediaTitle(type) {
    if (type === "video" || type === "gifv") return "Video";
    if (type === "audio") return "Audio";
    return "Bild";
  }

  async function downloadMedia(url, filename) {
    if (!url) return;
    let href = url;
    let revoke = "";
    try {
      const local = window.RetroDB ? await RetroDB.mediaSrc(url) : "";
      if (local && local.indexOf("blob:") === 0) {
        href = local;
      } else {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Download fehlgeschlagen");
        const blob = await res.blob();
        href = URL.createObjectURL(blob);
        revoke = href;
      }
    } catch {
      window.open(url, "_blank", "noopener");
      return;
    }
    const a = document.createElement("a");
    a.href = href;
    a.download = filename || "media";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(revoke), 2500);
  }

  function stopMediaPlayback() {
    const stage = $("media-stage");
    if (!stage) return;
    const av = stage.querySelector("video, audio");
    if (av) {
      av.pause();
      av.removeAttribute("src");
      av.load();
    }
    stage.innerHTML = "";
    state.mediaView = null;
  }

  function closeMedia() {
    const dlg = $("media-dialog");
    if (dlg && dlg.open) dlg.close();
    else stopMediaPlayback();
  }

  function openMediaFromEl(el) {
    const url = el.getAttribute("data-media-url") || "";
    if (!url) return;
    const type = el.getAttribute("data-media-type") || "image";
    const alt = el.getAttribute("data-media-alt") || "";
    const preview = el.getAttribute("data-media-preview") || "";
    state.mediaView = { url, type, alt, preview };
    $("media-title").textContent = mediaTitle(type);
    const stage = $("media-stage");
    if (type === "video" || type === "gifv") {
      const loop = type === "gifv" ? " loop muted" : "";
      stage.innerHTML = `<video controls autoplay playsinline${loop} src="${escapeHtml(url)}"${preview ? ` poster="${escapeHtml(preview)}"` : ""}></video>`;
    } else if (type === "audio") {
      stage.innerHTML = `<audio controls autoplay src="${escapeHtml(url)}"></audio>`;
    } else {
      stage.innerHTML = `<img alt="${escapeHtml(alt)}" src="${escapeHtml(url)}" />`;
    }
    const dlg = $("media-dialog");
    if (!dlg.open) dlg.showModal();
    if (window.RetroDB) RetroDB.hydrateMedia(stage);
  }

  document.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-act]");
    if (btn) {
      const article = btn.closest(".status");
      const act = btn.getAttribute("data-act");
      if (act === "cw") {
        const content = article.querySelector(".content");
        content.hidden = !content.hidden;
        btn.textContent = content.hidden ? "CW zeigen" : "CW verbergen";
        return;
      }
      if (act === "open") {
        openProfile(article.getAttribute("data-acct"));
        return;
      }
      actOnStatus(article.getAttribute("data-id"), act, btn);
      return;
    }
    const mediaOpen = ev.target.closest("[data-media-open]");
    if (mediaOpen) {
      openMediaFromEl(mediaOpen);
      return;
    }
    const acctOpen = ev.target.closest("[data-acct-open]");
    if (acctOpen) {
      openProfile(acctOpen.getAttribute("data-acct-open"));
      return;
    }
    if (!ev.target.closest("a, button, input, textarea, select, video, label")) {
      const article = ev.target.closest(".status");
      if (article) {
        const id = article.getAttribute("data-id");
        if (article.closest("#thread-dialog")) {
          if (!$("thread-reply-form").hidden) selectThreadReply(id);
        } else openThread(id);
        return;
      }
    }
    const collapse = ev.target.closest("[data-collapse]");
    if (collapse) {
      collapseCol(collapse.getAttribute("data-collapse"));
      return;
    }
    const restore = ev.target.closest("[data-restore]");
    if (restore) {
      restoreCol(restore.getAttribute("data-restore"));
      return;
    }
    const expand = ev.target.closest("[data-expand]");
    if (expand) {
      setColumnExpanded(expand.getAttribute("data-expand"));
      return;
    }
    const refresh = ev.target.closest("[data-refresh]");
    if (refresh) loadTimeline(refresh.getAttribute("data-refresh"), true);
    const save = ev.target.closest("[data-outbox-save]");
    if (save) {
      const id = save.getAttribute("data-outbox-save");
      const item = save.closest(".outbox-item");
      const ta = item && item.querySelector(".outbox-edit");
      if (id && ta && window.RetroDB) {
        RetroDB.getOutbox(id).then((doc) => {
          if (!doc) return;
          const payload = Object.assign({}, doc.payload, { status: ta.value });
          return RetroDB.updateOutbox(id, { payload, error: null });
        }).then(() => openOutbox());
      }
      return;
    }
    const del = ev.target.closest("[data-outbox-del]");
    if (del) {
      const id = del.getAttribute("data-outbox-del");
      if (id && window.RetroDB) {
        RetroDB.removeOutbox(id).then(() => {
          refreshOutboxBadge();
          openOutbox();
        });
      }
    }
  });

  function followLabel(rel) {
    if (rel.requested) return "Angefragt";
    if (rel.following) return "Abo beenden";
    return "Abonnieren";
  }

  function muteLabel(rel) {
    return rel.muting ? "Mute aufheben" : "Muten";
  }

  function blockLabel(rel) {
    return rel.blocking ? "Block aufheben" : "Blocken";
  }

  function paintRelButtons(rel) {
    const followBtn = $("follow-btn");
    const muteBtn = $("mute-btn");
    const blockBtn = $("block-btn");
    if (followBtn) {
      followBtn.textContent = followLabel(rel);
      followBtn.classList.toggle("is-on", Boolean(rel.following || rel.requested));
      followBtn.disabled = Boolean(rel.blocking || rel.blocked_by);
    }
    if (muteBtn) {
      muteBtn.textContent = muteLabel(rel);
      muteBtn.classList.toggle("is-on", Boolean(rel.muting));
      muteBtn.disabled = Boolean(rel.blocking);
    }
    if (blockBtn) {
      blockBtn.textContent = blockLabel(rel);
      blockBtn.classList.toggle("is-block", Boolean(rel.blocking));
    }
  }

  function bindProfileActions(id, rel) {
    const actions = [
      ["follow-btn", () => (rel.following || rel.requested ? "unfollow" : "follow")],
      ["mute-btn", () => (rel.muting ? "unmute" : "mute")],
      ["block-btn", () => (rel.blocking ? "unblock" : "block")],
    ];
    actions.forEach(([bid, pathOf]) => {
      const btn = $(bid);
      if (!btn) return;
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const next = await api("/api/v1/accounts/" + id + "/" + pathOf(), { method: "POST" });
          Object.assign(rel, next);
        } catch (err) {
          alert(err.message);
        }
        paintRelButtons(rel);
      });
    });
  }

  async function openProfile(id) {
    if (!id) return;
    const dlg = $("overlay-dialog");
    $("overlay-title").textContent = "Profil";
    $("overlay-body").innerHTML = "<p class='hint'>Lade Profil…</p>";
    dlg.showModal();
    try {
      const acc = await api("/api/v1/accounts/" + id);
      const rels = await api("/api/v1/accounts/relationships?id[]=" + encodeURIComponent(id)).catch(() => []);
      const rel = (rels && rels[0]) || {};
      const statuses = await api("/api/v1/accounts/" + id + "/statuses?limit=20");
      const isSelf = Boolean(state.me && state.me.id === acc.id);
      $("overlay-title").textContent = acc.display_name || acc.username;
      $("overlay-body").innerHTML = `
        <div class="profile-head">
          <img alt="" src="${escapeHtml(acc.avatar)}" />
          <div>
            <div class="display">${escapeHtml(acc.display_name || acc.username)}</div>
            <div class="acct">@${escapeHtml(acc.acct)}</div>
            ${isSelf ? `<p class="hint">Das bist du.</p>` : `<div class="profile-actions">
              <button type="button" class="primary" id="follow-btn">Abonnieren</button>
              <button type="button" id="mute-btn">Muten</button>
              <button type="button" class="danger" id="block-btn">Blocken</button>
            </div>`}
            ${!isSelf && rel.blocked_by ? `<p class="hint">Dieser Account hat dich blockiert.</p>` : ""}
          </div>
        </div>
        <div class="profile-note">${sanitize(acc.note || "")}</div>
        <div class="profile-stats">
          <div><strong>${acc.statuses_count}</strong>Posts</div>
          <div><strong>${acc.following_count}</strong>Following</div>
          <div><strong>${acc.followers_count}</strong>Followers</div>
        </div>
        <div id="profile-statuses"></div>`;
      renderStatusList($("profile-statuses"), statuses, "Keine Posts.");
      if (!isSelf) {
        paintRelButtons(rel);
        bindProfileActions(id, rel);
      }
    } catch (err) {
      $("overlay-body").innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
    }
  }

  function openSearch() {
    $("overlay-title").textContent = "Suche";
    $("overlay-body").innerHTML = `
      <div class="search-box">
        <input id="search-q" type="search" placeholder="Accounts, Hashtags, Posts…" />
        <button type="button" class="primary" id="search-go">Los</button>
      </div>
      <div id="search-results"></div>`;
    $("overlay-dialog").showModal();
    const run = async () => {
      const q = $("search-q").value.trim();
      const box = $("search-results");
      if (!q) return;
      box.innerHTML = "<p class='hint'>Suche…</p>";
      try {
        const res = await api("/api/v2/search?q=" + encodeURIComponent(q) + "&resolve=true");
        const accounts = (res.accounts || [])
          .map(
            (a) =>
              `<div class="search-hit" data-acct-open="${escapeHtml(a.id)}">
                <strong>${escapeHtml(a.display_name || a.username)}</strong>
                <div class="acct">@${escapeHtml(a.acct)}</div>
              </div>`
          )
          .join("");
        const statuses = (res.statuses || []).map((s) => statusHtml(s)).join("");
        const tags = (res.hashtags || [])
          .map((t) => `<div class="search-hit">#${escapeHtml(t.name)}</div>`)
          .join("");
        box.innerHTML =
          (accounts ? "<h3>Accounts</h3>" + accounts : "") +
          (tags ? "<h3>Tags</h3>" + tags : "") +
          (statuses ? "<h3>Posts</h3>" + statuses : "") ||
          "<p class='empty'>Nichts gefunden.</p>";
      } catch (err) {
        box.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
      }
    };
    $("search-go").addEventListener("click", run);
    $("search-q").addEventListener("keydown", (e) => {
      if (e.key === "Enter") run();
    });
    $("search-q").focus();
  }

  $("compose-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const status = $("compose-text").value.trim();
    if (!status) return;
    $("compose-status").textContent = "Sende…";
    try {
      const payload = {
        status,
        visibility: $("compose-vis").value,
        spoiler_text: $("compose-spoiler").value.trim() || undefined,
      };
      if (state.replyTo) payload.in_reply_to_id = state.replyTo.id;
      const result = await publishStatus(payload, state.replyTo ? { status: statusSnapshot(state.replyTo) } : null);
      $("compose-status").textContent = "";
      $("compose-text").value = "";
      $("compose-spoiler").value = "";
      state.replyTo = null;
      $("compose-dialog").close();
      if (result && result.queued) {
        openOutbox();
      } else {
        loadTimeline("home", true);
        loadTimeline("local", true);
      }
    } catch (err) {
      $("compose-status").textContent = err.message;
    }
  });

  $("compose-text").addEventListener("input", () => {
    $("compose-count").textContent = String(5000 - $("compose-text").value.length);
  });

  function bootApp() {
    setLoggedIn(true);
    loadTimeline("home", true);
    loadTimeline("local", true);
    loadTimeline("notifications", true);
    startPolling();
    refreshOutboxBadge();
    tryFlushOutbox();
  }

  $("instance-input").addEventListener("input", () => {
    const url = normalizeInstance($("instance-input").value);
    paintInstanceLabel(url ? instanceHost(url) : $("instance-input").value.trim());
  });
  $("instance-input").addEventListener("change", () => {
    const url = normalizeInstance($("instance-input").value);
    if (url) $("instance-input").value = instanceHost(url);
  });
  $("btn-oauth").addEventListener("click", startOAuth);
  $("btn-token").addEventListener("click", exchangeCode);
  $("btn-login").addEventListener("click", () => {
    setLoggedIn(false);
    $("login-panel").hidden = false;
  });
  $("btn-logout").addEventListener("click", logout);
  $("btn-compose").addEventListener("click", () => {
    state.replyTo = null;
    $("compose-dialog").showModal();
  });
  $("compose-close").addEventListener("click", () => $("compose-dialog").close());
  $("compose-cancel").addEventListener("click", () => $("compose-dialog").close());
  $("btn-search").addEventListener("click", openSearch);
  $("btn-profile").addEventListener("click", () => state.me && openProfile(state.me.id));
  $("overlay-close").addEventListener("click", () => $("overlay-dialog").close());
  $("media-close").addEventListener("click", closeMedia);
  $("media-dialog").addEventListener("close", stopMediaPlayback);
  $("media-download").addEventListener("click", () => {
    if (!state.mediaView) return;
    downloadMedia(state.mediaView.url, mediaFilename(state.mediaView.url, state.mediaView.type));
  });
  $("btn-outbox").addEventListener("click", () => openOutbox());
  $("outbox-close").addEventListener("click", () => $("outbox-dialog").close());
  $("thread-close").addEventListener("click", () => requestCloseThread());
  $("thread-reply-close").addEventListener("click", () => requestCloseReplyComposer());
  $("thread-dialog").addEventListener("cancel", (ev) => {
    ev.preventDefault();
    requestCloseThread();
  });
  $("thread-reply-text").addEventListener("input", () => {
    $("thread-reply-count").textContent = "noch " + (5000 - $("thread-reply-text").value.length);
  });
  $("thread-reply-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const raw = $("thread-reply-text").value.trim();
    if (!raw || !state.threadReplyTo) return;
    const text = ensureReplyMentions(raw, state.threadReplyTo);
    $("thread-reply-status").textContent = "Sende…";
    try {
      const payload = {
        status: text,
        in_reply_to_id: state.threadReplyTo.id,
        visibility: state.threadReplyTo.visibility || "public",
      };
      const result = await publishStatus(payload, { status: statusSnapshot(state.threadReplyTo) });
      const rootId = state.threadRootId;
      hideReplyComposer();
      if (result && result.queued) {
        $("thread-dialog").close();
        openOutbox();
      } else {
        await openThread(rootId);
        loadTimeline("home", true);
        loadTimeline("local", true);
      }
    } catch (err) {
      $("thread-reply-status").textContent = err.message;
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (document.querySelector("dialog[open]")) return;
    if (state.expandedCol) setColumnExpanded(null);
  });

  bindColumnScroll("home");
  bindColumnScroll("local");
  bindColumnScroll("notifications");

  (async () => {
    await initInstance();
    startConnWatch();
    loadMeCached();
    if (state.token) {
      setLoggedIn(true);
      refreshMe()
        .then(bootApp)
        .catch((err) => {
          if (isNetworkError(err) && state.me) {
            bootApp();
          } else {
            logout();
            $("login-status").textContent = "Session ungültig — bitte neu anmelden.";
          }
        });
    } else {
      setLoggedIn(false);
    }
  })();
})();
