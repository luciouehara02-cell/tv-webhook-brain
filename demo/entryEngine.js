/**
 * entryEngine.js
 * Brain Phase 5 v5.7
 *
 * Unified entry engine:
 * - setupType=washout -> washout validation only
 * - setupType=breakout -> breakout ready / early validation only
 *
 * Main goals:
 * - eliminate cross-strategy contamination
 * - make decisions deterministic
 * - keep current return contract unchanged
 * - reduce late breakout entries that are too extended from trigger/retest
 */

export const BRAIN_VERSION = "Brain Phase 5 v5.7";

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
const EARLY_ENTRY_ALLOW_NEGATIVE_OI = boolEnv("EARLY_ENTRY_ALLOW_NEGATIVE_OI", false);

const READY_RECLAIM_MIN_PCT = numEnv("READY_RECLAIM_MIN_PCT", 0.05);
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
const SCORE_EARLY_TREND_LONG_MIN = numEnv("SCORE_EARLY_TREND_LONG_MIN", 6);

const BREAKOUT_MAX_CHASE_FROM_BOUNCE_PCT_READY_ENTRY = numEnv(
  "BREAKOUT_MAX_CHASE_FROM_BOUNCE_PCT_READY_ENTRY",
  0.35
);
const BREAKOUT_MAX_CHASE_FROM_BOUNCE_PCT_BOUNCE_ENTRY = numEnv(
  "BREAKOUT_MAX_CHASE_FROM_BOUNCE_PCT_BOUNCE_ENTRY",
  0.2
);

// new: hard cap on late extension from trigger / retest
const BREAKOUT_MAX_EXTENSION_FROM_TRIGGER_PCT_READY_ENTRY = numEnv(
  "BREAKOUT_MAX_EXTENSION_FROM_TRIGGER_PCT_READY_ENTRY",
  0.60
);
const BREAKOUT_MAX_EXTENSION_FROM_RETEST_PCT_READY_ENTRY = numEnv(
  "BREAKOUT_MAX_EXTENSION_FROM_RETEST_PCT_READY_ENTRY",
  0.50
);
const BREAKOUT_MAX_EXTENSION_FROM_TRIGGER_PCT_BOUNCE_ENTRY = numEnv(
  "BREAKOUT_MAX_EXTENSION_FROM_TRIGGER_PCT_BOUNCE_ENTRY",
  0.45
);
const BREAKOUT_MAX_EXTENSION_FROM_RETEST_PCT_BOUNCE_ENTRY = numEnv(
  "BREAKOUT_MAX_EXTENSION_FROM_RETEST_PCT_BOUNCE_ENTRY",
  0.35
);

const ENTER_DEDUP_MS = numEnv("ENTER_DEDUP_MS", 25000);

// washout
const WASHOUT_ALLOW_NEGATIVE_OI_ON_ENTRY = boolEnv(
  "WASHOUT_ALLOW_NEGATIVE_OI_ON_ENTRY",
  true
);
const WASHOUT_MIN_SCORE = numEnv("WASHOUT_MIN_SCORE", 7);
const WASHOUT_MIN_CLOSE_IN_RANGE_PCT = numEnv("WASHOUT_MIN_CLOSE_IN_RANGE_PCT", 60);
const WASHOUT_MIN_BOUNCE_BODY_PCT = numEnv("WASHOUT_MIN_BOUNCE_BODY_PCT", 0.08);
const WASHOUT_MIN_RECLAIM_FROM_LOW_PCT = numEnv("WASHOUT_MIN_RECLAIM_FROM_LOW_PCT", 0.35);
const WASHOUT_MIN_RECLAIM_FROM_LOW_PCT_DEEP = numEnv(
  "WASHOUT_MIN_RECLAIM_FROM_LOW_PCT_DEEP",
  0.60
);
const WASHOUT_MIN_BASE_BARS = numEnv("WASHOUT_MIN_BASE_BARS", 3);
const WASHOUT_REQUIRE_RECLAIM_ABOVE_EMA8 = boolEnv(
  "WASHOUT_REQUIRE_RECLAIM_ABOVE_EMA8",
  true
);

// ---------------------------
// Logging
// ---------------------------
function dlog(...args) {
  if (DEBUG) console.log(...args);
}

// ---------------------------
// Metrics
// ---------------------------
function getSetupMetrics(state) {
  const feat = state.features || {};
  const setup = state.setups?.breakout || {};
  const context = state.context || {};

  const close = n(feat.close, NaN);
  const open = n(feat.open, NaN);
  const high = n(feat.high, NaN);
  const low = n(feat.low, NaN);

  const triggerPrice = n(setup.triggerPrice, NaN);
  const retestPrice = n(setup.retestPrice, NaN);
  const bouncePrice = n(setup.bouncePrice, NaN);
  const washoutLow = n(setup.washoutLow, NaN);

  const closeBelowTriggerTolPrice = Number.isFinite(triggerPrice)
    ? triggerPrice * (1 - ENTRY_CLOSE_BELOW_TRIGGER_TOL_PCT / 100)
    : NaN;

  const reclaimPctFromTrigger =
    setup.reclaimPctFromTrigger !== undefined && setup.reclaimPctFromTrigger !== null
      ? n(setup.reclaimPctFromTrigger)
      : pctFrom(close, triggerPrice);

  const reclaimPctFromLow =
    setup.reclaimPctFromLow !== undefined && setup.reclaimPctFromLow !== null
      ? n(setup.reclaimPctFromLow)
      : pctFrom(close, washoutLow);

  const bounceCloseInRangePct =
    setup.bounceCloseInRangePct !== undefined && setup.bounceCloseInRangePct !== null
      ? n(setup.bounceCloseInRangePct)
      : Number.isFinite(high) && Number.isFinite(low) && high > low
      ? ((close - low) / (high - low)) * 100
      : 0;

  const bounceBodyPct =
    setup.bounceBodyPct !== undefined && setup.bounceBodyPct !== null
      ? n(setup.bounceBodyPct)
      : Number.isFinite(open) && open !== 0 && Number.isFinite(close)
      ? (Math.abs(close - open) / open) * 100
      : 0;

  const chasePctFromBounce = Number.isFinite(bouncePrice)
    ? pctFrom(close, bouncePrice)
    : 0;

  const entryExtensionFromTriggerPct = Number.isFinite(triggerPrice)
    ? pctFrom(close, triggerPrice)
    : 0;

  const entryExtensionFromRetestPct = Number.isFinite(retestPrice)
    ? pctFrom(close, retestPrice)
    : Number.isFinite(triggerPrice)
    ? pctFrom(close, triggerPrice)
    : 0;

  return {
    close,
    open,
    high,
    low,
    triggerPrice,
    retestPrice,
    bouncePrice,
    washoutLow,
    closeBelowTriggerTolPrice,
    reclaimPctFromTrigger,
    reclaimPctFromLow,
    bounceCloseInRangePct,
    bounceBodyPct,
    chasePctFromBounce,
    entryExtensionFromTriggerPct,
    entryExtensionFromRetestPct,
    ema8: n(feat.ema8, NaN),
    ema18: n(feat.ema18, NaN),
    ema50: n(feat.ema50, NaN),
    oiTrend: n(feat.oiTrend, 0),
    cvdTrend: n(feat.cvdTrend, 0),
    setupScore: n(setup.score, 0),
    regime: String(context.regime || "unknown"),
    phase: String(setup.phase || "idle"),
    setupType: String(setup.setupType || "breakout"),
    qualityFlags: Array.isArray(setup.qualityFlags) ? setup.qualityFlags : [],
    baseBars: n(setup.baseBars, 0),
    washoutDropPct: n(setup.washoutDropPct, 0),
  };
}

// ---------------------------
// Breakout READY
// ---------------------------
function evaluateReadyLong(state) {
  const m = getSetupMetrics(state);
  const reasons = [];
  const hardReasons = [];
  const softReasons = [];

  if (m.setupType !== "breakout") {
    addUnique(hardReasons, "not breakout setup");
    addUnique(reasons, "not_breakout_setup");
  }

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

  if (
    Number.isFinite(m.entryExtensionFromTriggerPct) &&
    m.entryExtensionFromTriggerPct > BREAKOUT_MAX_EXTENSION_FROM_TRIGGER_PCT_READY_ENTRY
  ) {
    addUnique(reasons, "ready_block_extension_from_trigger_too_high");
    addUnique(hardReasons, "extension from trigger too high");
  }

  if (
    Number.isFinite(m.entryExtensionFromRetestPct) &&
    m.entryExtensionFromRetestPct > BREAKOUT_MAX_EXTENSION_FROM_RETEST_PCT_READY_ENTRY
  ) {
    addUnique(reasons, "ready_block_extension_from_retest_too_high");
    addUnique(hardReasons, "extension from retest too high");
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
  if (m.entryExtensionFromTriggerPct > BREAKOUT_MAX_EXTENSION_FROM_TRIGGER_PCT_READY_ENTRY) {
    score = Math.min(score, 5);
  }
  if (m.entryExtensionFromRetestPct > BREAKOUT_MAX_EXTENSION_FROM_RETEST_PCT_READY_ENTRY) {
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
      `retest=${Number.isFinite(m.retestPrice) ? m.retestPrice.toFixed(4) : "na"} ` +
      `reclaimPct=${m.reclaimPctFromTrigger.toFixed(3)} oiTrend=${m.oiTrend} ` +
      `closeInRange=${m.bounceCloseInRangePct.toFixed(2)} bodyPct=${m.bounceBodyPct.toFixed(3)} ` +
      `extTrig=${m.entryExtensionFromTriggerPct.toFixed(3)} extRetest=${m.entryExtensionFromRetestPct.toFixed(3)} ` +
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
// Breakout EARLY
// ---------------------------
function evaluateEarlyTrendLong(state) {
  const m = getSetupMetrics(state);
  const reasons = [];
  const hardReasons = [];
  const softReasons = [];

  if (m.setupType !== "breakout") {
    addUnique(hardReasons, "not breakout setup");
    addUnique(reasons, "not_breakout_setup");
  }

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

  if (m.bounceCloseInRangePct < READY_MIN_BOUNCE_CLOSE_IN_RANGE_PCT) {
    addUnique(reasons, "entry_block_weak_close_in_range");
    addUnique(hardReasons, "weak close in range");
  }

  if (m.bounceBodyPct < READY_MIN_BOUNCE_BODY_PCT) {
    addUnique(reasons, "entry_block_weak_bounce_body");
    addUnique(hardReasons, "weak bounce body");
  }

  if (
    BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE &&
    !EARLY_ENTRY_ALLOW_NEGATIVE_OI &&
    m.oiTrend <= 0
  ) {
    addUnique(reasons, "entry_block_flow_not_supportive");
    addUnique(hardReasons, "flow not supportive");
  }

  if (
    !BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE &&
    !EARLY_ENTRY_ALLOW_NEGATIVE_OI &&
    m.oiTrend < 0
  ) {
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

  if (
    Number.isFinite(m.entryExtensionFromTriggerPct) &&
    m.entryExtensionFromTriggerPct > BREAKOUT_MAX_EXTENSION_FROM_TRIGGER_PCT_BOUNCE_ENTRY
  ) {
    addUnique(reasons, "entry_block_extension_from_trigger_too_high");
    addUnique(hardReasons, "extension from trigger too high");
  }

  if (
    Number.isFinite(m.entryExtensionFromRetestPct) &&
    m.entryExtensionFromRetestPct > BREAKOUT_MAX_EXTENSION_FROM_RETEST_PCT_BOUNCE_ENTRY
  ) {
    addUnique(reasons, "entry_block_extension_from_retest_too_high");
    addUnique(hardReasons, "extension from retest too high");
  }

  if (m.qualityFlags.includes("close_quality:weak")) {
    addUnique(reasons, "entry_block_close_quality_weak");
    addUnique(hardReasons, "close quality weak");
  }

  if (m.qualityFlags.includes("reclaim_quality:weak")) {
    addUnique(reasons, "entry_block_reclaim_quality_weak");
    addUnique(hardReasons, "reclaim quality weak");
  }

  let score = m.setupScore;

  if (m.close < m.triggerPrice) score = Math.min(score, 5);
  if (m.reclaimPctFromTrigger < EARLY_ENTRY_RECLAIM_MIN_PCT) score = Math.min(score, 5);
  if (m.bounceCloseInRangePct < READY_MIN_BOUNCE_CLOSE_IN_RANGE_PCT) {
    score = Math.min(score, 5);
  }
  if (m.bounceBodyPct < READY_MIN_BOUNCE_BODY_PCT) {
    score = Math.min(score, 5);
  }
  if (
    BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE &&
    !EARLY_ENTRY_ALLOW_NEGATIVE_OI &&
    m.oiTrend <= 0
  ) {
    score = Math.min(score, 5);
  }
  if (!BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE && !EARLY_ENTRY_ALLOW_NEGATIVE_OI && m.oiTrend < 0) {
    score = Math.min(score, 4);
  }
  if (m.entryExtensionFromTriggerPct > BREAKOUT_MAX_EXTENSION_FROM_TRIGGER_PCT_BOUNCE_ENTRY) {
    score = Math.min(score, 5);
  }
  if (m.entryExtensionFromRetestPct > BREAKOUT_MAX_EXTENSION_FROM_RETEST_PCT_BOUNCE_ENTRY) {
    score = Math.min(score, 5);
  }

  if (score < SCORE_EARLY_TREND_LONG_MIN) {
    addUnique(reasons, "entry_block_score_too_low");
    addUnique(softReasons, "score too low");
  }

  const allowed = hardReasons.length === 0 && score >= SCORE_EARLY_TREND_LONG_MIN;

  dlog(
    `🚦 ENTRYCHK LONG | mode=early close=${Number.isFinite(m.close) ? m.close.toFixed(4) : "na"} ` +
      `trigger=${Number.isFinite(m.triggerPrice) ? m.triggerPrice.toFixed(4) : "na"} ` +
      `retest=${Number.isFinite(m.retestPrice) ? m.retestPrice.toFixed(4) : "na"} ` +
      `reclaimPct=${m.reclaimPctFromTrigger.toFixed(3)} oiTrend=${m.oiTrend} ` +
      `closeInRange=${m.bounceCloseInRangePct.toFixed(2)} bodyPct=${m.bounceBodyPct.toFixed(3)} ` +
      `extTrig=${m.entryExtensionFromTriggerPct.toFixed(3)} extRetest=${m.entryExtensionFromRetestPct.toFixed(3)} ` +
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
// Washout reclaim
// ---------------------------
function evaluateWashoutReclaimLong(state) {
  const m = getSetupMetrics(state);
  const reasons = [];
  const hardReasons = [];
  const softReasons = [];

  if (m.setupType !== "washout") {
    addUnique(hardReasons, "not washout setup");
    addUnique(reasons, "not_washout_setup");
  }

  if (m.phase !== "washout_ready") {
    addUnique(reasons, `washout phase=${m.phase}`);
    addUnique(hardReasons, "not in washout ready phase");
  }

  if (!Number.isFinite(m.washoutLow) || m.washoutLow <= 0) {
    addUnique(reasons, "washout_missing_low");
    addUnique(hardReasons, "missing washout low");
  }

  const minReclaim =
    m.washoutDropPct >= 3.8
      ? WASHOUT_MIN_RECLAIM_FROM_LOW_PCT_DEEP
      : WASHOUT_MIN_RECLAIM_FROM_LOW_PCT;

  if (m.reclaimPctFromLow < minReclaim) {
    addUnique(reasons, "washout_reclaim_too_small");
    addUnique(hardReasons, "washout reclaim too small");
  }

  if (m.baseBars < WASHOUT_MIN_BASE_BARS) {
    addUnique(reasons, "washout_base_too_short");
    addUnique(hardReasons, "washout base too short");
  }

  if (WASHOUT_REQUIRE_RECLAIM_ABOVE_EMA8 && !(m.close > m.ema8)) {
    addUnique(reasons, "washout_close_not_above_ema8");
    addUnique(hardReasons, "close not above ema8");
  }

  if (m.bounceCloseInRangePct < WASHOUT_MIN_CLOSE_IN_RANGE_PCT) {
    addUnique(reasons, "washout_close_in_range_too_weak");
    addUnique(hardReasons, "washout close in range too weak");
  }

  if (m.bounceBodyPct < WASHOUT_MIN_BOUNCE_BODY_PCT) {
    addUnique(reasons, "washout_body_too_weak");
    addUnique(hardReasons, "washout body too weak");
  }

  if (!WASHOUT_ALLOW_NEGATIVE_OI_ON_ENTRY && m.oiTrend < 0) {
    addUnique(reasons, "washout_negative_oi_block");
    addUnique(hardReasons, "negative oi blocked for washout");
  }

  let score = m.setupScore;

  if (m.reclaimPctFromLow < minReclaim) score = Math.min(score, 5);
  if (m.baseBars < WASHOUT_MIN_BASE_BARS) score = Math.min(score, 5);
  if (!WASHOUT_ALLOW_NEGATIVE_OI_ON_ENTRY && m.oiTrend < 0) score = Math.min(score, 5);

  if (score < WASHOUT_MIN_SCORE) {
    addUnique(reasons, "washout_score_too_low");
    addUnique(softReasons, "score too low");
  }

  const allowed = hardReasons.length === 0 && score >= WASHOUT_MIN_SCORE;

  dlog(
    `🟨 WASHOUTCHK LONG | close=${Number.isFinite(m.close) ? m.close.toFixed(4) : "na"} ` +
      `washoutLow=${Number.isFinite(m.washoutLow) ? m.washoutLow.toFixed(4) : "na"} ` +
      `reclaimPctFromLow=${m.reclaimPctFromLow.toFixed(3)} baseBars=${m.baseBars} ` +
      `oiTrend=${m.oiTrend} closeInRange=${m.bounceCloseInRangePct.toFixed(2)} ` +
      `bodyPct=${m.bounceBodyPct.toFixed(3)} score=${score} ok=${allowed ? 1 : 0} ` +
      `reasons=${reasons.join(",") || "entry_allowed"}`
  );

  return {
    allowed,
    mode: allowed ? "washout_reclaim_long" : null,
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
  const setupType = String(breakout.setupType || "breakout");

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

  if (setupType === "washout") {
    const washoutEval = evaluateWashoutReclaimLong(state);

    if (washoutEval.allowed) {
      return {
        allowed: true,
        mode: "washout_reclaim_long",
        score: washoutEval.score,
        patch: {
          score: washoutEval.score,
          chasePct: 0,
          entryCandidatePrice: washoutEval.metrics.close,
          lastEntryMode: "washout_reclaim_long",
        },
        chasePct: 0,
        reasons: ["entry_allowed"],
        hardReasons: [],
        softReasons: [],
      };
    }

    return {
      allowed: false,
      mode: null,
      score: washoutEval.score,
      patch: {
        score: washoutEval.score,
        chasePct: 0,
        entryCandidatePrice: washoutEval.metrics?.close ?? null,
      },
      chasePct: 0,
      reasons: washoutEval.reasons.length ? washoutEval.reasons : ["entry_blocked"],
      hardReasons: washoutEval.hardReasons,
      softReasons: washoutEval.softReasons,
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

  const fallbackScore = Math.max(
    n(readyEval.score),
    n(earlyEval.score),
    n(breakout.score)
  );

  return {
    allowed: false,
    mode: null,
    score: fallbackScore,
    patch: {
      score: fallbackScore,
      chasePct:
        readyEval.metrics?.chasePctFromBounce ??
        earlyEval.metrics?.chasePctFromBounce ??
        0,
      entryCandidatePrice:
        readyEval.metrics?.close ??
        earlyEval.metrics?.close ??
        null,
    },
    chasePct:
      readyEval.metrics?.chasePctFromBounce ??
      earlyEval.metrics?.chasePctFromBounce ??
      0,
    reasons: mergedReasons.length ? mergedReasons : ["entry_blocked"],
    hardReasons: mergedHardReasons,
    softReasons: mergedSoftReasons,
  };
}
