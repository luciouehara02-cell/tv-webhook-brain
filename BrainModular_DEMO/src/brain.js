/**
 * BrainRAY_Continuation_v6.7e_SHADOW_EARLY_FVVO
 * Source behavior: v6.6c ATR / structure stop + strong-feature confirm upgrade + adaptive TP ladder + reset/reclaim reentry gate
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
import { normalizeSymbol, s, n, pickFirst, parseTsMs, barTimeKey, isoNow } from "./utils.js";
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
  if (src === "ray_probe" || src === "rayprobe") return { family: "ray_probe", name: event };
  if (src === "fvvo") return { family: "fvvo", name: event };
  if (src === "fvvo_probe" || src === "fvvoprobe") return { family: "fvvo_probe", name: event };
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
    postAdaptiveTpReentryConfig: {
      enabled: CONFIG.POST_ADAPTIVE_TP_REENTRY_ENABLED,
      cooldownBars: CONFIG.POST_ADAPTIVE_TP_REENTRY_COOLDOWN_BARS,
      windowBars: CONFIG.POST_ADAPTIVE_TP_REENTRY_WINDOW_BARS,
      minResetFromPeakPct: CONFIG.POST_ADAPTIVE_TP_REENTRY_MIN_RESET_FROM_PEAK_PCT,
      minResetFromExitPct: CONFIG.POST_ADAPTIVE_TP_REENTRY_MIN_RESET_FROM_EXIT_PCT,
      allowEma8TouchReset: CONFIG.POST_ADAPTIVE_TP_REENTRY_ALLOW_EMA8_TOUCH_RESET,
      allowEma18TouchReset: CONFIG.POST_ADAPTIVE_TP_REENTRY_ALLOW_EMA18_TOUCH_RESET,
      reclaimMinRsi: CONFIG.POST_ADAPTIVE_TP_REENTRY_RECLAIM_MIN_RSI,
      reclaimMinAdx: CONFIG.POST_ADAPTIVE_TP_REENTRY_RECLAIM_MIN_ADX,
      maxChaseFromReclaimPct: CONFIG.POST_ADAPTIVE_TP_REENTRY_MAX_CHASE_FROM_RECLAIM_PCT,
    },
    cooldownUntil: S.cooldownUntilMs ? new Date(S.cooldownUntilMs).toISOString() : null,
    bullContext: S.ray.bullContext,
    bullRegimeId: S.ray.bullRegimeId,
    reentryCountInRegime: S.ray.reentryCountInRegime,
    cycleState: S.cycleState,
    lastExitClass: S.lastExitClass,
    lastExitReason: S.lastExitReason,
    pendingExit: S.pendingExit,
    exitForwardRetryConfig: {
      enabled: CONFIG.EXIT_FORWARD_RETRY_ENABLED,
      delaysMs: CONFIG.EXIT_FORWARD_RETRY_DELAYS_MS,
      blockEntries: CONFIG.EXIT_FORWARD_RETRY_BLOCK_ENTRIES,
    },
    firstEntry: S.firstEntry,
    firstEntryFeatureSync: S.firstEntryFeatureSync,
    firstEntryLateExtWatch: S.firstEntryLateExtWatch,
    firstEntryContextQualityConfig: {
      enabled: CONFIG.FIRST_ENTRY_CONTEXT_QUALITY_BLOCK_ENABLED,
      compressedRsiBelow: CONFIG.FIRST_ENTRY_COMPRESSED_RSI_BELOW,
      compressedAdxBelow: CONFIG.FIRST_ENTRY_COMPRESSED_ADX_BELOW,
      compressedEmaSpreadBelowPct: CONFIG.FIRST_ENTRY_COMPRESSED_EMA_SPREAD_BELOW_PCT,
      lateExtLowAdxEnabled: CONFIG.FIRST_ENTRY_LATE_EXT_LOW_ADX_ENABLED,
      lateExtAdxBelow: CONFIG.FIRST_ENTRY_LATE_EXT_ADX_BELOW,
      lateExtExt18AbovePct: CONFIG.FIRST_ENTRY_LATE_EXT_EXT18_ABOVE_PCT,
      lateExtRsiAbove: CONFIG.FIRST_ENTRY_LATE_EXT_RSI_ABOVE,
      lateExtAction: CONFIG.FIRST_ENTRY_LATE_EXT_ACTION,
      lateExtWatchBars: CONFIG.FIRST_ENTRY_LATE_EXT_WATCH_BARS,
      lateExtReentryAdxMin: CONFIG.FIRST_ENTRY_LATE_EXT_REENTRY_ADX_MIN,
      lateExtReentryEmaSpreadMinPct: CONFIG.FIRST_ENTRY_LATE_EXT_REENTRY_EMA_SPREAD_MIN_PCT,
    },
    firstEntryDeepRecoveryOverrideConfig: {
      enabled: CONFIG.FIRST_ENTRY_DEEP_RECOVERY_OVERRIDE_ENABLED,
      lookbackBars: CONFIG.FIRST_ENTRY_DEEP_RECOVERY_LOOKBACK_BARS,
      minDropPct: CONFIG.FIRST_ENTRY_DEEP_RECOVERY_MIN_DROP_PCT,
      maxExt18Pct: CONFIG.FIRST_ENTRY_DEEP_RECOVERY_MAX_EXT18_PCT,
      minRsi: CONFIG.FIRST_ENTRY_DEEP_RECOVERY_MIN_RSI,
      minAdx: CONFIG.FIRST_ENTRY_DEEP_RECOVERY_MIN_ADX,
      maxChasePct: CONFIG.FIRST_ENTRY_DEEP_RECOVERY_MAX_CHASE_PCT,
      requireBullishFvvo: CONFIG.FIRST_ENTRY_DEEP_RECOVERY_REQUIRE_BULLISH_FVVO,
      requireCloseAboveEma8: CONFIG.FIRST_ENTRY_DEEP_RECOVERY_REQUIRE_CLOSE_ABOVE_EMA8,
      requireEma8AboveEma18: CONFIG.FIRST_ENTRY_DEEP_RECOVERY_REQUIRE_EMA8_ABOVE_EMA18,
    },
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
    rayFeatureSync: S.rayFeatureSync,
    lastTickPrice: S.lastTickPrice,
    lastTickTime: S.lastTickTime,
    tickFresh: isTickFresh(),
    lastFeatureTime: S.lastFeatureTime,
    featureFresh: isFeatureFresh(),
    breakoutMemory: S.breakoutMemory,
    ray: S.ray,
    fvvo: S.fvvo,
    fvvoScore: getFvvoScore(),
    fvvoDirectEventConfig: {
      shadowEnabled: CONFIG.FVVO_DIRECT_EVENT_SHADOW_ENABLED,
      ttlSec: CONFIG.FVVO_DIRECT_EVENT_TTL_SEC,
      acceptTf: CONFIG.FVVO_DIRECT_EVENT_ACCEPT_TF,
      opbUpdateRealMemory: CONFIG.FVVO_OPB_UPDATE_REAL_MEMORY,
      earlyShadowEnabled: CONFIG.EARLY_FVVO_ENTRY_SHADOW_ENABLED,
      requireBullContext: CONFIG.EARLY_FVVO_ENTRY_SHADOW_REQUIRE_BULL_CONTEXT,
      minRsi: CONFIG.EARLY_FVVO_ENTRY_SHADOW_MIN_RSI,
      minAdx: CONFIG.EARLY_FVVO_ENTRY_SHADOW_MIN_ADX,
      maxExt18Pct: CONFIG.EARLY_FVVO_ENTRY_SHADOW_MAX_EXT18_PCT,
      maxChasePct: CONFIG.EARLY_FVVO_ENTRY_SHADOW_MAX_CHASE_PCT,
    },
    barIndex: S.barIndex,
    replayAllowStaleData: CONFIG.REPLAY_ALLOW_STALE_DATA,
    replayUseEventTimeForPositionClock: CONFIG.REPLAY_USE_EVENT_TIME_FOR_POSITION_CLOCK,
    forwardExitWhenFlat: CONFIG.FORWARD_EXIT_WHEN_FLAT,
    recentLogs: S.logs.slice(-100),
  };
}


function sanitizeWebhookForLog(body = {}) {
  const clean = {
    src: s(body.src, ""),
    event: s(body.event || body.signal || body.alert || body.action, ""),
    tf: s(body.tf || body.interval, ""),
    symbol: s(body.symbol, ""),
    price: body.price ?? body.close ?? body.trigger_price ?? null,
    bar_time: body.bar_time || body.barTime || body.candle_time || body.candleTime || null,
    alert_time: body.alert_time || body.alertTime || body.time || body.timestamp || null,
    server_time: isoNow(),
  };
  if (CONFIG.WEBHOOK_RX_LOG_BODY) {
    const bodyCopy = { ...body };
    for (const key of ["secret", "tv_secret", "webhook_secret", "TICKROUTER_SECRET", "WEBHOOK_SECRET"]) delete bodyCopy[key];
    clean.body = bodyCopy;
  }
  return clean;
}

function configuredWebhookRxFamilies() {
  return String(CONFIG.WEBHOOK_RX_LOG_FAMILIES || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function webhookRxFamilyAllowed(family) {
  const allowed = configuredWebhookRxFamilies();
  if (!allowed.length || allowed.includes("all")) return true;
  const f = String(family || "unknown").toLowerCase();
  if (allowed.includes(f)) return true;
  if (f === "feature" && allowed.includes("features")) return true;
  if (f === "features" && allowed.includes("feature")) return true;
  return false;
}

function logWebhookRx(body = {}, parsed = null, extra = {}) {
  if (!CONFIG.WEBHOOK_RX_LOG_ENABLED) return;
  if (!webhookRxFamilyAllowed(parsed?.family || "unknown")) return;
  log("📩 WEBHOOK_RX", {
    ...sanitizeWebhookForLog(body),
    family: parsed?.family || null,
    name: parsed?.name || null,
    ...extra,
  });
}

function rayAlertTs(body = {}) {
  return pickFirst(body, ["alert_time", "alertTime", "time", "timestamp"], isoNow());
}

function rayExpectedFeatureTime(body = {}) {
  const directBarTime = pickFirst(body, ["bar_time", "barTime", "candle_time", "candleTime"], null);
  if (directBarTime) return new Date(directBarTime).toISOString();
  const ts = rayAlertTs(body);
  const t = parseTsMs(ts);
  if (!Number.isFinite(t)) return null;
  const graceMs = Math.max(0, n(CONFIG.RAY_FEATURE_SYNC_CLOSE_ALERT_GRACE_SEC, 20)) * 1000;
  return barTimeKey(new Date(t - graceMs).toISOString(), n(CONFIG.ENTRY_TF, 5));
}

function latestFeatureIsAtOrAfter(expectedFeatureTime) {
  if (!expectedFeatureTime || !S.lastFeatureTime) return false;
  const expectedMs = parseTsMs(expectedFeatureTime);
  const latestMs = parseTsMs(S.lastFeatureTime);
  return Number.isFinite(expectedMs) && Number.isFinite(latestMs) && latestMs >= expectedMs;
}

function configuredRayFeatureSyncEvents() {
  return String(CONFIG.RAY_FEATURE_SYNC_EVENTS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function shouldHoldRayForFeatureSync(body = {}, parsed = null) {
  if (!CONFIG.RAY_FEATURE_SYNC_WAIT_ENABLED) return false;
  if (parsed?.family !== "ray") return false;
  const waitMs = n(CONFIG.RAY_FEATURE_SYNC_WAIT_MS, 0);
  if (!(waitMs > 0)) return false;
  const name = String(parsed?.name || body.event || "").trim().toLowerCase();
  const allowed = configuredRayFeatureSyncEvents();
  if (allowed.length && !allowed.some((token) => name.includes(token))) return false;
  const expectedFeatureTime = rayExpectedFeatureTime(body);
  if (!expectedFeatureTime) return false;
  return !latestFeatureIsAtOrAfter(expectedFeatureTime);
}

const rayFeatureSyncTimers = new Map();

function clearRayFeatureSyncTimer(id) {
  const timer = rayFeatureSyncTimers.get(id);
  if (timer) clearTimeout(timer);
  rayFeatureSyncTimers.delete(id);
}

function removePendingRay(id) {
  const pending = Array.isArray(S.rayFeatureSync?.pending) ? S.rayFeatureSync.pending : [];
  S.rayFeatureSync.pending = pending.filter((item) => item.id !== id);
}

function processHeldRay(item, reason) {
  if (!item || item.processed) return;
  item.processed = true;
  clearRayFeatureSyncTimer(item.id);
  removePendingRay(item.id);
  S.rayFeatureSync.releasedCount = n(S.rayFeatureSync.releasedCount, 0) + 1;
  S.rayFeatureSync.lastRelease = {
    id: item.id,
    reason,
    mode: item.mode,
    event: item.event,
    expectedFeatureTime: item.expectedFeatureTime,
    lastFeatureTime: S.lastFeatureTime,
    releasedAt: isoNow(),
  };
  const label = item.mode === "shadow"
    ? reason === "timeout" ? "🟣 RAY_FEATURE_SYNC_SHADOW_TIMEOUT" : "🟣 RAY_FEATURE_SYNC_SHADOW_RELEASED"
    : reason === "timeout" ? "🟠 RAY_FEATURE_SYNC_TIMEOUT" : "🟢 RAY_FEATURE_SYNC_RELEASED";
  log(label, {
    id: item.id,
    mode: item.mode,
    reason,
    event: item.event,
    rayTime: item.rayTime,
    rayBarTime: item.expectedFeatureTime,
    lastFeatureTime: S.lastFeatureTime,
    waitedMs: Math.max(0, Date.now() - n(item.armedAtMs, Date.now())),
  });
  if (item.mode !== "shadow") handleRayEvent(item.body);
}

function armRayFeatureSyncWait(body = {}, parsed = null, mode = "hold") {
  S.rayFeatureSync = S.rayFeatureSync || { pending: [] };
  const expectedFeatureTime = rayExpectedFeatureTime(body);
  const rayTime = rayAlertTs(body);
  const id = n(S.rayFeatureSync.nextId, 1);
  S.rayFeatureSync.nextId = id + 1;
  const item = {
    id,
    body: { ...body, time: pickFirst(body, ["time", "alert_time", "alertTime", "timestamp"], rayTime) },
    event: parsed?.name || body.event || "ray",
    rayTime,
    expectedFeatureTime,
    armedAt: isoNow(),
    armedAtMs: Date.now(),
    waitMs: n(CONFIG.RAY_FEATURE_SYNC_WAIT_MS, 1500),
    mode,
    processed: false,
  };
  S.rayFeatureSync.pending = Array.isArray(S.rayFeatureSync.pending) ? S.rayFeatureSync.pending : [];
  S.rayFeatureSync.pending.push(item);
  S.rayFeatureSync.armedCount = n(S.rayFeatureSync.armedCount, 0) + 1;
  S.rayFeatureSync.lastArm = {
    id,
    mode,
    event: item.event,
    rayTime: item.rayTime,
    expectedFeatureTime: item.expectedFeatureTime,
    lastFeatureTime: S.lastFeatureTime,
    waitMs: item.waitMs,
    armedAt: item.armedAt,
  };
  log(mode === "shadow" ? "🟣 RAY_FEATURE_SYNC_SHADOW_ARMED" : "🟡 RAY_FEATURE_SYNC_WAIT_ARMED", {
    id,
    mode,
    event: item.event,
    rayTime: item.rayTime,
    rayBarTime: item.expectedFeatureTime,
    lastFeatureTime: S.lastFeatureTime,
    waitMs: item.waitMs,
  });
  const timer = setTimeout(() => {
    const stillPending = (S.rayFeatureSync?.pending || []).find((x) => x.id === id);
    if (stillPending && !stillPending.processed) processHeldRay(stillPending, "timeout");
  }, item.waitMs);
  rayFeatureSyncTimers.set(id, timer);
  return item;
}

function releasePendingRayFeatureSync(reason = "matching_feature_arrived") {
  const pending = Array.isArray(S.rayFeatureSync?.pending) ? [...S.rayFeatureSync.pending] : [];
  for (const item of pending) {
    if (!item || item.processed) continue;
    if (latestFeatureIsAtOrAfter(item.expectedFeatureTime)) processHeldRay(item, reason);
  }
}

export function resetBrain(reason = "manual_reset") {
  for (const id of rayFeatureSyncTimers.keys()) clearRayFeatureSyncTimer(id);
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
    const parsed = parseInboundType(body);
    logWebhookRx(body, parsed);

    if (symbol !== CONFIG.SYMBOL) {
      log("↩️ WEBHOOK_IGNORED_SYMBOL_MISMATCH", { symbol, expected: CONFIG.SYMBOL, src: body.src, event: parsed.name });
      return { status: 200, json: { ok: true, ignored: true, reason: "symbol_mismatch", symbol, expected: CONFIG.SYMBOL } };
    }

    if (parsed.family === "tick") return { status: 200, json: handleTick(body) };

    if (parsed.family === "feature") {
      handleFeature(body);
      releasePendingRayFeatureSync("matching_feature_arrived");
      return { status: 200, json: { ok: true, kind: "feature", barIndex: S.barIndex, inPosition: S.inPosition, cycleState: S.cycleState } };
    }

    if (parsed.family === "ray_probe") {
      if (CONFIG.RAY_PROBE_LOG_ENABLED) log("🧪 RAY_PROBE_RX", sanitizeWebhookForLog(body));
      return { status: 200, json: { ok: true, kind: "ray_probe", event: parsed.name } };
    }

    if (parsed.family === "ray") {
      if (shouldHoldRayForFeatureSync(body, parsed)) {
        const mode = CONFIG.RAY_FEATURE_SYNC_MODE === "hold" ? "hold" : "shadow";
        const held = armRayFeatureSyncWait(body, parsed, mode);
        if (mode === "hold") {
          return {
            status: 200,
            json: {
              ok: true,
              kind: "ray",
              event: parsed.name,
              heldForFeatureSync: true,
              mode,
              expectedFeatureTime: held.expectedFeatureTime,
              lastFeatureTime: S.lastFeatureTime,
            },
          };
        }
        handleRayEvent(body);
        return {
          status: 200,
          json: {
            ok: true,
            kind: "ray",
            event: parsed.name,
            featureSyncShadow: true,
            expectedFeatureTime: held.expectedFeatureTime,
            lastFeatureTime: S.lastFeatureTime,
            bullContext: S.ray.bullContext,
            inPosition: S.inPosition,
          },
        };
      }
      handleRayEvent(body);
      return { status: 200, json: { ok: true, kind: "ray", event: parsed.name, bullContext: S.ray.bullContext, inPosition: S.inPosition } };
    }

    if (parsed.family === "fvvo_probe") {
      if (CONFIG.FVVO_PROBE_LOG_ENABLED) log("🧪 FVVO_PROBE_RX", sanitizeWebhookForLog(body));
      handleFvvoEvent(body, { probe: true });
      return { status: 200, json: { ok: true, kind: "fvvo_probe", event: parsed.name, fvvoScore: getFvvoScore() } };
    }

    if (parsed.family === "fvvo") {
      handleFvvoEvent(body, { probe: false });
      return { status: 200, json: { ok: true, kind: "fvvo", event: parsed.name, fvvoScore: getFvvoScore() } };
    }

    log("❓ UNKNOWN_EVENT", sanitizeWebhookForLog(body));
    return { status: 200, json: { ok: true, kind: "unknown_ignored" } };
  } catch (err) {
    log("💥 WEBHOOK_ERROR", { err: String(err?.stack || err) });
    return { status: 500, json: { ok: false, error: String(err?.message || err) } };
  }
}
