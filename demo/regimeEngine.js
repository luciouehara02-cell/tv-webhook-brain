import { CONFIG } from "./config.js";

function isBullAligned(features) {
  const { ema8, ema18, ema50 } = features;
  if ([ema8, ema18, ema50].some((v) => v === null)) return false;
  return ema8 > ema18 && ema18 > ema50;
}

function isBearAligned(features) {
  const { ema8, ema18, ema50 } = features;
  if ([ema8, ema18, ema50].some((v) => v === null)) return false;
  return ema8 < ema18 && ema18 < ema50;
}

export function calculateRegime(state) {
  const f = state.features;
  const reasons = [];

  const adx = f.adx ?? 0;
  const atrPct = f.atrPct ?? 0;
  const bullAligned = isBullAligned(f);
  const bearAligned = isBearAligned(f);

  let regime = "mixed";
  let confidence = 0.5;
  let hostile = false;

  if (adx >= CONFIG.REGIME_ADX_TREND_MIN && atrPct >= CONFIG.REGIME_ATRPCT_MIN) {
    if (bullAligned || bearAligned) {
      regime = "trend";
      confidence = 0.8;
      reasons.push("adx strong", "atrPct healthy", "ema aligned");
    } else {
      regime = "mixed";
      confidence = 0.6;
      reasons.push("adx strong", "atrPct healthy", "ema not aligned");
    }
  } else if (adx <= CONFIG.REGIME_ADX_RANGE_MAX) {
    regime = "range";
    confidence = 0.75;
    reasons.push("low adx");
    if (atrPct < CONFIG.REGIME_ATRPCT_MIN) {
      reasons.push("low atrPct");
    }
  } else {
    regime = "mixed";
    confidence = 0.55;
    reasons.push("mid adx");
  }

  if (atrPct > 0 && atrPct < 0.12) {
    hostile = true;
    reasons.push("volatility too low");
  }

  if (state.features.cvdTrend !== null && state.features.oiTrend !== null) {
    if (regime === "trend" && state.features.cvdTrend < 0 && state.features.oiTrend <= 0) {
      hostile = true;
      reasons.push("flow disagreement");
    }
  }

  return {
    regime,
    confidence,
    hostile,
    reasons,
  };
}
