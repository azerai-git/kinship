# Chrome Web Store submission — Kinship

Copy-paste material for the Developer Dashboard. Fields are in dashboard order.

---

## Before you submit (blockers)

1. **OAuth client.** The extension signs in using Firefox for Android's public
   OAuth registration (`lib/config.js`). Mozilla doesn't offer Sync sign-in to
   third-party apps. A published extension doing this at scale could be blocked
   by Mozilla at any time, or questioned as a terms-of-service issue. Ask Mozilla
   for a dedicated client (with an `https` redirect URI and the
   `https://identity.mozilla.com/apps/oldsync` scope), then change the two values in
   `lib/config.js`. If you publish before then, keep the disclosure below in the
   description.
2. **Privacy policy URL:** https://azerai-git.github.io/kinship/privacy.html
   (served by GitHub Pages from `docs/privacy.md`, a copy of `store/PRIVACY.md`.
   Keep them in sync).
3. **Screenshots.** At least one 1280×800 (or 640×400) PNG/JPEG. Suggested shots:
   Choose what to sync, Synced tabs, Bookmarks, Settings, and the toolbar
   "Send this tab to" popup.
4. **Trademarks.** The name uses "Firefox Sync" only descriptively, after the
   brand ("Kinship – works with Firefox Sync"), which follows the pattern in
   Mozilla's trademark policy ("NewGadget Extension for Firefox"). Never start
   the name with a Mozilla mark, never use the Firefox logo, and keep the
   "not affiliated" line. For certainty, ask trademark-permissions@mozilla.com
   (`build.ps1` enforces the name rule).
5. **Name availability.** Search the store and a trademark database (USPTO or
   EUIPO) for "Kinship" before committing.

---

## Store listing

**Name (≤ 75 chars):** Kinship – works with Firefox Sync

**Summary (≤ 132 chars):**
Unofficial Firefox Sync client for Chrome & Edge: your Firefox bookmarks, synced tabs, history and Send Tab, end-to-end encrypted.

**Category:** Productivity → Tools (or "Workflow & Planning")

**Language:** English

**Description:**

Use Chrome, Edge or another Chromium browser alongside Firefox, with your bookmarks, tabs and history kept in step, the way Firefox Sync does between Firefox devices.

Sign in with the Mozilla account you use for Firefox Sync. Kinship then works like another Firefox device:

• Bookmarks: your Firefox bookmarks appear in this browser's bookmarks and stay up to date. Or keep them inside Kinship only. (Two-way sync is coming.)
• Synced tabs: see what's open on your other Firefox devices, and (optionally) let them see this browser's tabs.
• History: browse and search your Firefox history, and (optionally) add this browser's history to it.
• Send Tab: click the toolbar button, or right-click any page or link → "Send to Firefox Sync device", to send it to your phone or another computer. Tabs sent to this browser open instantly.
• Automatic: syncs in the background, instantly when your other devices change.

Private by design
• End-to-end encrypted with your account's own key, the same as Firefox. Your data goes only to Mozilla's servers.
• No servers, analytics or tracking of our own.
• Nothing is shared from this browser until you choose it.
• You sign in on Mozilla's own page. Kinship never sees your password.

Good to know
• Kinship is an independent project, not affiliated with or endorsed by Mozilla. Firefox is a trademark of the Mozilla Foundation.
• Mozilla's sign-in page will say you're connecting "Firefox for Android". Kinship signs in through that app's registration, because Mozilla doesn't offer Sync sign-in to other apps.
• Passwords, addresses and payment methods aren't synced.

---

## Privacy practices tab

**Single purpose description:**
Kinship connects the browser to the user's Mozilla account (Firefox Sync) so their bookmarks, open tabs and history are shared between this browser and their Firefox devices, and lets them send tabs between devices.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Stores the user's sign-in tokens, encryption keys, settings and a local copy of their synced data. |
| `unlimitedStorage` | A user's synced history and bookmarks can exceed the default 10 MB local storage quota. |
| `alarms` | Runs the periodic sync (every 10 minutes) and the 30-second check for received tabs. |
| `contextMenus` | Adds the "Send to Firefox Sync device" right-click menu for pages and links. |
| `activeTab` | When the user clicks the toolbar button, reads the current tab's address and title so they can send it to one of their devices. No access to other tabs. |
| `notifications` | Tells the user when a tab arrives from another device, a send succeeds or fails, or they need to sign in again. |
| `bookmarks` (optional) | Requested only when the user chooses "Mirror Firefox bookmarks". It adds their Firefox bookmarks to the browser's bookmarks and keeps them updated. |
| `tabs` (optional) | Requested only when the user turns on "Share open tabs". It reads open tabs' titles and URLs so they appear on the user's other devices. |
| `history` (optional) | Requested only when the user turns on "Share browsing history". It reads visited pages so they're added to the user's Firefox history. |
| Host `accounts.firefox.com`, `*.accounts.firefox.com` | Mozilla account sign-in (OAuth), device registration, Send Tab, profile. The sign-in tab's redirect is observed to complete sign-in. |
| Host `*.services.mozilla.com` | Firefox Sync token server and storage servers, and Mozilla's push service for instant delivery. |

**Remote code:** No, I am not using remote code. (All JavaScript is in the package; the extension only exchanges JSON data with Mozilla's APIs.)

**Data usage, what you collect** (check these boxes):

- [x] **Authentication information** (Mozilla account tokens and keys, stored locally)
- [x] **Web history** (only if the user enables history sharing, sent encrypted to their own Mozilla account)
- [x] **User activity** (open tabs, only if the user enables tab sharing; tabs they choose to send)
- [ ] Personally identifiable information. The account email is shown in the UI from Mozilla's profile and isn't transmitted anywhere else. Check this box too if you'd rather be conservative.
- [ ] All others: not collected.

**Certifications** (all true for this extension):

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Notes for the reviewer** (Distribution → "Test instructions"):

Kinship needs a Mozilla account (free at accounts.firefox.com) with Firefox Sync data to show anything. To test: click the toolbar icon, then "Sign in" in the popup, then "Sign in with Mozilla" on the page that opens, and sign in on accounts.firefox.com. On "Choose what to sync", pick options. Each optional permission is requested only for the feature that needs it. Data goes only to Mozilla's servers (accounts.firefox.com, *.services.mozilla.com). The extension has no backend.
