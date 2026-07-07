/* =====================================================================
 * AI Company OS — Analytics SDK (analytics.js) / C3
 * 根拠: Analytics_Platform/07_Implementation_Plan.md §5, §0, §7
 * 方針:
 *   - フレームワーク非依存の素のブラウザJS（IIFE / window.analytics）。React化に非依存。
 *   - 依存なし（fetch / navigator.sendBeacon / crypto.randomUUID / localStorage）。
 *   - 機密の直書きなし（X-Analytics-Key は init(config) から受け取る）。
 *   - C2 API と整合: POST {apiBase}/api/analytics/collect|identify（X-Analytics-Key ヘッダ）。
 * 実装判断（設計不変・07とC2の整合）:
 *   - sendBeacon はカスタムヘッダ不可のため、認証付き配信は fetch(keepalive) を主、
 *     sendBeacon は keepalive 非対応環境の最終フォールバック（無認証・best-effort）。
 * ===================================================================== */
(function () {
  "use strict";

  // ---- 定数（マジックナンバー禁止） ----
  var SDK_VERSION = "1.0.0";
  var DEFAULT_EVENT_VERSION = 1;
  var FLUSH_INTERVAL_MS = 5000;      // 07 §5: 5秒
  var FLUSH_BATCH_SIZE = 20;         // 07 §5: 20件
  var MAX_BATCH_EVENTS = 200;        // C2 §4: 最大200件/req
  var SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 07 §5: 非活動30分
  var RETRY_BASE_MS = 1000;
  var RETRY_MAX_MS = 60000;
  var MAX_BUFFER_EVENTS = 500;       // offline buffer 上限（localStorage肥大防止）
  var HEADER_INGEST_KEY = "X-Analytics-Key";

  var STORAGE = {
    anon: "aco_analytics_anonymous_id",
    actor: "aco_analytics_actor_id",
    buffer: "aco_analytics_buffer",
    session: "aco_analytics_session"
  };

  // Envelope の予約フィールド（props からこれらは top-level へ、残りは properties へ）
  var RESERVED_FIELDS = [
    "domain", "actor_type", "event_version",
    "screen", "feature", "entity_type", "entity_id",
    "result", "error_type", "duration_ms"
  ];

  // ---- 内部状態 ----
  var config = null;         // {apiBase, app, environment, key, appVersion, domain?, analyticsEnabled}
  var anonymousId = null;
  var actorId = null;
  var session = null;        // {id, startedAt, lastActivity}
  var queue = [];
  var flushTimer = null;
  var retryAttempt = 0;
  var nextRetryAt = 0;
  var started = false;

  // ---- ユーティリティ ----
  function uuid() {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
    } catch (e) { /* fallback below */ }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function nowIso() { return new Date().toISOString(); }
  function isEnabled() { return !!(config && config.analyticsEnabled); }

  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* storage full/blocked */ }
  }

  function loadOrCreateAnonymousId() {
    var id = lsGet(STORAGE.anon);
    if (!id) { id = uuid(); lsSet(STORAGE.anon, id); }
    return id;
  }

  // ---- セッション管理（07 §5: 非活動30分 or 日跨ぎで新セッション） ----
  function persistSession() {
    if (session) lsSet(STORAGE.session, JSON.stringify(session));
  }
  function loadSession() {
    try {
      var raw = lsGet(STORAGE.session);
      if (raw) session = JSON.parse(raw);
    } catch (e) { session = null; }
  }
  function dayChanged(startedAt, now) {
    return new Date(startedAt).toDateString() !== new Date(now).toDateString();
  }
  function startSession() {
    if (session) { endSession(); }
    session = { id: uuid(), startedAt: Date.now(), lastActivity: Date.now() };
    persistSession();
    enqueue("session_started", {});
  }
  function endSession() {
    if (!session) return;
    var durationS = Math.round((Date.now() - session.startedAt) / 1000);
    enqueue("session_ended", { duration_s: durationS });
    session = null;
    try { window.localStorage.removeItem(STORAGE.session); } catch (e) { /* ignore */ }
  }
  function currentSessionId() {
    var now = Date.now();
    if (!session || (now - session.lastActivity) > SESSION_TIMEOUT_MS || dayChanged(session.startedAt, now)) {
      startSession();
    }
    session.lastActivity = now;
    persistSession();
    return session.id;
  }

  // ---- Envelope 構築（07 §10） ----
  function buildEnvelope(eventName, props) {
    props = props || {};
    var reserved = {};
    var properties = {};
    Object.keys(props).forEach(function (k) {
      if (RESERVED_FIELDS.indexOf(k) >= 0) { reserved[k] = props[k]; }
      else { properties[k] = props[k]; }
    });

    var ev = {
      event_id: uuid(),
      event_name: eventName,
      event_version: reserved.event_version != null ? reserved.event_version : DEFAULT_EVENT_VERSION,
      occurred_at: nowIso(),
      app: config.app,
      domain: reserved.domain != null ? reserved.domain : config.domain,
      environment: config.environment,
      actor_id: actorId || anonymousId,
      actor_type: reserved.actor_type != null ? reserved.actor_type : "human",
      session_id: currentSessionId(),
      app_version: config.appVersion,
      properties: properties,
      context: { ua: navigator.userAgent, lang: navigator.language }
    };
    // 条件付き Envelope 列（存在時のみ付与）
    ["screen", "feature", "entity_type", "entity_id", "result", "error_type", "duration_ms"].forEach(function (k) {
      if (reserved[k] != null) ev[k] = reserved[k];
    });
    return ev;
  }

  // enqueue: セッション再帰を避けるため session_started/ended もここを通す
  function enqueue(eventName, props) {
    var ev = buildEnvelope(eventName, props);
    queue.push(ev);
    if (queue.length >= FLUSH_BATCH_SIZE) { flush({ unload: false }); }
  }

  // ---- offline buffer ----
  function bufferLoad() {
    try {
      var raw = lsGet(STORAGE.buffer);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function bufferSave(events) {
    var trimmed = events.slice(-MAX_BUFFER_EVENTS);
    lsSet(STORAGE.buffer, JSON.stringify(trimmed));
  }
  function bufferAdd(events) {
    bufferSave(bufferLoad().concat(events));
  }

  // ---- 送信（07 §5） ----
  function makeBody(events) {
    return JSON.stringify({ sentAt: nowIso(), environment: config.environment, events: events });
  }

  // 認証付き通常送信（fetch）
  function sendFetch(events, keepalive) {
    var headers = { "content-type": "application/json" };
    headers[HEADER_INGEST_KEY] = config.key;
    return fetch(config.apiBase + "/api/analytics/collect", {
      method: "POST",
      headers: headers,
      body: makeBody(events),
      keepalive: !!keepalive
    }).then(function (res) { return res.ok; }).catch(function () { return false; });
  }

  // 離脱時フォールバック（keepalive非対応時のみ）。sendBeaconはヘッダ付与不可のため無認証・best-effort。
  function sendBeaconFallback(events) {
    try {
      if (navigator && typeof navigator.sendBeacon === "function") {
        var blob = new Blob([makeBody(events)], { type: "application/json" });
        return navigator.sendBeacon(config.apiBase + "/api/analytics/collect", blob);
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function supportsKeepalive() {
    try { return typeof Request !== "undefined" && "keepalive" in Request.prototype; }
    catch (e) { return false; }
  }

  // flush: queue を送信。失敗は offline buffer へ退避して retry。
  function flush(opts) {
    opts = opts || {};
    if (!isEnabled()) return Promise.resolve();
    if (queue.length === 0) { return drainBuffer(); }

    var batch = queue.splice(0, MAX_BATCH_EVENTS);

    if (opts.unload) {
      // 離脱時: keepalive 付き fetch を優先、非対応なら sendBeacon（無認証）
      if (supportsKeepalive()) {
        return sendFetch(batch, true).then(function (ok) { if (!ok) bufferAdd(batch); });
      }
      sendBeaconFallback(batch); // best-effort（失敗しても next-load で offline buffer から再送されない点に注意）
      return Promise.resolve();
    }

    return sendFetch(batch, false).then(function (ok) {
      if (ok) { retryAttempt = 0; nextRetryAt = 0; return drainBuffer(); }
      bufferAdd(batch);
    });
  }

  // offline buffer を排出（online かつ backoff 経過時）
  function drainBuffer() {
    if (!isEnabled()) return Promise.resolve();
    var buffered = bufferLoad();
    if (buffered.length === 0) return Promise.resolve();
    if (typeof navigator !== "undefined" && navigator.onLine === false) return Promise.resolve();
    if (Date.now() < nextRetryAt) return Promise.resolve();

    var batch = buffered.slice(0, MAX_BATCH_EVENTS);
    return sendFetch(batch, false).then(function (ok) {
      if (ok) {
        var rest = buffered.slice(batch.length);
        bufferSave(rest);
        retryAttempt = 0; nextRetryAt = 0;
      } else {
        retryAttempt = retryAttempt + 1;
        nextRetryAt = Date.now() + Math.min(RETRY_BASE_MS * Math.pow(2, retryAttempt), RETRY_MAX_MS);
      }
    });
  }

  // ---- 公開 API（07 §5） ----
  function init(userConfig) {
    userConfig = userConfig || {};
    config = {
      apiBase: userConfig.apiBase || "",
      app: userConfig.app || "portal",
      environment: userConfig.environment,
      key: userConfig.key || "",
      appVersion: userConfig.appVersion || null,
      domain: userConfig.domain || null, // Envelope必須domainの既定（track props で上書き可）
      analyticsEnabled: userConfig.analyticsEnabled !== false // 既定 true（07 §7 flag）
    };
    anonymousId = loadOrCreateAnonymousId();
    actorId = lsGet(STORAGE.actor) || null;

    if (!isEnabled()) return; // 無効時は何もしない（ロールバック可）

    loadSession();
    if (started) return;
    started = true;

    // 離脱・可視性・オンライン復帰
    window.addEventListener("pagehide", function () { endSession(); flush({ unload: true }); });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") { flush({ unload: true }); }
    });
    window.addEventListener("online", function () { drainBuffer(); });

    // 定期 flush
    flushTimer = window.setInterval(function () { flush({ unload: false }); }, FLUSH_INTERVAL_MS);

    // 初回セッション開始＋offline残の排出
    startSession();
    drainBuffer();
  }

  function identify(arg) {
    if (!isEnabled()) return Promise.resolve(null);
    var personToken = arg && arg.personToken;
    if (!personToken) return Promise.resolve(null);
    var headers = { "content-type": "application/json" };
    headers[HEADER_INGEST_KEY] = config.key;
    return fetch(config.apiBase + "/api/analytics/identify", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ personToken: personToken })
    }).then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).then(function (data) {
      if (data && data.actor_id) {
        actorId = data.actor_id;       // anonymous → actor に stitch
        lsSet(STORAGE.actor, actorId);
        return actorId;
      }
      return null;
    }).catch(function () { return null; });
  }

  function track(eventName, props) {
    if (!isEnabled()) return;
    if (!eventName) return;
    enqueue(eventName, props);
  }

  window.analytics = {
    VERSION: SDK_VERSION,
    init: init,
    identify: identify,
    track: track,
    startSession: startSession,
    endSession: endSession,
    flush: function () { return flush({ unload: false }); }
  };
})();
