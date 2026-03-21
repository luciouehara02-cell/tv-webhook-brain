import { CONFIG } from "./config.js";

export function build3CommasEnterLongSignal(state) {
  const breakout = state.setups.breakout;
  const market = state.market;
  const features = state.features;

  const entryPrice =
    features.close ?? market.price ?? breakout.bouncePrice ?? breakout.triggerPrice;

  return {
    secret: CONFIG.C3_SIGNAL_SECRET,
    bot_uuid: CONFIG.C3_BOT_UUID,
    max_lag: String(CONFIG.C3_MAX_LAG_SEC),
    timestamp: market.time || new Date().toISOString(),
    trigger_price: String(entryPrice),
    tv_exchange: "BINANCE",
    tv_instrument: "SOLUSDT",
    action: "enter_long",
    order: {
      amount: "199",
      currency_type: "quote",
    },
    meta: {
      brain: CONFIG.BRAIN_VERSION,
      setup_type: "breakout",
      phase: breakout.phase,
      score: breakout.score,
      trigger_price: breakout.triggerPrice,
      retest_price: breakout.retestPrice,
      bounce_price: breakout.bouncePrice,
      tf: market.tf,
      symbol: market.symbol,
    },
  };
}

export function build3CommasExitLongSignal(state) {
  const market = state.market;
  const features = state.features;

  const exitPrice = features.close ?? market.price;

  return {
    secret: CONFIG.C3_SIGNAL_SECRET,
    bot_uuid: CONFIG.C3_BOT_UUID,
    max_lag: String(CONFIG.C3_MAX_LAG_SEC),
    timestamp: market.time || new Date().toISOString(),
    trigger_price: String(exitPrice),
    tv_exchange: "BINANCE",
    tv_instrument: "SOLUSDT",
    action: "exit_long",
    meta: {
      brain: CONFIG.BRAIN_VERSION,
      reason: "close_below_ema18",
      tf: market.tf,
      symbol: market.symbol,
    },
  };
}
