/**
 * BrainRAY_Basic_Signal_v2.0
 *
 * Rebuilt entry logic:
 *
 * - RayAlgo Bullish Trend Change is treated as the primary trusted trigger.
 * - Brain no longer requires one strict DCA/Momentum filter.
 * - Brain classifies the market using a scoring engine.
 * - Only clearly dangerous setups are hard-blocked.
 * - Weak but not dangerous Bullish Trend Change can arm pending confirmation.
 *
 * Recommended live setup:
 * - RayAlgo signal: 5m
 * - Feature Publisher: 3m
 * - Brain evaluation: latest 3m feature, fallback to 5m
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

// --------------------------------------------------
// Helpers
// --------------------------------------------------
function strEnv(name, def = "") {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === "") return def;
  return String(v).trim();
}

function numEnv(name, def = 0) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : def;
}

function boolEnv(name, def = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return def;
  const v = String(raw).trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(v);
}

function nowMs() {
  return Date.now();
}

function isoNow() {
  return new Date().toISOString();
}

function safeNumber(v, def = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function safeBool(v, def = false) {
  if (typeof v === "boolean") return v;
  if (v === undefined || v === null || String(v).trim() === "") return def;

  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;

  return def;
}

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function normalizeSignal(signal) {
  return String(signal || "").trim();
}

function normalizeSrc(src) {
  return String(src || "unknown").trim().toLowerCase();
}

function normalizeTf(tf) {
  return String(tf || "").trim();
}

function ageSec(tsMs) {
  if (!tsMs) return null;
  return Math.max(0, Math.round((nowMs() - tsMs) / 1000));
}

function withinTtlMin(tsMs, ttlMin) {
  if (!tsMs) return false;
  return nowMs() - tsMs <= ttlMin * 60 * 1000;
}

function pctChange(from, to) {
  const a = Number(from);
  const b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return ((b - a) / a) * 100;
}

function compactObject(value) {
  if (Array.isArray(value)) return value.map(compactObject);

  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = compactObject(v);
    }
    return out;
  }

  return value;
}

function oneLine(payload = {}) {
  try {
    return JSON.stringify(compactObject(payload));
  } catch (e) {
    return JSON.stringify({ logError: String(e?.message || e) });
  }
}

function logEvent(tag, payload = {}) {
  if (!CONFIG.DEBUG) return;
  console.log(`${isoNow()} ${tag} | ${oneLine(payload)}`);
}

function warnEvent(tag, payload = {}) {
  console.warn(`${isoNow()} ${tag} | ${oneLine(payload)}`);
}

function errorEvent(tag, payload = {}) {
  console.error(`${isoNow()} ${tag} | ${oneLine(payload)}`);
}

function parseSymbolBotMap(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch (e) {
    console.error(
      `${isoNow()} ❌ INVALID_SYMBOL_BOT_MAP | ${oneLine({
        error: String(e?.message || e),
        rawPresent: Boolean(raw),
      })}`
    );
    return {};
  }
}

function responseOk(res, payload = {}) {
  return res.status(200).json({
    ok: true,
    brain: CONFIG.BRAIN_NAME,
    time: isoNow(),
    ...payload,
  });
}

function responseFail(res, status, payload = {}) {
  return res.status(status).json({
    ok: false,
    brain: CONFIG.BRAIN_NAME,
    time: isoNow(),
    ...payload,
  });
}

// --------------------------------------------------
// Config
// --------------------------------------------------
const CONFIG = {
  BRAIN_NAME: strEnv("BRAIN_NAME", "BrainRAY_Basic_Signal_v2.0"),
  PORT: numEnv("PORT", 8080),
  DEBUG: boolEnv("DEBUG", true),
  WEBHOOK_PATH: strEnv("WEBHOOK_PATH", "/webhook"),

  WEBHOOK_SECRET: strEnv("WEBHOOK_SECRET", ""),

  SYMBOL: normalizeSymbol(strEnv("SYMBOL", "BINANCE:SOLUSDT")),
  SYMBOL_BOT_MAP: parseSymbolBotMap(strEnv("SYMBOL_BOT_MAP", "{}")),

  ENABLE_HTTP_FORWARD: boolEnv("ENABLE_HTTP_FORWARD", true),
  C3_SIGNAL_URL: strEnv("C3_SIGNAL_URL", "https://api.3commas.io/signal_bots/webhooks"),
  C3_SIGNAL_SECRET: strEnv("C3_SIGNAL_SECRET", ""),
  C3_TIMEOUT_MS: numEnv("C3_TIMEOUT_MS", 8000),
  MAX_LAG_SEC: numEnv("MAX_LAG_SEC", 300),

  ENTRY_MODE: strEnv("ENTRY_MODE", "SCORE_ENGINE_V2"),

  PRIMARY_FEATURE_TF: normalizeTf(strEnv("PRIMARY_FEATURE_TF", "3")),
  FALLBACK_FEATURE_TF: normalizeTf(strEnv("FALLBACK_FEATURE_TF", "5")),
  PRIMARY_FEATURE_MAX_AGE_SEC: numEnv("PRIMARY_FEATURE_MAX_AGE_SEC", 240),
  FALLBACK_FEATURE_MAX_AGE_SEC: numEnv("FALLBACK_FEATURE_MAX_AGE_SEC", 420),

  ALLOW_TREND_CHANGE_ENTRY: boolEnv("ALLOW_TREND_CHANGE_ENTRY", true),
  ALLOW_BOS_ENTRY: boolEnv("ALLOW_BOS_ENTRY", true),
  ALLOW_TREND_CONTINUATION_ENTRY: boolEnv("ALLOW_TREND_CONTINUATION_ENTRY", false),

  TREND_CHANGE_MIN_SCORE: numEnv("TREND_CHANGE_MIN_SCORE", 5),
  BOS_MIN_SCORE: numEnv("BOS_MIN_SCORE", 6),
  PENDING_MIN_SCORE: numEnv("PENDING_MIN_SCORE", 4),

  PENDING_TREND_CHANGE_ENTRY: boolEnv("PENDING_TREND_CHANGE_ENTRY", true),
  PENDING_TREND_CHANGE_TTL_MIN: numEnv("PENDING_TREND_CHANGE_TTL_MIN", 12),

  SCORE_MEMORY_ENABLED: boolEnv("SCORE_MEMORY_ENABLED", true),
  SCORE_MEMORY_TTL_MIN: numEnv("SCORE_MEMORY_TTL_MIN", 10),
  SCORE_MEMORY_MIN_SCORE: numEnv("SCORE_MEMORY_MIN_SCORE", 5),

  HARD_BLOCKS_ENABLED: boolEnv("HARD_BLOCKS_ENABLED", true),

  CHASE_PUMP_LOOKBACK_BARS: numEnv("CHASE_PUMP_LOOKBACK_BARS", 3),
  CHASE_PUMP_BLOCK_PCT: numEnv("CHASE_PUMP_BLOCK_PCT", 1.2),
  CHASE_EXT_EMA11_BLOCK_PCT: numEnv("CHASE_EXT_EMA11_BLOCK_PCT", 0.7),
  CHASE_RSI_BLOCK: numEnv("CHASE_RSI_BLOCK", 72),

  RECENT_BEARISH_BLOCK_MIN: numEnv("RECENT_BEARISH_BLOCK_MIN", 10),

  ENTER_DEDUP_SEC: numEnv("ENTER_DEDUP_SEC", 25),
  ENTRY_COOLDOWN_SEC: numEnv("ENTRY_COOLDOWN_SEC", 300),
  LOCK_AFTER_ENTER: boolEnv("LOCK_AFTER_ENTER", true),

  EXIT_ON_BEARISH_TREND_CHANGE: boolEnv("EXIT_ON_BEARISH_TREND_CHANGE", true),
  EXIT_ON_BEARISH_BOS: boolEnv("EXIT_ON_BEARISH_BOS", true),
  EXIT_ON_BEARISH_TREND_CONTINUATION: boolEnv(
    "EXIT_ON_BEARISH_TREND_CONTINUATION",
    false
  ),

  EXIT_DEDUP_SEC: numEnv("EXIT_DEDUP_SEC", 20),
  EXIT_COOLDOWN_SEC: numEnv("EXIT_COOLDOWN_SEC", 60),

  REQUIRE_KNOWN_SIGNAL: boolEnv("REQUIRE_KNOWN_SIGNAL", true),
};

// --------------------------------------------------
// Signals
// --------------------------------------------------
const SIGNALS = {
  BULLISH_TREND_CHANGE: "Bullish Trend Change",
  BULLISH_BOS: "Bullish BOS",
  BULLISH_TREND_CONTINUATION: "Bullish Trend Continuation",

  BEARISH_TREND_CHANGE: "Bearish Trend Change",
  BEARISH_BOS: "Bearish BOS",
  BEARISH_TREND_CONTINUATION: "Bearish Trend Continuation",
};

const KNOWN_SIGNALS = new Set(Object.values(SIGNALS));

function isBearishSignal(signal) {
  return (
    signal === SIGNALS.BEARISH_TREND_CHANGE ||
    signal === SIGNALS.BEARISH_BOS ||
    signal === SIGNALS.BEARISH_TREND_CONTINUATION
  );
}

function raySignalTag(signal) {
  if (signal === SIGNALS.BULLISH_TREND_CHANGE) return "🟩 RAY_BULLISH_TREND_CHANGE";
  if (signal === SIGNALS.BULLISH_BOS) return "🟩 RAY_BULLISH_BOS";
  if (signal === SIGNALS.BULLISH_TREND_CONTINUATION) return "🟩 RAY_BULLISH_TREND_CONTINUATION";

  if (signal === SIGNALS.BEARISH_TREND_CHANGE) return "🟥 RAY_BEARISH_TREND_CHANGE";
  if (signal === SIGNALS.BEARISH_BOS) return "🟥 RAY_BEARISH_BOS";
  if (signal === SIGNALS.BEARISH_TREND_CONTINUATION) return "🟥 RAY_BEARISH_TREND_CONTINUATION";

  return "⚪ RAY_UNKNOWN_SIGNAL";
}

// --------------------------------------------------
// State
// --------------------------------------------------
const state = {
  startedAt: isoNow(),
  lastPayload: null,

  position: {
    inLong: false,
    entryPrice: null,
    entrySignal: null,
    entryReason: null,
    entryScore: null,
    entryTime: null,
    entryTsMs: null,

    exitPrice: null,
    exitSignal: null,
    exitReason: null,
    exitTime: null,
    exitTsMs: null,
  },

  featuresByTf: {},

  bullishBias: {
    active: false,
    signal: null,
    price: null,
    time: null,
    tsMs: null,
  },

  bosBias: {
    active: false,
    signal: null,
    price: null,
    time: null,
    tsMs: null,
  },

  lastBearishSignal: {
    signal: null,
    price: null,
    time: null,
    tsMs: null,
  },

  pendingTrendChange: {
    active: false,
    signal: null,
    price: null,
    time: null,
    tsMs: null,
    originalScoreCheck: null,
  },

  scoreMemory: {
    active: false,
    pass: false,
    score: null,
    setupType: null,
    time: null,
    tsMs: null,
    price: null,
    tf: null,
    scoreCheck: null,
  },

  lastEnterLong: {
    tsMs: null,
    price: null,
    signal: null,
    reason: null,
  },

  lastExitLong: {
    tsMs: null,
    price: null,
    signal: null,
    reason: null,
  },

  counters: {
    received: 0,
    featureReceived: 0,
    unauthorized: 0,
    wrongSymbol: 0,
    unknownSignal: 0,

    scoreMemorySaved: 0,

    biasSaved: 0,
    biasCancelled: 0,

    pendingTrendArmed: 0,
    pendingTrendExpired: 0,
    pendingTrendTriggered: 0,
    pendingTrendCancelled: 0,

    enterAllowed: 0,
    enterBlocked: 0,
    exitAllowed: 0,
    exitBlocked: 0,

    confirmationOnly: 0,

    forwardedOk: 0,
    forwardedFail: 0,
  },
};

// --------------------------------------------------
// Feature handling
// --------------------------------------------------
function isFeaturePayload(body) {
  const src = normalizeSrc(body?.src);
  return (
    src === "features" ||
    src === "feature" ||
    src === "feature_3m" ||
    src === "feature_5m" ||
    src === "raybasic_features" ||
    src === "dca_features" ||
    body?.kind === "features" ||
    body?.type === "features"
  );
}

function extractFeature(body) {
  const symbol = normalizeSymbol(body.symbol || body.ticker || body.tickerid || CONFIG.SYMBOL);
  const tf = normalizeTf(body.tf || body.timeframe || body.interval || CONFIG.PRIMARY_FEATURE_TF);

  return {
    symbol,
    tf,
    time: String(body.time || body.timestamp || isoNow()).trim(),

    close: safeNumber(body.close ?? body.price, null),

    macdLine: safeNumber(body.macdLine ?? body.macd ?? body.macd_line, null),
    macdSignal: safeNumber(body.macdSignal ?? body.macd_signal ?? body.signalLine, null),
    macdHist: safeNumber(body.macdHist ?? body.macd_hist ?? body.histogram, null),
    macdCrossUpBelowZero: safeBool(body.macdCrossUpBelowZero, false),

    ema11: safeNumber(body.ema11 ?? body.ema_11, null),
    ema33: safeNumber(body.ema33 ?? body.ema_33, null),

    rsi12: safeNumber(body.rsi12 ?? body.rsi_12, null),
    adx14: safeNumber(body.adx14 ?? body.adx ?? body.adx_14, null),
    mfi12: safeNumber(body.mfi12 ?? body.mfi ?? body.mfi_12, null),

    dcaFilterPass: safeBool(body.dcaFilterPass, false),
  };
}

function ensureFeatureSlot(tf) {
  const key = normalizeTf(tf);
  if (!state.featuresByTf[key]) {
    state.featuresByTf[key] = {
      current: null,
      previous: null,
      history: [],
      updatedAtMs: null,
    };
  }
  return state.featuresByTf[key];
}

function featureAgeSec(tf) {
  const slot = state.featuresByTf[normalizeTf(tf)];
  if (!slot) return null;
  return ageSec(slot.updatedAtMs);
}

function maxAgeForTf(tf) {
  const key = normalizeTf(tf);
  if (key === CONFIG.PRIMARY_FEATURE_TF) return CONFIG.PRIMARY_FEATURE_MAX_AGE_SEC;
  return CONFIG.FALLBACK_FEATURE_MAX_AGE_SEC;
}

function hasFreshFeature(tf) {
  const age = featureAgeSec(tf);
  return age !== null && age <= maxAgeForTf(tf);
}

function getFeatureContext() {
  const primary = state.featuresByTf[CONFIG.PRIMARY_FEATURE_TF];
  if (primary?.current && hasFreshFeature(CONFIG.PRIMARY_FEATURE_TF)) {
    return {
      tf: CONFIG.PRIMARY_FEATURE_TF,
      source: "primary",
      slot: primary,
      feature: primary.current,
      previous: primary.previous,
      history: primary.history,
      ageSec: featureAgeSec(CONFIG.PRIMARY_FEATURE_TF),
      maxAgeSec: CONFIG.PRIMARY_FEATURE_MAX_AGE_SEC,
    };
  }

  const fallback = state.featuresByTf[CONFIG.FALLBACK_FEATURE_TF];
  if (fallback?.current && hasFreshFeature(CONFIG.FALLBACK_FEATURE_TF)) {
    return {
      tf: CONFIG.FALLBACK_FEATURE_TF,
      source: "fallback",
      slot: fallback,
      feature: fallback.current,
      previous: fallback.previous,
      history: fallback.history,
      ageSec: featureAgeSec(CONFIG.FALLBACK_FEATURE_TF),
      maxAgeSec: CONFIG.FALLBACK_FEATURE_MAX_AGE_SEC,
    };
  }

  return {
    tf: null,
    source: "missing",
    slot: null,
    feature: null,
    previous: null,
    history: [],
    ageSec: null,
    maxAgeSec: null,
  };
}

function recentPumpPctFromHistory(history, lookbackBars) {
  if (!Array.isArray(history) || history.length < 2) return null;

  const lookback = Math.max(1, Number(lookbackBars || 1));
  const end = history[history.length - 1];
  const startIndex = Math.max(0, history.length - 1 - lookback);
  const start = history[startIndex];

  if (!start || !end) return null;
  return pctChange(start.close, end.close);
}

function calcExtensionPct(close, ema) {
  const c = Number(close);
  const e = Number(ema);
  if (!Number.isFinite(c) || !Number.isFinite(e) || e === 0) return null;
  return ((c - e) / e) * 100;
}

function evaluateScore(minScore = CONFIG.TREND_CHANGE_MIN_SCORE) {
  const ctx = getFeatureContext();
  const f = ctx.feature;
  const prev = ctx.previous;

  const points = [];
  const warnings = [];
  const hardBlocks = [];
  const values = {
    tf: ctx.tf,
    featureSource: ctx.source,
    featureAgeSec: ctx.ageSec,
    featureMaxAgeSec: ctx.maxAgeSec,
  };

  if (!f) {
    return {
      pass: false,
      score: 0,
      minScore,
      setupType: "missing_feature",
      hardBlocked: true,
      hardBlocks: ["missing_fresh_feature"],
      points,
      warnings,
      values,
      tf: ctx.tf,
      source: ctx.source,
    };
  }

  values.close = f.close;
  values.ema11 = f.ema11;
  values.ema33 = f.ema33;
  values.rsi12 = f.rsi12;
  values.adx14 = f.adx14;
  values.mfi12 = f.mfi12;
  values.macdLine = f.macdLine;
  values.macdSignal = f.macdSignal;
  values.macdHist = f.macdHist;

  const macdLineGtSignal =
    f.macdLine !== null && f.macdSignal !== null && f.macdLine > f.macdSignal;

  const ema11GtEma33 = f.ema11 !== null && f.ema33 !== null && f.ema11 > f.ema33;
  const closeGtEma11 = f.close !== null && f.ema11 !== null && f.close > f.ema11;
  const closeGtEma33 = f.close !== null && f.ema33 !== null && f.close > f.ema33;

  const rsiRising =
    !!prev && prev.rsi12 !== null && f.rsi12 !== null && f.rsi12 > prev.rsi12;

  const adxRising =
    !!prev && prev.adx14 !== null && f.adx14 !== null && f.adx14 > prev.adx14;

  const macdHistImproving =
    !!prev &&
    prev.macdHist !== null &&
    f.macdHist !== null &&
    f.macdHist > prev.macdHist;

  const macdLineImproving =
    !!prev &&
    prev.macdLine !== null &&
    f.macdLine !== null &&
    f.macdLine > prev.macdLine;

  const reclaimedEma11 =
    !!prev &&
    prev.close !== null &&
    prev.ema11 !== null &&
    f.close !== null &&
    f.ema11 !== null &&
    prev.close <= prev.ema11 &&
    f.close > f.ema11;

  const extensionEma11Pct = calcExtensionPct(f.close, f.ema11);
  const extensionEma33Pct = calcExtensionPct(f.close, f.ema33);
  const recentPumpPct = recentPumpPctFromHistory(
    ctx.history,
    CONFIG.CHASE_PUMP_LOOKBACK_BARS
  );

  values.macdLineGtSignal = macdLineGtSignal;
  values.ema11GtEma33 = ema11GtEma33;
  values.closeGtEma11 = closeGtEma11;
  values.closeGtEma33 = closeGtEma33;
  values.rsiRising = rsiRising;
  values.adxRising = adxRising;
  values.macdHistImproving = macdHistImproving;
  values.macdLineImproving = macdLineImproving;
  values.reclaimedEma11 = reclaimedEma11;
  values.extensionEma11Pct = extensionEma11Pct;
  values.extensionEma33Pct = extensionEma33Pct;
  values.recentPumpPct = recentPumpPct;

  let score = 0;

  function add(scoreValue, reason) {
    score += scoreValue;
    points.push({ points: scoreValue, reason });
  }

  if (macdLineGtSignal) add(2, "macd_line_gt_signal");
  if (macdHistImproving) add(1, "macd_hist_improving");
  if (macdLineImproving) add(1, "macd_line_improving");

  if (ema11GtEma33) add(2, "ema11_gt_ema33");
  if (closeGtEma11) add(1, "close_gt_ema11");
  if (closeGtEma33) add(1, "close_gt_ema33");
  if (reclaimedEma11) add(2, "ema11_reclaim");

  if (f.rsi12 !== null && f.rsi12 >= 52) add(2, "rsi12_above_52");
  else if (f.rsi12 !== null && f.rsi12 >= 48) add(1, "rsi12_recovery_zone");

  if (rsiRising) add(1, "rsi12_rising");

  if (f.mfi12 !== null && f.mfi12 >= 50) add(2, "mfi12_above_50");
  else if (f.mfi12 !== null && f.mfi12 >= 45) add(1, "mfi12_recovery_zone");

  if (f.adx14 !== null && f.adx14 >= 18) add(1, "adx14_above_18");
  if (f.adx14 !== null && f.adx14 >= 25) add(1, "adx14_above_25");
  if (adxRising) add(1, "adx14_rising");

  if (extensionEma11Pct !== null && extensionEma11Pct <= 0.8) {
    add(1, "not_overextended_from_ema11");
  }

  // --------------------------------------------------
  // Hard danger blocks
  // --------------------------------------------------
  if (CONFIG.HARD_BLOCKS_ENABLED) {
    if (
      recentPumpPct !== null &&
      extensionEma11Pct !== null &&
      f.rsi12 !== null &&
      recentPumpPct >= CONFIG.CHASE_PUMP_BLOCK_PCT &&
      extensionEma11Pct >= CONFIG.CHASE_EXT_EMA11_BLOCK_PCT &&
      f.rsi12 >= CONFIG.CHASE_RSI_BLOCK
    ) {
      hardBlocks.push("chase_after_vertical_pump");
    }

    if (
      f.macdLine !== null &&
      f.macdSignal !== null &&
      f.rsi12 !== null &&
      f.mfi12 !== null &&
      f.macdLine < f.macdSignal &&
      f.rsi12 < 48 &&
      f.mfi12 < 45
    ) {
      hardBlocks.push("bearish_momentum_stack");
    }

    if (
      f.close !== null &&
      f.ema11 !== null &&
      f.ema33 !== null &&
      f.macdLine !== null &&
      f.macdSignal !== null &&
      f.rsi12 !== null &&
      f.close < f.ema11 &&
      f.close < f.ema33 &&
      f.macdLine < f.macdSignal &&
      f.rsi12 < 50
    ) {
      hardBlocks.push("below_ema_stack_no_reclaim");
    }

    const recentBearish =
      state.lastBearishSignal.tsMs &&
      withinTtlMin(state.lastBearishSignal.tsMs, CONFIG.RECENT_BEARISH_BLOCK_MIN);

    if (
      recentBearish &&
      f.close !== null &&
      f.ema11 !== null &&
      f.close < f.ema11 &&
      !macdLineGtSignal
    ) {
      hardBlocks.push("recent_bearish_signal_no_reclaim");
    }
  }

  if (!macdLineGtSignal) warnings.push("macd_not_supportive");
  if (!ema11GtEma33) warnings.push("ema11_not_above_ema33");
  if (!closeGtEma11) warnings.push("close_not_above_ema11");
  if (f.rsi12 === null || f.rsi12 < 48) warnings.push("rsi_weak");
  if (f.mfi12 === null || f.mfi12 < 45) warnings.push("mfi_weak");

  let setupType = "weak";
  if (score >= 8 && ema11GtEma33 && macdLineGtSignal) setupType = "strong_momentum";
  else if (score >= 6 && reclaimedEma11) setupType = "recovery_reclaim";
  else if (score >= 6 && ema11GtEma33) setupType = "healthy_trend_change";
  else if (score >= 4) setupType = "weak_pending";

  return {
    pass: hardBlocks.length === 0 && score >= minScore,
    score,
    minScore,
    setupType,
    hardBlocked: hardBlocks.length > 0,
    hardBlocks,
    points,
    warnings,
    values,
    tf: ctx.tf,
    source: ctx.source,
  };
}

function hasRecentScoreMemory() {
  if (!CONFIG.SCORE_MEMORY_ENABLED) return false;
  if (!state.scoreMemory.active || !state.scoreMemory.pass || !state.scoreMemory.tsMs) {
    return false;
  }

  return withinTtlMin(state.scoreMemory.tsMs, CONFIG.SCORE_MEMORY_TTL_MIN);
}

function getScoreMemoryStatus() {
  return {
    active: hasRecentScoreMemory(),
    rawActive: state.scoreMemory.active,
    pass: state.scoreMemory.pass,
    score: state.scoreMemory.score,
    setupType: state.scoreMemory.setupType,
    price: state.scoreMemory.price,
    tf: state.scoreMemory.tf,
    time: state.scoreMemory.time,
    ageSec: ageSec(state.scoreMemory.tsMs),
    ttlMin: CONFIG.SCORE_MEMORY_TTL_MIN,
  };
}

function updateScoreMemory(scoreCheck) {
  if (!CONFIG.SCORE_MEMORY_ENABLED) return;
  if (!scoreCheck?.pass) return;
  if (scoreCheck.score < CONFIG.SCORE_MEMORY_MIN_SCORE) return;

  const ctx = getFeatureContext();
  const f = ctx.feature;

  state.scoreMemory = {
    active: true,
    pass: true,
    score: scoreCheck.score,
    setupType: scoreCheck.setupType,
    time: f?.time || isoNow(),
    tsMs: nowMs(),
    price: f?.close ?? null,
    tf: ctx.tf,
    scoreCheck,
  };

  state.counters.scoreMemorySaved += 1;

  logEvent("🧠 SCORE_MEMORY_SAVED", {
    ttlMin: CONFIG.SCORE_MEMORY_TTL_MIN,
    score: scoreCheck.score,
    setupType: scoreCheck.setupType,
    tf: ctx.tf,
    price: state.scoreMemory.price,
    scorePoints: scoreCheck.points,
    hardBlocks: scoreCheck.hardBlocks,
  });
}

async function updateFeature(body) {
  const f = extractFeature(body);

  if (f.symbol !== CONFIG.SYMBOL) {
    state.counters.wrongSymbol += 1;
    warnEvent("⚠️ FEATURE_WRONG_SYMBOL", {
      received: f.symbol,
      expected: CONFIG.SYMBOL,
      tf: f.tf,
    });

    return { ok: false, reason: "wrong_symbol", feature: f };
  }

  const slot = ensureFeatureSlot(f.tf);

  slot.previous = slot.current;
  slot.current = f;
  slot.updatedAtMs = nowMs();
  slot.history.push(f);
  if (slot.history.length > 50) slot.history.shift();

  state.counters.featureReceived += 1;

  const scoreCheck = evaluateScore(CONFIG.TREND_CHANGE_MIN_SCORE);
  updateScoreMemory(scoreCheck);

  logEvent("📊 FEATURE_UPDATE", {
    symbol: f.symbol,
    tf: f.tf,
    close: f.close,
    selectedTf: scoreCheck.tf,
    featureSource: scoreCheck.source,
    score: scoreCheck.score,
    minScore: scoreCheck.minScore,
    pass: scoreCheck.pass,
    setupType: scoreCheck.setupType,
    hardBlocked: scoreCheck.hardBlocked,
    hardBlocks: scoreCheck.hardBlocks,
    warnings: scoreCheck.warnings,
    values: scoreCheck.values,
    scoreMemory: getScoreMemoryStatus(),
    pendingTrend: getPendingTrendStatus(),
  });

  const pendingResult = await maybeTriggerPendingTrendChangeFromFeature(scoreCheck);

  return {
    ok: true,
    reason: "feature_updated",
    feature: f,
    scoreCheck,
    pendingResult,
  };
}

// --------------------------------------------------
// Status helpers
// --------------------------------------------------
function getPositionStatus() {
  return {
    inLong: state.position.inLong,
    entryPrice: state.position.entryPrice,
    entrySignal: state.position.entrySignal,
    entryReason: state.position.entryReason,
    entryScore: state.position.entryScore,
    entryTime: state.position.entryTime,
    entryAgeSec: ageSec(state.position.entryTsMs),

    exitPrice: state.position.exitPrice,
    exitSignal: state.position.exitSignal,
    exitReason: state.position.exitReason,
    exitTime: state.position.exitTime,
    exitAgeSec: ageSec(state.position.exitTsMs),
  };
}

function getPendingTrendStatus() {
  return {
    active: hasRecentPendingTrendChange(),
    rawActive: state.pendingTrendChange.active,
    signal: state.pendingTrendChange.signal,
    price: state.pendingTrendChange.price,
    time: state.pendingTrendChange.time,
    ageSec: ageSec(state.pendingTrendChange.tsMs),
    ttlMin: CONFIG.PENDING_TREND_CHANGE_TTL_MIN,
  };
}

function hasRecentPendingTrendChange() {
  if (!CONFIG.PENDING_TREND_CHANGE_ENTRY) return false;
  if (!state.pendingTrendChange.active || !state.pendingTrendChange.tsMs) return false;

  return withinTtlMin(
    state.pendingTrendChange.tsMs,
    CONFIG.PENDING_TREND_CHANGE_TTL_MIN
  );
}

function expirePendingTrendIfNeeded() {
  if (!state.pendingTrendChange.active) return false;
  if (hasRecentPendingTrendChange()) return false;

  const old = { ...state.pendingTrendChange };

  clearPendingTrendChange("pending_trend_expired", {
    oldSignal: old.signal,
    oldPrice: old.price,
    oldAgeSec: ageSec(old.tsMs),
  });

  state.counters.pendingTrendExpired += 1;
  return true;
}

function getBiasStatus() {
  return {
    bullishBiasActive: state.bullishBias.active,
    bullishBiasSignal: state.bullishBias.signal,
    bullishBiasPrice: state.bullishBias.price,
    bullishBiasAgeSec: ageSec(state.bullishBias.tsMs),

    bosBiasActive: state.bosBias.active,
    bosBiasSignal: state.bosBias.signal,
    bosBiasPrice: state.bosBias.price,
    bosBiasAgeSec: ageSec(state.bosBias.tsMs),

    lastBearishSignal: state.lastBearishSignal.signal,
    lastBearishPrice: state.lastBearishSignal.price,
    lastBearishAgeSec: ageSec(state.lastBearishSignal.tsMs),
  };
}

function featureStatus() {
  const scoreCheck = evaluateScore(CONFIG.TREND_CHANGE_MIN_SCORE);

  return {
    primaryTf: CONFIG.PRIMARY_FEATURE_TF,
    fallbackTf: CONFIG.FALLBACK_FEATURE_TF,
    selectedTf: scoreCheck.tf,
    selectedSource: scoreCheck.source,
    featuresByTf: state.featuresByTf,
    scoreCheck,
    scoreMemory: getScoreMemoryStatus(),
    pendingTrend: getPendingTrendStatus(),
  };
}

// --------------------------------------------------
// Bias / pending
// --------------------------------------------------
function saveBullishBias({ signal, price, time }) {
  state.bullishBias = {
    active: true,
    signal,
    price,
    time,
    tsMs: nowMs(),
  };

  state.counters.biasSaved += 1;

  logEvent("🟢 BIAS_SAVED", {
    signal,
    price,
    ts: time,
  });
}

function saveBosBias({ signal, price, time }) {
  state.bosBias = {
    active: true,
    signal,
    price,
    time,
    tsMs: nowMs(),
  };

  logEvent("🟢 BOS_BIAS_SAVED", {
    signal,
    price,
    ts: time,
  });
}

function cancelBullishBias(reason, payload = {}) {
  const hadBias = state.bullishBias.active || state.bosBias.active;

  state.bullishBias = {
    active: false,
    signal: null,
    price: null,
    time: null,
    tsMs: null,
  };

  state.bosBias = {
    active: false,
    signal: null,
    price: null,
    time: null,
    tsMs: null,
  };

  if (hadBias) state.counters.biasCancelled += 1;

  logEvent("🔴 BIAS_CANCELLED", {
    reason,
    hadBias,
    ...payload,
  });
}

function saveBearishSignal({ signal, price, time }) {
  state.lastBearishSignal = {
    signal,
    price,
    time,
    tsMs: nowMs(),
  };
}

function armPendingTrendChange({ signal, price, time, scoreCheck }) {
  if (!CONFIG.PENDING_TREND_CHANGE_ENTRY) return;

  state.pendingTrendChange = {
    active: true,
    signal,
    price,
    time,
    tsMs: nowMs(),
    originalScoreCheck: scoreCheck,
  };

  state.counters.pendingTrendArmed += 1;

  logEvent("🟡 PENDING_TREND_ARMED", {
    signal,
    price,
    ts: time,
    ttlMin: CONFIG.PENDING_TREND_CHANGE_TTL_MIN,
    score: scoreCheck?.score,
    setupType: scoreCheck?.setupType,
    hardBlocks: scoreCheck?.hardBlocks,
    warnings: scoreCheck?.warnings,
  });
}

function clearPendingTrendChange(reason, payload = {}) {
  const hadPending = state.pendingTrendChange.active;

  state.pendingTrendChange = {
    active: false,
    signal: null,
    price: null,
    time: null,
    tsMs: null,
    originalScoreCheck: null,
  };

  if (hadPending) {
    state.counters.pendingTrendCancelled += 1;
    logEvent("⚪ PENDING_TREND_CLEARED", { reason, ...payload });
  }
}

// --------------------------------------------------
// Position and protection
// --------------------------------------------------
function isEnterDedupBlocked(signal) {
  if (!state.lastEnterLong.tsMs) return false;
  const diffSec = (nowMs() - state.lastEnterLong.tsMs) / 1000;
  return diffSec < CONFIG.ENTER_DEDUP_SEC && state.lastEnterLong.signal === signal;
}

function isEntryCooldownBlocked() {
  if (!state.lastEnterLong.tsMs) return false;
  const diffSec = (nowMs() - state.lastEnterLong.tsMs) / 1000;
  return diffSec < CONFIG.ENTRY_COOLDOWN_SEC;
}

function isExitDedupBlocked(signal) {
  if (!state.lastExitLong.tsMs) return false;
  const diffSec = (nowMs() - state.lastExitLong.tsMs) / 1000;
  return diffSec < CONFIG.EXIT_DEDUP_SEC && state.lastExitLong.signal === signal;
}

function isExitCooldownBlocked() {
  if (!state.lastExitLong.tsMs) return false;
  const diffSec = (nowMs() - state.lastExitLong.tsMs) / 1000;
  return diffSec < CONFIG.EXIT_COOLDOWN_SEC;
}

function markEnterLong({ signal, price, time, reason, scoreCheck }) {
  state.lastEnterLong = {
    tsMs: nowMs(),
    price,
    signal,
    reason,
  };

  state.position.inLong = true;
  state.position.entryPrice = price;
  state.position.entrySignal = signal;
  state.position.entryReason = reason;
  state.position.entryScore = scoreCheck?.score ?? null;
  state.position.entryTime = time || isoNow();
  state.position.entryTsMs = nowMs();

  clearPendingTrendChange("entry_filled", {
    entrySignal: signal,
    entryPrice: price,
  });
}

function markExitLong({ signal, price, time, reason }) {
  state.lastExitLong = {
    tsMs: nowMs(),
    price,
    signal,
    reason,
  };

  state.position.inLong = false;
  state.position.exitPrice = price;
  state.position.exitSignal = signal;
  state.position.exitReason = reason;
  state.position.exitTime = time || isoNow();
  state.position.exitTsMs = nowMs();

  clearPendingTrendChange("exit_signal_received", {
    exitSignal: signal,
    exitPrice: price,
  });
}

function applyTradeProtection({ decision, signal, price, time }) {
  if (!decision.allowed) return decision;

  if (decision.action === "enter_long") {
    if (CONFIG.LOCK_AFTER_ENTER && state.position.inLong) {
      state.counters.enterBlocked += 1;

      return {
        ...decision,
        allowed: false,
        action: "blocked",
        reason: "already_in_long_lock_after_enter",
        positionStatus: getPositionStatus(),
      };
    }

    if (isEnterDedupBlocked(signal)) {
      state.counters.enterBlocked += 1;

      return {
        ...decision,
        allowed: false,
        action: "blocked",
        reason: "enter_dedup_blocked",
        positionStatus: getPositionStatus(),
      };
    }

    if (isEntryCooldownBlocked()) {
      state.counters.enterBlocked += 1;

      return {
        ...decision,
        allowed: false,
        action: "blocked",
        reason: "entry_cooldown_blocked",
        positionStatus: getPositionStatus(),
      };
    }

    markEnterLong({
      signal,
      price,
      time,
      reason: decision.reason,
      scoreCheck: decision.scoreCheck,
    });

    state.counters.enterAllowed += 1;

    return {
      ...decision,
      positionStatus: getPositionStatus(),
    };
  }

  if (decision.action === "exit_long") {
    if (CONFIG.LOCK_AFTER_ENTER && !state.position.inLong) {
      state.counters.exitBlocked += 1;

      return {
        ...decision,
        allowed: false,
        action: "blocked",
        reason: "not_in_long_exit_blocked",
        positionStatus: getPositionStatus(),
      };
    }

    if (isExitDedupBlocked(signal)) {
      state.counters.exitBlocked += 1;

      return {
        ...decision,
        allowed: false,
        action: "blocked",
        reason: "exit_dedup_blocked",
        positionStatus: getPositionStatus(),
      };
    }

    if (isExitCooldownBlocked()) {
      state.counters.exitBlocked += 1;

      return {
        ...decision,
        allowed: false,
        action: "blocked",
        reason: "exit_cooldown_blocked",
        positionStatus: getPositionStatus(),
      };
    }

    markExitLong({
      signal,
      price,
      time,
      reason: decision.reason,
    });

    state.counters.exitAllowed += 1;

    return {
      ...decision,
      positionStatus: getPositionStatus(),
    };
  }

  return decision;
}

// --------------------------------------------------
// Decision engine
// --------------------------------------------------
function entryDecisionFromScore({
  signal,
  price,
  time,
  minScore,
  reasonPrefix,
  allowMemory = true,
  allowPending = false,
}) {
  const scoreCheck = evaluateScore(minScore);

  if (scoreCheck.pass) {
    return {
      action: "enter_long",
      allowed: true,
      reason: `${reasonPrefix}_${scoreCheck.setupType}`,
      scoreCheck,
      biasStatus: getBiasStatus(),
      positionStatus: getPositionStatus(),
      scoreMemory: getScoreMemoryStatus(),
    };
  }

  if (
    allowMemory &&
    hasRecentScoreMemory() &&
    state.scoreMemory.score >= minScore &&
    !state.scoreMemory.scoreCheck?.hardBlocked
  ) {
    return {
      action: "enter_long",
      allowed: true,
      reason: `${reasonPrefix}_recent_score_memory_${state.scoreMemory.setupType}`,
      scoreCheck: state.scoreMemory.scoreCheck,
      biasStatus: getBiasStatus(),
      positionStatus: getPositionStatus(),
      scoreMemory: getScoreMemoryStatus(),
    };
  }

  if (
    allowPending &&
    CONFIG.PENDING_TREND_CHANGE_ENTRY &&
    !scoreCheck.hardBlocked &&
    scoreCheck.score >= CONFIG.PENDING_MIN_SCORE
  ) {
    armPendingTrendChange({
      signal,
      price,
      time,
      scoreCheck,
    });

    return {
      action: "blocked",
      allowed: false,
      reason: "trend_change_pending_confirmation",
      scoreCheck,
      biasStatus: getBiasStatus(),
      positionStatus: getPositionStatus(),
      scoreMemory: getScoreMemoryStatus(),
    };
  }

  return {
    action: "blocked",
    allowed: false,
    reason: scoreCheck.hardBlocked
      ? `entry_hard_blocked_${scoreCheck.hardBlocks.join("+")}`
      : "entry_score_too_low",
    scoreCheck,
    biasStatus: getBiasStatus(),
    positionStatus: getPositionStatus(),
    scoreMemory: getScoreMemoryStatus(),
  };
}

function decideRayAlgoSignal({ signal, price, time }) {
  expirePendingTrendIfNeeded();

  if (CONFIG.REQUIRE_KNOWN_SIGNAL && !KNOWN_SIGNALS.has(signal)) {
    return {
      action: "ignore",
      allowed: false,
      reason: "unknown_signal",
      biasStatus: getBiasStatus(),
      positionStatus: getPositionStatus(),
    };
  }

  if (isBearishSignal(signal)) {
    saveBearishSignal({ signal, price, time });
    cancelBullishBias("bearish_signal_received", { signal, price, ts: time });
    clearPendingTrendChange("bearish_signal_received", { signal, price, ts: time });

    if (
      signal === SIGNALS.BEARISH_TREND_CHANGE &&
      CONFIG.EXIT_ON_BEARISH_TREND_CHANGE
    ) {
      return {
        action: "exit_long",
        allowed: true,
        reason: "bearish_trend_change_exit",
        biasStatus: getBiasStatus(),
        positionStatus: getPositionStatus(),
      };
    }

    if (signal === SIGNALS.BEARISH_BOS && CONFIG.EXIT_ON_BEARISH_BOS) {
      return {
        action: "exit_long",
        allowed: true,
        reason: "bearish_bos_exit",
        biasStatus: getBiasStatus(),
        positionStatus: getPositionStatus(),
      };
    }

    if (
      signal === SIGNALS.BEARISH_TREND_CONTINUATION &&
      CONFIG.EXIT_ON_BEARISH_TREND_CONTINUATION
    ) {
      return {
        action: "exit_long",
        allowed: true,
        reason: "bearish_trend_continuation_exit",
        biasStatus: getBiasStatus(),
        positionStatus: getPositionStatus(),
      };
    }

    return {
      action: "ignore",
      allowed: false,
      reason: "bearish_signal_exit_disabled",
      biasStatus: getBiasStatus(),
      positionStatus: getPositionStatus(),
    };
  }

  if (signal === SIGNALS.BULLISH_TREND_CHANGE) {
    saveBullishBias({ signal, price, time });

    if (!CONFIG.ALLOW_TREND_CHANGE_ENTRY) {
      return {
        action: "bias_only",
        allowed: false,
        reason: "bullish_trend_change_saved_bias_only",
        biasStatus: getBiasStatus(),
        positionStatus: getPositionStatus(),
      };
    }

    return entryDecisionFromScore({
      signal,
      price,
      time,
      minScore: CONFIG.TREND_CHANGE_MIN_SCORE,
      reasonPrefix: "bullish_trend_change_score_entry",
      allowMemory: true,
      allowPending: true,
    });
  }

  if (signal === SIGNALS.BULLISH_BOS) {
    saveBosBias({ signal, price, time });

    if (!CONFIG.ALLOW_BOS_ENTRY) {
      state.counters.confirmationOnly += 1;

      return {
        action: "confirmation_only",
        allowed: false,
        reason: "bullish_bos_confirmation_only",
        biasStatus: getBiasStatus(),
        positionStatus: getPositionStatus(),
      };
    }

    return entryDecisionFromScore({
      signal,
      price,
      time,
      minScore: CONFIG.BOS_MIN_SCORE,
      reasonPrefix: "bullish_bos_score_entry",
      allowMemory: true,
      allowPending: false,
    });
  }

  if (signal === SIGNALS.BULLISH_TREND_CONTINUATION) {
    if (!CONFIG.ALLOW_TREND_CONTINUATION_ENTRY) {
      return {
        action: "ignore",
        allowed: false,
        reason: "trend_continuation_entry_disabled",
        biasStatus: getBiasStatus(),
        positionStatus: getPositionStatus(),
      };
    }

    return entryDecisionFromScore({
      signal,
      price,
      time,
      minScore: CONFIG.BOS_MIN_SCORE,
      reasonPrefix: "bullish_trend_continuation_score_entry",
      allowMemory: true,
      allowPending: false,
    });
  }

  return {
    action: "ignore",
    allowed: false,
    reason: "no_matching_rule",
    biasStatus: getBiasStatus(),
    positionStatus: getPositionStatus(),
  };
}

// --------------------------------------------------
// Pending entry from feature update
// --------------------------------------------------
async function maybeTriggerPendingTrendChangeFromFeature(scoreCheckFromUpdate) {
  expirePendingTrendIfNeeded();

  if (!CONFIG.PENDING_TREND_CHANGE_ENTRY) {
    return { triggered: false, reason: "pending_disabled" };
  }

  if (!hasRecentPendingTrendChange()) {
    return { triggered: false, reason: "no_recent_pending_trend" };
  }

  if (state.position.inLong && CONFIG.LOCK_AFTER_ENTER) {
    return { triggered: false, reason: "already_in_long" };
  }

  const scoreCheck = evaluateScore(CONFIG.TREND_CHANGE_MIN_SCORE);

  if (!scoreCheck.pass) {
    return {
      triggered: false,
      reason: scoreCheck.hardBlocked ? "hard_blocked" : "score_not_confirmed",
      scoreCheck,
    };
  }

  const pending = { ...state.pendingTrendChange };
  const ctx = getFeatureContext();
  const feature = ctx.feature;

  let decision = {
    action: "enter_long",
    allowed: true,
    reason: `pending_bullish_trend_change_confirmed_${scoreCheck.setupType}`,
    signalSource: "feature_trigger_after_pending_trend_change",
    scoreCheck,
    biasStatus: getBiasStatus(),
    positionStatus: getPositionStatus(),
    scoreMemory: getScoreMemoryStatus(),
  };

  decision = applyTradeProtection({
    decision,
    signal: pending.signal || SIGNALS.BULLISH_TREND_CHANGE,
    price: feature?.close ?? pending.price ?? 0,
    time: feature?.time || isoNow(),
  });

  logFinalDecision({
    signal: pending.signal || SIGNALS.BULLISH_TREND_CHANGE,
    symbol: CONFIG.SYMBOL,
    price: feature?.close ?? pending.price ?? 0,
    decision,
  });

  if (!decision.allowed || decision.action !== "enter_long") {
    return {
      triggered: false,
      reason: decision.reason,
      decision,
    };
  }

  state.counters.pendingTrendTriggered += 1;

  const forwardResult = await forwardTo3Commas({
    symbol: CONFIG.SYMBOL,
    action: "enter_long",
    price: feature?.close ?? pending.price ?? 0,
    time: feature?.time || isoNow(),
    signal: pending.signal || SIGNALS.BULLISH_TREND_CHANGE,
    reason: decision.reason,
  });

  return {
    triggered: Boolean(forwardResult.ok && !forwardResult.skipped),
    reason: decision.reason,
    decision,
    forwardResult,
  };
}

// --------------------------------------------------
// Logging
// --------------------------------------------------
function logFinalDecision({ signal, symbol, price, decision }) {
  const scoreCheck = decision.scoreCheck || null;

  const base = {
    signal,
    symbol,
    price,
    action: decision.action,
    allowed: decision.allowed,
    reason: decision.reason,

    score: scoreCheck?.score,
    minScore: scoreCheck?.minScore,
    setupType: scoreCheck?.setupType,
    hardBlocked: scoreCheck?.hardBlocked,
    hardBlocks: scoreCheck?.hardBlocks,
    scorePoints: scoreCheck?.points,
    warnings: scoreCheck?.warnings,
    scoreValues: scoreCheck?.values,
    featureTf: scoreCheck?.tf,
    featureSource: scoreCheck?.source,

    scoreMemory: getScoreMemoryStatus(),
    pendingTrend: getPendingTrendStatus(),
    position: getPositionStatus(),
    bias: getBiasStatus(),
  };

  if (decision.action === "enter_long" && decision.allowed) {
    logEvent("🟢 ENTRY_ALLOWED", base);
    return;
  }

  if (decision.action === "exit_long" && decision.allowed) {
    logEvent("🔴 EXIT_ALLOWED", base);
    return;
  }

  if (decision.action === "bias_only") {
    logEvent("🧠 BIAS_ONLY", base);
    return;
  }

  if (decision.action === "confirmation_only") {
    logEvent("🧠 CONFIRMATION_ONLY", base);
    return;
  }

  if (decision.action === "blocked") {
    if (
      String(decision.reason || "").includes("exit") ||
      String(decision.reason || "").includes("not_in_long")
    ) {
      logEvent("🟠 EXIT_BLOCKED", base);
      return;
    }

    logEvent("⛔ ENTRY_BLOCKED", base);
    return;
  }

  if (isBearishSignal(signal) && !decision.allowed) {
    logEvent("🟠 EXIT_BLOCKED", base);
    return;
  }

  logEvent("⚪ SIGNAL_IGNORED", base);
}

// --------------------------------------------------
// 3Commas forwarding
// --------------------------------------------------
function resolveBotUuid(symbol) {
  const botUuid = CONFIG.SYMBOL_BOT_MAP[symbol];
  if (botUuid) return String(botUuid);

  const fallback = CONFIG.SYMBOL_BOT_MAP[CONFIG.SYMBOL];
  if (fallback) return String(fallback);

  return "";
}

function splitTvSymbol(symbol) {
  const s = normalizeSymbol(symbol);

  if (s.includes(":")) {
    const [exchange, instrument] = s.split(":");
    return {
      tv_exchange: exchange || "BINANCE",
      tv_instrument: instrument || s,
    };
  }

  return {
    tv_exchange: "BINANCE",
    tv_instrument: s,
  };
}

function build3CommasSignal({ symbol, action, price, time }) {
  const botUuid = resolveBotUuid(symbol);
  const { tv_exchange, tv_instrument } = splitTvSymbol(symbol);

  return {
    secret: CONFIG.C3_SIGNAL_SECRET,
    max_lag: String(CONFIG.MAX_LAG_SEC),
    timestamp: time || isoNow(),
    trigger_price: String(price),
    tv_exchange,
    tv_instrument,
    action,
    bot_uuid: botUuid,
  };
}

async function postJsonWithTimeout(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text().catch(() => "");

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      bodyText: text,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function forwardTo3Commas({ symbol, action, price, time, signal, reason }) {
  if (!CONFIG.ENABLE_HTTP_FORWARD) {
    logEvent("⚪ FORWARD_SKIP", {
      reason: "http_forward_disabled",
      symbol,
      action,
      price,
      signal,
    });

    return {
      skipped: true,
      ok: true,
      reason: "http_forward_disabled",
    };
  }

  if (!CONFIG.C3_SIGNAL_SECRET) {
    errorEvent("❌ FORWARD_FAIL", {
      reason: "missing_c3_signal_secret",
      symbol,
      action,
      signal,
    });

    return {
      ok: false,
      skipped: false,
      reason: "missing_c3_signal_secret",
    };
  }

  const botUuid = resolveBotUuid(symbol);

  if (!botUuid) {
    errorEvent("❌ FORWARD_FAIL", {
      reason: "missing_bot_uuid_for_symbol",
      symbol,
      action,
      signal,
    });

    return {
      ok: false,
      skipped: false,
      reason: "missing_bot_uuid_for_symbol",
    };
  }

  const payload = build3CommasSignal({
    symbol,
    action,
    price,
    time,
  });

  logEvent("📤 FORWARD_3COMMAS", {
    symbol,
    action,
    signal,
    reason,
    trigger_price: payload.trigger_price,
    tv_exchange: payload.tv_exchange,
    tv_instrument: payload.tv_instrument,
    bot_uuid: payload.bot_uuid,
    timestamp: payload.timestamp,
    max_lag: payload.max_lag,
  });

  try {
    const result = await postJsonWithTimeout(
      CONFIG.C3_SIGNAL_URL,
      payload,
      CONFIG.C3_TIMEOUT_MS
    );

    if (result.ok) {
      state.counters.forwardedOk += 1;

      logEvent("✅ FORWARD_OK", {
        action,
        signal,
        status: result.status,
        body: result.bodyText,
      });
    } else {
      state.counters.forwardedFail += 1;

      errorEvent("❌ FORWARD_FAIL", {
        action,
        signal,
        status: result.status,
        statusText: result.statusText,
        body: result.bodyText,
      });
    }

    return result;
  } catch (e) {
    state.counters.forwardedFail += 1;

    errorEvent("❌ FORWARD_FAIL", {
      action,
      signal,
      reason: "forward_exception",
      error: String(e?.message || e),
    });

    return {
      ok: false,
      skipped: false,
      reason: "forward_exception",
      error: e?.message || String(e),
    };
  }
}

// --------------------------------------------------
// Routes
// --------------------------------------------------
function publicConfig() {
  return {
    brainName: CONFIG.BRAIN_NAME,
    symbol: CONFIG.SYMBOL,
    webhookPath: CONFIG.WEBHOOK_PATH,
    entryMode: CONFIG.ENTRY_MODE,

    primaryFeatureTf: CONFIG.PRIMARY_FEATURE_TF,
    fallbackFeatureTf: CONFIG.FALLBACK_FEATURE_TF,
    primaryFeatureMaxAgeSec: CONFIG.PRIMARY_FEATURE_MAX_AGE_SEC,
    fallbackFeatureMaxAgeSec: CONFIG.FALLBACK_FEATURE_MAX_AGE_SEC,

    allowTrendChangeEntry: CONFIG.ALLOW_TREND_CHANGE_ENTRY,
    allowBosEntry: CONFIG.ALLOW_BOS_ENTRY,
    allowTrendContinuationEntry: CONFIG.ALLOW_TREND_CONTINUATION_ENTRY,

    trendChangeMinScore: CONFIG.TREND_CHANGE_MIN_SCORE,
    bosMinScore: CONFIG.BOS_MIN_SCORE,
    pendingMinScore: CONFIG.PENDING_MIN_SCORE,

    pendingTrendChangeEntry: CONFIG.PENDING_TREND_CHANGE_ENTRY,
    pendingTrendChangeTtlMin: CONFIG.PENDING_TREND_CHANGE_TTL_MIN,

    scoreMemoryEnabled: CONFIG.SCORE_MEMORY_ENABLED,
    scoreMemoryTtlMin: CONFIG.SCORE_MEMORY_TTL_MIN,
    scoreMemoryMinScore: CONFIG.SCORE_MEMORY_MIN_SCORE,

    hardBlocksEnabled: CONFIG.HARD_BLOCKS_ENABLED,
    chasePumpLookbackBars: CONFIG.CHASE_PUMP_LOOKBACK_BARS,
    chasePumpBlockPct: CONFIG.CHASE_PUMP_BLOCK_PCT,
    chaseExtEma11BlockPct: CONFIG.CHASE_EXT_EMA11_BLOCK_PCT,
    chaseRsiBlock: CONFIG.CHASE_RSI_BLOCK,

    recentBearishBlockMin: CONFIG.RECENT_BEARISH_BLOCK_MIN,

    entryCooldownSec: CONFIG.ENTRY_COOLDOWN_SEC,
    lockAfterEnter: CONFIG.LOCK_AFTER_ENTER,

    exitOnBearishTrendChange: CONFIG.EXIT_ON_BEARISH_TREND_CHANGE,
    exitOnBearishBos: CONFIG.EXIT_ON_BEARISH_BOS,
    exitOnBearishTrendContinuation: CONFIG.EXIT_ON_BEARISH_TREND_CONTINUATION,

    requireKnownSignal: CONFIG.REQUIRE_KNOWN_SIGNAL,
  };
}

app.get("/", (req, res) => {
  return responseOk(res, {
    message: "Brain is running",
    startedAt: state.startedAt,
    webhookPath: CONFIG.WEBHOOK_PATH,
    symbol: CONFIG.SYMBOL,
    config: publicConfig(),
    position: getPositionStatus(),
    bias: getBiasStatus(),
    feature: featureStatus(),
    counters: state.counters,
  });
});

app.get("/health", (req, res) => {
  return responseOk(res, {
    status: "healthy",
    startedAt: state.startedAt,
    symbol: CONFIG.SYMBOL,
    position: getPositionStatus(),
    bias: getBiasStatus(),
    feature: featureStatus(),
    counters: state.counters,
  });
});

app.get("/state", (req, res) => {
  return responseOk(res, {
    state,
    config: publicConfig(),
    feature: featureStatus(),
  });
});

app.post(CONFIG.WEBHOOK_PATH, async (req, res) => {
  state.counters.received += 1;

  const body = req.body || {};
  state.lastPayload = body;

  const receivedSecret = String(body.secret || body.tv_secret || "").trim();

  if (!CONFIG.WEBHOOK_SECRET) {
    errorEvent("❌ WEBHOOK_SECRET_MISSING", {});
    return responseFail(res, 500, {
      reason: "server_missing_webhook_secret",
    });
  }

  if (receivedSecret !== CONFIG.WEBHOOK_SECRET) {
    state.counters.unauthorized += 1;

    warnEvent("🚫 UNAUTHORIZED", {
      receivedSecretPresent: Boolean(receivedSecret),
    });

    return responseFail(res, 401, {
      reason: "unauthorized",
    });
  }

  if (isFeaturePayload(body)) {
    const result = await updateFeature(body);

    return responseOk(res, {
      accepted: result.ok,
      type: "features",
      reason: result.reason,
      feature: result.feature,
      scoreCheck: result.scoreCheck,
      scoreMemory: getScoreMemoryStatus(),
      pendingTrend: getPendingTrendStatus(),
      pendingResult: result.pendingResult,
      counters: state.counters,
    });
  }

  const src = normalizeSrc(body.src);
  const symbol = normalizeSymbol(body.symbol || body.ticker || body.tickerid || CONFIG.SYMBOL);
  const signal = normalizeSignal(body.signal || body.alert || body.condition);
  const price = safeNumber(body.price ?? body.close ?? body.trigger_price, null);
  const time = String(body.time || body.timestamp || isoNow()).trim();

  if (symbol !== CONFIG.SYMBOL) {
    state.counters.wrongSymbol += 1;

    warnEvent("⚠️ WRONG_SYMBOL", {
      received: symbol,
      expected: CONFIG.SYMBOL,
      signal,
      price,
    });

    return responseOk(res, {
      accepted: false,
      reason: "wrong_symbol",
      receivedSymbol: symbol,
      expectedSymbol: CONFIG.SYMBOL,
    });
  }

  if (!signal) {
    state.counters.unknownSignal += 1;

    warnEvent("⚠️ UNKNOWN_SIGNAL", {
      reason: "missing_signal",
      src,
      symbol,
      price,
    });

    return responseOk(res, {
      accepted: false,
      reason: "missing_signal",
    });
  }

  if (CONFIG.REQUIRE_KNOWN_SIGNAL && !KNOWN_SIGNALS.has(signal)) {
    state.counters.unknownSignal += 1;

    warnEvent("⚠️ UNKNOWN_SIGNAL", {
      signal,
      src,
      symbol,
      price,
      knownSignals: Array.from(KNOWN_SIGNALS),
    });

    return responseOk(res, {
      accepted: false,
      reason: "unknown_signal",
      signal,
      knownSignals: Array.from(KNOWN_SIGNALS),
    });
  }

  const cleanPrice = price ?? 0;

  logEvent(raySignalTag(signal), {
    price: cleanPrice,
    ts: time,
    src,
    symbol,
    feature: {
      selected: getFeatureContext().tf,
      ageSec: getFeatureContext().ageSec,
      source: getFeatureContext().source,
    },
    scoreMemory: getScoreMemoryStatus(),
    pendingTrend: getPendingTrendStatus(),
  });

  let decision = decideRayAlgoSignal({
    signal,
    price: cleanPrice,
    time,
  });

  decision = applyTradeProtection({
    decision,
    signal,
    price: cleanPrice,
    time,
  });

  logFinalDecision({
    signal,
    symbol,
    price: cleanPrice,
    decision,
  });

  if (!decision.allowed || !["enter_long", "exit_long"].includes(decision.action)) {
    return responseOk(res, {
      accepted: true,
      forwarded: false,
      src,
      symbol,
      signal,
      price: cleanPrice,
      decision,
      position: getPositionStatus(),
      feature: featureStatus(),
      counters: state.counters,
    });
  }

  const forwardResult = await forwardTo3Commas({
    symbol,
    action: decision.action,
    price: cleanPrice,
    time,
    signal,
    reason: decision.reason,
  });

  return responseOk(res, {
    accepted: true,
    forwarded: Boolean(forwardResult.ok && !forwardResult.skipped),
    src,
    symbol,
    signal,
    price: cleanPrice,
    action: decision.action,
    decision,
    forwardResult,
    position: getPositionStatus(),
    feature: featureStatus(),
    counters: state.counters,
  });
});

app.post("/reset", (req, res) => {
  cancelBullishBias("manual_reset");
  clearPendingTrendChange("manual_reset");

  state.lastEnterLong = {
    tsMs: null,
    price: null,
    signal: null,
    reason: null,
  };

  state.lastExitLong = {
    tsMs: null,
    price: null,
    signal: null,
    reason: null,
  };

  state.position = {
    inLong: false,
    entryPrice: null,
    entrySignal: null,
    entryReason: null,
    entryScore: null,
    entryTime: null,
    entryTsMs: null,

    exitPrice: null,
    exitSignal: null,
    exitReason: null,
    exitTime: null,
    exitTsMs: null,
  };

  logEvent("♻️ STATE_RESET", {
    position: getPositionStatus(),
    bias: getBiasStatus(),
    scoreMemory: getScoreMemoryStatus(),
    pendingTrend: getPendingTrendStatus(),
  });

  return responseOk(res, {
    message: "state reset",
    position: getPositionStatus(),
    bias: getBiasStatus(),
    feature: featureStatus(),
  });
});

app.post("/reset-all", (req, res) => {
  state.featuresByTf = {};

  state.scoreMemory = {
    active: false,
    pass: false,
    score: null,
    setupType: null,
    time: null,
    tsMs: null,
    price: null,
    tf: null,
    scoreCheck: null,
  };

  state.lastBearishSignal = {
    signal: null,
    price: null,
    time: null,
    tsMs: null,
  };

  cancelBullishBias("manual_reset_all");
  clearPendingTrendChange("manual_reset_all");

  state.lastEnterLong = {
    tsMs: null,
    price: null,
    signal: null,
    reason: null,
  };

  state.lastExitLong = {
    tsMs: null,
    price: null,
    signal: null,
    reason: null,
  };

  state.position = {
    inLong: false,
    entryPrice: null,
    entrySignal: null,
    entryReason: null,
    entryScore: null,
    entryTime: null,
    entryTsMs: null,

    exitPrice: null,
    exitSignal: null,
    exitReason: null,
    exitTime: null,
    exitTsMs: null,
  };

  logEvent("♻️ STATE_RESET_ALL", {
    position: getPositionStatus(),
    bias: getBiasStatus(),
    feature: null,
    scoreMemory: getScoreMemoryStatus(),
    pendingTrend: getPendingTrendStatus(),
  });

  return responseOk(res, {
    message: "state and features reset",
    position: getPositionStatus(),
    bias: getBiasStatus(),
    feature: featureStatus(),
  });
});

// --------------------------------------------------
// Start
// --------------------------------------------------
app.listen(CONFIG.PORT, () => {
  console.log(
    `${isoNow()} ✅ START_OK | ${oneLine({
      brain: CONFIG.BRAIN_NAME,
      port: CONFIG.PORT,
      symbol: CONFIG.SYMBOL,
      webhookPath: CONFIG.WEBHOOK_PATH,
    })}`
  );

  console.log(
    `${isoNow()} 🧠 CONFIG_SNAPSHOT | ${oneLine({
      webhookPath: CONFIG.WEBHOOK_PATH,
      symbol: CONFIG.SYMBOL,
      debug: CONFIG.DEBUG,
      entryMode: CONFIG.ENTRY_MODE,
      enableHttpForward: CONFIG.ENABLE_HTTP_FORWARD,
      c3Url: CONFIG.C3_SIGNAL_URL,
      hasWebhookSecret: Boolean(CONFIG.WEBHOOK_SECRET),
      hasC3SignalSecret: Boolean(CONFIG.C3_SIGNAL_SECRET),
      symbolBotMapKeys: Object.keys(CONFIG.SYMBOL_BOT_MAP),

      primaryFeatureTf: CONFIG.PRIMARY_FEATURE_TF,
      fallbackFeatureTf: CONFIG.FALLBACK_FEATURE_TF,
      primaryFeatureMaxAgeSec: CONFIG.PRIMARY_FEATURE_MAX_AGE_SEC,
      fallbackFeatureMaxAgeSec: CONFIG.FALLBACK_FEATURE_MAX_AGE_SEC,

      allowTrendChangeEntry: CONFIG.ALLOW_TREND_CHANGE_ENTRY,
      allowBosEntry: CONFIG.ALLOW_BOS_ENTRY,
      allowTrendContinuationEntry: CONFIG.ALLOW_TREND_CONTINUATION_ENTRY,

      trendChangeMinScore: CONFIG.TREND_CHANGE_MIN_SCORE,
      bosMinScore: CONFIG.BOS_MIN_SCORE,
      pendingMinScore: CONFIG.PENDING_MIN_SCORE,

      pendingTrendChangeEntry: CONFIG.PENDING_TREND_CHANGE_ENTRY,
      pendingTrendChangeTtlMin: CONFIG.PENDING_TREND_CHANGE_TTL_MIN,

      scoreMemoryEnabled: CONFIG.SCORE_MEMORY_ENABLED,
      scoreMemoryTtlMin: CONFIG.SCORE_MEMORY_TTL_MIN,
      scoreMemoryMinScore: CONFIG.SCORE_MEMORY_MIN_SCORE,

      hardBlocksEnabled: CONFIG.HARD_BLOCKS_ENABLED,
      chasePumpLookbackBars: CONFIG.CHASE_PUMP_LOOKBACK_BARS,
      chasePumpBlockPct: CONFIG.CHASE_PUMP_BLOCK_PCT,
      chaseExtEma11BlockPct: CONFIG.CHASE_EXT_EMA11_BLOCK_PCT,
      chaseRsiBlock: CONFIG.CHASE_RSI_BLOCK,

      recentBearishBlockMin: CONFIG.RECENT_BEARISH_BLOCK_MIN,

      enterDedupSec: CONFIG.ENTER_DEDUP_SEC,
      entryCooldownSec: CONFIG.ENTRY_COOLDOWN_SEC,
      lockAfterEnter: CONFIG.LOCK_AFTER_ENTER,

      exitOnBearishTrendChange: CONFIG.EXIT_ON_BEARISH_TREND_CHANGE,
      exitOnBearishBos: CONFIG.EXIT_ON_BEARISH_BOS,
      exitOnBearishTrendContinuation: CONFIG.EXIT_ON_BEARISH_TREND_CONTINUATION,

      exitDedupSec: CONFIG.EXIT_DEDUP_SEC,
      exitCooldownSec: CONFIG.EXIT_COOLDOWN_SEC,
      requireKnownSignal: CONFIG.REQUIRE_KNOWN_SIGNAL,
    })}`
  );
});
