import { CONFIG } from "./config.js";

function num(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getProspectiveEntryPrice(state) {
  const p = state.position;
  const f = state.features;
  const breakout = state.setups.breakout;

  return (
    f.close ??
    p.entryPrice ??
    breakout.bouncePrice ??
    breakout.triggerPrice ??
    null
  );
}

function getProspectiveStopPrice(state, entryPrice) {
  const f = state.features;

  if (!num(entryPrice)) return null;

  const atr = f.atr ?? null;
  const ema18 = f.ema18 ?? null;

  const atrStop = num(atr)
    ? entryPrice - atr * CONFIG.INIT_STOP_ATR_MULT
    : null;

  const emaStop = num(ema18)
    ? ema18 - (num(atr) ? atr * CONFIG.INIT_STOP_EMA_BUFFER_ATR_MULT : 0)
    : null;

  const candidates = [atrStop, emaStop].filter(num);
  if (!candidates.length) return null;

  return Math.min(...candidates);
}

function calcDynamicQuoteSizeFromProspectiveStop(state) {
  const entryPrice = getProspectiveEntryPrice(state);
  const stopPrice = getProspectiveStopPrice(state, entryPrice);

  if (!num(entryPrice) || !num(stopPrice) || entryPrice <= stopPrice) {
    return null;
  }

  const accountEquity = Number(CONFIG.ACCOUNT_EQUITY);
  const riskPct = Number(CONFIG.RISK_PER_TRADE_PCT);

  if (!num(accountEquity) || !num(riskPct) || accountEquity <= 0 || riskPct <= 0) {
    return null;
  }

  const riskAmountQuote = accountEquity * (riskPct / 100);
  const stopDistancePct = (entryPrice - stopPrice) / entryPrice;

  if (!num(stopDistancePct) || stopDistancePct <= 0) {
    return null;
  }

  let quoteSize = riskAmountQuote / stopDistancePct;

  const minQuote = Number(CONFIG.MIN_POSITION_QUOTE);
  const maxQuote = Number(CONFIG.MAX_POSITION_QUOTE);

  if (num(minQuote) && num(maxQuote) && maxQuote >= minQuote) {
    quoteSize = clamp(quoteSize, minQuote, maxQuote);
  } else if (num(minQuote)) {
    quoteSize = Math.max(quoteSize, minQuote);
  } else if (num(maxQuote)) {
    quoteSize = Math.min(quoteSize, maxQuote);
  }

  return {
    entryPrice,
    stopPrice,
    riskAmountQuote,
    stopDistancePct,
    quoteSize,
  };
}

export function resolveEntryOrder(state) {
  if (CONFIG.C3_RISK_MODE !== "dynamic") {
    return {
      amount: CONFIG.C3_ENTRY_AMOUNT,
      currency_type: CONFIG.C3_ENTRY_CURRENCY_TYPE,
      sizing_mode: "fixed",
      sizing_debug: {
        mode: "fixed",
        configured_amount: CONFIG.C3_ENTRY_AMOUNT,
        configured_currency_type: CONFIG.C3_ENTRY_CURRENCY_TYPE,
      },
    };
  }

  const dynamic = calcDynamicQuoteSizeFromProspectiveStop(state);

  if (!dynamic) {
    return {
      amount: CONFIG.C3_ENTRY_AMOUNT,
      currency_type: CONFIG.C3_ENTRY_CURRENCY_TYPE,
      sizing_mode: "fixed_fallback",
      sizing_debug: {
        mode: "fixed_fallback",
        configured_amount: CONFIG.C3_ENTRY_AMOUNT,
        configured_currency_type: CONFIG.C3_ENTRY_CURRENCY_TYPE,
      },
    };
  }

  return {
    amount: dynamic.quoteSize.toFixed(2),
    currency_type: "quote",
    sizing_mode: "dynamic",
    sizing_debug: {
      mode: "dynamic",
      entry_price: Number(dynamic.entryPrice.toFixed(4)),
      stop_price: Number(dynamic.stopPrice.toFixed(4)),
      risk_amount_quote: Number(dynamic.riskAmountQuote.toFixed(4)),
      stop_distance_pct: Number((dynamic.stopDistancePct * 100).toFixed(4)),
      quote_size: Number(dynamic.quoteSize.toFixed(2)),
      account_equity: Number(CONFIG.ACCOUNT_EQUITY),
      risk_per_trade_pct: Number(CONFIG.RISK_PER_TRADE_PCT),
      min_position_quote: Number(CONFIG.MIN_POSITION_QUOTE),
      max_position_quote: Number(CONFIG.MAX_POSITION_QUOTE),
    },
  };
}
