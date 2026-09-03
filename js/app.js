(() => {
  const INSTANCE = "https://fediverse2.blackneon.net";
  const SCOPES = "read write follow push";
  const OOB = "urn:ietf:wg:oauth:2.0:oob";
  const LS = {
    app: "retrodon84.app",
    token: "retrodon84.token",
    me: "retrodon84.me",
  };

  const $ = (id) => document.getElementById(id);
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
    threadRootId: null,
    threadReplyTo: null,
    threadById: new Map(),
    pollTimer: null,
  };

  function api(path, opts = {}) {
    const headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
    if (state.token) headers.Authorization = "Bearer " + state.token;
    if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== "string") {
      headers["Content-Type"] = "application/json";
      opts = Object.assign({}, opts, { body: JSON.stringify(opts.body) });
    }
    return fetch(INSTANCE + path, Object.assign({ headers }, opts)).then(async (res) => {
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!res.ok) {
        const msg = (data && (data.error || data.error_description)) || res.statusText;
        throw new Error(msg);
      }
      return data;
    });
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
  }

  async function ensureApp() {
    const cached = localStorage.getItem(LS.app);
    if (cached) return JSON.parse(cached);
    const body = new URLSearchParams({
      client_name: "Retrodon '84",
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
    localStorage.setItem(LS.app, JSON.stringify(app));
    return app;
  }

  async function startOAuth() {
    try {
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
    return (
      `<img class="avatar" alt="" src="${escapeHtml(acct.avatar_static || acct.avatar || "")}" />` +
      `<div class="who">` +
      `<div class="display">${escapeHtml(acct.display_name || acct.username)}</div>` +
      `<div class="acct">@${escapeHtml(acct.acct)} · <span class="time"></span></div>` +
      `</div>`
    );
  }

  function mediaBlock(status) {
    const atts = status.media_attachments || [];
    if (!atts.length) return "";
    return (
      `<div class="media">` +
      atts
        .map((m) => {
          if (m.type === "video" || m.type === "gifv") {
            return `<video controls preload="metadata" src="${escapeHtml(m.url)}"></video>`;
          }
          const src = m.preview_url || m.url;
          return `<a href="${escapeHtml(m.url)}" target="_blank" rel="noopener"><img alt="${escapeHtml(m.description || "")}" loading="lazy" src="${escapeHtml(src)}" /></a>`;
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
      ? `<div class="boost-line">↻ ${escapeHtml(boosted.account.display_name || boosted.account.username)} boosted</div>`
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
      <div class="notif-kind">${escapeHtml(n.account.acct)} ${kind}</div>
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
    } catch (err) {
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
    return (thread && thread.open) || (overlay && overlay.open);
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
    state.pollTimer = setInterval(pollNewPosts, 5 * 60 * 1000);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function setColumnExpanded(name) {
    const next = name && name === state.expandedCol ? null : name || null;
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
    $("thread-title").textContent = "Thread · " + (root.account.acct || "Post");
    if (!$("thread-reply-form").hidden) {
      const keepId = (state.threadReplyTo && state.threadById.has(state.threadReplyTo.id) && state.threadReplyTo.id) || root.id;
      selectThreadReply(keepId);
    }
  }

  async function loadThreadContext(id) {
    const path = "/api/v1/statuses/" + encodeURIComponent(id);
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
    if (needsRemote) {
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
    const expand = ev.target.closest("[data-expand]");
    if (expand) {
      setColumnExpanded(expand.getAttribute("data-expand"));
      return;
    }
    const refresh = ev.target.closest("[data-refresh]");
    if (refresh) loadTimeline(refresh.getAttribute("data-refresh"), true);
    const hit = ev.target.closest("[data-acct-open]");
    if (hit) openProfile(hit.getAttribute("data-acct-open"));
  });

  async function openProfile(id) {
    const dlg = $("overlay-dialog");
    $("overlay-title").textContent = "Profil";
    $("overlay-body").innerHTML = "<p class='hint'>Lade Profil…</p>";
    dlg.showModal();
    try {
      const acc = await api("/api/v1/accounts/" + id);
      const rels = await api("/api/v1/accounts/relationships?id[]=" + encodeURIComponent(id)).catch(() => []);
      const rel = (rels && rels[0]) || {};
      const statuses = await api("/api/v1/accounts/" + id + "/statuses?limit=20");
      $("overlay-title").textContent = acc.display_name || acc.username;
      $("overlay-body").innerHTML = `
        <div class="profile-head">
          <img alt="" src="${escapeHtml(acc.avatar)}" />
          <div>
            <div class="display">${escapeHtml(acc.display_name || acc.username)}</div>
            <div class="acct">@${escapeHtml(acc.acct)}</div>
            ${state.me && state.me.id !== acc.id ? `<p><button type="button" class="primary" id="follow-btn">${rel.following ? "Entfolgen" : "Folgen"}</button></p>` : ""}
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
      const followBtn = $("follow-btn");
      if (followBtn) {
        followBtn.addEventListener("click", async () => {
          try {
            const path = rel.following ? `/api/v1/accounts/${id}/unfollow` : `/api/v1/accounts/${id}/follow`;
            const next = await api(path, { method: "POST" });
            rel.following = next.following;
            followBtn.textContent = rel.following ? "Entfolgen" : "Folgen";
          } catch (err) {
            alert(err.message);
          }
        });
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
      await api("/api/v1/statuses", { method: "POST", body: payload });
      $("compose-status").textContent = "";
      $("compose-text").value = "";
      $("compose-spoiler").value = "";
      state.replyTo = null;
      $("compose-dialog").close();
      loadTimeline("home", true);
      loadTimeline("local", true);
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
  }

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
      await api("/api/v1/statuses", {
        method: "POST",
        body: {
          status: text,
          in_reply_to_id: state.threadReplyTo.id,
          visibility: state.threadReplyTo.visibility || "public",
        },
      });
      const rootId = state.threadRootId;
      hideReplyComposer();
      await openThread(rootId);
      loadTimeline("home", true);
      loadTimeline("local", true);
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

  loadMeCached();
  if (state.token) {
    setLoggedIn(true);
    refreshMe()
      .then(bootApp)
      .catch(() => {
        logout();
        $("login-status").textContent = "Session ungültig — bitte neu anmelden.";
      });
  } else {
    setLoggedIn(false);
  }
})();
