/**
 * BrainPhase2_DemoLong_v3.7i
 *
 * Long-only demo brain
 *
 * v3.7i goals:
 * - Preserve v3.7h trading logic
 * - Add restart-safe SmartTrade position sync
 * - Restore open position state after reboot
 * - Optionally re-sync periodically
 */

import express from "express";
import crypto from "crypto";

// --------------------------------------------------
// App / config
// --------------------------------------------------
const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 8080);
const DEBUG = String(process.env.DEBUG || "1") === "1";
const BRAIN_NAME = process.env.BRAIN_NAME || "BrainPhase2_DemoLong_v3.7i";

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const TICKROUTER_SECRET = process.env.TICKROUTER_SECRET || "";

const C3_SIGNAL_URL =
  process.env.C3_SIGNAL_URL || "https://api.3commas.io/signal_bots/webhooks";
const C3_SIGNAL_SECRET = process.env.C3_SIGNAL_SECRET || "";
const C3_TIMEOUT_MS = Number(process.env.C3_TIMEOUT_MS || 8000);
const MAX_LAG_SEC = Number(process.env.MAX_LAG_SEC || 300);

const SYMBOL_BOT_MAP = safeJson(process.env.SYMBOL_BOT_MAP || "{}", {});
const ALLOW_SYMBOLS = Object.keys(SYMBOL_BOT_MAP);

// --------------------------------------------------
// 3Commas SmartTrade sync
// --------------------------------------------------
const C3_SYNC_ENABLE = String(process.env.C3_SYNC_ENABLE || "1") === "1";
const C3_SYNC_ON_STARTUP = String(process.env.C3_SYNC_ON_STARTUP || "1") === "1";
const C3_SYNC_INTERVAL_SEC = Number(process.env.C3_SYNC_INTERVAL_SEC || 180);
const C3_API_BASE_URL =
  process.env.C3_API_BASE_URL || "https://api.3commas.io/public/api";
const C3_API_KEY = process.env.C3_API_KEY || "";
const C3_API_SECRET = process.env.C3_API_SECRET || "";
const C3_SMARTTRADE_PAIR_MAP = safeJson(
  process.env.C3_SMARTTRADE_PAIR_MAP || "{}",
  {}
);
const C3_SYNC_ONLY_IF_LOCAL_FLAT =
  String(process.env.C3_SYNC_ONLY_IF_LOCAL_FLAT || "1") === "1";
const C3_SYNC_LOG_VERBOSE = String(process.env.C3_SYNC_LOG_VERBOSE || "1") === "1";

// --------------------------------------------------
// Warmup / lifecycle
// --------------------------------------------------
const MIN_BARS_FOR_SETUPS = Number(process.env.MIN_BARS_FOR_SETUPS || 8);
const SETUP_TTL_SEC = Number(process.env.SETUP_TTL_SEC || 1800);
const BREAKOUT_MAX_AGE_MIN = Number(process.env.BREAKOUT_MAX_AGE_MIN || 12);
const BREAKOUT_RETEST_MAX_MIN = Number(process.env.BREAKOUT_RETEST_MAX_MIN || 4);
const WASHOUT_MAX_AGE_MIN = Number(process.env.WASHOUT_MAX_AGE_MIN || 12);
const RECOVERY_MAX_AGE_MIN = Number(process.env.RECOVERY_MAX_AGE_MIN || 6);

// breakout cleanup
const BREAKOUT_B_FAIL_RESET_MIN = Number(
  process.env.BREAKOUT_B_FAIL_RESET_MIN || 2.5
);
const BREAKOUT_B_FAIL_RESET_MAX_BOUNCE_PCT = Number(
  process.env.BREAKOUT_B_FAIL_RESET_MAX_BOUNCE_PCT || 0.05
);
const BREAKOUT_FAIL_CONFIRM_MAX = Number(
  process.env.BREAKOUT_FAIL_CONFIRM_MAX || 6
);
const BREAKOUT_FAIL_CONFIRM_NO_RECLAIM_MAX = Number(
  process.env.BREAKOUT_FAIL_CONFIRM_NO_RECLAIM_MAX || 4
);

// breakout late / extension controls
const BREAKOUT_HARD_LATE_ENTRY_MIN = Number(
  process.env.BREAKOUT_HARD_LATE_ENTRY_MIN || 1.0
);
const BREAKOUT_HARD_LATE_NEAR_LEVEL_PCT = Number(
  process.env.BREAKOUT_HARD_LATE_NEAR_LEVEL_PCT || 0.22
);

const BREAKOUT_B_MAX_NEAR_LEVEL_PCT = Number(
  process.env.BREAKOUT_B_MAX_NEAR_LEVEL_PCT || 0.18
);
const BREAKOUT_B_LATE_ENTRY_MIN = Number(
  process.env.BREAKOUT_B_LATE_ENTRY_MIN || 0.3
);
const BREAKOUT_B_LATE_NEAR_LEVEL_PCT = Number(
  process.env.BREAKOUT_B_LATE_NEAR_LEVEL_PCT || 0.14
);

const BREAKOUT_STALE_CLEAR_AGE_MIN = Number(
  process.env.BREAKOUT_STALE_CLEAR_AGE_MIN || 4
);
const BREAKOUT_STALE_CLEAR_NEAR_LEVEL_PCT = Number(
  process.env.BREAKOUT_STALE_CLEAR_NEAR_LEVEL_PCT || 0.30
);
const BREAKOUT_WEAK_PROGRESS_CLEAR_AGE_MIN = Number(
  process.env.BREAKOUT_WEAK_PROGRESS_CLEAR_AGE_MIN || 2
);
const BREAKOUT_WEAK_PROGRESS_MIN_BOUNCE_PCT = Number(
  process.env.BREAKOUT_WEAK_PROGRESS_MIN_BOUNCE_PCT || 0.04
);

// recovery path
const RECOVERY_MIN_SCORE = Number(process.env.RECOVERY_MIN_SCORE || 5);
const RECOVERY_MAX_NEAR_EMA8_PCT = Number(
  process.env.RECOVERY_MAX_NEAR_EMA8_PCT || 0.20
);
const RECOVERY_MAX_NEAR_EMA18_PCT = Number(
  process.env.RECOVERY_MAX_NEAR_EMA18_PCT || 0.28
);
const RECOVERY_BOUNCE_MIN_PCT = Number(
  process.env.RECOVERY_BOUNCE_MIN_PCT || 0.02
);
const RECOVERY_REQUIRE_CVD_NON_NEGATIVE =
  String(process.env.RECOVERY_REQUIRE_CVD_NON_NEGATIVE || "0") === "1";
const RECOVERY_REQUIRE_OI_NON_NEGATIVE =
  String(process.env.RECOVERY_REQUIRE_OI_NON_NEGATIVE || "1") === "1";
const RECOVERY_RSI_MIN = Number(process.env.RECOVERY_RSI_MIN || 38);
const RECOVERY_ADX_MAX = Number(process.env.RECOVERY_ADX_MAX || 28);
const RECOVERY_ATRPCT_MIN = Number(process.env.RECOVERY_ATRPCT_MIN || 0.16);
const RECOVERY_EARLY_TREND_ADX_MAX = Number(
  process.env.RECOVERY_EARLY_TREND_ADX_MAX || 32
);

// shallow recovery path
const SHALLOW_RECOVERY_ENABLE =
  String(process.env.SHALLOW_RECOVERY_ENABLE || "1") === "1";
const SHALLOW_RECOVERY_MIN_SCORE = Number(
  process.env.SHALLOW_RECOVERY_MIN_SCORE || 6
);
const SHALLOW_RECOVERY_RSI_MIN = Number(
  process.env.SHALLOW_RECOVERY_RSI_MIN || 44
);
const SHALLOW_RECOVERY_ADX_MAX = Number(
  process.env.SHALLOW_RECOVERY_ADX_MAX || 28
);
const SHALLOW_RECOVERY_ATRPCT_MIN = Number(
  process.env.SHALLOW_RECOVERY_ATRPCT_MIN || 0.07
);
const SHALLOW_RECOVERY_MAX_NEAR_EMA8_PCT = Number(
  process.env.SHALLOW_RECOVERY_MAX_NEAR_EMA8_PCT || 0.20
);
const SHALLOW_RECOVERY_MAX_NEAR_EMA18_PCT = Number(
  process.env.SHALLOW_RECOVERY_MAX_NEAR_EMA18_PCT || 0.30
);
const SHALLOW_RECOVERY_BOUNCE_MIN_PCT = Number(
  process.env.SHALLOW_RECOVERY_BOUNCE_MIN_PCT || 0.015
);
const SHALLOW_RECOVERY_REQUIRE_CVD_NON_NEGATIVE =
  String(process.env.SHALLOW_RECOVERY_REQUIRE_CVD_NON_NEGATIVE || "0") === "1";
const SHALLOW_RECOVERY_REQUIRE_OI_NON_NEGATIVE =
  String(process.env.SHALLOW_RECOVERY_REQUIRE_OI_NON_NEGATIVE || "0") === "1";
const SHALLOW_RECOVERY_REQUIRE_RECLAIM_EMA18 =
  String(process.env.SHALLOW_RECOVERY_REQUIRE_RECLAIM_EMA18 || "1") === "1";
const SHALLOW_RECOVERY_REQUIRE_UPTICK =
  String(process.env.SHALLOW_RECOVERY_REQUIRE_UPTICK || "1") === "1";

const SHALLOW_RECOVERY_MIN_FLOW_SUPPORT = Number(
  process.env.SHALLOW_RECOVERY_MIN_FLOW_SUPPORT || 2
);
const SHALLOW_RECOVERY_ALLOW_SCORE9_FLOW1 =
  String(process.env.SHALLOW_RECOVERY_ALLOW_SCORE9_FLOW1 || "1") === "1";
const SHALLOW_RECOVERY_MOMENTUM_RSI_MIN = Number(
  process.env.SHALLOW_RECOVERY_MOMENTUM_RSI_MIN || 60
);
const SHALLOW_RECOVERY_MOMENTUM_MIN_SCORE = Number(
  process.env.SHALLOW_RECOVERY_MOMENTUM_MIN_SCORE || 9
);
const SHALLOW_RECOVERY_MOMENTUM_MIN_FLOW = Number(
  process.env.SHALLOW_RECOVERY_MOMENTUM_MIN_FLOW || 2
);

// premium breakout tiny-bounce exception
const BREAKOUT_PREMIUM_CONFIRM_ENABLE =
  String(process.env.BREAKOUT_PREMIUM_CONFIRM_ENABLE || "1") === "1";
const BREAKOUT_PREMIUM_MIN_SCORE = Number(
  process.env.BREAKOUT_PREMIUM_MIN_SCORE || 9
);
const BREAKOUT_PREMIUM_MAX_NEAR_LEVEL_PCT = Number(
  process.env.BREAKOUT_PREMIUM_MAX_NEAR_LEVEL_PCT || 0.10
);
const BREAKOUT_PREMIUM_MIN_BOUNCE_PCT = Number(
  process.env.BREAKOUT_PREMIUM_MIN_BOUNCE_PCT || 0.01
);

// --------------------------------------------------
// Freshness
// --------------------------------------------------
const REQUIRE_FRESH_HEARTBEAT =
  String(process.env.REQUIRE_FRESH_HEARTBEAT || "1") === "1";
const HEARTBEAT_MAX_AGE_SEC = Number(process.env.HEARTBEAT_MAX_AGE_SEC || 90);
const TICK_MAX_AGE_SEC = Number(process.env.TICK_MAX_AGE_SEC || 60);
const TICK_LOG_EVERY_MS = Number(process.env.TICK_LOG_EVERY_MS || 180000);
const RAY_SIGNAL_TTL_MS = Number(process.env.RAY_SIGNAL_TTL_MS || 900000);
const FWO_SIGNAL_TTL_MS = Number(process.env.FWO_SIGNAL_TTL_MS || 900000);

// --------------------------------------------------
// Dedupe / cooldown
// --------------------------------------------------
const ENTER_DEDUP_SEC = Number(process.env.ENTER_DEDUP_SEC || 25);
const EXIT_DEDUP_SEC = Number(process.env.EXIT_DEDUP_SEC || 20);
const COOLDOWN_SEC = Number(process.env.COOLDOWN_SEC || 180);

// --------------------------------------------------
// Setup thresholds
// --------------------------------------------------
const BREAKOUT_MIN_SCORE = Number(process.env.BREAKOUT_MIN_SCORE || 7);
const WASHOUT_MIN_SCORE = Number(process.env.WASHOUT_MIN_SCORE || 6);
const BREAKOUT_MIN_ADX = Number(process.env.BREAKOUT_MIN_ADX || 20);
const BREAKOUT_A_GRADE_ADX_MIN = Number(process.env.BREAKOUT_A_GRADE_ADX_MIN || 22);
const BREAKOUT_STALE_MIN_SCORE = Number(
  process.env.BREAKOUT_STALE_MIN_SCORE || 5
);

const BREAKOUT_CONFIRM_BOUNCE_PCT_STRONG = Number(
  process.env.BREAKOUT_CONFIRM_BOUNCE_PCT_STRONG || 0.08
);
const BREAKOUT_CONFIRM_BOUNCE_PCT_WEAK = Number(
  process.env.BREAKOUT_CONFIRM_BOUNCE_PCT_WEAK || 0.12
);

const BREAKOUT_NEAR_LEVEL_MAX_PCT_STRONG = Number(
  process.env.BREAKOUT_NEAR_LEVEL_MAX_PCT_STRONG || 0.30
);
const BREAKOUT_NEAR_LEVEL_MAX_PCT_WEAK = Number(
  process.env.BREAKOUT_NEAR_LEVEL_MAX_PCT_WEAK || 0.20
);
const BREAKOUT_NEAR_EMA8_MAX_PCT = Number(
  process.env.BREAKOUT_NEAR_EMA8_MAX_PCT || 0.20
);
const MAX_CHASE_PCT_WASHOUT = Number(process.env.MAX_CHASE_PCT_WASHOUT || 0.20);
const MAX_CHASE_PCT_BREAKOUT_STRONG = Number(
  process.env.MAX_CHASE_PCT_BREAKOUT_STRONG || 0.30
);
const MAX_CHASE_PCT_BREAKOUT_WEAK = Number(
  process.env.MAX_CHASE_PCT_BREAKOUT_WEAK || 0.18
);
const BREAKOUT_LATE_AGE_MIN = Number(process.env.BREAKOUT_LATE_AGE_MIN || 2.5);

const BREAKOUT_MIN_FLOW_SUPPORT = Number(process.env.BREAKOUT_MIN_FLOW_SUPPORT || 2);
const BREAKOUT_ALLOW_SCORE9_FLOW1 =
  String(process.env.BREAKOUT_ALLOW_SCORE9_FLOW1 || "1") === "1";

const PUMP_BLOCK_PCT = Number(process.env.PUMP_BLOCK_PCT || 1.8);
const PUMP_BLOCK_WINDOW_BARS = Number(process.env.PUMP_BLOCK_WINDOW_BARS || 3);

// --------------------------------------------------
// Risk / sizing
// --------------------------------------------------
const BOT_MAX_NOTIONAL_USDT = Number(process.env.BOT_MAX_NOTIONAL_USDT || 3000);
const ACCOUNT_EQUITY = Number(process.env.ACCOUNT_EQUITY || 3000);

const BASE_RISK_PCT = Number(process.env.BASE_RISK_PCT || 0.35);
const MIN_RISK_PCT = Number(process.env.MIN_RISK_PCT || 0.2);
const MAX_RISK_PCT = Number(process.env.MAX_RISK_PCT || 0.7);

const MIN_VOLUME_PCT = Number(process.env.MIN_VOLUME_PCT || 5);
const MAX_VOLUME_PCT = Number(process.env.MAX_VOLUME_PCT || 100);

const BREAKOUT_VOLUME_CAP_FLOW1 = Number(
  process.env.BREAKOUT_VOLUME_CAP_FLOW1 || 40
);
const BREAKOUT_VOLUME_CAP_FLOW2 = Number(
  process.env.BREAKOUT_VOLUME_CAP_FLOW2 || 65
);
const BREAKOUT_VOLUME_CAP_FLOW3 = Number(
  process.env.BREAKOUT_VOLUME_CAP_FLOW3 || 100
);
const RECOVERY_VOLUME_CAP = Number(process.env.RECOVERY_VOLUME_CAP || 45);

// --------------------------------------------------
// Trade management
// --------------------------------------------------
const TREND_STOP_ACTIVATE_MIN = Number(
  process.env.TREND_STOP_ACTIVATE_MIN || 9
);
const TREND_MIN_TRAIL_PCT = Number(process.env.TREND_MIN_TRAIL_PCT || 0.5);
const TREND_TIME_STOP_MIN = Number(process.env.TREND_TIME_STOP_MIN || 60);
const TREND_MIN_PROGRESS_PCT = Number(
  process.env.TREND_MIN_PROGRESS_PCT || 0.15
);
const TRAIL_ATR_MULT = Number(process.env.TRAIL_ATR_MULT || 2.0);

// --------------------------------------------------
// Utilities
// --------------------------------------------------
function safeJson(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function nowMs() {
  return Date.now();
}

function ageSec(ts) {
  if (!ts) return 999999;
  return (nowMs() - ts) / 1000;
}

function ageMin(ts) {
  return ageSec(ts) / 60;
}

function pctChange(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0;
  return ((a - b) / b) * 100;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function fmt(x, d = 4) {
  return Number.isFinite(x) ? Number(x).toFixed(d) : "na";
}

function dlog(...args) {
  if (DEBUG) console.log(...args);
}

function verifySecret(req, isTick = false) {
  const supplied =
    req.headers["x-webhook-secret"] ||
    req.body?.secret ||
    req.query?.secret ||
    "";
  const expected = isTick ? TICKROUTER_SECRET : WEBHOOK_SECRET;
  if (!expected) return true;
  return String(supplied) === String(expected);
}

function symbolTo3CommasPair(symbol) {
  if (C3_SMARTTRADE_PAIR_MAP[symbol]) return C3_SMARTTRADE_PAIR_MAP[symbol];

  const raw = String(symbol || "").split(":")[1] || "";
  const quotes = ["USDT", "USDC", "BUSD", "BTC", "ETH", "BNB", "USD"];
  for (const q of quotes) {
    if (raw.endsWith(q) && raw.length > q.length) {
      const base = raw.slice(0, raw.length - q.length);
      return `${q}_${base}`;
    }
  }
  return raw ? `USDT_${raw.replace(/USDT$/, "")}` : "";
}

function build3CSignaturePayload(path, queryString = "", body = "") {
  const qs = queryString ? `?${queryString}` : "";
  return `${path}${qs}${body || ""}`;
}

function sign3CRequestHmac(payload) {
  return crypto.createHmac("sha256", C3_API_SECRET).update(payload).digest("hex");
}

async function fetch3C(path, { method = "GET", query = {}, body = null } = {}) {
  if (!C3_API_KEY || !C3_API_SECRET) {
    return { ok: false, err: "missing 3c api credentials" };
  }

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v == null || v === "") continue;
    qs.set(k, String(v));
  }
  const queryString = qs.toString();
  const bodyStr = body ? JSON.stringify(body) : "";
  const sigPayload = build3CSignaturePayload(path, queryString, bodyStr);
  const signature = sign3CRequestHmac(sigPayload);
  const url = `${C3_API_BASE_URL}${path}${queryString ? `?${queryString}` : ""}`;

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), C3_TIMEOUT_MS);

    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        APIKEY: C3_API_KEY,
        Signature: signature,
      },
      body: body ? bodyStr : undefined,
      signal: ac.signal,
    }).finally(() => clearTimeout(timer));

    const text = await res.text().catch(() => "");
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (C3_SYNC_LOG_VERBOSE) {
      dlog(`🔄 3C API ${method} ${path} status=${res.status}`);
    }

    return { ok: res.ok, status: res.status, text, json };
  } catch (err) {
    return { ok: false, err: err?.message || String(err) };
  }
}

function extractSmartTradeState(trade) {
  if (!trade || typeof trade !== "object") return null;

  const basicStatus = trade?.status?.basic_type || trade?.status?.type || "";
  const positionType = trade?.position?.type || "";
  const data = trade?.data || {};

  const finished = data.finished === true;
  const enteredAmount =
    n(data.entered_amount) ??
    n(trade?.position?.units?.value) ??
    0;
  const closedAmount = n(data.closed_amount) ?? 0;

  const avgEnter =
    n(data.average_enter_price) ??
    n(data.average_enter_price_without_commission) ??
    n(trade?.position?.price?.value) ??
    n(trade?.position?.price?.value_without_commission);

  const currentLast = n(data?.current_price?.last);
  const createdAtMs = data.created_at ? Date.parse(data.created_at) : 0;

  const stopLoss =
    n(trade?.stop_loss?.conditional?.price?.value) ??
    n(trade?.stop_loss?.price?.value);

  const isOpenLong =
    !finished &&
    positionType === "buy" &&
    enteredAmount > closedAmount &&
    (basicStatus === "waiting_targets" ||
      basicStatus === "position_opened" ||
      basicStatus === "order_placed" ||
      basicStatus === "waiting_position" ||
      enteredAmount > 0);

  if (!isOpenLong || !Number.isFinite(avgEnter)) return null;

  return {
    id: trade.id,
    pair: trade.pair,
    entryPrice: avgEnter,
    entryTs: Number.isFinite(createdAtMs) && createdAtMs > 0 ? createdAtMs : nowMs(),
    peakPrice: Number.isFinite(currentLast) ? currentLast : avgEnter,
    stopPrice: Number.isFinite(stopLoss) ? stopLoss : avgEnter * 0.985,
    trailingStop: Number.isFinite(stopLoss) ? stopLoss : avgEnter * 0.985,
    rawStatus: basicStatus,
    enteredAmount,
    closedAmount,
  };
}

async function findOpenSmartTradeForSymbol(symbol) {
  const pair = symbolTo3CommasPair(symbol);
  if (!pair) return { ok: false, err: "cannot derive 3c pair" };

  const listRes = await fetch3C("/v2/smart_trades", {
    method: "GET",
    query: { per_page: 100, page: 1 },
  });

  if (!listRes.ok) return listRes;
  const arr = Array.isArray(listRes.json) ? listRes.json : [];

  const candidates = arr.filter((x) => String(x?.pair || "") === pair);
  for (const item of candidates) {
    const state = extractSmartTradeState(item);
    if (state) return { ok: true, trade: item, state };
  }

  return { ok: true, trade: null, state: null };
}

// --------------------------------------------------
// State
// --------------------------------------------------
const S = {};

function ensureState(symbol) {
  if (!S[symbol]) {
    S[symbol] = {
      symbol,

      lastPrice: null,
      lastTickMs: 0,
      tickCount: 0,
      lastTickLogMs: 0,

      tf: "3",
      close: null,
      ema8: null,
      ema18: null,
      ema50: null,
      rsi: null,
      adx: null,
      atr: null,
      atrPct: null,
      heartbeat: 0,
      lastHeartbeatMs: 0,

      rayFresh: 0,
      fwoFresh: 0,
      raySignal: "",
      fwoSignal: "",
      lastRayBullMs: 0,
      lastRayBearMs: 0,
      lastFwoBullMs: 0,
      lastFwoBearMs: 0,

      oiTrend: 0,
      oiDeltaBias: 0,
      cvdTrend: 0,
      liqClusterBelow: 0,
      priceDropPct: 0,
      patternAReady: 0,
      patternAWatch: 0,

      barsSeen: 0,
      closeHist: [],

      regime: "range",
      regimeConf: 0.4,

      armed: false,
      setupType: "",
      setupPhase: "idle",
      setupTs: 0,
      setupScore: 0,
      setupReasons: [],
      setupGrade: "",
      flowSupport: 0,
      level: null,
      triggerPrice: null,
      retestPrice: null,
      bouncePrice: null,
      invalidation: null,
      failConfirmCount: 0,
      failConfirmNoReclaimCount: 0,

      inPosition: false,
      entryPrice: null,
      entryTs: 0,
      peakPrice: null,
      stopPrice: null,
      trailingStop: null,

      syncedSmartTradeId: null,
      syncedSmartTradePair: null,
      lastSyncMs: 0,

      enterInFlight: false,
      exitInFlight: false,
      lastEnterMs: 0,
      lastExitMs: 0,
      cooldownUntilMs: 0,

      lastAction: "none",
    };
  }
  return S[symbol];
}

function applySyncedPosition(st, sync) {
  if (!sync) return;

  st.inPosition = true;
  st.entryPrice = sync.entryPrice;
  st.entryTs = sync.entryTs;
  st.peakPrice = Math.max(sync.peakPrice ?? sync.entryPrice, sync.entryPrice);
  st.stopPrice = sync.stopPrice;
  st.trailingStop = sync.trailingStop;
  st.syncedSmartTradeId = sync.id;
  st.syncedSmartTradePair = sync.pair;
  st.lastSyncMs = nowMs();
  clearSetup(st, "position_sync");
  dlog(
    `🔄 POSITION SYNC restored symbol=${st.symbol} tradeId=${sync.id} entry=${fmt(
      sync.entryPrice
    )} peak=${fmt(st.peakPrice)} stop=${fmt(st.stopPrice)} status=${sync.rawStatus}`
  );
}

async function syncPositionForSymbol(symbol) {
  if (!C3_SYNC_ENABLE) return;
  const st = ensureState(symbol);

  if (C3_SYNC_ONLY_IF_LOCAL_FLAT && st.inPosition) {
    st.lastSyncMs = nowMs();
    return;
  }

  const found = await findOpenSmartTradeForSymbol(symbol);
  st.lastSyncMs = nowMs();

  if (!found.ok) {
    dlog(`⚠️ POSITION SYNC failed symbol=${symbol} err=${found.err || found.status}`);
    return;
  }

  if (found.state) {
    applySyncedPosition(st, found.state);
  } else if (C3_SYNC_LOG_VERBOSE) {
    dlog(`🔄 POSITION SYNC none symbol=${symbol}`);
  }
}

async function syncAllPositions(reason = "manual") {
  if (!C3_SYNC_ENABLE) return;
  for (const symbol of ALLOW_SYMBOLS) {
    try {
      if (C3_SYNC_LOG_VERBOSE) dlog(`🔄 POSITION SYNC start symbol=${symbol} reason=${reason}`);
      await syncPositionForSymbol(symbol);
    } catch (err) {
      dlog(`⚠️ POSITION SYNC exception symbol=${symbol} err=${err?.message || err}`);
    }
  }
}

// --------------------------------------------------
// Core helpers
// --------------------------------------------------
function updateCloseHistory(st, close) {
  if (!Number.isFinite(close)) return;
  st.closeHist.push(close);
  if (st.closeHist.length > 30) st.closeHist.shift();
}

function recentPumpPct(st) {
  if (st.closeHist.length < PUMP_BLOCK_WINDOW_BARS + 1) return 0;
  const from = st.closeHist[st.closeHist.length - 1 - PUMP_BLOCK_WINDOW_BARS];
  const to = st.closeHist[st.closeHist.length - 1];
  return pctChange(to, from);
}

function isFreshTick(st) {
  return ageSec(st.lastTickMs) <= TICK_MAX_AGE_SEC;
}

function isFreshHeartbeat(st) {
  if (!REQUIRE_FRESH_HEARTBEAT) return true;
  return ageSec(st.lastHeartbeatMs) <= HEARTBEAT_MAX_AGE_SEC;
}

function inCooldown(st) {
  return nowMs() < st.cooldownUntilMs;
}

function shouldDedupeEnter(st) {
  if (st.enterInFlight) return true;
  return ageSec(st.lastEnterMs) < ENTER_DEDUP_SEC;
}

function shouldDedupeExit(st) {
  if (st.exitInFlight) return true;
  return ageSec(st.lastExitMs) < EXIT_DEDUP_SEC;
}

function clearSetup(st, reason = "") {
  if (reason) dlog(`🧹 Setup cleared (${reason}) type=${st.setupType || "na"}`);
  st.armed = false;
  st.setupType = "";
  st.setupPhase = "idle";
  st.setupTs = 0;
  st.setupScore = 0;
  st.setupReasons = [];
  st.setupGrade = "";
  st.flowSupport = 0;
  st.level = null;
  st.triggerPrice = null;
  st.retestPrice = null;
  st.bouncePrice = null;
  st.invalidation = null;
  st.failConfirmCount = 0;
  st.failConfirmNoReclaimCount = 0;
}

function resetPosition(st) {
  st.inPosition = false;
  st.entryPrice = null;
  st.entryTs = 0;
  st.peakPrice = null;
  st.stopPrice = null;
  st.trailingStop = null;
  st.syncedSmartTradeId = null;
  st.syncedSmartTradePair = null;
}

function computeRegime(st) {
  let score = 0;
  const bullAligned =
    st.ema8 != null &&
    st.ema18 != null &&
    st.ema50 != null &&
    st.ema8 > st.ema18 &&
    st.ema18 > st.ema50;

  if (bullAligned) score += 2;
  if ((st.adx || 0) >= 18) score += 1;
  if ((st.adx || 0) >= 25) score += 1;
  if ((st.atrPct || 0) >= 0.25) score += 1;

  if (score >= 4) return { mode: "trend", conf: 0.8 };
  if (score >= 3) return { mode: "trend", conf: 0.6 };
  return { mode: "range", conf: 0.4 };
}

function computeSignalFreshness(st) {
  st.rayFresh =
    Math.max(st.lastRayBullMs, st.lastRayBearMs) &&
    nowMs() - Math.max(st.lastRayBullMs, st.lastRayBearMs) <= RAY_SIGNAL_TTL_MS
      ? 1
      : 0;

  st.fwoFresh =
    Math.max(st.lastFwoBullMs, st.lastFwoBearMs) &&
    nowMs() - Math.max(st.lastFwoBullMs, st.lastFwoBearMs) <= FWO_SIGNAL_TTL_MS
      ? 1
      : 0;
}

function computeFlowSupport(st) {
  let x = 0;
  if (st.oiTrend > 0) x += 1;
  if (st.oiDeltaBias > 0) x += 1;
  if (st.cvdTrend > 0) x += 1;
  return x;
}

function computeStopDistancePct(entry, stop) {
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || stop >= entry) return 0.5;
  return ((entry - stop) / entry) * 100;
}

function getPrevClose(st) {
  return st.closeHist.length >= 2 ? st.closeHist[st.closeHist.length - 2] : null;
}

function isEarlyTrendRecovery(st) {
  return (
    st.regime === "trend" &&
    (st.adx || 0) <= RECOVERY_EARLY_TREND_ADX_MAX &&
    st.ema8 != null &&
    st.ema18 != null &&
    st.ema8 > st.ema18
  );
}

function hasContradictoryShallowInternals(st) {
  return st.oiDeltaBias < 0 && st.cvdTrend < 0;
}

function hasNonHostileShallowInternals(st) {
  return st.oiDeltaBias >= 0 && st.cvdTrend >= 0;
}

function shallowRecoveryQualityPass(st, score, flowSupport) {
  if (hasContradictoryShallowInternals(st)) return false;

  if (flowSupport >= SHALLOW_RECOVERY_MIN_FLOW_SUPPORT) return true;

  if (
    SHALLOW_RECOVERY_ALLOW_SCORE9_FLOW1 &&
    flowSupport === 1 &&
    score >= 9 &&
    hasNonHostileShallowInternals(st)
  ) {
    return true;
  }

  return false;
}

// --------------------------------------------------
// Scoring
// --------------------------------------------------
function scoreBreakout(st) {
  let score = 0;
  const reasons = [];
  const bullAligned =
    st.ema8 != null &&
    st.ema18 != null &&
    st.ema50 != null &&
    st.ema8 > st.ema18 &&
    st.ema18 > st.ema50;

  const flowSupport = computeFlowSupport(st);

  if (st.regime === "trend") {
    score += 2;
    reasons.push("regime(trend)+2");
  }

  if (bullAligned) {
    score += 2;
    reasons.push("bull aligned +2");
  }

  if ((st.adx || 0) >= BREAKOUT_MIN_ADX) {
    score += 1;
    reasons.push("adx ok +1");
  }

  if ((st.rsi || 0) >= 55) {
    score += 1;
    reasons.push("rsi strength +1");
  }

  if (st.rayFresh) {
    score += 1;
    reasons.push("fresh ray +1");
  }

  if (st.fwoFresh) {
    score += 1;
    reasons.push("fresh fwo +1");
  }

  if (st.oiTrend > 0) {
    score += 1;
    reasons.push("oi trend up +1");
  }
  if (st.oiDeltaBias > 0) {
    score += 1;
    reasons.push("oi expansion +1");
  }
  if (st.cvdTrend > 0) {
    score += 1;
    reasons.push("cvd bullish +1");
  }

  const pumpPct = recentPumpPct(st);
  if (pumpPct > PUMP_BLOCK_PCT) {
    score -= 3;
    reasons.push(`pump>${PUMP_BLOCK_PCT}% -3`);
  }

  if (flowSupport === 0) {
    score -= 2;
    reasons.push("flow=0 -2");
  }

  return { score, reasons, flowSupport };
}

function scoreWashout(st) {
  let score = 0;
  const reasons = [];
  const flowSupport = computeFlowSupport(st);

  score += 1;
  reasons.push(`regime(${st.regime}) +1`);

  if ((st.rsi || 0) > 0 && (st.rsi || 0) <= 45) {
    score += 1;
    reasons.push("rsi recovering +1");
  }

  if (st.fwoFresh) {
    score += 2;
    reasons.push("fresh fwo +2");
  }

  if (st.rayFresh) {
    score += 1;
    reasons.push("fresh ray +1");
  }

  if (st.oiTrend > 0) {
    score += 1;
    reasons.push("oi trend up +1");
  }

  if (st.oiDeltaBias > 0) {
    score += 1;
    reasons.push("oi expansion +1");
  }

  if (st.cvdTrend > 0) {
    score += 1;
    reasons.push("cvd bullish +1");
  }

  if (st.liqClusterBelow) {
    score += 1;
    reasons.push("liq below +1");
  }

  if ((st.priceDropPct || 0) <= -0.2) {
    score += 1;
    reasons.push("recent flush +1");
  }

  return { score, reasons, flowSupport };
}

function scoreRecovery(st) {
  let score = 0;
  const reasons = [];
  const flowSupport = computeFlowSupport(st);

  if (st.regime === "range") {
    score += 1;
    reasons.push("range recovery +1");
  } else if (isEarlyTrendRecovery(st)) {
    score += 1;
    reasons.push("early trend recovery +1");
  }

  if ((st.rsi || 0) >= RECOVERY_RSI_MIN) {
    score += 1;
    reasons.push("rsi recovery +1");
  }

  if ((st.atrPct || 0) >= RECOVERY_ATRPCT_MIN) {
    score += 1;
    reasons.push("atrPct healthy +1");
  }

  if ((st.adx || 0) <= RECOVERY_ADX_MAX) {
    score += 1;
    reasons.push("adx acceptable +1");
  }

  if (st.oiTrend >= 0) {
    score += 1;
    reasons.push("oi not hostile +1");
  }

  if (st.oiDeltaBias >= 0) {
    score += 1;
    reasons.push("oi delta not hostile +1");
  }

  if (st.cvdTrend >= 0) {
    score += 1;
    reasons.push("cvd not hostile +1");
  }

  if (st.close != null && st.ema8 != null && st.close >= st.ema8) {
    score += 1;
    reasons.push("above ema8 +1");
  }

  if (st.close != null && st.ema18 != null && st.close >= st.ema18) {
    score += 1;
    reasons.push("above ema18 +1");
  }

  if ((st.priceDropPct || 0) <= -0.15) {
    score += 1;
    reasons.push("recent drop context +1");
  }

  if (flowSupport === 0) {
    score -= 0.5;
    reasons.push("flow=0 -0.5");
  }

  return { score, reasons, flowSupport };
}

function scoreShallowRecovery(st) {
  let score = 0;
  const reasons = [];
  const flowSupport = computeFlowSupport(st);

  if (st.regime === "range") {
    score += 1;
    reasons.push("range shallow recovery +1");
  } else if (isEarlyTrendRecovery(st)) {
    score += 1;
    reasons.push("early trend shallow recovery +1");
  }

  if ((st.rsi || 0) >= SHALLOW_RECOVERY_RSI_MIN) {
    score += 1;
    reasons.push("rsi ok +1");
  }

  if ((st.atrPct || 0) >= SHALLOW_RECOVERY_ATRPCT_MIN) {
    score += 1;
    reasons.push("atrPct ok +1");
  }

  if ((st.adx || 0) <= SHALLOW_RECOVERY_ADX_MAX) {
    score += 1;
    reasons.push("adx ok +1");
  }

  if (st.close != null && st.ema8 != null && st.close >= st.ema8) {
    score += 1;
    reasons.push("above ema8 +1");
  }

  if (st.close != null && st.ema18 != null && st.close >= st.ema18) {
    score += 1;
    reasons.push("above ema18 +1");
  }

  if (st.rayFresh) {
    score += 1;
    reasons.push("fresh ray +1");
  }

  if (st.fwoFresh) {
    score += 1;
    reasons.push("fresh fwo +1");
  }

  if (st.oiTrend >= 0) {
    score += 1;
    reasons.push("oi not hostile +1");
  }

  if (st.oiDeltaBias >= 0) {
    score += 1;
    reasons.push("oi delta not hostile +1");
  }

  if (st.cvdTrend >= 0) {
    score += 1;
    reasons.push("cvd not hostile +1");
  }

  if (flowSupport === 0) {
    score -= 0.75;
    reasons.push("flow=0 -0.75");
  }

  if (hasContradictoryShallowInternals(st)) {
    score -= 1.5;
    reasons.push("contradictory internals -1.5");
  }

  return { score, reasons, flowSupport };
}

function classifyBreakoutGrade(st, score, flowSupport) {
  const bullAligned =
    st.ema8 != null &&
    st.ema18 != null &&
    st.ema50 != null &&
    st.ema8 > st.ema18 &&
    st.ema18 > st.ema50;

  const aGrade =
    st.regime === "trend" &&
    bullAligned &&
    (st.adx || 0) >= BREAKOUT_A_GRADE_ADX_MIN &&
    flowSupport === 3 &&
    score >= 9;

  if (aGrade) return "A";
  if (flowSupport >= 2) return "B";
  return "C";
}

// --------------------------------------------------
// Setup detection
// --------------------------------------------------
function detectBreakoutSetup(st) {
  if (st.regime !== "trend") return null;
  if (
    st.close == null ||
    st.ema8 == null ||
    st.ema18 == null ||
    st.ema50 == null
  ) {
    return null;
  }

  const bullAligned = st.ema8 > st.ema18 && st.ema18 > st.ema50;
  if (!bullAligned) return null;
  if ((st.adx || 0) < BREAKOUT_MIN_ADX) return null;

  const recent = st.closeHist.slice(-10);
  const swingHigh = recent.length ? Math.max(...recent) : st.close;
  const breakout = st.close >= swingHigh * 0.999;

  dlog(`🔎 BRKCHK swingHigh=${fmt(swingHigh)} breakout=${breakout ? 1 : 0}`);
  if (!breakout) return null;

  const scored = scoreBreakout(st);
  if (scored.score < BREAKOUT_MIN_SCORE) return null;

  const grade = classifyBreakoutGrade(st, scored.score, scored.flowSupport);

  const allowFlow2Plus = scored.flowSupport >= BREAKOUT_MIN_FLOW_SUPPORT;
  const allowExceptionalFlow1 =
    BREAKOUT_ALLOW_SCORE9_FLOW1 &&
    scored.flowSupport === 1 &&
    scored.score >= 9;

  if (!allowFlow2Plus && !allowExceptionalFlow1) {
    dlog(
      `🚫 breakout rejected | flowSupport=${scored.flowSupport} score=${scored.score}`
    );
    return null;
  }

  return {
    type: "breakout_pullback",
    phase: "breakout_triggered",
    level: st.ema8,
    triggerPrice: st.close,
    retestPrice: null,
    bouncePrice: null,
    invalidation: st.ema18 * 0.997,
    score: scored.score,
    reasons: [...scored.reasons, `grade=${grade}`, `flow=${scored.flowSupport}`],
    grade,
    flowSupport: scored.flowSupport,
  };
}

function detectWashoutSetup(st) {
  if (
    st.close == null ||
    st.ema18 == null ||
    st.ema50 == null ||
    st.rsi == null
  ) {
    return null;
  }

  const recent = st.closeHist.slice(-12);
  const localLow = recent.length ? Math.min(...recent) : st.close;
  const washout = localLow < st.ema50 * 0.995;
  const reclaimed = st.close > st.ema18;
  const prev1 = getPrevClose(st);
  const rsiUp = prev1 != null ? st.close > prev1 : false;

  dlog(
    `🔎 SETUPCHK localLow=${fmt(localLow)} ema50=${fmt(st.ema50)} washout=${washout ? 1 : 0} reclaimed=${reclaimed ? 1 : 0} rsiUp=${rsiUp ? 1 : 0}`
  );

  if (!washout || !reclaimed || !rsiUp) return null;

  const scored = scoreWashout(st);
  if (scored.score < WASHOUT_MIN_SCORE) return null;

  return {
    type: "washout_reclaim",
    phase: "washout_reclaim",
    level: st.ema18,
    triggerPrice: st.close,
    retestPrice: null,
    bouncePrice: st.close,
    invalidation: localLow * 0.999,
    score: scored.score,
    reasons: [...scored.reasons, `flow=${scored.flowSupport}`],
    grade: "W",
    flowSupport: scored.flowSupport,
  };
}

function detectRecoverySetup(st) {
  if (
    st.close == null ||
    st.ema8 == null ||
    st.ema18 == null ||
    st.ema50 == null ||
    st.rsi == null ||
    st.adx == null ||
    st.atrPct == null
  ) {
    return null;
  }

  if (!(st.regime === "range" || isEarlyTrendRecovery(st))) return null;

  const recent = st.closeHist.slice(-12);
  const localLow = recent.length ? Math.min(...recent) : st.close;
  const washout = localLow < st.ema50 * 0.995;
  const reclaimed = st.close > st.ema18;
  const prev1 = getPrevClose(st);
  const rsiUp = prev1 != null ? st.close > prev1 : false;

  if (!washout || !reclaimed || !rsiUp) return null;
  if ((st.rsi || 0) < RECOVERY_RSI_MIN) return null;
  if ((st.adx || 0) > RECOVERY_ADX_MAX) return null;
  if ((st.atrPct || 0) < RECOVERY_ATRPCT_MIN) return null;

  if (RECOVERY_REQUIRE_OI_NON_NEGATIVE) {
    if (st.oiTrend < 0 || st.oiDeltaBias < 0) return null;
  }
  if (RECOVERY_REQUIRE_CVD_NON_NEGATIVE) {
    if (st.cvdTrend < 0) return null;
  }

  const nearEma8Pct = Math.abs(pctChange(st.close, st.ema8));
  const nearEma18Pct = Math.abs(pctChange(st.close, st.ema18));

  if (nearEma8Pct > RECOVERY_MAX_NEAR_EMA8_PCT) return null;
  if (nearEma18Pct > RECOVERY_MAX_NEAR_EMA18_PCT) return null;

  const scored = scoreRecovery(st);
  if (scored.score < RECOVERY_MIN_SCORE) return null;

  return {
    type: "recovery_reclaim",
    phase: "recovery_reclaim",
    level: st.ema8,
    triggerPrice: st.close,
    retestPrice: null,
    bouncePrice: st.close,
    invalidation: Math.min(localLow * 0.999, st.ema18 * 0.997),
    score: scored.score,
    reasons: [...scored.reasons, `flow=${scored.flowSupport}`],
    grade: "R",
    flowSupport: scored.flowSupport,
  };
}

function detectShallowRecoverySetup(st) {
  if (!SHALLOW_RECOVERY_ENABLE) return null;

  if (
    st.close == null ||
    st.ema8 == null ||
    st.ema18 == null ||
    st.ema50 == null ||
    st.rsi == null ||
    st.adx == null ||
    st.atrPct == null
  ) {
    return null;
  }

  if (!(st.regime === "range" || isEarlyTrendRecovery(st))) return null;

  const prev1 = getPrevClose(st);
  const upTick = prev1 != null ? st.close > prev1 : false;
  const reclaimedEma18 = st.close > st.ema18;
  const reclaimedEma8 = st.close > st.ema8;

  if (SHALLOW_RECOVERY_REQUIRE_UPTICK && !upTick) return null;
  if (SHALLOW_RECOVERY_REQUIRE_RECLAIM_EMA18 && !reclaimedEma18) return null;
  if (!reclaimedEma18 && !reclaimedEma8) return null;

  if ((st.rsi || 0) < SHALLOW_RECOVERY_RSI_MIN) return null;
  if ((st.adx || 0) > SHALLOW_RECOVERY_ADX_MAX) return null;
  if ((st.atrPct || 0) < SHALLOW_RECOVERY_ATRPCT_MIN) return null;

  if (SHALLOW_RECOVERY_REQUIRE_OI_NON_NEGATIVE) {
    if (st.oiTrend < 0 || st.oiDeltaBias < 0) return null;
  }
  if (SHALLOW_RECOVERY_REQUIRE_CVD_NON_NEGATIVE) {
    if (st.cvdTrend < 0) return null;
  }

  if (hasContradictoryShallowInternals(st)) {
    dlog(
      `🚫 shallow recovery rejected | contradictory internals oiD=${st.oiDeltaBias} cvd=${st.cvdTrend}`
    );
    return null;
  }

  const nearEma8Pct = Math.abs(pctChange(st.close, st.ema8));
  const nearEma18Pct = Math.abs(pctChange(st.close, st.ema18));

  if (nearEma8Pct > SHALLOW_RECOVERY_MAX_NEAR_EMA8_PCT) return null;
  if (nearEma18Pct > SHALLOW_RECOVERY_MAX_NEAR_EMA18_PCT) return null;

  const recent = st.closeHist.slice(-12);
  const localLow = recent.length ? Math.min(...recent) : st.close;

  const scored = scoreShallowRecovery(st);
  if (scored.score < SHALLOW_RECOVERY_MIN_SCORE) return null;

  if (!shallowRecoveryQualityPass(st, scored.score, scored.flowSupport)) {
    dlog(
      `🚫 shallow recovery rejected | score=${fmt(scored.score, 2)} flow=${scored.flowSupport} oiD=${st.oiDeltaBias} cvd=${st.cvdTrend}`
    );
    return null;
  }

  return {
    type: "shallow_recovery_reclaim",
    phase: "shallow_recovery_reclaim",
    level: st.ema8,
    triggerPrice: st.close,
    retestPrice: null,
    bouncePrice: st.close,
    invalidation: Math.min(st.ema18 * 0.9965, localLow * 0.9985),
    score: scored.score,
    reasons: [...scored.reasons, `flow=${scored.flowSupport}`],
    grade: "SR",
    flowSupport: scored.flowSupport,
  };
}

function maybeArmSetup(st) {
  if (st.inPosition || inCooldown(st)) return;

  if (st.barsSeen < MIN_BARS_FOR_SETUPS) {
    dlog(`⏳ detectSetups waiting bars=${st.barsSeen}/${MIN_BARS_FOR_SETUPS}`);
    return;
  }

  const wash = detectWashoutSetup(st);
  if (wash) {
    st.armed = true;
    st.setupType = wash.type;
    st.setupPhase = wash.phase;
    st.setupTs = nowMs();
    st.setupScore = wash.score;
    st.setupReasons = wash.reasons;
    st.setupGrade = wash.grade;
    st.flowSupport = wash.flowSupport;
    st.level = wash.level;
    st.triggerPrice = wash.triggerPrice;
    st.retestPrice = wash.retestPrice;
    st.bouncePrice = wash.bouncePrice;
    st.invalidation = wash.invalidation;
    st.failConfirmCount = 0;
    st.failConfirmNoReclaimCount = 0;
    dlog(
      `🟡 Armed washout_reclaim inv=${fmt(st.invalidation)} score=${st.setupScore} flow=${st.flowSupport}`
    );
    return;
  }

  const recovery = detectRecoverySetup(st);
  if (recovery) {
    st.armed = true;
    st.setupType = recovery.type;
    st.setupPhase = recovery.phase;
    st.setupTs = nowMs();
    st.setupScore = recovery.score;
    st.setupReasons = recovery.reasons;
    st.setupGrade = recovery.grade;
    st.flowSupport = recovery.flowSupport;
    st.level = recovery.level;
    st.triggerPrice = recovery.triggerPrice;
    st.retestPrice = recovery.retestPrice;
    st.bouncePrice = recovery.bouncePrice;
    st.invalidation = recovery.invalidation;
    st.failConfirmCount = 0;
    st.failConfirmNoReclaimCount = 0;
    dlog(
      `🟢 Armed recovery_reclaim trigger=${fmt(st.triggerPrice)} level=${fmt(st.level)} inv=${fmt(
        st.invalidation
      )} score=${st.setupScore} flow=${st.flowSupport}`
    );
    return;
  }

  const shallowRecovery = detectShallowRecoverySetup(st);
  if (shallowRecovery) {
    st.armed = true;
    st.setupType = shallowRecovery.type;
    st.setupPhase = shallowRecovery.phase;
    st.setupTs = nowMs();
    st.setupScore = shallowRecovery.score;
    st.setupReasons = shallowRecovery.reasons;
    st.setupGrade = shallowRecovery.grade;
    st.flowSupport = shallowRecovery.flowSupport;
    st.level = shallowRecovery.level;
    st.triggerPrice = shallowRecovery.triggerPrice;
    st.retestPrice = shallowRecovery.retestPrice;
    st.bouncePrice = shallowRecovery.bouncePrice;
    st.invalidation = shallowRecovery.invalidation;
    st.failConfirmCount = 0;
    st.failConfirmNoReclaimCount = 0;
    dlog(
      `🟩 Armed shallow_recovery_reclaim trigger=${fmt(st.triggerPrice)} level=${fmt(
        st.level
      )} inv=${fmt(st.invalidation)} score=${st.setupScore} flow=${st.flowSupport}`
    );
    return;
  }

  const brk = detectBreakoutSetup(st);
  if (brk) {
    st.armed = true;
    st.setupType = brk.type;
    st.setupPhase = brk.phase;
    st.setupTs = nowMs();
    st.setupScore = brk.score;
    st.setupReasons = brk.reasons;
    st.setupGrade = brk.grade;
    st.flowSupport = brk.flowSupport;
    st.level = brk.level;
    st.triggerPrice = brk.triggerPrice;
    st.retestPrice = brk.retestPrice;
    st.bouncePrice = brk.bouncePrice;
    st.invalidation = brk.invalidation;
    st.failConfirmCount = 0;
    st.failConfirmNoReclaimCount = 0;
    dlog(
      `🟦 Armed breakout_pullback trigger=${fmt(st.triggerPrice)} level=${fmt(st.level)} inv=${fmt(
        st.invalidation
      )} score=${st.setupScore} grade=${st.setupGrade} flow=${st.flowSupport}`
    );
    return;
  }

  dlog(
    `📌 STATE ${st.symbol} reg=${st.regime} armed=0 type= setupAgeMin=0 score=0 inPos=${st.inPosition ? 1 : 0} cooldown=${inCooldown(st) ? 1 : 0} rayFresh=${st.rayFresh} fwoFresh=${st.fwoFresh}`
  );
}

function manageSetupLifecycle(st) {
  if (!st.armed) return;

  const sAgeMin = ageMin(st.setupTs);

  if (ageSec(st.setupTs) > SETUP_TTL_SEC) {
    clearSetup(st, "setup_ttl");
    return;
  }

  if (st.setupType === "washout_reclaim" && sAgeMin > WASHOUT_MAX_AGE_MIN) {
    clearSetup(st, "washout_stale");
    return;
  }

  if (
    (st.setupType === "recovery_reclaim" ||
      st.setupType === "shallow_recovery_reclaim") &&
    sAgeMin > RECOVERY_MAX_AGE_MIN
  ) {
    clearSetup(st, "recovery_stale");
    return;
  }

  if (
    st.setupType === "recovery_reclaim" ||
    st.setupType === "shallow_recovery_reclaim"
  ) {
    if (st.invalidation != null && st.close != null && st.close <= st.invalidation) {
      clearSetup(st, "recovery_invalidated");
      return;
    }
  }

  if (st.setupType === "breakout_pullback") {
    if (sAgeMin > BREAKOUT_MAX_AGE_MIN) {
      clearSetup(st, "breakout_stale");
      return;
    }

    if (st.setupPhase === "breakout_triggered") {
      const pullbackHappened =
        st.close != null &&
        st.triggerPrice != null &&
        st.close <= st.triggerPrice * 0.9995;

      if (pullbackHappened) {
        st.setupPhase = "breakout_retest";
        st.retestPrice = st.close;
        dlog(`🔁 breakout retest price=${fmt(st.retestPrice)}`);
      }
    }

    if (st.setupPhase === "breakout_retest") {
      const retestAgeMin = ageMin(st.setupTs);
      if (retestAgeMin > BREAKOUT_RETEST_MAX_MIN) {
        dlog(
          `⌛ Breakout retest stale retestAgeMin=${fmt(retestAgeMin, 1)} > ${BREAKOUT_RETEST_MAX_MIN}`
        );
        clearSetup(st, "breakout_retest_stale");
        return;
      }
    }

    if (st.invalidation != null && st.close != null && st.close <= st.invalidation) {
      clearSetup(st, "breakout_invalidated");
      return;
    }

    if (
      sAgeMin > BREAKOUT_RETEST_MAX_MIN &&
      st.setupScore < BREAKOUT_STALE_MIN_SCORE
    ) {
      clearSetup(st, "breakout_score_stale");
      return;
    }

    if (Number.isFinite(st.level) && Number.isFinite(st.close)) {
      const nearLevelPct = Math.abs(pctChange(st.close, st.level));
      const bounceBase = st.retestPrice ?? st.triggerPrice ?? st.close;
      const bouncePct = pctChange(st.close, bounceBase);

      if (
        sAgeMin > BREAKOUT_STALE_CLEAR_AGE_MIN &&
        nearLevelPct > BREAKOUT_STALE_CLEAR_NEAR_LEVEL_PCT
      ) {
        clearSetup(st, "breakout_old_and_extended");
        return;
      }

      if (
        sAgeMin > BREAKOUT_WEAK_PROGRESS_CLEAR_AGE_MIN &&
        bouncePct < BREAKOUT_WEAK_PROGRESS_MIN_BOUNCE_PCT
      ) {
        clearSetup(st, "breakout_weak_progress_timeout");
        return;
      }
    }
  }
}

// --------------------------------------------------
// Entry logic
// --------------------------------------------------
function canEnter(st) {
  if (st.inPosition) return { ok: false, note: "already in position" };
  if (!st.armed) return { ok: false, note: "no setup" };
  if (inCooldown(st)) return { ok: false, note: "cooldown" };
  if (!isFreshTick(st)) return { ok: false, note: "tick stale" };
  if (!isFreshHeartbeat(st)) return { ok: false, note: "heartbeat stale" };
  if (shouldDedupeEnter(st)) return { ok: false, note: "enter dedupe" };
  return { ok: true, note: "ok" };
}

function getBreakoutBounceNeed(st) {
  return st.flowSupport >= 3 || st.setupGrade === "A"
    ? BREAKOUT_CONFIRM_BOUNCE_PCT_STRONG
    : BREAKOUT_CONFIRM_BOUNCE_PCT_WEAK;
}

function getBreakoutNearLevelMax(st) {
  return st.flowSupport >= 3 || st.setupGrade === "A"
    ? BREAKOUT_NEAR_LEVEL_MAX_PCT_STRONG
    : BREAKOUT_NEAR_LEVEL_MAX_PCT_WEAK;
}

function getBreakoutMaxChase(st) {
  return st.flowSupport >= 3 || st.setupGrade === "A"
    ? MAX_CHASE_PCT_BREAKOUT_STRONG
    : MAX_CHASE_PCT_BREAKOUT_WEAK;
}

function breakoutEntryDecision(st, price) {
  if (st.setupType !== "breakout_pullback") {
    return { ok: false, note: "not breakout" };
  }
  if (st.level == null || st.ema8 == null) {
    return { ok: false, note: "missing level" };
  }

  const sAgeMin = ageMin(st.setupTs);
  const nearLevelPct = Math.abs(pctChange(price, st.level));
  const nearEma8Pct = Math.abs(pctChange(price, st.ema8));
  const bounceBase = st.retestPrice ?? st.triggerPrice ?? price;
  const bouncePct = pctChange(price, bounceBase);
  const aboveLevel = price > st.level ? 1 : 0;
  const aboveEma8 = price > st.ema8 ? 1 : 0;

  const maxDist = getBreakoutNearLevelMax(st);
  const needBounce = getBreakoutBounceNeed(st);
  const maxChase = getBreakoutMaxChase(st);

  dlog(
    `🎯 breakout entry check ageMin=${fmt(sAgeMin, 1)} nearLevelPct=${fmt(
      nearLevelPct,
      3
    )} nearEma8Pct=${fmt(nearEma8Pct, 3)} maxDist=${fmt(maxDist, 2)} score=${st.setupScore} grade=${st.setupGrade} flow=${st.flowSupport}`
  );
  dlog(
    `🎯 breakout confirm bouncePct=${fmt(
      bouncePct,
      3
    )} need=${fmt(needBounce, 3)} aboveLevel=${aboveLevel} aboveEma8=${aboveEma8}`
  );

  if (
    sAgeMin > BREAKOUT_HARD_LATE_ENTRY_MIN &&
    nearLevelPct > BREAKOUT_HARD_LATE_NEAR_LEVEL_PCT
  ) {
    st.failConfirmCount += 1;
    clearSetup(st, "breakout_hard_late_extended");
    return { ok: false, note: "breakout_hard_late_extended" };
  }

  if (st.setupGrade === "B") {
    if (nearLevelPct > BREAKOUT_B_MAX_NEAR_LEVEL_PCT) {
      st.failConfirmCount += 1;
      dlog(
        `🚫 breakout blocked | grade=B reason=too_extended nearLevelPct=${fmt(
          nearLevelPct,
          3
        )} max=${fmt(BREAKOUT_B_MAX_NEAR_LEVEL_PCT, 3)}`
      );
      return { ok: false, note: "breakout_B_too_extended" };
    }

    if (
      sAgeMin > BREAKOUT_B_LATE_ENTRY_MIN &&
      nearLevelPct > BREAKOUT_B_LATE_NEAR_LEVEL_PCT
    ) {
      st.failConfirmCount += 1;
      clearSetup(st, "breakout_B_late_extended");
      return { ok: false, note: "breakout_B_late_extended" };
    }
  }

  if (nearLevelPct > maxDist && nearEma8Pct > BREAKOUT_NEAR_EMA8_MAX_PCT) {
    st.failConfirmCount += 1;
    return { ok: false, note: "too far from breakout level" };
  }

  if (sAgeMin > BREAKOUT_LATE_AGE_MIN) {
    if (st.flowSupport < 2) {
      st.failConfirmCount += 1;
      return { ok: false, note: "late breakout weak flow" };
    }
    if (nearLevelPct > 0.25 && !(st.setupScore >= 9 && st.flowSupport >= 2)) {
      st.failConfirmCount += 1;
      return { ok: false, note: "late breakout too extended" };
    }
  }

  const premiumConfirmPass =
    BREAKOUT_PREMIUM_CONFIRM_ENABLE &&
    st.setupGrade === "A" &&
    st.flowSupport === 3 &&
    st.setupScore >= BREAKOUT_PREMIUM_MIN_SCORE &&
    aboveLevel &&
    aboveEma8 &&
    nearLevelPct <= BREAKOUT_PREMIUM_MAX_NEAR_LEVEL_PCT &&
    bouncePct >= BREAKOUT_PREMIUM_MIN_BOUNCE_PCT;

  if (!(aboveLevel && aboveEma8 && bouncePct >= needBounce) && !premiumConfirmPass) {
    st.failConfirmCount += 1;
    if (!aboveLevel && !aboveEma8) {
      st.failConfirmNoReclaimCount += 1;
    }

    dlog(
      `🚫 breakout blocked | grade=${st.setupGrade} flow=${st.flowSupport} ageMin=${fmt(
        sAgeMin,
        1
      )} aboveLevel=${aboveLevel} aboveEma8=${aboveEma8} bouncePct=${fmt(
        bouncePct,
        3
      )} need=${fmt(needBounce, 3)} nearLevelPct=${fmt(
        nearLevelPct,
        3
      )} failCount=${st.failConfirmCount} noReclaimCount=${st.failConfirmNoReclaimCount}`
    );

    if (
      st.setupGrade === "B" &&
      sAgeMin >= BREAKOUT_B_FAIL_RESET_MIN &&
      bouncePct < BREAKOUT_B_FAIL_RESET_MAX_BOUNCE_PCT
    ) {
      clearSetup(st, "breakout_B_weak_bounce_timeout");
      return { ok: false, note: "breakout_B_weak_bounce_timeout" };
    }

    if (
      st.setupGrade === "B" &&
      st.failConfirmNoReclaimCount >= BREAKOUT_FAIL_CONFIRM_NO_RECLAIM_MAX
    ) {
      clearSetup(st, "breakout_B_no_reclaim_repeat_fail");
      return { ok: false, note: "breakout_B_no_reclaim_repeat_fail" };
    }

    if (st.failConfirmCount >= BREAKOUT_FAIL_CONFIRM_MAX) {
      clearSetup(st, "breakout_repeat_fail");
      return { ok: false, note: "breakout_repeat_fail" };
    }

    return { ok: false, note: "no breakout confirm" };
  }

  const chasePct = Math.abs(pctChange(price, st.level));
  if (chasePct > maxChase) {
    st.failConfirmCount += 1;
    return { ok: false, note: "breakout chase too far" };
  }

  st.setupPhase = "breakout_bounce_confirmed";
  st.bouncePrice = price;
  st.failConfirmCount = 0;
  st.failConfirmNoReclaimCount = 0;
  return {
    ok: true,
    note: premiumConfirmPass ? "breakout premium confirm" : "breakout confirmed",
  };
}

function washoutEntryDecision(st, price) {
  if (st.setupType !== "washout_reclaim") {
    return { ok: false, note: "not washout" };
  }
  if (st.level == null) {
    return { ok: false, note: "missing level" };
  }

  const aboveLevel = price >= st.level ? 1 : 0;
  const chasePct = Math.abs(pctChange(price, st.level));

  dlog(
    `🎯 washout entry check ageMin=${fmt(ageMin(st.setupTs), 1)} price=${fmt(
      price
    )} level=${fmt(st.level)} aboveLevel=${aboveLevel} chasePct=${fmt(
      chasePct,
      3
    )}% score=${st.setupScore} flow=${st.flowSupport}`
  );

  if (!aboveLevel) return { ok: false, note: "washout below level" };
  if (chasePct > MAX_CHASE_PCT_WASHOUT) return { ok: false, note: "washout chase too far" };
  if (st.setupScore < WASHOUT_MIN_SCORE) return { ok: false, note: "washout score low" };

  return { ok: true, note: "washout confirmed" };
}

function recoveryEntryDecision(st, price) {
  if (
    st.setupType !== "recovery_reclaim" &&
    st.setupType !== "shallow_recovery_reclaim"
  ) {
    return { ok: false, note: "not recovery" };
  }
  if (st.level == null || st.ema8 == null || st.ema18 == null) {
    return { ok: false, note: "missing recovery level" };
  }

  const isShallow = st.setupType === "shallow_recovery_reclaim";

  const sAgeMin = ageMin(st.setupTs);
  const nearEma8Pct = Math.abs(pctChange(price, st.ema8));
  const nearEma18Pct = Math.abs(pctChange(price, st.ema18));
  const bounceBase = st.bouncePrice ?? st.triggerPrice ?? price;
  const bouncePct = pctChange(price, bounceBase);
  const aboveEma8 = price >= st.ema8 ? 1 : 0;
  const aboveEma18 = price >= st.ema18 ? 1 : 0;

  dlog(
    `🎯 recovery entry check type=${st.setupType} ageMin=${fmt(
      sAgeMin,
      1
    )} nearEma8Pct=${fmt(nearEma8Pct, 3)} nearEma18Pct=${fmt(
      nearEma18Pct,
      3
    )} bouncePct=${fmt(bouncePct, 3)} score=${st.setupScore} flow=${st.flowSupport}`
  );

  if (sAgeMin > RECOVERY_MAX_AGE_MIN) {
    clearSetup(st, "recovery_timeout");
    return { ok: false, note: "recovery_timeout" };
  }

  const maxNear8 = isShallow
    ? SHALLOW_RECOVERY_MAX_NEAR_EMA8_PCT
    : RECOVERY_MAX_NEAR_EMA8_PCT;
  const maxNear18 = isShallow
    ? SHALLOW_RECOVERY_MAX_NEAR_EMA18_PCT
    : RECOVERY_MAX_NEAR_EMA18_PCT;
  const minBounce = isShallow
    ? SHALLOW_RECOVERY_BOUNCE_MIN_PCT
    : RECOVERY_BOUNCE_MIN_PCT;

  if (nearEma8Pct > maxNear8) {
    return { ok: false, note: "recovery too far ema8" };
  }

  if (nearEma18Pct > maxNear18) {
    return { ok: false, note: "recovery too far ema18" };
  }

  if (isShallow) {
    const shallowMomentumPass =
      st.setupScore >= SHALLOW_RECOVERY_MOMENTUM_MIN_SCORE &&
      st.flowSupport >= SHALLOW_RECOVERY_MOMENTUM_MIN_FLOW &&
      (st.rsi || 0) >= SHALLOW_RECOVERY_MOMENTUM_RSI_MIN &&
      st.oiDeltaBias >= 0 &&
      st.cvdTrend >= 0 &&
      (st.regime === "trend" || isEarlyTrendRecovery(st)) &&
      price > st.ema8 &&
      price > st.ema18;

    if (shallowMomentumPass) {
      return { ok: true, note: "shallow recovery momentum entry" };
    }
  } else {
    if (
      st.setupScore >= 6 &&
      (st.rsi || 0) >= 55 &&
      price > st.ema8 &&
      price > st.ema18
    ) {
      return { ok: true, note: "recovery momentum entry" };
    }
  }

  if (!(aboveEma8 || aboveEma18)) {
    return { ok: false, note: "recovery not above reclaim level" };
  }

  if (bouncePct < minBounce) {
    return { ok: false, note: "recovery bounce too weak" };
  }

  return { ok: true, note: "recovery confirmed" };
}

// --------------------------------------------------
// Sizing
// --------------------------------------------------
function computeRiskVolumePct(st, entryPrice, stopPrice) {
  const stopDistPct = computeStopDistancePct(entryPrice, stopPrice);
  if (stopDistPct <= 0) {
    return {
      riskPct: BASE_RISK_PCT,
      riskUsd: ACCOUNT_EQUITY * (BASE_RISK_PCT / 100),
      stopDistPct,
      sizeMult: 0.5,
      volumePct: MIN_VOLUME_PCT,
      flowCap: MIN_VOLUME_PCT,
    };
  }

  let riskPct = BASE_RISK_PCT;
  if ((st.atrPct || 0) < 0.15) riskPct -= 0.05;
  if ((st.atrPct || 0) > 0.30) riskPct += 0.05;
  if (st.regime === "trend" && (st.adx || 0) > 22) riskPct += 0.05;
  riskPct = clamp(riskPct, MIN_RISK_PCT, MAX_RISK_PCT);

  let sizeMult = 1.0;

  if (st.setupType === "washout_reclaim") {
    if (st.setupScore >= 8) sizeMult = 1.10;
    else if (st.setupScore >= 7) sizeMult = 1.00;
    else if (st.setupScore >= 6) sizeMult = 0.85;
    else sizeMult = 0.70;
  } else if (st.setupType === "recovery_reclaim") {
    if (st.setupScore >= 8) sizeMult = 0.80;
    else if (st.setupScore >= 7) sizeMult = 0.70;
    else if (st.setupScore >= 6) sizeMult = 0.60;
    else sizeMult = 0.50;
  } else if (st.setupType === "shallow_recovery_reclaim") {
    if (st.setupScore >= 9 && st.flowSupport >= 2) sizeMult = 0.38;
    else if (st.setupScore >= 9 && st.flowSupport === 1) sizeMult = 0.28;
    else if (st.setupScore >= 8 && st.flowSupport >= 2) sizeMult = 0.30;
    else if (st.setupScore >= 7 && st.flowSupport >= 2) sizeMult = 0.24;
    else if (st.setupScore >= 6 && st.flowSupport >= 2) sizeMult = 0.18;
    else sizeMult = 0.12;
  } else if (st.setupType === "breakout_pullback") {
    if (st.flowSupport >= 3 && st.setupScore >= 9) sizeMult = 1.00;
    else if (st.flowSupport >= 2 && st.setupScore >= 8) sizeMult = 0.80;
    else if (st.flowSupport >= 2 && st.setupScore >= 7) sizeMult = 0.65;
    else if (st.flowSupport === 1 && st.setupScore >= 9) sizeMult = 0.45;
    else sizeMult = 0.35;

    const nearLevelNow =
      Number.isFinite(st.level) && Number.isFinite(entryPrice)
        ? Math.abs(pctChange(entryPrice, st.level))
        : 0;

    if (nearLevelNow > 0.25) sizeMult *= 0.85;
    if (ageMin(st.setupTs) > BREAKOUT_LATE_AGE_MIN) sizeMult *= 0.90;
    if (st.setupGrade === "B" && nearLevelNow > 0.14) sizeMult *= 0.80;
  }

  const riskUsd = ACCOUNT_EQUITY * (riskPct / 100) * sizeMult;
  const maxNotionalByRisk = riskUsd / (stopDistPct / 100);
  const cappedNotional = Math.min(maxNotionalByRisk, BOT_MAX_NOTIONAL_USDT);

  let volumePct = (cappedNotional / BOT_MAX_NOTIONAL_USDT) * 100;

  let flowCap = MAX_VOLUME_PCT;
  if (st.setupType === "breakout_pullback") {
    if (st.flowSupport <= 1) flowCap = BREAKOUT_VOLUME_CAP_FLOW1;
    else if (st.flowSupport === 2) flowCap = BREAKOUT_VOLUME_CAP_FLOW2;
    else flowCap = BREAKOUT_VOLUME_CAP_FLOW3;
  } else if (
    st.setupType === "recovery_reclaim" ||
    st.setupType === "shallow_recovery_reclaim"
  ) {
    flowCap = RECOVERY_VOLUME_CAP;
  }

  volumePct = clamp(volumePct, MIN_VOLUME_PCT, Math.min(MAX_VOLUME_PCT, flowCap));

  return {
    riskPct,
    riskUsd,
    stopDistPct,
    sizeMult,
    volumePct: Number(volumePct.toFixed(2)),
    flowCap,
  };
}

// --------------------------------------------------
// 3Commas Signal Bot
// --------------------------------------------------
async function send3CommasSignal(st, action, price, extra = {}) {
  const botUuid = SYMBOL_BOT_MAP[st.symbol];
  if (!botUuid) return { ok: false, err: "missing bot uuid" };
  if (!C3_SIGNAL_SECRET) return { ok: false, err: "missing 3c secret" };

  const stopPrice = st.invalidation || st.stopPrice || price * 0.995;
  const sizing = computeRiskVolumePct(st, price, stopPrice);

  const defaultComment =
    `${BRAIN_NAME}|${st.setupType || "na"}|score=${st.setupScore}|grade=${st.setupGrade || "na"}` +
    `|flow=${st.flowSupport}|reg=${st.regime}|riskPct=${fmt(sizing.riskPct, 2)}` +
    `|riskUsd=${fmt(sizing.riskUsd, 2)}|stopDist=${fmt(sizing.stopDistPct, 5)}` +
    `|volPct=${fmt(sizing.volumePct, 2)}|flowCap=${fmt(sizing.flowCap, 2)}` +
    `|oiT=${st.oiTrend}|oiD=${st.oiDeltaBias}|cvd=${st.cvdTrend}` +
    `|liq=${st.liqClusterBelow}|drop=${st.priceDropPct}|pA=${st.patternAReady}`;

  const payload = {
    secret: C3_SIGNAL_SECRET,
    bot_uuid: botUuid,
    max_lag: String(MAX_LAG_SEC),
    timestamp: new Date().toISOString(),
    trigger_price: String(price),
    tv_exchange: st.symbol.split(":")[0] || "BINANCE",
    tv_instrument: st.symbol.split(":")[1] || st.symbol,
    action,
    comment: extra.comment || defaultComment,
    ...(action === "enter_long"
      ? {
          order: {
            amount: String(sizing.volumePct),
            currency_type: "margin_percent",
            order_type: "market",
          },
        }
      : {}),
  };

  dlog(`📦 3C PAYLOAD ${JSON.stringify(payload)}`);

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), C3_TIMEOUT_MS);

    const res = await fetch(C3_SIGNAL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ac.signal,
    }).finally(() => clearTimeout(timer));

    const text = await res.text().catch(() => "");
    dlog(`📦 3C RESPONSE status=${res.status} body=${text}`);
    dlog(`📨 3Commas ${action} status=${res.status}`);
    return { ok: res.ok, status: res.status, body: text, payload };
  } catch (err) {
    dlog(`❌ 3Commas ${action} error=${err?.message || err}`);
    return { ok: false, err: err?.message || String(err) };
  }
}

// --------------------------------------------------
// Entry / exit
// --------------------------------------------------
async function tryEnterOnTick(st, price) {
  const gate = canEnter(st);
  if (!gate.ok) return { ok: false, note: gate.note };

  let decision = { ok: false, note: "unknown setup" };
  if (st.setupType === "breakout_pullback") {
    decision = breakoutEntryDecision(st, price);
  } else if (st.setupType === "washout_reclaim") {
    decision = washoutEntryDecision(st, price);
  } else if (
    st.setupType === "recovery_reclaim" ||
    st.setupType === "shallow_recovery_reclaim"
  ) {
    decision = recoveryEntryDecision(st, price);
  }

  if (!decision.ok) return decision;

  st.enterInFlight = true;
  try {
    const stopPrice = st.invalidation || st.stopPrice || price * 0.995;
    const sizing = computeRiskVolumePct(st, price, stopPrice);

    dlog(
      `📥 ENTER ${st.symbol} ${BRAIN_NAME}|${st.setupType}|score=${st.setupScore}|grade=${st.setupGrade}|flow=${st.flowSupport}|reg=${st.regime}|riskPct=${fmt(
        sizing.riskPct,
        2
      )}|riskUsd=${fmt(sizing.riskUsd, 1)}|stopDist=${fmt(
        sizing.stopDistPct,
        5
      )}|volPct=${fmt(sizing.volumePct, 2)}|flowCap=${fmt(
        sizing.flowCap,
        2
      )}|oiT=${st.oiTrend}|oiD=${st.oiDeltaBias}|cvd=${st.cvdTrend}|liq=${st.liqClusterBelow}|drop=${st.priceDropPct}|pA=${st.patternAReady} price=${price} sizeMult=${fmt(
        sizing.sizeMult,
        2
      )}|note=${decision.note}`
    );

    const sent = await send3CommasSignal(st, "enter_long", price);
    if (!sent.ok) return { ok: false, note: sent.err || "3c failed" };

    st.inPosition = true;
    st.entryPrice = price;
    st.entryTs = nowMs();
    st.peakPrice = price;
    st.stopPrice = stopPrice;
    st.trailingStop = stopPrice;
    st.lastEnterMs = nowMs();
    st.lastAction = "enter_long";

    clearSetup(st, "entered");
    return { ok: true, note: "entered" };
  } finally {
    st.enterInFlight = false;
  }
}

function updateTrailingStop(st, price) {
  if (!st.inPosition || !Number.isFinite(st.entryPrice)) return;
  if (!Number.isFinite(st.peakPrice) || price > st.peakPrice) st.peakPrice = price;

  const atrTrail =
    Number.isFinite(st.atr) && Number.isFinite(st.peakPrice)
      ? st.peakPrice - st.atr * TRAIL_ATR_MULT
      : st.stopPrice;

  const minPctTrail =
    Number.isFinite(st.peakPrice)
      ? st.peakPrice * (1 - TREND_MIN_TRAIL_PCT / 100)
      : st.stopPrice;

  const wideTrail = Math.min(atrTrail ?? Infinity, minPctTrail ?? Infinity);
  st.trailingStop = Math.max(st.stopPrice || -Infinity, wideTrail || -Infinity);
}

async function tryExitOnTick(st, price) {
  if (!st.inPosition) return { ok: false, note: "not in position" };
  if (shouldDedupeExit(st)) return { ok: false, note: "exit dedupe" };

  updateTrailingStop(st, price);

  const pnlPct = pctChange(price, st.entryPrice);
  const timeInMin = ageMin(st.entryTs);
  const belowTrail = Number.isFinite(st.trailingStop) && price <= st.trailingStop;
  const trendStopActive = timeInMin >= TREND_STOP_ACTIVATE_MIN;
  const weakProgress =
    timeInMin >= TREND_TIME_STOP_MIN && pnlPct < TREND_MIN_PROGRESS_PCT;

  let exitReason = "";
  if (belowTrail) exitReason = "trail_hit";
  else if (trendStopActive && st.close != null && st.ema18 != null && st.close < st.ema18)
    exitReason = "trend_lost";
  else if (weakProgress) exitReason = "time_stop";
  else if (st.raySignal === "bearish_trend_change" && st.rayFresh) exitReason = "ray_bear";

  if (!exitReason) return { ok: false, note: "hold" };

  st.exitInFlight = true;
  try {
    const sent = await send3CommasSignal(st, "exit_long", price, {
      comment: `${BRAIN_NAME}|exit|reason=${exitReason}`,
    });
    if (!sent.ok) return { ok: false, note: sent.err || "3c exit failed" };

    st.lastExitMs = nowMs();
    st.lastAction = "exit_long";
    st.cooldownUntilMs = nowMs() + COOLDOWN_SEC * 1000;
    resetPosition(st);
    clearSetup(st, "after_exit");

    dlog(`📤 EXIT ${st.symbol} reason=${exitReason} price=${fmt(price)} cooldownSec=${COOLDOWN_SEC}`);
    return { ok: true, note: exitReason };
  } finally {
    st.exitInFlight = false;
  }
}

// --------------------------------------------------
// Routes
// --------------------------------------------------
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    brain: BRAIN_NAME,
    symbols: ALLOW_SYMBOLS,
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, brain: BRAIN_NAME, ts: nowMs() });
});

app.get("/state", (req, res) => {
  const symbol = req.query.symbol;
  if (symbol && S[symbol]) return res.json({ ok: true, state: S[symbol] });
  return res.json({ ok: true, states: S });
});

app.get("/sync", async (_req, res) => {
  await syncAllPositions("manual_route");
  return res.json({ ok: true, ts: nowMs() });
});

app.post("/webhook", async (req, res) => {
  const body = req.body || {};
  const src = String(body.src || "").toLowerCase();

  if (src === "tick") {
    if (!verifySecret(req, true)) {
      return res.status(401).json({ ok: false, err: "bad tick secret" });
    }

    const symbol = body.symbol;
    const price = n(body.price);

    if (!symbol || !Number.isFinite(price)) {
      return res.status(400).json({ ok: false, err: "bad tick payload" });
    }

    if (!SYMBOL_BOT_MAP[symbol]) {
      return res.status(400).json({ ok: false, err: "symbol not mapped" });
    }

    const st = ensureState(symbol);
    st.lastPrice = price;
    st.lastTickMs = nowMs();
    st.tickCount++;

    if (nowMs() - st.lastTickLogMs >= TICK_LOG_EVERY_MS) {
      st.lastTickLogMs = nowMs();
      dlog(`🟦 TICK(3m) ${symbol} price=${price} time=${new Date(st.lastTickMs).toISOString()}`);
    }

    if (st.tickCount % 50 === 0) {
      dlog(`🟦 LIVE TICKS ${symbol} count=${st.tickCount} px=${price}`);
    }

    if (st.inPosition) {
      const ex = await tryExitOnTick(st, price);
      return res.json({ ok: true, path: "tick-exit", result: ex });
    }

    const en = await tryEnterOnTick(st, price);
    return res.json({ ok: true, path: "tick-entry", result: en });
  }

  if (!verifySecret(req, false)) {
    return res.status(401).json({ ok: false, err: "bad webhook secret" });
  }

  const symbol = body.symbol;
  if (!symbol) return res.status(400).json({ ok: false, err: "missing symbol" });
  if (!SYMBOL_BOT_MAP[symbol]) {
    return res.status(400).json({ ok: false, err: "symbol not mapped" });
  }

  const st = ensureState(symbol);

  dlog(`📩 WEBHOOK src=${src || "features"} signal=${body.signal || ""} symbol=${symbol}`);

  const hasFeaturePayload =
    body.close != null ||
    body.price != null ||
    body.ema8 != null ||
    body.ema18 != null ||
    body.ema50 != null ||
    body.rsi != null ||
    body.adx != null ||
    body.atr != null ||
    body.atrPct != null;

  st.tf = String(body.tf || st.tf || "3");

  if (hasFeaturePayload) {
    st.close = n(body.close ?? body.price);
    st.ema8 = n(body.ema8);
    st.ema18 = n(body.ema18);
    st.ema50 = n(body.ema50);
    st.rsi = n(body.rsi);
    st.adx = n(body.adx);
    st.atr = n(body.atr);
    st.atrPct = n(body.atrPct);

    st.heartbeat = n(body.heartbeat) || 0;
    if (st.heartbeat) st.lastHeartbeatMs = nowMs();

    st.oiTrend = n(body.oiTrend) || 0;
    st.oiDeltaBias = n(body.oiDeltaBias) || 0;
    st.cvdTrend = n(body.cvdTrend) || 0;
    st.liqClusterBelow = n(body.liqClusterBelow) || 0;
    st.priceDropPct = n(body.priceDropPct) || 0;
    st.patternAReady = n(body.patternAReady) || 0;
    st.patternAWatch = n(body.patternAWatch) || 0;

    st.barsSeen += 1;
    updateCloseHistory(st, st.close);
  }

  st.raySignal = String(body.raySignal || st.raySignal || "");
  st.fwoSignal = String(body.fwoSignal || st.fwoSignal || "");

  const rayBuy = n(body.rayBuy) || 0;
  const raySell = n(body.raySell) || 0;
  const fwo = n(body.fwo) || 0;

  if (src === "fwo_buy" || String(body.signal || "").toLowerCase().includes("buy")) {
    st.lastFwoBullMs = nowMs();
  }
  if (src === "fwo_sell" || String(body.signal || "").toLowerCase().includes("sell")) {
    st.lastFwoBearMs = nowMs();
  }

  if (rayBuy) st.lastRayBullMs = nowMs();
  if (raySell) st.lastRayBearMs = nowMs();
  if (fwo > 0) st.lastFwoBullMs = nowMs();
  if (fwo < 0) st.lastFwoBearMs = nowMs();

  computeSignalFreshness(st);

  dlog(
    `🟩 FEAT rx ${symbol} close=${st.close} ema8=${st.ema8} ema18=${st.ema18} ema50=${st.ema50} rsi=${st.rsi} atr=${st.atr} atrPct=${st.atrPct} adx=${st.adx} oiTrend=${st.oiTrend} oiDeltaBias=${st.oiDeltaBias} cvdTrend=${st.cvdTrend} liqClusterBelow=${st.liqClusterBelow} priceDropPct=${st.priceDropPct} patternAReady=${st.patternAReady} patternAWatch=${st.patternAWatch} rayFresh=${st.rayFresh} fwoFresh=${st.fwoFresh}`
  );

  const rg = computeRegime(st);
  st.regime = rg.mode;
  st.regimeConf = rg.conf;

  dlog(`🧭 REGIME ${symbol} mode=${st.regime} conf=${st.regimeConf}`);

  manageSetupLifecycle(st);

  if (!st.armed && !st.inPosition) {
    maybeArmSetup(st);
  } else {
    dlog(
      `📌 STATE ${symbol} reg=${st.regime} armed=${st.armed ? 1 : 0} type=${st.setupType} setupAgeMin=${st.armed ? fmt(ageMin(st.setupTs), 1) : 0} score=${st.setupScore} grade=${st.setupGrade || "na"} flow=${st.flowSupport} inPos=${st.inPosition ? 1 : 0} cooldown=${inCooldown(st) ? 1 : 0} rayFresh=${st.rayFresh} fwoFresh=${st.fwoFresh}`
    );
  }

  return res.json({
    ok: true,
    symbol,
    regime: st.regime,
    regimeConf: st.regimeConf,
    armed: st.armed,
    setupType: st.setupType,
    setupScore: st.setupScore,
    setupGrade: st.setupGrade,
    flowSupport: st.flowSupport,
    failConfirmCount: st.failConfirmCount,
    failConfirmNoReclaimCount: st.failConfirmNoReclaimCount,
    inPosition: st.inPosition,
    barsSeen: st.barsSeen,
    syncedSmartTradeId: st.syncedSmartTradeId,
  });
});

// legacy TV route
app.post("/tv", async (req, res) => {
  req.body = req.body || {};
  if (!req.body.src) req.body.src = "features";
  return app._router.handle(req, res, () => {});
});

// --------------------------------------------------
// Start
// --------------------------------------------------
app.listen(PORT, async () => {
  console.log(`✅ ${BRAIN_NAME} listening on :${PORT}`);
  console.log(`📚 MIN_BARS_FOR_SETUPS=${MIN_BARS_FOR_SETUPS}`);
  console.log(`🧭 SYMBOL_BOT_MAP keys=${ALLOW_SYMBOLS.length}`);
  console.log(`🐛 DEBUG=${DEBUG ? 1 : 0}`);
  console.log(`🧾 TICK_LOG_EVERY_MS=${TICK_LOG_EVERY_MS}`);
  console.log(`🕒 RAY_SIGNAL_TTL_MS=${RAY_SIGNAL_TTL_MS}`);
  console.log(`🕒 FWO_SIGNAL_TTL_MS=${FWO_SIGNAL_TTL_MS}`);
  console.log(`⏱️ BREAKOUT_MAX_AGE_MIN=${BREAKOUT_MAX_AGE_MIN}`);
  console.log(`⏱️ BREAKOUT_RETEST_MAX_MIN=${BREAKOUT_RETEST_MAX_MIN}`);
  console.log(`⏱️ WASHOUT_MAX_AGE_MIN=${WASHOUT_MAX_AGE_MIN}`);
  console.log(`⏱️ RECOVERY_MAX_AGE_MIN=${RECOVERY_MAX_AGE_MIN}`);
  console.log(`✅ BREAKOUT_CONFIRM_BOUNCE_PCT_STRONG=${BREAKOUT_CONFIRM_BOUNCE_PCT_STRONG}`);
  console.log(`✅ BREAKOUT_CONFIRM_BOUNCE_PCT_WEAK=${BREAKOUT_CONFIRM_BOUNCE_PCT_WEAK}`);
  console.log(`✅ BREAKOUT_MIN_FLOW_SUPPORT=${BREAKOUT_MIN_FLOW_SUPPORT}`);
  console.log(`✅ BREAKOUT_B_FAIL_RESET_MIN=${BREAKOUT_B_FAIL_RESET_MIN}`);
  console.log(`✅ BREAKOUT_B_FAIL_RESET_MAX_BOUNCE_PCT=${BREAKOUT_B_FAIL_RESET_MAX_BOUNCE_PCT}`);
  console.log(`✅ BREAKOUT_FAIL_CONFIRM_MAX=${BREAKOUT_FAIL_CONFIRM_MAX}`);
  console.log(`✅ BREAKOUT_FAIL_CONFIRM_NO_RECLAIM_MAX=${BREAKOUT_FAIL_CONFIRM_NO_RECLAIM_MAX}`);
  console.log(`✅ BREAKOUT_HARD_LATE_ENTRY_MIN=${BREAKOUT_HARD_LATE_ENTRY_MIN}`);
  console.log(`✅ BREAKOUT_HARD_LATE_NEAR_LEVEL_PCT=${BREAKOUT_HARD_LATE_NEAR_LEVEL_PCT}`);
  console.log(`✅ BREAKOUT_B_MAX_NEAR_LEVEL_PCT=${BREAKOUT_B_MAX_NEAR_LEVEL_PCT}`);
  console.log(`✅ BREAKOUT_B_LATE_ENTRY_MIN=${BREAKOUT_B_LATE_ENTRY_MIN}`);
  console.log(`✅ BREAKOUT_B_LATE_NEAR_LEVEL_PCT=${BREAKOUT_B_LATE_NEAR_LEVEL_PCT}`);
  console.log(`✅ RECOVERY_MIN_SCORE=${RECOVERY_MIN_SCORE}`);
  console.log(`✅ RECOVERY_MAX_NEAR_EMA8_PCT=${RECOVERY_MAX_NEAR_EMA8_PCT}`);
  console.log(`✅ RECOVERY_MAX_NEAR_EMA18_PCT=${RECOVERY_MAX_NEAR_EMA18_PCT}`);
  console.log(`✅ RECOVERY_BOUNCE_MIN_PCT=${RECOVERY_BOUNCE_MIN_PCT}`);
  console.log(`✅ RECOVERY_RSI_MIN=${RECOVERY_RSI_MIN}`);
  console.log(`✅ RECOVERY_ADX_MAX=${RECOVERY_ADX_MAX}`);
  console.log(`✅ RECOVERY_ATRPCT_MIN=${RECOVERY_ATRPCT_MIN}`);
  console.log(`✅ RECOVERY_EARLY_TREND_ADX_MAX=${RECOVERY_EARLY_TREND_ADX_MAX}`);
  console.log(`✅ SHALLOW_RECOVERY_ENABLE=${SHALLOW_RECOVERY_ENABLE ? 1 : 0}`);
  console.log(`✅ SHALLOW_RECOVERY_MIN_SCORE=${SHALLOW_RECOVERY_MIN_SCORE}`);
  console.log(`✅ SHALLOW_RECOVERY_RSI_MIN=${SHALLOW_RECOVERY_RSI_MIN}`);
  console.log(`✅ SHALLOW_RECOVERY_ADX_MAX=${SHALLOW_RECOVERY_ADX_MAX}`);
  console.log(`✅ SHALLOW_RECOVERY_ATRPCT_MIN=${SHALLOW_RECOVERY_ATRPCT_MIN}`);
  console.log(`✅ SHALLOW_RECOVERY_MAX_NEAR_EMA8_PCT=${SHALLOW_RECOVERY_MAX_NEAR_EMA8_PCT}`);
  console.log(`✅ SHALLOW_RECOVERY_MAX_NEAR_EMA18_PCT=${SHALLOW_RECOVERY_MAX_NEAR_EMA18_PCT}`);
  console.log(`✅ SHALLOW_RECOVERY_BOUNCE_MIN_PCT=${SHALLOW_RECOVERY_BOUNCE_MIN_PCT}`);
  console.log(`✅ SHALLOW_RECOVERY_MIN_FLOW_SUPPORT=${SHALLOW_RECOVERY_MIN_FLOW_SUPPORT}`);
  console.log(`✅ SHALLOW_RECOVERY_ALLOW_SCORE9_FLOW1=${SHALLOW_RECOVERY_ALLOW_SCORE9_FLOW1 ? 1 : 0}`);
  console.log(`✅ SHALLOW_RECOVERY_MOMENTUM_RSI_MIN=${SHALLOW_RECOVERY_MOMENTUM_RSI_MIN}`);
  console.log(`✅ SHALLOW_RECOVERY_MOMENTUM_MIN_SCORE=${SHALLOW_RECOVERY_MOMENTUM_MIN_SCORE}`);
  console.log(`✅ SHALLOW_RECOVERY_MOMENTUM_MIN_FLOW=${SHALLOW_RECOVERY_MOMENTUM_MIN_FLOW}`);
  console.log(`✅ BREAKOUT_PREMIUM_CONFIRM_ENABLE=${BREAKOUT_PREMIUM_CONFIRM_ENABLE ? 1 : 0}`);
  console.log(`✅ BREAKOUT_PREMIUM_MIN_SCORE=${BREAKOUT_PREMIUM_MIN_SCORE}`);
  console.log(`✅ BREAKOUT_PREMIUM_MAX_NEAR_LEVEL_PCT=${BREAKOUT_PREMIUM_MAX_NEAR_LEVEL_PCT}`);
  console.log(`✅ BREAKOUT_PREMIUM_MIN_BOUNCE_PCT=${BREAKOUT_PREMIUM_MIN_BOUNCE_PCT}`);
  console.log(`✅ C3_SYNC_ENABLE=${C3_SYNC_ENABLE ? 1 : 0}`);
  console.log(`✅ C3_SYNC_ON_STARTUP=${C3_SYNC_ON_STARTUP ? 1 : 0}`);
  console.log(`✅ C3_SYNC_INTERVAL_SEC=${C3_SYNC_INTERVAL_SEC}`);
  console.log(`✅ C3_SYNC_ONLY_IF_LOCAL_FLAT=${C3_SYNC_ONLY_IF_LOCAL_FLAT ? 1 : 0}`);
  console.log(`💰 BOT_MAX_NOTIONAL_USDT=${BOT_MAX_NOTIONAL_USDT}`);
  console.log(`🛡️ BASE_RISK_PCT=${BASE_RISK_PCT}`);
  console.log(`🛡️ MIN_RISK_PCT=${MIN_RISK_PCT}`);
  console.log(`🛡️ MAX_RISK_PCT=${MAX_RISK_PCT}`);
  console.log(`📉 TREND_MIN_TRAIL_PCT=${TREND_MIN_TRAIL_PCT}`);
  console.log(`⏳ TREND_TIME_STOP_MIN=${TREND_TIME_STOP_MIN}`);
  console.log(`📉 TREND_MIN_PROGRESS_PCT=${TREND_MIN_PROGRESS_PCT}`);

  if (C3_SYNC_ENABLE && C3_SYNC_ON_STARTUP) {
    await syncAllPositions("startup");
  }

  if (C3_SYNC_ENABLE && C3_SYNC_INTERVAL_SEC > 0) {
    setInterval(() => {
      syncAllPositions("interval").catch((err) =>
        dlog(`⚠️ POSITION SYNC interval err=${err?.message || err}`)
      );
    }, C3_SYNC_INTERVAL_SEC * 1000);
  }
});
