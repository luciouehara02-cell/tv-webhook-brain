// ============================================================
// BrainFVVO_ManualExit_v1e_EXPLICIT_MARKET_ENTRY_EXIT_DEMO
// Isolated SOLUSDT DEMO-only manual-entry / brain-exit service
// ------------------------------------------------------------
// Technical lineage: BrainFVVO_v2o_CROSS_EXIT_FLOOR_DEMO
//
// v1e changes versus v1d:
// - Explicit entry order is mandatory: `order.amount`, `currency_type: quote`,
//   and `order_type: market` are always emitted. This prevents 3Commas from
//   creating an unfilled pending entry SmartTrade when an entry needs to be immediate.
// - Requires Signal Bot Entry Orders = `Send in webhook, quote`; the bot must
//   not silently infer entry sizing/order type from its UI defaults.
// - Adds `C3_ENTRY_WEBHOOK_MARKET_REQUIRED` safety validation and clearly
//   exposes the expected bot mode in /manual status.
//
// v1d changes versus v1c:
// - 3Commas Custom Signal payload now matches the generated schema exactly:
//   ISO-8601 timestamp, trigger_price, explicit C3 payload audit, and
//   configurable entry-size source while retaining position-percent exits.
// - Adds force_clear_verified_flat for a verified external emergency close
//   that happened outside the normal brain exit lifecycle.
//
// v1c changes versus v1b:
// - Manual chart levels use absolute prices, never % inputs:
//     first_stop_price, final_stop_price, profit_target_price(optional)
// - Enforces max stop / target distance % safety guards from the fresh entry
//   reference price while retaining a native 3Commas final-stop fallback.
// - Serializes all persistent state writes and uses unique temp file names.
// - Adds a post-recovery protected-profit stop to prevent a confirmed recovery
//   from falling through breakeven into the previous post-arm loss corridor.
// - Adds audit lifecycle events and ANSI color-coded Railway logs.
// - Tracks tick, 5m feature, and fast-tick feed health separately.
//
// This service NEVER opens automatic trades. A position is opened only by
// authenticated /manual action=enter_long using
// MANUAL_WASHOUT_TWO_LEVEL_RECOVERY.
// ============================================================

"use strict";

const express = require("express");
const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb", strict: true }));

function envStr(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === null || String(value).trim() === ""
    ? fallback
    : String(value).trim();
}

function envNum(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  return ["1", "true", "yes", "y", "on"].includes(
    String(value).trim().toLowerCase()
  );
}

function parseJsonEnv(name, fallback) {
  const raw = envStr(name, "");
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (error) {
    console.error(
      `${new Date().toISOString()} | CONFIG_ERROR | ${name} invalid JSON | ${error.message}`
    );
    return fallback;
  }
}

const CFG = {
  BRAIN_NAME: envStr(
    "BRAIN_NAME",
    "BrainFVVO_ManualExit_v1e_EXPLICIT_MARKET_ENTRY_EXIT_DEMO"
  ),
  PORT: envNum("PORT", 8080),
  SYMBOL: envStr("SYMBOL", "BINANCE:SOLUSDT"),
  ENTRY_TF: envStr("ENTRY_TF", "5"),

  WEBHOOK_PATH: envStr("WEBHOOK_PATH", "/webhook"),
  WEBHOOK_SECRET: envStr("WEBHOOK_SECRET", ""),
  MANUAL_CONTROL_ENABLED: envBool("MANUAL_CONTROL_ENABLED", true),
  MANUAL_WEBHOOK_PATH: envStr("MANUAL_WEBHOOK_PATH", "/manual"),
  MANUAL_WEBHOOK_SECRET: envStr("MANUAL_WEBHOOK_SECRET", ""),

  SHADOW_ONLY: envBool("SHADOW_ONLY", false),
  ENABLE_HTTP_FORWARD: envBool("ENABLE_HTTP_FORWARD", true),
  DEMO_FORWARD_ALLOWED: envBool("DEMO_FORWARD_ALLOWED", true),
  LIVE_FORWARD_ALLOWED: envBool("LIVE_FORWARD_ALLOWED", false),
  C3_DRY_RUN: envBool("C3_DRY_RUN", false),
  FVVO_EMERGENCY_DISABLE_ALL_FORWARDS: envBool(
    "FVVO_EMERGENCY_DISABLE_ALL_FORWARDS",
    false
  ),
  FVVO_EMERGENCY_DISABLE_NEW_ENTRIES: envBool(
    "FVVO_EMERGENCY_DISABLE_NEW_ENTRIES",
    false
  ),

  C3_SIGNAL_URL: envStr(
    "C3_SIGNAL_URL",
    "https://api.3commas.io/signal_bots/webhooks"
  ),
  C3_SIGNAL_SECRET: envStr("C3_SIGNAL_SECRET", ""),
  C3_BOT_UUID: envStr("C3_BOT_UUID", ""),
  SYMBOL_BOT_MAP: parseJsonEnv("SYMBOL_BOT_MAP", {}),

  // C3_ORDER_AMOUNT_QUOTE is retained as a compatibility fallback. Prefer the
  // explicit C3_ENTRY_ORDER_* variables below for a new deployment.
  C3_ORDER_AMOUNT_QUOTE: envNum("C3_ORDER_AMOUNT_QUOTE", 0),
  // v1e: explicit entry market order is mandatory. The dedicated Signal Bot
  // must be set to "Send in webhook, quote" so 3Commas respects these fields.
  C3_ENTRY_WEBHOOK_MARKET_REQUIRED: envBool(
    "C3_ENTRY_WEBHOOK_MARKET_REQUIRED",
    true
  ),
  C3_ENTRY_ORDER_AMOUNT: envNum(
    "C3_ENTRY_ORDER_AMOUNT",
    envNum("C3_ORDER_AMOUNT_QUOTE", 800)
  ),
  C3_ENTRY_ORDER_CURRENCY_TYPE: envStr(
    "C3_ENTRY_ORDER_CURRENCY_TYPE",
    "quote"
  ).toLowerCase(),
  C3_ENTRY_ORDER_TYPE: envStr("C3_ENTRY_ORDER_TYPE", "market").toLowerCase(),
  C3_EXIT_INCLUDE_POSITION_ORDER: envBool(
    "C3_EXIT_INCLUDE_POSITION_ORDER",
    true
  ),
  C3_TRIGGER_PRICE_DECIMALS: Math.floor(
    envNum("C3_TRIGGER_PRICE_DECIMALS", 8)
  ),
  C3_PAYLOAD_AUDIT_ENABLED: envBool("C3_PAYLOAD_AUDIT_ENABLED", true),
  C3_REQUEST_TIMEOUT_MS: envNum("C3_REQUEST_TIMEOUT_MS", 10000),
  C3_MAX_LAG_SEC: envNum("C3_MAX_LAG_SEC", 300),
  C3_FORWARD_DEDUP_MS: envNum("C3_FORWARD_DEDUP_MS", 60000),
  C3_NATIVE_FINAL_STOP_ENABLED: envBool(
    "C3_NATIVE_FINAL_STOP_ENABLED",
    true
  ),
  C3_PARTIAL_EXIT_ENABLED: envBool("C3_PARTIAL_EXIT_ENABLED", true),
  C3_ASSUME_EXIT_ACCEPTANCE: envBool("C3_ASSUME_EXIT_ACCEPTANCE", false),

  STATE_DIR: envStr("STATE_DIR", "/data"),
  STATE_FILE_NAME: envStr(
    "STATE_FILE_NAME",
    "brainfvvo-manualexit-v1c-state.json"
  ),
  STATE_PERSISTENCE_REQUIRED: envBool("STATE_PERSISTENCE_REQUIRED", true),

  FVVO_LOG_COLOR_ENABLED: envBool("FVVO_LOG_COLOR_ENABLED", true),
  FVVO_FEATURE_TICK_EVENT: envStr(
    "FVVO_FEATURE_TICK_EVENT",
    "FEATURE_TICK_FVVO"
  ),
  FVVO_FEATURE_5M_EVENT: envStr(
    "FVVO_FEATURE_5M_EVENT",
    "FEATURE_5M_FVVO"
  ),
  FVVO_FAST_TICK_EVENT: envStr("FVVO_FAST_TICK_EVENT", "FAST_TICK_FVVO"),
  MANUAL_REQUIRE_FRESH_FEATURE_TICK: envBool(
    "MANUAL_REQUIRE_FRESH_FEATURE_TICK",
    true
  ),
  FVVO_STALE_FEATURE_TICK_MAX_AGE_SEC: envNum(
    "FVVO_STALE_FEATURE_TICK_MAX_AGE_SEC",
    60
  ),

  MANUAL_ENTRY_DEFAULT_PROFILE: envStr(
    "MANUAL_ENTRY_DEFAULT_PROFILE",
    "MANUAL_WASHOUT_TWO_LEVEL_RECOVERY"
  ),
  MANUAL_ALLOW_ENTER: envBool("MANUAL_ALLOW_ENTER", true),
  MANUAL_ALLOW_EXIT: envBool("MANUAL_ALLOW_EXIT", true),
  MANUAL_ALLOW_STATUS: envBool("MANUAL_ALLOW_STATUS", true),
  MANUAL_ALLOW_HANDOFF: envBool("MANUAL_ALLOW_HANDOFF", true),
  MANUAL_ALLOW_CLEAR_HANDOFF: envBool(
    "MANUAL_ALLOW_CLEAR_HANDOFF",
    true
  ),
  MANUAL_ALLOW_CONFIRM_EXIT: envBool("MANUAL_ALLOW_CONFIRM_EXIT", true),
  MANUAL_ALLOW_FORCE_CLEAR_VERIFIED_FLAT: envBool(
    "MANUAL_ALLOW_FORCE_CLEAR_VERIFIED_FLAT",
    true
  ),
  MANUAL_FORCE_CLEAR_CONFIRM_PHRASE: envStr(
    "MANUAL_FORCE_CLEAR_CONFIRM_PHRASE",
    "I_VERIFIED_DEDICATED_3COMMAS_DEMO_BOT_IS_FLAT"
  ),
  MANUAL_ALLOW_ADOPT: envBool("MANUAL_ALLOW_ADOPT", false),
  MANUAL_ADOPT_REQUIRE_RECOVERY_LOCK: envBool(
    "MANUAL_ADOPT_REQUIRE_RECOVERY_LOCK",
    true
  ),
  MANUAL_CLEAR_REQUIRES_CONFIRM_FLAT: envBool(
    "MANUAL_CLEAR_REQUIRES_CONFIRM_FLAT",
    true
  ),
  MANUAL_ENTRY_EXIT_GRACE_SEC: envNum("MANUAL_ENTRY_EXIT_GRACE_SEC", 8),

  // Manual chart levels are absolute SOLUSDT prices in the command.
  MANUAL_WASHOUT_PROFILE_ENABLED: envBool(
    "MANUAL_WASHOUT_PROFILE_ENABLED",
    true
  ),
  MANUAL_WASHOUT_REQUIRE_ABSOLUTE_STOP_PRICES: envBool(
    "MANUAL_WASHOUT_REQUIRE_ABSOLUTE_STOP_PRICES",
    true
  ),
  MANUAL_WASHOUT_PRICE_STEP: envNum("MANUAL_WASHOUT_PRICE_STEP", 0.01),
  MANUAL_WASHOUT_MAX_STOP_DISTANCE_PCT: envNum(
    "MANUAL_WASHOUT_MAX_STOP_DISTANCE_PCT",
    2.0
  ),
  MANUAL_WASHOUT_MAX_TARGET_DISTANCE_PCT: envNum(
    "MANUAL_WASHOUT_MAX_TARGET_DISTANCE_PCT",
    2.0
  ),
  MANUAL_WASHOUT_MIN_STOP_GAP_PCT: envNum(
    "MANUAL_WASHOUT_MIN_STOP_GAP_PCT",
    0.2
  ),
  MANUAL_WASHOUT_PARTIAL_EXIT_PCT: envNum(
    "MANUAL_WASHOUT_PARTIAL_EXIT_PCT",
    50
  ),
  MANUAL_WASHOUT_FIRST_STOP_CONFIRM_SEC: envNum(
    "MANUAL_WASHOUT_FIRST_STOP_CONFIRM_SEC",
    20
  ),
  MANUAL_WASHOUT_FIRST_STOP_CONFIRM_OBSERVATIONS: envNum(
    "MANUAL_WASHOUT_FIRST_STOP_CONFIRM_OBSERVATIONS",
    2
  ),
  MANUAL_WASHOUT_FIRST_STOP_5M_CLOSE_IMMEDIATE: envBool(
    "MANUAL_WASHOUT_FIRST_STOP_5M_CLOSE_IMMEDIATE",
    true
  ),
  MANUAL_WASHOUT_RECOVERY_ARM_MFE_PCT: envNum(
    "MANUAL_WASHOUT_RECOVERY_ARM_MFE_PCT",
    0.45
  ),
  MANUAL_WASHOUT_ARM_REQUIRE_ABOVE_EMA8: envBool(
    "MANUAL_WASHOUT_ARM_REQUIRE_ABOVE_EMA8",
    true
  ),
  MANUAL_WASHOUT_ARM_REQUIRE_FVVO_ABOVE_ZERO: envBool(
    "MANUAL_WASHOUT_ARM_REQUIRE_FVVO_ABOVE_ZERO",
    true
  ),
  MANUAL_WASHOUT_ARM_MAX_DOWN_SLOPE: envNum(
    "MANUAL_WASHOUT_ARM_MAX_DOWN_SLOPE",
    -0.55
  ),
  MANUAL_WASHOUT_TARGET_TRAIL_MAX_GIVEBACK_PCT: envNum(
    "MANUAL_WASHOUT_TARGET_TRAIL_MAX_GIVEBACK_PCT",
    0.10
  ),

  // Once a recovery is genuinely armed, do not allow the trade to fall back
  // through breakeven merely because generic fee-floor exits need +0.25%.
  MANUAL_WASHOUT_POST_ARM_PROTECT_ENABLED: envBool(
    "MANUAL_WASHOUT_POST_ARM_PROTECT_ENABLED",
    true
  ),
  MANUAL_WASHOUT_POST_ARM_PROTECT_PNL_PCT: envNum(
    "MANUAL_WASHOUT_POST_ARM_PROTECT_PNL_PCT",
    0.20
  ),

  // v2o Cross-style protection, active only after recovery has armed.
  FVVO_CROSS_HARD_STOP_PCT: envNum("FVVO_CROSS_HARD_STOP_PCT", 0.25),
  FVVO_FEE_ROUND_TRIP_PCT: envNum("FVVO_FEE_ROUND_TRIP_PCT", 0.15),
  FVVO_CROSS_MIN_EXIT_GROSS_PCT: envNum(
    "FVVO_CROSS_MIN_EXIT_GROSS_PCT",
    0.25
  ),
  FVVO_CROSS_FEATURE_FEE_TRAIL_ENABLED: envBool(
    "FVVO_CROSS_FEATURE_FEE_TRAIL_ENABLED",
    true
  ),
  FVVO_CROSS_FEATURE_FEE_TRAIL_ARM_PCT: envNum(
    "FVVO_CROSS_FEATURE_FEE_TRAIL_ARM_PCT",
    0.20
  ),
  FVVO_CROSS_FEATURE_FEE_TRAIL_MIN_GIVEBACK_PCT: envNum(
    "FVVO_CROSS_FEATURE_FEE_TRAIL_MIN_GIVEBACK_PCT",
    0.06
  ),
  FVVO_CROSS_DYNAMIC_TRAIL_ENABLED: envBool(
    "FVVO_CROSS_DYNAMIC_TRAIL_ENABLED",
    true
  ),
  FVVO_CROSS_DYNAMIC_TRAIL_ARM_PCT: envNum(
    "FVVO_CROSS_DYNAMIC_TRAIL_ARM_PCT",
    0.45
  ),
  FVVO_CROSS_DYNAMIC_TRAIL_START_GIVEBACK_PCT: envNum(
    "FVVO_CROSS_DYNAMIC_TRAIL_START_GIVEBACK_PCT",
    0.28
  ),
  FVVO_CROSS_DYNAMIC_TRAIL_MIN_GIVEBACK_PCT: envNum(
    "FVVO_CROSS_DYNAMIC_TRAIL_MIN_GIVEBACK_PCT",
    0.12
  ),
  FVVO_CROSS_DYNAMIC_TRAIL_TIGHTEN_PER_1PCT: envNum(
    "FVVO_CROSS_DYNAMIC_TRAIL_TIGHTEN_PER_1PCT",
    0.10
  ),
  FVVO_CROSS_HARD_DOWN_SLOPE: envNum("FVVO_CROSS_HARD_DOWN_SLOPE", -0.55),
  FVVO_CROSS_EXIT_ON_RED_PULSE: envBool(
    "FVVO_CROSS_EXIT_ON_RED_PULSE",
    true
  ),
  FVVO_CROSS_EXIT_ON_CROSS_DOWN: envBool(
    "FVVO_CROSS_EXIT_ON_CROSS_DOWN",
    true
  ),
  FVVO_CROSS_EXIT_ON_5M_BACKUP: envBool(
    "FVVO_CROSS_EXIT_ON_5M_BACKUP",
    true
  ),
  FVVO_CROSS_EXIT_ON_FAST_TICK_BACKUP: envBool(
    "FVVO_CROSS_EXIT_ON_FAST_TICK_BACKUP",
    true
  ),

  MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_ENABLED: envBool(
    "MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_ENABLED",
    true
  ),
  MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_SEC: envNum(
    "MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_SEC",
    7200
  ),
  MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_REQUIRE_PRICE_ABOVE_EMA18: envBool(
    "MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_REQUIRE_PRICE_ABOVE_EMA18",
    true
  ),
  MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_REQUIRE_FVVO_ABOVE_ZERO: envBool(
    "MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_REQUIRE_FVVO_ABOVE_ZERO",
    true
  ),
  MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_ENABLED: envBool(
    "MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_ENABLED",
    true
  ),
  MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_MIN_PNL_PCT: envNum(
    "MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_MIN_PNL_PCT",
    0.20
  ),
  MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_CTX_MIN_FVVO: envNum(
    "MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_CTX_MIN_FVVO",
    0
  ),
  MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_MAX_BELOW_EMA18_PCT: envNum(
    "MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_MAX_BELOW_EMA18_PCT",
    0.15
  ),
};

const PROFILE = "MANUAL_WASHOUT_TWO_LEVEL_RECOVERY";
const STATE_PATH = path.join(CFG.STATE_DIR, CFG.STATE_FILE_NAME);
const STATE_BACKUP_PATH = `${STATE_PATH}.bak`;

let persistenceReady = false;
let persistenceError = "";
let persistenceQueue = Promise.resolve();
let persistenceSequence = 0;
let state = defaultState();
let lastExitDecisionLogAt = 0;

const ANSI = {
  reset: "\x1b[0m",
  grey: "\x1b[90m",
  orange: "\x1b[38;5;214m",
  yellow: "\x1b[93m",
  lightBlue: "\x1b[94m",
  cyan: "\x1b[96m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function logColor(level, event, fields) {
  if (!CFG.FVVO_LOG_COLOR_ENABLED) return "";
  const action = String(fields?.action || "").toLowerCase();
  const upperEvent = String(event || "").toUpperCase();

  if (upperEvent.includes("FEATURE_5M")) return ANSI.lightBlue;
  if (upperEvent.includes("FEATURE_TICK") || upperEvent.includes("FAST_TICK")) {
    return ANSI.orange;
  }
  if (upperEvent.includes("ENTRY") || upperEvent.includes("TRADE_OPEN")) {
    return ANSI.green;
  }
  if (
    upperEvent.includes("EXIT") ||
    upperEvent.includes("STOP") ||
    action === "exit_long"
  ) {
    return ANSI.red;
  }
  if (upperEvent.includes("RECOVERY") || upperEvent.includes("RESTORED")) {
    return ANSI.magenta;
  }
  if (level === "ERROR") return ANSI.red;
  if (level === "WARN") return ANSI.yellow;
  if (upperEvent.includes("MANUAL_COMMAND")) return ANSI.cyan;
  return ANSI.grey;
}

function log(level, event, fields = {}) {
  const line = `${nowIso()} | ${level} | ${CFG.BRAIN_NAME} | ${event} | ${JSON.stringify(
    fields
  )}`;
  const color = logColor(level, event, fields);
  console.log(color ? `${color}${line}${ANSI.reset}` : line);
}

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function firstFinite(...values) {
  for (const value of values) {
    const parsed = finite(value, null);
    if (parsed !== null) return parsed;
  }
  return null;
}

function cleanSymbol(value) {
  return String(value || "").trim().toUpperCase();
}

function asBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function pctPriceBelow(entry, pctBelow) {
  return entry * (1 - pctBelow / 100);
}

function pctPriceAbove(entry, pctAbove) {
  return entry * (1 + pctAbove / 100);
}

function percentPnl(entry, price) {
  return ((price - entry) / entry) * 100;
}

function percentageBelow(reference, price) {
  return ((reference - price) / reference) * 100;
}

function safeTimingEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authenticate(expected, received) {
  return Boolean(expected) && safeTimingEqual(expected, received);
}

function cloneForPersistence(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultState() {
  return {
    schemaVersion: 3,
    updatedAt: nowIso(),
    lastFeature: null,
    lastFeature5m: null,
    lastFastTick: null,
    position: null,
    externalDealLock: { active: false, source: "", setAt: "", reason: "" },
    manual: {
      handoffActive: false,
      recoveryRequired: false,
      recoveryReason: "",
      lastAction: "",
      lastActionAt: "",
    },
    forward: { lastByKey: {}, lastRequestId: "" },
  };
}

function normalizeState(raw) {
  const fallback = defaultState();
  if (!raw || typeof raw !== "object") return fallback;

  const position = raw.position && typeof raw.position === "object" ? raw.position : null;
  if (position) {
    position.profile = PROFILE;
    position.phase = position.phase || "DEFENSIVE";
    position.remainingPositionPctAssumed = finite(
      position.remainingPositionPctAssumed,
      100
    );
    position.partial = {
      status: "NONE",
      requestedPct: CFG.MANUAL_WASHOUT_PARTIAL_EXIT_PCT,
      ...((position.partial && typeof position.partial === "object")
        ? position.partial
        : {}),
    };
    position.firstStop = {
      breachAtMs: 0,
      observations: 0,
      lastBreachPrice: null,
      ...((position.firstStop && typeof position.firstStop === "object")
        ? position.firstStop
        : {}),
    };

    // v1b -> v1c migration: retain existing absolute calculated prices and
    // derive percentage metadata if it is missing.
    const entry = finite(position.entryPriceReference, null);
    if (entry && entry > 0) {
      position.firstStopPrice = finite(
        position.firstStopPrice,
        pctPriceBelow(entry, finite(position.firstStopPct, 0.7))
      );
      position.finalStopPrice = finite(
        position.finalStopPrice,
        pctPriceBelow(entry, finite(position.finalStopPct, 1.0))
      );
      position.firstStopPct = round(
        percentageBelow(entry, position.firstStopPrice),
        6
      );
      position.finalStopPct = round(
        percentageBelow(entry, position.finalStopPrice),
        6
      );
      const priorTargetPct = finite(position.profitTargetPct, 0);
      position.profitTargetPrice = finite(
        position.profitTargetPrice,
        priorTargetPct > 0 ? pctPriceAbove(entry, priorTargetPct) : 0
      );
      position.profitTargetPct =
        position.profitTargetPrice > entry
          ? round(percentPnl(entry, position.profitTargetPrice), 6)
          : 0;
    }
  }

  return {
    ...fallback,
    ...raw,
    schemaVersion: 3,
    lastFeature:
      raw.lastFeature && typeof raw.lastFeature === "object"
        ? raw.lastFeature
        : null,
    lastFeature5m:
      raw.lastFeature5m && typeof raw.lastFeature5m === "object"
        ? raw.lastFeature5m
        : null,
    lastFastTick:
      raw.lastFastTick && typeof raw.lastFastTick === "object"
        ? raw.lastFastTick
        : null,
    position,
    externalDealLock: {
      ...fallback.externalDealLock,
      ...(raw.externalDealLock || {}),
    },
    manual: { ...fallback.manual, ...(raw.manual || {}) },
    forward: { ...fallback.forward, ...(raw.forward || {}) },
  };
}

function getBotUuid() {
  return String(CFG.SYMBOL_BOT_MAP[CFG.SYMBOL] || CFG.C3_BOT_UUID || "").trim();
}

function isForwardAllowed() {
  return (
    CFG.ENABLE_HTTP_FORWARD &&
    CFG.DEMO_FORWARD_ALLOWED &&
    !CFG.LIVE_FORWARD_ALLOWED &&
    !CFG.SHADOW_ONLY &&
    !CFG.FVVO_EMERGENCY_DISABLE_ALL_FORWARDS
  );
}

function configProblems() {
  const problems = [];
  if (!CFG.WEBHOOK_SECRET) problems.push("WEBHOOK_SECRET_MISSING");
  if (!CFG.MANUAL_WEBHOOK_SECRET) problems.push("MANUAL_WEBHOOK_SECRET_MISSING");
  if (!CFG.C3_SIGNAL_SECRET) problems.push("C3_SIGNAL_SECRET_MISSING");
  if (!getBotUuid()) problems.push("DEDICATED_C3_BOT_UUID_MISSING");
  if (!Number.isInteger(CFG.C3_TRIGGER_PRICE_DECIMALS) || CFG.C3_TRIGGER_PRICE_DECIMALS < 0 || CFG.C3_TRIGGER_PRICE_DECIMALS > 12) {
    problems.push("INVALID_C3_TRIGGER_PRICE_DECIMALS");
  }
  if (!Number.isFinite(CFG.C3_ENTRY_ORDER_AMOUNT) || CFG.C3_ENTRY_ORDER_AMOUNT < 0) {
    problems.push("INVALID_C3_ENTRY_ORDER_AMOUNT");
  }
  if (CFG.C3_ENTRY_WEBHOOK_MARKET_REQUIRED && CFG.C3_ENTRY_ORDER_AMOUNT <= 0) {
    problems.push("C3_ENTRY_ORDER_AMOUNT_MUST_BE_GT_ZERO_FOR_EXPLICIT_WEBHOOK_MARKET_ENTRY");
  }
  if (CFG.C3_ENTRY_WEBHOOK_MARKET_REQUIRED && CFG.C3_ENTRY_ORDER_CURRENCY_TYPE !== "quote") {
    problems.push("C3_ENTRY_ORDER_CURRENCY_TYPE_MUST_BE_QUOTE_FOR_EXPLICIT_WEBHOOK_MARKET_ENTRY");
  }
  if (!['quote', 'base', 'margin_percent'].includes(CFG.C3_ENTRY_ORDER_CURRENCY_TYPE)) {
    problems.push("INVALID_C3_ENTRY_ORDER_CURRENCY_TYPE");
  }
  if (CFG.C3_ENTRY_ORDER_TYPE !== "market") {
    problems.push("C3_ENTRY_ORDER_TYPE_MUST_BE_MARKET");
  }
  if (CFG.C3_PARTIAL_EXIT_ENABLED && !CFG.C3_EXIT_INCLUDE_POSITION_ORDER) {
    problems.push("PARTIAL_EXIT_REQUIRES_C3_EXIT_INCLUDE_POSITION_ORDER_TRUE");
  }
  if (CFG.LIVE_FORWARD_ALLOWED) problems.push("LIVE_FORWARD_ALLOWED_MUST_BE_FALSE");
  if (!CFG.DEMO_FORWARD_ALLOWED) problems.push("DEMO_FORWARD_ALLOWED_MUST_BE_TRUE");
  if (!CFG.ENABLE_HTTP_FORWARD) problems.push("ENABLE_HTTP_FORWARD_MUST_BE_TRUE");
  if (CFG.SHADOW_ONLY) problems.push("SHADOW_ONLY_MUST_BE_FALSE");
  if (CFG.MANUAL_WASHOUT_PRICE_STEP <= 0) problems.push("INVALID_PRICE_STEP");
  if (CFG.MANUAL_WASHOUT_MAX_STOP_DISTANCE_PCT <= 0) {
    problems.push("INVALID_MAX_STOP_DISTANCE_PCT");
  }
  if (CFG.MANUAL_WASHOUT_MAX_TARGET_DISTANCE_PCT < 0) {
    problems.push("INVALID_MAX_TARGET_DISTANCE_PCT");
  }
  if (CFG.MANUAL_WASHOUT_MIN_STOP_GAP_PCT <= 0) {
    problems.push("INVALID_MIN_STOP_GAP_PCT");
  }
  if (CFG.MANUAL_WASHOUT_PARTIAL_EXIT_PCT !== 50) {
    problems.push("PARTIAL_EXIT_MUST_REMAIN_50_PERCENT_FOR_V1C");
  }
  if (CFG.FVVO_CROSS_HARD_STOP_PCT <= 0) {
    problems.push("INVALID_CROSS_HARD_STOP");
  }
  if (CFG.FVVO_CROSS_MIN_EXIT_GROSS_PCT < CFG.FVVO_FEE_ROUND_TRIP_PCT) {
    problems.push("EXIT_FLOOR_BELOW_ESTIMATED_FEE");
  }
  if (
    CFG.MANUAL_WASHOUT_POST_ARM_PROTECT_ENABLED &&
    CFG.MANUAL_WASHOUT_POST_ARM_PROTECT_PNL_PCT <
      CFG.FVVO_FEE_ROUND_TRIP_PCT
  ) {
    problems.push("POST_ARM_PROTECT_BELOW_ESTIMATED_FEE");
  }
  if (CFG.STATE_PERSISTENCE_REQUIRED && !persistenceReady) {
    problems.push("PERSISTENCE_NOT_READY");
  }
  return problems;
}

async function ensurePersistence() {
  try {
    await fsp.mkdir(CFG.STATE_DIR, { recursive: true });
    const probe = path.join(
      CFG.STATE_DIR,
      `.brainfvvo-probe-${process.pid}-${Date.now()}-${crypto.randomUUID()}`
    );
    await fsp.writeFile(probe, "ok", { mode: 0o600 });
    await fsp.unlink(probe);
    persistenceReady = true;
    persistenceError = "";
    log("INFO", "FVVO_STATE_PERSISTENCE_READY", {
      statePath: STATE_PATH,
      stateDir: CFG.STATE_DIR,
    });
  } catch (error) {
    persistenceReady = false;
    persistenceError = error.message;
    log("ERROR", "FVVO_STATE_PERSISTENCE_UNAVAILABLE", {
      stateDir: CFG.STATE_DIR,
      error: error.message,
    });
  }
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

async function loadState() {
  if (!persistenceReady) return;

  let loaded = null;
  let source = "";
  try {
    loaded = await readJson(STATE_PATH);
    source = "primary";
  } catch (primaryError) {
    try {
      loaded = await readJson(STATE_BACKUP_PATH);
      source = "backup";
    } catch (_) {
      if (primaryError.code !== "ENOENT") {
        log("WARN", "FVVO_STATE_LOAD_FAILED", { error: primaryError.message });
      }
    }
  }

  if (!loaded) {
    state = defaultState();
    log("INFO", "FVVO_POSITION_STATE_EMPTY", { statePath: STATE_PATH });
    return;
  }

  state = normalizeState(loaded);
  const unresolved = Boolean(
    state.position || state.externalDealLock.active || state.manual.handoffActive
  );

  if (!unresolved) {
    log("INFO", "FVVO_POSITION_STATE_RESTORED", {
      source,
      empty: true,
      schemaVersion: state.schemaVersion,
    });
    return;
  }

  state.manual.recoveryRequired = true;
  state.manual.recoveryReason = state.manual.handoffActive
    ? "MANUAL_HANDOFF_RESTORED"
    : "UNRESOLVED_STATE_RESTORED";
  state.manual.lastAction = "restore";
  state.manual.lastActionAt = nowIso();

  log("WARN", "FVVO_POSITION_STATE_RESTORED", {
    source,
    schemaVersion: state.schemaVersion,
    positionLifecycle: state.position?.lifecycle || null,
    phase: state.position?.phase || null,
    partialStatus: state.position?.partial?.status || null,
    externalDealLockActive: Boolean(state.externalDealLock.active),
    recoveryRequired: true,
  });

  log("WARN", "FVVO_RECOVERY_REQUIRED", {
    reason: state.manual.recoveryReason,
    profile: state.position?.profile || null,
    firstStopPrice: state.position?.firstStopPrice || null,
    finalStopPrice: state.position?.finalStopPrice || null,
    newEntriesBlocked: true,
  });

  await persistState("restore_unresolved_lock");
}

// Every call enters one ordered queue. This prevents multiple webhooks in the
// same millisecond from renaming the same temp file over each other.
function persistState(reason) {
  if (!persistenceReady) {
    persistenceError = "PERSISTENCE_NOT_READY";
    log("ERROR", "FVVO_STATE_SAVE_BLOCKED", {
      reason,
      error: persistenceError,
    });
    return Promise.resolve(false);
  }

  const snapshot = cloneForPersistence(state);
  snapshot.updatedAt = nowIso();
  const sequence = ++persistenceSequence;

  const writeTask = async () => {
    const tempPath = `${STATE_PATH}.tmp-${process.pid}-${Date.now()}-${sequence}-${crypto.randomUUID()}`;
    try {
      const handle = await fsp.open(tempPath, "w", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      try {
        await fsp.copyFile(STATE_PATH, STATE_BACKUP_PATH);
      } catch (_) {
        // First write has no primary file yet. That is expected.
      }

      await fsp.rename(tempPath, STATE_PATH);
      persistenceError = "";
      return true;
    } catch (error) {
      persistenceError = error.message;
      try {
        await fsp.unlink(tempPath);
      } catch (_) {}
      log("ERROR", "FVVO_STATE_SAVE_FAILED", {
        reason,
        sequence,
        error: error.message,
      });
      return false;
    }
  };

  const task = persistenceQueue.then(writeTask, writeTask);
  persistenceQueue = task.catch(() => undefined);
  return task;
}

function ageSec(feature) {
  return feature?.receivedAtMs
    ? Math.max(0, (nowMs() - Number(feature.receivedAtMs)) / 1000)
    : Infinity;
}

function feedSummary(feature) {
  if (!feature) return null;
  return {
    kind: feature.kind,
    price: feature.price,
    ageSec: round(ageSec(feature), 1),
    receivedAt: feature.receivedAt,
    source: feature.src || null,
    publisherKind: feature.publisherKind || null,
    chartTimeframe: feature.chartTimeframe || null,
    barTimeMs: feature.barTimeMs || null,
  };
}

function isFeatureFresh() {
  return (
    state.lastFeature?.kind === CFG.FVVO_FEATURE_TICK_EVENT &&
    ageSec(state.lastFeature) <= CFG.FVVO_STALE_FEATURE_TICK_MAX_AGE_SEC
  );
}

function stateBlocksNewEntry() {
  if (CFG.FVVO_EMERGENCY_DISABLE_NEW_ENTRIES) {
    return "EMERGENCY_NEW_ENTRY_DISABLE";
  }
  if (state.position) return "MANAGED_POSITION_ACTIVE";
  if (state.externalDealLock.active) return "EXTERNAL_DEAL_LOCK_ACTIVE";
  if (state.manual.handoffActive) return "MANUAL_HANDOFF_ACTIVE";
  if (state.manual.recoveryRequired) return "RECOVERY_REQUIRED";
  return "";
}

function positionManagementActive(position) {
  return Boolean(
    position &&
      !state.manual.handoffActive &&
      !String(position.lifecycle || "").startsWith("EXIT_")
  );
}

function activeEmergencyStop(position) {
  if (!position) return { price: null, mode: null, structuralPrice: null, protectedProfitPrice: null };

  if (position.phase !== "RECOVERY_ARMED") {
    return {
      price: finite(position.finalStopPrice, null),
      mode: "FINAL_STRUCTURE_STOP",
      structuralPrice: finite(position.finalStopPrice, null),
      protectedProfitPrice: null,
    };
  }

  const structuralPrice = pctPriceBelow(
    position.entryPriceReference,
    finite(position.postArmCrossStopPct, CFG.FVVO_CROSS_HARD_STOP_PCT)
  );

  const protectedProfitPrice = CFG.MANUAL_WASHOUT_POST_ARM_PROTECT_ENABLED
    ? pctPriceAbove(
        position.entryPriceReference,
        CFG.MANUAL_WASHOUT_POST_ARM_PROTECT_PNL_PCT
      )
    : null;

  if (
    Number.isFinite(protectedProfitPrice) &&
    protectedProfitPrice > structuralPrice
  ) {
    return {
      price: protectedProfitPrice,
      mode: "POST_ARM_PROTECTED_PROFIT_STOP",
      structuralPrice,
      protectedProfitPrice,
    };
  }

  return {
    price: structuralPrice,
    mode: "POST_ARM_CROSS_HARD_STOP",
    structuralPrice,
    protectedProfitPrice,
  };
}

function publicPosition(position) {
  if (!position) return null;
  const emergency = activeEmergencyStop(position);
  return {
    symbol: position.symbol,
    profile: position.profile,
    lifecycle: position.lifecycle,
    phase: position.phase,
    brainExitManagementActive: positionManagementActive(position),
    exchangeFillVerified: Boolean(position.exchangeFillVerified),
    entryPriceReference: position.entryPriceReference,
    entryPriceSource: position.entryPriceSource,

    firstStopPrice: position.firstStopPrice,
    firstStopDistancePct: round(position.firstStopPct, 4),
    finalStopPrice: position.finalStopPrice,
    finalStopDistancePct: round(position.finalStopPct, 4),

    activeEmergencyStopPrice: emergency.price,
    activeEmergencyStopMode: emergency.mode,
    postArmProtectedProfitPrice: emergency.protectedProfitPrice,

    recoveryArmed: Boolean(position.recoveryArmed),
    recoveryArmedAt: position.recoveryArmedAt || null,

    profitTargetPrice: position.profitTargetPrice || null,
    profitTargetDistancePct: position.profitTargetPct || 0,
    targetReached: Boolean(position.targetReached),

    remainingPositionPctAssumed: position.remainingPositionPctAssumed,
    partial: position.partial,
    peakPnlPct: position.peakPnlPct,
    maxFavorableExcursionPct: position.maxFavorableExcursionPct,
    latestPnlPct: position.latestPnlPct,
    latestPrice: position.latestPrice,
    openedAt: position.openedAt,
    exitRequestedAt: position.exitRequestedAt || null,
    exitReason: position.exitReason || null,
  };
}

function statusPayload() {
  return {
    ok: true,
    brain: CFG.BRAIN_NAME,
    symbol: CFG.SYMBOL,
    demoOnly: true,
    automaticEntriesEnabled: false,
    entryProfileAllowed: PROFILE,
    forwarding: {
      allowed: isForwardAllowed(),
      dryRun: CFG.C3_DRY_RUN,
      liveForwardAllowed: false,
      c3CustomSignalSchema: "ISO8601_TIMESTAMP_TRIGGER_PRICE",
      c3EntryOrder: {
        explicitWebhookMarketRequired: CFG.C3_ENTRY_WEBHOOK_MARKET_REQUIRED,
        amount: CFG.C3_ENTRY_ORDER_AMOUNT || null,
        currencyType: CFG.C3_ENTRY_ORDER_CURRENCY_TYPE,
        orderType: CFG.C3_ENTRY_ORDER_TYPE,
        requiredBotEntryMode: "SEND_IN_WEBHOOK_QUOTE",
      },
      c3ExitIncludesPositionPercentOrder: CFG.C3_EXIT_INCLUDE_POSITION_ORDER,
    },
    persistence: {
      ready: persistenceReady,
      statePath: STATE_PATH,
      lastError: persistenceError || null,
      queuedWrites: persistenceSequence,
    },
    latestFeature: feedSummary(state.lastFeature),
    feeds: {
      featureTick: feedSummary(state.lastFeature),
      feature5m: feedSummary(state.lastFeature5m),
      fastTick: feedSummary(state.lastFastTick),
      freshForManualEntry: isFeatureFresh(),
    },
    position: publicPosition(state.position),
    externalDealLockActive: Boolean(state.externalDealLock.active),
    manualState: {
      handoffActive: Boolean(state.manual.handoffActive),
      recoveryRequired: Boolean(state.manual.recoveryRequired),
      recoveryReason: state.manual.recoveryReason || null,
      lastAction: state.manual.lastAction || null,
      lastActionAt: state.manual.lastActionAt || null,
    },
    entryBlockReason: stateBlocksNewEntry() || null,
  };
}

function normalizeFeature(payload, expectedEvent) {
  const event = String(payload.event || payload.type || payload.src || "").trim();
  const kind = expectedEvent || event;
  const rayRegime = String(
    payload.gateRayRegime ||
      payload.context5mRayRegime ||
      payload.rayRegime ||
      payload.ray_regime ||
      payload.rayRaw ||
      ""
  )
    .trim()
    .toUpperCase();

  return {
    kind,
    event,
    src: String(payload.src || "").trim(),
    intent: String(payload.intent || "").trim(),
    publisherKind: String(payload.publisherKind || payload.publisher_kind || "").trim(),
    publisherVersion: String(payload.publisherVersion || payload.publisher_version || "").trim(),
    chartTimeframe: String(payload.chartTimeframe || payload.chart_timeframe || "").trim(),
    barTimeMs: firstFinite(payload.barTimeMs, payload.bar_time_ms, payload.time),
    barConfirmed: asBool(payload.barConfirmed ?? payload.bar_confirmed, false),

    symbol: cleanSymbol(
      payload.symbol || payload.tv_symbol || payload.instrument || CFG.SYMBOL
    ),
    price: firstFinite(
      payload.price,
      payload.close,
      payload.last,
      payload.markPrice,
      payload.mark_price
    ),
    close: firstFinite(payload.close, payload.price, payload.last),
    high: firstFinite(payload.high, payload.price, payload.close),
    low: firstFinite(payload.low, payload.price, payload.close),
    ema8: firstFinite(payload.ema8, payload.ema_8),
    ema18: firstFinite(payload.ema18, payload.ema_18),
    rsi: firstFinite(payload.rsi),
    adx: firstFinite(payload.adx),
    fvvo: firstFinite(payload.fvvo, payload.fvvoValue, payload.fvvo_value),
    contextFvvo: firstFinite(
      payload.context5mFvvo,
      payload.context_fvvo,
      payload.ctxFvvo,
      payload.fvvo5m
    ),
    slope: firstFinite(payload.slope, payload.fvvoSlope, payload.fvvo_slope),
    crossDown: asBool(
      payload.crossDown ?? payload.fvvoCrossDown ?? payload.cross_down,
      false
    ),
    redPulse: asBool(
      payload.redPulse ?? payload.fvvoRedPulse ?? payload.redDot ?? payload.red_pulse,
      false
    ),
    rayRegime,
    rayBull: asBool(
      payload.rayBull ?? payload.tickRayBull,
      rayRegime === "RAY_BULL"
    ),
    receivedAt: nowIso(),
    receivedAtMs: nowMs(),
  };
}

function updateLatestFeature(feature) {
  if (!Number.isFinite(feature.price) || feature.price <= 0) return false;

  if (feature.kind === CFG.FVVO_FEATURE_TICK_EVENT) {
    state.lastFeature = feature;
    return true;
  }

  if (feature.kind === CFG.FVVO_FEATURE_5M_EVENT) {
    state.lastFeature5m = feature;
    return true;
  }

  if (feature.kind === CFG.FVVO_FAST_TICK_EVENT) {
    state.lastFastTick = feature;
    return true;
  }

  return false;
}

function validPriceStep(value) {
  if (!Number.isFinite(value) || value <= 0) return false;
  const units = value / CFG.MANUAL_WASHOUT_PRICE_STEP;
  return Math.abs(units - Math.round(units)) < 1e-7;
}

function hasLegacyPercentageFields(body) {
  return [
    "first_stop_pct",
    "firstStopPct",
    "initial_stop_pct",
    "initialStopPct",
    "final_stop_pct",
    "finalStopPct",
    "second_stop_pct",
    "secondStopPct",
    "profit_target_pct",
    "profitTargetPct",
    "target_pct",
    "targetPct",
  ].some((key) => Object.prototype.hasOwnProperty.call(body, key));
}

function absoluteInput(body, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(body, name)) {
      return { present: true, value: finite(body[name], null) };
    }
  }
  return { present: false, value: null };
}

function validateAbsoluteLadder(body, entryPrice, requireStops = true) {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return { ok: false, error: "VALID_ENTRY_REFERENCE_REQUIRED_FOR_ABSOLUTE_LEVELS" };
  }

  if (hasLegacyPercentageFields(body)) {
    return {
      ok: false,
      error:
        "USE_FIRST_STOP_PRICE_FINAL_STOP_PRICE_AND_OPTIONAL_PROFIT_TARGET_PRICE_NOT_PERCENT_FIELDS",
    };
  }

  const first = absoluteInput(body, ["first_stop_price", "firstStopPrice"]);
  const final = absoluteInput(body, ["final_stop_price", "finalStopPrice"]);
  const target = absoluteInput(body, [
    "profit_target_price",
    "profitTargetPrice",
    "target_price",
    "targetPrice",
  ]);

  if (
    requireStops &&
    CFG.MANUAL_WASHOUT_REQUIRE_ABSOLUTE_STOP_PRICES &&
    (!first.present || !final.present)
  ) {
    return {
      ok: false,
      error: "FIRST_STOP_PRICE_AND_FINAL_STOP_PRICE_REQUIRED",
    };
  }

  if (!first.present || !final.present) {
    return {
      ok: false,
      error: "FIRST_STOP_PRICE_AND_FINAL_STOP_PRICE_REQUIRED",
    };
  }

  if (!Number.isFinite(first.value) || !Number.isFinite(final.value)) {
    return { ok: false, error: "VALID_ABSOLUTE_STOP_PRICES_REQUIRED" };
  }

  if (!validPriceStep(first.value) || !validPriceStep(final.value)) {
    return {
      ok: false,
      error: "STOP_PRICE_NOT_ALIGNED_TO_MANUAL_WASHOUT_PRICE_STEP",
    };
  }

  if (first.value >= entryPrice) {
    return { ok: false, error: "FIRST_STOP_PRICE_MUST_BE_BELOW_ENTRY_REFERENCE" };
  }

  if (final.value >= first.value) {
    return {
      ok: false,
      error: "FINAL_STOP_PRICE_MUST_BE_BELOW_FIRST_STOP_PRICE",
    };
  }

  const firstStopPct = percentageBelow(entryPrice, first.value);
  const finalStopPct = percentageBelow(entryPrice, final.value);
  const stopGapPct = finalStopPct - firstStopPct;

  if (finalStopPct > CFG.MANUAL_WASHOUT_MAX_STOP_DISTANCE_PCT + 1e-9) {
    return {
      ok: false,
      error: "FINAL_STOP_DISTANCE_EXCEEDS_MANUAL_WASHOUT_MAX_STOP_DISTANCE_PCT",
    };
  }

  if (stopGapPct < CFG.MANUAL_WASHOUT_MIN_STOP_GAP_PCT - 1e-9) {
    return {
      ok: false,
      error: "FINAL_STOP_MUST_BE_AT_LEAST_MIN_STOP_GAP_PCT_WIDER_THAN_FIRST_STOP",
    };
  }

  let profitTargetPrice = 0;
  let profitTargetPct = 0;

  if (target.present && target.value !== 0) {
    if (!Number.isFinite(target.value) || !validPriceStep(target.value)) {
      return {
        ok: false,
        error: "PROFIT_TARGET_PRICE_NOT_ALIGNED_TO_MANUAL_WASHOUT_PRICE_STEP",
      };
    }

    if (target.value <= entryPrice) {
      return {
        ok: false,
        error: "PROFIT_TARGET_PRICE_MUST_BE_ABOVE_ENTRY_REFERENCE_OR_ZERO",
      };
    }

    profitTargetPct = percentPnl(entryPrice, target.value);
    if (
      profitTargetPct >
      CFG.MANUAL_WASHOUT_MAX_TARGET_DISTANCE_PCT + 1e-9
    ) {
      return {
        ok: false,
        error: "PROFIT_TARGET_DISTANCE_EXCEEDS_MANUAL_WASHOUT_MAX_TARGET_DISTANCE_PCT",
      };
    }

    profitTargetPrice = target.value;
  }

  return {
    ok: true,
    firstStopPrice: round(first.value, 8),
    finalStopPrice: round(final.value, 8),
    profitTargetPrice: round(profitTargetPrice, 8),
    firstStopPct: round(firstStopPct, 6),
    finalStopPct: round(finalStopPct, 6),
    profitTargetPct: round(profitTargetPct, 6),
    stopGapPct: round(stopGapPct, 6),
  };
}

function allowedProfile(value) {
  return (
    String(value || CFG.MANUAL_ENTRY_DEFAULT_PROFILE).trim().toUpperCase() ===
    PROFILE
  );
}

function buildPosition(entryPrice, source, lifecycle, ladder) {
  return {
    symbol: CFG.SYMBOL,
    profile: PROFILE,
    lifecycle,
    phase: "DEFENSIVE",
    recoveryArmed: false,
    recoveryArmedAt: null,

    entryPriceReference: entryPrice,
    entryPriceSource: source,
    exchangeFillVerified: false,
    openedAt: nowIso(),
    openedAtMs: nowMs(),
    entryAcceptedAt: null,

    firstStopPrice: ladder.firstStopPrice,
    firstStopPct: ladder.firstStopPct,
    finalStopPrice: ladder.finalStopPrice,
    finalStopPct: ladder.finalStopPct,
    postArmCrossStopPct: CFG.FVVO_CROSS_HARD_STOP_PCT,

    profitTargetPrice: ladder.profitTargetPrice,
    profitTargetPct: ladder.profitTargetPct,
    targetReached: false,
    targetReachedAt: null,

    firstStop: { breachAtMs: 0, observations: 0, lastBreachPrice: null },
    partial: {
      status: "NONE",
      requestedPct: CFG.MANUAL_WASHOUT_PARTIAL_EXIT_PCT,
      requestedAt: null,
      requestId: null,
      acceptedAt: null,
      error: null,
    },
    remainingPositionPctAssumed: 100,

    peakPnlPct: 0,
    maxFavorableExcursionPct: 0,
    latestPnlPct: 0,
    latestPrice: entryPrice,

    exitRequestedAt: null,
    exitReason: null,
  };
}

function dynamicGivebackLimit(peakPnlPct, targetReached) {
  const extra = Math.max(
    0,
    peakPnlPct - CFG.FVVO_CROSS_DYNAMIC_TRAIL_ARM_PCT
  );
  let limit = Math.max(
    CFG.FVVO_CROSS_DYNAMIC_TRAIL_MIN_GIVEBACK_PCT,
    CFG.FVVO_CROSS_DYNAMIC_TRAIL_START_GIVEBACK_PCT -
      extra * CFG.FVVO_CROSS_DYNAMIC_TRAIL_TIGHTEN_PER_1PCT
  );
  if (targetReached) {
    limit = Math.min(limit, CFG.MANUAL_WASHOUT_TARGET_TRAIL_MAX_GIVEBACK_PCT);
  }
  return limit;
}

function featureSoftSignal(feature, isFiveMinute) {
  const belowEma8 =
    Number.isFinite(feature.ema8) &&
    Number.isFinite(feature.close) &&
    feature.close < feature.ema8;
  const hardDownSlope =
    Number.isFinite(feature.slope) &&
    feature.slope <= CFG.FVVO_CROSS_HARD_DOWN_SLOPE;
  const fvvoWeak = Number.isFinite(feature.fvvo) && feature.fvvo <= 0;

  if (isFiveMinute) {
    return {
      triggered:
        belowEma8 &&
        (feature.crossDown || feature.redPulse || fvvoWeak || hardDownSlope),
      reason: "FVVO_CROSS_5M_BACKUP_FEE_AWARE",
      belowEma8,
      hardDownSlope,
      fvvoWeak,
    };
  }

  return {
    triggered:
      (CFG.FVVO_CROSS_EXIT_ON_RED_PULSE && feature.redPulse) ||
      (CFG.FVVO_CROSS_EXIT_ON_CROSS_DOWN && feature.crossDown) ||
      (belowEma8 && (fvvoWeak || hardDownSlope)),
    reason: "FVVO_CROSS_FEATURE_SOFT_EXIT_FEE_AWARE",
    belowEma8,
    hardDownSlope,
    fvvoWeak,
  };
}

function rayBullHoldActive(position, feature) {
  if (
    !CFG.MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_ENABLED ||
    position.phase !== "RECOVERY_ARMED"
  ) {
    return false;
  }

  const elapsedSec =
    (nowMs() -
      Number(position.recoveryArmedAtMs || position.openedAtMs || nowMs())) /
    1000;

  if (elapsedSec > CFG.MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_SEC) return false;
  if (!feature.rayBull && feature.rayRegime !== "RAY_BULL") return false;

  if (
    CFG.MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_REQUIRE_PRICE_ABOVE_EMA18 &&
    (!Number.isFinite(feature.ema18) || feature.price < feature.ema18)
  ) {
    return false;
  }

  if (
    CFG.MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_REQUIRE_FVVO_ABOVE_ZERO &&
    (!Number.isFinite(feature.fvvo) || feature.fvvo <= 0)
  ) {
    return false;
  }

  return true;
}

function squeezeHoldActive(position, feature, pnl) {
  if (
    !CFG.MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_ENABLED ||
    position.phase !== "RECOVERY_ARMED"
  ) {
    return false;
  }

  if (pnl < CFG.MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_MIN_PNL_PCT) {
    return false;
  }

  const fvvoContext = Number.isFinite(feature.contextFvvo)
    ? feature.contextFvvo
    : feature.fvvo;

  if (
    !Number.isFinite(fvvoContext) ||
    fvvoContext < CFG.MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_CTX_MIN_FVVO
  ) {
    return false;
  }

  if (!Number.isFinite(feature.ema18)) return false;

  return (
    percentageBelow(feature.ema18, feature.price) <=
    CFG.MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_MAX_BELOW_EMA18_PCT
  );
}

function c3NumberString(value, decimals = CFG.C3_TRIGGER_PRICE_DECIMALS) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return String(round(numeric, decimals));
}

function c3OrderForAction(action, options = {}) {
  if (action === "enter_long") {
    if (CFG.C3_ENTRY_WEBHOOK_MARKET_REQUIRED && CFG.C3_ENTRY_ORDER_AMOUNT <= 0) {
      throw new Error("C3_ENTRY_ORDER_AMOUNT_MUST_BE_GT_ZERO_FOR_EXPLICIT_WEBHOOK_MARKET_ENTRY");
    }
    if (CFG.C3_ENTRY_ORDER_AMOUNT > 0) {
      return {
        amount: CFG.C3_ENTRY_ORDER_AMOUNT,
        currency_type: CFG.C3_ENTRY_ORDER_CURRENCY_TYPE,
        order_type: CFG.C3_ENTRY_ORDER_TYPE,
      };
    }
  }

  if (
    action === "exit_long" &&
    CFG.C3_EXIT_INCLUDE_POSITION_ORDER &&
    Number.isFinite(options.positionPercent)
  ) {
    return {
      amount: options.positionPercent,
      currency_type: "position_percent",
    };
  }

  return null;
}

function build3CommasCustomSignal(action, price, options = {}, current = nowMs()) {
  const triggerPrice = c3NumberString(price);
  if (!triggerPrice) {
    throw new Error("C3_TRIGGER_PRICE_INVALID");
  }

  const body = {
    // Exact Custom Signal schema base: timestamp is ISO-8601 (not Unix
    // seconds/milliseconds). trigger_price makes every request auditable.
    // v1e additionally makes the entry order explicit through c3OrderForAction.
    secret: CFG.C3_SIGNAL_SECRET,
    max_lag: String(Math.floor(CFG.C3_MAX_LAG_SEC)),
    timestamp: new Date(current).toISOString(),
    trigger_price: triggerPrice,
    tv_exchange: "BINANCE",
    tv_instrument: "SOLUSDT",
    action,
    bot_uuid: getBotUuid(),
  };

  const order = c3OrderForAction(action, options);
  if (order) body.order = order;

  // 3Commas Signal Bot takes the final stop as a percentage, therefore this
  // derives it from the chart-defined absolute final support price.
  if (
    action === "enter_long" &&
    CFG.C3_NATIVE_FINAL_STOP_ENABLED &&
    Number.isFinite(options.finalStopPct)
  ) {
    body.stop_loss = {
      enabled: true,
      breakeven: false,
      order_type: "market",
      trigger_price_percent: round(options.finalStopPct, 6),
      trailing: { enabled: false },
    };
  }

  return body;
}

async function forward3Commas(action, price, reason, options = {}) {
  const requestId = crypto.randomUUID();
  const dedupeKey = options.dedupeKey || `${action}:${options.positionPercent || "full"}`;
  const current = nowMs();
  const lastAt = finite(state.forward.lastByKey?.[dedupeKey], 0);

  if (
    !options.bypassDedupe &&
    current - lastAt < CFG.C3_FORWARD_DEDUP_MS
  ) {
    return { ok: false, deduped: true, error: "C3_FORWARD_DEDUP_ACTIVE", requestId };
  }

  if (!isForwardAllowed()) {
    return { ok: false, error: "FORWARDING_NOT_ALLOWED", requestId };
  }

  let body;
  try {
    body = build3CommasCustomSignal(action, price, options, current);
  } catch (error) {
    log("ERROR", "C3_PAYLOAD_BUILD_FAILED", {
      action,
      reason,
      requestId,
      error: error.message,
    });
    return { ok: false, error: error.message, requestId };
  }

  state.forward.lastByKey = {
    ...(state.forward.lastByKey || {}),
    [dedupeKey]: current,
  };
  state.forward.lastRequestId = requestId;
  await persistState(`c3_${dedupeKey}_requested`);

  log("INFO", "C3_FORWARD_SEND", {
    action,
    reason,
    symbol: CFG.SYMBOL,
    price,
    positionPercent: options.positionPercent || null,
    finalStopPct: options.finalStopPct || null,
    requestId,
    c3Timestamp: body.timestamp,
    triggerPrice: body.trigger_price,
    hasOrder: Boolean(body.order),
    dryRun: CFG.C3_DRY_RUN,
  });

  if (CFG.C3_PAYLOAD_AUDIT_ENABLED) {
    log("INFO", "C3_FORWARD_PAYLOAD_AUDIT", {
      requestId,
      action,
      reason,
      schema: "CUSTOM_SIGNAL_ISO8601_TRIGGER_PRICE_EXPLICIT_MARKET_ENTRY",
      body: { ...body, secret: "REDACTED" },
    });
  }

  if (CFG.C3_DRY_RUN) {
    log("INFO", "C3_FORWARD_DRY_RUN", {
      action,
      reason,
      requestId,
      body: { ...body, secret: "REDACTED" },
    });
    return {
      ok: true,
      accepted: true,
      dryRun: true,
      requestId,
      status: 200,
      c3Timestamp: body.timestamp,
      triggerPrice: body.trigger_price,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.C3_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(CFG.C3_SIGNAL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const responseText = (await response.text()).slice(0, 500);
    if (!response.ok) {
      log("ERROR", "C3_FORWARD_REJECTED", {
        action,
        reason,
        status: response.status,
        requestId,
        responseText,
      });
      return {
        ok: false,
        error: `C3_HTTP_${response.status}`,
        requestId,
        status: response.status,
      };
    }

    log("INFO", "C3_FORWARD_ACCEPTED_UNVERIFIED", {
      action,
      reason,
      status: response.status,
      requestId,
      responseText,
    });
    return {
      ok: true,
      accepted: true,
      requestId,
      status: response.status,
      c3Timestamp: body.timestamp,
      triggerPrice: body.trigger_price,
    };
  } catch (error) {
    const label = error.name === "AbortError" ? "C3_TIMEOUT" : "C3_NETWORK_ERROR";
    log("ERROR", label, {
      action,
      reason,
      requestId,
      error: error.message,
    });
    return { ok: false, error: label, requestId };
  } finally {
    clearTimeout(timer);
  }
}

async function beginManualEnter(body) {
  const configIssue = configProblems()[0];
  if (configIssue) return { status: 503, body: { ok: false, error: configIssue } };

  if (!CFG.MANUAL_ALLOW_ENTER) {
    return { status: 403, body: { ok: false, error: "MANUAL_ENTER_DISABLED" } };
  }

  if (!CFG.MANUAL_WASHOUT_PROFILE_ENABLED) {
    return {
      status: 403,
      body: { ok: false, error: "MANUAL_WASHOUT_PROFILE_DISABLED" },
    };
  }

  if (!allowedProfile(body.profile)) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "ONLY_MANUAL_WASHOUT_TWO_LEVEL_RECOVERY_PROFILE_ALLOWED",
      },
    };
  }

  if (
    ["price", "entry_price", "entryPrice"].some((key) =>
      Object.prototype.hasOwnProperty.call(body, key)
    )
  ) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "MANUAL_ENTRY_PRICE_FIELD_NOT_ALLOWED_USE_LATEST_FEATURE_PRICE",
      },
    };
  }

  const blockReason = stateBlocksNewEntry();
  if (blockReason) {
    return {
      status: 409,
      body: { ok: false, error: blockReason, status: statusPayload() },
    };
  }

  if (CFG.MANUAL_REQUIRE_FRESH_FEATURE_TICK && !isFeatureFresh()) {
    return {
      status: 409,
      body: {
        ok: false,
        error: "FRESH_FEATURE_TICK_REQUIRED",
        featureAgeSec: ageSec(state.lastFeature),
      },
    };
  }

  const entryPrice = finite(state.lastFeature?.price, null);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return {
      status: 409,
      body: { ok: false, error: "NO_VALID_FRESH_FEATURE_PRICE" },
    };
  }

  const ladder = validateAbsoluteLadder(body, entryPrice, true);
  if (!ladder.ok) {
    return { status: 400, body: { ok: false, error: ladder.error } };
  }

  state.position = buildPosition(
    entryPrice,
    "LATEST_FRESH_FEATURE_TICK",
    "ENTRY_PENDING_FORWARD",
    ladder
  );
  state.externalDealLock = {
    active: true,
    source: "manual_enter",
    setAt: nowIso(),
    reason: "ENTRY_REQUEST_PENDING",
  };
  state.manual = {
    ...state.manual,
    handoffActive: false,
    recoveryRequired: false,
    recoveryReason: "",
    lastAction: "enter_long",
    lastActionAt: nowIso(),
  };

  if (!(await persistState("manual_enter_pre_forward"))) {
    return {
      status: 503,
      body: { ok: false, error: "STATE_PERSISTENCE_FAILED_BEFORE_ENTRY" },
    };
  }

  log("INFO", "FVVO_TRADE_OPEN_PENDING", {
    profile: PROFILE,
    entryPriceReference: entryPrice,
    firstStopPrice: ladder.firstStopPrice,
    finalStopPrice: ladder.finalStopPrice,
    profitTargetPrice: ladder.profitTargetPrice || null,
  });

  const outcome = await forward3Commas(
    "enter_long",
    entryPrice,
    "MANUAL_WASHOUT_ENTER_LATEST_FEATURE_PRICE",
    {
      dedupeKey: "enter_long",
      finalStopPct: ladder.finalStopPct,
    }
  );

  if (!outcome.ok) {
    state.position.lifecycle = "ENTRY_UNKNOWN_AFTER_FORWARD_ERROR";
    state.manual.recoveryRequired = true;
    state.manual.recoveryReason = `ENTRY_FORWARD_UNCERTAIN_${outcome.error}`;
    state.externalDealLock.reason = "ENTRY_FORWARD_UNCERTAIN";
    await persistState("manual_enter_forward_uncertain");
    log("WARN", "FVVO_RECOVERY_REQUIRED", {
      reason: state.manual.recoveryReason,
      requestId: outcome.requestId,
      newEntriesBlocked: true,
    });
    return {
      status: 502,
      body: {
        ok: false,
        error: outcome.error,
        requestId: outcome.requestId,
        externalDealLockActive: true,
        recoveryRequired: true,
      },
    };
  }

  state.position.lifecycle = "ENTRY_ACCEPTED_UNVERIFIED_FILL";
  state.position.entryForwardRequestId = outcome.requestId;
  state.position.entryAcceptedAt = nowIso();
  state.position.entryAcceptedAtMs = nowMs();
  state.externalDealLock.reason = "ENTRY_ACCEPTED_UNVERIFIED_FILL";
  await persistState("manual_enter_accepted");

  log("INFO", "FVVO_MANUAL_WASHOUT_ENTRY_TRACKED", {
    entryPriceReference: entryPrice,
    firstStopPrice: ladder.firstStopPrice,
    firstStopDistancePct: ladder.firstStopPct,
    finalStopPrice: ladder.finalStopPrice,
    finalStopDistancePct: ladder.finalStopPct,
    profitTargetPrice: ladder.profitTargetPrice || null,
    profitTargetDistancePct: ladder.profitTargetPct,
    nativeFinalStopSent: CFG.C3_NATIVE_FINAL_STOP_ENABLED,
    requestId: outcome.requestId,
    fillVerified: false,
  });

  return {
    status: 200,
    body: {
      ok: true,
      forwarded: true,
      acceptedBy3CommasWebhook: true,
      exchangeFillVerified: false,
      brainWillManageExit: true,
      manualEntryTracked: true,
      externalDealLockActive: true,
      profile: PROFILE,
      entryPriceReference: entryPrice,
      firstStopPrice: ladder.firstStopPrice,
      firstStopDistancePct: ladder.firstStopPct,
      finalStopPrice: ladder.finalStopPrice,
      finalStopDistancePct: ladder.finalStopPct,
      profitTargetPrice: ladder.profitTargetPrice || null,
      profitTargetDistancePct: ladder.profitTargetPct,
      requestId: outcome.requestId,
    },
  };
}

async function requestPartialExit(reason, price, origin) {
  const position = state.position;
  if (!position) return { ok: false, error: "NO_MANAGED_POSITION" };
  if (position.partial?.status !== "NONE") {
    return { ok: false, error: "PARTIAL_EXIT_ALREADY_REQUESTED" };
  }
  if (!CFG.C3_PARTIAL_EXIT_ENABLED) {
    return { ok: false, error: "C3_PARTIAL_EXIT_DISABLED" };
  }

  position.partial = {
    ...position.partial,
    status: "PARTIAL_PENDING_FORWARD",
    requestedAt: nowIso(),
    requestedAtMs: nowMs(),
    reason,
    requestedPrice: price,
    requestedPct: CFG.MANUAL_WASHOUT_PARTIAL_EXIT_PCT,
  };
  await persistState("partial_exit_pre_forward");

  log("WARN", "FVVO_PARTIAL_EXIT_DECISION", {
    reason,
    origin,
    price,
    requestedPct: CFG.MANUAL_WASHOUT_PARTIAL_EXIT_PCT,
    firstStopPrice: position.firstStopPrice,
  });

  const outcome = await forward3Commas("exit_long", price, reason, {
    positionPercent: CFG.MANUAL_WASHOUT_PARTIAL_EXIT_PCT,
    dedupeKey: "exit_long_partial_50",
  });

  if (!outcome.ok) {
    position.partial.status = "PARTIAL_UNKNOWN_AFTER_FORWARD_ERROR";
    position.partial.error = outcome.error;
    state.manual.recoveryRequired = true;
    state.manual.recoveryReason = `PARTIAL_EXIT_FORWARD_UNCERTAIN_${outcome.error}`;
    await persistState("partial_exit_forward_uncertain");
    log("WARN", "FVVO_RECOVERY_REQUIRED", {
      reason: state.manual.recoveryReason,
      origin,
      requestId: outcome.requestId,
      newEntriesBlocked: true,
      fullExitStillAllowed: true,
    });
    return outcome;
  }

  position.partial.status = "PARTIAL_ACCEPTED_UNVERIFIED";
  position.partial.requestId = outcome.requestId;
  position.partial.acceptedAt = nowIso();
  position.remainingPositionPctAssumed =
    100 - CFG.MANUAL_WASHOUT_PARTIAL_EXIT_PCT;
  await persistState("partial_exit_accepted");

  log("WARN", "FVVO_MANUAL_PARTIAL_EXIT_ACCEPTED_UNVERIFIED", {
    reason,
    origin,
    price,
    requestedPct: CFG.MANUAL_WASHOUT_PARTIAL_EXIT_PCT,
    assumedRemainingPct: position.remainingPositionPctAssumed,
    requestId: outcome.requestId,
    exchangePartialFillVerified: false,
  });

  return { ...outcome, partialUnverified: true };
}

async function requestFullExit(reason, price, origin) {
  const position = state.position;
  if (!position) return { ok: false, error: "NO_MANAGED_POSITION" };
  if (state.manual.handoffActive) {
    return { ok: false, error: "MANUAL_HANDOFF_ACTIVE" };
  }
  if (String(position.lifecycle).startsWith("EXIT_")) {
    return { ok: false, error: "EXIT_ALREADY_REQUESTED" };
  }

  log("WARN", "FVVO_EXIT_DECISION", {
    reason,
    origin,
    price,
    phase: position.phase,
    entryPrice: position.entryPriceReference,
    latestPnlPct: round(position.latestPnlPct, 4),
    peakPnlPct: round(position.peakPnlPct, 4),
    activeEmergencyStop: activeEmergencyStop(position),
  });

  const outcome = await forward3Commas("exit_long", price, reason, {
    positionPercent: 100,
    dedupeKey: "exit_long_full_100",
    bypassDedupe: true,
  });

  if (!outcome.ok) {
    position.lifecycle = "EXIT_UNKNOWN_AFTER_FORWARD_ERROR";
    position.exitRequestedAt = nowIso();
    position.exitReason = reason;
    state.manual.recoveryRequired = true;
    state.manual.recoveryReason = `EXIT_FORWARD_UNCERTAIN_${outcome.error}`;
    await persistState("full_exit_forward_uncertain");
    log("WARN", "FVVO_RECOVERY_REQUIRED", {
      reason: state.manual.recoveryReason,
      origin,
      requestId: outcome.requestId,
      newEntriesBlocked: true,
    });
    return outcome;
  }

  position.lifecycle = "EXIT_ACCEPTED_UNVERIFIED_CLOSE";
  position.exitRequestedAt = nowIso();
  position.exitReason = reason;
  position.exitRequestPrice = price;
  position.exitForwardRequestId = outcome.requestId;

  state.manual.recoveryRequired = !CFG.C3_ASSUME_EXIT_ACCEPTANCE;
  state.manual.recoveryReason = CFG.C3_ASSUME_EXIT_ACCEPTANCE
    ? ""
    : "EXIT_ACCEPTED_UNVERIFIED_CLOSE";
  state.externalDealLock = {
    active: !CFG.C3_ASSUME_EXIT_ACCEPTANCE,
    source: "brain_full_exit",
    setAt: nowIso(),
    reason: CFG.C3_ASSUME_EXIT_ACCEPTANCE
      ? "EXIT_ASSUMED_CLOSED_BY_CONFIG"
      : "EXIT_ACCEPTED_UNVERIFIED_CLOSE",
  };

  if (CFG.C3_ASSUME_EXIT_ACCEPTANCE) state.position = null;

  await persistState("full_exit_accepted");
  log("INFO", "FVVO_FULL_EXIT_SIGNAL_ACCEPTED_UNVERIFIED", {
    origin,
    reason,
    price,
    requestId: outcome.requestId,
    exchangeCloseVerified: false,
    recoveryRequired: !CFG.C3_ASSUME_EXIT_ACCEPTANCE,
  });

  return { ...outcome, exitUnverified: !CFG.C3_ASSUME_EXIT_ACCEPTANCE };
}

function firstStopBreakConfirmed(position, feature, markPrice) {
  if (position.partial?.status !== "NONE") {
    return { confirmed: false, reason: "PARTIAL_ALREADY_REQUESTED" };
  }

  if (markPrice > position.firstStopPrice) {
    if (position.firstStop?.observations) {
      position.firstStop = {
        breachAtMs: 0,
        observations: 0,
        lastBreachPrice: null,
      };
    }
    return { confirmed: false, reason: "ABOVE_FIRST_STOP" };
  }

  if (
    feature.kind === CFG.FVVO_FEATURE_5M_EVENT &&
    CFG.MANUAL_WASHOUT_FIRST_STOP_5M_CLOSE_IMMEDIATE &&
    Number.isFinite(feature.close) &&
    feature.close <= position.firstStopPrice
  ) {
    return { confirmed: true, reason: "FIRST_STOP_5M_CLOSE_BREAK" };
  }

  const current = nowMs();
  if (!position.firstStop?.breachAtMs) {
    position.firstStop = {
      breachAtMs: current,
      observations: 1,
      lastBreachPrice: markPrice,
    };
  } else {
    position.firstStop.observations =
      Number(position.firstStop.observations || 0) + 1;
    position.firstStop.lastBreachPrice = markPrice;
  }

  const elapsed = (current - position.firstStop.breachAtMs) / 1000;
  const observations = Number(position.firstStop.observations || 0);

  return {
    confirmed:
      observations >= CFG.MANUAL_WASHOUT_FIRST_STOP_CONFIRM_OBSERVATIONS &&
      elapsed >= CFG.MANUAL_WASHOUT_FIRST_STOP_CONFIRM_SEC,
    reason: "FIRST_STOP_TICK_CONFIRM",
    elapsedSec: elapsed,
    observations,
  };
}

function recoveryCanArm(position, feature, pnl) {
  if (pnl < CFG.MANUAL_WASHOUT_RECOVERY_ARM_MFE_PCT) return false;

  if (
    CFG.MANUAL_WASHOUT_ARM_REQUIRE_ABOVE_EMA8 &&
    (!Number.isFinite(feature.ema8) || feature.price < feature.ema8)
  ) {
    return false;
  }

  if (
    CFG.MANUAL_WASHOUT_ARM_REQUIRE_FVVO_ABOVE_ZERO &&
    (!Number.isFinite(feature.fvvo) || feature.fvvo <= 0)
  ) {
    return false;
  }

  if (
    Number.isFinite(feature.slope) &&
    feature.slope <= CFG.MANUAL_WASHOUT_ARM_MAX_DOWN_SLOPE
  ) {
    return false;
  }

  return true;
}

function entryGraceActive(position) {
  return (
    position.entryAcceptedAtMs &&
    nowMs() - Number(position.entryAcceptedAtMs) <
      CFG.MANUAL_ENTRY_EXIT_GRACE_SEC * 1000
  );
}

async function manageExit(feature) {
  const position = state.position;
  if (
    !position ||
    state.manual.handoffActive ||
    String(position.lifecycle).startsWith("EXIT_")
  ) {
    return;
  }

  const markPrice = firstFinite(feature.price, feature.close);
  if (!Number.isFinite(markPrice) || markPrice <= 0) return;

  const entry = position.entryPriceReference;
  const pnl = percentPnl(entry, markPrice);
  position.latestPrice = markPrice;
  position.latestPnlPct = pnl;
  position.peakPnlPct = Math.max(Number(position.peakPnlPct || 0), pnl);
  position.maxFavorableExcursionPct = Math.max(
    Number(position.maxFavorableExcursionPct || 0),
    pnl
  );

  const peak = position.peakPnlPct;
  const giveback = Math.max(0, peak - pnl);

  if (
    !position.targetReached &&
    position.profitTargetPrice > 0 &&
    peak >= position.profitTargetPct
  ) {
    position.targetReached = true;
    position.targetReachedAt = nowIso();
    log("INFO", "FVVO_MANUAL_TARGET_REACHED", {
      targetPrice: position.profitTargetPrice,
      targetPct: round(position.profitTargetPct, 4),
      peakPnlPct: round(peak, 4),
      noForcedExit: true,
    });
  }

  const emergency = activeEmergencyStop(position);
  if (Number.isFinite(emergency.price) && markPrice <= emergency.price) {
    await persistState(`emergency_stop_${feature.kind}`);

    let reason = "FVVO_MANUAL_FINAL_SUPPORT_HARD_STOP";
    if (emergency.mode === "POST_ARM_PROTECTED_PROFIT_STOP") {
      reason = "FVVO_POST_ARM_PROTECTED_PROFIT_STOP";
    } else if (position.phase === "RECOVERY_ARMED") {
      reason = "FVVO_CROSS_POST_ARM_UNIFIED_HARD_STOP";
    }

    await requestFullExit(reason, markPrice, feature.kind);
    return;
  }

  if (entryGraceActive(position)) {
    await persistState(`entry_grace_${feature.kind}`);
    return;
  }

  if (position.phase !== "RECOVERY_ARMED") {
    const first = firstStopBreakConfirmed(position, feature, markPrice);
    if (first.confirmed) {
      await persistState(`first_support_break_${feature.kind}`);
      await requestPartialExit(
        `FVVO_MANUAL_FIRST_SUPPORT_BREAK_${first.reason}`,
        markPrice,
        feature.kind
      );
      return;
    }

    if (recoveryCanArm(position, feature, pnl)) {
      position.phase = "RECOVERY_ARMED";
      position.recoveryArmed = true;
      position.recoveryArmedAt = nowIso();
      position.recoveryArmedAtMs = nowMs();
      position.firstStop = {
        breachAtMs: 0,
        observations: 0,
        lastBreachPrice: null,
      };

      await persistState(`recovery_armed_${feature.kind}`);
      const armedStop = activeEmergencyStop(position);
      log("INFO", "FVVO_MANUAL_RECOVERY_ARMED", {
        pnlPct: round(pnl, 4),
        peakPnlPct: round(peak, 4),
        entryPrice: entry,
        postArmProtectedProfitStopPrice: armedStop.protectedProfitPrice,
        postArmProtectedProfitPnlPct:
          CFG.MANUAL_WASHOUT_POST_ARM_PROTECT_PNL_PCT,
        structuralCrossHardStopPrice: armedStop.structuralPrice,
        ema8: feature.ema8,
        fvvo: feature.fvvo,
        slope: feature.slope,
      });
      return;
    }

    await persistState(`defensive_hold_${feature.kind}`);
    return;
  }

  const floorMet = pnl >= CFG.FVVO_CROSS_MIN_EXIT_GROSS_PCT;
  const isFiveMinute = feature.kind === CFG.FVVO_FEATURE_5M_EVENT;
  const isFastTick = feature.kind === CFG.FVVO_FAST_TICK_EVENT;
  const rayHold = rayBullHoldActive(position, feature);
  const squeezeHold = squeezeHoldActive(position, feature, pnl);
  const dynamicLimit = dynamicGivebackLimit(peak, Boolean(position.targetReached));

  if (
    floorMet &&
    CFG.FVVO_CROSS_DYNAMIC_TRAIL_ENABLED &&
    peak >= CFG.FVVO_CROSS_DYNAMIC_TRAIL_ARM_PCT &&
    giveback >= dynamicLimit &&
    !squeezeHold
  ) {
    await persistState(`cross_dynamic_trail_${feature.kind}`);
    await requestFullExit(
      position.targetReached
        ? "FVVO_CROSS_TARGET_TIGHT_DYNAMIC_TRAIL"
        : "FVVO_CROSS_DYNAMIC_TRAIL_FEE_AWARE",
      markPrice,
      feature.kind
    );
    return;
  }

  if (
    floorMet &&
    CFG.FVVO_CROSS_FEATURE_FEE_TRAIL_ENABLED &&
    peak >= CFG.FVVO_CROSS_FEATURE_FEE_TRAIL_ARM_PCT &&
    giveback >= CFG.FVVO_CROSS_FEATURE_FEE_TRAIL_MIN_GIVEBACK_PCT &&
    !squeezeHold
  ) {
    await persistState(`cross_fee_trail_${feature.kind}`);
    await requestFullExit(
      "FVVO_CROSS_FEATURE_FEE_TRAIL",
      markPrice,
      feature.kind
    );
    return;
  }

  const soft = featureSoftSignal(feature, isFiveMinute);
  const softAllowed = !isFastTick || CFG.FVVO_CROSS_EXIT_ON_FAST_TICK_BACKUP;
  const fiveMinuteAllowed = !isFiveMinute || CFG.FVVO_CROSS_EXIT_ON_5M_BACKUP;

  if (
    floorMet &&
    softAllowed &&
    fiveMinuteAllowed &&
    soft.triggered &&
    !rayHold
  ) {
    await persistState(`cross_soft_exit_${feature.kind}`);
    await requestFullExit(soft.reason, markPrice, feature.kind);
    return;
  }

  await persistState(`post_arm_mark_${feature.kind}`);

  if (
    soft.triggered &&
    (!floorMet || rayHold) &&
    nowMs() - lastExitDecisionLogAt > 60000
  ) {
    lastExitDecisionLogAt = nowMs();
    log("INFO", "FVVO_POST_ARM_EXIT_HOLD", {
      feed: feature.kind,
      pnlPct: round(pnl, 4),
      requiredGrossPct: CFG.FVVO_CROSS_MIN_EXIT_GROSS_PCT,
      softReason: soft.reason,
      rayBullHold: rayHold,
      squeezeHold,
      activeEmergencyStop: activeEmergencyStop(position),
    });
  }
}

async function manualHandoff() {
  if (!state.position && !state.externalDealLock.active) {
    return { status: 409, body: { ok: false, error: "NO_POSITION_OR_LOCK_TO_HANDOFF" } };
  }

  state.manual.handoffActive = true;
  state.manual.recoveryRequired = true;
  state.manual.recoveryReason = "MANUAL_HANDOFF_ACTIVE";
  state.manual.lastAction = "handoff_manual";
  state.manual.lastActionAt = nowIso();
  await persistState("manual_handoff");

  log("WARN", "FVVO_MANUAL_HANDOFF_ACTIVE", {
    newEntriesBlocked: true,
    brainExitManagementStopped: true,
  });

  return {
    status: 200,
    body: {
      ok: true,
      handoffActive: true,
      brainExitManagementStopped: true,
      newEntriesBlocked: true,
    },
  };
}

async function manualClearHandoff(body) {
  if (!state.manual.handoffActive) {
    return {
      status: 409,
      body: { ok: false, error: "CLEAR_HANDOFF_REQUIRES_MANUAL_HANDOFF_ACTIVE" },
    };
  }

  if (CFG.MANUAL_CLEAR_REQUIRES_CONFIRM_FLAT && body.confirm_flat !== true) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "CONFIRM_FLAT_TRUE_REQUIRED_AFTER_MANUALLY_CLOSING_THE_EXTERNAL_DEAL",
      },
    };
  }

  state.position = null;
  state.externalDealLock = { active: false, source: "", setAt: "", reason: "" };
  state.manual = {
    ...state.manual,
    handoffActive: false,
    recoveryRequired: false,
    recoveryReason: "",
    lastAction: "clear_handoff",
    lastActionAt: nowIso(),
  };
  await persistState("manual_clear_handoff_confirmed_flat");

  log("INFO", "FVVO_TRADE_RESULT", {
    resultSource: "manual_handoff_confirmed_flat",
    confirmedFlat: true,
  });

  return {
    status: 200,
    body: { ok: true, cleared: true, confirmedFlat: true, handoffCleared: true },
  };
}

async function manualConfirmExitClosed(body) {
  if (
    !state.position ||
    !String(state.position.lifecycle || "").startsWith("EXIT_")
  ) {
    return {
      status: 409,
      body: { ok: false, error: "NO_EXIT_RECONCILIATION_PENDING" },
    };
  }

  if (CFG.MANUAL_CLEAR_REQUIRES_CONFIRM_FLAT && body.confirm_flat !== true) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "CONFIRM_FLAT_TRUE_REQUIRED_AFTER_VERIFYING_3COMMAS_DEAL_IS_CLOSED",
      },
    };
  }

  const closing = publicPosition(state.position);
  state.position = null;
  state.externalDealLock = { active: false, source: "", setAt: "", reason: "" };
  state.manual = {
    ...state.manual,
    handoffActive: false,
    recoveryRequired: false,
    recoveryReason: "",
    lastAction: "confirm_exit_closed",
    lastActionAt: nowIso(),
  };
  await persistState("manual_confirm_exit_closed");

  log("INFO", "FVVO_EXIT_RECONCILIATION_CONFIRMED", {
    confirmedFlat: true,
    newEntriesAllowedSubjectToFreshFeature: true,
  });
  log("INFO", "FVVO_TRADE_RESULT", {
    resultSource: "confirmed_flat_after_3commas_verification",
    exitReason: closing.exitReason,
    entryPriceReference: closing.entryPriceReference,
    exitRequestPrice: state.lastFeature?.price || closing.latestPrice || null,
    lastTrackedPnlPct: closing.latestPnlPct,
    peakPnlPct: closing.peakPnlPct,
    remainingPositionPctAssumed: closing.remainingPositionPctAssumed,
  });

  return {
    status: 200,
    body: { ok: true, exitReconciled: true, confirmedFlat: true },
  };
}

async function manualForceClearVerifiedFlat(body) {
  if (!CFG.MANUAL_ALLOW_FORCE_CLEAR_VERIFIED_FLAT) {
    return {
      status: 403,
      body: { ok: false, error: "FORCE_CLEAR_VERIFIED_FLAT_DISABLED" },
    };
  }

  if (!state.position && !state.externalDealLock.active && !state.manual.recoveryRequired) {
    return {
      status: 409,
      body: { ok: false, error: "NO_POSITION_OR_EXTERNAL_LOCK_TO_CLEAR" },
    };
  }

  if (body.confirm_flat !== true) {
    return {
      status: 400,
      body: { ok: false, error: "CONFIRM_FLAT_TRUE_REQUIRED" },
    };
  }

  if (
    CFG.MANUAL_FORCE_CLEAR_CONFIRM_PHRASE &&
    String(body.confirm_phrase || "").trim() !== CFG.MANUAL_FORCE_CLEAR_CONFIRM_PHRASE
  ) {
    return {
      status: 400,
      body: { ok: false, error: "EXACT_FORCE_CLEAR_CONFIRM_PHRASE_REQUIRED" },
    };
  }

  const clearing = publicPosition(state.position);
  state.position = null;
  state.externalDealLock = { active: false, source: "", setAt: "", reason: "" };
  state.manual = {
    ...state.manual,
    handoffActive: false,
    recoveryRequired: false,
    recoveryReason: "",
    lastAction: "force_clear_verified_flat",
    lastActionAt: nowIso(),
  };
  await persistState("force_clear_verified_external_flat");

  log("WARN", "FVVO_FORCE_CLEAR_VERIFIED_FLAT", {
    confirmedFlat: true,
    priorLifecycle: clearing?.lifecycle || null,
    priorExitReason: clearing?.exitReason || null,
    note: "Operator verified the dedicated 3Commas DEMO bot is flat after an external/emergency close.",
  });
  log("INFO", "FVVO_TRADE_RESULT", {
    resultSource: "force_clear_verified_external_flat",
    entryPriceReference: clearing?.entryPriceReference || null,
    lastTrackedPnlPct: clearing?.latestPnlPct || null,
    peakPnlPct: clearing?.peakPnlPct || null,
  });

  return {
    status: 200,
    body: { ok: true, forcedClear: true, confirmedFlat: true },
  };
}

async function manualAdopt(body) {
  if (!CFG.MANUAL_ALLOW_ADOPT) {
    return { status: 403, body: { ok: false, error: "ADOPT_LONG_DISABLED" } };
  }

  if (!allowedProfile(body.profile)) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "ONLY_MANUAL_WASHOUT_TWO_LEVEL_RECOVERY_PROFILE_ALLOWED",
      },
    };
  }

  if (
    CFG.MANUAL_ADOPT_REQUIRE_RECOVERY_LOCK &&
    !state.manual.recoveryRequired
  ) {
    return {
      status: 409,
      body: { ok: false, error: "ADOPT_ALLOWED_ONLY_DURING_RECOVERY_LOCK" },
    };
  }

  if (!state.externalDealLock.active) {
    return {
      status: 409,
      body: { ok: false, error: "ADOPT_REQUIRES_EXISTING_DEDICATED_BOT_LOCK" },
    };
  }

  if (body.confirm_same_dedicated_bot !== true) {
    return {
      status: 400,
      body: { ok: false, error: "CONFIRM_SAME_DEDICATED_BOT_REQUIRED" },
    };
  }

  if (body.bot_uuid && !safeTimingEqual(String(body.bot_uuid), getBotUuid())) {
    return {
      status: 403,
      body: { ok: false, error: "BOT_UUID_DOES_NOT_MATCH_DEDICATED_BOT" },
    };
  }

  const entryPrice = firstFinite(body.entry_price, body.entryPrice);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return {
      status: 400,
      body: { ok: false, error: "ADOPT_REQUIRES_EXPLICIT_ACTUAL_3COMMAS_ENTRY_PRICE" },
    };
  }

  const ladder = validateAbsoluteLadder(body, entryPrice, true);
  if (!ladder.ok) {
    return { status: 400, body: { ok: false, error: ladder.error } };
  }

  state.position = buildPosition(
    entryPrice,
    "RECOVERY_ADOPT_SAME_DEDICATED_BOT",
    "ADOPTED_UNVERIFIED_EXISTING_DEAL",
    ladder
  );
  state.externalDealLock = {
    active: true,
    source: "adopt_long",
    setAt: nowIso(),
    reason: "ADOPTED_DEDICATED_BOT_RECOVERY",
  };
  state.manual.recoveryRequired = false;
  state.manual.recoveryReason = "";
  state.manual.lastAction = "adopt_long";
  state.manual.lastActionAt = nowIso();
  await persistState("adopt_long_recovery");

  log("WARN", "FVVO_POSITION_ADOPTED_RECOVERY_ONLY", {
    entryPrice,
    profile: PROFILE,
    firstStopPrice: ladder.firstStopPrice,
    finalStopPrice: ladder.finalStopPrice,
  });

  return {
    status: 200,
    body: {
      ok: true,
      adopted: true,
      recoveryOnly: true,
      position: publicPosition(state.position),
    },
  };
}

function logFeatureReceipt(feature) {
  const eventName =
    feature.kind === CFG.FVVO_FEATURE_5M_EVENT
      ? "FVVO_FEATURE_5M_RECEIVED"
      : feature.kind === CFG.FVVO_FAST_TICK_EVENT
        ? "FVVO_FAST_TICK_RECEIVED"
        : "FVVO_FEATURE_TICK_RECEIVED";

  log("INFO", eventName, {
    event: feature.kind,
    price: feature.price,
    ema8: feature.ema8,
    ema18: feature.ema18,
    fvvo: feature.fvvo,
    slope: feature.slope,
    crossDown: feature.crossDown,
    redPulse: feature.redPulse,
    rayRegime: feature.rayRegime,
    publisherKind: feature.publisherKind || null,
    chartTimeframe: feature.chartTimeframe || null,
    barTimeMs: feature.barTimeMs || null,
    positionLifecycle: state.position?.lifecycle || null,
    phase: state.position?.phase || null,
    brainExitManagementActive: positionManagementActive(state.position),
    reconciliationRequired: Boolean(state.manual.recoveryRequired),
  });
}

app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    brain: CFG.BRAIN_NAME,
    demoOnly: true,
    automaticEntriesEnabled: false,
    allowedProfile: PROFILE,
  });
});

app.get("/health", (_req, res) => {
  const problems = configProblems();
  res.status(problems.length ? 503 : 200).json({
    ok: problems.length === 0,
    brain: CFG.BRAIN_NAME,
    problems,
    persistenceReady,
  });
});

app.post(CFG.MANUAL_WEBHOOK_PATH, async (req, res) => {
  try {
    if (!CFG.MANUAL_CONTROL_ENABLED) {
      return res.status(404).json({ ok: false, error: "MANUAL_CONTROL_DISABLED" });
    }

    if (!authenticate(CFG.MANUAL_WEBHOOK_SECRET, req.body?.secret)) {
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    }

    const body = req.body || {};
    const action = String(body.action || "").trim().toLowerCase();

    if (cleanSymbol(body.symbol || CFG.SYMBOL) !== CFG.SYMBOL) {
      return res.status(400).json({ ok: false, error: "SOLUSDT_ONLY" });
    }

    log("INFO", "FVVO_MANUAL_COMMAND", { action, symbol: CFG.SYMBOL });

    if (action === "status") {
      if (!CFG.MANUAL_ALLOW_STATUS) {
        return res.status(403).json({ ok: false, error: "MANUAL_STATUS_DISABLED" });
      }
      return res.status(200).json(statusPayload());
    }

    if (action === "enter_long") {
      const outcome = await beginManualEnter(body);
      return res.status(outcome.status).json(outcome.body);
    }

    if (action === "exit_long") {
      if (!CFG.MANUAL_ALLOW_EXIT) {
        return res.status(403).json({ ok: false, error: "MANUAL_EXIT_DISABLED" });
      }

      const price =
        state.lastFeature?.price ||
        state.lastFastTick?.price ||
        state.position?.latestPrice ||
        state.position?.entryPriceReference;

      if (!Number.isFinite(price)) {
        return res.status(409).json({
          ok: false,
          error: "NO_REFERENCE_PRICE_FOR_EXIT",
        });
      }

      const outcome = await requestFullExit("MANUAL_EXIT_LONG", price, "manual");
      return res.status(outcome.ok ? 200 : 409).json({
        ok: outcome.ok,
        ...outcome,
        status: statusPayload(),
      });
    }

    if (action === "handoff_manual") {
      if (!CFG.MANUAL_ALLOW_HANDOFF) {
        return res.status(403).json({ ok: false, error: "MANUAL_HANDOFF_DISABLED" });
      }
      const outcome = await manualHandoff();
      return res.status(outcome.status).json(outcome.body);
    }

    if (action === "clear_handoff") {
      if (!CFG.MANUAL_ALLOW_CLEAR_HANDOFF) {
        return res.status(403).json({
          ok: false,
          error: "MANUAL_CLEAR_HANDOFF_DISABLED",
        });
      }
      const outcome = await manualClearHandoff(body);
      return res.status(outcome.status).json(outcome.body);
    }

    if (action === "confirm_exit_closed") {
      if (!CFG.MANUAL_ALLOW_CONFIRM_EXIT) {
        return res.status(403).json({
          ok: false,
          error: "MANUAL_CONFIRM_EXIT_DISABLED",
        });
      }
      const outcome = await manualConfirmExitClosed(body);
      return res.status(outcome.status).json(outcome.body);
    }

    if (action === "force_clear_verified_flat") {
      const outcome = await manualForceClearVerifiedFlat(body);
      return res.status(outcome.status).json(outcome.body);
    }

    if (action === "adopt_long") {
      const outcome = await manualAdopt(body);
      return res.status(outcome.status).json(outcome.body);
    }

    return res.status(400).json({ ok: false, error: "UNKNOWN_MANUAL_ACTION" });
  } catch (error) {
    log("ERROR", "FVVO_MANUAL_HANDLER_ERROR", { error: error.message });
    return res.status(500).json({ ok: false, error: "MANUAL_HANDLER_ERROR" });
  }
});

app.post(CFG.WEBHOOK_PATH, async (req, res) => {
  try {
    if (!authenticate(CFG.WEBHOOK_SECRET, req.body?.secret)) {
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    }

    const rawEvent = String(
      req.body?.event || req.body?.type || req.body?.src || ""
    ).trim();

    if (
      ![
        CFG.FVVO_FEATURE_TICK_EVENT,
        CFG.FVVO_FEATURE_5M_EVENT,
        CFG.FVVO_FAST_TICK_EVENT,
      ].includes(rawEvent)
    ) {
      return res.status(202).json({
        ok: true,
        ignored: true,
        reason: "UNSUPPORTED_EVENT",
      });
    }

    const feature = normalizeFeature(req.body || {}, rawEvent);
    if (feature.symbol !== CFG.SYMBOL) {
      return res.status(400).json({ ok: false, error: "SOLUSDT_ONLY" });
    }

    if (!Number.isFinite(feature.price) || feature.price <= 0) {
      return res.status(400).json({ ok: false, error: "VALID_PRICE_REQUIRED" });
    }

    updateLatestFeature(feature);
    logFeatureReceipt(feature);
    await manageExit(feature);

    return res.status(200).json({
      ok: true,
      event: feature.kind,
      position: publicPosition(state.position),
    });
  } catch (error) {
    log("ERROR", "FVVO_WEBHOOK_HANDLER_ERROR", { error: error.message });
    return res.status(500).json({ ok: false, error: "WEBHOOK_HANDLER_ERROR" });
  }
});

async function start() {
  await ensurePersistence();
  await loadState();
  const problems = configProblems();

  log("INFO", "FVVO_MANUAL_WASHOUT_STARTUP", {
    port: CFG.PORT,
    webhookPath: CFG.WEBHOOK_PATH,
    manualPath: CFG.MANUAL_WEBHOOK_PATH,
    symbol: CFG.SYMBOL,
    demoOnly: true,
    automaticEntriesEnabled: false,
    allowedProfile: PROFILE,
    manualLevelMode: "ABSOLUTE_PRICE",
    maxStopDistancePct: CFG.MANUAL_WASHOUT_MAX_STOP_DISTANCE_PCT,
    maxTargetDistancePct: CFG.MANUAL_WASHOUT_MAX_TARGET_DISTANCE_PCT,
    priceStep: CFG.MANUAL_WASHOUT_PRICE_STEP,
    recoveryArmMfePct: CFG.MANUAL_WASHOUT_RECOVERY_ARM_MFE_PCT,
    postArmProtectedProfitPct:
      CFG.MANUAL_WASHOUT_POST_ARM_PROTECT_PNL_PCT,
    minFeeAwareExitGrossPct: CFG.FVVO_CROSS_MIN_EXIT_GROSS_PCT,
    persistenceReady,
    configurationProblems: problems,
  });

  app.listen(CFG.PORT, () => {
    log("INFO", "FVVO_LISTENING", { port: CFG.PORT });
  });
}

process.on("unhandledRejection", (reason) => {
  log("ERROR", "UNHANDLED_REJECTION", { reason: String(reason) });
});

process.on("uncaughtException", (error) => {
  log("ERROR", "UNCAUGHT_EXCEPTION", { error: error.message });
});

start().catch((error) => {
  log("ERROR", "STARTUP_FAILED", { error: error.message });
  process.exit(1);
});
