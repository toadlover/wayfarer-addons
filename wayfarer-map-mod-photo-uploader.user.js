// ==UserScript==
// @name         Wayfarer Map Mods - Photo Upload
// @namespace    https://wayfarer.nianticlabs.com/
// @version      0.2.0
// @description  Draft photo uploader for Wayfarer Map Mod.
// @author       TrungLatias
// @match        https://wayfarer.nianticlabs.com/*
// @run-at       document-idle
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/heic-to@1.3.0/dist/iife/heic-to.js
// @updateURL    https://raw.githubusercontent.com/Trungx5/wayfarer-addons/Trungx5/wayfarer-map-mod-photo-uploader.user.js
// @downloadURL  https://raw.githubusercontent.com/Trungx5/wayfarer-addons/Trungx5/wayfarer-map-mod-photo-uploader.user.js
// ==/UserScript==

(function () {
  "use strict";

  const MAX_PHOTOS = 6;
  const MAX_SUPPORTING = 5;
  const MAX_UPLOAD_ATTEMPTS = 3;
  const LINK_TEXT = "Photo Upload";
  const DB_NAME = "wfpu-photo-uploader-db";
  const DB_VERSION = 1;
  const PHOTO_STORE = "photos";
  const BATCH_STORE = "batches";
  const SETTINGS_KEY = "wfpu-v2-settings";
  const SESSION_ID = "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);

  const DEFAULT_SETTINGS = {
    showDraftPreview: true,
    zeroPhotoOnly: false,
    showUploadMode: true,
    showPhotoPreview: true,
    gridColumns: 7,
    draftOrder: "newest",
    photoOrder: "newest",
    showHiddenDrafts: false,
    hiddenDraftIds: [],
    chooseMode: "full-auto",
    persistent: false,
    activeBatchId: "default"
  };

  const state = {
    drafts: [],
    visibleDrafts: [],
    photos: [],
    batches: [],
    assignments: new Map(),
    queue: [],
    selectedPhotoIds: new Set(),
    objectUrls: new Map(),
    running: false,
    userLoc: null,
    activeDraftId: null,
    activePreview: null,
    searchText: "",
    db: null,
    settings: loadSettings()
  };

  function $(selector, root = document) { return root.querySelector(selector); }
  function $all(selector, root = document) { return Array.from(root.querySelectorAll(selector)); }
  function txt(value, fallback = "") {
    const s = value == null ? "" : String(value);
    return s.trim() || fallback;
  }
  function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, Math.round(n)));
  }
  function uid(prefix) {
    return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  function frame() { return new Promise(resolve => requestAnimationFrame(resolve)); }

  function loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      return Object.assign({}, DEFAULT_SETTINGS, raw || {});
    } catch (_) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch (err) {
      console.warn("[WF Photo Upload] Could not save settings", err);
    }
  }

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
    all.sort(compareDrafts);
    state.drafts = all;
    const firstSelectable = all.find(isSelectableDraft) || null;
    if (!state.activeDraftId && firstSelectable) state.activeDraftId = firstSelectable.id;
    if (state.activeDraftId && (!all.some(d => d.id === state.activeDraftId) || (isDraftHidden(state.activeDraftId) && !state.settings.showHiddenDrafts))) {
      state.activeDraftId = firstSelectable?.id || null;
    }
    return all;
  }

  function requestUploadUrls(draftId, slots) {
    return postJson("/api/v1/vault/submit/draft/upload?draftId=" + encodeURIComponent(draftId), slots).then(resp => {
      if (!resp || resp.captcha) throw new Error("Upload URL request requires captcha/login.");
      return (resp.result && resp.result.imageUrlMap) || {};
    });
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

  function snapshotDraft(draft) {
    return {
      mainImageGcsPath: draft.mainImageGcsPath || null,
      mainImageServingUrl: draft.mainImageServingUrl || null,
      supportingImageGcsPaths: draft.supportingImageGcsPaths.slice(0, MAX_SUPPORTING),
      supportingImageServingUrls: draft.supportingImageServingUrls.slice(0, MAX_SUPPORTING)
    };
  }

  function getDraftPhotos(draft) {
    if (!draft) return [];
    const out = [];
    if (draft.mainImageGcsPath || draft.mainImageServingUrl) {
      out.push({
        type: "server",
        draftId: draft.id,
        index: 0,
        role: "Main",
        gcsPath: draft.mainImageGcsPath || null,
        url: draft.mainImageServingUrl || "",
        name: "Main photo"
      });
    }
    const supportCount = Math.max(draft.supportingImageGcsPaths.length, draft.supportingImageServingUrls.length);
    for (let i = 0; i < supportCount; i++) {
      const path = draft.supportingImageGcsPaths[i] || null;
      const url = draft.supportingImageServingUrls[i] || "";
      if (!path && !url) continue;
      out.push({
        type: "server",
        draftId: draft.id,
        index: i + 1,
        role: "Support " + (i + 1),
        gcsPath: path,
        url,
        name: "Supporting photo " + (i + 1)
      });
    }
    return out;
  }

  function draftPhotoCount(draft) { return getDraftPhotos(draft).length; }
  function findDraft(id) { return state.drafts.find(d => d.id === id) || null; }
  function findPhoto(id) { return state.photos.find(p => p.id === id) || null; }
  function photoBlob(photo) { return photo && (photo.uploadBlob || photo.originalBlob); }

  function updateDraft(saved) {
    const idx = state.drafts.findIndex(d => d.id === saved.id);
    if (idx >= 0) state.drafts[idx] = saved;
    else state.drafts.unshift(saved);
    if (state.activeDraftId === saved.id && state.activePreview?.type === "server") {
      const photos = getDraftPhotos(saved);
      const next = photos[Math.min(state.activePreview.index || 0, Math.max(0, photos.length - 1))] || photos[0] || null;
      state.activePreview = next;
    }
  }

  function openDb() {
    if (state.db) return Promise.resolve(state.db);
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("This browser does not support IndexedDB."));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = event => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(PHOTO_STORE)) {
          const photos = db.createObjectStore(PHOTO_STORE, { keyPath: "id" });
          photos.createIndex("batchId", "batchId", { unique: false });
          photos.createIndex("persistent", "persistent", { unique: false });
          photos.createIndex("sessionId", "sessionId", { unique: false });
          photos.createIndex("sortTs", "sortTs", { unique: false });
        }
        if (!db.objectStoreNames.contains(BATCH_STORE)) {
          db.createObjectStore(BATCH_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = event => {
        state.db = event.target.result;
        resolve(state.db);
      };
      req.onerror = () => reject(req.error || new Error("Failed to open IndexedDB."));
      req.onblocked = () => reject(new Error("IndexedDB is blocked. Close other Wayfarer tabs and reload."));
    });
  }

  function idbRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("IndexedDB request failed."));
    });
  }

  async function idbStore(name, mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const store = tx.objectStore(name);
      let value;
      try { value = fn(store); } catch (err) { reject(err); return; }
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed."));
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted."));
    });
  }

  async function getAll(storeName) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || new Error("Failed to read IndexedDB."));
      tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed."));
    });
  }

  async function putRecord(storeName, record) {
    await idbStore(storeName, "readwrite", store => { store.put(record); });
  }

  async function deleteRecord(storeName, id) {
    await idbStore(storeName, "readwrite", store => { store.delete(id); });
  }

  async function clearStore(storeName) {
    await idbStore(storeName, "readwrite", store => { store.clear(); });
  }

  async function initStorage() {
    await openDb();
    state.batches = await getAll(BATCH_STORE);
    if (!state.batches.length) {
      const batch = { id: "default", name: "Default", createdAt: Date.now() };
      await putRecord(BATCH_STORE, batch);
      state.batches = [batch];
    }
    if (!state.batches.some(b => b.id === state.settings.activeBatchId)) {
      state.settings.activeBatchId = state.batches[0].id;
      saveSettings();
    }
    state.photos = await getAll(PHOTO_STORE);
    await cleanupSessionPhotos();
    sortPhotos();
  }

  async function cleanupSessionPhotos() {
    const stale = state.photos.filter(p => !p.persistent && p.sessionId !== SESSION_ID);
    if (!stale.length) return;
    for (const photo of stale) await deleteRecord(PHOTO_STORE, photo.id);
    state.photos = state.photos.filter(p => p.persistent || p.sessionId === SESSION_ID);
  }

  function sortPhotos() {
    state.photos.sort(comparePhotos);
  }

  function comparePhotos(a, b) {
    const dir = state.settings.photoOrder === "oldest" ? 1 : -1;
    const diff = ((a.sortTs || 0) - (b.sortTs || 0)) * dir;
    return diff || String(a.name).localeCompare(String(b.name));
  }

  function compareDrafts(a, b) {
    const dir = state.settings.draftOrder === "oldest" ? 1 : -1;
    const diff = ((a.lastModified || 0) - (b.lastModified || 0)) * dir;
    return diff || String(a.title).localeCompare(String(b.title));
  }

  function currentBatch() {
    if (state.settings.activeBatchId === "all") return null;
    return state.batches.find(b => b.id === state.settings.activeBatchId) || state.batches[0] || null;
  }

  function visiblePhotos() {
    const batchId = state.settings.activeBatchId;
    const list = batchId === "all" ? state.photos : state.photos.filter(p => p.batchId === batchId);
    return list.slice().sort(comparePhotos);
  }

  function isHeic(file) {
    const type = (file.type || "").toLowerCase();
    const name = (file.name || "").toLowerCase();
    return type === "image/heic" || type === "image/heif" || name.endsWith(".heic") || name.endsWith(".heif");
  }

  function canConvert(file) {
    const type = (file.type || "").toLowerCase();
    const name = (file.name || "").toLowerCase();
    return isHeic(file) || type === "image/jpeg" || type === "image/jpg" || type === "image/png" || type === "image/webp" || /\.(jpe?g|png|webp)$/i.test(name);
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

  async function convertToUploadBlob(file) {
    if (!canConvert(file)) throw new Error("Unsupported image format: " + (file.name || file.type || "unknown"));
    const type = (file.type || "").toLowerCase();
    if (isHeic(file)) {
      const heicTo = window.HeicTo || window.heicTo;
      if (!heicTo) throw new Error("HEIC converter did not load.");
      return heicTo({ blob: file, type: "image/jpeg", quality: 0.9 });
    }
    if (type === "image/png" || type === "image/webp" || /\.(png|webp)$/i.test(file.name || "")) return canvasToJpeg(file);
    return null;
  }

  function validDateMs(year, month, day, hour, minute, second) {
    const y = Number(year);
    const mo = Number(month) - 1;
    const d = Number(day);
    const h = Number(hour || 0);
    const mi = Number(minute || 0);
    const s = Number(second || 0);
    const dt = new Date(y, mo, d, h, mi, s);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return null;
    return dt.getTime();
  }

  function parseDateFromName(name) {
    const base = String(name || "").replace(/\.[^.]+$/, "");
    const ymd = base.match(/(?:^|[^\d])((?:19|20)\d{2})[-_. ]?([01]\d)[-_. ]?([0-3]\d)(?:[-_. T]?([0-2]\d)[-_.:]?([0-5]\d)(?:[-_.:]?([0-5]\d))?)?/);
    if (ymd) return validDateMs(ymd[1], ymd[2], ymd[3], ymd[4], ymd[5], ymd[6]);
    const dmy = base.match(/(?:^|[^\d])([0-3]\d)[-_. ]([01]\d)[-_. ]((?:19|20)\d{2})(?:[-_. T]?([0-2]\d)[-_.:]?([0-5]\d)(?:[-_.:]?([0-5]\d))?)?/);
    if (dmy) return validDateMs(dmy[3], dmy[2], dmy[1], dmy[4], dmy[5], dmy[6]);
    return null;
  }

  async function importFiles(fileList) {
    const batch = currentBatch();
    if (!batch || batch.id === "all") throw new Error("Choose or create an import batch first.");
    const files = Array.from(fileList || []).filter(canConvert);
    if (!files.length) {
      setStatus("No supported image files found.", "err");
      return;
    }
    files.sort((a, b) => {
      const ad = parseDateFromName(a.webkitRelativePath || a.name) || a.lastModified || 0;
      const bd = parseDateFromName(b.webkitRelativePath || b.name) || b.lastModified || 0;
      return bd - ad || String(a.name).localeCompare(String(b.name));
    });
    setStatus("Importing " + files.length + " photo(s)...", "");
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const parsedTs = parseDateFromName(file.webkitRelativePath || file.name);
      const uploadBlob = await convertToUploadBlob(file);
      const record = {
        id: uid("photo"),
        batchId: batch.id,
        name: file.webkitRelativePath || file.name || "photo.jpg",
        originalBlob: file,
        uploadBlob,
        parsedDate: parsedTs ? new Date(parsedTs).toISOString() : null,
        lastModified: file.lastModified || 0,
        sortTs: parsedTs || file.lastModified || Date.now(),
        persistent: !!state.settings.persistent,
        sessionId: SESSION_ID,
        status: "available",
        addedAt: Date.now()
      };
      await putRecord(PHOTO_STORE, record);
      state.photos.push(record);
      if (i % 5 === 0) {
        sortPhotos();
        renderPhotoTable();
        setStatus("Importing " + (i + 1) + "/" + files.length + ": " + file.name, "");
        await frame();
      }
    }
    sortPhotos();
    renderAll();
    setStatus("Imported " + files.length + " photo(s).", "ok");
  }

  function photoUrl(photo) {
    if (!photo) return "";
    const existing = state.objectUrls.get(photo.id);
    if (existing) return existing;
    const blob = photoBlob(photo);
    if (!blob) return "";
    const url = URL.createObjectURL(blob);
    state.objectUrls.set(photo.id, url);
    return url;
  }

  function revokePhotoUrl(id) {
    const url = state.objectUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    state.objectUrls.delete(id);
  }

  async function updatePhotoRecord(photo) {
    await putRecord(PHOTO_STORE, photo);
  }

  async function setPhotoStatus(ids, status) {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
      const photo = findPhoto(id);
      if (!photo) continue;
      photo.status = status;
      await updatePhotoRecord(photo);
    }
  }

  async function setVisiblePersistence(persistent) {
    state.settings.persistent = !!persistent;
    saveSettings();
    const list = visiblePhotos();
    for (const photo of list) {
      photo.persistent = !!persistent;
      if (!persistent) photo.sessionId = SESSION_ID;
      await updatePhotoRecord(photo);
    }
    renderPhotoTable();
    setStatus(persistent ? "Visible photo table saved persistently." : "Visible photo table set to session storage.", "ok");
  }

  function availablePhotos() {
    return visiblePhotos().filter(p => p.status === "available");
  }

  function isSkippablePhoto(photo) {
    return photo && photo.status === "available";
  }

  function currentLocalPhoto() {
    if (state.activePreview?.type === "upload" && state.activePreview?.photoId) {
      const photo = findPhoto(state.activePreview.photoId);
      if (photo?.status === "available") return photo;
    }
    return availablePhotos()[0] || null;
  }

  function nextAvailablePhotoAfter(photoId) {
    const photos = visiblePhotos();
    const idx = photos.findIndex(p => p.id === photoId);
    const start = idx >= 0 ? idx + 1 : 0;
    for (let i = start; i < photos.length; i++) {
      if (photos[i].status === "available" && photos[i].id !== photoId) return photos[i];
    }
    for (let i = 0; i < start; i++) {
      if (photos[i].status === "available" && photos[i].id !== photoId) return photos[i];
    }
    return null;
  }

  function focusUploadPhoto(photo, showPreview) {
    if (!photo) {
      if (state.activePreview?.type === "upload" || state.activePreview?.type === "pending") state.activePreview = null;
      return null;
    }
    state.activePreview = uploadPreviewItem(photo);
    if (showPreview) {
      state.settings.showPhotoPreview = true;
      saveSettings();
    }
    return photo;
  }

  function ensureCurrentUploadPhoto() {
    if (state.activePreview?.type === "server") return null;
    const active = state.activePreview?.photoId ? findPhoto(state.activePreview.photoId) : null;
    if (state.activePreview?.type === "upload" && active?.status === "available") return active;
    if (state.activePreview?.type === "upload") return null;
    return focusUploadPhoto(availablePhotos()[0] || null, false);
  }

  function focusNextAvailablePhoto(photoId, showPreview) {
    return focusUploadPhoto(nextAvailablePhotoAfter(photoId) || availablePhotos()[0] || null, showPreview);
  }

  function assignmentFor(draftId) {
    return state.assignments.get(draftId) || null;
  }

  function hiddenDraftIds() {
    if (!Array.isArray(state.settings.hiddenDraftIds)) state.settings.hiddenDraftIds = [];
    return state.settings.hiddenDraftIds;
  }

  function isDraftHidden(draftId) {
    return hiddenDraftIds().includes(draftId);
  }

  function isSelectableDraft(draft) {
    return !!draft && !isDraftHidden(draft.id);
  }

  async function setDraftHidden(draftId, hidden) {
    const ids = hiddenDraftIds();
    if (hidden && !ids.includes(draftId)) ids.push(draftId);
    if (!hidden) state.settings.hiddenDraftIds = ids.filter(id => id !== draftId);
    saveSettings();
    if (hidden) {
      await clearAssignment(draftId, true);
      if (state.activeDraftId === draftId) {
        state.activeDraftId = null;
        state.activePreview = null;
      }
    }
    renderAll();
    setStatus(hidden ? "Submission hidden. Turn on Show hidden to restore it." : "Submission restored.", "ok");
  }

  function hasWaitingQueueEntry(draftId) {
    return state.queue.some(e => e.draftId === draftId && !e.done && !e.cancelled);
  }

  function firstOpenAssignment() {
    return Array.from(state.assignments.values()).find(a => !a.queued) || null;
  }

  function firstAutoDraft() {
    const open = firstOpenAssignment();
    if (open) {
      const draft = findDraft(open.draftId);
      if (draft) return draft;
      state.assignments.delete(open.draftId);
    }
    return state.visibleDrafts.find(d => isSelectableDraft(d) && !assignmentFor(d.id) && !hasWaitingQueueEntry(d.id)) || null;
  }

  async function clearAssignment(draftId, releasePhotos) {
    const assignment = assignmentFor(draftId);
    if (!assignment) return;
    if (assignment.queued) return;
    state.assignments.delete(draftId);
    if (releasePhotos) await setPhotoStatus(assignment.photoIds, "available");
    if (state.activePreview?.draftId === draftId && state.activePreview.type === "pending") state.activePreview = null;
  }

  async function addCurrentPhotoToDraft(draft) {
    if (!draft) return setStatus("Select a draft first.", "err");
    if (hasWaitingQueueEntry(draft.id)) return setStatus("This draft already has a queue entry.", "err");
    let assignment = assignmentFor(draft.id);
    if (assignment?.queued) return setStatus("This draft is already queued.", "err");
    if (!assignment) {
      assignment = { draftId: draft.id, photoIds: [], queued: false, createdAt: Date.now() };
      state.assignments.set(draft.id, assignment);
    }
    if (assignment.photoIds.length >= MAX_PHOTOS) {
      state.activeDraftId = draft.id;
      renderAll();
      return setStatus("This draft already has 6 pending photos. Press Next Draft to queue it.", "err");
    }
    const photo = currentLocalPhoto();
    if (!photo) return setStatus("No available photos left to choose.", "err");
    const next = nextAvailablePhotoAfter(photo.id);
    assignment.photoIds.push(photo.id);
    await setPhotoStatus(photo.id, "assigned");
    state.activeDraftId = draft.id;
    focusUploadPhoto(next || availablePhotos()[0] || null, true);
    state.selectedPhotoIds.clear();
    renderAll();
    setStatus("Added current photo " + assignment.photoIds.length + "/" + MAX_PHOTOS + " to " + draft.title + ".", "ok");
  }

  async function choosePhotos() {
    const mode = state.settings.chooseMode;
    if (mode === "nothing") {
      setStatus("Preview-only mode is active; no photos assigned.", "");
      return;
    }
    if (mode === "full-auto") {
      return addCurrentPhotoToDraft(firstAutoDraft());
    }
    if (mode === "semi-auto") {
      const selected = findDraft(state.activeDraftId);
      return addCurrentPhotoToDraft(isSelectableDraft(selected) ? selected : state.visibleDrafts.find(isSelectableDraft) || null);
    }

    const draft = findDraft(state.activeDraftId);
    const ids = Array.from(state.selectedPhotoIds).map(findPhoto).filter(Boolean)
      .sort((a, b) => (b.sortTs || 0) - (a.sortTs || 0)).slice(0, MAX_PHOTOS).map(p => p.id);
    if (!draft) return setStatus("Select a draft first.", "err");
    if (isDraftHidden(draft.id)) return setStatus("Unhide this draft before assigning photos.", "err");
    if (!ids.length) return setStatus("Select or import available photos first.", "err");
    await clearAssignment(draft.id, true);
    state.assignments.set(draft.id, { draftId: draft.id, photoIds: ids, queued: false, createdAt: Date.now() });
    await setPhotoStatus(ids, "assigned");
    state.activeDraftId = draft.id;
    focusUploadPhoto(availablePhotos()[0] || null, true);
    state.selectedPhotoIds.clear();
    renderAll();
    setStatus("Assigned " + ids.length + " photo(s) to " + draft.title + ". Press Next Draft to queue.", "ok");
  }

  function nextDraftAfter(draftId) {
    const idx = state.visibleDrafts.findIndex(d => d.id === draftId);
    if (idx < 0) return state.visibleDrafts.find(isSelectableDraft) || null;
    for (let i = idx + 1; i < state.visibleDrafts.length; i++) {
      const d = state.visibleDrafts[i];
      if (isSelectableDraft(d) && !assignmentFor(d.id) && !hasWaitingQueueEntry(d.id)) return d;
    }
    return null;
  }

  async function skipActiveDraft() {
    const draft = findDraft(state.activeDraftId);
    if (!isSelectableDraft(draft)) return setStatus("Select a draft to skip.", "err");
    if (hasWaitingQueueEntry(draft.id)) return setStatus("This draft is queued. Remove it from the queue first.", "err");
    const next = nextDraftAfter(draft.id);
    await setDraftHidden(draft.id, true);
    if (next) {
      const nextDraft = findDraft(next.id) || next;
      state.activeDraftId = nextDraft.id;
      state.activePreview = getDraftPhotos(nextDraft)[0] || null;
      renderAll();
      setStatus("Skipped draft. Moved to " + nextDraft.title + ".", "ok");
      return;
    }
    setStatus("Draft skipped. No next draft available.", "ok");
  }

  async function queueActiveAssignment() {
    const draft = findDraft(state.activeDraftId);
    if (!draft) return setStatus("Select a draft first.", "err");
    if (isDraftHidden(draft.id)) return setStatus("Unhide this draft before queueing.", "err");
    const assignment = assignmentFor(draft.id);
    if (!assignment || !assignment.photoIds.length) return setStatus("Press Choose before Next Draft.", "err");
    if (assignment.queued) return setStatus("This draft is already queued.", "");
    if (state.queue.some(e => e.draftId === draft.id && !e.done && !e.cancelled)) return setStatus("This draft already has a queue entry.", "err");
    const entry = {
      id: uid("queue"),
      draftId: draft.id,
      title: draft.title,
      photoIds: assignment.photoIds.slice(0, MAX_PHOTOS),
      status: "Waiting",
      progress: 0,
      done: false,
      attempts: 0,
      cancelled: false,
      lastSnapshot: snapshotDraft(draft)
    };
    const next = nextDraftAfter(draft.id);
    assignment.queued = true;
    state.queue.push(entry);
    await setPhotoStatus(entry.photoIds, "queued");
    const nextPhoto = availablePhotos()[0] || null;
    if (next) {
      state.activeDraftId = next.id;
      state.activePreview = nextPhoto ? uploadPreviewItem(nextPhoto) : (getDraftPhotos(next)[0] || null);
    } else {
      state.activeDraftId = null;
      state.activePreview = nextPhoto ? uploadPreviewItem(nextPhoto) : null;
    }
    renderAll();
    setStatus(next ? "Queued " + draft.title + ". Moved to " + next.title + "." : "Queued " + draft.title + ". No next draft available.", "ok");
  }

  function setQueueStatus(entry, message, pct) {
    entry.status = message || entry.status || "Waiting";
    entry.progress = Math.max(0, Math.min(100, Number(pct) || 0));
    const status = $("[data-wfpu-q-status='" + entry.id + "']");
    const fill = $("[data-wfpu-q-fill='" + entry.id + "']");
    if (status) status.textContent = entry.status;
    if (fill) fill.style.width = entry.progress + "%";
  }

  function throwIfCancelled(entry) {
    if (entry.cancelled) throw new Error("Cancelled");
  }

  async function uploadEntry(entry) {
    const draft = findDraft(entry.draftId);
    if (!draft) throw new Error("Draft no longer exists.");
    const photos = entry.photoIds.map(findPhoto).filter(Boolean).slice(0, MAX_PHOTOS);
    if (!photos.length) throw new Error("No queued photos found.");
    entry.lastSnapshot = snapshotDraft(draft);
    throwIfCancelled(entry);

    const slots = photos.map((_, i) => slotName(i));
    setQueueStatus(entry, "Requesting upload URLs", 15);
    const urlMap = await requestUploadUrls(draft.id, slots);
    const gcs = {};
    for (let i = 0; i < photos.length; i++) {
      throwIfCancelled(entry);
      const slot = slots[i];
      const info = urlMap[slot] || {};
      const uploadUrl = info.uploadUrl || info.url || info.signedUrl;
      if (!uploadUrl || !info.gcsPath) throw new Error("Missing upload URL for " + slot);
      setQueueStatus(entry, "Uploading " + (i + 1) + "/" + photos.length, 20 + Math.floor((i / photos.length) * 60));
      await putSigned(uploadUrl, photoBlob(photos[i]));
      gcs[slot] = info.gcsPath;
    }

    const supporting = [];
    for (let i = 1; i < photos.length; i++) {
      const slot = slotName(i);
      if (gcs[slot]) supporting.push(gcs[slot]);
    }
    throwIfCancelled(entry);
    setQueueStatus(entry, "Saving draft", 88);
    const saved = await saveDraft(draft, {
      mainImageGcsPath: gcs.main || null,
      mainImageServingUrl: null,
      supportingImageGcsPaths: supporting,
      supportingImageServingUrls: []
    });
    updateDraft(saved);
    state.assignments.delete(entry.draftId);
    await setPhotoStatus(entry.photoIds, "uploaded");
    entry.done = true;
    setQueueStatus(entry, "Done", 100);
  }

  async function releaseQueueEntry(entry) {
    state.queue = state.queue.filter(e => e !== entry);
    const assignment = assignmentFor(entry.draftId);
    if (assignment?.queued) state.assignments.delete(entry.draftId);
    const releasable = entry.photoIds.map(findPhoto).filter(p => p && p.status === "queued").map(p => p.id);
    if (releasable.length) await setPhotoStatus(releasable, "available");
    renderAll();
  }

  async function runQueue() {
    if (state.running) return;
    state.running = true;
    renderQueue();
    try {
      for (const entry of state.queue) {
        if (entry.done || entry.cancelled) continue;
        while (!entry.done && !entry.cancelled && entry.attempts < MAX_UPLOAD_ATTEMPTS) {
          try {
            entry.attempts++;
            setQueueStatus(entry, entry.attempts > 1 ? "Retrying " + entry.attempts + "/" + MAX_UPLOAD_ATTEMPTS : "Starting", 5);
            await uploadEntry(entry);
          } catch (err) {
            console.error("[WF Photo Upload]", err);
            if (entry.cancelled || err.message === "Cancelled") {
              entry.cancelled = true;
              setQueueStatus(entry, "Cancelled", entry.progress || 0);
              const releasable = entry.photoIds.map(findPhoto).filter(p => p && p.status === "queued").map(p => p.id);
              if (releasable.length) await setPhotoStatus(releasable, "available");
              break;
            }
            if (entry.attempts < MAX_UPLOAD_ATTEMPTS) {
              setQueueStatus(entry, "Failed, retrying by default", entry.progress || 0);
              await sleep(900);
              continue;
            }
            setQueueStatus(entry, "Error after " + entry.attempts + " tries: " + err.message, entry.progress || 0);
            break;
          }
        }
      }
    } finally {
      state.running = false;
      renderAll();
    }
  }

  async function clearWaitingQueue() {
    if (state.running) return setStatus("Queue is running.", "err");
    const entries = state.queue.filter(e => !e.done);
    for (const entry of entries) await releaseQueueEntry(entry);
    state.queue = state.queue.filter(e => e.done);
    renderAll();
    setStatus("Waiting queue cleared.", "ok");
  }

  function removePhotosFromOpenAssignments(photoIds) {
    for (const assignment of Array.from(state.assignments.values())) {
      if (assignment.queued) continue;
      assignment.photoIds = assignment.photoIds.filter(id => !photoIds.includes(id));
      if (!assignment.photoIds.length) state.assignments.delete(assignment.draftId);
    }
  }

  async function skipPhotoIds(ids, label) {
    const unique = Array.from(new Set(ids)).filter(Boolean);
    const skippable = unique.map(findPhoto).filter(isSkippablePhoto);
    if (!skippable.length) return setStatus("No skippable photos selected.", "err");
    const skipIds = skippable.map(p => p.id);
    removePhotosFromOpenAssignments(skipIds);
    for (const photo of skippable) {
      photo.status = "skipped";
      await updatePhotoRecord(photo);
      state.selectedPhotoIds.delete(photo.id);
    }
    if (state.activePreview?.type === "pending" && skipIds.includes(state.activePreview.photoId)) state.activePreview = null;
    renderAll();
    setStatus("Skipped " + skipIds.length + " photo(s)" + (label ? " from " + label : "") + ".", "ok");
  }

  async function restorePhotoIds(ids, label) {
    const unique = Array.from(new Set(ids)).filter(Boolean);
    const restorable = unique.map(findPhoto).filter(p => p && p.status === "skipped");
    if (!restorable.length) return setStatus("No skipped photos selected.", "err");
    for (const photo of restorable) {
      photo.status = "available";
      await updatePhotoRecord(photo);
    }
    renderAll();
    setStatus("Restored " + restorable.length + " photo(s)" + (label ? " from " + label : "") + ".", "ok");
  }

  async function skipCurrentPhoto() {
    const photo = ensureCurrentUploadPhoto();
    if (!isSkippablePhoto(photo)) return setStatus("Select a skippable photo first.", "err");
    const next = nextAvailablePhotoAfter(photo.id);
    await skipPhotoIds([photo.id], "current photo");
    focusUploadPhoto(next ? findPhoto(next.id) || next : availablePhotos()[0] || null, true);
    renderAll();
  }

  async function clearActiveAssignment() {
    const draft = findDraft(state.activeDraftId);
    if (!draft) return setStatus("Select a draft first.", "err");
    const assignment = assignmentFor(draft.id);
    if (!assignment) return setStatus("This draft has no pending assignment.", "");
    if (assignment.queued) return setStatus("This draft is queued. Remove it from the queue first.", "err");
    await clearAssignment(draft.id, true);
    renderAll();
    setStatus("Cleared assignment for " + draft.title + ".", "ok");
  }

  function deleteCurrentImage() {
    if (state.selectedPhotoIds.size) return deletePhotoIds(Array.from(state.selectedPhotoIds), "selected photos");
    if (state.activePreview?.type === "server") return deleteDraftPhoto(state.activePreview);
    if (state.activePreview?.photoId) return deletePhotoIds([state.activePreview.photoId], "current image");
    return setStatus("Select an image first.", "err");
  }

  async function deletePhotoIds(ids, label) {
    const unique = Array.from(new Set(ids)).filter(Boolean);
    const deletable = unique.map(findPhoto).filter(p => p && p.status !== "queued");
    if (!deletable.length) return setStatus("No deletable photos selected.", "err");
    const locked = unique.length - deletable.length;
    const message = "Delete " + deletable.length + " photo(s)" + (locked ? " and skip " + locked + " locked photo(s)" : "") + (label ? " from " + label : "") + "?";
    if (!window.confirm(message)) return;
    const deleteIds = deletable.map(p => p.id);
    removePhotosFromOpenAssignments(deleteIds);
    for (const id of deleteIds) {
      revokePhotoUrl(id);
      await deleteRecord(PHOTO_STORE, id);
      state.selectedPhotoIds.delete(id);
      if (state.activePreview?.photoId === id) state.activePreview = null;
    }
    state.photos = state.photos.filter(p => !deleteIds.includes(p.id));
    renderAll();
    setStatus("Deleted " + deleteIds.length + " photo(s).", "ok");
  }

  async function resetPhotoTable() {
    if (!state.photos.length) return;
    if (!window.confirm("Reset the entire upload photo table? This removes all local photo records.")) return;
    for (const id of Array.from(state.objectUrls.keys())) revokePhotoUrl(id);
    await clearStore(PHOTO_STORE);
    state.photos = [];
    state.assignments.clear();
    state.queue = state.queue.filter(e => e.done);
    state.selectedPhotoIds.clear();
    state.activePreview = null;
    renderAll();
    setStatus("Photo table reset.", "ok");
  }

  async function deleteDraftPhoto(preview) {
    const draft = findDraft(preview?.draftId);
    if (!draft || preview?.type !== "server") return;
    if (!window.confirm("Delete " + preview.role + " from " + draft.title + "? This saves the draft immediately.")) return;
    setStatus("Deleting draft photo...", "");
    const paths = draft.supportingImageGcsPaths.slice(0, MAX_SUPPORTING);
    const urls = draft.supportingImageServingUrls.slice(0, MAX_SUPPORTING);
    const imageFields = {
      mainImageGcsPath: draft.mainImageGcsPath || null,
      mainImageServingUrl: draft.mainImageServingUrl || null,
      supportingImageGcsPaths: paths,
      supportingImageServingUrls: urls
    };
    if (preview.index === 0) {
      imageFields.mainImageGcsPath = null;
      imageFields.mainImageServingUrl = null;
    } else {
      const supportIndex = preview.index - 1;
      imageFields.supportingImageGcsPaths = paths.filter((_, i) => i !== supportIndex);
      imageFields.supportingImageServingUrls = urls.filter((_, i) => i !== supportIndex);
    }
    try {
      const saved = await saveDraft(draft, imageFields);
      updateDraft(saved);
      state.activePreview = getDraftPhotos(saved)[0] || null;
      renderAll();
      setStatus("Draft photo deleted.", "ok");
    } catch (err) {
      console.error(err);
      setStatus("Delete failed: " + err.message, "err");
    }
  }

  async function createBatch() {
    const input = $("#wfpu-batch-name");
    const name = txt(input?.value, "Batch " + (state.batches.length + 1));
    const batch = { id: uid("batch"), name, createdAt: Date.now() };
    await putRecord(BATCH_STORE, batch);
    state.batches.push(batch);
    state.settings.activeBatchId = batch.id;
    saveSettings();
    if (input) input.value = "";
    renderAll();
    setStatus("Created batch " + batch.name + ".", "ok");
  }

  function setStatus(message, cls) {
    const el = $("#wfpu-status");
    if (!el) return;
    el.textContent = message || "";
    el.className = "wfpu-status" + (cls ? " " + cls : "");
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function makeButton(text, className, onClick) {
    const b = el("button", "wfpu-btn" + (className ? " " + className : ""), text);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  function makeToggle(label, checked, onChange) {
    const wrap = el("label", "wfpu-toggle");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!checked;
    input.addEventListener("change", () => onChange(input.checked));
    wrap.append(input, document.createTextNode(label));
    return wrap;
  }

  function injectCss() {
    if (document.getElementById("wfpu-plugin-css")) return;
    const style = document.createElement("style");
    style.id = "wfpu-plugin-css";
    style.textContent = `
.wfpu-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.38);z-index:2147483599;display:flex;align-items:center;justify-content:center;padding:10px;box-sizing:border-box}
.wfpu-dialog{width:min(1500px,calc(100vw - 20px));height:min(920px,calc(100vh - 20px));background:#fff;color:#111827;border-radius:8px;box-shadow:0 18px 50px rgba(0,0,0,.36);font-family:Roboto,Arial,sans-serif;font-size:12px;display:flex;flex-direction:column;overflow:hidden}
.wfpu-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid #e5e7eb;background:#f8fafc}
.wfpu-title{font-size:15px;font-weight:700}.wfpu-x{width:28px;height:28px;border:1px solid #d1d5db;background:#fff;color:#111827;border-radius:6px;cursor:pointer;font-weight:700}
.wfpu-shell{display:grid;grid-template-columns:minmax(360px,42%) minmax(420px,58%);gap:0;min-height:0;flex:1}
.wfpu-left,.wfpu-right{min-height:0;display:flex;flex-direction:column}.wfpu-left{border-right:1px solid #e5e7eb;background:#f9fafb}.wfpu-right{background:#fff}
.wfpu-modebar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px;border-bottom:1px solid #e5e7eb;background:#f8fafc;flex:0 0 auto}
.wfpu-drafts{flex:2 1 0;min-height:0;display:flex;flex-direction:column}.wfpu-queue-panel{flex:1 1 0;min-height:170px;display:flex;flex-direction:column;border-top:1px solid #e5e7eb;background:#fff}
.wfpu-panel-head,.wfpu-toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:8px;border-bottom:1px solid #e5e7eb}
.wfpu-panel-title{font-weight:700;margin-right:auto}.wfpu-status,.wfpu-meta,.wfpu-empty{font-size:11px;color:#6b7280}.wfpu-status.ok{color:#047857}.wfpu-status.err{color:#b91c1c}
.wfpu-btn{border:1px solid #d1d5db;border-radius:5px;background:#fff;color:#111827;cursor:pointer;font:inherit;padding:5px 8px;white-space:nowrap}.wfpu-btn:hover:not(:disabled){background:#f3f4f6}.wfpu-btn:disabled{opacity:.55;cursor:not-allowed}
.wfpu-primary{background:#fb4c21;border-color:#fb4c21;color:#fff}.wfpu-primary:hover:not(:disabled){background:#e0441d}
.wfpu-danger{border-color:#fca5a5;color:#991b1b}.wfpu-search,.wfpu-input,.wfpu-select{border:1px solid #d1d5db;border-radius:5px;background:#fff;color:#111827;font:inherit;padding:5px 7px;min-width:0}.wfpu-search{flex:1 1 170px}
.wfpu-toggle{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#374151;white-space:nowrap}.wfpu-toggle input{margin:0}.wfpu-count{font-size:11px;color:#6b7280;padding:0 8px 6px}
.wfpu-draft-list,.wfpu-queue-list{min-height:0;overflow:auto;padding:7px;display:flex;flex-direction:column;gap:6px}.wfpu-draft-list{flex:1}
.wfpu-draft{border:1px solid #e5e7eb;background:#fff;border-radius:6px;padding:7px;cursor:pointer}.wfpu-draft:hover{border-color:#f97316}.wfpu-draft.active{border-color:#fb4c21;box-shadow:0 0 0 1px #fb4c21 inset}.wfpu-draft.wfpu-draft-hidden{opacity:.68;border-style:dashed}
.wfpu-draft-top{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:start}.wfpu-draft-title{font-weight:700;word-break:break-word}.wfpu-draft-side{display:flex;gap:5px;align-items:flex-start;justify-content:flex-end;flex-wrap:wrap}.wfpu-draft-side .wfpu-btn{padding:2px 6px;font-size:11px}.wfpu-pill{border:1px solid #e5e7eb;border-radius:999px;padding:2px 7px;background:#f8fafc;font-size:11px;color:#374151}
.wfpu-draft-thumbs{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}.wfpu-thumb-btn{border:1px solid #d1d5db;background:#fff;border-radius:5px;padding:0;cursor:pointer;width:46px;height:46px;overflow:hidden}.wfpu-thumb-btn.active{border-color:#fb4c21;box-shadow:0 0 0 1px #fb4c21}.wfpu-thumb-btn img{width:100%;height:100%;object-fit:cover;display:block}.wfpu-thumb-miss{display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:#eef2f7;color:#6b7280;font-size:10px;text-align:center}
.wfpu-qrow{border:1px solid #e5e7eb;border-radius:6px;background:#f9fafb;padding:7px}.wfpu-qhead{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;align-items:center}.wfpu-bar{height:6px;border-radius:999px;background:#e5e7eb;overflow:hidden;margin-top:5px}.wfpu-fill{height:100%;width:0%;background:#fb4c21;transition:width 160ms ease}
.wfpu-section{min-height:0;display:flex;flex-direction:column;border-bottom:1px solid #e5e7eb}.wfpu-upload-section{flex:2 1 0}.wfpu-preview-section{flex:3 1 0;border-bottom:0}.wfpu-section.hidden{display:none}
.wfpu-section-body{min-height:0;display:flex;flex-direction:column;gap:7px;padding:8px;flex:1}.wfpu-grid-controls{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.wfpu-grid-controls .wfpu-input{width:92px}.wfpu-range{width:110px}
.wfpu-upload-split{min-height:0;display:grid;grid-template-rows:minmax(0,1fr) auto;gap:7px;flex:1;overflow:hidden}.wfpu-photo-table{min-height:0;overflow:auto;border:1px solid #e5e7eb;border-radius:6px;background:#f8fafc;padding:6px;position:relative;z-index:0}.wfpu-photo-row{display:grid;grid-template-columns:34px minmax(0,1fr);gap:6px;margin-bottom:6px;align-items:stretch}.wfpu-row-delete{writing-mode:vertical-rl;text-orientation:mixed;padding:4px 2px}
.wfpu-photo-grid{display:grid;gap:6px}.wfpu-photo-tile{position:relative;min-width:0;border:1px solid #e5e7eb;background:#fff;border-radius:6px;overflow:hidden;cursor:pointer}.wfpu-photo-tile.selected{border-color:#2563eb;box-shadow:0 0 0 1px #2563eb}.wfpu-photo-tile.focused{border-color:#fb4c21;box-shadow:0 0 0 2px #fb4c21}.wfpu-photo-tile.locked{opacity:.72}.wfpu-photo-tile img{width:100%;aspect-ratio:1/1;object-fit:cover;display:block;background:#e5e7eb}.wfpu-photo-tile input{position:absolute;left:5px;top:5px}.wfpu-photo-badge{position:absolute;right:4px;top:4px;background:rgba(17,24,39,.78);color:#fff;border-radius:4px;padding:1px 4px;font-size:10px}.wfpu-photo-name{font-size:10px;line-height:1.2;padding:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wfpu-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;align-items:stretch;position:relative;z-index:1;flex:0 0 auto}.wfpu-action-pair{display:flex;flex-direction:column;gap:6px;min-width:0}.wfpu-action-pair .wfpu-btn{width:100%;white-space:normal}.wfpu-preview-main{border:1px solid #e5e7eb;border-radius:6px;background:#f9fafb;min-height:300px;padding:7px;display:grid;grid-template-rows:minmax(0,1fr) auto;gap:8px;flex:1;overflow:auto}.wfpu-preview-main img{max-width:100%;max-height:100%;width:100%;height:100%;min-height:0;object-fit:contain;background:#fff;border-radius:5px;border:1px solid #e5e7eb}.wfpu-preview-main .wfpu-preview-info{flex-direction:row;align-items:flex-start;flex-wrap:wrap;overflow:visible}.wfpu-preview-main .wfpu-btn{align-self:flex-start;min-height:28px;line-height:1.2;white-space:normal}.wfpu-preview-main.no-photo{display:flex;align-items:center;justify-content:center;color:#6b7280}
.wfpu-preview-info{min-width:0;display:flex;flex-direction:column;gap:6px}.wfpu-preview-title{font-weight:700;word-break:break-word}.wfpu-preview-meta{color:#6b7280;font-size:11px;word-break:break-word}.wfpu-footer-status{padding:6px 8px;border-top:1px solid #e5e7eb;background:#f8fafc}
@media(max-width:900px){.wfpu-shell{grid-template-columns:1fr}.wfpu-left{border-right:0;border-bottom:1px solid #e5e7eb}.wfpu-dialog{height:calc(100vh - 16px)}.wfpu-left{max-height:44vh}.wfpu-row-delete{writing-mode:horizontal-tb}.wfpu-photo-row{grid-template-columns:1fr}.wfpu-actions{grid-template-columns:1fr}}
@media(prefers-color-scheme:dark){.wfpu-dialog,.wfpu-right,.wfpu-queue-panel,.wfpu-draft,.wfpu-photo-tile{background:#111827;color:#f9fafb}.wfpu-head,.wfpu-left,.wfpu-section,.wfpu-modebar,.wfpu-footer-status,.wfpu-photo-table,.wfpu-qrow,.wfpu-preview-main{background:#0f172a;border-color:rgba(255,255,255,.14)}.wfpu-btn,.wfpu-x,.wfpu-search,.wfpu-input,.wfpu-select{background:#1f2937;color:#f9fafb;border-color:rgba(255,255,255,.18)}.wfpu-meta,.wfpu-status,.wfpu-empty,.wfpu-preview-meta,.wfpu-toggle,.wfpu-count{color:#9ca3af}.wfpu-pill{background:#1f2937;color:#d1d5db;border-color:rgba(255,255,255,.14)}.wfpu-bar{background:#374151}}
`;
    document.head.appendChild(style);
  }

  function renderDrafts() {
    const list = $("#wfpu-draft-list");
    const count = $("#wfpu-draft-count");
    if (!list) return;
    list.textContent = "";
    const order = $("#wfpu-draft-order");
    if (order) order.value = state.settings.draftOrder;
    const needle = state.searchText.trim().toLowerCase();
    state.visibleDrafts = state.drafts.filter(d => {
      if (isDraftHidden(d.id) && !state.settings.showHiddenDrafts) return false;
      if (state.settings.zeroPhotoOnly && draftPhotoCount(d) !== 0) return false;
      if (!needle) return true;
      return (d.title + " " + d.description + " " + d.supportingStatement + " " + d.id).toLowerCase().includes(needle);
    }).sort(compareDrafts);
    if (count) count.textContent = state.visibleDrafts.length + " draft(s)";
    if (!state.visibleDrafts.length) {
      list.appendChild(el("div", "wfpu-empty", "No drafts found."));
      return;
    }
    state.visibleDrafts.forEach(draft => {
      const hidden = isDraftHidden(draft.id);
      const row = el("div", "wfpu-draft" + (draft.id === state.activeDraftId ? " active" : "") + (hidden ? " wfpu-draft-hidden" : ""));
      row.addEventListener("click", () => {
        state.activeDraftId = draft.id;
        state.activePreview = getDraftPhotos(draft)[0] || null;
        renderAll();
      });
      const top = el("div", "wfpu-draft-top");
      const titleWrap = el("div");
      titleWrap.appendChild(el("div", "wfpu-draft-title", draft.title));
      const loc = Number.isFinite(draft.lat) && Number.isFinite(draft.lng) ? draft.lat.toFixed(6) + ", " + draft.lng.toFixed(6) : "No location";
      const assignment = assignmentFor(draft.id);
      const suffix = assignment ? " - pending: " + assignment.photoIds.length : "";
      titleWrap.appendChild(el("div", "wfpu-meta", loc + suffix));
      const side = el("div", "wfpu-draft-side");
      side.appendChild(el("div", "wfpu-pill", draftPhotoCount(draft) + " photo"));
      const hideButton = makeButton(hidden ? "Unhide" : "Hide", hidden ? "" : "wfpu-danger", async ev => {
        ev.stopPropagation();
        await setDraftHidden(draft.id, !hidden);
      });
      side.appendChild(hideButton);
      top.append(titleWrap, side);
      row.appendChild(top);
      if (state.settings.showDraftPreview) {
        const photos = getDraftPhotos(draft);
        const thumbs = el("div", "wfpu-draft-thumbs");
        if (!photos.length) thumbs.appendChild(el("div", "wfpu-empty", "No draft photos."));
        photos.slice(0, MAX_PHOTOS).forEach(photo => {
          const btn = el("button", "wfpu-thumb-btn" + (state.activePreview?.draftId === draft.id && state.activePreview?.type === "server" && state.activePreview?.index === photo.index ? " active" : ""));
          btn.type = "button";
          btn.title = photo.role;
          btn.addEventListener("click", ev => {
            ev.stopPropagation();
            state.activeDraftId = draft.id;
            state.settings.showPhotoPreview = true;
            state.activePreview = photo;
            saveSettings();
            renderAll();
          });
          if (photo.url) {
            const img = document.createElement("img");
            img.src = photo.url;
            img.alt = photo.role;
            btn.appendChild(img);
          } else {
            btn.appendChild(el("span", "wfpu-thumb-miss", photo.role));
          }
          thumbs.appendChild(btn);
        });
        row.appendChild(thumbs);
      }
      list.appendChild(row);
    });
  }

  function renderQueue() {
    const list = $("#wfpu-queue-list");
    if (!list) return;
    list.textContent = "";
    if (!state.queue.length) {
      list.appendChild(el("div", "wfpu-empty", "Queue is empty."));
      return;
    }
    state.queue.forEach(entry => {
      const row = el("div", "wfpu-qrow");
      const head = el("div", "wfpu-qhead");
      const title = el("div", "wfpu-draft-title", entry.title + " - " + entry.photoIds.length + " photo(s)");
      const cancel = makeButton(entry.done ? "Done" : "Remove", "", async () => {
        if (entry.done) return;
        if (state.running && entry.status !== "Waiting") {
          entry.cancelled = true;
          setQueueStatus(entry, "Cancelling...", entry.progress || 0);
        } else {
          await releaseQueueEntry(entry);
        }
      });
      cancel.disabled = entry.done || entry.cancelled;
      head.append(title, cancel);
      const status = el("div", "wfpu-status", entry.status);
      status.dataset.wfpuQStatus = entry.id;
      const bar = el("div", "wfpu-bar");
      const fill = el("div", "wfpu-fill");
      fill.dataset.wfpuQFill = entry.id;
      fill.style.width = (entry.progress || 0) + "%";
      bar.appendChild(fill);
      row.append(head, status, bar);
      list.appendChild(row);
    });
  }

  function renderBatchControls() {
    const select = $("#wfpu-batch-select");
    if (!select) return;
    select.textContent = "";
    const all = document.createElement("option");
    all.value = "all";
    all.textContent = "All batches";
    select.appendChild(all);
    state.batches.slice().sort((a, b) => a.createdAt - b.createdAt).forEach(batch => {
      const opt = document.createElement("option");
      opt.value = batch.id;
      opt.textContent = batch.name;
      select.appendChild(opt);
    });
    select.value = state.settings.activeBatchId;
  }

  function renderPhotoTable() {
    const table = $("#wfpu-photo-table");
    if (!table) return;
    table.textContent = "";
    const photos = visiblePhotos();
    const columns = clamp(state.settings.gridColumns, 3, 10);
    const count = $("#wfpu-photo-count");
    if (count) count.textContent = photos.length + " photo(s)";
    if (!photos.length) {
      table.appendChild(el("div", "wfpu-empty", "Import photos to fill this table."));
      return;
    }
    for (let i = 0; i < photos.length; i += columns) {
      const rowPhotos = photos.slice(i, i + columns);
      const row = el("div", "wfpu-photo-row");
      const delRow = makeButton("Delete row", "wfpu-danger wfpu-row-delete", () => {
        const rowIds = rowPhotos.map(p => p.id);
        deletePhotoIds(rowIds.concat(Array.from(state.selectedPhotoIds)), "this row");
      });
      const grid = el("div", "wfpu-photo-grid");
      grid.style.gridTemplateColumns = "repeat(" + columns + ", minmax(0, 1fr))";
      rowPhotos.forEach(photo => {
        const selected = state.selectedPhotoIds.has(photo.id);
        const focused = state.activePreview?.type === "upload" && state.activePreview?.photoId === photo.id && photo.status === "available";
        const locked = photo.status !== "available";
        const tile = el("div", "wfpu-photo-tile" + (selected ? " selected" : "") + (focused ? " focused" : "") + (locked ? " locked" : ""));
        tile.title = photo.name;
        tile.addEventListener("mouseenter", () => {
          if (photo.status === "available") showUploadPhotoPreview(photo, false);
        });
        tile.addEventListener("click", ev => {
          if (ev.target && ev.target.tagName === "INPUT") return;
          if (state.settings.chooseMode === "manual" && photo.status === "available") {
            if (state.selectedPhotoIds.has(photo.id)) state.selectedPhotoIds.delete(photo.id);
            else state.selectedPhotoIds.add(photo.id);
          }
          showUploadPhotoPreview(photo, true);
        });
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selected;
        checkbox.disabled = photo.status === "queued";
        checkbox.addEventListener("change", ev => {
          ev.stopPropagation();
          if (checkbox.checked) state.selectedPhotoIds.add(photo.id);
          else state.selectedPhotoIds.delete(photo.id);
          showUploadPhotoPreview(photo, true);
        });
        const img = document.createElement("img");
        img.src = photoUrl(photo);
        img.alt = photo.name;
        const badge = el("div", "wfpu-photo-badge", photo.status || "available");
        const name = el("div", "wfpu-photo-name", photo.name.split(/[\\/]/).pop());
        tile.append(checkbox, img, badge, name);
        grid.appendChild(tile);
      });
      row.append(delRow, grid);
      table.appendChild(row);
    }
  }

  function pendingPreviewItems(draftId) {
    const assignment = assignmentFor(draftId);
    if (!assignment) return [];
    return assignment.photoIds.map((id, index) => {
      const photo = findPhoto(id);
      if (!photo) return null;
      return { type: "pending", draftId, photoId: id, index, role: photoRole(index), name: photo.name, url: photoUrl(photo) };
    }).filter(Boolean);
  }

  function uploadPreviewItem(photo) {
    if (!photo) return null;
    return {
      type: "upload",
      photoId: photo.id,
      role: "Upload photo",
      name: photo.name,
      url: photoUrl(photo)
    };
  }

  function showUploadPhotoPreview(photo, openPreview) {
    if (!photo) return;
    state.activePreview = uploadPreviewItem(photo);
    if (openPreview) {
      state.settings.showPhotoPreview = true;
      saveSettings();
      renderAll();
    } else if (state.settings.showPhotoPreview) {
      renderPhotoPreview();
    }
  }

  function renderPhotoPreview() {
    const section = $("#wfpu-preview-section");
    const body = $("#wfpu-preview-body");
    if (!section || !body) return;
    const toggle = $("#wfpu-toggle-preview-mode");
    if (toggle) toggle.checked = !!state.settings.showPhotoPreview;
    section.classList.toggle("hidden", !state.settings.showPhotoPreview);
    body.textContent = "";
    if (state.activePreview?.type === "upload") {
      renderUploadPhotoPreview(body, state.activePreview);
      return;
    }
    const draft = findDraft(state.activeDraftId);
    if (!draft) {
      body.appendChild(el("div", "wfpu-empty", "Click an upload photo or draft photo to preview it here."));
      return;
    }
    const header = el("div", "wfpu-preview-title", draft.title);
    const items = getDraftPhotos(draft).concat(pendingPreviewItems(draft.id));
    if (!state.activePreview || state.activePreview.draftId !== draft.id) state.activePreview = items[0] || null;
    const active = state.activePreview;
    const main = el("div", active ? "wfpu-preview-main" : "wfpu-preview-main no-photo");
    if (!active) {
      main.textContent = "Click a draft photo or choose pending photos to preview here.";
    } else {
      const img = document.createElement("img");
      img.src = active.url || (active.photoId ? photoUrl(findPhoto(active.photoId)) : "");
      img.alt = active.role || "photo";
      const info = el("div", "wfpu-preview-info");
      info.appendChild(el("div", "wfpu-preview-title", active.role || "Photo"));
      info.appendChild(el("div", "wfpu-preview-meta", active.name || (active.type === "server" ? "Server photo" : "Pending photo")));
      info.appendChild(el("div", "wfpu-preview-meta", active.type === "server" ? "Existing draft photo" : "Pending upload photo"));
      if (active.type === "server") info.appendChild(makeButton("Delete draft photo", "wfpu-danger", () => deleteDraftPhoto(active)));
      main.append(img, info);
    }
    body.append(header, main);
  }

  function renderUploadPhotoPreview(body, preview) {
    const photo = findPhoto(preview.photoId);
    if (!photo) {
      body.appendChild(el("div", "wfpu-empty", "Upload photo is no longer available."));
      return;
    }
    body.appendChild(el("div", "wfpu-preview-title", "Upload Photo Preview"));
    const main = el("div", "wfpu-preview-main");
    const img = document.createElement("img");
    img.src = photoUrl(photo);
    img.alt = photo.name;
    const info = el("div", "wfpu-preview-info");
    info.appendChild(el("div", "wfpu-preview-title", photo.name));
    info.appendChild(el("div", "wfpu-preview-meta", "Status: " + photo.status + (photo.parsedDate ? " - Filename date: " + photo.parsedDate.slice(0, 19).replace("T", " ") : "")));
    info.appendChild(el("div", "wfpu-preview-meta", "Batch: " + (state.batches.find(b => b.id === photo.batchId)?.name || photo.batchId)));
    const draft = findDraft(state.activeDraftId);
    if (isSelectableDraft(draft)) {
      info.appendChild(makeButton("Skip Draft", "wfpu-danger", skipActiveDraft));
    }
    if (photo.status === "skipped") {
      info.appendChild(makeButton("Restore photo", "", () => restorePhotoIds([photo.id], "this upload photo")));
    } else if (isSkippablePhoto(photo)) {
      info.appendChild(makeButton("Skip Photo", "", skipCurrentPhoto));
    }
    info.appendChild(makeButton("Delete local photo", "wfpu-danger", () => deletePhotoIds([photo.id], "this upload photo")));
    main.append(img, info);
    body.appendChild(main);
  }

  function isSamePreview(a, b) {
    if (!a || !b) return false;
    if (a.type !== b.type || a.draftId !== b.draftId) return false;
    if (a.type === "upload") return a.photoId === b.photoId;
    if (a.type === "server") return a.index === b.index;
    return a.photoId === b.photoId;
  }

  function renderUploadSection() {
    const section = $("#wfpu-upload-section");
    if (!section) return;
    const uploadToggle = $("#wfpu-toggle-upload-mode");
    if (uploadToggle) uploadToggle.checked = !!state.settings.showUploadMode;
    section.classList.toggle("hidden", !state.settings.showUploadMode);
    renderBatchControls();
    const mode = $("#wfpu-choose-mode");
    if (mode) mode.value = state.settings.chooseMode;
    const photoOrder = $("#wfpu-photo-order");
    if (photoOrder) photoOrder.value = state.settings.photoOrder;
    const persist = $("#wfpu-persist");
    if (persist) persist.checked = !!state.settings.persistent;
    const columns = $("#wfpu-columns");
    const range = $("#wfpu-column-range");
    if (columns) columns.value = clamp(state.settings.gridColumns, 3, 10);
    if (range) range.value = clamp(state.settings.gridColumns, 3, 10);
    ensureCurrentUploadPhoto();
    renderPhotoTable();
  }

  function renderAll() {
    renderDrafts();
    renderQueue();
    renderUploadSection();
    renderPhotoPreview();
  }

  async function refreshDrafts() {
    const load = $("#wfpu-load-status");
    if (load) load.textContent = "Loading drafts...";
    try {
      await loadDrafts();
      if (load) load.textContent = "Loaded.";
      renderAll();
    } catch (err) {
      console.error(err);
      if (load) load.textContent = "Failed: " + err.message;
    }
  }

  function buildLeftPane(left) {
    const drafts = el("div", "wfpu-drafts");
    const toolbar = el("div", "wfpu-toolbar");
    toolbar.appendChild(makeButton("Refresh drafts", "", refreshDrafts));
    const search = el("input", "wfpu-search");
    search.type = "search";
    search.placeholder = "Search drafts...";
    search.addEventListener("input", () => { state.searchText = search.value; renderDrafts(); });
    toolbar.appendChild(search);
    const draftOrder = el("select", "wfpu-select");
    draftOrder.id = "wfpu-draft-order";
    [["newest", "Newest"], ["oldest", "Oldest"]].forEach(pair => {
      const opt = document.createElement("option");
      opt.value = pair[0];
      opt.textContent = pair[1];
      draftOrder.appendChild(opt);
    });
    draftOrder.value = state.settings.draftOrder;
    draftOrder.addEventListener("change", () => {
      state.settings.draftOrder = draftOrder.value;
      saveSettings();
      renderDrafts();
    });
    toolbar.append(el("span", "wfpu-meta", "Draft order"), draftOrder);
    toolbar.appendChild(makeToggle("Photo preview", state.settings.showDraftPreview, checked => {
      state.settings.showDraftPreview = checked;
      saveSettings();
      renderDrafts();
    }));
    toolbar.appendChild(makeToggle("0 photo only", state.settings.zeroPhotoOnly, checked => {
      state.settings.zeroPhotoOnly = checked;
      saveSettings();
      renderDrafts();
    }));
    toolbar.appendChild(makeToggle("Show hidden", state.settings.showHiddenDrafts, checked => {
      state.settings.showHiddenDrafts = checked;
      saveSettings();
      renderAll();
    }));
    drafts.appendChild(toolbar);
    const count = el("div", "wfpu-count");
    const draftCount = el("span", "", "0 draft(s)");
    draftCount.id = "wfpu-draft-count";
    const loadStatus = el("span", "", "Not loaded.");
    loadStatus.id = "wfpu-load-status";
    count.append(draftCount, document.createTextNode(" - "), loadStatus);
    drafts.appendChild(count);
    const list = el("div", "wfpu-draft-list");
    list.id = "wfpu-draft-list";
    drafts.appendChild(list);

    const queue = el("div", "wfpu-queue-panel");
    const qHead = el("div", "wfpu-panel-head");
    qHead.appendChild(el("div", "wfpu-panel-title", "Queue"));
    qHead.appendChild(makeButton("Start queue", "wfpu-primary", runQueue));
    qHead.appendChild(makeButton("Clear waiting", "", clearWaitingQueue));
    queue.appendChild(qHead);
    const qList = el("div", "wfpu-queue-list");
    qList.id = "wfpu-queue-list";
    queue.appendChild(qList);
    left.append(drafts, queue);
  }

  function buildRightPane(right) {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*,.heic,.heif";
    fileInput.multiple = true;
    fileInput.style.display = "none";
    fileInput.addEventListener("change", async () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = "";
      try { await importFiles(files); } catch (err) { console.error(err); setStatus("Import failed: " + err.message, "err"); }
    });

    const folderInput = document.createElement("input");
    folderInput.type = "file";
    folderInput.accept = "image/*,.heic,.heif";
    folderInput.multiple = true;
    folderInput.webkitdirectory = true;
    folderInput.setAttribute("webkitdirectory", "");
    folderInput.style.display = "none";
    folderInput.addEventListener("change", async () => {
      const files = Array.from(folderInput.files || []);
      folderInput.value = "";
      try { await importFiles(files); } catch (err) { console.error(err); setStatus("Import failed: " + err.message, "err"); }
    });
    right.append(fileInput, folderInput);

    const modebar = el("div", "wfpu-modebar");
    modebar.appendChild(el("div", "wfpu-panel-title", "Modes"));
    const uploadModeToggle = makeToggle("Upload mode", state.settings.showUploadMode, checked => {
      state.settings.showUploadMode = checked;
      saveSettings();
      renderUploadSection();
    });
    uploadModeToggle.querySelector("input").id = "wfpu-toggle-upload-mode";
    const previewModeToggle = makeToggle("Photo preview mode", state.settings.showPhotoPreview, checked => {
      state.settings.showPhotoPreview = checked;
      saveSettings();
      renderPhotoPreview();
    });
    previewModeToggle.querySelector("input").id = "wfpu-toggle-preview-mode";
    modebar.append(uploadModeToggle, previewModeToggle);
    right.appendChild(modebar);

    const upload = el("div", "wfpu-section wfpu-upload-section");
    upload.id = "wfpu-upload-section";
    const uHead = el("div", "wfpu-panel-head");
    uHead.appendChild(el("div", "wfpu-panel-title", "Upload Mode"));
    uHead.appendChild(el("span", "wfpu-meta", ""));
    uHead.lastChild.id = "wfpu-photo-count";
    const uBody = el("div", "wfpu-section-body");
    const controls = el("div", "wfpu-grid-controls");
    const batchSelect = el("select", "wfpu-select");
    batchSelect.id = "wfpu-batch-select";
    batchSelect.addEventListener("change", () => {
      state.settings.activeBatchId = batchSelect.value;
      saveSettings();
      renderUploadSection();
    });
    const batchName = el("input", "wfpu-input");
    batchName.id = "wfpu-batch-name";
    batchName.placeholder = "New batch";
    controls.append(batchSelect, batchName, makeButton("New batch", "", createBatch));
    controls.append(makeButton("Import photos", "wfpu-primary", () => fileInput.click()));
    controls.append(makeButton("Import folder", "", () => folderInput.click()));
    const persist = makeToggle("Persist table", state.settings.persistent, checked => setVisiblePersistence(checked));
    persist.querySelector("input").id = "wfpu-persist";
    controls.appendChild(persist);
    controls.appendChild(makeButton("Reset photo table", "wfpu-danger", resetPhotoTable));
    const mode = el("select", "wfpu-select");
    mode.id = "wfpu-choose-mode";
    [["nothing", "Nothing"], ["full-auto", "Full auto"], ["semi-auto", "Semi-auto"], ["manual", "Manual"]].forEach(pair => {
      const opt = document.createElement("option");
      opt.value = pair[0];
      opt.textContent = pair[1];
      mode.appendChild(opt);
    });
    mode.addEventListener("change", () => {
      state.settings.chooseMode = mode.value;
      saveSettings();
      renderPhotoTable();
    });
    controls.append(el("span", "wfpu-meta", "Mode"), mode);
    const photoOrder = el("select", "wfpu-select");
    photoOrder.id = "wfpu-photo-order";
    [["newest", "Newest"], ["oldest", "Oldest"]].forEach(pair => {
      const opt = document.createElement("option");
      opt.value = pair[0];
      opt.textContent = pair[1];
      photoOrder.appendChild(opt);
    });
    photoOrder.value = state.settings.photoOrder;
    photoOrder.addEventListener("change", () => {
      state.settings.photoOrder = photoOrder.value;
      saveSettings();
      sortPhotos();
      renderPhotoTable();
    });
    controls.append(el("span", "wfpu-meta", "Photo order"), photoOrder);
    const colInput = el("input", "wfpu-input");
    colInput.id = "wfpu-columns";
    colInput.type = "number";
    colInput.min = "3";
    colInput.max = "10";
    colInput.addEventListener("change", () => {
      state.settings.gridColumns = clamp(colInput.value, 3, 10);
      saveSettings();
      renderPhotoTable();
    });
    const colRange = el("input", "wfpu-range");
    colRange.id = "wfpu-column-range";
    colRange.type = "range";
    colRange.min = "3";
    colRange.max = "10";
    colRange.addEventListener("input", () => {
      state.settings.gridColumns = clamp(colRange.value, 3, 10);
      saveSettings();
      renderPhotoTable();
    });
    controls.append(el("span", "wfpu-meta", "Columns"), colInput, colRange);
    uBody.appendChild(controls);

    const split = el("div", "wfpu-upload-split");
    const table = el("div", "wfpu-photo-table");
    table.id = "wfpu-photo-table";
    const actions = el("div", "wfpu-actions");
    const choosePair = el("div", "wfpu-action-pair");
    choosePair.append(makeButton("Choose", "wfpu-primary", choosePhotos), makeButton("Skip Photo", "", skipCurrentPhoto));
    const draftPair = el("div", "wfpu-action-pair");
    draftPair.append(makeButton("Next Draft", "wfpu-primary", queueActiveAssignment), makeButton("Skip Draft", "", skipActiveDraft));
    const imagePair = el("div", "wfpu-action-pair");
    imagePair.append(makeButton("Clear assignment", "", clearActiveAssignment), makeButton("Delete image", "wfpu-danger", deleteCurrentImage));
    actions.append(choosePair, draftPair, imagePair);
    split.append(table, actions);
    uBody.appendChild(split);
    upload.append(uHead, uBody);

    const preview = el("div", "wfpu-section wfpu-preview-section");
    preview.id = "wfpu-preview-section";
    const pHead = el("div", "wfpu-panel-head");
    pHead.appendChild(el("div", "wfpu-panel-title", "Photo Preview"));
    const pBody = el("div", "wfpu-section-body");
    pBody.id = "wfpu-preview-body";
    preview.append(pHead, pBody);

    right.append(upload, preview);
  }

  async function openUploader() {
    injectCss();
    const old = document.getElementById("wfpu-modal");
    if (old) old.remove();

    const backdrop = el("div", "wfpu-backdrop");
    backdrop.id = "wfpu-modal";
    const dialog = el("div", "wfpu-dialog");
    backdrop.appendChild(dialog);
    const head = el("div", "wfpu-head");
    head.appendChild(el("div", "wfpu-title", "Photo Upload"));
    const close = el("button", "wfpu-x", "x");
    close.type = "button";
    close.addEventListener("click", () => backdrop.remove());
    head.appendChild(close);
    dialog.appendChild(head);

    const shell = el("div", "wfpu-shell");
    const left = el("div", "wfpu-left");
    const right = el("div", "wfpu-right");
    buildLeftPane(left);
    buildRightPane(right);
    shell.append(left, right);
    dialog.appendChild(shell);
    const footer = el("div", "wfpu-footer-status");
    const status = el("div", "wfpu-status", "Ready.");
    status.id = "wfpu-status";
    footer.appendChild(status);
    dialog.appendChild(footer);

    backdrop.addEventListener("click", ev => { if (ev.target === backdrop) backdrop.remove(); });
    document.body.appendChild(backdrop);
    try {
      await initStorage();
      renderAll();
      refreshDrafts();
    } catch (err) {
      console.error(err);
      setStatus("Storage failed: " + err.message, "err");
    }
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
