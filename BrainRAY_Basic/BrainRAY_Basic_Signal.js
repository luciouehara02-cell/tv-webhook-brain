/**
 * BrainRAY_Basic_Signal_v1.1c
 *
 * Basic RayAlgo TradingView signal bridge:
 * TradingView -> Railway /webhook -> 3Commas Signal Bot
 *
 * Entry:
 * - Bullish Trend Change       -> save bullish_bias only by default
 * - Bullish BOS                -> enter_long
 * - Bullish Trend Continuation -> enter_long only after recent bullish context
 *
 * Exit:
 * - Bearish Trend Change       -> exit_long if enabled
 * - Bearish BOS                -> exit_long if enabled
 * - Bearish Trend Continuation -> optional exit_long if enabled
 *
 * v1.1c:
 * - Same trading logic as v1.1h
 * - Color-coded horizontal logs like BrainRAY_Continuation
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

// --------------------------------------------------
// Helpers
// --------------------------------------------------
function strEnv(name, def = "") {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === "") return def;
  return String(v).trim();
}

function numEnv(name, def = 0) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : def;
}

function boolEnv(name, def = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return def;

  const v = String(raw).trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(v);
}

function nowMs() {
  return Date.now();
}

function isoNow() {
  return new Date().toISOString();
}

function safeNumber(v, def = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

function normalizeSignal(signal) {
  return String(signal || "").trim();
}

function normalizeSrc(src) {
  return String(src || "unknown").trim().toLowerCase();
}

function ageSec(tsMs) {
  if (!tsMs) return null;
  return Math.max(0, Math.round((nowMs() - tsMs) / 1000));
}

function withinTtl(tsMs, ttlMin) {
  if (!tsMs) return false;
  const ttlMs = ttlMin * 60 * 1000;
  return nowMs() - tsMs <= ttlMs;
}

function compactObject(value) {
  if (Array.isArray(value)) {
    return value.map(compactObject);
  }

  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = compactObject(v);
    }
    return out;
  }

  return value;
}

function oneLine(payload = {}) {
  try {
    return JSON.stringify(compactObject(payload));
  } catch (e) {
    return JSON.stringify({ logError: String(e?.message || e) });
  }
}

function warnEvent(tag, payload = {}) {
  console.warn(`${isoNow()} ${tag} | ${oneLine(payload)}`);
}

function errorEvent(tag, payload = {}) {
  console.error(`${isoNow()} ${tag} | ${oneLine(payload)}`);
}

function parseSymbolBotMap(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch (e) {
    errorEvent("❌ INVALID_SYMBOL_BOT_MAP", {
      error: String(e?.message || e),
      rawPresent: Boolean(raw),
    });
    return {};
  }
}

function responseOk(res, payload = {}) {
  return res.status(200).json({
    ok: true,
    brain: CONFIG.BRAIN_NAME,
    time: isoNow(),
    ...payload,
  });
}

function responseFail(res, status, payload = {}) {
  return res.status(status).json({
    ok: false,
    brain: CONFIG.BRAIN_NAME,
    time: isoNow(),
    ...payload,
  });
}

// --------------------------------------------------
// Config
// --------------------------------------------------
const CONFIG = {
  BRAIN_NAME: strEnv("BRAIN_NAME", "BrainRAY_Basic_Signal_v1.1c"),
  PORT: numEnv("PORT", 8080),
  DEBUG: boolEnv("DEBUG", true),
  WEBHOOK_PATH: strEnv("WEBHOOK_PATH", "/webhook"),

  WEBHOOK_SECRET: strEnv("WEBHOOK_SECRET", ""),

  SYMBOL: normalizeSymbol(strEnv("SYMBOL", "BINANCE:SOLUSDT")),
  SYMBOL_BOT_MAP: parseSymbolBotMap(strEnv("SYMBOL_BOT_MAP", "{}")),

  ENABLE_HTTP_FORWARD: boolEnv("ENABLE_HTTP_FORWARD", true),
  C3_SIGNAL_URL: strEnv("C3_SIGNAL_URL", "https://api.3commas.io/signal_bots/webhooks"),
  C3_SIGNAL_SECRET: strEnv("C3_SIGNAL_SECRET", ""),
  C3_TIMEOUT_MS: numEnv("C3_TIMEOUT_MS", 8000),
  MAX_LAG_SEC: numEnv("MAX_LAG_SEC", 300),

  BASIC_ALLOW_TREND_CHANGE_ENTRY: boolEnv("BASIC_ALLOW_TREND_CHANGE_ENTRY", false),
  ALLOW_TREND_CONTINUATION_ENTRY: boolEnv("ALLOW_TREND_CONTINUATION_ENTRY", true),

  BULLISH_BIAS_TTL_MIN: numEnv("BULLISH_BIAS_TTL_MIN", 30),
  BOS_BIAS_TTL_MIN: numEnv("BOS_BIAS_TTL_MIN", 30),

  ENTER_DEDUP_SEC: numEnv("ENTER_DEDUP_SEC", 25),
  ENTRY_COOLDOWN_SEC: numEnv("ENTRY_COOLDOWN_SEC", 180),

  LOCK_AFTER_ENTER: boolEnv("LOCK_AFTER_ENTER", true),

  EXIT_ON_BEARISH_TREND_CHANGE: boolEnv("EXIT_ON_BEARISH_TREND_CHANGE", true),
  EXIT_ON_BEARISH_BOS: boolEnv("EXIT_ON_BEARISH_BOS", true),
  EXIT_ON_BEARISH_TREND_CONTINUATION: boolEnv(
    "EXIT_ON_BEARISH_TREND_CONTINUATION",
    false
  ),

  EXIT_DEDUP_SEC: numEnv("EXIT_DEDUP_SEC", 20),
  EXIT_COOLDOWN_SEC: numEnv("EXIT_COOLDOWN_SEC", 60),

  REQUIRE_KNOWN_SIGNAL: boolEnv("REQUIRE_KNOWN_SIGNAL", true),
};

function logEvent(tag, payload = {}) {
  if (!CONFIG.DEBUG) return;
  console.log(`${isoNow()} ${tag} | ${oneLine(payload)}`);
}

// --------------------------------------------------
// State
// Railway state is runtime-only and resets on redeploy/restart.
// --------------------------------------------------
const state = {
  startedAt: isoNow(),

  lastPayload: null,

  position: {
    inLong: false,
    entryPrice: null,
    entrySignal: null,
    entryTime: null,
    entryTsMs: null,
    exitPrice: null,
    exitSignal: null,
    exitTime: null,
    exitTsMs: null,
  },

  bullishBias: {
    active: false,
    signal: null,
    price: null,
    time: null,
    tsMs: null,
  },

  bosBias: {
    active: false,
    signal: null,
    price: null,
    time: null,
    tsMs: null,
  },

  lastEnterLong: {
    tsMs: null,
    price: null,
    signal: null,
    reason: null,
  },

  lastExitLong: {
    tsMs: null,
    price: null,
    signal: null,
    reason: null,
  },

  counters: {
    received: 0,
    unauthorized: 0,
    wrongSymbol: 0,
    unknownSignal: 0,

    biasSaved: 0,
    biasCancelled: 0,

    enterAllowed: 0,
    enterBlocked: 0,
    exitAllowed: 0,
    exitBlocked: 0,

    forwardedOk: 0,
    forwardedFail: 0,
  },
};

// --------------------------------------------------
// Signals
// --------------------------------------------------
const SIGNALS = {
  BULLISH_TREND_CHANGE: "Bullish Trend Change",
  BULLISH_BOS: "Bullish BOS",
  BULLISH_TREND_CONTINUATION: "Bullish Trend Continuation",

  BEARISH_TREND_CHANGE: "Bearish Trend Change",
  BEARISH_BOS: "Bearish BOS",
  BEARISH_TREND_CONTINUATION: "Bearish Trend Continuation",
};

const KNOWN_SIGNALS = new Set(Object.values(SIGNALS));

function isBearishSignal(signal) {
  return (
    signal === SIGNALS.BEARISH_TREND_CHANGE ||
    signal === SIGNALS.BEARISH_BOS ||
    signal === SIGNALS.BEARISH_TREND_CONTINUATION
  );
}

function raySignalTag(signal) {
  if (signal === SIGNALS.BULLISH_TREND_CHANGE) return "🟩 RAY_BULLISH_TREND_CHANGE";
  if (signal === SIGNALS.BULLISH_BOS) return "🟩 RAY_BULLISH_BOS";
  if (signal === SIGNALS.BULLISH_TREND_CONTINUATION) return "🟩 RAY_BULLISH_TREND_CONTINUATION";

  if (signal === SIGNALS.BEARISH_TREND_CHANGE) return "🟥 RAY_BEARISH_TREND_CHANGE";
  if (signal === SIGNALS.BEARISH_BOS) return "🟥 RAY_BEARISH_BOS";
  if (signal === SIGNALS.BEARISH_TREND_CONTINUATION) return "🟥 RAY_BEARISH_TREND_CONTINUATION";

  return "⚪ RAY_UNKNOWN_SIGNAL";
}

// --------------------------------------------------
// Status helpers
// --------------------------------------------------
function hasRecentBullishBias() {
  return (
    state.bullishBias.active &&
    withinTtl(state.bullishBias.tsMs, CONFIG.BULLISH_BIAS_TTL_MIN)
  );
}

function hasRecentBosBias() {
  return (
    state.bosBias.active &&
    withinTtl(state.bosBias.tsMs, CONFIG.BOS_BIAS_TTL_MIN)
  );
}

function getBiasStatus() {
  return {
    bullishBiasActive: hasRecentBullishBias(),
    bullishBiasSignal: state.bullishBias.signal,
    bullishBiasPrice: state.bullishBias.price,
    bullishBiasAgeSec: ageSec(state.bullishBias.tsMs),

    bosBiasActive: hasRecentBosBias(),
    bosBiasSignal: state.bosBias.signal,
    bosBiasPrice: state.bosBias.price,
    bosBiasAgeSec: ageSec(state.bosBias.tsMs),
  };
}

function getPositionStatus() {
  return {
    inLong: state.position.inLong,
    entryPrice: state.position.entryPrice,
    entrySignal: state.position.entrySignal,
    entryTime: state.position.entryTime,
    entryAgeSec: ageSec(state.position.entryTsMs),
    exitPrice: state.position.exitPrice,
    exitSignal: state.position.exitSignal,
    exitTime: state.position.exitTime,
    exitAgeSec: ageSec(state.position.exitTsMs),
  };
}

function getCompactPosition() {
  return {
    inLong: state.position.inLong,
    entryPrice: state.position.entryPrice,
    entrySignal: state.position.entrySignal,
    entryAgeSec: ageSec(state.position.entryTsMs),
    exitPrice: state.position.exitPrice,
    exitSignal: state.position.exitSignal,
    exitAgeSec: ageSec(state.position.exitTsMs),
  };
}

function getCompactBias() {
  return {
    bullishBiasActive: hasRecentBullishBias(),
    bullishBiasSignal: state.bullishBias.signal,
    bullishBiasPrice: state.bullishBias.price,
    bullishBiasAgeSec: ageSec(state.bullishBias.tsMs),
    bosBiasActive: hasRecentBosBias(),
    bosBiasSignal: state.bosBias.signal,
    bosBiasPrice: state.bosBias.price,
    bosBiasAgeSec: ageSec(state.bosBias.tsMs),
  };
}

// --------------------------------------------------
// Bias state
// --------------------------------------------------
function saveBullishBias({ signal, price, time }) {
  state.bullishBias = {
    active: true,
    signal,
    price,
    time,
    tsMs: nowMs(),
  };

  state.counters.biasSaved += 1;

  logEvent("🟢 BIAS_SAVED", {
    signal,
    price,
    ts: time,
    ttlMin: CONFIG.BULLISH_BIAS_TTL_MIN,
    bias: getCompactBias(),
  });
}

function saveBosBias({ signal, price, time }) {
  state.bosBias = {
    active: true,
    signal,
    price,
    time,
    tsMs: nowMs(),
  };

  logEvent("🟢 BOS_BIAS_SAVED", {
    signal,
    price,
    ts: time,
    ttlMin: CONFIG.BOS_BIAS_TTL_MIN,
    bias: getCompactBias(),
  });
}

function cancelBullishBias(reason, payload = {}) {
  const hadBias = state.bullishBias.active || state.bosBias.active;

  state.bullishBias = {
    active: false,
    signal: null,
    price: null,
    time: null,
    tsMs: null,
  };

  state.bosBias = {
    active: false,
    signal: null,
    price: null,
    time: null,
    tsMs: null,
  };

  if (hadBias) {
    state.counters.biasCancelled += 1;
  }

  logEvent("🔴 BIAS_CANCELLED", {
    reason,
    hadBias,
    ...payload,
    bias: getCompactBias(),
  });
}

// --------------------------------------------------
// Position state
// --------------------------------------------------
function markEnterLong({ signal, price, time, reason }) {
  state.lastEnterLong = {
    tsMs: nowMs(),
    price,
    signal,
    reason,
  };

  state.position.inLong = true;
  state.position.entryPrice = price;
  state.position.entrySignal = signal;
  state.position.entryTime = time || isoNow();
  state.position.entryTsMs = nowMs();
}

function markExitLong({ signal, price, time, reason }) {
  state.lastExitLong = {
    tsMs: nowMs(),
    price,
    signal,
    reason,
  };

  state.position.inLong = false;
  state.position.exitPrice = price;
  state.position.exitSignal = signal;
  state.position.exitTime = time || isoNow();
  state.position.exitTsMs = nowMs();
}

// --------------------------------------------------
// Entry / exit protection
// --------------------------------------------------
function isEnterDedupBlocked(signal) {
  if (!state.lastEnterLong.tsMs) return false;
  const diffSec = (nowMs() - state.lastEnterLong.tsMs) / 1000;
  return diffSec < CONFIG.ENTER_DEDUP_SEC && state.lastEnterLong.signal === signal;
}

function isEntryCooldownBlocked() {
  if (!state.lastEnterLong.tsMs) return false;
  const diffSec = (nowMs() - state.lastEnterLong.tsMs) / 1000;
  return diffSec < CONFIG.ENTRY_COOLDOWN_SEC;
}

function isExitDedupBlocked(signal) {
  if (!state.lastExitLong.tsMs) return false;
  const diffSec = (nowMs() - state.lastExitLong.tsMs) / 1000;
  return diffSec < CONFIG.EXIT_DEDUP_SEC && state.lastExitLong.signal === signal;
}

function isExitCooldownBlocked() {
  if (!state.lastExitLong.tsMs) return false;
  const diffSec = (nowMs() - state.lastExitLong.tsMs) / 1000;
  return diffSec < CONFIG.EXIT_COOLDOWN_SEC;
}

// --------------------------------------------------
// Decision engine
// --------------------------------------------------
function decideRayAlgoSignal({ signal, price, time }) {
  const biasStatus = getBiasStatus();
  const positionStatus = getPositionStatus();

  if (CONFIG.REQUIRE_KNOWN_SIGNAL && !KNOWN_SIGNALS.has(signal)) {
    return {
      action: "ignore",
      allowed: false,
      reason: "unknown_signal",
      biasStatus,
      positionStatus,
    };
  }

  // Bearish signals cancel bullish context and may trigger exit_long.
  if (isBearishSignal(signal)) {
    cancelBullishBias("bearish_signal_received", { signal, price, ts: time });

    if (
      signal === SIGNALS.BEARISH_TREND_CHANGE &&
      CONFIG.EXIT_ON_BEARISH_TREND_CHANGE
    ) {
      return {
        action: "exit_long",
        allowed: true,
        reason: "bearish_trend_change_exit",
        biasStatus: getBiasStatus(),
        positionStatus: getPositionStatus(),
      };
    }

    if (signal === SIGNALS.BEARISH_BOS && CONFIG.EXIT_ON_BEARISH_BOS) {
      return {
        action: "exit_long",
        allowed: true,
        reason: "bearish_bos_exit",
        biasStatus: getBiasStatus(),
        positionStatus: getPositionStatus(),
      };
    }

    if (
      signal === SIGNALS.BEARISH_TREND_CONTINUATION &&
      CONFIG.EXIT_ON_BEARISH_TREND_CONTINUATION
    ) {
      return {
        action: "exit_long",
        allowed: true,
        reason: "bearish_trend_continuation_exit",
        biasStatus: getBiasStatus(),
        positionStatus: getPositionStatus(),
      };
    }

    return {
      action: "ignore",
      allowed: false,
      reason: "bearish_signal_exit_disabled",
      biasStatus: getBiasStatus(),
      positionStatus: getPositionStatus(),
    };
  }

  // Bullish Trend Change
  if (signal === SIGNALS.BULLISH_TREND_CHANGE) {
    saveBullishBias({ signal, price, time });

    if (!CONFIG.BASIC_ALLOW_TREND_CHANGE_ENTRY) {
      return {
        action: "bias_only",
        allowed: false,
        reason: "bullish_trend_change_saved_bias_only",
        biasStatus: getBiasStatus(),
        positionStatus: getPositionStatus(),
      };
    }

    return {
      action: "enter_long",
      allowed: true,
      reason: "bullish_trend_change_entry_enabled",
      biasStatus: getBiasStatus(),
      positionStatus: getPositionStatus(),
    };
  }

  // Bullish BOS
  if (signal === SIGNALS.BULLISH_BOS) {
    saveBosBias({ signal, price, time });

    return {
      action: "enter_long",
      allowed: true,
      reason: "bullish_bos_direct_entry",
      biasStatus: getBiasStatus(),
      positionStatus: getPositionStatus(),
    };
  }

  // Bullish Trend Continuation
  if (signal === SIGNALS.BULLISH_TREND_CONTINUATION) {
    if (!CONFIG.ALLOW_TREND_CONTINUATION_ENTRY) {
      return {
        action: "ignore",
        allowed: false,
        reason: "trend_continuation_entry_disabled",
        biasStatus,
        positionStatus,
      };
    }

    const recentBullish = hasRecentBullishBias();
    const recentBos = hasRecentBosBias();

    if (!recentBullish && !recentBos) {
      return {
        action: "ignore",
        allowed: false,
        reason: "trend_continuation_without_recent_bullish_context",
        biasStatus: getBiasStatus(),
        positionStatus: getPositionStatus(),
      };
    }

    return {
      action: "enter_long",
      allowed: true,
      reason: recentBos
        ? "trend_continuation_after_recent_bos"
        : "trend_continuation_after_recent_bullish_bias",
      biasStatus: getBiasStatus(),
      positionStatus: getPositionStatus(),
    };
  }

  return {
    action: "ignore",
    allowed: false,
    reason: "no_matching_rule",
    biasStatus,
    positionStatus,
  };
}

function applyTradeProtection({ decision, signal, price, time }) {
  if (!decision.allowed) {
    return decision;
  }

  if (decision.action === "enter_long") {
    if (CONFIG.LOCK_AFTER_ENTER && state.position.inLong) {
      state.counters.enterBlocked += 1;

      return {
        ...decision,
        allowed: false,
        action: "blocked",
        reason: "already_in_long_lock_after_enter",
        lastEnterLongAgeSec: ageSec(state.lastEnterLong.tsMs),
        positionStatus: getPositionStatus(),
      };
    }

    if (isEnterDedupBlocked(signal)) {
      state.counters.enterBlocked += 1;

      return {
        ...decision,
        allowed: false,
        action: "blocked",
        reason: "enter_dedup_blocked",
        lastEnterLongAgeSec: ageSec(state.lastEnterLong.tsMs),
        positionStatus: getPositionStatus(),
      };
    }

    if (isEntryCooldownBlocked()) {
      state.counters.enterBlocked += 1;

      return {
        ...decision,
        allowed: false,
        action: "blocked",
        reason: "entry_cooldown_blocked",
        lastEnterLongAgeSec: ageSec(state.lastEnterLong.tsMs),
        positionStatus: getPositionStatus(),
      };
    }

    markEnterLong({
      signal,
      price,
      time,
      reason: decision.reason,
    });

    state.counters.enterAllowed += 1;

    return {
      ...decision,
      positionStatus: getPositionStatus(),
    };
  }

  if (decision.action === "exit_long") {
    if (CONFIG.LOCK_AFTER_ENTER && !state.position.inLong) {
      state.counters.exitBlocked += 1;

      return {
        ...decision,
        allowed: false,
        action: "blocked",
        reason: "not_in_long_exit_blocked",
        lastExitLongAgeSec: ageSec(state.lastExitLong.tsMs),
        positionStatus: getPositionStatus(),
      };
    }

    if (isExitDedupBlocked(signal)) {
      state.counters.exitBlocked += 1;

      return {
        ...decision,
        allowed: false,
        action: "blocked",
        reason: "exit_dedup_blocked",
        lastExitLongAgeSec: ageSec(state.lastExitLong.tsMs),
        positionStatus: getPositionStatus(),
      };
    }

    if (isExitCooldownBlocked()) {
      state.counters.exitBlocked += 1;

      return {
        ...decision,
        allowed: false,
        action: "blocked",
        reason: "exit_cooldown_blocked",
        lastExitLongAgeSec: ageSec(state.lastExitLong.tsMs),
        positionStatus: getPositionStatus(),
      };
    }

    markExitLong({
      signal,
      price,
      time,
      reason: decision.reason,
    });

    state.counters.exitAllowed += 1;

    return {
      ...decision,
      positionStatus: getPositionStatus(),
    };
  }

  return decision;
}

// --------------------------------------------------
// Color-coded horizontal decision logs
// --------------------------------------------------
function logFinalDecision({ signal, symbol, price, decision }) {
  const base = {
    signal,
    symbol,
    price,
    action: decision.action,
    allowed: decision.allowed,
    reason: decision.reason,

    inLong: state.position.inLong,
    entrySignal: state.position.entrySignal,
    entryPrice: state.position.entryPrice,
    entryAgeSec: ageSec(state.position.entryTsMs),
    exitSignal: state.position.exitSignal,
    exitPrice: state.position.exitPrice,
    exitAgeSec: ageSec(state.position.exitTsMs),

    lastEnterLongAgeSec: ageSec(state.lastEnterLong.tsMs),
    lastExitLongAgeSec: ageSec(state.lastExitLong.tsMs),

    bullishBiasActive: hasRecentBullishBias(),
    bullishBiasSignal: state.bullishBias.signal,
    bullishBiasPrice: state.bullishBias.price,
    bosBiasActive: hasRecentBosBias(),
    bosBiasSignal: state.bosBias.signal,
    bosBiasPrice: state.bosBias.price,
  };

  if (decision.action === "enter_long" && decision.allowed) {
    logEvent("🟢 ENTRY_ALLOWED", base);
    return;
  }

  if (decision.action === "exit_long" && decision.allowed) {
    logEvent("🔴 EXIT_ALLOWED", base);
    return;
  }

  if (decision.action === "bias_only") {
    logEvent("🧠 BIAS_ONLY", base);
    return;
  }

  if (
    decision.action === "blocked" &&
    (
      String(decision.reason || "").includes("enter") ||
      String(decision.reason || "").includes("in_long") ||
      String(decision.reason || "").includes("cooldown")
    )
  ) {
    logEvent("⛔ ENTRY_BLOCKED", base);
    return;
  }

  if (
    decision.action === "blocked" &&
    (
      String(decision.reason || "").includes("exit") ||
      String(decision.reason || "").includes("not_in_long")
    )
  ) {
    logEvent("🟠 EXIT_BLOCKED", base);
    return;
  }

  if (isBearishSignal(signal) && !decision.allowed) {
    logEvent("🟠 EXIT_BLOCKED", base);
    return;
  }

  logEvent("⚪ SIGNAL_IGNORED", base);
}

// --------------------------------------------------
// 3Commas forwarding
// --------------------------------------------------
function resolveBotUuid(symbol) {
  const botUuid = CONFIG.SYMBOL_BOT_MAP[symbol];
  if (botUuid) return String(botUuid);

  const fallback = CONFIG.SYMBOL_BOT_MAP[CONFIG.SYMBOL];
  if (fallback) return String(fallback);

  return "";
}

function splitTvSymbol(symbol) {
  const s = normalizeSymbol(symbol);

  if (s.includes(":")) {
    const [exchange, instrument] = s.split(":");
    return {
      tv_exchange: exchange || "BINANCE",
      tv_instrument: instrument || s,
    };
  }

  return {
    tv_exchange: "BINANCE",
    tv_instrument: s,
  };
}

function build3CommasSignal({ symbol, action, price, time }) {
  const botUuid = resolveBotUuid(symbol);
  const { tv_exchange, tv_instrument } = splitTvSymbol(symbol);

  return {
    secret: CONFIG.C3_SIGNAL_SECRET,
    max_lag: String(CONFIG.MAX_LAG_SEC),
    timestamp: time || isoNow(),
    trigger_price: String(price),
    tv_exchange,
    tv_instrument,
    action,
    bot_uuid: botUuid,
  };
}

async function postJsonWithTimeout(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text().catch(() => "");

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      bodyText: text,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function forwardTo3Commas({ symbol, action, price, time, signal, reason }) {
  if (!CONFIG.ENABLE_HTTP_FORWARD) {
    logEvent("⚪ FORWARD_SKIP", {
      reason: "http_forward_disabled",
      symbol,
      action,
      price,
      signal,
    });

    return {
      skipped: true,
      ok: true,
      reason: "http_forward_disabled",
    };
  }

  if (!CONFIG.C3_SIGNAL_SECRET) {
    errorEvent("❌ FORWARD_FAIL", {
      reason: "missing_c3_signal_secret",
      symbol,
      action,
      signal,
    });

    return {
      ok: false,
      skipped: false,
      reason: "missing_c3_signal_secret",
    };
  }

  const botUuid = resolveBotUuid(symbol);

  if (!botUuid) {
    errorEvent("❌ FORWARD_FAIL", {
      reason: "missing_bot_uuid_for_symbol",
      symbol,
      action,
      signal,
    });

    return {
      ok: false,
      skipped: false,
      reason: "missing_bot_uuid_for_symbol",
    };
  }

  const payload = build3CommasSignal({
    symbol,
    action,
    price,
    time,
  });

  logEvent("📤 FORWARD_3COMMAS", {
    symbol,
    action,
    signal,
    reason,
    trigger_price: payload.trigger_price,
    tv_exchange: payload.tv_exchange,
    tv_instrument: payload.tv_instrument,
    bot_uuid: payload.bot_uuid,
    timestamp: payload.timestamp,
    max_lag: payload.max_lag,
  });

  try {
    const result = await postJsonWithTimeout(
      CONFIG.C3_SIGNAL_URL,
      payload,
      CONFIG.C3_TIMEOUT_MS
    );

    if (result.ok) {
      state.counters.forwardedOk += 1;

      logEvent("✅ FORWARD_OK", {
        action,
        signal,
        status: result.status,
        body: result.bodyText,
      });
    } else {
      state.counters.forwardedFail += 1;

      errorEvent("❌ FORWARD_FAIL", {
        action,
        signal,
        status: result.status,
        statusText: result.statusText,
        body: result.bodyText,
      });
    }

    return result;
  } catch (e) {
    state.counters.forwardedFail += 1;

    errorEvent("❌ FORWARD_FAIL", {
      action,
      signal,
      reason: "forward_exception",
      error: String(e?.message || e),
    });

    return {
      ok: false,
      skipped: false,
      reason: "forward_exception",
      error: e?.message || String(e),
    };
  }
}

// --------------------------------------------------
// Routes
// --------------------------------------------------
app.get("/", (req, res) => {
  return responseOk(res, {
    message: "Brain is running",
    startedAt: state.startedAt,
    webhookPath: CONFIG.WEBHOOK_PATH,
    symbol: CONFIG.SYMBOL,
    config: {
      debug: CONFIG.DEBUG,
      enableHttpForward: CONFIG.ENABLE_HTTP_FORWARD,
      basicAllowTrendChangeEntry: CONFIG.BASIC_ALLOW_TREND_CHANGE_ENTRY,
      allowTrendContinuationEntry: CONFIG.ALLOW_TREND_CONTINUATION_ENTRY,
      bullishBiasTtlMin: CONFIG.BULLISH_BIAS_TTL_MIN,
      bosBiasTtlMin: CONFIG.BOS_BIAS_TTL_MIN,
      enterDedupSec: CONFIG.ENTER_DEDUP_SEC,
      entryCooldownSec: CONFIG.ENTRY_COOLDOWN_SEC,
      lockAfterEnter: CONFIG.LOCK_AFTER_ENTER,
      exitOnBearishTrendChange: CONFIG.EXIT_ON_BEARISH_TREND_CHANGE,
      exitOnBearishBos: CONFIG.EXIT_ON_BEARISH_BOS,
      exitOnBearishTrendContinuation: CONFIG.EXIT_ON_BEARISH_TREND_CONTINUATION,
      exitDedupSec: CONFIG.EXIT_DEDUP_SEC,
      exitCooldownSec: CONFIG.EXIT_COOLDOWN_SEC,
      requireKnownSignal: CONFIG.REQUIRE_KNOWN_SIGNAL,
    },
    position: getPositionStatus(),
    bias: getBiasStatus(),
    counters: state.counters,
  });
});

app.get("/health", (req, res) => {
  return responseOk(res, {
    status: "healthy",
    startedAt: state.startedAt,
    symbol: CONFIG.SYMBOL,
    position: getPositionStatus(),
    bias: getBiasStatus(),
    counters: state.counters,
  });
});

app.get("/state", (req, res) => {
  return responseOk(res, {
    state,
    config: {
      brainName: CONFIG.BRAIN_NAME,
      symbol: CONFIG.SYMBOL,
      webhookPath: CONFIG.WEBHOOK_PATH,
      enableHttpForward: CONFIG.ENABLE_HTTP_FORWARD,
      basicAllowTrendChangeEntry: CONFIG.BASIC_ALLOW_TREND_CHANGE_ENTRY,
      allowTrendContinuationEntry: CONFIG.ALLOW_TREND_CONTINUATION_ENTRY,
      bullishBiasTtlMin: CONFIG.BULLISH_BIAS_TTL_MIN,
      bosBiasTtlMin: CONFIG.BOS_BIAS_TTL_MIN,
      enterDedupSec: CONFIG.ENTER_DEDUP_SEC,
      entryCooldownSec: CONFIG.ENTRY_COOLDOWN_SEC,
      lockAfterEnter: CONFIG.LOCK_AFTER_ENTER,
      exitOnBearishTrendChange: CONFIG.EXIT_ON_BEARISH_TREND_CHANGE,
      exitOnBearishBos: CONFIG.EXIT_ON_BEARISH_BOS,
      exitOnBearishTrendContinuation: CONFIG.EXIT_ON_BEARISH_TREND_CONTINUATION,
      exitDedupSec: CONFIG.EXIT_DEDUP_SEC,
      exitCooldownSec: CONFIG.EXIT_COOLDOWN_SEC,
      requireKnownSignal: CONFIG.REQUIRE_KNOWN_SIGNAL,
    },
  });
});

app.post(CONFIG.WEBHOOK_PATH, async (req, res) => {
  state.counters.received += 1;

  const body = req.body || {};
  state.lastPayload = body;

  const receivedSecret = String(body.secret || body.tv_secret || "").trim();

  if (!CONFIG.WEBHOOK_SECRET) {
    errorEvent("❌ WEBHOOK_SECRET_MISSING", {});
    return responseFail(res, 500, {
      reason: "server_missing_webhook_secret",
    });
  }

  if (receivedSecret !== CONFIG.WEBHOOK_SECRET) {
    state.counters.unauthorized += 1;

    warnEvent("🚫 UNAUTHORIZED", {
      receivedSecretPresent: Boolean(receivedSecret),
    });

    return responseFail(res, 401, {
      reason: "unauthorized",
    });
  }

  const src = normalizeSrc(body.src);
  const symbol = normalizeSymbol(body.symbol || body.ticker || body.tickerid || CONFIG.SYMBOL);
  const signal = normalizeSignal(body.signal || body.alert || body.condition);
  const price = safeNumber(body.price ?? body.close ?? body.trigger_price, null);
  const time = String(body.time || body.timestamp || isoNow()).trim();

  if (symbol !== CONFIG.SYMBOL) {
    state.counters.wrongSymbol += 1;

    warnEvent("⚠️ WRONG_SYMBOL", {
      received: symbol,
      expected: CONFIG.SYMBOL,
      signal,
      price,
    });

    return responseOk(res, {
      accepted: false,
      reason: "wrong_symbol",
      receivedSymbol: symbol,
      expectedSymbol: CONFIG.SYMBOL,
    });
  }

  if (!signal) {
    state.counters.unknownSignal += 1;

    warnEvent("⚠️ UNKNOWN_SIGNAL", {
      reason: "missing_signal",
      src,
      symbol,
      price,
    });

    return responseOk(res, {
      accepted: false,
      reason: "missing_signal",
    });
  }

  if (CONFIG.REQUIRE_KNOWN_SIGNAL && !KNOWN_SIGNALS.has(signal)) {
    state.counters.unknownSignal += 1;

    warnEvent("⚠️ UNKNOWN_SIGNAL", {
      signal,
      src,
      symbol,
      price,
      knownSignals: Array.from(KNOWN_SIGNALS),
    });

    return responseOk(res, {
      accepted: false,
      reason: "unknown_signal",
      signal,
      knownSignals: Array.from(KNOWN_SIGNALS),
    });
  }

  const cleanPrice = price ?? 0;

  logEvent(raySignalTag(signal), {
    price: cleanPrice,
    ts: time,
    src,
    symbol,
  });

  let decision = decideRayAlgoSignal({
    signal,
    price: cleanPrice,
    time,
  });

  decision = applyTradeProtection({
    decision,
    signal,
    price: cleanPrice,
    time,
  });

  logFinalDecision({
    signal,
    symbol,
    price: cleanPrice,
    decision,
  });

  if (!decision.allowed || !["enter_long", "exit_long"].includes(decision.action)) {
    return responseOk(res, {
      accepted: true,
      forwarded: false,
      src,
      symbol,
      signal,
      price: cleanPrice,
      decision,
      position: getPositionStatus(),
      counters: state.counters,
    });
  }

  const forwardResult = await forwardTo3Commas({
    symbol,
    action: decision.action,
    price: cleanPrice,
    time,
    signal,
    reason: decision.reason,
  });

  return responseOk(res, {
    accepted: true,
    forwarded: Boolean(forwardResult.ok && !forwardResult.skipped),
    src,
    symbol,
    signal,
    price: cleanPrice,
    action: decision.action,
    decision,
    forwardResult,
    position: getPositionStatus(),
    counters: state.counters,
  });
});

app.post("/reset", (req, res) => {
  cancelBullishBias("manual_reset");

  state.lastEnterLong = {
    tsMs: null,
    price: null,
    signal: null,
    reason: null,
  };

  state.lastExitLong = {
    tsMs: null,
    price: null,
    signal: null,
    reason: null,
  };

  state.position = {
    inLong: false,
    entryPrice: null,
    entrySignal: null,
    entryTime: null,
    entryTsMs: null,
    exitPrice: null,
    exitSignal: null,
    exitTime: null,
    exitTsMs: null,
  };

  logEvent("♻️ STATE_RESET", {
    position: getCompactPosition(),
    bias: getCompactBias(),
  });

  return responseOk(res, {
    message: "state reset",
    position: getPositionStatus(),
    bias: getBiasStatus(),
  });
});

// --------------------------------------------------
// Start
// --------------------------------------------------
app.listen(CONFIG.PORT, () => {
  console.log(
    `${isoNow()} ✅ START_OK | ${oneLine({
      brain: CONFIG.BRAIN_NAME,
      port: CONFIG.PORT,
      symbol: CONFIG.SYMBOL,
      webhookPath: CONFIG.WEBHOOK_PATH,
    })}`
  );

  console.log(
    `${isoNow()} 🧠 CONFIG_SNAPSHOT | ${oneLine({
      webhookPath: CONFIG.WEBHOOK_PATH,
      symbol: CONFIG.SYMBOL,
      debug: CONFIG.DEBUG,
      enableHttpForward: CONFIG.ENABLE_HTTP_FORWARD,
      c3Url: CONFIG.C3_SIGNAL_URL,
      hasWebhookSecret: Boolean(CONFIG.WEBHOOK_SECRET),
      hasC3SignalSecret: Boolean(CONFIG.C3_SIGNAL_SECRET),
      symbolBotMapKeys: Object.keys(CONFIG.SYMBOL_BOT_MAP),
      basicAllowTrendChangeEntry: CONFIG.BASIC_ALLOW_TREND_CHANGE_ENTRY,
      allowTrendContinuationEntry: CONFIG.ALLOW_TREND_CONTINUATION_ENTRY,
      bullishBiasTtlMin: CONFIG.BULLISH_BIAS_TTL_MIN,
      bosBiasTtlMin: CONFIG.BOS_BIAS_TTL_MIN,
      enterDedupSec: CONFIG.ENTER_DEDUP_SEC,
      entryCooldownSec: CONFIG.ENTRY_COOLDOWN_SEC,
      lockAfterEnter: CONFIG.LOCK_AFTER_ENTER,
      exitOnBearishTrendChange: CONFIG.EXIT_ON_BEARISH_TREND_CHANGE,
      exitOnBearishBos: CONFIG.EXIT_ON_BEARISH_BOS,
      exitOnBearishTrendContinuation: CONFIG.EXIT_ON_BEARISH_TREND_CONTINUATION,
      exitDedupSec: CONFIG.EXIT_DEDUP_SEC,
      exitCooldownSec: CONFIG.EXIT_COOLDOWN_SEC,
      requireKnownSignal: CONFIG.REQUIRE_KNOWN_SIGNAL,
    })}`
  );
});
