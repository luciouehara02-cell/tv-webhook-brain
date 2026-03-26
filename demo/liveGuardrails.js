import { CONFIG } from "./config.js";

function buildEventKey(kind, state) {
  const breakout = state.setups.breakout;
  const time = state.market.time || "na";
  const phase = breakout.phase || "na";
  const trigger = breakout.triggerPrice ?? "na";

  return `${kind}|${time}|${phase}|${trigger}`;
}

export function checkLiveEntryGuardrails(state) {
  if (CONFIG.EXECUTION_MODE !== "live") {
    return {
      allowed: false,
      reason: "execution mode is not live",
      eventKey: null,
    };
  }

  if (!CONFIG.LIVE_EXECUTION_ENABLED) {
    return {
      allowed: false,
      reason: "live execution disabled",
      eventKey: null,
    };
  }

  if (!CONFIG.C3_SIGNAL_SECRET || !CONFIG.C3_BOT_UUID) {
    return {
      allowed: false,
      reason: "missing 3Commas credentials",
      eventKey: null,
    };
  }

  const eventKey = buildEventKey("enter_long", state);

  if (state.execution.lastLiveEventKey === eventKey) {
    return {
      allowed: false,
      reason: "duplicate live event blocked",
      eventKey,
    };
  }

  return {
    allowed: true,
    reason: "live entry allowed",
    eventKey,
  };
}

export function checkLiveExitGuardrails(state) {
  if (CONFIG.EXECUTION_MODE !== "live") {
    return {
      allowed: false,
      reason: "execution mode is not live",
      eventKey: null,
    };
  }

  if (!CONFIG.LIVE_EXECUTION_ENABLED) {
    return {
      allowed: false,
      reason: "live execution disabled",
      eventKey: null,
    };
  }

  if (!CONFIG.C3_SIGNAL_SECRET || !CONFIG.C3_BOT_UUID) {
    return {
      allowed: false,
      reason: "missing 3Commas credentials",
      eventKey: null,
    };
  }

  const eventKey = buildEventKey("exit_long", state);

  if (state.execution.lastLiveEventKey === eventKey) {
    return {
      allowed: false,
      reason: "duplicate live event blocked",
      eventKey,
    };
  }

  return {
    allowed: true,
    reason: "live exit allowed",
    eventKey,
  };
}
