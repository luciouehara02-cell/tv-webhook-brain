import { CONFIG } from "./config.js";

function pctDiff(a, b) {
  if (!a || !b) return null;
  return ((a - b) / b) * 100;
}

export function validateBreakout(state) {
  const reasons = [];
  const b = state.setups.breakout;
  const f = state.features;
  const c = state.context;
  const close = f.close;

  const isReady = b.phase === "ready";
  const isBounce = b.phase === "bounce_confirmed";

  if (!isReady && !(CONFIG.ALLOW_ENTRY_ON_BOUNCE_CONFIRMED && isBounce)) {
    reasons.push("not in entry-capable phase");
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

  const extFromTrigger = pctDiff(close, b.triggerPrice);
  if (
    extFromTrigger !== null &&
    extFromTrigger > CONFIG.MAX_ENTRY_EXTENSION_FROM_TRIGGER_PCT
  ) {
    reasons.push(`too extended from trigger (${extFromTrigger.toFixed(3)}%)`);
  }

  if (
    CONFIG.BREAKOUT_REQUIRE_CLOSE_BACK_ABOVE_TRIGGER &&
    close < b.triggerPrice
  ) {
    reasons.push("close below trigger");
  }

  if (
    CONFIG.BREAKOUT_REQUIRE_EMA8_ABOVE_EMA18_ON_ENTRY &&
    (f.ema8 ?? 0) <= (f.ema18 ?? 0)
  ) {
    reasons.push("ema8 not above ema18");
  }

  if (
    CONFIG.BREAKOUT_REQUIRE_RSI_MIN_ON_ENTRY &&
    (f.rsi ?? 0) < CONFIG.BREAKOUT_RSI_MIN_ON_ENTRY
  ) {
    reasons.push(
      `rsi below min (${f.rsi ?? 0} < ${CONFIG.BREAKOUT_RSI_MIN_ON_ENTRY})`
    );
  }

  if (
    b.readySinceBar !== null &&
    (state.meta.barIndex - b.readySinceBar) > CONFIG.BREAKOUT_MAX_READY_AGE_BARS_FOR_ENTRY
  ) {
    reasons.push("ready setup too old");
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}
