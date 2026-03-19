import { CONFIG } from "./config.js";

function pctDiff(a, b) {
  if (!a || !b) return null;
  return ((a - b) / b) * 100;
}

export function validateBreakout(state) {
  const reasons = [];
  const s = state.setups.breakout;
  const f = state.features;
  const c = state.context;
  const close = f.close;

  if (s.phase !== "bounce_confirmed" && s.phase !== "ready") {
    reasons.push("setup not in entry-capable phase");
    return { allowed: false, reasons };
  }

  if (c.regime !== "trend") {
    reasons.push("regime not trend");
  }

  if (c.hostile) {
    reasons.push("hostile context");
  }

  if ((f.oiTrend ?? 0) <= 0) {
    reasons.push("oiTrend not supportive");
  }

  if ((f.cvdTrend ?? 0) < 0) {
    reasons.push("cvdTrend negative");
  }

  const extFromEma18 = pctDiff(close, f.ema18);
  if (
    extFromEma18 !== null &&
    extFromEma18 > CONFIG.MAX_ENTRY_EXTENSION_FROM_EMA18_PCT
  ) {
    reasons.push(`too extended from ema18 (${extFromEma18.toFixed(3)}%)`);
  }

  const extFromTrigger = pctDiff(close, s.triggerPrice);
  if (
    extFromTrigger !== null &&
    extFromTrigger > CONFIG.MAX_ENTRY_EXTENSION_FROM_TRIGGER_PCT
  ) {
    reasons.push(`too extended from trigger (${extFromTrigger.toFixed(3)}%)`);
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}
