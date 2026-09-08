/* Nightboard '83 — local IndexedDB/PouchDB store
   Copyright (C) 2026 Ralf Wissing
   SPDX-License-Identifier: AGPL-3.0-or-later */
window.NightDB = (() => {
  const ready = typeof PouchDB === "function";
  const cache = ready ? new PouchDB("nightboard83-cache") : null;
  const media = ready ? new PouchDB("nightboard83-media") : null;
  const outbox = ready ? new PouchDB("nightboard83-outbox") : null;
  const drafts = ready ? new PouchDB("nightboard83-drafts") : null;
  const blobUrls = new Map();
  const BLOB_URL_MAX = 80;
  const MEDIA_MAX_BYTES = 64 * 1024 * 1024;
  const MEDIA_MAX_FILES = 400;
  const TIMELINE_KEEP = 120;
  let mediaQueue = Promise.resolve();
  let evictTimer = null;

  function mediaId(url) {
    return "m:" + encodeURIComponent(url);
  }

  async function putDoc(db, id, patch) {
    if (!db) return;
    let doc;
    try {
      doc = await db.get(id);
    } catch {
      doc = { _id: id };
    }
    Object.assign(doc, patch);
    try {
      await db.put(doc);
    } catch (err) {
      if (err && err.status === 409) {
        const again = await db.get(id);
        Object.assign(again, patch);
        await db.put(again);
      }
    }
  }

  function collectUrlEntries(item) {
    const out = [];
    const walk = (s) => {
      if (!s) return;
      const acc = s.account;
      if (acc) {
        const av = acc.avatar_static || acc.avatar;
        if (av) out.push({ url: av, kind: "avatar" });
      }
      (s.media_attachments || []).forEach((m) => {
        if (m.preview_url) out.push({ url: m.preview_url, kind: "preview" });
        else if (m.type === "image" && m.url) out.push({ url: m.url, kind: "preview" });
      });
    };
    if (item && item.type && item.account && item.status !== undefined) {
      walk({ account: item.account });
      walk(item.status);
      if (item.status && item.status.reblog) walk(item.status.reblog);
    } else {
      walk(item);
      if (item && item.reblog) walk(item.reblog);
    }
    return out.filter((e) => e && e.url);
  }

  async function saveTimeline(name, items) {
    if (!cache) return;
    const keep = (items || []).slice(0, TIMELINE_KEEP);
    const ids = keep.map((it) => it.id).filter(Boolean);
    await putDoc(cache, "index:" + name, { type: "index", ids });
    await Promise.all(
      keep.map((it) =>
        putDoc(cache, "item:" + name + ":" + it.id, { type: "item", timeline: name, data: it })
      )
    );
    try {
      const prefix = "item:" + name + ":";
      const res = await cache.allDocs({ startkey: prefix, endkey: prefix + "\ufff0", include_docs: true });
      const keepSet = new Set(ids.map((id) => prefix + id));
      await Promise.all(
        res.rows
          .filter((row) => row.doc && !keepSet.has(row.id))
          .map((row) => cache.remove(row.doc).catch(() => {}))
      );
    } catch {
      /* ignore */
    }
    scheduleEvict();
  }

  async function loadTimeline(name) {
    if (!cache) return [];
    try {
      const idx = await cache.get("index:" + name);
      const ids = idx.ids || [];
      const docs = await Promise.all(
        ids.map((id) => cache.get("item:" + name + ":" + id).catch(() => null))
      );
      return docs.map((d) => d && d.data).filter(Boolean);
    } catch {
      return [];
    }
  }

  async function saveStatus(status) {
    if (!cache || !status || !status.id) return;
    await putDoc(cache, "status:" + status.id, { type: "status", data: status });
  }

  async function loadStatus(id) {
    if (!cache || !id) return null;
    try {
      const doc = await cache.get("status:" + id);
      return doc.data || null;
    } catch {
      try {
        for (const name of ["home", "local", "federated"]) {
          const doc = await cache.get("item:" + name + ":" + id);
          if (doc && doc.data) return doc.data.reblog || doc.data;
        }
      } catch {
        /* ignore */
      }
      return null;
    }
  }

  async function removeStatus(id) {
    if (!cache || !id) return;
    const keys = ["status:" + id, "item:home:" + id, "item:local:" + id, "item:federated:" + id];
    for (const key of keys) {
      try {
        const doc = await cache.get(key);
        await cache.remove(doc);
      } catch {
        /* ignore */
      }
    }
    for (const name of ["home", "local", "federated", "notifications"]) {
      try {
        const idx = await cache.get("index:" + name);
        if (!idx || !Array.isArray(idx.ids)) continue;
        const next = idx.ids.filter((x) => x !== id);
        if (next.length !== idx.ids.length) {
          idx.ids = next;
          await cache.put(idx);
        }
      } catch {
        /* ignore */
      }
    }
    scheduleEvict();
  }

  async function allCachedStatuses() {
    if (!cache) return [];
    const res = await cache.allDocs({ include_docs: true });
    const out = [];
    res.rows.forEach((row) => {
      const doc = row.doc;
      if (!doc) return;
      if (doc.type === "status" && doc.data) out.push(doc.data.reblog || doc.data);
      if (doc.type === "item" && doc.data && !doc.data.type) out.push(doc.data.reblog || doc.data);
    });
    return out;
  }

  function mediaBytes(doc) {
    if (!doc) return 0;
    if (Number.isFinite(doc.bytes) && doc.bytes >= 0) return doc.bytes;
    const att = doc._attachments && doc._attachments.file;
    if (att && Number.isFinite(att.length) && att.length >= 0) return att.length;
    return 0;
  }

  function revokeCachedBlob(url) {
    if (!url || !blobUrls.has(url)) return;
    const prev = blobUrls.get(url);
    blobUrls.delete(url);
    if (prev && String(prev).indexOf("blob:") === 0) URL.revokeObjectURL(prev);
  }

  async function pinnedMediaMap() {
    const pinned = new Map();
    if (!cache) return pinned;
    try {
      const res = await cache.allDocs({ include_docs: true });
      res.rows.forEach((row) => {
        const doc = row.doc;
        if (!doc) return;
        let item = null;
        if (doc.type === "item" && doc.data) item = doc.data;
        else if (doc.type === "status" && doc.data) item = doc.data;
        if (!item) return;
        collectUrlEntries(item).forEach((e) => {
          if (!e.url) return;
          if (pinned.get(e.url) === "avatar") return;
          pinned.set(e.url, e.kind === "avatar" ? "avatar" : "preview");
        });
      });
    } catch {
      /* ignore */
    }
    return pinned;
  }

  async function evictMedia() {
    if (!media) return;
    let docs;
    try {
      const res = await media.allDocs({ include_docs: true });
      docs = res.rows.map((r) => r.doc).filter(Boolean);
    } catch {
      return;
    }
    let total = docs.reduce((sum, d) => sum + mediaBytes(d), 0);
    if (total <= MEDIA_MAX_BYTES && docs.length <= MEDIA_MAX_FILES) return;

    const pinned = await pinnedMediaMap();
    const unreferenced = [];
    const pinnedPreview = [];
    const pinnedAvatar = [];
    docs.forEach((doc) => {
      const url = doc.url || "";
      const pinKind = url ? pinned.get(url) : null;
      const kind = pinKind || doc.kind || "preview";
      const rec = { doc, url, kind, bytes: mediaBytes(doc), created: Number(doc.createdAt) || 0 };
      if (!pinKind) unreferenced.push(rec);
      else if (kind === "avatar") pinnedAvatar.push(rec);
      else pinnedPreview.push(rec);
    });
    const oldestFirst = (a, b) => a.created - b.created || String(a.url).localeCompare(String(b.url));
    unreferenced.sort(oldestFirst);
    pinnedPreview.sort(oldestFirst);
    pinnedAvatar.sort(oldestFirst);

    let files = docs.length;
    const victims = unreferenced.concat(pinnedPreview, pinnedAvatar);
    for (const rec of victims) {
      if (total <= MEDIA_MAX_BYTES && files <= MEDIA_MAX_FILES) break;
      try {
        await media.remove(rec.doc);
        total -= rec.bytes;
        files -= 1;
        revokeCachedBlob(rec.url);
      } catch {
        /* ignore */
      }
    }
  }

  function scheduleEvict() {
    if (evictTimer) clearTimeout(evictTimer);
    evictTimer = setTimeout(() => {
      evictTimer = null;
      mediaQueue = mediaQueue.then(() => evictMedia()).catch(() => {});
    }, 800);
  }

  function cacheMedia(url, kind) {
    if (!media || !url || !/^https?:/i.test(url)) return;
    mediaQueue = mediaQueue.then(async () => {
      const id = mediaId(url);
      try {
        await media.get(id);
        return;
      } catch {
        /* missing */
      }
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const blob = await res.blob();
        await media.put({
          _id: id,
          url,
          kind: kind === "avatar" ? "avatar" : "preview",
          bytes: blob.size || 0,
          createdAt: Date.now(),
          _attachments: {
            file: { content_type: blob.type || "application/octet-stream", data: blob },
          },
        });
        scheduleEvict();
      } catch {
        /* ignore */
      }
    });
  }

  function cacheItemMedia(item) {
    collectUrlEntries(item).forEach((e) => cacheMedia(e.url, e.kind));
  }

  function rememberBlob(url, obj) {
    if (blobUrls.has(url)) blobUrls.delete(url);
    blobUrls.set(url, obj);
    while (blobUrls.size > BLOB_URL_MAX) {
      const oldest = blobUrls.keys().next().value;
      const prev = blobUrls.get(oldest);
      blobUrls.delete(oldest);
      if (prev && String(prev).indexOf("blob:") === 0) URL.revokeObjectURL(prev);
    }
  }

  async function mediaSrc(url) {
    if (!media || !url) return url;
    if (blobUrls.has(url)) {
      const hit = blobUrls.get(url);
      rememberBlob(url, hit);
      return hit;
    }
    try {
      const doc = await media.get(mediaId(url), { attachments: true, binary: true });
      const att = doc._attachments && doc._attachments.file;
      if (!att || !att.data) return url;
      const blob = att.data instanceof Blob ? att.data : new Blob([att.data], { type: att.content_type });
      const obj = URL.createObjectURL(blob);
      rememberBlob(url, obj);
      return obj;
    } catch {
      return url;
    }
  }

  async function hydrateMedia(root) {
    if (!root) return;
    const jobs = [];
    const swap = async (el, attr) => {
      const orig = el.getAttribute(attr);
      if (!orig || orig.indexOf("blob:") === 0) return;
      const local = await mediaSrc(orig);
      if (local !== orig) el.setAttribute(attr, local);
    };
    root.querySelectorAll("img[src]").forEach((el) => jobs.push(swap(el, "src")));
    root.querySelectorAll("video[src]").forEach((el) => jobs.push(swap(el, "src")));
    root.querySelectorAll("video[poster]").forEach((el) => jobs.push(swap(el, "poster")));
    await Promise.all(jobs);
  }

  function filesToAttachments(files) {
    const atts = {};
    const meta = [];
    (files || []).forEach((item, i) => {
      const file = item.file || item.blob || item;
      if (!file) return;
      const key = "f" + i;
      const type = file.type || item.type || "application/octet-stream";
      const name = file.name || item.name || key;
      atts[key] = { content_type: type, data: file };
      meta.push({ key, name, type, alt: String(item.alt || "").trim() });
    });
    return { atts, meta };
  }

  function attachmentsToFiles(doc) {
    const atts = (doc && doc._attachments) || {};
    const meta = (doc && doc.filesMeta) || [];
    return Object.keys(atts)
      .sort()
      .map((key) => {
        const att = atts[key];
        const info = meta.find((m) => m.key === key) || {};
        const blob = att.data instanceof Blob ? att.data : new Blob([att.data], { type: att.content_type || info.type || "application/octet-stream" });
        const file = new File([blob], info.name || key, { type: blob.type });
        return { file, kind: (file.type.split("/")[0] || "file"), alt: info.alt || "" };
      });
  }

  async function enqueue(entry) {
    if (!outbox) throw new Error("Offline-Speicher nicht verfügbar");
    const id = "outbox:" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const files = entry.files || [];
    const packed = filesToAttachments(files);
    const doc = {
      _id: id,
      createdAt: Date.now(),
      error: null,
      action: entry.action === "edit" || entry.action === "delete" ? entry.action : "create",
      statusId: entry.statusId || null,
      payload: entry.payload || {},
      context: entry.context || null,
      filesMeta: packed.meta,
    };
    if (Object.keys(packed.atts).length) doc._attachments = packed.atts;
    await outbox.put(doc);
    return doc;
  }

  async function listOutbox() {
    if (!outbox) return [];
    const res = await outbox.allDocs({ include_docs: true });
    return res.rows
      .map((r) => r.doc)
      .filter((d) => d && (d.action === "delete" || d.payload))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async function getOutbox(id, withFiles) {
    if (!outbox) return null;
    try {
      return withFiles ? await outbox.get(id, { attachments: true, binary: true }) : await outbox.get(id);
    } catch {
      return null;
    }
  }

  async function updateOutbox(id, patch) {
    if (!outbox) return;
    const doc = await outbox.get(id);
    Object.assign(doc, patch);
    await outbox.put(doc);
  }

  async function removeOutbox(id) {
    if (!outbox) return;
    const doc = await outbox.get(id);
    await outbox.remove(doc);
  }

  async function saveDraft(entry, files) {
    if (!drafts) throw new Error("Offline-Speicher nicht verfügbar");
    const packed = filesToAttachments(files);
    const now = Date.now();
    const id = entry._id || "draft:" + now + "-" + Math.random().toString(36).slice(2, 8);
    let doc;
    try {
      doc = await drafts.get(id);
    } catch {
      doc = { _id: id, createdAt: now };
    }
    doc.updatedAt = now;
    doc.text = entry.text || "";
    doc.spoiler = entry.spoiler || "";
    doc.visibility = entry.visibility || "public";
    doc.in_reply_to_id = entry.in_reply_to_id || null;
    doc.filesMeta = packed.meta;
    if (Object.keys(packed.atts).length) doc._attachments = packed.atts;
    else delete doc._attachments;
    await drafts.put(doc);
    return doc;
  }

  async function listDrafts() {
    if (!drafts) return [];
    const res = await drafts.allDocs({ include_docs: true });
    return res.rows
      .map((r) => r.doc)
      .filter((d) => d && d._id && d._id.indexOf("draft:") === 0)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async function getDraft(id) {
    if (!drafts || !id) return null;
    try {
      return await drafts.get(id, { attachments: true, binary: true });
    } catch {
      return null;
    }
  }

  async function removeDraft(id) {
    if (!drafts || !id) return;
    const doc = await drafts.get(id);
    await drafts.remove(doc);
  }

  return {
    ready,
    saveTimeline,
    loadTimeline,
    saveStatus,
    loadStatus,
    removeStatus,
    allCachedStatuses,
    cacheItemMedia,
    hydrateMedia,
    mediaSrc,
    enqueue,
    listOutbox,
    getOutbox,
    updateOutbox,
    removeOutbox,
    attachmentsToFiles,
    saveDraft,
    listDrafts,
    getDraft,
    removeDraft,
  };
})();
