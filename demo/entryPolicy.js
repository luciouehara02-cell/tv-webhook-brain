import { CONFIG } from "./config.js";

export function shouldEnterBreakout(state) {
  const breakout = state.setups.breakout;
  const validation = state.validation.breakout;
  const position = state.position;
  const execution = state.execution;
  const bar = state.meta.barIndex;
  const close = state.features.close;

  if (!CONFIG.DRY_RUN_EXECUTION_ENABLED && CONFIG.EXECUTION_MODE === "dry_run") {
    return { allowed: false, reasons: ["dry run execution disabled"] };
  }

  if (position.inPosition) {
    return { allowed: false, reasons: ["already in position"] };
  }

  if (execution.cooldownUntilBar !== null && bar < execution.cooldownUntilBar) {
    return {
      allowed: false,
      reasons: [`cooldown active until bar ${execution.cooldownUntilBar}`],
    };
  }

  if (!validation.allowed) {
    return { allowed: false, reasons: ["validation not allowed"] };
  }

  if (
    breakout.phase !== "ready" &&
    !(CONFIG.ALLOW_ENTRY_ON_BOUNCE_CONFIRMED && breakout.phase === "bounce_confirmed")
  ) {
    return {
      allowed: false,
      reasons: [`phase not entry-capable (${breakout.phase})`],
    };
  }

  if ((breakout.score ?? 0) < CONFIG.BREAKOUT_MIN_SCORE) {
    return {
      allowed: false,
      reasons: [`score ${breakout.score ?? 0} < min ${CONFIG.BREAKOUT_MIN_SCORE}`],
    };
  }

  if (
    breakout.readySinceBar !== null &&
    (bar - breakout.readySinceBar) > CONFIG.BREAKOUT_MAX_READY_AGE_BARS_FOR_ENTRY
  ) {
    return {
      allowed: false,
      reasons: [`ready too old (${bar - breakout.readySinceBar} bars)`],
    };
  }

  if (
    breakout.bouncePrice !== null &&
    typeof close === "number" &&
    Number.isFinite(close)
  ) {
    const chasePct = ((close - breakout.bouncePrice) / breakout.bouncePrice) * 100;

    if (chasePct > CONFIG.BREAKOUT_MAX_CHASE_FROM_BOUNCE_PCT) {
      return {
        allowed: false,
        reasons: [`late entry chase too large (${chasePct.toFixed(3)}%)`],
      };
    }
  }

  const setupId =
    breakout.setupId ||
    `${breakout.startedBar}-${breakout.lastTransition}-${breakout.triggerPrice}`;

  if (
    CONFIG.ALLOW_ONLY_ONE_ENTRY_PER_SETUP &&
    execution.lastEnteredSetupId &&
    execution.lastEnteredSetupId === setupId
  ) {
    return { allowed: false, reasons: ["already entered this setup"] };
  }

  return {
    allowed: true,
    reasons: [],
  };
}
