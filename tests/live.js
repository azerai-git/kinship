// Dev-only harness: runs the extension's lib modules against the real Mozilla
// servers from a localhost page. Mozilla doesn't send CORS headers for
// localhost, so Mozilla-bound fetches are routed through the local server's
// /proxy endpoint (the extension itself doesn't need this). Logs only status
// codes, counts and record *shapes* — never bookmark/history contents.
import * as oauth from "../lib/oauth.js";
import * as fxa from "../lib/fxa.js";
import { getSyncToken, SyncClient } from "../lib/sync.js";

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (url, opts) => {
  const s = String(url);
  if (/^https:\/\/([a-z0-9-]+\.)*(accounts\.firefox\.com|services\.mozilla\.com)\//.test(s)) {
    return realFetch(`/proxy?url=${encodeURIComponent(s)}`, opts);
  }
  return realFetch(url, opts);
};

const logEl = document.getElementById("log");
function log(msg, cls = "") {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = msg;
  logEl.append(d);
  console.log(msg);
}
const errText = (e) => `${e.name}: ${e.message}` + (e.status ? ` [HTTP ${e.status}]` : "") +
  (e.errno ? ` [errno ${e.errno}]` : "") + (e.body ? ` body=${JSON.stringify(e.body).slice(0, 400)}` : "");
const shape = (o) => Object.keys(o || {}).sort().join(",");

let flow = null;
let session = null; // {accessToken, refreshToken, sessionToken, kSync, kid}

window.start = async () => {
  flow = await oauth.beginFlow();
  log("flow started; state=" + flow.state.slice(0, 4) + "…");
  return flow.url;
};

async function step(name, fn) {
  try {
    const r = await fn();
    log(`OK   ${name}`, "ok");
    return r;
  } catch (e) {
    log(`FAIL ${name}: ${errText(e)}`, "err");
    console.error(e);
    throw e;
  }
}

window.finish = async (redirectUrl) => {
  const code = await step("parse redirect", () => oauth.parseRedirect(flow, redirectUrl));
  session = await step("exchange code + decrypt keys_jwe", () => oauth.completeFlow(flow, code));
  log(`     scope="${session.scope}" refresh=${!!session.refreshToken} session=${!!session.sessionToken} kSync=${session.kSync.length}B kid=${session.kid.split("-")[0]}-…`);
  return window.syncTest();
};

window.syncTest = async () => {
  const s = session;
  const prof = await step("profile", () => oauth.getProfile(s.accessToken)).catch(() => null);
  if (prof) log(`     profile fields: ${shape(prof)}`);
  const refreshed = await step("refresh token → access token", () => oauth.refreshAccessToken(s.refreshToken));
  const tok = await step("tokenserver", () => getSyncToken(refreshed.accessToken, s.kid));
  log(`     api_endpoint host=${new URL(tok.api_endpoint).host} duration=${tok.duration}`);
  const client = new SyncClient(tok, s.kSync);
  const info = await step("info/collections", () => client.info());
  log(`     collections: ${Object.keys(info).sort().join(", ")}`);
  const keys = await step("crypto/keys decrypt", () => client.loadKeys());
  log(`     per-collection keys: ${Object.keys(keys.collections).length}`);
  for (const [coll, opts] of [["bookmarks", { sort: "index" }], ["tabs", {}], ["history", { max: 200, limit: 200 }], ["clients", {}]]) {
    if (!(coll in info)) { log(`     (no ${coll} collection)`); continue; }
    const recs = await step(`fetch+decrypt ${coll}`, () => client.fetchCollection(coll, opts)).catch(() => null);
    if (recs) {
      const types = {};
      for (const r of recs) types[r.type ?? (r.deleted ? "deleted" : "-")] = (types[r.type ?? (r.deleted ? "deleted" : "-")] || 0) + 1;
      log(`     ${coll}: ${recs.length} records; types ${JSON.stringify(types)}; first record fields: ${shape(recs.find((r) => !r.deleted))}`);
    }
  }
  if (s.sessionToken) {
    const devs = await step("devices (Hawk session token)", () => fxa.getDevices(s.sessionToken)).catch(() => null);
    if (devs) log(`     devices: ${devs.length}; types ${JSON.stringify(devs.map((d) => d.type))}; send-tab capable: ${devs.filter((d) => Object.keys(d.availableCommands || {}).some((k) => k.includes("open-uri"))).length}`);
  }
  log("done.");
  return "done";
};

window.cleanup = async () => {
  if (session?.refreshToken) await step("destroy refresh token", () => oauth.destroyRefreshToken(session.refreshToken)).catch(() => {});
  if (session?.sessionToken) await step("destroy session", () => fxa.destroySession(session.sessionToken)).catch(() => {});
  session = null;
};

log("ready. call start()");
