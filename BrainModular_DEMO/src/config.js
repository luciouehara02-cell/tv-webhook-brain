import { normalizeSymbol, n } from "./utils.js";
const env = process.env;
export const CONFIG = Object.freeze({
  NAME: "BrainSwing_LongRun_v1a_BNB_SHADOW",
  PORT: n(env.PORT, 3000), SYMBOL: normalizeSymbol(env.SYMBOL || "BNBUSDT"), WEBHOOK_SECRET: env.WEBHOOK_SECRET || "CHANGE_ME",
  ENABLE_HTTP_FORWARD: String(env.ENABLE_HTTP_FORWARD || "false").toLowerCase() === "true",
  C3_SIGNAL_URL: env.C3_SIGNAL_URL || "", C3_SIGNAL_SECRET: env.C3_SIGNAL_SECRET || "", C3_BOT_UUID: env.C3_BOT_UUID || "",
  C3_TIMEOUT_MS: n(env.C3_TIMEOUT_MS, 8000), MAX_LAG_SEC: n(env.MAX_LAG_SEC, 300),
  STATE_FILE: env.STATE_FILE || "/data/brainswing-longrun-v1a-state.json", DEBUG: String(env.DEBUG || "true").toLowerCase() === "true",
  FEE_ROUND_TRIP_PCT: n(env.FEE_ROUND_TRIP_PCT, 0.15), CAMPAIGN_MAX_HOURS: n(env.CAMPAIGN_MAX_HOURS, 168),
  FOUR_H_MAX_AGE_SEC: 18000, ONE_H_MAX_AGE_SEC: 5400, FIFTEEN_M_MAX_AGE_SEC: 1800, SETUP_TTL_MIN: 180,
  STOP_ATR_MULT: 1.6, STOP_MIN_PCT: 1.25, STOP_MAX_PCT: 2.75, MAX_ENTRY_EXTENSION_ATR: 0.7,
  ENTRY_DEDUP_MS: 30 * 60 * 1000, EXIT_DEDUP_MS: 60 * 1000, EVENT_DEDUP_LIMIT: 2000
});
