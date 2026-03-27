export async function processEvent(payload) {
  const src = payload?.src;

  // =========================
  // 🔵 TICK FLOW (ENTRY + EXIT)
  // =========================
  if (src === "tick") {
    updateTick(payload);

    const state = getState();

    // 🔥 ENTRY FROM TICK
    const execResult = routeExecution(state);

    if (execResult.action !== "noop") {
      const execModeResult = await executeEnterLong(state);
      if (execModeResult.logLine) console.log(execModeResult.logLine);

      const applyResult = applyExecutionResult(state, execResult);

      if (applyResult.positionPatch) updatePosition(applyResult.positionPatch);
      if (applyResult.executionPatch) updateExecution(applyResult.executionPatch);
      if (applyResult.logLine) console.log(applyResult.logLine);

      const postEntryState = getState();

      const tradePatch = onEntryPositionPatch(postEntryState);
      if (tradePatch) updatePosition(tradePatch);

      updateExecution({
        lastLiveSendOk: execModeResult.ok,
        lastLiveSendAt: state.market.time,
        lastLiveResponse: execModeResult.result || execModeResult.logLine,
        lastLiveEventKey: execModeResult.eventKey ?? null,
      });

      // ✅ mark consumed ONLY if actually entered
      if (getState().position.inPosition) {
        updateBreakoutSetup({
          phase: "consumed",
          lastTransition: "consumed_after_entry",
          reasons: ["consumed via tick entry"],
          consumedAtBar: state.meta.barIndex,
        });
      }
    }

    // 🔴 EXIT FROM TICK
    const manageResult = manageOpenPosition(getState());

    if (manageResult.positionPatch) {
      updatePosition(manageResult.positionPatch);
    }

    for (const line of manageResult.logs) {
      console.log(line);
    }

    const latestState = getState();
    const exitDecision = shouldExitPosition(
      latestState,
      manageResult.exitSignal
    );

    if (exitDecision.allowed) {
      const exitReason = manageResult.exitSignal?.reason ?? "exit_long";

      const exitModeResult = await executeExitLong(latestState, exitReason);
      if (exitModeResult.logLine) console.log(exitModeResult.logLine);

      const exitPatches = buildExitPatches(
        latestState,
        manageResult.exitSignal
      );

      if (exitPatches.positionPatch) updatePosition(exitPatches.positionPatch);
      if (exitPatches.executionPatch) updateExecution(exitPatches.executionPatch);

      console.log(exitPatches.logLine);
    }

    // logs
    const finalState = getState();
    logCore("TICK", finalState);
    logBreakout(finalState);
    logPosition(finalState);

    return;
  }

  // =========================
  // 🟢 FEATURES FLOW (SETUP ONLY)
  // =========================
  if (src !== "features") {
    console.log(`⚠️ Unknown src=${src ?? "undefined"}`);
    return;
  }

  console.log(`📦 FEATURE PAYLOAD ${JSON.stringify(payload)}`);

  const featureEventKey = [
    payload.symbol ?? "na",
    payload.tf ?? "na",
    payload.time ?? "na",
    payload.close ?? "na",
  ].join("|");

  const preState = getState();

  if (preState.execution?.lastFeatureEventKey === featureEventKey) {
    console.log(`⏭️ DUPLICATE FEATURE IGNORED | ${featureEventKey}`);
    return;
  }

  updateFeatures(payload);

  updateExecution({
    lastFeatureEventKey: featureEventKey,
  });

  // regime
  const context = calculateRegime(getState());
  updateContext(context);

  const before = getState().setups.breakout.phase;

  // setup engine
  const breakoutResult = runBreakoutSetup(getState());

  if (breakoutResult.patch) {
    updateBreakoutSetup(breakoutResult.patch);
  }

  // validation only
  const entryDecision = buildEntryDecision(getState());

  updateBreakoutValidation({
    allowed: entryDecision.allowed,
    mode: entryDecision.mode ?? null,
    score: entryDecision.score ?? null,
    chasePct: entryDecision.chasePct ?? null,
    reasons: entryDecision.reasons ?? [],
  });

  const state = getState();
  const after = state.setups.breakout.phase;

  logCore("FEATURES", state);
  console.log(`🔎 SETUP NOTE | ${breakoutResult.note}`);
  logTransition(before, after, breakoutResult.note);
  logBreakout(state);
  logPosition(state);
}

export function getBrainState() {
  return getState();
}
