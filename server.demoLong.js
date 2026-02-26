/**
 * Brain v2.9.2-LONG — READY_LONG + Ray gatekeeper + 3Commas + Regime + Adaptive PL + CrashLock + Equity + ReEntry v2 + PendingBUY
 * ---------------------------------------------------------------------------------------------------------------
 * Adds:
 * ✅ ReEntry Rule A: window starts on FIRST exit, later exits DO NOT extend time (but can refresh ref price)
 * ✅ REENTRY_MAX_TRIES: allow up to N re-entry BUYs per window (default 2)
 * ✅ REENTRY_SKIP_START_IF_EXIT_PNL_LE_PCT: don't start/refresh re-entry window if exit PnL <= threshold (e.g. -0.35)
 * ✅ Pending BUY buffer (Pink fix): if Ray BUY arrives before READY_LONG, remember it briefly and auto-enter on READY_LONG
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const BRAIN_VERSION = "v2.9.2-LONG";

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

// Optional per-regime drift overrides
const READY_MAX_MOVE_PCT_TREND = toNumEnv(process.env.READY_MAX_MOVE_PCT_TREND);
const READY_MAX_MOVE_PCT_RANGE = toNumEnv(process.env.READY_MAX_MOVE_PCT_RANGE);

// Auto-expire drift gate (READY auto-clears if price drifts too far)
const READY_AUTOEXPIRE_PCT = Number(process.env.READY_AUTOEXPIRE_PCT || String(READY_MAX_MOVE_PCT));
const READY_AUTOEXPIRE_ENABLED =
  String(process.env.READY_AUTOEXPIRE_ENABLED || "true").toLowerCase() === "true";

// Cooldown after exit (minutes). 0 = disabled
const EXIT_COOLDOWN_MIN = Number(process.env.EXIT_COOLDOWN_MIN || "0");

// Heartbeat safety
const REQUIRE_FRESH_HEARTBEAT =
  String(process.env.REQUIRE_FRESH_HEARTBEAT || "true").toLowerCase() === "true";
const HEARTBEAT_MAX_AGE_SEC = Number(process.env.HEARTBEAT_MAX_AGE_SEC || "240");

// Profit Lock (trailing)
const PROFIT_LOCK_ENABLED =
  String(process.env.PROFIT_LOCK_ENABLED || "true").toLowerCase() === "true";

// Fixed PL fallback
const PROFIT_LOCK_ARM_PCT = Number(process.env.PROFIT_LOCK_ARM_PCT || "0.7");
const PROFIT_LOCK_GIVEBACK_PCT = Number(process.env.PROFIT_LOCK_GIVEBACK_PCT || "0.5");

// Adaptive PL
const PL_ADAPTIVE_ENABLED =
  String(process.env.PL_ADAPTIVE_ENABLED || "true").toLowerCase() === "true";

const PL_START_ATR_MULT_TREND = Number(process.env.PL_START_ATR_MULT_TREND || "2.2");
const PL_GIVEBACK_ATR_MULT_TREND = Number(process.env.PL_GIVEBACK_ATR_MULT_TREND || "1.2");
const PL_START_ATR_MULT_RANGE = Number(process.env.PL_START_ATR_MULT_RANGE || "1.4");
const PL_GIVEBACK_ATR_MULT_RANGE = Number(process.env.PL_GIVEBACK_ATR_MULT_RANGE || "0.9");

// PL clamps
const PL_MIN_ARM_PCT = Number(process.env.PL_MIN_ARM_PCT || "0.4");
const PL_MIN_GIVEBACK_PCT = Number(process.env.PL_MIN_GIVEBACK_PCT || "0.3");
const PL_MAX_ARM_PCT = Number(process.env.PL_MAX_ARM_PCT || "3.0");
const PL_MAX_GIVEBACK_PCT = Number(process.env.PL_MAX_GIVEBACK_PCT || "1.5");

// Optional: ignore Ray SELL unless profit >= this % (0 disables)
const PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT = Number(
  process.env.PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT || "0"
);

// Regime switching
const REGIME_ENABLED =
  String(process.env.REGIME_ENABLED || "true").toLowerCase() === "true";

const SLOPE_WINDOW_SEC = Number(process.env.SLOPE_WINDOW_SEC || "1800");
const ATR_WINDOW_SEC = Number(process.env.ATR_WINDOW_SEC || "1800");
const TICK_BUFFER_SEC = Number(process.env.TICK_BUFFER_SEC || "1800");
const REGIME_MIN_TICKS = Number(process.env.REGIME_MIN_TICKS || "10");

const REGIME_TREND_SLOPE_ON_PCT = Number(process.env.REGIME_TREND_SLOPE_ON_PCT || "0.30");
const REGIME_TREND_SLOPE_OFF_PCT = Number(process.env.REGIME_TREND_SLOPE_OFF_PCT || "0.20");
const REGIME_RANGE_SLOPE_ON_PCT = Number(process.env.REGIME_RANGE_SLOPE_ON_PCT || "0.12");
const REGIME_RANGE_SLOPE_OFF_PCT = Number(process.env.REGIME_RANGE_SLOPE_OFF_PCT || "0.16");
const REGIME_VOL_MIN_ATR_PCT = Number(process.env.REGIME_VOL_MIN_ATR_PCT || "0.20");

// Crash protection
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

// Re-entry
const REENTRY_ENABLED =
  String(process.env.REENTRY_ENABLED || "true").toLowerCase() === "true";
const REENTRY_WINDOW_MIN = Number(process.env.REENTRY_WINDOW_MIN || "30");
const REENTRY_MAX_FALL_PCT = Number(process.env.REENTRY_MAX_FALL_PCT || "0.5");
const REENTRY_MAX_RISE_PCT = Number(process.env.REENTRY_MAX_RISE_PCT || "0.8");
const REENTRY_REQUIRE_TREND =
  String(process.env.REENTRY_REQUIRE_TREND || "false").toLowerCase() === "true";
const REENTRY_REQUIRE_READY =
  String(process.env.REENTRY_REQUIRE_READY || "false").toLowerCase() === "true";
const REENTRY_CANCEL_ON_BREACH =
  String(process.env.REENTRY_CANCEL_ON_BREACH || "true").toLowerCase() === "true";
const REENTRY_MAX_TRIES = Number(process.env.REENTRY_MAX_TRIES || "2");
const REENTRY_SKIP_START_IF_EXIT_PNL_LE_PCT = Number(
  process.env.REENTRY_SKIP_START_IF_EXIT_PNL_LE_PCT || "-0.35"
);

// Pending BUY buffer (Pink fix)
const PENDING_BUY_ENABLED =
  String(process.env.PENDING_BUY_ENABLED || "true").toLowerCase() === "true";
const PENDING_BUY_WINDOW_SEC = Number(process.env.PENDING_BUY_WINDOW_SEC || "120");
// How far pending BUY price can differ from READY price when READY arrives
const PENDING_BUY_MAX_READY_DRIFT_PCT = Number(process.env.PENDING_BUY_MAX_READY_DRIFT_PCT || "0.30");

// 3Commas
const THREECOMMAS_WEBHOOK_URL =
  process.env.THREECOMMAS_WEBHOOK_URL || "https://api.3commas.io/signal_bots/webhooks";
const THREECOMMAS_BOT_UUID = process.env.THREECOMMAS_BOT_UUID || "";
const THREECOMMAS_SECRET = process.env.THREECOMMAS_SECRET || "";
const THREECOMMAS_MAX_LAG = String(process.env.THREECOMMAS_MAX_LAG || "300");
const THREECOMMAS_TIMEOUT_MS = Number(process.env.THREECOMMAS_TIMEOUT_MS || "8000");

// Optional fallbacks
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
let reentryRefPrice = null;
let reentrySymbol = "";
let reentryRegimeAtExit = "RANGE";
let reentryReason = "";
let reentryTriesUsed = 0;

// Pending BUY state (Pink)
let pendingBuy = null; // { untilMs, payload, price, symbol }

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
  return toNum(payload?.trigger_price) ?? toNum(payload?.price) ?? toNum(payload?.close) ?? null;
}

function getRayPrice(payload) {
  return toNum(payload?.price) ?? toNum(payload?.close) ?? toNum(payload?.trigger_price) ?? null;
}

function getTickPrice(payload) {
  return toNum(payload?.price) ?? toNum(payload?.close) ?? null;
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

// ---- Tick analytics buffer
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
    if (absSlope >= REGIME_TREND_SLOPE_ON_PCT && atrP >= REGIME_VOL_MIN_ATR_PCT) next = "TREND";
  } else {
    if (absSlope <= REGIME_TREND_SLOPE_OFF_PCT) next = "RANGE";
  }

  if (absSlope <= REGIME_RANGE_SLOPE_ON_PCT) next = "RANGE";
  if (absSlope >= REGIME_RANGE_SLOPE_OFF_PCT && atrP >= REGIME_VOL_MIN_ATR_PCT) {
    if (absSlope >= REGIME_TREND_SLOPE_ON_PCT) next = "TREND";
  }

  const st = { regime: next, updatedMs: nowMs(), slopePct: s, atrPct: atrP };
  regimeState.set(symbol, st);

  if (prev.regime !== next) {
    console.log(
      `🔄 REGIME SWITCH: ${symbol} ${prev.regime} -> ${next} | slope=${s.toFixed(3)}% | atr=${atrP.toFixed(3)}%`
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
    return { triggered: true, window: "1m", dumpPct: dump1m };
  }

  if (dump5m != null && dump5m <= -CRASH_DUMP_5M_PCT) {
    startCrashLock(`dump_5m_${dump5m.toFixed(2)}%`);
    lastAction = "crash_lock_dump_5m";
    clearReadyContext("crash_lock_dump_5m");
    return { triggered: true, window: "5m", dumpPct: dump5m };
  }

  return false;
}

// ====================
// RE-ENTRY (Rule A + MAX_TRIES + LossSkip)
// ====================
function reentryTimeOk() {
  return reentryActive && reentryUntilMs && nowMs() <= reentryUntilMs;
}

function reentryTriesLeft() {
  return reentryTriesUsed < REENTRY_MAX_TRIES;
}

function clearReentry(reason = "cleared") {
  reentryActive = false;
  reentryUntilMs = 0;
  reentryRefPrice = null;
  reentrySymbol = "";
  reentryRegimeAtExit = "RANGE";
  reentryReason = "";
  reentryTriesUsed = 0;
  console.log(`🧼 REENTRY cleared (${reason})`);
}

function startOrUpdateReentryWindow({ exitPrice, symbol, regimeAtExit, reason, exitPnlPct }) {
  if (!REENTRY_ENABLED) return;
  if (!Number.isFinite(exitPrice)) return;

  // ✅ LossSkip: if exitPnL is too negative, don't start/refresh
  if (Number.isFinite(exitPnlPct) && exitPnlPct <= REENTRY_SKIP_START_IF_EXIT_PNL_LE_PCT) {
    console.log(
      `🟤 REENTRY not started: exitPnL=${exitPnlPct.toFixed(3)}% <= ${REENTRY_SKIP_START_IF_EXIT_PNL_LE_PCT}%`
    );
    return;
  }

  const now = nowMs();

  // ✅ Rule A: don't extend time if already active and still valid
  if (reentryActive && reentryTimeOk()) {
    reentryRefPrice = exitPrice; // refresh ref (safer anchoring)
    reentrySymbol = symbol || reentrySymbol || "";
    reentryRegimeAtExit = regimeAtExit || reentryRegimeAtExit || "RANGE";
    reentryReason = reason || reentryReason || "exit";
    console.log(
      `🟣 REENTRY window kept (no reset) | until=${new Date(reentryUntilMs).toISOString()} | ref=${reentryRefPrice} tries=${reentryTriesUsed}/${REENTRY_MAX_TRIES} reason=${reentryReason}`
    );
    return;
  }

  // start new window
  reentryActive = true;
  reentryUntilMs = now + REENTRY_WINDOW_MIN * 60 * 1000;
  reentryRefPrice = exitPrice;
  reentrySymbol = symbol || "";
  reentryRegimeAtExit = regimeAtExit || "RANGE";
  reentryReason = reason || "exit";
  reentryTriesUsed = 0;

  console.log(
    `🟣 REENTRY window started (${REENTRY_WINDOW_MIN}m) ref=${reentryRefPrice} fall<=${REENTRY_MAX_FALL_PCT}% rise<=${REENTRY_MAX_RISE_PCT}% regimeAtExit=${reentryRegimeAtExit} reason=${reentryReason}`
  );
}

function reentryPriceCheck(currentPrice) {
  if (!Number.isFinite(reentryRefPrice) || reentryRefPrice === 0) return { ok: false, why: "bad_ref" };
  if (!Number.isFinite(currentPrice)) return { ok: false, why: "bad_price" };

  const pct = ((currentPrice - reentryRefPrice) / reentryRefPrice) * 100.0;
  const fallOk = pct >= -REENTRY_MAX_FALL_PCT;
  const riseOk = pct <= REENTRY_MAX_RISE_PCT;

  return {
    ok: fallOk && riseOk,
    fallPct: pct,
    risePct: pct,
    fallOk,
    riseOk,
  };
}

// ====================
// Pending BUY (Pink fix)
// ====================
function pendingBuyActive() {
  return pendingBuy && pendingBuy.untilMs && nowMs() <= pendingBuy.untilMs;
}

function clearPendingBuy(reason = "cleared") {
  if (pendingBuy) console.log(`🩷 PendingBUY cleared (${reason})`);
  pendingBuy = null;
}

function storePendingBuy(rayPayload, rayPrice, raySymbol) {
  if (!PENDING_BUY_ENABLED) return false;
  if (!Number.isFinite(rayPrice) || !raySymbol) return false;

  pendingBuy = {
    untilMs: nowMs() + PENDING_BUY_WINDOW_SEC * 1000,
    payload: rayPayload,
    price: rayPrice,
    symbol: raySymbol,
  };
  console.log(`🩷 PendingBUY stored (${PENDING_BUY_WINDOW_SEC}s) symbol=${raySymbol} price=${rayPrice}`);
  return true;
}

// ====================
// 3Commas forwarder
// ====================
async function postTo3Commas(action, payload) {
  if (!THREECOMMAS_BOT_UUID || !THREECOMMAS_SECRET) {
    console.log("⚠️ 3Commas not configured (missing BOT_UUID/SECRET) — skipping");
    return { skipped: true };
  }

  const tv_exchange =
    payload?.tv_exchange ??
    payload?.exchange ??
    entryMeta?.tv_exchange ??
    readyMeta?.tv_exchange ??
    THREECOMMAS_TV_EXCHANGE ??
    "";

  const tv_instrument =
    payload?.tv_instrument ??
    payload?.ticker ??
    entryMeta?.tv_instrument ??
    readyMeta?.tv_instrument ??
    THREECOMMAS_TV_INSTRUMENT ??
    "";

  const trigger_price =
    toNum(payload?.trigger_price) ??
    toNum(payload?.price) ??
    toNum(payload?.close) ??
    readyPrice ??
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
    return { ok: resp.ok, status: resp.status, resp: text };
  } catch (e) {
    console.log("⛔ 3Commas POST failed:", e?.name === "AbortError" ? "timeout" : (e?.message || e));
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

function noteExitForEquity(exitPrice) {
  if (!EQUITY_STABILIZER_ENABLED) return null;
  const p = pctProfit(entryPrice, exitPrice);
  if (p == null) return null;

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

  return p;
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

  if (PL_ADAPTIVE_ENABLED) {
    const st = regimeState.get(currentSymbol);
    const atrP = st?.atrPct ?? atrPctFromTicks(currentSymbol, ATR_WINDOW_SEC);
    if (atrP != null) {
      const r = getRegime(currentSymbol);
      const startMult = r === "TREND" ? PL_START_ATR_MULT_TREND : PL_START_ATR_MULT_RANGE;
      const giveMult = r === "TREND" ? PL_GIVEBACK_ATR_MULT_TREND : PL_GIVEBACK_ATR_MULT_RANGE;
      armPct = startMult * atrP;
      givebackPct = giveMult * atrP;
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
      `🧷 PROFIT LOCK EXIT: price=${currentPrice} <= floor=${floor.toFixed(4)} | peak=${peakPrice} | giveback=${givebackPct.toFixed(3)}%`
    );

    lastAction = "profit_lock_exit_long";

    const fwd = await postTo3Commas("exit_long", {
      time: new Date().toISOString(),
      trigger_price: currentPrice,
      tv_exchange: entryMeta?.tv_exchange,
      tv_instrument: entryMeta?.tv_instrument,
    });

    const exitPnl = noteExitForEquity(currentPrice);

    startOrUpdateReentryWindow({
      exitPrice: currentPrice,
      symbol: currentSymbol,
      regimeAtExit: currentSymbol ? getRegime(currentSymbol) : "RANGE",
      reason: "exit_profit_lock",
      exitPnlPct: exitPnl,
    });

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

  if (crashLockActive()) {
    lastAction = "enter_long_blocked_crash_lock";
    return res.json({ ok: false, blocked: "crash_lock_active" });
  }

  const reentryCandidate =
    REENTRY_ENABLED &&
    reentryTimeOk() &&
    reentryTriesLeft() &&
    (!REENTRY_REQUIRE_READY && !readyOn);

  // bypass cooldown for valid re-entry candidate
  if (!reentryCandidate && cooldownActive()) {
    lastAction = "enter_long_blocked_cooldown";
    return res.json({ ok: false, blocked: "cooldown_active" });
  }
  if (reentryCandidate) console.log("🟣 REENTRY bypassing cooldown (valid re-entry candidate)");

  if (!isHeartbeatFresh()) {
    lastAction = "enter_long_blocked_stale_heartbeat";
    return res.json({ ok: false, blocked: "stale_heartbeat" });
  }

  // If not re-entry, must have READY
  if (!reentryCandidate) {
    if (!readyOn) {
      // Pink fix: store pending BUY if enabled
      const stored = storePendingBuy(payload, rayPx, raySym);
      lastAction = stored ? "enter_long_pending_buy_saved" : "enter_long_blocked_not_ready";
      return res.json({
        ok: false,
        blocked: stored ? "pending_buy_saved" : "not_ready",
        pending_buy: stored ? { windowSec: PENDING_BUY_WINDOW_SEC } : null,
      });
    }
  } else {
    if (reentrySymbol && raySym && reentrySymbol !== raySym) {
      lastAction = "enter_long_blocked_reentry_symbol_mismatch";
      return res.json({ ok: false, blocked: "reentry_symbol_mismatch", reentrySymbol, raySym });
    }

    const curReg = raySym ? getRegime(raySym) : "RANGE";
    if (REENTRY_REQUIRE_TREND && curReg !== "TREND") {
      lastAction = "enter_long_blocked_reentry_not_trend";
      return res.json({ ok: false, blocked: "reentry_not_trend", regime: curReg });
    }

    const chk = reentryPriceCheck(rayPx);
    if (!chk.ok) {
      lastAction = "enter_long_blocked_reentry_price_guard";
      console.log(
        `⛔ REENTRY blocked (price guard) fall=${(chk.fallPct ?? 0).toFixed(3)}% rise=${(chk.risePct ?? 0).toFixed(3)}% ref=${reentryRefPrice}`
      );
      if (REENTRY_CANCEL_ON_BREACH) clearReentry("breach");
      return res.json({ ok: false, blocked: "reentry_price_guard", detail: chk });
    }

    console.log(
      `🟣 REENTRY allowed (${sourceTag}) fall=${chk.fallPct.toFixed(3)}% rise=${chk.risePct.toFixed(
        3
      )}% ref=${reentryRefPrice} regime=${curReg} tries=${reentryTriesUsed + 1}/${REENTRY_MAX_TRIES}`
    );
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

  // Normal entry symbol + drift vs READY
  if (!reentryCandidate) {
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

  // Approve entry
  inPosition = true;
  entryPrice = rayPx;
  entrySymbol = raySym || readySymbol || reentrySymbol || "";
  peakPrice = rayPx;
  profitLockArmed = false;

  entryMeta = {
    tv_exchange: readyMeta?.tv_exchange ?? payload?.tv_exchange ?? payload?.exchange ?? null,
    tv_instrument: readyMeta?.tv_instrument ?? payload?.tv_instrument ?? payload?.ticker ?? null,
  };

  let tag = sourceTag;
  if (reentryCandidate) {
    reentryTriesUsed += 1;
    tag = `${sourceTag}+reentry`;
    if (!reentryTriesLeft()) clearReentry("max_tries_reached");
  }

  clearPendingBuy("enter_used_or_not_needed");

  lastAction = "enter_long";
  console.log(`🚀 ENTER LONG (${tag}) | regime=${getRegime(entrySymbol)}`);

  const fwd = await postTo3Commas("enter_long", {
    ...payload,
    trigger_price: payload?.price ?? payload?.close ?? payload?.trigger_price ?? readyPrice ?? rayPx,
    tv_exchange: entryMeta?.tv_exchange,
    tv_instrument: entryMeta?.tv_instrument,
  });

  return res.json({
    ok: true,
    action: "enter_long",
    source: tag,
    threecommas: fwd,
    reentry: {
      active: reentryActive,
      untilMs: reentryUntilMs,
      ref: reentryRefPrice,
      triesUsed: reentryTriesUsed,
      triesMax: REENTRY_MAX_TRIES,
    },
  });
}

async function handleExitLong(payload, res, sourceTag) {
  const rayPx = getRayPrice(payload);

  if (!inPosition) {
    lastAction = "exit_long_no_position";
    return res.json({ ok: false, blocked: "no_position" });
  }

  if (PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT > 0) {
    const px = rayPx ?? lastTickPrice;
    const p = pctProfit(entryPrice, px);
    if (p != null && p < PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT) {
      lastAction = "exit_long_blocked_profit_filter";
      return res.json({ ok: false, blocked: "profit_filter", profit_pct: p });
    }
  }

  lastAction = "exit_long";

  const exitPx = rayPx ?? lastTickPrice ?? null;

  const fwd = await postTo3Commas("exit_long", {
    ...payload,
    trigger_price: payload?.price ?? payload?.close ?? payload?.trigger_price ?? "",
    tv_exchange: entryMeta?.tv_exchange,
    tv_instrument: entryMeta?.tv_instrument,
  });

  const exitPnl = exitPx != null ? noteExitForEquity(exitPx) : null;

  // Start/keep re-entry window on exit (Rule A + LossSkip)
  startOrUpdateReentryWindow({
    exitPrice: exitPx ?? entryPrice ?? null,
    symbol: entrySymbol || getSymbolFromPayload(payload),
    regimeAtExit: (entrySymbol || getSymbolFromPayload(payload)) ? getRegime(entrySymbol || getSymbolFromPayload(payload)) : "RANGE",
    reason: `exit_${sourceTag}`,
    exitPnlPct: exitPnl,
  });

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
    crashLockActive: crashLockActive(),
    crashLockUntilMs,
    cooldownActive: cooldownActive(),
    cooldownUntilMs,
    REQUIRE_FRESH_HEARTBEAT,
    HEARTBEAT_MAX_AGE_SEC,
    lastTickMs,
    lastTickSymbol,
    lastTickPrice,
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
    // ReEntry
    REENTRY_ENABLED,
    REENTRY_WINDOW_MIN,
    REENTRY_MAX_FALL_PCT,
    REENTRY_MAX_RISE_PCT,
    REENTRY_REQUIRE_TREND,
    REENTRY_REQUIRE_READY,
    REENTRY_CANCEL_ON_BREACH,
    REENTRY_MAX_TRIES,
    REENTRY_SKIP_START_IF_EXIT_PNL_LE_PCT,
    reentry: {
      active: reentryActive,
      untilMs: reentryUntilMs,
      ref: reentryRefPrice,
      symbol: reentrySymbol,
      regimeAtExit: reentryRegimeAtExit,
      reason: reentryReason,
      triesUsed: reentryTriesUsed,
      triesMax: REENTRY_MAX_TRIES,
      timeOk: reentryTimeOk(),
      triesLeft: reentryTriesLeft(),
    },
    // Pending BUY
    PENDING_BUY_ENABLED,
    PENDING_BUY_WINDOW_SEC,
    PENDING_BUY_MAX_READY_DRIFT_PCT,
    pendingBuy: pendingBuyActive()
      ? { active: true, untilMs: pendingBuy.untilMs, symbol: pendingBuy.symbol, price: pendingBuy.price }
      : { active: false },
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

  if (reentryActive && !reentryTimeOk()) clearReentry("expired");
  if (pendingBuy && !pendingBuyActive()) clearPendingBuy("expired");

  if (!checkSecret(payload)) {
    console.log("⛔ Secret mismatch - blocked");
    return res.status(401).json({ ok: false, error: "secret_mismatch" });
  }

  const intent = normalizeIntent(payload);

  // ---- TICK
  if (intent === "tick") {
    const tickPx = getTickPrice(payload);
    const tickSym = getSymbolFromPayload(payload);

    if (tickPx == null || !tickSym) {
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
    });
  }

  // ---- READY_LONG
  if (intent === "ready_long" || (READY_ACCEPT_LEGACY_READY && intent === "ready")) {
    if (crashLockActive()) {
      lastAction = "ready_long_ignored_crash_lock";
      return res.json({ ok: true, ignored: "crash_lock_active" });
    }
    if (cooldownActive()) {
      lastAction = "ready_long_ignored_cooldown";
      return res.json({ ok: true, ignored: "cooldown_active" });
    }
    if (!isHeartbeatFresh()) {
      lastAction = "ready_long_ignored_stale_heartbeat";
      return res.json({ ok: true, ignored: "stale_heartbeat" });
    }
    if (inPosition) {
      lastAction = "ready_long_ignored_in_position";
      return res.json({ ok: true, ignored: "in_position" });
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

    // ✅ Pink fix: if we have a pending BUY that matches this READY, auto-enter
    if (pendingBuyActive() && readySymbol && pendingBuy.symbol === readySymbol) {
      const d = (readyPrice != null && pendingBuy.price != null) ? pctDiff(readyPrice, pendingBuy.price) : null;
      if (d != null && d <= PENDING_BUY_MAX_READY_DRIFT_PCT) {
        console.log(`🩷 PendingBUY matched READY_LONG: drift=${d.toFixed(3)}% <= ${PENDING_BUY_MAX_READY_DRIFT_PCT}% → auto ENTER`);
        // call enter using stored ray payload
        const stored = pendingBuy.payload;
        // ensure src looks like ray BUY
        const enterPayload = { ...stored, src: "ray", side: "BUY", symbol: pendingBuy.symbol };
        clearPendingBuy("used_on_ready");

        // use the same handler so it goes through all normal entry checks (READY on, drift, etc.)
        return handleEnterLong(enterPayload, res, "pending_ray_buy");
      } else {
        console.log(`🩷 PendingBUY not used (drift too big): drift=${d?.toFixed(3)}%`);
        clearPendingBuy("ready_drift_too_big");
      }
    }

    return res.json({
      ok: true,
      readyOn,
      action: "ready_long",
      readyPrice,
      readySymbol,
      readyTf,
      regime: readySymbol ? regimeState.get(readySymbol) || null : null,
      pendingBuy: pendingBuyActive() ? { active: true } : { active: false },
    });
  }

  // ---- ENTER/EXIT intents
  if (intent === "enter_long") return handleEnterLong(payload, res, "intent_enter_long");
  if (intent === "exit_long") return handleExitLong(payload, res, "intent_exit_long");

  // ---- Backward compatible Ray format
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
    `ReEntry: ENABLED=${REENTRY_ENABLED} | window=${REENTRY_WINDOW_MIN}m | fall<=${REENTRY_MAX_FALL_PCT}% | rise<=${REENTRY_MAX_RISE_PCT}% | reqTrend=${REENTRY_REQUIRE_TREND} | reqReady=${REENTRY_REQUIRE_READY} | cancelOnBreach=${REENTRY_CANCEL_ON_BREACH} | maxTries=${REENTRY_MAX_TRIES} | skipExitPnL<=${REENTRY_SKIP_START_IF_EXIT_PNL_LE_PCT}%`
  );

  console.log(
    `PendingBUY: ENABLED=${PENDING_BUY_ENABLED} | window=${PENDING_BUY_WINDOW_SEC}s | maxReadyDrift=${PENDING_BUY_MAX_READY_DRIFT_PCT}%`
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
