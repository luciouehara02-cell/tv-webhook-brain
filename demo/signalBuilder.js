import { CONFIG } from "./config.js";
import { resolveEntryOrder } from "./riskSizer.js";

function buildTiming(marketTime) {
  // Replay mode:
  // - use wall-clock time so old replay bars are not rejected as stale
  if (CONFIG.REPLAY_SIGNAL_MODE === true) {
    return {
      timestamp: new Date().toISOString(),
      signalBarTime: marketTime || null,
      maxLag: String(CONFIG.REPLAY_MAX_LAG_SEC),
    };
  }

  // Live mode:
  // - use actual send/build time for 3Commas timestamp alignment
  // - preserve original bar time separately in metadata
  return {
    timestamp: new Date().toISOString(),
    signalBarTime: marketTime || null,
    maxLag: String(CONFIG.C3_MAX_LAG_SEC),
  };
}

function detectSetupType(state) {
  const breakout = state?.setups?.breakout || {};
  return breakout.setupType || "breakout";
}

export function build3CommasEnterLongSignal(state) {
  const breakout = state.setups.breakout;
  const market = state.market;
  const features = state.features;

  const entryPrice =
    features.close ??
    market.price ??
    breakout.entryCandidatePrice ??
    breakout.bouncePrice ??
    breakout.triggerPrice;

  const { timestamp, signalBarTime, maxLag } = buildTiming(market.time);
  const order = resolveEntryOrder(state);
  const setupType = detectSetupType(state);

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
      setup_type: setupType,
      phase: breakout.phase,
      score: breakout.score,
      trigger_price: breakout.triggerPrice,
      retest_price: breakout.retestPrice,
      bounce_price: breakout.bouncePrice,
      washout_low: breakout.washoutLow ?? null,
      washout_drop_pct: breakout.washoutDropPct ?? null,
      tf: market.tf,
      symbol: market.symbol,
      exec_mode: CONFIG.EXECUTION_MODE,
      replay_signal_mode: CONFIG.REPLAY_SIGNAL_MODE,
      signal_bar_time: signalBarTime,
      sizing_mode: order.sizing_mode,
      sizing_debug: order.sizing_debug,
    },
  };
}

export function build3CommasExitLongSignal(state, exitReason = "exit_long") {
  const market = state.market;
  const features = state.features;

  const exitPrice = features.close ?? market.price;
  const { timestamp, signalBarTime, maxLag } = buildTiming(market.time);

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
      signal_bar_time: signalBarTime,
    },
  };
}
