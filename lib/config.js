// Product configuration — the one place to change branding and the OAuth client.
export const PRODUCT_NAME = "Kinship";

// OAuth client used to sign in to Mozilla accounts.
//
// Mozilla only grants the Sync scope (and its encryption key) to clients it has
// allowlisted. Until Mozilla registers a client for this extension, it uses the
// public registration of Firefox for Android ("firefox-android" mode), whose
// redirect is a normal https page the extension observes in the sign-in tab.
//
// If Mozilla registers a dedicated client with the standard extension redirect
// (https://<extension-id>.chromiumapp.org/):
//   1. set OAUTH_CLIENT_ID to the new id and OAUTH_REDIRECT_MODE to "chromiumapp"
//   2. set OAUTH_CLIENT_DISPLAY_NAME to null (Mozilla's page will show "Kinship")
//   3. add "identity" to "permissions" in manifest.json (build.ps1 checks this)
// Sign-in then uses chrome.identity.launchWebAuthFlow instead of watching a tab.
export const OAUTH_CLIENT_ID = "a2270f727f45f648";
export const OAUTH_REDIRECT_MODE = "firefox-android";   // "firefox-android" | "chromiumapp"
// Shown to users so the "Firefox for Android" wording on Mozilla's page isn't a surprise.
export const OAUTH_CLIENT_DISPLAY_NAME = "Firefox for Android";

/** The redirect URI registered for OAUTH_CLIENT_ID. */
export function oauthRedirectUri() {
  if (OAUTH_REDIRECT_MODE === "chromiumapp") {
    if (!globalThis.chrome?.identity?.getRedirectURL) {
      throw new Error('OAUTH_REDIRECT_MODE "chromiumapp" needs the "identity" permission in manifest.json');
    }
    return chrome.identity.getRedirectURL();          // https://<extension-id>.chromiumapp.org/
  }
  return `https://accounts.firefox.com/oauth/success/${OAUTH_CLIENT_ID}`;
}
