/**
 * BrainPhase2_DemoLong_v3.6b
 *
 * Merged from:
 * - BrainPhase2_DemoLong v3.5 direction
 * - v3.6 structure improvements
 * - log-backed tuning from logs20260317_Phase2.log
 *
 * Key points:
 * - FEATURES path handles regime/setup/scoring
 * - TICK path handles timing + active trade management
 * - Warmup reduced vs prior version
 * - Breakout confirmation kept strict
 * - Retest stale cleanup kept and made explicit
 * - Washout reclaim path preserved
 * - Flow-aware scoring preserved
 * - Full script, no partial patch
 */

import express from "express";

// --------------------------------------------------
// App / config helpers
// --------------------------------------------------
const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 8080);
const DEBUG = String(process.env.DEBUG || "1") === "1";
const BRAIN_NAME = process.env.BRAIN_NAME || "BrainPhase2_DemoLong_v3.6b";

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const TICKROUTER_SECRET = process.env.TICKROUTER_SECRET || "";

const C3_SIGNAL_URL =
  process.env.C3_SIGNAL_URL || "https://api.3commas.io/signal_bots/webhooks";
const C3_SIGNAL_SECRET = process.env.C3_SIGNAL_SECRET || "";
const C3_TIMEOUT_MS = Number(process.env.C3_TIMEOUT_MS || 8000);
const MAX_LAG_SEC = Number(process.env.MAX_LAG_SEC || 300);

const SYMBOL_BOT_MAP = safeJson(process.env.SYMBOL_BOT_MAP || "{}", {});
const ALLOW_SYMBOLS = Object.keys(SYMBOL_BOT_MAP);

// warmup / setup lifecycle
const MIN_BARS_FOR_SETUPS = Number(process.env.MIN_BARS_FOR_SETUPS || 20);
const SETUP_TTL_SEC = Number(process.env.SETUP_TTL_SEC || 1800);
const BREAKOUT_MAX_AGE_MIN = Number(process.env.BREAKOUT_MAX_AGE_MIN || 12);
const BREAKOUT_RETEST_MAX_MIN = Number(process.env.BREAKOUT_RETEST_MAX_MIN || 4);
const WASHOUT_MAX_AGE_MIN = Number(process.env.WASHOUT_MAX_AGE_MIN || 12);

// freshness / signals
const REQUIRE_FRESH_HEARTBEAT =
  String(process.env.REQUIRE_FRESH_HEARTBEAT || "1") === "1";
const HEARTBEAT_MAX_AGE_SEC = Number(process.env.HEARTBEAT_MAX_AGE_SEC || 90);
const TICK_MAX_AGE_SEC = Number(process.env.TICK_MAX_AGE_SEC || 60);
const TICK_LOG_EVERY_MS = Number(process.env.TICK_LOG_EVERY_MS || 180000);
const RAY_SIGNAL_TTL_MS = Number(process.env.RAY_SIGNAL_TTL_MS || 900000);
const FWO_SIGNAL_TTL_MS = Number(process.env.FWO_SIGNAL_TTL_MS || 900000);

// dedupe / cooldown
const ENTER_DEDUP_SEC = Number(process.env.ENTER_DEDUP_SEC || 25);
const EXIT_DEDUP_SEC = Number(process.env.EXIT_DEDUP_SEC || 20);
const COOLDOWN_SEC = Number(process.env.COOLDOWN_SEC || 180);

// scoring / entry thresholds
const BREAKOUT_MIN_SCORE = Number(process.env.BREAKOUT_MIN_SCORE || 7);
const WASHOUT_MIN_SCORE = Number(process.env.WASHOUT_MIN_SCORE || 6);

const BREAKOUT_MIN_ADX = Number(process.env.BREAKOUT_MIN_ADX || 20);
const BREAKOUT_CONFIRM_BOUNCE_PCT = Number(
  process.env.BREAKOUT_CONFIRM_BOUNCE_PCT || 0.08
);
const BREAKOUT_NEAR_LEVEL_MAX_PCT = Number(
  process.env.BREAKOUT_NEAR_LEVEL_MAX_PCT || 0.35
);
const BREAKOUT_NEAR_EMA8_MAX_PCT = Number(
  process.env.BREAKOUT_NEAR_EMA8_MAX_PCT || 0.20
);
const BREAKOUT_STALE_MIN_SCORE = Number(
  process.env.BREAKOUT_STALE_MIN_SCORE || 5
);
const ALLOW_EARLY_TREND_ENTRY =
  String(process.env.ALLOW_EARLY_TREND_ENTRY || "1") === "1";
const BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE =
  String(process.env.BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE || "1") === "1";

// risk / sizing
const BOT_MAX_NOTIONAL_USDT = Number(process.env.BOT_MAX_NOTIONAL_USDT || 3000);
const ACCOUNT_EQUITY = Number(process.env.ACCOUNT_EQUITY || 3000);
const BASE_RISK_PCT = Number(process.env.BASE_RISK_PCT || 0.35);
const MIN_RISK_PCT = Number(process.env.MIN_RISK_PCT || 0.2);
const MAX_RISK_PCT = Number(process.env.MAX_RISK_PCT || 0.7);
const MIN_VOLUME_PCT = Number(process.env.MIN_VOLUME_PCT || 5);
const MAX_VOLUME_PCT = Number(process.env.MAX_VOLUME_PCT || 100);

// pump / anti-chase
const PUMP_BLOCK_PCT = Number(process.env.PUMP_BLOCK_PCT || 1.8);
const PUMP_BLOCK_WINDOW_BARS = Number(process.env.PUMP_BLOCK_WINDOW_BARS || 3);
const MAX_CHASE_PCT_WASHOUT = Number(process.env.MAX_CHASE_PCT_WASHOUT || 0.20);
const MAX_CHASE_PCT_BREAKOUT = Number(process.env.MAX_CHASE_PCT_BREAKOUT || 0.35);

// trade management
const TREND_STOP_ACTIVATE_MIN = Number(
  process.env.TREND_STOP_ACTIVATE_MIN || 9
);
const TREND_MIN_TRAIL_PCT = Number(process.env.TREND_MIN_TRAIL_PCT || 0.5);
const TREND_TIME_STOP_MIN = Number(process.env.TREND_TIME_STOP_MIN || 60);
const TREND_MIN_PROGRESS_PCT = Number(
  process.env.TREND_MIN_PROGRESS_PCT || 0.15
);
const TRAIL_ATR_MULT = Number(process.env.TRAIL_ATR_MULT || 2.0);

// --------------------------------------------------
// Utilities
// --------------------------------------------------
function safeJson(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function nowMs() {
  return Date.now();
}

function ageSec(ts) {
  if (!ts) return 999999;
  return (nowMs() - ts) / 1000;
}

function ageMin(ts) {
  return ageSec(ts) / 60;
}

function pctChange(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0;
  return ((a - b) / b) * 100;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function fmt(x, d = 4) {
  return Number.isFinite(x) ? Number(x).toFixed(d) : "na";
}

function dlog(...args) {
  if (DEBUG) console.log(...args);
}

function verifySecret(req, isTick = false) {
  const supplied =
    req.headers["x-webhook-secret"] ||
    req.body?.secret ||
    req.query?.secret ||
    "";
  const expected = isTick ? TICKROUTER_SECRET : WEBHOOK_SECRET;
  if (!expected) return true;
  return String(supplied) === String(expected);
}

// --------------------------------------------------
// State
// --------------------------------------------------
const S = {};

function ensureState(symbol) {
  if (!S[symbol]) {
    S[symbol] = {
      symbol,

      // market
      lastPrice: null,
      lastTickMs: 0,
      tickCount: 0,
      lastTickLogMs: 0,

      // features
      tf: "3",
      close: null,
      ema8: null,
      ema18: null,
      ema50: null,
      rsi: null,
      adx: null,
      atr: null,
      atrPct: null,
      heartbeat: 0,
      lastHeartbeatMs: 0,

      // external signal freshness
      rayFresh: 0,
      fwoFresh: 0,
      raySignal: "",
      fwoSignal: "",
      lastRayBullMs: 0,
      lastRayBearMs: 0,
      lastFwoBullMs: 0,
      lastFwoBearMs: 0,

      // flow / pattern features
      oiTrend: 0,
      oiDeltaBias: 0,
      cvdTrend: 0,
      liqClusterBelow: 0,
      priceDropPct: 0,
      patternAReady: 0,
      patternAWatch: 0,

      // rolling bars
      barsSeen: 0,
      closeHist: [],

      // regime
      regime: "range",
      regimeConf: 0.4,

      // setup
      armed: false,
      setupType: "",
      setupPhase: "idle", // idle | breakout_triggered | breakout_retest | breakout_bounce_confirmed | washout_reclaim
      setupTs: 0,
      setupScore: 0,
      setupReasons: [],
      level: null,
      triggerPrice: null,
      retestPrice: null,
      bouncePrice: null,
      invalidation: null,

      // position
      inPosition: false,
      entryPrice: null,
      entryTs: 0,
      peakPrice: null,
      stopPrice: null,
      trailingStop: null,

      // dedupe / cooldown
      enterInFlight: false,
      exitInFlight: false,
      lastEnterMs: 0,
      lastExitMs: 0,
      cooldownUntilMs: 0,

      // last action
      lastAction: "none",
    };
  }
  return S[symbol];
}

// --------------------------------------------------
// Core helpers
// --------------------------------------------------
function updateCloseHistory(st, close) {
  if (!Number.isFinite(close)) return;
  st.closeHist.push(close);
  if (st.closeHist.length > 20) st.closeHist.shift();
}

function recentPumpPct(st) {
  if (st.closeHist.length < PUMP_BLOCK_WINDOW_BARS + 1) return 0;
  const from = st.closeHist[st.closeHist.length - 1 - PUMP_BLOCK_WINDOW_BARS];
  const to = st.closeHist[st.closeHist.length - 1];
  return pctChange(to, from);
}

function isFreshTick(st) {
  return ageSec(st.lastTickMs) <= TICK_MAX_AGE_SEC;
}

function isFreshHeartbeat(st) {
  if (!REQUIRE_FRESH_HEARTBEAT) return true;
  return ageSec(st.lastHeartbeatMs) <= HEARTBEAT_MAX_AGE_SEC;
}

function inCooldown(st) {
  return nowMs() < st.cooldownUntilMs;
}

function shouldDedupeEnter(st) {
  if (st.enterInFlight) return true;
  return ageSec(st.lastEnterMs) < ENTER_DEDUP_SEC;
}

function shouldDedupeExit(st) {
  if (st.exitInFlight) return true;
  return ageSec(st.lastExitMs) < EXIT_DEDUP_SEC;
}

function clearSetup(st, reason = "") {
  if (reason) {
    dlog(`🧹 Setup cleared (${reason}) type=${st.setupType || "na"}`);
  }
  st.armed = false;
  st.setupType = "";
  st.setupPhase = "idle";
  st.setupTs = 0;
  st.setupScore = 0;
  st.setupReasons = [];
  st.level = null;
  st.triggerPrice = null;
  st.retestPrice = null;
  st.bouncePrice = null;
  st.invalidation = null;
}

function resetPosition(st) {
  st.inPosition = false;
  st.entryPrice = null;
  st.entryTs = 0;
  st.peakPrice = null;
  st.stopPrice = null;
  st.trailingStop = null;
}

function computeRegime(st) {
  let score = 0;
  const bullAligned =
    st.ema8 != null &&
    st.ema18 != null &&
    st.ema50 != null &&
    st.ema8 > st.ema18 &&
    st.ema18 > st.ema50;

  if (bullAligned) score += 2;
  if ((st.adx || 0) >= 18) score += 1;
  if ((st.adx || 0) >= 25) score += 1;
  if ((st.atrPct || 0) >= 0.25) score += 1;

  if (score >= 4) return { mode: "trend", conf: 0.8 };
  if (score >= 3) return { mode: "trend", conf: 0.6 };
  return { mode: "range", conf: 0.4 };
}

function computeSignalFreshness(st) {
  st.rayFresh =
    Math.max(st.lastRayBullMs, st.lastRayBearMs) &&
    nowMs() - Math.max(st.lastRayBullMs, st.lastRayBearMs) <= RAY_SIGNAL_TTL_MS
      ? 1
      : 0;

  st.fwoFresh =
    Math.max(st.lastFwoBullMs, st.lastFwoBearMs) &&
    nowMs() - Math.max(st.lastFwoBullMs, st.lastFwoBearMs) <= FWO_SIGNAL_TTL_MS
      ? 1
      : 0;
}

function computeStopDistancePct(entry, stop) {
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || stop >= entry) return 0.5;
  return ((entry - stop) / entry) * 100;
}

function computeRiskVolumePct(st, entryPrice, stopPrice) {
  const stopDistPct = computeStopDistancePct(entryPrice, stopPrice);
  if (stopDistPct <= 0) return MIN_VOLUME_PCT;

  let riskPct = BASE_RISK_PCT;
  if ((st.atrPct || 0) < 0.15) riskPct -= 0.05;
  if ((st.atrPct || 0) > 0.30) riskPct += 0.05;
  if (st.regime === "trend" && (st.adx || 0) > 22) riskPct += 0.05;
  riskPct = clamp(riskPct, MIN_RISK_PCT, MAX_RISK_PCT);

  let sizeMult = 1.0;
  if (st.setupScore >= 8) sizeMult = 1.15;
  else if (st.setupScore >= 7) sizeMult = 1.0;
  else if (st.setupScore >= 6) sizeMult = 0.85;
  else sizeMult = 0.7;

  const riskUsd = ACCOUNT_EQUITY * (riskPct / 100) * sizeMult;
  const maxNotionalByRisk = riskUsd / (stopDistPct / 100);
  const cappedNotional = Math.min(maxNotionalByRisk, BOT_MAX_NOTIONAL_USDT);

  let volumePct = (cappedNotional / BOT_MAX_NOTIONAL_USDT) * 100;
  volumePct = clamp(volumePct, MIN_VOLUME_PCT, MAX_VOLUME_PCT);

  return {
    riskPct,
    riskUsd,
    stopDistPct,
    sizeMult,
    volumePct: Number(volumePct.toFixed(2)),
  };
}

// --------------------------------------------------
// Setup scoring
// --------------------------------------------------
function scoreBreakout(st) {
  let score = 0;
  const reasons = [];

  const bullAligned =
    st.ema8 != null &&
    st.ema18 != null &&
    st.ema50 != null &&
    st.ema8 > st.ema18 &&
    st.ema18 > st.ema50;

  if (st.regime === "trend") {
    score += 2;
    reasons.push("regime(trend)+2");
  } else {
    reasons.push("regime(range)+0");
  }

  if (bullAligned) {
    score += 2;
    reasons.push("bull aligned +2");
  }

  if ((st.adx || 0) >= BREAKOUT_MIN_ADX) {
    score += 1;
    reasons.push("adx ok +1");
  }

  if ((st.rsi || 0) >= 55) {
    score += 1;
    reasons.push("rsi strength +1");
  }

  if (st.rayFresh) {
    score += 1;
    reasons.push("fresh ray +1");
  }

  if (st.fwoFresh) {
    score += 1;
    reasons.push("fresh fwo +1");
  }

  if (st.oiTrend > 0) {
    score += 1;
    reasons.push("oi trend up +1");
  }

  if (st.oiDeltaBias > 0) {
    score += 1;
    reasons.push("oi expansion +1");
  }

  if (st.cvdTrend > 0) {
    score += 1;
    reasons.push("cvd bullish +1");
  }

  const pumpPct = recentPumpPct(st);
  if (pumpPct > PUMP_BLOCK_PCT) {
    score -= 3;
    reasons.push(`pump>${PUMP_BLOCK_PCT}% -3`);
  }

  if (
    BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE &&
    st.oiTrend <= 0 &&
    st.oiDeltaBias <= 0 &&
    st.cvdTrend <= 0
  ) {
    score -= 2;
    reasons.push("flow weak -2");
  }

  return { score, reasons };
}

function scoreWashout(st) {
  let score = 0;
  const reasons = [];

  if (st.regime === "range") {
    score += 1;
    reasons.push("regime(range) +1");
  } else {
    score += 1;
    reasons.push("regime(trend) +1");
  }

  if ((st.rsi || 0) > 0 && (st.rsi || 0) <= 45) {
    score += 1;
    reasons.push("rsi recovering +1");
  }

  if (st.fwoFresh) {
    score += 2;
    reasons.push("fresh fwo sniper +2");
  }

  if (st.rayFresh) {
    score += 1;
    reasons.push("fresh ray +1");
  }

  if (st.oiTrend > 0) {
    score += 1;
    reasons.push("oi trend up +1");
  }

  if (st.oiDeltaBias > 0) {
    score += 1;
    reasons.push("oi expansion +1");
  }

  if (st.cvdTrend > 0) {
    score += 1;
    reasons.push("cvd bullish +1");
  }

  if (st.liqClusterBelow) {
    score += 1;
    reasons.push("liq below +1");
  }

  if ((st.priceDropPct || 0) <= -0.2) {
    score += 1;
    reasons.push("recent flush +1");
  }

  return { score, reasons };
}

// --------------------------------------------------
// Setup detection
// --------------------------------------------------
function detectBreakoutSetup(st) {
  if (st.regime !== "trend") return null;
  if (
    st.close == null ||
    st.ema8 == null ||
    st.ema18 == null ||
    st.ema50 == null
  ) {
    return null;
  }

  const bullAligned = st.ema8 > st.ema18 && st.ema18 > st.ema50;
  if (!bullAligned) return null;
  if ((st.adx || 0) < BREAKOUT_MIN_ADX) return null;

  const swingHigh = Math.max(...st.closeHist.slice(-10), st.close || -Infinity);
  const breakout = st.close >= swingHigh * 0.999;

  dlog(
    `🔎 BRKCHK swingHigh=${fmt(swingHigh)} breakout=${breakout ? 1 : 0}`
  );

  if (!breakout) return null;

  const scored = scoreBreakout(st);
  if (scored.score < BREAKOUT_MIN_SCORE) return null;

  return {
    type: "breakout_pullback",
    phase: "breakout_triggered",
    level: st.ema8,
    triggerPrice: st.close,
    retestPrice: null,
    bouncePrice: null,
    invalidation: st.ema18 * 0.997,
    score: scored.score,
    reasons: scored.reasons,
  };
}

function detectWashoutSetup(st) {
  if (
    st.close == null ||
    st.ema18 == null ||
    st.ema50 == null ||
    st.rsi == null
  ) {
    return null;
  }

  const localLow = Math.min(...st.closeHist.slice(-12), st.close || Infinity);
  const washout = localLow < st.ema50 * 0.995;
  const reclaimed = st.close > st.ema18;
  const prev1 = st.closeHist.length >= 2 ? st.closeHist[st.closeHist.length - 2] : null;
  const rsiUp = prev1 != null ? st.close > prev1 : false;

  dlog(
    `🔎 SETUPCHK localLow=${fmt(localLow)} ema50=${fmt(st.ema50)} washout=${washout ? 1 : 0} reclaimed=${reclaimed ? 1 : 0} rsiUp=${rsiUp ? 1 : 0}`
  );

  if (!washout || !reclaimed || !rsiUp) return null;

  const scored = scoreWashout(st);
  if (scored.score < WASHOUT_MIN_SCORE) return null;

  return {
    type: "washout_reclaim",
    phase: "washout_reclaim",
    level: st.ema18,
    triggerPrice: st.close,
    retestPrice: null,
    bouncePrice: st.close,
    invalidation: localLow * 0.999,
    score: scored.score,
    reasons: scored.reasons,
  };
}

function maybeArmSetup(st) {
  if (st.inPosition || inCooldown(st)) return;
  if (st.barsSeen < MIN_BARS_FOR_SETUPS) {
    dlog(`⏳ detectSetups waiting bars=${st.barsSeen}/${MIN_BARS_FOR_SETUPS}`);
    return;
  }

  const wash = detectWashoutSetup(st);
  if (wash) {
    st.armed = true;
    st.setupType = wash.type;
    st.setupPhase = wash.phase;
    st.setupTs = nowMs();
    st.setupScore = wash.score;
    st.setupReasons = wash.reasons;
    st.level = wash.level;
    st.triggerPrice = wash.triggerPrice;
    st.retestPrice = wash.retestPrice;
    st.bouncePrice = wash.bouncePrice;
    st.invalidation = wash.invalidation;
    dlog(
      `📌 STATE ${st.symbol} reg=${st.regime} armed=1 type=${st.setupType} setupAgeMin=0.0 score=${st.setupScore} inPos=0 cooldown=0 rayFresh=${st.rayFresh} fwoFresh=${st.fwoFresh}`
    );
    dlog(`🟡 Armed washout_reclaim inv=${st.invalidation}`);
    return;
  }

  const brk = detectBreakoutSetup(st);
  if (brk) {
    st.armed = true;
    st.setupType = brk.type;
    st.setupPhase = brk.phase;
    st.setupTs = nowMs();
    st.setupScore = brk.score;
    st.setupReasons = brk.reasons;
    st.level = brk.level;
    st.triggerPrice = brk.triggerPrice;
    st.retestPrice = brk.retestPrice;
    st.bouncePrice = brk.bouncePrice;
    st.invalidation = brk.invalidation;
    dlog(
      `📌 STATE ${st.symbol} reg=${st.regime} armed=1 type=${st.setupType} setupAgeMin=0.0 score=${st.setupScore} inPos=0 cooldown=0 rayFresh=${st.rayFresh} fwoFresh=${st.fwoFresh}`
    );
    dlog(
      `🟦 Armed breakout_pullback trigger=${fmt(st.triggerPrice)} level=${fmt(st.level)} inv=${fmt(st.invalidation)} score=${st.setupScore}`
    );
    return;
  }

  dlog(
    `📌 STATE ${st.symbol} reg=${st.regime} armed=0 type= setupAgeMin=0 score=0 inPos=${st.inPosition ? 1 : 0} cooldown=${inCooldown(st) ? 1 : 0} rayFresh=${st.rayFresh} fwoFresh=${st.fwoFresh}`
  );
}

function manageSetupLifecycle(st) {
  if (!st.armed) return;

  const sAgeMin = ageMin(st.setupTs);

  if (ageSec(st.setupTs) > SETUP_TTL_SEC) {
    clearSetup(st, "setup_ttl");
    return;
  }

  if (st.setupType === "washout_reclaim" && sAgeMin > WASHOUT_MAX_AGE_MIN) {
    clearSetup(st, "washout_stale");
    return;
  }

  if (st.setupType === "breakout_pullback") {
    if (sAgeMin > BREAKOUT_MAX_AGE_MIN) {
      clearSetup(st, "breakout_stale");
      return;
    }

    if (st.setupPhase === "breakout_triggered") {
      const pullbackHappened =
        st.close != null &&
        st.triggerPrice != null &&
        st.close <= st.triggerPrice * 0.9995;

      if (pullbackHappened) {
        st.setupPhase = "breakout_retest";
        st.retestPrice = st.close;
        dlog(`🔁 breakout retest price=${fmt(st.retestPrice)}`);
      }
    }

    if (st.setupPhase === "breakout_retest") {
      const retestAgeMin = ageMin(st.setupTs);
      if (retestAgeMin > BREAKOUT_RETEST_MAX_MIN) {
        dlog(
          `⌛ Breakout retest stale retestAgeMin=${fmt(retestAgeMin, 1)} > ${BREAKOUT_RETEST_MAX_MIN}`
        );
        clearSetup(st, "breakout_retest_stale");
        return;
      }
    }

    if (st.invalidation != null && st.close != null && st.close <= st.invalidation) {
      clearSetup(st, "breakout_invalidated");
      return;
    }
  }
}

// --------------------------------------------------
// Entry checks
// --------------------------------------------------
function canEnter(st) {
  if (st.inPosition) return { ok: false, note: "already in position" };
  if (!st.armed) return { ok: false, note: "no setup" };
  if (inCooldown(st)) return { ok: false, note: "cooldown" };
  if (!isFreshTick(st)) return { ok: false, note: "tick stale" };
  if (!isFreshHeartbeat(st)) return { ok: false, note: "heartbeat stale" };
  if (shouldDedupeEnter(st)) return { ok: false, note: "enter dedupe" };
  return { ok: true, note: "ok" };
}

function breakoutEntryDecision(st, price) {
  if (st.setupType !== "breakout_pullback") return { ok: false, note: "not breakout" };
  if (st.level == null || st.ema8 == null) return { ok: false, note: "missing level" };

  const nearLevelPct = Math.abs(pctChange(price, st.level));
  const nearEma8Pct = Math.abs(pctChange(price, st.ema8));
  const bounceBase = st.retestPrice ?? st.triggerPrice ?? price;
  const bouncePct = pctChange(price, bounceBase);
  const aboveLevel = price >= st.level ? 1 : 0;
  const aboveEma8 = price >= st.ema8 ? 1 : 0;
  const maxDist = BREAKOUT_NEAR_LEVEL_MAX_PCT;

  dlog(
    `🎯 breakout entry check ageMin=${fmt(ageMin(st.setupTs), 1)} nearLevelPct=${fmt(
      nearLevelPct,
      3
    )} nearEma8Pct=${fmt(nearEma8Pct, 3)} maxDist=${fmt(maxDist, 2)} score=${st.setupScore}`
  );
  dlog(
    `🎯 breakout confirm bouncePct=${fmt(
      bouncePct,
      3
    )} need=${fmt(BREAKOUT_CONFIRM_BOUNCE_PCT, 3)} aboveLevel=${aboveLevel} aboveEma8=${aboveEma8}`
  );

  if (nearLevelPct > BREAKOUT_NEAR_LEVEL_MAX_PCT && nearEma8Pct > BREAKOUT_NEAR_EMA8_MAX_PCT) {
    return { ok: false, note: "too far from breakout level" };
  }

  if (st.setupScore < BREAKOUT_MIN_SCORE) {
    if (ageMin(st.setupTs) > BREAKOUT_RETEST_MAX_MIN && st.setupScore < BREAKOUT_STALE_MIN_SCORE) {
      clearSetup(st, "breakout_score_stale");
    }
    return { ok: false, note: "breakout score low" };
  }

  // keep strict confirmation per log findings
  if (!(aboveLevel && aboveEma8 && bouncePct >= BREAKOUT_CONFIRM_BOUNCE_PCT)) {
    dlog(`🚫 no breakout confirm: price not back above level/ema8`);
    return { ok: false, note: "no breakout confirm" };
  }

  const chasePct = Math.abs(pctChange(price, st.level));
  if (chasePct > MAX_CHASE_PCT_BREAKOUT) {
    return { ok: false, note: "breakout chase too far" };
  }

  st.setupPhase = "breakout_bounce_confirmed";
  st.bouncePrice = price;
  return { ok: true, note: "breakout confirmed" };
}

function washoutEntryDecision(st, price) {
  if (st.setupType !== "washout_reclaim") return { ok: false, note: "not washout" };
  if (st.level == null) return { ok: false, note: "missing level" };

  const aboveLevel = price >= st.level ? 1 : 0;
  const chasePct = Math.abs(pctChange(price, st.level));

  dlog(
    `🎯 washout entry check: ageMin=${fmt(ageMin(st.setupTs), 1)} price=${fmt(
      price
    )} level=${fmt(st.level)} aboveLevel=${aboveLevel} chasePct=${fmt(
      chasePct,
      3
    )}% score=${st.setupScore}`
  );

  if (!aboveLevel) return { ok: false, note: "washout below level" };
  if (chasePct > MAX_CHASE_PCT_WASHOUT) return { ok: false, note: "washout chase too far" };
  if (st.setupScore < WASHOUT_MIN_SCORE) return { ok: false, note: "washout score low" };

  return { ok: true, note: "washout confirmed" };
}

// --------------------------------------------------
// 3Commas
// --------------------------------------------------
async function send3CommasSignal(st, action, price, extra = {}) {
  const botUuid = SYMBOL_BOT_MAP[st.symbol];
  if (!botUuid) return { ok: false, err: "missing bot uuid" };
  if (!C3_SIGNAL_SECRET) return { ok: false, err: "missing 3c secret" };

  const stopPrice = st.invalidation || price * 0.995;
  const sizing = computeRiskVolumePct(st, price, stopPrice);

  const comment =
    `${BRAIN_NAME}|${st.setupType || "na"}|score=${st.setupScore}|reg=${st.regime}` +
    `|riskPct=${fmt(sizing.riskPct, 2)}|riskUsd=${fmt(sizing.riskUsd, 2)}` +
    `|stopDist=${fmt(sizing.stopDistPct, 5)}|volPct=${fmt(sizing.volumePct, 2)}` +
    `|oiT=${st.oiTrend}|oiD=${st.oiDeltaBias}|cvd=${st.cvdTrend}` +
    `|liq=${st.liqClusterBelow}|drop=${st.priceDropPct}|pA=${st.patternAReady}`;

  const payload = {
    secret: C3_SIGNAL_SECRET,
    bot_uuid: botUuid,
    max_lag: String(MAX_LAG_SEC),
    timestamp: new Date().toISOString(),
    trigger_price: String(price),
    tv_exchange: st.symbol.split(":")[0] || "BINANCE",
    tv_instrument: st.symbol.split(":")[1] || st.symbol,
    action,
    comment,
    ...(action === "enter_long"
      ? {
          order: {
            amount: String(sizing.volumePct),
            currency_type: "margin_percent",
            order_type: "market",
          },
        }
      : {}),
    ...extra,
  };

  dlog(`📦 3C PAYLOAD ${JSON.stringify(payload)}`);

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), C3_TIMEOUT_MS);

    const res = await fetch(C3_SIGNAL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ac.signal,
    }).finally(() => clearTimeout(timer));

    const text = await res.text().catch(() => "");
    dlog(`📦 3C RESPONSE status=${res.status} body=${text}`);
    dlog(`📨 3Commas ${action} status=${res.status}`);
    return { ok: res.ok, status: res.status, body: text, payload };
  } catch (err) {
    dlog(`❌ 3Commas ${action} error=${err?.message || err}`);
    return { ok: false, err: err?.message || String(err) };
  }
}

// --------------------------------------------------
// Entry / exit execution
// --------------------------------------------------
async function tryEnterOnTick(st, price) {
  const gate = canEnter(st);
  if (!gate.ok) return { ok: false, note: gate.note };

  let decision = { ok: false, note: "unknown setup" };
  if (st.setupType === "breakout_pullback") {
    decision = breakoutEntryDecision(st, price);
  } else if (st.setupType === "washout_reclaim") {
    decision = washoutEntryDecision(st, price);
  }

  if (!decision.ok) return decision;

  st.enterInFlight = true;
  try {
    const stopPrice = st.invalidation || price * 0.995;
    const sizing = computeRiskVolumePct(st, price, stopPrice);

    dlog(
      `📥 ENTER ${st.symbol} ${BRAIN_NAME}|${st.setupType}|score=${st.setupScore}|reg=${st.regime}|riskPct=${fmt(
        sizing.riskPct,
        2
      )}|riskUsd=${fmt(sizing.riskUsd, 1)}|stopDist=${fmt(
        sizing.stopDistPct,
        5
      )}|volPct=${fmt(sizing.volumePct, 2)}|oiT=${st.oiTrend}|oiD=${st.oiDeltaBias}|cvd=${st.cvdTrend}|liq=${st.liqClusterBelow}|drop=${st.priceDropPct}|pA=${st.patternAReady} price=${price} sizeMult=${fmt(sizing.sizeMult, 2)} volumePercent=${fmt(sizing.volumePct, 2)}`
    );

    const sent = await send3CommasSignal(st, "enter_long", price);
    if (!sent.ok) return { ok: false, note: sent.err || "3c failed" };

    st.inPosition = true;
    st.entryPrice = price;
    st.entryTs = nowMs();
    st.peakPrice = price;
    st.stopPrice = stopPrice;
    st.trailingStop = stopPrice;
    st.lastEnterMs = nowMs();
    st.lastAction = "enter_long";

    clearSetup(st, "entered");
    return { ok: true, note: "entered" };
  } finally {
    st.enterInFlight = false;
  }
}

function updateTrailingStop(st, price) {
  if (!st.inPosition || !Number.isFinite(st.entryPrice)) return;
  if (!Number.isFinite(st.peakPrice) || price > st.peakPrice) st.peakPrice = price;

  const atrTrail =
    Number.isFinite(st.atr) && Number.isFinite(st.peakPrice)
      ? st.peakPrice - st.atr * TRAIL_ATR_MULT
      : st.stopPrice;

  const minPctTrail =
    Number.isFinite(st.peakPrice)
      ? st.peakPrice * (1 - TREND_MIN_TRAIL_PCT / 100)
      : st.stopPrice;

  const wideTrail = Math.min(atrTrail ?? Infinity, minPctTrail ?? Infinity);
  st.trailingStop = Math.max(st.stopPrice || -Infinity, wideTrail || -Infinity);
}

async function tryExitOnTick(st, price) {
  if (!st.inPosition) return { ok: false, note: "not in position" };
  if (shouldDedupeExit(st)) return { ok: false, note: "exit dedupe" };

  updateTrailingStop(st, price);

  const pnlPct = pctChange(price, st.entryPrice);
  const timeInMin = ageMin(st.entryTs);
  const belowTrail =
    Number.isFinite(st.trailingStop) && price <= st.trailingStop;
  const trendStopActive = timeInMin >= TREND_STOP_ACTIVATE_MIN;
  const weakProgress =
    timeInMin >= TREND_TIME_STOP_MIN && pnlPct < TREND_MIN_PROGRESS_PCT;

  let exitReason = "";
  if (belowTrail) exitReason = "trail_hit";
  else if (trendStopActive && st.close != null && st.ema18 != null && st.close < st.ema18)
    exitReason = "trend_lost";
  else if (weakProgress) exitReason = "time_stop";
  else if (st.raySignal === "bearish_trend_change" && st.rayFresh) exitReason = "ray_bear";

  if (!exitReason) return { ok: false, note: "hold" };

  st.exitInFlight = true;
  try {
    const sent = await send3CommasSignal(st, "exit_long", price, {
      comment: `${BRAIN_NAME}|exit|reason=${exitReason}`,
    });
    if (!sent.ok) return { ok: false, note: sent.err || "3c exit failed" };

    st.lastExitMs = nowMs();
    st.lastAction = "exit_long";
    st.cooldownUntilMs = nowMs() + COOLDOWN_SEC * 1000;
    resetPosition(st);
    clearSetup(st, "after_exit");
    dlog(
      `📤 EXIT ${st.symbol} reason=${exitReason} price=${fmt(price)} cooldownSec=${COOLDOWN_SEC}`
    );
    return { ok: true, note: exitReason };
  } finally {
    st.exitInFlight = false;
  }
}

// --------------------------------------------------
// Routes
// --------------------------------------------------
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    brain: BRAIN_NAME,
    symbols: ALLOW_SYMBOLS,
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, brain: BRAIN_NAME, ts: nowMs() });
});

app.get("/state", (req, res) => {
  const symbol = req.query.symbol;
  if (symbol && S[symbol]) return res.json({ ok: true, state: S[symbol] });
  return res.json({ ok: true, states: S });
});

app.post("/webhook", async (req, res) => {
  const body = req.body || {};
  const src = String(body.src || "").toLowerCase();

  // ---------------- TICK ----------------
  if (src === "tick") {
    if (!verifySecret(req, true)) {
      return res.status(401).json({ ok: false, err: "bad tick secret" });
    }

    const symbol = body.symbol;
    const price = n(body.price);

    if (!symbol || !Number.isFinite(price)) {
      return res.status(400).json({ ok: false, err: "bad tick payload" });
    }

    if (!SYMBOL_BOT_MAP[symbol]) {
      return res.status(400).json({ ok: false, err: "symbol not mapped" });
    }

    const st = ensureState(symbol);
    st.lastPrice = price;
    st.lastTickMs = nowMs();
    st.tickCount++;

    if (nowMs() - st.lastTickLogMs >= TICK_LOG_EVERY_MS) {
      st.lastTickLogMs = nowMs();
      dlog(
        `🟦 TICK(3m) ${symbol} price=${price} time=${new Date(st.lastTickMs).toISOString()}`
      );
    }

    if (st.tickCount % 50 === 0) {
      dlog(`🟦 LIVE TICKS ${symbol} count=${st.tickCount} px=${price}`);
    }

    if (st.inPosition) {
      const ex = await tryExitOnTick(st, price);
      return res.json({ ok: true, path: "tick-exit", result: ex });
    }

    const en = await tryEnterOnTick(st, price);
    return res.json({ ok: true, path: "tick-entry", result: en });
  }

  // ---------------- FEATURES ----------------
  if (!verifySecret(req, false)) {
    return res.status(401).json({ ok: false, err: "bad webhook secret" });
  }

  const symbol = body.symbol;
  if (!symbol) return res.status(400).json({ ok: false, err: "missing symbol" });
  if (!SYMBOL_BOT_MAP[symbol]) {
    return res.status(400).json({ ok: false, err: "symbol not mapped" });
  }

  const st = ensureState(symbol);

  dlog(`📩 WEBHOOK src=${src || "features"} signal=${body.signal || ""} symbol=${symbol}`);

  st.tf = String(body.tf || st.tf || "3");
  st.close = n(body.close ?? body.price);
  st.ema8 = n(body.ema8);
  st.ema18 = n(body.ema18);
  st.ema50 = n(body.ema50);
  st.rsi = n(body.rsi);
  st.adx = n(body.adx);
  st.atr = n(body.atr);
  st.atrPct = n(body.atrPct);

  st.heartbeat = n(body.heartbeat) || 0;
  if (st.heartbeat) st.lastHeartbeatMs = nowMs();

  st.oiTrend = n(body.oiTrend) || 0;
  st.oiDeltaBias = n(body.oiDeltaBias) || 0;
  st.cvdTrend = n(body.cvdTrend) || 0;
  st.liqClusterBelow = n(body.liqClusterBelow) || 0;
  st.priceDropPct = n(body.priceDropPct) || 0;
  st.patternAReady = n(body.patternAReady) || 0;
  st.patternAWatch = n(body.patternAWatch) || 0;

  // external signals
  st.raySignal = String(body.raySignal || st.raySignal || "");
  st.fwoSignal = String(body.fwoSignal || st.fwoSignal || "");
  const rayBuy = n(body.rayBuy) || 0;
  const raySell = n(body.raySell) || 0;
  const fwo = n(body.fwo) || 0;

  if (rayBuy) st.lastRayBullMs = nowMs();
  if (raySell) st.lastRayBearMs = nowMs();
  if (fwo > 0) st.lastFwoBullMs = nowMs();
  if (fwo < 0) st.lastFwoBearMs = nowMs();

  computeSignalFreshness(st);

  st.barsSeen += 1;
  updateCloseHistory(st, st.close);

  dlog(
    `🟩 FEAT rx ${symbol} close=${st.close} ema8=${st.ema8} ema18=${st.ema18} ema50=${st.ema50} rsi=${st.rsi} atr=${st.atr} atrPct=${st.atrPct} adx=${st.adx} oiTrend=${st.oiTrend} oiDeltaBias=${st.oiDeltaBias} cvdTrend=${st.cvdTrend} liqClusterBelow=${st.liqClusterBelow} priceDropPct=${st.priceDropPct} patternAReady=${st.patternAReady} patternAWatch=${st.patternAWatch}`
  );

  const rg = computeRegime(st);
  st.regime = rg.mode;
  st.regimeConf = rg.conf;

  dlog(`🧭 REGIME ${symbol} mode=${st.regime} conf=${st.regimeConf}`);

  manageSetupLifecycle(st);

  if (!st.armed && !st.inPosition) {
    maybeArmSetup(st);
  } else {
    dlog(
      `📌 STATE ${symbol} reg=${st.regime} armed=${st.armed ? 1 : 0} type=${st.setupType} setupAgeMin=${st.armed ? fmt(ageMin(st.setupTs), 1) : 0} score=${st.setupScore} inPos=${st.inPosition ? 1 : 0} cooldown=${inCooldown(st) ? 1 : 0} rayFresh=${st.rayFresh} fwoFresh=${st.fwoFresh}`
    );
  }

  return res.json({
    ok: true,
    symbol,
    regime: st.regime,
    regimeConf: st.regimeConf,
    armed: st.armed,
    setupType: st.setupType,
    setupScore: st.setupScore,
    inPosition: st.inPosition,
    barsSeen: st.barsSeen,
  });
});

app.post("/tv", async (req, res) => {
  req.body = req.body || {};
  if (!req.body.src) req.body.src = "features";
  return app._router.handle(req, res, () => {});
});

// --------------------------------------------------
// Start
// --------------------------------------------------
app.listen(PORT, () => {
  console.log(`✅ ${BRAIN_NAME} listening on :${PORT}`);
  console.log(`🧭 SYMBOL_BOT_MAP keys=${ALLOW_SYMBOLS.length}`);
  console.log(`🐛 DEBUG=${DEBUG ? 1 : 0}`);
  console.log(`📚 MIN_BARS_FOR_SETUPS=${MIN_BARS_FOR_SETUPS}`);
  console.log(`🧾 TICK_LOG_EVERY_MS=${TICK_LOG_EVERY_MS}`);
  console.log(`🕒 RAY_SIGNAL_TTL_MS=${RAY_SIGNAL_TTL_MS}`);
  console.log(`🕒 FWO_SIGNAL_TTL_MS=${FWO_SIGNAL_TTL_MS}`);
  console.log(`⏱️ BREAKOUT_MAX_AGE_MIN=${BREAKOUT_MAX_AGE_MIN}`);
  console.log(`📏 BREAKOUT_STALE_MIN_SCORE=${BREAKOUT_STALE_MIN_SCORE}`);
  console.log(`⏱️ BREAKOUT_RETEST_MAX_MIN=${BREAKOUT_RETEST_MAX_MIN}`);
  console.log(`⏱️ WASHOUT_MAX_AGE_MIN=${WASHOUT_MAX_AGE_MIN}`);
  console.log(`💰 BOT_MAX_NOTIONAL_USDT=${BOT_MAX_NOTIONAL_USDT}`);
  console.log(`🛡️ BASE_RISK_PCT=${BASE_RISK_PCT}`);
  console.log(`🛡️ MIN_RISK_PCT=${MIN_RISK_PCT}`);
  console.log(`🛡️ MAX_RISK_PCT=${MAX_RISK_PCT}`);
  console.log(`⏳ TREND_STOP_ACTIVATE_MIN=${TREND_STOP_ACTIVATE_MIN}`);
  console.log(`📉 TREND_MIN_TRAIL_PCT=${TREND_MIN_TRAIL_PCT}`);
  console.log(`⏳ TREND_TIME_STOP_MIN=${TREND_TIME_STOP_MIN}`);
  console.log(`📉 TREND_MIN_PROGRESS_PCT=${TREND_MIN_PROGRESS_PCT}`);
  console.log(`✅ BREAKOUT_CONFIRM_BOUNCE_PCT=${BREAKOUT_CONFIRM_BOUNCE_PCT}`);
});
