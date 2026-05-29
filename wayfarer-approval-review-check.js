// ==UserScript==
// @name         Wayfarer Review Approval Checker
// @version      0.1.0
// @developer    TrungLatias
// @description  Add local review history storage to Wayfarer
// @match        https://wayfarer.nianticlabs.com/*
// @run-at       document-start
// ==/UserScript==

// This script is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This script is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

/*
 * Wayfarer Review Approval Checker
 *
 * Requirements:
 * - Install beside "Wayfarer Review History" so the reviewHistory IndexedDB store exists.
 * - Uses Wayfarer Map's GCS endpoint to check if an exact reviewed coordinate currently exists as a map wayspot.
 *
 * Status rules:
 * - Exact coordinate found in map GCS data: Approved
 * - Exact coordinate not found: automatically checks same-name wayspots within 100m.
 * - Same-name wayspot found within 100m: Approved relocated, persisted with distance and new coordinate
 * - Still not found and review age < your configured threshold: Reviewing
 * - Still not found and review age >= your configured threshold: Likely rejected
 */

(function () {
    "use strict";

    const DB_NAME = "wayfarer-tools-db";
    const REVIEW_STORE_NAME = "reviewHistory";
    const GCS_ENDPOINT = "/api/v1/vault/mapview/gcs";
    const LIVE_ENDPOINT = "/api/v1/vault/live-pois-in-radius";
    const CELL_LEVEL = 14;

    const HARD_MAX_ROWS = 2000; // hard cap requested by user
    const DEFAULT_LIST_DAYS = 14;
    const DEFAULT_REVIEWING_DAYS = 7;
    const REQUEST_DELAY_MS = 120;
    const CONCURRENT_CHECKS = 18; // 6x more than v0.5.4's 3 parallel checks
    const RELOCATION_RADIUS_M = 100;
    const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours for pending/rejected checks

    const PANEL_ID = "wf-review-approval-checker";
    const CACHE_KEY = "wf_review_approval_checker_cache_v5"; // compact one-key cache, not one localStorage row per coordinate
    const LEGACY_CACHE_PREFIXES = [
        "wf_review_approval_checker_v4:",
        "wf_review_approval_checker_v3:",
        "wf_review_approval_checker_v2:",
        "wf_review_approval_checker_v1:"
    ];
    const STATS_KEY = "wf_review_approval_checker_stats_v5";
    const SETTINGS_KEY = "wf_review_approval_checker_settings_v1";
    const MAX_CACHE_ENTRIES = 6000;

    let userHash = null;
    let inserted = false;
    let activeChecks = 0;
    const pendingChecks = [];

    function clampInt(value, fallback, min, max) {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(min, Math.min(max, n));
    }

    function loadSettings() {
        let parsed = null;
        try {
            parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
        } catch (_) {
            parsed = null;
        }

        const settings = {
            reviewingDays: DEFAULT_REVIEWING_DAYS,
            listDays: String(DEFAULT_LIST_DAYS)
        };

        if (parsed && typeof parsed === "object") {
            settings.reviewingDays = clampInt(parsed.reviewingDays, DEFAULT_REVIEWING_DAYS, 1, 365);
            if (parsed.listDays === "unlimited") {
                settings.listDays = "unlimited";
            } else {
                settings.listDays = String(clampInt(parsed.listDays, DEFAULT_LIST_DAYS, 1, 3650));
            }
        }

        return settings;
    }

    function saveSettings(settings) {
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        } catch (_) {}
    }

    function getReviewingDays() {
        return loadSettings().reviewingDays;
    }

    function getCutoffDays() {
        const value = loadSettings().listDays;
        if (value === "unlimited") return null;
        return clampInt(value, DEFAULT_LIST_DAYS, 1, 3650);
    }

    function getCutoffLabel() {
        const days = getCutoffDays();
        return days == null ? "unlimited history" : `last ${days} days`;
    }

    // Same hash used by Wayfarer Review History.
    function cyrb53(str, seed = 0) {
        let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
        for (let i = 0, ch; i < str.length; i++) {
            ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return 4294967296 * (2097151 & h2) + (h1 >>> 0);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function isProfileRoute() {
        // Current Wayfarer profile route usually contains /profile.
        return /\/profile(?:\/|$)/.test(location.pathname) || location.pathname.includes("/new/profile");
    }

    function onRouteChange(callback) {
        const wrap = (fn) => function () {
            const ret = fn.apply(this, arguments);
            setTimeout(callback, 150);
            return ret;
        };

        try {
            history.pushState = wrap(history.pushState);
            history.replaceState = wrap(history.replaceState);
        } catch (_) {}

        window.addEventListener("popstate", () => setTimeout(callback, 150));
        window.addEventListener("hashchange", () => setTimeout(callback, 150));
        setInterval(callback, 1500);
    }

    function awaitElement(selector, timeoutMs = 15000) {
        const start = Date.now();
        return new Promise((resolve, reject) => {
            const tick = () => {
                const el = document.querySelector(selector);
                if (el) return resolve(el);
                if (Date.now() - start > timeoutMs) return reject(new Error("Timed out waiting for " + selector));
                setTimeout(tick, 250);
            };
            tick();
        });
    }

    function openReviewHistoryDB(version) {
        return new Promise((resolve, reject) => {
            if (!window.indexedDB) {
                reject(new Error("This browser does not support IndexedDB."));
                return;
            }

            const req = indexedDB.open(DB_NAME, version);

            req.onsuccess = event => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(REVIEW_STORE_NAME)) {
                    const nextVersion = db.version + 1;
                    db.close();
                    openReviewHistoryDB(nextVersion).then(resolve, reject);
                    return;
                }
                resolve(db);
            };

            req.onupgradeneeded = event => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(REVIEW_STORE_NAME)) {
                    db.createObjectStore(REVIEW_STORE_NAME, { keyPath: "id" });
                }
            };

            req.onerror = () => reject(req.error || new Error("Failed to open IndexedDB."));
            req.onblocked = () => reject(new Error("IndexedDB is blocked. Close other Wayfarer tabs and reload."));
        });
    }

    async function loadReviewHistory() {
        const db = await openReviewHistoryDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(REVIEW_STORE_NAME, "readonly");
            const store = tx.objectStore(REVIEW_STORE_NAME);
            const req = store.getAll();

            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error || new Error("Failed to read review history."));
            tx.oncomplete = () => db.close();
            tx.onerror = () => {
                try { db.close(); } catch (_) {}
                reject(tx.error || new Error("Review history transaction failed."));
            };
        });
    }

    async function loadCurrentUserHash() {
        if (userHash != null) return userHash;

        try {
            const res = await fetch("/api/v1/vault/properties", {
                method: "GET",
                credentials: "include"
            });
            const json = await res.json();
            const email = json?.result?.socialProfile?.email;
            if (email) userHash = cyrb53(email);
        } catch (e) {
            console.warn("[WF Approval Checker] Could not load user hash; showing unfiltered review history.", e);
        }

        return userHash;
    }

    function validNumber(v) {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }

    function coordKey(lat, lng) {
        const latE6 = Math.round(Number(lat) * 1e6);
        const lngE6 = Math.round(Number(lng) * 1e6);
        return `${latE6},${lngE6}`;
    }

    function getRecordLatLng(rec) {
        const lat = validNumber(rec?.lat);
        const lng = validNumber(rec?.lng);
        if (lat != null && lng != null) return { lat, lng };

        // Some EDIT records can carry location edit candidates. Fall back to the first usable edit.
        const edits = rec?.locationEdits;
        if (Array.isArray(edits)) {
            for (const e of edits) {
                const eLat = validNumber(e?.lat);
                const eLng = validNumber(e?.lng);
                if (eLat != null && eLng != null) return { lat: eLat, lng: eLng };
            }
        }

        return null;
    }

    function summarizeUserReview(rec) {
        const review = rec?.review;
        if (review === "skipped") return "Skipped";
        if (!review || typeof review !== "object") return "Timed out/Pending";

        if (review.duplicate != null && review.duplicate !== false) return "Duplicate";

        // Newer Wayfarer review flow: a present quality score means the reviewer accepted the nomination.
        if (review.quality != null && review.quality !== false) return "You approved";

        const reasons = Array.isArray(review.rejectReasons)
            ? review.rejectReasons
            : (review.rejectReason ? [review.rejectReason] : []);

        if (reasons.length) {
            return "You rejected: " + reasons.join(", ");
        }

        if (review.spam) return "You rejected: spam";
        return "Submitted";
    }

    function classifyUserReview(text) {
        const t = String(text || "").toLowerCase();
        if (t.startsWith("you approved")) return "approved";
        if (t.startsWith("you rejected")) return "rejected";
        if (t.includes("duplicate")) return "duplicate";
        if (t.includes("skipped")) return "skipped";
        if (t.includes("timed out") || t.includes("pending")) return "pending";
        return "other";
    }

    function normalizeReviewRecord(rec) {
        const ll = getRecordLatLng(rec);
        if (!ll) return null;

        const ts = Number(rec.ts || rec.timestampMs || rec.timestamp || 0);
        const title =
            (typeof rec.title === "string" && rec.title.trim()) ||
            (typeof rec.review?.title === "string" && rec.review.title.trim()) ||
            "(untitled)";

        return {
            raw: rec,
            id: rec.id || rec.review?.id || coordKey(ll.lat, ll.lng),
            title,
            type: rec.type || rec.review?.type || "",
            userReview: summarizeUserReview(rec),
            lat: ll.lat,
            lng: ll.lng,
            key: coordKey(ll.lat, ll.lng),
            ts: Number.isFinite(ts) ? ts : 0,
            ageDays: Number.isFinite(ts) && ts > 0 ? Math.floor((Date.now() - ts) / 86400000) : null
        };
    }

    function exactCoordMatch(p, wantedLatE6, wantedLngE6) {
        const latE6 = (typeof p?.latE6 === "number") ? p.latE6 : Math.round(Number(p?.lat) * 1e6);
        const lngE6 = (typeof p?.lngE6 === "number") ? p.lngE6 : Math.round(Number(p?.lng) * 1e6);

        // "Exact" after E6 rounding. The ±1 guard prevents float/string rounding edge cases.
        return Math.abs(latE6 - wantedLatE6) <= 1 && Math.abs(lngE6 - wantedLngE6) <= 1;
    }

    function normalizeTitleForMatch(value) {
        return String(value || "")
            .normalize("NFC")
            .replace(/\s+/g, " ")
            .trim()
            .toLocaleLowerCase();
    }

    function poiLatLng(p) {
        const lat = (typeof p?.latE6 === "number") ? p.latE6 / 1e6 : Number(p?.lat);
        const lng = (typeof p?.lngE6 === "number") ? p.lngE6 / 1e6 : Number(p?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return { lat, lng };
    }

    function distanceMeters(aLat, aLng, bLat, bLng) {
        const toRad = deg => deg * Math.PI / 180;
        const R = 6371000;
        const dLat = toRad(bLat - aLat);
        const dLng = toRad(bLng - aLng);
        const lat1 = toRad(aLat);
        const lat2 = toRad(bLat);
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }

    function extractPoisFromGcs(json) {
        const out = [];
        const cells = json?.result?.data;
        if (!Array.isArray(cells)) return out;

        for (const cell of cells) {
            const pois = Array.isArray(cell?.pois) ? cell.pois : [];
            for (const p of pois) out.push(p);
        }

        return out;
    }

    function normalizePoiForDisplay(p) {
        if (!p) return null;
        return {
            guid: String(p.poiId || p.guid || ""),
            title: p.title || "",
            lat: (typeof p.latE6 === "number") ? p.latE6 / 1e6 : Number(p.lat),
            lng: (typeof p.lngE6 === "number") ? p.lngE6 / 1e6 : Number(p.lng),
            imageUrl: p.mainImage || p.imageUrl || ""
        };
    }

    function emptyCompactCache() {
        return { version: 6, createdAt: Date.now(), updatedAt: Date.now(), items: {} };
    }

    function normalizeCompactEntry(entry, record) {
        if (!entry) return null;
        let state = entry.s || entry.state;
        if (state === "a") state = "approved";
        if (state === "r") state = "reviewing";
        if (state === "l") state = "likely-rejected";
        if (!state) return null;

        if (state !== "approved") {
            const cachedAt = Number(entry.t || entry.cachedAt || 0);
            if (!cachedAt || Date.now() - cachedAt > CACHE_TTL_MS) return null;

            // v0.5.11+ non-approved cache is only trusted when the 100m nearby relocation
            // check has also been done. Older non-approved cache is ignored and recalculated.
            if (!(entry.n === 1 || entry.nearbyChecked)) return null;

            // Non-approved cache only means "not found exact or same-name nearby at last check".
            // Whether that is Reviewing or Likely rejected depends on the current age threshold setting.
            const age = record?.ageDays;
            if (age != null) state = age < getReviewingDays() ? "reviewing" : "likely-rejected";
        }

        if (state === "approved") {
            const rawPoi = entry.p || null;
            const poi = rawPoi && typeof rawPoi === "object"
                ? {
                    title: rawPoi.title || "",
                    lat: Number(rawPoi.lat),
                    lng: Number(rawPoi.lng),
                    distanceMeters: Number(rawPoi.d || rawPoi.distanceMeters || 0)
                }
                : rawPoi ? { title: String(rawPoi) } : null;
            const relocated = !!(entry.relocated || entry.m === 1 || (poi && Number.isFinite(poi.distanceMeters) && poi.distanceMeters > 0));
            return {
                state: "approved",
                label: relocated ? formatRelocatedLabel(poi?.distanceMeters, poi?.lat, poi?.lng) : "Approved",
                className: "wfap-status-approved",
                poi,
                relocated,
                checkedAt: Number(entry.t || entry.cachedAt || Date.now())
            };
        }

        if (state === "reviewing") {
            const age = record?.ageDays;
            return {
                state: "reviewing",
                label: (age != null) ? `Reviewing (${age}d / <${getReviewingDays()}d)` : "Reviewing",
                className: "wfap-status-reviewing",
                poi: null,
                checkedAt: Number(entry.t || entry.cachedAt || Date.now())
            };
        }

        return {
            state: "likely-rejected",
            label: "Likely rejected",
            className: "wfap-status-rejected",
            poi: null,
            checkedAt: Number(entry.t || entry.cachedAt || Date.now())
        };
    }

    let compactCacheMemory = null;

    function loadCompactCache() {
        if (compactCacheMemory) return compactCacheMemory;

        let cache = null;
        try {
            cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
        } catch (_) {
            cache = null;
        }

        if (!cache || typeof cache !== "object" || !cache.items || typeof cache.items !== "object") {
            cache = emptyCompactCache();
        }

        // One-time migration from old per-coordinate keys.
        // Important: old versions wrote hundreds/thousands of localStorage records like
        // wf_review_approval_checker_v1:lat,lng. That is why browser storage grew fast.
        let migrated = false;
        const keysToRemove = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const storageKey = localStorage.key(i);
                if (!storageKey) continue;
                const prefix = LEGACY_CACHE_PREFIXES.find(p => storageKey.startsWith(p));
                if (!prefix) continue;

                keysToRemove.push(storageKey);
                const coordKey = storageKey.slice(prefix.length);
                if (!coordKey || cache.items[coordKey]) continue;

                try {
                    const old = JSON.parse(localStorage.getItem(storageKey) || "null");
                    const value = old?.value;
                    if (value?.state === "approved") {
                        cache.items[coordKey] = {
                            s: "a",
                            t: Number(old.cachedAt || value.checkedAt || Date.now()),
                            p: value.poi?.title ? String(value.poi.title).slice(0, 120) : ""
                        };
                        migrated = true;
                    }
                    // Do not migrate old Reviewing/Likely rejected. They expire quickly and can become wrong by age.
                } catch (_) {}
            }
        } catch (_) {}

        // Remove old one-key and per-coordinate cache records after collecting approved results.
        for (const storageKey of keysToRemove) {
            try { localStorage.removeItem(storageKey); } catch (_) {}
        }
        try { localStorage.removeItem("wf_review_approval_checker_stats_v4"); } catch (_) {}
        try { localStorage.removeItem("wf_review_approval_checker_stats_v3"); } catch (_) {}
        try { localStorage.removeItem("wf_review_approval_checker_stats_v2"); } catch (_) {}
        try { localStorage.removeItem("wf_review_approval_checker_stats_v1"); } catch (_) {}

        compactCacheMemory = cache;
        pruneCompactCache();
        if (migrated || keysToRemove.length) saveCompactCache();
        return compactCacheMemory;
    }

    function saveCompactCache() {
        if (!compactCacheMemory) return;
        try {
            compactCacheMemory.updatedAt = Date.now();
            localStorage.setItem(CACHE_KEY, JSON.stringify(compactCacheMemory));
        } catch (err) {
            // Last-resort: if storage is full, keep approved entries first and drop temporary entries.
            try {
                const entries = Object.entries(compactCacheMemory.items || {});
                compactCacheMemory.items = Object.fromEntries(entries.filter(([, v]) => (v.s || v.state) === "a"));
                localStorage.setItem(CACHE_KEY, JSON.stringify(compactCacheMemory));
            } catch (_) {
                console.warn("[WF Approval Checker] Could not save compact cache:", err);
            }
        }
    }

    function pruneCompactCache() {
        const cache = loadCompactCache();
        const now = Date.now();
        const entries = Object.entries(cache.items || {});
        const kept = [];

        for (const [key, entry] of entries) {
            const state = entry.s || entry.state;
            const t = Number(entry.t || entry.cachedAt || 0);
            if (state === "a" || state === "approved") kept.push([key, entry]);
            else if (t && now - t <= CACHE_TTL_MS) kept.push([key, entry]);
        }

        kept.sort((a, b) => Number(b[1].t || b[1].cachedAt || 0) - Number(a[1].t || a[1].cachedAt || 0));
        cache.items = Object.fromEntries(kept.slice(0, MAX_CACHE_ENTRIES));
    }

    function getCachedStatus(key, record = null) {
        try {
            const cache = loadCompactCache();
            return normalizeCompactEntry(cache.items[key], record);
        } catch (_) {
            return null;
        }
    }

    function setCachedStatus(key, value) {
        try {
            const cache = loadCompactCache();
            const item = {
                s: value.state === "approved" ? "a" : value.state === "reviewing" ? "r" : "l",
                t: Date.now()
            };

            if (value.poi?.title || value.poi?.lat != null || value.poi?.lng != null) {
                item.p = {
                    title: value.poi?.title ? String(value.poi.title).slice(0, 120) : "",
                    lat: Number.isFinite(Number(value.poi?.lat)) ? Number(value.poi.lat) : undefined,
                    lng: Number.isFinite(Number(value.poi?.lng)) ? Number(value.poi.lng) : undefined,
                    d: Number.isFinite(Number(value.poi?.distanceMeters)) ? Math.round(Number(value.poi.distanceMeters)) : undefined
                };
                Object.keys(item.p).forEach(k => item.p[k] === undefined && delete item.p[k]);
            }

            if (value.relocated || value.label?.toLowerCase?.().includes("relocated")) item.relocated = true;
            if (value.nearbyChecked && item.s !== "a") item.n = 1;

            cache.items[key] = item;
            pruneCompactCache();
            saveCompactCache();
        } catch (_) {}
    }

    async function queryGcsExact(lat, lng) {
        const delta = 0.0015; // small box around the submitted coordinate
        const neLat = lat + delta;
        const neLng = lng + delta;
        const swLat = lat - delta;
        const swLng = lng - delta;

        const url =
            `${GCS_ENDPOINT}` +
            `?ne=(${neLat},${neLng})` +
            `&sw=(${swLat},${swLng})` +
            `&cellLevel=${CELL_LEVEL}`;

        const res = await fetch(url, {
            method: "GET",
            credentials: "include"
        });

        if (!res.ok) throw new Error("GCS HTTP " + res.status);

        const json = await res.json();
        if (json?.captcha) throw new Error("Wayfarer requested captcha.");
        if (json?.code && json.code !== "OK") throw new Error("GCS returned " + json.code);

        const wantedLatE6 = Math.round(lat * 1e6);
        const wantedLngE6 = Math.round(lng * 1e6);
        const pois = extractPoisFromGcs(json);
        const exact = pois.find(p => exactCoordMatch(p, wantedLatE6, wantedLngE6));

        return exact ? normalizePoiForDisplay(exact) : null;
    }

    async function queryGcsNearbyName(lat, lng, title, radiusM = RELOCATION_RADIUS_M) {
        const titleKey = normalizeTitleForMatch(title);
        if (!titleKey) return null;

        const latDelta = radiusM / 111320;
        const lngDelta = radiusM / (111320 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
        const neLat = lat + latDelta;
        const neLng = lng + lngDelta;
        const swLat = lat - latDelta;
        const swLng = lng - lngDelta;

        const url =
            `${GCS_ENDPOINT}` +
            `?ne=(${neLat},${neLng})` +
            `&sw=(${swLat},${swLng})` +
            `&cellLevel=${CELL_LEVEL}`;

        const res = await fetch(url, {
            method: "GET",
            credentials: "include"
        });

        if (!res.ok) throw new Error("GCS nearby HTTP " + res.status);

        const json = await res.json();
        if (json?.captcha) throw new Error("Wayfarer requested captcha.");
        if (json?.code && json.code !== "OK") throw new Error("GCS nearby returned " + json.code);

        const pois = extractPoisFromGcs(json);
        let best = null;
        let bestDistance = Infinity;

        for (const poi of pois) {
            if (normalizeTitleForMatch(poi?.title) !== titleKey) continue;
            const ll = poiLatLng(poi);
            if (!ll) continue;
            const meters = distanceMeters(lat, lng, ll.lat, ll.lng);
            if (meters <= radiusM && meters < bestDistance) {
                best = poi;
                bestDistance = meters;
            }
        }

        if (!best) return null;
        const normalized = normalizePoiForDisplay(best);
        normalized.distanceMeters = bestDistance;
        return normalized;
    }

    async function queryLivePoisExact(lat, lng) {
        // Fallback only. GCS is the main map source; live-pois can catch some active game objects.
        const url = `${LIVE_ENDPOINT}?lat=${lat}&lng=${lng}&radius=80`;

        const res = await fetch(url, {
            method: "GET",
            credentials: "include"
        });

        if (!res.ok) return null;

        const json = await res.json();
        const pois = json?.result?.pois;
        if (!Array.isArray(pois)) return null;

        const wantedLatE6 = Math.round(lat * 1e6);
        const wantedLngE6 = Math.round(lng * 1e6);
        const exact = pois.find(p => exactCoordMatch(p, wantedLatE6, wantedLngE6));

        return exact ? normalizePoiForDisplay(exact) : null;
    }

    async function checkRecord(record, force = false) {
        if (!force) {
            const cached = getCachedStatus(record.key, record);
            if (cached) return cached;
        }

        const found = await queryGcsExact(record.lat, record.lng).catch(err => {
            console.warn("[WF Approval Checker] GCS exact check failed:", err);
            return null;
        }) || await queryLivePoisExact(record.lat, record.lng).catch(() => null);

        let result;
        if (found) {
            result = {
                state: "approved",
                label: "Approved",
                className: "wfap-status-approved",
                poi: found,
                checkedAt: Date.now()
            };
            setCachedStatus(record.key, result);
            return result;
        }

        // Better v0.5.11 logic: if the exact pin is not present, immediately check
        // whether the approved wayspot was relocated within 100m under the same name.
        const relocated = await queryGcsNearbyName(record.lat, record.lng, record.title, RELOCATION_RADIUS_M).catch(err => {
            console.warn("[WF Approval Checker] GCS nearby relocation check failed:", err);
            return null;
        });

        if (relocated) {
            const meters = Math.round(relocated.distanceMeters || 0);
            result = {
                state: "approved",
                label: formatRelocatedLabel(meters, relocated.lat, relocated.lng),
                className: "wfap-status-approved",
                poi: { ...relocated, distanceMeters: meters },
                relocated: true,
                checkedAt: Date.now()
            };
            setCachedStatus(record.key, result);
            return result;
        }

        if (record.ageDays != null && record.ageDays < getReviewingDays()) {
            result = {
                state: "reviewing",
                label: `Reviewing (${record.ageDays}d / <${getReviewingDays()}d)\n(Relocated checked)`,
                className: "wfap-status-reviewing",
                poi: null,
                nearbyChecked: true,
                checkedAt: Date.now()
            };
        } else {
            result = {
                state: "likely-rejected",
                label: "Likely rejected\n(Relocated checked)",
                className: "wfap-status-rejected",
                poi: null,
                nearbyChecked: true,
                checkedAt: Date.now()
            };
        }

        setCachedStatus(record.key, result);
        return result;
    }

    async function checkRelocatedRecord(record, force = false) {
        if (!force) {
            const cached = getCachedStatus(record.key, record);
            if (cached?.state === "approved") return cached;
        }

        const found = await queryGcsNearbyName(record.lat, record.lng, record.title, RELOCATION_RADIUS_M).catch(err => {
            console.warn("[WF Approval Checker] Nearby relocation check failed:", err);
            return null;
        });

        if (!found) {
            // Do not persist a special "rejected relocated-checked" state.
            // The note is only for the current page session; after refresh it returns to normal Likely rejected.
            return {
                state: "likely-rejected",
                label: "Likely rejected\n(Relocated checked)",
                className: "wfap-status-rejected",
                poi: null,
                nearbyChecked: true,
                checkedAt: Date.now()
            };
        }

        const meters = Math.round(found.distanceMeters || 0);
        const result = {
            state: "approved",
            label: formatRelocatedLabel(meters, found.lat, found.lng),
            className: "wfap-status-approved",
            poi: { ...found, distanceMeters: meters },
            relocated: true,
            checkedAt: Date.now()
        };
        setCachedStatus(record.key, result);
        return result;
    }

    function enqueueCheck(fn) {
        return new Promise((resolve, reject) => {
            pendingChecks.push({ fn, resolve, reject });
            pumpQueue();
        });
    }

    function pumpQueue() {
        while (activeChecks < CONCURRENT_CHECKS && pendingChecks.length) {
            const item = pendingChecks.shift();
            activeChecks++;
            (async () => {
                await sleep(REQUEST_DELAY_MS);
                return item.fn();
            })()
                .then(item.resolve, item.reject)
                .catch(err => console.error("[WF Approval Checker] Queue error:", err))
                .finally(() => {
                    activeChecks--;
                    pumpQueue();
                });
        }
    }

    function ymd(ts) {
        if (!ts) return "";
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) return "";
        return d.toISOString().slice(0, 10);
    }

    function mapUrl(lat, lng) {
        return `/new/mapview?${lat},${lng}`;
    }

    function formatCoord(lat, lng) {
        const nLat = Number(lat);
        const nLng = Number(lng);
        if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return "";
        return `${nLat.toFixed(6)}, ${nLng.toFixed(6)}`;
    }

    function formatRelocatedLabel(distanceMeters, lat, lng) {
        const meters = Math.round(Number(distanceMeters) || 0);
        const coord = formatCoord(lat, lng);
        return coord ? `Approved relocated (${meters}m)\n${coord}` : `Approved relocated (${meters}m)`;
    }

    function setStatusCell(row, result) {
        const cell = row.querySelector(".wfap-status");
        if (!cell) return;

        cell.className = "wfap-status " + (result.className || "");
        cell.textContent = result.label || "Unknown";
        row.dataset.status = result.state || "";

        const btn = row.querySelector(".wfap-row-check");
        if (btn && result.state === "approved") {
            btn.disabled = true;
            btn.textContent = "Approved";
            btn.title = "Already approved; skipped by Check all.";
        }

        if (result.poi?.title) {
            const coord = formatCoord(result.poi.lat, result.poi.lng);
            const distance = Number.isFinite(Number(result.poi.distanceMeters)) ? ` (${Math.round(Number(result.poi.distanceMeters))}m from reviewed pin)` : "";
            cell.title = `Matched map wayspot: ${result.poi.title}${distance}${coord ? ` at ${coord}` : ""}`;
        } else {
            cell.title = result.nearbyChecked ? `Nearby relocation check completed: no same-name wayspot within ${RELOCATION_RADIUS_M}m.` : "";
        }

        const panel = row.closest(`#${PANEL_ID}`);
        if (panel) {
            updateStats(panel);
            applyFiltersAndSort(panel);
        }
    }

    function rowAlreadyApproved(row, record) {
        if (row?.dataset?.status === "approved") return true;
        const cached = record ? getCachedStatus(record.key, record) : null;
        if (cached?.state === "approved") {
            setStatusCell(row, cached);
            return true;
        }
        return false;
    }

    function createRow(record, index) {
        const tr = document.createElement("tr");
        tr.dataset.key = record.key;
        tr.dataset.title = (record.title || "").toLowerCase();
        tr.dataset.status = "";
        tr.dataset.ts = String(record.ts || 0);
        tr.dataset.userReview = (record.userReview || "").toLowerCase();
        tr.dataset.reviewKind = classifyUserReview(record.userReview);

        const tdIndex = document.createElement("td");
        tdIndex.textContent = String(index + 1);

        const tdDate = document.createElement("td");
        tdDate.textContent = ymd(record.ts);

        const tdAge = document.createElement("td");
        tdAge.textContent = record.ageDays == null ? "?" : `${record.ageDays}d`;

        const tdTitle = document.createElement("td");
        tdTitle.textContent = record.title;
        tdTitle.title = record.title;

        const tdReview = document.createElement("td");
        tdReview.textContent = record.userReview || "";
        tdReview.title = record.userReview || "";

        const tdCoord = document.createElement("td");
        const coordLink = document.createElement("a");
        coordLink.href = mapUrl(record.lat, record.lng);
        coordLink.target = "_blank";
        coordLink.rel = "noopener noreferrer";
        coordLink.textContent = `${record.lat.toFixed(6)}, ${record.lng.toFixed(6)}`;
        tdCoord.appendChild(coordLink);

        const tdStatus = document.createElement("td");
        tdStatus.className = "wfap-status";
        tdStatus.textContent = "Not checked";

        const tdAction = document.createElement("td");

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "wfap-btn wfap-row-check";
        btn.textContent = "Check";
        btn.addEventListener("click", () => {
            if (rowAlreadyApproved(tr, record)) return;

            btn.disabled = true;
            tdStatus.className = "wfap-status wfap-status-checking";
            tdStatus.textContent = "Checking…";

            enqueueCheck(async () => {
                const result = await checkRecord(record, true);
                setStatusCell(tr, result);
                if (result.state !== "approved") btn.disabled = false;
            });
        });

        tdAction.appendChild(btn);

        tr.append(tdIndex, tdDate, tdAge, tdTitle, tdReview, tdCoord, tdStatus, tdAction);

        const cached = getCachedStatus(record.key, record);
        if (cached) setStatusCell(tr, cached);

        return tr;
    }

    async function buildPanel() {
        const panel = document.createElement("section");
        panel.id = PANEL_ID;
        panel.innerHTML = `
            <div class="wfap-head">
                <div>
                    <h2>Recent Review Map Status</h2>
                    <p>
                        Loads nomination reviews using your cutoff setting, checks their exact coordinates against Wayfarer Map,
                        then classifies them as Approved, Reviewing, or Likely rejected using your chosen day threshold. The rejected-nearby check searches 100m around likely rejected pins and marks same-name relocated wayspots as approved relocated with distance and new coordinate. Rejected rows only show a temporary relocated-checked note and are not persisted as a special relocated state.
                    </p>
                </div>
                <div class="wfap-actions">
                    <button type="button" class="wfap-btn wfap-refresh">Reload history</button>
                    <button type="button" class="wfap-btn wfap-check-visible">Check unchecked</button>
                    <button type="button" class="wfap-btn wfap-check-relocated">Recheck rejected nearby</button>
                </div>
            </div>
            <div class="wfap-stats wfap-block"></div>
            <div class="wfap-summary wfap-block">Loading review history…</div>
            <div class="wfap-controls wfap-block">
                <label>Rejected after: <input type="number" class="wfap-reviewing-days" min="1" max="365" step="1"> days</label>
                <label>Load cutoff: <select class="wfap-list-days">
                    <option value="7">7 days</option>
                    <option value="14">14 days</option>
                    <option value="15">15 days</option>
                    <option value="30">30 days</option>
                    <option value="60">60 days</option>
                    <option value="90">90 days</option>
                    <option value="180">180 days</option>
                    <option value="365">365 days</option>
                    <option value="unlimited">Unlimited</option>
                </select></label>
                <label>Search title: <input type="search" class="wfap-search" placeholder="Submission name"></label>
                <label>Status: <select class="wfap-status-filter">
                    <option value="">All</option>
                    <option value="approved">Approved</option>
                    <option value="reviewing">Reviewing</option>
                    <option value="likely-rejected">Likely rejected</option>
                    <option value="unchecked">Not checked</option>
                </select></label>
                <label>Your review: <select class="wfap-review-filter">
                    <option value="">All</option>
                    <option value="approved">You approved</option>
                    <option value="rejected">You rejected</option>
                    <option value="duplicate">Duplicate</option>
                    <option value="skipped">Skipped</option>
                    <option value="pending">Timed out/Pending</option>
                </select></label>
                <label>Sort: <select class="wfap-sort">
                    <option value="date-desc">Newest first</option>
                    <option value="date-asc">Oldest first</option>
                    <option value="status">Status: Approved → Reviewing → Likely rejected → Not checked</option>
                    <option value="status-reverse">Status: Likely rejected → Reviewing → Approved → Not checked</option>
                    <option value="title">Title A → Z</option>
                    <option value="review">Your review A → Z</option>
                    <option value="status-review">Status, then your review</option>
                    <option value="review-status">Your review, then status</option>
                </select></label>
            </div>
            <div class="wfap-visible-counts wfap-block"></div>
            <div class="wfap-table-wrap"></div>
            <div class="wfap-analytics wfap-block"></div>
        `;

        const initialSettings = loadSettings();
        const reviewingInput = panel.querySelector(".wfap-reviewing-days");
        const listDaysSelect = panel.querySelector(".wfap-list-days");
        if (reviewingInput) reviewingInput.value = String(initialSettings.reviewingDays);
        if (listDaysSelect) listDaysSelect.value = initialSettings.listDays;

        panel.querySelector(".wfap-refresh").addEventListener("click", () => renderTable(panel));
        panel.querySelector(".wfap-check-visible").addEventListener("click", () => checkAllRows(panel));
        panel.querySelector(".wfap-check-relocated").addEventListener("click", () => checkRejectedNearbyRows(panel));
        panel.querySelector(".wfap-search").addEventListener("input", () => applyFiltersAndSort(panel));
        panel.querySelector(".wfap-status-filter").addEventListener("change", () => applyFiltersAndSort(panel));
        panel.querySelector(".wfap-review-filter").addEventListener("change", () => applyFiltersAndSort(panel));
        panel.querySelector(".wfap-sort").addEventListener("change", () => applyFiltersAndSort(panel));
        if (reviewingInput) {
            reviewingInput.addEventListener("change", () => {
                const settings = loadSettings();
                settings.reviewingDays = clampInt(reviewingInput.value, DEFAULT_REVIEWING_DAYS, 1, 365);
                reviewingInput.value = String(settings.reviewingDays);
                saveSettings(settings);
                renderTable(panel);
            });
        }
        if (listDaysSelect) {
            listDaysSelect.addEventListener("change", () => {
                const settings = loadSettings();
                settings.listDays = listDaysSelect.value === "unlimited" ? "unlimited" : String(clampInt(listDaysSelect.value, DEFAULT_LIST_DAYS, 1, 3650));
                listDaysSelect.value = settings.listDays;
                saveSettings(settings);
                renderTable(panel);
            });
        }

        renderPersistedStats(panel);
        await renderTable(panel);
        return panel;
    }

    async function renderTable(panel) {
        const summary = panel.querySelector(".wfap-summary");
        const wrap = panel.querySelector(".wfap-table-wrap");
        summary.textContent = "Loading review history…";
        wrap.textContent = "";

        try {
            const currentHash = await loadCurrentUserHash();
            const all = await loadReviewHistory();

            const nominationRows = all
                .filter(r => !currentHash || r.userHash == null || String(r.userHash) === String(currentHash))
                .map(normalizeReviewRecord)
                .filter(Boolean)
                .filter(r => !r.type || String(r.type).toUpperCase() === "NEW")
                .sort((a, b) => (b.ts || 0) - (a.ts || 0));

            const cutoffDays = getCutoffDays();
            const rowsMatchingCutoff = cutoffDays == null
                ? nominationRows
                : nominationRows.filter(r => r.ageDays == null || r.ageDays <= cutoffDays);

            // Listing rule:
            // - Use the selected cutoff window (for example 15 days, 30 days, or unlimited).
            // - Always hard-cap displayed rows at 2000 to protect browser performance.
            const rows = rowsMatchingCutoff.slice(0, HARD_MAX_ROWS);

            const table = document.createElement("table");
            table.className = "wfap-table";
            table.innerHTML = `
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Reviewed</th>
                        <th>Age</th>
                        <th>Title</th>
                        <th>Your review</th>
                        <th>Coordinate</th>
                        <th>Status</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody></tbody>
            `;

            const tbody = table.querySelector("tbody");
            rows.forEach((record, i) => tbody.appendChild(createRow(record, i)));

            wrap.appendChild(table);
            panel._wfapRecords = rows;
            updateStats(panel);
            applyFiltersAndSort(panel);

            const cutoffText = getCutoffLabel();
            const capText = rowsMatchingCutoff.length > HARD_MAX_ROWS ? ` Showing newest ${HARD_MAX_ROWS} due to the hard cap.` : "";
            summary.textContent = `Loaded ${rows.length}/${rowsMatchingCutoff.length} nomination review-history records from ${cutoffText} with coordinates.${capText}`;
            if (!rows.length) {
                summary.textContent = `No nomination review-history records with coordinates were found. Review some nominations first, or import your Review History data.`;
            }
        } catch (e) {
            console.error("[WF Approval Checker] Failed to render table:", e);
            summary.textContent = "Failed to load review history: " + (e?.message || e);
        }
    }

    function computeStats(panel) {
        const rows = Array.from(panel.querySelectorAll("tbody tr"));
        const stats = { total: rows.length, approved: 0, reviewing: 0, rejected: 0, unchecked: 0, updatedAt: Date.now() };
        for (const row of rows) {
            const state = row.dataset.status || "";
            if (state === "approved") stats.approved++;
            else if (state === "reviewing") stats.reviewing++;
            else if (state === "likely-rejected") stats.rejected++;
            else stats.unchecked++;
        }
        return stats;
    }

    function loadPersistedStats() {
        try {
            return JSON.parse(localStorage.getItem(STATS_KEY) || "null");
        } catch (_) {
            return null;
        }
    }

    function savePersistedStats(stats) {
        try {
            localStorage.setItem(STATS_KEY, JSON.stringify(stats));
        } catch (_) {}
    }

    function updateStats(panel) {
        const statsEl = panel.querySelector(".wfap-stats");
        if (!statsEl) return;
        const stats = computeStats(panel);
        savePersistedStats(stats);
        const previous = loadPersistedStats();
        const date = new Date((previous || stats).updatedAt || Date.now()).toLocaleString();
        statsEl.textContent = `Stats (general): ${stats.approved} approved • ${stats.reviewing} reviewing (<${getReviewingDays()}d) • ${stats.rejected} likely rejected • ${stats.unchecked} not checked • ${stats.total} total. Last saved: ${date}`;
    }

    function renderPersistedStats(panel) {
        const statsEl = panel.querySelector(".wfap-stats");
        if (!statsEl) return;
        const stats = loadPersistedStats();
        if (!stats) return;
        const date = new Date(stats.updatedAt || Date.now()).toLocaleString();
        statsEl.textContent = `Stats (general, saved): ${stats.approved || 0} approved • ${stats.reviewing || 0} reviewing (<${getReviewingDays()}d) • ${stats.rejected || 0} likely rejected • ${stats.unchecked || 0} not checked • ${stats.total || 0} total. Last saved: ${date}`;
    }

    function updateVisibleCounters(panel) {
        const countsEl = panel.querySelector(".wfap-visible-counts");
        const tbody = panel.querySelector("tbody");
        if (!countsEl || !tbody) return;

        const rows = Array.from(tbody.querySelectorAll("tr"));
        const visibleRows = rows.filter(row => row.style.display !== "none");
        const reviewCounts = {
            approved: 0,
            rejected: 0,
            duplicate: 0,
            skipped: 0,
            pending: 0,
            other: 0
        };
        const statusCounts = {
            approved: 0,
            reviewing: 0,
            rejected: 0,
            unchecked: 0
        };

        for (const row of visibleRows) {
            const reviewKind = row.dataset.reviewKind || "other";
            if (Object.prototype.hasOwnProperty.call(reviewCounts, reviewKind)) reviewCounts[reviewKind]++;
            else reviewCounts.other++;

            const status = row.dataset.status || "unchecked";
            if (status === "approved") statusCounts.approved++;
            else if (status === "reviewing") statusCounts.reviewing++;
            else if (status === "likely-rejected") statusCounts.rejected++;
            else statusCounts.unchecked++;
        }

        countsEl.textContent = `Stats (current search/sort): showing ${visibleRows.length}/${rows.length} rows • Your review: ${reviewCounts.approved} approved, ${reviewCounts.rejected} rejected, ${reviewCounts.duplicate} duplicate, ${reviewCounts.skipped} skipped, ${reviewCounts.pending} pending • Status: ${statusCounts.approved} approved, ${statusCounts.reviewing} reviewing, ${statusCounts.rejected} likely rejected, ${statusCounts.unchecked} not checked`;
        updateAnalytics(panel);
    }

    function percent(n, d) {
        if (!d) return "0.0%";
        return `${((n / d) * 100).toFixed(1)}%`;
    }

    function resolvedKindFromRow(row) {
        const status = row.dataset.status || "";
        if (status === "approved") return "approved";
        if (status === "likely-rejected") return "rejected";
        return ""; // excludes reviewing, unchecked, checking, errors
    }

    function userDecisionKindFromRow(row) {
        const reviewKind = row.dataset.reviewKind || "";
        if (reviewKind === "approved") return "approved";
        // Treat duplicate as a reject decision for Approved/Rejected comparison.
        if (reviewKind === "rejected" || reviewKind === "duplicate") return "rejected";
        return ""; // skipped/pending/other are not used for agreement math
    }

    function buildAnalyticsData(panel) {
        const tbody = panel.querySelector("tbody");
        if (!tbody) return null;
        const visibleRows = Array.from(tbody.querySelectorAll("tr")).filter(row => row.style.display !== "none");

        const data = {
            consideredRows: 0,
            userTotal: 0,
            solutionTotal: 0,
            yourApproved: 0,
            yourRejected: 0,
            solutionApproved: 0,
            solutionRejected: 0,
            approveButRejected: 0,
            rejectButApproved: 0,
            agreement: 0,
            disagreement: 0
        };

        for (const row of visibleRows) {
            const solution = resolvedKindFromRow(row);
            if (!solution) continue; // requested: exclude Reviewing review submissions
            data.consideredRows++;
            if (solution === "approved") data.solutionApproved++;
            else data.solutionRejected++;

            const userDecision = userDecisionKindFromRow(row);
            if (!userDecision) continue;
            data.userTotal++;
            if (userDecision === "approved") data.yourApproved++;
            else data.yourRejected++;

            if (userDecision === solution) {
                data.agreement++;
            } else {
                data.disagreement++;
                if (userDecision === "approved" && solution === "rejected") data.approveButRejected++;
                if (userDecision === "rejected" && solution === "approved") data.rejectButApproved++;
            }
        }

        data.solutionTotal = data.solutionApproved + data.solutionRejected;
        return data;
    }

    function updateAnalytics(panel) {
        const box = panel.querySelector(".wfap-analytics");
        if (!box) return;
        const data = buildAnalyticsData(panel);
        if (!data) {
            box.textContent = "";
            return;
        }

        const maxValue = Math.max(data.yourApproved, data.yourRejected, data.solutionApproved, data.solutionRejected, 1);
        const barWidth = (value) => Math.max(2, Math.round((value / maxValue) * 100));

        box.innerHTML = `
            <h3>Resolved review comparison</h3>
            <p class="wfap-analytics-note">Uses the current search/filter/sort view. Reviewing, not checked, skipped, and pending rows are excluded from agreement math.</p>
            <div class="wfap-chart" aria-label="Your review versus review resolution bar chart">
                <div class="wfap-chart-row">
                    <div class="wfap-chart-label">Approved</div>
                    <div class="wfap-chart-bars">
                        <div class="wfap-chart-bar wfap-chart-user" style="width:${barWidth(data.yourApproved)}%"><span>Your review: ${data.yourApproved}</span></div>
                        <div class="wfap-chart-bar wfap-chart-solution" style="width:${barWidth(data.solutionApproved)}%"><span>Review resolution: ${data.solutionApproved}</span></div>
                    </div>
                </div>
                <div class="wfap-chart-row">
                    <div class="wfap-chart-label">Rejected</div>
                    <div class="wfap-chart-bars">
                        <div class="wfap-chart-bar wfap-chart-user" style="width:${barWidth(data.yourRejected)}%"><span>Your review: ${data.yourRejected}</span></div>
                        <div class="wfap-chart-bar wfap-chart-solution" style="width:${barWidth(data.solutionRejected)}%"><span>Review resolution: ${data.solutionRejected}</span></div>
                    </div>
                </div>
            </div>
            <div class="wfap-chart-legend">
                <span><i class="wfap-legend-user"></i>Your review</span>
                <span><i class="wfap-legend-solution"></i>Review resolution</span>
            </div>
            <div class="wfap-resolution-table-wrap">
                <table class="wfap-resolution-table">
                    <thead>
                        <tr><th>Metric</th><th>Your review</th><th>Review resolution</th></tr>
                    </thead>
                    <tbody>
                        <tr><td>Approved</td><td>${data.yourApproved}</td><td>${data.solutionApproved}</td></tr>
                        <tr><td>Rejected</td><td>${data.yourRejected}</td><td>${data.solutionRejected}</td></tr>
                        <tr><td>Approved rate</td><td>${percent(data.yourApproved, data.userTotal)}</td><td>${percent(data.solutionApproved, data.solutionTotal)}</td></tr>
                        <tr><td>Rejected rate</td><td>${percent(data.yourRejected, data.userTotal)}</td><td>${percent(data.solutionRejected, data.solutionTotal)}</td></tr>
                        <tr><td>You approve but resolution reject</td><td>${data.approveButRejected}</td><td>—</td></tr>
                        <tr><td>You reject but resolution approve</td><td>${data.rejectButApproved}</td><td>—</td></tr>
                        <tr><td>Agreement rate</td><td>${percent(data.agreement, data.userTotal)}</td><td>—</td></tr>
                    </tbody>
                </table>
            </div>
        `;
    }

    function statusRank(state, reverse = false) {
        const normal = { "approved": 0, "reviewing": 1, "likely-rejected": 2, "": 3 };
        const reversed = { "likely-rejected": 0, "reviewing": 1, "approved": 2, "": 3 };
        return (reverse ? reversed : normal)[state || ""] ?? 3;
    }

    function applyFiltersAndSort(panel) {
        const tbody = panel.querySelector("tbody");
        if (!tbody) return;
        const search = (panel.querySelector(".wfap-search")?.value || "").trim().toLowerCase();
        const statusFilter = panel.querySelector(".wfap-status-filter")?.value || "";
        const reviewFilter = panel.querySelector(".wfap-review-filter")?.value || "";
        const sort = panel.querySelector(".wfap-sort")?.value || "date-desc";
        const rows = Array.from(tbody.querySelectorAll("tr"));

        rows.forEach(row => {
            const state = row.dataset.status || "";
            const matchesText = !search || (row.dataset.title || "").includes(search);
            const matchesStatus = !statusFilter || (statusFilter === "unchecked" ? !state : state === statusFilter);
            const matchesReview = !reviewFilter || row.dataset.reviewKind === reviewFilter;
            row.style.display = (matchesText && matchesStatus && matchesReview) ? "" : "none";
        });

        rows.sort((a, b) => {
            const reviewCompare = (a.dataset.userReview || "").localeCompare(b.dataset.userReview || "");
            if (sort === "date-asc") return Number(a.dataset.ts || 0) - Number(b.dataset.ts || 0);
            if (sort === "status") return statusRank(a.dataset.status) - statusRank(b.dataset.status) || Number(b.dataset.ts || 0) - Number(a.dataset.ts || 0);
            if (sort === "status-reverse") return statusRank(a.dataset.status, true) - statusRank(b.dataset.status, true) || Number(b.dataset.ts || 0) - Number(a.dataset.ts || 0);
            if (sort === "title") return (a.dataset.title || "").localeCompare(b.dataset.title || "");
            if (sort === "review") return reviewCompare || Number(b.dataset.ts || 0) - Number(a.dataset.ts || 0);
            if (sort === "status-review") return statusRank(a.dataset.status) - statusRank(b.dataset.status) || reviewCompare || Number(b.dataset.ts || 0) - Number(a.dataset.ts || 0);
            if (sort === "review-status") return reviewCompare || statusRank(a.dataset.status) - statusRank(b.dataset.status) || Number(b.dataset.ts || 0) - Number(a.dataset.ts || 0);
            return Number(b.dataset.ts || 0) - Number(a.dataset.ts || 0);
        });

        rows.forEach(row => tbody.appendChild(row));
        updateVisibleCounters(panel);
    }

    async function checkAllRows(panel) {
        const rows = Array.from(panel.querySelectorAll("tbody tr"));
        const records = panel._wfapRecords || [];
        const btn = panel.querySelector(".wfap-check-visible");
        const reloadBtn = panel.querySelector(".wfap-refresh");
        const summary = panel.querySelector(".wfap-summary");

        if (!rows.length || !records.length) return;

        const jobs = [];
        let skippedApproved = 0;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const record = records[i];
            if (rowAlreadyApproved(row, record)) {
                skippedApproved++;
                continue;
            }
            jobs.push({ row, record });
        }

        if (!jobs.length) {
            summary.textContent = `All ${rows.length} visible records are already approved or cached as approved. Nothing to check.`;
            return;
        }

        btn.disabled = true;
        if (reloadBtn) reloadBtn.disabled = true; // do not allow reload during Check unchecked

        let done = 0;
        let approved = skippedApproved;
        let reviewing = 0;
        let rejected = 0;

        for (const job of jobs) {
            const { row, record } = job;
            const statusCell = row.querySelector(".wfap-status");

            statusCell.className = "wfap-status wfap-status-checking";
            statusCell.textContent = "Queued…";

            enqueueCheck(async () => {
                statusCell.textContent = "Checking…";
                const result = await checkRecord(record, false);
                setStatusCell(row, result);

                done++;
                if (result.state === "approved") approved++;
                else if (result.state === "reviewing") reviewing++;
                else rejected++;

                summary.textContent = `Checked ${done}/${jobs.length} unchecked, skipped ${skippedApproved} already approved: ${approved} approved, ${reviewing} reviewing, ${rejected} likely rejected. Exact-miss rows also checked same-name nearby within ${RELOCATION_RADIUS_M}m.`;

                if (done >= jobs.length) {
                    btn.disabled = false;
                    if (reloadBtn) reloadBtn.disabled = false;
                }
            });
        }
    }

    async function checkRejectedNearbyRows(panel) {
        const rows = Array.from(panel.querySelectorAll("tbody tr"));
        const records = panel._wfapRecords || [];
        const btn = panel.querySelector(".wfap-check-relocated");
        const checkBtn = panel.querySelector(".wfap-check-visible");
        const reloadBtn = panel.querySelector(".wfap-refresh");
        const summary = panel.querySelector(".wfap-summary");

        if (!rows.length || !records.length) return;

        const jobs = [];
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const record = records[i];
            if ((row.dataset.status || "") !== "likely-rejected") continue;
            jobs.push({ row, record });
        }

        if (!jobs.length) {
            summary.textContent = `No likely rejected rows loaded. Run Check unchecked first, or change the Status filter to Likely rejected.`;
            return;
        }

        btn.disabled = true;
        if (checkBtn) checkBtn.disabled = true;
        if (reloadBtn) reloadBtn.disabled = true;

        let done = 0;
        let relocated = 0;
        let stillRejected = 0;

        for (const job of jobs) {
            const { row, record } = job;
            const statusCell = row.querySelector(".wfap-status");

            statusCell.className = "wfap-status wfap-status-checking";
            statusCell.textContent = "Queued nearby…";

            enqueueCheck(async () => {
                statusCell.textContent = `Checking same-name wayspots within ${RELOCATION_RADIUS_M}m…`;
                const result = await checkRelocatedRecord(record, true);
                setStatusCell(row, result);

                done++;
                if (result.state === "approved") relocated++;
                else stillRejected++;

                summary.textContent = `Nearby relocation check ${done}/${jobs.length}: ${relocated} same-name relocated approved, ${stillRejected} checked and still likely rejected.`;

                if (done >= jobs.length) {
                    btn.disabled = false;
                    if (checkBtn) checkBtn.disabled = false;
                    if (reloadBtn) reloadBtn.disabled = false;
                    updateStats(panel);
                    applyFiltersAndSort(panel);
                }
            });
        }
    }

    const APPROVED_TAB_ID = "wfap-approved-review-tab";
    const HISTORY_BUTTON_LABELS = ["Nomination Reviews", "Edit Reviews", "Photo Reviews"];
    const HISTORY_TABLE_IDS = ["nomination-table", "edit-table", "photo-table"];
    const STANDALONE_WAIT_MS = 9000;

    let profileEnteredAt = Date.now();
    let syncTimer = null;
    let syncRunning = false;

    function findButtonByText(text) {
        return Array.from(document.querySelectorAll("button, a"))
            .find(el => (el.textContent || "").trim() === text);
    }

    function findReviewHistoryLayout() {
        const nominationButton = findButtonByText("Nomination Reviews");
        const editButton = findButtonByText("Edit Reviews");
        const photoButton = findButtonByText("Photo Reviews");
        const nominationTable = document.getElementById("nomination-table");
        const editTable = document.getElementById("edit-table");
        const photoTable = document.getElementById("photo-table");

        // This means Wayfarer Review History Table is really present.
        // The Approved Review script does not create Nomination/Edit/Photo sections itself.
        if (!nominationButton || !nominationTable) return null;

        return {
            buttons: [nominationButton, editButton, photoButton].filter(Boolean),
            insertAfterButton: photoButton || editButton || nominationButton,
            buttonParent: (photoButton || editButton || nominationButton).parentElement,
            tables: [nominationTable, editTable, photoTable].filter(Boolean),
            tableParent: nominationTable.parentElement
        };
    }

    async function getOrBuildPanel() {
        let panel = document.getElementById(PANEL_ID);
        if (!panel) panel = await buildPanel();
        panel.classList.add("review-history-table");
        return panel;
    }

    function setActiveButton(activeButton, layout) {
        const allButtons = [...(layout?.buttons || []), document.getElementById(APPROVED_TAB_ID)].filter(Boolean);
        allButtons.forEach(btn => btn.classList.remove("wfap-tab-active"));
        if (activeButton) activeButton.classList.add("wfap-tab-active");
    }

    function showApprovedPanel(panel, tabButton, layout) {
        layout.tables.forEach(table => {
            table.style.display = "none";
        });
        panel.hidden = false;
        panel.style.display = "block";
        setActiveButton(tabButton, layout);
    }

    function hideApprovedPanel(panel, tabButton) {
        if (!panel) return;
        panel.style.display = "none";
        panel.hidden = false;
        if (tabButton) tabButton.classList.remove("wfap-tab-active");
    }

    function attachHistoryButtonHiders(layout, panel, tabButton) {
        layout.buttons.forEach(btn => {
            if (btn.dataset.wfapHideAttached === "1") return;
            btn.dataset.wfapHideAttached = "1";
            btn.addEventListener("click", () => hideApprovedPanel(panel, tabButton));
        });
    }

    function ensureApprovedTab(layout, panel) {
        let tabButton = document.getElementById(APPROVED_TAB_ID);

        if (!tabButton) {
            tabButton = document.createElement(layout.insertAfterButton?.tagName || "button");
            tabButton.id = APPROVED_TAB_ID;
            tabButton.type = "button";
            tabButton.textContent = "Approved Review";
        }

        // Keep it in the same button row as Nomination/Edit/Photo Reviews.
        if (layout.insertAfterButton && tabButton.previousElementSibling !== layout.insertAfterButton) {
            layout.insertAfterButton.insertAdjacentElement("afterend", tabButton);
        } else if (layout.buttonParent && tabButton.parentElement !== layout.buttonParent) {
            layout.buttonParent.appendChild(tabButton);
        }

        tabButton.className = layout.insertAfterButton?.className || tabButton.className || "";
        tabButton.classList.add("wfap-approved-tab-button");
        tabButton.onclick = ev => {
            ev.preventDefault();
            ev.stopPropagation();
            showApprovedPanel(panel, tabButton, layout);
        };

        attachHistoryButtonHiders(layout, panel, tabButton);
        return tabButton;
    }

    async function integrateWithReviewHistoryTable(layout) {
        const panel = await getOrBuildPanel();
        const wasShowing = panel.style.display === "block" && !panel.hidden;

        panel.classList.remove("wfap-standalone");
        panel.classList.add("wfap-integrated");

        if (layout.tableParent && panel.parentElement !== layout.tableParent) {
            layout.tableParent.appendChild(panel);
        }

        const tabButton = ensureApprovedTab(layout, panel);

        // Integrated mode behaves like the existing three tables:
        // hidden until the user presses "Approved Review".
        if (wasShowing || tabButton.classList.contains("wfap-tab-active")) {
            showApprovedPanel(panel, tabButton, layout);
        } else {
            hideApprovedPanel(panel, tabButton);
        }
    }

    async function insertStandalonePanel() {
        if (document.getElementById(PANEL_ID)?.classList.contains("wfap-integrated")) return;

        const panel = await getOrBuildPanel();
        panel.classList.remove("wfap-integrated");
        panel.classList.add("wfap-standalone");
        panel.hidden = false;
        panel.style.display = "block";

        const ref = document.querySelector("wf-credibility-card");
        const container =
            (ref && ref.parentNode && ref.parentNode.parentNode) ||
            document.querySelector("main") ||
            document.body ||
            document.documentElement;

        if (panel.parentElement !== container) {
            container.appendChild(panel);
        }
    }

    async function syncPlacement() {
        if (!isProfileRoute() || syncRunning) return;
        syncRunning = true;

        try {
            const layout = findReviewHistoryLayout();

            if (layout) {
                await integrateWithReviewHistoryTable(layout);
                return;
            }

            // Give Wayfarer Review History Table time to render first.
            // If it never appears, this script still works alone.
            if (Date.now() - profileEnteredAt >= STANDALONE_WAIT_MS) {
                await insertStandalonePanel();
            }
        } catch (e) {
            console.error("[WF Approval Checker] Could not sync placement:", e);
        } finally {
            syncRunning = false;
        }
    }

    function scheduleSync(delay = 250) {
        if (syncTimer) clearTimeout(syncTimer);
        syncTimer = setTimeout(syncPlacement, delay);
    }

    function injectCss() {
        const css = `
#wf-review-approval-checker[hidden] {
    display: none !important;
}

#wfap-approved-review-tab.wfap-tab-active,
.wfap-approved-tab-button.wfap-tab-active {
    outline: 2px solid #38bdf8;
    outline-offset: 2px;
}

#wf-review-approval-checker {
    margin: 16px auto;
    max-width: 1180px;
    padding: 14px;
    border: 1px solid rgba(128,128,128,0.35);
    border-radius: 10px;
    background: rgba(255,255,255,0.92);
    color: #1f2937;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.dark #wf-review-approval-checker,
body.dark #wf-review-approval-checker {
    background: rgba(30,30,30,0.92);
    color: #e5e7eb;
    border-color: rgba(255,255,255,0.22);
}

#wf-review-approval-checker .wfap-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 10px;
}

#wf-review-approval-checker h2 {
    margin: 0 0 4px;
    font-size: 18px;
    font-weight: 700;
}

#wf-review-approval-checker p {
    margin: 0;
    font-size: 12px;
    opacity: 0.85;
}

#wf-review-approval-checker .wfap-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
}

#wf-review-approval-checker .wfap-btn {
    border: 1px solid #d1d5db;
    border-radius: 6px;
    background: #f9fafb;
    color: #111827;
    padding: 5px 9px;
    cursor: pointer;
    font-size: 12px;
}

.dark #wf-review-approval-checker .wfap-btn,
body.dark #wf-review-approval-checker .wfap-btn {
    background: #374151;
    color: #f9fafb;
    border-color: #4b5563;
}

#wf-review-approval-checker .wfap-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
}

#wf-review-approval-checker .wfap-controls {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: center;
    margin: 10px 0 6px;
    font-size: 12px;
}

#wf-review-approval-checker .wfap-controls input,
#wf-review-approval-checker .wfap-controls select {
    margin-left: 4px;
    padding: 4px 6px;
    border: 1px solid #d1d5db;
    border-radius: 5px;
    background: #fff;
    color: #111827;
}

.dark #wf-review-approval-checker .wfap-controls input,
.dark #wf-review-approval-checker .wfap-controls select,
body.dark #wf-review-approval-checker .wfap-controls input,
body.dark #wf-review-approval-checker .wfap-controls select {
    background: #1f2937;
    color: #f9fafb;
    border-color: #4b5563;
}

#wf-review-approval-checker .wfap-stats,
#wf-review-approval-checker .wfap-visible-counts,
#wf-review-approval-checker .wfap-summary {
    margin: 8px 0;
    font-size: 12px;
    opacity: 0.9;
}



#wf-review-approval-checker .wfap-analytics {
    margin-top: 14px;
    padding: 12px;
    border: 1px solid rgba(128,128,128,0.22);
    border-radius: 8px;
    background: rgba(128,128,128,0.06);
}

#wf-review-approval-checker .wfap-analytics h3 {
    margin: 0 0 6px 0;
    font-size: 16px;
    font-weight: 700;
}

#wf-review-approval-checker .wfap-analytics-note {
    margin: 0 0 10px 0;
    font-size: 12px;
    opacity: 0.85;
}

#wf-review-approval-checker .wfap-chart {
    display: grid;
    gap: 10px;
    margin: 10px 0;
}

#wf-review-approval-checker .wfap-chart-row {
    display: grid;
    grid-template-columns: 90px 1fr;
    gap: 10px;
    align-items: center;
}

#wf-review-approval-checker .wfap-chart-label {
    font-weight: 700;
    font-size: 12px;
}

#wf-review-approval-checker .wfap-chart-bars {
    display: grid;
    gap: 4px;
}

#wf-review-approval-checker .wfap-chart-bar {
    min-width: 2px;
    border-radius: 5px;
    padding: 4px 6px;
    line-height: 1.15;
    white-space: pre-line;
    overflow: visible;
    font-size: 11px;
    box-sizing: border-box;
}

#wf-review-approval-checker .wfap-chart-user {
    background: rgba(37, 99, 235, 0.26);
    border: 1px solid rgba(37, 99, 235, 0.45);
}

#wf-review-approval-checker .wfap-chart-solution {
    background: rgba(22, 163, 74, 0.26);
    border: 1px solid rgba(22, 163, 74, 0.45);
}

#wf-review-approval-checker .wfap-chart-legend {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    margin: 6px 0 10px 0;
    font-size: 12px;
}

#wf-review-approval-checker .wfap-chart-legend span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
}

#wf-review-approval-checker .wfap-chart-legend i {
    width: 12px;
    height: 12px;
    border-radius: 3px;
    display: inline-block;
}

#wf-review-approval-checker .wfap-legend-user {
    background: rgba(37, 99, 235, 0.40);
    border: 1px solid rgba(37, 99, 235, 0.55);
}

#wf-review-approval-checker .wfap-legend-solution {
    background: rgba(22, 163, 74, 0.40);
    border: 1px solid rgba(22, 163, 74, 0.55);
}

#wf-review-approval-checker .wfap-resolution-table-wrap {
    overflow-x: auto;
}

#wf-review-approval-checker .wfap-resolution-table {
    width: 100%;
    border-collapse: collapse;
    min-width: 560px;
    font-size: 12px;
}

#wf-review-approval-checker .wfap-resolution-table th,
#wf-review-approval-checker .wfap-resolution-table td {
    border-bottom: 1px solid rgba(128,128,128,0.22);
    padding: 6px 8px;
    text-align: left;
}

#wf-review-approval-checker .wfap-table-wrap {
    overflow-x: auto;
    max-height: 620px;
    overflow-y: auto;
    border: 1px solid rgba(128,128,128,0.22);
    border-radius: 8px;
}

#wf-review-approval-checker .wfap-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    min-width: 960px;
}

#wf-review-approval-checker th,
#wf-review-approval-checker td {
    border-bottom: 1px solid rgba(128,128,128,0.25);
    padding: 6px 8px;
    text-align: left;
    vertical-align: middle;
}

#wf-review-approval-checker th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: #f3f4f6;
    font-weight: 700;
}

.dark #wf-review-approval-checker th,
body.dark #wf-review-approval-checker th {
    background: #111827;
}

#wf-review-approval-checker td:nth-child(4) {
    max-width: 330px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

#wf-review-approval-checker a {
    color: #2563eb;
    text-decoration: none;
}

.dark #wf-review-approval-checker a,
body.dark #wf-review-approval-checker a {
    color: #93c5fd;
}

#wf-review-approval-checker .wfap-status {
    font-weight: 700;
    white-space: nowrap;
}

#wf-review-approval-checker .wfap-status-approved {
    color: #15803d;
}

#wf-review-approval-checker .wfap-status-reviewing {
    color: #a16207;
}

#wf-review-approval-checker .wfap-status-rejected {
    color: #b91c1c;
}

#wf-review-approval-checker .wfap-status-checking {
    color: #2563eb;
}
`;
        const style = document.createElement("style");
        style.id = "wf-review-approval-checker-css";
        style.textContent = css;

        const add = () => {
            if (!document.getElementById(style.id)) {
                (document.head || document.documentElement).appendChild(style);
            }
        };

        if (document.head) add();
        else document.addEventListener("DOMContentLoaded", add, { once: true });
    }

    function start() {
        injectCss();

        onRouteChange(() => {
            profileEnteredAt = Date.now();
            scheduleSync(300);
            scheduleSync(STANDALONE_WAIT_MS + 500);
        });

        document.addEventListener("DOMContentLoaded", () => {
            profileEnteredAt = Date.now();
            scheduleSync(500);
            scheduleSync(1800);
            scheduleSync(STANDALONE_WAIT_MS + 500);
        });

        // Watch for Wayfarer Review History Table rendering after the profile API returns.
        const observerTarget = document.documentElement || document;
        const observer = new MutationObserver(() => scheduleSync(300));
        observer.observe(observerTarget, { childList: true, subtree: true });

        scheduleSync(1200);
        scheduleSync(STANDALONE_WAIT_MS + 500);
    }

    start();
})();
