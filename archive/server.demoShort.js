/**
 * Brain v3.4 — Breakout Confirmation Entry + Better Trend Exit
 * ✅ No external OI API
 * ✅ Duplicate enter/exit protection
 * ✅ Tick path only handles execution timing
 * ✅ Features path handles regime/setup/scoring
 * ✅ TV-derived flow:
 *    - oiTrend
 *    - oiDeltaBias
 *    - cvdTrend
 * ✅ Pattern A fields:
 *    - liqClusterBelow
 *    - priceDropPct
 *    - patternAReady
 *    - patternAWatch
 * ✅ Breakout confirmation entry:
 *    breakout -> retest -> bounce -> enter
 * ✅ Trend stop delay
 * ✅ Trend stop uses wider of:
 *    - ATR trail
 *    - minimum % trail
 * ✅ Score-based amount table
 * ✅ Adaptive breakout entry distance by ATR
 */

import express from "express";

// ---------------------------
// Config
// ---------------------------
const PORT = process.env.PORT || 8080;

// Debug toggle
const DEBUG = (process.env.DEBUG || "1") === "1";
function dlog(...args) { if (DEBUG) console.log(...args); }

// Tick log throttling
const TICK_LOG_EVERY_MS = parseInt(
  process.env.TICK_LOG_EVERY_MS || String(3 * 60 * 1000),
  10
);

// Signal freshness TTLs
const RAY_SIGNAL_TTL_MS = parseInt(process.env.RAY_SIGNAL_TTL_MS || String(10 * 60 * 1000), 10);
const FWO_SIGNAL_TTL_MS = parseInt(process.env.FWO_SIGNAL_TTL_MS || String(10 * 60 * 1000), 10);

// Setup aging
const BREAKOUT_MAX_AGE_MIN = parseInt(process.env.BREAKOUT_MAX_AGE_MIN || "12", 10);
const BREAKOUT_STALE_MIN_SCORE = parseInt(process.env.BREAKOUT_STALE_MIN_SCORE || "5", 10);
const WASHOUT_MAX_AGE_MIN = parseInt(process.env.WASHOUT_MAX_AGE_MIN || "12", 10);

// Reject log throttling
const NO_ENTER_LOG_EVERY_MS = parseInt(process.env.NO_ENTER_LOG_EVERY_MS || "60000", 10);

// Trend stop delay
const TREND_STOP_ACTIVATE_MIN = parseInt(process.env.TREND_STOP_ACTIVATE_MIN || "9", 10);

// Trend minimum trailing %
const TREND_MIN_TRAIL_PCT = parseFloat(process.env.TREND_MIN_TRAIL_PCT || "0.5");

// Breakout confirmation bounce %
const BREAKOUT_CONFIRM_BOUNCE_PCT = parseFloat(process.env.BREAKOUT_CONFIRM_BOUNCE_PCT || "0.08");

// Breakout minimum ADX
const BREAKOUT_MIN_ADX = parseFloat(process.env.BREAKOUT_MIN_ADX || "20");

// Entry score tuning
const BREAKOUT_MIN_SCORE = parseInt(process.env.BREAKOUT_MIN_SCORE || "7", 10);
const WASHOUT_MIN_SCORE = parseInt(process.env.WASHOUT_MIN_SCORE || "6", 10);

// Secrets
const BRAIN_SECRET = process.env.WEBHOOK_SECRET || "";
const TICKROUTER_SECRET = process.env.TICKROUTER_SECRET || "";

// 3Commas
const C3_SIGNAL_URL =
  process.env.C3_SIGNAL_URL || "https://api.3commas.io/signal_bots/webhooks";
const C3_SIGNAL_SECRET = process.env.C3_SIGNAL_SECRET || "";
const C3_TIMEOUT_MS = parseInt(process.env.C3_TIMEOUT_MS || "8000", 10);
const MAX_LAG_SEC = parseInt(process.env.MAX_LAG_SEC || "300", 10);

// Routing: symbol -> bot_uuid
let SYMBOL_BOT_MAP = {};
try {
  SYMBOL_BOT_MAP = JSON.parse(process.env.SYMBOL_BOT_MAP || "{}");
} catch (e) {
  console.error("❌ SYMBOL_BOT_MAP invalid JSON:", e?.message || e);
  SYMBOL_BOT_MAP = {};
}

// Decision tuning
const TICK_MAX_AGE_SEC = parseInt(process.env.TICK_MAX_AGE_SEC || "60", 10);
const SETUP_TTL_SEC = parseInt(process.env.SETUP_TTL_SEC || "1800", 10);
const COOLDOWN_SEC = parseInt(process.env.COOLDOWN_SEC || "180", 10);

const SCORE_ENTER_SMALL = parseInt(process.env.SCORE_ENTER_SMALL || "6", 10);
const SCORE_ENTER_FULL = parseInt(process.env.SCORE_ENTER_FULL || "7", 10);

const PUMP_BLOCK_PCT = parseFloat(process.env.PUMP_BLOCK_PCT || "1.8");
const PUMP_BLOCK_WINDOW_BARS = parseInt(process.env.PUMP_BLOCK_WINDOW_BARS || "3", 10);

const ENTER_DEDUP_MS = parseInt(process.env.ENTER_DEDUP_MS || "60000", 10);
const EXIT_DEDUP_MS = parseInt(process.env.EXIT_DEDUP_MS || "30000", 10);

// ---------------------------
// Risk-based sizing
// ---------------------------
const BOT_MAX_NOTIONAL_USDT = parseFloat(process.env.BOT_MAX_NOTIONAL_USDT || "10000");

// Adaptive risk bounds as % of bot allocation
const BASE_RISK_PCT = parseFloat(process.env.BASE_RISK_PCT || "0.35");
const MIN_RISK_PCT = parseFloat(process.env.MIN_RISK_PCT || "0.20");
const MAX_RISK_PCT = parseFloat(process.env.MAX_RISK_PCT || "0.70");

// Optional score sizing
const USE_SCORE_SIZE_MULT = (process.env.USE_SCORE_SIZE_MULT || "1") === "1";

// Safety caps on webhook volume %
const MIN_VOLUME_PCT = parseFloat(process.env.MIN_VOLUME_PCT || "10");
const MAX_VOLUME_PCT = parseFloat(process.env.MAX_VOLUME_PCT || "100");

// ---------------------------
// App
// ---------------------------
const app = express();
app.use(express.json({ limit: "512kb" }));

// ---------------------------
// State
// ---------------------------
const state = new Map();

function nowMs() { return Date.now(); }

function n(x, fallback = null) {
  const v = Number(x);
  return Number.isFinite(v) ? v : fallback;
}

function recently(ts, windowMs) {
  return ts > 0 && (nowMs() - ts) < windowMs;
}

function tvParts(symbol) {
  const [ex, inst] = symbol.includes(":") ? symbol.split(":") : ["BINANCE", symbol];
  return { tv_exchange: ex || "BINANCE", tv_instrument: inst || symbol };
}

function botUuidForSymbol(symbol) {
  return SYMBOL_BOT_MAP?.[symbol] || null;
}

function signalFresh(ts, ttlMs) {
  return ts > 0 && (nowMs() - ts) < ttlMs;
}

function setupAgeMin(setup) {
  if (!setup?.armedMs) return 0;
  return (nowMs() - setup.armedMs) / 60000;
}

function logNoEnter(s, msg) {
  const now = nowMs();
  if (s.lastNoEnterReason !== msg || (now - (s.lastNoEnterLogMs || 0)) >= NO_ENTER_LOG_EVERY_MS) {
    dlog(msg);
    s.lastNoEnterReason = msg;
    s.lastNoEnterLogMs = now;
  }
}

function ensureSymbol(symbol) {
  if (!state.has(symbol)) {
    state.set(symbol, {
      lastTickMs: 0,
      lastPrice: null,
      tickCount: 0,
      lastTickLogMs: 0,

      bars: [],
      regime: { mode: "unknown", confidence: 0 },

      setup: {
        armed: false,
        setupType: null,
        armedMs: 0,
        ttlMs: SETUP_TTL_SEC * 1000,
        score: 0,
        invalidationPrice: null,
        level: null,

        // washout memory
        lastWashoutInv: null,
        lastWashoutArmMs: 0,

        // breakout confirmation state
        retestSeen: false,
        retestSeenMs: 0,
        retestPrice: null,
      },

      position: {
        inPosition: false,
        entry: null,
        peak: null,
        stop: null,
        sizeMult: 0,
        volumePercent: 0,
        adaptiveRiskPct: 0,
        enteredMs: 0,
      },

      cooldownUntilMs: 0,

      signals: {
        lastRayBuyMs: 0,
        lastRayBuySignal: "",
        lastFwoBuyMs: 0,
        lastFwoBuySignal: "",
      },

      orderLock: {
        enterInFlight: false,
        exitInFlight: false,
        lastEnterMs: 0,
        lastExitMs: 0,
      },

      lastNoEnterReason: "",
      lastNoEnterLogMs: 0,
    });
  }
  return state.get(symbol);
}

function pruneBars(s, maxBars = 800) {
  if (s.bars.length > maxBars) s.bars.splice(0, s.bars.length - maxBars);
}

function isInCooldown(s) {
  return nowMs() < s.cooldownUntilMs;
}

function startCooldown(s, reason) {
  s.cooldownUntilMs = nowMs() + COOLDOWN_SEC * 1000;
  console.log(`⏳ Cooldown ${COOLDOWN_SEC}s reason=${reason}`);
}

function clearSetup(s, why) {
  if (s.setup.armed) console.log(`🧹 Setup cleared (${why}) type=${s.setup.setupType}`);
  s.setup.armed = false;
  s.setup.setupType = null;
  s.setup.armedMs = 0;
  s.setup.score = 0;
  s.setup.invalidationPrice = null;
  s.setup.level = null;
  s.setup.retestSeen = false;
  s.setup.retestSeenMs = 0;
  s.setup.retestPrice = null;
}

function canUseTick(s) {
  return s.lastPrice != null && (nowMs() - s.lastTickMs) <= TICK_MAX_AGE_SEC * 1000;
}

// ---------------------------
// Engines
// ---------------------------
function computeRegime(lastBar) {
  const ema8 = lastBar.ema8, ema18 = lastBar.ema18, ema50 = lastBar.ema50;
  const adx = lastBar.adx, atrPct = lastBar.atrPct;

  let score = 0;
  if (ema8 != null && ema18 != null && ema50 != null) {
    if (ema8 > ema18 && ema18 > ema50) score += 2;
    const spread = (ema8 - ema50) / ema50;
    if (spread > 0.003) score += 1;
  }
  if (adx != null && adx >= 18) score += 1;
  if (atrPct != null && atrPct >= 0.5) score += 1;

  if (score >= 4) return { mode: "trend", confidence: 0.8 };
  if (score >= 3) return { mode: "trend", confidence: 0.6 };
  if (score >= 2) return { mode: "range", confidence: 0.55 };
  return { mode: "range", confidence: 0.4 };
}

function detectSetups(s) {
  if (s.position.inPosition) return;
  if (s.setup.armed) return;

  const bars = s.bars;
  if (bars.length < 20) {
    dlog(`⏳ detectSetups waiting bars=${bars.length}/20`);
    return;
  }

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];

  // Setup A: Washout -> Reclaim
  const lookback = 20;
  let localLow = Infinity;
  for (let i = bars.length - lookback; i < bars.length; i++) {
    if (i < 0) continue;
    localLow = Math.min(localLow, bars[i].low);
  }

  const canUseEma = (last.ema18 != null && prev.ema18 != null);
  const wasBelowEma18 = canUseEma ? (prev.close < prev.ema18) : false;
  const reclaimed = canUseEma ? (last.close > last.ema18 && wasBelowEma18) : false;
  const washout = (last.ema50 != null) ? (localLow < last.ema50 * 0.995) : false;
  const rsiUp = (last.rsi != null && prev.rsi != null) ? (last.rsi > prev.rsi) : false;

  dlog(
    `🔎 SETUPCHK localLow=${Number.isFinite(localLow) ? localLow.toFixed(4) : localLow} ` +
    `ema50=${last.ema50 != null ? last.ema50.toFixed(4) : "null"} ` +
    `washout=${washout ? 1 : 0} reclaimed=${reclaimed ? 1 : 0} rsiUp=${rsiUp ? 1 : 0}`
  );

  if (washout && reclaimed && rsiUp) {
    const candidateInv = localLow * 0.999;
    const recentlyArmedSameWashout =
      s.setup.lastWashoutInv != null &&
      Math.abs(candidateInv - s.setup.lastWashoutInv) / s.setup.lastWashoutInv < 0.0015 &&
      (nowMs() - (s.setup.lastWashoutArmMs || 0)) < 20 * 60 * 1000;

    if (recentlyArmedSameWashout) {
      dlog(`🚫 skip washout re-arm: same invalidation recently used inv=${candidateInv}`);
      return;
    }

    s.setup.armed = true;
    s.setup.setupType = "washout_reclaim";
    s.setup.armedMs = nowMs();
    s.setup.invalidationPrice = candidateInv;
    s.setup.level = last.ema18;

    s.setup.lastWashoutInv = candidateInv;
    s.setup.lastWashoutArmMs = nowMs();

    console.log(`🟡 Armed washout_reclaim inv=${s.setup.invalidationPrice}`);
    return;
  }

  // Setup B: Breakout -> Pullback
  if (s.regime.mode === "trend") {
    const swingLb = 30;
    let swingHigh = -Infinity;
    for (let i = bars.length - swingLb; i < bars.length - 1; i++) {
      if (i < 0) continue;
      swingHigh = Math.max(swingHigh, bars[i].high);
    }
    const breakout = last.close > swingHigh;

    dlog(`🔎 BRKCHK swingHigh=${Number.isFinite(swingHigh) ? swingHigh.toFixed(4) : swingHigh} breakout=${breakout ? 1 : 0}`);

    if (breakout) {
      s.setup.armed = true;
      s.setup.setupType = "breakout_pullback";
      s.setup.armedMs = nowMs();
      s.setup.level = swingHigh;
      s.setup.invalidationPrice = (last.ema50 != null) ? (last.ema50 * 0.995) : null;

      s.setup.retestSeen = false;
      s.setup.retestSeenMs = 0;
      s.setup.retestPrice = null;

      console.log(`🟡 Armed breakout_pullback level=${s.setup.level}`);
      return;
    }
  }
}

function expireSetup(s) {
  if (!s.setup.armed) return;

  const ageMs = nowMs() - s.setup.armedMs;
  if (ageMs > s.setup.ttlMs) {
    dlog(`⌛ Setup TTL expired ageSec=${(ageMs / 1000).toFixed(0)}`);
    clearSetup(s, "ttl");
    return;
  }

  const ageMin = setupAgeMin(s.setup);

  if (s.setup.setupType === "breakout_pullback" && ageMin > BREAKOUT_MAX_AGE_MIN) {
    dlog(`⌛ Breakout setup stale ageMin=${ageMin.toFixed(1)} > ${BREAKOUT_MAX_AGE_MIN}`);
    clearSetup(s, "breakout_stale");
    return;
  }

  if (s.setup.setupType === "washout_reclaim" && ageMin > WASHOUT_MAX_AGE_MIN) {
    dlog(`⌛ Washout setup stale ageMin=${ageMin.toFixed(1)} > ${WASHOUT_MAX_AGE_MIN}`);
    clearSetup(s, "washout_stale");
    return;
  }

  if (s.setup.armed && s.setup.setupType === "washout_reclaim" && s.bars.length >= 2) {
    const last = s.bars[s.bars.length - 1];
    const prev = s.bars[s.bars.length - 2];

    const badFlowNow = last.cvdTrend === -1 && last.oiDeltaBias <= 0;
    const badFlowPrev = prev.cvdTrend === -1 && prev.oiDeltaBias <= 0;

    if (badFlowNow && badFlowPrev) {
      dlog("⌛ Washout setup cleared: bearish flow persisted 2 bars");
      clearSetup(s, "washout_bad_flow");
      return;
    }
  }
}

function scoreSetup(s) {
  if (!s.setup.armed) return 0;
  const bars = s.bars;
  if (bars.length < 3) return 0;

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];

  let score = 0;
  const add = (nn, label) => {
    score += nn;
    dlog(`   ➕ ${label} +${nn} => ${score}`);
  };

  const rayFresh = signalFresh(s.signals.lastRayBuyMs, RAY_SIGNAL_TTL_MS);
  const fwoFresh = signalFresh(s.signals.lastFwoBuyMs, FWO_SIGNAL_TTL_MS);

  dlog(
    `🧠 SIGNAL TTL rayFresh=${rayFresh ? 1 : 0} ` +
    `fwoFresh=${fwoFresh ? 1 : 0} ` +
    `raySignal=${s.signals.lastRayBuySignal || ""} ` +
    `fwoSignal=${s.signals.lastFwoBuySignal || ""}`
  );

  if (s.regime.mode === "trend") add(Math.round(3 * s.regime.confidence), "regime(trend)");
  else add(Math.round(2 * s.regime.confidence), "regime(range)");

  if (last.atrPct != null) {
    if (last.atrPct >= 0.6) add(2, "atrPct>=0.6");
    else if (last.atrPct >= 0.4) add(1, "atrPct>=0.4");
  }

  if (last.rsi != null && prev.rsi != null && last.rsi > prev.rsi) add(1, "rsi rising");

  if (rayFresh) {
    if (s.signals.lastRayBuySignal === "bullish_trend_change") add(3, "fresh ray trend change");
    else if (s.signals.lastRayBuySignal === "bullish_bos") add(2, "fresh ray bos");
    else add(2, "fresh ray_buy");
  }

  if (fwoFresh) {
    if (s.signals.lastFwoBuySignal === "sniper_buy") add(2, "fresh fwo sniper");
    else add(2, "fresh fwo_buy");
  }

  if (last.oiTrend === 1) add(1, "oi trend up");
  if (last.oiDeltaBias === 1) add(1, "oi expansion");
  if (last.cvdTrend === 1) add(1, "cvd bullish");

  if (last.oiDeltaBias === -1) {
    score -= 1;
    dlog(`   ➖ oi contraction -1 => ${score}`);
  }

  if (last.cvdTrend === -1) {
    score -= 2;
    dlog(`   ➖ cvd bearish -2 => ${score}`);
  }

  // Pattern A / flush helpers
  if (last.liqClusterBelow === 1) add(1, "liq cluster below");
  if (last.priceDropPct <= -0.35) add(1, "flush down");
  if (last.patternAWatch === 1) add(1, "pattern A watch");
  if (last.patternAReady === 1) add(2, "pattern A ready");

  const nBars = PUMP_BLOCK_WINDOW_BARS;
  if (bars.length > nBars) {
    const past = bars[bars.length - 1 - nBars];
    const movePct = ((last.close - past.close) / past.close) * 100;
    if (movePct > PUMP_BLOCK_PCT) {
      score -= 3;
      dlog(`   ➖ pump penalty -3 => ${score}`);
    }
  }

  score = Math.max(0, Math.min(10, score));
  s.setup.score = score;
  dlog(`📊 SCORE final=${score}`);
  return score;
}

// ---------------------------
// Adaptive risk + size helpers
// ---------------------------
function scoreTargetAmountPct(score) {
  if (!USE_SCORE_SIZE_MULT) return 100;
  if (score >= 10) return 100;
  if (score >= 9) return 90;
  if (score >= 8) return 80;
  if (score >= 7) return 60;
  if (score >= 6) return 40;
  return 0;
}

function computeAdaptiveRiskPct(s, lastBar) {
  const atrPct = lastBar?.atrPct ?? 0;
  const adx = lastBar?.adx ?? 0;
  const regime = s.regime.mode;

  let risk = BASE_RISK_PCT;

  if (atrPct < 0.15) risk -= 0.2;
  else if (atrPct > 0.60) risk += 0.2;
  else if (atrPct > 0.35) risk += 0.1;

  if (regime === "trend" && adx > 22) risk += 0.2;
  if (regime === "range" && adx < 18) risk -= 0.1;

  risk = Math.max(MIN_RISK_PCT, Math.min(MAX_RISK_PCT, risk));
  return Math.round(risk * 1000) / 1000;
}

function computeRiskBasedSize(s, entryPrice) {
  const lastBar = s.bars[s.bars.length - 1];
  const stop = s.setup.invalidationPrice;

  if (!entryPrice || !stop || entryPrice <= stop) {
    return { sizeMult: 0, volumePercent: 0, riskUsd: 0, stopDistance: 0, adaptiveRiskPct: 0, targetAmountPct: 0 };
  }

  const adaptiveRiskPct = computeAdaptiveRiskPct(s, lastBar);
  const stopDistance = entryPrice - stop;
  const riskUsdBase = BOT_MAX_NOTIONAL_USDT * (adaptiveRiskPct / 100.0);

  const qty = riskUsdBase / stopDistance;
  const notionalUsd = qty * entryPrice;

  let riskBasedVolumePercent = (notionalUsd / BOT_MAX_NOTIONAL_USDT) * 100.0;
  const targetAmountPct = scoreTargetAmountPct(s.setup.score);

  let volumePercent = Math.min(riskBasedVolumePercent, targetAmountPct);
  volumePercent = Math.max(MIN_VOLUME_PCT, Math.min(MAX_VOLUME_PCT, volumePercent));

  const sizeMult = volumePercent / 100.0;

  return {
    sizeMult: Math.round(sizeMult * 1000) / 1000,
    volumePercent: Math.round(volumePercent * 100) / 100,
    targetAmountPct,
    riskUsd: Math.round(riskUsdBase * 100) / 100,
    stopDistance: Math.round(stopDistance * 100000) / 100000,
    adaptiveRiskPct,
  };
}

function breakoutMaxDistPct(last) {
  if ((last.atrPct ?? 0) >= 0.25) return 0.35;
  if ((last.atrPct ?? 0) >= 0.18) return 0.28;
  return 0.20;
}

function shouldEnter(s) {
  if (!s.setup.armed) return false;
  if (s.position.inPosition) return false;
  if (isInCooldown(s)) return false;
  if (!canUseTick(s)) return false;
  if (s.orderLock.enterInFlight) return false;
  if (recently(s.orderLock.lastEnterMs, ENTER_DEDUP_MS)) return false;

  const price = s.lastPrice;
  const last = s.bars[s.bars.length - 1];
  const ageMin = setupAgeMin(s.setup);

  if (s.setup.invalidationPrice != null && price <= s.setup.invalidationPrice) {
    clearSetup(s, "invalidation");
    return false;
  }

  // Hard flow filter
  if (last.cvdTrend === -1 && last.oiDeltaBias <= 0) {
    logNoEnter(s, "🚫 no enter: bearish flow + no oi expansion");
    return false;
  }

  if (s.setup.setupType === "washout_reclaim" && ageMin > WASHOUT_MAX_AGE_MIN) {
    dlog(`🚫 no washout enter: setup stale ageMin=${ageMin.toFixed(1)} > ${WASHOUT_MAX_AGE_MIN}`);
    clearSetup(s, "washout_stale");
    return false;
  }

  if (s.setup.setupType === "washout_reclaim") {
    if (s.setup.score < WASHOUT_MIN_SCORE) {
      logNoEnter(s, `🚫 no enter: score ${s.setup.score} < ${WASHOUT_MIN_SCORE}`);
      return false;
    }

    const level = s.setup.level ?? last.ema18;
    if (!level) {
      logNoEnter(s, "🚫 no enter: missing washout level");
      return false;
    }

    if (s.regime.mode === "range") {
      if (!(last.cvdTrend === 1 && last.oiDeltaBias === 1)) {
        logNoEnter(s, "🚫 no washout enter: range mode requires bullish flow confirmation");
        return false;
      }
    }

    const chasePct = ((price - level) / level) * 100;

    dlog(
      `🎯 washout entry check: ` +
      `ageMin=${ageMin.toFixed(1)} ` +
      `price=${price} level=${level} ` +
      `aboveLevel=${price > level ? 1 : 0} ` +
      `chasePct=${chasePct.toFixed(3)}% ` +
      `score=${s.setup.score}`
    );

    if (!(price > level)) {
      logNoEnter(s, "🚫 no enter: price not above reclaim level");
      return false;
    }

    if (!(chasePct <= 0.25)) {
      logNoEnter(s, "🚫 no enter: chasePct too high");
      return false;
    }

    return true;
  }

  if (s.setup.setupType === "breakout_pullback") {
    const level = s.setup.level;
    if (!level || last.ema8 == null) {
      logNoEnter(s, "🚫 no breakout enter: missing level or ema8");
      return false;
    }

    if (s.setup.score < BREAKOUT_MIN_SCORE) {
      logNoEnter(s, `🚫 no breakout enter: score ${s.setup.score} < ${BREAKOUT_MIN_SCORE}`);
      return false;
    }

    if ((last.adx ?? 0) < BREAKOUT_MIN_ADX) {
      logNoEnter(s, `🚫 breakout rejected: ADX ${last.adx} < ${BREAKOUT_MIN_ADX}`);
      return false;
    }

    if ((last.atrPct ?? 0) < 0.15) {
      logNoEnter(s, "🚫 no breakout enter: atrPct too low");
      return false;
    }

    const nearLevelPct = Math.abs((price - level) / level) * 100;
    const nearEma8Pct = Math.abs((price - last.ema8) / last.ema8) * 100;
    const maxEntryDistPct = breakoutMaxDistPct(last);

    dlog(
      `🎯 breakout entry check ` +
      `ageMin=${ageMin.toFixed(1)} ` +
      `nearLevelPct=${nearLevelPct.toFixed(3)} ` +
      `nearEma8Pct=${nearEma8Pct.toFixed(3)} ` +
      `maxDist=${maxEntryDistPct.toFixed(2)} ` +
      `score=${s.setup.score}`
    );

    if (ageMin > BREAKOUT_MAX_AGE_MIN) {
      dlog(`🚫 no breakout enter: setup stale ageMin=${ageMin.toFixed(1)} > ${BREAKOUT_MAX_AGE_MIN}`);
      clearSetup(s, "breakout_stale");
      return false;
    }

    if (ageMin > Math.max(3, BREAKOUT_MAX_AGE_MIN * 0.5) && s.setup.score < BREAKOUT_STALE_MIN_SCORE) {
      logNoEnter(
        s,
        `🚫 no breakout enter: aged setup needs higher score score=${s.setup.score} < ${BREAKOUT_STALE_MIN_SCORE}`
      );
      return false;
    }

    // Breakout confirmation step 1:
    // wait for retest zone touch first, do not enter immediately
    if (!s.setup.retestSeen) {
      if ((nearLevelPct <= maxEntryDistPct) || (nearEma8Pct <= maxEntryDistPct)) {
        s.setup.retestSeen = true;
        s.setup.retestSeenMs = nowMs();
        s.setup.retestPrice = price;
        dlog(`✅ breakout retest seen price=${price} level=${level} ema8=${last.ema8}`);
      } else {
        logNoEnter(s, "🚫 no breakout enter: too far from level/ema8");
      }
      return false;
    }

    // Breakout confirmation step 2:
    // after retest, require bounce confirmation
    const bounceRef = s.setup.retestPrice ?? price;
    const bouncePct = ((price - bounceRef) / bounceRef) * 100;
    const aboveLevel = price >= level;
    const aboveEma8 = price >= last.ema8;

    dlog(
      `🎯 breakout confirm ` +
      `bouncePct=${bouncePct.toFixed(3)} ` +
      `need=${BREAKOUT_CONFIRM_BOUNCE_PCT.toFixed(3)} ` +
      `aboveLevel=${aboveLevel ? 1 : 0} aboveEma8=${aboveEma8 ? 1 : 0}`
    );

    if (!(aboveLevel && aboveEma8)) {
      logNoEnter(s, "🚫 no breakout confirm: price not back above level/ema8");
      return false;
    }

    if (!(bouncePct >= BREAKOUT_CONFIRM_BOUNCE_PCT)) {
      logNoEnter(s, "🚫 no breakout confirm: bounce too small");
      return false;
    }

    return true;
  }

  return false;
}

// ---------------------------
// Regime-aware exit logic
// ---------------------------
function exitCheck(s) {
  if (!s.position.inPosition) return null;
  if (!canUseTick(s)) return null;
  if (s.orderLock.exitInFlight) return null;
  if (recently(s.orderLock.lastExitMs, EXIT_DEDUP_MS)) return null;

  const price = s.lastPrice;
  const last = s.bars[s.bars.length - 1];
  const entry = s.position.entry ?? price;

  s.position.peak = Math.max(s.position.peak ?? entry, price);

  const pnlPct = ((price - entry) / entry) * 100;
  const atr = last.atr ?? 0;
  const minsInTrade = (nowMs() - (s.position.enteredMs || nowMs())) / 60000;

  const shouldLogExitCheck =
    price <= (s.position.stop ?? -Infinity) ||
    (s.regime.mode === "range" && pnlPct >= 0.35) ||
    (s.regime.mode === "trend" && last.ema8 != null && last.ema18 != null && last.ema8 < last.ema18);

  if (shouldLogExitCheck) {
    dlog(
      `🛡️ EXITCHK price=${price} entry=${entry} peak=${s.position.peak} ` +
      `stop=${s.position.stop} pnlPct=${pnlPct.toFixed(3)} reg=${s.regime.mode}`
    );
  }

  if (s.regime.mode === "trend") {
    let trendTrailMult = 2.4;
    if ((last.atrPct ?? 0) < 0.10) trendTrailMult = 3.2;
    else if ((last.atrPct ?? 0) < 0.15) trendTrailMult = 2.8;

    if (atr > 0 && s.position.peak != null) {
      const atrStop = s.position.peak - atr * trendTrailMult;
      const pctStop = s.position.peak * (1 - TREND_MIN_TRAIL_PCT / 100.0);
      const newStop = Math.max(atrStop, pctStop); // wider stop
      if (s.position.stop == null || newStop > s.position.stop) s.position.stop = newStop;
    }

    if (last.ema8 != null && last.ema18 != null && last.ema8 < last.ema18) {
      return "trend_fail_ema_cross";
    }

    const trendStopActive = minsInTrade >= TREND_STOP_ACTIVATE_MIN;
    if (trendStopActive && s.position.stop != null && price <= s.position.stop) {
      return "atr_trail_stop_trend";
    }
  } else {
    if (atr > 0 && s.position.peak != null) {
      const rangeTrailMult = 1.3;
      const newStop = s.position.peak - atr * rangeTrailMult;
      if (s.position.stop == null || newStop > s.position.stop) s.position.stop = newStop;
    }

    if (pnlPct >= 0.35) {
      return "range_take_profit";
    }

    if (s.position.stop != null && price <= s.position.stop) {
      return "atr_trail_stop_range";
    }
  }

  if (s.regime.mode === "range") {
    if (minsInTrade >= 30 && pnlPct < 0.10) {
      return "time_stop_no_progress";
    }
  }

  return null;
}

// ---------------------------
// 3Commas sender
// ---------------------------
async function post3C({ action, symbol, price, comment, volumePercent = null }) {
  if (!C3_SIGNAL_SECRET) throw new Error("Missing C3_SIGNAL_SECRET");

  const bot_uuid = botUuidForSymbol(symbol);
  if (!bot_uuid) throw new Error(`No bot_uuid mapping for symbol=${symbol}`);

  const { tv_exchange, tv_instrument } = tvParts(symbol);

  const payload = {
    secret: C3_SIGNAL_SECRET,
    bot_uuid,
    max_lag: String(MAX_LAG_SEC),
    timestamp: new Date().toISOString(),
    trigger_price: String(price),
    tv_exchange,
    tv_instrument,
    action,
    comment,
  };

  if (volumePercent != null && action === "enter_long") {
    payload.order = {
      amount: String(volumePercent),
      currency_type: "margin_percent",
      order_type: "market",
    };
  }

  dlog(`📦 3C PAYLOAD ${JSON.stringify(payload)}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), C3_TIMEOUT_MS);

  try {
    const resp = await fetch(C3_SIGNAL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const body = await resp.text();
    dlog(`📦 3C RESPONSE status=${resp.status} body=${body}`);
    return { status: resp.status, body, payload };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------
// Main decision runner
// ---------------------------
async function runDecision(symbol, source) {
  const s = ensureSymbol(symbol);
  if (s.bars.length < 3) return;

  const lastBar = s.bars[s.bars.length - 1];

  if (source === "features") {
    s.regime = computeRegime(lastBar);
    dlog(`🧭 REGIME ${symbol} mode=${s.regime.mode} conf=${s.regime.confidence}`);
    expireSetup(s);
    detectSetups(s);
    scoreSetup(s);

    dlog(
      `📌 STATE ${symbol} ` +
      `reg=${s.regime.mode} armed=${s.setup.armed ? 1 : 0} type=${s.setup.setupType || ""} ` +
      `setupAgeMin=${s.setup.armed ? setupAgeMin(s.setup).toFixed(1) : 0} ` +
      `score=${s.setup.score} inPos=${s.position.inPosition ? 1 : 0} cooldown=${isInCooldown(s) ? 1 : 0} ` +
      `rayFresh=${signalFresh(s.signals.lastRayBuyMs, RAY_SIGNAL_TTL_MS) ? 1 : 0} ` +
      `fwoFresh=${signalFresh(s.signals.lastFwoBuyMs, FWO_SIGNAL_TTL_MS) ? 1 : 0}`
    );
  }

  const exitReason = exitCheck(s);
  if (exitReason) {
    const price = s.lastPrice ?? lastBar.close;

    if (s.orderLock.exitInFlight) return;
    if (recently(s.orderLock.lastExitMs, EXIT_DEDUP_MS)) return;

    s.orderLock.exitInFlight = true;

    console.log(`📤 EXIT ${symbol} reason=${exitReason} price=${price}`);
    try {
      const r = await post3C({ action: "exit_long", symbol, price, comment: exitReason });
      console.log(`📨 3Commas exit_long status=${r.status}`);
      s.orderLock.lastExitMs = nowMs();
    } catch (e) {
      console.error("Exit error:", e?.message || e);
      return;
    } finally {
      s.orderLock.exitInFlight = false;
    }

    s.position = {
      inPosition: false,
      entry: null,
      peak: null,
      stop: null,
      sizeMult: 0,
      volumePercent: 0,
      adaptiveRiskPct: 0,
      enteredMs: 0,
    };
    clearSetup(s, exitReason);
    startCooldown(s, exitReason);
    return;
  }

  if (source !== "tick") return;

  if (shouldEnter(s)) {
    const price = s.lastPrice ?? lastBar.close;

    if (s.orderLock.enterInFlight) return;
    if (recently(s.orderLock.lastEnterMs, ENTER_DEDUP_MS)) return;

    const sizing = computeRiskBasedSize(s, price);
    if (sizing.volumePercent <= 0) {
      dlog("🚫 no enter: sizing returned 0");
      return;
    }

    s.orderLock.enterInFlight = true;

    const comment =
      `${s.setup.setupType}|score=${s.setup.score}|reg=${s.regime.mode}` +
      `|riskPct=${sizing.adaptiveRiskPct}|riskUsd=${sizing.riskUsd}` +
      `|stopDist=${sizing.stopDistance}|volPct=${sizing.volumePercent}|targetPct=${sizing.targetAmountPct}` +
      `|oiT=${lastBar.oiTrend}|oiD=${lastBar.oiDeltaBias}|cvd=${lastBar.cvdTrend}` +
      `|liq=${lastBar.liqClusterBelow}|drop=${lastBar.priceDropPct}|pA=${lastBar.patternAReady}`;

    console.log(
      `📥 ENTER ${symbol} ${comment} price=${price} sizeMult=${sizing.sizeMult} volumePercent=${sizing.volumePercent}`
    );

    try {
      const r = await post3C({
        action: "enter_long",
        symbol,
        price,
        comment,
        volumePercent: sizing.volumePercent,
      });
      console.log(`📨 3Commas enter_long status=${r.status}`);
      s.orderLock.lastEnterMs = nowMs();
    } catch (e) {
      console.error("Entry error:", e?.message || e);
      return;
    } finally {
      s.orderLock.enterInFlight = false;
    }

    s.position.inPosition = true;
    s.position.entry = price;
    s.position.peak = price;
    s.position.sizeMult = sizing.sizeMult;
    s.position.volumePercent = sizing.volumePercent;
    s.position.adaptiveRiskPct = sizing.adaptiveRiskPct;
    s.position.enteredMs = nowMs();

    clearSetup(s, "entered");
  }
}

// ---------------------------
// Auth
// ---------------------------
function authOk(body) {
  if (body?.src === "tick" && TICKROUTER_SECRET) return body.secret === TICKROUTER_SECRET;
  if (body?.src === "features" && BRAIN_SECRET) return body.secret === BRAIN_SECRET;
  if ((body?.src === "ray_buy" || body?.src === "fwo_buy") && BRAIN_SECRET) return body.secret === BRAIN_SECRET;
  if (BRAIN_SECRET || TICKROUTER_SECRET) return body.secret === (BRAIN_SECRET || TICKROUTER_SECRET);
  return true;
}

// ---------------------------
// Webhook handler
// ---------------------------
async function handleWebhook(req, res) {
  try {
    const body = req.body || {};
    if (!authOk(body)) return res.status(401).json({ ok: false, err: "bad secret" });

    if (body.src !== "tick") {
      dlog(`📩 WEBHOOK src=${body.src || ""} signal=${body.signal || ""} symbol=${body.symbol || ""}`);
    }

    const symbol = body.symbol;
    if (!symbol) return res.status(400).json({ ok: false, err: "missing symbol" });

    if (body.action === "ready" || body.src === "enter_long" || body.intent === "exit_long") {
      return res.json({ ok: true, ignored: "legacy_pine_decision" });
    }

    const s = ensureSymbol(symbol);

if (body.src === "tick") {
  const price = n(body.price);
  if (price == null) return res.status(400).json({ ok: false, err: "bad price" });

  s.lastPrice = price;
  s.lastTickMs = nowMs();
  s.tickCount++;

  if (s.tickCount % 50 === 0) {
    console.log(`🟦 LIVE TICKS ${body.symbol} count=${s.tickCount} px=${price}`);
  }

  const now = nowMs();
  if ((now - (s.lastTickLogMs || 0)) >= TICK_LOG_EVERY_MS) {
    console.log(`🟦 TICK(3m) ${symbol} price=${price} time=${body.time || body.timestamp || ""}`);
    s.lastTickLogMs = now;
  }

  await runDecision(symbol, "tick");
  return res.json({ ok: true });
}

    if (body.src === "features") {
      const timeMs =
        body.timestamp ? Date.parse(body.timestamp) :
        body.time ? Date.parse(body.time) :
        nowMs();

      const bar = {
        timeMs,
        close: n(body.close),
        high: n(body.high),
        low: n(body.low),
        ema8: n(body.ema8),
        ema18: n(body.ema18),
        ema50: n(body.ema50),
        rsi: n(body.rsi),
        adx: n(body.adx),
        atr: n(body.atr),
        atrPct: n(body.atrPct),
        oiTrend: n(body.oiTrend, 0),
        oiDeltaBias: n(body.oiDeltaBias, 0),
        cvdTrend: n(body.cvdTrend, 0),
        liqClusterBelow: n(body.liqClusterBelow, 0),
        priceDropPct: n(body.priceDropPct, 0),
        patternAReady: n(body.patternAReady, 0),
        patternAWatch: n(body.patternAWatch, 0),
      };

      if (bar.close == null || bar.high == null || bar.low == null) {
        return res.status(400).json({ ok: false, err: "bad OHLC" });
      }

      console.log(
        `🟩 FEAT rx ${symbol} close=${bar.close} ema8=${bar.ema8} ema18=${bar.ema18} ema50=${bar.ema50} ` +
        `rsi=${bar.rsi} atr=${bar.atr} atrPct=${bar.atrPct} adx=${bar.adx} ` +
        `oiTrend=${bar.oiTrend} oiDeltaBias=${bar.oiDeltaBias} cvdTrend=${bar.cvdTrend} ` +
        `liqClusterBelow=${bar.liqClusterBelow} priceDropPct=${bar.priceDropPct} ` +
        `patternAReady=${bar.patternAReady} patternAWatch=${bar.patternAWatch}`
      );

      s.bars.push(bar);
      pruneBars(s);

      if (s.lastPrice == null) s.lastPrice = bar.close;

      await runDecision(symbol, "features");
      return res.json({ ok: true });
    }

    if (body.src === "ray_buy") {
      s.signals.lastRayBuyMs = nowMs();
      s.signals.lastRayBuySignal = body.signal || "";
      console.log(`🟪 RAY BUY rx ${symbol} signal=${body.signal || ""} price=${body.price || ""}`);
      dlog(`🧠 RAY state lastRayBuyMs=${s.signals.lastRayBuyMs}`);
      return res.json({ ok: true });
    }

    if (body.src === "fwo_buy") {
      s.signals.lastFwoBuyMs = nowMs();
      s.signals.lastFwoBuySignal = body.signal || "";
      console.log(`🟪 FWO BUY rx ${symbol} signal=${body.signal || ""} price=${body.price || ""}`);
      dlog(`🧠 FWO state lastFwoBuyMs=${s.signals.lastFwoBuyMs}`);
      return res.json({ ok: true });
    }

    console.log(`🟪 IGNORE src=${body.src} symbol=${symbol}`);
    return res.json({ ok: true, ignored: "src_not_supported" });
  } catch (e) {
    console.error("handleWebhook error:", e?.stack || e);
    return res.status(500).json({ ok: false, err: "server error" });
  }
}

// ---------------------------
// Routes
// ---------------------------
app.get("/", (_, res) => {
  res.json({
    ok: true,
    brain: "Brain v3.4",
    symbolsMapped: Object.keys(SYMBOL_BOT_MAP).length,
    hasBrainSecret: Boolean(BRAIN_SECRET),
    hasTickRouterSecret: Boolean(TICKROUTER_SECRET),
    debug: DEBUG,
    tickLogEveryMs: TICK_LOG_EVERY_MS,
    raySignalTtlMs: RAY_SIGNAL_TTL_MS,
    fwoSignalTtlMs: FWO_SIGNAL_TTL_MS,
    breakoutMaxAgeMin: BREAKOUT_MAX_AGE_MIN,
    breakoutStaleMinScore: BREAKOUT_STALE_MIN_SCORE,
    washoutMaxAgeMin: WASHOUT_MAX_AGE_MIN,
    botMaxNotionalUsd: BOT_MAX_NOTIONAL_USDT,
    baseRiskPct: BASE_RISK_PCT,
    minRiskPct: MIN_RISK_PCT,
    maxRiskPct: MAX_RISK_PCT,
    trendStopActivateMin: TREND_STOP_ACTIVATE_MIN,
    trendMinTrailPct: TREND_MIN_TRAIL_PCT,
    breakoutConfirmBouncePct: BREAKOUT_CONFIRM_BOUNCE_PCT,
    breakoutMinAdx: BREAKOUT_MIN_ADX,
    breakoutMinScore: BREAKOUT_MIN_SCORE,
    washoutMinScore: WASHOUT_MIN_SCORE,
  });
});

app.post("/tv", handleWebhook);
app.post("/webhook", handleWebhook);

// ---------------------------
// Safety
// ---------------------------
process.on("unhandledRejection", (reason) => console.error("unhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

// ---------------------------
// Start
// ---------------------------
app.listen(PORT, () => {
  console.log(`✅ Brain listening on :${PORT}`);
  console.log(`🧭 SYMBOL_BOT_MAP keys=${Object.keys(SYMBOL_BOT_MAP).length}`);
  console.log(`🐛 DEBUG=${DEBUG ? 1 : 0}`);
  console.log(`🧾 TICK_LOG_EVERY_MS=${TICK_LOG_EVERY_MS}`);
  console.log(`🕒 RAY_SIGNAL_TTL_MS=${RAY_SIGNAL_TTL_MS}`);
  console.log(`🕒 FWO_SIGNAL_TTL_MS=${FWO_SIGNAL_TTL_MS}`);
  console.log(`⏱️ BREAKOUT_MAX_AGE_MIN=${BREAKOUT_MAX_AGE_MIN}`);
  console.log(`📏 BREAKOUT_STALE_MIN_SCORE=${BREAKOUT_STALE_MIN_SCORE}`);
  console.log(`⏱️ WASHOUT_MAX_AGE_MIN=${WASHOUT_MAX_AGE_MIN}`);
  console.log(`💰 BOT_MAX_NOTIONAL_USDT=${BOT_MAX_NOTIONAL_USDT}`);
  console.log(`🛡️ BASE_RISK_PCT=${BASE_RISK_PCT}`);
  console.log(`🛡️ MIN_RISK_PCT=${MIN_RISK_PCT}`);
  console.log(`🛡️ MAX_RISK_PCT=${MAX_RISK_PCT}`);
  console.log(`⏳ TREND_STOP_ACTIVATE_MIN=${TREND_STOP_ACTIVATE_MIN}`);
  console.log(`📉 TREND_MIN_TRAIL_PCT=${TREND_MIN_TRAIL_PCT}`);
  console.log(`✅ BREAKOUT_CONFIRM_BOUNCE_PCT=${BREAKOUT_CONFIRM_BOUNCE_PCT}`);
  console.log(`✅ BREAKOUT_MIN_ADX=${BREAKOUT_MIN_ADX}`);
  console.log(`✅ BREAKOUT_MIN_SCORE=${BREAKOUT_MIN_SCORE}`);
  console.log(`✅ WASHOUT_MIN_SCORE=${WASHOUT_MIN_SCORE}`);
});
