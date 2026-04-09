/**
 * Brain_READYFilter_v4.6-LONG
 *
 * Architecture:
 * - RayAlgo BUY/SELL remains the external trigger
 * - Brain builds synthetic 3m bars from 15s ticks
 * - Brain evaluates BUY quality at the exact BUY moment
 * - Brain blocks unwanted BUYs and forwards only approved BUYs to 3Commas
 *
 * v4.6:
 * - preserves v4.5 internal exit stack
 * - preserves all prior entry modes:
 *   1) reversal_reclaim
 *   2) early_breakout_launch
 *   3) breakout_continuation
 *   4) hold_continuation
 * - adds new entry mode:
 *   5) trend_momentum_continuation
 *
 * Main goal of trend_momentum_continuation:
 * - catch Ray BUYs that arrive after the initial reclaim
 * - allow strong post-reclaim trend continuation
 * - avoid loosening reversal / reclaim logic globally
 *
 * Notes:
 * - this mode does NOT require recent reclaim
 * - this mode does NOT require recent damage
 * - this mode still requires:
 *   - strong RSI
 *   - healthy ADX
 *   - bullish structure above EMA18/EMA21
 *   - positive EMA21 slope
 *   - breakout/hold continuation flag
 *   - controlled extension
 *   - non-hostile structure
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const BRAIN_VERSION = "Brain_READYFilter_v4.6-LONG";

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
const BAR_TF_SEC = Number(process.env.BAR_TF_SEC || "180");
const MAX_BARS = Number(process.env.MAX_BARS || "300");

// Logging
const TICK_LOG_EVERY_MS = Number(process.env.TICK_LOG_EVERY_MS || "180000");
const STATE_LOG_EVERY_MS = Number(process.env.STATE_LOG_EVERY_MS || "180000");
const DEBUG_FILTER =
  String(process.env.DEBUG_FILTER || "true").toLowerCase() === "true";

// Heartbeat
const REQUIRE_FRESH_HEARTBEAT =
  String(process.env.REQUIRE_FRESH_HEARTBEAT || "true").toLowerCase() ===
  "true";
const HEARTBEAT_MAX_AGE_SEC = Number(
  process.env.HEARTBEAT_MAX_AGE_SEC || "90"
);

// Enter dedupe
const ENTER_DEDUP_SEC = Number(process.env.ENTER_DEDUP_SEC || "25");

// Filter base thresholds
const FILTER_ENABLED =
  String(process.env.FILTER_ENABLED || "true").toLowerCase() === "true";

const FILTER_MIN_BARS = Number(process.env.FILTER_MIN_BARS || "12");
const FILTER_ADX_MIN = Number(process.env.FILTER_ADX_MIN || "14");
const FILTER_RSI_MIN = Number(process.env.FILTER_RSI_MIN || "46");

const FILTER_WASH_LOOKBACK_BARS = Number(
  process.env.FILTER_WASH_LOOKBACK_BARS || "18"
);
const FILTER_DROP_LOOKBACK_BARS = Number(
  process.env.FILTER_DROP_LOOKBACK_BARS || "12"
);
const FILTER_MAX_BARS_SINCE_LOW = Number(
  process.env.FILTER_MAX_BARS_SINCE_LOW || "4"
);
const FILTER_MAX_BARS_SINCE_RECLAIM = Number(
  process.env.FILTER_MAX_BARS_SINCE_RECLAIM || "3"
);

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

// Breakout continuation mode
const FILTER_BREAKOUT_ENABLED =
  String(process.env.FILTER_BREAKOUT_ENABLED || "true").toLowerCase() ===
  "true";

const FILTER_BREAKOUT_MAX_BARS_SINCE_RECLAIM = Number(
  process.env.FILTER_BREAKOUT_MAX_BARS_SINCE_RECLAIM || "8"
);
const FILTER_BREAKOUT_MAX_BUY_FROM_RECLAIM_PCT = Number(
  process.env.FILTER_BREAKOUT_MAX_BUY_FROM_RECLAIM_PCT || "0.80"
);
const FILTER_BREAKOUT_MAX_ENTRY_EXT_EMA18_PCT = Number(
  process.env.FILTER_BREAKOUT_MAX_ENTRY_EXT_EMA18_PCT || "1.10"
);
const FILTER_BREAKOUT_MAX_ENTRY_EXT_EMA21_PCT = Number(
  process.env.FILTER_BREAKOUT_MAX_ENTRY_EXT_EMA21_PCT || "1.25"
);
const FILTER_BREAKOUT_MIN_RSI = Number(
  process.env.FILTER_BREAKOUT_MIN_RSI || "44"
);
const FILTER_BREAKOUT_MIN_ADX = Number(
  process.env.FILTER_BREAKOUT_MIN_ADX || "6"
);
const FILTER_BREAKOUT_REQUIRE_BULL_CANDLE =
  String(
    process.env.FILTER_BREAKOUT_REQUIRE_BULL_CANDLE || "false"
  ).toLowerCase() === "true";
const FILTER_BREAKOUT_MIN_CLOSE_OVER_RECLAIM_PCT = Number(
  process.env.FILTER_BREAKOUT_MIN_CLOSE_OVER_RECLAIM_PCT || "0.00"
);

// Hold continuation mode
const FILTER_HOLD_ENABLED =
  String(process.env.FILTER_HOLD_ENABLED || "true").toLowerCase() === "true";
const FILTER_HOLD_MIN_RSI = Number(process.env.FILTER_HOLD_MIN_RSI || "42");
const FILTER_HOLD_MIN_ADX = Number(process.env.FILTER_HOLD_MIN_ADX || "0");
const FILTER_HOLD_MAX_ENTRY_EXT_EMA18_PCT = Number(
  process.env.FILTER_HOLD_MAX_ENTRY_EXT_EMA18_PCT || "1.20"
);
const FILTER_HOLD_MAX_ENTRY_EXT_EMA21_PCT = Number(
  process.env.FILTER_HOLD_MAX_ENTRY_EXT_EMA21_PCT || "1.40"
);
const FILTER_HOLD_REQUIRE_BULL_CANDLE =
  String(process.env.FILTER_HOLD_REQUIRE_BULL_CANDLE || "false").toLowerCase() ===
  "true";
const FILTER_HOLD_REQUIRE_RSI_RISING =
  String(process.env.FILTER_HOLD_REQUIRE_RSI_RISING || "false").toLowerCase() ===
  "true";
const FILTER_HOLD_REQUIRE_FWO_RECOVERED =
  String(
    process.env.FILTER_HOLD_REQUIRE_FWO_RECOVERED || "false"
  ).toLowerCase() === "true";
const FILTER_HOLD_REQUIRE_EMA8_RISING =
  String(process.env.FILTER_HOLD_REQUIRE_EMA8_RISING || "false").toLowerCase() ===
  "true";
const FILTER_HOLD_RECENT_RECLAIM_LOOKBACK = Number(
  process.env.FILTER_HOLD_RECENT_RECLAIM_LOOKBACK || "8"
);
const FILTER_HOLD_REQUIRE_RECENT_RECLAIM =
  String(
    process.env.FILTER_HOLD_REQUIRE_RECENT_RECLAIM || "true"
  ).toLowerCase() === "true";

// Early breakout launch mode
const FILTER_EARLY_BREAKOUT_ENABLED =
  String(process.env.FILTER_EARLY_BREAKOUT_ENABLED || "true").toLowerCase() ===
  "true";
const FILTER_EARLY_BREAKOUT_MAX_BARS_SINCE_RECLAIM = Number(
  process.env.FILTER_EARLY_BREAKOUT_MAX_BARS_SINCE_RECLAIM || "2"
);
const FILTER_EARLY_BREAKOUT_MIN_RSI = Number(
  process.env.FILTER_EARLY_BREAKOUT_MIN_RSI || "48"
);
const FILTER_EARLY_BREAKOUT_MIN_ADX = Number(
  process.env.FILTER_EARLY_BREAKOUT_MIN_ADX || "0"
);
const FILTER_EARLY_BREAKOUT_MAX_ENTRY_EXT_EMA18_PCT = Number(
  process.env.FILTER_EARLY_BREAKOUT_MAX_ENTRY_EXT_EMA18_PCT || "0.20"
);
const FILTER_EARLY_BREAKOUT_MAX_ENTRY_EXT_EMA21_PCT = Number(
  process.env.FILTER_EARLY_BREAKOUT_MAX_ENTRY_EXT_EMA21_PCT || "0.20"
);
const FILTER_EARLY_BREAKOUT_MAX_BUY_FROM_RECLAIM_PCT = Number(
  process.env.FILTER_EARLY_BREAKOUT_MAX_BUY_FROM_RECLAIM_PCT || "0.35"
);
const FILTER_EARLY_BREAKOUT_MIN_CLOSE_OVER_RECLAIM_PCT = Number(
  process.env.FILTER_EARLY_BREAKOUT_MIN_CLOSE_OVER_RECLAIM_PCT || "0.00"
);
const FILTER_EARLY_BREAKOUT_REQUIRE_BREAK_FLAG =
  String(
    process.env.FILTER_EARLY_BREAKOUT_REQUIRE_BREAK_FLAG || "true"
  ).toLowerCase() === "true";
const FILTER_EARLY_BREAKOUT_REQUIRE_ABOVE_EMA8 =
  String(
    process.env.FILTER_EARLY_BREAKOUT_REQUIRE_ABOVE_EMA8 || "true"
  ).toLowerCase() === "true";
const FILTER_EARLY_BREAKOUT_REQUIRE_RSI_RISING =
  String(
    process.env.FILTER_EARLY_BREAKOUT_REQUIRE_RSI_RISING || "false"
  ).toLowerCase() === "true";
const FILTER_EARLY_BREAKOUT_REQUIRE_BULL_CANDLE =
  String(
    process.env.FILTER_EARLY_BREAKOUT_REQUIRE_BULL_CANDLE || "false"
  ).toLowerCase() === "true";

// NEW: Trend momentum continuation mode
const FILTER_TREND_CONTINUATION_ENABLED =
  String(
    process.env.FILTER_TREND_CONTINUATION_ENABLED || "true"
  ).toLowerCase() === "true";

const FILTER_TREND_CONTINUATION_MIN_RSI = Number(
  process.env.FILTER_TREND_CONTINUATION_MIN_RSI || "62"
);
const FILTER_TREND_CONTINUATION_MIN_ADX = Number(
  process.env.FILTER_TREND_CONTINUATION_MIN_ADX || "20"
);
const FILTER_TREND_CONTINUATION_MIN_EMA21_SLOPE_PCT = Number(
  process.env.FILTER_TREND_CONTINUATION_MIN_EMA21_SLOPE_PCT || "0.00"
);
const FILTER_TREND_CONTINUATION_MAX_ENTRY_EXT_EMA18_PCT = Number(
  process.env.FILTER_TREND_CONTINUATION_MAX_ENTRY_EXT_EMA18_PCT || "0.45"
);
const FILTER_TREND_CONTINUATION_MAX_ENTRY_EXT_EMA21_PCT = Number(
  process.env.FILTER_TREND_CONTINUATION_MAX_ENTRY_EXT_EMA21_PCT || "0.55"
);
const FILTER_TREND_CONTINUATION_REQUIRE_BREAK_FLAG =
  String(
    process.env.FILTER_TREND_CONTINUATION_REQUIRE_BREAK_FLAG || "true"
  ).toLowerCase() === "true";
const FILTER_TREND_CONTINUATION_REQUIRE_ABOVE_EMA8 =
  String(
    process.env.FILTER_TREND_CONTINUATION_REQUIRE_ABOVE_EMA8 || "true"
  ).toLowerCase() === "true";
const FILTER_TREND_CONTINUATION_REQUIRE_RSI_ABOVE_MA =
  String(
    process.env.FILTER_TREND_CONTINUATION_REQUIRE_RSI_ABOVE_MA || "false"
  ).toLowerCase() === "true";
const FILTER_TREND_CONTINUATION_REQUIRE_FWO_RECOVERED =
  String(
    process.env.FILTER_TREND_CONTINUATION_REQUIRE_FWO_RECOVERED || "false"
  ).toLowerCase() === "true";
const FILTER_TREND_CONTINUATION_REQUIRE_BULL_CANDLE =
  String(
    process.env.FILTER_TREND_CONTINUATION_REQUIRE_BULL_CANDLE || "false"
  ).toLowerCase() === "true";

// Hostility
const FILTER_HOSTILE_MAX_EMA_GAP_PCT = Number(
  process.env.FILTER_HOSTILE_MAX_EMA_GAP_PCT || "0.60"
);
const FILTER_HOSTILE_MAX_NEG_SLOPE_PCT = Number(
  process.env.FILTER_HOSTILE_MAX_NEG_SLOPE_PCT || "0.12"
);
const FILTER_HOSTILE_MAX_MINUS_DI_LEAD = Number(
  process.env.FILTER_HOSTILE_MAX_MINUS_DI_LEAD || "10"
);

// Position
const ALLOW_ONLY_ONE_POSITION =
  String(process.env.ALLOW_ONLY_ONE_POSITION || "true").toLowerCase() ===
  "true";

// ========================================
// EXIT STACK CONFIG
// ========================================
const INTERNAL_EXITS_ENABLED =
  String(process.env.INTERNAL_EXITS_ENABLED || "true").toLowerCase() ===
  "true";

const INITIAL_STOP_BUFFER_PCT = Number(
  process.env.INITIAL_STOP_BUFFER_PCT || "0.18"
);

const FALLBACK_INITIAL_STOP_PCT = Number(
  process.env.FALLBACK_INITIAL_STOP_PCT || "0.60"
);

const TRAIL_ATR_LEN = Number(process.env.TRAIL_ATR_LEN || "14");
const TRAIL_ATR_MULT = Number(process.env.TRAIL_ATR_MULT || "2.0");
const TREND_MIN_TRAIL_PCT = Number(
  process.env.TREND_MIN_TRAIL_PCT || "0.45"
);

const TREND_STOP_ACTIVATE_MIN = Number(
  process.env.TREND_STOP_ACTIVATE_MIN || "9"
);
const TREND_TIME_STOP_MIN = Number(
  process.env.TREND_TIME_STOP_MIN || "60"
);
const TREND_MIN_PROGRESS_PCT = Number(
  process.env.TREND_MIN_PROGRESS_PCT || "0.12"
);

const EXIT_DEDUP_SEC = Number(process.env.EXIT_DEDUP_SEC || "20");

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
    entryMode: "",
    entryEval: null,

    peakPrice: null,
    stopPrice: null,
    trailingStop: null,
    lastExitTs: 0,

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
  return (
    toNum(payload?.price) ??
    toNum(payload?.close) ??
    toNum(payload?.trigger_price) ??
    null
  );
}

function isHeartbeatFresh(s) {
  if (!REQUIRE_FRESH_HEARTBEAT) return true;
  if (!s.lastTickMs) return false;
  return nowMs() - s.lastTickMs <= HEARTBEAT_MAX_AGE_SEC * 1000;
}

function enterDedupeActive(s, ts) {
  if (!ENTER_DEDUP_SEC || ENTER_DEDUP_SEC <= 0) return false;
  return s.lastEnterAcceptedTs && ts - s.lastEnterAcceptedTs < ENTER_DEDUP_SEC * 1000;
}

function exitDedupeActive(s, ts) {
  if (!EXIT_DEDUP_SEC || EXIT_DEDUP_SEC <= 0) return false;
  return s.lastExitTs && ts - s.lastExitTs < EXIT_DEDUP_SEC * 1000;
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
      `📌 STATE ${s.symbol} inPos=${s.inPosition ? 1 : 0} bars=${s.bars.length} price=${s.lastTickPrice ?? "na"} allow=${e?.allow ? 1 : 0} mode=${e?.mode || "na"} reclaimAge=${e?.reclaimAgeBars ?? "na"} ext21=${e?.entryExtEma21Pct != null ? e.entryExtEma21Pct.toFixed(3) : "na"} hostile=${e?.hostileBear ? 1 : 0} trail=${s.trailingStop != null ? s.trailingStop.toFixed(4) : "na"} stop=${s.stopPrice != null ? s.stopPrice.toFixed(4) : "na"} reasons=${reasons} lastAction=${s.lastAction}`
    );
    s.lastStateLogMs = now;
  }
}

function adxBelowThresholdStrict(adxValue, minAdx) {
  return !Number.isFinite(adxValue) || adxValue < minAdx;
}

function adxBelowThresholdContinuation(adxValue, minAdx) {
  if (!Number.isFinite(minAdx) || minAdx <= 0) return false;
  if (!Number.isFinite(adxValue)) return false;
  return adxValue < minAdx;
}

function pctChange(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / b) * 100;
}

function fmt(x, d = 4) {
  return Number.isFinite(x) ? Number(x).toFixed(d) : "na";
}

// ========================================
// BAR BUILDER
// ========================================
function pushTickToBars(s, price, tsMs) {
  const bucketMs = floorToTfMs(tsMs, BAR_TF_SEC);

  if (!s.currentBar || s.currentBar.t !== bucketMs) {
    if (s.currentBar) {
      s.bars.push(s.currentBar);
      if (s.bars.length > MAX_BARS) s.bars.shift();
    }
    s.currentBar = { t: bucketMs, o: price, h: price, l: price, c: price };
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

  const finiteDx = dx.filter((x) => Number.isFinite(x));
  const adxShort = rma(finiteDx, len);

  const fullAdx = new Array(dx.length).fill(null);
  let k = 0;
  for (let i = 0; i < dx.length; i++) {
    if (Number.isFinite(dx[i])) {
      fullAdx[i] = adxShort[k] ?? null;
      k++;
    }
  }

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
    if (i + 1 < sigLen) {
      fwoSignal.push(null);
    } else {
      let sum = 0;
      for (let j = i - sigLen + 1; j <= i; j++) sum += fwo[j];
      fwoSignal.push(sum / sigLen);
    }
  }

  return { fwo, fwoSignal };
}

function atrSeries(bars, len) {
  if (bars.length < len + 1) return [];
  const tr = [null];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h;
    const l = bars[i].l;
    const pc = bars[i - 1].c;
    tr.push(Math.max(h - l, Math.max(Math.abs(h - pc), Math.abs(l - pc))));
  }

  const out = new Array(bars.length).fill(null);
  let seed = 0;
  for (let i = 1; i <= len; i++) seed += tr[i];
  out[len] = seed / len;

  for (let i = len + 1; i < bars.length; i++) {
    out[i] = ((out[i - 1] * (len - 1)) + tr[i]) / len;
  }
  return out;
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

function highestHigh(bars, lookback) {
  const start = Math.max(0, bars.length - lookback);
  let v = bars[start].h;
  for (let i = start + 1; i < bars.length; i++) v = Math.max(v, bars[i].h);
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
        return {
          index: i,
          ageBars: age,
          reclaimPrice: bars[i].c,
          reclaimLow: bars[i].l,
        };
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
      mode: "disabled",
      barsCount: bars.length,
      hostileBear: false,
    };
  }

  if (bars.length < FILTER_MIN_BARS) {
    reasons.push("not_enough_bars");
    return {
      allow: false,
      reasons,
      mode: "warmup",
      barsCount: bars.length,
      hostileBear: false,
    };
  }

  const closes = bars.map((b) => b.c);

  const ema8 = emaSeries(closes, 8);
  const ema18 = emaSeries(closes, 18);
  const ema21 = emaSeries(closes, 21);
  const rsi = rsiSeries(closes, 14);
  const atr = atrSeries(bars, TRAIL_ATR_LEN);
  const { adx, plusDI, minusDI } = adxSeries(bars, 14);
  const { fwo, fwoSignal } = wtSeries(bars, 10, 21, 4);

  const rsiMA = [];
  for (let i = 0; i < rsi.length; i++) {
    if (i < 4 || !Number.isFinite(rsi[i])) {
      rsiMA.push(null);
    } else {
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

  const i = bars.length - 1;
  const bar = bars[i];

  const rsiNow = rsi[i];
  const rsiPrev = rsi[i - 1];
  const rsiMaNow = rsiMA[i];

  const adxNow = adx[i];
  const plusDINow = plusDI[i];
  const minusDINow = minusDI[i];

  const ema8Now = ema8[i];
  const ema18Now = ema18[i];
  const ema21Now = ema21[i];
  const atrNow = atr[i];
  const ema8Prev = ema8[i - 1];
  const ema21Prev = ema21[i - 1];

  const fwoNow = fwo[i];
  const fwoPrev = fwo[i - 1];
  const fwoSigNow = fwoSignal[i];

  const bullCandle = bar.c > bar.o;

  const lowInfo = barsSinceLowestLow(bars, FILTER_WASH_LOOKBACK_BARS);
  const recentLow = lowInfo.low;
  const barsSinceLow = lowInfo.barsSince;
  const recentHigh = highestClose(bars, FILTER_DROP_LOOKBACK_BARS);
  const dropPct = recentHigh > 0 ? ((recentHigh - bar.c) / recentHigh) * 100 : 0;
  const maxStretchBelow = highestStretchBelowEma(
    bars,
    ema21,
    FILTER_WASH_LOOKBACK_BARS
  );
  const maxBelowStreak = highestBelowStreak(
    bars,
    ema21,
    FILTER_WASH_LOOKBACK_BARS
  );

  const hadDamage =
    dropPct >= FILTER_MIN_DROP_PCT ||
    maxStretchBelow >= FILTER_MIN_DROP_PCT ||
    maxBelowStreak >= 3;

  const reclaimReversal = findRecentReclaimBar(
    bars,
    ema21,
    FILTER_MAX_BARS_SINCE_RECLAIM
  );
  const reclaimBreakout = findRecentReclaimBar(
    bars,
    ema21,
    FILTER_BREAKOUT_MAX_BARS_SINCE_RECLAIM
  );
  const reclaimHold = findRecentReclaimBar(
    bars,
    ema21,
    FILTER_HOLD_RECENT_RECLAIM_LOOKBACK
  );
  const reclaimEarly = findRecentReclaimBar(
    bars,
    ema21,
    FILTER_EARLY_BREAKOUT_MAX_BARS_SINCE_RECLAIM
  );

  const reclaimAny =
    reclaimBreakout || reclaimReversal || reclaimHold || reclaimEarly;
  const reclaimAgeBars = reclaimAny ? reclaimAny.ageBars : null;
  const reclaimPrice = reclaimAny ? reclaimAny.reclaimPrice : null;
  const reclaimLow = reclaimAny ? reclaimAny.reclaimLow : null;

  const reclaimFromLowPct =
    Number.isFinite(recentLow) && recentLow > 0
      ? ((bar.c - recentLow) / recentLow) * 100
      : null;

  const impulseFromLowPct =
    Number.isFinite(recentLow) && recentLow > 0
      ? ((bar.h - recentLow) / recentLow) * 100
      : null;

  const bodyPct = bar.o > 0 ? (Math.abs(bar.c - bar.o) / bar.o) * 100 : null;

  const emaGapPct = ema21Now > 0 ? ((ema21Now - ema8Now) / ema21Now) * 100 : 0;
  const ema21SlopePct =
    Number.isFinite(ema21Prev) && ema21Prev > 0
      ? ((ema21Now - ema21Prev) / ema21Prev) * 100
      : 0;
  const minusLead =
    Number.isFinite(minusDINow) && Number.isFinite(plusDINow)
      ? minusDINow - plusDINow
      : 0;

  const hostileBear =
    emaGapPct > FILTER_HOSTILE_MAX_EMA_GAP_PCT ||
    ema21SlopePct < -FILTER_HOSTILE_MAX_NEG_SLOPE_PCT ||
    minusLead > FILTER_HOSTILE_MAX_MINUS_DI_LEAD;

  const entryExtEma21Pct =
    ema21Now > 0 ? ((bar.c - ema21Now) / ema21Now) * 100 : null;
  const entryExtEma18Pct =
    ema18Now > 0 ? ((bar.c - ema18Now) / ema18Now) * 100 : null;
  const buyFromReclaimPct =
    Number.isFinite(reclaimPrice) && reclaimPrice > 0
      ? ((bar.c - reclaimPrice) / reclaimPrice) * 100
      : null;

  const fwoRecovered = Number.isFinite(fwoSigNow) && fwoNow > fwoSigNow;
  const fwoRising = Number.isFinite(fwoPrev) && fwoNow > fwoPrev;
  const rsiRising = Number.isFinite(rsiPrev) && rsiNow > rsiPrev;
  const rsiAboveMa = Number.isFinite(rsiMaNow) && rsiNow > rsiMaNow;
  const ema8Rising = Number.isFinite(ema8Prev) && ema8Now > ema8Prev;
  const aboveEma18_21 =
    Number.isFinite(ema18Now) &&
    Number.isFinite(ema21Now) &&
    bar.c > ema18Now &&
    bar.c > ema21Now;
  const aboveEma8 = Number.isFinite(ema8Now) ? bar.c > ema8Now : false;

  const prev6High =
    i >= 1 ? highestHigh(bars.slice(0, -1), Math.min(6, bars.length - 1)) : null;
  const prev4High =
    i >= 1 ? highestHigh(bars.slice(0, -1), Math.min(4, bars.length - 1)) : null;
  const breakoutNow = Number.isFinite(prev6High) ? bar.c > prev6High : false;
  const holdBreakNow = Number.isFinite(prev4High) ? bar.c >= prev4High : false;

  const closeOverReclaimPct =
    Number.isFinite(reclaimPrice) && reclaimPrice > 0
      ? ((bar.c - reclaimPrice) / reclaimPrice) * 100
      : null;

  // ---------- MODE 1: REVERSAL RECLAIM ----------
  const reversalReasons = [];

  if (!hadDamage) reversalReasons.push("no_recent_damage");
  if (barsSinceLow > FILTER_MAX_BARS_SINCE_LOW) reversalReasons.push("low_too_old");
  if (!reclaimReversal) reversalReasons.push("no_fresh_reclaim");
  if (!(reclaimFromLowPct >= FILTER_MIN_RECLAIM_FROM_LOW_PCT))
    reversalReasons.push("weak_reclaim_from_low");
  if (!(impulseFromLowPct >= FILTER_MIN_IMPULSE_FROM_LOW_PCT))
    reversalReasons.push("weak_impulse_from_low");
  if (!(bodyPct >= FILTER_MIN_BODY_PCT)) reversalReasons.push("weak_body");
  if (!aboveEma18_21) reversalReasons.push("not_above_ema18_21");
  if (!(rsiNow >= FILTER_RSI_MIN)) reversalReasons.push("rsi_too_low");
  if (!rsiRising) reversalReasons.push("rsi_not_rising");
  if (!rsiAboveMa) reversalReasons.push("rsi_not_above_ma");
  if (!fwoRecovered) reversalReasons.push("fwo_not_recovered");
  if (!fwoRising) reversalReasons.push("fwo_not_rising");
  if (!bullCandle) reversalReasons.push("not_bull_candle");
  if (adxBelowThresholdStrict(adxNow, FILTER_ADX_MIN))
    reversalReasons.push("adx_too_low");
  if (!ema8Rising) reversalReasons.push("ema8_not_rising");
  if (hostileBear) reversalReasons.push("hostile_bear");
  if (!(entryExtEma21Pct <= FILTER_MAX_ENTRY_EXT_EMA21_PCT))
    reversalReasons.push("too_extended_ema21");
  if (!(entryExtEma18Pct <= FILTER_MAX_ENTRY_EXT_EMA18_PCT))
    reversalReasons.push("too_extended_ema18");
  if (
    !(
      buyFromReclaimPct == null ||
      buyFromReclaimPct <= FILTER_MAX_BUY_FROM_RECLAIM_PCT
    )
  ) {
    reversalReasons.push("too_far_from_reclaim");
  }
  if (reclaimReversal && lowInfo.index > reclaimReversal.index)
    reversalReasons.push("fresh_low_after_reclaim");

  const reversalAllow = reversalReasons.length === 0;

  // ---------- MODE 2: EARLY BREAKOUT LAUNCH ----------
  const earlyBreakoutReasons = [];

  if (!FILTER_EARLY_BREAKOUT_ENABLED) {
    earlyBreakoutReasons.push("early_breakout_disabled");
  } else {
    if (!reclaimEarly) earlyBreakoutReasons.push("no_fresh_reclaim");
    if (!aboveEma18_21) earlyBreakoutReasons.push("not_above_ema18_21");
    if (FILTER_EARLY_BREAKOUT_REQUIRE_ABOVE_EMA8 && !aboveEma8) {
      earlyBreakoutReasons.push("not_above_ema8");
    }
    if (!(rsiNow >= FILTER_EARLY_BREAKOUT_MIN_RSI))
      earlyBreakoutReasons.push("rsi_too_low");
    if (FILTER_EARLY_BREAKOUT_REQUIRE_RSI_RISING && !rsiRising) {
      earlyBreakoutReasons.push("rsi_not_rising");
    }
    if (adxBelowThresholdContinuation(adxNow, FILTER_EARLY_BREAKOUT_MIN_ADX)) {
      earlyBreakoutReasons.push("adx_too_low");
    }
    if (
      FILTER_EARLY_BREAKOUT_REQUIRE_BREAK_FLAG &&
      !(breakoutNow || holdBreakNow)
    ) {
      earlyBreakoutReasons.push("no_launch_break_flag");
    }
    if (
      !(
        closeOverReclaimPct != null &&
        closeOverReclaimPct >= FILTER_EARLY_BREAKOUT_MIN_CLOSE_OVER_RECLAIM_PCT
      )
    ) {
      earlyBreakoutReasons.push("no_breakout_clearance");
    }
    if (!(entryExtEma18Pct <= FILTER_EARLY_BREAKOUT_MAX_ENTRY_EXT_EMA18_PCT)) {
      earlyBreakoutReasons.push("too_extended_ema18");
    }
    if (!(entryExtEma21Pct <= FILTER_EARLY_BREAKOUT_MAX_ENTRY_EXT_EMA21_PCT)) {
      earlyBreakoutReasons.push("too_extended_ema21");
    }
    if (
      !(
        buyFromReclaimPct == null ||
        buyFromReclaimPct <= FILTER_EARLY_BREAKOUT_MAX_BUY_FROM_RECLAIM_PCT
      )
    ) {
      earlyBreakoutReasons.push("too_far_from_reclaim");
    }
    if (FILTER_EARLY_BREAKOUT_REQUIRE_BULL_CANDLE && !bullCandle) {
      earlyBreakoutReasons.push("not_bull_candle");
    }
    if (hostileBear) earlyBreakoutReasons.push("hostile_bear");
  }

  const earlyBreakoutAllow = earlyBreakoutReasons.length === 0;

  // ---------- MODE 3: TREND MOMENTUM CONTINUATION ----------
  const trendContinuationReasons = [];

  if (!FILTER_TREND_CONTINUATION_ENABLED) {
    trendContinuationReasons.push("trend_continuation_disabled");
  } else {
    if (!aboveEma18_21) trendContinuationReasons.push("not_above_ema18_21");

    if (FILTER_TREND_CONTINUATION_REQUIRE_ABOVE_EMA8 && !aboveEma8) {
      trendContinuationReasons.push("not_above_ema8");
    }

    if (!(rsiNow >= FILTER_TREND_CONTINUATION_MIN_RSI)) {
      trendContinuationReasons.push("rsi_too_low");
    }

    if (adxBelowThresholdContinuation(adxNow, FILTER_TREND_CONTINUATION_MIN_ADX)) {
      trendContinuationReasons.push("adx_too_low");
    }

    if (!(ema21SlopePct >= FILTER_TREND_CONTINUATION_MIN_EMA21_SLOPE_PCT)) {
      trendContinuationReasons.push("ema21_slope_too_low");
    }

    if (
      FILTER_TREND_CONTINUATION_REQUIRE_BREAK_FLAG &&
      !(breakoutNow || holdBreakNow)
    ) {
      trendContinuationReasons.push("no_trend_continuation_flag");
    }

    if (!(entryExtEma18Pct <= FILTER_TREND_CONTINUATION_MAX_ENTRY_EXT_EMA18_PCT)) {
      trendContinuationReasons.push("too_extended_ema18");
    }

    if (!(entryExtEma21Pct <= FILTER_TREND_CONTINUATION_MAX_ENTRY_EXT_EMA21_PCT)) {
      trendContinuationReasons.push("too_extended_ema21");
    }

    if (
      FILTER_TREND_CONTINUATION_REQUIRE_RSI_ABOVE_MA &&
      !rsiAboveMa
    ) {
      trendContinuationReasons.push("rsi_not_above_ma");
    }

    if (
      FILTER_TREND_CONTINUATION_REQUIRE_FWO_RECOVERED &&
      !fwoRecovered
    ) {
      trendContinuationReasons.push("fwo_not_recovered");
    }

    if (
      FILTER_TREND_CONTINUATION_REQUIRE_BULL_CANDLE &&
      !bullCandle
    ) {
      trendContinuationReasons.push("not_bull_candle");
    }

    if (hostileBear) trendContinuationReasons.push("hostile_bear");
  }

  const trendContinuationAllow = trendContinuationReasons.length === 0;

  // ---------- MODE 4: BREAKOUT CONTINUATION ----------
  const breakoutReasons = [];

  if (!FILTER_BREAKOUT_ENABLED) {
    breakoutReasons.push("breakout_mode_disabled");
  } else {
    if (!reclaimBreakout) breakoutReasons.push("no_recent_reclaim");
    if (!aboveEma18_21) breakoutReasons.push("not_above_ema18_21");
    if (!(rsiNow >= FILTER_BREAKOUT_MIN_RSI))
      breakoutReasons.push("rsi_too_low");
    if (adxBelowThresholdContinuation(adxNow, FILTER_BREAKOUT_MIN_ADX))
      breakoutReasons.push("adx_too_low");
    if (
      !(
        closeOverReclaimPct != null &&
        closeOverReclaimPct >= FILTER_BREAKOUT_MIN_CLOSE_OVER_RECLAIM_PCT
      )
    ) {
      breakoutReasons.push("no_breakout_clearance");
    }
    if (
      !(
        buyFromReclaimPct == null ||
        buyFromReclaimPct <= FILTER_BREAKOUT_MAX_BUY_FROM_RECLAIM_PCT
      )
    ) {
      breakoutReasons.push("too_far_from_reclaim");
    }
    if (!(entryExtEma18Pct <= FILTER_BREAKOUT_MAX_ENTRY_EXT_EMA18_PCT)) {
      breakoutReasons.push("too_extended_ema18");
    }
    if (!(entryExtEma21Pct <= FILTER_BREAKOUT_MAX_ENTRY_EXT_EMA21_PCT)) {
      breakoutReasons.push("too_extended_ema21");
    }
    if (FILTER_BREAKOUT_REQUIRE_BULL_CANDLE && !bullCandle) {
      breakoutReasons.push("not_bull_candle");
    }
    if (hostileBear) breakoutReasons.push("hostile_bear");
  }

  const breakoutAllow = breakoutReasons.length === 0;

  // ---------- MODE 5: HOLD CONTINUATION ----------
  const holdReasons = [];

  if (!FILTER_HOLD_ENABLED) {
    holdReasons.push("hold_mode_disabled");
  } else {
    if (!aboveEma18_21) holdReasons.push("not_above_ema18_21");
    if (!(rsiNow >= FILTER_HOLD_MIN_RSI)) holdReasons.push("rsi_too_low");
    if (adxBelowThresholdContinuation(adxNow, FILTER_HOLD_MIN_ADX))
      holdReasons.push("adx_too_low");

    if (FILTER_HOLD_REQUIRE_RSI_RISING && !rsiRising)
      holdReasons.push("rsi_not_rising");
    if (FILTER_HOLD_REQUIRE_FWO_RECOVERED && !fwoRecovered)
      holdReasons.push("fwo_not_recovered");
    if (FILTER_HOLD_REQUIRE_EMA8_RISING && !ema8Rising)
      holdReasons.push("ema8_not_rising");
    if (FILTER_HOLD_REQUIRE_BULL_CANDLE && !bullCandle)
      holdReasons.push("not_bull_candle");

    if (FILTER_HOLD_REQUIRE_RECENT_RECLAIM && !reclaimHold) {
      holdReasons.push("no_recent_reclaim");
    }

    if (!(entryExtEma18Pct <= FILTER_HOLD_MAX_ENTRY_EXT_EMA18_PCT)) {
      holdReasons.push("too_extended_ema18");
    }
    if (!(entryExtEma21Pct <= FILTER_HOLD_MAX_ENTRY_EXT_EMA21_PCT)) {
      holdReasons.push("too_extended_ema21");
    }

    if (
      !(
        holdBreakNow ||
        breakoutNow ||
        (closeOverReclaimPct != null && closeOverReclaimPct >= 0)
      )
    ) {
      holdReasons.push("no_hold_continuation_clearance");
    }

    if (hostileBear) holdReasons.push("hostile_bear");
  }

  const holdAllow = holdReasons.length === 0;

  let allow = false;
  let mode = "blocked";

  if (reversalAllow) {
    allow = true;
    mode = "reversal_reclaim";
  } else if (earlyBreakoutAllow) {
    allow = true;
    mode = "early_breakout_launch";
  } else if (trendContinuationAllow) {
    allow = true;
    mode = "trend_momentum_continuation";
  } else if (breakoutAllow) {
    allow = true;
    mode = "breakout_continuation";
  } else if (holdAllow) {
    allow = true;
    mode = "hold_continuation";
  } else {
    const combined = new Set();
    for (const r of reversalReasons) combined.add(r);
    for (const r of earlyBreakoutReasons) combined.add(r);
    for (const r of trendContinuationReasons) combined.add(r);
    for (const r of breakoutReasons) combined.add(r);
    for (const r of holdReasons) combined.add(r);
    reasons.push(...combined);
  }

  return {
    allow,
    mode,
    reasons,
    barsCount: bars.length,
    recentLow,
    barsSinceLow,
    recentHigh,
    dropPct,
    maxStretchBelow,
    maxBelowStreak,
    reclaimAgeBars,
    reclaimPrice,
    reclaimLow,
    reclaimFromLowPct,
    impulseFromLowPct,
    bodyPct,
    rsi: rsiNow,
    rsiMa: rsiMaNow,
    adx: adxNow,
    plusDI: plusDINow,
    minusDI: minusDINow,
    atr: atrNow,
    ema8: ema8Now,
    ema18: ema18Now,
    ema21: ema21Now,
    close: bar.c,
    emaGapPct,
    ema21SlopePct,
    minusLead,
    hostileBear,
    entryExtEma21Pct,
    entryExtEma18Pct,
    buyFromReclaimPct,
    closeOverReclaimPct,
    breakoutNow,
    holdBreakNow,
    reversalReasons,
    earlyBreakoutReasons,
    trendContinuationReasons,
    breakoutReasons,
    holdReasons,
  };
}

// ========================================
// EXIT HELPERS
// ========================================
function buildInitialStop(entryPrice, evalResult) {
  const candidates = [];

  const buf = INITIAL_STOP_BUFFER_PCT / 100;

  if (
    Number.isFinite(evalResult?.reclaimPrice) &&
    evalResult.reclaimPrice < entryPrice
  ) {
    candidates.push(evalResult.reclaimPrice * (1 - buf));
  }

  if (
    Number.isFinite(evalResult?.reclaimLow) &&
    evalResult.reclaimLow < entryPrice
  ) {
    candidates.push(evalResult.reclaimLow * (1 - buf));
  }

  if (
    Number.isFinite(evalResult?.recentLow) &&
    evalResult.recentLow < entryPrice
  ) {
    candidates.push(evalResult.recentLow * (1 - buf));
  }

  if (
    Number.isFinite(evalResult?.ema21) &&
    evalResult.ema21 < entryPrice
  ) {
    candidates.push(evalResult.ema21 * (1 - buf));
  }

  if (
    Number.isFinite(evalResult?.ema18) &&
    evalResult.ema18 < entryPrice
  ) {
    candidates.push(evalResult.ema18 * (1 - buf));
  }

  const valid = candidates.filter((x) => Number.isFinite(x) && x < entryPrice);

  if (valid.length) {
    return Math.max(...valid);
  }

  return entryPrice * (1 - FALLBACK_INITIAL_STOP_PCT / 100);
}

function updateTrailingStop(s, price, evalResult) {
  if (!s.inPosition || !Number.isFinite(s.entryPrice)) return;

  if (!Number.isFinite(s.peakPrice) || price > s.peakPrice) {
    s.peakPrice = price;
  }

  const atrTrail =
    Number.isFinite(evalResult?.atr) && Number.isFinite(s.peakPrice)
      ? s.peakPrice - evalResult.atr * TRAIL_ATR_MULT
      : null;

  const minPctTrail =
    Number.isFinite(s.peakPrice)
      ? s.peakPrice * (1 - TREND_MIN_TRAIL_PCT / 100)
      : null;

  let wideTrail = null;
  if (Number.isFinite(atrTrail) && Number.isFinite(minPctTrail)) {
    wideTrail = Math.min(atrTrail, minPctTrail);
  } else if (Number.isFinite(atrTrail)) {
    wideTrail = atrTrail;
  } else if (Number.isFinite(minPctTrail)) {
    wideTrail = minPctTrail;
  }

  if (Number.isFinite(wideTrail)) {
    s.trailingStop = Math.max(
      Number.isFinite(s.stopPrice) ? s.stopPrice : -Infinity,
      wideTrail
    );
  } else {
    s.trailingStop = s.stopPrice;
  }
}

function getOpenPnLPct(s, price) {
  if (!Number.isFinite(s.entryPrice) || !Number.isFinite(price) || s.entryPrice <= 0) {
    return null;
  }
  return ((price - s.entryPrice) / s.entryPrice) * 100;
}

function getTimeInMinutes(s) {
  if (!s.entryAtMs) return 0;
  return (nowMs() - s.entryAtMs) / 60000;
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
    tv_exchange: String(
      payload?.tv_exchange ?? payload?.exchange ?? derived.tv_exchange ?? ""
    ),
    tv_instrument: String(
      payload?.tv_instrument ?? payload?.ticker ?? derived.tv_instrument ?? ""
    ),
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
    console.log(
      `📨 3Commas POST -> ${action} | status=${resp.status} | resp=${text || ""}`
    );
    return { ok: resp.ok, status: resp.status, resp: text };
  } catch (e) {
    console.log(
      "⛔ 3Commas POST failed:",
      e?.name === "AbortError" ? "timeout" : e?.message || e
    );
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

  const evalResult = evaluateLongFilter(s);
  s.lastEval = evalResult;

  // internal exit stack first
  if (INTERNAL_EXITS_ENABLED && s.inPosition) {
    const now = nowMs();

    if (exitDedupeActive(s, now)) {
      maybeLogState(s);
      return res.json({
        ok: true,
        tick: true,
        symbol,
        price,
        bars: getBarsForCalc(s).length,
        inPosition: true,
        ignored: "exit_dedup",
        filter: evalResult,
      });
    }

    updateTrailingStop(s, price, evalResult);

    const pnlPct = getOpenPnLPct(s, price);
    const timeInMin = getTimeInMinutes(s);
    const belowTrail =
      Number.isFinite(s.trailingStop) && price <= s.trailingStop;
    const trendStopActive = timeInMin >= TREND_STOP_ACTIVATE_MIN;
    const weakProgress =
      timeInMin >= TREND_TIME_STOP_MIN &&
      Number.isFinite(pnlPct) &&
      pnlPct < TREND_MIN_PROGRESS_PCT;

    let exitReason = "";

    if (belowTrail) {
      exitReason = "trail_hit";
    } else if (
      trendStopActive &&
      Number.isFinite(evalResult?.close) &&
      Number.isFinite(evalResult?.ema18) &&
      evalResult.close < evalResult.ema18
    ) {
      exitReason = "trend_lost";
    } else if (weakProgress) {
      exitReason = "time_stop";
    }

    if (exitReason) {
      const exitPrice = price;
      const exitTrailingStop = s.trailingStop;
      const exitStopPrice = s.stopPrice;
      const prevEntry = s.entryPrice;

      s.inPosition = false;
      s.lastExitTs = now;
      s.lastAction = `exit_${exitReason}`;
      s.entryPrice = null;
      s.entryAtMs = 0;
      s.entryMode = "";
      s.entryEval = null;
      s.peakPrice = null;
      s.stopPrice = null;
      s.trailingStop = null;

      console.log(
        `📤 EXIT LONG (internal) | symbol=${symbol} reason=${exitReason} price=${fmt(
          exitPrice
        )} pnlPct=${fmt(pnlPct, 3)} timeMin=${fmt(timeInMin, 1)} prevEntry=${fmt(
          prevEntry
        )}`
      );

      const fwd = await postTo3Commas("exit_long", {
        ...payload,
        symbol,
        price: exitPrice,
      });

      maybeLogState(s);

      return res.json({
        ok: true,
        tick: true,
        symbol,
        action: "exit_long",
        source: "internal_exit_stack",
        reason: exitReason,
        price: exitPrice,
        pnlPct,
        timeInMin,
        trailingStop: exitTrailingStop,
        stopPrice: exitStopPrice,
        threecommas: fwd,
      });
    }
  }

  maybeLogState(s);

  return res.json({
    ok: true,
    tick: true,
    symbol,
    price,
    bars: getBarsForCalc(s).length,
    filter: s.lastEval,
    inPosition: s.inPosition,
    trailingStop: s.trailingStop,
    stopPrice: s.stopPrice,
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
    return res.json({
      ok: true,
      ignored: "enter_dedup",
      window_sec: ENTER_DEDUP_SEC,
    });
  }

  const evalResult = evaluateLongFilter(s);
  s.lastEval = evalResult;

  if (!evalResult.allow) {
    s.lastAction = "enter_long_blocked_filter";
    if (DEBUG_FILTER) {
      console.log(
        `⛔ BUY BLOCKED | symbol=${symbol} price=${price} | mode=${evalResult.mode} | reasons=${evalResult.reasons.join(",")}`
      );
    }
    return res.json({
      ok: false,
      blocked: "filter_blocked",
      mode: evalResult.mode,
      reasons: evalResult.reasons,
      filter: evalResult,
    });
  }

  s.inPosition = true;
  s.entryPrice = price;
  s.entryAtMs = ts;
  s.entryMode = evalResult.mode;
  s.entryEval = evalResult;

  s.peakPrice = price;
  s.stopPrice = buildInitialStop(price, evalResult);
  s.trailingStop = s.stopPrice;

  s.lastEnterAcceptedTs = ts;
  s.lastAction = "enter_long";

  console.log(
    `🚀 ENTER LONG (${sourceTag}) | symbol=${symbol} price=${price} mode=${evalResult.mode} reclaimAge=${evalResult.reclaimAgeBars} ext18=${evalResult.entryExtEma18Pct?.toFixed(3)}% ext21=${evalResult.entryExtEma21Pct?.toFixed(3)}% stop=${fmt(
      s.stopPrice
    )}`
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
    mode: evalResult.mode,
    stopPrice: s.stopPrice,
    trailingStop: s.trailingStop,
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
  s.entryMode = "";
  s.entryEval = null;
  s.peakPrice = null;
  s.stopPrice = null;
  s.trailingStop = null;
  s.lastExitTs = nowMs();
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
      entryMode: s.entryMode,
      lastTickPrice: s.lastTickPrice,
      bars: getBarsForCalc(s).length,
      stopPrice: s.stopPrice,
      trailingStop: s.trailingStop,
      lastAction: s.lastAction,
      lastEval: s.lastEval,
    };
  }
  res.json({ brain: BRAIN_VERSION, symbols: out });
});

app.get("/status", (_req, res) => {
  const out = {};
  for (const [sym, s] of symbolState.entries()) {
    out[sym] = {
      inPosition: s.inPosition,
      entryPrice: s.entryPrice,
      entryMode: s.entryMode,
      lastTickPrice: s.lastTickPrice,
      bars: getBarsForCalc(s).length,
      stopPrice: s.stopPrice,
      trailingStop: s.trailingStop,
      lastAction: s.lastAction,
      lastEval: s.lastEval,
    };
  }
  res.json({ brain: BRAIN_VERSION, symbols: out });
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
  console.log(
    `Heartbeat: REQUIRE_FRESH_HEARTBEAT=${REQUIRE_FRESH_HEARTBEAT} | HEARTBEAT_MAX_AGE_SEC=${HEARTBEAT_MAX_AGE_SEC}`
  );
  console.log(`Bars: BAR_TF_SEC=${BAR_TF_SEC} | MAX_BARS=${MAX_BARS}`);
  console.log(
    `Filter: ENABLED=${FILTER_ENABLED} | MIN_BARS=${FILTER_MIN_BARS} | ADX_MIN=${FILTER_ADX_MIN} | RSI_MIN=${FILTER_RSI_MIN}`
  );
  console.log(
    `Damage: washLookback=${FILTER_WASH_LOOKBACK_BARS} | dropLookback=${FILTER_DROP_LOOKBACK_BARS} | maxBarsSinceLow=${FILTER_MAX_BARS_SINCE_LOW} | minDropPct=${FILTER_MIN_DROP_PCT}`
  );
  console.log(
    `Reclaim: minReclaimFromLow=${FILTER_MIN_RECLAIM_FROM_LOW_PCT}% | minImpulseFromLow=${FILTER_MIN_IMPULSE_FROM_LOW_PCT}% | minBody=${FILTER_MIN_BODY_PCT}% | maxBarsSinceReclaim=${FILTER_MAX_BARS_SINCE_RECLAIM}`
  );
  console.log(
    `EarlyBreakout: enabled=${FILTER_EARLY_BREAKOUT_ENABLED} | maxBarsSinceReclaim=${FILTER_EARLY_BREAKOUT_MAX_BARS_SINCE_RECLAIM} | minRsi=${FILTER_EARLY_BREAKOUT_MIN_RSI} | maxExt18=${FILTER_EARLY_BREAKOUT_MAX_ENTRY_EXT_EMA18_PCT}% | maxExt21=${FILTER_EARLY_BREAKOUT_MAX_ENTRY_EXT_EMA21_PCT}% | maxBuyFromReclaim=${FILTER_EARLY_BREAKOUT_MAX_BUY_FROM_RECLAIM_PCT}%`
  );
  console.log(
    `TrendContinuation: enabled=${FILTER_TREND_CONTINUATION_ENABLED} | minRsi=${FILTER_TREND_CONTINUATION_MIN_RSI} | minAdx=${FILTER_TREND_CONTINUATION_MIN_ADX} | minEma21Slope=${FILTER_TREND_CONTINUATION_MIN_EMA21_SLOPE_PCT}% | maxExt18=${FILTER_TREND_CONTINUATION_MAX_ENTRY_EXT_EMA18_PCT}% | maxExt21=${FILTER_TREND_CONTINUATION_MAX_ENTRY_EXT_EMA21_PCT}%`
  );
  console.log(
    `Breakout: enabled=${FILTER_BREAKOUT_ENABLED} | maxBarsSinceReclaim=${FILTER_BREAKOUT_MAX_BARS_SINCE_RECLAIM} | maxBuyFromReclaim=${FILTER_BREAKOUT_MAX_BUY_FROM_RECLAIM_PCT}% | maxExt18=${FILTER_BREAKOUT_MAX_ENTRY_EXT_EMA18_PCT}% | maxExt21=${FILTER_BREAKOUT_MAX_ENTRY_EXT_EMA21_PCT}%`
  );
  console.log(
    `Hold: enabled=${FILTER_HOLD_ENABLED} | minRsi=${FILTER_HOLD_MIN_RSI} | minAdx=${FILTER_HOLD_MIN_ADX} | maxExt18=${FILTER_HOLD_MAX_ENTRY_EXT_EMA18_PCT}% | maxExt21=${FILTER_HOLD_MAX_ENTRY_EXT_EMA21_PCT}% | recentReclaimLookback=${FILTER_HOLD_RECENT_RECLAIM_LOOKBACK} | requireRecent=${FILTER_HOLD_REQUIRE_RECENT_RECLAIM}`
  );
  console.log(
    `Extension: maxExt21=${FILTER_MAX_ENTRY_EXT_EMA21_PCT}% | maxExt18=${FILTER_MAX_ENTRY_EXT_EMA18_PCT}% | maxBuyFromReclaim=${FILTER_MAX_BUY_FROM_RECLAIM_PCT}%`
  );
  console.log(
    `Hostility: maxEmaGap=${FILTER_HOSTILE_MAX_EMA_GAP_PCT}% | maxNegSlope=${FILTER_HOSTILE_MAX_NEG_SLOPE_PCT}% | maxMinusLead=${FILTER_HOSTILE_MAX_MINUS_DI_LEAD}`
  );
  console.log(
    `ExitStack: enabled=${INTERNAL_EXITS_ENABLED} | initBuf=${INITIAL_STOP_BUFFER_PCT}% | fallbackInitStop=${FALLBACK_INITIAL_STOP_PCT}% | atrLen=${TRAIL_ATR_LEN} | atrMult=${TRAIL_ATR_MULT} | minTrailPct=${TREND_MIN_TRAIL_PCT}% | trendStopMin=${TREND_STOP_ACTIVATE_MIN} | timeStopMin=${TREND_TIME_STOP_MIN} | minProgress=${TREND_MIN_PROGRESS_PCT}%`
  );
  console.log(
    `3Commas: URL=${THREECOMMAS_WEBHOOK_URL} | BOT_UUID=${THREECOMMAS_BOT_UUID ? "(set)" : "(missing)"} | SECRET=${THREECOMMAS_SECRET ? "(set)" : "(missing)"}`
  );
});
