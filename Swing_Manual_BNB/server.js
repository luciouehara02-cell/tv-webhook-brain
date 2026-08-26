"use strict";

// ============================================================
// BrainFVVO_Swing_MultiAsset_v1h_REENTRY_ALIGNMENT_INTELLIGENT_TP_LIVE_PAPER_SINGLE_SERVER_MULTI_SYMBOL
// Supervisor + BrainFVVO Swing v1h engine in ONE server.js with C3 dynamic-instrument hotfix.
//
// Main thread:
//   - exposes one external /webhook + /manual + /health service
//   - routes each request by payload.symbol
//   - runs one isolated worker per enabled asset (default SOL, ETH, BNB)
//
// Worker thread:
//   - runs the exact replay-validated Swing v1h engine below
//   - has its own SYMBOL, bot UUID, state file, strategy env, locks and campaigns
//
// Any per-symbol env override uses the asset prefix, e.g.:
//   ETH_DYNAMIC_PROFIT_ARM_MFE_PCT=0.70
// becomes DYNAMIC_PROFIT_ARM_MFE_PCT=0.70 inside only the ETH worker.
// ============================================================

const { Worker, isMainThread, workerData } = require("worker_threads");
const FVVO_ENGINE_WORKER = !isMainThread && Boolean(workerData?.fvvoEngineWorker);

if (FVVO_ENGINE_WORKER) {
// ===== BEGIN SWING V1H ENGINE + C3 DYNAMIC-INSTRUMENT HOTFIX =====
// ============================================================
// BrainFVVO_Swing_v1h_5M_BEAR_VETO_FAST_RELEASE_CAMPAIGN
// SOLUSDT dedicated Signal Bot manual-entry / brain-exit service — DEMO/LIVE selected only by EXECUTION_MODE
// ------------------------------------------------------------
// Swing v1h DEMO: preserves v1g exits, campaign arbitration, dynamic reclaim, breakout retest, and shallow-hold breakout logic.
// Adds a Preferred/Deep-only strong-bear 5m context veto with a fast 15s structural release.
// The guard never cancels a setup solely for bearish context; it preserves the trigger and lets the existing stop/chase/expiry rules remain authoritative.
//   - v1m prevents split exit ownership: no native 3Commas entry stop is allowed.
//   - The brain is the single stop / target / profit-exit owner and sends one full exit_long.
//   - Manual and price-trigger entries reject stops closer than the configured minimum distance.
//   - Primary entries can be immediate manual or a user-armed absolute price trigger.
//   - The price trigger is cross-activated from a fresh 15s feature and then sends a bot-fixed market entry.
//   - Strong winning runners can suppress premature 15s thesis exits after a configured MFE and use a tight full-position runner trail.
//   - Automatic re-entry remains enabled when the environment variables select `REENTRY_PHASE="auto"`.
//   - A healthy pullback observed during the 90-second assumed-flat release may be carried into the post-release reclaim state.
//   - Yellow chart signals are accepted as optional telemetry and remain shadow-only until the publisher stream proves replay coverage.
//   - One absolute `stop_price`: a confirmed breach sends exit_long 100%.
//   - Optional absolute `profit_target_price`: fixed ceiling, full 100% exit.
//   - When peak gross PnL reaches the configured arm level (default +0.45%),
//     a monotonic dynamic protected-profit floor is armed.
//   - Dynamic floor breach, 15s thesis failure, or 5m thesis failure each
//     send the SAME full 100% exit_long payload. No partial exits exist.
//   - Entry order sizing is BOT-OWNED: the brain emits no entry `order` object.
//   - 3Commas Signal Bot owns the fixed entry size and Market entry type.
//   - HTTP 200 from 3Commas is acceptance only. In either configured environment, a brain-requested full exit
//     uses the configured 90-second assumed-flat auto-release contract. A force-clear remains recovery-only.
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
  BRAIN_NAME: envStr("BRAIN_NAME", "BrainFVVO_Swing_MultiAsset_v1k_PROFITABLE_EMERGENCY_RECOVERY_LIVE_PAPER"),
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
  // v1o: deploy exactly the same code to DEMO or LIVE. The sole environment selector is this variable.
  // Valid values: demo | live. The legacy DEMO_FORWARD_ALLOWED/LIVE_FORWARD_ALLOWED flags are ignored by v1o.
  EXECUTION_MODE: envStr("EXECUTION_MODE", "live").toLowerCase(),
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
  // v1m: external native stops are prohibited. A native stop can close a 3Commas
  // deal between feature observations and leave the brain with an unprovable stale lock.
  // Keep this false; configProblems blocks new entries when it is true.
  C3_NATIVE_STOP_ENABLED: envBool("C3_NATIVE_STOP_ENABLED", false),
  C3_TRIGGER_PRICE_DECIMALS: Math.max(0, Math.floor(envNum("C3_TRIGGER_PRICE_DECIMALS", 8))),
  C3_MAX_LAG_SEC: envNum("C3_MAX_LAG_SEC", 300),
  C3_REQUEST_TIMEOUT_MS: envNum("C3_REQUEST_TIMEOUT_MS", 10000),
  C3_FORWARD_DEDUP_MS: envNum("C3_FORWARD_DEDUP_MS", 60000),
  C3_PAYLOAD_AUDIT_ENABLED: envBool("C3_PAYLOAD_AUDIT_ENABLED", true),
  // v1c audit-only PnL estimate. It never changes entry, stop, or exit decisions.
  PNL_ESTIMATED_ROUND_TRIP_COST_PCT: envNum("PNL_ESTIMATED_ROUND_TRIP_COST_PCT", 0.20),
  // Retired direct-clear compatibility flag. v1l requires the delayed auto-release contract instead.
  C3_ASSUME_EXIT_ACCEPTANCE: envBool("C3_ASSUME_EXIT_ACCEPTANCE", false),
  // After a 100% exit_long is accepted by 3Commas, retain the lock for this grace
  // period and then release the brain state as ASSUMED flat. This is intentionally identical for demo/live mode.
  AUTO_EXIT_RECONCILIATION_ENABLED: envBool("AUTO_EXIT_RECONCILIATION_ENABLED", false),
  AUTO_EXIT_RECONCILIATION_DELAY_SEC: envNum("AUTO_EXIT_RECONCILIATION_DELAY_SEC", 90),

  STATE_DIR: envStr("STATE_DIR", "/data"),
  STATE_FILE_NAME: envStr("STATE_FILE_NAME", "brainfvvo-swing-v1h-live-paper-state.json"),
  STATE_PERSISTENCE_REQUIRED: envBool("STATE_PERSISTENCE_REQUIRED", true),

  // Copy/paste-safe Unicode event category markers replace ANSI terminal colour.
  FVVO_LOG_UNICODE_MARKERS_ENABLED: envBool("FVVO_LOG_UNICODE_MARKERS_ENABLED", true),
  FVVO_FEATURE_TICK_EVENT: envStr("FVVO_FEATURE_TICK_EVENT", "FEATURE_TICK_FVVO"),
  FVVO_FEATURE_5M_EVENT: envStr("FVVO_FEATURE_5M_EVENT", "FEATURE_5M_FVVO"),
  FVVO_FAST_TICK_EVENT: envStr("FVVO_FAST_TICK_EVENT", "FAST_TICK_FVVO"),
  MANUAL_REQUIRE_FRESH_FEATURE_TICK: envBool("MANUAL_REQUIRE_FRESH_FEATURE_TICK", true),
  FVVO_STALE_FEATURE_TICK_MAX_AGE_SEC: envNum("FVVO_STALE_FEATURE_TICK_MAX_AGE_SEC", 60),
  FEATURE_MONOTONIC_GUARD_ENABLED: envBool("FEATURE_MONOTONIC_GUARD_ENABLED", true),
  FEATURE_DUPLICATE_BAR_GUARD_ENABLED: envBool("FEATURE_DUPLICATE_BAR_GUARD_ENABLED", true),

  MANUAL_ENTRY_DEFAULT_PROFILE: envStr("MANUAL_ENTRY_DEFAULT_PROFILE", "SWING_BALANCED_STRUCTURE_EXIT"),
  MANUAL_ALLOW_ENTER: envBool("MANUAL_ALLOW_ENTER", true),
  MANUAL_ALLOW_EXIT: envBool("MANUAL_ALLOW_EXIT", true),
  MANUAL_ALLOW_STATUS: envBool("MANUAL_ALLOW_STATUS", true),
  MANUAL_ALLOW_HANDOFF: envBool("MANUAL_ALLOW_HANDOFF", true),
  MANUAL_ALLOW_CLEAR_HANDOFF: envBool("MANUAL_ALLOW_CLEAR_HANDOFF", true),
  MANUAL_ALLOW_CONFIRM_EXIT: envBool("MANUAL_ALLOW_CONFIRM_EXIT", true),
  // Optional audit-only confirmation of the actual 3Commas fill. The signal reference remains
  // the risk-management basis; this value improves gross/net PnL reporting only.
  MANUAL_ALLOW_CONFIRM_ENTRY_FILL: envBool("MANUAL_ALLOW_CONFIRM_ENTRY_FILL", true),
  MANUAL_ENTRY_FILL_MAX_DEVIATION_PCT: envNum("MANUAL_ENTRY_FILL_MAX_DEVIATION_PCT", 1.0),
  MANUAL_ALLOW_FORCE_CLEAR_VERIFIED_FLAT: envBool("MANUAL_ALLOW_FORCE_CLEAR_VERIFIED_FLAT", true),
  MANUAL_FORCE_CLEAR_CONFIRM_PHRASE: envStr("MANUAL_FORCE_CLEAR_CONFIRM_PHRASE", "I_VERIFIED_DEDICATED_3COMMAS_BOT_IS_FLAT"),
  MANUAL_CLEAR_REQUIRES_CONFIRM_FLAT: envBool("MANUAL_CLEAR_REQUIRES_CONFIRM_FLAT", true),

  // v1u: direct manual entries remain immediate unless a configurable overheat warning is
  // triggered. A warning creates a short-lived server-side confirmation challenge; no order is
  // sent until the operator explicitly replies yes. `no` clears it without changing any trade state.
  MANUAL_ENTRY_OVERHEAT_CONFIRMATION_ENABLED: envBool("MANUAL_ENTRY_OVERHEAT_CONFIRMATION_ENABLED", true),
  MANUAL_ALLOW_CONFIRM_ENTRY: envBool("MANUAL_ALLOW_CONFIRM_ENTRY", true),
  MANUAL_ENTRY_OVERHEAT_CONFIRM_EXPIRY_SEC: envNum("MANUAL_ENTRY_OVERHEAT_CONFIRM_EXPIRY_SEC", 120),
  MANUAL_ENTRY_OVERHEAT_CONFIRM_MAX_PRICE_DEVIATION_PCT: envNum("MANUAL_ENTRY_OVERHEAT_CONFIRM_MAX_PRICE_DEVIATION_PCT", 0.35),
  MANUAL_ENTRY_OVERHEAT_MIN_RSI: envNum("MANUAL_ENTRY_OVERHEAT_MIN_RSI", 72),
  MANUAL_ENTRY_OVERHEAT_MIN_ADX: envNum("MANUAL_ENTRY_OVERHEAT_MIN_ADX", 40),
  MANUAL_ENTRY_OVERHEAT_MIN_FVVO: envNum("MANUAL_ENTRY_OVERHEAT_MIN_FVVO", 3.0),
  MANUAL_ENTRY_OVERHEAT_MAX_ABOVE_EMA8_PCT: envNum("MANUAL_ENTRY_OVERHEAT_MAX_ABOVE_EMA8_PCT", 0.45),
  MANUAL_ENTRY_OVERHEAT_MAX_ABOVE_EMA18_PCT: envNum("MANUAL_ENTRY_OVERHEAT_MAX_ABOVE_EMA18_PCT", 0.75),
  MANUAL_ENTRY_OVERHEAT_MIN_SIGNALS: Math.floor(envNum("MANUAL_ENTRY_OVERHEAT_MIN_SIGNALS", 2)),

  // v1l user-armed absolute price trigger. This is a brain-side conditional entry,
  // not an exchange-native resting limit order. It sends a bot-fixed MARKET entry only
  // after a fresh price crosses the armed level from the correct side.
  // v1w adds `trailing_dip_reclaim`: after activation_price crosses down, the brain tracks the
  // lowest observed 15-second feature price and buys only after a calculated rebound.
  // v1z adds `trailing_dip_reclaim_zone`: the operator supplies activation_range_low/high so
  // a planned flush zone can activate without depending on a single exact tick. The entry
  // still requires a reclaim from the observed low and rejects excess chase or stop proximity.
  PRICE_ENTRY_ENABLED: envBool("PRICE_ENTRY_ENABLED", true),
  MANUAL_ALLOW_ARM_PRICE_ENTRY: envBool("MANUAL_ALLOW_ARM_PRICE_ENTRY", true),
  MANUAL_ALLOW_CANCEL_PRICE_ENTRY: envBool("MANUAL_ALLOW_CANCEL_PRICE_ENTRY", true),
  PRICE_ENTRY_DEFAULT_EXPIRY_SEC: envNum("PRICE_ENTRY_DEFAULT_EXPIRY_SEC", 43200),
  PRICE_ENTRY_MIN_EXPIRY_SEC: envNum("PRICE_ENTRY_MIN_EXPIRY_SEC", 60),
  PRICE_ENTRY_MAX_EXPIRY_SEC: envNum("PRICE_ENTRY_MAX_EXPIRY_SEC", 86400),
  PRICE_ENTRY_MIN_TRIGGER_DISTANCE_PCT: envNum("PRICE_ENTRY_MIN_TRIGGER_DISTANCE_PCT", 0.05),
  PRICE_ENTRY_MAX_TRIGGER_DISTANCE_PCT: envNum("PRICE_ENTRY_MAX_TRIGGER_DISTANCE_PCT", 5.0),
  PRICE_ENTRY_REQUIRE_ACTUAL_CROSS: envBool("PRICE_ENTRY_REQUIRE_ACTUAL_CROSS", true),
  PRICE_ENTRY_TRIGGER_ON_FAST_TICK: envBool("PRICE_ENTRY_TRIGGER_ON_FAST_TICK", false),
  // v1aa: allow one dip-side pending trigger and one breakout pending trigger at the same time.
  PRICE_ENTRY_MAX_PENDING: Math.max(1, Math.min(3, Math.floor(envNum("PRICE_ENTRY_MAX_PENDING", 3)))),
  // v1e: warn before a user-supplied hard expiry. The real trigger is never extended silently.
  PRICE_TRIGGER_EXPIRY_WARNING_SEC: Math.max(0, envNum("PRICE_TRIGGER_EXPIRY_WARNING_SEC", 900)),
  BREAKOUT_RETEST_POST_EXPIRY_SHADOW_ENABLED: envBool("BREAKOUT_RETEST_POST_EXPIRY_SHADOW_ENABLED", true),
  BREAKOUT_RETEST_POST_EXPIRY_SHADOW_SEC: Math.max(60, envNum("BREAKOUT_RETEST_POST_EXPIRY_SHADOW_SEC", 7200)),
  BREAKOUT_RETEST_POST_EXPIRY_SHADOW_PERFORMANCE_SEC: Math.max(60, envNum("BREAKOUT_RETEST_POST_EXPIRY_SHADOW_PERFORMANCE_SEC", 3600)),

  // v1w user-armed one-input trailing dip reclaim. The operator supplies only activation_price
  // and stop_price. Once activation is crossed down, the brain records the lowest observed feature
  // price and enters on a percentage rebound. `shadow` never forwards; `live` forwards one market entry.
  TRAILING_DIP_RECLAIM_MODE: envStr("TRAILING_DIP_RECLAIM_MODE", "shadow").toLowerCase(),
  TRAILING_DIP_RECLAIM_MIN_DROP_PCT: envNum("TRAILING_DIP_RECLAIM_MIN_DROP_PCT", 0.10),
  TRAILING_DIP_RECLAIM_RECLAIM_PCT: envNum("TRAILING_DIP_RECLAIM_RECLAIM_PCT", 0.05),
  TRAILING_DIP_RECLAIM_MAX_CHASE_PCT: envNum("TRAILING_DIP_RECLAIM_MAX_CHASE_PCT", 0.12),
  TRAILING_DIP_RECLAIM_MAX_TRACK_SEC: envNum("TRAILING_DIP_RECLAIM_MAX_TRACK_SEC", 600),
  TRAILING_DIP_RECLAIM_MIN_LOW_ABOVE_STOP_PCT: envNum("TRAILING_DIP_RECLAIM_MIN_LOW_ABOVE_STOP_PCT", 0.10),
  TRAILING_DIP_RECLAIM_REQUIRE_TICK_RECOVERY: envBool("TRAILING_DIP_RECLAIM_REQUIRE_TICK_RECOVERY", false),
  TRAILING_DIP_RECLAIM_MIN_TICK_SLOPE: envNum("TRAILING_DIP_RECLAIM_MIN_TICK_SLOPE", 0),
  TRAILING_DIP_RECLAIM_REQUIRE_RAY_NOT_BEAR: envBool("TRAILING_DIP_RECLAIM_REQUIRE_RAY_NOT_BEAR", false),

  // v1z range-based flush-reclaim. Activates when price crosses into activation_range_low/high
  // from above, then enters on low-based reclaim while capped by the top-of-zone chase limit.
  TRAILING_DIP_RECLAIM_ZONE_MODE: envStr("TRAILING_DIP_RECLAIM_ZONE_MODE", "live").toLowerCase(),
  TRAILING_DIP_RECLAIM_ZONE_RECLAIM_PCT: envNum("TRAILING_DIP_RECLAIM_ZONE_RECLAIM_PCT", 0.09),
  TRAILING_DIP_RECLAIM_ZONE_MAX_ENTRY_ABOVE_HIGH_PCT: envNum("TRAILING_DIP_RECLAIM_ZONE_MAX_ENTRY_ABOVE_HIGH_PCT", 0.07),
  TRAILING_DIP_RECLAIM_ZONE_MIN_PENETRATION_PCT: envNum("TRAILING_DIP_RECLAIM_ZONE_MIN_PENETRATION_PCT", 0.08),
  TRAILING_DIP_RECLAIM_ZONE_MAX_TRACK_SEC: envNum("TRAILING_DIP_RECLAIM_ZONE_MAX_TRACK_SEC", 600),
  TRAILING_DIP_RECLAIM_ZONE_MIN_LOW_ABOVE_STOP_PCT: envNum("TRAILING_DIP_RECLAIM_ZONE_MIN_LOW_ABOVE_STOP_PCT", envNum("TRAILING_DIP_RECLAIM_MIN_LOW_ABOVE_STOP_PCT", 0.10)),
  TRAILING_DIP_RECLAIM_ZONE_REQUIRE_TICK_RECOVERY: envBool("TRAILING_DIP_RECLAIM_ZONE_REQUIRE_TICK_RECOVERY", true),
  TRAILING_DIP_RECLAIM_ZONE_MIN_TICK_SLOPE: envNum("TRAILING_DIP_RECLAIM_ZONE_MIN_TICK_SLOPE", 0),
  TRAILING_DIP_RECLAIM_ZONE_REQUIRE_RAY_NOT_BEAR: envBool("TRAILING_DIP_RECLAIM_ZONE_REQUIRE_RAY_NOT_BEAR", true),

  // v1d role-specific confirmed pullback. Preferred/Deep must first touch their support zone,
  // then receive an aligned confirmed 15m close above breakout_confirm_price, retest/hold that
  // recovery level, and finally pass two fast recovery observations before a paper order is sent.
  CONFIRMED_PULLBACK_RECLAIM_ZONE_MODE: envStr("CONFIRMED_PULLBACK_RECLAIM_ZONE_MODE", "live").toLowerCase(),
  CONFIRMED_PULLBACK_MIN_PENETRATION_PCT: envNum("CONFIRMED_PULLBACK_MIN_PENETRATION_PCT", 0.05),
  CONFIRMED_PULLBACK_MAX_TRACK_SEC: envNum("CONFIRMED_PULLBACK_MAX_TRACK_SEC", 21600),
  CONFIRMED_PULLBACK_MIN_LOW_ABOVE_STOP_PCT: envNum("CONFIRMED_PULLBACK_MIN_LOW_ABOVE_STOP_PCT", 0.10),
  CONFIRMED_PULLBACK_15M_ALIGNMENT_MINUTE: Math.max(0, Math.min(14, Math.floor(envNum("CONFIRMED_PULLBACK_15M_ALIGNMENT_MINUTE", 0)))),
  CONFIRMED_PULLBACK_15M_CONFIRM_BUFFER_PCT: envNum("CONFIRMED_PULLBACK_15M_CONFIRM_BUFFER_PCT", 0.00),
  CONFIRMED_PULLBACK_RETEST_TOUCH_ABOVE_PCT: envNum("CONFIRMED_PULLBACK_RETEST_TOUCH_ABOVE_PCT", 0.10),
  CONFIRMED_PULLBACK_RETEST_HOLD_BELOW_PCT: envNum("CONFIRMED_PULLBACK_RETEST_HOLD_BELOW_PCT", 0.10),
  CONFIRMED_PULLBACK_MAX_ENTRY_ABOVE_CONFIRM_PCT: envNum("CONFIRMED_PULLBACK_MAX_ENTRY_ABOVE_CONFIRM_PCT", 0.12),
  CONFIRMED_PULLBACK_FAST_CONFIRM_OBSERVATIONS: Math.max(1, Math.floor(envNum("CONFIRMED_PULLBACK_FAST_CONFIRM_OBSERVATIONS", 2))),
  CONFIRMED_PULLBACK_FAST_MIN_FVVO: envNum("CONFIRMED_PULLBACK_FAST_MIN_FVVO", 0.0),
  CONFIRMED_PULLBACK_FAST_MIN_SLOPE: envNum("CONFIRMED_PULLBACK_FAST_MIN_SLOPE", 0.0),
  CONFIRMED_PULLBACK_FAST_REQUIRE_RAY_NOT_BEAR: envBool("CONFIRMED_PULLBACK_FAST_REQUIRE_RAY_NOT_BEAR", true),
  CONFIRMED_PULLBACK_DORMANT_DEEP_FALLBACK_ENABLED: envBool("CONFIRMED_PULLBACK_DORMANT_DEEP_FALLBACK_ENABLED", true),
  CONFIRMED_PULLBACK_DORMANT_DEEP_MAX_PRIOR_EXIT_PNL_PCT: envNum("CONFIRMED_PULLBACK_DORMANT_DEEP_MAX_PRIOR_EXIT_PNL_PCT", 0.0),

  // v1i: faster pullback confirmation without removing the existing confirmed
  // pullback mode. The first valid path wins: spaced fast votes, or a confirmed
  // 5m close fallback. Shadow is the default for all workers.
  HYBRID_PULLBACK_FAST_PATH_MODE: envStr("HYBRID_PULLBACK_FAST_PATH_MODE", "live").toLowerCase(),
  HYBRID_PULLBACK_MIN_PENETRATION_PCT: envNum("HYBRID_PULLBACK_MIN_PENETRATION_PCT", 0.05),
  HYBRID_PULLBACK_MIN_REBOUND_PCT: envNum("HYBRID_PULLBACK_MIN_REBOUND_PCT", 0.09),
  HYBRID_PULLBACK_MAX_ENTRY_ABOVE_CONFIRM_PCT: envNum("HYBRID_PULLBACK_MAX_ENTRY_ABOVE_CONFIRM_PCT", 0.12),
  HYBRID_PULLBACK_MIN_LOW_ABOVE_STOP_PCT: envNum("HYBRID_PULLBACK_MIN_LOW_ABOVE_STOP_PCT", 0.10),
  HYBRID_PULLBACK_MAX_TRACK_SEC: envNum("HYBRID_PULLBACK_MAX_TRACK_SEC", 21600),
  HYBRID_PULLBACK_MIN_SPACING_SEC: envNum("HYBRID_PULLBACK_MIN_SPACING_SEC", 3),
  HYBRID_PULLBACK_PREFERRED_VOTE_COUNT: Math.max(3, Math.floor(envNum("HYBRID_PULLBACK_PREFERRED_VOTE_COUNT", 5))),
  HYBRID_PULLBACK_PREFERRED_VOTES_REQUIRED: Math.max(2, Math.floor(envNum("HYBRID_PULLBACK_PREFERRED_VOTES_REQUIRED", 4))),
  HYBRID_PULLBACK_PREFERRED_FINAL_CONSECUTIVE: Math.max(1, Math.floor(envNum("HYBRID_PULLBACK_PREFERRED_FINAL_CONSECUTIVE", 2))),
  HYBRID_PULLBACK_PREFERRED_MIN_SPAN_SEC: envNum("HYBRID_PULLBACK_PREFERRED_MIN_SPAN_SEC", 12),
  HYBRID_PULLBACK_DEEP_VOTE_COUNT: Math.max(3, Math.floor(envNum("HYBRID_PULLBACK_DEEP_VOTE_COUNT", 6))),
  HYBRID_PULLBACK_DEEP_VOTES_REQUIRED: Math.max(2, Math.floor(envNum("HYBRID_PULLBACK_DEEP_VOTES_REQUIRED", 5))),
  HYBRID_PULLBACK_DEEP_FINAL_CONSECUTIVE: Math.max(1, Math.floor(envNum("HYBRID_PULLBACK_DEEP_FINAL_CONSECUTIVE", 3))),
  HYBRID_PULLBACK_DEEP_MIN_SPAN_SEC: envNum("HYBRID_PULLBACK_DEEP_MIN_SPAN_SEC", 20),
  HYBRID_PULLBACK_FAST_MIN_FVVO: envNum("HYBRID_PULLBACK_FAST_MIN_FVVO", 0),
  HYBRID_PULLBACK_FAST_STRONG_NEGATIVE_FVVO: envNum("HYBRID_PULLBACK_FAST_STRONG_NEGATIVE_FVVO", -2.0),
  HYBRID_PULLBACK_FAST_MIN_SLOPE: envNum("HYBRID_PULLBACK_FAST_MIN_SLOPE", 0),
  HYBRID_PULLBACK_FAST_REQUIRE_RAY_NOT_BEAR: envBool("HYBRID_PULLBACK_FAST_REQUIRE_RAY_NOT_BEAR", true),
  HYBRID_PULLBACK_DEEP_REQUIRE_5M_RAY_NOT_BEAR: envBool("HYBRID_PULLBACK_DEEP_REQUIRE_5M_RAY_NOT_BEAR", true),
  HYBRID_PULLBACK_FALLBACK_5M_ENABLED: envBool("HYBRID_PULLBACK_FALLBACK_5M_ENABLED", true),
  HYBRID_PULLBACK_FALLBACK_5M_CONFIRM_OBSERVATIONS: Math.max(1, Math.floor(envNum("HYBRID_PULLBACK_FALLBACK_5M_CONFIRM_OBSERVATIONS", 1))),
  HYBRID_PULLBACK_VOTE_MAX_SEC: envNum("HYBRID_PULLBACK_VOTE_MAX_SEC", 90),

  // v1h Preferred/Deep context guard. The confirmed 5m stream is used only to veto an otherwise
  // qualified 15s reclaim when the larger structure is strongly bearish. Once latched, release is
  // driven by fast 15s recovery against the latest known 5m structural reference (optimized default: EMA18) so we do not wait for another 5m bar.
  ENTRY_5M_BEAR_GUARD_MODE: envStr("ENTRY_5M_BEAR_GUARD_MODE", "live").toLowerCase(),
  ENTRY_5M_BEAR_GUARD_MAX_AGE_SEC: Math.max(60, envNum("ENTRY_5M_BEAR_GUARD_MAX_AGE_SEC", 420)),
  ENTRY_5M_BEAR_GUARD_MAX_FVVO: envNum("ENTRY_5M_BEAR_GUARD_MAX_FVVO", -1.0),
  ENTRY_5M_BEAR_GUARD_REQUIRE_RAY_BEAR: envBool("ENTRY_5M_BEAR_GUARD_REQUIRE_RAY_BEAR", true),
  ENTRY_5M_BEAR_GUARD_APPLY_PREFERRED: envBool("ENTRY_5M_BEAR_GUARD_APPLY_PREFERRED", true),
  ENTRY_5M_BEAR_GUARD_APPLY_DEEP: envBool("ENTRY_5M_BEAR_GUARD_APPLY_DEEP", true),
  ENTRY_5M_BEAR_GUARD_RELEASE_REFERENCE: envStr("ENTRY_5M_BEAR_GUARD_RELEASE_REFERENCE", "ema18").toLowerCase(),
  ENTRY_5M_BEAR_GUARD_RELEASE_STRUCTURE_TOLERANCE_PCT: Math.max(0, envNum("ENTRY_5M_BEAR_GUARD_RELEASE_STRUCTURE_TOLERANCE_PCT", envNum("ENTRY_5M_BEAR_GUARD_RELEASE_EMA8_TOLERANCE_PCT", 0.03))),
  ENTRY_5M_BEAR_GUARD_RELEASE_MIN_FVVO: envNum("ENTRY_5M_BEAR_GUARD_RELEASE_MIN_FVVO", 0.0),
  ENTRY_5M_BEAR_GUARD_RELEASE_MIN_SLOPE: envNum("ENTRY_5M_BEAR_GUARD_RELEASE_MIN_SLOPE", 0.0),
  ENTRY_5M_BEAR_GUARD_RELEASE_REQUIRE_RAY_NOT_BEAR: envBool("ENTRY_5M_BEAR_GUARD_RELEASE_REQUIRE_RAY_NOT_BEAR", true),
  ENTRY_5M_BEAR_GUARD_RELEASE_CONFIRM_OBSERVATIONS: Math.max(1, Math.floor(envNum("ENTRY_5M_BEAR_GUARD_RELEASE_CONFIRM_OBSERVATIONS", 2))),
  ENTRY_5M_BEAR_GUARD_WAIT_LOG_SEC: Math.max(15, envNum("ENTRY_5M_BEAR_GUARD_WAIT_LOG_SEC", 60)),

  // v1ac breakout retest reclaim zone. Preferred request fields:
  //   breakout_confirm_price = safe break above resistance / prior peak
  //   retest_range_low/high  = old resistance zone that should hold as support
  // Backward compatibility: activation_range_low/high still work, using range_high as the breakout confirmation.
  BREAKOUT_RETEST_RECLAIM_ZONE_MODE: envStr("BREAKOUT_RETEST_RECLAIM_ZONE_MODE", "live").toLowerCase(),
  BREAKOUT_RETEST_RECLAIM_ZONE_RECLAIM_PCT: envNum("BREAKOUT_RETEST_RECLAIM_ZONE_RECLAIM_PCT", 0.07),
  BREAKOUT_RETEST_RECLAIM_ZONE_MAX_ENTRY_ABOVE_HIGH_PCT: envNum("BREAKOUT_RETEST_RECLAIM_ZONE_MAX_ENTRY_ABOVE_HIGH_PCT", 0.12),
  BREAKOUT_RETEST_RECLAIM_ZONE_MIN_RETEST_PENETRATION_PCT: envNum("BREAKOUT_RETEST_RECLAIM_ZONE_MIN_RETEST_PENETRATION_PCT", 0.03),
  BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRM_BUFFER_PCT: envNum("BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRM_BUFFER_PCT", 0.00),
  BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRM_OBSERVATIONS: Math.max(1, Math.floor(envNum("BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRM_OBSERVATIONS", 2))),
  // v1e: first observation remains a strict breakout. Only the follow-up hold may sit slightly below the line.
  BREAKOUT_RETEST_ADAPTIVE_CONFIRM_ENABLED: envBool("BREAKOUT_RETEST_ADAPTIVE_CONFIRM_ENABLED", true),
  BREAKOUT_RETEST_ADAPTIVE_HOLD_TOLERANCE_PCT: Math.max(0, envNum("BREAKOUT_RETEST_ADAPTIVE_HOLD_TOLERANCE_PCT", 0.015)),
  BREAKOUT_RETEST_ADAPTIVE_HOLD_MAX_SEC: Math.max(1, envNum("BREAKOUT_RETEST_ADAPTIVE_HOLD_MAX_SEC", 45)),
  BREAKOUT_RETEST_ADAPTIVE_HOLD_REQUIRE_ABOVE_EMA8: envBool("BREAKOUT_RETEST_ADAPTIVE_HOLD_REQUIRE_ABOVE_EMA8", true),
  BREAKOUT_RETEST_ADAPTIVE_HOLD_REQUIRE_RAY_NOT_BEAR: envBool("BREAKOUT_RETEST_ADAPTIVE_HOLD_REQUIRE_RAY_NOT_BEAR", true),
  BREAKOUT_RETEST_RECLAIM_ZONE_FAIL_BELOW_LOW_BUFFER_PCT: envNum("BREAKOUT_RETEST_RECLAIM_ZONE_FAIL_BELOW_LOW_BUFFER_PCT", 0.03),
  BREAKOUT_RETEST_RECLAIM_ZONE_MAX_TRACK_SEC: envNum("BREAKOUT_RETEST_RECLAIM_ZONE_MAX_TRACK_SEC", 1800),
  BREAKOUT_RETEST_RECLAIM_ZONE_MIN_LOW_ABOVE_STOP_PCT: envNum("BREAKOUT_RETEST_RECLAIM_ZONE_MIN_LOW_ABOVE_STOP_PCT", 0.10),
  BREAKOUT_RETEST_RECLAIM_ZONE_REQUIRE_TICK_RECOVERY: envBool("BREAKOUT_RETEST_RECLAIM_ZONE_REQUIRE_TICK_RECOVERY", true),
  BREAKOUT_RETEST_RECLAIM_ZONE_MIN_TICK_SLOPE: envNum("BREAKOUT_RETEST_RECLAIM_ZONE_MIN_TICK_SLOPE", 0.10),
  BREAKOUT_RETEST_RECLAIM_ZONE_REQUIRE_RAY_NOT_BEAR: envBool("BREAKOUT_RETEST_RECLAIM_ZONE_REQUIRE_RAY_NOT_BEAR", true),
  BREAKOUT_RETEST_RECLAIM_ZONE_MIN_FVVO: envNum("BREAKOUT_RETEST_RECLAIM_ZONE_MIN_FVVO", -0.50),
  // v1c: an already-qualified retest is not permanently cancelled merely because
  // recovery temporarily moves above the configured entry cap. The engine waits
  // without chasing and resumes the unchanged recovery gates only after price
  // returns inside the original max-entry window. "cancel" restores v1b behavior.
  BREAKOUT_RETEST_RECLAIM_ZONE_CHASE_POLICY: envStr("BREAKOUT_RETEST_RECLAIM_ZONE_CHASE_POLICY", "wait_no_chase").toLowerCase(),

  // v1g shallow hold/reclaim path: fills the price gap above the manually supplied
  // retest zone, but keeps the original structural retest path intact.
  BREAKOUT_SHALLOW_HOLD_RECLAIM_MODE: envStr("BREAKOUT_SHALLOW_HOLD_RECLAIM_MODE", "live").toLowerCase(),
  BREAKOUT_SHALLOW_HOLD_MAX_TRACK_SEC: envNum("BREAKOUT_SHALLOW_HOLD_MAX_TRACK_SEC", 2700),
  BREAKOUT_SHALLOW_HOLD_MAX_ABOVE_CONFIRM_PCT: envNum("BREAKOUT_SHALLOW_HOLD_MAX_ABOVE_CONFIRM_PCT", 0.03),
  BREAKOUT_SHALLOW_HOLD_MIN_PULLBACK_FROM_HIGH_PCT: envNum("BREAKOUT_SHALLOW_HOLD_MIN_PULLBACK_FROM_HIGH_PCT", 0.08),
  BREAKOUT_SHALLOW_HOLD_MIN_OBSERVATIONS: Math.max(1, Math.floor(envNum("BREAKOUT_SHALLOW_HOLD_MIN_OBSERVATIONS", 2))),
  BREAKOUT_SHALLOW_HOLD_RECLAIM_PCT: envNum("BREAKOUT_SHALLOW_HOLD_RECLAIM_PCT", 0.07),
  BREAKOUT_SHALLOW_HOLD_MAX_ENTRY_ABOVE_CONFIRM_PCT: envNum("BREAKOUT_SHALLOW_HOLD_MAX_ENTRY_ABOVE_CONFIRM_PCT", 0.12),
  BREAKOUT_SHALLOW_HOLD_MIN_ADX: envNum("BREAKOUT_SHALLOW_HOLD_MIN_ADX", 35),
  BREAKOUT_SHALLOW_HOLD_MIN_FVVO: envNum("BREAKOUT_SHALLOW_HOLD_MIN_FVVO", 1.0),
  BREAKOUT_SHALLOW_HOLD_MIN_SLOPE: envNum("BREAKOUT_SHALLOW_HOLD_MIN_SLOPE", 0.10),
  BREAKOUT_SHALLOW_HOLD_REQUIRE_ABOVE_EMA8: envBool("BREAKOUT_SHALLOW_HOLD_REQUIRE_ABOVE_EMA8", true),
  BREAKOUT_SHALLOW_HOLD_REQUIRE_RAY_NOT_BEAR: envBool("BREAKOUT_SHALLOW_HOLD_REQUIRE_RAY_NOT_BEAR", true),

  // v1i wider continuation observer. It does not relax wait_no_chase or the
  // existing shallow-hold path. Generic defaults apply to SOL/ETH/BNB/XRP and
  // may be overridden per worker with SOL_/ETH_/BNB_/XRP_ prefixes.
  BREAKOUT_BULL_CONTINUATION_MODE: envStr("BREAKOUT_BULL_CONTINUATION_MODE", "live").toLowerCase(),
  BREAKOUT_BULL_CONTINUATION_MAX_TRACK_SEC: envNum("BREAKOUT_BULL_CONTINUATION_MAX_TRACK_SEC", 1200),
  BREAKOUT_BULL_CONTINUATION_MIN_PEAK_EXTENSION_PCT: envNum("BREAKOUT_BULL_CONTINUATION_MIN_PEAK_EXTENSION_PCT", 0.20),
  BREAKOUT_BULL_CONTINUATION_MAX_PEAK_EXTENSION_PCT: envNum("BREAKOUT_BULL_CONTINUATION_MAX_PEAK_EXTENSION_PCT", 1.25),
  BREAKOUT_BULL_CONTINUATION_MIN_PULLBACK_FROM_HIGH_PCT: envNum("BREAKOUT_BULL_CONTINUATION_MIN_PULLBACK_FROM_HIGH_PCT", 0.12),
  BREAKOUT_BULL_CONTINUATION_MIN_OBSERVATIONS: Math.max(2, Math.floor(envNum("BREAKOUT_BULL_CONTINUATION_MIN_OBSERVATIONS", 2))),
  BREAKOUT_BULL_CONTINUATION_RECLAIM_PCT: envNum("BREAKOUT_BULL_CONTINUATION_RECLAIM_PCT", 0.07),
  BREAKOUT_BULL_CONTINUATION_MAX_ENTRY_ABOVE_CONFIRM_PCT: envNum("BREAKOUT_BULL_CONTINUATION_MAX_ENTRY_ABOVE_CONFIRM_PCT", 0.35),
  BREAKOUT_BULL_CONTINUATION_MIN_ADX: envNum("BREAKOUT_BULL_CONTINUATION_MIN_ADX", 22),
  BREAKOUT_BULL_CONTINUATION_MIN_FVVO: envNum("BREAKOUT_BULL_CONTINUATION_MIN_FVVO", 0.75),
  BREAKOUT_BULL_CONTINUATION_MIN_SLOPE: envNum("BREAKOUT_BULL_CONTINUATION_MIN_SLOPE", 0.15),
  BREAKOUT_BULL_CONTINUATION_MAX_RSI: envNum("BREAKOUT_BULL_CONTINUATION_MAX_RSI", 76),
  BREAKOUT_BULL_CONTINUATION_MAX_EXTENSION_FROM_EMA8_PCT: envNum("BREAKOUT_BULL_CONTINUATION_MAX_EXTENSION_FROM_EMA8_PCT", 0.30),
  BREAKOUT_BULL_CONTINUATION_REQUIRE_EMA8_ABOVE_EMA18: envBool("BREAKOUT_BULL_CONTINUATION_REQUIRE_EMA8_ABOVE_EMA18", true),
  BREAKOUT_BULL_CONTINUATION_REQUIRE_RAY_BULL: envBool("BREAKOUT_BULL_CONTINUATION_REQUIRE_RAY_BULL", true),
  BREAKOUT_BULL_CONTINUATION_STOP_DISTANCE_CAP_PCT: envNum("BREAKOUT_BULL_CONTINUATION_STOP_DISTANCE_CAP_PCT", 2.50),

  // v1h one-stop / optional fixed-target controls.
  MANUAL_ONE_STOP_PROFILE_ENABLED: envBool("MANUAL_ONE_STOP_PROFILE_ENABLED", true),
  MANUAL_ONE_STOP_PRICE_STEP: envNum("MANUAL_ONE_STOP_PRICE_STEP", 0.01),
  MANUAL_ONE_STOP_MIN_STOP_DISTANCE_PCT: envNum("MANUAL_ONE_STOP_MIN_STOP_DISTANCE_PCT", 0.25),
  MANUAL_ONE_STOP_MAX_STOP_DISTANCE_PCT: envNum("MAX_STOP_DISTANCE_PCT", envNum("MANUAL_ONE_STOP_MAX_STOP_DISTANCE_PCT", 2.0)),
  MANUAL_ONE_STOP_MAX_TARGET_DISTANCE_PCT: envNum("MAX_PROFIT_TARGET_DISTANCE_PCT", envNum("MANUAL_ONE_STOP_MAX_TARGET_DISTANCE_PCT", 4.0)),
  MANUAL_ONE_STOP_TICK_CONFIRM_SEC: envNum("MANUAL_ONE_STOP_TICK_CONFIRM_SEC", 0),
  MANUAL_ONE_STOP_TICK_CONFIRM_OBSERVATIONS: envNum("MANUAL_ONE_STOP_TICK_CONFIRM_OBSERVATIONS", 1),
  MANUAL_ONE_STOP_5M_CLOSE_IMMEDIATE: envBool("MANUAL_ONE_STOP_5M_CLOSE_IMMEDIATE", true),
  MANUAL_ONE_STOP_TARGET_EXIT_ENABLED: envBool("MANUAL_ONE_STOP_TARGET_EXIT_ENABLED", true),

  // v1e Stage 2: full-position intelligent TP observer. Shadow is the safe default;
  // no partial exits are ever used and shadow mode can never forward an exit.
  INTELLIGENT_TP_MODE: envStr("INTELLIGENT_TP_MODE", "shadow").toLowerCase(),
  INTELLIGENT_TP_MAX_DISTANCE_PCT: envNum("INTELLIGENT_TP_MAX_DISTANCE_PCT", 10.0),
  INTELLIGENT_TP_DECISION_WINDOW_SEC: envNum("INTELLIGENT_TP_DECISION_WINDOW_SEC", 180),
  INTELLIGENT_TP_CONFIRM_OBSERVATIONS: Math.max(1, Math.floor(envNum("INTELLIGENT_TP_CONFIRM_OBSERVATIONS", 2))),
  INTELLIGENT_TP_REJECTION_MIN_BEAR_SIGNALS: Math.max(1, Math.floor(envNum("INTELLIGENT_TP_REJECTION_MIN_BEAR_SIGNALS", 2))),
  INTELLIGENT_TP_PROTECTION_BUFFER_PCT: envNum("INTELLIGENT_TP_PROTECTION_BUFFER_PCT", 0.12),
  INTELLIGENT_TP_PROTECTION_CONFIRM_OBSERVATIONS: Math.max(1, Math.floor(envNum("INTELLIGENT_TP_PROTECTION_CONFIRM_OBSERVATIONS", 2))),
  INTELLIGENT_TP_PROTECTION_HARD_BREAK_PCT: envNum("INTELLIGENT_TP_PROTECTION_HARD_BREAK_PCT", 0.12),
  // v1g: retain a positive estimated net result after TP1 has been reached.
  INTELLIGENT_TP1_COST_AWARE_FLOOR_ENABLED: envBool("INTELLIGENT_TP1_COST_AWARE_FLOOR_ENABLED", true),
  INTELLIGENT_TP1_MIN_NET_LOCK_PCT: envNum("INTELLIGENT_TP1_MIN_NET_LOCK_PCT", 0.05),
  // v1g: once TP2 is clean, protect the best price rather than only the static TP2 floor.
  INTELLIGENT_TP2_PEAK_TRAIL_ENABLED: envBool("INTELLIGENT_TP2_PEAK_TRAIL_ENABLED", true),
  INTELLIGENT_TP2_PEAK_TRAIL_GIVEBACK_PCT: envNum("INTELLIGENT_TP2_PEAK_TRAIL_GIVEBACK_PCT", 0.30),
  INTELLIGENT_TP2_PEAK_TRAIL_HARD_BREAK_PCT: envNum("INTELLIGENT_TP2_PEAK_TRAIL_HARD_BREAK_PCT", 0.05),
  // v1g: near TP3 is not a TP3 hit, but it earns a tighter peak trail.
  INTELLIGENT_TP3_NEAR_MISS_ENABLED: envBool("INTELLIGENT_TP3_NEAR_MISS_ENABLED", true),
  INTELLIGENT_TP3_NEAR_MISS_DISTANCE_PCT: envNum("INTELLIGENT_TP3_NEAR_MISS_DISTANCE_PCT", 0.05),
  INTELLIGENT_TP3_NEAR_MISS_TRAIL_GIVEBACK_PCT: envNum("INTELLIGENT_TP3_NEAR_MISS_TRAIL_GIVEBACK_PCT", 0.25),
  INTELLIGENT_TP3_NEAR_MISS_HARD_BREAK_PCT: envNum("INTELLIGENT_TP3_NEAR_MISS_HARD_BREAK_PCT", 0.05),
  INTELLIGENT_TP_REQUIRE_ABOVE_EMA8: envBool("INTELLIGENT_TP_REQUIRE_ABOVE_EMA8", true),
  INTELLIGENT_TP_REQUIRE_POSITIVE_FVVO: envBool("INTELLIGENT_TP_REQUIRE_POSITIVE_FVVO", true),
  INTELLIGENT_TP_REQUIRE_POSITIVE_SLOPE: envBool("INTELLIGENT_TP_REQUIRE_POSITIVE_SLOPE", true),
  INTELLIGENT_TP_REQUIRE_RAY_NOT_BEAR: envBool("INTELLIGENT_TP_REQUIRE_RAY_NOT_BEAR", true),
  INTELLIGENT_TP1_BREAKOUT_BUFFER_PCT: envNum("INTELLIGENT_TP1_BREAKOUT_BUFFER_PCT", 0.05),
  INTELLIGENT_TP1_REJECTION_BUFFER_PCT: envNum("INTELLIGENT_TP1_REJECTION_BUFFER_PCT", 0.10),
  INTELLIGENT_TP2_BREAKOUT_BUFFER_PCT: envNum("INTELLIGENT_TP2_BREAKOUT_BUFFER_PCT", 0.06),
  INTELLIGENT_TP2_REJECTION_BUFFER_PCT: envNum("INTELLIGENT_TP2_REJECTION_BUFFER_PCT", 0.12),
  INTELLIGENT_TP3_BREAKOUT_BUFFER_PCT: envNum("INTELLIGENT_TP3_BREAKOUT_BUFFER_PCT", 0.08),
  INTELLIGENT_TP3_REJECTION_BUFFER_PCT: envNum("INTELLIGENT_TP3_REJECTION_BUFFER_PCT", 0.15),
  INTELLIGENT_TP3_RUNNER_ENABLED: envBool("INTELLIGENT_TP3_RUNNER_ENABLED", true),
  INTELLIGENT_TP3_RUNNER_MIN_FVVO: envNum("INTELLIGENT_TP3_RUNNER_MIN_FVVO", 1.0),
  INTELLIGENT_TP3_RUNNER_MIN_SLOPE: envNum("INTELLIGENT_TP3_RUNNER_MIN_SLOPE", 0.50),
  INTELLIGENT_TP3_RUNNER_INITIAL_FLOOR_BELOW_TP3_PCT: envNum("INTELLIGENT_TP3_RUNNER_INITIAL_FLOOR_BELOW_TP3_PCT", 0.15),
  INTELLIGENT_TP3_RUNNER_TRAIL_GIVEBACK_PCT: envNum("INTELLIGENT_TP3_RUNNER_TRAIL_GIVEBACK_PCT", 0.25),
  INTELLIGENT_TP3_RUNNER_HARD_BREAK_PCT: envNum("INTELLIGENT_TP3_RUNNER_HARD_BREAK_PCT", 0.12),
  INTELLIGENT_TP3_RUNNER_MAX_SEC: envNum("INTELLIGENT_TP3_RUNNER_MAX_SEC", 21600),

  // v1h dynamic brain-managed profit exit. Every emitted close remains 100%.
  DYNAMIC_PROFIT_EXIT_ENABLED: envBool("DYNAMIC_PROFIT_EXIT_ENABLED", true),
  DYNAMIC_PROFIT_ARM_MFE_PCT: envNum("DYNAMIC_PROFIT_ARM_MFE_PCT", 0.90),
  DYNAMIC_PROFIT_MIN_LOCK_PNL_PCT: envNum("DYNAMIC_PROFIT_MIN_LOCK_PNL_PCT", 0.40),
  DYNAMIC_PROFIT_TRAIL_GIVEBACK_START_PCT: envNum("DYNAMIC_PROFIT_TRAIL_GIVEBACK_START_PCT", 0.55),
  DYNAMIC_PROFIT_TRAIL_GIVEBACK_MIN_PCT: envNum("DYNAMIC_PROFIT_TRAIL_GIVEBACK_MIN_PCT", 0.25),
  DYNAMIC_PROFIT_TRAIL_TIGHTEN_PER_1PCT: envNum("DYNAMIC_PROFIT_TRAIL_TIGHTEN_PER_1PCT", 0.05),
  DYNAMIC_PROFIT_FLOOR_CONFIRM_SEC: envNum("DYNAMIC_PROFIT_FLOOR_CONFIRM_SEC", 0),
  DYNAMIC_PROFIT_FLOOR_CONFIRM_OBSERVATIONS: envNum("DYNAMIC_PROFIT_FLOOR_CONFIRM_OBSERVATIONS", 2),
  DYNAMIC_PROFIT_THESIS_EXIT_ENABLED: envBool("DYNAMIC_PROFIT_THESIS_EXIT_ENABLED", false),
  DYNAMIC_PROFIT_THESIS_MIN_PNL_PCT: envNum("DYNAMIC_PROFIT_THESIS_MIN_PNL_PCT", 0.25),
  DYNAMIC_PROFIT_THESIS_SLOPE_MAX: envNum("DYNAMIC_PROFIT_THESIS_SLOPE_MAX", -0.10),
  DYNAMIC_PROFIT_THESIS_TICK_CONFIRM_SEC: envNum("DYNAMIC_PROFIT_THESIS_TICK_CONFIRM_SEC", 0),
  DYNAMIC_PROFIT_THESIS_TICK_CONFIRM_OBSERVATIONS: envNum("DYNAMIC_PROFIT_THESIS_TICK_CONFIRM_OBSERVATIONS", 2),
  DYNAMIC_PROFIT_5M_THESIS_EXIT_ENABLED: envBool("DYNAMIC_PROFIT_5M_THESIS_EXIT_ENABLED", false),
  DYNAMIC_PROFIT_FLOOR_LOG_STEP_PCT: envNum("DYNAMIC_PROFIT_FLOOR_LOG_STEP_PCT", 0.05),

  // v1d shadow-only observer A: compare the current two-tick live dynamic-profit floor
  // against a smoothed 15s micro confirmation. This observer can never forward an order.
  PROFIT_FLOOR_MICRO_SHADOW_ENABLED: envBool("PROFIT_FLOOR_MICRO_SHADOW_ENABLED", true),
  PROFIT_FLOOR_MICRO_SHADOW_WINDOW_TICKS: Math.max(3, Math.floor(envNum("PROFIT_FLOOR_MICRO_SHADOW_WINDOW_TICKS", 5))),
  PROFIT_FLOOR_MICRO_SHADOW_REQUIRED_BELOW_TICKS: Math.max(1, Math.floor(envNum("PROFIT_FLOOR_MICRO_SHADOW_REQUIRED_BELOW_TICKS", 4))),
  PROFIT_FLOOR_MICRO_SHADOW_MIN_AVG_DECLINE_PCT: envNum("PROFIT_FLOOR_MICRO_SHADOW_MIN_AVG_DECLINE_PCT", 0.001),
  PROFIT_FLOOR_MICRO_SHADOW_MIN_BEAR_SIGNALS: Math.max(1, Math.floor(envNum("PROFIT_FLOOR_MICRO_SHADOW_MIN_BEAR_SIGNALS", 2))),
  PROFIT_FLOOR_MICRO_SHADOW_MOMENTUM_RECOVERY_VETO: envBool("PROFIT_FLOOR_MICRO_SHADOW_MOMENTUM_RECOVERY_VETO", true),
  PROFIT_FLOOR_MICRO_SHADOW_MAX_SEC: envNum("PROFIT_FLOOR_MICRO_SHADOW_MAX_SEC", 75),
  PROFIT_FLOOR_MICRO_SHADOW_HARD_BREAK_BUFFER_PCT: envNum("PROFIT_FLOOR_MICRO_SHADOW_HARD_BREAK_BUFFER_PCT", 0.10),
  PROFIT_FLOOR_MICRO_SHADOW_HARD_NET_PNL_PCT: envNum("PROFIT_FLOOR_MICRO_SHADOW_HARD_NET_PNL_PCT", 0.20),
  PROFIT_FLOOR_MICRO_SHADOW_RECOVERY_BUFFER_PCT: envNum("PROFIT_FLOOR_MICRO_SHADOW_RECOVERY_BUFFER_PCT", 0.03),
  PROFIT_FLOOR_MICRO_SHADOW_RECOVERY_OBSERVATIONS: Math.max(1, Math.floor(envNum("PROFIT_FLOOR_MICRO_SHADOW_RECOVERY_OBSERVATIONS", 2))),

  // v1d shadow-only observer B: after a real normal-floor exit, look for a high-quality
  // hypothetical reclaim and track its one-hour MFE/MAE. It can never send enter_long.
  PROFIT_FLOOR_POST_EXIT_RECLAIM_SHADOW_ENABLED: envBool("PROFIT_FLOOR_POST_EXIT_RECLAIM_SHADOW_ENABLED", true),
  PROFIT_FLOOR_POST_EXIT_RECLAIM_WINDOW_SEC: envNum("PROFIT_FLOOR_POST_EXIT_RECLAIM_WINDOW_SEC", 2700),
  PROFIT_FLOOR_POST_EXIT_RECLAIM_CONFIRM_OBSERVATIONS: Math.max(1, Math.floor(envNum("PROFIT_FLOOR_POST_EXIT_RECLAIM_CONFIRM_OBSERVATIONS", 2))),
  PROFIT_FLOOR_POST_EXIT_RECLAIM_MIN_RECOVERY_PCT: envNum("PROFIT_FLOOR_POST_EXIT_RECLAIM_MIN_RECOVERY_PCT", 0.08),
  PROFIT_FLOOR_POST_EXIT_RECLAIM_MAX_RECOVERY_PCT: envNum("PROFIT_FLOOR_POST_EXIT_RECLAIM_MAX_RECOVERY_PCT", 0.25),
  PROFIT_FLOOR_POST_EXIT_RECLAIM_MIN_RSI: envNum("PROFIT_FLOOR_POST_EXIT_RECLAIM_MIN_RSI", 54),
  PROFIT_FLOOR_POST_EXIT_RECLAIM_MAX_RSI: envNum("PROFIT_FLOOR_POST_EXIT_RECLAIM_MAX_RSI", 74),
  PROFIT_FLOOR_POST_EXIT_RECLAIM_MIN_ADX: envNum("PROFIT_FLOOR_POST_EXIT_RECLAIM_MIN_ADX", 15),
  PROFIT_FLOOR_POST_EXIT_RECLAIM_MIN_FVVO: envNum("PROFIT_FLOOR_POST_EXIT_RECLAIM_MIN_FVVO", 0),
  PROFIT_FLOOR_POST_EXIT_RECLAIM_MIN_SLOPE: envNum("PROFIT_FLOOR_POST_EXIT_RECLAIM_MIN_SLOPE", 0.60),
  PROFIT_FLOOR_POST_EXIT_RECLAIM_5M_MAX_AGE_SEC: envNum("PROFIT_FLOOR_POST_EXIT_RECLAIM_5M_MAX_AGE_SEC", 420),
  PROFIT_FLOOR_POST_EXIT_RECLAIM_PERFORMANCE_SEC: envNum("PROFIT_FLOOR_POST_EXIT_RECLAIM_PERFORMANCE_SEC", 3600),
  PROFIT_FLOOR_POST_EXIT_RECLAIM_MONITOR_LOG_SEC: envNum("PROFIT_FLOOR_POST_EXIT_RECLAIM_MONITOR_LOG_SEC", 300),

  // Swing v1b: structure-led full-position exit. This sits below the manual stop,
  // loss-side thesis fail, dynamic floor, and runner trail. It does not create entries.
  SWING_STRUCTURE_EXIT_MODE: envStr("SWING_STRUCTURE_EXIT_MODE", "live").toLowerCase(),
  SWING_STRUCTURE_MIN_MFE_PCT: envNum("SWING_STRUCTURE_MIN_MFE_PCT", 0.60),
  SWING_STRUCTURE_MIN_CURRENT_PNL_PCT: envNum("SWING_STRUCTURE_MIN_CURRENT_PNL_PCT", 0.20),
  SWING_STRUCTURE_EMA18_BREAK_TOLERANCE_PCT: envNum("SWING_STRUCTURE_EMA18_BREAK_TOLERANCE_PCT", 0.08),
  SWING_STRUCTURE_CONFIRM_5M_OBSERVATIONS: Math.max(1, Math.floor(envNum("SWING_STRUCTURE_CONFIRM_5M_OBSERVATIONS", 2))),
  SWING_STRUCTURE_MIN_DETERIORATION_SIGNALS: Math.max(1, Math.floor(envNum("SWING_STRUCTURE_MIN_DETERIORATION_SIGNALS", 2))),
  SWING_STRUCTURE_MAX_RSI: envNum("SWING_STRUCTURE_MAX_RSI", 48),
  SWING_STRUCTURE_MAX_FVVO: envNum("SWING_STRUCTURE_MAX_FVVO", 0.0),
  SWING_STRUCTURE_MAX_SLOPE: envNum("SWING_STRUCTURE_MAX_SLOPE", 0.0),
  SWING_STRUCTURE_REQUIRE_CLOSE_BELOW_EMA18: envBool("SWING_STRUCTURE_REQUIRE_CLOSE_BELOW_EMA18", true),
  SWING_STRUCTURE_REQUIRE_EMA8_BELOW_EMA18: envBool("SWING_STRUCTURE_REQUIRE_EMA8_BELOW_EMA18", false),
  SWING_STRUCTURE_REQUIRE_RAY_BEAR: envBool("SWING_STRUCTURE_REQUIRE_RAY_BEAR", false),
  SWING_STRUCTURE_EMERGENCY_BREAK_PCT: envNum("SWING_STRUCTURE_EMERGENCY_BREAK_PCT", 0.20),
  // v1c: the confirmed 5m emergency candle arms a fast state instead of exiting immediately.
  // The live path uses smoothed 15s micro-trend persistence; intelligent synthetic-1m and
  // legacy-immediate outcomes are logged in shadow for direct counterfactual comparison.
  SWING_STRUCTURE_EMERGENCY_CONFIRM_5M_OBSERVATIONS: Math.max(1, Math.floor(envNum("SWING_STRUCTURE_EMERGENCY_CONFIRM_5M_OBSERVATIONS", 1))),
  SWING_EMERGENCY_FAST_CONFIRM_MODE: envStr("SWING_EMERGENCY_FAST_CONFIRM_MODE", "micro_15s_trend").toLowerCase(),
  SWING_EMERGENCY_FAST_CONFIRM_MAX_SEC: envNum("SWING_EMERGENCY_FAST_CONFIRM_MAX_SEC", 195),
  SWING_EMERGENCY_MICRO_WINDOW_TICKS: Math.max(5, Math.floor(envNum("SWING_EMERGENCY_MICRO_WINDOW_TICKS", 5))),
  SWING_EMERGENCY_MICRO_REQUIRED_BELOW_TICKS: Math.max(1, Math.floor(envNum("SWING_EMERGENCY_MICRO_REQUIRED_BELOW_TICKS", 4))),
  SWING_EMERGENCY_MICRO_CONFIRM_OBSERVATIONS: Math.max(1, Math.floor(envNum("SWING_EMERGENCY_MICRO_CONFIRM_OBSERVATIONS", 2))),
  SWING_EMERGENCY_MICRO_MIN_AVG_DECLINE_PCT: envNum("SWING_EMERGENCY_MICRO_MIN_AVG_DECLINE_PCT", 0.001),
  SWING_EMERGENCY_MICRO_MIN_BEAR_SIGNALS: Math.max(1, Math.floor(envNum("SWING_EMERGENCY_MICRO_MIN_BEAR_SIGNALS", 2))),
  SWING_EMERGENCY_MICRO_MOMENTUM_RECOVERY_VETO: envBool("SWING_EMERGENCY_MICRO_MOMENTUM_RECOVERY_VETO", true),
  SWING_EMERGENCY_HARD_BREAK_BUFFER_PCT: envNum("SWING_EMERGENCY_HARD_BREAK_BUFFER_PCT", 0.12),
  SWING_EMERGENCY_HARD_EXIT_PNL_PCT: envNum("SWING_EMERGENCY_HARD_EXIT_PNL_PCT", -0.35),
  // v1k: profitable hard breaks require persistence unless the fast tape is recovering.
  // Losing hard breaks, the stop, and protected profit floors remain immediate.
  SWING_EMERGENCY_PROFIT_HARD_BREAK_CONFIRM_OBSERVATIONS: Math.max(1, Math.floor(envNum("SWING_EMERGENCY_PROFIT_HARD_BREAK_CONFIRM_OBSERVATIONS", 2))),
  SWING_EMERGENCY_PROFIT_HARD_BREAK_MIN_SPAN_SEC: envNum("SWING_EMERGENCY_PROFIT_HARD_BREAK_MIN_SPAN_SEC", 12),
  SWING_EMERGENCY_RECOVERY_CANCEL_MIN_SIGNALS: Math.max(1, Math.floor(envNum("SWING_EMERGENCY_RECOVERY_CANCEL_MIN_SIGNALS", 4))),
  SWING_EMERGENCY_RECOVERY_REQUIRE_PRICE_RISING: envBool("SWING_EMERGENCY_RECOVERY_REQUIRE_PRICE_RISING", true),
  SWING_EMERGENCY_RECOVERY_RECLAIM_BUFFER_PCT: envNum("SWING_EMERGENCY_RECOVERY_RECLAIM_BUFFER_PCT", 0.02),
  SWING_EMERGENCY_RECOVERY_CONFIRM_OBSERVATIONS: Math.max(1, Math.floor(envNum("SWING_EMERGENCY_RECOVERY_CONFIRM_OBSERVATIONS", 2))),
  SWING_EMERGENCY_TIMEOUT_EXIT_MIN_BEAR_SIGNALS: Math.max(1, Math.floor(envNum("SWING_EMERGENCY_TIMEOUT_EXIT_MIN_BEAR_SIGNALS", 3))),
  SWING_EMERGENCY_SHADOW_INTELLIGENT_1M_ENABLED: envBool("SWING_EMERGENCY_SHADOW_INTELLIGENT_1M_ENABLED", true),
  SWING_EMERGENCY_SHADOW_1M_CONFIRM_OBSERVATIONS: Math.max(1, Math.floor(envNum("SWING_EMERGENCY_SHADOW_1M_CONFIRM_OBSERVATIONS", 2))),
  SWING_EMERGENCY_SHADOW_1M_MIN_BEAR_SIGNALS: Math.max(1, Math.floor(envNum("SWING_EMERGENCY_SHADOW_1M_MIN_BEAR_SIGNALS", 2))),
  SWING_EMERGENCY_SHADOW_LEGACY_IMMEDIATE_ENABLED: envBool("SWING_EMERGENCY_SHADOW_LEGACY_IMMEDIATE_ENABLED", true),
  SWING_NO_PROGRESS_CHECK_AFTER_SEC: envNum("SWING_NO_PROGRESS_CHECK_AFTER_SEC", 21600),
  SWING_NO_PROGRESS_MAX_MFE_PCT: envNum("SWING_NO_PROGRESS_MAX_MFE_PCT", 0.80),
  SWING_NO_PROGRESS_MAX_CURRENT_PNL_PCT: envNum("SWING_NO_PROGRESS_MAX_CURRENT_PNL_PCT", 0.20),
  SWING_NO_PROGRESS_REQUIRE_WEAK_STRUCTURE: envBool("SWING_NO_PROGRESS_REQUIRE_WEAK_STRUCTURE", true),
  SWING_NO_PROGRESS_CONFIRM_5M_OBSERVATIONS: Math.max(1, Math.floor(envNum("SWING_NO_PROGRESS_CONFIRM_5M_OBSERVATIONS", 2))),
  SWING_HARD_MAX_HOLD_SEC: envNum("SWING_HARD_MAX_HOLD_SEC", 86400),

  // v1y: strict loss-side thesis-failure overlay. This does not change the manual stop
  // contract; it audits or exits early only when an unprotected trade has clearly broken down.
  LOSS_SIDE_THESIS_FAIL_MODE: envStr("LOSS_SIDE_THESIS_FAIL_MODE", "live").toLowerCase(),
  LOSS_SIDE_THESIS_FAIL_MIN_LOSS_PCT: envNum("LOSS_SIDE_THESIS_FAIL_MIN_LOSS_PCT", -0.35),
  LOSS_SIDE_THESIS_FAIL_MAX_RSI: envNum("LOSS_SIDE_THESIS_FAIL_MAX_RSI", 32),
  LOSS_SIDE_THESIS_FAIL_MIN_ADX: envNum("LOSS_SIDE_THESIS_FAIL_MIN_ADX", 20),
  LOSS_SIDE_THESIS_FAIL_MAX_FVVO: envNum("LOSS_SIDE_THESIS_FAIL_MAX_FVVO", -3.0),
  LOSS_SIDE_THESIS_FAIL_MAX_SLOPE: envNum("LOSS_SIDE_THESIS_FAIL_MAX_SLOPE", 0.0),
  LOSS_SIDE_THESIS_FAIL_CONFIRM_OBSERVATIONS: Math.floor(envNum("LOSS_SIDE_THESIS_FAIL_CONFIRM_OBSERVATIONS", 2)),
  LOSS_SIDE_THESIS_FAIL_CONFIRM_SEC: envNum("LOSS_SIDE_THESIS_FAIL_CONFIRM_SEC", 0),
  LOSS_SIDE_THESIS_FAIL_REQUIRE_RAY_BEAR: envBool("LOSS_SIDE_THESIS_FAIL_REQUIRE_RAY_BEAR", true),
  LOSS_SIDE_THESIS_FAIL_REQUIRE_BELOW_EMA8_AND_EMA18: envBool("LOSS_SIDE_THESIS_FAIL_REQUIRE_BELOW_EMA8_AND_EMA18", true),

  // v1s: after a profitable 15s/tick thesis-failure signal, optionally defer the full exit while
  // the fresh 5m trend remains above its EMA18 (the chart pink line). Hard stop, dynamic floor
  // and runner trail always remain higher-priority. `shadow` only audits; `live` can hold briefly.
  DYNAMIC_PULLBACK_GRACE_MODE: envStr("DYNAMIC_PULLBACK_GRACE_MODE", "disabled").toLowerCase(),
  DYNAMIC_PULLBACK_GRACE_MIN_MFE_PCT: envNum("DYNAMIC_PULLBACK_GRACE_MIN_MFE_PCT", 1.10),
  DYNAMIC_PULLBACK_GRACE_MIN_PNL_PCT: envNum("DYNAMIC_PULLBACK_GRACE_MIN_PNL_PCT", 0.25),
  DYNAMIC_PULLBACK_GRACE_MAX_SEC: envNum("DYNAMIC_PULLBACK_GRACE_MAX_SEC", 90),
  DYNAMIC_PULLBACK_GRACE_CONTEXT_MAX_AGE_SEC: envNum("DYNAMIC_PULLBACK_GRACE_CONTEXT_MAX_AGE_SEC", 420),
  DYNAMIC_PULLBACK_GRACE_REQUIRE_5M_EMA_BULL: envBool("DYNAMIC_PULLBACK_GRACE_REQUIRE_5M_EMA_BULL", true),
  DYNAMIC_PULLBACK_GRACE_REQUIRE_RAY_NOT_BEAR: envBool("DYNAMIC_PULLBACK_GRACE_REQUIRE_RAY_NOT_BEAR", true),
  DYNAMIC_PULLBACK_GRACE_MIN_5M_FVVO: envNum("DYNAMIC_PULLBACK_GRACE_MIN_5M_FVVO", -0.50),
  DYNAMIC_PULLBACK_GRACE_PINK_BREAK_TOLERANCE_PCT: envNum("DYNAMIC_PULLBACK_GRACE_PINK_BREAK_TOLERANCE_PCT", 0),
  DYNAMIC_PULLBACK_GRACE_PINK_BREAK_CONFIRM_OBSERVATIONS: Math.floor(envNum("DYNAMIC_PULLBACK_GRACE_PINK_BREAK_CONFIRM_OBSERVATIONS", 1)),
  DYNAMIC_PULLBACK_GRACE_RECOVERY_REQUIRE_CROSS_UP: envBool("DYNAMIC_PULLBACK_GRACE_RECOVERY_REQUIRE_CROSS_UP", false),

  // v1k strong-runner protection retained in v1l. This changes exits only; no new primary entry path is added.
  // "live" suppresses the fast 15s thesis exit after the hold threshold and activates a tight runner trail after the arm threshold.
  // "shadow" logs what would have been held/trailing but preserves baseline exits.
  RUNNER_EXIT_ENABLED: envBool("RUNNER_EXIT_ENABLED", true),
  RUNNER_EXIT_MODE: envStr("RUNNER_EXIT_MODE", "live").toLowerCase(),
  RUNNER_HOLD_MIN_MFE_PCT: envNum("RUNNER_HOLD_MIN_MFE_PCT", 1.10),
  RUNNER_TIGHT_TRAIL_ARM_MFE_PCT: envNum("RUNNER_TIGHT_TRAIL_ARM_MFE_PCT", 1.60),
  RUNNER_TIGHT_TRAIL_GIVEBACK_PCT: envNum("RUNNER_TIGHT_TRAIL_GIVEBACK_PCT", 0.25),
  RUNNER_TIGHT_TRAIL_CONFIRM_SEC: envNum("RUNNER_TIGHT_TRAIL_CONFIRM_SEC", 0),
  RUNNER_TIGHT_TRAIL_CONFIRM_OBSERVATIONS: Math.floor(envNum("RUNNER_TIGHT_TRAIL_CONFIRM_OBSERVATIONS", 2)),
  RUNNER_TIGHT_TRAIL_LOG_STEP_PCT: envNum("RUNNER_TIGHT_TRAIL_LOG_STEP_PCT", 0.05),

  // v1t: qualified tight-runner exits can be audited, or only when explicitly promoted
  // held briefly while fresh 5m EMA18/pink structure remains healthy. Default is audit-only.
  RUNNER_CONTINUATION_RESCUE_MODE: envStr("RUNNER_CONTINUATION_RESCUE_MODE", "live").toLowerCase(),
  RUNNER_CONTINUATION_RESCUE_MIN_MFE_PCT: envNum("RUNNER_CONTINUATION_RESCUE_MIN_MFE_PCT", 1.75),
  RUNNER_CONTINUATION_RESCUE_MIN_PNL_PCT: envNum("RUNNER_CONTINUATION_RESCUE_MIN_PNL_PCT", 0.75),
  RUNNER_CONTINUATION_RESCUE_MAX_SEC: envNum("RUNNER_CONTINUATION_RESCUE_MAX_SEC", 180),
  RUNNER_CONTINUATION_RESCUE_CONTEXT_MAX_AGE_SEC: envNum("RUNNER_CONTINUATION_RESCUE_CONTEXT_MAX_AGE_SEC", 420),
  RUNNER_CONTINUATION_RESCUE_REQUIRE_5M_EMA_BULL: envBool("RUNNER_CONTINUATION_RESCUE_REQUIRE_5M_EMA_BULL", true),
  RUNNER_CONTINUATION_RESCUE_REQUIRE_RAY_NOT_BEAR: envBool("RUNNER_CONTINUATION_RESCUE_REQUIRE_RAY_NOT_BEAR", true),
  RUNNER_CONTINUATION_RESCUE_MIN_5M_FVVO: envNum("RUNNER_CONTINUATION_RESCUE_MIN_5M_FVVO", -0.50),
  RUNNER_CONTINUATION_RESCUE_MIN_HARD_LOCK_PNL_PCT: envNum("RUNNER_CONTINUATION_RESCUE_MIN_HARD_LOCK_PNL_PCT", 0.70),
  RUNNER_CONTINUATION_RESCUE_PINK_BREAK_TOLERANCE_PCT: envNum("RUNNER_CONTINUATION_RESCUE_PINK_BREAK_TOLERANCE_PCT", 0),
  RUNNER_CONTINUATION_RESCUE_PINK_BREAK_CONFIRM_OBSERVATIONS: Math.floor(envNum("RUNNER_CONTINUATION_RESCUE_PINK_BREAK_CONFIRM_OBSERVATIONS", 1)),
  RUNNER_CONTINUATION_RESCUE_MAX_RESCUES_PER_TRADE: Math.floor(envNum("RUNNER_CONTINUATION_RESCUE_MAX_RESCUES_PER_TRADE", 1)),

  // v1u: audit strict confirmed-5m gating against a fast-tick proxy without ever allowing the
  // proxy to change a live runner exit. The post-exit audit follows the actual baseline exit only.
  RUNNER_CONTINUATION_RESCUE_FAST_TICK_PROXY_AUDIT_ENABLED: envBool("RUNNER_CONTINUATION_RESCUE_FAST_TICK_PROXY_AUDIT_ENABLED", true),
  RUNNER_CONTINUATION_RESCUE_FAST_TICK_MIN_FVVO: envNum("RUNNER_CONTINUATION_RESCUE_FAST_TICK_MIN_FVVO", 0),
  RUNNER_CONTINUATION_RESCUE_POST_EXIT_AUDIT_ENABLED: envBool("RUNNER_CONTINUATION_RESCUE_POST_EXIT_AUDIT_ENABLED", true),
  RUNNER_CONTINUATION_RESCUE_POST_EXIT_AUDIT_HORIZONS_SEC: envStr("RUNNER_CONTINUATION_RESCUE_POST_EXIT_AUDIT_HORIZONS_SEC", "60,90,120,180"),

  // v1l/v1m re-entry: strict pullback reclaim micro-breakout.
  // `shadow` observes only; `auto` sends a bot-fixed market re-entry after the auto-release guard.
  // Legacy `demo_auto` is treated as `auto` so an existing v1m DEMO variable set remains compatible.
  REENTRY_ENABLED: envBool("REENTRY_ENABLED", false),
  REENTRY_PHASE: (() => { const phase = envStr("REENTRY_PHASE", "shadow").toLowerCase(); return phase === "demo_auto" ? "auto" : phase; })(),
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
  // v1u audit-only hysteresis measures noise around the EMA18 invalidation threshold. It does not
  // alter automatic re-entry eligibility in the selected runtime configuration.
  REENTRY_PULLBACK_HYSTERESIS_AUDIT_ENABLED: envBool("REENTRY_PULLBACK_HYSTERESIS_AUDIT_ENABLED", true),
  REENTRY_PULLBACK_INVALIDATION_HYSTERESIS_PCT: envNum("REENTRY_PULLBACK_INVALIDATION_HYSTERESIS_PCT", 0.05),
  REENTRY_PULLBACK_REARM_ABOVE_EMA18_PCT: envNum("REENTRY_PULLBACK_REARM_ABOVE_EMA18_PCT", 0.03),
  REENTRY_MIN_BOUNCE_FROM_LOW_PCT: envNum("REENTRY_MIN_BOUNCE_FROM_LOW_PCT", 0.25),
  // v1r: optional late-reclaim ceiling. 0 disables the ceiling. This controls entry timing only; it never changes stops.
  REENTRY_MAX_BOUNCE_FROM_LOW_PCT: envNum("REENTRY_MAX_BOUNCE_FROM_LOW_PCT", 0),
  REENTRY_REQUIRE_RECLAIM_EMA8: envBool("REENTRY_REQUIRE_RECLAIM_EMA8", true),
  REENTRY_MIN_RSI: envNum("REENTRY_MIN_RSI", 54),
  REENTRY_MAX_RSI: envNum("REENTRY_MAX_RSI", 84),
  REENTRY_MIN_ADX: envNum("REENTRY_MIN_ADX", 17),
  REENTRY_MIN_FVVO: envNum("REENTRY_MIN_FVVO", -1.00),
  REENTRY_MIN_SLOPE: envNum("REENTRY_MIN_SLOPE", 0.50),
  REENTRY_MAX_CHASE_ABOVE_EMA8_PCT: envNum("REENTRY_MAX_CHASE_ABOVE_EMA8_PCT", 0.30),
  REENTRY_RECLAIM_CONFIRM_OBSERVATIONS: Math.floor(envNum("REENTRY_RECLAIM_CONFIRM_OBSERVATIONS", 2)),
  // v1h: a reclaim cannot use a 5m candle that predates the final pullback low.
  REENTRY_POST_PULLBACK_5M_ALIGNMENT_ENABLED: envBool("REENTRY_POST_PULLBACK_5M_ALIGNMENT_ENABLED", true),
  REENTRY_POST_PULLBACK_5M_REQUIRE_CLOSE_ABOVE_EMA8: envBool("REENTRY_POST_PULLBACK_5M_REQUIRE_CLOSE_ABOVE_EMA8", true),
  REENTRY_POST_PULLBACK_5M_REQUIRE_EMA8_ABOVE_EMA18: envBool("REENTRY_POST_PULLBACK_5M_REQUIRE_EMA8_ABOVE_EMA18", true),
  REENTRY_POST_PULLBACK_5M_MIN_FVVO: envNum("REENTRY_POST_PULLBACK_5M_MIN_FVVO", 0),
  REENTRY_POST_PULLBACK_5M_REQUIRE_RAY_NOT_BEAR: envBool("REENTRY_POST_PULLBACK_5M_REQUIRE_RAY_NOT_BEAR", true),
  REENTRY_POST_PULLBACK_5M_MIN_SLOPE: envNum("REENTRY_POST_PULLBACK_5M_MIN_SLOPE", -0.65),
  REENTRY_POST_PULLBACK_5M_POSITIVE_SLOPE_BYPASS: envNum("REENTRY_POST_PULLBACK_5M_POSITIVE_SLOPE_BYPASS", 0),
  REENTRY_POST_PULLBACK_5M_MIN_SLOPE_IMPROVEMENT: envNum("REENTRY_POST_PULLBACK_5M_MIN_SLOPE_IMPROVEMENT", 0.10),
  REENTRY_STOP_BUFFER_PCT: envNum("REENTRY_STOP_BUFFER_PCT", 0.15),
  REENTRY_MIN_STOP_DISTANCE_PCT: envNum("REENTRY_MIN_STOP_DISTANCE_PCT", 0.25),
  REENTRY_MAX_STOP_DISTANCE_PCT: envNum("REENTRY_MAX_STOP_DISTANCE_PCT", 1.20),

  // v1q: preserve a valid pullback that occurs while the 90-second exit-release timer is active.
  // This never sends an entry before the release; it only seeds the post-release reclaim state.
  REENTRY_PRE_RELEASE_MEMORY_ENABLED: envBool("REENTRY_PRE_RELEASE_MEMORY_ENABLED", true),
  REENTRY_PRE_RELEASE_TICK_OVERRIDE_ENABLED: envBool("REENTRY_PRE_RELEASE_TICK_OVERRIDE_ENABLED", true),
  REENTRY_PRE_RELEASE_OVERRIDE_REQUIRE_CROSS_UP: envBool("REENTRY_PRE_RELEASE_OVERRIDE_REQUIRE_CROSS_UP", true),
  REENTRY_PRE_RELEASE_OVERRIDE_REQUIRE_RAY_BULL: envBool("REENTRY_PRE_RELEASE_OVERRIDE_REQUIRE_RAY_BULL", true),
  REENTRY_PRE_RELEASE_OVERRIDE_MIN_RSI: envNum("REENTRY_PRE_RELEASE_OVERRIDE_MIN_RSI", 58),
  REENTRY_PRE_RELEASE_OVERRIDE_MIN_ADX: envNum("REENTRY_PRE_RELEASE_OVERRIDE_MIN_ADX", 18),
  REENTRY_PRE_RELEASE_OVERRIDE_MIN_FVVO: envNum("REENTRY_PRE_RELEASE_OVERRIDE_MIN_FVVO", 0),
  REENTRY_PRE_RELEASE_OVERRIDE_MIN_SLOPE: envNum("REENTRY_PRE_RELEASE_OVERRIDE_MIN_SLOPE", 0.80),
  // A strict fast-reclaim override also applies after a qualifying pullback observed after release; it is needed because the 5m context can lag the first 15s reclaim.
  REENTRY_FAST_RECLAIM_TICK_OVERRIDE_ENABLED: envBool("REENTRY_FAST_RECLAIM_TICK_OVERRIDE_ENABLED", true),
  REENTRY_FAST_RECLAIM_MIN_PRIOR_IMPULSE_PCT: envNum("REENTRY_FAST_RECLAIM_MIN_PRIOR_IMPULSE_PCT", 0.90),
  REENTRY_FAST_RECLAIM_OVERRIDE_MAX_RSI: envNum("REENTRY_FAST_RECLAIM_OVERRIDE_MAX_RSI", 72),

  // v1v: measure whether a first strong 15-second recovery tick can improve an automatic
  // re-entry price without changing production entries. Both paths default to shadow.
  // `fast_launch` is a strict one-tick launch; `early_turn` is deliberately more permissive
  // and must remain shadow until replay + live audits justify any promotion.
  REENTRY_15S_FAST_LAUNCH_MODE: envStr("REENTRY_15S_FAST_LAUNCH_MODE", "shadow").toLowerCase(),
  REENTRY_15S_FAST_LAUNCH_MIN_PRIOR_IMPULSE_PCT: envNum("REENTRY_15S_FAST_LAUNCH_MIN_PRIOR_IMPULSE_PCT", 0.90),
  REENTRY_15S_FAST_LAUNCH_MIN_PULLBACK_PCT: envNum("REENTRY_15S_FAST_LAUNCH_MIN_PULLBACK_PCT", 0.70),
  REENTRY_15S_FAST_LAUNCH_MAX_PULLBACK_PCT: envNum("REENTRY_15S_FAST_LAUNCH_MAX_PULLBACK_PCT", 1.20),
  REENTRY_15S_FAST_LAUNCH_MIN_RSI: envNum("REENTRY_15S_FAST_LAUNCH_MIN_RSI", 65),
  REENTRY_15S_FAST_LAUNCH_MAX_RSI: envNum("REENTRY_15S_FAST_LAUNCH_MAX_RSI", 84),
  REENTRY_15S_FAST_LAUNCH_MIN_ADX: envNum("REENTRY_15S_FAST_LAUNCH_MIN_ADX", 30),
  REENTRY_15S_FAST_LAUNCH_MIN_FVVO: envNum("REENTRY_15S_FAST_LAUNCH_MIN_FVVO", 0.50),
  REENTRY_15S_FAST_LAUNCH_MIN_SLOPE: envNum("REENTRY_15S_FAST_LAUNCH_MIN_SLOPE", 1.20),
  REENTRY_15S_FAST_LAUNCH_REQUIRE_RAY_BULL: envBool("REENTRY_15S_FAST_LAUNCH_REQUIRE_RAY_BULL", true),
  REENTRY_15S_FAST_LAUNCH_REQUIRE_CROSS_UP: envBool("REENTRY_15S_FAST_LAUNCH_REQUIRE_CROSS_UP", true),
  REENTRY_15S_FAST_LAUNCH_REQUIRE_5M_CONTEXT: envBool("REENTRY_15S_FAST_LAUNCH_REQUIRE_5M_CONTEXT", true),

  REENTRY_15S_EARLY_TURN_MODE: envStr("REENTRY_15S_EARLY_TURN_MODE", "live").toLowerCase(),
  REENTRY_15S_EARLY_TURN_MIN_PRIOR_IMPULSE_PCT: envNum("REENTRY_15S_EARLY_TURN_MIN_PRIOR_IMPULSE_PCT", 0.90),
  REENTRY_15S_EARLY_TURN_MIN_PULLBACK_PCT: envNum("REENTRY_15S_EARLY_TURN_MIN_PULLBACK_PCT", 0.70),
  REENTRY_15S_EARLY_TURN_MAX_PULLBACK_PCT: envNum("REENTRY_15S_EARLY_TURN_MAX_PULLBACK_PCT", 1.20),
  REENTRY_15S_EARLY_TURN_MIN_RSI: envNum("REENTRY_15S_EARLY_TURN_MIN_RSI", 54),
  REENTRY_15S_EARLY_TURN_MIN_ADX: envNum("REENTRY_15S_EARLY_TURN_MIN_ADX", 30),
  REENTRY_15S_EARLY_TURN_MIN_FVVO: envNum("REENTRY_15S_EARLY_TURN_MIN_FVVO", -1.00),
  REENTRY_15S_EARLY_TURN_MIN_SLOPE: envNum("REENTRY_15S_EARLY_TURN_MIN_SLOPE", 0.80),
  REENTRY_15S_EARLY_TURN_EMA_CONVERGENCE_TOLERANCE_PCT: envNum("REENTRY_15S_EARLY_TURN_EMA_CONVERGENCE_TOLERANCE_PCT", 0.03),
  REENTRY_15S_EARLY_TURN_REQUIRE_5M_CONTEXT: envBool("REENTRY_15S_EARLY_TURN_REQUIRE_5M_CONTEXT", true),

  // v1x: after the existing 90-second assumed-flat release, observe a compact recovered base
  // without requiring a new 0.35% pullback from the prior trade peak. This is intentionally
  // independent from the standard WAIT_PULLBACK path. `shadow` writes evidence only; `live`
  // is explicitly opt-in and still requires a two-tick recovery confirmation and projected stop.
  POST_EXIT_RECOVERED_BASE_MODE: envStr("POST_EXIT_RECOVERED_BASE_MODE", "live").toLowerCase(),
  POST_EXIT_RECOVERED_BASE_WINDOW_SEC: envNum("POST_EXIT_RECOVERED_BASE_WINDOW_SEC", 600),
  POST_EXIT_RECOVERED_BASE_MIN_PRIOR_IMPULSE_PCT: envNum("POST_EXIT_RECOVERED_BASE_MIN_PRIOR_IMPULSE_PCT", 0.60),
  POST_EXIT_RECOVERED_BASE_MIN_RECOVERY_PCT: envNum("POST_EXIT_RECOVERED_BASE_MIN_RECOVERY_PCT", 0.06),
  POST_EXIT_RECOVERED_BASE_MAX_CHASE_FROM_LOW_PCT: envNum("POST_EXIT_RECOVERED_BASE_MAX_CHASE_FROM_LOW_PCT", 0.18),
  POST_EXIT_RECOVERED_BASE_CONFIRM_OBSERVATIONS: Math.floor(envNum("POST_EXIT_RECOVERED_BASE_CONFIRM_OBSERVATIONS", 2)),
  POST_EXIT_RECOVERED_BASE_MIN_RSI: envNum("POST_EXIT_RECOVERED_BASE_MIN_RSI", 54),
  POST_EXIT_RECOVERED_BASE_MAX_RSI: envNum("POST_EXIT_RECOVERED_BASE_MAX_RSI", 72),
  POST_EXIT_RECOVERED_BASE_MIN_ADX: envNum("POST_EXIT_RECOVERED_BASE_MIN_ADX", 15),
  POST_EXIT_RECOVERED_BASE_MIN_FVVO: envNum("POST_EXIT_RECOVERED_BASE_MIN_FVVO", 0),
  POST_EXIT_RECOVERED_BASE_MIN_SLOPE: envNum("POST_EXIT_RECOVERED_BASE_MIN_SLOPE", 0.60),
  POST_EXIT_RECOVERED_BASE_REQUIRE_RAY_NOT_BEAR: envBool("POST_EXIT_RECOVERED_BASE_REQUIRE_RAY_NOT_BEAR", true),
  POST_EXIT_RECOVERED_BASE_REQUIRE_5M_CONTEXT: envBool("POST_EXIT_RECOVERED_BASE_REQUIRE_5M_CONTEXT", true),
  POST_EXIT_RECOVERED_BASE_REQUIRE_EMA8_ABOVE_EMA18: envBool("POST_EXIT_RECOVERED_BASE_REQUIRE_EMA8_ABOVE_EMA18", true),

  // v1r: when a profitable AUTO_REENTRY sees a transient tick-thesis failure while the 5m thesis remains strongly bullish,
  // optionally defer that one exit until a short recovery cross or timeout. Manual/price-trigger first legs are untouched.
  // disabled | shadow | live. Default is shadow so missing variables cannot alter production exits.
  REENTRY_CONTINUATION_GRACE_MODE: envStr("REENTRY_CONTINUATION_GRACE_MODE", "live").toLowerCase(),
  REENTRY_CONTINUATION_GRACE_MIN_MFE_PCT: envNum("REENTRY_CONTINUATION_GRACE_MIN_MFE_PCT", 0.55),
  REENTRY_CONTINUATION_GRACE_MIN_PNL_PCT: envNum("REENTRY_CONTINUATION_GRACE_MIN_PNL_PCT", 0.25),
  REENTRY_CONTINUATION_GRACE_MAX_SEC: envNum("REENTRY_CONTINUATION_GRACE_MAX_SEC", 180),
  REENTRY_CONTINUATION_GRACE_CONTEXT_MAX_AGE_SEC: envNum("REENTRY_CONTINUATION_GRACE_CONTEXT_MAX_AGE_SEC", 420),
  REENTRY_CONTINUATION_GRACE_REQUIRE_RAY_BULL: envBool("REENTRY_CONTINUATION_GRACE_REQUIRE_RAY_BULL", true),
  REENTRY_CONTINUATION_GRACE_REQUIRE_5M_EMA_BULL: envBool("REENTRY_CONTINUATION_GRACE_REQUIRE_5M_EMA_BULL", true),
  REENTRY_CONTINUATION_GRACE_MIN_5M_FVVO: envNum("REENTRY_CONTINUATION_GRACE_MIN_5M_FVVO", 0),
  REENTRY_CONTINUATION_GRACE_RECOVERY_REQUIRE_CROSS_UP: envBool("REENTRY_CONTINUATION_GRACE_RECOVERY_REQUIRE_CROSS_UP", true),

  // The server accepts yellowPulse/yellowReason from the feature publisher. v1q records them only; no Yellow TP is forwarded.
  YELLOW_TP_SHADOW_ENABLED: envBool("YELLOW_TP_SHADOW_ENABLED", true),
  YELLOW_TP_SHADOW_MIN_MFE_PCT: envNum("YELLOW_TP_SHADOW_MIN_MFE_PCT", 0.75),
  YELLOW_TP_SHADOW_MIN_PNL_PCT: envNum("YELLOW_TP_SHADOW_MIN_PNL_PCT", 0.50),
};

const PROFILE = "SWING_BALANCED_STRUCTURE_EXIT";
const REENTRY_PROFILE = "AUTO_REENTRY_PULLBACK_MICROBREAKOUT";
const POST_EXIT_RECOVERED_BASE_PROFILE = "AUTO_REENTRY_POST_EXIT_RECOVERED_BASE";
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
let testNowMs = null;
let state = defaultState();
let autoExitReleaseTimer = null;

function nowMs() { return Number.isFinite(testNowMs) ? testNowMs : Date.now(); }
function nowIso() { return new Date(nowMs()).toISOString(); }
function setTestNowMs(value) { testNowMs = Number.isFinite(Number(value)) ? Number(value) : null; }
function resetStateForTest() { clearAutoExitReleaseTimer(); state = defaultState(); }
function snapshotStateForTest() { return clone(state); }
function injectTrackedPositionForTest({ entryPrice, stopPrice, profitTargetPrice = 0, entryOrigin = "MANUAL", reentryNumber = 0 } = {}) {
  const entry = finite(entryPrice, null);
  const stop = finite(stopPrice, null);
  if (!(entry > 0) || !(stop > 0) || stop >= entry) throw new Error("TEST_POSITION_LEVELS_INVALID");
  const levels = { stopPrice: stop, stopPct: round(percentageBelow(entry, stop), 6), profitTargetPrice: finite(profitTargetPrice, 0) || 0, profitTargetPct: finite(profitTargetPrice, 0) > 0 ? round(percentPnl(entry, profitTargetPrice), 6) : 0 };
  state.position = buildPosition(entry, levels, { entryOrigin, profile: entryOrigin === "AUTO_REENTRY" ? REENTRY_PROFILE : PROFILE, reentryNumber });
  state.position.lifecycle = "ENTRY_ACCEPTED_UNVERIFIED_FILL";
  state.position.entryAcceptedAt = nowIso();
  state.position.entryAcceptedAtMs = nowMs();
  state.externalDealLock = { active: true, source: "test_replay", setAt: nowIso(), reason: "ENTRY_ACCEPTED_UNVERIFIED_FILL" };
  return state.position;
}
function finite(value, fallback = null) { if (value === null || value === undefined || value === "") return fallback; const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function firstFinite(...values) { for (const value of values) { const parsed = finite(value, null); if (parsed !== null) return parsed; } return null; }
function round(value, digits = 6) { return Number(Number(value).toFixed(digits)); }
function cleanSymbol(value) { return String(value || "").trim().toUpperCase(); }
function percentPnl(entry, price) { return ((price - entry) / entry) * 100; }
function percentageBelow(entry, price) { return ((entry - price) / entry) * 100; }
function pctPriceBelow(entry, pct) { return entry * (1 - pct / 100); }
function pnlAudit(position, price) {
  const signalEntry = finite(position?.entryPriceReference, null);
  const actualFill = finite(position?.actualEntryFillPrice, null);
  const signalGross = signalEntry && price ? percentPnl(signalEntry, price) : null;
  const actualFillGross = actualFill && price ? percentPnl(actualFill, price) : null;
  const basisGross = actualFillGross !== null ? actualFillGross : signalGross;
  return {
    signalEntryPriceReference: signalEntry,
    actualEntryFillPrice: actualFill,
    fillVerified: Boolean(position?.exchangeFillVerified && actualFill),
    pnlBasis: actualFillGross !== null ? "ACTUAL_FILL_AUDIT" : "SIGNAL_REFERENCE",
    signalReferenceGrossPnlPct: signalGross === null ? null : round(signalGross, 6),
    actualFillGrossPnlPct: actualFillGross === null ? null : round(actualFillGross, 6),
    estimatedRoundTripCostPct: round(Math.max(0, CFG.PNL_ESTIMATED_ROUND_TRIP_COST_PCT), 6),
    estimatedNetPnlPct: basisGross === null ? null : round(basisGross - Math.max(0, CFG.PNL_ESTIMATED_ROUND_TRIP_COST_PCT), 6),
  };
}
function safeTimingEqual(left, right) { const a = Buffer.from(String(left || "")); const b = Buffer.from(String(right || "")); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function authenticate(expected, received) { return Boolean(expected) && safeTimingEqual(expected, received); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function logMarker(level, event, fields = {}) {
  const name = String(event || "").toUpperCase();
  const action = String(fields.action || "").toLowerCase();
  if (level === "ERROR" || name.includes("FAILED") || name.includes("FATAL")) return LOG_MARKER.error;
  if (name.includes("CANCELLED") || name.includes("CANCELED")) return LOG_MARKER.exit;
  if (level === "WARN" || name.includes("BLOCK") || name.includes("EXPIRED") || name.includes("REJECTED")) return LOG_MARKER.warning;
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
    schemaVersion: 19,
    updatedAt: nowIso(),
    lastFeature: null,
    lastFeature5m: null,
    lastFastTick: null,
    position: null,
    externalDealLock: { active: false, source: "", setAt: "", reason: "" },
    manual: { handoffActive: false, recoveryRequired: false, recoveryReason: "", lastAction: "", lastActionAt: "", entryConfirmation: null },
    forward: { lastByKey: {}, lastRequestId: "" },
    reentry: { campaign: null, recentTickPrices: [] },
    // Persisted auto-exit release state so a Railway restart cannot silently skip or duplicate a release.
    autoExitRelease: { active: false, status: "IDLE", positionOpenedAtMs: 0, releaseAtMs: 0, armedAt: "", releaseAt: "", requestId: "", reason: "", releasedAt: "", reentryPullbackMemory: null },
    priceEntry: { pending: null, pending2: null, pending3: null, last: null, dormantDeepFallback: null },
    audit: { runnerRescuePostExit: null, profitFloorMicroShadow: null, profitFloorPostExitReclaimShadow: null, breakoutPostExpiryShadows: [], lastBarTimeByKind: {} },
  };
}

function normalizeState(raw) {
  const fallback = defaultState();
  if (!raw || typeof raw !== "object") return fallback;
  const next = { ...fallback, ...raw };
  // v1h schema migration marker: preserve compatible fields but always persist the current schema.
  next.schemaVersion = 19;
  next.forward = { ...fallback.forward, ...(raw.forward || {}) };
  next.manual = { ...fallback.manual, ...(raw.manual || {}) };
  if (next.manual.entryConfirmation && typeof next.manual.entryConfirmation !== "object") next.manual.entryConfirmation = null;
  next.externalDealLock = { ...fallback.externalDealLock, ...(raw.externalDealLock || {}) };
  next.reentry = { ...fallback.reentry, ...(raw.reentry || {}) };
  next.reentry.recentTickPrices = Array.isArray(next.reentry.recentTickPrices) ? next.reentry.recentTickPrices.slice(-12) : [];
  next.autoExitRelease = { ...fallback.autoExitRelease, ...(raw.autoExitRelease || {}) };
  next.autoExitRelease.active = Boolean(next.autoExitRelease.active);
  next.autoExitRelease.releaseAtMs = finite(next.autoExitRelease.releaseAtMs, 0);
  next.autoExitRelease.positionOpenedAtMs = finite(next.autoExitRelease.positionOpenedAtMs, 0);
  next.priceEntry = { ...fallback.priceEntry, ...(raw.priceEntry || {}) };
  if (next.priceEntry.dormantDeepFallback && typeof next.priceEntry.dormantDeepFallback !== "object") next.priceEntry.dormantDeepFallback = null;
  next.audit = { ...fallback.audit, ...(raw.audit || {}) };
  next.audit.lastBarTimeByKind = next.audit.lastBarTimeByKind && typeof next.audit.lastBarTimeByKind === "object" ? next.audit.lastBarTimeByKind : {};
  if (next.audit.runnerRescuePostExit && typeof next.audit.runnerRescuePostExit !== "object") next.audit.runnerRescuePostExit = null;
  next.audit.profitFloorMicroShadow = normalizeProfitFloorMicroShadowState(next.audit.profitFloorMicroShadow);
  next.audit.profitFloorPostExitReclaimShadow = normalizeProfitFloorPostExitReclaimShadowState(next.audit.profitFloorPostExitReclaimShadow);
  next.audit.breakoutPostExpiryShadows = Array.isArray(next.audit.breakoutPostExpiryShadows) ? next.audit.breakoutPostExpiryShadows.filter((x) => x && typeof x === "object").slice(-4) : [];
  if (next.priceEntry.pending && typeof next.priceEntry.pending !== "object") next.priceEntry.pending = null;
  if (next.priceEntry.pending2 && typeof next.priceEntry.pending2 !== "object") next.priceEntry.pending2 = null;
  if (next.priceEntry.pending3 && typeof next.priceEntry.pending3 !== "object") next.priceEntry.pending3 = null;
  if (next.priceEntry.last && typeof next.priceEntry.last !== "object") next.priceEntry.last = null;
  // v1f: de-duplicate all three persisted campaign slots after restart.
  const seenPriceEntryIds = new Set();
  for (const slot of ["pending", "pending2", "pending3"]) {
    const item = next.priceEntry[slot];
    if (!item) continue;
    if (!item.id || seenPriceEntryIds.has(item.id)) next.priceEntry[slot] = null;
    else seenPriceEntryIds.add(item.id);
  }

  if (!raw.position || typeof raw.position !== "object") return next;
  const p = { ...raw.position };
  const entry = finite(p.entryPriceReference, null);
  p.actualEntryFillPrice = finite(p.actualEntryFillPrice, null);
  p.actualEntryFillConfirmedAt = p.actualEntryFillConfirmedAt || null;
  p.actualEntryFillSource = p.actualEntryFillSource || null;
  p.actualEntryDealId = p.actualEntryDealId || null;
  p.exchangeFillVerified = Boolean(p.exchangeFillVerified && p.actualEntryFillPrice);

  // Safe migration from the retired v1e two-level state: retain the stricter
  // final price as the only stop if a position exists during deployment.
  const migratedStop = firstFinite(p.stopPrice, p.finalStopPrice, p.firstStopPrice, entry ? pctPriceBelow(entry, finite(p.finalStopPct, finite(p.firstStopPct, 1.0))) : null);
  const migratedTarget = firstFinite(p.profitTargetPrice, 0);
  p.entryOrigin = p.entryOrigin || "MANUAL";
  p.reentryNumber = Math.max(0, Math.floor(finite(p.reentryNumber, 0)));
  p.profile = p.entryOrigin === "AUTO_REENTRY" ? REENTRY_PROFILE : PROFILE;
  p.phase = "ONE_STOP_ACTIVE";
  p.stopPrice = finite(migratedStop, null);
  p.stopPct = entry && p.stopPrice ? round(percentageBelow(entry, p.stopPrice), 6) : finite(p.stopPct, 0);
  p.profitTargetPrice = migratedTarget > 0 ? migratedTarget : 0;
  p.profitTargetPct = entry && p.profitTargetPrice > 0 ? round(percentPnl(entry, p.profitTargetPrice), 6) : 0;
  if (p.intelligentTp && typeof p.intelligentTp === "object") {
    const priorTp = p.intelligentTp;
    p.intelligentTp = {
      ...buildIntelligentTpState({ intelligentTp: { tp1Price: finite(priorTp.tp1Price, 0), tp2Price: finite(priorTp.tp2Price, 0), tp3Price: finite(priorTp.tp3Price, 0) } }),
      ...priorTp,
      history: Array.isArray(priorTp.history) ? priorTp.history.slice(-20) : [],
    };
  } else p.intelligentTp = null;
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
    runner: {
      holdActive: Boolean(priorDynamic.runner?.holdActive),
      holdActivatedAtMs: finite(priorDynamic.runner?.holdActivatedAtMs, 0),
      holdActivatedAtPnlPct: finite(priorDynamic.runner?.holdActivatedAtPnlPct, 0),
      tightTrailArmed: Boolean(priorDynamic.runner?.tightTrailArmed),
      tightTrailArmedAtMs: finite(priorDynamic.runner?.tightTrailArmedAtMs, 0),
      tightTrailArmedAtPnlPct: finite(priorDynamic.runner?.tightTrailArmedAtPnlPct, 0),
      protectedPnlPct: Math.max(0, finite(priorDynamic.runner?.protectedPnlPct, 0)),
      protectedPrice: finite(priorDynamic.runner?.protectedPrice, null),
      trailPeakPnlPct: Math.max(0, finite(priorDynamic.runner?.trailPeakPnlPct, 0)),
      lastLoggedProtectedPnlPct: Math.max(0, finite(priorDynamic.runner?.lastLoggedProtectedPnlPct, 0)),
      floor: { breachAtMs: 0, observations: 0, lastBreachPrice: null, ...(priorDynamic.runner?.floor || {}) },
      suppressedTickThesisCount: Math.max(0, Math.floor(finite(priorDynamic.runner?.suppressedTickThesisCount, 0))),
      continuationRescue: { active: Boolean(priorDynamic.runner?.continuationRescue?.active), consumed: Boolean(priorDynamic.runner?.continuationRescue?.consumed), count: Math.max(0, Math.floor(finite(priorDynamic.runner?.continuationRescue?.count, 0))), startedAtMs: finite(priorDynamic.runner?.continuationRescue?.startedAtMs, 0), expiresAtMs: finite(priorDynamic.runner?.continuationRescue?.expiresAtMs, 0), baselineExitPrice: finite(priorDynamic.runner?.continuationRescue?.baselineExitPrice, null), baselinePnlPct: finite(priorDynamic.runner?.continuationRescue?.baselinePnlPct, 0), baselineProtectedPnlPct: finite(priorDynamic.runner?.continuationRescue?.baselineProtectedPnlPct, 0), baselineProtectedPrice: finite(priorDynamic.runner?.continuationRescue?.baselineProtectedPrice, null), hardLockPnlPct: finite(priorDynamic.runner?.continuationRescue?.hardLockPnlPct, 0), hardLockPrice: finite(priorDynamic.runner?.continuationRescue?.hardLockPrice, null), baselineReason: priorDynamic.runner?.continuationRescue?.baselineReason || null, context: priorDynamic.runner?.continuationRescue?.context || null, pinkBreakAtMs: finite(priorDynamic.runner?.continuationRescue?.pinkBreakAtMs, 0), pinkBreakObservations: Math.max(0, Math.floor(finite(priorDynamic.runner?.continuationRescue?.pinkBreakObservations, 0))), shadowLogged: Boolean(priorDynamic.runner?.continuationRescue?.shadowLogged) },
    },
    lastThesisReason: priorDynamic.lastThesisReason || null,
  };
  if (p.dynamicProfit.armed && entry) {
    const computedFloor = dynamicProfitFloorPnlPct(p.dynamicProfit.peakPnlPct);
    p.dynamicProfit.protectedPnlPct = Math.max(p.dynamicProfit.protectedPnlPct, computedFloor);
    p.dynamicProfit.protectedPrice = round(entry * (1 + p.dynamicProfit.protectedPnlPct / 100), 8);
    const runner = p.dynamicProfit.runner;
    const runnerPeak = p.dynamicProfit.peakPnlPct;
    if (CFG.RUNNER_EXIT_ENABLED && runnerPeak >= CFG.RUNNER_HOLD_MIN_MFE_PCT) {
      runner.holdActive = true;
      if (!runner.holdActivatedAtMs) runner.holdActivatedAtMs = nowMs();
      if (!runner.holdActivatedAtPnlPct) runner.holdActivatedAtPnlPct = round(runnerPeak, 6);
    }
    if (CFG.RUNNER_EXIT_ENABLED && runnerPeak >= CFG.RUNNER_TIGHT_TRAIL_ARM_MFE_PCT) {
      runner.tightTrailArmed = true;
      if (!runner.tightTrailArmedAtMs) runner.tightTrailArmedAtMs = nowMs();
      if (!runner.tightTrailArmedAtPnlPct) runner.tightTrailArmedAtPnlPct = round(runnerPeak, 6);
      const floorPnl = Math.max(0, runnerPeak - CFG.RUNNER_TIGHT_TRAIL_GIVEBACK_PCT);
      runner.protectedPnlPct = Math.max(runner.protectedPnlPct, round(floorPnl, 6));
      runner.protectedPrice = round(entry * (1 + runner.protectedPnlPct / 100), 8);
    }
  }
  p.lossSideThesis = { breachAtMs: 0, observations: 0, lastBreachPrice: null, lastFeatureKind: null, lastReason: null, shadowLogged: false, ...(p.lossSideThesis || {}) };
  p.swingExit = normalizeSwingExitState(p.swingExit);
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
    const probe = path.join(CFG.STATE_DIR, `.brainfvvo-v1h-probe-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
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
  if (!["demo", "live"].includes(CFG.EXECUTION_MODE)) problems.push("EXECUTION_MODE_MUST_BE_DEMO_OR_LIVE");
  if (CFG.SHADOW_ONLY) problems.push("SHADOW_ONLY_MUST_BE_FALSE");
  if (CFG.C3_ENTRY_SIZE_SOURCE !== "bot_fixed") problems.push("C3_ENTRY_SIZE_SOURCE_MUST_BE_BOT_FIXED");
  if (!CFG.C3_EXIT_INCLUDE_POSITION_ORDER) problems.push("C3_EXIT_INCLUDE_POSITION_ORDER_MUST_BE_TRUE");
  // v1m must have a single exit owner. The attached 3Commas native stop is disabled
  // because it can complete without a callback to this service.
  if (CFG.C3_NATIVE_STOP_ENABLED) problems.push("C3_NATIVE_STOP_MUST_BE_FALSE_V1M_BRAIN_OWNS_ALL_EXITS");
  if (CFG.MANUAL_ONE_STOP_PRICE_STEP <= 0) problems.push("INVALID_ONE_STOP_PRICE_STEP");
  if (CFG.MANUAL_ONE_STOP_MIN_STOP_DISTANCE_PCT <= 0) problems.push("INVALID_MIN_STOP_DISTANCE_PCT");
  if (CFG.MANUAL_ONE_STOP_MAX_STOP_DISTANCE_PCT < CFG.MANUAL_ONE_STOP_MIN_STOP_DISTANCE_PCT) problems.push("MAX_STOP_DISTANCE_MUST_BE_AT_LEAST_MIN_STOP_DISTANCE");
  if (CFG.MANUAL_ONE_STOP_MAX_TARGET_DISTANCE_PCT < 0) problems.push("INVALID_MAX_TARGET_DISTANCE_PCT");
  if (CFG.MANUAL_ONE_STOP_TICK_CONFIRM_SEC < 0) problems.push("INVALID_STOP_CONFIRM_SEC");
  if (CFG.MANUAL_ONE_STOP_TICK_CONFIRM_OBSERVATIONS < 1) problems.push("INVALID_STOP_CONFIRM_OBSERVATIONS");
  if (!["disabled", "shadow", "live"].includes(CFG.INTELLIGENT_TP_MODE)) problems.push("INVALID_INTELLIGENT_TP_MODE");
  if (CFG.INTELLIGENT_TP_MAX_DISTANCE_PCT <= 0 || CFG.INTELLIGENT_TP_DECISION_WINDOW_SEC <= 0 || CFG.INTELLIGENT_TP_CONFIRM_OBSERVATIONS < 1 || CFG.INTELLIGENT_TP_REJECTION_MIN_BEAR_SIGNALS < 1 || CFG.INTELLIGENT_TP_PROTECTION_CONFIRM_OBSERVATIONS < 1) problems.push("INVALID_INTELLIGENT_TP_CORE_CONFIG");
  if (CFG.INTELLIGENT_TP_PROTECTION_BUFFER_PCT < 0 || CFG.INTELLIGENT_TP_PROTECTION_HARD_BREAK_PCT < 0 || CFG.INTELLIGENT_TP3_RUNNER_INITIAL_FLOOR_BELOW_TP3_PCT < 0 || CFG.INTELLIGENT_TP3_RUNNER_TRAIL_GIVEBACK_PCT <= 0 || CFG.INTELLIGENT_TP3_RUNNER_HARD_BREAK_PCT < 0 || CFG.INTELLIGENT_TP3_RUNNER_MAX_SEC <= 0) problems.push("INVALID_INTELLIGENT_TP_PROTECTION_CONFIG");
  if (CFG.INTELLIGENT_TP1_MIN_NET_LOCK_PCT < 0 || CFG.INTELLIGENT_TP2_PEAK_TRAIL_GIVEBACK_PCT <= 0 || CFG.INTELLIGENT_TP2_PEAK_TRAIL_HARD_BREAK_PCT < 0 || CFG.INTELLIGENT_TP3_NEAR_MISS_DISTANCE_PCT <= 0 || CFG.INTELLIGENT_TP3_NEAR_MISS_TRAIL_GIVEBACK_PCT <= 0 || CFG.INTELLIGENT_TP3_NEAR_MISS_HARD_BREAK_PCT < 0) problems.push("INVALID_INTELLIGENT_TP_V1G_PROFIT_LOCK_CONFIG");
  if (CFG.MANUAL_ENTRY_OVERHEAT_CONFIRM_EXPIRY_SEC < 15 || CFG.MANUAL_ENTRY_OVERHEAT_CONFIRM_EXPIRY_SEC > 900 || CFG.MANUAL_ENTRY_OVERHEAT_CONFIRM_MAX_PRICE_DEVIATION_PCT < 0 || CFG.MANUAL_ENTRY_OVERHEAT_MIN_RSI <= 0 || CFG.MANUAL_ENTRY_OVERHEAT_MIN_ADX < 0 || CFG.MANUAL_ENTRY_OVERHEAT_MIN_SIGNALS < 1 || CFG.MANUAL_ENTRY_OVERHEAT_MIN_SIGNALS > 5) problems.push("INVALID_MANUAL_ENTRY_OVERHEAT_CONFIRMATION_CONFIG");
  if (CFG.PNL_ESTIMATED_ROUND_TRIP_COST_PCT < 0 || CFG.PNL_ESTIMATED_ROUND_TRIP_COST_PCT > 2) problems.push("INVALID_PNL_ESTIMATED_ROUND_TRIP_COST_PCT");
  if (CFG.MANUAL_ENTRY_FILL_MAX_DEVIATION_PCT <= 0 || CFG.MANUAL_ENTRY_FILL_MAX_DEVIATION_PCT > 5) problems.push("INVALID_MANUAL_ENTRY_FILL_MAX_DEVIATION_PCT");
  if (CFG.DYNAMIC_PROFIT_ARM_MFE_PCT <= 0) problems.push("INVALID_DYNAMIC_PROFIT_ARM_MFE_PCT");
  if (CFG.DYNAMIC_PROFIT_MIN_LOCK_PNL_PCT < 0) problems.push("INVALID_DYNAMIC_PROFIT_MIN_LOCK_PNL_PCT");
  if (CFG.DYNAMIC_PROFIT_TRAIL_GIVEBACK_START_PCT <= 0) problems.push("INVALID_DYNAMIC_PROFIT_TRAIL_GIVEBACK_START_PCT");
  if (CFG.DYNAMIC_PROFIT_TRAIL_GIVEBACK_MIN_PCT <= 0 || CFG.DYNAMIC_PROFIT_TRAIL_GIVEBACK_MIN_PCT > CFG.DYNAMIC_PROFIT_TRAIL_GIVEBACK_START_PCT) problems.push("INVALID_DYNAMIC_PROFIT_TRAIL_GIVEBACK_MIN_PCT");
  if (CFG.DYNAMIC_PROFIT_TRAIL_TIGHTEN_PER_1PCT < 0) problems.push("INVALID_DYNAMIC_PROFIT_TRAIL_TIGHTEN_PER_1PCT");
  if (CFG.DYNAMIC_PROFIT_FLOOR_CONFIRM_SEC < 0 || CFG.DYNAMIC_PROFIT_FLOOR_CONFIRM_OBSERVATIONS < 1) problems.push("INVALID_DYNAMIC_PROFIT_FLOOR_CONFIRM");
  if (CFG.PROFIT_FLOOR_MICRO_SHADOW_WINDOW_TICKS < 3 || CFG.PROFIT_FLOOR_MICRO_SHADOW_REQUIRED_BELOW_TICKS < 1 || CFG.PROFIT_FLOOR_MICRO_SHADOW_REQUIRED_BELOW_TICKS > CFG.PROFIT_FLOOR_MICRO_SHADOW_WINDOW_TICKS || CFG.PROFIT_FLOOR_MICRO_SHADOW_MAX_SEC <= 0 || CFG.PROFIT_FLOOR_MICRO_SHADOW_HARD_BREAK_BUFFER_PCT < 0 || CFG.PROFIT_FLOOR_MICRO_SHADOW_RECOVERY_OBSERVATIONS < 1) problems.push("INVALID_PROFIT_FLOOR_MICRO_SHADOW_CONFIG");
  if (CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_WINDOW_SEC <= 0 || CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_CONFIRM_OBSERVATIONS < 1 || CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_MIN_RECOVERY_PCT < 0 || CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_MAX_RECOVERY_PCT < CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_MIN_RECOVERY_PCT || CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_PERFORMANCE_SEC <= 0) problems.push("INVALID_PROFIT_FLOOR_POST_EXIT_RECLAIM_SHADOW_CONFIG");
  if (CFG.DYNAMIC_PROFIT_THESIS_MIN_PNL_PCT < 0 || CFG.DYNAMIC_PROFIT_THESIS_TICK_CONFIRM_SEC < 0 || CFG.DYNAMIC_PROFIT_THESIS_TICK_CONFIRM_OBSERVATIONS < 1) problems.push("INVALID_DYNAMIC_PROFIT_THESIS_CONFIRM");
  if (!["disabled", "shadow", "live"].includes(CFG.LOSS_SIDE_THESIS_FAIL_MODE)) problems.push("INVALID_LOSS_SIDE_THESIS_FAIL_MODE");
  if (CFG.LOSS_SIDE_THESIS_FAIL_MIN_LOSS_PCT >= 0 || CFG.LOSS_SIDE_THESIS_FAIL_CONFIRM_SEC < 0 || CFG.LOSS_SIDE_THESIS_FAIL_CONFIRM_OBSERVATIONS < 1 || CFG.LOSS_SIDE_THESIS_FAIL_MAX_RSI <= 0 || CFG.LOSS_SIDE_THESIS_FAIL_MIN_ADX < 0) problems.push("INVALID_LOSS_SIDE_THESIS_FAIL_THRESHOLDS");
  if (!["disabled", "shadow", "live"].includes(CFG.SWING_STRUCTURE_EXIT_MODE)) problems.push("INVALID_SWING_STRUCTURE_EXIT_MODE");
  if (CFG.SWING_STRUCTURE_MIN_MFE_PCT < 0 || CFG.SWING_STRUCTURE_MIN_CURRENT_PNL_PCT < 0 || CFG.SWING_STRUCTURE_EMA18_BREAK_TOLERANCE_PCT < 0 || CFG.SWING_STRUCTURE_CONFIRM_5M_OBSERVATIONS < 1 || CFG.SWING_STRUCTURE_MIN_DETERIORATION_SIGNALS < 1 || CFG.SWING_STRUCTURE_EMERGENCY_BREAK_PCT < CFG.SWING_STRUCTURE_EMA18_BREAK_TOLERANCE_PCT || CFG.SWING_STRUCTURE_EMERGENCY_CONFIRM_5M_OBSERVATIONS < 1) problems.push("INVALID_SWING_STRUCTURE_THRESHOLDS");
  if (!["disabled", "shadow", "micro_15s_trend"].includes(CFG.SWING_EMERGENCY_FAST_CONFIRM_MODE)) problems.push("INVALID_SWING_EMERGENCY_FAST_CONFIRM_MODE");
  if (CFG.SWING_EMERGENCY_FAST_CONFIRM_MAX_SEC < 30 || CFG.SWING_EMERGENCY_FAST_CONFIRM_MAX_SEC > 600 || CFG.SWING_EMERGENCY_MICRO_WINDOW_TICKS < 5 || CFG.SWING_EMERGENCY_MICRO_REQUIRED_BELOW_TICKS < 1 || CFG.SWING_EMERGENCY_MICRO_REQUIRED_BELOW_TICKS > CFG.SWING_EMERGENCY_MICRO_WINDOW_TICKS || CFG.SWING_EMERGENCY_MICRO_CONFIRM_OBSERVATIONS < 1 || CFG.SWING_EMERGENCY_MICRO_MIN_AVG_DECLINE_PCT < 0 || CFG.SWING_EMERGENCY_MICRO_MIN_BEAR_SIGNALS < 1 || CFG.SWING_EMERGENCY_HARD_BREAK_BUFFER_PCT < 0 || CFG.SWING_EMERGENCY_HARD_EXIT_PNL_PCT >= 0 || CFG.SWING_EMERGENCY_PROFIT_HARD_BREAK_CONFIRM_OBSERVATIONS < 1 || CFG.SWING_EMERGENCY_PROFIT_HARD_BREAK_MIN_SPAN_SEC < 0 || CFG.SWING_EMERGENCY_RECOVERY_CANCEL_MIN_SIGNALS < 1 || CFG.SWING_EMERGENCY_RECOVERY_CANCEL_MIN_SIGNALS > 5 || CFG.SWING_EMERGENCY_RECOVERY_RECLAIM_BUFFER_PCT < 0 || CFG.SWING_EMERGENCY_RECOVERY_CONFIRM_OBSERVATIONS < 1 || CFG.SWING_EMERGENCY_TIMEOUT_EXIT_MIN_BEAR_SIGNALS < 1 || CFG.SWING_EMERGENCY_SHADOW_1M_CONFIRM_OBSERVATIONS < 1 || CFG.SWING_EMERGENCY_SHADOW_1M_MIN_BEAR_SIGNALS < 1) problems.push("INVALID_SWING_EMERGENCY_FAST_THRESHOLDS");
  if (CFG.SWING_NO_PROGRESS_CHECK_AFTER_SEC < 0 || CFG.SWING_NO_PROGRESS_MAX_MFE_PCT < 0 || CFG.SWING_NO_PROGRESS_CONFIRM_5M_OBSERVATIONS < 1 || CFG.SWING_HARD_MAX_HOLD_SEC <= 0 || CFG.SWING_HARD_MAX_HOLD_SEC < CFG.SWING_NO_PROGRESS_CHECK_AFTER_SEC) problems.push("INVALID_SWING_HOLD_THRESHOLDS");
  if (!["disabled", "shadow", "live"].includes(CFG.DYNAMIC_PULLBACK_GRACE_MODE)) problems.push("INVALID_DYNAMIC_PULLBACK_GRACE_MODE");
  if (CFG.DYNAMIC_PULLBACK_GRACE_MIN_MFE_PCT < CFG.DYNAMIC_PROFIT_ARM_MFE_PCT || CFG.DYNAMIC_PULLBACK_GRACE_MIN_PNL_PCT < 0 || CFG.DYNAMIC_PULLBACK_GRACE_MAX_SEC < 0 || CFG.DYNAMIC_PULLBACK_GRACE_CONTEXT_MAX_AGE_SEC <= 0 || CFG.DYNAMIC_PULLBACK_GRACE_PINK_BREAK_TOLERANCE_PCT < 0 || CFG.DYNAMIC_PULLBACK_GRACE_PINK_BREAK_CONFIRM_OBSERVATIONS < 1) problems.push("INVALID_DYNAMIC_PULLBACK_GRACE_THRESHOLDS");
  if (!["live", "shadow", "disabled"].includes(CFG.RUNNER_EXIT_MODE)) problems.push("INVALID_RUNNER_EXIT_MODE");
  if (CFG.RUNNER_HOLD_MIN_MFE_PCT <= 0 || CFG.RUNNER_TIGHT_TRAIL_ARM_MFE_PCT < CFG.RUNNER_HOLD_MIN_MFE_PCT || CFG.RUNNER_TIGHT_TRAIL_GIVEBACK_PCT <= 0) problems.push("INVALID_RUNNER_THRESHOLDS");
  if (CFG.RUNNER_TIGHT_TRAIL_CONFIRM_SEC < 0 || CFG.RUNNER_TIGHT_TRAIL_CONFIRM_OBSERVATIONS < 1) problems.push("INVALID_RUNNER_TIGHT_TRAIL_CONFIRM");
  if (!["disabled", "shadow", "live"].includes(CFG.RUNNER_CONTINUATION_RESCUE_MODE)) problems.push("INVALID_RUNNER_CONTINUATION_RESCUE_MODE");
  if (CFG.RUNNER_CONTINUATION_RESCUE_MIN_MFE_PCT < CFG.RUNNER_TIGHT_TRAIL_ARM_MFE_PCT || CFG.RUNNER_CONTINUATION_RESCUE_MIN_PNL_PCT < 0 || CFG.RUNNER_CONTINUATION_RESCUE_MAX_SEC < 0 || CFG.RUNNER_CONTINUATION_RESCUE_CONTEXT_MAX_AGE_SEC <= 0 || CFG.RUNNER_CONTINUATION_RESCUE_MIN_HARD_LOCK_PNL_PCT < 0 || CFG.RUNNER_CONTINUATION_RESCUE_PINK_BREAK_TOLERANCE_PCT < 0 || CFG.RUNNER_CONTINUATION_RESCUE_PINK_BREAK_CONFIRM_OBSERVATIONS < 1 || CFG.RUNNER_CONTINUATION_RESCUE_MAX_RESCUES_PER_TRADE < 1) problems.push("INVALID_RUNNER_CONTINUATION_RESCUE_THRESHOLDS");
  if (CFG.RUNNER_CONTINUATION_RESCUE_FAST_TICK_MIN_FVVO < -20 || CFG.RUNNER_CONTINUATION_RESCUE_FAST_TICK_MIN_FVVO > 20) problems.push("INVALID_RUNNER_FAST_TICK_PROXY_CONFIG");
  if (CFG.C3_ASSUME_EXIT_ACCEPTANCE) problems.push("C3_ASSUME_EXIT_ACCEPTANCE_MUST_BE_FALSE_USE_AUTO_EXIT_RECONCILIATION");
  if (CFG.AUTO_EXIT_RECONCILIATION_ENABLED && (CFG.AUTO_EXIT_RECONCILIATION_DELAY_SEC < 1 || CFG.AUTO_EXIT_RECONCILIATION_DELAY_SEC > 600)) problems.push("INVALID_AUTO_EXIT_RECONCILIATION_DELAY_SEC");
  if (!["shadow", "auto"].includes(CFG.REENTRY_PHASE)) problems.push("INVALID_REENTRY_PHASE");
  if (CFG.REENTRY_PHASE === "shadow" && CFG.REENTRY_AUTO_FORWARD_ENABLED) problems.push("REENTRY_AUTO_FORWARD_REQUIRES_AUTO_PHASE");
  if (CFG.REENTRY_PHASE === "auto" && !CFG.REENTRY_AUTO_FORWARD_ENABLED) problems.push("REENTRY_AUTO_REQUIRES_AUTO_FORWARD_TRUE");
  if (CFG.REENTRY_PHASE === "auto" && !CFG.AUTO_EXIT_RECONCILIATION_ENABLED) problems.push("REENTRY_AUTO_REQUIRES_AUTO_EXIT_RELEASE");
  if (CFG.REENTRY_MAX_COUNT < 1 || CFG.REENTRY_MAX_COUNT > 2) problems.push("REENTRY_MAX_COUNT_MUST_BE_1_OR_2");
  if (CFG.REENTRY_MIN_PRIOR_IMPULSE_PCT <= 0 || CFG.REENTRY_CAMPAIGN_MAX_AGE_SEC <= 0 || CFG.REENTRY_CONTEXT_MAX_AGE_SEC <= 0) problems.push("INVALID_REENTRY_CAMPAIGN_GUARD");
  if (CFG.REENTRY_POST_PULLBACK_5M_MIN_SLOPE_IMPROVEMENT < 0 || CFG.REENTRY_POST_PULLBACK_5M_MIN_FVVO < -10 || CFG.REENTRY_POST_PULLBACK_5M_MIN_SLOPE < -10) problems.push("INVALID_REENTRY_POST_PULLBACK_5M_ALIGNMENT_CONFIG");
  if (CFG.REENTRY_PULLBACK_MIN_PCT <= 0 || CFG.REENTRY_PULLBACK_MAX_PCT < CFG.REENTRY_PULLBACK_MIN_PCT) problems.push("INVALID_REENTRY_PULLBACK_RANGE");
  if (CFG.REENTRY_MAX_BELOW_EMA18_PCT < 0 || CFG.REENTRY_MIN_BOUNCE_FROM_LOW_PCT <= 0 || CFG.REENTRY_PULLBACK_INVALIDATION_HYSTERESIS_PCT < 0 || CFG.REENTRY_PULLBACK_REARM_ABOVE_EMA18_PCT < 0) problems.push("INVALID_REENTRY_RECLAIM_STRUCTURE");
  if (CFG.REENTRY_MIN_RSI <= 0 || CFG.REENTRY_MAX_RSI < CFG.REENTRY_MIN_RSI || CFG.REENTRY_MIN_ADX < 0) problems.push("INVALID_REENTRY_MOMENTUM_RANGE");
  if (CFG.REENTRY_RECLAIM_CONFIRM_OBSERVATIONS < 1) problems.push("INVALID_REENTRY_RECLAIM_CONFIRM_OBSERVATIONS");
  if (CFG.REENTRY_STOP_BUFFER_PCT < 0 || CFG.REENTRY_MIN_STOP_DISTANCE_PCT <= 0 || CFG.REENTRY_MAX_STOP_DISTANCE_PCT < CFG.REENTRY_MIN_STOP_DISTANCE_PCT) problems.push("INVALID_REENTRY_STOP_PROJECTION");
  if (CFG.REENTRY_PRE_RELEASE_OVERRIDE_MIN_RSI <= 0 || CFG.REENTRY_PRE_RELEASE_OVERRIDE_MIN_ADX < 0 || CFG.REENTRY_PRE_RELEASE_OVERRIDE_MIN_SLOPE < 0 || CFG.REENTRY_FAST_RECLAIM_MIN_PRIOR_IMPULSE_PCT <= 0 || CFG.REENTRY_FAST_RECLAIM_OVERRIDE_MAX_RSI < CFG.REENTRY_PRE_RELEASE_OVERRIDE_MIN_RSI) problems.push("INVALID_REENTRY_PRE_RELEASE_OVERRIDE");
  if (!["disabled", "shadow", "live"].includes(CFG.REENTRY_15S_FAST_LAUNCH_MODE) || !["disabled", "shadow", "live"].includes(CFG.REENTRY_15S_EARLY_TURN_MODE)) problems.push("INVALID_REENTRY_15S_LAUNCH_MODE");
  if (CFG.REENTRY_15S_FAST_LAUNCH_MODE === "live" && CFG.REENTRY_15S_EARLY_TURN_MODE === "live") problems.push("ONLY_ONE_REENTRY_15S_LAUNCH_PATH_MAY_BE_LIVE");
  if (CFG.REENTRY_15S_FAST_LAUNCH_MIN_PRIOR_IMPULSE_PCT <= 0 || CFG.REENTRY_15S_FAST_LAUNCH_MIN_PULLBACK_PCT <= 0 || CFG.REENTRY_15S_FAST_LAUNCH_MAX_PULLBACK_PCT < CFG.REENTRY_15S_FAST_LAUNCH_MIN_PULLBACK_PCT || CFG.REENTRY_15S_FAST_LAUNCH_MIN_RSI <= 0 || CFG.REENTRY_15S_FAST_LAUNCH_MAX_RSI < CFG.REENTRY_15S_FAST_LAUNCH_MIN_RSI || CFG.REENTRY_15S_FAST_LAUNCH_MIN_ADX < 0 || CFG.REENTRY_15S_FAST_LAUNCH_MIN_SLOPE < 0) problems.push("INVALID_REENTRY_15S_FAST_LAUNCH_THRESHOLDS");
  if (CFG.REENTRY_15S_EARLY_TURN_MIN_PRIOR_IMPULSE_PCT <= 0 || CFG.REENTRY_15S_EARLY_TURN_MIN_PULLBACK_PCT <= 0 || CFG.REENTRY_15S_EARLY_TURN_MAX_PULLBACK_PCT < CFG.REENTRY_15S_EARLY_TURN_MIN_PULLBACK_PCT || CFG.REENTRY_15S_EARLY_TURN_MIN_RSI <= 0 || CFG.REENTRY_15S_EARLY_TURN_MIN_ADX < 0 || CFG.REENTRY_15S_EARLY_TURN_MIN_SLOPE < 0 || CFG.REENTRY_15S_EARLY_TURN_EMA_CONVERGENCE_TOLERANCE_PCT < 0) problems.push("INVALID_REENTRY_15S_EARLY_TURN_THRESHOLDS");
  if (!['disabled', 'shadow', 'live'].includes(CFG.POST_EXIT_RECOVERED_BASE_MODE)) problems.push("INVALID_POST_EXIT_RECOVERED_BASE_MODE");
  if (CFG.POST_EXIT_RECOVERED_BASE_WINDOW_SEC <= 0 || CFG.POST_EXIT_RECOVERED_BASE_MIN_PRIOR_IMPULSE_PCT <= 0 || CFG.POST_EXIT_RECOVERED_BASE_MIN_RECOVERY_PCT <= 0 || CFG.POST_EXIT_RECOVERED_BASE_MAX_CHASE_FROM_LOW_PCT < CFG.POST_EXIT_RECOVERED_BASE_MIN_RECOVERY_PCT || CFG.POST_EXIT_RECOVERED_BASE_CONFIRM_OBSERVATIONS < 2 || CFG.POST_EXIT_RECOVERED_BASE_MIN_RSI <= 0 || CFG.POST_EXIT_RECOVERED_BASE_MAX_RSI < CFG.POST_EXIT_RECOVERED_BASE_MIN_RSI || CFG.POST_EXIT_RECOVERED_BASE_MIN_ADX < 0 || CFG.POST_EXIT_RECOVERED_BASE_MIN_SLOPE < 0) problems.push("INVALID_POST_EXIT_RECOVERED_BASE_THRESHOLDS");
  if (CFG.POST_EXIT_RECOVERED_BASE_MODE === 'live' && (!CFG.REENTRY_ENABLED || CFG.REENTRY_PHASE !== 'auto' || !CFG.REENTRY_AUTO_FORWARD_ENABLED)) problems.push("POST_EXIT_RECOVERED_BASE_LIVE_REQUIRES_AUTO_REENTRY_FORWARD");
  if (CFG.YELLOW_TP_SHADOW_MIN_MFE_PCT < 0 || CFG.YELLOW_TP_SHADOW_MIN_PNL_PCT < 0) problems.push("INVALID_YELLOW_TP_SHADOW_THRESHOLDS");
  if (CFG.PRICE_ENTRY_DEFAULT_EXPIRY_SEC < CFG.PRICE_ENTRY_MIN_EXPIRY_SEC || CFG.PRICE_ENTRY_MAX_EXPIRY_SEC < CFG.PRICE_ENTRY_MIN_EXPIRY_SEC) problems.push("INVALID_PRICE_ENTRY_EXPIRY_RANGE");
  if (CFG.PRICE_ENTRY_MIN_TRIGGER_DISTANCE_PCT <= 0 || CFG.PRICE_ENTRY_MAX_TRIGGER_DISTANCE_PCT < CFG.PRICE_ENTRY_MIN_TRIGGER_DISTANCE_PCT) problems.push("INVALID_PRICE_ENTRY_TRIGGER_DISTANCE_RANGE");
  if (!["off", "shadow", "live"].includes(CFG.ENTRY_5M_BEAR_GUARD_MODE)) problems.push("INVALID_ENTRY_5M_BEAR_GUARD_MODE");
  if (!["ema8", "ema18"].includes(CFG.ENTRY_5M_BEAR_GUARD_RELEASE_REFERENCE)) problems.push("INVALID_ENTRY_5M_BEAR_GUARD_RELEASE_REFERENCE");
  if (CFG.ENTRY_5M_BEAR_GUARD_MAX_AGE_SEC < 60 || CFG.ENTRY_5M_BEAR_GUARD_RELEASE_STRUCTURE_TOLERANCE_PCT < 0 || CFG.ENTRY_5M_BEAR_GUARD_RELEASE_STRUCTURE_TOLERANCE_PCT > 0.20 || CFG.ENTRY_5M_BEAR_GUARD_RELEASE_CONFIRM_OBSERVATIONS < 1 || CFG.ENTRY_5M_BEAR_GUARD_WAIT_LOG_SEC < 15) problems.push("INVALID_ENTRY_5M_BEAR_GUARD_THRESHOLDS");
  if (!["disabled", "shadow", "live"].includes(CFG.TRAILING_DIP_RECLAIM_MODE)) problems.push("INVALID_TRAILING_DIP_RECLAIM_MODE");
  if (CFG.TRAILING_DIP_RECLAIM_MIN_DROP_PCT <= 0 || CFG.TRAILING_DIP_RECLAIM_RECLAIM_PCT <= 0 || CFG.TRAILING_DIP_RECLAIM_MAX_CHASE_PCT < CFG.TRAILING_DIP_RECLAIM_RECLAIM_PCT || CFG.TRAILING_DIP_RECLAIM_MAX_TRACK_SEC <= 0 || CFG.TRAILING_DIP_RECLAIM_MIN_LOW_ABOVE_STOP_PCT < 0) problems.push("INVALID_TRAILING_DIP_RECLAIM_THRESHOLDS");
  if (!['disabled', 'shadow', 'live'].includes(CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MODE)) problems.push("INVALID_BREAKOUT_RETEST_RECLAIM_ZONE_MODE");
  if (!["disabled", "shadow", "live"].includes(CFG.CONFIRMED_PULLBACK_RECLAIM_ZONE_MODE)) problems.push("INVALID_CONFIRMED_PULLBACK_RECLAIM_ZONE_MODE");
  if (CFG.CONFIRMED_PULLBACK_MIN_PENETRATION_PCT <= 0 || CFG.CONFIRMED_PULLBACK_MAX_TRACK_SEC <= 0 || CFG.CONFIRMED_PULLBACK_MIN_LOW_ABOVE_STOP_PCT < 0 || CFG.CONFIRMED_PULLBACK_RETEST_TOUCH_ABOVE_PCT < 0 || CFG.CONFIRMED_PULLBACK_RETEST_HOLD_BELOW_PCT < 0 || CFG.CONFIRMED_PULLBACK_MAX_ENTRY_ABOVE_CONFIRM_PCT < 0 || CFG.CONFIRMED_PULLBACK_FAST_CONFIRM_OBSERVATIONS < 1) problems.push("INVALID_CONFIRMED_PULLBACK_THRESHOLDS");
  if (!["disabled", "shadow", "live"].includes(CFG.HYBRID_PULLBACK_FAST_PATH_MODE)) problems.push("INVALID_HYBRID_PULLBACK_FAST_PATH_MODE");
  if (CFG.HYBRID_PULLBACK_MIN_PENETRATION_PCT <= 0 || CFG.HYBRID_PULLBACK_MIN_REBOUND_PCT <= 0 || CFG.HYBRID_PULLBACK_MAX_ENTRY_ABOVE_CONFIRM_PCT <= 0 || CFG.HYBRID_PULLBACK_MIN_LOW_ABOVE_STOP_PCT < 0 || CFG.HYBRID_PULLBACK_MAX_TRACK_SEC <= 0 || CFG.HYBRID_PULLBACK_MIN_SPACING_SEC <= 0 || CFG.HYBRID_PULLBACK_VOTE_MAX_SEC <= 0 || CFG.HYBRID_PULLBACK_PREFERRED_VOTES_REQUIRED > CFG.HYBRID_PULLBACK_PREFERRED_VOTE_COUNT || CFG.HYBRID_PULLBACK_PREFERRED_FINAL_CONSECUTIVE > CFG.HYBRID_PULLBACK_PREFERRED_VOTES_REQUIRED || CFG.HYBRID_PULLBACK_DEEP_VOTES_REQUIRED > CFG.HYBRID_PULLBACK_DEEP_VOTE_COUNT || CFG.HYBRID_PULLBACK_DEEP_FINAL_CONSECUTIVE > CFG.HYBRID_PULLBACK_DEEP_VOTES_REQUIRED || CFG.HYBRID_PULLBACK_PREFERRED_MIN_SPAN_SEC <= 0 || CFG.HYBRID_PULLBACK_DEEP_MIN_SPAN_SEC <= 0) problems.push("INVALID_HYBRID_PULLBACK_THRESHOLDS");
  if (!["cancel", "wait_no_chase"].includes(CFG.BREAKOUT_RETEST_RECLAIM_ZONE_CHASE_POLICY)) problems.push("INVALID_BREAKOUT_RETEST_RECLAIM_ZONE_CHASE_POLICY");
  if (!["disabled", "shadow", "live"].includes(CFG.BREAKOUT_SHALLOW_HOLD_RECLAIM_MODE)) problems.push("INVALID_BREAKOUT_SHALLOW_HOLD_RECLAIM_MODE");
  if (CFG.BREAKOUT_SHALLOW_HOLD_MAX_TRACK_SEC <= 0 || CFG.BREAKOUT_SHALLOW_HOLD_MAX_ABOVE_CONFIRM_PCT < 0 || CFG.BREAKOUT_SHALLOW_HOLD_MIN_PULLBACK_FROM_HIGH_PCT <= 0 || CFG.BREAKOUT_SHALLOW_HOLD_MIN_OBSERVATIONS < 1 || CFG.BREAKOUT_SHALLOW_HOLD_RECLAIM_PCT <= 0 || CFG.BREAKOUT_SHALLOW_HOLD_MAX_ENTRY_ABOVE_CONFIRM_PCT < CFG.BREAKOUT_SHALLOW_HOLD_RECLAIM_PCT || CFG.BREAKOUT_SHALLOW_HOLD_MIN_ADX < 0 || CFG.BREAKOUT_SHALLOW_HOLD_MIN_SLOPE < -10) problems.push("INVALID_BREAKOUT_SHALLOW_HOLD_RECLAIM_THRESHOLDS");
  if (!["disabled", "shadow", "live"].includes(CFG.BREAKOUT_BULL_CONTINUATION_MODE)) problems.push("INVALID_BREAKOUT_BULL_CONTINUATION_MODE");
  if (CFG.BREAKOUT_BULL_CONTINUATION_MAX_TRACK_SEC <= 0 || CFG.BREAKOUT_BULL_CONTINUATION_MIN_PEAK_EXTENSION_PCT <= 0 || CFG.BREAKOUT_BULL_CONTINUATION_MAX_PEAK_EXTENSION_PCT < CFG.BREAKOUT_BULL_CONTINUATION_MIN_PEAK_EXTENSION_PCT || CFG.BREAKOUT_BULL_CONTINUATION_MIN_PULLBACK_FROM_HIGH_PCT <= 0 || CFG.BREAKOUT_BULL_CONTINUATION_MIN_OBSERVATIONS < 2 || CFG.BREAKOUT_BULL_CONTINUATION_RECLAIM_PCT <= 0 || CFG.BREAKOUT_BULL_CONTINUATION_MAX_ENTRY_ABOVE_CONFIRM_PCT < CFG.BREAKOUT_BULL_CONTINUATION_RECLAIM_PCT || CFG.BREAKOUT_BULL_CONTINUATION_MIN_ADX < 0 || CFG.BREAKOUT_BULL_CONTINUATION_MAX_RSI <= 0 || CFG.BREAKOUT_BULL_CONTINUATION_MAX_EXTENSION_FROM_EMA8_PCT <= 0 || CFG.BREAKOUT_BULL_CONTINUATION_STOP_DISTANCE_CAP_PCT <= 0) problems.push("INVALID_BREAKOUT_BULL_CONTINUATION_THRESHOLDS");
  if (CFG.BREAKOUT_RETEST_RECLAIM_ZONE_RECLAIM_PCT <= 0 || CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MAX_ENTRY_ABOVE_HIGH_PCT < CFG.BREAKOUT_RETEST_RECLAIM_ZONE_RECLAIM_PCT || CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_RETEST_PENETRATION_PCT < 0 || CFG.BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRM_BUFFER_PCT < 0 || CFG.BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRM_OBSERVATIONS < 1 || CFG.BREAKOUT_RETEST_RECLAIM_ZONE_FAIL_BELOW_LOW_BUFFER_PCT < 0 || CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MAX_TRACK_SEC <= 0 || CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_LOW_ABOVE_STOP_PCT < 0 || CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_TICK_SLOPE < -10) problems.push("INVALID_BREAKOUT_RETEST_RECLAIM_ZONE_THRESHOLDS");
  if (CFG.BREAKOUT_RETEST_ADAPTIVE_HOLD_TOLERANCE_PCT < 0 || CFG.BREAKOUT_RETEST_ADAPTIVE_HOLD_TOLERANCE_PCT > 0.10 || CFG.BREAKOUT_RETEST_ADAPTIVE_HOLD_MAX_SEC <= 0) problems.push("INVALID_BREAKOUT_ADAPTIVE_CONFIRM_THRESHOLDS");
  if (CFG.PRICE_TRIGGER_EXPIRY_WARNING_SEC < 0 || CFG.BREAKOUT_RETEST_POST_EXPIRY_SHADOW_SEC <= 0 || CFG.BREAKOUT_RETEST_POST_EXPIRY_SHADOW_PERFORMANCE_SEC <= 0) problems.push("INVALID_BREAKOUT_EXPIRY_AUDIT_THRESHOLDS");
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

function executionModeValid() { return ["demo", "live"].includes(CFG.EXECUTION_MODE); }
function demoMode() { return CFG.EXECUTION_MODE === "demo"; }
function liveMode() { return CFG.EXECUTION_MODE === "live"; }
function isForwardAllowed() {
  return CFG.ENABLE_HTTP_FORWARD && executionModeValid() && !CFG.SHADOW_ONLY && !CFG.FVVO_EMERGENCY_DISABLE_ALL_FORWARDS;
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
  const tp1 = oneOf(body, ["tp1_price", "tp1Price"]);
  const tp2 = oneOf(body, ["tp2_price", "tp2Price"]);
  const tp3 = oneOf(body, ["tp3_price", "tp3Price"]);
  if (!stop.present || !Number.isFinite(stop.value)) return { ok: false, error: "STOP_PRICE_REQUIRED" };
  if (!validStep(stop.value)) return { ok: false, error: "STOP_PRICE_NOT_ALIGNED_TO_MANUAL_ONE_STOP_PRICE_STEP" };
  if (stop.value >= entryPrice) return { ok: false, error: "STOP_PRICE_MUST_BE_BELOW_ENTRY_REFERENCE" };
  const stopPct = percentageBelow(entryPrice, stop.value);
  if (stopPct < CFG.MANUAL_ONE_STOP_MIN_STOP_DISTANCE_PCT - 1e-9) return { ok: false, error: "STOP_DISTANCE_BELOW_MANUAL_ONE_STOP_MIN_STOP_DISTANCE_PCT", minStopDistancePct: CFG.MANUAL_ONE_STOP_MIN_STOP_DISTANCE_PCT, stopDistancePct: round(stopPct, 6) };
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

  const anyIntelligentTp = tp1.present || tp2.present || tp3.present;
  if (anyIntelligentTp && targetPrice > 0) return { ok: false, error: "FIXED_PROFIT_TARGET_AND_INTELLIGENT_TP_LADDER_ARE_MUTUALLY_EXCLUSIVE" };
  let intelligentTp = null;
  if (anyIntelligentTp) {
    if (![tp1, tp2, tp3].every((item) => item.present && Number.isFinite(item.value))) return { ok: false, error: "TP1_TP2_TP3_ALL_REQUIRED" };
    if (![tp1.value, tp2.value, tp3.value].every(validStep)) return { ok: false, error: "INTELLIGENT_TP_PRICE_NOT_ALIGNED_TO_MANUAL_ONE_STOP_PRICE_STEP" };
    if (!(entryPrice < tp1.value && tp1.value < tp2.value && tp2.value < tp3.value)) return { ok: false, error: "INTELLIGENT_TP_ORDER_MUST_BE_ENTRY_LT_TP1_LT_TP2_LT_TP3" };
    if (percentPnl(entryPrice, tp3.value) > CFG.INTELLIGENT_TP_MAX_DISTANCE_PCT + 1e-9) return { ok: false, error: "INTELLIGENT_TP3_DISTANCE_EXCEEDS_MAX" };
    intelligentTp = { tp1Price: round(tp1.value, 8), tp2Price: round(tp2.value, 8), tp3Price: round(tp3.value, 8) };
  }

  return { ok: true, stopPrice: round(stop.value, 8), stopPct: round(stopPct, 6), profitTargetPrice: round(targetPrice, 8), profitTargetPct: round(targetPct, 6), intelligentTp };
}

function normalizeFeature(payload) {
  const kind = String(payload.event || payload.intent || payload.src || "").trim();
  const price = firstFinite(payload.price, payload.close, payload.last, payload.markPrice);
  return {
    kind,
    event: kind,
    price,
    open: firstFinite(payload.open),
    high: firstFinite(payload.high),
    low: firstFinite(payload.low),
    close: firstFinite(payload.close, price),
    ema8: firstFinite(payload.ema8, payload.ema_8),
    ema18: firstFinite(payload.ema18, payload.ema_18),
    ema50: firstFinite(payload.ema50, payload.ema_50),
    atrPct: firstFinite(payload.atrPct, payload.atr_pct),
    barConfirmed: payload.barConfirmed === undefined ? null : Boolean(payload.barConfirmed),
    fvvo: firstFinite(payload.fvvo, payload.fvvoValue, payload.fluxOscillator),
    slope: firstFinite(payload.slope, payload.fvvoSlope),
    rsi: firstFinite(payload.rsi, payload.rsiValue),
    adx: firstFinite(payload.adx, payload.adxValue),
    crossUp: Boolean(payload.crossUp ?? payload.fvvoCrossUp),
    crossDown: Boolean(payload.crossDown ?? payload.fvvoCrossDown),
    redPulse: Boolean(payload.redPulse ?? payload.fvvoRedPulse),
    yellowPulse: Boolean(payload.yellowPulse ?? payload.fvvoYellowPulse ?? payload.yellowDot ?? payload.fvvoYellowDot),
    yellowReason: String(payload.yellowReason || payload.fvvoYellowReason || ""),
    rayRegime: String(payload.rayRegime || payload.tickRayRegime || "RAY_NEUTRAL"),
    publisherKind: payload.publisherKind || null,
    chartTimeframe: payload.chartTimeframe || payload.tf || null,
    barTimeMs: firstFinite(payload.barTimeMs, payload.time, nowMs()),
    receivedAt: nowIso(),
    receivedAtMs: nowMs(),
  };
}

function featureTimeGuard(feature) {
  if (!CFG.FEATURE_MONOTONIC_GUARD_ENABLED) return { ok: true };
  const family = String(feature.kind || "UNKNOWN");
  const currentBarTime = finite(feature.barTimeMs, null);
  if (currentBarTime === null) return { ok: true };
  state.audit = state.audit && typeof state.audit === "object" ? state.audit : { runnerRescuePostExit: null, profitFloorMicroShadow: null, profitFloorPostExitReclaimShadow: null, lastBarTimeByKind: {} };
  state.audit.lastBarTimeByKind = state.audit.lastBarTimeByKind && typeof state.audit.lastBarTimeByKind === "object" ? state.audit.lastBarTimeByKind : {};
  const prior = finite(state.audit.lastBarTimeByKind[family], null);
  if (prior !== null && currentBarTime < prior) return { ok: false, reason: "OLDER_BAR_TIME", family, currentBarTime, priorBarTime: prior };
  if (CFG.FEATURE_DUPLICATE_BAR_GUARD_ENABLED && prior !== null && currentBarTime === prior) return { ok: false, reason: "DUPLICATE_BAR_TIME", family, currentBarTime, priorBarTime: prior };
  state.audit.lastBarTimeByKind[family] = currentBarTime;
  return { ok: true };
}

function updateFeature(feature) {
  if (!Number.isFinite(feature.price) || feature.price <= 0) return false;
  if (feature.kind === CFG.FVVO_FEATURE_TICK_EVENT) state.lastFeature = feature;
  else if (feature.kind === CFG.FVVO_FEATURE_5M_EVENT) state.lastFeature5m = feature;
  else if (feature.kind === CFG.FVVO_FAST_TICK_EVENT) state.lastFastTick = feature;
  else return false;
  return true;
}

function buildIntelligentTpState(levels) {
  const ladder = levels?.intelligentTp;
  if (!ladder) return null;
  return {
    mode: CFG.INTELLIGENT_TP_MODE, enabled: CFG.INTELLIGENT_TP_MODE !== "disabled",
    tp1Price: ladder.tp1Price, tp2Price: ladder.tp2Price, tp3Price: ladder.tp3Price,
    currentIndex: 0, highestConfirmedIndex: -1, phase: "WATCH_TARGET",
    touchedAtMs: 0, touchedAt: null, breakoutObservations: 0, rejectionObservations: 0,
    protectedFloorPrice: null, protectedByTarget: null, floorObservations: 0,
    costAwareFloorPrice: null, peakTrailActive: false, peakTrailPeakPrice: null, peakTrailFloorPrice: null,
    nearMissActive: false, nearMissPeakPrice: null, nearMissFloorPrice: null,
    runnerActive: false, runnerStartedAtMs: 0, runnerPeakPrice: null, runnerFloorPrice: null,
    shadowExitCandidate: null, history: [],
  };
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
    actualEntryFillPrice: null,
    actualEntryFillConfirmedAt: null,
    actualEntryFillSource: null,
    actualEntryDealId: null,
    exchangeFillVerified: false,
    openedAt: nowIso(),
    openedAtMs: nowMs(),
    entryAcceptedAt: null,
    entryAcceptedAtMs: 0,
    stopPrice: levels.stopPrice,
    stopPct: levels.stopPct,
    profitTargetPrice: levels.profitTargetPrice,
    profitTargetPct: levels.profitTargetPct,
    intelligentTp: buildIntelligentTpState(levels),
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
    maxAdverseExcursionPct: 0,
    swingExit: normalizeSwingExitState(null),
    exitRequestedAt: null,
    exitReason: null,
  };
}

function c3NumberString(value) {
  const parsed = finite(value, null);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return String(round(parsed, CFG.C3_TRIGGER_PRICE_DECIMALS));
}

function c3MarketFromConfiguredSymbol(symbol = CFG.SYMBOL) {
  const raw = String(symbol || "").trim().toUpperCase();
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator >= raw.length - 1) {
    throw new Error("C3_SYMBOL_FORMAT_INVALID");
  }

  const tvExchange = raw.slice(0, separator).trim();
  const tvInstrument = raw.slice(separator + 1).trim();

  if (!tvExchange || !tvInstrument) {
    throw new Error("C3_SYMBOL_FORMAT_INVALID");
  }

  return { tvExchange, tvInstrument };
}

function buildC3Signal(action, price, options = {}, current = nowMs()) {
  const trigger = c3NumberString(price);
  if (!trigger) throw new Error("C3_TRIGGER_PRICE_INVALID");

  const market = c3MarketFromConfiguredSymbol(CFG.SYMBOL);

  const body = {
    secret: CFG.C3_SIGNAL_SECRET,
    max_lag: String(Math.floor(CFG.C3_MAX_LAG_SEC)),
    timestamp: new Date(current).toISOString(),
    trigger_price: trigger,
    tv_exchange: market.tvExchange,
    tv_instrument: market.tvInstrument,
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


function reentryAutoEnabled() {
  return CFG.REENTRY_ENABLED && CFG.REENTRY_PHASE === "auto" && CFG.REENTRY_AUTO_FORWARD_ENABLED && executionModeValid();
}

function autoExitReconciliationActive() {
  return CFG.AUTO_EXIT_RECONCILIATION_ENABLED && executionModeValid();
}

function autoExitReleaseStatusPayload() {
  const a = state.autoExitRelease || {};
  return {
    enabled: autoExitReconciliationActive(),
    delaySec: CFG.AUTO_EXIT_RECONCILIATION_DELAY_SEC,
    active: Boolean(a.active),
    status: a.status || "IDLE",
    releaseAt: a.releaseAt || null,
    reason: a.reason || null,
    requestId: a.requestId || null,
    releasedAt: a.releasedAt || null,
    reentryPullbackMemory: a.reentryPullbackMemory ? {
      eligible: Boolean(a.reentryPullbackMemory.eligible),
      invalidated: Boolean(a.reentryPullbackMemory.invalidated),
      priorPeakPrice: a.reentryPullbackMemory.priorPeakPrice || null,
      pullbackLowPrice: a.reentryPullbackMemory.pullbackLowPrice || null,
      pullbackDepthPct: a.reentryPullbackMemory.pullbackDepthPct || 0,
      reason: a.reentryPullbackMemory.reason || null,
    } : null,
  };
}

function clearAutoExitReleaseTimer() {
  if (autoExitReleaseTimer) clearTimeout(autoExitReleaseTimer);
  autoExitReleaseTimer = null;
}

function armAutoExitRelease(position, requestId, reason) {
  if (!autoExitReconciliationActive()) return null;
  const current = nowMs();
  const releaseAtMs = current + CFG.AUTO_EXIT_RECONCILIATION_DELAY_SEC * 1000;
  state.autoExitRelease = {
    active: true,
    status: "PENDING_ASSUMED_FLAT_RELEASE",
    positionOpenedAtMs: finite(position?.openedAtMs, 0),
    releaseAtMs,
    armedAt: nowIso(),
    releaseAt: new Date(releaseAtMs).toISOString(),
    requestId: requestId || "",
    reason: reason || "",
    releasedAt: "",
  };
  log("INFO", "FVVO_EXIT_AUTO_RELEASE_ARMED", { requestId: requestId || null, reason, delaySec: CFG.AUTO_EXIT_RECONCILIATION_DELAY_SEC, releaseAt: state.autoExitRelease.releaseAt, executionMode: CFG.EXECUTION_MODE, demoOnly: demoMode(), reentryAutoEnabled: reentryAutoEnabled(), preReleasePullbackMemoryEnabled: CFG.REENTRY_PRE_RELEASE_MEMORY_ENABLED });
  return state.autoExitRelease;
}

function buildPreReleasePullbackMemory(position) {
  const peakPnlPct = Math.max(finite(position?.peakPnlPct, 0), finite(position?.dynamicProfit?.peakPnlPct, 0));
  const entry = finite(position?.entryPriceReference, 0);
  const peak = Math.max(finite(position?.dynamicProfit?.peakPrice, 0), entry * (1 + peakPnlPct / 100), finite(position?.latestPrice, 0));
  return {
    enabled: CFG.REENTRY_PRE_RELEASE_MEMORY_ENABLED,
    eligible: false,
    invalidated: false,
    reason: "WAIT_VALID_PULLBACK",
    priorPeakPrice: round(peak, 8),
    pullbackLowPrice: null,
    pullbackDepthPct: 0,
    belowEma18Pct: 0,
    capturedAtMs: 0,
    capturedAt: null,
    crossUpSeen: false,
  };
}

async function capturePreReleaseReentryPullback(feature) {
  if (!CFG.REENTRY_PRE_RELEASE_MEMORY_ENABLED || feature.kind !== CFG.FVVO_FEATURE_TICK_EVENT || !Number.isFinite(feature.price) || feature.price <= 0) return false;
  const pending = state.autoExitRelease;
  const prior = state.position;
  if (!pending?.active || !prior || !String(prior.lifecycle || "").startsWith("EXIT_ACCEPTED_AUTO_RELEASE")) return false;
  const memory = pending.reentryPullbackMemory || buildPreReleasePullbackMemory(prior);
  pending.reentryPullbackMemory = memory;
  const peak = finite(memory.priorPeakPrice, 0);
  if (!(peak > 0)) return false;
  const price = feature.price;
  const depth = percentageBelow(peak, price);
  const ema18 = finite(feature.ema18, null);
  const belowEma18Pct = ema18 !== null && price < ema18 ? percentageBelow(ema18, price) : 0;
  if (memory.pullbackLowPrice === null || price < memory.pullbackLowPrice - 1e-9) {
    memory.pullbackLowPrice = round(price, 8);
    memory.pullbackDepthPct = round(depth, 6);
    memory.belowEma18Pct = round(belowEma18Pct, 6);
    memory.capturedAtMs = feature.receivedAtMs;
    memory.capturedAt = feature.receivedAt;
    if (depth >= CFG.REENTRY_PULLBACK_MIN_PCT && depth <= CFG.REENTRY_PULLBACK_MAX_PCT && belowEma18Pct <= CFG.REENTRY_MAX_BELOW_EMA18_PCT) {
      memory.eligible = true;
      memory.invalidated = false;
      memory.reason = "HEALTHY_PULLBACK_DURING_AUTO_RELEASE";
      log("INFO", "FVVO_REENTRY_PRE_RELEASE_PULLBACK_CAPTURED", { priorPeakPrice: memory.priorPeakPrice, pullbackLowPrice: memory.pullbackLowPrice, pullbackDepthPct: memory.pullbackDepthPct, belowEma18Pct: memory.belowEma18Pct, releaseAt: pending.releaseAt || null });
    } else if (depth > CFG.REENTRY_PULLBACK_MAX_PCT || belowEma18Pct > CFG.REENTRY_MAX_BELOW_EMA18_PCT) {
      memory.eligible = false;
      memory.invalidated = true;
      memory.reason = "PRE_RELEASE_PULLBACK_INVALIDATED";
      log("WARN", "FVVO_REENTRY_PRE_RELEASE_PULLBACK_INVALIDATED", { priorPeakPrice: memory.priorPeakPrice, pullbackLowPrice: memory.pullbackLowPrice, pullbackDepthPct: memory.pullbackDepthPct, belowEma18Pct: memory.belowEma18Pct, maxPullbackPct: CFG.REENTRY_PULLBACK_MAX_PCT, maxBelowEma18Pct: CFG.REENTRY_MAX_BELOW_EMA18_PCT });
    }
    await persistState("reentry_pre_release_pullback_memory");
    return true;
  }
  return false;
}

async function finalizeAutoExitRelease(source = "timer") {
  const pending = state.autoExitRelease;
  if (!autoExitReconciliationActive() || !pending?.active) return false;
  const remainingMs = finite(pending.releaseAtMs, 0) - nowMs();
  if (remainingMs > 0) {
    scheduleAutoExitRelease();
    return false;
  }
  const prior = state.position;
  if (!prior || !String(prior.lifecycle || "").startsWith("EXIT_ACCEPTED_AUTO_RELEASE")) {
    state.autoExitRelease = { ...pending, active: false, status: "CANCELLED_NO_MATCHING_EXIT", releasedAt: nowIso() };
    await persistState("auto_exit_release_cancelled_no_position");
    log("WARN", "FVVO_EXIT_AUTO_RELEASE_CANCELLED", { source, reason: "NO_MATCHING_EXIT_POSITION", requestId: pending.requestId || null });
    return false;
  }
  state.position = null;
  state.externalDealLock = { active: false, source: "", setAt: "", reason: "" };
  const deepFallback = reactivateDormantDeepFallback(prior, source);
  const campaign = deepFallback ? null : armReentryCampaignAfterConfirmedExit(prior);
  state.manual = { ...state.manual, recoveryRequired: false, recoveryReason: "", lastAction: "auto_exit_release", lastActionAt: nowIso() };
  state.autoExitRelease = { ...pending, active: false, status: "RELEASED_ASSUMED_FLAT", releasedAt: nowIso() };
  clearAutoExitReleaseTimer();
  await persistState("auto_exit_release_assumed_flat");
  log("INFO", "FVVO_EXIT_AUTO_RECONCILED_ASSUMED_FLAT", { source, priorExitReason: prior.exitReason, requestId: pending.requestId || null, delaySec: CFG.AUTO_EXIT_RECONCILIATION_DELAY_SEC, dormantDeepFallbackReactivated: Boolean(deepFallback), reentryCampaignArmed: Boolean(campaign?.active), reentryCampaignReason: campaign?.reason || null, reentryAutoEnabled: reentryAutoEnabled() });
  return true;
}

function scheduleAutoExitRelease() {
  clearAutoExitReleaseTimer();
  const pending = state.autoExitRelease;
  if (!autoExitReconciliationActive() || !pending?.active) return;
  if (Number.isFinite(testNowMs)) return;
  const waitMs = Math.max(0, finite(pending.releaseAtMs, nowMs()) - nowMs());
  autoExitReleaseTimer = setTimeout(() => {
    finalizeAutoExitRelease("timer").catch((error) => log("ERROR", "FVVO_EXIT_AUTO_RELEASE_FAILED", { error: error.message }));
  }, Math.min(waitMs + 20, 2147483647));
}

function stateBlocksNewEntry() {
  if (CFG.FVVO_EMERGENCY_DISABLE_NEW_ENTRIES) return "EMERGENCY_NEW_ENTRIES_DISABLED";
  const pendingConfirmation = state.manual?.entryConfirmation;
  if (pendingConfirmation && finite(pendingConfirmation.expiresAtMs, 0) > nowMs()) return "MANUAL_ENTRY_CONFIRMATION_PENDING";
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
    executionMode: CFG.EXECUTION_MODE,
    demoOnly: demoMode(),
    automaticEntriesEnabled: reentryAutoEnabled(),
    reentryAutomaticOrdersEnabled: reentryAutoEnabled(),
    entryProfileAllowed: PROFILE,
    manualEntryOverheatConfirmation: { enabled: CFG.MANUAL_ENTRY_OVERHEAT_CONFIRMATION_ENABLED, allowConfirmEntry: CFG.MANUAL_ALLOW_CONFIRM_ENTRY, expirySec: CFG.MANUAL_ENTRY_OVERHEAT_CONFIRM_EXPIRY_SEC, maxPriceDeviationPct: CFG.MANUAL_ENTRY_OVERHEAT_CONFIRM_MAX_PRICE_DEVIATION_PCT, minSignals: CFG.MANUAL_ENTRY_OVERHEAT_MIN_SIGNALS, thresholds: { minRsi: CFG.MANUAL_ENTRY_OVERHEAT_MIN_RSI, minAdx: CFG.MANUAL_ENTRY_OVERHEAT_MIN_ADX, minFvvo: CFG.MANUAL_ENTRY_OVERHEAT_MIN_FVVO, maxAboveEma8Pct: CFG.MANUAL_ENTRY_OVERHEAT_MAX_ABOVE_EMA8_PCT, maxAboveEma18Pct: CFG.MANUAL_ENTRY_OVERHEAT_MAX_ABOVE_EMA18_PCT }, pending: manualEntryConfirmationPublicPayload() },
    oneStopContract: {
      commandStopField: "stop_price",
      optionalTargetField: "profit_target_price",
      stopExitPercent: 100,
      targetExitPercent: 100,
      minStopDistancePct: CFG.MANUAL_ONE_STOP_MIN_STOP_DISTANCE_PCT,
      maxStopDistancePct: CFG.MANUAL_ONE_STOP_MAX_STOP_DISTANCE_PCT,
      maxTargetDistancePct: CFG.MANUAL_ONE_STOP_MAX_TARGET_DISTANCE_PCT,
      nativeStopAttachedToEntry: CFG.C3_NATIVE_STOP_ENABLED,
      exitOwnership: "BRAIN_ONLY",
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
    profitFloorShadowMonitoring: profitFloorShadowStatusPayload(),
    lossSideThesisFailContract: {
      mode: lossSideThesisFailMode(),
      minLossPct: CFG.LOSS_SIDE_THESIS_FAIL_MIN_LOSS_PCT,
      maxRsi: CFG.LOSS_SIDE_THESIS_FAIL_MAX_RSI,
      minAdx: CFG.LOSS_SIDE_THESIS_FAIL_MIN_ADX,
      maxFvvo: CFG.LOSS_SIDE_THESIS_FAIL_MAX_FVVO,
      maxSlope: CFG.LOSS_SIDE_THESIS_FAIL_MAX_SLOPE,
      confirmObservations: CFG.LOSS_SIDE_THESIS_FAIL_CONFIRM_OBSERVATIONS,
      requireRayBear: CFG.LOSS_SIDE_THESIS_FAIL_REQUIRE_RAY_BEAR,
      requireBelowEma8AndEma18: CFG.LOSS_SIDE_THESIS_FAIL_REQUIRE_BELOW_EMA8_AND_EMA18,
      exitsOnlyBeforeDynamicProfitArmed: true,
    },
    swingStructureExitContract: {
      mode: swingStructureExitMode(),
      minMfePct: CFG.SWING_STRUCTURE_MIN_MFE_PCT,
      minCurrentPnlPct: CFG.SWING_STRUCTURE_MIN_CURRENT_PNL_PCT,
      ema18BreakTolerancePct: CFG.SWING_STRUCTURE_EMA18_BREAK_TOLERANCE_PCT,
      confirm5mObservations: CFG.SWING_STRUCTURE_CONFIRM_5M_OBSERVATIONS,
      minDeteriorationSignals: CFG.SWING_STRUCTURE_MIN_DETERIORATION_SIGNALS,
      emergencyBreakPct: CFG.SWING_STRUCTURE_EMERGENCY_BREAK_PCT,
      emergency5mDetectorObservations: CFG.SWING_STRUCTURE_EMERGENCY_CONFIRM_5M_OBSERVATIONS,
      fastEmergency: {
        mode: CFG.SWING_EMERGENCY_FAST_CONFIRM_MODE,
        maxSec: CFG.SWING_EMERGENCY_FAST_CONFIRM_MAX_SEC,
        microWindowTicks: CFG.SWING_EMERGENCY_MICRO_WINDOW_TICKS,
        requiredBelowTicks: CFG.SWING_EMERGENCY_MICRO_REQUIRED_BELOW_TICKS,
        confirmObservations: CFG.SWING_EMERGENCY_MICRO_CONFIRM_OBSERVATIONS,
        minAverageDeclinePct: CFG.SWING_EMERGENCY_MICRO_MIN_AVG_DECLINE_PCT,
        minBearSignals: CFG.SWING_EMERGENCY_MICRO_MIN_BEAR_SIGNALS,
        momentumRecoveryVeto: CFG.SWING_EMERGENCY_MICRO_MOMENTUM_RECOVERY_VETO,
        hardBreakBufferPct: CFG.SWING_EMERGENCY_HARD_BREAK_BUFFER_PCT,
        hardExitPnlPct: CFG.SWING_EMERGENCY_HARD_EXIT_PNL_PCT,
        recoveryReclaimBufferPct: CFG.SWING_EMERGENCY_RECOVERY_RECLAIM_BUFFER_PCT,
        recoveryConfirmObservations: CFG.SWING_EMERGENCY_RECOVERY_CONFIRM_OBSERVATIONS,
        shadowIntelligent1mEnabled: CFG.SWING_EMERGENCY_SHADOW_INTELLIGENT_1M_ENABLED,
        shadowLegacyImmediateEnabled: CFG.SWING_EMERGENCY_SHADOW_LEGACY_IMMEDIATE_ENABLED,
        activeState: state.position ? swingExitState(state.position).fastEmergency : null,
      },
      noProgressCheckAfterSec: CFG.SWING_NO_PROGRESS_CHECK_AFTER_SEC,
      hardMaxHoldSec: CFG.SWING_HARD_MAX_HOLD_SEC,
      exitPercent: 100,
    },
    runnerExitContract: {
      enabled: CFG.RUNNER_EXIT_ENABLED,
      mode: CFG.RUNNER_EXIT_MODE,
      holdMinMfePct: CFG.RUNNER_HOLD_MIN_MFE_PCT,
      tightTrailArmMfePct: CFG.RUNNER_TIGHT_TRAIL_ARM_MFE_PCT,
      tightTrailGivebackPct: CFG.RUNNER_TIGHT_TRAIL_GIVEBACK_PCT,
      tightTrailConfirmObservations: CFG.RUNNER_TIGHT_TRAIL_CONFIRM_OBSERVATIONS,
      automaticEntryOrdersEnabled: false,
    },
    pnlAuditContract: {
      managementBasis: "SIGNAL_REFERENCE",
      actualFillConfirmationAllowed: CFG.MANUAL_ALLOW_CONFIRM_ENTRY_FILL,
      actualFillMaxDeviationPct: CFG.MANUAL_ENTRY_FILL_MAX_DEVIATION_PCT,
      estimatedRoundTripCostPct: CFG.PNL_ESTIMATED_ROUND_TRIP_COST_PCT,
      estimateChangesExitLogic: false,
    },
    c3ExecutionContract: {
      entrySizeSource: CFG.C3_ENTRY_SIZE_SOURCE,
      entryOrderIncludedInWebhook: false,
      requiredBotEntryOrder: "fixed quote amount + Market",
      exitOrderIncludedInWebhook: CFG.C3_EXIT_INCLUDE_POSITION_ORDER,
      exitPercent: 100,
      nativeStopAttachedToEntry: CFG.C3_NATIVE_STOP_ENABLED,
    },
    autoExitReconciliation: autoExitReleaseStatusPayload(),
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
      entryOrigin: state.position.entryOrigin || "MANUAL",
      reentryNumber: state.position.reentryNumber || 0,
      entryPriceReference: state.position.entryPriceReference,
      actualEntryFillPrice: state.position.actualEntryFillPrice || null,
      exchangeFillVerified: Boolean(state.position.exchangeFillVerified),
      pnlAudit: pnlAudit(state.position, finite(state.position.latestPrice, state.position.entryPriceReference)),
      stopPrice: state.position.stopPrice,
      stopPct: state.position.stopPct,
      profitTargetPrice: state.position.profitTargetPrice || null,
      profitTargetPct: state.position.profitTargetPct || 0,
      latestPrice: state.position.latestPrice,
      latestPnlPct: state.position.latestPnlPct,
      peakPnlPct: state.position.peakPnlPct,
      lossSideThesis: state.position.lossSideThesis ? {
        observations: state.position.lossSideThesis.observations || 0,
        lastBreachPrice: state.position.lossSideThesis.lastBreachPrice || null,
        lastReason: state.position.lossSideThesis.lastReason || null,
        shadowLogged: Boolean(state.position.lossSideThesis.shadowLogged),
      } : null,
      dynamicProfit: state.position.dynamicProfit ? {
        armed: Boolean(state.position.dynamicProfit.armed),
        armedAtPnlPct: state.position.dynamicProfit.armedAtPnlPct || 0,
        peakPnlPct: state.position.dynamicProfit.peakPnlPct || 0,
        protectedPnlPct: state.position.dynamicProfit.protectedPnlPct || 0,
        protectedPrice: state.position.dynamicProfit.protectedPrice || null,
        floorObservations: state.position.dynamicProfit.floor?.observations || 0,
        thesisObservations: state.position.dynamicProfit.thesis?.observations || 0,
        lastThesisReason: state.position.dynamicProfit.lastThesisReason || null,
        runner: state.position.dynamicProfit.runner ? {
          holdActive: Boolean(state.position.dynamicProfit.runner.holdActive),
          holdActivatedAtPnlPct: state.position.dynamicProfit.runner.holdActivatedAtPnlPct || 0,
          tightTrailArmed: Boolean(state.position.dynamicProfit.runner.tightTrailArmed),
          tightTrailArmedAtPnlPct: state.position.dynamicProfit.runner.tightTrailArmedAtPnlPct || 0,
          protectedPnlPct: state.position.dynamicProfit.runner.protectedPnlPct || 0,
          protectedPrice: state.position.dynamicProfit.runner.protectedPrice || null,
          floorObservations: state.position.dynamicProfit.runner.floor?.observations || 0,
          suppressedTickThesisCount: state.position.dynamicProfit.runner.suppressedTickThesisCount || 0,
        } : null,
      } : null,
      exitReason: state.position.exitReason,
    } : null,
    externalDealLockActive: Boolean(state.externalDealLock?.active),
    manualState: state.manual,
    runnerContinuationRescuePostExitAudit: state.audit?.runnerRescuePostExit || null,
    reentry: reentryStatusPayload(),
    entryBlockReason: stateBlocksNewEntry() || null,
  };
}


function manualEntryOverheatSignalSnapshot(entryPrice) {
  const f = state.lastFeature || {};
  const ema8 = finite(f.ema8, null), ema18 = finite(f.ema18, null), rsi = finite(f.rsi, null), adx = finite(f.adx, null), fvvo = finite(f.fvvo, null);
  const aboveEma8Pct = ema8 !== null && entryPrice > ema8 ? percentPnl(ema8, entryPrice) : 0;
  const aboveEma18Pct = ema18 !== null && entryPrice > ema18 ? percentPnl(ema18, entryPrice) : 0;
  const signals = [];
  if (rsi !== null && rsi >= CFG.MANUAL_ENTRY_OVERHEAT_MIN_RSI) signals.push({ code: "RSI_HIGH", value: round(rsi, 4), threshold: CFG.MANUAL_ENTRY_OVERHEAT_MIN_RSI });
  if (adx !== null && adx >= CFG.MANUAL_ENTRY_OVERHEAT_MIN_ADX) signals.push({ code: "ADX_HIGH", value: round(adx, 4), threshold: CFG.MANUAL_ENTRY_OVERHEAT_MIN_ADX });
  if (fvvo !== null && fvvo >= CFG.MANUAL_ENTRY_OVERHEAT_MIN_FVVO) signals.push({ code: "FVVO_ELEVATED", value: round(fvvo, 4), threshold: CFG.MANUAL_ENTRY_OVERHEAT_MIN_FVVO });
  if (aboveEma8Pct >= CFG.MANUAL_ENTRY_OVERHEAT_MAX_ABOVE_EMA8_PCT) signals.push({ code: "EXTENDED_ABOVE_EMA8", value: round(aboveEma8Pct, 6), threshold: CFG.MANUAL_ENTRY_OVERHEAT_MAX_ABOVE_EMA8_PCT });
  if (aboveEma18Pct >= CFG.MANUAL_ENTRY_OVERHEAT_MAX_ABOVE_EMA18_PCT) signals.push({ code: "EXTENDED_ABOVE_EMA18", value: round(aboveEma18Pct, 6), threshold: CFG.MANUAL_ENTRY_OVERHEAT_MAX_ABOVE_EMA18_PCT });
  return { triggered: signals.length >= CFG.MANUAL_ENTRY_OVERHEAT_MIN_SIGNALS, signalCount: signals.length, minSignals: CFG.MANUAL_ENTRY_OVERHEAT_MIN_SIGNALS, signals, feature: { price: entryPrice, ema8, ema18, rsi, adx, fvvo, rayRegime: String(f.rayRegime || "RAY_NEUTRAL") } };
}
function manualEntryConfirmationPublicPayload(pending = state.manual?.entryConfirmation) {
  if (!pending) return null;
  const expiresAtMs = finite(pending.expiresAtMs, 0);
  return { id: pending.id, status: expiresAtMs > nowMs() ? "PENDING" : "EXPIRED", createdAt: pending.createdAt, expiresAt: pending.expiresAt, entryPriceReference: pending.entryPriceReference, stopPrice: pending.stopPrice, profitTargetPrice: pending.profitTargetPrice || null, intelligentTp: pending.intelligentTp || null, reason: pending.reason || "", overheat: pending.overheat || null };
}
async function expireManualEntryConfirmationIfNeeded(source = "manual_action") {
  const pending = state.manual?.entryConfirmation;
  if (!pending || finite(pending.expiresAtMs, 0) > nowMs()) return false;
  state.manual = { ...state.manual, entryConfirmation: null, lastAction: "manual_entry_confirmation_expired", lastActionAt: nowIso() };
  await persistState("manual_entry_confirmation_expired");
  log("WARN", "FVVO_MANUAL_ENTRY_OVERHEAT_CONFIRMATION_EXPIRED", { confirmationId: pending.id, source, entryPriceReference: pending.entryPriceReference, expiresAt: pending.expiresAt });
  return true;
}
async function createManualEntryOverheatConfirmation(body, entry, levels, overheat) {
  const createdAtMs = nowMs(), expiresAtMs = createdAtMs + CFG.MANUAL_ENTRY_OVERHEAT_CONFIRM_EXPIRY_SEC * 1000;
  const pending = { id: crypto.randomUUID(), createdAt: nowIso(), createdAtMs, expiresAt: new Date(expiresAtMs).toISOString(), expiresAtMs, entryPriceReference: round(entry, 8), stopPrice: levels.stopPrice, profitTargetPrice: levels.profitTargetPrice || 0, intelligentTp: levels.intelligentTp ? clone(levels.intelligentTp) : null, profile: PROFILE, reason: String(body.reason || "manual_entry_latest_price"), overheat };
  state.manual = { ...state.manual, entryConfirmation: pending, lastAction: "manual_entry_confirmation_required", lastActionAt: nowIso() };
  await persistState("manual_entry_overheat_confirmation_required");
  log("WARN", "FVVO_MANUAL_ENTRY_OVERHEAT_CONFIRMATION_REQUIRED", { confirmationId: pending.id, entryPriceReference: pending.entryPriceReference, stopPrice: pending.stopPrice, profitTargetPrice: pending.profitTargetPrice || null, expiresAt: pending.expiresAt, signalCount: overheat.signalCount, minSignals: overheat.minSignals, signals: overheat.signals, feature: overheat.feature });
  return { status: 202, body: { ok: true, forwarded: false, confirmationRequired: true, confirmation: manualEntryConfirmationPublicPayload(pending), nextAction: "confirm_manual_entry", decisionValues: ["yes", "no"] } };
}
async function executeManualEntry(entry, levels, options = {}) {
  const confirmation = options.confirmation || null;
  for (const item of activePriceEntryItems()) {
    const cancelled = resolvePriceEntryPending("CANCELLED_BY_IMMEDIATE_MANUAL_ENTRY", "IMMEDIATE_MANUAL_ENTRY", {}, item);
    if (cancelled) log("INFO", "FVVO_PRICE_TRIGGER_CANCELLED_BY_IMMEDIATE_MANUAL_ENTRY", { triggerId: cancelled.id, triggerMode: cancelled.triggerMode, triggerPrice: cancelled.triggerPrice });
  }
  if (state.reentry?.campaign) log("INFO", "FVVO_REENTRY_CAMPAIGN_CANCELLED_BY_MANUAL_ENTRY", { campaignId: state.reentry.campaign.id, observedCandidates: state.reentry.campaign.observedCandidates || 0 });
  state.reentry = { campaign: null, recentTickPrices: [] };
  state.position = buildPosition(entry, levels, { entryOrigin: "MANUAL" });
  state.externalDealLock = { active: true, source: "manual_enter", setAt: nowIso(), reason: "ENTRY_REQUEST_PENDING" };
  state.manual = { ...state.manual, entryConfirmation: null, handoffActive: false, recoveryRequired: false, recoveryReason: "", lastAction: confirmation ? "confirm_manual_entry_yes" : "enter_long", lastActionAt: nowIso() };
  if (!(await persistState("manual_enter_pre_forward"))) return { status: 503, body: { ok: false, error: "STATE_PERSISTENCE_FAILED_BEFORE_ENTRY" } };
  log("INFO", "FVVO_TRADE_OPEN_PENDING", { profile: PROFILE, entryPriceReference: entry, stopPrice: levels.stopPrice, profitTargetPrice: levels.profitTargetPrice || null, stopExitPercent: 100, targetExitPercent: 100, entrySizeSource: CFG.C3_ENTRY_SIZE_SOURCE, entryOrderIncludedInWebhook: false, dynamicProfitEnabled: CFG.DYNAMIC_PROFIT_EXIT_ENABLED, dynamicProfitArmMfePct: CFG.DYNAMIC_PROFIT_ARM_MFE_PCT, dynamicProfitMinLockPnlPct: CFG.DYNAMIC_PROFIT_MIN_LOCK_PNL_PCT, overheatConfirmationId: confirmation?.id || null });
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
  log("INFO", "FVVO_MANUAL_ONE_STOP_ENTRY_TRACKED", { entryPriceReference: entry, stopPrice: levels.stopPrice, stopDistancePct: levels.stopPct, profitTargetPrice: levels.profitTargetPrice || null, profitTargetDistancePct: levels.profitTargetPct, entrySizeSource: CFG.C3_ENTRY_SIZE_SOURCE, entryOrderIncludedInWebhook: false, nativeStopSent: CFG.C3_NATIVE_STOP_ENABLED, dynamicProfitEnabled: CFG.DYNAMIC_PROFIT_EXIT_ENABLED, dynamicProfitArmMfePct: CFG.DYNAMIC_PROFIT_ARM_MFE_PCT, requestId: result.requestId, fillVerified: false, overheatConfirmationId: confirmation?.id || null });
  return { status: 200, body: { ok: true, forwarded: true, acceptedBy3CommasWebhook: true, exchangeFillVerified: false, brainWillManageExit: true, manualEntryTracked: true, externalDealLockActive: true, profile: PROFILE, entrySizeSource: CFG.C3_ENTRY_SIZE_SOURCE, entryOrderIncludedInWebhook: false, entrySizeConfiguredInBot: true, entryPriceReference: entry, stopPrice: levels.stopPrice, stopDistancePct: levels.stopPct, profitTargetPrice: levels.profitTargetPrice || null, profitTargetDistancePct: levels.profitTargetPct, dynamicProfitEnabled: CFG.DYNAMIC_PROFIT_EXIT_ENABLED, dynamicProfitArmMfePct: CFG.DYNAMIC_PROFIT_ARM_MFE_PCT, dynamicProfitMinLockPnlPct: CFG.DYNAMIC_PROFIT_MIN_LOCK_PNL_PCT, requestId: result.requestId, overheatConfirmationId: confirmation?.id || null } };
}
async function confirmManualEntry(body) {
  if (!CFG.MANUAL_ALLOW_CONFIRM_ENTRY) return { status: 403, body: { ok: false, error: "MANUAL_CONFIRM_ENTRY_DISABLED" } };
  await expireManualEntryConfirmationIfNeeded("confirm_manual_entry");
  const pending = state.manual?.entryConfirmation;
  if (!pending) return { status: 409, body: { ok: false, error: "NO_MANUAL_ENTRY_CONFIRMATION_PENDING" } };
  if (String(body.confirmation_id || "") !== String(pending.id)) return { status: 409, body: { ok: false, error: "MANUAL_ENTRY_CONFIRMATION_ID_MISMATCH", confirmation: manualEntryConfirmationPublicPayload(pending) } };
  const decision = String(body.decision || "").trim().toLowerCase();
  if (!["yes", "no"].includes(decision)) return { status: 400, body: { ok: false, error: "MANUAL_ENTRY_CONFIRMATION_DECISION_MUST_BE_YES_OR_NO" } };
  if (decision === "no") {
    state.manual = { ...state.manual, entryConfirmation: null, lastAction: "confirm_manual_entry_no", lastActionAt: nowIso() };
    await persistState("manual_entry_confirmation_declined");
    log("INFO", "FVVO_MANUAL_ENTRY_OVERHEAT_CONFIRMATION_DECLINED", { confirmationId: pending.id, entryPriceReference: pending.entryPriceReference, reason: pending.reason || "" });
    return { status: 200, body: { ok: true, forwarded: false, entryNotSent: true, confirmationDeclined: true } };
  }
  if (CFG.MANUAL_REQUIRE_FRESH_FEATURE_TICK && !isFeatureFresh()) return { status: 409, body: { ok: false, error: "FRESH_FEATURE_TICK_REQUIRED", featureAgeSec: ageSec(state.lastFeature) } };
  if (state.position || state.externalDealLock?.active || state.manual?.handoffActive || state.manual?.recoveryRequired) return { status: 409, body: { ok: false, error: stateBlocksNewEntry() || "NEW_ENTRY_BLOCKED" } };
  const entry = finite(state.lastFeature?.price, null);
  if (!entry || entry <= 0) return { status: 409, body: { ok: false, error: "NO_VALID_FRESH_FEATURE_PRICE" } };
  const deviationPct = Math.abs(percentPnl(pending.entryPriceReference, entry));
  if (deviationPct > CFG.MANUAL_ENTRY_OVERHEAT_CONFIRM_MAX_PRICE_DEVIATION_PCT + 1e-9) {
    state.manual = { ...state.manual, entryConfirmation: null, lastAction: "manual_entry_confirmation_price_changed", lastActionAt: nowIso() };
    await persistState("manual_entry_confirmation_price_changed");
    log("WARN", "FVVO_MANUAL_ENTRY_OVERHEAT_CONFIRMATION_PRICE_CHANGED", { confirmationId: pending.id, originalEntryPriceReference: pending.entryPriceReference, currentEntryPriceReference: entry, deviationPct: round(deviationPct, 6), maxDeviationPct: CFG.MANUAL_ENTRY_OVERHEAT_CONFIRM_MAX_PRICE_DEVIATION_PCT });
    return { status: 409, body: { ok: false, error: "MANUAL_ENTRY_CONFIRMATION_PRICE_CHANGED_REARM_REQUIRED", deviationPct: round(deviationPct, 6), maxDeviationPct: CFG.MANUAL_ENTRY_OVERHEAT_CONFIRM_MAX_PRICE_DEVIATION_PCT } };
  }
  const confirmationLevels = { stop_price: pending.stopPrice, profit_target_price: pending.profitTargetPrice || 0 };
  if (pending.intelligentTp) Object.assign(confirmationLevels, { tp1_price: pending.intelligentTp.tp1Price, tp2_price: pending.intelligentTp.tp2Price, tp3_price: pending.intelligentTp.tp3Price });
  const levels = validateOneStopCommand(confirmationLevels, entry);
  if (!levels.ok) return { status: 409, body: { ok: false, error: `MANUAL_ENTRY_CONFIRMATION_LEVELS_INVALID_${levels.error}` } };
  return executeManualEntry(entry, levels, { confirmation: pending });
}
async function cancelManualEntryConfirmation(body) {
  const pending = state.manual?.entryConfirmation;
  if (!pending) return { status: 200, body: { ok: true, confirmationCancelled: false, reason: "NO_PENDING_CONFIRMATION" } };
  state.manual = { ...state.manual, entryConfirmation: null, lastAction: "cancel_manual_entry_confirmation", lastActionAt: nowIso() };
  await persistState("manual_entry_confirmation_cancelled");
  log("INFO", "FVVO_MANUAL_ENTRY_OVERHEAT_CONFIRMATION_CANCELLED", { confirmationId: pending.id, reason: body.reason || "" });
  return { status: 200, body: { ok: true, confirmationCancelled: true } };
}

async function beginManualEnter(body) {
  const issue = configProblems()[0];
  if (issue) return { status: 503, body: { ok: false, error: issue } };
  if (!CFG.MANUAL_ALLOW_ENTER) return { status: 403, body: { ok: false, error: "MANUAL_ENTER_DISABLED" } };
  if (!CFG.MANUAL_ONE_STOP_PROFILE_ENABLED) return { status: 403, body: { ok: false, error: "MANUAL_ONE_STOP_PROFILE_DISABLED" } };
  if (String(body.profile || CFG.MANUAL_ENTRY_DEFAULT_PROFILE).trim().toUpperCase() !== PROFILE) return { status: 400, body: { ok: false, error: "ONLY_SWING_BALANCED_STRUCTURE_EXIT_PROFILE_ALLOWED" } };
  if (["price", "entry_price", "entryPrice"].some((key) => Object.prototype.hasOwnProperty.call(body, key))) return { status: 400, body: { ok: false, error: "MANUAL_ENTRY_PRICE_FIELD_NOT_ALLOWED_USE_LATEST_FEATURE_PRICE" } };
  await expireManualEntryConfirmationIfNeeded("enter_long");
  const block = stateBlocksNewEntry();
  if (block) return { status: 409, body: { ok: false, error: block, status: statusPayload() } };
  if (CFG.MANUAL_REQUIRE_FRESH_FEATURE_TICK && !isFeatureFresh()) return { status: 409, body: { ok: false, error: "FRESH_FEATURE_TICK_REQUIRED", featureAgeSec: ageSec(state.lastFeature) } };
  const entry = finite(state.lastFeature?.price, null);
  if (!entry || entry <= 0) return { status: 409, body: { ok: false, error: "NO_VALID_FRESH_FEATURE_PRICE" } };
  const levels = validateOneStopCommand(body, entry);
  if (!levels.ok) return { status: 400, body: { ok: false, error: levels.error } };
  const overheat = manualEntryOverheatSignalSnapshot(entry);
  if (CFG.MANUAL_ENTRY_OVERHEAT_CONFIRMATION_ENABLED && overheat.triggered) return createManualEntryOverheatConfirmation(body, entry, levels, overheat);
  return executeManualEntry(entry, levels, {});
}
async function confirmEntryFill(body) {
  if (!CFG.MANUAL_ALLOW_CONFIRM_ENTRY_FILL) return { status: 403, body: { ok: false, error: "MANUAL_CONFIRM_ENTRY_FILL_DISABLED" } };
  const p = state.position;
  if (!p) return { status: 409, body: { ok: false, error: "NO_MANAGED_POSITION" } };
  if (String(p.lifecycle || "").startsWith("EXIT_")) return { status: 409, body: { ok: false, error: "POSITION_EXIT_ALREADY_REQUESTED" } };
  const fillPrice = firstFinite(body.actual_entry_fill_price, body.fill_price, body.actualEntryFillPrice);
  if (!(fillPrice > 0)) return { status: 400, body: { ok: false, error: "VALID_ACTUAL_ENTRY_FILL_PRICE_REQUIRED" } };
  const deviationPct = Math.abs(percentPnl(p.entryPriceReference, fillPrice));
  if (deviationPct > CFG.MANUAL_ENTRY_FILL_MAX_DEVIATION_PCT + 1e-9) return { status: 400, body: { ok: false, error: "ACTUAL_ENTRY_FILL_DEVIATION_TOO_LARGE", deviationPct: round(deviationPct, 6), maxDeviationPct: CFG.MANUAL_ENTRY_FILL_MAX_DEVIATION_PCT } };
  p.actualEntryFillPrice = round(fillPrice, 8);
  p.actualEntryFillConfirmedAt = nowIso();
  p.actualEntryFillSource = String(body.source || "MANUAL_3COMMAS_AUDIT").slice(0, 80);
  p.actualEntryDealId = body.deal_id === undefined || body.deal_id === null ? null : String(body.deal_id).slice(0, 80);
  p.exchangeFillVerified = true;
  await persistState("actual_entry_fill_confirmed");
  const audit = pnlAudit(p, finite(p.latestPrice, p.entryPriceReference));
  log("INFO", "FVVO_ENTRY_FILL_CONFIRMED", { signalEntryPriceReference: p.entryPriceReference, actualEntryFillPrice: p.actualEntryFillPrice, deviationPct: round(deviationPct, 6), source: p.actualEntryFillSource, dealId: p.actualEntryDealId, managementBasisUnchanged: "SIGNAL_REFERENCE", pnlAudit: audit });
  return { status: 200, body: { ok: true, fillConfirmed: true, managementBasisUnchanged: "SIGNAL_REFERENCE", pnlAudit: audit, status: statusPayload() } };
}

async function requestFullExit(reason, price, origin) {
  const p = state.position;
  if (!p) return { ok: false, error: "NO_MANAGED_POSITION" };
  if (state.manual.handoffActive) return { ok: false, error: "MANUAL_HANDOFF_ACTIVE" };
  if (String(p.lifecycle || "").startsWith("EXIT_")) return { ok: false, error: "EXIT_ALREADY_REQUESTED" };

  const exitPnlAudit = pnlAudit(p, price);
  log("WARN", "FVVO_EXIT_DECISION", { reason, origin, price, phase: p.phase, entryPrice: p.entryPriceReference, latestPnlPct: round(p.latestPnlPct, 4), peakPnlPct: round(p.peakPnlPct, 4), stopPrice: p.stopPrice, profitTargetPrice: p.profitTargetPrice || null, exitPercent: 100, pnlAudit: exitPnlAudit });
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

  p.lifecycle = CFG.AUTO_EXIT_RECONCILIATION_ENABLED ? "EXIT_ACCEPTED_AUTO_RELEASE_PENDING" : "EXIT_ACCEPTED_UNVERIFIED_CLOSE";
  p.exitRequestedAt = nowIso();
  p.exitReason = reason;
  p.exitRequestPrice = price;
  p.exitForwardRequestId = result.requestId;
  state.manual.recoveryRequired = !CFG.AUTO_EXIT_RECONCILIATION_ENABLED;
  state.manual.recoveryReason = CFG.AUTO_EXIT_RECONCILIATION_ENABLED ? "" : "EXIT_ACCEPTED_UNVERIFIED_CLOSE";
  state.externalDealLock = { active: true, source: "brain_full_exit", setAt: nowIso(), reason: CFG.AUTO_EXIT_RECONCILIATION_ENABLED ? "EXIT_ACCEPTED_AUTO_RELEASE_PENDING" : "EXIT_ACCEPTED_UNVERIFIED_CLOSE" };
  if (CFG.AUTO_EXIT_RECONCILIATION_ENABLED) armAutoExitRelease(p, result.requestId, reason);
  if (String(reason || "").includes("DYNAMIC_PROFIT_FLOOR_HIT")) recordProfitFloorBaselineExit(p, price, reason);
  await persistState("full_exit_accepted");
  if (CFG.AUTO_EXIT_RECONCILIATION_ENABLED) scheduleAutoExitRelease();
  log("INFO", "FVVO_FULL_EXIT_SIGNAL_ACCEPTED_UNVERIFIED", { origin, reason, price, requestId: result.requestId, exchangeCloseVerified: false, autoReleasePending: CFG.AUTO_EXIT_RECONCILIATION_ENABLED, autoReleaseDelaySec: CFG.AUTO_EXIT_RECONCILIATION_ENABLED ? CFG.AUTO_EXIT_RECONCILIATION_DELAY_SEC : null, recoveryRequired: !CFG.AUTO_EXIT_RECONCILIATION_ENABLED, exitPercent: 100, pnlAudit: exitPnlAudit });
  return { ...result, exitUnverified: true, autoReleasePending: CFG.AUTO_EXIT_RECONCILIATION_ENABLED };
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
      runner: {
        holdActive: false, holdActivatedAtMs: 0, holdActivatedAtPnlPct: 0,
        tightTrailArmed: false, tightTrailArmedAtMs: 0, tightTrailArmedAtPnlPct: 0,
        protectedPnlPct: 0, protectedPrice: null, trailPeakPnlPct: 0, lastLoggedProtectedPnlPct: 0,
        floor: { breachAtMs: 0, observations: 0, lastBreachPrice: null },
        suppressedTickThesisCount: 0,
        continuationRescue: { active: false, consumed: false, count: 0, startedAtMs: 0, expiresAtMs: 0, baselineExitPrice: null, baselinePnlPct: 0, baselineProtectedPnlPct: 0, baselineProtectedPrice: null, hardLockPnlPct: 0, hardLockPrice: null, baselineReason: null, context: null, pinkBreakAtMs: 0, pinkBreakObservations: 0, shadowLogged: false },
      },
      lastThesisReason: null,
      dynamicPullbackGrace: { active: false, startedAtMs: 0, expiresAtMs: 0, baselineExitPrice: null, baselinePnlPct: 0, baselineReason: null, context: null, pinkBreakAtMs: 0, pinkBreakObservations: 0, shadowLogged: false },
      reentryContinuationGrace: { active: false, startedAtMs: 0, expiresAtMs: 0, baselineExitPrice: null, baselinePnlPct: 0, baselineReason: null, context: null, shadowLogged: false },
    };
  }
  const d = position.dynamicProfit;
  d.floor = { breachAtMs: 0, observations: 0, lastBreachPrice: null, ...(d.floor || {}) };
  d.thesis = { breachAtMs: 0, observations: 0, lastBreachPrice: null, lastFeatureKind: null, ...(d.thesis || {}) };
  d.runner = {
    holdActive: false, holdActivatedAtMs: 0, holdActivatedAtPnlPct: 0,
    tightTrailArmed: false, tightTrailArmedAtMs: 0, tightTrailArmedAtPnlPct: 0,
    protectedPnlPct: 0, protectedPrice: null, trailPeakPnlPct: 0, lastLoggedProtectedPnlPct: 0,
    floor: { breachAtMs: 0, observations: 0, lastBreachPrice: null },
    suppressedTickThesisCount: 0,
    continuationRescue: { active: false, consumed: false, count: 0, startedAtMs: 0, expiresAtMs: 0, baselineExitPrice: null, baselinePnlPct: 0, baselineProtectedPnlPct: 0, baselineProtectedPrice: null, hardLockPnlPct: 0, hardLockPrice: null, baselineReason: null, context: null, pinkBreakAtMs: 0, pinkBreakObservations: 0, shadowLogged: false },
    ...(d.runner || {}),
  };
  d.runner.floor = { breachAtMs: 0, observations: 0, lastBreachPrice: null, ...(d.runner.floor || {}) };
  d.runner.continuationRescue = { active: false, consumed: false, count: 0, startedAtMs: 0, expiresAtMs: 0, baselineExitPrice: null, baselinePnlPct: 0, baselineProtectedPnlPct: 0, baselineProtectedPrice: null, hardLockPnlPct: 0, hardLockPrice: null, baselineReason: null, context: null, pinkBreakAtMs: 0, pinkBreakObservations: 0, shadowLogged: false, ...(d.runner.continuationRescue || {}) };
  d.dynamicPullbackGrace = { active: false, startedAtMs: 0, expiresAtMs: 0, baselineExitPrice: null, baselinePnlPct: 0, baselineReason: null, context: null, pinkBreakAtMs: 0, pinkBreakObservations: 0, shadowLogged: false, ...(d.dynamicPullbackGrace || {}) };
  d.reentryContinuationGrace = { active: false, startedAtMs: 0, expiresAtMs: 0, baselineExitPrice: null, baselinePnlPct: 0, baselineReason: null, context: null, shadowLogged: false, ...(d.reentryContinuationGrace || {}) };
  return d;
}


function runnerLiveEnabled() { return CFG.RUNNER_EXIT_ENABLED && CFG.RUNNER_EXIT_MODE === "live"; }
function runnerShadowEnabled() { return CFG.RUNNER_EXIT_ENABLED && CFG.RUNNER_EXIT_MODE === "shadow"; }


function parseAuditHorizonsSec(raw, fallback = [60, 90, 120, 180]) {
  const values = String(raw || "").split(",").map((x) => Math.floor(Number(String(x).trim()))).filter((x) => Number.isFinite(x) && x > 0 && x <= 900);
  const unique = [...new Set(values)].sort((a, b) => a - b);
  return unique.length ? unique : fallback.slice();
}
function runnerContinuationRescueFastTickProxyContext(feature, price) {
  const ema8 = finite(feature?.ema8, null), ema18 = finite(feature?.ema18, null), fvvo = finite(feature?.fvvo, null);
  const ray = String(feature?.rayRegime || "RAY_NEUTRAL").toUpperCase();
  const fresh = feature?.kind === CFG.FVVO_FEATURE_TICK_EVENT && Number.isFinite(price) && price > 0;
  const emaBull = ema8 !== null && ema18 !== null && price >= ema18 && ema8 >= ema18;
  const rayNotBear = !ray.startsWith("RAY_BEAR");
  const fvvoOk = fvvo !== null && fvvo >= CFG.RUNNER_CONTINUATION_RESCUE_FAST_TICK_MIN_FVVO;
  return { enabled: CFG.RUNNER_CONTINUATION_RESCUE_FAST_TICK_PROXY_AUDIT_ENABLED, fresh, ema8, ema18, fvvo, ray, emaBull, rayNotBear, fvvoOk, eligible: Boolean(CFG.RUNNER_CONTINUATION_RESCUE_FAST_TICK_PROXY_AUDIT_ENABLED && fresh && emaBull && rayNotBear && fvvoOk) };
}
function runnerContinuationRescueAuditSummary(check, feature, price) {
  const strict = check?.context || null;
  const fastTickProxy = runnerContinuationRescueFastTickProxyContext(feature, price);
  return {
    strict5mEligible: Boolean(check?.ok),
    strict5mReason: check?.ok ? "OK" : (check?.reason || "RUNNER_RESCUE_UNKNOWN"),
    strict5m: strict,
    fastTickProxy,
    divergence: Boolean(!check?.ok && fastTickProxy.eligible),
  };
}
function createRunnerRescuePostExitAudit(position, feature, price, pnlPct, baselineReason, protectedPrice, gateAudit) {
  if (!CFG.RUNNER_CONTINUATION_RESCUE_POST_EXIT_AUDIT_ENABLED || !state.audit) return null;
  const horizonsSec = parseAuditHorizonsSec(CFG.RUNNER_CONTINUATION_RESCUE_POST_EXIT_AUDIT_HORIZONS_SEC);
  const audit = {
    active: true,
    status: "ACTIVE",
    startedAtMs: nowMs(),
    startedAt: nowIso(),
    entryPrice: position.entryPriceReference,
    baselineExitPrice: round(price, 8),
    baselineExitPnlPct: round(pnlPct, 6),
    baselineReason,
    baselineProtectedPrice: finite(protectedPrice, null),
    horizonsSec,
    completedHorizonsSec: [],
    maxPrice: round(price, 8),
    minPrice: round(price, 8),
    lastPrice: round(price, 8),
    reclaimedBaselineProtected: false,
    strict5mEligibleAtExit: Boolean(gateAudit?.strict5mEligible),
    fastTickProxyEligibleAtExit: Boolean(gateAudit?.fastTickProxy?.eligible),
    gateAudit,
  };
  state.audit.runnerRescuePostExit = audit;
  log("INFO", "FVVO_RUNNER_CONTINUATION_RESCUE_POST_EXIT_AUDIT_STARTED", { baselineReason, baselineExitPrice: audit.baselineExitPrice, baselineExitPnlPct: audit.baselineExitPnlPct, baselineProtectedPrice: audit.baselineProtectedPrice, horizonsSec, strict5mEligibleAtExit: audit.strict5mEligibleAtExit, fastTickProxyEligibleAtExit: audit.fastTickProxyEligibleAtExit, divergence: Boolean(gateAudit?.divergence), gateAudit });
  return audit;
}
async function evaluateRunnerRescuePostExitAudit(feature) {
  const audit = state.audit?.runnerRescuePostExit;
  if (!audit?.active || feature.kind !== CFG.FVVO_FEATURE_TICK_EVENT || !Number.isFinite(feature.price) || feature.price <= 0) return;
  const price = feature.price;
  audit.lastPrice = round(price, 8);
  audit.maxPrice = round(Math.max(finite(audit.maxPrice, price), price), 8);
  audit.minPrice = round(Math.min(finite(audit.minPrice, price), price), 8);
  if (finite(audit.baselineProtectedPrice, null) !== null && price > audit.baselineProtectedPrice + 1e-9) audit.reclaimedBaselineProtected = true;
  const elapsedSec = (nowMs() - finite(audit.startedAtMs, nowMs())) / 1000;
  let changed = false;
  for (const horizon of (audit.horizonsSec || [])) {
    if (elapsedSec + 1e-9 < horizon || (audit.completedHorizonsSec || []).includes(horizon)) continue;
    audit.completedHorizonsSec.push(horizon);
    changed = true;
    const deltaPct = percentPnl(audit.baselineExitPrice, price);
    log("INFO", "FVVO_RUNNER_CONTINUATION_RESCUE_POST_EXIT_AUDIT_MILESTONE", { horizonSec: horizon, elapsedSec: round(elapsedSec, 3), baselineReason: audit.baselineReason, baselineExitPrice: audit.baselineExitPrice, price, deltaFromBaselinePct: round(deltaPct, 6), maxPrice: audit.maxPrice, minPrice: audit.minPrice, reclaimedBaselineProtected: Boolean(audit.reclaimedBaselineProtected), strict5mEligibleAtExit: Boolean(audit.strict5mEligibleAtExit), fastTickProxyEligibleAtExit: Boolean(audit.fastTickProxyEligibleAtExit) });
  }
  if ((audit.completedHorizonsSec || []).length >= (audit.horizonsSec || []).length) {
    audit.active = false;
    audit.status = "COMPLETE";
    audit.completedAt = nowIso();
    changed = true;
    log("INFO", "FVVO_RUNNER_CONTINUATION_RESCUE_POST_EXIT_AUDIT_COMPLETE", { baselineReason: audit.baselineReason, baselineExitPrice: audit.baselineExitPrice, lastPrice: audit.lastPrice, maxPrice: audit.maxPrice, minPrice: audit.minPrice, reclaimedBaselineProtected: Boolean(audit.reclaimedBaselineProtected), horizonsSec: audit.horizonsSec, strict5mEligibleAtExit: Boolean(audit.strict5mEligibleAtExit), fastTickProxyEligibleAtExit: Boolean(audit.fastTickProxyEligibleAtExit) });
  }
  if (changed) await persistState("runner_rescue_post_exit_audit");
}

function runnerContinuationRescueMode() {
  return ["disabled", "shadow", "live"].includes(CFG.RUNNER_CONTINUATION_RESCUE_MODE) ? CFG.RUNNER_CONTINUATION_RESCUE_MODE : "shadow";
}
function runnerContinuationRescueContext(feature, price) {
  const ctx = state.lastFeature5m, age = ageSec(ctx), close = finite(ctx?.close, ctx?.price), ema8 = finite(ctx?.ema8, null), ema18 = finite(ctx?.ema18, null), fvvo = finite(ctx?.fvvo, null);
  const ray = String(ctx?.rayRegime || feature.rayRegime || "RAY_NEUTRAL").toUpperCase(), fresh = Boolean(ctx) && age <= CFG.RUNNER_CONTINUATION_RESCUE_CONTEXT_MAX_AGE_SEC;
  const emaBull = !CFG.RUNNER_CONTINUATION_RESCUE_REQUIRE_5M_EMA_BULL || (close !== null && ema8 !== null && ema18 !== null && close >= ema18 && ema8 >= ema18);
  const rayNotBear = !CFG.RUNNER_CONTINUATION_RESCUE_REQUIRE_RAY_NOT_BEAR || !ray.startsWith("RAY_BEAR"), fvvoOk = fvvo !== null && fvvo >= CFG.RUNNER_CONTINUATION_RESCUE_MIN_5M_FVVO;
  const pinkPrice = ema18 === null ? null : ema18 * (1 - CFG.RUNNER_CONTINUATION_RESCUE_PINK_BREAK_TOLERANCE_PCT / 100), pinkHeld = pinkPrice !== null && price > pinkPrice + 1e-9;
  return { fresh, ageSec: age, close, ema8, ema18, fvvo, ray, emaBull, rayNotBear, fvvoOk, pinkPrice, pinkHeld, eligible: fresh && emaBull && rayNotBear && fvvoOk && pinkHeld };
}
function runnerContinuationRescueEligible(position, feature, price, pnlPct) {
  const mode = runnerContinuationRescueMode();
  if (mode === "disabled") return { ok: false, reason: "RUNNER_RESCUE_DISABLED" };
  if (feature.kind !== CFG.FVVO_FEATURE_TICK_EVENT) return { ok: false, reason: "RUNNER_RESCUE_NOT_TICK" };
  const dynamic = dynamicProfitState(position), runner = dynamic.runner, rescue = runner.continuationRescue, peak = Math.max(finite(position.peakPnlPct, 0), finite(dynamic.peakPnlPct, 0));
  if (!runner.tightTrailArmed || peak + 1e-9 < CFG.RUNNER_CONTINUATION_RESCUE_MIN_MFE_PCT) return { ok: false, reason: "RUNNER_RESCUE_MFE_BELOW_MIN", peakPnlPct: peak };
  if (pnlPct + 1e-9 < CFG.RUNNER_CONTINUATION_RESCUE_MIN_PNL_PCT) return { ok: false, reason: "RUNNER_RESCUE_PNL_BELOW_MIN", peakPnlPct: peak, pnlPct };
  if (rescue.active) return { ok: false, reason: "RUNNER_RESCUE_ALREADY_ACTIVE" };
  if (Number(rescue.count || 0) >= CFG.RUNNER_CONTINUATION_RESCUE_MAX_RESCUES_PER_TRADE) return { ok: false, reason: "RUNNER_RESCUE_LIMIT_REACHED" };
  const context = runnerContinuationRescueContext(feature, price);
  const fastTickProxy = runnerContinuationRescueFastTickProxyContext(feature, price);
  return context.eligible ? { ok: true, peakPnlPct: peak, pnlPct, context, fastTickProxy } : { ok: false, reason: "RUNNER_RESCUE_PINK_STRUCTURE_NOT_HEALTHY", peakPnlPct: peak, pnlPct, context, fastTickProxy };
}
function armRunnerContinuationRescue(position, price, pnlPct, baselineReason, evidence) {
  const dynamic = dynamicProfitState(position), runner = dynamic.runner, rescue = runner.continuationRescue, current = nowMs();
  rescue.active = true; rescue.consumed = true; rescue.count = Number(rescue.count || 0) + 1; rescue.startedAtMs = current; rescue.expiresAtMs = current + Math.max(0, CFG.RUNNER_CONTINUATION_RESCUE_MAX_SEC) * 1000;
  rescue.baselineExitPrice = round(price, 8); rescue.baselinePnlPct = round(pnlPct, 6); rescue.baselineProtectedPnlPct = round(finite(runner.protectedPnlPct, 0), 6); rescue.baselineProtectedPrice = round(finite(runner.protectedPrice, 0), 8) || null;
  rescue.hardLockPnlPct = round(Math.max(finite(dynamic.protectedPnlPct, 0), CFG.RUNNER_CONTINUATION_RESCUE_MIN_HARD_LOCK_PNL_PCT), 6); rescue.hardLockPrice = round(position.entryPriceReference * (1 + rescue.hardLockPnlPct / 100), 8);
  rescue.baselineReason = baselineReason; rescue.context = evidence?.context || null; rescue.pinkBreakAtMs = 0; rescue.pinkBreakObservations = 0; rescue.shadowLogged = false; return rescue;
}
function evaluateRunnerContinuationRescue(position, feature, price, pnlPct) {
  const dynamic = dynamicProfitState(position);
  const rescue = dynamic.runner.continuationRescue;
  if (!rescue.active) return { active: false, resolved: false };
  const current = nowMs();
  if (pnlPct <= finite(rescue.hardLockPnlPct, -Infinity) + 1e-9 || price <= finite(rescue.hardLockPrice, -Infinity)) { rescue.active = false; return { active: false, resolved: true, action: "HARD_LOCK", baselineExitPrice: rescue.baselineExitPrice, baselinePnlPct: rescue.baselinePnlPct, hardLockPnlPct: rescue.hardLockPnlPct, hardLockPrice: rescue.hardLockPrice }; }
  const context = runnerContinuationRescueContext(feature, price);
  if (!context.fresh || context.ema18 === null || context.pinkPrice === null) { rescue.active = false; return { active: false, resolved: true, action: "CONTEXT_STALE", context, baselineExitPrice: rescue.baselineExitPrice, baselinePnlPct: rescue.baselinePnlPct }; }
  if (!context.pinkHeld) { if (!rescue.pinkBreakAtMs) rescue.pinkBreakAtMs = current; rescue.pinkBreakObservations = Number(rescue.pinkBreakObservations || 0) + 1; if (rescue.pinkBreakObservations >= CFG.RUNNER_CONTINUATION_RESCUE_PINK_BREAK_CONFIRM_OBSERVATIONS) { rescue.active = false; return { active: false, resolved: true, action: "PINK_BREAK", context, baselineExitPrice: rescue.baselineExitPrice, baselinePnlPct: rescue.baselinePnlPct }; }} else if (rescue.pinkBreakObservations) { rescue.pinkBreakAtMs = 0; rescue.pinkBreakObservations = 0; }
  if (price > finite(rescue.baselineProtectedPrice, Infinity) + 1e-9 && pnlPct > finite(rescue.baselineProtectedPnlPct, Infinity) + 1e-9) {
    const runner = dynamic.runner;
    runner.trailPeakPnlPct = round(Math.max(0, pnlPct), 6);
    const resumedFloorPnlPct = round(Math.max(finite(rescue.hardLockPnlPct, 0), runner.trailPeakPnlPct - CFG.RUNNER_TIGHT_TRAIL_GIVEBACK_PCT), 6);
    runner.protectedPnlPct = resumedFloorPnlPct;
    runner.protectedPrice = round(position.entryPriceReference * (1 + resumedFloorPnlPct / 100), 8);
    runner.floor = { breachAtMs: 0, observations: 0, lastBreachPrice: null };
    rescue.active = false;
    return { active: false, resolved: true, action: "RECOVERY_CONTINUE", context, baselineExitPrice: rescue.baselineExitPrice, baselinePnlPct: rescue.baselinePnlPct, baselineProtectedPrice: rescue.baselineProtectedPrice, resumedProtectedPnlPct: resumedFloorPnlPct, resumedProtectedPrice: runner.protectedPrice };
  }
  if (current >= rescue.expiresAtMs) { rescue.active = false; return { active: false, resolved: true, action: "TIMEOUT", context, baselineExitPrice: rescue.baselineExitPrice, baselinePnlPct: rescue.baselinePnlPct }; }
  return { active: true, resolved: false, context, expiresAtMs: rescue.expiresAtMs, baselineExitPrice: rescue.baselineExitPrice, baselinePnlPct: rescue.baselinePnlPct, hardLockPnlPct: rescue.hardLockPnlPct, hardLockPrice: rescue.hardLockPrice };
}

function updateRunnerExit(position, price) {
  const d = dynamicProfitState(position);
  const r = d.runner;
  const peak = finite(d.peakPnlPct, 0);
  let holdActivatedNow = false;
  let tightTrailArmedNow = false;
  let floorRaised = false;
  const enabled = CFG.RUNNER_EXIT_ENABLED && CFG.RUNNER_EXIT_MODE !== "disabled" && Boolean(d.armed);
  if (!enabled) return { enabled: false, holdActive: false, tightTrailArmed: false, holdActivatedNow, tightTrailArmedNow, floorRaised, runner: r };

  if (!r.holdActive && peak >= CFG.RUNNER_HOLD_MIN_MFE_PCT) {
    r.holdActive = true;
    r.holdActivatedAtMs = nowMs();
    r.holdActivatedAtPnlPct = round(peak, 6);
    holdActivatedNow = true;
  }
  if (!r.tightTrailArmed && peak >= CFG.RUNNER_TIGHT_TRAIL_ARM_MFE_PCT) {
    r.tightTrailArmed = true;
    r.tightTrailArmedAtMs = nowMs();
    r.tightTrailArmedAtPnlPct = round(peak, 6);
    r.trailPeakPnlPct = round(peak, 6);
    tightTrailArmedNow = true;
  }
  if (r.tightTrailArmed) {
    const priorFloor = finite(r.protectedPnlPct, 0);
    const latest = Math.max(0, finite(position.latestPnlPct, 0));
    if (!(finite(r.trailPeakPnlPct, 0) > 0)) r.trailPeakPnlPct = Math.max(peak, latest);
    else r.trailPeakPnlPct = Math.max(finite(r.trailPeakPnlPct, 0), latest);
    const calculatedFloor = Math.max(0, finite(r.trailPeakPnlPct, 0) - CFG.RUNNER_TIGHT_TRAIL_GIVEBACK_PCT);
    r.protectedPnlPct = Math.max(priorFloor, round(calculatedFloor, 6));
    r.protectedPrice = round(position.entryPriceReference * (1 + r.protectedPnlPct / 100), 8);
    floorRaised = r.protectedPnlPct > priorFloor + 1e-9;
  }
  return { enabled: true, holdActive: r.holdActive, tightTrailArmed: r.tightTrailArmed, holdActivatedNow, tightTrailArmedNow, floorRaised, runner: r, price };
}

function runnerTightTrailBreakConfirmed(position, feature, price, pnlPct) {
  const d = dynamicProfitState(position);
  const r = d.runner;
  if (!runnerLiveEnabled() || !r.tightTrailArmed || feature.kind !== CFG.FVVO_FEATURE_TICK_EVENT || !(finite(r.protectedPnlPct, 0) > 0)) return { confirmed: false, reason: "RUNNER_TIGHT_TRAIL_NOT_ELIGIBLE" };
  if (pnlPct > r.protectedPnlPct + 1e-9 || price > finite(r.protectedPrice, Infinity)) {
    if (r.floor?.observations) r.floor = { breachAtMs: 0, observations: 0, lastBreachPrice: null };
    return { confirmed: false, reason: "ABOVE_RUNNER_TIGHT_TRAIL", protectedPnlPct: r.protectedPnlPct, protectedPrice: r.protectedPrice };
  }
  const current = nowMs();
  if (!r.floor?.breachAtMs) r.floor = { breachAtMs: current, observations: 1, lastBreachPrice: price };
  else { r.floor.observations = Number(r.floor.observations || 0) + 1; r.floor.lastBreachPrice = price; }
  const elapsed = (current - r.floor.breachAtMs) / 1000;
  const observations = Number(r.floor.observations || 0);
  return { confirmed: observations >= CFG.RUNNER_TIGHT_TRAIL_CONFIRM_OBSERVATIONS && elapsed >= CFG.RUNNER_TIGHT_TRAIL_CONFIRM_SEC, reason: "RUNNER_TIGHT_TRAIL_CONFIRM", observations, elapsedSec: elapsed, protectedPnlPct: r.protectedPnlPct, protectedPrice: r.protectedPrice };
}

function tickThesisEvidence(position, feature, price, pnlPct) {
  const d = dynamicProfitState(position);
  if (!CFG.DYNAMIC_PROFIT_EXIT_ENABLED || !CFG.DYNAMIC_PROFIT_THESIS_EXIT_ENABLED || !d.armed || feature.kind !== CFG.FVVO_FEATURE_TICK_EVENT) return { eligible: false, conditions: false, reason: "TICK_THESIS_NOT_ELIGIBLE" };
  const ema8 = finite(feature.ema8, null);
  const fvvo = finite(feature.fvvo, null);
  const slope = finite(feature.slope, null);
  const conditions = pnlPct >= CFG.DYNAMIC_PROFIT_THESIS_MIN_PNL_PCT && ema8 !== null && price < ema8 && slope !== null && slope <= CFG.DYNAMIC_PROFIT_THESIS_SLOPE_MAX && fvvo !== null && (fvvo <= 0 || feature.crossDown === true);
  return { eligible: true, conditions, ema8, fvvo, slope, reason: conditions ? "PRICE_BELOW_EMA8_AND_NEGATIVE_FVVO_SLOPE" : "TICK_THESIS_HEALTHY_OR_UNCONFIRMED" };
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
  const evidence = tickThesisEvidence(position, feature, price, pnlPct);
  if (!evidence.eligible) return { confirmed: false, reason: evidence.reason };
  if (!evidence.conditions) {
    if (d.thesis?.observations) d.thesis = { breachAtMs: 0, observations: 0, lastBreachPrice: null, lastFeatureKind: null };
    return { confirmed: false, reason: evidence.reason, ema8: evidence.ema8, fvvo: evidence.fvvo, slope: evidence.slope };
  }
  const current = nowMs();
  if (!d.thesis?.breachAtMs) d.thesis = { breachAtMs: current, observations: 1, lastBreachPrice: price, lastFeatureKind: feature.kind };
  else { d.thesis.observations = Number(d.thesis.observations || 0) + 1; d.thesis.lastBreachPrice = price; d.thesis.lastFeatureKind = feature.kind; }
  d.lastThesisReason = "PRICE_BELOW_EMA8_AND_NEGATIVE_FVVO_SLOPE";
  const elapsed = (current - d.thesis.breachAtMs) / 1000;
  const observations = Number(d.thesis.observations || 0);
  return { confirmed: observations >= CFG.DYNAMIC_PROFIT_THESIS_TICK_CONFIRM_OBSERVATIONS && elapsed >= CFG.DYNAMIC_PROFIT_THESIS_TICK_CONFIRM_SEC, reason: "TICK_THESIS_FAILURE_CONFIRM", observations, elapsedSec: elapsed, ema8: evidence.ema8, fvvo: evidence.fvvo, slope: evidence.slope };
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

function lossSideThesisFailMode() {
  return ["disabled", "shadow", "live"].includes(CFG.LOSS_SIDE_THESIS_FAIL_MODE)
    ? CFG.LOSS_SIDE_THESIS_FAIL_MODE
    : "shadow";
}

function lossSideThesisState(position) {
  if (!position.lossSideThesis || typeof position.lossSideThesis !== "object") {
    position.lossSideThesis = { breachAtMs: 0, observations: 0, lastBreachPrice: null, lastFeatureKind: null, lastReason: null, shadowLogged: false };
  }
  return position.lossSideThesis;
}

function resetLossSideThesis(position, reason) {
  const s = lossSideThesisState(position);
  if (s.observations || s.breachAtMs || s.lastReason) {
    position.lossSideThesis = { breachAtMs: 0, observations: 0, lastBreachPrice: null, lastFeatureKind: null, lastReason: reason || null, shadowLogged: false };
  }
}

function lossSideThesisEvidence(position, feature, price, pnlPct) {
  const mode = lossSideThesisFailMode();
  const dynamic = dynamicProfitState(position);
  if (mode === "disabled") return { eligible: false, conditions: false, reason: "LOSS_SIDE_THESIS_DISABLED" };
  if (feature.kind !== CFG.FVVO_FEATURE_TICK_EVENT) return { eligible: false, conditions: false, reason: "NOT_FEATURE_TICK" };
  if (dynamic.armed) return { eligible: false, conditions: false, reason: "DYNAMIC_PROFIT_ALREADY_ARMED" };
  if (pnlPct > CFG.LOSS_SIDE_THESIS_FAIL_MIN_LOSS_PCT + 1e-9) return { eligible: true, conditions: false, reason: "LOSS_NOT_DEEP_ENOUGH", pnlPct };
  const ema8 = finite(feature.ema8, null);
  const ema18 = finite(feature.ema18, null);
  const rsi = finite(feature.rsi, null);
  const adx = finite(feature.adx, null);
  const fvvo = finite(feature.fvvo, null);
  const slope = finite(feature.slope, null);
  const ray = String(feature.rayRegime || "RAY_NEUTRAL").toUpperCase();
  const belowEma = !CFG.LOSS_SIDE_THESIS_FAIL_REQUIRE_BELOW_EMA8_AND_EMA18 || (ema8 !== null && ema18 !== null && price < ema8 && price < ema18);
  const rayBear = !CFG.LOSS_SIDE_THESIS_FAIL_REQUIRE_RAY_BEAR || ray.startsWith("RAY_BEAR");
  const rsiOk = rsi !== null && rsi <= CFG.LOSS_SIDE_THESIS_FAIL_MAX_RSI;
  const adxOk = adx !== null && adx >= CFG.LOSS_SIDE_THESIS_FAIL_MIN_ADX;
  const fvvoOk = fvvo !== null && fvvo <= CFG.LOSS_SIDE_THESIS_FAIL_MAX_FVVO;
  const slopeOk = slope !== null && slope <= CFG.LOSS_SIDE_THESIS_FAIL_MAX_SLOPE;
  const conditions = belowEma && rayBear && rsiOk && adxOk && fvvoOk && slopeOk;
  const reason = conditions ? "CONFIRMED_BREAKDOWN_STRUCTURE" : "LOSS_SIDE_THESIS_NOT_CONFIRMED";
  return { eligible: true, conditions, reason, pnlPct, ema8, ema18, rsi, adx, fvvo, slope, ray, belowEma, rayBear, rsiOk, adxOk, fvvoOk, slopeOk };
}

function lossSideThesisFailureConfirmed(position, feature, price, pnlPct) {
  const evidence = lossSideThesisEvidence(position, feature, price, pnlPct);
  const state = lossSideThesisState(position);
  if (!evidence.eligible) {
    resetLossSideThesis(position, evidence.reason);
    return { confirmed: false, reason: evidence.reason, evidence };
  }
  if (!evidence.conditions) {
    resetLossSideThesis(position, evidence.reason);
    return { confirmed: false, reason: evidence.reason, evidence };
  }
  const current = nowMs();
  if (!state.breachAtMs) {
    state.breachAtMs = current;
    state.observations = 1;
  } else {
    state.observations = Number(state.observations || 0) + 1;
  }
  state.lastBreachPrice = price;
  state.lastFeatureKind = feature.kind;
  state.lastReason = evidence.reason;
  const elapsed = (current - state.breachAtMs) / 1000;
  const observations = Number(state.observations || 0);
  return { confirmed: observations >= CFG.LOSS_SIDE_THESIS_FAIL_CONFIRM_OBSERVATIONS && elapsed >= CFG.LOSS_SIDE_THESIS_FAIL_CONFIRM_SEC, reason: "LOSS_SIDE_THESIS_FAILURE_CONFIRM", observations, elapsedSec: elapsed, evidence };
}

function dynamicPullbackGraceMode() {
  return ["disabled", "shadow", "live"].includes(CFG.DYNAMIC_PULLBACK_GRACE_MODE)
    ? CFG.DYNAMIC_PULLBACK_GRACE_MODE
    : "shadow";
}

function dynamicPullbackGraceContext(feature, price) {
  const ctx = state.lastFeature5m;
  const age = ageSec(ctx);
  const close = finite(ctx?.close, ctx?.price);
  const ema8 = finite(ctx?.ema8, null);
  const ema18 = finite(ctx?.ema18, null);
  const fvvo = finite(ctx?.fvvo, null);
  const ray = String(ctx?.rayRegime || feature.rayRegime || "RAY_NEUTRAL").toUpperCase();
  const fresh = Boolean(ctx) && age <= CFG.DYNAMIC_PULLBACK_GRACE_CONTEXT_MAX_AGE_SEC;
  const emaBull = !CFG.DYNAMIC_PULLBACK_GRACE_REQUIRE_5M_EMA_BULL ||
    (close !== null && ema8 !== null && ema18 !== null && close >= ema18 && ema8 >= ema18);
  const rayNotBear = !CFG.DYNAMIC_PULLBACK_GRACE_REQUIRE_RAY_NOT_BEAR || !ray.startsWith("RAY_BEAR");
  const fvvoOk = fvvo !== null && fvvo >= CFG.DYNAMIC_PULLBACK_GRACE_MIN_5M_FVVO;
  const pinkPrice = ema18 === null ? null : ema18 * (1 - CFG.DYNAMIC_PULLBACK_GRACE_PINK_BREAK_TOLERANCE_PCT / 100);
  const pinkHeld = pinkPrice !== null && price > pinkPrice + 1e-9;
  return { fresh, ageSec: age, close, ema8, ema18, fvvo, ray, emaBull, rayNotBear, fvvoOk, pinkPrice, pinkHeld,
    eligible: fresh && emaBull && rayNotBear && fvvoOk && pinkHeld };
}

function dynamicPullbackGraceEligible(position, feature, price, pnlPct) {
  if (dynamicPullbackGraceMode() === "disabled") return { ok: false, reason: "GRACE_DISABLED" };
  if (feature.kind !== CFG.FVVO_FEATURE_TICK_EVENT) return { ok: false, reason: "NOT_TICK_THESIS" };
  const dynamic = dynamicProfitState(position);
  const peak = Math.max(finite(position.peakPnlPct, 0), finite(dynamic.peakPnlPct, 0));
  if (!dynamic.armed || peak + 1e-9 < CFG.DYNAMIC_PULLBACK_GRACE_MIN_MFE_PCT) return { ok: false, reason: "MFE_BELOW_GRACE_MIN", peakPnlPct: peak };
  if (pnlPct + 1e-9 < CFG.DYNAMIC_PULLBACK_GRACE_MIN_PNL_PCT) return { ok: false, reason: "PNL_BELOW_GRACE_MIN", peakPnlPct: peak, pnlPct };
  const context = dynamicPullbackGraceContext(feature, price);
  if (!context.eligible) return { ok: false, reason: "FIVE_MINUTE_PINK_STRUCTURE_NOT_HEALTHY", peakPnlPct: peak, pnlPct, context };
  return { ok: true, peakPnlPct: peak, pnlPct, context };
}

function armDynamicPullbackGrace(position, feature, price, pnlPct, baselineReason, evidence) {
  const dynamic = dynamicProfitState(position);
  const grace = dynamic.dynamicPullbackGrace;
  if (grace.active) return grace;
  const current = nowMs();
  grace.active = true;
  grace.startedAtMs = current;
  grace.expiresAtMs = current + Math.max(0, CFG.DYNAMIC_PULLBACK_GRACE_MAX_SEC) * 1000;
  grace.baselineExitPrice = round(price, 8);
  grace.baselinePnlPct = round(pnlPct, 6);
  grace.baselineReason = baselineReason;
  grace.context = evidence?.context || null;
  grace.pinkBreakAtMs = 0;
  grace.pinkBreakObservations = 0;
  grace.shadowLogged = false;
  return grace;
}

function dynamicPullbackGraceRecovery(feature, price) {
  const ema8 = finite(feature.ema8, null);
  const ema18 = finite(feature.ema18, null);
  const fvvo = finite(feature.fvvo, null);
  const slope = finite(feature.slope, null);
  const rsi = finite(feature.rsi, null);
  const ray = String(feature.rayRegime || "RAY_NEUTRAL").toUpperCase();
  const crossOk = !CFG.DYNAMIC_PULLBACK_GRACE_RECOVERY_REQUIRE_CROSS_UP || feature.crossUp === true;
  const priceOk = ema8 !== null && ema18 !== null && price >= ema8 && price >= ema18;
  const momentumOk = fvvo !== null && fvvo >= 0 && slope !== null && slope >= 0 && rsi !== null && rsi >= 50 && !ray.startsWith("RAY_BEAR");
  return { ok: crossOk && priceOk && momentumOk, crossOk, priceOk, momentumOk, ema8, ema18, fvvo, slope, rsi, ray };
}

async function evaluateDynamicPullbackGrace(position, feature, price, pnlPct) {
  const dynamic = dynamicProfitState(position);
  const grace = dynamic.dynamicPullbackGrace;
  if (!grace.active) return { active: false, resolved: false };
  const current = nowMs();
  const context = dynamicPullbackGraceContext(feature, price);
  if (!context.fresh || context.ema18 === null || context.pinkPrice === null) {
    grace.active = false;
    return { active: false, resolved: true, action: "CONTEXT_STALE", context, baselineExitPrice: grace.baselineExitPrice, baselinePnlPct: grace.baselinePnlPct };
  }
  if (!context.pinkHeld) {
    if (!grace.pinkBreakAtMs) grace.pinkBreakAtMs = current;
    grace.pinkBreakObservations = Number(grace.pinkBreakObservations || 0) + 1;
    if (grace.pinkBreakObservations >= CFG.DYNAMIC_PULLBACK_GRACE_PINK_BREAK_CONFIRM_OBSERVATIONS) {
      grace.active = false;
      return { active: false, resolved: true, action: "PINK_BREAK", context, baselineExitPrice: grace.baselineExitPrice, baselinePnlPct: grace.baselinePnlPct };
    }
  } else if (grace.pinkBreakObservations) {
    grace.pinkBreakAtMs = 0;
    grace.pinkBreakObservations = 0;
  }
  const recovery = feature.kind === CFG.FVVO_FEATURE_TICK_EVENT ? dynamicPullbackGraceRecovery(feature, price) : { ok: false };
  if (recovery.ok) {
    grace.active = false;
    return { active: false, resolved: true, action: "RECOVERY_CONTINUE", context, recovery, baselineExitPrice: grace.baselineExitPrice, baselinePnlPct: grace.baselinePnlPct };
  }
  if (current >= grace.expiresAtMs) {
    grace.active = false;
    return { active: false, resolved: true, action: "TIMEOUT", context, recovery, baselineExitPrice: grace.baselineExitPrice, baselinePnlPct: grace.baselinePnlPct };
  }
  return { active: true, resolved: false, context, recovery, expiresAtMs: grace.expiresAtMs, baselineExitPrice: grace.baselineExitPrice, baselinePnlPct: grace.baselinePnlPct };
}

function reentryContinuationGraceMode() {
  return ["disabled", "shadow", "live"].includes(CFG.REENTRY_CONTINUATION_GRACE_MODE)
    ? CFG.REENTRY_CONTINUATION_GRACE_MODE
    : "shadow";
}

function reentryContinuationGraceContext(feature) {
  const ctx = state.lastFeature5m;
  const age = ageSec(ctx);
  const close = finite(ctx?.close, ctx?.price);
  const ema8 = finite(ctx?.ema8, null);
  const ema18 = finite(ctx?.ema18, null);
  const fvvo = finite(ctx?.fvvo, null);
  const ray = String(ctx?.rayRegime || feature.rayRegime || "RAY_NEUTRAL").toUpperCase();
  const fresh = Boolean(ctx) && age <= CFG.REENTRY_CONTINUATION_GRACE_CONTEXT_MAX_AGE_SEC;
  const emaBull = !CFG.REENTRY_CONTINUATION_GRACE_REQUIRE_5M_EMA_BULL ||
    (close !== null && ema8 !== null && ema18 !== null && close >= ema18 && ema8 >= ema18);
  const rayBull = !CFG.REENTRY_CONTINUATION_GRACE_REQUIRE_RAY_BULL || ray === "RAY_BULL";
  const fvvoOk = fvvo !== null && fvvo >= CFG.REENTRY_CONTINUATION_GRACE_MIN_5M_FVVO;
  return { ok: fresh && emaBull && rayBull && fvvoOk, fresh, ageSec: age, close, ema8, ema18, fvvo, ray, emaBull, rayBull, fvvoOk };
}

function reentryContinuationGraceEligible(position, feature, price, pnlPct) {
  if (reentryContinuationGraceMode() === "disabled") return { ok: false, reason: "GRACE_DISABLED" };
  if (position.entryOrigin !== "AUTO_REENTRY") return { ok: false, reason: "NOT_AUTO_REENTRY" };
  const dynamic = dynamicProfitState(position);
  const peak = Math.max(finite(position.peakPnlPct, 0), finite(dynamic.peakPnlPct, 0));
  if (peak + 1e-9 < CFG.REENTRY_CONTINUATION_GRACE_MIN_MFE_PCT) return { ok: false, reason: "MFE_BELOW_GRACE_MIN", peakPnlPct: peak };
  if (pnlPct + 1e-9 < CFG.REENTRY_CONTINUATION_GRACE_MIN_PNL_PCT) return { ok: false, reason: "PNL_BELOW_GRACE_MIN", peakPnlPct: peak, pnlPct };
  const context = reentryContinuationGraceContext(feature);
  if (!context.ok) return { ok: false, reason: "FIVE_MINUTE_CONTINUATION_NOT_STRONG", peakPnlPct: peak, pnlPct, context };
  return { ok: true, peakPnlPct: peak, pnlPct, context };
}

function armReentryContinuationGrace(position, feature, price, pnlPct, baselineReason, evidence) {
  const dynamic = dynamicProfitState(position);
  const grace = dynamic.reentryContinuationGrace;
  if (grace.active) return grace;
  const current = nowMs();
  grace.active = true;
  grace.startedAtMs = current;
  grace.expiresAtMs = current + Math.max(0, CFG.REENTRY_CONTINUATION_GRACE_MAX_SEC) * 1000;
  grace.baselineExitPrice = round(price, 8);
  grace.baselinePnlPct = round(pnlPct, 6);
  grace.baselineReason = baselineReason;
  grace.context = evidence?.context || null;
  grace.shadowLogged = false;
  return grace;
}

function reentryContinuationGraceRecovery(feature, price) {
  const ema8 = finite(feature.ema8, null);
  const ema18 = finite(feature.ema18, null);
  const fvvo = finite(feature.fvvo, null);
  const slope = finite(feature.slope, null);
  const rsi = finite(feature.rsi, null);
  const ray = String(feature.rayRegime || "RAY_NEUTRAL").toUpperCase();
  const crossOk = !CFG.REENTRY_CONTINUATION_GRACE_RECOVERY_REQUIRE_CROSS_UP || feature.crossUp === true;
  const priceOk = ema8 !== null && ema18 !== null && price >= ema8 && price >= ema18;
  const momentumOk = fvvo !== null && fvvo >= 0 && slope !== null && slope >= 0 && rsi !== null && rsi >= 52 && ray === "RAY_BULL";
  return { ok: crossOk && priceOk && momentumOk, crossOk, priceOk, momentumOk, ema8, ema18, fvvo, slope, rsi, ray };
}

async function evaluateReentryContinuationGrace(position, feature, price, pnlPct) {
  const dynamic = dynamicProfitState(position);
  const grace = dynamic.reentryContinuationGrace;
  if (!grace.active) return { active: false, resolved: false };
  const current = nowMs();
  const recovery = reentryContinuationGraceRecovery(feature, price);
  if (recovery.ok) {
    grace.active = false;
    return { active: false, resolved: true, action: "RECOVERY_CAPTURE", recovery, baselineExitPrice: grace.baselineExitPrice, baselinePnlPct: grace.baselinePnlPct };
  }
  if (current >= grace.expiresAtMs) {
    grace.active = false;
    return { active: false, resolved: true, action: "TIMEOUT", recovery, baselineExitPrice: grace.baselineExitPrice, baselinePnlPct: grace.baselinePnlPct };
  }
  return { active: true, resolved: false, recovery, expiresAtMs: grace.expiresAtMs, baselineExitPrice: grace.baselineExitPrice, baselinePnlPct: grace.baselinePnlPct };
}


function defaultProfitFloorMicroShadowState() {
  return {
    active: false, id: null, status: "IDLE", sourcePositionOpenedAtMs: 0,
    entryPrice: null, protectedPrice: null, protectedPnlPct: null,
    armedAtMs: 0, armedAt: null, expiresAtMs: 0, baselineExitAtMs: 0,
    baselineExitAt: null, baselineExitPrice: null, baselineExitPnlPct: null,
    ticks: [], lowestPrice: null, highestPrice: null, recoveryObservations: 0,
    lastEvaluation: null, outcome: null, resolvedAt: null,
  };
}

function normalizeProfitFloorMicroShadowState(raw) {
  const fallback = defaultProfitFloorMicroShadowState();
  const source = raw && typeof raw === "object" ? raw : {};
  const next = { ...fallback, ...source };
  next.active = Boolean(next.active);
  next.ticks = Array.isArray(source.ticks) ? source.ticks.slice(-Math.max(12, CFG.PROFIT_FLOOR_MICRO_SHADOW_WINDOW_TICKS + 4)) : [];
  next.recoveryObservations = Math.max(0, Math.floor(finite(source.recoveryObservations, 0)));
  return next;
}

function defaultProfitFloorPostExitReclaimShadowState() {
  return {
    active: false, id: null, status: "IDLE", sourcePositionOpenedAtMs: 0,
    originalEntryPrice: null, originalPeakPnlPct: null, exitReason: null,
    exitPrice: null, exitPnlPct: null, exitAtMs: 0, exitAt: null,
    expiresAtMs: 0, lowPrice: null, lowAtMs: 0, confirmObservations: 0,
    lastMonitorLogAtMs: 0, candidate: null, outcome: null, resolvedAt: null,
  };
}

function normalizeProfitFloorPostExitReclaimShadowState(raw) {
  const fallback = defaultProfitFloorPostExitReclaimShadowState();
  const source = raw && typeof raw === "object" ? raw : {};
  const next = { ...fallback, ...source };
  next.active = Boolean(next.active);
  next.confirmObservations = Math.max(0, Math.floor(finite(source.confirmObservations, 0)));
  if (next.candidate && typeof next.candidate !== "object") next.candidate = null;
  return next;
}

function ensureProfitFloorShadowState() {
  state.audit = state.audit && typeof state.audit === "object" ? state.audit : { runnerRescuePostExit: null, profitFloorMicroShadow: null, profitFloorPostExitReclaimShadow: null, lastBarTimeByKind: {} };
  state.audit.profitFloorMicroShadow = normalizeProfitFloorMicroShadowState(state.audit.profitFloorMicroShadow);
  state.audit.profitFloorPostExitReclaimShadow = normalizeProfitFloorPostExitReclaimShadowState(state.audit.profitFloorPostExitReclaimShadow);
  return { micro: state.audit.profitFloorMicroShadow, postExit: state.audit.profitFloorPostExitReclaimShadow };
}

function profitFloorShadowStatusPayload() {
  const { micro, postExit } = ensureProfitFloorShadowState();
  return {
    micro: {
      enabled: CFG.PROFIT_FLOOR_MICRO_SHADOW_ENABLED, active: Boolean(micro.active), status: micro.status,
      protectedPrice: micro.protectedPrice, baselineExitPrice: micro.baselineExitPrice,
      baselineExitPnlPct: micro.baselineExitPnlPct, outcome: micro.outcome,
    },
    postExitReclaim: {
      enabled: CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_SHADOW_ENABLED, active: Boolean(postExit.active), status: postExit.status,
      exitPrice: postExit.exitPrice, lowPrice: postExit.lowPrice,
      candidate: postExit.candidate ? {
        entryPrice: postExit.candidate.entryPrice, enteredAt: postExit.candidate.enteredAt,
        mfePct: postExit.candidate.mfePct, maePct: postExit.candidate.maePct,
        latestPnlPct: postExit.candidate.latestPnlPct,
      } : null,
      outcome: postExit.outcome,
    },
    executionEffect: "NONE_SHADOW_ONLY",
  };
}

function profitFloorMomentumRecoveryVeto(latest, compareTick) {
  if (!CFG.PROFIT_FLOOR_MICRO_SHADOW_MOMENTUM_RECOVERY_VETO || !latest || !compareTick) return false;
  const slope = finite(latest.slope, null), fvvo = finite(latest.fvvo, null), rsi = finite(latest.rsi, null);
  const priorFvvo = finite(compareTick.fvvo, null), priorRsi = finite(compareTick.rsi, null);
  return slope !== null && slope > 0 && fvvo !== null && priorFvvo !== null && fvvo > priorFvvo && rsi !== null && priorRsi !== null && rsi > priorRsi;
}

function armProfitFloorMicroShadow(position, feature, price, pnlPct, floor) {
  if (!CFG.PROFIT_FLOOR_MICRO_SHADOW_ENABLED || feature.kind !== CFG.FVVO_FEATURE_TICK_EVENT) return null;
  const dynamic = dynamicProfitState(position);
  if (dynamic.runner?.tightTrailArmed) return null;
  const { micro } = ensureProfitFloorShadowState();
  if (micro.active && micro.sourcePositionOpenedAtMs === finite(position.openedAtMs, 0)) return micro;
  const current = nowMs();
  const next = defaultProfitFloorMicroShadowState();
  Object.assign(next, {
    active: true, id: crypto.randomUUID(), status: "MONITORING", sourcePositionOpenedAtMs: finite(position.openedAtMs, 0),
    entryPrice: round(position.entryPriceReference, 8), protectedPrice: round(floor.protectedPrice, 8), protectedPnlPct: round(floor.protectedPnlPct, 6),
    armedAtMs: current, armedAt: nowIso(), expiresAtMs: current + Math.max(1, CFG.PROFIT_FLOOR_MICRO_SHADOW_MAX_SEC) * 1000,
    lowestPrice: round(price, 8), highestPrice: round(price, 8),
  });
  state.audit.profitFloorMicroShadow = next;
  log("INFO", "FVVO_PROFIT_FLOOR_MICRO_SHADOW_ARMED", {
    observerId: next.id, entryPrice: next.entryPrice, protectedPrice: next.protectedPrice, protectedPnlPct: next.protectedPnlPct,
    firstBreachPrice: price, firstBreachPnlPct: round(pnlPct, 6), expiresAt: new Date(next.expiresAtMs).toISOString(),
    windowTicks: CFG.PROFIT_FLOOR_MICRO_SHADOW_WINDOW_TICKS, requiredBelowTicks: CFG.PROFIT_FLOOR_MICRO_SHADOW_REQUIRED_BELOW_TICKS,
    executionEffect: "NONE_SHADOW_ONLY",
  });
  return next;
}

function profitFloorMicroEvaluation(observer) {
  const ticks = observer.ticks || [];
  const n = CFG.PROFIT_FLOOR_MICRO_SHADOW_WINDOW_TICKS;
  if (ticks.length < n) return { qualified: false, reason: "INSUFFICIENT_TICKS", tickCount: ticks.length };
  const window = ticks.slice(-n), prices = window.map((x) => finite(x.price, null)).filter((x) => x !== null);
  if (prices.length < n) return { qualified: false, reason: "INVALID_TICKS" };
  const floor = finite(observer.protectedPrice, null);
  const belowCount = prices.filter((x) => x <= floor + 1e-9).length;
  const sorted = [...prices].sort((a,b)=>a-b), median = sorted[Math.floor(sorted.length/2)];
  const early = prices.slice(0,3).reduce((a,b)=>a+b,0)/3, late = prices.slice(-3).reduce((a,b)=>a+b,0)/3;
  const avgDeclinePct = early > 0 ? ((early-late)/early)*100 : 0;
  const latest = window[window.length-1], compare = window[Math.max(0, window.length-3)];
  const bear = featureBearSignals(latest, latest.price, compare);
  const recoveryVeto = profitFloorMomentumRecoveryVeto(latest, compare);
  const qualified = belowCount >= Math.min(n, CFG.PROFIT_FLOOR_MICRO_SHADOW_REQUIRED_BELOW_TICKS)
    && median <= floor + 1e-9
    && avgDeclinePct + 1e-9 >= CFG.PROFIT_FLOOR_MICRO_SHADOW_MIN_AVG_DECLINE_PCT
    && bear.signalCount >= CFG.PROFIT_FLOOR_MICRO_SHADOW_MIN_BEAR_SIGNALS
    && !recoveryVeto;
  return { qualified, reason: qualified ? "MICRO_DOWNTREND_CONFIRMED" : "MICRO_HOLD", belowCount, median: round(median,8), earlyAverage: round(early,8), lateAverage: round(late,8), avgDeclinePct: round(avgDeclinePct,6), bearSignals: bear.signals, bearSignalCount: bear.signalCount, recoveryVeto };
}

function resolveProfitFloorMicroShadow(observer, outcome, price, feature, evaluation = null) {
  observer.active = false; observer.status = "RESOLVED"; observer.outcome = outcome; observer.resolvedAt = nowIso();
  const gross = percentPnl(observer.entryPrice, price), baseline = finite(observer.baselineExitPnlPct, null);
  const payload = {
    observerId: observer.id, outcome, hypotheticalExitPrice: round(price,8), hypotheticalGrossPnlPct: round(gross,6),
    hypotheticalEstimatedNetPnlPct: round(gross-CFG.PNL_ESTIMATED_ROUND_TRIP_COST_PCT,6), baselineExitPrice: observer.baselineExitPrice,
    baselineExitPnlPct: baseline, deltaVsBaselinePct: baseline === null ? null : round(gross-baseline,6),
    elapsedSec: round((nowMs()-observer.armedAtMs)/1000,3), lowestPrice: observer.lowestPrice, highestPrice: observer.highestPrice,
    evaluation, executionEffect: "NONE_SHADOW_ONLY", featureKind: feature.kind,
  };
  const event = outcome === "RECOVERY_CANCELLED" ? "FVVO_PROFIT_FLOOR_MICRO_SHADOW_RECOVERY_CANCELLED" : `FVVO_PROFIT_FLOOR_MICRO_SHADOW_${outcome}`;
  log(outcome === "RECOVERY_CANCELLED" ? "INFO" : "WARN", event, payload);
  return payload;
}

async function evaluateProfitFloorMicroShadow(feature) {
  if (feature.kind !== CFG.FVVO_FEATURE_TICK_EVENT || !Number.isFinite(feature.price) || feature.price <= 0) return;
  const { micro } = ensureProfitFloorShadowState();
  if (!micro.active) return;
  const price = feature.price;
  micro.lowestPrice = round(Math.min(finite(micro.lowestPrice, price), price),8);
  micro.highestPrice = round(Math.max(finite(micro.highestPrice, price), price),8);
  micro.ticks.push({ price: round(price,8), ema8: feature.ema8, fvvo: feature.fvvo, slope: feature.slope, rsi: feature.rsi, rayRegime: feature.rayRegime, barTimeMs: feature.barTimeMs });
  micro.ticks = micro.ticks.slice(-Math.max(12, CFG.PROFIT_FLOOR_MICRO_SHADOW_WINDOW_TICKS + 4));

  const gross = percentPnl(micro.entryPrice, price), estimatedNet = gross - CFG.PNL_ESTIMATED_ROUND_TRIP_COST_PCT;
  const hardBreakPrice = micro.protectedPrice * (1 - CFG.PROFIT_FLOOR_MICRO_SHADOW_HARD_BREAK_BUFFER_PCT/100);
  let outcome = null, evaluation = null;
  if (price <= hardBreakPrice + 1e-9) outcome = "HYPOTHETICAL_HARD_BREAK_EXIT";
  else if (estimatedNet <= CFG.PROFIT_FLOOR_MICRO_SHADOW_HARD_NET_PNL_PCT + 1e-9) outcome = "HYPOTHETICAL_HARD_NET_EXIT";
  else {
    const ray = String(feature.rayRegime || "RAY_NEUTRAL").toUpperCase();
    const recovered = price >= micro.protectedPrice*(1+CFG.PROFIT_FLOOR_MICRO_SHADOW_RECOVERY_BUFFER_PCT/100)-1e-9
      && finite(feature.ema8,null)!==null && price >= feature.ema8 && finite(feature.slope,null)!==null && feature.slope>0 && !ray.startsWith("RAY_BEAR");
    micro.recoveryObservations = recovered ? micro.recoveryObservations + 1 : 0;
    if (micro.recoveryObservations >= CFG.PROFIT_FLOOR_MICRO_SHADOW_RECOVERY_OBSERVATIONS) outcome = "RECOVERY_CANCELLED";
    else {
      evaluation = profitFloorMicroEvaluation(micro); micro.lastEvaluation = evaluation;
      if (evaluation.qualified) outcome = "HYPOTHETICAL_MICRO_EXIT";
      else if (nowMs() >= micro.expiresAtMs) outcome = price <= micro.protectedPrice + 1e-9 ? "HYPOTHETICAL_TIMEOUT_EXIT" : "RECOVERY_CANCELLED";
    }
  }
  if (outcome) resolveProfitFloorMicroShadow(micro, outcome, price, feature, evaluation);
  else log("INFO", evaluation?.qualified ? "FVVO_PROFIT_FLOOR_MICRO_SHADOW_CONFIRMING" : "FVVO_PROFIT_FLOOR_MICRO_SHADOW_HOLD", { observerId: micro.id, price, protectedPrice: micro.protectedPrice, grossPnlPct: round(gross,6), estimatedNetPnlPct: round(estimatedNet,6), recoveryObservations: micro.recoveryObservations, evaluation, executionEffect: "NONE_SHADOW_ONLY" });
  await persistState("profit_floor_micro_shadow_tick");
}

function recordProfitFloorBaselineExit(position, price, reason) {
  const { micro, postExit } = ensureProfitFloorShadowState();
  const current = nowMs(), gross = percentPnl(position.entryPriceReference, price);
  if (micro.active && micro.sourcePositionOpenedAtMs === finite(position.openedAtMs,0) && micro.baselineExitPrice === null) {
    micro.baselineExitAtMs = current; micro.baselineExitAt = nowIso(); micro.baselineExitPrice = round(price,8); micro.baselineExitPnlPct = round(gross,6);
    log("INFO", "FVVO_PROFIT_FLOOR_BASELINE_EXIT_RECORDED", { observerId: micro.id, reason, baselineExitPrice: micro.baselineExitPrice, baselineExitPnlPct: micro.baselineExitPnlPct, executionEffect: "LIVE_BASELINE_UNCHANGED" });
  }
  if (!CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_SHADOW_ENABLED) return;
  const next = defaultProfitFloorPostExitReclaimShadowState();
  Object.assign(next, {
    active: true, id: crypto.randomUUID(), status: "SCANNING", sourcePositionOpenedAtMs: finite(position.openedAtMs,0),
    originalEntryPrice: round(position.entryPriceReference,8), originalPeakPnlPct: round(Math.max(finite(position.peakPnlPct,0),finite(position.dynamicProfit?.peakPnlPct,0)),6),
    exitReason: reason, exitPrice: round(price,8), exitPnlPct: round(gross,6), exitAtMs: current, exitAt: nowIso(),
    expiresAtMs: current + Math.max(1, CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_WINDOW_SEC)*1000, lowPrice: round(price,8), lowAtMs: current,
  });
  state.audit.profitFloorPostExitReclaimShadow = next;
  log("INFO", "FVVO_PROFIT_FLOOR_POST_EXIT_RECLAIM_SHADOW_ARMED", { observerId: next.id, exitReason: reason, exitPrice: next.exitPrice, exitPnlPct: next.exitPnlPct, originalEntryPrice: next.originalEntryPrice, originalPeakPnlPct: next.originalPeakPnlPct, expiresAt: new Date(next.expiresAtMs).toISOString(), executionEffect: "NONE_SHADOW_ONLY" });
}

function postExitReclaim5mContext() {
  const ctx = state.lastFeature5m, age = ageSec(ctx);
  const close = finite(ctx?.close,ctx?.price), ema8 = finite(ctx?.ema8,null), ema18 = finite(ctx?.ema18,null), fvvo = finite(ctx?.fvvo,null), slope = finite(ctx?.slope,null);
  const ray = String(ctx?.rayRegime || "RAY_NEUTRAL").toUpperCase();
  const fresh = Boolean(ctx) && age <= CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_5M_MAX_AGE_SEC;
  const supportive = fresh && close!==null && ema18!==null && close>=ema18 && (!ray.startsWith("RAY_BEAR")) && (fvvo===null || fvvo>=CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_MIN_FVVO) && (slope===null || slope>=0);
  return { fresh, supportive, ageSec: age, close, ema8, ema18, fvvo, slope, ray };
}

function postExitReclaimEvidence(feature, observer) {
  const price=feature.price, ema8=finite(feature.ema8,null), ema18=finite(feature.ema18,null), rsi=finite(feature.rsi,null), adx=finite(feature.adx,null), fvvo=finite(feature.fvvo,null), slope=finite(feature.slope,null);
  const ray=String(feature.rayRegime||"RAY_NEUTRAL").toUpperCase(), low=finite(observer.lowPrice,price), recoveryPct=percentPnl(low,price), context5m=postExitReclaim5mContext();
  const conditions={ recoveryRange: recoveryPct+1e-9>=CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_MIN_RECOVERY_PCT && recoveryPct<=CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_MAX_RECOVERY_PCT+1e-9, priceAboveEmas: ema8!==null&&ema18!==null&&price>=ema8&&price>=ema18, emaBull: ema8!==null&&ema18!==null&&ema8>=ema18, rsi: rsi!==null&&rsi>=CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_MIN_RSI&&rsi<=CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_MAX_RSI, adx: adx!==null&&adx>=CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_MIN_ADX, fvvo: fvvo!==null&&fvvo>=CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_MIN_FVVO, slope: slope!==null&&slope>=CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_MIN_SLOPE, rayNotBear: !ray.startsWith("RAY_BEAR"), context5m: context5m.supportive };
  return { qualified:Object.values(conditions).every(Boolean), price, low, recoveryPct:round(recoveryPct,6), ema8,ema18,rsi,adx,fvvo,slope,ray,context5m,conditions };
}

async function evaluateProfitFloorPostExitReclaimShadow(feature) {
  if (feature.kind!==CFG.FVVO_FEATURE_TICK_EVENT || !Number.isFinite(feature.price)||feature.price<=0) return;
  const { postExit }=ensureProfitFloorShadowState();
  if (!postExit.active) return;
  // A newly opened real position invalidates the old hypothetical recovery campaign.
  if (state.position && !String(state.position.lifecycle||"").startsWith("EXIT_") && finite(state.position.openedAtMs,0)!==postExit.sourcePositionOpenedAtMs) {
    postExit.active=false; postExit.status="CANCELLED_NEW_REAL_POSITION"; postExit.outcome="CANCELLED_NEW_REAL_POSITION"; postExit.resolvedAt=nowIso();
    log("INFO","FVVO_PROFIT_FLOOR_POST_EXIT_RECLAIM_SHADOW_EXPIRED",{observerId:postExit.id,reason:"NEW_REAL_POSITION",executionEffect:"NONE_SHADOW_ONLY"}); await persistState("profit_floor_post_exit_cancel_new_position"); return;
  }
  const price=feature.price, current=nowMs(); let changed=false;
  if (!postExit.candidate) {
    if (price < finite(postExit.lowPrice,Infinity)-1e-9) { postExit.lowPrice=round(price,8); postExit.lowAtMs=current; postExit.confirmObservations=0; changed=true; log("INFO","FVVO_PROFIT_FLOOR_POST_EXIT_RECLAIM_SHADOW_LOW_UPDATED",{observerId:postExit.id,lowPrice:postExit.lowPrice,exitPrice:postExit.exitPrice,drawdownFromExitPct:round(percentPnl(postExit.exitPrice,price),6),executionEffect:"NONE_SHADOW_ONLY"}); }
    if (current>=postExit.expiresAtMs) { postExit.active=false; postExit.status="EXPIRED_NO_CANDIDATE"; postExit.outcome="EXPIRED_NO_CANDIDATE"; postExit.resolvedAt=nowIso(); log("INFO","FVVO_PROFIT_FLOOR_POST_EXIT_RECLAIM_SHADOW_EXPIRED",{observerId:postExit.id,exitPrice:postExit.exitPrice,lowPrice:postExit.lowPrice,windowSec:CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_WINDOW_SEC,executionEffect:"NONE_SHADOW_ONLY"}); changed=true; }
    else {
      const evidence=postExitReclaimEvidence(feature,postExit); postExit.confirmObservations=evidence.qualified?postExit.confirmObservations+1:0;
      if (postExit.confirmObservations>=CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_CONFIRM_OBSERVATIONS) {
        postExit.candidate={ entryPrice:round(price,8), enteredAtMs:current, enteredAt:nowIso(), expiresAtMs:current+Math.max(1,CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_PERFORMANCE_SEC)*1000, mfePct:0, maePct:0, latestPnlPct:0, peakPrice:round(price,8), lowPrice:round(price,8), evidence };
        postExit.status="CANDIDATE_TRACKING"; changed=true;
        log("INFO","FVVO_PROFIT_FLOOR_POST_EXIT_RECLAIM_SHADOW_CANDIDATE",{observerId:postExit.id,hypotheticalEntryPrice:postExit.candidate.entryPrice,recoveryFromLowPct:evidence.recoveryPct,confirmObservations:postExit.confirmObservations,evidence,executionEffect:"NONE_SHADOW_ONLY",automaticOrderSent:false});
      } else if (current-finite(postExit.lastMonitorLogAtMs,0)>=Math.max(15,CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_MONITOR_LOG_SEC)*1000) {
        postExit.lastMonitorLogAtMs=current; changed=true; log("INFO","FVVO_PROFIT_FLOOR_POST_EXIT_RECLAIM_SHADOW_MONITOR",{observerId:postExit.id,price,exitPrice:postExit.exitPrice,lowPrice:postExit.lowPrice,recoveryFromLowPct:evidence.recoveryPct,confirmObservations:postExit.confirmObservations,requiredObservations:CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_CONFIRM_OBSERVATIONS,evidence,executionEffect:"NONE_SHADOW_ONLY"});
      }
    }
  } else {
    const c=postExit.candidate, pnl=percentPnl(c.entryPrice,price); c.latestPnlPct=round(pnl,6); c.mfePct=round(Math.max(finite(c.mfePct,0),pnl),6); c.maePct=round(Math.min(finite(c.maePct,0),pnl),6); c.peakPrice=round(Math.max(finite(c.peakPrice,price),price),8); c.lowPrice=round(Math.min(finite(c.lowPrice,price),price),8);
    if (current>=c.expiresAtMs) { postExit.active=false; postExit.status="PERFORMANCE_COMPLETE"; postExit.outcome="PERFORMANCE_COMPLETE"; postExit.resolvedAt=nowIso(); changed=true; log("INFO","FVVO_PROFIT_FLOOR_POST_EXIT_RECLAIM_SHADOW_PERFORMANCE_COMPLETE",{observerId:postExit.id,hypotheticalEntryPrice:c.entryPrice,latestPrice:price,latestPnlPct:c.latestPnlPct,mfePct:c.mfePct,maePct:c.maePct,peakPrice:c.peakPrice,lowPrice:c.lowPrice,performanceSec:CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_PERFORMANCE_SEC,executionEffect:"NONE_SHADOW_ONLY",automaticOrderSent:false}); }
  }
  if (changed) await persistState("profit_floor_post_exit_reclaim_shadow");
}

async function evaluateProfitFloorShadowObservers(feature) {
  await evaluateProfitFloorMicroShadow(feature);
  await evaluateProfitFloorPostExitReclaimShadow(feature);
}

function swingStructureExitMode() {
  return ["disabled", "shadow", "live"].includes(CFG.SWING_STRUCTURE_EXIT_MODE)
    ? CFG.SWING_STRUCTURE_EXIT_MODE
    : "disabled";
}

function defaultFastEmergencyState() {
  return {
    active: false, id: null, armedAtMs: 0, armedAt: null, expiresAtMs: 0,
    detectorBarTimeMs: 0, detectorPrice: null, detectorPnlPct: null, detectorEvidence: null,
    emergencyBreakPrice: null, normalBreakPrice: null, hardBreakPrice: null,
    ticks: [], microConfirmations: 0, recoveryObservations: 0, lastMicroReason: null,
    profitHardBreakObservations: 0, profitHardBreakStartedAtMs: 0,
    lastEvaluationBarTimeMs: 0, lastPrice: null, lastPnlPct: null,
    shadow: {
      legacyImmediate: { logged: false, price: null, pnlPct: null, at: null },
      intelligent1m: { currentMinute: null, current: null, confirmedMinutes: 0, exitLogged: false, exitPrice: null, exitPnlPct: null, exitAt: null, lastFinalizedMinute: null, lastClosed: null },
    },
    resolution: null,
  };
}

function normalizeFastEmergencyState(raw) {
  const fallback = defaultFastEmergencyState();
  const source = raw && typeof raw === "object" ? raw : {};
  const next = { ...fallback, ...source };
  next.active = Boolean(next.active);
  next.ticks = Array.isArray(source.ticks) ? source.ticks.slice(-Math.max(12, CFG.SWING_EMERGENCY_MICRO_WINDOW_TICKS + 4)) : [];
  next.microConfirmations = Math.max(0, Math.floor(finite(source.microConfirmations, 0)));
  next.recoveryObservations = Math.max(0, Math.floor(finite(source.recoveryObservations, 0)));
  next.profitHardBreakObservations = Math.max(0, Math.floor(finite(source.profitHardBreakObservations, 0)));
  next.profitHardBreakStartedAtMs = Math.max(0, finite(source.profitHardBreakStartedAtMs, 0));
  next.shadow = { ...fallback.shadow, ...(source.shadow || {}) };
  next.shadow.legacyImmediate = { ...fallback.shadow.legacyImmediate, ...(source.shadow?.legacyImmediate || {}) };
  next.shadow.intelligent1m = { ...fallback.shadow.intelligent1m, ...(source.shadow?.intelligent1m || {}) };
  return next;
}

function normalizeSwingExitState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const next = { ...source };
  for (const key of ["structure", "emergency", "noProgress"]) next[key] = { observations: 0, breachAtMs: 0, lastEvidence: null, ...(source[key] || {}) };
  next.fastEmergency = normalizeFastEmergencyState(source.fastEmergency);
  return next;
}

function swingExitState(position) {
  position.swingExit = normalizeSwingExitState(position.swingExit);
  return position.swingExit;
}

function resetSwingCounter(counter) {
  if (counter?.observations) Object.assign(counter, { observations: 0, breachAtMs: 0, lastEvidence: null });
}

function swingDeteriorationEvidence(feature, price) {
  const close = finite(feature.close, price);
  const ema8 = finite(feature.ema8, null);
  const ema18 = finite(feature.ema18, null);
  const ema50 = finite(feature.ema50, null);
  const fvvo = finite(feature.fvvo, null);
  const slope = finite(feature.slope, null);
  const rsi = finite(feature.rsi, null);
  const ray = String(feature.rayRegime || "RAY_NEUTRAL").toUpperCase();
  const signals = [];
  if (ema8 !== null && ema18 !== null && ema8 <= ema18) signals.push("EMA8_BELOW_OR_EQUAL_EMA18");
  if (ema50 !== null && close !== null && close < ema50) signals.push("CLOSE_BELOW_EMA50");
  if (fvvo !== null && fvvo <= CFG.SWING_STRUCTURE_MAX_FVVO) signals.push("FVVO_NONPOSITIVE");
  if (slope !== null && slope <= CFG.SWING_STRUCTURE_MAX_SLOPE) signals.push("FVVO_SLOPE_NONPOSITIVE");
  if (rsi !== null && rsi <= CFG.SWING_STRUCTURE_MAX_RSI) signals.push("RSI_WEAK");
  if (ray.startsWith("RAY_BEAR")) signals.push("RAY_BEAR");
  if (feature.crossDown === true) signals.push("FVVO_CROSS_DOWN");
  const normalBreakPrice = ema18 === null ? null : ema18 * (1 - CFG.SWING_STRUCTURE_EMA18_BREAK_TOLERANCE_PCT / 100);
  const emergencyBreakPrice = ema18 === null ? null : ema18 * (1 - CFG.SWING_STRUCTURE_EMERGENCY_BREAK_PCT / 100);
  const closeBelowNormal = close !== null && normalBreakPrice !== null && close <= normalBreakPrice + 1e-9;
  const closeBelowEmergency = close !== null && emergencyBreakPrice !== null && close <= emergencyBreakPrice + 1e-9;
  const emaRequirement = !CFG.SWING_STRUCTURE_REQUIRE_EMA8_BELOW_EMA18 || (ema8 !== null && ema18 !== null && ema8 <= ema18);
  const rayRequirement = !CFG.SWING_STRUCTURE_REQUIRE_RAY_BEAR || ray.startsWith("RAY_BEAR");
  const closeRequirement = !CFG.SWING_STRUCTURE_REQUIRE_CLOSE_BELOW_EMA18 || closeBelowNormal;
  return { close, ema8, ema18, ema50, fvvo, slope, rsi, ray, signals, signalCount: signals.length, normalBreakPrice, emergencyBreakPrice, closeBelowNormal, closeBelowEmergency, emaRequirement, rayRequirement, closeRequirement };
}

function incrementSwingCounter(counter, evidence) {
  const current = nowMs();
  if (!counter.breachAtMs) counter.breachAtMs = current;
  counter.observations = Number(counter.observations || 0) + 1;
  counter.lastEvidence = evidence;
  return { observations: counter.observations, elapsedSec: (current - counter.breachAtMs) / 1000 };
}


function featureBearSignals(feature, price, compareTick = null) {
  const ema8 = finite(feature?.ema8, null);
  const fvvo = finite(feature?.fvvo, null);
  const slope = finite(feature?.slope, null);
  const rsi = finite(feature?.rsi, null);
  const ray = String(feature?.rayRegime || "RAY_NEUTRAL").toUpperCase();
  const signals = [];
  if (ema8 !== null && price < ema8) signals.push("PRICE_BELOW_EMA8");
  if (ray.startsWith("RAY_BEAR")) signals.push("RAY_BEAR");
  if (slope !== null && slope <= 0) signals.push("FVVO_SLOPE_NONPOSITIVE");
  if (compareTick && fvvo !== null && finite(compareTick.fvvo, null) !== null && fvvo < compareTick.fvvo) signals.push("FVVO_LOWER_THAN_30S_AGO");
  if (rsi !== null && rsi <= 35) signals.push("RSI_WEAK_35");
  return { signals, signalCount: signals.length, ema8, fvvo, slope, rsi, ray };
}

function emergencyMomentumRecoveryVeto(latest, compareTick) {
  if (!CFG.SWING_EMERGENCY_MICRO_MOMENTUM_RECOVERY_VETO || !latest || !compareTick) return false;
  const slope = finite(latest.slope, null);
  const fvvo = finite(latest.fvvo, null);
  const priorFvvo = finite(compareTick.fvvo, null);
  const rsi = finite(latest.rsi, null);
  const priorRsi = finite(compareTick.rsi, null);
  return slope !== null && slope > 0 && fvvo !== null && priorFvvo !== null && fvvo > priorFvvo && rsi !== null && priorRsi !== null && rsi > priorRsi;
}

function armFastEmergency(position, feature, price, pnlPct, evidence) {
  const swing = swingExitState(position);
  const fast = swing.fastEmergency;
  if (fast.active) return { armedNow: false, fast };
  const current = nowMs();
  const line = finite(evidence?.emergencyBreakPrice, null);
  const fresh = normalizeFastEmergencyState(null);
  Object.assign(fast, fresh, {
    active: true,
    id: crypto.randomUUID(),
    armedAtMs: current,
    armedAt: nowIso(),
    expiresAtMs: current + CFG.SWING_EMERGENCY_FAST_CONFIRM_MAX_SEC * 1000,
    detectorBarTimeMs: finite(feature?.barTimeMs, current),
    detectorPrice: round(price, 8),
    detectorPnlPct: round(pnlPct, 6),
    detectorEvidence: clone(evidence),
    emergencyBreakPrice: line === null ? null : round(line, 8),
    normalBreakPrice: finite(evidence?.normalBreakPrice, null),
    hardBreakPrice: line === null ? null : round(line * (1 - CFG.SWING_EMERGENCY_HARD_BREAK_BUFFER_PCT / 100), 8),
    lastPrice: round(price, 8),
    lastPnlPct: round(pnlPct, 6),
  });
  if (CFG.SWING_EMERGENCY_SHADOW_LEGACY_IMMEDIATE_ENABLED) {
    fast.shadow.legacyImmediate = { logged: true, price: round(price, 8), pnlPct: round(pnlPct, 6), at: nowIso() };
    log("WARN", "FVVO_SWING_EMERGENCY_LEGACY_IMMEDIATE_SHADOW", { fastEmergencyId: fast.id, counterfactualReason: "V1B_IMMEDIATE_5M_EMERGENCY_EXIT", price, pnlPct: round(pnlPct, 6), emergencyBreakPrice: fast.emergencyBreakPrice, action: "SHADOW_ONLY_NO_EXIT" });
  }
  log("WARN", "FVVO_SWING_EMERGENCY_FAST_CONFIRM_ARMED", { fastEmergencyId: fast.id, mode: CFG.SWING_EMERGENCY_FAST_CONFIRM_MODE, price, pnlPct: round(pnlPct, 6), peakPnlPct: round(position.peakPnlPct, 6), emergencyBreakPrice: fast.emergencyBreakPrice, hardBreakPrice: fast.hardBreakPrice, expiresAt: new Date(fast.expiresAtMs).toISOString(), detectorEvidence: evidence, action: CFG.SWING_EMERGENCY_FAST_CONFIRM_MODE === "shadow" ? "SHADOW_MONITOR" : "WAIT_FOR_15S_CONFIRMATION" });
  return { armedNow: true, fast };
}

function resetFastEmergency(position, resolution, feature = null, price = null, pnlPct = null, extra = {}) {
  const fast = swingExitState(position).fastEmergency;
  const snapshot = { id: fast.id, armedAt: fast.armedAt, emergencyBreakPrice: fast.emergencyBreakPrice, hardBreakPrice: fast.hardBreakPrice, detectorPrice: fast.detectorPrice, detectorPnlPct: fast.detectorPnlPct, microConfirmations: fast.microConfirmations, recoveryObservations: fast.recoveryObservations, shadow: clone(fast.shadow), resolution, resolvedAt: nowIso(), price: finite(price, fast.lastPrice), pnlPct: finite(pnlPct, fast.lastPnlPct), ...extra };
  Object.assign(fast, defaultFastEmergencyState(), { resolution: snapshot });
  return snapshot;
}

function emergencyMicroEvaluation(fast) {
  const n = CFG.SWING_EMERGENCY_MICRO_WINDOW_TICKS;
  const ticks = fast.ticks.slice(-n);
  if (ticks.length < n || !(fast.emergencyBreakPrice > 0)) return { ready: false, reason: "MICRO_WINDOW_INCOMPLETE", tickCount: ticks.length, requiredTicks: n };
  const prices = ticks.map((t) => t.price);
  const belowCount = prices.filter((v) => v <= fast.emergencyBreakPrice + 1e-9).length;
  const sorted = [...prices].sort((a,b)=>a-b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const early = ticks.slice(0, 3);
  const late = ticks.slice(-3);
  const earlyAverage = early.reduce((a,t)=>a+t.price,0)/early.length;
  const lateAverage = late.reduce((a,t)=>a+t.price,0)/late.length;
  const averageDeclinePct = earlyAverage > 0 ? ((earlyAverage - lateAverage) / earlyAverage) * 100 : 0;
  const latest = ticks[ticks.length - 1];
  const compareTick = ticks[Math.max(0, ticks.length - 3)];
  const bear = featureBearSignals(latest, latest.price, compareTick);
  const recoveryVeto = emergencyMomentumRecoveryVeto(latest, compareTick);
  const qualifies = belowCount >= CFG.SWING_EMERGENCY_MICRO_REQUIRED_BELOW_TICKS && median <= fast.emergencyBreakPrice + 1e-9 && averageDeclinePct + 1e-12 >= CFG.SWING_EMERGENCY_MICRO_MIN_AVG_DECLINE_PCT && bear.signalCount >= CFG.SWING_EMERGENCY_MICRO_MIN_BEAR_SIGNALS && !recoveryVeto;
  return { ready: true, qualifies, reason: qualifies ? "MICRO_DOWNTREND_PERSISTENT" : recoveryVeto ? "MOMENTUM_RECOVERY_VETO" : averageDeclinePct < CFG.SWING_EMERGENCY_MICRO_MIN_AVG_DECLINE_PCT ? "AVERAGE_NOT_DECLINING" : belowCount < CFG.SWING_EMERGENCY_MICRO_REQUIRED_BELOW_TICKS ? "INSUFFICIENT_BELOW_TICKS" : median > fast.emergencyBreakPrice ? "MEDIAN_RECLAIMED" : "INSUFFICIENT_BEAR_SIGNALS", belowCount, requiredBelowCount: CFG.SWING_EMERGENCY_MICRO_REQUIRED_BELOW_TICKS, median: round(median,8), earlyAverage: round(earlyAverage,8), lateAverage: round(lateAverage,8), averageDeclinePct: round(averageDeclinePct,6), minAverageDeclinePct: CFG.SWING_EMERGENCY_MICRO_MIN_AVG_DECLINE_PCT, bearSignals: bear.signals, bearSignalCount: bear.signalCount, recoveryVeto, latest };
}

function updateIntelligent1mShadow(fast, tick, pnlPct) {
  if (!CFG.SWING_EMERGENCY_SHADOW_INTELLIGENT_1M_ENABLED || fast.shadow.intelligent1m.exitLogged) return null;
  const sh = fast.shadow.intelligent1m;
  const minute = Math.floor(tick.barTimeMs / 60000) * 60000;
  if (sh.currentMinute === null) {
    sh.currentMinute = minute; sh.current = tick; return null;
  }
  if (minute === sh.currentMinute) { sh.current = tick; return null; }
  if (minute < sh.currentMinute) return null;
  const closed = sh.current;
  sh.lastFinalizedMinute = sh.currentMinute;
  sh.currentMinute = minute;
  sh.current = tick;
  if (!closed) return null;
  const compareTick = sh.lastClosed;
  const bear = featureBearSignals(closed, closed.price, compareTick);
  const recoveryVeto = emergencyMomentumRecoveryVeto(closed, compareTick);
  const qualifies = closed.price <= fast.emergencyBreakPrice + 1e-9 && bear.signalCount >= CFG.SWING_EMERGENCY_SHADOW_1M_MIN_BEAR_SIGNALS && !recoveryVeto;
  sh.confirmedMinutes = qualifies ? sh.confirmedMinutes + 1 : 0;
  sh.lastClosed = closed;
  log("INFO", "FVVO_SWING_EMERGENCY_INTELLIGENT_1M_SHADOW_OBSERVATION", { fastEmergencyId: fast.id, minuteCloseTime: new Date(sh.lastFinalizedMinute + 60000).toISOString(), price: closed.price, pnlPct: round(percentPnl(state.position?.entryPriceReference || closed.price, closed.price),6), emergencyBreakPrice: fast.emergencyBreakPrice, qualifies, confirmedMinutes: sh.confirmedMinutes, requiredMinutes: CFG.SWING_EMERGENCY_SHADOW_1M_CONFIRM_OBSERVATIONS, bearSignals: bear.signals, recoveryVeto, action: "SHADOW_ONLY_NO_EXIT" });
  if (sh.confirmedMinutes >= CFG.SWING_EMERGENCY_SHADOW_1M_CONFIRM_OBSERVATIONS) {
    sh.exitLogged = true; sh.exitPrice = closed.price; sh.exitPnlPct = round(pnlPct,6); sh.exitAt = nowIso();
    log("WARN", "FVVO_SWING_EMERGENCY_INTELLIGENT_1M_SHADOW_EXIT", { fastEmergencyId: fast.id, price: closed.price, pnlPct: round(percentPnl(state.position?.entryPriceReference || closed.price, closed.price),6), confirmedMinutes: sh.confirmedMinutes, bearSignals: bear.signals, action: "SHADOW_ONLY_NO_EXIT" });
  }
  return { qualifies, bear, recoveryVeto, closed };
}

function evaluateFastEmergency(position, feature, price, pnlPct) {
  const fast = swingExitState(position).fastEmergency;
  if (!fast.active) return { active: false };
  const previousPrice = finite(fast.lastPrice, null);
  fast.lastPrice = round(price,8); fast.lastPnlPct = round(pnlPct,6);
  const current = nowMs();
  const hardByPrice = fast.hardBreakPrice !== null && price <= fast.hardBreakPrice + 1e-9;
  const hardByPnl = pnlPct <= CFG.SWING_EMERGENCY_HARD_EXIT_PNL_PCT + 1e-9;
  if (hardByPnl || (hardByPrice && pnlPct <= 0)) return { active: true, confirmed: CFG.SWING_EMERGENCY_FAST_CONFIRM_MODE === "micro_15s_trend", shadow: CFG.SWING_EMERGENCY_FAST_CONFIRM_MODE === "shadow", reason: hardByPnl ? "SWING_EMERGENCY_FAST_HARD_PNL" : "SWING_EMERGENCY_FAST_HARD_BREAK_LOSS", fast: clone(fast), evidence: { price, pnlPct, hardBreakPrice: fast.hardBreakPrice, hardExitPnlPct: CFG.SWING_EMERGENCY_HARD_EXIT_PNL_PCT } };
  if (feature.kind !== CFG.FVVO_FEATURE_TICK_EVENT) return { active: true, reason: "FAST_EMERGENCY_WAITING_FOR_15S" };
  const barTimeMs = finite(feature.barTimeMs, current);
  if (barTimeMs <= finite(fast.lastEvaluationBarTimeMs, 0)) return { active: true, reason: "FAST_EMERGENCY_DUPLICATE_TICK_IGNORED" };
  fast.lastEvaluationBarTimeMs = barTimeMs;
  const tick = { barTimeMs, price: round(price,8), ema8: finite(feature.ema8,null), ema18: finite(feature.ema18,null), fvvo: finite(feature.fvvo,null), slope: finite(feature.slope,null), rsi: finite(feature.rsi,null), adx: finite(feature.adx,null), rayRegime: String(feature.rayRegime || "RAY_NEUTRAL") };
  fast.ticks.push(tick);
  fast.ticks = fast.ticks.slice(-Math.max(12, CFG.SWING_EMERGENCY_MICRO_WINDOW_TICKS + 4));
  updateIntelligent1mShadow(fast, tick, pnlPct);
  const recoverySignals = [];
  if (fast.detectorPrice !== null && price > fast.detectorPrice + 1e-9) recoverySignals.push("ABOVE_DETECTOR_PRICE");
  if (tick.ema8 !== null && price > tick.ema8 + 1e-9) recoverySignals.push("PRICE_ABOVE_EMA8");
  if (tick.ema8 !== null && tick.ema18 !== null && tick.ema8 > tick.ema18 + 1e-9) recoverySignals.push("EMA8_ABOVE_EMA18");
  if (tick.slope !== null && tick.slope >= 0) recoverySignals.push("SLOPE_NONNEGATIVE");
  if (!String(tick.rayRegime).toUpperCase().startsWith("RAY_BEAR")) recoverySignals.push("RAY_NOT_BEAR");
  const priceRising = previousPrice === null || price > previousPrice + 1e-9;
  const bullishRecovery = recoverySignals.length >= CFG.SWING_EMERGENCY_RECOVERY_CANCEL_MIN_SIGNALS && (!CFG.SWING_EMERGENCY_RECOVERY_REQUIRE_PRICE_RISING || priceRising);
  if (hardByPrice && pnlPct > 0 && bullishRecovery) {
    return { active: false, cancelled: true, reason: "SWING_EMERGENCY_FAST_BULLISH_RECOVERY", evidence: { price, pnlPct, previousPrice, priceRising, recoverySignals, requiredSignals: CFG.SWING_EMERGENCY_RECOVERY_CANCEL_MIN_SIGNALS, hardBreakPrice: fast.hardBreakPrice, tick } };
  }
  if (hardByPrice && pnlPct > 0) {
    if (!fast.profitHardBreakStartedAtMs) fast.profitHardBreakStartedAtMs = current;
    fast.profitHardBreakObservations += 1;
    const elapsedSec = (current - fast.profitHardBreakStartedAtMs) / 1000;
    const confirmed = fast.profitHardBreakObservations >= CFG.SWING_EMERGENCY_PROFIT_HARD_BREAK_CONFIRM_OBSERVATIONS && elapsedSec + 1e-9 >= CFG.SWING_EMERGENCY_PROFIT_HARD_BREAK_MIN_SPAN_SEC;
    log(confirmed ? "WARN" : "INFO", confirmed ? "FVVO_SWING_EMERGENCY_PROFIT_HARD_BREAK_CONFIRMED" : "FVVO_SWING_EMERGENCY_PROFIT_HARD_BREAK_HOLD", { fastEmergencyId: fast.id, price, pnlPct: round(pnlPct,6), hardBreakPrice: fast.hardBreakPrice, observations: fast.profitHardBreakObservations, requiredObservations: CFG.SWING_EMERGENCY_PROFIT_HARD_BREAK_CONFIRM_OBSERVATIONS, elapsedSec: round(elapsedSec,3), requiredSpanSec: CFG.SWING_EMERGENCY_PROFIT_HARD_BREAK_MIN_SPAN_SEC, recoverySignals, priceRising });
    if (confirmed) return { active: true, confirmed: CFG.SWING_EMERGENCY_FAST_CONFIRM_MODE === "micro_15s_trend", shadow: CFG.SWING_EMERGENCY_FAST_CONFIRM_MODE === "shadow", reason: "SWING_EMERGENCY_FAST_PROFIT_HARD_BREAK_CONFIRMED", fast: clone(fast), evidence: { price, pnlPct, hardBreakPrice: fast.hardBreakPrice, observations: fast.profitHardBreakObservations, elapsedSec, recoverySignals, priceRising } };
  } else {
    fast.profitHardBreakObservations = 0;
    fast.profitHardBreakStartedAtMs = 0;
  }
  const reclaimPrice = fast.emergencyBreakPrice * (1 + CFG.SWING_EMERGENCY_RECOVERY_RECLAIM_BUFFER_PCT / 100);
  const recovery = price >= reclaimPrice - 1e-9 && tick.ema8 !== null && price >= tick.ema8 - 1e-9 && tick.slope !== null && tick.slope > 0 && !String(tick.rayRegime).toUpperCase().startsWith("RAY_BEAR");
  fast.recoveryObservations = recovery ? fast.recoveryObservations + 1 : 0;
  if (fast.recoveryObservations >= CFG.SWING_EMERGENCY_RECOVERY_CONFIRM_OBSERVATIONS) return { active: false, cancelled: true, reason: "SWING_EMERGENCY_FAST_RECOVERY_RECLAIM", evidence: { price, pnlPct, reclaimPrice: round(reclaimPrice,8), recoveryObservations: fast.recoveryObservations, tick } };
  const micro = emergencyMicroEvaluation(fast);
  if (micro.ready) {
    fast.microConfirmations = micro.qualifies ? fast.microConfirmations + 1 : 0;
    if (micro.qualifies) log("WARN", "FVVO_SWING_EMERGENCY_MICRO_CONFIRMING", { fastEmergencyId: fast.id, price, pnlPct: round(pnlPct,6), emergencyBreakPrice: fast.emergencyBreakPrice, observations: fast.microConfirmations, requiredObservations: CFG.SWING_EMERGENCY_MICRO_CONFIRM_OBSERVATIONS, micro });
    else if (fast.lastMicroReason !== micro.reason) log("INFO", "FVVO_SWING_EMERGENCY_MICRO_HOLD", { fastEmergencyId: fast.id, price, pnlPct: round(pnlPct,6), emergencyBreakPrice: fast.emergencyBreakPrice, reason: micro.reason, microConfirmations: fast.microConfirmations, micro });
    fast.lastMicroReason = micro.reason;
    if (fast.microConfirmations >= CFG.SWING_EMERGENCY_MICRO_CONFIRM_OBSERVATIONS) return { active: true, confirmed: CFG.SWING_EMERGENCY_FAST_CONFIRM_MODE === "micro_15s_trend", shadow: CFG.SWING_EMERGENCY_FAST_CONFIRM_MODE === "shadow", reason: "SWING_EMERGENCY_FAST_MICRO_15S_CONFIRMED", fast: clone(fast), evidence: micro };
  }
  if (current >= fast.expiresAtMs) {
    const latest = fast.ticks[fast.ticks.length - 1] || tick;
    const compare = fast.ticks.length >= 3 ? fast.ticks[fast.ticks.length - 3] : null;
    const bear = featureBearSignals(latest, latest.price, compare);
    const recoveryVeto = emergencyMomentumRecoveryVeto(latest, compare);
    const timeoutExit = latest.price <= fast.emergencyBreakPrice + 1e-9 && bear.signalCount >= CFG.SWING_EMERGENCY_TIMEOUT_EXIT_MIN_BEAR_SIGNALS && !recoveryVeto;
    return timeoutExit ? { active: true, confirmed: CFG.SWING_EMERGENCY_FAST_CONFIRM_MODE === "micro_15s_trend", shadow: CFG.SWING_EMERGENCY_FAST_CONFIRM_MODE === "shadow", reason: "SWING_EMERGENCY_FAST_TIMEOUT_BEARISH", fast: clone(fast), evidence: { bearSignals: bear.signals, recoveryVeto, latest } } : { active: false, cancelled: true, reason: "SWING_EMERGENCY_FAST_TIMEOUT_NOT_CONFIRMED", evidence: { bearSignals: bear.signals, recoveryVeto, latest } };
  }
  return { active: true, confirmed: false, reason: "SWING_EMERGENCY_FAST_MONITORING", micro, recoveryObservations: fast.recoveryObservations };
}

function swingStructureExitDecision(position, feature, price, pnlPct) {
  const mode = swingStructureExitMode();
  const stateSwing = swingExitState(position);
  const heldSec = Math.max(0, (nowMs() - finite(position.openedAtMs, nowMs())) / 1000);
  const peak = Math.max(finite(position.peakPnlPct, 0), finite(position.dynamicProfit?.peakPnlPct, 0));
  if (mode === "disabled") return { confirmed: false, shadow: false, reason: "SWING_STRUCTURE_DISABLED", heldSec, peakPnlPct: peak };
  if (feature.kind !== CFG.FVVO_FEATURE_5M_EVENT) return { confirmed: false, shadow: false, reason: "SWING_STRUCTURE_REQUIRES_5M", heldSec, peakPnlPct: peak };
  const evidence = swingDeteriorationEvidence(feature, price);

  if (heldSec >= CFG.SWING_HARD_MAX_HOLD_SEC) {
    return { confirmed: mode === "live", shadow: mode === "shadow", reason: "SWING_HARD_MAX_HOLD", heldSec, peakPnlPct: peak, pnlPct, evidence };
  }

  const emergencyEligible = peak + 1e-9 >= CFG.SWING_STRUCTURE_MIN_MFE_PCT && evidence.closeBelowEmergency && (evidence.signals.includes("RAY_BEAR") || evidence.signals.includes("FVVO_CROSS_DOWN") || evidence.signals.includes("EMA8_BELOW_OR_EQUAL_EMA18"));
  if (emergencyEligible) {
    const c = incrementSwingCounter(stateSwing.emergency, evidence);
    if (c.observations >= CFG.SWING_STRUCTURE_EMERGENCY_CONFIRM_5M_OBSERVATIONS) {
      if (CFG.SWING_EMERGENCY_FAST_CONFIRM_MODE === "disabled") return { confirmed: mode === "live", shadow: mode === "shadow", reason: "SWING_EMERGENCY_EMA18_STRUCTURE_BREAK", heldSec, peakPnlPct: peak, pnlPct, evidence, ...c };
      const armed = armFastEmergency(position, feature, price, pnlPct, evidence);
      resetSwingCounter(stateSwing.emergency);
      return { confirmed: false, shadow: false, armedFastEmergency: true, armedNow: armed.armedNow, reason: "SWING_EMERGENCY_FAST_CONFIRM_PENDING", heldSec, peakPnlPct: peak, pnlPct, evidence, fastEmergencyId: armed.fast.id, observations: c.observations };
    }
  } else if (!stateSwing.fastEmergency.active) resetSwingCounter(stateSwing.emergency);

  const normalEligible = peak + 1e-9 >= CFG.SWING_STRUCTURE_MIN_MFE_PCT && pnlPct + 1e-9 >= CFG.SWING_STRUCTURE_MIN_CURRENT_PNL_PCT && evidence.closeRequirement && evidence.emaRequirement && evidence.rayRequirement && evidence.signalCount >= CFG.SWING_STRUCTURE_MIN_DETERIORATION_SIGNALS;
  if (normalEligible) {
    const c = incrementSwingCounter(stateSwing.structure, evidence);
    if (c.observations >= CFG.SWING_STRUCTURE_CONFIRM_5M_OBSERVATIONS) return { confirmed: mode === "live", shadow: mode === "shadow", reason: "SWING_CONFIRMED_5M_STRUCTURE_DETERIORATION", heldSec, peakPnlPct: peak, pnlPct, evidence, ...c };
  } else resetSwingCounter(stateSwing.structure);

  const weakStructure = evidence.signalCount >= CFG.SWING_STRUCTURE_MIN_DETERIORATION_SIGNALS && (evidence.closeBelowNormal || evidence.signals.includes("EMA8_BELOW_OR_EQUAL_EMA18"));
  const noProgressEligible = heldSec >= CFG.SWING_NO_PROGRESS_CHECK_AFTER_SEC && peak <= CFG.SWING_NO_PROGRESS_MAX_MFE_PCT + 1e-9 && pnlPct <= CFG.SWING_NO_PROGRESS_MAX_CURRENT_PNL_PCT + 1e-9 && (!CFG.SWING_NO_PROGRESS_REQUIRE_WEAK_STRUCTURE || weakStructure);
  if (noProgressEligible) {
    const c = incrementSwingCounter(stateSwing.noProgress, evidence);
    if (c.observations >= CFG.SWING_NO_PROGRESS_CONFIRM_5M_OBSERVATIONS) return { confirmed: mode === "live", shadow: mode === "shadow", reason: "SWING_NO_PROGRESS_WEAK_STRUCTURE", heldSec, peakPnlPct: peak, pnlPct, evidence, ...c };
  } else resetSwingCounter(stateSwing.noProgress);

  return { confirmed: false, shadow: false, reason: "SWING_STRUCTURE_HOLD", heldSec, peakPnlPct: peak, pnlPct, evidence, observations: { structure: stateSwing.structure.observations, emergency: stateSwing.emergency.observations, noProgress: stateSwing.noProgress.observations } };
}

function evaluateYellowTpShadow(feature) {
  const p = state.position;
  if (!CFG.YELLOW_TP_SHADOW_ENABLED || !p || String(p.lifecycle || "").startsWith("EXIT_") || feature.yellowPulse !== true) return false;
  const price = firstFinite(feature.price, feature.close);
  if (!Number.isFinite(price) || price <= 0) return false;
  const pnlPct = percentPnl(p.entryPriceReference, price);
  const peakPnlPct = Math.max(finite(p.peakPnlPct, 0), finite(p.dynamicProfit?.peakPnlPct, 0));
  if (peakPnlPct + 1e-9 < CFG.YELLOW_TP_SHADOW_MIN_MFE_PCT || pnlPct + 1e-9 < CFG.YELLOW_TP_SHADOW_MIN_PNL_PCT) return false;
  log("INFO", "FVVO_YELLOW_TP_SHADOW_CANDIDATE", { price, pnlPct: round(pnlPct, 6), peakPnlPct: round(peakPnlPct, 6), yellowReason: feature.yellowReason || null, runnerHoldActive: Boolean(p.dynamicProfit?.runner?.holdActive), runnerTightTrailArmed: Boolean(p.dynamicProfit?.runner?.tightTrailArmed), action: "NO_EXIT_SHADOW_ONLY" });
  return true;
}

function intelligentTpBearEvidence(feature, price) {
  const signals = [];
  if (finite(feature.fvvo, null) !== null && feature.fvvo <= 0) signals.push("FVVO_NON_POSITIVE");
  if (finite(feature.slope, null) !== null && feature.slope <= 0) signals.push("SLOPE_NON_POSITIVE");
  if (String(feature.rayRegime || "").toUpperCase().includes("BEAR")) signals.push("RAY_BEAR");
  if (finite(feature.ema8, null) !== null && price < feature.ema8) signals.push("BELOW_EMA8");
  if (feature.crossDown) signals.push("CROSS_DOWN");
  return { count: signals.length, signals };
}

function intelligentTpContinuationEvidence(feature, price, threshold, tp3Strong = false) {
  const fvvo = finite(feature.fvvo, null), slope = finite(feature.slope, null), ema8 = finite(feature.ema8, null);
  const priceOk = price + 1e-9 >= threshold;
  const fvvoOk = !CFG.INTELLIGENT_TP_REQUIRE_POSITIVE_FVVO || (fvvo !== null && fvvo >= (tp3Strong ? CFG.INTELLIGENT_TP3_RUNNER_MIN_FVVO : 0));
  const slopeOk = !CFG.INTELLIGENT_TP_REQUIRE_POSITIVE_SLOPE || (slope !== null && slope >= (tp3Strong ? CFG.INTELLIGENT_TP3_RUNNER_MIN_SLOPE : 0));
  const rayOk = !CFG.INTELLIGENT_TP_REQUIRE_RAY_NOT_BEAR || !String(feature.rayRegime || "").toUpperCase().includes("BEAR");
  const ema8Ok = !CFG.INTELLIGENT_TP_REQUIRE_ABOVE_EMA8 || ema8 === null || price + 1e-9 >= ema8;
  return { qualifies: priceOk && fvvoOk && slopeOk && rayOk && ema8Ok, priceOk, fvvoOk, slopeOk, rayOk, ema8Ok, fvvo, slope, ema8, rayRegime: feature.rayRegime || null };
}

function intelligentTpRecordCandidate(position, stateTp, reason, price, feature, extra = {}) {
  if (stateTp.shadowExitCandidate) return stateTp.shadowExitCandidate;
  const candidate = { reason, price: round(price, 8), pnlPct: round(percentPnl(position.entryPriceReference, price), 6), at: nowIso(), atMs: nowMs(), featureKind: feature.kind, ...extra };
  stateTp.shadowExitCandidate = candidate;
  stateTp.phase = "SHADOW_EXIT_CANDIDATE";
  stateTp.history.push({ type: "SHADOW_EXIT_CANDIDATE", ...candidate });
  stateTp.history = stateTp.history.slice(-20);
  log("WARN", CFG.INTELLIGENT_TP_MODE === "live" ? "FVVO_INTELLIGENT_TP_LIVE_EXIT_CONFIRMED" : "FVVO_INTELLIGENT_TP_SHADOW_EXIT_CANDIDATE", { ...candidate, tp1Price: stateTp.tp1Price, tp2Price: stateTp.tp2Price, tp3Price: stateTp.tp3Price, mode: CFG.INTELLIGENT_TP_MODE, action: CFG.INTELLIGENT_TP_MODE === "live" ? "EXIT_LONG_100_PERCENT" : "NO_EXIT_CHANGE_SHADOW_ONLY", exitPercent: 100 });
  return candidate;
}

function evaluateIntelligentTpShadow(position, feature, price) {
  const t = position?.intelligentTp;
  if (!t?.enabled || CFG.INTELLIGENT_TP_MODE === "disabled" || t.shadowExitCandidate) return null;
  const levels = [t.tp1Price, t.tp2Price, t.tp3Price];
  if (!levels.every((x) => finite(x, 0) > 0)) return null;
  const current = nowMs();
  const bear = intelligentTpBearEvidence(feature, price);

  if (t.runnerActive) {
    t.runnerPeakPrice = Math.max(finite(t.runnerPeakPrice, price), price);
    const initialFloor = t.tp3Price * (1 - CFG.INTELLIGENT_TP3_RUNNER_INITIAL_FLOOR_BELOW_TP3_PCT / 100);
    const trailingFloor = t.runnerPeakPrice * (1 - CFG.INTELLIGENT_TP3_RUNNER_TRAIL_GIVEBACK_PCT / 100);
    t.runnerFloorPrice = round(Math.max(initialFloor, trailingFloor), 8);
    const hardFloor = t.runnerFloorPrice * (1 - CFG.INTELLIGENT_TP3_RUNNER_HARD_BREAK_PCT / 100);
    if (price <= hardFloor + 1e-9) return intelligentTpRecordCandidate(position, t, "TP3_RUNNER_HARD_FLOOR_BREAK", price, feature, { runnerPeakPrice: t.runnerPeakPrice, runnerFloorPrice: t.runnerFloorPrice, bear });
    if (price <= t.runnerFloorPrice + 1e-9 && bear.count >= CFG.INTELLIGENT_TP_REJECTION_MIN_BEAR_SIGNALS) t.floorObservations = Math.max(0, finite(t.floorObservations, 0)) + 1;
    else t.floorObservations = 0;
    if (t.floorObservations >= CFG.INTELLIGENT_TP_PROTECTION_CONFIRM_OBSERVATIONS) return intelligentTpRecordCandidate(position, t, "TP3_RUNNER_TRAIL_CONFIRMED", price, feature, { runnerPeakPrice: t.runnerPeakPrice, runnerFloorPrice: t.runnerFloorPrice, bear });
    if (current - finite(t.runnerStartedAtMs, current) >= CFG.INTELLIGENT_TP3_RUNNER_MAX_SEC * 1000) return intelligentTpRecordCandidate(position, t, "TP3_RUNNER_MAX_DURATION", price, feature, { runnerPeakPrice: t.runnerPeakPrice, runnerFloorPrice: t.runnerFloorPrice, bear });
    return null;
  }

  if (t.peakTrailActive && CFG.INTELLIGENT_TP2_PEAK_TRAIL_ENABLED) {
    t.peakTrailPeakPrice = Math.max(finite(t.peakTrailPeakPrice, price), price);
    t.peakTrailFloorPrice = round(t.peakTrailPeakPrice * (1 - CFG.INTELLIGENT_TP2_PEAK_TRAIL_GIVEBACK_PCT / 100), 8);
  }
  if (!t.runnerActive && CFG.INTELLIGENT_TP3_NEAR_MISS_ENABLED && finite(t.currentIndex, 0) === 2 && price < t.tp3Price && price + 1e-9 >= t.tp3Price * (1 - CFG.INTELLIGENT_TP3_NEAR_MISS_DISTANCE_PCT / 100)) {
    if (!t.nearMissActive) log("INFO", CFG.INTELLIGENT_TP_MODE === "live" ? "FVVO_INTELLIGENT_TP_LIVE_TP3_NEAR_MISS_ARMED" : "FVVO_INTELLIGENT_TP_SHADOW_TP3_NEAR_MISS_ARMED", { tp3Price: t.tp3Price, price, distancePct: round(percentPnl(price, t.tp3Price), 6), action: "TIGHTEN_PEAK_PROTECTION_WITHOUT_DECLARING_TP3_HIT" });
    t.nearMissActive = true;
    t.nearMissPeakPrice = Math.max(finite(t.nearMissPeakPrice, price), price);
    t.nearMissFloorPrice = round(t.nearMissPeakPrice * (1 - CFG.INTELLIGENT_TP3_NEAR_MISS_TRAIL_GIVEBACK_PCT / 100), 8);
  } else if (t.nearMissActive) {
    t.nearMissPeakPrice = Math.max(finite(t.nearMissPeakPrice, price), price);
    t.nearMissFloorPrice = round(t.nearMissPeakPrice * (1 - CFG.INTELLIGENT_TP3_NEAR_MISS_TRAIL_GIVEBACK_PCT / 100), 8);
  }

  const floorOptions = [
    { source: t.protectedByTarget ? `${t.protectedByTarget}_PROTECTED` : "STATIC_PROTECTED", price: finite(t.protectedFloorPrice, 0), hardBreakPct: CFG.INTELLIGENT_TP_PROTECTION_HARD_BREAK_PCT },
    { source: "DYNAMIC_PROFIT", price: finite(position.dynamicProfit?.protectedPrice, 0), hardBreakPct: CFG.INTELLIGENT_TP_PROTECTION_HARD_BREAK_PCT },
    { source: "RUNNER", price: finite(position.dynamicProfit?.runner?.protectedPrice, 0), hardBreakPct: CFG.INTELLIGENT_TP_PROTECTION_HARD_BREAK_PCT },
    { source: "TP1_COST_AWARE", price: finite(t.costAwareFloorPrice, 0), hardBreakPct: 0 },
    { source: "TP2_PEAK_TRAIL", price: finite(t.peakTrailFloorPrice, 0), hardBreakPct: CFG.INTELLIGENT_TP2_PEAK_TRAIL_HARD_BREAK_PCT },
    { source: "TP3_NEAR_MISS_TRAIL", price: finite(t.nearMissFloorPrice, 0), hardBreakPct: CFG.INTELLIGENT_TP3_NEAR_MISS_HARD_BREAK_PCT },
  ].filter((x) => x.price > 0).sort((a, b) => b.price - a.price);
  if (floorOptions.length) {
    const strongest = floorOptions[0];
    const effectiveFloor = strongest.price;
    const hardFloor = effectiveFloor * (1 - strongest.hardBreakPct / 100);
    const details = { floorSource: strongest.source, effectiveFloor, hardFloor: round(hardFloor, 8), protectedFloorPrice: t.protectedFloorPrice, costAwareFloorPrice: t.costAwareFloorPrice, peakTrailPeakPrice: t.peakTrailPeakPrice, peakTrailFloorPrice: t.peakTrailFloorPrice, nearMissPeakPrice: t.nearMissPeakPrice, nearMissFloorPrice: t.nearMissFloorPrice, bear };
    if (price <= hardFloor + 1e-9) return intelligentTpRecordCandidate(position, t, `${strongest.source}_HARD_FLOOR_BREAK`, price, feature, details);
    if (price <= effectiveFloor + 1e-9 && bear.count >= CFG.INTELLIGENT_TP_REJECTION_MIN_BEAR_SIGNALS) t.floorObservations = Math.max(0, finite(t.floorObservations, 0)) + 1;
    else t.floorObservations = 0;
    if (t.floorObservations >= CFG.INTELLIGENT_TP_PROTECTION_CONFIRM_OBSERVATIONS) return intelligentTpRecordCandidate(position, t, `${strongest.source}_FLOOR_BREAK`, price, feature, details);
  }

  const index = Math.max(0, Math.min(2, Math.floor(finite(t.currentIndex, 0))));
  const target = levels[index];
  const label = `TP${index + 1}`;
  const breakoutBuffer = [CFG.INTELLIGENT_TP1_BREAKOUT_BUFFER_PCT, CFG.INTELLIGENT_TP2_BREAKOUT_BUFFER_PCT, CFG.INTELLIGENT_TP3_BREAKOUT_BUFFER_PCT][index];
  const rejectionBuffer = [CFG.INTELLIGENT_TP1_REJECTION_BUFFER_PCT, CFG.INTELLIGENT_TP2_REJECTION_BUFFER_PCT, CFG.INTELLIGENT_TP3_REJECTION_BUFFER_PCT][index];
  if (t.phase === "WATCH_TARGET" && price + 1e-9 >= target) {
    Object.assign(t, { phase: "DECISION_WINDOW", touchedAtMs: current, touchedAt: nowIso(), breakoutObservations: 0, rejectionObservations: 0 });
    if (index === 0 && CFG.INTELLIGENT_TP1_COST_AWARE_FLOOR_ENABLED) t.costAwareFloorPrice = round(position.entryPriceReference * (1 + (Math.max(0, CFG.PNL_ESTIMATED_ROUND_TRIP_COST_PCT) + CFG.INTELLIGENT_TP1_MIN_NET_LOCK_PCT) / 100), 8);
    t.history.push({ type: "TARGET_TOUCHED", target: label, price: round(price, 8), at: nowIso() });
    log("INFO", CFG.INTELLIGENT_TP_MODE === "live" ? "FVVO_INTELLIGENT_TP_LIVE_TARGET_TOUCHED" : "FVVO_INTELLIGENT_TP_SHADOW_TARGET_TOUCHED", { target: label, targetPrice: target, price, costAwareFloorPrice: t.costAwareFloorPrice, immediateFixedTpPnlPct: round(percentPnl(position.entryPriceReference, price), 6), action: CFG.INTELLIGENT_TP_MODE === "live" ? "WAIT_BREAKOUT_OR_REJECTION_LIVE_MANAGED" : "WAIT_BREAKOUT_OR_REJECTION_SHADOW_ONLY" });
  }
  if (t.phase !== "DECISION_WINDOW") return null;
  const breakoutThreshold = target * (1 + breakoutBuffer / 100);
  const rejectionFloor = target * (1 - rejectionBuffer / 100);
  const continuation = intelligentTpContinuationEvidence(feature, price, breakoutThreshold, index === 2);
  t.breakoutObservations = continuation.qualifies ? t.breakoutObservations + 1 : 0;
  t.rejectionObservations = price <= rejectionFloor + 1e-9 && bear.count >= CFG.INTELLIGENT_TP_REJECTION_MIN_BEAR_SIGNALS ? t.rejectionObservations + 1 : 0;
  if (t.rejectionObservations >= CFG.INTELLIGENT_TP_CONFIRM_OBSERVATIONS) return intelligentTpRecordCandidate(position, t, `${label}_REJECTION_CONFIRMED`, price, feature, { targetPrice: target, rejectionFloor: round(rejectionFloor, 8), bear });
  if (t.breakoutObservations >= CFG.INTELLIGENT_TP_CONFIRM_OBSERVATIONS) {
    if (index === 2) {
      if (!CFG.INTELLIGENT_TP3_RUNNER_ENABLED) return intelligentTpRecordCandidate(position, t, "TP3_CLEAN_BREAKOUT_RUNNER_DISABLED", price, feature, { targetPrice: target, continuation });
      Object.assign(t, { phase: "TP3_RUNNER", runnerActive: true, runnerStartedAtMs: current, runnerPeakPrice: price, runnerFloorPrice: round(target * (1 - CFG.INTELLIGENT_TP3_RUNNER_INITIAL_FLOOR_BELOW_TP3_PCT / 100), 8), floorObservations: 0, highestConfirmedIndex: 2 });
      t.history.push({ type: "CLEAN_BREAKOUT", target: label, price: round(price, 8), at: nowIso(), runner: true });
      log("INFO", "FVVO_INTELLIGENT_TP_SHADOW_TP3_RUNNER_ARMED", { targetPrice: target, price, runnerFloorPrice: t.runnerFloorPrice, continuation, action: "NO_EXIT_CHANGE_SHADOW_ONLY" });
      return null;
    }
    t.highestConfirmedIndex = index;
    t.protectedByTarget = label;
    t.protectedFloorPrice = round(target * (1 - CFG.INTELLIGENT_TP_PROTECTION_BUFFER_PCT / 100), 8);
    if (index === 1 && CFG.INTELLIGENT_TP2_PEAK_TRAIL_ENABLED) Object.assign(t, { peakTrailActive: true, peakTrailPeakPrice: price, peakTrailFloorPrice: round(price * (1 - CFG.INTELLIGENT_TP2_PEAK_TRAIL_GIVEBACK_PCT / 100), 8) });
    t.currentIndex = index + 1;
    Object.assign(t, { phase: "WATCH_TARGET", touchedAtMs: 0, touchedAt: null, breakoutObservations: 0, rejectionObservations: 0, floorObservations: 0 });
    t.history.push({ type: "CLEAN_BREAKOUT", target: label, price: round(price, 8), at: nowIso(), protectedFloorPrice: t.protectedFloorPrice });
    log("INFO", CFG.INTELLIGENT_TP_MODE === "live" ? "FVVO_INTELLIGENT_TP_LIVE_CLEAN_BREAKOUT" : "FVVO_INTELLIGENT_TP_SHADOW_CLEAN_BREAKOUT", { target: label, targetPrice: target, price, nextTarget: `TP${index + 2}`, protectedFloorPrice: t.protectedFloorPrice, peakTrailFloorPrice: t.peakTrailFloorPrice, continuation, action: CFG.INTELLIGENT_TP_MODE === "live" ? "HOLD_100_PERCENT_LIVE_MANAGED" : "HOLD_100_PERCENT_SHADOW_ONLY" });
    return null;
  }
  if (current - finite(t.touchedAtMs, current) >= CFG.INTELLIGENT_TP_DECISION_WINDOW_SEC * 1000 && price <= target + 1e-9 && bear.count >= CFG.INTELLIGENT_TP_REJECTION_MIN_BEAR_SIGNALS) return intelligentTpRecordCandidate(position, t, `${label}_DECISION_TIMEOUT_WEAK`, price, feature, { targetPrice: target, bear });
  return null;
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
  p.maxAdverseExcursionPct = Math.min(finite(p.maxAdverseExcursionPct, 0), pnl);

  const dynamicUpdate = updateDynamicProfit(p, price, pnl);
  const d = dynamicUpdate.dynamic;
  if (dynamicUpdate.armedNow) {
    log("INFO", "FVVO_DYNAMIC_PROFIT_ARMED", { entryPrice: p.entryPriceReference, armMfePct: CFG.DYNAMIC_PROFIT_ARM_MFE_PCT, armObservedPnlPct: d.armedAtPnlPct, protectedPnlPct: d.protectedPnlPct, protectedPrice: d.protectedPrice, price });
  }
  if (dynamicUpdate.floorRaised && d.protectedPnlPct >= finite(d.lastLoggedProtectedPnlPct, 0) + CFG.DYNAMIC_PROFIT_FLOOR_LOG_STEP_PCT - 1e-9) {
    d.lastLoggedProtectedPnlPct = d.protectedPnlPct;
    log("INFO", "FVVO_DYNAMIC_PROFIT_FLOOR_RAISED", { peakPnlPct: d.peakPnlPct, protectedPnlPct: d.protectedPnlPct, protectedPrice: d.protectedPrice, price, allowedGivebackPct: round(d.peakPnlPct - d.protectedPnlPct, 6) });
  }

  const runnerUpdate = updateRunnerExit(p, price);
  const runner = runnerUpdate.runner;
  if (runnerUpdate.holdActivatedNow) {
    log("INFO", runnerLiveEnabled() ? "FVVO_RUNNER_HOLD_ARMED" : "FVVO_RUNNER_HOLD_SHADOW_ARMED", { entryPrice: p.entryPriceReference, peakPnlPct: d.peakPnlPct, holdMinMfePct: CFG.RUNNER_HOLD_MIN_MFE_PCT, mode: CFG.RUNNER_EXIT_MODE, price });
  }
  if (runnerUpdate.tightTrailArmedNow) {
    log("INFO", runnerLiveEnabled() ? "FVVO_RUNNER_TIGHT_TRAIL_ARMED" : "FVVO_RUNNER_TIGHT_TRAIL_SHADOW_ARMED", { entryPrice: p.entryPriceReference, peakPnlPct: d.peakPnlPct, armMfePct: CFG.RUNNER_TIGHT_TRAIL_ARM_MFE_PCT, protectedPnlPct: runner.protectedPnlPct, protectedPrice: runner.protectedPrice, givebackPct: CFG.RUNNER_TIGHT_TRAIL_GIVEBACK_PCT, mode: CFG.RUNNER_EXIT_MODE, price });
  }
  if (runnerUpdate.floorRaised && runner.tightTrailArmed && runner.protectedPnlPct >= finite(runner.lastLoggedProtectedPnlPct, 0) + CFG.RUNNER_TIGHT_TRAIL_LOG_STEP_PCT - 1e-9) {
    runner.lastLoggedProtectedPnlPct = runner.protectedPnlPct;
    log("INFO", runnerLiveEnabled() ? "FVVO_RUNNER_TIGHT_TRAIL_RAISED" : "FVVO_RUNNER_TIGHT_TRAIL_SHADOW_RAISED", { peakPnlPct: d.peakPnlPct, protectedPnlPct: runner.protectedPnlPct, protectedPrice: runner.protectedPrice, price, allowedGivebackPct: CFG.RUNNER_TIGHT_TRAIL_GIVEBACK_PCT, mode: CFG.RUNNER_EXIT_MODE });
  }

  const intelligentTpCandidate = evaluateIntelligentTpShadow(p, feature, price);
  if (intelligentTpCandidate && CFG.INTELLIGENT_TP_MODE === "live") {
    await persistState(`intelligent_tp_live_${intelligentTpCandidate.reason}`);
    await requestFullExit(`FVVO_INTELLIGENT_TP_${intelligentTpCandidate.reason}`, price, feature.kind);
    return;
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

  // v1y: strict loss-side thesis failure is subordinate to the manual stop but can audit/exit before the full stop if an unprotected trade clearly breaks down.
  const lossSide = lossSideThesisFailureConfirmed(p, feature, price, pnl);
  if (lossSide.confirmed) {
    const mode = lossSideThesisFailMode();
    if (mode === "shadow") {
      const ls = lossSideThesisState(p);
      if (!ls.shadowLogged) {
        ls.shadowLogged = true;
        log("WARN", "FVVO_LOSS_SIDE_THESIS_FAIL_SHADOW_CANDIDATE", { entryPrice: p.entryPriceReference, entryOrigin: p.entryOrigin, price, latestPnlPct: round(pnl, 6), peakPnlPct: round(p.peakPnlPct, 6), stopPrice: p.stopPrice, stopDistanceRemainingPct: round(percentageBelow(price, p.stopPrice), 6), minLossPct: CFG.LOSS_SIDE_THESIS_FAIL_MIN_LOSS_PCT, requiredObservations: CFG.LOSS_SIDE_THESIS_FAIL_CONFIRM_OBSERVATIONS, observations: lossSide.observations, evidence: lossSide.evidence, action: "NO_EXIT_CHANGE_SHADOW_ONLY" });
      }
    } else if (mode === "live") {
      await persistState(`loss_side_thesis_fail_${feature.kind}`);
      await requestFullExit(`FVVO_LOSS_SIDE_THESIS_FAIL_${lossSide.reason}`, price, feature.kind);
      return;
    }
  }

  // Profit floor is a hard protection after the +0.45% (default) arm threshold.
  const floor = dynamicFloorBreakConfirmed(p, price, pnl);
  if (!floor.confirmed && floor.reason === "DYNAMIC_PROFIT_FLOOR_CONFIRM" && Number(floor.observations || 0) > 0) {
    if (Number(floor.observations || 0) === 1) armProfitFloorMicroShadow(p, feature, price, pnl, floor);
    log("WARN", "FVVO_DYNAMIC_PROFIT_FLOOR_BREACH_CONFIRMING", { price, latestPnlPct: round(pnl, 6), peakPnlPct: round(p.peakPnlPct, 6), protectedPnlPct: floor.protectedPnlPct, protectedPrice: floor.protectedPrice, observations: floor.observations, requiredObservations: CFG.DYNAMIC_PROFIT_FLOOR_CONFIRM_OBSERVATIONS, elapsedSec: floor.elapsedSec, requiredSec: CFG.DYNAMIC_PROFIT_FLOOR_CONFIRM_SEC, pnlAudit: pnlAudit(p, price) });
  }
  if (floor.confirmed) {
    await persistState(`dynamic_profit_floor_${feature.kind}`);
    await requestFullExit(`FVVO_DYNAMIC_PROFIT_FLOOR_HIT_${floor.reason}`, price, feature.kind);
    return;
  }

  // v1t: active rescue is always subordinate to the manual stop and normal dynamic floor above.
  const activeRunnerRescue = evaluateRunnerContinuationRescue(p, feature, price, pnl);
  if (activeRunnerRescue.resolved) {
    if (activeRunnerRescue.action === "RECOVERY_CONTINUE") {
      await persistState(`runner_continuation_rescue_recovery_continue_${feature.kind}`);
      log("INFO", "FVVO_RUNNER_CONTINUATION_RESCUE_RECOVERY_CONTINUE", { entryPrice: p.entryPriceReference, price, latestPnlPct: round(pnl, 6), baselineExitPrice: activeRunnerRescue.baselineExitPrice, baselinePnlPct: activeRunnerRescue.baselinePnlPct, baselineProtectedPrice: activeRunnerRescue.baselineProtectedPrice || null, context5m: activeRunnerRescue.context });
      return;
    }
    await persistState(`runner_continuation_rescue_${activeRunnerRescue.action.toLowerCase()}_${feature.kind}`);
    const runnerRescueReason = activeRunnerRescue.action === "PINK_BREAK" ? "FVVO_RUNNER_CONTINUATION_RESCUE_PINK_EMA18_BREAK" : activeRunnerRescue.action === "HARD_LOCK" ? "FVVO_RUNNER_CONTINUATION_RESCUE_HARD_LOCK" : activeRunnerRescue.action === "CONTEXT_STALE" ? "FVVO_RUNNER_CONTINUATION_RESCUE_CONTEXT_STALE" : "FVVO_RUNNER_CONTINUATION_RESCUE_TIMEOUT";
    await requestFullExit(runnerRescueReason, price, feature.kind);
    return;
  }
  if (activeRunnerRescue.active) { await persistState(`runner_continuation_rescue_hold_${feature.kind}`); return; }

  // A strong runner has a separate full-position tight trail. It remains subordinate to the manual stop and normal dynamic floor above.
  const runnerTrail = runnerTightTrailBreakConfirmed(p, feature, price, pnl);
  if (!runnerTrail.confirmed && runnerTrail.reason === "RUNNER_TIGHT_TRAIL_CONFIRM" && Number(runnerTrail.observations || 0) > 0) {
    log("WARN", "FVVO_RUNNER_TIGHT_TRAIL_BREACH_CONFIRMING", { price, latestPnlPct: round(pnl, 6), peakPnlPct: round(p.peakPnlPct, 6), protectedPnlPct: runnerTrail.protectedPnlPct, protectedPrice: runnerTrail.protectedPrice, observations: runnerTrail.observations, requiredObservations: CFG.RUNNER_TIGHT_TRAIL_CONFIRM_OBSERVATIONS, elapsedSec: runnerTrail.elapsedSec, requiredSec: CFG.RUNNER_TIGHT_TRAIL_CONFIRM_SEC, pnlAudit: pnlAudit(p, price) });
  }
  if (runnerTrail.confirmed) {
    const baselineExitReason = `FVVO_RUNNER_TIGHT_TRAIL_HIT_${runnerTrail.reason}`;
    const runnerRescueCheck = runnerContinuationRescueEligible(p, feature, price, pnl);
    const runnerRescueMode = runnerContinuationRescueMode();
    const gateAudit = runnerContinuationRescueAuditSummary(runnerRescueCheck, feature, price);
    if (!runnerRescueCheck.ok && runnerRescueMode !== "disabled") {
      log("WARN", "FVVO_RUNNER_CONTINUATION_RESCUE_REJECTED", { entryPrice: p.entryPriceReference, entryOrigin: p.entryOrigin, price, latestPnlPct: round(pnl, 6), peakPnlPct: round(finite(runnerRescueCheck.peakPnlPct, p.peakPnlPct), 6), baselineExitReason, protectedPnlPct: runnerTrail.protectedPnlPct, protectedPrice: runnerTrail.protectedPrice, rescueMode: runnerRescueMode, rejectionReason: runnerRescueCheck.reason, strict5mEligible: gateAudit.strict5mEligible, strict5m: gateAudit.strict5m, fastTickProxy: gateAudit.fastTickProxy, divergence: gateAudit.divergence, action: "BASELINE_RUNNER_EXIT_REMAINS_ACTIVE" });
    }
    if (runnerRescueCheck.ok && runnerRescueMode === "shadow") {
      log("INFO", "FVVO_RUNNER_CONTINUATION_RESCUE_SHADOW_CANDIDATE", { entryPrice: p.entryPriceReference, entryOrigin: p.entryOrigin, price, latestPnlPct: round(pnl, 6), peakPnlPct: round(runnerRescueCheck.peakPnlPct, 6), baselineExitReason, protectedPnlPct: runnerTrail.protectedPnlPct, protectedPrice: runnerTrail.protectedPrice, maxGraceSec: CFG.RUNNER_CONTINUATION_RESCUE_MAX_SEC, minHardLockPnlPct: CFG.RUNNER_CONTINUATION_RESCUE_MIN_HARD_LOCK_PNL_PCT, pinkEma18: runnerRescueCheck.context.ema18, pinkPrice: runnerRescueCheck.context.pinkPrice, context5m: runnerRescueCheck.context, fastTickProxy: gateAudit.fastTickProxy, action: "NO_EXIT_CHANGE_SHADOW_ONLY" });
    }
    if (runnerRescueCheck.ok && runnerRescueMode === "live") {
      const rescue = armRunnerContinuationRescue(p, price, pnl, baselineExitReason, runnerRescueCheck);
      await persistState(`runner_continuation_rescue_armed_${feature.kind}`);
      log("INFO", "FVVO_RUNNER_CONTINUATION_RESCUE_ARMED", { entryPrice: p.entryPriceReference, entryOrigin: p.entryOrigin, price, latestPnlPct: round(pnl, 6), peakPnlPct: round(runnerRescueCheck.peakPnlPct, 6), baselineExitReason: rescue.baselineReason, baselineExitPrice: rescue.baselineExitPrice, baselinePnlPct: rescue.baselinePnlPct, baselineProtectedPnlPct: rescue.baselineProtectedPnlPct, baselineProtectedPrice: rescue.baselineProtectedPrice, hardLockPnlPct: rescue.hardLockPnlPct, hardLockPrice: rescue.hardLockPrice, pinkEma18: runnerRescueCheck.context.ema18, pinkPrice: runnerRescueCheck.context.pinkPrice, expiresAt: new Date(rescue.expiresAtMs).toISOString(), maxGraceSec: CFG.RUNNER_CONTINUATION_RESCUE_MAX_SEC, context5m: runnerRescueCheck.context, fastTickProxy: gateAudit.fastTickProxy });
      return;
    }
    await persistState(`runner_tight_trail_${feature.kind}`);
    const exitResult = await requestFullExit(baselineExitReason, price, feature.kind);
    if (exitResult.ok) {
      createRunnerRescuePostExitAudit(p, feature, price, pnl, baselineExitReason, runnerTrail.protectedPrice, gateAudit);
      await persistState(`runner_rescue_post_exit_audit_started_${feature.kind}`);
    }
    return;
  }

  // Swing v1c: once a 5m emergency candle arms the persisted fast state, use the
  // smoothed 15s micro-trend path for the live decision. Hard stop/loss/floor/runner
  // protections above always retain priority.
  const fastEmergency = evaluateFastEmergency(p, feature, price, pnl);
  if (fastEmergency.cancelled) {
    const resolved = resetFastEmergency(p, fastEmergency.reason, feature, price, pnl, { evidence: fastEmergency.evidence });
    await persistState(`swing_emergency_fast_cancel_${feature.kind}`);
    log("INFO", "FVVO_SWING_EMERGENCY_FAST_CANCELLED", { ...resolved, action: "POSITION_REMAINS_MANAGED" });
  } else if (fastEmergency.shadow) {
    log("WARN", "FVVO_SWING_EMERGENCY_FAST_SHADOW_EXIT", { reason: fastEmergency.reason, price, latestPnlPct: round(pnl,6), evidence: fastEmergency.evidence, action: "NO_EXIT_CHANGE_SHADOW_ONLY" });
    resetFastEmergency(p, `SHADOW_${fastEmergency.reason}`, feature, price, pnl, { evidence: fastEmergency.evidence });
    await persistState(`swing_emergency_fast_shadow_${feature.kind}`);
  } else if (fastEmergency.confirmed) {
    const reason = fastEmergency.reason;
    const resolved = resetFastEmergency(p, reason, feature, price, pnl, { evidence: fastEmergency.evidence });
    await persistState(`swing_emergency_fast_exit_${feature.kind}`);
    log("WARN", "FVVO_SWING_EMERGENCY_FAST_CONFIRMED", { reason, price, latestPnlPct: round(pnl,6), peakPnlPct: round(p.peakPnlPct,6), resolution: resolved, evidence: fastEmergency.evidence });
    await requestFullExit(`FVVO_${reason}`, price, feature.kind);
    return;
  }

  // Swing structure: normal/no-progress paths remain confirmed on 5m. A 5m emergency
  // detector now arms the fast state and does not directly close the position.
  const swingExit = swingStructureExitDecision(p, feature, price, pnl);
  if (swingExit.shadow) {
    log("WARN", "FVVO_SWING_STRUCTURE_EXIT_SHADOW_CANDIDATE", { reason: swingExit.reason, price, latestPnlPct: round(pnl, 6), peakPnlPct: round(swingExit.peakPnlPct, 6), heldSec: round(swingExit.heldSec, 1), observations: swingExit.observations || null, evidence: swingExit.evidence, action: "NO_EXIT_CHANGE_SHADOW_ONLY" });
  } else if (swingExit.confirmed) {
    await persistState(`swing_structure_exit_${feature.kind}`);
    log("WARN", "FVVO_SWING_STRUCTURE_EXIT_CONFIRMED", { reason: swingExit.reason, price, latestPnlPct: round(pnl, 6), peakPnlPct: round(swingExit.peakPnlPct, 6), heldSec: round(swingExit.heldSec, 1), observations: swingExit.observations || null, evidence: swingExit.evidence });
    await requestFullExit(`FVVO_${swingExit.reason}`, price, feature.kind);
    return;
  }

  // v1s: a dynamic pullback grace also never bypasses the stop, normal dynamic floor, or runner trail above.
  // While active it suppresses the faster EMA8 / 5m EMA8 thesis exits and exits on the fresh 5m EMA18 (pink) break, a recovery continuation, or timeout.
  const activeDynamicPullbackGrace = await evaluateDynamicPullbackGrace(p, feature, price, pnl);
  if (activeDynamicPullbackGrace.resolved) {
    if (activeDynamicPullbackGrace.action === "RECOVERY_CONTINUE") {
      dynamicProfitState(p).thesis = { breachAtMs: 0, observations: 0, lastBreachPrice: null, lastFeatureKind: null };
      await persistState(`dynamic_pullback_grace_recovery_continue_${feature.kind}`);
      log("INFO", "FVVO_DYNAMIC_PULLBACK_GRACE_RECOVERY_CONTINUE", { entryPrice: p.entryPriceReference, price, latestPnlPct: round(pnl, 6), baselineExitPrice: activeDynamicPullbackGrace.baselineExitPrice, baselinePnlPct: activeDynamicPullbackGrace.baselinePnlPct, context5m: activeDynamicPullbackGrace.context, recovery: activeDynamicPullbackGrace.recovery });
      return;
    }
    await persistState(`dynamic_pullback_grace_${activeDynamicPullbackGrace.action.toLowerCase()}_${feature.kind}`);
    const dynamicGraceReason = activeDynamicPullbackGrace.action === "PINK_BREAK"
      ? "FVVO_DYNAMIC_PULLBACK_GRACE_PINK_EMA18_BREAK"
      : activeDynamicPullbackGrace.action === "CONTEXT_STALE"
        ? "FVVO_DYNAMIC_PULLBACK_GRACE_CONTEXT_STALE"
        : "FVVO_DYNAMIC_PULLBACK_GRACE_TIMEOUT";
    await requestFullExit(dynamicGraceReason, price, feature.kind);
    return;
  }
  if (activeDynamicPullbackGrace.active) {
    await persistState(`dynamic_pullback_grace_hold_${feature.kind}`);
    return;
  }

  // v1r: an already-armed re-entry continuation grace never bypasses the manual stop, dynamic floor, or runner trail above.
  // It can only resolve with a short recovery-capture exit or a timeout.
  const activeGrace = await evaluateReentryContinuationGrace(p, feature, price, pnl);
  if (activeGrace.resolved) {
    await persistState(`reentry_continuation_grace_${activeGrace.action.toLowerCase()}_${feature.kind}`);
    const reason = activeGrace.action === "RECOVERY_CAPTURE"
      ? "FVVO_REENTRY_CONTINUATION_GRACE_RECOVERY_CAPTURE"
      : "FVVO_REENTRY_CONTINUATION_GRACE_TIMEOUT";
    await requestFullExit(reason, price, feature.kind);
    return;
  }
  if (activeGrace.active) {
    await persistState(`reentry_continuation_grace_hold_${feature.kind}`);
    return;
  }

  // Faster 15s momentum/thesis failure; requires consecutive observations. For strong runners in live mode,
  // this exit is suppressed until either the runner trail or the slower 5m / normal floor protection exits.
  const currentRunner = dynamicProfitState(p).runner;
  const suppressTickThesis = runnerLiveEnabled() && currentRunner.holdActive;
  if (suppressTickThesis && feature.kind === CFG.FVVO_FEATURE_TICK_EVENT) {
    const evidence = tickThesisEvidence(p, feature, price, pnl);
    const persistedRunner = dynamicProfitState(p).runner;
    if (evidence.eligible && evidence.conditions) {
      persistedRunner.suppressedTickThesisCount = Number(persistedRunner.suppressedTickThesisCount || 0) + 1;
      log("INFO", "FVVO_RUNNER_HOLD_SUPPRESSED_TICK_THESIS", { peakPnlPct: d.peakPnlPct, latestPnlPct: pnl, holdMinMfePct: CFG.RUNNER_HOLD_MIN_MFE_PCT, price, ema8: evidence.ema8, fvvo: evidence.fvvo, slope: evidence.slope, suppressedCount: persistedRunner.suppressedTickThesisCount, tightTrailArmed: persistedRunner.tightTrailArmed, runnerProtectedPrice: persistedRunner.protectedPrice || null });
    }
    d.thesis = { breachAtMs: 0, observations: 0, lastBreachPrice: null, lastFeatureKind: null };
  } else {
    const tickThesis = tickThesisFailureConfirmed(p, feature, price, pnl);
    if (tickThesis.confirmed) {
      const pullbackGraceCheck = dynamicPullbackGraceEligible(p, feature, price, pnl);
      const pullbackGraceMode = dynamicPullbackGraceMode();
      if (pullbackGraceCheck.ok && pullbackGraceMode === "shadow") {
        log("INFO", "FVVO_DYNAMIC_PULLBACK_GRACE_SHADOW_CANDIDATE", {
          entryPrice: p.entryPriceReference, entryOrigin: p.entryOrigin, price, latestPnlPct: round(pnl, 6), peakPnlPct: round(pullbackGraceCheck.peakPnlPct, 6),
          baselineExitReason: `FVVO_DYNAMIC_PROFIT_TICK_THESIS_FAILURE_${tickThesis.reason}`, maxGraceSec: CFG.DYNAMIC_PULLBACK_GRACE_MAX_SEC,
          pinkEma18: pullbackGraceCheck.context.ema18, pinkPrice: pullbackGraceCheck.context.pinkPrice, context5m: pullbackGraceCheck.context, action: "NO_EXIT_CHANGE_SHADOW_ONLY",
        });
      }
      if (pullbackGraceCheck.ok && pullbackGraceMode === "live") {
        const pullbackGrace = armDynamicPullbackGrace(p, feature, price, pnl, `FVVO_DYNAMIC_PROFIT_TICK_THESIS_FAILURE_${tickThesis.reason}`, pullbackGraceCheck);
        dynamicProfitState(p).thesis = { breachAtMs: 0, observations: 0, lastBreachPrice: null, lastFeatureKind: null };
        await persistState(`dynamic_pullback_grace_armed_${feature.kind}`);
        log("INFO", "FVVO_DYNAMIC_PULLBACK_GRACE_ARMED", {
          entryPrice: p.entryPriceReference, entryOrigin: p.entryOrigin, price, latestPnlPct: round(pnl, 6), peakPnlPct: round(pullbackGraceCheck.peakPnlPct, 6),
          baselineExitReason: pullbackGrace.baselineReason, baselineExitPrice: pullbackGrace.baselineExitPrice, baselinePnlPct: pullbackGrace.baselinePnlPct,
          pinkEma18: pullbackGraceCheck.context.ema18, pinkPrice: pullbackGraceCheck.context.pinkPrice, expiresAt: new Date(pullbackGrace.expiresAtMs).toISOString(), maxGraceSec: CFG.DYNAMIC_PULLBACK_GRACE_MAX_SEC, context5m: pullbackGraceCheck.context,
        });
        return;
      }
      const graceCheck = reentryContinuationGraceEligible(p, feature, price, pnl);
      const graceMode = reentryContinuationGraceMode();
      if (graceCheck.ok && graceMode === "shadow") {
        log("INFO", "FVVO_REENTRY_CONTINUATION_GRACE_SHADOW_CANDIDATE", {
          entryPrice: p.entryPriceReference, price, latestPnlPct: round(pnl, 6), peakPnlPct: round(graceCheck.peakPnlPct, 6),
          baselineExitReason: `FVVO_DYNAMIC_PROFIT_TICK_THESIS_FAILURE_${tickThesis.reason}`,
          maxGraceSec: CFG.REENTRY_CONTINUATION_GRACE_MAX_SEC, context5m: graceCheck.context,
          action: "NO_EXIT_CHANGE_SHADOW_ONLY",
        });
      }
      if (graceCheck.ok && graceMode === "live") {
        const grace = armReentryContinuationGrace(p, feature, price, pnl, `FVVO_DYNAMIC_PROFIT_TICK_THESIS_FAILURE_${tickThesis.reason}`, graceCheck);
        await persistState(`reentry_continuation_grace_armed_${feature.kind}`);
        log("INFO", "FVVO_REENTRY_CONTINUATION_GRACE_ARMED", {
          entryPrice: p.entryPriceReference, price, latestPnlPct: round(pnl, 6), peakPnlPct: round(graceCheck.peakPnlPct, 6),
          baselineExitReason: grace.baselineReason, baselineExitPrice: grace.baselineExitPrice, baselinePnlPct: grace.baselinePnlPct,
          expiresAt: new Date(grace.expiresAtMs).toISOString(), maxGraceSec: CFG.REENTRY_CONTINUATION_GRACE_MAX_SEC,
          context5m: graceCheck.context,
        });
        return;
      }
      await persistState(`dynamic_profit_tick_thesis_${feature.kind}`);
      await requestFullExit(`FVVO_DYNAMIC_PROFIT_TICK_THESIS_FAILURE_${tickThesis.reason}`, price, feature.kind);
      return;
    }
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
    automaticOrdersEnabled: reentryAutoEnabled(),
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
      nextReentryNumber: c.nextReentryNumber || 1,
      reclaimObservations: c.reclaim?.observations || 0,
      expiresAt: c.expiresAt || null,
      lastCandidate: c.lastCandidate || null,
      preReleasePullback: c.preReleasePullback ? {
        carried: true, eligible: Boolean(c.preReleasePullback.eligible), pullbackLowPrice: c.preReleasePullback.pullbackLowPrice || null,
        pullbackDepthPct: c.preReleasePullback.pullbackDepthPct || 0, crossUpSeen: Boolean(c.preReleasePullback.crossUpSeen),
      } : null,
      postExitRecoveredBase: c.postExitRecoveredBase ? {
        mode: c.postExitRecoveredBase.mode, active: Boolean(c.postExitRecoveredBase.active), phase: c.postExitRecoveredBase.phase || null,
        baseLowPrice: c.postExitRecoveredBase.baseLowPrice || null, baseLowAt: c.postExitRecoveredBase.baseLowAt || null,
        recoveryPct: c.postExitRecoveredBase.recoveryPct || 0, confirmations: c.postExitRecoveredBase.confirmations || 0,
        requiredConfirmations: c.postExitRecoveredBase.requiredConfirmations || CFG.POST_EXIT_RECOVERED_BASE_CONFIRM_OBSERVATIONS,
        expiresAt: c.postExitRecoveredBase.expiresAt || null, reason: c.postExitRecoveredBase.reason || null,
        lastCandidate: c.postExitRecoveredBase.lastCandidate || null,
      } : null,
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
  const nextReentryNumber = Math.max(1, Math.floor(finite(prior.reentryNumber, 0)) + 1);
  if (nextReentryNumber > CFG.REENTRY_MAX_COUNT) {
    r.campaign = null;
    log("INFO", "FVVO_REENTRY_CAMPAIGN_NOT_ARMED", { reason: "REENTRY_LIMIT_REACHED", priorReentryNumber: finite(prior.reentryNumber, 0), nextReentryNumber, maxCount: CFG.REENTRY_MAX_COUNT, priorExitReason: prior.exitReason || null });
    return { active: false, reason: "REENTRY_LIMIT_REACHED" };
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
  const preReleaseMemory = state.autoExitRelease?.reentryPullbackMemory;
  const carryPreReleasePullback = Boolean(CFG.REENTRY_PRE_RELEASE_MEMORY_ENABLED && preReleaseMemory?.eligible && !preReleaseMemory?.invalidated && Number.isFinite(finite(preReleaseMemory?.pullbackLowPrice, null)));
  const campaign = {
    id: crypto.randomUUID(),
    active: true,
    phase: carryPreReleasePullback ? "WAIT_RECLAIM" : "WAIT_PULLBACK",
    reason: carryPreReleasePullback ? "PRE_RELEASE_HEALTHY_PULLBACK_CARRIED" : "ARMED_AFTER_CONFIRMED_PROFITABLE_CYCLE",
    sourceEntryOrigin: prior.entryOrigin || "MANUAL",
    sourceExitReason: prior.exitReason || null,
    sourceExitPrice: finite(prior.latestPrice, prior.entryPriceReference),
    nextReentryNumber,
    baseEntryPrice: round(prior.entryPriceReference, 8),
    priorPeakPrice: round(priorPeakPrice, 8),
    highestPrice: round(priorPeakPrice, 8),
    pullbackLowPrice: carryPreReleasePullback ? round(preReleaseMemory.pullbackLowPrice, 8) : null,
    pullbackDepthPct: carryPreReleasePullback ? round(preReleaseMemory.pullbackDepthPct, 6) : 0,
    pullbackSeenAtMs: carryPreReleasePullback ? finite(preReleaseMemory.capturedAtMs, 0) : 0,
    pullbackSeenAt: carryPreReleasePullback ? preReleaseMemory.capturedAt || null : null,
    preReleasePullback: carryPreReleasePullback ? { ...clone(preReleaseMemory), carriedAtMs: current, carriedAt: nowIso(), crossUpSeen: false } : null,
    postExitRecoveredBase: buildPostExitRecoveredBaseState(prior, finite(state.lastFeature?.price, finite(prior.latestPrice, prior.entryPriceReference)), current),
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
    mode: CFG.REENTRY_PHASE,
    profile: REENTRY_PROFILE,
    baseEntryPrice: campaign.baseEntryPrice,
    priorPeakPrice: campaign.priorPeakPrice,
    priorImpulsePct: round(impulsePct, 6),
    minPriorImpulsePct: CFG.REENTRY_MIN_PRIOR_IMPULSE_PCT,
    priorExitReason: campaign.sourceExitReason,
    maxCount: CFG.REENTRY_MAX_COUNT,
    nextReentryNumber,
    automaticOrderWillBeSent: reentryAutoEnabled(),
    preReleasePullbackCarried: carryPreReleasePullback,
    preReleasePullbackLowPrice: carryPreReleasePullback ? campaign.pullbackLowPrice : null,
    preReleasePullbackDepthPct: carryPreReleasePullback ? campaign.pullbackDepthPct : null,
    postExitRecoveredBaseMode: campaign.postExitRecoveredBase?.mode || "disabled",
    postExitRecoveredBaseWindowSec: CFG.POST_EXIT_RECOVERED_BASE_WINDOW_SEC,
    postExitRecoveredBaseRequiredConfirmations: CFG.POST_EXIT_RECOVERED_BASE_CONFIRM_OBSERVATIONS,
  });
  if (carryPreReleasePullback) log("INFO", "FVVO_REENTRY_PRE_RELEASE_PULLBACK_CARRIED", { campaignId: campaign.id, pullbackLowPrice: campaign.pullbackLowPrice, pullbackDepthPct: campaign.pullbackDepthPct, priorPeakPrice: campaign.priorPeakPrice });
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

function reentryPostPullback5mAlignment(campaign, context) {
  if (!CFG.REENTRY_POST_PULLBACK_5M_ALIGNMENT_ENABLED) return { ok: true, reason: "DISABLED" };
  const ctx = context?.ctx;
  const contextAtMs = finite(ctx?.receivedAtMs, finite(ctx?.barTimeMs, 0));
  const pullbackLowAtMs = finite(campaign?.pullbackLowAtMs, finite(campaign?.pullbackSeenAtMs, 0));
  const tracker = campaign.postPullback5mAlignment = campaign.postPullback5mAlignment && typeof campaign.postPullback5mAlignment === "object" ? campaign.postPullback5mAlignment : { barTimeMs: 0, priorSlope: null, currentSlope: null, slopeImprovement: null };
  const barTimeMs = finite(ctx?.barTimeMs, contextAtMs);
  if (barTimeMs > finite(tracker.barTimeMs, 0)) {
    tracker.priorSlope = finite(tracker.currentSlope, null);
    tracker.currentSlope = finite(ctx?.slope, null);
    tracker.slopeImprovement = tracker.priorSlope !== null && tracker.currentSlope !== null ? tracker.currentSlope - tracker.priorSlope : null;
    tracker.barTimeMs = barTimeMs;
  }
  const newerThanLow = contextAtMs > pullbackLowAtMs;
  const closeAboveEma8 = !CFG.REENTRY_POST_PULLBACK_5M_REQUIRE_CLOSE_ABOVE_EMA8 || (context.close !== null && context.ema8 !== null && context.close >= context.ema8);
  const emaStack = !CFG.REENTRY_POST_PULLBACK_5M_REQUIRE_EMA8_ABOVE_EMA18 || (context.ema8 !== null && context.ema18 !== null && context.ema8 >= context.ema18);
  const fvvoOk = context.fvvo !== null && context.fvvo >= CFG.REENTRY_POST_PULLBACK_5M_MIN_FVVO;
  const rayOk = !CFG.REENTRY_POST_PULLBACK_5M_REQUIRE_RAY_NOT_BEAR || context.ray !== "RAY_BEAR";
  const slope = finite(ctx?.slope, null);
  const positiveSlope = slope !== null && slope >= CFG.REENTRY_POST_PULLBACK_5M_POSITIVE_SLOPE_BYPASS;
  const improvingSlope = slope !== null && slope >= CFG.REENTRY_POST_PULLBACK_5M_MIN_SLOPE && tracker.slopeImprovement !== null && tracker.slopeImprovement >= CFG.REENTRY_POST_PULLBACK_5M_MIN_SLOPE_IMPROVEMENT;
  const slopeOk = positiveSlope || improvingSlope;
  const ok = Boolean(context.ok && newerThanLow && closeAboveEma8 && emaStack && fvvoOk && rayOk && slopeOk);
  return { ok, reason: ok ? "POST_PULLBACK_5M_ALIGNED" : "WAIT_POST_PULLBACK_5M_ALIGNMENT", barTimeMs, contextAtMs, pullbackLowAtMs, newerThanLow, closeAboveEma8, emaStack, fvvoOk, rayOk, slopeOk, positiveSlope, improvingSlope, slope, priorSlope: tracker.priorSlope, slopeImprovement: tracker.slopeImprovement, close: context.close, ema8: context.ema8, ema18: context.ema18, fvvo: context.fvvo, ray: context.ray };
}

function resetReentryReclaim(campaign) {
  campaign.reclaim = { observations: 0, firstAtMs: 0, lastPrice: null };
}

function reentryTickContextOverride(campaign, feature, price, tickEma8, tickEma18, rsi, adx, fvvo, slope) {
  const memory = campaign?.preReleasePullback;
  const carriedEligible = Boolean(CFG.REENTRY_PRE_RELEASE_MEMORY_ENABLED && CFG.REENTRY_PRE_RELEASE_TICK_OVERRIDE_ENABLED && memory?.eligible && !memory?.invalidated);
  const priorImpulsePct = percentPnl(finite(campaign?.baseEntryPrice, 0), finite(campaign?.priorPeakPrice, 0));
  const currentPullbackEligible = finite(campaign?.pullbackDepthPct, 0) >= CFG.REENTRY_PULLBACK_MIN_PCT && finite(campaign?.pullbackDepthPct, 0) <= CFG.REENTRY_PULLBACK_MAX_PCT && Number.isFinite(finite(campaign?.pullbackLowPrice, null));
  const fastEligible = Boolean(CFG.REENTRY_FAST_RECLAIM_TICK_OVERRIDE_ENABLED && currentPullbackEligible && priorImpulsePct + 1e-9 >= CFG.REENTRY_FAST_RECLAIM_MIN_PRIOR_IMPULSE_PCT);
  if (!carriedEligible && !fastEligible) return { ok: false, source: "NONE", reason: "TICK_OVERRIDE_UNAVAILABLE" };
  const latch = memory || (campaign.fastReclaimOverride = campaign.fastReclaimOverride || { crossUpSeen: false, source: "POST_RELEASE_PULLBACK" });
  const ray = String(feature.rayRegime || "RAY_NEUTRAL").toUpperCase();
  const maxRsi = fastEligible ? CFG.REENTRY_FAST_RECLAIM_OVERRIDE_MAX_RSI : CFG.REENTRY_MAX_RSI;
  const structural = tickEma8 !== null && tickEma18 !== null && price >= tickEma8 && price >= tickEma18 && feature.redPulse !== true && feature.crossDown !== true;
  const momentum = rsi !== null && rsi >= CFG.REENTRY_PRE_RELEASE_OVERRIDE_MIN_RSI && rsi <= maxRsi &&
    adx !== null && adx >= CFG.REENTRY_PRE_RELEASE_OVERRIDE_MIN_ADX &&
    fvvo !== null && fvvo >= CFG.REENTRY_PRE_RELEASE_OVERRIDE_MIN_FVVO &&
    slope !== null && slope >= CFG.REENTRY_PRE_RELEASE_OVERRIDE_MIN_SLOPE;
  const rayOk = !CFG.REENTRY_PRE_RELEASE_OVERRIDE_REQUIRE_RAY_BULL || ray === "RAY_BULL";
  if (structural && momentum && rayOk && feature.crossUp === true && !latch.crossUpSeen) {
    latch.crossUpSeen = true;
    latch.crossUpSeenAtMs = feature.receivedAtMs;
    latch.crossUpSeenAt = feature.receivedAt;
    log("INFO", carriedEligible ? "FVVO_REENTRY_PRE_RELEASE_TICK_OVERRIDE_LATCHED" : "FVVO_REENTRY_FAST_RECLAIM_TICK_OVERRIDE_LATCHED", { campaignId: campaign.id, price, rsi, adx, fvvo, slope, rayRegime: ray, pullbackLowPrice: campaign.pullbackLowPrice, priorImpulsePct: round(priorImpulsePct, 6) });
  }
  const crossOk = !CFG.REENTRY_PRE_RELEASE_OVERRIDE_REQUIRE_CROSS_UP || Boolean(latch.crossUpSeen);
  const source = carriedEligible ? "PRE_RELEASE_TICK_OVERRIDE" : "FAST_RECLAIM_TICK_OVERRIDE";
  return { ok: structural && momentum && rayOk && crossOk, structural, momentum, rayOk, crossOk, source, priorImpulsePct: round(priorImpulsePct, 6), reason: structural && momentum && rayOk && crossOk ? source : "TICK_RECLAIM_NOT_READY" };
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


function reentryPullbackHysteresisAudit(campaign, feature, belowEma18Pct, phase) {
  if (!CFG.REENTRY_PULLBACK_HYSTERESIS_AUDIT_ENABLED) return;
  if (!campaign.hysteresisAudit || typeof campaign.hysteresisAudit !== "object") campaign.hysteresisAudit = { lastState: "", lastAtMs: 0, invalidationCount: 0, rearmLogged: false };
  const h = campaign.hysteresisAudit;
  const tickEma18 = finite(feature.ema18, null);
  const price = finite(feature.price, null);
  const nearInvalidation = belowEma18Pct > CFG.REENTRY_MAX_BELOW_EMA18_PCT && belowEma18Pct <= CFG.REENTRY_MAX_BELOW_EMA18_PCT + CFG.REENTRY_PULLBACK_INVALIDATION_HYSTERESIS_PCT;
  if (phase === "NEAR_INVALIDATION" && nearInvalidation && h.lastState !== "NEAR_INVALIDATION") {
    h.lastState = "NEAR_INVALIDATION"; h.lastAtMs = nowMs();
    log("INFO", "FVVO_REENTRY_PULLBACK_HYSTERESIS_SHADOW", { campaignId: campaign.id, price, belowEma18Pct: round(belowEma18Pct, 6), liveInvalidationThresholdPct: CFG.REENTRY_MAX_BELOW_EMA18_PCT, shadowHysteresisPct: CFG.REENTRY_PULLBACK_INVALIDATION_HYSTERESIS_PCT, action: "NO_REENTRY_BEHAVIOUR_CHANGE" });
  }
  if (phase === "INVALIDATED") {
    h.lastState = "INVALIDATED"; h.lastAtMs = nowMs(); h.invalidationCount = Number(h.invalidationCount || 0) + 1; h.rearmLogged = false;
  }
  if (phase === "WAIT_PULLBACK" && h.lastState === "INVALIDATED" && !h.rearmLogged && tickEma18 !== null && price !== null && price >= tickEma18 * (1 + CFG.REENTRY_PULLBACK_REARM_ABOVE_EMA18_PCT / 100)) {
    h.rearmLogged = true; h.lastState = "REARMED"; h.lastAtMs = nowMs();
    log("INFO", "FVVO_REENTRY_PULLBACK_HYSTERESIS_REARM_SHADOW", { campaignId: campaign.id, price, ema18: tickEma18, requiredAboveEma18Pct: CFG.REENTRY_PULLBACK_REARM_ABOVE_EMA18_PCT, invalidationCount: h.invalidationCount, action: "NO_REENTRY_BEHAVIOUR_CHANGE" });
  }
}

function postExitRecoveredBaseMode() { return CFG.POST_EXIT_RECOVERED_BASE_MODE; }

function buildPostExitRecoveredBaseState(prior, startingPrice, current = nowMs()) {
  const mode = postExitRecoveredBaseMode();
  const base = finite(startingPrice, finite(prior?.latestPrice, finite(prior?.entryPriceReference, null)));
  const enabled = mode !== "disabled" && Number.isFinite(base) && base > 0;
  const expiresAtMs = current + CFG.POST_EXIT_RECOVERED_BASE_WINDOW_SEC * 1000;
  return {
    enabled,
    mode,
    active: enabled,
    phase: enabled ? "WATCHING_BASE" : "DISABLED",
    reason: enabled ? "POST_RELEASE_BASE_TRACKING" : "MODE_DISABLED",
    sourceExitPrice: finite(prior?.latestPrice, finite(prior?.entryPriceReference, null)),
    baseLowPrice: enabled ? round(base, 8) : null,
    baseLowAtMs: enabled ? current : 0,
    baseLowAt: enabled ? new Date(current).toISOString() : null,
    recoveryPct: 0,
    confirmations: 0,
    requiredConfirmations: CFG.POST_EXIT_RECOVERED_BASE_CONFIRM_OBSERVATIONS,
    firstConfirmAtMs: 0,
    firstConfirmAt: null,
    lastConfirmPrice: null,
    crossUpSeen: false,
    startedAtMs: current,
    startedAt: new Date(current).toISOString(),
    expiresAtMs,
    expiresAt: new Date(expiresAtMs).toISOString(),
    logged: false,
    consumed: false,
    lastCandidate: null,
  };
}

function postExitRecoveredBaseCandidate(campaign, feature, context, values, recovered) {
  const projectedStop = projectReentryStop(values.price, recovered.baseLowPrice);
  return {
    id: crypto.randomUUID(),
    profile: POST_EXIT_RECOVERED_BASE_PROFILE,
    sequence: Number(campaign.nextReentryNumber || 1),
    observedAt: nowIso(),
    observedAtMs: nowMs(),
    price: round(values.price, 8),
    projectedStopPrice: projectedStop.ok ? projectedStop.stopPrice : null,
    projectedStopDistancePct: projectedStop.ok ? projectedStop.stopDistancePct : null,
    baseEntryPrice: campaign.baseEntryPrice,
    priorPeakPrice: campaign.priorPeakPrice,
    baseLowPrice: recovered.baseLowPrice,
    baseLowAt: recovered.baseLowAt,
    recoveryPct: round(recovered.recoveryPct, 6),
    confirmations: recovered.confirmations,
    requiredConfirmations: recovered.requiredConfirmations,
    tick: {
      ema8: values.tickEma8,
      ema18: values.tickEma18,
      rsi: values.rsi,
      adx: values.adx,
      fvvo: values.fvvo,
      slope: values.slope,
      crossUp: Boolean(feature.crossUp),
      rayRegime: String(feature.rayRegime || "RAY_NEUTRAL").toUpperCase(),
    },
    context5m: {
      price: context.close,
      ema8: context.ema8,
      ema18: context.ema18,
      fvvo: context.fvvo,
      rayRegime: context.ray,
      ageSec: round(context.ctxAge, 2),
      eligible: context.ok,
    },
    mode: postExitRecoveredBaseMode(),
    automaticOrderSent: false,
  };
}

async function forwardPostExitRecoveredBaseCandidate(campaign, recovered, candidate) {
  const projectedStop = projectReentryStop(candidate.price, recovered.baseLowPrice);
  if (!projectedStop.ok) {
    recovered.active = false;
    recovered.phase = "STOP_REJECTED";
    recovered.reason = projectedStop.reason;
    await persistState("post_exit_recovered_base_stop_rejected");
    log("WARN", "FVVO_POST_EXIT_RECOVERED_BASE_REJECTED", {
      campaignId: campaign.id,
      reason: projectedStop.reason,
      price: candidate.price,
      baseLowPrice: recovered.baseLowPrice,
      stopDistancePct: projectedStop.stopDistancePct || null,
    });
    return { entered: false, rejected: true };
  }

  candidate.projectedStopPrice = projectedStop.stopPrice;
  candidate.projectedStopDistancePct = projectedStop.stopDistancePct;
  candidate.automaticOrderSent = true;
  candidate.forwardStatus = "PENDING";
  recovered.active = false;
  recovered.phase = "LIVE_CANDIDATE_CONFIRMED";
  recovered.reason = "TWO_TICK_RECOVERED_BASE_CONFIRMED";
  recovered.consumed = true;
  recovered.lastCandidate = candidate;
  campaign.observedCandidates = Number(campaign.observedCandidates || 0) + 1;
  campaign.lastCandidate = candidate;
  campaign.phase = "CANDIDATE_OBSERVED";
  campaign.reason = "POST_EXIT_RECOVERED_BASE_CONFIRMED";
  campaign.active = false;

  state.position = buildPosition(candidate.price, {
    stopPrice: projectedStop.stopPrice,
    stopPct: projectedStop.stopDistancePct,
    profitTargetPrice: 0,
    profitTargetPct: 0,
  }, {
    entryOrigin: "AUTO_REENTRY",
    profile: POST_EXIT_RECOVERED_BASE_PROFILE,
    reentryNumber: candidate.sequence,
  });
  state.position.reentryCampaignId = campaign.id;
  state.position.reentryCandidateId = candidate.id;
  state.externalDealLock = { active: true, source: "post_exit_recovered_base", setAt: nowIso(), reason: "POST_EXIT_RECOVERED_BASE_PENDING_FORWARD" };
  state.manual = { ...state.manual, handoffActive: false, recoveryRequired: false, recoveryReason: "", lastAction: "post_exit_recovered_base", lastActionAt: nowIso() };
  await persistState("post_exit_recovered_base_pre_forward");
  log("INFO", "FVVO_POST_EXIT_RECOVERED_BASE_LIVE_CONFIRMED", { ...candidate, executionMode: CFG.EXECUTION_MODE });
  log("INFO", "FVVO_REENTRY_CANDIDATE_AUTO", { ...candidate, launchPath: "POST_EXIT_RECOVERED_BASE", executionMode: CFG.EXECUTION_MODE });

  const result = await forward3Commas("enter_long", candidate.price, candidate.profile, {
    dedupeKey: `post_exit_recovered_base_enter_${candidate.id}`,
    stopPct: projectedStop.stopDistancePct,
  });
  if (!result.ok) {
    state.position.lifecycle = "ENTRY_UNKNOWN_AFTER_FORWARD_ERROR";
    state.manual.recoveryRequired = true;
    state.manual.recoveryReason = `POST_EXIT_RECOVERED_BASE_FORWARD_UNCERTAIN_${result.error}`;
    state.externalDealLock.reason = "POST_EXIT_RECOVERED_BASE_FORWARD_UNCERTAIN";
    candidate.forwardStatus = "FORWARD_UNCERTAIN";
    candidate.forwardRequestId = result.requestId || null;
    await persistState("post_exit_recovered_base_forward_uncertain");
    log("ERROR", "FVVO_POST_EXIT_RECOVERED_BASE_FORWARD_UNCERTAIN", {
      candidateId: candidate.id,
      reentryNumber: candidate.sequence,
      requestId: result.requestId || null,
      error: result.error,
    });
    return { entered: true, uncertain: true };
  }
  state.position.lifecycle = "ENTRY_ACCEPTED_UNVERIFIED_FILL";
  state.position.entryAcceptedAt = nowIso();
  state.position.entryAcceptedAtMs = nowMs();
  state.position.entryForwardRequestId = result.requestId;
  state.externalDealLock.reason = "POST_EXIT_RECOVERED_BASE_ACCEPTED_UNVERIFIED_FILL";
  candidate.forwardStatus = "FORWARDED_UNVERIFIED";
  candidate.forwardRequestId = result.requestId;
  await persistState("post_exit_recovered_base_forward_accepted");
  log("INFO", "FVVO_AUTO_REENTRY_ENTRY_TRACKED", {
    candidateId: candidate.id,
    reentryNumber: candidate.sequence,
    entryPriceReference: candidate.price,
    stopPrice: projectedStop.stopPrice,
    stopDistancePct: projectedStop.stopDistancePct,
    requestId: result.requestId,
    entrySizeSource: CFG.C3_ENTRY_SIZE_SOURCE,
    entryOrderIncludedInWebhook: false,
    fillVerified: false,
    entryPath: "POST_EXIT_RECOVERED_BASE",
  });
  return { entered: true, forwarded: true };
}

async function evaluatePostExitRecoveredBase(campaign, feature) {
  const recovered = campaign?.postExitRecoveredBase;
  if (!recovered || !recovered.enabled || !recovered.active || feature.kind !== CFG.FVVO_FEATURE_TICK_EVENT) return { entered: false, active: false };
  const current = nowMs();
  if (current > finite(recovered.expiresAtMs, 0)) {
    recovered.active = false;
    recovered.phase = "EXPIRED";
    recovered.reason = "POST_RELEASE_WINDOW_EXPIRED";
    await persistState("post_exit_recovered_base_expired");
    log("INFO", "FVVO_POST_EXIT_RECOVERED_BASE_EXPIRED", {
      campaignId: campaign.id,
      windowSec: CFG.POST_EXIT_RECOVERED_BASE_WINDOW_SEC,
      baseLowPrice: recovered.baseLowPrice,
    });
    return { entered: false, active: false, expired: true };
  }

  const price = finite(feature.price, null);
  if (!(price > 0)) return { entered: false, active: true };
  if (!Number.isFinite(finite(recovered.baseLowPrice, null)) || price < recovered.baseLowPrice - 1e-9) {
    const priorLow = finite(recovered.baseLowPrice, null);
    recovered.baseLowPrice = round(price, 8);
    recovered.baseLowAtMs = current;
    recovered.baseLowAt = nowIso();
    recovered.recoveryPct = 0;
    recovered.confirmations = 0;
    recovered.firstConfirmAtMs = 0;
    recovered.firstConfirmAt = null;
    recovered.lastConfirmPrice = null;
    recovered.crossUpSeen = false;
    recovered.phase = "WATCHING_BASE";
    recovered.reason = "LOW_UPDATED";
    await persistState("post_exit_recovered_base_low_updated");
    log("INFO", "FVVO_POST_EXIT_RECOVERED_BASE_LOW_UPDATED", {
      campaignId: campaign.id,
      previousLowPrice: priorLow,
      baseLowPrice: recovered.baseLowPrice,
      sourceExitPrice: recovered.sourceExitPrice,
      maxChasePct: CFG.POST_EXIT_RECOVERED_BASE_MAX_CHASE_FROM_LOW_PCT,
    });
    return { entered: false, active: true, lowUpdated: true };
  }

  const tickEma8 = finite(feature.ema8, null);
  const tickEma18 = finite(feature.ema18, null);
  const rsi = finite(feature.rsi, null);
  const adx = finite(feature.adx, null);
  const fvvo = finite(feature.fvvo, null);
  const slope = finite(feature.slope, null);
  const ray = String(feature.rayRegime || "RAY_NEUTRAL").toUpperCase();
  const context = reentryContext(feature);
  const recoveryPct = percentPnl(recovered.baseLowPrice, price);
  recovered.recoveryPct = round(recoveryPct, 6);
  if (feature.crossUp === true) recovered.crossUpSeen = true;

  const structural = tickEma8 !== null && tickEma18 !== null &&
    price >= tickEma8 && price >= tickEma18 &&
    (!CFG.POST_EXIT_RECOVERED_BASE_REQUIRE_EMA8_ABOVE_EMA18 || tickEma8 >= tickEma18) &&
    feature.redPulse !== true && feature.crossDown !== true;
  const momentum = rsi !== null && rsi >= CFG.POST_EXIT_RECOVERED_BASE_MIN_RSI && rsi <= CFG.POST_EXIT_RECOVERED_BASE_MAX_RSI &&
    adx !== null && adx >= CFG.POST_EXIT_RECOVERED_BASE_MIN_ADX &&
    fvvo !== null && fvvo >= CFG.POST_EXIT_RECOVERED_BASE_MIN_FVVO &&
    slope !== null && slope >= CFG.POST_EXIT_RECOVERED_BASE_MIN_SLOPE;
  const rayOk = !CFG.POST_EXIT_RECOVERED_BASE_REQUIRE_RAY_NOT_BEAR || !ray.includes("BEAR");
  const contextOk = !CFG.POST_EXIT_RECOVERED_BASE_REQUIRE_5M_CONTEXT || context.ok;
  const recoveryOk = recoveryPct + 1e-9 >= CFG.POST_EXIT_RECOVERED_BASE_MIN_RECOVERY_PCT &&
    recoveryPct <= CFG.POST_EXIT_RECOVERED_BASE_MAX_CHASE_FROM_LOW_PCT + 1e-9;
  const priorImpulsePct = percentPnl(finite(campaign.baseEntryPrice, 0), finite(campaign.priorPeakPrice, 0));
  const impulseOk = priorImpulsePct + 1e-9 >= CFG.POST_EXIT_RECOVERED_BASE_MIN_PRIOR_IMPULSE_PCT;
  const qualified = structural && momentum && rayOk && contextOk && recoveryOk && impulseOk;

  if (!qualified) {
    if (recovered.confirmations > 0) {
      recovered.confirmations = 0;
      recovered.firstConfirmAtMs = 0;
      recovered.firstConfirmAt = null;
      recovered.lastConfirmPrice = null;
      recovered.phase = "WATCHING_BASE";
      recovered.reason = "RECOVERY_CONFIRMATION_RESET";
      await persistState("post_exit_recovered_base_confirmation_reset");
      log("INFO", "FVVO_POST_EXIT_RECOVERED_BASE_CONFIRMATION_RESET", {
        campaignId: campaign.id,
        price,
        baseLowPrice: recovered.baseLowPrice,
        recoveryPct: round(recoveryPct, 6),
        checks: { structural, momentum, rayOk, contextOk, recoveryOk, impulseOk },
      });
    }
    return { entered: false, active: true, qualified: false };
  }

  recovered.confirmations = Number(recovered.confirmations || 0) + 1;
  recovered.lastConfirmPrice = round(price, 8);
  if (!recovered.firstConfirmAtMs) {
    recovered.firstConfirmAtMs = current;
    recovered.firstConfirmAt = nowIso();
  }
  recovered.phase = "RECOVERY_CONFIRMING";
  recovered.reason = "TWO_TICK_RECOVERY_CONFIRMATION_PENDING";
  const values = { price, tickEma8, tickEma18, rsi, adx, fvvo, slope };
  await persistState("post_exit_recovered_base_confirming");
  log("INFO", "FVVO_POST_EXIT_RECOVERED_BASE_CONFIRMING", {
    campaignId: campaign.id,
    price,
    baseLowPrice: recovered.baseLowPrice,
    recoveryPct: round(recoveryPct, 6),
    observations: recovered.confirmations,
    requiredObservations: recovered.requiredConfirmations,
    rayRegime: ray,
    context5m: { eligible: context.ok, ray: context.ray, ageSec: round(context.ctxAge, 2) },
  });
  if (recovered.confirmations < recovered.requiredConfirmations) return { entered: false, active: true, confirming: true };

  const candidate = postExitRecoveredBaseCandidate(campaign, feature, context, values, recovered);
  recovered.lastCandidate = candidate;
  if (postExitRecoveredBaseMode() === "shadow") {
    recovered.active = false;
    recovered.phase = "SHADOW_CANDIDATE_OBSERVED";
    recovered.reason = "TWO_TICK_RECOVERED_BASE_CONFIRMED";
    recovered.logged = true;
    await persistState("post_exit_recovered_base_shadow_candidate");
    log("INFO", "FVVO_POST_EXIT_RECOVERED_BASE_SHADOW_CANDIDATE", {
      ...candidate,
      action: "NO_REENTRY_BEHAVIOUR_CHANGE",
      candidateReferenceOnly: true,
    });
    return { entered: false, active: false, shadowCandidate: true, candidate };
  }
  if (postExitRecoveredBaseMode() !== "live") return { entered: false, active: false };
  return forwardPostExitRecoveredBaseCandidate(campaign, recovered, candidate);
}

function reentry15sFastLaunchEligible(campaign, feature, context, values) {
  const price = values.price, tickEma8 = values.tickEma8, tickEma18 = values.tickEma18;
  const rsi = values.rsi, adx = values.adx, fvvo = values.fvvo, slope = values.slope;
  const priorImpulsePct = percentPnl(finite(campaign?.baseEntryPrice, 0), finite(campaign?.highestPrice, 0));
  const pullbackDepthPct = finite(campaign?.pullbackDepthPct, 0);
  const ray = String(feature.rayRegime || "RAY_NEUTRAL").toUpperCase();
  const structural = tickEma8 !== null && tickEma18 !== null && price >= tickEma8 && price >= tickEma18 && tickEma8 >= tickEma18 && feature.redPulse !== true && feature.crossDown !== true;
  const momentum = rsi !== null && rsi >= CFG.REENTRY_15S_FAST_LAUNCH_MIN_RSI && rsi <= CFG.REENTRY_15S_FAST_LAUNCH_MAX_RSI &&
    adx !== null && adx >= CFG.REENTRY_15S_FAST_LAUNCH_MIN_ADX &&
    fvvo !== null && fvvo >= CFG.REENTRY_15S_FAST_LAUNCH_MIN_FVVO &&
    slope !== null && slope >= CFG.REENTRY_15S_FAST_LAUNCH_MIN_SLOPE;
  const impulseOk = priorImpulsePct + 1e-9 >= CFG.REENTRY_15S_FAST_LAUNCH_MIN_PRIOR_IMPULSE_PCT;
  const pullbackOk = pullbackDepthPct + 1e-9 >= CFG.REENTRY_15S_FAST_LAUNCH_MIN_PULLBACK_PCT && pullbackDepthPct <= CFG.REENTRY_15S_FAST_LAUNCH_MAX_PULLBACK_PCT + 1e-9;
  const rayOk = !CFG.REENTRY_15S_FAST_LAUNCH_REQUIRE_RAY_BULL || ray === "RAY_BULL";
  const crossOk = !CFG.REENTRY_15S_FAST_LAUNCH_REQUIRE_CROSS_UP || feature.crossUp === true;
  const contextOk = !CFG.REENTRY_15S_FAST_LAUNCH_REQUIRE_5M_CONTEXT || context.ok;
  return { eligible: structural && momentum && impulseOk && pullbackOk && rayOk && crossOk && contextOk, priorImpulsePct: round(priorImpulsePct, 6), pullbackDepthPct: round(pullbackDepthPct, 6), structural, momentum, impulseOk, pullbackOk, rayOk, crossOk, contextOk, ray };
}

function reentry15sEarlyTurnEligible(campaign, feature, context, values) {
  const price = values.price, tickEma8 = values.tickEma8, tickEma18 = values.tickEma18;
  const rsi = values.rsi, adx = values.adx, fvvo = values.fvvo, slope = values.slope;
  const priorImpulsePct = percentPnl(finite(campaign?.baseEntryPrice, 0), finite(campaign?.highestPrice, 0));
  const pullbackDepthPct = finite(campaign?.pullbackDepthPct, 0);
  const ray = String(feature.rayRegime || "RAY_NEUTRAL").toUpperCase();
  const emaConverged = tickEma8 !== null && tickEma18 !== null && tickEma8 >= tickEma18 * (1 - CFG.REENTRY_15S_EARLY_TURN_EMA_CONVERGENCE_TOLERANCE_PCT / 100);
  const structural = tickEma8 !== null && tickEma18 !== null && price >= tickEma8 && price >= tickEma18 && emaConverged && feature.redPulse !== true && feature.crossDown !== true;
  const momentum = rsi !== null && rsi >= CFG.REENTRY_15S_EARLY_TURN_MIN_RSI &&
    adx !== null && adx >= CFG.REENTRY_15S_EARLY_TURN_MIN_ADX &&
    fvvo !== null && fvvo >= CFG.REENTRY_15S_EARLY_TURN_MIN_FVVO &&
    slope !== null && slope >= CFG.REENTRY_15S_EARLY_TURN_MIN_SLOPE;
  const impulseOk = priorImpulsePct + 1e-9 >= CFG.REENTRY_15S_EARLY_TURN_MIN_PRIOR_IMPULSE_PCT;
  const pullbackOk = pullbackDepthPct + 1e-9 >= CFG.REENTRY_15S_EARLY_TURN_MIN_PULLBACK_PCT && pullbackDepthPct <= CFG.REENTRY_15S_EARLY_TURN_MAX_PULLBACK_PCT + 1e-9;
  const rayOk = ray !== "RAY_BEAR";
  const contextOk = !CFG.REENTRY_15S_EARLY_TURN_REQUIRE_5M_CONTEXT || context.ok;
  return { eligible: structural && momentum && impulseOk && pullbackOk && rayOk && contextOk, priorImpulsePct: round(priorImpulsePct, 6), pullbackDepthPct: round(pullbackDepthPct, 6), structural, momentum, impulseOk, pullbackOk, rayOk, contextOk, emaConverged, ray };
}

function logReentry15sShadowCandidate(kind, campaign, feature, context, values, detail) {
  const key = kind === "FAST_LAUNCH" ? "fastLaunchShadow" : "earlyTurnShadow";
  if (campaign[key]?.logged) return;
  const projectedStop = projectReentryStop(values.price, campaign.pullbackLowPrice);
  const candidate = {
    campaignId: campaign.id, profile: kind === "FAST_LAUNCH" ? "AUTO_REENTRY_15S_FAST_LAUNCH_SHADOW" : "AUTO_REENTRY_15S_EARLY_TURN_SHADOW",
    action: "NO_REENTRY_BEHAVIOUR_CHANGE", observedAt: nowIso(), observedAtMs: nowMs(), price: round(values.price, 8),
    projectedStopPrice: projectedStop.ok ? projectedStop.stopPrice : null, projectedStopDistancePct: projectedStop.ok ? projectedStop.stopDistancePct : null,
    baseEntryPrice: campaign.baseEntryPrice, highestPrice: campaign.highestPrice, pullbackLowPrice: campaign.pullbackLowPrice,
    pullbackDepthPct: campaign.pullbackDepthPct, bouncePct: round(percentPnl(campaign.pullbackLowPrice, values.price), 6),
    tick: { ema8: values.tickEma8, ema18: values.tickEma18, rsi: values.rsi, adx: values.adx, fvvo: values.fvvo, slope: values.slope, crossUp: feature.crossUp, rayRegime: detail.ray },
    context5m: { price: context.close, ema8: context.ema8, ema18: context.ema18, fvvo: context.fvvo, rayRegime: context.ray, ageSec: round(context.ctxAge, 2) },
    checks: detail,
  };
  campaign[key] = { logged: true, candidate };
  log("INFO", kind === "FAST_LAUNCH" ? "FVVO_REENTRY_15S_FAST_LAUNCH_SHADOW_CANDIDATE" : "FVVO_REENTRY_15S_EARLY_TURN_SHADOW_CANDIDATE", candidate);
}

async function evaluateReentryShadow(feature) {
  const r = ensureReentryState();
  if (!CFG.REENTRY_ENABLED || !["shadow", "auto"].includes(CFG.REENTRY_PHASE) || state.position || state.externalDealLock?.active || state.manual?.handoffActive || state.manual?.recoveryRequired) return;
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

  // v1x: a compact post-release recovered-base path runs alongside the legacy pullback/reclaim
  // campaign. Shadow candidates never change the legacy phase. A deliberate live candidate owns
  // the campaign and returns before the standard path can create a competing order on this tick.
  const postExitRecoveredBase = await evaluatePostExitRecoveredBase(c, feature);
  if (postExitRecoveredBase.entered) return;

  const price = feature.price;
  if (price > finite(c.highestPrice, 0) + 1e-9) {
    c.highestPrice = round(price, 8);
    c.phase = "WAIT_PULLBACK";
    c.pullbackLowPrice = null; c.pullbackDepthPct = 0; c.pullbackSeenAtMs = 0; c.pullbackSeenAt = null; c.pullbackLowAtMs = 0; c.pullbackLowAt = null; c.postPullback5mAlignment = null;
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
    reentryPullbackHysteresisAudit(c, feature, belowEma18Pct, "WAIT_PULLBACK");
    if (pullbackDepthPct >= CFG.REENTRY_PULLBACK_MIN_PCT && pullbackDepthPct <= CFG.REENTRY_PULLBACK_MAX_PCT && belowEma18Pct <= CFG.REENTRY_MAX_BELOW_EMA18_PCT) {
      c.phase = "WAIT_RECLAIM";
      c.reason = "HEALTHY_PULLBACK_SEEN";
      c.pullbackLowPrice = round(price, 8);
      c.pullbackDepthPct = round(pullbackDepthPct, 6);
      c.pullbackSeenAtMs = current;
      c.pullbackSeenAt = nowIso();
      c.pullbackLowAtMs = current;
      c.pullbackLowAt = nowIso();
      c.postPullback5mAlignment = null;
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
    c.pullbackLowAtMs = current;
    c.pullbackLowAt = nowIso();
    c.postPullback5mAlignment = null;
    resetReentryReclaim(c);
  }
  if (belowEma18Pct > CFG.REENTRY_MAX_BELOW_EMA18_PCT && belowEma18Pct <= CFG.REENTRY_MAX_BELOW_EMA18_PCT + CFG.REENTRY_PULLBACK_INVALIDATION_HYSTERESIS_PCT) reentryPullbackHysteresisAudit(c, feature, belowEma18Pct, "NEAR_INVALIDATION");
  if (c.pullbackDepthPct > CFG.REENTRY_PULLBACK_MAX_PCT + 1e-9 || belowEma18Pct > CFG.REENTRY_MAX_BELOW_EMA18_PCT + 1e-9) {
    reentryPullbackHysteresisAudit(c, feature, belowEma18Pct, "INVALIDATED");
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
  const preReleaseOverride = reentryTickContextOverride(c, feature, price, tickEma8, tickEma18, rsi, adx, fvvo, slope);
  const postPullbackAlignment = reentryPostPullback5mAlignment(c, context);
  const contextGate = context.ok || preReleaseOverride.ok;
  const conditions = contextGate &&
    tickEma18 !== null && price >= tickEma18 * (1 - CFG.REENTRY_MAX_BELOW_EMA18_PCT / 100) &&
    reclaimEma8Ok &&
    bouncePct >= CFG.REENTRY_MIN_BOUNCE_FROM_LOW_PCT &&
    (CFG.REENTRY_MAX_BOUNCE_FROM_LOW_PCT <= 0 || bouncePct <= CFG.REENTRY_MAX_BOUNCE_FROM_LOW_PCT) &&
    rsi !== null && rsi >= CFG.REENTRY_MIN_RSI && rsi <= CFG.REENTRY_MAX_RSI &&
    adx !== null && adx >= CFG.REENTRY_MIN_ADX &&
    fvvo !== null && fvvo >= CFG.REENTRY_MIN_FVVO &&
    slope !== null && slope >= CFG.REENTRY_MIN_SLOPE &&
    chasePct <= CFG.REENTRY_MAX_CHASE_ABOVE_EMA8_PCT &&
    feature.redPulse !== true && feature.crossDown !== true;

  // v1v audit candidates are evaluated at the first usable recovery tick, before the legacy
  // two-observation confirmation has time to chase a stronger reclaim. Shadow modes never change
  // campaign state, entry timing, stop placement, or 3Commas forwarding.
  const launchValues = { price, tickEma8, tickEma18, rsi, adx, fvvo, slope };
  const fastLaunch = reentry15sFastLaunchEligible(c, feature, context, launchValues);
  const earlyTurn = reentry15sEarlyTurnEligible(c, feature, context, launchValues);
  if (CFG.REENTRY_15S_FAST_LAUNCH_MODE === "shadow" && fastLaunch.eligible) logReentry15sShadowCandidate("FAST_LAUNCH", c, feature, context, launchValues, fastLaunch);
  if (CFG.REENTRY_15S_EARLY_TURN_MODE === "shadow" && earlyTurn.eligible) logReentry15sShadowCandidate("EARLY_TURN", c, feature, context, launchValues, earlyTurn);
  const liveFastLaunch = CFG.REENTRY_15S_FAST_LAUNCH_MODE === "live" && fastLaunch.eligible;
  const liveEarlyTurn = CFG.REENTRY_15S_EARLY_TURN_MODE === "live" && earlyTurn.eligible;
  const launchPath = liveFastLaunch ? "FAST_LAUNCH_15S" : (liveEarlyTurn ? "EARLY_TURN_15S" : null);
  const effectiveConditions = (conditions || Boolean(launchPath)) && postPullbackAlignment.ok;

  if (!effectiveConditions) {
    if ((conditions || Boolean(launchPath)) && !postPullbackAlignment.ok && finite(c.lastPostPullbackAlignmentWaitBarTimeMs, 0) !== finite(postPullbackAlignment.barTimeMs, 0)) {
      c.lastPostPullbackAlignmentWaitBarTimeMs = finite(postPullbackAlignment.barTimeMs, 0);
      log("INFO", "FVVO_REENTRY_POST_PULLBACK_5M_ALIGNMENT_WAIT", { campaignId: c.id, price, ...postPullbackAlignment, action: "NO_REENTRY_UNTIL_NEW_5M_ALIGNMENT" });
    }
    resetReentryReclaim(c);
    await persistState("reentry_wait_reclaim");
    return;
  }
  if (launchPath) {
    c.reclaim = { observations: CFG.REENTRY_RECLAIM_CONFIRM_OBSERVATIONS, firstAtMs: current, lastPrice: price };
    log("WARN", "FVVO_REENTRY_15S_LAUNCH_LIVE_TEST", { campaignId: c.id, launchPath, price, pullbackLowPrice: c.pullbackLowPrice, pullbackDepthPct: c.pullbackDepthPct, action: "ONE_TICK_LAUNCH_WILL_FORWARD_AFTER_STOP_VALIDATION" });
  } else if (!c.reclaim.firstAtMs) c.reclaim = { observations: 1, firstAtMs: current, lastPrice: price };
  else { c.reclaim.observations = Number(c.reclaim.observations || 0) + 1; c.reclaim.lastPrice = price; }
  if (c.reclaim.observations < CFG.REENTRY_RECLAIM_CONFIRM_OBSERVATIONS) {
    await persistState("reentry_reclaim_confirming");
    log("INFO", "FVVO_REENTRY_RECLAIM_CONFIRMING", { campaignId: c.id, observations: c.reclaim.observations, requiredObservations: CFG.REENTRY_RECLAIM_CONFIRM_OBSERVATIONS, price, bouncePct: round(bouncePct, 6), contextRayRegime: context.ray, reentryContextMode: context.ok ? "5M_CONTEXT" : (preReleaseOverride.ok ? preReleaseOverride.source : "NONE") });
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
    id: crypto.randomUUID(), profile: launchPath === "FAST_LAUNCH_15S" ? "AUTO_REENTRY_15S_FAST_LAUNCH" : (launchPath === "EARLY_TURN_15S" ? "AUTO_REENTRY_15S_EARLY_TURN" : REENTRY_PROFILE), sequence: Number(c.nextReentryNumber || 1),
    observedAt: nowIso(), observedAtMs: current, price: round(price, 8), projectedStopPrice: projectedStop.stopPrice,
    projectedStopDistancePct: projectedStop.stopDistancePct, baseEntryPrice: c.baseEntryPrice, highestPrice: c.highestPrice,
    pullbackLowPrice: c.pullbackLowPrice, pullbackDepthPct: c.pullbackDepthPct, bouncePct: round(bouncePct, 6),
    tick: { ema8: tickEma8, ema18: tickEma18, rsi, adx, fvvo, slope, crossUp: feature.crossUp },
    context5m: { price: context.close, ema8: context.ema8, ema18: context.ema18, fvvo: context.fvvo, rayRegime: context.ray, ageSec: round(context.ctxAge, 2) },
    reentryContextMode: context.ok ? "5M_CONTEXT" : (preReleaseOverride.ok ? preReleaseOverride.source : "NONE"),
    preReleasePullbackCarried: Boolean(c.preReleasePullback?.eligible),
    postPullback5mAlignment,
    mode: CFG.REENTRY_PHASE, launchPath: launchPath || "STANDARD_TWO_CONFIRM", automaticOrderSent: false,
  };
  c.observedCandidates = Number(c.observedCandidates || 0) + 1;
  c.lastCandidate = candidate;
  c.phase = "CANDIDATE_OBSERVED";
  c.reason = launchPath ? `PULLBACK_RECLAIM_${launchPath}_CONFIRMED` : "PULLBACK_RECLAIM_MICROBREAKOUT_CONFIRMED";
  c.active = false;
  resetReentryReclaim(c);

  if (!reentryAutoEnabled()) {
    await persistState("reentry_candidate_shadow");
    log("INFO", "FVVO_REENTRY_CANDIDATE_SHADOW", candidate);
    return;
  }

  state.position = buildPosition(price, { stopPrice: projectedStop.stopPrice, stopPct: projectedStop.stopDistancePct, profitTargetPrice: 0, profitTargetPct: 0 }, { entryOrigin: "AUTO_REENTRY", profile: REENTRY_PROFILE, reentryNumber: candidate.sequence });
  state.position.reentryCampaignId = c.id;
  state.position.reentryCandidateId = candidate.id;
  state.externalDealLock = { active: true, source: "auto_reentry", setAt: nowIso(), reason: "AUTO_REENTRY_PENDING_FORWARD" };
  state.manual = { ...state.manual, handoffActive: false, recoveryRequired: false, recoveryReason: "", lastAction: "auto_reentry", lastActionAt: nowIso() };
  candidate.automaticOrderSent = true;
  candidate.forwardStatus = "PENDING";
  await persistState("reentry_auto_pre_forward");
  log("INFO", "FVVO_REENTRY_CANDIDATE_AUTO", { ...candidate, executionMode: CFG.EXECUTION_MODE });
  const result = await forward3Commas("enter_long", price, candidate.profile, { dedupeKey: `auto_reentry_enter_${candidate.id}`, stopPct: projectedStop.stopDistancePct });
  if (!result.ok) {
    state.position.lifecycle = "ENTRY_UNKNOWN_AFTER_FORWARD_ERROR";
    state.manual.recoveryRequired = true;
    state.manual.recoveryReason = `AUTO_REENTRY_FORWARD_UNCERTAIN_${result.error}`;
    state.externalDealLock.reason = "AUTO_REENTRY_FORWARD_UNCERTAIN";
    candidate.forwardStatus = "FORWARD_UNCERTAIN";
    candidate.forwardRequestId = result.requestId || null;
    await persistState("reentry_auto_forward_uncertain");
    log("ERROR", "FVVO_REENTRY_FORWARD_UNCERTAIN", { candidateId: candidate.id, reentryNumber: candidate.sequence, requestId: result.requestId || null, error: result.error });
    return;
  }
  state.position.lifecycle = "ENTRY_ACCEPTED_UNVERIFIED_FILL";
  state.position.entryAcceptedAt = nowIso();
  state.position.entryAcceptedAtMs = nowMs();
  state.position.entryForwardRequestId = result.requestId;
  state.externalDealLock.reason = "AUTO_REENTRY_ACCEPTED_UNVERIFIED_FILL";
  candidate.forwardStatus = "FORWARDED_UNVERIFIED";
  candidate.forwardRequestId = result.requestId;
  await persistState("reentry_auto_forward_accepted");
  log("INFO", "FVVO_AUTO_REENTRY_ENTRY_TRACKED", { candidateId: candidate.id, reentryNumber: candidate.sequence, entryPriceReference: price, stopPrice: projectedStop.stopPrice, stopDistancePct: projectedStop.stopDistancePct, requestId: result.requestId, entrySizeSource: CFG.C3_ENTRY_SIZE_SOURCE, entryOrderIncludedInWebhook: false, fillVerified: false });
}

function ensurePriceEntryState() {
  if (!state.priceEntry || typeof state.priceEntry !== "object") state.priceEntry = { pending: null, pending2: null, pending3: null, last: null, dormantDeepFallback: null };
  if (state.priceEntry.dormantDeepFallback && typeof state.priceEntry.dormantDeepFallback !== "object") state.priceEntry.dormantDeepFallback = null;
  if (state.priceEntry.pending && typeof state.priceEntry.pending !== "object") state.priceEntry.pending = null;
  if (state.priceEntry.pending2 && typeof state.priceEntry.pending2 !== "object") state.priceEntry.pending2 = null;
  if (state.priceEntry.pending3 && typeof state.priceEntry.pending3 !== "object") state.priceEntry.pending3 = null;
  const seen = new Set();
  for (const slot of ["pending", "pending2", "pending3"]) {
    const item = state.priceEntry[slot];
    if (!item) continue;
    if (!item.id || seen.has(item.id)) state.priceEntry[slot] = null;
    else seen.add(item.id);
  }
  return state.priceEntry;
}

function activePriceEntryItems() {
  const pe = ensurePriceEntryState();
  return [pe.pending, pe.pending2, pe.pending3].filter((item) => item && typeof item === "object");
}

function priceEntryKind(modeOrItem) {
  const mode = String(modeOrItem?.triggerMode || modeOrItem || "").toLowerCase();
  return (mode === "breakout" || mode === "breakout_retest_reclaim_zone") ? "breakout" : "dip";
}

function priceEntryKindLabel(kind) {
  return kind === "breakout" ? "BREAKOUT" : "DIP";
}

function priceEntrySlotFor(item) {
  const pe = ensurePriceEntryState();
  if (item?.id && pe.pending?.id === item.id) return "pending";
  if (item?.id && pe.pending2?.id === item.id) return "pending2";
  if (item?.id && pe.pending3?.id === item.id) return "pending3";
  return !pe.pending ? "pending" : (!pe.pending2 ? "pending2" : "pending3");
}

function setPriceEntrySlot(item) {
  const pe = ensurePriceEntryState();
  const slot = !pe.pending ? "pending" : (!pe.pending2 ? "pending2" : "pending3");
  pe[slot] = item;
  return slot;
}

function clearPriceEntrySlot(item) {
  const pe = ensurePriceEntryState();
  const slot = priceEntrySlotFor(item);
  if (["pending", "pending2", "pending3"].includes(slot)) pe[slot] = null;
}

function trailingDipReclaimMode() { return CFG.TRAILING_DIP_RECLAIM_MODE; }
function trailingDipReclaimZoneMode() { return CFG.TRAILING_DIP_RECLAIM_ZONE_MODE; }
function breakoutRetestReclaimZoneMode() { return CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MODE; }
function breakoutShallowHoldReclaimMode() { return CFG.BREAKOUT_SHALLOW_HOLD_RECLAIM_MODE; }
function entry5mBearGuardMode() { return CFG.ENTRY_5M_BEAR_GUARD_MODE; }
function entry5mBearGuardApplies(pending) {
  const role = String(pending?.entryRole || "").toLowerCase();
  return (role === "preferred" && CFG.ENTRY_5M_BEAR_GUARD_APPLY_PREFERRED) || (role === "deep_alternative" && CFG.ENTRY_5M_BEAR_GUARD_APPLY_DEEP);
}
function entry5mStrongBearContext(feature) {
  const ctx = state.lastFeature5m;
  const age = ageSec(ctx);
  const ema8 = finite(ctx?.ema8, null), ema18 = finite(ctx?.ema18, null), fvvo = finite(ctx?.fvvo, null);
  const ray = String(ctx?.rayRegime || "").toUpperCase();
  const available = Boolean(ctx) && Number.isFinite(age) && age <= CFG.ENTRY_5M_BEAR_GUARD_MAX_AGE_SEC && ema8 !== null && ema18 !== null && fvvo !== null;
  const belowEma8 = available && feature.price < ema8 - 1e-9;
  const belowEma18 = available && feature.price < ema18 - 1e-9;
  const fvvoBear = available && fvvo < CFG.ENTRY_5M_BEAR_GUARD_MAX_FVVO;
  const rayBear = available && ray.startsWith("RAY_BEAR");
  const strongBear = available && belowEma8 && belowEma18 && fvvoBear && (!CFG.ENTRY_5M_BEAR_GUARD_REQUIRE_RAY_BEAR || rayBear);
  return { available, strongBear, ageSec: Number.isFinite(age) ? round(age, 3) : null, price: feature.price, ema8, ema18, fvvo, slope: finite(ctx?.slope, null), rsi: finite(ctx?.rsi, null), adx: finite(ctx?.adx, null), rayRegime: ctx?.rayRegime || null, barTimeMs: finite(ctx?.barTimeMs, null), receivedAt: ctx?.receivedAt || null, belowEma8, belowEma18, fvvoBear, rayBear };
}
function updateEntry5mGuardReference(guard) {
  const ctx = state.lastFeature5m;
  const age = ageSec(ctx);
  const ema8 = finite(ctx?.ema8, null), ema18 = finite(ctx?.ema18, null);
  if (!ctx || !Number.isFinite(age) || age > CFG.ENTRY_5M_BEAR_GUARD_MAX_AGE_SEC || ema8 === null || ema18 === null) return guard;
  const barTimeMs = finite(ctx.barTimeMs, 0);
  if (barTimeMs >= finite(guard.referenceBarTimeMs, 0)) {
    guard.referenceEma8 = ema8; guard.referenceEma18 = ema18; guard.referenceBarTimeMs = barTimeMs; guard.referenceReceivedAt = ctx.receivedAt || null;
    guard.referenceFvvo = finite(ctx.fvvo, null); guard.referenceSlope = finite(ctx.slope, null); guard.referenceRayRegime = ctx.rayRegime || null;
  }
  return guard;
}
function entry5mFastReleaseEvidence(feature, guard) {
  updateEntry5mGuardReference(guard);
  const refEma8 = finite(guard?.referenceEma8, null), refEma18 = finite(guard?.referenceEma18, null);
  const referenceKind = CFG.ENTRY_5M_BEAR_GUARD_RELEASE_REFERENCE === "ema8" ? "ema8" : "ema18";
  const referencePrice = referenceKind === "ema8" ? refEma8 : refEma18;
  const releaseFloor = referencePrice === null ? null : referencePrice * (1 - CFG.ENTRY_5M_BEAR_GUARD_RELEASE_STRUCTURE_TOLERANCE_PCT / 100);
  const fvvo = finite(feature.fvvo, null), slope = finite(feature.slope, null), context5mFvvo = finite(guard?.referenceFvvo, null);
  const priceStructural = releaseFloor !== null && feature.price + 1e-9 >= releaseFloor;
  const fvvoOk = fvvo !== null && fvvo >= CFG.ENTRY_5M_BEAR_GUARD_RELEASE_MIN_FVVO;
  const slopeOk = slope !== null && slope >= CFG.ENTRY_5M_BEAR_GUARD_RELEASE_MIN_SLOPE;
  const rayOk = !CFG.ENTRY_5M_BEAR_GUARD_RELEASE_REQUIRE_RAY_NOT_BEAR || nonBearRay(feature.rayRegime);
  return { qualifies: priceStructural && fvvoOk && slopeOk && rayOk, referenceKind, referencePrice, releaseFloor: releaseFloor === null ? null : round(releaseFloor, 8), referenceEma8: refEma8, referenceEma18: refEma18, context5mFvvo, priceStructural, fvvoOk, slopeOk, rayOk, fvvo, slope, rayRegime: feature.rayRegime || null };
}
function isTrailingDipReclaim(pending) { return String(pending?.triggerMode || "").toLowerCase() === "trailing_dip_reclaim"; }
function isTrailingDipReclaimZone(pending) { return String(pending?.triggerMode || "").toLowerCase() === "trailing_dip_reclaim_zone"; }
function isConfirmedPullbackReclaimZone(pending) { return String(pending?.triggerMode || "").toLowerCase() === "confirmed_pullback_reclaim_zone"; }
function isHybridPullbackReclaimZone(pending) { return String(pending?.triggerMode || "").toLowerCase() === "hybrid_pullback_reclaim_zone"; }
function isBreakoutRetestReclaimZone(pending) { return String(pending?.triggerMode || "").toLowerCase() === "breakout_retest_reclaim_zone"; }
function isAnyTrailingDipReclaim(pending) { return isTrailingDipReclaim(pending) || isTrailingDipReclaimZone(pending) || isConfirmedPullbackReclaimZone(pending); }
function nonBearRay(value) { return !String(value || "").toUpperCase().includes("BEAR"); }

function trailingDipReclaimPublic(item) {
  const t = item?.trailing;
  if (!t || typeof t !== "object") return null;
  return {
    mode: isConfirmedPullbackReclaimZone(item) ? CFG.CONFIRMED_PULLBACK_RECLAIM_ZONE_MODE : (isTrailingDipReclaimZone(item) ? trailingDipReclaimZoneMode() : trailingDipReclaimMode()),
    phase: t.phase || "ARMED",
    activatedAt: t.activatedAt || null,
    activationPrice: item.activationPrice || item.triggerPrice || null,
    activationRangeLow: item.activationRangeLow || null,
    activationRangeHigh: item.activationRangeHigh || null,
    observedLowPrice: t.observedLowPrice || null,
    observedLowAt: t.observedLowAt || null,
    observedDropPct: t.observedDropPct || 0,
    lowStopBufferPct: t.lowStopBufferPct || 0,
    minDipQualified: Boolean(t.minDipQualified),
    reclaimTargetPrice: t.reclaimTargetPrice || null,
    maxEntryPrice: t.maxEntryPrice || null,
    trackingExpiresAt: t.trackingExpiresAt || null,
    confirmed15mAt: t.confirmed15mAt || null,
    confirmed15mClose: t.confirmed15mClose || null,
    retestSeen: Boolean(t.retestSeen),
    fastConfirmObservations: Math.max(0, Math.floor(finite(t.fastConfirmObservations, 0))),
    lastFastEvidence: t.lastFastEvidence || null,
    tickRecoveryRequired: Boolean(isTrailingDipReclaimZone(item) ? CFG.TRAILING_DIP_RECLAIM_ZONE_REQUIRE_TICK_RECOVERY : CFG.TRAILING_DIP_RECLAIM_REQUIRE_TICK_RECOVERY),
    entry5mBearGuard: t.entry5mBearGuard ? { active: Boolean(t.entry5mBearGuard.active), armedAt: t.entry5mBearGuard.armedAt || null, role: item.entryRole || "standalone", referenceEma8: finite(t.entry5mBearGuard.referenceEma8, null), referenceEma18: finite(t.entry5mBearGuard.referenceEma18, null), releaseObservations: Math.max(0, Math.floor(finite(t.entry5mBearGuard.releaseObservations, 0))), lastEvidence: t.entry5mBearGuard.lastEvidence || null } : null,
  };
}

function priceEntryStatusPayload() {
  const pe = ensurePriceEntryState();
  const pending = pe.pending;
  const pending2 = pe.pending2;
  const pending3 = pe.pending3;
  const pendingList = activePriceEntryItems();
  const serialize = (item) => item ? {
    id: item.id,
    status: item.status,
    triggerMode: item.triggerMode,
    triggerKind: priceEntryKind(item),
    entryCampaign: item.entryCampaign || null,
    entryRole: item.entryRole || "standalone",
    campaignOrdinal: Math.max(0, Math.floor(finite(item.campaignOrdinal, 0))),
    slot: priceEntrySlotFor(item),
    triggerPrice: item.triggerPrice,
    activationPrice: item.activationPrice || null,
    activationRangeLow: item.activationRangeLow || null,
    activationRangeHigh: item.activationRangeHigh || null,
    breakoutConfirmPrice: item.breakoutConfirmPrice || null,
    retestRangeLow: item.retestRangeLow || null,
    retestRangeHigh: item.retestRangeHigh || null,
    armedReferencePrice: item.armedReferencePrice,
    stopPrice: item.stopPrice,
    stopPctAtTrigger: item.stopPctAtTrigger,
    profitTargetPrice: item.profitTargetPrice || null,
    profitTargetPctAtTrigger: item.profitTargetPctAtTrigger || 0,
    intelligentTp: item.intelligentTp || null,
    armedAt: item.armedAt,
    expiresAt: item.expiresAt,
    lastObservedPrice: item.lastObservedPrice,
    lastObservedAt: item.lastObservedAt,
    triggeredAt: item.triggeredAt || null,
    triggeredPrice: item.triggeredPrice || null,
    resolutionReason: item.resolutionReason || null,
    requestId: item.requestId || null,
    trailingDipReclaim: trailingDipReclaimPublic(item),
  } : null;
  return {
    enabled: CFG.PRICE_ENTRY_ENABLED,
    profile: PROFILE,
    automaticOrderOnCross: CFG.PRICE_ENTRY_ENABLED,
    triggerSource: CFG.PRICE_ENTRY_TRIGGER_ON_FAST_TICK ? "feature_tick_or_fast_tick" : "feature_tick_only",
    requireActualCross: CFG.PRICE_ENTRY_REQUIRE_ACTUAL_CROSS,
    maxPending: CFG.PRICE_ENTRY_MAX_PENDING,
    activePendingCount: pendingList.length,
    activeKinds: pendingList.map((item) => priceEntryKind(item)),
    minTriggerDistancePct: CFG.PRICE_ENTRY_MIN_TRIGGER_DISTANCE_PCT,
    maxTriggerDistancePct: CFG.PRICE_ENTRY_MAX_TRIGGER_DISTANCE_PCT,
    trailingDipReclaim: {
      enabled: CFG.TRAILING_DIP_RECLAIM_MODE !== "disabled",
      mode: trailingDipReclaimMode(),
      minDropPct: CFG.TRAILING_DIP_RECLAIM_MIN_DROP_PCT,
      reclaimPct: CFG.TRAILING_DIP_RECLAIM_RECLAIM_PCT,
      maxChasePct: CFG.TRAILING_DIP_RECLAIM_MAX_CHASE_PCT,
      maxTrackSec: CFG.TRAILING_DIP_RECLAIM_MAX_TRACK_SEC,
      minLowAboveStopPct: CFG.TRAILING_DIP_RECLAIM_MIN_LOW_ABOVE_STOP_PCT,
      requireTickRecovery: CFG.TRAILING_DIP_RECLAIM_REQUIRE_TICK_RECOVERY,
    },
    trailingDipReclaimZone: {
      enabled: CFG.TRAILING_DIP_RECLAIM_ZONE_MODE !== "disabled",
      mode: trailingDipReclaimZoneMode(),
      reclaimPct: CFG.TRAILING_DIP_RECLAIM_ZONE_RECLAIM_PCT,
      maxEntryAboveHighPct: CFG.TRAILING_DIP_RECLAIM_ZONE_MAX_ENTRY_ABOVE_HIGH_PCT,
      minPenetrationPct: CFG.TRAILING_DIP_RECLAIM_ZONE_MIN_PENETRATION_PCT,
      maxTrackSec: CFG.TRAILING_DIP_RECLAIM_ZONE_MAX_TRACK_SEC,
      minLowAboveStopPct: CFG.TRAILING_DIP_RECLAIM_ZONE_MIN_LOW_ABOVE_STOP_PCT,
      requireTickRecovery: CFG.TRAILING_DIP_RECLAIM_ZONE_REQUIRE_TICK_RECOVERY,
    },
    confirmedPullbackReclaimZone: {
      enabled: CFG.CONFIRMED_PULLBACK_RECLAIM_ZONE_MODE !== "disabled",
      mode: CFG.CONFIRMED_PULLBACK_RECLAIM_ZONE_MODE,
      minPenetrationPct: CFG.CONFIRMED_PULLBACK_MIN_PENETRATION_PCT,
      confirmBufferPct: CFG.CONFIRMED_PULLBACK_15M_CONFIRM_BUFFER_PCT,
      aligned15mMinute: CFG.CONFIRMED_PULLBACK_15M_ALIGNMENT_MINUTE,
      retestTouchAbovePct: CFG.CONFIRMED_PULLBACK_RETEST_TOUCH_ABOVE_PCT,
      retestHoldBelowPct: CFG.CONFIRMED_PULLBACK_RETEST_HOLD_BELOW_PCT,
      maxEntryAboveConfirmPct: CFG.CONFIRMED_PULLBACK_MAX_ENTRY_ABOVE_CONFIRM_PCT,
      fastConfirmObservations: CFG.CONFIRMED_PULLBACK_FAST_CONFIRM_OBSERVATIONS,
      dormantDeepFallbackEnabled: CFG.CONFIRMED_PULLBACK_DORMANT_DEEP_FALLBACK_ENABLED,
      dormantDeepMaxPriorExitPnlPct: CFG.CONFIRMED_PULLBACK_DORMANT_DEEP_MAX_PRIOR_EXIT_PNL_PCT,
    },
    breakoutRetestReclaimZone: {
      enabled: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MODE !== "disabled",
      mode: breakoutRetestReclaimZoneMode(),
      reclaimPct: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_RECLAIM_PCT,
      maxEntryAboveHighPct: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MAX_ENTRY_ABOVE_HIGH_PCT,
      minRetestPenetrationPct: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_RETEST_PENETRATION_PCT,
      confirmBufferPct: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRM_BUFFER_PCT,
      confirmObservations: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRM_OBSERVATIONS,
      adaptiveConfirmEnabled: CFG.BREAKOUT_RETEST_ADAPTIVE_CONFIRM_ENABLED,
      adaptiveHoldTolerancePct: CFG.BREAKOUT_RETEST_ADAPTIVE_HOLD_TOLERANCE_PCT,
      adaptiveHoldMaxSec: CFG.BREAKOUT_RETEST_ADAPTIVE_HOLD_MAX_SEC,
      minTickSlope: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_TICK_SLOPE,
      minFvvo: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_FVVO,
      chasePolicy: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_CHASE_POLICY,
      shallowHoldReclaim: {
        mode: breakoutShallowHoldReclaimMode(),
        maxTrackSec: CFG.BREAKOUT_SHALLOW_HOLD_MAX_TRACK_SEC,
        maxAboveConfirmPct: CFG.BREAKOUT_SHALLOW_HOLD_MAX_ABOVE_CONFIRM_PCT,
        minPullbackFromHighPct: CFG.BREAKOUT_SHALLOW_HOLD_MIN_PULLBACK_FROM_HIGH_PCT,
        minObservations: CFG.BREAKOUT_SHALLOW_HOLD_MIN_OBSERVATIONS,
        reclaimPct: CFG.BREAKOUT_SHALLOW_HOLD_RECLAIM_PCT,
        maxEntryAboveConfirmPct: CFG.BREAKOUT_SHALLOW_HOLD_MAX_ENTRY_ABOVE_CONFIRM_PCT,
        minAdx: CFG.BREAKOUT_SHALLOW_HOLD_MIN_ADX,
        minFvvo: CFG.BREAKOUT_SHALLOW_HOLD_MIN_FVVO,
        minSlope: CFG.BREAKOUT_SHALLOW_HOLD_MIN_SLOPE,
        requireAboveEma8: CFG.BREAKOUT_SHALLOW_HOLD_REQUIRE_ABOVE_EMA8,
        requireRayNotBear: CFG.BREAKOUT_SHALLOW_HOLD_REQUIRE_RAY_NOT_BEAR,
      },
      expiryWarningSec: CFG.PRICE_TRIGGER_EXPIRY_WARNING_SEC,
      postExpiryShadowEnabled: CFG.BREAKOUT_RETEST_POST_EXPIRY_SHADOW_ENABLED,
      failBelowLowBufferPct: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_FAIL_BELOW_LOW_BUFFER_PCT,
      maxTrackSec: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MAX_TRACK_SEC,
      requireTickRecovery: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_REQUIRE_TICK_RECOVERY,
    },
    campaign: (() => {
      const members = pendingList.filter((item) => item.entryCampaign);
      if (!members.length) return null;
      const id = members[0].entryCampaign;
      return {
        id,
        activeCount: members.length,
        roles: members.map((item) => item.entryRole),
        setups: Object.fromEntries(members.map((item) => [item.entryRole, { id: item.id, status: item.status, triggerMode: item.triggerMode, slot: priceEntrySlotFor(item), expiresAt: item.expiresAt }])),
      };
    })(),
    pending: serialize(pending),
    pending2: serialize(pending2),
    pending3: serialize(pending3),
    pendingList: pendingList.map(serialize),
    dormantDeepFallback: pe.dormantDeepFallback ? { id: pe.dormantDeepFallback.id, status: pe.dormantDeepFallback.status, entryCampaign: pe.dormantDeepFallback.entryCampaign || null, entryRole: pe.dormantDeepFallback.entryRole || null, expiresAt: pe.dormantDeepFallback.expiresAt || null, preferredTriggerId: pe.dormantDeepFallback.preferredTriggerId || null } : null,
    last: serialize(pe.last),
  };
}

function isPriceTriggerFeature(feature) {
  return feature.kind === CFG.FVVO_FEATURE_TICK_EVENT || (CFG.PRICE_ENTRY_TRIGGER_ON_FAST_TICK && feature.kind === CFG.FVVO_FAST_TICK_EVENT);
}

function validTriggerMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return ["dip", "breakout", "trailing_dip_reclaim", "trailing_dip_reclaim_zone", "confirmed_pullback_reclaim_zone", "hybrid_pullback_reclaim_zone", "breakout_retest_reclaim_zone"].includes(mode) ? mode : "";
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
  if (["price", "entry_price", "entryPrice"].some((key) => Object.prototype.hasOwnProperty.call(body, key))) return { ok: false, error: "ENTRY_PRICE_FIELD_NOT_ALLOWED" };
  const mode = validTriggerMode(body.trigger_mode || body.triggerMode);
  if (!mode) return { ok: false, error: "TRIGGER_MODE_NOT_SUPPORTED" };
  const isTrailing = mode === "trailing_dip_reclaim";
  const isZone = mode === "trailing_dip_reclaim_zone";
  const isConfirmedPullback = mode === "confirmed_pullback_reclaim_zone";
  const isHybridPullback = mode === "hybrid_pullback_reclaim_zone";
  const isBreakoutRetestZone = mode === "breakout_retest_reclaim_zone";
  if (isTrailing && trailingDipReclaimMode() === "disabled") return { ok: false, error: "TRAILING_DIP_RECLAIM_DISABLED" };
  if (isZone && trailingDipReclaimZoneMode() === "disabled") return { ok: false, error: "TRAILING_DIP_RECLAIM_ZONE_DISABLED" };
  if (isConfirmedPullback && CFG.CONFIRMED_PULLBACK_RECLAIM_ZONE_MODE === "disabled") return { ok: false, error: "CONFIRMED_PULLBACK_RECLAIM_ZONE_DISABLED" };
  if (isHybridPullback && CFG.HYBRID_PULLBACK_FAST_PATH_MODE === "disabled") return { ok: false, error: "HYBRID_PULLBACK_RECLAIM_ZONE_DISABLED" };
  if (isBreakoutRetestZone && breakoutRetestReclaimZoneMode() === "disabled") return { ok: false, error: "BREAKOUT_RETEST_RECLAIM_ZONE_DISABLED" };

  if (isZone || isConfirmedPullback || isHybridPullback || isBreakoutRetestZone) {
    if (isZone && ["trigger_price", "triggerPrice", "activation_price", "activationPrice", "breakout_confirm_price", "breakoutConfirmPrice", "retest_range_low", "retestRangeLow", "retest_range_high", "retestRangeHigh"].some((key) => Object.prototype.hasOwnProperty.call(body, key))) return { ok: false, error: "USE_ACTIVATION_RANGE_LOW_HIGH_FOR_TRAILING_DIP_RECLAIM_ZONE" };
    if (isBreakoutRetestZone && ["trigger_price", "triggerPrice", "activation_price", "activationPrice"].some((key) => Object.prototype.hasOwnProperty.call(body, key))) return { ok: false, error: "USE_BREAKOUT_CONFIRM_PRICE_AND_RETEST_RANGE_LOW_HIGH_FOR_BREAKOUT_RETEST_RECLAIM_ZONE" };

    const lowField = isBreakoutRetestZone ? oneOf(body, ["retest_range_low", "retestRangeLow", "activation_range_low", "activationRangeLow"]) : oneOf(body, ["activation_range_low", "activationRangeLow"]);
    const highField = isBreakoutRetestZone ? oneOf(body, ["retest_range_high", "retestRangeHigh", "activation_range_high", "activationRangeHigh"]) : oneOf(body, ["activation_range_high", "activationRangeHigh"]);
    if (!lowField.present || !Number.isFinite(lowField.value) || !validStep(lowField.value)) return { ok: false, error: isBreakoutRetestZone ? "VALID_RETEST_RANGE_LOW_ALIGNED_TO_PRICE_STEP_REQUIRED" : "VALID_ACTIVATION_RANGE_LOW_ALIGNED_TO_PRICE_STEP_REQUIRED" };
    if (!highField.present || !Number.isFinite(highField.value) || !validStep(highField.value)) return { ok: false, error: isBreakoutRetestZone ? "VALID_RETEST_RANGE_HIGH_ALIGNED_TO_PRICE_STEP_REQUIRED" : "VALID_ACTIVATION_RANGE_HIGH_ALIGNED_TO_PRICE_STEP_REQUIRED" };
    const rangeLow = round(lowField.value, 8);
    const rangeHigh = round(highField.value, 8);
    if (!(rangeLow > 0) || !(rangeHigh > 0) || rangeLow >= rangeHigh) return { ok: false, error: isBreakoutRetestZone ? "RETEST_RANGE_LOW_MUST_BE_BELOW_HIGH" : "ACTIVATION_RANGE_LOW_MUST_BE_BELOW_HIGH" };

    let breakoutConfirmPrice = null;
    if (isBreakoutRetestZone || isConfirmedPullback || isHybridPullback) {
      const confirmField = oneOf(body, ["breakout_confirm_price", "breakoutConfirmPrice", "breakout_price", "breakoutPrice"]);
      breakoutConfirmPrice = confirmField.present ? round(confirmField.value, 8) : null;
      if (!Number.isFinite(breakoutConfirmPrice) || !validStep(breakoutConfirmPrice) || breakoutConfirmPrice <= 0) return { ok: false, error: "VALID_BREAKOUT_CONFIRM_PRICE_ALIGNED_TO_PRICE_STEP_REQUIRED" };
      if (breakoutConfirmPrice < rangeHigh) return { ok: false, error: "BREAKOUT_CONFIRM_PRICE_MUST_BE_AT_OR_ABOVE_RETEST_RANGE_HIGH" };
      if (isBreakoutRetestZone && breakoutConfirmPrice <= currentPrice) return { ok: false, error: "BREAKOUT_CONFIRM_PRICE_MUST_BE_ABOVE_CURRENT_PRICE" };
    }

    if ((isZone || isConfirmedPullback || isHybridPullback) && rangeHigh >= currentPrice) return { ok: false, error: "ACTIVATION_RANGE_HIGH_MUST_BE_BELOW_CURRENT_PRICE" };
    const triggerReference = (isBreakoutRetestZone || isConfirmedPullback || isHybridPullback) ? breakoutConfirmPrice : rangeHigh;
    const gapPct = isBreakoutRetestZone ? percentPnl(currentPrice, triggerReference) : percentageBelow(currentPrice, rangeHigh);
    if (gapPct + 1e-9 < CFG.PRICE_ENTRY_MIN_TRIGGER_DISTANCE_PCT) return { ok: false, error: isBreakoutRetestZone ? "BREAKOUT_CONFIRM_PRICE_TOO_CLOSE_TO_CURRENT_PRICE" : "TRIGGER_RANGE_TOO_CLOSE_TO_CURRENT_PRICE" };
    if (gapPct > CFG.PRICE_ENTRY_MAX_TRIGGER_DISTANCE_PCT + 1e-9) return { ok: false, error: isBreakoutRetestZone ? "BREAKOUT_CONFIRM_PRICE_TOO_FAR_FROM_CURRENT_PRICE" : "TRIGGER_RANGE_TOO_FAR_FROM_CURRENT_PRICE" };
    const stopPreview = finite(body.stop_price, finite(body.stopPrice, null));
    if (!(stopPreview > 0) || stopPreview >= rangeLow) return { ok: false, error: isBreakoutRetestZone ? "STOP_PRICE_MUST_BE_BELOW_RETEST_RANGE_LOW" : "STOP_PRICE_MUST_BE_BELOW_ACTIVATION_RANGE_LOW" };
    const levels = validateOneStopCommand(body, triggerReference);
    if (!levels.ok) return { ok: false, error: levels.error };
    const expiry = resolvePriceTriggerExpiry(body);
    if (!expiry.ok) return expiry;
    return { ok: true, triggerMode: mode, triggerPrice: triggerReference, activationPrice: (isConfirmedPullback || isHybridPullback) ? rangeHigh : triggerReference, activationRangeLow: rangeLow, activationRangeHigh: rangeHigh, breakoutConfirmPrice: (isBreakoutRetestZone || isConfirmedPullback || isHybridPullback) ? breakoutConfirmPrice : null, retestRangeLow: isBreakoutRetestZone ? rangeLow : null, retestRangeHigh: isBreakoutRetestZone ? rangeHigh : null, armPrice: round(currentPrice, 8), triggerDistancePct: round(gapPct, 6), levels, expirySec: expiry.seconds };
  }

  const level = isTrailing ? oneOf(body, ["activation_price", "activationPrice"]) : oneOf(body, ["trigger_price", "triggerPrice"]);
  if (isTrailing && ["trigger_price", "triggerPrice"].some((key) => Object.prototype.hasOwnProperty.call(body, key))) return { ok: false, error: "USE_ACTIVATION_PRICE_ONLY_FOR_TRAILING_DIP_RECLAIM" };
  if (!level.present || !Number.isFinite(level.value) || !validStep(level.value)) return { ok: false, error: isTrailing ? "VALID_ACTIVATION_PRICE_ALIGNED_TO_PRICE_STEP_REQUIRED" : "VALID_TRIGGER_PRICE_ALIGNED_TO_PRICE_STEP_REQUIRED" };
  const triggerPrice = round(level.value, 8);
  const gapPct = isTrailing || mode === "dip" ? percentageBelow(currentPrice, triggerPrice) : percentPnl(currentPrice, triggerPrice);
  if ((isTrailing || mode === "dip") && triggerPrice >= currentPrice) return { ok: false, error: isTrailing ? "ACTIVATION_PRICE_MUST_BE_BELOW_CURRENT_PRICE" : "DIP_TRIGGER_MUST_BE_BELOW_CURRENT_PRICE" };
  if (mode === "breakout" && triggerPrice <= currentPrice) return { ok: false, error: "BREAKOUT_TRIGGER_MUST_BE_ABOVE_CURRENT_PRICE" };
  if (gapPct + 1e-9 < CFG.PRICE_ENTRY_MIN_TRIGGER_DISTANCE_PCT) return { ok: false, error: "TRIGGER_PRICE_TOO_CLOSE_TO_CURRENT_PRICE" };
  if (gapPct > CFG.PRICE_ENTRY_MAX_TRIGGER_DISTANCE_PCT + 1e-9) return { ok: false, error: "TRIGGER_PRICE_TOO_FAR_FROM_CURRENT_PRICE" };
  const levels = validateOneStopCommand(body, triggerPrice);
  if (!levels.ok) return { ok: false, error: levels.error };
  const expiry = resolvePriceTriggerExpiry(body);
  if (!expiry.ok) return expiry;
  return { ok: true, triggerMode: mode, triggerPrice, activationPrice: isTrailing ? triggerPrice : null, armPrice: round(currentPrice, 8), triggerDistancePct: round(gapPct, 6), levels, expirySec: expiry.seconds };
}

function validateStoredPriceTriggerAtExecution(pending, executionPrice) {
  if (!Number.isFinite(executionPrice) || executionPrice <= 0) return { ok: false, error: "INVALID_EXECUTION_PRICE" };
  const body = { stop_price: pending.stopPrice, profit_target_price: pending.profitTargetPrice || 0 };
  if (pending.intelligentTp) Object.assign(body, { tp1_price: pending.intelligentTp.tp1Price, tp2_price: pending.intelligentTp.tp2Price, tp3_price: pending.intelligentTp.tp3Price });
  const levels = validateOneStopCommand(body, executionPrice);
  if (!levels.ok) return { ok: false, error: `EXECUTION_LEVELS_INVALID_${levels.error}` };
  return { ok: true, levels };
}

function priceTriggerCrossed(pending, previousPrice, currentPrice) {
  if (!Number.isFinite(previousPrice) || !Number.isFinite(currentPrice)) return false;
  const trigger = pending.activationPrice || pending.triggerPrice;
  const epsilon = Math.max(CFG.MANUAL_ONE_STOP_PRICE_STEP / 10, 1e-9);
  if (pending.triggerMode === "dip" || pending.triggerMode === "trailing_dip_reclaim") return previousPrice > trigger + epsilon && currentPrice <= trigger + epsilon;
  if (pending.triggerMode === "trailing_dip_reclaim_zone") {
    const rangeHigh = finite(pending.activationRangeHigh, trigger);
    return previousPrice > rangeHigh + epsilon && currentPrice <= rangeHigh + epsilon;
  }
  if (pending.triggerMode === "confirmed_pullback_reclaim_zone") {
    const rangeHigh = finite(pending.activationRangeHigh, trigger);
    return previousPrice > rangeHigh + epsilon && currentPrice <= rangeHigh + epsilon;
  }
  if (pending.triggerMode === "hybrid_pullback_reclaim_zone") {
    const rangeHigh = finite(pending.activationRangeHigh, trigger);
    return previousPrice > rangeHigh + epsilon && currentPrice <= rangeHigh + epsilon;
  }
  if (pending.triggerMode === "breakout_retest_reclaim_zone") {
    const breakoutConfirmPrice = finite(pending.breakoutConfirmPrice, trigger);
    const confirmThreshold = breakoutConfirmPrice * (1 + CFG.BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRM_BUFFER_PCT / 100);
    return previousPrice < confirmThreshold - epsilon && currentPrice >= confirmThreshold - epsilon;
  }
  if (pending.triggerMode === "breakout") return previousPrice < trigger - epsilon && currentPrice >= trigger - epsilon;
  return false;
}

function resolvePriceEntryPending(status, reason, fields = {}, target = null) {
  const pe = ensurePriceEntryState();
  let pending = target || pe.pending;
  if (target?.id) {
    if (pe.pending?.id === target.id) pending = pe.pending;
    else if (pe.pending2?.id === target.id) pending = pe.pending2;
    else if (pe.pending3?.id === target.id) pending = pe.pending3;
    else return null;
  }
  if (!pending) return null;
  pe.last = { ...pending, ...fields, status, resolutionReason: reason, resolvedAt: nowIso(), resolvedAtMs: nowMs() };
  if (pe.pending?.id === pending.id) pe.pending = null;
  if (pe.pending2?.id === pending.id) pe.pending2 = null;
  if (pe.pending3?.id === pending.id) pe.pending3 = null;
  return pe.last;
}

function cancelOtherPriceEntries(triggeredId, reason, extra = {}) {
  const pe = ensurePriceEntryState();
  const others = activePriceEntryItems().filter((item) => item.id !== triggeredId);
  const cancelled = [];
  for (const item of others) {
    const resolved = resolvePriceEntryPending("CANCELLED", reason, extra, item);
    if (resolved) cancelled.push(resolved);
  }
  return cancelled;
}

function captureDormantDeepFallback(preferred) {
  if (!CFG.CONFIRMED_PULLBACK_DORMANT_DEEP_FALLBACK_ENABLED || String(preferred?.entryRole || "").toLowerCase() !== "preferred") return null;
  const deep = activePriceEntryItems().find((item) => item.id !== preferred.id && item.entryCampaign && item.entryCampaign === preferred.entryCampaign && String(item.entryRole || "").toLowerCase() === "deep_alternative");
  if (!deep) return null;
  return { ...clone(deep), status: "DORMANT_AFTER_PREFERRED_ENTRY", dormantAt: nowIso(), dormantAtMs: nowMs(), preferredTriggerId: preferred.id, originalExpiresAt: deep.expiresAt, originalExpiresAtMs: deep.expiresAtMs };
}

function reactivateDormantDeepFallback(prior, source = "exit_release") {
  const pe = ensurePriceEntryState();
  const dormant = pe.dormantDeepFallback;
  if (!CFG.CONFIRMED_PULLBACK_DORMANT_DEEP_FALLBACK_ENABLED || !dormant) return null;
  if (String(prior?.priceTrigger?.entryRole || "").toLowerCase() !== "preferred") return null;
  if (finite(prior?.latestPnlPct, 0) > CFG.CONFIRMED_PULLBACK_DORMANT_DEEP_MAX_PRIOR_EXIT_PNL_PCT + 1e-9) {
    pe.dormantDeepFallback = null;
    log("INFO", "FVVO_DORMANT_DEEP_FALLBACK_DISCARDED_PROFIT_EXIT", { source, priorExitPnlPct: prior?.latestPnlPct, maxPnlPct: CFG.CONFIRMED_PULLBACK_DORMANT_DEEP_MAX_PRIOR_EXIT_PNL_PCT });
    return null;
  }
  if (nowMs() >= finite(dormant.originalExpiresAtMs, dormant.expiresAtMs)) {
    pe.dormantDeepFallback = null;
    log("INFO", "FVVO_DORMANT_DEEP_FALLBACK_EXPIRED", { source, triggerId: dormant.id, expiresAt: dormant.originalExpiresAt || dormant.expiresAt || null });
    return null;
  }
  if (activePriceEntryItems().length >= CFG.PRICE_ENTRY_MAX_PENDING) return null;
  const restored = clone(dormant);
  Object.assign(restored, { status: "ARMED", reactivatedAt: nowIso(), reactivatedAtMs: nowMs(), lastObservedPrice: state.lastFeature?.price || restored.lastObservedPrice, lastObservedAt: nowIso(), lastObservedAtMs: nowMs(), expiresAt: dormant.originalExpiresAt || dormant.expiresAt, expiresAtMs: dormant.originalExpiresAtMs || dormant.expiresAtMs, resolutionReason: null, triggeredAt: null, triggeredAtMs: 0, triggeredPrice: null, requestId: null });
  restored.trailing = { phase: "ARMED" };
  const slot = setPriceEntrySlot(restored);
  pe.dormantDeepFallback = null;
  log("INFO", "FVVO_DORMANT_DEEP_FALLBACK_REACTIVATED", { source, triggerId: restored.id, entryCampaign: restored.entryCampaign || null, entryRole: restored.entryRole, slot, expiresAt: restored.expiresAt, priorExitPnlPct: prior?.latestPnlPct });
  return restored;
}

function trailingTickRecoveryOk(feature) {
  if (!CFG.TRAILING_DIP_RECLAIM_REQUIRE_TICK_RECOVERY) return true;
  const ema8 = finite(feature.ema8, null);
  const slope = finite(feature.slope, null);
  if (ema8 === null || feature.price < ema8 || slope === null || slope < CFG.TRAILING_DIP_RECLAIM_MIN_TICK_SLOPE) return false;
  if (CFG.TRAILING_DIP_RECLAIM_REQUIRE_RAY_NOT_BEAR && !nonBearRay(feature.rayRegime)) return false;
  return true;
}
function trailingZoneTickRecoveryOk(feature) {
  if (!CFG.TRAILING_DIP_RECLAIM_ZONE_REQUIRE_TICK_RECOVERY) return true;
  const ema8 = finite(feature.ema8, null);
  const slope = finite(feature.slope, null);
  if (ema8 === null || feature.price < ema8 || slope === null || slope < CFG.TRAILING_DIP_RECLAIM_ZONE_MIN_TICK_SLOPE) return false;
  if (CFG.TRAILING_DIP_RECLAIM_ZONE_REQUIRE_RAY_NOT_BEAR && !nonBearRay(feature.rayRegime)) return false;
  return true;
}
function breakoutRetestZoneTickRecoveryOk(feature) {
  if (!CFG.BREAKOUT_RETEST_RECLAIM_ZONE_REQUIRE_TICK_RECOVERY) return true;
  const ema8 = finite(feature.ema8, null);
  const slope = finite(feature.slope, null);
  const fvvo = finite(feature.fvvo, null);
  if (ema8 === null || feature.price < ema8) return false;
  if (slope === null || slope < CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_TICK_SLOPE) return false;
  if (fvvo === null || fvvo < CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_FVVO) return false;
  if (CFG.BREAKOUT_RETEST_RECLAIM_ZONE_REQUIRE_RAY_NOT_BEAR && !nonBearRay(feature.rayRegime)) return false;
  return true;
}

function breakoutBullContinuationMode() { return CFG.BREAKOUT_BULL_CONTINUATION_MODE; }
function breakoutBullContinuationRecovery(feature) {
  const ema8 = finite(feature.ema8, null), ema18 = finite(feature.ema18, null), rsi = finite(feature.rsi, null), adx = finite(feature.adx, null), fvvo = finite(feature.fvvo, null), slope = finite(feature.slope, null);
  const extensionFromEma8Pct = ema8 !== null && ema8 > 0 ? Math.max(0, percentPnl(ema8, feature.price)) : Infinity;
  const evidence = { aboveEma8: ema8 !== null && feature.price >= ema8, ema8AboveEma18: ema8 !== null && ema18 !== null && ema8 > ema18, rsiOk: rsi !== null && rsi <= CFG.BREAKOUT_BULL_CONTINUATION_MAX_RSI, adxOk: adx !== null && adx >= CFG.BREAKOUT_BULL_CONTINUATION_MIN_ADX, fvvoOk: fvvo !== null && fvvo >= CFG.BREAKOUT_BULL_CONTINUATION_MIN_FVVO, slopeOk: slope !== null && slope >= CFG.BREAKOUT_BULL_CONTINUATION_MIN_SLOPE, extensionFromEma8Pct: round(extensionFromEma8Pct, 6), emaExtensionOk: extensionFromEma8Pct <= CFG.BREAKOUT_BULL_CONTINUATION_MAX_EXTENSION_FROM_EMA8_PCT + 1e-9, rayBullOk: String(feature.rayRegime || "").toUpperCase() === "RAY_BULL" };
  evidence.ok = evidence.aboveEma8 && (!CFG.BREAKOUT_BULL_CONTINUATION_REQUIRE_EMA8_ABOVE_EMA18 || evidence.ema8AboveEma18) && evidence.rsiOk && evidence.adxOk && evidence.fvvoOk && evidence.slopeOk && evidence.emaExtensionOk && (!CFG.BREAKOUT_BULL_CONTINUATION_REQUIRE_RAY_BULL || evidence.rayBullOk);
  return evidence;
}

async function evaluateBreakoutBullContinuation(pending, feature, rangeHigh, breakoutConfirmPrice) {
  if (breakoutBullContinuationMode() === "disabled") return false;
  const t = pending.trailing || (pending.trailing = {}), current = nowMs(), breakoutAtMs = finite(t.breakoutAtMs, 0);
  if (!(breakoutAtMs > 0) || current - breakoutAtMs > CFG.BREAKOUT_BULL_CONTINUATION_MAX_TRACK_SEC * 1000 || !(feature.price > rangeHigh + 1e-9)) return false;
  const highest = Math.max(finite(t.highestBreakoutPrice, feature.price), feature.price);
  const peakExtensionPct = percentPnl(breakoutConfirmPrice, highest);
  if (peakExtensionPct > CFG.BREAKOUT_BULL_CONTINUATION_MAX_PEAK_EXTENSION_PCT + 1e-9) { t.bullContinuationBlowoffVeto = true; return false; }
  if (t.bullContinuationBlowoffVeto || peakExtensionPct + 1e-9 < CFG.BREAKOUT_BULL_CONTINUATION_MIN_PEAK_EXTENSION_PCT) return false;
  const pullbackFromHighPct = percentageBelow(highest, feature.price), maxEntryPrice = breakoutConfirmPrice * (1 + CFG.BREAKOUT_BULL_CONTINUATION_MAX_ENTRY_ABOVE_CONFIRM_PCT / 100);
  if (feature.price <= maxEntryPrice + 1e-9 && pullbackFromHighPct + 1e-9 >= CFG.BREAKOUT_BULL_CONTINUATION_MIN_PULLBACK_FROM_HIGH_PCT) {
    const priorLow = finite(t.bullContinuationLowPrice, null);
    if (priorLow === null || feature.price < priorLow - 1e-9) { t.bullContinuationLowPrice = round(feature.price, 8); t.bullContinuationLowAtMs = feature.receivedAtMs || current; t.bullContinuationObservations = 1; t.bullContinuationShadowCandidateLowPrice = null; }
    else t.bullContinuationObservations = Math.floor(finite(t.bullContinuationObservations, 0)) + 1;
  }
  const low = finite(t.bullContinuationLowPrice, null), observations = Math.floor(finite(t.bullContinuationObservations, 0));
  if (low === null || observations < CFG.BREAKOUT_BULL_CONTINUATION_MIN_OBSERVATIONS) return false;
  const reclaimTarget = low * (1 + CFG.BREAKOUT_BULL_CONTINUATION_RECLAIM_PCT / 100);
  if (feature.price + 1e-9 < reclaimTarget || feature.price > maxEntryPrice + 1e-9) return false;
  const recovery = breakoutBullContinuationRecovery(feature);
  if (!recovery.ok) return false;
  const checked = validateStoredPriceTriggerAtExecution(pending, feature.price);
  if (!checked.ok || checked.levels.stopPct > CFG.BREAKOUT_BULL_CONTINUATION_STOP_DISTANCE_CAP_PCT + 1e-9) return false;
  const candidate = { triggerId: pending.id, breakoutConfirmPrice, retestRangeHigh: rangeHigh, highestBreakoutPrice: highest, peakExtensionPct: round(peakExtensionPct, 6), lowPrice: low, observations, pullbackFromHighPct: round(percentageBelow(highest, low), 6), reclaimTargetPrice: round(reclaimTarget, 8), maxEntryPrice: round(maxEntryPrice, 8), candidateEntryPrice: feature.price, stopPrice: pending.stopPrice, stopDistancePct: checked.levels.stopPct, recovery };
  if (breakoutBullContinuationMode() === "shadow") {
    if (finite(t.bullContinuationShadowCandidateLowPrice, null) !== low) { t.bullContinuationShadowCandidateLowPrice = low; log("INFO", "FVVO_BREAKOUT_BULL_CONTINUATION_SHADOW_CANDIDATE", { ...candidate, action: "NO_ORDER_SHADOW_ONLY" }); }
    return false;
  }
  await enterFromPriceTrigger(pending, feature, "BREAKOUT_BULL_CONTINUATION_CONFIRMED");
  return true;
}

function breakoutShallowHoldRecoveryOk(feature) {
  const ema8 = finite(feature.ema8, null);
  const slope = finite(feature.slope, null);
  const fvvo = finite(feature.fvvo, null);
  const adx = finite(feature.adx, null);
  if (CFG.BREAKOUT_SHALLOW_HOLD_REQUIRE_ABOVE_EMA8 && (ema8 === null || feature.price < ema8)) return false;
  if (slope === null || slope < CFG.BREAKOUT_SHALLOW_HOLD_MIN_SLOPE) return false;
  if (fvvo === null || fvvo < CFG.BREAKOUT_SHALLOW_HOLD_MIN_FVVO) return false;
  if (adx === null || adx < CFG.BREAKOUT_SHALLOW_HOLD_MIN_ADX) return false;
  if (CFG.BREAKOUT_SHALLOW_HOLD_REQUIRE_RAY_NOT_BEAR && !nonBearRay(feature.rayRegime)) return false;
  return true;
}

async function evaluateBreakoutShallowHoldReclaim(pending, feature, rangeHigh, breakoutConfirmPrice) {
  if (breakoutShallowHoldReclaimMode() === "disabled") return false;
  const t = pending.trailing || (pending.trailing = {});
  const current = nowMs();
  const breakoutAtMs = finite(t.breakoutAtMs, 0);
  if (!(breakoutAtMs > 0) || current - breakoutAtMs > CFG.BREAKOUT_SHALLOW_HOLD_MAX_TRACK_SEC * 1000) return false;
  if (!(feature.price > rangeHigh + 1e-9)) return false;
  const highest = Math.max(finite(t.highestBreakoutPrice, feature.price), feature.price);
  const ceiling = breakoutConfirmPrice * (1 + CFG.BREAKOUT_SHALLOW_HOLD_MAX_ABOVE_CONFIRM_PCT / 100);
  const pullbackFromHighPct = highest > 0 ? percentageBelow(highest, feature.price) : 0;
  const inBand = feature.price <= ceiling + 1e-9 && pullbackFromHighPct + 1e-9 >= CFG.BREAKOUT_SHALLOW_HOLD_MIN_PULLBACK_FROM_HIGH_PCT;
  if (inBand) {
    const priorLow = finite(t.shallowHoldLowPrice, null);
    if (priorLow === null || feature.price < priorLow - 1e-9) {
      t.shallowHoldLowPrice = round(feature.price, 8);
      t.shallowHoldLowAt = feature.receivedAt || nowIso();
      t.shallowHoldLowAtMs = feature.receivedAtMs || current;
      t.shallowHoldObservations = 1;
      t.shallowHoldLastChaseLowPrice = null;
      t.shallowHoldShadowCandidateLowPrice = null;
      log("INFO", "FVVO_BREAKOUT_SHALLOW_HOLD_LOW_UPDATED", { triggerId: pending.id, breakoutConfirmPrice, retestRangeHigh: rangeHigh, highestBreakoutPrice: highest, shallowHoldLowPrice: t.shallowHoldLowPrice, pullbackFromHighPct: round(pullbackFromHighPct, 6), holdCeilingPrice: round(ceiling, 8) });
    } else {
      t.shallowHoldObservations = Math.floor(finite(t.shallowHoldObservations, 0)) + 1;
    }
  }
  const low = finite(t.shallowHoldLowPrice, null);
  const observations = Math.floor(finite(t.shallowHoldObservations, 0));
  if (low === null || observations < CFG.BREAKOUT_SHALLOW_HOLD_MIN_OBSERVATIONS) return false;
  const reclaimTarget = Math.max(breakoutConfirmPrice, low * (1 + CFG.BREAKOUT_SHALLOW_HOLD_RECLAIM_PCT / 100));
  const maxEntryPrice = breakoutConfirmPrice * (1 + CFG.BREAKOUT_SHALLOW_HOLD_MAX_ENTRY_ABOVE_CONFIRM_PCT / 100);
  t.shallowHoldReclaimTargetPrice = round(reclaimTarget, 8);
  t.shallowHoldMaxEntryPrice = round(maxEntryPrice, 8);
  t.shallowHoldPullbackFromHighPct = round(highest > 0 ? percentageBelow(highest, low) : 0, 6);
  if (feature.price + 1e-9 < reclaimTarget) return false;
  if (feature.price > maxEntryPrice + 1e-9) {
    if (finite(t.shallowHoldLastChaseLowPrice, null) !== low) {
      t.shallowHoldLastChaseLowPrice = low;
      log("INFO", "FVVO_BREAKOUT_SHALLOW_HOLD_RECLAIM_CHASE_SKIPPED", { triggerId: pending.id, breakoutConfirmPrice, retestRangeHigh: rangeHigh, shallowHoldLowPrice: low, reclaimTargetPrice: round(reclaimTarget, 8), maxEntryPrice: round(maxEntryPrice, 8), executionPrice: feature.price, action: "KEEP_NORMAL_RETEST_ALIVE" });
    }
    return false;
  }
  if (!breakoutShallowHoldRecoveryOk(feature)) {
    log("INFO", "FVVO_BREAKOUT_SHALLOW_HOLD_WAIT_RECOVERY", { triggerId: pending.id, breakoutConfirmPrice, retestRangeHigh: rangeHigh, shallowHoldLowPrice: low, observations, reclaimTargetPrice: round(reclaimTarget, 8), executionPrice: feature.price, ema8: feature.ema8, adx: feature.adx, fvvo: feature.fvvo, slope: feature.slope, rayRegime: feature.rayRegime, minAdx: CFG.BREAKOUT_SHALLOW_HOLD_MIN_ADX, minFvvo: CFG.BREAKOUT_SHALLOW_HOLD_MIN_FVVO, minSlope: CFG.BREAKOUT_SHALLOW_HOLD_MIN_SLOPE });
    return false;
  }
  const checked = validateStoredPriceTriggerAtExecution(pending, feature.price);
  if (!checked.ok) return false;
  if (breakoutShallowHoldReclaimMode() === "shadow") {
    if (finite(t.shallowHoldShadowCandidateLowPrice, null) !== low) {
      t.shallowHoldShadowCandidateLowPrice = low;
      log("INFO", "FVVO_BREAKOUT_SHALLOW_HOLD_RECLAIM_SHADOW_CANDIDATE", { triggerId: pending.id, breakoutConfirmPrice, retestRangeLow: pending.retestRangeLow, retestRangeHigh: rangeHigh, highestBreakoutPrice: highest, shallowHoldLowPrice: low, observations, pullbackFromHighPct: t.shallowHoldPullbackFromHighPct, reclaimTargetPrice: round(reclaimTarget, 8), maxEntryPrice: round(maxEntryPrice, 8), candidateEntryPrice: feature.price, stopPrice: pending.stopPrice, stopDistancePct: checked.levels.stopPct, automaticOrderSent: false });
    }
    return false;
  }
  log("INFO", "FVVO_BREAKOUT_SHALLOW_HOLD_RECLAIM_CONFIRMED", { triggerId: pending.id, breakoutConfirmPrice, retestRangeLow: pending.retestRangeLow, retestRangeHigh: rangeHigh, highestBreakoutPrice: highest, shallowHoldLowPrice: low, observations, pullbackFromHighPct: t.shallowHoldPullbackFromHighPct, reclaimTargetPrice: round(reclaimTarget, 8), maxEntryPrice: round(maxEntryPrice, 8), candidateEntryPrice: feature.price, stopPrice: pending.stopPrice, adx: feature.adx, fvvo: feature.fvvo, slope: feature.slope, rayRegime: feature.rayRegime });
  await enterFromPriceTrigger(pending, feature, "BREAKOUT_SHALLOW_HOLD_RECLAIM_CONFIRMED");
  return true;
}


function cleanEntryCampaign(value) {
  const campaign = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(campaign) ? campaign : "";
}

function cleanEntryRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return ["breakout", "preferred", "deep_alternative"].includes(role) ? role : "";
}

function validateCampaignArm(body, validated, active) {
  const campaignRaw = body.entry_campaign ?? body.entryCampaign ?? body.trigger_group ?? body.triggerGroup;
  const roleRaw = body.entry_role ?? body.entryRole ?? body.zone_role ?? body.zoneRole;
  const campaignProvided = campaignRaw !== undefined && campaignRaw !== null && String(campaignRaw).trim() !== "";
  const roleProvided = roleRaw !== undefined && roleRaw !== null && String(roleRaw).trim() !== "";

  // Legacy Swing behaviour remains unchanged when campaign fields are absent:
  // at most one dip-kind and one breakout-kind setup may coexist.
  if (!campaignProvided && !roleProvided) {
    const requestedKind = priceEntryKind(validated.triggerMode);
    if (active.some((item) => item.entryCampaign)) return { ok: false, error: "CAMPAIGN_AND_LEGACY_STANDALONE_SETUPS_CANNOT_BE_MIXED" };
    if (active.some((item) => priceEntryKind(item) === requestedKind)) return { ok: false, error: `PENDING_${priceEntryKindLabel(requestedKind)}_PRICE_ENTRY_ACTIVE` };
    return { ok: true, entryCampaign: null, entryRole: "standalone", campaignOrdinal: 0 };
  }

  const entryCampaign = cleanEntryCampaign(campaignRaw);
  const entryRole = cleanEntryRole(roleRaw);
  if (!entryCampaign) return { ok: false, error: "VALID_ENTRY_CAMPAIGN_REQUIRED" };
  if (!entryRole) return { ok: false, error: "ENTRY_ROLE_MUST_BE_BREAKOUT_PREFERRED_OR_DEEP_ALTERNATIVE" };
  if (active.some((item) => !item.entryCampaign || item.entryCampaign !== entryCampaign)) return { ok: false, error: "ALL_PENDING_SETUPS_MUST_SHARE_ENTRY_CAMPAIGN" };
  if (active.some((item) => item.entryRole === entryRole)) return { ok: false, error: `DUPLICATE_ENTRY_ROLE_${entryRole.toUpperCase()}` };

  // Campaign orchestration is copied from Daily v1g, while Swing trigger logic is retained.
  if (entryRole === "breakout" && validated.triggerMode !== "breakout_retest_reclaim_zone") return { ok: false, error: "SWING_BREAKOUT_ROLE_REQUIRES_BREAKOUT_RETEST_RECLAIM_ZONE" };
  if (["preferred", "deep_alternative"].includes(entryRole) && !["trailing_dip_reclaim_zone", "confirmed_pullback_reclaim_zone", "hybrid_pullback_reclaim_zone"].includes(validated.triggerMode)) return { ok: false, error: "PREFERRED_AND_DEEP_ROLES_REQUIRE_TRAILING_CONFIRMED_OR_HYBRID_PULLBACK_RECLAIM_ZONE" };

  // Preferred/deep ordering applies ONLY when arming one of the two dip roles.
  // Breakout has no activationRangeLow/High and must never be evaluated by this check.
  if (["preferred", "deep_alternative"].includes(entryRole)) {
    const counterpartRole = entryRole === "preferred" ? "deep_alternative" : "preferred";
    const otherDip = active.find((item) => item.entryRole === counterpartRole);
    if (otherDip) {
      const newLow = Number(validated.activationRangeLow);
      const newHigh = Number(validated.activationRangeHigh);
      const oldLow = Number(otherDip.activationRangeLow);
      const oldHigh = Number(otherDip.activationRangeHigh);
      if (![newLow, newHigh, oldLow, oldHigh].every(Number.isFinite)) {
        return { ok: false, error: "CAMPAIGN_DIP_ZONE_RANGE_REQUIRED" };
      }
      const preferredLow = entryRole === "preferred" ? newLow : oldLow;
      const deepHigh = entryRole === "preferred" ? oldHigh : newHigh;
      if (!(preferredLow > deepHigh)) return { ok: false, error: "PREFERRED_ZONE_MUST_BE_COMPLETELY_ABOVE_DEEP_ALTERNATIVE_ZONE" };
    }
  }

  const campaignOrdinal = Math.max(0, ...active.filter((item) => item.entryCampaign === entryCampaign).map((item) => Math.floor(finite(item.campaignOrdinal, 0)))) + 1;
  return { ok: true, entryCampaign, entryRole, campaignOrdinal };
}

function closeCampaignBreakoutPostExpiryShadows(entryCampaign, winningRole, winningTriggerId) {
  if (!entryCampaign || !state.audit || !Array.isArray(state.audit.breakoutPostExpiryShadows)) return [];
  const closed = [];
  for (const sh of state.audit.breakoutPostExpiryShadows) {
    if (!sh || sh.status === "DONE" || sh.entryCampaign !== entryCampaign) continue;
    sh.status = "DONE";
    sh.resolutionReason = "CAMPAIGN_RESOLVED_BY_SIBLING_ENTRY";
    sh.campaignResolvedByRole = winningRole || null;
    sh.campaignResolvedByTriggerId = winningTriggerId || null;
    sh.resolvedAt = nowIso();
    sh.resolvedAtMs = nowMs();
    closed.push(sh);
  }
  return closed;
}

async function armPriceEntry(body) {
  const issue = configProblems()[0];
  if (issue) return { status: 503, body: { ok: false, error: issue } };
  if (!CFG.PRICE_ENTRY_ENABLED || !CFG.MANUAL_ALLOW_ARM_PRICE_ENTRY) return { status: 403, body: { ok: false, error: "PRICE_TRIGGER_ENTRY_DISABLED" } };
  if (String(body.profile || CFG.MANUAL_ENTRY_DEFAULT_PROFILE).trim().toUpperCase() !== PROFILE) return { status: 400, body: { ok: false, error: "ONLY_SWING_BALANCED_STRUCTURE_EXIT_PROFILE_ALLOWED" } };
  const pe = ensurePriceEntryState();
  const active = activePriceEntryItems();
  const block = stateBlocksNewEntry();
  if (block) return { status: 409, body: { ok: false, error: block, status: statusPayload() } };
  if (CFG.MANUAL_REQUIRE_FRESH_FEATURE_TICK && !isFeatureFresh()) return { status: 409, body: { ok: false, error: "FRESH_FEATURE_TICK_REQUIRED", featureAgeSec: ageSec(state.lastFeature) } };
  const armPrice = finite(state.lastFeature?.price, null);
  const validated = validatePriceTriggerCommand(body, armPrice);
  if (!validated.ok) return { status: 400, body: { ok: false, error: validated.error } };

  const campaign = validateCampaignArm(body, validated, active);
  if (!campaign.ok) return { status: 409, body: { ok: false, error: campaign.error, priceTriggerEntry: priceEntryStatusPayload() } };
  if (active.length >= CFG.PRICE_ENTRY_MAX_PENDING) return { status: 409, body: { ok: false, error: "MAX_PENDING_PRICE_ENTRIES_ACTIVE", priceTriggerEntry: priceEntryStatusPayload() } };

  if (state.reentry?.campaign) {
    log("INFO", "FVVO_REENTRY_CAMPAIGN_CANCELLED_BY_PRICE_TRIGGER_ARM", { campaignId: state.reentry.campaign.id, observedCandidates: state.reentry.campaign.observedCandidates || 0 });
    state.reentry = { campaign: null, recentTickPrices: [] };
  }
  const current = nowMs();
  const expiresAtMs = current + validated.expirySec * 1000;
  const isTrailing = validated.triggerMode === "trailing_dip_reclaim" || validated.triggerMode === "trailing_dip_reclaim_zone" || validated.triggerMode === "confirmed_pullback_reclaim_zone" || validated.triggerMode === "hybrid_pullback_reclaim_zone";
  const pending = {
    id: crypto.randomUUID(), status: "ARMED", profile: PROFILE,
    entryCampaign: campaign.entryCampaign, entryRole: campaign.entryRole, campaignOrdinal: campaign.campaignOrdinal,
    triggerMode: validated.triggerMode, triggerPrice: validated.triggerPrice, activationPrice: validated.activationPrice, activationRangeLow: validated.activationRangeLow || null, activationRangeHigh: validated.activationRangeHigh || null,
    breakoutConfirmPrice: validated.breakoutConfirmPrice || null, retestRangeLow: validated.retestRangeLow || null, retestRangeHigh: validated.retestRangeHigh || null,
    armedReferencePrice: validated.armPrice, triggerDistancePct: validated.triggerDistancePct,
    stopPrice: validated.levels.stopPrice, stopPctAtTrigger: validated.levels.stopPct,
    profitTargetPrice: validated.levels.profitTargetPrice, profitTargetPctAtTrigger: validated.levels.profitTargetPct,
    intelligentTp: validated.levels.intelligentTp ? clone(validated.levels.intelligentTp) : null,
    armedAt: nowIso(), armedAtMs: current, expiresAt: new Date(expiresAtMs).toISOString(), expiresAtMs,
    lastObservedPrice: validated.armPrice, lastObservedAt: nowIso(), lastObservedAtMs: current,
    reason: String(body.reason || "manual_price_trigger_entry"),
    trailing: isTrailing ? { phase: "ARMED", activatedAt: null, activatedAtMs: 0, observedLowPrice: null, observedLowAt: null, observedLowAtMs: 0, observedDropPct: 0, lowStopBufferPct: 0, minDipQualified: false, reclaimTargetPrice: null, maxEntryPrice: null, trackingExpiresAt: null, trackingExpiresAtMs: 0 } : null,
  };
  const pendingSlot = setPriceEntrySlot(pending);
  state.manual = { ...state.manual, lastAction: "arm_price_entry", lastActionAt: nowIso() };
  if (!(await persistState("price_trigger_armed"))) return { status: 503, body: { ok: false, error: "STATE_PERSISTENCE_FAILED_WHILE_ARMING_PRICE_TRIGGER" } };
  log("INFO", "FVVO_PRICE_TRIGGER_ARMED", { triggerId: pending.id, pendingSlot, activePendingCount: activePriceEntryItems().length, entryCampaign: pending.entryCampaign, entryRole: pending.entryRole, campaignOrdinal: pending.campaignOrdinal, triggerMode: pending.triggerMode, triggerPrice: pending.triggerPrice, activationPrice: pending.activationPrice || null, activationRangeLow: pending.activationRangeLow || null, activationRangeHigh: pending.activationRangeHigh || null, breakoutConfirmPrice: pending.breakoutConfirmPrice || null, retestRangeLow: pending.retestRangeLow || null, retestRangeHigh: pending.retestRangeHigh || null, armedReferencePrice: pending.armedReferencePrice, triggerDistancePct: pending.triggerDistancePct, stopPrice: pending.stopPrice, profitTargetPrice: pending.profitTargetPrice || null, expiresAt: pending.expiresAt, marketOrderWillBeSentOnCross: (!isTrailing && pending.triggerMode !== "breakout_retest_reclaim_zone"), trailingDipReclaimMode: isTrailingDipReclaim(pending) ? trailingDipReclaimMode() : null, trailingDipReclaimZoneMode: isTrailingDipReclaimZone(pending) ? trailingDipReclaimZoneMode() : null, breakoutRetestReclaimZoneMode: pending.triggerMode === "breakout_retest_reclaim_zone" ? breakoutRetestReclaimZoneMode() : null });
  if (pending.entryCampaign) {
    log("INFO", "FVVO_CAMPAIGN_ENTRY_SETUP_ARMED", { entryCampaign: pending.entryCampaign, entryRole: pending.entryRole, campaignOrdinal: pending.campaignOrdinal, triggerId: pending.id, pendingSlot, activeCampaignSetups: activePriceEntryItems().filter((item) => item.entryCampaign === pending.entryCampaign).length, triggerMode: pending.triggerMode, expiresAt: pending.expiresAt });
  }
  return { status: 200, body: { ok: true, priceEntryArmed: true, orderTypeOnTrigger: (isTrailing || pending.triggerMode === "breakout_retest_reclaim_zone") ? "market_on_reclaim" : "market", entrySizeSource: CFG.C3_ENTRY_SIZE_SOURCE, entryOrderIncludedInWebhook: false, trigger: priceEntryStatusPayload().pendingList.find((item) => item.id === pending.id) || priceEntryStatusPayload().pending } };
}

async function cancelPriceEntry(body) {
  if (!CFG.MANUAL_ALLOW_CANCEL_PRICE_ENTRY) return { status: 403, body: { ok: false, error: "PRICE_TRIGGER_CANCEL_DISABLED" } };
  const active = activePriceEntryItems();
  if (!active.length) return { status: 409, body: { ok: false, error: "NO_PENDING_PRICE_ENTRY", priceTriggerEntry: priceEntryStatusPayload() } };
  const requestedId = String(body.trigger_id || body.triggerId || body.id || "").trim();
  const requestedMode = validTriggerMode(body.trigger_mode || body.triggerMode);
  const requestedKind = requestedMode ? priceEntryKind(requestedMode) : String(body.trigger_kind || body.triggerKind || "").trim().toLowerCase();
  const requestedCampaign = cleanEntryCampaign(body.entry_campaign ?? body.entryCampaign ?? body.trigger_group ?? body.triggerGroup);
  const requestedRole = cleanEntryRole(body.entry_role ?? body.entryRole ?? body.zone_role ?? body.zoneRole);
  let targets = active;
  if (requestedId) targets = active.filter((item) => item.id === requestedId);
  else if (requestedCampaign && requestedRole) targets = active.filter((item) => item.entryCampaign === requestedCampaign && item.entryRole === requestedRole);
  else if (requestedCampaign) targets = active.filter((item) => item.entryCampaign === requestedCampaign);
  else if (requestedRole) targets = active.filter((item) => item.entryRole === requestedRole);
  else if (["dip", "breakout"].includes(requestedKind)) targets = active.filter((item) => priceEntryKind(item) === requestedKind);
  if (!targets.length) return { status: 404, body: { ok: false, error: "MATCHING_PENDING_PRICE_ENTRY_NOT_FOUND", priceTriggerEntry: priceEntryStatusPayload() } };
  const cancelled = [];
  for (const item of targets) {
    const resolved = resolvePriceEntryPending("CANCELLED", "MANUAL_CANCEL", { cancelReason: String(body.reason || "manual_cancel_price_entry") }, item);
    if (resolved) cancelled.push(resolved);
  }
  state.manual = { ...state.manual, lastAction: "cancel_price_entry", lastActionAt: nowIso() };
  await persistState("price_trigger_cancelled");
  for (const item of cancelled) {
    log("INFO", "FVVO_PRICE_TRIGGER_CANCELLED", { triggerId: item.id, entryCampaign: item.entryCampaign || null, entryRole: item.entryRole || "standalone", triggerMode: item.triggerMode, triggerPrice: item.triggerPrice, reason: item.cancelReason });
    if (item.entryCampaign) log("WARN", "FVVO_CAMPAIGN_ENTRY_SETUP_CANCELLED", { entryCampaign: item.entryCampaign, entryRole: item.entryRole, triggerId: item.id, reason: item.cancelReason });
  }
  return { status: 200, body: { ok: true, priceEntryCancelled: true, cancelledCount: cancelled.length, cancelled: cancelled.map((item) => ({ id: item.id, entryCampaign: item.entryCampaign || null, entryRole: item.entryRole || "standalone", triggerMode: item.triggerMode, triggerKind: priceEntryKind(item), triggerPrice: item.triggerPrice })), priceTriggerEntry: priceEntryStatusPayload() } };
}


async function enterFromPriceTrigger(pending, feature, modeReason) {
  const pe = ensurePriceEntryState();
  const current = nowMs();
  const checked = validateStoredPriceTriggerAtExecution(pending, feature.price);
  if (!checked.ok) {
    const cancelled = resolvePriceEntryPending("CANCELLED", checked.error, { triggeredPrice: round(feature.price, 8), triggeredAt: nowIso(), triggeredAtMs: current }, pending);
    await persistState("price_trigger_gap_level_rejected");
    log("WARN", "FVVO_PRICE_TRIGGER_CANCELLED", { triggerId: cancelled.id, entryCampaign: cancelled.entryCampaign || null, entryRole: cancelled.entryRole || "standalone", triggerMode: cancelled.triggerMode, triggerPrice: cancelled.triggerPrice, executionPrice: feature.price, reason: checked.error });
    if (cancelled.entryCampaign) log("WARN", "FVVO_CAMPAIGN_ENTRY_SETUP_CANCELLED", { entryCampaign: cancelled.entryCampaign, entryRole: cancelled.entryRole, triggerId: cancelled.id, reason: checked.error });
    return;
  }

  // Select and persist one winner before any HTTP forward. All other armed alternatives are
  // resolved locally first, preserving the one-symbol/one-deal contract even on same-tick races.
  const consumed = resolvePriceEntryPending("TRIGGERED_FORWARDING", modeReason, { triggeredPrice: round(feature.price, 8), triggeredAt: nowIso(), triggeredAtMs: current, sourceEvent: feature.kind }, pending);
  if (!consumed) return;
  if (["preferred", "deep"].includes(String(consumed.entryRole || "").toLowerCase())) {
    const tick = feature || state.lastFeature || {};
    const five = state.lastFeature5m || {};
    const price = finite(tick.price, null), ema8 = finite(tick.ema8, null), ema18 = finite(tick.ema18, finite(tick.pink, null));
    const belowBoth = price !== null && ema8 !== null && ema18 !== null && price < ema8 && price < ema18;
    const weakSlope = finite(tick.slope, null) !== null && tick.slope < 0.10;
    const freshFive = finite(five.receivedAtMs, null) !== null && current - five.receivedAtMs <= CFG.ENTRY_5M_BEAR_GUARD_MAX_AGE_SEC * 1000;
    const negativeFive = freshFive && finite(five.fvvo, null) !== null && five.fvvo <= -1;
    const wouldDelay = (belowBoth && weakSlope) || negativeFive;
    log("INFO", "FVVO_ENTRY_ALIGNMENT_SHADOW_AUDIT", { entryCampaign: consumed.entryCampaign || null, entryRole: consumed.entryRole, triggerId: consumed.id, executionReferencePrice: price, tickEma8: ema8, tickEma18: ema18, tickSlope: finite(tick.slope, null), fiveMinuteFvvo: finite(five.fvvo, null), fiveMinuteFresh: freshFive, belowTickEma8AndEma18: belowBoth, negativeFiveMinuteFvvo: negativeFive, wouldDelayUnderCandidate: wouldDelay, candidateRequirement: negativeFive ? "STRONGER_TICK_CONFIRMATION" : (belowBoth && weakSlope ? "EMA8_RECLAIM_OR_TWO_POSITIVE_SLOPE_OBSERVATIONS" : "ENTER_WITHOUT_DELAY"), action: "AUDIT_ONLY_NO_ENTRY_CHANGE" });
  }
  const dormantDeep = captureDormantDeepFallback(consumed);
  const siblingCancelled = cancelOtherPriceEntries(consumed.id, "SIBLING_PRICE_TRIGGER_FIRED", { stateBlock: "ENTRY_TRIGGERED_BY_OTHER_SETUP" });
  if (dormantDeep) {
    pe.dormantDeepFallback = dormantDeep;
    log("INFO", "FVVO_DEEP_FALLBACK_STORED_DORMANT", { triggerId: dormantDeep.id, entryCampaign: dormantDeep.entryCampaign, preferredTriggerId: consumed.id, expiresAt: dormantDeep.originalExpiresAt || dormantDeep.expiresAt });
  }
  const closedCampaignShadows = closeCampaignBreakoutPostExpiryShadows(consumed.entryCampaign, consumed.entryRole, consumed.id);

  for (const item of siblingCancelled) {
    log("WARN", "FVVO_SIBLING_TRIGGER_AUTO_CANCELLED_AFTER_ENTRY", { entryCampaign: consumed.entryCampaign || null, winningEntryRole: consumed.entryRole || "standalone", cancelledTriggerId: item.id, cancelledEntryCampaign: item.entryCampaign || null, cancelledEntryRole: item.entryRole || "standalone", cancelledTriggerMode: item.triggerMode, cancelledTriggerPrice: item.triggerPrice, reason: item.resolutionReason, firedTriggerId: consumed.id, firedTriggerMode: consumed.triggerMode, firedTriggerPrice: consumed.triggerPrice });
    if (consumed.entryCampaign) log("WARN", "FVVO_CAMPAIGN_SIBLING_CANCELLED", { entryCampaign: consumed.entryCampaign, winningEntryRole: consumed.entryRole, winningTriggerId: consumed.id, cancelledEntryRole: item.entryRole || "standalone", cancelledTriggerId: item.id, reason: item.resolutionReason });
  }
  for (const sh of closedCampaignShadows) {
    log("INFO", "FVVO_CAMPAIGN_POST_EXPIRY_SHADOW_CLOSED", { entryCampaign: consumed.entryCampaign, winningEntryRole: consumed.entryRole, winningTriggerId: consumed.id, shadowId: sh.id, sourceTriggerId: sh.sourceTriggerId, sourceEntryRole: sh.entryRole || null, reason: sh.resolutionReason, automaticOrderSent: false });
  }

  if (state.reentry?.campaign) state.reentry = { campaign: null, recentTickPrices: [] };
  state.position = buildPosition(feature.price, checked.levels, { entryOrigin: "PRICE_TRIGGER", profile: PROFILE });
  state.position.priceTrigger = { id: consumed.id, mode: consumed.triggerMode, entryCampaign: consumed.entryCampaign || null, entryRole: consumed.entryRole || "standalone", campaignOrdinal: Math.max(0, Math.floor(finite(consumed.campaignOrdinal, 0))), price: consumed.triggerPrice, activationPrice: consumed.activationPrice || null, activationRangeLow: consumed.activationRangeLow || null, activationRangeHigh: consumed.activationRangeHigh || null, breakoutConfirmPrice: consumed.breakoutConfirmPrice || null, retestRangeLow: consumed.retestRangeLow || null, retestRangeHigh: consumed.retestRangeHigh || null, armedReferencePrice: consumed.armedReferencePrice, triggeredAt: consumed.triggeredAt };
  state.externalDealLock = { active: true, source: "price_trigger_entry", setAt: nowIso(), reason: "PRICE_TRIGGER_ENTRY_PENDING_FORWARD" };
  state.manual = { ...state.manual, handoffActive: false, recoveryRequired: false, recoveryReason: "", lastAction: "price_trigger_fired", lastActionAt: nowIso() };
  // Improvement over Daily v1g: keep `last` bound to the winner, not the last cancelled sibling.
  pe.last = { ...consumed };
  await persistState("price_trigger_pre_forward");

  if (consumed.entryCampaign) {
    log("INFO", "FVVO_CAMPAIGN_WINNER_SELECTED", { entryCampaign: consumed.entryCampaign, winningEntryRole: consumed.entryRole, winningTriggerId: consumed.id, winningTriggerMode: consumed.triggerMode, siblingCancelledCount: siblingCancelled.length, campaignPostExpiryShadowsClosed: closedCampaignShadows.length, executionReferencePrice: feature.price, action: "ONE_WINNER_PRE_FORWARD_PERSISTED" });
  }
  log("INFO", "FVVO_PRICE_TRIGGER_FIRED", { triggerId: consumed.id, entryCampaign: consumed.entryCampaign || null, entryRole: consumed.entryRole || "standalone", campaignOrdinal: consumed.campaignOrdinal || 0, cancelledSiblingCount: siblingCancelled.length, triggerMode: consumed.triggerMode, triggerPrice: consumed.triggerPrice, activationPrice: consumed.activationPrice || null, activationRangeLow: consumed.activationRangeLow || null, activationRangeHigh: consumed.activationRangeHigh || null, breakoutConfirmPrice: consumed.breakoutConfirmPrice || null, retestRangeLow: consumed.retestRangeLow || null, retestRangeHigh: consumed.retestRangeHigh || null, previousPrice: consumed.lastObservedPrice, executionReferencePrice: feature.price, stopPrice: checked.levels.stopPrice, profitTargetPrice: checked.levels.profitTargetPrice || null, marketOrderWillBeSent: true });

  const result = await forward3Commas("enter_long", feature.price, modeReason === "CONFIRMED_PULLBACK_RECLAIM_CONFIRMED" ? "PRICE_TRIGGER_CONFIRMED_PULLBACK_RECLAIM" : (modeReason === "HYBRID_PULLBACK_FAST_CONFIRMED" ? "PRICE_TRIGGER_HYBRID_PULLBACK_FAST" : (modeReason === "HYBRID_PULLBACK_5M_FALLBACK_CONFIRMED" ? "PRICE_TRIGGER_HYBRID_PULLBACK_5M_FALLBACK" : (modeReason === "TRAILING_DIP_RECLAIM_CONFIRMED" ? "PRICE_TRIGGER_TRAILING_DIP_RECLAIM" : (modeReason === "TRAILING_DIP_RECLAIM_ZONE_CONFIRMED" ? "PRICE_TRIGGER_TRAILING_DIP_RECLAIM_ZONE" : (modeReason === "BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRMED" ? "PRICE_TRIGGER_BREAKOUT_RETEST_RECLAIM_ZONE" : (modeReason === "BREAKOUT_SHALLOW_HOLD_RECLAIM_CONFIRMED" ? "PRICE_TRIGGER_BREAKOUT_SHALLOW_HOLD_RECLAIM" : (modeReason === "BREAKOUT_BULL_CONTINUATION_CONFIRMED" ? "PRICE_TRIGGER_BREAKOUT_BULL_CONTINUATION" : `PRICE_TRIGGER_${String(consumed.triggerMode || "").toUpperCase()}_CROSS`))))))), { dedupeKey: `price_trigger_enter_${consumed.id}`, stopPct: checked.levels.stopPct });
  if (!result.ok) {
    state.position.lifecycle = "ENTRY_UNKNOWN_AFTER_FORWARD_ERROR";
    state.manual.recoveryRequired = true;
    state.manual.recoveryReason = `PRICE_TRIGGER_ENTRY_FORWARD_UNCERTAIN_${result.error}`;
    state.externalDealLock.reason = "PRICE_TRIGGER_ENTRY_FORWARD_UNCERTAIN";
    pe.last = { ...consumed, status: "FORWARD_UNCERTAIN", requestId: result.requestId || null, resolutionReason: result.error };
    await persistState("price_trigger_forward_uncertain");
    log("ERROR", "FVVO_PRICE_TRIGGER_FORWARD_UNCERTAIN", { triggerId: consumed.id, entryCampaign: consumed.entryCampaign || null, entryRole: consumed.entryRole || "standalone", requestId: result.requestId, error: result.error });
    return;
  }
  state.position.lifecycle = "ENTRY_ACCEPTED_UNVERIFIED_FILL";
  state.position.entryAcceptedAt = nowIso();
  state.position.entryAcceptedAtMs = nowMs();
  state.position.entryForwardRequestId = result.requestId;
  state.externalDealLock.reason = "PRICE_TRIGGER_ENTRY_ACCEPTED_UNVERIFIED_FILL";
  pe.last = { ...consumed, status: "FORWARDED_UNVERIFIED", requestId: result.requestId, acceptedAt: nowIso(), acceptedAtMs: nowMs() };
  await persistState("price_trigger_forward_accepted");
  log("INFO", "FVVO_PRICE_TRIGGER_ENTRY_TRACKED", { triggerId: consumed.id, entryCampaign: consumed.entryCampaign || null, entryRole: consumed.entryRole || "standalone", triggerMode: consumed.triggerMode, triggerPrice: consumed.triggerPrice, activationPrice: consumed.activationPrice || null, activationRangeLow: consumed.activationRangeLow || null, activationRangeHigh: consumed.activationRangeHigh || null, entryPriceReference: feature.price, stopPrice: checked.levels.stopPrice, stopDistancePct: checked.levels.stopPct, profitTargetPrice: checked.levels.profitTargetPrice || null, requestId: result.requestId, entrySizeSource: CFG.C3_ENTRY_SIZE_SOURCE, entryOrderIncludedInWebhook: false, fillVerified: false });
}

async function evaluateTrailingDipReclaim(pending, previousPrice, feature) {
  const current = nowMs();
  const t = pending.trailing || (pending.trailing = {});
  const activation = finite(pending.activationPrice, pending.triggerPrice);
  if (!t.phase) t.phase = "ARMED";

  // `ARMED` / `WATCHING_DIP` can repeat until the full command expiry. A shallow first touch that
  // returns above activation is reset rather than consuming the user's three-hour order. The short
  // tracking timeout begins only after a meaningful dip has actually formed.
  if (t.phase === "ARMED") {
    const crossed = CFG.PRICE_ENTRY_REQUIRE_ACTUAL_CROSS ? priceTriggerCrossed(pending, previousPrice, feature.price) : feature.price <= activation;
    if (!crossed) return;
    Object.assign(t, { phase: "WATCHING_DIP", activatedAt: nowIso(), activatedAtMs: current, observedLowPrice: round(feature.price, 8), observedLowAt: feature.receivedAt, observedLowAtMs: feature.receivedAtMs, observedDropPct: 0, lowStopBufferPct: 0, minDipQualified: false, reclaimTargetPrice: null, maxEntryPrice: null, trackingExpiresAt: null, trackingExpiresAtMs: 0 });
    log("INFO", "FVVO_TRAILING_DIP_RECLAIM_ACTIVATED", { triggerId: pending.id, activationPrice: activation, activationCrossPrice: feature.price, stopPrice: pending.stopPrice, mode: trailingDipReclaimMode() });
  }

  if (t.phase === "WATCHING_DIP" || t.phase === "TRACKING_RECLAIM") {
    if (t.observedLowPrice === null || feature.price < t.observedLowPrice - 1e-9) {
      t.observedLowPrice = round(feature.price, 8);
      t.observedLowAt = feature.receivedAt;
      t.observedLowAtMs = feature.receivedAtMs;
    }
    const low = finite(t.observedLowPrice, feature.price);
    const dropPct = percentageBelow(activation, low);
    const lowStopBufferPct = low > pending.stopPrice ? percentageBelow(low, pending.stopPrice) : 0;
    t.observedDropPct = round(dropPct, 6);
    t.lowStopBufferPct = round(lowStopBufferPct, 6);

    if (low <= pending.stopPrice + 1e-9) {
      const cancelled = resolvePriceEntryPending("CANCELLED", "TRAILING_DIP_RECLAIM_LOW_AT_OR_BELOW_STOP", { trailing: t }, pending);
      await persistState("trailing_dip_reclaim_low_at_stop");
      log("WARN", "FVVO_TRAILING_DIP_RECLAIM_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, activationPrice: activation, observedLowPrice: low, stopPrice: pending.stopPrice, lowStopBufferPct });
      return;
    }
    if (lowStopBufferPct + 1e-9 < CFG.TRAILING_DIP_RECLAIM_MIN_LOW_ABOVE_STOP_PCT) {
      const cancelled = resolvePriceEntryPending("CANCELLED", "TRAILING_DIP_RECLAIM_LOW_TOO_CLOSE_TO_STOP", { trailing: t }, pending);
      await persistState("trailing_dip_reclaim_low_too_close_stop");
      log("WARN", "FVVO_TRAILING_DIP_RECLAIM_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, activationPrice: activation, observedLowPrice: low, stopPrice: pending.stopPrice, lowStopBufferPct, minLowAboveStopPct: CFG.TRAILING_DIP_RECLAIM_MIN_LOW_ABOVE_STOP_PCT });
      return;
    }

    if (t.phase === "WATCHING_DIP") {
      if (dropPct + 1e-9 < CFG.TRAILING_DIP_RECLAIM_MIN_DROP_PCT) {
        // A shallow touch recovered back above activation. Reset so a later genuine dip can be tracked.
        if (feature.price > activation + 1e-9) {
          Object.assign(t, { phase: "ARMED", activatedAt: null, activatedAtMs: 0, observedLowPrice: null, observedLowAt: null, observedLowAtMs: 0, observedDropPct: 0, lowStopBufferPct: 0, minDipQualified: false, reclaimTargetPrice: null, maxEntryPrice: null, trackingExpiresAt: null, trackingExpiresAtMs: 0 });
          await persistState("trailing_dip_reclaim_reset_no_meaningful_dip");
          log("INFO", "FVVO_TRAILING_DIP_RECLAIM_RESET_NO_MEANINGFUL_DIP", { triggerId: pending.id, activationPrice: activation, recoveredPrice: feature.price, minDropPct: CFG.TRAILING_DIP_RECLAIM_MIN_DROP_PCT });
          return;
        }
        await persistState("trailing_dip_reclaim_watch_dip");
        return;
      }
      const trackingExpiresAtMs = Math.min(finite(pending.expiresAtMs, current + CFG.TRAILING_DIP_RECLAIM_MAX_TRACK_SEC * 1000), current + CFG.TRAILING_DIP_RECLAIM_MAX_TRACK_SEC * 1000);
      Object.assign(t, { phase: "TRACKING_RECLAIM", minDipQualified: true, reclaimTargetPrice: round(low * (1 + CFG.TRAILING_DIP_RECLAIM_RECLAIM_PCT / 100), 8), maxEntryPrice: round(low * (1 + CFG.TRAILING_DIP_RECLAIM_MAX_CHASE_PCT / 100), 8), trackingExpiresAtMs, trackingExpiresAt: new Date(trackingExpiresAtMs).toISOString() });
      log("INFO", "FVVO_TRAILING_DIP_RECLAIM_LOW_QUALIFIED", { triggerId: pending.id, activationPrice: activation, observedLowPrice: low, observedDropPct: dropPct, reclaimTargetPrice: t.reclaimTargetPrice, maxEntryPrice: t.maxEntryPrice, trackingExpiresAt: t.trackingExpiresAt });
    }

    if (t.phase !== "TRACKING_RECLAIM") return;
    if (current > finite(t.trackingExpiresAtMs, 0)) {
      const cancelled = resolvePriceEntryPending("CANCELLED", "TRAILING_DIP_RECLAIM_TRACK_TIMEOUT", { trailing: t }, pending);
      await persistState("trailing_dip_reclaim_timeout");
      log("WARN", "FVVO_TRAILING_DIP_RECLAIM_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, activationPrice: activation, observedLowPrice: low, stopPrice: pending.stopPrice });
      return;
    }

    // Recalculate thresholds whenever a new low appears during the qualified dip.
    t.reclaimTargetPrice = round(low * (1 + CFG.TRAILING_DIP_RECLAIM_RECLAIM_PCT / 100), 8);
    t.maxEntryPrice = round(low * (1 + CFG.TRAILING_DIP_RECLAIM_MAX_CHASE_PCT / 100), 8);
    if (feature.price + 1e-9 < t.reclaimTargetPrice) { await persistState("trailing_dip_reclaim_track_low"); return; }
    if (feature.price > t.maxEntryPrice + 1e-9) {
      const cancelled = resolvePriceEntryPending("CANCELLED", "TRAILING_DIP_RECLAIM_RECOVERY_CHASE_TOO_LARGE", { trailing: t, triggeredPrice: round(feature.price, 8), triggeredAt: nowIso(), triggeredAtMs: current }, pending);
      await persistState("trailing_dip_reclaim_chase_cancelled");
      log("WARN", "FVVO_TRAILING_DIP_RECLAIM_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, observedLowPrice: low, reclaimTargetPrice: t.reclaimTargetPrice, maxEntryPrice: t.maxEntryPrice, executionPrice: feature.price });
      return;
    }
    if (!trailingTickRecoveryOk(feature)) {
      await persistState("trailing_dip_reclaim_wait_tick_recovery");
      log("INFO", "FVVO_TRAILING_DIP_RECLAIM_WAIT_TICK_RECOVERY", { triggerId: pending.id, observedLowPrice: low, reclaimTargetPrice: t.reclaimTargetPrice, executionPrice: feature.price, requireTickRecovery: CFG.TRAILING_DIP_RECLAIM_REQUIRE_TICK_RECOVERY });
      return;
    }
    const checked = validateStoredPriceTriggerAtExecution(pending, feature.price);
    if (!checked.ok) {
      const cancelled = resolvePriceEntryPending("CANCELLED", checked.error, { trailing: t, triggeredPrice: round(feature.price, 8), triggeredAt: nowIso(), triggeredAtMs: current }, pending);
      await persistState("trailing_dip_reclaim_execution_levels_invalid");
      log("WARN", "FVVO_TRAILING_DIP_RECLAIM_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, observedLowPrice: low, reclaimTargetPrice: t.reclaimTargetPrice, executionPrice: feature.price, stopPrice: pending.stopPrice });
      return;
    }
    if (trailingDipReclaimMode() === "shadow") {
      const shadow = resolvePriceEntryPending("SHADOW_CANDIDATE", "TRAILING_DIP_RECLAIM_SHADOW_CANDIDATE", { trailing: t, triggeredPrice: round(feature.price, 8), triggeredAt: nowIso(), triggeredAtMs: current }, pending);
      await persistState("trailing_dip_reclaim_shadow_candidate");
      log("INFO", "FVVO_TRAILING_DIP_RECLAIM_SHADOW_CANDIDATE", { triggerId: shadow.id, activationPrice: activation, observedLowPrice: low, observedDropPct: dropPct, reclaimTargetPrice: t.reclaimTargetPrice, maxEntryPrice: t.maxEntryPrice, candidateEntryPrice: feature.price, stopPrice: pending.stopPrice, stopDistancePct: checked.levels.stopPct });
      return;
    }
    await enterFromPriceTrigger(pending, feature, "TRAILING_DIP_RECLAIM_CONFIRMED");
  }
}

let priceEntryEvaluationQueue = Promise.resolve();
async function evaluateTrailingDipReclaimZone(pending, previousPrice, feature) {
  const current = nowMs();
  const t = pending.trailing || (pending.trailing = {});
  const rangeLow = finite(pending.activationRangeLow, null);
  const rangeHigh = finite(pending.activationRangeHigh, finite(pending.activationPrice, pending.triggerPrice));
  if (!(rangeLow > 0) || !(rangeHigh > 0) || rangeLow >= rangeHigh) {
    const cancelled = resolvePriceEntryPending("CANCELLED", "TRAILING_DIP_RECLAIM_ZONE_INVALID_RANGE", { trailing: t, triggeredPrice: round(feature.price, 8), triggeredAt: nowIso(), triggeredAtMs: current }, pending);
    await persistState("trailing_dip_reclaim_zone_invalid_range");
    log("WARN", "FVVO_TRAILING_DIP_RECLAIM_ZONE_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, activationRangeLow: rangeLow, activationRangeHigh: rangeHigh, executionPrice: feature.price });
    return;
  }
  if (!t.phase) t.phase = "ARMED";

  if (t.phase === "ARMED") {
    const crossed = CFG.PRICE_ENTRY_REQUIRE_ACTUAL_CROSS ? priceTriggerCrossed(pending, previousPrice, feature.price) : feature.price <= rangeHigh;
    if (!crossed) return;
    Object.assign(t, { phase: "WATCHING_ZONE_DIP", activatedAt: nowIso(), activatedAtMs: current, observedLowPrice: round(feature.price, 8), observedLowAt: feature.receivedAt, observedLowAtMs: feature.receivedAtMs, observedDropPct: 0, lowStopBufferPct: 0, minDipQualified: false, reclaimTargetPrice: null, maxEntryPrice: null, trackingExpiresAt: null, trackingExpiresAtMs: 0 });
    log("INFO", "FVVO_TRAILING_DIP_RECLAIM_ZONE_ACTIVATED", { triggerId: pending.id, activationRangeLow: rangeLow, activationRangeHigh: rangeHigh, activationCrossPrice: feature.price, stopPrice: pending.stopPrice, mode: trailingDipReclaimZoneMode() });
  }

  if (t.phase === "WATCHING_ZONE_DIP" || t.phase === "TRACKING_ZONE_RECLAIM") {
    const priorLow = finite(t.observedLowPrice, null);
    if (t.observedLowPrice === null || feature.price < t.observedLowPrice - 1e-9) {
      t.observedLowPrice = round(feature.price, 8);
      t.observedLowAt = feature.receivedAt;
      t.observedLowAtMs = feature.receivedAtMs;
      if (priorLow !== null) log("INFO", "FVVO_TRAILING_DIP_RECLAIM_ZONE_LOW_UPDATED", { triggerId: pending.id, activationRangeLow: rangeLow, activationRangeHigh: rangeHigh, priorLowPrice: priorLow, observedLowPrice: t.observedLowPrice, stopPrice: pending.stopPrice });
    }
    const low = finite(t.observedLowPrice, feature.price);
    const penetrationPct = percentageBelow(rangeHigh, low);
    const lowStopBufferPct = low > pending.stopPrice ? percentageBelow(low, pending.stopPrice) : 0;
    t.observedDropPct = round(penetrationPct, 6);
    t.lowStopBufferPct = round(lowStopBufferPct, 6);

    if (low <= pending.stopPrice + 1e-9) {
      const cancelled = resolvePriceEntryPending("CANCELLED", "TRAILING_DIP_RECLAIM_ZONE_LOW_AT_OR_BELOW_STOP", { trailing: t }, pending);
      await persistState("trailing_dip_reclaim_zone_low_at_stop");
      log("WARN", "FVVO_TRAILING_DIP_RECLAIM_ZONE_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, activationRangeLow: rangeLow, activationRangeHigh: rangeHigh, observedLowPrice: low, stopPrice: pending.stopPrice, lowStopBufferPct });
      return;
    }
    if (lowStopBufferPct + 1e-9 < CFG.TRAILING_DIP_RECLAIM_ZONE_MIN_LOW_ABOVE_STOP_PCT) {
      const cancelled = resolvePriceEntryPending("CANCELLED", "TRAILING_DIP_RECLAIM_ZONE_LOW_TOO_CLOSE_TO_STOP", { trailing: t }, pending);
      await persistState("trailing_dip_reclaim_zone_low_too_close_stop");
      log("WARN", "FVVO_TRAILING_DIP_RECLAIM_ZONE_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, activationRangeLow: rangeLow, activationRangeHigh: rangeHigh, observedLowPrice: low, stopPrice: pending.stopPrice, lowStopBufferPct, minLowAboveStopPct: CFG.TRAILING_DIP_RECLAIM_ZONE_MIN_LOW_ABOVE_STOP_PCT });
      return;
    }

    if (t.phase === "WATCHING_ZONE_DIP") {
      if (penetrationPct + 1e-9 < CFG.TRAILING_DIP_RECLAIM_ZONE_MIN_PENETRATION_PCT) {
        if (feature.price > rangeHigh + 1e-9) {
          Object.assign(t, { phase: "ARMED", activatedAt: null, activatedAtMs: 0, observedLowPrice: null, observedLowAt: null, observedLowAtMs: 0, observedDropPct: 0, lowStopBufferPct: 0, minDipQualified: false, reclaimTargetPrice: null, maxEntryPrice: null, trackingExpiresAt: null, trackingExpiresAtMs: 0 });
          await persistState("trailing_dip_reclaim_zone_reset_no_meaningful_penetration");
          log("INFO", "FVVO_TRAILING_DIP_RECLAIM_ZONE_RESET_NO_MEANINGFUL_DIP", { triggerId: pending.id, activationRangeLow: rangeLow, activationRangeHigh: rangeHigh, recoveredPrice: feature.price, minPenetrationPct: CFG.TRAILING_DIP_RECLAIM_ZONE_MIN_PENETRATION_PCT });
          return;
        }
        await persistState("trailing_dip_reclaim_zone_watch_dip");
        return;
      }
      const trackingExpiresAtMs = Math.min(finite(pending.expiresAtMs, current + CFG.TRAILING_DIP_RECLAIM_ZONE_MAX_TRACK_SEC * 1000), current + CFG.TRAILING_DIP_RECLAIM_ZONE_MAX_TRACK_SEC * 1000);
      Object.assign(t, { phase: "TRACKING_ZONE_RECLAIM", minDipQualified: true, reclaimTargetPrice: round(low * (1 + CFG.TRAILING_DIP_RECLAIM_ZONE_RECLAIM_PCT / 100), 8), maxEntryPrice: round(rangeHigh * (1 + CFG.TRAILING_DIP_RECLAIM_ZONE_MAX_ENTRY_ABOVE_HIGH_PCT / 100), 8), trackingExpiresAtMs, trackingExpiresAt: new Date(trackingExpiresAtMs).toISOString() });
      log("INFO", "FVVO_TRAILING_DIP_RECLAIM_ZONE_LOW_QUALIFIED", { triggerId: pending.id, activationRangeLow: rangeLow, activationRangeHigh: rangeHigh, observedLowPrice: low, penetrationPct, reclaimTargetPrice: t.reclaimTargetPrice, maxEntryPrice: t.maxEntryPrice, stopPrice: pending.stopPrice, trackingExpiresAt: t.trackingExpiresAt });
    }

    if (t.phase !== "TRACKING_ZONE_RECLAIM") return;
    if (current > finite(t.trackingExpiresAtMs, 0)) {
      const cancelled = resolvePriceEntryPending("CANCELLED", "TRAILING_DIP_RECLAIM_ZONE_TRACK_TIMEOUT", { trailing: t }, pending);
      await persistState("trailing_dip_reclaim_zone_timeout");
      log("WARN", "FVVO_TRAILING_DIP_RECLAIM_ZONE_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, activationRangeLow: rangeLow, activationRangeHigh: rangeHigh, observedLowPrice: low, stopPrice: pending.stopPrice });
      return;
    }

    t.reclaimTargetPrice = round(low * (1 + CFG.TRAILING_DIP_RECLAIM_ZONE_RECLAIM_PCT / 100), 8);
    t.maxEntryPrice = round(rangeHigh * (1 + CFG.TRAILING_DIP_RECLAIM_ZONE_MAX_ENTRY_ABOVE_HIGH_PCT / 100), 8);
    if (feature.price + 1e-9 < t.reclaimTargetPrice) { await persistState("trailing_dip_reclaim_zone_track_low"); return; }
    if (feature.price > t.maxEntryPrice + 1e-9) {
      const cancelled = resolvePriceEntryPending("CANCELLED", "TRAILING_DIP_RECLAIM_ZONE_RECOVERY_CHASE_TOO_LARGE", { trailing: t, triggeredPrice: round(feature.price, 8), triggeredAt: nowIso(), triggeredAtMs: current }, pending);
      await persistState("trailing_dip_reclaim_zone_chase_cancelled");
      log("WARN", "FVVO_TRAILING_DIP_RECLAIM_ZONE_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, activationRangeLow: rangeLow, activationRangeHigh: rangeHigh, observedLowPrice: low, reclaimTargetPrice: t.reclaimTargetPrice, maxEntryPrice: t.maxEntryPrice, executionPrice: feature.price });
      return;
    }
    if (!trailingZoneTickRecoveryOk(feature)) {
      if (t.entry5mBearGuard?.active) { t.entry5mBearGuard.releaseObservations = 0; t.entry5mBearGuard.lastEvidence = { reason: "BASE_TICK_RECOVERY_NOT_READY", price: feature.price, at: nowIso() }; }
      await persistState("trailing_dip_reclaim_zone_wait_tick_recovery");
      log("INFO", "FVVO_TRAILING_DIP_RECLAIM_ZONE_WAIT_TICK_RECOVERY", { triggerId: pending.id, activationRangeLow: rangeLow, activationRangeHigh: rangeHigh, observedLowPrice: low, reclaimTargetPrice: t.reclaimTargetPrice, executionPrice: feature.price, requireTickRecovery: CFG.TRAILING_DIP_RECLAIM_ZONE_REQUIRE_TICK_RECOVERY });
      return;
    }

    if (entry5mBearGuardMode() !== "off" && entry5mBearGuardApplies(pending)) {
      const ctx = entry5mStrongBearContext(feature);
      let guard = t.entry5mBearGuard && typeof t.entry5mBearGuard === "object" ? t.entry5mBearGuard : null;
      if (!guard?.active && ctx.strongBear) {
        guard = t.entry5mBearGuard = { active: true, armedAt: nowIso(), armedAtMs: current, role: pending.entryRole || null, referenceEma8: ctx.ema8, referenceEma18: ctx.ema18, referenceBarTimeMs: ctx.barTimeMs || 0, referenceReceivedAt: ctx.receivedAt || null, referenceFvvo: ctx.fvvo, referenceSlope: ctx.slope, referenceRayRegime: ctx.rayRegime, releaseObservations: 0, lastWaitLogAtMs: 0, lastEvidence: { reason: "STRONG_BEAR_5M", context: ctx, price: feature.price, at: nowIso() } };
        await persistState("entry_5m_bear_guard_armed");
        log("WARN", "FVVO_ENTRY_5M_STRONG_BEAR_GUARD_ARMED", { triggerId: pending.id, entryCampaign: pending.entryCampaign || null, entryRole: pending.entryRole || null, executionPrice: feature.price, observedLowPrice: low, reclaimTargetPrice: t.reclaimTargetPrice, maxEntryPrice: t.maxEntryPrice, context5m: ctx, action: entry5mBearGuardMode() === "shadow" ? "SHADOW_ONLY" : "WAIT_FAST_STRUCTURAL_RELEASE" });
        if (entry5mBearGuardMode() === "live") return;
      }
      if (guard?.active && entry5mBearGuardMode() === "live") {
        const evidence = entry5mFastReleaseEvidence(feature, guard);
        guard.lastEvidence = { ...evidence, price: feature.price, at: nowIso() };
        if (evidence.qualifies) guard.releaseObservations = Math.max(0, Math.floor(finite(guard.releaseObservations, 0))) + 1;
        else guard.releaseObservations = 0;
        const required = CFG.ENTRY_5M_BEAR_GUARD_RELEASE_CONFIRM_OBSERVATIONS;
        if (guard.releaseObservations < required) {
          const shouldLog = evidence.qualifies || current - finite(guard.lastWaitLogAtMs, 0) >= CFG.ENTRY_5M_BEAR_GUARD_WAIT_LOG_SEC * 1000;
          if (shouldLog) {
            guard.lastWaitLogAtMs = current;
            log("INFO", evidence.qualifies ? "FVVO_ENTRY_5M_STRONG_BEAR_GUARD_RELEASE_CONFIRMING" : "FVVO_ENTRY_5M_STRONG_BEAR_GUARD_WAIT", { triggerId: pending.id, entryCampaign: pending.entryCampaign || null, entryRole: pending.entryRole || null, executionPrice: feature.price, observations: guard.releaseObservations, requiredObservations: required, referenceKind: evidence.referenceKind, referencePrice: evidence.referencePrice, referenceEma8: evidence.referenceEma8, referenceEma18: evidence.referenceEma18, releaseFloor: evidence.releaseFloor, evidence });
          }
          await persistState("entry_5m_bear_guard_wait");
          return;
        }
        guard.active = false; guard.releasedAt = nowIso(); guard.releasedAtMs = current;
        log("INFO", "FVVO_ENTRY_5M_STRONG_BEAR_GUARD_RELEASED", { triggerId: pending.id, entryCampaign: pending.entryCampaign || null, entryRole: pending.entryRole || null, executionPrice: feature.price, observations: guard.releaseObservations, requiredObservations: required, referenceKind: evidence.referenceKind, referencePrice: evidence.referencePrice, referenceEma8: evidence.referenceEma8, referenceEma18: evidence.referenceEma18, releaseFloor: evidence.releaseFloor, evidence, action: "ALLOW_EXISTING_ENTRY_FLOW" });
      }
    }

    const checked = validateStoredPriceTriggerAtExecution(pending, feature.price);
    if (!checked.ok) {
      const cancelled = resolvePriceEntryPending("CANCELLED", checked.error, { trailing: t, triggeredPrice: round(feature.price, 8), triggeredAt: nowIso(), triggeredAtMs: current }, pending);
      await persistState("trailing_dip_reclaim_zone_execution_levels_invalid");
      log("WARN", "FVVO_TRAILING_DIP_RECLAIM_ZONE_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, activationRangeLow: rangeLow, activationRangeHigh: rangeHigh, observedLowPrice: low, reclaimTargetPrice: t.reclaimTargetPrice, executionPrice: feature.price, stopPrice: pending.stopPrice });
      return;
    }
    if (trailingDipReclaimZoneMode() === "shadow") {
      const shadow = resolvePriceEntryPending("SHADOW_CANDIDATE", "TRAILING_DIP_RECLAIM_ZONE_SHADOW_CANDIDATE", { trailing: t, triggeredPrice: round(feature.price, 8), triggeredAt: nowIso(), triggeredAtMs: current }, pending);
      await persistState("trailing_dip_reclaim_zone_shadow_candidate");
      log("INFO", "FVVO_TRAILING_DIP_RECLAIM_ZONE_SHADOW_CANDIDATE", { triggerId: shadow.id, activationRangeLow: rangeLow, activationRangeHigh: rangeHigh, observedLowPrice: low, penetrationPct, reclaimTargetPrice: t.reclaimTargetPrice, maxEntryPrice: t.maxEntryPrice, candidateEntryPrice: feature.price, stopPrice: pending.stopPrice, stopDistancePct: checked.levels.stopPct });
      return;
    }
    await enterFromPriceTrigger(pending, feature, "TRAILING_DIP_RECLAIM_ZONE_CONFIRMED");
  }
}

function confirmedPullbackAligned15mContext(pending) {
  const ctx = state.lastFeature5m;
  const barTimeMs = finite(ctx?.barTimeMs, 0);
  if (!ctx || !(barTimeMs > 0)) return { available: false, reason: "NO_CONFIRMED_5M_CONTEXT" };
  const minute = new Date(barTimeMs).getUTCMinutes();
  const aligned = minute % 15 === CFG.CONFIRMED_PULLBACK_15M_ALIGNMENT_MINUTE;
  const close = finite(ctx.close, finite(ctx.price, null));
  const fresh = ageSec(ctx) <= CFG.ENTRY_5M_BEAR_GUARD_MAX_AGE_SEC;
  const afterZoneTouch = barTimeMs >= finite(pending?.trailing?.zoneQualifiedAtMs, finite(pending?.trailing?.activatedAtMs, 0));
  return { available: aligned && fresh && afterZoneTouch && close !== null, aligned, fresh, afterZoneTouch, close, barTimeMs, receivedAt: ctx.receivedAt || null, rayRegime: ctx.rayRegime || null, fvvo: finite(ctx.fvvo, null), slope: finite(ctx.slope, null), rsi: finite(ctx.rsi, null), adx: finite(ctx.adx, null) };
}

function confirmedPullbackFastEvidence(feature, confirmPrice) {
  const fvvo = finite(feature.fvvo, null), slope = finite(feature.slope, null);
  const priceOk = feature.price + 1e-9 >= confirmPrice;
  const fvvoOk = fvvo !== null && fvvo >= CFG.CONFIRMED_PULLBACK_FAST_MIN_FVVO;
  const slopeOk = slope !== null && slope >= CFG.CONFIRMED_PULLBACK_FAST_MIN_SLOPE;
  const rayOk = !CFG.CONFIRMED_PULLBACK_FAST_REQUIRE_RAY_NOT_BEAR || nonBearRay(feature.rayRegime);
  return { qualifies: priceOk && fvvoOk && slopeOk && rayOk, priceOk, fvvoOk, slopeOk, rayOk, price: feature.price, fvvo, slope, rayRegime: feature.rayRegime || null };
}

function hybridPullbackVoteRules(pending) {
  const deep = String(pending?.entryRole || "").toLowerCase() === "deep_alternative";
  return deep
    ? { role: "deep_alternative", count: CFG.HYBRID_PULLBACK_DEEP_VOTE_COUNT, required: CFG.HYBRID_PULLBACK_DEEP_VOTES_REQUIRED, finalConsecutive: CFG.HYBRID_PULLBACK_DEEP_FINAL_CONSECUTIVE, minSpanSec: CFG.HYBRID_PULLBACK_DEEP_MIN_SPAN_SEC }
    : { role: "preferred", count: CFG.HYBRID_PULLBACK_PREFERRED_VOTE_COUNT, required: CFG.HYBRID_PULLBACK_PREFERRED_VOTES_REQUIRED, finalConsecutive: CFG.HYBRID_PULLBACK_PREFERRED_FINAL_CONSECUTIVE, minSpanSec: CFG.HYBRID_PULLBACK_PREFERRED_MIN_SPAN_SEC };
}

function hybridPullbackFastEvidence(feature, pending, confirmPrice) {
  const fvvo = finite(feature.fvvo, null), slope = finite(feature.slope, null);
  const low = finite(pending?.trailing?.observedLowPrice, null);
  const lowStopBufferPct = low !== null && low > pending.stopPrice ? percentageBelow(low, pending.stopPrice) : 0;
  const rules = hybridPullbackVoteRules(pending);
  const five = state.lastFeature5m;
  const fiveFresh = Boolean(five) && ageSec(five) <= CFG.ENTRY_5M_BEAR_GUARD_MAX_AGE_SEC;
  const fiveRayOk = !CFG.HYBRID_PULLBACK_DEEP_REQUIRE_5M_RAY_NOT_BEAR || rules.role !== "deep_alternative" || (fiveFresh && nonBearRay(five.rayRegime));
  const evidence = {
    priceAboveConfirm: feature.price + 1e-9 >= confirmPrice,
    fvvoOk: fvvo !== null && fvvo >= CFG.HYBRID_PULLBACK_FAST_MIN_FVVO,
    slopeOk: slope !== null && slope >= CFG.HYBRID_PULLBACK_FAST_MIN_SLOPE,
    rayOk: !CFG.HYBRID_PULLBACK_FAST_REQUIRE_RAY_NOT_BEAR || nonBearRay(feature.rayRegime),
    lowSafelyAboveStop: lowStopBufferPct + 1e-9 >= CFG.HYBRID_PULLBACK_MIN_LOW_ABOVE_STOP_PCT,
    fiveFresh,
    fiveRayOk,
    price: feature.price, fvvo, slope, rayRegime: feature.rayRegime || null,
    lowStopBufferPct: round(lowStopBufferPct, 6), fiveRayRegime: five?.rayRegime || null,
  };
  evidence.qualifies = evidence.priceAboveConfirm && evidence.fvvoOk && evidence.slopeOk && evidence.rayOk && evidence.lowSafelyAboveStop && evidence.fiveFresh && evidence.fiveRayOk;
  evidence.hardReset = (fvvo !== null && fvvo <= CFG.HYBRID_PULLBACK_FAST_STRONG_NEGATIVE_FVVO) || !evidence.rayOk || !evidence.lowSafelyAboveStop;
  return evidence;
}

function hybridPullbackFallback5mContext(pending, confirmPrice) {
  const ctx = state.lastFeature5m;
  if (!CFG.HYBRID_PULLBACK_FALLBACK_5M_ENABLED || !ctx) return { qualifies: false, reason: "NO_5M_CONTEXT" };
  const close = finite(ctx.close, finite(ctx.price, null));
  const barTimeMs = finite(ctx.barTimeMs, 0);
  const fresh = ageSec(ctx) <= CFG.ENTRY_5M_BEAR_GUARD_MAX_AGE_SEC;
  const afterTouch = barTimeMs >= finite(pending?.trailing?.zoneQualifiedAtMs, 0);
  const ema8 = finite(ctx.ema8, null), ema18 = finite(ctx.ema18, null), fvvo = finite(ctx.fvvo, null), slope = finite(ctx.slope, null);
  const maxEntryPrice = confirmPrice * (1 + CFG.HYBRID_PULLBACK_MAX_ENTRY_ABOVE_CONFIRM_PCT / 100);
  const rayOk = nonBearRay(ctx.rayRegime), closeAboveEma8 = close !== null && ema8 !== null && close >= ema8, emaOrderOk = ema8 !== null && ema18 !== null && ema8 > ema18, fvvoOk = fvvo !== null && fvvo >= 0, slopeOk = slope !== null && slope >= 0, chaseOk = close !== null && close <= maxEntryPrice + 1e-9;
  return { qualifies: close !== null && close + 1e-9 >= confirmPrice && fresh && afterTouch && rayOk && closeAboveEma8 && emaOrderOk && fvvoOk && slopeOk && chaseOk, close, barTimeMs, fresh, afterTouch, rayOk, closeAboveEma8, emaOrderOk, fvvoOk, slopeOk, chaseOk, maxEntryPrice: round(maxEntryPrice, 8), rayRegime: ctx.rayRegime || null, ema8, ema18, fvvo, slope };
}

async function completeHybridPullbackCandidate(pending, feature, path, details) {
  const t = pending.trailing || {};
  const checked = validateStoredPriceTriggerAtExecution(pending, feature.price);
  if (!checked.ok) {
    const cancelled = resolvePriceEntryPending("CANCELLED", checked.error, { trailing: t }, pending);
    await persistState("hybrid_pullback_execution_invalid");
    log("WARN", "FVVO_HYBRID_PULLBACK_CANCELLED", { triggerId: cancelled?.id || pending.id, reason: checked.error, path, executionPrice: feature.price });
    return true;
  }
  const payload = { triggerId: pending.id, entryCampaign: pending.entryCampaign || null, entryRole: pending.entryRole || null, path, confirmPrice: pending.breakoutConfirmPrice, observedLowPrice: t.observedLowPrice, executionPrice: feature.price, stopPrice: pending.stopPrice, stopDistancePct: checked.levels.stopPct, details };
  if (CFG.HYBRID_PULLBACK_FAST_PATH_MODE === "shadow") {
    const shadow = resolvePriceEntryPending("SHADOW_CANDIDATE", `HYBRID_PULLBACK_${path}_SHADOW_CANDIDATE`, { trailing: t, triggeredPrice: round(feature.price, 8), triggeredAt: nowIso(), triggeredAtMs: nowMs() }, pending);
    await persistState("hybrid_pullback_shadow_candidate");
    log("INFO", "FVVO_HYBRID_PULLBACK_SHADOW_CANDIDATE", { ...payload, triggerId: shadow?.id || pending.id, automaticOrderSent: false });
    return true;
  }
  await enterFromPriceTrigger(pending, feature, path === "FAST_VOTE" ? "HYBRID_PULLBACK_FAST_CONFIRMED" : "HYBRID_PULLBACK_5M_FALLBACK_CONFIRMED");
  return true;
}

async function evaluateHybridPullbackReclaimZone(pending, previousPrice, feature) {
  const current = nowMs();
  const t = pending.trailing || (pending.trailing = {});
  const rangeLow = finite(pending.activationRangeLow, null), rangeHigh = finite(pending.activationRangeHigh, null), confirmPrice = finite(pending.breakoutConfirmPrice, null);
  if (!(rangeLow > 0) || !(rangeHigh > rangeLow) || !(confirmPrice >= rangeHigh)) {
    const cancelled = resolvePriceEntryPending("CANCELLED", "HYBRID_PULLBACK_INVALID_LEVELS", { trailing: t }, pending);
    await persistState("hybrid_pullback_invalid_levels");
    log("WARN", "FVVO_HYBRID_PULLBACK_CANCELLED", { triggerId: cancelled?.id || pending.id, reason: "HYBRID_PULLBACK_INVALID_LEVELS", rangeLow, rangeHigh, confirmPrice });
    return;
  }
  if (!t.phase) t.phase = "ARMED";
  if (feature.price <= pending.stopPrice + 1e-9) {
    const cancelled = resolvePriceEntryPending("CANCELLED", "HYBRID_PULLBACK_LOW_AT_OR_BELOW_STOP", { trailing: t }, pending);
    await persistState("hybrid_pullback_low_at_stop");
    log("WARN", "FVVO_HYBRID_PULLBACK_CANCELLED", { triggerId: cancelled?.id || pending.id, reason: "HYBRID_PULLBACK_LOW_AT_OR_BELOW_STOP", price: feature.price, stopPrice: pending.stopPrice });
    return;
  }
  if (t.phase === "ARMED") {
    const crossed = CFG.PRICE_ENTRY_REQUIRE_ACTUAL_CROSS ? priceTriggerCrossed(pending, previousPrice, feature.price) : feature.price <= rangeHigh;
    if (!crossed) return;
    Object.assign(t, { phase: "WATCHING_ZONE", activatedAtMs: current, observedLowPrice: round(feature.price, 8), observedLowAtMs: feature.receivedAtMs || current, zoneQualifiedAtMs: 0, trackingExpiresAtMs: 0, votes: [], voteStartedAtMs: 0, consecutivePasses: 0, lastVoteAtMs: 0, last5mBarTimeMs: 0, fallback5mObservations: 0 });
    log("INFO", "FVVO_HYBRID_PULLBACK_ZONE_ACTIVATED", { triggerId: pending.id, entryRole: pending.entryRole || null, rangeLow, rangeHigh, confirmPrice, price: feature.price });
  }
  const priorLow = finite(t.observedLowPrice, feature.price);
  if (feature.price < priorLow - 1e-9) {
    t.observedLowPrice = round(feature.price, 8); t.observedLowAtMs = feature.receivedAtMs || current; t.votes = []; t.voteStartedAtMs = 0; t.consecutivePasses = 0; t.lastVoteAtMs = 0;
    log("INFO", "FVVO_HYBRID_PULLBACK_NEW_LOW_VOTE_RESET", { triggerId: pending.id, observedLowPrice: t.observedLowPrice, price: feature.price });
  }
  const low = finite(t.observedLowPrice, feature.price);
  const penetrationPct = percentageBelow(rangeHigh, low);
  const lowStopBufferPct = low > pending.stopPrice ? percentageBelow(low, pending.stopPrice) : 0;
  if (lowStopBufferPct + 1e-9 < CFG.HYBRID_PULLBACK_MIN_LOW_ABOVE_STOP_PCT) {
    const cancelled = resolvePriceEntryPending("CANCELLED", "HYBRID_PULLBACK_LOW_TOO_CLOSE_TO_STOP", { trailing: t }, pending);
    await persistState("hybrid_pullback_low_too_close_stop");
    log("WARN", "FVVO_HYBRID_PULLBACK_CANCELLED", { triggerId: cancelled?.id || pending.id, reason: "HYBRID_PULLBACK_LOW_TOO_CLOSE_TO_STOP", low, stopPrice: pending.stopPrice, lowStopBufferPct });
    return;
  }
  if (t.phase === "WATCHING_ZONE") {
    if (penetrationPct + 1e-9 < CFG.HYBRID_PULLBACK_MIN_PENETRATION_PCT) { await persistState("hybrid_pullback_watch_zone"); return; }
    const trackingExpiresAtMs = Math.min(finite(pending.expiresAtMs, current + CFG.HYBRID_PULLBACK_MAX_TRACK_SEC * 1000), current + CFG.HYBRID_PULLBACK_MAX_TRACK_SEC * 1000);
    Object.assign(t, { phase: "WAIT_RECOVERY", zoneQualifiedAtMs: current, trackingExpiresAtMs });
    log("INFO", "FVVO_HYBRID_PULLBACK_ZONE_QUALIFIED", { triggerId: pending.id, entryRole: pending.entryRole || null, observedLowPrice: low, penetrationPct, confirmPrice, trackingExpiresAt: new Date(trackingExpiresAtMs).toISOString() });
  }
  if (current > finite(t.trackingExpiresAtMs, 0)) {
    const cancelled = resolvePriceEntryPending("CANCELLED", "HYBRID_PULLBACK_TRACK_TIMEOUT", { trailing: t }, pending);
    await persistState("hybrid_pullback_timeout");
    log("WARN", "FVVO_HYBRID_PULLBACK_CANCELLED", { triggerId: cancelled?.id || pending.id, reason: "HYBRID_PULLBACK_TRACK_TIMEOUT" });
    return;
  }

  const fallback = hybridPullbackFallback5mContext(pending, confirmPrice);
  if (fallback.barTimeMs > finite(t.last5mBarTimeMs, 0)) {
    t.last5mBarTimeMs = fallback.barTimeMs;
    t.fallback5mObservations = fallback.qualifies ? Math.floor(finite(t.fallback5mObservations, 0)) + 1 : 0;
    const fallbackExecutionInsideCap = feature.price <= confirmPrice * (1 + CFG.HYBRID_PULLBACK_MAX_ENTRY_ABOVE_CONFIRM_PCT / 100) + 1e-9;
    if (t.fallback5mObservations >= CFG.HYBRID_PULLBACK_FALLBACK_5M_CONFIRM_OBSERVATIONS && fallbackExecutionInsideCap) {
      await completeHybridPullbackCandidate(pending, feature, "5M_FALLBACK", fallback); return;
    }
  }

  const reboundPct = percentPnl(low, feature.price);
  if (reboundPct + 1e-9 < CFG.HYBRID_PULLBACK_MIN_REBOUND_PCT || feature.price + 1e-9 < confirmPrice) { await persistState("hybrid_pullback_wait_recovery_cross"); return; }
  const maxEntryPrice = confirmPrice * (1 + CFG.HYBRID_PULLBACK_MAX_ENTRY_ABOVE_CONFIRM_PCT / 100);
  if (feature.price > maxEntryPrice + 1e-9) {
    t.votes = []; t.voteStartedAtMs = 0; t.consecutivePasses = 0; t.lastVoteAtMs = 0;
    await persistState("hybrid_pullback_wait_no_chase");
    log("INFO", "FVVO_HYBRID_PULLBACK_WAIT_NO_CHASE", { triggerId: pending.id, confirmPrice, maxEntryPrice: round(maxEntryPrice, 8), price: feature.price });
    return;
  }
  if (feature.price < rangeLow - 1e-9) {
    t.votes = []; t.voteStartedAtMs = 0; t.consecutivePasses = 0; t.lastVoteAtMs = 0;
    await persistState("hybrid_pullback_below_zone_low_reset"); return;
  }
  if (t.voteStartedAtMs > 0 && current - t.voteStartedAtMs > CFG.HYBRID_PULLBACK_VOTE_MAX_SEC * 1000) {
    t.votes = []; t.voteStartedAtMs = 0; t.consecutivePasses = 0; t.lastVoteAtMs = 0;
    log("INFO", "FVVO_HYBRID_PULLBACK_VOTE_TIMEOUT_RESET", { triggerId: pending.id });
  }
  if (current - finite(t.lastVoteAtMs, 0) < CFG.HYBRID_PULLBACK_MIN_SPACING_SEC * 1000) return;
  const evidence = hybridPullbackFastEvidence(feature, pending, confirmPrice);
  if (evidence.hardReset) {
    t.votes = []; t.voteStartedAtMs = 0; t.consecutivePasses = 0; t.lastVoteAtMs = 0;
    await persistState("hybrid_pullback_hard_vote_reset");
    log("INFO", "FVVO_HYBRID_PULLBACK_HARD_VOTE_RESET", { triggerId: pending.id, evidence }); return;
  }
  const rules = hybridPullbackVoteRules(pending);
  if (!(t.voteStartedAtMs > 0)) t.voteStartedAtMs = current;
  t.lastVoteAtMs = current;
  t.votes = Array.isArray(t.votes) ? t.votes : [];
  t.votes.push({ atMs: current, pass: evidence.qualifies, evidence });
  if (t.votes.length > rules.count) t.votes = t.votes.slice(-rules.count);
  t.consecutivePasses = evidence.qualifies ? Math.floor(finite(t.consecutivePasses, 0)) + 1 : 0;
  const passCount = t.votes.filter((v) => v.pass).length;
  const spanSec = t.votes.length > 1 ? (t.votes[t.votes.length - 1].atMs - t.votes[0].atMs) / 1000 : 0;
  const qualified = t.votes.length >= rules.count && passCount >= rules.required && t.consecutivePasses >= rules.finalConsecutive && spanSec + 1e-9 >= rules.minSpanSec;
  log("INFO", "FVVO_HYBRID_PULLBACK_FAST_VOTE", { triggerId: pending.id, entryRole: rules.role, votes: t.votes.length, passCount, required: rules.required, consecutivePasses: t.consecutivePasses, finalConsecutiveRequired: rules.finalConsecutive, spanSec: round(spanSec, 3), minSpanSec: rules.minSpanSec, qualified, evidence });
  await persistState("hybrid_pullback_fast_vote");
  if (qualified) await completeHybridPullbackCandidate(pending, feature, "FAST_VOTE", { rules, passCount, spanSec: round(spanSec, 3), evidence });
}

async function evaluateConfirmedPullbackReclaimZone(pending, previousPrice, feature) {
  const current = nowMs();
  const t = pending.trailing || (pending.trailing = {});
  const rangeLow = finite(pending.activationRangeLow, null);
  const rangeHigh = finite(pending.activationRangeHigh, null);
  const confirmPrice = finite(pending.breakoutConfirmPrice, null);
  if (!(rangeLow > 0) || !(rangeHigh > rangeLow) || !(confirmPrice >= rangeHigh)) {
    const cancelled = resolvePriceEntryPending("CANCELLED", "CONFIRMED_PULLBACK_INVALID_LEVELS", { trailing: t }, pending);
    await persistState("confirmed_pullback_invalid_levels");
    log("WARN", "FVVO_CONFIRMED_PULLBACK_CANCELLED", { triggerId: cancelled?.id || pending.id, reason: "CONFIRMED_PULLBACK_INVALID_LEVELS", rangeLow, rangeHigh, confirmPrice });
    return;
  }
  if (!t.phase) t.phase = "ARMED";
  if (feature.price <= pending.stopPrice + 1e-9) {
    const cancelled = resolvePriceEntryPending("CANCELLED", "CONFIRMED_PULLBACK_LOW_AT_OR_BELOW_STOP", { trailing: t }, pending);
    await persistState("confirmed_pullback_low_at_stop");
    log("WARN", "FVVO_CONFIRMED_PULLBACK_CANCELLED", { triggerId: cancelled?.id || pending.id, reason: "CONFIRMED_PULLBACK_LOW_AT_OR_BELOW_STOP", price: feature.price, stopPrice: pending.stopPrice });
    return;
  }
  if (t.phase === "ARMED") {
    const crossed = CFG.PRICE_ENTRY_REQUIRE_ACTUAL_CROSS ? priceTriggerCrossed(pending, previousPrice, feature.price) : feature.price <= rangeHigh;
    if (!crossed) return;
    Object.assign(t, { phase: "WATCHING_ZONE_TOUCH", activatedAt: nowIso(), activatedAtMs: current, observedLowPrice: round(feature.price, 8), observedLowAt: feature.receivedAt, observedLowAtMs: feature.receivedAtMs, zoneQualifiedAtMs: 0, trackingExpiresAtMs: 0, last15mBarTimeMs: 0, confirmed15mAtMs: 0, retestSeen: false, fastConfirmObservations: 0 });
    log("INFO", "FVVO_CONFIRMED_PULLBACK_ZONE_ACTIVATED", { triggerId: pending.id, entryCampaign: pending.entryCampaign || null, entryRole: pending.entryRole || null, rangeLow, rangeHigh, confirmPrice, price: feature.price });
  }
  if (feature.price < finite(t.observedLowPrice, Infinity)) {
    t.observedLowPrice = round(feature.price, 8); t.observedLowAt = feature.receivedAt; t.observedLowAtMs = feature.receivedAtMs;
  }
  const low = finite(t.observedLowPrice, feature.price);
  const penetrationPct = percentageBelow(rangeHigh, low);
  const lowStopBufferPct = low > pending.stopPrice ? percentageBelow(low, pending.stopPrice) : 0;
  if (lowStopBufferPct + 1e-9 < CFG.CONFIRMED_PULLBACK_MIN_LOW_ABOVE_STOP_PCT) {
    const cancelled = resolvePriceEntryPending("CANCELLED", "CONFIRMED_PULLBACK_LOW_TOO_CLOSE_TO_STOP", { trailing: t }, pending);
    await persistState("confirmed_pullback_low_too_close_stop");
    log("WARN", "FVVO_CONFIRMED_PULLBACK_CANCELLED", { triggerId: cancelled?.id || pending.id, reason: "CONFIRMED_PULLBACK_LOW_TOO_CLOSE_TO_STOP", low, stopPrice: pending.stopPrice, lowStopBufferPct });
    return;
  }
  if (t.phase === "WATCHING_ZONE_TOUCH") {
    if (penetrationPct + 1e-9 < CFG.CONFIRMED_PULLBACK_MIN_PENETRATION_PCT) { await persistState("confirmed_pullback_watch_zone"); return; }
    const trackingExpiresAtMs = Math.min(finite(pending.expiresAtMs, current + CFG.CONFIRMED_PULLBACK_MAX_TRACK_SEC * 1000), current + CFG.CONFIRMED_PULLBACK_MAX_TRACK_SEC * 1000);
    Object.assign(t, { phase: "WAIT_15M_RECOVERY_CONFIRM", zoneQualifiedAtMs: current, zoneQualifiedAt: nowIso(), trackingExpiresAtMs, trackingExpiresAt: new Date(trackingExpiresAtMs).toISOString() });
    log("INFO", "FVVO_CONFIRMED_PULLBACK_ZONE_QUALIFIED", { triggerId: pending.id, entryCampaign: pending.entryCampaign || null, entryRole: pending.entryRole || null, rangeLow, rangeHigh, observedLowPrice: low, penetrationPct, confirmPrice, trackingExpiresAt: t.trackingExpiresAt });
  }
  if (current > finite(t.trackingExpiresAtMs, 0)) {
    const cancelled = resolvePriceEntryPending("CANCELLED", "CONFIRMED_PULLBACK_TRACK_TIMEOUT", { trailing: t }, pending);
    await persistState("confirmed_pullback_timeout");
    log("WARN", "FVVO_CONFIRMED_PULLBACK_CANCELLED", { triggerId: cancelled?.id || pending.id, reason: "CONFIRMED_PULLBACK_TRACK_TIMEOUT", observedLowPrice: low, confirmPrice });
    return;
  }
  if (t.phase === "WAIT_15M_RECOVERY_CONFIRM") {
    const ctx = confirmedPullbackAligned15mContext(pending);
    const threshold = confirmPrice * (1 + CFG.CONFIRMED_PULLBACK_15M_CONFIRM_BUFFER_PCT / 100);
    if (ctx.available && ctx.barTimeMs > finite(t.last15mBarTimeMs, 0)) {
      t.last15mBarTimeMs = ctx.barTimeMs;
      if (ctx.close + 1e-9 >= threshold) {
        Object.assign(t, { phase: "WAIT_CONFIRM_LEVEL_RETEST", confirmed15mAtMs: ctx.barTimeMs, confirmed15mAt: ctx.receivedAt || nowIso(), confirmed15mClose: round(ctx.close, 8), retestSeen: false, fastConfirmObservations: 0 });
        log("INFO", "FVVO_CONFIRMED_PULLBACK_15M_CLOSE_CONFIRMED", { triggerId: pending.id, entryCampaign: pending.entryCampaign || null, entryRole: pending.entryRole || null, confirmPrice, confirmThreshold: round(threshold, 8), close: ctx.close, barTimeMs: ctx.barTimeMs, context: ctx });
      } else {
        log("INFO", "FVVO_CONFIRMED_PULLBACK_WAIT_15M_CLOSE", { triggerId: pending.id, confirmPrice, confirmThreshold: round(threshold, 8), close: ctx.close, barTimeMs: ctx.barTimeMs });
      }
      await persistState("confirmed_pullback_15m_update");
    }
    return;
  }
  if (t.phase === "WAIT_CONFIRM_LEVEL_RETEST" || t.phase === "WAIT_FAST_RECOVERY") {
    const holdFloor = confirmPrice * (1 - CFG.CONFIRMED_PULLBACK_RETEST_HOLD_BELOW_PCT / 100);
    const touchCeiling = confirmPrice * (1 + CFG.CONFIRMED_PULLBACK_RETEST_TOUCH_ABOVE_PCT / 100);
    const maxEntryPrice = confirmPrice * (1 + CFG.CONFIRMED_PULLBACK_MAX_ENTRY_ABOVE_CONFIRM_PCT / 100);
    if (feature.price < holdFloor - 1e-9) {
      Object.assign(t, { phase: "WAIT_15M_RECOVERY_CONFIRM", confirmed15mAtMs: 0, confirmed15mAt: null, confirmed15mClose: null, retestSeen: false, fastConfirmObservations: 0 });
      await persistState("confirmed_pullback_retest_failed_reconfirm");
      log("WARN", "FVVO_CONFIRMED_PULLBACK_RETEST_FAILED_WAIT_RECONFIRM", { triggerId: pending.id, confirmPrice, holdFloor: round(holdFloor, 8), price: feature.price, action: "WAIT_NEW_ALIGNED_15M_CLOSE" });
      return;
    }
    if (!t.retestSeen && feature.price <= touchCeiling + 1e-9) {
      t.retestSeen = true; t.retestSeenAt = nowIso(); t.retestSeenAtMs = current; t.phase = "WAIT_FAST_RECOVERY";
      log("INFO", "FVVO_CONFIRMED_PULLBACK_RETEST_HELD", { triggerId: pending.id, confirmPrice, holdFloor: round(holdFloor, 8), touchCeiling: round(touchCeiling, 8), retestPrice: feature.price });
    }
    if (!t.retestSeen) { await persistState("confirmed_pullback_wait_retest"); return; }
    if (feature.price > maxEntryPrice + 1e-9) { t.fastConfirmObservations = 0; await persistState("confirmed_pullback_wait_no_chase"); return; }
    const evidence = confirmedPullbackFastEvidence(feature, confirmPrice);
    t.lastFastEvidence = evidence;
    t.fastConfirmObservations = evidence.qualifies ? Math.max(0, Math.floor(finite(t.fastConfirmObservations, 0))) + 1 : 0;
    const required = CFG.CONFIRMED_PULLBACK_FAST_CONFIRM_OBSERVATIONS;
    if (t.fastConfirmObservations < required) {
      await persistState("confirmed_pullback_wait_fast_recovery");
      log("INFO", "FVVO_CONFIRMED_PULLBACK_FAST_CONFIRMING", { triggerId: pending.id, confirmPrice, observations: t.fastConfirmObservations, required, maxEntryPrice: round(maxEntryPrice, 8), evidence });
      return;
    }
    const checked = validateStoredPriceTriggerAtExecution(pending, feature.price);
    if (!checked.ok) {
      const cancelled = resolvePriceEntryPending("CANCELLED", checked.error, { trailing: t }, pending);
      await persistState("confirmed_pullback_execution_invalid");
      log("WARN", "FVVO_CONFIRMED_PULLBACK_CANCELLED", { triggerId: cancelled?.id || pending.id, reason: checked.error, executionPrice: feature.price });
      return;
    }
    if (CFG.CONFIRMED_PULLBACK_RECLAIM_ZONE_MODE === "shadow") {
      const shadow = resolvePriceEntryPending("SHADOW_CANDIDATE", "CONFIRMED_PULLBACK_SHADOW_CANDIDATE", { trailing: t, triggeredPrice: round(feature.price, 8), triggeredAt: nowIso(), triggeredAtMs: current }, pending);
      await persistState("confirmed_pullback_shadow_candidate");
      log("INFO", "FVVO_CONFIRMED_PULLBACK_SHADOW_CANDIDATE", { triggerId: shadow?.id || pending.id, confirmPrice, executionPrice: feature.price, stopPrice: pending.stopPrice, automaticOrderSent: false });
      return;
    }
    await enterFromPriceTrigger(pending, feature, "CONFIRMED_PULLBACK_RECLAIM_CONFIRMED");
  }
}


function adaptiveBreakoutHoldEligible(feature, confirmThreshold, t, current) {
  if (!CFG.BREAKOUT_RETEST_ADAPTIVE_CONFIRM_ENABLED) return false;
  if (Math.floor(finite(t?.breakoutConfirmObservations, 0)) < 1) return false;
  const firstAtMs = finite(t?.firstBreakoutConfirmAtMs, finite(t?.lastBreakoutConfirmAtMs, 0));
  if (!(firstAtMs > 0) || current - firstAtMs > CFG.BREAKOUT_RETEST_ADAPTIVE_HOLD_MAX_SEC * 1000) return false;
  const holdFloor = confirmThreshold * (1 - CFG.BREAKOUT_RETEST_ADAPTIVE_HOLD_TOLERANCE_PCT / 100);
  if (feature.price < holdFloor - 1e-9) return false;
  if (CFG.BREAKOUT_RETEST_ADAPTIVE_HOLD_REQUIRE_ABOVE_EMA8) {
    const ema8 = finite(feature.ema8, null);
    if (ema8 === null || feature.price + 1e-9 < ema8) return false;
  }
  if (CFG.BREAKOUT_RETEST_ADAPTIVE_HOLD_REQUIRE_RAY_NOT_BEAR && !nonBearRay(feature.rayRegime)) return false;
  return true;
}

async function evaluateBreakoutRetestReclaimZone(pending, previousPrice, feature) {
  const current = nowMs();
  const t = pending.trailing || (pending.trailing = {});
  const rangeLow = finite(pending.retestRangeLow, finite(pending.activationRangeLow, null));
  const rangeHigh = finite(pending.retestRangeHigh, finite(pending.activationRangeHigh, null));
  const breakoutConfirmPrice = finite(pending.breakoutConfirmPrice, finite(pending.activationPrice, pending.triggerPrice));
  const confirmThreshold = breakoutConfirmPrice * (1 + CFG.BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRM_BUFFER_PCT / 100);
  const failBelowPrice = rangeLow * (1 - CFG.BREAKOUT_RETEST_RECLAIM_ZONE_FAIL_BELOW_LOW_BUFFER_PCT / 100);

  if (!(rangeLow > 0) || !(rangeHigh > 0) || rangeLow >= rangeHigh || !(breakoutConfirmPrice > 0) || breakoutConfirmPrice < rangeHigh) {
    const cancelled = resolvePriceEntryPending("CANCELLED", "BREAKOUT_RETEST_RECLAIM_ZONE_INVALID_CONFIRM_OR_RANGE", { trailing: t, triggeredPrice: round(feature.price, 8), triggeredAt: nowIso(), triggeredAtMs: current }, pending);
    await persistState("breakout_retest_reclaim_zone_invalid_confirm_range");
    log("WARN", "FVVO_BREAKOUT_RETEST_RECLAIM_ZONE_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, breakoutConfirmPrice, retestRangeLow: rangeLow, retestRangeHigh: rangeHigh, executionPrice: feature.price });
    return;
  }
  if (!t.phase) t.phase = "ARMED";

  if (t.phase === "ARMED" || t.phase === "CONFIRMING_BREAKOUT") {
    const epsilon = Math.max(CFG.MANUAL_ONE_STOP_PRICE_STEP / 10, 1e-9);
    const crossedOrConfirming = t.phase === "CONFIRMING_BREAKOUT" || (CFG.PRICE_ENTRY_REQUIRE_ACTUAL_CROSS ? (Number.isFinite(previousPrice) && previousPrice < confirmThreshold - epsilon && feature.price >= confirmThreshold - epsilon) : feature.price >= confirmThreshold - epsilon);
    if (!crossedOrConfirming) return;

    const adaptiveHoldAccepted = feature.price < confirmThreshold - epsilon && adaptiveBreakoutHoldEligible(feature, confirmThreshold, t, current);
    if (feature.price < confirmThreshold - epsilon && !adaptiveHoldAccepted) {
      if (t.phase === "CONFIRMING_BREAKOUT") {
        Object.assign(t, { phase: "ARMED", breakoutConfirmObservations: 0, firstBreakoutConfirmAt: null, firstBreakoutConfirmAtMs: 0, lastBreakoutConfirmPrice: null, lastBreakoutConfirmAt: null, lastBreakoutConfirmAtMs: 0 });
        await persistState("breakout_retest_reclaim_zone_confirm_reset");
        log("INFO", "FVVO_BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRM_RESET", { triggerId: pending.id, breakoutConfirmPrice, confirmThreshold: round(confirmThreshold, 8), adaptiveHoldFloor: round(confirmThreshold * (1 - CFG.BREAKOUT_RETEST_ADAPTIVE_HOLD_TOLERANCE_PCT / 100), 8), executionPrice: feature.price });
      }
      return;
    }

    t.phase = "CONFIRMING_BREAKOUT";
    t.breakoutConfirmObservations = Math.floor(finite(t.breakoutConfirmObservations, 0)) + 1;
    if (t.breakoutConfirmObservations === 1) {
      t.firstBreakoutConfirmAt = feature.receivedAt || nowIso();
      t.firstBreakoutConfirmAtMs = feature.receivedAtMs || current;
    }
    t.lastBreakoutConfirmPrice = round(feature.price, 8);
    t.lastBreakoutConfirmAt = feature.receivedAt || nowIso();
    t.lastBreakoutConfirmAtMs = feature.receivedAtMs || current;
    t.highestBreakoutPrice = Math.max(finite(t.highestBreakoutPrice, 0), round(feature.price, 8));

    if (adaptiveHoldAccepted) {
      log("INFO", "FVVO_BREAKOUT_RETEST_ADAPTIVE_HOLD_ACCEPTED", { triggerId: pending.id, breakoutConfirmPrice, confirmThreshold: round(confirmThreshold, 8), adaptiveHoldFloor: round(confirmThreshold * (1 - CFG.BREAKOUT_RETEST_ADAPTIVE_HOLD_TOLERANCE_PCT / 100), 8), executionPrice: feature.price, observations: t.breakoutConfirmObservations, requiredObservations: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRM_OBSERVATIONS, rayRegime: feature.rayRegime, ema8: feature.ema8 });
    }

    if (t.breakoutConfirmObservations < CFG.BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRM_OBSERVATIONS) {
      await persistState("breakout_retest_reclaim_zone_confirming_breakout");
      log("INFO", "FVVO_BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRMING", { triggerId: pending.id, breakoutConfirmPrice, confirmThreshold: round(confirmThreshold, 8), observations: t.breakoutConfirmObservations, requiredObservations: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRM_OBSERVATIONS, executionPrice: feature.price, adaptiveHoldAccepted });
      return;
    }

    const trackingExpiresAtMs = Math.min(finite(pending.expiresAtMs, current + CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MAX_TRACK_SEC * 1000), current + CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MAX_TRACK_SEC * 1000);
    Object.assign(t, { phase: "WAITING_RETEST", breakoutAt: nowIso(), breakoutAtMs: current, breakoutPrice: round(feature.price, 8), breakoutConfirmPrice: round(breakoutConfirmPrice, 8), confirmThreshold: round(confirmThreshold, 8), breakoutConfirmObservations: t.breakoutConfirmObservations, highestBreakoutPrice: round(Math.max(finite(t.highestBreakoutPrice, 0), feature.price), 8), retestLowPrice: null, retestLowAt: null, retestLowAtMs: 0, retestPenetrationPct: 0, lowStopBufferPct: 0, reclaimTargetPrice: null, maxEntryPrice: null, shallowHoldLowPrice: null, shallowHoldLowAt: null, shallowHoldLowAtMs: 0, shallowHoldObservations: 0, shallowHoldReclaimTargetPrice: null, shallowHoldMaxEntryPrice: null, shallowHoldPullbackFromHighPct: 0, shallowHoldLastChaseLowPrice: null, shallowHoldShadowCandidateLowPrice: null, bullContinuationLowPrice: null, bullContinuationLowAtMs: 0, bullContinuationObservations: 0, bullContinuationShadowCandidateLowPrice: null, bullContinuationBlowoffVeto: false, trackingExpiresAtMs, trackingExpiresAt: new Date(trackingExpiresAtMs).toISOString() });
    await persistState("breakout_retest_reclaim_zone_activated");
    log("INFO", "FVVO_BREAKOUT_RETEST_RECLAIM_ZONE_ACTIVATED", { triggerId: pending.id, breakoutConfirmPrice, confirmThreshold: round(confirmThreshold, 8), retestRangeLow: rangeLow, retestRangeHigh: rangeHigh, breakoutPrice: feature.price, observations: t.breakoutConfirmObservations, stopPrice: pending.stopPrice, mode: breakoutRetestReclaimZoneMode(), trackingExpiresAt: t.trackingExpiresAt });
  }

  if (t.phase === "WAITING_RETEST" || t.phase === "TRACKING_RECLAIM") {
    if (current > finite(t.trackingExpiresAtMs, 0)) {
      const cancelled = resolvePriceEntryPending("CANCELLED", "BREAKOUT_RETEST_RECLAIM_ZONE_TRACK_TIMEOUT", { trailing: t }, pending);
      await persistState("breakout_retest_reclaim_zone_timeout");
      log("WARN", "FVVO_BREAKOUT_RETEST_RECLAIM_ZONE_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, breakoutConfirmPrice, retestRangeLow: rangeLow, retestRangeHigh: rangeHigh, retestLowPrice: t.retestLowPrice || null, stopPrice: pending.stopPrice });
      return;
    }

    if (feature.price > finite(t.highestBreakoutPrice, 0) + 1e-9) t.highestBreakoutPrice = round(feature.price, 8);

    if (feature.price < failBelowPrice - 1e-9) {
      const cancelled = resolvePriceEntryPending("CANCELLED", "BREAKOUT_RETEST_RECLAIM_ZONE_RETEST_FAILED_BELOW_LOW_BUFFER", { trailing: t, triggeredPrice: round(feature.price, 8), triggeredAt: nowIso(), triggeredAtMs: current }, pending);
      await persistState("breakout_retest_reclaim_zone_failed_below_low_buffer");
      log("WARN", "FVVO_BREAKOUT_RETEST_RECLAIM_ZONE_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, breakoutConfirmPrice, retestRangeLow: rangeLow, retestRangeHigh: rangeHigh, failBelowPrice: round(failBelowPrice, 8), failBelowLowBufferPct: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_FAIL_BELOW_LOW_BUFFER_PCT, executionPrice: feature.price, stopPrice: pending.stopPrice });
      return;
    }

    if (t.phase === "WAITING_RETEST") {
      if (feature.price > rangeHigh + 1e-9) {
        const bullContinuationEntered = await evaluateBreakoutBullContinuation(pending, feature, rangeHigh, breakoutConfirmPrice);
        if (bullContinuationEntered) return;
        const shallowEntered = await evaluateBreakoutShallowHoldReclaim(pending, feature, rangeHigh, breakoutConfirmPrice);
        if (shallowEntered) return;
        await persistState("breakout_retest_reclaim_zone_wait_retest");
        return;
      }
      if (t.retestLowPrice === null || feature.price < t.retestLowPrice - 1e-9) {
        t.retestLowPrice = round(feature.price, 8);
        t.retestLowAt = feature.receivedAt;
        t.retestLowAtMs = feature.receivedAtMs;
      }
      const low = finite(t.retestLowPrice, feature.price);
      const penetrationPct = percentageBelow(rangeHigh, low);
      const lowStopBufferPct = low > pending.stopPrice ? percentageBelow(low, pending.stopPrice) : 0;
      t.retestPenetrationPct = round(penetrationPct, 6);
      t.lowStopBufferPct = round(lowStopBufferPct, 6);
      if (low <= pending.stopPrice + 1e-9) {
        const cancelled = resolvePriceEntryPending("CANCELLED", "BREAKOUT_RETEST_RECLAIM_ZONE_LOW_AT_OR_BELOW_STOP", { trailing: t }, pending);
        await persistState("breakout_retest_reclaim_zone_low_at_stop");
        log("WARN", "FVVO_BREAKOUT_RETEST_RECLAIM_ZONE_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, breakoutConfirmPrice, retestRangeLow: rangeLow, retestRangeHigh: rangeHigh, retestLowPrice: low, stopPrice: pending.stopPrice, lowStopBufferPct });
        return;
      }
      if (lowStopBufferPct + 1e-9 < CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_LOW_ABOVE_STOP_PCT) {
        const cancelled = resolvePriceEntryPending("CANCELLED", "BREAKOUT_RETEST_RECLAIM_ZONE_LOW_TOO_CLOSE_TO_STOP", { trailing: t }, pending);
        await persistState("breakout_retest_reclaim_zone_low_too_close_stop");
        log("WARN", "FVVO_BREAKOUT_RETEST_RECLAIM_ZONE_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, breakoutConfirmPrice, retestRangeLow: rangeLow, retestRangeHigh: rangeHigh, retestLowPrice: low, stopPrice: pending.stopPrice, lowStopBufferPct, minLowAboveStopPct: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_LOW_ABOVE_STOP_PCT });
        return;
      }
      if (penetrationPct + 1e-9 < CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_RETEST_PENETRATION_PCT) { await persistState("breakout_retest_reclaim_zone_watch_retest_depth"); return; }
      Object.assign(t, { phase: "TRACKING_RECLAIM", retestLowPrice: low, retestPenetrationPct: round(penetrationPct, 6), reclaimTargetPrice: round(low * (1 + CFG.BREAKOUT_RETEST_RECLAIM_ZONE_RECLAIM_PCT / 100), 8), maxEntryPrice: round(rangeHigh * (1 + CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MAX_ENTRY_ABOVE_HIGH_PCT / 100), 8) });
      log("INFO", "FVVO_BREAKOUT_RETEST_RECLAIM_ZONE_RETEST_QUALIFIED", { triggerId: pending.id, breakoutConfirmPrice, retestRangeLow: rangeLow, retestRangeHigh: rangeHigh, retestLowPrice: low, penetrationPct, reclaimTargetPrice: t.reclaimTargetPrice, maxEntryPrice: t.maxEntryPrice, stopPrice: pending.stopPrice, trackingExpiresAt: t.trackingExpiresAt });
    }

    if (t.phase !== "TRACKING_RECLAIM") return;
    const priorLow = finite(t.retestLowPrice, null);
    if (priorLow === null || feature.price < priorLow - 1e-9) {
      t.retestLowPrice = round(feature.price, 8);
      t.retestLowAt = feature.receivedAt;
      t.retestLowAtMs = feature.receivedAtMs;
      if (priorLow !== null) log("INFO", "FVVO_BREAKOUT_RETEST_RECLAIM_ZONE_LOW_UPDATED", { triggerId: pending.id, breakoutConfirmPrice, retestRangeLow: rangeLow, retestRangeHigh: rangeHigh, priorLowPrice: priorLow, retestLowPrice: t.retestLowPrice, stopPrice: pending.stopPrice });
    }
    const low = finite(t.retestLowPrice, feature.price);
    const lowStopBufferPct = low > pending.stopPrice ? percentageBelow(low, pending.stopPrice) : 0;
    t.retestPenetrationPct = round(percentageBelow(rangeHigh, low), 6);
    t.lowStopBufferPct = round(lowStopBufferPct, 6);
    if (low <= pending.stopPrice + 1e-9 || lowStopBufferPct + 1e-9 < CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_LOW_ABOVE_STOP_PCT) {
      const reason = low <= pending.stopPrice + 1e-9 ? "BREAKOUT_RETEST_RECLAIM_ZONE_LOW_AT_OR_BELOW_STOP" : "BREAKOUT_RETEST_RECLAIM_ZONE_LOW_TOO_CLOSE_TO_STOP";
      const cancelled = resolvePriceEntryPending("CANCELLED", reason, { trailing: t }, pending);
      await persistState("breakout_retest_reclaim_zone_low_stop_cancelled");
      log("WARN", "FVVO_BREAKOUT_RETEST_RECLAIM_ZONE_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, breakoutConfirmPrice, retestRangeLow: rangeLow, retestRangeHigh: rangeHigh, retestLowPrice: low, stopPrice: pending.stopPrice, lowStopBufferPct });
      return;
    }

    t.reclaimTargetPrice = round(low * (1 + CFG.BREAKOUT_RETEST_RECLAIM_ZONE_RECLAIM_PCT / 100), 8);
    t.maxEntryPrice = round(rangeHigh * (1 + CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MAX_ENTRY_ABOVE_HIGH_PCT / 100), 8);
    if (feature.price + 1e-9 < t.reclaimTargetPrice) { await persistState("breakout_retest_reclaim_zone_track_reclaim"); return; }
    if (feature.price > t.maxEntryPrice + 1e-9) {
      if (CFG.BREAKOUT_RETEST_RECLAIM_ZONE_CHASE_POLICY === "cancel") {
        const cancelled = resolvePriceEntryPending("CANCELLED", "BREAKOUT_RETEST_RECLAIM_ZONE_RECOVERY_CHASE_TOO_LARGE", { trailing: t, triggeredPrice: round(feature.price, 8), triggeredAt: nowIso(), triggeredAtMs: current }, pending);
        await persistState("breakout_retest_reclaim_zone_chase_cancelled");
        log("WARN", "FVVO_BREAKOUT_RETEST_RECLAIM_ZONE_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, breakoutConfirmPrice, retestRangeLow: rangeLow, retestRangeHigh: rangeHigh, retestLowPrice: low, reclaimTargetPrice: t.reclaimTargetPrice, maxEntryPrice: t.maxEntryPrice, executionPrice: feature.price, chasePolicy: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_CHASE_POLICY });
        return;
      }

      const firstWait = !t.recoveryNoChaseActive;
      if (firstWait) {
        t.recoveryNoChaseSince = nowIso();
        t.recoveryNoChaseSinceMs = current;
        t.recoveryNoChaseWaitObservations = 0;
        t.recoveryNoChaseMaxObservedPrice = 0;
      }
      t.recoveryNoChaseActive = true;
      t.recoveryNoChaseWaitObservations = Math.max(0, Math.floor(finite(t.recoveryNoChaseWaitObservations, 0))) + 1;
      t.recoveryNoChaseMaxObservedPrice = round(Math.max(finite(t.recoveryNoChaseMaxObservedPrice, 0), feature.price), 8);
      t.recoveryNoChaseLastPrice = round(feature.price, 8);
      t.recoveryNoChaseLastAt = nowIso();
      await persistState("breakout_retest_reclaim_zone_no_chase_wait");
      log("INFO", "FVVO_BREAKOUT_RETEST_RECLAIM_ZONE_NO_CHASE_WAIT", { triggerId: pending.id, breakoutConfirmPrice, retestRangeLow: rangeLow, retestRangeHigh: rangeHigh, retestLowPrice: low, reclaimTargetPrice: t.reclaimTargetPrice, maxEntryPrice: t.maxEntryPrice, executionPrice: feature.price, waitObservations: t.recoveryNoChaseWaitObservations, maxObservedPrice: t.recoveryNoChaseMaxObservedPrice, firstWait, trackingExpiresAt: t.trackingExpiresAt, action: "KEEP_QUALIFIED_RETEST_ALIVE_NO_CHASE" });
      return;
    }

    if (t.recoveryNoChaseActive) {
      const waitStartedAt = t.recoveryNoChaseSince || null;
      const waitStartedAtMs = finite(t.recoveryNoChaseSinceMs, 0);
      const waitSec = waitStartedAtMs > 0 ? Math.max(0, (current - waitStartedAtMs) / 1000) : null;
      t.recoveryNoChaseActive = false;
      t.recoveryNoChaseReturnedAt = nowIso();
      t.recoveryNoChaseReturnedAtMs = current;
      await persistState("breakout_retest_reclaim_zone_returned_to_entry_window");
      log("INFO", "FVVO_BREAKOUT_RETEST_RECLAIM_ZONE_RETURNED_TO_ENTRY_WINDOW", { triggerId: pending.id, breakoutConfirmPrice, retestRangeLow: rangeLow, retestRangeHigh: rangeHigh, retestLowPrice: low, reclaimTargetPrice: t.reclaimTargetPrice, maxEntryPrice: t.maxEntryPrice, executionPrice: feature.price, waitStartedAt, waitSec: waitSec === null ? null : round(waitSec, 3), priorMaxObservedPrice: finite(t.recoveryNoChaseMaxObservedPrice, null), action: "RESUME_EXISTING_TICK_RECOVERY_GATES" });
    }
    if (!breakoutRetestZoneTickRecoveryOk(feature)) {
      await persistState("breakout_retest_reclaim_zone_wait_tick_recovery");
      log("INFO", "FVVO_BREAKOUT_RETEST_RECLAIM_ZONE_WAIT_TICK_RECOVERY", { triggerId: pending.id, breakoutConfirmPrice, retestRangeLow: rangeLow, retestRangeHigh: rangeHigh, retestLowPrice: low, reclaimTargetPrice: t.reclaimTargetPrice, executionPrice: feature.price, requireTickRecovery: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_REQUIRE_TICK_RECOVERY, minFvvo: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_FVVO });
      return;
    }
    const checked = validateStoredPriceTriggerAtExecution(pending, feature.price);
    if (!checked.ok) {
      const cancelled = resolvePriceEntryPending("CANCELLED", checked.error, { trailing: t, triggeredPrice: round(feature.price, 8), triggeredAt: nowIso(), triggeredAtMs: current }, pending);
      await persistState("breakout_retest_reclaim_zone_execution_levels_invalid");
      log("WARN", "FVVO_BREAKOUT_RETEST_RECLAIM_ZONE_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, breakoutConfirmPrice, retestRangeLow: rangeLow, retestRangeHigh: rangeHigh, retestLowPrice: low, reclaimTargetPrice: t.reclaimTargetPrice, executionPrice: feature.price, stopPrice: pending.stopPrice });
      return;
    }
    if (breakoutRetestReclaimZoneMode() === "shadow") {
      const shadow = resolvePriceEntryPending("SHADOW_CANDIDATE", "BREAKOUT_RETEST_RECLAIM_ZONE_SHADOW_CANDIDATE", { trailing: t, triggeredPrice: round(feature.price, 8), triggeredAt: nowIso(), triggeredAtMs: current }, pending);
      await persistState("breakout_retest_reclaim_zone_shadow_candidate");
      log("INFO", "FVVO_BREAKOUT_RETEST_RECLAIM_ZONE_SHADOW_CANDIDATE", { triggerId: shadow.id, breakoutConfirmPrice, retestRangeLow: rangeLow, retestRangeHigh: rangeHigh, retestLowPrice: low, reclaimTargetPrice: t.reclaimTargetPrice, maxEntryPrice: t.maxEntryPrice, candidateEntryPrice: feature.price, stopPrice: pending.stopPrice, stopDistancePct: checked.levels.stopPct });
      return;
    }
    await enterFromPriceTrigger(pending, feature, "BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRMED");
  }
}

function ensureBreakoutPostExpiryShadows() {
  if (!state.audit || typeof state.audit !== "object") state.audit = {};
  if (!Array.isArray(state.audit.breakoutPostExpiryShadows)) state.audit.breakoutPostExpiryShadows = [];
  state.audit.breakoutPostExpiryShadows = state.audit.breakoutPostExpiryShadows.filter((x) => x && typeof x === "object").slice(-4);
  return state.audit.breakoutPostExpiryShadows;
}

async function armBreakoutPostExpiryShadow(pending) {
  if (!CFG.BREAKOUT_RETEST_POST_EXPIRY_SHADOW_ENABLED || !isBreakoutRetestReclaimZone(pending)) return null;
  const list = ensureBreakoutPostExpiryShadows();
  if (list.some((x) => x.sourceTriggerId === pending.id)) return null;
  const expiryMs = finite(pending.expiresAtMs, nowMs());
  const shadow = {
    id: crypto.randomUUID(),
    sourceTriggerId: pending.id,
    entryCampaign: pending.entryCampaign || null,
    entryRole: pending.entryRole || "standalone",
    status: "ACTIVE",
    phase: String(pending.trailing?.phase || "ARMED"),
    breakoutConfirmPrice: finite(pending.breakoutConfirmPrice, finite(pending.activationPrice, pending.triggerPrice)),
    retestRangeLow: finite(pending.retestRangeLow, pending.activationRangeLow),
    retestRangeHigh: finite(pending.retestRangeHigh, pending.activationRangeHigh),
    stopPrice: finite(pending.stopPrice, null),
    trailing: { ...(pending.trailing || {}), shadowPreviousPrice: finite(pending.lastObservedPrice, pending.armedReferencePrice) },
    originalExpiresAt: pending.expiresAt || new Date(expiryMs).toISOString(),
    originalExpiresAtMs: expiryMs,
    shadowExpiresAtMs: expiryMs + CFG.BREAKOUT_RETEST_POST_EXPIRY_SHADOW_SEC * 1000,
    shadowExpiresAt: new Date(expiryMs + CFG.BREAKOUT_RETEST_POST_EXPIRY_SHADOW_SEC * 1000).toISOString(),
    candidate: null,
    automaticOrderSent: false,
  };
  list.push(shadow);
  state.audit.breakoutPostExpiryShadows = list.slice(-4);
  await persistState("breakout_retest_post_expiry_shadow_armed");
  log("INFO", "FVVO_BREAKOUT_RETEST_POST_EXPIRY_SHADOW_ARMED", { shadowId: shadow.id, sourceTriggerId: pending.id, entryCampaign: shadow.entryCampaign, entryRole: shadow.entryRole, breakoutConfirmPrice: shadow.breakoutConfirmPrice, retestRangeLow: shadow.retestRangeLow, retestRangeHigh: shadow.retestRangeHigh, stopPrice: shadow.stopPrice, originalExpiresAt: shadow.originalExpiresAt, shadowExpiresAt: shadow.shadowExpiresAt, automaticOrderSent: false });
  return shadow;
}

function shadowBreakoutTickRecoveryOk(feature) {
  if (!CFG.BREAKOUT_RETEST_RECLAIM_ZONE_REQUIRE_TICK_RECOVERY) return true;
  const ema8 = finite(feature.ema8, null);
  const slope = finite(feature.slope, null);
  const fvvo = finite(feature.fvvo, null);
  if (ema8 === null || feature.price + 1e-9 < ema8) return false;
  if (slope === null || slope < CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_TICK_SLOPE) return false;
  if (fvvo === null || fvvo < CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_FVVO) return false;
  if (CFG.BREAKOUT_RETEST_RECLAIM_ZONE_REQUIRE_RAY_NOT_BEAR && !nonBearRay(feature.rayRegime)) return false;
  return true;
}

async function evaluateBreakoutPostExpiryShadow(feature) {
  if (!CFG.BREAKOUT_RETEST_POST_EXPIRY_SHADOW_ENABLED || !isPriceTriggerFeature(feature)) return;
  const list = ensureBreakoutPostExpiryShadows();
  if (!list.length) return;
  const current = nowMs();
  let dirty = false;
  for (const sh of list) {
    if (!sh || sh.status === "DONE") continue;
    if (sh.candidate) {
      const c = sh.candidate;
      c.peakPrice = Math.max(finite(c.peakPrice, c.entryPrice), feature.price);
      c.lowPrice = Math.min(finite(c.lowPrice, c.entryPrice), feature.price);
      c.mfePct = round(pctFromTo(c.entryPrice, c.peakPrice), 6);
      c.maePct = round(pctFromTo(c.entryPrice, c.lowPrice), 6);
      c.latestPrice = round(feature.price, 8);
      c.latestPnlPct = round(pctFromTo(c.entryPrice, feature.price), 6);
      dirty = true;
      if (current >= finite(c.performanceEndsAtMs, 0)) {
        sh.status = "DONE";
        sh.resolutionReason = "PERFORMANCE_COMPLETE";
        log("INFO", "FVVO_BREAKOUT_RETEST_POST_EXPIRY_SHADOW_PERFORMANCE_COMPLETE", { shadowId: sh.id, sourceTriggerId: sh.sourceTriggerId, entryPrice: c.entryPrice, mfePct: c.mfePct, maePct: c.maePct, latestPnlPct: c.latestPnlPct, automaticOrderSent: false });
      }
      continue;
    }
    if (current > finite(sh.shadowExpiresAtMs, 0)) {
      sh.status = "DONE";
      sh.resolutionReason = "SHADOW_WINDOW_EXPIRED_NO_CANDIDATE";
      dirty = true;
      log("INFO", "FVVO_BREAKOUT_RETEST_POST_EXPIRY_SHADOW_EXPIRED", { shadowId: sh.id, sourceTriggerId: sh.sourceTriggerId, breakoutConfirmPrice: sh.breakoutConfirmPrice, automaticOrderSent: false });
      continue;
    }
    const t = sh.trailing || (sh.trailing = {});
    const rangeLow = finite(sh.retestRangeLow, null);
    const rangeHigh = finite(sh.retestRangeHigh, null);
    const breakoutConfirmPrice = finite(sh.breakoutConfirmPrice, null);
    if (!(rangeLow > 0) || !(rangeHigh > rangeLow) || !(breakoutConfirmPrice >= rangeHigh) || !(sh.stopPrice > 0)) { sh.status = "DONE"; sh.resolutionReason = "INVALID_SHADOW_LEVELS"; dirty = true; continue; }
    const confirmThreshold = breakoutConfirmPrice * (1 + CFG.BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRM_BUFFER_PCT / 100);
    const epsilon = Math.max(CFG.MANUAL_ONE_STOP_PRICE_STEP / 10, 1e-9);
    const failBelowPrice = rangeLow * (1 - CFG.BREAKOUT_RETEST_RECLAIM_ZONE_FAIL_BELOW_LOW_BUFFER_PCT / 100);
    if (!t.phase) t.phase = sh.phase || "ARMED";

    if (t.phase === "ARMED" || t.phase === "CONFIRMING_BREAKOUT") {
      const prev = finite(t.shadowPreviousPrice, null);
      const strictCross = CFG.PRICE_ENTRY_REQUIRE_ACTUAL_CROSS ? (Number.isFinite(prev) && prev < confirmThreshold - epsilon && feature.price >= confirmThreshold - epsilon) : feature.price >= confirmThreshold - epsilon;
      const continuing = t.phase === "CONFIRMING_BREAKOUT";
      t.shadowPreviousPrice = feature.price;
      if (!strictCross && !continuing) { dirty = true; continue; }
      const adaptiveHoldAccepted = feature.price < confirmThreshold - epsilon && adaptiveBreakoutHoldEligible(feature, confirmThreshold, t, current);
      if (feature.price < confirmThreshold - epsilon && !adaptiveHoldAccepted) {
        Object.assign(t, { phase: "ARMED", breakoutConfirmObservations: 0, firstBreakoutConfirmAtMs: 0, firstBreakoutConfirmAt: null, lastBreakoutConfirmAtMs: 0, lastBreakoutConfirmAt: null });
        dirty = true;
        continue;
      }
      t.phase = "CONFIRMING_BREAKOUT";
      t.breakoutConfirmObservations = Math.floor(finite(t.breakoutConfirmObservations, 0)) + 1;
      if (t.breakoutConfirmObservations === 1) { t.firstBreakoutConfirmAtMs = current; t.firstBreakoutConfirmAt = nowIso(); }
      t.lastBreakoutConfirmAtMs = current; t.lastBreakoutConfirmAt = nowIso();
      t.highestBreakoutPrice = Math.max(finite(t.highestBreakoutPrice, 0), feature.price);
      dirty = true;
      if (t.breakoutConfirmObservations < CFG.BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRM_OBSERVATIONS) continue;
      t.phase = "WAITING_RETEST";
      t.breakoutAtMs = current; t.breakoutAt = nowIso(); t.breakoutPrice = round(feature.price, 8);
      t.retestLowPrice = null;
      log("INFO", "FVVO_BREAKOUT_RETEST_POST_EXPIRY_SHADOW_BREAKOUT_CONFIRMED", { shadowId: sh.id, sourceTriggerId: sh.sourceTriggerId, breakoutConfirmPrice, breakoutPrice: feature.price, adaptiveHoldAccepted, automaticOrderSent: false });
    }

    if (t.phase === "WAITING_RETEST" || t.phase === "TRACKING_RECLAIM") {
      t.shadowPreviousPrice = feature.price;
      if (feature.price < failBelowPrice - 1e-9) { sh.status = "DONE"; sh.resolutionReason = "RETEST_FAILED_BELOW_LOW_BUFFER"; dirty = true; continue; }
      if (t.phase === "WAITING_RETEST") {
        if (feature.price > rangeHigh + 1e-9) { dirty = true; continue; }
        if (t.retestLowPrice === null || feature.price < t.retestLowPrice - 1e-9) t.retestLowPrice = round(feature.price, 8);
        const low = finite(t.retestLowPrice, feature.price);
        const penetrationPct = percentageBelow(rangeHigh, low);
        const lowStopBufferPct = low > sh.stopPrice ? percentageBelow(low, sh.stopPrice) : 0;
        if (low <= sh.stopPrice + 1e-9 || lowStopBufferPct + 1e-9 < CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_LOW_ABOVE_STOP_PCT) { sh.status = "DONE"; sh.resolutionReason = "LOW_TOO_CLOSE_TO_STOP"; dirty = true; continue; }
        if (penetrationPct + 1e-9 < CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_RETEST_PENETRATION_PCT) { dirty = true; continue; }
        t.phase = "TRACKING_RECLAIM";
        t.reclaimTargetPrice = round(low * (1 + CFG.BREAKOUT_RETEST_RECLAIM_ZONE_RECLAIM_PCT / 100), 8);
        t.maxEntryPrice = round(rangeHigh * (1 + CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MAX_ENTRY_ABOVE_HIGH_PCT / 100), 8);
        log("INFO", "FVVO_BREAKOUT_RETEST_POST_EXPIRY_SHADOW_RETEST_QUALIFIED", { shadowId: sh.id, sourceTriggerId: sh.sourceTriggerId, retestLowPrice: low, penetrationPct: round(penetrationPct, 6), reclaimTargetPrice: t.reclaimTargetPrice, maxEntryPrice: t.maxEntryPrice, automaticOrderSent: false });
      }
      if (t.phase !== "TRACKING_RECLAIM") continue;
      if (feature.price < finite(t.retestLowPrice, feature.price) - 1e-9) t.retestLowPrice = round(feature.price, 8);
      const low = finite(t.retestLowPrice, feature.price);
      const lowStopBufferPct = low > sh.stopPrice ? percentageBelow(low, sh.stopPrice) : 0;
      if (low <= sh.stopPrice + 1e-9 || lowStopBufferPct + 1e-9 < CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_LOW_ABOVE_STOP_PCT) { sh.status = "DONE"; sh.resolutionReason = "LOW_TOO_CLOSE_TO_STOP"; dirty = true; continue; }
      t.reclaimTargetPrice = round(low * (1 + CFG.BREAKOUT_RETEST_RECLAIM_ZONE_RECLAIM_PCT / 100), 8);
      t.maxEntryPrice = round(rangeHigh * (1 + CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MAX_ENTRY_ABOVE_HIGH_PCT / 100), 8);
      if (feature.price + 1e-9 < t.reclaimTargetPrice) { dirty = true; continue; }
      if (feature.price > t.maxEntryPrice + 1e-9) { sh.status = "DONE"; sh.resolutionReason = "RECOVERY_CHASE_TOO_LARGE"; dirty = true; continue; }
      if (!shadowBreakoutTickRecoveryOk(feature)) { dirty = true; continue; }
      sh.candidate = { entryPrice: round(feature.price, 8), candidateAt: nowIso(), candidateAtMs: current, performanceEndsAtMs: current + CFG.BREAKOUT_RETEST_POST_EXPIRY_SHADOW_PERFORMANCE_SEC * 1000, peakPrice: round(feature.price, 8), lowPrice: round(feature.price, 8), mfePct: 0, maePct: 0, latestPnlPct: 0 };
      sh.status = "CANDIDATE_TRACKING";
      dirty = true;
      log("INFO", "FVVO_BREAKOUT_RETEST_POST_EXPIRY_SHADOW_CANDIDATE", { shadowId: sh.id, sourceTriggerId: sh.sourceTriggerId, breakoutConfirmPrice, retestRangeLow: rangeLow, retestRangeHigh: rangeHigh, retestLowPrice: low, reclaimTargetPrice: t.reclaimTargetPrice, maxEntryPrice: t.maxEntryPrice, candidateEntryPrice: feature.price, stopPrice: sh.stopPrice, fvvo: feature.fvvo, slope: feature.slope, rayRegime: feature.rayRegime, automaticOrderSent: false });
    }
  }
  const before = state.audit.breakoutPostExpiryShadows.length;
  state.audit.breakoutPostExpiryShadows = list.filter((x) => x.status !== "DONE").slice(-4);
  if (dirty || state.audit.breakoutPostExpiryShadows.length !== before) await persistState("breakout_retest_post_expiry_shadow_update");
}

async function evaluatePriceTriggerEntry(feature) {
  const run = async () => {
    if (!CFG.PRICE_ENTRY_ENABLED || !isPriceTriggerFeature(feature) || !Number.isFinite(feature.price) || feature.price <= 0) return;
    const pendings = activePriceEntryItems().slice().sort((a, b) => {
      if (a.entryCampaign && b.entryCampaign && a.entryCampaign === b.entryCampaign) {
        const ao = Math.floor(finite(a.campaignOrdinal, 0));
        const bo = Math.floor(finite(b.campaignOrdinal, 0));
        if (ao !== bo) return ao - bo;
      }
      return finite(a.armedAtMs, 0) - finite(b.armedAtMs, 0);
    });
    if (!pendings.length) return;
    const current = nowMs();
    for (const pending of pendings) {
      if (!pending || state.position) break;
      const expiresAtMs = finite(pending.expiresAtMs, 0);
      const remainingSec = expiresAtMs > 0 ? (expiresAtMs - current) / 1000 : null;
      if (!pending.expiryWarningLogged && CFG.PRICE_TRIGGER_EXPIRY_WARNING_SEC > 0 && Number.isFinite(remainingSec) && remainingSec > 0 && remainingSec <= CFG.PRICE_TRIGGER_EXPIRY_WARNING_SEC) {
        pending.expiryWarningLogged = true;
        pending.expiryWarningAt = nowIso();
        await persistState("price_trigger_expiry_warning");
        log("WARN", "FVVO_PRICE_TRIGGER_EXPIRY_SOON", { triggerId: pending.id, entryCampaign: pending.entryCampaign || null, entryRole: pending.entryRole || "standalone", triggerMode: pending.triggerMode, triggerPrice: pending.triggerPrice, breakoutConfirmPrice: pending.breakoutConfirmPrice || null, expiresAt: pending.expiresAt, remainingSec: round(remainingSec, 3), action: "REAL_TRIGGER_WILL_EXPIRE_HARD" });
      }
      if (current > expiresAtMs) {
        if (isBreakoutRetestReclaimZone(pending)) await armBreakoutPostExpiryShadow(pending);
        const expired = resolvePriceEntryPending("EXPIRED", "EXPIRY_REACHED", { lastObservedPrice: pending.lastObservedPrice, lastObservedAt: pending.lastObservedAt }, pending);
        await persistState("price_trigger_expired");
        if (expired) {
          log("WARN", "FVVO_PRICE_TRIGGER_EXPIRED", { triggerId: expired.id, entryCampaign: expired.entryCampaign || null, entryRole: expired.entryRole || "standalone", triggerMode: expired.triggerMode, triggerPrice: expired.triggerPrice, expiresAt: expired.expiresAt, postExpiryShadowArmed: Boolean(CFG.BREAKOUT_RETEST_POST_EXPIRY_SHADOW_ENABLED && isBreakoutRetestReclaimZone(expired)) });
          if (expired.entryCampaign) log("WARN", "FVVO_CAMPAIGN_ENTRY_SETUP_EXPIRED", { entryCampaign: expired.entryCampaign, entryRole: expired.entryRole, triggerId: expired.id, triggerMode: expired.triggerMode, remainingCampaignSetups: activePriceEntryItems().filter((item) => item.entryCampaign === expired.entryCampaign).length, postExpiryShadowArmed: Boolean(CFG.BREAKOUT_RETEST_POST_EXPIRY_SHADOW_ENABLED && isBreakoutRetestReclaimZone(expired)) });
        }
        continue;
      }
      if (state.position || state.externalDealLock?.active || state.manual?.handoffActive || state.manual?.recoveryRequired) {
        const cancelled = resolvePriceEntryPending("CANCELLED", "STATE_BECAME_INELIGIBLE", { stateBlock: stateBlocksNewEntry() || "MANAGED_STATE" }, pending);
        await persistState("price_trigger_cancelled_ineligible_state");
        if (cancelled) log("WARN", "FVVO_PRICE_TRIGGER_CANCELLED", { triggerId: cancelled.id, reason: cancelled.resolutionReason, stateBlock: cancelled.stateBlock });
        continue;
      }
      const previousPrice = finite(pending.lastObservedPrice, pending.armedReferencePrice);
      pending.lastObservedPrice = round(feature.price, 8);
      pending.lastObservedAt = feature.receivedAt;
      pending.lastObservedAtMs = feature.receivedAtMs;
      if (isTrailingDipReclaim(pending)) {
        await evaluateTrailingDipReclaim(pending, previousPrice, feature);
        continue;
      }
      if (isTrailingDipReclaimZone(pending)) {
        await evaluateTrailingDipReclaimZone(pending, previousPrice, feature);
        continue;
      }
      if (isConfirmedPullbackReclaimZone(pending)) {
        await evaluateConfirmedPullbackReclaimZone(pending, previousPrice, feature);
        continue;
      }
      if (isHybridPullbackReclaimZone(pending)) {
        await evaluateHybridPullbackReclaimZone(pending, previousPrice, feature);
        continue;
      }
      if (isBreakoutRetestReclaimZone(pending)) {
        await evaluateBreakoutRetestReclaimZone(pending, previousPrice, feature);
        continue;
      }
      const crossed = CFG.PRICE_ENTRY_REQUIRE_ACTUAL_CROSS ? priceTriggerCrossed(pending, previousPrice, feature.price) : (pending.triggerMode === "dip" ? feature.price <= pending.triggerPrice : feature.price >= pending.triggerPrice);
      if (!crossed) { await persistState("price_trigger_watch"); continue; }
      await enterFromPriceTrigger(pending, feature, "PRICE_CROSS_CONFIRMED");
      break;
    }
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
  return result.ok ? { status: 200, body: { ok: true, accepted: true, requestId: result.requestId, c3Timestamp: result.c3Timestamp, triggerPrice: result.triggerPrice, exitUnverified: result.exitUnverified, autoReleasePending: Boolean(result.autoReleasePending), status: statusPayload() } } : { status: 502, body: { ok: false, error: result.error, requestId: result.requestId, status: statusPayload() } };
}

async function confirmExitClosed(body) {
  if (!CFG.MANUAL_ALLOW_CONFIRM_EXIT) return { status: 403, body: { ok: false, error: "MANUAL_CONFIRM_EXIT_DISABLED" } };
  if (!state.position || !String(state.position.lifecycle || "").startsWith("EXIT_")) return { status: 409, body: { ok: false, error: "NO_EXIT_RECONCILIATION_PENDING" } };
  if (CFG.MANUAL_CLEAR_REQUIRES_CONFIRM_FLAT && body.confirm_flat !== true) return { status: 400, body: { ok: false, error: "CONFIRM_FLAT_TRUE_REQUIRED" } };
  const prior = state.position;
  clearAutoExitReleaseTimer();
  state.position = null;
  state.externalDealLock = { active: false, source: "", setAt: "", reason: "" };
  state.autoExitRelease = { ...(state.autoExitRelease || {}), active: false, status: "MANUALLY_CONFIRMED", releasedAt: nowIso() };
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
  clearAutoExitReleaseTimer();
  state.position = null;
  state.externalDealLock = { active: false, source: "", setAt: "", reason: "" };
  state.autoExitRelease = { ...(state.autoExitRelease || {}), active: false, status: "FORCE_CLEARED", releasedAt: nowIso() };
  state.reentry = { campaign: null, recentTickPrices: [] };
  state.manual = { ...state.manual, entryConfirmation: null };
  for (const item of activePriceEntryItems()) resolvePriceEntryPending("CANCELLED_BY_FORCE_CLEAR", "FORCE_CLEAR_VERIFIED_FLAT", {}, item);
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
  if (action === "confirm_manual_entry") return confirmManualEntry(body);
  if (action === "confirm_entry_fill") return confirmEntryFill(body);
  if (action === "cancel_manual_entry_confirmation") return cancelManualEntryConfirmation(body);
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

async function processFeatureEvent(feature) {
  if (!Number.isFinite(feature.price) || feature.price <= 0) return { ok: false, error: "VALID_PRICE_REQUIRED" };
  const timeGuard = featureTimeGuard(feature);
  if (!timeGuard.ok) {
    log("WARN", "FVVO_STALE_FEATURE_IGNORED", { event: feature.kind, price: feature.price, barTimeMs: feature.barTimeMs, reason: timeGuard.reason, priorBarTimeMs: timeGuard.priorBarTime, positionLifecycle: state.position?.lifecycle || null, action: "NO_STATE_OR_TRADE_CHANGE" });
    return { ok: true, ignored: true, reason: timeGuard.reason, event: feature.kind };
  }
  if (!updateFeature(feature)) return { ok: false, error: "VALID_PRICE_REQUIRED" };
  const eventName = feature.kind === CFG.FVVO_FEATURE_5M_EVENT ? "FVVO_FEATURE_5M_RECEIVED" : feature.kind === CFG.FVVO_FAST_TICK_EVENT ? "FVVO_FAST_TICK_RECEIVED" : "FVVO_FEATURE_TICK_RECEIVED";
  log("INFO", eventName, { event: feature.kind, price: feature.price, ema8: feature.ema8, ema18: feature.ema18, rsi: feature.rsi, adx: feature.adx, fvvo: feature.fvvo, slope: feature.slope, crossUp: feature.crossUp, crossDown: feature.crossDown, redPulse: feature.redPulse, yellowPulse: feature.yellowPulse, yellowReason: feature.yellowReason || null, rayRegime: feature.rayRegime, publisherKind: feature.publisherKind, chartTimeframe: feature.chartTimeframe, barTimeMs: feature.barTimeMs, positionLifecycle: state.position?.lifecycle || null, phase: state.position?.phase || null, reentryPhase: state.reentry?.campaign?.phase || null, priceTriggerState: activePriceEntryItems().length ? `${activePriceEntryItems().length}_ARMED` : null, handoffActive: Boolean(state.manual?.handoffActive), runnerHoldActive: Boolean(state.position?.dynamicProfit?.runner?.holdActive), runnerTightTrailArmed: Boolean(state.position?.dynamicProfit?.runner?.tightTrailArmed), brainExitManagementActive: Boolean(state.position && !state.manual?.handoffActive && !String(state.position.lifecycle || "").startsWith("EXIT_")), reconciliationRequired: Boolean(state.manual?.recoveryRequired) });
  await capturePreReleaseReentryPullback(feature);
  await finalizeAutoExitRelease("feature");
  await evaluateRunnerRescuePostExitAudit(feature);
  evaluateYellowTpShadow(feature);
  await evaluateProfitFloorShadowObservers(feature);
  await manageExit(feature);
  await evaluateBreakoutPostExpiryShadow(feature);
  await evaluatePriceTriggerEntry(feature);
  await evaluateReentryShadow(feature);
  return { ok: true, event: feature.kind };
}

app.post(CFG.WEBHOOK_PATH, async (req, res) => {
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  if (!authenticate(CFG.WEBHOOK_SECRET, payload.secret)) return res.status(401).json({ ok: false, error: "BAD_WEBHOOK_SECRET" });
  if (payload.symbol && cleanSymbol(payload.symbol) !== cleanSymbol(CFG.SYMBOL)) return res.status(400).json({ ok: false, error: "SYMBOL_NOT_ALLOWED" });
  const feature = normalizeFeature(payload);
  if (![CFG.FVVO_FEATURE_TICK_EVENT, CFG.FVVO_FEATURE_5M_EVENT, CFG.FVVO_FAST_TICK_EVENT].includes(feature.kind)) return res.status(202).json({ ok: false, error: "UNSUPPORTED_EVENT", event: feature.kind || null });
  try {
    const result = await processFeatureEvent(feature);
    return res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    log("ERROR", "FVVO_MANAGEMENT_FAILED", { error: error.message, event: feature.kind });
    return res.status(500).json({ ok: false, error: "MANAGEMENT_FAILED" });
  }
});

app.post(CFG.MANUAL_WEBHOOK_PATH, async (req, res) => {
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  try {
    const result = await handleManual(payload);
    if (Number(result.status || 500) >= 400) log("WARN", "FVVO_MANUAL_COMMAND_REJECTED", { action: String(payload.action || "").trim().toLowerCase() || null, symbol: cleanSymbol(payload.symbol || CFG.SYMBOL), status: result.status, error: result.body?.error || "UNKNOWN", activePendingCount: activePriceEntryItems().length, positionLifecycle: state.position?.lifecycle || null });
    return res.status(result.status).json(result.body);
  }
  catch (error) { log("ERROR", "FVVO_MANUAL_HANDLER_FAILED", { action: String(payload.action || "").trim().toLowerCase() || null, error: error.message }); return res.status(500).json({ ok: false, error: "MANUAL_HANDLER_FAILED" }); }
});

async function start() {
  await ensurePersistence();
  await loadState();
  const problems = configProblems();
  if (!problems.length && state.autoExitRelease?.active) scheduleAutoExitRelease();
  const legacyEntryVars = legacyEntrySizingVariablesPresent();
  if (legacyEntryVars.length) log("WARN", "C3_LEGACY_ENTRY_SIZE_VARIABLES_IGNORED", { variables: legacyEntryVars, requiredEntrySizeSource: "bot_fixed" });

  try {
    const c3MarketAudit = c3MarketFromConfiguredSymbol(CFG.SYMBOL);
    const botUuid = getBotUuid();
    log("INFO", "C3_SYMBOL_ROUTE_AUDIT", {
      symbol: CFG.SYMBOL,
      tvExchange: c3MarketAudit.tvExchange,
      tvInstrument: c3MarketAudit.tvInstrument,
      botUuidSuffix: botUuid ? String(botUuid).slice(-8) : null,
    });
  } catch (error) {
    log("ERROR", "C3_SYMBOL_ROUTE_INVALID", {
      symbol: CFG.SYMBOL,
      error: error.message,
    });
  }

  log("INFO", "FVVO_MANUAL_DYNAMIC_PROFIT_STARTUP", { port: CFG.PORT, webhookPath: CFG.WEBHOOK_PATH, manualPath: CFG.MANUAL_WEBHOOK_PATH, symbol: CFG.SYMBOL, executionMode: CFG.EXECUTION_MODE,
    demoOnly: demoMode(), httpForwardAllowed: isForwardAllowed(), c3DryRun: CFG.C3_DRY_RUN, estimatedRoundTripCostPct: CFG.PNL_ESTIMATED_ROUND_TRIP_COST_PCT, automaticEntriesEnabled: reentryAutoEnabled(), priceTriggerEntryEnabled: CFG.PRICE_ENTRY_ENABLED, priceTriggerEntryAutoOrderOnCross: CFG.PRICE_ENTRY_ENABLED, autoExitReconciliationEnabled: autoExitReconciliationActive(), autoExitReconciliationDelaySec: CFG.AUTO_EXIT_RECONCILIATION_DELAY_SEC, reentryPhase: CFG.REENTRY_PHASE, reentryAutomaticOrdersEnabled: reentryAutoEnabled(), reentryEnabled: CFG.REENTRY_ENABLED, reentryMaxCount: CFG.REENTRY_MAX_COUNT, allowedProfile: PROFILE, swingStructureExitMode: swingStructureExitMode(), swingHardMaxHoldSec: CFG.SWING_HARD_MAX_HOLD_SEC, swingNoProgressCheckAfterSec: CFG.SWING_NO_PROGRESS_CHECK_AFTER_SEC, swingEmergencyFastConfirmMode: CFG.SWING_EMERGENCY_FAST_CONFIRM_MODE, swingEmergencyFastConfirmMaxSec: CFG.SWING_EMERGENCY_FAST_CONFIRM_MAX_SEC, swingEmergencyMicroWindowTicks: CFG.SWING_EMERGENCY_MICRO_WINDOW_TICKS, swingEmergencyMicroRequiredBelowTicks: CFG.SWING_EMERGENCY_MICRO_REQUIRED_BELOW_TICKS, swingEmergencyMicroConfirmObservations: CFG.SWING_EMERGENCY_MICRO_CONFIRM_OBSERVATIONS, swingEmergencyMicroMinAvgDeclinePct: CFG.SWING_EMERGENCY_MICRO_MIN_AVG_DECLINE_PCT, swingEmergencyMicroMinBearSignals: CFG.SWING_EMERGENCY_MICRO_MIN_BEAR_SIGNALS, swingEmergencyHardBreakBufferPct: CFG.SWING_EMERGENCY_HARD_BREAK_BUFFER_PCT, swingEmergencyHardExitPnlPct: CFG.SWING_EMERGENCY_HARD_EXIT_PNL_PCT, swingEmergencyProfitHardBreakConfirmObservations: CFG.SWING_EMERGENCY_PROFIT_HARD_BREAK_CONFIRM_OBSERVATIONS, swingEmergencyProfitHardBreakMinSpanSec: CFG.SWING_EMERGENCY_PROFIT_HARD_BREAK_MIN_SPAN_SEC, swingEmergencyRecoveryCancelMinSignals: CFG.SWING_EMERGENCY_RECOVERY_CANCEL_MIN_SIGNALS, swingEmergencyRecoveryRequirePriceRising: CFG.SWING_EMERGENCY_RECOVERY_REQUIRE_PRICE_RISING, swingEmergencyRecoveryReclaimBufferPct: CFG.SWING_EMERGENCY_RECOVERY_RECLAIM_BUFFER_PCT, swingEmergencyRecoveryConfirmObservations: CFG.SWING_EMERGENCY_RECOVERY_CONFIRM_OBSERVATIONS, swingEmergencyShadowIntelligent1mEnabled: CFG.SWING_EMERGENCY_SHADOW_INTELLIGENT_1M_ENABLED, swingEmergencyShadowLegacyImmediateEnabled: CFG.SWING_EMERGENCY_SHADOW_LEGACY_IMMEDIATE_ENABLED, profitFloorMicroShadowEnabled: CFG.PROFIT_FLOOR_MICRO_SHADOW_ENABLED, profitFloorMicroShadowWindowTicks: CFG.PROFIT_FLOOR_MICRO_SHADOW_WINDOW_TICKS, profitFloorMicroShadowRequiredBelowTicks: CFG.PROFIT_FLOOR_MICRO_SHADOW_REQUIRED_BELOW_TICKS, profitFloorMicroShadowMaxSec: CFG.PROFIT_FLOOR_MICRO_SHADOW_MAX_SEC, profitFloorPostExitReclaimShadowEnabled: CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_SHADOW_ENABLED, profitFloorPostExitReclaimWindowSec: CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_WINDOW_SEC, profitFloorPostExitReclaimPerformanceSec: CFG.PROFIT_FLOOR_POST_EXIT_RECLAIM_PERFORMANCE_SEC, featureMonotonicGuardEnabled: CFG.FEATURE_MONOTONIC_GUARD_ENABLED, featureDuplicateBarGuardEnabled: CFG.FEATURE_DUPLICATE_BAR_GUARD_ENABLED, manualLevelMode: "ONE_ABSOLUTE_STOP_PRICE", entrySizeSource: CFG.C3_ENTRY_SIZE_SOURCE, entryOrderIncludedInWebhook: false, requiredBotEntryOrder: "fixed quote amount + Market", exitOwnership: "BRAIN_ONLY", nativeStopAttachedToEntry: CFG.C3_NATIVE_STOP_ENABLED, minStopDistancePct: CFG.MANUAL_ONE_STOP_MIN_STOP_DISTANCE_PCT, maxStopDistancePct: CFG.MANUAL_ONE_STOP_MAX_STOP_DISTANCE_PCT, maxTargetDistancePct: CFG.MANUAL_ONE_STOP_MAX_TARGET_DISTANCE_PCT, priceStep: CFG.MANUAL_ONE_STOP_PRICE_STEP, stopExitPercent: 100, targetExitPercent: 100, tickConfirmSec: CFG.MANUAL_ONE_STOP_TICK_CONFIRM_SEC, tickConfirmObservations: CFG.MANUAL_ONE_STOP_TICK_CONFIRM_OBSERVATIONS, fiveMinuteCloseImmediate: CFG.MANUAL_ONE_STOP_5M_CLOSE_IMMEDIATE, dynamicProfitEnabled: CFG.DYNAMIC_PROFIT_EXIT_ENABLED, dynamicProfitArmMfePct: CFG.DYNAMIC_PROFIT_ARM_MFE_PCT, dynamicProfitMinLockPnlPct: CFG.DYNAMIC_PROFIT_MIN_LOCK_PNL_PCT, dynamicProfitTrailGivebackStartPct: CFG.DYNAMIC_PROFIT_TRAIL_GIVEBACK_START_PCT, dynamicProfitTrailGivebackMinPct: CFG.DYNAMIC_PROFIT_TRAIL_GIVEBACK_MIN_PCT, dynamicProfitTrailTightenPer1Pct: CFG.DYNAMIC_PROFIT_TRAIL_TIGHTEN_PER_1PCT, dynamicProfitThesisTickConfirmObservations: CFG.DYNAMIC_PROFIT_THESIS_TICK_CONFIRM_OBSERVATIONS, dynamicProfit5mThesisEnabled: CFG.DYNAMIC_PROFIT_5M_THESIS_EXIT_ENABLED, lossSideThesisFailMode: lossSideThesisFailMode(), lossSideThesisFailMinLossPct: CFG.LOSS_SIDE_THESIS_FAIL_MIN_LOSS_PCT, lossSideThesisFailMaxRsi: CFG.LOSS_SIDE_THESIS_FAIL_MAX_RSI, lossSideThesisFailMinAdx: CFG.LOSS_SIDE_THESIS_FAIL_MIN_ADX, lossSideThesisFailMaxFvvo: CFG.LOSS_SIDE_THESIS_FAIL_MAX_FVVO, lossSideThesisFailConfirmObservations: CFG.LOSS_SIDE_THESIS_FAIL_CONFIRM_OBSERVATIONS, dynamicPullbackGraceMode: dynamicPullbackGraceMode(), dynamicPullbackGraceMinMfePct: CFG.DYNAMIC_PULLBACK_GRACE_MIN_MFE_PCT, dynamicPullbackGraceMinPnlPct: CFG.DYNAMIC_PULLBACK_GRACE_MIN_PNL_PCT, dynamicPullbackGraceMaxSec: CFG.DYNAMIC_PULLBACK_GRACE_MAX_SEC, dynamicPullbackGracePinkBreakConfirmObservations: CFG.DYNAMIC_PULLBACK_GRACE_PINK_BREAK_CONFIRM_OBSERVATIONS, runnerExitEnabled: CFG.RUNNER_EXIT_ENABLED, runnerExitMode: CFG.RUNNER_EXIT_MODE, runnerHoldMinMfePct: CFG.RUNNER_HOLD_MIN_MFE_PCT, runnerTightTrailArmMfePct: CFG.RUNNER_TIGHT_TRAIL_ARM_MFE_PCT, runnerTightTrailGivebackPct: CFG.RUNNER_TIGHT_TRAIL_GIVEBACK_PCT, runnerTightTrailConfirmObservations: CFG.RUNNER_TIGHT_TRAIL_CONFIRM_OBSERVATIONS,
    manualEntryOverheatConfirmationEnabled: CFG.MANUAL_ENTRY_OVERHEAT_CONFIRMATION_ENABLED, manualEntryOverheatConfirmExpirySec: CFG.MANUAL_ENTRY_OVERHEAT_CONFIRM_EXPIRY_SEC, manualEntryOverheatMinSignals: CFG.MANUAL_ENTRY_OVERHEAT_MIN_SIGNALS,
    runnerContinuationRescueMode: runnerContinuationRescueMode(), runnerContinuationRescueMinMfePct: CFG.RUNNER_CONTINUATION_RESCUE_MIN_MFE_PCT, runnerContinuationRescueMinPnlPct: CFG.RUNNER_CONTINUATION_RESCUE_MIN_PNL_PCT, runnerContinuationRescueMaxSec: CFG.RUNNER_CONTINUATION_RESCUE_MAX_SEC, runnerContinuationRescueHardLockPnlPct: CFG.RUNNER_CONTINUATION_RESCUE_MIN_HARD_LOCK_PNL_PCT, runnerContinuationRescueFastTickProxyAuditEnabled: CFG.RUNNER_CONTINUATION_RESCUE_FAST_TICK_PROXY_AUDIT_ENABLED, runnerContinuationRescuePostExitAuditEnabled: CFG.RUNNER_CONTINUATION_RESCUE_POST_EXIT_AUDIT_ENABLED,
    reentryPullbackHysteresisAuditEnabled: CFG.REENTRY_PULLBACK_HYSTERESIS_AUDIT_ENABLED, reentryPullbackInvalidationHysteresisPct: CFG.REENTRY_PULLBACK_INVALIDATION_HYSTERESIS_PCT, reentryPullbackRearmAboveEma18Pct: CFG.REENTRY_PULLBACK_REARM_ABOVE_EMA18_PCT,
    reentryPreReleaseMemoryEnabled: CFG.REENTRY_PRE_RELEASE_MEMORY_ENABLED, reentryPreReleaseTickOverrideEnabled: CFG.REENTRY_PRE_RELEASE_TICK_OVERRIDE_ENABLED, reentryFastReclaimTickOverrideEnabled: CFG.REENTRY_FAST_RECLAIM_TICK_OVERRIDE_ENABLED, reentryFastReclaimOverrideMaxRsi: CFG.REENTRY_FAST_RECLAIM_OVERRIDE_MAX_RSI,
    reentry15sFastLaunchMode: CFG.REENTRY_15S_FAST_LAUNCH_MODE, reentry15sFastLaunchMinPriorImpulsePct: CFG.REENTRY_15S_FAST_LAUNCH_MIN_PRIOR_IMPULSE_PCT, reentry15sFastLaunchMinPullbackPct: CFG.REENTRY_15S_FAST_LAUNCH_MIN_PULLBACK_PCT, reentry15sFastLaunchMinRsi: CFG.REENTRY_15S_FAST_LAUNCH_MIN_RSI, reentry15sFastLaunchMinAdx: CFG.REENTRY_15S_FAST_LAUNCH_MIN_ADX, reentry15sFastLaunchMinFvvo: CFG.REENTRY_15S_FAST_LAUNCH_MIN_FVVO, reentry15sFastLaunchMinSlope: CFG.REENTRY_15S_FAST_LAUNCH_MIN_SLOPE,
    reentry15sEarlyTurnMode: CFG.REENTRY_15S_EARLY_TURN_MODE, reentry15sEarlyTurnMinPriorImpulsePct: CFG.REENTRY_15S_EARLY_TURN_MIN_PRIOR_IMPULSE_PCT, reentry15sEarlyTurnMinPullbackPct: CFG.REENTRY_15S_EARLY_TURN_MIN_PULLBACK_PCT, reentry15sEarlyTurnMinRsi: CFG.REENTRY_15S_EARLY_TURN_MIN_RSI, reentry15sEarlyTurnMinAdx: CFG.REENTRY_15S_EARLY_TURN_MIN_ADX, reentry15sEarlyTurnMinFvvo: CFG.REENTRY_15S_EARLY_TURN_MIN_FVVO, reentry15sEarlyTurnMinSlope: CFG.REENTRY_15S_EARLY_TURN_MIN_SLOPE,
    postExitRecoveredBaseMode: postExitRecoveredBaseMode(), postExitRecoveredBaseWindowSec: CFG.POST_EXIT_RECOVERED_BASE_WINDOW_SEC, postExitRecoveredBaseMinPriorImpulsePct: CFG.POST_EXIT_RECOVERED_BASE_MIN_PRIOR_IMPULSE_PCT, postExitRecoveredBaseMinRecoveryPct: CFG.POST_EXIT_RECOVERED_BASE_MIN_RECOVERY_PCT, postExitRecoveredBaseMaxChaseFromLowPct: CFG.POST_EXIT_RECOVERED_BASE_MAX_CHASE_FROM_LOW_PCT, postExitRecoveredBaseConfirmObservations: CFG.POST_EXIT_RECOVERED_BASE_CONFIRM_OBSERVATIONS, postExitRecoveredBaseMinRsi: CFG.POST_EXIT_RECOVERED_BASE_MIN_RSI, postExitRecoveredBaseMinAdx: CFG.POST_EXIT_RECOVERED_BASE_MIN_ADX, postExitRecoveredBaseMinFvvo: CFG.POST_EXIT_RECOVERED_BASE_MIN_FVVO, postExitRecoveredBaseMinSlope: CFG.POST_EXIT_RECOVERED_BASE_MIN_SLOPE,
    reentryCampaignMaxAgeSec: CFG.REENTRY_CAMPAIGN_MAX_AGE_SEC, reentryMaxBounceFromLowPct: CFG.REENTRY_MAX_BOUNCE_FROM_LOW_PCT, reentryContinuationGraceMode: reentryContinuationGraceMode(), reentryContinuationGraceMinMfePct: CFG.REENTRY_CONTINUATION_GRACE_MIN_MFE_PCT, reentryContinuationGraceMaxSec: CFG.REENTRY_CONTINUATION_GRACE_MAX_SEC, yellowTpShadowEnabled: CFG.YELLOW_TP_SHADOW_ENABLED, priceTriggerDefaultExpirySec: CFG.PRICE_ENTRY_DEFAULT_EXPIRY_SEC, priceTriggerMinDistancePct: CFG.PRICE_ENTRY_MIN_TRIGGER_DISTANCE_PCT, priceTriggerMaxDistancePct: CFG.PRICE_ENTRY_MAX_TRIGGER_DISTANCE_PCT, priceTriggerRequireActualCross: CFG.PRICE_ENTRY_REQUIRE_ACTUAL_CROSS, priceTriggerMaxPending: CFG.PRICE_ENTRY_MAX_PENDING, priceTriggerActivePendingCount: activePriceEntryItems().length, trailingDipReclaimMode: trailingDipReclaimMode(), trailingDipReclaimMinDropPct: CFG.TRAILING_DIP_RECLAIM_MIN_DROP_PCT, trailingDipReclaimReclaimPct: CFG.TRAILING_DIP_RECLAIM_RECLAIM_PCT, trailingDipReclaimMaxChasePct: CFG.TRAILING_DIP_RECLAIM_MAX_CHASE_PCT, trailingDipReclaimMaxTrackSec: CFG.TRAILING_DIP_RECLAIM_MAX_TRACK_SEC, trailingDipReclaimMinLowAboveStopPct: CFG.TRAILING_DIP_RECLAIM_MIN_LOW_ABOVE_STOP_PCT, trailingDipReclaimRequireTickRecovery: CFG.TRAILING_DIP_RECLAIM_REQUIRE_TICK_RECOVERY, trailingDipReclaimZoneMode: trailingDipReclaimZoneMode(), trailingDipReclaimZoneReclaimPct: CFG.TRAILING_DIP_RECLAIM_ZONE_RECLAIM_PCT, trailingDipReclaimZoneMaxEntryAboveHighPct: CFG.TRAILING_DIP_RECLAIM_ZONE_MAX_ENTRY_ABOVE_HIGH_PCT, trailingDipReclaimZoneMinPenetrationPct: CFG.TRAILING_DIP_RECLAIM_ZONE_MIN_PENETRATION_PCT, trailingDipReclaimZoneMaxTrackSec: CFG.TRAILING_DIP_RECLAIM_ZONE_MAX_TRACK_SEC, trailingDipReclaimZoneMinLowAboveStopPct: CFG.TRAILING_DIP_RECLAIM_ZONE_MIN_LOW_ABOVE_STOP_PCT, trailingDipReclaimZoneRequireTickRecovery: CFG.TRAILING_DIP_RECLAIM_ZONE_REQUIRE_TICK_RECOVERY, trailingDipReclaimZoneRequireRayNotBear: CFG.TRAILING_DIP_RECLAIM_ZONE_REQUIRE_RAY_NOT_BEAR, entry5mBearGuardMode: entry5mBearGuardMode(), entry5mBearGuardMaxAgeSec: CFG.ENTRY_5M_BEAR_GUARD_MAX_AGE_SEC, entry5mBearGuardMaxFvvo: CFG.ENTRY_5M_BEAR_GUARD_MAX_FVVO, entry5mBearGuardRequireRayBear: CFG.ENTRY_5M_BEAR_GUARD_REQUIRE_RAY_BEAR, entry5mBearGuardApplyPreferred: CFG.ENTRY_5M_BEAR_GUARD_APPLY_PREFERRED, entry5mBearGuardApplyDeep: CFG.ENTRY_5M_BEAR_GUARD_APPLY_DEEP, entry5mBearGuardReleaseReference: CFG.ENTRY_5M_BEAR_GUARD_RELEASE_REFERENCE, entry5mBearGuardReleaseStructureTolerancePct: CFG.ENTRY_5M_BEAR_GUARD_RELEASE_STRUCTURE_TOLERANCE_PCT, entry5mBearGuardReleaseMinFvvo: CFG.ENTRY_5M_BEAR_GUARD_RELEASE_MIN_FVVO, entry5mBearGuardReleaseMinSlope: CFG.ENTRY_5M_BEAR_GUARD_RELEASE_MIN_SLOPE, entry5mBearGuardReleaseRequireRayNotBear: CFG.ENTRY_5M_BEAR_GUARD_RELEASE_REQUIRE_RAY_NOT_BEAR, entry5mBearGuardReleaseConfirmObservations: CFG.ENTRY_5M_BEAR_GUARD_RELEASE_CONFIRM_OBSERVATIONS, breakoutRetestReclaimZoneMode: breakoutRetestReclaimZoneMode(), breakoutRetestReclaimZoneReclaimPct: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_RECLAIM_PCT, breakoutRetestReclaimZoneMaxEntryAboveHighPct: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MAX_ENTRY_ABOVE_HIGH_PCT, breakoutRetestReclaimZoneMinRetestPenetrationPct: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_RETEST_PENETRATION_PCT, breakoutRetestReclaimZoneConfirmBufferPct: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRM_BUFFER_PCT, breakoutRetestReclaimZoneConfirmObservations: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_CONFIRM_OBSERVATIONS, breakoutRetestAdaptiveConfirmEnabled: CFG.BREAKOUT_RETEST_ADAPTIVE_CONFIRM_ENABLED, breakoutRetestAdaptiveHoldTolerancePct: CFG.BREAKOUT_RETEST_ADAPTIVE_HOLD_TOLERANCE_PCT, breakoutRetestAdaptiveHoldMaxSec: CFG.BREAKOUT_RETEST_ADAPTIVE_HOLD_MAX_SEC, breakoutRetestReclaimZoneMinTickSlope: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_TICK_SLOPE, breakoutRetestReclaimZoneMinFvvo: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MIN_FVVO, priceTriggerExpiryWarningSec: CFG.PRICE_TRIGGER_EXPIRY_WARNING_SEC, breakoutRetestPostExpiryShadowEnabled: CFG.BREAKOUT_RETEST_POST_EXPIRY_SHADOW_ENABLED, breakoutRetestPostExpiryShadowSec: CFG.BREAKOUT_RETEST_POST_EXPIRY_SHADOW_SEC, breakoutRetestPostExpiryShadowPerformanceSec: CFG.BREAKOUT_RETEST_POST_EXPIRY_SHADOW_PERFORMANCE_SEC, breakoutRetestReclaimZoneFailBelowLowBufferPct: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_FAIL_BELOW_LOW_BUFFER_PCT, breakoutRetestReclaimZoneMaxTrackSec: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_MAX_TRACK_SEC, breakoutRetestReclaimZoneRequireTickRecovery: CFG.BREAKOUT_RETEST_RECLAIM_ZONE_REQUIRE_TICK_RECOVERY, breakoutShallowHoldReclaimMode: breakoutShallowHoldReclaimMode(), breakoutShallowHoldMaxTrackSec: CFG.BREAKOUT_SHALLOW_HOLD_MAX_TRACK_SEC, breakoutShallowHoldMaxAboveConfirmPct: CFG.BREAKOUT_SHALLOW_HOLD_MAX_ABOVE_CONFIRM_PCT, breakoutShallowHoldMinPullbackFromHighPct: CFG.BREAKOUT_SHALLOW_HOLD_MIN_PULLBACK_FROM_HIGH_PCT, breakoutShallowHoldMinObservations: CFG.BREAKOUT_SHALLOW_HOLD_MIN_OBSERVATIONS, breakoutShallowHoldReclaimPct: CFG.BREAKOUT_SHALLOW_HOLD_RECLAIM_PCT, breakoutShallowHoldMaxEntryAboveConfirmPct: CFG.BREAKOUT_SHALLOW_HOLD_MAX_ENTRY_ABOVE_CONFIRM_PCT, breakoutShallowHoldMinAdx: CFG.BREAKOUT_SHALLOW_HOLD_MIN_ADX, breakoutShallowHoldMinFvvo: CFG.BREAKOUT_SHALLOW_HOLD_MIN_FVVO, breakoutShallowHoldMinSlope: CFG.BREAKOUT_SHALLOW_HOLD_MIN_SLOPE, persistenceReady, configurationProblems: problems });
  log("INFO", "FVVO_HYBRID_PULLBACK_STARTUP", { mode: CFG.HYBRID_PULLBACK_FAST_PATH_MODE, preferredVotes: `${CFG.HYBRID_PULLBACK_PREFERRED_VOTES_REQUIRED}/${CFG.HYBRID_PULLBACK_PREFERRED_VOTE_COUNT}`, preferredFinalConsecutive: CFG.HYBRID_PULLBACK_PREFERRED_FINAL_CONSECUTIVE, preferredMinSpanSec: CFG.HYBRID_PULLBACK_PREFERRED_MIN_SPAN_SEC, deepVotes: `${CFG.HYBRID_PULLBACK_DEEP_VOTES_REQUIRED}/${CFG.HYBRID_PULLBACK_DEEP_VOTE_COUNT}`, deepFinalConsecutive: CFG.HYBRID_PULLBACK_DEEP_FINAL_CONSECUTIVE, deepMinSpanSec: CFG.HYBRID_PULLBACK_DEEP_MIN_SPAN_SEC, fallback5mEnabled: CFG.HYBRID_PULLBACK_FALLBACK_5M_ENABLED, chasePolicy: "wait_no_chase", configurationProblems: problems });
  log("INFO", "FVVO_BREAKOUT_BULL_CONTINUATION_STARTUP", { mode: breakoutBullContinuationMode(), maxTrackSec: CFG.BREAKOUT_BULL_CONTINUATION_MAX_TRACK_SEC, minPeakExtensionPct: CFG.BREAKOUT_BULL_CONTINUATION_MIN_PEAK_EXTENSION_PCT, maxPeakExtensionPct: CFG.BREAKOUT_BULL_CONTINUATION_MAX_PEAK_EXTENSION_PCT, minAdx: CFG.BREAKOUT_BULL_CONTINUATION_MIN_ADX, maxEntryAboveConfirmPct: CFG.BREAKOUT_BULL_CONTINUATION_MAX_ENTRY_ABOVE_CONFIRM_PCT, configurationProblems: problems });
  app.listen(CFG.PORT, () => log("INFO", "FVVO_LISTENING", { port: CFG.PORT }));
}

if (require.main === module) start().catch((error) => { log("ERROR", "FVVO_STARTUP_FATAL", { error: error.message }); process.exit(1); });

module.exports = { app, CFG, c3MarketFromConfiguredSymbol, pnlAudit, confirmEntryFill, ensurePersistence, loadState, configProblems, buildC3Signal, normalizeFeature, processFeatureEvent, capturePreReleaseReentryPullback, evaluateYellowTpShadow, setTestNowMs, resetStateForTest, snapshotStateForTest, injectTrackedPositionForTest, validateOneStopCommand, normalizeState, defaultState, dynamicProfitFloorPnlPct, dynamicFloorBreakConfirmed, tickThesisFailureConfirmed, tickThesisEvidence, fiveMinuteThesisFailure, dynamicPullbackGraceMode, dynamicPullbackGraceContext, dynamicPullbackGraceEligible, evaluateDynamicPullbackGrace, runnerContinuationRescueMode, runnerContinuationRescueContext, runnerContinuationRescueFastTickProxyContext, runnerContinuationRescueEligible, evaluateRunnerContinuationRescue, evaluateRunnerRescuePostExitAudit, manualEntryOverheatSignalSnapshot, manualEntryConfirmationPublicPayload, reentryContinuationGraceMode, reentryContinuationGraceContext, reentryContinuationGraceEligible, evaluateReentryContinuationGrace, updateRunnerExit, runnerTightTrailBreakConfirmed, runnerLiveEnabled, legacyEntrySizingVariablesPresent, evaluateReentryShadow, armReentryCampaignAfterConfirmedExit, projectReentryStop, reentry15sFastLaunchEligible, reentry15sEarlyTurnEligible, postExitRecoveredBaseMode, buildPostExitRecoveredBaseState, evaluatePostExitRecoveredBase, postExitRecoveredBaseCandidate, reentryAutoEnabled, autoExitReconciliationActive, executionModeValid, demoMode, liveMode, autoExitReleaseStatusPayload, finalizeAutoExitRelease, validatePriceTriggerCommand, validateStoredPriceTriggerAtExecution, priceTriggerCrossed, priceEntryStatusPayload, handleManual, armPriceEntry, evaluatePriceTriggerEntry, evaluateTrailingDipReclaim, evaluateTrailingDipReclaimZone, evaluateConfirmedPullbackReclaimZone, evaluateHybridPullbackReclaimZone, hybridPullbackVoteRules, hybridPullbackFastEvidence, hybridPullbackFallback5mContext, confirmedPullbackAligned15mContext, confirmedPullbackFastEvidence, reactivateDormantDeepFallback, evaluateBreakoutRetestReclaimZone, evaluateBreakoutBullContinuation, breakoutBullContinuationRecovery, adaptiveBreakoutHoldEligible, armBreakoutPostExpiryShadow, evaluateBreakoutPostExpiryShadow, trailingDipReclaimMode, trailingDipReclaimZoneMode, breakoutRetestReclaimZoneMode, breakoutShallowHoldReclaimMode, breakoutShallowHoldRecoveryOk, evaluateBreakoutShallowHoldReclaim, entry5mBearGuardMode, entry5mBearGuardApplies, entry5mStrongBearContext, entry5mFastReleaseEvidence, trailingTickRecoveryOk, trailingZoneTickRecoveryOk, breakoutRetestZoneTickRecoveryOk, lossSideThesisFailMode, lossSideThesisEvidence, lossSideThesisFailureConfirmed, swingStructureExitMode, swingDeteriorationEvidence, swingStructureExitDecision, swingExitState, armFastEmergency, evaluateFastEmergency, emergencyMicroEvaluation, featureBearSignals, featureTimeGuard, resetFastEmergency, normalizeSwingExitState, ensureProfitFloorShadowState, profitFloorShadowStatusPayload, armProfitFloorMicroShadow, profitFloorMicroEvaluation, evaluateProfitFloorMicroShadow, recordProfitFloorBaselineExit, postExitReclaimEvidence, evaluateProfitFloorPostExitReclaimShadow, evaluateProfitFloorShadowObservers };

Object.assign(module.exports, { buildPosition, buildIntelligentTpState, evaluateIntelligentTpShadow });

// ===== END SWING V1H ENGINE + C3 DYNAMIC-INSTRUMENT HOTFIX =====
} else {
  const express = require("express");
  const http = require("http");

  function envStr(name, fallback = "") {
    const v = process.env[name];
    return v === undefined || v === null || String(v).trim() === "" ? fallback : String(v).trim();
  }
  function envNum(name, fallback) {
    const n = Number(process.env[name]);
    return Number.isFinite(n) ? n : fallback;
  }
  function envBool(name, fallback = false) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
    return ["1", "true", "yes", "y", "on"].includes(String(raw).trim().toLowerCase());
  }
  function cleanSymbol(value) {
    return String(value || "")
      .trim()
      .toUpperCase()
      .replace(/^BINANCE:/, "")
      .replace(/[^A-Z0-9]/g, "");
  }
  function safeJson(value) {
    try { return JSON.parse(value); } catch { return null; }
  }
  function nowIso() { return new Date().toISOString(); }
  function slog(marker, event, payload = {}) {
    console.log(`${nowIso()} ${marker} ${event} | ${JSON.stringify(payload)}`);
  }

  const SUPERVISOR = {
    brain: envStr("MULTI_BRAIN_NAME", "BrainFVVO_Swing_MultiAsset_v1k_PROFITABLE_EMERGENCY_RECOVERY_LIVE_PAPER"),
    port: Math.max(1, Math.floor(envNum("PORT", 8080))),
    host: envStr("MULTI_BIND_HOST", "0.0.0.0"),
    webhookPath: envStr("WEBHOOK_PATH", "/webhook"),
    manualPath: envStr("MANUAL_WEBHOOK_PATH", "/manual"),
    internalBasePort: Math.max(10000, Math.floor(envNum("MULTI_INTERNAL_BASE_PORT", 18100))),
    workerRestartDelayMs: Math.max(250, Math.floor(envNum("MULTI_WORKER_RESTART_DELAY_MS", 1500))),
    workerReadyTimeoutMs: Math.max(2000, Math.floor(envNum("MULTI_WORKER_READY_TIMEOUT_MS", 20000))),
    requestTimeoutMs: Math.max(1000, Math.floor(envNum("MULTI_PROXY_TIMEOUT_MS", 15000))),
    requireSymbol: envBool("MULTI_REQUIRE_SYMBOL", true),
    assets: envStr("MULTI_ASSETS", "SOL,ETH,BNB,XRP")
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean),
  };

  const RESERVED_INHERITED = new Set([
    "PORT",
    "SYMBOL",
    "BRAIN_NAME",
    "STATE_FILE_NAME",
    "C3_BOT_UUID",
    "SYMBOL_BOT_MAP",
  ]);

  function buildWorkerSpec(alias, index) {
    const prefix = `${alias}_`;
    const childEnv = { ...process.env };

    // Prevent a previous single-symbol Railway deployment from leaking SOL-only
    // identity/bot/state settings into ETH or BNB.
    for (const key of RESERVED_INHERITED) delete childEnv[key];

    // Generic prefix mapper: ETH_X=y -> worker sees X=y.
    // This makes every current/future engine env independently configurable per asset
    // without changing the trading engine code.
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(prefix) && key.length > prefix.length) {
        childEnv[key.slice(prefix.length)] = value;
      }
    }

    const enabled = envBool(`${alias}_ENABLED`, true);
    const symbol = envStr(`${alias}_SYMBOL`, `BINANCE:${alias}USDT`).toUpperCase();
    const internalPort = Math.max(
      10000,
      Math.floor(envNum(`${alias}_INTERNAL_PORT`, SUPERVISOR.internalBasePort + index + 1))
    );

    // Worker identity/state must always be unique unless explicitly overridden.
    childEnv.PORT = String(internalPort);
    childEnv.SYMBOL = symbol;
    childEnv.BRAIN_NAME = envStr(
      `${alias}_BRAIN_NAME`,
      `BrainFVVO_Swing_MultiAsset_v1k_${alias}_PROFITABLE_EMERGENCY_RECOVERY_LIVE_PAPER`
    );
    childEnv.STATE_FILE_NAME = envStr(
      `${alias}_STATE_FILE_NAME`,
      `brainfvvo-swing-multi-${alias.toLowerCase()}-v1a-live-paper-state.json`
    );
    childEnv.SYMBOL_BOT_MAP = "{}";

    // Paper-execution-compatible defaults. Per-symbol prefixed variables can override.
    if (!process.env[`${alias}_EXECUTION_MODE`]) childEnv.EXECUTION_MODE = "live";
    if (!process.env[`${alias}_SHADOW_ONLY`]) childEnv.SHADOW_ONLY = "false";
    if (!process.env[`${alias}_ENABLE_HTTP_FORWARD`]) childEnv.ENABLE_HTTP_FORWARD = "true";
    if (!process.env[`${alias}_C3_DRY_RUN`]) childEnv.C3_DRY_RUN = "false";
    if (!process.env[`${alias}_AUTO_EXIT_RECONCILIATION_ENABLED`]) childEnv.AUTO_EXIT_RECONCILIATION_ENABLED = "true";

    // Alias-prefixed bot UUID is mandatory for clean one-symbol/one-bot isolation.
    // Do not inherit the old global C3_BOT_UUID.
    childEnv.C3_BOT_UUID = envStr(`${alias}_C3_BOT_UUID`, "");

    // Optional per-symbol Signal Bot secret. Falls back to common C3_SIGNAL_SECRET.
    if (process.env[`${alias}_C3_SIGNAL_SECRET`]) {
      childEnv.C3_SIGNAL_SECRET = process.env[`${alias}_C3_SIGNAL_SECRET`];
    }

    // Optional per-symbol inbound/manual secrets; common values remain valid fallback.
    if (process.env[`${alias}_WEBHOOK_SECRET`]) {
      childEnv.WEBHOOK_SECRET = process.env[`${alias}_WEBHOOK_SECRET`];
    }
    if (process.env[`${alias}_MANUAL_WEBHOOK_SECRET`]) {
      childEnv.MANUAL_WEBHOOK_SECRET = process.env[`${alias}_MANUAL_WEBHOOK_SECRET`];
    }

    return {
      alias,
      enabled,
      symbol,
      cleanSymbol: cleanSymbol(symbol),
      internalPort,
      webhookPath: childEnv.WEBHOOK_PATH || "/webhook",
      manualPath: childEnv.MANUAL_WEBHOOK_PATH || "/manual",
      brainName: childEnv.BRAIN_NAME,
      stateFileName: childEnv.STATE_FILE_NAME,
      env: childEnv,
    };
  }

  const specs = SUPERVISOR.assets
    .map((alias, index) => buildWorkerSpec(alias, index))
    .filter((x) => x.enabled);

  if (!specs.length) {
    console.error(`${nowIso()} ❌ FVVO_MULTI_STARTUP_FATAL | ${JSON.stringify({ error: "NO_ENABLED_ASSETS" })}`);
    process.exit(1);
  }

  const bySymbol = new Map();
  const byAlias = new Map();
  const runtime = new Map();
  for (const spec of specs) {
    if (bySymbol.has(spec.cleanSymbol)) {
      console.error(`${nowIso()} ❌ FVVO_MULTI_STARTUP_FATAL | ${JSON.stringify({ error: "DUPLICATE_SYMBOL", symbol: spec.symbol })}`);
      process.exit(1);
    }
    bySymbol.set(spec.cleanSymbol, spec);
    byAlias.set(spec.alias, spec);
    runtime.set(spec.alias, {
      spec,
      worker: null,
      ready: false,
      starting: false,
      stopped: false,
      restartCount: 0,
      lastExitCode: null,
      lastError: null,
      lastReadyAt: null,
    });
  }

  let shuttingDown = false;

  function httpJson({ method = "GET", port, path, body = null, timeoutMs = SUPERVISOR.requestTimeoutMs }) {
    return new Promise((resolve, reject) => {
      const payload = body === null ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: payload ? {
          "content-type": "application/json",
          "content-length": payload.length,
        } : {},
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: Number(res.statusCode || 500),
            text,
            json: safeJson(text),
            contentType: String(res.headers["content-type"] || "application/json"),
          });
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error("INTERNAL_WORKER_TIMEOUT")));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function waitUntilReady(rt) {
    const deadline = Date.now() + SUPERVISOR.workerReadyTimeoutMs;
    while (!shuttingDown && Date.now() < deadline && rt.worker) {
      try {
        const health = await httpJson({ port: rt.spec.internalPort, path: "/health", timeoutMs: 1000 });
        if (health.status === 200 && health.json?.ok) {
          rt.ready = true;
          rt.lastReadyAt = nowIso();
          slog("✅", "FVVO_MULTI_WORKER_READY", {
            alias: rt.spec.alias,
            symbol: rt.spec.symbol,
            brain: rt.spec.brainName,
            internalPort: rt.spec.internalPort,
            restartCount: rt.restartCount,
          });
          return true;
        }
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!shuttingDown) {
      rt.ready = false;
      rt.lastError = "WORKER_READY_TIMEOUT";
      slog("❌", "FVVO_MULTI_WORKER_READY_TIMEOUT", {
        alias: rt.spec.alias,
        symbol: rt.spec.symbol,
        internalPort: rt.spec.internalPort,
      });
    }
    return false;
  }

  function spawnWorker(rt) {
    if (shuttingDown || rt.starting) return;
    rt.starting = true;
    rt.ready = false;
    rt.lastError = null;

    const worker = new Worker(__filename, {
      workerData: {
        fvvoEngineWorker: true,
        alias: rt.spec.alias,
        symbol: rt.spec.symbol,
      },
      env: rt.spec.env,
    });
    rt.worker = worker;

    slog("🧠", "FVVO_MULTI_WORKER_SPAWNED", {
      alias: rt.spec.alias,
      symbol: rt.spec.symbol,
      brain: rt.spec.brainName,
      internalPort: rt.spec.internalPort,
      stateFileName: rt.spec.stateFileName,
    });

    worker.on("online", () => {
      rt.starting = false;
      waitUntilReady(rt).catch((error) => {
        rt.lastError = error.message;
      });
    });
    worker.on("error", (error) => {
      rt.lastError = error.message;
      slog("❌", "FVVO_MULTI_WORKER_ERROR", {
        alias: rt.spec.alias,
        symbol: rt.spec.symbol,
        error: error.message,
      });
    });
    worker.on("exit", (code) => {
      rt.ready = false;
      rt.starting = false;
      rt.worker = null;
      rt.lastExitCode = code;
      if (shuttingDown || rt.stopped) return;
      rt.restartCount += 1;
      slog("🔴", "FVVO_MULTI_WORKER_EXIT", {
        alias: rt.spec.alias,
        symbol: rt.spec.symbol,
        code,
        restartCount: rt.restartCount,
        restartDelayMs: SUPERVISOR.workerRestartDelayMs,
      });
      setTimeout(() => spawnWorker(rt), SUPERVISOR.workerRestartDelayMs);
    });
  }

  function resolveSpec(rawSymbol) {
    const cleaned = cleanSymbol(rawSymbol);
    if (!cleaned) return null;
    if (bySymbol.has(cleaned)) return bySymbol.get(cleaned);
    const alias = String(rawSymbol || "").trim().toUpperCase();
    if (byAlias.has(alias)) return byAlias.get(alias);
    return null;
  }

  async function proxyToWorker(spec, kind, payload) {
    const rt = runtime.get(spec.alias);
    if (!rt || !rt.ready) {
      return {
        status: 503,
        json: {
          ok: false,
          error: "SYMBOL_WORKER_NOT_READY",
          symbol: spec.symbol,
          alias: spec.alias,
        },
      };
    }
    const targetPath = kind === "manual" ? spec.manualPath : spec.webhookPath;
    try {
      const forwarded = { ...(payload || {}), symbol: spec.symbol };
      const result = await httpJson({
        method: "POST",
        port: spec.internalPort,
        path: targetPath,
        body: forwarded,
      });
      return {
        status: result.status,
        json: result.json || { ok: result.status >= 200 && result.status < 300, raw: result.text },
      };
    } catch (error) {
      const rt2 = runtime.get(spec.alias);
      if (rt2) rt2.lastError = error.message;
      slog("❌", "FVVO_MULTI_PROXY_FAILED", {
        kind,
        alias: spec.alias,
        symbol: spec.symbol,
        error: error.message,
      });
      return {
        status: 503,
        json: {
          ok: false,
          error: "SYMBOL_WORKER_PROXY_FAILED",
          symbol: spec.symbol,
          detail: error.message,
        },
      };
    }
  }

  async function workerHealth(spec) {
    const rt = runtime.get(spec.alias);
    const base = {
      alias: spec.alias,
      symbol: spec.symbol,
      brain: spec.brainName,
      ready: Boolean(rt?.ready),
      internalPort: spec.internalPort,
      stateFileName: spec.stateFileName,
      restartCount: Number(rt?.restartCount || 0),
      lastExitCode: rt?.lastExitCode ?? null,
      lastError: rt?.lastError || null,
      lastReadyAt: rt?.lastReadyAt || null,
    };
    if (!rt?.ready) return base;
    try {
      const result = await httpJson({ port: spec.internalPort, path: "/health", timeoutMs: 2500 });
      return { ...base, workerHealthStatus: result.status, worker: result.json || null };
    } catch (error) {
      return { ...base, ready: false, lastError: error.message };
    }
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb", strict: true }));

  app.get("/health", async (_req, res) => {
    const workers = await Promise.all(specs.map(workerHealth));
    const allReady = workers.every((x) => x.ready && x.workerHealthStatus === 200);
    return res.status(allReady ? 200 : 503).json({
      ok: allReady,
      brain: SUPERVISOR.brain,
      mode: "single_server_multi_symbol",
      externalPort: SUPERVISOR.port,
      symbols: specs.map((x) => x.symbol),
      workers,
    });
  });

  app.get("/health/:symbol", async (req, res) => {
    const spec = resolveSpec(req.params.symbol);
    if (!spec) return res.status(404).json({ ok: false, error: "SYMBOL_NOT_CONFIGURED" });
    const result = await workerHealth(spec);
    return res.status(result.ready && result.workerHealthStatus === 200 ? 200 : 503).json(result);
  });

  app.get("/routes", (_req, res) => {
    return res.status(200).json({
      ok: true,
      brain: SUPERVISOR.brain,
      webhookPath: SUPERVISOR.webhookPath,
      manualPath: SUPERVISOR.manualPath,
      routes: specs.map((x) => ({ alias: x.alias, symbol: x.symbol, brain: x.brainName })),
    });
  });

  app.post(SUPERVISOR.webhookPath, async (req, res) => {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const spec = resolveSpec(payload.symbol);
    if (!spec) {
      return res.status(400).json({
        ok: false,
        error: payload.symbol ? "SYMBOL_NOT_CONFIGURED" : "SYMBOL_REQUIRED",
        symbol: payload.symbol || null,
        configuredSymbols: specs.map((x) => x.symbol),
      });
    }
    const result = await proxyToWorker(spec, "webhook", payload);
    return res.status(result.status).json(result.json);
  });

  app.post(SUPERVISOR.manualPath, async (req, res) => {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const spec = resolveSpec(payload.symbol);
    if (!spec) {
      return res.status(400).json({
        ok: false,
        error: payload.symbol ? "SYMBOL_NOT_CONFIGURED" : "SYMBOL_REQUIRED",
        symbol: payload.symbol || null,
        configuredSymbols: specs.map((x) => x.symbol),
      });
    }
    const result = await proxyToWorker(spec, "manual", payload);
    return res.status(result.status).json(result.json);
  });

  let supervisorServer = null;

  async function startSupervisor() {
    slog("🧠", "FVVO_MULTI_SUPERVISOR_STARTUP", {
      brain: SUPERVISOR.brain,
      externalPort: SUPERVISOR.port,
      webhookPath: SUPERVISOR.webhookPath,
      manualPath: SUPERVISOR.manualPath,
      assets: specs.map((x) => ({
        alias: x.alias,
        symbol: x.symbol,
        brain: x.brainName,
        internalPort: x.internalPort,
        stateFileName: x.stateFileName,
      })),
    });

    for (const spec of specs) spawnWorker(runtime.get(spec.alias));

    supervisorServer = app.listen(SUPERVISOR.port, SUPERVISOR.host, () => {
      slog("✅", "FVVO_MULTI_LISTENING", {
        brain: SUPERVISOR.brain,
        host: SUPERVISOR.host,
        port: SUPERVISOR.port,
        symbols: specs.map((x) => x.symbol),
      });
    });
  }

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    slog("🟡", "FVVO_MULTI_SHUTDOWN", { signal });
    if (supervisorServer) {
      try { supervisorServer.close(); } catch (_) {}
    }
    const terms = [];
    for (const rt of runtime.values()) {
      rt.stopped = true;
      if (rt.worker) terms.push(rt.worker.terminate().catch(() => null));
    }
    await Promise.allSettled(terms);
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  if (require.main === module) {
    startSupervisor().catch((error) => {
      slog("❌", "FVVO_MULTI_STARTUP_FATAL", { error: error.message });
      process.exit(1);
    });
  }

  module.exports = {
    app,
    SUPERVISOR,
    buildWorkerSpec,
    cleanSymbol,
    resolveSpec,
    startSupervisor,
  };
}
