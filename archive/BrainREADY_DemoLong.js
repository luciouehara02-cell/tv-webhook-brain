/**
 * Brain v3.1.0-LONG
 * READY_LONG + enter/exit gatekeeper + 3Commas + Regime + Adaptive PL + Crash Lock + Equity Stabilizer
 * + Pending BUY buffer
 * + Re-entry window with loop protection
 * + READY freshness gate for entry
 * + Pending BUY freshness gate
 * + Consolidated tick logging
 * + Compact state snapshot
 * + Entry drift logging
 * + Exit ladder:
 *   Stage 1 = Fail Stop
 *   Stage 2 = Breakeven
 *   Stage 3 = Profit Lock
 * + READY cleanup after successful enter
 * + Progressive Profit Lock tightening by peak profit tiers
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const BRAIN_VERSION = "v3.1.0-LONG";

// ====================
// CONFIG (Railway Variables)
// ====================
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

const EMERGENCY_BYPASS_COOLDOWN =
  String(process.env.EMERGENCY_BYPASS_COOLDOWN || "false").toLowerCase() === "true";

// READY
const READY_TTL_MIN = Number(process.env.READY_TTL_MIN || "0");
const READY_ENTRY_MAX_AGE_SEC = Number(process.env.READY_ENTRY_MAX_AGE_SEC || "480");
const READY_ACCEPT_LEGACY_READY =
  String(process.env.READY_ACCEPT_LEGACY_READY || "true").toLowerCase() === "true";
const READY_MAX_MOVE_PCT = Number(process.env.READY_MAX_MOVE_PCT || "1.2");
const READY_MAX_MOVE_PCT_TREND = toNumEnv(process.env.READY_MAX_MOVE_PCT_TREND);
const READY_MAX_MOVE_PCT_RANGE = toNumEnv(process.env.READY_MAX_MOVE_PCT_RANGE);
const READY_AUTOEXPIRE_PCT = Number(process.env.READY_AUTOEXPIRE_PCT || String(READY_MAX_MOVE_PCT));
const READY_AUTOEXPIRE_ENABLED =
  String(process.env.READY_AUTOEXPIRE_ENABLED || "true").toLowerCase() === "true";

// Cooldown / heartbeat / logging
const EXIT_COOLDOWN_MIN = Number(process.env.EXIT_COOLDOWN_MIN || "0");
const REQUIRE_FRESH_HEARTBEAT =
  String(process.env.REQUIRE_FRESH_HEARTBEAT || "true").toLowerCase() === "true";
const HEARTBEAT_MAX_AGE_SEC = Number(process.env.HEARTBEAT_MAX_AGE_SEC || "240");
const TICK_LOG_EVERY_MS = Number(process.env.TICK_LOG_EVERY_MS || "180000");
const STATE_LOG_EVERY_MS = Number(process.env.STATE_LOG_EVERY_MS || String(TICK_LOG_EVERY_MS));

// ===== Exit ladder =====

// Stage 1: Fail stop
const FAIL_STOP_ENABLED =
  String(process.env.FAIL_STOP_ENABLED || "true").toLowerCase() === "true";
const FAIL_STOP_PCT = Number(process.env.FAIL_STOP_PCT || "0.45");

// Stage 2: Breakeven
const BREAKEVEN_ENABLED =
  String(process.env.BREAKEVEN_ENABLED || "true").toLowerCase() === "true";
const BREAKEVEN_ARM_PCT = Number(process.env.BREAKEVEN_ARM_PCT || "0.35");
const BREAKEVEN_LOCK_PCT = Number(process.env.BREAKEVEN_LOCK_PCT || "0.05");

// Stage 3: Profit lock
const PROFIT_LOCK_ENABLED =
  String(process.env.PROFIT_LOCK_ENABLED || "true").toLowerCase() === "true";
const PROFIT_LOCK_ARM_PCT = Number(process.env.PROFIT_LOCK_ARM_PCT || "0.6");
const PROFIT_LOCK_GIVEBACK_PCT = Number(process.env.PROFIT_LOCK_GIVEBACK_PCT || "0.35");

const PL_ADAPTIVE_ENABLED =
  String(process.env.PL_ADAPTIVE_ENABLED || "true").toLowerCase() === "true";

const PL_START_ATR_MULT_TREND = Number(process.env.PL_START_ATR_MULT_TREND || "2.2");
const PL_GIVEBACK_ATR_MULT_TREND = Number(process.env.PL_GIVEBACK_ATR_MULT_TREND || "1.2");
const PL_START_ATR_MULT_RANGE = Number(process.env.PL_START_ATR_MULT_RANGE || "1.2");
const PL_GIVEBACK_ATR_MULT_RANGE = Number(process.env.PL_GIVEBACK_ATR_MULT_RANGE || "0.7");

const PL_MIN_ARM_PCT = Number(process.env.PL_MIN_ARM_PCT || "0");
const PL_MIN_GIVEBACK_PCT = Number(process.env.PL_MIN_GIVEBACK_PCT || "0");
const PL_MAX_ARM_PCT = Number(process.env.PL_MAX_ARM_PCT || "0");
const PL_MAX_GIVEBACK_PCT = Number(process.env.PL_MAX_GIVEBACK_PCT || "0");

// Progressive PL tightening
const PL_TIGHTEN_ENABLED =
  String(process.env.PL_TIGHTEN_ENABLED || "true").toLowerCase() === "true";

const PL_TIGHTEN_TIER1_PROFIT_PCT = Number(process.env.PL_TIGHTEN_TIER1_PROFIT_PCT || "0.80");
const PL_TIGHTEN_TIER2_PROFIT_PCT = Number(process.env.PL_TIGHTEN_TIER2_PROFIT_PCT || "1.20");
const PL_TIGHTEN_TIER3_PROFIT_PCT = Number(process.env.PL_TIGHTEN_TIER3_PROFIT_PCT || "1.80");

const PL_TIGHTEN_TIER1_MULT = Number(process.env.PL_TIGHTEN_TIER1_MULT || "1.00");
const PL_TIGHTEN_TIER2_MULT = Number(process.env.PL_TIGHTEN_TIER2_MULT || "0.85");
const PL_TIGHTEN_TIER3_MULT = Number(process.env.PL_TIGHTEN_TIER3_MULT || "0.70");
const PL_TIGHTEN_TIER4_MULT = Number(process.env.PL_TIGHTEN_TIER4_MULT || "0.55");

const PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT = Number(
  process.env.PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT || "0"
);

// Regime
const REGIME_ENABLED =
  String(process.env.REGIME_ENABLED || "true").toLowerCase() === "true";
const SLOPE_WINDOW_SEC = Number(process.env.SLOPE_WINDOW_SEC || "300");
const ATR_WINDOW_SEC = Number(process.env.ATR_WINDOW_SEC || "300");
const TICK_BUFFER_SEC = Number(process.env.TICK_BUFFER_SEC || "1800");
const REGIME_MIN_TICKS = Number(process.env.REGIME_MIN_TICKS || "10");
const REGIME_TREND_SLOPE_ON_PCT = Number(process.env.REGIME_TREND_SLOPE_ON_PCT || "0.25");
const REGIME_TREND_SLOPE_OFF_PCT = Number(process.env.REGIME_TREND_SLOPE_OFF_PCT || "0.18");
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

// Pending BUY
const PENDING_BUY_ENABLED =
  String(process.env.PENDING_BUY_ENABLED || "true").toLowerCase() === "true";
const PENDING_BUY_WINDOW_SEC = Number(process.env.PENDING_BUY_WINDOW_SEC || "120");
const PENDING_BUY_MAX_READY_DRIFT_PCT = Number(
  process.env.PENDING_BUY_MAX_READY_DRIFT_PCT || "0.3"
);
const PENDING_BUY_MAX_AGE_SEC = Number(process.env.PENDING_BUY_MAX_AGE_SEC || "60");

// ENTER dedupe
const ENTER_DEDUP_SEC = Number(process.env.ENTER_DEDUP_SEC || "25");

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

const THREECOMMAS_TV_EXCHANGE = process.env.THREECOMMAS_TV_EXCHANGE || "";
const THREECOMMAS_TV_INSTRUMENT = process.env.THREECOMMAS_TV_INSTRUMENT || "";

// ====================
// MEMORY
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
let lastTickLogMs = 0;
let lastStateLogMs = 0;

const tickHistory = new Map();
const regimeState = new Map();

let entryPrice = null;
let entrySymbol = "";
let peakPrice = null;
let profitLockArmed = false;
let breakevenArmed = false;

let entryMeta = { tv_exchange: null, tv_instrument: null };

let reentry = {
  active: false,
  untilMs: 0,
  ref: null,
  symbol: "",
  regimeAtExit: "",
  reason: "",
  triesUsed: 0,
  triesMax: REENTRY_MAX_TRIES,
  exitTs: 0,
  consumed: false,
};

let positionWasReentry = false;
let lastEnterAcceptedTs = 0;

function emptyPendingBuy() {
  return {
    active: false,
    untilMs: 0,
    symbol: "",
    price: null,
    payload: null,
    createdMs: 0,
  };
}
let pendingBuy = emptyPendingBuy();

// ====================
// HELPERS
// ====================
const nowMs = () => Date.now();

function toNumEnv(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
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

function isEmergency(payload) {
  const er = String(payload?.exitReason || "").toLowerCase().trim();
  return er === "emergency";
}

function pctDiff(a, b) {
  if (!Number.isFinite(a) || a === 0) return null;
  return (Math.abs(b - a) / Math.abs(a)) * 100.0;
}

function pctProfit(entry, current) {
  if (!Number.isFinite(entry) || entry === 0 || !Number.isFinite(current)) return null;
  return ((current - entry) / entry) * 100.0;
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
  if (payload?.tv_exchange && payload?.tv_instrument)
    return parseSymbol(`${payload.tv_exchange}:${payload.tv_instrument}`).symbol;
  if (payload?.exchange && payload?.ticker)
    return parseSymbol(`${payload.exchange}:${payload.ticker}`).symbol;
  if (payload?.tv_instrument && payload?.tv_exchange)
    return parseSymbol(`${payload.tv_exchange}:${payload.tv_instrument}`).symbol;
  return "";
}

function deriveTvFromSymbol(sym) {
  const { ex, ins } = parseSymbol(sym);
  return { tv_exchange: ex || "", tv_instrument: ins || "" };
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

function readyAgeMs() {
  return readyAtMs ? nowMs() - readyAtMs : null;
}

function isReadyFresh(maxAgeMs) {
  if (!readyOn || !readyAtMs) return false;
  return nowMs() - readyAtMs <= maxAgeMs;
}

function maybeLogTick(symbol, price, isoTime) {
  const now = nowMs();
  if (!TICK_LOG_EVERY_MS || TICK_LOG_EVERY_MS <= 0) return;
  if (!lastTickLogMs || now - lastTickLogMs >= TICK_LOG_EVERY_MS) {
    console.log(`🟦 TICK(3m) ${symbol} price=${price} time=${isoTime}`);
    lastTickLogMs = now;
  }
}

function maybeLogState(symbol) {
  const now = nowMs();
  if (!STATE_LOG_EVERY_MS || STATE_LOG_EVERY_MS <= 0) return;
  if (!symbol) return;

  if (!lastStateLogMs || now - lastStateLogMs >= STATE_LOG_EVERY_MS) {
    const reg = getRegime(symbol);
    const readyAgeSec = readyAgeMs() != null ? Math.round(readyAgeMs() / 1000) : null;
    const readyAgeStr = readyAgeSec != null ? `${readyAgeSec}s` : "na";
    console.log(
      `📌 STATE ${symbol} ready=${readyOn ? 1 : 0} readyAge=${readyAgeStr} inPos=${inPosition ? 1 : 0} reg=${reg} cooldown=${cooldownActive() ? 1 : 0} crash=${crashLockActive() ? 1 : 0} pending=${pendingActive() ? 1 : 0} reentry=${reentryActive() ? 1 : 0} be=${breakevenArmed ? 1 : 0} pl=${profitLockArmed ? 1 : 0} lastAction=${lastAction}`
    );
    lastStateLogMs = now;
  }
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
  breakevenArmed = false;
  entryMeta = { tv_exchange: null, tv_instrument: null };
  positionWasReentry = false;
  console.log(`🧽 POSITION context cleared (${reason})`);
}

function startCooldown(reason = "exit", minutesOverride = null) {
  const mins = minutesOverride != null ? minutesOverride : EXIT_COOLDOWN_MIN;
  if (!mins || mins <= 0) return;
  const until = nowMs() + mins * 60 * 1000;
  cooldownUntilMs = Math.max(cooldownUntilMs || 0, until);
  console.log(`⏳ Cooldown active until ${new Date(cooldownUntilMs).toISOString()} reason=${reason}`);
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
  if (inPosition) return false;
  if (!READY_TTL_MIN || READY_TTL_MIN <= 0) return false;
  return readyOn && nowMs() - readyAtMs > READY_TTL_MIN * 60 * 1000;
}

function isHeartbeatFresh() {
  if (!REQUIRE_FRESH_HEARTBEAT) return true;
  if (!lastTickMs) return false;
  return nowMs() - lastTickMs <= HEARTBEAT_MAX_AGE_SEC * 1000;
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

// tick analytics
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

function plTightenMultiplier(peakProfitPct) {
  if (!PL_TIGHTEN_ENABLED || !Number.isFinite(peakProfitPct)) return 1.0;

  if (peakProfitPct >= PL_TIGHTEN_TIER3_PROFIT_PCT) return PL_TIGHTEN_TIER4_MULT;
  if (peakProfitPct >= PL_TIGHTEN_TIER2_PROFIT_PCT) return PL_TIGHTEN_TIER3_MULT;
  if (peakProfitPct >= PL_TIGHTEN_TIER1_PROFIT_PCT) return PL_TIGHTEN_TIER2_MULT;
  return PL_TIGHTEN_TIER1_MULT;
}

async function postTo3Commas(action, payload) {
  if (!THREECOMMAS_BOT_UUID || !THREECOMMAS_SECRET) {
    console.log("⚠️ 3Commas not configured (missing BOT_UUID/SECRET) — skipping");
    return { skipped: true };
  }

  const sym = getSymbolFromPayload(payload) || entrySymbol || readySymbol || "";
  const derived = deriveTvFromSymbol(sym);

  const tv_exchange =
    payload?.tv_exchange ??
    payload?.exchange ??
    entryMeta?.tv_exchange ??
    readyMeta?.tv_exchange ??
    THREECOMMAS_TV_EXCHANGE ??
    derived.tv_exchange ??
    "";

  const tv_instrument =
    payload?.tv_instrument ??
    payload?.ticker ??
    entryMeta?.tv_instrument ??
    readyMeta?.tv_instrument ??
    THREECOMMAS_TV_INSTRUMENT ??
    derived.tv_instrument ??
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
    return { ok: resp.ok, status: resp.status, resp: text };
  } catch (e) {
    console.log("⛔ 3Commas POST failed:", e?.name === "AbortError" ? "timeout" : e?.message || e);
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

// ===== Exit ladder evaluators =====

async function doManagedExit(reason, currentPrice, currentSymbol) {
  lastAction = reason;

  const fwd = await postTo3Commas("exit_long", {
    time: new Date().toISOString(),
    trigger_price: currentPrice,
    symbol: entrySymbol || currentSymbol,
    tv_exchange: entryMeta?.tv_exchange,
    tv_instrument: entryMeta?.tv_instrument,
  });

  noteExitForEquity(currentPrice);
  maybeStartOrKeepReentryWindow(
    currentSymbol || entrySymbol,
    currentPrice,
    reason,
    pctProfit(entryPrice, currentPrice)
  );

  clearReadyContext(reason);
  clearPositionContext(reason);
  startCooldown(reason);

  return { exited: true, reason, threecommas: fwd };
}

async function maybeFailStopExit(currentPrice, currentSymbol) {
  if (!FAIL_STOP_ENABLED) return false;
  if (!inPosition) return false;
  if (!Number.isFinite(entryPrice) || !Number.isFinite(currentPrice)) return false;
  if (entrySymbol && currentSymbol && entrySymbol !== currentSymbol) return false;
  if (profitLockArmed || breakevenArmed) return false;

  const stopPx = entryPrice * (1 - FAIL_STOP_PCT / 100);
  if (currentPrice <= stopPx) {
    console.log(
      `🛑 FAIL STOP EXIT: price=${currentPrice} <= stop=${stopPx.toFixed(4)} | entry=${entryPrice} | failStop=${FAIL_STOP_PCT}%`
    );
    return doManagedExit("fail_stop_exit", currentPrice, currentSymbol);
  }
  return false;
}

async function maybeBreakevenExit(currentPrice, currentSymbol) {
  if (!BREAKEVEN_ENABLED) return false;
  if (!inPosition) return false;
  if (!Number.isFinite(entryPrice) || !Number.isFinite(currentPrice)) return false;
  if (entrySymbol && currentSymbol && entrySymbol !== currentSymbol) return false;
  if (profitLockArmed) return false;

  const p = pctProfit(entryPrice, currentPrice);
  if (p == null) return false;

  if (!breakevenArmed && p >= BREAKEVEN_ARM_PCT) {
    breakevenArmed = true;
    console.log(
      `🟡 BREAKEVEN ARMED at +${p.toFixed(3)}% (>= ${BREAKEVEN_ARM_PCT.toFixed(3)}%)`
    );
  }

  if (!breakevenArmed) return false;

  const beFloor = entryPrice * (1 + BREAKEVEN_LOCK_PCT / 100);
  if (currentPrice <= beFloor) {
    console.log(
      `🟨 BREAKEVEN EXIT: price=${currentPrice} <= floor=${beFloor.toFixed(4)} | entry=${entryPrice} | lock=${BREAKEVEN_LOCK_PCT}%`
    );
    return doManagedExit("breakeven_exit", currentPrice, currentSymbol);
  }

  return false;
}

async function maybeProfitLockExit(currentPrice, currentSymbol) {
  if (!PROFIT_LOCK_ENABLED) return false;
  if (!inPosition) return false;
  if (!entryPrice || currentPrice == null) return false;
  if (entrySymbol && currentSymbol && entrySymbol !== currentSymbol) return false;

  peakPrice = peakPrice == null ? currentPrice : Math.max(peakPrice, currentPrice);

  const p = pctProfit(entryPrice, currentPrice);
  const peakProfitPct = pctProfit(entryPrice, peakPrice);
  if (p == null || peakProfitPct == null) return false;

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

  const tightenMult = plTightenMultiplier(peakProfitPct);
  let effectiveGivebackPct = givebackPct * tightenMult;

  if (PL_MIN_GIVEBACK_PCT > 0) effectiveGivebackPct = Math.max(effectiveGivebackPct, PL_MIN_GIVEBACK_PCT);
  if (PL_MAX_GIVEBACK_PCT > 0) effectiveGivebackPct = Math.min(effectiveGivebackPct, PL_MAX_GIVEBACK_PCT);

  const floor = peakPrice * (1 - effectiveGivebackPct / 100);

  if (currentPrice <= floor) {
    console.log(
      `🧷 PROFIT LOCK EXIT: price=${currentPrice} <= floor=${floor.toFixed(4)} | peak=${peakPrice} | baseGiveback=${givebackPct.toFixed(3)}% | tightenMult=${tightenMult.toFixed(2)} | effectiveGiveback=${effectiveGivebackPct.toFixed(3)}% | peakProfit=${peakProfitPct.toFixed(3)}%`
    );
    return doManagedExit("profit_lock_exit", currentPrice, currentSymbol);
  }

  return false;
}

// ====================
// RE-ENTRY helpers
// ====================
function reentryActive() {
  return reentry.active && nowMs() < reentry.untilMs;
}
function reentryTriesLeft() {
  return reentry.triesUsed < reentry.triesMax;
}
function reentryClear(reason = "cleared") {
  reentry.active = false;
  reentry.untilMs = 0;
  reentry.ref = null;
  reentry.symbol = "";
  reentry.regimeAtExit = "";
  reentry.reason = reason;
  reentry.triesUsed = 0;
  reentry.triesMax = REENTRY_MAX_TRIES;
  reentry.exitTs = 0;
  reentry.consumed = false;
  console.log(`🧼 REENTRY cleared (${reason})`);
}

function reentryFallRiseFromRef(ref, current) {
  if (!Number.isFinite(ref) || ref === 0 || !Number.isFinite(current)) return null;
  const pct = ((current - ref) / ref) * 100.0;
  return { pct };
}

function maybeStartOrKeepReentryWindow(symbol, exitPrice, reason, exitPnlPct) {
  if (!REENTRY_ENABLED) return;
  if (!symbol || !Number.isFinite(exitPrice)) return;

  if (positionWasReentry) {
    console.log("🟣 REENTRY not started (exit from re-entry trade)");
    return;
  }

  if (Number.isFinite(exitPnlPct) && exitPnlPct <= REENTRY_SKIP_START_IF_EXIT_PNL_LE_PCT) {
    console.log(
      `🟣 REENTRY not started (exitPnL ${exitPnlPct.toFixed(3)}% <= ${REENTRY_SKIP_START_IF_EXIT_PNL_LE_PCT}%)`
    );
    return;
  }

  const now = nowMs();
  const regAtExit = symbol ? getRegime(symbol) : "RANGE";

  if (reentry.active && now < reentry.untilMs && reentry.symbol === symbol) {
    reentry.ref = exitPrice;
    reentry.regimeAtExit = regAtExit;
    reentry.reason = reason;
    reentry.exitTs = now;
    reentry.consumed = false;
    console.log(
      `🟣 REENTRY window kept | until=${new Date(reentry.untilMs).toISOString()} | ref=${exitPrice} tries=${reentry.triesUsed}/${reentry.triesMax} reason=${reason}`
    );
    return;
  }

  reentry = {
    active: true,
    untilMs: now + REENTRY_WINDOW_MIN * 60 * 1000,
    ref: exitPrice,
    symbol,
    regimeAtExit: regAtExit,
    reason,
    triesUsed: 0,
    triesMax: REENTRY_MAX_TRIES,
    exitTs: now,
    consumed: false,
  };

  console.log(
    `🟣 REENTRY window started (${REENTRY_WINDOW_MIN}m) ref=${exitPrice} fall<=${REENTRY_MAX_FALL_PCT}% rise<=${REENTRY_MAX_RISE_PCT}% regimeAtExit=${regAtExit} reason=${reason}`
  );
}

// ====================
// Pending BUY helpers
// ====================
function pendingActive() {
  return pendingBuy.active && nowMs() < pendingBuy.untilMs;
}

function pendingClear(reason = "cleared") {
  pendingBuy = emptyPendingBuy();
  if (reason) console.log(`🩷 PendingBUY cleared (${reason})`);
}

function pendingStore(symbol, price, payload) {
  if (!PENDING_BUY_ENABLED) return;
  pendingBuy = {
    active: true,
    untilMs: nowMs() + PENDING_BUY_WINDOW_SEC * 1000,
    symbol,
    price,
    payload,
    createdMs: nowMs(),
  };
  console.log(`🩷 PendingBUY stored (${PENDING_BUY_WINDOW_SEC}s) symbol=${symbol} price=${price}`);
}

function pendingCanConsumeWithReady(readySym, readyPx) {
  if (!pendingActive()) return false;
  if (!readySym || pendingBuy.symbol !== readySym) return false;
  if (!Number.isFinite(readyPx) || !Number.isFinite(pendingBuy.price)) return false;
  if (!pendingBuy.createdMs) return false;
  if (nowMs() - pendingBuy.createdMs > PENDING_BUY_MAX_AGE_SEC * 1000) return false;

  const d = pctDiff(readyPx, pendingBuy.price);
  return d != null && d <= PENDING_BUY_MAX_READY_DRIFT_PCT;
}

// ====================
// ENTRY/EXIT handlers
// ====================
function enterDedupeActive(ts) {
  if (!ENTER_DEDUP_SEC || ENTER_DEDUP_SEC <= 0) return false;
  const gapMs = ENTER_DEDUP_SEC * 1000;
  return lastEnterAcceptedTs && ts - lastEnterAcceptedTs < gapMs;
}

async function handleEnterLong(payload, res, sourceTag) {
  const px = getRayPrice(payload);
  const sym = getSymbolFromPayload(payload);
  const ts = nowMs();
  const emergency = isEmergency(payload);

  if (crashLockActive()) {
    lastAction = "enter_long_blocked_crash_lock";
    return res.json({ ok: false, blocked: "crash_lock_active" });
  }

  if (inPosition) {
    lastAction = "enter_long_blocked_in_position";
    return res.json({ ok: false, blocked: "already_in_position" });
  }

  if (!isHeartbeatFresh()) {
    lastAction = "enter_long_blocked_stale_heartbeat";
    return res.json({ ok: false, blocked: "stale_heartbeat" });
  }

  if (enterDedupeActive(ts)) {
    lastAction = "enter_long_deduped";
    return res.json({ ok: true, ignored: "enter_dedup", window_sec: ENTER_DEDUP_SEC });
  }

  const reentryCandidate =
    REENTRY_ENABLED &&
    reentryActive() &&
    reentryTriesLeft() &&
    !reentry.consumed &&
    (!REENTRY_REQUIRE_READY || readyOn);

  const emergencyBypassCooldown = emergency && EMERGENCY_BYPASS_COOLDOWN;

  if (cooldownActive() && !reentryCandidate && !emergencyBypassCooldown) {
    lastAction = "enter_long_blocked_cooldown";
    return res.json({ ok: false, blocked: "cooldown_active" });
  } else if (cooldownActive() && reentryCandidate) {
    console.log("🟣 REENTRY bypassing cooldown (valid re-entry candidate)");
  } else if (cooldownActive() && emergencyBypassCooldown) {
    console.log("🧨 EMERGENCY: bypassing cooldown (EMERGENCY_BYPASS_COOLDOWN=true)");
  }

  if (conservativeModeActive()) {
    const reg = sym ? getRegime(sym) : "RANGE";
    if (reg !== "TREND") {
      lastAction = "enter_long_blocked_conservative_range";
      return res.json({ ok: false, blocked: "conservative_blocks_range", regime: reg });
    }
  }

  if (!reentryCandidate && !emergency) {
    if (!readyOn) {
      lastAction = "enter_long_blocked_not_ready";
      if (PENDING_BUY_ENABLED && sym && Number.isFinite(px)) {
        pendingStore(sym, px, payload);
      }
      return res.json({ ok: false, blocked: "not_ready" });
    }

    if (!isReadyFresh(READY_ENTRY_MAX_AGE_SEC * 1000)) {
      lastAction = "enter_long_blocked_ready_too_old";
      clearReadyContext("ready_too_old_for_entry");
      return res.json({
        ok: false,
        blocked: "ready_too_old",
        readyAgeSec: readyAgeMs() != null ? Math.round(readyAgeMs() / 1000) : null,
        maxAgeSec: READY_ENTRY_MAX_AGE_SEC,
      });
    }
  }

  if (emergency && !reentryCandidate) {
    console.log("🧨 EMERGENCY: ENTER_LONG bypassing READY requirement");
  }

  if (reentryCandidate) {
    if (reentry.symbol && sym && reentry.symbol !== sym) {
      lastAction = "enter_long_blocked_reentry_symbol_mismatch";
      return res.json({
        ok: false,
        blocked: "reentry_symbol_mismatch",
        reentrySymbol: reentry.symbol,
        sym,
      });
    }

    if (REENTRY_REQUIRE_TREND) {
      const r = getRegime(sym);
      if (r !== "TREND") {
        lastAction = "enter_long_blocked_reentry_requires_trend";
        return res.json({ ok: false, blocked: "reentry_requires_trend", regime: r });
      }
    }

    if (Number.isFinite(reentry.ref) && Number.isFinite(px)) {
      const move = reentryFallRiseFromRef(reentry.ref, px);
      if (move) {
        const pct = move.pct;
        if (pct < -REENTRY_MAX_FALL_PCT || pct > REENTRY_MAX_RISE_PCT) {
          lastAction = "enter_long_blocked_reentry_breach";
          console.log(
            `🟣 REENTRY blocked (breach) move=${pct.toFixed(3)}% ref=${reentry.ref} fall<=${REENTRY_MAX_FALL_PCT}% rise<=${REENTRY_MAX_RISE_PCT}%`
          );
          if (REENTRY_CANCEL_ON_BREACH) reentryClear("breach_cancel");
          return res.json({ ok: false, blocked: "reentry_breach", movePct: pct });
        }
      }
    }

    reentry.triesUsed += 1;
    console.log(
      `🟣 REENTRY allowed (${sourceTag}) ref=${reentry.ref} regime=${getRegime(sym)} tries=${reentry.triesUsed}/${reentry.triesMax}`
    );
  }

  if (!reentryCandidate && !emergency) {
    if (readySymbol && sym && readySymbol !== sym) {
      lastAction = "enter_long_blocked_symbol_mismatch";
      return res.json({ ok: false, blocked: "symbol_mismatch", readySymbol, sym });
    }
  }

  if (px == null || !sym) {
    lastAction = "enter_long_blocked_missing_fields";
    return res.json({ ok: false, blocked: "missing_price_or_symbol" });
  }

  let entryDriftPct = null;

  if (!reentryCandidate && !emergency) {
    if (readyPrice == null) {
      lastAction = "enter_long_blocked_missing_ready_price";
      return res.json({ ok: false, blocked: "missing_ready_price" });
    }

    const dPct = pctDiff(readyPrice, px);
    if (dPct == null) {
      lastAction = "enter_long_blocked_bad_price_diff";
      return res.json({ ok: false, blocked: "bad_price_diff" });
    }

    entryDriftPct = dPct;
    const maxMove = effectiveReadyMaxMovePct(sym);

    if (dPct > maxMove) {
      console.log(`⛔ ENTER LONG blocked (drift ${dPct.toFixed(3)}% > ${maxMove}%) — HARD RESET READY`);
      clearReadyContext("hard_reset_price_drift");
      lastAction = "enter_long_blocked_price_drift_reset";
      return res.json({ ok: false, blocked: "price_drift_reset", drift_pct: dPct, maxMove });
    }
  }

  inPosition = true;
  entryPrice = px;
  entrySymbol = sym;
  peakPrice = px;
  profitLockArmed = false;
  breakevenArmed = false;

  positionWasReentry = Boolean(reentryCandidate);

  const derived = deriveTvFromSymbol(sym);
  entryMeta = {
    tv_exchange:
      payload?.tv_exchange ?? payload?.exchange ?? readyMeta?.tv_exchange ?? derived.tv_exchange ?? null,
    tv_instrument:
      payload?.tv_instrument ?? payload?.ticker ?? readyMeta?.tv_instrument ?? derived.tv_instrument ?? null,
  };

  lastAction = "enter_long";
  lastEnterAcceptedTs = ts;

  const readyPxForLog = readyPrice;
  console.log(
    `🚀 ENTER LONG (${sourceTag}${reentryCandidate ? "+reentry" : ""}${emergency ? "+emergency" : ""}) | regime=${getRegime(entrySymbol)} | ready=${readyPxForLog ?? "na"} entry=${px ?? "na"} drift=${entryDriftPct != null ? entryDriftPct.toFixed(3) + "%" : "na"}`
  );

  const fwd = await postTo3Commas("enter_long", {
    ...payload,
    symbol: sym,
    trigger_price: payload?.trigger_price ?? payload?.price ?? payload?.close ?? readyPrice ?? px,
    tv_exchange: entryMeta?.tv_exchange,
    tv_instrument: entryMeta?.tv_instrument,
  });

  clearReadyContext("entered_long");

  if (reentryCandidate) {
    reentry.consumed = true;
    reentry.active = false;
  }

  return res.json({
    ok: true,
    action: "enter_long",
    source: sourceTag,
    emergency,
    reentry: reentryCandidate ? true : false,
    entryDriftPct,
    regime: entrySymbol ? regimeState.get(entrySymbol) || null : null,
    threecommas: fwd,
  });
}

async function handleExitLong(payload, res, sourceTag) {
  const px = getRayPrice(payload);
  const exitPx = px ?? lastTickPrice ?? null;

  if (!inPosition) {
    lastAction = "exit_long_no_position";
    return res.json({ ok: false, blocked: "no_position" });
  }

  const emergency = isEmergency(payload);

  if (PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT > 0 && exitPx != null) {
    const p = pctProfit(entryPrice, exitPx);
    if (p != null && p < PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT) {
      lastAction = "exit_long_blocked_profit_filter";
      console.log(
        `⛔ EXIT LONG ignored: profit ${p.toFixed(3)}% < ${PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT}%`
      );
      return res.json({ ok: false, blocked: "profit_filter", profit_pct: p });
    }
  }

  lastAction = "exit_long";

  const sym = entrySymbol || getSymbolFromPayload(payload) || "";
  const derived = deriveTvFromSymbol(sym);

  const fwd = await postTo3Commas("exit_long", {
    ...payload,
    symbol: sym,
    trigger_price: payload?.trigger_price ?? payload?.price ?? payload?.close ?? "",
    tv_exchange: entryMeta?.tv_exchange ?? derived.tv_exchange,
    tv_instrument: entryMeta?.tv_instrument ?? derived.tv_instrument,
  });

  let pnlPct = null;
  if (exitPx != null) {
    pnlPct = pctProfit(entryPrice, exitPx);

    if (emergency) {
      console.log("🧨 EMERGENCY EXIT: skipping EquityStab cooldown/conservative");
    } else {
      noteExitForEquity(exitPx);
    }
  }

  if (exitPx != null) {
    maybeStartOrKeepReentryWindow(sym, exitPx, `exit_${sourceTag}`, pnlPct);
  }

  clearReadyContext("exit_long");
  clearPositionContext("exit_long");
  startCooldown(sourceTag);

  console.log(`✅ EXIT LONG (${sourceTag}${emergency ? "+emergency" : ""})`);
  return res.json({ ok: true, action: "exit_long", source: sourceTag, emergency, threecommas: fwd });
}

// ====================
// ROUTES
// ====================
function statusPayload() {
  return {
    brain: BRAIN_VERSION,

    EMERGENCY_BYPASS_COOLDOWN,

    readyOn,
    inPosition,
    lastAction,

    READY_TTL_MIN,
    READY_ENTRY_MAX_AGE_SEC,
    readyAgeMs: readyAgeMs(),

    READY_MAX_MOVE_PCT,
    READY_MAX_MOVE_PCT_TREND,
    READY_MAX_MOVE_PCT_RANGE,
    READY_AUTOEXPIRE_ENABLED,
    READY_AUTOEXPIRE_PCT,

    EXIT_COOLDOWN_MIN,
    crashLockActive: crashLockActive() ? 1 : 0,
    crashLockUntilMs,
    cooldownActive: cooldownActive(),
    cooldownUntilMs,

    REQUIRE_FRESH_HEARTBEAT,
    HEARTBEAT_MAX_AGE_SEC,
    TICK_LOG_EVERY_MS,
    STATE_LOG_EVERY_MS,
    lastTickMs,
    lastTickSymbol,
    lastTickPrice,

    FAIL_STOP_ENABLED,
    FAIL_STOP_PCT,
    BREAKEVEN_ENABLED,
    BREAKEVEN_ARM_PCT,
    BREAKEVEN_LOCK_PCT,
    breakevenArmed,

    PROFIT_LOCK_ENABLED,
    PL_ADAPTIVE_ENABLED,
    profitLockArmed,

    PL_TIGHTEN_ENABLED,
    PL_TIGHTEN_TIER1_PROFIT_PCT,
    PL_TIGHTEN_TIER2_PROFIT_PCT,
    PL_TIGHTEN_TIER3_PROFIT_PCT,
    PL_TIGHTEN_TIER1_MULT,
    PL_TIGHTEN_TIER2_MULT,
    PL_TIGHTEN_TIER3_MULT,
    PL_TIGHTEN_TIER4_MULT,

    REGIME_ENABLED,
    SLOPE_WINDOW_SEC,
    ATR_WINDOW_SEC,
    TICK_BUFFER_SEC,

    CRASH_PROTECT_ENABLED,
    CRASH_DUMP_1M_PCT,
    CRASH_DUMP_5M_PCT,
    CRASH_COOLDOWN_MIN,

    EQUITY_STABILIZER_ENABLED,
    lossStreak,
    conservativeModeActive: conservativeModeActive() ? 1 : 0,
    conservativeUntilMs,

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
      ...reentry,
      activeNow: reentryActive(),
      triesLeft: reentryTriesLeft(),
    },

    ENTER_DEDUP_SEC,
    lastEnterAcceptedTs,

    PENDING_BUY_ENABLED,
    PENDING_BUY_WINDOW_SEC,
    PENDING_BUY_MAX_READY_DRIFT_PCT,
    PENDING_BUY_MAX_AGE_SEC,
    pendingBuy: {
      active: pendingActive(),
      untilMs: pendingBuy.untilMs,
      symbol: pendingBuy.symbol,
      price: pendingBuy.price,
      createdMs: pendingBuy.createdMs,
    },

    readyPrice,
    readySymbol,
    readyTf,

    entryPrice,
    entrySymbol,
    peakPrice,
    entryMeta,
    positionWasReentry,

    regime: lastTickSymbol ? regimeState.get(lastTickSymbol) || null : null,
    threecommas_configured: Boolean(THREECOMMAS_BOT_UUID && THREECOMMAS_SECRET),
    READY_ACCEPT_LEGACY_READY,
  };
}

app.get("/", (_req, res) => res.json(statusPayload()));
app.get("/status", (_req, res) => res.json(statusPayload()));

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

    maybeLogTick(tickSym, tickPx, payload?.time ?? new Date(lastTickMs).toISOString());

    pushTick(tickSym, tickPx, lastTickMs);

    if (pendingBuy.active && nowMs() > pendingBuy.untilMs) {
      pendingClear("expired");
    }

    const r = updateRegime(tickSym);
    const crash = maybeCrashLock(tickSym);
    const expired = maybeAutoExpireReady(tickPx, tickSym);

    const fail = await maybeFailStopExit(tickPx, tickSym);
    const be = fail ? null : await maybeBreakevenExit(tickPx, tickSym);
    const pl = fail || be ? null : await maybeProfitLockExit(tickPx, tickSym);

    maybeLogState(tickSym);

    return res.json({
      ok: true,
      tick: true,
      regime: r || regimeState.get(tickSym) || null,
      crash: crash || null,
      expired,
      fail_stop: fail || null,
      breakeven: be || null,
      profit_lock: pl || null,
      readyOn,
      inPosition,
      crashLockActive: crashLockActive(),
      conservativeModeActive: conservativeModeActive(),
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

    const priorReady = readyOn
      ? {
          price: readyPrice,
          symbol: readySymbol,
          tf: readyTf,
          ageSec: readyAtMs ? Math.round((nowMs() - readyAtMs) / 1000) : null,
        }
      : null;

    readyOn = true;
    readyAtMs = nowMs();

    readyPrice = getReadyPrice(payload);
    readySymbol = getSymbolFromPayload(payload);
    readyTf = payload?.tf ? String(payload.tf) : "";

    const derived = deriveTvFromSymbol(readySymbol);

    readyMeta = {
      timestamp: payload?.timestamp ?? payload?.time ?? null,
      tv_exchange: payload?.tv_exchange ?? payload?.exchange ?? derived.tv_exchange ?? null,
      tv_instrument: payload?.tv_instrument ?? payload?.ticker ?? derived.tv_instrument ?? null,
      meta_ready_ver: payload?.meta_ready_ver ?? null,
    };

    lastAction = "ready_long_set";
    console.log("🟢 READY_LONG ON", {
      priorReady,
      readyPrice,
      readySymbol,
      readyTf,
      meta_ready_ver: payload?.meta_ready_ver ?? null,
      READY_ENTRY_MAX_AGE_SEC,
      READY_MAX_MOVE_PCT,
      READY_AUTOEXPIRE_ENABLED,
      READY_AUTOEXPIRE_PCT,
      regime: readySymbol ? getRegime(readySymbol) : null,
    });

    if (PENDING_BUY_ENABLED && pendingCanConsumeWithReady(readySymbol, readyPrice)) {
      console.log(
        `🩷 PendingBUY consuming -> ENTER LONG (pending) drift<=${PENDING_BUY_MAX_READY_DRIFT_PCT}% age<=${PENDING_BUY_MAX_AGE_SEC}s`
      );

      const pendingPayload = pendingBuy.payload || {};
      const pendingPrice = pendingBuy.price;
      const pendingSym = pendingBuy.symbol;

      pendingClear("consumed");

      return handleEnterLong(
        {
          ...pendingPayload,
          intent: "enter_long",
          symbol: pendingPayload?.symbol ?? pendingSym,
          price: pendingPayload?.price ?? pendingPrice,
          time: pendingPayload?.time ?? new Date().toISOString(),
          tv_exchange: readyMeta?.tv_exchange ?? pendingPayload?.tv_exchange,
          tv_instrument: readyMeta?.tv_instrument ?? pendingPayload?.tv_instrument,
        },
        res,
        "pending_buy_consumed"
      );
    }

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
  console.log(`Emergency: EMERGENCY_BYPASS_COOLDOWN=${EMERGENCY_BYPASS_COOLDOWN}`);
  console.log(
    `Config: READY_TTL_MIN=${READY_TTL_MIN} | READY_ENTRY_MAX_AGE_SEC=${READY_ENTRY_MAX_AGE_SEC} | READY_MAX_MOVE_PCT=${READY_MAX_MOVE_PCT} | READY_AUTOEXPIRE_ENABLED=${READY_AUTOEXPIRE_ENABLED} | READY_AUTOEXPIRE_PCT=${READY_AUTOEXPIRE_PCT} | EXIT_COOLDOWN_MIN=${EXIT_COOLDOWN_MIN}`
  );
  console.log(
    `Heartbeat: REQUIRE_FRESH_HEARTBEAT=${REQUIRE_FRESH_HEARTBEAT} | HEARTBEAT_MAX_AGE_SEC=${HEARTBEAT_MAX_AGE_SEC}`
  );
  console.log(`TickLog: TICK_LOG_EVERY_MS=${TICK_LOG_EVERY_MS}`);
  console.log(`StateLog: STATE_LOG_EVERY_MS=${STATE_LOG_EVERY_MS}`);
  console.log(
    `ExitLadder: FAIL_STOP_ENABLED=${FAIL_STOP_ENABLED} fail=${FAIL_STOP_PCT}% | BREAKEVEN_ENABLED=${BREAKEVEN_ENABLED} arm=${BREAKEVEN_ARM_PCT}% lock=${BREAKEVEN_LOCK_PCT}% | PROFIT_LOCK_ENABLED=${PROFIT_LOCK_ENABLED} adaptive=${PL_ADAPTIVE_ENABLED}`
  );
  console.log(
    `PLTighten: enabled=${PL_TIGHTEN_ENABLED} | t1>=${PL_TIGHTEN_TIER1_PROFIT_PCT}% mult=${PL_TIGHTEN_TIER2_MULT} | t2>=${PL_TIGHTEN_TIER2_PROFIT_PCT}% mult=${PL_TIGHTEN_TIER3_MULT} | t3>=${PL_TIGHTEN_TIER3_PROFIT_PCT}% mult=${PL_TIGHTEN_TIER4_MULT}`
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
    `ReEntry: ENABLED=${REENTRY_ENABLED} | window=${REENTRY_WINDOW_MIN}m | fall<=${REENTRY_MAX_FALL_PCT}% | rise<=${REENTRY_MAX_RISE_PCT}% | reqTrend=${REENTRY_REQUIRE_TREND} | reqReady=${REENTRY_REQUIRE_READY} | cancelOnBreach=${REENTRY_CANCEL_ON_BREACH} | maxTries=${REENTRY_MAX_TRIES} | skipStartIfExitPnL<=${REENTRY_SKIP_START_IF_EXIT_PNL_LE_PCT}%`
  );
  console.log(
    `PendingBUY: ENABLED=${PENDING_BUY_ENABLED} | window=${PENDING_BUY_WINDOW_SEC}s | maxReadyDrift=${PENDING_BUY_MAX_READY_DRIFT_PCT}% | maxAge=${PENDING_BUY_MAX_AGE_SEC}s`
  );
  console.log(`EnterDedupe: ENTER_DEDUP_SEC=${ENTER_DEDUP_SEC}`);
  console.log(
    `3Commas: URL=${THREECOMMAS_WEBHOOK_URL} | BOT_UUID=${THREECOMMAS_BOT_UUID ? "(set)" : "(missing)"} | SECRET=${THREECOMMAS_SECRET ? "(set)" : "(missing)"} | TIMEOUT_MS=${THREECOMMAS_TIMEOUT_MS}`
  );
});
