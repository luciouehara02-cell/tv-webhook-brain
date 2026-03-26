export function buildExitPatches(state, exitSignal) {
  const bar = state.meta.barIndex;
  const exitReason = exitSignal?.reason ?? "exit_long";

  return {
    positionPatch: {
      inPosition: false,
      side: null,
      entryPrice: null,
      entryTime: null,
      entrySetupType: null,
      entrySetupId: null,
      peakPrice: null,
      stopPrice: null,
      breakEvenArmed: false,
      trailingActive: false,
      profitLockActive: false,
      lastExitReason: exitReason,
    },
    executionPatch: {
      lastAction:
        CONFIG.EXECUTION_MODE === "dry_run" ? "exit_long_dry_run" : "exit_long",
      lastActionAt: state.market.time,
      cooldownUntilBar: bar + CONFIG.ENTRY_COOLDOWN_BARS,
    },
    logLine: `🛑 EXIT | reason=${exitReason} | exit=${exitSignal.exitPrice}`,
  };
}
