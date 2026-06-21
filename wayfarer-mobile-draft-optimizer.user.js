// ==UserScript==
// @name         Wayfarer Mobile Draft Optimizer
// @namespace    https://wayfarer.nianticlabs.com/
// @version      0.1.0
// @description  Mobile-only quick remote draft saver and lightweight map data saver for Wayfarer.
// @author       TrungLatias
// @match        https://wayfarer.nianticlabs.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Trungx5/wayfarer-addons/Trungx5/wayfarer-mobile-draft-optimizer.user.js
// @downloadURL  https://raw.githubusercontent.com/Trungx5/wayfarer-addons/Trungx5/wayfarer-mobile-draft-optimizer.user.js
// ==/UserScript==

(function () {
  "use strict";

  const VERSION = "0.1.0";
  const SETTINGS_KEY = "wfmds-settings";
  const MAX_SUPPORTING = 5;
  const MAP_POI_THROTTLE_MS = 30000;

  const DEFAULT_SETTINGS = {
    dataSaver: true,
    blockPoiImages: true,
    throttleMapPoiData: true,
    blockMapPoiData: false,
    autoPlaceholder: true,
    draftOrder: "newest"
  };

  const state = {
    settings: loadSettings(),
    drafts: [],
    activeDraftId: null,
    lastCoords: null,
    userLoc: null,
    loading: false,
    saving: false,
    lastAllowedByKind: Object.create(null),
    blocked: Object.create(null),
    ui: Object.create(null),
    routeTimer: null,
    observer: null
  };

  patchNetworkSaver();
  window.addEventListener("wf:submit-coords", handleSubmitCoords, true);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      return Object.assign({}, DEFAULT_SETTINGS, saved || {});
    } catch (_) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch (err) {
      console.warn("[WF Mobile Draft] Could not save settings", err);
    }
  }

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function $all(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function cleanText(value, fallback = "") {
    const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    return text || fallback;
  }

  function normArray(value) {
    return Array.isArray(value) ? value.filter(Boolean) : [];
  }

  function isValidLatLng(lat, lng) {
    return typeof lat === "number" && typeof lng === "number" &&
      Number.isFinite(lat) && Number.isFinite(lng) &&
      lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  }

  function formatCoords(coords) {
    if (!coords || !isValidLatLng(coords.lat, coords.lng)) return "No pin";
    return coords.lat.toFixed(6) + ", " + coords.lng.toFixed(6);
  }

  function parseCoordsText(text) {
    const match = String(text || "").match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (!match) return null;
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    return isValidLatLng(lat, lng) ? { lat, lng } : null;
  }

  function isMobileContext() {
    if (window.wfmapmodsMapMode === "mobile") return true;
    if (document.querySelector(".nia-map__center-img-overlay")) return true;
    if (document.querySelector("app-poi-detail-panel .poi-panel.mobile")) return true;

    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches;
    const narrow = window.matchMedia?.("(max-width: 820px)")?.matches;
    return !!(coarse && narrow);
  }

  function isAllowedRoute() {
    const path = location.pathname || "";
    return path.includes("/new/submit/new") || path.includes("/new/mapview");
  }

  function isMapviewRoute() {
    return (location.pathname || "").includes("/new/mapview");
  }

  function endpointKind(url) {
    let path = "";
    try {
      path = new URL(String(url), location.href).pathname;
    } catch (_) {
      path = String(url || "");
    }

    if (path.includes("/api/v1/vault/mapview/poi-images")) return "poi-images";
    if (path.includes("/api/v1/vault/mapview/lowzoom/gcs")) return "lowzoom-gcs";
    if (path.includes("/api/v1/vault/mapview/gcs")) return "gcs";
    if (path.includes("/api/v1/vault/live-pois-in-radius")) return "live-pois";
    return "";
  }

  function shouldBlockRequest(url) {
    const kind = endpointKind(url);
    if (!kind) return false;
    if (!state.settings.dataSaver || !isMobileContext()) return false;

    if (kind === "poi-images") {
      return !!state.settings.blockPoiImages;
    }

    if (state.settings.blockMapPoiData && (kind === "gcs" || kind === "lowzoom-gcs" || kind === "live-pois")) {
      return true;
    }

    if (state.settings.throttleMapPoiData && isMapviewRoute() && (kind === "gcs" || kind === "lowzoom-gcs")) {
      const now = Date.now();
      const last = state.lastAllowedByKind[kind] || 0;
      if (now - last < MAP_POI_THROTTLE_MS) return true;
      state.lastAllowedByKind[kind] = now;
    }

    return false;
  }

  function noteBlocked(url) {
    const kind = endpointKind(url) || "request";
    state.blocked[kind] = (state.blocked[kind] || 0) + 1;
    updateNetworkStats();
  }

  function emptyResponseFor(url) {
    const kind = endpointKind(url);
    let body = { code: "OK", result: {} };
    if (kind === "poi-images") body = { code: "OK", result: { images: [] } };
    if (kind === "gcs" || kind === "lowzoom-gcs") body = { code: "OK", result: { success: true, data: [] } };
    if (kind === "live-pois") body = { code: "OK", result: { pois: [] } };

    return new Response(JSON.stringify(body), {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "application/json;charset=UTF-8" }
    });
  }

  function patchNetworkSaver() {
    const XHR = window.XMLHttpRequest;
    if (XHR && !XHR.prototype.__wfmdsPatched) {
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;

      XHR.prototype.open = function (method, url) {
        try {
          this.__wfmdsUrl = url;
        } catch (_) {}
        return origOpen.apply(this, arguments);
      };

      XHR.prototype.send = function () {
        const url = this.__wfmdsUrl || "";
        if (shouldBlockRequest(url)) {
          noteBlocked(url);
          setTimeout(() => {
            try {
              this.dispatchEvent(new ProgressEvent("error"));
              this.dispatchEvent(new ProgressEvent("loadend"));
            } catch (_) {}
          }, 0);
          try {
            this.abort();
          } catch (_) {}
          return;
        }
        return origSend.apply(this, arguments);
      };

      XHR.prototype.__wfmdsPatched = true;
    }

    if (window.fetch && !window.fetch.__wfmdsPatched) {
      const origFetch = window.fetch;
      const patched = function (input, init) {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (shouldBlockRequest(url)) {
          noteBlocked(url);
          return Promise.resolve(emptyResponseFor(url));
        }
        return origFetch.apply(this, arguments);
      };
      patched.__wfmdsPatched = true;
      window.fetch = patched;
    }
  }

  function boot() {
    injectCss();
    ensureFab();
    startRouteObserver();
    window.addEventListener("resize", scheduleEnsureFab, { passive: true });
  }

  function scheduleEnsureFab() {
    clearTimeout(state.routeTimer);
    state.routeTimer = setTimeout(ensureFab, 150);
  }

  function startRouteObserver() {
    if (state.observer || !document.body) return;
    let lastUrl = location.href;
    state.observer = new MutationObserver(() => {
      if (location.href === lastUrl) {
        ensureFab();
        return;
      }
      lastUrl = location.href;
      ensureFab();
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  function injectCss() {
    if (document.getElementById("wfmds-css")) return;
    const style = document.createElement("style");
    style.id = "wfmds-css";
    style.textContent = `
#wfmds-fab {
  position: fixed;
  right: max(12px, env(safe-area-inset-right));
  bottom: max(18px, calc(env(safe-area-inset-bottom) + 14px));
  z-index: 2147483000;
  min-width: 64px;
  height: 48px;
  border: 0;
  border-radius: 8px;
  background: #111827;
  color: #ffffff;
  box-shadow: 0 10px 24px rgba(15, 23, 42, .26);
  font: 700 14px/1 Roboto, Arial, sans-serif;
  letter-spacing: 0;
  padding: 0 14px;
}

#wfmds-fab:active {
  transform: translateY(1px);
}

#wfmds-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2147483001;
  background: rgba(15, 23, 42, .35);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  font-family: Roboto, Arial, sans-serif;
}

#wfmds-sheet {
  width: min(100vw, 620px);
  max-height: min(86vh, 720px);
  padding-bottom: max(12px, env(safe-area-inset-bottom));
  background: #f8fafc;
  color: #111827;
  border-radius: 8px 8px 0 0;
  box-shadow: 0 -20px 46px rgba(15, 23, 42, .28);
  display: grid;
  grid-template-rows: auto auto auto auto auto minmax(180px, 1fr);
  overflow: hidden;
}

.wfmds-head,
.wfmds-actions,
.wfmds-row,
.wfmds-toolbar,
.wfmds-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wfmds-head {
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid #dbe3ef;
  background: #ffffff;
}

.wfmds-title {
  font-weight: 800;
  font-size: 15px;
}

.wfmds-version {
  color: #64748b;
  font-weight: 500;
  font-size: 11px;
  margin-left: 6px;
}

.wfmds-close,
.wfmds-btn {
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: #ffffff;
  color: #111827;
  min-height: 36px;
  padding: 0 10px;
  font: 700 13px/1 Roboto, Arial, sans-serif;
}

.wfmds-btn:disabled,
.wfmds-close:disabled {
  opacity: .58;
}

.wfmds-primary {
  background: #0f766e;
  border-color: #0f766e;
  color: #ffffff;
}

.wfmds-danger {
  color: #991b1b;
}

.wfmds-body {
  padding: 10px 14px 12px;
  display: grid;
  gap: 10px;
  border-bottom: 1px solid #dbe3ef;
  background: #f8fafc;
}

.wfmds-row {
  min-width: 0;
}

.wfmds-coords {
  flex: 1 1 auto;
  min-width: 0;
  color: #334155;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wfmds-input {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  height: 42px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: #ffffff;
  color: #111827;
  padding: 0 10px;
  font: 700 15px/1.2 Roboto, Arial, sans-serif;
  letter-spacing: 0;
}

.wfmds-actions .wfmds-btn {
  flex: 1 1 0;
}

.wfmds-status {
  min-height: 18px;
  color: #64748b;
  font-size: 12px;
  line-height: 1.35;
}

.wfmds-status.ok {
  color: #166534;
  font-weight: 700;
}

.wfmds-status.err {
  color: #b91c1c;
  font-weight: 700;
}

.wfmds-settings {
  padding: 9px 14px;
  border-bottom: 1px solid #dbe3ef;
  background: #ffffff;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
}

.wfmds-toggle {
  min-height: 34px;
  color: #334155;
  font-size: 12px;
  user-select: none;
}

.wfmds-toggle input {
  width: 18px;
  height: 18px;
}

.wfmds-toolbar {
  justify-content: space-between;
  padding: 9px 14px;
  border-bottom: 1px solid #dbe3ef;
  background: #f8fafc;
}

.wfmds-count,
.wfmds-net {
  color: #64748b;
  font-size: 12px;
}

.wfmds-list {
  min-height: 0;
  overflow: auto;
  padding: 8px 14px 14px;
  display: grid;
  gap: 7px;
}

.wfmds-draft {
  border: 1px solid #dbe3ef;
  border-radius: 7px;
  background: #ffffff;
  color: #111827;
  min-height: 58px;
  padding: 8px 10px;
  text-align: left;
  display: grid;
  gap: 4px;
}

.wfmds-draft.active {
  border-color: #0f766e;
  box-shadow: 0 0 0 2px rgba(15, 118, 110, .16);
}

.wfmds-draft-title {
  font-size: 13px;
  font-weight: 800;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wfmds-draft-meta {
  color: #64748b;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wfmds-empty {
  color: #64748b;
  font-size: 13px;
  padding: 16px 0;
  text-align: center;
}

@media (min-width: 680px) {
  #wfmds-sheet {
    border-radius: 8px;
    margin-bottom: 18px;
  }
}
`;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureFab() {
    const existing = document.getElementById("wfmds-fab");
    if (!isAllowedRoute() || !isMobileContext()) {
      if (existing) existing.remove();
      return;
    }

    if (existing) return;
    const button = el("button", "", "Draft");
    button.id = "wfmds-fab";
    button.type = "button";
    button.title = "Mobile draft";
    button.addEventListener("click", openPanel);
    document.body.appendChild(button);
  }

  function openPanel() {
    if (document.getElementById("wfmds-backdrop")) return;

    captureCurrentCoords();

    const backdrop = el("div");
    backdrop.id = "wfmds-backdrop";
    backdrop.addEventListener("click", (ev) => {
      if (ev.target === backdrop) closePanel();
    });

    const sheet = el("section");
    sheet.id = "wfmds-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");

    const head = el("div", "wfmds-head");
    const titleWrap = el("div");
    titleWrap.append(el("span", "wfmds-title", "Mobile Draft"), el("span", "wfmds-version", "v" + VERSION));
    const close = el("button", "wfmds-close", "Close");
    close.type = "button";
    close.addEventListener("click", closePanel);
    head.append(titleWrap, close);

    const body = el("div", "wfmds-body");
    const coordRow = el("div", "wfmds-row");
    const coords = el("div", "wfmds-coords");
    const pinBtn = makeButton("Pin", "", () => {
      captureCurrentCoords();
      setStatus("Pin refreshed.", "ok");
    });
    coordRow.append(coords, pinBtn);

    const inputRow = el("div", "wfmds-row");
    const input = el("input", "wfmds-input");
    input.type = "text";
    input.maxLength = 128;
    input.autocomplete = "off";
    input.placeholder = "Name";
    if (state.settings.autoPlaceholder) input.value = makePlaceholderName();
    const quickBtn = makeButton("Now", "", () => {
      input.value = makePlaceholderName();
      input.focus();
      input.select();
    });
    inputRow.append(input, quickBtn);

    const actions = el("div", "wfmds-actions");
    const newBtn = makeButton("Save draft", "wfmds-primary", saveNewDraftFromUi);
    const updateBtn = makeButton("Save title", "", saveSelectedTitleFromUi);
    actions.append(newBtn, updateBtn);

    const status = el("div", "wfmds-status");
    body.append(coordRow, inputRow, actions, status);

    const settings = el("div", "wfmds-settings");
    settings.append(
      makeToggle("Data saver", "dataSaver"),
      makeToggle("No galleries", "blockPoiImages"),
      makeToggle("Throttle POI", "throttleMapPoiData"),
      makeToggle("POI API off", "blockMapPoiData")
    );

    const toolbar = el("div", "wfmds-toolbar");
    const count = el("div", "wfmds-count", "0 drafts");
    const toolActions = el("div", "wfmds-actions");
    const refresh = makeButton("Refresh", "", refreshDrafts);
    const order = makeButton(state.settings.draftOrder === "oldest" ? "Oldest" : "Newest", "", () => {
      state.settings.draftOrder = state.settings.draftOrder === "oldest" ? "newest" : "oldest";
      order.textContent = state.settings.draftOrder === "oldest" ? "Oldest" : "Newest";
      saveSettings();
      sortDrafts();
      renderDrafts();
    });
    toolActions.append(order, refresh);
    toolbar.append(count, toolActions);

    const net = el("div", "wfmds-net");
    const list = el("div", "wfmds-list");

    sheet.append(head, body, settings, toolbar, net, list);
    backdrop.appendChild(sheet);
    document.body.appendChild(backdrop);

    state.ui = { backdrop, sheet, coords, input, status, count, list, net, newBtn, updateBtn, refresh };
    updateCoordsUi();
    updateNetworkStats();
    renderDrafts();
    refreshDrafts();

    setTimeout(() => input.focus(), 80);
  }

  function closePanel() {
    const panel = document.getElementById("wfmds-backdrop");
    if (panel) panel.remove();
    state.ui = Object.create(null);
  }

  function makeButton(text, extraClass, onClick) {
    const button = el("button", "wfmds-btn" + (extraClass ? " " + extraClass : ""), text);
    button.type = "button";
    button.addEventListener("click", onClick);
    return button;
  }

  function makeToggle(label, key) {
    const wrap = el("label", "wfmds-toggle");
    const input = el("input");
    input.type = "checkbox";
    input.checked = !!state.settings[key];
    input.addEventListener("change", () => {
      state.settings[key] = !!input.checked;
      saveSettings();
      updateNetworkStats();
    });
    wrap.append(input, el("span", "", label));
    return wrap;
  }

  function setBusy(busy) {
    state.loading = !!busy;
    if (state.ui.refresh) state.ui.refresh.disabled = busy || state.saving;
    if (state.ui.newBtn) state.ui.newBtn.disabled = busy || state.saving;
    if (state.ui.updateBtn) state.ui.updateBtn.disabled = busy || state.saving || !state.activeDraftId;
  }

  function setStatus(message, type) {
    if (!state.ui.status) return;
    state.ui.status.textContent = message || "";
    state.ui.status.className = "wfmds-status" + (type ? " " + type : "");
  }

  function updateCoordsUi() {
    captureCurrentCoords();
    if (state.ui.coords) state.ui.coords.textContent = formatCoords(state.lastCoords);
  }

  function updateNetworkStats() {
    if (!state.ui.net) return;
    const parts = Object.keys(state.blocked)
      .sort()
      .map(key => key + ": " + state.blocked[key]);
    const mode = state.settings.dataSaver ? "Saver on" : "Saver off";
    state.ui.net.textContent = parts.length ? mode + " - blocked " + parts.join(", ") : mode;
  }

  function handleSubmitCoords(ev) {
    const detail = ev && ev.detail;
    const lat = Number(detail && detail.lat);
    const lng = Number(detail && detail.lng);
    if (isValidLatLng(lat, lng)) {
      state.lastCoords = { lat, lng };
      updateCoordsUi();
    }
  }

  function captureCurrentCoords() {
    const lat = Number(window.currentLat);
    const lng = Number(window.currentLng);
    if (isValidLatLng(lat, lng)) {
      state.lastCoords = { lat, lng };
      return state.lastCoords;
    }

    const coordEl = $(".submit-coordinates-text") ||
      $(".wfmapmods-submit-location-value") ||
      $(".text-gray-400.text-xs");
    const parsed = parseCoordsText(coordEl && coordEl.textContent);
    if (parsed) state.lastCoords = parsed;
    return state.lastCoords;
  }

  function makePlaceholderName() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const coords = captureCurrentCoords();
    if (!coords) return "Draft " + hh + mm;
    return "Draft " + hh + mm + " " + coords.lat.toFixed(5) + "," + coords.lng.toFixed(5);
  }

  function getCookie(name) {
    const prefix = name + "=";
    return (document.cookie || "")
      .split(";")
      .map(part => part.trim())
      .find(part => part.startsWith(prefix))
      ?.slice(prefix.length) || "";
  }

  function csrfToken() {
    return decodeURIComponent(getCookie("XSRF-TOKEN") || "");
  }

  function getJson(url) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.withCredentials = true;
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error("HTTP " + xhr.status + " for " + url));
          return;
        }
        try {
          resolve(JSON.parse(xhr.responseText || "{}"));
        } catch (err) {
          reject(err);
        }
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
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error("HTTP " + xhr.status + ": " + (xhr.responseText || url)));
          return;
        }
        try {
          resolve(JSON.parse(xhr.responseText || "{}"));
        } catch (err) {
          reject(err);
        }
      };
      xhr.onerror = () => reject(new Error("Network error for " + url));
      xhr.send(JSON.stringify(body == null ? {} : body));
    });
  }

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
      title: cleanText(poi.title ?? raw.title, "Untitled draft"),
      description: cleanText(poi.description ?? raw.description),
      supportingStatement: cleanText(poi.supportingStatement ?? raw.supportingStatement),
      lastModified: Number(raw.lastModified || raw.lastModifiedMs || 0),
      mainImageGcsPath: raw.mainImageGcsPath || images.main?.gcsPath || null,
      mainImageServingUrl: raw.mainImageServingUrl || images.main?.servingUrl || images.main?.url || null,
      supportingImageGcsPaths: normArray(raw.supportingImageGcsPaths || images.supporting?.map(x => x && x.gcsPath)),
      supportingImageServingUrls: normArray(raw.supportingImageServingUrls || images.supporting?.map(x => x && (x.servingUrl || x.url))),
      raw
    };
  }

  function sortDrafts() {
    const dir = state.settings.draftOrder === "oldest" ? 1 : -1;
    state.drafts.sort((a, b) => {
      const ma = Number(a.lastModified || 0);
      const mb = Number(b.lastModified || 0);
      if (ma !== mb) return (ma - mb) * dir;
      return String(a.title || "").localeCompare(String(b.title || "")) * dir;
    });
  }

  async function loadDrafts() {
    const all = [];
    let cursor = null;
    let guard = 0;

    do {
      let url = "/api/v1/vault/submit/get/drafts";
      if (cursor) url += "?cursor=" + encodeURIComponent(cursor);
      const resp = await getJson(url);
      if (!resp || resp.captcha) throw new Error("Draft list requires captcha/login.");

      const result = resp.result || {};
      const items = Array.isArray(result.result) ? result.result : (Array.isArray(result) ? result : []);
      items.forEach(item => {
        const draft = normalizeDraft(item);
        if (draft) all.push(draft);
      });

      const next = result.cursor || null;
      cursor = next && next !== cursor ? next : null;
      guard++;
    } while (cursor && guard < 50);

    state.drafts = all;
    sortDrafts();

    if (state.activeDraftId && !state.drafts.some(d => d.id === state.activeDraftId)) {
      state.activeDraftId = null;
    }

    return state.drafts;
  }

  async function refreshDrafts() {
    if (state.loading || state.saving) return;
    setBusy(true);
    setStatus("Loading drafts...");
    try {
      await loadDrafts();
      renderDrafts();
      setStatus("Loaded " + state.drafts.length + " draft(s).", "ok");
    } catch (err) {
      console.error("[WF Mobile Draft] Draft load failed", err);
      renderDrafts();
      setStatus(err?.message || "Could not load drafts.", "err");
    } finally {
      setBusy(false);
    }
  }

  function renderDrafts() {
    const list = state.ui.list;
    if (!list) return;
    list.innerHTML = "";
    if (state.ui.count) state.ui.count.textContent = state.drafts.length + " draft(s)";

    if (!state.drafts.length) {
      list.appendChild(el("div", "wfmds-empty", state.loading ? "Loading drafts..." : "No drafts loaded."));
      setBusy(state.loading);
      return;
    }

    state.drafts.forEach(draft => {
      const row = el("button", "wfmds-draft" + (draft.id === state.activeDraftId ? " active" : ""));
      row.type = "button";
      const title = el("div", "wfmds-draft-title", draft.title || "Untitled draft");
      const meta = el("div", "wfmds-draft-meta", formatCoords(draft) + " - " + formatDraftTime(draft.lastModified));
      row.append(title, meta);
      row.addEventListener("click", () => {
        state.activeDraftId = draft.id;
        if (state.ui.input) {
          state.ui.input.value = draft.title || "";
          state.ui.input.focus();
          state.ui.input.select();
        }
        renderDrafts();
      });
      list.appendChild(row);
    });

    setBusy(state.loading);
  }

  function formatDraftTime(ms) {
    const n = Number(ms || 0);
    if (!Number.isFinite(n) || n <= 0) return "No date";
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return "No date";
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function findDraft(id) {
    return state.drafts.find(d => d.id === id) || null;
  }

  async function getUserLocation(fallbackCoords) {
    if (state.userLoc) return state.userLoc;

    const fallback = {
      userLat: isValidLatLng(fallbackCoords?.lat, fallbackCoords?.lng) ? fallbackCoords.lat : 0,
      userLng: isValidLatLng(fallbackCoords?.lat, fallbackCoords?.lng) ? fallbackCoords.lng : 0
    };

    if (!navigator.geolocation) return fallback;

    return new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        pos => {
          state.userLoc = {
            userLat: pos.coords.latitude,
            userLng: pos.coords.longitude
          };
          resolve(state.userLoc);
        },
        () => resolve(fallback),
        { enableHighAccuracy: false, timeout: 3000, maximumAge: 300000 }
      );
    });
  }

  async function createDraftShell() {
    const resp = await postJson("/api/v1/vault/submit/draft/create", {});
    if (!resp || resp.captcha) throw new Error("Draft create requires captcha/login.");
    const id = resp?.result?.submissionId || null;
    if (!id) throw new Error("Draft create did not return an id.");
    return id;
  }

  async function postDraftPayload(payload, coords) {
    const loc = await getUserLocation(coords);
    const url = "/api/v1/vault/submit/draft?userLat=" + encodeURIComponent(loc.userLat) +
      "&userLng=" + encodeURIComponent(loc.userLng);
    const resp = await postJson(url, payload);
    if (!resp || resp.captcha) throw new Error("Draft save requires captcha/login.");
    const saved = resp.result && (resp.result.poiSubmissionDraft || resp.result.draft || resp.result);
    const normalized = normalizeDraft(saved);
    if (!normalized) throw new Error("Draft save did not return a valid draft.");
    return normalized;
  }

  async function saveNewDraftFromUi() {
    if (state.saving) return;
    const coords = captureCurrentCoords();
    if (!coords || !isValidLatLng(coords.lat, coords.lng)) {
      setStatus("Missing pin coordinates.", "err");
      return;
    }

    const title = cleanText(state.ui.input?.value, state.settings.autoPlaceholder ? makePlaceholderName() : "");
    if (!title) {
      setStatus("Name is required.", "err");
      return;
    }

    state.saving = true;
    setBusy(true);
    setStatus("Creating draft...");
    try {
      const id = await createDraftShell();
      const saved = await postDraftPayload({
        id,
        lat: coords.lat,
        lng: coords.lng,
        title,
        description: "",
        supportingStatement: ""
      }, coords);
      upsertDraft(saved);
      state.activeDraftId = saved.id;
      renderDrafts();
      setStatus("Draft saved.", "ok");
      if (state.ui.input && state.settings.autoPlaceholder) state.ui.input.value = makePlaceholderName();
    } catch (err) {
      console.error("[WF Mobile Draft] Save draft failed", err);
      setStatus(err?.message || "Could not save draft.", "err");
    } finally {
      state.saving = false;
      setBusy(false);
    }
  }

  async function saveSelectedTitleFromUi() {
    if (state.saving) return;
    const draft = findDraft(state.activeDraftId);
    if (!draft) {
      setStatus("Choose a draft first.", "err");
      return;
    }

    const title = cleanText(state.ui.input?.value);
    if (!title) {
      setStatus("Name is required.", "err");
      return;
    }

    const coords = {
      lat: draft.lat,
      lng: draft.lng
    };

    const payload = {
      id: draft.id,
      lat: draft.lat,
      lng: draft.lng,
      title,
      description: draft.description || "",
      supportingStatement: draft.supportingStatement || ""
    };

    if (draft.mainImageGcsPath) {
      payload.mainImageGcsPath = draft.mainImageGcsPath;
      if (draft.mainImageServingUrl) payload.mainImageServingUrl = draft.mainImageServingUrl;
    } else if (draft.mainImageServingUrl) {
      setStatus("This draft is missing image path data. Refresh it first.", "err");
      return;
    }

    if (draft.supportingImageGcsPaths.length) {
      payload.supportingImageGcsPaths = draft.supportingImageGcsPaths.slice(0, MAX_SUPPORTING);
    } else if (draft.supportingImageServingUrls.length) {
      setStatus("This draft is missing supporting image path data. Refresh it first.", "err");
      return;
    }

    if (draft.supportingImageServingUrls.length) {
      payload.supportingImageServingUrls = draft.supportingImageServingUrls.slice(0, MAX_SUPPORTING);
    }

    state.saving = true;
    setBusy(true);
    setStatus("Saving title...");
    try {
      const saved = await postDraftPayload(payload, coords);
      upsertDraft(saved);
      state.activeDraftId = saved.id;
      renderDrafts();
      setStatus("Title saved.", "ok");
    } catch (err) {
      console.error("[WF Mobile Draft] Save title failed", err);
      setStatus(err?.message || "Could not save title.", "err");
    } finally {
      state.saving = false;
      setBusy(false);
    }
  }

  function upsertDraft(draft) {
    const idx = state.drafts.findIndex(d => d.id === draft.id);
    if (idx >= 0) state.drafts[idx] = draft;
    else state.drafts.unshift(draft);
    sortDrafts();
  }
})();
