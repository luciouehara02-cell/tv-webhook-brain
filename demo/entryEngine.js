import { CONFIG } from "./config.js";

function num(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function pctDiff(a, b) {
  if (!num(a) || !num(b) || b === 0) return null;
  return ((a - b) / b) * 100;
}

function hasQualityFlag(breakout, flag) {
  return (
    Array.isArray(breakout?.qualityFlags) &&
    breakout.qualityFlags.includes(flag)
  );
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function inferEntryMode(state) {
  const b = state.setups.breakout;
  const f = state.features;
  const barIndex = state.meta?.barIndex ?? 0;
  const phaseBar = b.phaseBar ?? barIndex;

  if (b.phase === "ready") return "ready";
  if (b.phase === "bounce_confirmed") return "bounce";

  if (b.phase === "retest_pending") {
    const barsSincePhase = barIndex - phaseBar;
    const extFromTrigger = pctDiff(f.close, b.triggerPrice) ?? 0;

    const continuationStrong =
      (f.adx ?? 0) >= (CONFIG.BREAKOUT_CONTINUATION_ADX_MIN ?? 22) &&
      (f.rsi ?? 0) >= (CONFIG.BREAKOUT_CONTINUATION_RSI_MIN ?? 58) &&
      (f.ema8 ?? 0) > (f.ema18 ?? 0) &&
      (f.close ?? 0) > (b.triggerPrice ?? Number.POSITIVE_INFINITY) &&
      extFromTrigger >=
        (CONFIG.BREAKOUT_CONTINUATION_MIN_EXTENSION_PCT ?? 0.12) &&
      barsSincePhase >= (CONFIG.BREAKOUT_CONTINUATION_MIN_BARS ?? 1);

    if (continuationStrong) return "continuation";
  }

  return null;
}

function buildHardAndSoftReasons(state, mode) {
  const hardReasons = [];
  const softReasons = [];

  const b = state.setups.breakout;
  const f = state.features;
  const c = state.context;
  const close = f.close;

  if (!mode) {
    hardReasons.push("not in entry-capable phase");
    return { hardReasons, softReasons };
  }

  if (c.regime !== "trend") {
    hardReasons.push(`regime not trend (${c.regime})`);
  }

  if (c.hostile) {
    hardReasons.push("hostile context");
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
      `rsi below min (${(f.rsi ?? 0).toFixed(2)} < ${
        CONFIG.BREAKOUT_RSI_MIN_ON_ENTRY
      })`
    );
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
    hardReasons.push(
      `too extended from trigger (${extFromTrigger.toFixed(3)}%)`
    );
  }

  const triggerUnderPct =
    num(close) && num(b.triggerPrice)
      ? ((b.triggerPrice - close) / b.triggerPrice) * 100
      : null;

  if (
    CONFIG.BREAKOUT_REQUIRE_CLOSE_BACK_ABOVE_TRIGGER &&
    num(close) &&
    num(b.triggerPrice) &&
    close < b.triggerPrice
  ) {
    if (
      triggerUnderPct !== null &&
      triggerUnderPct >
        (CONFIG.MAX_CLOSE_BELOW_TRIGGER_TOLERANCE_PCT ?? 0.10)
    ) {
      hardReasons.push(
        `close too far below trigger (${triggerUnderPct.toFixed(3)}%)`
      );
    } else {
      softReasons.push("close slightly below trigger");
    }
  }

  if (mode === "ready") {
    if (
      b.readySinceBar !== null &&
      state.meta.barIndex - b.readySinceBar >
        CONFIG.BREAKOUT_MAX_READY_AGE_BARS_FOR_ENTRY
    ) {
      hardReasons.push("ready setup too old");
    }
  }

  if (
    CONFIG.BREAKOUT_REQUIRE_MEANINGFUL_PULLBACK_ON_ENTRY &&
    mode !== "continuation" &&
    !hasQualityFlag(b, "meaningful_pullback")
  ) {
    softReasons.push("pullback not meaningful");
  }

  if (
    CONFIG.BREAKOUT_REQUIRE_RETEST_NEAR_EMA8_ON_ENTRY &&
    mode !== "continuation" &&
    !hasQualityFlag(b, "retest_near_ema8")
  ) {
    softReasons.push("retest not near ema8");
  }

  if (
    CONFIG.BREAKOUT_REQUIRE_HELD_ABOVE_EMA18_ON_ENTRY &&
    mode !== "continuation" &&
    !hasQualityFlag(b, "held_above_ema18")
  ) {
    hardReasons.push("did not hold above ema18");
  }

  if (
    CONFIG.BREAKOUT_REQUIRE_BOUNCE_BODY_MIN_ON_ENTRY &&
    mode !== "continuation" &&
    !hasQualityFlag(b, "bounce_body_ok")
  ) {
    softReasons.push("bounce body too weak");
  }

  if (
    CONFIG.BREAKOUT_REQUIRE_CLOSE_IN_RANGE_MIN_ON_ENTRY &&
    mode !== "continuation" &&
    !hasQualityFlag(b, "bounce_close_strong")
  ) {
    softReasons.push("bounce close not strong enough");
  }

  if (
    CONFIG.BREAKOUT_REQUIRE_RECLAIM_ABOVE_TRIGGER_MIN_ON_ENTRY &&
    mode !== "continuation" &&
    !hasQualityFlag(b, "reclaim_above_trigger_ok")
  ) {
    softReasons.push("reclaim above trigger too weak");
  }

  if (mode === "bounce") {
    if (
      CONFIG.BREAKOUT_REQUIRE_BOUNCE_PCT_MIN_ON_BOUNCE_ENTRY &&
      (b.bouncePct ?? 0) < CONFIG.BREAKOUT_MIN_BOUNCE_PCT_FOR_ENTRY
    ) {
      softReasons.push(
        `bounce pct too small (${(b.bouncePct ?? 0).toFixed(3)}% < ${
          CONFIG.BREAKOUT_MIN_BOUNCE_PCT_FOR_ENTRY
        })`
      );
    }
  }

  if (
    CONFIG.BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE &&
    (f.oiTrend ?? 0) <= 0
  ) {
    hardReasons.push("oiTrend not supportive");
  } else if ((f.oiTrend ?? 0) <= 0) {
    softReasons.push("oiTrend not supportive");
  }

  if (
    CONFIG.BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE &&
    (f.cvdTrend ?? 0) < 0
  ) {
    hardReasons.push("cvdTrend negative");
  } else if ((f.cvdTrend ?? 0) < 0) {
    softReasons.push("cvdTrend negative");
  }

  if (
    mode === "continuation" &&
    (f.adx ?? 0) < (CONFIG.BREAKOUT_CONTINUATION_ADX_MIN ?? 22)
  ) {
    hardReasons.push("continuation adx too weak");
  }

  if (
    mode === "continuation" &&
    (f.rsi ?? 0) < (CONFIG.BREAKOUT_CONTINUATION_RSI_MIN ?? 58)
  ) {
    hardReasons.push("continuation rsi too weak");
  }

  return { hardReasons, softReasons };
}

function computeChasePct(state, mode) {
  const b = state.setups.breakout;
  const close = state.features.close;

  if (!num(close)) return null;

  if ((mode === "bounce" || mode === "ready") && num(b.bouncePrice)) {
    return pctDiff(close, b.bouncePrice);
  }

  if (mode === "continuation" && num(b.triggerPrice)) {
    return pctDiff(close, b.triggerPrice);
  }

  return null;
}

function chaseLimitForMode(mode) {
  if (mode === "bounce") {
    return CONFIG.BREAKOUT_MAX_CHASE_FROM_BOUNCE_PCT_BOUNCE_ENTRY ?? 0.20;
  }
  if (mode === "ready") {
    return CONFIG.BREAKOUT_MAX_CHASE_FROM_BOUNCE_PCT_READY_ENTRY ?? 0.35;
  }
  if (mode === "continuation") {
    return (
      CONFIG.BREAKOUT_MAX_CHASE_FROM_TRIGGER_PCT_CONTINUATION_ENTRY ?? 0.28
    );
  }
  return 0.25;
}

function computeEntryScoreAdjustment(state, mode, softReasons) {
  const f = state.features;
  const b = state.setups.breakout;

  let score = b.score ?? 0;

  if (mode === "continuation") score += 1;
  if ((f.adx ?? 0) >= 28) score += 1;
  if ((f.rsi ?? 0) >= 62) score += 1;
  if ((f.oiTrend ?? 0) <= 0) score -= 1;
  if ((f.cvdTrend ?? 0) < 0) score -= 1;

  score -= clamp(softReasons.length, 0, 3);

  return score;
}

export function validateBreakoutEntry(state) {
  const mode = inferEntryMode(state);
  const { hardReasons, softReasons } = buildHardAndSoftReasons(state, mode);

  const chasePct = computeChasePct(state, mode);
  const chaseLimit = chaseLimitForMode(mode);

  if (num(chasePct) && chasePct > chaseLimit) {
    hardReasons.push(
      `chase too large (${chasePct.toFixed(3)}% > ${chaseLimit})`
    );
  }

  const effectiveScore = computeEntryScoreAdjustment(state, mode, softReasons);

  if (effectiveScore < (CONFIG.BREAKOUT_MIN_SCORE ?? 7)) {
    hardReasons.push(
      `effective score too low (${effectiveScore} < ${
        CONFIG.BREAKOUT_MIN_SCORE ?? 7
      })`
    );
  }

  const allowed =
    mode !== null &&
    hardReasons.length === 0 &&
    softReasons.length <= (CONFIG.BREAKOUT_MAX_SOFT_REASONS ?? 2);

  return {
    allowed,
    mode,
    score: effectiveScore,
    chasePct,
    reasons: [...hardReasons, ...softReasons],
    hardReasons,
    softReasons,
  };
}

export function buildEntryDecision(state) {
  const validation = validateBreakoutEntry(state);
  const f = state.features;

  if (!validation.allowed) {
    return {
      allowed: false,
      mode: validation.mode,
      score: validation.score,
      reasons: validation.reasons,
      hardReasons: validation.hardReasons,
      softReasons: validation.softReasons,
      patch: null,
    };
  }

  return {
    allowed: true,
    mode: validation.mode,
    score: validation.score,
    reasons: [],
    hardReasons: [],
    softReasons: [],
    patch: {
      score: validation.score,
      chasePct: validation.chasePct ?? null,
      consumedAtBar: state.meta.barIndex,
      lastEntryMode: validation.mode,
      entryCandidatePrice: f.close ?? null,
    },
  };
}
