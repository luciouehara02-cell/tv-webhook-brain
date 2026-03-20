import { CONFIG } from "./config.js";
import {
  buildInitialStop,
  shouldMoveToBreakEven,
  calcTrailingStop,
  calcProfitLockStop,
  checkExitTrigger,
} from "./stopEngine.js";

function num(v) {
  return typeof v === "number" && Number.isFinite(v);
}

export function onEntryPositionPatch(state) {
  const initialStop = buildInitialStop(state);

  return {
    peakPrice: state.features.close ?? state.position.entryPrice,
    stopPrice: initialStop,
    breakEvenArmed: false,
    trailingActive: false,
    profitLockActive: false,
    lastExitReason: null,
  };
}

export function manageOpenPosition(state) {
  const p = state.position;
  const f = state.features;
  const close = f.close;

  if (!p.inPosition) {
    return {
      positionPatch: null,
      exitSignal: null,
      logs: [],
    };
  }

  const logs = [];
  const patch = {};

  if (num(close) && (!num(p.peakPrice) || close > p.peakPrice)) {
    patch.peakPrice = close;
    logs.push(`📈 PEAK UPDATE | peak=${close}`);
  }

  if (shouldMoveToBreakEven(state)) {
    patch.breakEvenArmed = true;
    patch.stopPrice = Math.max(
      num(p.stopPrice) ? p.stopPrice : -Infinity,
      p.entryPrice
    );
    logs.push(`🟨 BREAKEVEN ARMED | stop=${patch.stopPrice}`);
  }

  const trailStop = calcTrailingStop({
    ...state,
    position: { ...p, ...patch },
  });

  if (num(trailStop)) {
    const currentStop = num(patch.stopPrice)
      ? patch.stopPrice
      : num(p.stopPrice)
      ? p.stopPrice
      : null;

    if (!num(currentStop) || trailStop > currentStop) {
      patch.stopPrice = trailStop;
      patch.trailingActive = true;
      logs.push(`🟦 TRAIL UPDATE | stop=${trailStop.toFixed(4)}`);
    }
  }

  const profitLockStop = calcProfitLockStop({
    ...state,
    position: { ...p, ...patch, peakPrice: patch.peakPrice ?? p.peakPrice },
  });

  if (num(profitLockStop)) {
    const currentStop = num(patch.stopPrice)
      ? patch.stopPrice
      : num(p.stopPrice)
      ? p.stopPrice
      : null;

    if (!num(currentStop) || profitLockStop > currentStop) {
      patch.stopPrice = profitLockStop;
      patch.profitLockActive = true;
      logs.push(`🟪 PROFIT LOCK | stop=${profitLockStop.toFixed(4)}`);
    }
  }

  const exitSignal = checkExitTrigger({
    ...state,
    position: { ...p, ...patch },
  });

  return {
    positionPatch: Object.keys(patch).length ? patch : null,
    exitSignal,
    logs,
  };
}

export function buildExitPatches(state, exitSignal) {
  const bar = state.meta.barIndex;

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
      lastExitReason: exitSignal.reason,
    },
    executionPatch: {
      lastAction: "exit_long_dry_run",
      lastActionAt: state.market.time,
      cooldownUntilBar: bar + CONFIG.ENTRY_COOLDOWN_BARS,
    },
    logLine: `🛑 EXIT | reason=${exitSignal.reason} | exit=${exitSignal.exitPrice}`,
  };
}
