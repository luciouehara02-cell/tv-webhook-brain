// ============================================================
// BrainFVVO_v1b_SHADOW
// Standalone FVVO shadow brain
// ------------------------------------------------------------
// Purpose:
// - SHADOW-only FVVO brain for SOLUSDT
// - Primary setup: FVVO washout reversal
// - Secondary setup: strict FVVO zero-line cross-up confirmation
// - Weak above-zero-rising continuation is disabled by default
// - Does not use Ray Bullish Trend Change as an entry trigger
// - Tick data is not required for the entry logic
// ============================================================

const express = require("express");

// ============================================================
// ENV HELPERS
// ============================================================

function envStr(name, fallback = "") {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === "") return fallback;
  return String(v).trim();
}

function envNum(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === "") return fallback;
  const s = String(v).trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(s);
}

// ============================================================
// CONFIG
// ============================================================

const CFG = {
  BRAIN_NAME: envStr("BRAIN_NAME", "BrainFVVO_v1b_SHADOW"),
  PORT: envNum("PORT", 8080),
  WEBHOOK_PATH: envStr("WEBHOOK_PATH", "/webhook"),
  WEBHOOK_SECRET: envStr("WEBHOOK_SECRET", "CHANGE_ME_TO_RANDOM_SECRET"),
  DEBUG: envBool("DEBUG", true),

  SYMBOL: envStr("SYMBOL", "BINANCE:SOLUSDT"),
  ENTRY_TF: envStr("ENTRY_TF", "5"),

  SHADOW_ONLY: envBool("SHADOW_ONLY", true),
  ENABLE_HTTP_FORWARD: envBool("ENABLE_HTTP_FORWARD", false),

  FVVO_LONG_ENABLED: envBool("FVVO_LONG_ENABLED", true),
  FVVO_SHORT_ENABLED: envBool("FVVO_SHORT_ENABLED", false),

  // General entry safety
  FVVO_ENTRY_COOLDOWN_BARS: envNum("FVVO_ENTRY_COOLDOWN_BARS", 2),

  // Primary setup: washout reversal
  FVVO_WASHOUT_ENABLED: envBool("FVVO_WASHOUT_ENABLED", true),
  FVVO_WASHOUT_LOOKBACK_BARS: envNum("FVVO_WASHOUT_LOOKBACK_BARS", 12),
  FVVO_WASHOUT_RSI_MAX: envNum("FVVO_WASHOUT_RSI_MAX", 35),
  FVVO_WASHOUT_RSI_RECOVER_MIN: envNum("FVVO_WASHOUT_RSI_RECOVER_MIN", 38),
  FVVO_WASHOUT_MIN_DEEP_NEGATIVE: envNum("FVVO_WASHOUT_MIN_DEEP_NEGATIVE", -2.0),
  FVVO_WASHOUT_MIN_SLOPE: envNum("FVVO_WASHOUT_MIN_SLOPE", 0.50),
  FVVO_WASHOUT_MAX_CURRENT_FVVO: envNum("FVVO_WASHOUT_MAX_CURRENT_FVVO", 0.75),
  FVVO_WASHOUT_MAX_BELOW_EMA8_PCT: envNum("FVVO_WASHOUT_MAX_BELOW_EMA8_PCT", 0.45),
  FVVO_WASHOUT_MAX_EXT_EMA8_PCT: envNum("FVVO_WASHOUT_MAX_EXT_EMA8_PCT", 0.55),
  FVVO_WASHOUT_MAX_EXT_EMA18_PCT: envNum("FVVO_WASHOUT_MAX_EXT_EMA18_PCT", 0.80),
  FVVO_WASHOUT_BLOCK_FRESH_LOW: envBool("FVVO_WASHOUT_BLOCK_FRESH_LOW", true),
  FVVO_WASHOUT_REQUIRE_PRICE_CONFIRM: envBool("FVVO_WASHOUT_REQUIRE_PRICE_CONFIRM", true),

  // Secondary setup: strict cross-up confirmation
  FVVO_CROSS_ENABLED: envBool("FVVO_CROSS_ENABLED", true),
  FVVO_CROSS_MIN_RSI: envNum("FVVO_CROSS_MIN_RSI", 52),
  FVVO_CROSS_MIN_SLOPE: envNum("FVVO_CROSS_MIN_SLOPE", 0.60),
  FVVO_CROSS_MAX_EXT_EMA8_PCT: envNum("FVVO_CROSS_MAX_EXT_EMA8_PCT", 0.35),
  FVVO_CROSS_MAX_EXT_EMA18_PCT: envNum("FVVO_CROSS_MAX_EXT_EMA18_PCT", 0.65),
  FVVO_CROSS_ALLOW_EMA8_BELOW_EMA18_PCT: envNum("FVVO_CROSS_ALLOW_EMA8_BELOW_EMA18_PCT", 0.10),
  FVVO_CROSS_RECENT_REDDOT_BLOCK_BARS: envNum("FVVO_CROSS_RECENT_REDDOT_BLOCK_BARS", 2),

  // Optional strict above-zero rising continuation. Disabled by default because replay showed weak entries.
  FVVO_RISING_CONT_ENABLED: envBool("FVVO_RISING_CONT_ENABLED", false),
  FVVO_RISING_MIN_RSI: envNum("FVVO_RISING_MIN_RSI", 55),
  FVVO_RISING_MIN_SLOPE: envNum("FVVO_RISING_MIN_SLOPE", 0.80),
  FVVO_RISING_MAX_EXT_EMA8_PCT: envNum("FVVO_RISING_MAX_EXT_EMA8_PCT", 0.25),
  FVVO_RISING_MAX_EXT_EMA18_PCT: envNum("FVVO_RISING_MAX_EXT_EMA18_PCT", 0.55),

  // Exits
  FVVO_INTRABAR_HARD_STOP_ENABLED: envBool("FVVO_INTRABAR_HARD_STOP_ENABLED", true),
  FVVO_MAX_LOSS_EXIT_PCT: envNum("FVVO_MAX_LOSS_EXIT_PCT", 0.45),

  FVVO_GIVEBACK_ARM1_PCT: envNum("FVVO_GIVEBACK_ARM1_PCT", 0.30),
  FVVO_GIVEBACK_ARM1_DROP_PCT: envNum("FVVO_GIVEBACK_ARM1_DROP_PCT", 0.15),

  FVVO_GIVEBACK_ARM2_PCT: envNum("FVVO_GIVEBACK_ARM2_PCT", 0.50),
  FVVO_GIVEBACK_ARM2_DROP_PCT: envNum("FVVO_GIVEBACK_ARM2_DROP_PCT", 0.22),

  FVVO_HARD_DOWN_SLOPE: envNum("FVVO_HARD_DOWN_SLOPE", -0.08),
  FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT: envNum("FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT", 0.05),
  FVVO_MAX_HOLD_BARS: envNum("FVVO_MAX_HOLD_BARS", 36),

  BAR_DEDUP_ENABLED: envBool("BAR_DEDUP_ENABLED", true),
  HISTORY_MAX_BARS: envNum("HISTORY_MAX_BARS", 120)
};

// Hard safety.
if (!CFG.SHADOW_ONLY || CFG.ENABLE_HTTP_FORWARD) {
  console.log("⚠️ SAFETY: BrainFVVO_v1b_SHADOW is SHADOW ONLY.");
  console.log("⚠️ SAFETY: Forcing SHADOW_ONLY=true and ENABLE_HTTP_FORWARD=false.");
  CFG.SHADOW_ONLY = true;
  CFG.ENABLE_HTTP_FORWARD = false;
}

// ============================================================
// EXPRESS SETUP
// ============================================================

const app = express();

app.use(
  express.json({
    limit: "2mb",
    type: ["application/json", "text/plain", "*/*"]
  })
);

// ============================================================
// STATE
// ============================================================

const state = {
  startedAt: new Date().toISOString(),

  positions: new Map(),
  lastFeature: new Map(),
  history: new Map(),
  seenBars: new Set(),
  barIndex: new Map(),
  lastExitBar: new Map(),

  stats: {
    received: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,

    virtualLongOpens: 0,
    virtualLongExits: 0,

    washoutSignals: 0,
    washoutOpens: 0,
    washoutExits: 0,
    washoutPnlPct: 0,

    crossSignals: 0,
    crossOpens: 0,
    crossExits: 0,
    crossPnlPct: 0,

    risingSignals: 0,
    risingOpens: 0,
    risingExits: 0,
    risingPnlPct: 0,

    wins: 0,
    losses: 0,
    flats: 0,
    totalPnlPct: 0,
    bestPnlPct: null,
    worstPnlPct: null,
    bestRunupPct: null,

    redDotExits: 0,
    backupExits: 0,
    intrabarHardStopExits: 0,
    closeMaxLossExits: 0,
    maxHoldExits: 0
  }
};

// ============================================================
// HELPERS
// ============================================================

function nowIso() {
  return new Date().toISOString();
}

function n(v, d = 4) {
  const x = Number(v);
  if (!Number.isFinite(x)) return "na";
  return x.toFixed(d);
}

function pct(v, d = 3) {
  const x = Number(v);
  if (!Number.isFinite(x)) return "na";
  const sign = x > 0 ? "+" : "";
  return `${sign}${x.toFixed(d)}%`;
}

function boolStr(v) {
  return v ? "true" : "false";
}

function safeNum(v, fallback = null) {
  if (v === undefined || v === null || v === "") return fallback;
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function safeBool(v, fallback = false) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return fallback;
}

function strFromPayload(v, fallback = "") {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  return s === "" ? fallback : s;
}

function calcPct(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || y === 0) return null;
  return ((x - y) / y) * 100;
}

function calcBelowPct(reference, value) {
  const r = Number(reference);
  const v = Number(value);
  if (!Number.isFinite(r) || !Number.isFinite(v) || r === 0) return null;
  if (v >= r) return 0;
  return ((r - v) / r) * 100;
}

function logLine(type, msg, obj = null) {
  const prefix = `${nowIso()} | ${CFG.BRAIN_NAME} | ${type}`;
  if (obj && CFG.DEBUG) console.log(`${prefix} | ${msg} | ${JSON.stringify(obj)}`);
  else console.log(`${prefix} | ${msg}`);
}

function getHistory(symbol) {
  return state.history.get(symbol) || [];
}

function pushHistory(p) {
  const arr = state.history.get(p.symbol) || [];
  arr.push(p);
  while (arr.length > CFG.HISTORY_MAX_BARS) arr.shift();
  state.history.set(p.symbol, arr);
}

function recentBarsIncludingCurrent(p, lookback) {
  const prev = getHistory(p.symbol);
  const combined = prev.concat([p]);
  const nBars = Math.max(1, Number(lookback) || 1);
  return combined.slice(-nBars);
}

function minOf(arr, key) {
  const vals = arr.map((x) => safeNum(x[key], null)).filter((x) => Number.isFinite(x));
  if (!vals.length) return null;
  return Math.min(...vals);
}

function recentRedDot(p, barsBack) {
  const bars = recentBarsIncludingCurrent(p, barsBack);
  return bars.some((b) => b.fvvoRedDot === true);
}

function previousBar(symbol) {
  const arr = getHistory(symbol);
  if (!arr.length) return null;
  return arr[arr.length - 1];
}

function risingVsPrevious(p, key) {
  const prev = previousBar(p.symbol);
  if (!prev) return false;
  const pv = safeNum(prev[key], null);
  const cv = safeNum(p[key], null);
  if (!Number.isFinite(pv) || !Number.isFinite(cv)) return false;
  return cv > pv;
}

function twoBarRisingIncludingCurrent(p, key) {
  const arr = getHistory(p.symbol);
  if (arr.length < 2) return false;

  const prev2 = arr[arr.length - 2];
  const prev1 = arr[arr.length - 1];
  const a = safeNum(prev2[key], null);
  const b = safeNum(prev1[key], null);
  const c = safeNum(p[key], null);

  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return false;
  return c > b && b > a;
}

function nextBarNumber(symbol) {
  const current = state.barIndex.get(symbol) || 0;
  const next = current + 1;
  state.barIndex.set(symbol, next);
  return next;
}

function isEntryCooldownActive(symbol, barNo) {
  const lastExit = state.lastExitBar.get(symbol);
  if (!Number.isFinite(lastExit)) return false;
  return barNo - lastExit <= CFG.FVVO_ENTRY_COOLDOWN_BARS;
}

// ============================================================
// PAYLOAD NORMALIZATION
// ============================================================

function normalizePayload(body) {
  const raw = body || {};

  const symbol = strFromPayload(raw.symbol, CFG.SYMBOL);
  const tf = strFromPayload(raw.tf, CFG.ENTRY_TF);
  const event = strFromPayload(raw.event, "");

  const close = safeNum(raw.close, safeNum(raw.price, null));
  const price = safeNum(raw.price, close);
  const open = safeNum(raw.open, close);
  const high = safeNum(raw.high, close);
  const low = safeNum(raw.low, close);

  const ema8 = safeNum(raw.ema8, null);
  const ema18 = safeNum(raw.ema18, null);
  const ema50 = safeNum(raw.ema50, null);
  const rsi = safeNum(raw.rsi, null);
  const adx = safeNum(raw.adx, null);
  const atrPct = safeNum(raw.atrPct, null);

  const fvvoValue = safeNum(raw.fvvoValue, null);
  const fvvoSignal = safeNum(raw.fvvoSignal, null);

  const last = state.lastFeature.get(symbol);
  const prevFvvoValue = last ? last.fvvoValue : null;

  let fvvoSlope = safeNum(raw.fvvoSlope, null);
  if (fvvoSlope === null && fvvoValue !== null && prevFvvoValue !== null) {
    fvvoSlope = fvvoValue - prevFvvoValue;
  }

  let fvvoAboveZero = safeBool(raw.fvvoAboveZero, false);
  if (fvvoValue !== null) fvvoAboveZero = fvvoValue > 0;

  let fvvoCrossUp = safeBool(raw.fvvoCrossUp, false);
  let fvvoCrossDown = safeBool(raw.fvvoCrossDown, false);

  if (fvvoValue !== null && prevFvvoValue !== null) {
    fvvoCrossUp = prevFvvoValue <= 0 && fvvoValue > 0;
    fvvoCrossDown = prevFvvoValue >= 0 && fvvoValue < 0;
  }

  return {
    raw,
    secret: strFromPayload(raw.secret, ""),
    src: strFromPayload(raw.src, ""),
    brain: strFromPayload(raw.brain, ""),
    version: strFromPayload(raw.version, ""),
    symbol,
    tf,
    event,
    price,
    time: strFromPayload(raw.time, nowIso()),

    open,
    high,
    low,
    close,

    ema8,
    ema18,
    ema50,
    rsi,
    adx,
    atrPct,

    fvvoValue,
    fvvoSignal,
    fvvoAboveZero,
    fvvoSlope,
    fvvoCrossUp,
    fvvoCrossDown,

    fvvoRedDot: safeBool(raw.fvvoRedDot, false),
    fvvoBullishColor: safeBool(raw.fvvoBullishColor, false),
    fvvoBearishColor: safeBool(raw.fvvoBearishColor, false),

    sniperBuy: safeBool(raw.sniperBuy, false),
    sniperSell: safeBool(raw.sniperSell, false),
    burstBullish: safeBool(raw.burstBullish, false),
    burstBearish: safeBool(raw.burstBearish, false)
  };
}

// ============================================================
// VALIDATION / DEDUP
// ============================================================

function validatePayload(p) {
  if (!p) return { ok: false, reason: "EMPTY_PAYLOAD" };

  if (CFG.WEBHOOK_SECRET && CFG.WEBHOOK_SECRET !== "CHANGE_ME_TO_RANDOM_SECRET") {
    if (p.secret !== CFG.WEBHOOK_SECRET) return { ok: false, reason: "BAD_SECRET" };
  }

  if (p.symbol !== CFG.SYMBOL) return { ok: false, reason: `SYMBOL_MISMATCH:${p.symbol}` };
  if (p.tf !== CFG.ENTRY_TF) return { ok: false, reason: `TF_MISMATCH:${p.tf}` };
  if (p.event !== "FEATURE_5M_FVVO") return { ok: false, reason: `UNSUPPORTED_EVENT:${p.event}` };

  if (!Number.isFinite(p.close) || p.close <= 0) return { ok: false, reason: "BAD_CLOSE" };
  if (!Number.isFinite(p.ema8) || !Number.isFinite(p.ema18)) return { ok: false, reason: "MISSING_EMA8_OR_EMA18" };
  if (!Number.isFinite(p.rsi)) return { ok: false, reason: "MISSING_RSI" };
  if (!Number.isFinite(p.fvvoValue)) return { ok: false, reason: "MISSING_FVVO_VALUE" };

  return { ok: true, reason: "OK" };
}

function isDuplicateBar(p) {
  if (!CFG.BAR_DEDUP_ENABLED) return false;

  const key = `${p.symbol}|${p.tf}|${p.time}`;
  if (state.seenBars.has(key)) return true;

  state.seenBars.add(key);

  if (state.seenBars.size > 5000) {
    const arr = Array.from(state.seenBars);
    state.seenBars = new Set(arr.slice(arr.length - 2500));
  }

  return false;
}

// ============================================================
// ENTRY: WASHOUT REVERSAL
// ============================================================

function evaluateWashoutEntry(p) {
  const setup = "WASHOUT_REVERSAL";

  if (!CFG.FVVO_LONG_ENABLED) return { ok: false, setup, reason: "FVVO_LONG_DISABLED" };
  if (!CFG.FVVO_WASHOUT_ENABLED) return { ok: false, setup, reason: "FVVO_WASHOUT_DISABLED" };

  const bars = recentBarsIncludingCurrent(p, CFG.FVVO_WASHOUT_LOOKBACK_BARS);
  const recentRsiLow = minOf(bars, "rsi");
  const recentFvvoLow = minOf(bars, "fvvoValue");
  const recentLow = minOf(bars, "low");

  const prev = previousBar(p.symbol);
  const prevRsi = prev ? safeNum(prev.rsi, null) : null;
  const prevHigh = prev ? safeNum(prev.high, null) : null;

  const rsiWasWashedOut = Number.isFinite(recentRsiLow) && recentRsiLow <= CFG.FVVO_WASHOUT_RSI_MAX;
  const rsiRecovering =
    Number.isFinite(p.rsi) &&
    p.rsi >= CFG.FVVO_WASHOUT_RSI_RECOVER_MIN &&
    (!Number.isFinite(prevRsi) || p.rsi >= prevRsi);

  const fvvoWasDeep = Number.isFinite(recentFvvoLow) && recentFvvoLow <= CFG.FVVO_WASHOUT_MIN_DEEP_NEGATIVE;
  const currentFvvoNotLate = Number.isFinite(p.fvvoValue) && p.fvvoValue <= CFG.FVVO_WASHOUT_MAX_CURRENT_FVVO;

  const fvvoSlopeStrong = Number.isFinite(p.fvvoSlope) && p.fvvoSlope >= CFG.FVVO_WASHOUT_MIN_SLOPE;
  const fvvoRising = risingVsPrevious(p, "fvvoValue") || twoBarRisingIncludingCurrent(p, "fvvoValue");
  const fvvoRecovery = fvvoSlopeStrong || fvvoRising || p.fvvoBullishColor;

  const closeBelowEma8Pct = calcBelowPct(p.ema8, p.close);
  const extEma8Pct = calcPct(p.close, p.ema8);
  const extEma18Pct = calcPct(p.close, p.ema18);

  const notTooFarBelowEma8 = Number.isFinite(closeBelowEma8Pct) && closeBelowEma8Pct <= CFG.FVVO_WASHOUT_MAX_BELOW_EMA8_PCT;
  const notTooExtendedFromEma8 = Number.isFinite(extEma8Pct) && extEma8Pct <= CFG.FVVO_WASHOUT_MAX_EXT_EMA8_PCT;
  const notTooExtendedFromEma18 = Number.isFinite(extEma18Pct) && extEma18Pct <= CFG.FVVO_WASHOUT_MAX_EXT_EMA18_PCT;

  const bullishCandle = Number.isFinite(p.open) && p.close > p.open;
  const closeAbovePrevHigh = Number.isFinite(prevHigh) && p.close > prevHigh;
  const closeReclaimEma8 = p.close >= p.ema8;

  const priceConfirm =
    !CFG.FVVO_WASHOUT_REQUIRE_PRICE_CONFIRM ||
    bullishCandle ||
    closeAbovePrevHigh ||
    closeReclaimEma8;

  const freshBreakdownLow =
    CFG.FVVO_WASHOUT_BLOCK_FRESH_LOW &&
    Number.isFinite(recentLow) &&
    Number.isFinite(p.low) &&
    p.low <= recentLow &&
    !bullishCandle &&
    !closeReclaimEma8;

  const noBearishConflict = !p.fvvoBearishColor || p.fvvoBullishColor || fvvoSlopeStrong;

  const ok =
    rsiWasWashedOut &&
    rsiRecovering &&
    fvvoWasDeep &&
    currentFvvoNotLate &&
    fvvoRecovery &&
    notTooFarBelowEma8 &&
    notTooExtendedFromEma8 &&
    notTooExtendedFromEma18 &&
    priceConfirm &&
    !freshBreakdownLow &&
    noBearishConflict;

  const checks = {
    setup,
    rsiWasWashedOut,
    rsiRecovering,
    fvvoWasDeep,
    currentFvvoNotLate,
    fvvoSlopeStrong,
    fvvoRising,
    fvvoBullishColor: p.fvvoBullishColor,
    fvvoRecovery,
    closeBelowEma8Pct,
    extEma8Pct,
    extEma18Pct,
    notTooFarBelowEma8,
    notTooExtendedFromEma8,
    notTooExtendedFromEma18,
    bullishCandle,
    closeAbovePrevHigh,
    closeReclaimEma8,
    priceConfirm,
    freshBreakdownLow,
    noBearishConflict,
    recentRsiLow,
    recentFvvoLow,
    recentLow,
    prevRsi
  };

  let reason = "NO_WASHOUT_ENTRY";

  if (ok) {
    if (p.fvvoBullishColor) reason = "FVVO_WASHOUT_GREEN";
    else if (fvvoSlopeStrong) reason = "FVVO_WASHOUT_SLOPE_RECOVERY";
    else reason = "FVVO_WASHOUT_RISING";
  } else {
    const failed = [];
    if (!rsiWasWashedOut) failed.push("NO_RSI_WASHOUT");
    if (!rsiRecovering) failed.push("RSI_NOT_RECOVERING");
    if (!fvvoWasDeep) failed.push("FVVO_NOT_DEEP_NEGATIVE");
    if (!currentFvvoNotLate) failed.push("FVVO_RECOVERY_TOO_LATE");
    if (!fvvoRecovery) failed.push("FVVO_NOT_RECOVERING");
    if (!notTooFarBelowEma8) failed.push("PRICE_TOO_FAR_BELOW_EMA8");
    if (!notTooExtendedFromEma8) failed.push("TOO_EXTENDED_EMA8");
    if (!notTooExtendedFromEma18) failed.push("TOO_EXTENDED_EMA18");
    if (!priceConfirm) failed.push("NO_PRICE_CONFIRM");
    if (freshBreakdownLow) failed.push("FRESH_BREAKDOWN_LOW");
    if (!noBearishConflict) failed.push("FVVO_BEARISH_CONFLICT");
    reason = failed.join("+") || "NO_WASHOUT_ENTRY";
  }

  return { ok, setup, reason, checks };
}

// ============================================================
// ENTRY: STRICT CROSS-UP CONFIRM
// ============================================================

function evaluateCrossEntry(p) {
  const setup = "CROSS_UP_CONFIRM";

  if (!CFG.FVVO_LONG_ENABLED) return { ok: false, setup, reason: "FVVO_LONG_DISABLED" };
  if (!CFG.FVVO_CROSS_ENABLED) return { ok: false, setup, reason: "FVVO_CROSS_DISABLED" };

  const fvvoCrossOk = p.fvvoCrossUp && p.fvvoAboveZero && p.fvvoValue > 0;
  const slopeOk = Number.isFinite(p.fvvoSlope) && p.fvvoSlope >= CFG.FVVO_CROSS_MIN_SLOPE;
  const rsiOk = Number.isFinite(p.rsi) && p.rsi >= CFG.FVVO_CROSS_MIN_RSI;
  const priceAboveEma8 = p.close > p.ema8;

  const ema8BelowEma18Pct = p.ema8 < p.ema18 ? calcPct(p.ema18, p.ema8) : 0;
  const emaStructureOk =
    p.ema8 >= p.ema18 ||
    (Number.isFinite(ema8BelowEma18Pct) && ema8BelowEma18Pct <= CFG.FVVO_CROSS_ALLOW_EMA8_BELOW_EMA18_PCT);

  const extEma8Pct = calcPct(p.close, p.ema8);
  const extEma18Pct = calcPct(p.close, p.ema18);

  const notTooExtendedFromEma8 = Number.isFinite(extEma8Pct) && extEma8Pct <= CFG.FVVO_CROSS_MAX_EXT_EMA8_PCT;
  const notTooExtendedFromEma18 = Number.isFinite(extEma18Pct) && extEma18Pct <= CFG.FVVO_CROSS_MAX_EXT_EMA18_PCT;

  const recentRedDotBlocked =
    CFG.FVVO_CROSS_RECENT_REDDOT_BLOCK_BARS > 0 &&
    recentRedDot(p, CFG.FVVO_CROSS_RECENT_REDDOT_BLOCK_BARS);

  const noBearishConflict = !p.fvvoBearishColor || p.fvvoCrossUp || p.burstBullish;

  const ok =
    fvvoCrossOk &&
    slopeOk &&
    rsiOk &&
    priceAboveEma8 &&
    emaStructureOk &&
    notTooExtendedFromEma8 &&
    notTooExtendedFromEma18 &&
    !recentRedDotBlocked &&
    noBearishConflict;

  const checks = {
    setup,
    fvvoCrossOk,
    slopeOk,
    rsiOk,
    priceAboveEma8,
    emaStructureOk,
    notTooExtendedFromEma8,
    notTooExtendedFromEma18,
    recentRedDotBlocked,
    noBearishConflict,
    extEma8Pct,
    extEma18Pct,
    ema8BelowEma18Pct
  };

  let reason = "NO_CROSS_ENTRY";

  if (ok) {
    reason = "FVVO_CROSS_UP_CONFIRM";
  } else {
    const failed = [];
    if (!fvvoCrossOk) failed.push("NO_FRESH_CROSS_UP");
    if (!slopeOk) failed.push("SLOPE_TOO_WEAK");
    if (!rsiOk) failed.push("RSI_TOO_LOW");
    if (!priceAboveEma8) failed.push("PRICE_NOT_ABOVE_EMA8");
    if (!emaStructureOk) failed.push("EMA8_TOO_FAR_BELOW_EMA18");
    if (!notTooExtendedFromEma8) failed.push("TOO_EXTENDED_EMA8");
    if (!notTooExtendedFromEma18) failed.push("TOO_EXTENDED_EMA18");
    if (recentRedDotBlocked) failed.push("RECENT_RED_DOT");
    if (!noBearishConflict) failed.push("FVVO_BEARISH_CONFLICT");
    reason = failed.join("+") || "NO_CROSS_ENTRY";
  }

  return { ok, setup, reason, checks };
}

// ============================================================
// ENTRY: OPTIONAL STRICT ABOVE-ZERO RISING CONTINUATION
// ============================================================

function evaluateRisingContinuationEntry(p) {
  const setup = "RISING_CONTINUATION";

  if (!CFG.FVVO_LONG_ENABLED) return { ok: false, setup, reason: "FVVO_LONG_DISABLED" };
  if (!CFG.FVVO_RISING_CONT_ENABLED) return { ok: false, setup, reason: "FVVO_RISING_CONT_DISABLED" };

  const fvvoOk =
    p.fvvoAboveZero &&
    !p.fvvoCrossUp &&
    Number.isFinite(p.fvvoSlope) &&
    p.fvvoSlope >= CFG.FVVO_RISING_MIN_SLOPE;

  const rsiOk = Number.isFinite(p.rsi) && p.rsi >= CFG.FVVO_RISING_MIN_RSI;
  const priceAboveEma8 = p.close > p.ema8;

  const extEma8Pct = calcPct(p.close, p.ema8);
  const extEma18Pct = calcPct(p.close, p.ema18);

  const notTooExtendedFromEma8 = Number.isFinite(extEma8Pct) && extEma8Pct <= CFG.FVVO_RISING_MAX_EXT_EMA8_PCT;
  const notTooExtendedFromEma18 = Number.isFinite(extEma18Pct) && extEma18Pct <= CFG.FVVO_RISING_MAX_EXT_EMA18_PCT;
  const noRecentRedDot = !recentRedDot(p, CFG.FVVO_CROSS_RECENT_REDDOT_BLOCK_BARS);
  const noBearishConflict = !p.fvvoBearishColor || p.burstBullish;

  const ok =
    fvvoOk &&
    rsiOk &&
    priceAboveEma8 &&
    notTooExtendedFromEma8 &&
    notTooExtendedFromEma18 &&
    noRecentRedDot &&
    noBearishConflict;

  const checks = {
    setup,
    fvvoOk,
    rsiOk,
    priceAboveEma8,
    notTooExtendedFromEma8,
    notTooExtendedFromEma18,
    noRecentRedDot,
    noBearishConflict,
    extEma8Pct,
    extEma18Pct
  };

  let reason = "NO_RISING_CONT_ENTRY";

  if (ok) {
    reason = "FVVO_STRICT_ABOVE_ZERO_RISING";
  } else {
    const failed = [];
    if (!fvvoOk) failed.push("FVVO_RISING_NOT_STRONG");
    if (!rsiOk) failed.push("RSI_TOO_LOW");
    if (!priceAboveEma8) failed.push("PRICE_NOT_ABOVE_EMA8");
    if (!notTooExtendedFromEma8) failed.push("TOO_EXTENDED_EMA8");
    if (!notTooExtendedFromEma18) failed.push("TOO_EXTENDED_EMA18");
    if (!noRecentRedDot) failed.push("RECENT_RED_DOT");
    if (!noBearishConflict) failed.push("FVVO_BEARISH_CONFLICT");
    reason = failed.join("+") || "NO_RISING_CONT_ENTRY";
  }

  return { ok, setup, reason, checks };
}

// ============================================================
// POSITION MANAGEMENT
// ============================================================

function setupPrefix(setup) {
  if (setup === "WASHOUT_REVERSAL") return "FVVO_WASHOUT";
  if (setup === "CROSS_UP_CONFIRM") return "FVVO_CROSS";
  return "FVVO_RISING";
}

function openVirtualLong(p, decision, barNo) {
  const position = {
    side: "LONG",
    setup: decision.setup,
    symbol: p.symbol,
    tf: p.tf,
    entryBarNo: barNo,

    entryPrice: p.close,
    entryTime: p.time,
    entryReceivedAt: nowIso(),
    entryReason: decision.reason,

    entryFvvoValue: p.fvvoValue,
    entryFvvoSignal: p.fvvoSignal,
    entryFvvoSlope: p.fvvoSlope,
    entryRsi: p.rsi,
    entryAdx: p.adx,
    entryEma8: p.ema8,
    entryEma18: p.ema18,

    barsHeld: 0,
    maxPrice: p.close,
    minPrice: p.close,
    peakPnlPct: 0,
    maxDrawdownPct: 0,

    stopPrice:
      CFG.FVVO_MAX_LOSS_EXIT_PCT > 0
        ? p.close * (1 - Math.abs(CFG.FVVO_MAX_LOSS_EXIT_PCT) / 100)
        : null,

    redDotSeen: false,
    backupUsed: false
  };

  state.positions.set(p.symbol, position);
  state.stats.virtualLongOpens += 1;

  if (decision.setup === "WASHOUT_REVERSAL") state.stats.washoutOpens += 1;
  if (decision.setup === "CROSS_UP_CONFIRM") state.stats.crossOpens += 1;
  if (decision.setup === "RISING_CONTINUATION") state.stats.risingOpens += 1;

  logLine(
    `${setupPrefix(decision.setup)}_LONG_OPEN`,
    [
      `🟢 setup=${decision.setup}`,
      `symbol=${p.symbol}`,
      `price=${n(p.close, 4)}`,
      `stop=${position.stopPrice === null ? "na" : n(position.stopPrice, 4)}`,
      `reason=${decision.reason}`,
      `rsi=${n(p.rsi, 2)}`,
      `adx=${n(p.adx, 2)}`,
      `fvvo=${n(p.fvvoValue, 6)}`,
      `signal=${n(p.fvvoSignal, 6)}`,
      `slope=${n(p.fvvoSlope, 6)}`,
      `aboveZero=${boolStr(p.fvvoAboveZero)}`,
      `crossUp=${boolStr(p.fvvoCrossUp)}`,
      `redDot=${boolStr(p.fvvoRedDot)}`,
      `bullishColor=${boolStr(p.fvvoBullishColor)}`,
      `burstBullish=${boolStr(p.burstBullish)}`,
      `sniperBuy=${boolStr(p.sniperBuy)}`
    ].join(" | "),
    decision.checks
  );
}

function updatePositionStats(pos, p) {
  pos.barsHeld += 1;

  if (Number.isFinite(p.high) && p.high > pos.maxPrice) pos.maxPrice = p.high;
  if (Number.isFinite(p.low) && p.low < pos.minPrice) pos.minPrice = p.low;

  const currentPnlPct = calcPct(p.close, pos.entryPrice) || 0;
  const peakPnlPct = calcPct(pos.maxPrice, pos.entryPrice) || 0;
  const drawdownPct = calcPct(pos.minPrice, pos.entryPrice) || 0;

  pos.peakPnlPct = Math.max(pos.peakPnlPct, peakPnlPct);
  pos.maxDrawdownPct = Math.min(pos.maxDrawdownPct, drawdownPct);

  if (p.fvvoRedDot) pos.redDotSeen = true;

  return {
    currentPnlPct,
    peakPnlPct: pos.peakPnlPct,
    givebackPct: pos.peakPnlPct - currentPnlPct,
    drawdownPct: pos.maxDrawdownPct
  };
}

function evaluateLongExit(pos, p, perf) {
  const currentPnlPct = perf.currentPnlPct;
  const peakPnlPct = perf.peakPnlPct;
  const givebackPct = perf.givebackPct;

  const closeLostEma8 = p.close < p.ema8;
  const hardDownSlope = Number.isFinite(p.fvvoSlope) && p.fvvoSlope <= CFG.FVVO_HARD_DOWN_SLOPE;

  const intrabarHardStopHit =
    CFG.FVVO_INTRABAR_HARD_STOP_ENABLED &&
    Number.isFinite(pos.stopPrice) &&
    Number.isFinite(p.low) &&
    p.low <= pos.stopPrice;

  const closeMaxLossHit = currentPnlPct <= -Math.abs(CFG.FVVO_MAX_LOSS_EXIT_PCT);

  const givebackArm2 = peakPnlPct >= CFG.FVVO_GIVEBACK_ARM2_PCT && givebackPct >= CFG.FVVO_GIVEBACK_ARM2_DROP_PCT;
  const givebackArm1 = peakPnlPct >= CFG.FVVO_GIVEBACK_ARM1_PCT && givebackPct >= CFG.FVVO_GIVEBACK_ARM1_DROP_PCT;

  const backupNoRedDot =
    !pos.redDotSeen &&
    !p.fvvoAboveZero &&
    closeLostEma8 &&
    currentPnlPct >= CFG.FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT &&
    givebackPct >= CFG.FVVO_GIVEBACK_ARM1_DROP_PCT;

  const crossDownExit = p.fvvoCrossDown && currentPnlPct >= CFG.FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT;
  const hardSlopeExit = hardDownSlope && currentPnlPct >= CFG.FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT;

  const ema8LossProfitExit =
    closeLostEma8 &&
    currentPnlPct >= CFG.FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT &&
    givebackPct >= CFG.FVVO_GIVEBACK_ARM1_DROP_PCT;

  const maxHoldExit = CFG.FVVO_MAX_HOLD_BARS > 0 && pos.barsHeld >= CFG.FVVO_MAX_HOLD_BARS;

  if (intrabarHardStopHit) {
    return { exit: true, reason: "FVVO_INTRABAR_HARD_STOP", backupUsed: true, exitPrice: pos.stopPrice };
  }

  if (p.fvvoRedDot) {
    return { exit: true, reason: "FVVO_RED_DOT", backupUsed: false, exitPrice: p.close };
  }

  if (closeMaxLossHit) {
    return { exit: true, reason: "FVVO_CLOSE_MAX_LOSS_EXIT", backupUsed: true, exitPrice: p.close };
  }

  if (givebackArm2) {
    return { exit: true, reason: "FVVO_GIVEBACK_ARM2", backupUsed: true, exitPrice: p.close };
  }

  if (givebackArm1) {
    return { exit: true, reason: "FVVO_GIVEBACK_ARM1", backupUsed: true, exitPrice: p.close };
  }

  if (backupNoRedDot) {
    return { exit: true, reason: "FVVO_NO_RED_DOT_BACKUP_ZERO_LOSS_EMA8_GIVEBACK", backupUsed: true, exitPrice: p.close };
  }

  if (crossDownExit) {
    return { exit: true, reason: "FVVO_CROSS_DOWN_BACKUP", backupUsed: true, exitPrice: p.close };
  }

  if (hardSlopeExit) {
    return { exit: true, reason: "FVVO_HARD_DOWN_SLOPE_BACKUP", backupUsed: true, exitPrice: p.close };
  }

  if (ema8LossProfitExit) {
    return { exit: true, reason: "FVVO_EMA8_LOSS_PROFIT_BACKUP", backupUsed: true, exitPrice: p.close };
  }

  if (maxHoldExit) {
    return { exit: true, reason: "FVVO_MAX_HOLD_BARS_EXIT", backupUsed: true, exitPrice: p.close };
  }

  return { exit: false, reason: "HOLD", backupUsed: false, exitPrice: null };
}

function closeVirtualLong(pos, p, perf, exitDecision, barNo) {
  const exitPrice =
    Number.isFinite(exitDecision.exitPrice) && exitDecision.exitPrice > 0
      ? exitDecision.exitPrice
      : p.close;

  const pnlPct = calcPct(exitPrice, pos.entryPrice) || 0;
  const maxRunupPct = perf.peakPnlPct;
  const givebackPct = maxRunupPct - pnlPct;

  state.positions.delete(pos.symbol);
  state.lastExitBar.set(pos.symbol, barNo);

  state.stats.virtualLongExits += 1;
  state.stats.totalPnlPct += pnlPct;

  if (pos.setup === "WASHOUT_REVERSAL") {
    state.stats.washoutExits += 1;
    state.stats.washoutPnlPct += pnlPct;
  }

  if (pos.setup === "CROSS_UP_CONFIRM") {
    state.stats.crossExits += 1;
    state.stats.crossPnlPct += pnlPct;
  }

  if (pos.setup === "RISING_CONTINUATION") {
    state.stats.risingExits += 1;
    state.stats.risingPnlPct += pnlPct;
  }

  if (pnlPct > 0.03) state.stats.wins += 1;
  else if (pnlPct < -0.03) state.stats.losses += 1;
  else state.stats.flats += 1;

  if (state.stats.bestPnlPct === null || pnlPct > state.stats.bestPnlPct) state.stats.bestPnlPct = pnlPct;
  if (state.stats.worstPnlPct === null || pnlPct < state.stats.worstPnlPct) state.stats.worstPnlPct = pnlPct;
  if (state.stats.bestRunupPct === null || maxRunupPct > state.stats.bestRunupPct) state.stats.bestRunupPct = maxRunupPct;

  if (exitDecision.reason === "FVVO_RED_DOT") state.stats.redDotExits += 1;
  if (exitDecision.backupUsed) state.stats.backupExits += 1;
  if (exitDecision.reason === "FVVO_INTRABAR_HARD_STOP") state.stats.intrabarHardStopExits += 1;
  if (exitDecision.reason === "FVVO_CLOSE_MAX_LOSS_EXIT") state.stats.closeMaxLossExits += 1;
  if (exitDecision.reason === "FVVO_MAX_HOLD_BARS_EXIT") state.stats.maxHoldExits += 1;

  const result = pnlPct > 0.03 ? "WIN" : pnlPct < -0.03 ? "LOSS" : "FLAT";
  const prefix = setupPrefix(pos.setup);

  logLine(
    `${prefix}_LONG_EXIT_SIGNAL`,
    [
      `🔴 setup=${pos.setup}`,
      `symbol=${p.symbol}`,
      `exitPrice=${n(exitPrice, 4)}`,
      `close=${n(p.close, 4)}`,
      `low=${n(p.low, 4)}`,
      `stop=${pos.stopPrice === null ? "na" : n(pos.stopPrice, 4)}`,
      `pnl=${pct(pnlPct)}`,
      `peak=${pct(maxRunupPct)}`,
      `giveback=${pct(givebackPct)}`,
      `barsHeld=${pos.barsHeld}`,
      `reason=${exitDecision.reason}`,
      `redDotSeen=${boolStr(pos.redDotSeen)}`,
      `backupUsed=${boolStr(exitDecision.backupUsed)}`,
      `fvvo=${n(p.fvvoValue, 6)}`,
      `slope=${n(p.fvvoSlope, 6)}`,
      `aboveZero=${boolStr(p.fvvoAboveZero)}`,
      `crossDown=${boolStr(p.fvvoCrossDown)}`
    ].join(" | ")
  );

  logLine(
    `${prefix}_LONG_RESULT`,
    [
      `📊 result=${result}`,
      `setup=${pos.setup}`,
      `symbol=${p.symbol}`,
      `entry=${n(pos.entryPrice, 4)}`,
      `exit=${n(exitPrice, 4)}`,
      `pnl=${pct(pnlPct)}`,
      `maxRunup=${pct(maxRunupPct)}`,
      `maxDrawdown=${pct(pos.maxDrawdownPct)}`,
      `entryReason=${pos.entryReason}`,
      `exitReason=${exitDecision.reason}`,
      `redDotSeen=${boolStr(pos.redDotSeen)}`,
      `backupUsed=${boolStr(exitDecision.backupUsed)}`,
      `barsHeld=${pos.barsHeld}`
    ].join(" | ")
  );

  logScorecard();
}

// ============================================================
// SHORT OBSERVATION ONLY
// ============================================================

function observeShortSignal(p) {
  if (CFG.FVVO_SHORT_ENABLED) return;

  const shortSignal =
    p.fvvoCrossDown ||
    p.fvvoRedDot ||
    p.burstBearish ||
    p.sniperSell ||
    p.fvvoBearishColor;

  if (!shortSignal) return;

  logLine(
    "FVVO_RAW_SHORT_SIGNAL",
    [
      `⚠️ observationOnly=true`,
      `symbol=${p.symbol}`,
      `price=${n(p.close, 4)}`,
      `redDot=${boolStr(p.fvvoRedDot)}`,
      `crossDown=${boolStr(p.fvvoCrossDown)}`,
      `bearishColor=${boolStr(p.fvvoBearishColor)}`,
      `sniperSell=${boolStr(p.sniperSell)}`,
      `burstBearish=${boolStr(p.burstBearish)}`,
      `fvvo=${n(p.fvvoValue, 6)}`,
      `slope=${n(p.fvvoSlope, 6)}`
    ].join(" | ")
  );
}

// ============================================================
// SCORECARD
// ============================================================

function avg(total, count) {
  return count > 0 ? total / count : 0;
}

function logScorecard() {
  const exits = state.stats.virtualLongExits;
  const avgPnl = avg(state.stats.totalPnlPct, exits);
  const winRate = exits > 0 ? (state.stats.wins / exits) * 100 : 0;

  const washoutAvg = avg(state.stats.washoutPnlPct, state.stats.washoutExits);
  const crossAvg = avg(state.stats.crossPnlPct, state.stats.crossExits);
  const risingAvg = avg(state.stats.risingPnlPct, state.stats.risingExits);

  logLine(
    "FVVO_RAW_SCORECARD_RESULT",
    [
      `📈 trades=${exits}`,
      `wins=${state.stats.wins}`,
      `losses=${state.stats.losses}`,
      `flats=${state.stats.flats}`,
      `winRate=${pct(winRate, 1)}`,
      `avgPnl=${pct(avgPnl)}`,
      `totalPnl=${pct(state.stats.totalPnlPct)}`,
      `best=${state.stats.bestPnlPct === null ? "na" : pct(state.stats.bestPnlPct)}`,
      `worst=${state.stats.worstPnlPct === null ? "na" : pct(state.stats.worstPnlPct)}`,
      `bestRunup=${state.stats.bestRunupPct === null ? "na" : pct(state.stats.bestRunupPct)}`,
      `redDotExits=${state.stats.redDotExits}`,
      `backupExits=${state.stats.backupExits}`,
      `intrabarHardStops=${state.stats.intrabarHardStopExits}`,
      `closeMaxLossExits=${state.stats.closeMaxLossExits}`,
      `maxHoldExits=${state.stats.maxHoldExits}`,
      `washoutTrades=${state.stats.washoutExits}`,
      `washoutAvg=${pct(washoutAvg)}`,
      `washoutTotal=${pct(state.stats.washoutPnlPct)}`,
      `crossTrades=${state.stats.crossExits}`,
      `crossAvg=${pct(crossAvg)}`,
      `crossTotal=${pct(state.stats.crossPnlPct)}`,
      `risingTrades=${state.stats.risingExits}`,
      `risingAvg=${pct(risingAvg)}`,
      `risingTotal=${pct(state.stats.risingPnlPct)}`
    ].join(" | ")
  );
}

// ============================================================
// MAIN HANDLER
// ============================================================

function handleFeature(p) {
  state.stats.accepted += 1;
  const barNo = nextBarNumber(p.symbol);

  if (CFG.DEBUG) {
    logLine(
      "FEATURE_5M_FVVO",
      [
        `symbol=${p.symbol}`,
        `open=${n(p.open, 4)}`,
        `high=${n(p.high, 4)}`,
        `low=${n(p.low, 4)}`,
        `close=${n(p.close, 4)}`,
        `ema8=${n(p.ema8, 4)}`,
        `ema18=${n(p.ema18, 4)}`,
        `rsi=${n(p.rsi, 2)}`,
        `adx=${n(p.adx, 2)}`,
        `fvvo=${n(p.fvvoValue, 6)}`,
        `signal=${n(p.fvvoSignal, 6)}`,
        `slope=${n(p.fvvoSlope, 6)}`,
        `aboveZero=${boolStr(p.fvvoAboveZero)}`,
        `crossUp=${boolStr(p.fvvoCrossUp)}`,
        `crossDown=${boolStr(p.fvvoCrossDown)}`,
        `redDot=${boolStr(p.fvvoRedDot)}`,
        `bullishColor=${boolStr(p.fvvoBullishColor)}`
      ].join(" | ")
    );
  }

  observeShortSignal(p);

  const openPos = state.positions.get(p.symbol);

  if (openPos) {
    const perf = updatePositionStats(openPos, p);
    const exitDecision = evaluateLongExit(openPos, p, perf);

    if (exitDecision.exit) {
      closeVirtualLong(openPos, p, perf, exitDecision, barNo);
    } else if (CFG.DEBUG) {
      logLine(
        `${setupPrefix(openPos.setup)}_LONG_HOLD`,
        [
          `🟡 setup=${openPos.setup}`,
          `symbol=${p.symbol}`,
          `price=${n(p.close, 4)}`,
          `low=${n(p.low, 4)}`,
          `stop=${openPos.stopPrice === null ? "na" : n(openPos.stopPrice, 4)}`,
          `pnl=${pct(perf.currentPnlPct)}`,
          `peak=${pct(perf.peakPnlPct)}`,
          `giveback=${pct(perf.givebackPct)}`,
          `barsHeld=${openPos.barsHeld}`,
          `fvvo=${n(p.fvvoValue, 6)}`,
          `slope=${n(p.fvvoSlope, 6)}`,
          `redDot=${boolStr(p.fvvoRedDot)}`
        ].join(" | ")
      );
    }

    state.lastFeature.set(p.symbol, p);
    pushHistory(p);
    return;
  }

  if (isEntryCooldownActive(p.symbol, barNo)) {
    if (CFG.DEBUG) {
      logLine(
        "FVVO_RAW_LONG_NO_ENTRY",
        [
          `symbol=${p.symbol}`,
          `price=${n(p.close, 4)}`,
          `reason=ENTRY_COOLDOWN`,
          `barNo=${barNo}`,
          `cooldownBars=${CFG.FVVO_ENTRY_COOLDOWN_BARS}`,
          `rsi=${n(p.rsi, 2)}`,
          `fvvo=${n(p.fvvoValue, 6)}`,
          `slope=${n(p.fvvoSlope, 6)}`,
          `aboveZero=${boolStr(p.fvvoAboveZero)}`,
          `crossUp=${boolStr(p.fvvoCrossUp)}`
        ].join(" | ")
      );
    }

    state.lastFeature.set(p.symbol, p);
    pushHistory(p);
    return;
  }

  const washoutDecision = evaluateWashoutEntry(p);
  const crossDecision = evaluateCrossEntry(p);
  const risingDecision = evaluateRisingContinuationEntry(p);

  if (washoutDecision.ok) {
    state.stats.washoutSignals += 1;
    logLine(
      "FVVO_WASHOUT_LONG_SIGNAL",
      [
        `🧪 symbol=${p.symbol}`,
        `price=${n(p.close, 4)}`,
        `reason=${washoutDecision.reason}`,
        `rsi=${n(p.rsi, 2)}`,
        `fvvo=${n(p.fvvoValue, 6)}`,
        `slope=${n(p.fvvoSlope, 6)}`,
        `aboveZero=${boolStr(p.fvvoAboveZero)}`,
        `bullishColor=${boolStr(p.fvvoBullishColor)}`
      ].join(" | "),
      washoutDecision.checks
    );
  }

  if (crossDecision.ok) {
    state.stats.crossSignals += 1;
    logLine(
      "FVVO_CROSS_LONG_SIGNAL",
      [
        `🧪 symbol=${p.symbol}`,
        `price=${n(p.close, 4)}`,
        `reason=${crossDecision.reason}`,
        `rsi=${n(p.rsi, 2)}`,
        `fvvo=${n(p.fvvoValue, 6)}`,
        `slope=${n(p.fvvoSlope, 6)}`,
        `crossUp=${boolStr(p.fvvoCrossUp)}`
      ].join(" | "),
      crossDecision.checks
    );
  }

  if (risingDecision.ok) {
    state.stats.risingSignals += 1;
    logLine(
      "FVVO_RISING_LONG_SIGNAL",
      [
        `🧪 symbol=${p.symbol}`,
        `price=${n(p.close, 4)}`,
        `reason=${risingDecision.reason}`,
        `rsi=${n(p.rsi, 2)}`,
        `fvvo=${n(p.fvvoValue, 6)}`,
        `slope=${n(p.fvvoSlope, 6)}`
      ].join(" | "),
      risingDecision.checks
    );
  }

  // Priority:
  // 1. Washout reversal catches earlier bounce from RSI/FVVO washout.
  // 2. Strict cross-up confirmation catches confirmed zero-line reclaim.
  // 3. Strict rising continuation only if explicitly enabled.
  let chosenDecision = null;

  if (washoutDecision.ok) chosenDecision = washoutDecision;
  else if (crossDecision.ok) chosenDecision = crossDecision;
  else if (risingDecision.ok) chosenDecision = risingDecision;

  if (chosenDecision) {
    openVirtualLong(p, chosenDecision, barNo);
  } else if (CFG.DEBUG) {
    logLine(
      "FVVO_RAW_LONG_NO_ENTRY",
      [
        `symbol=${p.symbol}`,
        `price=${n(p.close, 4)}`,
        `washout=${washoutDecision.reason}`,
        `cross=${crossDecision.reason}`,
        `rising=${risingDecision.reason}`,
        `rsi=${n(p.rsi, 2)}`,
        `fvvo=${n(p.fvvoValue, 6)}`,
        `slope=${n(p.fvvoSlope, 6)}`,
        `aboveZero=${boolStr(p.fvvoAboveZero)}`,
        `crossUp=${boolStr(p.fvvoCrossUp)}`,
        `redDot=${boolStr(p.fvvoRedDot)}`,
        `bullishColor=${boolStr(p.fvvoBullishColor)}`
      ].join(" | ")
    );
  }

  state.lastFeature.set(p.symbol, p);
  pushHistory(p);
}

// ============================================================
// ROUTES
// ============================================================

app.get("/", (req, res) => {
  res.json({
    ok: true,
    brain: CFG.BRAIN_NAME,
    mode: "SHADOW_ONLY",
    startedAt: state.startedAt,
    symbol: CFG.SYMBOL,
    tf: CFG.ENTRY_TF
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    brain: CFG.BRAIN_NAME,
    startedAt: state.startedAt,
    now: nowIso(),
    stats: state.stats,
    openPositions: Array.from(state.positions.values()).map((p) => ({
      symbol: p.symbol,
      side: p.side,
      setup: p.setup,
      entryPrice: p.entryPrice,
      stopPrice: p.stopPrice,
      entryTime: p.entryTime,
      entryReason: p.entryReason,
      barsHeld: p.barsHeld,
      peakPnlPct: p.peakPnlPct,
      redDotSeen: p.redDotSeen
    }))
  });
});

app.post(CFG.WEBHOOK_PATH, (req, res) => {
  state.stats.received += 1;

  let payload;

  try {
    payload = normalizePayload(req.body);
  } catch (err) {
    state.stats.rejected += 1;
    logLine("REJECT", `NORMALIZE_ERROR | ${err.message}`);
    return res.status(400).json({ ok: false, reason: "NORMALIZE_ERROR" });
  }

  const valid = validatePayload(payload);

  if (!valid.ok) {
    state.stats.rejected += 1;
    logLine("REJECT", `${valid.reason}`);
    return res.status(400).json({ ok: false, reason: valid.reason });
  }

  if (isDuplicateBar(payload)) {
    state.stats.duplicates += 1;
    logLine("DUPLICATE", `ignored duplicate bar | symbol=${payload.symbol} | tf=${payload.tf} | time=${payload.time}`);
    return res.json({ ok: true, duplicate: true, brain: CFG.BRAIN_NAME });
  }

  try {
    handleFeature(payload);
  } catch (err) {
    state.stats.rejected += 1;
    logLine("ERROR", `HANDLE_FEATURE_ERROR | ${err.stack || err.message}`);
    return res.status(500).json({ ok: false, reason: "HANDLE_FEATURE_ERROR" });
  }

  return res.json({ ok: true, brain: CFG.BRAIN_NAME, shadowOnly: true });
});

// ============================================================
// STARTUP
// ============================================================

app.listen(CFG.PORT, () => {
  console.log("============================================================");
  console.log(`${CFG.BRAIN_NAME} started`);
  console.log("============================================================");
  console.log(`PORT=${CFG.PORT}`);
  console.log(`WEBHOOK_PATH=${CFG.WEBHOOK_PATH}`);
  console.log(`SYMBOL=${CFG.SYMBOL}`);
  console.log(`ENTRY_TF=${CFG.ENTRY_TF}`);
  console.log(`SHADOW_ONLY=${CFG.SHADOW_ONLY}`);
  console.log(`ENABLE_HTTP_FORWARD=${CFG.ENABLE_HTTP_FORWARD}`);
  console.log(`FVVO_LONG_ENABLED=${CFG.FVVO_LONG_ENABLED}`);
  console.log(`FVVO_SHORT_ENABLED=${CFG.FVVO_SHORT_ENABLED}`);
  console.log(`FVVO_ENTRY_COOLDOWN_BARS=${CFG.FVVO_ENTRY_COOLDOWN_BARS}`);
  console.log("------------------------------------------------------------");
  console.log(`FVVO_WASHOUT_ENABLED=${CFG.FVVO_WASHOUT_ENABLED}`);
  console.log(`FVVO_WASHOUT_LOOKBACK_BARS=${CFG.FVVO_WASHOUT_LOOKBACK_BARS}`);
  console.log(`FVVO_WASHOUT_RSI_MAX=${CFG.FVVO_WASHOUT_RSI_MAX}`);
  console.log(`FVVO_WASHOUT_RSI_RECOVER_MIN=${CFG.FVVO_WASHOUT_RSI_RECOVER_MIN}`);
  console.log(`FVVO_WASHOUT_MIN_DEEP_NEGATIVE=${CFG.FVVO_WASHOUT_MIN_DEEP_NEGATIVE}`);
  console.log(`FVVO_WASHOUT_MIN_SLOPE=${CFG.FVVO_WASHOUT_MIN_SLOPE}`);
  console.log(`FVVO_WASHOUT_MAX_CURRENT_FVVO=${CFG.FVVO_WASHOUT_MAX_CURRENT_FVVO}`);
  console.log(`FVVO_WASHOUT_MAX_BELOW_EMA8_PCT=${CFG.FVVO_WASHOUT_MAX_BELOW_EMA8_PCT}`);
  console.log(`FVVO_WASHOUT_MAX_EXT_EMA8_PCT=${CFG.FVVO_WASHOUT_MAX_EXT_EMA8_PCT}`);
  console.log(`FVVO_WASHOUT_MAX_EXT_EMA18_PCT=${CFG.FVVO_WASHOUT_MAX_EXT_EMA18_PCT}`);
  console.log(`FVVO_WASHOUT_BLOCK_FRESH_LOW=${CFG.FVVO_WASHOUT_BLOCK_FRESH_LOW}`);
  console.log(`FVVO_WASHOUT_REQUIRE_PRICE_CONFIRM=${CFG.FVVO_WASHOUT_REQUIRE_PRICE_CONFIRM}`);
  console.log("------------------------------------------------------------");
  console.log(`FVVO_CROSS_ENABLED=${CFG.FVVO_CROSS_ENABLED}`);
  console.log(`FVVO_CROSS_MIN_RSI=${CFG.FVVO_CROSS_MIN_RSI}`);
  console.log(`FVVO_CROSS_MIN_SLOPE=${CFG.FVVO_CROSS_MIN_SLOPE}`);
  console.log(`FVVO_CROSS_MAX_EXT_EMA8_PCT=${CFG.FVVO_CROSS_MAX_EXT_EMA8_PCT}`);
  console.log(`FVVO_CROSS_MAX_EXT_EMA18_PCT=${CFG.FVVO_CROSS_MAX_EXT_EMA18_PCT}`);
  console.log(`FVVO_CROSS_ALLOW_EMA8_BELOW_EMA18_PCT=${CFG.FVVO_CROSS_ALLOW_EMA8_BELOW_EMA18_PCT}`);
  console.log(`FVVO_CROSS_RECENT_REDDOT_BLOCK_BARS=${CFG.FVVO_CROSS_RECENT_REDDOT_BLOCK_BARS}`);
  console.log("------------------------------------------------------------");
  console.log(`FVVO_RISING_CONT_ENABLED=${CFG.FVVO_RISING_CONT_ENABLED}`);
  console.log(`FVVO_RISING_MIN_RSI=${CFG.FVVO_RISING_MIN_RSI}`);
  console.log(`FVVO_RISING_MIN_SLOPE=${CFG.FVVO_RISING_MIN_SLOPE}`);
  console.log(`FVVO_RISING_MAX_EXT_EMA8_PCT=${CFG.FVVO_RISING_MAX_EXT_EMA8_PCT}`);
  console.log(`FVVO_RISING_MAX_EXT_EMA18_PCT=${CFG.FVVO_RISING_MAX_EXT_EMA18_PCT}`);
  console.log("------------------------------------------------------------");
  console.log(`FVVO_INTRABAR_HARD_STOP_ENABLED=${CFG.FVVO_INTRABAR_HARD_STOP_ENABLED}`);
  console.log(`FVVO_MAX_LOSS_EXIT_PCT=${CFG.FVVO_MAX_LOSS_EXIT_PCT}`);
  console.log(`FVVO_GIVEBACK_ARM1_PCT=${CFG.FVVO_GIVEBACK_ARM1_PCT}`);
  console.log(`FVVO_GIVEBACK_ARM1_DROP_PCT=${CFG.FVVO_GIVEBACK_ARM1_DROP_PCT}`);
  console.log(`FVVO_GIVEBACK_ARM2_PCT=${CFG.FVVO_GIVEBACK_ARM2_PCT}`);
  console.log(`FVVO_GIVEBACK_ARM2_DROP_PCT=${CFG.FVVO_GIVEBACK_ARM2_DROP_PCT}`);
  console.log(`FVVO_HARD_DOWN_SLOPE=${CFG.FVVO_HARD_DOWN_SLOPE}`);
  console.log(`FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT=${CFG.FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT}`);
  console.log(`FVVO_MAX_HOLD_BARS=${CFG.FVVO_MAX_HOLD_BARS}`);
  console.log("============================================================");
});
