/**
 * setupEngine.js
 * Brain Phase 5 v5.5
 *
 * Contract for current brain.js:
 *   const breakoutResult = runBreakoutSetup(getState());
 *   breakoutResult => { patch, note }
 *
 * v5.5:
 * - keep strict READY gating
 * - true reclaim required
 * - remove positive score for shallow_pullback_ok
 * - prevent weak/strong contradictory quality stacking
 * - add early-trend-compatible bounce scoring so good continuation setups
 *   can still progress even when candle body is not ideal
 */

export const BRAIN_VERSION = "Brain Phase 5 v5.5";

// ---------------------------
// helpers
// ---------------------------
function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function isNum(v) {
  return Number.isFinite(Number(v));
}

function pctFrom(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0;
  return ((a - b) / b) * 100;
}

function boolEnv(name, def = false) {
  const raw = String(process.env[name] ?? (def ? "1" : "0")).trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function numEnv(name, def) {
  const x = Number(process.env[name]);
  return Number.isFinite(x) ? x : def;
}

function addUnique(arr, item) {
  if (!arr.includes(item)) arr.push(item);
}

function removeByPrefix(arr, prefix) {
  return arr.filter(x => !x.startsWith(prefix));
}

function setFamilyFlag(arr, family, value) {
  const next = removeByPrefix(arr, `${family}:`);
  next.push(`${family}:${value}`);
  return next;
}

function phaseOf(state) {
  return state?.setups?.breakout?.phase ?? "idle";
}

function breakoutOf(state) {
  return state?.setups?.breakout ?? {};
}

function featOf(state) {
  return state?.features ?? {};
}

function ctxOf(state) {
  return state?.context ?? {};
}

function metaOf(state) {
  return state?.meta ?? {};
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

const READY_RECLAIM_MIN_PCT = numEnv("READY_RECLAIM_MIN_PCT", 0.05);
const EARLY_ENTRY_RECLAIM_MIN_PCT = numEnv("EARLY_ENTRY_RECLAIM_MIN_PCT", 0.05);

const BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE = boolEnv(
  "BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE",
  true
);

// for READY phase only
const READY_BLOCK_ON_NEGATIVE_OI = boolEnv("READY_BLOCK_ON_NEGATIVE_OI", true);

// weaker handling for early trend path
const EARLY_ENTRY_ALLOW_NEGATIVE_OI = boolEnv("EARLY_ENTRY_ALLOW_NEGATIVE_OI", true);

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

const BREAKOUT_MIN_IMPULSE_PCT = numEnv("BREAKOUT_MIN_IMPULSE_PCT", 0.18);
const BREAKOUT_MIN_ADX = numEnv("BREAKOUT_MIN_ADX", 20);
const BREAKOUT_RETEST_MAX_PULLBACK_PCT = numEnv("BREAKOUT_RETEST_MAX_PULLBACK_PCT", 1.20);
const BREAKOUT_BOUNCE_MIN_PCT = numEnv("BREAKOUT_BOUNCE_MIN_PCT", 0.03);

const SCORE_READY_LONG_MIN = numEnv("SCORE_READY_LONG_MIN", 6);
const SCORE_EARLY_TREND_LONG_MIN = numEnv("SCORE_EARLY_TREND_LONG_MIN", 5);

// ---------------------------
// logging
// ---------------------------
function dlog(...args) {
  if (DEBUG) console.log(...args);
}

// ---------------------------
// quality
// ---------------------------
function resolveQualityFlags({
  bounceCloseInRangePct,
  bounceBodyPct,
  reclaimPctFromTrigger,
  pullbackPct,
}) {
  let flags = [];

  if (bounceCloseInRangePct >= 75) {
    flags = setFamilyFlag(flags, "close_quality", "strong");
  } else if (bounceCloseInRangePct >= READY_MIN_BOUNCE_CLOSE_IN_RANGE_PCT) {
    flags = setFamilyFlag(flags, "close_quality", "ok");
  } else {
    flags = setFamilyFlag(flags, "close_quality", "weak");
  }

  if (bounceBodyPct >= 0.15) {
    flags = setFamilyFlag(flags, "body_quality", "strong");
  } else if (bounceBodyPct >= READY_MIN_BOUNCE_BODY_PCT) {
    flags = setFamilyFlag(flags, "body_quality", "ok");
  } else {
    flags = setFamilyFlag(flags, "body_quality", "weak");
  }

  if (reclaimPctFromTrigger >= 0.10) {
    flags = setFamilyFlag(flags, "reclaim_quality", "strong");
  } else if (reclaimPctFromTrigger >= READY_RECLAIM_MIN_PCT) {
    flags = setFamilyFlag(flags, "reclaim_quality", "ok");
  } else {
    flags = setFamilyFlag(flags, "reclaim_quality", "weak");
  }

  if (isNum(pullbackPct)) {
    if (n(pullbackPct) <= 0.45) {
      flags = setFamilyFlag(flags, "pullback_depth", "shallow");
    } else if (n(pullbackPct) <= 1.00) {
      flags = setFamilyFlag(flags, "pullback_depth", "normal");
    } else {
      flags = setFamilyFlag(flags, "pullback_depth", "deep");
    }
  }

  return flags;
}

function hasFlag(flags, exact) {
  return Array.isArray(flags) && flags.includes(exact);
}

// ---------------------------
// scoring
// ---------------------------
function computeScore(state, candidate) {
  const feat = featOf(state);
  const reasons = [];
  let score = 0;

  const regime = String(ctxOf(state).regime ?? feat.regime ?? "range");
  const adx = n(feat.adx);
  const atrPct = n(feat.atrPct);
  const ema8 = n(feat.ema8);
  const ema18 = n(feat.ema18);
  const ema50 = n(feat.ema50);
  const oiTrend = n(feat.oiTrend);
  const cvdTrend = n(feat.cvdTrend);
  const close = n(feat.close);

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
  } else if (adx >= BREAKOUT_MIN_ADX) {
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

  // OI less absolute in v5.5; still meaningful but not always fatal
  if (oiTrend > 0) {
    score += 1;
    addUnique(reasons, "oi_supportive");
  } else if (oiTrend < 0) {
    score -= 1;
    addUnique(reasons, "oi_negative");
  } else {
    score -= 0;
    addUnique(reasons, "oi_flat");
  }

  if (cvdTrend > 0) {
    score += 1;
    addUnique(reasons, "cvd_supportive");
  } else if (cvdTrend < 0) {
    score -= 1;
    addUnique(reasons, "cvd_negative");
  }

  const flags = candidate.qualityFlags || [];

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
    // softer than v5.4 so early trend continuation is not over-killed
    score -= 1;
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

  // informational only
  if (candidate.shallowPullbackOk) {
    addUnique(reasons, "shallow_pullback_ok");
  }

  if (close < n(candidate.triggerPrice)) {
    score -= 3;
    addUnique(reasons, "close_below_trigger");
  }

  if (n(candidate.reclaimPctFromTrigger) < READY_RECLAIM_MIN_PCT) {
    score -= 2;
    addUnique(reasons, "reclaim_below_min");
  }

  // hard caps remain for truly weak reclaim / below-trigger structure
  if (close < n(candidate.triggerPrice)) score = Math.min(score, 5);
  if (n(candidate.reclaimPctFromTrigger) < READY_RECLAIM_MIN_PCT) score = Math.min(score, 5);

  return { score, reasons };
}

// ---------------------------
// candidate building
// ---------------------------
function buildIdleCandidate(state) {
  const feat = featOf(state);
  const ctx = ctxOf(state);
  const close = n(feat.close);
  const adx = n(feat.adx);
  const ema18 = n(feat.ema18);

  const bullAligned = isBullAligned(feat);
  const impulsePct = pctFrom(close, ema18);
  const regime = String(ctx.regime ?? feat.regime ?? "range");

  const reasons = [];

  if (!isTrendRegime(regime)) reasons.push("regime=range");
  if (!bullAligned) reasons.push("bullAligned=false");
  if (impulsePct < BREAKOUT_MIN_IMPULSE_PCT) {
    reasons.push(`impulsePct=${impulsePct.toFixed(3)} < min=${BREAKOUT_MIN_IMPULSE_PCT}`);
  }
  if (adx < BREAKOUT_MIN_ADX) reasons.push(`adx=${adx.toFixed(2)} < min=${BREAKOUT_MIN_ADX}`);

  if (!isTrendRegime(regime) || !bullAligned || impulsePct < BREAKOUT_MIN_IMPULSE_PCT || adx < BREAKOUT_MIN_ADX) {
    return {
      ok: false,
      note: `idle no breakout | ${reasons.join(", ") || "conditions not met"}`,
    };
  }

  const triggerPrice = close;
  const invalidationPrice = Math.min(n(feat.ema18), n(feat.ema50)) * 0.995;

  return {
    ok: true,
    candidate: {
      phase: "retest_pending",
      startedBar: metaOf(state).barIndex ?? null,
      phaseBar: metaOf(state).barIndex ?? null,
      triggerPrice,
      breakoutLevel: triggerPrice,
      retestPrice: null,
      bouncePrice: null,
      score: 0,
      reasons: ["initial breakout detected"],
      lastTransition: "idle_to_retest_pending",
      setupId: `brk-${state.market?.symbol ?? "na"}-${state.market?.time ?? Date.now()}`,
      retestLow: null,
      invalidationPrice,
      readySinceBar: null,
      expiresAtBar: null,
      bouncePct: null,
      pullbackPct: null,
      chasePct: null,
      qualityFlags: [],
      cancelReason: null,
      consumedAtBar: null,
      bounceBodyPct: null,
      bounceCloseInRangePct: null,
      reclaimPctFromTrigger: 0,
      reentryCount: 0,
      lastEntryMode: null,
      entryCandidatePrice: null,
      shallowPullbackOk: false,
    },
    note: `new breakout candidate | impulsePct=${impulsePct.toFixed(3)} adx=${adx.toFixed(2)}`
  };
}

function buildRetestPendingCandidate(state, current) {
  const feat = featOf(state);
  const close = n(feat.close);
  const low = isNum(feat.low) ? n(feat.low) : close;
  const triggerPrice = n(current.triggerPrice);

  const pullbackPct = pctFrom(triggerPrice, close);
  const retestLow = Math.min(isNum(current.retestLow) ? n(current.retestLow) : Infinity, low);

  const next = {
    ...current,
    retestPrice: close,
    retestLow: Number.isFinite(retestLow) ? retestLow : low,
    pullbackPct,
    phaseBar: metaOf(state).barIndex ?? current.phaseBar ?? null,
  };

  if (close > triggerPrice || Math.abs(close - triggerPrice) < 1e-9) {
    return {
      candidate: {
        ...next,
        phase: "bounce_confirmed",
        bouncePrice: close,
        bouncePct: pctFrom(close, triggerPrice),
        lastTransition: "retest_pending_to_bounce_confirmed",
        reasons: ["retest held and bounced above trigger"],
      },
      note: "retest held -> bounce confirmed",
    };
  }

  if (pullbackPct > BREAKOUT_RETEST_MAX_PULLBACK_PCT) {
    return {
      candidate: {
        ...next,
        phase: "idle",
        cancelReason: "retest_too_deep",
        reasons: [`retest too deep pullbackPct=${pullbackPct.toFixed(3)}`],
        lastTransition: "retest_pending_to_idle",
      },
      note: `retest invalidated | pullbackPct=${pullbackPct.toFixed(3)} > max=${BREAKOUT_RETEST_MAX_PULLBACK_PCT}`,
    };
  }

  return {
    candidate: {
      ...next,
      reasons: ["waiting retest / reclaim"],
      lastTransition: "retest_pending_hold",
    },
    note: `retest pending | close=${close.toFixed(4)} trigger=${triggerPrice.toFixed(4)}`
  };
}

function buildBounceConfirmedCandidate(state, current) {
  const feat = featOf(state);
  const ctx = ctxOf(state);

  const close = n(feat.close);
  const open = isNum(feat.open) ? n(feat.open) : close;
  const high = isNum(feat.high) ? n(feat.high) : Math.max(open, close);
  const low = isNum(feat.low) ? n(feat.low) : Math.min(open, close);

  const triggerPrice = n(current.triggerPrice);
  const range = Math.max(high - low, 0);

  const bounceBodyPct = open !== 0 ? Math.abs((close - open) / open) * 100 : 0;
  const bounceCloseInRangePct =
    range > 0 ? ((close - low) / range) * 100 : close >= open ? 100 : 0;

  const reclaimPctFromTrigger = pctFrom(close, triggerPrice);
  const pullbackPct = isNum(current.pullbackPct)
    ? n(current.pullbackPct)
    : pctFrom(triggerPrice, low);

  const shallowPullbackOk = pullbackPct <= 0.45;

  const qualityFlags = resolveQualityFlags({
    bounceCloseInRangePct,
    bounceBodyPct,
    reclaimPctFromTrigger,
    pullbackPct,
  });

  const next = {
    ...current,
    phase: "bounce_confirmed",
    bouncePrice: close,
    bouncePct: pctFrom(close, triggerPrice),
    pullbackPct,
    bounceBodyPct,
    bounceCloseInRangePct,
    reclaimPctFromTrigger,
    qualityFlags,
    shallowPullbackOk,
    reasons: ["bounce confirmed"],
    lastTransition: "bounce_confirmed_hold",
    entryCandidatePrice: close,
  };

  const scorePack = computeScore(state, next);

  const scored = {
    ...next,
    score: scorePack.score,
    reasons: scorePack.reasons,
  };

  const readyReasons = [];
  const earlyReasons = [];

  const minCloseAllowed =
    triggerPrice * (1 - BREAKOUT_CLOSE_BELOW_TRIGGER_TOL_PCT / 100);

  const oiTrend = n(feat.oiTrend);
  const regime = String(ctx.regime ?? feat.regime ?? "range");
  const bullAligned = isBullAligned(feat);

  // common structural blockers
  if (close < minCloseAllowed) {
    readyReasons.push("ready_block_close_below_trigger");
    earlyReasons.push("early_block_close_below_trigger");
  }

  if (reclaimPctFromTrigger < READY_RECLAIM_MIN_PCT) {
    readyReasons.push("ready_block_reclaim_too_small");
  }

  if (reclaimPctFromTrigger < EARLY_ENTRY_RECLAIM_MIN_PCT) {
    earlyReasons.push("early_block_reclaim_too_small");
  }

  if (!isTrendRegime(regime)) {
    readyReasons.push("ready_block_not_trend_regime");
    earlyReasons.push("early_block_not_trend_regime");
  }

  if (!bullAligned) {
    readyReasons.push("ready_block_ema_not_bull_aligned");
    earlyReasons.push("early_block_ema_not_bull_aligned");
  }

  // strict READY path
  if (BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE && READY_BLOCK_ON_NEGATIVE_OI && oiTrend <= 0) {
    readyReasons.push("ready_block_flow_not_supportive");
  }

  if (bounceCloseInRangePct < READY_MIN_BOUNCE_CLOSE_IN_RANGE_PCT) {
    readyReasons.push("ready_block_weak_close_in_range");
  }

  if (bounceBodyPct < READY_MIN_BOUNCE_BODY_PCT) {
    readyReasons.push("ready_block_weak_bounce_body");
  }

  if (scored.score < SCORE_READY_LONG_MIN) {
    readyReasons.push("ready_block_score_too_low");
  }

  // softer EARLY TREND path
  if (BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE && !EARLY_ENTRY_ALLOW_NEGATIVE_OI && oiTrend <= 0) {
    earlyReasons.push("early_block_flow_not_supportive");
  }

  if (bouncePctFromTriggerTooSmall(scored)) {
    earlyReasons.push("early_block_bounce_too_small");
  }

  if (scored.score < SCORE_EARLY_TREND_LONG_MIN) {
    earlyReasons.push("early_block_score_too_low");
  }

  dlog(
    `🟦 READYCHK LONG | close=${close.toFixed(4)} trigger=${triggerPrice.toFixed(4)} ` +
      `reclaimPct=${reclaimPctFromTrigger.toFixed(3)} oiTrend=${oiTrend} ` +
      `closeInRange=${bounceCloseInRangePct.toFixed(2)} bodyPct=${bounceBodyPct.toFixed(3)} ` +
      `score=${scored.score} readyOk=${readyReasons.length === 0 ? 1 : 0} earlyOk=${earlyReasons.length === 0 ? 1 : 0} ` +
      `readyReasons=${readyReasons.join(",") || "pass"} earlyReasons=${earlyReasons.join(",") || "pass"}`
  );

  if (readyReasons.length === 0) {
    return {
      candidate: {
        ...scored,
        phase: "ready",
        readySinceBar: metaOf(state).barIndex ?? null,
        lastEntryMode: null,
        reasons: [...scored.reasons, "ready_long_promoted"],
        lastTransition: "bounce_confirmed_to_ready",
      },
      note: "ready promoted after true reclaim",
    };
  }

  // hold in bounce_confirmed; entryEngine can still allow early_trend_long
  return {
    candidate: {
      ...scored,
      phase: "bounce_confirmed",
      reasons: [...scored.reasons, ...readyReasons, ...earlyReasons],
      lastTransition: "bounce_confirmed_hold",
    },
    note: `bounce confirmed but not ready | ${readyReasons.join(", ") || "waiting"}`,
  };
}

function bouncePctFromTriggerTooSmall(candidate) {
  return n(candidate.bouncePct) < BREAKOUT_BOUNCE_MIN_PCT;
}

// ---------------------------
// public runner
// ---------------------------
export function runBreakoutSetup(state) {
  const current = breakoutOf(state);
  const phase = phaseOf(state);

  let result;

  if (phase === "idle") {
    const built = buildIdleCandidate(state);
    if (!built.ok) {
      return { patch: null, note: built.note };
    }
    result = { candidate: built.candidate, note: built.note };
  } else if (phase === "retest_pending") {
    result = buildRetestPendingCandidate(state, current);
  } else if (phase === "bounce_confirmed" || phase === "ready") {
    result = buildBounceConfirmedCandidate(state, current);
  } else if (phase === "consumed") {
    return { patch: null, note: "setup already consumed" };
  } else {
    return { patch: null, note: `unsupported breakout phase=${phase}` };
  }

  const next = result?.candidate;
  if (!next) {
    return { patch: null, note: result?.note ?? "no breakout update" };
  }

  return {
    patch: {
      phase: next.phase ?? current.phase ?? "idle",
      startedBar: next.startedBar ?? current.startedBar ?? null,
      phaseBar: next.phaseBar ?? metaOf(state).barIndex ?? current.phaseBar ?? null,
      triggerPrice: isNum(next.triggerPrice) ? n(next.triggerPrice) : current.triggerPrice ?? null,
      breakoutLevel: isNum(next.breakoutLevel) ? n(next.breakoutLevel) : current.breakoutLevel ?? null,
      retestPrice: isNum(next.retestPrice) ? n(next.retestPrice) : next.retestPrice ?? null,
      bouncePrice: isNum(next.bouncePrice) ? n(next.bouncePrice) : next.bouncePrice ?? null,
      score: isNum(next.score) ? n(next.score) : 0,
      reasons: Array.isArray(next.reasons) ? next.reasons : [],
      lastTransition: next.lastTransition ?? null,
      setupId: next.setupId ?? current.setupId ?? null,
      retestLow: isNum(next.retestLow) ? n(next.retestLow) : next.retestLow ?? null,
      invalidationPrice: isNum(next.invalidationPrice) ? n(next.invalidationPrice) : next.invalidationPrice ?? null,
      readySinceBar: next.readySinceBar ?? null,
      expiresAtBar: next.expiresAtBar ?? null,
      bouncePct: isNum(next.bouncePct) ? n(next.bouncePct) : next.bouncePct ?? null,
      pullbackPct: isNum(next.pullbackPct) ? n(next.pullbackPct) : next.pullbackPct ?? null,
      chasePct: isNum(next.chasePct) ? n(next.chasePct) : next.chasePct ?? null,
      qualityFlags: Array.isArray(next.qualityFlags) ? next.qualityFlags : [],
      cancelReason: next.cancelReason ?? null,
      consumedAtBar: next.consumedAtBar ?? null,
      bounceBodyPct: isNum(next.bounceBodyPct) ? n(next.bounceBodyPct) : next.bounceBodyPct ?? null,
      bounceCloseInRangePct: isNum(next.bounceCloseInRangePct) ? n(next.bounceCloseInRangePct) : next.bounceCloseInRangePct ?? null,
      reclaimPctFromTrigger: isNum(next.reclaimPctFromTrigger) ? n(next.reclaimPctFromTrigger) : next.reclaimPctFromTrigger ?? null,
      reentryCount: isNum(next.reentryCount) ? n(next.reentryCount) : current.reentryCount ?? 0,
      lastEntryMode: next.lastEntryMode ?? current.lastEntryMode ?? null,
      entryCandidatePrice: isNum(next.entryCandidatePrice) ? n(next.entryCandidatePrice) : next.entryCandidatePrice ?? null,
    },
    note: result.note ?? "breakout updated",
  };
}

export default {
  BRAIN_VERSION,
  runBreakoutSetup,
};
