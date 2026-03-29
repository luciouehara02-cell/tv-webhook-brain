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
 * - negative OI no longer always kills a strong trend continuation
 * - noise reduction: do NOT emit "missing trigger price" style hard blocks while breakout is idle
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

function isBullAligned(feat) {
  return n(feat.ema8) > n(feat.ema18) && n(feat.ema18) >= n(feat.ema50);
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
const SCORE_EARLY_TREND_LONG_MIN = numEnv("SCORE_EARLY_TREND_LONG_MIN", 5);

const MAX_CHASE_PCT = numEnv("MAX_CHASE_PCT", 0.25);

const ALLOW_EARLY_TREND_ENTRY = boolEnv("ALLOW_EARLY_TREND_ENTRY", true);
const EARLY_ENTRY_ALLOW_NEGATIVE_OI = boolEnv("EARLY_ENTRY_ALLOW_NEGATIVE_OI", true);
const EARLY_ENTRY_MAX_BODY_WEAKNESS_ALLOW = boolEnv("EARLY_ENTRY_MAX_BODY_WEAKNESS_ALLOW", true);

// ---------------------------
// logging
// ---------------------------
function dlog(...args) {
  if (DEBUG) console.log(...args);
}

// ---------------------------
// named export required by brain.js / entryPolicy.js
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
  const ema50 = n(feat.ema50);
  const oiTrend = n(feat.oiTrend);
  const regime = String(ctxOf(state).regime ?? feat.regime ?? "range");

  const triggerPrice = n(breakout.triggerPrice);
  const phase = String(breakout.phase ?? "idle");
  const score = n(breakout.score);

  const entryCandidatePrice = Number.isFinite(
    Number(breakout.entryCandidatePrice)
  )
    ? n(breakout.entryCandidatePrice)
    : close;

  const chasePct = triggerPrice > 0 ? pctFrom(close, triggerPrice) : 0;

  const reclaimPctFromTrigger =
    triggerPrice > 0
      ? (
          Number.isFinite(Number(breakout.reclaimPctFromTrigger))
            ? n(breakout.reclaimPctFromTrigger)
            : pctFrom(close, triggerPrice)
        )
      : 0;

  const bounceBodyPct = n(breakout.bounceBodyPct);
  const bounceCloseInRangePct = n(breakout.bounceCloseInRangePct);

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

  // ---------------------------
  // noise reduction
  // ---------------------------
  // For idle phase, do not emit hard block reasons like "missing trigger price".
  // This keeps logs clean when no setup exists yet.
  if (phase === "idle") {
    addUnique(reasons, "breakout phase=idle");
    return base;
  }

  // For retest_pending, keep it quiet and explicit.
  if (phase === "retest_pending" && !(triggerPrice > 0)) {
    addUnique(reasons, "breakout phase=retest_pending");
    addUnique(hardReasons, "waiting for trigger context");
    return base;
  }

  if (!(triggerPrice > 0)) {
    addUnique(reasons, "missing trigger price");
    addUnique(hardReasons, "missing trigger price");
    return base;
  }

  const minCloseAllowed =
    triggerPrice * (1 - ENTRY_CLOSE_BELOW_TRIGGER_TOL_PCT / 100);

  const trendOk = isTrendRegime(regime);
  const bullAligned = isBullAligned(feat);

  // universal hard blocks for real setup phases only
  if (!trendOk) {
    addUnique(reasons, "entry_block_not_trend_regime");
    addUnique(hardReasons, "not trend regime");
  }

  if (!bullAligned) {
    addUnique(reasons, "entry_block_ema_not_bull_aligned");
    addUnique(hardReasons, "ema not bull aligned");
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

  if (chasePct > MAX_CHASE_PCT) {
    addUnique(reasons, `entry_block_chase_too_high_${chasePct.toFixed(3)}`);
    addUnique(hardReasons, "chase too high");
  }

  // ---------------------------
  // STRICT READY PATH
  // ---------------------------
  if (phase === "ready") {
    if (BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE && oiTrend <= 0) {
      addUnique(reasons, "entry_block_flow_not_supportive");
      addUnique(hardReasons, "flow not supportive");
    }

    if (hardReasons.length > 0) {
      dlog(
        `🚦 ENTRYCHK LONG | mode=ready close=${close.toFixed(4)} trigger=${triggerPrice.toFixed(
          4
        )} reclaimPct=${reclaimPctFromTrigger.toFixed(3)} oiTrend=${oiTrend} ` +
          `ema8=${ema8.toFixed(4)} ema18=${ema18.toFixed(4)} ema50=${ema50.toFixed(4)} ` +
          `regime=${regime} ok=0 reasons=${reasons.join(",")} score=${score}`
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
      `🚦 ENTRYCHK LONG | mode=ready close=${close.toFixed(4)} trigger=${triggerPrice.toFixed(
        4
      )} reclaimPct=${reclaimPctFromTrigger.toFixed(3)} oiTrend=${oiTrend} ` +
        `ema8=${ema8.toFixed(4)} ema18=${ema18.toFixed(4)} ema50=${ema50.toFixed(4)} ` +
        `regime=${regime} ok=1 reasons=${reasons.join(",")} score=${score}`
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

  // ---------------------------
  // EARLY TREND LONG PATH
  // ---------------------------
  if (phase === "bounce_confirmed" && ALLOW_EARLY_TREND_ENTRY) {
    if (
      BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE &&
      !EARLY_ENTRY_ALLOW_NEGATIVE_OI &&
      oiTrend <= 0
    ) {
      addUnique(reasons, "early_block_flow_not_supportive");
      addUnique(hardReasons, "flow not supportive");
    }

    if (!EARLY_ENTRY_MAX_BODY_WEAKNESS_ALLOW && bounceBodyPct < 0.08) {
      addUnique(reasons, "early_block_weak_bounce_body");
      addUnique(hardReasons, "weak bounce body");
    }

    if (bounceCloseInRangePct > 0 && bounceCloseInRangePct < 15) {
      addUnique(reasons, "early_block_very_weak_close_in_range");
      addUnique(hardReasons, "very weak close in range");
    }

    if (hardReasons.length > 0) {
      dlog(
        `🚦 ENTRYCHK LONG | mode=early close=${close.toFixed(4)} trigger=${triggerPrice.toFixed(
          4
        )} reclaimPct=${reclaimPctFromTrigger.toFixed(3)} oiTrend=${oiTrend} ` +
          `ema8=${ema8.toFixed(4)} ema18=${ema18.toFixed(4)} ema50=${ema50.toFixed(4)} ` +
          `regime=${regime} ok=0 reasons=${reasons.join(",")} score=${score}`
      );
      return base;
    }

    if (score < SCORE_EARLY_TREND_LONG_MIN) {
      addUnique(reasons, "early_block_score_too_low");
      addUnique(softReasons, "score too low");
      return base;
    }

    addUnique(reasons, "entry_allowed");

    dlog(
      `🚦 ENTRYCHK LONG | mode=early close=${close.toFixed(4)} trigger=${triggerPrice.toFixed(
        4
      )} reclaimPct=${reclaimPctFromTrigger.toFixed(3)} oiTrend=${oiTrend} ` +
        `ema8=${ema8.toFixed(4)} ema18=${ema18.toFixed(4)} ema50=${ema50.toFixed(4)} ` +
        `regime=${regime} ok=1 reasons=${reasons.join(",")} score=${score}`
    );

    return {
      allowed: true,
      mode: "early_trend_long",
      score,
      chasePct,
      reasons,
      hardReasons,
      softReasons,
      patch: {
        lastEntryMode: "early_trend_long",
        entryCandidatePrice,
        chasePct,
        reasons: [`entry allowed | mode=early_trend_long score=${score}`],
      },
    };
  }

  addUnique(reasons, `breakout phase=${phase}`);
  addUnique(hardReasons, "not in ready/early-entry phase");
  return base;
}

export default {
  BRAIN_VERSION,
  buildEntryDecision,
};
