/**
 * BrainRAY_Continuation_v6.0_modular
 * Source behavior: BrainRAY_Continuation_v5.1
 *
 * Runtime state and state helper functions.
 */

import { CONFIG } from "./config.js";
import { isoNow, ageSec, n, maxFinite, parseTsMs, nowMs, pickFirst } from "./utils.js";

export function buildInitialRuntimeState() {
  return {
    startedAt: isoNow(),
    barIndex: 0,
    lastBarKey: null,
    lastTickPrice: null,
    lastTickTime: null,
    tickCount: 0,
    lastFeature: null,
    lastFeatureTime: null,
    lastFeatureBarKey: null,
    prevFeature: null,
    prevPrevFeature: null,
    inPosition: false,
    entryPrice: null,
    entryAt: null,
    entryMode: null,
    stopPrice: null,
    beArmed: false,
    peakPrice: null,
    peakPnlPct: 0,
    dynamicTpTier: 0,
    cooldownUntilMs: 0,
    lastEnterAtMs: 0,
    lastExitAtMs: 0,
    lastAction: null,
    cycleState: "flat",
    lastExitClass: null,
    lastExitReason: null,
    ray: {
      bullContext: false,
      bullRegimeId: 0,
      bullRegimeStartedAt: null,
      reentryCountInRegime: 0,
      lastBullTrendChangeAt: null,
      lastBullTrendContinuationAt: null,
      lastBullBosAt: null,
      lastBearTrendChangeAt: null,
      lastBearTrendContinuationAt: null,
    },
    rayConflict: {
      pending: false,
      side: null,
      event: null,
      eventTime: null,
      source: null,
      armedBar: null,
      expiresBar: null,
      price: null,
    },
    fvvo: {
      lastSniperBuyAt: null,
      lastSniperSellAt: null,
      lastBurstBullishAt: null,
      lastBurstBearishAt: null,
    },
    firstEntry: {
      pending: false,
      armedAtMs: null,
      expiresAtMs: null,
      bullRegimeId: null,
      rayPrice: null,
      confirmPrice: null,
      ticksAboveConfirm: 0,
      lastConfirmedTickPrice: null,
      decision: null,
      redFlags: [],
    },
    breakoutMemory: {
      active: false,
      used: false,
      armedBar: null,
      expiresBar: null,
      triggerPrice: null,
      reclaimPrice: null,
      breakoutHigh: null,
      mode: null,
      armedAt: null,
    },
    reentry: {
      eligible: false,
      eligibleUntilBar: null,
      eligibleFromBar: null,
      exitPrice: null,
      peakBeforeExit: null,
      anchorPrice: null,
      bullRegimeId: null,
    },
    postExitContinuation: {
      active: false,
      armedAtBar: null,
      eligibleFromBar: null,
      expiresBar: null,
      exitPrice: null,
      peakBeforeExit: null,
      anchorPrice: null,
      bullRegimeId: null,
      exitReason: null,
      exitPnlPct: null,
    },
    trendChangeLaunch: {
      pending: false,
      armedBar: null,
      expiresBar: null,
      rayPrice: null,
      rayTime: null,
    },
    fastTickLaunch: {
      active: false,
      openedAtMs: null,
      expiresAtMs: null,
      bullRegimeId: null,
      source: null,
      rayPrice: null,
      confirmPrice: null,
      featureClose: null,
      ema8: null,
      ema18: null,
      rsi: null,
      adx: null,
      breakoutHigh: null,
      ticksAboveConfirm: 0,
      lastConfirmedTickPrice: null,
    },
  };
}

export const S = {
  ...buildInitialRuntimeState(),
  logs: [],
};

export function log(msg, data = null) {
  const line = data ? `${msg} | ${JSON.stringify(data)}` : msg;
  const out = `${isoNow()} ${line}`;
  S.logs.push(out);
  if (S.logs.length > 2000) S.logs.shift();
  if (CONFIG.DEBUG) console.log(out);
}

export function resetRuntimeState(reason = "manual_reset") {
  const keepLogs = Array.isArray(S.logs) ? S.logs : [];
  const fresh = buildInitialRuntimeState();
  for (const key of Object.keys(fresh)) S[key] = fresh[key];
  S.logs = keepLogs;
  log("♻️ STATE_RESET", { reason });
}
export function currentPrice() {
  return Number.isFinite(S.lastTickPrice) ? S.lastTickPrice : n(S.lastFeature?.close, NaN);
}
export function isTickFresh() {
  if (CONFIG.REPLAY_ALLOW_STALE_DATA) return true;
  return ageSec(S.lastTickTime) <= CONFIG.TICK_MAX_AGE_SEC;
}
export function isFeatureFresh() {
  if (CONFIG.REPLAY_ALLOW_STALE_DATA) return true;
  return ageSec(S.lastFeatureTime) <= CONFIG.FEATURE_MAX_AGE_SEC;
}
export function wasWeakeningBar(cur, prev) {
  if (!cur || !prev) return false;
  const rsiWeak = Number.isFinite(prev.rsi) && Number.isFinite(cur.rsi) && cur.rsi <= prev.rsi;
  const adxWeak = Number.isFinite(prev.adx) && Number.isFinite(cur.adx) && cur.adx <= prev.adx;
  const closeWeak = Number.isFinite(prev.close) && Number.isFinite(cur.close) && cur.close < prev.close;
  return rsiWeak || adxWeak || closeWeak;
}
export function twoConsecutiveWeakeningBars() {
  return wasWeakeningBar(S.lastFeature, S.prevFeature) && wasWeakeningBar(S.prevFeature, S.prevPrevFeature);
}
export function bullishRayRecent() {
  return (
    ageSec(S.ray.lastBullTrendChangeAt) <= CONFIG.POST_EXIT_CONTINUATION_REQUIRE_BULLISH_RAY_RECENCY_SEC ||
    ageSec(S.ray.lastBullTrendContinuationAt) <= CONFIG.POST_EXIT_CONTINUATION_REQUIRE_BULLISH_RAY_RECENCY_SEC ||
    ageSec(S.ray.lastBullBosAt) <= CONFIG.POST_EXIT_CONTINUATION_REQUIRE_BULLISH_RAY_RECENCY_SEC
  );
}
export function getExitPeakSnapshot(exitPrice) {
  return maxFinite(
    S.peakPrice,
    exitPrice,
    S.lastFeature?.high,
    S.lastFeature?.close,
    S.prevFeature?.high,
    S.prevFeature?.close,
    S.entryPrice
  );
}
export function recentRsiHigh(lookback = 3) {
  const arr = [S.lastFeature, S.prevFeature, S.prevPrevFeature].slice(0, Math.max(1, Math.min(3, lookback)));
  return maxFinite(...arr.map((x) => n(x?.rsi, NaN)));
}
export function actionClockMs(eventIso = null) {
  if (CONFIG.REPLAY_USE_EVENT_TIME_FOR_POSITION_CLOCK && eventIso) {
    const t = parseTsMs(eventIso);
    if (Number.isFinite(t)) return t;
  }
  return nowMs();
}
export function activeEnterDedupMs(source) {
  if (source === "feature_reentry" || source === "post_exit_continuation_reentry" || source === "first_entry_tick_confirm") {
    return CONFIG.REENTRY_ENTER_DEDUP_MS;
  }
  return CONFIG.ENTER_DEDUP_MS;
}
export function canEnterByDedup(source, eventIso = null) {
  const clockMs = actionClockMs(eventIso);
  return clockMs - S.lastEnterAtMs >= activeEnterDedupMs(source);
}
export function canExitByDedup(eventIso = null) {
  const clockMs = actionClockMs(eventIso);
  return clockMs - S.lastExitAtMs >= CONFIG.EXIT_DEDUP_MS;
}
