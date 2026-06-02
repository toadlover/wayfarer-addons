// ==UserScript==
// @name         Wayfarer Map Compact Pre-texts Plugin
// @namespace    https://chatgpt.local/wayfarer-map-pretexts-compact
// @version      0.1.0
// @description  Standalone compact pre-text manager for Wayfarer Map Mod. Adds a simple panel link and a small submit-screen pre-text box without editing the base script.
// @author       TrungLatias
// @match        https://wayfarer.nianticlabs.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEY = "wfmapmods-pretexts";
  const LINK_TEXT = "Pre-texts";

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function $all(selector, root = document) {
    return Array.from(root.querySelectorAll(selector));
  }

  function text(value) {
    return value == null ? "" : String(value);
  }

  function trimText(value) {
    return text(value).trim();
  }

  function loadPreTexts() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(p => p && p.text) : [];
    } catch (_) {
      return [];
    }
  }

  function savePreTexts(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.isArray(list) ? list : []));
    window.dispatchEvent(new CustomEvent("wfpt:changed"));
  }

  function makeId() {
    return "pt-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  }

  function compactLabel(pt) {
    const nick = trimText(pt.nickname);
    if (nick) return nick;
    const s = trimText(pt.text).replace(/\s+/g, " ");
    return s.slice(0, 48) + (s.length > 48 ? "…" : "");
  }

  function copyText(value) {
    const s = text(value);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(s);
    }
    return new Promise((resolve, reject) => {
      const ta = document.createElement("textarea");
      ta.value = s;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try {
        const ok = document.execCommand("copy");
        ta.remove();
        ok ? resolve() : reject(new Error("copy failed"));
      } catch (err) {
        ta.remove();
        reject(err);
      }
    });
  }

  function putIntoField(field, value) {
    if (!field) return;
    field.value = text(value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.focus();
  }

  function injectCss() {
    if (document.getElementById("wfpt-css")) return;
    const style = document.createElement("style");
    style.id = "wfpt-css";
    style.textContent = `
.wfpt-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:2147483600;display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box}
.wfpt-dialog{width:520px;max-width:calc(100vw - 24px);max-height:90vh;background:#fff;color:#111827;border-radius:8px;box-shadow:0 10px 25px rgba(0,0,0,.35);font-family:Roboto,Arial,sans-serif;font-size:12px;display:flex;flex-direction:column;overflow:hidden}
.wfpt-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid #e5e7eb;flex:0 0 auto}.wfpt-title{font-size:15px;font-weight:700}.wfpt-x{border:1px solid #d1d5db;background:#fff;border-radius:999px;width:26px;height:26px;cursor:pointer;font-weight:700}.wfpt-body{display:flex;flex-direction:column;min-height:0;max-height:calc(90vh - 48px)}
.wfpt-add{flex:0 0 auto;padding:10px 12px;border-bottom:1px solid #e5e7eb;background:#fff}.wfpt-label{font-size:11px;font-weight:700;color:#374151;margin:4px 0}.wfpt-input,.wfpt-textarea,.wfpt-search{width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:5px;background:#fff;color:#111827;font:inherit;padding:6px 8px}.wfpt-textarea{resize:vertical;min-height:58px;max-height:120px}.wfpt-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.wfpt-btn{border:1px solid #d1d5db;border-radius:5px;background:#fff;color:#111827;cursor:pointer;font:inherit;padding:5px 9px;min-height:28px}.wfpt-btn:hover{background:#f3f4f6}.wfpt-primary{background:#fb4c21;border-color:#fb4c21;color:#fff}.wfpt-primary:hover{background:#e0441d}.wfpt-danger{color:#b91c1c}.wfpt-small{font-size:11px;color:#6b7280}.wfpt-hidden{display:none!important}
.wfpt-list-wrap{flex:1 1 auto;min-height:130px;display:flex;flex-direction:column;padding:10px 12px;overflow:hidden}.wfpt-list-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap}.wfpt-list{border:1px solid #e5e7eb;border-radius:6px;background:#f9fafb;overflow-y:auto;min-height:90px;max-height:42vh;padding:5px}.wfpt-empty{color:#6b7280;font-size:12px;padding:10px}.wfpt-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;align-items:center;padding:6px;border:1px solid #e5e7eb;border-radius:5px;background:#fff;margin-bottom:5px}.wfpt-card:last-child{margin-bottom:0}.wfpt-name{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wfpt-preview{font-size:11px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}.wfpt-card-actions{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}.wfpt-card-actions .wfpt-btn{padding:4px 7px;min-height:24px;font-size:11px}
#wfpt-submit-panel{border:1px solid #e5e7eb;border-radius:6px;background:#fff;padding:7px;margin:7px 0 10px}.wfpt-submit-head{display:flex;align-items:center;gap:6px;margin-bottom:5px}.wfpt-submit-title{font-size:12px;font-weight:700}.wfpt-badge{background:#e5e7eb;border-radius:999px;padding:0 6px;font-size:11px;font-weight:700;color:#374151}.wfpt-submit-list{max-height:150px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:5px;background:#f9fafb;padding:4px}.wfpt-submit-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px;align-items:center;border:1px solid #e5e7eb;border-radius:4px;background:#fff;padding:5px;margin-bottom:4px}.wfpt-submit-row:last-child{margin-bottom:0}.wfpt-submit-name{font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wfpt-submit-actions{display:flex;gap:4px}.wfpt-submit-actions button{border:1px solid #d1d5db;background:#fff;border-radius:4px;font:inherit;font-size:11px;padding:3px 6px;cursor:pointer;white-space:nowrap}.wfpt-submit-actions button:hover{background:#f3f4f6}
@media(max-width:620px){.wfpt-dialog{width:calc(100vw - 16px);max-height:94vh}.wfpt-body{max-height:calc(94vh - 48px)}.wfpt-row{align-items:stretch}.wfpt-row .wfpt-btn{flex:1 1 auto}.wfpt-card{grid-template-columns:1fr}.wfpt-card-actions{justify-content:flex-start}.wfpt-submit-row{grid-template-columns:1fr}.wfpt-submit-actions{flex-wrap:wrap}.wfpt-submit-actions button{flex:1 1 auto}}
@media(prefers-color-scheme:dark){.wfpt-dialog,.wfpt-add,.wfpt-card,#wfpt-submit-panel,.wfpt-submit-row{background:#111827;color:#f9fafb}.wfpt-head,.wfpt-add{border-color:rgba(255,255,255,.14)}.wfpt-input,.wfpt-textarea,.wfpt-search,.wfpt-btn,.wfpt-x,.wfpt-submit-actions button{background:#1f2937;color:#f9fafb;border-color:rgba(255,255,255,.18)}.wfpt-list,.wfpt-submit-list{background:#0f172a;border-color:rgba(255,255,255,.14)}.wfpt-card,.wfpt-submit-row{border-color:rgba(255,255,255,.14)}.wfpt-label{color:#e5e7eb}.wfpt-small,.wfpt-preview,.wfpt-empty{color:#9ca3af}.wfpt-primary{background:#fb4c21;border-color:#fb4c21}.wfpt-badge{background:#374151;color:#e5e7eb}}
`;
    document.head.appendChild(style);
  }

  function openManager() {
    injectCss();
    const old = document.getElementById("wfpt-modal");
    if (old) old.remove();

    let editingId = null;

    const backdrop = document.createElement("div");
    backdrop.id = "wfpt-modal";
    backdrop.className = "wfpt-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "wfpt-dialog";
    backdrop.appendChild(dialog);

    const head = document.createElement("div");
    head.className = "wfpt-head";
    const title = document.createElement("div");
    title.className = "wfpt-title";
    title.textContent = "Pre-texts";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "wfpt-x";
    close.textContent = "×";
    close.addEventListener("click", () => backdrop.remove());
    head.append(title, close);
    dialog.appendChild(head);

    const body = document.createElement("div");
    body.className = "wfpt-body";
    dialog.appendChild(body);

    const add = document.createElement("div");
    add.className = "wfpt-add";
    add.innerHTML = `
      <div class="wfpt-label">Nickname</div>
      <input id="wfpt-nick" class="wfpt-input" maxlength="80" placeholder="Optional short name">
      <div class="wfpt-label">Text</div>
      <textarea id="wfpt-text" class="wfpt-textarea" rows="3" placeholder="Paste or type the reusable text here"></textarea>
      <div class="wfpt-row" style="margin-top:7px">
        <button id="wfpt-save" type="button" class="wfpt-btn wfpt-primary">Add pre-text</button>
        <button id="wfpt-cancel" type="button" class="wfpt-btn wfpt-hidden">Cancel edit</button>
        <span id="wfpt-editing" class="wfpt-small"></span>
      </div>`;
    body.appendChild(add);

    const wrap = document.createElement("div");
    wrap.className = "wfpt-list-wrap";
    wrap.innerHTML = `
      <div class="wfpt-list-head">
        <div><b>Saved pre-texts</b> <span id="wfpt-count" class="wfpt-small"></span></div>
        <div class="wfpt-row">
          <button id="wfpt-export" type="button" class="wfpt-btn">Export</button>
          <button id="wfpt-import" type="button" class="wfpt-btn">Import</button>
          <input id="wfpt-import-file" type="file" accept="application/json,.json" style="display:none">
        </div>
      </div>
      <input id="wfpt-search" class="wfpt-search" type="search" placeholder="Search pre-texts…" style="margin-bottom:6px">
      <div id="wfpt-list" class="wfpt-list"></div>`;
    body.appendChild(wrap);

    const nickInput = $("#wfpt-nick", dialog);
    const textArea = $("#wfpt-text", dialog);
    const saveBtn = $("#wfpt-save", dialog);
    const cancelBtn = $("#wfpt-cancel", dialog);
    const editingLabel = $("#wfpt-editing", dialog);
    const searchInput = $("#wfpt-search", dialog);
    const listEl = $("#wfpt-list", dialog);
    const countEl = $("#wfpt-count", dialog);
    const importInput = $("#wfpt-import-file", dialog);

    function resetEdit() {
      editingId = null;
      nickInput.value = "";
      textArea.value = "";
      saveBtn.textContent = "Add pre-text";
      cancelBtn.classList.add("wfpt-hidden");
      editingLabel.textContent = "";
    }

    function renderList() {
      const all = loadPreTexts();
      const q = trimText(searchInput.value).toLowerCase();
      const filtered = all.filter(pt => !q || (text(pt.nickname) + " " + text(pt.text)).toLowerCase().includes(q));
      countEl.textContent = `(${filtered.length}/${all.length})`;
      listEl.textContent = "";
      if (!filtered.length) {
        const empty = document.createElement("div");
        empty.className = "wfpt-empty";
        empty.textContent = all.length ? "No matching pre-texts." : "No pre-texts saved yet.";
        listEl.appendChild(empty);
        return;
      }
      filtered.forEach(pt => {
        const card = document.createElement("div");
        card.className = "wfpt-card";

        const main = document.createElement("div");
        const name = document.createElement("div");
        name.className = "wfpt-name";
        name.textContent = compactLabel(pt);
        name.title = text(pt.text);
        const preview = document.createElement("div");
        preview.className = "wfpt-preview";
        preview.textContent = trimText(pt.text).replace(/\s+/g, " ");
        main.append(name, preview);

        const actions = document.createElement("div");
        actions.className = "wfpt-card-actions";
        const makeBtn = (label, cls, fn) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "wfpt-btn" + (cls ? " " + cls : "");
          b.textContent = label;
          b.addEventListener("click", fn);
          actions.appendChild(b);
        };
        makeBtn("Copy", "", () => copyText(pt.text));
        makeBtn("Edit", "", () => {
          editingId = pt.id;
          nickInput.value = text(pt.nickname);
          textArea.value = text(pt.text);
          saveBtn.textContent = "Save edit";
          cancelBtn.classList.remove("wfpt-hidden");
          editingLabel.textContent = "Editing selected pre-text";
          nickInput.focus();
        });
        makeBtn("Del", "wfpt-danger", () => {
          if (!confirm("Delete this pre-text?")) return;
          savePreTexts(loadPreTexts().filter(x => x.id !== pt.id));
          if (editingId === pt.id) resetEdit();
          renderList();
        });

        card.append(main, actions);
        listEl.appendChild(card);
      });
    }

    saveBtn.addEventListener("click", () => {
      const value = trimText(textArea.value);
      if (!value) {
        alert("Please enter some text first.");
        return;
      }
      const list = loadPreTexts();
      if (editingId) {
        const item = list.find(x => x.id === editingId);
        if (item) {
          item.nickname = trimText(nickInput.value);
          item.text = value;
        }
      } else {
        list.push({ id: makeId(), nickname: trimText(nickInput.value), text: value });
      }
      savePreTexts(list);
      resetEdit();
      renderList();
    });

    cancelBtn.addEventListener("click", resetEdit);
    searchInput.addEventListener("input", renderList);

    $("#wfpt-export", dialog).addEventListener("click", () => {
      const list = loadPreTexts();
      if (!list.length) {
        alert("No pre-texts to export.");
        return;
      }
      const blob = new Blob([JSON.stringify({ wfmm_pretexts: true, version: 1, pretexts: list }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "wfmm-pretexts-" + new Date().toISOString().slice(0, 10) + ".json";
      a.click();
      URL.revokeObjectURL(url);
    });

    $("#wfpt-import", dialog).addEventListener("click", () => importInput.click());
    importInput.addEventListener("change", () => {
      const file = importInput.files && importInput.files[0];
      importInput.value = "";
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const parsed = JSON.parse(text(ev.target.result));
          const incoming = Array.isArray(parsed.pretexts) ? parsed.pretexts : (Array.isArray(parsed) ? parsed : []);
          const list = loadPreTexts();
          const known = new Set(list.map(p => p.id + "|" + p.text));
          let added = 0;
          incoming.forEach(pt => {
            if (!pt || !pt.text) return;
            const item = { id: pt.id || makeId(), nickname: text(pt.nickname), text: text(pt.text) };
            const key = item.id + "|" + item.text;
            if (known.has(key)) return;
            list.push(item);
            known.add(key);
            added++;
          });
          savePreTexts(list);
          renderList();
          alert(`Imported ${added} pre-text(s).`);
        } catch (err) {
          alert("Could not import JSON: " + err.message);
        }
      };
      reader.readAsText(file);
    });

    backdrop.addEventListener("click", ev => {
      if (ev.target === backdrop) backdrop.remove();
    });
    document.body.appendChild(backdrop);
    renderList();
  }

  function wirePanelLink() {
    $all(".wfmapmods-settings-links").forEach(container => {
      let link = $all("a", container).find(a => trimText(a.textContent).toLowerCase() === LINK_TEXT.toLowerCase());
      if (!link) {
        link = document.createElement("a");
        link.href = "#";
        link.textContent = LINK_TEXT;
        container.appendChild(link);
      }
      if (link.dataset.wfptHooked === "1") return;
      link.dataset.wfptHooked = "1";
      link.addEventListener("click", ev => {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        openManager();
      }, true);
    });
  }

  function findSubmitModal() {
    const direct = document.getElementById("wfmapmods-submission-edit");
    if (direct && direct.querySelector("textarea")) return direct;
    return $all(".wfmapmods-modal-backdrop").find(el => el.querySelector("textarea.wfmapmods-submit-textarea, textarea") && /supporting|description|title/i.test(el.textContent || "")) || null;
  }

  function removeBuiltInSubmitPreTextPanel(modal) {
    $all(".wfmapmods-submit-field", modal).forEach(field => {
      if (field.id === "wfpt-submit-panel") return;
      const label = $("label", field);
      const hasTextControl = !!$("textarea,input", field);
      if (label && trimText(label.textContent).toLowerCase() === "pre-texts" && !hasTextControl) {
        field.remove();
      }
    });
  }

  function renderSubmitPanel(panel, descInput, suppInput) {
    const list = loadPreTexts();
    panel.textContent = "";
    const head = document.createElement("div");
    head.className = "wfpt-submit-head";
    const title = document.createElement("div");
    title.className = "wfpt-submit-title";
    title.textContent = "Pre-texts";
    const badge = document.createElement("span");
    badge.className = "wfpt-badge";
    badge.textContent = list.length;
    head.append(title, badge);
    panel.appendChild(head);

    const box = document.createElement("div");
    box.className = "wfpt-submit-list";
    panel.appendChild(box);

    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "wfpt-empty";
      empty.textContent = "No pre-texts saved.";
      box.appendChild(empty);
      return;
    }

    list.forEach(pt => {
      const row = document.createElement("div");
      row.className = "wfpt-submit-row";
      const name = document.createElement("div");
      name.className = "wfpt-submit-name";
      name.textContent = compactLabel(pt);
      name.title = text(pt.text);
      const actions = document.createElement("div");
      actions.className = "wfpt-submit-actions";
      const make = (label, titleText, fn) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.title = titleText;
        b.addEventListener("click", fn);
        actions.appendChild(b);
      };
      make("Copy", "Copy text", () => copyText(pt.text));
      make("Desc", "Put into Description", () => putIntoField(descInput, pt.text));
      make("Supp", "Put into Supporting statement", () => putIntoField(suppInput, pt.text));
      row.append(name, actions);
      box.appendChild(row);
    });
  }

  function injectSubmitPanel() {
    const modal = findSubmitModal();
    if (!modal) return;
    injectCss();
    removeBuiltInSubmitPreTextPanel(modal);

    let panel = $("#wfpt-submit-panel", modal);
    const textareas = $all("textarea.wfmapmods-submit-textarea, textarea", modal);
    if (!textareas.length) return;
    const descInput = textareas[0];
    const suppInput = textareas[1] || textareas[0];

    let created = false;
    if (!panel) {
      const target = suppInput.closest(".wfmapmods-submit-field") || descInput.closest(".wfmapmods-submit-field") || suppInput.parentElement;
      if (!target || !target.parentElement) return;
      panel = document.createElement("div");
      panel.id = "wfpt-submit-panel";
      panel.className = "wfmapmods-submit-field";
      target.insertAdjacentElement("afterend", panel);
      created = true;
    }
    panel._wfptRender = () => {
      renderSubmitPanel(panel, descInput, suppInput);
      panel.dataset.wfptSig = JSON.stringify(loadPreTexts().map(pt => [pt.id, pt.nickname || "", pt.text || ""]));
    };
    const sig = JSON.stringify(loadPreTexts().map(pt => [pt.id, pt.nickname || "", pt.text || ""]));
    if (created || panel.dataset.wfptSig !== sig) panel._wfptRender();
  }

  function scan() {
    wirePanelLink();
    injectSubmitPanel();
  }

  function boot() {
    injectCss();
    scan();
    const observer = new MutationObserver(() => scan());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("storage", ev => {
      if (ev.key === STORAGE_KEY) scan();
    });
    window.addEventListener("wfpt:changed", () => {
      $all("#wfpt-submit-panel").forEach(panel => {
        if (typeof panel._wfptRender === "function") panel._wfptRender();
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
