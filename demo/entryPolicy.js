import { CONFIG } from "./config.js";

function num(v) {
  return typeof v === "number" && Number.isFinite(v);
}

export function shouldEnterBreakout(state) {
  const breakout = state.setups.breakout;
  const validation = state.validation.breakout;
  const position = state.position;
  const execution = state.execution;
  const bar = state.meta.barIndex;
  const close = state.features.close;

  const isBounceEntry =
    CONFIG.ALLOW_ENTRY_ON_BOUNCE_CONFIRMED &&
    breakout.phase === "bounce_confirmed";

  const isReadyEntry = breakout.phase === "ready";

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

  if (!isReadyEntry && !isBounceEntry) {
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

  if (num(breakout.bouncePrice) && num(close)) {
    const chasePct = ((close - breakout.bouncePrice) / breakout.bouncePrice) * 100;

    const maxChasePct = isBounceEntry
      ? CONFIG.BREAKOUT_MAX_CHASE_FROM_BOUNCE_PCT_BOUNCE_ENTRY
      : CONFIG.BREAKOUT_MAX_CHASE_FROM_BOUNCE_PCT_READY_ENTRY;

    if (chasePct > maxChasePct) {
      return {
        allowed: false,
        reasons: [`late entry chase too large (${chasePct.toFixed(3)}%)`],
      };
    }
  }

  if (
    isBounceEntry &&
    CONFIG.BREAKOUT_REQUIRE_STRONGER_RULES_ON_BOUNCE_ENTRY
  ) {
    if (
      num(breakout.bounceBodyPct) &&
      breakout.bounceBodyPct < CONFIG.BREAKOUT_MIN_BOUNCE_BODY_PCT
    ) {
      return {
        allowed: false,
        reasons: [
          `bounce body too weak (${breakout.bounceBodyPct.toFixed(3)}% < ${CONFIG.BREAKOUT_MIN_BOUNCE_BODY_PCT})`,
        ],
      };
    }

    if (
      num(breakout.bounceCloseInRangePct) &&
      breakout.bounceCloseInRangePct < CONFIG.BREAKOUT_MIN_CLOSE_IN_RANGE_PCT
    ) {
      return {
        allowed: false,
        reasons: [
          `bounce close too weak in range (${breakout.bounceCloseInRangePct.toFixed(1)} < ${CONFIG.BREAKOUT_MIN_CLOSE_IN_RANGE_PCT})`,
        ],
      };
    }

    if (
      num(breakout.reclaimPctFromTrigger) &&
      breakout.reclaimPctFromTrigger < CONFIG.BREAKOUT_MIN_RECLAIM_ABOVE_TRIGGER_PCT
    ) {
      return {
        allowed: false,
        reasons: [
          `reclaim above trigger too weak (${breakout.reclaimPctFromTrigger.toFixed(3)}% < ${CONFIG.BREAKOUT_MIN_RECLAIM_ABOVE_TRIGGER_PCT})`,
        ],
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

  if (
    CONFIG.BREAKOUT_ALLOW_ONE_REENTRY_AFTER_FAST_FAILURE &&
    execution.lastEnteredSetupId &&
    execution.lastEnteredSetupId === setupId &&
    state.position.lastExitReason === CONFIG.BREAKOUT_REENTRY_ALLOWED_EXIT_REASON
  ) {
    const reentryCount = breakout.reentryCount ?? 0;

    if (reentryCount >= 1) {
      return { allowed: false, reasons: ["reentry limit reached"] };
    }
  }

  return {
    allowed: true,
    reasons: [],
  };
}
