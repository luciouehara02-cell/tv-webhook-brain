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

function updateStopHigherOnly(current, candidate) {
  if (!num(candidate)) return current;
  if (!num(current)) return candidate;
  return candidate > current ? candidate : current;
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
    entryBarIndex: state.meta.barIndex ?? null,
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

  if (!num(close)) {
    return {
      positionPatch: null,
      exitSignal: null,
      logs: ["⚠️ NO CLOSE PRICE | skipping position management"],
    };
  }

  const logs = [];
  const patch = {};

  logs.push(
    `📊 POS MGMT | close=${close.toFixed(4)} peak=${
      num(p.peakPrice) ? p.peakPrice.toFixed(4) : "na"
    } stop=${num(p.stopPrice) ? p.stopPrice.toFixed(4) : "na"}`
  );

  if (num(close) && (!num(p.peakPrice) || close > p.peakPrice)) {
    patch.peakPrice = close;
    logs.push(`📈 PEAK UPDATE | peak=${close.toFixed(4)}`);
  }

  if (!p.breakEvenArmed && shouldMoveToBreakEven(state)) {
    const newStop = updateStopHigherOnly(p.stopPrice, p.entryPrice);

    patch.breakEvenArmed = true;
    patch.stopPrice = newStop;
    logs.push(`🟨 BREAKEVEN ARMED | stop=${newStop.toFixed(4)}`);
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

    const newStop = updateStopHigherOnly(currentStop, trailStop);

    if (num(newStop) && newStop !== currentStop) {
      patch.stopPrice = newStop;
      patch.trailingActive = true;
      logs.push(`🟦 TRAIL UPDATE | stop=${newStop.toFixed(4)}`);
    }
  }

  const profitLockStop = calcProfitLockStop({
    ...state,
    position: {
      ...p,
      ...patch,
      peakPrice: patch.peakPrice ?? p.peakPrice,
    },
  });

  if (num(profitLockStop)) {
    const currentStop = num(patch.stopPrice)
      ? patch.stopPrice
      : num(p.stopPrice)
      ? p.stopPrice
      : null;

    const newStop = updateStopHigherOnly(currentStop, profitLockStop);

    if (num(newStop) && newStop !== currentStop) {
      patch.stopPrice = newStop;
      patch.profitLockActive = true;
      logs.push(`🟪 PROFIT LOCK | stop=${newStop.toFixed(4)}`);
    }
  }

  const maxBars = Number(CONFIG.MAX_POSITION_BARS || 100);
  const entryBarIndex = Number.isFinite(Number(p.entryBarIndex))
    ? Number(p.entryBarIndex)
    : null;

  if (
    Number.isFinite(maxBars) &&
    maxBars > 0 &&
    entryBarIndex != null &&
    (state.meta.barIndex ?? 0) - entryBarIndex > maxBars
  ) {
    logs.push("🧯 MAX HOLD EXIT TRIGGERED");

    return {
      positionPatch: Object.keys(patch).length ? patch : null,
      exitSignal: {
        reason: "max_hold_time",
        exitPrice: close,
      },
      logs,
    };
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
      entryBarIndex: null,
    },
    executionPatch: {
      lastAction:
        CONFIG.EXECUTION_MODE === "dry_run" ? "exit_long_dry_run" : "exit_long",
      lastActionAt: state.market.time,
      cooldownUntilBar: bar + CONFIG.ENTRY_COOLDOWN_BARS,
    },
    logLine: `🛑 EXIT | reason=${exitReason} | exit=${
      exitSignal?.exitPrice ?? "na"
    }`,
  };
}
