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

function assumeLiveFillEnabled() {
  return String(process.env.LIVE_ASSUME_SIGNAL_BOT_FILL ?? "true").toLowerCase() === "true";
}

export function applyExecutionResult(state, execResult, execModeResult = null) {
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

    const stopPrice = calcInitialStop(state);

    // dry_run: simulate open position
    if (CONFIG.EXECUTION_MODE === "dry_run") {
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
          positionSyncState: "open_local",
          pendingLivePosition: null,
          pendingLiveExit: null,
          desyncWarning: null,
        },
        logLine: `✅ SIM POSITION OPENED | side=long entry=${
          num(close) ? close.toFixed(4) : "na"
        } stop=${num(stopPrice) ? stopPrice.toFixed(4) : "na"} setupId=${setupId}`,
      };
    }

    // live mode
    const liveSendOk = !!execModeResult?.ok && !execModeResult?.result?.skipped;

    if (liveSendOk && assumeLiveFillEnabled()) {
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
          positionSyncState: "open_assumed_after_live_send",
          pendingLivePosition: {
            side: "long",
            entryPrice: close,
            entryTime: time,
            entrySetupType: "breakout",
            entrySetupId: setupId,
            peakPrice: close,
            stopPrice,
          },
          pendingLiveExit: null,
          desyncWarning: null,
        },
        logLine: `🟢 LIVE POSITION ASSUMED OPEN | entry=${
          num(close) ? close.toFixed(4) : "na"
        } stop=${num(stopPrice) ? stopPrice.toFixed(4) : "na"} setupId=${setupId}`,
      };
    }

    return {
      positionPatch: null,
      executionPatch: {
        lastAction: "enter_long",
        lastActionAt: time,
        lastEnteredSetupId: setupId,
        positionSyncState: liveSendOk ? "entry_sent_waiting_fill" : "entry_not_sent",
        pendingLivePosition: liveSendOk
          ? {
              side: "long",
              entryPrice: close,
              entryTime: time,
              entrySetupType: "breakout",
              entrySetupId: setupId,
              peakPrice: close,
              stopPrice,
            }
          : null,
        pendingLiveExit: null,
      },
      logLine: liveSendOk
        ? `🟡 LIVE ENTRY ACK | waiting external confirmation | setupId=${setupId}`
        : `🟠 LIVE ENTRY NOT CONFIRMED | local position unchanged | setupId=${setupId}`,
    };
  }

  if (execResult.action === "exit_long") {
    const time = state.market.time;
    const cooldownUntilBar = state.meta.barIndex + CONFIG.ENTRY_COOLDOWN_BARS;

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
          lastExitReason: null,
        },
        executionPatch: {
          lastAction: "exit_long",
          lastActionAt: time,
          cooldownUntilBar,
          positionSyncState: "flat",
          pendingLivePosition: null,
          pendingLiveExit: null,
          desyncWarning: null,
        },
        logLine: `✅ SIM POSITION CLOSED | cooldownUntilBar=${cooldownUntilBar}`,
      };
    }

    // live mode
    const liveSendOk = !!execModeResult?.ok && !execModeResult?.result?.skipped;

    if (liveSendOk && assumeLiveFillEnabled()) {
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
          lastExitReason: null,
        },
        executionPatch: {
          lastAction: "exit_long",
          lastActionAt: time,
          cooldownUntilBar,
          positionSyncState: "flat_assumed_after_live_exit",
          pendingLivePosition: null,
          pendingLiveExit: {
            exitTime: time,
            cooldownUntilBar,
          },
          desyncWarning: null,
        },
        logLine: `🟢 LIVE POSITION ASSUMED CLOSED | cooldownUntilBar=${cooldownUntilBar}`,
      };
    }

    return {
      positionPatch: null,
      executionPatch: {
        lastAction: "exit_long",
        lastActionAt: time,
        cooldownUntilBar,
        positionSyncState: liveSendOk ? "exit_sent_waiting_fill" : "exit_not_sent",
        pendingLiveExit: liveSendOk
          ? {
              exitTime: time,
              cooldownUntilBar,
            }
          : null,
      },
      logLine: liveSendOk
        ? `🟡 LIVE EXIT ACK | waiting external confirmation | cooldownUntilBar=${cooldownUntilBar}`
        : `🟠 LIVE EXIT NOT CONFIRMED | local position unchanged | cooldownUntilBar=${cooldownUntilBar}`,
    };
  }

  return {
    positionPatch: null,
    executionPatch: null,
    logLine: null,
  };
}
