// ==UserScript==
// @name         Wayfarer Map Mods - Batch Photo Uploader for Draft
// @version      0.1.0
// @description  Standalone simple draft photo uploader for Wayfarer Map Mod. Adds a plain panel link, previews/queues draft photos, retries failed uploads, and does not submit nominations.
// @author       TrungLatias
// @match        https://wayfarer.nianticlabs.com/*
// @run-at       document-idle
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/heic-to@1.3.0/dist/iife/heic-to.js
// ==/UserScript==

(function () {
  "use strict";

  const MAX_PHOTOS = 6;
  const MAX_SUPPORTING = 5;
  const MAX_UPLOAD_ATTEMPTS = 3;
  const LINK_TEXT = "Photo Upload";
  const state = { drafts: [], cards: new Map(), queue: [], running: false, userLoc: null };

  function $(selector, root = document) { return root.querySelector(selector); }
  function $all(selector, root = document) { return Array.from(root.querySelectorAll(selector)); }
  function txt(value, fallback = "") { const s = value == null ? "" : String(value); return s.trim() || fallback; }

  function getCookie(name) {
    const prefix = name + "=";
    return (document.cookie || "").split(";").map(p => p.trim()).find(p => p.startsWith(prefix))?.slice(prefix.length) || "";
  }

  function csrfToken() { return decodeURIComponent(getCookie("XSRF-TOKEN") || ""); }

  function getJson(url) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.withCredentials = true;
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) return reject(new Error("HTTP " + xhr.status + " for " + url));
        try { resolve(JSON.parse(xhr.responseText || "{}")); } catch (err) { reject(err); }
      };
      xhr.onerror = () => reject(new Error("Network error for " + url));
      xhr.send();
    });
  }

  function postJson(url, body) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader("Content-Type", "application/json;charset=UTF-8");
      const token = csrfToken();
      if (token) xhr.setRequestHeader("x-csrf-token", token);
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) return reject(new Error("HTTP " + xhr.status + ": " + (xhr.responseText || url)));
        try { resolve(JSON.parse(xhr.responseText || "{}")); } catch (err) { reject(err); }
      };
      xhr.onerror = () => reject(new Error("Network error for " + url));
      xhr.send(JSON.stringify(body == null ? {} : body));
    });
  }

  function slotName(index) {
    if (index === 0) return "main";
    const support = index - 1;
    return support === 0 ? "supporting" : "supporting" + support;
  }

  function photoRole(index) {
    if (index === 0) return "Main";
    if (index >= 1 && index < MAX_PHOTOS) return "Support " + index;
    return "Ignored";
  }

  function normArray(value) { return Array.isArray(value) ? value.filter(Boolean) : []; }

  function normalizeDraft(raw) {
    if (!raw) return null;
    const poi = raw.poi || raw;
    const images = raw.images || {};
    const id = raw.id || raw.remoteDraftId || poi.id;
    if (!id) return null;
    return {
      id,
      lat: Number(poi.lat ?? raw.lat),
      lng: Number(poi.lng ?? raw.lng),
      title: txt(poi.title ?? raw.title, "Untitled draft"),
      description: txt(poi.description ?? raw.description),
      supportingStatement: txt(poi.supportingStatement ?? raw.supportingStatement),
      lastModified: Number(raw.lastModified || raw.lastModifiedMs || 0),
      mainImageGcsPath: raw.mainImageGcsPath || images.main?.gcsPath || null,
      mainImageServingUrl: raw.mainImageServingUrl || images.main?.servingUrl || images.main?.url || null,
      supportingImageGcsPaths: normArray(raw.supportingImageGcsPaths || images.supporting?.map(x => x && x.gcsPath)),
      supportingImageServingUrls: normArray(raw.supportingImageServingUrls || images.supporting?.map(x => x && (x.servingUrl || x.url))),
      raw
    };
  }

  async function loadDrafts() {
    const all = [];
    let cursor = null;
    let guard = 0;
    do {
      let url = "/api/v1/vault/submit/get/drafts";
      if (cursor) url += "?cursor=" + encodeURIComponent(cursor);
      const resp = await getJson(url);
      if (!resp || resp.captcha) throw new Error("Draft list requires captcha/login. Open Wayfarer normally, then try again.");
      const result = resp.result || {};
      const items = Array.isArray(result.result) ? result.result : (Array.isArray(result) ? result : []);
      items.forEach(item => { const d = normalizeDraft(item); if (d) all.push(d); });
      const next = result.cursor || null;
      cursor = next && next !== cursor ? next : null;
      guard++;
    } while (cursor && guard < 50);
    all.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
    state.drafts = all;
    return all;
  }

  function snapshotDraft(draft) {
    return {
      mainImageGcsPath: draft.mainImageGcsPath || null,
      mainImageServingUrl: draft.mainImageServingUrl || null,
      supportingImageGcsPaths: draft.supportingImageGcsPaths.slice(0, MAX_SUPPORTING),
      supportingImageServingUrls: draft.supportingImageServingUrls.slice(0, MAX_SUPPORTING)
    };
  }

  async function requestUploadUrls(draftId, slots) {
    const resp = await postJson("/api/v1/vault/submit/draft/upload?draftId=" + encodeURIComponent(draftId), slots);
    if (!resp || resp.captcha) throw new Error("Upload URL request requires captcha/login.");
    return (resp.result && resp.result.imageUrlMap) || {};
  }

  async function putSigned(uploadUrl, blob) {
    const buf = await blob.arrayBuffer();
    const res = await fetch(uploadUrl, { method: "PUT", body: buf });
    if (!res.ok) throw new Error("Image PUT failed: HTTP " + res.status);
  }

  async function getUserLocation(draft) {
    if (state.userLoc) return state.userLoc;
    const fallback = { userLat: Number.isFinite(draft.lat) ? draft.lat : 0, userLng: Number.isFinite(draft.lng) ? draft.lng : 0 };
    if (!navigator.geolocation) return fallback;
    return new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        pos => { state.userLoc = { userLat: pos.coords.latitude, userLng: pos.coords.longitude }; resolve(state.userLoc); },
        () => resolve(fallback),
        { enableHighAccuracy: false, timeout: 3500, maximumAge: 300000 }
      );
    });
  }

  async function saveDraft(draft, imageFields) {
    const loc = await getUserLocation(draft);
    const url = "/api/v1/vault/submit/draft?userLat=" + encodeURIComponent(loc.userLat) + "&userLng=" + encodeURIComponent(loc.userLng);
    const payload = Object.assign({
      id: draft.id,
      lat: draft.lat,
      lng: draft.lng,
      title: draft.title || "",
      description: draft.description || "",
      supportingStatement: draft.supportingStatement || ""
    }, imageFields || {});
    const resp = await postJson(url, payload);
    if (!resp || resp.captcha) throw new Error("Draft save requires captcha/login.");
    const saved = resp.result && (resp.result.poiSubmissionDraft || resp.result.draft || resp.result);
    const norm = normalizeDraft(saved);
    if (!norm) throw new Error("Draft save did not return a valid draft.");
    return norm;
  }

  function isHeic(file) {
    const type = (file.type || "").toLowerCase();
    const name = (file.name || "").toLowerCase();
    return type === "image/heic" || type === "image/heif" || name.endsWith(".heic") || name.endsWith(".heif");
  }

  function canConvert(file) {
    const type = (file.type || "").toLowerCase();
    return isHeic(file) || type === "image/jpeg" || type === "image/jpg" || type === "image/png" || type === "image/webp";
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error("Could not read image."));
      r.readAsDataURL(blob);
    });
  }

  async function canvasToJpeg(file) {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    if (typeof bitmap.close === "function") bitmap.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) throw new Error("Image conversion failed.");
    return blob;
  }

  async function convertToJpeg(file) {
    if (!canConvert(file)) throw new Error("Unsupported image format: " + (file.name || file.type || "unknown"));
    const type = (file.type || "").toLowerCase();
    let blob;
    if (isHeic(file)) {
      const heicTo = window.HeicTo || window.heicTo;
      if (!heicTo) throw new Error("HEIC converter did not load.");
      blob = await heicTo({ blob: file, type: "image/jpeg", quality: 0.9 });
    } else if (type === "image/png" || type === "image/webp") {
      blob = await canvasToJpeg(file);
    } else {
      blob = file;
    }
    return { name: file.name || "photo.jpg", blob, dataUrl: await blobToDataUrl(blob) };
  }

  async function convertFiles(files, onProgress) {
    const out = [];
    for (let i = 0; i < files.length; i++) {
      if (onProgress) onProgress(i + 1, files.length, files[i].name || "photo");
      out.push(await convertToJpeg(files[i]));
    }
    return out;
  }

  function injectCss() {
    if (document.getElementById("wfpu-plugin-css")) return;
    const style = document.createElement("style");
    style.id = "wfpu-plugin-css";
    style.textContent = `
.wfpu-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:2147483599;display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box}.wfpu-dialog{width:720px;max-width:calc(100vw - 24px);max-height:90vh;overflow:auto;background:#fff;color:#111827;border-radius:8px;box-shadow:0 10px 25px rgba(0,0,0,.35);font-family:Roboto,Arial,sans-serif;font-size:12px;padding:12px;box-sizing:border-box}.wfpu-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}.wfpu-title{font-size:15px;font-weight:700}.wfpu-x{border:1px solid #d1d5db;background:#fff;border-radius:999px;width:26px;height:26px;cursor:pointer;font-weight:700}.wfpu-note{font-size:11px;color:#374151;margin-bottom:8px}.wfpu-toolbar,.wfpu-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:7px 0}.wfpu-btn{border:1px solid #d1d5db;border-radius:5px;background:#fff;color:#111827;cursor:pointer;font:inherit;padding:5px 9px}.wfpu-btn:hover:not(:disabled){background:#f3f4f6}.wfpu-btn:disabled{opacity:.55;cursor:not-allowed}.wfpu-primary{background:#fb4c21;border-color:#fb4c21;color:#fff}.wfpu-primary:hover:not(:disabled){background:#e0441d}.wfpu-search{flex:1 1 180px;min-width:0;border:1px solid #d1d5db;border-radius:5px;font:inherit;padding:6px 8px}.wfpu-status,.wfpu-meta,.wfpu-empty{font-size:11px;color:#6b7280}.wfpu-status.ok{color:#047857}.wfpu-status.err{color:#b91c1c}.wfpu-list{display:flex;flex-direction:column;gap:8px;max-height:48vh;overflow-y:auto;border:1px solid #e5e7eb;border-radius:6px;background:#f9fafb;padding:6px}.wfpu-card{border:1px solid #e5e7eb;border-radius:6px;background:#fff;padding:8px}.wfpu-card-title{font-weight:700;word-break:break-word}.wfpu-files{display:flex;flex-direction:column;gap:4px;margin-top:6px}.wfpu-file{display:grid;grid-template-columns:54px 76px minmax(0,1fr) auto;gap:6px;align-items:center;border:1px solid #e5e7eb;border-radius:5px;background:#f9fafb;padding:5px}.wfpu-thumb{width:54px;height:54px;border-radius:4px;object-fit:cover;background:#e5e7eb;border:1px solid #e5e7eb}.wfpu-role{font-weight:700;font-size:11px}.wfpu-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wfpu-queue{border-top:1px solid #e5e7eb;margin-top:10px;padding-top:8px}.wfpu-qrow{border:1px solid #e5e7eb;border-radius:5px;margin:5px 0;padding:6px}.wfpu-qhead{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;align-items:center}.wfpu-qx{border:1px solid #d1d5db;background:#fff;color:#111827;border-radius:4px;width:20px;height:20px;line-height:16px;padding:0;cursor:pointer;font-size:12px;font-weight:700}.wfpu-qx:disabled{opacity:.45;cursor:not-allowed}.wfpu-bar{height:6px;border-radius:999px;background:#e5e7eb;overflow:hidden;margin-top:4px}.wfpu-fill{height:100%;width:0%;background:#fb4c21;transition:width 160ms ease}
@media(max-width:620px){.wfpu-dialog{width:calc(100vw - 16px);max-height:94vh}.wfpu-toolbar,.wfpu-actions{align-items:stretch}.wfpu-toolbar .wfpu-btn,.wfpu-search{flex:1 1 100%}.wfpu-file{grid-template-columns:54px 68px minmax(0,1fr)}.wfpu-file .wfpu-btn{grid-column:1/-1}}
@media(prefers-color-scheme:dark){.wfpu-dialog,.wfpu-card{background:#111827;color:#f9fafb}.wfpu-x,.wfpu-btn,.wfpu-search,.wfpu-qx{background:#1f2937;color:#f9fafb;border-color:rgba(255,255,255,.18)}.wfpu-list,.wfpu-file,.wfpu-thumb{background:#0f172a;border-color:rgba(255,255,255,.14)}.wfpu-card,.wfpu-qrow{border-color:rgba(255,255,255,.14)}.wfpu-note,.wfpu-status,.wfpu-meta,.wfpu-empty{color:#9ca3af}.wfpu-primary{background:#fb4c21;border-color:#fb4c21}.wfpu-bar{background:#374151}}
`;
    document.head.appendChild(style);
  }

  function setCardStatus(card, message, cls) {
    if (!card.statusEl) return;
    card.statusEl.textContent = message || "";
    card.statusEl.className = "wfpu-status" + (cls ? " " + cls : "");
  }

  function renderSelected(card) {
    const el = card.filesEl;
    el.textContent = "";
    if (!card.photos.length) {
      const empty = document.createElement("div");
      empty.className = "wfpu-empty";
      empty.textContent = "No selected photos.";
      el.appendChild(empty);
      return;
    }
    card.photos.forEach((photo, i) => {
      const row = document.createElement("div");
      row.className = "wfpu-file";
      const thumb = document.createElement("img");
      thumb.className = "wfpu-thumb";
      thumb.alt = photoRole(i) + " preview";
      thumb.src = photo.dataUrl || "";
      const role = document.createElement("div");
      role.className = "wfpu-role";
      role.textContent = photoRole(i);
      const name = document.createElement("div");
      name.className = "wfpu-name";
      name.title = photo.name || "photo";
      name.textContent = photo.name + (i >= MAX_PHOTOS ? " (ignored, not uploaded)" : "");
      const del = document.createElement("button");
      del.type = "button";
      del.className = "wfpu-btn";
      del.textContent = "Delete";
      del.addEventListener("click", () => {
        const removed = card.photos.splice(i, 1)[0];
        if (removed) card.undoStack.push({ index: i, photo: removed });
        renderSelected(card);
      });
      row.append(thumb, role, name, del);
      el.appendChild(row);
    });
  }

  function setQueueStatus(entry, message, pct) {
    entry.status = message || entry.status || "Waiting";
    entry.progress = Math.max(0, Math.min(100, Number(pct) || 0));
    if (entry.statusEl) entry.statusEl.textContent = entry.status;
    if (entry.fillEl) entry.fillEl.style.width = entry.progress + "%";
    if (entry.cancelBtn) entry.cancelBtn.disabled = !!entry.done || !!entry.cancelled;
  }

  function throwIfCancelled(entry) {
    if (entry.cancelled) throw new Error("Cancelled");
  }

  async function uploadEntry(entry) {
    const card = entry.card;
    throwIfCancelled(entry);
    const draft = card.draft;
    const photos = card.photos.slice(0, MAX_PHOTOS);
    if (!photos.length) throw new Error("No photos selected.");
    card.lastSnapshot = snapshotDraft(draft);
    if (card.undoUploadBtn) card.undoUploadBtn.disabled = false;

    const slots = photos.map((_, i) => slotName(i));
    setQueueStatus(entry, "Requesting upload URLs", 15);
    const urlMap = await requestUploadUrls(draft.id, slots);
    throwIfCancelled(entry);
    const gcs = {};
    for (let i = 0; i < photos.length; i++) {
      const slot = slots[i];
      const info = urlMap[slot] || {};
      const uploadUrl = info.uploadUrl || info.url || info.signedUrl;
      if (!uploadUrl || !info.gcsPath) throw new Error("Missing upload URL for " + slot);
      throwIfCancelled(entry);
      setQueueStatus(entry, "Uploading " + (i + 1) + "/" + photos.length, 20 + Math.floor((i / photos.length) * 60));
      await putSigned(uploadUrl, photos[i].blob);
      throwIfCancelled(entry);
      gcs[slot] = info.gcsPath;
    }
    const supporting = [];
    for (let i = 1; i < photos.length; i++) {
      const slot = slotName(i);
      if (gcs[slot]) supporting.push(gcs[slot]);
    }
    setQueueStatus(entry, "Saving draft", 88);
    throwIfCancelled(entry);
    const saved = await saveDraft(draft, { mainImageGcsPath: gcs.main || null, supportingImageGcsPaths: supporting, supportingImageServingUrls: [] });
    throwIfCancelled(entry);
    card.draft = saved;
    const idx = state.drafts.findIndex(d => d.id === saved.id);
    if (idx >= 0) state.drafts[idx] = saved;
    setCardStatus(card, "Uploaded and saved", "ok");
    setQueueStatus(entry, "Done", 100);
  }

  async function undoUpload(card) {
    if (!card.lastSnapshot) return;
    setCardStatus(card, "Undoing upload…");
    const saved = await saveDraft(card.draft, card.lastSnapshot);
    card.draft = saved;
    card.lastSnapshot = null;
    if (card.undoUploadBtn) card.undoUploadBtn.disabled = true;
    setCardStatus(card, "Upload undone", "ok");
  }

  function addQueue(card, autoStart) {
    if (!card.photos.length) return setCardStatus(card, "Choose photos first", "err");
    const existing = state.queue.find(e => e.card === card && !e.done);
    if (!existing) state.queue.push({ card, title: card.draft.title, status: "Waiting", progress: 0, done: false, attempts: 0, cancelled: false });
    setCardStatus(card, "Queued");
    renderQueue();
    if (autoStart) runQueue();
  }

  function renderQueue() {
    const list = $("#wfpu-queue-list");
    if (!list) return;
    list.textContent = "";
    if (!state.queue.length) {
      const empty = document.createElement("div");
      empty.className = "wfpu-empty";
      empty.textContent = "Queue is empty.";
      list.appendChild(empty);
      return;
    }
    state.queue.forEach(entry => {
      const row = document.createElement("div");
      row.className = "wfpu-qrow";
      const head = document.createElement("div");
      head.className = "wfpu-qhead";
      const title = document.createElement("div");
      title.className = "wfpu-card-title";
      title.textContent = entry.title;
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "wfpu-qx";
      cancel.textContent = "×";
      cancel.title = "Cancel this submission";
      cancel.disabled = !!entry.done || !!entry.cancelled;
      cancel.addEventListener("click", () => {
        entry.cancelled = true;
        if (!state.running || entry.status === "Waiting") {
          state.queue = state.queue.filter(e => e !== entry);
          renderQueue();
        } else {
          setQueueStatus(entry, "Cancelling…", entry.progress || 0);
        }
        setCardStatus(entry.card, "Cancelled", "err");
      });
      head.append(title, cancel);
      const status = document.createElement("div");
      status.className = "wfpu-status";
      status.textContent = entry.status;
      const bar = document.createElement("div");
      bar.className = "wfpu-bar";
      const fill = document.createElement("div");
      fill.className = "wfpu-fill";
      fill.style.width = (entry.progress || 0) + "%";
      bar.appendChild(fill);
      row.append(head, status, bar);
      list.appendChild(row);
      entry.statusEl = status;
      entry.fillEl = fill;
      entry.cancelBtn = cancel;
    });
  }

  async function runQueue() {
    if (state.running) return;
    state.running = true;
    try {
      for (const entry of state.queue) {
        if (entry.done || entry.cancelled) continue;
        while (!entry.done && !entry.cancelled && entry.attempts < MAX_UPLOAD_ATTEMPTS) {
          try {
            entry.attempts++;
            setCardStatus(entry.card, entry.attempts > 1 ? "Retrying upload…" : "Uploading…");
            setQueueStatus(entry, entry.attempts > 1 ? "Retrying " + entry.attempts + "/" + MAX_UPLOAD_ATTEMPTS : "Starting", 5);
            await uploadEntry(entry);
            entry.done = true;
          } catch (err) {
            console.error("[WF Photo Upload]", err);
            if (entry.cancelled || err.message === "Cancelled") {
              entry.cancelled = true;
              setQueueStatus(entry, "Cancelled", entry.progress || 0);
              setCardStatus(entry.card, "Cancelled", "err");
              break;
            }
            if (entry.attempts < MAX_UPLOAD_ATTEMPTS) {
              setQueueStatus(entry, "Failed, will retry by default", entry.progress || 0);
              setCardStatus(entry.card, "Failed, will retry by default", "err");
              await new Promise(resolve => setTimeout(resolve, 900));
              continue;
            }
            setQueueStatus(entry, "Error after " + entry.attempts + " tries: " + err.message, entry.progress || 0);
            setCardStatus(entry.card, "Error after " + entry.attempts + " tries: " + err.message, "err");
            break;
          }
        }
      }
    } finally {
      state.running = false;
    }
  }

  function createCard(draft) {
    const card = { draft, photos: [], undoStack: [], lastSnapshot: null };
    const el = document.createElement("div");
    el.className = "wfpu-card";
    const title = document.createElement("div");
    title.className = "wfpu-card-title";
    title.textContent = draft.title;
    const meta = document.createElement("div");
    meta.className = "wfpu-meta";
    const photoCount = (draft.mainImageGcsPath ? 1 : 0) + draft.supportingImageGcsPaths.length;
    meta.textContent = (Number.isFinite(draft.lat) && Number.isFinite(draft.lng) ? draft.lat.toFixed(6) + ", " + draft.lng.toFixed(6) : "No location") + " · current photos: " + photoCount;
    el.append(title, meta);

    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,.heic,.heif";
    input.multiple = true;
    input.style.display = "none";
    el.appendChild(input);

    const actions = document.createElement("div");
    actions.className = "wfpu-actions";
    const btn = (label, cls, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "wfpu-btn" + (cls ? " " + cls : "");
      b.textContent = label;
      b.addEventListener("click", fn);
      actions.appendChild(b);
      return b;
    };
    btn("Choose photos", "wfpu-primary", () => input.click());
    btn("Undo delete", "", () => {
      const last = card.undoStack.pop();
      if (!last) return;
      card.photos.splice(Math.max(0, Math.min(last.index, card.photos.length)), 0, last.photo);
      renderSelected(card);
    });
    btn("Add queue", "", () => addQueue(card, false));
    btn("Upload now", "", () => addQueue(card, true));
    card.undoUploadBtn = btn("Undo upload", "", () => undoUpload(card).catch(err => setCardStatus(card, "Undo failed: " + err.message, "err")));
    card.undoUploadBtn.disabled = true;
    el.appendChild(actions);

    const status = document.createElement("div");
    status.className = "wfpu-status";
    status.textContent = "Ready";
    card.statusEl = status;
    el.appendChild(status);

    const files = document.createElement("div");
    files.className = "wfpu-files";
    card.filesEl = files;
    el.appendChild(files);
    renderSelected(card);

    input.addEventListener("change", async ev => {
      const files = Array.from(ev.target.files || []);
      input.value = "";
      if (!files.length) return;
      try {
        setCardStatus(card, "Converting photos…");
        const converted = await convertFiles(files, (done, total, name) => setCardStatus(card, `Converting ${done}/${total}: ${name}`));
        card.photos.push(...converted);
        renderSelected(card);
        const ignored = Math.max(0, card.photos.length - MAX_PHOTOS);
        setCardStatus(card, ignored ? `Ready; ${ignored} extra photo(s) ignored` : "Ready", ignored ? "" : "ok");
      } catch (err) {
        console.error(err);
        setCardStatus(card, "Image failed: " + err.message, "err");
      }
    });

    state.cards.set(draft.id, card);
    return el;
  }

  function renderDrafts(filter = "") {
    const list = $("#wfpu-draft-list");
    const count = $("#wfpu-count");
    if (!list) return;
    list.textContent = "";
    state.cards.clear();
    const needle = filter.trim().toLowerCase();
    const drafts = state.drafts.filter(d => !needle || (d.title + " " + d.description + " " + d.supportingStatement + " " + d.id).toLowerCase().includes(needle));
    if (count) count.textContent = drafts.length + " draft(s)";
    if (!drafts.length) {
      const empty = document.createElement("div");
      empty.className = "wfpu-empty";
      empty.textContent = "No drafts found.";
      list.appendChild(empty);
      return;
    }
    drafts.forEach(d => list.appendChild(createCard(d)));
  }

  async function refreshDrafts() {
    const status = $("#wfpu-load-status");
    const search = $("#wfpu-search");
    if (status) status.textContent = "Loading drafts…";
    try {
      await loadDrafts();
      if (status) status.textContent = "Loaded.";
      renderDrafts(search ? search.value : "");
    } catch (err) {
      console.error(err);
      if (status) status.textContent = "Failed: " + err.message;
    }
  }

  function openUploader() {
    injectCss();
    const old = document.getElementById("wfpu-modal");
    if (old) old.remove();
    const backdrop = document.createElement("div");
    backdrop.id = "wfpu-modal";
    backdrop.className = "wfpu-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "wfpu-dialog";
    backdrop.appendChild(dialog);

    const head = document.createElement("div");
    head.className = "wfpu-head";
    const title = document.createElement("div");
    title.className = "wfpu-title";
    title.textContent = "Photo Upload";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "wfpu-x";
    close.textContent = "×";
    close.addEventListener("click", () => backdrop.remove());
    head.append(title, close);
    dialog.appendChild(head);

    const note = document.createElement("div");
    note.className = "wfpu-note";
    note.textContent = "Select multiple photo result in first photo = Main, Photos 2-6 = supporting. Extra photo are ignored and won't upload. You should double check and queue all your submission by using \"Add Queue\" then press \"Start queue\" to submit all photo. Failed upload will resubmit by default.";
    dialog.appendChild(note);

    const toolbar = document.createElement("div");
    toolbar.className = "wfpu-toolbar";
    const make = (label, cls, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "wfpu-btn" + (cls ? " " + cls : "");
      b.textContent = label;
      b.addEventListener("click", fn);
      toolbar.appendChild(b);
    };
    make("Refresh drafts", "", refreshDrafts);
    make("Start queue", "wfpu-primary", runQueue);
    make("Clear queue", "", () => { if (!state.running) { state.queue = []; renderQueue(); } });
    const search = document.createElement("input");
    search.id = "wfpu-search";
    search.type = "search";
    search.className = "wfpu-search";
    search.placeholder = "Search drafts…";
    search.addEventListener("input", () => renderDrafts(search.value));
    toolbar.appendChild(search);
    dialog.appendChild(toolbar);

    const info = document.createElement("div");
    info.className = "wfpu-empty";
    info.innerHTML = `<span id="wfpu-count">0 draft(s)</span> · <span id="wfpu-load-status">Not loaded.</span>`;
    dialog.appendChild(info);

    const list = document.createElement("div");
    list.id = "wfpu-draft-list";
    list.className = "wfpu-list";
    dialog.appendChild(list);

    const queue = document.createElement("div");
    queue.className = "wfpu-queue";
    queue.innerHTML = `<b>Queue</b><div id="wfpu-queue-list"></div>`;
    dialog.appendChild(queue);

    backdrop.addEventListener("click", ev => { if (ev.target === backdrop) backdrop.remove(); });
    document.body.appendChild(backdrop);
    renderQueue();
    refreshDrafts();
  }

  function wirePanelLink() {
    $all(".wfmapmods-settings-links").forEach(container => {
      let link = $all("a", container).find(a => txt(a.textContent).toLowerCase() === LINK_TEXT.toLowerCase());
      if (!link) {
        link = document.createElement("a");
        link.href = "#";
        link.textContent = LINK_TEXT;
        container.appendChild(link);
      }
      if (link.dataset.wfpuHooked === "1") return;
      link.dataset.wfpuHooked = "1";
      link.addEventListener("click", ev => {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        openUploader();
      }, true);
    });
  }

  function boot() {
    injectCss();
    wirePanelLink();
    const observer = new MutationObserver(wirePanelLink);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
