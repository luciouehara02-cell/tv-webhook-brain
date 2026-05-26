/**
 * BrainRAY_Continuation_v6.6d_ATR_STRUCTURE_SYNC_ADAPTIVE_TP
 * Source behavior: v6.6c ATR / structure stop + strong-feature confirm upgrade + adaptive TP ladder
 *
 * Main event coordinator. Express stays in server.js; trading logic stays in tradeEngine.js.
 */

import { CONFIG } from "./config.js";
import {
  S,
  log,
  resetRuntimeState,
  isTickFresh,
  isFeatureFresh,
} from "./stateStore.js";
import { normalizeSymbol, s } from "./utils.js";
import {
  handleTick,
  handleFeature,
  handleRayEvent,
  handleFvvoEvent,
  getFvvoScore,
} from "./tradeEngine.js";

export function parseInboundType(body) {
  const src = String(body.src || "").toLowerCase();
  const event = String(body.event || body.signal || body.alert || body.action || "").trim();
  if (src === "tick") return { family: "tick", name: "tick" };
  if (src === "feature" || src === "features") return { family: "feature", name: "feature" };
  if (src === "ray") return { family: "ray", name: event };
  if (src === "fvvo") return { family: "fvvo", name: event };
  return { family: "unknown", name: event || "unknown" };
}

export function getRootStatus() {
  return { ok: true, brain: CONFIG.BRAIN_NAME, symbol: CONFIG.SYMBOL, tf: CONFIG.ENTRY_TF, startedAt: S.startedAt };
}

export function getStatus() {
  return {
    ok: true,
    brain: CONFIG.BRAIN_NAME,
    symbol: CONFIG.SYMBOL,
    tf: CONFIG.ENTRY_TF,
    inPosition: S.inPosition,
    entryPrice: S.entryPrice,
    entryAt: S.entryAt,
    entryMode: S.entryMode,
    stopPrice: S.stopPrice,
    stopSource: S.stopSource,
    stopMeta: S.stopMeta,
    peakPrice: S.peakPrice,
    peakPnlPct: S.peakPnlPct,
    dynamicTpTier: S.dynamicTpTier,
    adaptiveTp: S.adaptiveTp,
    adaptiveTpConfig: {
      enabled: CONFIG.DYNAMIC_TP_ADAPTIVE_ENABLED,
      minGrossExitPnlPct: CONFIG.DYNAMIC_TP_MIN_GROSS_EXIT_PNL_PCT,
      minNetExitPnlPct: CONFIG.DYNAMIC_TP_MIN_NET_EXIT_PNL_PCT,
      feeRoundTripPct: CONFIG.FEE_ROUND_TRIP_PCT,
      slippageBufferPct: CONFIG.SLIPPAGE_BUFFER_PCT,
      oneBarPullbackEnabled: CONFIG.DYNAMIC_TP_ONE_BAR_PULLBACK_ENABLED,
    },
    cooldownUntil: S.cooldownUntilMs ? new Date(S.cooldownUntilMs).toISOString() : null,
    bullContext: S.ray.bullContext,
    bullRegimeId: S.ray.bullRegimeId,
    reentryCountInRegime: S.ray.reentryCountInRegime,
    cycleState: S.cycleState,
    lastExitClass: S.lastExitClass,
    lastExitReason: S.lastExitReason,
    firstEntry: S.firstEntry,
    firstEntryFeatureSync: S.firstEntryFeatureSync,
    reentry: S.reentry,
    postExitContinuation: S.postExitContinuation,
    atrStructureStopConfig: {
      enabled: CONFIG.ATR_STRUCTURE_STOP_ENABLED,
      multFirstEntry: CONFIG.ATR_STOP_MULT_FIRST_ENTRY,
      multReentry: CONFIG.ATR_STOP_MULT_REENTRY,
      multStrongReentry: CONFIG.ATR_STOP_MULT_STRONG_REENTRY,
      minPct: CONFIG.ATR_STOP_MIN_PCT,
      maxPct: CONFIG.ATR_STOP_MAX_PCT,
      lookbackBars: CONFIG.ATR_STRUCTURE_LOOKBACK_BARS,
      bufferPct: CONFIG.ATR_STRUCTURE_BUFFER_PCT,
      tightenOnly: CONFIG.ATR_STOP_ALLOW_TIGHTEN_ONLY,
      deriveIfMissing: CONFIG.ATR_STOP_DERIVE_IF_MISSING,
      applyFirstEntry: CONFIG.ATR_STOP_APPLY_FIRST_ENTRY,
      applyReentry: CONFIG.ATR_STOP_APPLY_REENTRY,
      applyOtherModes: CONFIG.ATR_STOP_APPLY_OTHER_MODES,
      minBarsAfterEntry: CONFIG.ATR_STOP_MIN_BARS_AFTER_ENTRY,
      minLossTriggerPct: CONFIG.ATR_STOP_MIN_LOSS_TRIGGER_PCT,
    },
    postExitProfitGuardConfig: {
      enabled: CONFIG.POST_EXIT_CONT_PROFIT_GUARD_ENABLED,
      armPeakPct: CONFIG.POST_EXIT_CONT_PROFIT_GUARD_ARM_PEAK_PCT,
      lockPct: CONFIG.POST_EXIT_CONT_PROFIT_GUARD_LOCK_PCT,
      givebackPct: CONFIG.POST_EXIT_CONT_PROFIT_GUARD_GIVEBACK_PCT,
      minCurrentPct: CONFIG.POST_EXIT_CONT_PROFIT_GUARD_MIN_CURRENT_PCT,
    },
    firstEntryNoProgressConfig: {
      enabled: CONFIG.FIRST_ENTRY_NO_PROGRESS_ENABLED,
      minBars: CONFIG.FIRST_ENTRY_NO_PROGRESS_MIN_BARS,
      maxBars: CONFIG.FIRST_ENTRY_NO_PROGRESS_MAX_BARS,
      minPeakPct: CONFIG.FIRST_ENTRY_NO_PROGRESS_MIN_PEAK_PCT,
      maxCurrentPct: CONFIG.FIRST_ENTRY_NO_PROGRESS_MAX_CURRENT_PCT,
      rsiBelow: CONFIG.FIRST_ENTRY_NO_PROGRESS_RSI_BELOW,
    },
    firstEntryThesisFailConfig: {
      enabled: CONFIG.FIRST_ENTRY_THESIS_FAIL_ENABLED,
      minBars: CONFIG.FIRST_ENTRY_THESIS_FAIL_MIN_BARS,
      maxBars: CONFIG.FIRST_ENTRY_THESIS_FAIL_MAX_BARS,
      minLossPct: CONFIG.FIRST_ENTRY_THESIS_FAIL_MIN_LOSS_PCT,
      maxPeakPct: CONFIG.FIRST_ENTRY_THESIS_FAIL_MAX_PEAK_PCT,
      rsiBelow: CONFIG.FIRST_ENTRY_THESIS_FAIL_RSI_BELOW,
    },
    trendChangeLaunch: S.trendChangeLaunch,
    fastTickLaunch: S.fastTickLaunch,
    rayConflict: S.rayConflict,
    lastTickPrice: S.lastTickPrice,
    lastTickTime: S.lastTickTime,
    tickFresh: isTickFresh(),
    lastFeatureTime: S.lastFeatureTime,
    featureFresh: isFeatureFresh(),
    breakoutMemory: S.breakoutMemory,
    ray: S.ray,
    fvvo: S.fvvo,
    fvvoScore: getFvvoScore(),
    barIndex: S.barIndex,
    replayAllowStaleData: CONFIG.REPLAY_ALLOW_STALE_DATA,
    replayUseEventTimeForPositionClock: CONFIG.REPLAY_USE_EVENT_TIME_FOR_POSITION_CLOCK,
    forwardExitWhenFlat: CONFIG.FORWARD_EXIT_WHEN_FLAT,
    recentLogs: S.logs.slice(-100),
  };
}

export function resetBrain(reason = "manual_reset") {
  resetRuntimeState(reason);
  return { ok: true, reset: true, reason, brain: CONFIG.BRAIN_NAME, symbol: CONFIG.SYMBOL, tf: CONFIG.ENTRY_TF };
}

export function handleWebhook(body = {}) {
  try {
    const expectedSecret = CONFIG.WEBHOOK_SECRET || CONFIG.TICKROUTER_SECRET;
    if (expectedSecret && s(body.secret || body.tv_secret || body.webhook_secret) !== expectedSecret) {
      log("🚫 UNAUTHORIZED", { src: body.src, symbol: body.symbol, hasSecret: Boolean(body.secret || body.tv_secret || body.webhook_secret) });
      return { status: 401, json: { ok: false, error: "unauthorized" } };
    }

    const symbol = normalizeSymbol(body.symbol || CONFIG.SYMBOL);
    if (symbol !== CONFIG.SYMBOL) {
      return { status: 200, json: { ok: true, ignored: true, reason: "symbol_mismatch", symbol, expected: CONFIG.SYMBOL } };
    }

    const parsed = parseInboundType(body);
    if (parsed.family === "tick") return { status: 200, json: handleTick(body) };

    if (parsed.family === "feature") {
      handleFeature(body);
      return { status: 200, json: { ok: true, kind: "feature", barIndex: S.barIndex, inPosition: S.inPosition, cycleState: S.cycleState } };
    }

    if (parsed.family === "ray") {
      handleRayEvent(body);
      return { status: 200, json: { ok: true, kind: "ray", event: parsed.name, bullContext: S.ray.bullContext, inPosition: S.inPosition } };
    }

    if (parsed.family === "fvvo") {
      handleFvvoEvent(body);
      return { status: 200, json: { ok: true, kind: "fvvo", event: parsed.name, fvvoScore: getFvvoScore() } };
    }

    log("❓ UNKNOWN_EVENT", body);
    return { status: 200, json: { ok: true, kind: "unknown_ignored" } };
  } catch (err) {
    log("💥 WEBHOOK_ERROR", { err: String(err?.stack || err) });
    return { status: 500, json: { ok: false, error: String(err?.message || err) } };
  }
}
