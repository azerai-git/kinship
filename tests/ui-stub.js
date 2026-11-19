// Dev-only: stub chrome.* + proxy fetch so app.html's real UI code runs in a
// normal localhost page. Initial storage comes from localStorage("devStore")
// (a JSON object of chrome.storage.local keys); sample data only.
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (url, opts) => {
  const s = String(url);
  if (/^https:\/\/([a-z0-9-]+\.)*(accounts\.firefox\.com|services\.mozilla\.com)\//.test(s)) {
    return realFetch(`/proxy?url=${encodeURIComponent(s)}`, opts);
  }
  return realFetch(url, opts);
};
let store = {};
try { store = JSON.parse(localStorage.getItem("devStore") || "{}"); } catch {}
const listeners = [];
const ev = () => ({ addListener() {} });
globalThis.chrome = {
  storage: {
    local: {
      async get(k) { const o = {}; for (const x of [].concat(k)) if (x in store) o[x] = structuredClone(store[x]); return o; },
      async set(o) {
        const changes = {};
        for (const [k, v] of Object.entries(o)) changes[k] = { oldValue: store[k], newValue: v };
        Object.assign(store, structuredClone(o));
        listeners.forEach((f) => f(changes, "local"));
      },
      async remove(k) { for (const x of [].concat(k)) delete store[x]; },
    },
    onChanged: { addListener(f) { listeners.push(f); } },
  },
  runtime: {
    async sendMessage(msg) {
      window.__sent = [...(window.__sent || []), msg.type === "settings-changed" ? { patch: msg.patch } : msg.type];
      if (msg.type === "status") return { ok: true, result: { pushStatus: "connected", pushConnected: true, pushEndpointRegistered: true } };
      if (msg.type === "settings-changed") {   // what the background does with it
        await chrome.storage.local.set({ settings: { ...(store.settings || {}), ...msg.patch } });
      }
      return { ok: true, result: null };
    },
  },
  // Optional permissions: window.__grant decides whether the prompt is accepted.
  permissions: {
    granted: new Set(JSON.parse(localStorage.getItem("devPerms") || "[]")),
    async request({ permissions }) {
      window.__permRequests = [...(window.__permRequests || []), permissions];
      if (window.__grant === false) return false;
      permissions.forEach((p) => chrome.permissions.granted.add(p));
      return true;
    },
    async contains({ permissions }) { return permissions.every((p) => chrome.permissions.granted.has(p)); },
    async remove({ permissions }) { permissions.forEach((p) => chrome.permissions.granted.delete(p)); return true; },
  },
  tabs: { onUpdated: ev(), onRemoved: ev(), async getCurrent() { return null; },
          async create() { return { id: 1 }; }, async remove() {}, async update() {} },
};
window.__store = store;
window.confirm = () => true;
