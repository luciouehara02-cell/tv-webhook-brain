process.env.BRAIN_NAME = "BrainRAY_Continuation_v6.6e_ATR_STRUCTURE_SYNC_ADAPTIVE_TP_RESET_REENTRY_TEST";
process.env.ENABLE_HTTP_FORWARD = "false";
process.env.REPLAY_ALLOW_STALE_DATA = "true";
process.env.REPLAY_USE_EVENT_TIME_FOR_POSITION_CLOCK = "true";
process.env.FORWARD_EXIT_WHEN_FLAT = "false";
process.env.FIRST_ENTRY_ENGINE_ENABLED = "true";
process.env.FIRST_ENTRY_IMMEDIATE_MIN_RSI = "55";
process.env.FIRST_ENTRY_IMMEDIATE_MIN_ADX = "14";
process.env.FIRST_ENTRY_FEATURE_SYNC_ENABLED = "true";
process.env.FIRST_ENTRY_FEATURE_SYNC_GRACE_SEC = "10";
process.env.FIRST_ENTRY_FEATURE_SYNC_MIN_FEATURE_LAG_SEC = "240";
process.env.FIRST_ENTRY_CONFIRM_UPGRADE_ENABLED = "true";
process.env.FIRST_ENTRY_CONFIRM_UPGRADE_GRACE_SEC = "10";
process.env.FIRST_ENTRY_CONFIRM_UPGRADE_MIN_RSI = "60";
process.env.FIRST_ENTRY_CONFIRM_UPGRADE_MIN_ADX = "14";
process.env.FIRST_ENTRY_CONFIRM_MIN_TICKS = "2";
process.env.FIRST_ENTRY_CONFIRM_STRONG_FEATURE_TICKS = "1";
process.env.FIRST_ENTRY_CONFIRM_STRONG_MIN_RSI = "60";
process.env.FIRST_ENTRY_CONFIRM_STRONG_MIN_ADX = "14";
process.env.ATR_STRUCTURE_STOP_ENABLED = "true";
process.env.ATR_STOP_APPLY_FIRST_ENTRY = "true";
process.env.ATR_STOP_APPLY_REENTRY = "true";
process.env.ATR_STOP_APPLY_OTHER_MODES = "false";
process.env.ATR_STRUCTURE_USE_RECENT_LOW = "false";
process.env.ATR_STOP_MULT_FIRST_ENTRY = "2.2";
process.env.ATR_STOP_MULT_REENTRY = "1.6";
process.env.ATR_STOP_MULT_STRONG_REENTRY = "1.6";
process.env.ATR_STOP_MIN_BARS_AFTER_ENTRY = "2";
process.env.ATR_STOP_MIN_LOSS_TRIGGER_PCT = "-0.35";
process.env.LAUNCH_TP_PROTECTION_FORCE_ALLOW_ON_MAX_GIVEBACK = "true";
process.env.LAUNCH_TP_PROTECTION_MAX_GIVEBACK_PCT = "0.30";
process.env.LAUNCH_TP_PROTECTION_DISABLE_ON_BEARISH_FVVO = "true";
process.env.LAUNCH_TP_PROTECTION_DISABLE_BELOW_EMA8 = "true";
process.env.DYNAMIC_TP_TIER1_FORCE_EXIT_GIVEBACK_PCT = "0.30";
process.env.DYNAMIC_TP_TIER1_MIN_EXIT_PNL_PCT = "0.30";
process.env.DYNAMIC_TP_ENABLED = "true";
process.env.DYNAMIC_TP_ADAPTIVE_ENABLED = "true";
process.env.DYNAMIC_TP_ADAPTIVE_LOG = "true";
process.env.DYNAMIC_TP_MIN_GROSS_EXIT_PNL_PCT = "0.35";
process.env.DYNAMIC_TP_MIN_NET_EXIT_PNL_PCT = "0.10";
process.env.FEE_ROUND_TRIP_PCT = "0.15";
process.env.SLIPPAGE_BUFFER_PCT = "0.05";
process.env.DYNAMIC_TP_ONE_BAR_PULLBACK_ENABLED = "true";
process.env.DYNAMIC_TP_ONE_BAR_PULLBACK_MIN_PEAK_PCT = "0.60";
process.env.DYNAMIC_TP_ONE_BAR_PULLBACK_MIN_GIVEBACK_PCT = "0.08";
process.env.DYNAMIC_TP_ONE_BAR_PULLBACK_MIN_EXIT_PNL_PCT = "0.35";
process.env.POST_ADAPTIVE_TP_REENTRY_ENABLED = "true";
process.env.POST_ADAPTIVE_TP_REENTRY_COOLDOWN_BARS = "2";
process.env.POST_ADAPTIVE_TP_REENTRY_WINDOW_BARS = "48";
process.env.POST_ADAPTIVE_TP_REENTRY_REQUIRE_RESET = "true";
process.env.POST_ADAPTIVE_TP_REENTRY_MIN_RESET_FROM_PEAK_PCT = "0.70";
process.env.POST_ADAPTIVE_TP_REENTRY_MIN_RESET_FROM_EXIT_PCT = "0.45";
process.env.POST_ADAPTIVE_TP_REENTRY_ALLOW_EMA8_TOUCH_RESET = "false";
process.env.POST_ADAPTIVE_TP_REENTRY_ALLOW_EMA18_TOUCH_RESET = "true";
process.env.POST_ADAPTIVE_TP_REENTRY_REQUIRE_RECLAIM = "true";
process.env.POST_ADAPTIVE_TP_REENTRY_RECLAIM_MIN_RSI = "58";
process.env.POST_ADAPTIVE_TP_REENTRY_RECLAIM_MIN_ADX = "18";
process.env.POST_ADAPTIVE_TP_REENTRY_REQUIRE_CLOSE_ABOVE_EMA8 = "true";
process.env.POST_ADAPTIVE_TP_REENTRY_REQUIRE_EMA8_ABOVE_EMA18 = "true";
process.env.POST_ADAPTIVE_TP_REENTRY_BLOCK_BEARISH_FVVO_SEC = "300";
process.env.POST_ADAPTIVE_TP_REENTRY_MAX_CHASE_FROM_RECLAIM_PCT = "0.35";
process.env.POST_ADAPTIVE_TP_REENTRY_LOG = "true";

import fs from 'fs';
const { handleWebhook } = await import('./src/brain.js');
const { S } = await import('./src/stateStore.js');

const events = JSON.parse(fs.readFileSync('/mnt/data/May26_v6_6d_replay_from_shared_logs_synthetic_ticks.json', 'utf8'));
for (const e of events) {
  const clean = { ...e };
  delete clean._arrivalTime;
  delete clean._syntheticFrom;
  delete clean._sourcePnlPct;
  handleWebhook(clean);
}
const interesting = S.logs.filter(l => /ENTER_LONG|DYNAMIC_BREAKEVEN|DYNAMIC_TP|ADAPTIVE_TP|EXIT_LONG|LAUNCH_TP|ATR_STRUCTURE|FIRST_ENTRY|FVVO|FEATURE_5M|POST_ADAPTIVE_TP|ENTRY_DECISION|REENTRY/.test(l));
fs.writeFileSync('/mnt/data/ReplayModulev6.6e_May26_from_shared_logs.log', interesting.join('\n') + '\n\nFINAL_STATE ' + JSON.stringify({
  inPosition: S.inPosition,
  entryPrice: S.entryPrice,
  lastExitReason: S.lastExitReason,
  lastExitClass: S.lastExitClass,
  exitAt: S.lastExitAt,
  peakPnlPct: S.peakPnlPct,
  adaptiveTp: S.adaptiveTp,
  dynamicTpTier: S.dynamicTpTier,
  logs: S.logs.slice(-20)
}, null, 2));
console.log(interesting.join('\n'));
console.log('\nFINAL_STATE', JSON.stringify({ inPosition: S.inPosition, lastExitReason: S.lastExitReason, lastExitClass: S.lastExitClass, peakPnlPct: S.peakPnlPct, adaptiveTp: S.adaptiveTp }, null, 2));
