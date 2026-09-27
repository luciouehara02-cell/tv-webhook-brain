"use strict";

/*
  BrainFVVO_SOL_v3b_RAY30_PULLBACK_LONGHOLD_DEMO
  ------------------------------------------------
  SOLUSDT DEMO brain.

  Entry design:
    - 30m RayAlgo gate = higher-timeframe permission.
    - 5m FVVO = pullback/recovery context.
    - 15s FVVO Feature Tick = easy execution trigger.
    - Campaign/manual entry controls included.

  Exit design:
    - Persisted long-hold state.
    - -0.80% hard stop.
    - -1.00% sudden-drop emergency exit from recent 60s high.
    - Permanent profit floors: +1 -> 0, +2 -> +0.5, +3 -> +1, +4 -> +2.
    - Runner after +5 with min lock and peak giveback.
    - 30m/5m thesis exit hook, intentionally slower than 15s noise.

  Safety:
    - DEMO by default. LIVE_FORWARD_ALLOWED defaults false.
    - No secrets hardcoded.
    - Do not redeploy/restart with an open real deal unless persistent state is intact.
*/

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "2mb" }));

function envStr(name, def = "") {
  const value = process.env[name];
  return value === undefined || value === null || String(value).trim() === "" ? def : String(value).trim();
}
function envNum(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}
function envBool(name, def = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return def;
  return /^(1|true|yes|y|on)$/i.test(String(raw).trim());
}
function nowMs() { return Date.now(); }
function iso(t = nowMs()) { return new Date(t).toISOString(); }
function finite(value, def = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : def;
}
function round(value, digits = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
function pct(from, to) {
  const a = Number(from), b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return 0;
  return ((b - a) / a) * 100;
}
function priceFromPct(entry, pctValue) {
  const e = Number(entry), p = Number(pctValue);
  if (!Number.isFinite(e) || e <= 0 || !Number.isFinite(p)) return null;
  return e * (1 + p / 100);
}
function normalizeSymbol(symbol) {
  const s = String(symbol || "").trim().toUpperCase();
  if (!s) return "";
  if (s.includes(":")) return s;
  if (/^[A-Z0-9]+USDT$/.test(s)) return `BINANCE:${s}`;
  return s;
}
function instrumentFromSymbol(symbol) {
  return String(symbol || "").split(":").pop().replace(/[^A-Z0-9]/gi, "").toUpperCase();
}
function cleanWord(value, def = "") {
  return String(value || def || "").trim().toUpperCase().replace(/[^A-Z0-9_\-:.]/g, "");
}
function uuid(prefix = "id") { return `${prefix}_${crypto.randomUUID()}`; }
function c3NumberString(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return "";
  return String(Number(n.toFixed(8)));
}
function redact(value) {
  const s = String(value || "");
  if (!s) return null;
  if (s.length <= 12) return "***";
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

const CFG = {
  BRAIN_NAME: envStr("BRAIN_NAME", "BrainFVVO_SOL_v3b_RAY30_PULLBACK_LONGHOLD_DEMO"),
  PORT: envNum("PORT", 8080),
  SYMBOL: normalizeSymbol(envStr("SYMBOL", "BINANCE:SOLUSDT")),
  WEBHOOK_PATH: envStr("WEBHOOK_PATH", "/webhook"),
  MANUAL_WEBHOOK_PATH: envStr("MANUAL_WEBHOOK_PATH", "/manual"),
  WEBHOOK_SECRET: envStr("WEBHOOK_SECRET", ""),
  MANUAL_WEBHOOK_SECRET: envStr("MANUAL_WEBHOOK_SECRET", ""),

  STATE_FILE: envStr("STATE_FILE", "/data/brainfvvo-sol-ray30-longhold-v3b-state.json"),
  EXECUTION_MODE: envStr("EXECUTION_MODE", "demo").toLowerCase(),
  ENABLE_HTTP_FORWARD: envBool("ENABLE_HTTP_FORWARD", true),
  DEMO_FORWARD_ALLOWED: envBool("DEMO_FORWARD_ALLOWED", true),
  LIVE_FORWARD_ALLOWED: envBool("LIVE_FORWARD_ALLOWED", false),
  C3_DRY_RUN: envBool("C3_DRY_RUN", false),
  SHADOW_ONLY: envBool("SHADOW_ONLY", false),
  EMERGENCY_DISABLE_ALL_FORWARDS: envBool("FVVO_EMERGENCY_DISABLE_ALL_FORWARDS", false),
  EMERGENCY_DISABLE_NEW_ENTRIES: envBool("FVVO_EMERGENCY_DISABLE_NEW_ENTRIES", false),
  MAX_TRADES_PER_DAY: envNum("FVVO_MAX_TRADES_PER_DAY", 20),

  C3_SIGNAL_URL: envStr("C3_SIGNAL_URL", "https://api.3commas.io/signal_bots/webhooks"),
  C3_ENTER_LONG_CODE: envStr("C3_ENTER_LONG_CODE", ""),
  C3_EXIT_LONG_CODE: envStr("C3_EXIT_LONG_CODE", ""),
  C3_AMOUNT_PER_TRADE: envStr("C3_AMOUNT_PER_TRADE", "0.10"),
  C3_AMOUNT_PER_TRADE_TYPE: envStr("C3_AMOUNT_PER_TRADE_TYPE", "percents"),
  C3_ORDER_TYPE: envStr("C3_ORDER_TYPE", "market"),
  C3_TIMEOUT_MS: envNum("C3_TIMEOUT_MS", 8000),

  RAY30_ENABLED: envBool("RAY30_ENABLED", true),
  RAY30_MAX_AGE_SEC: envNum("RAY30_MAX_AGE_SEC", 2700),
  RAY30_STALE_FALLBACK: cleanWord(envStr("RAY30_STALE_FALLBACK", "NEUTRAL")),
  RAY30_LONG_GATE_MODE: cleanWord(envStr("RAY30_LONG_GATE_MODE", "EASY_TEST")),

  ENTRY_5M_PULLBACK_ENABLED: envBool("RAY30_5M_PULLBACK_RECOVERY_ENABLED", true),
  ENTRY_15S_BREAKOUT_ENABLED: envBool("RAY30_15S_RECOVERY_BREAKOUT_ENABLED", true),
  ENTRY_TREND_CONTINUATION_ENABLED: envBool("RAY30_TREND_CONTINUATION_ENABLED", true),
  ENTRY_TREND_CONTINUATION_SHADOW_ONLY: envBool("RAY30_TREND_CONTINUATION_SHADOW_ONLY", true),

  PULLBACK_5M_MIN_RSI: envNum("RAY30_PULLBACK_5M_MIN_RSI", 38),
  PULLBACK_5M_MAX_RSI: envNum("RAY30_PULLBACK_5M_MAX_RSI", 58),
  PULLBACK_MIN_FVVO: envNum("RAY30_PULLBACK_MIN_FVVO", -1.5),
  PULLBACK_MAX_BELOW_EMA18_PCT: envNum("RAY30_PULLBACK_MAX_BELOW_EMA18_PCT", 0.5),
  PULLBACK_REQUIRE_SLOPE_IMPROVING: envBool("RAY30_PULLBACK_REQUIRE_SLOPE_IMPROVING", true),

  TICK_MIN_RSI: envNum("RAY30_15S_MIN_RSI", 50),
  TICK_MIN_FVVO: envNum("RAY30_15S_MIN_FVVO", -0.2),
  TICK_MIN_SLOPE: envNum("RAY30_15S_MIN_SLOPE", 0.05),
  TICK_BREAKOUT_MARGIN_PCT: envNum("RAY30_15S_BREAKOUT_MARGIN_PCT", 0.03),
  TICK_MAX_EXT_EMA8_PCT: envNum("RAY30_15S_MAX_EXT_EMA8_PCT", 0.35),
  TICK_BREAKOUT_LOOKBACK_SEC: envNum("RAY30_15S_BREAKOUT_LOOKBACK_SEC", 60),
  FEATURE_5M_MAX_AGE_SEC: envNum("FEATURE_5M_MAX_AGE_SEC", 420),
  FEATURE_TICK_MAX_AGE_SEC: envNum("FEATURE_TICK_MAX_AGE_SEC", 60),

  EXIT_STACK_ENABLED: envBool("RAY30_EXIT_STACK_ENABLED", true),
  STOP_LOSS_PCT: envNum("RAY30_STOP_LOSS_PCT", 0.8),
  EMERGENCY_DROP_ENABLED: envBool("RAY30_EMERGENCY_DROP_ENABLED", true),
  EMERGENCY_DROP_MODE: cleanWord(envStr("RAY30_EMERGENCY_DROP_MODE", "FROM_60S_HIGH")),
  EMERGENCY_DROP_WINDOW_SEC: envNum("RAY30_EMERGENCY_DROP_WINDOW_SEC", 60),
  EMERGENCY_DROP_PCT: envNum("RAY30_EMERGENCY_DROP_PCT", 1.0),
  EMERGENCY_DROP_CONFIRM_TICKS: envNum("RAY30_EMERGENCY_DROP_CONFIRM_TICKS", 1),
  PERMANENT_FLOORS_ENABLED: envBool("RAY30_PERMANENT_FLOORS_ENABLED", true),
  FLOOR_1_MFE_PCT: envNum("RAY30_FLOOR_1_MFE_PCT", 1.0),
  FLOOR_1_LOCK_PCT: envNum("RAY30_FLOOR_1_LOCK_PCT", 0.0),
  FLOOR_2_MFE_PCT: envNum("RAY30_FLOOR_2_MFE_PCT", 2.0),
  FLOOR_2_LOCK_PCT: envNum("RAY30_FLOOR_2_LOCK_PCT", 0.5),
  FLOOR_3_MFE_PCT: envNum("RAY30_FLOOR_3_MFE_PCT", 3.0),
  FLOOR_3_LOCK_PCT: envNum("RAY30_FLOOR_3_LOCK_PCT", 1.0),
  FLOOR_4_MFE_PCT: envNum("RAY30_FLOOR_4_MFE_PCT", 4.0),
  FLOOR_4_LOCK_PCT: envNum("RAY30_FLOOR_4_LOCK_PCT", 2.0),
  RUNNER_ENABLED: envBool("RAY30_RUNNER_ENABLED", true),
  RUNNER_ACTIVATE_MFE_PCT: envNum("RAY30_RUNNER_ACTIVATE_MFE_PCT", 5.0),
  RUNNER_MIN_LOCK_PCT: envNum("RAY30_RUNNER_MIN_LOCK_PCT", 3.0),
  RUNNER_GIVEBACK_PCT: envNum("RAY30_RUNNER_GIVEBACK_PCT", 1.5),
  THESIS_EXIT_ENABLED: envBool("RAY30_THESIS_EXIT_ENABLED", true),
  THESIS_EXIT_REQUIRE_5M_CONFIRM: envBool("RAY30_THESIS_EXIT_REQUIRE_5M_CONFIRM", true),
  THESIS_EXIT_5M_CONFIRM_BARS: envNum("RAY30_THESIS_EXIT_5M_CONFIRM_BARS", 2),

  MANUAL_CONTROL_ENABLED: envBool("MANUAL_CONTROL_ENABLED", true),
  MANUAL_ENTRY_DEFAULT_PROFILE: cleanWord(envStr("MANUAL_ENTRY_DEFAULT_PROFILE", "RAY30_15S_RECOVERY_BREAKOUT")),
  MANUAL_REQUIRE_FRESH_FEATURE_TICK: envBool("MANUAL_REQUIRE_FRESH_FEATURE_TICK", true),
  CAMPAIGN_MAX_ACTIVE: envNum("CAMPAIGN_MAX_ACTIVE", 12),
  CAMPAIGN_DEFAULT_EXPIRE_SEC: envNum("CAMPAIGN_DEFAULT_EXPIRE_SEC", 14400),
  CAMPAIGN_BREAKOUT_RECLAIM_BUFFER_PCT: envNum("CAMPAIGN_BREAKOUT_RECLAIM_BUFFER_PCT", 0.00),
  CAMPAIGN_POST_EXPIRY_SHADOW_SEC: envNum("CAMPAIGN_POST_EXPIRY_SHADOW_SEC", 7200),
  MANUAL_ALLOW_AUTO_LATEST_PRICE: envBool("MANUAL_ALLOW_AUTO_LATEST_PRICE", true),
};

function log(level, event, fields = {}) {
  const payload = { ts: iso(), level, brain: CFG.BRAIN_NAME, event, ...fields };
  const line = `${payload.ts} | ${level} | ${CFG.BRAIN_NAME} | ${event} | ${Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" | ")}`;
  console.log(line);
}

const emptyState = () => ({
  version: "v3b",
  symbol: CFG.SYMBOL,
  startedAt: iso(),
  ray30: null,
  feature5m: null,
  previous5m: null,
  ticks: [],
  position: null,
  campaigns: [],
  daily: { date: new Date().toISOString().slice(0, 10), trades: 0 },
  pending: { manual: null },
  audit: { lastEntryReject: null, lastExit: null },
});

let state = emptyState();

function ensureStateDir() {
  const dir = path.dirname(CFG.STATE_FILE);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}
function loadState() {
  try {
    if (fs.existsSync(CFG.STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CFG.STATE_FILE, "utf8"));
      state = { ...emptyState(), ...parsed };
      state.symbol = CFG.SYMBOL;
      if (!Array.isArray(state.ticks)) state.ticks = [];
      if (!Array.isArray(state.campaigns)) state.campaigns = [];
      log("INFO", "STATE_LOADED", { stateFile: CFG.STATE_FILE, hasPosition: Boolean(state.position), campaigns: state.campaigns.length });
    } else {
      ensureStateDir();
      persistState("initial_create");
      log("INFO", "STATE_CREATED", { stateFile: CFG.STATE_FILE });
    }
  } catch (error) {
    log("ERROR", "STATE_LOAD_FAILED_STARTING_EMPTY", { stateFile: CFG.STATE_FILE, error: error.message });
    state = emptyState();
  }
}
function persistState(reason = "update") {
  try {
    ensureStateDir();
    fs.writeFileSync(CFG.STATE_FILE, JSON.stringify({ ...state, updatedAt: iso(), updateReason: reason }, null, 2));
    return true;
  } catch (error) {
    log("ERROR", "STATE_PERSIST_FAILED", { reason, error: error.message });
    return false;
  }
}

function allowedManualActions() {
  return [
    "status",
    "enter_long",
    "adopt_long",
    "exit_long",
    "cancel",
    "arm_price_entry",
    "arm_campaign_entry",
    "cancel_price_entry",
    "cancel_campaign",
    "handoff_manual",
    "clear_handoff",
    "force_clear_verified_flat",
  ];
}
function latestFeaturePricePayload() {
  const t = state.ticks && state.ticks.length ? state.ticks[state.ticks.length - 1] : null;
  return {
    latestFeaturePrice: Number.isFinite(t?.price) ? t.price : null,
    latestFeatureAgeSec: Number.isFinite(t?.atMs) ? round((nowMs() - t.atMs) / 1000, 3) : null,
  };
}

function requireSecret(body, manual = false) {
  const expected = manual ? CFG.MANUAL_WEBHOOK_SECRET : CFG.WEBHOOK_SECRET;
  if (!expected) return true;
  const got = String(body?.secret || body?.webhookSecret || "");
  return got === expected;
}
function symbolOk(body) {
  const s = normalizeSymbol(body?.symbol || CFG.SYMBOL);
  return !s || s === CFG.SYMBOL;
}
function eventTimeMs(body) {
  const candidates = [body.time, body.timestamp, body.barTime, body.timenow, body.createdAt, body.closeTime];
  for (const c of candidates) {
    if (c === undefined || c === null || c === "") continue;
    const n = Number(c);
    if (Number.isFinite(n)) return n > 10_000_000_000 ? n : n * 1000;
    const d = Date.parse(String(c));
    if (Number.isFinite(d)) return d;
  }
  return nowMs();
}
function bodyPrice(body) {
  return finite(body.price ?? body.close ?? body.c ?? body.markPrice ?? body.last, null);
}
function normalizeRayTrend(v) {
  const s = cleanWord(v, "NEUTRAL");
  if (["BULL", "BULLISH", "BUY", "LONG"].includes(s)) return "BULL";
  if (["BEAR", "BEARISH", "SELL", "SHORT"].includes(s)) return "BEAR";
  if (["RECOVERY", "REVERSAL", "NEUTRAL", "NONE", "FLAT"].includes(s)) return s === "RECOVERY" || s === "REVERSAL" ? "RECOVERY" : "NEUTRAL";
  return s || "NEUTRAL";
}
function normalizeStrength(v) {
  const s = cleanWord(v, "UNKNOWN");
  if (["STRONG", "HIGH", "HARD"].includes(s)) return "STRONG";
  if (["WEAK", "LOW", "SOFT"].includes(s)) return "WEAK";
  if (["MEDIUM", "MID", "NORMAL"].includes(s)) return "MEDIUM";
  return s || "UNKNOWN";
}
function normalizeFeature(body, kind) {
  const price = bodyPrice(body);
  const ts = eventTimeMs(body);
  return {
    kind,
    symbol: normalizeSymbol(body.symbol || CFG.SYMBOL),
    atMs: ts,
    at: iso(ts),
    price,
    close: finite(body.close ?? body.c ?? price, price),
    open: finite(body.open ?? body.o, null),
    high: finite(body.high ?? body.h, null),
    low: finite(body.low ?? body.l, null),
    ema8: finite(body.ema8 ?? body.EMA8 ?? body.emaFast, null),
    ema18: finite(body.ema18 ?? body.EMA18 ?? body.emaSlow, null),
    rsi: finite(body.rsi ?? body.RSI, null),
    adx: finite(body.adx ?? body.ADX, null),
    fvvo: finite(body.fvvo ?? body.FVVO ?? body.fvvoValue, null),
    slope: finite(body.slope ?? body.fvvoSlope ?? body.FVVO_SLOPE, null),
    crossUp: Boolean(body.crossUp || body.fvvoCrossUp || body.cross_up),
    rayTrend: normalizeRayTrend(body.rayTrend ?? body.rayRegime ?? body.ray ?? body.trend),
    raySignal: cleanWord(body.raySignal ?? body.signal ?? ""),
    rayStrength: normalizeStrength(body.rayStrength ?? body.strength ?? ""),
    rayBull: Boolean(body.rayBull || body.tickRayBull || normalizeRayTrend(body.rayTrend ?? body.rayRegime) === "BULL"),
    rayBear: Boolean(body.rayBear || body.tickRayBear || normalizeRayTrend(body.rayTrend ?? body.rayRegime) === "BEAR"),
    raw: body,
  };
}

function updateDaily() {
  const d = new Date().toISOString().slice(0, 10);
  if (!state.daily || state.daily.date !== d) state.daily = { date: d, trades: 0 };
}
function positionOpen() { return Boolean(state.position && state.position.open); }
function canForward(action) {
  if (CFG.SHADOW_ONLY || CFG.EMERGENCY_DISABLE_ALL_FORWARDS) return { ok: false, reason: "FORWARD_DISABLED_GLOBAL" };
  if (!CFG.ENABLE_HTTP_FORWARD) return { ok: false, reason: "HTTP_FORWARD_DISABLED" };
  if (CFG.EXECUTION_MODE === "live" && !CFG.LIVE_FORWARD_ALLOWED) return { ok: false, reason: "LIVE_FORWARD_NOT_ALLOWED" };
  if (CFG.EXECUTION_MODE !== "live" && !CFG.DEMO_FORWARD_ALLOWED) return { ok: false, reason: "DEMO_FORWARD_NOT_ALLOWED" };
  if (action === "enter_long" && CFG.EMERGENCY_DISABLE_NEW_ENTRIES) return { ok: false, reason: "NEW_ENTRIES_DISABLED" };
  return { ok: true };
}
function validateC3Code(code, action) {
  const value = String(code || "").trim().toUpperCase();
  const instrument = instrumentFromSymbol(CFG.SYMBOL);
  if (!value) return { ok: false, reason: "C3_CODE_EMPTY" };
  if (instrument && !value.includes(`_${instrument}_`)) return { ok: false, reason: "C3_CODE_WRONG_SYMBOL", instrument };
  if (action === "enter_long" && !value.startsWith("ENTER-LONG_")) return { ok: false, reason: "C3_ENTER_CODE_INVALID" };
  if (action === "exit_long" && !(value.startsWith("EXIT-LONG_") || value.startsWith("EXIT-ALL_"))) return { ok: false, reason: "C3_EXIT_CODE_INVALID" };
  return { ok: true };
}
function buildC3Payload(action) {
  if (action === "enter_long") {
    const valid = validateC3Code(CFG.C3_ENTER_LONG_CODE, action);
    if (!valid.ok) throw new Error(valid.reason);
    return { code: CFG.C3_ENTER_LONG_CODE, amountPerTrade: CFG.C3_AMOUNT_PER_TRADE, amountPerTradeType: CFG.C3_AMOUNT_PER_TRADE_TYPE, orderType: CFG.C3_ORDER_TYPE };
  }
  if (action === "exit_long") {
    const valid = validateC3Code(CFG.C3_EXIT_LONG_CODE, action);
    if (!valid.ok) throw new Error(valid.reason);
    return { code: CFG.C3_EXIT_LONG_CODE };
  }
  throw new Error("UNSUPPORTED_C3_ACTION");
}
async function forward3Commas(action, price, reason, meta = {}) {
  const requestId = meta.requestId || uuid(action);
  const gate = canForward(action);
  if (!gate.ok) {
    log("WARN", "C3_FORWARD_BLOCKED", { action, reason, blockReason: gate.reason, price, requestId });
    return { ok: false, blocked: true, reason: gate.reason, requestId };
  }
  let payload;
  try { payload = buildC3Payload(action); }
  catch (error) {
    log("ERROR", "C3_PAYLOAD_BUILD_FAILED", { action, reason, error: error.message, requestId });
    return { ok: false, error: error.message, requestId };
  }
  log("INFO", "C3_FORWARD_SEND", { action, reason, symbol: CFG.SYMBOL, price: round(price, 8), requestId, dryRun: CFG.C3_DRY_RUN, code: redact(payload.code), meta });
  if (CFG.C3_DRY_RUN) return { ok: true, dryRun: true, status: 0, requestId };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), CFG.C3_TIMEOUT_MS);
  try {
    const response = await fetch(CFG.C3_SIGNAL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    clearTimeout(t);
    if (!response.ok) {
      log("ERROR", "C3_FORWARD_REJECTED", { action, reason, status: response.status, requestId, responseText: text.slice(0, 500) });
      return { ok: false, status: response.status, responseText: text, requestId };
    }
    log("INFO", "C3_FORWARD_ACCEPTED_UNVERIFIED", { action, reason, status: response.status, requestId, responseText: text.slice(0, 300) });
    return { ok: true, status: response.status, responseText: text, requestId };
  } catch (error) {
    clearTimeout(t);
    log("ERROR", "C3_FORWARD_FAILED", { action, reason, requestId, error: error.message });
    return { ok: false, error: error.message, requestId };
  }
}

function ray30Context(current = nowMs()) {
  const r = state.ray30;
  if (!r) return { fresh: false, stale: true, trend: CFG.RAY30_STALE_FALLBACK, strength: "UNKNOWN", ageSec: null, source: "missing" };
  const ageSec = (current - r.atMs) / 1000;
  const fresh = ageSec <= CFG.RAY30_MAX_AGE_SEC;
  return { fresh, stale: !fresh, trend: fresh ? r.trend : CFG.RAY30_STALE_FALLBACK, signal: r.signal, strength: fresh ? r.strength : "UNKNOWN", ageSec: round(ageSec, 3), source: fresh ? "ray30" : "stale_fallback", raw: r };
}
function ray30AllowsLong(current = nowMs()) {
  if (!CFG.RAY30_ENABLED) return { ok: true, mode: "DISABLED", reason: "RAY30_DISABLED" };
  const ctx = ray30Context(current);
  const mode = CFG.RAY30_LONG_GATE_MODE;
  if (!ctx.fresh && CFG.RAY30_STALE_FALLBACK === "BLOCK") return { ok: false, mode, ctx, reason: "RAY30_STALE" };
  const trend = normalizeRayTrend(ctx.trend);
  const strength = normalizeStrength(ctx.strength);
  if (mode === "STRICT") {
    if (trend === "BULL" || trend === "RECOVERY") return { ok: true, mode, ctx, reason: "STRICT_BULL_OR_RECOVERY" };
    return { ok: false, mode, ctx, reason: "STRICT_BLOCK_NOT_BULL" };
  }
  if (mode === "BALANCED") {
    if (["BULL", "RECOVERY", "NEUTRAL"].includes(trend)) return { ok: true, mode, ctx, reason: "BALANCED_ALLOWED" };
    if (trend === "BEAR" && strength === "WEAK") return { ok: true, mode, ctx, reason: "BALANCED_WEAK_BEAR_RECOVERY_ALLOWED" };
    return { ok: false, mode, ctx, reason: "BALANCED_STRONG_BEAR_BLOCK" };
  }
  // EASY_TEST
  if (trend === "BEAR" && strength === "STRONG") return { ok: false, mode, ctx, reason: "EASY_STRONG_BEAR_BLOCK" };
  return { ok: true, mode, ctx, reason: "EASY_ALLOWED" };
}
function fresh5m(current = nowMs()) {
  const f = state.feature5m;
  if (!f) return { ok: false, reason: "MISSING_5M" };
  const ageSec = (current - f.atMs) / 1000;
  if (ageSec > CFG.FEATURE_5M_MAX_AGE_SEC) return { ok: false, reason: "STALE_5M", ageSec: round(ageSec, 3), feature: f };
  return { ok: true, ageSec: round(ageSec, 3), feature: f };
}
function freshTick(current = nowMs()) {
  const t = state.ticks[state.ticks.length - 1];
  if (!t) return { ok: false, reason: "MISSING_TICK" };
  const ageSec = (current - t.atMs) / 1000;
  if (ageSec > CFG.FEATURE_TICK_MAX_AGE_SEC) return { ok: false, reason: "STALE_TICK", ageSec: round(ageSec, 3), tick: t };
  return { ok: true, ageSec: round(ageSec, 3), tick: t };
}
function belowPct(price, level) {
  if (!Number.isFinite(price) || !Number.isFinite(level) || level <= 0) return 0;
  return price < level ? ((level - price) / level) * 100 : 0;
}
function abovePct(price, level) {
  if (!Number.isFinite(price) || !Number.isFinite(level) || level <= 0) return 0;
  return price > level ? ((price - level) / level) * 100 : 0;
}
function fiveMinutePullbackOk(feature = state.feature5m) {
  if (!feature) return { ok: false, reason: "NO_5M" };
  const rsi = finite(feature.rsi, null);
  const fvvo = finite(feature.fvvo, null);
  const slope = finite(feature.slope, null);
  const prevSlope = finite(state.previous5m?.slope, null);
  const price = finite(feature.close ?? feature.price, null);
  const ema18 = finite(feature.ema18, null);
  const below18 = belowPct(price, ema18);
  if (rsi === null || rsi < CFG.PULLBACK_5M_MIN_RSI || rsi > CFG.PULLBACK_5M_MAX_RSI) return { ok: false, reason: "5M_RSI_OUT_OF_PULLBACK_ZONE", rsi };
  if (fvvo !== null && fvvo < CFG.PULLBACK_MIN_FVVO) return { ok: false, reason: "5M_FVVO_TOO_WEAK", fvvo };
  if (CFG.PULLBACK_REQUIRE_SLOPE_IMPROVING && slope !== null && prevSlope !== null && slope < prevSlope) return { ok: false, reason: "5M_SLOPE_NOT_IMPROVING", slope, prevSlope };
  if (below18 > CFG.PULLBACK_MAX_BELOW_EMA18_PCT) return { ok: false, reason: "5M_TOO_FAR_BELOW_EMA18", below18: round(below18, 6) };
  if (feature.rayBear && normalizeStrength(feature.rayStrength) === "STRONG") return { ok: false, reason: "5M_STRONG_RAY_BEAR" };
  return { ok: true, rsi, fvvo, slope, prevSlope, belowEma18Pct: round(below18, 6) };
}
function recentHighBefore(atMs, lookbackSec, excludeCurrent = true) {
  const minAt = atMs - lookbackSec * 1000;
  const arr = state.ticks.filter(t => t.atMs >= minAt && (!excludeCurrent || t.atMs < atMs) && Number.isFinite(t.price));
  if (!arr.length) return null;
  return Math.max(...arr.map(t => t.price));
}
function tickBreakoutOk(tick) {
  if (!tick || !Number.isFinite(tick.price)) return { ok: false, reason: "NO_TICK_PRICE" };
  const recentHigh = recentHighBefore(tick.atMs, CFG.TICK_BREAKOUT_LOOKBACK_SEC, true);
  const required = Number.isFinite(recentHigh) ? recentHigh * (1 + CFG.TICK_BREAKOUT_MARGIN_PCT / 100) : null;
  if (required && tick.price < required) return { ok: false, reason: "NO_15S_BREAKOUT", price: tick.price, recentHigh, required: round(required, 8) };
  return { ok: true, recentHigh, required: round(required, 8) };
}
function tickRecoveryOk(tick) {
  if (!tick) return { ok: false, reason: "NO_TICK" };
  const price = finite(tick.price, null);
  if (!Number.isFinite(price)) return { ok: false, reason: "NO_PRICE" };
  if (tick.rayBear) return { ok: false, reason: "TICK_RAY_BEAR" };
  if (finite(tick.rsi, 0) < CFG.TICK_MIN_RSI) return { ok: false, reason: "TICK_RSI_LOW", rsi: tick.rsi };
  if (finite(tick.fvvo, 0) < CFG.TICK_MIN_FVVO) return { ok: false, reason: "TICK_FVVO_LOW", fvvo: tick.fvvo };
  if (finite(tick.slope, -999) < CFG.TICK_MIN_SLOPE) return { ok: false, reason: "TICK_SLOPE_LOW", slope: tick.slope };
  if (Number.isFinite(tick.ema8) && price < tick.ema8) return { ok: false, reason: "PRICE_BELOW_TICK_EMA8", price, ema8: tick.ema8 };
  const ext8 = abovePct(price, tick.ema8);
  if (ext8 > CFG.TICK_MAX_EXT_EMA8_PCT) return { ok: false, reason: "TICK_TOO_EXTENDED_ABOVE_EMA8", ext8: round(ext8, 6) };
  const br = tickBreakoutOk(tick);
  if (!br.ok) return br;
  return { ok: true, rsi: tick.rsi, fvvo: tick.fvvo, slope: tick.slope, extEma8Pct: round(ext8, 6), breakout: br };
}
function entryReject(reason, meta = {}) {
  state.audit.lastEntryReject = { at: iso(), reason, ...meta };
  log("INFO", "RAY30_ENTRY_NO_ENTRY", { reason, ...meta });
}
async function openPosition(setup, price, reason, meta = {}) {
  updateDaily();
  if (positionOpen()) return { ok: false, error: "POSITION_ALREADY_OPEN" };
  if (state.daily.trades >= CFG.MAX_TRADES_PER_DAY) return { ok: false, error: "MAX_TRADES_PER_DAY_REACHED" };
  const result = await forward3Commas("enter_long", price, reason, { setup, ...meta });
  if (!result.ok) return result;
  state.position = {
    id: uuid("pos"), open: true, symbol: CFG.SYMBOL, setup, reason,
    entryPrice: price, entryAt: iso(), entryAtMs: nowMs(), entrySource: meta.source || "auto",
    peakPrice: price, peakProfitPct: 0, lockedFloorPct: null, lockedFloorPrice: null,
    runnerActive: false, emergencyDropObservations: 0, thesisBear5mCount: 0,
    campaignId: meta.campaignId || null, entryRole: meta.entryRole || null,
    lastC3EnterRequestId: result.requestId,
  };
  state.daily.trades += 1;
  persistState("position_opened");
  log("WARN", "RAY30_POSITION_OPENED", { setup, price: round(price, 8), reason, source: meta.source || "auto", requestId: result.requestId });
  return { ok: true, position: state.position, c3: result };
}
async function closePosition(price, reason, meta = {}) {
  if (!positionOpen()) return { ok: false, error: "NO_OPEN_POSITION" };
  const p = state.position;
  const pnlPct = pct(p.entryPrice, price);
  const result = await forward3Commas("exit_long", price, reason, { setup: p.setup, positionId: p.id, pnlPct: round(pnlPct, 6), ...meta });
  if (!result.ok) return result;
  const closed = { ...p, open: false, exitPrice: price, exitAt: iso(), exitAtMs: nowMs(), exitReason: reason, exitPnlPct: pnlPct, lastC3ExitRequestId: result.requestId };
  state.audit.lastExit = closed;
  state.position = null;
  persistState("position_closed");
  log("WARN", "RAY30_POSITION_CLOSED", { reason, price: round(price, 8), pnlPct: round(pnlPct, 6), peakProfitPct: round(closed.peakProfitPct, 6), requestId: result.requestId });
  return { ok: true, closed, c3: result };
}
function floorTable() {
  return [
    { mfe: CFG.FLOOR_1_MFE_PCT, lock: CFG.FLOOR_1_LOCK_PCT, label: "FLOOR_1_BREAKEVEN" },
    { mfe: CFG.FLOOR_2_MFE_PCT, lock: CFG.FLOOR_2_LOCK_PCT, label: "FLOOR_2_HALF_PERCENT" },
    { mfe: CFG.FLOOR_3_MFE_PCT, lock: CFG.FLOOR_3_LOCK_PCT, label: "FLOOR_3_ONE_PERCENT" },
    { mfe: CFG.FLOOR_4_MFE_PCT, lock: CFG.FLOOR_4_LOCK_PCT, label: "FLOOR_4_TWO_PERCENT" },
  ].sort((a, b) => a.mfe - b.mfe);
}
function recentTickHigh(windowSec, currentMs) {
  const minAt = currentMs - windowSec * 1000;
  const arr = state.ticks.filter(t => t.atMs >= minAt && Number.isFinite(t.price));
  if (!arr.length) return null;
  return Math.max(...arr.map(t => t.price));
}
async function manageOpenPositionOnTick(tick) {
  if (!positionOpen() || !tick || !Number.isFinite(tick.price)) return { ok: true, action: "none" };
  const p = state.position;
  const price = tick.price;
  const pnlPct = pct(p.entryPrice, price);
  if (price > finite(p.peakPrice, 0)) {
    p.peakPrice = price;
    p.peakProfitPct = pct(p.entryPrice, p.peakPrice);
  }
  // Emergency sudden-drop from recent 60s high.
  if (CFG.EMERGENCY_DROP_ENABLED) {
    let dropRef = null;
    if (CFG.EMERGENCY_DROP_MODE === "PREVIOUS_TICK") {
      const prior = state.ticks[state.ticks.length - 2];
      dropRef = prior?.price || null;
    } else {
      dropRef = recentTickHigh(CFG.EMERGENCY_DROP_WINDOW_SEC, tick.atMs);
    }
    const dropPct = dropRef ? pct(dropRef, price) : 0;
    if (dropRef && dropPct <= -Math.abs(CFG.EMERGENCY_DROP_PCT)) {
      p.emergencyDropObservations = Number(p.emergencyDropObservations || 0) + 1;
      log("WARN", "RAY30_EMERGENCY_DROP_DETECTED", { price, dropRef, dropPct: round(dropPct, 6), observations: p.emergencyDropObservations, required: CFG.EMERGENCY_DROP_CONFIRM_TICKS });
      if (p.emergencyDropObservations >= CFG.EMERGENCY_DROP_CONFIRM_TICKS) return closePosition(price, "RAY30_EMERGENCY_15S_DROP_EXIT", { dropRef, dropPct });
    } else {
      p.emergencyDropObservations = 0;
    }
  }
  // Hard stop.
  if (pnlPct <= -Math.abs(CFG.STOP_LOSS_PCT)) {
    return closePosition(price, "RAY30_HARD_STOP_LOSS", { pnlPct });
  }
  // Permanent floors.
  if (CFG.PERMANENT_FLOORS_ENABLED) {
    for (const floor of floorTable()) {
      if (p.peakProfitPct >= floor.mfe && (p.lockedFloorPct === null || floor.lock > p.lockedFloorPct)) {
        const old = p.lockedFloorPct;
        p.lockedFloorPct = floor.lock;
        p.lockedFloorPrice = priceFromPct(p.entryPrice, floor.lock);
        log("INFO", "RAY30_FLOOR_UPGRADED", { label: floor.label, peakProfitPct: round(p.peakProfitPct, 6), oldFloorPct: old, newFloorPct: floor.lock, floorPrice: round(p.lockedFloorPrice, 8) });
      }
    }
  }
  // Runner.
  if (CFG.RUNNER_ENABLED && p.peakProfitPct >= CFG.RUNNER_ACTIVATE_MFE_PCT) {
    if (!p.runnerActive) log("WARN", "RAY30_RUNNER_ACTIVATED", { peakProfitPct: round(p.peakProfitPct, 6), price });
    p.runnerActive = true;
    const runnerLock = Math.max(CFG.RUNNER_MIN_LOCK_PCT, p.peakProfitPct - CFG.RUNNER_GIVEBACK_PCT);
    if (p.lockedFloorPct === null || runnerLock > p.lockedFloorPct) {
      p.lockedFloorPct = runnerLock;
      p.lockedFloorPrice = priceFromPct(p.entryPrice, runnerLock);
      log("INFO", "RAY30_RUNNER_FLOOR_UPDATED", { peakProfitPct: round(p.peakProfitPct, 6), runnerLockPct: round(runnerLock, 6), floorPrice: round(p.lockedFloorPrice, 8) });
    }
  }
  if (p.lockedFloorPct !== null && pnlPct <= p.lockedFloorPct) {
    return closePosition(price, p.runnerActive ? "RAY30_RUNNER_FLOOR_EXIT" : "RAY30_PERMANENT_FLOOR_EXIT", { pnlPct, floorPct: p.lockedFloorPct, floorPrice: p.lockedFloorPrice, peakProfitPct: p.peakProfitPct });
  }
  persistState("position_tick_update");
  return { ok: true, action: "hold", pnlPct, peakProfitPct: p.peakProfitPct, lockedFloorPct: p.lockedFloorPct };
}
async function manageThesisExitOn5m(feature) {
  if (!CFG.THESIS_EXIT_ENABLED || !positionOpen() || !feature) return;
  const p = state.position;
  const ray = ray30Context(feature.atMs);
  const rayBearStrong = normalizeRayTrend(ray.trend) === "BEAR" && normalizeStrength(ray.strength) === "STRONG";
  const price = finite(feature.close ?? feature.price, null);
  const belowEma18 = Number.isFinite(price) && Number.isFinite(feature.ema18) && price < feature.ema18;
  const fvvoNegative = finite(feature.fvvo, 0) < 0;
  const fiveBear = belowEma18 && fvvoNegative;
  if (rayBearStrong && (!CFG.THESIS_EXIT_REQUIRE_5M_CONFIRM || fiveBear)) {
    p.thesisBear5mCount = Number(p.thesisBear5mCount || 0) + 1;
    log("WARN", "RAY30_THESIS_EXIT_CONFIRMING", { count: p.thesisBear5mCount, required: CFG.THESIS_EXIT_5M_CONFIRM_BARS, rayTrend: ray.trend, rayStrength: ray.strength, belowEma18, fvvo: feature.fvvo });
    if (p.thesisBear5mCount >= CFG.THESIS_EXIT_5M_CONFIRM_BARS && Number.isFinite(price)) {
      await closePosition(price, "RAY30_30M_RAY_BEAR_5M_THESIS_EXIT", { ray, five: { belowEma18, fvvo: feature.fvvo } });
    } else persistState("thesis_exit_confirming");
  } else if (p.thesisBear5mCount) {
    p.thesisBear5mCount = 0;
    persistState("thesis_exit_reset");
  }
}

async function evaluateAutoEntries(tick) {
  if (!tick || !Number.isFinite(tick.price)) return;
  if (positionOpen()) return entryReject("POSITION_ALREADY_OPEN");
  updateDaily();
  if (state.daily.trades >= CFG.MAX_TRADES_PER_DAY) return entryReject("MAX_TRADES_PER_DAY_REACHED", { trades: state.daily.trades });
  if (CFG.EMERGENCY_DISABLE_NEW_ENTRIES) return entryReject("NEW_ENTRIES_DISABLED");
  const rayGate = ray30AllowsLong(tick.atMs);
  if (!rayGate.ok) return entryReject("RAY30_GATE_BLOCK", { rayGate });
  const f5 = fresh5m(tick.atMs);
  if (!f5.ok) return entryReject(f5.reason, { rayGate });
  const fiveOk = fiveMinutePullbackOk(f5.feature);
  const tickOk = tickRecoveryOk(tick);

  // Campaigns have explicit user intent and are checked before pure automatic entries.
  const campaignResult = await evaluateCampaigns(tick, rayGate, f5, fiveOk, tickOk);
  if (campaignResult?.opened) return;

  if (CFG.ENTRY_15S_BREAKOUT_ENABLED && fiveOk.ok && tickOk.ok) {
    return openPosition("RAY30_15S_RECOVERY_BREAKOUT", tick.price, "RAY30_15S_RECOVERY_BREAKOUT", { source: "auto", rayGate, fiveOk, tickOk });
  }
  if (CFG.ENTRY_5M_PULLBACK_ENABLED && fiveOk.ok && tickOk.ok) {
    return openPosition("RAY30_5M_PULLBACK_RECOVERY", tick.price, "RAY30_5M_PULLBACK_RECOVERY", { source: "auto", rayGate, fiveOk, tickOk });
  }
  if (CFG.ENTRY_TREND_CONTINUATION_ENABLED && rayGate.ctx?.trend === "BULL" && tickOk.ok) {
    if (CFG.ENTRY_TREND_CONTINUATION_SHADOW_ONLY) {
      log("INFO", "RAY30_TREND_CONTINUATION_SHADOW", { price: tick.price, rayGate, tickOk, action: "NO_ORDER_SHADOW_ONLY" });
      return;
    }
    return openPosition("RAY30_TREND_CONTINUATION", tick.price, "RAY30_TREND_CONTINUATION", { source: "auto", rayGate, tickOk });
  }
  return entryReject("NO_ENTRY_CONDITIONS", { rayGate, fiveOk, tickOk });
}
function activeCampaigns() {
  const current = nowMs();
  state.campaigns = (state.campaigns || []).filter(c => c && c.active !== false && (!c.expiresAtMs || c.expiresAtMs > current));
  return state.campaigns;
}
function boolFromBody(value, def = false) {
  if (value === undefined || value === null || value === "") return def;
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|y|on)$/i.test(String(value).trim());
}
function campaignFromBody(body) {
  const campaignId = String(body.entry_campaign || body.entryCampaign || body.campaignId || body.campaign_id || uuid("camp")).trim();
  const role = cleanWord(body.entry_role || body.entryRole || body.role || "standalone").toLowerCase();
  const triggerMode = cleanWord(body.trigger_mode || body.triggerMode || "ray30_15s_recovery_breakout").toLowerCase();
  const expiresSec = finite(body.expire_after_sec ?? body.expireAfterSec, CFG.CAMPAIGN_DEFAULT_EXPIRE_SEC);
  const current = nowMs();
  const isBreakoutRetest = triggerMode === "breakout_retest_reclaim_zone";
  const c = {
    id: uuid("trigger"), campaignId, role, triggerMode,
    symbol: normalizeSymbol(body.symbol || CFG.SYMBOL),
    reason: String(body.reason || "manual_campaign_entry").slice(0, 200),
    triggerPrice: finite(body.trigger_price ?? body.triggerPrice ?? body.activation_price ?? body.activationPrice, null),
    activationPrice: finite(body.activation_price ?? body.activationPrice ?? body.trigger_price ?? body.triggerPrice, null),
    activationRangeLow: finite(body.activation_range_low ?? body.activationRangeLow ?? body.range_low ?? body.rangeLow, null),
    activationRangeHigh: finite(body.activation_range_high ?? body.activationRangeHigh ?? body.range_high ?? body.rangeHigh, null),
    breakoutConfirmPrice: finite(body.breakout_confirm_price ?? body.breakoutConfirmPrice ?? body.confirm_price ?? body.confirmPrice, null),
    retestRangeLow: finite(body.retest_range_low ?? body.retestRangeLow, null),
    retestRangeHigh: finite(body.retest_range_high ?? body.retestRangeHigh, null),
    maxEntryPrice: finite(body.max_entry_price ?? body.maxEntryPrice, null),
    minEntryPrice: finite(body.min_entry_price ?? body.minEntryPrice, null),
    stopPrice: finite(body.stop_price ?? body.stopPrice, null),
    profitTargetPrice: finite(body.profit_target_price ?? body.profitTargetPrice, 0),
    tp1Price: finite(body.tp1_price ?? body.tp1Price, null),
    tp2Price: finite(body.tp2_price ?? body.tp2Price, null),
    tp3Price: finite(body.tp3_price ?? body.tp3Price, null),
    requireRay30Gate: boolFromBody(body.require_ray30_gate, true),
    require5mPullback: boolFromBody(body.require_5m_pullback, false),
    require15sRecovery: boolFromBody(body.require_15s_recovery, true),
    phase: isBreakoutRetest ? "WAIT_BREAKOUT_CONFIRM" : "WAIT_TRIGGER",
    breakoutConfirmedAt: null,
    retestTouchedAt: null,
    lastObservedPrice: null,
    createdAt: iso(current), createdAtMs: current,
    expiresAt: iso(current + expiresSec * 1000), expiresAtMs: current + expiresSec * 1000,
    active: true, observedTicks: 0,
  };
  if (isBreakoutRetest && !Number.isFinite(c.breakoutConfirmPrice) && Number.isFinite(c.triggerPrice)) c.breakoutConfirmPrice = c.triggerPrice;
  return c;
}
function campaignPriceWindowOk(c, price) {
  if (Number.isFinite(c.minEntryPrice) && price < c.minEntryPrice) return { ok: false, reason: "PRICE_BELOW_MIN_ENTRY" };
  if (Number.isFinite(c.maxEntryPrice) && price > c.maxEntryPrice) return { ok: false, reason: "PRICE_ABOVE_MAX_ENTRY" };
  if (c.triggerMode === "breakout_retest_reclaim_zone") return { ok: true, mode: c.triggerMode, phase: c.phase };
  if (Number.isFinite(c.activationRangeLow) || Number.isFinite(c.activationRangeHigh)) {
    const lo = Number.isFinite(c.activationRangeLow) ? c.activationRangeLow : -Infinity;
    const hi = Number.isFinite(c.activationRangeHigh) ? c.activationRangeHigh : Infinity;
    if (price < lo || price > hi) return { ok: false, reason: "PRICE_OUTSIDE_ACTIVATION_RANGE", lo, hi };
  }
  if (Number.isFinite(c.activationPrice) && price < c.activationPrice) return { ok: false, reason: "PRICE_BELOW_ACTIVATION_PRICE", activationPrice: c.activationPrice };
  return { ok: true };
}
function breakoutRetestCampaignStep(c, tick) {
  const price = tick.price;
  c.lastObservedPrice = price;
  if (Number.isFinite(c.stopPrice) && price <= c.stopPrice) {
    c.active = false;
    c.cancelReason = "BREAKOUT_RETEST_STOP_BREACHED_BEFORE_ENTRY";
    log("WARN", "FVVO_PRICE_TRIGGER_CANCELLED", { triggerId: c.id, entryCampaign: c.campaignId, entryRole: c.role, triggerMode: c.triggerMode, triggerPrice: c.breakoutConfirmPrice, executionPrice: price, reason: c.cancelReason });
    log("WARN", "FVVO_CAMPAIGN_ENTRY_SETUP_CANCELLED", { entryCampaign: c.campaignId, entryRole: c.role, triggerId: c.id, reason: c.cancelReason });
    return { ok: false, cancelled: true, reason: c.cancelReason };
  }
  if (c.phase === "WAIT_BREAKOUT_CONFIRM") {
    if (!Number.isFinite(c.breakoutConfirmPrice)) return { ok: false, reason: "BREAKOUT_CONFIRM_PRICE_REQUIRED" };
    if (price >= c.breakoutConfirmPrice) {
      c.phase = "WAIT_RETEST_ZONE";
      c.breakoutConfirmedAt = iso(tick.atMs);
      log("INFO", "FVVO_BREAKOUT_RETEST_CONFIRM_SEEN", { triggerId: c.id, entryCampaign: c.campaignId, entryRole: c.role, breakoutConfirmPrice: c.breakoutConfirmPrice, price });
    }
    return { ok: false, reason: "WAIT_BREAKOUT_CONFIRM", phase: c.phase };
  }
  if (c.phase === "WAIT_RETEST_ZONE") {
    const lo = Number.isFinite(c.retestRangeLow) ? c.retestRangeLow : -Infinity;
    const hi = Number.isFinite(c.retestRangeHigh) ? c.retestRangeHigh : Infinity;
    if (price >= lo && price <= hi) {
      c.phase = "WAIT_RECLAIM";
      c.retestTouchedAt = iso(tick.atMs);
      log("INFO", "FVVO_BREAKOUT_RETEST_ZONE_TOUCHED", { triggerId: c.id, entryCampaign: c.campaignId, entryRole: c.role, price, retestRangeLow: c.retestRangeLow, retestRangeHigh: c.retestRangeHigh });
    }
    return { ok: false, reason: "WAIT_RETEST_ZONE", phase: c.phase };
  }
  if (c.phase === "WAIT_RECLAIM") {
    const reclaimLevel = Number.isFinite(c.retestRangeHigh) ? c.retestRangeHigh * (1 + CFG.CAMPAIGN_BREAKOUT_RECLAIM_BUFFER_PCT / 100) : c.breakoutConfirmPrice;
    if (Number.isFinite(reclaimLevel) && price >= reclaimLevel) return { ok: true, reason: "BREAKOUT_RETEST_RECLAIM_CONFIRMED", reclaimLevel, phase: c.phase };
    return { ok: false, reason: "WAIT_RECLAIM", reclaimLevel, phase: c.phase };
  }
  return { ok: false, reason: "UNKNOWN_BREAKOUT_PHASE", phase: c.phase };
}
async function evaluateCampaigns(tick, rayGate, f5, fiveOk, tickOk) {
  const campaigns = activeCampaigns();
  if (!campaigns.length || positionOpen()) return { opened: false };
  for (const c of campaigns) {
    if (c.symbol !== CFG.SYMBOL) continue;
    c.observedTicks = Number(c.observedTicks || 0) + 1;
    let modeStep = { ok: true };
    if (c.triggerMode === "breakout_retest_reclaim_zone") {
      modeStep = breakoutRetestCampaignStep(c, tick);
      if (!modeStep.ok) { c.lastReject = { at: iso(), price: tick.price, ...modeStep }; continue; }
    } else {
      const priceWindow = campaignPriceWindowOk(c, tick.price);
      if (!priceWindow.ok) { c.lastReject = { at: iso(), ...priceWindow, price: tick.price }; continue; }
    }
    if (c.requireRay30Gate && !rayGate.ok) { c.lastReject = { at: iso(), reason: "RAY30_GATE_BLOCK", rayGate }; continue; }
    if (c.require5mPullback && !fiveOk.ok) { c.lastReject = { at: iso(), reason: "5M_PULLBACK_NOT_CONFIRMED", fiveOk }; continue; }
    if (c.require15sRecovery && !tickOk.ok) { c.lastReject = { at: iso(), reason: "15S_RECOVERY_NOT_CONFIRMED", tickOk }; continue; }
    c.active = false;
    const siblingCancelled = campaigns.filter(s => s !== c && s.campaignId === c.campaignId && s.active !== false);
    for (const s of siblingCancelled) { s.active = false; s.cancelReason = "SIBLING_PRICE_TRIGGER_FIRED"; }
    persistState("campaign_winner_selected");
    log("INFO", "FVVO_CAMPAIGN_ENTRY_RESERVED", { entryCampaign: c.campaignId, candidateRole: c.role, candidateMode: c.triggerMode, triggerId: c.id, executionPrice: tick.price, siblingCount: siblingCancelled.length });
    if (siblingCancelled.length) log("WARN", "FVVO_CAMPAIGN_SIBLINGS_CANCELLED", { entryCampaign: c.campaignId, triggerId: c.id, cancelledSiblingCount: siblingCancelled.length });
    log("INFO", "FVVO_PRICE_TRIGGER_FIRED", { triggerId: c.id, entryCampaign: c.campaignId, entryRole: c.role, triggerMode: c.triggerMode, triggerPrice: c.triggerPrice || c.breakoutConfirmPrice || c.activationPrice, activationPrice: c.activationPrice || null, activationRangeLow: c.activationRangeLow || null, activationRangeHigh: c.activationRangeHigh || null, breakoutConfirmPrice: c.breakoutConfirmPrice || null, retestRangeLow: c.retestRangeLow || null, retestRangeHigh: c.retestRangeHigh || null, previousPrice: c.lastObservedPrice, executionReferencePrice: tick.price, stopPrice: c.stopPrice, profitTargetPrice: c.profitTargetPrice || null, marketOrderWillBeSent: true });
    const result = await openPosition(`PRICE_TRIGGER_${cleanWord(c.triggerMode, "RAY30_15S_RECOVERY_BREAKOUT")}`, tick.price, c.triggerMode === "breakout_retest_reclaim_zone" ? "PRICE_TRIGGER_BREAKOUT_RETEST_RECLAIM_ZONE" : "PRICE_TRIGGER_CAMPAIGN_ENTRY", { source: "campaign", campaignId: c.campaignId, entryRole: c.role, triggerId: c.id, rayGate, fiveOk, tickOk, campaign: c, modeStep });
    return { opened: Boolean(result.ok), result };
  }
  persistState("campaigns_evaluated");
  return { opened: false };
}


function statusPayload() {
  return {
    ok: true,
    brain: CFG.BRAIN_NAME,
    symbol: CFG.SYMBOL,
    mode: CFG.EXECUTION_MODE,
    forward: {
      enableHttpForward: CFG.ENABLE_HTTP_FORWARD,
      demoForwardAllowed: CFG.DEMO_FORWARD_ALLOWED,
      liveForwardAllowed: CFG.LIVE_FORWARD_ALLOWED,
      c3DryRun: CFG.C3_DRY_RUN,
      emergencyDisableAllForwards: CFG.EMERGENCY_DISABLE_ALL_FORWARDS,
      emergencyDisableNewEntries: CFG.EMERGENCY_DISABLE_NEW_ENTRIES,
    },
    ray30: ray30Context(),
    feature5m: state.feature5m ? { at: state.feature5m.at, ageSec: round((nowMs() - state.feature5m.atMs) / 1000, 3), price: state.feature5m.price, rsi: state.feature5m.rsi, fvvo: state.feature5m.fvvo, slope: state.feature5m.slope } : null,
    latestTick: state.ticks.length ? { at: state.ticks[state.ticks.length - 1].at, price: state.ticks[state.ticks.length - 1].price, rsi: state.ticks[state.ticks.length - 1].rsi, fvvo: state.ticks[state.ticks.length - 1].fvvo, slope: state.ticks[state.ticks.length - 1].slope } : null,
    position: state.position,
    activeCampaigns: activeCampaigns(),
    priceTrigger: {
      activePendingCount: activeCampaigns().length,
      pendingList: activeCampaigns(),
      supportedTriggerModes: ["breakout_retest_reclaim_zone", "trailing_dip_reclaim_zone", "confirmed_pullback_reclaim_zone", "ray30_15s_recovery_breakout"],
    },
    manual: {
      allowedActions: allowedManualActions(),
      ...latestFeaturePricePayload(),
      positionOpen: positionOpen(),
      externalDealLockActive: positionOpen(),
      brainWillManageExit: positionOpen(),
    },
    allowed: allowedManualActions(),
    daily: state.daily,
    stateFile: CFG.STATE_FILE,
    audit: state.audit,
  };
}
async function manualEnter(body) {
  if (positionOpen()) return { status: 409, body: { ok: false, action: "enter_long", symbol: CFG.SYMBOL, reason: "POSITION_ALREADY_OPEN", status: statusPayload() } };
  const tick = freshTick();
  if (CFG.MANUAL_REQUIRE_FRESH_FEATURE_TICK && !tick.ok) return { status: 400, body: { ok: false, action: "enter_long", symbol: CFG.SYMBOL, reason: tick.reason, manual: latestFeaturePricePayload(), allowed: allowedManualActions() } };
  const explicitPrice = finite(body.entry_price ?? body.entryPrice ?? body.price, null);
  const price = Number.isFinite(explicitPrice) ? explicitPrice : (CFG.MANUAL_ALLOW_AUTO_LATEST_PRICE ? finite(tick.tick?.price, null) : null);
  if (!Number.isFinite(price) || price <= 0) return { status: 400, body: { ok: false, action: "enter_long", symbol: CFG.SYMBOL, reason: "MANUAL_PRICE_REQUIRED", manual: latestFeaturePricePayload(), allowed: allowedManualActions() } };
  const profile = cleanWord(body.profile || body.entryProfile || CFG.MANUAL_ENTRY_DEFAULT_PROFILE);
  const result = await openPosition(profile, price, "MANUAL_ENTER_LONG", { source: "manual", manualReason: body.reason || null, stopPrice: finite(body.stop_price ?? body.stopPrice, null), profitTargetPrice: finite(body.profit_target_price ?? body.profitTargetPrice, 0) });
  return { status: result.ok ? 200 : 400, body: { ...result, action: "enter_long", symbol: CFG.SYMBOL, entryPrice: price, profile, manual: latestFeaturePricePayload() } };
}
async function manualExit(body) {
  if (!positionOpen()) return { status: 409, body: { ok: false, error: "NO_OPEN_POSITION" } };
  const tick = freshTick();
  const price = finite(body.price ?? body.exit_price ?? body.exitPrice, tick.tick?.price ?? state.position.entryPrice);
  const result = await closePosition(price, "MANUAL_EXIT_LONG", { source: "manual", manualReason: body.reason || null });
  return { status: result.ok ? 200 : 400, body: result };
}
function manualCancel(body) {
  const target = cleanWord(body.target || body.cancelTarget || "campaigns").toLowerCase();
  let cancelled = 0;
  if (["campaign", "campaigns", "all", "entries"].includes(target)) {
    for (const c of activeCampaigns()) { c.active = false; c.cancelReason = "MANUAL_CANCEL"; cancelled += 1; }
  }
  if (["pending", "all", "entries"].includes(target)) state.pending.manual = null;
  persistState("manual_cancel");
  log("WARN", "FVVO_PRICE_TRIGGER_CANCELLED", { triggerId: "ALL", entryCampaign: null, entryRole: "all", reason: "MANUAL_CANCEL", cancelled });
  log("WARN", "RAY30_MANUAL_CANCEL", { target, cancelled });
  return { status: 200, body: { ok: true, target, cancelled } };
}
function armCampaignEntry(body) {
  if (!symbolOk(body)) return { status: 400, body: { ok: false, error: "SYMBOL_MISMATCH", expected: CFG.SYMBOL } };
  const campaigns = activeCampaigns();
  if (campaigns.length >= CFG.CAMPAIGN_MAX_ACTIVE) return { status: 409, body: { ok: false, error: "MAX_ACTIVE_CAMPAIGNS_REACHED", max: CFG.CAMPAIGN_MAX_ACTIVE } };
  const c = campaignFromBody(body);
  if (!c.campaignId) return { status: 400, body: { ok: false, error: "CAMPAIGN_ID_REQUIRED" } };
  state.campaigns.push(c);
  persistState("price_trigger_armed");
  const pendingSlot = activeCampaigns().length;
  log("INFO", "FVVO_PRICE_TRIGGER_ARMED", { triggerId: c.id, pendingSlot, activePendingCount: activeCampaigns().length, entryCampaign: c.campaignId, entryRole: c.role, triggerMode: c.triggerMode, triggerPrice: c.triggerPrice || c.breakoutConfirmPrice || c.activationPrice || null, activationPrice: c.activationPrice || null, activationRangeLow: c.activationRangeLow || null, activationRangeHigh: c.activationRangeHigh || null, breakoutConfirmPrice: c.breakoutConfirmPrice || null, retestRangeLow: c.retestRangeLow || null, retestRangeHigh: c.retestRangeHigh || null, stopPrice: c.stopPrice || null, profitTargetPrice: c.profitTargetPrice || null, expiresAt: c.expiresAt, initialCrossAction: c.triggerMode === "breakout_retest_reclaim_zone" ? "START_TRACKING" : "SEND_MARKET_ORDER", confirmedAction: "SEND_DEMO_MARKET_ORDER", marketOrderWillBeSentOnCross: c.triggerMode !== "breakout_retest_reclaim_zone", breakoutRetestReclaimZoneMode: c.triggerMode === "breakout_retest_reclaim_zone" ? "TRACK_CONFIRM_RETEST_RECLAIM" : null });
  if (c.campaignId) log("INFO", "FVVO_CAMPAIGN_ENTRY_SETUP_ARMED", { entryCampaign: c.campaignId, entryRole: c.role, triggerId: c.id, pendingSlot, activeCampaignSetups: activeCampaigns().filter(item => item.campaignId === c.campaignId).length, triggerMode: c.triggerMode, expiresAt: c.expiresAt });
  return { status: 200, body: { ok: true, priceEntryArmed: true, orderTypeOnTrigger: c.triggerMode === "breakout_retest_reclaim_zone" ? "market_on_reclaim" : "market", trigger: c, campaign: c, activeCampaigns: activeCampaigns().length, allowed: allowedManualActions() } };
}
function cancelCampaign(body) {
  const id = String(body.entry_campaign || body.entryCampaign || body.campaignId || body.campaign_id || "").trim();
  let cancelled = 0;
  for (const c of activeCampaigns()) {
    if (!id || c.campaignId === id || c.id === id) { c.active = false; c.cancelReason = "MANUAL_CANCEL_CAMPAIGN"; cancelled += 1; }
  }
  persistState("campaign_cancelled");
  log("WARN", "FVVO_PRICE_TRIGGER_CANCELLED", { triggerId: id || "ALL", entryCampaign: id || null, entryRole: "campaign", reason: "MANUAL_CANCEL_CAMPAIGN", cancelled });
  log("WARN", "FVVO_CAMPAIGN_ENTRY_SETUP_CANCELLED", { entryCampaign: id || "ALL", entryRole: "campaign", triggerId: id || "ALL", reason: "MANUAL_CANCEL_CAMPAIGN", cancelled });
  log("WARN", "RAY30_CAMPAIGN_CANCELLED", { campaignId: id || "ALL", cancelled });
  return { status: 200, body: { ok: true, campaignId: id || "ALL", cancelled } };
}
function adoptLong(body) {
  if (positionOpen()) return { status: 409, body: { ok: false, error: "POSITION_ALREADY_OPEN" } };
  const price = finite(body.entry_price ?? body.entryPrice ?? body.price, null);
  if (!Number.isFinite(price) || price <= 0) return { status: 400, body: { ok: false, error: "EXPLICIT_ENTRY_PRICE_REQUIRED" } };
  state.position = {
    id: uuid("adopt"), open: true, symbol: CFG.SYMBOL, setup: cleanWord(body.profile || "MANUAL_ADOPT_LONG"), reason: "MANUAL_ADOPT_LONG",
    entryPrice: price, entryAt: iso(), entryAtMs: nowMs(), entrySource: "manual_adopt",
    peakPrice: price, peakProfitPct: 0, lockedFloorPct: null, lockedFloorPrice: null, runnerActive: false,
    emergencyDropObservations: 0, thesisBear5mCount: 0,
  };
  persistState("manual_adopt_long");
  log("WARN", "RAY30_MANUAL_ADOPT_LONG", { entryPrice: price });
  return { status: 200, body: { ok: true, position: state.position } };
}
function forceClear(body) {
  const prior = state.position;
  state.position = null;
  persistState("force_clear_verified_flat");
  log("WARN", "RAY30_FORCE_CLEAR_VERIFIED_FLAT", { hadPosition: Boolean(prior), reason: body.reason || null });
  return { status: 200, body: { ok: true, cleared: Boolean(prior) } };
}
async function handleManual(body) {
  const action = String(body.action || "").trim().toLowerCase();
  log("INFO", "RAY30_MANUAL_COMMAND", { action });
  if (!CFG.MANUAL_CONTROL_ENABLED) return { status: 403, body: { ok: false, error: "MANUAL_CONTROL_DISABLED" } };
  if (!requireSecret(body, true)) return { status: 403, body: { ok: false, error: "MANUAL_SECRET_INVALID" } };
  if (!symbolOk(body)) return { status: 400, body: { ok: false, error: "SYMBOL_MISMATCH", expected: CFG.SYMBOL } };
  if (action === "status") return { status: 200, body: statusPayload() };
  if (action === "enter_long" || action === "manual_entry") return manualEnter(body);
  if (action === "exit_long" || action === "manual_exit") return manualExit(body);
  if (action === "cancel" || action === "cancel_all_entries" || action === "handoff_manual") return manualCancel(body);
  if (action === "arm_campaign_entry" || action === "campaign_entry" || action === "arm_price_entry") return armCampaignEntry(body);
  if (action === "cancel_campaign" || action === "cancel_price_entry") return cancelCampaign(body);
  if (action === "adopt_long") return adoptLong(body);
  if (action === "force_clear_verified_flat" || action === "clear_position" || action === "clear_handoff") return forceClear(body);
  return { status: 400, body: { ok: false, reason: "UNKNOWN_MANUAL_ACTION", allowed: allowedManualActions() } };
}

async function handleFeature(body) {
  if (!requireSecret(body, false)) return { status: 403, body: { ok: false, error: "WEBHOOK_SECRET_INVALID" } };
  if (!symbolOk(body)) return { status: 400, body: { ok: false, error: "SYMBOL_MISMATCH", expected: CFG.SYMBOL } };
  const event = cleanWord(body.event || body.kind || body.type || body.timeframe || "FEATURE_TICK_FVVO");
  if (["RAY30_SIGNAL", "RAY_30M", "RAY30", "30M_RAY"].includes(event)) {
    const price = bodyPrice(body);
    const atMs = eventTimeMs(body);
    state.ray30 = {
      at: iso(atMs), atMs, price,
      trend: normalizeRayTrend(body.rayTrend ?? body.rayRegime ?? body.trend),
      signal: cleanWord(body.raySignal ?? body.signal ?? ""),
      strength: normalizeStrength(body.rayStrength ?? body.strength ?? ""),
      trendAge: finite(body.rayTrendAge ?? body.trendAge, null),
      volatility: finite(body.rayVolatility ?? body.volatility, null),
      rayBull: Boolean(body.rayBull), rayBear: Boolean(body.rayBear), raw: body,
    };
    persistState("ray30_update");
    log("INFO", "RAY30_SIGNAL_UPDATE", { trend: state.ray30.trend, signal: state.ray30.signal, strength: state.ray30.strength, price });
    return { status: 200, body: { ok: true, ray30: state.ray30 } };
  }
  if (["FEATURE_5M_FVVO", "FVVO_FEATURE_5M", "5M", "FEATURE_5M"].includes(event)) {
    const f = normalizeFeature(body, "FEATURE_5M_FVVO");
    if (!Number.isFinite(f.price)) return { status: 400, body: { ok: false, error: "PRICE_REQUIRED" } };
    state.previous5m = state.feature5m;
    state.feature5m = f;
    await manageThesisExitOn5m(f);
    persistState("feature5m_update");
    log("INFO", "FVVO_FEATURE_5M_RECEIVED", { event: "FEATURE_5M_FVVO", price: f.price, ema8: f.ema8, ema18: f.ema18, rsi: f.rsi, adx: f.adx, fvvo: f.fvvo, slope: f.slope, crossUp: f.crossUp, crossDown: f.crossDown, rayRegime: f.rayTrend, publisherKind: "SOL_5M_FEATURE", chartTimeframe: "5", barTimeMs: f.atMs, priceTriggerState: activeCampaigns().length ? `${activeCampaigns().length}_ARMED` : null, brainExitManagementActive: positionOpen() });
    return { status: 200, body: { ok: true, feature5m: { at: f.at, price: f.price } } };
  }
  // Default feature tick / 15s event.
  const t = normalizeFeature(body, "FEATURE_TICK_FVVO");
  if (!Number.isFinite(t.price)) return { status: 400, body: { ok: false, error: "PRICE_REQUIRED" } };
  state.ticks.push(t);
  const cutoff = t.atMs - Math.max(CFG.EMERGENCY_DROP_WINDOW_SEC, CFG.TICK_BREAKOUT_LOOKBACK_SEC, 300) * 1000;
  state.ticks = state.ticks.filter(x => x.atMs >= cutoff).slice(-500);
  const exitResult = await manageOpenPositionOnTick(t);
  if (!positionOpen()) await evaluateAutoEntries(t);
  persistState("feature_tick_update");
  log("INFO", "FVVO_FEATURE_TICK_RECEIVED", { event: "FEATURE_TICK_FVVO", price: t.price, ema8: t.ema8, ema18: t.ema18, rsi: t.rsi, adx: t.adx, fvvo: t.fvvo, slope: t.slope, crossUp: t.crossUp, crossDown: t.crossDown, rayRegime: t.rayTrend, publisherKind: null, chartTimeframe: "15S", barTimeMs: t.atMs, priceTriggerState: activeCampaigns().length ? `${activeCampaigns().length}_ARMED` : null, brainExitManagementActive: positionOpen(), exitAction: exitResult?.action || null });
  return { status: 200, body: { ok: true, tick: { at: t.at, price: t.price }, positionOpen: positionOpen() } };
}

app.get("/", (_, res) => res.json({ ok: true, brain: CFG.BRAIN_NAME, symbol: CFG.SYMBOL, manualPath: CFG.MANUAL_WEBHOOK_PATH, webhookPath: CFG.WEBHOOK_PATH }));
app.get("/health", (_, res) => res.json({ ok: true, brain: CFG.BRAIN_NAME, symbol: CFG.SYMBOL, hasPosition: positionOpen(), campaigns: activeCampaigns().length, stateFile: CFG.STATE_FILE }));
app.post(CFG.WEBHOOK_PATH, async (req, res) => {
  try {
    const result = await handleFeature(req.body || {});
    res.status(result.status).json(result.body);
  } catch (error) {
    log("ERROR", "WEBHOOK_HANDLER_FAILED", { error: error.message, stack: String(error.stack || "").slice(0, 500) });
    res.status(500).json({ ok: false, error: "WEBHOOK_HANDLER_FAILED" });
  }
});
app.post(CFG.MANUAL_WEBHOOK_PATH, async (req, res) => {
  try {
    const result = await handleManual(req.body || {});
    res.status(result.status).json(result.body);
  } catch (error) {
    log("ERROR", "MANUAL_HANDLER_FAILED", { error: error.message, stack: String(error.stack || "").slice(0, 500) });
    res.status(500).json({ ok: false, error: "MANUAL_HANDLER_FAILED" });
  }
});

function startupSummary() {
  log("INFO", "STARTUP", {
    port: CFG.PORT, webhookPath: CFG.WEBHOOK_PATH, manualPath: CFG.MANUAL_WEBHOOK_PATH,
    symbol: CFG.SYMBOL, executionMode: CFG.EXECUTION_MODE,
    demoForwardAllowed: CFG.DEMO_FORWARD_ALLOWED, liveForwardAllowed: CFG.LIVE_FORWARD_ALLOWED,
    c3DryRun: CFG.C3_DRY_RUN, stateFile: CFG.STATE_FILE,
    ray30GateMode: CFG.RAY30_LONG_GATE_MODE,
    entries: {
      pullback5m: CFG.ENTRY_5M_PULLBACK_ENABLED,
      breakout15s: CFG.ENTRY_15S_BREAKOUT_ENABLED,
      trendContinuationShadow: CFG.ENTRY_TREND_CONTINUATION_ENABLED && CFG.ENTRY_TREND_CONTINUATION_SHADOW_ONLY,
    },
    exits: {
      stopLossPct: CFG.STOP_LOSS_PCT,
      emergencyDropPct: CFG.EMERGENCY_DROP_PCT,
      permanentFloors: CFG.PERMANENT_FLOORS_ENABLED,
      runner: CFG.RUNNER_ENABLED,
    },
    secrets: { webhookSecretSet: Boolean(CFG.WEBHOOK_SECRET), manualSecretSet: Boolean(CFG.MANUAL_WEBHOOK_SECRET), c3EnterSet: Boolean(CFG.C3_ENTER_LONG_CODE), c3ExitSet: Boolean(CFG.C3_EXIT_LONG_CODE) },
  });
}

loadState();
startupSummary();
app.listen(CFG.PORT, () => log("INFO", "HTTP_LISTENING", { port: CFG.PORT }));
