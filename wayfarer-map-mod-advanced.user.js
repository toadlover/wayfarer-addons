// ==UserScript==
// @name         Wayfarer Map Mod - Advanced
// @namespace    https://wayfarer.nianticlabs.com/
// @version      0.1.0
// @description  Advanced submit/edit draft inspection panel for Wayfarer Map Mods Base.
// @author       TrungLatias
// @match        https://wayfarer.nianticlabs.com/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Trungx5/wayfarer-addons/Trungx5/wayfarer-map-mod-advanced.user.js
// @downloadURL  https://raw.githubusercontent.com/Trungx5/wayfarer-addons/Trungx5/wayfarer-map-mod-advanced.user.js
// ==/UserScript==

(function () {
  "use strict";

  const VERSION = "0.1.0";
  const STREET_VIEW_RADII = [45, 120, 300];
  const COORD_EPSILON = 0.0000002;

  let activeView = null;
  let rootObserver = null;
  let pollTimer = null;

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function $all(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
  }

  function cleanText(value, fallback = "") {
    const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    return text || fallback;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function isValidLatLng(lat, lng) {
    return typeof lat === "number" && typeof lng === "number" &&
      Number.isFinite(lat) && Number.isFinite(lng) &&
      lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  }

  function formatLatLng(lat, lng) {
    if (!isValidLatLng(lat, lng)) return "No coordinate";
    return lat.toFixed(6) + ", " + lng.toFixed(6);
  }

  function sameCoords(a, b) {
    return !!a && !!b &&
      Math.abs(a.lat - b.lat) < COORD_EPSILON &&
      Math.abs(a.lng - b.lng) < COORD_EPSILON;
  }

  function fullImageUrl(url) {
    const text = String(url || "").trim();
    if (!text) return "";
    if (/^(data|blob):/i.test(text)) return text;
    if (/=s0(?:$|[&#?])/.test(text)) return text;
    if (/=s\d+(?:-[a-z0-9]+)?$/i.test(text)) {
      return text.replace(/=s\d+(?:-[a-z0-9]+)?$/i, "=s0");
    }
    return text + "=s0";
  }

  function makeButton(text, className, onClick) {
    const button = el("button", "wfadv-btn" + (className ? " " + className : ""), text);
    button.type = "button";
    if (onClick) button.addEventListener("click", onClick);
    return button;
  }

  function injectCss() {
    if (document.getElementById("wfadv-css")) return;

    const style = document.createElement("style");
    style.id = "wfadv-css";
    style.textContent = `
.wfadv-submit-layout {
  display: grid;
  grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}

.wfadv-submit-layout.wfadv-has-ai {
  grid-template-columns: minmax(300px, 340px) minmax(0, 1fr) minmax(310px, .95fr);
}

.wfadv-submit-layout .wfmapmods-submit-wrap,
.wfadv-submit-column,
.wfmapmods-submit-ai-column {
  min-width: 0;
}

.wfadv-submit-column {
  position: sticky;
  top: 0;
}

.wfadv-panel {
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #f9fafb;
  color: #111827;
  display: grid;
  grid-template-rows: auto minmax(260px, 1fr) minmax(260px, 1fr);
  max-height: calc(90vh - 96px);
  min-height: 560px;
  overflow: hidden;
  font-family: Roboto, Arial, sans-serif;
  font-size: 12px;
}

.wfadv-head,
.wfadv-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.wfadv-head {
  padding: 8px;
  border-bottom: 1px solid #e5e7eb;
  background: #f8fafc;
}

.wfadv-title,
.wfadv-section-title {
  font-weight: 700;
}

.wfadv-title {
  font-size: 13px;
}

.wfadv-section {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid #e5e7eb;
}

.wfadv-section:last-child {
  border-bottom: none;
}

.wfadv-section-head {
  flex: 0 0 auto;
  padding: 6px 8px;
  border-bottom: 1px solid #eef2f7;
}

.wfadv-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.wfadv-btn {
  border: 1px solid #d1d5db;
  border-radius: 4px;
  background: #ffffff;
  color: #111827;
  cursor: pointer;
  font: inherit;
  padding: 3px 7px;
}

.wfadv-btn:hover {
  background: #f3f4f6;
}

.wfadv-btn:disabled {
  opacity: .55;
  cursor: default;
}

.wfadv-meta,
.wfadv-status,
.wfadv-empty,
.wfadv-note {
  color: #6b7280;
  line-height: 1.35;
}

.wfadv-status.ok {
  color: #166534;
  font-weight: 600;
}

.wfadv-status.err {
  color: #b91c1c;
  font-weight: 600;
}

.wfadv-street-body,
.wfadv-photo-body {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 8px 8px;
}

.wfadv-street-view,
.wfadv-photo-frame {
  flex: 1 1 auto;
  min-height: 150px;
  position: relative;
  overflow: hidden;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #f3f4f6;
}

.wfadv-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  text-align: center;
  color: #6b7280;
  line-height: 1.35;
}

.wfadv-thumbs {
  flex: 0 0 auto;
  display: flex;
  gap: 5px;
  overflow-x: auto;
  padding-bottom: 1px;
}

.wfadv-thumb {
  position: relative;
  flex: 0 0 auto;
  width: 52px;
  height: 52px;
  border: 2px solid #e5e7eb;
  border-radius: 5px;
  background: #f3f4f6;
  cursor: pointer;
  overflow: hidden;
  padding: 0;
}

.wfadv-thumb.active {
  border-color: #2563eb;
}

.wfadv-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.wfadv-thumb span {
  position: absolute;
  left: 2px;
  bottom: 2px;
  max-width: calc(100% - 4px);
  border-radius: 3px;
  background: rgba(17,24,39,.78);
  color: #ffffff;
  font-size: 9px;
  line-height: 1;
  padding: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wfadv-photo-frame {
  display: flex;
  align-items: center;
  justify-content: center;
}

.wfadv-photo-frame img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  object-position: 50% 50%;
  transform-origin: 50% 50%;
  will-change: transform;
}

.wfadv-controls {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 5px 7px;
  align-items: center;
}

.wfadv-controls label {
  color: #374151;
  white-space: nowrap;
}

.wfadv-controls input[type="range"] {
  width: 100%;
}

.wfadv-note {
  flex: 0 0 auto;
  font-size: 11px;
}

@media (max-width: 980px) {
  .wfadv-submit-layout,
  .wfadv-submit-layout.wfadv-has-ai {
    grid-template-columns: minmax(0, 1fr);
  }

  .wfadv-submit-column {
    position: static;
  }

  .wfadv-panel {
    max-height: none;
    min-height: 620px;
  }
}
`;
    document.documentElement.appendChild(style);
  }

  function parseLatLngFromModal(modal) {
    const text = cleanText($(".wfmapmods-submit-location-value", modal)?.textContent || "");
    const match = text.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (match) {
      const lat = Number(match[1]);
      const lng = Number(match[2]);
      if (isValidLatLng(lat, lng)) return { lat, lng };
    }

    const lat = typeof window.currentLat === "number" ? window.currentLat : Number(window.currentLat);
    const lng = typeof window.currentLng === "number" ? window.currentLng : Number(window.currentLng);
    return isValidLatLng(lat, lng) ? { lat, lng } : null;
  }

  function collectModalPhotos(wrapper) {
    return $all(".wfmapmods-submit-imgblock", wrapper)
      .map((block, index) => {
        const img = $(".wfmapmods-submit-thumb", block);
        const url = img?.currentSrc || img?.src || "";
        if (!url) return null;

        const rawLabel = cleanText($(".wfmapmods-submit-imglabel", block)?.textContent || "", "Photo " + (index + 1));
        return {
          key: index + ":" + url,
          index,
          label: rawLabel.replace(/\s+photo$/i, "") || rawLabel,
          url
        };
      })
      .filter(Boolean);
  }

  function buildAdvancedPanel(view) {
    const panel = el("div", "wfadv-panel");

    const head = el("div", "wfadv-head");
    head.appendChild(el("div", "wfadv-title", "Advanced"));
    const headMeta = el("div", "wfadv-meta", "Modal only");
    head.appendChild(headMeta);
    panel.appendChild(head);

    const streetSection = el("section", "wfadv-section");
    const streetHead = el("div", "wfadv-section-head");
    streetHead.appendChild(el("div", "wfadv-section-title", "Latest Street View"));
    const streetActions = el("div", "wfadv-actions");
    const coordLabel = el("div", "wfadv-meta", "No coordinate");
    const forcePinBtn = makeButton("Force pin", "", () => forceStreetPin(view));
    streetActions.append(coordLabel, forcePinBtn);
    streetHead.appendChild(streetActions);
    streetSection.appendChild(streetHead);

    const streetBody = el("div", "wfadv-street-body");
    const streetStatus = el("div", "wfadv-status", "Waiting for draft coordinates.");
    const streetView = el("div", "wfadv-street-view");
    streetView.appendChild(el("div", "wfadv-placeholder", "Street View will load here when the draft opens."));
    streetBody.append(streetStatus, streetView);
    streetSection.appendChild(streetBody);
    panel.appendChild(streetSection);

    const photoSection = el("section", "wfadv-section");
    const photoHead = el("div", "wfadv-section-head");
    photoHead.appendChild(el("div", "wfadv-section-title", "Photo Inspector"));
    const photoActions = el("div", "wfadv-actions");
    const resetBtn = makeButton("Reset view", "", () => resetPhotoView(view));
    const openBtn = makeButton("Open original", "", () => openSelectedPhoto(view));
    photoActions.append(resetBtn, openBtn);
    photoHead.appendChild(photoActions);
    photoSection.appendChild(photoHead);

    const photoBody = el("div", "wfadv-photo-body");
    const thumbs = el("div", "wfadv-thumbs");
    const photoFrame = el("div", "wfadv-photo-frame");
    photoFrame.appendChild(el("div", "wfadv-placeholder", "Click a draft photo above to inspect it."));
    const controls = buildPhotoControls(view);
    const note = el("div", "wfadv-note", "Crop view is preview-only. The draft image is not changed or reuploaded.");
    photoBody.append(thumbs, photoFrame, controls, note);
    photoSection.appendChild(photoBody);
    panel.appendChild(photoSection);

    view.ui.coordLabel = coordLabel;
    view.ui.forcePinBtn = forcePinBtn;
    view.ui.streetStatus = streetStatus;
    view.ui.streetView = streetView;
    view.ui.thumbs = thumbs;
    view.ui.photoFrame = photoFrame;
    view.ui.resetPhotoBtn = resetBtn;
    view.ui.openPhotoBtn = openBtn;
    setPhotoControlsEnabled(view, false);

    return panel;
  }

  function buildPhotoControls(view) {
    const controls = el("div", "wfadv-controls");

    const zoomLabel = el("label", "", "Zoom");
    const zoomInput = document.createElement("input");
    zoomInput.type = "range";
    zoomInput.min = "1";
    zoomInput.max = "4";
    zoomInput.step = "0.05";
    zoomInput.value = String(view.photoZoom);
    const zoomValue = el("span", "wfadv-meta", "1.00x");

    const xLabel = el("label", "", "Focus X");
    const xInput = document.createElement("input");
    xInput.type = "range";
    xInput.min = "0";
    xInput.max = "100";
    xInput.step = "1";
    xInput.value = String(view.photoFocusX);
    const xValue = el("span", "wfadv-meta", "50%");

    const yLabel = el("label", "", "Focus Y");
    const yInput = document.createElement("input");
    yInput.type = "range";
    yInput.min = "0";
    yInput.max = "100";
    yInput.step = "1";
    yInput.value = String(view.photoFocusY);
    const yValue = el("span", "wfadv-meta", "50%");

    const onInput = () => {
      view.photoZoom = Number(zoomInput.value) || 1;
      view.photoFocusX = Number(xInput.value) || 50;
      view.photoFocusY = Number(yInput.value) || 50;
      applyPhotoTransform(view);
    };

    [zoomInput, xInput, yInput].forEach(input => input.addEventListener("input", onInput));
    controls.append(zoomLabel, zoomInput, zoomValue, xLabel, xInput, xValue, yLabel, yInput, yValue);

    view.ui.zoomInput = zoomInput;
    view.ui.zoomValue = zoomValue;
    view.ui.xInput = xInput;
    view.ui.xValue = xValue;
    view.ui.yInput = yInput;
    view.ui.yValue = yValue;

    return controls;
  }

  function createView(modal, wrapper, column) {
    const view = {
      modal,
      wrapper,
      column,
      ui: {},
      photos: [],
      photoListKey: "",
      selectedPhoto: null,
      photoZoom: 1,
      photoFocusX: 50,
      photoFocusY: 50,
      selectedCoords: null,
      streetDebounce: null,
      streetSeq: 0,
      streetViewService: null,
      panorama: null,
      streetMarker: null,
      wrapperObserver: null
    };

    column.appendChild(buildAdvancedPanel(view));
    return view;
  }

  function ensureSubmitLayout(modal, wrapper) {
    let layout = wrapper.parentElement;
    if (layout && (
      layout.classList.contains("wfadv-submit-layout") ||
      layout.classList.contains("wfmapmods-submit-ai-layout")
    )) {
      layout.classList.add("wfadv-submit-layout");
      return layout;
    }

    layout = document.createElement("div");
    layout.className = "wfadv-submit-layout";
    wrapper.parentNode.insertBefore(layout, wrapper);
    layout.appendChild(wrapper);
    return layout;
  }

  function normalizeSubmitLayout(modal, wrapper, column) {
    let layout = column?.parentElement || ensureSubmitLayout(modal, wrapper);
    layout.classList.add("wfadv-submit-layout");

    const nestedAiLayout = wrapper.closest(".wfmapmods-submit-ai-layout");
    if (nestedAiLayout && nestedAiLayout !== layout && layout.contains(nestedAiLayout)) {
      const aiColumn = $(".wfmapmods-submit-ai-column", nestedAiLayout);
      layout.insertBefore(wrapper, column.nextSibling);
      if (aiColumn) layout.appendChild(aiColumn);
      if (!nestedAiLayout.children.length) nestedAiLayout.remove();
    }

    if (column.parentElement !== layout) {
      layout.insertBefore(column, wrapper);
    } else if (wrapper.parentElement === layout && column.nextElementSibling !== wrapper) {
      layout.insertBefore(column, wrapper);
    }

    layout.classList.toggle("wfadv-has-ai", !!$(".wfmapmods-submit-ai-column", layout));
    return layout;
  }

  function updateDialogWidth(modal) {
    const dialog = $(".wfmapmods-modal-dialog", modal);
    if (!dialog) return;
    const hasAi = !!$(".wfmapmods-submit-ai-column", modal);
    dialog.style.width = hasAi ? "1500px" : "1160px";
    dialog.style.maxWidth = "calc(100% - 32px)";
  }

  function observeWrapper(view) {
    if (view.wrapperObserver) view.wrapperObserver.disconnect();
    view.wrapperObserver = new MutationObserver(() => {
      renderPhotoThumbs(view);
      syncCoordsFromModal(view, "modal");
      resizePanorama(view);
    });
    view.wrapperObserver.observe(view.wrapper, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["src", "style", "class"]
    });
  }

  function enhanceSubmitModal() {
    injectCss();

    const modal = document.getElementById("wfmapmods-submission-edit");
    if (!modal) {
      cleanupInactiveView();
      return;
    }

    if (activeView && activeView.modal !== modal) {
      destroyView(activeView);
    }

    const wrapper = $(".wfmapmods-submit-wrap", modal);
    if (!wrapper) return;

    if (modal.dataset.wfadvEnhanced === "1") {
      const view = modal.__wfadvView || activeView;
      if (!view) {
        delete modal.dataset.wfadvEnhanced;
        enhanceSubmitModal();
        return;
      }
      normalizeSubmitLayout(modal, wrapper, view.column);
      updateDialogWidth(modal);
      renderPhotoThumbs(view);
      syncCoordsFromModal(view, "modal");
      resizePanorama(view);
      return;
    }

    const layout = ensureSubmitLayout(modal, wrapper);
    const column = el("div", "wfadv-submit-column");
    layout.insertBefore(column, wrapper);

    const view = createView(modal, wrapper, column);
    activeView = view;
    modal.__wfadvView = view;
    modal.dataset.wfadvEnhanced = "1";

    normalizeSubmitLayout(modal, wrapper, column);
    updateDialogWidth(modal);
    observeWrapper(view);
    renderPhotoThumbs(view);
    syncCoordsFromModal(view, "modal");
  }

  function cleanupInactiveView() {
    if (!activeView || document.contains(activeView.modal)) return;
    destroyView(activeView);
  }

  function destroyView(view) {
    clearTimeout(view.streetDebounce);
    if (view.wrapperObserver) view.wrapperObserver.disconnect();
    if (view.streetMarker) view.streetMarker.setMap(null);
    if (activeView === view) activeView = null;
  }

  function photoKey(photo) {
    return photo ? photo.key : "";
  }

  function renderPhotoThumbs(view) {
    const photos = collectModalPhotos(view.wrapper);
    const listKey = photos.map(photo => photo.key).join("|");
    if (listKey === view.photoListKey) return;

    view.photoListKey = listKey;
    view.photos = photos;
    if (view.selectedPhoto) {
      view.selectedPhoto = photos.find(photo => photo.key === view.selectedPhoto.key) || null;
    }

    const thumbs = view.ui.thumbs;
    if (!thumbs) return;
    thumbs.textContent = "";

    if (!photos.length) {
      thumbs.appendChild(el("div", "wfadv-empty", "No ready photos in this draft."));
      renderPhotoInspector(view);
      return;
    }

    const activeKey = photoKey(view.selectedPhoto);
    photos.forEach(photo => {
      const button = el("button", "wfadv-thumb" + (photo.key === activeKey ? " active" : ""));
      button.type = "button";
      button.title = photo.label;
      button.addEventListener("click", ev => {
        ev.preventDefault();
        selectPhoto(view, photo);
      });

      const img = document.createElement("img");
      img.src = photo.url;
      img.alt = photo.label;
      button.appendChild(img);
      button.appendChild(el("span", "", photo.label));
      thumbs.appendChild(button);
    });

    renderPhotoInspector(view);
  }

  function selectPhoto(view, photo) {
    view.selectedPhoto = photo;
    resetPhotoView(view, false);
    view.photoListKey = "";
    renderPhotoThumbs(view);
  }

  function renderPhotoInspector(view) {
    const frame = view.ui.photoFrame;
    if (!frame) return;
    frame.textContent = "";
    view.ui.photoImg = null;

    const photo = view.selectedPhoto;
    if (!photo || !photo.url) {
      frame.appendChild(el("div", "wfadv-placeholder", "Click a draft photo above to inspect it."));
      setPhotoControlsEnabled(view, false);
      return;
    }

    const img = document.createElement("img");
    img.src = fullImageUrl(photo.url);
    img.alt = photo.label || "Draft photo";
    img.onerror = () => {
      if (img.src !== photo.url) img.src = photo.url;
    };
    frame.appendChild(img);
    view.ui.photoImg = img;
    setPhotoControlsEnabled(view, true);
    applyPhotoTransform(view);
  }

  function setPhotoControlsEnabled(view, enabled) {
    [view.ui.zoomInput, view.ui.xInput, view.ui.yInput, view.ui.resetPhotoBtn, view.ui.openPhotoBtn].forEach(control => {
      if (control) control.disabled = !enabled;
    });
  }

  function applyPhotoTransform(view) {
    if (view.ui.zoomInput) view.ui.zoomInput.value = String(view.photoZoom);
    if (view.ui.xInput) view.ui.xInput.value = String(view.photoFocusX);
    if (view.ui.yInput) view.ui.yInput.value = String(view.photoFocusY);
    if (view.ui.zoomValue) view.ui.zoomValue.textContent = view.photoZoom.toFixed(2) + "x";
    if (view.ui.xValue) view.ui.xValue.textContent = Math.round(view.photoFocusX) + "%";
    if (view.ui.yValue) view.ui.yValue.textContent = Math.round(view.photoFocusY) + "%";

    const img = view.ui.photoImg;
    if (!img) return;
    const focus = view.photoFocusX + "% " + view.photoFocusY + "%";
    img.style.objectPosition = focus;
    img.style.transformOrigin = focus;
    img.style.transform = "scale(" + view.photoZoom + ")";
  }

  function resetPhotoView(view, render = true) {
    view.photoZoom = 1;
    view.photoFocusX = 50;
    view.photoFocusY = 50;
    if (render) applyPhotoTransform(view);
  }

  function openSelectedPhoto(view) {
    const url = fullImageUrl(view.selectedPhoto?.url || "");
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function syncCoordsFromModal(view, source) {
    const coords = parseLatLngFromModal(view.modal);
    if (!coords) {
      if (view.ui.coordLabel) view.ui.coordLabel.textContent = "No coordinate";
      if (view.ui.streetStatus) {
        view.ui.streetStatus.textContent = "No draft coordinate was found.";
        view.ui.streetStatus.className = "wfadv-status err";
      }
      return;
    }
    setCoords(view, coords.lat, coords.lng, source || "modal");
  }

  function setCoords(view, lat, lng, source) {
    if (!view || !isValidLatLng(lat, lng)) return;
    const next = { lat, lng, source: source || "modal" };
    if (sameCoords(view.selectedCoords, next)) return;
    view.selectedCoords = next;

    if (view.ui.coordLabel) view.ui.coordLabel.textContent = formatLatLng(lat, lng);
    scheduleStreetViewUpdate(view, next);
  }

  function scheduleStreetViewUpdate(view, coords) {
    clearTimeout(view.streetDebounce);
    view.streetDebounce = setTimeout(() => loadStreetView(view, coords), 250);
  }

  function ensureStreetViewObjects(view) {
    if (!window.google?.maps?.StreetViewService || !window.google?.maps?.StreetViewPanorama) {
      return false;
    }

    if (!view.streetViewService) {
      view.streetViewService = new google.maps.StreetViewService();
    }

    if (!view.panorama && view.ui.streetView) {
      view.ui.streetView.textContent = "";
      view.panorama = new google.maps.StreetViewPanorama(view.ui.streetView, {
        visible: true,
        addressControl: false,
        fullscreenControl: false,
        linksControl: true,
        motionTracking: false,
        motionTrackingControl: false,
        panControl: false,
        zoomControl: true,
        clickToGo: true,
        disableDefaultUI: false
      });
    }

    return !!view.streetViewService && !!view.panorama;
  }

  function streetViewRequest(view, location, radius) {
    return new Promise(resolve => {
      const request = { location, radius };
      if (google.maps.StreetViewPreference?.NEAREST) {
        request.preference = google.maps.StreetViewPreference.NEAREST;
      }
      if (google.maps.StreetViewSource?.OUTDOOR) {
        request.source = google.maps.StreetViewSource.OUTDOOR;
      }
      view.streetViewService.getPanorama(request, (data, status) => {
        resolve({ data, status, radius });
      });
    });
  }

  async function loadStreetView(view, coords) {
    const seq = ++view.streetSeq;
    if (!coords || !isValidLatLng(coords.lat, coords.lng)) return;

    if (!ensureStreetViewObjects(view)) {
      if (view.ui.streetStatus) {
        view.ui.streetStatus.textContent = "Google Street View is not available yet.";
        view.ui.streetStatus.className = "wfadv-status err";
      }
      clearTimeout(view.streetDebounce);
      view.streetDebounce = setTimeout(() => {
        if (document.contains(view.modal)) loadStreetView(view, coords);
      }, 1500);
      return;
    }

    const location = { lat: coords.lat, lng: coords.lng };
    if (view.ui.streetStatus) {
      view.ui.streetStatus.textContent = "Loading Google default/latest panorama for " + formatLatLng(coords.lat, coords.lng) + "...";
      view.ui.streetStatus.className = "wfadv-status";
    }

    let found = null;
    for (const radius of STREET_VIEW_RADII) {
      const result = await streetViewRequest(view, location, radius);
      if (seq !== view.streetSeq) return;
      if (result.status === google.maps.StreetViewStatus.OK && result.data?.location) {
        found = result;
        break;
      }
    }

    if (seq !== view.streetSeq) return;

    if (!found) {
      if (view.ui.streetStatus) {
        view.ui.streetStatus.textContent = "No Street View found within " + STREET_VIEW_RADII[STREET_VIEW_RADII.length - 1] + "m.";
        view.ui.streetStatus.className = "wfadv-status err";
      }
      if (view.streetMarker) view.streetMarker.setMap(null);
      return;
    }

    const data = found.data;
    const panoId = data.location.pano;
    const panoLatLng = data.location.latLng;
    view.panorama.setPano(panoId);
    view.panorama.setPov({
      heading: panoLatLng ? bearingBetween(panoLatLng, location) : 0,
      pitch: 0
    });
    view.panorama.setZoom(0);
    updateStreetMarker(view, location);
    resizePanorama(view);

    const imageDate = data.imageDate ? " Imagery: " + data.imageDate + "." : "";
    if (view.ui.streetStatus) {
      view.ui.streetStatus.textContent = "Google default/latest panorama, " + found.radius + "m search radius." + imageDate;
      view.ui.streetStatus.className = "wfadv-status ok";
    }
  }

  function resizePanorama(view) {
    if (!view.panorama || !window.google?.maps?.event) return;
    setTimeout(() => {
      if (view.panorama && document.contains(view.modal)) {
        google.maps.event.trigger(view.panorama, "resize");
      }
    }, 0);
  }

  function forceStreetPin(view) {
    if (!view || !document.contains(view.modal)) return;

    const parsed = parseLatLngFromModal(view.modal);
    const coords = parsed || view.selectedCoords;
    if (!coords || !isValidLatLng(coords.lat, coords.lng)) {
      if (view.ui.streetStatus) {
        view.ui.streetStatus.textContent = "No draft coordinate is available for the pin.";
        view.ui.streetStatus.className = "wfadv-status err";
      }
      return;
    }

    if (parsed) {
      setCoords(view, parsed.lat, parsed.lng, "manual-pin");
    }

    if (!ensureStreetViewObjects(view)) {
      if (view.ui.streetStatus) {
        view.ui.streetStatus.textContent = "Google Street View is not ready. Pin will be retried with the normal load.";
        view.ui.streetStatus.className = "wfadv-status err";
      }
      scheduleStreetViewUpdate(view, coords);
      return;
    }

    updateStreetMarker(view, coords, true);
    resizePanorama(view);

    if (!view.panorama.getPano?.()) {
      scheduleStreetViewUpdate(view, coords);
      return;
    }

    if (view.ui.streetStatus) {
      view.ui.streetStatus.textContent = "Pin refreshed at " + formatLatLng(coords.lat, coords.lng) + ".";
      view.ui.streetStatus.className = "wfadv-status ok";
    }
  }

  function latOf(value) {
    return typeof value.lat === "function" ? value.lat() : Number(value.lat);
  }

  function lngOf(value) {
    return typeof value.lng === "function" ? value.lng() : Number(value.lng);
  }

  function bearingBetween(from, to) {
    const lat1 = latOf(from) * Math.PI / 180;
    const lat2 = latOf(to) * Math.PI / 180;
    const dLng = (lngOf(to) - lngOf(from)) * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function updateStreetMarker(view, coords, force = false) {
    if (!view.panorama || !window.google?.maps) return;
    const position = new google.maps.LatLng(coords.lat, coords.lng);
    const icon = {
      url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="42" viewBox="0 0 30 42"><path d="M15 41S2 25.5 2 15.5C2 7.5 7.8 2 15 2s13 5.5 13 13.5C28 25.5 15 41 15 41z" fill="#dc2626" stroke="#7f1d1d" stroke-width="2"/><circle cx="15" cy="15" r="5.5" fill="#fff"/></svg>'
      ),
      scaledSize: new google.maps.Size(30, 42),
      anchor: new google.maps.Point(15, 42)
    };

    if (!view.streetMarker) {
      view.streetMarker = new google.maps.Marker({
        map: view.panorama,
        position,
        icon,
        clickable: false,
        optimized: false,
        title: "Selected draft coordinate"
      });
    } else {
      if (force) view.streetMarker.setMap(null);
      view.streetMarker.setPosition(position);
      view.streetMarker.setIcon(icon);
      view.streetMarker.setMap(view.panorama);
    }

    view.streetMarker.setVisible(true);

    if (force) {
      const panoLocation = typeof view.panorama.getLocation === "function" ? view.panorama.getLocation() : null;
      const panoLatLng = panoLocation?.latLng;
      if (panoLatLng) {
        const pov = view.panorama.getPov ? view.panorama.getPov() : {};
        view.panorama.setPov({
          heading: bearingBetween(panoLatLng, coords),
          pitch: typeof pov.pitch === "number" ? pov.pitch : 0
        });
      }
    }
  }

  function handleSubmitCoords(ev) {
    const view = activeView;
    if (!view || !document.contains(view.modal)) return;

    const detail = ev?.detail || {};
    const lat = Number(detail.lat);
    const lng = Number(detail.lng);
    if (isValidLatLng(lat, lng)) setCoords(view, lat, lng, detail.source || "map");
  }

  function exposeApi() {
    window.WFMMAdvanced = {
      version: VERSION,
      refresh: () => {
        enhanceSubmitModal();
        if (activeView) {
          renderPhotoThumbs(activeView);
          syncCoordsFromModal(activeView, "api");
        }
      },
      setCoords: (lat, lng) => setCoords(activeView, Number(lat), Number(lng), "api"),
      selectedPhoto: () => activeView?.selectedPhoto || null,
      selectedCoords: () => activeView?.selectedCoords || null
    };
  }

  function tick() {
    enhanceSubmitModal();
    exposeApi();
  }

  function startModalPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (!activeView || !document.contains(activeView.modal)) return;
      syncCoordsFromModal(activeView, "poll");
      resizePanorama(activeView);
    }, 1000);
  }

  function boot() {
    injectCss();
    window.addEventListener("wf:submit-coords", handleSubmitCoords);
    startModalPoll();
    tick();
    rootObserver = new MutationObserver(tick);
    rootObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
