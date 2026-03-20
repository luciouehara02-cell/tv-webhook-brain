import { CONFIG } from "./config.js";

export function applyExecutionResult(state, execResult) {
  const bar = state.meta.barIndex;

  if (execResult.action === "enter_long_dry_run" && execResult.payload) {
    return {
      positionPatch: {
        inPosition: true,
        side: "long",
        entryPrice: execResult.payload.entryPrice,
        entryTime: execResult.payload.time,
        entrySetupType: execResult.payload.setupType,
        entrySetupId: execResult.payload.setupId,
      },
      executionPatch: {
        lastAction: "enter_long_dry_run",
        lastActionAt: execResult.payload.time,
        lastEnteredSetupId: execResult.payload.setupId,
      },
      logLine: `🚀 DRY-RUN ENTRY | type=${execResult.payload.setupType} | phase=${execResult.payload.phase} | entry=${execResult.payload.entryPrice} | score=${execResult.payload.score}`,
    };
  }

  return {
    positionPatch: null,
    executionPatch: null,
    logLine: null,
  };
}

export function maybeExitDryRunPosition(state) {
  const position = state.position;
  const features = state.features;
  const bar = state.meta.barIndex;

  if (!position.inPosition) {
    return null;
  }

  const close = features.close;
  const ema18 = features.ema18;

  if (close !== null && ema18 !== null && close < ema18) {
    return {
      positionPatch: {
        inPosition: false,
        side: null,
        entryPrice: null,
        entryTime: null,
        entrySetupType: null,
        entrySetupId: null,
      },
      executionPatch: {
        lastAction: "exit_long_dry_run",
        lastActionAt: state.market.time,
        cooldownUntilBar: bar + CONFIG.ENTRY_COOLDOWN_BARS,
      },
      logLine: `🛑 DRY-RUN EXIT | reason=close_below_ema18 | close=${close} ema18=${ema18}`,
    };
  }

  return null;
}
