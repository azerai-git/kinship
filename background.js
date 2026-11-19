// Background service worker: makes this browser a Firefox Sync device.
//  - receiving: Mozilla push service (instant) or 30-second checks, per settings
//  - sync engine on a schedule / on push / on demand
//  - tracking local tabs + history for upload (optional permissions)
//  - Send Tab receive + context menu
import { loadAccount, clearAccount } from "./lib/account.js";
import * as device from "./lib/device.js";
import * as engine from "./lib/engine.js";
import * as mirror from "./lib/mirror.js";
import { PushClient } from "./lib/push.js";
import { PRODUCT_NAME } from "./lib/config.js";

const POLL_ALARM = "poll-tabs";
const SYNC_ALARM = "sync";            // periodic sync, like Firefox's 10-minute interval
const MENU_ALARM = "refresh-menu";
const MENU_ROOT = "send-tab";
const SYNC_INTERVAL_MIN = 10;
const KEEPALIVE_MS = 20_000;
const SAFETY_POLL_MS = 5 * 60e3;      // with push connected, still check the queue every 5 min

let push = null;
let keepalive = null;
let lastPoll = 0;
let pushStatus = "off";
let reauthNotified = false;

// The toolbar button opens popup.html (send this tab / open the full page).

// ---------- lifecycle ----------
let setupRunning = null;
function setup() {
  setupRunning ||= doSetup().finally(() => { setupRunning = null; });
  return setupRunning;
}

async function doSetup() {
  const acct = await loadAccount();
  if (!acct) return teardown();
  await engine.saveSettings({});              // persist migrated/normalised settings
  const settings = await engine.loadSettings();
  await chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
  await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_INTERVAL_MIN });
  await chrome.alarms.create(MENU_ALARM, { periodInMinutes: 15 });
  await device.ensureDevice(acct).catch((e) => console.error("ensureDevice", e));
  await applyDelivery(settings.delivery);
  registerHistoryListener();
  await rebuildMenu().catch(console.error);
  await chrome.storage.session.set({ initialized: true });
  runSync({ reason: "startup" });
  poll().catch(console.error);
}

async function teardown() {
  await chrome.storage.session.remove("initialized");
  await chrome.alarms.clearAll();
  await chrome.contextMenus.removeAll();
  await stopPush({ forget: true });
  await engine.clearLocalData();
  // Next sign-in asks "Choose what to sync" again (preferences are kept as defaults).
  const s = await chrome.storage.local.get("settings");
  if (s.settings?.setupDone) await chrome.storage.local.set({ settings: { ...s.settings, setupDone: false } });
  reauthNotified = false;
}

chrome.runtime.onInstalled.addListener(() => setup().catch(console.error));
chrome.runtime.onStartup.addListener(() => setup().catch(console.error));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "account" in changes) setup().catch(console.error);
});
// Worker (re)started for another reason (alarm, message, crash). Full setup runs
// once per browser session; after that a wake-up only restores the push socket.
(async () => {
  if (!(await loadAccount())) return;
  const { initialized } = await chrome.storage.session.get("initialized");
  if (!initialized) return setup();
  const s = await engine.loadSettings();
  if (s.delivery === "push") await applyDelivery("push");
})().catch(console.error);

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === POLL_ALARM) {
    if (!push?.connected || Date.now() - lastPoll > SAFETY_POLL_MS) poll().catch(console.error);
  }
  if (a.name === SYNC_ALARM) runSync({ reason: "schedule" });
  if (a.name === MENU_ALARM) rebuildMenu().catch(console.error);
});

// ---------- receiving: push vs 30-second checks ----------
async function applyDelivery(mode) {
  if (mode === "push") {
    startPush();
    // Keep the worker alive so the push socket stays open
    // (any extension API call resets the 30 s idle timer).
    keepalive ||= setInterval(() => chrome.runtime.getPlatformInfo(), KEEPALIVE_MS);
  } else {
    await stopPush({ forget: true });
    const acct = await loadAccount();
    if (acct) await device.ensureDevice(acct, { push: null }).catch((e) => console.warn("clear pushCallback", e));
    setPushStatus("off (checking every 30 s)");
  }
}

async function stopPush({ forget }) {
  clearInterval(keepalive);
  keepalive = null;
  if (push) {
    if (forget) await push.reset(); else push.stop();
    push = null;
  } else if (forget) {
    await chrome.storage.local.remove("push");
  }
  setPushStatus("off");
}

function setPushStatus(s) { pushStatus = s; }

function startPush() {
  if (push) return;
  push = new PushClient({
    onStatus: (s) => setPushStatus(s),
    onSubscription: async (sub) => {
      const acct = await loadAccount();
      if (!acct || !sub) return;
      try { await device.ensureDevice(acct, { push: sub }); }
      catch (e) { console.error("device push update", e); }
    },
    onMessage: (msg) => handlePush(msg).catch(console.error),
  });
  push.start().catch(console.error);
}

async function handlePush(msg) {
  chrome.storage.local.set({ "push:last": { at: Date.now(), command: msg?.command || "(no payload)" } }).catch(() => {});
  if (!msg) return poll();
  const cmd = msg.command;
  if (cmd === "fxaccounts:command_received") return poll();
  if (cmd === "sync:collection_changed") {
    return runSync({ reason: "push", collections: msg.data?.collections });
  }
  if (cmd === "fxaccounts:device_connected" || cmd === "fxaccounts:device_disconnected") {
    const me = await device.loadDevice();
    if (cmd === "fxaccounts:device_disconnected" && me && msg.data?.id === me.id) {
      return signedOutRemotely("This browser was removed from your Mozilla account.");
    }
    rebuildMenu().catch(console.error);
    return runSync({ reason: "devices", collections: ["clients"] });
  }
  if (["fxaccounts:password_changed", "fxaccounts:password_reset", "fxaccounts:account_destroyed"].includes(cmd)) {
    return signedOutRemotely("Your Mozilla account password changed. Please sign in again.");
  }
}

async function signedOutRemotely(message) {
  notify(`Signed out of ${PRODUCT_NAME}`, message);
  await clearAccount().catch(console.error);   // triggers teardown via storage change
}

// ---------- sync ----------
async function runSync(opts) {
  try {
    return await engine.sync(opts);
  } catch (e) {
    console.warn("sync", e.message || e);
    const st = await engine.loadState();
    if (st.needsReauth && !reauthNotified) {
      reauthNotified = true;
      notify(`${PRODUCT_NAME}: sign in again`, "Your Mozilla account session ended. Open Kinship to sign in again.");
    }
  }
}

// Local tab changes → upload our tabs record shortly after (debounced).
// Tab events fire without the "tabs" permission; reading URLs needs it (checked in the engine).
let tabsTimer = null;
function tabsChanged() {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(async () => {
    if (!(await loadAccount())) return;
    const s = await engine.loadSettings();
    if (!s.setupDone || !s.uploadTabs) return;
    await engine.markTabsDirty();
    runSync({ reason: "tabs", uploadsOnly: true });
  }, 5000);
}
chrome.tabs.onCreated.addListener(tabsChanged);
chrome.tabs.onRemoved.addListener(tabsChanged);
chrome.tabs.onActivated.addListener(tabsChanged);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url || info.title || info.pinned !== undefined) tabsChanged(); });

// Local visits → queue for history upload (flushed within a minute).
// chrome.history only exists once the optional permission is granted.
let historyTimer = null;
let historyListening = false;
async function onVisited(item) {
  if (!(await loadAccount())) return;
  const s = await engine.loadSettings();
  if (!s.setupDone || !s.uploadHistory) return;
  await engine.queueHistory(item.url);
  if (!historyTimer) {
    historyTimer = setTimeout(() => { historyTimer = null; runSync({ reason: "history", uploadsOnly: true }); }, 60_000);
  }
}
function registerHistoryListener() {
  if (historyListening || !chrome.history?.onVisited) return;
  chrome.history.onVisited.addListener(onVisited);
  historyListening = true;
}
registerHistoryListener();                              // top level: survives worker restarts
chrome.permissions.onAdded.addListener(() => registerHistoryListener());

// ---------- messages from the UI ----------
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const done = (p) => p.then((r) => reply({ ok: true, result: r }), (e) => reply({ ok: false, error: String(e.message || e) }));
  switch (msg?.type) {
    case "sync-now": done(engine.sync({ reason: "manual" })); break;
    case "poll-now": done(poll()); break;
    case "rebuild-menu": done(rebuildMenu()); break;
    case "status":
      device.loadDevice().then((d) => reply({ ok: true, result: {
        pushStatus, pushConnected: !!push?.connected, pushEndpointRegistered: !!d?.pushEndpoint,
      } }));
      break;
    case "settings-changed": done(onSettingsChanged(msg.patch || {})); break;
    default: return false;
  }
  return true;
});

async function onSettingsChanged(patch) {
  const before = await engine.loadSettings();
  await engine.saveSettings(patch);
  const after = await engine.loadSettings();
  if (before.bookmarksMode === "mirror" && after.bookmarksMode !== "mirror") await mirror.removeAll();
  if (before.uploadTabs && !after.uploadTabs) await engine.deleteOwnTabsRecord().catch(console.warn);
  if (before.delivery !== after.delivery) await applyDelivery(after.delivery);
  registerHistoryListener();
  if (after.uploadTabs) await engine.markTabsDirty();
  if (after.setupDone) await engine.sync({ reason: "manual" });
}

// ---------- receiving tabs ----------
let polling = null;
function poll() {
  polling ||= (async () => {
    try {
      const acct = await loadAccount();
      if (!acct) return 0;
      lastPoll = Date.now();
      const tabs = await device.pollReceivedTabs(acct);
      for (const t of tabs) {
        await chrome.tabs.create({ url: t.url, active: false });
        notify(`Tab from ${t.sender}`, t.title || t.url);
      }
      if (tabs.length) {
        const cur = Number(await chrome.action.getBadgeText({})) || 0;
        await chrome.action.setBadgeText({ text: String(cur + tabs.length) });
      }
      return tabs.length;
    } finally {
      polling = null;
    }
  })();
  return polling;
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic", iconUrl: "icons/icon128.png", title, message: String(message).slice(0, 200),
  }).catch(() => {});
}

// ---------- sending (context menu) ----------
async function rebuildMenu() {
  await chrome.contextMenus.removeAll();
  const acct = await loadAccount();
  if (!acct) return;
  // Worded to stand apart from Edge's built-in "Send to your devices" (Microsoft account).
  chrome.contextMenus.create({ id: MENU_ROOT, title: "Send to Firefox Sync device", contexts: ["page", "link"] });
  let targets = [];
  try {
    await device.ensureDevice(acct);
    targets = await device.sendTargets(acct);
  } catch (e) {
    console.error(e);
  }
  for (const d of targets) {
    chrome.contextMenus.create({ id: `send:${d.id}`, parentId: MENU_ROOT, title: d.name, contexts: ["page", "link"] });
  }
  if (!targets.length) {
    chrome.contextMenus.create({ id: "none", parentId: MENU_ROOT, title: "No devices available", enabled: false, contexts: ["page", "link"] });
  }
  chrome.contextMenus.create({ id: "sep", parentId: MENU_ROOT, type: "separator", contexts: ["page", "link"] });
  chrome.contextMenus.create({ id: "refresh", parentId: MENU_ROOT, title: "Refresh device list", contexts: ["page", "link"] });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "refresh") return rebuildMenu().catch(console.error);
  if (typeof info.menuItemId !== "string" || !info.menuItemId.startsWith("send:")) return;
  const targetId = info.menuItemId.slice(5);
  // pageUrl/linkUrl come with the click itself; no "tabs" permission needed.
  const url = info.linkUrl || info.pageUrl || tab?.url;
  const title = info.linkUrl ? (info.selectionText || info.linkUrl) : (tab?.title || url);
  try {
    if (!/^(https?|ftp):/i.test(url || "")) throw new Error("Only web pages can be sent.");
    const acct = await loadAccount();
    const r = await device.sendTab(acct, targetId, { title, url });
    notify(`Sent to ${r.target}`, title);
  } catch (e) {
    console.error(e);
    notify("Send failed", e.message || String(e));
  }
});
