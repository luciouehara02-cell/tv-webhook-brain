export const CONFIG = {
  BRAIN_VERSION: "Brain Phase 5 v5.0",
  SYMBOL: "BINANCE:SOLUSDT",
  TF: "3",

  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "",

  REGIME_ADX_TREND_MIN: 20,
  REGIME_ADX_RANGE_MAX: 14,
  REGIME_ATRPCT_MIN: 0.18,

  PORT: Number(process.env.PORT || 8080),
};
