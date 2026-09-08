/* Nightboard '83 — static Mastodon/GoToSocial web client
   Copyright (C) 2026 Ralf Wissing
   SPDX-License-Identifier: AGPL-3.0-or-later */
(() => {
  let INSTANCE = "";
  let POLL_MS = 2 * 60 * 1000;
  const Core = window.NBCore || {};
  const SCOPES = "read write follow";
  const OOB = "urn:ietf:wg:oauth:2.0:oob";
  const COLS = ["home", "local", "federated", "notifications"];
  const TIMELINE_CAP = 300;
  const DEFAULT_MAX_CHARS = 5000;
  const LS = {
    app: "nightboard83.app",
    token: "nightboard83.token",
    me: "nightboard83.me",
    instance: "nightboard83.instance",
    collapsed: "nightboard83.collapsed",
    seen: "nightboard83.seen",
    pkce: "nightboard83.pkce",
    locale: "nightboard83.locale",
  };

  const I18n = window.NBI18n || {};
  const Tr = window.NBTranslate || {};
  function t(key, vars) {
    return I18n.t ? I18n.t(key, vars) : String(key || "");
  }
  /** Translate error/status payloads that may already be i18n keys. */
  function tx(msg) {
    const s = String(msg || "");
    if (!s) return "";
    if (/^(errors|login|compose|thread|outbox|status|common|nav|timeline|profile|search|media|drafts|pwa|a11y|confirm)\./.test(s)) {
      return t(s);
    }
    return s;
  }

  const $ = (id) => document.getElementById(id);

  function instanceHost(url) {
    return Core.instanceHost ? Core.instanceHost(url) : "";
  }

  function normalizeInstance(raw) {
    return Core.normalizeInstance ? Core.normalizeInstance(raw) : "";
  }

  function parseInstanceInput(raw) {
    if (Core.parseInstanceInput) return Core.parseInstanceInput(raw);
    const origin = normalizeInstance(raw);
    return origin
      ? { origin, error: "" }
      : { origin: "", error: "errors.instanceRequired" };
  }

  function friendlyConnectError(err) {
    const raw = Core.friendlyConnectError ? Core.friendlyConnectError(err) : String((err && err.message) || err || "common.error");
    return tx(raw);
  }

  function appBaseUrl() {
    return Core.appBaseUrl ? Core.appBaseUrl(location) : (location.origin + "/");
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
    const parsed = parseInstanceInput($("instance-input") ? $("instance-input").value : "");
    if (!parsed.origin) return "";
    const prev = localStorage.getItem(LS.instance) || "";
    if (prev && prev !== parsed.origin) localStorage.removeItem(LS.app);
    setInstance(parsed.origin, true);
    return parsed.origin;
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
    return Core.pollIntervalMs ? Core.pollIntervalMs(cfg) : 2 * 60 * 1000;
  }

  async function initInstance() {
    const cfg = await loadConfig();
    const fromLs = normalizeInstance(localStorage.getItem(LS.instance) || "");
    const fromCfg = normalizeInstance(cfg.instance || cfg.url || cfg.host || "");
    setInstance(fromLs || fromCfg, Boolean(fromLs));
    POLL_MS = pollIntervalMs(cfg);
  }

  function maxCharsFromInstance(data) {
    return Core.maxCharsFromInstance ? Core.maxCharsFromInstance(data) : 0;
  }

  function remainingChars(text) {
    return Math.max(0, state.maxChars - String(text || "").length);
  }

  function paintComposeCount() {
    const el = $("compose-count");
    const ta = $("compose-text");
    if (el && ta) el.textContent = String(remainingChars(ta.value));
  }

  function paintThreadReplyCount() {
    const el = $("thread-reply-count");
    const ta = $("thread-reply-text");
    if (el && ta) el.textContent = t("thread.charsLeft", { count: remainingChars(ta.value) });
  }

  function applyMaxChars(n) {
    const v = Number(n);
    state.maxChars = Number.isFinite(v) && v > 0
      ? Math.min(100000, Math.max(1, Math.floor(v)))
      : DEFAULT_MAX_CHARS;
    ["compose-text", "thread-reply-text"].forEach((id) => {
      const el = $(id);
      if (el) el.maxLength = state.maxChars;
    });
    paintComposeCount();
    paintThreadReplyCount();
  }

  function paintComposeMode() {
    const title = document.querySelector("#compose-dialog h2");
    const editing = Boolean(state.editingStatusId);
    if (title) title.textContent = editing ? t("compose.editTitle") : t("compose.title");
    const vis = $("compose-vis");
    if (vis) vis.disabled = editing;
    const attach = $("compose-attach");
    const draft = $("compose-draft");
    if (attach) attach.hidden = editing;
    if (draft) draft.hidden = editing;
    if (editing && state.editingMediaIds.length && $("compose-status") && !$("compose-status").textContent) {
      $("compose-status").textContent = t("compose.existingAttachments", { count: state.editingMediaIds.length });
    }
  }

  async function refreshInstanceConfig() {
    if (!INSTANCE) {
      applyMaxChars(DEFAULT_MAX_CHARS);
      return;
    }
    try {
      let data = null;
      try {
        data = await api("/api/v2/instance");
      } catch {
        data = await api("/api/v1/instance");
      }
      applyMaxChars(maxCharsFromInstance(data) || DEFAULT_MAX_CHARS);
      rememberStreamingUrl(data);
    } catch {
      /* keep current limit */
    }
  }

  const state = {
    ageTimer: 0,
    token: localStorage.getItem(LS.token) || "",
    me: null,
    timelines: {
      home: { items: [], maxId: null, loading: false, done: false },
      local: { items: [], maxId: null, loading: false, done: false },
      federated: { items: [], maxId: null, loading: false, done: false },
      notifications: { items: [], maxId: null, loading: false, done: false },
    },
    replyTo: null,
    expandedCol: null,
    collapsed: { home: true, local: true, federated: true, notifications: true },
    colBusy: false,
    threadRootId: null,
    threadReplyTo: null,
    threadById: new Map(),
    pollTimer: null,
    conn: "unknown",
    carrierTimer: null,
    flushing: false,
    mediaView: null,
    composeAttach: [],
    threadAttach: [],
    editingDraftId: null,
    editingStatusId: null,
    editingMediaIds: [],
    composeClosing: false,
    carrierWanted: true,
    unread: { home: false, local: false, federated: false, notifications: false },
    seen: { home: "", local: "", federated: "", notifications: "" },
    maxChars: DEFAULT_MAX_CHARS,
    tagView: null,
    profileView: null,
    notifFilter: "all",
    streams: [],
    streamingUrl: "",
    usingStream: false,
    streamRetry: null,
    authBusy: false,
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
          const err = new Error(msg);
          err.status = res.status;
          if (res.status === 401 && state.token && !opts.skipAuth) {
            logout();
          }
          throw err;
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
    return Core.isNetworkError ? Core.isNetworkError(err) : false;
  }

  function isMissingStatus(err) {
    return Core.isMissingStatus ? Core.isMissingStatus(err) : false;
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

  function paintCarrierBtn() {
    const btn = $("btn-carrier");
    if (!btn) return;
    const on = state.conn === "online";
    btn.classList.toggle("is-online", on);
    btn.classList.toggle("is-offline", !on);
    btn.setAttribute("aria-pressed", String(on));
    btn.title = on ? t("status.disconnect") : t("status.connect");
    btn.setAttribute("aria-label", on ? t("status.disconnect") : t("status.connectAria"));
  }

  function hangUp() {
    state.carrierWanted = false;
    stopStreaming();
    stopPolling();
    if (state.carrierTimer) {
      clearTimeout(state.carrierTimer);
      state.carrierTimer = null;
    }
    state.conn = "offline";
    paintConn("is-offline", t("status.offline"));
  }

  function pickUp() {
    state.carrierWanted = true;
    probeConn();
    if (state.token) startLiveUpdates();
  }

  function toggleCarrier() {
    if (state.conn === "online") hangUp();
    else pickUp();
  }

  function paintConn(kind, text) {
    const el = $("conn-status");
    if (!el) return;
    el.textContent = text;
    el.className = "conn-status " + kind;
    paintCarrierBtn();
  }

  function finishCarrierLost() {
    state.carrierTimer = null;
    if (state.conn !== "carrier-lost") return;
    state.conn = "offline";
    paintConn("is-offline", t("status.offline"));
  }

  function setConn(next) {
    if (next === "offline" && state.conn === "online") {
      state.conn = "carrier-lost";
      paintConn("is-carrier-lost", t("status.carrierLost"));
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
      paintConn("is-connected", t("status.connected"));
      tryFlushOutbox();
      if (state.token && state.carrierWanted) startStreaming();
      return;
    }
    if (next === "offline") {
      if (state.carrierTimer) {
        clearTimeout(state.carrierTimer);
        state.carrierTimer = null;
      }
      state.conn = "offline";
      paintConn("is-offline", t("status.offline"));
      stopStreaming();
    }
  }

  async function probeConn() {
    if (!state.carrierWanted) {
      if (state.conn !== "offline") {
        state.conn = "offline";
        paintConn("is-offline", t("status.offline"));
      }
      return;
    }
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
      if (res.ok) {
        try {
          const data = await res.json();
          applyMaxChars(maxCharsFromInstance(data));
          rememberStreamingUrl(data);
        } catch {
          /* keep current limit */
        }
      }
    } catch {
      setConn("offline");
    }
  }

  function startConnWatch() {
    window.addEventListener("online", () => {
      if (state.carrierWanted) probeConn();
    });
    window.addEventListener("offline", () => setConn("offline"));
    setInterval(probeConn, 20000);
    if (navigator.onLine && state.carrierWanted) setConn("online");
    else setConn("offline");
    probeConn();
  }

  async function refreshOutboxBadge() {
    const btn = $("btn-outbox");
    if (!btn) return;
    if (!state.token || !window.NightDB) {
      btn.hidden = true;
      return;
    }
    const list = await NightDB.listOutbox();
    const n = list.length;
    $("outbox-count").textContent = String(n);
    btn.hidden = n === 0;
    btn.setAttribute("aria-label", t("outbox.countAria", { count: n }));
  }

  async function refreshDraftsBadge() {
    const btn = $("btn-drafts");
    if (!btn) return;
    if (!state.token || !window.NightDB) {
      btn.hidden = true;
      return;
    }
    const list = await NightDB.listDrafts();
    const n = list.length;
    $("drafts-count").textContent = String(n);
    btn.hidden = n === 0;
    btn.setAttribute("aria-label", t("drafts.countAria", { count: n }));
  }

  function revokeAttach(list) {
    (list || []).forEach((item) => {
      if (item.preview && String(item.preview).indexOf("blob:") === 0) URL.revokeObjectURL(item.preview);
    });
  }

  function attachKind(file) {
    return file && String(file.type || "").indexOf("video/") === 0 ? "video" : "image";
  }

  function canAddAttach(list, file) {
    if (!file) return t("compose.invalidFile");
    if (list.length >= 4) return t("compose.maxAttachments");
    const kind = attachKind(file);
    if (kind !== "image" && kind !== "video") return t("compose.imagesOrVideosOnly");
    if (!/^image\//.test(file.type) && !/^video\//.test(file.type)) return t("compose.imagesOrVideosOnly");
    const hasVid = list.some((x) => x.kind === "video");
    const hasImg = list.some((x) => x.kind === "image");
    if (kind === "video" && (hasVid || hasImg)) return t("compose.oneVideoOnly");
    if (kind === "image" && hasVid) return t("compose.noImagesWithVideo");
    return "";
  }

  function paintAttachList(elId, list, which) {
    const el = $(elId);
    if (!el) return;
    el.innerHTML = (list || [])
      .map((item, i) => {
        const alt = escapeHtml(item.alt || "");
        const media = item.kind === "video"
          ? `<video src="${escapeHtml(item.preview)}" muted></video>`
          : `<img alt="${alt}" src="${escapeHtml(item.preview)}" />`;
        return `<div class="attach-item">${media}<label class="attach-alt"><span>${escapeHtml(t("compose.altText"))}</span><textarea data-attach-alt="${which}:${i}" maxlength="1500" rows="2" placeholder="${escapeHtml(t("compose.altPlaceholder"))}">${alt}</textarea></label><button type="button" class="attach-remove" data-attach-rm="${which}:${i}" aria-label="${escapeHtml(t("compose.removeAttachAria"))}">×</button></div>`;
      })
      .join("");
  }

  function addAttachFiles(which, fileList) {
    const list = which === "thread" ? state.threadAttach : state.composeAttach;
    const statusId = which === "thread" ? "thread-reply-status" : "compose-status";
    const elId = which === "thread" ? "thread-attach-list" : "compose-attach-list";
    let firstNew = -1;
    [...(fileList || [])].forEach((file) => {
      const err = canAddAttach(list, file);
      if (err) {
        if ($(statusId)) $(statusId).textContent = err;
        return;
      }
      if (firstNew < 0) firstNew = list.length;
      list.push({
        file,
        kind: attachKind(file),
        preview: URL.createObjectURL(file),
        alt: "",
      });
    });
    paintAttachList(elId, list, which);
    if (firstNew >= 0) {
      const ta = document.querySelector(`[data-attach-alt="${which}:${firstNew}"]`);
      if (ta) ta.focus();
    }
  }

  function removeAttach(which, index) {
    const list = which === "thread" ? state.threadAttach : state.composeAttach;
    const item = list[index];
    if (!item) return;
    if (item.preview && String(item.preview).indexOf("blob:") === 0) URL.revokeObjectURL(item.preview);
    list.splice(index, 1);
    paintAttachList(which === "thread" ? "thread-attach-list" : "compose-attach-list", list, which);
  }

  function resetCompose() {
    if ($("compose-text")) $("compose-text").value = "";
    if ($("compose-spoiler")) $("compose-spoiler").value = "";
    if ($("compose-vis")) $("compose-vis").value = "public";
    if ($("compose-status")) $("compose-status").textContent = "";
    revokeAttach(state.composeAttach);
    state.composeAttach = [];
    state.editingDraftId = null;
    state.editingStatusId = null;
    state.editingMediaIds = [];
    state.replyTo = null;
    paintAttachList("compose-attach-list", state.composeAttach, "compose");
    paintComposeMode();
    paintComposeCount();
  }

  function composeDraftPending() {
    if (state.composeAttach.length) return true;
    const text = $("compose-text") ? $("compose-text").value.trim() : "";
    const spoiler = $("compose-spoiler") ? $("compose-spoiler").value.trim() : "";
    return Boolean(text || spoiler);
  }

  async function saveCurrentDraft() {
    const text = $("compose-text").value;
    if (!text.trim() && !state.composeAttach.length) {
      $("compose-status").textContent = t("compose.nothingToSave");
      return false;
    }
    if (!window.NightDB) {
      $("compose-status").textContent = t("compose.storageUnavailable");
      return false;
    }
    try {
      const doc = await NightDB.saveDraft({
        _id: state.editingDraftId || undefined,
        text,
        spoiler: $("compose-spoiler").value.trim(),
        visibility: $("compose-vis").value,
        in_reply_to_id: state.replyTo ? state.replyTo.id : null,
      }, state.composeAttach);
      state.editingDraftId = doc._id;
      $("compose-status").textContent = t("compose.draftSaved");
      await refreshDraftsBadge();
      return true;
    } catch (err) {
      $("compose-status").textContent = err.message;
      return false;
    }
  }

  function closeCompose() {
    resetCompose();
    const dlg = $("compose-dialog");
    if (dlg && dlg.open) dlg.close();
  }

  async function requestCloseCompose() {
    if (state.composeClosing) return;
    state.composeClosing = true;
    try {
      if (state.editingStatusId) {
        if (composeDraftPending()) {
          const discard = await askConfirm({
            title: t("compose.discardEditTitle"),
            message: t("compose.discardEditMessage"),
            noLabel: t("compose.keepEditing"),
            yesLabel: t("common.discard"),
          });
          if (discard !== true) {
            $("compose-text").focus();
            return;
          }
        }
        closeCompose();
        return;
      }
      if (!composeDraftPending()) {
        closeCompose();
        return;
      }
      const choice = await askConfirm({
        title: t("compose.saveDraftTitle"),
        message: t("compose.saveDraftMessage"),
        noLabel: t("common.discard"),
        yesLabel: t("common.save"),
      });
      if (choice === null) {
        $("compose-text").focus();
        return;
      }
      if (choice) {
        const ok = await saveCurrentDraft();
        if (!ok) return;
      }
      closeCompose();
    } finally {
      state.composeClosing = false;
    }
  }

  async function openDrafts() {
    const dlg = $("drafts-dialog");
    $("drafts-body").innerHTML = "<p class='hint'>" + escapeHtml(t("drafts.loading")) + "</p>";
    if (!dlg.open) dlg.showModal();
    const docs = window.NightDB ? await NightDB.listDrafts() : [];
    if (!docs.length) {
      $("drafts-body").innerHTML = "<p class='empty'>" + escapeHtml(t("drafts.empty")) + "</p>";
      return;
    }
    $("drafts-body").innerHTML = docs
      .map((d) => {
        const snippet = String(d.text || "").trim() || t("drafts.mediaOnly");
        return `<article class="draft-item" data-draft-id="${escapeHtml(d._id)}">
          <p>${escapeHtml(snippet.slice(0, 180))}</p>
          <div class="outbox-actions">
            <button type="button" data-draft-open="${escapeHtml(d._id)}">${escapeHtml(t("drafts.open"))}</button>
            <button type="button" class="danger" data-draft-del="${escapeHtml(d._id)}">${escapeHtml(t("common.delete"))}</button>
          </div>
        </article>`;
      })
      .join("");
  }

  async function loadDraft(id) {
    if (!window.NightDB) return;
    const doc = await NightDB.getDraft(id);
    if (!doc) return;
    resetCompose();
    state.editingDraftId = doc._id;
    $("compose-text").value = doc.text || "";
    $("compose-spoiler").value = doc.spoiler || "";
    $("compose-vis").value = doc.visibility || "public";
    paintComposeCount();
    const files = NightDB.attachmentsToFiles(doc);
    state.composeAttach = files.map((item) => ({
      file: item.file,
      kind: item.kind === "video" ? "video" : "image",
      preview: URL.createObjectURL(item.file),
      alt: item.alt || "",
    }));
    paintAttachList("compose-attach-list", state.composeAttach, "compose");
    if ($("drafts-dialog").open) $("drafts-dialog").close();
    if (!$("compose-dialog").open) $("compose-dialog").showModal();
  }

  function attachAltMissing(list) {
    return (list || []).some((item) => !String(item.alt || "").trim());
  }

  async function uploadAttachList(list) {
    const ids = [];
    for (const item of list || []) {
      const body = new FormData();
      body.append("file", item.file);
      const alt = String(item.alt || "").trim();
      if (alt) body.append("description", alt);
      const media = await api("/api/v1/media", { method: "POST", body });
      if (!media || !media.id) throw new Error(t("errors.mediaUploadFailed"));
      if (alt && String(media.description || "").trim() !== alt) {
        try {
          await api("/api/v1/media/" + encodeURIComponent(media.id), {
            method: "PUT",
            body: { description: alt },
          });
        } catch { /* Instanz erlaubt kein Update */ }
      }
      ids.push(media.id);
    }
    return ids;
  }

  async function publishStatus(payload, context, files) {
    files = files || [];
    if (state.conn === "online") {
      try {
        if (files.length) payload = Object.assign({}, payload, { media_ids: await uploadAttachList(files) });
        return await api("/api/v1/statuses", { method: "POST", body: payload });
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        setConn("offline");
      }
    }
    if (!window.NightDB) throw new Error(t("errors.offlineStoreUnavailable"));
    await NightDB.enqueue({ action: "create", payload, context: context || null, files });
    await refreshOutboxBadge();
    return { queued: true };
  }

  async function publishEdit(id, payload) {
    if (state.conn === "online") {
      try {
        return await api("/api/v1/statuses/" + encodeURIComponent(id), { method: "PUT", body: payload });
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        setConn("offline");
      }
    }
    if (!window.NightDB) throw new Error(t("errors.offlineStoreUnavailable"));
    const local = findLocalStatus(id);
    await NightDB.enqueue({
      action: "edit",
      statusId: id,
      payload,
      context: local ? { status: statusSnapshot(local) } : null,
    });
    await refreshOutboxBadge();
    return { queued: true };
  }

  async function dropQueuedStatusActions(id) {
    if (!id || !window.NightDB) return;
    const docs = await NightDB.listOutbox();
    for (const doc of docs) {
      if ((doc.action === "edit" || doc.action === "delete") && doc.statusId === id) {
        await NightDB.removeOutbox(doc._id);
      }
    }
  }

  async function publishDelete(id) {
    if (state.conn === "online") {
      try {
        await api("/api/v1/statuses/" + encodeURIComponent(id), { method: "DELETE" });
        await dropQueuedStatusActions(id);
        return { deleted: true };
      } catch (err) {
        if (isMissingStatus(err)) {
          await dropQueuedStatusActions(id);
          return { deleted: true };
        }
        if (!isNetworkError(err)) throw err;
        setConn("offline");
      }
    }
    if (!window.NightDB) throw new Error(t("errors.offlineStoreUnavailable"));
    const local = findLocalStatus(id);
    await dropQueuedStatusActions(id);
    await NightDB.enqueue({
      action: "delete",
      statusId: id,
      payload: {},
      context: local ? { status: statusSnapshot(local) } : null,
    });
    await refreshOutboxBadge();
    return { queued: true };
  }

  async function statusStillExists(id) {
    try {
      await api("/api/v1/statuses/" + encodeURIComponent(id));
      return true;
    } catch (err) {
      if (isNetworkError(err)) throw err;
      if (isMissingStatus(err)) return false;
      throw err;
    }
  }

  async function tryFlushOutbox() {
    if (state.flushing || state.conn !== "online" || !state.token || !window.NightDB) return;
    state.flushing = true;
    let sent = 0;
    const updatedEdits = [];
    try {
      const docs = await NightDB.listOutbox();
      for (const summary of docs) {
        try {
          const doc = (await NightDB.getOutbox(summary._id, true)) || summary;
          const action = doc.action || "create";
          const targetId = doc.statusId || (doc.payload && doc.payload.id) || null;
          if (action === "edit" || action === "delete") {
            if (!targetId) throw new Error(action === "delete" ? t("errors.deleteWithoutStatusId") : t("errors.editWithoutStatusId"));
            const exists = await statusStillExists(targetId);
            if (!exists) {
              if (action === "delete") {
                await NightDB.removeOutbox(doc._id);
                sent += 1;
              } else {
                await NightDB.updateOutbox(summary._id, {
                  error: t("errors.postGoneEdit"),
                });
              }
              continue;
            }
            if (action === "delete") {
              try {
                await api("/api/v1/statuses/" + encodeURIComponent(targetId), { method: "DELETE" });
              } catch (err) {
                if (!isMissingStatus(err)) throw err;
              }
              await NightDB.removeOutbox(doc._id);
              sent += 1;
              continue;
            }
            const updated = await api("/api/v1/statuses/" + encodeURIComponent(targetId), {
              method: "PUT",
              body: Object.assign({}, doc.payload),
            });
            await NightDB.removeOutbox(doc._id);
            sent += 1;
            if (updated) updatedEdits.push(updated);
            continue;
          }
          const files = NightDB.attachmentsToFiles ? NightDB.attachmentsToFiles(doc) : [];
          let payload = Object.assign({}, doc.payload);
          if (files.length) payload.media_ids = await uploadAttachList(files);
          await api("/api/v1/statuses", { method: "POST", body: payload });
          await NightDB.removeOutbox(doc._id);
          sent += 1;
        } catch (err) {
          if (isNetworkError(err)) {
            setConn("offline");
            break;
          }
          if (isMissingStatus(err)) {
            if (summary.action === "delete") {
              await NightDB.removeOutbox(summary._id);
              sent += 1;
            } else {
              await NightDB.updateOutbox(summary._id, {
                error: t("errors.postGoneEdit"),
              });
            }
            continue;
          }
          await NightDB.updateOutbox(summary._id, { error: err.message });
        }
      }
    } finally {
      state.flushing = false;
      await refreshOutboxBadge();
      if ($("outbox-dialog").open) openOutbox();
      updatedEdits.forEach((s) => replaceStatusEverywhere(unwrapStatus(s)));
      if (sent) {
        loadTimeline("home", true);
        loadTimeline("local", true);
        loadTimeline("federated", true);
      }
    }
  }

  function renderOutboxList(docs) {
    if (!docs.length) return "<p class='empty'>" + escapeHtml(t("outbox.empty")) + "</p>";
    return docs
      .map((doc) => {
        const ctx = doc.context && doc.context.status;
        const isEdit = doc.action === "edit";
        const isDelete = doc.action === "delete";
        const isReply = !isEdit && !isDelete && Boolean(doc.payload && doc.payload.in_reply_to_id);
        const contextHtml = isDelete
          ? ctx
            ? `<div class="outbox-context"><p class="hint">${escapeHtml(t("outbox.deleteOf"))}</p>${statusHtml(ctx, { hideActions: true })}</div>`
            : `<p class="hint">${escapeHtml(doc.statusId ? t("outbox.deleteOfPost", { id: doc.statusId }) : t("outbox.deleteGeneric"))}</p>`
          : isEdit
            ? ctx
              ? `<div class="outbox-context"><p class="hint">${escapeHtml(t("outbox.editOf"))}</p>${statusHtml(ctx, { hideActions: true })}</div>`
              : `<p class="hint">${escapeHtml(doc.statusId ? t("outbox.editOfPost", { id: doc.statusId }) : t("outbox.editGeneric"))}</p>`
            : isReply && ctx
              ? `<div class="outbox-context"><p class="hint">${escapeHtml(t("outbox.replyTo"))}</p>${statusHtml(ctx, { hideActions: true })}</div>`
              : isReply
                ? `<p class="hint">${escapeHtml(t("outbox.replyToPost", { id: doc.payload.in_reply_to_id }))}</p>`
                : `<p class="hint">${escapeHtml(t("outbox.newPost"))}</p>`;
        const waiting = isDelete ? t("outbox.waitingDelete") : t("outbox.waitingSend");
        const editor = isDelete
          ? ""
          : `<textarea class="outbox-edit" maxlength="${state.maxChars}">${escapeHtml((doc.payload && doc.payload.status) || "")}</textarea>`;
        const saveBtn = isDelete
          ? ""
          : `<button type="button" data-outbox-save="${escapeHtml(doc._id)}">${escapeHtml(t("outbox.save"))}</button>`;
        return `<article class="outbox-item" data-outbox-id="${escapeHtml(doc._id)}">
          ${contextHtml}
          ${editor}
          <div class="outbox-actions">
            ${saveBtn}
            <button type="button" class="danger" data-outbox-del="${escapeHtml(doc._id)}">${escapeHtml(isDelete ? t("outbox.dontDelete") : t("outbox.deleteAction"))}</button>
          </div>
          ${doc.error ? `<p class="error">${escapeHtml(tx(doc.error))}</p>` : `<p class="hint">${escapeHtml(waiting)}</p>`}
        </article>`;
      })
      .join("");
  }

  async function openOutbox() {
    const dlg = $("outbox-dialog");
    $("outbox-body").innerHTML = "<p class='hint'>" + escapeHtml(t("outbox.loading")) + "</p>";
    if (!dlg.open) dlg.showModal();
    const docs = window.NightDB ? await NightDB.listOutbox() : [];
    $("outbox-body").innerHTML = renderOutboxList(docs);
    if (window.NightDB) NightDB.hydrateMedia($("outbox-body"));
  }

  function loadMeCached() {
    try { state.me = JSON.parse(localStorage.getItem(LS.me) || "null"); } catch { state.me = null; }
  }

  function setLoggedIn(on) {
    $("login-panel").hidden = on;
    $("columns").hidden = !on;
    $("btn-login").hidden = on;
    $("btn-compose").hidden = !on;
    $("btn-search").hidden = !on;
    $("btn-profile").hidden = !on;
    $("app").classList.toggle("is-logged-in", on);
    refreshOutboxBadge();
    refreshDraftsBadge();
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

  async function ensureApp(redirectUri) {
    const redirect = redirectUri || appBaseUrl();
    const cached = localStorage.getItem(LS.app);
    if (cached) {
      try {
        const app = JSON.parse(cached);
        if (
          app &&
          app.client_id &&
          app._instance === INSTANCE &&
          app._redirect === redirect &&
          app._scopes === SCOPES
        ) {
          return app;
        }
      } catch { /* re-register */ }
    }
    const register = async (uris) => {
      const body = new URLSearchParams({
        client_name: "Nightboard '83",
        redirect_uris: uris,
        scopes: SCOPES,
        website: appBaseUrl() || location.origin,
      });
      let res;
      try {
        res = await fetch(INSTANCE + "/api/v1/apps", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body,
        });
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err || "Failed to fetch"));
        e.network = true;
        throw e;
      }
      const textBody = await res.text();
      let data = null;
      try { data = textBody ? JSON.parse(textBody) : null; } catch {
        throw new Error(t("errors.noApi"));
      }
      if (!res.ok) throw new Error((data && data.error) || t("errors.appRegisterFailed"));
      if (!data || !data.client_id) throw new Error(t("errors.noApi"));
      return data;
    };
    let app;
    try {
      app = await register(redirect + "\n" + OOB);
    } catch {
      app = await register(redirect);
    }
    app._instance = INSTANCE;
    app._redirect = redirect;
    app._scopes = SCOPES;
    localStorage.setItem(LS.app, JSON.stringify(app));
    return app;
  }

  function bytesToB64Url(bytes) {
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let bin = "";
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function makePkce() {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const verifier = bytesToB64Url(raw);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return { verifier, challenge: bytesToB64Url(digest) };
  }

  // GoToSocial (memstore) keeps oauth params only in a server-side session
  // (cookie is just an id; SameSite=Lax; Max-Age ~120s). After login it redirects
  // to bare /oauth/authorize and reloads redirect_uri from that session.
  // A cross-origin no-cors fetch from this app cannot clear/set that cookie, so
  // we do not attempt a preflight — navigate straight to authorize with full query.
  // If GTS was restarted (or load-balanced without sticky memstore) mid-login,
  // GTS shows "key redirect_uri not found in session"; clear site data for the
  // instance and retry without restarting GTS during the flow.
  async function startOAuth() {

    try {
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        $("login-status").textContent = t("login.offlineNoLogin");
        return;
      }
      const parsed = parseInstanceInput($("instance-input") ? $("instance-input").value : "");
      if (!parsed.origin) {
        $("login-status").textContent = tx(parsed.error) || t("errors.instanceRequired");
        return;
      }
      if (!applyInstanceFromInput()) {
        $("login-status").textContent = t("errors.instanceRequired");
        return;
      }
      $("login-status").textContent = t("login.registering");
      const redirect = appBaseUrl();
      const app = await ensureApp(redirect);
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        $("login-status").textContent = t("login.offlineNoLogin");
        return;
      }
      const pkce = await makePkce();
      sessionStorage.setItem(LS.pkce, pkce.verifier);
      const params = new URLSearchParams({
        client_id: app.client_id,
        redirect_uri: redirect,
        response_type: "code",
        scope: SCOPES,
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
      });
      $("login-status").textContent = t("login.redirecting");
      location.href = INSTANCE + "/oauth/authorize?" + params.toString();
    } catch (err) {
      $("login-status").textContent = friendlyConnectError(err);
    }
  }

  async function exchangeCode(rawCode, oob) {
    const code = String(rawCode || ($("oauth-code") && $("oauth-code").value) || "").trim();
    if (!code) {
      $("login-status").textContent = t("login.pasteCode");
      return;
    }
    try {
      if (!INSTANCE && !applyInstanceFromInput()) {
        $("login-status").textContent = t("errors.instanceRequired");
        return;
      }
      if ($("instance-input") && $("instance-input").value) applyInstanceFromInput();
      const redirect = oob ? OOB : appBaseUrl();
      const app = await ensureApp(appBaseUrl());
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: app.client_id,
        redirect_uri: redirect,
        code,
      });
      if (app.client_secret) body.set("client_secret", app.client_secret);
      const verifier = sessionStorage.getItem(LS.pkce);
      if (verifier && !oob) body.set("code_verifier", verifier);
      const token = await fetch(INSTANCE + "/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
      }).then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error_description || data.error || t("errors.tokenFailed"));
        return data;
      });
      sessionStorage.removeItem(LS.pkce);
      state.token = token.access_token;
      localStorage.setItem(LS.token, state.token);
      await refreshMe();
      $("login-status").textContent = t("login.connected");
      bootApp();
    } catch (err) {
      $("login-status").textContent = friendlyConnectError(err);
    }
  }

  async function consumeOAuthRedirect() {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const err = params.get("error");
    if (!code && !err) return false;
    history.replaceState({}, "", location.pathname + location.hash);
    if (err) {
      $("login-status").textContent = params.get("error_description") || err;
      return true;
    }
    $("login-status").textContent = t("login.fetchingToken");
    await exchangeCode(code, false);
    return true;
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
    sessionStorage.removeItem(LS.pkce);
    setColumnExpanded(null);
    state.colBusy = false;
    closeThread();
    stopStreaming();
    stopPolling();
    setLoggedIn(false);
  }

  function escapeHtml(s) {
    return Core.escapeHtml ? Core.escapeHtml(s) : String(s || "");
  }

  function sanitize(html) {
    return Core.sanitize ? Core.sanitize(html) : escapeHtml(html);
  }

  function relTime(iso, nowMs) {
    if (Core.relativeAgeLabel) return Core.relativeAgeLabel(iso, nowMs);
    const now = nowMs == null ? Date.now() : Number(nowMs);
    const d = Math.max(0, (now - new Date(iso).getTime()) / 1000);
    if (d < 60) return Math.floor(d) + "s";
    if (d < 5 * 60) return Math.floor(d / 60) + "m";
    if (d < 3600) return Math.floor(d / (5 * 60)) * 5 + "m";
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
          const label = type === "video" || type === "gifv" ? t("media.showVideo") : type === "audio" ? t("media.showAudio") : t("media.showImage");
          const img = preview && type !== "audio"
            ? `<img alt="${escapeHtml(alt)}" loading="lazy" src="${escapeHtml(preview)}" />`
            : `<span class="media-thumb-fallback" aria-hidden="true">${type === "audio" ? "♪" : "▣"}</span>`;
          const caption = alt ? `<p class="media-alt">${escapeHtml(alt)}</p>` : "";
          return `<div class="media-cell"><button type="button" class="media-thumb" data-media-open title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" data-media-url="${escapeHtml(full)}" data-media-preview="${escapeHtml(preview)}" data-media-type="${escapeHtml(type)}" data-media-alt="${escapeHtml(alt)}">${img}${play ? `<span class="media-play" aria-hidden="true">▶</span>` : ""}</button>${caption}</div>`;
        })
        .join("") +
      `</div>`
    );
  }


  function pollBlock(status, opts = {}) {
    const poll = status && status.poll;
    if (!poll || !Array.isArray(poll.options) || !poll.options.length) return "";
    const closed = Core.pollIsClosed ? Core.pollIsClosed(poll) : Boolean(poll.expired);
    const isOwnPoll = Boolean(state.me && status.account && status.account.id === state.me.id);
    const voted = Core.pollUserVoted
      ? Core.pollUserVoted(poll)
      : Boolean(poll.voted) || (Array.isArray(poll.own_votes) && poll.own_votes.length > 0);
    // Authors see live tallies without voting; GTS forbids self-votes.
    const showResults = closed || voted || isOwnPoll;
    const total = Core.pollTotalVotes ? Core.pollTotalVotes(poll) : Number(poll.votes_count) || 0;
    const own = new Set(Core.pollOwnVotes ? Core.pollOwnVotes(poll) : []);
    const multiple = Boolean(poll.multiple);
    const hideActions = Boolean(opts.hideActions);
    const canVote = !hideActions && !closed && !voted && !isOwnPoll && Boolean(state.token);
    const hidden = status.spoiler_text ? " hidden" : "";
    const optionsHtml = poll.options
      .map((opt, i) => {
        const title = escapeHtml(opt && opt.title != null ? String(opt.title) : "");
        const votes = Number(opt && opt.votes_count) || 0;
        const pct = showResults && Core.pollPercent ? Core.pollPercent(votes, total) : 0;
        const isOwn = own.has(i);
        const classes = ["poll-option"];
        if (isOwn) classes.push("is-own");
        const bar = showResults ? `<span class="poll-bar" style="width:${pct}%"></span>` : "";
        const pctLabel = showResults ? `<span class="poll-option-pct">${pct}%</span>` : "";
        const aria = escapeHtml(t("timeline.poll.optionAria", { title: opt && opt.title != null ? String(opt.title) : "" }));
        if (canVote && multiple) {
          return `<button type="button" class="${classes.join(" ")}" data-act="poll-toggle" data-choice="${i}" aria-pressed="false" aria-label="${aria}"><span class="poll-option-title">${title}</span>${pctLabel}${bar}</button>`;
        }
        if (canVote) {
          return `<button type="button" class="${classes.join(" ")}" data-act="poll-vote" data-choice="${i}" aria-label="${aria}"><span class="poll-option-title">${title}</span>${pctLabel}${bar}</button>`;
        }
        return `<div class="${classes.join(" ")}" role="listitem" aria-label="${aria}"><span class="poll-option-title">${title}</span>${pctLabel}${bar}</div>`;
      })
      .join("");
    const voters = poll.voters_count != null ? Number(poll.voters_count) : null;
    const countLabel =
      multiple && Number.isFinite(voters) && voters >= 0
        ? t("timeline.poll.voters", { count: voters })
        : t("timeline.poll.votes", { count: total });
    let expiry = "";
    if (closed) {
      expiry = t("timeline.poll.ended");
    } else if (poll.expires_at) {
      const rel = Core.relativeFutureLabel ? Core.relativeFutureLabel(poll.expires_at) : "";
      expiry = rel ? t("timeline.poll.endsIn", { rel }) : "";
    }
    const hints = [];
    if (multiple) hints.push(`<span class="poll-hint">${escapeHtml(t("timeline.poll.multiple"))}</span>`);
    if (isOwnPoll && !closed) hints.push(`<span class="poll-hint">${escapeHtml(t("timeline.poll.own"))}</span>`);
    else if (voted && !closed) hints.push(`<span>${escapeHtml(t("timeline.poll.voted"))}</span>`);
    if (expiry) hints.push(`<span>${escapeHtml(expiry)}</span>`);
    hints.push(`<span>${escapeHtml(countLabel)}</span>`);
    const submit =
      canVote && multiple
        ? `<button type="button" class="poll-submit" data-act="poll-submit" disabled>${escapeHtml(t("timeline.poll.vote"))}</button>`
        : "";
    return `<div class="poll" data-poll-id="${escapeHtml(poll.id)}" data-status-id="${escapeHtml(status.id)}" data-multiple="${multiple ? "1" : "0"}"${hidden} role="group">
      <div class="poll-options"${showResults ? ' role="list"' : ""}>${optionsHtml}</div>
      ${submit}
      <div class="poll-meta">${hints.join("")}</div>
    </div>`;
  }

  /** Per-status translation UI state for this session (id → record). */
  const translateCache = new Map();

  function statusPlainForDetect(s) {
    try {
      return htmlToPlain(s && s.content ? s.content : "");
    } catch {
      return String((s && s.content) || "").replace(/<[^>]+>/g, " ");
    }
  }

  function translateBtnHtml(s) {
    if (!Tr || !Tr.shouldOffer) return "";
    const plain = statusPlainForDetect(s);
    const target = Tr.targetLocale ? Tr.targetLocale() : (I18n.getLocale ? I18n.getLocale() : "de");
    if (!Tr.shouldOffer(s.language, plain, target)) return "";
    const cached = translateCache.get(s.id);
    if (cached && cached.showing === "translation") {
      return `<button type="button" class="nb-translate is-active" data-act="translate" aria-label="${escapeHtml(t("a11y.showOriginal"))}" title="${escapeHtml(t("translate.showOriginal"))}"><span class="nb-translate-glyph" aria-hidden="true">⇄</span>${escapeHtml(t("translate.showOriginal"))}</button>`;
    }
    const label = cached && cached.translatedHtml ? t("translate.showTranslation") : t("translate.action");
    const aria = cached && cached.translatedHtml ? t("a11y.showTranslation") : t("a11y.translate");
    return `<button type="button" class="nb-translate" data-act="translate" aria-label="${escapeHtml(aria)}" title="${escapeHtml(label)}"><span class="nb-translate-glyph" aria-hidden="true">あ</span>${escapeHtml(label)}</button>`;
  }

  const FLIP_GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ§$%&#@*+=<>?/\\|";

  function startFlipAnimation(contentEl) {
    if (!contentEl) return;
    const plain = (contentEl.textContent || "").replace(/\s+/g, " ").trim();
    const sample = plain.slice(0, 80) || "TRANSLATING";
    contentEl.classList.add("nb-translating");
    contentEl.classList.remove("nb-translated", "nb-translate-error");
    let html = "";
    for (let i = 0; i < sample.length; i++) {
      const ch = sample[i];
      if (ch === " ") {
        html += " ";
        continue;
      }
      const g = FLIP_GLYPHS[i % FLIP_GLYPHS.length];
      html += `<span class="nb-flip" style="--i:${i}">${escapeHtml(g)}</span>`;
    }
    contentEl.innerHTML = html || `<span class="nb-flip" style="--i:0">§</span>`;
  }

  function paintTranslateButton(article, record) {
    if (!article) return;
    const btn = article.querySelector('button[data-act="translate"]');
    if (!btn) return;
    if (record && record.showing === "translation") {
      btn.classList.add("is-active");
      btn.innerHTML = `<span class="nb-translate-glyph" aria-hidden="true">⇄</span>${escapeHtml(t("translate.showOriginal"))}`;
      btn.setAttribute("aria-label", t("a11y.showOriginal"));
      btn.title = t("translate.showOriginal");
    } else {
      btn.classList.remove("is-active");
      const has = record && record.translatedHtml;
      const label = has ? t("translate.showTranslation") : t("translate.action");
      const aria = has ? t("a11y.showTranslation") : t("a11y.translate");
      btn.innerHTML = `<span class="nb-translate-glyph" aria-hidden="true">あ</span>${escapeHtml(label)}`;
      btn.setAttribute("aria-label", aria);
      btn.title = label;
    }
    btn.disabled = false;
  }

  async function handleTranslateClick(article, btn) {
    const id = article.getAttribute("data-id");
    if (!id) return;
    const content = article.querySelector(".content");
    if (!content) return;
    let record = translateCache.get(id);
    if (record && record.translatedHtml) {
      if (record.showing === "translation") {
        content.innerHTML = record.originalHtml;
        content.classList.remove("nb-translated", "nb-translating", "nb-translate-error");
        record.showing = "original";
        paintTranslateButton(article, record);
        return;
      }
      content.innerHTML = record.translatedHtml;
      content.classList.add("nb-translated");
      content.classList.remove("nb-translating", "nb-translate-error");
      record.showing = "translation";
      paintTranslateButton(article, record);
      return;
    }

    if (!Tr || !Tr.isAvailable || !Tr.isAvailable()) {
      content.classList.add("nb-translate-error");
      const note = document.createElement("p");
      note.className = "nb-translate-error";
      note.textContent = t("translate.unavailable");
      content.appendChild(note);
      return;
    }

    const originalHtml = content.innerHTML;
    const fromAttr = article.getAttribute("data-status-lang") || "";
    const plain = statusPlainForDetect({ content: originalHtml, language: fromAttr });
    const from = Tr.resolveSourceLang ? Tr.resolveSourceLang(fromAttr, plain) : fromAttr;
    const to = Tr.targetLocale ? Tr.targetLocale() : (I18n.getLocale ? I18n.getLocale() : "de");
    if (Tr.langsEqual && Tr.langsEqual(from, to)) {
      btn.title = t("translate.sameLanguage");
      return;
    }

    btn.disabled = true;
    btn.textContent = t("translate.loading");
    startFlipAnimation(content);

    try {
      const translated = await Tr.translate(originalHtml, from, to, {
        html: true,
        onProgress: (phase) => {
          if (phase === "downloading") btn.textContent = t("translate.downloading");
          else btn.textContent = t("translate.loading");
        },
      });
      const safe = sanitize(translated || "");
      record = {
        originalHtml,
        translatedHtml: safe,
        showing: "translation",
        from,
        to,
      };
      translateCache.set(id, record);
      content.innerHTML = safe;
      content.classList.remove("nb-translating", "nb-translate-error");
      content.classList.add("nb-translated");
      paintTranslateButton(article, record);
    } catch (err) {
      content.innerHTML = originalHtml;
      content.classList.remove("nb-translating", "nb-translated");
      const code = err && err.code;
      let msg = t("translate.error");
      if (code === "unsupportedPair") msg = t("translate.unsupportedPair");
      else if (code === "downloadFailed") msg = t("translate.downloadFailed");
      else if (code === "unavailable") msg = t("translate.unavailable");
      const note = document.createElement("p");
      note.className = "nb-translate-error";
      note.textContent = msg;
      content.appendChild(note);
      paintTranslateButton(article, null);
      btn.disabled = false;
    }
  }


  function statusHtml(status, opts = {}) {
    const boosted = status.reblog ? status : null;
    const s = status.reblog || status;
    const cw = s.spoiler_text
      ? `<div class="cw"><strong>${escapeHtml(s.spoiler_text)}</strong><br /><button type="button" data-act="cw">${escapeHtml(t("timeline.cwShow"))}</button></div>`
      : "";
    const body = `<div class="content"${s.spoiler_text ? " hidden" : ""}>${sanitize(s.content)}</div>`;
    const boostLine = boosted
      ? `<div class="boost-line">↻ <button type="button" class="acct-open-inline" data-acct-open="${escapeHtml(boosted.account.id)}">${escapeHtml(boosted.account.display_name || boosted.account.username)}</button> ${escapeHtml(t("timeline.boosted"))}</div>`
      : "";
    const extraClass = opts.root ? " is-thread-root" : "";
    const own = Boolean(state.me && s.account && s.account.id === state.me.id);
    const ownBtns = own
      ? `<button type="button" data-act="edit">${escapeHtml(t("common.edit"))}</button><button type="button" data-act="delete" class="danger">${escapeHtml(t("common.delete"))}</button>`
      : "";
    const langCode = (Tr.normalizeLang && Tr.normalizeLang(s.language)) || "";
    const langAttr = langCode ? ` data-status-lang="${escapeHtml(langCode)}"` : "";
    const translateBtn = opts.hideActions ? "" : translateBtnHtml(s);
    return `<article class="status${extraClass}" data-id="${escapeHtml(s.id)}" data-acct="${escapeHtml(s.account.id)}"${langAttr}>
      ${boostLine}
      <div class="status-head">${accountLine(s.account)}</div>
      ${cw}${body}${pollBlock(s, opts)}${mediaBlock(s)}
      ${opts.hideActions ? "" : `<div class="actions">
        <button type="button" data-act="reply">↩ ${s.replies_count || 0}</button>
        <button type="button" data-act="boost" class="${s.reblogged ? "on-boost" : ""}">↻ ${s.reblogs_count || 0}</button>
        <button type="button" data-act="fav" class="${s.favourited ? "on-fav" : ""}">★ ${s.favourites_count || 0}</button>
        ${translateBtn}
        <button type="button" data-act="open">${escapeHtml(t("common.profile"))}</button>
        ${ownBtns}
      </div>`}
    </article>`;
  }

  function paintTime(root, iso) {
    const el = root.querySelector(".time");
    if (!el || !iso) return;
    el.setAttribute("data-created-at", iso);
    el.textContent = relTime(iso);
  }

  function tickRelativeAges() {
    const now = Date.now();
    document.querySelectorAll(".time[data-created-at]").forEach((el) => {
      const iso = el.getAttribute("data-created-at");
      if (!iso) return;
      const next = relTime(iso, now);
      if (el.textContent !== next) el.textContent = next;
    });
  }

  function startRelativeAgeTicker() {
    if (state.ageTimer) return;
    tickRelativeAges();
    state.ageTimer = setInterval(() => {
      if (document.hidden) return;
      tickRelativeAges();
    }, 1000);
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
    if (window.NightDB) NightDB.hydrateMedia(el);
  }

  function noticeHtml(n) {
    const kind = {
      follow: t("timeline.notif.follow"),
      follow_request: t("timeline.notif.followRequest"),
      mention: t("timeline.notif.mention"),
      reblog: t("timeline.notif.reblog"),
      favourite: t("timeline.notif.favourite"),
      poll: t("timeline.notif.poll"),
      status: t("timeline.notif.status"),
      update: t("timeline.notif.update"),
    }[n.type] || n.type;
    const status = n.status ? statusHtml(n.status) : "";
    return `<div class="notice" data-acct="${escapeHtml(n.account.id)}">
      <div class="notif-kind"><button type="button" class="acct-open-inline" data-acct-open="${escapeHtml(n.account.id)}">${escapeHtml(n.account.acct)}</button> ${escapeHtml(kind)}</div>
      <div class="status-head">${accountLine(n.account)}</div>
      ${status}
    </div>`;
  }

  function notifMatchesFilter(n, filter) {
    if (!n) return false;
    if (!filter || filter === "all") return true;
    if (filter === "mention") return n.type === "mention";
    if (filter === "follow") return n.type === "follow" || n.type === "follow_request";
    return n.type === filter;
  }

  function renderNotifications(el, items) {
    const visible = (items || []).filter((n) => notifMatchesFilter(n, state.notifFilter));
    if (!visible.length) {
      el.innerHTML = `<div class="empty">${escapeHtml(t("timeline.notifEmpty"))}</div>`;
      return;
    }
    el.innerHTML = visible.map((n) => noticeHtml(n)).join("");
    [...el.children].forEach((node, i) => paintTime(node, visible[i].created_at));
    if (window.NightDB) NightDB.hydrateMedia(el);
  }

  function cacheTimelineItems(items) {
    if (!window.NightDB || !items || !items.length) return;
    items.forEach((it) => {
      NightDB.cacheItemMedia(it);
      const inner = it.reblog || it;
      if (inner && inner.id && !it.type) NightDB.saveStatus(inner);
      if (it.status) NightDB.saveStatus(it.status);
    });
  }

  function paintTimelineItem(name, item) {
    const wrap = document.createElement("div");
    wrap.innerHTML = name === "notifications" ? noticeHtml(item) : statusHtml(item);
    const node = wrap.firstElementChild;
    if (!node) return null;
    const timed = item.reblog || item;
    if (timed && timed.created_at) paintTime(node, timed.created_at);
    return node;
  }

  function hydrateNodes(nodes) {
    if (!window.NightDB || !nodes || !nodes.length) return Promise.resolve();
    return Promise.all(nodes.map((node) => NightDB.hydrateMedia(node)));
  }

  function keepScrollAnchor(el, anchor, top) {
    if (!el || !anchor || !anchor.isConnected) return;
    const delta = anchor.getBoundingClientRect().top - top;
    if (Math.abs(delta) >= 0.5) el.scrollTop += delta;
  }

  function trimTimeline(name) {
    const tl = state.timelines[name];
    const el = $(name + "-body");
    if (!tl || tl.items.length <= TIMELINE_CAP) return;
    const drop = tl.items.length - TIMELINE_CAP;
    tl.items.splice(TIMELINE_CAP, drop);
    if (el) {
      const nodes = [...el.children].filter((n) => n.classList.contains("status") || n.classList.contains("notice"));
      for (let i = 0; i < drop; i++) {
        const node = nodes[nodes.length - 1 - i];
        if (node) node.remove();
      }
    }
    tl.maxId = tl.items.length ? tl.items[tl.items.length - 1].id : null;
    tl.done = false;
  }

  function appendTimelineNodes(name, fresh) {
    const el = $(name + "-body");
    if (!el || !fresh.length) return;
    const placeholder = el.querySelector(":scope > .empty, :scope > .error");
    if (placeholder) placeholder.remove();
    const nodes = fresh.map((item) => paintTimelineItem(name, item)).filter(Boolean);
    nodes.forEach((node) => el.appendChild(node));
    hydrateNodes(nodes);
  }

  function renderTimeline(name, el) {
    const tl = state.timelines[name];
    if (name === "notifications") renderNotifications(el, tl.items);
    else renderStatusList(el, tl.items, t("timeline.empty"));
  }

  async function loadTimeline(name, reset) {
    const tl = state.timelines[name];
    if ((tl.loading && !reset) || (tl.done && !reset)) return;
    tl.loading = true;
    tl.seq = (tl.seq || 0) + 1;
    const seq = tl.seq;
    const el = $(name + "-body");
    if (reset) {
      tl.items = [];
      tl.maxId = null;
      tl.done = false;
      el.innerHTML = `<div class="empty">${escapeHtml(t("timeline.loading"))}</div>`;
    }
    try {
      let path = timelinePath(name);
      if (tl.maxId) path += "&max_id=" + encodeURIComponent(tl.maxId);
      const batch = await api(path);
      if (seq !== tl.seq) return;
      if (!batch.length) {
        tl.done = true;
        if (!tl.items.length) renderTimeline(name, el);
      } else {
        const incremental = tl.items.length > 0 && !reset;
        tl.items = tl.items.concat(batch);
        tl.maxId = batch[batch.length - 1].id;
        if (incremental) appendTimelineNodes(name, batch);
        else renderTimeline(name, el);
        trimTimeline(name);
        if (!incremental || reset) syncTimelineUnread(name);
      }
      if (window.NightDB) {
        NightDB.saveTimeline(name, tl.items);
        cacheTimelineItems(reset ? tl.items : batch);
      }
    } catch (err) {
      if (seq !== tl.seq) return;
      if (window.NightDB) {
        const cached = await NightDB.loadTimeline(name);
        if (seq !== tl.seq) return;
        if (cached.length) {
          tl.items = cached;
          tl.maxId = cached[cached.length - 1].id;
          tl.done = false;
          renderTimeline(name, el);
          syncTimelineUnread(name);
          return;
        }
      }
      el.innerHTML = `<div class="error">${escapeHtml(tx(err.message))}</div>`;
    } finally {
      if (seq === tl.seq) tl.loading = false;
    }
  }

  function bindColumnScroll(name) {
    const el = $(name + "-body");
    el.addEventListener("scroll", () => {
      if (el.scrollTop + el.clientHeight > el.scrollHeight - 200) loadTimeline(name, false);
    });
  }

  function detailWindowOpen() {
    return ["thread-dialog", "overlay-dialog", "outbox-dialog", "compose-dialog", "media-dialog", "drafts-dialog", "confirm-dialog", "sw-update-dialog"]
      .some((id) => {
        const el = $(id);
        return el && el.open;
      });
  }

  function notifExcludeTypes(filter) {
    const all = ["mention", "status", "reblog", "follow", "follow_request", "favourite", "poll", "update"];
    if (!filter || filter === "all") return [];
    if (filter === "mention") return all.filter((t) => t !== "mention");
    if (filter === "follow") return all.filter((t) => t !== "follow" && t !== "follow_request");
    return all.filter((t) => t !== filter);
  }

  function timelinePath(name, extra) {
    let path;
    if (name === "home") path = "/api/v1/timelines/home?limit=30";
    else if (name === "local") path = "/api/v1/timelines/public?local=true&limit=30";
    else if (name === "federated") path = "/api/v1/timelines/public?limit=30";
    else {
      path = "/api/v1/notifications?limit=30";
      notifExcludeTypes(state.notifFilter).forEach((t) => {
        path += "&exclude_types[]=" + encodeURIComponent(t);
      });
    }
    if (extra) path += extra;
    return path;
  }

  function prependTicker(name, fresh) {
    const el = $(name + "-body");
    if (!el) return;
    const placeholder = el.querySelector(".empty, .error");
    if (placeholder) placeholder.remove();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const stick = el.scrollTop > 24;
    const anchor = stick ? el.firstElementChild : null;
    const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
    const pin = () => keepScrollAnchor(el, anchor, anchorTop);
    const nodes = fresh.map((item) => paintTimelineItem(name, item)).filter(Boolean);
    nodes.slice().reverse().forEach((node, revI) => {
      if (!reduce) {
        node.classList.add("is-ticker");
        node.style.animationDelay = revI * 0.16 + "s";
        node.addEventListener(
          "animationend",
          () => {
            node.classList.remove("is-ticker");
            node.style.animationDelay = "";
            pin();
          },
          { once: true }
        );
      }
      el.insertBefore(node, el.firstChild);
    });
    if (stick) {
      pin();
      requestAnimationFrame(() => {
        pin();
        requestAnimationFrame(pin);
      });
      if (typeof ResizeObserver === "function") {
        const ro = new ResizeObserver(pin);
        nodes.forEach((node) => ro.observe(node));
        setTimeout(() => ro.disconnect(), 2500);
      }
      nodes.forEach((node) => {
        node.querySelectorAll("img, video").forEach((media) => {
          media.addEventListener("load", pin, { once: true });
          media.addEventListener("loadeddata", pin, { once: true });
        });
      });
    }
    const hydrated = hydrateNodes(nodes);
    if (hydrated && hydrated.then) hydrated.then(pin);
    trimTimeline(name);
    if (stick) pin();
  }

  async function fetchNewer(name) {
    const tl = state.timelines[name];
    if (!tl || tl.loading || !tl.items.length) return;
    const sinceId = tl.items[0] && tl.items[0].id;
    if (!sinceId) return;
    try {
      const batch = await api(timelinePath(name, "&since_id=" + encodeURIComponent(sinceId)));
      if (!Array.isArray(batch) || !batch.length) return;
      const known = new Set(tl.items.map((s) => s.id));
      const fresh = batch.filter((s) => s && s.id && !known.has(s.id));
      if (!fresh.length) return;
      tl.items = fresh.concat(tl.items);
      prependTicker(name, fresh);
      syncTimelineUnread(name);
      if (window.NightDB) {
        NightDB.saveTimeline(name, tl.items);
        cacheTimelineItems(fresh);
      }
    } catch {
      /* keep current list */
    }
  }

  async function pollNewPosts() {
    if (!state.carrierWanted || !state.token || detailWindowOpen() || document.hidden) return;
    if (state.usingStream) return;
    await Promise.all([fetchNewer("home"), fetchNewer("local"), fetchNewer("federated"), fetchNewer("notifications")]);
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

  function rememberStreamingUrl(data) {
    if (!data || typeof data !== "object") return;
    const urls = data.urls || {};
    const raw = urls.streaming_api || urls.streaming || "";
    if (raw) state.streamingUrl = String(raw);
  }

  function streamingWsBase() {
    const raw = String(state.streamingUrl || "").trim();
    if (raw) return raw.replace(/\/$/, "");
    return INSTANCE.replace(/^http/i, "ws");
  }

  function buildStreamUrl(stream) {
    let base = streamingWsBase();
    if (!/\/api\/v1\/streaming$/i.test(base)) base += "/api/v1/streaming";
    const u = new URL(base);
    u.searchParams.set("access_token", state.token);
    u.searchParams.set("stream", stream);
    return u.toString();
  }

  function parseStreamPayload(event, payload) {
    if (payload && typeof payload === "object") return payload;
    if (typeof payload !== "string" || !payload) return payload;
    if (event === "delete") return payload;
    try { return JSON.parse(payload); } catch { return payload; }
  }


  function ensurePostedOnTimelines(status) {
    const s = unwrapStatus(status);
    if (!s || !s.id || status && status.queued) return;
    ingestStatus("home", s);
    const vis = s.visibility || "public";
    if (vis === "public" || vis === "unlisted") {
      ingestStatus("local", s);
    }
    if (vis === "public") {
      ingestStatus("federated", s);
    }
  }

  function ingestStatus(name, status) {
    const s = unwrapStatus(status);
    if (!s || !s.id) return;
    const tl = state.timelines[name];
    if (!tl) return;
    if ((tl.items || []).some((it) => it && (it.id === s.id || (it.reblog && it.reblog.id === s.id)))) {
      replaceStatusEverywhere(s);
      return;
    }
    tl.items = [status].concat(tl.items || []);
    prependTicker(name, [status]);
    syncTimelineUnread(name);
    if (window.NightDB) {
      NightDB.saveTimeline(name, tl.items);
      cacheTimelineItems([status]);
    }
  }

  function ingestNotification(n) {
    if (!n || !n.id) return;
    const tl = state.timelines.notifications;
    if (!tl) return;
    if ((tl.items || []).some((it) => it && it.id === n.id)) return;
    tl.items = [n].concat(tl.items || []);
    if (notifMatchesFilter(n, state.notifFilter)) prependTicker("notifications", [n]);
    syncTimelineUnread("notifications");
    if (window.NightDB) {
      NightDB.saveTimeline("notifications", tl.items);
      cacheTimelineItems([n]);
    }
  }

  function handleStreamEvent(source, event, payload) {
    const data = parseStreamPayload(event, payload);
    if (event === "delete") {
      removeStatusEverywhere(String(data || payload || ""));
      return;
    }
    if (event === "status.update" && data) {
      replaceStatusEverywhere(data);
      return;
    }
    if (event === "notification" && data) {
      ingestNotification(data);
      return;
    }
    if (event === "update" && data) {
      const col = source === "local" || source === "federated" || source === "home" ? source : "home";
      ingestStatus(col, data);
    }
  }

  function openStream(stream, source) {
    if (!state.token || typeof WebSocket !== "function") return null;
    let ws;
    try {
      ws = new WebSocket(buildStreamUrl(stream));
    } catch {
      return null;
    }
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleStreamEvent(source, msg.event, msg.payload);
    };
    return ws;
  }

  function stopStreaming() {
    if (state.streamRetry) {
      clearTimeout(state.streamRetry);
      state.streamRetry = null;
    }
    (state.streams || []).forEach((ws) => {
      try {
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      } catch { /* ignore */ }
    });
    state.streams = [];
    state.usingStream = false;
  }

  function scheduleStreamRetry() {
    if (state.streamRetry || !state.carrierWanted || state.conn !== "online" || !state.token) return;
    state.streamRetry = setTimeout(() => {
      state.streamRetry = null;
      startStreaming();
    }, 8000);
  }

  function startStreaming() {
    stopStreaming();
    if (!state.token || !state.carrierWanted || state.conn !== "online") return;
    const sockets = [
      openStream("user", "home"),
      openStream("public:local", "local"),
      openStream("public", "federated"),
    ].filter(Boolean);
    state.streams = sockets;
    if (!sockets.length) return;
    sockets.forEach((ws) => {
      ws.onopen = () => {
        state.usingStream = true;
      };
      ws.onclose = () => {
        state.usingStream = state.streams.some((s) => s && s.readyState === 1);
        if (!state.usingStream) {
          if (state.carrierWanted && state.conn === "online" && state.token) startPolling();
          scheduleStreamRetry();
        }
      };
    });
  }

  function startLiveUpdates() {
    if (!state.token || !state.carrierWanted) return;
    startStreaming();
    startPolling();
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
      btn.title = on ? t("common.shrink") : t("common.expand");
      btn.setAttribute("aria-label", on ? t("nav.shrinkCol", { name: id }) : t("nav.expandCol", { name: id }));
      btn.textContent = on ? "⤡" : "⤢";
    });
  }

  function allCollapsed() {
    const out = {};
    COLS.forEach((id) => { out[id] = true; });
    return out;
  }

  function readCollapsed() {
    const raw = localStorage.getItem(LS.collapsed);
    if (raw == null) {
      localStorage.setItem(LS.collapsed, JSON.stringify(COLS));
      return allCollapsed();
    }
    const out = {};
    COLS.forEach((id) => { out[id] = false; });
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach((id) => {
          if (id in out) out[id] = true;
        });
        // Prefs from before federated existed: keep new column collapsed.
        if (!parsed.includes("federated") && "federated" in out) {
          const legacy = parsed.every((id) => id === "home" || id === "local" || id === "notifications");
          if (legacy) out.federated = true;
        }
        return out;
      }
    } catch { /* default all minimized */ }
    return allCollapsed();
  }

  function saveCollapsed() {
    localStorage.setItem(LS.collapsed, JSON.stringify(COLS.filter((id) => state.collapsed[id])));
  }

  function emptySeen() {
    const out = {};
    COLS.forEach((id) => { out[id] = ""; });
    return out;
  }

  function emptyUnread() {
    const out = {};
    COLS.forEach((id) => { out[id] = false; });
    return out;
  }

  function loadSeenState() {
    try {
      const data = JSON.parse(localStorage.getItem(LS.seen) || "null");
      if (!data || data.instance !== INSTANCE) {
        state.seen = emptySeen();
        state.unread = emptyUnread();
        paintUnread();
        return;
      }
      state.seen = {
        home: String(data.home || ""),
        local: String(data.local || ""),
        federated: String(data.federated || ""),
        notifications: String(data.notifications || ""),
      };
      const u = data.unread || {};
      state.unread = {
        home: Boolean(u.home),
        local: Boolean(u.local),
        federated: Boolean(u.federated),
        notifications: Boolean(u.notifications),
      };
    } catch {
      state.seen = emptySeen();
      state.unread = emptyUnread();
    }
    paintUnread();
  }

  function persistSeen() {
    if (!INSTANCE) return;
    localStorage.setItem(LS.seen, JSON.stringify({
      instance: INSTANCE,
      home: state.seen.home || "",
      local: state.seen.local || "",
      federated: state.seen.federated || "",
      notifications: state.seen.notifications || "",
      unread: {
        home: Boolean(state.unread.home),
        local: Boolean(state.unread.local),
        federated: Boolean(state.unread.federated),
        notifications: Boolean(state.unread.notifications),
      },
    }));
  }

  function newestItemId(name) {
    const items = state.timelines[name] && state.timelines[name].items;
    if (!items || !items.length || !items[0] || !items[0].id) return "";
    return String(items[0].id);
  }

  function idNewer(a, b) {
    return Core.idNewer ? Core.idNewer(a, b) : false;
  }

  function markTimelineRead(name) {
    const id = newestItemId(name);
    if (id) state.seen[name] = id;
    state.unread[name] = false;
    persistSeen();
    paintUnread();
  }

  function syncTimelineUnread(name) {
    const newest = newestItemId(name);
    if (!newest) return;
    if (!state.seen[name]) {
      state.seen[name] = newest;
      state.unread[name] = false;
      persistSeen();
      paintUnread();
      return;
    }
    const hasNew = idNewer(newest, state.seen[name]);
    if (state.collapsed[name]) {
      state.unread[name] = hasNew;
    } else {
      if (hasNew) state.seen[name] = newest;
      state.unread[name] = false;
    }
    persistSeen();
    paintUnread();
  }

  function colEl(name) {
    return document.querySelector('.col[data-col="' + name + '"]');
  }

  function dockBtn(name) {
    return document.querySelector('.dock-icon[data-restore="' + name + '"]');
  }

  function paintUnread() {
    COLS.forEach((id) => {
      const btn = dockBtn(id);
      if (btn) btn.classList.toggle("has-unread", Boolean(state.unread[id]));
    });
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
    paintUnread();
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
      paintUnread();
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
      markTimelineRead(name);
      paintCollapsed();
      paintUnread();
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
      ? t("thread.replyTo", { name: prefix })
      : t("thread.replyToAcct", { acct: s.account.acct || s.account.username });
    document.querySelectorAll("#thread-body .status").forEach((n) => {
      n.classList.toggle("is-reply-target", n.getAttribute("data-id") === id);
    });
    const ta = $("thread-reply-text");
    const mention = prefix ? prefix + " " : "";
    const prevMention = prev ? mentionPrefix(prev) : "";
    const trimmed = ta.value.trim();
    if (!trimmed || trimmed === prevMention) ta.value = mention;
    paintThreadReplyCount();
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
          ? `<div class="thread-replies-empty">${escapeHtml(t("thread.repliesMissingLocal", { count: n }))}${remote}</div>`
          : `<div class="thread-replies-empty">${escapeHtml(t("thread.noReplies"))}</div>`;
    }
    $("thread-body").innerHTML =
      ancestorHtml +
      `<div class="thread-root">${statusHtml(root, { root: true })}</div>` +
      repliesHtml;
    paintThreadTimes($("thread-body"), ancestors.concat([root], descendants));
    if (window.NightDB) {
      NightDB.hydrateMedia($("thread-body"));
      [root].concat(ancestors, descendants).forEach((s) => {
        NightDB.saveStatus(s);
        NightDB.cacheItemMedia(s);
      });
    }
    $("thread-title").textContent = t("thread.titleWithAcct", { acct: root.account.acct || "Post" });
    if (!$("thread-reply-form").hidden) {
      const keepId = (state.threadReplyTo && state.threadById.has(state.threadReplyTo.id) && state.threadReplyTo.id) || root.id;
      selectThreadReply(keepId);
    }
  }

  async function cachedThreadContext(id) {
    if (!window.NightDB) return null;
    const status = unwrapStatus(await NightDB.loadStatus(id));
    if (!status) return null;
    const all = await NightDB.allCachedStatuses();
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
      if (discard !== true) return;
    }
    const dlg = $("thread-dialog");
    state.threadRootId = id;
    $("thread-title").textContent = t("thread.title");
    $("thread-body").innerHTML = "<p class='hint'>" + escapeHtml(t("thread.loading")) + "</p>";
    $("thread-reply-status").textContent = "";
    if (!opts.keepDraft) {
      if (opts.focusReply) {
        $("thread-reply-text").value = "";
        paintThreadReplyCount();
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
    if (state.threadAttach.length) return true;
    const raw = $("thread-reply-text").value.trim();
    if (!raw) return false;
    const expected = state.threadReplyTo ? mentionPrefix(state.threadReplyTo) : "";
    if (expected && raw === expected) return false;
    return true;
  }

  function askConfirm({ title, message, noLabel, yesLabel }) {
    return new Promise((resolve) => {
      const dlg = $("confirm-dialog");
      const titleEl = $("confirm-title");
      const msgEl = $("confirm-message");
      const noBtn = $("confirm-no");
      const yesBtn = $("confirm-yes");
      if (titleEl) titleEl.textContent = title;
      if (msgEl) msgEl.textContent = message;
      if (noBtn) noBtn.textContent = noLabel;
      if (yesBtn) yesBtn.textContent = yesLabel;
      const finish = (yes) => {
        yesBtn.onclick = null;
        noBtn.onclick = null;
        dlg.oncancel = null;
        if (dlg.open) dlg.close();
        resolve(yes);
      };
      yesBtn.onclick = () => finish(true);
      noBtn.onclick = () => finish(false);
      dlg.oncancel = (ev) => {
        ev.preventDefault();
        finish(null);
      };
      dlg.showModal();
    });
  }

  function askDiscardReply() {
    return askConfirm({
      title: t("thread.discardTitle"),
      message: t("thread.discardMessage"),
      noLabel: t("thread.keepWriting"),
      yesLabel: t("common.discard"),
    });
  }

  function askMissingAlt() {
    return askConfirm({
      title: t("compose.missingAltTitle"),
      message: t("compose.missingAltMessage"),
      noLabel: t("common.back"),
      yesLabel: t("compose.sendAnyway"),
    });
  }

  function hideReplyComposer() {
    $("thread-reply-form").hidden = true;
    $("thread-reply-text").value = "";
    $("thread-reply-status").textContent = "";
    paintThreadReplyCount();
    $("thread-reply-to").textContent = "";
    document.querySelectorAll("#thread-body .status").forEach((n) => {
      n.classList.remove("is-reply-target");
    });
    state.threadReplyTo = null;
    revokeAttach(state.threadAttach);
    state.threadAttach = [];
    paintAttachList("thread-attach-list", state.threadAttach, "thread");
  }

  function openReplyComposer(id) {
    $("thread-reply-form").hidden = false;
    selectThreadReply(id);
    $("thread-reply-text").focus();
  }

  async function requestCloseReplyComposer() {
    if (threadDraftPending()) {
      const discard = await askDiscardReply();
      if (discard !== true) {
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
      if (discard !== true) {
        $("thread-reply-text").focus();
        return;
      }
    }
    closeThread();
  }


  function normalizePollPayload(poll) {
    if (!poll || typeof poll !== "object" || !Array.isArray(poll.options)) return null;
    if (Core.pollUserVoted && poll.voted && !Core.pollUserVoted(poll)) {
      return Object.assign({}, poll, { voted: false });
    }
    return poll;
  }

  async function applyPollToStatus(statusId, poll) {
    if (!statusId || !poll) return;
    const normalized = normalizePollPayload(poll) || poll;
    const local = findLocalStatus(statusId);
    if (local) {
      replaceStatusEverywhere(Object.assign({}, unwrapStatus(local), { poll: normalized }));
      return;
    }
    try {
      const s = unwrapStatus(await api("/api/v1/statuses/" + encodeURIComponent(statusId)));
      if (s) replaceStatusEverywhere(Object.assign({}, s, { poll: normalized || s.poll }));
    } catch (err) {
      alert(err.message);
    }
  }

  async function submitPollVote(article, btn, act) {
    const pollEl = (btn && btn.closest(".poll")) || (article && article.querySelector(".poll"));
    if (!pollEl || !article) return;
    const pollId = pollEl.getAttribute("data-poll-id");
    const statusId = pollEl.getAttribute("data-status-id") || article.getAttribute("data-id");
    if (!pollId || !statusId) return;
    const acctId = article.getAttribute("data-acct");
    if (state.me && acctId && acctId === String(state.me.id)) {
      alert(t("timeline.poll.own"));
      return;
    }
    let choices = [];
    if (act === "poll-vote") {
      const choice = Number(btn.getAttribute("data-choice"));
      if (!Number.isInteger(choice) || choice < 0) return;
      choices = [choice];
    } else {
      choices = [...pollEl.querySelectorAll(".poll-option.is-selected")].map((el) => Number(el.getAttribute("data-choice")))
        .filter((n) => Number.isInteger(n) && n >= 0);
    }
    if (!choices.length) return;
    const controls = pollEl.querySelectorAll("button");
    controls.forEach((el) => {
      el.disabled = true;
    });
    try {
      const raw = await api("/api/v1/polls/" + encodeURIComponent(pollId) + "/votes", {
        method: "POST",
        body: { choices },
      });
      const poll = normalizePollPayload(raw);
      if (!poll) throw new Error(t("common.error"));
      // Successful foreign vote must reflect a real ballot (own_votes or voted with tallies).
      if (Core.pollUserVoted && !Core.pollUserVoted(poll)) {
        throw new Error(t("common.error"));
      }
      await applyPollToStatus(statusId, poll);
    } catch (err) {
      controls.forEach((el) => {
        el.disabled = false;
      });
      const submit = pollEl.querySelector('[data-act="poll-submit"]');
      if (submit) {
        submit.disabled = pollEl.querySelectorAll(".poll-option.is-selected").length === 0;
      }
      alert(err && err.message ? err.message : t("common.error"));
    }
  }

  async function actOnStatus(id, act, btn) {
    try {
      if (act === "fav") {
        const on = btn.classList.contains("on-fav");
        const s = await api(`/api/v1/statuses/${id}/${on ? "unfavourite" : "favourite"}`, { method: "POST" });
        replaceStatusEverywhere(unwrapStatus(s));
      } else if (act === "boost") {
        const on = btn.classList.contains("on-boost");
        const s = await api(`/api/v1/statuses/${id}/${on ? "unreblog" : "reblog"}`, { method: "POST" });
        replaceStatusEverywhere(unwrapStatus(s));
      } else if (act === "reply") {
        if ($("thread-dialog").open && state.threadById.has(id)) {
          openReplyComposer(id);
          return;
        }
        openThread(id, { focusReply: true });
      } else if (act === "edit") {
        await openEditStatus(id);
      } else if (act === "delete") {
        await deleteOwnStatus(id);
      }
    } catch (err) {
      alert(err.message);
    }
  }

  function htmlToPlain(html) {
    const doc = new DOMParser().parseFromString("<div>" + (html || "") + "</div>", "text/html");
    return String(doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  }

  function findLocalStatus(id) {
    if (!id) return null;
    if (state.threadById.has(id)) return state.threadById.get(id);
    for (const name of COLS) {
      const items = state.timelines[name] && state.timelines[name].items;
      if (!items) continue;
      for (const it of items) {
        if (it && it.id === id && !it.reblog) return it;
        if (it && it.reblog && it.reblog.id === id) return it.reblog;
        if (it && it.status && it.status.id === id) return unwrapStatus(it.status);
      }
    }
    return null;
  }

  function patchStatusInList(items, updated) {
    return items.map((it) => {
      if (!it || !updated) return it;
      if (it.id === updated.id && !it.reblog) return updated;
      if (it.reblog && it.reblog.id === updated.id) return Object.assign({}, it, { reblog: updated });
      if (it.status && it.status.id === updated.id) return Object.assign({}, it, { status: updated });
      return it;
    });
  }

  function replaceStatusNode(root, updated) {
    if (!root || !updated || !updated.id) return;
    root.querySelectorAll('.status[data-id="' + CSS.escape(updated.id) + '"]').forEach((node) => {
      const wrap = document.createElement("div");
      wrap.innerHTML = statusHtml(updated, { root: node.classList.contains("is-thread-root") });
      const next = wrap.firstElementChild;
      if (!next) return;
      paintTime(next, updated.created_at);
      node.replaceWith(next);
      if (window.NightDB) NightDB.hydrateMedia(next);
    });
  }

  function replaceStatusEverywhere(updated) {
    const s = unwrapStatus(updated);
    if (!s || !s.id) return;
    COLS.forEach((name) => {
      const tl = state.timelines[name];
      if (!tl) return;
      tl.items = patchStatusInList(tl.items, s);
      replaceStatusNode($(name + "-body"), s);
    });
    if (state.threadById.has(s.id)) {
      state.threadById.set(s.id, s);
      replaceStatusNode($("thread-body"), s);
    }
    const overlay = $("overlay-body");
    if (overlay) replaceStatusNode(overlay, s);
    if (window.NightDB) NightDB.saveStatus(s);
  }

  function removeStatusEverywhere(id) {
    if (!id) return;
    COLS.forEach((name) => {
      const tl = state.timelines[name];
      if (!tl) return;
      tl.items = tl.items.filter((it) => {
        if (!it) return false;
        if (it.id === id) return false;
        if (it.reblog && it.reblog.id === id) return false;
        if (it.status && it.status.id === id) return false;
        return true;
      });
      const el = $(name + "-body");
      if (!el) return;
      el.querySelectorAll('.status[data-id="' + CSS.escape(id) + '"]').forEach((node) => {
        const notice = node.closest(".notice");
        (notice || node).remove();
      });
    });
    if (state.threadRootId === id) closeThread();
    else if (state.threadById.has(id)) {
      state.threadById.delete(id);
      const body = $("thread-body");
      if (body) {
        body.querySelectorAll('.status[data-id="' + CSS.escape(id) + '"]').forEach((node) => {
          const branch = node.closest(".thread-branch");
          (branch || node).remove();
        });
      }
    }
    const overlay = $("overlay-body");
    if (overlay) {
      overlay.querySelectorAll('.status[data-id="' + CSS.escape(id) + '"]').forEach((node) => node.remove());
    }
    if (window.NightDB && NightDB.removeStatus) NightDB.removeStatus(id);
  }

  async function openEditStatus(id) {
    let status = findLocalStatus(id);
    try {
      if (!status) status = unwrapStatus(await api("/api/v1/statuses/" + encodeURIComponent(id)));
      else status = unwrapStatus(status);
      if (!status || !state.me || status.account.id !== state.me.id) {
        throw new Error(t("errors.editOwnOnly"));
      }
      let text = "";
      let spoiler = status.spoiler_text || "";
      try {
        const src = await api("/api/v1/statuses/" + encodeURIComponent(id) + "/source");
        text = src && src.text != null ? String(src.text) : htmlToPlain(status.content);
        if (src && src.spoiler_text != null) spoiler = String(src.spoiler_text);
      } catch {
        text = htmlToPlain(status.content);
      }
      resetCompose();
      state.editingStatusId = id;
      state.editingMediaIds = (status.media_attachments || []).map((m) => m.id).filter(Boolean);
      $("compose-text").value = text;
      $("compose-spoiler").value = spoiler;
      if (status.visibility && $("compose-vis")) $("compose-vis").value = status.visibility;
      paintComposeMode();
      paintComposeCount();
      if (!$("compose-dialog").open) $("compose-dialog").showModal();
      $("compose-text").focus();
    } catch (err) {
      alert(err.message);
    }
  }

  function restoreQueuedDelete(status) {
    const s = unwrapStatus(status);
    if (!s || !s.id) return;
    if (window.NightDB) NightDB.saveStatus(s);
    const home = state.timelines.home;
    if (!home) return;
    const exists = home.items.some((it) => it && (it.id === s.id || (it.reblog && it.reblog.id === s.id)));
    if (exists) return;
    home.items = [s].concat(home.items);
    const el = $("home-body");
    if (!el) return;
    if (el.querySelector('.status[data-id="' + CSS.escape(s.id) + '"]')) return;
    const node = paintTimelineItem("home", s);
    if (!node) return;
    const placeholder = el.querySelector(":scope > .empty, :scope > .error");
    if (placeholder) placeholder.remove();
    el.insertBefore(node, el.firstChild);
    hydrateNodes([node]);
  }

  async function deleteOwnStatus(id) {
    const choice = await askConfirm({
      title: t("confirm.deletePostTitle"),
      message: t("confirm.deletePostMessage"),
      noLabel: t("common.cancel"),
      yesLabel: t("common.delete"),
    });
    if (choice !== true) return;
    const result = await publishDelete(id);
    removeStatusEverywhere(id);
    if (result && result.queued) openOutbox();
  }

  function tagNameFromHref(href) {
    return Core.tagNameFromHref ? Core.tagNameFromHref(href, location.href) : "";
  }

  function mentionAcctFromHref(href) {
    return Core.mentionAcctFromHref
      ? Core.mentionAcctFromHref(href, location.href, instanceHost(INSTANCE))
      : "";
  }

  async function openMention(acct) {
    const who = String(acct || "").replace(/^@/, "").trim();
    if (!who) return;
    try {
      const acc = await api("/api/v1/accounts/lookup?acct=" + encodeURIComponent(who));
      if (acc && acc.id) {
        await openProfile(acc.id);
        return;
      }
    } catch { /* try search */ }
    try {
      const res = await api("/api/v2/search?q=" + encodeURIComponent("@" + who) + "&type=accounts&resolve=true");
      const hit = res && res.accounts && res.accounts[0];
      if (hit && hit.id) await openProfile(hit.id);
    } catch (err) {
      alert(err.message);
    }
  }

  async function openHashtag(name) {
    const tag = String(name || "").replace(/^#/, "").trim();
    if (!tag) return;
    state.profileView = null;
    state.tagView = { name: tag, maxId: null, loading: false, done: false, items: [] };
    $("overlay-title").textContent = "#" + tag;
    $("overlay-body").innerHTML = "<div id='tag-statuses'><p class='hint'>" + escapeHtml(t("search.tagLoading")) + "</p></div>";
    const dlg = $("overlay-dialog");
    if (!dlg.open) dlg.showModal();
    await loadHashtagPage(true);
  }

  async function loadHashtagPage(reset) {
    const tv = state.tagView;
    if (!tv || (tv.loading && !reset) || (tv.done && !reset)) return;
    tv.loading = true;
    if (reset) {
      tv.items = [];
      tv.maxId = null;
      tv.done = false;
    }
    try {
      let path = "/api/v1/timelines/tag/" + encodeURIComponent(tv.name) + "?limit=30";
      if (tv.maxId) path += "&max_id=" + encodeURIComponent(tv.maxId);
      const batch = await api(path);
      if (!state.tagView || state.tagView.name !== tv.name) return;
      const el = $("tag-statuses");
      if (!Array.isArray(batch) || !batch.length) {
        tv.done = true;
        if (el && !tv.items.length) el.innerHTML = "<p class='empty'>" + escapeHtml(t("search.tagEmpty")) + "</p>";
        return;
      }
      const incremental = tv.items.length > 0 && !reset;
      tv.items = tv.items.concat(batch);
      tv.maxId = batch[batch.length - 1].id;
      if (!el) return;
      if (incremental) {
        batch.forEach((s) => {
          const wrap = document.createElement("div");
          wrap.innerHTML = statusHtml(s);
          const node = wrap.firstElementChild;
          if (!node) return;
          paintTime(node, (s.reblog || s).created_at);
          el.appendChild(node);
          if (window.NightDB) NightDB.hydrateMedia(node);
        });
      } else {
        renderStatusList(el, tv.items, t("search.tagEmpty"));
      }
      if (window.NightDB) cacheTimelineItems(batch);
    } catch (err) {
      const el = $("tag-statuses");
      if (el && !tv.items.length) el.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
    } finally {
      if (state.tagView === tv) tv.loading = false;
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
    if (type === "video" || type === "gifv") return t("media.video");
    if (type === "audio") return t("media.audio");
    return t("media.image");
  }

  function isSafeMediaUrl(url) {
    try {
      const u = new URL(url, location.href);
      return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "blob:";
    } catch {
      return false;
    }
  }

  async function downloadMedia(url, filename) {
    if (!url || !isSafeMediaUrl(url)) return;
    let href = url;
    let revoke = "";
    try {
      const local = window.NightDB ? await NightDB.mediaSrc(url) : "";
      if (local && local.indexOf("blob:") === 0) {
        href = local;
      } else {
        const res = await fetch(url);
        if (!res.ok) throw new Error(t("media.downloadFailed"));
        const blob = await res.blob();
        href = URL.createObjectURL(blob);
        revoke = href;
      }
    } catch {
      if (isSafeMediaUrl(url)) window.open(url, "_blank", "noopener");
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
    const cap = $("media-alt");
    if (cap) {
      cap.hidden = true;
      cap.textContent = "";
    }
  }

  function closeMedia() {
    const dlg = $("media-dialog");
    if (dlg && dlg.open) dlg.close();
    else stopMediaPlayback();
  }

  function openMediaFromEl(el) {
    const url = el.getAttribute("data-media-url") || "";
    if (!url || !isSafeMediaUrl(url)) return;
    const type = el.getAttribute("data-media-type") || "image";
    const alt = el.getAttribute("data-media-alt") || "";
    const previewRaw = el.getAttribute("data-media-preview") || "";
    const preview = isSafeMediaUrl(previewRaw) ? previewRaw : "";
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
    const cap = $("media-alt");
    if (cap) {
      if (alt) {
        cap.hidden = false;
        cap.textContent = alt;
      } else {
        cap.hidden = true;
        cap.textContent = "";
      }
    }
    const dlg = $("media-dialog");
    if (!dlg.open) dlg.showModal();
    if (window.NightDB) NightDB.hydrateMedia(stage);
  }

  document.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-act]");
    if (btn) {
      const article = btn.closest(".status");
      const act = btn.getAttribute("data-act");
      if (!article) return;
      if (act === "cw") {
        const content = article.querySelector(".content");
        const nextHidden = !content.hidden;
        content.hidden = nextHidden;
        article.querySelectorAll(".poll").forEach((el) => {
          el.hidden = nextHidden;
        });
        btn.textContent = nextHidden ? t("timeline.cwShow") : t("timeline.cwHide");
        return;
      }
      if (act === "open") {
        openProfile(article.getAttribute("data-acct"));
        return;
      }
      if (act === "poll-toggle") {
        if (btn.disabled) return;
        const on = !btn.classList.contains("is-selected");
        btn.classList.toggle("is-selected", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
        const pollEl = btn.closest(".poll");
        const submit = pollEl && pollEl.querySelector('[data-act="poll-submit"]');
        if (submit) {
          const n = pollEl.querySelectorAll(".poll-option.is-selected").length;
          submit.disabled = n === 0;
        }
        return;
      }
      if (act === "poll-vote" || act === "poll-submit") {
        submitPollVote(article, btn, act);
        return;
      }
      if (act === "translate") {
        ev.preventDefault();
        ev.stopPropagation();
        handleTranslateClick(article, btn);
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
    const mediaAlt = ev.target.closest(".media-alt");
    if (mediaAlt) {
      const thumb = mediaAlt.closest(".media-cell") && mediaAlt.closest(".media-cell").querySelector("[data-media-open]");
      if (thumb) {
        openMediaFromEl(thumb);
        return;
      }
    }
    const acctOpen = ev.target.closest("[data-acct-open]");
    if (acctOpen) {
      openProfile(acctOpen.getAttribute("data-acct-open"));
      return;
    }
    const tagOpen = ev.target.closest("[data-tag-open]");
    if (tagOpen) {
      openHashtag(tagOpen.getAttribute("data-tag-open"));
      return;
    }
    const tagLink = ev.target.closest("a[href]");
    if (tagLink) {
      const href = tagLink.getAttribute("href");
      const tag = tagNameFromHref(href);
      if (tag) {
        ev.preventDefault();
        openHashtag(tag);
        return;
      }
      const mention = mentionAcctFromHref(href);
      if (mention && (tagLink.classList.contains("mention") || /\/@|\/users\//i.test(href || ""))) {
        ev.preventDefault();
        openMention(mention);
        return;
      }
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
    const attachRm = ev.target.closest("[data-attach-rm]");
    if (attachRm) {
      const parts = String(attachRm.getAttribute("data-attach-rm") || "").split(":");
      removeAttach(parts[0], Number(parts[1]));
      return;
    }
    const draftOpen = ev.target.closest("[data-draft-open]");
    if (draftOpen) {
      loadDraft(draftOpen.getAttribute("data-draft-open"));
      return;
    }
    const draftDel = ev.target.closest("[data-draft-del]");
    if (draftDel) {
      const id = draftDel.getAttribute("data-draft-del");
      if (id && window.NightDB) {
        NightDB.removeDraft(id).then(() => {
          refreshDraftsBadge();
          openDrafts();
        });
      }
      return;
    }
    const save = ev.target.closest("[data-outbox-save]");
    if (save) {
      const id = save.getAttribute("data-outbox-save");
      const item = save.closest(".outbox-item");
      const ta = item && item.querySelector(".outbox-edit");
      if (id && ta && window.NightDB) {
        NightDB.getOutbox(id).then((doc) => {
          if (!doc || doc.action === "delete") return;
          const payload = Object.assign({}, doc.payload, { status: ta.value });
          return NightDB.updateOutbox(id, { payload, error: null });
        }).then(() => openOutbox());
      }
      return;
    }
    const del = ev.target.closest("[data-outbox-del]");
    if (del) {
      const id = del.getAttribute("data-outbox-del");
      if (id && window.NightDB) {
        NightDB.getOutbox(id).then(async (doc) => {
          await NightDB.removeOutbox(id);
          if (doc && doc.action === "delete" && doc.context && doc.context.status) {
            restoreQueuedDelete(doc.context.status);
          }
          await refreshOutboxBadge();
          openOutbox();
        });
      }
    }
  });

  function followLabel(rel) {
    if (rel.requested) return t("profile.requested");
    if (rel.following) return t("profile.unfollow");
    return t("profile.follow");
  }

  function muteLabel(rel) {
    return rel.muting ? t("profile.unmute") : t("profile.mute");
  }

  function blockLabel(rel) {
    return rel.blocking ? t("profile.unblock") : t("profile.block");
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
          const next = await api("/api/v1/accounts/" + encodeURIComponent(id) + "/" + pathOf(), { method: "POST" });
          Object.assign(rel, next);
        } catch (err) {
          alert(err.message);
        }
        paintRelButtons(rel);
      });
    });
  }

  async function loadProfileStatuses(reset) {
    const pv = state.profileView;
    if (!pv || (pv.loading && !reset) || (pv.done && !reset)) return;
    pv.loading = true;
    if (reset) {
      pv.items = [];
      pv.maxId = null;
      pv.done = false;
    }
    try {
      let path = "/api/v1/accounts/" + encodeURIComponent(pv.id) + "/statuses?limit=20";
      if (pv.maxId) path += "&max_id=" + encodeURIComponent(pv.maxId);
      const batch = await api(path);
      if (!state.profileView || state.profileView.id !== pv.id) return;
      const el = $("profile-statuses");
      if (!Array.isArray(batch) || !batch.length) {
        pv.done = true;
        if (el && !pv.items.length) el.innerHTML = "<p class='empty'>" + escapeHtml(t("timeline.noPosts")) + "</p>";
        return;
      }
      const incremental = pv.items.length > 0 && !reset;
      pv.items = pv.items.concat(batch);
      pv.maxId = batch[batch.length - 1].id;
      if (!el) return;
      if (incremental) {
        batch.forEach((s) => {
          const wrap = document.createElement("div");
          wrap.innerHTML = statusHtml(s);
          const node = wrap.firstElementChild;
          if (!node) return;
          paintTime(node, (s.reblog || s).created_at);
          el.appendChild(node);
          if (window.NightDB) NightDB.hydrateMedia(node);
        });
      } else {
        renderStatusList(el, pv.items, t("timeline.noPosts"));
      }
      if (window.NightDB) cacheTimelineItems(batch);
    } catch (err) {
      const el = $("profile-statuses");
      if (el && !pv.items.length) el.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
    } finally {
      if (state.profileView === pv) pv.loading = false;
    }
  }

  async function openProfile(id) {
    if (!id) return;
    state.tagView = null;
    state.profileView = { id, maxId: null, loading: false, done: false, items: [] };
    const dlg = $("overlay-dialog");
    $("overlay-title").textContent = t("profile.title");
    $("overlay-body").innerHTML = "<p class='hint'>" + escapeHtml(t("profile.loading")) + "</p>";
    dlg.showModal();
    try {
      const acc = await api("/api/v1/accounts/" + encodeURIComponent(id));
      const rels = await api("/api/v1/accounts/relationships?id[]=" + encodeURIComponent(id)).catch(() => []);
      const rel = (rels && rels[0]) || {};
      const isSelf = Boolean(state.me && state.me.id === acc.id);
      $("overlay-title").textContent = acc.display_name || acc.username;
      $("overlay-body").innerHTML = `
        <div class="profile-head">
          <img alt="" src="${escapeHtml(acc.avatar)}" />
          <div>
            <div class="display">${escapeHtml(acc.display_name || acc.username)}</div>
            <div class="acct">@${escapeHtml(acc.acct)}</div>
            ${isSelf ? `<div class="profile-actions">
              <p class="hint">${escapeHtml(t("profile.itsYou"))}</p>
              <button type="button" class="danger" id="profile-logout">${escapeHtml(t("profile.logout"))}</button>
            </div>` : `<div class="profile-actions">
              <button type="button" class="primary" id="follow-btn">${escapeHtml(t("profile.follow"))}</button>
              <button type="button" id="mute-btn">${escapeHtml(t("profile.mute"))}</button>
              <button type="button" class="danger" id="block-btn">${escapeHtml(t("profile.block"))}</button>
            </div>`}
            ${!isSelf && rel.blocked_by ? `<p class="hint">${escapeHtml(t("profile.blockedYou"))}</p>` : ""}
          </div>
        </div>
        <div class="profile-note">${sanitize(acc.note || "")}</div>
        <div class="profile-stats">
          <div><strong>${acc.statuses_count}</strong>${escapeHtml(t("profile.statPosts"))}</div>
          <div><strong>${acc.following_count}</strong>${escapeHtml(t("profile.statFollowing"))}</div>
          <div><strong>${acc.followers_count}</strong>${escapeHtml(t("profile.statFollowers"))}</div>
        </div>
        <div id="profile-statuses"><p class="hint">${escapeHtml(t("profile.loadingPosts"))}</p></div>`;
      await loadProfileStatuses(true);
      if (isSelf) {
        const lo = $("profile-logout");
        if (lo) {
          lo.addEventListener("click", () => {
            $("overlay-dialog").close();
            logout();
          });
        }
      } else {
        paintRelButtons(rel);
        bindProfileActions(id, rel);
      }
    } catch (err) {
      $("overlay-body").innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
    }
  }

  async function runSearch() {
    const qEl = $("search-q");
    const box = $("search-results");
    if (!qEl || !box) return;
    const q = qEl.value.trim();
    if (!q) return;
    box.innerHTML = "<p class='hint'>" + escapeHtml(t("search.loading")) + "</p>";
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
        .map((t) => {
          const name = t.name || t;
          return `<div class="search-hit" data-tag-open="${escapeHtml(name)}" role="button" tabindex="0">#${escapeHtml(name)}</div>`;
        })
        .join("");
      box.innerHTML =
        (accounts ? "<h3>" + escapeHtml(t("search.accounts")) + "</h3>" + accounts : "") +
        (tags ? "<h3>" + escapeHtml(t("search.tags")) + "</h3>" + tags : "") +
        (statuses ? "<h3>" + escapeHtml(t("search.posts")) + "</h3>" + statuses : "") ||
        "<p class='empty'>" + escapeHtml(t("search.empty")) + "</p>";
    } catch (err) {
      box.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
    }
  }

  function openSearch() {
    state.tagView = null;
    state.profileView = null;
    $("overlay-title").textContent = t("search.title");
    $("overlay-body").innerHTML = `
      <div class="search-box">
        <input id="search-q" type="search" placeholder="${escapeHtml(t("search.placeholder"))}" />
        <button type="button" class="primary" id="search-go">${escapeHtml(t("search.go"))}</button>
      </div>
      <div id="search-results"></div>`;
    $("overlay-dialog").showModal();
    $("search-q").focus();
  }

  $("compose-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const status = $("compose-text").value.trim();
    if (state.editingStatusId) {
      if (!status && !state.editingMediaIds.length) {
        $("compose-status").textContent = t("compose.missingTextOrAttach");
        return;
      }
      $("compose-status").textContent = t("compose.saving");
      try {
        const payload = {
          status: status || "",
          spoiler_text: $("compose-spoiler").value.trim() || "",
        };
        if (state.editingMediaIds.length) payload.media_ids = state.editingMediaIds;
        const result = await publishEdit(state.editingStatusId, payload);
        if (result && result.queued) {
          resetCompose();
          $("compose-dialog").close();
          openOutbox();
        } else {
          replaceStatusEverywhere(unwrapStatus(result));
          resetCompose();
          $("compose-dialog").close();
        }
      } catch (err) {
        $("compose-status").textContent = err.message;
      }
      return;
    }
    if (!status && !state.composeAttach.length) {
      $("compose-status").textContent = t("compose.missingTextOrAttach");
      return;
    }
    if (state.composeAttach.length && attachAltMissing(state.composeAttach)) {
      const sendAnyway = await askMissingAlt();
      if (!sendAnyway) {
        const empty = document.querySelector("#compose-attach-list [data-attach-alt]");
        const missing = [...document.querySelectorAll("#compose-attach-list [data-attach-alt]")]
          .find((ta) => !ta.value.trim());
        (missing || empty || $("compose-text")).focus();
        return;
      }
    }
    $("compose-status").textContent = t("compose.sending");
    try {
      const payload = {
        status: status || "",
        visibility: $("compose-vis").value,
        spoiler_text: $("compose-spoiler").value.trim() || undefined,
      };
      if (state.replyTo) payload.in_reply_to_id = state.replyTo.id;
      const result = await publishStatus(payload, state.replyTo ? { status: statusSnapshot(state.replyTo) } : null, state.composeAttach);
      if (state.editingDraftId && window.NightDB) await NightDB.removeDraft(state.editingDraftId);
      resetCompose();
      $("compose-dialog").close();
      await refreshDraftsBadge();
      if (result && result.queued) {
        openOutbox();
      } else {
        await Promise.all([
          loadTimeline("home", true),
          loadTimeline("local", true),
          loadTimeline("federated", true),
        ]);
        ensurePostedOnTimelines(result);
      }
    } catch (err) {
      $("compose-status").textContent = err.message;
    }
  });

  $("compose-text").addEventListener("input", () => {
    paintComposeCount();
  });

  function bootApp() {
    loadSeenState();
    setLoggedIn(true);
    refreshInstanceConfig();
    applyMaxChars(state.maxChars);
    loadTimeline("home", true);
    loadTimeline("local", true);
    loadTimeline("federated", true);
    loadTimeline("notifications", true);
    if (state.carrierWanted) startLiveUpdates();
    refreshOutboxBadge();
    refreshDraftsBadge();
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
  $("btn-token").addEventListener("click", () => exchangeCode($("oauth-code").value, true));
  const notifFilter = $("notif-filter");
  if (notifFilter) {
    notifFilter.addEventListener("change", () => {
      state.notifFilter = notifFilter.value || "all";
      loadTimeline("notifications", true);
    });
  }
  const notifClear = $("notif-clear");
  if (notifClear) {
    notifClear.addEventListener("click", async () => {
      try {
        await api("/api/v1/notifications/clear", { method: "POST" });
        state.timelines.notifications.items = [];
        markTimelineRead("notifications");
        loadTimeline("notifications", true);
      } catch (err) {
        alert(err.message);
      }
    });
  }
  $("btn-login").addEventListener("click", () => {
    setLoggedIn(false);
    $("login-panel").hidden = false;
  });
  $("btn-carrier").addEventListener("click", () => toggleCarrier());
  $("btn-compose").addEventListener("click", () => {
    resetCompose();
    $("compose-dialog").showModal();
  });
  $("compose-close").addEventListener("click", () => {
    requestCloseCompose();
  });
  $("compose-dialog").addEventListener("cancel", (ev) => {
    ev.preventDefault();
    requestCloseCompose();
  });
  $("compose-attach").addEventListener("click", () => $("compose-file").click());
  $("compose-file").addEventListener("change", (ev) => {
    addAttachFiles("compose", ev.target.files);
    ev.target.value = "";
  });
  document.addEventListener("input", (ev) => {
    const ta = ev.target && ev.target.closest && ev.target.closest("[data-attach-alt]");
    if (!ta) return;
    const parts = String(ta.getAttribute("data-attach-alt") || "").split(":");
    const list = parts[0] === "thread" ? state.threadAttach : state.composeAttach;
    const item = list[Number(parts[1])];
    if (item) item.alt = ta.value;
  });
  $("compose-draft").addEventListener("click", () => saveCurrentDraft());
  $("btn-drafts").addEventListener("click", () => openDrafts());
  $("drafts-close").addEventListener("click", () => $("drafts-dialog").close());
  $("thread-attach").addEventListener("click", () => $("thread-file").click());
  $("thread-file").addEventListener("change", (ev) => {
    addAttachFiles("thread", ev.target.files);
    ev.target.value = "";
  });
  $("btn-search").addEventListener("click", openSearch);
  $("overlay-body").addEventListener("click", (ev) => {
    if (ev.target.closest("#search-go")) runSearch();
  });
  $("overlay-body").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && ev.target && ev.target.id === "search-q") {
      ev.preventDefault();
      runSearch();
    }
    const tagHit = ev.target && ev.target.closest && ev.target.closest("[data-tag-open]");
    if (tagHit && (ev.key === "Enter" || ev.key === " ")) {
      ev.preventDefault();
      openHashtag(tagHit.getAttribute("data-tag-open"));
    }
  });
  $("btn-profile").addEventListener("click", () => state.me && openProfile(state.me.id));
  $("overlay-close").addEventListener("click", () => $("overlay-dialog").close());
  $("overlay-dialog").addEventListener("close", () => {
    state.tagView = null;
    state.profileView = null;
  });
  $("overlay-body").addEventListener("scroll", () => {
    const el = $("overlay-body");
    if (!el) return;
    if (el.scrollTop + el.clientHeight <= el.scrollHeight - 200) return;
    if (state.tagView && !state.tagView.loading && !state.tagView.done) loadHashtagPage(false);
    if (state.profileView && !state.profileView.loading && !state.profileView.done) loadProfileStatuses(false);
  });
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
    paintThreadReplyCount();
  });
  $("thread-reply-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const raw = $("thread-reply-text").value.trim();
    if ((!raw && !state.threadAttach.length) || !state.threadReplyTo) return;
    if (state.threadAttach.length && attachAltMissing(state.threadAttach)) {
      const sendAnyway = await askMissingAlt();
      if (!sendAnyway) {
        const missing = [...document.querySelectorAll("#thread-attach-list [data-attach-alt]")]
          .find((ta) => !ta.value.trim());
        (missing || $("thread-reply-text")).focus();
        return;
      }
    }
    const text = raw ? ensureReplyMentions(raw, state.threadReplyTo) : ensureReplyMentions("", state.threadReplyTo);
    $("thread-reply-status").textContent = t("compose.sending");
    try {
      const payload = {
        status: text,
        in_reply_to_id: state.threadReplyTo.id,
        visibility: state.threadReplyTo.visibility || "public",
      };
      const result = await publishStatus(payload, { status: statusSnapshot(state.threadReplyTo) }, state.threadAttach);
      const rootId = state.threadRootId;
      hideReplyComposer();
      if (result && result.queued) {
        $("thread-dialog").close();
        openOutbox();
      } else {
        await openThread(rootId);
        await Promise.all([
          loadTimeline("home", true),
          loadTimeline("local", true),
          loadTimeline("federated", true),
        ]);
        ensurePostedOnTimelines(result);
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
  bindColumnScroll("federated");
  bindColumnScroll("notifications");

  function startSwUpdates() {
    if (!("serviceWorker" in navigator)) return;
    let reloading = false;
    let wantReload = false;
    let playing = false;
    let sequenceDone = false;
    let controllerReady = false;

    function canReload() {
      try {
        return !composeDraftPending() && !threadDraftPending();
      } catch {
        return true;
      }
    }

    function reloadNow() {
      if (reloading) return;
      reloading = true;
      location.reload();
    }

    function requestReload() {
      if (canReload()) reloadNow();
      else wantReload = true;
    }

    function maybeReload() {
      if (!sequenceDone) return;
      if (controllerReady || !navigator.serviceWorker.controller) requestReload();
    }

    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        controllerReady = true;
        maybeReload();
      });
    }

    const tryIdleReload = () => {
      if (wantReload && canReload()) reloadNow();
    };
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) tryIdleReload();
    });
    setInterval(tryIdleReload, 4000);

    function reduceMotion() {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, reduceMotion() ? Math.min(ms, 50) : ms));
    }

    function setUpdateBar(pct) {
      const fill = $("sw-update-fill");
      if (fill) fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
    }

    async function typeLine(log, text, cls) {
      const line = document.createElement("div");
      if (cls) line.className = cls;
      log.appendChild(line);
      let cursor = log.querySelector(".sw-update-cursor");
      if (!cursor) {
        cursor = document.createElement("span");
        cursor.className = "sw-update-cursor";
        cursor.setAttribute("aria-hidden", "true");
      }
      if (reduceMotion()) {
        line.textContent = text;
        line.appendChild(cursor);
        log.scrollTop = log.scrollHeight;
        return;
      }
      for (let i = 1; i <= text.length; i++) {
        line.textContent = text.slice(0, i);
        line.appendChild(cursor);
        log.scrollTop = log.scrollHeight;
        await sleep(18);
      }
    }

    async function playUpdateSequence() {
      const dlg = $("sw-update-dialog");
      const log = $("sw-update-log");
      if (!dlg || !log) return;
      log.textContent = "";
      setUpdateBar(6);
      if (!dlg.open) dlg.showModal();
      const steps = [
        { text: "SYNCHRONISING...", cls: "", bar: 18, wait: 420 },
        { text: "PLEASE STAND BY", cls: "", bar: 32, wait: 520 },
        { text: "SCANNING GRID NODE", cls: "", bar: 48, wait: 480 },
        { text: "UPDATE FOUND", cls: "is-found", bar: 64, wait: 560 },
        { text: "APPLYING PATCH", cls: "is-found", bar: 82, wait: 640 },
        { text: "REBOOTING TERMINAL", cls: "is-warn", bar: 100, wait: 420 },
      ];
      for (const step of steps) {
        await typeLine(log, step.text, step.cls);
        setUpdateBar(step.bar);
        await sleep(step.wait);
      }
      if (!canReload()) {
        await typeLine(log, "HOLD — BUFFER NOT EMPTY", "is-warn");
        setUpdateBar(100);
        wantReload = true;
        await typeLine(log, "DEFERRED — CONTINUE WRITING", "is-found");
        await sleep(420);
        // Modal blocks Compose/Reply — dismiss so the user can finish the draft.
        // Keep waiting in the background; activate/reload runs after canReload().
        if (dlg.open) dlg.close();
        try {
          if ($("compose-dialog") && $("compose-dialog").open && $("compose-text")) {
            $("compose-text").focus();
          } else if ($("thread-dialog") && $("thread-dialog").open && $("thread-reply-text")) {
            $("thread-reply-text").focus();
          }
        } catch { /* focus best-effort */ }
        while (!canReload()) await sleep(400);
      }
    }

    function activateWaiting(reg) {
      const w = (reg && (reg.waiting || reg.installing)) || null;
      if (w) w.postMessage({ type: "SKIP_WAITING" });
    }

    async function runUpdateShow(reg) {
      if (playing) return;
      playing = true;
      try {
        await playUpdateSequence();
        activateWaiting(reg);
        sequenceDone = true;
        maybeReload();
        setTimeout(requestReload, 1200);
      } catch {
        sequenceDone = true;
        activateWaiting(reg);
        requestReload();
      }
    }

    const watchReg = (reg) => {
      if (!reg) return;
      const ping = () => reg.update().catch(() => {});
      ping();
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) ping();
      });
      window.addEventListener("online", ping);
      setInterval(ping, 10 * 60 * 1000);

      if (!navigator.serviceWorker.controller) return;

      if (reg.waiting) runUpdateShow(reg);

      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) {
          runUpdateShow(reg);
          return;
        }
        sw.addEventListener("statechange", () => {
          if (sw.state === "installed" || sw.state === "activating" || sw.state === "activated") {
            runUpdateShow(reg);
          }
        });
      });
    };

    const dlg = $("sw-update-dialog");
    if (dlg) {
      dlg.addEventListener("cancel", (ev) => ev.preventDefault());
    }

    navigator.serviceWorker
      .getRegistration("./sw.js")
      .then((reg) => reg || navigator.serviceWorker.register("./sw.js"))
      .then(watchReg)
      .catch(() => {});
  }

  function bindLangSwitch() {
    document.querySelectorAll(".lang-switch [data-lang]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const code = btn.getAttribute("data-lang");
        if (!code || !I18n.setLocale) return;
        I18n.setLocale(code);
      });
    });
  }

  function repaintLocaleSensitive() {
    translateCache.clear();
    if (I18n.applyDom) I18n.applyDom();
    paintCarrierBtn();
    if (state.conn === "online") paintConn("is-connected", t("status.connected"));
    else if (state.conn === "carrier-lost") paintConn("is-carrier-lost", t("status.carrierLost"));
    else paintConn("is-offline", t("status.offline"));
    paintComposeMode();
    paintComposeCount();
    paintThreadReplyCount();
    refreshOutboxBadge();
    refreshDraftsBadge();
    // Re-render open column bodies so dynamic strings (CW, notifs) follow locale.
    COLS.forEach((name) => {
      const el = $(name + "-body");
      if (el && state.timelines[name] && state.timelines[name].items && state.timelines[name].items.length) {
        renderTimeline(name, el);
      }
    });
  }

  document.addEventListener("nb:locale", () => {
    repaintLocaleSensitive();
  });

  bindLangSwitch();

  startRelativeAgeTicker();

  startSwUpdates();

  (async () => {
    try {
      if (I18n.load) await I18n.load();
    } catch (err) {
      console.warn("i18n load failed", err);
    }
    const loc = I18n.detect ? I18n.detect() : "de";
    if (I18n.setLocale) I18n.setLocale(loc);
    else if (I18n.applyDom) I18n.applyDom();

    await initInstance();
    applyMaxChars(state.maxChars);
    startConnWatch();
    loadMeCached();
    loadSeenState();
    if (await consumeOAuthRedirect()) return;
    if (state.token) {
      setLoggedIn(true);
      refreshMe()
        .then(bootApp)
        .catch((err) => {
          if (isNetworkError(err) && state.me) {
            bootApp();
          } else {
            logout();
            $("login-status").textContent = t("login.sessionInvalid");
          }
        });
    } else {
      setLoggedIn(false);
    }
  })();
})();
