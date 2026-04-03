import { CONFIG } from "./config.js";

function num(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function pctBelow(value, reference) {
  if (!num(value) || !num(reference) || reference === 0) return 0;
  return ((reference - value) / reference) * 100;
}

function getSetupType(state) {
  return (
    state?.position?.entrySetupType ||
    state?.setups?.breakout?.setupType ||
    "breakout"
  );
}

function getEma18ExitProfile(state) {
  const setupType = getSetupType(state);

  if (setupType === "washout") {
    return {
      bufferPct: Number.isFinite(Number(CONFIG.WASHOUT_EMA18_EXIT_BUFFER_PCT))
        ? Number(CONFIG.WASHOUT_EMA18_EXIT_BUFFER_PCT)
        : 0.05,
      minBarsAfterEntry: Number.isFinite(
        Number(CONFIG.WASHOUT_EMA18_EXIT_MIN_BARS_AFTER_ENTRY)
      )
        ? Number(CONFIG.WASHOUT_EMA18_EXIT_MIN_BARS_AFTER_ENTRY)
        : 2,
      requireConsecutiveCloses: Number.isFinite(
        Number(CONFIG.WASHOUT_EMA18_EXIT_REQUIRE_CONSECUTIVE_CLOSES)
      )
        ? Number(CONFIG.WASHOUT_EMA18_EXIT_REQUIRE_CONSECUTIVE_CLOSES)
        : 2,
    };
  }

  return {
    bufferPct: Number.isFinite(Number(CONFIG.BREAKOUT_EMA18_EXIT_BUFFER_PCT))
      ? Number(CONFIG.BREAKOUT_EMA18_EXIT_BUFFER_PCT)
      : 0.03,
    minBarsAfterEntry: Number.isFinite(
      Number(CONFIG.BREAKOUT_EMA18_EXIT_MIN_BARS_AFTER_ENTRY)
    )
      ? Number(CONFIG.BREAKOUT_EMA18_EXIT_MIN_BARS_AFTER_ENTRY)
      : 1,
    requireConsecutiveCloses: Number.isFinite(
      Number(CONFIG.BREAKOUT_EMA18_EXIT_REQUIRE_CONSECUTIVE_CLOSES)
    )
      ? Number(CONFIG.BREAKOUT_EMA18_EXIT_REQUIRE_CONSECUTIVE_CLOSES)
      : 1,
  };
}

export function buildInitialStop(state) {
  const f = state.features;
  const p = state.position;

  if (!num(p.entryPrice)) return null;

  const atr = f.atr ?? null;
  const ema18 = f.ema18 ?? null;

  const atrStop = num(atr)
    ? p.entryPrice - atr * CONFIG.INIT_STOP_ATR_MULT
    : null;

  const emaStop = num(ema18)
    ? ema18 - (num(atr) ? atr * CONFIG.INIT_STOP_EMA_BUFFER_ATR_MULT : 0)
    : null;

  const candidates = [atrStop, emaStop].filter(num);
  if (!candidates.length) return null;

  return Math.min(...candidates);
}

export function shouldMoveToBreakEven(state) {
  const p = state.position;
  const close = state.features.close;

  if (!p.inPosition || !num(p.entryPrice) || !num(close)) return false;
  if (p.breakEvenArmed) return false;

  const gainPct = ((close - p.entryPrice) / p.entryPrice) * 100;
  return gainPct >= CONFIG.BREAKEVEN_ARM_PCT;
}

export function calcTrailingStop(state) {
  const p = state.position;
  const f = state.features;

  if (!p.inPosition || !num(p.entryPrice) || !num(f.close)) return null;

  const atr = f.atr ?? null;
  const close = f.close;
  const gainPct = ((close - p.entryPrice) / p.entryPrice) * 100;

  if (gainPct < CONFIG.TRAILING_START_PCT) return null;
  if (!num(atr)) return null;

  return close - atr * CONFIG.TRAILING_ATR_MULT;
}

export function calcProfitLockStop(state) {
  const p = state.position;

  if (!p.inPosition || !num(p.entryPrice) || !num(p.peakPrice)) return null;

  const gainPct = ((p.peakPrice - p.entryPrice) / p.entryPrice) * 100;

  if (gainPct < CONFIG.PROFIT_LOCK_ARM_PCT) return null;

  return p.peakPrice * (1 - CONFIG.PROFIT_LOCK_GIVEBACK_PCT / 100);
}

export function checkExitTrigger(state) {
  const p = state.position;
  const f = state.features;

  if (!p.inPosition) return null;

  const close = f.close;
  const ema18 = f.ema18;
  const stopPrice = p.stopPrice;

  if (num(stopPrice) && num(close) && close <= stopPrice) {
    return {
      shouldExit: true,
      reason: "stop_hit",
      exitPrice: close,
    };
  }

  const entryBarIndex = Number.isFinite(Number(p.entryBarIndex))
    ? Number(p.entryBarIndex)
    : null;
  const currentBarIndex = Number.isFinite(Number(state.meta?.barIndex))
    ? Number(state.meta.barIndex)
    : null;

  const barsSinceEntry =
    entryBarIndex != null && currentBarIndex != null
      ? currentBarIndex - entryBarIndex
      : null;

  const profile = getEma18ExitProfile(state);

  const prevClose = state.history?.bars?.length
    ? state.history.bars[state.history.bars.length - 1]?.close
    : null;

  const closeBelowNow =
    num(close) &&
    num(ema18) &&
    close < ema18 &&
    pctBelow(close, ema18) >= profile.bufferPct;

  const closeBelowPrev =
    num(prevClose) &&
    num(ema18) &&
    prevClose < ema18 &&
    pctBelow(prevClose, ema18) >= profile.bufferPct;

  const consecutiveBelowOk =
    profile.requireConsecutiveCloses <= 1
      ? closeBelowNow
      : closeBelowNow && closeBelowPrev;

  const minBarsOk =
    barsSinceEntry == null ? true : barsSinceEntry >= profile.minBarsAfterEntry;

  if (
    CONFIG.EXIT_ON_CLOSE_BELOW_EMA18 &&
    closeBelowNow &&
    consecutiveBelowOk &&
    minBarsOk
  ) {
    return {
      shouldExit: true,
      reason: "close_below_ema18",
      exitPrice: close,
    };
  }

  return null;
}
