// ============================================================
// BrainFVVO_v1a_SHADOW
// Standalone FVVO shadow brain
// ------------------------------------------------------------
// Purpose:
// - Receive FVVO raw 5m feature JSON from TradingView
// - Simulate FVVO-only shadow long entries/exits
// - Compare continuation vs deep reversal setups
// - Add low-based intrabar hard-stop simulation
// - No real 3Commas forwarding in v1a
//
// Main Ray brain remains separate:
// BrainRAY_Continuation_v6.7j_FVVO_SYNC_10S_SHADOW_DEMO
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
  BRAIN_NAME: envStr("BRAIN_NAME", "BrainFVVO_v1a_SHADOW"),
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

  // Continuation entry rules
  FVVO_CONTINUATION_ENABLED: envBool("FVVO_CONTINUATION_ENABLED", true),
  FVVO_ENTRY_MIN_RSI: envNum("FVVO_ENTRY_MIN_RSI", 52),
  FVVO_ENTRY_MIN_ADX: envNum("FVVO_ENTRY_MIN_ADX", 0),
  FVVO_ENTRY_MIN_SLOPE: envNum("FVVO_ENTRY_MIN_SLOPE", 0.30),
  FVVO_ENTRY_MAX_EXT_EMA8_PCT: envNum("FVVO_ENTRY_MAX_EXT_EMA8_PCT", 0.40),
  FVVO_ENTRY_MAX_EXT_EMA18_PCT: envNum("FVVO_ENTRY_MAX_EXT_EMA18_PCT", 0.85),
  FVVO_ENTRY_ALLOW_EMA8_BELOW_EMA18_PCT: envNum("FVVO_ENTRY_ALLOW_EMA8_BELOW_EMA18_PCT", 0.10),

  // Deep reversal setup
  FVVO_REVERSAL_ENABLED: envBool("FVVO_REVERSAL_ENABLED", true),
  FVVO_REVERSAL_LOOKBACK_BARS: envNum("FVVO_REVERSAL_LOOKBACK_BARS", 8),
  FVVO_REVERSAL_RSI_WASHOUT_MAX: envNum("FVVO_REVERSAL_RSI_WASHOUT_MAX", 30),
  FVVO_REVERSAL_RSI_RECOVER_MIN: envNum("FVVO_REVERSAL_RSI_RECOVER_MIN", 34),
  FVVO_REVERSAL_MIN_DEEP_NEGATIVE: envNum("FVVO_REVERSAL_MIN_DEEP_NEGATIVE", -3.0),
  FVVO_REVERSAL_MIN_SLOPE: envNum("FVVO_REVERSAL_MIN_SLOPE", 0.50),
  FVVO_REVERSAL_MAX_BELOW_EMA8_PCT: envNum("FVVO_REVERSAL_MAX_BELOW_EMA8_PCT", 0.35),
  FVVO_REVERSAL_REQUIRE_PRICE_CONFIRM: envBool("FVVO_REVERSAL_REQUIRE_PRICE_CONFIRM", true),
  FVVO_REVERSAL_ALLOW_BULLISH_COLOR: envBool("FVVO_REVERSAL_ALLOW_BULLISH_COLOR", true),
  FVVO_REVERSAL_BLOCK_FRESH_LOW: envBool("FVVO_REVERSAL_BLOCK_FRESH_LOW", true),

  // Exit rules
  FVVO_GIVEBACK_ARM1_PCT: envNum("FVVO_GIVEBACK_ARM1_PCT", 0.30),
  FVVO_GIVEBACK_ARM1_DROP_PCT: envNum("FVVO_GIVEBACK_ARM1_DROP_PCT", 0.15),

  FVVO_GIVEBACK_ARM2_PCT: envNum("FVVO_GIVEBACK_ARM2_PCT", 0.50),
  FVVO_GIVEBACK_ARM2_DROP_PCT: envNum("FVVO_GIVEBACK_ARM2_DROP_PCT", 0.22),

  FVVO_HARD_DOWN_SLOPE: envNum("FVVO_HARD_DOWN_SLOPE", -0.08),
  FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT: envNum("FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT", 0.05),

  FVVO_INTRABAR_HARD_STOP_ENABLED: envBool("FVVO_INTRABAR_HARD_STOP_ENABLED", true),
  FVVO_MAX_LOSS_EXIT_PCT: envNum("FVVO_MAX_LOSS_EXIT_PCT", 0.45),
  FVVO_MAX_HOLD_BARS: envNum("FVVO_MAX_HOLD_BARS", 36),

  // Safety / duplicate handling
  BAR_DEDUP_ENABLED: envBool("BAR_DEDUP_ENABLED", true),

  // Internal memory
  HISTORY_MAX_BARS: envNum("HISTORY_MAX_BARS", 80)
};

// Hard safety for v1a.
if (!CFG.SHADOW_ONLY || CFG.ENABLE_HTTP_FORWARD) {
  console.log("⚠️ SAFETY: BrainFVVO_v1a_SHADOW is designed for SHADOW ONLY.");
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

  // symbol -> open virtual position
  positions: new Map(),

  // symbol -> last FVVO bar data
  lastFeature: new Map(),

  // symbol -> feature history array
  history: new Map(),

  // symbol|tf|time -> seen
  seenBars: new Set(),

  stats: {
    received: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,

    virtualLongOpens: 0,
    virtualLongExits: 0,

    continuationOpens: 0,
    continuationExits: 0,
    continuationPnlPct: 0,

    reversalSignals: 0,
    reversalOpens: 0,
    reversalExits: 0,
    reversalPnlPct: 0,

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
    maxLossExits: 0,
    maxHoldExits: 0
  }
};

// ============================================================
// FORMAT HELPERS
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
  if (obj && CFG.DEBUG) {
    console.log(`${prefix} | ${msg} | ${JSON.stringify(obj)}`);
  } else {
    console.log(`${prefix} | ${msg}`);
  }
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

function maxOf(arr, key) {
  const vals = arr.map((x) => safeNum(x[key], null)).filter((x) => Number.isFinite(x));
  if (!vals.length) return null;
  return Math.max(...vals);
}

function risingTwoBars(symbol, key) {
  const arr = getHistory(symbol);
  if (arr.length < 2) return false;
  const a = arr[arr.length - 2];
  const b = arr[arr.length - 1];
  const av = safeNum(a[key], null);
  const bv = safeNum(b[key], null);
  if (!Number.isFinite(av) || !Number.isFinite(bv)) return false;
  return bv > av;
}

// ============================================================
// PAYLOAD NORMALIZATION
// ============================================================

function normalizePayload(body) {
  const p = body || {};

  const symbol = strFromPayload(p.symbol, CFG.SYMBOL);
  const tf = strFromPayload(p.tf, CFG.ENTRY_TF);
  const event = strFromPayload(p.event, "");

  const close = safeNum(p.close, safeNum(p.price, null));
  const price = safeNum(p.price, close);
  const open = safeNum(p.open, close);
  const high = safeNum(p.high, close);
  const low = safeNum(p.low, close);

  const ema8 = safeNum(p.ema8, null);
  const ema18 = safeNum(p.ema18, null);
  const ema50 = safeNum(p.ema50, null);
  const rsi = safeNum(p.rsi, null);
  const adx = safeNum(p.adx, null);
  const atrPct = safeNum(p.atrPct, null);

  const fvvoValue = safeNum(p.fvvoValue, null);
  const fvvoSignal = safeNum(p.fvvoSignal, null);

  const last = state.lastFeature.get(symbol);
  const prevFvvoValue = last ? last.fvvoValue : null;

  let fvvoSlope = safeNum(p.fvvoSlope, null);
  if (fvvoSlope === null && fvvoValue !== null && prevFvvoValue !== null) {
    fvvoSlope = fvvoValue - prevFvvoValue;
  }

  let fvvoAboveZero = safeBool(p.fvvoAboveZero, false);
  if (fvvoValue !== null) {
    fvvoAboveZero = fvvoValue > 0;
  }

  let fvvoCrossUp = safeBool(p.fvvoCrossUp, false);
  let fvvoCrossDown = safeBool(p.fvvoCrossDown, false);

  if (fvvoValue !== null && prevFvvoValue !== null) {
    fvvoCrossUp = prevFvvoValue <= 0 && fvvoValue > 0;
    fvvoCrossDown = prevFvvoValue >= 0 && fvvoValue < 0;
  }

  return {
    raw: p,

    secret: strFromPayload(p.secret, ""),
    src: strFromPayload(p.src, ""),
    brain: strFromPayload(p.brain, ""),
    version: strFromPayload(p.version, ""),
    symbol,
    tf,
    event,

    price,
    time: strFromPayload(p.time, nowIso()),

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

    fvvoRedDot: safeBool(p.fvvoRedDot, false),
    fvvoBullishColor: safeBool(p.fvvoBullishColor, false),
    fvvoBearishColor: safeBool(p.fvvoBearishColor, false),

    sniperBuy: safeBool(p.sniperBuy, false),
    sniperSell: safeBool(p.sniperSell, false),
    burstBullish: safeBool(p.burstBullish, false),
    burstBearish: safeBool(p.burstBearish, false)
  };
}

function strFromPayload(v, fallback = "") {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  return s === "" ? fallback : s;
}

// ============================================================
// VALIDATION
// ============================================================

function validatePayload(p) {
  if (!p) return { ok: false, reason: "EMPTY_PAYLOAD" };

  if (CFG.WEBHOOK_SECRET && CFG.WEBHOOK_SECRET !== "CHANGE_ME_TO_RANDOM_SECRET") {
    if (p.secret !== CFG.WEBHOOK_SECRET) {
      return { ok: false, reason: "BAD_SECRET" };
    }
  }

  if (p.symbol !== CFG.SYMBOL) {
    return { ok: false, reason: `SYMBOL_MISMATCH:${p.symbol}` };
  }

  if (p.tf !== CFG.ENTRY_TF) {
    return { ok: false, reason: `TF_MISMATCH:${p.tf}` };
  }

  if (p.event !== "FEATURE_5M_FVVO") {
    return { ok: false, reason: `UNSUPPORTED_EVENT:${p.event}` };
  }

  if (!Number.isFinite(p.close) || p.close <= 0) {
    return { ok: false, reason: "BAD_CLOSE" };
  }

  if (!Number.isFinite(p.ema8) || !Number.isFinite(p.ema18)) {
    return { ok: false, reason: "MISSING_EMA8_OR_EMA18" };
  }

  if (!Number.isFinite(p.rsi)) {
    return { ok: false, reason: "MISSING_RSI" };
  }

  if (!Number.isFinite(p.fvvoValue)) {
    return { ok: false, reason: "MISSING_FVVO_VALUE" };
  }

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
// ENTRY LOGIC: CONTINUATION
// ============================================================

function evaluateContinuationEntry(p) {
  if (!CFG.FVVO_LONG_ENABLED) {
    return {
      ok: false,
      setup: "CONTINUATION",
      reason: "FVVO_LONG_DISABLED"
    };
  }

  if (!CFG.FVVO_CONTINUATION_ENABLED) {
    return {
      ok: false,
      setup: "CONTINUATION",
      reason: "FVVO_CONTINUATION_DISABLED"
    };
  }

  const fvvoCrossEntry =
    p.fvvoCrossUp &&
    p.fvvoValue > 0 &&
    Number.isFinite(p.fvvoSlope) &&
    p.fvvoSlope >= CFG.FVVO_ENTRY_MIN_SLOPE;

  const fvvoAboveZeroRising =
    p.fvvoAboveZero &&
    Number.isFinite(p.fvvoSlope) &&
    p.fvvoSlope >= CFG.FVVO_ENTRY_MIN_SLOPE;

  const fvvoBullish = fvvoCrossEntry || fvvoAboveZeroRising;

  const priceAboveEma8 = p.close > p.ema8;

  const ema8BelowEma18Pct = p.ema8 < p.ema18 ? calcPct(p.ema18, p.ema8) : 0;
  const emaStructureOk =
    p.ema8 >= p.ema18 ||
    (Number.isFinite(ema8BelowEma18Pct) &&
      ema8BelowEma18Pct <= CFG.FVVO_ENTRY_ALLOW_EMA8_BELOW_EMA18_PCT);

  const rsiOk = p.rsi >= CFG.FVVO_ENTRY_MIN_RSI;

  const adxOk =
    !Number.isFinite(CFG.FVVO_ENTRY_MIN_ADX) ||
    CFG.FVVO_ENTRY_MIN_ADX <= 0 ||
    (Number.isFinite(p.adx) && p.adx >= CFG.FVVO_ENTRY_MIN_ADX);

  const extEma8Pct = calcPct(p.close, p.ema8);
  const extEma18Pct = calcPct(p.close, p.ema18);

  const notTooExtendedFromEma8 =
    Number.isFinite(extEma8Pct) && extEma8Pct <= CFG.FVVO_ENTRY_MAX_EXT_EMA8_PCT;

  const notTooExtendedFromEma18 =
    Number.isFinite(extEma18Pct) && extEma18Pct <= CFG.FVVO_ENTRY_MAX_EXT_EMA18_PCT;

  const noBearishConflict =
    !p.fvvoBearishColor || p.fvvoCrossUp || p.burstBullish;

  const checks = {
    setup: "CONTINUATION",
    fvvoCrossEntry,
    fvvoAboveZeroRising,
    fvvoBullish,
    priceAboveEma8,
    emaStructureOk,
    rsiOk,
    adxOk,
    notTooExtendedFromEma8,
    notTooExtendedFromEma18,
    noBearishConflict,
    extEma8Pct,
    extEma18Pct,
    ema8BelowEma18Pct
  };

  const ok =
    fvvoBullish &&
    priceAboveEma8 &&
    emaStructureOk &&
    rsiOk &&
    adxOk &&
    notTooExtendedFromEma8 &&
    notTooExtendedFromEma18 &&
    noBearishConflict;

  let reason = "NO_ENTRY";

  if (ok) {
    if (fvvoCrossEntry) reason = "FVVO_CROSS_UP_ABOVE_ZERO";
    else if (fvvoAboveZeroRising) reason = "FVVO_ABOVE_ZERO_RISING";
    else reason = "FVVO_BULLISH";
  } else {
    const failed = [];
    if (!fvvoBullish) failed.push("FVVO_NOT_BULLISH");
    if (!priceAboveEma8) failed.push("PRICE_NOT_ABOVE_EMA8");
    if (!emaStructureOk) failed.push("EMA8_TOO_FAR_BELOW_EMA18");
    if (!rsiOk) failed.push("RSI_TOO_LOW");
    if (!adxOk) failed.push("ADX_TOO_LOW");
    if (!notTooExtendedFromEma8) failed.push("TOO_EXTENDED_EMA8");
    if (!notTooExtendedFromEma18) failed.push("TOO_EXTENDED_EMA18");
    if (!noBearishConflict) failed.push("FVVO_BEARISH_CONFLICT");
    reason = failed.join("+") || "NO_ENTRY";
  }

  return {
    ok,
    setup: "CONTINUATION",
    reason,
    checks
  };
}

// ============================================================
// ENTRY LOGIC: DEEP REVERSAL
// ============================================================

function evaluateDeepReversalEntry(p) {
  if (!CFG.FVVO_LONG_ENABLED) {
    return {
      ok: false,
      setup: "DEEP_REVERSAL",
      reason: "FVVO_LONG_DISABLED"
    };
  }

  if (!CFG.FVVO_REVERSAL_ENABLED) {
    return {
      ok: false,
      setup: "DEEP_REVERSAL",
      reason: "FVVO_REVERSAL_DISABLED"
    };
  }

  const bars = recentBarsIncludingCurrent(p, CFG.FVVO_REVERSAL_LOOKBACK_BARS);
  const recentRsiLow = minOf(bars, "rsi");
  const recentFvvoLow = minOf(bars, "fvvoValue");
  const recentLow = minOf(bars, "low");

  const prev = getHistory(p.symbol).slice(-1)[0] || null;
  const prevRsi = prev ? safeNum(prev.rsi, null) : null;
  const prevFvvo = prev ? safeNum(prev.fvvoValue, null) : null;
  const prevHigh = prev ? safeNum(prev.high, null) : null;

  const rsiWasWashedOut =
    Number.isFinite(recentRsiLow) &&
    recentRsiLow <= CFG.FVVO_REVERSAL_RSI_WASHOUT_MAX;

  const rsiRecovering =
    Number.isFinite(p.rsi) &&
    p.rsi >= CFG.FVVO_REVERSAL_RSI_RECOVER_MIN &&
    (!Number.isFinite(prevRsi) || p.rsi >= prevRsi);

  const fvvoWasDeep =
    Number.isFinite(recentFvvoLow) &&
    recentFvvoLow <= CFG.FVVO_REVERSAL_MIN_DEEP_NEGATIVE;

  const fvvoSlopeStrong =
    Number.isFinite(p.fvvoSlope) &&
    p.fvvoSlope >= CFG.FVVO_REVERSAL_MIN_SLOPE;

  const fvvoRisingVsPrev =
    Number.isFinite(prevFvvo) &&
    Number.isFinite(p.fvvoValue) &&
    p.fvvoValue > prevFvvo;

  const fvvoRecovery =
    fvvoSlopeStrong ||
    fvvoRisingVsPrev ||
    (CFG.FVVO_REVERSAL_ALLOW_BULLISH_COLOR && p.fvvoBullishColor);

  const closeBelowEma8Pct = calcBelowPct(p.ema8, p.close);

  const notTooFarBelowEma8 =
    Number.isFinite(closeBelowEma8Pct) &&
    closeBelowEma8Pct <= CFG.FVVO_REVERSAL_MAX_BELOW_EMA8_PCT;

  const bullishCandle = Number.isFinite(p.open) && p.close > p.open;
  const closeAbovePrevHigh = Number.isFinite(prevHigh) && p.close > prevHigh;
  const closeReclaimEma8 = p.close >= p.ema8;

  const priceConfirm =
    !CFG.FVVO_REVERSAL_REQUIRE_PRICE_CONFIRM ||
    bullishCandle ||
    closeAbovePrevHigh ||
    closeReclaimEma8;

  const freshBreakdownLow =
    CFG.FVVO_REVERSAL_BLOCK_FRESH_LOW &&
    Number.isFinite(recentLow) &&
    Number.isFinite(p.low) &&
    p.low <= recentLow &&
    !bullishCandle &&
    !closeReclaimEma8;

  const noBearishConflict =
    !p.fvvoBearishColor || p.fvvoBullishColor || fvvoSlopeStrong;

  const ok =
    rsiWasWashedOut &&
    rsiRecovering &&
    fvvoWasDeep &&
    fvvoRecovery &&
    notTooFarBelowEma8 &&
    priceConfirm &&
    !freshBreakdownLow &&
    noBearishConflict;

  const checks = {
    setup: "DEEP_REVERSAL",
    rsiWasWashedOut,
    rsiRecovering,
    fvvoWasDeep,
    fvvoSlopeStrong,
    fvvoRisingVsPrev,
    fvvoBullishColor: p.fvvoBullishColor,
    fvvoRecovery,
    closeBelowEma8Pct,
    notTooFarBelowEma8,
    bullishCandle,
    closeAbovePrevHigh,
    closeReclaimEma8,
    priceConfirm,
    freshBreakdownLow,
    noBearishConflict,
    recentRsiLow,
    recentFvvoLow,
    recentLow,
    prevRsi,
    prevFvvo
  };

  let reason = "NO_REVERSAL_ENTRY";

  if (ok) {
    if (p.fvvoBullishColor) reason = "FVVO_DEEP_REVERSAL_GREEN";
    else if (fvvoSlopeStrong) reason = "FVVO_DEEP_REVERSAL_SLOPE";
    else reason = "FVVO_DEEP_REVERSAL_RISING";
  } else {
    const failed = [];
    if (!rsiWasWashedOut) failed.push("NO_RECENT_RSI_WASHOUT");
    if (!rsiRecovering) failed.push("RSI_NOT_RECOVERING");
    if (!fvvoWasDeep) failed.push("FVVO_NOT_DEEP_NEGATIVE");
    if (!fvvoRecovery) failed.push("FVVO_NOT_RECOVERING");
    if (!notTooFarBelowEma8) failed.push("PRICE_TOO_FAR_BELOW_EMA8");
    if (!priceConfirm) failed.push("NO_PRICE_CONFIRM");
    if (freshBreakdownLow) failed.push("FRESH_BREAKDOWN_LOW");
    if (!noBearishConflict) failed.push("FVVO_BEARISH_CONFLICT");
    reason = failed.join("+") || "NO_REVERSAL_ENTRY";
  }

  return {
    ok,
    setup: "DEEP_REVERSAL",
    reason,
    checks
  };
}

// ============================================================
// POSITION MANAGEMENT
// ============================================================

function openVirtualLong(p, entryDecision) {
  const position = {
    side: "LONG",
    setup: entryDecision.setup,
    symbol: p.symbol,
    tf: p.tf,

    entryPrice: p.close,
    entryTime: p.time,
    entryReceivedAt: nowIso(),
    entryReason: entryDecision.reason,

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
    backupUsed: false,
    exitSignals: []
  };

  state.positions.set(p.symbol, position);
  state.stats.virtualLongOpens += 1;

  if (entryDecision.setup === "CONTINUATION") {
    state.stats.continuationOpens += 1;
  }

  if (entryDecision.setup === "DEEP_REVERSAL") {
    state.stats.reversalOpens += 1;
  }

  const logType =
    entryDecision.setup === "DEEP_REVERSAL"
      ? "FVVO_REVERSAL_LONG_OPEN"
      : "FVVO_RAW_LONG_OPEN";

  logLine(
    logType,
    [
      `🟢 setup=${entryDecision.setup}`,
      `symbol=${p.symbol}`,
      `price=${n(p.close, 4)}`,
      `stop=${position.stopPrice === null ? "na" : n(position.stopPrice, 4)}`,
      `reason=${entryDecision.reason}`,
      `rsi=${n(p.rsi, 2)}`,
      `adx=${n(p.adx, 2)}`,
      `fvvo=${n(p.fvvoValue, 6)}`,
      `signal=${n(p.fvvoSignal, 6)}`,
      `slope=${n(p.fvvoSlope, 6)}`,
      `aboveZero=${boolStr(p.fvvoAboveZero)}`,
      `crossUp=${boolStr(p.fvvoCrossUp)}`,
      `bullishColor=${boolStr(p.fvvoBullishColor)}`,
      `burstBullish=${boolStr(p.burstBullish)}`,
      `sniperBuy=${boolStr(p.sniperBuy)}`
    ].join(" | "),
    entryDecision.checks
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

  if (p.fvvoRedDot) {
    pos.redDotSeen = true;
  }

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

  const hardDownSlope =
    Number.isFinite(p.fvvoSlope) &&
    p.fvvoSlope <= CFG.FVVO_HARD_DOWN_SLOPE;

  const intrabarHardStopHit =
    CFG.FVVO_INTRABAR_HARD_STOP_ENABLED &&
    Number.isFinite(pos.stopPrice) &&
    Number.isFinite(p.low) &&
    p.low <= pos.stopPrice;

  const closeMaxLossHit =
    currentPnlPct <= -Math.abs(CFG.FVVO_MAX_LOSS_EXIT_PCT);

  const givebackArm2 =
    peakPnlPct >= CFG.FVVO_GIVEBACK_ARM2_PCT &&
    givebackPct >= CFG.FVVO_GIVEBACK_ARM2_DROP_PCT;

  const givebackArm1 =
    peakPnlPct >= CFG.FVVO_GIVEBACK_ARM1_PCT &&
    givebackPct >= CFG.FVVO_GIVEBACK_ARM1_DROP_PCT;

  const backupNoRedDot =
    !pos.redDotSeen &&
    !p.fvvoAboveZero &&
    closeLostEma8 &&
    currentPnlPct >= CFG.FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT &&
    givebackPct >= CFG.FVVO_GIVEBACK_ARM1_DROP_PCT;

  const crossDownExit =
    p.fvvoCrossDown &&
    currentPnlPct >= CFG.FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT;

  const hardSlopeExit =
    hardDownSlope &&
    currentPnlPct >= CFG.FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT;

  const ema8LossProfitExit =
    closeLostEma8 &&
    currentPnlPct >= CFG.FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT &&
    givebackPct >= CFG.FVVO_GIVEBACK_ARM1_DROP_PCT;

  const maxHoldExit =
    CFG.FVVO_MAX_HOLD_BARS > 0 &&
    pos.barsHeld >= CFG.FVVO_MAX_HOLD_BARS;

  // Exit priority.
  // v1a important change: low-based intrabar stop is highest priority.
  if (intrabarHardStopHit) {
    return {
      exit: true,
      reason: "FVVO_INTRABAR_HARD_STOP",
      backupUsed: true,
      exitPrice: pos.stopPrice
    };
  }

  if (p.fvvoRedDot) {
    return {
      exit: true,
      reason: "FVVO_RED_DOT",
      backupUsed: false,
      exitPrice: p.close
    };
  }

  if (closeMaxLossHit) {
    return {
      exit: true,
      reason: "FVVO_CLOSE_MAX_LOSS_EXIT",
      backupUsed: true,
      exitPrice: p.close
    };
  }

  if (givebackArm2) {
    return {
      exit: true,
      reason: "FVVO_GIVEBACK_ARM2",
      backupUsed: true,
      exitPrice: p.close
    };
  }

  if (givebackArm1) {
    return {
      exit: true,
      reason: "FVVO_GIVEBACK_ARM1",
      backupUsed: true,
      exitPrice: p.close
    };
  }

  if (backupNoRedDot) {
    return {
      exit: true,
      reason: "FVVO_NO_RED_DOT_BACKUP_ZERO_LOSS_EMA8_GIVEBACK",
      backupUsed: true,
      exitPrice: p.close
    };
  }

  if (crossDownExit) {
    return {
      exit: true,
      reason: "FVVO_CROSS_DOWN_BACKUP",
      backupUsed: true,
      exitPrice: p.close
    };
  }

  if (hardSlopeExit) {
    return {
      exit: true,
      reason: "FVVO_HARD_DOWN_SLOPE_BACKUP",
      backupUsed: true,
      exitPrice: p.close
    };
  }

  if (ema8LossProfitExit) {
    return {
      exit: true,
      reason: "FVVO_EMA8_LOSS_PROFIT_BACKUP",
      backupUsed: true,
      exitPrice: p.close
    };
  }

  if (maxHoldExit) {
    return {
      exit: true,
      reason: "FVVO_MAX_HOLD_BARS_EXIT",
      backupUsed: true,
      exitPrice: p.close
    };
  }

  return {
    exit: false,
    reason: "HOLD",
    backupUsed: false,
    exitPrice: null
  };
}

function closeVirtualLong(pos, p, perf, exitDecision) {
  const exitPrice =
    Number.isFinite(exitDecision.exitPrice) && exitDecision.exitPrice > 0
      ? exitDecision.exitPrice
      : p.close;

  const pnlPct = calcPct(exitPrice, pos.entryPrice) || 0;
  const maxRunupPct = perf.peakPnlPct;
  const givebackPct = maxRunupPct - pnlPct;

  pos.exitPrice = exitPrice;
  pos.exitTime = p.time;
  pos.exitReceivedAt = nowIso();
  pos.exitReason = exitDecision.reason;
  pos.backupUsed = exitDecision.backupUsed;

  state.positions.delete(pos.symbol);
  state.stats.virtualLongExits += 1;
  state.stats.totalPnlPct += pnlPct;

  if (pos.setup === "CONTINUATION") {
    state.stats.continuationExits += 1;
    state.stats.continuationPnlPct += pnlPct;
  }

  if (pos.setup === "DEEP_REVERSAL") {
    state.stats.reversalExits += 1;
    state.stats.reversalPnlPct += pnlPct;
  }

  if (pnlPct > 0.03) state.stats.wins += 1;
  else if (pnlPct < -0.03) state.stats.losses += 1;
  else state.stats.flats += 1;

  if (state.stats.bestPnlPct === null || pnlPct > state.stats.bestPnlPct) {
    state.stats.bestPnlPct = pnlPct;
  }

  if (state.stats.worstPnlPct === null || pnlPct < state.stats.worstPnlPct) {
    state.stats.worstPnlPct = pnlPct;
  }

  if (state.stats.bestRunupPct === null || maxRunupPct > state.stats.bestRunupPct) {
    state.stats.bestRunupPct = maxRunupPct;
  }

  if (exitDecision.reason === "FVVO_RED_DOT") {
    state.stats.redDotExits += 1;
  }

  if (exitDecision.backupUsed) {
    state.stats.backupExits += 1;
  }

  if (exitDecision.reason === "FVVO_INTRABAR_HARD_STOP") {
    state.stats.intrabarHardStopExits += 1;
  }

  if (exitDecision.reason === "FVVO_CLOSE_MAX_LOSS_EXIT") {
    state.stats.maxLossExits += 1;
  }

  if (exitDecision.reason === "FVVO_MAX_HOLD_BARS_EXIT") {
    state.stats.maxHoldExits += 1;
  }

  const result =
    pnlPct > 0.03 ? "WIN" :
    pnlPct < -0.03 ? "LOSS" :
    "FLAT";

  const exitLogType =
    pos.setup === "DEEP_REVERSAL"
      ? "FVVO_REVERSAL_LONG_EXIT_SIGNAL"
      : "FVVO_RAW_LONG_EXIT_SIGNAL";

  const resultLogType =
    pos.setup === "DEEP_REVERSAL"
      ? "FVVO_REVERSAL_LONG_RESULT"
      : "FVVO_RAW_LONG_RESULT";

  logLine(
    exitLogType,
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
    resultLogType,
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
// SHORT SIGNAL OBSERVATION ONLY
// ============================================================

function observeShortSignal(p) {
  if (!CFG.FVVO_SHORT_ENABLED) {
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
}

// ============================================================
// SCORECARD
// ============================================================

function logScorecard() {
  const exits = state.stats.virtualLongExits;
  const avgPnl = exits > 0 ? state.stats.totalPnlPct / exits : 0;
  const winRate = exits > 0 ? (state.stats.wins / exits) * 100 : 0;

  const contAvg =
    state.stats.continuationExits > 0
      ? state.stats.continuationPnlPct / state.stats.continuationExits
      : 0;

  const revAvg =
    state.stats.reversalExits > 0
      ? state.stats.reversalPnlPct / state.stats.reversalExits
      : 0;

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
      `closeMaxLossExits=${state.stats.maxLossExits}`,
      `maxHoldExits=${state.stats.maxHoldExits}`,
      `continuationTrades=${state.stats.continuationExits}`,
      `continuationAvg=${pct(contAvg)}`,
      `continuationTotal=${pct(state.stats.continuationPnlPct)}`,
      `reversalTrades=${state.stats.reversalExits}`,
      `reversalAvg=${pct(revAvg)}`,
      `reversalTotal=${pct(state.stats.reversalPnlPct)}`
    ].join(" | ")
  );
}

// ============================================================
// MAIN FEATURE HANDLER
// ============================================================

function handleFeature(p) {
  state.stats.accepted += 1;

  const openPos = state.positions.get(p.symbol);

  if (CFG.DEBUG) {
    logLine(
      "FEATURE_5M_FVVO",
      [
        `symbol=${p.symbol}`,
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

  if (openPos) {
    const perf = updatePositionStats(openPos, p);
    const exitDecision = evaluateLongExit(openPos, p, perf);

    if (exitDecision.exit) {
      closeVirtualLong(openPos, p, perf, exitDecision);
    } else if (CFG.DEBUG) {
      const holdType =
        openPos.setup === "DEEP_REVERSAL"
          ? "FVVO_REVERSAL_LONG_HOLD"
          : "FVVO_RAW_LONG_HOLD";

      logLine(
        holdType,
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

  const continuationDecision = evaluateContinuationEntry(p);
  const reversalDecision = evaluateDeepReversalEntry(p);

  if (reversalDecision.ok) {
    state.stats.reversalSignals += 1;
    logLine(
      "FVVO_REVERSAL_LONG_SIGNAL",
      [
        `🧪 symbol=${p.symbol}`,
        `price=${n(p.close, 4)}`,
        `reason=${reversalDecision.reason}`,
        `rsi=${n(p.rsi, 2)}`,
        `fvvo=${n(p.fvvoValue, 6)}`,
        `slope=${n(p.fvvoSlope, 6)}`,
        `aboveZero=${boolStr(p.fvvoAboveZero)}`,
        `bullishColor=${boolStr(p.fvvoBullishColor)}`
      ].join(" | "),
      reversalDecision.checks
    );
  }

  // Entry priority:
  // 1) Deep reversal opens first because it catches earlier bounce.
  // 2) Continuation opens if no reversal.
  let chosenDecision = null;

  if (reversalDecision.ok) {
    chosenDecision = reversalDecision;
  } else if (continuationDecision.ok) {
    chosenDecision = continuationDecision;
  }

  if (chosenDecision) {
    openVirtualLong(p, chosenDecision);
  } else if (CFG.DEBUG) {
    logLine(
      "FVVO_RAW_LONG_NO_ENTRY",
      [
        `symbol=${p.symbol}`,
        `price=${n(p.close, 4)}`,
        `continuation=${continuationDecision.reason}`,
        `reversal=${reversalDecision.reason}`,
        `rsi=${n(p.rsi, 2)}`,
        `fvvo=${n(p.fvvoValue, 6)}`,
        `slope=${n(p.fvvoSlope, 6)}`,
        `aboveZero=${boolStr(p.fvvoAboveZero)}`,
        `crossUp=${boolStr(p.fvvoCrossUp)}`,
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
    return res.status(400).json({
      ok: false,
      reason: "NORMALIZE_ERROR"
    });
  }

  const valid = validatePayload(payload);

  if (!valid.ok) {
    state.stats.rejected += 1;
    logLine("REJECT", `${valid.reason}`);
    return res.status(400).json({
      ok: false,
      reason: valid.reason
    });
  }

  if (isDuplicateBar(payload)) {
    state.stats.duplicates += 1;
    logLine(
      "DUPLICATE",
      `ignored duplicate bar | symbol=${payload.symbol} | tf=${payload.tf} | time=${payload.time}`
    );
    return res.json({
      ok: true,
      duplicate: true,
      brain: CFG.BRAIN_NAME
    });
  }

  try {
    handleFeature(payload);
  } catch (err) {
    state.stats.rejected += 1;
    logLine("ERROR", `HANDLE_FEATURE_ERROR | ${err.stack || err.message}`);
    return res.status(500).json({
      ok: false,
      reason: "HANDLE_FEATURE_ERROR"
    });
  }

  return res.json({
    ok: true,
    brain: CFG.BRAIN_NAME,
    shadowOnly: true
  });
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
  console.log("------------------------------------------------------------");
  console.log(`FVVO_CONTINUATION_ENABLED=${CFG.FVVO_CONTINUATION_ENABLED}`);
  console.log(`FVVO_ENTRY_MIN_RSI=${CFG.FVVO_ENTRY_MIN_RSI}`);
  console.log(`FVVO_ENTRY_MIN_ADX=${CFG.FVVO_ENTRY_MIN_ADX}`);
  console.log(`FVVO_ENTRY_MIN_SLOPE=${CFG.FVVO_ENTRY_MIN_SLOPE}`);
  console.log(`FVVO_ENTRY_MAX_EXT_EMA8_PCT=${CFG.FVVO_ENTRY_MAX_EXT_EMA8_PCT}`);
  console.log(`FVVO_ENTRY_MAX_EXT_EMA18_PCT=${CFG.FVVO_ENTRY_MAX_EXT_EMA18_PCT}`);
  console.log(`FVVO_ENTRY_ALLOW_EMA8_BELOW_EMA18_PCT=${CFG.FVVO_ENTRY_ALLOW_EMA8_BELOW_EMA18_PCT}`);
  console.log("------------------------------------------------------------");
  console.log(`FVVO_REVERSAL_ENABLED=${CFG.FVVO_REVERSAL_ENABLED}`);
  console.log(`FVVO_REVERSAL_LOOKBACK_BARS=${CFG.FVVO_REVERSAL_LOOKBACK_BARS}`);
  console.log(`FVVO_REVERSAL_RSI_WASHOUT_MAX=${CFG.FVVO_REVERSAL_RSI_WASHOUT_MAX}`);
  console.log(`FVVO_REVERSAL_RSI_RECOVER_MIN=${CFG.FVVO_REVERSAL_RSI_RECOVER_MIN}`);
  console.log(`FVVO_REVERSAL_MIN_DEEP_NEGATIVE=${CFG.FVVO_REVERSAL_MIN_DEEP_NEGATIVE}`);
  console.log(`FVVO_REVERSAL_MIN_SLOPE=${CFG.FVVO_REVERSAL_MIN_SLOPE}`);
  console.log(`FVVO_REVERSAL_MAX_BELOW_EMA8_PCT=${CFG.FVVO_REVERSAL_MAX_BELOW_EMA8_PCT}`);
  console.log(`FVVO_REVERSAL_REQUIRE_PRICE_CONFIRM=${CFG.FVVO_REVERSAL_REQUIRE_PRICE_CONFIRM}`);
  console.log(`FVVO_REVERSAL_ALLOW_BULLISH_COLOR=${CFG.FVVO_REVERSAL_ALLOW_BULLISH_COLOR}`);
  console.log(`FVVO_REVERSAL_BLOCK_FRESH_LOW=${CFG.FVVO_REVERSAL_BLOCK_FRESH_LOW}`);
  console.log("------------------------------------------------------------");
  console.log(`FVVO_GIVEBACK_ARM1_PCT=${CFG.FVVO_GIVEBACK_ARM1_PCT}`);
  console.log(`FVVO_GIVEBACK_ARM1_DROP_PCT=${CFG.FVVO_GIVEBACK_ARM1_DROP_PCT}`);
  console.log(`FVVO_GIVEBACK_ARM2_PCT=${CFG.FVVO_GIVEBACK_ARM2_PCT}`);
  console.log(`FVVO_GIVEBACK_ARM2_DROP_PCT=${CFG.FVVO_GIVEBACK_ARM2_DROP_PCT}`);
  console.log(`FVVO_HARD_DOWN_SLOPE=${CFG.FVVO_HARD_DOWN_SLOPE}`);
  console.log(`FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT=${CFG.FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT}`);
  console.log(`FVVO_INTRABAR_HARD_STOP_ENABLED=${CFG.FVVO_INTRABAR_HARD_STOP_ENABLED}`);
  console.log(`FVVO_MAX_LOSS_EXIT_PCT=${CFG.FVVO_MAX_LOSS_EXIT_PCT}`);
  console.log(`FVVO_MAX_HOLD_BARS=${CFG.FVVO_MAX_HOLD_BARS}`);
  console.log("============================================================");
});
