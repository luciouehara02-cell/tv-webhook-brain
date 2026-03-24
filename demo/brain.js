import { CONFIG } from "./config.js";
import {
  getState,
  updateBreakoutSetup,
  updateBreakoutValidation,
  updateContext,
  updateExecution,
  updateFeatures,
  updatePosition,
  updateTick,
} from "./stateStore.js";
import { calculateRegime } from "./regimeEngine.js";
import { validateBreakout } from "./validationEngine.js";
import { runBreakoutSetup } from "./setupEngine.js";
import { routeExecution } from "./executionRouter.js";
import { applyExecutionResult } from "./positionEngine.js";
import { executeEnterLong, executeExitLong } from "./executionModeRouter.js";
import {
  onEntryPositionPatch,
  manageOpenPosition,
  buildExitPatches,
} from "./tradeManager.js";
import { shouldExitPosition } from "./exitPolicy.js";

function formatNum(v, digits = 2) {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "na";
}

function logCore(tag, state) {
  console.log(
    `🧠 ${CONFIG.BRAIN_VERSION} | ${tag} | symbol=${state.market.symbol} tf=${state.market.tf} price=${formatNum(state.market.price, 4)} regime=${state.context.regime} conf=${formatNum(state.context.confidence, 2)} hostile=${state.context.hostile ? 1 : 0}`
  );


    console.log(
  `📊 FEAT | close=${formatNum(state.features.close, 4)} ema8=${formatNum(state.features.ema8, 4)} ema18=${formatNum(state.features.ema18, 4)} ema50=${formatNum(state.features.ema50, 4)} rsi=${formatNum(state.features.rsi, 2)} adx=${formatNum(state.features.adx, 2)} atrPct=${formatNum(state.features.atrPct, 3)} oiTrend=${state.features.oiTrend ?? "na"} cvdTrend=${state.features.cvdTrend ?? "na"}`
    );

  if (state.context.reasons?.length) {
    console.log(`🧭 CONTEXT | reasons=${state.context.reasons.join(", ")}`);
  }
}

function logBreakout(state) {
  const b = state.setups.breakout;
  const v = state.validation.breakout;

  console.log(
    `🟦 BREAKOUT | phase=${b.phase} trigger=${formatNum(b.triggerPrice, 4)} retest=${formatNum(b.retestPrice, 4)} bounce=${formatNum(b.bouncePrice, 4)} score=${b.score} allowed=${v.allowed ? 1 : 0}`
  );

  if (b.reasons?.length) {
    console.log(`🧩 BREAKOUT reasons | ${b.reasons.join(", ")}`);
  }

  if (
    (b.phase === "ready" || b.phase === "bounce_confirmed") &&
    v.reasons?.length
  ) {
    console.log(`🛡️ VALIDATION | ${v.reasons.join(", ")}`);
  }
}

function logPosition(state) {
  console.log(
    `📍 POSITION | inPosition=${state.position.inPosition ? 1 : 0} side=${state.position.side ?? "na"} entry=${formatNum(state.position.entryPrice, 4)} stop=${formatNum(state.position.stopPrice, 4)} peak=${formatNum(state.position.peakPrice, 4)} be=${state.position.breakEvenArmed ? 1 : 0} trail=${state.position.trailingActive ? 1 : 0} pl=${state.position.profitLockActive ? 1 : 0} cooldownUntilBar=${state.execution.cooldownUntilBar ?? "na"}`
  );
}

function logTransition(beforePhase, afterPhase, note) {
  if (beforePhase !== afterPhase) {
    console.log(`🔄 BREAKOUT transition | ${beforePhase} -> ${afterPhase} | ${note}`);
  }
}

export async function processEvent(payload) {
  const src = payload?.src;

  if (src === "tick") {
    updateTick(payload);
    const state = getState();
    logCore("TICK", state);
    logBreakout(state);
    logPosition(state);
    return;
  }

  if (src !== "features") {
    console.log(`⚠️ Unknown src=${src ?? "undefined"}`);
    return;
  }
  
if (CONFIG.LOG_FULL_FEATURE_PAYLOADS) {
  console.log(`📦 FEATURE PAYLOAD ${JSON.stringify(payload)}`);
}
  
  const featureEventKey = [
    payload.symbol ?? "na",
    payload.tf ?? "na",
    payload.time ?? "na",
    payload.close ?? "na",
  ].join("|");

  const preFeatureState = getState();

  if (preFeatureState.execution?.lastFeatureEventKey === featureEventKey) {
    console.log(`⏭️ DUPLICATE FEATURE IGNORED | ${featureEventKey}`);
    return;
  }

  updateFeatures(payload);

  updateExecution({
    lastFeatureEventKey: featureEventKey,
  });

  const state1 = getState();
  const context = calculateRegime(state1);
  updateContext(context);

  const before = getState().setups.breakout.phase;
  const breakoutResult = runBreakoutSetup(getState());

  if (breakoutResult.patch) {
    updateBreakoutSetup(breakoutResult.patch);
  }

  const state2 = getState();

  if (
    state2.setups.breakout.phase === "ready" ||
    state2.setups.breakout.phase === "bounce_confirmed"
  ) {
    const validation = validateBreakout(state2);
    updateBreakoutValidation(validation);
  } else {
    updateBreakoutValidation({
      allowed: false,
      reasons: ["not in entry-capable phase"],
    });
  }

  const state3 = getState();
  const execResult = routeExecution(state3);

  const shouldLogBlockedEntry =
    execResult.action === "noop" &&
    execResult.reason &&
    execResult.reason !== "already in position" &&
    !execResult.reason.includes("not in entry-capable phase");

  if (execResult.action !== "noop") {
    const execModeResult = await executeEnterLong(state3);
    if (execModeResult.logLine) console.log(execModeResult.logLine);

    const applyResult = applyExecutionResult(state3, execResult);

    if (applyResult.positionPatch) updatePosition(applyResult.positionPatch);
    if (applyResult.executionPatch) updateExecution(applyResult.executionPatch);
    if (applyResult.logLine) console.log(applyResult.logLine);

    const postEntryState = getState();
    const tradePatch = onEntryPositionPatch(postEntryState);
    if (tradePatch) updatePosition(tradePatch);

    updateExecution({
      lastLiveSendOk: execModeResult.ok,
      lastLiveSendAt: state3.market.time,
      lastLiveResponse: execModeResult.result || execModeResult.logLine,
      lastLiveEventKey: execModeResult.eventKey ?? null,
      lastLiveGuardrailReason: execModeResult.guardrailReason ?? null,
      lastSignalPayload: execModeResult.signalPayload ?? null,
    });

    const enteredState = getState();

    if (enteredState.position.inPosition) {
      updateBreakoutSetup({
        phase: "consumed",
        lastTransition: "consumed_after_entry",
        reasons: ["setup consumed after entry"],
        consumedAtBar: enteredState.meta.barIndex,
      });
    } else {
      console.log("⚠️ ENTRY NOT ACTIVATED | setup not consumed because inPosition=0");
    }
  } else if (shouldLogBlockedEntry) {
    console.log(`🚫 ENTRY BLOCKED | ${execResult.reason}`);
  }

  const postExecState = getState();
  const manageResult = manageOpenPosition(postExecState);

  if (manageResult.positionPatch) {
    updatePosition(manageResult.positionPatch);
  }

  for (const line of manageResult.logs) {
    console.log(line);
  }

  const latestManagedState = getState();
  const exitDecision = shouldExitPosition(
    latestManagedState,
    manageResult.exitSignal
  );

  let finalSetupNote = breakoutResult.note;

  if (exitDecision.allowed) {
    const exitReason = manageResult.exitSignal?.reason ?? "exit_long";
    const exitModeResult = await executeExitLong(latestManagedState, exitReason);
    if (exitModeResult.logLine) console.log(exitModeResult.logLine);

    const exitPatches = buildExitPatches(
      latestManagedState,
      manageResult.exitSignal
    );

    if (exitPatches.positionPatch) updatePosition(exitPatches.positionPatch);
    if (exitPatches.executionPatch) updateExecution(exitPatches.executionPatch);
    if (exitPatches.logLine) console.log(exitPatches.logLine);

    updateExecution({
      lastLiveSendOk: exitModeResult.ok,
      lastLiveSendAt: latestManagedState.market.time,
      lastLiveResponse: exitModeResult.result || exitModeResult.logLine,
      lastLiveEventKey: exitModeResult.eventKey ?? null,
      lastLiveGuardrailReason: exitModeResult.guardrailReason ?? null,
      lastSignalPayload: exitModeResult.signalPayload ?? null,
    });

    const latestState = getState();

    updateBreakoutSetup({
      phase: "idle",
      startedBar: null,
      phaseBar: latestState.meta.barIndex,
      triggerPrice: null,
      breakoutLevel: null,
      retestPrice: null,
      bouncePrice: null,
      score: 0,
      reasons: ["reset after exit"],
      lastTransition: "reset_after_exit",
      setupId: null,
      retestLow: null,
      invalidationPrice: null,
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
      reclaimPctFromTrigger: null,
      reentryCount: 0,
    });

    finalSetupNote = `reset after exit (${exitReason})`;
  }

  const state4 = getState();
  const after = state4.setups.breakout.phase;

  logCore("FEATURES", state4);
  console.log(`🔎 SETUP NOTE | ${finalSetupNote}`);
  logTransition(before, after, finalSetupNote);
  logBreakout(state4);
  logPosition(state4);

  if (CONFIG.LOG_FULL_STATE_ON_TRANSITIONS && before !== after) {
    console.log(
      `📝 STATE SNAPSHOT ${JSON.stringify({
        market: state4.market,
        context: state4.context,
        breakout: state4.setups.breakout,
        validation: state4.validation.breakout,
        position: state4.position,
        execution: state4.execution,
      })}`
    );
  }
}

export function getBrainState() {
  return getState();
}
