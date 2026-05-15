/**
 * BrainRAY_Continuation_v6.0_modular
 * Source behavior: BrainRAY_Continuation_v5.1
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
    peakPrice: S.peakPrice,
    peakPnlPct: S.peakPnlPct,
    dynamicTpTier: S.dynamicTpTier,
    cooldownUntil: S.cooldownUntilMs ? new Date(S.cooldownUntilMs).toISOString() : null,
    bullContext: S.ray.bullContext,
    bullRegimeId: S.ray.bullRegimeId,
    reentryCountInRegime: S.ray.reentryCountInRegime,
    cycleState: S.cycleState,
    lastExitClass: S.lastExitClass,
    lastExitReason: S.lastExitReason,
    firstEntry: S.firstEntry,
    reentry: S.reentry,
    postExitContinuation: S.postExitContinuation,
    postExitProfitGuardConfig: {
      enabled: CONFIG.POST_EXIT_CONT_PROFIT_GUARD_ENABLED,
      armPeakPct: CONFIG.POST_EXIT_CONT_PROFIT_GUARD_ARM_PEAK_PCT,
      lockPct: CONFIG.POST_EXIT_CONT_PROFIT_GUARD_LOCK_PCT,
      givebackPct: CONFIG.POST_EXIT_CONT_PROFIT_GUARD_GIVEBACK_PCT,
      minCurrentPct: CONFIG.POST_EXIT_CONT_PROFIT_GUARD_MIN_CURRENT_PCT,
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
