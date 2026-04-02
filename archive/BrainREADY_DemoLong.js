/**
 * Brain_READYFilter_v4.0-LONG
 *
 * New architecture:
 * - RayAlgo BUY/SELL remains the external trigger
 * - READY is no longer sent from Pine
 * - Brain builds synthetic 3m bars from 15s ticks
 * - Brain evaluates a live long-entry filter at BUY time
 *
 * Goal:
 * - block stale continuation BUYs
 * - allow fresh washout -> reclaim -> bounce BUYs
 *
 * Notes:
 * - This first build focuses on ENTRY architecture
 * - EXIT remains simple: Ray SELL / intent exit_long
 * - You can layer your current fail stop / BE / PL ladder back on top next
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const BRAIN_VERSION = "Brain_READYFilter_v4.0-LONG";

// ========================================
// CONFIG
// ========================================
const PORT = Number(process.env.PORT || 8080);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// 3Commas
const THREECOMMAS_WEBHOOK_URL =
  process.env.THREECOMMAS_WEBHOOK_URL ||
  process.env.C3_WEBHOOK_URL ||
  "https://api.3commas.io/signal_bots/webhooks";

const THREECOMMAS_BOT_UUID =
  process.env.THREECOMMAS_BOT_UUID ||
  process.env.C3_BOT_UUID ||
  "";

const THREECOMMAS_SECRET =
  process.env.THREECOMMAS_SECRET ||
  process.env.C3_SIGNAL_SECRET ||
  process.env.C3_WEBHOOK_SECRET ||
  "";

const THREECOMMAS_MAX_LAG = String(
  process.env.THREECOMMAS_MAX_LAG || process.env.C3_MAX_LAG_SEC || "300"
);

const THREECOMMAS_TIMEOUT_MS = Number(
  process.env.THREECOMMAS_TIMEOUT_MS || process.env.C3_TIMEOUT_MS || "8000"
);

// Tick / bar building
const TICK_EXPECTED_SEC = Number(process.env.TICK_EXPECTED_SEC || "15");
const BAR_TF_SEC = Number(process.env.BAR_TF_SEC || "180"); // 3m
const MAX_BARS = Number(process.env.MAX_BARS || "300");

// Logging
const TICK_LOG_EVERY_MS = Number(process.env.TICK_LOG_EVERY_MS || "180000");
const STATE_LOG_EVERY_MS = Number(process.env.STATE_LOG_EVERY_MS || "180000");
const DEBUG_FILTER = String(process.env.DEBUG_FILTER || "true").toLowerCase() === "true";

// Heartbeat
const REQUIRE_FRESH_HEARTBEAT =
  String(process.env.REQUIRE_FRESH_HEARTBEAT || "true").toLowerCase() === "true";
const HEARTBEAT_MAX_AGE_SEC = Number(process.env.HEARTBEAT_MAX_AGE_SEC || "90");

// Enter dedupe
const ENTER_DEDUP_SEC = Number(process.env.ENTER_DEDUP_SEC || "25");

// Entry filter thresholds
const FILTER_ENABLED =
  String(process.env.FILTER_ENABLED || "true").toLowerCase() === "true";

const FILTER_MIN_BARS = Number(process.env.FILTER_MIN_BARS || "25");
const FILTER_ADX_MIN = Number(process.env.FILTER_ADX_MIN || "14");
const FILTER_RSI_MIN = Number(process.env.FILTER_RSI_MIN || "46");

const FILTER_WASH_LOOKBACK_BARS = Number(process.env.FILTER_WASH_LOOKBACK_BARS || "18");
const FILTER_DROP_LOOKBACK_BARS = Number(process.env.FILTER_DROP_LOOKBACK_BARS || "12");
const FILTER_MAX_BARS_SINCE_LOW = Number(process.env.FILTER_MAX_BARS_SINCE_LOW || "4");

const FILTER_MIN_DROP_PCT = Number(process.env.FILTER_MIN_DROP_PCT || "0.60");
const FILTER_MIN_RECLAIM_FROM_LOW_PCT = Number(
  process.env.FILTER_MIN_RECLAIM_FROM_LOW_PCT || "0.45"
);
const FILTER_MIN_IMPULSE_FROM_LOW_PCT = Number(
  process.env.FILTER_MIN_IMPULSE_FROM_LOW_PCT || "0.55"
);
const FILTER_MIN_BODY_PCT = Number(process.env.FILTER_MIN_BODY_PCT || "0.20");

const FILTER_MAX_ENTRY_EXT_EMA21_PCT = Number(
  process.env.FILTER_MAX_ENTRY_EXT_EMA21_PCT || "0.80"
);
const FILTER_MAX_ENTRY_EXT_EMA18_PCT = Number(
  process.env.FILTER_MAX_ENTRY_EXT_EMA18_PCT || "0.60"
);
const FILTER_MAX_BUY_FROM_RECLAIM_PCT = Number(
  process.env.FILTER_MAX_BUY_FROM_RECLAIM_PCT || "0.40"
);

const FILTER_HOSTILE_MAX_EMA_GAP_PCT = Number(
  process.env.FILTER_HOSTILE_MAX_EMA_GAP_PCT || "0.60"
);
const FILTER_HOSTILE_MAX_NEG_SLOPE_PCT = Number(
  process.env.FILTER_HOSTILE_MAX_NEG_SLOPE_PCT || "0.12"
);
const FILTER_HOSTILE_MAX_MINUS_DI_LEAD = Number(
  process.env.FILTER_HOSTILE_MAX_MINUS_DI_LEAD || "10"
);

// Reclaim freshness
const FILTER_MAX_BARS_SINCE_RECLAIM = Number(
  process.env.FILTER_MAX_BARS_SINCE_RECLAIM || "3"
);

// In-position tracking
const ALLOW_ONLY_ONE_POSITION =
  String(process.env.ALLOW_ONLY_ONE_POSITION || "true").toLowerCase() === "true";

// ========================================
// MEMORY
// ========================================
function createSymbolState(symbol) {
  return {
    symbol,

    lastTickMs: 0,
    lastTickPrice: null,

    lastTickLogMs: 0,
    lastStateLogMs: 0,

    currentBar: null,
    bars: [],

    inPosition: false,
    entryPrice: null,
    entryAtMs: 0,
    lastAction: "none",
    lastEnterAcceptedTs: 0,

    lastEval: null,
  };
}

const symbolState = new Map();

function getState(symbol) {
  if (!symbolState.has(symbol)) {
    symbolState.set(symbol, createSymbolState(symbol));
  }
  return symbolState.get(symbol);
}

// ========================================
// HELPERS
// ========================================
const nowMs = () => Date.now();

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function logWebhook(payload) {
  const intent = normalizeIntent(payload);
  if (intent === "tick") return;
  console.log("==== NEW WEBHOOK ====");
  console.log(payload);
}

function checkSecret(payload) {
  if (!WEBHOOK_SECRET) return true;
  const s =
    payload?.secret ??
    payload?.tv_secret ??
    payload?.token ??
    payload?.passphrase ??
    "";
  return String(s) === String(WEBHOOK_SECRET);
}

function normalizeIntent(payload) {
  const a = payload?.action ? String(payload.action).toLowerCase() : "";
  const i = payload?.intent ? String(payload.intent).toLowerCase() : "";
  const s = payload?.src ? String(payload.src).toLowerCase() : "";
  if (a) return a;
  if (i) return i;
  if (s && s !== "ray") return s;
  return "";
}

function parseSymbol(symbolStr) {
  const s = String(symbolStr || "");
  if (!s) return { symbol: "", ex: "", ins: "" };
  if (s.includes(":")) {
    const [ex, ins] = s.split(":");
    return { symbol: `${ex}:${ins}`, ex: ex || "", ins: ins || "" };
  }
  return { symbol: s, ex: "", ins: s };
}

function getSymbolFromPayload(payload) {
  if (payload?.symbol) return parseSymbol(payload.symbol).symbol;
  if (payload?.tv_exchange && payload?.tv_instrument) {
    return parseSymbol(`${payload.tv_exchange}:${payload.tv_instrument}`).symbol;
  }
  if (payload?.exchange && payload?.ticker) {
    return parseSymbol(`${payload.exchange}:${payload.ticker}`).symbol;
  }
  return "";
}

function deriveTvFromSymbol(sym) {
  const { ex, ins } = parseSymbol(sym);
  return { tv_exchange: ex || "", tv_instrument: ins || "" };
}

function getTickPrice(payload) {
  return toNum(payload?.price) ?? toNum(payload?.close) ?? null;
}

function getRayPrice(payload) {
  return toNum(payload?.price) ?? toNum(payload?.close) ?? toNum(payload?.trigger_price) ?? null;
}

function isHeartbeatFresh(s) {
  if (!REQUIRE_FRESH_HEARTBEAT) return true;
  if (!s.lastTickMs) return false;
  return nowMs() - s.lastTickMs <= HEARTBEAT_MAX_AGE_SEC * 1000;
}

function pctDiff(a, b) {
  if (!Number.isFinite(a) || a === 0 || !Number.isFinite(b)) return null;
  return (Math.abs(b - a) / Math.abs(a)) * 100.0;
}

function pctProfit(entry, current) {
  if (!Number.isFinite(entry) || entry === 0 || !Number.isFinite(current)) return null;
  return ((current - entry) / entry) * 100.0;
}

function enterDedupeActive(s, ts) {
  if (!ENTER_DEDUP_SEC || ENTER_DEDUP_SEC <= 0) return false;
  return s.lastEnterAcceptedTs && ts - s.lastEnterAcceptedTs < ENTER_DEDUP_SEC * 1000;
}

function floorToTfMs(tsMs, tfSec) {
  const tfMs = tfSec * 1000;
  return Math.floor(tsMs / tfMs) * tfMs;
}

function maybeLogTick(s, isoTime) {
  const now = nowMs();
  if (!TICK_LOG_EVERY_MS || TICK_LOG_EVERY_MS <= 0) return;
  if (!s.lastTickLogMs || now - s.lastTickLogMs >= TICK_LOG_EVERY_MS) {
    console.log(`🟦 TICK(15s) ${s.symbol} price=${s.lastTickPrice} time=${isoTime}`);
    s.lastTickLogMs = now;
  }
}

function maybeLogState(s) {
  const now = nowMs();
  if (!STATE_LOG_EVERY_MS || STATE_LOG_EVERY_MS <= 0) return;
  if (!s.lastStateLogMs || now - s.lastStateLogMs >= STATE_LOG_EVERY_MS) {
    const e = s.lastEval;
    const reasons = e?.reasons?.length ? e.reasons.join(",") : "na";
    console.log(
      `📌 STATE ${s.symbol} inPos=${s.inPosition ? 1 : 0} bars=${s.bars.length} price=${s.lastTickPrice ?? "na"} allow=${e?.allow ? 1 : 0} reg=${e?.regime || "na"} reclaimAge=${e?.reclaimAgeBars ?? "na"} ext21=${e?.entryExtEma21Pct != null ? e.entryExtEma21Pct.toFixed(3) : "na"} hostile=${e?.hostileBear ? 1 : 0} reasons=${reasons} lastAction=${s.lastAction}`
    );
    s.lastStateLogMs = now;
  }
}

// ========================================
// 3M BAR BUILDER FROM 15S TICKS
// ========================================
function pushTickToBars(s, price, tsMs) {
  const bucketMs = floorToTfMs(tsMs, BAR_TF_SEC);

  if (!s.currentBar || s.currentBar.t !== bucketMs) {
    if (s.currentBar) {
      s.bars.push(s.currentBar);
      if (s.bars.length > MAX_BARS) s.bars.shift();
    }
    s.currentBar = {
      t: bucketMs,
      o: price,
      h: price,
      l: price,
      c: price,
    };
  } else {
    s.currentBar.h = Math.max(s.currentBar.h, price);
    s.currentBar.l = Math.min(s.currentBar.l, price);
    s.currentBar.c = price;
  }
}

function getBarsForCalc(s) {
  const out = s.bars.slice();
  if (s.currentBar) out.push(s.currentBar);
  return out;
}

// ========================================
// INDICATOR HELPERS
// ========================================
function emaSeries(values, len) {
  if (!values.length) return [];
  const alpha = 2 / (len + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(alpha * values[i] + (1 - alpha) * out[i - 1]);
  }
  return out;
}

function smaLast(values, len) {
  if (values.length < len) return null;
  let sum = 0;
  for (let i = values.length - len; i < values.length; i++) sum += values[i];
  return sum / len;
}

function rsiSeries(values, len) {
  if (values.length < len + 1) return [];
  const gains = [];
  const losses = [];
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < len; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= len;
  avgLoss /= len;

  const out = [null];
  for (let i = 1; i < len; i++) out.push(null);

  const firstRs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  out.push(100 - 100 / (1 + firstRs));

  for (let i = len; i < gains.length; i++) {
    avgGain = (avgGain * (len - 1) + gains[i]) / len;
    avgLoss = (avgLoss * (len - 1) + losses[i]) / len;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out.push(100 - 100 / (1 + rs));
  }
  return out;
}

function adxSeries(bars, len) {
  if (bars.length < len + 2) return { adx: [], plusDI: [], minusDI: [] };

  const tr = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h;
    const l = bars[i].l;
    const pc = bars[i - 1].c;
    const upMove = h - bars[i - 1].h;
    const downMove = bars[i - 1].l - l;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(h - l, Math.max(Math.abs(h - pc), Math.abs(l - pc))));
  }

  function rma(vals, rmaLen) {
    if (vals.length < rmaLen) return [];
    let seed = 0;
    for (let i = 0; i < rmaLen; i++) seed += vals[i];
    seed /= rmaLen;
    const out = [];
    for (let i = 0; i < rmaLen - 1; i++) out.push(null);
    out.push(seed);
    for (let i = rmaLen; i < vals.length; i++) {
      out.push((out[out.length - 1] * (rmaLen - 1) + vals[i]) / rmaLen);
    }
    return out;
  }

  const trRma = rma(tr, len);
  const plusRma = rma(plusDM, len);
  const minusRma = rma(minusDM, len);

  const plusDI = [];
  const minusDI = [];
  const dx = [];

  for (let i = 0; i < tr.length; i++) {
    const atr = trRma[i];
    if (!Number.isFinite(atr) || atr === 0) {
      plusDI.push(null);
      minusDI.push(null);
      dx.push(null);
      continue;
    }
    const pdi = (100 * plusRma[i]) / atr;
    const mdi = (100 * minusRma[i]) / atr;
    plusDI.push(pdi);
    minusDI.push(mdi);
    const denom = pdi + mdi;
    dx.push(denom > 0 ? (100 * Math.abs(pdi - mdi)) / denom : 0);
  }

  const adx = rma(dx.filter((x) => Number.isFinite(x)), len);
  const fullAdx = new Array(dx.length).fill(null);
  let k = 0;
  for (let i = 0; i < dx.length; i++) {
    if (Number.isFinite(dx[i])) {
      fullAdx[i] = adx[k] ?? null;
      k++;
    }
  }

  // align to bars length
  return {
    adx: [null, ...fullAdx],
    plusDI: [null, ...plusDI],
    minusDI: [null, ...minusDI],
  };
}

function wtSeries(bars, n1, n2, sigLen) {
  const ap = bars.map((b) => (b.h + b.l + b.c) / 3);
  const esa = emaSeries(ap, n1);
  const absDev = ap.map((v, i) => Math.abs(v - esa[i]));
  const de = emaSeries(absDev, n1);
  const ci = ap.map((v, i) => {
    const d = de[i];
    return d && d !== 0 ? (v - esa[i]) / (0.015 * d) : 0;
  });
  const fwo = emaSeries(ci, n2);
  const fwoSignal = [];
  for (let i = 0; i < fwo.length; i++) {
    if (i + 1 < sigLen) fwoSignal.push(null);
    else {
      let sum = 0;
      for (let j = i - sigLen + 1; j <= i; j++) sum += fwo[j];
      fwoSignal.push(sum / sigLen);
    }
  }
  return { fwo, fwoSignal };
}

function barsSinceLowestLow(bars, lookback) {
  const start = Math.max(0, bars.length - lookback);
  let idx = start;
  let low = bars[start].l;
  for (let i = start + 1; i < bars.length; i++) {
    if (bars[i].l <= low) {
      low = bars[i].l;
      idx = i;
    }
  }
  return { low, barsSince: bars.length - 1 - idx, index: idx };
}

function highestClose(bars, lookback) {
  const start = Math.max(0, bars.length - lookback);
  let v = bars[start].c;
  for (let i = start + 1; i < bars.length; i++) v = Math.max(v, bars[i].c);
  return v;
}

function highestStretchBelowEma(bars, ema21, lookback) {
  const start = Math.max(0, bars.length - lookback);
  let maxStretch = 0;
  for (let i = start; i < bars.length; i++) {
    const e = ema21[i];
    if (Number.isFinite(e) && e > 0) {
      maxStretch = Math.max(maxStretch, ((e - bars[i].l) / e) * 100);
    }
  }
  return maxStretch;
}

function highestBelowStreak(bars, ema21, lookback) {
  const start = Math.max(0, bars.length - lookback);
  let streak = 0;
  let maxStreak = 0;
  for (let i = start; i < bars.length; i++) {
    if (bars[i].c < ema21[i]) {
      streak += 1;
      maxStreak = Math.max(maxStreak, streak);
    } else {
      streak = 0;
    }
  }
  return maxStreak;
}

function findRecentReclaimBar(bars, ema21, maxBarsSinceReclaim) {
  for (let i = bars.length - 1; i >= 1; i--) {
    const crossed = bars[i - 1].c <= ema21[i - 1] && bars[i].c > ema21[i];
    if (crossed) {
      const age = bars.length - 1 - i;
      if (age <= maxBarsSinceReclaim) {
        return { index: i, ageBars: age, reclaimPrice: bars[i].c, reclaimLow: bars[i].l };
      }
      return null;
    }
  }
  return null;
}

// ========================================
// FILTER EVALUATION
// ========================================
function evaluateLongFilter(s) {
  const bars = getBarsForCalc(s);
  const reasons = [];

  if (!FILTER_ENABLED) {
    return {
      allow: true,
      reasons,
      barsCount: bars.length,
      regime: "na",
      hostileBear: false,
    };
  }

  if (bars.length < FILTER_MIN_BARS) {
    reasons.push("not_enough_bars");
    return {
      allow: false,
      reasons,
      barsCount: bars.length,
      regime: "na",
      hostileBear: false,
    };
  }

  const closes = bars.map((b) => b.c);
  const opens = bars.map((b) => b.o);

  const ema8 = emaSeries(closes, 8);
  const ema18 = emaSeries(closes, 18);
  const ema21 = emaSeries(closes, 21);
  const rsi = rsiSeries(closes, 14);
  const rsiMA = [];
  for (let i = 0; i < rsi.length; i++) {
    if (i < 4 || !Number.isFinite(rsi[i])) rsiMA.push(null);
    else {
      let sum = 0;
      let ok = true;
      for (let j = i - 4; j <= i; j++) {
        if (!Number.isFinite(rsi[j])) {
          ok = false;
          break;
        }
        sum += rsi[j];
      }
      rsiMA.push(ok ? sum / 5 : null);
    }
  }

  const { adx, plusDI, minusDI } = adxSeries(bars, 14);
  const { fwo, fwoSignal } = wtSeries(bars, 10, 21, 4);

  const i = bars.length - 1;
  const bar = bars[i];
  const prev = bars[i - 1];

  const rsiNow = rsi[i];
  const rsiPrev = rsi[i - 1];
  const rsiMaNow = rsiMA[i];

  const adxNow = adx[i];
  const plusDINow = plusDI[i];
  const minusDINow = minusDI[i];

  const ema8Now = ema8[i];
  const ema18Now = ema18[i];
  const ema21Now = ema21[i];
  const ema21Prev = ema21[i - 1];

  const fwoNow = fwo[i];
  const fwoPrev = fwo[i - 1];
  const fwoSigNow = fwoSignal[i];

  const reg = "RANGE"; // entry filter is tailored mainly for reversal/range-to-early-trend

  // 1) Damage / washout
  const lowInfo = barsSinceLowestLow(bars, FILTER_WASH_LOOKBACK_BARS);
  const recentLow = lowInfo.low;
  const barsSinceLow = lowInfo.barsSince;
  const recentHigh = highestClose(bars, FILTER_DROP_LOOKBACK_BARS);
  const dropPct = recentHigh > 0 ? ((recentHigh - bar.c) / recentHigh) * 100 : 0;
  const maxStretchBelow = highestStretchBelowEma(bars, ema21, FILTER_WASH_LOOKBACK_BARS);
  const maxBelowStreak = highestBelowStreak(bars, ema21, FILTER_WASH_LOOKBACK_BARS);

  const hadDamage =
    dropPct >= FILTER_MIN_DROP_PCT ||
    maxStretchBelow >= FILTER_MIN_DROP_PCT ||
    maxBelowStreak >= 3;

  if (!hadDamage) reasons.push("no_recent_damage");
  if (barsSinceLow > FILTER_MAX_BARS_SINCE_LOW) reasons.push("low_too_old");

  // 2) Reclaim freshness
  const reclaim = findRecentReclaimBar(bars, ema21, FILTER_MAX_BARS_SINCE_RECLAIM);
  if (!reclaim) reasons.push("no_fresh_reclaim");

  const reclaimAgeBars = reclaim ? reclaim.ageBars : null;
  const reclaimPrice = reclaim ? reclaim.reclaimPrice : null;
  const reclaimFromLowPct =
    Number.isFinite(recentLow) && recentLow > 0 ? ((bar.c - recentLow) / recentLow) * 100 : null;
  const impulseFromLowPct =
    Number.isFinite(recentLow) && recentLow > 0 ? ((bar.h - recentLow) / recentLow) * 100 : null;
  const bodyPct =
    bar.o > 0 ? (Math.abs(bar.c - bar.o) / bar.o) * 100 : null;

  if (!(reclaimFromLowPct >= FILTER_MIN_RECLAIM_FROM_LOW_PCT)) {
    reasons.push("weak_reclaim_from_low");
  }
  if (!(impulseFromLowPct >= FILTER_MIN_IMPULSE_FROM_LOW_PCT)) {
    reasons.push("weak_impulse_from_low");
  }
  if (!(bodyPct >= FILTER_MIN_BODY_PCT)) {
    reasons.push("weak_body");
  }

  // 3) Recovery quality
  if (!(bar.c > ema18Now && bar.c > ema21Now)) reasons.push("not_above_ema18_21");
  if (!(rsiNow >= FILTER_RSI_MIN)) reasons.push("rsi_too_low");
  if (!(Number.isFinite(rsiPrev) && rsiNow > rsiPrev)) reasons.push("rsi_not_rising");
  if (!(Number.isFinite(rsiMaNow) && rsiNow > rsiMaNow)) reasons.push("rsi_not_above_ma");
  if (!(Number.isFinite(fwoSigNow) && fwoNow > fwoSigNow)) reasons.push("fwo_not_recovered");
  if (!(Number.isFinite(fwoPrev) && fwoNow > fwoPrev)) reasons.push("fwo_not_rising");
  if (!(bar.c > bar.o)) reasons.push("not_bull_candle");
  if (!(adxNow >= FILTER_ADX_MIN)) reasons.push("adx_too_low");
  if (!(ema8Now > ema8[i - 1])) reasons.push("ema8_not_rising");

  // 4) Hostility
  const emaGapPct = ema21Now > 0 ? ((ema21Now - ema8Now) / ema21Now) * 100 : 0;
  const ema21SlopePct =
    Number.isFinite(ema21Prev) && ema21Prev > 0 ? ((ema21Now - ema21Prev) / ema21Prev) * 100 : 0;
  const minusLead =
    Number.isFinite(minusDINow) && Number.isFinite(plusDINow) ? minusDINow - plusDINow : 0;

  const hostileBear =
    emaGapPct > FILTER_HOSTILE_MAX_EMA_GAP_PCT ||
    ema21SlopePct < -FILTER_HOSTILE_MAX_NEG_SLOPE_PCT ||
    minusLead > FILTER_HOSTILE_MAX_MINUS_DI_LEAD;

  if (hostileBear) reasons.push("hostile_bear");

  // 5) Extension / stale continuation protection
  const entryExtEma21Pct = ema21Now > 0 ? ((bar.c - ema21Now) / ema21Now) * 100 : null;
  const entryExtEma18Pct = ema18Now > 0 ? ((bar.c - ema18Now) / ema18Now) * 100 : null;
  const buyFromReclaimPct =
    Number.isFinite(reclaimPrice) && reclaimPrice > 0 ? ((bar.c - reclaimPrice) / reclaimPrice) * 100 : null;

  if (!(entryExtEma21Pct <= FILTER_MAX_ENTRY_EXT_EMA21_PCT)) reasons.push("too_extended_ema21");
  if (!(entryExtEma18Pct <= FILTER_MAX_ENTRY_EXT_EMA18_PCT)) reasons.push("too_extended_ema18");
  if (!(buyFromReclaimPct == null || buyFromReclaimPct <= FILTER_MAX_BUY_FROM_RECLAIM_PCT)) {
    reasons.push("too_far_from_reclaim");
  }

  // 6) Fresh low should precede reclaim
  if (reclaim && lowInfo.index > reclaim.index) {
    reasons.push("fresh_low_after_reclaim");
  }

  const allow = reasons.length === 0;

  return {
    allow,
    reasons,
    regime: reg,

    barsCount: bars.length,

    recentLow,
    barsSinceLow,
    recentHigh,
    dropPct,
    maxStretchBelow,
    maxBelowStreak,

    reclaimAgeBars,
    reclaimPrice,
    reclaimFromLowPct,
    impulseFromLowPct,
    bodyPct,

    rsi: rsiNow,
    rsiMa: rsiMaNow,
    adx: adxNow,
    plusDI: plusDINow,
    minusDI: minusDINow,

    ema8: ema8Now,
    ema18: ema18Now,
    ema21: ema21Now,
    emaGapPct,
    ema21SlopePct,
    minusLead,
    hostileBear,

    entryExtEma21Pct,
    entryExtEma18Pct,
    buyFromReclaimPct,
  };
}

// ========================================
// 3COMMAS POST
// ========================================
async function postTo3Commas(action, payload) {
  if (!THREECOMMAS_BOT_UUID || !THREECOMMAS_SECRET) {
    console.log("⚠️ 3Commas not configured (missing BOT_UUID/SECRET) — skipping");
    return { skipped: true };
  }

  const sym = getSymbolFromPayload(payload);
  const derived = deriveTvFromSymbol(sym);

  const body = {
    secret: THREECOMMAS_SECRET,
    max_lag: THREECOMMAS_MAX_LAG,
    timestamp: payload?.timestamp ?? payload?.time ?? new Date().toISOString(),
    trigger_price: String(
      toNum(payload?.trigger_price) ??
      toNum(payload?.price) ??
      toNum(payload?.close) ??
      ""
    ),
    tv_exchange: String(payload?.tv_exchange ?? payload?.exchange ?? derived.tv_exchange ?? ""),
    tv_instrument: String(payload?.tv_instrument ?? payload?.ticker ?? derived.tv_instrument ?? ""),
    action,
    bot_uuid: THREECOMMAS_BOT_UUID,
  };

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), THREECOMMAS_TIMEOUT_MS);

  try {
    const resp = await fetch(THREECOMMAS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await resp.text();
    console.log(`📨 3Commas POST -> ${action} | status=${resp.status} | resp=${text || ""}`);
    return { ok: resp.ok, status: resp.status, resp: text };
  } catch (e) {
    console.log("⛔ 3Commas POST failed:", e?.name === "AbortError" ? "timeout" : e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// ========================================
// HANDLERS
// ========================================
async function handleTick(payload, res) {
  const symbol = getSymbolFromPayload(payload);
  const price = getTickPrice(payload);
  const tsMs = payload?.time ? new Date(payload.time).getTime() : nowMs();

  if (!symbol || !Number.isFinite(price)) {
    return res.json({ ok: true, tick: true, ignored: "missing_fields" });
  }

  const s = getState(symbol);
  s.lastTickMs = nowMs();
  s.lastTickPrice = price;

  pushTickToBars(s, price, tsMs);

  maybeLogTick(s, payload?.time ?? new Date(tsMs).toISOString());

  s.lastEval = evaluateLongFilter(s);

  maybeLogState(s);

  return res.json({
    ok: true,
    tick: true,
    symbol,
    price,
    bars: getBarsForCalc(s).length,
    filter: s.lastEval,
  });
}

async function handleEnterLong(payload, res, sourceTag) {
  const symbol = getSymbolFromPayload(payload);
  const price = getRayPrice(payload);
  const ts = nowMs();

  if (!symbol || !Number.isFinite(price)) {
    return res.json({ ok: false, blocked: "missing_price_or_symbol" });
  }

  const s = getState(symbol);

  if (!isHeartbeatFresh(s)) {
    s.lastAction = "enter_long_blocked_stale_heartbeat";
    return res.json({ ok: false, blocked: "stale_heartbeat" });
  }

  if (ALLOW_ONLY_ONE_POSITION && s.inPosition) {
    s.lastAction = "enter_long_blocked_in_position";
    return res.json({ ok: false, blocked: "already_in_position" });
  }

  if (enterDedupeActive(s, ts)) {
    s.lastAction = "enter_long_deduped";
    return res.json({ ok: true, ignored: "enter_dedup", window_sec: ENTER_DEDUP_SEC });
  }

  const evalResult = evaluateLongFilter(s);
  s.lastEval = evalResult;

  if (!evalResult.allow) {
    s.lastAction = "enter_long_blocked_filter";
    if (DEBUG_FILTER) {
      console.log(
        `⛔ BUY BLOCKED | symbol=${symbol} price=${price} | reasons=${evalResult.reasons.join(",")}`
      );
    }
    return res.json({
      ok: false,
      blocked: "filter_blocked",
      reasons: evalResult.reasons,
      filter: evalResult,
    });
  }

  s.inPosition = true;
  s.entryPrice = price;
  s.entryAtMs = ts;
  s.lastEnterAcceptedTs = ts;
  s.lastAction = "enter_long";

  console.log(
    `🚀 ENTER LONG (${sourceTag}) | symbol=${symbol} price=${price} reclaimAge=${evalResult.reclaimAgeBars} ext21=${evalResult.entryExtEma21Pct?.toFixed(3)}%`
  );

  const fwd = await postTo3Commas("enter_long", {
    ...payload,
    symbol,
    price,
  });

  return res.json({
    ok: true,
    action: "enter_long",
    source: sourceTag,
    filter: evalResult,
    threecommas: fwd,
  });
}

async function handleExitLong(payload, res, sourceTag) {
  const symbol = getSymbolFromPayload(payload);
  const price = getRayPrice(payload);

  if (!symbol) {
    return res.json({ ok: false, blocked: "missing_symbol" });
  }

  const s = getState(symbol);

  if (!s.inPosition) {
    s.lastAction = "exit_long_no_position";
    return res.json({ ok: false, blocked: "no_position" });
  }

  s.inPosition = false;
  s.entryPrice = null;
  s.entryAtMs = 0;
  s.lastAction = "exit_long";

  console.log(`✅ EXIT LONG (${sourceTag}) | symbol=${symbol} price=${price ?? "na"}`);

  const fwd = await postTo3Commas("exit_long", {
    ...payload,
    symbol,
    price: price ?? s.lastTickPrice,
  });

  return res.json({
    ok: true,
    action: "exit_long",
    source: sourceTag,
    threecommas: fwd,
  });
}

// ========================================
// STATUS
// ========================================
app.get("/", (_req, res) => {
  const out = {};
  for (const [sym, s] of symbolState.entries()) {
    out[sym] = {
      inPosition: s.inPosition,
      entryPrice: s.entryPrice,
      lastTickPrice: s.lastTickPrice,
      bars: getBarsForCalc(s).length,
      lastAction: s.lastAction,
      lastEval: s.lastEval,
    };
  }
  res.json({
    brain: BRAIN_VERSION,
    symbols: out,
  });
});

app.get("/status", (_req, res) => {
  const out = {};
  for (const [sym, s] of symbolState.entries()) {
    out[sym] = {
      inPosition: s.inPosition,
      entryPrice: s.entryPrice,
      lastTickPrice: s.lastTickPrice,
      bars: getBarsForCalc(s).length,
      lastAction: s.lastAction,
      lastEval: s.lastEval,
    };
  }
  res.json({
    brain: BRAIN_VERSION,
    symbols: out,
  });
});

// ========================================
// WEBHOOK
// ========================================
app.post("/webhook", async (req, res) => {
  const payload = req.body || {};
  logWebhook(payload);

  if (!checkSecret(payload)) {
    console.log("⛔ Secret mismatch - blocked");
    return res.status(401).json({ ok: false, error: "secret_mismatch" });
  }

  const intent = normalizeIntent(payload);

  if (intent === "tick") return handleTick(payload, res);

  if (intent === "enter_long") return handleEnterLong(payload, res, "intent_enter_long");
  if (intent === "exit_long") return handleExitLong(payload, res, "intent_exit_long");

  if (String(payload?.src || "").toLowerCase() === "ray") {
    const side = String(payload?.side || "").toUpperCase();
    if (side === "BUY") return handleEnterLong(payload, res, "ray_side_buy");
    if (side === "SELL") return handleExitLong(payload, res, "ray_side_sell");
    return res.json({ ok: true, note: "ray_unknown_side" });
  }

  return res.json({ ok: true, note: "unknown" });
});

// ========================================
// START
// ========================================
app.listen(PORT, () => {
  console.log(`✅ Brain ${BRAIN_VERSION} listening on port ${PORT}`);
  console.log(`Heartbeat: REQUIRE_FRESH_HEARTBEAT=${REQUIRE_FRESH_HEARTBEAT} | HEARTBEAT_MAX_AGE_SEC=${HEARTBEAT_MAX_AGE_SEC}`);
  console.log(`Bars: BAR_TF_SEC=${BAR_TF_SEC} | MAX_BARS=${MAX_BARS}`);
  console.log(`Filter: ENABLED=${FILTER_ENABLED} | MIN_BARS=${FILTER_MIN_BARS} | ADX_MIN=${FILTER_ADX_MIN} | RSI_MIN=${FILTER_RSI_MIN}`);
  console.log(`Damage: washLookback=${FILTER_WASH_LOOKBACK_BARS} | dropLookback=${FILTER_DROP_LOOKBACK_BARS} | maxBarsSinceLow=${FILTER_MAX_BARS_SINCE_LOW} | minDropPct=${FILTER_MIN_DROP_PCT}`);
  console.log(`Reclaim: minReclaimFromLow=${FILTER_MIN_RECLAIM_FROM_LOW_PCT}% | minImpulseFromLow=${FILTER_MIN_IMPULSE_FROM_LOW_PCT}% | minBody=${FILTER_MIN_BODY_PCT}% | maxBarsSinceReclaim=${FILTER_MAX_BARS_SINCE_RECLAIM}`);
  console.log(`Extension: maxExt21=${FILTER_MAX_ENTRY_EXT_EMA21_PCT}% | maxExt18=${FILTER_MAX_ENTRY_EXT_EMA18_PCT}% | maxBuyFromReclaim=${FILTER_MAX_BUY_FROM_RECLAIM_PCT}%`);
  console.log(`Hostility: maxEmaGap=${FILTER_HOSTILE_MAX_EMA_GAP_PCT}% | maxNegSlope=${FILTER_HOSTILE_MAX_NEG_SLOPE_PCT}% | maxMinusLead=${FILTER_HOSTILE_MAX_MINUS_DI_LEAD}`);
  console.log(`3Commas: URL=${THREECOMMAS_WEBHOOK_URL} | BOT_UUID=${THREECOMMAS_BOT_UUID ? "(set)" : "(missing)"} | SECRET=${THREECOMMAS_SECRET ? "(set)" : "(missing)"}`);
});
