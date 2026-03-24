import { CONFIG } from "./config.js";

function pctDiff(a, b) {
  if (!a || !b) return null;
  return ((a - b) / b) * 100;
}

function hasQualityFlag(breakout, flag) {
  return Array.isArray(breakout.qualityFlags) && breakout.qualityFlags.includes(flag);
}

export function validateBreakout(state) {
  const hardReasons = [];
  const softReasons = [];
  const b = state.setups.breakout;
  const f = state.features;
  const c = state.context;
  const close = f.close;

  const isReady = b.phase === "ready";
  const isBounce = b.phase === "bounce_confirmed";

  if (!isReady && !(CONFIG.ALLOW_ENTRY_ON_BOUNCE_CONFIRMED && isBounce)) {
    hardReasons.push("not in entry-capable phase");
    return {
      allowed: false,
      reasons: hardReasons,
      hardReasons,
      softReasons,
    };
  }

  if (c.regime !== "trend") {
    hardReasons.push("regime not trend");
  }

  if (c.hostile) {
    hardReasons.push("hostile context");
  }

  if ((f.oiTrend ?? 0) <= 0) {
    softReasons.push("oiTrend not supportive");
  }

  if ((f.cvdTrend ?? 0) < 0) {
    softReasons.push("cvdTrend negative");
  }

  const extFromEma18 = pctDiff(close, f.ema18);
  if (
    extFromEma18 !== null &&
    extFromEma18 > CONFIG.MAX_ENTRY_EXTENSION_FROM_EMA18_PCT
  ) {
    hardReasons.push(`too extended from ema18 (${extFromEma18.toFixed(3)}%)`);
  }

  const extFromTrigger = pctDiff(close, b.triggerPrice);
  if (
    extFromTrigger !== null &&
    extFromTrigger > CONFIG.MAX_ENTRY_EXTENSION_FROM_TRIGGER_PCT
  ) {
    hardReasons.push(`too extended from trigger (${extFromTrigger.toFixed(3)}%)`);
  }

  const triggerUnderPct =
    close && b.triggerPrice ? ((b.triggerPrice - close) / b.triggerPrice) * 100 : null;

  if (
    CONFIG.BREAKOUT_REQUIRE_CLOSE_BACK_ABOVE_TRIGGER &&
    close < b.triggerPrice
  ) {
    if (
      triggerUnderPct !== null &&
      triggerUnderPct > CONFIG.MAX_CLOSE_BELOW_TRIGGER_TOLERANCE_PCT
    ) {
      hardReasons.push(`close too far below trigger (${triggerUnderPct.toFixed(3)}%)`);
    } else {
      softReasons.push("close slightly below trigger");
    }
  }

  if (
    CONFIG.BREAKOUT_REQUIRE_EMA8_ABOVE_EMA18_ON_ENTRY &&
    (f.ema8 ?? 0) <= (f.ema18 ?? 0)
  ) {
    hardReasons.push("ema8 not above ema18");
  }

  if (
    CONFIG.BREAKOUT_REQUIRE_RSI_MIN_ON_ENTRY &&
    (f.rsi ?? 0) < CONFIG.BREAKOUT_RSI_MIN_ON_ENTRY
  ) {
    hardReasons.push(
      `rsi below min (${f.rsi ?? 0} < ${CONFIG.BREAKOUT_RSI_MIN_ON_ENTRY})`
    );
  }

  if (
    b.readySinceBar !== null &&
    (state.meta.barIndex - b.readySinceBar) > CONFIG.BREAKOUT_MAX_READY_AGE_BARS_FOR_ENTRY
  ) {
    hardReasons.push("ready setup too old");
  }

  if (
    CONFIG.BREAKOUT_REQUIRE_MEANINGFUL_PULLBACK_ON_ENTRY &&
    !hasQualityFlag(b, "meaningful_pullback") &&
    !hasQualityFlag(b, "shallow_pullback_ok")
  ) {
    softReasons.push("pullback not meaningful");
  }

  if (
    CONFIG.BREAKOUT_REQUIRE_RETEST_NEAR_EMA8_ON_ENTRY &&
    !hasQualityFlag(b, "retest_near_ema8") &&
    !hasQualityFlag(b, "retest_near_trigger")
  ) {
    softReasons.push("retest not near ema8");
  }

  if (
    CONFIG.BREAKOUT_REQUIRE_HELD_ABOVE_EMA18_ON_ENTRY &&
    !hasQualityFlag(b, "held_above_ema18")
  ) {
    hardReasons.push("did not hold above ema18");
  }

  if (
    CONFIG.BREAKOUT_REQUIRE_BOUNCE_BODY_MIN_ON_ENTRY &&
    !hasQualityFlag(b, "bounce_body_ok")
  ) {
    softReasons.push("bounce body too weak");
  }

  if (
    CONFIG.BREAKOUT_REQUIRE_CLOSE_IN_RANGE_MIN_ON_ENTRY &&
    !hasQualityFlag(b, "bounce_close_strong")
  ) {
    softReasons.push("bounce close not strong enough");
  }

  if (
    CONFIG.BREAKOUT_REQUIRE_RECLAIM_ABOVE_TRIGGER_MIN_ON_ENTRY &&
    !hasQualityFlag(b, "reclaim_above_trigger_ok")
  ) {
    softReasons.push("reclaim above trigger too weak");
  }

  if (isBounce) {
    if (
      CONFIG.BREAKOUT_REQUIRE_BOUNCE_PCT_MIN_ON_BOUNCE_ENTRY &&
      (b.bouncePct ?? 0) < CONFIG.BREAKOUT_MIN_BOUNCE_PCT_FOR_ENTRY
    ) {
      softReasons.push(
        `bounce pct too small (${(b.bouncePct ?? 0).toFixed(3)}% < ${CONFIG.BREAKOUT_MIN_BOUNCE_PCT_FOR_ENTRY})`
      );
    }

    if (
      CONFIG.BREAKOUT_REQUIRE_STRONG_OI_ON_BOUNCE_ENTRY &&
      (f.oiTrend ?? 0) < 1
    ) {
      softReasons.push("oiTrend not strong enough for bounce entry");
    }

    if (
      CONFIG.BREAKOUT_REQUIRE_STRONG_CVD_ON_BOUNCE_ENTRY &&
      (f.cvdTrend ?? 0) < 1
    ) {
      softReasons.push("cvdTrend not strong enough for bounce entry");
    }

    const weakFlow = (f.oiTrend ?? 0) < 1 && (f.cvdTrend ?? 0) < 1;
    if (CONFIG.BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE && weakFlow) {
      hardReasons.push("flow not supportive for bounce entry");
    }
  }

  const allowed =
    hardReasons.length === 0 &&
    softReasons.length <= CONFIG.BREAKOUT_MAX_SOFT_REASONS;

  return {
    allowed,
    reasons: [...hardReasons, ...softReasons],
    hardReasons,
    softReasons,
  };
}
