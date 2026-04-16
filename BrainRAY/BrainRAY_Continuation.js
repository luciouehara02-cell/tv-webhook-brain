import express from "express";

// ============================================================
// BrainRAY_Continuation_v2.6
//
// New in v2.6
// - keeps v2.5 fast tick launch
// - keeps strict deferred launch filter
// - adds deferred slow-ramp override
//
// Purpose:
// - still block weak deferred launches
// - allow structured slow bullish ramp setups
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
  const b2 = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b2) || a === 0) return 0;
  return ((b2 - a) / a) * 100;
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

function round4(x) {
  return Math.round(Number(x) * 10000) / 10000;
}

// ------------------------------------------------------------
// Config
// ------------------------------------------------------------
const CONFIG = {
  PORT: n(process.env.PORT, 8080),
  DEBUG: b(process.env.DEBUG, true),
  BRAIN_NAME: s(process.env.BRAIN_NAME, "BrainRAY_Continuation_v2.6"),

  WEBHOOK_SECRET: s(process.env.WEBHOOK_SECRET, ""),
  TICKROUTER_SECRET: s(process.env.TICKROUTER_SECRET, ""),
  WEBHOOK_PATH: s(process.env.WEBHOOK_PATH, "/webhook"),

  SYMBOL: normalizeSymbol(s(process.env.SYMBOL || "BINANCE:SOLUSDT")),
  ENTRY_TF: s(process.env.ENTRY_TF || "5"),
  TICK_MAX_AGE_SEC: n(process.env.TICK_MAX_AGE_SEC, 60),
  FEATURE_MAX_AGE_SEC: n(process.env.FEATURE_MAX_AGE_SEC, 900),
  REPLAY_ALLOW_STALE_DATA: b(process.env.REPLAY_ALLOW_STALE_DATA, false),

  ENTER_DEDUP_MS: n(process.env.ENTER_DEDUP_MS, 90000),
  EXIT_DEDUP_MS: n(process.env.EXIT_DEDUP_MS, 60000),
  EXIT_COOLDOWN_MIN: n(process.env.EXIT_COOLDOWN_MIN, 12),
  REENTRY_ENTER_DEDUP_MS: n(process.env.REENTRY_ENTER_DEDUP_MS, 8000),

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

  FVVO_USE_SNIPER_BUY: b(process.env.FVVO_USE_SNIPER_BUY, false),
  FVVO_SNIPER_LOOKBACK_BARS: n(process.env.FVVO_SNIPER_LOOKBACK_BARS, 3),

  REQUIRE_EMA8_ABOVE_EMA18: b(process.env.REQUIRE_EMA8_ABOVE_EMA18, true),
  REQUIRE_CLOSE_ABOVE_EMA8: b(process.env.REQUIRE_CLOSE_ABOVE_EMA8, true),
  MIN_RSI_LONG: n(process.env.MIN_RSI_LONG, 48),
  MIN_ADX_CONTINUATION: n(process.env.MIN_ADX_CONTINUATION, 14),

  CONTINUATION_MAX_CHASE_PCT: n(process.env.CONTINUATION_MAX_CHASE_PCT, 0.35),
  MAX_EXT_FROM_EMA8_PCT: n(process.env.MAX_EXT_FROM_EMA8_PCT, 0.75),
  MAX_EXT_FROM_EMA18_PCT: n(process.env.MAX_EXT_FROM_EMA18_PCT, 1.20),

  BREAKOUT_MEMORY_ENABLED: b(process.env.BREAKOUT_MEMORY_ENABLED, true),
  BREAKOUT_MEMORY_BARS: n(process.env.BREAKOUT_MEMORY_BARS, 4),
  BREAKOUT_MEMORY_MAX_CHASE_PCT: n(process.env.BREAKOUT_MEMORY_MAX_CHASE_PCT, 0.25),
  BREAKOUT_MEMORY_REQUIRE_ABOVE_RECLAIM: b(process.env.BREAKOUT_MEMORY_REQUIRE_ABOVE_RECLAIM, true),
  BREAKOUT_MEMORY_INVALIDATE_PCT: n(process.env.BREAKOUT_MEMORY_INVALIDATE_PCT, 0.10),

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

  PHASE2_REENTRY_ENABLED: b(process.env.PHASE2_REENTRY_ENABLED, true),
  MAX_REENTRIES_PER_BULL_REGIME: n(process.env.MAX_REENTRIES_PER_BULL_REGIME, 2),
  REENTRY_MIN_BARS_AFTER_EXIT: n(process.env.REENTRY_MIN_BARS_AFTER_EXIT, 1),
  REENTRY_REQUIRE_BULL_CONTEXT: b(process.env.REENTRY_REQUIRE_BULL_CONTEXT, true),
  REENTRY_REQUIRE_CLOSE_ABOVE_EMA8: b(process.env.REENTRY_REQUIRE_CLOSE_ABOVE_EMA8, true),
  REENTRY_MAX_CHASE_PCT: n(process.env.REENTRY_MAX_CHASE_PCT, 0.20),
  REENTRY_MIN_RESET_FROM_PEAK_PCT: n(process.env.REENTRY_MIN_RESET_FROM_PEAK_PCT, 0.15),

  LOCAL_TP_EXIT_ENABLED: b(process.env.LOCAL_TP_EXIT_ENABLED, true),
  LOCAL_TP_MIN_PROFIT_PCT: n(process.env.LOCAL_TP_MIN_PROFIT_PCT, 0.60),
  LOCAL_TP_EXIT_ON_CLOSE_BELOW_EMA8: b(process.env.LOCAL_TP_EXIT_ON_CLOSE_BELOW_EMA8, true),
  KEEP_BULL_CONTEXT_ON_TP_EXIT: b(process.env.KEEP_BULL_CONTEXT_ON_TP_EXIT, true),

  DYNAMIC_TP_ENABLED: b(process.env.DYNAMIC_TP_ENABLED, true),
  DTP_TIER1_ARM_PCT: n(process.env.DTP_TIER1_ARM_PCT, 0.60),
  DTP_TIER1_GIVEBACK_PCT: n(process.env.DTP_TIER1_GIVEBACK_PCT, 0.35),
  DTP_TIER2_ARM_PCT: n(process.env.DTP_TIER2_ARM_PCT, 1.20),
  DTP_TIER2_GIVEBACK_PCT: n(process.env.DTP_TIER2_GIVEBACK_PCT, 0.22),
  DTP_TIER3_ARM_PCT: n(process.env.DTP_TIER3_ARM_PCT, 1.80),
  DTP_TIER3_GIVEBACK_PCT: n(process.env.DTP_TIER3_GIVEBACK_PCT, 0.12),

  FAST_REENTRY_ENABLED: b(process.env.FAST_REENTRY_ENABLED, true),
  FAST_REENTRY_MIN_RESET_FROM_PEAK_PCT: n(process.env.FAST_REENTRY_MIN_RESET_FROM_PEAK_PCT, 0.20),
  FAST_REENTRY_REQUIRE_CLOSE_ABOVE_EMA8: b(process.env.FAST_REENTRY_REQUIRE_CLOSE_ABOVE_EMA8, true),
  FAST_REENTRY_MAX_CHASE_PCT: n(process.env.FAST_REENTRY_MAX_CHASE_PCT, 0.18),
  FAST_REENTRY_MIN_RSI: n(process.env.FAST_REENTRY_MIN_RSI, 50),
  FAST_REENTRY_MIN_ADX: n(process.env.FAST_REENTRY_MIN_ADX, 14),
  FAST_REENTRY_REQUIRE_BULL_CONTEXT: b(process.env.FAST_REENTRY_REQUIRE_BULL_CONTEXT, true),

  TREND_CHANGE_LAUNCH_ENABLED: b(process.env.TREND_CHANGE_LAUNCH_ENABLED, true),
  TREND_CHANGE_LAUNCH_MIN_RSI: n(process.env.TREND_CHANGE_LAUNCH_MIN_RSI, 60),
  TREND_CHANGE_LAUNCH_MIN_ADX: n(process.env.TREND_CHANGE_LAUNCH_MIN_ADX, 14),
  TREND_CHANGE_LAUNCH_MAX_CHASE_PCT: n(process.env.TREND_CHANGE_LAUNCH_MAX_CHASE_PCT, 0.35),
  TREND_CHANGE_LAUNCH_MAX_EXT_FROM_EMA18_PCT: n(process.env.TREND_CHANGE_LAUNCH_MAX_EXT_FROM_EMA18_PCT, 1.20),
  TREND_CHANGE_LAUNCH_MEMORY_BARS: n(process.env.TREND_CHANGE_LAUNCH_MEMORY_BARS, 2),

  DEFERRED_LAUNCH_MIN_RSI: n(process.env.DEFERRED_LAUNCH_MIN_RSI, 68),
  DEFERRED_LAUNCH_MIN_ADX: n(process.env.DEFERRED_LAUNCH_MIN_ADX, 18),

  STRONG_LAUNCH_OVERRIDE_ENABLED: b(process.env.STRONG_LAUNCH_OVERRIDE_ENABLED, true),
  STRONG_LAUNCH_MIN_RSI: n(process.env.STRONG_LAUNCH_MIN_RSI, 72),
  STRONG_LAUNCH_MIN_ADX: n(process.env.STRONG_LAUNCH_MIN_ADX, 24),
  STRONG_LAUNCH_MAX_CHASE_PCT: n(process.env.STRONG_LAUNCH_MAX_CHASE_PCT, 0.55),
  STRONG_LAUNCH_MAX_EXT_FROM_EMA18_PCT: n(process.env.STRONG_LAUNCH_MAX_EXT_FROM_EMA18_PCT, 1.35),

  FAST_TICK_LAUNCH_ENABLED: b(process.env.FAST_TICK_LAUNCH_ENABLED, true),
  FAST_TICK_LAUNCH_WINDOW_SEC: n(process.env.FAST_TICK_LAUNCH_WINDOW_SEC, 45),
  FAST_TICK_LAUNCH_MIN_RSI: n(process.env.FAST_TICK_LAUNCH_MIN_RSI, 56),
  FAST_TICK_LAUNCH_MIN_ADX: n(process.env.FAST_TICK_LAUNCH_MIN_ADX, 18),
  FAST_TICK_LAUNCH_CONFIRM_PCT: n(process.env.FAST_TICK_LAUNCH_CONFIRM_PCT, 0.05),
  FAST_TICK_LAUNCH_MAX_CHASE_PCT: n(process.env.FAST_TICK_LAUNCH_MAX_CHASE_PCT, 0.35),
  FAST_TICK_LAUNCH_MIN_TICKS_ABOVE_CONFIRM: n(process.env.FAST_TICK_LAUNCH_MIN_TICKS_ABOVE_CONFIRM, 2),
  FAST_TICK_LAUNCH_STRONG_MIN_RSI: n(process.env.FAST_TICK_LAUNCH_STRONG_MIN_RSI, 60),
  FAST_TICK_LAUNCH_STRONG_MIN_ADX: n(process.env.FAST_TICK_LAUNCH_STRONG_MIN_ADX, 22),
  FAST_TICK_LAUNCH_STRONG_MAX_CHASE_PCT: n(process.env.FAST_TICK_LAUNCH_STRONG_MAX_CHASE_PCT, 0.45),

  // New in v2.6
  DEFERRED_SLOW_RAMP_OVERRIDE_ENABLED: b(process.env.DEFERRED_SLOW_RAMP_OVERRIDE_ENABLED, true),
  DEFERRED_SLOW_RAMP_MIN_RSI: n(process.env.DEFERRED_SLOW_RAMP_MIN_RSI, 62),
  DEFERRED_SLOW_RAMP_MIN_ADX: n(process.env.DEFERRED_SLOW_RAMP_MIN_ADX, 20),
  DEFERRED_SLOW_RAMP_MAX_CHASE_PCT: n(process.env.DEFERRED_SLOW_RAMP_MAX_CHASE_PCT, 0.25),
  DEFERRED_SLOW_RAMP_MAX_EXT_FROM_EMA18_PCT: n(process.env.DEFERRED_SLOW_RAMP_MAX_EXT_FROM_EMA18_PCT, 0.60),

  ENABLE_HTTP_FORWARD: b(process.env.ENABLE_HTTP_FORWARD, true),
};

const fetchFn = globalThis.fetch;

// ------------------------------------------------------------
// Initial runtime state / reset support
// ------------------------------------------------------------
function buildInitialRuntimeState() {
  return {
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
    peakPrice: null,
    peakPnlPct: 0,
    dynamicTpTier: 0,
    cooldownUntilMs: 0,

    lastEnterAtMs: 0,
    lastExitAtMs: 0,
    lastAction: null,

    cycleState: "flat",
    lastExitClass: null,

    ray: {
      bullContext: false,
      bullRegimeId: 0,
      bullRegimeStartedAt: null,
      reentryCountInRegime: 0,

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

    reentry: {
      eligible: false,
      eligibleUntilBar: null,
      eligibleFromBar: null,
      exitPrice: null,
      peakBeforeExit: null,
      anchorPrice: null,
      bullRegimeId: null,
    },

    trendChangeLaunch: {
      pending: false,
      armedBar: null,
      expiresBar: null,
      rayPrice: null,
      rayTime: null,
    },

    fastTickLaunch: {
      active: false,
      openedAtMs: null,
      expiresAtMs: null,
      bullRegimeId: null,
      source: null,
      rayPrice: null,
      confirmPrice: null,
      featureClose: null,
      ema8: null,
      ema18: null,
      rsi: null,
      adx: null,
      breakoutHigh: null,
      ticksAboveConfirm: 0,
      lastConfirmedTickPrice: null,
    },
  };
}

const S = {
  ...buildInitialRuntimeState(),
  logs: [],
};

function log(msg, data = null) {
  const line = data ? `${msg} | ${JSON.stringify(data)}` : msg;
  const out = `${isoNow()} ${line}`;
  S.logs.push(out);
  if (S.logs.length > 700) S.logs.shift();
  if (CONFIG.DEBUG) console.log(out);
}

function resetRuntimeState(reason = "manual_reset") {
  const keepLogs = Array.isArray(S.logs) ? S.logs : [];
  const fresh = buildInitialRuntimeState();

  for (const key of Object.keys(fresh)) {
    S[key] = fresh[key];
  }

  S.logs = keepLogs;
  log("♻️ STATE_RESET", { reason });
}

function currentPrice() {
  return Number.isFinite(S.lastTickPrice) ? S.lastTickPrice : n(S.lastFeature?.close, NaN);
}

function isTickFresh() {
  if (CONFIG.REPLAY_ALLOW_STALE_DATA) return true;
  return ageSec(S.lastTickTime) <= CONFIG.TICK_MAX_AGE_SEC;
}

function isFeatureFresh() {
  if (CONFIG.REPLAY_ALLOW_STALE_DATA) return true;
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

function clearReentry(reason = "reset") {
  if (S.reentry.eligible) {
    log("🔁 REENTRY_DISABLED", { reason });
  }
  S.reentry = {
    eligible: false,
    eligibleUntilBar: null,
    eligibleFromBar: null,
    exitPrice: null,
    peakBeforeExit: null,
    anchorPrice: null,
    bullRegimeId: null,
  };
}

function armTrendChangeLaunch(rayPrice, rayTime) {
  S.trendChangeLaunch = {
    pending: true,
    armedBar: S.barIndex,
    expiresBar: S.barIndex + CONFIG.TREND_CHANGE_LAUNCH_MEMORY_BARS,
    rayPrice,
    rayTime,
  };

  log("🚀 TREND_CHANGE_LAUNCH_ARMED", {
    armedBar: S.trendChangeLaunch.armedBar,
    expiresBar: S.trendChangeLaunch.expiresBar,
    rayPrice,
    rayTime,
  });
}

function clearTrendChangeLaunch(reason = "reset") {
  if (S.trendChangeLaunch.pending) {
    log("🚀 TREND_CHANGE_LAUNCH_CLEARED", { reason });
  }
  S.trendChangeLaunch = {
    pending: false,
    armedBar: null,
    expiresBar: null,
    rayPrice: null,
    rayTime: null,
  };
}

function armFastTickLaunch(source, rayPrice) {
  if (!CONFIG.FAST_TICK_LAUNCH_ENABLED) return;
  const f = S.lastFeature;
  if (!f) return;

  const confirmPrice = rayPrice * (1 + CONFIG.FAST_TICK_LAUNCH_CONFIRM_PCT / 100);

  S.fastTickLaunch = {
    active: true,
    openedAtMs: nowMs(),
    expiresAtMs: nowMs() + CONFIG.FAST_TICK_LAUNCH_WINDOW_SEC * 1000,
    bullRegimeId: S.ray.bullRegimeId,
    source,
    rayPrice,
    confirmPrice,
    featureClose: f.close,
    ema8: f.ema8,
    ema18: f.ema18,
    rsi: f.rsi,
    adx: f.adx,
    breakoutHigh: Number.isFinite(S.breakoutMemory.breakoutHigh) ? S.breakoutMemory.breakoutHigh : f.high,
    ticksAboveConfirm: 0,
    lastConfirmedTickPrice: null,
  };

  log("⚡ FAST_TICK_LAUNCH_ARMED", {
    source,
    bullRegimeId: S.fastTickLaunch.bullRegimeId,
    rayPrice,
    confirmPrice: round4(confirmPrice),
    expiresAt: new Date(S.fastTickLaunch.expiresAtMs).toISOString(),
    rsi: f.rsi,
    adx: f.adx,
    ema8: f.ema8,
    ema18: f.ema18,
  });
}

function clearFastTickLaunch(reason = "reset") {
  if (S.fastTickLaunch.active) {
    log("⚡ FAST_TICK_LAUNCH_CLEARED", { reason });
  }
  S.fastTickLaunch = {
    active: false,
    openedAtMs: null,
    expiresAtMs: null,
    bullRegimeId: null,
    source: null,
    rayPrice: null,
    confirmPrice: null,
    featureClose: null,
    ema8: null,
    ema18: null,
    rsi: null,
    adx: null,
    breakoutHigh: null,
    ticksAboveConfirm: 0,
    lastConfirmedTickPrice: null,
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
function turnBullRegimeOn(ts, source) {
  if (!S.ray.bullContext) {
    S.ray.bullContext = true;
    S.ray.bullRegimeId += 1;
    S.ray.bullRegimeStartedAt = ts;
    S.ray.reentryCountInRegime = 0;
    S.cycleState = S.inPosition ? "long" : "flat";
    clearReentry("new_bull_regime");
    log("🟢 BULL_REGIME_ON", {
      source,
      bullRegimeId: S.ray.bullRegimeId,
      ts,
    });
  }
}

function turnBullRegimeOff(ts, reason) {
  if (S.ray.bullContext) {
    S.ray.bullContext = false;
    S.cycleState = S.inPosition ? "long" : "disabled_by_bear_regime";
    clearBreakoutMemory("bull_regime_off");
    clearReentry("bull_regime_off");
    clearTrendChangeLaunch("bull_regime_off");
    clearFastTickLaunch("bull_regime_off");
    log("🔴 BULL_REGIME_OFF", { reason, ts, bullRegimeId: S.ray.bullRegimeId });
  }
}

function handleRayEvent(body) {
  const name = String(body.event || body.signal || body.alert || body.action || "").trim();
  const ts = pickFirst(body, ["time", "timestamp"], isoNow());
  const price = n(pickFirst(body, ["price", "trigger_price", "close"], currentPrice()));

  if (/Bullish Trend Change/i.test(name) && CONFIG.RAY_USE_BULLISH_TREND_CHANGE) {
    S.ray.lastBullTrendChangeAt = ts;
    turnBullRegimeOn(ts, "ray_bullish_trend_change");
    log("🟢 RAY_BULLISH_TREND_CHANGE", { price, ts });

    if (CONFIG.TREND_CHANGE_LAUNCH_ENABLED) {
      armTrendChangeLaunch(price, ts);
      const decision = tryEntry("immediate_trend_change_launch", {
        ...body,
        src: "ray",
        event: "Bullish Trend Change",
        price,
        time: ts,
      });
      if (!decision.allow) {
        armFastTickLaunch("ray_bullish_trend_change", price);
      }
    }
    return;
  }

  if (/Bullish Trend Continuation/i.test(name) && CONFIG.RAY_USE_BULLISH_TREND_CONTINUATION) {
    S.ray.lastBullTrendContinuationAt = ts;
    if (!S.ray.bullContext) turnBullRegimeOn(ts, "ray_bullish_trend_continuation");
    log("🟩 RAY_BULLISH_TREND_CONTINUATION", { price, ts });

    const decision = tryEntry("ray_bullish_trend_continuation", body);

    if (!decision.allow && CONFIG.FAST_TICK_LAUNCH_ENABLED) {
      armFastTickLaunch("ray_bullish_trend_continuation", price);
    }
    return;
  }

  if (/Bullish BOS/i.test(name) && CONFIG.RAY_USE_BULLISH_BOS) {
    S.ray.lastBullBosAt = ts;
    log("🔹 RAY_BULLISH_BOS", { price, ts });
    return;
  }

  if (/Bearish Trend Change/i.test(name) && CONFIG.RAY_USE_BEARISH_TREND_CHANGE) {
    S.ray.lastBearTrendChangeAt = ts;
    log("🔴 RAY_BEARISH_TREND_CHANGE", { price, ts });

    if (S.inPosition && CONFIG.EXIT_ON_BEARISH_TREND_CHANGE) {
      doExit("ray_bearish_trend_change", price, ts, "regime_break");
    }

    turnBullRegimeOff(ts, "ray_bearish_trend_change");
    return;
  }

  if (/Bearish Trend Continuation/i.test(name) && CONFIG.RAY_USE_BEARISH_TREND_CONTINUATION) {
    S.ray.lastBearTrendContinuationAt = ts;
    log("🟥 RAY_BEARISH_TREND_CONTINUATION", { price, ts });

    if (S.inPosition && CONFIG.EXIT_ON_BEARISH_TREND_CONTINUATION) {
      doExit("ray_bearish_trend_continuation", price, ts, "regime_break");
      turnBullRegimeOff(ts, "ray_bearish_trend_continuation");
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
    invalidateReentry();
    invalidateTrendChangeLaunch();
    invalidateFastTickLaunch();
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
  evaluateReentryEligibilityFromFeature(feature);

  if (CONFIG.TREND_CHANGE_LAUNCH_ENABLED && S.trendChangeLaunch.pending) {
    tryEntry("deferred_trend_change_launch", {
      src: "ray",
      symbol: CONFIG.SYMBOL,
      tf: CONFIG.ENTRY_TF,
      event: "Bullish Trend Change",
      price: feature.close,
      time: feature.time,
    });
  }

  if (CONFIG.PHASE2_REENTRY_ENABLED && S.reentry.eligible && !S.inPosition) {
    tryEntry("feature_reentry", {
      src: "features",
      symbol: CONFIG.SYMBOL,
      tf: CONFIG.ENTRY_TF,
      close: feature.close,
      price: feature.close,
      time: feature.time,
    });
  }

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

  const bullRayContext =
    S.ray.bullContext ||
    ageSec(S.ray.lastBullTrendChangeAt) < 3600 ||
    ageSec(S.ray.lastBullTrendContinuationAt) < 1800;
  const bullishBosRecent = ageSec(S.ray.lastBullBosAt) < 1800;

  const structureOk = bullEmaOk && closeAboveEma8Ok && rsiOk && adxOk && (bullRayContext || bullishBosRecent);
  if (!structureOk) return;

  S.breakoutMemory = {
    active: true,
    used: false,
    armedBar: S.barIndex,
    expiresBar: S.barIndex + CONFIG.BREAKOUT_MEMORY_BARS,
    triggerPrice: f.close,
    reclaimPrice: Number.isFinite(f.ema8) ? f.ema8 : f.close,
    breakoutHigh: f.high,
    mode: "breakout_continuation_memory",
    armedAt: isoNow(),
  };

  log("🧠 BREAKOUT_MEMORY_ARMED", {
    armedBar: S.breakoutMemory.armedBar,
    expiresBar: S.breakoutMemory.expiresBar,
    triggerPrice: S.breakoutMemory.triggerPrice,
    reclaimPrice: S.breakoutMemory.reclaimPrice,
    breakoutHigh: S.breakoutMemory.breakoutHigh,
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
    if (px < floor) return clearBreakoutMemory("lost_reclaim");
  }
}

function invalidateReentry() {
  if (!S.reentry.eligible) return;
  if (S.barIndex > n(S.reentry.eligibleUntilBar, -1)) {
    return clearReentry("expired");
  }
}

function invalidateTrendChangeLaunch() {
  if (!S.trendChangeLaunch.pending) return;
  if (S.barIndex > n(S.trendChangeLaunch.expiresBar, -1)) {
    clearTrendChangeLaunch("expired");
  }
}

function invalidateFastTickLaunch() {
  if (!S.fastTickLaunch.active) return;
  if (nowMs() > n(S.fastTickLaunch.expiresAtMs, 0)) {
    clearFastTickLaunch("expired");
    return;
  }
  if (S.fastTickLaunch.bullRegimeId !== S.ray.bullRegimeId) {
    clearFastTickLaunch("regime_changed");
  }
}

function evaluateReentryEligibilityFromFeature(feature) {
  if (!CONFIG.PHASE2_REENTRY_ENABLED) return;
  if (!S.ray.bullContext) return;
  if (!S.reentry.eligible) return;
  if (S.reentry.bullRegimeId !== S.ray.bullRegimeId) return;

  const peak = n(S.reentry.peakBeforeExit, NaN);
  const close = n(feature.close, NaN);
  if (!Number.isFinite(peak) || !Number.isFinite(close)) return;

  const resetThreshold = CONFIG.FAST_REENTRY_ENABLED
    ? CONFIG.FAST_REENTRY_MIN_RESET_FROM_PEAK_PCT
    : CONFIG.REENTRY_MIN_RESET_FROM_PEAK_PCT;

  const resetFromPeakPct = pctDiff(peak, close);
  if (resetFromPeakPct <= -resetThreshold) {
    S.reentry.anchorPrice = Number.isFinite(feature.ema8) ? feature.ema8 : close;
    log("🔁 REENTRY_ELIGIBLE", {
      bullRegimeId: S.ray.bullRegimeId,
      barIndex: S.barIndex,
      resetFromPeakPct,
      anchorPrice: S.reentry.anchorPrice,
    });
  }
}

// ------------------------------------------------------------
// Entry logic
// ------------------------------------------------------------
function activeEnterDedupMs(source) {
  if (source === "feature_reentry" || source === "pullback_reclaim_reentry_long") {
    return CONFIG.REENTRY_ENTER_DEDUP_MS;
  }
  return CONFIG.ENTER_DEDUP_MS;
}

function tryEntry(source, body) {
  const decision = evaluateEntry(source, body);
  if (!decision.allow) {
    if (
      source === "deferred_trend_change_launch" ||
      source === "immediate_trend_change_launch" ||
      source === "tick_confirmed_fast_launch"
    ) {
      log("🚫 LAUNCH_ENTRY_BLOCKED", decision);
    } else {
      log("🚫 ENTRY_BLOCKED", decision);
    }
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
  reasonPush(reasons, now - S.lastEnterAtMs < activeEnterDedupMs(source), "enter_dedup");
  reasonPush(reasons, !isFeatureFresh(), "stale_feature");
  reasonPush(reasons, !S.ray.bullContext, "no_bull_context");
  reasonPush(reasons, !Number.isFinite(px), "bad_price");
  reasonPush(reasons, !feature, "no_feature");

  if (source === "tick_confirmed_fast_launch") {
    reasonPush(reasons, !isTickFresh(), "stale_tick");
  }

  if (reasons.length) {
    return { allow: false, source, reasons };
  }

  const ema8 = n(feature.ema8, NaN);
  const ema18 = n(feature.ema18, NaN);
  const close = n(feature.close, NaN);
  const rsi = n(feature.rsi, NaN);
  const adx = n(feature.adx, NaN);

  const emaBullOk =
    !CONFIG.REQUIRE_EMA8_ABOVE_EMA18 ||
    (Number.isFinite(ema8) && Number.isFinite(ema18) && ema8 >= ema18);

  const closeAboveEma8Ok =
    !CONFIG.REQUIRE_CLOSE_ABOVE_EMA8 ||
    (Number.isFinite(close) && Number.isFinite(ema8) && close >= ema8);

  const rsiOk = !Number.isFinite(rsi) || rsi >= CONFIG.MIN_RSI_LONG;
  const adxOk = !Number.isFinite(adx) || adx >= CONFIG.MIN_ADX_CONTINUATION;

  const extFromEma8 = Number.isFinite(ema8) ? pctDiff(ema8, px) : 0;
  const extFromEma18 = Number.isFinite(ema18) ? pctDiff(ema18, px) : 0;

  const recentSniperBuy =
    ageSec(S.fvvo.lastSniperBuyAt) <= CONFIG.FVVO_SNIPER_LOOKBACK_BARS * n(CONFIG.ENTRY_TF, 5) * 60;

  // --------------------------------------------------------
  // v2.5 fast tick launch
  // --------------------------------------------------------
  if (source === "tick_confirmed_fast_launch" && CONFIG.FAST_TICK_LAUNCH_ENABLED) {
    const tl = S.fastTickLaunch;
    const tlReasons = [];

    reasonPush(tlReasons, !tl.active, "fast_tick_launch_not_active");
    reasonPush(tlReasons, now > n(tl.expiresAtMs, 0), "fast_tick_launch_expired");
    reasonPush(tlReasons, tl.bullRegimeId !== S.ray.bullRegimeId, "fast_tick_launch_regime_mismatch");
    reasonPush(tlReasons, !emaBullOk, "fast_tick_launch_ema_invalid");

    const minRsi = CONFIG.FAST_TICK_LAUNCH_MIN_RSI;
    const minAdx = CONFIG.FAST_TICK_LAUNCH_MIN_ADX;
    const strongRsi = CONFIG.FAST_TICK_LAUNCH_STRONG_MIN_RSI;
    const strongAdx = CONFIG.FAST_TICK_LAUNCH_STRONG_MIN_ADX;

    const strongFastLaunch =
      Number.isFinite(rsi) &&
      Number.isFinite(adx) &&
      rsi >= strongRsi &&
      adx >= strongAdx;

    const allowedChase = strongFastLaunch
      ? CONFIG.FAST_TICK_LAUNCH_STRONG_MAX_CHASE_PCT
      : CONFIG.FAST_TICK_LAUNCH_MAX_CHASE_PCT;

    reasonPush(tlReasons, Number.isFinite(rsi) && rsi < minRsi, "fast_tick_launch_rsi_too_low");
    reasonPush(tlReasons, Number.isFinite(adx) && adx < minAdx, "fast_tick_launch_adx_too_low");
    reasonPush(tlReasons, extFromEma8 > allowedChase, "fast_tick_launch_chase_too_high");
    reasonPush(tlReasons, px < n(tl.confirmPrice, Infinity), "fast_tick_launch_below_confirm");
    reasonPush(
      tlReasons,
      n(tl.ticksAboveConfirm, 0) < CONFIG.FAST_TICK_LAUNCH_MIN_TICKS_ABOVE_CONFIRM,
      "fast_tick_launch_not_enough_confirm_ticks"
    );

    if (tlReasons.length === 0) {
      return {
        allow: true,
        source,
        mode: strongFastLaunch
          ? "tick_confirmed_launch_long_strong"
          : "tick_confirmed_launch_long",
        entryPrice: px,
        extFromEma8,
        extFromEma18,
        ticksAboveConfirm: tl.ticksAboveConfirm,
        confirmPrice: round4(tl.confirmPrice),
        strongFastLaunch,
      };
    }

    return {
      allow: false,
      source,
      reasons: tlReasons,
      extFromEma8,
      extFromEma18,
      ticksAboveConfirm: tl.ticksAboveConfirm,
      confirmPrice: round4(tl.confirmPrice),
      strongFastLaunchCandidate: strongFastLaunch,
    };
  }

  // --------------------------------------------------------
  // Immediate or deferred trend-change launch
  // --------------------------------------------------------
  if (
    (source === "immediate_trend_change_launch" ||
      source === "deferred_trend_change_launch" ||
      source === "ray_bullish_trend_change_launch") &&
    CONFIG.TREND_CHANGE_LAUNCH_ENABLED
  ) {
    const launchReasons = [];
    const launchAnchor = Number.isFinite(ema8) ? ema8 : close;
    const launchChasePct = Number.isFinite(launchAnchor) ? pctDiff(launchAnchor, px) : 999;

    const isDeferredLaunch =
      source === "deferred_trend_change_launch" ||
      source === "ray_bullish_trend_change_launch";

    const minLaunchRsi = isDeferredLaunch
      ? CONFIG.DEFERRED_LAUNCH_MIN_RSI
      : CONFIG.TREND_CHANGE_LAUNCH_MIN_RSI;

    const minLaunchAdx = isDeferredLaunch
      ? CONFIG.DEFERRED_LAUNCH_MIN_ADX
      : CONFIG.TREND_CHANGE_LAUNCH_MIN_ADX;

    const strongOverride =
      CONFIG.STRONG_LAUNCH_OVERRIDE_ENABLED &&
      Number.isFinite(rsi) &&
      Number.isFinite(adx) &&
      rsi >= CONFIG.STRONG_LAUNCH_MIN_RSI &&
      adx >= CONFIG.STRONG_LAUNCH_MIN_ADX &&
      extFromEma18 <= CONFIG.STRONG_LAUNCH_MAX_EXT_FROM_EMA18_PCT &&
      launchChasePct <= CONFIG.STRONG_LAUNCH_MAX_CHASE_PCT;

    const slowRampOverride =
      isDeferredLaunch &&
      CONFIG.DEFERRED_SLOW_RAMP_OVERRIDE_ENABLED &&
      Number.isFinite(rsi) &&
      Number.isFinite(adx) &&
      emaBullOk &&
      closeAboveEma8Ok &&
      rsi >= CONFIG.DEFERRED_SLOW_RAMP_MIN_RSI &&
      adx >= CONFIG.DEFERRED_SLOW_RAMP_MIN_ADX &&
      launchChasePct <= CONFIG.DEFERRED_SLOW_RAMP_MAX_CHASE_PCT &&
      extFromEma18 <= CONFIG.DEFERRED_SLOW_RAMP_MAX_EXT_FROM_EMA18_PCT;

    const allowedLaunchChase = strongOverride
      ? CONFIG.STRONG_LAUNCH_MAX_CHASE_PCT
      : CONFIG.TREND_CHANGE_LAUNCH_MAX_CHASE_PCT;

    const allowedLaunchExtEma18 = strongOverride
      ? CONFIG.STRONG_LAUNCH_MAX_EXT_FROM_EMA18_PCT
      : CONFIG.TREND_CHANGE_LAUNCH_MAX_EXT_FROM_EMA18_PCT;

    reasonPush(launchReasons, !S.trendChangeLaunch.pending, "launch_not_pending");
    reasonPush(launchReasons, S.barIndex > n(S.trendChangeLaunch.expiresBar, -1), "launch_pending_expired");
    reasonPush(launchReasons, !emaBullOk, "launch_ema8_below_ema18");
    reasonPush(launchReasons, !closeAboveEma8Ok, "launch_close_below_ema8");

    if (!slowRampOverride) {
      reasonPush(launchReasons, Number.isFinite(rsi) && rsi < minLaunchRsi, "launch_rsi_too_low");
      reasonPush(launchReasons, Number.isFinite(adx) && adx < minLaunchAdx, "launch_adx_too_low");
    }

    reasonPush(launchReasons, launchChasePct > allowedLaunchChase, "launch_chase_too_high");
    reasonPush(launchReasons, extFromEma18 > allowedLaunchExtEma18, "launch_too_extended_from_ema18");

    if (launchReasons.length === 0) {
      return {
        allow: true,
        source,
        mode: strongOverride
          ? "bullish_trend_change_launch_long_strong"
          : slowRampOverride
          ? "bullish_trend_change_launch_long_slow_ramp"
          : "bullish_trend_change_launch_long",
        entryPrice: px,
        extFromEma8,
        extFromEma18,
        launchChasePct,
        armedBar: S.trendChangeLaunch.armedBar,
        expiresBar: S.trendChangeLaunch.expiresBar,
        strongOverride,
        slowRampOverride,
        isDeferredLaunch,
        minLaunchRsi,
        minLaunchAdx,
      };
    }

    return {
      allow: false,
      source,
      reasons: launchReasons,
      extFromEma8,
      extFromEma18,
      launchChasePct,
      armedBar: S.trendChangeLaunch.armedBar,
      expiresBar: S.trendChangeLaunch.expiresBar,
      strongOverrideCandidate:
        CONFIG.STRONG_LAUNCH_OVERRIDE_ENABLED &&
        Number.isFinite(rsi) &&
        Number.isFinite(adx) &&
        rsi >= CONFIG.STRONG_LAUNCH_MIN_RSI &&
        adx >= CONFIG.STRONG_LAUNCH_MIN_ADX,
      slowRampOverrideCandidate:
        isDeferredLaunch &&
        CONFIG.DEFERRED_SLOW_RAMP_OVERRIDE_ENABLED &&
        Number.isFinite(rsi) &&
        Number.isFinite(adx) &&
        emaBullOk &&
        closeAboveEma8Ok &&
        rsi >= CONFIG.DEFERRED_SLOW_RAMP_MIN_RSI &&
        adx >= CONFIG.DEFERRED_SLOW_RAMP_MIN_ADX &&
        launchChasePct <= CONFIG.DEFERRED_SLOW_RAMP_MAX_CHASE_PCT &&
        extFromEma18 <= CONFIG.DEFERRED_SLOW_RAMP_MAX_EXT_FROM_EMA18_PCT,
      isDeferredLaunch,
      minLaunchRsi,
      minLaunchAdx,
    };
  }

  // --------------------------------------------------------
  // Re-entry path
  // --------------------------------------------------------
  if (CONFIG.PHASE2_REENTRY_ENABLED && S.reentry.eligible) {
    const rr = [];
    const useFast = CONFIG.FAST_REENTRY_ENABLED;

    reasonPush(
      rr,
      (useFast ? CONFIG.FAST_REENTRY_REQUIRE_BULL_CONTEXT : CONFIG.REENTRY_REQUIRE_BULL_CONTEXT) &&
        !S.ray.bullContext,
      "reentry_no_bull_context"
    );
    reasonPush(rr, S.reentry.bullRegimeId !== S.ray.bullRegimeId, "reentry_regime_mismatch");
    reasonPush(rr, S.ray.reentryCountInRegime >= CONFIG.MAX_REENTRIES_PER_BULL_REGIME, "max_reentry_reached");
    reasonPush(rr, S.barIndex < n(S.reentry.eligibleFromBar, 0), "reentry_too_early");

    const reentryRequireCloseAboveEma8 = useFast
      ? CONFIG.FAST_REENTRY_REQUIRE_CLOSE_ABOVE_EMA8
      : CONFIG.REENTRY_REQUIRE_CLOSE_ABOVE_EMA8;

    const reentryCloseAboveEma8Ok =
      !reentryRequireCloseAboveEma8 || (Number.isFinite(close) && Number.isFinite(ema8) && close >= ema8);

    const anchor = Number.isFinite(S.reentry.anchorPrice) ? S.reentry.anchorPrice : ema8;
    const reentryChasePct = Number.isFinite(anchor) ? pctDiff(anchor, px) : 999;
    const maxReentryChase = useFast ? CONFIG.FAST_REENTRY_MAX_CHASE_PCT : CONFIG.REENTRY_MAX_CHASE_PCT;
    const minRsi = useFast ? CONFIG.FAST_REENTRY_MIN_RSI : CONFIG.MIN_RSI_LONG;
    const minAdx = useFast ? CONFIG.FAST_REENTRY_MIN_ADX : CONFIG.MIN_ADX_CONTINUATION;

    reasonPush(rr, !emaBullOk, "reentry_ema_invalid");
    reasonPush(rr, !reentryCloseAboveEma8Ok, "reentry_close_below_ema8");
    reasonPush(rr, Number.isFinite(rsi) && rsi < minRsi, "reentry_rsi_too_low");
    reasonPush(rr, Number.isFinite(adx) && adx < minAdx, "reentry_adx_too_low");
    reasonPush(rr, reentryChasePct > maxReentryChase, "reentry_chase_too_high");

    if (rr.length === 0) {
      return {
        allow: true,
        source,
        mode:
          source === "feature_reentry"
            ? "feature_pullback_reclaim_reentry_long"
            : "pullback_reclaim_reentry_long",
        entryPrice: px,
        reentryChasePct,
        anchor: round4(anchor),
        bullRegimeId: S.ray.bullRegimeId,
      };
    }
  }

  // --------------------------------------------------------
  // Continuation path
  // --------------------------------------------------------
  const contReasons = [];
  reasonPush(contReasons, !emaBullOk, "ema8_below_ema18");
  reasonPush(contReasons, !closeAboveEma8Ok, "close_below_ema8");
  reasonPush(contReasons, !rsiOk, "rsi_too_low");
  reasonPush(contReasons, !adxOk, "adx_too_low");
  reasonPush(contReasons, extFromEma8 > CONFIG.MAX_EXT_FROM_EMA8_PCT, "too_extended_from_ema8");
  reasonPush(contReasons, extFromEma18 > CONFIG.MAX_EXT_FROM_EMA18_PCT, "too_extended_from_ema18");

  const contAnchor = Number.isFinite(ema8) ? ema8 : close;
  const contChasePct = Number.isFinite(contAnchor) ? pctDiff(contAnchor, px) : 999;
  reasonPush(contReasons, contChasePct > CONFIG.CONTINUATION_MAX_CHASE_PCT, "continuation_chase_too_high");

  if (contReasons.length === 0) {
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

  // --------------------------------------------------------
  // Breakout memory fallback
  // --------------------------------------------------------
  const mem = S.breakoutMemory;
  const memReasons = [];
  const memActive = CONFIG.BREAKOUT_MEMORY_ENABLED && mem.active && !mem.used;

  reasonPush(memReasons, !memActive, "no_breakout_memory");

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
      memAnchor: round4(memAnchor),
      reclaimPrice: round4(mem.reclaimPrice),
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
  const stop = price * (1 - CONFIG.HARD_STOP_PCT / 100);

  S.inPosition = true;
  S.entryPrice = price;
  S.entryAt = isoNow();
  S.entryMode = mode;
  S.stopPrice = stop;
  S.beArmed = false;
  S.peakPrice = price;
  S.peakPnlPct = 0;
  S.dynamicTpTier = 0;
  S.lastEnterAtMs = nowMs();
  S.lastAction = "enter";
  S.cycleState = "long";

  if (mode === "pullback_reclaim_reentry_long" || mode === "feature_pullback_reclaim_reentry_long") {
    S.ray.reentryCountInRegime += 1;
    clearReentry("consumed_on_reentry");
  }

  if (
    mode === "bullish_trend_change_launch_long" ||
    mode === "bullish_trend_change_launch_long_strong" ||
    mode === "bullish_trend_change_launch_long_slow_ramp" ||
    mode === "tick_confirmed_launch_long" ||
    mode === "tick_confirmed_launch_long_strong"
  ) {
    clearTrendChangeLaunch("consumed_on_entry");
    clearFastTickLaunch("consumed_on_entry");
  }

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
function currentDynamicTpTier(pnlPct) {
  if (!CONFIG.DYNAMIC_TP_ENABLED) return 0;
  if (pnlPct >= CONFIG.DTP_TIER3_ARM_PCT) return 3;
  if (pnlPct >= CONFIG.DTP_TIER2_ARM_PCT) return 2;
  if (pnlPct >= CONFIG.DTP_TIER1_ARM_PCT) return 1;
  return 0;
}

function dynamicTpGivebackForTier(tier) {
  if (tier === 3) return CONFIG.DTP_TIER3_GIVEBACK_PCT;
  if (tier === 2) return CONFIG.DTP_TIER2_GIVEBACK_PCT;
  if (tier === 1) return CONFIG.DTP_TIER1_GIVEBACK_PCT;
  return null;
}

function updatePositionFromTick(price) {
  if (!S.inPosition || !Number.isFinite(price) || !Number.isFinite(S.entryPrice)) return;

  if (!Number.isFinite(S.peakPrice) || price > S.peakPrice) {
    S.peakPrice = price;
  }

  const pnlPct = pctDiff(S.entryPrice, price);
  S.peakPnlPct = Math.max(S.peakPnlPct || 0, pnlPct);

  const tier = currentDynamicTpTier(S.peakPnlPct);
  if (tier > (S.dynamicTpTier || 0)) {
    S.dynamicTpTier = tier;
    log(`🎯 DYNAMIC_TP_TIER_${tier}_ARMED`, {
      pnlPct: round4(pnlPct),
      peakPnlPct: round4(S.peakPnlPct),
    });
  }

  if (!S.beArmed && pnlPct >= CONFIG.BREAKEVEN_ARM_PCT) {
    S.beArmed = true;
    const beStop = S.entryPrice * (1 + CONFIG.BREAKEVEN_OFFSET_PCT / 100);
    S.stopPrice = Math.max(S.stopPrice, beStop);
    log("🛡️ BREAKEVEN_ARMED", { pnlPct: round4(pnlPct), stopPrice: round4(S.stopPrice) });
  }

  if (price <= S.stopPrice) {
    const exitClass = S.beArmed ? "cycle_exit" : "stop_exit";
    return doExit("hard_or_breakeven_stop", price, isoNow(), exitClass);
  }

  if (CONFIG.DYNAMIC_TP_ENABLED && S.dynamicTpTier > 0) {
    const giveback = dynamicTpGivebackForTier(S.dynamicTpTier);
    const peakPnl = S.peakPnlPct || 0;
    const pnlGiveback = peakPnl - pnlPct;

    if (Number.isFinite(giveback) && pnlGiveback >= giveback) {
      return doExit(
        `dynamic_tp_tier${S.dynamicTpTier}_giveback`,
        price,
        isoNow(),
        "cycle_exit"
      );
    }
  } else {
    const drawFromPeakPct = Number.isFinite(S.peakPrice) ? -pctDiff(S.peakPrice, price) : 0;

    if (pnlPct >= CONFIG.PROFIT_LOCK_ARM_PCT && drawFromPeakPct >= CONFIG.PROFIT_LOCK_GIVEBACK_PCT) {
      return doExit("profit_lock_giveback", price, isoNow(), "cycle_exit");
    }

    if (pnlPct >= CONFIG.TRAIL_ARM_PCT && drawFromPeakPct >= CONFIG.TRAIL_GIVEBACK_PCT) {
      return doExit("trail_giveback", price, isoNow(), "cycle_exit");
    }
  }
}

function evaluateBarExit(feature) {
  if (!S.inPosition) return;
  const price = n(feature.close, currentPrice());
  const pnlPct = pctDiff(S.entryPrice, price);

  if (
    CONFIG.LOCAL_TP_EXIT_ENABLED &&
    CONFIG.LOCAL_TP_EXIT_ON_CLOSE_BELOW_EMA8 &&
    Number.isFinite(feature.ema8) &&
    price < feature.ema8 &&
    pnlPct >= CONFIG.LOCAL_TP_MIN_PROFIT_PCT
  ) {
    return doExit("local_tp_close_below_ema8", price, feature.time, "cycle_exit");
  }

  if (CONFIG.EXIT_ON_5M_CLOSE_BELOW_EMA18 && Number.isFinite(feature.ema18) && price < feature.ema18) {
    return doExit("close_below_ema18_5m", price, feature.time, "regime_break");
  }
}

function markReentryEligible(reason, exitPrice) {
  if (!CONFIG.PHASE2_REENTRY_ENABLED) return;
  if (!CONFIG.KEEP_BULL_CONTEXT_ON_TP_EXIT) return;
  if (!S.ray.bullContext) return;
  if (S.ray.reentryCountInRegime >= CONFIG.MAX_REENTRIES_PER_BULL_REGIME) return;

  S.reentry = {
    eligible: true,
    eligibleUntilBar: S.barIndex + 6,
    eligibleFromBar: S.barIndex + CONFIG.REENTRY_MIN_BARS_AFTER_EXIT,
    exitPrice,
    peakBeforeExit: S.peakPrice,
    anchorPrice: S.lastFeature?.ema8 ?? exitPrice,
    bullRegimeId: S.ray.bullRegimeId,
  };

  S.cycleState = "tp_exit_wait_reentry";

  log("🔁 TP_EXIT_WAIT_REENTRY", {
    reason,
    bullRegimeId: S.ray.bullRegimeId,
    reentryCountInRegime: S.ray.reentryCountInRegime,
    eligibleFromBar: S.reentry.eligibleFromBar,
    eligibleUntilBar: S.reentry.eligibleUntilBar,
    peakBeforeExit: round4(S.reentry.peakBeforeExit),
    anchorPrice: round4(S.reentry.anchorPrice),
  });
}

function doExit(reason, price, ts, exitClass = "stop_exit") {
  const now = nowMs();
  if (!S.inPosition) return;
  if (now - S.lastExitAtMs < CONFIG.EXIT_DEDUP_MS) return;

  const exitPrice = Number.isFinite(price) ? price : currentPrice();
  const pnlPct = Number.isFinite(exitPrice) && Number.isFinite(S.entryPrice) ? pctDiff(S.entryPrice, exitPrice) : 0;

  log("📤 EXIT", {
    reason,
    exitClass,
    price: round4(exitPrice),
    pnlPct: round4(pnlPct),
    entryPrice: round4(S.entryPrice),
    entryMode: S.entryMode,
    heldSec: S.entryAt ? Math.max(0, Math.round((new Date(ts).getTime() - new Date(S.entryAt).getTime()) / 1000)) : null,
  });

  forward3Commas("exit_long", exitPrice, {
    reason,
    brain: CONFIG.BRAIN_NAME,
    entry_mode: S.entryMode,
  }).catch((err) => {
    log("❌ 3COMMAS_EXIT_ERROR", { err: String(err?.message || err) });
  });

  if (exitClass === "cycle_exit") {
    markReentryEligible(reason, exitPrice);
  } else {
    clearReentry("non_cycle_exit");
  }

  if (exitClass === "regime_break") {
    turnBullRegimeOff(ts, reason);
  }

  S.inPosition = false;
  S.entryPrice = null;
  S.entryAt = null;
  S.entryMode = null;
  S.stopPrice = null;
  S.beArmed = false;
  S.peakPrice = null;
  S.peakPnlPct = 0;
  S.dynamicTpTier = 0;
  S.lastExitAtMs = now;
  S.lastAction = "exit";
  S.lastExitClass = exitClass;

  if (exitClass === "cycle_exit") {
    S.cooldownUntilMs = 0;
  } else {
    S.cooldownUntilMs = now + CONFIG.EXIT_COOLDOWN_MIN * 60 * 1000;
    S.cycleState = "cooldown_hard";
  }
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
// Tick handling
// ------------------------------------------------------------
function handleTick(body) {
  const ts = pickFirst(body, ["time", "timestamp"], isoNow());
  const px = n(body.price, NaN);
  if (!Number.isFinite(px)) {
    throw new Error("bad_tick_price");
  }

  S.lastTickPrice = px;
  S.lastTickTime = ts;
  S.tickCount += 1;

  invalidateFastTickLaunch();

  if (S.fastTickLaunch.active && !S.inPosition) {
    if (px >= n(S.fastTickLaunch.confirmPrice, Infinity)) {
      S.fastTickLaunch.ticksAboveConfirm += 1;
      S.fastTickLaunch.lastConfirmedTickPrice = px;
      log("⚡ FAST_TICK_CONFIRM", {
        price: px,
        ticksAboveConfirm: S.fastTickLaunch.ticksAboveConfirm,
        confirmPrice: round4(S.fastTickLaunch.confirmPrice),
      });

      tryEntry("tick_confirmed_fast_launch", {
        src: "tick",
        symbol: CONFIG.SYMBOL,
        tf: CONFIG.ENTRY_TF,
        price: px,
        time: ts,
      });
    }
  }

  updatePositionFromTick(px);

  return {
    ok: true,
    kind: "tick",
    price: px,
    inPosition: S.inPosition,
  };
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
    peakPnlPct: S.peakPnlPct,
    dynamicTpTier: S.dynamicTpTier,
    cooldownUntil: S.cooldownUntilMs ? new Date(S.cooldownUntilMs).toISOString() : null,
    bullContext: S.ray.bullContext,
    bullRegimeId: S.ray.bullRegimeId,
    reentryCountInRegime: S.ray.reentryCountInRegime,
    cycleState: S.cycleState,
    reentry: S.reentry,
    trendChangeLaunch: S.trendChangeLaunch,
    fastTickLaunch: S.fastTickLaunch,
    lastTickPrice: S.lastTickPrice,
    lastTickTime: S.lastTickTime,
    tickFresh: isTickFresh(),
    lastFeatureTime: S.lastFeatureTime,
    featureFresh: isFeatureFresh(),
    breakoutMemory: S.breakoutMemory,
    ray: S.ray,
    fvvo: S.fvvo,
    barIndex: S.barIndex,
    replayAllowStaleData: CONFIG.REPLAY_ALLOW_STALE_DATA,
    recentLogs: S.logs.slice(-40),
  });
});

app.post("/reset", (req, res) => {
  const body = req.body || {};

  if (!checkSecret({ ...body, src: "admin" })) {
    log("⛔ RESET_UNAUTHORIZED");
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const reason = String(body.reason || "manual_reset");
  resetRuntimeState(reason);

  return res.json({
    ok: true,
    reset: true,
    reason,
    brain: CONFIG.BRAIN_NAME,
    symbol: CONFIG.SYMBOL,
    tf: CONFIG.ENTRY_TF,
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
      return res.json(handleTick(body));
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
