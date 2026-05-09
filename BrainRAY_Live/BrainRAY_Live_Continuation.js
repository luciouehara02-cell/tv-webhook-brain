import express from "express";

/**
 * BrainRAY_Continuation_v5.1
 *
 * Built from the v5.0 replay behaviour:
 * - keeps the v5.0 first Bullish Trend Change engine
 * - changes the default immediate first-entry chase from 0.30% to 0.35%
 * - adds v5.1 post-exit continuation profit guard
 *
 * Main v5.1 goal:
 * If post-exit continuation reaches useful profit, protect it near the v4.4f-style
 * first re-entry harvest area instead of allowing full giveback to breakeven/loss.
 */

const app = express();
app.use(express.json({ limit: "1mb" }));

// -----------------------------
// Basic helpers
// -----------------------------
function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function s(v, d = "") {
  return v == null ? d : String(v);
}

function b(v, d = false) {
  if (v == null) return d;
  const x = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(x)) return true;
  if (["0", "false", "no", "off"].includes(x)) return false;
  return d;
}

function nowMs() {
  return Date.now();
}

function isoNow() {
  return new Date().toISOString();
}

function round4(v) {
  const x = Number(v);
  return Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null;
}

function pctDiff(from, to) {
  const a = Number(from);
  const c = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(c) || a === 0) return 0;
  return ((c - a) / a) * 100;
}

function normalizeSymbol(raw) {
  const x = String(raw || "").trim().toUpperCase();
  if (!x) return "";
  if (x.includes(":")) return x;
  return `BINANCE:${x}`;
}

function safeJsonParse(raw, fallback = {}) {
  try {
    return JSON.parse(String(raw || ""));
  } catch {
    return fallback;
  }
}

function parseTimeMs(v) {
  const t = new Date(v || "").getTime();
  return Number.isFinite(t) ? t : null;
}

function ageSec(iso) {
  const t = parseTimeMs(iso);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowMs() - t) / 1000);
}

function pickFirst(obj, keys, fallback = undefined) {
  for (const k of keys) {
    if (obj?.[k] !== undefined && obj?.[k] !== null && obj?.[k] !== "") return obj[k];
  }
  return fallback;
}

function reasonPush(list, condition, reason) {
  if (condition) list.push(reason);
}

function barKeyFromTime(iso, tfMin = 5) {
  const t = parseTimeMs(iso) ?? nowMs();
  const bucket = Math.floor(t / (tfMin * 60 * 1000)) * tfMin * 60 * 1000;
  return new Date(bucket).toISOString();
}

function symbolParts(symbol) {
  const sym = normalizeSymbol(symbol);
  if (sym.includes(":")) {
    const [tv_exchange, tv_instrument] = sym.split(":");
    return { tv_exchange, tv_instrument };
  }
  return { tv_exchange: "BINANCE", tv_instrument: sym };
}

function isFirstEntryMode(mode) {
  return [
    "first_bullish_trend_change_immediate_long",
    "first_bullish_trend_change_confirmed_long",
  ].includes(String(mode || ""));
}

function isPostExitContinuationMode(mode) {
  return [
    "post_exit_continuation_reentry_long",
    "post_exit_continuation_reentry_long_strong",
  ].includes(String(mode || ""));
}

function isFeatureReentryMode(mode) {
  return [
    "feature_pullback_reclaim_reentry_long",
    "feature_pullback_reclaim_reentry_long_strong",
  ].includes(String(mode || ""));
}

function isReentryHarvestMode(mode) {
  return isPostExitContinuationMode(mode) || isFeatureReentryMode(mode);
}

function maxFinite(...vals) {
  const arr = vals.map(Number).filter(Number.isFinite);
  return arr.length ? Math.max(...arr) : NaN;
}

// -----------------------------
// Config
// -----------------------------
const CONFIG = {
  PORT: n(process.env.PORT, 8080),
  DEBUG: b(process.env.DEBUG, true),
  BRAIN_NAME: s(process.env.BRAIN_NAME, "BrainRAY_Continuation_v5.1"),
  WEBHOOK_PATH: s(process.env.WEBHOOK_PATH, "/webhook"),
  WEBHOOK_SECRET: s(process.env.WEBHOOK_SECRET, ""),
  TICKROUTER_SECRET: s(process.env.TICKROUTER_SECRET, ""),

  SYMBOL: normalizeSymbol(process.env.SYMBOL || "BINANCE:SOLUSDT"),
  ENTRY_TF: s(process.env.ENTRY_TF, "5"),

  REPLAY_ALLOW_STALE_DATA: b(process.env.REPLAY_ALLOW_STALE_DATA, false),
  REPLAY_USE_EVENT_TIME_FOR_POSITION_CLOCK: b(process.env.REPLAY_USE_EVENT_TIME_FOR_POSITION_CLOCK, true),
  TICK_MAX_AGE_SEC: n(process.env.TICK_MAX_AGE_SEC, 60),
  FEATURE_MAX_AGE_SEC: n(process.env.FEATURE_MAX_AGE_SEC, 900),

  ENABLE_HTTP_FORWARD: b(process.env.ENABLE_HTTP_FORWARD, true),
  C3_SIGNAL_URL: s(process.env.C3_SIGNAL_URL || process.env.THREECOMMAS_WEBHOOK_URL, ""),
  C3_SIGNAL_SECRET: s(process.env.C3_SIGNAL_SECRET || process.env.THREECOMMAS_SECRET, ""),
  C3_TIMEOUT_MS: n(process.env.C3_TIMEOUT_MS || process.env.THREECOMMAS_TIMEOUT_MS, 8000),
  MAX_LAG_SEC: n(process.env.MAX_LAG_SEC, 300),
  SYMBOL_BOT_MAP: safeJsonParse(process.env.SYMBOL_BOT_MAP || "{}", {}),

  ENTER_DEDUP_MS: n(process.env.ENTER_DEDUP_MS, 90000),
  REENTRY_ENTER_DEDUP_MS: n(process.env.REENTRY_ENTER_DEDUP_MS, 8000),
  EXIT_DEDUP_MS: n(process.env.EXIT_DEDUP_MS, 60000),
  EXIT_COOLDOWN_MIN: n(process.env.EXIT_COOLDOWN_MIN, 12),

  // v5.0 / v5.1 first Bullish Trend Change engine
  FIRST_ENTRY_ENGINE_ENABLED: b(process.env.FIRST_ENTRY_ENGINE_ENABLED, true),
  FIRST_ENTRY_IMMEDIATE_MIN_RSI: n(process.env.FIRST_ENTRY_IMMEDIATE_MIN_RSI, 55),
  FIRST_ENTRY_IMMEDIATE_MIN_ADX: n(process.env.FIRST_ENTRY_IMMEDIATE_MIN_ADX, 14),

  // v5.1 default changed from v5.0 0.30 to 0.35 based on v5.0B replay.
  FIRST_ENTRY_IMMEDIATE_MAX_CHASE_PCT: n(process.env.FIRST_ENTRY_IMMEDIATE_MAX_CHASE_PCT, 0.35),
  FIRST_ENTRY_IMMEDIATE_MAX_EXT_EMA18_PCT: n(process.env.FIRST_ENTRY_IMMEDIATE_MAX_EXT_EMA18_PCT, 1.20),
  FIRST_ENTRY_REQUIRE_EMA8_ABOVE_EMA18: b(process.env.FIRST_ENTRY_REQUIRE_EMA8_ABOVE_EMA18, true),
  FIRST_ENTRY_REQUIRE_CLOSE_ABOVE_EMA8: b(process.env.FIRST_ENTRY_REQUIRE_CLOSE_ABOVE_EMA8, true),

  FIRST_ENTRY_CONFIRM_ENABLED: b(process.env.FIRST_ENTRY_CONFIRM_ENABLED, true),
  FIRST_ENTRY_CONFIRM_WINDOW_SEC: n(process.env.FIRST_ENTRY_CONFIRM_WINDOW_SEC, 45),
  FIRST_ENTRY_CONFIRM_MIN_RSI: n(process.env.FIRST_ENTRY_CONFIRM_MIN_RSI, 52),
  FIRST_ENTRY_CONFIRM_MIN_ADX: n(process.env.FIRST_ENTRY_CONFIRM_MIN_ADX, 12),
  FIRST_ENTRY_CONFIRM_MAX_CHASE_PCT: n(process.env.FIRST_ENTRY_CONFIRM_MAX_CHASE_PCT, 0.38),
  FIRST_ENTRY_CONFIRM_TICK_CONFIRM_PCT: n(process.env.FIRST_ENTRY_CONFIRM_TICK_CONFIRM_PCT, 0.05),
  FIRST_ENTRY_CONFIRM_MIN_TICKS: n(process.env.FIRST_ENTRY_CONFIRM_MIN_TICKS, 2),
  FIRST_ENTRY_CONFIRM_ALLOW_CLOSE_NEAR_EMA8: b(process.env.FIRST_ENTRY_CONFIRM_ALLOW_CLOSE_NEAR_EMA8, true),
  FIRST_ENTRY_CONFIRM_MAX_BELOW_EMA8_PCT: n(process.env.FIRST_ENTRY_CONFIRM_MAX_BELOW_EMA8_PCT, 0.08),

  FIRST_ENTRY_WEAK_BLOCK_ENABLED: b(process.env.FIRST_ENTRY_WEAK_BLOCK_ENABLED, true),
  FIRST_ENTRY_BLOCK_MIN_RED_FLAGS: n(process.env.FIRST_ENTRY_BLOCK_MIN_RED_FLAGS, 2),
  FIRST_ENTRY_BLOCK_RSI_BELOW: n(process.env.FIRST_ENTRY_BLOCK_RSI_BELOW, 50),
  FIRST_ENTRY_BLOCK_ADX_BELOW: n(process.env.FIRST_ENTRY_BLOCK_ADX_BELOW, 12),
  FIRST_ENTRY_BLOCK_MAX_CHASE_PCT: n(process.env.FIRST_ENTRY_BLOCK_MAX_CHASE_PCT, 0.45),
  FIRST_ENTRY_BLOCK_MAX_EXT_EMA18_PCT: n(process.env.FIRST_ENTRY_BLOCK_MAX_EXT_EMA18_PCT, 1.35),
  FIRST_ENTRY_BLOCK_IF_EMA8_BELOW_EMA18: b(process.env.FIRST_ENTRY_BLOCK_IF_EMA8_BELOW_EMA18, true),
  FIRST_ENTRY_BLOCK_IF_CLOSE_BELOW_EMA8: b(process.env.FIRST_ENTRY_BLOCK_IF_CLOSE_BELOW_EMA8, false),
  FIRST_ENTRY_BLOCK_IF_STRONG_BEARISH_FVVO: b(process.env.FIRST_ENTRY_BLOCK_IF_STRONG_BEARISH_FVVO, true),
  FIRST_ENTRY_BLOCK_IF_RECENT_BEARISH_RAY: b(process.env.FIRST_ENTRY_BLOCK_IF_RECENT_BEARISH_RAY, true),
  FIRST_ENTRY_RECENT_BEARISH_RAY_SEC: n(process.env.FIRST_ENTRY_RECENT_BEARISH_RAY_SEC, 300),
  FIRST_ENTRY_LOG_DEBUG: b(process.env.FIRST_ENTRY_LOG_DEBUG, true),

  // Post-exit continuation
  POST_EXIT_CONTINUATION_ENABLED: b(process.env.POST_EXIT_CONTINUATION_ENABLED, true),
  POST_EXIT_CONTINUATION_WINDOW_BARS: n(process.env.POST_EXIT_CONTINUATION_WINDOW_BARS, 8),
  POST_EXIT_CONTINUATION_MIN_PROFIT_EXIT_PCT: n(process.env.POST_EXIT_CONTINUATION_MIN_PROFIT_EXIT_PCT, 0.50),
  POST_EXIT_CONTINUATION_MIN_RSI: n(process.env.POST_EXIT_CONTINUATION_MIN_RSI, 55),
  POST_EXIT_CONTINUATION_MIN_ADX: n(process.env.POST_EXIT_CONTINUATION_MIN_ADX, 18),
  POST_EXIT_CONTINUATION_STRONG_MIN_RSI: n(process.env.POST_EXIT_CONTINUATION_STRONG_MIN_RSI, 64),
  POST_EXIT_CONTINUATION_STRONG_MIN_ADX: n(process.env.POST_EXIT_CONTINUATION_STRONG_MIN_ADX, 30),
  POST_EXIT_CONTINUATION_MAX_CHASE_PCT: n(process.env.POST_EXIT_CONTINUATION_MAX_CHASE_PCT, 0.38),
  POST_EXIT_CONTINUATION_STRONG_MAX_CHASE_PCT: n(process.env.POST_EXIT_CONTINUATION_STRONG_MAX_CHASE_PCT, 0.60),
  POST_EXIT_CONTINUATION_MAX_EXT_FROM_EMA18_PCT: n(process.env.POST_EXIT_CONTINUATION_MAX_EXT_FROM_EMA18_PCT, 1.25),
  POST_EXIT_CONTINUATION_REQUIRE_CLOSE_ABOVE_EMA8: b(process.env.POST_EXIT_CONTINUATION_REQUIRE_CLOSE_ABOVE_EMA8, false),
  POST_EXIT_CONTINUATION_MAX_BELOW_EMA8_PCT: n(process.env.POST_EXIT_CONTINUATION_MAX_BELOW_EMA8_PCT, 0.06),
  POST_EXIT_CONTINUATION_REQUIRE_EMA8_ABOVE_EMA18: b(process.env.POST_EXIT_CONTINUATION_REQUIRE_EMA8_ABOVE_EMA18, true),
  POST_EXIT_CONTINUATION_BLOCK_ON_BURST_BEARISH: b(process.env.POST_EXIT_CONTINUATION_BLOCK_ON_BURST_BEARISH, true),

  // v5.1 post-exit continuation profit guard
  POST_EXIT_CONT_PROFIT_GUARD_ENABLED: b(process.env.POST_EXIT_CONT_PROFIT_GUARD_ENABLED, true),
  POST_EXIT_CONT_PROFIT_GUARD_ARM_PEAK_PCT: n(process.env.POST_EXIT_CONT_PROFIT_GUARD_ARM_PEAK_PCT, 0.55),
  POST_EXIT_CONT_PROFIT_GUARD_LOCK_PCT: n(process.env.POST_EXIT_CONT_PROFIT_GUARD_LOCK_PCT, 0.45),
  POST_EXIT_CONT_PROFIT_GUARD_GIVEBACK_PCT: n(process.env.POST_EXIT_CONT_PROFIT_GUARD_GIVEBACK_PCT, 0.12),
  POST_EXIT_CONT_PROFIT_GUARD_MIN_CURRENT_PCT: n(process.env.POST_EXIT_CONT_PROFIT_GUARD_MIN_CURRENT_PCT, 0.20),
  POST_EXIT_CONT_PROFIT_GUARD_LOG: b(process.env.POST_EXIT_CONT_PROFIT_GUARD_LOG, true),

  PHASE2_REENTRY_ENABLED: b(process.env.PHASE2_REENTRY_ENABLED, true),
  MAX_REENTRIES_PER_BULL_REGIME: n(process.env.MAX_REENTRIES_PER_BULL_REGIME, 3),
  REENTRY_MIN_BARS_AFTER_EXIT: n(process.env.REENTRY_MIN_BARS_AFTER_EXIT, 1),
  REENTRY_WINDOW_BARS: n(process.env.REENTRY_WINDOW_BARS, 6),
  REENTRY_MIN_RESET_FROM_PEAK_PCT: n(process.env.REENTRY_MIN_RESET_FROM_PEAK_PCT, 0.15),
  FAST_REENTRY_MIN_RESET_FROM_PEAK_PCT: n(process.env.FAST_REENTRY_MIN_RESET_FROM_PEAK_PCT, 0.20),
  REENTRY_REQUIRE_CLOSE_ABOVE_EMA8: b(process.env.REENTRY_REQUIRE_CLOSE_ABOVE_EMA8, true),
  REENTRY_MAX_CHASE_PCT: n(process.env.REENTRY_MAX_CHASE_PCT, 0.20),
  FAST_REENTRY_MAX_CHASE_PCT: n(process.env.FAST_REENTRY_MAX_CHASE_PCT, 0.18),
  FAST_REENTRY_MIN_RSI: n(process.env.FAST_REENTRY_MIN_RSI, 50),
  FAST_REENTRY_MIN_ADX: n(process.env.FAST_REENTRY_MIN_ADX, 14),
  STRONG_REENTRY_OVERRIDE_ENABLED: b(process.env.STRONG_REENTRY_OVERRIDE_ENABLED, true),
  STRONG_REENTRY_MIN_RSI: n(process.env.STRONG_REENTRY_MIN_RSI, 60),
  STRONG_REENTRY_MIN_ADX: n(process.env.STRONG_REENTRY_MIN_ADX, 30),
  STRONG_REENTRY_MAX_CHASE_PCT: n(process.env.STRONG_REENTRY_MAX_CHASE_PCT, 0.38),

  HARD_STOP_PCT: n(process.env.HARD_STOP_PCT, 0.80),
  BREAKEVEN_ARM_PCT: n(process.env.BREAKEVEN_ARM_PCT, 0.40),
  BREAKEVEN_OFFSET_PCT: n(process.env.BREAKEVEN_OFFSET_PCT, 0.05),

  DYNAMIC_TP_ENABLED: b(process.env.DYNAMIC_TP_ENABLED, true),
  DTP_TIER1_ARM_PCT: n(process.env.DTP_TIER1_ARM_PCT, 0.60),
  DTP_TIER1_GIVEBACK_PCT: n(process.env.DTP_TIER1_GIVEBACK_PCT, 0.35),
  DTP_TIER2_ARM_PCT: n(process.env.DTP_TIER2_ARM_PCT, 1.20),
  DTP_TIER2_GIVEBACK_PCT: n(process.env.DTP_TIER2_GIVEBACK_PCT, 0.22),
  DTP_TIER3_ARM_PCT: n(process.env.DTP_TIER3_ARM_PCT, 1.80),
  DTP_TIER3_GIVEBACK_PCT: n(process.env.DTP_TIER3_GIVEBACK_PCT, 0.12),

  REENTRY_TOP_HARVEST_ENABLED: b(process.env.REENTRY_TOP_HARVEST_ENABLED, true),
  REENTRY_TOP_HARVEST_MIN_PROFIT_PCT: n(process.env.REENTRY_TOP_HARVEST_MIN_PROFIT_PCT, 0.55),
  REENTRY_TOP_HARVEST_SOFT_MIN_PROFIT_PCT: n(process.env.REENTRY_TOP_HARVEST_SOFT_MIN_PROFIT_PCT, 0.50),
  REENTRY_TOP_HARVEST_SOFT_MIN_PEAK_PROFIT_PCT: n(process.env.REENTRY_TOP_HARVEST_SOFT_MIN_PEAK_PROFIT_PCT, 0.58),
  REENTRY_TOP_HARVEST_SOFT_MIN_ADX: n(process.env.REENTRY_TOP_HARVEST_SOFT_MIN_ADX, 30),
  REENTRY_TOP_HARVEST_SOFT_MIN_EXT_FROM_EMA8_PCT: n(process.env.REENTRY_TOP_HARVEST_SOFT_MIN_EXT_FROM_EMA8_PCT, 0.30),
  REENTRY_TOP_HARVEST_SOFT_MIN_EXT_FROM_EMA18_PCT: n(process.env.REENTRY_TOP_HARVEST_SOFT_MIN_EXT_FROM_EMA18_PCT, 0.50),
  REENTRY_TOP_HARVEST_LOG_DEBUG: b(process.env.REENTRY_TOP_HARVEST_LOG_DEBUG, true),
};
// -----------------------------
// Runtime state
// -----------------------------
const S = {
  startedAt: isoNow(),

  lastTick: null,
  lastFeature: null,
  lastRay: null,
  lastFvvo: null,

  barIndex: 0,
  lastBarKey: null,

  bullRegime: false,
  bullRegimeStartedAt: null,
  bullRegimeEntryCount: 0,

  inPosition: false,
  position: null,

  lastEnterAtMs: 0,
  lastExitAtMs: 0,

  lastBullishRayAtMs: 0,
  lastBearishRayAtMs: 0,

  firstEntryConfirm: null,

  lastProfitExit: null,
  postExitContinuation: null,

  reentriesThisBullRegime: 0,

  stats: {
    ticks: 0,
    features: 0,
    rays: 0,
    fvvo: 0,
    enterAllowed: 0,
    enterBlocked: 0,
    exitAllowed: 0,
    exitBlocked: 0,
    forwardedOk: 0,
    forwardedFail: 0,
  },
};

// -----------------------------
// Logging
// -----------------------------
function log(label, obj = {}) {
  const line = `${isoNow()} ${label} | ${JSON.stringify(obj)}`;
  console.log(line);
}

function debug(label, obj = {}) {
  if (CONFIG.DEBUG) log(label, obj);
}

function configSnapshot() {
  return {
    brain: CONFIG.BRAIN_NAME,
    port: CONFIG.PORT,
    path: CONFIG.WEBHOOK_PATH,
    symbol: CONFIG.SYMBOL,
    tf: CONFIG.ENTRY_TF,
    enableHttpForward: CONFIG.ENABLE_HTTP_FORWARD,
    replayAllowStaleData: CONFIG.REPLAY_ALLOW_STALE_DATA,
    replayUseEventTimeForPositionClock: CONFIG.REPLAY_USE_EVENT_TIME_FOR_POSITION_CLOCK,

    firstEntry: {
      enabled: CONFIG.FIRST_ENTRY_ENGINE_ENABLED,
      immediateMaxChasePct: CONFIG.FIRST_ENTRY_IMMEDIATE_MAX_CHASE_PCT,
      immediateMinRsi: CONFIG.FIRST_ENTRY_IMMEDIATE_MIN_RSI,
      immediateMinAdx: CONFIG.FIRST_ENTRY_IMMEDIATE_MIN_ADX,
      confirmEnabled: CONFIG.FIRST_ENTRY_CONFIRM_ENABLED,
      confirmWindowSec: CONFIG.FIRST_ENTRY_CONFIRM_WINDOW_SEC,
      weakBlockEnabled: CONFIG.FIRST_ENTRY_WEAK_BLOCK_ENABLED,
    },

    postExitProfitGuard: {
      enabled: CONFIG.POST_EXIT_CONT_PROFIT_GUARD_ENABLED,
      armPeakPct: CONFIG.POST_EXIT_CONT_PROFIT_GUARD_ARM_PEAK_PCT,
      lockPct: CONFIG.POST_EXIT_CONT_PROFIT_GUARD_LOCK_PCT,
      givebackPct: CONFIG.POST_EXIT_CONT_PROFIT_GUARD_GIVEBACK_PCT,
      minCurrentPct: CONFIG.POST_EXIT_CONT_PROFIT_GUARD_MIN_CURRENT_PCT,
    },
  };
}

// -----------------------------
// Payload classification
// -----------------------------
function payloadSecret(payload) {
  return String(
    payload?.secret ??
      payload?.tv_secret ??
      payload?.webhook_secret ??
      payload?.tickrouter_secret ??
      ""
  );
}

function checkSecret(payload) {
  const expected = CONFIG.WEBHOOK_SECRET || CONFIG.TICKROUTER_SECRET;
  if (!expected) return true;

  const got = payloadSecret(payload);
  return got === expected;
}

function payloadSymbol(payload) {
  return normalizeSymbol(
    payload?.symbol ??
      payload?.ticker ??
      payload?.tv_symbol ??
      payload?.tv_instrument ??
      CONFIG.SYMBOL
  );
}

function payloadTf(payload) {
  return String(payload?.tf ?? payload?.timeframe ?? payload?.interval ?? CONFIG.ENTRY_TF);
}

function payloadPrice(payload) {
  const v = pickFirst(payload, [
    "price",
    "trigger_price",
    "close",
    "last",
    "markPrice",
    "p",
  ]);
  return n(v, NaN);
}

function payloadTime(payload) {
  return String(payload?.time ?? payload?.timestamp ?? payload?.event_time ?? isoNow());
}

function payloadSrc(payload) {
  const src = String(payload?.src ?? payload?.source ?? "").toLowerCase();

  if (src) return src;

  const action = String(payload?.action ?? payload?.event ?? "").toLowerCase();

  if (action.includes("bullish") || action.includes("bearish")) return "ray";
  if (payload?.ema8 !== undefined || payload?.rsi !== undefined || payload?.adx !== undefined) return "features";
  if (payload?.price !== undefined || payload?.p !== undefined) return "tick";

  return "unknown";
}

function payloadAction(payload) {
  return String(payload?.action ?? payload?.event ?? payload?.signal ?? "").trim();
}

function isBullishTrendChange(action) {
  const a = String(action || "").toLowerCase();
  return (
    a === "buy" ||
    a === "enter_long" ||
    a.includes("bullishtrendchange") ||
    a.includes("bullish_trend_change") ||
    a.includes("bullish trend change") ||
    a.includes("bullish")
  );
}

function isBearishTrendChange(action) {
  const a = String(action || "").toLowerCase();
  return (
    a === "sell" ||
    a === "exit_long" ||
    a.includes("bearishtrendchange") ||
    a.includes("bearish_trend_change") ||
    a.includes("bearish trend change") ||
    a.includes("bearish")
  );
}

// -----------------------------
// Feature normalization
// -----------------------------
function normalizeFeature(payload) {
  const close = n(payload.close ?? payload.price ?? payload.trigger_price, NaN);
  const open = n(payload.open, close);
  const high = n(payload.high, maxFinite(open, close));
  const low = n(payload.low, Math.min(open, close));

  return {
    src: "features",
    symbol: payloadSymbol(payload),
    tf: payloadTf(payload),
    time: payloadTime(payload),

    open,
    high,
    low,
    close,

    ema8: n(payload.ema8, NaN),
    ema18: n(payload.ema18 ?? payload.ema21, NaN),
    ema50: n(payload.ema50, NaN),

    rsi: n(payload.rsi, NaN),
    adx: n(payload.adx, NaN),
    atr: n(payload.atr, NaN),
    atrPct: n(payload.atrPct, NaN),

    oiTrend: n(payload.oiTrend, 0),
    oiDeltaBias: n(payload.oiDeltaBias, 0),
    cvdTrend: n(payload.cvdTrend, 0),

    fvvo: String(payload.fvvo ?? payload.fvvoState ?? "").toLowerCase(),
    burst: String(payload.burst ?? payload.burstState ?? "").toLowerCase(),

    barKey: barKeyFromTime(payloadTime(payload), n(payloadTf(payload), 5)),
  };
}

function featureContext(feature = S.lastFeature) {
  const f = feature || {};
  const close = n(f.close, NaN);
  const ema8 = n(f.ema8, NaN);
  const ema18 = n(f.ema18, NaN);
  const ema50 = n(f.ema50, NaN);

  return {
    close,
    ema8,
    ema18,
    ema50,
    rsi: n(f.rsi, NaN),
    adx: n(f.adx, NaN),
    atrPct: n(f.atrPct, NaN),

    closeAboveEma8:
      Number.isFinite(close) && Number.isFinite(ema8) ? close >= ema8 : false,
    ema8AboveEma18:
      Number.isFinite(ema8) && Number.isFinite(ema18) ? ema8 >= ema18 : false,
    ema18AboveEma50:
      Number.isFinite(ema18) && Number.isFinite(ema50) ? ema18 >= ema50 : false,

    extFromEma8Pct:
      Number.isFinite(close) && Number.isFinite(ema8) ? pctDiff(ema8, close) : 0,
    extFromEma18Pct:
      Number.isFinite(close) && Number.isFinite(ema18) ? pctDiff(ema18, close) : 0,
    belowEma8Pct:
      Number.isFinite(close) && Number.isFinite(ema8) && close < ema8
        ? Math.abs(pctDiff(ema8, close))
        : 0,

    bullishFlow:
      n(f.oiTrend, 0) > 0 || n(f.oiDeltaBias, 0) > 0 || n(f.cvdTrend, 0) > 0,

    bearishFlow:
      n(f.oiTrend, 0) < 0 || n(f.oiDeltaBias, 0) < 0 || n(f.cvdTrend, 0) < 0,

    fvvo: String(f.fvvo || "").toLowerCase(),
    burst: String(f.burst || "").toLowerCase(),
  };
}

function fvvoBearish(feature = S.lastFeature) {
  const f = featureContext(feature);
  return (
    f.fvvo.includes("bear") ||
    f.burst.includes("bear") ||
    f.bearishFlow
  );
}

function fvvoBullish(feature = S.lastFeature) {
  const f = featureContext(feature);
  return (
    f.fvvo.includes("bull") ||
    f.burst.includes("bull") ||
    f.bullishFlow
  );
}

// -----------------------------
// 3Commas forwarding
// -----------------------------
function botUuidForSymbol(symbol) {
  const sym = normalizeSymbol(symbol || CONFIG.SYMBOL);
  return CONFIG.SYMBOL_BOT_MAP?.[sym] || CONFIG.SYMBOL_BOT_MAP?.[sym.replace("BINANCE:", "")] || "";
}

async function postJsonWithTimeout(url, body, timeoutMs) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, body: text };
  } finally {
    clearTimeout(to);
  }
}

async function forwardTo3Commas(action, price, eventIso, reason = "") {
  if (!CONFIG.ENABLE_HTTP_FORWARD) {
    debug("🧪 FORWARD_SKIPPED_REPLAY", {
      action,
      price: round4(price),
      reason,
      enableHttpForward: CONFIG.ENABLE_HTTP_FORWARD,
    });
    return { ok: true, skipped: true };
  }

  const botUuid = botUuidForSymbol(CONFIG.SYMBOL);
  if (!CONFIG.C3_SIGNAL_URL || !CONFIG.C3_SIGNAL_SECRET || !botUuid) {
    S.stats.forwardedFail += 1;
    log("❌ FORWARD_CONFIG_MISSING", {
      hasUrl: Boolean(CONFIG.C3_SIGNAL_URL),
      hasSecret: Boolean(CONFIG.C3_SIGNAL_SECRET),
      hasBotUuid: Boolean(botUuid),
      action,
      reason,
    });
    return { ok: false, error: "forward_config_missing" };
  }

  const parts = symbolParts(CONFIG.SYMBOL);

  const body = {
    secret: CONFIG.C3_SIGNAL_SECRET,
    max_lag: CONFIG.MAX_LAG_SEC,
    timestamp: eventIso || isoNow(),
    trigger_price: String(price),
    tv_exchange: parts.tv_exchange,
    tv_instrument: parts.tv_instrument,
    action,
    bot_uuid: botUuid,
  };

  try {
    const res = await postJsonWithTimeout(CONFIG.C3_SIGNAL_URL, body, CONFIG.C3_TIMEOUT_MS);

    if (res.ok) {
      S.stats.forwardedOk += 1;
      log("✅ FORWARDED_OK", {
        action,
        price: round4(price),
        status: res.status,
        reason,
      });
    } else {
      S.stats.forwardedFail += 1;
      log("❌ FORWARDED_FAIL", {
        action,
        price: round4(price),
        status: res.status,
        body: res.body?.slice?.(0, 250),
        reason,
      });
    }

    return res;
  } catch (err) {
    S.stats.forwardedFail += 1;
    log("❌ FORWARDED_ERROR", {
      action,
      price: round4(price),
      reason,
      error: err?.message || String(err),
    });
    return { ok: false, error: err?.message || String(err) };
  }
}

// -----------------------------
// Entry / exit execution
// -----------------------------
async function doEnter(mode, price, eventIso, meta = {}) {
  const p = n(price, NaN);
  if (!Number.isFinite(p) || p <= 0) {
    S.stats.enterBlocked += 1;
    log("⛔ ENTER_BLOCKED_BAD_PRICE", { mode, price });
    return { ok: false, reason: "bad_price" };
  }

  if (S.inPosition) {
    S.stats.enterBlocked += 1;
    log("⛔ ENTER_BLOCKED_ALREADY_IN_POSITION", {
      mode,
      price: round4(p),
      currentMode: S.position?.mode,
    });
    return { ok: false, reason: "already_in_position" };
  }

  const now = nowMs();
  const dedupMs = isReentryHarvestMode(mode) ? CONFIG.REENTRY_ENTER_DEDUP_MS : CONFIG.ENTER_DEDUP_MS;

  if (now - S.lastEnterAtMs < dedupMs) {
    S.stats.enterBlocked += 1;
    log("⛔ ENTER_BLOCKED_DEDUP", {
      mode,
      price: round4(p),
      msSinceLastEnter: now - S.lastEnterAtMs,
      dedupMs,
    });
    return { ok: false, reason: "enter_dedup" };
  }

  S.inPosition = true;
  S.position = {
    mode,
    entryPrice: p,
    entryTime: eventIso || isoNow(),
    entryMs: CONFIG.REPLAY_USE_EVENT_TIME_FOR_POSITION_CLOCK
      ? parseTimeMs(eventIso) ?? now
      : now,
    peakPrice: p,
    peakPnlPct: 0,
    lowPrice: p,
    currentPnlPct: 0,
    breakevenArmed: false,
    dynamicTpTier: 0,
    meta,
  };

  S.lastEnterAtMs = now;
  S.stats.enterAllowed += 1;

  if (S.bullRegime) {
    S.bullRegimeEntryCount += 1;
  }

  if (isReentryHarvestMode(mode)) {
    S.reentriesThisBullRegime += 1;
  }

  S.firstEntryConfirm = null;

  log("📥 ENTER", {
    mode,
    price: round4(p),
    eventIso,
    barIndex: S.barIndex,
    meta,
  });

  await forwardTo3Commas("enter_long", p, eventIso || isoNow(), mode);

  return { ok: true, mode, price: p };
}

async function doExit(reason, price, eventIso, exitType = "cycle_exit") {
  const p = n(price, NaN);

  if (!S.inPosition || !S.position) {
    S.stats.exitBlocked += 1;
    log("⛔ EXIT_BLOCKED_NOT_IN_POSITION", {
      reason,
      price: round4(p),
    });
    return { ok: false, reason: "not_in_position" };
  }

  if (!Number.isFinite(p) || p <= 0) {
    S.stats.exitBlocked += 1;
    log("⛔ EXIT_BLOCKED_BAD_PRICE", { reason, price });
    return { ok: false, reason: "bad_price" };
  }

  const now = nowMs();

  if (now - S.lastExitAtMs < CONFIG.EXIT_DEDUP_MS) {
    S.stats.exitBlocked += 1;
    log("⛔ EXIT_BLOCKED_DEDUP", {
      reason,
      price: round4(p),
      msSinceLastExit: now - S.lastExitAtMs,
      exitDedupMs: CONFIG.EXIT_DEDUP_MS,
    });
    return { ok: false, reason: "exit_dedup" };
  }

  const pos = S.position;
  const pnlPct = pctDiff(pos.entryPrice, p);
  const peakPnlPct = n(pos.peakPnlPct, pnlPct);

  log("📤 EXIT", {
    reason,
    exitType,
    mode: pos.mode,
    entryPrice: round4(pos.entryPrice),
    exitPrice: round4(p),
    pnlPct: round4(pnlPct),
    peakPnlPct: round4(peakPnlPct),
    eventIso,
    barIndex: S.barIndex,
  });

  await forwardTo3Commas("exit_long", p, eventIso || isoNow(), reason);

  S.inPosition = false;
  S.position = null;
  S.lastExitAtMs = now;
  S.stats.exitAllowed += 1;

  if (pnlPct > 0) {
    S.lastProfitExit = {
      reason,
      exitType,
      exitPrice: p,
      exitTime: eventIso || isoNow(),
      exitBarIndex: S.barIndex,
      pnlPct,
      peakPnlPct,
      mode: pos.mode,
    };

    armPostExitContinuation(S.lastProfitExit);
  }

  return { ok: true, reason, price: p, pnlPct };
}

// -----------------------------
// Position update and exits
// -----------------------------
function positionAgeMin(eventIso = isoNow()) {
  if (!S.position) return 0;

  const eventMs = CONFIG.REPLAY_USE_EVENT_TIME_FOR_POSITION_CLOCK
    ? parseTimeMs(eventIso) ?? nowMs()
    : nowMs();

  return Math.max(0, (eventMs - n(S.position.entryMs, eventMs)) / 60000);
}

function updatePositionStats(price) {
  if (!S.inPosition || !S.position) return null;

  const p = n(price, NaN);
  if (!Number.isFinite(p) || p <= 0) return null;

  const pos = S.position;

  pos.peakPrice = Math.max(n(pos.peakPrice, p), p);
  pos.lowPrice = Math.min(n(pos.lowPrice, p), p);
  pos.currentPnlPct = pctDiff(pos.entryPrice, p);
  pos.peakPnlPct = Math.max(n(pos.peakPnlPct, pos.currentPnlPct), pos.currentPnlPct);

  return pos;
}

function dynamicTpReason(pos) {
  if (!CONFIG.DYNAMIC_TP_ENABLED || !pos) return null;

  const pnlPct = n(pos.currentPnlPct, 0);
  const peak = n(pos.peakPnlPct, pnlPct);
  const giveback = peak - pnlPct;

  if (peak >= CONFIG.DTP_TIER3_ARM_PCT) {
    pos.dynamicTpTier = Math.max(n(pos.dynamicTpTier, 0), 3);
    if (giveback >= CONFIG.DTP_TIER3_GIVEBACK_PCT) {
      return "dynamic_tp_tier3_giveback";
    }
  }

  if (peak >= CONFIG.DTP_TIER2_ARM_PCT) {
    pos.dynamicTpTier = Math.max(n(pos.dynamicTpTier, 0), 2);
    if (giveback >= CONFIG.DTP_TIER2_GIVEBACK_PCT) {
      return "dynamic_tp_tier2_giveback";
    }
  }

  if (peak >= CONFIG.DTP_TIER1_ARM_PCT) {
    pos.dynamicTpTier = Math.max(n(pos.dynamicTpTier, 0), 1);
    if (giveback >= CONFIG.DTP_TIER1_GIVEBACK_PCT) {
      return "dynamic_tp_tier1_giveback";
    }
  }

  return null;
}

function stopReason(pos, price) {
  if (!pos) return null;

  const pnlPct = n(pos.currentPnlPct, pctDiff(pos.entryPrice, price));

  if (pnlPct <= -Math.abs(CONFIG.HARD_STOP_PCT)) {
    return "hard_stop";
  }

  if (!pos.breakevenArmed && n(pos.peakPnlPct, 0) >= CONFIG.BREAKEVEN_ARM_PCT) {
    pos.breakevenArmed = true;
    log("🟢 BREAKEVEN_ARMED", {
      mode: pos.mode,
      entryPrice: round4(pos.entryPrice),
      peakPrice: round4(pos.peakPrice),
      peakPnlPct: round4(pos.peakPnlPct),
    });
  }

  if (pos.breakevenArmed && pnlPct <= CONFIG.BREAKEVEN_OFFSET_PCT) {
    return "hard_or_breakeven_stop";
  }

  return null;
}

function shouldPostExitContinuationProfitGuardExit(price, eventIso = isoNow()) {
  if (!CONFIG.POST_EXIT_CONT_PROFIT_GUARD_ENABLED) return { allow: false };
  if (!S.inPosition || !S.position) return { allow: false };
  if (!isPostExitContinuationMode(S.position.mode)) return { allow: false };

  const pos = updatePositionStats(price) || S.position;
  const pnlPct = n(pos.currentPnlPct, pctDiff(pos.entryPrice, price));
  const peakPnlPct = n(pos.peakPnlPct, pnlPct);
  const givebackPct = Math.max(0, peakPnlPct - pnlPct);

  const armed = peakPnlPct >= CONFIG.POST_EXIT_CONT_PROFIT_GUARD_ARM_PEAK_PCT;
  const lockHit = armed && pnlPct <= CONFIG.POST_EXIT_CONT_PROFIT_GUARD_LOCK_PCT;
  const givebackHit = armed && givebackPct >= CONFIG.POST_EXIT_CONT_PROFIT_GUARD_GIVEBACK_PCT;
  const emergencyHit = armed && pnlPct <= CONFIG.POST_EXIT_CONT_PROFIT_GUARD_MIN_CURRENT_PCT;

  if (CONFIG.POST_EXIT_CONT_PROFIT_GUARD_LOG) {
    log("🟪 POST_EXIT_CONT_PROFIT_GUARD_CHECK", {
      mode: pos.mode,
      price: round4(price),
      entryPrice: round4(pos.entryPrice),
      pnlPct: round4(pnlPct),
      peakPnlPct: round4(peakPnlPct),
      givebackPct: round4(givebackPct),
      armed,
      lockHit,
      givebackHit,
      emergencyHit,
      eventIso,
    });
  }

  if (emergencyHit) {
    return {
      allow: true,
      reason: "post_exit_cont_profit_guard_emergency",
      pnlPct,
      peakPnlPct,
      givebackPct,
    };
  }

  if (givebackHit) {
    return {
      allow: true,
      reason: "post_exit_cont_profit_guard_giveback",
      pnlPct,
      peakPnlPct,
      givebackPct,
    };
  }

  if (lockHit) {
    return {
      allow: true,
      reason: "post_exit_cont_profit_guard_lock",
      pnlPct,
      peakPnlPct,
      givebackPct,
    };
  }

  return { allow: false, pnlPct, peakPnlPct, givebackPct };
}

async function updatePositionFromTick(price, eventIso = isoNow()) {
  if (!S.inPosition || !S.position) return;

  const p = n(price, NaN);
  if (!Number.isFinite(p) || p <= 0) return;

  const pos = updatePositionStats(p);

  const postExitGuard = shouldPostExitContinuationProfitGuardExit(p, eventIso);
  if (postExitGuard.allow) {
    await doExit(postExitGuard.reason, p, eventIso, "cycle_exit");
    return;
  }

  const dynamicReason = dynamicTpReason(pos);
  if (dynamicReason) {
    await doExit(dynamicReason, p, eventIso, "cycle_exit");
    return;
  }

  const sr = stopReason(pos, p);
  if (sr) {
    await doExit(sr, p, eventIso, "cycle_exit");
  }
}

// -----------------------------
// First Bullish Trend Change engine
// -----------------------------
function recentBearishRayWithin(sec) {
  if (!S.lastBearishRayAtMs) return false;
  return nowMs() - S.lastBearishRayAtMs <= sec * 1000;
}

function evaluateFirstBullishTrendChangeEntry(rayPrice, feature = S.lastFeature) {
  const price = n(rayPrice, NaN);
  const f = featureContext(feature);

  const reasons = [];
  const redFlags = [];

  if (!Number.isFinite(price) || price <= 0) {
    return { decision: "block", reason: "bad_ray_price", redFlags: ["bad_price"] };
  }

  const close = Number.isFinite(f.close) ? f.close : price;

  const chasePct = pctDiff(price, close);
  const extEma18Pct = f.extFromEma18Pct;

  reasonPush(redFlags, Number.isFinite(f.rsi) && f.rsi < CONFIG.FIRST_ENTRY_BLOCK_RSI_BELOW, "rsi_too_low");
  reasonPush(redFlags, Number.isFinite(f.adx) && f.adx < CONFIG.FIRST_ENTRY_BLOCK_ADX_BELOW, "adx_too_low");
  reasonPush(redFlags, chasePct > CONFIG.FIRST_ENTRY_BLOCK_MAX_CHASE_PCT, "chase_too_high");
  reasonPush(redFlags, extEma18Pct > CONFIG.FIRST_ENTRY_BLOCK_MAX_EXT_EMA18_PCT, "ema18_extension_too_high");
  reasonPush(
    redFlags,
    CONFIG.FIRST_ENTRY_BLOCK_IF_EMA8_BELOW_EMA18 && !f.ema8AboveEma18,
    "ema8_below_ema18"
  );
  reasonPush(
    redFlags,
    CONFIG.FIRST_ENTRY_BLOCK_IF_CLOSE_BELOW_EMA8 && !f.closeAboveEma8,
    "close_below_ema8"
  );
  reasonPush(
    redFlags,
    CONFIG.FIRST_ENTRY_BLOCK_IF_STRONG_BEARISH_FVVO && fvvoBearish(feature),
    "bearish_fvvo_or_flow"
  );
  reasonPush(
    redFlags,
    CONFIG.FIRST_ENTRY_BLOCK_IF_RECENT_BEARISH_RAY &&
      recentBearishRayWithin(CONFIG.FIRST_ENTRY_RECENT_BEARISH_RAY_SEC),
    "recent_bearish_ray"
  );

  const weakBlock =
    CONFIG.FIRST_ENTRY_WEAK_BLOCK_ENABLED &&
    redFlags.length >= CONFIG.FIRST_ENTRY_BLOCK_MIN_RED_FLAGS;

  if (weakBlock) {
    return {
      decision: "block",
      reason: "first_entry_weak_block",
      redFlags,
      metrics: {
        rayPrice: round4(price),
        close: round4(close),
        chasePct: round4(chasePct),
        extEma18Pct: round4(extEma18Pct),
        rsi: round4(f.rsi),
        adx: round4(f.adx),
        ema8AboveEma18: f.ema8AboveEma18,
        closeAboveEma8: f.closeAboveEma8,
      },
    };
  }

  const immediateOk =
    (!CONFIG.FIRST_ENTRY_REQUIRE_EMA8_ABOVE_EMA18 || f.ema8AboveEma18) &&
    (!CONFIG.FIRST_ENTRY_REQUIRE_CLOSE_ABOVE_EMA8 || f.closeAboveEma8) &&
    Number.isFinite(f.rsi) &&
    f.rsi >= CONFIG.FIRST_ENTRY_IMMEDIATE_MIN_RSI &&
    Number.isFinite(f.adx) &&
    f.adx >= CONFIG.FIRST_ENTRY_IMMEDIATE_MIN_ADX &&
    chasePct <= CONFIG.FIRST_ENTRY_IMMEDIATE_MAX_CHASE_PCT &&
    extEma18Pct <= CONFIG.FIRST_ENTRY_IMMEDIATE_MAX_EXT_EMA18_PCT;

  if (immediateOk) {
    return {
      decision: "enter",
      mode: "first_bullish_trend_change_immediate_long",
      reason: "first_entry_immediate_ok",
      redFlags,
      metrics: {
        rayPrice: round4(price),
        close: round4(close),
        chasePct: round4(chasePct),
        extEma18Pct: round4(extEma18Pct),
        rsi: round4(f.rsi),
        adx: round4(f.adx),
        ema8AboveEma18: f.ema8AboveEma18,
        closeAboveEma8: f.closeAboveEma8,
      },
    };
  }

  const closeNearEma8 =
    f.closeAboveEma8 ||
    (CONFIG.FIRST_ENTRY_CONFIRM_ALLOW_CLOSE_NEAR_EMA8 &&
      f.belowEma8Pct <= CONFIG.FIRST_ENTRY_CONFIRM_MAX_BELOW_EMA8_PCT);

  const confirmOk =
    CONFIG.FIRST_ENTRY_CONFIRM_ENABLED &&
    closeNearEma8 &&
    f.ema8AboveEma18 &&
    Number.isFinite(f.rsi) &&
    f.rsi >= CONFIG.FIRST_ENTRY_CONFIRM_MIN_RSI &&
    Number.isFinite(f.adx) &&
    f.adx >= CONFIG.FIRST_ENTRY_CONFIRM_MIN_ADX &&
    chasePct <= CONFIG.FIRST_ENTRY_CONFIRM_MAX_CHASE_PCT;

  if (confirmOk) {
    return {
      decision: "confirm",
      mode: "first_bullish_trend_change_confirmed_long",
      reason: "first_entry_confirm_window_armed",
      redFlags,
      metrics: {
        rayPrice: round4(price),
        close: round4(close),
        chasePct: round4(chasePct),
        extEma18Pct: round4(extEma18Pct),
        rsi: round4(f.rsi),
        adx: round4(f.adx),
        ema8AboveEma18: f.ema8AboveEma18,
        closeAboveEma8: f.closeAboveEma8,
        belowEma8Pct: round4(f.belowEma8Pct),
      },
    };
  }

  reasons.push("first_entry_conditions_not_enough");

  return {
    decision: "block",
    reason: reasons.join(","),
    redFlags,
    metrics: {
      rayPrice: round4(price),
      close: round4(close),
      chasePct: round4(chasePct),
      extEma18Pct: round4(extEma18Pct),
      rsi: round4(f.rsi),
      adx: round4(f.adx),
      ema8AboveEma18: f.ema8AboveEma18,
      closeAboveEma8: f.closeAboveEma8,
      belowEma8Pct: round4(f.belowEma8Pct),
    },
  };
}

function armFirstEntryConfirm(rayPrice, eventIso, decision) {
  const price = n(rayPrice, NaN);
  if (!Number.isFinite(price) || price <= 0) return;

  S.firstEntryConfirm = {
    armedAtMs: nowMs(),
    expiresAtMs: nowMs() + CONFIG.FIRST_ENTRY_CONFIRM_WINDOW_SEC * 1000,
    rayPrice: price,
    eventIso: eventIso || isoNow(),
    mode: decision.mode || "first_bullish_trend_change_confirmed_long",
    ticksConfirmed: 0,
    lastConfirmPrice: null,
    metrics: decision.metrics || {},
  };

  log("🟨 FIRST_ENTRY_CONFIRM_ARMED", {
    rayPrice: round4(price),
    expiresInSec: CONFIG.FIRST_ENTRY_CONFIRM_WINDOW_SEC,
    metrics: decision.metrics || {},
    redFlags: decision.redFlags || [],
  });
}

async function maybeTriggerFirstEntryConfirmFromTick(price, eventIso = isoNow()) {
  const c = S.firstEntryConfirm;
  if (!c || S.inPosition) return;

  if (nowMs() > c.expiresAtMs) {
    log("⌛ FIRST_ENTRY_CONFIRM_EXPIRED", {
      rayPrice: round4(c.rayPrice),
      ticksConfirmed: c.ticksConfirmed,
    });
    S.firstEntryConfirm = null;
    return;
  }

  const p = n(price, NaN);
  if (!Number.isFinite(p) || p <= 0) return;

  const confirmMovePct = pctDiff(c.rayPrice, p);
  const hit = confirmMovePct >= CONFIG.FIRST_ENTRY_CONFIRM_TICK_CONFIRM_PCT;

  if (hit) {
    c.ticksConfirmed += 1;
    c.lastConfirmPrice = p;
  }

  debug("🟨 FIRST_ENTRY_CONFIRM_TICK", {
    price: round4(p),
    rayPrice: round4(c.rayPrice),
    confirmMovePct: round4(confirmMovePct),
    ticksConfirmed: c.ticksConfirmed,
    requiredTicks: CONFIG.FIRST_ENTRY_CONFIRM_MIN_TICKS,
  });

  if (c.ticksConfirmed >= CONFIG.FIRST_ENTRY_CONFIRM_MIN_TICKS) {
    await doEnter(c.mode, p, eventIso, {
      trigger: "tick_confirm",
      rayPrice: c.rayPrice,
      confirmMovePct,
      firstEntryMetrics: c.metrics,
    });
  }
}

// -----------------------------
// Post-exit continuation / re-entry
// -----------------------------
function armPostExitContinuation(exitInfo) {
  if (!CONFIG.POST_EXIT_CONTINUATION_ENABLED) return;
  if (!exitInfo || n(exitInfo.pnlPct, 0) < CONFIG.POST_EXIT_CONTINUATION_MIN_PROFIT_EXIT_PCT) return;

  S.postExitContinuation = {
    armed: true,
    exitPrice: n(exitInfo.exitPrice, NaN),
    exitBarIndex: n(exitInfo.exitBarIndex, S.barIndex),
    exitTime: exitInfo.exitTime || isoNow(),
    eligibleFromBar: n(exitInfo.exitBarIndex, S.barIndex) + 1,
    eligibleUntilBar:
      n(exitInfo.exitBarIndex, S.barIndex) + CONFIG.POST_EXIT_CONTINUATION_WINDOW_BARS,
    pnlPct: n(exitInfo.pnlPct, 0),
    peakPnlPct: n(exitInfo.peakPnlPct, 0),
    exitReason: exitInfo.reason,
    used: false,
  };

  log("🟦 POST_EXIT_CONTINUATION_ARMED", {
    exitPrice: round4(S.postExitContinuation.exitPrice),
    exitBarIndex: S.postExitContinuation.exitBarIndex,
    eligibleFromBar: S.postExitContinuation.eligibleFromBar,
    eligibleUntilBar: S.postExitContinuation.eligibleUntilBar,
    pnlPct: round4(S.postExitContinuation.pnlPct),
    peakPnlPct: round4(S.postExitContinuation.peakPnlPct),
    exitReason: S.postExitContinuation.exitReason,
  });
}

function postExitContinuationExpired() {
  const c = S.postExitContinuation;
  if (!c || !c.armed || c.used) return true;
  return S.barIndex > c.eligibleUntilBar;
}

function evaluatePostExitContinuation(feature = S.lastFeature) {
  const c = S.postExitContinuation;
  if (!CONFIG.POST_EXIT_CONTINUATION_ENABLED) return { allow: false, reason: "disabled" };
  if (!c || !c.armed || c.used) return { allow: false, reason: "not_armed" };
  if (S.inPosition) return { allow: false, reason: "in_position" };

  if (S.barIndex < c.eligibleFromBar) {
    return {
      allow: false,
      reason: "too_early",
      barIndex: S.barIndex,
      eligibleFromBar: c.eligibleFromBar,
    };
  }

  if (S.barIndex > c.eligibleUntilBar) {
    log("⌛ POST_EXIT_CONTINUATION_EXPIRED", {
      barIndex: S.barIndex,
      eligibleUntilBar: c.eligibleUntilBar,
    });
    c.armed = false;
    return { allow: false, reason: "expired" };
  }

  const f = featureContext(feature);
  const price = n(feature?.close, NaN);

  if (!Number.isFinite(price) || price <= 0) {
    return { allow: false, reason: "bad_price" };
  }

  const chasePct = pctDiff(c.exitPrice, price);
  const resetFromPeakPct =
    Number.isFinite(c.exitPrice) && Number.isFinite(price) && price < c.exitPrice
      ? Math.abs(pctDiff(c.exitPrice, price))
      : 0;

  const closeAboveEma8Ok =
    f.closeAboveEma8 ||
    (!CONFIG.POST_EXIT_CONTINUATION_REQUIRE_CLOSE_ABOVE_EMA8 &&
      f.belowEma8Pct <= CONFIG.POST_EXIT_CONTINUATION_MAX_BELOW_EMA8_PCT);

  const hardBlocks = [];

  reasonPush(
    hardBlocks,
    CONFIG.POST_EXIT_CONTINUATION_REQUIRE_EMA8_ABOVE_EMA18 && !f.ema8AboveEma18,
    "ema8_not_above_ema18"
  );

  reasonPush(
    hardBlocks,
    !closeAboveEma8Ok,
    "close_not_above_or_near_ema8"
  );

  reasonPush(
    hardBlocks,
    CONFIG.POST_EXIT_CONTINUATION_BLOCK_ON_BURST_BEARISH && fvvoBearish(feature),
    "burst_or_flow_bearish"
  );

  reasonPush(
    hardBlocks,
    f.extFromEma18Pct > CONFIG.POST_EXIT_CONTINUATION_MAX_EXT_FROM_EMA18_PCT,
    "too_extended_from_ema18"
  );

  const strong =
    Number.isFinite(f.rsi) &&
    f.rsi >= CONFIG.POST_EXIT_CONTINUATION_STRONG_MIN_RSI &&
    Number.isFinite(f.adx) &&
    f.adx >= CONFIG.POST_EXIT_CONTINUATION_STRONG_MIN_ADX &&
    chasePct <= CONFIG.POST_EXIT_CONTINUATION_STRONG_MAX_CHASE_PCT;

  const normal =
    Number.isFinite(f.rsi) &&
    f.rsi >= CONFIG.POST_EXIT_CONTINUATION_MIN_RSI &&
    Number.isFinite(f.adx) &&
    f.adx >= CONFIG.POST_EXIT_CONTINUATION_MIN_ADX &&
    chasePct <= CONFIG.POST_EXIT_CONTINUATION_MAX_CHASE_PCT;

  const allow = hardBlocks.length === 0 && (strong || normal);

  const mode = strong
    ? "post_exit_continuation_reentry_long_strong"
    : "post_exit_continuation_reentry_long";

  const result = {
    allow,
    mode,
    reason: allow ? "post_exit_continuation_ok" : "post_exit_continuation_blocked",
    hardBlocks,
    metrics: {
      price: round4(price),
      exitPrice: round4(c.exitPrice),
      chasePct: round4(chasePct),
      resetFromPeakPct: round4(resetFromPeakPct),
      rsi: round4(f.rsi),
      adx: round4(f.adx),
      extFromEma8Pct: round4(f.extFromEma8Pct),
      extFromEma18Pct: round4(f.extFromEma18Pct),
      closeAboveEma8: f.closeAboveEma8,
      belowEma8Pct: round4(f.belowEma8Pct),
      ema8AboveEma18: f.ema8AboveEma18,
      strong,
      normal,
      barIndex: S.barIndex,
      eligibleFromBar: c.eligibleFromBar,
      eligibleUntilBar: c.eligibleUntilBar,
    },
  };

  debug("🟦 POST_EXIT_CONTINUATION_CHECK", result);

  return result;
}

async function maybeEnterPostExitContinuation(feature = S.lastFeature) {
  const r = evaluatePostExitContinuation(feature);

  if (!r.allow) return r;

  const price = n(feature?.close, NaN);
  if (!Number.isFinite(price) || price <= 0) return { allow: false, reason: "bad_price" };

  if (S.postExitContinuation) {
    S.postExitContinuation.used = true;
  }

  await doEnter(r.mode, price, feature?.time || isoNow(), {
    trigger: "post_exit_continuation",
    metrics: r.metrics,
  });

  return r;
}

function evaluateFeatureReentry(feature = S.lastFeature) {
  if (!CONFIG.PHASE2_REENTRY_ENABLED) return { allow: false, reason: "disabled" };
  if (S.inPosition) return { allow: false, reason: "in_position" };
  if (!S.bullRegime) return { allow: false, reason: "not_bull_regime" };

  if (S.reentriesThisBullRegime >= CONFIG.MAX_REENTRIES_PER_BULL_REGIME) {
    return {
      allow: false,
      reason: "max_reentries_reached",
      count: S.reentriesThisBullRegime,
      max: CONFIG.MAX_REENTRIES_PER_BULL_REGIME,
    };
  }

  if (!S.lastProfitExit) {
    return { allow: false, reason: "no_profit_exit_anchor" };
  }

  const barsAfterExit = S.barIndex - n(S.lastProfitExit.exitBarIndex, S.barIndex);
  if (barsAfterExit < CONFIG.REENTRY_MIN_BARS_AFTER_EXIT) {
    return {
      allow: false,
      reason: "reentry_too_early",
      barsAfterExit,
      required: CONFIG.REENTRY_MIN_BARS_AFTER_EXIT,
    };
  }

  if (barsAfterExit > CONFIG.REENTRY_WINDOW_BARS) {
    return {
      allow: false,
      reason: "reentry_window_expired",
      barsAfterExit,
      window: CONFIG.REENTRY_WINDOW_BARS,
    };
  }

  const f = featureContext(feature);
  const price = n(feature?.close, NaN);

  if (!Number.isFinite(price) || price <= 0) return { allow: false, reason: "bad_price" };

  const resetFromPeakPct =
    Number.isFinite(S.lastProfitExit.exitPrice) && price < S.lastProfitExit.exitPrice
      ? Math.abs(pctDiff(S.lastProfitExit.exitPrice, price))
      : 0;

  const chasePct = pctDiff(S.lastProfitExit.exitPrice, price);

  const strong =
    CONFIG.STRONG_REENTRY_OVERRIDE_ENABLED &&
    Number.isFinite(f.rsi) &&
    f.rsi >= CONFIG.STRONG_REENTRY_MIN_RSI &&
    Number.isFinite(f.adx) &&
    f.adx >= CONFIG.STRONG_REENTRY_MIN_ADX &&
    chasePct <= CONFIG.STRONG_REENTRY_MAX_CHASE_PCT &&
    f.ema8AboveEma18 &&
    f.closeAboveEma8;

  const normal =
    resetFromPeakPct >= CONFIG.REENTRY_MIN_RESET_FROM_PEAK_PCT &&
    chasePct <= CONFIG.REENTRY_MAX_CHASE_PCT &&
    (!CONFIG.REENTRY_REQUIRE_CLOSE_ABOVE_EMA8 || f.closeAboveEma8) &&
    f.ema8AboveEma18;

  const fast =
    resetFromPeakPct >= CONFIG.FAST_REENTRY_MIN_RESET_FROM_PEAK_PCT &&
    chasePct <= CONFIG.FAST_REENTRY_MAX_CHASE_PCT &&
    Number.isFinite(f.rsi) &&
    f.rsi >= CONFIG.FAST_REENTRY_MIN_RSI &&
    Number.isFinite(f.adx) &&
    f.adx >= CONFIG.FAST_REENTRY_MIN_ADX &&
    f.closeAboveEma8 &&
    f.ema8AboveEma18;

  const hardBlocks = [];

  reasonPush(hardBlocks, fvvoBearish(feature) && !strong, "bearish_flow_or_fvvo");
  reasonPush(hardBlocks, !f.ema8AboveEma18 && !strong, "ema8_not_above_ema18");
  reasonPush(
    hardBlocks,
    CONFIG.REENTRY_REQUIRE_CLOSE_ABOVE_EMA8 && !f.closeAboveEma8 && !strong,
    "close_below_ema8"
  );

  const allow = hardBlocks.length === 0 && (strong || fast || normal);

  const mode = strong
    ? "feature_pullback_reclaim_reentry_long_strong"
    : "feature_pullback_reclaim_reentry_long";

  const result = {
    allow,
    mode,
    reason: allow ? "feature_reentry_ok" : "feature_reentry_blocked",
    hardBlocks,
    metrics: {
      price: round4(price),
      anchorExitPrice: round4(S.lastProfitExit.exitPrice),
      barsAfterExit,
      resetFromPeakPct: round4(resetFromPeakPct),
      chasePct: round4(chasePct),
      rsi: round4(f.rsi),
      adx: round4(f.adx),
      extFromEma8Pct: round4(f.extFromEma8Pct),
      extFromEma18Pct: round4(f.extFromEma18Pct),
      closeAboveEma8: f.closeAboveEma8,
      ema8AboveEma18: f.ema8AboveEma18,
      strong,
      fast,
      normal,
    },
  };

  debug("🟩 FEATURE_REENTRY_CHECK", result);

  return result;
}

async function maybeEnterFeatureReentry(feature = S.lastFeature) {
  const r = evaluateFeatureReentry(feature);
  if (!r.allow) return r;

  const price = n(feature?.close, NaN);
  await doEnter(r.mode, price, feature?.time || isoNow(), {
    trigger: "feature_reentry",
    metrics: r.metrics,
  });

  return r;
}

// -----------------------------
// Reentry top harvest
// -----------------------------
function shouldReentryTopHarvestExit(feature, pnlPct, fv) {
  if (!CONFIG.REENTRY_TOP_HARVEST_ENABLED) return { allow: false };
  if (!S.inPosition || !S.position) return { allow: false };
  if (!isReentryHarvestMode(S.position.mode)) return { allow: false };

  const f = featureContext(feature);
  const pos = S.position;

  const peakPnlPct = n(pos.peakPnlPct, pnlPct);
  const ext8 = n(f.extFromEma8Pct, 0);
  const ext18 = n(f.extFromEma18Pct, 0);
  const adx = n(f.adx, 0);
  const currentPnl = n(pnlPct, 0);

  const hardHit = currentPnl >= CONFIG.REENTRY_TOP_HARVEST_MIN_PROFIT_PCT;

  const softHit =
    currentPnl >= CONFIG.REENTRY_TOP_HARVEST_SOFT_MIN_PROFIT_PCT &&
    peakPnlPct >= CONFIG.REENTRY_TOP_HARVEST_SOFT_MIN_PEAK_PROFIT_PCT &&
    adx >= CONFIG.REENTRY_TOP_HARVEST_SOFT_MIN_ADX &&
    ext8 >= CONFIG.REENTRY_TOP_HARVEST_SOFT_MIN_EXT_FROM_EMA8_PCT &&
    ext18 >= CONFIG.REENTRY_TOP_HARVEST_SOFT_MIN_EXT_FROM_EMA18_PCT &&
    !fvvoBullish(feature);

  if (CONFIG.REENTRY_TOP_HARVEST_LOG_DEBUG) {
    log("🟧 REENTRY_TOP_HARVEST_CHECK", {
      mode: pos.mode,
      pnlPct: round4(currentPnl),
      peakPnlPct: round4(peakPnlPct),
      adx: round4(adx),
      extFromEma8Pct: round4(ext8),
      extFromEma18Pct: round4(ext18),
      fvvoBullish: fvvoBullish(feature),
      hardHit,
      softHit,
    });
  }

  if (hardHit) {
    return {
      allow: true,
      reason: "reentry_top_harvest_exit",
      type: "hard",
    };
  }

  if (softHit) {
    return {
      allow: true,
      reason: "reentry_top_harvest_soft_exit",
      type: "soft",
    };
  }

  return { allow: false };
}

// -----------------------------
// Bar exit evaluation
// -----------------------------
async function evaluateBarExit(feature = S.lastFeature) {
  if (!S.inPosition || !S.position || !feature) return;

  const price = n(feature.close, NaN);
  if (!Number.isFinite(price) || price <= 0) return;

  const pos = updatePositionStats(price);
  const pnlPct = n(pos.currentPnlPct, pctDiff(pos.entryPrice, price));

  const topHarvest = shouldReentryTopHarvestExit(feature, pnlPct, featureContext(feature));
  if (topHarvest.allow) {
    await doExit(topHarvest.reason, price, feature.time || isoNow(), "cycle_exit");
    return;
  }

  const postExitGuard = shouldPostExitContinuationProfitGuardExit(price, feature.time || isoNow());
  if (postExitGuard.allow) {
    await doExit(postExitGuard.reason, price, feature.time || isoNow(), "cycle_exit");
    return;
  }

  const dynamicReason = dynamicTpReason(pos);
  if (dynamicReason) {
    await doExit(dynamicReason, price, feature.time || isoNow(), "cycle_exit");
    return;
  }

  const sr = stopReason(pos, price);
  if (sr) {
    await doExit(sr, price, feature.time || isoNow(), "cycle_exit");
  }
}

// -----------------------------
// Event handlers
// -----------------------------
async function handleTick(payload) {
  S.stats.ticks += 1;

  const symbol = payloadSymbol(payload);
  const price = payloadPrice(payload);
  const eventIso = payloadTime(payload);

  if (symbol !== CONFIG.SYMBOL) {
    return {
      ok: true,
      kind: "tick",
      skipped: "symbol_mismatch",
      symbol,
      expected: CONFIG.SYMBOL,
    };
  }

  if (!CONFIG.REPLAY_ALLOW_STALE_DATA && ageSec(eventIso) > CONFIG.TICK_MAX_AGE_SEC) {
    return {
      ok: true,
      kind: "tick",
      skipped: "stale_tick",
      ageSec: round4(ageSec(eventIso)),
    };
  }

  S.lastTick = {
    src: "tick",
    symbol,
    price,
    time: eventIso,
    receivedAt: isoNow(),
  };

  await maybeTriggerFirstEntryConfirmFromTick(price, eventIso);
  await updatePositionFromTick(price, eventIso);

  return {
    ok: true,
    kind: "tick",
    price: round4(price),
    inPosition: S.inPosition,
  };
}

async function handleFeature(payload) {
  S.stats.features += 1;

  const feature = normalizeFeature(payload);

  if (feature.symbol !== CONFIG.SYMBOL) {
    return {
      ok: true,
      kind: "features",
      skipped: "symbol_mismatch",
      symbol: feature.symbol,
      expected: CONFIG.SYMBOL,
    };
  }

  if (!CONFIG.REPLAY_ALLOW_STALE_DATA && ageSec(feature.time) > CONFIG.FEATURE_MAX_AGE_SEC) {
    return {
      ok: true,
      kind: "features",
      skipped: "stale_feature",
      ageSec: round4(ageSec(feature.time)),
    };
  }

  const isNewBar = feature.barKey !== S.lastBarKey;
  if (isNewBar) {
    S.barIndex += 1;
    S.lastBarKey = feature.barKey;
  }

  S.lastFeature = feature;

  debug("📊 FEATURE", {
    barIndex: S.barIndex,
    isNewBar,
    time: feature.time,
    close: round4(feature.close),
    ema8: round4(feature.ema8),
    ema18: round4(feature.ema18),
    rsi: round4(feature.rsi),
    adx: round4(feature.adx),
    inPosition: S.inPosition,
    mode: S.position?.mode || null,
  });

  await evaluateBarExit(feature);

  if (!S.inPosition) {
    await maybeEnterPostExitContinuation(feature);

    if (!S.inPosition) {
      await maybeEnterFeatureReentry(feature);
    }
  }

  return {
    ok: true,
    kind: "features",
    close: round4(feature.close),
    barIndex: S.barIndex,
    inPosition: S.inPosition,
  };
}

async function handleRay(payload) {
  S.stats.rays += 1;

  const symbol = payloadSymbol(payload);
  const action = payloadAction(payload);
  const price = payloadPrice(payload);
  const eventIso = payloadTime(payload);

  if (symbol !== CONFIG.SYMBOL) {
    return {
      ok: true,
      kind: "ray",
      skipped: "symbol_mismatch",
      symbol,
      expected: CONFIG.SYMBOL,
    };
  }

  const ray = {
    src: "ray",
    symbol,
    action,
    price,
    time: eventIso,
    receivedAt: isoNow(),
  };

  S.lastRay = ray;

  if (isBearishTrendChange(action)) {
    S.lastBearishRayAtMs = nowMs();

    log("🔴 RAY_BEARISH", {
      action,
      price: round4(price),
      time: eventIso,
      inPosition: S.inPosition,
    });

    if (S.inPosition) {
      await doExit("ray_bearish_trend_change_exit", price, eventIso, "ray_exit");
    }

    S.bullRegime = false;
    S.bullRegimeStartedAt = null;
    S.bullRegimeEntryCount = 0;
    S.firstEntryConfirm = null;
    S.postExitContinuation = null;

    return {
      ok: true,
      kind: "ray",
      action,
      bearish: true,
      inPosition: S.inPosition,
    };
  }

  if (!isBullishTrendChange(action)) {
    return {
      ok: true,
      kind: "ray",
      skipped: "unhandled_ray_action",
      action,
    };
  }

  // Bullish Trend Change
  S.lastBullishRayAtMs = nowMs();

  if (!S.bullRegime) {
    S.bullRegime = true;
    S.bullRegimeStartedAt = eventIso || isoNow();
    S.bullRegimeEntryCount = 0;
    S.reentriesThisBullRegime = 0;
    S.lastProfitExit = null;
    S.postExitContinuation = null;

    log("🟢 BULL_REGIME_ON", {
      action,
      price: round4(price),
      time: eventIso,
      barIndex: S.barIndex,
    });
  } else {
    log("🟢 RAY_BULLISH_IN_EXISTING_REGIME", {
      action,
      price: round4(price),
      time: eventIso,
      barIndex: S.barIndex,
      bullRegimeEntryCount: S.bullRegimeEntryCount,
    });
  }

  if (S.inPosition) {
    return {
      ok: true,
      kind: "ray",
      action,
      bullish: true,
      skipped: "already_in_position",
      mode: S.position?.mode || null,
    };
  }

  if (!CONFIG.FIRST_ENTRY_ENGINE_ENABLED) {
    await doEnter("ray_bullish_trend_change_long", price, eventIso, {
      trigger: "ray_bullish",
      firstEntryEngine: false,
    });

    return {
      ok: true,
      kind: "ray",
      action,
      bullish: true,
      entered: true,
      mode: "ray_bullish_trend_change_long",
    };
  }

  const decision = evaluateFirstBullishTrendChangeEntry(price, S.lastFeature);

  if (CONFIG.FIRST_ENTRY_LOG_DEBUG) {
    log("🟨 FIRST_ENTRY_DECISION", {
      decision: decision.decision,
      reason: decision.reason,
      mode: decision.mode || null,
      redFlags: decision.redFlags || [],
      metrics: decision.metrics || {},
      rayPrice: round4(price),
      action,
      barIndex: S.barIndex,
    });
  }

  if (decision.decision === "enter") {
    await doEnter(decision.mode, price, eventIso, {
      trigger: "ray_bullish",
      firstEntryDecision: decision.reason,
      firstEntryMetrics: decision.metrics,
      redFlags: decision.redFlags || [],
    });

    return {
      ok: true,
      kind: "ray",
      action,
      bullish: true,
      entered: true,
      mode: decision.mode,
    };
  }

  if (decision.decision === "confirm") {
    armFirstEntryConfirm(price, eventIso, decision);

    return {
      ok: true,
      kind: "ray",
      action,
      bullish: true,
      entered: false,
      confirmArmed: true,
      mode: decision.mode,
      reason: decision.reason,
    };
  }

  S.stats.enterBlocked += 1;

  log("⛔ FIRST_ENTRY_BLOCKED", {
    reason: decision.reason,
    redFlags: decision.redFlags || [],
    metrics: decision.metrics || {},
    action,
    price: round4(price),
  });

  return {
    ok: true,
    kind: "ray",
    action,
    bullish: true,
    entered: false,
    blocked: true,
    reason: decision.reason,
    redFlags: decision.redFlags || [],
  };
}

async function handleFvvo(payload) {
  S.stats.fvvo += 1;

  const symbol = payloadSymbol(payload);
  if (symbol !== CONFIG.SYMBOL) {
    return {
      ok: true,
      kind: "fvvo",
      skipped: "symbol_mismatch",
      symbol,
      expected: CONFIG.SYMBOL,
    };
  }

  S.lastFvvo = {
    src: "fvvo",
    symbol,
    time: payloadTime(payload),
    price: payloadPrice(payload),
    state: String(payload.state ?? payload.fvvo ?? payload.fvvoState ?? ""),
    burst: String(payload.burst ?? payload.burstState ?? ""),
    raw: payload,
  };

  return {
    ok: true,
    kind: "fvvo",
    state: S.lastFvvo.state,
    burst: S.lastFvvo.burst,
  };
}

async function routePayload(payload) {
  const src = payloadSrc(payload);
  const action = payloadAction(payload);

  if (src === "tick") return handleTick(payload);

  if (
    src === "features" ||
    src === "feature" ||
    src === "bar" ||
    payload?.ema8 !== undefined ||
    payload?.rsi !== undefined ||
    payload?.adx !== undefined
  ) {
    return handleFeature(payload);
  }

  if (
    src === "ray" ||
    src === "rayalgo" ||
    isBullishTrendChange(action) ||
    isBearishTrendChange(action)
  ) {
    return handleRay(payload);
  }

  if (src === "fvvo" || src === "flow" || payload?.fvvo !== undefined || payload?.burst !== undefined) {
    return handleFvvo(payload);
  }

  return {
    ok: true,
    kind: "unknown",
    skipped: "unknown_payload_type",
    src,
    action,
  };
}

// -----------------------------
// HTTP routes
// -----------------------------
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    brain: CONFIG.BRAIN_NAME,
    symbol: CONFIG.SYMBOL,
    path: CONFIG.WEBHOOK_PATH,
    startedAt: S.startedAt,
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    brain: CONFIG.BRAIN_NAME,
    symbol: CONFIG.SYMBOL,
    inPosition: S.inPosition,
    startedAt: S.startedAt,
  });
});

app.get("/status", (_req, res) => {
  res.json({
    ok: true,
    config: configSnapshot(),
    state: {
      startedAt: S.startedAt,
      inPosition: S.inPosition,
      position: S.position
        ? {
            mode: S.position.mode,
            entryPrice: round4(S.position.entryPrice),
            entryTime: S.position.entryTime,
            peakPrice: round4(S.position.peakPrice),
            peakPnlPct: round4(S.position.peakPnlPct),
            currentPnlPct: round4(S.position.currentPnlPct),
            breakevenArmed: S.position.breakevenArmed,
            dynamicTpTier: S.position.dynamicTpTier,
          }
        : null,
      barIndex: S.barIndex,
      bullRegime: S.bullRegime,
      bullRegimeStartedAt: S.bullRegimeStartedAt,
      bullRegimeEntryCount: S.bullRegimeEntryCount,
      reentriesThisBullRegime: S.reentriesThisBullRegime,
      firstEntryConfirm: S.firstEntryConfirm
        ? {
            rayPrice: round4(S.firstEntryConfirm.rayPrice),
            ticksConfirmed: S.firstEntryConfirm.ticksConfirmed,
            expiresInMs: Math.max(0, S.firstEntryConfirm.expiresAtMs - nowMs()),
            mode: S.firstEntryConfirm.mode,
          }
        : null,
      lastProfitExit: S.lastProfitExit
        ? {
            reason: S.lastProfitExit.reason,
            exitPrice: round4(S.lastProfitExit.exitPrice),
            exitBarIndex: S.lastProfitExit.exitBarIndex,
            pnlPct: round4(S.lastProfitExit.pnlPct),
            peakPnlPct: round4(S.lastProfitExit.peakPnlPct),
            mode: S.lastProfitExit.mode,
          }
        : null,
      postExitContinuation: S.postExitContinuation
        ? {
            armed: S.postExitContinuation.armed,
            used: S.postExitContinuation.used,
            exitPrice: round4(S.postExitContinuation.exitPrice),
            eligibleFromBar: S.postExitContinuation.eligibleFromBar,
            eligibleUntilBar: S.postExitContinuation.eligibleUntilBar,
            pnlPct: round4(S.postExitContinuation.pnlPct),
            peakPnlPct: round4(S.postExitContinuation.peakPnlPct),
          }
        : null,
      lastTick: S.lastTick
        ? {
            price: round4(S.lastTick.price),
            time: S.lastTick.time,
            receivedAt: S.lastTick.receivedAt,
          }
        : null,
      lastFeature: S.lastFeature
        ? {
            close: round4(S.lastFeature.close),
            ema8: round4(S.lastFeature.ema8),
            ema18: round4(S.lastFeature.ema18),
            rsi: round4(S.lastFeature.rsi),
            adx: round4(S.lastFeature.adx),
            time: S.lastFeature.time,
            barKey: S.lastFeature.barKey,
          }
        : null,
      stats: S.stats,
    },
  });
});

app.post("/reset", (req, res) => {
  const keepStats = b(req.body?.keepStats, false);

  S.lastTick = null;
  S.lastFeature = null;
  S.lastRay = null;
  S.lastFvvo = null;

  S.barIndex = 0;
  S.lastBarKey = null;

  S.bullRegime = false;
  S.bullRegimeStartedAt = null;
  S.bullRegimeEntryCount = 0;

  S.inPosition = false;
  S.position = null;

  S.lastEnterAtMs = 0;
  S.lastExitAtMs = 0;

  S.lastBullishRayAtMs = 0;
  S.lastBearishRayAtMs = 0;

  S.firstEntryConfirm = null;
  S.lastProfitExit = null;
  S.postExitContinuation = null;
  S.reentriesThisBullRegime = 0;

  if (!keepStats) {
    S.stats = {
      ticks: 0,
      features: 0,
      rays: 0,
      fvvo: 0,
      enterAllowed: 0,
      enterBlocked: 0,
      exitAllowed: 0,
      exitBlocked: 0,
      forwardedOk: 0,
      forwardedFail: 0,
    };
  }

  log("♻️ RESET", {
    keepStats,
  });

  res.json({
    ok: true,
    reset: true,
    keepStats,
  });
});

app.post(CONFIG.WEBHOOK_PATH, async (req, res) => {
  const payload = req.body || {};

  if (!checkSecret(payload)) {
    log("⛔ UNAUTHORIZED", {
      src: payloadSrc(payload),
      symbol: payloadSymbol(payload),
      hasSecret: Boolean(payloadSecret(payload)),
    });

    return res.status(401).json({
      ok: false,
      error: "unauthorized",
    });
  }

  try {
    const out = await routePayload(payload);
    return res.json(out);
  } catch (err) {
    log("❌ WEBHOOK_ERROR", {
      error: err?.message || String(err),
      stack: err?.stack?.split?.("\n")?.slice?.(0, 5),
      src: payloadSrc(payload),
      action: payloadAction(payload),
      symbol: payloadSymbol(payload),
    });

    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
});

// Compatibility route if WEBHOOK_PATH is not "/webhook"
if (CONFIG.WEBHOOK_PATH !== "/webhook") {
  app.post("/webhook", async (req, res) => {
    const payload = req.body || {};

    if (!checkSecret(payload)) {
      return res.status(401).json({
        ok: false,
        error: "unauthorized",
      });
    }

    try {
      const out = await routePayload(payload);
      return res.json(out);
    } catch (err) {
      log("❌ WEBHOOK_ERROR_COMPAT", {
        error: err?.message || String(err),
        src: payloadSrc(payload),
        action: payloadAction(payload),
        symbol: payloadSymbol(payload),
      });

      return res.status(500).json({
        ok: false,
        error: err?.message || String(err),
      });
    }
  });
}

app.listen(CONFIG.PORT, () => {
  log("✅ brain listening", {
    port: CONFIG.PORT,
    path: CONFIG.WEBHOOK_PATH,
    symbol: CONFIG.SYMBOL,
    tf: CONFIG.ENTRY_TF,
    brain: CONFIG.BRAIN_NAME,
  });

  debug("🧠 CONFIG_SNAPSHOT", configSnapshot());
});
