import { CONFIG } from "./config.js";

export function shouldEnterBreakout(state) {
  const breakout = state.setups.breakout;
  const validation = state.validation.breakout;
  const position = state.position;
  const execution = state.execution;
  const bar = state.meta.barIndex;

  const reasons = [];

  if (!CONFIG.DRY_RUN_EXECUTION_ENABLED) {
    reasons.push("dry run execution disabled");
    return { allowed: false, reasons };
  }

  if (position.inPosition) {
    reasons.push("already in position");
  }

  if (execution.cooldownUntilBar !== null && bar < execution.cooldownUntilBar) {
    reasons.push(`cooldown active until bar ${execution.cooldownUntilBar}`);
  }

  if (!validation.allowed) {
    reasons.push("validation not allowed");
  }

  if (
    breakout.phase !== "ready" &&
    !(CONFIG.ALLOW_ENTRY_ON_BOUNCE_CONFIRMED && breakout.phase === "bounce_confirmed")
  ) {
    reasons.push(`phase not entry-capable (${breakout.phase})`);
  }

  if ((breakout.score ?? 0) < CONFIG.BREAKOUT_MIN_SCORE) {
    reasons.push(`score ${breakout.score ?? 0} < min ${CONFIG.BREAKOUT_MIN_SCORE}`);
  }

  if (
    CONFIG.ALLOW_ONLY_ONE_ENTRY_PER_SETUP &&
    execution.lastEnteredSetupId &&
    execution.lastEnteredSetupId === `${breakout.startedBar}-${breakout.lastTransition}-${breakout.triggerPrice}`
  ) {
    reasons.push("already entered this setup");
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}
