import { CONFIG } from "./config.js";

function num(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function calcDynamicQuoteSize(state) {
  const p = state.position;
  const f = state.features;
  const breakout = state.setups.breakout;

  const entryPrice =
    f.close ?? p.entryPrice ?? breakout.bouncePrice ?? breakout.triggerPrice;
  const stopPrice = p.stopPrice;

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

  return quoteSize;
}

export function resolveEntryOrder(state) {
  if (CONFIG.C3_RISK_MODE !== "dynamic") {
    return {
      amount: CONFIG.C3_ENTRY_AMOUNT,
      currency_type: CONFIG.C3_ENTRY_CURRENCY_TYPE,
      sizing_mode: "fixed",
    };
  }

  const dynamicQuote = calcDynamicQuoteSize(state);

  if (!num(dynamicQuote)) {
    return {
      amount: CONFIG.C3_ENTRY_AMOUNT,
      currency_type: CONFIG.C3_ENTRY_CURRENCY_TYPE,
      sizing_mode: "fixed_fallback",
    };
  }

  return {
    amount: dynamicQuote.toFixed(2),
    currency_type: "quote",
    sizing_mode: "dynamic",
  };
}
