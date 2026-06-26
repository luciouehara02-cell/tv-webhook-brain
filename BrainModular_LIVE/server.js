// ============================================================
// BrainFVVO_ManualExit_v1g_DYNAMIC_PROFIT_FULL_EXIT_DEMO
// SOLUSDT dedicated DEMO Signal Bot manual-entry / brain-exit service
// ------------------------------------------------------------
// v1g safety and dynamic-profit contract:
//   - No automatic entries. /manual enter_long only.
//   - One absolute `stop_price`: a confirmed breach sends exit_long 100%.
//   - Optional absolute `profit_target_price`: fixed ceiling, full 100% exit.
//   - When peak gross PnL reaches the configured arm level (default +0.45%),
//     a monotonic dynamic protected-profit floor is armed.
//   - Dynamic floor breach, 15s thesis failure, or 5m thesis failure each
//     send the SAME full 100% exit_long payload. No partial exits exist.
//   - Entry stays explicit quote market order (configurable; default 800 USDT).
//   - HTTP 200 from 3Commas is acceptance only. confirm_exit_closed is still
//     required after the dedicated Signal Bot visibly shows the trade flat.
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
    console.error(`${new Date().toISOString()} | CONFIG_ERROR | ${name} invalid JSON | ${error.message}`);
    return fallback;
  }
}

const CFG = {
  BRAIN_NAME: envStr("BRAIN_NAME", "BrainFVVO_ManualExit_v1g_DYNAMIC_PROFIT_FULL_EXIT_DEMO"),
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
  FVVO_EMERGENCY_DISABLE_ALL_FORWARDS: envBool("FVVO_EMERGENCY_DISABLE_ALL_FORWARDS", false),
  FVVO_EMERGENCY_DISABLE_NEW_ENTRIES: envBool("FVVO_EMERGENCY_DISABLE_NEW_ENTRIES", false),

  C3_SIGNAL_URL: envStr("C3_SIGNAL_URL", "https://api.3commas.io/signal_bots/webhooks"),
  C3_SIGNAL_SECRET: envStr("C3_SIGNAL_SECRET", ""),
  C3_BOT_UUID: envStr("C3_BOT_UUID", ""),
  SYMBOL_BOT_MAP: parseJsonEnv("SYMBOL_BOT_MAP", {}),
  C3_ENTRY_ORDER_AMOUNT: envNum("C3_ENTRY_ORDER_AMOUNT", 800),
  C3_ENTRY_ORDER_CURRENCY_TYPE: envStr("C3_ENTRY_ORDER_CURRENCY_TYPE", "quote").toLowerCase(),
  C3_ENTRY_ORDER_TYPE: envStr("C3_ENTRY_ORDER_TYPE", "market").toLowerCase(),
  C3_EXIT_INCLUDE_POSITION_ORDER: envBool("C3_EXIT_INCLUDE_POSITION_ORDER", true),
  C3_NATIVE_STOP_ENABLED: envBool("C3_NATIVE_STOP_ENABLED", true),
  C3_TRIGGER_PRICE_DECIMALS: Math.max(0, Math.floor(envNum("C3_TRIGGER_PRICE_DECIMALS", 8))),
  C3_MAX_LAG_SEC: envNum("C3_MAX_LAG_SEC", 300),
  C3_REQUEST_TIMEOUT_MS: envNum("C3_REQUEST_TIMEOUT_MS", 10000),
  C3_FORWARD_DEDUP_MS: envNum("C3_FORWARD_DEDUP_MS", 60000),
  C3_PAYLOAD_AUDIT_ENABLED: envBool("C3_PAYLOAD_AUDIT_ENABLED", true),
  C3_ASSUME_EXIT_ACCEPTANCE: envBool("C3_ASSUME_EXIT_ACCEPTANCE", false),

  STATE_DIR: envStr("STATE_DIR", "/data"),
  STATE_FILE_NAME: envStr("STATE_FILE_NAME", "brainfvvo-manualexit-v1b-state.json"),
  STATE_PERSISTENCE_REQUIRED: envBool("STATE_PERSISTENCE_REQUIRED", true),

  FVVO_LOG_COLOR_ENABLED: envBool("FVVO_LOG_COLOR_ENABLED", true),
  FVVO_FEATURE_TICK_EVENT: envStr("FVVO_FEATURE_TICK_EVENT", "FEATURE_TICK_FVVO"),
  FVVO_FEATURE_5M_EVENT: envStr("FVVO_FEATURE_5M_EVENT", "FEATURE_5M_FVVO"),
  FVVO_FAST_TICK_EVENT: envStr("FVVO_FAST_TICK_EVENT", "FAST_TICK_FVVO"),
  MANUAL_REQUIRE_FRESH_FEATURE_TICK: envBool("MANUAL_REQUIRE_FRESH_FEATURE_TICK", true),
  FVVO_STALE_FEATURE_TICK_MAX_AGE_SEC: envNum("FVVO_STALE_FEATURE_TICK_MAX_AGE_SEC", 60),

  MANUAL_ENTRY_DEFAULT_PROFILE: envStr("MANUAL_ENTRY_DEFAULT_PROFILE", "MANUAL_ONE_STOP_DYNAMIC_PROFIT_FULL_EXIT"),
  MANUAL_ALLOW_ENTER: envBool("MANUAL_ALLOW_ENTER", true),
  MANUAL_ALLOW_EXIT: envBool("MANUAL_ALLOW_EXIT", true),
  MANUAL_ALLOW_STATUS: envBool("MANUAL_ALLOW_STATUS", true),
  MANUAL_ALLOW_HANDOFF: envBool("MANUAL_ALLOW_HANDOFF", true),
  MANUAL_ALLOW_CLEAR_HANDOFF: envBool("MANUAL_ALLOW_CLEAR_HANDOFF", true),
  MANUAL_ALLOW_CONFIRM_EXIT: envBool("MANUAL_ALLOW_CONFIRM_EXIT", true),
  MANUAL_ALLOW_FORCE_CLEAR_VERIFIED_FLAT: envBool("MANUAL_ALLOW_FORCE_CLEAR_VERIFIED_FLAT", true),
  MANUAL_FORCE_CLEAR_CONFIRM_PHRASE: envStr("MANUAL_FORCE_CLEAR_CONFIRM_PHRASE", "I_VERIFIED_DEDICATED_3COMMAS_DEMO_BOT_IS_FLAT"),
  MANUAL_CLEAR_REQUIRES_CONFIRM_FLAT: envBool("MANUAL_CLEAR_REQUIRES_CONFIRM_FLAT", true),

  // v1g one-stop / optional fixed-target controls.
  MANUAL_ONE_STOP_PROFILE_ENABLED: envBool("MANUAL_ONE_STOP_PROFILE_ENABLED", true),
  MANUAL_ONE_STOP_PRICE_STEP: envNum("MANUAL_ONE_STOP_PRICE_STEP", 0.01),
  MANUAL_ONE_STOP_MAX_STOP_DISTANCE_PCT: envNum("MAX_STOP_DISTANCE_PCT", envNum("MANUAL_ONE_STOP_MAX_STOP_DISTANCE_PCT", 2.0)),
  MANUAL_ONE_STOP_MAX_TARGET_DISTANCE_PCT: envNum("MAX_PROFIT_TARGET_DISTANCE_PCT", envNum("MANUAL_ONE_STOP_MAX_TARGET_DISTANCE_PCT", 2.0)),
  MANUAL_ONE_STOP_TICK_CONFIRM_SEC: envNum("MANUAL_ONE_STOP_TICK_CONFIRM_SEC", 0),
  MANUAL_ONE_STOP_TICK_CONFIRM_OBSERVATIONS: envNum("MANUAL_ONE_STOP_TICK_CONFIRM_OBSERVATIONS", 1),
  MANUAL_ONE_STOP_5M_CLOSE_IMMEDIATE: envBool("MANUAL_ONE_STOP_5M_CLOSE_IMMEDIATE", true),
  MANUAL_ONE_STOP_TARGET_EXIT_ENABLED: envBool("MANUAL_ONE_STOP_TARGET_EXIT_ENABLED", true),

  // v1g dynamic brain-managed profit exit. Every emitted close remains 100%.
  DYNAMIC_PROFIT_EXIT_ENABLED: envBool("DYNAMIC_PROFIT_EXIT_ENABLED", true),
  DYNAMIC_PROFIT_ARM_MFE_PCT: envNum("DYNAMIC_PROFIT_ARM_MFE_PCT", 0.45),
  DYNAMIC_PROFIT_MIN_LOCK_PNL_PCT: envNum("DYNAMIC_PROFIT_MIN_LOCK_PNL_PCT", 0.20),
  DYNAMIC_PROFIT_TRAIL_GIVEBACK_START_PCT: envNum("DYNAMIC_PROFIT_TRAIL_GIVEBACK_START_PCT", 0.35),
  DYNAMIC_PROFIT_TRAIL_GIVEBACK_MIN_PCT: envNum("DYNAMIC_PROFIT_TRAIL_GIVEBACK_MIN_PCT", 0.18),
  DYNAMIC_PROFIT_TRAIL_TIGHTEN_PER_1PCT: envNum("DYNAMIC_PROFIT_TRAIL_TIGHTEN_PER_1PCT", 0.06),
  DYNAMIC_PROFIT_FLOOR_CONFIRM_SEC: envNum("DYNAMIC_PROFIT_FLOOR_CONFIRM_SEC", 0),
  DYNAMIC_PROFIT_FLOOR_CONFIRM_OBSERVATIONS: envNum("DYNAMIC_PROFIT_FLOOR_CONFIRM_OBSERVATIONS", 1),
  DYNAMIC_PROFIT_THESIS_EXIT_ENABLED: envBool("DYNAMIC_PROFIT_THESIS_EXIT_ENABLED", true),
  DYNAMIC_PROFIT_THESIS_MIN_PNL_PCT: envNum("DYNAMIC_PROFIT_THESIS_MIN_PNL_PCT", 0.25),
  DYNAMIC_PROFIT_THESIS_SLOPE_MAX: envNum("DYNAMIC_PROFIT_THESIS_SLOPE_MAX", -0.10),
  DYNAMIC_PROFIT_THESIS_TICK_CONFIRM_SEC: envNum("DYNAMIC_PROFIT_THESIS_TICK_CONFIRM_SEC", 0),
  DYNAMIC_PROFIT_THESIS_TICK_CONFIRM_OBSERVATIONS: envNum("DYNAMIC_PROFIT_THESIS_TICK_CONFIRM_OBSERVATIONS", 2),
  DYNAMIC_PROFIT_5M_THESIS_EXIT_ENABLED: envBool("DYNAMIC_PROFIT_5M_THESIS_EXIT_ENABLED", true),
  DYNAMIC_PROFIT_FLOOR_LOG_STEP_PCT: envNum("DYNAMIC_PROFIT_FLOOR_LOG_STEP_PCT", 0.05),
};

const PROFILE = "MANUAL_ONE_STOP_DYNAMIC_PROFIT_FULL_EXIT";
const STATE_PATH = path.join(CFG.STATE_DIR, CFG.STATE_FILE_NAME);
const STATE_BACKUP_PATH = `${STATE_PATH}.bak`;

const ANSI = {
  reset: "\x1b[0m",
  grey: "\x1b[90m",
  orange: "\x1b[38;5;214m",
  lightBlue: "\x1b[94m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

let persistenceReady = false;
let persistenceError = "";
let persistenceQueue = Promise.resolve();
let persistenceSequence = 0;
let state = defaultState();

function nowIso() { return new Date().toISOString(); }
function nowMs() { return Date.now(); }
function finite(value, fallback = null) { if (value === null || value === undefined || value === "") return fallback; const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function firstFinite(...values) { for (const value of values) { const parsed = finite(value, null); if (parsed !== null) return parsed; } return null; }
function round(value, digits = 6) { return Number(Number(value).toFixed(digits)); }
function cleanSymbol(value) { return String(value || "").trim().toUpperCase(); }
function percentPnl(entry, price) { return ((price - entry) / entry) * 100; }
function percentageBelow(entry, price) { return ((entry - price) / entry) * 100; }
function pctPriceBelow(entry, pct) { return entry * (1 - pct / 100); }
function safeTimingEqual(left, right) { const a = Buffer.from(String(left || "")); const b = Buffer.from(String(right || "")); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function authenticate(expected, received) { return Boolean(expected) && safeTimingEqual(expected, received); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function logColor(level, event, fields) {
  if (!CFG.FVVO_LOG_COLOR_ENABLED) return "";
  const eventName = String(event || "").toUpperCase();
  const action = String(fields?.action || "").toLowerCase();
  if (eventName.includes("FEATURE_5M")) return ANSI.lightBlue;
  if (eventName.includes("FEATURE_TICK") || eventName.includes("FAST_TICK")) return ANSI.orange;
  if (eventName.includes("ENTRY") || eventName.includes("TRADE_OPEN")) return ANSI.green;
  if (eventName.includes("EXIT") || eventName.includes("STOP") || eventName.includes("TARGET") || action === "exit_long") return ANSI.red;
  if (eventName.includes("RECOVERY") || eventName.includes("RESTORED")) return ANSI.magenta;
  if (level === "ERROR") return ANSI.red;
  if (level === "WARN") return ANSI.yellow;
  if (eventName.includes("MANUAL_COMMAND")) return ANSI.cyan;
  return ANSI.grey;
}

function log(level, event, fields = {}) {
  const line = `${nowIso()} | ${level} | ${CFG.BRAIN_NAME} | ${event} | ${JSON.stringify(fields)}`;
  const color = logColor(level, event, fields);
  console.log(color ? `${color}${line}${ANSI.reset}` : line);
}

function defaultState() {
  return {
    schemaVersion: 5,
    updatedAt: nowIso(),
    lastFeature: null,
    lastFeature5m: null,
    lastFastTick: null,
    position: null,
    externalDealLock: { active: false, source: "", setAt: "", reason: "" },
    manual: { handoffActive: false, recoveryRequired: false, recoveryReason: "", lastAction: "", lastActionAt: "" },
    forward: { lastByKey: {}, lastRequestId: "" },
  };
}

function normalizeState(raw) {
  const fallback = defaultState();
  if (!raw || typeof raw !== "object") return fallback;
  const next = { ...fallback, ...raw };
  next.forward = { ...fallback.forward, ...(raw.forward || {}) };
  next.manual = { ...fallback.manual, ...(raw.manual || {}) };
  next.externalDealLock = { ...fallback.externalDealLock, ...(raw.externalDealLock || {}) };

  if (!raw.position || typeof raw.position !== "object") return next;
  const p = { ...raw.position };
  const entry = finite(p.entryPriceReference, null);

  // Safe migration from the retired v1e two-level state: retain the stricter
  // final price as the only stop if a position exists during deployment.
  const migratedStop = firstFinite(p.stopPrice, p.finalStopPrice, p.firstStopPrice, entry ? pctPriceBelow(entry, finite(p.finalStopPct, finite(p.firstStopPct, 1.0))) : null);
  const migratedTarget = firstFinite(p.profitTargetPrice, 0);
  p.profile = PROFILE;
  p.phase = "ONE_STOP_ACTIVE";
  p.stopPrice = finite(migratedStop, null);
  p.stopPct = entry && p.stopPrice ? round(percentageBelow(entry, p.stopPrice), 6) : finite(p.stopPct, 0);
  p.profitTargetPrice = migratedTarget > 0 ? migratedTarget : 0;
  p.profitTargetPct = entry && p.profitTargetPrice > 0 ? round(percentPnl(entry, p.profitTargetPrice), 6) : 0;
  p.stop = { breachAtMs: 0, observations: 0, lastBreachPrice: null, ...(p.stop || {}) };
  const priorPeak = Math.max(0, finite(p.peakPnlPct, 0));
  const priorDynamic = p.dynamicProfit && typeof p.dynamicProfit === "object" ? p.dynamicProfit : {};
  const shouldBeArmed = Boolean(priorDynamic.armed) || (CFG.DYNAMIC_PROFIT_EXIT_ENABLED && priorPeak >= CFG.DYNAMIC_PROFIT_ARM_MFE_PCT);
  p.dynamicProfit = {
    armed: shouldBeArmed,
    armedAtMs: finite(priorDynamic.armedAtMs, shouldBeArmed ? nowMs() : 0),
    armedAtPrice: finite(priorDynamic.armedAtPrice, shouldBeArmed && entry ? entry * (1 + CFG.DYNAMIC_PROFIT_ARM_MFE_PCT / 100) : null),
    armedAtPnlPct: finite(priorDynamic.armedAtPnlPct, shouldBeArmed ? CFG.DYNAMIC_PROFIT_ARM_MFE_PCT : 0),
    peakPnlPct: Math.max(priorPeak, finite(priorDynamic.peakPnlPct, 0)),
    peakPrice: finite(priorDynamic.peakPrice, entry || 0),
    protectedPnlPct: Math.max(0, finite(priorDynamic.protectedPnlPct, 0)),
    protectedPrice: finite(priorDynamic.protectedPrice, null),
    lastLoggedProtectedPnlPct: Math.max(0, finite(priorDynamic.lastLoggedProtectedPnlPct, 0)),
    floor: { breachAtMs: 0, observations: 0, lastBreachPrice: null, ...(priorDynamic.floor || {}) },
    thesis: { breachAtMs: 0, observations: 0, lastBreachPrice: null, lastFeatureKind: null, ...(priorDynamic.thesis || {}) },
    lastThesisReason: priorDynamic.lastThesisReason || null,
  };
  if (p.dynamicProfit.armed && entry) {
    const computedFloor = dynamicProfitFloorPnlPct(p.dynamicProfit.peakPnlPct);
    p.dynamicProfit.protectedPnlPct = Math.max(p.dynamicProfit.protectedPnlPct, computedFloor);
    p.dynamicProfit.protectedPrice = round(entry * (1 + p.dynamicProfit.protectedPnlPct / 100), 8);
  }
  p.exitRequestedAt = p.exitRequestedAt || null;
  p.exitReason = p.exitReason || null;
  p.entryAcceptedAtMs = finite(p.entryAcceptedAtMs, 0);
  p.latestPnlPct = finite(p.latestPnlPct, 0);
  p.peakPnlPct = finite(p.peakPnlPct, 0);
  p.latestPrice = finite(p.latestPrice, entry || 0);
  next.position = p;
  return next;
}

async function ensurePersistence() {
  try {
    await fsp.mkdir(CFG.STATE_DIR, { recursive: true });
    const probe = path.join(CFG.STATE_DIR, `.brainfvvo-v1g-probe-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
    await fsp.writeFile(probe, "ok", { mode: 0o600 });
    await fsp.unlink(probe);
    persistenceReady = true;
    persistenceError = "";
    log("INFO", "FVVO_STATE_PERSISTENCE_READY", { statePath: STATE_PATH, stateDir: CFG.STATE_DIR });
  } catch (error) {
    persistenceReady = false;
    persistenceError = error.message;
    log("ERROR", "FVVO_STATE_PERSISTENCE_UNAVAILABLE", { stateDir: CFG.STATE_DIR, error: error.message });
  }
}

async function loadState() {
  if (!persistenceReady) return;
  let parsed = null;
  let source = "";
  try { parsed = JSON.parse(await fsp.readFile(STATE_PATH, "utf8")); source = "primary"; }
  catch (primaryError) {
    try { parsed = JSON.parse(await fsp.readFile(STATE_BACKUP_PATH, "utf8")); source = "backup"; }
    catch (_) { if (primaryError.code !== "ENOENT") log("WARN", "FVVO_STATE_LOAD_FAILED", { error: primaryError.message }); }
  }
  if (!parsed) {
    state = defaultState();
    log("INFO", "FVVO_POSITION_STATE_EMPTY", { statePath: STATE_PATH });
    return;
  }
  state = normalizeState(parsed);
  log("INFO", "FVVO_STATE_RESTORED", { source, hasPosition: Boolean(state.position), lifecycle: state.position?.lifecycle || null, profile: state.position?.profile || null });
}

function persistState(reason) {
  const snapshot = clone({ ...state, updatedAt: nowIso() });
  state.updatedAt = snapshot.updatedAt;
  const sequence = ++persistenceSequence;
  persistenceQueue = persistenceQueue.then(async () => {
    if (!persistenceReady) {
      persistenceError = "PERSISTENCE_UNAVAILABLE";
      if (CFG.STATE_PERSISTENCE_REQUIRED) throw new Error(persistenceError);
      return false;
    }
    const temp = `${STATE_PATH}.tmp-${process.pid}-${Date.now()}-${sequence}-${crypto.randomUUID()}`;
    try {
      await fsp.writeFile(temp, JSON.stringify(snapshot), { mode: 0o600 });
      try { await fsp.copyFile(STATE_PATH, STATE_BACKUP_PATH); } catch (_) {}
      await fsp.rename(temp, STATE_PATH);
      persistenceError = "";
      return true;
    } catch (error) {
      persistenceError = error.message;
      try { await fsp.unlink(temp); } catch (_) {}
      log("ERROR", "FVVO_STATE_PERSIST_FAILED", { reason, error: error.message });
      if (CFG.STATE_PERSISTENCE_REQUIRED) throw error;
      return false;
    }
  });
  return persistenceQueue;
}

function configProblems() {
  const problems = [];
  if (!CFG.WEBHOOK_SECRET) problems.push("WEBHOOK_SECRET_REQUIRED");
  if (!CFG.MANUAL_WEBHOOK_SECRET) problems.push("MANUAL_WEBHOOK_SECRET_REQUIRED");
  if (!CFG.C3_SIGNAL_SECRET) problems.push("C3_SIGNAL_SECRET_REQUIRED");
  if (!getBotUuid()) problems.push("C3_BOT_UUID_REQUIRED");
  if (!CFG.ENABLE_HTTP_FORWARD) problems.push("ENABLE_HTTP_FORWARD_MUST_BE_TRUE");
  if (!CFG.DEMO_FORWARD_ALLOWED) problems.push("DEMO_FORWARD_ALLOWED_MUST_BE_TRUE");
  if (CFG.LIVE_FORWARD_ALLOWED) problems.push("LIVE_FORWARD_ALLOWED_MUST_BE_FALSE");
  if (CFG.SHADOW_ONLY) problems.push("SHADOW_ONLY_MUST_BE_FALSE");
  if (CFG.C3_ENTRY_ORDER_AMOUNT <= 0) problems.push("C3_ENTRY_ORDER_AMOUNT_MUST_BE_GT_ZERO");
  if (CFG.C3_ENTRY_ORDER_CURRENCY_TYPE !== "quote") problems.push("C3_ENTRY_ORDER_CURRENCY_TYPE_MUST_BE_QUOTE");
  if (CFG.C3_ENTRY_ORDER_TYPE !== "market") problems.push("C3_ENTRY_ORDER_TYPE_MUST_BE_MARKET");
  if (!CFG.C3_EXIT_INCLUDE_POSITION_ORDER) problems.push("C3_EXIT_INCLUDE_POSITION_ORDER_MUST_BE_TRUE");
  if (CFG.MANUAL_ONE_STOP_PRICE_STEP <= 0) problems.push("INVALID_ONE_STOP_PRICE_STEP");
  if (CFG.MANUAL_ONE_STOP_MAX_STOP_DISTANCE_PCT <= 0) problems.push("INVALID_MAX_STOP_DISTANCE_PCT");
  if (CFG.MANUAL_ONE_STOP_MAX_TARGET_DISTANCE_PCT < 0) problems.push("INVALID_MAX_TARGET_DISTANCE_PCT");
  if (CFG.MANUAL_ONE_STOP_TICK_CONFIRM_SEC < 0) problems.push("INVALID_STOP_CONFIRM_SEC");
  if (CFG.MANUAL_ONE_STOP_TICK_CONFIRM_OBSERVATIONS < 1) problems.push("INVALID_STOP_CONFIRM_OBSERVATIONS");
  if (CFG.DYNAMIC_PROFIT_ARM_MFE_PCT <= 0) problems.push("INVALID_DYNAMIC_PROFIT_ARM_MFE_PCT");
  if (CFG.DYNAMIC_PROFIT_MIN_LOCK_PNL_PCT < 0) problems.push("INVALID_DYNAMIC_PROFIT_MIN_LOCK_PNL_PCT");
  if (CFG.DYNAMIC_PROFIT_TRAIL_GIVEBACK_START_PCT <= 0) problems.push("INVALID_DYNAMIC_PROFIT_TRAIL_GIVEBACK_START_PCT");
  if (CFG.DYNAMIC_PROFIT_TRAIL_GIVEBACK_MIN_PCT <= 0 || CFG.DYNAMIC_PROFIT_TRAIL_GIVEBACK_MIN_PCT > CFG.DYNAMIC_PROFIT_TRAIL_GIVEBACK_START_PCT) problems.push("INVALID_DYNAMIC_PROFIT_TRAIL_GIVEBACK_MIN_PCT");
  if (CFG.DYNAMIC_PROFIT_TRAIL_TIGHTEN_PER_1PCT < 0) problems.push("INVALID_DYNAMIC_PROFIT_TRAIL_TIGHTEN_PER_1PCT");
  if (CFG.DYNAMIC_PROFIT_FLOOR_CONFIRM_SEC < 0 || CFG.DYNAMIC_PROFIT_FLOOR_CONFIRM_OBSERVATIONS < 1) problems.push("INVALID_DYNAMIC_PROFIT_FLOOR_CONFIRM");
  if (CFG.DYNAMIC_PROFIT_THESIS_MIN_PNL_PCT < 0 || CFG.DYNAMIC_PROFIT_THESIS_TICK_CONFIRM_SEC < 0 || CFG.DYNAMIC_PROFIT_THESIS_TICK_CONFIRM_OBSERVATIONS < 1) problems.push("INVALID_DYNAMIC_PROFIT_THESIS_CONFIRM");
  if (CFG.STATE_PERSISTENCE_REQUIRED && !persistenceReady) problems.push("PERSISTENCE_NOT_READY");
  return problems;
}

function getBotUuid() {
  const map = CFG.SYMBOL_BOT_MAP || {};
  return String(map[CFG.SYMBOL] || map[cleanSymbol(CFG.SYMBOL)] || CFG.C3_BOT_UUID || "").trim();
}

function isForwardAllowed() {
  return CFG.ENABLE_HTTP_FORWARD && CFG.DEMO_FORWARD_ALLOWED && !CFG.LIVE_FORWARD_ALLOWED && !CFG.SHADOW_ONLY && !CFG.FVVO_EMERGENCY_DISABLE_ALL_FORWARDS;
}

function ageSec(feature) { return feature?.receivedAtMs ? Math.max(0, (nowMs() - feature.receivedAtMs) / 1000) : Infinity; }
function isFeatureFresh() { return Boolean(state.lastFeature) && ageSec(state.lastFeature) <= CFG.FVVO_STALE_FEATURE_TICK_MAX_AGE_SEC; }

function validStep(price) {
  if (!Number.isFinite(price) || price <= 0) return false;
  const units = price / CFG.MANUAL_ONE_STOP_PRICE_STEP;
  return Math.abs(units - Math.round(units)) < 1e-7;
}

function hasRetiredLadderFields(body) {
  return ["first_stop_price", "firstStopPrice", "final_stop_price", "finalStopPrice", "first_stop_pct", "final_stop_pct", "firstStopPct", "finalStopPct", "profit_target_pct", "profitTargetPct"].some((key) => Object.prototype.hasOwnProperty.call(body, key));
}

function oneOf(body, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(body, name)) return { present: true, value: finite(body[name], null) };
  }
  return { present: false, value: null };
}

function validateOneStopCommand(body, entryPrice) {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { ok: false, error: "VALID_ENTRY_REFERENCE_REQUIRED_FOR_ONE_STOP" };
  if (hasRetiredLadderFields(body)) return { ok: false, error: "USE_STOP_PRICE_AND_OPTIONAL_PROFIT_TARGET_PRICE_ONLY_TWO_LEVEL_FIELDS_ARE_RETIRED" };

  const stop = oneOf(body, ["stop_price", "stopPrice"]);
  const target = oneOf(body, ["profit_target_price", "profitTargetPrice", "target_price", "targetPrice"]);
  if (!stop.present || !Number.isFinite(stop.value)) return { ok: false, error: "STOP_PRICE_REQUIRED" };
  if (!validStep(stop.value)) return { ok: false, error: "STOP_PRICE_NOT_ALIGNED_TO_MANUAL_ONE_STOP_PRICE_STEP" };
  if (stop.value >= entryPrice) return { ok: false, error: "STOP_PRICE_MUST_BE_BELOW_ENTRY_REFERENCE" };
  const stopPct = percentageBelow(entryPrice, stop.value);
  if (stopPct > CFG.MANUAL_ONE_STOP_MAX_STOP_DISTANCE_PCT + 1e-9) return { ok: false, error: "STOP_DISTANCE_EXCEEDS_MANUAL_ONE_STOP_MAX_STOP_DISTANCE_PCT" };

  let targetPrice = 0;
  let targetPct = 0;
  if (target.present && target.value !== 0) {
    if (!Number.isFinite(target.value) || !validStep(target.value)) return { ok: false, error: "PROFIT_TARGET_PRICE_NOT_ALIGNED_TO_MANUAL_ONE_STOP_PRICE_STEP" };
    if (target.value <= entryPrice) return { ok: false, error: "PROFIT_TARGET_PRICE_MUST_BE_ABOVE_ENTRY_REFERENCE_OR_ZERO" };
    targetPct = percentPnl(entryPrice, target.value);
    if (targetPct > CFG.MANUAL_ONE_STOP_MAX_TARGET_DISTANCE_PCT + 1e-9) return { ok: false, error: "PROFIT_TARGET_DISTANCE_EXCEEDS_MANUAL_ONE_STOP_MAX_TARGET_DISTANCE_PCT" };
    targetPrice = target.value;
  }

  return { ok: true, stopPrice: round(stop.value, 8), stopPct: round(stopPct, 6), profitTargetPrice: round(targetPrice, 8), profitTargetPct: round(targetPct, 6) };
}

function normalizeFeature(payload) {
  const kind = String(payload.event || payload.intent || payload.src || "").trim();
  const price = firstFinite(payload.price, payload.close, payload.last, payload.markPrice);
  return {
    kind,
    event: kind,
    price,
    close: firstFinite(payload.close, price),
    ema8: firstFinite(payload.ema8, payload.ema_8),
    ema18: firstFinite(payload.ema18, payload.ema_18),
    fvvo: firstFinite(payload.fvvo, payload.fvvoValue, payload.fluxOscillator),
    slope: firstFinite(payload.slope, payload.fvvoSlope),
    crossDown: Boolean(payload.crossDown ?? payload.fvvoCrossDown),
    redPulse: Boolean(payload.redPulse ?? payload.fvvoRedPulse),
    rayRegime: String(payload.rayRegime || payload.tickRayRegime || "RAY_NEUTRAL"),
    publisherKind: payload.publisherKind || null,
    chartTimeframe: payload.chartTimeframe || payload.tf || null,
    barTimeMs: firstFinite(payload.barTimeMs, payload.time, nowMs()),
    receivedAt: nowIso(),
    receivedAtMs: nowMs(),
  };
}

function updateFeature(feature) {
  if (!Number.isFinite(feature.price) || feature.price <= 0) return false;
  if (feature.kind === CFG.FVVO_FEATURE_TICK_EVENT) state.lastFeature = feature;
  else if (feature.kind === CFG.FVVO_FEATURE_5M_EVENT) state.lastFeature5m = feature;
  else if (feature.kind === CFG.FVVO_FAST_TICK_EVENT) state.lastFastTick = feature;
  else return false;
  return true;
}

function buildPosition(entryPrice, levels) {
  return {
    symbol: CFG.SYMBOL,
    profile: PROFILE,
    lifecycle: "ENTRY_PENDING_FORWARD",
    phase: "ONE_STOP_ACTIVE",
    entryPriceReference: entryPrice,
    entryPriceSource: "LATEST_FRESH_FEATURE_TICK",
    exchangeFillVerified: false,
    openedAt: nowIso(),
    openedAtMs: nowMs(),
    entryAcceptedAt: null,
    entryAcceptedAtMs: 0,
    stopPrice: levels.stopPrice,
    stopPct: levels.stopPct,
    profitTargetPrice: levels.profitTargetPrice,
    profitTargetPct: levels.profitTargetPct,
    stop: { breachAtMs: 0, observations: 0, lastBreachPrice: null },
    dynamicProfit: {
      armed: false,
      armedAtMs: 0,
      armedAtPrice: null,
      armedAtPnlPct: 0,
      peakPnlPct: 0,
      peakPrice: entryPrice,
      protectedPnlPct: 0,
      protectedPrice: null,
      lastLoggedProtectedPnlPct: 0,
      floor: { breachAtMs: 0, observations: 0, lastBreachPrice: null },
      thesis: { breachAtMs: 0, observations: 0, lastBreachPrice: null, lastFeatureKind: null },
      lastThesisReason: null,
    },
    latestPrice: entryPrice,
    latestPnlPct: 0,
    peakPnlPct: 0,
    maxFavorableExcursionPct: 0,
    exitRequestedAt: null,
    exitReason: null,
  };
}

function c3NumberString(value) {
  const parsed = finite(value, null);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return String(round(parsed, CFG.C3_TRIGGER_PRICE_DECIMALS));
}

function buildC3Signal(action, price, options = {}, current = nowMs()) {
  const trigger = c3NumberString(price);
  if (!trigger) throw new Error("C3_TRIGGER_PRICE_INVALID");
  const body = {
    secret: CFG.C3_SIGNAL_SECRET,
    max_lag: String(Math.floor(CFG.C3_MAX_LAG_SEC)),
    timestamp: new Date(current).toISOString(),
    trigger_price: trigger,
    tv_exchange: "BINANCE",
    tv_instrument: "SOLUSDT",
    action,
    bot_uuid: getBotUuid(),
  };
  if (action === "enter_long") {
    body.order = { amount: CFG.C3_ENTRY_ORDER_AMOUNT, currency_type: CFG.C3_ENTRY_ORDER_CURRENCY_TYPE, order_type: CFG.C3_ENTRY_ORDER_TYPE };
    if (CFG.C3_NATIVE_STOP_ENABLED && Number.isFinite(options.stopPct)) {
      body.stop_loss = { enabled: true, breakeven: false, order_type: "market", trigger_price_percent: round(options.stopPct, 6), trailing: { enabled: false } };
    }
  } else if (action === "exit_long" && CFG.C3_EXIT_INCLUDE_POSITION_ORDER) {
    body.order = { amount: 100, currency_type: "position_percent" };
  }
  return body;
}

async function forward3Commas(action, price, reason, options = {}) {
  const requestId = crypto.randomUUID();
  const dedupeKey = options.dedupeKey || `${action}_100`;
  const current = nowMs();
  const last = finite(state.forward.lastByKey?.[dedupeKey], 0);
  if (!options.bypassDedupe && current - last < CFG.C3_FORWARD_DEDUP_MS) return { ok: false, deduped: true, error: "C3_FORWARD_DEDUP_ACTIVE", requestId };
  if (!isForwardAllowed()) return { ok: false, error: "FORWARDING_NOT_ALLOWED", requestId };

  let body;
  try { body = buildC3Signal(action, price, options, current); }
  catch (error) { log("ERROR", "C3_PAYLOAD_BUILD_FAILED", { action, reason, requestId, error: error.message }); return { ok: false, error: error.message, requestId }; }

  state.forward.lastByKey = { ...(state.forward.lastByKey || {}), [dedupeKey]: current };
  state.forward.lastRequestId = requestId;
  await persistState(`c3_${dedupeKey}_requested`);

  log("INFO", "C3_FORWARD_SEND", { action, reason, symbol: CFG.SYMBOL, price, requestId, c3Timestamp: body.timestamp, triggerPrice: body.trigger_price, hasOrder: Boolean(body.order), dryRun: CFG.C3_DRY_RUN });
  if (CFG.C3_PAYLOAD_AUDIT_ENABLED) log("INFO", "C3_FORWARD_PAYLOAD_AUDIT", { requestId, action, reason, schema: "CUSTOM_SIGNAL_ISO8601_EXPLICIT_MARKET_ENTRY_DYNAMIC_PROFIT_FULL_EXIT", body: { ...body, secret: "REDACTED" } });

  if (CFG.C3_DRY_RUN) return { ok: true, accepted: true, dryRun: true, requestId, status: 200, c3Timestamp: body.timestamp, triggerPrice: body.trigger_price };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.C3_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(CFG.C3_SIGNAL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    const responseText = (await response.text()).slice(0, 500);
    if (!response.ok) {
      log("ERROR", "C3_FORWARD_REJECTED", { action, reason, status: response.status, requestId, responseText });
      return { ok: false, error: `C3_HTTP_${response.status}`, requestId, status: response.status };
    }
    log("INFO", "C3_FORWARD_ACCEPTED_UNVERIFIED", { action, reason, status: response.status, requestId, responseText });
    return { ok: true, accepted: true, requestId, status: response.status, c3Timestamp: body.timestamp, triggerPrice: body.trigger_price };
  } catch (error) {
    const label = error.name === "AbortError" ? "C3_TIMEOUT" : "C3_NETWORK_ERROR";
    log("ERROR", label, { action, reason, requestId, error: error.message });
    return { ok: false, error: label, requestId };
  } finally { clearTimeout(timer); }
}

function stateBlocksNewEntry() {
  if (CFG.FVVO_EMERGENCY_DISABLE_NEW_ENTRIES) return "EMERGENCY_NEW_ENTRIES_DISABLED";
  if (state.position) return "MANAGED_POSITION_ACTIVE";
  if (state.externalDealLock?.active) return "EXTERNAL_DEAL_LOCK_ACTIVE";
  if (state.manual?.handoffActive) return "MANUAL_HANDOFF_ACTIVE";
  if (state.manual?.recoveryRequired) return "RECOVERY_REQUIRED";
  return "";
}

function statusPayload() {
  return {
    ok: true,
    brain: CFG.BRAIN_NAME,
    symbol: CFG.SYMBOL,
    demoOnly: !CFG.LIVE_FORWARD_ALLOWED,
    automaticEntriesEnabled: false,
    entryProfileAllowed: PROFILE,
    oneStopContract: {
      commandStopField: "stop_price",
      optionalTargetField: "profit_target_price",
      stopExitPercent: 100,
      targetExitPercent: 100,
      maxStopDistancePct: CFG.MANUAL_ONE_STOP_MAX_STOP_DISTANCE_PCT,
      maxTargetDistancePct: CFG.MANUAL_ONE_STOP_MAX_TARGET_DISTANCE_PCT,
      tickConfirmSec: CFG.MANUAL_ONE_STOP_TICK_CONFIRM_SEC,
      tickConfirmObservations: CFG.MANUAL_ONE_STOP_TICK_CONFIRM_OBSERVATIONS,
      fiveMinuteCloseImmediate: CFG.MANUAL_ONE_STOP_5M_CLOSE_IMMEDIATE,
    },
    dynamicProfitContract: {
      enabled: CFG.DYNAMIC_PROFIT_EXIT_ENABLED,
      armMfePct: CFG.DYNAMIC_PROFIT_ARM_MFE_PCT,
      minLockPnlPct: CFG.DYNAMIC_PROFIT_MIN_LOCK_PNL_PCT,
      trailGivebackStartPct: CFG.DYNAMIC_PROFIT_TRAIL_GIVEBACK_START_PCT,
      trailGivebackMinPct: CFG.DYNAMIC_PROFIT_TRAIL_GIVEBACK_MIN_PCT,
      trailTightenPer1Pct: CFG.DYNAMIC_PROFIT_TRAIL_TIGHTEN_PER_1PCT,
      floorConfirmSec: CFG.DYNAMIC_PROFIT_FLOOR_CONFIRM_SEC,
      floorConfirmObservations: CFG.DYNAMIC_PROFIT_FLOOR_CONFIRM_OBSERVATIONS,
      thesisExitEnabled: CFG.DYNAMIC_PROFIT_THESIS_EXIT_ENABLED,
      thesisMinPnlPct: CFG.DYNAMIC_PROFIT_THESIS_MIN_PNL_PCT,
      thesisSlopeMax: CFG.DYNAMIC_PROFIT_THESIS_SLOPE_MAX,
      thesisTickConfirmObservations: CFG.DYNAMIC_PROFIT_THESIS_TICK_CONFIRM_OBSERVATIONS,
      fiveMinuteThesisExitEnabled: CFG.DYNAMIC_PROFIT_5M_THESIS_EXIT_ENABLED,
      exitPercent: 100,
    },
    forwarding: { allowed: isForwardAllowed(), dryRun: CFG.C3_DRY_RUN, c3PayloadAudit: CFG.C3_PAYLOAD_AUDIT_ENABLED },
    persistence: { ready: persistenceReady, error: persistenceError, statePath: STATE_PATH },
    latestFeature: state.lastFeature ? { price: state.lastFeature.price, ageSec: round(ageSec(state.lastFeature), 2), freshForManualEntry: isFeatureFresh(), receivedAt: state.lastFeature.receivedAt } : null,
    feeds: {
      featureTick: state.lastFeature ? { price: state.lastFeature.price, ageSec: round(ageSec(state.lastFeature), 2), receivedAt: state.lastFeature.receivedAt } : null,
      feature5m: state.lastFeature5m ? { price: state.lastFeature5m.price, ageSec: round(ageSec(state.lastFeature5m), 2), receivedAt: state.lastFeature5m.receivedAt } : null,
      fastTick: state.lastFastTick ? { price: state.lastFastTick.price, ageSec: round(ageSec(state.lastFastTick), 2), receivedAt: state.lastFastTick.receivedAt } : null,
    },
    position: state.position ? {
      lifecycle: state.position.lifecycle,
      phase: state.position.phase,
      entryPriceReference: state.position.entryPriceReference,
      stopPrice: state.position.stopPrice,
      stopPct: state.position.stopPct,
      profitTargetPrice: state.position.profitTargetPrice || null,
      profitTargetPct: state.position.profitTargetPct || 0,
      latestPrice: state.position.latestPrice,
      latestPnlPct: state.position.latestPnlPct,
      peakPnlPct: state.position.peakPnlPct,
      dynamicProfit: state.position.dynamicProfit ? {
        armed: Boolean(state.position.dynamicProfit.armed),
        armedAtPnlPct: state.position.dynamicProfit.armedAtPnlPct || 0,
        peakPnlPct: state.position.dynamicProfit.peakPnlPct || 0,
        protectedPnlPct: state.position.dynamicProfit.protectedPnlPct || 0,
        protectedPrice: state.position.dynamicProfit.protectedPrice || null,
        floorObservations: state.position.dynamicProfit.floor?.observations || 0,
        thesisObservations: state.position.dynamicProfit.thesis?.observations || 0,
        lastThesisReason: state.position.dynamicProfit.lastThesisReason || null,
      } : null,
      exitReason: state.position.exitReason,
    } : null,
    externalDealLockActive: Boolean(state.externalDealLock?.active),
    manualState: state.manual,
    entryBlockReason: stateBlocksNewEntry() || null,
  };
}

async function beginManualEnter(body) {
  const issue = configProblems()[0];
  if (issue) return { status: 503, body: { ok: false, error: issue } };
  if (!CFG.MANUAL_ALLOW_ENTER) return { status: 403, body: { ok: false, error: "MANUAL_ENTER_DISABLED" } };
  if (!CFG.MANUAL_ONE_STOP_PROFILE_ENABLED) return { status: 403, body: { ok: false, error: "MANUAL_ONE_STOP_PROFILE_DISABLED" } };
  if (String(body.profile || CFG.MANUAL_ENTRY_DEFAULT_PROFILE).trim().toUpperCase() !== PROFILE) return { status: 400, body: { ok: false, error: "ONLY_MANUAL_ONE_STOP_DYNAMIC_PROFIT_FULL_EXIT_PROFILE_ALLOWED" } };
  if (["price", "entry_price", "entryPrice"].some((key) => Object.prototype.hasOwnProperty.call(body, key))) return { status: 400, body: { ok: false, error: "MANUAL_ENTRY_PRICE_FIELD_NOT_ALLOWED_USE_LATEST_FEATURE_PRICE" } };
  const block = stateBlocksNewEntry();
  if (block) return { status: 409, body: { ok: false, error: block, status: statusPayload() } };
  if (CFG.MANUAL_REQUIRE_FRESH_FEATURE_TICK && !isFeatureFresh()) return { status: 409, body: { ok: false, error: "FRESH_FEATURE_TICK_REQUIRED", featureAgeSec: ageSec(state.lastFeature) } };
  const entry = finite(state.lastFeature?.price, null);
  if (!entry || entry <= 0) return { status: 409, body: { ok: false, error: "NO_VALID_FRESH_FEATURE_PRICE" } };
  const levels = validateOneStopCommand(body, entry);
  if (!levels.ok) return { status: 400, body: { ok: false, error: levels.error } };

  state.position = buildPosition(entry, levels);
  state.externalDealLock = { active: true, source: "manual_enter", setAt: nowIso(), reason: "ENTRY_REQUEST_PENDING" };
  state.manual = { ...state.manual, handoffActive: false, recoveryRequired: false, recoveryReason: "", lastAction: "enter_long", lastActionAt: nowIso() };
  if (!(await persistState("manual_enter_pre_forward"))) return { status: 503, body: { ok: false, error: "STATE_PERSISTENCE_FAILED_BEFORE_ENTRY" } };

  log("INFO", "FVVO_TRADE_OPEN_PENDING", { profile: PROFILE, entryPriceReference: entry, stopPrice: levels.stopPrice, profitTargetPrice: levels.profitTargetPrice || null, stopExitPercent: 100, targetExitPercent: 100, dynamicProfitEnabled: CFG.DYNAMIC_PROFIT_EXIT_ENABLED, dynamicProfitArmMfePct: CFG.DYNAMIC_PROFIT_ARM_MFE_PCT, dynamicProfitMinLockPnlPct: CFG.DYNAMIC_PROFIT_MIN_LOCK_PNL_PCT });
  const result = await forward3Commas("enter_long", entry, "MANUAL_ONE_STOP_ENTER_LATEST_FEATURE_PRICE", { dedupeKey: "enter_long", stopPct: levels.stopPct });
  if (!result.ok) {
    state.position.lifecycle = "ENTRY_UNKNOWN_AFTER_FORWARD_ERROR";
    state.manual.recoveryRequired = true;
    state.manual.recoveryReason = `ENTRY_FORWARD_UNCERTAIN_${result.error}`;
    state.externalDealLock.reason = "ENTRY_FORWARD_UNCERTAIN";
    await persistState("manual_enter_forward_uncertain");
    return { status: 502, body: { ok: false, error: result.error, requestId: result.requestId, externalDealLockActive: true, recoveryRequired: true } };
  }

  state.position.lifecycle = "ENTRY_ACCEPTED_UNVERIFIED_FILL";
  state.position.entryAcceptedAt = nowIso();
  state.position.entryAcceptedAtMs = nowMs();
  state.position.entryForwardRequestId = result.requestId;
  state.externalDealLock.reason = "ENTRY_ACCEPTED_UNVERIFIED_FILL";
  await persistState("manual_enter_accepted");
  log("INFO", "FVVO_MANUAL_ONE_STOP_ENTRY_TRACKED", { entryPriceReference: entry, stopPrice: levels.stopPrice, stopDistancePct: levels.stopPct, profitTargetPrice: levels.profitTargetPrice || null, profitTargetDistancePct: levels.profitTargetPct, nativeStopSent: CFG.C3_NATIVE_STOP_ENABLED, dynamicProfitEnabled: CFG.DYNAMIC_PROFIT_EXIT_ENABLED, dynamicProfitArmMfePct: CFG.DYNAMIC_PROFIT_ARM_MFE_PCT, requestId: result.requestId, fillVerified: false });
  return { status: 200, body: { ok: true, forwarded: true, acceptedBy3CommasWebhook: true, exchangeFillVerified: false, brainWillManageExit: true, manualEntryTracked: true, externalDealLockActive: true, profile: PROFILE, entryPriceReference: entry, stopPrice: levels.stopPrice, stopDistancePct: levels.stopPct, profitTargetPrice: levels.profitTargetPrice || null, profitTargetDistancePct: levels.profitTargetPct, dynamicProfitEnabled: CFG.DYNAMIC_PROFIT_EXIT_ENABLED, dynamicProfitArmMfePct: CFG.DYNAMIC_PROFIT_ARM_MFE_PCT, dynamicProfitMinLockPnlPct: CFG.DYNAMIC_PROFIT_MIN_LOCK_PNL_PCT, requestId: result.requestId } };
}

async function requestFullExit(reason, price, origin) {
  const p = state.position;
  if (!p) return { ok: false, error: "NO_MANAGED_POSITION" };
  if (state.manual.handoffActive) return { ok: false, error: "MANUAL_HANDOFF_ACTIVE" };
  if (String(p.lifecycle || "").startsWith("EXIT_")) return { ok: false, error: "EXIT_ALREADY_REQUESTED" };

  log("WARN", "FVVO_EXIT_DECISION", { reason, origin, price, phase: p.phase, entryPrice: p.entryPriceReference, latestPnlPct: round(p.latestPnlPct, 4), peakPnlPct: round(p.peakPnlPct, 4), stopPrice: p.stopPrice, profitTargetPrice: p.profitTargetPrice || null, exitPercent: 100 });
  const result = await forward3Commas("exit_long", price, reason, { dedupeKey: "exit_long_full_100", bypassDedupe: true });
  if (!result.ok) {
    p.lifecycle = "EXIT_UNKNOWN_AFTER_FORWARD_ERROR";
    p.exitRequestedAt = nowIso();
    p.exitReason = reason;
    state.manual.recoveryRequired = true;
    state.manual.recoveryReason = `EXIT_FORWARD_UNCERTAIN_${result.error}`;
    await persistState("full_exit_forward_uncertain");
    return result;
  }

  p.lifecycle = "EXIT_ACCEPTED_UNVERIFIED_CLOSE";
  p.exitRequestedAt = nowIso();
  p.exitReason = reason;
  p.exitRequestPrice = price;
  p.exitForwardRequestId = result.requestId;
  state.manual.recoveryRequired = !CFG.C3_ASSUME_EXIT_ACCEPTANCE;
  state.manual.recoveryReason = CFG.C3_ASSUME_EXIT_ACCEPTANCE ? "" : "EXIT_ACCEPTED_UNVERIFIED_CLOSE";
  state.externalDealLock = { active: !CFG.C3_ASSUME_EXIT_ACCEPTANCE, source: "brain_full_exit", setAt: nowIso(), reason: CFG.C3_ASSUME_EXIT_ACCEPTANCE ? "EXIT_ASSUMED_CLOSED_BY_CONFIG" : "EXIT_ACCEPTED_UNVERIFIED_CLOSE" };
  if (CFG.C3_ASSUME_EXIT_ACCEPTANCE) state.position = null;
  await persistState("full_exit_accepted");
  log("INFO", "FVVO_FULL_EXIT_SIGNAL_ACCEPTED_UNVERIFIED", { origin, reason, price, requestId: result.requestId, exchangeCloseVerified: false, recoveryRequired: !CFG.C3_ASSUME_EXIT_ACCEPTANCE, exitPercent: 100 });
  return { ...result, exitUnverified: !CFG.C3_ASSUME_EXIT_ACCEPTANCE };
}

function oneStopBreakConfirmed(position, feature, markPrice) {
  if (markPrice > position.stopPrice) {
    if (position.stop?.observations) position.stop = { breachAtMs: 0, observations: 0, lastBreachPrice: null };
    return { confirmed: false, reason: "ABOVE_STOP_PRICE" };
  }
  if (feature.kind === CFG.FVVO_FEATURE_5M_EVENT && CFG.MANUAL_ONE_STOP_5M_CLOSE_IMMEDIATE && Number.isFinite(feature.close) && feature.close <= position.stopPrice) return { confirmed: true, reason: "STOP_5M_CLOSE_BREAK" };
  const current = nowMs();
  if (!position.stop?.breachAtMs) position.stop = { breachAtMs: current, observations: 1, lastBreachPrice: markPrice };
  else { position.stop.observations = Number(position.stop.observations || 0) + 1; position.stop.lastBreachPrice = markPrice; }
  const elapsed = (current - position.stop.breachAtMs) / 1000;
  const observations = Number(position.stop.observations || 0);
  return { confirmed: observations >= CFG.MANUAL_ONE_STOP_TICK_CONFIRM_OBSERVATIONS && elapsed >= CFG.MANUAL_ONE_STOP_TICK_CONFIRM_SEC, reason: "STOP_TICK_CONFIRM", observations, elapsedSec: elapsed };
}

function dynamicProfitFloorPnlPct(peakPnlPct) {
  const peak = Math.max(0, finite(peakPnlPct, 0));
  const excessAboveArm = Math.max(0, peak - CFG.DYNAMIC_PROFIT_ARM_MFE_PCT);
  const allowedGiveback = Math.max(
    CFG.DYNAMIC_PROFIT_TRAIL_GIVEBACK_MIN_PCT,
    CFG.DYNAMIC_PROFIT_TRAIL_GIVEBACK_START_PCT - (excessAboveArm * CFG.DYNAMIC_PROFIT_TRAIL_TIGHTEN_PER_1PCT)
  );
  return round(Math.max(CFG.DYNAMIC_PROFIT_MIN_LOCK_PNL_PCT, peak - allowedGiveback), 6);
}

function dynamicProfitState(position) {
  if (!position.dynamicProfit || typeof position.dynamicProfit !== "object") {
    position.dynamicProfit = {
      armed: false, armedAtMs: 0, armedAtPrice: null, armedAtPnlPct: 0,
      peakPnlPct: 0, peakPrice: position.entryPriceReference,
      protectedPnlPct: 0, protectedPrice: null, lastLoggedProtectedPnlPct: 0,
      floor: { breachAtMs: 0, observations: 0, lastBreachPrice: null },
      thesis: { breachAtMs: 0, observations: 0, lastBreachPrice: null, lastFeatureKind: null },
      lastThesisReason: null,
    };
  }
  const d = position.dynamicProfit;
  d.floor = { breachAtMs: 0, observations: 0, lastBreachPrice: null, ...(d.floor || {}) };
  d.thesis = { breachAtMs: 0, observations: 0, lastBreachPrice: null, lastFeatureKind: null, ...(d.thesis || {}) };
  return d;
}

function updateDynamicProfit(position, price, pnlPct) {
  const d = dynamicProfitState(position);
  const priorProtected = finite(d.protectedPnlPct, 0);
  d.peakPnlPct = Math.max(finite(d.peakPnlPct, 0), pnlPct);
  if (pnlPct >= d.peakPnlPct - 1e-9) d.peakPrice = price;
  let armedNow = false;
  if (CFG.DYNAMIC_PROFIT_EXIT_ENABLED && !d.armed && d.peakPnlPct >= CFG.DYNAMIC_PROFIT_ARM_MFE_PCT) {
    d.armed = true;
    d.armedAtMs = nowMs();
    d.armedAtPrice = price;
    d.armedAtPnlPct = round(d.peakPnlPct, 6);
    armedNow = true;
  }
  if (!d.armed || !CFG.DYNAMIC_PROFIT_EXIT_ENABLED) return { armedNow, floorRaised: false, dynamic: d };
  const calculated = dynamicProfitFloorPnlPct(d.peakPnlPct);
  d.protectedPnlPct = Math.max(priorProtected, calculated);
  d.protectedPrice = round(position.entryPriceReference * (1 + d.protectedPnlPct / 100), 8);
  const floorRaised = d.protectedPnlPct > priorProtected + 1e-9;
  return { armedNow, floorRaised, dynamic: d };
}

function dynamicFloorBreakConfirmed(position, markPrice, pnlPct) {
  const d = dynamicProfitState(position);
  if (!CFG.DYNAMIC_PROFIT_EXIT_ENABLED || !d.armed || !(finite(d.protectedPnlPct, 0) > 0)) return { confirmed: false, reason: "DYNAMIC_PROFIT_NOT_ARMED" };
  if (pnlPct > d.protectedPnlPct + 1e-9 || markPrice > finite(d.protectedPrice, Infinity)) {
    if (d.floor?.observations) d.floor = { breachAtMs: 0, observations: 0, lastBreachPrice: null };
    return { confirmed: false, reason: "ABOVE_DYNAMIC_PROFIT_FLOOR" };
  }
  const current = nowMs();
  if (!d.floor?.breachAtMs) d.floor = { breachAtMs: current, observations: 1, lastBreachPrice: markPrice };
  else { d.floor.observations = Number(d.floor.observations || 0) + 1; d.floor.lastBreachPrice = markPrice; }
  const elapsed = (current - d.floor.breachAtMs) / 1000;
  const observations = Number(d.floor.observations || 0);
  return { confirmed: observations >= CFG.DYNAMIC_PROFIT_FLOOR_CONFIRM_OBSERVATIONS && elapsed >= CFG.DYNAMIC_PROFIT_FLOOR_CONFIRM_SEC, reason: "DYNAMIC_PROFIT_FLOOR_CONFIRM", observations, elapsedSec: elapsed, protectedPnlPct: d.protectedPnlPct, protectedPrice: d.protectedPrice };
}

function tickThesisFailureConfirmed(position, feature, price, pnlPct) {
  const d = dynamicProfitState(position);
  if (!CFG.DYNAMIC_PROFIT_EXIT_ENABLED || !CFG.DYNAMIC_PROFIT_THESIS_EXIT_ENABLED || !d.armed || feature.kind !== CFG.FVVO_FEATURE_TICK_EVENT) return { confirmed: false, reason: "TICK_THESIS_NOT_ELIGIBLE" };
  const ema8 = finite(feature.ema8, null);
  const fvvo = finite(feature.fvvo, null);
  const slope = finite(feature.slope, null);
  const conditions = pnlPct >= CFG.DYNAMIC_PROFIT_THESIS_MIN_PNL_PCT &&
    ema8 !== null && price < ema8 &&
    slope !== null && slope <= CFG.DYNAMIC_PROFIT_THESIS_SLOPE_MAX &&
    fvvo !== null && (fvvo <= 0 || feature.crossDown === true);
  if (!conditions) {
    if (d.thesis?.observations) d.thesis = { breachAtMs: 0, observations: 0, lastBreachPrice: null, lastFeatureKind: null };
    return { confirmed: false, reason: "TICK_THESIS_HEALTHY_OR_UNCONFIRMED" };
  }
  const current = nowMs();
  if (!d.thesis?.breachAtMs) d.thesis = { breachAtMs: current, observations: 1, lastBreachPrice: price, lastFeatureKind: feature.kind };
  else { d.thesis.observations = Number(d.thesis.observations || 0) + 1; d.thesis.lastBreachPrice = price; d.thesis.lastFeatureKind = feature.kind; }
  d.lastThesisReason = "PRICE_BELOW_EMA8_AND_NEGATIVE_FVVO_SLOPE";
  const elapsed = (current - d.thesis.breachAtMs) / 1000;
  const observations = Number(d.thesis.observations || 0);
  return { confirmed: observations >= CFG.DYNAMIC_PROFIT_THESIS_TICK_CONFIRM_OBSERVATIONS && elapsed >= CFG.DYNAMIC_PROFIT_THESIS_TICK_CONFIRM_SEC, reason: "TICK_THESIS_FAILURE_CONFIRM", observations, elapsedSec: elapsed, ema8, fvvo, slope };
}

function fiveMinuteThesisFailure(position, feature, price, pnlPct) {
  const d = dynamicProfitState(position);
  if (!CFG.DYNAMIC_PROFIT_EXIT_ENABLED || !CFG.DYNAMIC_PROFIT_5M_THESIS_EXIT_ENABLED || !d.armed || feature.kind !== CFG.FVVO_FEATURE_5M_EVENT) return { confirmed: false, reason: "FIVE_MINUTE_THESIS_NOT_ELIGIBLE" };
  const close = finite(feature.close, price);
  const ema8 = finite(feature.ema8, null);
  const fvvo = finite(feature.fvvo, null);
  const confirmed = pnlPct >= CFG.DYNAMIC_PROFIT_MIN_LOCK_PNL_PCT && close !== null && ema8 !== null && close < ema8 && fvvo !== null && fvvo <= 0;
  if (confirmed) d.lastThesisReason = "FIVE_MINUTE_CLOSE_BELOW_EMA8_AND_FVVO_NONPOSITIVE";
  return { confirmed, reason: confirmed ? "FIVE_MINUTE_THESIS_FAILURE" : "FIVE_MINUTE_THESIS_HEALTHY_OR_UNCONFIRMED", close, ema8, fvvo };
}

async function manageExit(feature) {
  const p = state.position;
  if (!p || state.manual.handoffActive || String(p.lifecycle || "").startsWith("EXIT_")) return;
  const price = firstFinite(feature.price, feature.close);
  if (!price || price <= 0) return;
  const pnl = percentPnl(p.entryPriceReference, price);
  p.latestPrice = price;
  p.latestPnlPct = pnl;
  p.peakPnlPct = Math.max(finite(p.peakPnlPct, 0), pnl);
  p.maxFavorableExcursionPct = Math.max(finite(p.maxFavorableExcursionPct, 0), pnl);

  const dynamicUpdate = updateDynamicProfit(p, price, pnl);
  const d = dynamicUpdate.dynamic;
  if (dynamicUpdate.armedNow) {
    log("INFO", "FVVO_DYNAMIC_PROFIT_ARMED", { entryPrice: p.entryPriceReference, armMfePct: CFG.DYNAMIC_PROFIT_ARM_MFE_PCT, armObservedPnlPct: d.armedAtPnlPct, protectedPnlPct: d.protectedPnlPct, protectedPrice: d.protectedPrice, price });
  }
  if (dynamicUpdate.floorRaised && d.protectedPnlPct >= finite(d.lastLoggedProtectedPnlPct, 0) + CFG.DYNAMIC_PROFIT_FLOOR_LOG_STEP_PCT - 1e-9) {
    d.lastLoggedProtectedPnlPct = d.protectedPnlPct;
    log("INFO", "FVVO_DYNAMIC_PROFIT_FLOOR_RAISED", { peakPnlPct: d.peakPnlPct, protectedPnlPct: d.protectedPnlPct, protectedPrice: d.protectedPrice, price, allowedGivebackPct: round(d.peakPnlPct - d.protectedPnlPct, 6) });
  }

  // Optional fixed ceiling remains available. profit_target_price=0 means no fixed ceiling.
  if (CFG.MANUAL_ONE_STOP_TARGET_EXIT_ENABLED && p.profitTargetPrice > 0 && price >= p.profitTargetPrice) {
    await persistState(`profit_target_${feature.kind}`);
    await requestFullExit("FVVO_MANUAL_PROFIT_TARGET_PRICE_HIT", price, feature.kind);
    return;
  }

  // The manual absolute stop remains the primary downside invalidation.
  const stop = oneStopBreakConfirmed(p, feature, price);
  if (stop.confirmed) {
    await persistState(`stop_price_${feature.kind}`);
    await requestFullExit(`FVVO_MANUAL_STOP_PRICE_HIT_${stop.reason}`, price, feature.kind);
    return;
  }

  // Profit floor is a hard protection after the +0.45% (default) arm threshold.
  const floor = dynamicFloorBreakConfirmed(p, price, pnl);
  if (floor.confirmed) {
    await persistState(`dynamic_profit_floor_${feature.kind}`);
    await requestFullExit(`FVVO_DYNAMIC_PROFIT_FLOOR_HIT_${floor.reason}`, price, feature.kind);
    return;
  }

  // Faster 15s momentum/thesis failure; requires consecutive observations.
  const tickThesis = tickThesisFailureConfirmed(p, feature, price, pnl);
  if (tickThesis.confirmed) {
    await persistState(`dynamic_profit_tick_thesis_${feature.kind}`);
    await requestFullExit(`FVVO_DYNAMIC_PROFIT_TICK_THESIS_FAILURE_${tickThesis.reason}`, price, feature.kind);
    return;
  }

  // Slower 5m backup confirmation; only after protected profit is available.
  const fiveMinuteThesis = fiveMinuteThesisFailure(p, feature, price, pnl);
  if (fiveMinuteThesis.confirmed) {
    await persistState(`dynamic_profit_5m_thesis_${feature.kind}`);
    await requestFullExit(`FVVO_DYNAMIC_PROFIT_5M_THESIS_FAILURE_${fiveMinuteThesis.reason}`, price, feature.kind);
    return;
  }

  await persistState(`one_stop_dynamic_profit_hold_${feature.kind}`);
}

async function manualExit(body) {
  if (!CFG.MANUAL_ALLOW_EXIT) return { status: 403, body: { ok: false, error: "MANUAL_EXIT_DISABLED" } };
  if (!state.position) return { status: 409, body: { ok: false, error: "NO_MANAGED_POSITION", status: statusPayload() } };
  const price = finite(state.lastFeature?.price, state.position.latestPrice || state.position.entryPriceReference);
  const result = await requestFullExit("MANUAL_EXIT_LONG", price, "manual");
  return result.ok ? { status: 200, body: { ok: true, accepted: true, requestId: result.requestId, c3Timestamp: result.c3Timestamp, triggerPrice: result.triggerPrice, exitUnverified: result.exitUnverified, status: statusPayload() } } : { status: 502, body: { ok: false, error: result.error, requestId: result.requestId, status: statusPayload() } };
}

async function confirmExitClosed(body) {
  if (!CFG.MANUAL_ALLOW_CONFIRM_EXIT) return { status: 403, body: { ok: false, error: "MANUAL_CONFIRM_EXIT_DISABLED" } };
  if (!state.position || !String(state.position.lifecycle || "").startsWith("EXIT_")) return { status: 409, body: { ok: false, error: "NO_EXIT_RECONCILIATION_PENDING" } };
  if (CFG.MANUAL_CLEAR_REQUIRES_CONFIRM_FLAT && body.confirm_flat !== true) return { status: 400, body: { ok: false, error: "CONFIRM_FLAT_TRUE_REQUIRED" } };
  const prior = state.position;
  state.position = null;
  state.externalDealLock = { active: false, source: "", setAt: "", reason: "" };
  state.manual = { ...state.manual, recoveryRequired: false, recoveryReason: "", lastAction: "confirm_exit_closed", lastActionAt: nowIso() };
  await persistState("confirm_exit_closed");
  log("INFO", "FVVO_EXIT_RECONCILIATION_CONFIRMED", { priorExitReason: prior.exitReason, entryPrice: prior.entryPriceReference, stopPrice: prior.stopPrice, targetPrice: prior.profitTargetPrice || null });
  return { status: 200, body: { ok: true, exitReconciled: true, confirmedFlat: true } };
}

async function forceClearVerifiedFlat(body) {
  if (!CFG.MANUAL_ALLOW_FORCE_CLEAR_VERIFIED_FLAT) return { status: 403, body: { ok: false, error: "MANUAL_FORCE_CLEAR_DISABLED" } };
  if (body.confirm_flat !== true) return { status: 400, body: { ok: false, error: "CONFIRM_FLAT_TRUE_REQUIRED" } };
  if (String(body.confirm_phrase || "") !== CFG.MANUAL_FORCE_CLEAR_CONFIRM_PHRASE) return { status: 403, body: { ok: false, error: "FORCE_CLEAR_CONFIRM_PHRASE_REQUIRED" } };
  const prior = state.position;
  state.position = null;
  state.externalDealLock = { active: false, source: "", setAt: "", reason: "" };
  state.manual = { ...state.manual, handoffActive: false, recoveryRequired: false, recoveryReason: "", lastAction: "force_clear_verified_flat", lastActionAt: nowIso() };
  await persistState("force_clear_verified_flat");
  log("WARN", "FVVO_FORCE_CLEAR_VERIFIED_FLAT", { hadPosition: Boolean(prior), priorLifecycle: prior?.lifecycle || null, reason: body.reason || "" });
  return { status: 200, body: { ok: true, forcedClear: true, status: statusPayload() } };
}

async function handleManual(body) {
  if (!CFG.MANUAL_CONTROL_ENABLED) return { status: 403, body: { ok: false, error: "MANUAL_CONTROL_DISABLED" } };
  if (!authenticate(CFG.MANUAL_WEBHOOK_SECRET, body.secret)) return { status: 401, body: { ok: false, error: "BAD_MANUAL_SECRET" } };
  if (cleanSymbol(body.symbol || CFG.SYMBOL) !== cleanSymbol(CFG.SYMBOL)) return { status: 400, body: { ok: false, error: "SYMBOL_NOT_ALLOWED" } };
  const action = String(body.action || "").trim().toLowerCase();
  log("INFO", "FVVO_MANUAL_COMMAND", { action, symbol: CFG.SYMBOL });
  if (action === "status") return CFG.MANUAL_ALLOW_STATUS ? { status: 200, body: statusPayload() } : { status: 403, body: { ok: false, error: "MANUAL_STATUS_DISABLED" } };
  if (action === "enter_long") return beginManualEnter(body);
  if (action === "exit_long") return manualExit(body);
  if (action === "confirm_exit_closed") return confirmExitClosed(body);
  if (action === "force_clear_verified_flat") return forceClearVerifiedFlat(body);
  if (action === "handoff_manual") {
    if (!CFG.MANUAL_ALLOW_HANDOFF) return { status: 403, body: { ok: false, error: "MANUAL_HANDOFF_DISABLED" } };
    if (!state.position) return { status: 409, body: { ok: false, error: "NO_MANAGED_POSITION" } };
    state.manual = { ...state.manual, handoffActive: true, lastAction: "handoff_manual", lastActionAt: nowIso() };
    await persistState("handoff_manual");
    return { status: 200, body: { ok: true, handoffActive: true, status: statusPayload() } };
  }
  if (action === "clear_handoff") {
    if (!CFG.MANUAL_ALLOW_CLEAR_HANDOFF) return { status: 403, body: { ok: false, error: "MANUAL_CLEAR_HANDOFF_DISABLED" } };
    state.manual = { ...state.manual, handoffActive: false, lastAction: "clear_handoff", lastActionAt: nowIso() };
    await persistState("clear_handoff");
    return { status: 200, body: { ok: true, handoffActive: false, status: statusPayload() } };
  }
  return { status: 400, body: { ok: false, error: "UNKNOWN_MANUAL_ACTION" } };
}

app.get("/health", (_req, res) => res.status(200).json({ ok: true, brain: CFG.BRAIN_NAME, status: statusPayload() }));

app.post(CFG.WEBHOOK_PATH, async (req, res) => {
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  if (!authenticate(CFG.WEBHOOK_SECRET, payload.secret)) return res.status(401).json({ ok: false, error: "BAD_WEBHOOK_SECRET" });
  if (payload.symbol && cleanSymbol(payload.symbol) !== cleanSymbol(CFG.SYMBOL)) return res.status(400).json({ ok: false, error: "SYMBOL_NOT_ALLOWED" });
  const feature = normalizeFeature(payload);
  if (![CFG.FVVO_FEATURE_TICK_EVENT, CFG.FVVO_FEATURE_5M_EVENT, CFG.FVVO_FAST_TICK_EVENT].includes(feature.kind)) return res.status(202).json({ ok: false, error: "UNSUPPORTED_EVENT", event: feature.kind || null });
  if (!updateFeature(feature)) return res.status(400).json({ ok: false, error: "VALID_PRICE_REQUIRED" });
  const eventName = feature.kind === CFG.FVVO_FEATURE_5M_EVENT ? "FVVO_FEATURE_5M_RECEIVED" : feature.kind === CFG.FVVO_FAST_TICK_EVENT ? "FVVO_FAST_TICK_RECEIVED" : "FVVO_FEATURE_TICK_RECEIVED";
  log("INFO", eventName, { event: feature.kind, price: feature.price, ema8: feature.ema8, ema18: feature.ema18, fvvo: feature.fvvo, slope: feature.slope, crossDown: feature.crossDown, redPulse: feature.redPulse, rayRegime: feature.rayRegime, publisherKind: feature.publisherKind, chartTimeframe: feature.chartTimeframe, barTimeMs: feature.barTimeMs, positionLifecycle: state.position?.lifecycle || null, phase: state.position?.phase || null, brainExitManagementActive: Boolean(state.position && !String(state.position.lifecycle || "").startsWith("EXIT_")), reconciliationRequired: Boolean(state.manual?.recoveryRequired) });
  try { await manageExit(feature); } catch (error) { log("ERROR", "FVVO_MANAGE_EXIT_FAILED", { error: error.message, event: feature.kind }); return res.status(500).json({ ok: false, error: "MANAGE_EXIT_FAILED" }); }
  return res.status(200).json({ ok: true, event: feature.kind });
});

app.post(CFG.MANUAL_WEBHOOK_PATH, async (req, res) => {
  try { const result = await handleManual(req.body && typeof req.body === "object" ? req.body : {}); return res.status(result.status).json(result.body); }
  catch (error) { log("ERROR", "FVVO_MANUAL_HANDLER_FAILED", { error: error.message }); return res.status(500).json({ ok: false, error: "MANUAL_HANDLER_FAILED" }); }
});

async function start() {
  await ensurePersistence();
  await loadState();
  const problems = configProblems();
  log("INFO", "FVVO_MANUAL_DYNAMIC_PROFIT_STARTUP", { port: CFG.PORT, webhookPath: CFG.WEBHOOK_PATH, manualPath: CFG.MANUAL_WEBHOOK_PATH, symbol: CFG.SYMBOL, demoOnly: !CFG.LIVE_FORWARD_ALLOWED, automaticEntriesEnabled: false, allowedProfile: PROFILE, manualLevelMode: "ONE_ABSOLUTE_STOP_PRICE", maxStopDistancePct: CFG.MANUAL_ONE_STOP_MAX_STOP_DISTANCE_PCT, maxTargetDistancePct: CFG.MANUAL_ONE_STOP_MAX_TARGET_DISTANCE_PCT, priceStep: CFG.MANUAL_ONE_STOP_PRICE_STEP, stopExitPercent: 100, targetExitPercent: 100, tickConfirmSec: CFG.MANUAL_ONE_STOP_TICK_CONFIRM_SEC, tickConfirmObservations: CFG.MANUAL_ONE_STOP_TICK_CONFIRM_OBSERVATIONS, fiveMinuteCloseImmediate: CFG.MANUAL_ONE_STOP_5M_CLOSE_IMMEDIATE, dynamicProfitEnabled: CFG.DYNAMIC_PROFIT_EXIT_ENABLED, dynamicProfitArmMfePct: CFG.DYNAMIC_PROFIT_ARM_MFE_PCT, dynamicProfitMinLockPnlPct: CFG.DYNAMIC_PROFIT_MIN_LOCK_PNL_PCT, dynamicProfitTrailGivebackStartPct: CFG.DYNAMIC_PROFIT_TRAIL_GIVEBACK_START_PCT, dynamicProfitTrailGivebackMinPct: CFG.DYNAMIC_PROFIT_TRAIL_GIVEBACK_MIN_PCT, dynamicProfitTrailTightenPer1Pct: CFG.DYNAMIC_PROFIT_TRAIL_TIGHTEN_PER_1PCT, dynamicProfitThesisTickConfirmObservations: CFG.DYNAMIC_PROFIT_THESIS_TICK_CONFIRM_OBSERVATIONS, dynamicProfit5mThesisEnabled: CFG.DYNAMIC_PROFIT_5M_THESIS_EXIT_ENABLED, persistenceReady, configurationProblems: problems });
  app.listen(CFG.PORT, () => log("INFO", "FVVO_LISTENING", { port: CFG.PORT }));
}

if (require.main === module) start().catch((error) => { log("ERROR", "FVVO_STARTUP_FATAL", { error: error.message }); process.exit(1); });

module.exports = { app, CFG, buildC3Signal, validateOneStopCommand, normalizeState, defaultState, dynamicProfitFloorPnlPct, dynamicFloorBreakConfirmed, tickThesisFailureConfirmed, fiveMinuteThesisFailure };
