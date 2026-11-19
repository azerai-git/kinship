import * as oauth from "./lib/oauth.js";
import * as device from "./lib/device.js";
import * as sendtab from "./lib/sendtab.js";
import { loadAccount, clearAccount, completeLogin } from "./lib/account.js";
import { normalizeSettings } from "./lib/engine.js";
import { PRODUCT_NAME, OAUTH_CLIENT_DISPLAY_NAME } from "./lib/config.js";

const $ = (id) => document.getElementById(id);
const views = ["view-login", "view-setup", "view-main"];

let account = null;
let flow = null;           // in-flight OAuth flow {url, verifier, state, privateKey, tabId}
let currentTab = "bookmarks";

// ---------- helpers ----------

function show(view) {
  for (const v of views) $(v).hidden = v !== view;
  $("who").hidden = view === "view-login";
  if (view === "view-login") $("reauth").hidden = true;
}

$("client-note").textContent = OAUTH_CLIENT_DISPLAY_NAME
  ? `Mozilla's page will say you're connecting "${OAUTH_CLIENT_DISPLAY_NAME}". ` +
    `That's expected: ${PRODUCT_NAME} signs in through that app's registration, because Mozilla doesn't offer Sync sign-in to other apps.`
  : "";

function status(msg, kind = "") {
  $("status").textContent = msg || "";
  $("status").className = kind;
}

function describeError(e) {
  const known = {
    110: "Session is no longer valid. Please sign in again.",
    114: "Too many attempts. Try again later.",
  };
  if (e.errno && known[e.errno]) return `${known[e.errno]} (errno ${e.errno})`;
  if (e.errno) return `${e.message} (errno ${e.errno}, HTTP ${e.status})`;
  if (e.status === 406) return `HTTP 406 from Mozilla's CDN (bot protection) for ${e.url || "a request"}.`;
  return e.message || String(e);
}

async function busy(btn, fn) {
  const buttons = document.querySelectorAll("button");
  buttons.forEach((b) => (b.disabled = true));
  try { return await fn(); }
  finally { buttons.forEach((b) => (b.disabled = false)); }
}

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}

function safeLink(url, text) {
  const ok = /^(https?|ftp|file):/i.test(url || "");
  const a = el("a", ok ? { href: url, target: "_blank", rel: "noopener noreferrer" } : {});
  a.textContent = text || url || "(untitled)";
  return a;
}

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString() : "");

// ---------- auth flow (Mozilla's sign-in page in a separate tab) ----------

function resetSignin(msg, kind) {
  flow = null;
  $("signin").disabled = false;
  $("cancel-signin").hidden = true;
  status(msg, kind);
}

async function onRedirect(url) {
  const f = flow;
  if (!f) return;
  flow = null; // handle once
  try {
    const code = oauth.parseRedirect(f, url);
    if (f.tabId) {
      chrome.tabs.remove(f.tabId).catch(() => {});
      const self = await chrome.tabs.getCurrent();
      if (self) chrome.tabs.update(self.id, { active: true }).catch(() => {});
    }
    status("Exchanging code and decrypting Sync key…");
    const result = await oauth.completeFlow(f, code);
    account = await completeLogin(result);
    resetSignin("Signed in. Sync key received.", "ok");
    enterMain();
  } catch (e) {
    console.error(e);
    resetSignin("Sign-in failed: " + describeError(e), "error");
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (flow && tabId === flow.tabId && changeInfo.url?.startsWith(oauth.redirectUri())) {
    onRedirect(changeInfo.url);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (flow && tabId === flow.tabId) resetSignin("Sign-in tab was closed.");
});

$("signin").addEventListener("click", () => startSignin());
$("reauth-btn").addEventListener("click", () => startSignin());

async function startSignin() {
  if (flow?.tabId) { chrome.tabs.update(flow.tabId, { active: true }).catch(() => {}); return; }
  try {
    $("signin").disabled = true;
    flow = await oauth.beginFlow();
    if (oauth.USES_IDENTITY_API) {
      // Dedicated client with a chromiumapp.org redirect: the browser runs the
      // sign-in window and hands back the final redirect URL.
      status("Finish signing in in the Mozilla window…");
      let redirected;
      try {
        redirected = await chrome.identity.launchWebAuthFlow({ url: flow.url, interactive: true });
      } catch (e) {
        return resetSignin(/did not approve|closed|canceled/i.test(e.message) ? "Sign-in was cancelled." : describeError(e), "error");
      }
      return onRedirect(redirected);
    }
    const tab = await chrome.tabs.create({ url: flow.url });
    flow.tabId = tab.id;
    $("cancel-signin").hidden = false;
    status("Finish signing in on the Mozilla tab…");
  } catch (e) {
    console.error(e);
    resetSignin(describeError(e), "error");
  }
}

$("cancel-signin").addEventListener("click", () => {
  if (flow?.tabId) chrome.tabs.remove(flow.tabId).catch(() => {});
  resetSignin("");
});

$("signout").addEventListener("click", () => busy(null, async () => {
  if (!confirm(`Sign out of ${PRODUCT_NAME}? This browser is removed from your Mozilla account. Mirrored bookmarks stay in place.`)) return;
  await clearAccount();
  account = null;
  $("content").replaceChildren();
  status("Signed out.");
  show("view-login");
}));

// ---------- main view: renders the background engine's cache, live ----------

const CACHE_KEYS = ["cache:bookmarks", "cache:history", "cache:tabs", "cache:clients", "cache:devices", "sync:state", "device", "settings"];
let data = {};

async function loadData() {
  const r = await chrome.storage.local.get(CACHE_KEYS);
  data = {
    bookmarks: r["cache:bookmarks"], history: r["cache:history"], tabs: r["cache:tabs"],
    clients: r["cache:clients"] || {}, devices: r["cache:devices"] || [], state: r["sync:state"] || {},
    me: r.device, settings: normalizeSettings(r.settings || {}, { hadSynced: !!r["sync:state"]?.lastSync }),
  };
}

let renderTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !account) return;
  if (!Object.keys(changes).some((k) => CACHE_KEYS.includes(k))) return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(async () => { await loadData(); renderSyncInfo(); render(); }, 250);
});

const ago = (ms) => {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
};

async function renderSyncInfo() {
  const st = data.state || {};
  let pushText = "";
  try {
    const r = await chrome.runtime.sendMessage({ type: "status" });
    pushText = data.settings?.delivery === "poll" ? " · checking for tabs every 30 s"
      : r?.result?.pushConnected ? " · instant delivery on" : " · instant delivery connecting…";
  } catch {}
  $("sync-info").textContent = `Synced ${ago(st.lastSync)}${pushText}`;
  $("sync-info").title = st.lastSync ? new Date(st.lastSync).toLocaleString() : "";
  $("reauth").hidden = !st.needsReauth;
  if (st.lastError && !st.needsReauth && (!st.lastSync || st.lastErrorAt > st.lastSync)) status(`Last sync failed: ${st.lastError}`, "error");
}
setInterval(() => { if (account) renderSyncInfo(); }, 15000);

async function enterMain() {
  $("who-email").textContent = account.email;
  await loadData();
  if (!data.settings.setupDone) return showSetup();
  show("view-main");
  renderSyncInfo();
  selectTab(currentTab);
  if (!data.state?.lastSync) status("First sync in progress…");
}

// ---------- "Choose what to sync" (first run + Settings) ----------

const PERMISSION_FOR = { bookmarks: "bookmarks", uploadTabs: "tabs", uploadHistory: "history" };

function radio(name, value, checked, label, hint, { disabled = false } = {}) {
  const input = el("input", { type: "radio", name, value });
  input.checked = checked;
  input.disabled = disabled;
  return el("label", { class: "choice" + (disabled ? " disabled" : "") }, input,
    el("span", {}, el("b", { text: label }), hint ? el("span", { class: "meta", text: " — " + hint }) : null));
}
function checkbox(name, checked, label, hint) {
  const input = el("input", { type: "checkbox", name });
  input.checked = checked;
  return el("label", { class: "choice" }, input,
    el("span", {}, el("b", { text: label }), hint ? el("span", { class: "meta", text: " — " + hint }) : null));
}

/** Builds the choices form; returns {node, read()}. Exported shape used by setup + settings. */
function buildChoices(s) {
  const form = el("form", { class: "choices" });
  form.append(
    el("fieldset", {}, el("legend", { text: "Bookmarks" }),
      radio("bookmarksMode", "mirror", s.bookmarksMode === "mirror", "Mirror Firefox bookmarks into this browser",
        "they appear in this browser's bookmarks and stay up to date; changes made here aren't sent to Firefox"),
      radio("bookmarksMode", "view", s.bookmarksMode === "view", `Keep them in ${PRODUCT_NAME} only`,
        "view and search them here; this browser's bookmarks are left alone"),
      radio("bookmarksMode", "twoway", false, "Two-way sync", "coming soon", { disabled: true })),
    el("fieldset", {}, el("legend", { text: "Share from this browser" }),
      checkbox("uploadTabs", s.uploadTabs, "Open tabs",
        "your Firefox devices can see this browser's open tabs (titles and addresses) in Synced Tabs"),
      checkbox("uploadHistory", s.uploadHistory, "Browsing history",
        "pages you visit here are added to your Firefox history, starting with the last 30 days")),
    el("fieldset", {}, el("legend", { text: "Receiving tabs sent to this browser" }),
      radio("delivery", "push", s.delivery === "push", "Instantly",
        "uses Mozilla's push service; keeps a connection open in the background"),
      radio("delivery", "poll", s.delivery === "poll", "Check every 30 seconds",
        "no background connection; tabs can take up to 30 s to arrive")));
  const read = () => {
    const fd = new FormData(form);
    return {
      bookmarksMode: fd.get("bookmarksMode") || "mirror",
      uploadTabs: fd.get("uploadTabs") === "on",
      uploadHistory: fd.get("uploadHistory") === "on",
      delivery: fd.get("delivery") || "push",
    };
  };
  return { node: form, read };
}

/**
 * Ask for the optional permissions the chosen settings need (must run inside the
 * click handler, before any other await), drop features whose permission was
 * refused, release permissions no longer needed, then hand off to the background.
 */
async function applyChoices(choice, { first }) {
  const want = [];
  if (choice.bookmarksMode === "mirror") want.push("bookmarks");
  if (choice.uploadTabs) want.push("tabs");
  if (choice.uploadHistory) want.push("history");
  let granted = true;
  if (want.length) granted = await chrome.permissions.request({ permissions: want }).catch(() => false);
  const refused = [];
  if (!granted) {
    for (const p of want) {
      if (await chrome.permissions.contains({ permissions: [p] }).catch(() => false)) continue;
      refused.push(p);
      if (p === "bookmarks") choice.bookmarksMode = "view";
      if (p === "tabs") choice.uploadTabs = false;
      if (p === "history") choice.uploadHistory = false;
    }
  }
  const unneeded = ["bookmarks", "tabs", "history"].filter((p) => !want.includes(p) || refused.includes(p));
  if (unneeded.length) await chrome.permissions.remove({ permissions: unneeded }).catch(() => {});
  status(first ? "Starting sync…" : "Saving…");
  const r = await chrome.runtime.sendMessage({ type: "settings-changed", patch: { ...choice, setupDone: true } });
  if (!r?.ok) throw new Error(r?.error || "Background didn't respond");
  return refused;
}

let setupChoices = null;
function showSetup() {
  show("view-setup");
  setupChoices = buildChoices(data.settings);
  $("setup-choices").replaceChildren(setupChoices.node);
}

$("setup-start").addEventListener("click", () => {
  const choice = setupChoices.read();
  busy(null, async () => {
    try {
      const refused = await applyChoices(choice, { first: true });
      await loadData();
      show("view-main");
      renderSyncInfo();
      selectTab("bookmarks");
      status(refused.length ? `Syncing. Skipped (permission not granted): ${refused.join(", ")}.` : "Syncing. You can change these choices in Settings.", refused.length ? "" : "ok");
    } catch (e) {
      status("Couldn't start: " + describeError(e), "error");
    }
  });
});

function selectTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === tab));
  render();
}

document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => selectTab(b.dataset.tab)));

$("filter").addEventListener("input", () => render());

$("sync-now").addEventListener("click", () => busy(null, async () => {
  status("Syncing…");
  const r = await chrome.runtime.sendMessage({ type: "sync-now" });
  if (r?.ok) status("Sync complete.", "ok"); else status("Sync failed: " + (r?.error || "unknown error"), "error");
}));

function render() {
  const box = $("content");
  const q = $("filter").value.trim().toLowerCase();
  const match = (...s) => !q || s.some((x) => (x || "").toLowerCase().includes(q));
  try {
    box.replaceChildren(renderers[currentTab](match, q));
  } catch (e) {
    console.error(e);
    box.replaceChildren(el("p", { class: "meta", text: "Nothing synced yet." }));
  }
}

const ROOTS = [
  ["toolbar", "Bookmarks Toolbar"],
  ["menu", "Bookmarks Menu"],
  ["unfiled", "Other Bookmarks"],
  ["mobile", "Mobile Bookmarks"],
];

const empty = (text = "Nothing synced yet.") => el("p", { class: "meta", text });


const renderers = {
  bookmarks(match, q) {
    const recs = data.bookmarks;
    if (!recs) return empty();
    const byId = new Map(Object.entries(recs));
    const count = [...byId.values()].filter((r) => r.type === "bookmark").length;
    const frag = el("div", {},
      el("p", { class: "meta", text: `${count} bookmarks. ` + (data.settings.bookmarksMode === "mirror"
        ? "Mirrored into this browser's bookmarks automatically (Firefox → here)."
        : `Kept in ${PRODUCT_NAME} only; this browser's bookmarks aren't changed (see Settings).`) }));
    if (q) {
      const ul = el("ul", { class: "tree root" });
      for (const r of byId.values()) {
        if (r.type === "bookmark" && match(r.title, r.bmkUri)) {
          ul.append(el("li", { class: "item" }, safeLink(r.bmkUri, r.title), el("span", { class: "url", text: r.bmkUri })));
        }
      }
      frag.append(ul);
      return frag;
    }
    const seen = new Set();
    const build = (id) => {
      const r = byId.get(id);
      if (!r || seen.has(id)) return null;
      seen.add(id);
      if (r.type === "folder") {
        const ul = el("ul", { class: "tree" });
        for (const cid of r.children || []) { const n = build(cid); if (n) ul.append(n); }
        return el("li", {}, el("details", {}, el("summary", { text: `📁 ${r.title || id} (${(r.children || []).length})` }), ul));
      }
      if (r.type === "bookmark") {
        return el("li", { class: "item" }, safeLink(r.bmkUri, r.title), el("span", { class: "url", text: r.bmkUri }));
      }
      if (r.type === "separator") return el("li", { class: "meta", text: "────────" });
      return el("li", { class: "item meta", text: `[${r.type}] ${r.title || ""}` });
    };
    const root = el("ul", { class: "tree root" });
    for (const [id, name] of ROOTS) {
      const r = byId.get(id);
      if (!r) continue;
      const n = build(id);
      n.querySelector("summary").textContent = `📁 ${name} (${(r.children || []).length})`;
      root.append(n);
    }
    frag.append(root);
    return frag;
  },

  history(match) {
    if (!data.history) return empty();
    const all = Object.values(data.history);
    const rows = all
      .map((r) => ({ ...r, last: Math.max(0, ...(r.visits || []).map((v) => v.date)) / 1000 }))
      .filter((r) => match(r.title, r.histUri))
      .sort((a, b) => b.last - a.last);
    const table = el("table", {}, el("tr", {}, el("th", { text: "Page" }), el("th", { text: "Last visit" }), el("th", { text: "Visits" })));
    for (const r of rows.slice(0, 2000)) {
      table.append(el("tr", {},
        el("td", { class: "item" }, safeLink(r.histUri, r.title), el("span", { class: "url", text: r.histUri })),
        el("td", { class: "meta", text: fmtDate(r.last) }),
        el("td", { class: "meta", text: String((r.visits || []).length) })));
    }
    return el("div", {}, el("p", { class: "meta", text: `${all.length} recent history entries from all devices (showing ${Math.min(rows.length, 2000)})` }), table);
  },

  tabs(match) {
    if (!data.tabs) return empty();
    const ownId = data.state?.clientId;
    const known = new Set(Object.keys(data.clients || {}));
    const box = el("div");
    const newest = (c) => Math.max(0, ...(c.tabs || []).map((t) => t.lastUsed || 0));
    const clients = Object.values(data.tabs)
      .filter((c) => c.id !== ownId && (!known.size || known.has(c.id)))
      .sort((a, b) => newest(b) - newest(a));
    for (const client of clients) {
      const tabs = (client.tabs || []).filter((t) => match(t.title, t.urlHistory?.[0]))
        .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
      const ul = el("ul", { class: "tree root" });
      for (const t of tabs) {
        const url = t.urlHistory?.[0];
        ul.append(el("li", { class: "item" }, safeLink(url, t.title), el("span", { class: "url", text: url })));
      }
      const name = data.clients?.[client.id]?.name || client.clientName || client.id;
      box.append(el("div", { class: "device" }, el("h3", { text: `${name} — ${tabs.length} tabs` }), ul));
    }
    if (!clients.length) box.append(empty("No other devices are sharing tabs."));
    return box;
  },

  devices(match) {
    const box = el("div");
    const me = data.me;

    if (me) {
      const nameIn = el("input", { type: "text", value: me.name, "aria-label": "Device name" });
      const renameBtn = el("button", { class: "secondary", text: "Rename" });
      renameBtn.addEventListener("click", () => busy(null, async () => {
        try {
          await device.renameDevice(account, nameIn.value.trim() || device.defaultDeviceName());
          await chrome.runtime.sendMessage({ type: "sync-now" });
          status("Renamed.", "ok");
        } catch (e) { status(describeError(e), "error"); }
      }));
      box.append(el("h3", { text: "This browser" }), el("div", { class: "row inline" }, nameIn, renameBtn));
    }

    const devices = data.devices || [];
    const targets = devices.filter((d) => !d.isCurrentDevice && d.availableCommands?.[sendtab.COMMAND_SENDTAB]);
    const urlIn = el("input", { type: "url", placeholder: "https://…", "aria-label": "URL to send" });
    const sel = el("select", { "aria-label": "Target device" });
    for (const d of targets) sel.append(el("option", { value: d.id, text: d.name }));
    const sendBtn = el("button", { class: "primary", text: "Send" });
    if (!targets.length) sendBtn.disabled = true;
    sendBtn.addEventListener("click", () => busy(null, async () => {
      try {
        const url = urlIn.value.trim();
        if (!/^(https?|ftp):\/\//i.test(url)) throw new Error("Enter a full http(s) URL.");
        const r = await device.sendTab(account, sel.value, { title: url, url });
        status(`Sent to ${r.target}.`, "ok");
        urlIn.value = "";
      } catch (e) { status("Send failed: " + describeError(e), "error"); }
    }));
    box.append(el("h3", { text: "Send a page" }), el("div", { class: "row inline" }, urlIn, sel, sendBtn),
      el("p", { class: "hint", text: "Or right-click any page or link → “Send to device”. Tabs sent here open automatically." }));

    const table = el("table", {}, el("tr", {},
      el("th", { text: "Name" }), el("th", { text: "Type" }), el("th", { text: "Last active" }), el("th", { text: "Send Tab?" })));
    for (const d of devices.filter((d) => match(d.name, d.type))) {
      const can = !!d.availableCommands?.[sendtab.COMMAND_SENDTAB];
      table.append(el("tr", {},
        el("td", { text: d.name + (d.isCurrentDevice ? " (this browser)" : "") }),
        el("td", { class: "meta", text: d.type }),
        el("td", { class: "meta", text: fmtDate(d.lastAccessTime) }),
        el("td", { class: "meta", text: can ? "yes" : "—" })));
    }
    box.append(el("h3", { text: "Devices on your account" }), table);
    return box;
  },

  settings() {
    const box = el("div");
    const choices = buildChoices(data.settings);
    const save = el("button", { class: "primary", text: "Save" });
    save.addEventListener("click", (ev) => {
      ev.preventDefault();
      const choice = choices.read();               // read before the permission prompt
      busy(null, async () => {
        try {
          const refused = await applyChoices(choice, { first: false });
          await loadData();
          render();
          status(refused.length ? `Saved. Not enabled (permission not granted): ${refused.join(", ")}.` : "Saved.", refused.length ? "" : "ok");
        } catch (e) { status("Couldn't save: " + describeError(e), "error"); }
      });
    });
    box.append(choices.node, el("div", { class: "row" }, save),
      el("p", { class: "hint", text: "Switching bookmarks away from “Mirror” removes the bookmarks it added. " +
        "Turning off open tabs removes this browser from Firefox's Synced Tabs. History already shared stays in Firefox." }));
    return box;
  },

  raw() {
    const st = data.state || {};
    const diag = el("p", { class: "meta", text: "Push: checking…" });
    Promise.all([chrome.runtime.sendMessage({ type: "status" }), chrome.storage.local.get("push:last")]).then(([r, l]) => {
      const s = r?.result || {};
      const last = l["push:last"];
      diag.textContent = `Push connection: ${s.pushStatus || "?"} · endpoint registered with Mozilla: ${s.pushEndpointRegistered ? "yes" : "no"}` +
        ` · last push received: ${last ? `${ago(last.at)} (${last.command})` : "none yet"}`;
    }).catch(() => { diag.textContent = "Push: background not reachable"; });
    const counts = { bookmarks: data.bookmarks, history: data.history, tabs: data.tabs, clients: data.clients };
    const table = el("table", {}, el("tr", {}, el("th", { text: "Collection" }), el("th", { text: "Cached records" }), el("th", { text: "Server last modified" })));
    for (const [name, ts] of Object.entries(st.modified || {}).sort()) {
      const c = counts[name];
      table.append(el("tr", {}, el("td", { text: name }), el("td", { class: "meta", text: c ? String(Object.keys(c).length) : "—" }),
        el("td", { class: "meta", text: fmtDate(ts * 1000) })));
    }
    const engines = Object.keys(st.meta?.engines || {}).sort().join(", ");
    return el("div", {}, diag,
      el("p", { class: "meta", text: `Last sync: ${st.lastSync ? new Date(st.lastSync).toLocaleString() : "never"}` +
        (st.lastError ? ` · last error: ${st.lastError}` : "") }),
      el("p", { class: "meta", text: `Engines enabled on your account: ${engines || "?"}` +
        (st.meta?.declined?.length ? ` · declined: ${st.meta.declined.join(", ")}` : "") }),
      table);
  },
};

// ---------- boot ----------

(async () => {
  account = await loadAccount();
  if (account) enterMain();
  else show("view-login");
})();
