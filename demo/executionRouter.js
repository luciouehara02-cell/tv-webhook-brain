import { shouldEnterBreakout } from "./entryPolicy.js";

export function routeExecution(state) {
  const breakoutDecision = shouldEnterBreakout(state);

  if (breakoutDecision.allowed) {
    return {
      action: "enter_long",
      setupType: "breakout",
      reason: "breakout entry allowed",
      reasons: [],
    };
  }

  return {
    action: "noop",
    setupType: "breakout",
    reason:
      breakoutDecision.reasons?.join(" | ") || "entry conditions not met",
    reasons: breakoutDecision.reasons || [],
  };
}
