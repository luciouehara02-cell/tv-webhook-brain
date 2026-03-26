import { CONFIG } from "./config.js";

function num(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function calcInitialStop(state) {
  const f = state.features;
  const close = f.close;
  const ema18 = f.ema18;
  const atr = f.atr;

  if (!num(close) || !num(ema18) || !num(atr)) return null;

  const atrStop = close - atr * CONFIG.INIT_STOP_ATR_MULT;
  const emaStop = ema18 - atr * CONFIG.INIT_STOP_EMA_BUFFER_ATR_MULT;

  return Math.min(atrStop, emaStop);
}

export function applyExecutionResult(state, execResult) {
  if (!execResult || execResult.action === "noop") {
    return {
      positionPatch: null,
      executionPatch: null,
      logLine: null,
    };
  }

  if (execResult.action === "enter_long") {
    const close = state.features.close;
    const time = state.market.time;
    const breakout = state.setups.breakout;

    const setupId =
      breakout.setupId ||
      `${breakout.startedBar}-${breakout.lastTransition}-${breakout.triggerPrice}`;

    // dry_run: simulate open position
    if (CONFIG.EXECUTION_MODE === "dry_run") {
      const stopPrice = calcInitialStop(state);

      return {
        positionPatch: {
          inPosition: true,
          side: "long",
          entryPrice: close,
          entryTime: time,
          entrySetupType: "breakout",
          entrySetupId: setupId,
          peakPrice: close,
          stopPrice,
          breakEvenArmed: false,
          trailingActive: false,
          profitLockActive: false,
          lastExitReason: null,
        },
        executionPatch: {
          lastAction: "enter_long",
          lastActionAt: time,
          lastEnteredSetupId: setupId,
        },
        logLine: `✅ SIM POSITION OPENED | side=long entry=${
          num(close) ? close.toFixed(4) : "na"
        } stop=${num(stopPrice) ? stopPrice.toFixed(4) : "na"} setupId=${setupId}`,
      };
    }

    // live mode: do NOT assume filled here
    return {
      positionPatch: null,
      executionPatch: {
        lastAction: "enter_long",
        lastActionAt: time,
        lastEnteredSetupId: setupId,
      },
      logLine: `🟡 LIVE ENTRY ACK | waiting external confirmation | setupId=${setupId}`,
    };
  }

  if (execResult.action === "exit_long") {
    const time = state.market.time;

    // dry_run: simulate close
    if (CONFIG.EXECUTION_MODE === "dry_run") {
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
        },
        executionPatch: {
          lastAction: "exit_long",
          lastActionAt: time,
          cooldownUntilBar: state.meta.barIndex + CONFIG.ENTRY_COOLDOWN_BARS,
        },
        logLine: `✅ SIM POSITION CLOSED | cooldownUntilBar=${
          state.meta.barIndex + CONFIG.ENTRY_COOLDOWN_BARS
        }`,
      };
    }

    // live mode: do NOT force local close unless you truly have fill confirmation
    return {
      positionPatch: null,
      executionPatch: {
        lastAction: "exit_long",
        lastActionAt: time,
        cooldownUntilBar: state.meta.barIndex + CONFIG.ENTRY_COOLDOWN_BARS,
      },
      logLine: `🟡 LIVE EXIT ACK | waiting external confirmation | cooldownUntilBar=${
        state.meta.barIndex + CONFIG.ENTRY_COOLDOWN_BARS
      }`,
    };
  }

  return {
    positionPatch: null,
    executionPatch: null,
    logLine: null,
  };
}
