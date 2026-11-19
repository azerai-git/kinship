# Kinship – works with Firefox Sync

A Manifest V3 extension for Chrome, Edge or any Chromium browser. It makes the
browser a Firefox Sync device for your Mozilla account: it receives your
bookmarks, history and synced tabs; optionally shares its own open tabs and
history; and supports Send Tab with instant delivery. It has no runtime
dependencies.

Kinship is an independent project, not affiliated with Mozilla. Branding
and the OAuth client live in `lib/config.js`.

## Load it (development)

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder. After changing files, click the
   extension's reload icon.
3. Click the toolbar icon, then **Sign in with Mozilla**. Mozilla's own page opens
   in a new tab, where you enter your password and 2FA.
4. On **Choose what to sync**, pick your options. Your browser asks for permission
   only for the features you pick.

Everything then syncs in the background, and the page updates live. Errors appear
on the page and in **Sync status**. For details, go to the extensions page →
"service worker" link.

## Release (Chrome Web Store)

1. Bump `version` in `manifest.json`.
2. Run `powershell -ExecutionPolicy Bypass -File .\build.ps1`. It checks the
   manifest (MV3, description ≤ 132 chars, Mozilla marks in the name only as "works with / for Firefox (Sync)" after the brand,
   icons), checks that every import and file reference resolves inside the
   package (so no test code ships), and rejects `eval`. Then it writes
   `dist/kinship-<version>.zip` with only runtime files.
3. Upload the zip. Dashboard text, permission justifications, data disclosures
   and reviewer notes are in `store/LISTING.md`. Host `store/PRIVACY.md` and use
   its URL as the privacy policy.
4. Read the **Before you submit** blockers at the top of `store/LISTING.md`
   (OAuth client, privacy policy URL, screenshots, trademarks).

## Settings ("Choose what to sync")

Shown on first sign-in, and later under **Settings**. Nothing is written to the
browser or uploaded until the user confirms it.

| Setting | Options (default **bold**) | Permission |
|---|---|---|
| Bookmarks | **Mirror Firefox → this browser** · Keep in Kinship only · Two-way (coming soon) | `bookmarks` (mirror only) |
| Share open tabs | on · **off** | `tabs` |
| Share browsing history | on · **off** | `history` |
| Receiving tabs | **Instantly (Mozilla push service)** · Check every 30 seconds | none |

`bookmarks`, `tabs` and `history` are **optional permissions**. They're requested
when the matching feature is turned on and released when it's turned off.
Switching away from Mirror removes the bookmarks it added. Turning off tab
sharing deletes this browser's tabs record, so it leaves Firefox's Synced Tabs.
Switching to 30-second checks closes the push connection and clears the device's
`pushCallback`. Installs from before the settings screen are migrated with their
existing choices. If Mozilla revokes the session, syncing pauses and a **Sign in
again** banner appears.

## What syncs (like Firefox)

| | Direction | When |
|---|---|---|
| Bookmarks | Firefox → this browser (mirrored into native bookmarks) | on change (push), every 10 min, Sync now |
| Synced tabs | both ways (this browser shows up in Firefox's Synced Tabs) | uploads within ~5 s of a tab change |
| History | both ways (Firefox history shown in the extension; this browser's visits are added to Firefox) | uploads within ~1 min of a visit; first run backfills 30 days (≤ 2,000 pages) |
| Send Tab | both ways | instant (push), or every 30 s; with push connected, a safety check every 5 min |

The extension only uploads engines your account has enabled (per `meta/global`,
respecting `declined`).

**Sync triggers** match Firefox: push messages from Mozilla
(`sync:collection_changed`, `fxaccounts:command_received`, device connect and
disconnect), a 10-minute schedule, startup, and **Sync now**. Downloads are
incremental (`info/collections` timestamps, then `?newer=`) into a local cache.
The UI renders from that cache.

**Bookmark mirror** (one-way for now; designed for two-way later):

| Firefox | Browser |
|---|---|
| Bookmarks Toolbar | Bookmarks/Favorites bar (after your own items) |
| Other Bookmarks | Other bookmarks/favorites (after your own items) |
| Mobile Bookmarks | Mobile bookmarks root (or a folder in Other) |
| Bookmarks Menu | "Bookmarks Menu" folder in Other |

The mirror only ever touches bookmarks it created, tracked by Firefox GUID. Edits
in the browser to mirrored items are overwritten on the next sync. Separators and
smart queries are skipped. Turning the mirror off removes everything it created.

**Push:** the background worker keeps a WebSocket to Mozilla's push service
(`wss://push.services.mozilla.com`), using Firefox's protocol (hello, register,
notification, ack). It registers the endpoint as the device's `pushCallback`.
Messages are Web Push `aes128gcm`. The worker stays alive while you're signed in.
Chromium needs the `push-notification` subprotocol left out: the server doesn't
echo it, and Chromium fails the handshake (Firefox doesn't).

## Send Tab

- **Sending:** click the **toolbar button** (popup: pick a device; uses
  `activeTab`), or right-click any page or link → **Send to Firefox Sync device**,
  or use the "Send a page" box on **Devices**. Chromium doesn't let extensions add
  items to the tab-strip right-click menu. That menu's "Send to your devices" is
  Edge's own Microsoft-account feature.
- **Receiving:** tabs open in the background, with a notification and a badge count.
- **Protocol:** the device publishes `availableCommands["https://identity.mozilla.com/cmd/open-uri"]`,
  which holds a P-256 public key + auth secret, encrypted with the Sync key
  (`{kid, IV, hmac, ciphertext}`). Tabs are Web Push `aes128gcm` (RFC 8291) sent
  through `invoke_command`, and read from `device/commands?index=`.

## Why browser sign-in (not a password form)

Mozilla's CDN (Fastly) runs bot protection. It answers direct
`POST /v1/account/login` requests from anything other than Mozilla's own sign-in
page with an empty **HTTP 406**. So the extension uses the same flow mobile
Firefox uses: OAuth authorization code + PKCE with **scoped keys**.

```
extension: PKCE verifier/challenge + state + ephemeral ECDH P-256 key pair
tab → accounts.firefox.com/authorization?client_id=…&keys_jwk=<our public key>&scope=profile oldsync tokens/session
user signs in on Mozilla's page (password, 2FA, email confirmation…)
Mozilla redirects to accounts.firefox.com/oauth/success/<client_id>?code=…&state=…  ← extension watches the tab URL
POST /v1/oauth/token {grant_type: authorization_code, code, code_verifier}
   → access_token, refresh_token, session_token, keys_jwe
keys_jwe ──ECDH-ES + A256GCM with our private key──► { oldsync: { k: kSync (64 bytes), kid } }
access_token + X-KeyID: kid ──► tokenserver ──► Hawk creds + storage endpoint
storage/crypto/keys (decrypt with kSync) ──► collection keys ──► decrypt / encrypt records
```

The refresh token mints access tokens and is used for removing the device. The
session token (Hawk) is used for device registration, the device list and
commands. Signing in repeatedly in a short time makes Mozilla block sign-ins
temporarily ("request was blocked for security reasons").

## Files

- `background.js`: push, sync scheduling, tab and history tracking, Send Tab receive, context menu
- `lib/engine.js`: sync engine (incremental cache, uploads of clients, tabs and history records)
- `lib/mirror.js`: bookmark mirror into `chrome.bookmarks`
- `lib/push.js`: Mozilla push (autopush) WebSocket client
- `lib/oauth.js`: browser OAuth flow, PKCE, `keys_jwe` (ECDH-ES / Concat KDF / AES-GCM)
- `lib/sync.js`: tokenserver, Sync storage read and write, record crypto
- `lib/webpush.js`: RFC 8291 / RFC 8188 `aes128gcm`
- `lib/sendtab.js`, `lib/device.js`: Send Tab format, device registration and commands
- `lib/fxa.js`: Mozilla accounts API (Hawk / Bearer). `lib/hawk.js`, `lib/crypto.js`: primitives
- `lib/account.js`: sign-in state and token handling
- `app.*`: the UI (reads the cache). `icons/`
- `tests/` (dev only). Run `tests/serve.ps1 -Root <this folder>`, then open:
  - `test.html`: 33 crypto tests (Mozilla onepw, Hawk, RFC 7518 ECDH-ES, RFC 8291 byte-exact)
  - `test-engine.html`: 26 tests. Settings migration, plus the mirror runs against a fake `chrome.bookmarks`
    that copies Chrome's move semantics. Also covers the tabs and history records
    and record encryption.
  - `push-test.html`: live push round trip through Mozilla's push service (no account needed)
  - `live*.html`: live harnesses (need a sign-in). `live-engine.html` exercises
    push, the engine and the mirror (into a fake bookmark tree). `cleanup()` deletes
    its test records and revokes tokens.
  - `ui-dev.html`: the real UI with `chrome.*` stubbed (sample data via `localStorage.devStore`).

## Verified (2026-11-19)

- **Live account:** sign-in, `keys_jwe`, tokenserver, decryption of every
  collection, Send Tab key interop with 4 real Firefox devices, a Send Tab round
  trip, and token revocation. The user confirmed Send Tab Firefox → Edge in Edge.
- **Push service:** connected from Chromium, got an endpoint, and received and
  decrypted a pushed message in 389 ms. The subscription survives reconnects.
- **Offline:** engine, mirror and UI tests (above).
- **Not yet verified live:**
  - Mozilla accounts delivering pushes to the endpoint.
  - Uploads of the clients, tabs and history records.
  - The mirror into real Edge bookmarks.
  - Device removal on sign-out.

  The live harness couldn't run because Mozilla temporarily blocked further
  sign-ins. The first run in Edge covers all of these, and **Sync status** shows
  the push diagnostics.

## Caveats

- **OAuth client id.** Mozilla only lets its own apps request the Sync scope. This
  borrows **Firefox for Android**'s public registration (`a2270f727f45f648`).
  "Connected services" shows it as Firefox for Android. Mozilla doesn't sanction
  this and could break it at any time. The same goes for using Mozilla's push
  service from a non-Firefox client.
- **Secrets at rest.** `chrome.storage.local` holds the refresh token, session
  token, Sync key and Send Tab and push private keys. They aren't encrypted.
  **Sign out** removes the device and revokes the tokens.
- **Always-on worker.** To keep the push socket open, the worker makes a trivial
  extension API call every 20 s while you're signed in.
- **History into the browser.** Not possible: `history.addUrl` can't set titles or
  visit times. Firefox history is shown in the extension only.
- **Not built:** two-way bookmark sync, passwords, form data, and "close tabs on other devices".

## License

Copyright (C) 2026 Azerai. Kinship is licensed under the Mozilla Public License
2.0 (see [LICENSE](LICENSE)), the same license Mozilla uses for Firefox and
Mozilla accounts. Changes to Kinship's files must stay under the MPL when
distributed; Kinship's code can be combined with code under other licenses.
