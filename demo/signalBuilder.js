import { CONFIG } from "./config.js";
import { resolveEntryOrder } from "./riskSizer.js";

function buildTiming(marketTime) {
  const useReplayTiming = CONFIG.REPLAY_SIGNAL_MODE === true;

  if (useReplayTiming) {
    return {
      timestamp: new Date().toISOString(),
      maxLag: String(CONFIG.REPLAY_MAX_LAG_SEC),
    };
  }

  return {
    timestamp: marketTime || new Date().toISOString(),
    maxLag: String(CONFIG.C3_MAX_LAG_SEC),
  };
}

export function build3CommasEnterLongSignal(state) {
  const breakout = state.setups.breakout;
  const market = state.market;
  const features = state.features;

  const entryPrice =
    features.close ?? market.price ?? breakout.bouncePrice ?? breakout.triggerPrice;

  const { timestamp, maxLag } = buildTiming(market.time);
  const order = resolveEntryOrder(state);

  return {
    secret: CONFIG.C3_SIGNAL_SECRET,
    bot_uuid: CONFIG.C3_BOT_UUID,
    max_lag: maxLag,
    timestamp,
    trigger_price: String(entryPrice),
    tv_exchange: "BINANCE",
    tv_instrument: "SOLUSDT",
    action: "enter_long",
    order: {
      amount: order.amount,
      currency_type: order.currency_type,
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
      exec_mode: CONFIG.EXECUTION_MODE,
      replay_signal_mode: CONFIG.REPLAY_SIGNAL_MODE,
      sizing_mode: order.sizing_mode,
      sizing_debug: order.sizing_debug,
    },
  };
}

export function build3CommasExitLongSignal(state, exitReason = "exit_long") {
  const market = state.market;
  const features = state.features;

  const exitPrice = features.close ?? market.price;
  const { timestamp, maxLag } = buildTiming(market.time);

  return {
    secret: CONFIG.C3_SIGNAL_SECRET,
    bot_uuid: CONFIG.C3_BOT_UUID,
    max_lag: maxLag,
    timestamp,
    trigger_price: String(exitPrice),
    tv_exchange: "BINANCE",
    tv_instrument: "SOLUSDT",
    action: "exit_long",
    meta: {
      brain: CONFIG.BRAIN_VERSION,
      reason: exitReason,
      tf: market.tf,
      symbol: market.symbol,
      exec_mode: CONFIG.EXECUTION_MODE,
      replay_signal_mode: CONFIG.REPLAY_SIGNAL_MODE,
    },
  };
}
