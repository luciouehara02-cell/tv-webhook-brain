/**
 * Brain v2.8 — READY + Ray gatekeeper + 3Commas + Regime + Adaptive PL + Crash Lock + Equity Stabilizer
 * ----------------------------------------------------------------------------------------------------
 * Adds (1) Auto Regime Switching (TREND/RANGE) derived from ticks (slope + volatility) with hysteresis
 *      (2) Volatility-adaptive Profit Lock (ATR%-scaled) by regime
 *      (3) Crash Protection (1m/5m dump lock) blocks READY & BUY for cooldown
 *      (4) Equity Stabilizer (loss streak) adds cooldown + conservative mode gates
 *
 * Notes:
 * - No Pine changes required. Uses /tick heartbeat stream.
 * - All new logic is toggleable via env vars; defaults keep v2.7 behavior.
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const BRAIN_VERSION = "v2.8";

// ====================
// CONFIG (Railway Variables)
// ====================
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// READY TTL (minutes). 0 = disabled
const READY_TTL_MIN = Number(process.env.READY_TTL_MIN || "0");

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

// Profit Lock (trailing) protection
const PROFIT_LOCK_ENABLED =
  String(process.env.PROFIT_LOCK_ENABLED || "true").toLowerCase() === "true";

// Fixed Profit Lock (v2.7)
const PROFIT_LOCK_ARM_PCT = Number(process.env.PROFIT_LOCK_ARM_PCT || "0.6");
const PROFIT_LOCK_GIVEBACK_PCT = Number(process.env.PROFIT_LOCK_GIVEBACK_PCT || "0.35");

// v2.8 Adaptive Profit Lock (ATR%-scaled)
const PL_ADAPTIVE_ENABLED =
  String(process.env.PL_ADAPTIVE_ENABLED || "true").toLowerCase() === "true";

const PL_START_ATR_MULT_TREND = Number(process.env.PL_START_ATR_MULT_TREND || "2.2");
const PL_GIVEBACK_ATR_MULT_TREND = Number(process.env.PL_GIVEBACK_ATR_MULT_TREND || "1.2");
const PL_START_ATR_MULT_RANGE = Number(process.env.PL_START_ATR_MULT_RANGE || "1.2");
const PL_GIVEBACK_ATR_MULT_RANGE = Number(process.env.PL_GIVEBACK_ATR_MULT_RANGE || "0.7");

// Optional: ignore Ray SELL unless profit >= this % (0 disables)
const PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT = Number(
  process.env.PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT || "0"
);

// Regime switching (tick-derived)
const REGIME_ENABLED =
  String(process.env.REGIME_ENABLED || "true").toLowerCase() === "true";

// windows used for regime + ATR estimation
const SLOPE_WINDOW_SEC = Number(process.env.SLOPE_WINDOW_SEC || "300"); // 5m
const ATR_WINDOW_SEC = Number(process.env.ATR_WINDOW_SEC || "300");     // 5m
const TICK_BUFFER_SEC = Number(process.env.TICK_BUFFER_SEC || "1800");  // 30m
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
const ES_CONSERVATIVE_MIN = Number(process.env.ES_CONSERVATIVE_MIN || "45"); // conservative mode duration

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

// Cooldown state
let cooldownUntilMs = 0;

// Crash lock state
let crashLockUntilMs = 0;

// Equity stabilizer state
let lossStreak = 0;
let conservativeUntilMs = 0;

// Heartbeat / price cache
let lastTickMs = 0;
let lastTickSymbol = "";
let lastTickPrice = null;

// Per-symbol tick history: Map(symbol -> [{t, p}...])
const tickHistory = new Map();

// Regime state per symbol (default RANGE)
const regimeState = new Map(); // symbol -> { regime: "TREND"|"RANGE", updatedMs, slopePct, atrPct }

// Trade tracking for profit lock
let entryPrice = null;
let entrySymbol = "";
let peakPrice = null;
let profitLockArmed = false;

// store entry meta so exits know correct pair
let entryMeta = { tv_exchange: null, tv_instrument: null };

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

function normalizeAction(payload) {
  return payload?.action ? String(payload.action).toLowerCase() : "";
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
  return (
    toNum(payload?.trigger_price) ??
    toNum(payload?.price) ??
    toNum(payload?.close) ??
    null
  );
}

function getRayPrice(payload) {
  return toNum(payload?.price) ?? toNum(payload?.close) ?? null;
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
  // scan from end
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].t <= targetMs) return arr[i].p;
  }
  return arr[0]?.p ?? null;
}

// ATR proxy: average absolute tick-to-tick move inside ATR_WINDOW_SEC
function atrPctFromTicks(symbol, windowSec) {
  const arr = tickHistory.get(symbol);
  if (!arr || arr.length < 3) return null;

  const now = nowMs();
  const cutoff = now - windowSec * 1000;
  const sub = arr.filter(x => x.t >= cutoff);
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

// slope: absolute pct move over SLOPE_WINDOW_SEC
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

  // Hysteresis:
  // - Engage TREND if absSlope >= TREND_ON and atrPct >= volMin
  // - Disengage TREND if absSlope <= TREND_OFF
  // - Engage RANGE if absSlope <= RANGE_ON
  // - Disengage RANGE if absSlope >= RANGE_OFF
  if (prev.regime === "RANGE") {
    if (absSlope >= REGIME_TREND_SLOPE_ON_PCT && atrP >= REGIME_VOL_MIN_ATR_PCT) {
      next = "TREND";
    }
  } else {
    // TREND
    if (absSlope <= REGIME_TREND_SLOPE_OFF_PCT) {
      next = "RANGE";
    }
  }

  // extra clamp: if very low slope, force RANGE
  if (absSlope <= REGIME_RANGE_SLOPE_ON_PCT) next = "RANGE";
  // if strong again, allow TREND
  if (absSlope >= REGIME_RANGE_SLOPE_OFF_PCT && atrP >= REGIME_VOL_MIN_ATR_PCT) {
    // only flip to TREND if also past TREND_ON
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
    console.log(`🔄 REGIME SWITCH: ${symbol} ${prev.regime} -> ${next} | slope=${s.toFixed(3)}% | atr=${atrP.toFixed(3)}%`);
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

// Crash detection using price change over 1m and 5m
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
    // also clear READY to prevent stale entry
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

// ---- 3Commas forwarder (with timeout)
async function postTo3Commas(action, payload) {
  if (!THREECOMMAS_BOT_UUID || !THREECOMMAS_SECRET) {
    console.log("⚠️ 3Commas not configured (missing BOT_UUID/SECRET) — skipping");
    return { skipped: true };
  }

  // Prefer payload meta -> entryMeta -> readyMeta -> env fallbacks
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
    console.log(
      `📨 3Commas POST -> ${action} | status=${resp.status} | resp=${text || ""}`
    );
    return { ok: resp.ok, status: resp.status, resp: text };
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

  if (p < 0) {
    lossStreak += 1;
  } else {
    lossStreak = 0;
  }

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

  // update peak
  peakPrice = peakPrice == null ? currentPrice : Math.max(peakPrice, currentPrice);

  const p = pctProfit(entryPrice, currentPrice);
  if (p == null) return false;

  // Determine effective arm/giveback (adaptive or fixed)
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
    // adaptive even without regime: use TREND multipliers as default
    const atrP = atrPctFromTicks(currentSymbol, ATR_WINDOW_SEC);
    if (atrP != null) {
      armPct = PL_START_ATR_MULT_TREND * atrP;
      givebackPct = PL_GIVEBACK_ATR_MULT_TREND * atrP;
    }
  }

  // arm lock
  if (!profitLockArmed && p >= armPct) {
    profitLockArmed = true;
    console.log(`🔒 PROFIT LOCK ARMED at +${p.toFixed(3)}% (>= ${armPct.toFixed(3)}%)`);
  }

  if (!profitLockArmed) return false;

  // trailing floor from peak
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

    // equity update BEFORE clearing
    noteExitForEquity(currentPrice);

    clearReadyContext("profit_lock_exit");
    clearPositionContext("profit_lock_exit");
    startCooldown("profit_lock_exit");
    return { exited: true, threecommas: fwd };
  }

  return false;
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
    PROFIT_LOCK_ENABLED,
    PL_ADAPTIVE_ENABLED,
    PROFIT_LOCK_ARM_PCT,
    PROFIT_LOCK_GIVEBACK_PCT,
    PL_START_ATR_MULT_TREND,
    PL_GIVEBACK_ATR_MULT_TREND,
    PL_START_ATR_MULT_RANGE,
    PL_GIVEBACK_ATR_MULT_RANGE,
    PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT,
    REGIME_ENABLED,
    SLOPE_WINDOW_SEC,
    ATR_WINDOW_SEC,
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
    regime: lastTickSymbol ? (regimeState.get(lastTickSymbol) || null) : null,
    threecommas_configured: Boolean(THREECOMMAS_BOT_UUID && THREECOMMAS_SECRET),
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

  // ---- TICK (heartbeat + regime + crash + auto-expire + profit lock)
  if (payload?.src === "tick" || normalizeAction(payload) === "tick") {
    const tickPx = getTickPrice(payload);
    const tickSym = getSymbolFromPayload(payload);

    if (tickPx == null || !tickSym) {
      console.log("⚠️ Tick ignored (missing price or symbol)");
      return res.json({ ok: true, tick: true, ignored: "missing_fields" });
    }

    // Update heartbeat cache
    lastTickMs = nowMs();
    lastTickSymbol = tickSym;
    lastTickPrice = tickPx;

    // Buffer tick
    pushTick(tickSym, tickPx, lastTickMs);

    // Update regime from ticks
    const r = updateRegime(tickSym);

    // Crash protection check (may clear READY + lock)
    const crash = maybeCrashLock(tickSym);

    // Auto-expire READY if drift too large
    const expired = maybeAutoExpireReady(tickPx, tickSym);

    // Profit lock check (may auto exit)
    const pl = await maybeProfitLockExit(tickPx, tickSym);

    return res.json({
      ok: true,
      tick: true,
      regime: r || (regimeState.get(tickSym) || null),
      crash: crash || null,
      expired,
      profit_lock: pl || null,
      readyOn,
      inPosition,
      crashLockActive: crashLockActive(),
      conservativeModeActive: conservativeModeActive(),
    });
  }

  // ---- RAYALGO
  if (payload?.src === "ray") {
    const side = String(payload.side || "").toUpperCase();
    const rayPx = getRayPrice(payload);
    const raySym = getSymbolFromPayload(payload);
    console.log("Ray side:", side, "| symbol:", raySym, "| price:", rayPx);

    if (side === "BUY") {
      if (crashLockActive()) {
        lastAction = "ray_buy_blocked_crash_lock";
        return res.json({ ok: false, blocked: "crash_lock_active" });
      }

      if (cooldownActive()) {
        lastAction = "ray_buy_blocked_cooldown";
        return res.json({ ok: false, blocked: "cooldown_active" });
      }

      if (!isHeartbeatFresh()) {
        lastAction = "ray_buy_blocked_stale_heartbeat";
        return res.json({ ok: false, blocked: "stale_heartbeat" });
      }

      if (!readyOn) {
        lastAction = "ray_buy_blocked_not_ready";
        return res.json({ ok: false, blocked: "not_ready" });
      }
      if (inPosition) {
        lastAction = "ray_buy_blocked_in_position";
        return res.json({ ok: false, blocked: "already_in_position" });
      }

      if (conservativeModeActive()) {
        // simple conservative rule: only allow TREND entries during conservative mode
        const reg = raySym ? getRegime(raySym) : "RANGE";
        if (reg !== "TREND") {
          lastAction = "ray_buy_blocked_conservative_range";
          return res.json({ ok: false, blocked: "conservative_blocks_range", regime: reg });
        }
      }

      if (readySymbol && raySym && readySymbol !== raySym) {
        lastAction = "ray_buy_blocked_symbol_mismatch";
        return res.json({ ok: false, blocked: "symbol_mismatch", readySymbol, raySym });
      }
      if (readyPrice == null || rayPx == null) {
        lastAction = "ray_buy_blocked_missing_prices";
        return res.json({ ok: false, blocked: "missing_prices" });
      }

      const dPct = pctDiff(readyPrice, rayPx);
      if (dPct == null) {
        lastAction = "ray_buy_blocked_bad_price_diff";
        return res.json({ ok: false, blocked: "bad_price_diff" });
      }

      const maxMove = effectiveReadyMaxMovePct(raySym || readySymbol);

      // HARD RESET ON DRIFT BLOCK
      if (dPct > maxMove) {
        console.log(
          `⛔ Ray BUY blocked (drift ${dPct.toFixed(3)}% > ${maxMove}%) — HARD RESET READY`
        );
        clearReadyContext("hard_reset_price_drift");
        lastAction = "ray_buy_blocked_price_drift_reset";
        return res.json({ ok: false, blocked: "price_drift_reset", drift_pct: dPct, maxMove });
      }

      // Approve entry + forward to 3Commas
      inPosition = true;
      entryPrice = rayPx;
      entrySymbol = raySym || readySymbol || "";
      peakPrice = rayPx;
      profitLockArmed = false;

      // Capture entry meta NOW
      entryMeta = {
        tv_exchange: readyMeta?.tv_exchange ?? payload?.tv_exchange ?? payload?.exchange ?? null,
        tv_instrument: readyMeta?.tv_instrument ?? payload?.tv_instrument ?? payload?.ticker ?? null,
      };

      lastAction = "ray_enter_long";
      console.log(
        `🚀 RAY BUY → ENTER LONG | drift=${dPct.toFixed(3)}% (<= ${maxMove}%) | regime=${getRegime(entrySymbol)}`
      );

      const fwd = await postTo3Commas("enter_long", {
        ...payload,
        trigger_price: payload?.price ?? payload?.close ?? readyPrice,
        tv_exchange: entryMeta?.tv_exchange,
        tv_instrument: entryMeta?.tv_instrument,
      });

      return res.json({
        ok: true,
        action: "enter_long",
        source: "ray",
        drift_pct: dPct,
        maxMove,
        regime: entrySymbol ? (regimeState.get(entrySymbol) || null) : null,
        threecommas: fwd,
      });
    }

    if (side === "SELL") {
      if (!inPosition) {
        lastAction = "ray_sell_no_position";
        return res.json({ ok: false, blocked: "no_position" });
      }

      // Optional: ignore Ray SELL unless profit >= threshold
      if (PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT > 0) {
        const px = rayPx ?? lastTickPrice;
        const p = pctProfit(entryPrice, px);
        if (p != null && p < PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT) {
          lastAction = "ray_sell_blocked_profit_filter";
          console.log(
            `⛔ Ray SELL ignored: profit ${p.toFixed(3)}% < ${PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT}%`
          );
          return res.json({ ok: false, blocked: "profit_filter", profit_pct: p });
        }
      }

      lastAction = "ray_exit_long";

      const exitPx = rayPx ?? lastTickPrice ?? null;

      const fwd = await postTo3Commas("exit_long", {
        ...payload,
        trigger_price: payload?.price ?? payload?.close ?? "",
        tv_exchange: entryMeta?.tv_exchange,
        tv_instrument: entryMeta?.tv_instrument,
      });

      if (exitPx != null) noteExitForEquity(exitPx);

      clearReadyContext("exit_sell");
      clearPositionContext("exit_sell");
      startCooldown("ray_sell");

      console.log("✅ RAY SELL → EXIT LONG | READY OFF (context cleared)");
      return res.json({ ok: true, action: "exit_long", source: "ray", threecommas: fwd });
    }

    lastAction = "ray_unknown_side";
    return res.json({ ok: true, note: "ray_unknown_side" });
  }

  // ---- YY9 READY
  const action = normalizeAction(payload);

  if (action === "ready") {
    if (crashLockActive()) {
      console.log("🟡 READY ignored (crash lock active)");
      lastAction = "ready_ignored_crash_lock";
      return res.json({ ok: true, ignored: "crash_lock_active" });
    }

    if (cooldownActive()) {
      console.log("🟡 READY ignored (cooldown active)");
      lastAction = "ready_ignored_cooldown";
      return res.json({ ok: true, ignored: "cooldown_active" });
    }

    if (!isHeartbeatFresh()) {
      console.log("🟡 READY ignored (stale heartbeat)");
      lastAction = "ready_ignored_stale_heartbeat";
      return res.json({ ok: true, ignored: "stale_heartbeat" });
    }

    if (inPosition) {
      console.log("🟡 READY ignored (already in position)");
      lastAction = "ready_ignored_in_position";
      return res.json({ ok: true, ignored: "in_position" });
    }

    if (conservativeModeActive()) {
      // conservative: allow READY but it will likely block BUY later unless TREND
      console.log("🟠 READY received during conservative mode (will restrict buys)");
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

    lastAction = "ready";
    console.log("🟢 READY ON", {
      readyPrice,
      readySymbol,
      readyTf,
      READY_MAX_MOVE_PCT,
      READY_AUTOEXPIRE_ENABLED,
      READY_AUTOEXPIRE_PCT,
      regime: readySymbol ? getRegime(readySymbol) : null,
    });

    return res.json({ ok: true, readyOn, readyPrice, readySymbol, readyTf, regime: readySymbol ? (regimeState.get(readySymbol) || null) : null });
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
    `3Commas: URL=${THREECOMMAS_WEBHOOK_URL} | BOT_UUID=${THREECOMMAS_BOT_UUID ? "(set)" : "(missing)"} | SECRET=${
      THREECOMMAS_SECRET ? "(set)" : "(missing)"
    } | TIMEOUT_MS=${THREECOMMAS_TIMEOUT_MS}`
  );
});
