/**
 * entryEngine.js
 * Brain Phase 5 v5.5
 *
 * Contract for current brain.js / entryPolicy.js:
 *   const entryDecision = buildEntryDecision(state)
 *   entryDecision => {
 *     allowed,
 *     mode,
 *     score,
 *     patch,
 *     chasePct,
 *     reasons,
 *     hardReasons,
 *     softReasons
 *   }
 *
 * v5.5:
 * - strict READY path remains
 * - add EARLY TREND LONG path from bounce_confirmed
 * - weak reclaim / below-trigger still hard-block
 * - negative OI now hard-blocks EARLY longs
 * - READY path still blocks on non-supportive flow
 */

export const BRAIN_VERSION = "Brain Phase 5 v5.5";

// ---------------------------
// Helpers
// ---------------------------
function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function boolEnv(name, def = false) {
  const raw = String(process.env[name] ?? (def ? "1" : "0"))
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function numEnv(name, def) {
  const x = Number(process.env[name]);
  return Number.isFinite(x) ? x : def;
}

function pctFrom(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0;
  return ((a - b) / b) * 100;
}

function addUnique(arr, item) {
  if (item && !arr.includes(item)) arr.push(item);
}

function hasFlag(flags, wanted) {
  return Array.isArray(flags) && flags.includes(wanted);
}

// ---------------------------
// Config
// ---------------------------
const DEBUG = boolEnv("DEBUG", true);

const BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE = boolEnv(
  "BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE",
  true
);

const READY_BLOCK_ON_NEGATIVE_OI = boolEnv("READY_BLOCK_ON_NEGATIVE_OI", true);
const ALLOW_EARLY_TREND_ENTRY = boolEnv("ALLOW_EARLY_TREND_ENTRY", true);

// NEW: early long now blocks on negative OI by default
const EARLY_ENTRY_ALLOW_NEGATIVE_OI = boolEnv("EARLY_ENTRY_ALLOW_NEGATIVE_OI", false);

const READY_RECLAIM_MIN_PCT = numEnv("READY_RECLAIM_MIN_PCT", 0.05);
const ENTRY_RECLAIM_MIN_PCT = numEnv("ENTRY_RECLAIM_MIN_PCT", 0.05);
const EARLY_ENTRY_RECLAIM_MIN_PCT = numEnv("EARLY_ENTRY_RECLAIM_MIN_PCT", 0.05);

const READY_MIN_BOUNCE_CLOSE_IN_RANGE_PCT = numEnv(
  "READY_MIN_BOUNCE_CLOSE_IN_RANGE_PCT",
  60
);
const READY_MIN_BOUNCE_BODY_PCT = numEnv("READY_MIN_BOUNCE_BODY_PCT", 0.08);

const ENTRY_CLOSE_BELOW_TRIGGER_TOL_PCT = numEnv(
  "ENTRY_CLOSE_BELOW_TRIGGER_TOL_PCT",
  0.0
);

const SCORE_ENTER_LONG = numEnv("SCORE_ENTER_LONG", 6);
const SCORE_READY_LONG_MIN = numEnv("SCORE_READY_LONG_MIN", SCORE_ENTER_LONG);
const SCORE_EARLY_TREND_LONG_MIN = numEnv("SCORE_EARLY_TREND_LONG_MIN", 5);

const BREAKOUT_MAX_CHASE_FROM_BOUNCE_PCT_READY_ENTRY = numEnv(
  "BREAKOUT_MAX_CHASE_FROM_BOUNCE_PCT_READY_ENTRY",
  0.35
);
const BREAKOUT_MAX_CHASE_FROM_BOUNCE_PCT_BOUNCE_ENTRY = numEnv(
  "BREAKOUT_MAX_CHASE_FROM_BOUNCE_PCT_BOUNCE_ENTRY",
  0.2
);

const ENTER_DEDUP_MS = numEnv("ENTER_DEDUP_MS", 25000);

// ---------------------------
// Logging
// ---------------------------
function dlog(...args) {
  if (DEBUG) console.log(...args);
}

// ---------------------------
// Core metrics
// ---------------------------
function getBreakoutMetrics(state) {
  const feat = state.features || {};
  const breakout = state.setups?.breakout || {};
  const context = state.context || {};

  const close = n(feat.close, NaN);
  const open = n(feat.open, NaN);
  const high = n(feat.high, NaN);
  const low = n(feat.low, NaN);

  const triggerPrice = n(breakout.triggerPrice, NaN);
  const bouncePrice = n(breakout.bouncePrice, NaN);
  const retestPrice = n(breakout.retestPrice, NaN);

  const closeBelowTriggerTolPrice = Number.isFinite(triggerPrice)
    ? triggerPrice * (1 - ENTRY_CLOSE_BELOW_TRIGGER_TOL_PCT / 100)
    : NaN;

  const reclaimPctFromTrigger = Number.isFinite(breakout.reclaimPctFromTrigger)
    ? n(breakout.reclaimPctFromTrigger)
    : pctFrom(close, triggerPrice);

  const bounceCloseInRangePct = Number.isFinite(breakout.bounceCloseInRangePct)
    ? n(breakout.bounceCloseInRangePct)
    : Number.isFinite(high) && Number.isFinite(low) && high > low
    ? ((close - low) / (high - low)) * 100
    : 0;

  const bounceBodyPct = Number.isFinite(breakout.bounceBodyPct)
    ? n(breakout.bounceBodyPct)
    : Number.isFinite(open) && open !== 0 && Number.isFinite(close)
    ? (Math.abs(close - open) / open) * 100
    : 0;

  const chasePctFromBounce = Number.isFinite(bouncePrice)
    ? pctFrom(close, bouncePrice)
    : 0;

  const ema8 = n(feat.ema8, NaN);
  const ema18 = n(feat.ema18, NaN);
  const ema50 = n(feat.ema50, NaN);

  const oiTrend = n(feat.oiTrend, 0);
  const cvdTrend = n(feat.cvdTrend, 0);

  const setupScore = n(breakout.score, 0);

  return {
    close,
    open,
    high,
    low,
    triggerPrice,
    bouncePrice,
    retestPrice,
    closeBelowTriggerTolPrice,
    reclaimPctFromTrigger,
    bounceCloseInRangePct,
    bounceBodyPct,
    chasePctFromBounce,
    ema8,
    ema18,
    ema50,
    oiTrend,
    cvdTrend,
    setupScore,
    regime: String(context.regime || "unknown"),
    phase: String(breakout.phase || "idle"),
    qualityFlags: Array.isArray(breakout.qualityFlags) ? breakout.qualityFlags : [],
  };
}

// ---------------------------
// READY gate
// ---------------------------
function evaluateReadyLong(state) {
  const m = getBreakoutMetrics(state);
  const reasons = [];
  const hardReasons = [];
  const softReasons = [];

  if (m.phase !== "ready") {
    addUnique(reasons, `breakout phase=${m.phase}`);
    addUnique(hardReasons, "not in ready phase");
  }

  if (m.regime !== "trend") {
    addUnique(reasons, "entry_block_not_trend_regime");
    addUnique(hardReasons, "not trend regime");
  }

  if (!(m.ema8 > m.ema18)) {
    addUnique(reasons, "entry_block_ema8_not_above_ema18");
    addUnique(hardReasons, "ema8 not above ema18");
  }

  if (!Number.isFinite(m.triggerPrice) || m.triggerPrice <= 0) {
    addUnique(reasons, "missing trigger price");
    addUnique(hardReasons, "missing trigger price");
  }

  if (Number.isFinite(m.closeBelowTriggerTolPrice) && m.close < m.closeBelowTriggerTolPrice) {
    addUnique(reasons, "ready_block_close_below_trigger");
    addUnique(hardReasons, "close below trigger");
  }

  if (m.reclaimPctFromTrigger < READY_RECLAIM_MIN_PCT) {
    addUnique(reasons, "ready_block_reclaim_too_small");
    addUnique(hardReasons, "reclaim too small");
  }

  if (m.bounceCloseInRangePct < READY_MIN_BOUNCE_CLOSE_IN_RANGE_PCT) {
    addUnique(reasons, "ready_block_weak_close_in_range");
    addUnique(hardReasons, "weak close in range");
  }

  if (m.bounceBodyPct < READY_MIN_BOUNCE_BODY_PCT) {
    addUnique(reasons, "ready_block_weak_bounce_body");
    addUnique(hardReasons, "weak bounce body");
  }

  if (
    BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE &&
    READY_BLOCK_ON_NEGATIVE_OI &&
    m.oiTrend <= 0
  ) {
    addUnique(reasons, "ready_block_flow_not_supportive");
    addUnique(hardReasons, "flow not supportive");
  }

  if (
    Number.isFinite(m.chasePctFromBounce) &&
    m.chasePctFromBounce > BREAKOUT_MAX_CHASE_FROM_BOUNCE_PCT_READY_ENTRY
  ) {
    addUnique(reasons, "ready_block_chase_too_high");
    addUnique(hardReasons, "chase too high");
  }

  let score = m.setupScore;

  if (m.close < m.triggerPrice) score = Math.min(score, 5);
  if (m.reclaimPctFromTrigger < READY_RECLAIM_MIN_PCT) score = Math.min(score, 5);
  if (
    BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE &&
    READY_BLOCK_ON_NEGATIVE_OI &&
    m.oiTrend <= 0
  ) {
    score = Math.min(score, 5);
  }

  if (score < SCORE_READY_LONG_MIN) {
    addUnique(reasons, "ready_block_score_too_low");
    addUnique(softReasons, "score too low");
  }

  const allowed = hardReasons.length === 0 && score >= SCORE_READY_LONG_MIN;

  dlog(
    `🟦 READYCHK LONG | close=${Number.isFinite(m.close) ? m.close.toFixed(4) : "na"} ` +
      `trigger=${Number.isFinite(m.triggerPrice) ? m.triggerPrice.toFixed(4) : "na"} ` +
      `reclaimPct=${m.reclaimPctFromTrigger.toFixed(3)} oiTrend=${m.oiTrend} ` +
      `closeInRange=${m.bounceCloseInRangePct.toFixed(2)} bodyPct=${m.bounceBodyPct.toFixed(3)} ` +
      `score=${score} readyOk=${allowed ? 1 : 0} reasons=${reasons.join(",") || "pass"}`
  );

  return {
    allowed,
    mode: allowed ? "breakout_ready_long" : null,
    score,
    reasons,
    hardReasons,
    softReasons,
    metrics: m,
  };
}

// ---------------------------
// EARLY gate
// ---------------------------
function evaluateEarlyTrendLong(state) {
  const m = getBreakoutMetrics(state);
  const reasons = [];
  const hardReasons = [];
  const softReasons = [];

  if (m.phase !== "bounce_confirmed") {
    addUnique(reasons, `breakout phase=${m.phase}`);
    addUnique(hardReasons, "not in ready/early-entry phase");
  }

  if (!ALLOW_EARLY_TREND_ENTRY) {
    addUnique(reasons, "early_entry_disabled");
    addUnique(hardReasons, "early entry disabled");
  }

  if (m.regime !== "trend") {
    addUnique(reasons, "entry_block_not_trend_regime");
    addUnique(hardReasons, "not trend regime");
  }

  if (!(m.ema8 > m.ema18)) {
    addUnique(reasons, "entry_block_ema8_not_above_ema18");
    addUnique(hardReasons, "ema8 not above ema18");
  }

  if (!Number.isFinite(m.triggerPrice) || m.triggerPrice <= 0) {
    addUnique(reasons, "missing trigger price");
    addUnique(hardReasons, "missing trigger price");
  }

  if (Number.isFinite(m.closeBelowTriggerTolPrice) && m.close < m.closeBelowTriggerTolPrice) {
    addUnique(reasons, "entry_block_close_below_trigger");
    addUnique(hardReasons, "close below trigger");
  }

  if (m.reclaimPctFromTrigger < EARLY_ENTRY_RECLAIM_MIN_PCT) {
    addUnique(reasons, "entry_block_reclaim_too_small");
    addUnique(hardReasons, "reclaim too small");
  }

  // NEW: block negative OI early longs
  if (!EARLY_ENTRY_ALLOW_NEGATIVE_OI && m.oiTrend < 0) {
    addUnique(reasons, "entry_block_negative_oi_for_early_long");
    addUnique(hardReasons, "negative oi blocked for early long");
  }

  if (
    Number.isFinite(m.chasePctFromBounce) &&
    m.chasePctFromBounce > BREAKOUT_MAX_CHASE_FROM_BOUNCE_PCT_BOUNCE_ENTRY
  ) {
    addUnique(reasons, "entry_block_chase_too_high");
    addUnique(hardReasons, "chase too high");
  }

  let score = m.setupScore;

  if (m.close < m.triggerPrice) score = Math.min(score, 5);
  if (m.reclaimPctFromTrigger < EARLY_ENTRY_RECLAIM_MIN_PCT) score = Math.min(score, 5);
  if (!EARLY_ENTRY_ALLOW_NEGATIVE_OI && m.oiTrend < 0) score = Math.min(score, 4);

  if (score < SCORE_EARLY_TREND_LONG_MIN) {
    addUnique(reasons, "entry_block_score_too_low");
    addUnique(softReasons, "score too low");
  }

  const allowed = hardReasons.length === 0 && score >= SCORE_EARLY_TREND_LONG_MIN;

  dlog(
    `🚦 ENTRYCHK LONG | mode=early close=${Number.isFinite(m.close) ? m.close.toFixed(4) : "na"} ` +
      `trigger=${Number.isFinite(m.triggerPrice) ? m.triggerPrice.toFixed(4) : "na"} ` +
      `reclaimPct=${m.reclaimPctFromTrigger.toFixed(3)} oiTrend=${m.oiTrend} ` +
      `ema8=${Number.isFinite(m.ema8) ? m.ema8.toFixed(4) : "na"} ` +
      `ema18=${Number.isFinite(m.ema18) ? m.ema18.toFixed(4) : "na"} ` +
      `ema50=${Number.isFinite(m.ema50) ? m.ema50.toFixed(4) : "na"} ` +
      `regime=${m.regime} ok=${allowed ? 1 : 0} ` +
      `reasons=${reasons.join(",") || "entry_allowed"} score=${score}`
  );

  return {
    allowed,
    mode: allowed ? "early_trend_long" : null,
    score,
    reasons,
    hardReasons,
    softReasons,
    metrics: m,
  };
}

// ---------------------------
// Decision builder
// ---------------------------
export function buildEntryDecision(state) {
  const breakout = state.setups?.breakout || {};
  const execution = state.execution || {};
  const nowMs = Date.now();

  if (state.position?.inPosition) {
    return {
      allowed: false,
      mode: null,
      score: breakout.score ?? 0,
      patch: null,
      chasePct: breakout.chasePct ?? null,
      reasons: ["already in position"],
      hardReasons: ["already in position"],
      softReasons: [],
    };
  }

  if (
    n(execution.lastActionAt, 0) > 0 &&
    nowMs - n(execution.lastActionAt, 0) < ENTER_DEDUP_MS
  ) {
    return {
      allowed: false,
      mode: null,
      score: breakout.score ?? 0,
      patch: null,
      chasePct: breakout.chasePct ?? null,
      reasons: ["entry_block_dedup"],
      hardReasons: ["dedup active"],
      softReasons: [],
    };
  }

  const readyEval = evaluateReadyLong(state);

  if (readyEval.allowed) {
    return {
      allowed: true,
      mode: "breakout_ready_long",
      score: readyEval.score,
      patch: {
        score: readyEval.score,
        chasePct: readyEval.metrics.chasePctFromBounce,
        entryCandidatePrice: readyEval.metrics.close,
        lastEntryMode: "breakout_ready_long",
      },
      chasePct: readyEval.metrics.chasePctFromBounce,
      reasons: ["entry_allowed"],
      hardReasons: [],
      softReasons: [],
    };
  }

  const earlyEval = evaluateEarlyTrendLong(state);

  if (earlyEval.allowed) {
    return {
      allowed: true,
      mode: "early_trend_long",
      score: earlyEval.score,
      patch: {
        score: earlyEval.score,
        chasePct: earlyEval.metrics.chasePctFromBounce,
        entryCandidatePrice: earlyEval.metrics.close,
        lastEntryMode: "early_trend_long",
      },
      chasePct: earlyEval.metrics.chasePctFromBounce,
      reasons: ["entry_allowed"],
      hardReasons: [],
      softReasons: [],
    };
  }

  const mergedReasons = [];
  const mergedHardReasons = [];
  const mergedSoftReasons = [];

  for (const r of readyEval.reasons || []) addUnique(mergedReasons, r);
  for (const r of earlyEval.reasons || []) addUnique(mergedReasons, r);

  for (const r of readyEval.hardReasons || []) addUnique(mergedHardReasons, r);
  for (const r of earlyEval.hardReasons || []) addUnique(mergedHardReasons, r);

  for (const r of readyEval.softReasons || []) addUnique(mergedSoftReasons, r);
  for (const r of earlyEval.softReasons || []) addUnique(mergedSoftReasons, r);

  const fallbackScore = Math.max(n(readyEval.score), n(earlyEval.score), n(breakout.score));

  return {
    allowed: false,
    mode: null,
    score: fallbackScore,
    patch: {
      score: fallbackScore,
      chasePct:
        readyEval.metrics?.chasePctFromBounce ??
        earlyEval.metrics?.chasePctFromBounce ??
        breakout.chasePct ??
        null,
      entryCandidatePrice:
        readyEval.metrics?.close ??
        earlyEval.metrics?.close ??
        null,
    },
    chasePct:
      readyEval.metrics?.chasePctFromBounce ??
      earlyEval.metrics?.chasePctFromBounce ??
      breakout.chasePct ??
      null,
    reasons: mergedReasons.length ? mergedReasons : ["entry_blocked"],
    hardReasons: mergedHardReasons,
    softReasons: mergedSoftReasons,
  };
}
