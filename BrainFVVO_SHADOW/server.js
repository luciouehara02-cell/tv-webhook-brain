// ============================================================
// BrainFVVO_v1g_EXIT_MANAGED_DEMO_FORWARD
// Standalone FVVO demo-forward brain
// ------------------------------------------------------------
// v1g exit-managed build based on v1f pulse logic:
// - DEMO-only forwarding safety.
// - Forwards CROSS_UP_CONFIRM only by default.
// - Uses one-candle FVVO red/green pulses; raw active states are logged only.
// - Red pulse blocks new longs briefly and can act as profit-only exit warning.
// - Green pulse creates recovery memory for cross-up confirmation.
// - Adds fee-aware quick TP, exit forwarding, and forwarded-deal lock by default.
// ============================================================

const express = require("express");

function envStr(name, fallback = "") {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === "") return fallback;
  return String(v).trim();
}

function envNum(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === "") return fallback;
  const s = String(v).trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(s);
}

function parseJsonEnv(name, fallback) {
  const raw = envStr(name, "");
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.log(`${new Date().toISOString()} | CONFIG_ERROR | ${name} is not valid JSON: ${err.message}`);
    return fallback;
  }
}

const CFG = {
  BRAIN_NAME: envStr("BRAIN_NAME", "BrainFVVO_v1g_EXIT_MANAGED_DEMO_FORWARD"),
  PORT: envNum("PORT", 8080),
  WEBHOOK_PATH: envStr("WEBHOOK_PATH", "/webhook"),
  WEBHOOK_SECRET: envStr("WEBHOOK_SECRET", "BrainFVVO_DEMO_40+CHARS_9f8d7c6b5a4e3d2c1b0a"),
  DEBUG: envBool("DEBUG", true),

  SYMBOL: envStr("SYMBOL", "BINANCE:SOLUSDT"),
  ENTRY_TF: envStr("ENTRY_TF", "5"),

  SHADOW_ONLY: envBool("SHADOW_ONLY", true),
  ENABLE_HTTP_FORWARD: envBool("ENABLE_HTTP_FORWARD", false),
  DEMO_FORWARD_ALLOWED: envBool("DEMO_FORWARD_ALLOWED", false),
  LIVE_FORWARD_ALLOWED: envBool("LIVE_FORWARD_ALLOWED", false),
  C3_DRY_RUN: envBool("C3_DRY_RUN", false),

  C3_SIGNAL_URL: envStr("C3_SIGNAL_URL", "https://api.3commas.io/signal_bots/webhooks"),
  C3_SIGNAL_SECRET: envStr("C3_SIGNAL_SECRET", ""),
  C3_MAX_LAG_SEC: envNum("C3_MAX_LAG_SEC", 300),
  C3_ORDER_AMOUNT_QUOTE: envNum("C3_ORDER_AMOUNT_QUOTE", 0),
  C3_REQUEST_TIMEOUT_MS: envNum("C3_REQUEST_TIMEOUT_MS", 10000),
  C3_FORWARD_DEDUP_MS: envNum("C3_FORWARD_DEDUP_MS", 60000),
  SYMBOL_BOT_MAP: parseJsonEnv("SYMBOL_BOT_MAP", {}),

  FVVO_FORWARD_CROSS_ENABLED: envBool("FVVO_FORWARD_CROSS_ENABLED", true),
  FVVO_FORWARD_WASHOUT_ENABLED: envBool("FVVO_FORWARD_WASHOUT_ENABLED", false),
  FVVO_FORWARD_RISING_ENABLED: envBool("FVVO_FORWARD_RISING_ENABLED", false),
  FVVO_FORWARD_EXIT_ENABLED: envBool("FVVO_FORWARD_EXIT_ENABLED", true),

  FVVO_LONG_ENABLED: envBool("FVVO_LONG_ENABLED", true),
  FVVO_SHORT_ENABLED: envBool("FVVO_SHORT_ENABLED", false),
  FVVO_ENTRY_COOLDOWN_BARS: envNum("FVVO_ENTRY_COOLDOWN_BARS", 2),

  // v1f: pulse logic uses one-candle pulses only. Raw redActive/greenActive are logged
  // but never used for trading logic. FVVO_DOT_PULSE_USE_IN_LOGIC remains as a
  // compatibility switch and defaults true in v1f.
  FVVO_DOT_PULSE_TEST_MODE: envBool("FVVO_DOT_PULSE_TEST_MODE", true),
  FVVO_DOT_PULSE_USE_IN_LOGIC: envBool("FVVO_DOT_PULSE_USE_IN_LOGIC", true),
  FVVO_PULSE_LOGIC_ENABLED: envBool("FVVO_PULSE_LOGIC_ENABLED", true),

  FVVO_RED_PULSE_BLOCK_BARS: envNum("FVVO_RED_PULSE_BLOCK_BARS", 2),
  FVVO_RED_PULSE_EXIT_ENABLED: envBool("FVVO_RED_PULSE_EXIT_ENABLED", true),
  FVVO_RED_PULSE_EXIT_MIN_PROFIT_PCT: envNum("FVVO_RED_PULSE_EXIT_MIN_PROFIT_PCT", 0.30),
  FVVO_RED_PULSE_EXIT_MAX_SLOPE: envNum("FVVO_RED_PULSE_EXIT_MAX_SLOPE", 0.60),
  FVVO_RED_PULSE_EXIT_MIN_GIVEBACK_PCT: envNum("FVVO_RED_PULSE_EXIT_MIN_GIVEBACK_PCT", 0.10),

  // v1g: exit-managed / fee-aware exits.
  // QUICK_TP closes confirmed winners before giveback can turn them into fee-negative trades.
  // SOFT_EXIT_MIN_PROFIT is applied to giveback-style exits, not emergency stop/loss exits.
  FVVO_FEE_ROUND_TRIP_PCT: envNum("FVVO_FEE_ROUND_TRIP_PCT", 0.15),
  FVVO_QUICK_TP_ENABLED: envBool("FVVO_QUICK_TP_ENABLED", true),
  FVVO_QUICK_TP_MIN_PCT: envNum("FVVO_QUICK_TP_MIN_PCT", 0.45),
  FVVO_QUICK_TP_MIN_BARS: envNum("FVVO_QUICK_TP_MIN_BARS", 1),
  FVVO_SOFT_EXIT_MIN_PROFIT_PCT: envNum("FVVO_SOFT_EXIT_MIN_PROFIT_PCT", 0.25),
  FVVO_EXTERNAL_DEAL_LOCK_ENABLED: envBool("FVVO_EXTERNAL_DEAL_LOCK_ENABLED", true),

  FVVO_GREEN_PULSE_MEMORY_BARS: envNum("FVVO_GREEN_PULSE_MEMORY_BARS", 18),
  FVVO_GREEN_PULSE_CROSS_ASSIST_ENABLED: envBool("FVVO_GREEN_PULSE_CROSS_ASSIST_ENABLED", true),
  FVVO_GREEN_PULSE_CROSS_MIN_RSI: envNum("FVVO_GREEN_PULSE_CROSS_MIN_RSI", 55),
  FVVO_GREEN_PULSE_CROSS_MIN_SLOPE: envNum("FVVO_GREEN_PULSE_CROSS_MIN_SLOPE", 1.00),
  FVVO_GREEN_PULSE_CROSS_MIN_ADX: envNum("FVVO_GREEN_PULSE_CROSS_MIN_ADX", 15),
  FVVO_GREEN_PULSE_CROSS_MAX_EXT_EMA8_PCT: envNum("FVVO_GREEN_PULSE_CROSS_MAX_EXT_EMA8_PCT", 0.45),
  FVVO_GREEN_PULSE_CROSS_MAX_EXT_EMA18_PCT: envNum("FVVO_GREEN_PULSE_CROSS_MAX_EXT_EMA18_PCT", 0.75),

  FVVO_WASHOUT_ENABLED: envBool("FVVO_WASHOUT_ENABLED", false),
  FVVO_WASHOUT_LOOKBACK_BARS: envNum("FVVO_WASHOUT_LOOKBACK_BARS", 12),
  FVVO_WASHOUT_RSI_MAX: envNum("FVVO_WASHOUT_RSI_MAX", 35),
  FVVO_WASHOUT_RSI_RECOVER_MIN: envNum("FVVO_WASHOUT_RSI_RECOVER_MIN", 38),
  FVVO_WASHOUT_MIN_DEEP_NEGATIVE: envNum("FVVO_WASHOUT_MIN_DEEP_NEGATIVE", -2.0),
  FVVO_WASHOUT_MIN_SLOPE: envNum("FVVO_WASHOUT_MIN_SLOPE", 0.50),
  FVVO_WASHOUT_ALLOW_GREEN_DOT: envBool("FVVO_WASHOUT_ALLOW_GREEN_DOT", false),
  FVVO_WASHOUT_MAX_CURRENT_FVVO: envNum("FVVO_WASHOUT_MAX_CURRENT_FVVO", 0.75),
  FVVO_WASHOUT_MAX_BELOW_EMA8_PCT: envNum("FVVO_WASHOUT_MAX_BELOW_EMA8_PCT", 0.45),
  FVVO_WASHOUT_MAX_EXT_EMA8_PCT: envNum("FVVO_WASHOUT_MAX_EXT_EMA8_PCT", 0.55),
  FVVO_WASHOUT_MAX_EXT_EMA18_PCT: envNum("FVVO_WASHOUT_MAX_EXT_EMA18_PCT", 0.80),
  FVVO_WASHOUT_BLOCK_FRESH_LOW: envBool("FVVO_WASHOUT_BLOCK_FRESH_LOW", true),
  FVVO_WASHOUT_REQUIRE_PRICE_CONFIRM: envBool("FVVO_WASHOUT_REQUIRE_PRICE_CONFIRM", true),

  FVVO_CROSS_ENABLED: envBool("FVVO_CROSS_ENABLED", true),
  FVVO_CROSS_MIN_RSI: envNum("FVVO_CROSS_MIN_RSI", 55),
  FVVO_CROSS_MIN_SLOPE: envNum("FVVO_CROSS_MIN_SLOPE", 0.60),
  FVVO_CROSS_MAX_EXT_EMA8_PCT: envNum("FVVO_CROSS_MAX_EXT_EMA8_PCT", 0.35),
  FVVO_CROSS_MAX_EXT_EMA18_PCT: envNum("FVVO_CROSS_MAX_EXT_EMA18_PCT", 0.65),
  FVVO_CROSS_ALLOW_EMA8_BELOW_EMA18_PCT: envNum("FVVO_CROSS_ALLOW_EMA8_BELOW_EMA18_PCT", 0.10),
  FVVO_CROSS_RECENT_REDDOT_BLOCK_BARS: envNum("FVVO_CROSS_RECENT_REDDOT_BLOCK_BARS", 2),

  FVVO_CROSS_MOMO_OVERRIDE_ENABLED: envBool("FVVO_CROSS_MOMO_OVERRIDE_ENABLED", true),
  FVVO_CROSS_MOMO_MIN_SLOPE: envNum("FVVO_CROSS_MOMO_MIN_SLOPE", 1.20),
  FVVO_CROSS_MOMO_MIN_RSI: envNum("FVVO_CROSS_MOMO_MIN_RSI", 60),
  FVVO_CROSS_MOMO_MAX_RSI: envNum("FVVO_CROSS_MOMO_MAX_RSI", 74),
  FVVO_CROSS_MOMO_MIN_ADX: envNum("FVVO_CROSS_MOMO_MIN_ADX", 24),
  FVVO_CROSS_MOMO_MAX_EXT_EMA8_PCT: envNum("FVVO_CROSS_MOMO_MAX_EXT_EMA8_PCT", 0.65),
  FVVO_CROSS_MOMO_MAX_EXT_EMA18_PCT: envNum("FVVO_CROSS_MOMO_MAX_EXT_EMA18_PCT", 0.90),

  FVVO_RISING_CONT_ENABLED: envBool("FVVO_RISING_CONT_ENABLED", false),
  FVVO_RISING_MIN_RSI: envNum("FVVO_RISING_MIN_RSI", 55),
  FVVO_RISING_MIN_SLOPE: envNum("FVVO_RISING_MIN_SLOPE", 0.80),
  FVVO_RISING_MAX_EXT_EMA8_PCT: envNum("FVVO_RISING_MAX_EXT_EMA8_PCT", 0.25),
  FVVO_RISING_MAX_EXT_EMA18_PCT: envNum("FVVO_RISING_MAX_EXT_EMA18_PCT", 0.55),

  FVVO_INTRABAR_HARD_STOP_ENABLED: envBool("FVVO_INTRABAR_HARD_STOP_ENABLED", true),
  FVVO_MAX_LOSS_EXIT_PCT: envNum("FVVO_MAX_LOSS_EXIT_PCT", 0.45),
  FVVO_GIVEBACK_ARM1_PCT: envNum("FVVO_GIVEBACK_ARM1_PCT", 0.30),
  FVVO_GIVEBACK_ARM1_DROP_PCT: envNum("FVVO_GIVEBACK_ARM1_DROP_PCT", 0.15),
  FVVO_GIVEBACK_ARM2_PCT: envNum("FVVO_GIVEBACK_ARM2_PCT", 0.50),
  FVVO_GIVEBACK_ARM2_DROP_PCT: envNum("FVVO_GIVEBACK_ARM2_DROP_PCT", 0.22),
  FVVO_HARD_DOWN_SLOPE: envNum("FVVO_HARD_DOWN_SLOPE", -0.08),
  FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT: envNum("FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT", 0.05),
  FVVO_MAX_HOLD_BARS: envNum("FVVO_MAX_HOLD_BARS", 36),

  FVVO_STRONG_TREND_HOLD_ENABLED: envBool("FVVO_STRONG_TREND_HOLD_ENABLED", true),
  FVVO_STRONG_TREND_HOLD_MIN_RSI: envNum("FVVO_STRONG_TREND_HOLD_MIN_RSI", 60),
  FVVO_STRONG_TREND_HOLD_MIN_ADX: envNum("FVVO_STRONG_TREND_HOLD_MIN_ADX", 28),
  FVVO_STRONG_TREND_HOLD_MIN_FVVO: envNum("FVVO_STRONG_TREND_HOLD_MIN_FVVO", 0),
  FVVO_STRONG_TREND_HOLD_MAX_NEG_SLOPE: envNum("FVVO_STRONG_TREND_HOLD_MAX_NEG_SLOPE", -0.60),

  BAR_DEDUP_ENABLED: envBool("BAR_DEDUP_ENABLED", true),
  HISTORY_MAX_BARS: envNum("HISTORY_MAX_BARS", 120)
};

if (CFG.LIVE_FORWARD_ALLOWED) {
  console.log("⚠️ SAFETY: LIVE_FORWARD_ALLOWED=true is not supported in v1f. Forcing false.");
  CFG.LIVE_FORWARD_ALLOWED = false;
}

if (CFG.ENABLE_HTTP_FORWARD && !CFG.DEMO_FORWARD_ALLOWED) {
  console.log("⚠️ SAFETY: ENABLE_HTTP_FORWARD=true but DEMO_FORWARD_ALLOWED is not true. Forwarding disabled.");
  CFG.ENABLE_HTTP_FORWARD = false;
}

if (!CFG.ENABLE_HTTP_FORWARD) CFG.SHADOW_ONLY = true;
if (CFG.ENABLE_HTTP_FORWARD && CFG.DEMO_FORWARD_ALLOWED) CFG.SHADOW_ONLY = false;

const app = express();
app.use(express.json({ limit: "2mb", type: ["application/json", "text/plain", "*/*"] }));

const state = {
  startedAt: new Date().toISOString(),
  positions: new Map(),
  lastFeature: new Map(),
  history: new Map(),
  seenBars: new Set(),
  barIndex: new Map(),
  lastExitBar: new Map(),
  lastForward: new Map(),
  externalDeals: new Map(),
  stats: {
    received: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    virtualLongOpens: 0,
    virtualLongExits: 0,
    washoutSignals: 0,
    washoutOpens: 0,
    washoutExits: 0,
    washoutPnlPct: 0,
    crossSignals: 0,
    crossOpens: 0,
    crossMomoOverrideSignals: 0,
    crossMomoOverrideOpens: 0,
    greenPulseAssistSignals: 0,
    greenPulseAssistOpens: 0,
    redPulseBlocks: 0,
    redPulseWarnings: 0,
    crossExits: 0,
    crossPnlPct: 0,
    risingSignals: 0,
    risingOpens: 0,
    risingExits: 0,
    risingPnlPct: 0,
    wins: 0,
    losses: 0,
    flats: 0,
    totalPnlPct: 0,
    bestPnlPct: null,
    worstPnlPct: null,
    bestRunupPct: null,
    redDotExits: 0,
    redPulseProfitExits: 0,
    backupExits: 0,
    intrabarHardStopExits: 0,
    closeMaxLossExits: 0,
    maxHoldExits: 0,
    givebackBlockedByStrongTrend: 0,
    forwardAttempts: 0,
    forwardSuccess: 0,
    forwardErrors: 0,
    forwardSkipped: 0,
    forwardDryRuns: 0,
    forwardEntries: 0,
    forwardExits: 0,
    feeAwareQuickTpExits: 0,
    softExitMinProfitBlocks: 0,
    externalDealEntryBlocks: 0
  }
};

function nowIso() {
  return new Date().toISOString();
}

function n(v, d = 4) {
  const x = Number(v);
  if (!Number.isFinite(x)) return "na";
  return x.toFixed(d);
}

function pct(v, d = 3) {
  const x = Number(v);
  if (!Number.isFinite(x)) return "na";
  const sign = x > 0 ? "+" : "";
  return `${sign}${x.toFixed(d)}%`;
}

function boolStr(v) {
  return v ? "true" : "false";
}

function safeNum(v, fallback = null) {
  if (v === undefined || v === null || v === "") return fallback;
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function safeBool(v, fallback = false) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return fallback;
}

function strFromPayload(v, fallback = "") {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  return s === "" ? fallback : s;
}

function calcPct(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || y === 0) return null;
  return ((x - y) / y) * 100;
}

function calcBelowPct(reference, value) {
  const r = Number(reference);
  const v = Number(value);
  if (!Number.isFinite(r) || !Number.isFinite(v) || r === 0) return null;
  if (v >= r) return 0;
  return ((r - v) / r) * 100;
}

function logLine(type, msg, obj = null) {
  const prefix = `${nowIso()} | ${CFG.BRAIN_NAME} | ${type}`;
  if (obj && CFG.DEBUG) console.log(`${prefix} | ${msg} | ${JSON.stringify(obj)}`);
  else console.log(`${prefix} | ${msg}`);
}

function getHistory(symbol) {
  return state.history.get(symbol) || [];
}

function pushHistory(p) {
  const arr = state.history.get(p.symbol) || [];
  arr.push(p);
  while (arr.length > CFG.HISTORY_MAX_BARS) arr.shift();
  state.history.set(p.symbol, arr);
}

function recentBarsIncludingCurrent(p, lookback) {
  const prev = getHistory(p.symbol);
  const combined = prev.concat([p]);
  const nBars = Math.max(1, Number(lookback) || 1);
  return combined.slice(-nBars);
}

function minOf(arr, key) {
  const vals = arr.map((x) => safeNum(x[key], null)).filter((x) => Number.isFinite(x));
  if (!vals.length) return null;
  return Math.min(...vals);
}

function recentRedPulse(p, barsBack) {
  const nBars = Math.max(0, Number(barsBack) || 0);
  if (nBars <= 0) return false;
  const bars = recentBarsIncludingCurrent(p, nBars);
  return bars.some((b) => b.fvvoRedPulse === true || b.fvvoRedDot === true);
}

function recentGreenPulse(p, barsBack) {
  const nBars = Math.max(0, Number(barsBack) || 0);
  if (nBars <= 0) return false;
  const bars = recentBarsIncludingCurrent(p, nBars);
  return bars.some((b) => b.fvvoGreenPulse === true || b.fvvoGreenDot === true);
}

function recentRedDot(p, barsBack) {
  // Backwards-compatible name. In v1f this means recent red pulse only.
  return recentRedPulse(p, barsBack);
}

function previousBar(symbol) {
  const arr = getHistory(symbol);
  if (!arr.length) return null;
  return arr[arr.length - 1];
}

function risingVsPrevious(p, key) {
  const prev = previousBar(p.symbol);
  if (!prev) return false;
  const pv = safeNum(prev[key], null);
  const cv = safeNum(p[key], null);
  if (!Number.isFinite(pv) || !Number.isFinite(cv)) return false;
  return cv > pv;
}

function twoBarRisingIncludingCurrent(p, key) {
  const arr = getHistory(p.symbol);
  if (arr.length < 2) return false;
  const prev2 = arr[arr.length - 2];
  const prev1 = arr[arr.length - 1];
  const a = safeNum(prev2[key], null);
  const b = safeNum(prev1[key], null);
  const c = safeNum(p[key], null);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return false;
  return c > b && b > a;
}

function nextBarNumber(symbol) {
  const current = state.barIndex.get(symbol) || 0;
  const next = current + 1;
  state.barIndex.set(symbol, next);
  return next;
}

function isEntryCooldownActive(symbol, barNo) {
  const lastExit = state.lastExitBar.get(symbol);
  if (!Number.isFinite(lastExit)) return false;
  return barNo - lastExit <= CFG.FVVO_ENTRY_COOLDOWN_BARS;
}

function splitTvSymbol(symbol) {
  const raw = String(symbol || CFG.SYMBOL);
  const parts = raw.split(":");
  if (parts.length >= 2) return { tv_exchange: parts[0], tv_instrument: parts.slice(1).join(":") };
  return { tv_exchange: envStr("C3_TV_EXCHANGE", "BINANCE"), tv_instrument: raw };
}

function truncText(s, max = 600) {
  const str = String(s || "");
  return str.length > max ? `${str.slice(0, max)}...` : str;
}

function getBotUuid(symbol) {
  const direct = CFG.SYMBOL_BOT_MAP[symbol];
  if (direct) return String(direct);
  const fallback = CFG.SYMBOL_BOT_MAP[CFG.SYMBOL];
  return fallback ? String(fallback) : "";
}

function shouldForwardSetup(setup) {
  if (setup === "CROSS_UP_CONFIRM") return CFG.FVVO_FORWARD_CROSS_ENABLED;
  if (setup === "WASHOUT_REVERSAL") return CFG.FVVO_FORWARD_WASHOUT_ENABLED;
  if (setup === "RISING_CONTINUATION") return CFG.FVVO_FORWARD_RISING_ENABLED;
  return false;
}

function isForwardDuplicate(key) {
  const now = Date.now();
  const last = state.lastForward.get(key) || 0;
  if (now - last < CFG.C3_FORWARD_DEDUP_MS) return true;
  state.lastForward.set(key, now);
  return false;
}

function build3CommasPayload(action, p, extra = {}) {
  const { tv_exchange, tv_instrument } = splitTvSymbol(p.symbol);
  const payload = {
    secret: CFG.C3_SIGNAL_SECRET,
    max_lag: String(CFG.C3_MAX_LAG_SEC),
    timestamp: nowIso(),
    trigger_price: String(p.close),
    tv_exchange,
    tv_instrument,
    action,
    bot_uuid: getBotUuid(p.symbol)
  };

  if (CFG.C3_ORDER_AMOUNT_QUOTE > 0) {
    payload.order = { amount: CFG.C3_ORDER_AMOUNT_QUOTE, currency_type: "quote" };
  }

  payload.brain_note = {
    brain: CFG.BRAIN_NAME,
    setup: extra.setup || "",
    reason: extra.reason || "",
    symbol: p.symbol,
    tf: p.tf,
    momentumOverride: Boolean(extra.momentumOverride)
  };

  return payload;
}

async function forwardTo3Commas(action, p, extra = {}) {
  const setup = extra.setup || "UNKNOWN";
  const reason = extra.reason || "UNKNOWN";
  const botUuid = getBotUuid(p.symbol);
  const dedupKey = `${action}|${p.symbol}|${p.time}|${setup}`;

  if (!CFG.ENABLE_HTTP_FORWARD || CFG.SHADOW_ONLY) {
    state.stats.forwardSkipped += 1;
    logLine("C3_FORWARD_SKIP", `reason=FORWARD_DISABLED | action=${action} | setup=${setup} | symbol=${p.symbol} | shadowOnly=${CFG.SHADOW_ONLY} | enableForward=${CFG.ENABLE_HTTP_FORWARD}`);
    return { ok: false, skipped: true, reason: "FORWARD_DISABLED" };
  }

  if (!CFG.DEMO_FORWARD_ALLOWED || CFG.LIVE_FORWARD_ALLOWED) {
    state.stats.forwardSkipped += 1;
    logLine("C3_FORWARD_SKIP", `reason=SAFETY_GATE_BLOCK | action=${action} | setup=${setup} | demoAllowed=${CFG.DEMO_FORWARD_ALLOWED} | liveAllowed=${CFG.LIVE_FORWARD_ALLOWED}`);
    return { ok: false, skipped: true, reason: "SAFETY_GATE_BLOCK" };
  }

  if (!CFG.C3_SIGNAL_SECRET) {
    state.stats.forwardErrors += 1;
    logLine("C3_FORWARD_ERROR", `reason=MISSING_C3_SIGNAL_SECRET | action=${action} | setup=${setup}`);
    return { ok: false, error: "MISSING_C3_SIGNAL_SECRET" };
  }

  if (!botUuid) {
    state.stats.forwardErrors += 1;
    logLine("C3_FORWARD_ERROR", `reason=MISSING_BOT_UUID | action=${action} | setup=${setup} | symbol=${p.symbol}`);
    return { ok: false, error: "MISSING_BOT_UUID" };
  }

  if (isForwardDuplicate(dedupKey)) {
    state.stats.forwardSkipped += 1;
    logLine("C3_FORWARD_SKIP", `reason=FORWARD_DEDUP | action=${action} | setup=${setup} | symbol=${p.symbol} | time=${p.time}`);
    return { ok: false, skipped: true, reason: "FORWARD_DEDUP" };
  }

  const payload = build3CommasPayload(action, p, extra);
  const safePayload = { ...payload, secret: "***", bot_uuid: "***" };
  state.stats.forwardAttempts += 1;

  if (CFG.C3_DRY_RUN) {
    state.stats.forwardDryRuns += 1;
    logLine("C3_FORWARD_DRY_RUN", `action=${action} | setup=${setup} | reason=${reason} | symbol=${p.symbol} | price=${n(p.close, 4)} | payload=${JSON.stringify(safePayload)}`);
    return { ok: true, dryRun: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.C3_REQUEST_TIMEOUT_MS);

  try {
    logLine("C3_FORWARD_SEND", `action=${action} | setup=${setup} | reason=${reason} | symbol=${p.symbol} | price=${n(p.close, 4)} | momentumOverride=${boolStr(extra.momentumOverride)} | botUuid=${botUuid.slice(0, 8)}...`);

    const response = await fetch(CFG.C3_SIGNAL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const text = await response.text();

    if (!response.ok) {
      state.stats.forwardErrors += 1;
      logLine("C3_FORWARD_ERROR", `status=${response.status} | action=${action} | setup=${setup} | response=${truncText(text)}`);
      return { ok: false, status: response.status, body: text };
    }

    state.stats.forwardSuccess += 1;
    if (action === "enter_long") state.stats.forwardEntries += 1;
    if (action === "exit_long") state.stats.forwardExits += 1;

    logLine("C3_FORWARD_SUCCESS", `status=${response.status} | action=${action} | setup=${setup} | symbol=${p.symbol} | price=${n(p.close, 4)} | response=${truncText(text)}`);
    return { ok: true, status: response.status, body: text };
  } catch (err) {
    state.stats.forwardErrors += 1;
    logLine("C3_FORWARD_ERROR", `action=${action} | setup=${setup} | error=${err.name || "ERROR"}:${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function normalizePayload(body) {
  let raw = body || {};
  if (typeof raw === "string") {
    raw = raw.trim();
    if (!raw) raw = {};
    else raw = JSON.parse(raw);
  }

  const symbol = strFromPayload(raw.symbol, CFG.SYMBOL);
  const tf = strFromPayload(raw.tf, CFG.ENTRY_TF);
  const event = strFromPayload(raw.event, "");

  const close = safeNum(raw.close, safeNum(raw.price, null));
  const price = safeNum(raw.price, close);
  const open = safeNum(raw.open, close);
  const high = safeNum(raw.high, close);
  const low = safeNum(raw.low, close);

  const ema8 = safeNum(raw.ema8, null);
  const ema18 = safeNum(raw.ema18, null);
  const ema50 = safeNum(raw.ema50, null);
  const rsi = safeNum(raw.rsi, null);
  const adx = safeNum(raw.adx, null);
  const atrPct = safeNum(raw.atrPct, null);

  const fvvoValue = safeNum(raw.fvvoValue, null);
  const fvvoSignal = safeNum(raw.fvvoSignal, null);
  const last = state.lastFeature.get(symbol);
  const prevFvvoValue = last ? last.fvvoValue : null;

  let fvvoSlope = safeNum(raw.fvvoSlope, null);
  if (fvvoSlope === null && fvvoValue !== null && prevFvvoValue !== null) fvvoSlope = fvvoValue - prevFvvoValue;

  let fvvoAboveZero = safeBool(raw.fvvoAboveZero, false);
  if (fvvoValue !== null) fvvoAboveZero = fvvoValue > 0;

  let fvvoCrossUp = safeBool(raw.fvvoCrossUp, false);
  let fvvoCrossDown = safeBool(raw.fvvoCrossDown, false);
  if (fvvoValue !== null && prevFvvoValue !== null) {
    fvvoCrossUp = prevFvvoValue <= 0 && fvvoValue > 0;
    fvvoCrossDown = prevFvvoValue >= 0 && fvvoValue < 0;
  }

  // v1f: publisher sends raw active state and one-candle pulse state.
  // Only pulses are allowed into trade logic; raw active state is logged only.
  const fvvoRedActive = safeBool(raw.fvvoRedActive, safeBool(raw.fvvoRedDotActive, false));
  const fvvoGreenActive = safeBool(raw.fvvoGreenActive, safeBool(raw.fvvoGreenDotActive, false));
  const fvvoRedPulse = safeBool(raw.fvvoRedPulse, safeBool(raw.fvvoRedDotPulse, false));
  const fvvoGreenPulse = safeBool(raw.fvvoGreenPulse, safeBool(raw.fvvoGreenDotPulse, false));
  const fvvoRedDotLegacy = safeBool(raw.fvvoRedDot, false);
  const fvvoGreenDotLegacy = safeBool(raw.fvvoGreenDot, false);

  const pulseLogicEnabled = CFG.FVVO_PULSE_LOGIC_ENABLED && CFG.FVVO_DOT_PULSE_USE_IN_LOGIC;
  const fvvoRedDot = pulseLogicEnabled ? fvvoRedPulse : false;
  const fvvoGreenDot = pulseLogicEnabled ? fvvoGreenPulse : false;
  const fvvoBullishColor = safeBool(raw.fvvoBullishColor, false) || (CFG.FVVO_WASHOUT_ALLOW_GREEN_DOT && fvvoGreenDot);

  return {
    raw,
    secret: strFromPayload(raw.secret, ""),
    src: strFromPayload(raw.src, ""),
    brain: strFromPayload(raw.brain, ""),
    version: strFromPayload(raw.version, ""),
    symbol,
    tf,
    event,
    price,
    time: strFromPayload(raw.time, nowIso()),
    open,
    high,
    low,
    close,
    ema8,
    ema18,
    ema50,
    rsi,
    adx,
    atrPct,
    fvvoValue,
    fvvoSignal,
    fvvoAboveZero,
    fvvoSlope,
    fvvoCrossUp,
    fvvoCrossDown,
    fvvoRedDot,
    fvvoGreenDot,
    fvvoRedActive,
    fvvoGreenActive,
    fvvoRedPulse,
    fvvoGreenPulse,
    fvvoRedDotLegacy,
    fvvoGreenDotLegacy,
    fvvoBullishColor,
    fvvoBearishColor: safeBool(raw.fvvoBearishColor, false),
    sniperBuy: safeBool(raw.sniperBuy, false),
    sniperSell: safeBool(raw.sniperSell, false),
    burstBullish: safeBool(raw.burstBullish, false),
    burstBearish: safeBool(raw.burstBearish, false)
  };
}

function validatePayload(p) {
  if (!p) return { ok: false, reason: "EMPTY_PAYLOAD" };
  if (CFG.WEBHOOK_SECRET && CFG.WEBHOOK_SECRET !== "CHANGE_ME_TO_RANDOM_SECRET") {
    if (p.secret !== CFG.WEBHOOK_SECRET) return { ok: false, reason: "BAD_SECRET" };
  }
  if (p.symbol !== CFG.SYMBOL) return { ok: false, reason: `SYMBOL_MISMATCH:${p.symbol}` };
  if (p.tf !== CFG.ENTRY_TF) return { ok: false, reason: `TF_MISMATCH:${p.tf}` };
  if (p.event !== "FEATURE_5M_FVVO") return { ok: false, reason: `UNSUPPORTED_EVENT:${p.event}` };
  if (!Number.isFinite(p.close) || p.close <= 0) return { ok: false, reason: "BAD_CLOSE" };
  if (!Number.isFinite(p.ema8) || !Number.isFinite(p.ema18)) return { ok: false, reason: "MISSING_EMA8_OR_EMA18" };
  if (!Number.isFinite(p.rsi)) return { ok: false, reason: "MISSING_RSI" };
  if (!Number.isFinite(p.fvvoValue)) return { ok: false, reason: "MISSING_FVVO_VALUE" };
  return { ok: true, reason: "OK" };
}

function isDuplicateBar(p) {
  if (!CFG.BAR_DEDUP_ENABLED) return false;
  const key = `${p.symbol}|${p.tf}|${p.time}`;
  if (state.seenBars.has(key)) return true;
  state.seenBars.add(key);
  if (state.seenBars.size > 5000) {
    const arr = Array.from(state.seenBars);
    state.seenBars = new Set(arr.slice(arr.length - 2500));
  }
  return false;
}

function evaluateWashoutEntry(p) {
  const setup = "WASHOUT_REVERSAL";
  if (!CFG.FVVO_LONG_ENABLED) return { ok: false, setup, reason: "FVVO_LONG_DISABLED", momentumOverride: false };
  if (!CFG.FVVO_WASHOUT_ENABLED) return { ok: false, setup, reason: "FVVO_WASHOUT_DISABLED", momentumOverride: false };

  const bars = recentBarsIncludingCurrent(p, CFG.FVVO_WASHOUT_LOOKBACK_BARS);
  const recentRsiLow = minOf(bars, "rsi");
  const recentFvvoLow = minOf(bars, "fvvoValue");
  const recentLow = minOf(bars, "low");
  const prev = previousBar(p.symbol);
  const prevRsi = prev ? safeNum(prev.rsi, null) : null;
  const prevHigh = prev ? safeNum(prev.high, null) : null;

  const rsiWasWashedOut = Number.isFinite(recentRsiLow) && recentRsiLow <= CFG.FVVO_WASHOUT_RSI_MAX;
  const rsiRecovering = Number.isFinite(p.rsi) && p.rsi >= CFG.FVVO_WASHOUT_RSI_RECOVER_MIN && (!Number.isFinite(prevRsi) || p.rsi >= prevRsi);
  const fvvoWasDeep = Number.isFinite(recentFvvoLow) && recentFvvoLow <= CFG.FVVO_WASHOUT_MIN_DEEP_NEGATIVE;
  const currentFvvoNotLate = Number.isFinite(p.fvvoValue) && p.fvvoValue <= CFG.FVVO_WASHOUT_MAX_CURRENT_FVVO;

  const greenDotOk = CFG.FVVO_WASHOUT_ALLOW_GREEN_DOT && p.fvvoGreenDot === true;
  const bullishColorOk = CFG.FVVO_WASHOUT_ALLOW_GREEN_DOT && p.fvvoBullishColor === true;
  const fvvoSlopeStrong = Number.isFinite(p.fvvoSlope) && p.fvvoSlope >= CFG.FVVO_WASHOUT_MIN_SLOPE;
  const fvvoRising = risingVsPrevious(p, "fvvoValue") || twoBarRisingIncludingCurrent(p, "fvvoValue");
  const fvvoRecovery = greenDotOk || bullishColorOk || fvvoSlopeStrong || fvvoRising;

  const closeBelowEma8Pct = calcBelowPct(p.ema8, p.close);
  const extEma8Pct = calcPct(p.close, p.ema8);
  const extEma18Pct = calcPct(p.close, p.ema18);
  const notTooFarBelowEma8 = Number.isFinite(closeBelowEma8Pct) && closeBelowEma8Pct <= CFG.FVVO_WASHOUT_MAX_BELOW_EMA8_PCT;
  const notTooExtendedFromEma8 = Number.isFinite(extEma8Pct) && extEma8Pct <= CFG.FVVO_WASHOUT_MAX_EXT_EMA8_PCT;
  const notTooExtendedFromEma18 = Number.isFinite(extEma18Pct) && extEma18Pct <= CFG.FVVO_WASHOUT_MAX_EXT_EMA18_PCT;

  const bullishCandle = Number.isFinite(p.open) && p.close > p.open;
  const closeAbovePrevHigh = Number.isFinite(prevHigh) && p.close > prevHigh;
  const closeReclaimEma8 = p.close >= p.ema8;
  const priceConfirm = !CFG.FVVO_WASHOUT_REQUIRE_PRICE_CONFIRM || bullishCandle || closeAbovePrevHigh || closeReclaimEma8;

  const freshBreakdownLow = CFG.FVVO_WASHOUT_BLOCK_FRESH_LOW && Number.isFinite(recentLow) && Number.isFinite(p.low) && p.low <= recentLow && !bullishCandle && !closeReclaimEma8;
  const noBearishConflict = !p.fvvoBearishColor || greenDotOk || bullishColorOk || fvvoSlopeStrong;

  const ok = rsiWasWashedOut && rsiRecovering && fvvoWasDeep && currentFvvoNotLate && fvvoRecovery && notTooFarBelowEma8 && notTooExtendedFromEma8 && notTooExtendedFromEma18 && priceConfirm && !freshBreakdownLow && noBearishConflict;

  const checks = { setup, rsiWasWashedOut, rsiRecovering, fvvoWasDeep, currentFvvoNotLate, greenDotOk, bullishColorOk, fvvoSlopeStrong, fvvoRising, fvvoRecovery, closeBelowEma8Pct, extEma8Pct, extEma18Pct, notTooFarBelowEma8, notTooExtendedFromEma8, notTooExtendedFromEma18, bullishCandle, closeAbovePrevHigh, closeReclaimEma8, priceConfirm, freshBreakdownLow, noBearishConflict, recentRsiLow, recentFvvoLow, recentLow, prevRsi };

  let reason = "NO_WASHOUT_ENTRY";
  if (ok) {
    if (greenDotOk) reason = "FVVO_WASHOUT_GREEN_DOT";
    else if (bullishColorOk) reason = "FVVO_WASHOUT_BULLISH_COLOR";
    else if (fvvoSlopeStrong) reason = "FVVO_WASHOUT_SLOPE_RECOVERY";
    else reason = "FVVO_WASHOUT_RISING";
  } else {
    const failed = [];
    if (!rsiWasWashedOut) failed.push("NO_RSI_WASHOUT");
    if (!rsiRecovering) failed.push("RSI_NOT_RECOVERING");
    if (!fvvoWasDeep) failed.push("FVVO_NOT_DEEP_NEGATIVE");
    if (!currentFvvoNotLate) failed.push("FVVO_RECOVERY_TOO_LATE");
    if (!fvvoRecovery) failed.push("FVVO_NOT_RECOVERING");
    if (!notTooFarBelowEma8) failed.push("PRICE_TOO_FAR_BELOW_EMA8");
    if (!notTooExtendedFromEma8) failed.push("TOO_EXTENDED_EMA8");
    if (!notTooExtendedFromEma18) failed.push("TOO_EXTENDED_EMA18");
    if (!priceConfirm) failed.push("NO_PRICE_CONFIRM");
    if (freshBreakdownLow) failed.push("FRESH_BREAKDOWN_LOW");
    if (!noBearishConflict) failed.push("FVVO_BEARISH_CONFLICT");
    reason = failed.join("+") || "NO_WASHOUT_ENTRY";
  }

  return { ok, setup, reason, checks, momentumOverride: false };
}

function evaluateCrossEntry(p) {
  const setup = "CROSS_UP_CONFIRM";
  if (!CFG.FVVO_LONG_ENABLED) return { ok: false, setup, reason: "FVVO_LONG_DISABLED", momentumOverride: false, checks: {} };
  if (!CFG.FVVO_CROSS_ENABLED) return { ok: false, setup, reason: "FVVO_CROSS_DISABLED", momentumOverride: false, checks: {} };

  const fvvoCrossOk = p.fvvoCrossUp && p.fvvoAboveZero && p.fvvoValue > 0;
  const slopeOk = Number.isFinite(p.fvvoSlope) && p.fvvoSlope >= CFG.FVVO_CROSS_MIN_SLOPE;
  const rsiOk = Number.isFinite(p.rsi) && p.rsi >= CFG.FVVO_CROSS_MIN_RSI;
  const priceAboveEma8 = p.close > p.ema8;

  const ema8BelowEma18Pct = p.ema8 < p.ema18 ? calcPct(p.ema18, p.ema8) : 0;
  const emaStructureOk = p.ema8 >= p.ema18 || (Number.isFinite(ema8BelowEma18Pct) && ema8BelowEma18Pct <= CFG.FVVO_CROSS_ALLOW_EMA8_BELOW_EMA18_PCT);

  const extEma8Pct = calcPct(p.close, p.ema8);
  const extEma18Pct = calcPct(p.close, p.ema18);
  const normalExtEma8Ok = Number.isFinite(extEma8Pct) && extEma8Pct <= CFG.FVVO_CROSS_MAX_EXT_EMA8_PCT;
  const normalExtEma18Ok = Number.isFinite(extEma18Pct) && extEma18Pct <= CFG.FVVO_CROSS_MAX_EXT_EMA18_PCT;

  const momoSlopeOk = Number.isFinite(p.fvvoSlope) && p.fvvoSlope >= CFG.FVVO_CROSS_MOMO_MIN_SLOPE;
  const momoRsiOk = Number.isFinite(p.rsi) && p.rsi >= CFG.FVVO_CROSS_MOMO_MIN_RSI && p.rsi <= CFG.FVVO_CROSS_MOMO_MAX_RSI;
  const momoAdxOk = CFG.FVVO_CROSS_MOMO_MIN_ADX <= 0 || (Number.isFinite(p.adx) && p.adx >= CFG.FVVO_CROSS_MOMO_MIN_ADX);
  const momoExtEma8Ok = Number.isFinite(extEma8Pct) && extEma8Pct <= CFG.FVVO_CROSS_MOMO_MAX_EXT_EMA8_PCT;
  const momoExtEma18Ok = Number.isFinite(extEma18Pct) && extEma18Pct <= CFG.FVVO_CROSS_MOMO_MAX_EXT_EMA18_PCT;

  const momentumOverride = CFG.FVVO_CROSS_MOMO_OVERRIDE_ENABLED && fvvoCrossOk && momoSlopeOk && momoRsiOk && momoAdxOk && momoExtEma8Ok && momoExtEma18Ok;
  const extOk = (normalExtEma8Ok && normalExtEma18Ok) || momentumOverride;

  const recentRedDotBlocked = CFG.FVVO_RED_PULSE_BLOCK_BARS > 0 && recentRedPulse(p, CFG.FVVO_RED_PULSE_BLOCK_BARS);
  const recentGreenPulseMemory = CFG.FVVO_GREEN_PULSE_MEMORY_BARS > 0 && recentGreenPulse(p, CFG.FVVO_GREEN_PULSE_MEMORY_BARS);

  const greenAssistSlopeOk = Number.isFinite(p.fvvoSlope) && p.fvvoSlope >= CFG.FVVO_GREEN_PULSE_CROSS_MIN_SLOPE;
  const greenAssistRsiOk = Number.isFinite(p.rsi) && p.rsi >= CFG.FVVO_GREEN_PULSE_CROSS_MIN_RSI;
  const greenAssistAdxOk = CFG.FVVO_GREEN_PULSE_CROSS_MIN_ADX <= 0 || (Number.isFinite(p.adx) && p.adx >= CFG.FVVO_GREEN_PULSE_CROSS_MIN_ADX);
  const greenAssistExtEma8Ok = Number.isFinite(extEma8Pct) && extEma8Pct <= CFG.FVVO_GREEN_PULSE_CROSS_MAX_EXT_EMA8_PCT;
  const greenAssistExtEma18Ok = Number.isFinite(extEma18Pct) && extEma18Pct <= CFG.FVVO_GREEN_PULSE_CROSS_MAX_EXT_EMA18_PCT;
  const greenPulseAssist = CFG.FVVO_GREEN_PULSE_CROSS_ASSIST_ENABLED && recentGreenPulseMemory && fvvoCrossOk && greenAssistSlopeOk && greenAssistRsiOk && greenAssistAdxOk && priceAboveEma8 && emaStructureOk && greenAssistExtEma8Ok && greenAssistExtEma18Ok;

  const noBearishConflict = !p.fvvoBearishColor || p.fvvoCrossUp || p.burstBullish || greenPulseAssist;

  const normalOk = fvvoCrossOk && slopeOk && rsiOk && priceAboveEma8 && emaStructureOk && extOk && noBearishConflict;
  const ok = (normalOk || greenPulseAssist) && !recentRedDotBlocked;

  const checks = { setup, fvvoCrossOk, slopeOk, rsiOk, priceAboveEma8, emaStructureOk, normalExtEma8Ok, normalExtEma18Ok, momentumOverride, momoSlopeOk, momoRsiOk, momoAdxOk, momoExtEma8Ok, momoExtEma18Ok, extOk, recentRedDotBlocked, recentGreenPulseMemory, greenPulseAssist, greenAssistSlopeOk, greenAssistRsiOk, greenAssistAdxOk, greenAssistExtEma8Ok, greenAssistExtEma18Ok, noBearishConflict, extEma8Pct, extEma18Pct, ema8BelowEma18Pct, rsi: p.rsi, adx: p.adx, fvvoSlope: p.fvvoSlope };

  let reason = "NO_CROSS_ENTRY";
  if (ok) {
    if (greenPulseAssist && !normalOk) reason = "FVVO_CROSS_UP_GREEN_PULSE_ASSIST";
    else if (recentGreenPulseMemory) reason = momentumOverride ? "FVVO_CROSS_UP_MOMO_GREEN_MEMORY" : "FVVO_CROSS_UP_CONFIRM_GREEN_MEMORY";
    else reason = momentumOverride ? "FVVO_CROSS_UP_MOMENTUM_OVERRIDE" : "FVVO_CROSS_UP_CONFIRM";
  } else {
    const failed = [];
    if (!fvvoCrossOk) failed.push("NO_FRESH_CROSS_UP");
    if (!slopeOk) failed.push("SLOPE_TOO_WEAK");
    if (!rsiOk) failed.push("RSI_TOO_LOW");
    if (!priceAboveEma8) failed.push("PRICE_NOT_ABOVE_EMA8");
    if (!emaStructureOk) failed.push("EMA8_TOO_FAR_BELOW_EMA18");
    if (!extOk) {
      if (!normalExtEma8Ok && !momoExtEma8Ok) failed.push("TOO_EXTENDED_EMA8");
      if (!normalExtEma18Ok && !momoExtEma18Ok) failed.push("TOO_EXTENDED_EMA18");
      if (CFG.FVVO_CROSS_MOMO_OVERRIDE_ENABLED && !momentumOverride) failed.push("MOMO_OVERRIDE_NOT_MET");
    }
    if (recentRedDotBlocked) failed.push("RECENT_RED_PULSE_BLOCK");
    if (recentGreenPulseMemory && !greenPulseAssist && CFG.FVVO_GREEN_PULSE_CROSS_ASSIST_ENABLED) failed.push("GREEN_PULSE_ASSIST_NOT_MET");
    if (!noBearishConflict) failed.push("FVVO_BEARISH_CONFLICT");
    reason = failed.join("+") || "NO_CROSS_ENTRY";
  }

  return { ok, setup, reason, checks, momentumOverride };
}

function evaluateRisingContinuationEntry(p) {
  const setup = "RISING_CONTINUATION";
  if (!CFG.FVVO_LONG_ENABLED) return { ok: false, setup, reason: "FVVO_LONG_DISABLED", momentumOverride: false, checks: {} };
  if (!CFG.FVVO_RISING_CONT_ENABLED) return { ok: false, setup, reason: "FVVO_RISING_CONT_DISABLED", momentumOverride: false, checks: {} };

  const fvvoOk = p.fvvoAboveZero && !p.fvvoCrossUp && Number.isFinite(p.fvvoSlope) && p.fvvoSlope >= CFG.FVVO_RISING_MIN_SLOPE;
  const rsiOk = Number.isFinite(p.rsi) && p.rsi >= CFG.FVVO_RISING_MIN_RSI;
  const priceAboveEma8 = p.close > p.ema8;
  const extEma8Pct = calcPct(p.close, p.ema8);
  const extEma18Pct = calcPct(p.close, p.ema18);
  const notTooExtendedFromEma8 = Number.isFinite(extEma8Pct) && extEma8Pct <= CFG.FVVO_RISING_MAX_EXT_EMA8_PCT;
  const notTooExtendedFromEma18 = Number.isFinite(extEma18Pct) && extEma18Pct <= CFG.FVVO_RISING_MAX_EXT_EMA18_PCT;
  const noRecentRedDot = !recentRedPulse(p, CFG.FVVO_RED_PULSE_BLOCK_BARS);
  const noBearishConflict = !p.fvvoBearishColor || p.burstBullish;

  const ok = fvvoOk && rsiOk && priceAboveEma8 && notTooExtendedFromEma8 && notTooExtendedFromEma18 && noRecentRedDot && noBearishConflict;
  const checks = { setup, fvvoOk, rsiOk, priceAboveEma8, notTooExtendedFromEma8, notTooExtendedFromEma18, noRecentRedDot, noBearishConflict, extEma8Pct, extEma18Pct };

  let reason = "NO_RISING_CONT_ENTRY";
  if (ok) reason = "FVVO_STRICT_ABOVE_ZERO_RISING";
  else {
    const failed = [];
    if (!fvvoOk) failed.push("FVVO_RISING_NOT_STRONG");
    if (!rsiOk) failed.push("RSI_TOO_LOW");
    if (!priceAboveEma8) failed.push("PRICE_NOT_ABOVE_EMA8");
    if (!notTooExtendedFromEma8) failed.push("TOO_EXTENDED_EMA8");
    if (!notTooExtendedFromEma18) failed.push("TOO_EXTENDED_EMA18");
    if (!noRecentRedDot) failed.push("RECENT_RED_PULSE_BLOCK");
    if (!noBearishConflict) failed.push("FVVO_BEARISH_CONFLICT");
    reason = failed.join("+") || "NO_RISING_CONT_ENTRY";
  }

  return { ok, setup, reason, checks, momentumOverride: false };
}

function setupPrefix(setup) {
  if (setup === "WASHOUT_REVERSAL") return "FVVO_WASHOUT";
  if (setup === "CROSS_UP_CONFIRM") return "FVVO_CROSS";
  return "FVVO_RISING";
}

async function openVirtualLong(p, decision, barNo) {
  const position = {
    side: "LONG",
    setup: decision.setup,
    symbol: p.symbol,
    tf: p.tf,
    entryBarNo: barNo,
    entryPrice: p.close,
    entryTime: p.time,
    entryReceivedAt: nowIso(),
    entryReason: decision.reason,
    entryMomentumOverride: Boolean(decision.momentumOverride),
    entryFvvoValue: p.fvvoValue,
    entryFvvoSignal: p.fvvoSignal,
    entryFvvoSlope: p.fvvoSlope,
    entryRsi: p.rsi,
    entryAdx: p.adx,
    entryEma8: p.ema8,
    entryEma18: p.ema18,
    barsHeld: 0,
    maxPrice: p.close,
    minPrice: p.close,
    peakPnlPct: 0,
    maxDrawdownPct: 0,
    stopPrice: CFG.FVVO_MAX_LOSS_EXIT_PCT > 0 ? p.close * (1 - Math.abs(CFG.FVVO_MAX_LOSS_EXIT_PCT) / 100) : null,
    redDotSeen: false,
    greenDotAtEntry: p.fvvoGreenDot,
    greenPulseMemoryAtEntry: decision.checks ? Boolean(decision.checks.recentGreenPulseMemory) : false,
    greenPulseAssistAtEntry: decision.checks ? Boolean(decision.checks.greenPulseAssist) : false,
    forwardedEntry: false,
    forwardEntryStatus: "NOT_FORWARDED",
    backupUsed: false
  };

  state.positions.set(p.symbol, position);
  state.stats.virtualLongOpens += 1;
  if (decision.setup === "WASHOUT_REVERSAL") state.stats.washoutOpens += 1;
  if (decision.setup === "CROSS_UP_CONFIRM") {
    state.stats.crossOpens += 1;
    if (decision.momentumOverride) state.stats.crossMomoOverrideOpens += 1;
    if (decision.checks && decision.checks.greenPulseAssist) state.stats.greenPulseAssistOpens += 1;
  }
  if (decision.setup === "RISING_CONTINUATION") state.stats.risingOpens += 1;

  logLine(`${setupPrefix(decision.setup)}_LONG_OPEN`, [
    `🟢 setup=${decision.setup}`,
    `symbol=${p.symbol}`,
    `price=${n(p.close, 4)}`,
    `stop=${position.stopPrice === null ? "na" : n(position.stopPrice, 4)}`,
    `reason=${decision.reason}`,
    `momentumOverride=${boolStr(decision.momentumOverride)}`,
    `greenPulseMemory=${boolStr(decision.checks && decision.checks.recentGreenPulseMemory)}`,
    `greenPulseAssist=${boolStr(decision.checks && decision.checks.greenPulseAssist)}`,
    `rsi=${n(p.rsi, 2)}`,
    `adx=${n(p.adx, 2)}`,
    `fvvo=${n(p.fvvoValue, 6)}`,
    `signal=${n(p.fvvoSignal, 6)}`,
    `slope=${n(p.fvvoSlope, 6)}`,
    `aboveZero=${boolStr(p.fvvoAboveZero)}`,
    `crossUp=${boolStr(p.fvvoCrossUp)}`,
    `redDot=${boolStr(p.fvvoRedDot)}`,
    `greenDot=${boolStr(p.fvvoGreenDot)}`,
    `redActive=${boolStr(p.fvvoRedActive)}`,
    `greenActive=${boolStr(p.fvvoGreenActive)}`,
    `redPulse=${boolStr(p.fvvoRedPulse)}`,
    `greenPulse=${boolStr(p.fvvoGreenPulse)}`,
    `bullishColor=${boolStr(p.fvvoBullishColor)}`,
    `forwardEligible=${boolStr(shouldForwardSetup(decision.setup))}`,
    `shadowOnly=${boolStr(CFG.SHADOW_ONLY)}`
  ].join(" | "), decision.checks);

  if (shouldForwardSetup(decision.setup)) {
    const result = await forwardTo3Commas("enter_long", p, { setup: decision.setup, reason: decision.reason, momentumOverride: decision.momentumOverride });
    position.forwardedEntry = result.ok === true && !result.dryRun;
    position.forwardEntryStatus = result.ok ? (result.dryRun ? "DRY_RUN" : "FORWARDED") : (result.skipped ? "SKIPPED" : "ERROR");
    if (CFG.FVVO_EXTERNAL_DEAL_LOCK_ENABLED && position.forwardedEntry) {
      state.externalDeals.set(p.symbol, {
        symbol: p.symbol,
        setup: decision.setup,
        entryPrice: p.close,
        entryTime: p.time,
        openedAt: nowIso(),
        brain: CFG.BRAIN_NAME
      });
      logLine("FVVO_EXTERNAL_DEAL_LOCK_SET", `symbol=${p.symbol} | setup=${decision.setup} | entry=${n(p.close, 4)} | reason=${decision.reason}`);
    }
  } else {
    state.stats.forwardSkipped += 1;
    position.forwardEntryStatus = "SETUP_NOT_FORWARD_ENABLED";
    logLine("C3_FORWARD_SKIP", `reason=SETUP_NOT_FORWARD_ENABLED | setup=${decision.setup} | symbol=${p.symbol} | entryReason=${decision.reason}`);
  }
}

function updatePositionStats(pos, p) {
  pos.barsHeld += 1;
  if (Number.isFinite(p.high) && p.high > pos.maxPrice) pos.maxPrice = p.high;
  if (Number.isFinite(p.low) && p.low < pos.minPrice) pos.minPrice = p.low;
  const currentPnlPct = calcPct(p.close, pos.entryPrice) || 0;
  const peakPnlPct = calcPct(pos.maxPrice, pos.entryPrice) || 0;
  const drawdownPct = calcPct(pos.minPrice, pos.entryPrice) || 0;
  pos.peakPnlPct = Math.max(pos.peakPnlPct, peakPnlPct);
  pos.maxDrawdownPct = Math.min(pos.maxDrawdownPct, drawdownPct);
  if (p.fvvoRedDot) pos.redDotSeen = true;
  return { currentPnlPct, peakPnlPct: pos.peakPnlPct, givebackPct: pos.peakPnlPct - currentPnlPct, drawdownPct: pos.maxDrawdownPct };
}

function isStrongTrendHold(pos, p, perf) {
  if (!CFG.FVVO_STRONG_TREND_HOLD_ENABLED) return false;
  const pnlPositive = perf.currentPnlPct > 0;
  const fvvoOk = p.fvvoAboveZero && Number.isFinite(p.fvvoValue) && p.fvvoValue >= CFG.FVVO_STRONG_TREND_HOLD_MIN_FVVO;
  const priceOk = p.close >= p.ema8;
  const rsiOk = Number.isFinite(p.rsi) && p.rsi >= CFG.FVVO_STRONG_TREND_HOLD_MIN_RSI;
  const adxOk = Number.isFinite(p.adx) && p.adx >= CFG.FVVO_STRONG_TREND_HOLD_MIN_ADX;
  const slopeOk = !Number.isFinite(p.fvvoSlope) || p.fvvoSlope >= CFG.FVVO_STRONG_TREND_HOLD_MAX_NEG_SLOPE;
  return pnlPositive && fvvoOk && priceOk && rsiOk && adxOk && slopeOk;
}

function evaluateLongExit(pos, p, perf) {
  const currentPnlPct = perf.currentPnlPct;
  const peakPnlPct = perf.peakPnlPct;
  const givebackPct = perf.givebackPct;
  const closeLostEma8 = p.close < p.ema8;
  const hardDownSlope = Number.isFinite(p.fvvoSlope) && p.fvvoSlope <= CFG.FVVO_HARD_DOWN_SLOPE;
  const strongTrendHold = isStrongTrendHold(pos, p, perf);

  const intrabarHardStopHit = CFG.FVVO_INTRABAR_HARD_STOP_ENABLED && Number.isFinite(pos.stopPrice) && Number.isFinite(p.low) && p.low <= pos.stopPrice;
  const closeMaxLossHit = currentPnlPct <= -Math.abs(CFG.FVVO_MAX_LOSS_EXIT_PCT);
  const quickTpExit = CFG.FVVO_QUICK_TP_ENABLED && pos.barsHeld >= CFG.FVVO_QUICK_TP_MIN_BARS && currentPnlPct >= CFG.FVVO_QUICK_TP_MIN_PCT;
  const softExitMinProfitOk = currentPnlPct >= CFG.FVVO_SOFT_EXIT_MIN_PROFIT_PCT;
  const givebackArm2 = peakPnlPct >= CFG.FVVO_GIVEBACK_ARM2_PCT && givebackPct >= CFG.FVVO_GIVEBACK_ARM2_DROP_PCT;
  const givebackArm1 = peakPnlPct >= CFG.FVVO_GIVEBACK_ARM1_PCT && givebackPct >= CFG.FVVO_GIVEBACK_ARM1_DROP_PCT;
  const backupNoRedDot = !pos.redDotSeen && !p.fvvoAboveZero && closeLostEma8 && currentPnlPct >= CFG.FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT && givebackPct >= CFG.FVVO_GIVEBACK_ARM1_DROP_PCT;
  const redPulseProfitOk = currentPnlPct >= CFG.FVVO_RED_PULSE_EXIT_MIN_PROFIT_PCT;
  const redPulseWeaknessOk = p.fvvoRedPulse && (hardDownSlope || closeLostEma8 || givebackPct >= CFG.FVVO_RED_PULSE_EXIT_MIN_GIVEBACK_PCT || (Number.isFinite(p.fvvoSlope) && p.fvvoSlope <= CFG.FVVO_RED_PULSE_EXIT_MAX_SLOPE));
  const redPulseProfitExit = CFG.FVVO_RED_PULSE_EXIT_ENABLED && p.fvvoRedPulse && redPulseProfitOk && redPulseWeaknessOk;
  const crossDownExit = p.fvvoCrossDown && currentPnlPct >= CFG.FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT;
  const hardSlopeExit = hardDownSlope && currentPnlPct >= CFG.FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT;
  const ema8LossProfitExit = closeLostEma8 && currentPnlPct >= CFG.FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT && givebackPct >= CFG.FVVO_GIVEBACK_ARM1_DROP_PCT;
  const maxHoldExit = CFG.FVVO_MAX_HOLD_BARS > 0 && pos.barsHeld >= CFG.FVVO_MAX_HOLD_BARS;

  if (intrabarHardStopHit) return { exit: true, reason: "FVVO_INTRABAR_HARD_STOP", backupUsed: true, exitPrice: pos.stopPrice, strongTrendHold };
  if (p.fvvoRedPulse && CFG.FVVO_RED_PULSE_EXIT_ENABLED) state.stats.redPulseWarnings += 1;
  if (redPulseProfitExit) return { exit: true, reason: "FVVO_RED_PULSE_PROFIT_WARNING", backupUsed: false, exitPrice: p.close, strongTrendHold };
  if (closeMaxLossHit) return { exit: true, reason: "FVVO_CLOSE_MAX_LOSS_EXIT", backupUsed: true, exitPrice: p.close, strongTrendHold };
  if (quickTpExit) return { exit: true, reason: "FVVO_FEE_AWARE_QUICK_TP", backupUsed: false, exitPrice: p.close, strongTrendHold };
  if (givebackArm2 && !strongTrendHold && softExitMinProfitOk) return { exit: true, reason: "FVVO_GIVEBACK_ARM2", backupUsed: true, exitPrice: p.close, strongTrendHold };
  if (givebackArm2 && !strongTrendHold && !softExitMinProfitOk) {
    state.stats.softExitMinProfitBlocks += 1;
    return { exit: false, reason: "HOLD_FEE_AWARE_MIN_PROFIT_BLOCK_GIVEBACK_ARM2", backupUsed: false, exitPrice: null, strongTrendHold };
  }
  if (givebackArm2 && strongTrendHold) {
    state.stats.givebackBlockedByStrongTrend += 1;
    return { exit: false, reason: "HOLD_STRONG_TREND_BLOCKED_GIVEBACK_ARM2", backupUsed: false, exitPrice: null, strongTrendHold };
  }
  if (givebackArm1 && !strongTrendHold && softExitMinProfitOk) return { exit: true, reason: "FVVO_GIVEBACK_ARM1", backupUsed: true, exitPrice: p.close, strongTrendHold };
  if (givebackArm1 && !strongTrendHold && !softExitMinProfitOk) {
    state.stats.softExitMinProfitBlocks += 1;
    return { exit: false, reason: "HOLD_FEE_AWARE_MIN_PROFIT_BLOCK_GIVEBACK_ARM1", backupUsed: false, exitPrice: null, strongTrendHold };
  }
  if (givebackArm1 && strongTrendHold) {
    state.stats.givebackBlockedByStrongTrend += 1;
    return { exit: false, reason: "HOLD_STRONG_TREND_BLOCKED_GIVEBACK_ARM1", backupUsed: false, exitPrice: null, strongTrendHold };
  }
  if (backupNoRedDot) return { exit: true, reason: "FVVO_NO_RED_DOT_BACKUP_ZERO_LOSS_EMA8_GIVEBACK", backupUsed: true, exitPrice: p.close, strongTrendHold };
  if (crossDownExit) return { exit: true, reason: "FVVO_CROSS_DOWN_BACKUP", backupUsed: true, exitPrice: p.close, strongTrendHold };
  if (hardSlopeExit) return { exit: true, reason: "FVVO_HARD_DOWN_SLOPE_BACKUP", backupUsed: true, exitPrice: p.close, strongTrendHold };
  if (ema8LossProfitExit) return { exit: true, reason: "FVVO_EMA8_LOSS_PROFIT_BACKUP", backupUsed: true, exitPrice: p.close, strongTrendHold };
  if (maxHoldExit) return { exit: true, reason: "FVVO_MAX_HOLD_BARS_EXIT", backupUsed: true, exitPrice: p.close, strongTrendHold };
  return { exit: false, reason: "HOLD", backupUsed: false, exitPrice: null, strongTrendHold };
}

async function closeVirtualLong(pos, p, perf, exitDecision, barNo) {
  const exitPrice = Number.isFinite(exitDecision.exitPrice) && exitDecision.exitPrice > 0 ? exitDecision.exitPrice : p.close;
  const pnlPct = calcPct(exitPrice, pos.entryPrice) || 0;
  const maxRunupPct = perf.peakPnlPct;
  const givebackPct = maxRunupPct - pnlPct;

  const shouldForwardExit = CFG.FVVO_FORWARD_EXIT_ENABLED && pos.forwardedEntry;
  if (shouldForwardExit) {
    const forwardExitResult = await forwardTo3Commas("exit_long", { ...p, close: exitPrice }, { setup: pos.setup, reason: exitDecision.reason, momentumOverride: pos.entryMomentumOverride });
    if (!forwardExitResult.ok && !forwardExitResult.dryRun) {
      logLine("C3_FORWARD_EXIT_HOLDING_VIRTUAL", [
        `reason=EXIT_FORWARD_NOT_CONFIRMED`,
        `symbol=${p.symbol}`,
        `setup=${pos.setup}`,
        `exitReason=${exitDecision.reason}`,
        `exitPrice=${n(exitPrice, 4)}`,
        `pnl=${pct(pnlPct)}`,
        `forwardStatus=${forwardExitResult.reason || "ERROR"}`
      ].join(" | "));
      return;
    }
    if (CFG.FVVO_EXTERNAL_DEAL_LOCK_ENABLED) {
      state.externalDeals.delete(pos.symbol);
      logLine("FVVO_EXTERNAL_DEAL_LOCK_CLEAR", `symbol=${p.symbol} | setup=${pos.setup} | exit=${n(exitPrice, 4)} | reason=${exitDecision.reason}`);
    }
  }

  state.positions.delete(pos.symbol);
  state.lastExitBar.set(pos.symbol, barNo);
  state.stats.virtualLongExits += 1;
  state.stats.totalPnlPct += pnlPct;

  if (pos.setup === "WASHOUT_REVERSAL") {
    state.stats.washoutExits += 1;
    state.stats.washoutPnlPct += pnlPct;
  }
  if (pos.setup === "CROSS_UP_CONFIRM") {
    state.stats.crossExits += 1;
    state.stats.crossPnlPct += pnlPct;
  }
  if (pos.setup === "RISING_CONTINUATION") {
    state.stats.risingExits += 1;
    state.stats.risingPnlPct += pnlPct;
  }

  if (pnlPct > 0.03) state.stats.wins += 1;
  else if (pnlPct < -0.03) state.stats.losses += 1;
  else state.stats.flats += 1;

  if (state.stats.bestPnlPct === null || pnlPct > state.stats.bestPnlPct) state.stats.bestPnlPct = pnlPct;
  if (state.stats.worstPnlPct === null || pnlPct < state.stats.worstPnlPct) state.stats.worstPnlPct = pnlPct;
  if (state.stats.bestRunupPct === null || maxRunupPct > state.stats.bestRunupPct) state.stats.bestRunupPct = maxRunupPct;

  if (exitDecision.reason === "FVVO_RED_DOT") state.stats.redDotExits += 1;
  if (exitDecision.reason === "FVVO_RED_PULSE_PROFIT_WARNING") state.stats.redPulseProfitExits += 1;
  if (exitDecision.backupUsed) state.stats.backupExits += 1;
  if (exitDecision.reason === "FVVO_INTRABAR_HARD_STOP") state.stats.intrabarHardStopExits += 1;
  if (exitDecision.reason === "FVVO_CLOSE_MAX_LOSS_EXIT") state.stats.closeMaxLossExits += 1;
  if (exitDecision.reason === "FVVO_MAX_HOLD_BARS_EXIT") state.stats.maxHoldExits += 1;
  if (exitDecision.reason === "FVVO_FEE_AWARE_QUICK_TP") state.stats.feeAwareQuickTpExits += 1;

  const result = pnlPct > 0.03 ? "WIN" : pnlPct < -0.03 ? "LOSS" : "FLAT";
  const prefix = setupPrefix(pos.setup);

  logLine(`${prefix}_LONG_EXIT_SIGNAL`, [
    `🔴 setup=${pos.setup}`,
    `symbol=${p.symbol}`,
    `exitPrice=${n(exitPrice, 4)}`,
    `close=${n(p.close, 4)}`,
    `low=${n(p.low, 4)}`,
    `stop=${pos.stopPrice === null ? "na" : n(pos.stopPrice, 4)}`,
    `pnl=${pct(pnlPct)}`,
    `netAfterFee=${pct(pnlPct - CFG.FVVO_FEE_ROUND_TRIP_PCT)}`,
    `peak=${pct(maxRunupPct)}`,
    `giveback=${pct(givebackPct)}`,
    `barsHeld=${pos.barsHeld}`,
    `reason=${exitDecision.reason}`,
    `strongTrendHold=${boolStr(exitDecision.strongTrendHold)}`,
    `entryMomentumOverride=${boolStr(pos.entryMomentumOverride)}`,
    `redDotSeen=${boolStr(pos.redDotSeen)}`,
    `greenDotAtEntry=${boolStr(pos.greenDotAtEntry)}`,
    `forwardedEntry=${boolStr(pos.forwardedEntry)}`,
    `forwardEntryStatus=${pos.forwardEntryStatus}`,
    `backupUsed=${boolStr(exitDecision.backupUsed)}`,
    `fvvo=${n(p.fvvoValue, 6)}`,
    `slope=${n(p.fvvoSlope, 6)}`,
    `aboveZero=${boolStr(p.fvvoAboveZero)}`,
    `crossDown=${boolStr(p.fvvoCrossDown)}`
  ].join(" | "));


  logLine(`${prefix}_LONG_RESULT`, [
    `📊 result=${result}`,
    `setup=${pos.setup}`,
    `symbol=${p.symbol}`,
    `entry=${n(pos.entryPrice, 4)}`,
    `exit=${n(exitPrice, 4)}`,
    `pnl=${pct(pnlPct)}`,
    `netAfterFee=${pct(pnlPct - CFG.FVVO_FEE_ROUND_TRIP_PCT)}`,
    `maxRunup=${pct(maxRunupPct)}`,
    `maxDrawdown=${pct(pos.maxDrawdownPct)}`,
    `entryReason=${pos.entryReason}`,
    `entryMomentumOverride=${boolStr(pos.entryMomentumOverride)}`,
    `exitReason=${exitDecision.reason}`,
    `strongTrendHold=${boolStr(exitDecision.strongTrendHold)}`,
    `redDotSeen=${boolStr(pos.redDotSeen)}`,
    `greenDotAtEntry=${boolStr(pos.greenDotAtEntry)}`,
    `forwardedEntry=${boolStr(pos.forwardedEntry)}`,
    `forwardEntryStatus=${pos.forwardEntryStatus}`,
    `backupUsed=${boolStr(exitDecision.backupUsed)}`,
    `barsHeld=${pos.barsHeld}`
  ].join(" | "));

  logScorecard();
}

function observeShortSignal(p) {
  if (CFG.FVVO_SHORT_ENABLED) return;
  const shortSignal =
    p.fvvoCrossDown ||
    p.fvvoRedDot ||
    p.fvvoRedPulse ||
    p.burstBearish ||
    p.sniperSell ||
    p.fvvoBearishColor;
  if (!shortSignal) return;
  logLine("FVVO_RAW_SHORT_SIGNAL", [
    `⚠️ observationOnly=true`,
    `symbol=${p.symbol}`,
    `price=${n(p.close, 4)}`,
    `redDot=${boolStr(p.fvvoRedDot)}`,
    `greenDot=${boolStr(p.fvvoGreenDot)}`,
    `redActive=${boolStr(p.fvvoRedActive)}`,
    `greenActive=${boolStr(p.fvvoGreenActive)}`,
    `redPulse=${boolStr(p.fvvoRedPulse)}`,
    `greenPulse=${boolStr(p.fvvoGreenPulse)}`,
    `crossDown=${boolStr(p.fvvoCrossDown)}`,
    `bearishColor=${boolStr(p.fvvoBearishColor)}`,
    `sniperSell=${boolStr(p.sniperSell)}`,
    `burstBearish=${boolStr(p.burstBearish)}`,
    `fvvo=${n(p.fvvoValue, 6)}`,
    `slope=${n(p.fvvoSlope, 6)}`
  ].join(" | "));
}

function avg(total, count) {
  return count > 0 ? total / count : 0;
}

function logScorecard() {
  const exits = state.stats.virtualLongExits;
  const avgPnl = avg(state.stats.totalPnlPct, exits);
  const winRate = exits > 0 ? (state.stats.wins / exits) * 100 : 0;
  const washoutAvg = avg(state.stats.washoutPnlPct, state.stats.washoutExits);
  const crossAvg = avg(state.stats.crossPnlPct, state.stats.crossExits);
  const risingAvg = avg(state.stats.risingPnlPct, state.stats.risingExits);

  logLine("FVVO_RAW_SCORECARD_RESULT", [
    `📈 trades=${exits}`,
    `wins=${state.stats.wins}`,
    `losses=${state.stats.losses}`,
    `flats=${state.stats.flats}`,
    `winRate=${pct(winRate, 1)}`,
    `avgPnl=${pct(avgPnl)}`,
    `totalPnl=${pct(state.stats.totalPnlPct)}`,
    `best=${state.stats.bestPnlPct === null ? "na" : pct(state.stats.bestPnlPct)}`,
    `worst=${state.stats.worstPnlPct === null ? "na" : pct(state.stats.worstPnlPct)}`,
    `bestRunup=${state.stats.bestRunupPct === null ? "na" : pct(state.stats.bestRunupPct)}`,
    `redDotExits=${state.stats.redDotExits}`,
    `redPulseProfitExits=${state.stats.redPulseProfitExits}`,
    `backupExits=${state.stats.backupExits}`,
    `intrabarHardStops=${state.stats.intrabarHardStopExits}`,
    `closeMaxLossExits=${state.stats.closeMaxLossExits}`,
    `maxHoldExits=${state.stats.maxHoldExits}`,
    `givebackBlockedByStrongTrend=${state.stats.givebackBlockedByStrongTrend}`,
    `washoutTrades=${state.stats.washoutExits}`,
    `washoutAvg=${pct(washoutAvg)}`,
    `washoutTotal=${pct(state.stats.washoutPnlPct)}`,
    `crossTrades=${state.stats.crossExits}`,
    `crossAvg=${pct(crossAvg)}`,
    `crossTotal=${pct(state.stats.crossPnlPct)}`,
    `crossMomoOverrideSignals=${state.stats.crossMomoOverrideSignals}`,
    `crossMomoOverrideOpens=${state.stats.crossMomoOverrideOpens}`,
    `risingTrades=${state.stats.risingExits}`,
    `risingAvg=${pct(risingAvg)}`,
    `risingTotal=${pct(state.stats.risingPnlPct)}`,
    `forwardAttempts=${state.stats.forwardAttempts}`,
    `forwardSuccess=${state.stats.forwardSuccess}`,
    `forwardErrors=${state.stats.forwardErrors}`,
    `forwardSkipped=${state.stats.forwardSkipped}`,
    `forwardDryRuns=${state.stats.forwardDryRuns}`,
    `forwardEntries=${state.stats.forwardEntries}`,
    `forwardExits=${state.stats.forwardExits}`,
    `feeQuickTpExits=${state.stats.feeAwareQuickTpExits}`,
    `softExitBlocks=${state.stats.softExitMinProfitBlocks}`,
    `externalDealBlocks=${state.stats.externalDealEntryBlocks}`
  ].join(" | "));
}

async function handleFeature(p) {
  state.stats.accepted += 1;
  const barNo = nextBarNumber(p.symbol);

  if (CFG.DEBUG) {
    logLine("FEATURE_5M_FVVO", [
      `symbol=${p.symbol}`,
      `open=${n(p.open, 4)}`,
      `high=${n(p.high, 4)}`,
      `low=${n(p.low, 4)}`,
      `close=${n(p.close, 4)}`,
      `ema8=${n(p.ema8, 4)}`,
      `ema18=${n(p.ema18, 4)}`,
      `rsi=${n(p.rsi, 2)}`,
      `adx=${n(p.adx, 2)}`,
      `fvvo=${n(p.fvvoValue, 6)}`,
      `signal=${n(p.fvvoSignal, 6)}`,
      `slope=${n(p.fvvoSlope, 6)}`,
      `aboveZero=${boolStr(p.fvvoAboveZero)}`,
      `crossUp=${boolStr(p.fvvoCrossUp)}`,
      `crossDown=${boolStr(p.fvvoCrossDown)}`,
      `redDot=${boolStr(p.fvvoRedDot)}`,
      `greenDot=${boolStr(p.fvvoGreenDot)}`,
      `redActive=${boolStr(p.fvvoRedActive)}`,
      `greenActive=${boolStr(p.fvvoGreenActive)}`,
      `redPulse=${boolStr(p.fvvoRedPulse)}`,
      `greenPulse=${boolStr(p.fvvoGreenPulse)}`,
      `redLegacy=${boolStr(p.fvvoRedDotLegacy)}`,
      `greenLegacy=${boolStr(p.fvvoGreenDotLegacy)}`,
      `pulseLogic=${boolStr(CFG.FVVO_PULSE_LOGIC_ENABLED && CFG.FVVO_DOT_PULSE_USE_IN_LOGIC)}`,
      `bullishColor=${boolStr(p.fvvoBullishColor)}`
    ].join(" | "));
  }

  observeShortSignal(p);
  const openPos = state.positions.get(p.symbol);

  if (openPos) {
    const perf = updatePositionStats(openPos, p);
    const exitDecision = evaluateLongExit(openPos, p, perf);

    if (exitDecision.exit) {
      await closeVirtualLong(openPos, p, perf, exitDecision, barNo);
    } else if (CFG.DEBUG) {
      logLine(`${setupPrefix(openPos.setup)}_LONG_HOLD`, [
        `🟡 setup=${openPos.setup}`,
        `symbol=${p.symbol}`,
        `price=${n(p.close, 4)}`,
        `low=${n(p.low, 4)}`,
        `stop=${openPos.stopPrice === null ? "na" : n(openPos.stopPrice, 4)}`,
        `pnl=${pct(perf.currentPnlPct)}`,
        `peak=${pct(perf.peakPnlPct)}`,
        `giveback=${pct(perf.givebackPct)}`,
        `barsHeld=${openPos.barsHeld}`,
        `holdReason=${exitDecision.reason}`,
        `strongTrendHold=${boolStr(exitDecision.strongTrendHold)}`,
        `entryMomentumOverride=${boolStr(openPos.entryMomentumOverride)}`,
        `forwardedEntry=${boolStr(openPos.forwardedEntry)}`,
        `forwardEntryStatus=${openPos.forwardEntryStatus}`,
        `fvvo=${n(p.fvvoValue, 6)}`,
        `slope=${n(p.fvvoSlope, 6)}`,
        `redDot=${boolStr(p.fvvoRedDot)}`,
        `greenDot=${boolStr(p.fvvoGreenDot)}`
      ].join(" | "));
    }

    state.lastFeature.set(p.symbol, p);
    pushHistory(p);
    return;
  }

  if (CFG.FVVO_EXTERNAL_DEAL_LOCK_ENABLED && state.externalDeals.has(p.symbol)) {
    state.stats.externalDealEntryBlocks += 1;
    const deal = state.externalDeals.get(p.symbol);
    if (CFG.DEBUG) {
      logLine("FVVO_RAW_LONG_NO_ENTRY", [
        `symbol=${p.symbol}`,
        `price=${n(p.close, 4)}`,
        `reason=FORWARDED_DEAL_LOCK_OPEN`,
        `dealEntry=${deal && Number.isFinite(deal.entryPrice) ? n(deal.entryPrice, 4) : "na"}`,
        `dealEntryTime=${deal ? deal.entryTime : "na"}`,
        `rsi=${n(p.rsi, 2)}`,
        `fvvo=${n(p.fvvoValue, 6)}`,
        `slope=${n(p.fvvoSlope, 6)}`,
        `crossUp=${boolStr(p.fvvoCrossUp)}`
      ].join(" | "));
    }
    state.lastFeature.set(p.symbol, p);
    pushHistory(p);
    return;
  }

  if (isEntryCooldownActive(p.symbol, barNo)) {
    if (CFG.DEBUG) {
      logLine("FVVO_RAW_LONG_NO_ENTRY", [
        `symbol=${p.symbol}`,
        `price=${n(p.close, 4)}`,
        `reason=ENTRY_COOLDOWN`,
        `barNo=${barNo}`,
        `cooldownBars=${CFG.FVVO_ENTRY_COOLDOWN_BARS}`,
        `rsi=${n(p.rsi, 2)}`,
        `fvvo=${n(p.fvvoValue, 6)}`,
        `slope=${n(p.fvvoSlope, 6)}`,
        `greenDot=${boolStr(p.fvvoGreenDot)}`,
        `aboveZero=${boolStr(p.fvvoAboveZero)}`,
        `crossUp=${boolStr(p.fvvoCrossUp)}`
      ].join(" | "));
    }
    state.lastFeature.set(p.symbol, p);
    pushHistory(p);
    return;
  }

  const washoutDecision = evaluateWashoutEntry(p);
  const crossDecision = evaluateCrossEntry(p);
  const risingDecision = evaluateRisingContinuationEntry(p);

  if (washoutDecision.ok) {
    state.stats.washoutSignals += 1;
    logLine("FVVO_WASHOUT_LONG_SIGNAL", [
      `🧪 symbol=${p.symbol}`,
      `price=${n(p.close, 4)}`,
      `reason=${washoutDecision.reason}`,
      `rsi=${n(p.rsi, 2)}`,
      `fvvo=${n(p.fvvoValue, 6)}`,
      `slope=${n(p.fvvoSlope, 6)}`,
      `greenDot=${boolStr(p.fvvoGreenDot)}`,
      `redPulse=${boolStr(p.fvvoRedPulse)}`,
      `greenPulse=${boolStr(p.fvvoGreenPulse)}`,
      `aboveZero=${boolStr(p.fvvoAboveZero)}`,
      `bullishColor=${boolStr(p.fvvoBullishColor)}`,
      `forwardEligible=${boolStr(shouldForwardSetup(washoutDecision.setup))}`
    ].join(" | "), washoutDecision.checks);
  }

  if (crossDecision.ok) {
    state.stats.crossSignals += 1;
    if (crossDecision.momentumOverride) state.stats.crossMomoOverrideSignals += 1;
    if (crossDecision.checks && crossDecision.checks.greenPulseAssist) state.stats.greenPulseAssistSignals += 1;
    logLine("FVVO_CROSS_LONG_SIGNAL", [
      `🧪 symbol=${p.symbol}`,
      `price=${n(p.close, 4)}`,
      `reason=${crossDecision.reason}`,
      `momentumOverride=${boolStr(crossDecision.momentumOverride)}`,
      `greenPulseMemory=${boolStr(crossDecision.checks && crossDecision.checks.recentGreenPulseMemory)}`,
      `greenPulseAssist=${boolStr(crossDecision.checks && crossDecision.checks.greenPulseAssist)}`,
      `rsi=${n(p.rsi, 2)}`,
      `adx=${n(p.adx, 2)}`,
      `fvvo=${n(p.fvvoValue, 6)}`,
      `slope=${n(p.fvvoSlope, 6)}`,
      `greenDot=${boolStr(p.fvvoGreenDot)}`,
      `crossUp=${boolStr(p.fvvoCrossUp)}`,
      `forwardEligible=${boolStr(shouldForwardSetup(crossDecision.setup))}`
    ].join(" | "), crossDecision.checks);
  }

  if (risingDecision.ok) {
    state.stats.risingSignals += 1;
    logLine("FVVO_RISING_LONG_SIGNAL", [
      `🧪 symbol=${p.symbol}`,
      `price=${n(p.close, 4)}`,
      `reason=${risingDecision.reason}`,
      `rsi=${n(p.rsi, 2)}`,
      `fvvo=${n(p.fvvoValue, 6)}`,
      `slope=${n(p.fvvoSlope, 6)}`,
      `greenDot=${boolStr(p.fvvoGreenDot)}`,
      `forwardEligible=${boolStr(shouldForwardSetup(risingDecision.setup))}`
    ].join(" | "), risingDecision.checks);
  }

  let chosenDecision = null;
  if (washoutDecision.ok) chosenDecision = washoutDecision;
  else if (crossDecision.ok) chosenDecision = crossDecision;
  else if (risingDecision.ok) chosenDecision = risingDecision;

  if (chosenDecision) {
    await openVirtualLong(p, chosenDecision, barNo);
  } else if (CFG.DEBUG) {
    logLine("FVVO_RAW_LONG_NO_ENTRY", [
      `symbol=${p.symbol}`,
      `price=${n(p.close, 4)}`,
      `washout=${washoutDecision.reason}`,
      `cross=${crossDecision.reason}`,
      `rising=${risingDecision.reason}`,
      `rsi=${n(p.rsi, 2)}`,
      `adx=${n(p.adx, 2)}`,
      `fvvo=${n(p.fvvoValue, 6)}`,
      `slope=${n(p.fvvoSlope, 6)}`,
      `greenDot=${boolStr(p.fvvoGreenDot)}`,
      `redPulse=${boolStr(p.fvvoRedPulse)}`,
      `greenPulse=${boolStr(p.fvvoGreenPulse)}`,
      `aboveZero=${boolStr(p.fvvoAboveZero)}`,
      `crossUp=${boolStr(p.fvvoCrossUp)}`,
      `redDot=${boolStr(p.fvvoRedDot)}`,
      `bullishColor=${boolStr(p.fvvoBullishColor)}`,
      `momentumOverrideCandidate=${boolStr(crossDecision.checks && crossDecision.checks.momentumOverride)}`
    ].join(" | "));
  }

  state.lastFeature.set(p.symbol, p);
  pushHistory(p);
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    brain: CFG.BRAIN_NAME,
    mode: CFG.SHADOW_ONLY ? "SHADOW_ONLY" : "DEMO_FORWARD",
    startedAt: state.startedAt,
    symbol: CFG.SYMBOL,
    tf: CFG.ENTRY_TF,
    enableForward: CFG.ENABLE_HTTP_FORWARD,
    demoForwardAllowed: CFG.DEMO_FORWARD_ALLOWED,
    dryRun: CFG.C3_DRY_RUN
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    brain: CFG.BRAIN_NAME,
    startedAt: state.startedAt,
    now: nowIso(),
    mode: CFG.SHADOW_ONLY ? "SHADOW_ONLY" : "DEMO_FORWARD",
    forwarding: {
      enableHttpForward: CFG.ENABLE_HTTP_FORWARD,
      demoForwardAllowed: CFG.DEMO_FORWARD_ALLOWED,
      liveForwardAllowed: CFG.LIVE_FORWARD_ALLOWED,
      dryRun: CFG.C3_DRY_RUN,
      forwardCross: CFG.FVVO_FORWARD_CROSS_ENABLED,
      forwardWashout: CFG.FVVO_FORWARD_WASHOUT_ENABLED,
      forwardRising: CFG.FVVO_FORWARD_RISING_ENABLED,
      forwardExit: CFG.FVVO_FORWARD_EXIT_ENABLED,
      has3CommasSecret: Boolean(CFG.C3_SIGNAL_SECRET),
      botMapSymbols: Object.keys(CFG.SYMBOL_BOT_MAP)
    },
    crossMomentumOverride: {
      enabled: CFG.FVVO_CROSS_MOMO_OVERRIDE_ENABLED,
      minSlope: CFG.FVVO_CROSS_MOMO_MIN_SLOPE,
      minRsi: CFG.FVVO_CROSS_MOMO_MIN_RSI,
      maxRsi: CFG.FVVO_CROSS_MOMO_MAX_RSI,
      minAdx: CFG.FVVO_CROSS_MOMO_MIN_ADX,
      maxExtEma8Pct: CFG.FVVO_CROSS_MOMO_MAX_EXT_EMA8_PCT,
      maxExtEma18Pct: CFG.FVVO_CROSS_MOMO_MAX_EXT_EMA18_PCT
    },
    strongTrendHold: {
      enabled: CFG.FVVO_STRONG_TREND_HOLD_ENABLED,
      minRsi: CFG.FVVO_STRONG_TREND_HOLD_MIN_RSI,
      minAdx: CFG.FVVO_STRONG_TREND_HOLD_MIN_ADX,
      minFvvo: CFG.FVVO_STRONG_TREND_HOLD_MIN_FVVO,
      maxNegativeSlope: CFG.FVVO_STRONG_TREND_HOLD_MAX_NEG_SLOPE
    },
    pulseLogic: {
      testMode: CFG.FVVO_DOT_PULSE_TEST_MODE,
      enabled: CFG.FVVO_PULSE_LOGIC_ENABLED && CFG.FVVO_DOT_PULSE_USE_IN_LOGIC,
      feeRoundTripPct: CFG.FVVO_FEE_ROUND_TRIP_PCT,
      quickTpEnabled: CFG.FVVO_QUICK_TP_ENABLED,
      quickTpMinPct: CFG.FVVO_QUICK_TP_MIN_PCT,
      softExitMinProfitPct: CFG.FVVO_SOFT_EXIT_MIN_PROFIT_PCT,
      externalDealLockEnabled: CFG.FVVO_EXTERNAL_DEAL_LOCK_ENABLED,
      externalDealOpen: state.externalDeals.has(CFG.SYMBOL),
      redPulseBlockBars: CFG.FVVO_RED_PULSE_BLOCK_BARS,
      redPulseExitEnabled: CFG.FVVO_RED_PULSE_EXIT_ENABLED,
      redPulseExitMinProfitPct: CFG.FVVO_RED_PULSE_EXIT_MIN_PROFIT_PCT,
      greenPulseMemoryBars: CFG.FVVO_GREEN_PULSE_MEMORY_BARS,
      greenPulseCrossAssistEnabled: CFG.FVVO_GREEN_PULSE_CROSS_ASSIST_ENABLED
    },
    stats: state.stats,
    openPositions: Array.from(state.positions.values()).map((p) => ({
      symbol: p.symbol,
      side: p.side,
      setup: p.setup,
      entryPrice: p.entryPrice,
      stopPrice: p.stopPrice,
      entryTime: p.entryTime,
      entryReason: p.entryReason,
      entryMomentumOverride: p.entryMomentumOverride,
      barsHeld: p.barsHeld,
      peakPnlPct: p.peakPnlPct,
      redDotSeen: p.redDotSeen,
      greenDotAtEntry: p.greenDotAtEntry,
      greenPulseMemoryAtEntry: p.greenPulseMemoryAtEntry,
      greenPulseAssistAtEntry: p.greenPulseAssistAtEntry,
      forwardedEntry: p.forwardedEntry,
      forwardEntryStatus: p.forwardEntryStatus
    }))
  });
});

app.post(CFG.WEBHOOK_PATH, async (req, res) => {
  state.stats.received += 1;
  let payload;
  try {
    payload = normalizePayload(req.body);
  } catch (err) {
    state.stats.rejected += 1;
    logLine("REJECT", `NORMALIZE_ERROR | ${err.message}`);
    return res.status(400).json({ ok: false, reason: "NORMALIZE_ERROR" });
  }

  const valid = validatePayload(payload);
  if (!valid.ok) {
    state.stats.rejected += 1;
    logLine("REJECT", `${valid.reason}`);
    return res.status(400).json({ ok: false, reason: valid.reason });
  }

  if (isDuplicateBar(payload)) {
    state.stats.duplicates += 1;
    logLine("DUPLICATE", `ignored duplicate bar | symbol=${payload.symbol} | tf=${payload.tf} | time=${payload.time}`);
    return res.json({ ok: true, duplicate: true, brain: CFG.BRAIN_NAME });
  }

  try {
    await handleFeature(payload);
  } catch (err) {
    state.stats.rejected += 1;
    logLine("ERROR", `HANDLE_FEATURE_ERROR | ${err.stack || err.message}`);
    return res.status(500).json({ ok: false, reason: "HANDLE_FEATURE_ERROR" });
  }

  return res.json({
    ok: true,
    brain: CFG.BRAIN_NAME,
    shadowOnly: CFG.SHADOW_ONLY,
    demoForward: CFG.ENABLE_HTTP_FORWARD && CFG.DEMO_FORWARD_ALLOWED && !CFG.SHADOW_ONLY
  });
});

app.listen(CFG.PORT, () => {
  console.log("============================================================");
  console.log(`${CFG.BRAIN_NAME} started`);
  console.log("============================================================");
  console.log(`PORT=${CFG.PORT}`);
  console.log(`WEBHOOK_PATH=${CFG.WEBHOOK_PATH}`);
  console.log(`SYMBOL=${CFG.SYMBOL}`);
  console.log(`ENTRY_TF=${CFG.ENTRY_TF}`);
  console.log(`SHADOW_ONLY=${CFG.SHADOW_ONLY}`);
  console.log(`ENABLE_HTTP_FORWARD=${CFG.ENABLE_HTTP_FORWARD}`);
  console.log(`DEMO_FORWARD_ALLOWED=${CFG.DEMO_FORWARD_ALLOWED}`);
  console.log(`LIVE_FORWARD_ALLOWED=${CFG.LIVE_FORWARD_ALLOWED}`);
  console.log(`C3_DRY_RUN=${CFG.C3_DRY_RUN}`);
  console.log(`C3_SIGNAL_URL=${CFG.C3_SIGNAL_URL}`);
  console.log(`C3_SIGNAL_SECRET_SET=${Boolean(CFG.C3_SIGNAL_SECRET)}`);
  console.log(`SYMBOL_BOT_MAP_SYMBOLS=${Object.keys(CFG.SYMBOL_BOT_MAP).join(",") || "none"}`);
  console.log(`C3_ORDER_AMOUNT_QUOTE=${CFG.C3_ORDER_AMOUNT_QUOTE}`);
  console.log(`FVVO_FORWARD_CROSS_ENABLED=${CFG.FVVO_FORWARD_CROSS_ENABLED}`);
  console.log(`FVVO_FORWARD_WASHOUT_ENABLED=${CFG.FVVO_FORWARD_WASHOUT_ENABLED}`);
  console.log(`FVVO_FORWARD_RISING_ENABLED=${CFG.FVVO_FORWARD_RISING_ENABLED}`);
  console.log(`FVVO_FORWARD_EXIT_ENABLED=${CFG.FVVO_FORWARD_EXIT_ENABLED}`);
  console.log("------------------------------------------------------------");
  console.log(`FVVO_LONG_ENABLED=${CFG.FVVO_LONG_ENABLED}`);
  console.log(`FVVO_SHORT_ENABLED=${CFG.FVVO_SHORT_ENABLED}`);
  console.log(`FVVO_ENTRY_COOLDOWN_BARS=${CFG.FVVO_ENTRY_COOLDOWN_BARS}`);
  console.log(`FVVO_DOT_PULSE_TEST_MODE=${CFG.FVVO_DOT_PULSE_TEST_MODE}`);
  console.log(`FVVO_DOT_PULSE_USE_IN_LOGIC=${CFG.FVVO_DOT_PULSE_USE_IN_LOGIC}`);
  console.log(`FVVO_PULSE_LOGIC_ENABLED=${CFG.FVVO_PULSE_LOGIC_ENABLED}`);
  console.log(`FVVO_RED_PULSE_BLOCK_BARS=${CFG.FVVO_RED_PULSE_BLOCK_BARS}`);
  console.log(`FVVO_RED_PULSE_EXIT_ENABLED=${CFG.FVVO_RED_PULSE_EXIT_ENABLED}`);
  console.log(`FVVO_RED_PULSE_EXIT_MIN_PROFIT_PCT=${CFG.FVVO_RED_PULSE_EXIT_MIN_PROFIT_PCT}`);
  console.log(`FVVO_RED_PULSE_EXIT_MAX_SLOPE=${CFG.FVVO_RED_PULSE_EXIT_MAX_SLOPE}`);
  console.log(`FVVO_GREEN_PULSE_MEMORY_BARS=${CFG.FVVO_GREEN_PULSE_MEMORY_BARS}`);
  console.log(`FVVO_GREEN_PULSE_CROSS_ASSIST_ENABLED=${CFG.FVVO_GREEN_PULSE_CROSS_ASSIST_ENABLED}`);
  console.log(`FVVO_GREEN_PULSE_CROSS_MIN_RSI=${CFG.FVVO_GREEN_PULSE_CROSS_MIN_RSI}`);
  console.log(`FVVO_GREEN_PULSE_CROSS_MIN_SLOPE=${CFG.FVVO_GREEN_PULSE_CROSS_MIN_SLOPE}`);
  console.log(`FVVO_GREEN_PULSE_CROSS_MIN_ADX=${CFG.FVVO_GREEN_PULSE_CROSS_MIN_ADX}`);
  console.log("------------------------------------------------------------");
  console.log(`FVVO_FEE_ROUND_TRIP_PCT=${CFG.FVVO_FEE_ROUND_TRIP_PCT}`);
  console.log(`FVVO_QUICK_TP_ENABLED=${CFG.FVVO_QUICK_TP_ENABLED}`);
  console.log(`FVVO_QUICK_TP_MIN_PCT=${CFG.FVVO_QUICK_TP_MIN_PCT}`);
  console.log(`FVVO_QUICK_TP_MIN_BARS=${CFG.FVVO_QUICK_TP_MIN_BARS}`);
  console.log(`FVVO_SOFT_EXIT_MIN_PROFIT_PCT=${CFG.FVVO_SOFT_EXIT_MIN_PROFIT_PCT}`);
  console.log(`FVVO_EXTERNAL_DEAL_LOCK_ENABLED=${CFG.FVVO_EXTERNAL_DEAL_LOCK_ENABLED}`);
  console.log("------------------------------------------------------------");
  console.log(`FVVO_WASHOUT_ENABLED=${CFG.FVVO_WASHOUT_ENABLED}`);
  console.log(`FVVO_WASHOUT_ALLOW_GREEN_DOT=${CFG.FVVO_WASHOUT_ALLOW_GREEN_DOT}`);
  console.log("------------------------------------------------------------");
  console.log(`FVVO_CROSS_ENABLED=${CFG.FVVO_CROSS_ENABLED}`);
  console.log(`FVVO_CROSS_MIN_RSI=${CFG.FVVO_CROSS_MIN_RSI}`);
  console.log(`FVVO_CROSS_MIN_SLOPE=${CFG.FVVO_CROSS_MIN_SLOPE}`);
  console.log(`FVVO_CROSS_MAX_EXT_EMA8_PCT=${CFG.FVVO_CROSS_MAX_EXT_EMA8_PCT}`);
  console.log(`FVVO_CROSS_MAX_EXT_EMA18_PCT=${CFG.FVVO_CROSS_MAX_EXT_EMA18_PCT}`);
  console.log(`FVVO_CROSS_ALLOW_EMA8_BELOW_EMA18_PCT=${CFG.FVVO_CROSS_ALLOW_EMA8_BELOW_EMA18_PCT}`);
  console.log(`FVVO_CROSS_RECENT_REDDOT_BLOCK_BARS=${CFG.FVVO_CROSS_RECENT_REDDOT_BLOCK_BARS}`);
  console.log("------------------------------------------------------------");
  console.log(`FVVO_CROSS_MOMO_OVERRIDE_ENABLED=${CFG.FVVO_CROSS_MOMO_OVERRIDE_ENABLED}`);
  console.log(`FVVO_CROSS_MOMO_MIN_SLOPE=${CFG.FVVO_CROSS_MOMO_MIN_SLOPE}`);
  console.log(`FVVO_CROSS_MOMO_MIN_RSI=${CFG.FVVO_CROSS_MOMO_MIN_RSI}`);
  console.log(`FVVO_CROSS_MOMO_MAX_RSI=${CFG.FVVO_CROSS_MOMO_MAX_RSI}`);
  console.log(`FVVO_CROSS_MOMO_MIN_ADX=${CFG.FVVO_CROSS_MOMO_MIN_ADX}`);
  console.log(`FVVO_CROSS_MOMO_MAX_EXT_EMA8_PCT=${CFG.FVVO_CROSS_MOMO_MAX_EXT_EMA8_PCT}`);
  console.log(`FVVO_CROSS_MOMO_MAX_EXT_EMA18_PCT=${CFG.FVVO_CROSS_MOMO_MAX_EXT_EMA18_PCT}`);
  console.log("------------------------------------------------------------");
  console.log(`FVVO_RISING_CONT_ENABLED=${CFG.FVVO_RISING_CONT_ENABLED}`);
  console.log(`FVVO_RISING_MIN_RSI=${CFG.FVVO_RISING_MIN_RSI}`);
  console.log(`FVVO_RISING_MIN_SLOPE=${CFG.FVVO_RISING_MIN_SLOPE}`);
  console.log(`FVVO_RISING_MAX_EXT_EMA8_PCT=${CFG.FVVO_RISING_MAX_EXT_EMA8_PCT}`);
  console.log(`FVVO_RISING_MAX_EXT_EMA18_PCT=${CFG.FVVO_RISING_MAX_EXT_EMA18_PCT}`);
  console.log("------------------------------------------------------------");
  console.log(`FVVO_INTRABAR_HARD_STOP_ENABLED=${CFG.FVVO_INTRABAR_HARD_STOP_ENABLED}`);
  console.log(`FVVO_MAX_LOSS_EXIT_PCT=${CFG.FVVO_MAX_LOSS_EXIT_PCT}`);
  console.log(`FVVO_GIVEBACK_ARM1_PCT=${CFG.FVVO_GIVEBACK_ARM1_PCT}`);
  console.log(`FVVO_GIVEBACK_ARM1_DROP_PCT=${CFG.FVVO_GIVEBACK_ARM1_DROP_PCT}`);
  console.log(`FVVO_GIVEBACK_ARM2_PCT=${CFG.FVVO_GIVEBACK_ARM2_PCT}`);
  console.log(`FVVO_GIVEBACK_ARM2_DROP_PCT=${CFG.FVVO_GIVEBACK_ARM2_DROP_PCT}`);
  console.log(`FVVO_HARD_DOWN_SLOPE=${CFG.FVVO_HARD_DOWN_SLOPE}`);
  console.log(`FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT=${CFG.FVVO_BACKUP_EXIT_REQUIRE_PROFIT_PCT}`);
  console.log(`FVVO_MAX_HOLD_BARS=${CFG.FVVO_MAX_HOLD_BARS}`);
  console.log("------------------------------------------------------------");
  console.log(`FVVO_STRONG_TREND_HOLD_ENABLED=${CFG.FVVO_STRONG_TREND_HOLD_ENABLED}`);
  console.log(`FVVO_STRONG_TREND_HOLD_MIN_RSI=${CFG.FVVO_STRONG_TREND_HOLD_MIN_RSI}`);
  console.log(`FVVO_STRONG_TREND_HOLD_MIN_ADX=${CFG.FVVO_STRONG_TREND_HOLD_MIN_ADX}`);
  console.log(`FVVO_STRONG_TREND_HOLD_MIN_FVVO=${CFG.FVVO_STRONG_TREND_HOLD_MIN_FVVO}`);
  console.log(`FVVO_STRONG_TREND_HOLD_MAX_NEG_SLOPE=${CFG.FVVO_STRONG_TREND_HOLD_MAX_NEG_SLOPE}`);
  console.log("============================================================");
});
