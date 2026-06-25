// ============================================================
// BrainFVVO_ManualExit_v1b_TWO_LEVEL_WASHOUT_DEMO
// Isolated SOLUSDT DEMO-only manual-entry / brain-exit service
// ------------------------------------------------------------
// Technical lineage: BrainFVVO_v2o_CROSS_EXIT_FLOOR_DEMO.
//
// This service NEVER opens automatic trades. A position is opened only
// by the authenticated /manual action=enter_long command and only using
// MANUAL_WASHOUT_TWO_LEVEL_RECOVERY.
//
// Manual lifecycle
//   1. DEFENSIVE: first support-break confirmation -> exit 50%.
//      Final support-break -> exit 100%. Normal v2o soft exits blocked.
//   2. RECOVERY_ARMED: requires MFE + structural recovery. Cross-style
//      v2o protections are enabled: fee floor, dynamic trail, fee trail,
//      red/cross/EMA weakness, fast tick / 5m backup, optional Ray-Bull
//      and squeeze holds. The final emergency stop remains active.
//
// Safety model
//   - one symbol / one dedicated 3Commas DEMO Signal Bot / one active lock
//   - no external Binance manual buy or normal adopt_long path
//   - all unresolved state is atomically persisted to a Railway Volume
//   - HTTP 200 from 3Commas is webhook acceptance, NOT exchange-fill proof
//   - all webhook secrets are supplied only by environment variables
// ============================================================

"use strict";

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb", strict: true }));

function envStr(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === null || String(value).trim() === "" ? fallback : String(value).trim();
}

function envNum(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(value).trim().toLowerCase());
}

function parseJsonEnv(name, fallback) {
  const raw = envStr(name, "");
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : fallback;
  } catch (error) {
    console.error(`${new Date().toISOString()} | CONFIG_ERROR | ${name} invalid JSON | ${error.message}`);
    return fallback;
  }
}

const CFG = {
  BRAIN_NAME: envStr("BRAIN_NAME", "BrainFVVO_ManualExit_v1b_TWO_LEVEL_WASHOUT_DEMO"),
  PORT: envNum("PORT", 8080),
  SYMBOL: envStr("SYMBOL", "BINANCE:SOLUSDT"),
  ENTRY_TF: envStr("ENTRY_TF", "5"),

  WEBHOOK_PATH: envStr("WEBHOOK_PATH", "/webhook"),
  WEBHOOK_SECRET: envStr("WEBHOOK_SECRET", ""),
  MANUAL_CONTROL_ENABLED: envBool("MANUAL_CONTROL_ENABLED", true),
  MANUAL_WEBHOOK_PATH: envStr("MANUAL_WEBHOOK_PATH", "/manual"),
  MANUAL_WEBHOOK_SECRET: envStr("MANUAL_WEBHOOK_SECRET", ""),

  // Isolated DEMO-only forwarding gate. LIVE is prohibited both here and in config validation.
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
  C3_ORDER_AMOUNT_QUOTE: envNum("C3_ORDER_AMOUNT_QUOTE", 0),
  C3_REQUEST_TIMEOUT_MS: envNum("C3_REQUEST_TIMEOUT_MS", 10000),
  C3_MAX_LAG_SEC: envNum("C3_MAX_LAG_SEC", 300),
  C3_FORWARD_DEDUP_MS: envNum("C3_FORWARD_DEDUP_MS", 60000),
  C3_NATIVE_FINAL_STOP_ENABLED: envBool("C3_NATIVE_FINAL_STOP_ENABLED", true),
  C3_PARTIAL_EXIT_ENABLED: envBool("C3_PARTIAL_EXIT_ENABLED", true),

  STATE_DIR: envStr("STATE_DIR", "/data"),
  STATE_FILE_NAME: envStr("STATE_FILE_NAME", "brainfvvo-manualexit-state.json"),
  STATE_PERSISTENCE_REQUIRED: envBool("STATE_PERSISTENCE_REQUIRED", true),

  FVVO_FEATURE_TICK_EVENT: envStr("FVVO_FEATURE_TICK_EVENT", "FEATURE_TICK_FVVO"),
  FVVO_FEATURE_5M_EVENT: envStr("FVVO_FEATURE_5M_EVENT", "FEATURE_5M_FVVO"),
  FVVO_FAST_TICK_EVENT: envStr("FVVO_FAST_TICK_EVENT", "FAST_TICK_FVVO"),
  MANUAL_REQUIRE_FRESH_FEATURE_TICK: envBool("MANUAL_REQUIRE_FRESH_FEATURE_TICK", true),
  FVVO_STALE_FEATURE_TICK_MAX_AGE_SEC: envNum("FVVO_STALE_FEATURE_TICK_MAX_AGE_SEC", 60),
  MANUAL_ENTRY_DEFAULT_PROFILE: envStr("MANUAL_ENTRY_DEFAULT_PROFILE", "MANUAL_WASHOUT_TWO_LEVEL_RECOVERY"),
  MANUAL_ALLOW_ENTER: envBool("MANUAL_ALLOW_ENTER", true),
  MANUAL_ALLOW_EXIT: envBool("MANUAL_ALLOW_EXIT", true),
  MANUAL_ALLOW_STATUS: envBool("MANUAL_ALLOW_STATUS", true),
  MANUAL_ALLOW_HANDOFF: envBool("MANUAL_ALLOW_HANDOFF", true),
  MANUAL_ALLOW_CLEAR_HANDOFF: envBool("MANUAL_ALLOW_CLEAR_HANDOFF", true),
  MANUAL_ALLOW_CONFIRM_EXIT: envBool("MANUAL_ALLOW_CONFIRM_EXIT", true),
  MANUAL_ALLOW_ADOPT: envBool("MANUAL_ALLOW_ADOPT", false),
  MANUAL_ADOPT_REQUIRE_RECOVERY_LOCK: envBool("MANUAL_ADOPT_REQUIRE_RECOVERY_LOCK", true),
  MANUAL_CLEAR_REQUIRES_CONFIRM_FLAT: envBool("MANUAL_CLEAR_REQUIRES_CONFIRM_FLAT", true),
  MANUAL_ENTRY_EXIT_GRACE_SEC: envNum("MANUAL_ENTRY_EXIT_GRACE_SEC", 8),

  // Two-level washout invalidation ladder. Both stop values are percentage distances below entry.
  MANUAL_WASHOUT_PROFILE_ENABLED: envBool("MANUAL_WASHOUT_PROFILE_ENABLED", true),
  MANUAL_WASHOUT_STOP_MIN_PCT: envNum("MANUAL_WASHOUT_STOP_MIN_PCT", 0.4),
  MANUAL_WASHOUT_STOP_MAX_PCT: envNum("MANUAL_WASHOUT_STOP_MAX_PCT", 2.0),
  MANUAL_WASHOUT_STOP_STEP_PCT: envNum("MANUAL_WASHOUT_STOP_STEP_PCT", 0.1),
  MANUAL_WASHOUT_MIN_STOP_GAP_PCT: envNum("MANUAL_WASHOUT_MIN_STOP_GAP_PCT", 0.2),
  MANUAL_WASHOUT_DEFAULT_FIRST_STOP_PCT: envNum("MANUAL_WASHOUT_DEFAULT_FIRST_STOP_PCT", 0.7),
  MANUAL_WASHOUT_DEFAULT_FINAL_STOP_PCT: envNum("MANUAL_WASHOUT_DEFAULT_FINAL_STOP_PCT", 1.0),
  MANUAL_WASHOUT_PARTIAL_EXIT_PCT: envNum("MANUAL_WASHOUT_PARTIAL_EXIT_PCT", 50),
  MANUAL_WASHOUT_FIRST_STOP_CONFIRM_SEC: envNum("MANUAL_WASHOUT_FIRST_STOP_CONFIRM_SEC", 20),
  MANUAL_WASHOUT_FIRST_STOP_CONFIRM_OBSERVATIONS: envNum("MANUAL_WASHOUT_FIRST_STOP_CONFIRM_OBSERVATIONS", 2),
  MANUAL_WASHOUT_FIRST_STOP_5M_CLOSE_IMMEDIATE: envBool("MANUAL_WASHOUT_FIRST_STOP_5M_CLOSE_IMMEDIATE", true),
  MANUAL_WASHOUT_RECOVERY_ARM_MFE_PCT: envNum("MANUAL_WASHOUT_RECOVERY_ARM_MFE_PCT", 0.45),
  MANUAL_WASHOUT_ARM_REQUIRE_ABOVE_EMA8: envBool("MANUAL_WASHOUT_ARM_REQUIRE_ABOVE_EMA8", true),
  MANUAL_WASHOUT_ARM_REQUIRE_FVVO_ABOVE_ZERO: envBool("MANUAL_WASHOUT_ARM_REQUIRE_FVVO_ABOVE_ZERO", true),
  MANUAL_WASHOUT_ARM_MAX_DOWN_SLOPE: envNum("MANUAL_WASHOUT_ARM_MAX_DOWN_SLOPE", -0.55),
  MANUAL_WASHOUT_TARGET_MIN_PCT: envNum("MANUAL_WASHOUT_TARGET_MIN_PCT", 0),
  MANUAL_WASHOUT_TARGET_MAX_PCT: envNum("MANUAL_WASHOUT_TARGET_MAX_PCT", 10),
  MANUAL_WASHOUT_TARGET_STEP_PCT: envNum("MANUAL_WASHOUT_TARGET_STEP_PCT", 0.1),
  MANUAL_WASHOUT_TARGET_TRAIL_MAX_GIVEBACK_PCT: envNum("MANUAL_WASHOUT_TARGET_TRAIL_MAX_GIVEBACK_PCT", 0.10),

  // Post-arm Cross/v2o-style protection. These are deliberately inactive in DEFENSIVE phase.
  FVVO_CROSS_HARD_STOP_PCT: envNum("FVVO_CROSS_HARD_STOP_PCT", 0.25),
  FVVO_FEE_ROUND_TRIP_PCT: envNum("FVVO_FEE_ROUND_TRIP_PCT", 0.15),
  FVVO_CROSS_MIN_EXIT_GROSS_PCT: envNum("FVVO_CROSS_MIN_EXIT_GROSS_PCT", 0.25),
  FVVO_CROSS_FEATURE_FEE_TRAIL_ENABLED: envBool("FVVO_CROSS_FEATURE_FEE_TRAIL_ENABLED", true),
  FVVO_CROSS_FEATURE_FEE_TRAIL_ARM_PCT: envNum("FVVO_CROSS_FEATURE_FEE_TRAIL_ARM_PCT", 0.20),
  FVVO_CROSS_FEATURE_FEE_TRAIL_MIN_GIVEBACK_PCT: envNum("FVVO_CROSS_FEATURE_FEE_TRAIL_MIN_GIVEBACK_PCT", 0.06),
  FVVO_CROSS_DYNAMIC_TRAIL_ENABLED: envBool("FVVO_CROSS_DYNAMIC_TRAIL_ENABLED", true),
  FVVO_CROSS_DYNAMIC_TRAIL_ARM_PCT: envNum("FVVO_CROSS_DYNAMIC_TRAIL_ARM_PCT", 0.45),
  FVVO_CROSS_DYNAMIC_TRAIL_START_GIVEBACK_PCT: envNum("FVVO_CROSS_DYNAMIC_TRAIL_START_GIVEBACK_PCT", 0.28),
  FVVO_CROSS_DYNAMIC_TRAIL_MIN_GIVEBACK_PCT: envNum("FVVO_CROSS_DYNAMIC_TRAIL_MIN_GIVEBACK_PCT", 0.12),
  FVVO_CROSS_DYNAMIC_TRAIL_TIGHTEN_PER_1PCT: envNum("FVVO_CROSS_DYNAMIC_TRAIL_TIGHTEN_PER_1PCT", 0.10),
  FVVO_CROSS_HARD_DOWN_SLOPE: envNum("FVVO_CROSS_HARD_DOWN_SLOPE", -0.55),
  FVVO_CROSS_EXIT_ON_RED_PULSE: envBool("FVVO_CROSS_EXIT_ON_RED_PULSE", true),
  FVVO_CROSS_EXIT_ON_CROSS_DOWN: envBool("FVVO_CROSS_EXIT_ON_CROSS_DOWN", true),
  FVVO_CROSS_EXIT_ON_5M_BACKUP: envBool("FVVO_CROSS_EXIT_ON_5M_BACKUP", true),
  FVVO_CROSS_EXIT_ON_FAST_TICK_BACKUP: envBool("FVVO_CROSS_EXIT_ON_FAST_TICK_BACKUP", true),

  // Cross v2o profit-hold equivalents; these never block a hard stop/final stop.
  MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_ENABLED: envBool("MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_ENABLED", true),
  MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_SEC: envNum("MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_SEC", 7200),
  MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_REQUIRE_PRICE_ABOVE_EMA18: envBool("MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_REQUIRE_PRICE_ABOVE_EMA18", true),
  MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_REQUIRE_FVVO_ABOVE_ZERO: envBool("MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_REQUIRE_FVVO_ABOVE_ZERO", true),
  MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_ENABLED: envBool("MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_ENABLED", true),
  MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_MIN_PNL_PCT: envNum("MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_MIN_PNL_PCT", 0.20),
  MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_CTX_MIN_FVVO: envNum("MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_CTX_MIN_FVVO", 0),
  MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_MAX_BELOW_EMA18_PCT: envNum("MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_MAX_BELOW_EMA18_PCT", 0.15),

  // Never assume webhook acceptance means a position was filled/closed.
  C3_ASSUME_EXIT_ACCEPTANCE: envBool("C3_ASSUME_EXIT_ACCEPTANCE", false),
};

const PROFILE = "MANUAL_WASHOUT_TWO_LEVEL_RECOVERY";
const STATE_PATH = path.join(CFG.STATE_DIR, CFG.STATE_FILE_NAME);
const STATE_BACKUP_PATH = `${STATE_PATH}.bak`;

let persistenceReady = false;
let persistenceError = "";
let state = defaultState();
let lastExitDecisionLogAt = 0;

function nowIso() { return new Date().toISOString(); }
function nowMs() { return Date.now(); }
function log(level, event, fields = {}) { console.log(`${nowIso()} | ${level} | ${CFG.BRAIN_NAME} | ${event} | ${JSON.stringify(fields)}`); }
function finite(value, fallback = null) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function firstFinite(...values) { for (const value of values) { const parsed = finite(value, null); if (parsed !== null) return parsed; } return null; }
function cleanSymbol(value) { return String(value || "").trim().toUpperCase(); }
function asBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}
function round(value, digits = 6) { return Number(Number(value).toFixed(digits)); }
function pctPrice(entry, pctBelow) { return entry * (1 - pctBelow / 100); }
function percentPnl(entry, price) { return ((price - entry) / entry) * 100; }
function percentageBelow(reference, price) { return ((reference - price) / reference) * 100; }
function safeTimingEqual(left, right) { const a = Buffer.from(String(left || "")); const b = Buffer.from(String(right || "")); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function authenticate(expected, received) { return Boolean(expected) && safeTimingEqual(expected, received); }

function defaultState() {
  return {
    schemaVersion: 2,
    updatedAt: nowIso(),
    lastFeature: null,
    position: null,
    externalDealLock: { active: false, source: "", setAt: "", reason: "" },
    manual: { handoffActive: false, recoveryRequired: false, recoveryReason: "", lastAction: "", lastActionAt: "" },
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
    position.remainingPositionPctAssumed = finite(position.remainingPositionPctAssumed, 100);
    position.partial = { status: "NONE", requestedPct: CFG.MANUAL_WASHOUT_PARTIAL_EXIT_PCT, ...((position.partial && typeof position.partial === "object") ? position.partial : {}) };
    position.firstStop = { breachAtMs: 0, observations: 0, ...((position.firstStop && typeof position.firstStop === "object") ? position.firstStop : {}) };
  }
  return {
    ...fallback,
    ...raw,
    lastFeature: raw.lastFeature && typeof raw.lastFeature === "object" ? raw.lastFeature : null,
    position,
    externalDealLock: { ...fallback.externalDealLock, ...(raw.externalDealLock || {}) },
    manual: { ...fallback.manual, ...(raw.manual || {}) },
    forward: { ...fallback.forward, ...(raw.forward || {}) },
  };
}

function getBotUuid() { return String(CFG.SYMBOL_BOT_MAP[CFG.SYMBOL] || CFG.C3_BOT_UUID || "").trim(); }
function isForwardAllowed() { return CFG.ENABLE_HTTP_FORWARD && CFG.DEMO_FORWARD_ALLOWED && !CFG.LIVE_FORWARD_ALLOWED && !CFG.SHADOW_ONLY && !CFG.FVVO_EMERGENCY_DISABLE_ALL_FORWARDS; }

function configProblems() {
  const problems = [];
  if (!CFG.WEBHOOK_SECRET) problems.push("WEBHOOK_SECRET_MISSING");
  if (!CFG.MANUAL_WEBHOOK_SECRET) problems.push("MANUAL_WEBHOOK_SECRET_MISSING");
  if (!CFG.C3_SIGNAL_SECRET) problems.push("C3_SIGNAL_SECRET_MISSING");
  if (!getBotUuid()) problems.push("DEDICATED_C3_BOT_UUID_MISSING");
  if (CFG.LIVE_FORWARD_ALLOWED) problems.push("LIVE_FORWARD_ALLOWED_MUST_BE_FALSE");
  if (!CFG.DEMO_FORWARD_ALLOWED) problems.push("DEMO_FORWARD_ALLOWED_MUST_BE_TRUE");
  if (!CFG.ENABLE_HTTP_FORWARD) problems.push("ENABLE_HTTP_FORWARD_MUST_BE_TRUE");
  if (CFG.SHADOW_ONLY) problems.push("SHADOW_ONLY_MUST_BE_FALSE");
  if (CFG.MANUAL_WASHOUT_STOP_STEP_PCT <= 0) problems.push("INVALID_STOP_STEP");
  if (CFG.MANUAL_WASHOUT_DEFAULT_FINAL_STOP_PCT - CFG.MANUAL_WASHOUT_DEFAULT_FIRST_STOP_PCT < CFG.MANUAL_WASHOUT_MIN_STOP_GAP_PCT - 1e-9) problems.push("INVALID_DEFAULT_STOP_LADDER");
  if (CFG.MANUAL_WASHOUT_PARTIAL_EXIT_PCT !== 50) problems.push("PARTIAL_EXIT_MUST_REMAIN_50_PERCENT_FOR_V1B");
  if (CFG.FVVO_CROSS_HARD_STOP_PCT <= 0) problems.push("INVALID_CROSS_HARD_STOP");
  if (CFG.FVVO_CROSS_MIN_EXIT_GROSS_PCT < CFG.FVVO_FEE_ROUND_TRIP_PCT) problems.push("EXIT_FLOOR_BELOW_ESTIMATED_FEE");
  if (CFG.STATE_PERSISTENCE_REQUIRED && !persistenceReady) problems.push("PERSISTENCE_NOT_READY");
  return problems;
}

async function ensurePersistence() {
  try {
    await fsp.mkdir(CFG.STATE_DIR, { recursive: true });
    const probe = path.join(CFG.STATE_DIR, `.brainfvvo-probe-${process.pid}-${Date.now()}`);
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

async function readJson(filePath) { return JSON.parse(await fsp.readFile(filePath, "utf8")); }

async function loadState() {
  if (!persistenceReady) return;
  let loaded = null;
  let source = "";
  try { loaded = await readJson(STATE_PATH); source = "primary"; }
  catch (primaryError) {
    try { loaded = await readJson(STATE_BACKUP_PATH); source = "backup"; }
    catch (_) { if (primaryError.code !== "ENOENT") log("WARN", "FVVO_STATE_LOAD_FAILED", { error: primaryError.message }); }
  }
  if (!loaded) { state = defaultState(); log("INFO", "FVVO_POSITION_STATE_EMPTY", { statePath: STATE_PATH }); return; }
  state = normalizeState(loaded);
  const unresolved = Boolean(state.position || state.externalDealLock.active || state.manual.handoffActive);
  if (!unresolved) { log("INFO", "FVVO_POSITION_STATE_RESTORED", { source, empty: true }); return; }
  state.manual.recoveryRequired = true;
  state.manual.recoveryReason = state.manual.handoffActive ? "MANUAL_HANDOFF_RESTORED" : "UNRESOLVED_STATE_RESTORED";
  state.manual.lastAction = "restore";
  state.manual.lastActionAt = nowIso();
  log("WARN", "FVVO_POSITION_STATE_RESTORED", {
    source,
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

async function persistState(reason) {
  if (!persistenceReady) { persistenceError = "PERSISTENCE_NOT_READY"; log("ERROR", "FVVO_STATE_SAVE_BLOCKED", { reason, error: persistenceError }); return false; }
  try {
    state.updatedAt = nowIso();
    const tempPath = `${STATE_PATH}.tmp-${process.pid}-${Date.now()}`;
    const handle = await fsp.open(tempPath, "w", 0o600);
    try { await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    try { await fsp.copyFile(STATE_PATH, STATE_BACKUP_PATH); } catch (_) {}
    await fsp.rename(tempPath, STATE_PATH);
    return true;
  } catch (error) {
    persistenceError = error.message;
    log("ERROR", "FVVO_STATE_SAVE_FAILED", { reason, error: error.message });
    return false;
  }
}

function latestFeatureAgeSec() { return state.lastFeature?.receivedAtMs ? Math.max(0, (nowMs() - Number(state.lastFeature.receivedAtMs)) / 1000) : Infinity; }
function isFeatureFresh() { return state.lastFeature?.kind === CFG.FVVO_FEATURE_TICK_EVENT && latestFeatureAgeSec() <= CFG.FVVO_STALE_FEATURE_TICK_MAX_AGE_SEC; }
function stateBlocksNewEntry() {
  if (CFG.FVVO_EMERGENCY_DISABLE_NEW_ENTRIES) return "EMERGENCY_NEW_ENTRY_DISABLE";
  if (state.position) return "MANAGED_POSITION_ACTIVE";
  if (state.externalDealLock.active) return "EXTERNAL_DEAL_LOCK_ACTIVE";
  if (state.manual.handoffActive) return "MANUAL_HANDOFF_ACTIVE";
  if (state.manual.recoveryRequired) return "RECOVERY_REQUIRED";
  return "";
}

function publicPosition(position) {
  if (!position) return null;
  return {
    symbol: position.symbol,
    profile: position.profile,
    lifecycle: position.lifecycle,
    phase: position.phase,
    entryPriceReference: position.entryPriceReference,
    entryPriceSource: position.entryPriceSource,
    exchangeFillVerified: Boolean(position.exchangeFillVerified),
    firstStopPct: position.firstStopPct,
    firstStopPrice: position.firstStopPrice,
    finalStopPct: position.finalStopPct,
    finalStopPrice: position.finalStopPrice,
    activeEmergencyStopPrice: activeEmergencyStopPrice(position),
    recoveryArmed: Boolean(position.recoveryArmed),
    recoveryArmedAt: position.recoveryArmedAt || null,
    profitTargetPct: position.profitTargetPct,
    targetReached: Boolean(position.targetReached),
    remainingPositionPctAssumed: position.remainingPositionPctAssumed,
    partial: position.partial,
    peakPnlPct: position.peakPnlPct,
    maxFavorableExcursionPct: position.maxFavorableExcursionPct,
    latestPnlPct: position.latestPnlPct,
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
    forwarding: { allowed: isForwardAllowed(), dryRun: CFG.C3_DRY_RUN, liveForwardAllowed: false },
    persistence: { ready: persistenceReady, statePath: STATE_PATH, lastError: persistenceError || null },
    latestFeature: state.lastFeature ? { kind: state.lastFeature.kind, price: state.lastFeature.price, ageSec: round(latestFeatureAgeSec(), 1), freshForManualEntry: isFeatureFresh(), receivedAt: state.lastFeature.receivedAt } : null,
    position: publicPosition(state.position),
    externalDealLockActive: Boolean(state.externalDealLock.active),
    manualState: { handoffActive: Boolean(state.manual.handoffActive), recoveryRequired: Boolean(state.manual.recoveryRequired), recoveryReason: state.manual.recoveryReason || null, lastAction: state.manual.lastAction || null, lastActionAt: state.manual.lastActionAt || null },
    entryBlockReason: stateBlocksNewEntry() || null,
  };
}

function normalizeFeature(payload, expectedEvent) {
  const event = String(payload.event || payload.type || payload.src || "").trim();
  const kind = expectedEvent || event;
  const rayRegime = String(payload.gateRayRegime || payload.context5mRayRegime || payload.rayRegime || payload.ray_regime || payload.rayRaw || "").trim().toUpperCase();
  return {
    kind, event,
    symbol: cleanSymbol(payload.symbol || payload.tv_symbol || payload.instrument || CFG.SYMBOL),
    price: firstFinite(payload.price, payload.close, payload.last, payload.markPrice, payload.mark_price),
    close: firstFinite(payload.close, payload.price, payload.last),
    high: firstFinite(payload.high, payload.price, payload.close),
    low: firstFinite(payload.low, payload.price, payload.close),
    ema8: firstFinite(payload.ema8, payload.ema_8),
    ema18: firstFinite(payload.ema18, payload.ema_18),
    rsi: firstFinite(payload.rsi),
    adx: firstFinite(payload.adx),
    fvvo: firstFinite(payload.fvvo, payload.fvvoValue, payload.fvvo_value),
    contextFvvo: firstFinite(payload.context5mFvvo, payload.context_fvvo, payload.ctxFvvo, payload.fvvo5m),
    slope: firstFinite(payload.slope, payload.fvvoSlope, payload.fvvo_slope),
    crossDown: asBool(payload.crossDown ?? payload.fvvoCrossDown ?? payload.cross_down, false),
    redPulse: asBool(payload.redPulse ?? payload.fvvoRedPulse ?? payload.redDot ?? payload.red_pulse, false),
    rayRegime,
    rayBull: asBool(payload.rayBull ?? payload.tickRayBull, rayRegime === "RAY_BULL"),
    receivedAt: nowIso(), receivedAtMs: nowMs(),
  };
}

function updateLatestFeature(feature) {
  if (!Number.isFinite(feature.price) || feature.price <= 0) return false;
  if (feature.kind === CFG.FVVO_FEATURE_TICK_EVENT) { state.lastFeature = feature; persistState("fresh_feature_tick").catch(() => {}); return true; }
  return false;
}

function validStep(value, min, max, step) {
  if (!Number.isFinite(value) || value < min - 1e-9 || value > max + 1e-9) return false;
  const units = (value - min) / step;
  return Math.abs(units - Math.round(units)) < 1e-7;
}

function validateLadder(body, requireBoth = false) {
  const firstRaw = firstFinite(body.first_stop_pct, body.firstStopPct, body.initial_stop_pct, body.initialStopPct);
  const finalRaw = firstFinite(body.final_stop_pct, body.finalStopPct, body.second_stop_pct, body.secondStopPct);
  const first = firstRaw === null ? CFG.MANUAL_WASHOUT_DEFAULT_FIRST_STOP_PCT : firstRaw;
  const final = finalRaw === null ? CFG.MANUAL_WASHOUT_DEFAULT_FINAL_STOP_PCT : finalRaw;
  if (requireBoth && (firstRaw === null || finalRaw === null)) return { ok: false, error: "FIRST_AND_FINAL_STOP_PCT_REQUIRED_FOR_ADOPT" };
  if (!validStep(first, CFG.MANUAL_WASHOUT_STOP_MIN_PCT, CFG.MANUAL_WASHOUT_STOP_MAX_PCT, CFG.MANUAL_WASHOUT_STOP_STEP_PCT)) return { ok: false, error: "INVALID_FIRST_STOP_PCT_0_1_STEP_REQUIRED" };
  if (!validStep(final, CFG.MANUAL_WASHOUT_STOP_MIN_PCT, CFG.MANUAL_WASHOUT_STOP_MAX_PCT, CFG.MANUAL_WASHOUT_STOP_STEP_PCT)) return { ok: false, error: "INVALID_FINAL_STOP_PCT_0_1_STEP_REQUIRED" };
  if (final - first < CFG.MANUAL_WASHOUT_MIN_STOP_GAP_PCT - 1e-9) return { ok: false, error: "FINAL_STOP_MUST_BE_AT_LEAST_MIN_GAP_WIDER_THAN_FIRST_STOP" };
  const targetRaw = firstFinite(body.profit_target_pct, body.profitTargetPct, body.target_pct, body.targetPct);
  const target = targetRaw === null ? 0 : targetRaw;
  if (!validStep(target, CFG.MANUAL_WASHOUT_TARGET_MIN_PCT, CFG.MANUAL_WASHOUT_TARGET_MAX_PCT, CFG.MANUAL_WASHOUT_TARGET_STEP_PCT)) return { ok: false, error: "INVALID_PROFIT_TARGET_PCT_0_1_STEP_REQUIRED" };
  return { ok: true, firstStopPct: round(first, 1), finalStopPct: round(final, 1), profitTargetPct: round(target, 1) };
}

function allowedProfile(value) { return String(value || CFG.MANUAL_ENTRY_DEFAULT_PROFILE).trim().toUpperCase() === PROFILE; }

function buildPosition(entryPrice, source, lifecycle, ladder) {
  const firstStopPrice = pctPrice(entryPrice, ladder.firstStopPct);
  const finalStopPrice = pctPrice(entryPrice, ladder.finalStopPct);
  return {
    symbol: CFG.SYMBOL, profile: PROFILE, lifecycle,
    phase: "DEFENSIVE", recoveryArmed: false, recoveryArmedAt: null,
    entryPriceReference: entryPrice, entryPriceSource: source, exchangeFillVerified: false,
    openedAt: nowIso(), openedAtMs: nowMs(), entryAcceptedAt: null,
    firstStopPct: ladder.firstStopPct, firstStopPrice,
    finalStopPct: ladder.finalStopPct, finalStopPrice,
    postArmCrossStopPct: CFG.FVVO_CROSS_HARD_STOP_PCT,
    profitTargetPct: ladder.profitTargetPct, targetReached: false, targetReachedAt: null,
    firstStop: { breachAtMs: 0, observations: 0, lastBreachPrice: null },
    partial: { status: "NONE", requestedPct: CFG.MANUAL_WASHOUT_PARTIAL_EXIT_PCT, requestedAt: null, requestId: null, acceptedAt: null, error: null },
    remainingPositionPctAssumed: 100,
    peakPnlPct: 0, maxFavorableExcursionPct: 0, latestPnlPct: 0, latestPrice: entryPrice,
    exitRequestedAt: null, exitReason: null,
  };
}

function activeEmergencyStopPrice(position) {
  if (!position) return null;
  // The active hard stop is phase-specific but derived from persisted state only.
  if (position.phase === "RECOVERY_ARMED") return pctPrice(position.entryPriceReference, finite(position.postArmCrossStopPct, CFG.FVVO_CROSS_HARD_STOP_PCT));
  return finite(position.finalStopPrice, pctPrice(position.entryPriceReference, finite(position.finalStopPct, CFG.MANUAL_WASHOUT_DEFAULT_FINAL_STOP_PCT)));
}

function dynamicGivebackLimit(peakPnlPct, targetReached) {
  const extra = Math.max(0, peakPnlPct - CFG.FVVO_CROSS_DYNAMIC_TRAIL_ARM_PCT);
  let limit = Math.max(CFG.FVVO_CROSS_DYNAMIC_TRAIL_MIN_GIVEBACK_PCT, CFG.FVVO_CROSS_DYNAMIC_TRAIL_START_GIVEBACK_PCT - extra * CFG.FVVO_CROSS_DYNAMIC_TRAIL_TIGHTEN_PER_1PCT);
  if (targetReached) limit = Math.min(limit, CFG.MANUAL_WASHOUT_TARGET_TRAIL_MAX_GIVEBACK_PCT);
  return limit;
}

function featureSoftSignal(feature, isFiveMinute) {
  const belowEma8 = Number.isFinite(feature.ema8) && Number.isFinite(feature.close) && feature.close < feature.ema8;
  const hardDownSlope = Number.isFinite(feature.slope) && feature.slope <= CFG.FVVO_CROSS_HARD_DOWN_SLOPE;
  const fvvoWeak = Number.isFinite(feature.fvvo) && feature.fvvo <= 0;
  if (isFiveMinute) return { triggered: belowEma8 && (feature.crossDown || feature.redPulse || fvvoWeak || hardDownSlope), reason: "FVVO_CROSS_5M_BACKUP_FEE_AWARE", belowEma8, hardDownSlope, fvvoWeak };
  return {
    triggered: (CFG.FVVO_CROSS_EXIT_ON_RED_PULSE && feature.redPulse) || (CFG.FVVO_CROSS_EXIT_ON_CROSS_DOWN && feature.crossDown) || (belowEma8 && (fvvoWeak || hardDownSlope)),
    reason: "FVVO_CROSS_FEATURE_SOFT_EXIT_FEE_AWARE", belowEma8, hardDownSlope, fvvoWeak,
  };
}

function rayBullHoldActive(position, feature) {
  if (!CFG.MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_ENABLED || position.phase !== "RECOVERY_ARMED") return false;
  const elapsedSec = (nowMs() - Number(position.recoveryArmedAtMs || position.openedAtMs || nowMs())) / 1000;
  if (elapsedSec > CFG.MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_SEC) return false;
  if (!feature.rayBull && feature.rayRegime !== "RAY_BULL") return false;
  if (CFG.MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_REQUIRE_PRICE_ABOVE_EMA18 && (!Number.isFinite(feature.ema18) || feature.price < feature.ema18)) return false;
  if (CFG.MANUAL_WASHOUT_V2O_RAY_BULL_HOLD_REQUIRE_FVVO_ABOVE_ZERO && (!Number.isFinite(feature.fvvo) || feature.fvvo <= 0)) return false;
  return true;
}

function squeezeHoldActive(position, feature, pnl) {
  if (!CFG.MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_ENABLED || position.phase !== "RECOVERY_ARMED") return false;
  if (pnl < CFG.MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_MIN_PNL_PCT) return false;
  const fvvoContext = Number.isFinite(feature.contextFvvo) ? feature.contextFvvo : feature.fvvo;
  if (!Number.isFinite(fvvoContext) || fvvoContext < CFG.MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_CTX_MIN_FVVO) return false;
  if (!Number.isFinite(feature.ema18)) return false;
  return percentageBelow(feature.ema18, feature.price) <= CFG.MANUAL_WASHOUT_V2O_SQUEEZE_HOLD_MAX_BELOW_EMA18_PCT;
}

function c3OrderForAction(action, options = {}) {
  if (action === "enter_long" && CFG.C3_ORDER_AMOUNT_QUOTE > 0) return { amount: CFG.C3_ORDER_AMOUNT_QUOTE, currency_type: "quote" };
  if (action === "exit_long" && Number.isFinite(options.positionPercent)) return { amount: options.positionPercent, currency_type: "position_percent" };
  return null;
}

async function forward3Commas(action, price, reason, options = {}) {
  const requestId = crypto.randomUUID();
  const dedupeKey = options.dedupeKey || `${action}:${options.positionPercent || "full"}`;
  const current = nowMs();
  const lastAt = finite(state.forward.lastByKey?.[dedupeKey], 0);
  if (!options.bypassDedupe && current - lastAt < CFG.C3_FORWARD_DEDUP_MS) return { ok: false, deduped: true, error: "C3_FORWARD_DEDUP_ACTIVE", requestId };
  if (!isForwardAllowed()) return { ok: false, error: "FORWARDING_NOT_ALLOWED", requestId };

  const body = { secret: CFG.C3_SIGNAL_SECRET, bot_uuid: getBotUuid(), max_lag: CFG.C3_MAX_LAG_SEC, timestamp: Math.floor(current / 1000), tv_exchange: "BINANCE", tv_instrument: "SOLUSDT", action };
  const order = c3OrderForAction(action, options);
  if (order) body.order = order;
  if (action === "enter_long" && CFG.C3_NATIVE_FINAL_STOP_ENABLED && Number.isFinite(options.finalStopPct)) {
    body.stop_loss = { enabled: true, breakeven: false, order_type: "market", trigger_price_percent: options.finalStopPct, trailing: { enabled: false } };
  }

  state.forward.lastByKey = { ...(state.forward.lastByKey || {}), [dedupeKey]: current };
  state.forward.lastRequestId = requestId;
  await persistState(`c3_${dedupeKey}_requested`);
  log("INFO", "C3_FORWARD_SEND", { action, reason, symbol: CFG.SYMBOL, price, positionPercent: options.positionPercent || null, requestId, dryRun: CFG.C3_DRY_RUN });

  if (CFG.C3_DRY_RUN) { log("INFO", "C3_FORWARD_DRY_RUN", { action, reason, requestId, body: { ...body, secret: "REDACTED" } }); return { ok: true, accepted: true, dryRun: true, requestId, status: 200 }; }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.C3_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(CFG.C3_SIGNAL_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    const responseText = (await response.text()).slice(0, 500);
    if (!response.ok) { log("ERROR", "C3_FORWARD_REJECTED", { action, reason, status: response.status, requestId, responseText }); return { ok: false, error: `C3_HTTP_${response.status}`, requestId, status: response.status }; }
    log("INFO", "C3_FORWARD_ACCEPTED_UNVERIFIED", { action, reason, status: response.status, requestId, responseText });
    return { ok: true, accepted: true, requestId, status: response.status };
  } catch (error) {
    const label = error.name === "AbortError" ? "C3_TIMEOUT" : "C3_NETWORK_ERROR";
    log("ERROR", label, { action, reason, requestId, error: error.message });
    return { ok: false, error: label, requestId };
  } finally { clearTimeout(timer); }
}

async function beginManualEnter(body) {
  const configIssue = configProblems()[0];
  if (configIssue) return { status: 503, body: { ok: false, error: configIssue } };
  if (!CFG.MANUAL_ALLOW_ENTER) return { status: 403, body: { ok: false, error: "MANUAL_ENTER_DISABLED" } };
  if (!CFG.MANUAL_WASHOUT_PROFILE_ENABLED) return { status: 403, body: { ok: false, error: "MANUAL_WASHOUT_PROFILE_DISABLED" } };
  if (!allowedProfile(body.profile)) return { status: 400, body: { ok: false, error: "ONLY_MANUAL_WASHOUT_TWO_LEVEL_RECOVERY_PROFILE_ALLOWED" } };
  if (["price", "entry_price", "entryPrice"].some((key) => Object.prototype.hasOwnProperty.call(body, key))) return { status: 400, body: { ok: false, error: "MANUAL_PRICE_FIELD_NOT_ALLOWED_USE_LATEST_FEATURE_PRICE" } };
  const ladder = validateLadder(body);
  if (!ladder.ok) return { status: 400, body: { ok: false, error: ladder.error } };
  const blockReason = stateBlocksNewEntry();
  if (blockReason) return { status: 409, body: { ok: false, error: blockReason, status: statusPayload() } };
  if (CFG.MANUAL_REQUIRE_FRESH_FEATURE_TICK && !isFeatureFresh()) return { status: 409, body: { ok: false, error: "FRESH_FEATURE_TICK_REQUIRED", featureAgeSec: latestFeatureAgeSec() } };
  const entryPrice = finite(state.lastFeature?.price, null);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { status: 409, body: { ok: false, error: "NO_VALID_FRESH_FEATURE_PRICE" } };

  state.position = buildPosition(entryPrice, "LATEST_FRESH_FEATURE_TICK", "ENTRY_PENDING_FORWARD", ladder);
  state.externalDealLock = { active: true, source: "manual_enter", setAt: nowIso(), reason: "ENTRY_REQUEST_PENDING" };
  state.manual = { ...state.manual, handoffActive: false, recoveryRequired: false, recoveryReason: "", lastAction: "enter_long", lastActionAt: nowIso() };
  if (!(await persistState("manual_enter_pre_forward"))) return { status: 503, body: { ok: false, error: "STATE_PERSISTENCE_FAILED_BEFORE_ENTRY" } };

  const outcome = await forward3Commas("enter_long", entryPrice, "MANUAL_WASHOUT_ENTER_LATEST_FEATURE_PRICE", { dedupeKey: "enter_long", finalStopPct: ladder.finalStopPct });
  if (!outcome.ok) {
    state.position.lifecycle = "ENTRY_UNKNOWN_AFTER_FORWARD_ERROR";
    state.manual.recoveryRequired = true;
    state.manual.recoveryReason = `ENTRY_FORWARD_UNCERTAIN_${outcome.error}`;
    state.externalDealLock.reason = "ENTRY_FORWARD_UNCERTAIN";
    await persistState("manual_enter_forward_uncertain");
    log("WARN", "FVVO_RECOVERY_REQUIRED", { reason: state.manual.recoveryReason, requestId: outcome.requestId, newEntriesBlocked: true });
    return { status: 502, body: { ok: false, error: outcome.error, requestId: outcome.requestId, externalDealLockActive: true, recoveryRequired: true } };
  }

  state.position.lifecycle = "ENTRY_ACCEPTED_UNVERIFIED_FILL";
  state.position.entryForwardRequestId = outcome.requestId;
  state.position.entryAcceptedAt = nowIso();
  state.position.entryAcceptedAtMs = nowMs();
  state.externalDealLock.reason = "ENTRY_ACCEPTED_UNVERIFIED_FILL";
  await persistState("manual_enter_accepted");
  log("INFO", "FVVO_MANUAL_WASHOUT_ENTRY_TRACKED", { entryPriceReference: entryPrice, firstStopPct: ladder.firstStopPct, firstStopPrice: state.position.firstStopPrice, finalStopPct: ladder.finalStopPct, finalStopPrice: state.position.finalStopPrice, profitTargetPct: ladder.profitTargetPct, nativeFinalStopSent: CFG.C3_NATIVE_FINAL_STOP_ENABLED, requestId: outcome.requestId, fillVerified: false });
  return { status: 200, body: { ok: true, forwarded: true, acceptedBy3CommasWebhook: true, exchangeFillVerified: false, brainWillManageExit: true, manualEntryTracked: true, externalDealLockActive: true, profile: PROFILE, entryPriceReference: entryPrice, firstStopPct: ladder.firstStopPct, firstStopPrice: state.position.firstStopPrice, finalStopPct: ladder.finalStopPct, finalStopPrice: state.position.finalStopPrice, profitTargetPct: ladder.profitTargetPct, requestId: outcome.requestId } };
}

async function requestPartialExit(reason, price, origin) {
  const position = state.position;
  if (!position) return { ok: false, error: "NO_MANAGED_POSITION" };
  if (position.partial?.status !== "NONE") return { ok: false, error: "PARTIAL_EXIT_ALREADY_REQUESTED" };
  if (!CFG.C3_PARTIAL_EXIT_ENABLED) return { ok: false, error: "C3_PARTIAL_EXIT_DISABLED" };
  position.partial = { ...position.partial, status: "PARTIAL_PENDING_FORWARD", requestedAt: nowIso(), requestedAtMs: nowMs(), reason, requestedPrice: price, requestedPct: CFG.MANUAL_WASHOUT_PARTIAL_EXIT_PCT };
  await persistState("partial_exit_pre_forward");
  const outcome = await forward3Commas("exit_long", price, reason, { positionPercent: CFG.MANUAL_WASHOUT_PARTIAL_EXIT_PCT, dedupeKey: "exit_long_partial_50" });
  if (!outcome.ok) {
    position.partial.status = "PARTIAL_UNKNOWN_AFTER_FORWARD_ERROR";
    position.partial.error = outcome.error;
    state.manual.recoveryRequired = true;
    state.manual.recoveryReason = `PARTIAL_EXIT_FORWARD_UNCERTAIN_${outcome.error}`;
    await persistState("partial_exit_forward_uncertain");
    log("WARN", "FVVO_RECOVERY_REQUIRED", { reason: state.manual.recoveryReason, origin, requestId: outcome.requestId, newEntriesBlocked: true, fullExitStillAllowed: true });
    return outcome;
  }
  position.partial.status = "PARTIAL_ACCEPTED_UNVERIFIED";
  position.partial.requestId = outcome.requestId;
  position.partial.acceptedAt = nowIso();
  position.remainingPositionPctAssumed = 100 - CFG.MANUAL_WASHOUT_PARTIAL_EXIT_PCT;
  await persistState("partial_exit_accepted");
  log("WARN", "FVVO_MANUAL_PARTIAL_EXIT_ACCEPTED_UNVERIFIED", { reason, origin, price, requestedPct: CFG.MANUAL_WASHOUT_PARTIAL_EXIT_PCT, assumedRemainingPct: position.remainingPositionPctAssumed, requestId: outcome.requestId, exchangePartialFillVerified: false });
  return { ...outcome, partialUnverified: true };
}

async function requestFullExit(reason, price, origin) {
  const position = state.position;
  if (!position) return { ok: false, error: "NO_MANAGED_POSITION" };
  if (state.manual.handoffActive) return { ok: false, error: "MANUAL_HANDOFF_ACTIVE" };
  if (String(position.lifecycle).startsWith("EXIT_")) return { ok: false, error: "EXIT_ALREADY_REQUESTED" };
  const outcome = await forward3Commas("exit_long", price, reason, { positionPercent: 100, dedupeKey: "exit_long_full_100", bypassDedupe: true });
  if (!outcome.ok) {
    position.lifecycle = "EXIT_UNKNOWN_AFTER_FORWARD_ERROR";
    position.exitRequestedAt = nowIso(); position.exitReason = reason;
    state.manual.recoveryRequired = true; state.manual.recoveryReason = `EXIT_FORWARD_UNCERTAIN_${outcome.error}`;
    await persistState("full_exit_forward_uncertain");
    log("WARN", "FVVO_RECOVERY_REQUIRED", { reason: state.manual.recoveryReason, origin, requestId: outcome.requestId, newEntriesBlocked: true });
    return outcome;
  }
  position.lifecycle = "EXIT_ACCEPTED_UNVERIFIED_CLOSE";
  position.exitRequestedAt = nowIso(); position.exitReason = reason; position.exitRequestPrice = price; position.exitForwardRequestId = outcome.requestId;
  state.manual.recoveryRequired = !CFG.C3_ASSUME_EXIT_ACCEPTANCE;
  state.manual.recoveryReason = CFG.C3_ASSUME_EXIT_ACCEPTANCE ? "" : "EXIT_ACCEPTED_UNVERIFIED_CLOSE";
  state.externalDealLock = { active: !CFG.C3_ASSUME_EXIT_ACCEPTANCE, source: "brain_full_exit", setAt: nowIso(), reason: CFG.C3_ASSUME_EXIT_ACCEPTANCE ? "EXIT_ASSUMED_CLOSED_BY_CONFIG" : "EXIT_ACCEPTED_UNVERIFIED_CLOSE" };
  if (CFG.C3_ASSUME_EXIT_ACCEPTANCE) state.position = null;
  await persistState("full_exit_accepted");
  log("INFO", "FVVO_FULL_EXIT_SIGNAL_ACCEPTED_UNVERIFIED", { origin, reason, price, requestId: outcome.requestId, exchangeCloseVerified: false, recoveryRequired: !CFG.C3_ASSUME_EXIT_ACCEPTANCE });
  return { ...outcome, exitUnverified: !CFG.C3_ASSUME_EXIT_ACCEPTANCE };
}

function firstStopBreakConfirmed(position, feature, markPrice) {
  if (position.partial?.status !== "NONE") return { confirmed: false, reason: "PARTIAL_ALREADY_REQUESTED" };
  if (markPrice > position.firstStopPrice) {
    if (position.firstStop?.observations) { position.firstStop = { breachAtMs: 0, observations: 0, lastBreachPrice: null }; }
    return { confirmed: false, reason: "ABOVE_FIRST_STOP" };
  }
  if (feature.kind === CFG.FVVO_FEATURE_5M_EVENT && CFG.MANUAL_WASHOUT_FIRST_STOP_5M_CLOSE_IMMEDIATE && Number.isFinite(feature.close) && feature.close <= position.firstStopPrice) return { confirmed: true, reason: "FIRST_STOP_5M_CLOSE_BREAK" };
  const current = nowMs();
  if (!position.firstStop?.breachAtMs) position.firstStop = { breachAtMs: current, observations: 1, lastBreachPrice: markPrice };
  else { position.firstStop.observations = Number(position.firstStop.observations || 0) + 1; position.firstStop.lastBreachPrice = markPrice; }
  const elapsed = (current - position.firstStop.breachAtMs) / 1000;
  const observations = Number(position.firstStop.observations || 0);
  return { confirmed: observations >= CFG.MANUAL_WASHOUT_FIRST_STOP_CONFIRM_OBSERVATIONS && elapsed >= CFG.MANUAL_WASHOUT_FIRST_STOP_CONFIRM_SEC, reason: "FIRST_STOP_FAST_CONFIRM", elapsedSec: elapsed, observations };
}

function recoveryCanArm(position, feature, pnl) {
  if (pnl < CFG.MANUAL_WASHOUT_RECOVERY_ARM_MFE_PCT) return false;
  if (CFG.MANUAL_WASHOUT_ARM_REQUIRE_ABOVE_EMA8 && (!Number.isFinite(feature.ema8) || feature.price < feature.ema8)) return false;
  if (CFG.MANUAL_WASHOUT_ARM_REQUIRE_FVVO_ABOVE_ZERO && (!Number.isFinite(feature.fvvo) || feature.fvvo <= 0)) return false;
  if (Number.isFinite(feature.slope) && feature.slope <= CFG.MANUAL_WASHOUT_ARM_MAX_DOWN_SLOPE) return false;
  return true;
}

function entryGraceActive(position) { return position.entryAcceptedAtMs && nowMs() - Number(position.entryAcceptedAtMs) < CFG.MANUAL_ENTRY_EXIT_GRACE_SEC * 1000; }

async function manageExit(feature) {
  const position = state.position;
  if (!position || state.manual.handoffActive || String(position.lifecycle).startsWith("EXIT_")) return;
  const markPrice = firstFinite(feature.price, feature.close);
  if (!Number.isFinite(markPrice) || markPrice <= 0) return;

  const entry = position.entryPriceReference;
  const pnl = percentPnl(entry, markPrice);
  position.latestPrice = markPrice; position.latestPnlPct = pnl;
  position.peakPnlPct = Math.max(Number(position.peakPnlPct || 0), pnl);
  position.maxFavorableExcursionPct = Math.max(Number(position.maxFavorableExcursionPct || 0), pnl);
  const peak = position.peakPnlPct;
  const giveback = Math.max(0, peak - pnl);

  if (!position.targetReached && position.profitTargetPct > 0 && peak >= position.profitTargetPct) {
    position.targetReached = true; position.targetReachedAt = nowIso();
    log("INFO", "FVVO_MANUAL_TARGET_REACHED", { targetPct: position.profitTargetPct, peakPnlPct: round(peak, 4), noForcedExit: true });
  }

  // Active emergency stop is final structure stop during defensive phase and the v2o Cross
  // hard stop after confirmed recovery. It is the only hard stop source for every feed.
  const emergencyStop = activeEmergencyStopPrice(position);
  if (markPrice <= emergencyStop) {
    await persistState(`emergency_stop_${feature.kind}`);
    const reason = position.phase === "RECOVERY_ARMED" ? "FVVO_CROSS_POST_ARM_UNIFIED_HARD_STOP" : "FVVO_MANUAL_FINAL_SUPPORT_HARD_STOP";
    await requestFullExit(reason, markPrice, feature.kind);
    return;
  }

  // Do not dispatch normal soft exits during the very short external-entry acknowledgement grace.
  // Emergency stop remains active above. This avoids a close signal racing an unconfirmed entry.
  if (entryGraceActive(position)) { await persistState(`entry_grace_${feature.kind}`); return; }

  if (position.phase !== "RECOVERY_ARMED") {
    const first = firstStopBreakConfirmed(position, feature, markPrice);
    if (first.confirmed) {
      await persistState(`first_support_break_${feature.kind}`);
      await requestPartialExit(`FVVO_MANUAL_FIRST_SUPPORT_BREAK_${first.reason}`, markPrice, feature.kind);
      return;
    }
    if (recoveryCanArm(position, feature, pnl)) {
      position.phase = "RECOVERY_ARMED"; position.recoveryArmed = true; position.recoveryArmedAt = nowIso(); position.recoveryArmedAtMs = nowMs();
      // Clear any transient first-level breach memory once the recovery is structurally confirmed.
      position.firstStop = { breachAtMs: 0, observations: 0, lastBreachPrice: null };
      await persistState(`recovery_armed_${feature.kind}`);
      log("INFO", "FVVO_MANUAL_RECOVERY_ARMED", { pnlPct: round(pnl, 4), peakPnlPct: round(peak, 4), entryPrice: entry, activeCrossHardStopPrice: activeEmergencyStopPrice(position), ema8: feature.ema8, fvvo: feature.fvvo, slope: feature.slope });
      return;
    }
    await persistState(`defensive_hold_${feature.kind}`);
    return;
  }

  // Post-arm: v2o Cross-style fee-aware protection and hold logic.
  const floorMet = pnl >= CFG.FVVO_CROSS_MIN_EXIT_GROSS_PCT;
  const isFiveMinute = feature.kind === CFG.FVVO_FEATURE_5M_EVENT;
  const isFastTick = feature.kind === CFG.FVVO_FAST_TICK_EVENT;
  const rayHold = rayBullHoldActive(position, feature);
  const squeezeHold = squeezeHoldActive(position, feature, pnl);
  const dynamicLimit = dynamicGivebackLimit(peak, Boolean(position.targetReached));

  if (floorMet && CFG.FVVO_CROSS_DYNAMIC_TRAIL_ENABLED && peak >= CFG.FVVO_CROSS_DYNAMIC_TRAIL_ARM_PCT && giveback >= dynamicLimit && !squeezeHold) {
    await persistState(`cross_dynamic_trail_${feature.kind}`);
    await requestFullExit(position.targetReached ? "FVVO_CROSS_TARGET_TIGHT_DYNAMIC_TRAIL" : "FVVO_CROSS_DYNAMIC_TRAIL_FEE_AWARE", markPrice, feature.kind);
    return;
  }

  if (floorMet && CFG.FVVO_CROSS_FEATURE_FEE_TRAIL_ENABLED && peak >= CFG.FVVO_CROSS_FEATURE_FEE_TRAIL_ARM_PCT && giveback >= CFG.FVVO_CROSS_FEATURE_FEE_TRAIL_MIN_GIVEBACK_PCT && !squeezeHold) {
    await persistState(`cross_fee_trail_${feature.kind}`);
    await requestFullExit("FVVO_CROSS_FEATURE_FEE_TRAIL", markPrice, feature.kind);
    return;
  }

  const soft = featureSoftSignal(feature, isFiveMinute);
  const softAllowed = !isFastTick || CFG.FVVO_CROSS_EXIT_ON_FAST_TICK_BACKUP;
  const fiveMinuteAllowed = !isFiveMinute || CFG.FVVO_CROSS_EXIT_ON_5M_BACKUP;
  if (floorMet && softAllowed && fiveMinuteAllowed && soft.triggered && !rayHold) {
    await persistState(`cross_soft_exit_${feature.kind}`);
    await requestFullExit(soft.reason, markPrice, feature.kind);
    return;
  }

  await persistState(`post_arm_mark_${feature.kind}`);
  if (soft.triggered && (!floorMet || rayHold) && nowMs() - lastExitDecisionLogAt > 60000) {
    lastExitDecisionLogAt = nowMs();
    log("INFO", "FVVO_POST_ARM_EXIT_HOLD", { feed: feature.kind, pnlPct: round(pnl, 4), requiredGrossPct: CFG.FVVO_CROSS_MIN_EXIT_GROSS_PCT, softReason: soft.reason, rayBullHold: rayHold, squeezeHold, activeEmergencyStopPrice: emergencyStop });
  }
}

async function manualHandoff() {
  if (!state.position && !state.externalDealLock.active) return { status: 409, body: { ok: false, error: "NO_POSITION_OR_LOCK_TO_HANDOFF" } };
  state.manual.handoffActive = true; state.manual.recoveryRequired = true; state.manual.recoveryReason = "MANUAL_HANDOFF_ACTIVE"; state.manual.lastAction = "handoff_manual"; state.manual.lastActionAt = nowIso();
  await persistState("manual_handoff");
  log("WARN", "FVVO_MANUAL_HANDOFF_ACTIVE", { newEntriesBlocked: true, brainExitManagementStopped: true });
  return { status: 200, body: { ok: true, handoffActive: true, brainExitManagementStopped: true, newEntriesBlocked: true } };
}

async function manualClearHandoff(body) {
  if (!state.manual.handoffActive) return { status: 409, body: { ok: false, error: "CLEAR_HANDOFF_REQUIRES_MANUAL_HANDOFF_ACTIVE" } };
  if (CFG.MANUAL_CLEAR_REQUIRES_CONFIRM_FLAT && body.confirm_flat !== true) return { status: 400, body: { ok: false, error: "CONFIRM_FLAT_TRUE_REQUIRED_AFTER_MANUALLY_CLOSING_THE_EXTERNAL_DEAL" } };
  state.position = null; state.externalDealLock = { active: false, source: "", setAt: "", reason: "" };
  state.manual = { ...state.manual, handoffActive: false, recoveryRequired: false, recoveryReason: "", lastAction: "clear_handoff", lastActionAt: nowIso() };
  await persistState("manual_clear_handoff_confirmed_flat");
  return { status: 200, body: { ok: true, cleared: true, confirmedFlat: true, handoffCleared: true } };
}

async function manualConfirmExitClosed(body) {
  if (!state.position || !String(state.position.lifecycle || "").startsWith("EXIT_")) return { status: 409, body: { ok: false, error: "NO_EXIT_RECONCILIATION_PENDING" } };
  if (CFG.MANUAL_CLEAR_REQUIRES_CONFIRM_FLAT && body.confirm_flat !== true) return { status: 400, body: { ok: false, error: "CONFIRM_FLAT_TRUE_REQUIRED_AFTER_VERIFYING_3COMMAS_DEAL_IS_CLOSED" } };
  state.position = null; state.externalDealLock = { active: false, source: "", setAt: "", reason: "" };
  state.manual = { ...state.manual, handoffActive: false, recoveryRequired: false, recoveryReason: "", lastAction: "confirm_exit_closed", lastActionAt: nowIso() };
  await persistState("manual_confirm_exit_closed");
  log("INFO", "FVVO_EXIT_RECONCILIATION_CONFIRMED", { confirmedFlat: true, newEntriesAllowedSubjectToFreshFeature: true });
  return { status: 200, body: { ok: true, exitReconciled: true, confirmedFlat: true } };
}

async function manualAdopt(body) {
  if (!CFG.MANUAL_ALLOW_ADOPT) return { status: 403, body: { ok: false, error: "ADOPT_LONG_DISABLED" } };
  if (!allowedProfile(body.profile)) return { status: 400, body: { ok: false, error: "ONLY_MANUAL_WASHOUT_TWO_LEVEL_RECOVERY_PROFILE_ALLOWED" } };
  if (CFG.MANUAL_ADOPT_REQUIRE_RECOVERY_LOCK && !state.manual.recoveryRequired) return { status: 409, body: { ok: false, error: "ADOPT_ALLOWED_ONLY_DURING_RECOVERY_LOCK" } };
  if (!state.externalDealLock.active) return { status: 409, body: { ok: false, error: "ADOPT_REQUIRES_EXISTING_DEDICATED_BOT_LOCK" } };
  if (body.confirm_same_dedicated_bot !== true) return { status: 400, body: { ok: false, error: "CONFIRM_SAME_DEDICATED_BOT_REQUIRED" } };
  if (body.bot_uuid && !safeTimingEqual(String(body.bot_uuid), getBotUuid())) return { status: 403, body: { ok: false, error: "BOT_UUID_DOES_NOT_MATCH_DEDICATED_BOT" } };
  const entryPrice = firstFinite(body.entry_price, body.entryPrice);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return { status: 400, body: { ok: false, error: "ADOPT_REQUIRES_EXPLICIT_ACTUAL_3COMMAS_ENTRY_PRICE" } };
  const ladder = validateLadder(body, true);
  if (!ladder.ok) return { status: 400, body: { ok: false, error: ladder.error } };
  state.position = buildPosition(entryPrice, "RECOVERY_ADOPT_SAME_DEDICATED_BOT", "ADOPTED_UNVERIFIED_EXISTING_DEAL", ladder);
  state.externalDealLock = { active: true, source: "adopt_long", setAt: nowIso(), reason: "ADOPTED_DEDICATED_BOT_RECOVERY" };
  state.manual.recoveryRequired = false; state.manual.recoveryReason = ""; state.manual.lastAction = "adopt_long"; state.manual.lastActionAt = nowIso();
  await persistState("adopt_long_recovery");
  log("WARN", "FVVO_POSITION_ADOPTED_RECOVERY_ONLY", { entryPrice, profile: PROFILE, firstStopPct: ladder.firstStopPct, finalStopPct: ladder.finalStopPct });
  return { status: 200, body: { ok: true, adopted: true, recoveryOnly: true, position: publicPosition(state.position) } };
}

app.get("/", (_req, res) => res.status(200).json({ ok: true, brain: CFG.BRAIN_NAME, demoOnly: true, automaticEntriesEnabled: false, allowedProfile: PROFILE }));
app.get("/health", (_req, res) => { const problems = configProblems(); res.status(problems.length ? 503 : 200).json({ ok: problems.length === 0, brain: CFG.BRAIN_NAME, problems, persistenceReady }); });

app.post(CFG.MANUAL_WEBHOOK_PATH, async (req, res) => {
  try {
    if (!CFG.MANUAL_CONTROL_ENABLED) return res.status(404).json({ ok: false, error: "MANUAL_CONTROL_DISABLED" });
    if (!authenticate(CFG.MANUAL_WEBHOOK_SECRET, req.body?.secret)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    const body = req.body || {}; const action = String(body.action || "").trim().toLowerCase();
    if (cleanSymbol(body.symbol || CFG.SYMBOL) !== CFG.SYMBOL) return res.status(400).json({ ok: false, error: "SOLUSDT_ONLY" });
    log("INFO", "FVVO_MANUAL_COMMAND", { action, symbol: CFG.SYMBOL });
    if (action === "status") { if (!CFG.MANUAL_ALLOW_STATUS) return res.status(403).json({ ok: false, error: "MANUAL_STATUS_DISABLED" }); return res.status(200).json(statusPayload()); }
    if (action === "enter_long") { const outcome = await beginManualEnter(body); return res.status(outcome.status).json(outcome.body); }
    if (action === "exit_long") {
      if (!CFG.MANUAL_ALLOW_EXIT) return res.status(403).json({ ok: false, error: "MANUAL_EXIT_DISABLED" });
      const price = state.lastFeature?.price || state.position?.latestPrice || state.position?.entryPriceReference;
      if (!Number.isFinite(price)) return res.status(409).json({ ok: false, error: "NO_REFERENCE_PRICE_FOR_EXIT" });
      const outcome = await requestFullExit("MANUAL_EXIT_LONG", price, "manual");
      return res.status(outcome.ok ? 200 : 409).json({ ok: outcome.ok, ...outcome, status: statusPayload() });
    }
    if (action === "handoff_manual") { if (!CFG.MANUAL_ALLOW_HANDOFF) return res.status(403).json({ ok: false, error: "MANUAL_HANDOFF_DISABLED" }); const outcome = await manualHandoff(); return res.status(outcome.status).json(outcome.body); }
    if (action === "clear_handoff") { if (!CFG.MANUAL_ALLOW_CLEAR_HANDOFF) return res.status(403).json({ ok: false, error: "MANUAL_CLEAR_HANDOFF_DISABLED" }); const outcome = await manualClearHandoff(body); return res.status(outcome.status).json(outcome.body); }
    if (action === "confirm_exit_closed") { if (!CFG.MANUAL_ALLOW_CONFIRM_EXIT) return res.status(403).json({ ok: false, error: "MANUAL_CONFIRM_EXIT_DISABLED" }); const outcome = await manualConfirmExitClosed(body); return res.status(outcome.status).json(outcome.body); }
    if (action === "adopt_long") { const outcome = await manualAdopt(body); return res.status(outcome.status).json(outcome.body); }
    return res.status(400).json({ ok: false, error: "UNKNOWN_MANUAL_ACTION" });
  } catch (error) { log("ERROR", "FVVO_MANUAL_HANDLER_ERROR", { error: error.message }); return res.status(500).json({ ok: false, error: "MANUAL_HANDLER_ERROR" }); }
});

app.post(CFG.WEBHOOK_PATH, async (req, res) => {
  try {
    if (!authenticate(CFG.WEBHOOK_SECRET, req.body?.secret)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    const rawEvent = String(req.body?.event || req.body?.type || req.body?.src || "").trim();
    if (![CFG.FVVO_FEATURE_TICK_EVENT, CFG.FVVO_FEATURE_5M_EVENT, CFG.FVVO_FAST_TICK_EVENT].includes(rawEvent)) return res.status(202).json({ ok: true, ignored: true, reason: "UNSUPPORTED_EVENT" });
    const feature = normalizeFeature(req.body || {}, rawEvent);
    if (feature.symbol !== CFG.SYMBOL) return res.status(400).json({ ok: false, error: "SOLUSDT_ONLY" });
    if (!Number.isFinite(feature.price) || feature.price <= 0) return res.status(400).json({ ok: false, error: "VALID_PRICE_REQUIRED" });
    updateLatestFeature(feature);
    log("INFO", "FVVO_FEATURE_RECEIVED", { event: feature.kind, price: feature.price, ema8: feature.ema8, ema18: feature.ema18, fvvo: feature.fvvo, slope: feature.slope, crossDown: feature.crossDown, redPulse: feature.redPulse, rayRegime: feature.rayRegime, managedPosition: Boolean(state.position) });
    await manageExit(feature);
    return res.status(200).json({ ok: true, event: feature.kind, position: publicPosition(state.position) });
  } catch (error) { log("ERROR", "FVVO_WEBHOOK_HANDLER_ERROR", { error: error.message }); return res.status(500).json({ ok: false, error: "WEBHOOK_HANDLER_ERROR" }); }
});

async function start() {
  await ensurePersistence();
  await loadState();
  const problems = configProblems();
  log("INFO", "FVVO_MANUAL_WASHOUT_STARTUP", { port: CFG.PORT, webhookPath: CFG.WEBHOOK_PATH, manualPath: CFG.MANUAL_WEBHOOK_PATH, symbol: CFG.SYMBOL, demoOnly: true, automaticEntriesEnabled: false, allowedProfile: PROFILE, defaultFirstStopPct: CFG.MANUAL_WASHOUT_DEFAULT_FIRST_STOP_PCT, defaultFinalStopPct: CFG.MANUAL_WASHOUT_DEFAULT_FINAL_STOP_PCT, recoveryArmMfePct: CFG.MANUAL_WASHOUT_RECOVERY_ARM_MFE_PCT, postArmCrossHardStopPct: CFG.FVVO_CROSS_HARD_STOP_PCT, minFeeAwareExitGrossPct: CFG.FVVO_CROSS_MIN_EXIT_GROSS_PCT, persistenceReady, configurationProblems: problems });
  app.listen(CFG.PORT, () => log("INFO", "FVVO_LISTENING", { port: CFG.PORT }));
}

process.on("unhandledRejection", (reason) => log("ERROR", "UNHANDLED_REJECTION", { reason: String(reason) }));
process.on("uncaughtException", (error) => log("ERROR", "UNCAUGHT_EXCEPTION", { error: error.message }));
start().catch((error) => { log("ERROR", "STARTUP_FAILED", { error: error.message }); process.exit(1); });
