// Web Push client for Mozilla's push service (autopush), speaking the same
// WebSocket protocol Firefox uses (dom/push/PushServiceWebSocket). Gives this
// browser a push endpoint that Mozilla accounts can deliver to, so Send Tab
// and "collection changed" notifications arrive instantly instead of polled.
import * as webpush from "./webpush.js";
import { b64ToBytes, bytesToB64url, randomBytes, fromUtf8 } from "./crypto.js";

export const PUSH_SERVER = "wss://push.services.mozilla.com/";
const STORAGE_KEY = "push";
const PING_INTERVAL_MS = 5 * 60 * 1000;  // app-level ping; server also pings
const PONG_TIMEOUT_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const BACKOFF_STATUS = 4774;            // server says: don't reconnect automatically

const subtle = globalThis.crypto.subtle;

export async function loadPushState(storage = chrome.storage.local) {
  return (await storage.get(STORAGE_KEY))[STORAGE_KEY] || null;
}

/**
 * @param {object} opts
 * @param {(msg: object) => void} opts.onMessage  decrypted JSON payloads
 * @param {(sub: {endpoint, publicKey, authSecret}) => void} opts.onSubscription  new/changed endpoint
 * @param {(s: string) => void} [opts.onStatus]
 * @param {object} [opts.storage]  chrome.storage.local-compatible
 * @param {typeof WebSocket} [opts.WebSocketImpl]
 */
export class PushClient {
  constructor({ onMessage, onSubscription, onStatus = () => {}, storage = chrome.storage.local, WebSocketImpl = WebSocket, url = PUSH_SERVER }) {
    Object.assign(this, { onMessage, onSubscription, onStatus, storage, WebSocketImpl, url });
    this.ws = null;
    this.state = null;
    this.retries = 0;
    this.stopped = true;
    this.pending = null;      // pending register request
    this.timers = {};
  }

  get connected() { return this.ws?.readyState === 1 && this.helloDone; }

  async start() {
    this.stopped = false;
    if (this.ws && this.ws.readyState <= 1) return;
    this.state = (await loadPushState(this.storage)) || {};
    if (!this.state.keys) {
      const pair = await webpush.generateKeyPair();
      this.state.keys = {
        privateJwk: await subtle.exportKey("jwk", pair.privateKey),
        publicKey: bytesToB64url(await webpush.exportPublicRaw(pair.publicKey)),
        authSecret: bytesToB64url(randomBytes(16)),
      };
      await this.save();
    }
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    try { this.ws?.close(1000); } catch {}
    this.ws = null;
  }

  /** Forget the subscription entirely (sign-out). */
  async reset() {
    this.stop();
    await this.storage.remove(STORAGE_KEY);
    this.state = null;
  }

  async save() { await this.storage.set({ [STORAGE_KEY]: this.state }); }

  clearTimers() {
    for (const t of Object.values(this.timers)) clearTimeout(t);
    this.timers = {};
  }

  connect() {
    this.clearTimers();
    this.helloDone = false;
    this.onStatus("connecting");
    let ws;
    // No "push-notification" subprotocol: Firefox requests it, but the server
    // doesn't echo it back, and Chromium then fails the handshake (1006).
    try { ws = new this.WebSocketImpl(this.url); }
    catch (e) { this.onStatus("error: " + e.message); return this.scheduleReconnect(); }
    this.ws = ws;
    ws.onopen = () => {
      const hello = { messageType: "hello", use_webpush: true, broadcasts: {} };
      if (this.state.uaid && this.state.channelID) hello.uaid = this.state.uaid;
      this.send(hello);
      this.timers.hello = setTimeout(() => this.reconnect("hello timeout"), REQUEST_TIMEOUT_MS);
    };
    ws.onmessage = (ev) => this.handle(ev.data).catch((e) => console.error("push handle", e));
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.helloDone = false;
      this.clearTimers();
      this.onStatus(`closed (${ev.code})`);
      if (!this.stopped && ev.code !== BACKOFF_STATUS) this.scheduleReconnect();
    };
  }

  send(obj) { this.ws?.send(JSON.stringify(obj)); }

  reconnect(reason) {
    this.onStatus("reconnecting: " + reason);
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch {}
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(5000 * 2 ** this.retries, 5 * 60 * 1000);
    this.retries++;
    clearTimeout(this.timers.reconnect);
    this.timers.reconnect = setTimeout(() => this.connect(), delay);
  }

  armPing() {
    clearTimeout(this.timers.ping);
    clearTimeout(this.timers.pong);
    this.timers.ping = setTimeout(() => {
      this.send({});
      this.timers.pong = setTimeout(() => this.reconnect("ping timeout"), PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  async handle(raw) {
    const msg = JSON.parse(raw);
    this.armPing(); // any message counts as liveness
    const type = msg.messageType;
    if (!type || type === "ping") return;

    if (type === "hello") {
      clearTimeout(this.timers.hello);
      if (typeof msg.uaid !== "string" || !msg.uaid || msg.uaid.length > 128) return this.reconnect("bad hello");
      this.helloDone = true;
      this.retries = 0;
      if (msg.uaid !== this.state.uaid) {
        // New UAID: any old channel is gone on the server.
        this.state.uaid = msg.uaid;
        delete this.state.channelID;
        delete this.state.endpoint;
        await this.save();
      }
      this.onStatus("connected");
      if (!this.state.channelID) await this.register();
      else this.onSubscription?.(this.subscription());
      return;
    }

    if (type === "register") {
      if (!this.pending || msg.channelID !== this.pending.channelID) return;
      clearTimeout(this.timers.register);
      const { resolve, reject } = this.pending;
      this.pending = null;
      if (msg.status !== 200 || !msg.pushEndpoint) return reject(new Error(`register failed: ${msg.status}`));
      this.state.channelID = msg.channelID;
      this.state.endpoint = msg.pushEndpoint;
      await this.save();
      resolve();
      this.onSubscription?.(this.subscription());
      return;
    }

    if (type === "notification") {
      let code = 100;
      try {
        if (msg.channelID !== this.state.channelID) { code = 102; return; }
        if (!msg.data) { this.onMessage?.(null); return; }
        const enc = (msg.headers?.encoding || "").toLowerCase();
        if (enc && enc !== "aes128gcm") throw new Error(`unsupported push encoding ${enc}`);
        const priv = await subtle.importKey("jwk", this.state.keys.privateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
        const plain = await webpush.decrypt(
          b64ToBytes(msg.data), priv, b64ToBytes(this.state.keys.publicKey), b64ToBytes(this.state.keys.authSecret));
        const text = fromUtf8(plain);
        let payload;
        try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
        this.onMessage?.(payload);
      } catch (e) {
        console.warn("push decrypt failed", e);
        code = 101;
      } finally {
        this.send({ messageType: "ack", updates: [{ channelID: msg.channelID, version: msg.version, code }] });
      }
    }
  }

  register() {
    return new Promise((resolve, reject) => {
      const channelID = crypto.randomUUID();
      this.pending = { channelID, resolve, reject };
      this.send({ messageType: "register", channelID });
      this.timers.register = setTimeout(() => {
        this.pending = null;
        reject(new Error("register timeout"));
        this.reconnect("register timeout");
      }, REQUEST_TIMEOUT_MS);
    }).catch((e) => console.warn(e));
  }

  subscription() {
    if (!this.state?.endpoint) return null;
    return { endpoint: this.state.endpoint, publicKey: this.state.keys.publicKey, authSecret: this.state.keys.authSecret };
  }
}
