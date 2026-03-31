import { CONFIG } from "./config.js";

/**
 * setupEngine.js
 * Brain Phase 5 v5.6
 *
 * Keeps breakout flow
 * Adds 3m washout logic with delayed-entry filter
 */

export const BRAIN_VERSION = "Brain Phase 5 v5.6";

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

function addUnique(arr, item) {
  if (item && !arr.includes(item)) arr.push(item);
}

function removeByPrefix(arr, prefix) {
  return arr.filter((x) => !x.startsWith(prefix));
}

function setFamilyFlag(arr, family, value) {
  const next = removeByPrefix(arr, `${family}:`);
  next.push(`${family}:${value}`);
  return next;
}

function phaseOf(state) {
  return state?.setups?.breakout?.phase ?? "idle";
}

function setupOf(state) {
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

function historyOf(state) {
  return Array.isArray(state?.history?.bars) ? state.history.bars : [];
}

function isTrendRegime(regime) {
  return String(regime || "").toLowerCase() === "trend";
}

function isBullAligned(feat) {
  return n(feat.ema8) > n(feat.ema18) && n(feat.ema18) >= n(feat.ema50);
}

function computeCandleMetrics(open, high, low, close) {
  const range = Math.max(n(high) - n(low), 0);
  const bodyPct =
    Number.isFinite(open) && open !== 0 && Number.isFinite(close)
      ? (Math.abs(close - open) / open) * 100
      : 0;

  const closeInRangePct =
    range > 0 ? ((n(close) - n(low)) / range) * 100 : close >= open ? 100 : 0;

  return { range, bodyPct, closeInRangePct };
}

function buildSetupId(prefix, state) {
  return `${prefix}-${state.market?.symbol ?? "na"}-${state.market?.time ?? Date.now()}`;
}

// ---------------------------
// breakout scoring
// ---------------------------
function resolveBreakoutQualityFlags({
  bounceCloseInRangePct,
  bounceBodyPct,
  reclaimPctFromTrigger,
  pullbackPct,
}) {
  let flags = [];

  if (bounceCloseInRangePct >= 75) {
    flags = setFamilyFlag(flags, "close_quality", "strong");
  } else if (bounceCloseInRangePct >= CONFIG.BREAKOUT_MIN_CLOSE_IN_RANGE_PCT) {
    flags = setFamilyFlag(flags, "close_quality", "ok");
  } else {
    flags = setFamilyFlag(flags, "close_quality", "weak");
  }

  if (bounceBodyPct >= 0.15) {
    flags = setFamilyFlag(flags, "body_quality", "strong");
  } else if (bounceBodyPct >= CONFIG.BREAKOUT_MIN_BOUNCE_BODY_PCT) {
    flags = setFamilyFlag(flags, "body_quality", "ok");
  } else {
    flags = setFamilyFlag(flags, "body_quality", "weak");
  }

  if (reclaimPctFromTrigger >= 0.10) {
    flags = setFamilyFlag(flags, "reclaim_quality", "strong");
  } else if (reclaimPctFromTrigger >= CONFIG.BREAKOUT_MIN_RECLAIM_ABOVE_TRIGGER_PCT) {
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

function computeBreakoutScore(state, candidate) {
  const feat = featOf(state);
  const reasons = [];
  let score = 0;

  const regime = String(ctxOf(state).regime ?? "range");
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
  } else if (adx >= CONFIG.BREAKOUT_MIN_ADX) {
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
    score -= 1;
    addUnique(reasons, "oi_negative");
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

  if (candidate.shallowPullbackOk) {
    addUnique(reasons, "shallow_pullback_ok");
  }

  if (close < n(candidate.triggerPrice)) {
    score -= 3;
    addUnique(reasons, "close_below_trigger");
  }

  if (n(candidate.reclaimPctFromTrigger) < CONFIG.BREAKOUT_MIN_RECLAIM_ABOVE_TRIGGER_PCT) {
    score -= 2;
    addUnique(reasons, "reclaim_below_min");
  }

  if (close < n(candidate.triggerPrice)) score = Math.min(score, 5);
  if (n(candidate.reclaimPctFromTrigger) < CONFIG.BREAKOUT_MIN_RECLAIM_ABOVE_TRIGGER_PCT) {
    score = Math.min(score, 5);
  }

  return { score, reasons };
}

// ---------------------------
// washout scoring
// ---------------------------
function resolveWashoutQualityFlags({
  closeInRangePct,
  bodyPct,
  reclaimPctFromLow,
  baseBars,
  deepWashout,
}) {
  let flags = [];

  if (closeInRangePct >= 75) {
    flags = setFamilyFlag(flags, "wash_close_quality", "strong");
  } else if (closeInRangePct >= CONFIG.WASHOUT_MIN_CLOSE_IN_RANGE_PCT) {
    flags = setFamilyFlag(flags, "wash_close_quality", "ok");
  } else {
    flags = setFamilyFlag(flags, "wash_close_quality", "weak");
  }

  if (bodyPct >= 0.18) {
    flags = setFamilyFlag(flags, "wash_body_quality", "strong");
  } else if (bodyPct >= CONFIG.WASHOUT_MIN_BOUNCE_BODY_PCT) {
    flags = setFamilyFlag(flags, "wash_body_quality", "ok");
  } else {
    flags = setFamilyFlag(flags, "wash_body_quality", "weak");
  }

  const minReclaim = deepWashout
    ? CONFIG.WASHOUT_MIN_RECLAIM_FROM_LOW_PCT_DEEP
    : CONFIG.WASHOUT_MIN_RECLAIM_FROM_LOW_PCT;

  if (reclaimPctFromLow >= minReclaim + 0.35) {
    flags = setFamilyFlag(flags, "wash_reclaim_quality", "strong");
  } else if (reclaimPctFromLow >= minReclaim) {
    flags = setFamilyFlag(flags, "wash_reclaim_quality", "ok");
  } else {
    flags = setFamilyFlag(flags, "wash_reclaim_quality", "weak");
  }

  if (baseBars >= CONFIG.WASHOUT_MIN_BASE_BARS + 2) {
    flags = setFamilyFlag(flags, "wash_base_quality", "strong");
  } else if (baseBars >= CONFIG.WASHOUT_MIN_BASE_BARS) {
    flags = setFamilyFlag(flags, "wash_base_quality", "ok");
  } else {
    flags = setFamilyFlag(flags, "wash_base_quality", "weak");
  }

  return flags;
}

function computeWashoutScore(state, candidate) {
  const feat = featOf(state);
  const ctx = ctxOf(state);

  const close = n(feat.close);
  const ema8 = n(feat.ema8);
  const ema18 = n(feat.ema18);
  const ema50 = n(feat.ema50);
  const rsi = n(feat.rsi);
  const adx = n(feat.adx);
  const oiTrend = n(feat.oiTrend);
  const cvdTrend = n(feat.cvdTrend);

  let score = 0;
  const reasons = [];

  if (candidate.washoutDropPct >= CONFIG.WASHOUT_DEEP_DROP_PCT_MIN) {
    score += 3;
    addUnique(reasons, "deep_washout");
  } else if (candidate.washoutDropPct >= CONFIG.WASHOUT_DROP_PCT_MIN) {
    score += 2;
    addUnique(reasons, "valid_washout");
  }

  if (candidate.baseBars >= CONFIG.WASHOUT_MIN_BASE_BARS + 2) {
    score += 2;
    addUnique(reasons, "base_strong");
  } else if (candidate.baseBars >= CONFIG.WASHOUT_MIN_BASE_BARS) {
    score += 1;
    addUnique(reasons, "base_ok");
  } else {
    score -= 2;
    addUnique(reasons, "base_weak");
  }

  if (close > ema8) {
    score += 2;
    addUnique(reasons, "close_above_ema8");
  } else {
    score -= 1;
    addUnique(reasons, "close_below_ema8");
  }

  if (ema8 > ema18) {
    score += 2;
    addUnique(reasons, "ema8_above_ema18");
  } else if (close > ema18) {
    score += 1;
    addUnique(reasons, "close_above_ema18");
  }

  if (cvdTrend > 0) {
    score += 1;
    addUnique(reasons, "cvd_supportive");
  } else if (cvdTrend < 0) {
    score -= 1;
    addUnique(reasons, "cvd_negative");
  }

  if (oiTrend > 0) {
    score += 1;
    addUnique(reasons, "oi_supportive");
  } else if (oiTrend < 0) {
    score -= 1;
    addUnique(reasons, "oi_negative");
  }

  if (adx >= 18) {
    score += 1;
    addUnique(reasons, "adx_ok");
  }

  if (rsi >= 45 && rsi <= 62) {
    score += 1;
    addUnique(reasons, "rsi_recovery_zone");
  }

  const flags = candidate.qualityFlags || [];

  if (hasFlag(flags, "wash_close_quality:strong")) {
    score += 2;
    addUnique(reasons, "wash_close_quality_strong");
  } else if (hasFlag(flags, "wash_close_quality:ok")) {
    score += 1;
    addUnique(reasons, "wash_close_quality_ok");
  } else {
    score -= 2;
    addUnique(reasons, "wash_close_quality_weak");
  }

  if (hasFlag(flags, "wash_body_quality:strong")) {
    score += 1;
    addUnique(reasons, "wash_body_quality_strong");
  } else if (hasFlag(flags, "wash_body_quality:ok")) {
    addUnique(reasons, "wash_body_quality_ok");
  } else {
    score -= 1;
    addUnique(reasons, "wash_body_quality_weak");
  }

  if (hasFlag(flags, "wash_reclaim_quality:strong")) {
    score += 2;
    addUnique(reasons, "wash_reclaim_quality_strong");
  } else if (hasFlag(flags, "wash_reclaim_quality:ok")) {
    score += 1;
    addUnique(reasons, "wash_reclaim_quality_ok");
  } else {
    score -= 3;
    addUnique(reasons, "wash_reclaim_quality_weak");
  }

  if (String(ctx.regime) === "trend") {
    score += 1;
    addUnique(reasons, "trend_context");
  } else if (String(ctx.regime) === "range") {
    addUnique(reasons, "range_context");
  }

  return { score, reasons };
}

// ---------------------------
// washout detection
// ---------------------------
function detectWashoutCandidate(state) {
  if (!CONFIG.WASHOUT_ENABLED) return null;

  const bars = historyOf(state);
  const feat = featOf(state);

  if (!bars.length) return null;

  const lookback = bars.slice(-CONFIG.WASHOUT_LOOKBACK_BARS);
  if (lookback.length < 4) return null;

  let peakPrice = -Infinity;
  for (const b of lookback) {
    peakPrice = Math.max(peakPrice, n(b.high, n(b.close, -Infinity)));
  }

  const currentLow = n(feat.low, n(feat.close));
  const currentClose = n(feat.close);
  const currentRsi = n(feat.rsi, 50);
  const ema18 = n(feat.ema18);

  const dropPctFromPeak = pctFrom(peakPrice, currentLow);

  if (dropPctFromPeak < CONFIG.WASHOUT_DROP_PCT_MIN) return null;

  if (
    CONFIG.WASHOUT_REQUIRE_CLOSE_BELOW_EMA18_ON_DETECT &&
    !(currentClose < ema18)
  ) {
    return null;
  }

  if (currentRsi > CONFIG.WASHOUT_RSI_MAX_ON_DETECT) return null;

  return {
    peakPrice,
    lowPrice: currentLow,
    dropPctFromPeak,
  };
}

// ---------------------------
// idle entry point
// ---------------------------
function buildIdleCandidate(state) {
  const feat = featOf(state);
  const ctx = ctxOf(state);
  const close = n(feat.close);
  const adx = n(feat.adx);
  const ema18 = n(feat.ema18);

  const wash = detectWashoutCandidate(state);

  if (wash) {
    const currentBar = metaOf(state).barIndex ?? null;

    return {
      ok: true,
      candidate: {
        phase: "washout_monitor",
        startedBar: currentBar,
        phaseBar: currentBar,
        triggerPrice: close,
        breakoutLevel: close,
        retestPrice: null,
        bouncePrice: null,
        score: 0,
        reasons: ["washout detected"],
        lastTransition: "idle_to_washout_monitor",
        setupId: buildSetupId("wash", state),
        retestLow: wash.lowPrice,
        invalidationPrice: wash.lowPrice,
        readySinceBar: null,
        expiresAtBar: currentBar + CONFIG.WASHOUT_MAX_SETUP_BARS,
        bouncePct: null,
        pullbackPct: null,
        chasePct: null,
        qualityFlags: [],
        cancelReason: null,
        consumedAtBar: null,
        bounceBodyPct: null,
        bounceCloseInRangePct: null,
        reclaimPctFromTrigger: null,
        reentryCount: 0,
        lastEntryMode: null,
        entryCandidatePrice: null,

        washoutPeakPrice: wash.peakPrice,
        washoutLow: wash.lowPrice,
        washoutDropPct: wash.dropPctFromPeak,
        washoutDetectedBar: currentBar,
        noBuyUntilBar: currentBar + CONFIG.WASHOUT_NO_BUY_BARS_AFTER_DETECT,
        baseBars: 0,
        deepestLowBar: currentBar,
        reclaimPctFromLow: 0,
        setupType: "washout",
      },
      note: `washout detected | dropPct=${wash.dropPctFromPeak.toFixed(3)} peak=${wash.peakPrice.toFixed(4)} low=${wash.lowPrice.toFixed(4)}`,
    };
  }

  if (!CONFIG.BREAKOUT_ENABLED) {
    return { ok: false, note: "idle | breakout disabled" };
  }

  const bullAligned = isBullAligned(feat);
  const impulsePct = pctFrom(close, ema18);
  const regime = String(ctx.regime ?? "range");

  const reasons = [];

  if (!isTrendRegime(regime)) reasons.push("regime=range");
  if (!bullAligned) reasons.push("bullAligned=false");
  if (impulsePct < CONFIG.BREAKOUT_MIN_IMPULSE_PCT) {
    reasons.push(`impulsePct=${impulsePct.toFixed(3)} < min=${CONFIG.BREAKOUT_MIN_IMPULSE_PCT}`);
  }
  if (adx < CONFIG.BREAKOUT_MIN_ADX) {
    reasons.push(`adx=${adx.toFixed(2)} < min=${CONFIG.BREAKOUT_MIN_ADX}`);
  }

  if (
    !isTrendRegime(regime) ||
    !bullAligned ||
    impulsePct < CONFIG.BREAKOUT_MIN_IMPULSE_PCT ||
    adx < CONFIG.BREAKOUT_MIN_ADX
  ) {
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
      setupId: buildSetupId("brk", state),
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

      washoutPeakPrice: null,
      washoutLow: null,
      washoutDropPct: null,
      washoutDetectedBar: null,
      noBuyUntilBar: null,
      baseBars: 0,
      deepestLowBar: null,
      reclaimPctFromLow: null,
      setupType: "breakout",
    },
    note: `new breakout candidate | impulsePct=${impulsePct.toFixed(3)} adx=${adx.toFixed(2)}`,
  };
}

// ---------------------------
// washout progression
// ---------------------------
function buildWashoutMonitorCandidate(state, current) {
  const feat = featOf(state);
  const barIndex = metaOf(state).barIndex ?? 0;

  const low = n(feat.low, n(feat.close));
  const close = n(feat.close);
  const open = n(feat.open, close);
  const high = n(feat.high, close);

  const currentWashoutLow = isNum(current.washoutLow) ? n(current.washoutLow) : low;
  const newWashoutLow = Math.min(currentWashoutLow, low);

  const newLowTolerancePrice =
    currentWashoutLow * (1 - CONFIG.WASHOUT_NO_NEW_LOW_TOL_PCT / 100);

  let baseBars = n(current.baseBars, 0);
  let deepestLowBar = current.deepestLowBar ?? current.washoutDetectedBar ?? barIndex;

  if (low < currentWashoutLow) {
    baseBars = 0;
    deepestLowBar = barIndex;
  } else if (low >= newLowTolerancePrice) {
    baseBars += 1;
  } else {
    baseBars = 0;
  }

  const reclaimPctFromLow = pctFrom(close, newWashoutLow);
  const { bodyPct, closeInRangePct } = computeCandleMetrics(open, high, low, close);

  const deepWashout =
    n(current.washoutDropPct, 0) >= CONFIG.WASHOUT_DEEP_DROP_PCT_MIN;

  const qualityFlags = resolveWashoutQualityFlags({
    closeInRangePct,
    bodyPct,
    reclaimPctFromLow,
    baseBars,
    deepWashout,
  });

  const next = {
    ...current,
    phaseBar: barIndex,
    retestLow: newWashoutLow,
    invalidationPrice: newWashoutLow,
    washoutLow: newWashoutLow,
    baseBars,
    deepestLowBar,
    reclaimPctFromLow,
    bounceBodyPct: bodyPct,
    bounceCloseInRangePct: closeInRangePct,
    qualityFlags,
    entryCandidatePrice: close,
    reasons: ["washout monitoring"],
    lastTransition: "washout_monitor_hold",
  };

  if (barIndex > n(current.expiresAtBar, barIndex + 1)) {
    return {
      candidate: {
        ...next,
        phase: "idle",
        cancelReason: "washout_expired",
        reasons: ["washout expired"],
        lastTransition: "washout_monitor_to_idle",
      },
      note: "washout expired",
    };
  }

  if (barIndex <= n(current.noBuyUntilBar, barIndex)) {
    return {
      candidate: next,
      note: `washout delay active | noBuyUntilBar=${current.noBuyUntilBar}`,
    };
  }

  return {
    candidate: {
      ...next,
      phase: "washout_base",
      reasons: ["washout base forming"],
      lastTransition: "washout_monitor_to_base",
    },
    note: `washout delay complete -> base forming | baseBars=${baseBars}`,
  };
}

function buildWashoutBaseCandidate(state, current) {
  const feat = featOf(state);
  const barIndex = metaOf(state).barIndex ?? 0;

  const low = n(feat.low, n(feat.close));
  const close = n(feat.close);
  const open = n(feat.open, close);
  const high = n(feat.high, close);
  const ema8 = n(feat.ema8);

  const currentWashoutLow = isNum(current.washoutLow) ? n(current.washoutLow) : low;
  const newWashoutLow = Math.min(currentWashoutLow, low);

  const newLowTolerancePrice =
    currentWashoutLow * (1 - CONFIG.WASHOUT_NO_NEW_LOW_TOL_PCT / 100);

  let baseBars = n(current.baseBars, 0);
  let deepestLowBar = current.deepestLowBar ?? current.washoutDetectedBar ?? barIndex;

  if (low < currentWashoutLow) {
    baseBars = 0;
    deepestLowBar = barIndex;
  } else if (low >= newLowTolerancePrice) {
    baseBars += 1;
  } else {
    baseBars = 0;
  }

  const reclaimPctFromLow = pctFrom(close, newWashoutLow);
  const { bodyPct, closeInRangePct } = computeCandleMetrics(open, high, low, close);

  const deepWashout =
    n(current.washoutDropPct, 0) >= CONFIG.WASHOUT_DEEP_DROP_PCT_MIN;

  const qualityFlags = resolveWashoutQualityFlags({
    closeInRangePct,
    bodyPct,
    reclaimPctFromLow,
    baseBars,
    deepWashout,
  });

  const minReclaim = deepWashout
    ? CONFIG.WASHOUT_MIN_RECLAIM_FROM_LOW_PCT_DEEP
    : CONFIG.WASHOUT_MIN_RECLAIM_FROM_LOW_PCT;

  const reclaimAboveEma8Ok = !CONFIG.WASHOUT_REQUIRE_RECLAIM_ABOVE_EMA8 || close > ema8;
  const closeInRangeOk = closeInRangePct >= CONFIG.WASHOUT_MIN_CLOSE_IN_RANGE_PCT;
  const bodyOk = bodyPct >= CONFIG.WASHOUT_MIN_BOUNCE_BODY_PCT;
  const reclaimOk = reclaimPctFromLow >= minReclaim;
  const baseOk = baseBars >= CONFIG.WASHOUT_MIN_BASE_BARS;

  const next = {
    ...current,
    phaseBar: barIndex,
    retestLow: newWashoutLow,
    invalidationPrice: newWashoutLow,
    washoutLow: newWashoutLow,
    baseBars,
    deepestLowBar,
    reclaimPctFromLow,
    bounceBodyPct: bodyPct,
    bounceCloseInRangePct: closeInRangePct,
    qualityFlags,
    entryCandidatePrice: close,
    reasons: ["washout base forming"],
    lastTransition: "washout_base_hold",
  };

  if (barIndex > n(current.expiresAtBar, barIndex + 1)) {
    return {
      candidate: {
        ...next,
        phase: "idle",
        cancelReason: "washout_expired",
        reasons: ["washout expired"],
        lastTransition: "washout_base_to_idle",
      },
      note: "washout expired",
    };
  }

  if (low < currentWashoutLow) {
    return {
      candidate: {
        ...next,
        phase: "washout_monitor",
        reasons: ["new washout low -> monitoring reset"],
        lastTransition: "washout_base_to_monitor",
      },
      note: "new low after base -> back to monitor",
    };
  }

  if (baseOk && reclaimAboveEma8Ok && closeInRangeOk && bodyOk && reclaimOk) {
    const scored = computeWashoutScore(state, next);

    return {
      candidate: {
        ...next,
        phase: "washout_ready",
        score: scored.score,
        reasons: scored.reasons,
        readySinceBar: barIndex,
        lastTransition: "washout_base_to_ready",
        setupType: "washout",
      },
      note: `washout ready | baseBars=${baseBars} reclaimPctFromLow=${reclaimPctFromLow.toFixed(3)}`,
    };
  }

  return {
    candidate: next,
    note: `washout base waiting | baseBars=${baseBars} reclaimPctFromLow=${reclaimPctFromLow.toFixed(3)}`,
  };
}

function buildWashoutReadyCandidate(state, current) {
  const feat = featOf(state);
  const barIndex = metaOf(state).barIndex ?? 0;

  const low = n(feat.low, n(feat.close));
  const close = n(feat.close);
  const open = n(feat.open, close);
  const high = n(feat.high, close);

  const washoutLow = isNum(current.washoutLow) ? n(current.washoutLow) : low;
  const reclaimPctFromLow = pctFrom(close, washoutLow);
  const { bodyPct, closeInRangePct } = computeCandleMetrics(open, high, low, close);

  const deepWashout =
    n(current.washoutDropPct, 0) >= CONFIG.WASHOUT_DEEP_DROP_PCT_MIN;

  const qualityFlags = resolveWashoutQualityFlags({
    closeInRangePct,
    bodyPct,
    reclaimPctFromLow,
    baseBars: n(current.baseBars, 0),
    deepWashout,
  });

  const next = {
    ...current,
    phaseBar: barIndex,
    bounceBodyPct: bodyPct,
    bounceCloseInRangePct: closeInRangePct,
    reclaimPctFromLow,
    qualityFlags,
    entryCandidatePrice: close,
    setupType: "washout",
  };

  if (low < washoutLow * (1 - CONFIG.WASHOUT_NO_NEW_LOW_TOL_PCT / 100)) {
    return {
      candidate: {
        ...next,
        phase: "washout_monitor",
        washoutLow: low,
        baseBars: 0,
        readySinceBar: null,
        reasons: ["washout ready lost due to new low"],
        lastTransition: "washout_ready_to_monitor",
      },
      note: "washout ready invalidated by new low",
    };
  }

  const scored = computeWashoutScore(state, next);

  return {
    candidate: {
      ...next,
      phase: "washout_ready",
      score: scored.score,
      reasons: scored.reasons,
      lastTransition: "washout_ready_hold",
    },
    note: `washout ready hold | score=${scored.score}`,
  };
}

// ---------------------------
// breakout progression
// ---------------------------
function buildRetestPendingCandidate(state, current) {
  const feat = featOf(state);
  const close = n(feat.close);
  const low = isNum(feat.low) ? n(feat.low) : close;
  const triggerPrice = n(current.triggerPrice);

  const pullbackPct = pctFrom(triggerPrice, close);
  const retestLow = Math.min(
    isNum(current.retestLow) ? n(current.retestLow) : Infinity,
    low
  );

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

  if (pullbackPct > CONFIG.BREAKOUT_RETEST_MAX_PULLBACK_PCT) {
    return {
      candidate: {
        ...next,
        phase: "idle",
        cancelReason: "retest_too_deep",
        reasons: [`retest too deep pullbackPct=${pullbackPct.toFixed(3)}`],
        lastTransition: "retest_pending_to_idle",
      },
      note: `retest invalidated | pullbackPct=${pullbackPct.toFixed(3)} > max=${CONFIG.BREAKOUT_RETEST_MAX_PULLBACK_PCT}`,
    };
  }

  return {
    candidate: {
      ...next,
      reasons: ["waiting retest / reclaim"],
      lastTransition: "retest_pending_hold",
    },
    note: `retest pending | close=${close.toFixed(4)} trigger=${triggerPrice.toFixed(4)}`,
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
  const { bodyPct, closeInRangePct } = computeCandleMetrics(open, high, low, close);

  const reclaimPctFromTrigger = pctFrom(close, triggerPrice);
  const pullbackPct = isNum(current.pullbackPct)
    ? n(current.pullbackPct)
    : pctFrom(triggerPrice, low);

  const shallowPullbackOk = pullbackPct <= 0.45;

  const qualityFlags = resolveBreakoutQualityFlags({
    bounceCloseInRangePct: closeInRangePct,
    bounceBodyPct: bodyPct,
    reclaimPctFromTrigger,
    pullbackPct,
  });

  const next = {
    ...current,
    phase: "bounce_confirmed",
    bouncePrice: close,
    bouncePct: pctFrom(close, triggerPrice),
    pullbackPct,
    bounceBodyPct: bodyPct,
    bounceCloseInRangePct: closeInRangePct,
    reclaimPctFromTrigger,
    qualityFlags,
    shallowPullbackOk,
    reasons: ["bounce confirmed"],
    lastTransition: "bounce_confirmed_hold",
    entryCandidatePrice: close,
    setupType: "breakout",
  };

  const scorePack = computeBreakoutScore(state, next);

  const scored = {
    ...next,
    score: scorePack.score,
    reasons: scorePack.reasons,
  };

  const readyReasons = [];
  const minCloseAllowed =
    triggerPrice * (1 - CONFIG.MAX_CLOSE_BELOW_TRIGGER_TOLERANCE_PCT / 100);

  const oiTrend = n(feat.oiTrend);
  const regime = String(ctx.regime ?? "range");
  const bullAligned = isBullAligned(feat);

  if (close < minCloseAllowed) {
    readyReasons.push("ready_block_close_below_trigger");
  }

  if (reclaimPctFromTrigger < CONFIG.BREAKOUT_MIN_RECLAIM_ABOVE_TRIGGER_PCT) {
    readyReasons.push("ready_block_reclaim_too_small");
  }

  if (!isTrendRegime(regime)) {
    readyReasons.push("ready_block_not_trend_regime");
  }

  if (!bullAligned) {
    readyReasons.push("ready_block_ema_not_bull_aligned");
  }

  if (
    CONFIG.BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE &&
    oiTrend <= 0
  ) {
    readyReasons.push("ready_block_flow_not_supportive");
  }

  if (closeInRangePct < CONFIG.BREAKOUT_MIN_CLOSE_IN_RANGE_PCT) {
    readyReasons.push("ready_block_weak_close_in_range");
  }

  if (bodyPct < CONFIG.BREAKOUT_MIN_BOUNCE_BODY_PCT) {
    readyReasons.push("ready_block_weak_bounce_body");
  }

  if (scored.score < CONFIG.BREAKOUT_MIN_SCORE) {
    readyReasons.push("ready_block_score_too_low");
  }

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

  return {
    candidate: {
      ...scored,
      phase: "bounce_confirmed",
      reasons: [...scored.reasons, ...readyReasons],
      lastTransition: "bounce_confirmed_hold",
    },
    note: `bounce confirmed but not ready | ${readyReasons.join(", ") || "waiting"}`,
  };
}

// ---------------------------
// public runner
// ---------------------------
export function runBreakoutSetup(state) {
  const current = setupOf(state);
  const phase = phaseOf(state);

  let result;

  if (phase === "idle") {
    const built = buildIdleCandidate(state);
    if (!built.ok) {
      return { patch: null, note: built.note };
    }
    result = { candidate: built.candidate, note: built.note };
  } else if (phase === "washout_monitor") {
    result = buildWashoutMonitorCandidate(state, current);
  } else if (phase === "washout_base") {
    result = buildWashoutBaseCandidate(state, current);
  } else if (phase === "washout_ready") {
    result = buildWashoutReadyCandidate(state, current);
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
    return { patch: null, note: result?.note ?? "no setup update" };
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

      washoutPeakPrice: isNum(next.washoutPeakPrice) ? n(next.washoutPeakPrice) : next.washoutPeakPrice ?? null,
      washoutLow: isNum(next.washoutLow) ? n(next.washoutLow) : next.washoutLow ?? null,
      washoutDropPct: isNum(next.washoutDropPct) ? n(next.washoutDropPct) : next.washoutDropPct ?? null,
      washoutDetectedBar: next.washoutDetectedBar ?? null,
      noBuyUntilBar: next.noBuyUntilBar ?? null,
      baseBars: isNum(next.baseBars) ? n(next.baseBars) : 0,
      deepestLowBar: next.deepestLowBar ?? null,
      reclaimPctFromLow: isNum(next.reclaimPctFromLow) ? n(next.reclaimPctFromLow) : next.reclaimPctFromLow ?? null,
      setupType: next.setupType ?? current.setupType ?? null,
    },
    note: result.note ?? "setup updated",
  };
}

export default {
  BRAIN_VERSION,
  runBreakoutSetup,
};
