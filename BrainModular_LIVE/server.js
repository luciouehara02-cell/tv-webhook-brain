// ============================================================
// BrainFVVO_ManualExit_v1j_PRICE_TRIGGER_ENTRY_REENTRY_SHADOW_DEMO
// SOLUSDT dedicated DEMO Signal Bot manual-entry / brain-exit service
// ------------------------------------------------------------
// v1j manual price-trigger entry + Phase-2 shadow re-entry + dynamic-profit contract:
//   - Primary entries can be immediate manual or a user-armed absolute price trigger.
//   - The price trigger is cross-activated from a fresh 15s feature and then sends a bot-fixed market entry.
//   - Phase-2 re-entry remains candidate SHADOW only and never forwards an automatic re-entry order.
//   - One absolute `stop_price`: a confirmed breach sends exit_long 100%.
//   - Optional absolute `profit_target_price`: fixed ceiling, full 100% exit.
//   - When peak gross PnL reaches the configured arm level (default +0.45%),
//     a monotonic dynamic protected-profit floor is armed.
//   - Dynamic floor breach, 15s thesis failure, or 5m thesis failure each
//     send the SAME full 100% exit_long payload. No partial exits exist.
//   - Entry order sizing is BOT-OWNED: the brain emits no entry `order` object.
//   - 3Commas Signal Bot owns fixed entry size/type (800 USDT quote, Market).
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
  BRAIN_NAME: envStr("BRAIN_NAME", "BrainFVVO_ManualExit_v1j_PRICE_TRIGGER_ENTRY_REENTRY_SHADOW_DEMO"),
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
  // v1h: entry size and type are intentionally owned by the Signal Bot settings.
  // No entry `order` object is emitted by the brain. Legacy C3_ENTRY_ORDER_* values are ignored.
  C3_ENTRY_SIZE_SOURCE: envStr("C3_ENTRY_SIZE_SOURCE", "bot_fixed").toLowerCase(),
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

  // Copy/paste-safe Unicode event category markers replace ANSI terminal colour.
  FVVO_LOG_UNICODE_MARKERS_ENABLED: envBool("FVVO_LOG_UNICODE_MARKERS_ENABLED", true),
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

  // v1j user-armed absolute price trigger. This is a brain-side conditional entry,
  // not an exchange-native resting limit order. It sends a bot-fixed MARKET entry only
  // after a fresh price crosses the armed level from the correct side.
  PRICE_ENTRY_ENABLED: envBool("PRICE_ENTRY_ENABLED", true),
  MANUAL_ALLOW_ARM_PRICE_ENTRY: envBool("MANUAL_ALLOW_ARM_PRICE_ENTRY", true),
  MANUAL_ALLOW_CANCEL_PRICE_ENTRY: envBool("MANUAL_ALLOW_CANCEL_PRICE_ENTRY", true),
  PRICE_ENTRY_DEFAULT_EXPIRY_SEC: envNum("PRICE_ENTRY_DEFAULT_EXPIRY_SEC", 14400),
  PRICE_ENTRY_MIN_EXPIRY_SEC: envNum("PRICE_ENTRY_MIN_EXPIRY_SEC", 60),
  PRICE_ENTRY_MAX_EXPIRY_SEC: envNum("PRICE_ENTRY_MAX_EXPIRY_SEC", 86400),
  PRICE_ENTRY_MIN_TRIGGER_DISTANCE_PCT: envNum("PRICE_ENTRY_MIN_TRIGGER_DISTANCE_PCT", 0.05),
  PRICE_ENTRY_MAX_TRIGGER_DISTANCE_PCT: envNum("PRICE_ENTRY_MAX_TRIGGER_DISTANCE_PCT", 5.0),
  PRICE_ENTRY_REQUIRE_ACTUAL_CROSS: envBool("PRICE_ENTRY_REQUIRE_ACTUAL_CROSS", true),
  PRICE_ENTRY_TRIGGER_ON_FAST_TICK: envBool("PRICE_ENTRY_TRIGGER_ON_FAST_TICK", false),

  // v1h one-stop / optional fixed-target controls.
  MANUAL_ONE_STOP_PROFILE_ENABLED: envBool("MANUAL_ONE_STOP_PROFILE_ENABLED", true),
  MANUAL_ONE_STOP_PRICE_STEP: envNum("MANUAL_ONE_STOP_PRICE_STEP", 0.01),
  MANUAL_ONE_STOP_MAX_STOP_DISTANCE_PCT: envNum("MAX_STOP_DISTANCE_PCT", envNum("MANUAL_ONE_STOP_MAX_STOP_DISTANCE_PCT", 2.0)),
  MANUAL_ONE_STOP_MAX_TARGET_DISTANCE_PCT: envNum("MAX_PROFIT_TARGET_DISTANCE_PCT", envNum("MANUAL_ONE_STOP_MAX_TARGET_DISTANCE_PCT", 2.0)),
  MANUAL_ONE_STOP_TICK_CONFIRM_SEC: envNum("MANUAL_ONE_STOP_TICK_CONFIRM_SEC", 0),
  MANUAL_ONE_STOP_TICK_CONFIRM_OBSERVATIONS: envNum("MANUAL_ONE_STOP_TICK_CONFIRM_OBSERVATIONS", 1),
  MANUAL_ONE_STOP_5M_CLOSE_IMMEDIATE: envBool("MANUAL_ONE_STOP_5M_CLOSE_IMMEDIATE", true),
  MANUAL_ONE_STOP_TARGET_EXIT_ENABLED: envBool("MANUAL_ONE_STOP_TARGET_EXIT_ENABLED", true),

  // v1h dynamic brain-managed profit exit. Every emitted close remains 100%.
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

  // v1i Phase-2 re-entry: strict pullback reclaim micro-breakout observer.
  // This release intentionally NEVER sends automatic enter_long signals.
  REENTRY_ENABLED: envBool("REENTRY_ENABLED", true),
  REENTRY_PHASE: envStr("REENTRY_PHASE", "shadow").toLowerCase(),
  REENTRY_AUTO_FORWARD_ENABLED: envBool("REENTRY_AUTO_FORWARD_ENABLED", false),
  REENTRY_MAX_COUNT: Math.floor(envNum("REENTRY_MAX_COUNT", 1)),
  REENTRY_REQUIRE_PRIOR_DYNAMIC_ARM: envBool("REENTRY_REQUIRE_PRIOR_DYNAMIC_ARM", true),
  REENTRY_REQUIRE_NON_STOP_EXIT: envBool("REENTRY_REQUIRE_NON_STOP_EXIT", true),
  REENTRY_MIN_PRIOR_IMPULSE_PCT: envNum("REENTRY_MIN_PRIOR_IMPULSE_PCT", 0.60),
  REENTRY_CAMPAIGN_MAX_AGE_SEC: envNum("REENTRY_CAMPAIGN_MAX_AGE_SEC", 14400),
  REENTRY_CONTEXT_MAX_AGE_SEC: envNum("REENTRY_CONTEXT_MAX_AGE_SEC", 420),
  REENTRY_REQUIRE_RAY_BULL: envBool("REENTRY_REQUIRE_RAY_BULL", false),
  REENTRY_REQUIRE_5M_EMA_BULL: envBool("REENTRY_REQUIRE_5M_EMA_BULL", true),
  REENTRY_MIN_5M_FVVO: envNum("REENTRY_MIN_5M_FVVO", -0.50),
  REENTRY_PULLBACK_MIN_PCT: envNum("REENTRY_PULLBACK_MIN_PCT", 0.35),
  REENTRY_PULLBACK_MAX_PCT: envNum("REENTRY_PULLBACK_MAX_PCT", 1.20),
  REENTRY_MAX_BELOW_EMA18_PCT: envNum("REENTRY_MAX_BELOW_EMA18_PCT", 0.15),
  REENTRY_MIN_BOUNCE_FROM_LOW_PCT: envNum("REENTRY_MIN_BOUNCE_FROM_LOW_PCT", 0.25),
  REENTRY_REQUIRE_RECLAIM_EMA8: envBool("REENTRY_REQUIRE_RECLAIM_EMA8", true),
  REENTRY_MIN_RSI: envNum("REENTRY_MIN_RSI", 54),
  REENTRY_MAX_RSI: envNum("REENTRY_MAX_RSI", 84),
  REENTRY_MIN_ADX: envNum("REENTRY_MIN_ADX", 17),
  REENTRY_MIN_FVVO: envNum("REENTRY_MIN_FVVO", -1.00),
  REENTRY_MIN_SLOPE: envNum("REENTRY_MIN_SLOPE", 0.50),
  REENTRY_MAX_CHASE_ABOVE_EMA8_PCT: envNum("REENTRY_MAX_CHASE_ABOVE_EMA8_PCT", 0.30),
  REENTRY_RECLAIM_CONFIRM_OBSERVATIONS: Math.floor(envNum("REENTRY_RECLAIM_CONFIRM_OBSERVATIONS", 2)),
  REENTRY_STOP_BUFFER_PCT: envNum("REENTRY_STOP_BUFFER_PCT", 0.15),
  REENTRY_MIN_STOP_DISTANCE_PCT: envNum("REENTRY_MIN_STOP_DISTANCE_PCT", 0.25),
  REENTRY_MAX_STOP_DISTANCE_PCT: envNum("REENTRY_MAX_STOP_DISTANCE_PCT", 1.20),
};

const PROFILE = "MANUAL_ONE_STOP_DYNAMIC_PROFIT_FULL_EXIT";
const REENTRY_PROFILE = "AUTO_REENTRY_PULLBACK_MICROBREAKOUT_SHADOW";
const STATE_PATH = path.join(CFG.STATE_DIR, CFG.STATE_FILE_NAME);
const STATE_BACKUP_PATH = `${STATE_PATH}.bak`;

const LOG_MARKER = {
  inbound: "📩", feature5m: "📊", featureTick: "⚡", strategy: "🧠", entry: "🟢",
  protect: "🟡", exit: "🔴", lock: "🔒", confirmed: "✅", warning: "⚠", error: "❌", persistence: "💾",
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

function logMarker(level, event, fields = {}) {
  const name = String(event || "").toUpperCase();
  const action = String(fields.action || "").toLowerCase();
  if (level === "ERROR" || name.includes("FAILED") || name.includes("FATAL") || name.includes("REJECTED")) return LOG_MARKER.error;
  if (level === "WARN" || name.includes("BLOCK") || name.includes("EXPIRED")) return LOG_MARKER.warning;
  if (name.includes("PERSIST") || name.includes("STATE_")) return LOG_MARKER.persistence;
  if (name.includes("FEATURE_5M")) return LOG_MARKER.feature5m;
  if (name.includes("FEATURE_TICK") || name.includes("FAST_TICK")) return LOG_MARKER.featureTick;
  if (name.includes("WEBHOOK") || name.includes("MANUAL_COMMAND")) return LOG_MARKER.inbound;
  if (name.includes("REENTRY")) return LOG_MARKER.strategy;
  if (name.includes("PRICE_TRIGGER")) return LOG_MARKER.entry;
  if (name.includes("ENTRY") || name.includes("TRADE_OPEN") || action === "enter_long") return LOG_MARKER.entry;
  if (name.includes("DYNAMIC_PROFIT") || name.includes("FLOOR")) return LOG_MARKER.protect;
  if (name.includes("EXIT") || name.includes("STOP") || name.includes("TARGET") || action === "exit_long") return LOG_MARKER.exit;
  if (name.includes("LOCK") || name.includes("HANDOFF") || name.includes("RECOVERY")) return LOG_MARKER.lock;
  if (name.includes("CONFIRMED") || name.includes("ACCEPTED")) return LOG_MARKER.confirmed;
  return LOG_MARKER.strategy;
}

function log(level, event, fields = {}) {
  const marker = CFG.FVVO_LOG_UNICODE_MARKERS_ENABLED ? logMarker(level, event, fields) : "";
  console.log(`${nowIso()}${marker ? ` ${marker}` : ""} ${event} | ${JSON.stringify({ brain: CFG.BRAIN_NAME, ...fields })}`);
}

function defaultState() {
  return {
    schemaVersion: 7,
    updatedAt: nowIso(),
    lastFeature: null,
    lastFeature5m: null,
    lastFastTick: null,
    position: null,
    externalDealLock: { active: false, source: "", setAt: "", reason: "" },
    manual: { handoffActive: false, recoveryRequired: false, recoveryReason: "", lastAction: "", lastActionAt: "" },
    forward: { lastByKey: {}, lastRequestId: "" },
    reentry: { campaign: null, recentTickPrices: [] },
    priceEntry: { pending: null, last: null },
  };
}

function normalizeState(raw) {
  const fallback = defaultState();
  if (!raw || typeof raw !== "object") return fallback;
  const next = { ...fallback, ...raw };
  next.forward = { ...fallback.forward, ...(raw.forward || {}) };
  next.manual = { ...fallback.manual, ...(raw.manual || {}) };
  next.externalDealLock = { ...fallback.externalDealLock, ...(raw.externalDealLock || {}) };
  next.reentry = { ...fallback.reentry, ...(raw.reentry || {}) };
  next.reentry.recentTickPrices = Array.isArray(next.reentry.recentTickPrices) ? next.reentry.recentTickPrices.slice(-12) : [];
  next.priceEntry = { ...fallback.priceEntry, ...(raw.priceEntry || {}) };
  if (next.priceEntry.pending && typeof next.priceEntry.pending !== "object") next.priceEntry.pending = null;
  if (next.priceEntry.last && typeof next.priceEntry.last !== "object") next.priceEntry.last = null;

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
  if (CFG.C3_ENTRY_SIZE_SOURCE !== "bot_fixed") problems.push("C3_ENTRY_SIZE_SOURCE_MUST_BE_BOT_FIXED");
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
  if (CFG.REENTRY_PHASE !== "shadow") problems.push("REENTRY_PHASE_MUST_BE_SHADOW_IN_V1J");
  if (CFG.REENTRY_AUTO_FORWARD_ENABLED) problems.push("REENTRY_AUTO_FORWARD_MUST_BE_FALSE_IN_V1J");
  if (CFG.REENTRY_MAX_COUNT < 1 || CFG.REENTRY_MAX_COUNT > 2) problems.push("REENTRY_MAX_COUNT_MUST_BE_1_OR_2");
  if (CFG.REENTRY_MIN_PRIOR_IMPULSE_PCT <= 0 || CFG.REENTRY_CAMPAIGN_MAX_AGE_SEC <= 0 || CFG.REENTRY_CONTEXT_MAX_AGE_SEC <= 0) problems.push("INVALID_REENTRY_CAMPAIGN_GUARD");
  if (CFG.REENTRY_PULLBACK_MIN_PCT <= 0 || CFG.REENTRY_PULLBACK_MAX_PCT < CFG.REENTRY_PULLBACK_MIN_PCT) problems.push("INVALID_REENTRY_PULLBACK_RANGE");
  if (CFG.REENTRY_MAX_BELOW_EMA18_PCT < 0 || CFG.REENTRY_MIN_BOUNCE_FROM_LOW_PCT <= 0) problems.push("INVALID_REENTRY_RECLAIM_STRUCTURE");
  if (CFG.REENTRY_MIN_RSI <= 0 || CFG.REENTRY_MAX_RSI < CFG.REENTRY_MIN_RSI || CFG.REENTRY_MIN_ADX < 0) problems.push("INVALID_REENTRY_MOMENTUM_RANGE");
  if (CFG.REENTRY_RECLAIM_CONFIRM_OBSERVATIONS < 1) problems.push("INVALID_REENTRY_RECLAIM_CONFIRM_OBSERVATIONS");
  if (CFG.REENTRY_STOP_BUFFER_PCT < 0 || CFG.REENTRY_MIN_STOP_DISTANCE_PCT <= 0 || CFG.REENTRY_MAX_STOP_DISTANCE_PCT < CFG.REENTRY_MIN_STOP_DISTANCE_PCT) problems.push("INVALID_REENTRY_STOP_PROJECTION");
  if (CFG.PRICE_ENTRY_DEFAULT_EXPIRY_SEC < CFG.PRICE_ENTRY_MIN_EXPIRY_SEC || CFG.PRICE_ENTRY_MAX_EXPIRY_SEC < CFG.PRICE_ENTRY_MIN_EXPIRY_SEC) problems.push("INVALID_PRICE_ENTRY_EXPIRY_RANGE");
  if (CFG.PRICE_ENTRY_MIN_TRIGGER_DISTANCE_PCT <= 0 || CFG.PRICE_ENTRY_MAX_TRIGGER_DISTANCE_PCT < CFG.PRICE_ENTRY_MIN_TRIGGER_DISTANCE_PCT) problems.push("INVALID_PRICE_ENTRY_TRIGGER_DISTANCE_RANGE");
  if (CFG.STATE_PERSISTENCE_REQUIRED && !persistenceReady) problems.push("PERSISTENCE_NOT_READY");
  return problems;
}

function getBotUuid() {
  const map = CFG.SYMBOL_BOT_MAP || {};
  return String(map[CFG.SYMBOL] || map[cleanSymbol(CFG.SYMBOL)] || CFG.C3_BOT_UUID || "").trim();
}

function legacyEntrySizingVariablesPresent() {
  return ["C3_ENTRY_ORDER_AMOUNT", "C3_ENTRY_ORDER_CURRENCY_TYPE", "C3_ENTRY_ORDER_TYPE", "C3_ORDER_AMOUNT_QUOTE"]
    .filter((name) => Object.prototype.hasOwnProperty.call(process.env, name) && String(process.env[name] || "").trim() !== "");
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
    rsi: firstFinite(payload.rsi, payload.rsiValue),
    adx: firstFinite(payload.adx, payload.adxValue),
    crossUp: Boolean(payload.crossUp ?? payload.fvvoCrossUp),
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

function buildPosition(entryPrice, levels, options = {}) {
  return {
    symbol: CFG.SYMBOL,
    profile: options.profile || PROFILE,
    entryOrigin: options.entryOrigin || "MANUAL",
    reentryNumber: Number(options.reentryNumber || 0),
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
    // v1h deliberately omits body.order. The Signal Bot's own fixed entry size/type owns execution.
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

  log("INFO", "C3_FORWARD_SEND", { action, reason, symbol: CFG.SYMBOL, price, requestId, c3Timestamp: body.timestamp, triggerPrice: body.trigger_price, hasOrder: Boolean(body.order), entrySizeSource: action === "enter_long" ? CFG.C3_ENTRY_SIZE_SOURCE : null, dryRun: CFG.C3_DRY_RUN });
  if (CFG.C3_PAYLOAD_AUDIT_ENABLED) log("INFO", "C3_FORWARD_PAYLOAD_AUDIT", { requestId, action, reason, schema: "CUSTOM_SIGNAL_ISO8601_BOT_FIXED_ENTRY_DYNAMIC_PROFIT_FULL_EXIT", body: { ...body, secret: "REDACTED" } });

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
    reentryAutomaticOrdersEnabled: false,
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
    c3ExecutionContract: {
      entrySizeSource: CFG.C3_ENTRY_SIZE_SOURCE,
      entryOrderIncludedInWebhook: false,
      requiredBotEntryOrder: "fixed quote amount + Market",
      exitOrderIncludedInWebhook: CFG.C3_EXIT_INCLUDE_POSITION_ORDER,
      exitPercent: 100,
      nativeStopAttachedToEntry: CFG.C3_NATIVE_STOP_ENABLED,
    },
    priceTriggerEntry: priceEntryStatusPayload(),
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
    reentry: reentryStatusPayload(),
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

  if (state.priceEntry?.pending) {
    log("INFO", "FVVO_PRICE_TRIGGER_CANCELLED_BY_IMMEDIATE_MANUAL_ENTRY", { triggerId: state.priceEntry.pending.id, triggerMode: state.priceEntry.pending.triggerMode, triggerPrice: state.priceEntry.pending.triggerPrice });
    state.priceEntry = { pending: null, last: { ...state.priceEntry.pending, status: "CANCELLED_BY_IMMEDIATE_MANUAL_ENTRY", resolvedAt: nowIso(), resolvedAtMs: nowMs() } };
  }
  if (state.reentry?.campaign) {
    log("INFO", "FVVO_REENTRY_CAMPAIGN_CANCELLED_BY_MANUAL_ENTRY", { campaignId: state.reentry.campaign.id, observedCandidates: state.reentry.campaign.observedCandidates || 0 });
  }
  state.reentry = { campaign: null, recentTickPrices: [] };
  state.position = buildPosition(entry, levels, { entryOrigin: "MANUAL" });
  state.externalDealLock = { active: true, source: "manual_enter", setAt: nowIso(), reason: "ENTRY_REQUEST_PENDING" };
  state.manual = { ...state.manual, handoffActive: false, recoveryRequired: false, recoveryReason: "", lastAction: "enter_long", lastActionAt: nowIso() };
  if (!(await persistState("manual_enter_pre_forward"))) return { status: 503, body: { ok: false, error: "STATE_PERSISTENCE_FAILED_BEFORE_ENTRY" } };

  log("INFO", "FVVO_TRADE_OPEN_PENDING", { profile: PROFILE, entryPriceReference: entry, stopPrice: levels.stopPrice, profitTargetPrice: levels.profitTargetPrice || null, stopExitPercent: 100, targetExitPercent: 100, entrySizeSource: CFG.C3_ENTRY_SIZE_SOURCE, entryOrderIncludedInWebhook: false, dynamicProfitEnabled: CFG.DYNAMIC_PROFIT_EXIT_ENABLED, dynamicProfitArmMfePct: CFG.DYNAMIC_PROFIT_ARM_MFE_PCT, dynamicProfitMinLockPnlPct: CFG.DYNAMIC_PROFIT_MIN_LOCK_PNL_PCT });
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
  log("INFO", "FVVO_MANUAL_ONE_STOP_ENTRY_TRACKED", { entryPriceReference: entry, stopPrice: levels.stopPrice, stopDistancePct: levels.stopPct, profitTargetPrice: levels.profitTargetPrice || null, profitTargetDistancePct: levels.profitTargetPct, entrySizeSource: CFG.C3_ENTRY_SIZE_SOURCE, entryOrderIncludedInWebhook: false, nativeStopSent: CFG.C3_NATIVE_STOP_ENABLED, dynamicProfitEnabled: CFG.DYNAMIC_PROFIT_EXIT_ENABLED, dynamicProfitArmMfePct: CFG.DYNAMIC_PROFIT_ARM_MFE_PCT, requestId: result.requestId, fillVerified: false });
  return { status: 200, body: { ok: true, forwarded: true, acceptedBy3CommasWebhook: true, exchangeFillVerified: false, brainWillManageExit: true, manualEntryTracked: true, externalDealLockActive: true, profile: PROFILE, entrySizeSource: CFG.C3_ENTRY_SIZE_SOURCE, entryOrderIncludedInWebhook: false, entrySizeConfiguredInBot: true, entryPriceReference: entry, stopPrice: levels.stopPrice, stopDistancePct: levels.stopPct, profitTargetPrice: levels.profitTargetPrice || null, profitTargetDistancePct: levels.profitTargetPct, dynamicProfitEnabled: CFG.DYNAMIC_PROFIT_EXIT_ENABLED, dynamicProfitArmMfePct: CFG.DYNAMIC_PROFIT_ARM_MFE_PCT, dynamicProfitMinLockPnlPct: CFG.DYNAMIC_PROFIT_MIN_LOCK_PNL_PCT, requestId: result.requestId } };
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

function ensureReentryState() {
  if (!state.reentry || typeof state.reentry !== "object") state.reentry = { campaign: null, recentTickPrices: [] };
  if (!Array.isArray(state.reentry.recentTickPrices)) state.reentry.recentTickPrices = [];
  return state.reentry;
}

function reentryStatusPayload() {
  const r = ensureReentryState();
  const c = r.campaign;
  return {
    enabled: CFG.REENTRY_ENABLED,
    phase: CFG.REENTRY_PHASE,
    automaticOrdersEnabled: false,
    maxCount: CFG.REENTRY_MAX_COUNT,
    profile: REENTRY_PROFILE,
    campaign: c ? {
      id: c.id,
      active: Boolean(c.active),
      phase: c.phase,
      reason: c.reason || null,
      baseEntryPrice: c.baseEntryPrice,
      priorPeakPrice: c.priorPeakPrice,
      highestPrice: c.highestPrice,
      pullbackLowPrice: c.pullbackLowPrice || null,
      pullbackDepthPct: c.pullbackDepthPct || 0,
      observedCandidates: c.observedCandidates || 0,
      candidateLimit: c.candidateLimit,
      reclaimObservations: c.reclaim?.observations || 0,
      expiresAt: c.expiresAt || null,
      lastCandidate: c.lastCandidate || null,
    } : null,
  };
}

function exitReasonLooksLikeStop(reason) {
  const text = String(reason || "").toUpperCase();
  return text.includes("STOP") || text.includes("HARD_STOP") || text.includes("PRICE_HIT_STOP");
}

function armReentryCampaignAfterConfirmedExit(prior) {
  const r = ensureReentryState();
  r.recentTickPrices = [];
  if (!CFG.REENTRY_ENABLED) {
    r.campaign = null;
    return { active: false, reason: "REENTRY_DISABLED" };
  }
  if (!prior || !Number.isFinite(finite(prior.entryPriceReference, null))) {
    r.campaign = null;
    return { active: false, reason: "NO_VALID_PRIOR_POSITION" };
  }
  const peakPnlPct = Math.max(finite(prior.peakPnlPct, 0), finite(prior.dynamicProfit?.peakPnlPct, 0));
  const dynamicArmed = Boolean(prior.dynamicProfit?.armed) || peakPnlPct >= CFG.DYNAMIC_PROFIT_ARM_MFE_PCT;
  const priorPeakPrice = Math.max(
    finite(prior.dynamicProfit?.peakPrice, 0),
    finite(prior.entryPriceReference, 0) * (1 + peakPnlPct / 100),
    finite(prior.latestPrice, 0)
  );
  const impulsePct = percentPnl(prior.entryPriceReference, priorPeakPrice);
  if (CFG.REENTRY_REQUIRE_PRIOR_DYNAMIC_ARM && !dynamicArmed) {
    r.campaign = null;
    log("INFO", "FVVO_REENTRY_CAMPAIGN_NOT_ARMED", { reason: "PRIOR_DYNAMIC_PROFIT_NOT_ARMED", priorExitReason: prior.exitReason || null, peakPnlPct });
    return { active: false, reason: "PRIOR_DYNAMIC_PROFIT_NOT_ARMED" };
  }
  if (CFG.REENTRY_REQUIRE_NON_STOP_EXIT && exitReasonLooksLikeStop(prior.exitReason)) {
    r.campaign = null;
    log("INFO", "FVVO_REENTRY_CAMPAIGN_NOT_ARMED", { reason: "PRIOR_EXIT_WAS_STOP", priorExitReason: prior.exitReason || null, peakPnlPct });
    return { active: false, reason: "PRIOR_EXIT_WAS_STOP" };
  }
  if (impulsePct + 1e-9 < CFG.REENTRY_MIN_PRIOR_IMPULSE_PCT) {
    r.campaign = null;
    log("INFO", "FVVO_REENTRY_CAMPAIGN_NOT_ARMED", { reason: "PRIOR_IMPULSE_TOO_SMALL", impulsePct: round(impulsePct, 6), requiredImpulsePct: CFG.REENTRY_MIN_PRIOR_IMPULSE_PCT, peakPnlPct });
    return { active: false, reason: "PRIOR_IMPULSE_TOO_SMALL" };
  }
  const current = nowMs();
  const campaign = {
    id: crypto.randomUUID(),
    active: true,
    phase: "WAIT_PULLBACK",
    reason: "ARMED_AFTER_CONFIRMED_PROFITABLE_CYCLE",
    sourceEntryOrigin: prior.entryOrigin || "MANUAL",
    sourceExitReason: prior.exitReason || null,
    sourceExitPrice: finite(prior.latestPrice, prior.entryPriceReference),
    baseEntryPrice: round(prior.entryPriceReference, 8),
    priorPeakPrice: round(priorPeakPrice, 8),
    highestPrice: round(priorPeakPrice, 8),
    pullbackLowPrice: null,
    pullbackDepthPct: 0,
    pullbackSeenAtMs: 0,
    pullbackSeenAt: null,
    reclaim: { observations: 0, firstAtMs: 0, lastPrice: null },
    observedCandidates: 0,
    candidateLimit: CFG.REENTRY_MAX_COUNT,
    lastCandidate: null,
    armedAtMs: current,
    armedAt: nowIso(),
    expiresAtMs: current + CFG.REENTRY_CAMPAIGN_MAX_AGE_SEC * 1000,
    expiresAt: new Date(current + CFG.REENTRY_CAMPAIGN_MAX_AGE_SEC * 1000).toISOString(),
  };
  r.campaign = campaign;
  log("INFO", "FVVO_REENTRY_CAMPAIGN_ARMED", {
    campaignId: campaign.id,
    mode: "shadow",
    profile: REENTRY_PROFILE,
    baseEntryPrice: campaign.baseEntryPrice,
    priorPeakPrice: campaign.priorPeakPrice,
    priorImpulsePct: round(impulsePct, 6),
    minPriorImpulsePct: CFG.REENTRY_MIN_PRIOR_IMPULSE_PCT,
    priorExitReason: campaign.sourceExitReason,
    maxCount: CFG.REENTRY_MAX_COUNT,
    automaticOrderWillBeSent: false,
  });
  return campaign;
}

function addReentryTickPrice(feature) {
  const r = ensureReentryState();
  if (feature.kind !== CFG.FVVO_FEATURE_TICK_EVENT || !Number.isFinite(feature.price)) return;
  r.recentTickPrices.push({ price: round(feature.price, 8), atMs: feature.receivedAtMs, barTimeMs: feature.barTimeMs });
  r.recentTickPrices = r.recentTickPrices.slice(-12);
}

function reentryContext(feature) {
  const ctx = state.lastFeature5m;
  const ctxAge = ageSec(ctx);
  const close = finite(ctx?.close, ctx?.price);
  const ema8 = finite(ctx?.ema8, null);
  const ema18 = finite(ctx?.ema18, null);
  const fvvo = finite(ctx?.fvvo, null);
  const ray = String(ctx?.rayRegime || feature.rayRegime || "RAY_NEUTRAL").toUpperCase();
  const fresh = Boolean(ctx) && ctxAge <= CFG.REENTRY_CONTEXT_MAX_AGE_SEC;
  const emaBull = !CFG.REENTRY_REQUIRE_5M_EMA_BULL || (close !== null && ema8 !== null && ema18 !== null && close >= ema18 && ema8 >= ema18);
  const rayBull = !CFG.REENTRY_REQUIRE_RAY_BULL || ray === "RAY_BULL";
  const fvvoOk = fvvo !== null && fvvo >= CFG.REENTRY_MIN_5M_FVVO;
  return { ctx, ctxAge, close, ema8, ema18, fvvo, ray, fresh, emaBull, rayBull, fvvoOk, ok: fresh && emaBull && rayBull && fvvoOk };
}

function resetReentryReclaim(campaign) {
  campaign.reclaim = { observations: 0, firstAtMs: 0, lastPrice: null };
}

function floorToStep(value) {
  const step = CFG.MANUAL_ONE_STOP_PRICE_STEP;
  return round(Math.floor((value + 1e-9) / step) * step, 8);
}

function projectReentryStop(entryPrice, pullbackLowPrice) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(pullbackLowPrice) || entryPrice <= 0 || pullbackLowPrice <= 0) return { ok: false, reason: "INVALID_STOP_INPUT" };
  const bufferedLow = pullbackLowPrice * (1 - CFG.REENTRY_STOP_BUFFER_PCT / 100);
  const minDistancePrice = entryPrice * (1 - CFG.REENTRY_MIN_STOP_DISTANCE_PCT / 100);
  const rawStop = Math.min(bufferedLow, minDistancePrice);
  const stopPrice = floorToStep(rawStop);
  const stopDistancePct = percentageBelow(entryPrice, stopPrice);
  if (!Number.isFinite(stopPrice) || stopPrice <= 0 || stopPrice >= entryPrice) return { ok: false, reason: "INVALID_PROJECTED_STOP" };
  if (stopDistancePct > CFG.REENTRY_MAX_STOP_DISTANCE_PCT + 1e-9) return { ok: false, reason: "PROJECTED_STOP_TOO_WIDE", stopPrice, stopDistancePct: round(stopDistancePct, 6) };
  return { ok: true, stopPrice, stopDistancePct: round(stopDistancePct, 6) };
}

async function evaluateReentryShadow(feature) {
  const r = ensureReentryState();
  if (!CFG.REENTRY_ENABLED || CFG.REENTRY_PHASE !== "shadow" || state.position || state.externalDealLock?.active || state.manual?.handoffActive || state.manual?.recoveryRequired) return;
  if (feature.kind !== CFG.FVVO_FEATURE_TICK_EVENT || !Number.isFinite(feature.price) || feature.price <= 0) return;
  addReentryTickPrice(feature);
  const c = r.campaign;
  if (!c || !c.active) return;
  const current = nowMs();
  if (current > finite(c.expiresAtMs, 0)) {
    c.active = false; c.phase = "EXPIRED"; c.reason = "CAMPAIGN_MAX_AGE_EXCEEDED"; resetReentryReclaim(c);
    await persistState("reentry_campaign_expired");
    log("WARN", "FVVO_REENTRY_CAMPAIGN_EXPIRED", { campaignId: c.id, maxAgeSec: CFG.REENTRY_CAMPAIGN_MAX_AGE_SEC, observedCandidates: c.observedCandidates || 0 });
    return;
  }
  if ((c.observedCandidates || 0) >= CFG.REENTRY_MAX_COUNT) {
    c.active = false; c.phase = "CANDIDATE_LIMIT_REACHED"; c.reason = "SHADOW_CANDIDATE_LIMIT_REACHED";
    await persistState("reentry_candidate_limit");
    return;
  }

  const price = feature.price;
  if (price > finite(c.highestPrice, 0) + 1e-9) {
    c.highestPrice = round(price, 8);
    c.phase = "WAIT_PULLBACK";
    c.pullbackLowPrice = null; c.pullbackDepthPct = 0; c.pullbackSeenAtMs = 0; c.pullbackSeenAt = null;
    resetReentryReclaim(c);
  }
  const impulsePct = percentPnl(c.baseEntryPrice, c.highestPrice);
  if (impulsePct + 1e-9 < CFG.REENTRY_MIN_PRIOR_IMPULSE_PCT) {
    c.phase = "WAIT_IMPULSE";
    await persistState("reentry_wait_impulse");
    return;
  }

  const context = reentryContext(feature);
  const tickEma8 = finite(feature.ema8, null);
  const tickEma18 = finite(feature.ema18, null);
  const pullbackDepthPct = percentageBelow(c.highestPrice, price);
  const belowEma18Pct = tickEma18 !== null && price < tickEma18 ? percentageBelow(tickEma18, price) : 0;

  if (c.phase === "WAIT_PULLBACK" || c.phase === "WAIT_IMPULSE") {
    if (pullbackDepthPct >= CFG.REENTRY_PULLBACK_MIN_PCT && pullbackDepthPct <= CFG.REENTRY_PULLBACK_MAX_PCT && belowEma18Pct <= CFG.REENTRY_MAX_BELOW_EMA18_PCT) {
      c.phase = "WAIT_RECLAIM";
      c.reason = "HEALTHY_PULLBACK_SEEN";
      c.pullbackLowPrice = round(price, 8);
      c.pullbackDepthPct = round(pullbackDepthPct, 6);
      c.pullbackSeenAtMs = current;
      c.pullbackSeenAt = nowIso();
      resetReentryReclaim(c);
      await persistState("reentry_pullback_seen");
      log("INFO", "FVVO_REENTRY_PULLBACK_SEEN", { campaignId: c.id, highestPrice: c.highestPrice, pullbackLowPrice: c.pullbackLowPrice, pullbackDepthPct: c.pullbackDepthPct, belowEma18Pct: round(belowEma18Pct, 6), contextReady: context.ok });
    }
    return;
  }

  if (c.phase !== "WAIT_RECLAIM") return;
  if (price < finite(c.pullbackLowPrice, Infinity)) {
    c.pullbackLowPrice = round(price, 8);
    c.pullbackDepthPct = round(percentageBelow(c.highestPrice, price), 6);
    resetReentryReclaim(c);
  }
  if (c.pullbackDepthPct > CFG.REENTRY_PULLBACK_MAX_PCT + 1e-9 || belowEma18Pct > CFG.REENTRY_MAX_BELOW_EMA18_PCT + 1e-9) {
    c.phase = "WAIT_PULLBACK";
    c.reason = "PULLBACK_INVALIDATED";
    resetReentryReclaim(c);
    await persistState("reentry_pullback_invalidated");
    log("WARN", "FVVO_REENTRY_PULLBACK_INVALIDATED", { campaignId: c.id, pullbackDepthPct: c.pullbackDepthPct, belowEma18Pct: round(belowEma18Pct, 6), maxPullbackPct: CFG.REENTRY_PULLBACK_MAX_PCT, maxBelowEma18Pct: CFG.REENTRY_MAX_BELOW_EMA18_PCT });
    return;
  }

  const rsi = finite(feature.rsi, null);
  const adx = finite(feature.adx, null);
  const fvvo = finite(feature.fvvo, null);
  const slope = finite(feature.slope, null);
  const bouncePct = percentPnl(c.pullbackLowPrice, price);
  const reclaimEma8Ok = !CFG.REENTRY_REQUIRE_RECLAIM_EMA8 || (tickEma8 !== null && price >= tickEma8);
  const chasePct = tickEma8 !== null && price > tickEma8 ? percentPnl(tickEma8, price) : 0;
  const conditions = context.ok &&
    tickEma18 !== null && price >= tickEma18 * (1 - CFG.REENTRY_MAX_BELOW_EMA18_PCT / 100) &&
    reclaimEma8Ok &&
    bouncePct >= CFG.REENTRY_MIN_BOUNCE_FROM_LOW_PCT &&
    rsi !== null && rsi >= CFG.REENTRY_MIN_RSI && rsi <= CFG.REENTRY_MAX_RSI &&
    adx !== null && adx >= CFG.REENTRY_MIN_ADX &&
    fvvo !== null && fvvo >= CFG.REENTRY_MIN_FVVO &&
    slope !== null && slope >= CFG.REENTRY_MIN_SLOPE &&
    chasePct <= CFG.REENTRY_MAX_CHASE_ABOVE_EMA8_PCT &&
    feature.redPulse !== true && feature.crossDown !== true;

  if (!conditions) {
    resetReentryReclaim(c);
    await persistState("reentry_wait_reclaim");
    return;
  }
  if (!c.reclaim.firstAtMs) c.reclaim = { observations: 1, firstAtMs: current, lastPrice: price };
  else { c.reclaim.observations = Number(c.reclaim.observations || 0) + 1; c.reclaim.lastPrice = price; }
  if (c.reclaim.observations < CFG.REENTRY_RECLAIM_CONFIRM_OBSERVATIONS) {
    await persistState("reentry_reclaim_confirming");
    log("INFO", "FVVO_REENTRY_RECLAIM_CONFIRMING", { campaignId: c.id, observations: c.reclaim.observations, requiredObservations: CFG.REENTRY_RECLAIM_CONFIRM_OBSERVATIONS, price, bouncePct: round(bouncePct, 6), contextRayRegime: context.ray });
    return;
  }

  const projectedStop = projectReentryStop(price, c.pullbackLowPrice);
  if (!projectedStop.ok) {
    c.phase = "WAIT_PULLBACK"; c.reason = projectedStop.reason; resetReentryReclaim(c);
    await persistState("reentry_projected_stop_rejected");
    log("WARN", "FVVO_REENTRY_CANDIDATE_REJECTED", { campaignId: c.id, reason: projectedStop.reason, price, pullbackLowPrice: c.pullbackLowPrice, stopDistancePct: projectedStop.stopDistancePct || null });
    return;
  }

  const candidate = {
    id: crypto.randomUUID(), profile: REENTRY_PROFILE, sequence: Number(c.observedCandidates || 0) + 1,
    observedAt: nowIso(), observedAtMs: current, price: round(price, 8), projectedStopPrice: projectedStop.stopPrice,
    projectedStopDistancePct: projectedStop.stopDistancePct, baseEntryPrice: c.baseEntryPrice, highestPrice: c.highestPrice,
    pullbackLowPrice: c.pullbackLowPrice, pullbackDepthPct: c.pullbackDepthPct, bouncePct: round(bouncePct, 6),
    tick: { ema8: tickEma8, ema18: tickEma18, rsi, adx, fvvo, slope, crossUp: feature.crossUp },
    context5m: { price: context.close, ema8: context.ema8, ema18: context.ema18, fvvo: context.fvvo, rayRegime: context.ray, ageSec: round(context.ctxAge, 2) },
    mode: "shadow", automaticOrderSent: false,
  };
  c.observedCandidates = candidate.sequence;
  c.lastCandidate = candidate;
  c.phase = "CANDIDATE_OBSERVED";
  c.reason = "PULLBACK_RECLAIM_MICROBREAKOUT_CONFIRMED";
  c.active = false;
  resetReentryReclaim(c);
  await persistState("reentry_candidate_shadow");
  log("INFO", "FVVO_REENTRY_CANDIDATE_SHADOW", candidate);
}

function ensurePriceEntryState() {
  if (!state.priceEntry || typeof state.priceEntry !== "object") state.priceEntry = { pending: null, last: null };
  if (state.priceEntry.pending && typeof state.priceEntry.pending !== "object") state.priceEntry.pending = null;
  return state.priceEntry;
}

function priceEntryStatusPayload() {
  const pe = ensurePriceEntryState();
  const pending = pe.pending;
  const serialize = (item) => item ? {
    id: item.id,
    status: item.status,
    triggerMode: item.triggerMode,
    triggerPrice: item.triggerPrice,
    armedReferencePrice: item.armedReferencePrice,
    stopPrice: item.stopPrice,
    stopPctAtTrigger: item.stopPctAtTrigger,
    profitTargetPrice: item.profitTargetPrice || null,
    profitTargetPctAtTrigger: item.profitTargetPctAtTrigger || 0,
    armedAt: item.armedAt,
    expiresAt: item.expiresAt,
    lastObservedPrice: item.lastObservedPrice,
    lastObservedAt: item.lastObservedAt,
    triggeredAt: item.triggeredAt || null,
    triggeredPrice: item.triggeredPrice || null,
    resolutionReason: item.resolutionReason || null,
    requestId: item.requestId || null,
  } : null;
  return {
    enabled: CFG.PRICE_ENTRY_ENABLED,
    profile: PROFILE,
    automaticOrderOnCross: CFG.PRICE_ENTRY_ENABLED,
    triggerSource: CFG.PRICE_ENTRY_TRIGGER_ON_FAST_TICK ? "feature_tick_or_fast_tick" : "feature_tick_only",
    requireActualCross: CFG.PRICE_ENTRY_REQUIRE_ACTUAL_CROSS,
    minTriggerDistancePct: CFG.PRICE_ENTRY_MIN_TRIGGER_DISTANCE_PCT,
    maxTriggerDistancePct: CFG.PRICE_ENTRY_MAX_TRIGGER_DISTANCE_PCT,
    pending: serialize(pending),
    last: serialize(pe.last),
  };
}

function isPriceTriggerFeature(feature) {
  return feature.kind === CFG.FVVO_FEATURE_TICK_EVENT || (CFG.PRICE_ENTRY_TRIGGER_ON_FAST_TICK && feature.kind === CFG.FVVO_FAST_TICK_EVENT);
}

function validTriggerMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "dip" || mode === "breakout" ? mode : "";
}

function resolvePriceTriggerExpiry(body) {
  const requested = oneOf(body, ["expire_after_sec", "expires_after_sec", "expiry_sec"]);
  const seconds = requested.present ? requested.value : CFG.PRICE_ENTRY_DEFAULT_EXPIRY_SEC;
  if (!Number.isFinite(seconds) || seconds < CFG.PRICE_ENTRY_MIN_EXPIRY_SEC || seconds > CFG.PRICE_ENTRY_MAX_EXPIRY_SEC) return { ok: false, error: "PRICE_TRIGGER_EXPIRY_OUT_OF_RANGE" };
  return { ok: true, seconds: Math.floor(seconds) };
}

function validatePriceTriggerCommand(body, currentPrice) {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return { ok: false, error: "VALID_FRESH_FEATURE_PRICE_REQUIRED_FOR_PRICE_TRIGGER" };
  if (hasRetiredLadderFields(body)) return { ok: false, error: "USE_STOP_PRICE_AND_OPTIONAL_PROFIT_TARGET_PRICE_ONLY_TWO_LEVEL_FIELDS_ARE_RETIRED" };
  if (["price", "entry_price", "entryPrice"].some((key) => Object.prototype.hasOwnProperty.call(body, key))) return { ok: false, error: "ENTRY_PRICE_FIELD_NOT_ALLOWED_USE_TRIGGER_PRICE" };
  const mode = validTriggerMode(body.trigger_mode || body.triggerMode);
  if (!mode) return { ok: false, error: "TRIGGER_MODE_MUST_BE_DIP_OR_BREAKOUT" };
  const trigger = oneOf(body, ["trigger_price", "triggerPrice"]);
  if (!trigger.present || !Number.isFinite(trigger.value) || !validStep(trigger.value)) return { ok: false, error: "VALID_TRIGGER_PRICE_ALIGNED_TO_PRICE_STEP_REQUIRED" };
  const triggerPrice = round(trigger.value, 8);
  const gapPct = mode === "dip" ? percentageBelow(currentPrice, triggerPrice) : percentPnl(currentPrice, triggerPrice);
  if (mode === "dip" && triggerPrice >= currentPrice) return { ok: false, error: "DIP_TRIGGER_MUST_BE_BELOW_CURRENT_PRICE" };
  if (mode === "breakout" && triggerPrice <= currentPrice) return { ok: false, error: "BREAKOUT_TRIGGER_MUST_BE_ABOVE_CURRENT_PRICE" };
  if (gapPct + 1e-9 < CFG.PRICE_ENTRY_MIN_TRIGGER_DISTANCE_PCT) return { ok: false, error: "TRIGGER_PRICE_TOO_CLOSE_TO_CURRENT_PRICE" };
  if (gapPct > CFG.PRICE_ENTRY_MAX_TRIGGER_DISTANCE_PCT + 1e-9) return { ok: false, error: "TRIGGER_PRICE_TOO_FAR_FROM_CURRENT_PRICE" };
  const levels = validateOneStopCommand(body, triggerPrice);
  if (!levels.ok) return { ok: false, error: levels.error };
  const expiry = resolvePriceTriggerExpiry(body);
  if (!expiry.ok) return expiry;
  return { ok: true, triggerMode: mode, triggerPrice, armPrice: round(currentPrice, 8), triggerDistancePct: round(gapPct, 6), levels, expirySec: expiry.seconds };
}

function validateStoredPriceTriggerAtExecution(pending, executionPrice) {
  if (!Number.isFinite(executionPrice) || executionPrice <= 0) return { ok: false, error: "INVALID_EXECUTION_PRICE" };
  const body = { stop_price: pending.stopPrice, profit_target_price: pending.profitTargetPrice || 0 };
  const levels = validateOneStopCommand(body, executionPrice);
  if (!levels.ok) return { ok: false, error: `EXECUTION_LEVELS_INVALID_${levels.error}` };
  return { ok: true, levels };
}

function priceTriggerCrossed(pending, previousPrice, currentPrice) {
  if (!Number.isFinite(previousPrice) || !Number.isFinite(currentPrice)) return false;
  const trigger = pending.triggerPrice;
  const epsilon = Math.max(CFG.MANUAL_ONE_STOP_PRICE_STEP / 10, 1e-9);
  if (pending.triggerMode === "dip") return previousPrice > trigger + epsilon && currentPrice <= trigger + epsilon;
  if (pending.triggerMode === "breakout") return previousPrice < trigger - epsilon && currentPrice >= trigger - epsilon;
  return false;
}

function resolvePriceEntryPending(status, reason, fields = {}) {
  const pe = ensurePriceEntryState();
  const pending = pe.pending;
  if (!pending) return null;
  pe.last = { ...pending, ...fields, status, resolutionReason: reason, resolvedAt: nowIso(), resolvedAtMs: nowMs() };
  pe.pending = null;
  return pe.last;
}

async function armPriceEntry(body) {
  const issue = configProblems()[0];
  if (issue) return { status: 503, body: { ok: false, error: issue } };
  if (!CFG.PRICE_ENTRY_ENABLED || !CFG.MANUAL_ALLOW_ARM_PRICE_ENTRY) return { status: 403, body: { ok: false, error: "PRICE_TRIGGER_ENTRY_DISABLED" } };
  if (String(body.profile || CFG.MANUAL_ENTRY_DEFAULT_PROFILE).trim().toUpperCase() !== PROFILE) return { status: 400, body: { ok: false, error: "ONLY_MANUAL_ONE_STOP_DYNAMIC_PROFIT_FULL_EXIT_PROFILE_ALLOWED" } };
  const pe = ensurePriceEntryState();
  if (pe.pending) return { status: 409, body: { ok: false, error: "PENDING_PRICE_ENTRY_ACTIVE", priceTriggerEntry: priceEntryStatusPayload() } };
  const block = stateBlocksNewEntry();
  if (block) return { status: 409, body: { ok: false, error: block, status: statusPayload() } };
  if (CFG.MANUAL_REQUIRE_FRESH_FEATURE_TICK && !isFeatureFresh()) return { status: 409, body: { ok: false, error: "FRESH_FEATURE_TICK_REQUIRED", featureAgeSec: ageSec(state.lastFeature) } };
  const armPrice = finite(state.lastFeature?.price, null);
  const validated = validatePriceTriggerCommand(body, armPrice);
  if (!validated.ok) return { status: 400, body: { ok: false, error: validated.error } };

  if (state.reentry?.campaign) {
    log("INFO", "FVVO_REENTRY_CAMPAIGN_CANCELLED_BY_PRICE_TRIGGER_ARM", { campaignId: state.reentry.campaign.id, observedCandidates: state.reentry.campaign.observedCandidates || 0 });
    state.reentry = { campaign: null, recentTickPrices: [] };
  }
  const current = nowMs();
  const expiresAtMs = current + validated.expirySec * 1000;
  const pending = {
    id: crypto.randomUUID(), status: "ARMED", profile: PROFILE,
    triggerMode: validated.triggerMode, triggerPrice: validated.triggerPrice,
    armedReferencePrice: validated.armPrice, triggerDistancePct: validated.triggerDistancePct,
    stopPrice: validated.levels.stopPrice, stopPctAtTrigger: validated.levels.stopPct,
    profitTargetPrice: validated.levels.profitTargetPrice, profitTargetPctAtTrigger: validated.levels.profitTargetPct,
    armedAt: nowIso(), armedAtMs: current, expiresAt: new Date(expiresAtMs).toISOString(), expiresAtMs,
    lastObservedPrice: validated.armPrice, lastObservedAt: nowIso(), lastObservedAtMs: current,
    reason: String(body.reason || "manual_price_trigger_entry"),
  };
  pe.pending = pending;
  state.manual = { ...state.manual, lastAction: "arm_price_entry", lastActionAt: nowIso() };
  if (!(await persistState("price_trigger_armed"))) return { status: 503, body: { ok: false, error: "STATE_PERSISTENCE_FAILED_WHILE_ARMING_PRICE_TRIGGER" } };
  log("INFO", "FVVO_PRICE_TRIGGER_ARMED", { triggerId: pending.id, triggerMode: pending.triggerMode, triggerPrice: pending.triggerPrice, armedReferencePrice: pending.armedReferencePrice, triggerDistancePct: pending.triggerDistancePct, stopPrice: pending.stopPrice, profitTargetPrice: pending.profitTargetPrice || null, expiresAt: pending.expiresAt, marketOrderWillBeSentOnCross: true });
  return { status: 200, body: { ok: true, priceEntryArmed: true, orderTypeOnTrigger: "market", entrySizeSource: CFG.C3_ENTRY_SIZE_SOURCE, entryOrderIncludedInWebhook: false, trigger: priceEntryStatusPayload().pending } };
}

async function cancelPriceEntry(body) {
  if (!CFG.MANUAL_ALLOW_CANCEL_PRICE_ENTRY) return { status: 403, body: { ok: false, error: "PRICE_TRIGGER_CANCEL_DISABLED" } };
  const pe = ensurePriceEntryState();
  if (!pe.pending) return { status: 409, body: { ok: false, error: "NO_PENDING_PRICE_ENTRY", priceTriggerEntry: priceEntryStatusPayload() } };
  const cancelled = resolvePriceEntryPending("CANCELLED", "MANUAL_CANCEL", { cancelReason: String(body.reason || "manual_cancel_price_entry") });
  state.manual = { ...state.manual, lastAction: "cancel_price_entry", lastActionAt: nowIso() };
  await persistState("price_trigger_cancelled");
  log("INFO", "FVVO_PRICE_TRIGGER_CANCELLED", { triggerId: cancelled.id, triggerMode: cancelled.triggerMode, triggerPrice: cancelled.triggerPrice, reason: cancelled.cancelReason });
  return { status: 200, body: { ok: true, priceEntryCancelled: true, priceTriggerEntry: priceEntryStatusPayload() } };
}

let priceEntryEvaluationQueue = Promise.resolve();
async function evaluatePriceTriggerEntry(feature) {
  const run = async () => {
    if (!CFG.PRICE_ENTRY_ENABLED || !isPriceTriggerFeature(feature) || !Number.isFinite(feature.price) || feature.price <= 0) return;
    const pe = ensurePriceEntryState();
    const pending = pe.pending;
    if (!pending) return;
    const current = nowMs();
    if (current > finite(pending.expiresAtMs, 0)) {
      const expired = resolvePriceEntryPending("EXPIRED", "EXPIRY_REACHED", { lastObservedPrice: pending.lastObservedPrice, lastObservedAt: pending.lastObservedAt });
      await persistState("price_trigger_expired");
      log("WARN", "FVVO_PRICE_TRIGGER_EXPIRED", { triggerId: expired.id, triggerMode: expired.triggerMode, triggerPrice: expired.triggerPrice, expiresAt: expired.expiresAt });
      return;
    }
    if (state.position || state.externalDealLock?.active || state.manual?.handoffActive || state.manual?.recoveryRequired) {
      const cancelled = resolvePriceEntryPending("CANCELLED", "STATE_BECAME_INELIGIBLE", { stateBlock: stateBlocksNewEntry() || "MANAGED_STATE" });
      await persistState("price_trigger_cancelled_ineligible_state");
      log("WARN", "FVVO_PRICE_TRIGGER_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, stateBlock: cancelled.stateBlock });
      return;
    }
    const previousPrice = finite(pending.lastObservedPrice, pending.armedReferencePrice);
    pending.lastObservedPrice = round(feature.price, 8);
    pending.lastObservedAt = feature.receivedAt;
    pending.lastObservedAtMs = feature.receivedAtMs;
    const crossed = CFG.PRICE_ENTRY_REQUIRE_ACTUAL_CROSS ? priceTriggerCrossed(pending, previousPrice, feature.price) : (pending.triggerMode === "dip" ? feature.price <= pending.triggerPrice : feature.price >= pending.triggerPrice);
    if (!crossed) {
      await persistState("price_trigger_watch");
      return;
    }

    const checked = validateStoredPriceTriggerAtExecution(pending, feature.price);
    if (!checked.ok) {
      const cancelled = resolvePriceEntryPending("CANCELLED", checked.error, { triggeredPrice: round(feature.price, 8), triggeredAt: nowIso(), triggeredAtMs: current });
      await persistState("price_trigger_gap_level_rejected");
      log("WARN", "FVVO_PRICE_TRIGGER_CANCELLED", { triggerId: cancelled.id, triggerMode: cancelled.triggerMode, triggerPrice: cancelled.triggerPrice, executionPrice: feature.price, reason: checked.error });
      return;
    }

    const consumed = resolvePriceEntryPending("TRIGGERED_FORWARDING", "PRICE_CROSS_CONFIRMED", { triggeredPrice: round(feature.price, 8), triggeredAt: nowIso(), triggeredAtMs: current, sourceEvent: feature.kind });
    if (state.reentry?.campaign) state.reentry = { campaign: null, recentTickPrices: [] };
    state.position = buildPosition(feature.price, checked.levels, { entryOrigin: "PRICE_TRIGGER", profile: PROFILE });
    state.position.priceTrigger = { id: consumed.id, mode: consumed.triggerMode, price: consumed.triggerPrice, armedReferencePrice: consumed.armedReferencePrice, triggeredAt: consumed.triggeredAt };
    state.externalDealLock = { active: true, source: "price_trigger_entry", setAt: nowIso(), reason: "PRICE_TRIGGER_ENTRY_PENDING_FORWARD" };
    state.manual = { ...state.manual, handoffActive: false, recoveryRequired: false, recoveryReason: "", lastAction: "price_trigger_fired", lastActionAt: nowIso() };
    await persistState("price_trigger_pre_forward");
    log("INFO", "FVVO_PRICE_TRIGGER_FIRED", { triggerId: consumed.id, triggerMode: consumed.triggerMode, triggerPrice: consumed.triggerPrice, previousPrice, executionReferencePrice: feature.price, stopPrice: checked.levels.stopPrice, profitTargetPrice: checked.levels.profitTargetPrice || null, marketOrderWillBeSent: true });
    const result = await forward3Commas("enter_long", feature.price, `PRICE_TRIGGER_${String(consumed.triggerMode || "").toUpperCase()}_CROSS`, { dedupeKey: `price_trigger_enter_${consumed.id}`, stopPct: checked.levels.stopPct });
    if (!result.ok) {
      state.position.lifecycle = "ENTRY_UNKNOWN_AFTER_FORWARD_ERROR";
      state.manual.recoveryRequired = true;
      state.manual.recoveryReason = `PRICE_TRIGGER_ENTRY_FORWARD_UNCERTAIN_${result.error}`;
      state.externalDealLock.reason = "PRICE_TRIGGER_ENTRY_FORWARD_UNCERTAIN";
      pe.last = { ...pe.last, status: "FORWARD_UNCERTAIN", requestId: result.requestId || null, resolutionReason: result.error };
      await persistState("price_trigger_forward_uncertain");
      log("ERROR", "FVVO_PRICE_TRIGGER_FORWARD_UNCERTAIN", { triggerId: consumed.id, requestId: result.requestId, error: result.error });
      return;
    }
    state.position.lifecycle = "ENTRY_ACCEPTED_UNVERIFIED_FILL";
    state.position.entryAcceptedAt = nowIso();
    state.position.entryAcceptedAtMs = nowMs();
    state.position.entryForwardRequestId = result.requestId;
    state.externalDealLock.reason = "PRICE_TRIGGER_ENTRY_ACCEPTED_UNVERIFIED_FILL";
    pe.last = { ...pe.last, status: "FORWARDED_UNVERIFIED", requestId: result.requestId, acceptedAt: nowIso(), acceptedAtMs: nowMs() };
    await persistState("price_trigger_forward_accepted");
    log("INFO", "FVVO_PRICE_TRIGGER_ENTRY_TRACKED", { triggerId: consumed.id, triggerMode: consumed.triggerMode, triggerPrice: consumed.triggerPrice, entryPriceReference: feature.price, stopPrice: checked.levels.stopPrice, stopDistancePct: checked.levels.stopPct, profitTargetPrice: checked.levels.profitTargetPrice || null, requestId: result.requestId, entrySizeSource: CFG.C3_ENTRY_SIZE_SOURCE, entryOrderIncludedInWebhook: false, fillVerified: false });
  };
  const task = priceEntryEvaluationQueue.then(run, run);
  priceEntryEvaluationQueue = task.catch(() => {});
  return task;
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
  const campaign = armReentryCampaignAfterConfirmedExit(prior);
  state.manual = { ...state.manual, recoveryRequired: false, recoveryReason: "", lastAction: "confirm_exit_closed", lastActionAt: nowIso() };
  await persistState("confirm_exit_closed");
  log("INFO", "FVVO_EXIT_RECONCILIATION_CONFIRMED", { priorExitReason: prior.exitReason, entryPrice: prior.entryPriceReference, stopPrice: prior.stopPrice, targetPrice: prior.profitTargetPrice || null, reentryCampaignArmed: Boolean(campaign?.active), reentryCampaignReason: campaign?.reason || null });
  return { status: 200, body: { ok: true, exitReconciled: true, confirmedFlat: true, reentry: reentryStatusPayload() } };
}

async function forceClearVerifiedFlat(body) {
  if (!CFG.MANUAL_ALLOW_FORCE_CLEAR_VERIFIED_FLAT) return { status: 403, body: { ok: false, error: "MANUAL_FORCE_CLEAR_DISABLED" } };
  if (body.confirm_flat !== true) return { status: 400, body: { ok: false, error: "CONFIRM_FLAT_TRUE_REQUIRED" } };
  if (String(body.confirm_phrase || "") !== CFG.MANUAL_FORCE_CLEAR_CONFIRM_PHRASE) return { status: 403, body: { ok: false, error: "FORCE_CLEAR_CONFIRM_PHRASE_REQUIRED" } };
  const prior = state.position;
  state.position = null;
  state.externalDealLock = { active: false, source: "", setAt: "", reason: "" };
  state.reentry = { campaign: null, recentTickPrices: [] };
  if (state.priceEntry?.pending) {
    state.priceEntry = { pending: null, last: { ...state.priceEntry.pending, status: "CANCELLED_BY_FORCE_CLEAR", resolvedAt: nowIso(), resolvedAtMs: nowMs() } };
  }
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
  if (action === "arm_price_entry") return armPriceEntry(body);
  if (action === "cancel_price_entry") return cancelPriceEntry(body);
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
  if (action === "clear_reentry_campaign") {
    const prior = state.reentry?.campaign || null;
    state.reentry = { campaign: null, recentTickPrices: [] };
    await persistState("clear_reentry_campaign");
    log("INFO", "FVVO_REENTRY_CAMPAIGN_CLEARED", { hadCampaign: Boolean(prior), campaignId: prior?.id || null, reason: body.reason || "" });
    return { status: 200, body: { ok: true, reentryCampaignCleared: true, reentry: reentryStatusPayload() } };
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
  log("INFO", eventName, { event: feature.kind, price: feature.price, ema8: feature.ema8, ema18: feature.ema18, rsi: feature.rsi, adx: feature.adx, fvvo: feature.fvvo, slope: feature.slope, crossUp: feature.crossUp, crossDown: feature.crossDown, redPulse: feature.redPulse, rayRegime: feature.rayRegime, publisherKind: feature.publisherKind, chartTimeframe: feature.chartTimeframe, barTimeMs: feature.barTimeMs, positionLifecycle: state.position?.lifecycle || null, phase: state.position?.phase || null, reentryPhase: state.reentry?.campaign?.phase || null, priceTriggerState: state.priceEntry?.pending?.status || null, brainExitManagementActive: Boolean(state.position && !String(state.position.lifecycle || "").startsWith("EXIT_")), reconciliationRequired: Boolean(state.manual?.recoveryRequired) });
  try {
    await manageExit(feature);
    await evaluatePriceTriggerEntry(feature);
    await evaluateReentryShadow(feature);
  } catch (error) {
    log("ERROR", "FVVO_MANAGEMENT_FAILED", { error: error.message, event: feature.kind });
    return res.status(500).json({ ok: false, error: "MANAGEMENT_FAILED" });
  }
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
  const legacyEntryVars = legacyEntrySizingVariablesPresent();
  if (legacyEntryVars.length) log("WARN", "C3_LEGACY_ENTRY_SIZE_VARIABLES_IGNORED", { variables: legacyEntryVars, requiredEntrySizeSource: "bot_fixed" });
  log("INFO", "FVVO_MANUAL_DYNAMIC_PROFIT_STARTUP", { port: CFG.PORT, webhookPath: CFG.WEBHOOK_PATH, manualPath: CFG.MANUAL_WEBHOOK_PATH, symbol: CFG.SYMBOL, demoOnly: !CFG.LIVE_FORWARD_ALLOWED, automaticEntriesEnabled: false, priceTriggerEntryEnabled: CFG.PRICE_ENTRY_ENABLED, priceTriggerEntryAutoOrderOnCross: CFG.PRICE_ENTRY_ENABLED, reentryPhase: CFG.REENTRY_PHASE, reentryAutomaticOrdersEnabled: false, reentryEnabled: CFG.REENTRY_ENABLED, reentryMaxCount: CFG.REENTRY_MAX_COUNT, allowedProfile: PROFILE, manualLevelMode: "ONE_ABSOLUTE_STOP_PRICE", entrySizeSource: CFG.C3_ENTRY_SIZE_SOURCE, entryOrderIncludedInWebhook: false, requiredBotEntryOrder: "fixed quote amount + Market", maxStopDistancePct: CFG.MANUAL_ONE_STOP_MAX_STOP_DISTANCE_PCT, maxTargetDistancePct: CFG.MANUAL_ONE_STOP_MAX_TARGET_DISTANCE_PCT, priceStep: CFG.MANUAL_ONE_STOP_PRICE_STEP, stopExitPercent: 100, targetExitPercent: 100, tickConfirmSec: CFG.MANUAL_ONE_STOP_TICK_CONFIRM_SEC, tickConfirmObservations: CFG.MANUAL_ONE_STOP_TICK_CONFIRM_OBSERVATIONS, fiveMinuteCloseImmediate: CFG.MANUAL_ONE_STOP_5M_CLOSE_IMMEDIATE, dynamicProfitEnabled: CFG.DYNAMIC_PROFIT_EXIT_ENABLED, dynamicProfitArmMfePct: CFG.DYNAMIC_PROFIT_ARM_MFE_PCT, dynamicProfitMinLockPnlPct: CFG.DYNAMIC_PROFIT_MIN_LOCK_PNL_PCT, dynamicProfitTrailGivebackStartPct: CFG.DYNAMIC_PROFIT_TRAIL_GIVEBACK_START_PCT, dynamicProfitTrailGivebackMinPct: CFG.DYNAMIC_PROFIT_TRAIL_GIVEBACK_MIN_PCT, dynamicProfitTrailTightenPer1Pct: CFG.DYNAMIC_PROFIT_TRAIL_TIGHTEN_PER_1PCT, dynamicProfitThesisTickConfirmObservations: CFG.DYNAMIC_PROFIT_THESIS_TICK_CONFIRM_OBSERVATIONS, dynamicProfit5mThesisEnabled: CFG.DYNAMIC_PROFIT_5M_THESIS_EXIT_ENABLED, priceTriggerDefaultExpirySec: CFG.PRICE_ENTRY_DEFAULT_EXPIRY_SEC, priceTriggerMinDistancePct: CFG.PRICE_ENTRY_MIN_TRIGGER_DISTANCE_PCT, priceTriggerMaxDistancePct: CFG.PRICE_ENTRY_MAX_TRIGGER_DISTANCE_PCT, priceTriggerRequireActualCross: CFG.PRICE_ENTRY_REQUIRE_ACTUAL_CROSS, persistenceReady, configurationProblems: problems });
  app.listen(CFG.PORT, () => log("INFO", "FVVO_LISTENING", { port: CFG.PORT }));
}

if (require.main === module) start().catch((error) => { log("ERROR", "FVVO_STARTUP_FATAL", { error: error.message }); process.exit(1); });

module.exports = { app, CFG, buildC3Signal, validateOneStopCommand, normalizeState, defaultState, dynamicProfitFloorPnlPct, dynamicFloorBreakConfirmed, tickThesisFailureConfirmed, fiveMinuteThesisFailure, legacyEntrySizingVariablesPresent, evaluateReentryShadow, armReentryCampaignAfterConfirmedExit, projectReentryStop, validatePriceTriggerCommand, validateStoredPriceTriggerAtExecution, priceTriggerCrossed, priceEntryStatusPayload };
