// ==UserScript==
// @name         Wayfarer Mobile Draft Optimizer
// @namespace    https://wayfarer.nianticlabs.com/
// @version      0.2.0
// @description  Mobile-only quick Draft button that opens the Base draft modal in title-only mode.
// @author       TrungLatias
// @match        https://wayfarer.nianticlabs.com/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Trungx5/wayfarer-addons/Trungx5/wayfarer-mobile-draft-optimizer.user.js
// @downloadURL  https://raw.githubusercontent.com/Trungx5/wayfarer-addons/Trungx5/wayfarer-mobile-draft-optimizer.user.js
// ==/UserScript==

(function () {
  "use strict";

  const VERSION = "0.2.0";
  const SETTINGS_KEY = "wfqd-settings";
  const SUBMIT_BRIDGE_ID = "wfmapmods-submit-bridge";
  const QUICK_WINDOW_MS = 7000;

  const DEFAULT_SETTINGS = {
    quickEnabled: true,
    dataSaver: true
  };

  const state = {
    settings: loadSettings(),
    observer: null,
    quickUntil: 0,
    saveClicksBound: false,
    blockedGalleries: 0,
    uiTimer: null
  };

  patchGalleryDataSaver();

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
      console.warn("[WF Quick Draft] Could not save settings", err);
    }
  }

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function text(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function isValidLatLng(lat, lng) {
    return typeof lat === "number" && typeof lng === "number" &&
      Number.isFinite(lat) && Number.isFinite(lng) &&
      lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  }

  function isMobileContext() {
    if (window.wfmapmodsMapMode === "mobile") return true;
    if (document.querySelector(".nia-map__center-img-overlay")) return true;
    if (document.querySelector("app-poi-detail-panel .poi-panel.mobile")) return true;

    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches;
    const narrow = window.matchMedia?.("(max-width: 820px)")?.matches;
    return !!(coarse && narrow);
  }

  function isMapRoute() {
    const path = location.pathname || "";
    return path.includes("/new/mapview") || path.includes("/new/submit/new");
  }

  function parseCoordsText(value) {
    const match = String(value || "").match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (!match) return null;
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    return isValidLatLng(lat, lng) ? { lat, lng } : null;
  }

  function getCurrentCoords() {
    const lat = Number(window.currentLat);
    const lng = Number(window.currentLng);
    if (isValidLatLng(lat, lng)) return { lat, lng };

    const coordEl = $(".submit-coordinates-text") ||
      $(".wfmapmods-submit-location-value") ||
      $(".text-gray-400.text-xs");
    return parseCoordsText(coordEl && coordEl.textContent);
  }

  function galleryEndpoint(url) {
    try {
      return new URL(String(url), location.href).pathname.includes("/api/v1/vault/mapview/poi-images");
    } catch (_) {
      return String(url || "").includes("/api/v1/vault/mapview/poi-images");
    }
  }

  function shouldBlockGallery(url) {
    return !!state.settings.dataSaver && isMobileContext() && galleryEndpoint(url);
  }

  function fakeGalleryResponse() {
    return JSON.stringify({ code: "OK", result: { images: [] } });
  }

  function noteBlockedGallery() {
    state.blockedGalleries += 1;
    updateSidebarToggle();
  }

  function patchGalleryDataSaver() {
    const XHR = window.XMLHttpRequest;
    if (XHR && !XHR.prototype.__wfqdPatched) {
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;

      XHR.prototype.open = function (method, url) {
        try {
          this.__wfqdUrl = url;
        } catch (_) {}
        return origOpen.apply(this, arguments);
      };

      XHR.prototype.send = function () {
        const url = this.__wfqdUrl || "";
        if (!shouldBlockGallery(url)) {
          return origSend.apply(this, arguments);
        }

        noteBlockedGallery();
        const body = fakeGalleryResponse();
        try {
          Object.defineProperty(this, "readyState", { configurable: true, get: () => 4 });
          Object.defineProperty(this, "status", { configurable: true, get: () => 200 });
          Object.defineProperty(this, "statusText", { configurable: true, get: () => "OK" });
          Object.defineProperty(this, "responseText", { configurable: true, get: () => body });
          Object.defineProperty(this, "response", { configurable: true, get: () => body });
        } catch (_) {}

        setTimeout(() => {
          try {
            const loadEvent = new ProgressEvent("load");
            if (typeof this.onload === "function") this.onload(loadEvent);
            this.dispatchEvent(loadEvent);
            this.dispatchEvent(new ProgressEvent("loadend"));
          } catch (_) {}
        }, 0);
        return undefined;
      };

      XHR.prototype.__wfqdPatched = true;
    }

    if (window.fetch && !window.fetch.__wfqdPatched) {
      const origFetch = window.fetch;
      const patched = function (input) {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (shouldBlockGallery(url)) {
          noteBlockedGallery();
          return Promise.resolve(new Response(fakeGalleryResponse(), {
            status: 200,
            statusText: "OK",
            headers: { "Content-Type": "application/json;charset=UTF-8" }
          }));
        }
        return origFetch.apply(this, arguments);
      };
      patched.__wfqdPatched = true;
      window.fetch = patched;
    }
  }

  function boot() {
    injectCss();
    ensureControls();
    bindSaveClickClose();

    if (!state.observer && document.body) {
      state.observer = new MutationObserver(scheduleEnsureControls);
      state.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style"]
      });
    }

    window.addEventListener("resize", scheduleEnsureControls, { passive: true });
    window.addEventListener("popstate", scheduleEnsureControls);
  }

  function scheduleEnsureControls() {
    clearTimeout(state.uiTimer);
    state.uiTimer = setTimeout(ensureControls, 80);
  }

  function injectCss() {
    if (document.getElementById("wfqd-css")) return;

    const style = document.createElement("style");
    style.id = "wfqd-css";
    style.textContent = `
#wfqd-button {
  position: fixed;
  right: max(12px, env(safe-area-inset-right));
  bottom: max(18px, calc(env(safe-area-inset-bottom) + 14px));
  z-index: 2147483000;
  min-width: 66px;
  height: 46px;
  border: 0;
  border-radius: 8px;
  background: #111827;
  color: #ffffff;
  box-shadow: 0 10px 24px rgba(15, 23, 42, .28);
  font: 800 14px/1 Roboto, Arial, sans-serif;
  letter-spacing: 0;
  padding: 0 14px;
}

#wfqd-button:active {
  transform: translateY(1px);
}

#wfqd-sidebar-toggle {
  cursor: pointer;
}

#wfqd-sidebar-toggle.wfqd-off {
  opacity: .72;
}

#wfqd-sidebar-toggle.wfqd-active {
  font-weight: 700;
}

#wfmapmods-submission-edit.wfqd-quick-modal .wfmapmods-submit-images,
#wfmapmods-submission-edit.wfqd-quick-modal .wfmapmods-submit-location,
#wfmapmods-submission-edit.wfqd-quick-modal .wfmapmods-submit-warning,
#wfmapmods-submission-edit.wfqd-quick-modal .wfmapmods-modal-intro,
#wfmapmods-submission-edit.wfqd-quick-modal .wfmapmods-submit-field:not(.wfqd-title-field),
#wfmapmods-submission-edit.wfqd-quick-modal .wfmapmods-modal-btn-primary {
  display: none !important;
}

#wfmapmods-submission-edit.wfqd-quick-modal .wfmapmods-submit-wrap {
  display: block !important;
}

#wfmapmods-submission-edit.wfqd-quick-modal .wfmapmods-submit-field.wfqd-title-field {
  margin: 0;
}

#wfmapmods-submission-edit.wfqd-quick-modal .wfmapmods-submit-field.wfqd-title-field label {
  font-size: 13px;
}

#wfmapmods-submission-edit.wfqd-quick-modal .wfmapmods-submit-field.wfqd-title-field .wfmapmods-submit-counter {
  display: none !important;
}

#wfmapmods-submission-edit.wfqd-quick-modal .wfmapmods-submit-input {
  height: 44px;
  font-size: 16px;
}

#wfmapmods-submission-edit.wfqd-quick-modal .wfmapmods-modal-dialog {
  width: min(92vw, 420px) !important;
}
`;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureControls() {
    ensureSidebarToggle();
    ensureDraftButton();
    applyQuickModalIfNeeded();
  }

  function ensureSidebarToggle() {
    const links = $(".wfmapmods-settings-links");
    if (!links) return;

    let toggle = document.getElementById("wfqd-sidebar-toggle");
    if (!toggle) {
      toggle = document.createElement("a");
      toggle.id = "wfqd-sidebar-toggle";
      toggle.href = "#";
      toggle.addEventListener("click", (ev) => {
        ev.preventDefault();
        state.settings.quickEnabled = !state.settings.quickEnabled;
        saveSettings();
        updateSidebarToggle();
        ensureDraftButton();
      });
      links.appendChild(toggle);
    } else if (toggle.parentElement !== links) {
      links.appendChild(toggle);
    }

    updateSidebarToggle();
  }

  function updateSidebarToggle() {
    const toggle = document.getElementById("wfqd-sidebar-toggle");
    if (!toggle) return;

    const enabled = !!state.settings.quickEnabled;
    const saving = state.settings.dataSaver ? "data saver on" : "data saver off";
    const blocked = state.blockedGalleries ? ", " + state.blockedGalleries + " galleries skipped" : "";
    toggle.textContent = "Draft (quick): " + (enabled ? "On" : "Off") + " (" + saving + blocked + ")";
    toggle.classList.toggle("wfqd-active", enabled);
    toggle.classList.toggle("wfqd-off", !enabled);
  }

  function ensureDraftButton() {
    const existing = document.getElementById("wfqd-button");
    const visible = state.settings.quickEnabled && isMapRoute() && isMobileContext();

    if (!visible) {
      if (existing) existing.remove();
      return;
    }

    if (existing) return;
    const button = el("button", "", "Draft");
    button.id = "wfqd-button";
    button.type = "button";
    button.title = "Quick draft";
    button.addEventListener("click", openQuickDraft);
    document.body.appendChild(button);
  }

  function setCurrentCoords(coords) {
    if (!coords) return false;
    window.currentLat = coords.lat;
    window.currentLng = coords.lng;
    return true;
  }

  function openQuickDraft() {
    const coords = getCurrentCoords();
    if (!setCurrentCoords(coords)) {
      alert("Set the submission pin first.");
      return;
    }

    const bridge = document.getElementById(SUBMIT_BRIDGE_ID);
    const payload = {
      source: "wf-quick-draft",
      poi: {
        id: null,
        title: "",
        description: "",
        supportingStatement: "",
        lat: coords.lat,
        lng: coords.lng
      },
      images: {
        mainUrl: "",
        supportingUrls: []
      }
    };

    state.quickUntil = Date.now() + QUICK_WINDOW_MS;

    if (bridge) {
      bridge.setAttribute("data-submission", JSON.stringify(payload));
    } else {
      const submitLink = Array.from(document.querySelectorAll(".wfmapmods-section-location-functions a"))
        .find(a => text(a.textContent).toLowerCase() === "submit");
      if (submitLink) {
        submitLink.click();
      } else {
        alert("Wayfarer Map Mods Base is not ready yet.");
        return;
      }
    }

    waitForQuickModal();
  }

  function waitForQuickModal() {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      applyQuickModalIfNeeded();
      const modal = document.getElementById("wfmapmods-submission-edit");
      const ready = modal && modal.classList.contains("wfqd-quick-modal") && modal.querySelector(".wfmapmods-btn-save-draft");
      if (ready || tries >= 50 || Date.now() > state.quickUntil) {
        clearInterval(timer);
      }
    }, 100);
  }

  function applyQuickModalIfNeeded() {
    const modal = document.getElementById("wfmapmods-submission-edit");
    if (!modal) return;
    if (!state.settings.quickEnabled || Date.now() > state.quickUntil) return;

    modal.classList.add("wfqd-quick-modal");
    const title = modal.querySelector(".wfmapmods-modal-title");
    if (title) title.textContent = "Quick draft";

    const fields = Array.from(modal.querySelectorAll(".wfmapmods-submit-field"));
    let titleField = null;
    for (const field of fields) {
      const label = text(field.querySelector("label")?.textContent).toLowerCase();
      field.classList.toggle("wfqd-title-field", label === "title");
      if (label === "title") titleField = field;
    }

    const input = titleField && titleField.querySelector("input");
    if (input) {
      input.placeholder = "Draft title";
      setTimeout(() => input.focus(), 40);
    }

    const saveBtn = modal.querySelector(".wfmapmods-btn-save-draft");
    if (saveBtn) saveBtn.textContent = "Save draft";
  }

  function bindSaveClickClose() {
    if (state.saveClicksBound) return;
    state.saveClicksBound = true;
    document.addEventListener("click", (ev) => {
      const saveBtn = ev.target && ev.target.closest?.("#wfmapmods-submission-edit.wfqd-quick-modal .wfmapmods-btn-save-draft");
      const closeBtn = ev.target && ev.target.closest?.("#wfmapmods-submission-edit.wfqd-quick-modal .wfmapmods-close-btn");
      const footerBtn = ev.target && ev.target.closest?.("#wfmapmods-submission-edit.wfqd-quick-modal .wfmapmods-modal-footer .wfmapmods-modal-btn");

      if (closeBtn || (footerBtn && !footerBtn.classList.contains("wfmapmods-btn-save-draft"))) {
        state.quickUntil = 0;
        return;
      }

      if (!saveBtn) return;
      state.quickUntil = 0;

      setTimeout(() => {
        const modal = document.getElementById("wfmapmods-submission-edit");
        if (modal) modal.remove();
      }, 250);
    });
  }
})();
