import { CONFIG } from "./config.js";

function num(v) {
  return typeof v === "number" && Number.isFinite(v);
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

  if (!p.inPosition || !num(p.entryPrice) || !num(close)) {
    return false;
  }

  if (p.breakEvenArmed) return false;

  const gainPct = ((close - p.entryPrice) / p.entryPrice) * 100;
  return gainPct >= CONFIG.BREAKEVEN_ARM_PCT;
}

export function calcTrailingStop(state) {
  const p = state.position;
  const f = state.features;

  if (!p.inPosition || !num(p.entryPrice) || !num(f.close)) {
    return null;
  }

  const atr = f.atr ?? null;
  const close = f.close;
  const gainPct = ((close - p.entryPrice) / p.entryPrice) * 100;

  if (gainPct < CONFIG.TRAILING_START_PCT) return null;
  if (!num(atr)) return null;

  return close - atr * CONFIG.TRAILING_ATR_MULT;
}

export function calcProfitLockStop(state) {
  const p = state.position;
  const close = state.features.close;

  if (!p.inPosition || !num(p.entryPrice) || !num(close) || !num(p.peakPrice)) {
    return null;
  }

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
    return { shouldExit: true, reason: "stop_hit", exitPrice: close };
  }

  if (CONFIG.EXIT_ON_CLOSE_BELOW_EMA18 && num(close) && num(ema18) && close < ema18) {
    return { shouldExit: true, reason: "close_below_ema18", exitPrice: close };
  }

  return null;
}
