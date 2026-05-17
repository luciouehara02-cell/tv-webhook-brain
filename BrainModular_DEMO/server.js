import express from "express";

import { CONFIG } from "./src/config.js";
import { getRootStatus, getStatus, resetBrain, handleWebhook } from "./src/brain.js";
import { log } from "./src/stateStore.js";
import { s } from "./src/utils.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json(getRootStatus());
});

app.get("/health", (_req, res) => {
  res.json(getRootStatus());
});

app.get("/status", (_req, res) => {
  res.json(getStatus());
});

app.post("/reset", (req, res) => {
  const reason = s(req.body?.reason, "manual_reset");
  res.json(resetBrain(reason));
});

app.post(CONFIG.WEBHOOK_PATH, (req, res) => {
  const result = handleWebhook(req.body || {});
  res.status(result.status || 200).json(result.json);
});

app.listen(CONFIG.PORT, () => {
  log("✅ brain listening", { port: CONFIG.PORT, path: CONFIG.WEBHOOK_PATH, symbol: CONFIG.SYMBOL, tf: CONFIG.ENTRY_TF, brain: CONFIG.BRAIN_NAME });
  log("🧠 CONFIG_SNAPSHOT", {
    brain: CONFIG.BRAIN_NAME,
    port: CONFIG.PORT,
    path: CONFIG.WEBHOOK_PATH,
    symbol: CONFIG.SYMBOL,
    tf: CONFIG.ENTRY_TF,
    enableHttpForward: CONFIG.ENABLE_HTTP_FORWARD,
    replayAllowStaleData: CONFIG.REPLAY_ALLOW_STALE_DATA,
    replayUseEventTimeForPositionClock: CONFIG.REPLAY_USE_EVENT_TIME_FOR_POSITION_CLOCK,
    firstEntry: {
      enabled: CONFIG.FIRST_ENTRY_ENGINE_ENABLED,
      immediateMaxChasePct: CONFIG.FIRST_ENTRY_IMMEDIATE_MAX_CHASE_PCT,
      immediateMinRsi: CONFIG.FIRST_ENTRY_IMMEDIATE_MIN_RSI,
      immediateMinAdx: CONFIG.FIRST_ENTRY_IMMEDIATE_MIN_ADX,
      confirmEnabled: CONFIG.FIRST_ENTRY_CONFIRM_ENABLED,
      confirmWindowSec: CONFIG.FIRST_ENTRY_CONFIRM_WINDOW_SEC,
      confirmMinAdx: CONFIG.FIRST_ENTRY_CONFIRM_MIN_ADX,
      weakBlockEnabled: CONFIG.FIRST_ENTRY_WEAK_BLOCK_ENABLED,
    },
    firstEntryFailFast: {
      enabled: CONFIG.FIRST_ENTRY_FAIL_FAST_ENABLED,
      bars: CONFIG.FIRST_ENTRY_FAIL_FAST_BARS,
      minHeldSec: CONFIG.FIRST_ENTRY_FAIL_FAST_MIN_HELD_SEC,
      maxHeldSec: CONFIG.FIRST_ENTRY_FAIL_FAST_MAX_HELD_SEC,
      rsiBelow: CONFIG.FIRST_ENTRY_FAIL_FAST_RSI_BELOW,
      minLossPct: CONFIG.FIRST_ENTRY_FAIL_FAST_MIN_LOSS_PCT,
      exitIfCloseBelowEma18: CONFIG.FIRST_ENTRY_FAIL_FAST_EXIT_IF_CLOSE_BELOW_EMA18,
      exitIfCloseBelowEma8: CONFIG.FIRST_ENTRY_FAIL_FAST_EXIT_IF_CLOSE_BELOW_EMA8,
    },
    postExitProfitGuard: {
      enabled: CONFIG.POST_EXIT_CONT_PROFIT_GUARD_ENABLED,
      armPeakPct: CONFIG.POST_EXIT_CONT_PROFIT_GUARD_ARM_PEAK_PCT,
      lockPct: CONFIG.POST_EXIT_CONT_PROFIT_GUARD_LOCK_PCT,
      givebackPct: CONFIG.POST_EXIT_CONT_PROFIT_GUARD_GIVEBACK_PCT,
      minCurrentPct: CONFIG.POST_EXIT_CONT_PROFIT_GUARD_MIN_CURRENT_PCT,
    },
  });
});
