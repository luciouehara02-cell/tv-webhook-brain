/**
 * BrainRAY_Basic_Signal_v1.0
 *
 * Goal:
 * - Basic RayAlgo TradingView signal bridge
 * - TradingView -> Railway /webhook -> 3Commas Signal Bot
 *
 * Signal logic:
 * - Bullish Trend Change:
 *   -> save bullish_bias
 *   -> optional enter_long only if BASIC_ALLOW_TREND_CHANGE_ENTRY=true
 *
 * - Bullish BOS:
 *   -> save bos_biass
 *   -> enter_long
 *
 * - Bullish Trend Continuation:
 *   -> enter_long only if recent bullish_bias or recent Bullish BOS exists
 *
 * Bearish signals:
 * - cancel bullish bias
 * - no short trading in v1.0
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

function parseSymbolBotMap(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch (e) {
    console.error("❌ Invalid SYMBOL_BOT_MAP JSON:", e?.message || e);
    return {};
  }
}

function log(...args) {
  if (CONFIG.DEBUG) {
    console.log(...args);
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
  BRAIN_NAME: strEnv("BRAIN_NAME", "BrainRAY_Basic_Signal_v1.0"),
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

  REQUIRE_KNOWN_SIGNAL: boolEnv("REQUIRE_KNOWN_SIGNAL", true),
};

// --------------------------------------------------
// State
// Railway is stateless on redeploy/restart.
// This memory is runtime-only.
// --------------------------------------------------
const state = {
  startedAt: isoNow(),

  lastPayload: null,

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

  counters: {
    received: 0,
    unauthorized: 0,
    wrongSymbol: 0,
    unknownSignal: 0,
    biasSaved: 0,
    biasCancelled: 0,
    enterAllowed: 0,
    enterBlocked: 0,
    forwardedOk: 0,
    forwardedFail: 0,
  },
};

// --------------------------------------------------
// Signal definitions
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

function saveBullishBias({ signal, price, time }) {
  state.bullishBias = {
    active: true,
    signal,
    price,
    time,
    tsMs: nowMs(),
  };

  state.counters.biasSaved += 1;

  log("🟢 bullish_bias saved", {
    signal,
    price,
    time,
    ttlMin: CONFIG.BULLISH_BIAS_TTL_MIN,
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

  log("🟢 bos_bias saved", {
    signal,
    price,
    time,
    ttlMin: CONFIG.BOS_BIAS_TTL_MIN,
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

  log("🔴 bullish bias cancelled", {
    reason,
    ...payload,
  });
}

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

// --------------------------------------------------
// Entry protection
// --------------------------------------------------
function isEnterDedupBlocked(signal) {
  if (!state.lastEnterLong.tsMs) return false;
  const diffSec = (nowMs() - state.lastEnterLong.tsMs) / 1000;

  return (
    diffSec < CONFIG.ENTER_DEDUP_SEC &&
    state.lastEnterLong.signal === signal
  );
}

function isEntryCooldownBlocked() {
  if (!state.lastEnterLong.tsMs) return false;
  const diffSec = (nowMs() - state.lastEnterLong.tsMs) / 1000;
  return diffSec < CONFIG.ENTRY_COOLDOWN_SEC;
}

function markEnterLong({ signal, price, reason }) {
  state.lastEnterLong = {
    tsMs: nowMs(),
    price,
    signal,
    reason,
  };
}

// --------------------------------------------------
// Decision engine
// --------------------------------------------------
function decideRayAlgoSignal({ signal, price, time }) {
  const biasStatus = getBiasStatus();

  if (CONFIG.REQUIRE_KNOWN_SIGNAL && !KNOWN_SIGNALS.has(signal)) {
    return {
      action: "ignore",
      allowed: false,
      reason: "unknown_signal",
      biasStatus,
    };
  }

  // Bearish signal cancels bullish context.
  // v1.0 does not trade short.
  if (isBearishSignal(signal)) {
    cancelBullishBias("bearish_signal_received", { signal, price, time });

    return {
      action: "ignore",
      allowed: false,
      reason: "bearish_signal_cancelled_bullish_bias",
      biasStatus: getBiasStatus(),
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
      };
    }

    return {
      action: "enter_long",
      allowed: true,
      reason: "bullish_trend_change_entry_enabled",
      biasStatus: getBiasStatus(),
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
      };
    }

    return {
      action: "enter_long",
      allowed: true,
      reason: recentBos
        ? "trend_continuation_after_recent_bos"
        : "trend_continuation_after_recent_bullish_bias",
      biasStatus: getBiasStatus(),
    };
  }

  return {
    action: "ignore",
    allowed: false,
    reason: "no_matching_rule",
    biasStatus,
  };
}

function applyEntryProtection({ decision, signal, price }) {
  if (!decision.allowed || decision.action !== "enter_long") {
    return decision;
  }

  if (isEnterDedupBlocked(signal)) {
    state.counters.enterBlocked += 1;

    return {
      ...decision,
      allowed: false,
      action: "blocked",
      reason: "enter_dedup_blocked",
      lastEnterLongAgeSec: ageSec(state.lastEnterLong.tsMs),
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
    };
  }

  markEnterLong({
    signal,
    price,
    reason: decision.reason,
  });

  state.counters.enterAllowed += 1;

  return decision;
}

// --------------------------------------------------
// 3Commas forwarding
// --------------------------------------------------
function resolveBotUuid(symbol) {
  const botUuid = CONFIG.SYMBOL_BOT_MAP[symbol];

  if (botUuid) return String(botUuid);

  // Fallback if user only trades one symbol and bot UUID was mapped with configured symbol.
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
    log("🧪 forward skipped because ENABLE_HTTP_FORWARD=false", {
      symbol,
      action,
      price,
      signal,
      reason,
    });

    return {
      skipped: true,
      ok: true,
      reason: "http_forward_disabled",
    };
  }

  if (!CONFIG.C3_SIGNAL_SECRET) {
    return {
      ok: false,
      skipped: false,
      reason: "missing_c3_signal_secret",
    };
  }

  const botUuid = resolveBotUuid(symbol);
  if (!botUuid) {
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

  log("📤 forwarding to 3Commas", {
    url: CONFIG.C3_SIGNAL_URL,
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

      log("✅ 3Commas forward OK", {
        status: result.status,
        body: result.bodyText,
      });
    } else {
      state.counters.forwardedFail += 1;

      console.error("❌ 3Commas forward FAILED", {
        status: result.status,
        statusText: result.statusText,
        body: result.bodyText,
      });
    }

    return result;
  } catch (e) {
    state.counters.forwardedFail += 1;

    console.error("❌ 3Commas forward ERROR", e?.message || e);

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
      requireKnownSignal: CONFIG.REQUIRE_KNOWN_SIGNAL,
    },
    bias: getBiasStatus(),
    counters: state.counters,
  });
});

app.get("/health", (req, res) => {
  return responseOk(res, {
    status: "healthy",
    startedAt: state.startedAt,
    symbol: CONFIG.SYMBOL,
    bias: getBiasStatus(),
    counters: state.counters,
  });
});

app.post(CONFIG.WEBHOOK_PATH, async (req, res) => {
  state.counters.received += 1;

  const body = req.body || {};
  state.lastPayload = body;

  const receivedSecret = String(body.secret || body.tv_secret || "").trim();

  if (!CONFIG.WEBHOOK_SECRET) {
    console.error("❌ WEBHOOK_SECRET is not configured");
    return responseFail(res, 500, {
      reason: "server_missing_webhook_secret",
    });
  }

  if (receivedSecret !== CONFIG.WEBHOOK_SECRET) {
    state.counters.unauthorized += 1;

    console.warn("🚫 unauthorized webhook", {
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

    console.warn("⚠️ wrong symbol ignored", {
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

    return responseOk(res, {
      accepted: false,
      reason: "missing_signal",
    });
  }

  if (CONFIG.REQUIRE_KNOWN_SIGNAL && !KNOWN_SIGNALS.has(signal)) {
    state.counters.unknownSignal += 1;

    console.warn("⚠️ unknown signal ignored", {
      signal,
      src,
      symbol,
      price,
    });

    return responseOk(res, {
      accepted: false,
      reason: "unknown_signal",
      signal,
      knownSignals: Array.from(KNOWN_SIGNALS),
    });
  }

  const cleanPrice = price ?? 0;

  log("📩 webhook received", {
    src,
    symbol,
    signal,
    price: cleanPrice,
    time,
  });

  let decision = decideRayAlgoSignal({
    signal,
    price: cleanPrice,
    time,
  });

  decision = applyEntryProtection({
    decision,
    signal,
    price: cleanPrice,
  });

  log("🧠 decision", {
    signal,
    symbol,
    price: cleanPrice,
    action: decision.action,
    allowed: decision.allowed,
    reason: decision.reason,
    biasStatus: decision.biasStatus,
    lastEnterLongAgeSec: ageSec(state.lastEnterLong.tsMs),
  });

  if (!decision.allowed || decision.action !== "enter_long") {
    return responseOk(res, {
      accepted: true,
      forwarded: false,
      src,
      symbol,
      signal,
      price: cleanPrice,
      decision,
      counters: state.counters,
    });
  }

  const forwardResult = await forwardTo3Commas({
    symbol,
    action: "enter_long",
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
    action: "enter_long",
    decision,
    forwardResult,
    counters: state.counters,
  });
});

// Optional debug route to inspect state
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
    },
  });
});

// Optional manual reset route
app.post("/reset", (req, res) => {
  cancelBullishBias("manual_reset");

  state.lastEnterLong = {
    tsMs: null,
    price: null,
    signal: null,
    reason: null,
  };

  return responseOk(res, {
    message: "state reset",
    bias: getBiasStatus(),
  });
});

// --------------------------------------------------
// Start
// --------------------------------------------------
app.listen(CONFIG.PORT, () => {
  console.log(`✅ ${CONFIG.BRAIN_NAME} listening on port ${CONFIG.PORT}`);
  console.log("Config snapshot:", {
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
    requireKnownSignal: CONFIG.REQUIRE_KNOWN_SIGNAL,
  });
});
