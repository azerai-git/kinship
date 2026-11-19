// Background sync engine, modelled on Firefox Sync:
//  - incremental download of clients/tabs/bookmarks/history into a local cache
//    (info/collections timestamps + `newer=`), triggered on a schedule, on
//    push ("sync:collection_changed"), and on demand;
//  - upload of this browser's own client record, open tabs and history;
//  - bookmark mirror into the browser's native bookmarks (see mirror.js).
// Runs in the background service worker. The UI only reads the cache.
import { loadAccount, getSyncClient, resetSyncClient } from "./account.js";
import { loadDevice } from "./device.js";
import * as fxa from "./fxa.js";
import { makeGuid } from "./sync.js";
import * as mirror from "./mirror.js";

export const COLLECTIONS = ["clients", "tabs", "bookmarks", "history"];
const HISTORY_CACHE_MAX = 10000;
const HISTORY_INITIAL_FETCH = 5000;
export const CLIENTS_TTL = 15552000;   // 180 days, as Firefox
export const TABS_TTL = 1814400;       // 21 days
export const HISTORY_TTL = 5184000;    // 60 days, as Firefox
const MAX_VISITS = 20;
const MAX_TABS = 200;
const MAX_TABS_PAYLOAD = 400 * 1024;
const CLIENT_REUPLOAD_MS = 24 * 3600 * 1000;
const HISTORY_BACKFILL_DAYS = 30;
const HISTORY_BACKFILL_MAX = 2000;

/**
 * User settings ("Choose what to sync"):
 *   setupDone      — the user confirmed the first-run choices; nothing is written
 *                    to the browser or uploaded before that.
 *   bookmarksMode  — "mirror" (Firefox → browser bookmarks) | "view" (extension only)
 *                    | "twoway" (reserved, not implemented yet)
 *   uploadTabs     — share this browser's open tabs (Firefox's Synced Tabs)
 *   uploadHistory  — share this browser's history
 *   delivery       — "push" (Mozilla push service, instant) | "poll" (every 30 s)
 */
export const DEFAULT_SETTINGS = {
  setupDone: false, bookmarksMode: "mirror", uploadTabs: false, uploadHistory: false, delivery: "push",
};
export const BOOKMARK_MODES = ["mirror", "view", "twoway"];
export const IMPLEMENTED_BOOKMARK_MODES = ["mirror", "view"];

/**
 * Normalise stored settings, migrating installs from before the settings
 * screen (v0.3: {mirrorBookmarks, uploadTabs, uploadHistory}, defaults all on,
 * no setupDone). `hadSynced` = an earlier version already synced, i.e. the user
 * already chose these by using it. Exported for tests.
 */
export function normalizeSettings(raw = {}, { hadSynced = false } = {}) {
  const s = { ...raw };
  if (s.bookmarksMode === undefined && s.mirrorBookmarks !== undefined) s.bookmarksMode = s.mirrorBookmarks ? "mirror" : "view";
  delete s.mirrorBookmarks;
  if (s.setupDone === undefined && hadSynced) {
    s.setupDone = true;
    s.bookmarksMode ??= "mirror";
    s.uploadTabs ??= true;
    s.uploadHistory ??= true;
  }
  const out = { ...DEFAULT_SETTINGS, ...s };
  if (!IMPLEMENTED_BOOKMARK_MODES.includes(out.bookmarksMode)) out.bookmarksMode = "mirror";
  if (!["push", "poll"].includes(out.delivery)) out.delivery = "push";
  return out;
}

const S = chrome.storage.local;
const get = async (k, dflt) => (await S.get(k))[k] ?? dflt;
const set = (k, v) => S.set({ [k]: v });

export async function loadSettings() {
  const r = await S.get(["settings", "sync:state"]);
  return normalizeSettings(r.settings || {}, { hadSynced: !!r["sync:state"]?.lastSync });
}
export const saveSettings = async (patch) => set("settings", { ...(await loadSettings()), ...patch });

/** Optional permission check (bookmarks / tabs / history are requested on demand). */
export async function hasPermission(name) {
  try { return await chrome.permissions.contains({ permissions: [name] }); } catch { return false; }
}

/** Auth failures that only a new sign-in fixes (revoked refresh token / session). */
export function isAuthError(e) {
  if (!e) return false;
  if (e.errno === 110) return true;                              // invalid session token
  if (e.name === "OAuthError" || e.constructor?.name === "OAuthError") return e.status === 400 || e.status === 401;
  return false;
}
export const loadState = () => get("sync:state", { modified: {} });
const saveState = (st) => set("sync:state", st);
export const loadCache = (coll) => get(`cache:${coll}`, {});

/** Clear all cached Sync data (on sign-out / account switch). */
export async function clearLocalData() {
  await S.remove([...COLLECTIONS.map((c) => `cache:${c}`), "cache:devices", "sync:state", "upload:history"]);
}

// ---------- lock: one sync at a time ----------
let running = null;
let rerun = null;
export function sync(opts = {}) {
  if (running) {
    // Coalesce: run once more after the current one, with merged collections.
    rerun = { ...(rerun || {}), ...opts, collections: mergeColls(rerun?.collections, opts.collections) };
    return running;
  }
  running = (async () => {
    try { return await doSync(opts); }
    finally {
      running = null;
      if (rerun) { const r = rerun; rerun = null; sync(r); }
    }
  })();
  return running;
}
const mergeColls = (a, b) => (!a || !b ? undefined : [...new Set([...a, ...b])]);

function engineEnabled(meta, name) {
  if (!meta) return false;
  if ((meta.declined || []).includes(name)) return false;
  return !!meta.engines?.[name];
}

async function withClient(acct, fn) {
  try {
    return await fn(await getSyncClient(acct));
  } catch (e) {
    if (e.status === 401) { resetSyncClient(); return fn(await getSyncClient(acct)); }
    throw e;
  }
}

async function doSync({ reason = "manual", collections, uploadsOnly = false } = {}) {
  const acct = await loadAccount();
  if (!acct) return null;
  const st = await loadState();
  if (st.uid && st.uid !== acct.uid) { await clearLocalData(); return doSync({ reason }); }
  st.uid = acct.uid;
  st.clientId ||= makeGuid();
  st.modified ||= {};
  const summary = { reason, downloaded: {}, uploaded: {}, mirror: null };
  const settings = await loadSettings();
  try {
    await withClient(acct, async (client) => {
      const info = await client.info();
      if (info.crypto !== undefined && info.crypto !== st.keysModified) {
        await client.loadKeys();
        if (st.keysModified !== undefined) st.modified = {};  // keys rotated: refetch all
        st.keysModified = info.crypto;
      }
      if (info.meta !== st.metaModified || !st.meta) {
        const m = await client.metaGlobal();
        if (st.meta && m.syncID !== st.meta.syncID) st.modified = {}; // server was reset: refetch
        st.meta = { syncID: m.syncID, engines: m.engines || {}, declined: m.declined || [] };
        st.metaModified = info.meta;
      }

      if (!uploadsOnly) {
        for (const coll of COLLECTIONS) {
          if (collections && !collections.includes(coll)) continue;
          if (info[coll] === undefined || info[coll] === st.modified[coll]) continue;
          const n = await downloadCollection(client, coll, st.modified[coll]);
          summary.downloaded[coll] = n;
          st.modified[coll] = info[coll];
        }
      }

      // ---- uploads: only after the user chose them, with permission, for engines the account has enabled ----
      const dev = await loadDevice();
      if (dev && settings.setupDone) {
        if (engineEnabled(st.meta, "clients")) {
          summary.uploaded.client = await uploadClientRecord(client, st, dev, acct);
        }
        if (settings.uploadTabs && engineEnabled(st.meta, "tabs") && await hasPermission("tabs") &&
            (st.tabsDirty || !st.tabsUploadedAt || Date.now() - st.tabsUploadedAt > 3600e3)) {
          summary.uploaded.tabs = await uploadTabs(client, st, dev);
        }
      }
      if (settings.setupDone && settings.uploadHistory && engineEnabled(st.meta, "history") && await hasPermission("history")) {
        if (!st.historyBackfilled) { await backfillHistoryQueue(); st.historyBackfilled = true; }
        summary.uploaded.history = await uploadHistory(client);
      }
    });

    if (settings.setupDone && settings.bookmarksMode === "mirror" && await hasPermission("bookmarks") &&
        (summary.downloaded.bookmarks !== undefined || !st.mirroredOnce || reason === "manual")) {
      const bm = await loadCache("bookmarks");
      summary.mirror = await mirror.reconcile(bm, { uid: acct.uid });
      st.mirroredOnce = true;
    }

    try { await set("cache:devices", await fxa.getDevices(acct.sessionToken)); }
    catch (e) { if (isAuthError(e)) throw e; console.warn("devices", e); }

    st.lastSync = Date.now();
    st.lastError = null;
    st.needsReauth = false;
  } catch (e) {
    console.error("sync failed", e);
    st.lastError = `${e.message || e}`.slice(0, 300);
    st.lastErrorAt = Date.now();
    if (isAuthError(e)) st.needsReauth = true;
    throw e;
  } finally {
    await saveState(st);
  }
  return summary;
}

async function downloadCollection(client, coll, newer) {
  const opts = { newer, sort: coll === "bookmarks" ? "index" : "newest" };
  if (coll === "history" && !newer) opts.max = HISTORY_INITIAL_FETCH;
  const recs = await client.fetchCollection(coll, opts);
  const cache = newer ? await loadCache(coll) : {};
  for (const r of recs) {
    if (r.deleted) delete cache[r.id];
    else cache[r.id] = r;
  }
  if (coll === "history") pruneHistory(cache);
  await set(`cache:${coll}`, cache);
  return recs.length;
}

export function lastVisit(r) {
  let m = 0;
  for (const v of r.visits || []) if (v.date > m) m = v.date;
  return m;
}

function pruneHistory(cache) {
  const ids = Object.keys(cache);
  if (ids.length <= HISTORY_CACHE_MAX) return;
  ids.sort((a, b) => lastVisit(cache[b]) - lastVisit(cache[a]));
  for (const id of ids.slice(HISTORY_CACHE_MAX)) delete cache[id];
}

// ---------- uploads ----------

function browserInfo() {
  const ua = navigator.userAgent;
  const edge = ua.match(/Edg\/([\d.]+)/);
  const chrome_ = ua.match(/Chrome\/([\d.]+)/);
  const os = /Windows/.test(ua) ? "WINNT" : /Mac OS X/.test(ua) ? "Darwin" : /Android/.test(ua) ? "Android"
    : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  return {
    application: edge ? "Microsoft Edge" : "Google Chrome",
    version: (edge || chrome_)?.[1] || "",
    os,
  };
}

export function buildClientRecord(clientId, dev) {
  const b = browserInfo();
  return {
    id: clientId,
    name: dev.name,
    type: "desktop",
    commands: [],
    version: b.version,
    protocols: ["1.5"],
    os: b.os,
    application: b.application,
    appPackage: "firefox-sync-chrome-poc",
    fxaDeviceId: dev.id,
  };
}

async function uploadClientRecord(client, st, dev, acct) {
  const fresh = st.clientUploadedAt && Date.now() - st.clientUploadedAt < CLIENT_REUPLOAD_MS;
  if (fresh && st.clientUploadedName === dev.name && st.clientUploadedDevice === dev.id) return false;
  await client.putRecord("clients", buildClientRecord(st.clientId, dev), { ttl: CLIENTS_TTL });
  const first = !st.clientUploadedAt;
  st.clientUploadedAt = Date.now();
  st.clientUploadedName = dev.name;
  st.clientUploadedDevice = dev.id;
  if (first) {
    // Like Firefox's first sync: tell the other devices to sync clients now.
    fxa.notifyDevices(acct, {
      to: "all", excluded: [dev.id], TTL: 0,
      payload: { version: 1, command: "sync:collection_changed", data: { collections: ["clients"], reason: "firstsync" } },
    }).catch((e) => console.warn("notifyDevices", e));
  }
  return true;
}

/** Turn browser tabs into Firefox's tabs record. Exported for tests. */
export function buildTabsRecord(clientId, clientName, tabs) {
  const usable = tabs
    .filter((t) => !t.incognito && /^(https?|ftp):/i.test(t.url || ""))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
    .slice(0, MAX_TABS)
    .map((t) => {
      const tab = {
        title: (t.title || t.url).slice(0, 512),
        urlHistory: [t.url.slice(0, 65536)],
        icon: /^https?:/i.test(t.favIconUrl || "") ? t.favIconUrl : null,
        lastUsed: Math.floor((t.lastAccessed || Date.now()) / 1000),
      };
      if (t.pinned) tab.pinned = true;
      return tab;
    });
  const rec = { id: clientId, clientName, tabs: usable };
  while (rec.tabs.length && JSON.stringify(rec).length > MAX_TABS_PAYLOAD) rec.tabs.pop();
  return rec;
}

async function uploadTabs(client, st, dev) {
  const tabs = await chrome.tabs.query({});
  const rec = buildTabsRecord(st.clientId, dev.name, tabs);
  await client.putRecord("tabs", rec, { ttl: TABS_TTL });
  st.tabsDirty = false;
  st.tabsUploadedAt = Date.now();
  return rec.tabs.length;
}

/** Stop sharing tabs: remove this browser from Firefox's Synced Tabs. */
export async function deleteOwnTabsRecord() {
  const acct = await loadAccount();
  const st = await loadState();
  if (!acct || !st.clientId) return;
  await withClient(acct, (client) => client.deleteRecord("tabs", st.clientId)).catch((e) => {
    if (e.status !== 404) throw e;
  });
  st.tabsUploadedAt = null;
  await saveState(st);
}

/** Mark local tabs changed; caller schedules an uploads-only sync. */
export async function markTabsDirty() {
  const st = await loadState();
  st.tabsDirty = true;
  await saveState(st);
}

// History: Chrome transition → Firefox visit type (nsINavHistoryService TRANSITION_*)
const TRANSITIONS = {
  link: 1, typed: 2, auto_bookmark: 3, auto_subframe: 4, manual_subframe: 8, generated: 2,
  auto_toplevel: 1, form_submit: 1, reload: 9, keyword: 2, keyword_generated: 2,
};
export const visitType = (t) => TRANSITIONS[t] || 1;

/** Merge local visits into an (optional) existing Firefox history record. Exported for tests. */
export function mergeHistoryRecord(existing, url, title, localVisits) {
  const byKey = new Map();
  for (const v of existing?.visits || []) byKey.set(`${v.date}`, v);
  for (const v of localVisits) {
    const date = Math.round(v.visitTime) * 1000;           // ms → µs
    if (!byKey.has(`${date}`)) byKey.set(`${date}`, { date, type: visitType(v.transition) });
  }
  const visits = [...byKey.values()].sort((a, b) => b.date - a.date).slice(0, MAX_VISITS);
  return { id: existing?.id || makeGuid(), histUri: url, title: title || existing?.title || "", visits };
}

export async function queueHistory(url) {
  if (!/^(https?|ftp):/i.test(url) || url.length > 65536) return;
  const q = await get("upload:history", {});
  q[url] = Date.now();
  await set("upload:history", q);
}

async function backfillHistoryQueue() {
  const items = await chrome.history.search({
    text: "", startTime: Date.now() - HISTORY_BACKFILL_DAYS * 86400e3, maxResults: HISTORY_BACKFILL_MAX,
  });
  const q = await get("upload:history", {});
  for (const it of items) if (/^(https?|ftp):/i.test(it.url || "")) q[it.url] = 1; // old timestamp: never "re-visited"
  await set("upload:history", q);
}

async function uploadHistory(client) {
  const started = Date.now();
  const q = await get("upload:history", {});
  const urls = Object.keys(q).slice(0, 500);
  if (!urls.length) return 0;
  const cache = await loadCache("history");
  const byUrl = new Map(Object.values(cache).map((r) => [r.histUri, r]));
  const records = [];
  for (const url of urls) {
    let visits = [];
    try { visits = (await chrome.history.getVisits({ url })).filter((v) => v.isLocal !== false); } catch {}
    if (!visits.length) continue;
    let title = "";
    try {
      const hits = await chrome.history.search({ text: url, startTime: 0, maxResults: 20 });
      title = hits.find((h) => h.url === url)?.title || "";
    } catch {}
    const rec = mergeHistoryRecord(byUrl.get(url), url, title, visits.slice(-MAX_VISITS));
    if (byUrl.get(url) && rec.visits.length === byUrl.get(url).visits.length && rec.title === byUrl.get(url).title) continue;
    records.push(rec);
  }
  let uploaded = 0;
  if (records.length) {
    const res = await client.postRecords("history", records, { ttl: HISTORY_TTL });
    const ok = new Set(res.success);
    for (const r of records) if (ok.has(r.id)) { cache[r.id] = r; uploaded++; }
    await set("cache:history", cache);
  }
  // Drop processed URLs, unless they were visited again while we worked.
  const after = await get("upload:history", {});
  for (const u of urls) if ((after[u] || 0) <= started) delete after[u];
  await set("upload:history", after);
  return uploaded;
}
