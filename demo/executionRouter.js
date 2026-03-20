import { shouldEnterBreakout } from "./entryPolicy.js";

function buildSetupId(breakout) {
  return `${breakout.startedBar}-${breakout.lastTransition}-${breakout.triggerPrice}`;
}

export function routeExecution(state) {
  const breakout = state.setups.breakout;
  const market = state.market;
  const features = state.features;

  const decision = shouldEnterBreakout(state);

  if (!decision.allowed) {
    return {
      action: "noop",
      reason: decision.reasons.join(", ") || "entry blocked",
      payload: null,
    };
  }

  const entryPrice = features.close ?? market.price ?? breakout.bouncePrice ?? breakout.triggerPrice;

  return {
    action: "enter_long_dry_run",
    reason: "breakout entry approved",
    payload: {
      setupType: "breakout",
      setupId: buildSetupId(breakout),
      entryPrice,
      triggerPrice: breakout.triggerPrice,
      score: breakout.score,
      phase: breakout.phase,
      time: market.time,
      symbol: market.symbol,
      tf: market.tf,
    },
  };
}
