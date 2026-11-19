// Runs in a browser page. Vectors from Mozilla's onepw protocol doc and the Hawk README.
import * as C from "../lib/crypto.js";
import * as fxa from "../lib/fxa.js";
import { hawkHeader } from "../lib/hawk.js";
import { decryptPayload } from "../lib/sync.js";
import * as oauth from "../lib/oauth.js";
import * as webpush from "../lib/webpush.js";
import * as sendtab from "../lib/sendtab.js";

const out = document.getElementById("out");
const results = [];
function check(name, got, want) {
  const pass = got === want;
  results.push({ name, pass });
  const d = document.createElement("div");
  d.className = pass ? "pass" : "fail";
  d.textContent = `${pass ? "PASS" : "FAIL"} ${name}` + (pass ? "" : `\n   got:  ${got}\n   want: ${want}`);
  d.style.whiteSpace = "pre";
  out.append(d);
}
const h = (s) => s.replace(/\s+/g, "");

try {
  // ---- onepw vectors ----
  const email = C.fromUtf8(C.hexToBytes("616e6472c3a9406578616d706c652e6f7267"));
  const password = C.fromUtf8(C.hexToBytes("70c3a4737377c3b67264"));
  const qs = await fxa.stretchV1(email, password);
  check("quickStretchedPW", C.bytesToHex(qs), h("e4e8889bd8bd61ad 6de6b95c059d56e7 b50dacdaf62bd846 44af7e2add84345d"));
  check("authPW", C.bytesToHex(await fxa.deriveAuthPW(qs)), h("247b675ffb4c4631 0bc87e26d712153a be5e1c90ef00a478 4594f97ef54f2375"));
  const unwrapBKey = await fxa.deriveUnwrapBKey(qs);
  check("unwrapBkey", C.bytesToHex(unwrapBKey), h("de6a2648b78284fc b9ffa81ba9580330 9cfba7af583c01a8 a1a63e567234dd28"));

  const kft = await fxa.deriveTokenCreds(h("8081828384858687 88898a8b8c8d8e8f 9091929394959697 98999a9b9c9d9e9f"), "keyFetchToken", 96);
  check("keyFetchToken tokenID", kft.id, h("3d0a7c02a15a62a2 882f76e39b6494b5 00c022a8816e0486 25a495718998ba60"));
  check("keyFetchToken reqHMACkey", C.bytesToHex(kft.key), h("87b8937f61d38d0e 29cd2d5600b3f4da 0aa48ac41de36a0e fe84bb4a9872ceb7"));
  check("keyRequestKey", C.bytesToHex(kft.extra), h("14f338a9e8c6324d 9e102d4e6ee83b20 9796d5c74bb734a4 10e729e014a4a546"));

  const response = h(`ee5c58845c7c9412 b11bbd20920c2fdd d83c33c9cd2c2de2 d66b222613364636 fc7e59d854d599f1
    0e212801de3a47c3 4333f3b838ee3471 e0f285649c332bbb 4c17f42a0b319bbb a327d2b326ad23e9 37219b4de32e3ec7 b3e3f740522ad6ef`);
  const { kA, wrapKB } = await fxa.unbundleKeys(kft.extra, response);
  check("kA", C.bytesToHex(kA), h("2021222324252627 28292a2b2c2d2e2f 3031323334353637 38393a3b3c3d3e3f"));
  check("wrapkB", C.bytesToHex(wrapKB), h("7effe354abecbcb2 34a8dfc2d7644b4a d339b525589738f2 d27341bb8622ecd8"));
  const kB = C.xor(wrapKB, unwrapBKey);
  check("kB", C.bytesToHex(kB), h("a095c51c1c6e384e 8d5777d97e3c487a 4fc2128a00ab395a 73d57fedf41631f0"));

  // Tampered bundle must be rejected
  let rejected = false;
  try { await fxa.unbundleKeys(kft.extra, response.slice(0, -2) + "00"); } catch { rejected = true; }
  check("tampered key bundle rejected", rejected, true);

  const st = await fxa.sessionCreds(h("a0a1a2a3a4a5a6a7 a8a9aaabacadaeaf b0b1b2b3b4b5b6b7 b8b9babbbcbdbebf"));
  check("sessionToken tokenID", st.id, h("c0a29dcf46174973 da1378696e4c82ae 10f723cf4f4d9f75 e39f4ae3851595ab"));
  check("sessionToken reqHMACkey", C.bytesToHex(st.key), h("9d8f22998ee7f579 8b887042466b72d5 3e56ab0c094388bf 65831f702d2febc0"));

  // ---- Hawk README vectors ----
  const hawkCreds = { id: "dh37fgj492je", key: C.utf8("werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn") };
  const hdr = await hawkHeader(hawkCreds, "GET", "http://example.com:8000/resource/1?b=1&a=2",
    { ts: 1353832234, nonce: "j4h3g2", ext: "some-app-ext-data" });
  check("hawk GET mac", hdr.match(/mac="([^"]+)"/)[1], "6R4rV5iE+NPoym+WwjeHzjAGXUtLNIxmo1vpMofpLAE=");
  const hdr2 = await hawkHeader(hawkCreds, "POST", "http://example.com:8000/resource/1?b=1&a=2",
    { ts: 1353832234, nonce: "j4h3g2", ext: "some-app-ext-data", contentType: "text/plain", payload: "Thank you for flying Hawk" });
  check("hawk POST hash", hdr2.match(/hash="([^"]+)"/)[1], "Yi9LfIIFRtBEPt74PVmbTF/xVAwPn7ub15ePICfgnuY=");
  check("hawk POST mac", hdr2.match(/mac="([^"]+)"/)[1], "aSe1DERmZuRl3pI36/9BdZmnErTw3sNzOOAUlfeKjVw=");

  // ---- Sync key derivation + record round trip ----
  const { kSync, kid } = await fxa.deriveSyncKey(kB, 1510726317123);
  check("kSync length", kSync.length, 64);
  check("kid format", /^1510726317123-[A-Za-z0-9_-]{22}$/.test(kid), true);

  const encKey = C.randomBytes(32), hmacKey = C.randomBytes(32), iv = C.randomBytes(16);
  const record = { id: "abc", type: "bookmark", title: "Ünïcode ✓", bmkUri: "https://example.com/" };
  const ct = C.bytesToB64(await C.aesCbcEncrypt(encKey, iv, C.utf8(JSON.stringify(record))));
  const payload = JSON.stringify({ ciphertext: ct, IV: C.bytesToB64(iv), hmac: C.bytesToHex(await C.hmacSha256(hmacKey, C.utf8(ct))) });
  const back = await decryptPayload({ enc: encKey, hmac: hmacKey }, payload);
  check("sync record round trip", JSON.stringify(back), JSON.stringify(record));
  let badHmac = false;
  try { await decryptPayload({ enc: encKey, hmac: C.randomBytes(32) }, payload); } catch { badHmac = true; }
  check("sync record wrong HMAC key rejected", badHmac, true);

  // ---- RFC 7518 Appendix C: ECDH-ES Concat KDF ----
  const aliceEpk = { kty: "EC", crv: "P-256", x: "gI0GAILBdu7T53akrFmMyGcsF3n5dO7MmwNBHKW5SV0", y: "SLW_xSffzlPWrHEVI30DHM_4egVwt3NQqeUD7nMFpps" };
  const bobPriv = await crypto.subtle.importKey("jwk",
    { kty: "EC", crv: "P-256", x: "weNJy2HscCSM6AEDTDg04biOvhFhyyWvOHQfeF_PxMQ", y: "e8lnCO-AlStT-NJVX-crhB7QRYhiix03illJOVAOyck", d: "VEmDZpDXXK8p8N0Cndsxs924q6nS1RXFASRl6BfUqdw" },
    { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const z = await oauth.ecdhSharedSecret(bobPriv, aliceEpk);
  const rfcKey = await oauth.concatKdf(z, "A128GCM", C.utf8("Alice"), C.utf8("Bob"), 128);
  check("RFC 7518 ECDH-ES derived key", C.bytesToB64url(rfcKey), "VqqN6vgjbSBcIijNcacQGg");

  // ---- keys_jwe round trip: encrypt like the server does, decrypt with our code ----
  const fl = await oauth.beginFlow();
  const u = new URL(fl.url);
  const jwk = JSON.parse(C.fromUtf8(C.b64ToBytes(u.searchParams.get("keys_jwk"))));
  check("auth URL redirect_uri", u.searchParams.get("redirect_uri"), "https://accounts.firefox.com/oauth/success/a2270f727f45f648");
  check("auth URL code_challenge = S256(verifier)", u.searchParams.get("code_challenge"), C.bytesToB64url(await C.sha256(C.utf8(fl.verifier))));
  check("keys_jwk is a public P-256 JWK", jwk.kty === "EC" && jwk.crv === "P-256" && !!jwk.x && !!jwk.y && !jwk.d, true);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const ephPub = await crypto.subtle.exportKey("jwk", eph.publicKey);
  const peer = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const z2 = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, eph.privateKey, 256));
  const cek = await oauth.concatKdf(z2, "A256GCM", new Uint8Array(0), new Uint8Array(0), 256);
  const hdrB64 = C.bytesToB64url(C.utf8(JSON.stringify({ alg: "ECDH-ES", enc: "A256GCM", kid: "x", epk: { kty: "EC", crv: "P-256", x: ephPub.x, y: ephPub.y } })));
  const jiv = C.randomBytes(12);
  const plainKeys = JSON.stringify({ [oauth.SYNC_SCOPE]: { kty: "oct", scope: oauth.SYNC_SCOPE, k: C.bytesToB64url(C.randomBytes(64)), kid: "1510726317123-abc" } });
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: jiv, additionalData: C.utf8(hdrB64) }, aes, C.utf8(plainKeys)));
  const jwe = [hdrB64, "", C.bytesToB64url(jiv), C.bytesToB64url(sealed.slice(0, -16)), C.bytesToB64url(sealed.slice(-16))].join(".");
  check("keys_jwe round trip", await oauth.decryptJwe(jwe, fl.privateKey), plainKeys);
  let jweTamper = false;
  const jp = jwe.split(".");
  jp[3] = (jp[3][0] === "A" ? "B" : "A") + jp[3].slice(1);   // flip bits in the ciphertext
  try { await oauth.decryptJwe(jp.join("."), fl.privateKey); } catch { jweTamper = true; }
  check("tampered keys_jwe rejected", jweTamper, true);

  // ---- RFC 8291 §5 Web Push vector (aes128gcm) ----
  const wpMsg = C.b64ToBytes(
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vC" +
    "YLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXL" +
    "WyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
  const uaPub = C.b64ToBytes("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
  const wpAuth = C.b64ToBytes("BTBZMqHH6r4Tts7J_aSIgg");
  const ecJwk = (raw, d) => ({ kty: "EC", crv: "P-256", x: C.bytesToB64url(raw.slice(1, 33)), y: C.bytesToB64url(raw.slice(33, 65)), d });
  const uaPriv = await crypto.subtle.importKey("jwk", ecJwk(uaPub, "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const wpPlain = await webpush.decrypt(wpMsg, uaPriv, uaPub, wpAuth);
  check("RFC 8291 decrypt", C.fromUtf8(wpPlain), "When I grow up, I want to be a watermelon");
  const asPub = wpMsg.slice(21, 86);
  const asPriv = await crypto.subtle.importKey("jwk", ecJwk(asPub, "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const asPubKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, true, []);
  const reenc = await webpush.encrypt(wpPlain, uaPub, wpAuth, { senderKeys: { privateKey: asPriv, publicKey: asPubKey }, salt: wpMsg.slice(0, 16), rs: 4096 });
  check("RFC 8291 encrypt (byte-exact)", C.bytesToB64url(reenc), C.bytesToB64url(wpMsg));

  // ---- Send Tab: publish keys, encrypt tab to them, decrypt as receiver ----
  const stKeys = await sendtab.generateKeys();
  const kidT = "1411794099404-" + C.bytesToB64url(C.randomBytes(16));
  const cmdVal = await sendtab.encryptKeysForCommand(stKeys, kSync, kidT);
  const cmdObj = JSON.parse(cmdVal);
  check("send-tab command value shape", Object.keys(cmdObj).sort().join(","), "IV,ciphertext,hmac,kid");
  check("send-tab kid is hex fingerprint", /^[0-9a-f]{32}$/.test(cmdObj.kid), true);
  const pub = await sendtab.decryptKeysFromCommand(cmdVal, kSync, kidT);
  check("send-tab keys round trip", pub.publicKey === stKeys.publicKey && pub.authSecret === stKeys.authSecret, true);
  const payloadT = await sendtab.encryptTab(cmdVal, kSync, kidT, { title: "Tïtle ✓", url: "https://example.com/a?b=c" });
  const gotTab = await sendtab.decryptTab(stKeys, payloadT);
  check("send-tab tab round trip", `${gotTab.title}|${gotTab.url}`, "Tïtle ✓|https://example.com/a?b=c");
  let kidMismatch = false;
  try { await sendtab.decryptKeysFromCommand(cmdVal, kSync, "1-" + C.bytesToB64url(C.randomBytes(16))); } catch { kidMismatch = true; }
  check("send-tab rejects other-key device", kidMismatch, true);

  // ---- v2 stretch timing sanity ----
  const t0 = performance.now();
  const v2 = await fxa.stretchV2("identity.mozilla.com/picl/v1/quickStretchV2:0123456789abcdef0123456789abcdef", "pässwörd");
  check("v2 stretch length", v2.length, 32);
  const d = document.createElement("div"); d.textContent = `(v2 650k-iteration stretch took ${Math.round(performance.now() - t0)} ms)`; out.append(d);
} catch (e) {
  results.push({ name: "exception", pass: false });
  out.append(`EXCEPTION: ${e.stack || e}`);
}

const failed = results.filter((r) => !r.pass).length;
document.title = failed ? `FAIL ${failed}/${results.length}` : `PASS ${results.length}/${results.length}`;
window.__results = { passed: results.length - failed, failed, total: results.length };
