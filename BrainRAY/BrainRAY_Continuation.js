import express from "express";

// ============================================================
// BrainRAY_Continuation_v1.0
// Long-only, Ray-led continuation brain for SOLUSDT
// Entry structure: 5m features/signals
// Execution/protection: live ticks
// ============================================================

const app = express();
app.use(express.json({ limit: "1mb" }));

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
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

function pctDiff(from, to) {
  const a = Number(from);
  const b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return 0;
  return ((b - a) / a) * 100;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function upper(x) {
  return String(x || "").trim().toUpperCase();
}

function normalizeSymbol(raw) {
  const v = upper(raw);
  if (!v) return "";
  if (v.includes(":")) return v;
  return `BINANCE:${v}`;
}

function symbolParts(symbol) {
  const sym = normalizeSymbol(symbol);
  const [ex, inst] = sym.includes(":") ? sym.split(":") : ["BINANCE", sym];
  return { tv_exchange: ex || "BINANCE", tv_instrument: inst || "SOLUSDT" };
}

function ageSec(iso) {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - t) / 1000);
}

function fmt(x, dp = 4) {
  const v = Number(x);
  return Number.isFinite(v) ? v.toFixed(dp) : "na";
}

function pickFirst(obj, keys, def = undefined) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return def;
}

function barTimeKey(iso, tfMin = 5) {
  const t = new Date(iso || Date.now());
  if (!Number.isFinite(t.getTime())) return "na";
  const ms = t.getTime();
  const bucket = Math.floor(ms / (tfMin * 60 * 1000)) * (tfMin * 60 * 1000);
  return new Date(bucket).toISOString();
}

function reasonPush(arr, cond, text) {
  if (cond) arr.push(text);
}

// ------------------------------------------------------------
// Config
// ------------------------------------------------------------
const CONFIG = {
  PORT: n(process.env.PORT, 8080),
  DEBUG: b(process.env.DEBUG, true),
  BRAIN_NAME: s(process.env.BRAIN_NAME, "BrainRAY_Continuation_v1.0"),

  WEBHOOK_SECRET: s(process.env.WEBHOOK_SECRET, ""),
  TICKROUTER_SECRET: s(process.env.TICKROUTER_SECRET, ""),
  WEBHOOK_PATH: s(process.env.WEBHOOK_PATH, "/webhook"),

  SYMBOL: normalizeSymbol(s(process.env.SYMBOL || "BINANCE:SOLUSDT")),
  ENTRY_TF: s(process.env.ENTRY_TF || "5"),
  TICK_MAX_AGE_SEC: n(process.env.TICK_MAX_AGE_SEC, 60),
  FEATURE_MAX_AGE_SEC: n(process.env.FEATURE_MAX_AGE_SEC, 900),

  ENTER_DEDUP_MS: n(process.env.ENTER_DEDUP_MS, 90000),
  EXIT_DEDUP_MS: n(process.env.EXIT_DEDUP_MS, 60000),
  EXIT_COOLDOWN_MIN: n(process.env.EXIT_COOLDOWN_MIN, 12),

  C3_SIGNAL_URL: s(process.env.C3_SIGNAL_URL || process.env.THREECOMMAS_WEBHOOK_URL, ""),
  C3_SIGNAL_SECRET: s(process.env.C3_SIGNAL_SECRET || process.env.THREECOMMAS_SECRET, ""),
  C3_TIMEOUT_MS: n(process.env.C3_TIMEOUT_MS || process.env.THREECOMMAS_TIMEOUT_MS, 8000),
  MAX_LAG_SEC: n(process.env.MAX_LAG_SEC || process.env.THREECOMMAS_MAX_LAG, 300),

  SYMBOL_BOT_MAP: safeJsonParse(process.env.SYMBOL_BOT_MAP || "{}", {}),

  RAY_USE_BULLISH_TREND_CHANGE: b(process.env.RAY_USE_BULLISH_TREND_CHANGE, true),
  RAY_USE_BULLISH_TREND_CONTINUATION: b(process.env.RAY_USE_BULLISH_TREND_CONTINUATION, true),
  RAY_USE_BULLISH_BOS: b(process.env.RAY_USE_BULLISH_BOS, true),
  RAY_USE_BEARISH_TREND_CHANGE: b(process.env.RAY_USE_BEARISH_TREND_CHANGE, true),
  RAY_USE_BEARISH_TREND_CONTINUATION: b(process.env.RAY_USE_BEARISH_TREND_CONTINUATION, true),

  FVVO_USE_SNIPER_BUY: b(process.env.FVVO_USE_SNIPER_BUY, true),
  FVVO_SNIPER_LOOKBACK_BARS: n(process.env.FVVO_SNIPER_LOOKBACK_BARS, 3),

  REQUIRE_EMA8_ABOVE_EMA18: b(process.env.REQUIRE_EMA8_ABOVE_EMA18, true),
  REQUIRE_CLOSE_ABOVE_EMA8: b(process.env.REQUIRE_CLOSE_ABOVE_EMA8, true),
  MIN_RSI_LONG: n(process.env.MIN_RSI_LONG, 48),
  MIN_ADX_CONTINUATION: n(process.env.MIN_ADX_CONTINUATION, 14),

  CONTINUATION_MAX_CHASE_PCT: n(process.env.CONTINUATION_MAX_CHASE_PCT, 0.35),
  REVERSAL_RECLAIM_MAX_CHASE_PCT: n(process.env.REVERSAL_RECLAIM_MAX_CHASE_PCT, 0.30),
  MAX_EXT_FROM_EMA8_PCT: n(process.env.MAX_EXT_FROM_EMA8_PCT, 0.75),
  MAX_EXT_FROM_EMA18_PCT: n(process.env.MAX_EXT_FROM_EMA18_PCT, 1.20),

  BREAKOUT_MEMORY_ENABLED: b(process.env.BREAKOUT_MEMORY_ENABLED, true),
  BREAKOUT_MEMORY_BARS: n(process.env.BREAKOUT_MEMORY_BARS, 4),
  BREAKOUT_MEMORY_MAX_CHASE_PCT: n(process.env.BREAKOUT_MEMORY_MAX_CHASE_PCT, 0.25),
  BREAKOUT_MEMORY_REQUIRE_ABOVE_RECLAIM: b(process.env.BREAKOUT_MEMORY_REQUIRE_ABOVE_RECLAIM, true),
  BREAKOUT_MEMORY_INVALIDATE_PCT: n(process.env.BREAKOUT_MEMORY_INVALIDATE_PCT, 0.10),

  REGIME_MAX_BARS_WITHOUT_BULL_SUPPORT: n(process.env.REGIME_MAX_BARS_WITHOUT_BULL_SUPPORT, 8),

  HARD_STOP_PCT: n(process.env.HARD_STOP_PCT, 0.80),
  BREAKEVEN_ARM_PCT: n(process.env.BREAKEVEN_ARM_PCT, 0.40),
  BREAKEVEN_OFFSET_PCT: n(process.env.BREAKEVEN_OFFSET_PCT, 0.05),
  PROFIT_LOCK_ARM_PCT: n(process.env.PROFIT_LOCK_ARM_PCT, 0.60),
  PROFIT_LOCK_GIVEBACK_PCT: n(process.env.PROFIT_LOCK_GIVEBACK_PCT, 0.35),
  TRAIL_ARM_PCT: n(process.env.TRAIL_ARM_PCT, 1.00),
  TRAIL_GIVEBACK_PCT: n(process.env.TRAIL_GIVEBACK_PCT, 0.45),

  EXIT_ON_BEARISH_TREND_CHANGE: b(process.env.EXIT_ON_BEARISH_TREND_CHANGE, true),
  EXIT_ON_BEARISH_TREND_CONTINUATION: b(process.env.EXIT_ON_BEARISH_TREND_CONTINUATION, false),
  EXIT_ON_5M_CLOSE_BELOW_EMA8: b(process.env.EXIT_ON_5M_CLOSE_BELOW_EMA8, true),
  EXIT_ON_5M_CLOSE_BELOW_EMA18: b(process.env.EXIT_ON_5M_CLOSE_BELOW_EMA18, false),

  ENABLE_HTTP_FORWARD: b(process.env.ENABLE_HTTP_FORWARD, true),
};

const fetchFn = globalThis.fetch;

// ------------------------------------------------------------
// State
// ------------------------------------------------------------
const S = {
  startedAt: isoNow(),
  barIndex: 0,
  lastBarKey: null,

  lastTickPrice: null,
  lastTickTime: null,
  tickCount: 0,

  lastFeature: null,
  lastFeatureTime: null,
  lastFeatureBarKey: null,

  inPosition: false,
  entryPrice: null,
  entryAt: null,
  entryMode: null,
  stopPrice: null,
  beArmed: false,
  plArmed: false,
  trailArmed: false,
  peakPrice: null,
  cooldownUntilMs: 0,

  lastEnterAtMs: 0,
  lastExitAtMs: 0,
  lastAction: null,

  ray: {
    bullContext: false,
    lastBullTrendChangeAt: null,
    lastBullTrendContinuationAt: null,
    lastBullBosAt: null,
    lastBearTrendChangeAt: null,
    lastBearTrendContinuationAt: null,
  },

  fvvo: {
    lastSniperBuyAt: null,
  },

  breakoutMemory: {
    active: false,
    used: false,
    armedBar: null,
    expiresBar: null,
    triggerPrice: null,
    reclaimPrice: null,
    breakoutHigh: null,
    mode: null,
    armedAt: null,
  },

  logs: [],
};

function log(msg, data = null) {
  const line = data ? `${msg} | ${JSON.stringify(data)}` : msg;
  const out = `${isoNow()} ${line}`;
  S.logs.push(out);
  if (S.logs.length > 300) S.logs.shift();
  if (CONFIG.DEBUG) console.log(out);
}

function currentPrice() {
  return Number.isFinite(S.lastTickPrice) ? S.lastTickPrice : n(S.lastFeature?.close, NaN);
}

function isTickFresh() {
  return ageSec(S.lastTickTime) <= CONFIG.TICK_MAX_AGE_SEC;
}

function isFeatureFresh() {
  return ageSec(S.lastFeatureTime) <= CONFIG.FEATURE_MAX_AGE_SEC;
}

function getBotUuid(symbol) {
  return CONFIG.SYMBOL_BOT_MAP[symbol] || "";
}

function clearBreakoutMemory(reason = "reset") {
  if (S.breakoutMemory.active) {
    log("🧠 BREAKOUT_MEMORY_CLEARED", { reason });
  }
  S.breakoutMemory = {
    active: false,
    used: false,
    armedBar: null,
    expiresBar: null,
    triggerPrice: null,
    reclaimPrice: null,
    breakoutHigh: null,
    mode: null,
    armedAt: null,
  };
}

// ------------------------------------------------------------
// Parsing inbound event types
// ------------------------------------------------------------
function parseInboundType(body) {
  const src = String(body.src || "").toLowerCase();
  const event = String(body.event || body.signal || body.alert || body.action || "").trim();

  if (src === "tick") return { family: "tick", name: "tick" };
  if (src === "feature" || src === "features") return { family: "feature", name: "feature" };
  if (src === "ray") return { family: "ray", name: event };
  if (src === "fvvo") return { family: "fvvo", name: event };

  // Flexible fallbacks
  const cond = String(body.condition || "").trim();
  const label = event || cond;

  if (/sniper buy alert/i.test(label)) return { family: "fvvo", name: "Sniper Buy Alert" };
  if (/bullish trend change/i.test(label)) return { family: "ray", name: "Bullish Trend Change" };
  if (/bearish trend change/i.test(label)) return { family: "ray", name: "Bearish Trend Change" };
  if (/bullish trend continuation/i.test(label)) return { family: "ray", name: "Bullish Trend Continuation" };
  if (/bearish trend continuation/i.test(label)) return { family: "ray", name: "Bearish Trend Continuation" };
  if (/bullish bos/i.test(label)) return { family: "ray", name: "Bullish BOS" };
  if (/bearish bos/i.test(label)) return { family: "ray", name: "Bearish BOS" };

  return { family: "unknown", name: label || "unknown" };
}

// ------------------------------------------------------------
// Regime / signal memory
// ------------------------------------------------------------
function handleRayEvent(body) {
  const name = String(body.event || body.signal || body.alert || body.action || "").trim();
  const ts = pickFirst(body, ["time", "timestamp"], isoNow());
  const price = n(pickFirst(body, ["price", "trigger_price", "close"], currentPrice()));

  if (/Bullish Trend Change/i.test(name) && CONFIG.RAY_USE_BULLISH_TREND_CHANGE) {
    S.ray.bullContext = true;
    S.ray.lastBullTrendChangeAt = ts;
    log("🟢 RAY_BULLISH_TREND_CHANGE", { price, ts });
    return;
  }

  if (/Bullish Trend Continuation/i.test(name) && CONFIG.RAY_USE_BULLISH_TREND_CONTINUATION) {
    S.ray.bullContext = true;
    S.ray.lastBullTrendContinuationAt = ts;
    log("🟩 RAY_BULLISH_TREND_CONTINUATION", { price, ts });
    tryEntry("ray_bullish_trend_continuation", body);
    return;
  }

  if (/Bullish BOS/i.test(name) && CONFIG.RAY_USE_BULLISH_BOS) {
    S.ray.lastBullBosAt = ts;
    log("🔹 RAY_BULLISH_BOS", { price, ts });
    return;
  }

  if (/Bearish Trend Change/i.test(name) && CONFIG.RAY_USE_BEARISH_TREND_CHANGE) {
    S.ray.lastBearTrendChangeAt = ts;
    S.ray.bullContext = false;
    log("🔴 RAY_BEARISH_TREND_CHANGE", { price, ts });
    if (S.inPosition && CONFIG.EXIT_ON_BEARISH_TREND_CHANGE) {
      doExit("ray_bearish_trend_change", price, ts);
    }
    clearBreakoutMemory("bearish_trend_change");
    return;
  }

  if (/Bearish Trend Continuation/i.test(name) && CONFIG.RAY_USE_BEARISH_TREND_CONTINUATION) {
    S.ray.lastBearTrendContinuationAt = ts;
    log("🟥 RAY_BEARISH_TREND_CONTINUATION", { price, ts });
    if (S.inPosition && CONFIG.EXIT_ON_BEARISH_TREND_CONTINUATION) {
      doExit("ray_bearish_trend_continuation", price, ts);
    }
    return;
  }
}

function handleFvvoEvent(body) {
  const name = String(body.event || body.signal || body.alert || body.action || "").trim();
  const ts = pickFirst(body, ["time", "timestamp"], isoNow());

  if (/Sniper Buy Alert/i.test(name) && CONFIG.FVVO_USE_SNIPER_BUY) {
    S.fvvo.lastSniperBuyAt = ts;
    log("🎯 FVVO_SNIPER_BUY", { ts });
  }
}

// ------------------------------------------------------------
// Feature handling
// ------------------------------------------------------------
function updateBarProgress(ts) {
  const key = barTimeKey(ts, n(CONFIG.ENTRY_TF, 5));
  if (key !== S.lastBarKey) {
    S.barIndex += 1;
    S.lastBarKey = key;
    invalidateBreakoutMemory();
  }
}

function handleFeature(body) {
  const ts = pickFirst(body, ["time", "timestamp"], isoNow());
  updateBarProgress(ts);

  const feature = {
    symbol: normalizeSymbol(pickFirst(body, ["symbol"], CONFIG.SYMBOL)),
    tf: s(pickFirst(body, ["tf"], CONFIG.ENTRY_TF)),
    time: ts,

    open: n(body.open, NaN),
    high: n(body.high, NaN),
    low: n(body.low, NaN),
    close: n(body.close, NaN),

    ema8: n(body.ema8, NaN),
    ema18: n(body.ema18, NaN),
    ema50: n(body.ema50, NaN),

    rsi: n(body.rsi, NaN),
    adx: n(body.adx, NaN),
    atrPct: n(body.atrPct, NaN),

    regime: s(body.regime, ""),
    oiTrend: n(body.oiTrend, 0),
    cvdTrend: n(body.cvdTrend, 0),
  };

  S.lastFeature = feature;
  S.lastFeatureTime = ts;
  S.lastFeatureBarKey = S.lastBarKey;

  log("📊 FEATURE_5M", {
    close: feature.close,
    ema8: feature.ema8,
    ema18: feature.ema18,
    rsi: feature.rsi,
    adx: feature.adx,
    barIndex: S.barIndex,
  });

  evaluateStructureAndArmMemory(feature);

  if (S.inPosition) {
    evaluateBarExit(feature);
  }
}

function evaluateStructureAndArmMemory(f) {
  if (!CONFIG.BREAKOUT_MEMORY_ENABLED) return;
  if (normalizeSymbol(f.symbol) !== CONFIG.SYMBOL) return;
  if (String(f.tf) !== String(CONFIG.ENTRY_TF)) return;

  const bullEmaOk =
    !CONFIG.REQUIRE_EMA8_ABOVE_EMA18 || (Number.isFinite(f.ema8) && Number.isFinite(f.ema18) && f.ema8 >= f.ema18);

  const closeAboveEma8Ok =
    !CONFIG.REQUIRE_CLOSE_ABOVE_EMA8 || (Number.isFinite(f.close) && Number.isFinite(f.ema8) && f.close >= f.ema8);

  const rsiOk = !Number.isFinite(f.rsi) || f.rsi >= CONFIG.MIN_RSI_LONG;
  const adxOk = !Number.isFinite(f.adx) || f.adx >= CONFIG.MIN_ADX_CONTINUATION;

  const bullRayContext = S.ray.bullContext || ageSec(S.ray.lastBullTrendChangeAt) < 3600 || ageSec(S.ray.lastBullTrendContinuationAt) < 1800;
  const bullishBosRecent = ageSec(S.ray.lastBullBosAt) < 1800;

  const structureOk = bullEmaOk && closeAboveEma8Ok && rsiOk && adxOk && (bullRayContext || bullishBosRecent);

  if (!structureOk) return;

  const reclaimPrice = Number.isFinite(f.ema8) ? f.ema8 : f.close;
  const triggerPrice = f.close;
  const breakoutHigh = f.high;

  S.breakoutMemory = {
    active: true,
    used: false,
    armedBar: S.barIndex,
    expiresBar: S.barIndex + CONFIG.BREAKOUT_MEMORY_BARS,
    triggerPrice,
    reclaimPrice,
    breakoutHigh,
    mode: "breakout_continuation_memory",
    armedAt: isoNow(),
  };

  log("🧠 BREAKOUT_MEMORY_ARMED", {
    armedBar: S.barIndex,
    expiresBar: S.breakoutMemory.expiresBar,
    triggerPrice,
    reclaimPrice,
    breakoutHigh,
  });
}

function invalidateBreakoutMemory() {
  if (!S.breakoutMemory.active) return;
  if (S.breakoutMemory.used) return clearBreakoutMemory("used");
  if (S.barIndex > S.breakoutMemory.expiresBar) return clearBreakoutMemory("expired");

  const px = currentPrice();
  if (!Number.isFinite(px)) return;

  if (CONFIG.BREAKOUT_MEMORY_REQUIRE_ABOVE_RECLAIM && Number.isFinite(S.breakoutMemory.reclaimPrice)) {
    const floor = S.breakoutMemory.reclaimPrice * (1 - CONFIG.BREAKOUT_MEMORY_INVALIDATE_PCT / 100);
    if (px < floor) {
      return clearBreakoutMemory("lost_reclaim");
    }
  }
}

// ------------------------------------------------------------
// Entry logic
// ------------------------------------------------------------
function tryEntry(source, body) {
  const decision = evaluateEntry(source, body);
  if (!decision.allow) {
    log("🚫 ENTRY_BLOCKED", decision);
    return decision;
  }

  const price = Number.isFinite(decision.entryPrice) ? decision.entryPrice : currentPrice();
  if (!Number.isFinite(price)) {
    log("🚫 ENTRY_BLOCKED", { reason: "no_entry_price" });
    return { allow: false, reason: "no_entry_price" };
  }

  doEnter(decision.mode, price, decision);
  return decision;
}

function evaluateEntry(source, body) {
  const reasons = [];
  const now = nowMs();
  const px = n(pickFirst(body, ["price", "trigger_price", "close"], currentPrice()), NaN);
  const feature = S.lastFeature;

  reasonPush(reasons, normalizeSymbol(pickFirst(body, ["symbol"], CONFIG.SYMBOL)) !== CONFIG.SYMBOL, "symbol_mismatch");
  reasonPush(reasons, S.inPosition, "already_in_position");
  reasonPush(reasons, now < S.cooldownUntilMs, "cooldown_active");
  reasonPush(reasons, now - S.lastEnterAtMs < CONFIG.ENTER_DEDUP_MS, "enter_dedup");
  reasonPush(reasons, !isTickFresh(), "stale_tick");
  reasonPush(reasons, !isFeatureFresh(), "stale_feature");
  reasonPush(reasons, !S.ray.bullContext, "no_bull_context");
  reasonPush(reasons, !Number.isFinite(px), "bad_price");
  reasonPush(reasons, !feature, "no_feature");

  if (reasons.length) {
    return { allow: false, source, reasons };
  }

  const ema8 = n(feature.ema8, NaN);
  const ema18 = n(feature.ema18, NaN);
  const close = n(feature.close, NaN);
  const rsi = n(feature.rsi, NaN);
  const adx = n(feature.adx, NaN);

  const emaBullOk = !CONFIG.REQUIRE_EMA8_ABOVE_EMA18 || (Number.isFinite(ema8) && Number.isFinite(ema18) && ema8 >= ema18);
  const closeAboveEma8Ok = !CONFIG.REQUIRE_CLOSE_ABOVE_EMA8 || (Number.isFinite(close) && Number.isFinite(ema8) && close >= ema8);
  const rsiOk = !Number.isFinite(rsi) || rsi >= CONFIG.MIN_RSI_LONG;
  const adxOk = !Number.isFinite(adx) || adx >= CONFIG.MIN_ADX_CONTINUATION;

  const extFromEma8 = Number.isFinite(ema8) ? pctDiff(ema8, px) : 0;
  const extFromEma18 = Number.isFinite(ema18) ? pctDiff(ema18, px) : 0;

  const recentSniperBuy =
    ageSec(S.fvvo.lastSniperBuyAt) <= CONFIG.FVVO_SNIPER_LOOKBACK_BARS * n(CONFIG.ENTRY_TF, 5) * 60;

  // Normal continuation path
  const contReasons = [];
  reasonPush(contReasons, !emaBullOk, "ema8_below_ema18");
  reasonPush(contReasons, !closeAboveEma8Ok, "close_below_ema8");
  reasonPush(contReasons, !rsiOk, "rsi_too_low");
  reasonPush(contReasons, !adxOk, "adx_too_low");
  reasonPush(contReasons, extFromEma8 > CONFIG.MAX_EXT_FROM_EMA8_PCT, "too_extended_from_ema8");
  reasonPush(contReasons, extFromEma18 > CONFIG.MAX_EXT_FROM_EMA18_PCT, "too_extended_from_ema18");

  let contAnchor = Number.isFinite(ema8) ? ema8 : close;
  let contChasePct = Number.isFinite(contAnchor) ? pctDiff(contAnchor, px) : 999;
  reasonPush(contReasons, contChasePct > CONFIG.CONTINUATION_MAX_CHASE_PCT, "continuation_chase_too_high");

  const continuationOk = contReasons.length === 0;

  if (continuationOk) {
    return {
      allow: true,
      source,
      mode: recentSniperBuy ? "breakout_continuation_long_sniper" : "breakout_continuation_long",
      entryPrice: px,
      extFromEma8,
      extFromEma18,
      contChasePct,
      recentSniperBuy,
    };
  }

  // Breakout memory fallback
  const mem = S.breakoutMemory;
  const memReasons = [];
  const memActive = CONFIG.BREAKOUT_MEMORY_ENABLED && mem.active && !mem.used;

  reasonPush(memReasons, !memActive, "no_breakout_memory");
  reasonPush(memReasons, S.barIndex > n(mem.expiresBar, -1), "memory_expired");

  const memAnchor = Math.max(n(mem.reclaimPrice, NaN), n(mem.breakoutHigh, NaN));
  const memChasePct = Number.isFinite(memAnchor) ? pctDiff(memAnchor, px) : 999;

  if (CONFIG.BREAKOUT_MEMORY_REQUIRE_ABOVE_RECLAIM && Number.isFinite(mem.reclaimPrice)) {
    const reclaimFloor = mem.reclaimPrice * (1 - CONFIG.BREAKOUT_MEMORY_INVALIDATE_PCT / 100);
    reasonPush(memReasons, px < reclaimFloor, "below_memory_reclaim_floor");
  }

  reasonPush(memReasons, memChasePct > CONFIG.BREAKOUT_MEMORY_MAX_CHASE_PCT, "memory_chase_too_high");
  reasonPush(memReasons, !emaBullOk, "ema_bull_invalid");
  reasonPush(memReasons, extFromEma18 > CONFIG.MAX_EXT_FROM_EMA18_PCT, "too_extended_from_ema18");

  if (memReasons.length === 0) {
    return {
      allow: true,
      source,
      mode: "delayed_breakout_memory_long",
      entryPrice: px,
      memChasePct,
      memAnchor,
      reclaimPrice: mem.reclaimPrice,
    };
  }

  return {
    allow: false,
    source,
    reasons: [...contReasons, ...memReasons],
    extFromEma8,
    extFromEma18,
    contChasePct,
    memChasePct,
  };
}

function doEnter(mode, price, decision = {}) {
  const nowIso = isoNow();
  const stop = price * (1 - CONFIG.HARD_STOP_PCT / 100);

  S.inPosition = true;
  S.entryPrice = price;
  S.entryAt = nowIso;
  S.entryMode = mode;
  S.stopPrice = stop;
  S.beArmed = false;
  S.plArmed = false;
  S.trailArmed = false;
  S.peakPrice = price;
  S.lastEnterAtMs = nowMs();
  S.lastAction = "enter";

  if (S.breakoutMemory.active) {
    S.breakoutMemory.used = true;
    clearBreakoutMemory("consumed_on_entry");
  }

  log("📥 ENTER", {
    brain: CONFIG.BRAIN_NAME,
    mode,
    price,
    stop,
    decision,
  });

  forward3Commas("enter_long", price, {
    mode,
    setup_type: mode,
    brain: CONFIG.BRAIN_NAME,
  }).catch((err) => {
    log("❌ 3COMMAS_ENTER_ERROR", { err: String(err?.message || err) });
  });
}

// ------------------------------------------------------------
// Exit logic
// ------------------------------------------------------------
function updatePositionFromTick(price) {
  if (!S.inPosition || !Number.isFinite(price) || !Number.isFinite(S.entryPrice)) return;

  if (!Number.isFinite(S.peakPrice) || price > S.peakPrice) {
    S.peakPrice = price;
  }

  const pnlPct = pctDiff(S.entryPrice, price);
  const drawFromPeakPct = Number.isFinite(S.peakPrice) ? pctDiff(S.peakPrice, price) : 0;

  if (!S.beArmed && pnlPct >= CONFIG.BREAKEVEN_ARM_PCT) {
    S.beArmed = true;
    const beStop = S.entryPrice * (1 + CONFIG.BREAKEVEN_OFFSET_PCT / 100);
    S.stopPrice = Math.max(S.stopPrice, beStop);
    log("🛡️ BREAKEVEN_ARMED", { pnlPct, stopPrice: S.stopPrice });
  }

  if (!S.plArmed && pnlPct >= CONFIG.PROFIT_LOCK_ARM_PCT) {
    S.plArmed = true;
    log("🔒 PROFIT_LOCK_ARMED", { pnlPct });
  }

  if (!S.trailArmed && pnlPct >= CONFIG.TRAIL_ARM_PCT) {
    S.trailArmed = true;
    log("📈 TRAIL_ARMED", { pnlPct });
  }

  if (price <= S.stopPrice) {
    return doExit("hard_or_breakeven_stop", price, isoNow());
  }

  if (S.plArmed && drawFromPeakPct <= -CONFIG.PROFIT_LOCK_GIVEBACK_PCT) {
    return doExit("profit_lock_giveback", price, isoNow());
  }

  if (S.trailArmed && drawFromPeakPct <= -CONFIG.TRAIL_GIVEBACK_PCT) {
    return doExit("trail_giveback", price, isoNow());
  }
}

function evaluateBarExit(feature) {
  if (!S.inPosition) return;
  const price = n(feature.close, currentPrice());

  if (CONFIG.EXIT_ON_5M_CLOSE_BELOW_EMA8 && Number.isFinite(feature.ema8) && price < feature.ema8) {
    return doExit("close_below_ema8_5m", price, feature.time);
  }

  if (CONFIG.EXIT_ON_5M_CLOSE_BELOW_EMA18 && Number.isFinite(feature.ema18) && price < feature.ema18) {
    return doExit("close_below_ema18_5m", price, feature.time);
  }
}

function doExit(reason, price, ts) {
  const now = nowMs();
  if (!S.inPosition) return;
  if (now - S.lastExitAtMs < CONFIG.EXIT_DEDUP_MS) return;

  const exitPrice = Number.isFinite(price) ? price : currentPrice();
  const pnlPct = Number.isFinite(exitPrice) && Number.isFinite(S.entryPrice) ? pctDiff(S.entryPrice, exitPrice) : 0;

  log("📤 EXIT", {
    reason,
    price: exitPrice,
    pnlPct: Number(pnlPct.toFixed(4)),
    entryPrice: S.entryPrice,
    entryMode: S.entryMode,
    heldSec: S.entryAt ? Math.round((new Date(ts).getTime() - new Date(S.entryAt).getTime()) / 1000) : null,
  });

  forward3Commas("exit_long", exitPrice, {
    reason,
    brain: CONFIG.BRAIN_NAME,
    entry_mode: S.entryMode,
  }).catch((err) => {
    log("❌ 3COMMAS_EXIT_ERROR", { err: String(err?.message || err) });
  });

  S.inPosition = false;
  S.entryPrice = null;
  S.entryAt = null;
  S.entryMode = null;
  S.stopPrice = null;
  S.beArmed = false;
  S.plArmed = false;
  S.trailArmed = false;
  S.peakPrice = null;
  S.lastExitAtMs = now;
  S.lastAction = "exit";
  S.cooldownUntilMs = now + CONFIG.EXIT_COOLDOWN_MIN * 60 * 1000;
}

// ------------------------------------------------------------
// 3Commas forwarding
// ------------------------------------------------------------
async function forward3Commas(action, triggerPrice, meta = {}) {
  if (!CONFIG.ENABLE_HTTP_FORWARD) {
    log("📦 SIGNAL_PREVIEW", { action, triggerPrice, meta, enabled: false });
    return;
  }

  if (!fetchFn) {
    log("⚠️ FETCH_UNAVAILABLE", { action });
    return;
  }

  const botUuid = getBotUuid(CONFIG.SYMBOL);
  if (!CONFIG.C3_SIGNAL_URL || !CONFIG.C3_SIGNAL_SECRET || !botUuid) {
    log("⚠️ 3COMMAS_CONFIG_MISSING", {
      hasUrl: !!CONFIG.C3_SIGNAL_URL,
      hasSecret: !!CONFIG.C3_SIGNAL_SECRET,
      hasBotUuid: !!botUuid,
    });
    return;
  }

  const { tv_exchange, tv_instrument } = symbolParts(CONFIG.SYMBOL);

  const payload = {
    secret: CONFIG.C3_SIGNAL_SECRET,
    bot_uuid: botUuid,
    max_lag: String(CONFIG.MAX_LAG_SEC),
    timestamp: isoNow(),
    trigger_price: String(triggerPrice),
    tv_exchange,
    tv_instrument,
    action,
    meta,
  };

  log("📦 SIGNAL_PREVIEW", payload);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), CONFIG.C3_TIMEOUT_MS);

  try {
    const res = await fetchFn(CONFIG.C3_SIGNAL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await res.text().catch(() => "");
    log("✅ 3COMMAS_RESP", {
      action,
      status: res.status,
      ok: res.ok,
      body: text.slice(0, 500),
    });
  } finally {
    clearTimeout(t);
  }
}

// ------------------------------------------------------------
// Secret checks
// ------------------------------------------------------------
function checkSecret(body) {
  const inbound = String(body.secret || "");
  const src = String(body.src || "").toLowerCase();

  if (src === "tick") {
    if (!CONFIG.TICKROUTER_SECRET) return true;
    return inbound === CONFIG.TICKROUTER_SECRET;
  }

  if (!CONFIG.WEBHOOK_SECRET) return true;
  return inbound === CONFIG.WEBHOOK_SECRET;
}

// ------------------------------------------------------------
// Routes
// ------------------------------------------------------------
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    brain: CONFIG.BRAIN_NAME,
    symbol: CONFIG.SYMBOL,
    tf: CONFIG.ENTRY_TF,
    startedAt: S.startedAt,
  });
});

app.get("/status", (_req, res) => {
  res.json({
    ok: true,
    brain: CONFIG.BRAIN_NAME,
    symbol: CONFIG.SYMBOL,
    tf: CONFIG.ENTRY_TF,
    inPosition: S.inPosition,
    entryPrice: S.entryPrice,
    entryMode: S.entryMode,
    stopPrice: S.stopPrice,
    peakPrice: S.peakPrice,
    cooldownUntil: S.cooldownUntilMs ? new Date(S.cooldownUntilMs).toISOString() : null,
    bullContext: S.ray.bullContext,
    lastTickPrice: S.lastTickPrice,
    lastTickTime: S.lastTickTime,
    tickFresh: isTickFresh(),
    lastFeatureTime: S.lastFeatureTime,
    featureFresh: isFeatureFresh(),
    breakoutMemory: S.breakoutMemory,
    ray: S.ray,
    fvvo: S.fvvo,
    barIndex: S.barIndex,
    recentLogs: S.logs.slice(-20),
  });
});

app.post(CONFIG.WEBHOOK_PATH, (req, res) => {
  const body = req.body || {};

  if (!checkSecret(body)) {
    log("⛔ UNAUTHORIZED", { src: body.src, symbol: body.symbol });
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const symbol = normalizeSymbol(pickFirst(body, ["symbol"], CONFIG.SYMBOL));
  if (symbol !== CONFIG.SYMBOL) {
    log("🚫 SYMBOL_REJECTED", { got: symbol, want: CONFIG.SYMBOL });
    return res.status(400).json({ ok: false, error: "symbol_mismatch", got: symbol, want: CONFIG.SYMBOL });
  }

  const parsed = parseInboundType(body);

  try {
    if (parsed.family === "tick") {
      const ts = pickFirst(body, ["time", "timestamp"], isoNow());
      const px = n(body.price, NaN);
      if (!Number.isFinite(px)) return res.status(400).json({ ok: false, error: "bad_tick_price" });

      S.lastTickPrice = px;
      S.lastTickTime = ts;
      S.tickCount += 1;

      updatePositionFromTick(px);

      return res.json({
        ok: true,
        kind: "tick",
        price: px,
        inPosition: S.inPosition,
      });
    }

    if (parsed.family === "feature") {
      handleFeature(body);
      return res.json({
        ok: true,
        kind: "feature",
        barIndex: S.barIndex,
        inPosition: S.inPosition,
      });
    }

    if (parsed.family === "ray") {
      handleRayEvent(body);
      return res.json({
        ok: true,
        kind: "ray",
        event: parsed.name,
        bullContext: S.ray.bullContext,
        inPosition: S.inPosition,
      });
    }

    if (parsed.family === "fvvo") {
      handleFvvoEvent(body);
      return res.json({
        ok: true,
        kind: "fvvo",
        event: parsed.name,
      });
    }

    log("❓ UNKNOWN_EVENT", body);
    return res.json({ ok: true, kind: "unknown_ignored" });
  } catch (err) {
    log("💥 WEBHOOK_ERROR", { err: String(err?.stack || err) });
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.listen(CONFIG.PORT, () => {
  log("✅ brain listening", {
    port: CONFIG.PORT,
    path: CONFIG.WEBHOOK_PATH,
    symbol: CONFIG.SYMBOL,
    tf: CONFIG.ENTRY_TF,
    brain: CONFIG.BRAIN_NAME,
  });
});
