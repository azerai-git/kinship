// Toolbar popup: send the current tab to one of your Firefox Sync devices.
// Reading the current tab's URL/title relies on "activeTab", which the browser
// grants only for the tab you're on when you click the toolbar button.
import { loadAccount } from "./lib/account.js";
import * as device from "./lib/device.js";
import { COMMAND_SENDTAB } from "./lib/sendtab.js";
import { PRODUCT_NAME } from "./lib/config.js";

const $ = (id) => document.getElementById(id);
const sendable = (url) => /^(https?|ftp):/i.test(url || "");
const appUrl = chrome.runtime.getURL("app.html");

async function openApp() {
  const [ctx] = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [appUrl] }).catch(() => []);
  if (ctx?.tabId >= 0) await chrome.tabs.update(ctx.tabId, { active: true });
  else await chrome.tabs.create({ url: appUrl });
  window.close();
}
$("open-app").textContent = `Open ${PRODUCT_NAME}`;
$("open-app").addEventListener("click", openApp);
$("signin").addEventListener("click", openApp);

function msg(text, kind = "") { $("msg").textContent = text; $("msg").className = "meta " + kind; }

(async () => {
  chrome.action.setBadgeText({ text: "" }).catch(() => {});
  const acct = await loadAccount();
  if (!acct) { $("signed-out").hidden = false; return; }
  $("signed-in").hidden = false;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("tab-title").textContent = tab?.title || tab?.url || "";
  $("tab-title").title = tab?.url || "";

  // Device list: the background keeps a cached copy; refresh it if it's missing.
  let devices = (await chrome.storage.local.get("cache:devices"))["cache:devices"];
  if (!devices?.length) {
    try { devices = await (await import("./lib/fxa.js")).getDevices(acct.sessionToken); } catch { devices = []; }
  }
  const targets = (devices || []).filter((d) => !d.isCurrentDevice && d.availableCommands?.[COMMAND_SENDTAB]);

  if (!sendable(tab?.url)) { msg("Only web pages can be sent."); }
  if (!targets.length) { msg("No devices that can receive tabs. Sign in to Firefox Sync on another device."); return; }

  for (const d of targets) {
    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.disabled = !sendable(tab?.url);
    btn.append(Object.assign(document.createElement("span"), { textContent: d.name }),
      Object.assign(document.createElement("span"), { className: "meta", textContent: d.type || "" }));
    btn.addEventListener("click", async () => {
      document.querySelectorAll("#devices button").forEach((b) => (b.disabled = true));
      msg("Sending…");
      try {
        const r = await device.sendTab(acct, d.id, { title: tab.title || tab.url, url: tab.url }, devices);
        btn.classList.add("sent");
        msg(`Sent to ${r.target}.`, "ok");
        setTimeout(() => window.close(), 900);
      } catch (e) {
        console.error(e);
        msg(`Send failed: ${e.message || e}`, "error");
        document.querySelectorAll("#devices button").forEach((b) => (b.disabled = !sendable(tab?.url)));
      }
    });
    const li = document.createElement("li");
    li.append(btn);
    $("devices").append(li);
  }
})();
