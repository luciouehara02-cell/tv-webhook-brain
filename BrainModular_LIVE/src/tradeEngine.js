/**
 * BrainRAY_Continuation_v6.1_modular
 * Source behavior: BrainRAY_Continuation_v5.1 + v5.1a safety/log improvements
 *
 * Trading logic only. Strategy behavior, thresholds, modes, reasons, and logs are preserved.
 */

import { CONFIG } from "./config.js";
import { forward3Commas } from "./executionRouter.js";
import {
  S,
  log,
  currentPrice,
  isTickFresh,
  isFeatureFresh,
  wasWeakeningBar,
  twoConsecutiveWeakeningBars,
  bullishRayRecent,
  getExitPeakSnapshot,
  recentRsiHigh,
  actionClockMs,
  canEnterByDedup,
  canExitByDedup,
} from "./stateStore.js";
import {
  n,
  s,
  b,
  isoNow,
  nowMs,
  round4,
  pctDiff,
  pickFirst,
  reasonPush,
  barTimeKey,
  ageSec,
  parseTsMs,
  normalizeSymbol,
  isLaunchMode,
  isProtectedContinuationMode,
  isReentryHarvestMode,
  isFirstEntryMode,
} from "./utils.js";

function clearFirstEntry(reason = "reset") {
  if (S.firstEntry?.pending) log("🟢 FIRST_ENTRY_CLEARED", { reason });
  S.firstEntry = {
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
  };
}
function firstEntryStrongBearishFvvo(fv) {
  return Boolean(fv?.snap?.burstBearish || fv?.score <= -2);
}
function recentBearishRayForFirstEntry() {
  return (
    ageSec(S.ray.lastBearTrendChangeAt) <= CONFIG.FIRST_ENTRY_RECENT_BEARISH_RAY_SEC ||
    ageSec(S.ray.lastBearTrendContinuationAt) <= CONFIG.FIRST_ENTRY_RECENT_BEARISH_RAY_SEC
  );
}
function armFirstEntryConfirm(rayPrice, rayTime, decision = {}) {
  if (!CONFIG.FIRST_ENTRY_CONFIRM_ENABLED) return;
  const confirmPrice = rayPrice * (1 + CONFIG.FIRST_ENTRY_CONFIRM_TICK_CONFIRM_PCT / 100);
  S.firstEntry = {
    pending: true,
    armedAtMs: nowMs(),
    expiresAtMs: nowMs() + CONFIG.FIRST_ENTRY_CONFIRM_WINDOW_SEC * 1000,
    bullRegimeId: S.ray.bullRegimeId,
    rayPrice,
    confirmPrice,
    ticksAboveConfirm: 0,
    lastConfirmedTickPrice: null,
    decision,
    redFlags: Array.isArray(decision.redFlags) ? decision.redFlags : [],
  };
  log("🟢 FIRST_ENTRY_CONFIRM_ARMED", {
    rayPrice: round4(rayPrice),
    confirmPrice: round4(confirmPrice),
    expiresAt: new Date(S.firstEntry.expiresAtMs).toISOString(),
    bullRegimeId: S.firstEntry.bullRegimeId,
    decision,
  });
}
function invalidateFirstEntryConfirm() {
  if (!S.firstEntry?.pending) return;
  if (nowMs() > n(S.firstEntry.expiresAtMs, 0)) return clearFirstEntry("expired");
  if (S.firstEntry.bullRegimeId !== S.ray.bullRegimeId) return clearFirstEntry("regime_changed");
  if (!S.ray.bullContext) return clearFirstEntry("bull_context_off");
}
function clearBreakoutMemory(reason = "reset") {
  if (S.breakoutMemory.active) log("🧠 BREAKOUT_MEMORY_CLEARED", { reason });
  S.breakoutMemory = {
    active: false,
    used: false,
    armedBar: null,
    expiresBar: null,
    triggerPrice: null,
    reclaimPrice: null,
    breakoutHigh: null,
    mode: null,
    armedAt: null,
  };
}
function clearReentry(reason = "reset") {
  if (S.reentry.eligible) log("🔁 REENTRY_DISABLED", { reason });
  S.reentry = {
    eligible: false,
    eligibleUntilBar: null,
    eligibleFromBar: null,
    exitPrice: null,
    peakBeforeExit: null,
    anchorPrice: null,
    bullRegimeId: null,
  };
}
function clearPostExitContinuation(reason = "reset") {
  if (S.postExitContinuation.active) log("🔁 POST_EXIT_CONTINUATION_DISABLED", { reason });
  S.postExitContinuation = {
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
  };
}
function armPostExitContinuation(reason, exitPrice, exitPnlPct, peakBeforeExit) {
  if (!CONFIG.POST_EXIT_CONTINUATION_ENABLED) return;
  if (!S.ray.bullContext) return;
  if (S.ray.reentryCountInRegime >= CONFIG.MAX_REENTRIES_PER_BULL_REGIME) return;
  if (exitPnlPct < CONFIG.POST_EXIT_CONTINUATION_MIN_PROFIT_EXIT_PCT) return;
  const anchor = Number.isFinite(S.lastFeature?.ema8)
    ? S.lastFeature.ema8
    : Number.isFinite(exitPrice)
    ? exitPrice
    : peakBeforeExit;
  S.postExitContinuation = {
    active: true,
    armedAtBar: S.barIndex,
    eligibleFromBar: S.barIndex + 1,
    expiresBar: S.barIndex + CONFIG.POST_EXIT_CONTINUATION_WINDOW_BARS,
    exitPrice,
    peakBeforeExit,
    anchorPrice: anchor,
    bullRegimeId: S.ray.bullRegimeId,
    exitReason: reason,
    exitPnlPct,
  };
  log("🔁 POST_EXIT_CONTINUATION_ARMED", {
    reason,
    bullRegimeId: S.ray.bullRegimeId,
    eligibleFromBar: S.postExitContinuation.eligibleFromBar,
    expiresBar: S.postExitContinuation.expiresBar,
    exitPrice: round4(exitPrice),
    peakBeforeExit: round4(peakBeforeExit),
    anchorPrice: round4(anchor),
    exitPnlPct: round4(exitPnlPct),
  });
}
function armTrendChangeLaunch(rayPrice, rayTime) {
  S.trendChangeLaunch = {
    pending: true,
    armedBar: S.barIndex,
    expiresBar: S.barIndex + CONFIG.TREND_CHANGE_LAUNCH_MEMORY_BARS,
    rayPrice,
    rayTime,
  };
  log("🚀 TREND_CHANGE_LAUNCH_ARMED", S.trendChangeLaunch);
}
function clearTrendChangeLaunch(reason = "reset") {
  if (S.trendChangeLaunch.pending) log("🚀 TREND_CHANGE_LAUNCH_CLEARED", { reason });
  S.trendChangeLaunch = { pending: false, armedBar: null, expiresBar: null, rayPrice: null, rayTime: null };
}
function armFastTickLaunch(source, rayPrice) {
  if (!CONFIG.FAST_TICK_LAUNCH_ENABLED) return;
  const f = S.lastFeature;
  if (!f) return;
  const confirmPrice = rayPrice * (1 + CONFIG.FAST_TICK_LAUNCH_CONFIRM_PCT / 100);
  S.fastTickLaunch = {
    active: true,
    openedAtMs: nowMs(),
    expiresAtMs: nowMs() + CONFIG.FAST_TICK_LAUNCH_WINDOW_SEC * 1000,
    bullRegimeId: S.ray.bullRegimeId,
    source,
    rayPrice,
    confirmPrice,
    featureClose: f.close,
    ema8: f.ema8,
    ema18: f.ema18,
    rsi: f.rsi,
    adx: f.adx,
    breakoutHigh: Number.isFinite(S.breakoutMemory.breakoutHigh) ? S.breakoutMemory.breakoutHigh : f.high,
    ticksAboveConfirm: 0,
    lastConfirmedTickPrice: null,
  };
  log("⚡ FAST_TICK_LAUNCH_ARMED", {
    source,
    bullRegimeId: S.fastTickLaunch.bullRegimeId,
    rayPrice,
    confirmPrice: round4(confirmPrice),
    expiresAt: new Date(S.fastTickLaunch.expiresAtMs).toISOString(),
    rsi: f.rsi,
    adx: f.adx,
  });
}
function clearFastTickLaunch(reason = "reset") {
  if (S.fastTickLaunch.active) log("⚡ FAST_TICK_LAUNCH_CLEARED", { reason });
  S.fastTickLaunch = {
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
  };
}
function clearRayConflict(reason = "reset") {
  if (S.rayConflict.pending) log("⚖️ RAY_CONFLICT_CLEARED", { reason });
  S.rayConflict = { pending: false, side: null, event: null, eventTime: null, source: null, armedBar: null, expiresBar: null, price: null };
}
function armRayConflict(side, event, eventTime, source, price) {
  S.rayConflict = {
    pending: true,
    side,
    event,
    eventTime,
    source,
    armedBar: S.barIndex,
    expiresBar: S.barIndex + Math.max(1, CONFIG.RAY_CONFLICT_CONFIRM_FEATURE_BARS),
    price,
  };
  log("⚖️ RAY_CONFLICT_ARMED", S.rayConflict);
}

// --------------------------------------------------
// FVVO memory / score
// --------------------------------------------------
function fvvoRecent(iso, maxSec = CONFIG.FVVO_MEMORY_SEC) {
  return ageSec(iso) <= maxSec;
}
function getFvvoSnapshot() {
  return {
    sniperBuy: fvvoRecent(S.fvvo.lastSniperBuyAt),
    sniperSell: fvvoRecent(S.fvvo.lastSniperSellAt),
    burstBullish: fvvoRecent(S.fvvo.lastBurstBullishAt),
    burstBearish: fvvoRecent(S.fvvo.lastBurstBearishAt),
  };
}
export function getFvvoScore() {
  if (!CONFIG.FVVO_ENABLED) return { score: 0, tags: [], snap: getFvvoSnapshot() };
  const snap = getFvvoSnapshot();
  let score = 0;
  const tags = [];
  if (snap.sniperBuy) {
    score += CONFIG.FVVO_SNIPER_BUY_BOOST;
    tags.push("sniper_buy");
  }
  if (snap.burstBullish) {
    score += CONFIG.FVVO_BURST_BULLISH_BOOST;
    tags.push("burst_bullish");
  }
  if (snap.sniperSell) {
    score -= CONFIG.FVVO_SNIPER_SELL_PENALTY;
    tags.push("sniper_sell");
  }
  if (snap.burstBearish) {
    score -= CONFIG.FVVO_BURST_BEARISH_PENALTY;
    tags.push("burst_bearish");
  }
  return { score, tags, snap };
}

// --------------------------------------------------
function rayEventsConflict(tsA, tsB) {
  const a = parseTsMs(tsA);
  const b2 = parseTsMs(tsB);
  if (!Number.isFinite(a) || !Number.isFinite(b2)) return false;
  return Math.abs(a - b2) <= CONFIG.RAY_CONFLICT_GUARD_SEC * 1000;
}
function turnBullRegimeOn(ts, source) {
  if (!S.ray.bullContext) {
    S.ray.bullContext = true;
    S.ray.bullRegimeId += 1;
    S.ray.bullRegimeStartedAt = ts;
    S.ray.reentryCountInRegime = 0;
    S.cycleState = S.inPosition ? "long" : "flat";
    clearReentry("new_bull_regime");
    clearPostExitContinuation("new_bull_regime");
    log("🟢 BULL_REGIME_ON", { source, bullRegimeId: S.ray.bullRegimeId, ts });
  }
}
function turnBullRegimeOff(ts, reason) {
  if (S.ray.bullContext) {
    S.ray.bullContext = false;
    S.cycleState = S.inPosition ? "long" : "disabled_by_bear_regime";
    clearFirstEntry("bull_regime_off");
    clearBreakoutMemory("bull_regime_off");
    clearReentry("bull_regime_off");
    clearPostExitContinuation("bull_regime_off");
    clearTrendChangeLaunch("bull_regime_off");
    clearFastTickLaunch("bull_regime_off");
    log("🔴 BULL_REGIME_OFF", { reason, ts, bullRegimeId: S.ray.bullRegimeId });
  }
}
function maybeHandleRayConflict(side, event, ts, price, source) {
  if (!CONFIG.RAY_CONFLICT_GUARD_ENABLED) return false;
  const lastOppositeTs =
    side === "bull_off"
      ? pickFirst(S.ray, ["lastBullTrendChangeAt", "lastBullTrendContinuationAt"], null)
      : pickFirst(S.ray, ["lastBearTrendChangeAt", "lastBearTrendContinuationAt"], null);
  if (rayEventsConflict(ts, lastOppositeTs)) {
    armRayConflict(side, event, ts, source, price);
    return true;
  }
  return false;
}
function resolveRayConflictOnFeature(feature) {
  if (!S.rayConflict.pending) return;
  if (S.barIndex < n(S.rayConflict.expiresBar, Infinity)) return;
  const side = S.rayConflict.side;
  const fv = getFvvoScore();
  const close = n(feature.close, NaN);
  const ema18 = n(feature.ema18, NaN);
  const adx = n(feature.adx, NaN);
  const rsi = n(feature.rsi, NaN);
  let confirm = false;
  if (side === "bull_on") {
    confirm =
      (!CONFIG.RAY_CONFLICT_REQUIRE_CLOSE_CONFIRM_OVER_EMA18 ||
        (Number.isFinite(close) && Number.isFinite(ema18) && close >= ema18)) &&
      (!Number.isFinite(rsi) || rsi >= CONFIG.MIN_RSI_LONG) &&
      (!Number.isFinite(adx) || adx >= CONFIG.MIN_ADX_CONTINUATION);
    if (confirm) {
      turnBullRegimeOn(feature.time, "ray_conflict_confirm_bull");
      log("⚖️ RAY_CONFLICT_RESOLVED", { side, action: "bull_on_confirmed", fvvo: fv });
    } else if (!CONFIG.RAY_CONFLICT_KEEP_CURRENT_REGIME_IF_UNCLEAR) {
      turnBullRegimeOff(feature.time, "ray_conflict_bull_failed");
      log("⚖️ RAY_CONFLICT_RESOLVED", { side, action: "bull_on_failed_force_off", fvvo: fv });
    } else {
      log("⚖️ RAY_CONFLICT_RESOLVED", { side, action: "kept_current_regime", fvvo: fv });
    }
  }
  if (side === "bull_off") {
    confirm =
      (Number.isFinite(close) && Number.isFinite(ema18) && close < ema18) ||
      (Number.isFinite(rsi) && rsi < CONFIG.MIN_RSI_LONG - 2) ||
      fv.score < 0;
    if (confirm) {
      if (S.inPosition && CONFIG.EXIT_ON_BEARISH_TREND_CHANGE) {
        doExit("ray_conflict_bear_confirmed", currentPrice(), feature.time, "regime_break");
      } else if (CONFIG.FORWARD_EXIT_WHEN_FLAT) {
        doFlatExitPassthrough("ray_conflict_bear_confirmed_flat_safety_exit", currentPrice(), feature.time, "ray_conflict_confirm_bear");
      }
      turnBullRegimeOff(feature.time, "ray_conflict_confirm_bear");
      log("⚖️ RAY_CONFLICT_RESOLVED", { side, action: "bull_off_confirmed", fvvo: fv });
    } else if (!CONFIG.RAY_CONFLICT_KEEP_CURRENT_REGIME_IF_UNCLEAR) {
      turnBullRegimeOff(feature.time, "ray_conflict_force_bear");
      log("⚖️ RAY_CONFLICT_RESOLVED", { side, action: "forced_bull_off", fvvo: fv });
    } else {
      log("⚖️ RAY_CONFLICT_RESOLVED", { side, action: "kept_current_regime", fvvo: fv });
    }
  }
  clearRayConflict("resolved_on_feature");
}

export function handleRayEvent(body) {
  const name = String(body.event || "").trim();
  const ts = pickFirst(body, ["time", "timestamp"], isoNow());
  const price = n(pickFirst(body, ["price", "trigger_price", "close"], currentPrice()));

  if (/Bullish Trend Change/i.test(name) && CONFIG.RAY_USE_BULLISH_TREND_CHANGE) {
    S.ray.lastBullTrendChangeAt = ts;
    if (maybeHandleRayConflict("bull_on", name, ts, price, "ray_bullish_trend_change")) {
      log("🟡 RAY_BULLISH_TREND_CHANGE_HELD_FOR_CONFLICT", { price, ts });
      return;
    }
    turnBullRegimeOn(ts, "ray_bullish_trend_change");
    log("🟢 RAY_BULLISH_TREND_CHANGE", { price, ts });

    if (CONFIG.FIRST_ENTRY_ENGINE_ENABLED) {
      const firstDecision = evaluateFirstBullishTrendChangeEntry(price, ts);
      if (firstDecision.action === "enter") {
        doEnter(firstDecision.mode, price, firstDecision, ts);
        return;
      }
      if (firstDecision.action === "confirm") {
        armFirstEntryConfirm(price, ts, firstDecision);
        return;
      }
      if (firstDecision.action === "block") {
        log("🚫 FIRST_ENTRY_BLOCKED", firstDecision);
        clearFirstEntry("blocked_weak_first_entry");
        return;
      }
    }

    // Fallback to old v4.4f launch path only if v5.0 engine is disabled or returns fallback.
    if (CONFIG.TREND_CHANGE_LAUNCH_ENABLED) {
      armTrendChangeLaunch(price, ts);
      const decision = tryEntry("immediate_trend_change_launch", {
        ...body,
        src: "ray",
        event: "Bullish Trend Change",
        price,
        time: ts,
      });
      if (!decision.allow) armFastTickLaunch("ray_bullish_trend_change", price);
    }
    return;
  }

  if (/Bullish Trend Continuation/i.test(name) && CONFIG.RAY_USE_BULLISH_TREND_CONTINUATION) {
    S.ray.lastBullTrendContinuationAt = ts;
    if (maybeHandleRayConflict("bull_on", name, ts, price, "ray_bullish_trend_continuation")) {
      log("🟡 RAY_BULLISH_TREND_CONTINUATION_HELD_FOR_CONFLICT", { price, ts });
      return;
    }
    if (!S.ray.bullContext) turnBullRegimeOn(ts, "ray_bullish_trend_continuation");
    log("🟩 RAY_BULLISH_TREND_CONTINUATION", { price, ts });
    const decision = tryEntry("ray_bullish_trend_continuation", body);
    if (!decision.allow && CONFIG.FAST_TICK_LAUNCH_ENABLED) armFastTickLaunch("ray_bullish_trend_continuation", price);
    return;
  }

  if (/Bullish BOS/i.test(name) && CONFIG.RAY_USE_BULLISH_BOS) {
    S.ray.lastBullBosAt = ts;
    log("🔹 RAY_BULLISH_BOS", { price, ts });
    return;
  }

  if (/Bearish Trend Change/i.test(name) && CONFIG.RAY_USE_BEARISH_TREND_CHANGE) {
    S.ray.lastBearTrendChangeAt = ts;
    if (maybeHandleRayConflict("bull_off", name, ts, price, "ray_bearish_trend_change")) {
      log("🟡 RAY_BEARISH_TREND_CHANGE_HELD_FOR_CONFLICT", { price, ts });
      return;
    }
    log("🔴 RAY_BEARISH_TREND_CHANGE", { price, ts });
    if (S.inPosition && CONFIG.EXIT_ON_BEARISH_TREND_CHANGE) {
      doExit("ray_bearish_trend_change", price, ts, "regime_break");
    } else if (CONFIG.FORWARD_EXIT_WHEN_FLAT) {
      doFlatExitPassthrough("ray_bearish_trend_change_flat_safety_exit", price, ts, "ray_bearish_trend_change");
    }
    turnBullRegimeOff(ts, "ray_bearish_trend_change");
    return;
  }

  if (/Bearish Trend Continuation/i.test(name) && CONFIG.RAY_USE_BEARISH_TREND_CONTINUATION) {
    S.ray.lastBearTrendContinuationAt = ts;
    if (maybeHandleRayConflict("bull_off", name, ts, price, "ray_bearish_trend_continuation")) {
      log("🟡 RAY_BEARISH_TREND_CONTINUATION_HELD_FOR_CONFLICT", { price, ts });
      return;
    }
    log("🟥 RAY_BEARISH_TREND_CONTINUATION", { price, ts });
    if (S.inPosition && CONFIG.EXIT_ON_BEARISH_TREND_CONTINUATION) {
      doExit("ray_bearish_trend_continuation", price, ts, "regime_break");
      turnBullRegimeOff(ts, "ray_bearish_trend_continuation");
    } else if (CONFIG.FORWARD_EXIT_WHEN_FLAT) {
      doFlatExitPassthrough("ray_bearish_trend_continuation_flat_safety_exit", price, ts, "ray_bearish_trend_continuation");
    }
  }
}

export function handleFvvoEvent(body) {
  const name = String(body.event || "").trim();
  const ts = pickFirst(body, ["time", "timestamp"], isoNow());
  if (!CONFIG.FVVO_ENABLED) {
    log("🧿 FVVO_IGNORED_DISABLED", { name, ts });
    return;
  }
  if (/Sniper Buy Alert/i.test(name)) {
    S.fvvo.lastSniperBuyAt = ts;
    log("🧿 FVVO_SNIPER_BUY", { ts });
    return;
  }
  if (/Sniper Sell Alert/i.test(name)) {
    S.fvvo.lastSniperSellAt = ts;
    log("🧿 FVVO_SNIPER_SELL", { ts });
    return;
  }
  if (/Burst Bullish Alert/i.test(name)) {
    S.fvvo.lastBurstBullishAt = ts;
    log("🧿 FVVO_BURST_BULLISH", { ts });
    return;
  }
  if (/Burst Bearish Alert/i.test(name)) {
    S.fvvo.lastBurstBearishAt = ts;
    log("🧿 FVVO_BURST_BEARISH", { ts });
    return;
  }
  log("🧿 FVVO_UNKNOWN", { name, ts });
}

// --------------------------------------------------
// feature handling
// --------------------------------------------------
function updateBarProgress(ts) {
  const key = barTimeKey(ts, n(CONFIG.ENTRY_TF, 5));
  if (key !== S.lastBarKey) {
    S.barIndex += 1;
    S.lastBarKey = key;
    invalidateFirstEntryConfirm();
    invalidateBreakoutMemory();
    invalidateReentry();
    invalidatePostExitContinuation();
    invalidateTrendChangeLaunch();
    invalidateFastTickLaunch();
  }
}
export function handleFeature(body) {
  const ts = pickFirst(body, ["time", "timestamp"], isoNow());
  updateBarProgress(ts);
  const feature = {
    symbol: normalizeSymbol(pickFirst(body, ["symbol"], CONFIG.SYMBOL)),
    tf: s(pickFirst(body, ["tf"], CONFIG.ENTRY_TF)),
    time: ts,
    open: n(body.open, NaN),
    high: n(body.high, NaN),
    low: n(body.low, NaN),
    close: n(body.close, NaN),
    ema8: n(body.ema8, NaN),
    ema18: n(body.ema18, NaN),
    ema50: n(body.ema50, NaN),
    rsi: n(body.rsi, NaN),
    adx: n(body.adx, NaN),
    atrPct: n(body.atrPct, NaN),
  };
  S.prevPrevFeature = S.prevFeature ? { ...S.prevFeature } : null;
  S.prevFeature = S.lastFeature ? { ...S.lastFeature } : null;
  S.lastFeature = feature;
  S.lastFeatureTime = ts;
  S.lastFeatureBarKey = S.lastBarKey;
  log("📊 FEATURE_5M", {
    close: feature.close,
    ema8: feature.ema8,
    ema18: feature.ema18,
    rsi: feature.rsi,
    adx: feature.adx,
    barIndex: S.barIndex,
    fvvo: getFvvoScore(),
  });
  resolveRayConflictOnFeature(feature);
  evaluateStructureAndArmMemory(feature);
  evaluateReentryEligibilityFromFeature(feature);

  if (CONFIG.TREND_CHANGE_LAUNCH_ENABLED && S.trendChangeLaunch.pending) {
    tryEntry("deferred_trend_change_launch", {
      src: "ray",
      symbol: CONFIG.SYMBOL,
      tf: CONFIG.ENTRY_TF,
      event: "Bullish Trend Change",
      price: feature.close,
      time: feature.time,
    });
  }

  if (CONFIG.POST_EXIT_CONTINUATION_ENABLED && S.postExitContinuation.active && !S.inPosition) {
    const pecDecision = tryEntry("post_exit_continuation_reentry", {
      src: "features",
      symbol: CONFIG.SYMBOL,
      tf: CONFIG.ENTRY_TF,
      close: feature.close,
      price: feature.close,
      time: feature.time,
    });
    if (pecDecision?.allow && S.inPosition) return;
  }

  if (CONFIG.PHASE2_REENTRY_ENABLED && S.reentry.eligible && !S.inPosition) {
    tryEntry("feature_reentry", {
      src: "features",
      symbol: CONFIG.SYMBOL,
      tf: CONFIG.ENTRY_TF,
      close: feature.close,
      price: feature.close,
      time: feature.time,
    });
  }

  if (S.inPosition) evaluateBarExit(feature);
}
function evaluateStructureAndArmMemory(f) {
  if (!CONFIG.BREAKOUT_MEMORY_ENABLED) return;
  if (normalizeSymbol(f.symbol) !== CONFIG.SYMBOL) return;
  if (String(f.tf) !== String(CONFIG.ENTRY_TF)) return;
  const bullEmaOk = !CONFIG.REQUIRE_EMA8_ABOVE_EMA18 || (Number.isFinite(f.ema8) && Number.isFinite(f.ema18) && f.ema8 >= f.ema18);
  const closeAboveEma8Ok = !CONFIG.REQUIRE_CLOSE_ABOVE_EMA8 || (Number.isFinite(f.close) && Number.isFinite(f.ema8) && f.close >= f.ema8);
  const fv = getFvvoScore();
  const rsiFloor = Math.max(0, CONFIG.MIN_RSI_LONG - Math.max(0, fv.score > 0 ? CONFIG.FVVO_CONT_RSI_RELAX : 0));
  const rsiOk = !Number.isFinite(f.rsi) || f.rsi >= rsiFloor;
  const adxOk = !Number.isFinite(f.adx) || f.adx >= CONFIG.MIN_ADX_CONTINUATION;
  const bullRayContext = S.ray.bullContext || ageSec(S.ray.lastBullTrendChangeAt) < 3600 || ageSec(S.ray.lastBullTrendContinuationAt) < 1800;
  const bullishBosRecent = ageSec(S.ray.lastBullBosAt) < 1800;
  const structureOk = bullEmaOk && closeAboveEma8Ok && rsiOk && adxOk && (bullRayContext || bullishBosRecent);
  if (!structureOk) return;
  S.breakoutMemory = {
    active: true,
    used: false,
    armedBar: S.barIndex,
    expiresBar: S.barIndex + CONFIG.BREAKOUT_MEMORY_BARS,
    triggerPrice: f.close,
    reclaimPrice: f.ema8,
    breakoutHigh: f.high,
    mode: "breakout_memory",
    armedAt: f.time,
  };
  log("🧠 BREAKOUT_MEMORY_ARMED", {
    barIndex: S.barIndex,
    expiresBar: S.breakoutMemory.expiresBar,
    triggerPrice: round4(f.close),
    reclaimPrice: round4(f.ema8),
    breakoutHigh: round4(f.high),
    rsi: round4(f.rsi),
    adx: round4(f.adx),
    fvvo: fv,
  });
}
function invalidateBreakoutMemory() {
  if (!S.breakoutMemory.active) return;
  if (S.barIndex > S.breakoutMemory.expiresBar) return clearBreakoutMemory("expired");
  const px = currentPrice();
  if (Number.isFinite(px) && Number.isFinite(S.breakoutMemory.reclaimPrice)) {
    const invalidPx = S.breakoutMemory.reclaimPrice * (1 - CONFIG.BREAKOUT_MEMORY_INVALIDATE_PCT / 100);
    if (px < invalidPx) return clearBreakoutMemory("price_below_reclaim_invalidated");
  }
}
function evaluateReentryEligibilityFromFeature(_feature) {
  // eligibility is armed at TP exit; this keeps expiry clean and deterministic.
}
function invalidateReentry() {
  if (!S.reentry.eligible) return;
  if (!S.ray.bullContext && CONFIG.REENTRY_REQUIRE_BULL_CONTEXT) return clearReentry("bull_context_off");
  if (S.ray.bullRegimeId !== S.reentry.bullRegimeId) return clearReentry("bull_regime_changed");
  if (S.barIndex > S.reentry.eligibleUntilBar) return clearReentry("expired");
}
function invalidatePostExitContinuation() {
  if (!S.postExitContinuation.active) return;
  if (!S.ray.bullContext) return clearPostExitContinuation("bull_context_off");
  if (S.ray.bullRegimeId !== S.postExitContinuation.bullRegimeId) return clearPostExitContinuation("bull_regime_changed");
  if (S.barIndex > S.postExitContinuation.expiresBar) return clearPostExitContinuation("expired");
}
function invalidateTrendChangeLaunch() {
  if (!S.trendChangeLaunch.pending) return;
  if (!S.ray.bullContext) return clearTrendChangeLaunch("bull_context_off");
  if (S.barIndex > S.trendChangeLaunch.expiresBar) return clearTrendChangeLaunch("expired");
}
function invalidateFastTickLaunch() {
  if (!S.fastTickLaunch.active) return;
  if (!S.ray.bullContext) return clearFastTickLaunch("bull_context_off");
  if (nowMs() > S.fastTickLaunch.expiresAtMs) return clearFastTickLaunch("expired");
  if (S.fastTickLaunch.bullRegimeId !== S.ray.bullRegimeId) return clearFastTickLaunch("bull_regime_changed");
}

// --------------------------------------------------
// entry decisions
// --------------------------------------------------
function baseFeatureEntryContext() {
  const f = S.lastFeature;
  if (!f) return { ok: false, reason: "no_feature" };
  if (normalizeSymbol(f.symbol) !== CONFIG.SYMBOL) return { ok: false, reason: "symbol_mismatch" };
  if (String(f.tf) !== String(CONFIG.ENTRY_TF)) return { ok: false, reason: "tf_mismatch" };
  if (!isFeatureFresh()) return { ok: false, reason: "stale_feature" };
  const fv = getFvvoScore();
  const price = currentPrice();
  const close = n(f.close, NaN);
  const ema8 = n(f.ema8, NaN);
  const ema18 = n(f.ema18, NaN);
  const adx = n(f.adx, NaN);
  const rsi = n(f.rsi, NaN);
  const ext8 = Number.isFinite(close) && Number.isFinite(ema8) ? pctDiff(ema8, close) : 999;
  const ext18 = Number.isFinite(close) && Number.isFinite(ema18) ? pctDiff(ema18, close) : 999;
  const ema8SlopePct = S.prevFeature && Number.isFinite(S.prevFeature.ema8) && Number.isFinite(ema8) ? pctDiff(S.prevFeature.ema8, ema8) : 0;
  return { ok: true, f, fv, price, close, ema8, ema18, adx, rsi, ext8, ext18, ema8SlopePct };
}
function evaluateFirstBullishTrendChangeEntry(rayPrice, rayTime) {
  const ctx = baseFeatureEntryContext();
  if (!ctx.ok) {
    return { action: "confirm", mode: "first_bullish_trend_change_confirmed_long", reason: `feature_not_ready:${ctx.reason}`, rayPrice };
  }
  const { f, fv, close, ema8, ema18, adx, rsi, ext18 } = ctx;
  const chasePct = pctDiff(rayPrice, close);
  const redFlags = [];
  reasonPush(redFlags, Number.isFinite(rsi) && rsi < CONFIG.FIRST_ENTRY_BLOCK_RSI_BELOW, "rsi_below_block_floor");
  reasonPush(redFlags, Number.isFinite(adx) && adx < CONFIG.FIRST_ENTRY_BLOCK_ADX_BELOW, "adx_below_block_floor");
  reasonPush(redFlags, chasePct > CONFIG.FIRST_ENTRY_BLOCK_MAX_CHASE_PCT, "chase_too_high");
  reasonPush(redFlags, ext18 > CONFIG.FIRST_ENTRY_BLOCK_MAX_EXT_EMA18_PCT, "ext_ema18_too_high");
  reasonPush(redFlags, CONFIG.FIRST_ENTRY_BLOCK_IF_EMA8_BELOW_EMA18 && Number.isFinite(ema8) && Number.isFinite(ema18) && ema8 < ema18, "ema8_below_ema18");
  reasonPush(redFlags, CONFIG.FIRST_ENTRY_BLOCK_IF_CLOSE_BELOW_EMA8 && Number.isFinite(close) && Number.isFinite(ema8) && close < ema8, "close_below_ema8");
  reasonPush(redFlags, CONFIG.FIRST_ENTRY_BLOCK_IF_STRONG_BEARISH_FVVO && firstEntryStrongBearishFvvo(fv), "strong_bearish_fvvo");
  reasonPush(redFlags, CONFIG.FIRST_ENTRY_BLOCK_IF_RECENT_BEARISH_RAY && recentBearishRayForFirstEntry(), "recent_bearish_ray");
  const metrics = {
    rayPrice: round4(rayPrice),
    close: round4(close),
    chasePct: round4(chasePct),
    ext18: round4(ext18),
    ema8: round4(ema8),
    ema18: round4(ema18),
    rsi: round4(rsi),
    adx: round4(adx),
    fvvo: fv,
    rayTime,
    featureTime: f.time,
  };
  if (CONFIG.FIRST_ENTRY_LOG_DEBUG) log("🟢 FIRST_ENTRY_EVAL", { metrics, redFlags });
  if (CONFIG.FIRST_ENTRY_WEAK_BLOCK_ENABLED && redFlags.length >= CONFIG.FIRST_ENTRY_BLOCK_MIN_RED_FLAGS) {
    return { action: "block", reason: "weak_first_bullish_trend_change", redFlags, metrics };
  }
  const emaOk = !CONFIG.FIRST_ENTRY_REQUIRE_EMA8_ABOVE_EMA18 || (Number.isFinite(ema8) && Number.isFinite(ema18) && ema8 >= ema18);
  const closeOk = !CONFIG.FIRST_ENTRY_REQUIRE_CLOSE_ABOVE_EMA8 || (Number.isFinite(close) && Number.isFinite(ema8) && close >= ema8);
  const immediateOk =
    emaOk &&
    closeOk &&
    Number.isFinite(rsi) &&
    rsi >= CONFIG.FIRST_ENTRY_IMMEDIATE_MIN_RSI &&
    Number.isFinite(adx) &&
    adx >= CONFIG.FIRST_ENTRY_IMMEDIATE_MIN_ADX &&
    chasePct <= CONFIG.FIRST_ENTRY_IMMEDIATE_MAX_CHASE_PCT &&
    ext18 <= CONFIG.FIRST_ENTRY_IMMEDIATE_MAX_EXT_EMA18_PCT;
  if (immediateOk) {
    return { action: "enter", mode: "first_bullish_trend_change_immediate_long", reason: "first_entry_immediate_ok", redFlags, metrics };
  }
  const closeNearEma8 =
    closeOk ||
    (CONFIG.FIRST_ENTRY_CONFIRM_ALLOW_CLOSE_NEAR_EMA8 &&
      Number.isFinite(close) &&
      Number.isFinite(ema8) &&
      close >= ema8 * (1 - CONFIG.FIRST_ENTRY_CONFIRM_MAX_BELOW_EMA8_PCT / 100));
  const confirmOk =
    CONFIG.FIRST_ENTRY_CONFIRM_ENABLED &&
    emaOk &&
    closeNearEma8 &&
    Number.isFinite(rsi) &&
    rsi >= CONFIG.FIRST_ENTRY_CONFIRM_MIN_RSI &&
    Number.isFinite(adx) &&
    adx >= CONFIG.FIRST_ENTRY_CONFIRM_MIN_ADX &&
    chasePct <= CONFIG.FIRST_ENTRY_CONFIRM_MAX_CHASE_PCT;
  if (confirmOk) {
    return { action: "confirm", mode: "first_bullish_trend_change_confirmed_long", reason: "first_entry_confirm_needed", redFlags, metrics };
  }
  return { action: "block", reason: "first_entry_not_confirmable", redFlags, metrics };
}
function evaluateLaunchEntry(source, body) {
  const ctx = baseFeatureEntryContext();
  if (!ctx.ok) return { allow: false, reason: ctx.reason };
  const { f, fv, close, ema8, ema18, adx, rsi, ext8, ext18 } = ctx;
  if (!S.ray.bullContext) return { allow: false, reason: "no_bull_context" };
  const baseRsiReq = source === "immediate_trend_change_launch" ? CONFIG.TREND_CHANGE_LAUNCH_MIN_RSI : CONFIG.MIN_RSI_LONG;
  const rsiReq = Math.max(0, baseRsiReq - (fv.score > 0 ? CONFIG.FVVO_LAUNCH_RSI_RELAX : 0));
  const adxReq = source === "immediate_trend_change_launch" ? CONFIG.TREND_CHANGE_LAUNCH_MIN_ADX : CONFIG.MIN_ADX_CONTINUATION;
  let maxChase = source === "immediate_trend_change_launch" ? CONFIG.TREND_CHANGE_LAUNCH_MAX_CHASE_PCT : CONFIG.CONTINUATION_MAX_CHASE_PCT;
  maxChase += fv.score > 0 ? CONFIG.FVVO_LAUNCH_MAX_CHASE_BONUS_PCT : 0;
  if (fv.snap.sniperSell) maxChase -= CONFIG.FVVO_SNIPER_SELL_CHASE_PENALTY_PCT;
  if (fv.snap.burstBearish) maxChase -= CONFIG.FVVO_BURST_BEARISH_CHASE_PENALTY_PCT;
  const triggerPrice = n(pickFirst(body, ["price", "trigger_price", "close"], close), close);
  const chasePct = pctDiff(triggerPrice, close);
  const reasons = [];
  reasonPush(reasons, CONFIG.REQUIRE_EMA8_ABOVE_EMA18 && !(Number.isFinite(ema8) && Number.isFinite(ema18) && ema8 >= ema18), "ema8_not_above_ema18");
  reasonPush(reasons, CONFIG.REQUIRE_CLOSE_ABOVE_EMA8 && !(Number.isFinite(close) && Number.isFinite(ema8) && close >= ema8), "close_below_ema8");
  reasonPush(reasons, Number.isFinite(rsi) && rsi < rsiReq, "rsi_too_low");
  reasonPush(reasons, Number.isFinite(adx) && adx < adxReq, "adx_too_low");
  reasonPush(reasons, chasePct > maxChase, "chase_too_high");
  reasonPush(reasons, ext8 > CONFIG.MAX_EXT_FROM_EMA8_PCT, "ext_ema8_too_high");
  reasonPush(reasons, ext18 > CONFIG.MAX_EXT_FROM_EMA18_PCT, "ext_ema18_too_high");
  const strongOverride =
    CONFIG.STRONG_LAUNCH_OVERRIDE_ENABLED &&
    Number.isFinite(rsi) &&
    rsi >= CONFIG.STRONG_LAUNCH_MIN_RSI &&
    Number.isFinite(adx) &&
    adx >= CONFIG.STRONG_LAUNCH_MIN_ADX &&
    chasePct <= CONFIG.STRONG_LAUNCH_MAX_CHASE_PCT &&
    ext18 <= CONFIG.STRONG_LAUNCH_MAX_EXT_FROM_EMA18_PCT;
  const slowRampOverride =
    CONFIG.DEFERRED_SLOW_RAMP_OVERRIDE_ENABLED &&
    source === "deferred_trend_change_launch" &&
    Number.isFinite(rsi) &&
    rsi >= CONFIG.DEFERRED_SLOW_RAMP_MIN_RSI &&
    Number.isFinite(adx) &&
    adx >= CONFIG.DEFERRED_SLOW_RAMP_MIN_ADX &&
    chasePct <= CONFIG.DEFERRED_SLOW_RAMP_MAX_CHASE_PCT &&
    ext18 <= CONFIG.DEFERRED_SLOW_RAMP_MAX_EXT_FROM_EMA18_PCT;
  const allow = reasons.length === 0 || strongOverride || slowRampOverride;
  return {
    allow,
    reason: allow ? (strongOverride ? "strong_launch_override" : slowRampOverride ? "slow_ramp_launch_override" : "launch_ok") : reasons[0],
    mode: strongOverride ? "bullish_trend_change_launch_long_strong" : slowRampOverride ? "bullish_trend_change_launch_long_slow_ramp" : "bullish_trend_change_launch_long",
    stop: Number.isFinite(ema18) ? ema18 * (1 - CONFIG.HARD_STOP_PCT / 100) : close * (1 - CONFIG.HARD_STOP_PCT / 100),
    metrics: { source, triggerPrice, close, chasePct, rsi, adx, ext8, ext18, fvvo: fv, reasons },
  };
}
function evaluateFeatureReentry(source, body) {
  const ctx = baseFeatureEntryContext();
  if (!ctx.ok) return { allow: false, reason: ctx.reason };
  const { f, fv, close, ema8, ema18, adx, rsi, ext18 } = ctx;
  const state = source === "post_exit_continuation_reentry" ? S.postExitContinuation : S.reentry;
  if (source === "post_exit_continuation_reentry" && !S.postExitContinuation.active) return { allow: false, reason: "post_exit_cont_not_active" };
  if (source !== "post_exit_continuation_reentry" && !S.reentry.eligible) return { allow: false, reason: "reentry_not_eligible" };
  if (CONFIG.REENTRY_REQUIRE_BULL_CONTEXT && !S.ray.bullContext) return { allow: false, reason: "no_bull_context" };
  if (state.bullRegimeId !== S.ray.bullRegimeId) return { allow: false, reason: "bull_regime_changed" };
  if (source === "post_exit_continuation_reentry") {
    if (S.barIndex < S.postExitContinuation.eligibleFromBar) return { allow: false, reason: "post_exit_too_early" };
    if (S.barIndex > S.postExitContinuation.expiresBar) return { allow: false, reason: "post_exit_expired" };
  } else {
    if (S.barIndex < S.reentry.eligibleFromBar) return { allow: false, reason: "reentry_too_early" };
    if (S.barIndex > S.reentry.eligibleUntilBar) return { allow: false, reason: "reentry_expired" };
  }
  let maxChase = source === "post_exit_continuation_reentry" ? CONFIG.POST_EXIT_CONTINUATION_MAX_CHASE_PCT : CONFIG.REENTRY_MAX_CHASE_PCT;
  let minRsi = source === "post_exit_continuation_reentry" ? CONFIG.POST_EXIT_CONTINUATION_MIN_RSI : CONFIG.FAST_REENTRY_MIN_RSI;
  let minAdx = source === "post_exit_continuation_reentry" ? CONFIG.POST_EXIT_CONTINUATION_MIN_ADX : CONFIG.FAST_REENTRY_MIN_ADX;
  maxChase += fv.score > 0 ? CONFIG.FVVO_REENTRY_MAX_CHASE_BONUS_PCT : 0;
  minRsi -= fv.score > 0 ? CONFIG.FVVO_REENTRY_RSI_RELAX : 0;
  const anchor = n(state.anchorPrice, state.exitPrice);
  const chasePct = pctDiff(anchor, close);
  const resetPct = Number.isFinite(state.peakBeforeExit) ? -pctDiff(state.peakBeforeExit, close) : 0;
  const reasons = [];
  const requireCloseAboveEma8 = source === "post_exit_continuation_reentry" ? CONFIG.POST_EXIT_CONTINUATION_REQUIRE_CLOSE_ABOVE_EMA8 : CONFIG.REENTRY_REQUIRE_CLOSE_ABOVE_EMA8;
  const maxBelowEma8 = source === "post_exit_continuation_reentry" ? CONFIG.POST_EXIT_CONTINUATION_MAX_BELOW_EMA8_PCT : 0;
  const closeAboveOrNearEma8 = Number.isFinite(close) && Number.isFinite(ema8) && close >= ema8 * (1 - maxBelowEma8 / 100);
  reasonPush(reasons, source === "post_exit_continuation_reentry" && CONFIG.POST_EXIT_CONTINUATION_REQUIRE_EMA8_ABOVE_EMA18 && !(Number.isFinite(ema8) && Number.isFinite(ema18) && ema8 >= ema18), "ema8_not_above_ema18");
  reasonPush(reasons, requireCloseAboveEma8 && !closeAboveOrNearEma8, "close_below_ema8");
  reasonPush(reasons, Number.isFinite(rsi) && rsi < minRsi, "rsi_too_low");
  reasonPush(reasons, Number.isFinite(adx) && adx < minAdx, "adx_too_low");
  reasonPush(reasons, chasePct > maxChase, "chase_too_high");
  reasonPush(reasons, ext18 > (source === "post_exit_continuation_reentry" ? CONFIG.POST_EXIT_CONTINUATION_MAX_EXT_FROM_EMA18_PCT : CONFIG.MAX_EXT_FROM_EMA18_PCT), "ext_ema18_too_high");
  if (source === "post_exit_continuation_reentry" && CONFIG.POST_EXIT_CONTINUATION_REQUIRE_BULLISH_RAY_RECENCY && !bullishRayRecent()) reasons.push("no_recent_bullish_ray");
  if (source === "post_exit_continuation_reentry" && CONFIG.POST_EXIT_CONTINUATION_BLOCK_ON_BURST_BEARISH && fv.snap.burstBearish && !CONFIG.POST_EXIT_CONTINUATION_IGNORE_SNIPER_SELL_IF_STRONG) reasons.push("burst_bearish");
  if (source === "post_exit_continuation_reentry" && !CONFIG.POST_EXIT_CONTINUATION_ALLOW_FVVO_NEUTRAL && fv.score <= 0) reasons.push("fvvo_not_bullish");
  if (source !== "post_exit_continuation_reentry" && CONFIG.FAST_REENTRY_ENABLED && resetPct < CONFIG.FAST_REENTRY_MIN_RESET_FROM_PEAK_PCT) reasons.push("reset_too_small");
  const strongPostExit =
    source === "post_exit_continuation_reentry" &&
    Number.isFinite(rsi) &&
    rsi >= CONFIG.POST_EXIT_CONTINUATION_STRONG_MIN_RSI &&
    Number.isFinite(adx) &&
    adx >= CONFIG.POST_EXIT_CONTINUATION_STRONG_MIN_ADX &&
    chasePct <= CONFIG.POST_EXIT_CONTINUATION_STRONG_MAX_CHASE_PCT;
  const strongReentry =
    source !== "post_exit_continuation_reentry" &&
    CONFIG.STRONG_REENTRY_OVERRIDE_ENABLED &&
    Number.isFinite(rsi) &&
    rsi >= CONFIG.STRONG_REENTRY_MIN_RSI &&
    Number.isFinite(adx) &&
    adx >= CONFIG.STRONG_REENTRY_MIN_ADX &&
    chasePct <= CONFIG.STRONG_REENTRY_MAX_CHASE_PCT;
  const allow = reasons.length === 0 || strongPostExit || strongReentry;
  return {
    allow,
    reason: allow ? (strongPostExit || strongReentry ? "strong_reentry_override" : "reentry_ok") : reasons[0],
    mode:
      source === "post_exit_continuation_reentry"
        ? strongPostExit
          ? "post_exit_continuation_reentry_long_strong"
          : "post_exit_continuation_reentry_long"
        : strongReentry
        ? "feature_pullback_reclaim_reentry_long_strong"
        : "feature_pullback_reclaim_reentry_long",
    stop: Number.isFinite(ema18) ? ema18 * (1 - CONFIG.HARD_STOP_PCT / 100) : close * (1 - CONFIG.HARD_STOP_PCT / 100),
    metrics: { source, anchor, close, chasePct, resetPct, rsi, adx, ext18, fvvo: fv, reasons, strongPostExit, strongReentry },
  };
}
function evaluateElevatedContinuation(source, body) {
  if (!CONFIG.ELEVATED_CONTINUATION_ENABLED) return { allow: false, reason: "disabled" };
  const ctx = baseFeatureEntryContext();
  if (!ctx.ok) return { allow: false, reason: ctx.reason };
  const { f, fv, close, ema8, ema18, adx, rsi, ext18, ema8SlopePct } = ctx;
  if (!S.ray.bullContext) return { allow: false, reason: "no_bull_context" };
  const triggerPrice = n(pickFirst(body, ["price", "trigger_price", "close"], close), close);
  const chasePct = pctDiff(triggerPrice, close);
  const reasons = [];
  reasonPush(reasons, S.barIndex > (n(S.breakoutMemory.armedBar, S.barIndex) + CONFIG.ELEVATED_CONTINUATION_WINDOW_BARS), "window_expired");
  reasonPush(reasons, Number.isFinite(rsi) && rsi < CONFIG.ELEVATED_CONTINUATION_MIN_RSI, "rsi_too_low");
  reasonPush(reasons, Number.isFinite(adx) && adx < CONFIG.ELEVATED_CONTINUATION_MIN_ADX, "adx_too_low");
  reasonPush(reasons, chasePct > CONFIG.ELEVATED_CONTINUATION_MAX_CHASE_PCT, "chase_too_high");
  reasonPush(reasons, ext18 > CONFIG.ELEVATED_CONTINUATION_MAX_EXT_FROM_EMA18_PCT, "ext18_too_high");
  reasonPush(reasons, ema8SlopePct < CONFIG.ELEVATED_CONTINUATION_MIN_EMA8_SLOPE_PCT, "ema8_slope_too_low");
  reasonPush(reasons, CONFIG.ELEVATED_CONTINUATION_REQUIRE_CLOSE_ABOVE_EMA8 && !(Number.isFinite(close) && Number.isFinite(ema8) && close >= ema8), "close_below_ema8");
  reasonPush(reasons, !CONFIG.ELEVATED_CONTINUATION_ALLOW_NEGATIVE_FVVO_IF_STRONG && fv.score < 0, "fvvo_negative");
  const allow = reasons.length === 0;
  return {
    allow,
    reason: allow ? "elevated_continuation_ok" : reasons[0],
    mode: "elevated_continuation_long",
    stop: Number.isFinite(ema18) ? ema18 * (1 - CONFIG.HARD_STOP_PCT / 100) : close * (1 - CONFIG.HARD_STOP_PCT / 100),
    metrics: { source, triggerPrice, close, chasePct, rsi, adx, ext18, ema8SlopePct, fvvo: fv, reasons },
  };
}
function evaluateFastTickLaunch(px) {
  const ftl = S.fastTickLaunch;
  if (!ftl.active) return { allow: false, reason: "not_active" };
  if (nowMs() > ftl.expiresAtMs) {
    clearFastTickLaunch("expired");
    return { allow: false, reason: "expired" };
  }
  if (ftl.bullRegimeId !== S.ray.bullRegimeId || !S.ray.bullContext) return { allow: false, reason: "regime_changed" };
  const f = S.lastFeature;
  const fv = getFvvoScore();
  const adx = n(f?.adx ?? ftl.adx, NaN);
  const rsi = n(f?.rsi ?? ftl.rsi, NaN);
  const ema18 = n(f?.ema18 ?? ftl.ema18, NaN);
  const chasePct = pctDiff(ftl.rayPrice, px);
  const strong =
    Number.isFinite(rsi) &&
    rsi >= CONFIG.FAST_TICK_LAUNCH_STRONG_MIN_RSI &&
    Number.isFinite(adx) &&
    adx >= CONFIG.FAST_TICK_LAUNCH_STRONG_MIN_ADX &&
    chasePct <= CONFIG.FAST_TICK_LAUNCH_STRONG_MAX_CHASE_PCT;
  const normal =
    Number.isFinite(rsi) &&
    rsi >= CONFIG.FAST_TICK_LAUNCH_MIN_RSI &&
    Number.isFinite(adx) &&
    adx >= CONFIG.FAST_TICK_LAUNCH_MIN_ADX &&
    chasePct <= CONFIG.FAST_TICK_LAUNCH_MAX_CHASE_PCT &&
    ftl.ticksAboveConfirm >= CONFIG.FAST_TICK_LAUNCH_MIN_TICKS_ABOVE_CONFIRM;
  const allow = strong || normal;
  return {
    allow,
    reason: allow ? (strong ? "fast_tick_strong_confirmed" : "fast_tick_confirmed") : "not_confirmed",
    mode: strong ? "tick_confirmed_launch_long_strong" : "tick_confirmed_launch_long",
    stop: Number.isFinite(ema18) ? ema18 * (1 - CONFIG.HARD_STOP_PCT / 100) : px * (1 - CONFIG.HARD_STOP_PCT / 100),
    metrics: { price: px, rayPrice: ftl.rayPrice, confirmPrice: ftl.confirmPrice, chasePct, rsi, adx, ticksAboveConfirm: ftl.ticksAboveConfirm, fvvo: fv },
  };
}
function tryEntry(source, body) {
  if (S.inPosition) return { allow: false, reason: "already_in_position" };
  if (!isTickFresh()) return { allow: false, reason: "stale_tick" };
  if (actionClockMs(pickFirst(body, ["time", "timestamp"], null)) < S.cooldownUntilMs) return { allow: false, reason: "cooldown" };
  const eventIso = pickFirst(body, ["time", "timestamp"], isoNow());
  if (!canEnterByDedup(source, eventIso)) return { allow: false, reason: "enter_dedup" };
  let decision;
  if (source === "feature_reentry" || source === "post_exit_continuation_reentry") decision = evaluateFeatureReentry(source, body);
  else if (source === "tick_confirmed_fast_launch") decision = evaluateFastTickLaunch(n(body.price, NaN));
  else if (source === "ray_bullish_trend_continuation") decision = evaluateElevatedContinuation(source, body);
  else decision = evaluateLaunchEntry(source, body);
  log(decision.allow ? "🧪 ENTRY_DECISION" : "🟥⛔ ENTRY_BLOCKED", {
    source,
    allow: decision.allow,
    reason: decision.reason,
    mode: decision.mode,
    metrics: decision.metrics,
  });
  if (decision.allow) doEnter(decision.mode, n(pickFirst(body, ["price", "trigger_price", "close"], currentPrice()), currentPrice()), decision, eventIso);
  return decision;
}
function doEnter(mode, price, decision, eventIso = isoNow()) {
  if (S.inPosition) return;
  const stop = Number.isFinite(decision?.stop) ? decision.stop : price * (1 - CONFIG.HARD_STOP_PCT / 100);
  S.inPosition = true;
  S.entryPrice = price;
  S.entryAt = eventIso;
  S.entryMode = mode;
  S.stopPrice = stop;
  S.beArmed = false;
  S.peakPrice = price;
  S.peakPnlPct = 0;
  S.dynamicTpTier = 0;
  S.lastEnterAtMs = actionClockMs(eventIso);
  S.lastAction = "enter";
  S.cycleState = "long";
  if (isReentryHarvestMode(mode)) S.ray.reentryCountInRegime += 1;
  clearBreakoutMemory("entered");
  clearReentry("entered");
  clearPostExitContinuation("entered");
  clearTrendChangeLaunch("entered");
  clearFastTickLaunch("entered");
  clearFirstEntry("entered");
  log("🟩🟢 ENTER_LONG", {
    brain: CONFIG.BRAIN_NAME,
    mode,
    price: round4(price),
    stop: round4(stop),
    reason: decision?.reason || null,
    redFlags: Array.isArray(decision?.redFlags) ? decision.redFlags : [],
    metrics: decision?.metrics || null,
  });
  forward3Commas("enter_long", price, { mode, setup_type: mode, brain: CONFIG.BRAIN_NAME }, eventIso).catch((err) => {
    log("❌ 3COMMAS_ENTER_ERROR", { err: String(err?.message || err) });
  });
}
// --------------------------------------------------
// exits

// --------------------------------------------------
function currentDynamicTpTier(pnlPct) {
  if (!CONFIG.DYNAMIC_TP_ENABLED) return 0;
  if (pnlPct >= CONFIG.DTP_TIER3_ARM_PCT) return 3;
  if (pnlPct >= CONFIG.DTP_TIER2_ARM_PCT) return 2;
  if (pnlPct >= CONFIG.DTP_TIER1_ARM_PCT) return 1;
  return 0;
}
function dynamicTpGivebackForTier(tier) {
  if (tier === 3) return CONFIG.DTP_TIER3_GIVEBACK_PCT;
  if (tier === 2) return CONFIG.DTP_TIER2_GIVEBACK_PCT;
  if (tier === 1) return CONFIG.DTP_TIER1_GIVEBACK_PCT;
  return null;
}
function shouldBlockLaunchDynamicTp(feature, pnlPct, tier, fv) {
  if (!CONFIG.LAUNCH_TP_PROTECTION_ENABLED) return false;
  if (!isLaunchMode(S.entryMode)) return false;
  if (tier !== 1 || !CONFIG.LAUNCH_TP_PROTECTION_BLOCK_TIER1) return false;
  const adx = n(feature?.adx, NaN);
  const rsi = n(feature?.rsi, NaN);
  const close = n(feature?.close, NaN);
  const ema8 = n(feature?.ema8, NaN);
  const adxOk = Number.isFinite(adx) && adx >= CONFIG.LAUNCH_TP_PROTECTION_MIN_ADX;
  const rsiOk = Number.isFinite(rsi) && rsi >= CONFIG.LAUNCH_TP_PROTECTION_MIN_RSI;
  const profitTooEarly = pnlPct < CONFIG.LAUNCH_TP_PROTECTION_MIN_PROFIT_PCT;
  const priceAboveEma8Ok = !CONFIG.LAUNCH_TP_PROTECTION_REQUIRE_PRICE_ABOVE_EMA8 || (Number.isFinite(close) && Number.isFinite(ema8) && close >= ema8);
  const bullishFvvoHold = CONFIG.LAUNCH_TP_PROTECTION_BLOCK_IF_BULLISH_FVVO && fv.score > 0;
  const block = profitTooEarly || ((adxOk && rsiOk && priceAboveEma8Ok) || bullishFvvoHold);
  if (CONFIG.LAUNCH_TP_PROTECTION_LOG) {
    log("🟦 LAUNCH_TP_PROTECTION_CHECK", { block, entryMode: S.entryMode, tier, pnlPct: round4(pnlPct), adx: round4(adx), rsi: round4(rsi), priceAboveEma8Ok, bullishFvvoHold, fvvo: fv });
  }
  return block;
}
function shouldBlockPostExitContinuationDynamicTp(feature, pnlPct, tier, fv) {
  if (!CONFIG.POST_EXIT_CONT_TP_PROTECTION_ENABLED) return false;
  if (!isProtectedContinuationMode(S.entryMode)) return false;
  if (tier !== 1 || !CONFIG.POST_EXIT_CONT_TP_PROTECTION_BLOCK_TIER1) return false;
  const adx = n(feature?.adx, NaN);
  const rsi = n(feature?.rsi, NaN);
  const close = n(feature?.close, NaN);
  const ema8 = n(feature?.ema8, NaN);
  const stillEarlyProfit = pnlPct < CONFIG.POST_EXIT_CONT_TP_PROTECTION_MAX_PROTECT_PROFIT_PCT;
  const adxOk = Number.isFinite(adx) && adx >= CONFIG.POST_EXIT_CONT_TP_PROTECTION_MIN_ADX;
  const rsiOk = Number.isFinite(rsi) && rsi >= CONFIG.POST_EXIT_CONT_TP_PROTECTION_MIN_RSI;
  const priceAboveEma8Ok = !CONFIG.POST_EXIT_CONT_TP_PROTECTION_REQUIRE_PRICE_ABOVE_EMA8 || (Number.isFinite(close) && Number.isFinite(ema8) && close >= ema8);
  const bullishFvvoHold = CONFIG.POST_EXIT_CONT_TP_PROTECTION_BLOCK_IF_BULLISH_FVVO && fv.score > 0;
  const block = stillEarlyProfit && adxOk && rsiOk && priceAboveEma8Ok && !fv.snap.burstBearish && !fv.snap.sniperSell && (bullishFvvoHold || true);
  if (CONFIG.POST_EXIT_CONT_TP_PROTECTION_LOG) {
    log("🟪 POST_EXIT_CONT_TP_PROTECTION_CHECK", { block, entryMode: S.entryMode, tier, pnlPct: round4(pnlPct), adx: round4(adx), rsi: round4(rsi), priceAboveEma8Ok, bullishFvvoHold, fvvo: fv });
  }
  return block;
}
function shouldPostExitContinuationProfitGuardExit(price, eventIso = isoNow()) {
  if (!CONFIG.POST_EXIT_CONT_PROFIT_GUARD_ENABLED) return { allow: false, reason: "disabled" };
  if (!S.inPosition) return { allow: false, reason: "not_in_position" };
  if (!isProtectedContinuationMode(S.entryMode)) return { allow: false, reason: "not_post_exit_continuation" };
  if (!Number.isFinite(price) || !Number.isFinite(S.entryPrice)) return { allow: false, reason: "bad_price" };

  const pnlPct = pctDiff(S.entryPrice, price);
  const peakPnlPct = Math.max(n(S.peakPnlPct, pnlPct), pnlPct);
  const givebackPct = Math.max(0, peakPnlPct - pnlPct);

  const armed = peakPnlPct >= CONFIG.POST_EXIT_CONT_PROFIT_GUARD_ARM_PEAK_PCT;
  const lockHit = armed && pnlPct <= CONFIG.POST_EXIT_CONT_PROFIT_GUARD_LOCK_PCT;
  const givebackHit = armed && givebackPct >= CONFIG.POST_EXIT_CONT_PROFIT_GUARD_GIVEBACK_PCT;
  const emergencyHit = armed && pnlPct <= CONFIG.POST_EXIT_CONT_PROFIT_GUARD_MIN_CURRENT_PCT;

  if (CONFIG.POST_EXIT_CONT_PROFIT_GUARD_LOG) {
    log("🟪 POST_EXIT_CONT_PROFIT_GUARD_CHECK", {
      entryMode: S.entryMode,
      price: round4(price),
      entryPrice: round4(S.entryPrice),
      pnlPct: round4(pnlPct),
      peakPnlPct: round4(peakPnlPct),
      givebackPct: round4(givebackPct),
      armed,
      lockHit,
      givebackHit,
      emergencyHit,
      eventIso,
    });
  }

  if (emergencyHit) {
    return { allow: true, reason: "post_exit_cont_profit_guard_emergency", pnlPct, peakPnlPct, givebackPct };
  }
  if (givebackHit) {
    return { allow: true, reason: "post_exit_cont_profit_guard_giveback", pnlPct, peakPnlPct, givebackPct };
  }
  if (lockHit) {
    return { allow: true, reason: "post_exit_cont_profit_guard_lock", pnlPct, peakPnlPct, givebackPct };
  }

  return { allow: false, reason: "guard_not_hit", pnlPct, peakPnlPct, givebackPct };
}

function shouldReentryTopHarvestExit(feature, pnlPct, fv) {
  if (!CONFIG.REENTRY_TOP_HARVEST_ENABLED) return { allow: false, reason: "disabled" };
  if (!isReentryHarvestMode(S.entryMode)) return { allow: false, reason: "not_target_mode" };
  const price = n(feature.close, NaN);
  const ema8 = n(feature.ema8, NaN);
  const ema18 = n(feature.ema18, NaN);
  const adx = n(feature.adx, NaN);
  const prev = S.prevFeature;
  if (!Number.isFinite(price) || !Number.isFinite(ema8) || !Number.isFinite(ema18)) return { allow: false, reason: "bad_feature_values" };
  const extFromEma8 = pctDiff(ema8, price);
  const extFromEma18 = pctDiff(ema18, price);
  const rsiHighRecent = recentRsiHigh(3);
  const rsiRolldown = Number.isFinite(prev?.rsi) && Number.isFinite(feature.rsi) && feature.rsi < prev.rsi;
  const oneWeakBar = wasWeakeningBar(feature, prev);
  const twoWeakBars = twoConsecutiveWeakeningBars();
  const bearishFvvoAccel = CONFIG.REENTRY_TOP_HARVEST_ALLOW_BEARISH_FVVO_ACCELERATOR && (fv.score < 0 || fv.snap.sniperSell || fv.snap.burstBearish);
  const classicWeaknessOk =
    (CONFIG.REENTRY_TOP_HARVEST_ALLOW_TWO_WEAK_BARS && twoWeakBars) ||
    (CONFIG.REENTRY_TOP_HARVEST_ALLOW_ONE_WEAK_BAR && oneWeakBar) ||
    bearishFvvoAccel;
  const classicReasons = [];
  reasonPush(classicReasons, pnlPct < CONFIG.REENTRY_TOP_HARVEST_MIN_PROFIT_PCT, "profit_too_low");
  reasonPush(classicReasons, !Number.isFinite(adx) || adx < CONFIG.REENTRY_TOP_HARVEST_MIN_ADX, "adx_too_low");
  reasonPush(classicReasons, !Number.isFinite(rsiHighRecent) || rsiHighRecent < CONFIG.REENTRY_TOP_HARVEST_MIN_RSI_RECENT_HIGH, "no_recent_rsi_high");
  reasonPush(classicReasons, extFromEma8 < CONFIG.REENTRY_TOP_HARVEST_MIN_EXT_FROM_EMA8_PCT, "ext_from_ema8_too_low");
  reasonPush(classicReasons, extFromEma18 < CONFIG.REENTRY_TOP_HARVEST_MIN_EXT_FROM_EMA18_PCT, "ext_from_ema18_too_low");
  reasonPush(classicReasons, CONFIG.REENTRY_TOP_HARVEST_REQUIRE_RSI_ROLLDOWN && !rsiRolldown, "rsi_not_rolling_down");
  reasonPush(classicReasons, !classicWeaknessOk, "weakness_not_confirmed");
  const classicAllow = classicReasons.length === 0;

  const softStrongNegativeFvvo = fv.snap.burstBearish || fv.score <= -2;
  const softFvvoOk = !CONFIG.REENTRY_TOP_HARVEST_SOFT_REQUIRE_BULLISH_FVVO_NOT_STRONG_NEGATIVE || !softStrongNegativeFvvo;
  const softReasons = [];
  if (CONFIG.REENTRY_TOP_HARVEST_SOFT_ENABLED) {
    reasonPush(softReasons, pnlPct < CONFIG.REENTRY_TOP_HARVEST_SOFT_MIN_PROFIT_PCT, "soft_profit_too_low");
    reasonPush(softReasons, (S.peakPnlPct || 0) < CONFIG.REENTRY_TOP_HARVEST_SOFT_MIN_PEAK_PROFIT_PCT, "soft_peak_profit_too_low");
    reasonPush(softReasons, !Number.isFinite(adx) || adx < CONFIG.REENTRY_TOP_HARVEST_SOFT_MIN_ADX, "soft_adx_too_low");
    reasonPush(softReasons, extFromEma8 < CONFIG.REENTRY_TOP_HARVEST_SOFT_MIN_EXT_FROM_EMA8_PCT, "soft_ext_from_ema8_too_low");
    reasonPush(softReasons, extFromEma18 < CONFIG.REENTRY_TOP_HARVEST_SOFT_MIN_EXT_FROM_EMA18_PCT, "soft_ext_from_ema18_too_low");
    reasonPush(softReasons, !softFvvoOk, "soft_strong_negative_fvvo");
  } else softReasons.push("soft_disabled");
  const softAllow = softReasons.length === 0;

  const postExitSoftReasons = [];
  let postExitSoftAllow = false;
  if (isProtectedContinuationMode(S.entryMode) && CONFIG.POST_EXIT_CONT_HARVEST_SOFT_ENABLED) {
    const postExitFvvoOk = !CONFIG.POST_EXIT_CONT_HARVEST_SOFT_REQUIRE_NOT_STRONG_NEGATIVE_FVVO || !softStrongNegativeFvvo;
    reasonPush(postExitSoftReasons, pnlPct < CONFIG.POST_EXIT_CONT_HARVEST_SOFT_MIN_PROFIT_PCT, "post_exit_soft_profit_too_low");
    reasonPush(postExitSoftReasons, (S.peakPnlPct || 0) < CONFIG.POST_EXIT_CONT_HARVEST_SOFT_MIN_PEAK_PROFIT_PCT, "post_exit_soft_peak_profit_too_low");
    reasonPush(postExitSoftReasons, !Number.isFinite(adx) || adx < CONFIG.POST_EXIT_CONT_HARVEST_SOFT_MIN_ADX, "post_exit_soft_adx_too_low");
    reasonPush(postExitSoftReasons, extFromEma8 < CONFIG.POST_EXIT_CONT_HARVEST_SOFT_MIN_EXT_FROM_EMA8_PCT, "post_exit_soft_ext_from_ema8_too_low");
    reasonPush(postExitSoftReasons, extFromEma18 < CONFIG.POST_EXIT_CONT_HARVEST_SOFT_MIN_EXT_FROM_EMA18_PCT, "post_exit_soft_ext_from_ema18_too_low");
    reasonPush(postExitSoftReasons, !postExitFvvoOk, "post_exit_soft_strong_negative_fvvo");
    postExitSoftAllow = postExitSoftReasons.length === 0;
  }

  let chosenPath = "none";
  let allow = false;
  if (classicAllow) {
    allow = true;
    chosenPath = "classic";
  } else if (postExitSoftAllow) {
    allow = true;
    chosenPath = "post_exit_soft";
  } else if (softAllow) {
    allow = true;
    chosenPath = "soft";
  }

  if (CONFIG.REENTRY_TOP_HARVEST_LOG_DEBUG) {
    log("🟠 REENTRY_TOP_HARVEST_CHECK", {
      allow,
      path: chosenPath,
      entryMode: S.entryMode,
      classicReasons,
      softReasons,
      postExitSoftReasons,
      pnlPct: round4(pnlPct),
      peakPnlPct: round4(S.peakPnlPct),
      adx: round4(adx),
      rsi: round4(feature.rsi),
      recentRsiHigh: round4(rsiHighRecent),
      extFromEma8: round4(extFromEma8),
      extFromEma18: round4(extFromEma18),
      rsiRolldown,
      oneWeakBar,
      twoWeakBars,
      bearishFvvoAccel,
      fvvo: fv,
    });
  }
  if (allow) return { allow: true, path: chosenPath, extFromEma8, extFromEma18, recentRsiHigh, rsiRolldown, oneWeakBar, twoWeakBars, bearishFvvoAccel };
  return { allow: false, reason: classicReasons[0] || postExitSoftReasons[0] || softReasons[0] || "blocked" };
}
function updatePositionFromTick(price, eventIso = isoNow()) {
  if (!S.inPosition || !Number.isFinite(price) || !Number.isFinite(S.entryPrice)) return;
  if (!Number.isFinite(S.peakPrice) || price > S.peakPrice) S.peakPrice = price;
  const pnlPct = pctDiff(S.entryPrice, price);
  S.peakPnlPct = Math.max(S.peakPnlPct || 0, pnlPct);
  const tier = currentDynamicTpTier(S.peakPnlPct);
  if (tier > (S.dynamicTpTier || 0)) {
    S.dynamicTpTier = tier;
    log(`🎯 DYNAMIC_TP_TIER_${tier}_ARMED`, { pnlPct: round4(pnlPct), peakPnlPct: round4(S.peakPnlPct) });
  }
  if (!S.beArmed && pnlPct >= CONFIG.BREAKEVEN_ARM_PCT) {
    S.beArmed = true;
    const beStop = S.entryPrice * (1 + CONFIG.BREAKEVEN_OFFSET_PCT / 100);
    S.stopPrice = Math.max(S.stopPrice, beStop);
    log("🛡️ BREAKEVEN_ARMED", { pnlPct: round4(pnlPct), stopPrice: round4(S.stopPrice) });
  }

  const postExitProfitGuard = shouldPostExitContinuationProfitGuardExit(price, eventIso);
  if (postExitProfitGuard.allow) {
    return doExit(postExitProfitGuard.reason, price, eventIso, "cycle_exit");
  }

  if (price <= S.stopPrice) {
    const exitClass = S.beArmed ? "cycle_exit" : "stop_exit";
    return doExit("hard_or_breakeven_stop", price, eventIso, exitClass);
  }
  if (CONFIG.DYNAMIC_TP_ENABLED && S.dynamicTpTier > 0) {
    const giveback = dynamicTpGivebackForTier(S.dynamicTpTier);
    const peakPnl = S.peakPnlPct || 0;
    const pnlGiveback = peakPnl - pnlPct;
    const fv = getFvvoScore();
    const feature = S.lastFeature;
    if (Number.isFinite(giveback) && pnlGiveback >= giveback) {
      if (shouldBlockLaunchDynamicTp(feature, pnlPct, S.dynamicTpTier, fv)) {
        log("🟦 LAUNCH_TP_PROTECTION_BLOCKED_EXIT", { tier: S.dynamicTpTier, pnlPct: round4(pnlPct), peakPnlPct: round4(peakPnl), pnlGiveback: round4(pnlGiveback), entryMode: S.entryMode });
        return;
      }
      if (shouldBlockPostExitContinuationDynamicTp(feature, pnlPct, S.dynamicTpTier, fv)) {
        log("🟪 POST_EXIT_CONT_TP_PROTECTION_BLOCKED_EXIT", { tier: S.dynamicTpTier, pnlPct: round4(pnlPct), peakPnlPct: round4(peakPnl), pnlGiveback: round4(pnlGiveback), entryMode: S.entryMode });
        return;
      }
      return doExit(`dynamic_tp_tier${S.dynamicTpTier}_giveback`, price, eventIso, "cycle_exit");
    }
  } else {
    const drawFromPeakPct = Number.isFinite(S.peakPrice) ? -pctDiff(S.peakPrice, price) : 0;
    if (pnlPct >= CONFIG.PROFIT_LOCK_ARM_PCT && drawFromPeakPct >= CONFIG.PROFIT_LOCK_GIVEBACK_PCT) return doExit("profit_lock_giveback", price, eventIso, "cycle_exit");
    if (pnlPct >= CONFIG.TRAIL_ARM_PCT && drawFromPeakPct >= CONFIG.TRAIL_GIVEBACK_PCT) return doExit("trail_giveback", price, eventIso, "cycle_exit");
  }
}
function isStrongTrendHold(feature, fv) {
  const rsi = n(feature.rsi, NaN);
  const adx = n(feature.adx, NaN);
  if (!CONFIG.STRONG_TREND_HOLD_ENABLED) return false;
  if (!CONFIG.STRONG_TREND_HOLD_BLOCK_LOCAL_TP) return false;
  if (!Number.isFinite(rsi) || !Number.isFinite(adx)) return false;
  if (rsi < CONFIG.STRONG_TREND_HOLD_MIN_RSI) return false;
  if (adx < CONFIG.STRONG_TREND_HOLD_MIN_ADX) return false;
  if (CONFIG.STRONG_TREND_HOLD_BLOCK_IF_BEARISH_FVVO && fv.score < 0) return false;
  return true;
}
function shouldTopHarvestExit() {
  if (!CONFIG.TOP_HARVEST_ENABLED) return { allow: false, reason: "disabled" };
  return { allow: false, reason: "disabled_for_v50" };
}
function evaluateBarExit(feature) {
  if (!S.inPosition) return;
  const price = n(feature.close, currentPrice());
  const pnlPct = pctDiff(S.entryPrice, price);
  const fv = getFvvoScore();
  const prev = S.prevFeature;

  const reentryHarvest = shouldReentryTopHarvestExit(feature, pnlPct, fv);
  if (reentryHarvest.allow) return doExit("reentry_top_harvest_exit", price, feature.time, "cycle_exit");

  const postExitProfitGuard = shouldPostExitContinuationProfitGuardExit(price, feature.time);
  if (postExitProfitGuard.allow) return doExit(postExitProfitGuard.reason, price, feature.time, "cycle_exit");

  const topHarvest = shouldTopHarvestExit(feature, pnlPct, fv);
  if (topHarvest.allow) return doExit("cycle_top_harvest_exit", price, feature.time, "cycle_exit");

  if (
    CONFIG.LOCAL_TP_EXIT_ENABLED &&
    CONFIG.LOCAL_TP_EXIT_ON_CLOSE_BELOW_EMA8 &&
    Number.isFinite(feature.ema8) &&
    pnlPct >= CONFIG.LOCAL_TP_MIN_PROFIT_PCT
  ) {
    const belowBufferedEma8 = price < feature.ema8 * (1 - CONFIG.LOCAL_TP_EMA8_BUFFER_PCT / 100);
    const belowEma18 = Number.isFinite(feature.ema18) && price < feature.ema18;
    const oneWeakBar = wasWeakeningBar(feature, prev);
    const twoWeakBars = twoConsecutiveWeakeningBars();
    const holdByStrength = Number.isFinite(feature.rsi) && feature.rsi >= CONFIG.LOCAL_TP_MIN_RSI_TO_HOLD && Number.isFinite(feature.adx) && feature.adx >= CONFIG.LOCAL_TP_MIN_ADX_TO_HOLD;
    const holdByBullishFvvo = CONFIG.LOCAL_TP_BLOCK_IF_BULLISH_FVVO && fv.score > 0;
    const strongTrendHold = isStrongTrendHold(feature, fv);
    const rsiWeakEnough =
      Number.isFinite(feature.rsi) &&
      feature.rsi <=
        (Number.isFinite(feature.adx) && feature.adx >= CONFIG.LOCAL_TP_STRONG_ADX_HARD_BLOCK
          ? CONFIG.LOCAL_TP_RSI_WEAKNESS_THRESHOLD_STRONG_TREND
          : CONFIG.LOCAL_TP_RSI_WEAKNESS_THRESHOLD);
    const forceAllowByEma18 = CONFIG.LOCAL_TP_FORCE_ALLOW_IF_CLOSE_BELOW_EMA18 && belowEma18;
    const forceAllowByBearishFvvo = CONFIG.LOCAL_TP_FORCE_ALLOW_IF_BEARISH_FVVO && fv.score < 0;
    const forceAllowByWeakBars = CONFIG.LOCAL_TP_FORCE_ALLOW_ON_TWO_WEAKENING_BARS && twoWeakBars;
    const extraConfirmationOk = !CONFIG.LOCAL_TP_REQUIRE_CLOSE_BELOW_EMA18_OR_2_WEAK_BARS || belowEma18 || twoWeakBars || rsiWeakEnough;
    const hardBlockByStrongAdx =
      Number.isFinite(feature.adx) &&
      feature.adx >= CONFIG.LOCAL_TP_STRONG_ADX_HARD_BLOCK &&
      !forceAllowByEma18 &&
      !forceAllowByBearishFvvo &&
      !forceAllowByWeakBars &&
      !rsiWeakEnough;
    const strongTrendNeedsTwoWeakBars =
      CONFIG.LOCAL_TP_REQUIRE_TWO_WEAKENING_BARS_IN_STRONG_TREND &&
      Number.isFinite(feature.adx) &&
      feature.adx >= CONFIG.LOCAL_TP_STRONG_ADX_HARD_BLOCK &&
      !twoWeakBars &&
      !belowEma18 &&
      !rsiWeakEnough;
    const strongTrendHardHoldActive =
      CONFIG.LOCAL_TP_STRONG_TREND_HARD_HOLD_ENABLED &&
      Number.isFinite(feature.adx) &&
      feature.adx >= CONFIG.LOCAL_TP_STRONG_TREND_HARD_HOLD_MIN_ADX &&
      (!CONFIG.LOCAL_TP_STRONG_TREND_HARD_HOLD_REQUIRE_EMA8_ABOVE_EMA18 ||
        (Number.isFinite(feature.ema8) && Number.isFinite(feature.ema18) && feature.ema8 > feature.ema18)) &&
      (!Number.isFinite(feature.rsi) || feature.rsi >= CONFIG.LOCAL_TP_STRONG_TREND_HARD_HOLD_REQUIRE_RSI_ABOVE);
    const strongTrendHardHoldCanExitByWeakness =
      (CONFIG.LOCAL_TP_STRONG_TREND_ALLOW_ONLY_IF_CLOSE_BELOW_EMA18 && belowEma18) ||
      (CONFIG.LOCAL_TP_STRONG_TREND_ALLOW_IF_TWO_WEAK_BARS_AND_RSI_WEAK &&
        twoWeakBars &&
        Number.isFinite(feature.rsi) &&
        feature.rsi <= CONFIG.LOCAL_TP_STRONG_TREND_RSI_WEAK_MAX) ||
      forceAllowByBearishFvvo;
    const blockedByStrongTrendHardHold = strongTrendHardHoldActive && !strongTrendHardHoldCanExitByWeakness;
    const strictStrongTrendGateActive =
      CONFIG.LOCAL_TP_STRICT_STRONG_TREND_GATE_ENABLED &&
      Number.isFinite(feature.adx) &&
      feature.adx >= CONFIG.LOCAL_TP_STRICT_STRONG_TREND_MIN_ADX &&
      (!CONFIG.LOCAL_TP_STRICT_STRONG_TREND_REQUIRE_EMA8_GT_EMA18 ||
        (Number.isFinite(feature.ema8) && Number.isFinite(feature.ema18) && feature.ema8 > feature.ema18));
    const strictStrongTrendAllowsExit =
      belowEma18 ||
      (CONFIG.LOCAL_TP_STRICT_STRONG_TREND_ALLOW_TWO_WEAK_BARS_AND_RSI_WEAK &&
        (!CONFIG.LOCAL_TP_STRICT_STRONG_TREND_REQUIRE_TWO_WEAK_BARS || twoWeakBars) &&
        Number.isFinite(feature.rsi) &&
        feature.rsi <= CONFIG.LOCAL_TP_STRICT_STRONG_TREND_RSI_WEAK_MAX) ||
      forceAllowByBearishFvvo;
    const blockedByStrictStrongTrendGate = strictStrongTrendGateActive && !strictStrongTrendAllowsExit;

    if (
      belowBufferedEma8 &&
      oneWeakBar &&
      extraConfirmationOk &&
      !holdByStrength &&
      !holdByBullishFvvo &&
      !strongTrendHold &&
      !hardBlockByStrongAdx &&
      !strongTrendNeedsTwoWeakBars &&
      !blockedByStrongTrendHardHold &&
      !blockedByStrictStrongTrendGate
    ) {
      return doExit("local_tp_close_below_ema8", price, feature.time, "cycle_exit");
    }
  }

  if (CONFIG.EXIT_ON_5M_CLOSE_BELOW_EMA18 && Number.isFinite(feature.ema18) && price < feature.ema18) {
    return doExit("close_below_ema18_5m", price, feature.time, "regime_break");
  }
}
function markReentryEligible(reason, exitPrice, exitPnlPct, peakBeforeExit) {
  if (!CONFIG.PHASE2_REENTRY_ENABLED) return;
  if (!CONFIG.KEEP_BULL_CONTEXT_ON_TP_EXIT) return;
  if (!S.ray.bullContext) return;
  if (S.ray.reentryCountInRegime >= CONFIG.MAX_REENTRIES_PER_BULL_REGIME) return;
  const anchor = Number.isFinite(S.lastFeature?.ema8) ? S.lastFeature.ema8 : Number.isFinite(exitPrice) ? exitPrice : peakBeforeExit;
  S.reentry = {
    eligible: true,
    eligibleUntilBar: S.barIndex + 6,
    eligibleFromBar: S.barIndex + CONFIG.REENTRY_MIN_BARS_AFTER_EXIT,
    exitPrice,
    peakBeforeExit,
    anchorPrice: anchor,
    bullRegimeId: S.ray.bullRegimeId,
  };
  S.cycleState = "tp_exit_wait_reentry";
  log("🔁 TP_EXIT_WAIT_REENTRY", {
    reason,
    bullRegimeId: S.ray.bullRegimeId,
    reentryCountInRegime: S.ray.reentryCountInRegime,
    eligibleFromBar: S.reentry.eligibleFromBar,
    eligibleUntilBar: S.reentry.eligibleUntilBar,
    peakBeforeExit: round4(peakBeforeExit),
    anchorPrice: round4(anchor),
  });
  armPostExitContinuation(reason, exitPrice, exitPnlPct, peakBeforeExit);
}
function doFlatExitPassthrough(reason, price, ts, source = "flat_safety_exit") {
  if (!CONFIG.FORWARD_EXIT_WHEN_FLAT) return;
  if (!canExitByDedup(ts)) {
    log("⏸️ FLAT_EXIT_DEDUP_BLOCKED", { reason, source, ts, lastExitAtMs: S.lastExitAtMs, attemptClockMs: actionClockMs(ts), exitDedupMs: CONFIG.EXIT_DEDUP_MS });
    return;
  }
  const exitPrice = Number.isFinite(price) ? price : currentPrice();
  if (!Number.isFinite(exitPrice)) {
    log("🟥 FLAT_EXIT_PASSTHROUGH_BLOCKED", { reason: "bad_price", source, ts, price });
    return;
  }
  log("🟩🛟 FLAT_EXIT_PASSTHROUGH", {
    reason,
    source,
    price: round4(exitPrice),
    bullContext: S.ray.bullContext,
    cycleState: S.cycleState,
  });
  forward3Commas("exit_long", exitPrice, { reason, source, brain: CONFIG.BRAIN_NAME, safety: "flat_exit_passthrough" }, ts).catch((err) => {
    log("❌ 3COMMAS_FLAT_EXIT_ERROR", { err: String(err?.message || err) });
  });
  clearFirstEntry("flat_safety_exit");
  clearFastTickLaunch("flat_safety_exit");
  clearTrendChangeLaunch("flat_safety_exit");
  clearReentry("flat_safety_exit");
  clearPostExitContinuation("flat_safety_exit");
  S.lastExitAtMs = actionClockMs(ts);
  S.lastAction = "flat_exit_passthrough";
  S.lastExitClass = "flat_safety_exit";
  S.lastExitReason = reason;
  S.cycleState = "cooldown_flat_safety_exit";
  S.cooldownUntilMs = actionClockMs(ts) + CONFIG.EXIT_COOLDOWN_MIN * 60 * 1000;
}

function doExit(reason, price, ts, exitClass = "stop_exit") {
  if (!S.inPosition) return;
  if (!canExitByDedup(ts)) {
    log("⏸️ EXIT_DEDUP_BLOCKED", { reason, ts, entryMode: S.entryMode, lastExitAtMs: S.lastExitAtMs, attemptClockMs: actionClockMs(ts), exitDedupMs: CONFIG.EXIT_DEDUP_MS });
    return;
  }
  const exitPrice = Number.isFinite(price) ? price : currentPrice();
  const pnlPct = Number.isFinite(exitPrice) && Number.isFinite(S.entryPrice) ? pctDiff(S.entryPrice, exitPrice) : 0;
  const peakBeforeExit = getExitPeakSnapshot(exitPrice);
  const exitMs = actionClockMs(ts);
  const entryMs = parseTsMs(S.entryAt);
  log("🟩🔵 EXIT_LONG", {
    reason,
    exitClass,
    price: round4(exitPrice),
    pnlPct: round4(pnlPct),
    entryPrice: round4(S.entryPrice),
    entryMode: S.entryMode,
    peakBeforeExit: round4(peakBeforeExit),
    heldSec: Number.isFinite(entryMs) && Number.isFinite(exitMs) ? Math.max(0, Math.round((exitMs - entryMs) / 1000)) : null,
  });
  forward3Commas("exit_long", exitPrice, { reason, brain: CONFIG.BRAIN_NAME, entry_mode: S.entryMode }, ts).catch((err) => {
    log("❌ 3COMMAS_EXIT_ERROR", { err: String(err?.message || err) });
  });
  if (reason === "hard_or_breakeven_stop") clearFastTickLaunch("hard_or_breakeven_stop_exit");
  if (exitClass === "cycle_exit") markReentryEligible(reason, exitPrice, pnlPct, peakBeforeExit);
  else {
    clearReentry("non_cycle_exit");
    clearPostExitContinuation("non_cycle_exit");
  }
  if (exitClass === "regime_break") turnBullRegimeOff(ts, reason);
  S.inPosition = false;
  S.entryPrice = null;
  S.entryAt = null;
  S.entryMode = null;
  S.stopPrice = null;
  S.beArmed = false;
  S.peakPrice = null;
  S.peakPnlPct = 0;
  S.dynamicTpTier = 0;
  S.lastExitAtMs = actionClockMs(ts);
  S.lastAction = "exit";
  S.lastExitClass = exitClass;
  S.lastExitReason = reason;
  if (exitClass === "cycle_exit") S.cooldownUntilMs = 0;
  else {
    S.cooldownUntilMs = actionClockMs(ts) + CONFIG.EXIT_COOLDOWN_MIN * 60 * 1000;
    S.cycleState = "cooldown_hard";
  }
}

// --------------------------------------------------
// ticks
// --------------------------------------------------
export function handleTick(body) {
  const ts = pickFirst(body, ["time", "timestamp"], isoNow());
  const px = n(pickFirst(body, ["price", "close", "trigger_price"], NaN), NaN);
  if (!Number.isFinite(px)) return { ok: false, error: "bad_tick_price" };
  S.tickCount += 1;
  S.lastTickPrice = px;
  S.lastTickTime = ts;

  if (S.firstEntry.pending && !S.inPosition) {
    invalidateFirstEntryConfirm();
    if (S.firstEntry.pending && px >= n(S.firstEntry.confirmPrice, Infinity)) {
      S.firstEntry.ticksAboveConfirm += 1;
      S.firstEntry.lastConfirmedTickPrice = px;
      log("🟢 FIRST_ENTRY_TICK_CONFIRM", {
        price: px,
        ticksAboveConfirm: S.firstEntry.ticksAboveConfirm,
        required: CONFIG.FIRST_ENTRY_CONFIRM_MIN_TICKS,
        confirmPrice: round4(S.firstEntry.confirmPrice),
        rayPrice: round4(S.firstEntry.rayPrice),
      });
      if (S.firstEntry.ticksAboveConfirm >= CONFIG.FIRST_ENTRY_CONFIRM_MIN_TICKS) {
        const decision = {
          ...(S.firstEntry.decision || {}),
          mode: "first_bullish_trend_change_confirmed_long",
          reason: "first_entry_tick_confirmed",
          stop: Number.isFinite(S.lastFeature?.ema18) ? S.lastFeature.ema18 * (1 - CONFIG.HARD_STOP_PCT / 100) : px * (1 - CONFIG.HARD_STOP_PCT / 100),
        };
        if (canEnterByDedup("first_entry_tick_confirm", ts)) {
          doEnter("first_bullish_trend_change_confirmed_long", px, decision, ts);
          clearFirstEntry("consumed_on_confirmed_entry");
        } else {
          log("🚫 FIRST_ENTRY_CONFIRM_BLOCKED_BY_DEDUP", decision);
        }
      }
    }
  }

  if (S.fastTickLaunch.active && !S.inPosition) {
    if (px >= n(S.fastTickLaunch.confirmPrice, Infinity)) {
      S.fastTickLaunch.ticksAboveConfirm += 1;
      S.fastTickLaunch.lastConfirmedTickPrice = px;
      log("⚡ FAST_TICK_CONFIRM", { price: px, ticksAboveConfirm: S.fastTickLaunch.ticksAboveConfirm, confirmPrice: round4(S.fastTickLaunch.confirmPrice) });
      tryEntry("tick_confirmed_fast_launch", { src: "tick", symbol: CONFIG.SYMBOL, tf: CONFIG.ENTRY_TF, price: px, time: ts });
    }
  }

  updatePositionFromTick(px, ts);
  return { ok: true, kind: "tick", price: px, inPosition: S.inPosition };
}

