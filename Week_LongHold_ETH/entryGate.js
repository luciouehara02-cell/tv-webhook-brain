"use strict";

function finite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function recordFiveMinuteBar(audit, feature, maxBars = 900) {
  audit.entryGate5mBars = Array.isArray(audit.entryGate5mBars) ? audit.entryGate5mBars : [];
  const time = finite(feature.barTimeMs, Date.now());
  const close = finite(feature.close, finite(feature.price, null));
  if (!(close > 0)) return;
  const bar = { time, close, fvvo: finite(feature.fvvo), slope: finite(feature.slope), ray: String(feature.rayRegime || "RAY_NEUTRAL") };
  const prior = audit.entryGate5mBars[audit.entryGate5mBars.length - 1];
  if (prior && prior.time === time) audit.entryGate5mBars[audit.entryGate5mBars.length - 1] = bar;
  else audit.entryGate5mBars.push(bar);
  audit.entryGate5mBars = audit.entryGate5mBars.slice(-Math.max(36, maxBars));
}

function aggregate(source, minutes) {
  const width = minutes * 60000;
  const buckets = [];
  for (const bar of source || []) {
    const key = Math.floor(bar.time / width) * width;
    let bucket = buckets[buckets.length - 1];
    if (!bucket || bucket.time !== key) {
      bucket = { time: key, open: bar.close, close: bar.close };
      buckets.push(bucket);
    } else bucket.close = bar.close;
  }
  return buckets.slice(-3);
}

function frame(source, minutes) {
  const bars = aggregate(source, minutes);
  if (bars.length < 3) return { timeframe: `${minutes}m`, ready: false, barsAvailable: bars.length, barsRequired: 3, bias: "WARMING_UP", score: 0 };
  const bullish = bars.filter(b => b.close > b.open).length;
  const bearish = bars.filter(b => b.close < b.open).length;
  const rising = bars[2].close > bars[1].close && bars[1].close > bars[0].close;
  const falling = bars[2].close < bars[1].close && bars[1].close < bars[0].close;
  const score = Math.max(-100, Math.min(100, (bullish - bearish) * 30 + (rising ? 30 : 0) - (falling ? 30 : 0)));
  return { timeframe: minutes === 60 ? "1H" : minutes === 240 ? "4H" : "15m", ready: true, bullishBars: bullish, bearishBars: bearish, rising, falling, score, bias: score >= 30 ? "BULLISH" : score <= -30 ? "BEARISH" : "MIXED" };
}

function assess({ audit, fastFeature, role }) {
  const source = audit?.entryGate5mBars || [];
  const frames = { m15: frame(source, 15), h1: frame(source, 60), h4: frame(source, 240) };
  const weights = { m15: 0.25, h1: 0.45, h4: 0.30 };
  let weighted = 0, readyWeight = 0;
  for (const key of Object.keys(weights)) if (frames[key].ready) { weighted += frames[key].score * weights[key]; readyWeight += weights[key]; }
  let score = readyWeight ? weighted / readyWeight : 0;
  const fast = fastFeature || {};
  const price = finite(fast.price), ema8 = finite(fast.ema8), ema18 = finite(fast.ema18), fvvo = finite(fast.fvvo), slope = finite(fast.slope);
  const ray = String(fast.rayRegime || "RAY_NEUTRAL").toUpperCase();
  const signals = [];
  if (price && ema8 && price >= ema8) { score += 5; signals.push("PRICE_ABOVE_EMA8"); } else if (price && ema8) score -= 5;
  if (ema8 && ema18 && ema8 >= ema18) { score += 8; signals.push("EMA8_ABOVE_EMA18"); } else if (ema8 && ema18) score -= 8;
  if (fvvo !== null && fvvo > 0) { score += 5; signals.push("FVVO_POSITIVE"); } else if (fvvo !== null) score -= 5;
  if (slope !== null && slope > 0) { score += 5; signals.push("SLOPE_POSITIVE"); } else if (slope !== null) score -= 5;
  if (ray.includes("BULL")) { score += 7; signals.push("RAY_BULL"); } else if (ray.includes("BEAR")) score -= 7;
  score = Math.round(Math.max(-100, Math.min(100, score)));
  const normalizedRole = ["breakout", "preferred", "deep_alternative"].includes(role) ? role : "preferred";
  const thresholds = normalizedRole === "breakout" ? { good: 45, caution: 10 } : normalizedRole === "deep_alternative" ? { good: 0, caution: -35 } : { good: 25, caution: -15 };
  let verdict = score >= thresholds.good ? "GOOD" : score >= thresholds.caution ? "CAUTION" : "NO_ENTRY";
  const confidence = readyWeight >= 0.99 ? "HIGH" : readyWeight >= 0.69 ? "MEDIUM" : readyWeight >= 0.25 ? "LOW" : "WARMING_UP";
  if (confidence === "WARMING_UP" && verdict === "GOOD") verdict = "CAUTION";
  const summary = verdict === "GOOD" ? "Trend context supports this setup role." : verdict === "CAUTION" ? "Mixed or incomplete context; confirmation is discretionary." : "Bearish context for this setup role; arming is higher risk.";
  return { verdict, score, confidence, role: normalizedRole, summary, frames, fast: { price, ema8, ema18, fvvo, slope, rayRegime: ray, signals }, informationOnly: true };
}

module.exports = { recordFiveMinuteBar, assess };
