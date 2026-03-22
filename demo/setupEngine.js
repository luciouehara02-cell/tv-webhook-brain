import { CONFIG } from "./config.js";

function num(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function pctChange(current, base) {
  if (!num(current) || !num(base) || base === 0) return null;
  return ((current - base) / base) * 100;
}

function scoreBreakout(state, setup, options = {}) {
  const { provisional = false } = options;

  let score = 0;
  const reasons = [];
  const f = state.features;
  const c = state.context;

  if (c.regime === "trend") {
    score += 2;
    reasons.push("trend regime");
  }

  if ((c.confidence ?? 0) >= 0.75) {
    score += 1;
    reasons.push("good regime confidence");
  }

  if ((f.adx ?? 0) >= 25) {
    score += 1;
    reasons.push("strong adx");
  }

  if ((f.atrPct ?? 0) >= 0.30) {
    score += 1;
    reasons.push("healthy atrPct");
  }

  if ((f.oiTrend ?? 0) > 0) {
    score += 1;
    reasons.push("oi supportive");
  }

  if ((f.cvdTrend ?? 0) >= 0) {
    score += 1;
    reasons.push("cvd supportive");
  }

  if ((f.rsi ?? 0) >= 52) {
    score += 1;
    reasons.push("rsi supportive");
  }

  if (
    num(setup.retestPrice) &&
    num(setup.bouncePrice) &&
    setup.bouncePrice > setup.retestPrice
  ) {
    score += 1;
    reasons.push(provisional ? "bounce prelim confirmed" : "bounce confirmed");
  }

  if (
    num(setup.pullbackPct) &&
    Math.abs(setup.pullbackPct) >= CONFIG.BREAKOUT_MIN_PULLBACK_PCT
  ) {
    score += 1;
    reasons.push("meaningful pullback");
  }

  if (
    num(setup.bouncePct) &&
    setup.bouncePct >= CONFIG.BREAKOUT_CONFIRM_BOUNCE_PCT
  ) {
    score += 1;
    reasons.push("bounce pct ok");
  }

  return { score, reasons };
}

function resetPatch(bar, reason = "returned to idle", transition = "reset_to_idle") {
  return {
    phase: "idle",
    startedBar: null,
    phaseBar: bar,
    triggerPrice: null,
    breakoutLevel: null,
    retestPrice: null,
    bouncePrice: null,
    score: 0,
    reasons: [reason],
    lastTransition: transition,

    setupId: null,
    retestLow: null,
    invalidationPrice: null,
    readySinceBar: null,
    expiresAtBar: null,
    bouncePct: null,
    pullbackPct: null,
    chasePct: null,
    qualityFlags: [],
    cancelReason: null,
    consumedAtBar: null,
  };
}

export function runBreakoutSetup(state) {
  const f = state.features;
  const c = state.context;
  const s = state.setups.breakout;
  const bar = state.meta.barIndex;

  if (s.phase === "consumed") {
    return {
      action: "noop",
      patch: null,
      note: "setup consumed",
    };
  }

  const close = f.close;
  const low = f.low ?? close;
  const ema8 = f.ema8;
  const ema18 = f.ema18;
  const ema50 = f.ema50;

  if (![close, ema8, ema18, ema50].every(num)) {
    return {
      action: "noop",
      patch: null,
      note: "missing required features",
    };
  }

  if (!CONFIG.BREAKOUT_ENABLED) {
    return {
      action: "noop",
      patch: null,
      note: "breakout disabled",
    };
  }

  const bullAligned = ema8 > ema18 && ema18 > ema50;
  const impulsePct = pctChange(close, ema8) ?? 0;
  const retestTolerance = CONFIG.BREAKOUT_RETEST_TOLERANCE_PCT / 100;

  if (s.phase !== "idle" && s.startedBar !== null) {
    const ageBars = bar - s.startedBar;
    if (ageBars > CONFIG.BREAKOUT_SETUP_EXPIRY_BARS) {
      return {
        action: "expire",
        patch: {
          phase: "expired",
          phaseBar: bar,
          lastTransition: "expired",
          reasons: [`expired after ${ageBars} bars`],
          score: 0,
          cancelReason: "setup_expired",
        },
        note: "setup expired",
      };
    }
  }

  if (s.phase === "idle") {
    const rejectReasons = [];

    if (c.regime !== "trend") rejectReasons.push(`regime=${c.regime}`);
    if (c.hostile) rejectReasons.push("hostile=true");
    if (!bullAligned) rejectReasons.push("bullAligned=false");

    if (impulsePct < CONFIG.BREAKOUT_MIN_IMPULSE_PCT) {
      rejectReasons.push(
        `impulsePct=${impulsePct.toFixed(3)} < min=${CONFIG.BREAKOUT_MIN_IMPULSE_PCT}`
      );
    }

    if ((f.adx ?? 0) < CONFIG.REGIME_ADX_TREND_MIN) {
      rejectReasons.push(
        `adx=${(f.adx ?? 0).toFixed(2)} < min=${CONFIG.REGIME_ADX_TREND_MIN}`
      );
    }

    if (
      c.regime === "trend" &&
      !c.hostile &&
      bullAligned &&
      impulsePct >= CONFIG.BREAKOUT_MIN_IMPULSE_PCT &&
      (f.adx ?? 0) >= CONFIG.REGIME_ADX_TREND_MIN
    ) {
      return {
        action: "transition",
        patch: {
          phase: "breakout_detected",
          startedBar: bar,
          phaseBar: bar,
          triggerPrice: close,
          breakoutLevel: close,
          retestPrice: null,
          bouncePrice: null,
          score: 0,
          reasons: ["breakout detected"],
          lastTransition: "breakout_detected",

          setupId: `${bar}-${close}-breakout`,
          retestLow: null,
          invalidationPrice: null,
          readySinceBar: null,
          expiresAtBar: null,
          bouncePct: null,
          pullbackPct: null,
          chasePct: null,
          qualityFlags: [],
          cancelReason: null,
          consumedAtBar: null,
        },
        note: "breakout detected",
      };
    }

    return {
      action: "noop",
      patch: null,
      note: `idle no breakout | ${rejectReasons.join(", ") || "no specific reject reason"}`,
    };
  }

  if (s.phase === "breakout_detected") {
    return {
      action: "transition",
      patch: {
        phase: "retest_pending",
        phaseBar: bar,
        lastTransition: "retest_pending",
        reasons: ["waiting retest"],
      },
      note: "waiting retest",
    };
  }

  if (s.phase === "retest_pending") {
    const barsSincePhase = bar - (s.phaseBar ?? bar);

    const retestNearEma8 = Math.abs((low - ema8) / ema8) <= retestTolerance;
    const retestAboveEma18 = low >= ema18;

    const lowPullbackPct = pctChange(low, s.triggerPrice) ?? 0;
    const meaningfulPullback = lowPullbackPct <= -CONFIG.BREAKOUT_MIN_PULLBACK_PCT;

    const retestSeen = meaningfulPullback && retestNearEma8 && retestAboveEma18;

    if (barsSincePhase > CONFIG.BREAKOUT_MAX_RETEST_BARS) {
      return {
        action: "invalidate",
        patch: {
          phase: "invalidated",
          phaseBar: bar,
          lastTransition: "invalidated",
          reasons: ["retest timeout"],
          score: 0,
          cancelReason: "retest_timeout",
        },
        note: "retest timeout",
      };
    }

    if (low < ema18) {
      return {
        action: "invalidate",
        patch: {
          phase: "invalidated",
          phaseBar: bar,
          lastTransition: "invalidated",
          reasons: ["lost ema18 on retest"],
          score: 0,
          cancelReason: "lost_ema18_on_retest",
        },
        note: "lost ema18 on retest",
      };
    }

    if (retestSeen) {
      const invalidationPrice =
        low * (1 - CONFIG.BREAKOUT_RETEST_LOW_BUFFER_PCT / 100);

      const provisionalBouncePct = pctChange(close, low) ?? 0;

      const provisionalScore = scoreBreakout(
        state,
        {
          ...s,
          retestPrice: low,
          bouncePrice: close,
          retestLow: low,
          invalidationPrice,
          pullbackPct: lowPullbackPct,
          bouncePct: provisionalBouncePct,
        },
        { provisional: true }
      );

      return {
        action: "transition",
        patch: {
          phase: "bounce_confirmed",
          phaseBar: bar,
          retestPrice: low,
          retestLow: low,
          invalidationPrice,
          bouncePrice: close,
          pullbackPct: lowPullbackPct,
          bouncePct: provisionalBouncePct,
          score: provisionalScore.score,
          reasons: provisionalScore.reasons,
          qualityFlags: [
            "meaningful_pullback",
            "retest_near_ema8",
            "held_above_ema18",
          ],
          lastTransition: "bounce_confirmed",
        },
        note: "retest seen",
      };
    }

    return {
      action: "noop",
      patch: null,
      note: "still waiting retest",
    };
  }

  if (s.phase === "bounce_confirmed") {
    const bouncePct = pctChange(close, s.retestPrice) ?? 0;

    if (s.invalidationPrice !== null && close < s.invalidationPrice) {
      return {
        action: "invalidate",
        patch: {
          phase: "invalidated",
          phaseBar: bar,
          lastTransition: "invalidated",
          reasons: [
            `lost retest low (${close.toFixed(4)} < ${s.invalidationPrice.toFixed(4)})`,
          ],
          score: 0,
          cancelReason: "lost_retest_low",
        },
        note: "lost retest low",
      };
    }

    if (bouncePct >= CONFIG.BREAKOUT_CONFIRM_BOUNCE_PCT) {
      const scored = scoreBreakout(
        state,
        {
          ...s,
          bouncePrice: close,
          bouncePct,
        },
        { provisional: false }
      );

      return {
        action: "transition",
        patch: {
          phase: "ready",
          phaseBar: bar,
          readySinceBar: bar,
          expiresAtBar: bar + CONFIG.BREAKOUT_READY_EXPIRY_BARS,
          bouncePrice: close,
          bouncePct,
          score: scored.score,
          reasons: scored.reasons,
          qualityFlags: [
            ...(s.qualityFlags ?? []),
            bouncePct >= CONFIG.BREAKOUT_CONFIRM_BOUNCE_PCT ? "bounce_pct_ok" : "bounce_pct_weak",
            close >= s.triggerPrice ? "close_above_trigger" : "close_below_trigger",
            ema8 > ema18 ? "ema8_above_ema18" : "ema8_not_above_ema18",
          ],
          lastTransition: "ready",
        },
        note: "breakout ready",
      };
    }

    if (close < ema18) {
      return {
        action: "invalidate",
        patch: {
          phase: "invalidated",
          phaseBar: bar,
          lastTransition: "invalidated",
          reasons: ["bounce failed under ema18"],
          score: 0,
          cancelReason: "bounce_failed_under_ema18",
        },
        note: "bounce failed",
      };
    }

    const rescored = scoreBreakout(
      state,
      {
        ...s,
        bouncePrice: close,
        bouncePct,
      },
      { provisional: true }
    );

    return {
      action: "rescore",
      patch: {
        score: rescored.score,
        reasons: rescored.reasons,
        phaseBar: bar,
        bouncePrice: close,
        bouncePct,
      },
      note: "bounce still forming",
    };
  }

  if (s.phase === "ready") {
    const readyAgeBars = bar - (s.readySinceBar ?? s.phaseBar ?? bar);

    if (s.invalidationPrice !== null && close < s.invalidationPrice) {
      return {
        action: "invalidate",
        patch: {
          phase: "invalidated",
          phaseBar: bar,
          lastTransition: "invalidated",
          reasons: [
            `lost retest low (${close.toFixed(4)} < ${s.invalidationPrice.toFixed(4)})`,
          ],
          score: 0,
          cancelReason: "lost_retest_low",
        },
        note: "lost retest low",
      };
    }

    if (readyAgeBars > CONFIG.BREAKOUT_READY_EXPIRY_BARS) {
      return {
        action: "expire",
        patch: {
          phase: "expired",
          phaseBar: bar,
          lastTransition: "ready_expired",
          reasons: [`ready expired after ${readyAgeBars} bars`],
          score: 0,
          cancelReason: "ready_expired",
        },
        note: "ready expired",
      };
    }

    const rescored = scoreBreakout(
      state,
      {
        ...s,
      },
      { provisional: false }
    );

    return {
      action: "rescore",
      patch: {
        score: rescored.score,
        reasons: rescored.reasons,
        phaseBar: bar,
      },
      note: "ready rescored",
    };
  }

  if (s.phase === "invalidated" || s.phase === "expired") {
    return {
      action: "reset",
      patch: resetPatch(bar),
      note: "reset to idle",
    };
  }

  return {
    action: "noop",
    patch: null,
    note: "no transition",
  };
}
