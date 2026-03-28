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
 * - Backward-compatible export: runBreakoutSetup()
 */

export const BRAIN_VERSION = "Brain Phase 5 v5.5";

// ---------------------------
// Helpers
// ---------------------------
function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
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

function isTrendRegime(regime) {
  return String(regime || "").toLowerCase() === "trend";
}

// ---------------------------
// Config
// ---------------------------
const DEBUG = boolEnv("DEBUG", true);

const READY_RECLAIM_MIN_PCT = numEnv("READY_RECLAIM_MIN_PCT", 0.05);

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

  if (bounceCloseInRangePct >= 75) {
    flags = setQualityFlag(flags, "close_quality", "strong");
  } else if (bounceCloseInRangePct >= READY_MIN_BOUNCE_CLOSE_IN_RANGE_PCT) {
    flags = setQualityFlag(flags, "close_quality", "ok");
  } else {
    flags = setQualityFlag(flags, "close_quality", "weak");
  }

  if (bounceBodyPct >= 0.15) {
    flags = setQualityFlag(flags, "body_quality", "strong");
  } else if (bounceBodyPct >= READY_MIN_BOUNCE_BODY_PCT) {
    flags = setQualityFlag(flags, "body_quality", "ok");
  } else {
    flags = setQualityFlag(flags, "body_quality", "weak");
  }

  if (reclaimPctFromTrigger >= 0.10) {
    flags = setQualityFlag(flags, "reclaim_quality", "strong");
  } else if (reclaimPctFromTrigger >= READY_RECLAIM_MIN_PCT) {
    flags = setQualityFlag(flags, "reclaim_quality", "ok");
  } else {
    flags = setQualityFlag(flags, "reclaim_quality", "weak");
  }

  if (Number.isFinite(pullbackDepthPct)) {
    if (pullbackDepthPct <= 0.45) {
      flags = setQualityFlag(flags, "pullback_depth", "shallow");
    } else if (pullbackDepthPct <= 1.0) {
      flags = setQualityFlag(flags, "pullback_depth", "normal");
    } else {
      flags = setQualityFlag(flags, "pullback_depth", "deep");
    }
  }

  if (Number.isFinite(retestRespectPct)) {
    if (retestRespectPct >= 0.15) {
      flags = setQualityFlag(flags, "retest_respect", "strong");
    } else if (retestRespectPct >= 0.0) {
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

  if (isTrendRegime(regime)) {
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

  if (hasFlag(flags, "close_quality:strong")) {
    score += 2;
    addUnique(reasons, "close_quality_strong");
  } else if (hasFlag(flags, "close_quality:ok")) {
    score += 1;
    addUnique(reasons, "close_quality_ok");
  } else {
    score -= 2;
    addUnique(reasons, "close_quality_weak");
  }

  if (hasFlag(flags, "body_quality:strong")) {
    score += 1;
    addUnique(reasons, "body_quality_strong");
  } else if (hasFlag(flags, "body_quality:ok")) {
    addUnique(reasons, "body_quality_ok");
  } else {
    score -= 2;
    addUnique(reasons, "body_quality_weak");
  }

  if (hasFlag(flags, "reclaim_quality:strong")) {
    score += 2;
    addUnique(reasons, "reclaim_quality_strong");
  } else if (hasFlag(flags, "reclaim_quality:ok")) {
    score += 1;
    addUnique(reasons, "reclaim_quality_ok");
  } else {
    score -= 3;
    addUnique(reasons, "reclaim_quality_weak");
  }

  // v5.5: informational only, not positive score
  if (setup.shallowPullbackOk) {
    addUnique(reasons, "shallow_pullback_ok");
  }

  if (close < n(setup.triggerPrice)) {
    score -= 3;
    addUnique(reasons, "close_below_trigger");
  }

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

  const reclaimPctFromTrigger = Number.isFinite(Number(setup.reclaimPctFromTrigger))
    ? n(setup.reclaimPctFromTrigger)
    : pctFrom(close, triggerPrice);

  const bounceCloseInRangePct = n(setup.bounceCloseInRangePct);
  const bounceBodyPct = n(setup.bounceBodyPct);

  const minCloseAllowed =
    triggerPrice * (1 - BREAKOUT_CLOSE_BELOW_TRIGGER_TOL_PCT / 100);

  if (close < minCloseAllowed) {
    reasons.push("ready_block_close_below_trigger");
  }

  if (reclaimPctFromTrigger < READY_RECLAIM_MIN_PCT) {
    reasons.push("ready_block_reclaim_too_small");
  }

  if (BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE && oiTrend <= 0) {
    reasons.push("ready_block_flow_not_supportive");
  }

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
// Core evaluator
// ---------------------------
export function evaluateBreakoutLongSetup({ feat = {}, setup = {} }) {
  const close = n(feat.close);
  const triggerPrice = n(setup.triggerPrice);

  const nextSetup = {
    ...setup,
    side: "long",
    setupType: "breakout_long",
    triggerPrice,
    reclaimPctFromTrigger: Number.isFinite(Number(setup.reclaimPctFromTrigger))
      ? n(setup.reclaimPctFromTrigger)
      : pctFrom(close, triggerPrice),
    bounceCloseInRangePct: n(setup.bounceCloseInRangePct),
    bounceBodyPct: n(setup.bounceBodyPct),
    pullbackDepthPct: Number.isFinite(Number(setup.pullbackDepthPct))
      ? n(setup.pullbackDepthPct)
      : undefined,
    retestRespectPct: Number.isFinite(Number(setup.retestRespectPct))
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
    isTrendRegime(feat.regime) &&
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
// Promotion helper
// ---------------------------
export function maybePromoteBreakoutLongReady({
  state = {},
  feat = {},
  setupEval = {},
  nowMs = Date.now()
}) {
  const next = { ...state };

  if (!setupEval?.readyEligible) {
    next.readyOn = false;

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

// ---------------------------
// Backward-compatible export
// brain.js currently expects this name
//
// This wrapper is intentionally tolerant because I do not yet have
// your exact v5.4 runBreakoutSetup() call contract.
// It returns both setup evaluation and updated state.
// ---------------------------
export function runBreakoutSetup(args = {}) {
  const state = args.state || {};
  const feat = args.feat || args.features || {};
  const nowMs = Number.isFinite(Number(args.nowMs)) ? Number(args.nowMs) : Date.now();

  // Accept either explicit setup candidate or current state.setup
  const setupInput = args.setup || state.setup || {};

  const setupEval = evaluateBreakoutLongSetup({
    feat,
    setup: setupInput
  });

  const promo = maybePromoteBreakoutLongReady({
    state,
    feat,
    setupEval,
    nowMs
  });

  return {
    ...setupEval,
    state: promo.state,
    promoted: promo.promoted,
    promotionReasons: promo.reasons
  };
}

export default {
  BRAIN_VERSION,
  evaluateBreakoutLongSetup,
  maybePromoteBreakoutLongReady,
  runBreakoutSetup
};
