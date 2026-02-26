/**
 * Brain v2.9.1b (LONG) — READY_LONG + Ray enter/exit gatekeeper + 3Commas + Regime + Adaptive PL + Crash Lock + Equity Stabilizer + ReEntry
 * -------------------------------------------------------------------------------------------------------------------------------
 * v2.9.1b FIX:
 * ✅ Re-entry BUY after exit now forwards correct tv_exchange/tv_instrument even when READY is cleared
 *    by inferring meta from symbol format "EXCHANGE:INSTRUMENT" (e.g., "BINANCE:SOLUSDT").
 * ✅ Cooldown bypass ONLY for valid re-entry candidates (Option B)
 *
 * Balanced DEMO defaults assumed via env vars (see your Railway variables).
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const BRAIN_VERSION = "v2.9.1b-LONG";

// ====================
// CONFIG (Railway Variables)
// ====================
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// READY TTL (minutes). 0 = disabled
const READY_TTL_MIN = Number(process.env.READY_TTL_MIN || "0");

// accept legacy action:"ready" in addition to ready_long
const READY_ACCEPT_LEGACY_READY =
  String(process.env.READY_ACCEPT_LEGACY_READY || "true").toLowerCase() === "true";

// Base Entry drift gate (Ray BUY must be within this % of latest READY price)
const READY_MAX_MOVE_PCT = Number(process.env.READY_MAX_MOVE_PCT || "1.2");

// Optional per-regime drift overrides (if set, used when REGIME_ENABLED)
const READY_MAX_MOVE_PCT_TREND = toNumEnv(process.env.READY_MAX_MOVE_PCT_TREND);
const READY_MAX_MOVE_PCT_RANGE = toNumEnv(process.env.READY_MAX_MOVE_PCT_RANGE);

// Auto-expire drift gate (READY auto-clears if price drifts too far)
const READY_AUTOEXPIRE_PCT = Number(
  process.env.READY_AUTOEXPIRE_PCT || String(READY_MAX_MOVE_PCT)
);
const READY_AUTOEXPIRE_ENABLED =
  String(process.env.READY_AUTOEXPIRE_ENABLED || "true").toLowerCase() === "true";

// Cooldown after exit (minutes). 0 = disabled
const EXIT_COOLDOWN_MIN = Number(process.env.EXIT_COOLDOWN_MIN || "0");

// Heartbeat safety (ticks freshness)
const REQUIRE_FRESH_HEARTBEAT =
  String(process.env.REQUIRE_FRESH_HEARTBEAT || "true").toLowerCase() === "true";
const HEARTBEAT_MAX_AGE_SEC = Number(process.env.HEARTBEAT_MAX_AGE_SEC || "240");

// --------------------
// RE-ENTRY (v2.9.1b)
// --------------------
const REENTRY_ENABLED =
  String(process.env.REENTRY_ENABLED || "true").toLowerCase() === "true";

const REENTRY_WINDOW_MIN = Number(process.env.REENTRY_WINDOW_MIN || "30");
const REENTRY_MAX_FALL_PCT = Number(process.env.REENTRY_MAX_FALL_PCT || "0.6");
const REENTRY_MAX_RISE_PCT = Number(process.env.REENTRY_MAX_RISE_PCT || "0.9");

const REENTRY_REQUIRE_TREND =
  String(process.env.REENTRY_REQUIRE_TREND || "false").toLowerCase() === "true";

const REENTRY_REQUIRE_READY =
  String(process.env.REENTRY_REQUIRE_READY || "false").toLowerCase() === "true";

const REENTRY_CANCEL_ON_BREACH =
  String(process.env.REENTRY_CANCEL_ON_BREACH || "true").toLowerCase() === "true";

// Profit Lock (trailing) protection
const PROFIT_LOCK_ENABLED =
  String(process.env.PROFIT_LOCK_ENABLED || "true").toLowerCase() === "true";

// Fixed Profit Lock (fallback)
const PROFIT_LOCK_ARM_PCT = Number(process.env.PROFIT_LOCK_ARM_PCT || "0.6");
const PROFIT_LOCK_GIVEBACK_PCT = Number(process.env.PROFIT_LOCK_GIVEBACK_PCT || "0.35");

// Adaptive Profit Lock (ATR%-scaled)
const PL_ADAPTIVE_ENABLED =
  String(process.env.PL_ADAPTIVE_ENABLED || "true").toLowerCase() === "true";

const PL_START_ATR_MULT_TREND = Number(process.env.PL_START_ATR_MULT_TREND || "2.2");
const PL_GIVEBACK_ATR_MULT_TREND = Number(process.env.PL_GIVEBACK_ATR_MULT_TREND || "1.2");
const PL_START_ATR_MULT_RANGE = Number(process.env.PL_START_ATR_MULT_RANGE || "1.2");
const PL_GIVEBACK_ATR_MULT_RANGE = Number(process.env.PL_GIVEBACK_ATR_MULT_RANGE || "0.7");

// Profit Lock clamps
const PL_MIN_ARM_PCT = Number(process.env.PL_MIN_ARM_PCT || "0");
const PL_MIN_GIVEBACK_PCT = Number(process.env.PL_MIN_GIVEBACK_PCT || "0");
const PL_MAX_ARM_PCT = Number(process.env.PL_MAX_ARM_PCT || "0");
const PL_MAX_GIVEBACK_PCT = Number(process.env.PL_MAX_GIVEBACK_PCT || "0");

// Optional: ignore Ray SELL unless profit >= this % (0 disables)
const PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT = Number(
  process.env.PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT || "0"
);

// Regime switching (tick-derived)
const REGIME_ENABLED =
  String(process.env.REGIME_ENABLED || "true").toLowerCase() === "true";

// windows used for regime + ATR estimation
const SLOPE_WINDOW_SEC = Number(process.env.SLOPE_WINDOW_SEC || "300");
const ATR_WINDOW_SEC = Number(process.env.ATR_WINDOW_SEC || "300");
const TICK_BUFFER_SEC = Number(process.env.TICK_BUFFER_SEC || "1800");
const REGIME_MIN_TICKS = Number(process.env.REGIME_MIN_TICKS || "10");

// hysteresis thresholds (slope is absolute pct move over window)
const REGIME_TREND_SLOPE_ON_PCT = Number(process.env.REGIME_TREND_SLOPE_ON_PCT || "0.25");
const REGIME_TREND_SLOPE_OFF_PCT = Number(process.env.REGIME_TREND_SLOPE_OFF_PCT || "0.18");
const REGIME_RANGE_SLOPE_ON_PCT = Number(process.env.REGIME_RANGE_SLOPE_ON_PCT || "0.12");
const REGIME_RANGE_SLOPE_OFF_PCT = Number(process.env.REGIME_RANGE_SLOPE_OFF_PCT || "0.16");

// minimum volatility filter (ATR% must be above this for TREND to engage)
const REGIME_VOL_MIN_ATR_PCT = Number(process.env.REGIME_VOL_MIN_ATR_PCT || "0.20");

// Crash protection layer
const CRASH_PROTECT_ENABLED =
  String(process.env.CRASH_PROTECT_ENABLED || "true").toLowerCase() === "true";
const CRASH_DUMP_1M_PCT = Number(process.env.CRASH_DUMP_1M_PCT || "2.0");
const CRASH_DUMP_5M_PCT = Number(process.env.CRASH_DUMP_5M_PCT || "4.0");
const CRASH_COOLDOWN_MIN = Number(process.env.CRASH_COOLDOWN_MIN || "45");

// Equity stabilizer
const EQUITY_STABILIZER_ENABLED =
  String(process.env.EQUITY_STABILIZER_ENABLED || "true").toLowerCase() === "true";
const ES_LOSS_STREAK_2_COOLDOWN_MIN = Number(process.env.ES_LOSS_STREAK_2_COOLDOWN_MIN || "15");
const ES_LOSS_STREAK_3_COOLDOWN_MIN = Number(process.env.ES_LOSS_STREAK_3_COOLDOWN_MIN || "45");
const ES_CONSERVATIVE_MIN = Number(process.env.ES_CONSERVATIVE_MIN || "45");

// 3Commas
const THREECOMMAS_WEBHOOK_URL =
  process.env.THREECOMMAS_WEBHOOK_URL || "https://api.3commas.io/signal_bots/webhooks";
const THREECOMMAS_BOT_UUID = process.env.THREECOMMAS_BOT_UUID || "";
const THREECOMMAS_SECRET = process.env.THREECOMMAS_SECRET || "";
const THREECOMMAS_MAX_LAG = String(process.env.THREECOMMAS_MAX_LAG || "300");
const THREECOMMAS_TIMEOUT_MS = Number(process.env.THREECOMMAS_TIMEOUT_MS || "8000");

// Optional fallbacks if TV doesn't send these
const THREECOMMAS_TV_EXCHANGE = process.env.THREECOMMAS_TV_EXCHANGE || "";
const THREECOMMAS_TV_INSTRUMENT = process.env.THREECOMMAS_TV_INSTRUMENT || "";

// ====================
// MEMORY (in-RAM)
// ====================
let readyOn = false;
let readyAtMs = 0;

let inPosition = false;
let lastAction = "none";

let readyPrice = null;
let readySymbol = "";
let readyTf = "";
let readyMeta = {};

let cooldownUntilMs = 0;
let crashLockUntilMs = 0;

let lossStreak = 0;
let conservativeUntilMs = 0;

let lastTickMs = 0;
let lastTickSymbol = "";
let lastTickPrice = null;

const tickHistory = new Map();
const regimeState = new Map();

let entryPrice = null;
let entrySymbol = "";
let peakPrice = null;
let profitLockArmed = false;

let entryMeta = { tv_exchange: null, tv_instrument: null };

// Re-entry state
let reentryActive = false;
let reentryUntilMs = 0;
let reentryPrice = null;
let reentrySymbol = "";
let reentryRegimeAtExit = "RANGE";
let reentryReason = "";

// ====================
// HELPERS
// ====================
const nowMs = () => Date.now();

function toNumEnv(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function logWebhook(payload) {
  console.log("==== NEW WEBHOOK ====");
  console.log(payload);
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
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

function pctDiff(a, b) {
  if (!Number.isFinite(a) || a === 0) return null;
  return (Math.abs(b - a) / Math.abs(a)) * 100.0;
}

function pctProfit(entry, current) {
  if (!Number.isFinite(entry) || entry === 0 || !Number.isFinite(current)) return null;
  return ((current - entry) / entry) * 100.0;
}

function inferTvMetaFromSymbol(sym) {
  if (!sym || typeof sym !== "string") return { tv_exchange: null, tv_instrument: null };
  const m = sym.match(/^([^:]+):(.+)$/);
  if (!m) return { tv_exchange: null, tv_instrument: null };
  return { tv_exchange: m[1], tv_instrument: m[2] };
}

function clearReadyContext(reason = "cleared") {
  readyOn = false;
  readyAtMs = 0;
  readyPrice = null;
  readySymbol = "";
  readyTf = "";
  readyMeta = {};
  console.log(`🧹 READY context cleared (${reason})`);
}

function clearPositionContext(reason = "pos_cleared") {
  inPosition = false;
  entryPrice = null;
  entrySymbol = "";
  peakPrice = null;
  profitLockArmed = false;
  entryMeta = { tv_exchange: null, tv_instrument: null };
  console.log(`🧽 POSITION context cleared (${reason})`);
}

function startCooldown(reason = "exit", minutesOverride = null) {
  const mins = minutesOverride != null ? minutesOverride : EXIT_COOLDOWN_MIN;
  if (!mins || mins <= 0) return;
  cooldownUntilMs = nowMs() + mins * 60 * 1000;
  console.log(`⏳ Cooldown started (${mins} min) reason=${reason}`);
}

function startCrashLock(reason = "crash", minutesOverride = null) {
  const mins = minutesOverride != null ? minutesOverride : CRASH_COOLDOWN_MIN;
  if (!mins || mins <= 0) return;
  crashLockUntilMs = nowMs() + mins * 60 * 1000;
  console.log(`🛑 CrashLock started (${mins} min) reason=${reason}`);
}

function crashLockActive() {
  return crashLockUntilMs && nowMs() < crashLockUntilMs;
}

function cooldownActive() {
  return cooldownUntilMs && nowMs() < cooldownUntilMs;
}

function conservativeModeActive() {
  return conservativeUntilMs && nowMs() < conservativeUntilMs;
}

function ttlExpired() {
  if (!READY_TTL_MIN || READY_TTL_MIN <= 0) return false;
  return readyOn && nowMs() - readyAtMs > READY_TTL_MIN * 60 * 1000;
}

function isHeartbeatFresh() {
  if (!REQUIRE_FRESH_HEARTBEAT) return true;
  if (!lastTickMs) return false;
  return nowMs() - lastTickMs <= HEARTBEAT_MAX_AGE_SEC * 1000;
}

function getSymbolFromPayload(payload) {
  if (payload?.symbol) return String(payload.symbol);
  if (payload?.tv_exchange && payload?.tv_instrument)
    return `${payload.tv_exchange}:${payload.tv_instrument}`;
  if (payload?.exchange && payload?.ticker)
    return `${payload.exchange}:${payload.ticker}`;
  if (payload?.tv_instrument) return String(payload.tv_instrument);
  if (payload?.ticker) return String(payload.ticker);
  return "";
}

function getReadyPrice(payload) {
  return (
    toNum(payload?.trigger_price) ??
    toNum(payload?.price) ??
    toNum(payload?.close) ??
    null
  );
}

function getRayPrice(payload) {
  return toNum(payload?.price) ?? toNum(payload?.close) ?? toNum(payload?.trigger_price) ?? null;
}

function getTickPrice(payload) {
  return toNum(payload?.price) ?? toNum(payload?.close) ?? null;
}

// Re-entry helpers
function startReentryWindow(exitPrice, symbol, regime, reason) {
  if (!REENTRY_ENABLED) return;
  if (!Number.isFinite(exitPrice)) return;

  reentryActive = true;
  reentryUntilMs = nowMs() + REENTRY_WINDOW_MIN * 60 * 1000;
  reentryPrice = exitPrice;
  reentrySymbol = symbol || "";
  reentryRegimeAtExit = regime || "RANGE";
  reentryReason = reason || "exit";

  console.log(
    `🟣 REENTRY window started (${REENTRY_WINDOW_MIN}m) ref=${reentryPrice} fall<=${REENTRY_MAX_FALL_PCT}% rise<=${REENTRY_MAX_RISE_PCT}% regimeAtExit=${reentryRegimeAtExit} reason=${reentryReason}`
  );
}

function clearReentry(reason = "cleared") {
  if (!reentryActive) return;
  reentryActive = false;
  reentryUntilMs = 0;
  reentryPrice = null;
  reentrySymbol = "";
  reentryRegimeAtExit = "RANGE";
  reentryReason = "";
  console.log(`🧼 REENTRY cleared (${reason})`);
}

function reentryTimeOk() {
  return reentryActive && nowMs() <= reentryUntilMs;
}

function reentryPriceCheck(currentPrice) {
  if (!Number.isFinite(reentryPrice) || !Number.isFinite(currentPrice)) {
    return { ok: false, why: "missing_price" };
  }
  const fallPct = ((reentryPrice - currentPrice) / reentryPrice) * 100;
  const risePct = ((currentPrice - reentryPrice) / reentryPrice) * 100;

  if (fallPct > REENTRY_MAX_FALL_PCT) return { ok: false, why: "fall_breach", fallPct, risePct };
  if (risePct > REENTRY_MAX_RISE_PCT) return { ok: false, why: "rise_breach", fallPct, risePct };

  return { ok: true, fallPct, risePct };
}

function maybeAutoExpireReady(currentPrice, currentSymbol) {
  if (!READY_AUTOEXPIRE_ENABLED) return false;
  if (!readyOn) return false;
  if (inPosition) return false;
  if (readyPrice == null || currentPrice == null) return false;

  if (readySymbol && currentSymbol && readySymbol !== currentSymbol) return false;

  const dPct = pctDiff(readyPrice, currentPrice);
  if (dPct == null) return false;

  if (dPct > READY_AUTOEXPIRE_PCT) {
    console.log(
      `🟠 AUTO-EXPIRE READY: drift ${dPct.toFixed(3)}% > ${READY_AUTOEXPIRE_PCT}%`,
      { readyPrice, currentPrice }
    );
    clearReadyContext("auto_expire_drift");
    lastAction = "ready_autoexpired_drift";
    return true;
  }
  return false;
}

// Tick analytics
function pushTick(symbol, price, tMs) {
  if (!symbol || price == null) return;
  const arr = tickHistory.get(symbol) || [];
  arr.push({ t: tMs, p: price });
  const cutoff = tMs - TICK_BUFFER_SEC * 1000;
  while (arr.length && arr[0].t < cutoff) arr.shift();
  tickHistory.set(symbol, arr);
}

function priceAtOrBefore(symbol, targetMs) {
  const arr = tickHistory.get(symbol);
  if (!arr || arr.length === 0) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].t <= targetMs) return arr[i].p;
  }
  return arr[0]?.p ?? null;
}

function atrPctFromTicks(symbol, windowSec) {
  const arr = tickHistory.get(symbol);
  if (!arr || arr.length < 3) return null;

  const now = nowMs();
  const cutoff = now - windowSec * 1000;
  const sub = arr.filter((x) => x.t >= cutoff);
  if (sub.length < 3) return null;

  let sumTR = 0;
  let count = 0;
  for (let i = 1; i < sub.length; i++) {
    sumTR += Math.abs(sub[i].p - sub[i - 1].p);
    count++;
  }
  if (!count) return null;
  const atr = sumTR / count;
  const last = sub[sub.length - 1].p;
  if (!last) return null;
  return (atr / last) * 100.0;
}

function slopePct(symbol, windowSec) {
  const now = nowMs();
  const pNow = priceAtOrBefore(symbol, now);
  const pPast = priceAtOrBefore(symbol, now - windowSec * 1000);
  if (!Number.isFinite(pNow) || !Number.isFinite(pPast) || pPast === 0) return null;
  return ((pNow - pPast) / pPast) * 100.0;
}

function updateRegime(symbol) {
  if (!REGIME_ENABLED) return null;
  const arr = tickHistory.get(symbol);
  if (!arr || arr.length < REGIME_MIN_TICKS) return null;

  const s = slopePct(symbol, SLOPE_WINDOW_SEC);
  const atrP = atrPctFromTicks(symbol, ATR_WINDOW_SEC);
  if (s == null || atrP == null) return null;

  const prev = regimeState.get(symbol) || { regime: "RANGE", updatedMs: 0 };
  const absSlope = Math.abs(s);

  let next = prev.regime;

  if (prev.regime === "RANGE") {
    if (absSlope >= REGIME_TREND_SLOPE_ON_PCT && atrP >= REGIME_VOL_MIN_ATR_PCT) {
      next = "TREND";
    }
  } else {
    if (absSlope <= REGIME_TREND_SLOPE_OFF_PCT) {
      next = "RANGE";
    }
  }

  if (absSlope <= REGIME_RANGE_SLOPE_ON_PCT) next = "RANGE";
  if (absSlope >= REGIME_RANGE_SLOPE_OFF_PCT && atrP >= REGIME_VOL_MIN_ATR_PCT) {
    if (absSlope >= REGIME_TREND_SLOPE_ON_PCT) next = "TREND";
  }

  const st = {
    regime: next,
    updatedMs: nowMs(),
    slopePct: s,
    atrPct: atrP,
  };
  regimeState.set(symbol, st);

  if (prev.regime !== next) {
    console.log(
      `🔄 REGIME SWITCH: ${symbol} ${prev.regime} -> ${next} | slope=${s.toFixed(
        3
      )}% | atr=${atrP.toFixed(3)}%`
    );
  }
  return st;
}

function getRegime(symbol) {
  const st = regimeState.get(symbol);
  return st?.regime || "RANGE";
}

function effectiveReadyMaxMovePct(symbol) {
  if (!REGIME_ENABLED) return READY_MAX_MOVE_PCT;
  const r = getRegime(symbol);
  if (r === "TREND" && READY_MAX_MOVE_PCT_TREND != null) return READY_MAX_MOVE_PCT_TREND;
  if (r === "RANGE" && READY_MAX_MOVE_PCT_RANGE != null) return READY_MAX_MOVE_PCT_RANGE;
  return READY_MAX_MOVE_PCT;
}

function maybeCrashLock(symbol) {
  if (!CRASH_PROTECT_ENABLED) return false;
  if (!symbol) return false;

  const now = nowMs();
  const pNow = priceAtOrBefore(symbol, now);
  const p1m = priceAtOrBefore(symbol, now - 60 * 1000);
  const p5m = priceAtOrBefore(symbol, now - 300 * 1000);

  if (!Number.isFinite(pNow)) return false;

  let dump1m = null;
  let dump5m = null;

  if (Number.isFinite(p1m) && p1m !== 0) dump1m = ((pNow - p1m) / p1m) * 100.0;
  if (Number.isFinite(p5m) && p5m !== 0) dump5m = ((pNow - p5m) / p5m) * 100.0;

  if (dump1m != null && dump1m <= -CRASH_DUMP_1M_PCT) {
    startCrashLock(`dump_1m_${dump1m.toFixed(2)}%`);
    lastAction = "crash_lock_dump_1m";
    clearReadyContext("crash_lock_dump_1m");
    clearReentry("crash_lock_dump_1m");
    return { triggered: true, window: "1m", dumpPct: dump1m };
  }

  if (dump5m != null && dump5m <= -CRASH_DUMP_5M_PCT) {
    startCrashLock(`dump_5m_${dump5m.toFixed(2)}%`);
    lastAction = "crash_lock_dump_5m";
    clearReadyContext("crash_lock_dump_5m");
    clearReentry("crash_lock_dump_5m");
    return { triggered: true, window: "5m", dumpPct: dump5m };
  }

  return false;
}

// ---- 3Commas forwarder (with robust meta inference)
async function postTo3Commas(action, payload) {
  if (!THREECOMMAS_BOT_UUID || !THREECOMMAS_SECRET) {
    console.log("⚠️ 3Commas not configured (missing BOT_UUID/SECRET) — skipping");
    return { skipped: true };
  }

  // FIX: infer meta from symbol if missing
  const sym =
    getSymbolFromPayload(payload) || entrySymbol || readySymbol || lastTickSymbol || "";
  const inferred = inferTvMetaFromSymbol(sym);

  const tv_exchange =
    payload?.tv_exchange ??
    payload?.exchange ??
    entryMeta?.tv_exchange ??
    readyMeta?.tv_exchange ??
    inferred.tv_exchange ??
    THREECOMMAS_TV_EXCHANGE ??
    "";

  const tv_instrument =
    payload?.tv_instrument ??
    payload?.ticker ??
    entryMeta?.tv_instrument ??
    readyMeta?.tv_instrument ??
    inferred.tv_instrument ??
    THREECOMMAS_TV_INSTRUMENT ??
    "";

  const trigger_price =
    toNum(payload?.trigger_price) ??
    toNum(payload?.price) ??
    toNum(payload?.close) ??
    readyPrice ??
    lastTickPrice ??
    "";

  const body = {
    secret: THREECOMMAS_SECRET,
    max_lag: THREECOMMAS_MAX_LAG,
    timestamp: payload?.timestamp ?? payload?.time ?? new Date().toISOString(),
    trigger_price: trigger_price !== "" ? String(trigger_price) : "",
    tv_exchange: String(tv_exchange || ""),
    tv_instrument: String(tv_instrument || ""),
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
    return { ok: resp.ok, status: resp.status, resp: text, sent: body };
  } catch (e) {
    console.log(
      "⛔ 3Commas POST failed:",
      e?.name === "AbortError" ? "timeout" : (e?.message || e)
    );
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

function noteExitForEquity(exitPrice) {
  if (!EQUITY_STABILIZER_ENABLED) return;
  const p = pctProfit(entryPrice, exitPrice);
  if (p == null) return;

  if (p < 0) lossStreak += 1;
  else lossStreak = 0;

  console.log(`📉 Equity: exitPnL=${p.toFixed(3)}% | lossStreak=${lossStreak}`);

  if (lossStreak >= 3) {
    const until = nowMs() + ES_CONSERVATIVE_MIN * 60 * 1000;
    conservativeUntilMs = Math.max(conservativeUntilMs || 0, until);
    startCooldown("equity_loss_streak_3", ES_LOSS_STREAK_3_COOLDOWN_MIN);
    console.log(`🧯 Conservative mode ON for ${ES_CONSERVATIVE_MIN} min`);
  } else if (lossStreak >= 2) {
    startCooldown("equity_loss_streak_2", ES_LOSS_STREAK_2_COOLDOWN_MIN);
  }
}

// Profit lock evaluator (runs on each tick)
async function maybeProfitLockExit(currentPrice, currentSymbol) {
  if (!PROFIT_LOCK_ENABLED) return false;
  if (!inPosition) return false;
  if (!entryPrice || currentPrice == null) return false;
  if (entrySymbol && currentSymbol && entrySymbol !== currentSymbol) return false;

  peakPrice = peakPrice == null ? currentPrice : Math.max(peakPrice, currentPrice);

  const p = pctProfit(entryPrice, currentPrice);
  if (p == null) return false;

  let armPct = PROFIT_LOCK_ARM_PCT;
  let givebackPct = PROFIT_LOCK_GIVEBACK_PCT;

  if (PL_ADAPTIVE_ENABLED && REGIME_ENABLED) {
    const st = regimeState.get(currentSymbol);
    const atrP = st?.atrPct ?? atrPctFromTicks(currentSymbol, ATR_WINDOW_SEC);
    if (atrP != null) {
      const r = getRegime(currentSymbol);
      const startMult = r === "TREND" ? PL_START_ATR_MULT_TREND : PL_START_ATR_MULT_RANGE;
      const giveMult = r === "TREND" ? PL_GIVEBACK_ATR_MULT_TREND : PL_GIVEBACK_ATR_MULT_RANGE;
      armPct = startMult * atrP;
      givebackPct = giveMult * atrP;
    }
  } else if (PL_ADAPTIVE_ENABLED && !REGIME_ENABLED) {
    const atrP = atrPctFromTicks(currentSymbol, ATR_WINDOW_SEC);
    if (atrP != null) {
      armPct = PL_START_ATR_MULT_TREND * atrP;
      givebackPct = PL_GIVEBACK_ATR_MULT_TREND * atrP;
    }
  }

  if (PL_MIN_ARM_PCT > 0) armPct = Math.max(armPct, PL_MIN_ARM_PCT);
  if (PL_MIN_GIVEBACK_PCT > 0) givebackPct = Math.max(givebackPct, PL_MIN_GIVEBACK_PCT);
  if (PL_MAX_ARM_PCT > 0) armPct = Math.min(armPct, PL_MAX_ARM_PCT);
  if (PL_MAX_GIVEBACK_PCT > 0) givebackPct = Math.min(givebackPct, PL_MAX_GIVEBACK_PCT);

  if (!profitLockArmed && p >= armPct) {
    profitLockArmed = true;
    console.log(`🔒 PROFIT LOCK ARMED at +${p.toFixed(3)}% (>= ${armPct.toFixed(3)}%)`);
  }
  if (!profitLockArmed) return false;

  const floor = peakPrice * (1 - givebackPct / 100);
  if (currentPrice <= floor) {
    console.log(
      `🧷 PROFIT LOCK EXIT: price=${currentPrice} <= floor=${floor.toFixed(
        4
      )} | peak=${peakPrice} | giveback=${givebackPct.toFixed(3)}%`
    );

    lastAction = "profit_lock_exit_long";

    const fwd = await postTo3Commas("exit_long", {
      time: new Date().toISOString(),
      trigger_price: currentPrice,
      symbol: currentSymbol,
    });

    noteExitForEquity(currentPrice);

    startReentryWindow(
      currentPrice,
      entrySymbol || currentSymbol || "",
      currentSymbol ? getRegime(currentSymbol) : "RANGE",
      "profit_lock_exit"
    );

    clearReadyContext("profit_lock_exit");
    clearPositionContext("profit_lock_exit");
    startCooldown("profit_lock_exit");
    return { exited: true, threecommas: fwd };
  }

  return false;
}

// ====================
// ENTRY/EXIT handlers
// ====================
async function handleEnterLong(payload, res, sourceTag) {
  const rayPx = getRayPrice(payload);
  const raySym = getSymbolFromPayload(payload);

  const reentryCandidate =
    REENTRY_ENABLED &&
    !readyOn &&
    !REENTRY_REQUIRE_READY &&
    reentryTimeOk() &&
    (rayPx != null || lastTickPrice != null);

  if (crashLockActive()) {
    lastAction = "enter_long_blocked_crash_lock";
    return res.json({ ok: false, blocked: "crash_lock_active" });
  }

  if (cooldownActive() && !reentryCandidate) {
    lastAction = "enter_long_blocked_cooldown";
    return res.json({ ok: false, blocked: "cooldown_active" });
  }

  if (!isHeartbeatFresh()) {
    lastAction = "enter_long_blocked_stale_heartbeat";
    return res.json({ ok: false, blocked: "stale_heartbeat" });
  }

  if (inPosition) {
    lastAction = "enter_long_blocked_in_position";
    return res.json({ ok: false, blocked: "already_in_position" });
  }

  if (conservativeModeActive()) {
    const reg = raySym ? getRegime(raySym) : "RANGE";
    if (reg !== "TREND") {
      lastAction = "enter_long_blocked_conservative_range";
      return res.json({ ok: false, blocked: "conservative_blocks_range", regime: reg });
    }
  }

  let usingReentry = false;

  if (!readyOn) {
    if (REENTRY_REQUIRE_READY) {
      lastAction = "enter_long_blocked_not_ready";
      return res.json({ ok: false, blocked: "not_ready" });
    }

    if (!REENTRY_ENABLED || !reentryTimeOk()) {
      lastAction = "enter_long_blocked_not_ready";
      return res.json({ ok: false, blocked: "not_ready" });
    }

    if (reentrySymbol && raySym && reentrySymbol !== raySym) {
      if (REENTRY_CANCEL_ON_BREACH) clearReentry("symbol_mismatch");
      lastAction = "enter_long_blocked_reentry_symbol_mismatch";
      return res.json({ ok: false, blocked: "reentry_symbol_mismatch", reentrySymbol, raySym });
    }

    const curReg = raySym ? getRegime(raySym) : "RANGE";
    if (REENTRY_REQUIRE_TREND && curReg !== "TREND") {
      lastAction = "enter_long_blocked_reentry_not_trend";
      return res.json({ ok: false, blocked: "reentry_not_trend", regime: curReg });
    }

    const pxNow = rayPx ?? lastTickPrice;
    const chk = reentryPriceCheck(pxNow);
    if (!chk.ok) {
      if (REENTRY_CANCEL_ON_BREACH) clearReentry(`price_${chk.why}`);
      lastAction = "enter_long_blocked_reentry_price_guard";
      return res.json({
        ok: false,
        blocked: "reentry_price_guard",
        why: chk.why,
        fallPct: chk.fallPct,
        risePct: chk.risePct,
        ref: reentryPrice,
      });
    }

    if (cooldownActive() && reentryCandidate) {
      console.log("🟣 REENTRY bypassing cooldown (valid re-entry candidate)");
    }

    usingReentry = true;
    console.log(
      `🟣 REENTRY allowed (${sourceTag}) fall=${chk.fallPct.toFixed(3)}% rise=${chk.risePct.toFixed(
        3
      )}% ref=${reentryPrice} regime=${curReg}`
    );
  } else {
    if (readySymbol && raySym && readySymbol !== raySym) {
      lastAction = "enter_long_blocked_symbol_mismatch";
      return res.json({ ok: false, blocked: "symbol_mismatch", readySymbol, raySym });
    }

    if (readyPrice == null || rayPx == null) {
      lastAction = "enter_long_blocked_missing_prices";
      return res.json({ ok: false, blocked: "missing_prices" });
    }

    const dPct = pctDiff(readyPrice, rayPx);
    if (dPct == null) {
      lastAction = "enter_long_blocked_bad_price_diff";
      return res.json({ ok: false, blocked: "bad_price_diff" });
    }

    const maxMove = effectiveReadyMaxMovePct(raySym || readySymbol);

    if (dPct > maxMove) {
      console.log(
        `⛔ ENTER LONG blocked (drift ${dPct.toFixed(3)}% > ${maxMove}%) — HARD RESET READY`
      );
      clearReadyContext("hard_reset_price_drift");
      lastAction = "enter_long_blocked_price_drift_reset";
      return res.json({ ok: false, blocked: "price_drift_reset", drift_pct: dPct, maxMove });
    }
  }

  if (rayPx == null) {
    lastAction = "enter_long_blocked_missing_prices";
    return res.json({ ok: false, blocked: "missing_prices" });
  }

  inPosition = true;
  entryPrice = rayPx;
  entrySymbol = raySym || readySymbol || reentrySymbol || "";
  peakPrice = rayPx;
  profitLockArmed = false;

  // FIX: ensure entryMeta always has tv_exchange/tv_instrument even if READY is cleared
  const inferred = inferTvMetaFromSymbol(entrySymbol);
  entryMeta = {
    tv_exchange:
      readyMeta?.tv_exchange ??
      payload?.tv_exchange ??
      payload?.exchange ??
      inferred.tv_exchange ??
      null,
    tv_instrument:
      readyMeta?.tv_instrument ??
      payload?.tv_instrument ??
      payload?.ticker ??
      inferred.tv_instrument ??
      null,
  };

  if (usingReentry) clearReentry("used");

  lastAction = "enter_long";
  console.log(
    `🚀 ENTER LONG (${sourceTag}${usingReentry ? "+reentry" : ""}) | regime=${getRegime(entrySymbol)}`
  );

  const fwd = await postTo3Commas("enter_long", {
    ...payload,
    symbol: entrySymbol,
    trigger_price: payload?.price ?? payload?.close ?? payload?.trigger_price ?? readyPrice ?? rayPx,
    tv_exchange: entryMeta?.tv_exchange,
    tv_instrument: entryMeta?.tv_instrument,
  });

  return res.json({
    ok: true,
    action: "enter_long",
    source: sourceTag,
    usingReentry,
    threecommas: fwd,
  });
}

async function handleExitLong(payload, res, sourceTag) {
  const rayPx = getRayPrice(payload);
  const raySym = getSymbolFromPayload(payload);

  if (!inPosition) {
    lastAction = "exit_long_no_position";
    return res.json({ ok: false, blocked: "no_position" });
  }

  if (PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT > 0) {
    const px = rayPx ?? lastTickPrice;
    const p = pctProfit(entryPrice, px);
    if (p != null && p < PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT) {
      lastAction = "exit_long_blocked_profit_filter";
      console.log(
        `⛔ EXIT LONG ignored: profit ${p.toFixed(3)}% < ${PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT}%`
      );
      return res.json({ ok: false, blocked: "profit_filter", profit_pct: p });
    }
  }

  lastAction = "exit_long";

  const exitPx = rayPx ?? lastTickPrice ?? null;

  const fwd = await postTo3Commas("exit_long", {
    ...payload,
    symbol: entrySymbol || raySym || "",
    trigger_price: payload?.price ?? payload?.close ?? payload?.trigger_price ?? "",
  });

  if (exitPx != null) noteExitForEquity(exitPx);

  startReentryWindow(
    exitPx,
    entrySymbol || raySym || "",
    (entrySymbol || raySym) ? getRegime(entrySymbol || raySym) : "RANGE",
    `exit_${sourceTag}`
  );

  clearReadyContext("exit_long");
  clearPositionContext("exit_long");
  startCooldown(sourceTag);

  console.log(`✅ EXIT LONG (${sourceTag})`);
  return res.json({ ok: true, action: "exit_long", source: sourceTag, threecommas: fwd });
}

// ====================
// ROUTES
// ====================
app.get("/", (req, res) => {
  res.json({
    brain: BRAIN_VERSION,

    readyOn,
    inPosition,
    lastAction,

    READY_TTL_MIN,
    READY_MAX_MOVE_PCT,
    READY_MAX_MOVE_PCT_TREND,
    READY_MAX_MOVE_PCT_RANGE,
    READY_AUTOEXPIRE_ENABLED,
    READY_AUTOEXPIRE_PCT,
    EXIT_COOLDOWN_MIN,

    cooldownActive: cooldownActive(),
    cooldownUntilMs,

    crashLockActive: crashLockActive(),
    crashLockUntilMs,

    REQUIRE_FRESH_HEARTBEAT,
    HEARTBEAT_MAX_AGE_SEC,
    lastTickMs,
    lastTickSymbol,
    lastTickPrice,

    REENTRY_ENABLED,
    REENTRY_WINDOW_MIN,
    REENTRY_MAX_FALL_PCT,
    REENTRY_MAX_RISE_PCT,
    REENTRY_REQUIRE_TREND,
    REENTRY_REQUIRE_READY,
    REENTRY_CANCEL_ON_BREACH,
    reentryActive,
    reentryUntilMs,
    reentryPrice,
    reentrySymbol,
    reentryRegimeAtExit,
    reentryReason,

    PROFIT_LOCK_ENABLED,
    PL_ADAPTIVE_ENABLED,
    PROFIT_LOCK_ARM_PCT,
    PROFIT_LOCK_GIVEBACK_PCT,
    PL_START_ATR_MULT_TREND,
    PL_GIVEBACK_ATR_MULT_TREND,
    PL_START_ATR_MULT_RANGE,
    PL_GIVEBACK_ATR_MULT_RANGE,
    PL_MIN_ARM_PCT,
    PL_MIN_GIVEBACK_PCT,
    PL_MAX_ARM_PCT,
    PL_MAX_GIVEBACK_PCT,
    PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT,

    REGIME_ENABLED,
    SLOPE_WINDOW_SEC,
    ATR_WINDOW_SEC,
    TICK_BUFFER_SEC,
    REGIME_MIN_TICKS,
    REGIME_TREND_SLOPE_ON_PCT,
    REGIME_TREND_SLOPE_OFF_PCT,
    REGIME_VOL_MIN_ATR_PCT,

    CRASH_PROTECT_ENABLED,
    CRASH_DUMP_1M_PCT,
    CRASH_DUMP_5M_PCT,
    CRASH_COOLDOWN_MIN,

    EQUITY_STABILIZER_ENABLED,
    lossStreak,
    conservativeModeActive: conservativeModeActive(),
    conservativeUntilMs,

    readyPrice,
    readySymbol,
    readyTf,
    entryPrice,
    entrySymbol,
    peakPrice,
    profitLockArmed,
    entryMeta,

    regime: lastTickSymbol ? regimeState.get(lastTickSymbol) || null : null,
    threecommas_configured: Boolean(THREECOMMAS_BOT_UUID && THREECOMMAS_SECRET),
    READY_ACCEPT_LEGACY_READY,
  });
});

app.post("/webhook", async (req, res) => {
  const payload = req.body || {};
  logWebhook(payload);

  if (ttlExpired()) {
    clearReadyContext("ttl_expired");
    lastAction = "ready_ttl_expired";
  }

  if (!checkSecret(payload)) {
    console.log("⛔ Secret mismatch - blocked");
    return res.status(401).json({ ok: false, error: "secret_mismatch" });
  }

  const intent = normalizeIntent(payload);

  if (intent === "tick") {
    const tickPx = getTickPrice(payload);
    const tickSym = getSymbolFromPayload(payload);

    if (tickPx == null || !tickSym) {
      console.log("⚠️ Tick ignored (missing price or symbol)");
      return res.json({ ok: true, tick: true, ignored: "missing_fields" });
    }

    lastTickMs = nowMs();
    lastTickSymbol = tickSym;
    lastTickPrice = tickPx;

    pushTick(tickSym, tickPx, lastTickMs);

    const r = updateRegime(tickSym);
    const crash = maybeCrashLock(tickSym);
    const expired = maybeAutoExpireReady(tickPx, tickSym);
    const pl = await maybeProfitLockExit(tickPx, tickSym);

    if (reentryActive && !reentryTimeOk()) clearReentry("window_expired");

    return res.json({
      ok: true,
      tick: true,
      regime: r || regimeState.get(tickSym) || null,
      crash: crash || null,
      expired,
      profit_lock: pl || null,
      readyOn,
      inPosition,
      crashLockActive: crashLockActive(),
      conservativeModeActive: conservativeModeActive(),
      reentryActive,
    });
  }

  if (intent === "ready_long" || (READY_ACCEPT_LEGACY_READY && intent === "ready")) {
    if (crashLockActive()) {
      console.log("🟡 READY_LONG ignored (crash lock active)");
      lastAction = "ready_long_ignored_crash_lock";
      return res.json({ ok: true, ignored: "crash_lock_active" });
    }

    if (cooldownActive()) {
      console.log("🟡 READY_LONG ignored (cooldown active)");
      lastAction = "ready_long_ignored_cooldown";
      return res.json({ ok: true, ignored: "cooldown_active" });
    }

    if (!isHeartbeatFresh()) {
      console.log("🟡 READY_LONG ignored (stale heartbeat)");
      lastAction = "ready_long_ignored_stale_heartbeat";
      return res.json({ ok: true, ignored: "stale_heartbeat" });
    }

    if (inPosition) {
      console.log("🟡 READY_LONG ignored (already in position)");
      lastAction = "ready_long_ignored_in_position";
      return res.json({ ok: true, ignored: "in_position" });
    }

    if (conservativeModeActive()) {
      console.log("🟠 READY_LONG received during conservative mode (will restrict buys)");
    }

    readyOn = true;
    readyAtMs = nowMs();

    readyPrice = getReadyPrice(payload);
    readySymbol = getSymbolFromPayload(payload);
    readyTf = payload?.tf ? String(payload.tf) : "";

    readyMeta = {
      timestamp: payload?.timestamp ?? payload?.time ?? null,
      tv_exchange: payload?.tv_exchange ?? payload?.exchange ?? null,
      tv_instrument: payload?.tv_instrument ?? payload?.ticker ?? null,
    };

    clearReentry("ready_long_refresh");

    lastAction = "ready_long_set";
    console.log("🟢 READY_LONG ON", {
      readyPrice,
      readySymbol,
      readyTf,
      READY_MAX_MOVE_PCT,
      READY_AUTOEXPIRE_ENABLED,
      READY_AUTOEXPIRE_PCT,
      regime: readySymbol ? getRegime(readySymbol) : null,
    });

    return res.json({
      ok: true,
      readyOn,
      action: "ready_long",
      readyPrice,
      readySymbol,
      readyTf,
      regime: readySymbol ? regimeState.get(readySymbol) || null : null,
    });
  }

  if (intent === "enter_long") return handleEnterLong(payload, res, "intent_enter_long");
  if (intent === "exit_long") return handleExitLong(payload, res, "intent_exit_long");

  if (String(payload?.src || "").toLowerCase() === "ray") {
    const side = String(payload.side || "").toUpperCase();
    if (side === "BUY") return handleEnterLong(payload, res, "ray_side_buy");
    if (side === "SELL") return handleExitLong(payload, res, "ray_side_sell");
    lastAction = "ray_unknown_side";
    return res.json({ ok: true, note: "ray_unknown_side" });
  }

  lastAction = "unknown";
  return res.json({ ok: true, note: "unknown" });
});

// ====================
// START
// ====================
app.listen(PORT, () => {
  console.log(`✅ Brain ${BRAIN_VERSION} listening on port ${PORT}`);
  console.log(
    `Config: READY_TTL_MIN=${READY_TTL_MIN} | READY_MAX_MOVE_PCT=${READY_MAX_MOVE_PCT} | READY_AUTOEXPIRE_ENABLED=${READY_AUTOEXPIRE_ENABLED} | READY_AUTOEXPIRE_PCT=${READY_AUTOEXPIRE_PCT} | EXIT_COOLDOWN_MIN=${EXIT_COOLDOWN_MIN}`
  );
  console.log(
    `ReEntry: ENABLED=${REENTRY_ENABLED} | window=${REENTRY_WINDOW_MIN}m | fall<=${REENTRY_MAX_FALL_PCT}% | rise<=${REENTRY_MAX_RISE_PCT}% | reqTrend=${REENTRY_REQUIRE_TREND} | reqReady=${REENTRY_REQUIRE_READY} | cancelOnBreach=${REENTRY_CANCEL_ON_BREACH}`
  );
  console.log(
    `Heartbeat: REQUIRE_FRESH_HEARTBEAT=${REQUIRE_FRESH_HEARTBEAT} | HEARTBEAT_MAX_AGE_SEC=${HEARTBEAT_MAX_AGE_SEC}`
  );
  console.log(
    `Regime: ENABLED=${REGIME_ENABLED} | slopeWin=${SLOPE_WINDOW_SEC}s | atrWin=${ATR_WINDOW_SEC}s | trendOn=${REGIME_TREND_SLOPE_ON_PCT}% | trendOff=${REGIME_TREND_SLOPE_OFF_PCT}% | volMinATR=${REGIME_VOL_MIN_ATR_PCT}%`
  );
  console.log(
    `CrashProtect: ENABLED=${CRASH_PROTECT_ENABLED} | dump1m=${CRASH_DUMP_1M_PCT}% | dump5m=${CRASH_DUMP_5M_PCT}% | cooldown=${CRASH_COOLDOWN_MIN}m`
  );
  console.log(
    `EquityStab: ENABLED=${EQUITY_STABILIZER_ENABLED} | loss2_cd=${ES_LOSS_STREAK_2_COOLDOWN_MIN}m | loss3_cd=${ES_LOSS_STREAK_3_COOLDOWN_MIN}m | conservative=${ES_CONSERVATIVE_MIN}m`
  );
  console.log(
    `ProfitLock: ENABLED=${PROFIT_LOCK_ENABLED} | ADAPTIVE=${PL_ADAPTIVE_ENABLED} | fixedArm=${PROFIT_LOCK_ARM_PCT}% | fixedGive=${PROFIT_LOCK_GIVEBACK_PCT}% | TREND(start=${PL_START_ATR_MULT_TREND}x give=${PL_GIVEBACK_ATR_MULT_TREND}x) | RANGE(start=${PL_START_ATR_MULT_RANGE}x give=${PL_GIVEBACK_ATR_MULT_RANGE}x)`
  );
  console.log(
    `ProfitLockClamps: MIN_ARM=${PL_MIN_ARM_PCT}% | MIN_GIVE=${PL_MIN_GIVEBACK_PCT}% | MAX_ARM=${PL_MAX_ARM_PCT}% | MAX_GIVE=${PL_MAX_GIVEBACK_PCT}%`
  );
  console.log(
    `3Commas: URL=${THREECOMMAS_WEBHOOK_URL} | BOT_UUID=${THREECOMMAS_BOT_UUID ? "(set)" : "(missing)"} | SECRET=${
      THREECOMMAS_SECRET ? "(set)" : "(missing)"
    } | TIMEOUT_MS=${THREECOMMAS_TIMEOUT_MS}`
  );
});
