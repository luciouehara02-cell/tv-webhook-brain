import { CONFIG } from "./config.js";
import { buildEntryDecision } from "./entryEngine.js";

export function shouldEnterBreakout(state) {
  const position = state.position;
  const execution = state.execution;
  const breakout = state.setups.breakout;
  const bar = state.meta.barIndex;

  if (
    !CONFIG.DRY_RUN_EXECUTION_ENABLED &&
    CONFIG.EXECUTION_MODE === "dry_run"
  ) {
    return {
      allowed: false,
      mode: null,
      score: 0,
      reasons: ["dry run execution disabled"],
      hardReasons: ["dry run execution disabled"],
      softReasons: [],
      patch: null,
    };
  }

  if (position.inPosition) {
    return {
      allowed: false,
      mode: null,
      score: 0,
      reasons: ["already in position"],
      hardReasons: ["already in position"],
      softReasons: [],
      patch: null,
    };
  }

  if (
    execution.cooldownUntilBar !== null &&
    bar < execution.cooldownUntilBar
  ) {
    return {
      allowed: false,
      mode: null,
      score: 0,
      reasons: [`cooldown active until bar ${execution.cooldownUntilBar}`],
      hardReasons: [`cooldown active until bar ${execution.cooldownUntilBar}`],
      softReasons: [],
      patch: null,
    };
  }

  const entryDecision = buildEntryDecision(state);

  if (!entryDecision.allowed) {
    return {
      allowed: false,
      mode: entryDecision.mode ?? null,
      score: entryDecision.score ?? 0,
      reasons: entryDecision.reasons ?? ["entry conditions not met"],
      hardReasons: entryDecision.hardReasons ?? [],
      softReasons: entryDecision.softReasons ?? [],
      patch: null,
    };
  }

  const setupId =
    breakout.setupId ||
    `${breakout.startedBar}-${breakout.lastTransition}-${breakout.triggerPrice}`;

  if (
    CONFIG.ALLOW_ONLY_ONE_ENTRY_PER_SETUP &&
    execution.lastEnteredSetupId &&
    execution.lastEnteredSetupId === setupId
  ) {
    return {
      allowed: false,
      mode: entryDecision.mode ?? null,
      score: entryDecision.score ?? 0,
      reasons: ["already entered this setup"],
      hardReasons: ["already entered this setup"],
      softReasons: [],
      patch: null,
    };
  }

  if (
    CONFIG.BREAKOUT_ALLOW_ONE_REENTRY_AFTER_FAST_FAILURE &&
    execution.lastEnteredSetupId &&
    execution.lastEnteredSetupId === setupId &&
    state.position.lastExitReason === CONFIG.BREAKOUT_REENTRY_ALLOWED_EXIT_REASON
  ) {
    const reentryCount = breakout.reentryCount ?? 0;

    if (reentryCount >= 1) {
      return {
        allowed: false,
        mode: entryDecision.mode ?? null,
        score: entryDecision.score ?? 0,
        reasons: ["reentry limit reached"],
        hardReasons: ["reentry limit reached"],
        softReasons: [],
        patch: null,
      };
    }
  }

  return {
    allowed: true,
    mode: entryDecision.mode ?? null,
    score: entryDecision.score ?? 0,
    reasons: [],
    hardReasons: [],
    softReasons: [],
    patch: entryDecision.patch ?? null,
  };
}
