"use strict";
/**
 * htf_regime.js
 * -------------
 * Builds synthetic 1H and 4H bars internally from the 5m feature stream the
 * brain already receives (no new TradingView webhook required), computes
 * EMA-based trend state on each timeframe, and derives a single
 * `regimeBullish` flag for the swing exit logic to consult.
 *
 * Design notes (see conversation for full rationale):
 * - Only EMA(close) is computed here, not the full FVVO/RSI/ADX indicator
 *   stack. EMA is a simple, deterministic formula, so a from-scratch JS
 *   implementation can be trusted to match reality; replicating the Pine
 *   Script FVVO/RSI/ADX indicators independently would be much higher risk
 *   for comparatively little regime-gate value.
 * - Backfill on startup seeds the EMAs from real historical closes (Binance
 *   public klines REST endpoint) so the brain isn't blind for ~18h/~16.5
 *   days after every deploy while EMA18-on-1h / EMA18-on-4h warm up.
 * - If backfill fails or hasn't happened yet, `regimeBullish` reports
 *   `unknown` rather than a guessed true/false, and callers should treat
 *   `unknown` as "no long-leash privilege" (fail safe to the existing tight
 *   exit behavior).
 * - Confirmation is asymmetric: 2 consecutive confirmed 1H closes are
 *   required to GRANT bullish regime, but a single 1H close is enough to
 *   REVOKE it. Slow to trust, fast to protect — matching the existing
 *   emergency-recovery philosophy already in server.js.
 *
 * This module is intentionally state-isolated from the main `state` object
 * in server.js: it does not persist across restarts. Backfill is cheap and
 * idempotent, so we just re-seed on every startup rather than adding new
 * fields to the persisted state schema.
 */

function finite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function envStr(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === null || String(value).trim() === "" ? fallback : String(value).trim();
}
function envNum(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

const CFG = {
  HTF_REGIME_MODE: envStr("HTF_REGIME_MODE", "live").toLowerCase(), // "live" | "disabled". No "shadow" — user requested all-live for paper account.
  HTF_1H_EMA_FAST: Math.floor(envNum("HTF_1H_EMA_FAST", 8)),
  HTF_1H_EMA_SLOW: Math.floor(envNum("HTF_1H_EMA_SLOW", 18)),
  HTF_4H_EMA_FAST: Math.floor(envNum("HTF_4H_EMA_FAST", 8)),
  HTF_4H_EMA_SLOW: Math.floor(envNum("HTF_4H_EMA_SLOW", 18)),
  HTF_REGIME_CONFIRM_BARS_UP: Math.floor(envNum("HTF_REGIME_CONFIRM_BARS_UP", 2)),
  HTF_REGIME_CONFIRM_BARS_DOWN: Math.floor(envNum("HTF_REGIME_CONFIRM_BARS_DOWN", 1)),
  HTF_BACKFILL_ENABLED: envBool("HTF_BACKFILL_ENABLED", true),
  HTF_BACKFILL_SOURCE: envStr("HTF_BACKFILL_SOURCE", "binance").toLowerCase(),
  HTF_BACKFILL_BASE_URL: envStr("HTF_BACKFILL_BASE_URL", "https://api.binance.com"),
  HTF_BACKFILL_LIMIT_1H: Math.floor(envNum("HTF_BACKFILL_LIMIT_1H", 200)),
  HTF_BACKFILL_LIMIT_4H: Math.floor(envNum("HTF_BACKFILL_LIMIT_4H", 200)),
  HTF_BACKFILL_TIMEOUT_MS: Math.floor(envNum("HTF_BACKFILL_TIMEOUT_MS", 10000)),
  HTF_BACKFILL_MAX_RETRIES: Math.floor(envNum("HTF_BACKFILL_MAX_RETRIES", 2)),
};

const HOUR_MS = 3600 * 1000;
const FOUR_HOUR_MS = 4 * HOUR_MS;

function bucketStart(ms, bucketMs) {
  return Math.floor(ms / bucketMs) * bucketMs;
}

/** Standard EMA update. period<=1 degrades to "always equal latest close". */
function emaStep(prevEma, close, period) {
  if (!(period > 1)) return close;
  const mult = 2 / (period + 1);
  return prevEma === null || prevEma === undefined ? close : (close - prevEma) * mult + prevEma;
}

/** Seed an EMA by running the formula over an ordered array of historical closes. */
function seedEmaFromCloses(closes, period) {
  let ema = null;
  for (const c of closes) ema = emaStep(ema, c, period);
  return ema;
}

function freshTimeframeState() {
  return {
    bucketStartMs: null, // start of the bucket currently accumulating
    lastClose: null, // last close seen within the current (open) bucket
    bucketLow: null, // min close-as-low-proxy seen within the current (open) bucket
    emaFast: null,
    emaSlow: null,
    seeded: false, // true once backfill (or enough live bars) has produced a usable EMA
    liveBarsSeen: 0, // count of live 5m-derived closes folded into completed bars, for cold-start fallback
    confirmedBullish: null, // last confirmed bar's raw bullish boolean (pre-hysteresis)
    history: [], // recent {barStartMs, close, low, emaFast, emaSlow, bullish} entries, capped
  };
}

const tf = {
  h1: freshTimeframeState(),
  h4: freshTimeframeState(),
};

// Hysteresis state for the combined regime flag.
const regime = {
  value: "unknown", // "bullish" | "not_bullish" | "unknown"
  consecutiveBullishBars: 0,
  lastUpdatedMs: null,
  lastReason: "NOT_SEEDED",
};

const COLD_START_MIN_BARS = { h1: Math.max(2, CFG.HTF_1H_EMA_SLOW), h4: Math.max(2, CFG.HTF_4H_EMA_SLOW) };

function historyPush(state, entry) {
  state.history.push(entry);
  if (state.history.length > 50) state.history.shift();
}

/**
 * Finalizes the bucket currently held in `state` (using its lastClose as the
 * bar's close), updates EMAs, and returns the completed bar summary — or
 * null if there was nothing to finalize.
 */
function finalizeBar(state, label) {
  if (state.bucketStartMs === null || state.lastClose === null) return null;
  const close = state.lastClose;
  const low = state.bucketLow !== null ? state.bucketLow : close;
  state.emaFast = emaStep(state.emaFast, close, label === "h1" ? CFG.HTF_1H_EMA_FAST : CFG.HTF_4H_EMA_FAST);
  state.emaSlow = emaStep(state.emaSlow, close, label === "h1" ? CFG.HTF_1H_EMA_SLOW : CFG.HTF_4H_EMA_SLOW);
  state.liveBarsSeen += 1;
  if (!state.seeded && state.liveBarsSeen >= COLD_START_MIN_BARS[label]) state.seeded = true;
  const bullish = state.seeded && state.emaFast !== null && state.emaSlow !== null
    ? (close > state.emaSlow && state.emaFast >= state.emaSlow)
    : null;
  state.confirmedBullish = bullish;
  const entry = { barStartMs: state.bucketStartMs, close, low, emaFast: round8(state.emaFast), emaSlow: round8(state.emaSlow), bullish };
  historyPush(state, entry);
  return entry;
}

function round8(v) { return v === null || v === undefined ? null : Number(Number(v).toFixed(8)); }

/**
 * Feed one completed 5m bar's close price/time through both the 1H and 4H
 * aggregators. Call this for every FVVO_FEATURE_5M_EVENT.
 * Returns { h1Bar, h4Bar } — either is null if that timeframe's bucket did
 * not roll over on this call (i.e. still accumulating).
 */
function ingest5mBar(feature) {
  if (CFG.HTF_REGIME_MODE === "disabled") return { h1Bar: null, h4Bar: null };
  const close = finite(feature.close, finite(feature.price, null));
  const barTimeMs = finite(feature.barTimeMs, null);
  if (close === null || close <= 0 || barTimeMs === null) return { h1Bar: null, h4Bar: null };

  let h1Bar = null;
  let h4Bar = null;

  const h1Bucket = bucketStart(barTimeMs, HOUR_MS);
  if (tf.h1.bucketStartMs === null) {
    tf.h1.bucketStartMs = h1Bucket;
  } else if (h1Bucket > tf.h1.bucketStartMs) {
    h1Bar = finalizeBar(tf.h1, "h1");
    tf.h1.bucketStartMs = h1Bucket;
    tf.h1.bucketLow = null;
  }
  // Ignore late/out-of-order 5m bars that would move the bucket backwards.
  if (h1Bucket >= tf.h1.bucketStartMs) { tf.h1.lastClose = close; tf.h1.bucketLow = tf.h1.bucketLow === null ? close : Math.min(tf.h1.bucketLow, close); }

  const h4Bucket = bucketStart(barTimeMs, FOUR_HOUR_MS);
  if (tf.h4.bucketStartMs === null) {
    tf.h4.bucketStartMs = h4Bucket;
  } else if (h4Bucket > tf.h4.bucketStartMs) {
    h4Bar = finalizeBar(tf.h4, "h4");
    tf.h4.bucketStartMs = h4Bucket;
    tf.h4.bucketLow = null;
  }
  if (h4Bucket >= tf.h4.bucketStartMs) { tf.h4.lastClose = close; tf.h4.bucketLow = tf.h4.bucketLow === null ? close : Math.min(tf.h4.bucketLow, close); }

  if (h1Bar) updateRegime(h1Bar);

  return { h1Bar, h4Bar };
}

/**
 * Recompute the combined regime flag whenever a new 1H bar completes.
 * 4H only needs to be "not fighting the move" (a lower bar), so it's read
 * directly from tf.h4's current EMA state rather than requiring its own
 * hysteresis.
 */
function updateRegime(h1Bar) {
  regime.lastUpdatedMs = h1Bar.barStartMs;

  if (h1Bar.bullish === null) {
    regime.value = "unknown";
    regime.consecutiveBullishBars = 0;
    regime.lastReason = "H1_NOT_SEEDED";
    return;
  }

  const h4Seeded = tf.h4.seeded && tf.h4.emaFast !== null && tf.h4.emaSlow !== null;
  const h4NotBearish = !h4Seeded
    ? null
    : (tf.h4.lastClose !== null && tf.h4.lastClose > tf.h4.emaSlow) || tf.h4.emaFast >= tf.h4.emaSlow;

  if (h4NotBearish === null) {
    // 1H is seeded but 4H isn't yet (4H warms up slower). Fail safe to unknown.
    regime.value = "unknown";
    regime.consecutiveBullishBars = 0;
    regime.lastReason = "H4_NOT_SEEDED";
    return;
  }

  const rawBullish = h1Bar.bullish && h4NotBearish;

  if (!rawBullish) {
    // Revoke fast: a single failing 1H close is enough.
    regime.value = "not_bullish";
    regime.consecutiveBullishBars = 0;
    regime.lastReason = !h1Bar.bullish ? "H1_CLOSE_FAILED" : "H4_TURNED_BEARISH";
    return;
  }

  regime.consecutiveBullishBars += 1;
  if (regime.value === "bullish" || regime.consecutiveBullishBars >= CFG.HTF_REGIME_CONFIRM_BARS_UP) {
    regime.value = "bullish";
    regime.lastReason = "CONFIRMED";
  } else {
    regime.value = "not_bullish"; // building confirmation, not yet granted
    regime.lastReason = `CONFIRMING_${regime.consecutiveBullishBars}_OF_${CFG.HTF_REGIME_CONFIRM_BARS_UP}`;
  }
}

/**
 * Most recent confirmed swing-low anchor for the trailing structural stop:
 * the minimum `low` among the last `lookbackBars` COMPLETED 1H bars (the
 * currently-accumulating bucket is excluded since it isn't confirmed yet).
 * `low` here is a close-price proxy (min of the 5m closes seen within that
 * hour), not a true intrabar low, since the brain doesn't reliably receive
 * high/low from the webhook payload — documented limitation, see module
 * header. Returns null if there isn't enough confirmed history yet.
 */
function getRecentH1Low(lookbackBars = 3) {
  const bars = tf.h1.history.slice(-Math.max(1, lookbackBars));
  const lows = bars.map((b) => finite(b.low, null)).filter((v) => v !== null);
  if (!lows.length) return null;
  return Math.min(...lows);
}
function getRegimeSnapshot() {
  return {
    regimeBullish: regime.value, // "bullish" | "not_bullish" | "unknown"
    lastUpdatedMs: regime.lastUpdatedMs,
    lastReason: regime.lastReason,
    consecutiveBullishBars: regime.consecutiveBullishBars,
    h1: { seeded: tf.h1.seeded, emaFast: round8(tf.h1.emaFast), emaSlow: round8(tf.h1.emaSlow), lastClose: tf.h1.lastClose, bucketStartMs: tf.h1.bucketStartMs },
    h4: { seeded: tf.h4.seeded, emaFast: round8(tf.h4.emaFast), emaSlow: round8(tf.h4.emaSlow), lastClose: tf.h4.lastClose, bucketStartMs: tf.h4.bucketStartMs },
    mode: CFG.HTF_REGIME_MODE,
  };
}

function binanceSymbolFromConfigured(symbol) {
  const raw = String(symbol || "").trim().toUpperCase();
  const separator = raw.indexOf(":");
  return separator > 0 ? raw.slice(separator + 1).trim() : raw;
}

/**
 * Fetches historical closed klines from Binance's public REST endpoint.
 * NOTE: this reaches out to the network and could not be exercised in the
 * sandbox used to write this module (no network egress there). It has been
 * exercised offline via seedEmaFromCloses() with synthetic data instead —
 * verify this specific fetch against your real Railway deployment (or any
 * environment with network access) before relying on it in production.
 */
async function fetchHistoricalCloses(binanceSymbol, interval, limit) {
  const url = `${CFG.HTF_BACKFILL_BASE_URL}/api/v3/klines?symbol=${encodeURIComponent(binanceSymbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(String(limit))}`;
  let lastError = null;
  for (let attempt = 0; attempt <= CFG.HTF_BACKFILL_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CFG.HTF_BACKFILL_TIMEOUT_MS);
    try {
      const response = await fetch(url, { method: "GET", signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error("UNEXPECTED_RESPONSE_SHAPE");
      // Binance kline row: [openTime, open, high, low, close, volume, closeTime, ...]
      // Drop the last row if it's the still-open (unclosed) current candle.
      const now = Date.now();
      const closed = rows.filter((row) => Number(row[6]) < now);
      return closed.map((row) => ({ barStartMs: Number(row[0]), close: Number(row[4]), low: Number(row[3]) })).filter((r) => Number.isFinite(r.close) && r.close > 0 && Number.isFinite(r.low) && r.low > 0);
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
    }
  }
  throw lastError || new Error("BACKFILL_FETCH_FAILED");
}

function seedTimeframeFromHistory(state, label, historicalBars, fastPeriod, slowPeriod) {
  if (!historicalBars.length) return false;
  const closes = historicalBars.map((b) => b.close);
  state.emaFast = seedEmaFromCloses(closes, fastPeriod);
  state.emaSlow = seedEmaFromCloses(closes, slowPeriod);
  state.liveBarsSeen = historicalBars.length;
  state.seeded = true;
  const lastBar = historicalBars[historicalBars.length - 1];
  const bucketMs = label === "h1" ? HOUR_MS : FOUR_HOUR_MS;
  state.bucketStartMs = bucketStart(lastBar.barStartMs, bucketMs) + bucketMs; // next (currently-open) bucket
  state.lastClose = null;
  state.bucketLow = null;
  const bullish = lastBar.close > state.emaSlow && state.emaFast >= state.emaSlow;
  // Seed recent history with real lows (from backfill) where available so getRecentH1Low
  // has a meaningful anchor immediately, not just after live bars accumulate.
  const recent = historicalBars.slice(-10);
  state.history = recent.map((b) => ({ barStartMs: b.barStartMs, close: b.close, low: finite(b.low, b.close), emaFast: null, emaSlow: null, bullish: null, source: "backfill" }));
  historyPush(state, { barStartMs: lastBar.barStartMs, close: lastBar.close, low: finite(lastBar.low, lastBar.close), emaFast: round8(state.emaFast), emaSlow: round8(state.emaSlow), bullish, source: "backfill" });
  return true;
}

/**
 * Call once during worker startup (after config is available). Seeds both
 * timeframes from real historical data so the regime gate is usable
 * immediately instead of after ~18h/~16.5 days of live warm-up.
 * Never throws — on any failure it logs (via the passed-in logger) and
 * leaves the module in cold-start mode, where regimeBullish reports
 * "unknown" until enough live 5m-derived bars accumulate.
 */
async function backfillOnStartup({ symbol, log } = {}) {
  const logger = typeof log === "function" ? log : () => {};
  if (CFG.HTF_REGIME_MODE === "disabled") {
    logger("INFO", "FVVO_HTF_REGIME_DISABLED", {});
    return { ok: false, reason: "MODE_DISABLED" };
  }
  if (!CFG.HTF_BACKFILL_ENABLED) {
    logger("WARN", "FVVO_HTF_BACKFILL_SKIPPED", { reason: "BACKFILL_DISABLED_COLD_START_FALLBACK_ACTIVE" });
    return { ok: false, reason: "BACKFILL_DISABLED" };
  }
  if (CFG.HTF_BACKFILL_SOURCE !== "binance") {
    logger("WARN", "FVVO_HTF_BACKFILL_SKIPPED", { reason: "UNSUPPORTED_SOURCE", source: CFG.HTF_BACKFILL_SOURCE });
    return { ok: false, reason: "UNSUPPORTED_SOURCE" };
  }
  const binanceSymbol = binanceSymbolFromConfigured(symbol);
  try {
    const [h1History, h4History] = await Promise.all([
      fetchHistoricalCloses(binanceSymbol, "1h", CFG.HTF_BACKFILL_LIMIT_1H),
      fetchHistoricalCloses(binanceSymbol, "4h", CFG.HTF_BACKFILL_LIMIT_4H),
    ]);
    const h1Ok = seedTimeframeFromHistory(tf.h1, "h1", h1History, CFG.HTF_1H_EMA_FAST, CFG.HTF_1H_EMA_SLOW);
    const h4Ok = seedTimeframeFromHistory(tf.h4, "h4", h4History, CFG.HTF_4H_EMA_FAST, CFG.HTF_4H_EMA_SLOW);
    logger("INFO", "FVVO_HTF_BACKFILL_COMPLETE", {
      symbol: binanceSymbol, h1BarsLoaded: h1History.length, h4BarsLoaded: h4History.length,
      h1Seeded: h1Ok, h4Seeded: h4Ok,
      h1EmaFast: round8(tf.h1.emaFast), h1EmaSlow: round8(tf.h1.emaSlow),
      h4EmaFast: round8(tf.h4.emaFast), h4EmaSlow: round8(tf.h4.emaSlow),
    });
    return { ok: h1Ok && h4Ok, h1Loaded: h1History.length, h4Loaded: h4History.length };
  } catch (error) {
    logger("ERROR", "FVVO_HTF_BACKFILL_FAILED", { symbol: binanceSymbol, error: error.message, action: "COLD_START_FALLBACK_UNKNOWN_REGIME_UNTIL_WARM" });
    return { ok: false, reason: "FETCH_FAILED", error: error.message };
  }
}

// --- test helpers -----------------------------------------------------

function resetForTest() {
  tf.h1 = freshTimeframeState();
  tf.h4 = freshTimeframeState();
  regime.value = "unknown";
  regime.consecutiveBullishBars = 0;
  regime.lastUpdatedMs = null;
  regime.lastReason = "NOT_SEEDED";
}

/** Directly seed EMA state for tests, bypassing the network call. */
function seedForTest({ h1Closes = [], h4Closes = [], h1BarStartMs = 0, h4BarStartMs = 0, h1Lows = null, h4Lows = null } = {}) {
  if (h1Closes.length) seedTimeframeFromHistory(tf.h1, "h1", h1Closes.map((c, i) => ({ close: c, low: h1Lows ? h1Lows[i] : c, barStartMs: h1BarStartMs + i * HOUR_MS })), CFG.HTF_1H_EMA_FAST, CFG.HTF_1H_EMA_SLOW);
  if (h4Closes.length) seedTimeframeFromHistory(tf.h4, "h4", h4Closes.map((c, i) => ({ close: c, low: h4Lows ? h4Lows[i] : c, barStartMs: h4BarStartMs + i * FOUR_HOUR_MS })), CFG.HTF_4H_EMA_FAST, CFG.HTF_4H_EMA_SLOW);
}

module.exports = {
  CFG,
  ingest5mBar,
  getRegimeSnapshot,
  getRecentH1Low,
  backfillOnStartup,
  resetForTest,
  seedForTest,
  // exported for unit testing the pure math in isolation
  _internal: { emaStep, seedEmaFromCloses, bucketStart, binanceSymbolFromConfigured, HOUR_MS, FOUR_HOUR_MS },
};
