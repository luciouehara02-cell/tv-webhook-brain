/**
 * setupEngine.js
 * Brain Phase 5 v5.5
 *
 * LONG breakout tightening:
 * - READY long requires true reclaim
 * - READY long blocked if OI flow not supportive (when enabled)
 * - No positive score for shallow_pullback_ok
 * - Stronger close quality required for READY
 * - Contradictory weak/strong flags do not accumulate together
 * - Score caps prevent weak reclaim / weak OI from being rescued
 */

export const BRAIN_VERSION = "Brain Phase 5 v5.5";

// ---------------------------
// Helpers
// ---------------------------
function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function pctFrom(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0;
  return ((a - b) / b) * 100;
}

function addUnique(arr, item) {
  if (!arr.includes(item)) arr.push(item);
}

function removeByPrefix(arr, prefix) {
  return arr.filter(x => !x.startsWith(prefix));
}

function setQualityFlag(arr, family, value) {
  const next = removeByPrefix(arr, `${family}:`);
  next.push(`${family}:${value}`);
  return next;
}

function boolEnv(name, def = false) {
  const raw = String(process.env[name] ?? (def ? "1" : "0")).trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function numEnv(name, def) {
  const x = Number(process.env[name]);
  return Number.isFinite(x) ? x : def;
}

// ---------------------------
// Config
// ---------------------------
const DEBUG = boolEnv("DEBUG", true);

const READY_RECLAIM_MIN_PCT = numEnv("READY_RECLAIM_MIN_PCT", 0.05);
// Optional alternative if you later want softer reclaim:
// const READY_RECLAIM_MIN_PCT = numEnv("READY_RECLAIM_MIN_PCT", 0.03);

const BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE = boolEnv(
  "BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE",
  true
);

const BREAKOUT_CLOSE_BELOW_TRIGGER_TOL_PCT = numEnv(
  "BREAKOUT_CLOSE_BELOW_TRIGGER_TOL_PCT",
  0.00
);

const READY_MIN_BOUNCE_CLOSE_IN_RANGE_PCT = numEnv(
  "READY_MIN_BOUNCE_CLOSE_IN_RANGE_PCT",
  60
);

const READY_MIN_BOUNCE_BODY_PCT = numEnv(
  "READY_MIN_BOUNCE_BODY_PCT",
  0.08
);

const SCORE_READY_LONG_MIN = numEnv("SCORE_READY_LONG_MIN", 6);

// ---------------------------
// Logging
// ---------------------------
function dlog(...args) {
  if (DEBUG) console.log(...args);
}

// ---------------------------
// Quality resolution
// ---------------------------
function resolveBreakoutQualityFlags({
  bounceCloseInRangePct,
  bounceBodyPct,
  reclaimPctFromTrigger,
  pullbackDepthPct,
  retestRespectPct
}) {
  let flags = [];

  // Close quality: exactly one family result
  if (bounceCloseInRangePct >= 75) {
    flags = setQualityFlag(flags, "close_quality", "strong");
  } else if (bounceCloseInRangePct >= 60) {
    flags = setQualityFlag(flags, "close_quality", "ok");
  } else {
    flags = setQualityFlag(flags, "close_quality", "weak");
  }

  // Body quality: exactly one family result
  if (bounceBodyPct >= 0.15) {
    flags = setQualityFlag(flags, "body_quality", "strong");
  } else if (bounceBodyPct >= READY_MIN_BOUNCE_BODY_PCT) {
    flags = setQualityFlag(flags, "body_quality", "ok");
  } else {
    flags = setQualityFlag(flags, "body_quality", "weak");
  }

  // Reclaim quality: exactly one family result
  if (reclaimPctFromTrigger >= 0.10) {
    flags = setQualityFlag(flags, "reclaim_quality", "strong");
  } else if (reclaimPctFromTrigger >= READY_RECLAIM_MIN_PCT) {
    flags = setQualityFlag(flags, "reclaim_quality", "ok");
  } else {
    flags = setQualityFlag(flags, "reclaim_quality", "weak");
  }

  // Pullback depth: informational only, not contradictory stack
  if (Number.isFinite(pullbackDepthPct)) {
    if (pullbackDepthPct <= 0.45) {
      flags = setQualityFlag(flags, "pullback_depth", "shallow");
    } else if (pullbackDepthPct <= 1.00) {
      flags = setQualityFlag(flags, "pullback_depth", "normal");
    } else {
      flags = setQualityFlag(flags, "pullback_depth", "deep");
    }
  }

  // Retest respect
  if (Number.isFinite(retestRespectPct)) {
    if (retestRespectPct >= 0.15) {
      flags = setQualityFlag(flags, "retest_respect", "strong");
    } else if (retestRespectPct >= 0.00) {
      flags = setQualityFlag(flags, "retest_respect", "ok");
    } else {
      flags = setQualityFlag(flags, "retest_respect", "weak");
    }
  }

  return flags;
}

function hasFlag(flags, exact) {
  return flags.includes(exact);
}

// ---------------------------
// Score engine
// ---------------------------
function computeBreakoutLongScore({ feat, setup, flags }) {
  let score = 0;
  const reasons = [];

  const regime = String(feat.regime || "range");
  const adx = n(feat.adx);
  const atrPct = n(feat.atrPct);
  const ema8 = n(feat.ema8);
  const ema18 = n(feat.ema18);
  const ema50 = n(feat.ema50);
  const close = n(feat.close);
  const oiTrend = n(feat.oiTrend);
  const cvdTrend = n(feat.cvdTrend);
  const reclaimPctFromTrigger = n(setup.reclaimPctFromTrigger);

  // Trend alignment
  if (regime === "trend") {
    score += 2;
    addUnique(reasons, "trend_regime");
  } else {
    score -= 2;
    addUnique(reasons, "non_trend_regime");
  }

  if (ema8 > ema18 && ema18 >= ema50) {
    score += 2;
    addUnique(reasons, "ema_bull_aligned");
  } else if (ema8 > ema18) {
    score += 1;
    addUnique(reasons, "ema_short_bull");
  } else {
    score -= 2;
    addUnique(reasons, "ema_not_bull");
  }

  // ADX / ATR
  if (adx >= 25) {
    score += 2;
    addUnique(reasons, "adx_strong");
  } else if (adx >= 20) {
    score += 1;
    addUnique(reasons, "adx_ok");
  } else {
    score -= 1;
    addUnique(reasons, "adx_soft");
  }

  if (atrPct >= 0.60) {
    score += 1;
    addUnique(reasons, "atr_expanded");
  } else if (atrPct < 0.18) {
    score -= 1;
    addUnique(reasons, "atr_too_small");
  }

  // Flow
  if (oiTrend > 0) {
    score += 1;
    addUnique(reasons, "oi_supportive");
  } else if (oiTrend < 0) {
    score -= 2;
    addUnique(reasons, "oi_negative");
  } else {
    score -= 1;
    addUnique(reasons, "oi_flat");
  }

  if (cvdTrend > 0) {
    score += 1;
    addUnique(reasons, "cvd_supportive");
  } else if (cvdTrend < 0) {
    score -= 1;
    addUnique(reasons, "cvd_negative");
  }

  // Quality flags
  if (hasFlag(flags, "close_quality:strong")) {
    score += 2;
    addUnique(reasons, "close_quality_strong");
  } else if (hasFlag(flags, "close_quality:ok")) {
    score += 1;
    addUnique(reasons, "close_quality_ok");
  } else if (hasFlag(flags, "close_quality:weak")) {
    score -= 2;
    addUnique(reasons, "close_quality_weak");
  }

  if (hasFlag(flags, "body_quality:strong")) {
    score += 1;
    addUnique(reasons, "body_quality_strong");
  } else if (hasFlag(flags, "body_quality:ok")) {
    score += 0;
    addUnique(reasons, "body_quality_ok");
  } else if (hasFlag(flags, "body_quality:weak")) {
    score -= 2;
    addUnique(reasons, "body_quality_weak");
  }

  if (hasFlag(flags, "reclaim_quality:strong")) {
    score += 2;
    addUnique(reasons, "reclaim_quality_strong");
  } else if (hasFlag(flags, "reclaim_quality:ok")) {
    score += 1;
    addUnique(reasons, "reclaim_quality_ok");
  } else if (hasFlag(flags, "reclaim_quality:weak")) {
    score -= 3;
    addUnique(reasons, "reclaim_quality_weak");
  }

  // IMPORTANT: shallow pullback no longer adds positive score
  if (setup.shallowPullbackOk) {
    addUnique(reasons, "shallow_pullback_ok");
  }

  // If close is below trigger, penalize
  if (close < n(setup.triggerPrice)) {
    score -= 3;
    addUnique(reasons, "close_below_trigger");
  }

  // Small reclaim is explicitly weak
  if (reclaimPctFromTrigger < READY_RECLAIM_MIN_PCT) {
    score -= 2;
    addUnique(reasons, "reclaim_below_min");
  }

  return { score, reasons };
}

function applyBreakoutLongScoreCaps({ score, feat, setup }) {
  let capped = score;

  const close = n(feat.close);
  const triggerPrice = n(setup.triggerPrice);
  const oiTrend = n(feat.oiTrend);
  const reclaimPctFromTrigger = n(setup.reclaimPctFromTrigger);

  // A weak reclaim or below-trigger close cannot be rescued by score inflation
  if (close < triggerPrice) capped = Math.min(capped, 5);
  if (reclaimPctFromTrigger < READY_RECLAIM_MIN_PCT) capped = Math.min(capped, 5);
  if (BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE && oiTrend <= 0) capped = Math.min(capped, 5);

  return capped;
}

// ---------------------------
// READY gating
// ---------------------------
function canPromoteBreakoutLongToReady({ feat, setup }) {
  const reasons = [];

  const close = n(feat.close);
  const triggerPrice = n(setup.triggerPrice);
  const oiTrend = n(feat.oiTrend);

  const reclaimPctFromTrigger = Number.isFinite(setup.reclaimPctFromTrigger)
    ? n(setup.reclaimPctFromTrigger)
    : pctFrom(close, triggerPrice);

  const bounceCloseInRangePct = n(setup.bounceCloseInRangePct);
  const bounceBodyPct = n(setup.bounceBodyPct);

  const minCloseAllowed =
    triggerPrice * (1 - BREAKOUT_CLOSE_BELOW_TRIGGER_TOL_PCT / 100);

  // true reclaim required
  if (close < minCloseAllowed) {
    reasons.push("ready_block_close_below_trigger");
  }

  if (reclaimPctFromTrigger < READY_RECLAIM_MIN_PCT) {
    reasons.push("ready_block_reclaim_too_small");
  }

  // OI flow support required when enabled
  if (BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE && oiTrend <= 0) {
    reasons.push("ready_block_flow_not_supportive");
  }

  // stronger candle quality required
  if (bounceCloseInRangePct < READY_MIN_BOUNCE_CLOSE_IN_RANGE_PCT) {
    reasons.push("ready_block_weak_close_in_range");
  }

  if (bounceBodyPct < READY_MIN_BOUNCE_BODY_PCT) {
    reasons.push("ready_block_weak_bounce_body");
  }

  return {
    ok: reasons.length === 0,
    reasons,
    reclaimPctFromTrigger
  };
}

// ---------------------------
// Main breakout evaluator
// ---------------------------
export function evaluateBreakoutLongSetup({ feat, setup }) {
  const close = n(feat.close);
  const triggerPrice = n(setup.triggerPrice);

  const nextSetup = {
    ...setup,
    side: "long",
    setupType: "breakout_long",
    triggerPrice,
    reclaimPctFromTrigger: Number.isFinite(setup.reclaimPctFromTrigger)
      ? n(setup.reclaimPctFromTrigger)
      : pctFrom(close, triggerPrice),
    bounceCloseInRangePct: n(setup.bounceCloseInRangePct),
    bounceBodyPct: n(setup.bounceBodyPct),
    pullbackDepthPct: Number.isFinite(setup.pullbackDepthPct)
      ? n(setup.pullbackDepthPct)
      : undefined,
    retestRespectPct: Number.isFinite(setup.retestRespectPct)
      ? n(setup.retestRespectPct)
      : undefined
  };

  const flags = resolveBreakoutQualityFlags({
    bounceCloseInRangePct: nextSetup.bounceCloseInRangePct,
    bounceBodyPct: nextSetup.bounceBodyPct,
    reclaimPctFromTrigger: nextSetup.reclaimPctFromTrigger,
    pullbackDepthPct: nextSetup.pullbackDepthPct,
    retestRespectPct: nextSetup.retestRespectPct
  });

  const scorePack = computeBreakoutLongScore({
    feat,
    setup: nextSetup,
    flags
  });

  const effectiveScore = applyBreakoutLongScoreCaps({
    score: scorePack.score,
    feat,
    setup: nextSetup
  });

  const readyCheck = canPromoteBreakoutLongToReady({
    feat,
    setup: nextSetup
  });

  const readyEligible =
    readyCheck.ok &&
    String(feat.regime || "range") === "trend" &&
    n(feat.ema8) > n(feat.ema18) &&
    effectiveScore >= SCORE_READY_LONG_MIN;

  const readyReasons = [...scorePack.reasons];
  for (const f of flags) addUnique(readyReasons, f);
  for (const r of readyCheck.reasons) addUnique(readyReasons, r);

  dlog(
    `🟦 READYCHK LONG | close=${close.toFixed(4)} trigger=${triggerPrice.toFixed(4)} ` +
      `reclaimPct=${nextSetup.reclaimPctFromTrigger.toFixed(3)} oiTrend=${n(feat.oiTrend)} ` +
      `closeInRange=${nextSetup.bounceCloseInRangePct.toFixed(2)} ` +
      `bodyPct=${nextSetup.bounceBodyPct.toFixed(3)} ` +
      `scoreRaw=${scorePack.score} scoreEff=${effectiveScore} ` +
      `ready=${readyEligible ? 1 : 0} reasons=${readyCheck.reasons.join(",") || "pass"}`
  );

  return {
    ...nextSetup,
    flags,
    scoreRaw: scorePack.score,
    score: effectiveScore,
    reasons: readyReasons,
    readyCheck,
    readyEligible,
    readyState: readyEligible ? "ready" : "watch"
  };
}

// ---------------------------
// State promotion helper
// ---------------------------
export function maybePromoteBreakoutLongReady({ state, feat, setupEval, nowMs }) {
  const next = { ...state };

  if (!setupEval?.readyEligible) {
    next.readyOn = false;

    // keep setup alive in watch state; do not consume here
    next.setup = {
      ...(next.setup || {}),
      ...setupEval,
      phase: "watch",
      updatedAtMs: nowMs
    };

    return {
      state: next,
      promoted: false,
      reasons: setupEval?.readyCheck?.reasons || ["not_ready"]
    };
  }

  next.readyOn = true;
  next.readySide = "long";
  next.readyAtMs = nowMs;
  next.readyTriggerPrice = n(setupEval.triggerPrice);
  next.reclaimPctFromTrigger = n(setupEval.reclaimPctFromTrigger);

  next.setup = {
    ...(next.setup || {}),
    ...setupEval,
    phase: "ready",
    updatedAtMs: nowMs
  };

  return {
    state: next,
    promoted: true,
    reasons: ["ready_long_promoted"]
  };
}

export default {
  BRAIN_VERSION,
  evaluateBreakoutLongSetup,
  maybePromoteBreakoutLongReady
};
