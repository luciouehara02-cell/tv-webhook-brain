import express from "express";

/**
 * BrainRAY_Continuation_v4.4f
 *
 * v4.4f
 * - based on v4.4e
 * - preserves the dedicated post-exit soft harvest path
 * - fixes replay-time dedup so valid harvest exits are not blocked by wall-clock timing
 *
 * Main fix:
 * - entry/exit dedup uses event time when REPLAY_USE_EVENT_TIME_FOR_POSITION_CLOCK=true
 * - live still uses wall clock
 */

const app = express();
app.use(express.json({ limit: "1mb" }));

// --------------------------------------------------
// helpers
// --------------------------------------------------
function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}
function s(v, d = "") {
  return v == null ? d : String(v);
}
function b(v, d = false) {
  if (v == null) return d;
  const x = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(x)) return true;
  if (["0", "false", "no", "off"].includes(x)) return false;
  return d;
}
function nowMs() {
  return Date.now();
}
function isoNow() {
  return new Date().toISOString();
}
function round4(x) {
  return Math.round(Number(x) * 10000) / 10000;
}
function pctDiff(from, to) {
  const a = Number(from);
  const b2 = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b2) || a === 0) return 0;
  return ((b2 - a) / a) * 100;
}
function normalizeSymbol(raw) {
  const v = String(raw || "").trim().toUpperCase();
  if (!v) return "";
  if (v.includes(":")) return v;
  return `BINANCE:${v}`;
}
function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function parseTsMs(iso) {
  const t = new Date(iso || "").getTime();
  return Number.isFinite(t) ? t : null;
}
function ageSec(iso) {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = parseTsMs(iso);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - t) / 1000);
}
function symbolParts(symbol) {
  const sym = normalizeSymbol(symbol);
  const [tv_exchange, tv_instrument] = sym.includes(":")
    ? sym.split(":")
    : ["BINANCE", sym];
  return { tv_exchange, tv_instrument };
}
function pickFirst(obj, keys, def = undefined) {
  for (const k of keys) {
    if (obj?.[k] !== undefined && obj?.[k] !== null && obj?.[k] !== "") return obj[k];
  }
  return def;
}
function reasonPush(arr, cond, text) {
  if (cond) arr.push(text);
}
function barTimeKey(iso, tfMin = 5) {
  const t = new Date(iso || Date.now());
  if (!Number.isFinite(t.getTime())) return "na";
  const bucketMs =
    Math.floor(t.getTime() / (tfMin * 60 * 1000)) * (tfMin * 60 * 1000);
  return new Date(bucketMs).toISOString();
}
function eventTimeOrNow(iso) {
  return parseTsMs(iso) ?? nowMs();
}
function maxFinite(...vals) {
  const good = vals.filter((v) => Number.isFinite(v));
  return good.length ? Math.max(...good) : NaN;
}
function isLaunchMode(mode) {
  return [
    "bullish_trend_change_launch_long",
    "bullish_trend_change_launch_long_strong",
    "bullish_trend_change_launch_long_slow_ramp",
    "tick_confirmed_launch_long",
    "tick_confirmed_launch_long_strong",
  ].includes(String(mode || ""));
}
function isProtectedContinuationMode(mode) {
  return [
    "post_exit_continuation_reentry_long",
    "post_exit_continuation_reentry_long_strong",
  ].includes(String(mode || ""));
}
function isReentryHarvestMode(mode) {
  return [
    "post_exit_continuation_reentry_long",
    "post_exit_continuation_reentry_long_strong",
    "feature_pullback_reclaim_reentry_long_strong",
  ].includes(String(mode || ""));
}

// --------------------------------------------------
// config
// --------------------------------------------------
const CONFIG = {
  PORT: n(process.env.PORT, 8080),
  DEBUG: b(process.env.DEBUG, true),
  BRAIN_NAME: s(process.env.BRAIN_NAME, "BrainRAY_Continuation_v4.4f"),

  WEBHOOK_SECRET: s(process.env.WEBHOOK_SECRET, ""),
  TICKROUTER_SECRET: s(process.env.TICKROUTER_SECRET, ""),
  WEBHOOK_PATH: s(process.env.WEBHOOK_PATH, "/webhook"),

  SYMBOL: normalizeSymbol(s(process.env.SYMBOL || "BINANCE:SOLUSDT")),
  ENTRY_TF: s(process.env.ENTRY_TF || "5"),
  TICK_MAX_AGE_SEC: n(process.env.TICK_MAX_AGE_SEC, 60),
  FEATURE_MAX_AGE_SEC: n(process.env.FEATURE_MAX_AGE_SEC, 900),
  REPLAY_ALLOW_STALE_DATA: b(process.env.REPLAY_ALLOW_STALE_DATA, false),
  REPLAY_USE_EVENT_TIME_FOR_POSITION_CLOCK: b(
    process.env.REPLAY_USE_EVENT_TIME_FOR_POSITION_CLOCK,
    true
  ),

  ENTER_DEDUP_MS: n(process.env.ENTER_DEDUP_MS, 90000),
  EXIT_DEDUP_MS: n(process.env.EXIT_DEDUP_MS, 60000),
  EXIT_COOLDOWN_MIN: n(process.env.EXIT_COOLDOWN_MIN, 12),
  REENTRY_ENTER_DEDUP_MS: n(process.env.REENTRY_ENTER_DEDUP_MS, 8000),

  C3_SIGNAL_URL: s(
    process.env.C3_SIGNAL_URL || process.env.THREECOMMAS_WEBHOOK_URL,
    ""
  ),
  C3_SIGNAL_SECRET: s(
    process.env.C3_SIGNAL_SECRET || process.env.THREECOMMAS_SECRET,
    ""
  ),
  C3_TIMEOUT_MS: n(
    process.env.C3_TIMEOUT_MS || process.env.THREECOMMAS_TIMEOUT_MS,
    8000
  ),
  MAX_LAG_SEC: n(process.env.MAX_LAG_SEC || process.env.THREECOMMAS_MAX_LAG, 300),
  SYMBOL_BOT_MAP: safeJsonParse(process.env.SYMBOL_BOT_MAP || "{}", {}),

  ENABLE_HTTP_FORWARD: b(process.env.ENABLE_HTTP_FORWARD, true),

  RAY_USE_BULLISH_TREND_CHANGE: b(process.env.RAY_USE_BULLISH_TREND_CHANGE, true),
  RAY_USE_BULLISH_TREND_CONTINUATION: b(
    process.env.RAY_USE_BULLISH_TREND_CONTINUATION,
    true
  ),
  RAY_USE_BULLISH_BOS: b(process.env.RAY_USE_BULLISH_BOS, true),
  RAY_USE_BEARISH_TREND_CHANGE: b(process.env.RAY_USE_BEARISH_TREND_CHANGE, true),
  RAY_USE_BEARISH_TREND_CONTINUATION: b(
    process.env.RAY_USE_BEARISH_TREND_CONTINUATION,
    true
  ),

  RAY_CONFLICT_GUARD_ENABLED: b(process.env.RAY_CONFLICT_GUARD_ENABLED, true),
  RAY_CONFLICT_GUARD_SEC: n(process.env.RAY_CONFLICT_GUARD_SEC, 45),
  RAY_CONFLICT_CONFIRM_FEATURE_BARS: n(
    process.env.RAY_CONFLICT_CONFIRM_FEATURE_BARS,
    1
  ),
  RAY_CONFLICT_KEEP_CURRENT_REGIME_IF_UNCLEAR: b(
    process.env.RAY_CONFLICT_KEEP_CURRENT_REGIME_IF_UNCLEAR,
    true
  ),
  RAY_CONFLICT_REQUIRE_CLOSE_CONFIRM_OVER_EMA18: b(
    process.env.RAY_CONFLICT_REQUIRE_CLOSE_CONFIRM_OVER_EMA18,
    true
  ),

  REQUIRE_EMA8_ABOVE_EMA18: b(process.env.REQUIRE_EMA8_ABOVE_EMA18, true),
  REQUIRE_CLOSE_ABOVE_EMA8: b(process.env.REQUIRE_CLOSE_ABOVE_EMA8, true),
  MIN_RSI_LONG: n(process.env.MIN_RSI_LONG, 48),
  MIN_ADX_CONTINUATION: n(process.env.MIN_ADX_CONTINUATION, 14),

  CONTINUATION_MAX_CHASE_PCT: n(process.env.CONTINUATION_MAX_CHASE_PCT, 0.35),
  MAX_EXT_FROM_EMA8_PCT: n(process.env.MAX_EXT_FROM_EMA8_PCT, 0.75),
  MAX_EXT_FROM_EMA18_PCT: n(process.env.MAX_EXT_FROM_EMA18_PCT, 1.2),

  BREAKOUT_MEMORY_ENABLED: b(process.env.BREAKOUT_MEMORY_ENABLED, true),
  BREAKOUT_MEMORY_BARS: n(process.env.BREAKOUT_MEMORY_BARS, 4),
  BREAKOUT_MEMORY_MAX_CHASE_PCT: n(
    process.env.BREAKOUT_MEMORY_MAX_CHASE_PCT,
    0.25
  ),
  BREAKOUT_MEMORY_REQUIRE_ABOVE_RECLAIM: b(
    process.env.BREAKOUT_MEMORY_REQUIRE_ABOVE_RECLAIM,
    true
  ),
  BREAKOUT_MEMORY_INVALIDATE_PCT: n(
    process.env.BREAKOUT_MEMORY_INVALIDATE_PCT,
    0.1
  ),

  HARD_STOP_PCT: n(process.env.HARD_STOP_PCT, 0.8),
  BREAKEVEN_ARM_PCT: n(process.env.BREAKEVEN_ARM_PCT, 0.4),
  BREAKEVEN_OFFSET_PCT: n(process.env.BREAKEVEN_OFFSET_PCT, 0.05),

  PROFIT_LOCK_ARM_PCT: n(process.env.PROFIT_LOCK_ARM_PCT, 0.6),
  PROFIT_LOCK_GIVEBACK_PCT: n(process.env.PROFIT_LOCK_GIVEBACK_PCT, 0.35),
  TRAIL_ARM_PCT: n(process.env.TRAIL_ARM_PCT, 1.0),
  TRAIL_GIVEBACK_PCT: n(process.env.TRAIL_GIVEBACK_PCT, 0.45),

  EXIT_ON_BEARISH_TREND_CHANGE: b(process.env.EXIT_ON_BEARISH_TREND_CHANGE, true),
  EXIT_ON_BEARISH_TREND_CONTINUATION: b(
    process.env.EXIT_ON_BEARISH_TREND_CONTINUATION,
    false
  ),
  EXIT_ON_5M_CLOSE_BELOW_EMA8: b(process.env.EXIT_ON_5M_CLOSE_BELOW_EMA8, true),
  EXIT_ON_5M_CLOSE_BELOW_EMA18: b(process.env.EXIT_ON_5M_CLOSE_BELOW_EMA18, false),

  LOCAL_TP_EXIT_ENABLED: b(process.env.LOCAL_TP_EXIT_ENABLED, true),
  LOCAL_TP_MIN_PROFIT_PCT: n(process.env.LOCAL_TP_MIN_PROFIT_PCT, 0.6),
  LOCAL_TP_EXIT_ON_CLOSE_BELOW_EMA8: b(
    process.env.LOCAL_TP_EXIT_ON_CLOSE_BELOW_EMA8,
    true
  ),
  KEEP_BULL_CONTEXT_ON_TP_EXIT: b(process.env.KEEP_BULL_CONTEXT_ON_TP_EXIT, true),

  LOCAL_TP_EMA8_BUFFER_PCT: n(process.env.LOCAL_TP_EMA8_BUFFER_PCT, 0.1),
  LOCAL_TP_MIN_RSI_TO_HOLD: n(process.env.LOCAL_TP_MIN_RSI_TO_HOLD, 60),
  LOCAL_TP_MIN_ADX_TO_HOLD: n(process.env.LOCAL_TP_MIN_ADX_TO_HOLD, 35),
  LOCAL_TP_STRONG_ADX_HARD_BLOCK: n(
    process.env.LOCAL_TP_STRONG_ADX_HARD_BLOCK,
    35
  ),
  LOCAL_TP_BLOCK_IF_BULLISH_FVVO: b(process.env.LOCAL_TP_BLOCK_IF_BULLISH_FVVO, true),
  LOCAL_TP_FORCE_ALLOW_IF_CLOSE_BELOW_EMA18: b(
    process.env.LOCAL_TP_FORCE_ALLOW_IF_CLOSE_BELOW_EMA18,
    true
  ),
  LOCAL_TP_FORCE_ALLOW_IF_BEARISH_FVVO: b(
    process.env.LOCAL_TP_FORCE_ALLOW_IF_BEARISH_FVVO,
    true
  ),
  LOCAL_TP_FORCE_ALLOW_ON_TWO_WEAKENING_BARS: b(
    process.env.LOCAL_TP_FORCE_ALLOW_ON_TWO_WEAKENING_BARS,
    true
  ),
  LOCAL_TP_REQUIRE_TWO_WEAKENING_BARS_IN_STRONG_TREND: b(
    process.env.LOCAL_TP_REQUIRE_TWO_WEAKENING_BARS_IN_STRONG_TREND,
    true
  ),
  LOCAL_TP_RSI_WEAKNESS_THRESHOLD: n(
    process.env.LOCAL_TP_RSI_WEAKNESS_THRESHOLD,
    54
  ),
  LOCAL_TP_RSI_WEAKNESS_THRESHOLD_STRONG_TREND: n(
    process.env.LOCAL_TP_RSI_WEAKNESS_THRESHOLD_STRONG_TREND,
    52
  ),
  LOCAL_TP_REQUIRE_CLOSE_BELOW_EMA18_OR_2_WEAK_BARS: b(
    process.env.LOCAL_TP_REQUIRE_CLOSE_BELOW_EMA18_OR_2_WEAK_BARS,
    true
  ),
  LOCAL_TP_STRONG_TREND_HARD_HOLD_ENABLED: b(
    process.env.LOCAL_TP_STRONG_TREND_HARD_HOLD_ENABLED,
    true
  ),
  LOCAL_TP_STRONG_TREND_HARD_HOLD_MIN_ADX: n(
    process.env.LOCAL_TP_STRONG_TREND_HARD_HOLD_MIN_ADX,
    35
  ),
  LOCAL_TP_STRONG_TREND_HARD_HOLD_REQUIRE_EMA8_ABOVE_EMA18: b(
    process.env.LOCAL_TP_STRONG_TREND_HARD_HOLD_REQUIRE_EMA8_ABOVE_EMA18,
    true
  ),
  LOCAL_TP_STRONG_TREND_HARD_HOLD_REQUIRE_RSI_ABOVE: n(
    process.env.LOCAL_TP_STRONG_TREND_HARD_HOLD_REQUIRE_RSI_ABOVE,
    55
  ),
  LOCAL_TP_STRONG_TREND_ALLOW_ONLY_IF_CLOSE_BELOW_EMA18: b(
    process.env.LOCAL_TP_STRONG_TREND_ALLOW_ONLY_IF_CLOSE_BELOW_EMA18,
    true
  ),
  LOCAL_TP_STRONG_TREND_ALLOW_IF_TWO_WEAK_BARS_AND_RSI_WEAK: b(
    process.env.LOCAL_TP_STRONG_TREND_ALLOW_IF_TWO_WEAK_BARS_AND_RSI_WEAK,
    true
  ),
  LOCAL_TP_STRONG_TREND_RSI_WEAK_MAX: n(
    process.env.LOCAL_TP_STRONG_TREND_RSI_WEAK_MAX,
    52
  ),
  LOCAL_TP_STRICT_STRONG_TREND_GATE_ENABLED: b(
    process.env.LOCAL_TP_STRICT_STRONG_TREND_GATE_ENABLED,
    true
  ),
  LOCAL_TP_STRICT_STRONG_TREND_MIN_ADX: n(
    process.env.LOCAL_TP_STRICT_STRONG_TREND_MIN_ADX,
    35
  ),
  LOCAL_TP_STRICT_STRONG_TREND_REQUIRE_EMA8_GT_EMA18: b(
    process.env.LOCAL_TP_STRICT_STRONG_TREND_REQUIRE_EMA8_GT_EMA18,
    true
  ),
  LOCAL_TP_STRICT_STRONG_TREND_REQUIRE_CLOSE_BELOW_EMA18: b(
    process.env.LOCAL_TP_STRICT_STRONG_TREND_REQUIRE_CLOSE_BELOW_EMA18,
    false
  ),
  LOCAL_TP_STRICT_STRONG_TREND_ALLOW_TWO_WEAK_BARS_AND_RSI_WEAK: b(
    process.env.LOCAL_TP_STRICT_STRONG_TREND_ALLOW_TWO_WEAK_BARS_AND_RSI_WEAK,
    true
  ),
  LOCAL_TP_STRICT_STRONG_TREND_RSI_WEAK_MAX: n(
    process.env.LOCAL_TP_STRICT_STRONG_TREND_RSI_WEAK_MAX,
    52
  ),
  LOCAL_TP_STRICT_STRONG_TREND_REQUIRE_TWO_WEAK_BARS: b(
    process.env.LOCAL_TP_STRICT_STRONG_TREND_REQUIRE_TWO_WEAK_BARS,
    true
  ),

  STRONG_TREND_HOLD_ENABLED: b(process.env.STRONG_TREND_HOLD_ENABLED, true),
  STRONG_TREND_HOLD_MIN_RSI: n(process.env.STRONG_TREND_HOLD_MIN_RSI, 64),
  STRONG_TREND_HOLD_MIN_ADX: n(process.env.STRONG_TREND_HOLD_MIN_ADX, 30),
  STRONG_TREND_HOLD_BLOCK_LOCAL_TP: b(
    process.env.STRONG_TREND_HOLD_BLOCK_LOCAL_TP,
    true
  ),
  STRONG_TREND_HOLD_BLOCK_IF_BEARISH_FVVO: b(
    process.env.STRONG_TREND_HOLD_BLOCK_IF_BEARISH_FVVO,
    false
  ),

  TOP_HARVEST_ENABLED: b(process.env.TOP_HARVEST_ENABLED, false),
  TOP_HARVEST_MIN_PROFIT_PCT: n(process.env.TOP_HARVEST_MIN_PROFIT_PCT, 0.85),
  TOP_HARVEST_MIN_ADX: n(process.env.TOP_HARVEST_MIN_ADX, 28),
  TOP_HARVEST_MIN_RSI_RECENT_HIGH: n(process.env.TOP_HARVEST_MIN_RSI_RECENT_HIGH, 64),
  TOP_HARVEST_MIN_EXT_FROM_EMA8_PCT: n(process.env.TOP_HARVEST_MIN_EXT_FROM_EMA8_PCT, 0.3),
  TOP_HARVEST_MIN_EXT_FROM_EMA18_PCT: n(process.env.TOP_HARVEST_MIN_EXT_FROM_EMA18_PCT, 0.45),
  TOP_HARVEST_REQUIRE_TWO_WEAKENING_BARS: b(
    process.env.TOP_HARVEST_REQUIRE_TWO_WEAKENING_BARS,
    false
  ),
  TOP_HARVEST_ALLOW_ONE_WEAKENING_BAR_IF_BEARISH_FVVO: b(
    process.env.TOP_HARVEST_ALLOW_ONE_WEAKENING_BAR_IF_BEARISH_FVVO,
    true
  ),
  TOP_HARVEST_ALLOW_ONE_WEAKENING_BAR_IF_NEUTRAL_FVVO: b(
    process.env.TOP_HARVEST_ALLOW_ONE_WEAKENING_BAR_IF_NEUTRAL_FVVO,
    true
  ),
  TOP_HARVEST_REQUIRE_RSI_ROLLDOWN: b(
    process.env.TOP_HARVEST_REQUIRE_RSI_ROLLDOWN,
    true
  ),
  TOP_HARVEST_REQUIRE_NO_NEW_PRICE_EXPANSION: b(
    process.env.TOP_HARVEST_REQUIRE_NO_NEW_PRICE_EXPANSION,
    false
  ),
  TOP_HARVEST_NEAR_PEAK_LOOKBACK_BARS: n(
    process.env.TOP_HARVEST_NEAR_PEAK_LOOKBACK_BARS,
    3
  ),
  TOP_HARVEST_MAX_PULLBACK_FROM_PEAK_PCT: n(
    process.env.TOP_HARVEST_MAX_PULLBACK_FROM_PEAK_PCT,
    0.45
  ),
  TOP_HARVEST_BLOCK_IF_STRONG_BULLISH_FVVO: b(
    process.env.TOP_HARVEST_BLOCK_IF_STRONG_BULLISH_FVVO,
    false
  ),
  TOP_HARVEST_REQUIRE_BULL_CONTEXT: b(
    process.env.TOP_HARVEST_REQUIRE_BULL_CONTEXT,
    true
  ),
  TOP_HARVEST_LOG_DEBUG: b(process.env.TOP_HARVEST_LOG_DEBUG, true),

  REENTRY_TOP_HARVEST_ENABLED: b(process.env.REENTRY_TOP_HARVEST_ENABLED, true),
  REENTRY_TOP_HARVEST_MIN_PROFIT_PCT: n(
    process.env.REENTRY_TOP_HARVEST_MIN_PROFIT_PCT,
    0.55
  ),
  REENTRY_TOP_HARVEST_MIN_ADX: n(
    process.env.REENTRY_TOP_HARVEST_MIN_ADX,
    28
  ),
  REENTRY_TOP_HARVEST_MIN_RSI_RECENT_HIGH: n(
    process.env.REENTRY_TOP_HARVEST_MIN_RSI_RECENT_HIGH,
    64
  ),
  REENTRY_TOP_HARVEST_MIN_EXT_FROM_EMA8_PCT: n(
    process.env.REENTRY_TOP_HARVEST_MIN_EXT_FROM_EMA8_PCT,
    0.25
  ),
  REENTRY_TOP_HARVEST_MIN_EXT_FROM_EMA18_PCT: n(
    process.env.REENTRY_TOP_HARVEST_MIN_EXT_FROM_EMA18_PCT,
    0.4
  ),
  REENTRY_TOP_HARVEST_REQUIRE_RSI_ROLLDOWN: b(
    process.env.REENTRY_TOP_HARVEST_REQUIRE_RSI_ROLLDOWN,
    true
  ),
  REENTRY_TOP_HARVEST_ALLOW_ONE_WEAK_BAR: b(
    process.env.REENTRY_TOP_HARVEST_ALLOW_ONE_WEAK_BAR,
    true
  ),
  REENTRY_TOP_HARVEST_ALLOW_TWO_WEAK_BARS: b(
    process.env.REENTRY_TOP_HARVEST_ALLOW_TWO_WEAK_BARS,
    true
  ),
  REENTRY_TOP_HARVEST_ALLOW_BEARISH_FVVO_ACCELERATOR: b(
    process.env.REENTRY_TOP_HARVEST_ALLOW_BEARISH_FVVO_ACCELERATOR,
    true
  ),
  REENTRY_TOP_HARVEST_SOFT_ENABLED: b(
    process.env.REENTRY_TOP_HARVEST_SOFT_ENABLED,
    true
  ),
  REENTRY_TOP_HARVEST_SOFT_MIN_PROFIT_PCT: n(
    process.env.REENTRY_TOP_HARVEST_SOFT_MIN_PROFIT_PCT,
    0.5
  ),
  REENTRY_TOP_HARVEST_SOFT_MIN_PEAK_PROFIT_PCT: n(
    process.env.REENTRY_TOP_HARVEST_SOFT_MIN_PEAK_PROFIT_PCT,
    0.58
  ),
  REENTRY_TOP_HARVEST_SOFT_MIN_ADX: n(
    process.env.REENTRY_TOP_HARVEST_SOFT_MIN_ADX,
    30
  ),
  REENTRY_TOP_HARVEST_SOFT_MIN_EXT_FROM_EMA8_PCT: n(
    process.env.REENTRY_TOP_HARVEST_SOFT_MIN_EXT_FROM_EMA8_PCT,
    0.3
  ),
  REENTRY_TOP_HARVEST_SOFT_MIN_EXT_FROM_EMA18_PCT: n(
    process.env.REENTRY_TOP_HARVEST_SOFT_MIN_EXT_FROM_EMA18_PCT,
    0.5
  ),
  REENTRY_TOP_HARVEST_SOFT_REQUIRE_BULLISH_FVVO_NOT_STRONG_NEGATIVE: b(
    process.env.REENTRY_TOP_HARVEST_SOFT_REQUIRE_BULLISH_FVVO_NOT_STRONG_NEGATIVE,
    true
  ),

  POST_EXIT_CONT_HARVEST_SOFT_ENABLED: b(
    process.env.POST_EXIT_CONT_HARVEST_SOFT_ENABLED,
    true
  ),
  POST_EXIT_CONT_HARVEST_SOFT_MIN_PROFIT_PCT: n(
    process.env.POST_EXIT_CONT_HARVEST_SOFT_MIN_PROFIT_PCT,
    0.5
  ),
  POST_EXIT_CONT_HARVEST_SOFT_MIN_PEAK_PROFIT_PCT: n(
    process.env.POST_EXIT_CONT_HARVEST_SOFT_MIN_PEAK_PROFIT_PCT,
    0.45
  ),
  POST_EXIT_CONT_HARVEST_SOFT_MIN_ADX: n(
    process.env.POST_EXIT_CONT_HARVEST_SOFT_MIN_ADX,
    28
  ),
  POST_EXIT_CONT_HARVEST_SOFT_MIN_EXT_FROM_EMA8_PCT: n(
    process.env.POST_EXIT_CONT_HARVEST_SOFT_MIN_EXT_FROM_EMA8_PCT,
    0.26
  ),
  POST_EXIT_CONT_HARVEST_SOFT_MIN_EXT_FROM_EMA18_PCT: n(
    process.env.POST_EXIT_CONT_HARVEST_SOFT_MIN_EXT_FROM_EMA18_PCT,
    0.42
  ),
  POST_EXIT_CONT_HARVEST_SOFT_REQUIRE_NOT_STRONG_NEGATIVE_FVVO: b(
    process.env.POST_EXIT_CONT_HARVEST_SOFT_REQUIRE_NOT_STRONG_NEGATIVE_FVVO,
    true
  ),

  REENTRY_TOP_HARVEST_LOG_DEBUG: b(
    process.env.REENTRY_TOP_HARVEST_LOG_DEBUG,
    true
  ),

  DYNAMIC_TP_ENABLED: b(process.env.DYNAMIC_TP_ENABLED, true),
  DTP_TIER1_ARM_PCT: n(process.env.DTP_TIER1_ARM_PCT, 0.6),
  DTP_TIER1_GIVEBACK_PCT: n(process.env.DTP_TIER1_GIVEBACK_PCT, 0.35),
  DTP_TIER2_ARM_PCT: n(process.env.DTP_TIER2_ARM_PCT, 1.2),
  DTP_TIER2_GIVEBACK_PCT: n(process.env.DTP_TIER2_GIVEBACK_PCT, 0.22),
  DTP_TIER3_ARM_PCT: n(process.env.DTP_TIER3_ARM_PCT, 1.8),
  DTP_TIER3_GIVEBACK_PCT: n(process.env.DTP_TIER3_GIVEBACK_PCT, 0.12),

  LAUNCH_TP_PROTECTION_ENABLED: b(process.env.LAUNCH_TP_PROTECTION_ENABLED, true),
  LAUNCH_TP_PROTECTION_BLOCK_TIER1: b(
    process.env.LAUNCH_TP_PROTECTION_BLOCK_TIER1,
    true
  ),
  LAUNCH_TP_PROTECTION_MIN_PROFIT_PCT: n(
    process.env.LAUNCH_TP_PROTECTION_MIN_PROFIT_PCT,
    0.9
  ),
  LAUNCH_TP_PROTECTION_MIN_ADX: n(
    process.env.LAUNCH_TP_PROTECTION_MIN_ADX,
    35
  ),
  LAUNCH_TP_PROTECTION_MIN_RSI: n(
    process.env.LAUNCH_TP_PROTECTION_MIN_RSI,
    60
  ),
  LAUNCH_TP_PROTECTION_REQUIRE_PRICE_ABOVE_EMA8: b(
    process.env.LAUNCH_TP_PROTECTION_REQUIRE_PRICE_ABOVE_EMA8,
    true
  ),
  LAUNCH_TP_PROTECTION_BLOCK_IF_BULLISH_FVVO: b(
    process.env.LAUNCH_TP_PROTECTION_BLOCK_IF_BULLISH_FVVO,
    true
  ),
  LAUNCH_TP_PROTECTION_LOG: b(
    process.env.LAUNCH_TP_PROTECTION_LOG,
    true
  ),

  POST_EXIT_CONT_TP_PROTECTION_ENABLED: b(
    process.env.POST_EXIT_CONT_TP_PROTECTION_ENABLED,
    true
  ),
  POST_EXIT_CONT_TP_PROTECTION_BLOCK_TIER1: b(
    process.env.POST_EXIT_CONT_TP_PROTECTION_BLOCK_TIER1,
    true
  ),
  POST_EXIT_CONT_TP_PROTECTION_MAX_PROTECT_PROFIT_PCT: n(
    process.env.POST_EXIT_CONT_TP_PROTECTION_MAX_PROTECT_PROFIT_PCT,
    0.3
  ),
  POST_EXIT_CONT_TP_PROTECTION_MIN_ADX: n(
    process.env.POST_EXIT_CONT_TP_PROTECTION_MIN_ADX,
    28
  ),
  POST_EXIT_CONT_TP_PROTECTION_MIN_RSI: n(
    process.env.POST_EXIT_CONT_TP_PROTECTION_MIN_RSI,
    58
  ),
  POST_EXIT_CONT_TP_PROTECTION_REQUIRE_PRICE_ABOVE_EMA8: b(
    process.env.POST_EXIT_CONT_TP_PROTECTION_REQUIRE_PRICE_ABOVE_EMA8,
    true
  ),
  POST_EXIT_CONT_TP_PROTECTION_BLOCK_IF_BULLISH_FVVO: b(
    process.env.POST_EXIT_CONT_TP_PROTECTION_BLOCK_IF_BULLISH_FVVO,
    true
  ),
  POST_EXIT_CONT_TP_PROTECTION_LOG: b(
    process.env.POST_EXIT_CONT_TP_PROTECTION_LOG,
    true
  ),

  PHASE2_REENTRY_ENABLED: b(process.env.PHASE2_REENTRY_ENABLED, true),
  MAX_REENTRIES_PER_BULL_REGIME: n(
    process.env.MAX_REENTRIES_PER_BULL_REGIME,
    2
  ),
  REENTRY_MIN_BARS_AFTER_EXIT: n(process.env.REENTRY_MIN_BARS_AFTER_EXIT, 1),
  REENTRY_REQUIRE_BULL_CONTEXT: b(process.env.REENTRY_REQUIRE_BULL_CONTEXT, true),
  REENTRY_REQUIRE_CLOSE_ABOVE_EMA8: b(
    process.env.REENTRY_REQUIRE_CLOSE_ABOVE_EMA8,
    true
  ),
  REENTRY_MAX_CHASE_PCT: n(process.env.REENTRY_MAX_CHASE_PCT, 0.2),
  REENTRY_MIN_RESET_FROM_PEAK_PCT: n(
    process.env.REENTRY_MIN_RESET_FROM_PEAK_PCT,
    0.15
  ),

  FAST_REENTRY_ENABLED: b(process.env.FAST_REENTRY_ENABLED, true),
  FAST_REENTRY_MIN_RESET_FROM_PEAK_PCT: n(
    process.env.FAST_REENTRY_MIN_RESET_FROM_PEAK_PCT,
    0.2
  ),
  FAST_REENTRY_REQUIRE_CLOSE_ABOVE_EMA8: b(
    process.env.FAST_REENTRY_REQUIRE_CLOSE_ABOVE_EMA8,
    true
  ),
  FAST_REENTRY_MAX_CHASE_PCT: n(process.env.FAST_REENTRY_MAX_CHASE_PCT, 0.18),
  FAST_REENTRY_MIN_RSI: n(process.env.FAST_REENTRY_MIN_RSI, 50),
  FAST_REENTRY_MIN_ADX: n(process.env.FAST_REENTRY_MIN_ADX, 14),
  FAST_REENTRY_REQUIRE_BULL_CONTEXT: b(
    process.env.FAST_REENTRY_REQUIRE_BULL_CONTEXT,
    true
  ),

  STRONG_REENTRY_OVERRIDE_ENABLED: b(
    process.env.STRONG_REENTRY_OVERRIDE_ENABLED,
    true
  ),
  STRONG_REENTRY_MIN_RSI: n(process.env.STRONG_REENTRY_MIN_RSI, 60),
  STRONG_REENTRY_MIN_ADX: n(process.env.STRONG_REENTRY_MIN_ADX, 30),
  STRONG_REENTRY_MAX_CHASE_PCT: n(
    process.env.STRONG_REENTRY_MAX_CHASE_PCT,
    0.38
  ),

  POST_EXIT_CONTINUATION_ENABLED: b(
    process.env.POST_EXIT_CONTINUATION_ENABLED,
    true
  ),
  POST_EXIT_CONTINUATION_WINDOW_BARS: n(
    process.env.POST_EXIT_CONTINUATION_WINDOW_BARS,
    8
  ),
  POST_EXIT_CONTINUATION_MIN_PROFIT_EXIT_PCT: n(
    process.env.POST_EXIT_CONTINUATION_MIN_PROFIT_EXIT_PCT,
    0.5
  ),
  POST_EXIT_CONTINUATION_MIN_RSI: n(
    process.env.POST_EXIT_CONTINUATION_MIN_RSI,
    55
  ),
  POST_EXIT_CONTINUATION_MIN_ADX: n(
    process.env.POST_EXIT_CONTINUATION_MIN_ADX,
    18
  ),
  POST_EXIT_CONTINUATION_STRONG_MIN_RSI: n(
    process.env.POST_EXIT_CONTINUATION_STRONG_MIN_RSI,
    64
  ),
  POST_EXIT_CONTINUATION_STRONG_MIN_ADX: n(
    process.env.POST_EXIT_CONTINUATION_STRONG_MIN_ADX,
    30
  ),
  POST_EXIT_CONTINUATION_MAX_CHASE_PCT: n(
    process.env.POST_EXIT_CONTINUATION_MAX_CHASE_PCT,
    0.38
  ),
  POST_EXIT_CONTINUATION_STRONG_MAX_CHASE_PCT: n(
    process.env.POST_EXIT_CONTINUATION_STRONG_MAX_CHASE_PCT,
    0.6
  ),
  POST_EXIT_CONTINUATION_MAX_EXT_FROM_EMA18_PCT: n(
    process.env.POST_EXIT_CONTINUATION_MAX_EXT_FROM_EMA18_PCT,
    1.25
  ),
  POST_EXIT_CONTINUATION_REQUIRE_CLOSE_ABOVE_EMA8: b(
    process.env.POST_EXIT_CONTINUATION_REQUIRE_CLOSE_ABOVE_EMA8,
    false
  ),
  POST_EXIT_CONTINUATION_MAX_BELOW_EMA8_PCT: n(
    process.env.POST_EXIT_CONTINUATION_MAX_BELOW_EMA8_PCT,
    0.06
  ),
  POST_EXIT_CONTINUATION_REQUIRE_EMA8_ABOVE_EMA18: b(
    process.env.POST_EXIT_CONTINUATION_REQUIRE_EMA8_ABOVE_EMA18,
    true
  ),
  POST_EXIT_CONTINUATION_REQUIRE_BULLISH_RAY_RECENCY: b(
    process.env.POST_EXIT_CONTINUATION_REQUIRE_BULLISH_RAY_RECENCY,
    false
  ),
  POST_EXIT_CONTINUATION_REQUIRE_BULLISH_RAY_RECENCY_SEC: n(
    process.env.POST_EXIT_CONTINUATION_REQUIRE_BULLISH_RAY_RECENCY_SEC,
    1800
  ),
  POST_EXIT_CONTINUATION_ALLOW_FVVO_NEUTRAL: b(
    process.env.POST_EXIT_CONTINUATION_ALLOW_FVVO_NEUTRAL,
    true
  ),
  POST_EXIT_CONTINUATION_BLOCK_ON_BURST_BEARISH: b(
    process.env.POST_EXIT_CONTINUATION_BLOCK_ON_BURST_BEARISH,
    true
  ),
  POST_EXIT_CONTINUATION_IGNORE_SNIPER_SELL_IF_STRONG: b(
    process.env.POST_EXIT_CONTINUATION_IGNORE_SNIPER_SELL_IF_STRONG,
    true
  ),

  TREND_CHANGE_LAUNCH_ENABLED: b(process.env.TREND_CHANGE_LAUNCH_ENABLED, true),
  TREND_CHANGE_LAUNCH_MIN_RSI: n(process.env.TREND_CHANGE_LAUNCH_MIN_RSI, 60),
  TREND_CHANGE_LAUNCH_MIN_ADX: n(process.env.TREND_CHANGE_LAUNCH_MIN_ADX, 14),
  TREND_CHANGE_LAUNCH_MAX_CHASE_PCT: n(
    process.env.TREND_CHANGE_LAUNCH_MAX_CHASE_PCT,
    0.35
  ),
  TREND_CHANGE_LAUNCH_MAX_EXT_FROM_EMA18_PCT: n(
    process.env.TREND_CHANGE_LAUNCH_MAX_EXT_FROM_EMA18_PCT,
    1.2
  ),
  TREND_CHANGE_LAUNCH_MEMORY_BARS: n(
    process.env.TREND_CHANGE_LAUNCH_MEMORY_BARS,
    2
  ),

  DEFERRED_LAUNCH_MIN_RSI: n(process.env.DEFERRED_LAUNCH_MIN_RSI, 68),
  DEFERRED_LAUNCH_MIN_ADX: n(process.env.DEFERRED_LAUNCH_MIN_ADX, 18),

  STRONG_LAUNCH_OVERRIDE_ENABLED: b(
    process.env.STRONG_LAUNCH_OVERRIDE_ENABLED,
    true
  ),
  STRONG_LAUNCH_MIN_RSI: n(process.env.STRONG_LAUNCH_MIN_RSI, 72),
  STRONG_LAUNCH_MIN_ADX: n(process.env.STRONG_LAUNCH_MIN_ADX, 24),
  STRONG_LAUNCH_MAX_CHASE_PCT: n(
    process.env.STRONG_LAUNCH_MAX_CHASE_PCT,
    0.55
  ),
  STRONG_LAUNCH_MAX_EXT_FROM_EMA18_PCT: n(
    process.env.STRONG_LAUNCH_MAX_EXT_FROM_EMA18_PCT,
    1.35
  ),

  FAST_TICK_LAUNCH_ENABLED: b(process.env.FAST_TICK_LAUNCH_ENABLED, true),
  FAST_TICK_LAUNCH_WINDOW_SEC: n(process.env.FAST_TICK_LAUNCH_WINDOW_SEC, 45),
  FAST_TICK_LAUNCH_MIN_RSI: n(process.env.FAST_TICK_LAUNCH_MIN_RSI, 56),
  FAST_TICK_LAUNCH_MIN_ADX: n(process.env.FAST_TICK_LAUNCH_MIN_ADX, 18),
  FAST_TICK_LAUNCH_CONFIRM_PCT: n(
    process.env.FAST_TICK_LAUNCH_CONFIRM_PCT,
    0.05
  ),
  FAST_TICK_LAUNCH_MAX_CHASE_PCT: n(
    process.env.FAST_TICK_LAUNCH_MAX_CHASE_PCT,
    0.35
  ),
  FAST_TICK_LAUNCH_MIN_TICKS_ABOVE_CONFIRM: n(
    process.env.FAST_TICK_LAUNCH_MIN_TICKS_ABOVE_CONFIRM,
    2
  ),
  FAST_TICK_LAUNCH_STRONG_MIN_RSI: n(
    process.env.FAST_TICK_LAUNCH_STRONG_MIN_RSI,
    60
  ),
  FAST_TICK_LAUNCH_STRONG_MIN_ADX: n(
    process.env.FAST_TICK_LAUNCH_STRONG_MIN_ADX,
    22
  ),
  FAST_TICK_LAUNCH_STRONG_MAX_CHASE_PCT: n(
    process.env.FAST_TICK_LAUNCH_STRONG_MAX_CHASE_PCT,
    0.45
  ),

  DEFERRED_SLOW_RAMP_OVERRIDE_ENABLED: b(
    process.env.DEFERRED_SLOW_RAMP_OVERRIDE_ENABLED,
    true
  ),
  DEFERRED_SLOW_RAMP_MIN_RSI: n(process.env.DEFERRED_SLOW_RAMP_MIN_RSI, 62),
  DEFERRED_SLOW_RAMP_MIN_ADX: n(process.env.DEFERRED_SLOW_RAMP_MIN_ADX, 20),
  DEFERRED_SLOW_RAMP_MAX_CHASE_PCT: n(
    process.env.DEFERRED_SLOW_RAMP_MAX_CHASE_PCT,
    0.25
  ),
  DEFERRED_SLOW_RAMP_MAX_EXT_FROM_EMA18_PCT: n(
    process.env.DEFERRED_SLOW_RAMP_MAX_EXT_FROM_EMA18_PCT,
    0.6
  ),

  ELEVATED_CONTINUATION_ENABLED: b(
    process.env.ELEVATED_CONTINUATION_ENABLED,
    true
  ),
  ELEVATED_CONTINUATION_WINDOW_BARS: n(
    process.env.ELEVATED_CONTINUATION_WINDOW_BARS,
    6
  ),
  ELEVATED_CONTINUATION_MIN_RSI: n(
    process.env.ELEVATED_CONTINUATION_MIN_RSI,
    58
  ),
  ELEVATED_CONTINUATION_MIN_ADX: n(
    process.env.ELEVATED_CONTINUATION_MIN_ADX,
    18
  ),
  ELEVATED_CONTINUATION_MAX_CHASE_PCT: n(
    process.env.ELEVATED_CONTINUATION_MAX_CHASE_PCT,
    0.52
  ),
  ELEVATED_CONTINUATION_MAX_EXT_FROM_EMA18_PCT: n(
    process.env.ELEVATED_CONTINUATION_MAX_EXT_FROM_EMA18_PCT,
    0.95
  ),
  ELEVATED_CONTINUATION_MIN_EMA8_SLOPE_PCT: n(
    process.env.ELEVATED_CONTINUATION_MIN_EMA8_SLOPE_PCT,
    0.03
  ),
  ELEVATED_CONTINUATION_REQUIRE_CLOSE_ABOVE_EMA8: b(
    process.env.ELEVATED_CONTINUATION_REQUIRE_CLOSE_ABOVE_EMA8,
    true
  ),
  ELEVATED_CONTINUATION_ALLOW_NEGATIVE_FVVO_IF_STRONG: b(
    process.env.ELEVATED_CONTINUATION_ALLOW_NEGATIVE_FVVO_IF_STRONG,
    true
  ),

  FVVO_ENABLED: b(process.env.FVVO_ENABLED, true),
  FVVO_MEMORY_SEC: n(process.env.FVVO_MEMORY_SEC, 1800),
  FVVO_SNIPER_BUY_BOOST: n(process.env.FVVO_SNIPER_BUY_BOOST, 1),
  FVVO_BURST_BULLISH_BOOST: n(process.env.FVVO_BURST_BULLISH_BOOST, 2),
  FVVO_SNIPER_SELL_PENALTY: n(process.env.FVVO_SNIPER_SELL_PENALTY, 1),
  FVVO_BURST_BEARISH_PENALTY: n(process.env.FVVO_BURST_BEARISH_PENALTY, 2),
  FVVO_REENTRY_RSI_RELAX: n(process.env.FVVO_REENTRY_RSI_RELAX, 3),
  FVVO_REENTRY_MAX_CHASE_BONUS_PCT: n(
    process.env.FVVO_REENTRY_MAX_CHASE_BONUS_PCT,
    0.08
  ),
  FVVO_CONT_RSI_RELAX: n(process.env.FVVO_CONT_RSI_RELAX, 2),
  FVVO_CONT_MAX_CHASE_BONUS_PCT: n(
    process.env.FVVO_CONT_MAX_CHASE_BONUS_PCT,
    0.06
  ),
  FVVO_LAUNCH_RSI_RELAX: n(process.env.FVVO_LAUNCH_RSI_RELAX, 2),
  FVVO_LAUNCH_MAX_CHASE_BONUS_PCT: n(
    process.env.FVVO_LAUNCH_MAX_CHASE_BONUS_PCT,
    0.05
  ),
  FVVO_SNIPER_SELL_CHASE_PENALTY_PCT: n(
    process.env.FVVO_SNIPER_SELL_CHASE_PENALTY_PCT,
    0.08
  ),
  FVVO_BURST_BEARISH_CHASE_PENALTY_PCT: n(
    process.env.FVVO_BURST_BEARISH_CHASE_PENALTY_PCT,
    0.1
  ),
};

const fetchFn = globalThis.fetch;

// --------------------------------------------------
// state
// --------------------------------------------------
function buildInitialRuntimeState() {
  return {
    startedAt: isoNow(),
    barIndex: 0,
    lastBarKey: null,

    lastTickPrice: null,
    lastTickTime: null,
    tickCount: 0,

    lastFeature: null,
    lastFeatureTime: null,
    lastFeatureBarKey: null,
    prevFeature: null,
    prevPrevFeature: null,

    inPosition: false,
    entryPrice: null,
    entryAt: null,
    entryMode: null,
    stopPrice: null,
    beArmed: false,
    peakPrice: null,
    peakPnlPct: 0,
    dynamicTpTier: 0,
    cooldownUntilMs: 0,

    lastEnterAtMs: 0,
    lastExitAtMs: 0,
    lastAction: null,

    cycleState: "flat",
    lastExitClass: null,
    lastExitReason: null,

    ray: {
      bullContext: false,
      bullRegimeId: 0,
      bullRegimeStartedAt: null,
      reentryCountInRegime: 0,
      lastBullTrendChangeAt: null,
      lastBullTrendContinuationAt: null,
      lastBullBosAt: null,
      lastBearTrendChangeAt: null,
      lastBearTrendContinuationAt: null,
    },

    rayConflict: {
      pending: false,
      side: null,
      event: null,
      eventTime: null,
      source: null,
      armedBar: null,
      expiresBar: null,
      price: null,
    },

    fvvo: {
      lastSniperBuyAt: null,
      lastSniperSellAt: null,
      lastBurstBullishAt: null,
      lastBurstBearishAt: null,
    },

    breakoutMemory: {
      active: false,
      used: false,
      armedBar: null,
      expiresBar: null,
      triggerPrice: null,
      reclaimPrice: null,
      breakoutHigh: null,
      mode: null,
      armedAt: null,
    },

    reentry: {
      eligible: false,
      eligibleUntilBar: null,
      eligibleFromBar: null,
      exitPrice: null,
      peakBeforeExit: null,
      anchorPrice: null,
      bullRegimeId: null,
    },

    postExitContinuation: {
      active: false,
      armedAtBar: null,
      eligibleFromBar: null,
      expiresBar: null,
      exitPrice: null,
      peakBeforeExit: null,
      anchorPrice: null,
      bullRegimeId: null,
      exitReason: null,
      exitPnlPct: null,
    },

    trendChangeLaunch: {
      pending: false,
      armedBar: null,
      expiresBar: null,
      rayPrice: null,
      rayTime: null,
    },

    fastTickLaunch: {
      active: false,
      openedAtMs: null,
      expiresAtMs: null,
      bullRegimeId: null,
      source: null,
      rayPrice: null,
      confirmPrice: null,
      featureClose: null,
      ema8: null,
      ema18: null,
      rsi: null,
      adx: null,
      breakoutHigh: null,
      ticksAboveConfirm: 0,
      lastConfirmedTickPrice: null,
    },
  };
}

const S = {
  ...buildInitialRuntimeState(),
  logs: [],
};

function log(msg, data = null) {
  const line = data ? `${msg} | ${JSON.stringify(data)}` : msg;
  const out = `${isoNow()} ${line}`;
  S.logs.push(out);
  if (S.logs.length > 2000) S.logs.shift();
  if (CONFIG.DEBUG) console.log(out);
}

function resetRuntimeState(reason = "manual_reset") {
  const keepLogs = Array.isArray(S.logs) ? S.logs : [];
  const fresh = buildInitialRuntimeState();
  for (const key of Object.keys(fresh)) S[key] = fresh[key];
  S.logs = keepLogs;
  log("♻️ STATE_RESET", { reason });
}

function currentPrice() {
  return Number.isFinite(S.lastTickPrice)
    ? S.lastTickPrice
    : n(S.lastFeature?.close, NaN);
}
function isTickFresh() {
  if (CONFIG.REPLAY_ALLOW_STALE_DATA) return true;
  return ageSec(S.lastTickTime) <= CONFIG.TICK_MAX_AGE_SEC;
}
function isFeatureFresh() {
  if (CONFIG.REPLAY_ALLOW_STALE_DATA) return true;
  return ageSec(S.lastFeatureTime) <= CONFIG.FEATURE_MAX_AGE_SEC;
}
function getBotUuid(symbol) {
  return CONFIG.SYMBOL_BOT_MAP[symbol] || "";
}
function wasWeakeningBar(cur, prev) {
  if (!cur || !prev) return false;
  const rsiWeak =
    Number.isFinite(prev.rsi) &&
    Number.isFinite(cur.rsi) &&
    cur.rsi <= prev.rsi;
  const adxWeak =
    Number.isFinite(prev.adx) &&
    Number.isFinite(cur.adx) &&
    cur.adx <= prev.adx;
  const closeWeak =
    Number.isFinite(prev.close) &&
    Number.isFinite(cur.close) &&
    cur.close < prev.close;
  return rsiWeak || adxWeak || closeWeak;
}
function twoConsecutiveWeakeningBars() {
  return (
    wasWeakeningBar(S.lastFeature, S.prevFeature) &&
    wasWeakeningBar(S.prevFeature, S.prevPrevFeature)
  );
}
function bullishRayRecent() {
  return (
    ageSec(S.ray.lastBullTrendChangeAt) <=
      CONFIG.POST_EXIT_CONTINUATION_REQUIRE_BULLISH_RAY_RECENCY_SEC ||
    ageSec(S.ray.lastBullTrendContinuationAt) <=
      CONFIG.POST_EXIT_CONTINUATION_REQUIRE_BULLISH_RAY_RECENCY_SEC ||
    ageSec(S.ray.lastBullBosAt) <=
      CONFIG.POST_EXIT_CONTINUATION_REQUIRE_BULLISH_RAY_RECENCY_SEC
  );
}
function getExitPeakSnapshot(exitPrice) {
  return maxFinite(
    S.peakPrice,
    exitPrice,
    S.lastFeature?.high,
    S.lastFeature?.close,
    S.prevFeature?.high,
    S.prevFeature?.close,
    S.entryPrice
  );
}
function recentRsiHigh(lookback = 3) {
  const arr = [S.lastFeature, S.prevFeature, S.prevPrevFeature].slice(
    0,
    Math.max(1, Math.min(3, lookback))
  );
  return maxFinite(...arr.map((x) => n(x?.rsi, NaN)));
}
function actionClockMs(eventIso = null) {
  if (CONFIG.REPLAY_USE_EVENT_TIME_FOR_POSITION_CLOCK && eventIso) {
    const t = parseTsMs(eventIso);
    if (Number.isFinite(t)) return t;
  }
  return nowMs();
}
function activeEnterDedupMs(source) {
  if (
    source === "feature_reentry" ||
    source === "post_exit_continuation_reentry"
  ) {
    return CONFIG.REENTRY_ENTER_DEDUP_MS;
  }
  return CONFIG.ENTER_DEDUP_MS;
}
function canEnterByDedup(source, eventIso = null) {
  const clockMs = actionClockMs(eventIso);
  return clockMs - S.lastEnterAtMs >= activeEnterDedupMs(source);
}
function canExitByDedup(eventIso = null) {
  const clockMs = actionClockMs(eventIso);
  return clockMs - S.lastExitAtMs >= CONFIG.EXIT_DEDUP_MS;
}

// --------------------------------------------------
// clear / arm helpers
// --------------------------------------------------
function clearBreakoutMemory(reason = "reset") {
  if (S.breakoutMemory.active) log("🧠 BREAKOUT_MEMORY_CLEARED", { reason });
  S.breakoutMemory = {
    active: false,
    used: false,
    armedBar: null,
    expiresBar: null,
    triggerPrice: null,
    reclaimPrice: null,
    breakoutHigh: null,
    mode: null,
    armedAt: null,
  };
}
function clearReentry(reason = "reset") {
  if (S.reentry.eligible) log("🔁 REENTRY_DISABLED", { reason });
  S.reentry = {
    eligible: false,
    eligibleUntilBar: null,
    eligibleFromBar: null,
    exitPrice: null,
    peakBeforeExit: null,
    anchorPrice: null,
    bullRegimeId: null,
  };
}
function clearPostExitContinuation(reason = "reset") {
  if (S.postExitContinuation.active) {
    log("🔁 POST_EXIT_CONTINUATION_DISABLED", { reason });
  }
  S.postExitContinuation = {
    active: false,
    armedAtBar: null,
    eligibleFromBar: null,
    expiresBar: null,
    exitPrice: null,
    peakBeforeExit: null,
    anchorPrice: null,
    bullRegimeId: null,
    exitReason: null,
    exitPnlPct: null,
  };
}
function armPostExitContinuation(reason, exitPrice, exitPnlPct, peakBeforeExit) {
  if (!CONFIG.POST_EXIT_CONTINUATION_ENABLED) return;
  if (!S.ray.bullContext) return;
  if (S.ray.reentryCountInRegime >= CONFIG.MAX_REENTRIES_PER_BULL_REGIME) return;
  if (exitPnlPct < CONFIG.POST_EXIT_CONTINUATION_MIN_PROFIT_EXIT_PCT) return;

  const anchor = Number.isFinite(S.lastFeature?.ema8)
    ? S.lastFeature.ema8
    : Number.isFinite(exitPrice)
    ? exitPrice
    : peakBeforeExit;

  S.postExitContinuation = {
    active: true,
    armedAtBar: S.barIndex,
    eligibleFromBar: S.barIndex + 1,
    expiresBar: S.barIndex + CONFIG.POST_EXIT_CONTINUATION_WINDOW_BARS,
    exitPrice,
    peakBeforeExit,
    anchorPrice: anchor,
    bullRegimeId: S.ray.bullRegimeId,
    exitReason: reason,
    exitPnlPct,
  };

  log("🔁 POST_EXIT_CONTINUATION_ARMED", {
    reason,
    bullRegimeId: S.ray.bullRegimeId,
    eligibleFromBar: S.postExitContinuation.eligibleFromBar,
    expiresBar: S.postExitContinuation.expiresBar,
    exitPrice: round4(exitPrice),
    peakBeforeExit: round4(peakBeforeExit),
    anchorPrice: round4(anchor),
    exitPnlPct: round4(exitPnlPct),
  });
}
function armTrendChangeLaunch(rayPrice, rayTime) {
  S.trendChangeLaunch = {
    pending: true,
    armedBar: S.barIndex,
    expiresBar: S.barIndex + CONFIG.TREND_CHANGE_LAUNCH_MEMORY_BARS,
    rayPrice,
    rayTime,
  };
  log("🚀 TREND_CHANGE_LAUNCH_ARMED", {
    armedBar: S.trendChangeLaunch.armedBar,
    expiresBar: S.trendChangeLaunch.expiresBar,
    rayPrice,
    rayTime,
  });
}
function clearTrendChangeLaunch(reason = "reset") {
  if (S.trendChangeLaunch.pending) log("🚀 TREND_CHANGE_LAUNCH_CLEARED", { reason });
  S.trendChangeLaunch = {
    pending: false,
    armedBar: null,
    expiresBar: null,
    rayPrice: null,
    rayTime: null,
  };
}
function armFastTickLaunch(source, rayPrice) {
  if (!CONFIG.FAST_TICK_LAUNCH_ENABLED) return;
  const f = S.lastFeature;
  if (!f) return;

  const confirmPrice = rayPrice * (1 + CONFIG.FAST_TICK_LAUNCH_CONFIRM_PCT / 100);

  S.fastTickLaunch = {
    active: true,
    openedAtMs: nowMs(),
    expiresAtMs: nowMs() + CONFIG.FAST_TICK_LAUNCH_WINDOW_SEC * 1000,
    bullRegimeId: S.ray.bullRegimeId,
    source,
    rayPrice,
    confirmPrice,
    featureClose: f.close,
    ema8: f.ema8,
    ema18: f.ema18,
    rsi: f.rsi,
    adx: f.adx,
    breakoutHigh: Number.isFinite(S.breakoutMemory.breakoutHigh)
      ? S.breakoutMemory.breakoutHigh
      : f.high,
    ticksAboveConfirm: 0,
    lastConfirmedTickPrice: null,
  };

  log("⚡ FAST_TICK_LAUNCH_ARMED", {
    source,
    bullRegimeId: S.fastTickLaunch.bullRegimeId,
    rayPrice,
    confirmPrice: round4(confirmPrice),
    expiresAt: new Date(S.fastTickLaunch.expiresAtMs).toISOString(),
    rsi: f.rsi,
    adx: f.adx,
    ema8: f.ema8,
    ema18: f.ema18,
  });
}
function clearFastTickLaunch(reason = "reset") {
  if (S.fastTickLaunch.active) log("⚡ FAST_TICK_LAUNCH_CLEARED", { reason });
  S.fastTickLaunch = {
    active: false,
    openedAtMs: null,
    expiresAtMs: null,
    bullRegimeId: null,
    source: null,
    rayPrice: null,
    confirmPrice: null,
    featureClose: null,
    ema8: null,
    ema18: null,
    rsi: null,
    adx: null,
    breakoutHigh: null,
    ticksAboveConfirm: 0,
    lastConfirmedTickPrice: null,
  };
}
function clearRayConflict(reason = "reset") {
  if (S.rayConflict.pending) log("⚖️ RAY_CONFLICT_CLEARED", { reason });
  S.rayConflict = {
    pending: false,
    side: null,
    event: null,
    eventTime: null,
    source: null,
    armedBar: null,
    expiresBar: null,
    price: null,
  };
}
function armRayConflict(side, event, eventTime, source, price) {
  S.rayConflict = {
    pending: true,
    side,
    event,
    eventTime,
    source,
    armedBar: S.barIndex,
    expiresBar: S.barIndex + Math.max(1, CONFIG.RAY_CONFLICT_CONFIRM_FEATURE_BARS),
    price,
  };
  log("⚖️ RAY_CONFLICT_ARMED", {
    side,
    event,
    eventTime,
    source,
    armedBar: S.rayConflict.armedBar,
    expiresBar: S.rayConflict.expiresBar,
    price,
  });
}

// --------------------------------------------------
// FVVO memory / score
// --------------------------------------------------
function fvvoRecent(iso, maxSec = CONFIG.FVVO_MEMORY_SEC) {
  return ageSec(iso) <= maxSec;
}
function getFvvoSnapshot() {
  return {
    sniperBuy: fvvoRecent(S.fvvo.lastSniperBuyAt),
    sniperSell: fvvoRecent(S.fvvo.lastSniperSellAt),
    burstBullish: fvvoRecent(S.fvvo.lastBurstBullishAt),
    burstBearish: fvvoRecent(S.fvvo.lastBurstBearishAt),
  };
}
function getFvvoScore() {
  if (!CONFIG.FVVO_ENABLED) return { score: 0, tags: [], snap: getFvvoSnapshot() };
  const snap = getFvvoSnapshot();
  let score = 0;
  const tags = [];

  if (snap.sniperBuy) {
    score += CONFIG.FVVO_SNIPER_BUY_BOOST;
    tags.push("sniper_buy");
  }
  if (snap.burstBullish) {
    score += CONFIG.FVVO_BURST_BULLISH_BOOST;
    tags.push("burst_bullish");
  }
  if (snap.sniperSell) {
    score -= CONFIG.FVVO_SNIPER_SELL_PENALTY;
    tags.push("sniper_sell");
  }
  if (snap.burstBearish) {
    score -= CONFIG.FVVO_BURST_BEARISH_PENALTY;
    tags.push("burst_bearish");
  }

  return { score, tags, snap };
}

// --------------------------------------------------
// parse inbound family
// --------------------------------------------------
function parseInboundType(body) {
  const src = String(body.src || "").toLowerCase();
  const event = String(body.event || body.signal || body.alert || body.action || "").trim();

  if (src === "tick") return { family: "tick", name: "tick" };
  if (src === "feature" || src === "features") return { family: "feature", name: "feature" };
  if (src === "ray") return { family: "ray", name: event };
  if (src === "fvvo") return { family: "fvvo", name: event };

  return { family: "unknown", name: event || "unknown" };
}

// --------------------------------------------------
// regime / ray handling
// --------------------------------------------------
function rayEventsConflict(tsA, tsB) {
  const a = parseTsMs(tsA);
  const b2 = parseTsMs(tsB);
  if (!Number.isFinite(a) || !Number.isFinite(b2)) return false;
  return Math.abs(a - b2) <= CONFIG.RAY_CONFLICT_GUARD_SEC * 1000;
}
function turnBullRegimeOn(ts, source) {
  if (!S.ray.bullContext) {
    S.ray.bullContext = true;
    S.ray.bullRegimeId += 1;
    S.ray.bullRegimeStartedAt = ts;
    S.ray.reentryCountInRegime = 0;
    S.cycleState = S.inPosition ? "long" : "flat";
    clearReentry("new_bull_regime");
    clearPostExitContinuation("new_bull_regime");
    log("🟢 BULL_REGIME_ON", {
      source,
      bullRegimeId: S.ray.bullRegimeId,
      ts,
    });
  }
}
function turnBullRegimeOff(ts, reason) {
  if (S.ray.bullContext) {
    S.ray.bullContext = false;
    S.cycleState = S.inPosition ? "long" : "disabled_by_bear_regime";
    clearBreakoutMemory("bull_regime_off");
    clearReentry("bull_regime_off");
    clearPostExitContinuation("bull_regime_off");
    clearTrendChangeLaunch("bull_regime_off");
    clearFastTickLaunch("bull_regime_off");
    log("🔴 BULL_REGIME_OFF", { reason, ts, bullRegimeId: S.ray.bullRegimeId });
  }
}
function maybeHandleRayConflict(side, event, ts, price, source) {
  if (!CONFIG.RAY_CONFLICT_GUARD_ENABLED) return false;

  const lastOppositeTs =
    side === "bull_off"
      ? pickFirst(S.ray, ["lastBullTrendChangeAt", "lastBullTrendContinuationAt"], null)
      : pickFirst(S.ray, ["lastBearTrendChangeAt", "lastBearTrendContinuationAt"], null);

  if (rayEventsConflict(ts, lastOppositeTs)) {
    armRayConflict(side, event, ts, source, price);
    return true;
  }
  return false;
}
function resolveRayConflictOnFeature(feature) {
  if (!S.rayConflict.pending) return;
  if (S.barIndex < n(S.rayConflict.expiresBar, Infinity)) return;

  const side = S.rayConflict.side;
  const fv = getFvvoScore();

  const close = n(feature.close, NaN);
  const ema18 = n(feature.ema18, NaN);
  const adx = n(feature.adx, NaN);
  const rsi = n(feature.rsi, NaN);

  let confirm = false;

  if (side === "bull_on") {
    confirm =
      (!CONFIG.RAY_CONFLICT_REQUIRE_CLOSE_CONFIRM_OVER_EMA18 ||
        (Number.isFinite(close) && Number.isFinite(ema18) && close >= ema18)) &&
      (!Number.isFinite(rsi) || rsi >= CONFIG.MIN_RSI_LONG) &&
      (!Number.isFinite(adx) || adx >= CONFIG.MIN_ADX_CONTINUATION);

    if (confirm) {
      turnBullRegimeOn(feature.time, "ray_conflict_confirm_bull");
      log("⚖️ RAY_CONFLICT_RESOLVED", {
        side,
        action: "bull_on_confirmed",
        fvvo: fv,
      });
    } else if (!CONFIG.RAY_CONFLICT_KEEP_CURRENT_REGIME_IF_UNCLEAR) {
      turnBullRegimeOff(feature.time, "ray_conflict_bull_failed");
      log("⚖️ RAY_CONFLICT_RESOLVED", {
        side,
        action: "bull_on_failed_force_off",
        fvvo: fv,
      });
    } else {
      log("⚖️ RAY_CONFLICT_RESOLVED", {
        side,
        action: "kept_current_regime",
        fvvo: fv,
      });
    }
  }

  if (side === "bull_off") {
    confirm =
      (Number.isFinite(close) && Number.isFinite(ema18) && close < ema18) ||
      (Number.isFinite(rsi) && rsi < CONFIG.MIN_RSI_LONG - 2) ||
      fv.score < 0;

    if (confirm) {
      if (S.inPosition && CONFIG.EXIT_ON_BEARISH_TREND_CHANGE) {
        doExit("ray_conflict_bear_confirmed", currentPrice(), feature.time, "regime_break");
      }
      turnBullRegimeOff(feature.time, "ray_conflict_confirm_bear");
      log("⚖️ RAY_CONFLICT_RESOLVED", {
        side,
        action: "bull_off_confirmed",
        fvvo: fv,
      });
    } else if (!CONFIG.RAY_CONFLICT_KEEP_CURRENT_REGIME_IF_UNCLEAR) {
      turnBullRegimeOff(feature.time, "ray_conflict_force_bear");
      log("⚖️ RAY_CONFLICT_RESOLVED", {
        side,
        action: "forced_bull_off",
        fvvo: fv,
      });
    } else {
      log("⚖️ RAY_CONFLICT_RESOLVED", {
        side,
        action: "kept_current_regime",
        fvvo: fv,
      });
    }
  }

  clearRayConflict("resolved_on_feature");
}
function handleRayEvent(body) {
  const name = String(body.event || "").trim();
  const ts = pickFirst(body, ["time", "timestamp"], isoNow());
  const price = n(pickFirst(body, ["price", "trigger_price", "close"], currentPrice()));

  if (/Bullish Trend Change/i.test(name) && CONFIG.RAY_USE_BULLISH_TREND_CHANGE) {
    S.ray.lastBullTrendChangeAt = ts;

    if (maybeHandleRayConflict("bull_on", name, ts, price, "ray_bullish_trend_change")) {
      log("🟡 RAY_BULLISH_TREND_CHANGE_HELD_FOR_CONFLICT", { price, ts });
      return;
    }

    turnBullRegimeOn(ts, "ray_bullish_trend_change");
    log("🟢 RAY_BULLISH_TREND_CHANGE", { price, ts });

    if (CONFIG.TREND_CHANGE_LAUNCH_ENABLED) {
      armTrendChangeLaunch(price, ts);
      const decision = tryEntry("immediate_trend_change_launch", {
        ...body,
        src: "ray",
        event: "Bullish Trend Change",
        price,
        time: ts,
      });
      if (!decision.allow) armFastTickLaunch("ray_bullish_trend_change", price);
    }
    return;
  }

  if (/Bullish Trend Continuation/i.test(name) && CONFIG.RAY_USE_BULLISH_TREND_CONTINUATION) {
    S.ray.lastBullTrendContinuationAt = ts;

    if (
      maybeHandleRayConflict("bull_on", name, ts, price, "ray_bullish_trend_continuation")
    ) {
      log("🟡 RAY_BULLISH_TREND_CONTINUATION_HELD_FOR_CONFLICT", { price, ts });
      return;
    }

    if (!S.ray.bullContext) turnBullRegimeOn(ts, "ray_bullish_trend_continuation");
    log("🟩 RAY_BULLISH_TREND_CONTINUATION", { price, ts });

    const decision = tryEntry("ray_bullish_trend_continuation", body);
    if (!decision.allow && CONFIG.FAST_TICK_LAUNCH_ENABLED) {
      armFastTickLaunch("ray_bullish_trend_continuation", price);
    }
    return;
  }

  if (/Bullish BOS/i.test(name) && CONFIG.RAY_USE_BULLISH_BOS) {
    S.ray.lastBullBosAt = ts;
    log("🔹 RAY_BULLISH_BOS", { price, ts });
    return;
  }

  if (/Bearish Trend Change/i.test(name) && CONFIG.RAY_USE_BEARISH_TREND_CHANGE) {
    S.ray.lastBearTrendChangeAt = ts;

    if (maybeHandleRayConflict("bull_off", name, ts, price, "ray_bearish_trend_change")) {
      log("🟡 RAY_BEARISH_TREND_CHANGE_HELD_FOR_CONFLICT", { price, ts });
      return;
    }

    log("🔴 RAY_BEARISH_TREND_CHANGE", { price, ts });

    if (S.inPosition && CONFIG.EXIT_ON_BEARISH_TREND_CHANGE) {
      doExit("ray_bearish_trend_change", price, ts, "regime_break");
    }
    turnBullRegimeOff(ts, "ray_bearish_trend_change");
    return;
  }

  if (
    /Bearish Trend Continuation/i.test(name) &&
    CONFIG.RAY_USE_BEARISH_TREND_CONTINUATION
  ) {
    S.ray.lastBearTrendContinuationAt = ts;

    if (
      maybeHandleRayConflict(
        "bull_off",
        name,
        ts,
        price,
        "ray_bearish_trend_continuation"
      )
    ) {
      log("🟡 RAY_BEARISH_TREND_CONTINUATION_HELD_FOR_CONFLICT", { price, ts });
      return;
    }

    log("🟥 RAY_BEARISH_TREND_CONTINUATION", { price, ts });

    if (S.inPosition && CONFIG.EXIT_ON_BEARISH_TREND_CONTINUATION) {
      doExit("ray_bearish_trend_continuation", price, ts, "regime_break");
      turnBullRegimeOff(ts, "ray_bearish_trend_continuation");
    }
  }
}
function handleFvvoEvent(body) {
  const name = String(body.event || "").trim();
  const ts = pickFirst(body, ["time", "timestamp"], isoNow());

  if (!CONFIG.FVVO_ENABLED) {
    log("🧿 FVVO_IGNORED_DISABLED", { name, ts });
    return;
  }

  if (/Sniper Buy Alert/i.test(name)) {
    S.fvvo.lastSniperBuyAt = ts;
    log("🧿 FVVO_SNIPER_BUY", { ts });
    return;
  }
  if (/Sniper Sell Alert/i.test(name)) {
    S.fvvo.lastSniperSellAt = ts;
    log("🧿 FVVO_SNIPER_SELL", { ts });
    return;
  }
  if (/Burst Bullish Alert/i.test(name)) {
    S.fvvo.lastBurstBullishAt = ts;
    log("🧿 FVVO_BURST_BULLISH", { ts });
    return;
  }
  if (/Burst Bearish Alert/i.test(name)) {
    S.fvvo.lastBurstBearishAt = ts;
    log("🧿 FVVO_BURST_BEARISH", { ts });
    return;
  }

  log("🧿 FVVO_UNKNOWN", { name, ts });
}

// --------------------------------------------------
// feature handling
// --------------------------------------------------
function updateBarProgress(ts) {
  const key = barTimeKey(ts, n(CONFIG.ENTRY_TF, 5));
  if (key !== S.lastBarKey) {
    S.barIndex += 1;
    S.lastBarKey = key;
    invalidateBreakoutMemory();
    invalidateReentry();
    invalidatePostExitContinuation();
    invalidateTrendChangeLaunch();
    invalidateFastTickLaunch();
  }
}
function handleFeature(body) {
  const ts = pickFirst(body, ["time", "timestamp"], isoNow());
  updateBarProgress(ts);

  const feature = {
    symbol: normalizeSymbol(pickFirst(body, ["symbol"], CONFIG.SYMBOL)),
    tf: s(pickFirst(body, ["tf"], CONFIG.ENTRY_TF)),
    time: ts,

    open: n(body.open, NaN),
    high: n(body.high, NaN),
    low: n(body.low, NaN),
    close: n(body.close, NaN),

    ema8: n(body.ema8, NaN),
    ema18: n(body.ema18, NaN),
    ema50: n(body.ema50, NaN),

    rsi: n(body.rsi, NaN),
    adx: n(body.adx, NaN),
    atrPct: n(body.atrPct, NaN),
  };

  S.prevPrevFeature = S.prevFeature ? { ...S.prevFeature } : null;
  S.prevFeature = S.lastFeature ? { ...S.lastFeature } : null;
  S.lastFeature = feature;
  S.lastFeatureTime = ts;
  S.lastFeatureBarKey = S.lastBarKey;

  log("📊 FEATURE_5M", {
    close: feature.close,
    ema8: feature.ema8,
    ema18: feature.ema18,
    rsi: feature.rsi,
    adx: feature.adx,
    barIndex: S.barIndex,
    fvvo: getFvvoScore(),
  });

  resolveRayConflictOnFeature(feature);
  evaluateStructureAndArmMemory(feature);
  evaluateReentryEligibilityFromFeature(feature);

  if (CONFIG.TREND_CHANGE_LAUNCH_ENABLED && S.trendChangeLaunch.pending) {
    tryEntry("deferred_trend_change_launch", {
      src: "ray",
      symbol: CONFIG.SYMBOL,
      tf: CONFIG.ENTRY_TF,
      event: "Bullish Trend Change",
      price: feature.close,
      time: feature.time,
    });
  }

  if (CONFIG.POST_EXIT_CONTINUATION_ENABLED && S.postExitContinuation.active && !S.inPosition) {
    const pecDecision = tryEntry("post_exit_continuation_reentry", {
      src: "features",
      symbol: CONFIG.SYMBOL,
      tf: CONFIG.ENTRY_TF,
      close: feature.close,
      price: feature.close,
      time: feature.time,
    });

    if (pecDecision?.allow) {
      if (S.inPosition) return;
    }
  }

  if (CONFIG.PHASE2_REENTRY_ENABLED && S.reentry.eligible && !S.inPosition) {
    tryEntry("feature_reentry", {
      src: "features",
      symbol: CONFIG.SYMBOL,
      tf: CONFIG.ENTRY_TF,
      close: feature.close,
      price: feature.close,
      time: feature.time,
    });
  }

  if (S.inPosition) evaluateBarExit(feature);
}
function evaluateStructureAndArmMemory(f) {
  if (!CONFIG.BREAKOUT_MEMORY_ENABLED) return;
  if (normalizeSymbol(f.symbol) !== CONFIG.SYMBOL) return;
  if (String(f.tf) !== String(CONFIG.ENTRY_TF)) return;

  const bullEmaOk =
    !CONFIG.REQUIRE_EMA8_ABOVE_EMA18 ||
    (Number.isFinite(f.ema8) && Number.isFinite(f.ema18) && f.ema8 >= f.ema18);

  const closeAboveEma8Ok =
    !CONFIG.REQUIRE_CLOSE_ABOVE_EMA8 ||
    (Number.isFinite(f.close) && Number.isFinite(f.ema8) && f.close >= f.ema8);

  const fv = getFvvoScore();
  const rsiFloor = Math.max(
    0,
    CONFIG.MIN_RSI_LONG - Math.max(0, fv.score > 0 ? CONFIG.FVVO_CONT_RSI_RELAX : 0)
  );

  const rsiOk = !Number.isFinite(f.rsi) || f.rsi >= rsiFloor;
  const adxOk = !Number.isFinite(f.adx) || f.adx >= CONFIG.MIN_ADX_CONTINUATION;

  const bullRayContext =
    S.ray.bullContext ||
    ageSec(S.ray.lastBullTrendChangeAt) < 3600 ||
    ageSec(S.ray.lastBullTrendContinuationAt) < 1800;

  const bullishBosRecent = ageSec(S.ray.lastBullBosAt) < 1800;

  const structureOk =
    bullEmaOk && closeAboveEma8Ok && rsiOk && adxOk && (bullRayContext || bullishBosRecent);
  if (!structureOk) return;

  S.breakoutMemory = {
    active: true,
    used: false,
    armedBar: S.barIndex,
    expiresBar: S.barIndex + CONFIG.BREAKOUT_MEMORY_BARS,
    triggerPrice: f.close,
    reclaimPrice: Number.isFinite(f.ema8) ? f.ema8 : f.close,
    breakoutHigh: f.high,
    mode: "breakout_continuation_memory",
    armedAt: isoNow(),
  };

  log("🧠 BREAKOUT_MEMORY_ARMED", {
    armedBar: S.breakoutMemory.armedBar,
    expiresBar: S.breakoutMemory.expiresBar,
    triggerPrice: S.breakoutMemory.triggerPrice,
    reclaimPrice: S.breakoutMemory.reclaimPrice,
    breakoutHigh: S.breakoutMemory.breakoutHigh,
  });
}
function invalidateBreakoutMemory() {
  if (!S.breakoutMemory.active) return;
  if (S.breakoutMemory.used) return clearBreakoutMemory("used");
  if (S.barIndex > S.breakoutMemory.expiresBar) return clearBreakoutMemory("expired");

  const px = currentPrice();
  if (!Number.isFinite(px)) return;

  if (
    CONFIG.BREAKOUT_MEMORY_REQUIRE_ABOVE_RECLAIM &&
    Number.isFinite(S.breakoutMemory.reclaimPrice)
  ) {
    const floor =
      S.breakoutMemory.reclaimPrice *
      (1 - CONFIG.BREAKOUT_MEMORY_INVALIDATE_PCT / 100);
    if (px < floor) return clearBreakoutMemory("lost_reclaim");
  }
}
function invalidateReentry() {
  if (!S.reentry.eligible) return;
  if (S.barIndex > n(S.reentry.eligibleUntilBar, -1)) clearReentry("expired");
}
function invalidatePostExitContinuation() {
  if (!S.postExitContinuation.active) return;
  if (S.barIndex > n(S.postExitContinuation.expiresBar, -1)) {
    clearPostExitContinuation("expired");
  }
}
function invalidateTrendChangeLaunch() {
  if (!S.trendChangeLaunch.pending) return;
  if (S.barIndex > n(S.trendChangeLaunch.expiresBar, -1)) {
    clearTrendChangeLaunch("expired");
  }
}
function invalidateFastTickLaunch() {
  if (!S.fastTickLaunch.active) return;
  if (nowMs() > n(S.fastTickLaunch.expiresAtMs, 0)) {
    return clearFastTickLaunch("expired");
  }
  if (S.fastTickLaunch.bullRegimeId !== S.ray.bullRegimeId) {
    clearFastTickLaunch("regime_changed");
  }
}
function evaluateReentryEligibilityFromFeature(feature) {
  if (!CONFIG.PHASE2_REENTRY_ENABLED) return;
  if (!S.ray.bullContext) return;
  if (!S.reentry.eligible) return;
  if (S.reentry.bullRegimeId !== S.ray.bullRegimeId) return;

  const peak = n(S.reentry.peakBeforeExit, NaN);
  const close = n(feature.close, NaN);
  if (!Number.isFinite(peak) || !Number.isFinite(close)) return;

  const resetThreshold = CONFIG.FAST_REENTRY_ENABLED
    ? CONFIG.FAST_REENTRY_MIN_RESET_FROM_PEAK_PCT
    : CONFIG.REENTRY_MIN_RESET_FROM_PEAK_PCT;

  const resetFromPeakPct = pctDiff(peak, close);
  if (resetFromPeakPct <= -resetThreshold) {
    S.reentry.anchorPrice = Number.isFinite(feature.ema8) ? feature.ema8 : close;
    log("🔁 REENTRY_ELIGIBLE", {
      bullRegimeId: S.ray.bullRegimeId,
      barIndex: S.barIndex,
      resetFromPeakPct,
      anchorPrice: S.reentry.anchorPrice,
    });
  }
}

// --------------------------------------------------
// entry logic
// --------------------------------------------------
function tryEntry(source, body) {
  const eventIso = pickFirst(body, ["time", "timestamp"], isoNow());
  const decision = evaluateEntry(source, body, eventIso);

  if (!decision.allow) {
    if (
      source === "deferred_trend_change_launch" ||
      source === "immediate_trend_change_launch" ||
      source === "tick_confirmed_fast_launch"
    ) {
      log("🚫 LAUNCH_ENTRY_BLOCKED", decision);
    } else {
      log("🚫 ENTRY_BLOCKED", decision);
    }
    return decision;
  }

  const price = Number.isFinite(decision.entryPrice)
    ? decision.entryPrice
    : currentPrice();
  if (!Number.isFinite(price)) {
    log("🚫 ENTRY_BLOCKED", { reason: "no_entry_price" });
    return { allow: false, reason: "no_entry_price" };
  }

  doEnter(decision.mode, price, decision, eventIso);
  return decision;
}
function evaluateEntry(source, body, eventIso = null) {
  const reasons = [];
  const px = n(pickFirst(body, ["price", "trigger_price", "close"], currentPrice()), NaN);
  const feature = S.lastFeature;
  const fv = getFvvoScore();

  reasonPush(
    reasons,
    normalizeSymbol(pickFirst(body, ["symbol"], CONFIG.SYMBOL)) !== CONFIG.SYMBOL,
    "symbol_mismatch"
  );
  reasonPush(reasons, S.inPosition, "already_in_position");
  reasonPush(reasons, actionClockMs(eventIso) < S.cooldownUntilMs, "cooldown_active");
  reasonPush(reasons, !canEnterByDedup(source, eventIso), "enter_dedup");
  reasonPush(reasons, !isFeatureFresh(), "stale_feature");
  reasonPush(reasons, !S.ray.bullContext, "no_bull_context");
  reasonPush(reasons, !Number.isFinite(px), "bad_price");
  reasonPush(reasons, !feature, "no_feature");
  if (source === "tick_confirmed_fast_launch") {
    reasonPush(reasons, !isTickFresh(), "stale_tick");
  }

  if (reasons.length) return { allow: false, source, reasons, fvvo: fv };

  const ema8 = n(feature.ema8, NaN);
  const ema18 = n(feature.ema18, NaN);
  const close = n(feature.close, NaN);
  const rsi = n(feature.rsi, NaN);
  const adx = n(feature.adx, NaN);

  const emaBullOk =
    !CONFIG.REQUIRE_EMA8_ABOVE_EMA18 ||
    (Number.isFinite(ema8) && Number.isFinite(ema18) && ema8 >= ema18);

  const closeAboveEma8Ok =
    !CONFIG.REQUIRE_CLOSE_ABOVE_EMA8 ||
    (Number.isFinite(close) && Number.isFinite(ema8) && close >= ema8);

  const extFromEma8 = Number.isFinite(ema8) ? pctDiff(ema8, px) : 0;
  const extFromEma18 = Number.isFinite(ema18) ? pctDiff(ema18, px) : 0;

  const bullishFvvo = fv.score > 0;
  const strongNegativeFvvo = fv.snap.burstBearish || fv.score <= -2;

  if (source === "tick_confirmed_fast_launch" && CONFIG.FAST_TICK_LAUNCH_ENABLED) {
    const tl = S.fastTickLaunch;
    const rr = [];

    reasonPush(rr, !tl.active, "fast_tick_launch_not_active");
    reasonPush(rr, nowMs() > n(tl.expiresAtMs, 0), "fast_tick_launch_expired");
    reasonPush(
      rr,
      tl.bullRegimeId !== S.ray.bullRegimeId,
      "fast_tick_launch_regime_mismatch"
    );
    reasonPush(rr, !emaBullOk, "fast_tick_launch_ema_invalid");

    const minRsi = Math.max(
      0,
      CONFIG.FAST_TICK_LAUNCH_MIN_RSI -
        (bullishFvvo ? CONFIG.FVVO_LAUNCH_RSI_RELAX : 0)
    );
    const minAdx = CONFIG.FAST_TICK_LAUNCH_MIN_ADX;

    const strongFastLaunch =
      Number.isFinite(rsi) &&
      Number.isFinite(adx) &&
      rsi >= CONFIG.FAST_TICK_LAUNCH_STRONG_MIN_RSI &&
      adx >= CONFIG.FAST_TICK_LAUNCH_STRONG_MIN_ADX;

    let allowedChase = strongFastLaunch
      ? CONFIG.FAST_TICK_LAUNCH_STRONG_MAX_CHASE_PCT
      : CONFIG.FAST_TICK_LAUNCH_MAX_CHASE_PCT;

    if (bullishFvvo) allowedChase += CONFIG.FVVO_LAUNCH_MAX_CHASE_BONUS_PCT;
    if (fv.snap.sniperSell) {
      allowedChase -= CONFIG.FVVO_SNIPER_SELL_CHASE_PENALTY_PCT;
    }
    if (fv.snap.burstBearish) {
      allowedChase -= CONFIG.FVVO_BURST_BEARISH_CHASE_PENALTY_PCT;
    }

    reasonPush(rr, Number.isFinite(rsi) && rsi < minRsi, "fast_tick_launch_rsi_too_low");
    reasonPush(rr, Number.isFinite(adx) && adx < minAdx, "fast_tick_launch_adx_too_low");
    reasonPush(rr, extFromEma8 > allowedChase, "fast_tick_launch_chase_too_high");
    reasonPush(rr, px < n(tl.confirmPrice, Infinity), "fast_tick_launch_below_confirm");
    reasonPush(
      rr,
      n(tl.ticksAboveConfirm, 0) < CONFIG.FAST_TICK_LAUNCH_MIN_TICKS_ABOVE_CONFIRM,
      "fast_tick_launch_not_enough_confirm_ticks"
    );

    if (rr.length === 0) {
      return {
        allow: true,
        source,
        mode: strongFastLaunch
          ? "tick_confirmed_launch_long_strong"
          : "tick_confirmed_launch_long",
        entryPrice: px,
        extFromEma8,
        extFromEma18,
        ticksAboveConfirm: tl.ticksAboveConfirm,
        confirmPrice: round4(tl.confirmPrice),
        strongFastLaunch,
        fvvo: fv,
      };
    }

    return {
      allow: false,
      source,
      reasons: rr,
      extFromEma8,
      extFromEma18,
      ticksAboveConfirm: tl.ticksAboveConfirm,
      confirmPrice: round4(tl.confirmPrice),
      strongFastLaunchCandidate: strongFastLaunch,
      fvvo: fv,
    };
  }

  if (
    (source === "immediate_trend_change_launch" ||
      source === "deferred_trend_change_launch") &&
    CONFIG.TREND_CHANGE_LAUNCH_ENABLED
  ) {
    const rr = [];
    const launchAnchor = Number.isFinite(ema8) ? ema8 : close;
    const launchChasePct = Number.isFinite(launchAnchor)
      ? pctDiff(launchAnchor, px)
      : 999;

    const isDeferred = source === "deferred_trend_change_launch";

    const minLaunchRsiBase = isDeferred
      ? CONFIG.DEFERRED_LAUNCH_MIN_RSI
      : CONFIG.TREND_CHANGE_LAUNCH_MIN_RSI;

    const minLaunchRsi = Math.max(
      0,
      minLaunchRsiBase - (bullishFvvo ? CONFIG.FVVO_LAUNCH_RSI_RELAX : 0)
    );
    const minLaunchAdx = isDeferred
      ? CONFIG.DEFERRED_LAUNCH_MIN_ADX
      : CONFIG.TREND_CHANGE_LAUNCH_MIN_ADX;

    const strongOverride =
      CONFIG.STRONG_LAUNCH_OVERRIDE_ENABLED &&
      Number.isFinite(rsi) &&
      Number.isFinite(adx) &&
      rsi >= CONFIG.STRONG_LAUNCH_MIN_RSI &&
      adx >= CONFIG.STRONG_LAUNCH_MIN_ADX &&
      extFromEma18 <= CONFIG.STRONG_LAUNCH_MAX_EXT_FROM_EMA18_PCT &&
      launchChasePct <= CONFIG.STRONG_LAUNCH_MAX_CHASE_PCT;

    const slowRampOverride =
      isDeferred &&
      CONFIG.DEFERRED_SLOW_RAMP_OVERRIDE_ENABLED &&
      Number.isFinite(rsi) &&
      Number.isFinite(adx) &&
      emaBullOk &&
      closeAboveEma8Ok &&
      rsi >= CONFIG.DEFERRED_SLOW_RAMP_MIN_RSI &&
      adx >= CONFIG.DEFERRED_SLOW_RAMP_MIN_ADX &&
      launchChasePct <= CONFIG.DEFERRED_SLOW_RAMP_MAX_CHASE_PCT &&
      extFromEma18 <= CONFIG.DEFERRED_SLOW_RAMP_MAX_EXT_FROM_EMA18_PCT;

    let allowedLaunchChase = strongOverride
      ? CONFIG.STRONG_LAUNCH_MAX_CHASE_PCT
      : CONFIG.TREND_CHANGE_LAUNCH_MAX_CHASE_PCT;

    if (bullishFvvo) allowedLaunchChase += CONFIG.FVVO_LAUNCH_MAX_CHASE_BONUS_PCT;
    if (fv.snap.sniperSell) {
      allowedLaunchChase -= CONFIG.FVVO_SNIPER_SELL_CHASE_PENALTY_PCT;
    }
    if (fv.snap.burstBearish) {
      allowedLaunchChase -= CONFIG.FVVO_BURST_BEARISH_CHASE_PENALTY_PCT;
    }

    const allowedLaunchExtEma18 = strongOverride
      ? CONFIG.STRONG_LAUNCH_MAX_EXT_FROM_EMA18_PCT
      : CONFIG.TREND_CHANGE_LAUNCH_MAX_EXT_FROM_EMA18_PCT;

    reasonPush(rr, !S.trendChangeLaunch.pending, "launch_not_pending");
    reasonPush(
      rr,
      S.barIndex > n(S.trendChangeLaunch.expiresBar, -1),
      "launch_pending_expired"
    );
    reasonPush(rr, !emaBullOk, "launch_ema8_below_ema18");
    reasonPush(rr, !closeAboveEma8Ok, "launch_close_below_ema8");

    if (!slowRampOverride) {
      reasonPush(rr, Number.isFinite(rsi) && rsi < minLaunchRsi, "launch_rsi_too_low");
      reasonPush(rr, Number.isFinite(adx) && adx < minLaunchAdx, "launch_adx_too_low");
    }

    reasonPush(rr, launchChasePct > allowedLaunchChase, "launch_chase_too_high");
    reasonPush(
      rr,
      extFromEma18 > allowedLaunchExtEma18,
      "launch_too_extended_from_ema18"
    );

    if (rr.length === 0) {
      return {
        allow: true,
        source,
        mode: strongOverride
          ? "bullish_trend_change_launch_long_strong"
          : slowRampOverride
          ? "bullish_trend_change_launch_long_slow_ramp"
          : "bullish_trend_change_launch_long",
        entryPrice: px,
        extFromEma8,
        extFromEma18,
        launchChasePct,
        armedBar: S.trendChangeLaunch.armedBar,
        expiresBar: S.trendChangeLaunch.expiresBar,
        strongOverride,
        slowRampOverride,
        isDeferredLaunch: isDeferred,
        minLaunchRsi,
        minLaunchAdx,
        fvvo: fv,
      };
    }

    return {
      allow: false,
      source,
      reasons: rr,
      extFromEma8,
      extFromEma18,
      launchChasePct,
      armedBar: S.trendChangeLaunch.armedBar,
      expiresBar: S.trendChangeLaunch.expiresBar,
      strongOverrideCandidate: strongOverride,
      slowRampOverrideCandidate: slowRampOverride,
      isDeferredLaunch: isDeferred,
      minLaunchRsi,
      minLaunchAdx,
      fvvo: fv,
    };
  }

  if (
    source === "post_exit_continuation_reentry" &&
    CONFIG.POST_EXIT_CONTINUATION_ENABLED
  ) {
    const rr = [];
    const pec = S.postExitContinuation;

    reasonPush(rr, !pec.active, "post_exit_cont_not_active");
    reasonPush(
      rr,
      pec.bullRegimeId !== S.ray.bullRegimeId,
      "post_exit_cont_regime_mismatch"
    );
    reasonPush(rr, S.barIndex < n(pec.eligibleFromBar, 0), "post_exit_cont_too_early");
    reasonPush(rr, S.barIndex > n(pec.expiresBar, -1), "post_exit_cont_expired");
    reasonPush(
      rr,
      S.ray.reentryCountInRegime >= CONFIG.MAX_REENTRIES_PER_BULL_REGIME,
      "max_reentry_reached"
    );

    if (CONFIG.POST_EXIT_CONTINUATION_REQUIRE_BULLISH_RAY_RECENCY) {
      reasonPush(rr, !bullishRayRecent(), "post_exit_cont_ray_not_recent");
    }

    reasonPush(
      rr,
      CONFIG.POST_EXIT_CONTINUATION_REQUIRE_EMA8_ABOVE_EMA18 && !emaBullOk,
      "post_exit_cont_ema_invalid"
    );

    const pctBelowEma8 =
      Number.isFinite(ema8) && Number.isFinite(close)
        ? -pctDiff(ema8, close)
        : NaN;

    const closeWithinEma8Tolerance =
      Number.isFinite(pctBelowEma8) &&
      pctBelowEma8 <= CONFIG.POST_EXIT_CONTINUATION_MAX_BELOW_EMA8_PCT;

    const postExitCloseAboveEma8Ok =
      !CONFIG.POST_EXIT_CONTINUATION_REQUIRE_CLOSE_ABOVE_EMA8
        ? closeAboveEma8Ok || closeWithinEma8Tolerance
        : closeAboveEma8Ok;

    reasonPush(
      rr,
      !postExitCloseAboveEma8Ok,
      "post_exit_cont_close_too_far_below_ema8"
    );

    const anchor = Number.isFinite(pec.anchorPrice) ? pec.anchorPrice : ema8;
    const chasePct = Number.isFinite(anchor) ? pctDiff(anchor, px) : 999;

    const strongPEC =
      Number.isFinite(rsi) &&
      Number.isFinite(adx) &&
      rsi >= CONFIG.POST_EXIT_CONTINUATION_STRONG_MIN_RSI &&
      adx >= CONFIG.POST_EXIT_CONTINUATION_STRONG_MIN_ADX &&
      extFromEma18 <= CONFIG.POST_EXIT_CONTINUATION_MAX_EXT_FROM_EMA18_PCT &&
      chasePct <= CONFIG.POST_EXIT_CONTINUATION_STRONG_MAX_CHASE_PCT &&
      (!strongNegativeFvvo ||
        (CONFIG.POST_EXIT_CONTINUATION_IGNORE_SNIPER_SELL_IF_STRONG &&
          !fv.snap.burstBearish));

    const minRsi = CONFIG.POST_EXIT_CONTINUATION_MIN_RSI;
    const minAdx = CONFIG.POST_EXIT_CONTINUATION_MIN_ADX;
    let maxChase = strongPEC
      ? CONFIG.POST_EXIT_CONTINUATION_STRONG_MAX_CHASE_PCT
      : CONFIG.POST_EXIT_CONTINUATION_MAX_CHASE_PCT;

    if (bullishFvvo) maxChase += CONFIG.FVVO_REENTRY_MAX_CHASE_BONUS_PCT;

    reasonPush(
      rr,
      Number.isFinite(rsi) && rsi < minRsi && !strongPEC,
      "post_exit_cont_rsi_too_low"
    );
    reasonPush(
      rr,
      Number.isFinite(adx) && adx < minAdx && !strongPEC,
      "post_exit_cont_adx_too_low"
    );
    reasonPush(
      rr,
      extFromEma18 > CONFIG.POST_EXIT_CONTINUATION_MAX_EXT_FROM_EMA18_PCT &&
        !strongPEC,
      "post_exit_cont_too_extended_from_ema18"
    );
    reasonPush(rr, chasePct > maxChase, "post_exit_cont_chase_too_high");
    reasonPush(
      rr,
      !CONFIG.POST_EXIT_CONTINUATION_ALLOW_FVVO_NEUTRAL &&
        fv.score === 0 &&
        !strongPEC,
      "post_exit_cont_fvvo_not_positive"
    );
    reasonPush(
      rr,
      CONFIG.POST_EXIT_CONTINUATION_BLOCK_ON_BURST_BEARISH &&
        fv.snap.burstBearish &&
        !strongPEC,
      "post_exit_cont_burst_bearish"
    );

    if (rr.length === 0) {
      return {
        allow: true,
        source,
        mode: strongPEC
          ? "post_exit_continuation_reentry_long_strong"
          : "post_exit_continuation_reentry_long",
        entryPrice: px,
        anchor: round4(anchor),
        chasePct,
        pctBelowEma8,
        strongPostExitContinuation: strongPEC,
        fvvo: fv,
      };
    }

    return {
      allow: false,
      source,
      reasons: rr,
      anchor: round4(anchor),
      chasePct,
      pctBelowEma8,
      strongPostExitContinuationCandidate: strongPEC,
      fvvo: fv,
    };
  }

  if (source === "feature_reentry" || (CONFIG.PHASE2_REENTRY_ENABLED && S.reentry.eligible)) {
    const rr = [];
    const useFast = CONFIG.FAST_REENTRY_ENABLED;

    reasonPush(
      rr,
      CONFIG.POST_EXIT_CONTINUATION_ENABLED && S.postExitContinuation.active,
      "post_exit_continuation_has_priority"
    );

    reasonPush(
      rr,
      (useFast
        ? CONFIG.FAST_REENTRY_REQUIRE_BULL_CONTEXT
        : CONFIG.REENTRY_REQUIRE_BULL_CONTEXT) && !S.ray.bullContext,
      "reentry_no_bull_context"
    );
    reasonPush(rr, S.reentry.bullRegimeId !== S.ray.bullRegimeId, "reentry_regime_mismatch");
    reasonPush(
      rr,
      S.ray.reentryCountInRegime >= CONFIG.MAX_REENTRIES_PER_BULL_REGIME,
      "max_reentry_reached"
    );
    reasonPush(rr, S.barIndex < n(S.reentry.eligibleFromBar, 0), "reentry_too_early");

    const reentryRequireCloseAboveEma8 = useFast
      ? CONFIG.FAST_REENTRY_REQUIRE_CLOSE_ABOVE_EMA8
      : CONFIG.REENTRY_REQUIRE_CLOSE_ABOVE_EMA8;

    const reentryCloseAboveEma8Ok =
      !reentryRequireCloseAboveEma8 ||
      (Number.isFinite(close) && Number.isFinite(ema8) && close >= ema8);

    const anchor = Number.isFinite(S.reentry.anchorPrice) ? S.reentry.anchorPrice : ema8;
    const reentryChasePct = Number.isFinite(anchor) ? pctDiff(anchor, px) : 999;

    const baseMaxReentryChase = useFast
      ? CONFIG.FAST_REENTRY_MAX_CHASE_PCT
      : CONFIG.REENTRY_MAX_CHASE_PCT;
    const minRsiBase = useFast ? CONFIG.FAST_REENTRY_MIN_RSI : CONFIG.MIN_RSI_LONG;
    const minRsi = Math.max(
      0,
      minRsiBase - (bullishFvvo ? CONFIG.FVVO_REENTRY_RSI_RELAX : 0)
    );
    const minAdx = useFast ? CONFIG.FAST_REENTRY_MIN_ADX : CONFIG.MIN_ADX_CONTINUATION;

    const strongReentryOverride =
      CONFIG.STRONG_REENTRY_OVERRIDE_ENABLED &&
      S.ray.bullContext &&
      emaBullOk &&
      reentryCloseAboveEma8Ok &&
      Number.isFinite(rsi) &&
      Number.isFinite(adx) &&
      rsi >= CONFIG.STRONG_REENTRY_MIN_RSI &&
      adx >= CONFIG.STRONG_REENTRY_MIN_ADX &&
      reentryChasePct <= CONFIG.STRONG_REENTRY_MAX_CHASE_PCT;

    let allowedReentryChase = strongReentryOverride
      ? CONFIG.STRONG_REENTRY_MAX_CHASE_PCT
      : baseMaxReentryChase;

    if (bullishFvvo) allowedReentryChase += CONFIG.FVVO_REENTRY_MAX_CHASE_BONUS_PCT;
    if (fv.snap.sniperSell) {
      allowedReentryChase -= CONFIG.FVVO_SNIPER_SELL_CHASE_PENALTY_PCT;
    }
    if (fv.snap.burstBearish) {
      allowedReentryChase -= CONFIG.FVVO_BURST_BEARISH_CHASE_PENALTY_PCT;
    }

    reasonPush(rr, !emaBullOk, "reentry_ema_invalid");
    reasonPush(rr, !reentryCloseAboveEma8Ok, "reentry_close_below_ema8");
    reasonPush(rr, Number.isFinite(rsi) && rsi < minRsi, "reentry_rsi_too_low");
    reasonPush(rr, Number.isFinite(adx) && adx < minAdx, "reentry_adx_too_low");
    reasonPush(rr, reentryChasePct > allowedReentryChase, "reentry_chase_too_high");

    if (rr.length === 0) {
      return {
        allow: true,
        source,
        mode: strongReentryOverride
          ? "feature_pullback_reclaim_reentry_long_strong"
          : "feature_pullback_reclaim_reentry_long",
        entryPrice: px,
        reentryChasePct,
        anchor: round4(anchor),
        bullRegimeId: S.ray.bullRegimeId,
        strongReentryOverride,
        fvvo: fv,
      };
    }

    return {
      allow: false,
      source,
      reasons: rr,
      reentryChasePct,
      anchor: round4(anchor),
      bullRegimeId: S.ray.bullRegimeId,
      strongReentryOverrideCandidate: strongReentryOverride,
      fvvo: fv,
    };
  }

  const contReasons = [];
  const contMinRsi = Math.max(
    0,
    CONFIG.MIN_RSI_LONG - (bullishFvvo ? CONFIG.FVVO_CONT_RSI_RELAX : 0)
  );

  let contMaxChase = CONFIG.CONTINUATION_MAX_CHASE_PCT;
  if (bullishFvvo) contMaxChase += CONFIG.FVVO_CONT_MAX_CHASE_BONUS_PCT;
  if (fv.snap.sniperSell) contMaxChase -= CONFIG.FVVO_SNIPER_SELL_CHASE_PENALTY_PCT;
  if (fv.snap.burstBearish) contMaxChase -= CONFIG.FVVO_BURST_BEARISH_CHASE_PENALTY_PCT;

  const contAnchor = Number.isFinite(ema8) ? ema8 : close;
  const contChasePct = Number.isFinite(contAnchor) ? pctDiff(contAnchor, px) : 999;

  reasonPush(contReasons, !emaBullOk, "ema8_below_ema18");
  reasonPush(contReasons, !closeAboveEma8Ok, "close_below_ema8");
  reasonPush(contReasons, Number.isFinite(rsi) && rsi < contMinRsi, "rsi_too_low");
  reasonPush(
    contReasons,
    Number.isFinite(adx) && adx < CONFIG.MIN_ADX_CONTINUATION,
    "adx_too_low"
  );
  reasonPush(
    contReasons,
    extFromEma8 > CONFIG.MAX_EXT_FROM_EMA8_PCT,
    "too_extended_from_ema8"
  );
  reasonPush(
    contReasons,
    extFromEma18 > CONFIG.MAX_EXT_FROM_EMA18_PCT,
    "too_extended_from_ema18"
  );
  reasonPush(contReasons, contChasePct > contMaxChase, "continuation_chase_too_high");

  if (contReasons.length === 0) {
    return {
      allow: true,
      source,
      mode: bullishFvvo
        ? "breakout_continuation_long_fvvo"
        : "breakout_continuation_long",
      entryPrice: px,
      extFromEma8,
      extFromEma18,
      contChasePct,
      fvvo: fv,
    };
  }

  const mem = S.breakoutMemory;
  const memReasons = [];
  const memActive = CONFIG.BREAKOUT_MEMORY_ENABLED && mem.active && !mem.used;

  reasonPush(memReasons, !memActive, "no_breakout_memory");

  const memAnchor = maxFinite(mem.reclaimPrice, mem.breakoutHigh);
  const memChasePct = Number.isFinite(memAnchor) ? pctDiff(memAnchor, px) : 999;

  if (
    CONFIG.BREAKOUT_MEMORY_REQUIRE_ABOVE_RECLAIM &&
    Number.isFinite(mem.reclaimPrice)
  ) {
    const reclaimFloor =
      mem.reclaimPrice * (1 - CONFIG.BREAKOUT_MEMORY_INVALIDATE_PCT / 100);
    reasonPush(memReasons, px < reclaimFloor, "below_memory_reclaim_floor");
  }

  let allowedMemoryChase = CONFIG.BREAKOUT_MEMORY_MAX_CHASE_PCT;
  if (bullishFvvo) allowedMemoryChase += CONFIG.FVVO_CONT_MAX_CHASE_BONUS_PCT;
  if (fv.snap.sniperSell) {
    allowedMemoryChase -= CONFIG.FVVO_SNIPER_SELL_CHASE_PENALTY_PCT;
  }
  if (fv.snap.burstBearish) {
    allowedMemoryChase -= CONFIG.FVVO_BURST_BEARISH_CHASE_PENALTY_PCT;
  }

  reasonPush(memReasons, memChasePct > allowedMemoryChase, "memory_chase_too_high");
  reasonPush(memReasons, !emaBullOk, "ema_bull_invalid");
  reasonPush(
    memReasons,
    extFromEma18 > CONFIG.MAX_EXT_FROM_EMA18_PCT,
    "too_extended_from_ema18"
  );

  if (memReasons.length === 0) {
    return {
      allow: true,
      source,
      mode: bullishFvvo
        ? "delayed_breakout_memory_long_fvvo"
        : "delayed_breakout_memory_long",
      entryPrice: px,
      memChasePct,
      memAnchor: round4(memAnchor),
      reclaimPrice: round4(mem.reclaimPrice),
      fvvo: fv,
    };
  }

  return {
    allow: false,
    source,
    reasons: [...contReasons, ...memReasons],
    extFromEma8,
    extFromEma18,
    contChasePct,
    memChasePct,
    fvvo: fv,
  };
}
function doEnter(mode, price, decision = {}, eventIso = isoNow()) {
  const stop = price * (1 - CONFIG.HARD_STOP_PCT / 100);

  S.inPosition = true;
  S.entryPrice = price;
  S.entryAt =
    CONFIG.REPLAY_USE_EVENT_TIME_FOR_POSITION_CLOCK && eventIso ? eventIso : isoNow();
  S.entryMode = mode;
  S.stopPrice = stop;
  S.beArmed = false;
  S.peakPrice = price;
  S.peakPnlPct = 0;
  S.dynamicTpTier = 0;
  S.lastEnterAtMs = actionClockMs(eventIso);
  S.lastAction = "enter";
  S.cycleState = "long";

  if (
    mode === "feature_pullback_reclaim_reentry_long" ||
    mode === "feature_pullback_reclaim_reentry_long_strong" ||
    mode === "post_exit_continuation_reentry_long" ||
    mode === "post_exit_continuation_reentry_long_strong"
  ) {
    S.ray.reentryCountInRegime += 1;
    clearReentry("consumed_on_reentry");
    clearPostExitContinuation("consumed_on_reentry");
  }

  if (
    mode === "bullish_trend_change_launch_long" ||
    mode === "bullish_trend_change_launch_long_strong" ||
    mode === "bullish_trend_change_launch_long_slow_ramp" ||
    mode === "tick_confirmed_launch_long" ||
    mode === "tick_confirmed_launch_long_strong"
  ) {
    clearTrendChangeLaunch("consumed_on_entry");
    clearFastTickLaunch("consumed_on_entry");
  }

  if (S.breakoutMemory.active) {
    S.breakoutMemory.used = true;
    clearBreakoutMemory("consumed_on_entry");
  }

  log("📥 ENTER", {
    brain: CONFIG.BRAIN_NAME,
    mode,
    price,
    stop,
    decision,
  });

  forward3Commas(
    "enter_long",
    price,
    {
      mode,
      setup_type: mode,
      brain: CONFIG.BRAIN_NAME,
    },
    eventIso
  ).catch((err) => {
    log("❌ 3COMMAS_ENTER_ERROR", { err: String(err?.message || err) });
  });
}

// --------------------------------------------------
// exit logic
// --------------------------------------------------
function currentDynamicTpTier(pnlPct) {
  if (!CONFIG.DYNAMIC_TP_ENABLED) return 0;
  if (pnlPct >= CONFIG.DTP_TIER3_ARM_PCT) return 3;
  if (pnlPct >= CONFIG.DTP_TIER2_ARM_PCT) return 2;
  if (pnlPct >= CONFIG.DTP_TIER1_ARM_PCT) return 1;
  return 0;
}
function dynamicTpGivebackForTier(tier) {
  if (tier === 3) return CONFIG.DTP_TIER3_GIVEBACK_PCT;
  if (tier === 2) return CONFIG.DTP_TIER2_GIVEBACK_PCT;
  if (tier === 1) return CONFIG.DTP_TIER1_GIVEBACK_PCT;
  return null;
}
function shouldBlockLaunchDynamicTp(feature, pnlPct, tier, fv) {
  if (!CONFIG.LAUNCH_TP_PROTECTION_ENABLED) return false;
  if (!isLaunchMode(S.entryMode)) return false;
  if (tier !== 1 || !CONFIG.LAUNCH_TP_PROTECTION_BLOCK_TIER1) return false;

  const adx = n(feature?.adx, NaN);
  const rsi = n(feature?.rsi, NaN);
  const close = n(feature?.close, NaN);
  const ema8 = n(feature?.ema8, NaN);

  const adxOk = Number.isFinite(adx) && adx >= CONFIG.LAUNCH_TP_PROTECTION_MIN_ADX;
  const rsiOk = Number.isFinite(rsi) && rsi >= CONFIG.LAUNCH_TP_PROTECTION_MIN_RSI;
  const profitTooEarly = pnlPct < CONFIG.LAUNCH_TP_PROTECTION_MIN_PROFIT_PCT;

  const priceAboveEma8Ok =
    !CONFIG.LAUNCH_TP_PROTECTION_REQUIRE_PRICE_ABOVE_EMA8 ||
    (Number.isFinite(close) && Number.isFinite(ema8) && close >= ema8);

  const bullishFvvoHold =
    CONFIG.LAUNCH_TP_PROTECTION_BLOCK_IF_BULLISH_FVVO && fv.score > 0;

  const block = profitTooEarly || ((adxOk && rsiOk && priceAboveEma8Ok) || bullishFvvoHold);

  if (CONFIG.LAUNCH_TP_PROTECTION_LOG) {
    log("🟦 LAUNCH_TP_PROTECTION_CHECK", {
      block,
      entryMode: S.entryMode,
      tier,
      pnlPct: round4(pnlPct),
      adx: round4(adx),
      rsi: round4(rsi),
      close: round4(close),
      ema8: round4(ema8),
      profitTooEarly,
      adxOk,
      rsiOk,
      priceAboveEma8Ok,
      bullishFvvoHold,
      fvvo: fv,
    });
  }

  return block;
}
function shouldBlockPostExitContinuationDynamicTp(feature, pnlPct, tier, fv) {
  if (!CONFIG.POST_EXIT_CONT_TP_PROTECTION_ENABLED) return false;
  if (!isProtectedContinuationMode(S.entryMode)) return false;
  if (tier !== 1 || !CONFIG.POST_EXIT_CONT_TP_PROTECTION_BLOCK_TIER1) return false;

  const adx = n(feature?.adx, NaN);
  const rsi = n(feature?.rsi, NaN);
  const close = n(feature?.close, NaN);
  const ema8 = n(feature?.ema8, NaN);

  const stillEarlyProfit =
    pnlPct < CONFIG.POST_EXIT_CONT_TP_PROTECTION_MAX_PROTECT_PROFIT_PCT;
  const adxOk = Number.isFinite(adx) && adx >= CONFIG.POST_EXIT_CONT_TP_PROTECTION_MIN_ADX;
  const rsiOk = Number.isFinite(rsi) && rsi >= CONFIG.POST_EXIT_CONT_TP_PROTECTION_MIN_RSI;

  const priceAboveEma8Ok =
    !CONFIG.POST_EXIT_CONT_TP_PROTECTION_REQUIRE_PRICE_ABOVE_EMA8 ||
    (Number.isFinite(close) && Number.isFinite(ema8) && close >= ema8);

  const bullishFvvoHold =
    CONFIG.POST_EXIT_CONT_TP_PROTECTION_BLOCK_IF_BULLISH_FVVO && fv.score > 0;

  const block =
    stillEarlyProfit &&
    adxOk &&
    rsiOk &&
    priceAboveEma8Ok &&
    !fv.snap.burstBearish &&
    !fv.snap.sniperSell &&
    (bullishFvvoHold || true);

  if (CONFIG.POST_EXIT_CONT_TP_PROTECTION_LOG) {
    log("🟪 POST_EXIT_CONT_TP_PROTECTION_CHECK", {
      block,
      entryMode: S.entryMode,
      tier,
      pnlPct: round4(pnlPct),
      adx: round4(adx),
      rsi: round4(rsi),
      close: round4(close),
      ema8: round4(ema8),
      stillEarlyProfit,
      adxOk,
      rsiOk,
      priceAboveEma8Ok,
      bullishFvvoHold,
      fvvo: fv,
    });
  }

  return block;
}
function shouldReentryTopHarvestExit(feature, pnlPct, fv) {
  if (!CONFIG.REENTRY_TOP_HARVEST_ENABLED) {
    return { allow: false, reason: "disabled" };
  }
  if (!isReentryHarvestMode(S.entryMode)) {
    return { allow: false, reason: "not_target_mode" };
  }

  const price = n(feature.close, NaN);
  const ema8 = n(feature.ema8, NaN);
  const ema18 = n(feature.ema18, NaN);
  const adx = n(feature.adx, NaN);
  const prev = S.prevFeature;

  if (!Number.isFinite(price) || !Number.isFinite(ema8) || !Number.isFinite(ema18)) {
    return { allow: false, reason: "bad_feature_values" };
  }

  const extFromEma8 = pctDiff(ema8, price);
  const extFromEma18 = pctDiff(ema18, price);
  const rsiHighRecent = recentRsiHigh(3);

  const rsiRolldown =
    Number.isFinite(prev?.rsi) &&
    Number.isFinite(feature.rsi) &&
    feature.rsi < prev.rsi;

  const oneWeakBar = wasWeakeningBar(feature, prev);
  const twoWeakBars = twoConsecutiveWeakeningBars();

  const bearishFvvoAccel =
    CONFIG.REENTRY_TOP_HARVEST_ALLOW_BEARISH_FVVO_ACCELERATOR &&
    (fv.score < 0 || fv.snap.sniperSell || fv.snap.burstBearish);

  const classicWeaknessOk =
    (CONFIG.REENTRY_TOP_HARVEST_ALLOW_TWO_WEAK_BARS && twoWeakBars) ||
    (CONFIG.REENTRY_TOP_HARVEST_ALLOW_ONE_WEAK_BAR && oneWeakBar) ||
    bearishFvvoAccel;

  const classicReasons = [];
  reasonPush(
    classicReasons,
    pnlPct < CONFIG.REENTRY_TOP_HARVEST_MIN_PROFIT_PCT,
    "profit_too_low"
  );
  reasonPush(
    classicReasons,
    !Number.isFinite(adx) || adx < CONFIG.REENTRY_TOP_HARVEST_MIN_ADX,
    "adx_too_low"
  );
  reasonPush(
    classicReasons,
    !Number.isFinite(rsiHighRecent) ||
      rsiHighRecent < CONFIG.REENTRY_TOP_HARVEST_MIN_RSI_RECENT_HIGH,
    "no_recent_rsi_high"
  );
  reasonPush(
    classicReasons,
    extFromEma8 < CONFIG.REENTRY_TOP_HARVEST_MIN_EXT_FROM_EMA8_PCT,
    "ext_from_ema8_too_low"
  );
  reasonPush(
    classicReasons,
    extFromEma18 < CONFIG.REENTRY_TOP_HARVEST_MIN_EXT_FROM_EMA18_PCT,
    "ext_from_ema18_too_low"
  );
  reasonPush(
    classicReasons,
    CONFIG.REENTRY_TOP_HARVEST_REQUIRE_RSI_ROLLDOWN && !rsiRolldown,
    "rsi_not_rolling_down"
  );
  reasonPush(classicReasons, !classicWeaknessOk, "weakness_not_confirmed");

  const classicAllow = classicReasons.length === 0;

  const softStrongNegativeFvvo = fv.snap.burstBearish || fv.score <= -2;
  const softFvvoOk =
    !CONFIG.REENTRY_TOP_HARVEST_SOFT_REQUIRE_BULLISH_FVVO_NOT_STRONG_NEGATIVE ||
    !softStrongNegativeFvvo;

  const softReasons = [];
  if (CONFIG.REENTRY_TOP_HARVEST_SOFT_ENABLED) {
    reasonPush(
      softReasons,
      pnlPct < CONFIG.REENTRY_TOP_HARVEST_SOFT_MIN_PROFIT_PCT,
      "soft_profit_too_low"
    );
    reasonPush(
      softReasons,
      (S.peakPnlPct || 0) < CONFIG.REENTRY_TOP_HARVEST_SOFT_MIN_PEAK_PROFIT_PCT,
      "soft_peak_profit_too_low"
    );
    reasonPush(
      softReasons,
      !Number.isFinite(adx) || adx < CONFIG.REENTRY_TOP_HARVEST_SOFT_MIN_ADX,
      "soft_adx_too_low"
    );
    reasonPush(
      softReasons,
      extFromEma8 < CONFIG.REENTRY_TOP_HARVEST_SOFT_MIN_EXT_FROM_EMA8_PCT,
      "soft_ext_from_ema8_too_low"
    );
    reasonPush(
      softReasons,
      extFromEma18 < CONFIG.REENTRY_TOP_HARVEST_SOFT_MIN_EXT_FROM_EMA18_PCT,
      "soft_ext_from_ema18_too_low"
    );
    reasonPush(
      softReasons,
      !softFvvoOk,
      "soft_strong_negative_fvvo"
    );
  } else {
    softReasons.push("soft_disabled");
  }

  const softAllow = softReasons.length === 0;

  const postExitSoftReasons = [];
  let postExitSoftAllow = false;
  if (isProtectedContinuationMode(S.entryMode) && CONFIG.POST_EXIT_CONT_HARVEST_SOFT_ENABLED) {
    const postExitFvvoOk =
      !CONFIG.POST_EXIT_CONT_HARVEST_SOFT_REQUIRE_NOT_STRONG_NEGATIVE_FVVO ||
      !softStrongNegativeFvvo;

    reasonPush(
      postExitSoftReasons,
      pnlPct < CONFIG.POST_EXIT_CONT_HARVEST_SOFT_MIN_PROFIT_PCT,
      "post_exit_soft_profit_too_low"
    );
    reasonPush(
      postExitSoftReasons,
      (S.peakPnlPct || 0) < CONFIG.POST_EXIT_CONT_HARVEST_SOFT_MIN_PEAK_PROFIT_PCT,
      "post_exit_soft_peak_profit_too_low"
    );
    reasonPush(
      postExitSoftReasons,
      !Number.isFinite(adx) || adx < CONFIG.POST_EXIT_CONT_HARVEST_SOFT_MIN_ADX,
      "post_exit_soft_adx_too_low"
    );
    reasonPush(
      postExitSoftReasons,
      extFromEma8 < CONFIG.POST_EXIT_CONT_HARVEST_SOFT_MIN_EXT_FROM_EMA8_PCT,
      "post_exit_soft_ext_from_ema8_too_low"
    );
    reasonPush(
      postExitSoftReasons,
      extFromEma18 < CONFIG.POST_EXIT_CONT_HARVEST_SOFT_MIN_EXT_FROM_EMA18_PCT,
      "post_exit_soft_ext_from_ema18_too_low"
    );
    reasonPush(
      postExitSoftReasons,
      !postExitFvvoOk,
      "post_exit_soft_strong_negative_fvvo"
    );

    postExitSoftAllow = postExitSoftReasons.length === 0;
  }

  let chosenPath = "none";
  let allow = false;

  if (classicAllow) {
    allow = true;
    chosenPath = "classic";
  } else if (postExitSoftAllow) {
    allow = true;
    chosenPath = "post_exit_soft";
  } else if (softAllow) {
    allow = true;
    chosenPath = "soft";
  }

  if (CONFIG.REENTRY_TOP_HARVEST_LOG_DEBUG) {
    log("🟠 REENTRY_TOP_HARVEST_CHECK", {
      allow,
      path: chosenPath,
      entryMode: S.entryMode,
      classicReasons,
      softReasons,
      postExitSoftReasons,
      pnlPct: round4(pnlPct),
      peakPnlPct: round4(S.peakPnlPct),
      dynamicTpTier: S.dynamicTpTier,
      adx: round4(adx),
      rsi: round4(feature.rsi),
      recentRsiHigh: round4(rsiHighRecent),
      extFromEma8: round4(extFromEma8),
      extFromEma18: round4(extFromEma18),
      rsiRolldown,
      oneWeakBar,
      twoWeakBars,
      bearishFvvoAccel,
      fvvo: fv,
    });
  }

  if (allow) {
    return {
      allow: true,
      path: chosenPath,
      extFromEma8,
      extFromEma18,
      recentRsiHigh: rsiHighRecent,
      rsiRolldown,
      oneWeakBar,
      twoWeakBars,
      bearishFvvoAccel,
    };
  }

  return {
    allow: false,
    reason:
      classicReasons[0] ||
      postExitSoftReasons[0] ||
      softReasons[0] ||
      "blocked",
    classicReasons,
    softReasons,
    postExitSoftReasons,
    extFromEma8,
    extFromEma18,
    recentRsiHigh: rsiHighRecent,
    rsiRolldown,
    oneWeakBar,
    twoWeakBars,
    bearishFvvoAccel,
  };
}
function updatePositionFromTick(price, eventIso = isoNow()) {
  if (!S.inPosition || !Number.isFinite(price) || !Number.isFinite(S.entryPrice)) return;

  if (!Number.isFinite(S.peakPrice) || price > S.peakPrice) S.peakPrice = price;

  const pnlPct = pctDiff(S.entryPrice, price);
  S.peakPnlPct = Math.max(S.peakPnlPct || 0, pnlPct);

  const tier = currentDynamicTpTier(S.peakPnlPct);
  if (tier > (S.dynamicTpTier || 0)) {
    S.dynamicTpTier = tier;
    log(`🎯 DYNAMIC_TP_TIER_${tier}_ARMED`, {
      pnlPct: round4(pnlPct),
      peakPnlPct: round4(S.peakPnlPct),
    });
  }

  if (!S.beArmed && pnlPct >= CONFIG.BREAKEVEN_ARM_PCT) {
    S.beArmed = true;
    const beStop = S.entryPrice * (1 + CONFIG.BREAKEVEN_OFFSET_PCT / 100);
    S.stopPrice = Math.max(S.stopPrice, beStop);
    log("🛡️ BREAKEVEN_ARMED", {
      pnlPct: round4(pnlPct),
      stopPrice: round4(S.stopPrice),
    });
  }

  if (price <= S.stopPrice) {
    const exitClass = S.beArmed ? "cycle_exit" : "stop_exit";
    return doExit("hard_or_breakeven_stop", price, eventIso, exitClass);
  }

  if (CONFIG.DYNAMIC_TP_ENABLED && S.dynamicTpTier > 0) {
    const giveback = dynamicTpGivebackForTier(S.dynamicTpTier);
    const peakPnl = S.peakPnlPct || 0;
    const pnlGiveback = peakPnl - pnlPct;
    const fv = getFvvoScore();
    const feature = S.lastFeature;

    if (Number.isFinite(giveback) && pnlGiveback >= giveback) {
      if (shouldBlockLaunchDynamicTp(feature, pnlPct, S.dynamicTpTier, fv)) {
        log("🟦 LAUNCH_TP_PROTECTION_BLOCKED_EXIT", {
          tier: S.dynamicTpTier,
          pnlPct: round4(pnlPct),
          peakPnlPct: round4(peakPnl),
          pnlGiveback: round4(pnlGiveback),
          entryMode: S.entryMode,
        });
        return;
      }

      if (shouldBlockPostExitContinuationDynamicTp(feature, pnlPct, S.dynamicTpTier, fv)) {
        log("🟪 POST_EXIT_CONT_TP_PROTECTION_BLOCKED_EXIT", {
          tier: S.dynamicTpTier,
          pnlPct: round4(pnlPct),
          peakPnlPct: round4(peakPnl),
          pnlGiveback: round4(pnlGiveback),
          entryMode: S.entryMode,
        });
        return;
      }

      return doExit(`dynamic_tp_tier${S.dynamicTpTier}_giveback`, price, eventIso, "cycle_exit");
    }
  } else {
    const drawFromPeakPct = Number.isFinite(S.peakPrice)
      ? -pctDiff(S.peakPrice, price)
      : 0;

    if (
      pnlPct >= CONFIG.PROFIT_LOCK_ARM_PCT &&
      drawFromPeakPct >= CONFIG.PROFIT_LOCK_GIVEBACK_PCT
    ) {
      return doExit("profit_lock_giveback", price, eventIso, "cycle_exit");
    }

    if (
      pnlPct >= CONFIG.TRAIL_ARM_PCT &&
      drawFromPeakPct >= CONFIG.TRAIL_GIVEBACK_PCT
    ) {
      return doExit("trail_giveback", price, eventIso, "cycle_exit");
    }
  }
}
function isStrongTrendHold(feature, fv) {
  const rsi = n(feature.rsi, NaN);
  const adx = n(feature.adx, NaN);
  if (!CONFIG.STRONG_TREND_HOLD_ENABLED) return false;
  if (!CONFIG.STRONG_TREND_HOLD_BLOCK_LOCAL_TP) return false;
  if (!Number.isFinite(rsi) || !Number.isFinite(adx)) return false;
  if (rsi < CONFIG.STRONG_TREND_HOLD_MIN_RSI) return false;
  if (adx < CONFIG.STRONG_TREND_HOLD_MIN_ADX) return false;
  if (CONFIG.STRONG_TREND_HOLD_BLOCK_IF_BEARISH_FVVO && fv.score < 0) return false;
  return true;
}
function shouldTopHarvestExit() {
  if (!CONFIG.TOP_HARVEST_ENABLED) return { allow: false, reason: "disabled" };
  return { allow: false, reason: "disabled_for_v44f" };
}
function evaluateBarExit(feature) {
  if (!S.inPosition) return;
  const price = n(feature.close, currentPrice());
  const pnlPct = pctDiff(S.entryPrice, price);
  const fv = getFvvoScore();
  const prev = S.prevFeature;

  const reentryHarvest = shouldReentryTopHarvestExit(feature, pnlPct, fv);
  if (reentryHarvest.allow) {
    return doExit("reentry_top_harvest_exit", price, feature.time, "cycle_exit");
  }

  const topHarvest = shouldTopHarvestExit(feature, pnlPct, fv);
  if (topHarvest.allow) {
    return doExit("cycle_top_harvest_exit", price, feature.time, "cycle_exit");
  }

  if (
    CONFIG.LOCAL_TP_EXIT_ENABLED &&
    CONFIG.LOCAL_TP_EXIT_ON_CLOSE_BELOW_EMA8 &&
    Number.isFinite(feature.ema8) &&
    pnlPct >= CONFIG.LOCAL_TP_MIN_PROFIT_PCT
  ) {
    const belowBufferedEma8 =
      price < feature.ema8 * (1 - CONFIG.LOCAL_TP_EMA8_BUFFER_PCT / 100);

    const belowEma18 =
      Number.isFinite(feature.ema18) && price < feature.ema18;

    const oneWeakBar = wasWeakeningBar(feature, prev);
    const twoWeakBars = twoConsecutiveWeakeningBars();

    const holdByStrength =
      Number.isFinite(feature.rsi) &&
      feature.rsi >= CONFIG.LOCAL_TP_MIN_RSI_TO_HOLD &&
      Number.isFinite(feature.adx) &&
      feature.adx >= CONFIG.LOCAL_TP_MIN_ADX_TO_HOLD;

    const holdByBullishFvvo =
      CONFIG.LOCAL_TP_BLOCK_IF_BULLISH_FVVO && fv.score > 0;

    const strongTrendHold = isStrongTrendHold(feature, fv);

    const rsiWeakEnough =
      Number.isFinite(feature.rsi) &&
      feature.rsi <=
        (Number.isFinite(feature.adx) && feature.adx >= CONFIG.LOCAL_TP_STRONG_ADX_HARD_BLOCK
          ? CONFIG.LOCAL_TP_RSI_WEAKNESS_THRESHOLD_STRONG_TREND
          : CONFIG.LOCAL_TP_RSI_WEAKNESS_THRESHOLD);

    const forceAllowByEma18 =
      CONFIG.LOCAL_TP_FORCE_ALLOW_IF_CLOSE_BELOW_EMA18 && belowEma18;

    const forceAllowByBearishFvvo =
      CONFIG.LOCAL_TP_FORCE_ALLOW_IF_BEARISH_FVVO && fv.score < 0;

    const forceAllowByWeakBars =
      CONFIG.LOCAL_TP_FORCE_ALLOW_ON_TWO_WEAKENING_BARS && twoWeakBars;

    const needsExtraConfirmation =
      CONFIG.LOCAL_TP_REQUIRE_CLOSE_BELOW_EMA18_OR_2_WEAK_BARS;

    const extraConfirmationOk =
      !needsExtraConfirmation || belowEma18 || twoWeakBars || rsiWeakEnough;

    const hardBlockByStrongAdx =
      Number.isFinite(feature.adx) &&
      feature.adx >= CONFIG.LOCAL_TP_STRONG_ADX_HARD_BLOCK &&
      !forceAllowByEma18 &&
      !forceAllowByBearishFvvo &&
      !forceAllowByWeakBars &&
      !rsiWeakEnough;

    const strongTrendNeedsTwoWeakBars =
      CONFIG.LOCAL_TP_REQUIRE_TWO_WEAKENING_BARS_IN_STRONG_TREND &&
      Number.isFinite(feature.adx) &&
      feature.adx >= CONFIG.LOCAL_TP_STRONG_ADX_HARD_BLOCK &&
      !twoWeakBars &&
      !belowEma18 &&
      !rsiWeakEnough;

    const strongTrendHardHoldActive =
      CONFIG.LOCAL_TP_STRONG_TREND_HARD_HOLD_ENABLED &&
      Number.isFinite(feature.adx) &&
      feature.adx >= CONFIG.LOCAL_TP_STRONG_TREND_HARD_HOLD_MIN_ADX &&
      (!CONFIG.LOCAL_TP_STRONG_TREND_HARD_HOLD_REQUIRE_EMA8_ABOVE_EMA18 ||
        (Number.isFinite(feature.ema8) &&
          Number.isFinite(feature.ema18) &&
          feature.ema8 > feature.ema18)) &&
      (!Number.isFinite(feature.rsi) ||
        feature.rsi >= CONFIG.LOCAL_TP_STRONG_TREND_HARD_HOLD_REQUIRE_RSI_ABOVE);

    const strongTrendHardHoldCanExitByWeakness =
      (CONFIG.LOCAL_TP_STRONG_TREND_ALLOW_ONLY_IF_CLOSE_BELOW_EMA18 && belowEma18) ||
      (CONFIG.LOCAL_TP_STRONG_TREND_ALLOW_IF_TWO_WEAK_BARS_AND_RSI_WEAK &&
        twoWeakBars &&
        Number.isFinite(feature.rsi) &&
        feature.rsi <= CONFIG.LOCAL_TP_STRONG_TREND_RSI_WEAK_MAX) ||
      forceAllowByBearishFvvo;

    const blockedByStrongTrendHardHold =
      strongTrendHardHoldActive && !strongTrendHardHoldCanExitByWeakness;

    const strictStrongTrendGateActive =
      CONFIG.LOCAL_TP_STRICT_STRONG_TREND_GATE_ENABLED &&
      Number.isFinite(feature.adx) &&
      feature.adx >= CONFIG.LOCAL_TP_STRICT_STRONG_TREND_MIN_ADX &&
      (!CONFIG.LOCAL_TP_STRICT_STRONG_TREND_REQUIRE_EMA8_GT_EMA18 ||
        (Number.isFinite(feature.ema8) &&
          Number.isFinite(feature.ema18) &&
          feature.ema8 > feature.ema18));

    const strictStrongTrendAllowsExit =
      belowEma18 ||
      (
        CONFIG.LOCAL_TP_STRICT_STRONG_TREND_ALLOW_TWO_WEAK_BARS_AND_RSI_WEAK &&
        (!CONFIG.LOCAL_TP_STRICT_STRONG_TREND_REQUIRE_TWO_WEAK_BARS || twoWeakBars) &&
        Number.isFinite(feature.rsi) &&
        feature.rsi <= CONFIG.LOCAL_TP_STRICT_STRONG_TREND_RSI_WEAK_MAX
      ) ||
      forceAllowByBearishFvvo;

    const blockedByStrictStrongTrendGate =
      strictStrongTrendGateActive && !strictStrongTrendAllowsExit;

    if (
      belowBufferedEma8 &&
      oneWeakBar &&
      extraConfirmationOk &&
      !holdByStrength &&
      !holdByBullishFvvo &&
      !strongTrendHold &&
      !hardBlockByStrongAdx &&
      !strongTrendNeedsTwoWeakBars &&
      !blockedByStrongTrendHardHold &&
      !blockedByStrictStrongTrendGate
    ) {
      return doExit("local_tp_close_below_ema8", price, feature.time, "cycle_exit");
    }
  }

  if (
    CONFIG.EXIT_ON_5M_CLOSE_BELOW_EMA18 &&
    Number.isFinite(feature.ema18) &&
    price < feature.ema18
  ) {
    return doExit("close_below_ema18_5m", price, feature.time, "regime_break");
  }
}
function markReentryEligible(reason, exitPrice, exitPnlPct, peakBeforeExit) {
  if (!CONFIG.PHASE2_REENTRY_ENABLED) return;
  if (!CONFIG.KEEP_BULL_CONTEXT_ON_TP_EXIT) return;
  if (!S.ray.bullContext) return;
  if (S.ray.reentryCountInRegime >= CONFIG.MAX_REENTRIES_PER_BULL_REGIME) return;

  const anchor = Number.isFinite(S.lastFeature?.ema8)
    ? S.lastFeature.ema8
    : Number.isFinite(exitPrice)
    ? exitPrice
    : peakBeforeExit;

  S.reentry = {
    eligible: true,
    eligibleUntilBar: S.barIndex + 6,
    eligibleFromBar: S.barIndex + CONFIG.REENTRY_MIN_BARS_AFTER_EXIT,
    exitPrice,
    peakBeforeExit,
    anchorPrice: anchor,
    bullRegimeId: S.ray.bullRegimeId,
  };

  S.cycleState = "tp_exit_wait_reentry";

  log("🔁 TP_EXIT_WAIT_REENTRY", {
    reason,
    bullRegimeId: S.ray.bullRegimeId,
    reentryCountInRegime: S.ray.reentryCountInRegime,
    eligibleFromBar: S.reentry.eligibleFromBar,
    eligibleUntilBar: S.reentry.eligibleUntilBar,
    peakBeforeExit: round4(peakBeforeExit),
    anchorPrice: round4(anchor),
  });

  armPostExitContinuation(reason, exitPrice, exitPnlPct, peakBeforeExit);
}
function doExit(reason, price, ts, exitClass = "stop_exit") {
  if (!S.inPosition) return;
  if (!canExitByDedup(ts)) {
    log("⏸️ EXIT_DEDUP_BLOCKED", {
      reason,
      ts,
      entryMode: S.entryMode,
      lastExitAtMs: S.lastExitAtMs,
      attemptClockMs: actionClockMs(ts),
      exitDedupMs: CONFIG.EXIT_DEDUP_MS,
    });
    return;
  }

  const exitPrice = Number.isFinite(price) ? price : currentPrice();
  const pnlPct =
    Number.isFinite(exitPrice) && Number.isFinite(S.entryPrice)
      ? pctDiff(S.entryPrice, exitPrice)
      : 0;

  const peakBeforeExit = getExitPeakSnapshot(exitPrice);

  const exitMs = actionClockMs(ts);
  const entryMs = parseTsMs(S.entryAt);

  log("📤 EXIT", {
    reason,
    exitClass,
    price: round4(exitPrice),
    pnlPct: round4(pnlPct),
    entryPrice: round4(S.entryPrice),
    entryMode: S.entryMode,
    peakBeforeExit: round4(peakBeforeExit),
    heldSec:
      Number.isFinite(entryMs) && Number.isFinite(exitMs)
        ? Math.max(0, Math.round((exitMs - entryMs) / 1000))
        : null,
  });

  forward3Commas(
    "exit_long",
    exitPrice,
    {
      reason,
      brain: CONFIG.BRAIN_NAME,
      entry_mode: S.entryMode,
    },
    ts
  ).catch((err) => {
    log("❌ 3COMMAS_EXIT_ERROR", { err: String(err?.message || err) });
  });

  if (exitClass === "cycle_exit") {
    markReentryEligible(reason, exitPrice, pnlPct, peakBeforeExit);
  } else {
    clearReentry("non_cycle_exit");
    clearPostExitContinuation("non_cycle_exit");
  }

  if (exitClass === "regime_break") turnBullRegimeOff(ts, reason);

  S.inPosition = false;
  S.entryPrice = null;
  S.entryAt = null;
  S.entryMode = null;
  S.stopPrice = null;
  S.beArmed = false;
  S.peakPrice = null;
  S.peakPnlPct = 0;
  S.dynamicTpTier = 0;
  S.lastExitAtMs = actionClockMs(ts);
  S.lastAction = "exit";
  S.lastExitClass = exitClass;
  S.lastExitReason = reason;

  if (exitClass === "cycle_exit") {
    S.cooldownUntilMs = 0;
  } else {
    S.cooldownUntilMs = actionClockMs(ts) + CONFIG.EXIT_COOLDOWN_MIN * 60 * 1000;
    S.cycleState = "cooldown_hard";
  }
}

// --------------------------------------------------
// 3Commas forwarding
// --------------------------------------------------
async function forward3Commas(action, triggerPrice, meta = {}, eventIso = isoNow()) {
  if (!CONFIG.ENABLE_HTTP_FORWARD) {
    log("📦 SIGNAL_PREVIEW", { action, triggerPrice, meta, enabled: false });
    return;
  }
  if (!fetchFn) {
    log("⚠️ FETCH_UNAVAILABLE", { action });
    return;
  }

  const botUuid = getBotUuid(CONFIG.SYMBOL);
  if (!CONFIG.C3_SIGNAL_URL || !CONFIG.C3_SIGNAL_SECRET || !botUuid) {
    log("⚠️ 3COMMAS_CONFIG_MISSING", {
      hasUrl: !!CONFIG.C3_SIGNAL_URL,
      hasSecret: !!CONFIG.C3_SIGNAL_SECRET,
      hasBotUuid: !!botUuid,
    });
    return;
  }

  const { tv_exchange, tv_instrument } = symbolParts(CONFIG.SYMBOL);

  const payload = {
    secret: CONFIG.C3_SIGNAL_SECRET,
    bot_uuid: botUuid,
    max_lag: String(CONFIG.MAX_LAG_SEC),
    timestamp: eventIso || isoNow(),
    trigger_price: String(triggerPrice),
    tv_exchange,
    tv_instrument,
    action,
    meta,
  };

  log("📦 SIGNAL_PREVIEW", payload);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), CONFIG.C3_TIMEOUT_MS);

  try {
    const res = await fetchFn(CONFIG.C3_SIGNAL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await res.text().catch(() => "");
    log("✅ 3COMMAS_RESP", {
      action,
      status: res.status,
      ok: res.ok,
      body: text.slice(0, 500),
    });
  } finally {
    clearTimeout(t);
  }
}

// --------------------------------------------------
// secrets
// --------------------------------------------------
function checkSecret(body) {
  const inbound = String(body.secret || "");
  const src = String(body.src || "").toLowerCase();

  if (src === "tick") {
    if (!CONFIG.TICKROUTER_SECRET) return true;
    return inbound === CONFIG.TICKROUTER_SECRET;
  }

  if (!CONFIG.WEBHOOK_SECRET) return true;
  return inbound === CONFIG.WEBHOOK_SECRET;
}

// --------------------------------------------------
// tick handling
// --------------------------------------------------
function handleTick(body) {
  const ts = pickFirst(body, ["time", "timestamp"], isoNow());
  const px = n(body.price, NaN);
  if (!Number.isFinite(px)) throw new Error("bad_tick_price");

  S.lastTickPrice = px;
  S.lastTickTime = ts;
  S.tickCount += 1;

  invalidateFastTickLaunch();

  if (S.fastTickLaunch.active && !S.inPosition) {
    if (px >= n(S.fastTickLaunch.confirmPrice, Infinity)) {
      S.fastTickLaunch.ticksAboveConfirm += 1;
      S.fastTickLaunch.lastConfirmedTickPrice = px;

      log("⚡ FAST_TICK_CONFIRM", {
        price: px,
        ticksAboveConfirm: S.fastTickLaunch.ticksAboveConfirm,
        confirmPrice: round4(S.fastTickLaunch.confirmPrice),
      });

      tryEntry("tick_confirmed_fast_launch", {
        src: "tick",
        symbol: CONFIG.SYMBOL,
        tf: CONFIG.ENTRY_TF,
        price: px,
        time: ts,
      });
    }
  }

  updatePositionFromTick(px, ts);

  return {
    ok: true,
    kind: "tick",
    price: px,
    inPosition: S.inPosition,
  };
}

// --------------------------------------------------
// routes
// --------------------------------------------------
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    brain: CONFIG.BRAIN_NAME,
    symbol: CONFIG.SYMBOL,
    tf: CONFIG.ENTRY_TF,
    startedAt: S.startedAt,
  });
});

app.get("/status", (_req, res) => {
  res.json({
    ok: true,
    brain: CONFIG.BRAIN_NAME,
    symbol: CONFIG.SYMBOL,
    tf: CONFIG.ENTRY_TF,
    inPosition: S.inPosition,
    entryPrice: S.entryPrice,
    entryAt: S.entryAt,
    entryMode: S.entryMode,
    stopPrice: S.stopPrice,
    peakPrice: S.peakPrice,
    peakPnlPct: S.peakPnlPct,
    dynamicTpTier: S.dynamicTpTier,
    cooldownUntil: S.cooldownUntilMs
      ? new Date(S.cooldownUntilMs).toISOString()
      : null,
    bullContext: S.ray.bullContext,
    bullRegimeId: S.ray.bullRegimeId,
    reentryCountInRegime: S.ray.reentryCountInRegime,
    cycleState: S.cycleState,
    lastExitClass: S.lastExitClass,
    lastExitReason: S.lastExitReason,
    reentry: S.reentry,
    postExitContinuation: S.postExitContinuation,
    trendChangeLaunch: S.trendChangeLaunch,
    fastTickLaunch: S.fastTickLaunch,
    rayConflict: S.rayConflict,
    lastTickPrice: S.lastTickPrice,
    lastTickTime: S.lastTickTime,
    tickFresh: isTickFresh(),
    lastFeatureTime: S.lastFeatureTime,
    featureFresh: isFeatureFresh(),
    breakoutMemory: S.breakoutMemory,
    ray: S.ray,
    fvvo: S.fvvo,
    fvvoScore: getFvvoScore(),
    barIndex: S.barIndex,
    replayAllowStaleData: CONFIG.REPLAY_ALLOW_STALE_DATA,
    replayUseEventTimeForPositionClock:
      CONFIG.REPLAY_USE_EVENT_TIME_FOR_POSITION_CLOCK,
    recentLogs: S.logs.slice(-100),
  });
});

app.post("/reset", (req, res) => {
  const body = req.body || {};
  if (!checkSecret({ ...body, src: "admin" })) {
    log("⛔ RESET_UNAUTHORIZED");
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const reason = String(body.reason || "manual_reset");
  resetRuntimeState(reason);

  return res.json({
    ok: true,
    reset: true,
    reason,
    brain: CONFIG.BRAIN_NAME,
    symbol: CONFIG.SYMBOL,
    tf: CONFIG.ENTRY_TF,
  });
});

app.post(CONFIG.WEBHOOK_PATH, (req, res) => {
  const body = req.body || {};

  if (!checkSecret(body)) {
    log("⛔ UNAUTHORIZED", { src: body.src, symbol: body.symbol });
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const symbol = normalizeSymbol(pickFirst(body, ["symbol"], CONFIG.SYMBOL));
  if (symbol !== CONFIG.SYMBOL) {
    log("🚫 SYMBOL_REJECTED", { got: symbol, want: CONFIG.SYMBOL });
    return res.status(400).json({
      ok: false,
      error: "symbol_mismatch",
      got: symbol,
      want: CONFIG.SYMBOL,
    });
  }

  const parsed = parseInboundType(body);

  try {
    if (parsed.family === "tick") {
      return res.json(handleTick(body));
    }

    if (parsed.family === "feature") {
      handleFeature(body);
      return res.json({
        ok: true,
        kind: "feature",
        barIndex: S.barIndex,
        inPosition: S.inPosition,
      });
    }

    if (parsed.family === "ray") {
      handleRayEvent(body);
      return res.json({
        ok: true,
        kind: "ray",
        event: parsed.name,
        bullContext: S.ray.bullContext,
        inPosition: S.inPosition,
      });
    }

    if (parsed.family === "fvvo") {
      handleFvvoEvent(body);
      return res.json({
        ok: true,
        kind: "fvvo",
        event: parsed.name,
        fvvoScore: getFvvoScore(),
      });
    }

    log("❓ UNKNOWN_EVENT", body);
    return res.json({ ok: true, kind: "unknown_ignored" });
  } catch (err) {
    log("💥 WEBHOOK_ERROR", { err: String(err?.stack || err) });
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.listen(CONFIG.PORT, () => {
  log("✅ brain listening", {
    port: CONFIG.PORT,
    path: CONFIG.WEBHOOK_PATH,
    symbol: CONFIG.SYMBOL,
    tf: CONFIG.ENTRY_TF,
    brain: CONFIG.BRAIN_NAME,
  });
});
