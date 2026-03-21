export const CONFIG = {
  BRAIN_VERSION: "Brain Phase 5 v5.0",
  SYMBOL: "BINANCE:SOLUSDT",
  TF: "3",

  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "",
  PORT: Number(process.env.PORT || 8080),

  // Regime
  REGIME_ADX_TREND_MIN: 20,
  REGIME_ADX_RANGE_MAX: 14,
  REGIME_ATRPCT_MIN: 0.18,

  // Breakout lifecycle
  BREAKOUT_ENABLED: true,
  BREAKOUT_MIN_SCORE: 7,
  BREAKOUT_MIN_IMPULSE_PCT: 0.18,
  BREAKOUT_RETEST_TOLERANCE_PCT: 0.15,
  BREAKOUT_CONFIRM_BOUNCE_PCT: 0.08,
  BREAKOUT_MAX_RETEST_BARS: 4,
  BREAKOUT_SETUP_EXPIRY_BARS: 6,

  // Validation
  MAX_ENTRY_EXTENSION_FROM_EMA18_PCT: 0.70,
  MAX_ENTRY_EXTENSION_FROM_TRIGGER_PCT: 0.35,
  ALLOW_ENTRY_ON_BOUNCE_CONFIRMED: true,

  // Execution mode
  EXECUTION_MODE: process.env.EXECUTION_MODE || "dry_run", // dry_run | live
  DRY_RUN_EXECUTION_ENABLED: true,

  // Live guardrails
  LIVE_EXECUTION_ENABLED: process.env.LIVE_EXECUTION_ENABLED === "true",
  LIVE_MANUAL_ARMING_ENABLED: process.env.LIVE_MANUAL_ARMING_ENABLED === "true",
  ALLOW_ONLY_ONE_ENTRY_PER_SETUP: true,
  ENTRY_COOLDOWN_BARS: 3,

  // 3Commas
  C3_WEBHOOK_URL:
    process.env.C3_WEBHOOK_URL ||
    "https://api.3commas.io/signal_bots/webhooks",
  C3_SIGNAL_SECRET: process.env.C3_SIGNAL_SECRET || "",
  C3_BOT_UUID: process.env.C3_BOT_UUID || "",
  C3_MAX_LAG_SEC: Number(process.env.C3_MAX_LAG_SEC || 300),

  // Position size
  C3_ENTRY_AMOUNT: process.env.C3_ENTRY_AMOUNT || "199",
  C3_ENTRY_CURRENCY_TYPE:
    process.env.C3_ENTRY_CURRENCY_TYPE || "quote", // quote | base
  C3_RISK_MODE: process.env.C3_RISK_MODE || "fixed", // fixed | dynamic

  // Position management
  INIT_STOP_ATR_MULT: 1.8,
  INIT_STOP_EMA_BUFFER_ATR_MULT: 0.3,
  BREAKEVEN_ARM_PCT: 0.35,
  TRAILING_START_PCT: 0.55,
  TRAILING_ATR_MULT: 1.4,
  PROFIT_LOCK_ARM_PCT: 0.9,
  PROFIT_LOCK_GIVEBACK_PCT: 0.35,
  EXIT_ON_CLOSE_BELOW_EMA18: true,

  // Debug
  LOG_FULL_STATE_ON_TRANSITIONS: true,
  LOG_SIGNAL_PAYLOADS: true,
};
