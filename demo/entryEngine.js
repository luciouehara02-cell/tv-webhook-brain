/**
 * entryEngine.js
 * Brain Phase 5 v5.5
 *
 * Contract for current brain.js:
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
 */

export const BRAIN_VERSION = "Brain Phase 5 v5.5";

// ---------------------------
// helpers
// ---------------------------
function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function boolEnv(name, def = false) {
  const raw = String(process.env[name] ?? (def ? "1" : "0")).trim().toLowerCase();
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
  if (!arr.includes(item)) arr.push(item);
}

function featOf(state) {
  return state?.features ?? {};
}

function breakoutOf(state) {
  return state?.setups?.breakout ?? {};
}

function ctxOf(state) {
  return state?.context ?? {};
}

function posOf(state) {
  return state?.position ?? {};
}

function isTrendRegime(regime) {
  return String(regime || "").toLowerCase() === "trend";
}

// ---------------------------
// config
// ---------------------------
const DEBUG = boolEnv("DEBUG", true);

const BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE = boolEnv(
  "BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE",
  true
);

const ENTRY_RECLAIM_MIN_PCT = numEnv("ENTRY_RECLAIM_MIN_PCT", 0.05);
const ENTRY_CLOSE_BELOW_TRIGGER_TOL_PCT = numEnv(
  "ENTRY_CLOSE_BELOW_TRIGGER_TOL_PCT",
  0.00
);

const SCORE_ENTER_LONG = numEnv("SCORE_ENTER_LONG", 6);
const MAX_CHASE_PCT = numEnv("MAX_CHASE_PCT", 0.25);

// ---------------------------
// logging
// ---------------------------
function dlog(...args) {
  if (DEBUG) console.log(...args);
}

// ---------------------------
// NAMED EXPORT REQUIRED BY brain.js
// ---------------------------
export function buildEntryDecision(state) {
  const feat = featOf(state);
  const breakout = breakoutOf(state);
  const position = posOf(state);

  const reasons = [];
  const hardReasons = [];
  const softReasons = [];

  const close = n(feat.close);
  const ema8 = n(feat.ema8);
  const ema18 = n(feat.ema18);
  const oiTrend = n(feat.oiTrend);
  const regime = String(ctxOf(state).regime ?? feat.regime ?? "range");

  const triggerPrice = n(breakout.triggerPrice);
  const reclaimPctFromTrigger = Number.isFinite(Number(breakout.reclaimPctFromTrigger))
    ? n(breakout.reclaimPctFromTrigger)
    : pctFrom(close, triggerPrice);

  const score = n(breakout.score);
  const entryCandidatePrice = Number.isFinite(Number(breakout.entryCandidatePrice))
    ? n(breakout.entryCandidatePrice)
    : close;

  const chasePct = triggerPrice > 0 ? pctFrom(close, triggerPrice) : 0;

  const base = {
    allowed: false,
    mode: null,
    score,
    patch: null,
    chasePct,
    reasons,
    hardReasons,
    softReasons,
  };

  if (position.inPosition) {
    addUnique(reasons, "already in position");
    addUnique(hardReasons, "already in position");
    return base;
  }

  if (breakout.phase !== "ready") {
    addUnique(reasons, `breakout phase=${breakout.phase}`);
    addUnique(hardReasons, "not in ready phase");
    return base;
  }

  if (!(triggerPrice > 0)) {
    addUnique(reasons, "missing trigger price");
    addUnique(hardReasons, "missing trigger price");
    return base;
  }

  const minCloseAllowed =
    triggerPrice * (1 - ENTRY_CLOSE_BELOW_TRIGGER_TOL_PCT / 100);

  if (!isTrendRegime(regime)) {
    addUnique(reasons, "entry_block_not_trend_regime");
    addUnique(hardReasons, "not trend regime");
  }

  if (!(ema8 > ema18)) {
    addUnique(reasons, "entry_block_ema8_not_above_ema18");
    addUnique(hardReasons, "ema8 not above ema18");
  }

  if (close < minCloseAllowed) {
    addUnique(reasons, "entry_block_close_below_trigger");
    addUnique(hardReasons, "close below trigger");
  }

  if (reclaimPctFromTrigger < ENTRY_RECLAIM_MIN_PCT) {
    addUnique(reasons, "entry_block_reclaim_too_small");
    addUnique(hardReasons, "reclaim too small");
  }

  if (BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE && oiTrend <= 0) {
    addUnique(reasons, "entry_block_flow_not_supportive");
    addUnique(hardReasons, "flow not supportive");
  }

  if (chasePct > MAX_CHASE_PCT) {
    addUnique(reasons, `entry_block_chase_too_high_${chasePct.toFixed(3)}`);
    addUnique(hardReasons, "chase too high");
  }

  if (hardReasons.length > 0) {
    dlog(
      `🚦 ENTRYCHK LONG | close=${close.toFixed(4)} trigger=${triggerPrice.toFixed(4)} ` +
        `reclaimPct=${reclaimPctFromTrigger.toFixed(3)} oiTrend=${oiTrend} ` +
        `ema8=${ema8.toFixed(4)} ema18=${ema18.toFixed(4)} regime=${regime} ` +
        `ok=0 reasons=${reasons.join(",")} score=${score}`
    );

    return base;
  }

  if (score < SCORE_ENTER_LONG) {
    addUnique(reasons, "entry_block_score_too_low");
    addUnique(softReasons, "score too low");
    return base;
  }

  addUnique(reasons, "entry_allowed");

  dlog(
    `🚦 ENTRYCHK LONG | close=${close.toFixed(4)} trigger=${triggerPrice.toFixed(4)} ` +
      `reclaimPct=${reclaimPctFromTrigger.toFixed(3)} oiTrend=${oiTrend} ` +
      `ema8=${ema8.toFixed(4)} ema18=${ema18.toFixed(4)} regime=${regime} ` +
      `ok=1 reasons=${reasons.join(",")} score=${score}`
  );

  return {
    allowed: true,
    mode: "breakout_ready_long",
    score,
    chasePct,
    reasons,
    hardReasons,
    softReasons,
    patch: {
      lastEntryMode: "breakout_ready_long",
      entryCandidatePrice,
      chasePct,
      reasons: [`entry allowed | mode=breakout_ready_long score=${score}`],
    },
  };
}

export default {
  BRAIN_VERSION,
  buildEntryDecision,
};
