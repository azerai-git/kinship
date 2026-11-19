# Kinship — Privacy Policy

_Last updated: 2026-11-19_

Kinship is a browser extension that connects this browser to **your own
Mozilla account**, the account Firefox uses for Firefox Sync. It is an
independent project, not affiliated with or endorsed by Mozilla.

## The short version

- Kinship has **no servers of its own**. Its developer never receives,
  stores or sees any of your data.
- Your data travels only between this browser and **Mozilla's servers**, the same
  servers Firefox uses.
- Sync data is **end-to-end encrypted**: it's encrypted on your device with your
  account's Sync key before it's uploaded. Mozilla can't read it.
- Nothing is shared from this browser until you choose it on the **Choose what to
  sync** screen. You can change those choices at any time in Settings.

## What Kinship accesses, and why

| Data | When | What happens to it |
|---|---|---|
| Your Mozilla account sign-in | When you sign in | You sign in on Mozilla's own page (accounts.firefox.com). Kinship never sees your password. It receives sign-in tokens and your account's Sync encryption key, and stores them in this browser's extension storage. |
| Your Firefox Sync data (bookmarks, history, open tabs on your other devices, device list) | While you're signed in | Downloaded from Mozilla's servers, decrypted on this device, and stored locally so Kinship can show it. |
| This browser's bookmarks (optional, "Mirror" setting) | Only if you choose "Mirror Firefox bookmarks" | Kinship adds your Firefox bookmarks to this browser's bookmarks and keeps them up to date. It only changes bookmarks it created. Nothing from this browser's bookmarks is uploaded. |
| This browser's open tabs (optional, "Open tabs" setting) | Only if you turn it on | The titles and addresses of open tabs (not private/incognito windows) are encrypted and uploaded to your Mozilla account, so your other devices can show them in Synced Tabs. |
| This browser's history (optional, "Browsing history" setting) | Only if you turn it on | Addresses, titles and visit times of pages you visit (from the last 30 days when first enabled, then as you browse) are encrypted and uploaded to your Mozilla account. History is never deleted from Firefox. |
| Tabs you send | When you use "Send to device" | The page's address and title are encrypted for the device you picked and delivered through Mozilla's servers. |
| Push messages | If "Receive tabs instantly" is on | Kinship keeps a connection to Mozilla's push service (push.services.mozilla.com) so tabs and sync notifications arrive instantly. Messages are encrypted for this browser. |

## Where your data is stored

- **On this device:** extension storage holds your sign-in tokens, encryption keys
  and a local copy of your synced data. It isn't encrypted at rest beyond what
  your browser and operating system provide. Anyone with access to your browser
  profile could read it.
- **At Mozilla:** in your Mozilla account, under Mozilla's own privacy policy
  (https://www.mozilla.org/privacy/mozilla-accounts/).

## What Kinship does NOT do

- It doesn't collect analytics, telemetry or crash reports.
- It doesn't sell, transfer or share your data with anyone other than Mozilla, and
  then only as described above, to provide the sync features you turned on.
- It doesn't use your data for advertising, credit-worthiness, or any purpose
  other than syncing.
- It doesn't load or run remote code.

## Your controls

- **Settings** turns each feature on or off. Turning off "Mirror" removes the
  bookmarks it added. Turning off "Open tabs" removes this browser from your
  other devices' Synced Tabs.
- **Sign out** removes this browser from your Mozilla account, revokes its access,
  and deletes its local copy of your synced data. Mirrored bookmarks stay unless
  you turned the mirror off first.
- Removing the extension deletes all of its local storage.
- To delete data stored in your Mozilla account, use Mozilla's account settings
  at accounts.firefox.com.

## Contact

Questions about this policy: open an issue at https://github.com/azerai-git/kinship/issues.
