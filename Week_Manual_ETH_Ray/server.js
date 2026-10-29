'use strict';

/**
 * BrainFVVO_ETH_v3u_ATR_DROP_DIAGNOSTICS_PAPER
 * ------------------------------------------------
 * Clean deploy-root Node service for Railway.
 * Files expected in Railway Root Directory: server.js, package.json, package-lock.json
 *
 * Manual actions supported:
 *   status, enter_long, exit_long, cancel, cancel_price_entry,
 *   arm_campaign_entry, arm_price_entry, cancel_campaign,
 *   adopt_long, handoff_manual, clear_handoff, force_clear_verified_flat
 *
 * Clear emoji-coded log labels included:
 *   FVVO_FEATURE_TICK_RECEIVED
 *   FVVO_FEATURE_5M_RECEIVED
 *   FVVO_PRICE_TRIGGER_ARMED
 *   FVVO_PRICE_TRIGGER_EXPIRED
 *   FVVO_CAMPAIGN_ENTRY_SETUP_EXPIRED
 *   FVVO_BREAKOUT_RETEST_POST_EXPIRY_SHADOW_ARMED
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const env = process.env;

const BRAIN = env.BRAIN_NAME || 'BrainFVVO_ETH_v3u_ATR_DROP_DIAGNOSTICS_PAPER';

const cfg = {
  port: intEnv('PORT', 8080),
  symbol: env.SYMBOL || 'BINANCE:ETHUSDT',
  webhookSecret: env.WEBHOOK_SECRET || '',
  manualSecret: env.MANUAL_WEBHOOK_SECRET || env.WEBHOOK_SECRET || '',
  webhookPath: env.WEBHOOK_PATH || '/webhook',
  manualPath: env.MANUAL_WEBHOOK_PATH || '/manual',
  executionMode: (env.EXECUTION_MODE || 'demo').toLowerCase(),
  shadowOnly: boolEnv('SHADOW_ONLY', false),
  enableHttpForward: boolEnv('ENABLE_HTTP_FORWARD', true),
  demoForwardAllowed: boolEnv('DEMO_FORWARD_ALLOWED', true),
  liveForwardAllowed: boolEnv('LIVE_FORWARD_ALLOWED', false),
  c3DryRun: boolEnv('C3_DRY_RUN', false),
  c3SignalUrl: env.C3_SIGNAL_URL || 'https://3c.wtalerts.com/bot/custom',
  c3EnterLongCode: env.C3_ENTER_LONG_CODE || '',
  c3ExitLongCode: env.C3_EXIT_LONG_CODE || '',
  c3TimeoutMs: intEnv('C3_TIMEOUT_MS', 8000),
  c3AmountPerTrade: env.C3_AMOUNT_PER_TRADE || '30',
  c3AmountPerTradeType: env.C3_AMOUNT_PER_TRADE_TYPE || 'quote',
  c3OrderType: env.C3_ORDER_TYPE || 'market',
  // Preserve the v3q state path so an existing tracked position and exit protection survive an upgrade.
  stateFile: env.STATE_FILE || '/data/brainfvvo-eth-ray30-longhold-v3q-state.json',
  autoEntryHoldOnStartup: boolEnv('AUTO_ENTRY_HOLD_ON_STARTUP', true),
  autoEntryPauseAfterManualExit: boolEnv('AUTO_ENTRY_PAUSE_AFTER_MANUAL_EXIT', true),
  ray30LongGateMode: env.RAY30_LONG_GATE_MODE || 'RAYALGO_STRICT',
  ray30MaxAgeSec: intEnv('RAY30_MAX_AGE_SEC', 2700),
  feature5mMaxAgeSec: intEnv('FEATURE_5M_MAX_AGE_SEC', 420),
  featureTickMaxAgeSec: intEnv('FEATURE_TICK_MAX_AGE_SEC', 60),
  stopLossPct: numEnv('RAY30_STOP_LOSS_PCT', 0.60),
  emergencyDropEnabled: boolEnv('RAY30_EMERGENCY_DROP_ENABLED', true),
  emergencyDropMode: env.RAY30_EMERGENCY_DROP_MODE || 'FROM_60S_HIGH',
  emergencyDropWindowSec: intEnv('RAY30_EMERGENCY_DROP_WINDOW_SEC', 60),
  emergencyDropPct: numEnv('RAY30_EMERGENCY_DROP_PCT', 1.00),
  permanentFloorsEnabled: boolEnv('RAY30_PERMANENT_FLOORS_ENABLED', true),
  floor1MfePct: numEnv('RAY30_FLOOR_1_MFE_PCT', 1.00),
  floor1LockPct: numEnv('RAY30_FLOOR_1_LOCK_PCT', 0.00),
  floor2MfePct: numEnv('RAY30_FLOOR_2_MFE_PCT', 2.00),
  floor2LockPct: numEnv('RAY30_FLOOR_2_LOCK_PCT', 1.00),
  floor3MfePct: numEnv('RAY30_FLOOR_3_MFE_PCT', 3.00),
  floor3LockPct: numEnv('RAY30_FLOOR_3_LOCK_PCT', 2.00),
  floor4MfePct: numEnv('RAY30_FLOOR_4_MFE_PCT', 4.00),
  floor4LockPct: numEnv('RAY30_FLOOR_4_LOCK_PCT', 3.00),

  // v3h small protective floors: protect some profit before +2% progressive compression starts.
  protectiveFloorsEnabled: boolEnv('RAY30_PROTECTIVE_FLOORS_ENABLED', true),
  protectiveFloor1MfePct: numEnv('RAY30_PROTECTIVE_FLOOR_1_MFE_PCT', 1.50),
  protectiveFloor1LockPct: numEnv('RAY30_PROTECTIVE_FLOOR_1_LOCK_PCT', 0.30),
  protectiveFloor2MfePct: numEnv('RAY30_PROTECTIVE_FLOOR_2_MFE_PCT', 1.80),
  protectiveFloor2LockPct: numEnv('RAY30_PROTECTIVE_FLOOR_2_LOCK_PCT', 0.50),

  // v3o micro floors: protect small wins before the +1% permanent floor.
  microFloorsEnabled: boolEnv('RAY30_MICRO_FLOORS_ENABLED', true),
  microFloor1MfePct: numEnv('RAY30_MICRO_FLOOR_1_MFE_PCT', 0.55),
  microFloor1LockPct: numEnv('RAY30_MICRO_FLOOR_1_LOCK_PCT', 0.25),
  microFloor2MfePct: numEnv('RAY30_MICRO_FLOOR_2_MFE_PCT', 0.80),
  microFloor2LockPct: numEnv('RAY30_MICRO_FLOOR_2_LOCK_PCT', 0.45),

  runnerEnabled: boolEnv('RAY30_RUNNER_ENABLED', true),
  runnerActivateMfePct: numEnv('RAY30_RUNNER_ACTIVATE_MFE_PCT', 5.00),
  runnerMinLockPct: numEnv('RAY30_RUNNER_MIN_LOCK_PCT', 4.00),
  runnerGivebackPct: numEnv('RAY30_RUNNER_GIVEBACK_PCT', 0.80),

  // v3f/v3g progressive floor compressor. Fixed floors remain the safety base.
  progressiveFloorsEnabled: boolEnv('RAY30_PROGRESSIVE_FLOORS_ENABLED', true),
  progressiveStartMfePct: numEnv('RAY30_PROGRESSIVE_START_MFE_PCT', 2.00),
  progressiveNeverLoosen: boolEnv('RAY30_PROGRESSIVE_NEVER_LOOSEN', true),
  progressiveBand2MaxPullbackPct: numEnv('RAY30_PROGRESSIVE_BAND_2_MAX_PULLBACK_PCT', 1.20),
  progressiveBand2MinPullbackPct: numEnv('RAY30_PROGRESSIVE_BAND_2_MIN_PULLBACK_PCT', 0.60),
  progressiveBand3MaxPullbackPct: numEnv('RAY30_PROGRESSIVE_BAND_3_MAX_PULLBACK_PCT', 1.00),
  progressiveBand3MinPullbackPct: numEnv('RAY30_PROGRESSIVE_BAND_3_MIN_PULLBACK_PCT', 0.15),
  progressiveBand4MaxPullbackPct: numEnv('RAY30_PROGRESSIVE_BAND_4_MAX_PULLBACK_PCT', 0.70),
  progressiveBand4MinPullbackPct: numEnv('RAY30_PROGRESSIVE_BAND_4_MIN_PULLBACK_PCT', 0.08),
  progressiveBand5MaxPullbackPct: numEnv('RAY30_PROGRESSIVE_BAND_5_MAX_PULLBACK_PCT', 0.55),
  progressiveBand5MinPullbackPct: numEnv('RAY30_PROGRESSIVE_BAND_5_MIN_PULLBACK_PCT', 0.05),
  progressiveBand6MaxPullbackPct: numEnv('RAY30_PROGRESSIVE_BAND_6_MAX_PULLBACK_PCT', 0.40),
  progressiveBand6MinPullbackPct: numEnv('RAY30_PROGRESSIVE_BAND_6_MIN_PULLBACK_PCT', 0.05),

  // v3p: controlled, DEMO-only pre-RayAlgo reversal entry. No new TradingView alerts needed.
  earlyTurnEnabled: boolEnv('EARLY_TURN_ENABLED', true),
  earlyTurnSendOrder: boolEnv('EARLY_TURN_SEND_ORDER', true),
  earlyTurnMinRsi5m: numEnv('EARLY_TURN_MIN_RSI_5M', 50),
  earlyTurnMaxRsi5m: numEnv('EARLY_TURN_MAX_RSI_5M', 65),
  earlyTurnMinFvvo5m: numEnv('EARLY_TURN_MIN_FVVO_5M', 0.5),
  earlyTurnMinSlope5m: numEnv('EARLY_TURN_MIN_SLOPE_5M', 0.20),
  earlyTurnMinRiseFromLowPct: numEnv('EARLY_TURN_MIN_RISE_FROM_LOW_PCT', 0.15),
  earlyTurnMaxRiseFromLowPct: numEnv('EARLY_TURN_MAX_RISE_FROM_LOW_PCT', 1.20),
  earlyTurnMaxAboveEma18Pct: numEnv('EARLY_TURN_MAX_ABOVE_EMA18_PCT', 0.45),
  earlyTurnEma8Below18AllowancePct: numEnv('EARLY_TURN_EMA8_BELOW18_ALLOWANCE_PCT', 0.12),
  earlyTurnMinRsi15s: numEnv('EARLY_TURN_MIN_RSI_15S', 50),
  earlyTurnMaxRsi15s: numEnv('EARLY_TURN_MAX_RSI_15S', 76),
  earlyTurnMinTickSlope: numEnv('EARLY_TURN_MIN_TICK_SLOPE', -0.50),
  earlyTurnConfirmPositiveSlope: boolEnv('EARLY_TURN_CONFIRM_POSITIVE_SLOPE', true),
  earlyTurnRetryCooldownSec: intEnv('EARLY_TURN_RETRY_COOLDOWN_SEC', 1800),
  earlyTurnMinFvvo15s: numEnv('EARLY_TURN_MIN_FVVO_15S', 0.20),
  earlyTurnConfirmTicks: Math.max(2, intEnv('EARLY_TURN_CONFIRM_TICKS', 3)),
  earlyTurnConfirmWindow: Math.max(3, intEnv('EARLY_TURN_CONFIRM_WINDOW', 4)),
  earlyTurnConfirmTickMinGapSec: Math.max(0, intEnv('EARLY_TURN_CONFIRM_TICK_MIN_GAP_SEC', 5)),
  earlyTurnConfirmMinSec: Math.max(0, intEnv('EARLY_TURN_CONFIRM_MIN_SEC', 12)),
  earlyTurnRequire30mFeature: boolEnv('EARLY_TURN_REQUIRE_30M_FEATURE', true),
  earlyTurnAllowBearExhaustion30m: boolEnv('EARLY_TURN_ALLOW_BEAR_EXHAUSTION_30M', false),
  earlyTurnPrevRsiMax5m: numEnv('EARLY_TURN_PREV_RSI_MAX_5M', 54),
  earlyTurnContextMaxAgeSec: Math.max(60, intEnv('EARLY_TURN_CONTEXT_MAX_AGE_SEC', 2400)),
  earlyTurnDiagnosticsEnabled: boolEnv('EARLY_TURN_DIAGNOSTICS_ENABLED', true),
  rayalgoConflictGuardEnabled: boolEnv('RAYALGO_CONFLICT_GUARD_ENABLED', true),
  rayalgoConflictSettleSec: Math.max(0, intEnv('RAYALGO_CONFLICT_SETTLE_SEC', 20)),
  rayalgoConflictBarMinutes: Math.max(1, intEnv('RAYALGO_CONFLICT_BAR_MINUTES', 30)),
  earlyTurnResetRsi5m: numEnv('EARLY_TURN_RESET_RSI_5M', 42),
  earlyTurnResetFvvo5m: numEnv('EARLY_TURN_RESET_FVVO_5M', -0.80),
  earlyTurnBearMinAgeSec: Math.max(0, intEnv('EARLY_TURN_BEAR_MIN_AGE_SEC', 900)),
  earlyTurnProbationExitRsi5m: numEnv('EARLY_TURN_PROBATION_EXIT_RSI_5M', 43),
  earlyTurnProbationExitFvvo5m: numEnv('EARLY_TURN_PROBATION_EXIT_FVVO_5M', -0.50),
  earlyTurnProbationExitConfirmBars: Math.max(2, intEnv('EARLY_TURN_PROBATION_EXIT_CONFIRM_BARS', 2)),
  // v3t: standalone post-washout V-shape entry, DEMO accounts only. No 30m bullish gate needed.
  vRecoveryEnabled: boolEnv('V_RECOVERY_ENABLED', true),
  vRecoverySendOrder: boolEnv('V_RECOVERY_SEND_ORDER', true),
  vDrop30Pct: numEnv('V_DROP_30M_PCT', 1.20),
  vDrop60Pct: numEnv('V_DROP_60M_PCT', 1.80),
  vDrop90Pct: numEnv('V_DROP_90M_PCT', 2.50),
  vDropAtrMult: numEnv('V_DROP_ATR_MULT', 2.20),
  vRecoveryMinBouncePct: numEnv('V_RECOVERY_MIN_BOUNCE_PCT', 0.50),
  vRecoveryMaxBouncePct: numEnv('V_RECOVERY_MAX_BOUNCE_PCT', 2.50),
  vRecoveryMaxAgeSec: intEnv('V_RECOVERY_MAX_AGE_SEC', 10800),
  vRayalgoTf: String(env.V_RAYALGO_TIMEFRAME || '3'),
  vRayMaxAgeSec: intEnv('V_RAY_MAX_AGE_SEC', 420),
  vConfirmWindow: Math.max(4, intEnv('V_CONFIRM_15S_WINDOW', 4)),
  vConfirmRequired: Math.max(3, intEnv('V_CONFIRM_15S_REQUIRED', 3)),
  vConfirmMinSec: intEnv('V_CONFIRM_MIN_SEC', 30),
  vConfirmTickGapSec: intEnv('V_CONFIRM_TICK_GAP_SEC', 10),
  vMinRsi15s: numEnv('V_MIN_RSI_15S', 45),
  vMinFvvo15s: numEnv('V_MIN_FVVO_15S', 0),
  vMaxMicroChasePct: numEnv('V_MAX_MICRO_CHASE_PCT', 0.55),
  vAtrMaxAgeSec: intEnv('V_ATR_MAX_AGE_SEC', 900),
  vAtrRequire: boolEnv('V_REQUIRE_REAL_5M_ATR', true),
  vRayBearReversalCancel: boolEnv('V_CANCEL_ON_3M_BEAR_CHANGE', true),
  // Never treat a re-armed old RayAlgo alert as a newly received alert after a profit exit.
  ray30DisallowHistoricalBullRearmAfterExit: boolEnv('RAY30_DISALLOW_HISTORICAL_BULL_REARM_AFTER_EXIT', true),

  // RAY30 automatic-entry scanner. Defaults are safe: scan/log only, no order.
  ray30AutoEntryEnabled: boolEnv('RAY30_AUTO_ENTRY_ENABLED', true),
  ray30AutoEntrySendOrder: boolEnv('RAY30_AUTO_ENTRY_SEND_ORDER', true),
  ray30EntryScanLogEnabled: boolEnv('RAY30_ENTRY_SCAN_LOG_ENABLED', true),
  ray30EntryScanOnTick: boolEnv('RAY30_ENTRY_SCAN_ON_TICK', true),
  ray30MinRsi5m: numEnv('RAY30_MIN_RSI_5M', 50),
  ray30MaxRsi5m: numEnv('RAY30_MAX_RSI_5M', 68),
  ray30MinAdx5m: numEnv('RAY30_MIN_ADX_5M', 15),
  ray30MinFvvo5m: numEnv('RAY30_MIN_FVVO_5M', 0),
  ray30MinSlope5m: numEnv('RAY30_MIN_SLOPE_5M', 0),
  ray30MinRsi15s: numEnv('RAY30_MIN_RSI_15S', 48),
  ray30MaxRsi15s: numEnv('RAY30_MAX_RSI_15S', 74),
  ray30NoChaseRsi15s: numEnv('RAY30_NO_CHASE_RSI_15S', 78),
  ray30PullbackReclaimMaxRsi15s: numEnv('RAY30_PULLBACK_RECLAIM_MAX_RSI_15S', 64),
  ray30MinFvvo15s: numEnv('RAY30_MIN_FVVO_15S', 0),
  ray30MaxRayAgeSec: intEnv('RAY30_MAX_AGE_SEC', 2700),

  // v3g: separate stateful RayAlgo alerts are primary. The 30m feature/proxy publisher is fallback/context only.
  rayalgoExternalAlertsEnabled: boolEnv('RAYALGO_EXTERNAL_ALERTS_ENABLED', true),
  rayalgoStateMemoryEnabled: boolEnv('RAYALGO_STATE_MEMORY_ENABLED', true),
  rayalgoStateMaxAgeSec: intEnv('RAYALGO_STATE_MAX_AGE_SEC', 21600),
  ray30UseRayalgoExternalPriority: boolEnv('RAY30_USE_RAYALGO_EXTERNAL_PRIORITY', true),
  ray30FeatureProxyFallbackEnabled: boolEnv('RAY30_FEATURE_PROXY_FALLBACK_ENABLED', false),
  ray30FeatureProxyMonitorOnly: boolEnv('RAY30_FEATURE_PROXY_MONITOR_ONLY', true),
  rayalgoRequireExternalSetupForEntry: boolEnv('RAYALGO_REQUIRE_EXTERNAL_SETUP_FOR_ENTRY', true),
  rayalgoSetupTimeframe: String(env.RAYALGO_SETUP_TIMEFRAME || '15'),
  rayalgoAllowedEntryTimeframes: String(env.RAYALGO_ALLOWED_ENTRY_TIMEFRAMES || env.RAYALGO_SETUP_TIMEFRAME || '15'),

  // v3m: after a successful floor/profit exit, clear old setup and require a fresh RayAlgo alert.
  ray30ClearSetupOnExit: boolEnv('RAY30_CLEAR_SETUP_ON_EXIT', true),
  ray30ClearSetupOnProfitExitOnly: boolEnv('RAY30_CLEAR_SETUP_ON_PROFIT_EXIT_ONLY', true),
  ray30PostExitCooldownSec: intEnv('RAY30_POST_EXIT_COOLDOWN_SEC', 900),
  ray30PostExitRequireNewRayalgoAlert: boolEnv('RAY30_POST_EXIT_REQUIRE_NEW_RAYALGO_ALERT', true),

  // v3m: tighter pullback recovery quality filter so we do not buy while 5m still looks unreclaimed.
  ray30PullbackRequire5mAboveEma18: boolEnv('RAY30_PULLBACK_REQUIRE_5M_ABOVE_EMA18', true),
  ray30PullbackRequire5mEma8AboveEma18: boolEnv('RAY30_PULLBACK_REQUIRE_5M_EMA8_ABOVE_EMA18', true),

  // v3k/v3l/v3m: FVVO Oscillator confidence alerts are stored and printed.
  // v3l uses only bearish confidence signals as entry blockers; bullish confidence stays monitor-only.
  fvvoConfidenceMonitorEnabled: boolEnv('FVVO_CONFIDENCE_MONITOR_ENABLED', true),
  fvvoConfidenceMaxAgeSec: intEnv('FVVO_CONFIDENCE_MAX_AGE_SEC', 1800),
  fvvoBearishBlockLongEnabled: boolEnv('FVVO_BEARISH_BLOCK_LONG_ENABLED', true),
  fvvoSniperSellBlockSec: intEnv('FVVO_SNIPER_SELL_BLOCK_SEC', 2700),
  fvvoBurstBearishBlockSec: intEnv('FVVO_BURST_BEARISH_BLOCK_SEC', 2700),
  fvvoSniperBuyUseForEntry: boolEnv('FVVO_SNIPER_BUY_USE_FOR_ENTRY', false),
  fvvoBurstBullishUseForEntry: boolEnv('FVVO_BURST_BULLISH_USE_FOR_ENTRY', false),

  // v3n: protect open trades when bearish FVVO confirmation appears soon after entry.
  fvvoBearishExitGuardEnabled: boolEnv('FVVO_BEARISH_EXIT_GUARD_ENABLED', true),
  fvvoExitOnSniperSellWithinEntrySec: intEnv('FVVO_EXIT_ON_SNIPER_SELL_WITHIN_ENTRY_SEC', 900),
  fvvoExitOnBurstBearishWithinEntrySec: intEnv('FVVO_EXIT_ON_BURST_BEARISH_WITHIN_ENTRY_SEC', 900),
  fvvoBearishExitOnlyIfProfitBelowPct: numEnv('FVVO_BEARISH_EXIT_ONLY_IF_PROFIT_BELOW_PCT', 0.30),

  // v3o hotfix: external RayAlgo bearish alert can exit an open long when 5m confirms weakness.
  rayalgoBearExitEnabled: boolEnv('RAYALGO_BEAR_EXIT_ENABLED', true),
  rayalgoBearExitMaxAgeSec: intEnv('RAYALGO_BEAR_EXIT_MAX_AGE_SEC', 1800),
  rayalgoBearExitRequire5mConfirm: boolEnv('RAYALGO_BEAR_EXIT_REQUIRE_5M_CONFIRM', true),
  rayalgoBearExit5mMaxAgeSec: intEnv('RAYALGO_BEAR_EXIT_5M_MAX_AGE_SEC', 420),

  // v3n: early failed-entry loss control for 15m test mode.
  ray30EarlyFailExitEnabled: boolEnv('RAY30_EARLY_FAIL_EXIT_ENABLED', true),
  ray30EarlyFailMaxAgeSec: intEnv('RAY30_EARLY_FAIL_MAX_AGE_SEC', 1800),
  ray30EarlyFailExitPct: numEnv('RAY30_EARLY_FAIL_EXIT_PCT', -0.35),

  // v3j: RayAlgo opens a setup window. Entry waits for instant-qualified, pullback-recovery, or breakout-continuation.
  ray30SetupEntryEnabled: boolEnv('RAY30_SETUP_ENTRY_ENABLED', true),
  ray30SetupTtlSec: intEnv('RAY30_SETUP_TTL_SEC', 21600),
  ray30SetupNoImmediateEntrySec: intEnv('RAY30_SETUP_NO_IMMEDIATE_ENTRY_SEC', 60),

  // v3j: instant-qualified leg. RayAlgo does not blindly enter; it enters only if 5m and the next 15s tick are already high quality.
  ray30InstantQualifiedEntryEnabled: boolEnv('RAY30_INSTANT_QUALIFIED_ENTRY_ENABLED', true),
  ray30InstantMaxAfterRaySec: intEnv('RAY30_INSTANT_MAX_AFTER_RAY_SEC', 120),
  ray30InstantRequireNext15sTick: boolEnv('RAY30_INSTANT_REQUIRE_NEXT_15S_TICK', true),
  ray30Instant5mMinRsi: numEnv('RAY30_INSTANT_5M_MIN_RSI', 52),
  ray30Instant5mMaxRsi: numEnv('RAY30_INSTANT_5M_MAX_RSI', 68),
  ray30Instant5mMinFvvo: numEnv('RAY30_INSTANT_5M_MIN_FVVO', 0.00),
  ray30Instant5mMinSlope: numEnv('RAY30_INSTANT_5M_MIN_SLOPE', 0.00),
  ray30Instant15sMinRsi: numEnv('RAY30_INSTANT_15S_MIN_RSI', 52),
  ray30Instant15sMaxRsi: numEnv('RAY30_INSTANT_15S_MAX_RSI', 72),
  ray30Instant15sMinFvvo: numEnv('RAY30_INSTANT_15S_MIN_FVVO', 0.20),
  ray30Instant15sMinSlope: numEnv('RAY30_INSTANT_15S_MIN_SLOPE', 0.00),
  ray30InstantMaxExtEma8Pct: numEnv('RAY30_INSTANT_MAX_EXT_EMA8_PCT', 0.35),
  ray30InstantMaxExtEma18Pct: numEnv('RAY30_INSTANT_MAX_EXT_EMA18_PCT', 0.60),

  ray30PullbackEntryEnabled: boolEnv('RAY30_PULLBACK_ENTRY_ENABLED', true),
  ray30PullbackMinDipPct: numEnv('RAY30_PULLBACK_MIN_DIP_PCT', 0.25),
  ray30PullbackMaxDipPct: numEnv('RAY30_PULLBACK_MAX_DIP_PCT', 1.80),
  // v3o anti-chase: if price is already extended from RayAlgo, require a real dip from local high.
  ray30PullbackAntiChaseEnabled: boolEnv('RAY30_PULLBACK_ANTI_CHASE_ENABLED', true),
  ray30PullbackEntryMaxMoveFromRayPct: numEnv('RAY30_PULLBACK_ENTRY_MAX_MOVE_FROM_RAY_PCT', 0.80),
  ray30PullbackEntryMinDipFromHighPct: numEnv('RAY30_PULLBACK_ENTRY_MIN_DIP_FROM_HIGH_PCT', 0.12),
  ray30Pullback5mMinRsi: numEnv('RAY30_PULLBACK_5M_MIN_RSI', 50),
  ray30Pullback5mMinFvvo: numEnv('RAY30_PULLBACK_5M_MIN_FVVO', 0.00),
  ray30Pullback5mMinSlope: numEnv('RAY30_PULLBACK_5M_MIN_SLOPE', 0.20),
  ray30Pullback15sMinRsi: numEnv('RAY30_PULLBACK_15S_MIN_RSI', 48),
  ray30Pullback15sMaxRsi: numEnv('RAY30_PULLBACK_15S_MAX_RSI', 68),
  ray30Pullback15sMinFvvo: numEnv('RAY30_PULLBACK_15S_MIN_FVVO', 0.00),

  ray30BreakoutEntryEnabled: boolEnv('RAY30_BREAKOUT_ENTRY_ENABLED', true),
  ray30BreakoutMinWaitSec: intEnv('RAY30_BREAKOUT_MIN_WAIT_SEC', 180),
  ray30BreakoutMinMoveFromRayPct: numEnv('RAY30_BREAKOUT_MIN_MOVE_FROM_RAY_PCT', 0.45),
  ray30Breakout5mMinRsi: numEnv('RAY30_BREAKOUT_5M_MIN_RSI', 55),
  ray30Breakout5mMaxRsi: numEnv('RAY30_BREAKOUT_5M_MAX_RSI', 72),
  ray30Breakout5mMinFvvo: numEnv('RAY30_BREAKOUT_5M_MIN_FVVO', -0.20),
  ray30Breakout5mMinSlope: numEnv('RAY30_BREAKOUT_5M_MIN_SLOPE', 0.00),
  ray30Breakout15sMinRsi: numEnv('RAY30_BREAKOUT_15S_MIN_RSI', 55),
  ray30Breakout15sMaxRsi: numEnv('RAY30_BREAKOUT_15S_MAX_RSI', 76),
  ray30Breakout15sMinFvvo: numEnv('RAY30_BREAKOUT_15S_MIN_FVVO', 0.50),
  ray30Breakout15sMinSlope: numEnv('RAY30_BREAKOUT_15S_MIN_SLOPE', 0.00),

  // v3g replay logging controls. Default is compact/reason-change instead of printing every scan.
  ray30ScanLogMode: String(env.RAY30_SCAN_LOG_MODE || 'REASON_CHANGE').toUpperCase(),
  ray30NoEntryLogMode: String(env.RAY30_NO_ENTRY_LOG_MODE || 'OFF').toUpperCase(),
  logReplayCompactEnabled: boolEnv('LOG_REPLAY_COMPACT_ENABLED', true),

  // Cosmetic / log controls. Processing still continues when a log stream is disabled.
  logEmojiEnabled: boolEnv('LOG_EMOJI_ENABLED', true),
  logFeatureTickEnabled: boolEnv('LOG_FEATURE_TICK_ENABLED', false),
  log15sTickEnabled: boolEnv('LOG_15S_TICK_ENABLED', true),
  log15sTickEveryN: Math.max(1, intEnv('LOG_15S_TICK_EVERY_N', 4)),
  logFeature5mEnabled: boolEnv('LOG_FEATURE_5M_ENABLED', true),
  // Log-only V-Recovery 30m/60m/90m drawdown snapshot on each 5m feature.
  logVRecoveryDropDiagnosticEnabled: boolEnv('LOG_V_RECOVERY_DROP_DIAGNOSTIC_ENABLED', true),
  logC3PayloadAudit: boolEnv('LOG_C3_PAYLOAD_AUDIT', true)
};

const SUPPORTED_MANUAL_ACTIONS = [
  'status',
  'pause_auto_entry',
  'resume_auto_entry',
  'enter_long',
  'exit_long',
  'cancel',
  'arm_campaign_entry',
  'arm_price_entry',
  'cancel_price_entry',
  'cancel_campaign',
  'adopt_long',
  'handoff_manual',
  'clear_handoff',
  'force_clear_verified_flat'
];

const logCounters = { featureTick15s: 0, lastRay30ScanKey: null, lastRay30NoEntryKey: null };

let state = loadState();
ensureStateShape();
// Restart defaults to HOLD; a deliberate authenticated resume is needed before automatic entries.
// The pause is persisted, including after a successful manual exit.
if (cfg.autoEntryHoldOnStartup) pauseAutomaticEntries('STARTUP_SAFETY_HOLD', { preserveExistingReason: true });
// Runtime-only in-flight order guard; never permits concurrent duplicate 3Commas enter requests.
let entrySubmissionPending = false;

log('STARTUP', {
  brain: BRAIN,
  port: cfg.port,
  symbol: cfg.symbol,
  executionMode: cfg.executionMode,
  shadowOnly: cfg.shadowOnly,
  enableHttpForward: cfg.enableHttpForward,
  demoForwardAllowed: cfg.demoForwardAllowed,
  liveForwardAllowed: cfg.liveForwardAllowed,
  c3DryRun: cfg.c3DryRun,
  c3SignalUrlHost: safeHost(cfg.c3SignalUrl),
  hasEnterCode: Boolean(cfg.c3EnterLongCode),
  hasExitCode: Boolean(cfg.c3ExitLongCode),
  amountMode: cfg.c3AmountPerTrade ? `${cfg.c3AmountPerTradeType || 'unset'}:${cfg.c3AmountPerTrade}` : 'not_set',
  stateFile: cfg.stateFile,
  autoEntryControl: publicAutoEntryControl(),
  manualActions: SUPPORTED_MANUAL_ACTIONS,
  entryConfig: {
    ray30AutoEntryEnabled: cfg.ray30AutoEntryEnabled,
    ray30AutoEntrySendOrder: cfg.ray30AutoEntrySendOrder,
    ray30LongGateMode: cfg.ray30LongGateMode,
    ray30EntryScanLogEnabled: cfg.ray30EntryScanLogEnabled,
    ray30EntryScanOnTick: cfg.ray30EntryScanOnTick,
    rsi5m: `${cfg.ray30MinRsi5m}-${cfg.ray30MaxRsi5m}`,
    rsi15s: `${cfg.ray30MinRsi15s}-${cfg.ray30MaxRsi15s}`,
    noChaseRsi15s: cfg.ray30NoChaseRsi15s
  },
  rayalgoConfig: {
    externalAlertsEnabled: cfg.rayalgoExternalAlertsEnabled,
    stateMemoryEnabled: cfg.rayalgoStateMemoryEnabled,
    stateMaxAgeSec: cfg.rayalgoStateMaxAgeSec,
    useExternalPriority: cfg.ray30UseRayalgoExternalPriority,
    featureProxyFallbackEnabled: cfg.ray30FeatureProxyFallbackEnabled,
    featureProxyMonitorOnly: cfg.ray30FeatureProxyMonitorOnly,
    requireExternalSetupForEntry: cfg.rayalgoRequireExternalSetupForEntry,
    setupTimeframe: cfg.rayalgoSetupTimeframe,
    allowedEntryTimeframes: cfg.rayalgoAllowedEntryTimeframes,
    setupEntryEnabled: cfg.ray30SetupEntryEnabled,
    instantQualifiedEntryEnabled: cfg.ray30InstantQualifiedEntryEnabled,
    pullbackEntryEnabled: cfg.ray30PullbackEntryEnabled,
    breakoutEntryEnabled: cfg.ray30BreakoutEntryEnabled,
    pullback5mMinRsi: cfg.ray30Pullback5mMinRsi,
    pullback5mMinFvvo: cfg.ray30Pullback5mMinFvvo,
    pullback5mMinSlope: cfg.ray30Pullback5mMinSlope,
    pullbackAntiChaseEnabled: cfg.ray30PullbackAntiChaseEnabled,
    pullbackEntryMaxMoveFromRayPct: cfg.ray30PullbackEntryMaxMoveFromRayPct,
    pullbackEntryMinDipFromHighPct: cfg.ray30PullbackEntryMinDipFromHighPct,
    pullbackRequire5mAboveEma18: cfg.ray30PullbackRequire5mAboveEma18,
    pullbackRequire5mEma8AboveEma18: cfg.ray30PullbackRequire5mEma8AboveEma18,
    clearSetupOnExit: cfg.ray30ClearSetupOnExit,
    postExitCooldownSec: cfg.ray30PostExitCooldownSec,
    postExitRequireNewRayalgoAlert: cfg.ray30PostExitRequireNewRayalgoAlert,
    fvvoConfidenceMonitorEnabled: cfg.fvvoConfidenceMonitorEnabled,
    fvvoConfidenceMaxAgeSec: cfg.fvvoConfidenceMaxAgeSec,
    fvvoConfidenceUsage: 'BEARISH_BLOCKERS_ENTRY_AND_OPEN_TRADE_GUARD'
  },
  failSafeConfig: {
    stopLossPct: cfg.stopLossPct,
    earlyFailExitEnabled: cfg.ray30EarlyFailExitEnabled,
    earlyFailMaxAgeSec: cfg.ray30EarlyFailMaxAgeSec,
    earlyFailExitPct: cfg.ray30EarlyFailExitPct,
    bearishExitGuardEnabled: cfg.fvvoBearishExitGuardEnabled,
    sniperSellWithinEntrySec: cfg.fvvoExitOnSniperSellWithinEntrySec,
    burstBearishWithinEntrySec: cfg.fvvoExitOnBurstBearishWithinEntrySec,
    bearishExitOnlyIfProfitBelowPct: cfg.fvvoBearishExitOnlyIfProfitBelowPct,
    rayalgoBearExitEnabled: cfg.rayalgoBearExitEnabled,
    rayalgoBearExitMaxAgeSec: cfg.rayalgoBearExitMaxAgeSec,
    rayalgoBearExitRequire5mConfirm: cfg.rayalgoBearExitRequire5mConfirm,
    rayalgoBearExit5mMaxAgeSec: cfg.rayalgoBearExit5mMaxAgeSec
  },
  floorConfig: floorConfigSummary(),
  vRecoveryConfig: vRecoveryConfigSummary(),
  earlyTurnConfig: { enabled: cfg.earlyTurnEnabled && cfg.executionMode === 'demo', sendOrder: cfg.earlyTurnSendOrder, confirmationTicks: cfg.earlyTurnConfirmTicks, confirmationWindow: cfg.earlyTurnConfirmWindow, confirmationMinSec: cfg.earlyTurnConfirmMinSec, confirmTickMinGapSec: cfg.earlyTurnConfirmTickMinGapSec, require30mFeature: cfg.earlyTurnRequire30mFeature, contextMaxAgeSec: cfg.earlyTurnContextMaxAgeSec, allow30mBearExhaustion: cfg.earlyTurnAllowBearExhaustion30m, prior5mRsiCeiling: cfg.earlyTurnPrevRsiMax5m, bearishMemoryMinAgeSec: cfg.earlyTurnBearMinAgeSec, microFloorsEnabled: cfg.microFloorsEnabled, rayalgoConflictGuard: cfg.rayalgoConflictGuardEnabled, rayalgoConflictSettleSec: cfg.rayalgoConflictSettleSec },
  logConfig: {
    logEmojiEnabled: cfg.logEmojiEnabled,
    logFeatureTickEnabled: cfg.logFeatureTickEnabled,
    log15sTickEnabled: cfg.log15sTickEnabled,
    log15sTickEveryN: cfg.log15sTickEveryN,
    logFeature5mEnabled: cfg.logFeature5mEnabled,
    logVRecoveryDropDiagnosticEnabled: cfg.logVRecoveryDropDiagnosticEnabled,
    logC3PayloadAudit: cfg.logC3PayloadAudit,
    ray30ScanLogMode: cfg.ray30ScanLogMode,
    ray30NoEntryLogMode: cfg.ray30NoEntryLogMode,
    logReplayCompactEnabled: cfg.logReplayCompactEnabled
  }
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json(res, 200, publicStatus());
    }

    if (req.method !== 'POST') {
      return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    }

    const body = await readJson(req);

    if (url.pathname === cfg.manualPath) {
      if (!validSecret(body, req, cfg.manualSecret)) {
        return json(res, 403, { ok: false, error: 'BAD_MANUAL_SECRET' });
      }
      const out = await handleManual(body || {}, req);
      return json(res, out.httpStatus || (out.ok ? 200 : 400), stripHttpStatus(out));
    }

    if (url.pathname === cfg.webhookPath) {
      if (!validSecret(body, req, cfg.webhookSecret)) {
        return json(res, 403, { ok: false, error: 'BAD_WEBHOOK_SECRET_OR_SYMBOL' });
      }
      const out = await handleWebhook(body || {}, req);
      return json(res, out.httpStatus || (out.ok ? 200 : 400), stripHttpStatus(out));
    }

    return json(res, 404, { ok: false, error: 'NOT_FOUND', path: url.pathname });
  } catch (err) {
    log('FVVO_SERVER_ERROR', { error: err.message, stack: String(err.stack || '').slice(0, 1000) });
    return json(res, 500, { ok: false, error: 'SERVER_ERROR', message: err.message });
  }
});

server.listen(cfg.port, () => {
  log('FVVO_LISTENING', { brain: BRAIN, port: cfg.port, webhookPath: cfg.webhookPath, manualPath: cfg.manualPath });
});

async function handleManual(body, req) {
  const action = String(body.action || 'status').trim();
  log('FVVO_MANUAL_COMMAND', { action, symbol: body.symbol || cfg.symbol });

  if (!SUPPORTED_MANUAL_ACTIONS.includes(action)) {
    return {
      ok: false,
      error: 'UNKNOWN_MANUAL_ACTION',
      action,
      supportedActions: SUPPORTED_MANUAL_ACTIONS,
      httpStatus: 400
    };
  }

  if (action === 'status') {
    return { ok: true, ...publicStatus() };
  }

  if (action === 'pause_auto_entry') {
    pauseAutomaticEntries('MANUAL_COMMAND_PAUSE');
    return { ok: true, brain: BRAIN, action, autoEntryControl: publicAutoEntryControl(), state: publicState() };
  }

  if (action === 'resume_auto_entry') {
    state.autoEntryControl = { paused: false, reason: null, updatedAt: nowIso() };
    saveState();
    log('FVVO_AUTO_ENTRY_RESUMED_BY_MANUAL_COMMAND', { activePosition: Boolean(state.position && state.position.inPosition) });
    return { ok: true, brain: BRAIN, action, autoEntryControl: publicAutoEntryControl(), state: publicState() };
  }

  if (action === 'force_clear_verified_flat') {
    const previous = state.position;
    state.position = emptyPosition();
    state.priceTrigger = null;
    state.campaigns = {};
    saveState();
    log('FVVO_FORCE_CLEAR_VERIFIED_FLAT', { previousPosition: summarizePosition(previous) });
    return { ok: true, brain: BRAIN, action, cleared: true, state: publicState() };
  }

  if (action === 'adopt_long') {
    const price = priceFrom(body) || latestPrice();
    if (!isFiniteNum(price)) {
      return { ok: false, error: 'NO_PRICE_AVAILABLE_FOR_ADOPT_LONG', httpStatus: 400 };
    }
    state.position = {
      inPosition: true,
      entryPrice: price,
      entryTime: nowIso(),
      source: body.source || 'manual_adopt_long',
      campaignId: body.entry_campaign || null,
      entryRole: body.entry_role || null,
      peakPrice: price,
      mfePct: 0,
      activeFloorLockPct: null,
      runnerActive: false,
      lastExitReason: null,
      lastC3Entry: null,
      lastC3Exit: null
    };
    saveState();
    log('FVVO_MANUAL_LONG_ADOPTED', { price, source: state.position.source });
    return { ok: true, brain: BRAIN, action, adopted: true, price, state: publicState() };
  }

  if (action === 'cancel' || action === 'cancel_price_entry') {
    const hadTrigger = Boolean(state.priceTrigger);
    state.priceTrigger = null;
    saveState();
    log('FVVO_PRICE_TRIGGER_CANCELLED', { hadTrigger, action });
    return { ok: true, brain: BRAIN, action, cancelled: hadTrigger, state: publicState() };
  }

  if (action === 'handoff_manual') {
    state.handoff = { active: true, at: nowIso(), reason: body.reason || 'manual_handoff' };
    saveState();
    log('FVVO_HANDOFF_MANUAL_ENABLED', { reason: state.handoff.reason });
    return { ok: true, brain: BRAIN, action, handoffActive: true, state: publicState() };
  }

  if (action === 'clear_handoff') {
    state.handoff = { active: false, at: nowIso(), reason: body.reason || 'manual_clear_handoff' };
    saveState();
    log('FVVO_HANDOFF_MANUAL_CLEARED', { reason: state.handoff.reason });
    return { ok: true, brain: BRAIN, action, handoffActive: false, state: publicState() };
  }

  if (action === 'cancel_campaign') {
    const campaignId = String(body.entry_campaign || body.campaign || body.campaign_id || '').trim();
    if (campaignId && state.campaigns[campaignId]) {
      state.campaigns[campaignId].status = 'CANCELLED';
      state.campaigns[campaignId].cancelledAt = nowIso();
      log('FVVO_CAMPAIGN_ENTRY_CANCELLED', { campaignId });
    } else if (!campaignId) {
      for (const c of Object.values(state.campaigns)) {
        if (c.status === 'ARMED') {
          c.status = 'CANCELLED';
          c.cancelledAt = nowIso();
        }
      }
      log('FVVO_ALL_CAMPAIGN_ENTRIES_CANCELLED', {});
    }
    saveState();
    return { ok: true, brain: BRAIN, action, campaignId: campaignId || 'ALL', state: publicState() };
  }

  if (action === 'arm_campaign_entry' || action === 'arm_price_entry') {
    return armCampaignOrPriceTrigger(body, action);
  }

  if (action === 'enter_long') {
    const price = priceFrom(body) || latestPrice();
    if (!isFiniteNum(price)) {
      return { ok: false, error: 'NO_PRICE_AVAILABLE_FOR_ENTER_LONG', httpStatus: 400, latest: state.latest };
    }
    const out = await enterLong({
      price,
      source: body.source || 'manual_enter_long',
      campaignId: body.entry_campaign || null,
      entryRole: body.entry_role || null,
      manual: true,
      requestId: body.request_id || null
    });
    return out;
  }

  if (action === 'exit_long') {
    const price = priceFrom(body) || latestPrice() || (state.position && state.position.entryPrice);
    const reason = body.reason || 'manual_exit_long';
    const out = await exitLong({ price, reason, manual: true });
    return out;
  }

  return { ok: false, error: 'UNHANDLED_ACTION', action, httpStatus: 400 };
}

function armCampaignOrPriceTrigger(body, action) {
  const campaignId = String(body.entry_campaign || body.campaign || body.campaign_id || '').trim();
  const entryRole = String(body.entry_role || body.role || 'standalone').trim();
  const triggerMode = String(body.trigger_mode || body.mode || 'trailing_dip_reclaim_zone').trim();
  const now = Date.now();
  const expireAfterSec = intVal(body.expire_after_sec, intEnv('PRICE_TRIGGER_DEFAULT_EXPIRE_SEC', 14400));
  const expiresAtMs = now + expireAfterSec * 1000;

  const setup = {
    id: campaignId || `standalone_${now}`,
    campaignId: campaignId || null,
    entryRole,
    triggerMode,
    status: 'ARMED',
    createdAt: nowIso(),
    createdAtMs: now,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
    symbol: body.symbol || cfg.symbol,
    breakoutConfirmPrice: numVal(body.breakout_confirm_price, null),
    activationPrice: numVal(body.activation_price, null),
    retestRangeLow: numVal(body.retest_range_low, null),
    retestRangeHigh: numVal(body.retest_range_high, null),
    activationRangeLow: numVal(body.activation_range_low, null),
    activationRangeHigh: numVal(body.activation_range_high, null),
    stopPrice: numVal(body.stop_price, null),
    tp1: numVal(body.tp1, null),
    tp2: numVal(body.tp2, null),
    tp3: numVal(body.tp3, null),
    touchedZone: false,
    touchedAt: null,
    lastPrice: latestPrice(),
    informationOnly: boolVal(body.informationOnly, false),
    confirmationRequired: boolVal(body.confirmationRequired, false),
    raw: compactRaw(body)
  };

  const validation = validateSetup(setup);
  if (!validation.ok) {
    return { ok: false, error: validation.error, details: validation.details, setup, httpStatus: 400 };
  }

  if (campaignId) {
    if (!state.campaigns[campaignId]) {
      state.campaigns[campaignId] = { campaignId, status: 'ARMED', roles: {}, createdAt: nowIso() };
    }
    state.campaigns[campaignId].status = 'ARMED';
    state.campaigns[campaignId].roles[entryRole] = setup;
    state.campaigns[campaignId].updatedAt = nowIso();
    log('FVVO_PRICE_TRIGGER_ARMED', setupLog(setup));
    log('FVVO_CAMPAIGN_ENTRY_ARMED', setupLog(setup));
  } else {
    state.priceTrigger = setup;
    log('FVVO_PRICE_TRIGGER_ARMED', setupLog(setup));
  }

  saveState();
  return {
    ok: true,
    brain: BRAIN,
    action,
    armed: true,
    campaignId: campaignId || null,
    entryRole,
    triggerMode,
    expiresAt: setup.expiresAt,
    state: publicState()
  };
}

async function handleWebhook(body, req) {
  const symbol = body.symbol || body.ticker || body.tv_instrument || body.instrument || cfg.symbol;
  if (symbol && normalizeSymbol(symbol) !== normalizeSymbol(cfg.symbol)) {
    return { ok: false, error: 'SYMBOL_REQUIRED', expected: cfg.symbol, received: symbol, httpStatus: 403 };
  }

  const event = String(body.event || body.kind || body.type || '').trim();
  const price = priceFrom(body);
  const nowMs = Number(body.time || body.timestamp_ms || body.timenow || Date.now());

  if (event === 'FEATURE_TICK_FVVO' || event === 'fvvo_feature_tick' || body.kind === 'fvvo_feature_tick') {
    if (isFiniteNum(price)) {
      state.latest.tick = { price, at: nowIso(), atMs: Date.now(), sourceTime: nowMs, raw: compactRaw(body) };
      rememberRecentPrice(price);
      observeVRecoveryTick(price, body);
      log('FVVO_FEATURE_TICK_RECEIVED', featureLogPayload(body, event || body.kind || 'FEATURE_TICK_FVVO', price, 'tick'));
      const evalOut = await evaluateAll(price, 'feature_tick');
      saveState();
      return { ok: true, brain: BRAIN, accepted: true, event: 'FEATURE_TICK_FVVO', price, eval: evalOut, state: publicState() };
    }
  }

  if (event === 'FEATURE_5M_FVVO' || event === 'fvvo_feature_5m' || body.kind === 'fvvo_feature_5m') {
    if (isFiniteNum(price)) {
      state.latest.feature5m = { price, at: nowIso(), atMs: Date.now(), sourceTime: nowMs, raw: compactRaw(body) };
      rememberFeature5mBar(price, body);
      const vAtr = extractRealAtrPct(body, price);
      if (isFiniteNum(vAtr) && vAtr > 0) state.vRecovery.atr5m = { pct:vAtr, atMs:Date.now(), source:'FEATURE_5M_FVVO' };
      rememberRecentPrice(price);
      // Diagnostic-only enrichment. atrPct is the exact validated value stored above.
      // A missing feature ATR is explicit, even when another ATR5M_CONTEXT value is cached.
      log('FVVO_FEATURE_5M_RECEIVED', featureLogPayload(body, event || body.kind || 'FEATURE_5M_FVVO', price, 'feature5m', {
        atrPct: isFiniteNum(vAtr) && vAtr > 0 ? vAtr : null,
        atrSource: isFiniteNum(vAtr) && vAtr > 0 ? 'FEATURE_5M_FVVO' : null
      }));
      if (cfg.vRecoveryEnabled && cfg.logVRecoveryDropDiagnosticEnabled) {
        log('V_RECOVERY_DROP_WINDOW_DIAGNOSTIC', vRecoveryDropWindowDiagnostic());
      }
      const evalOut = await evaluateAll(price, 'feature_5m');
      saveState();
      return { ok: true, brain: BRAIN, accepted: true, event: 'FEATURE_5M_FVVO', price, eval: evalOut, state: publicState() };
    }
  }

  // A separate 5m Pine publisher can supply true 5m ATR%. This NEVER feeds the price-entry or Ray state.
  if (event === 'ATR5M_CONTEXT') {
    const atrPct = extractRealAtrPct(body, price);
    if (!isFiniteNum(atrPct) || atrPct <= 0) return { ok:true, accepted:false, reason:'MISSING_VALID_5M_ATR' };
    state.vRecovery.atr5m = { pct:atrPct, atMs:Date.now(), source:'ATR5M_CONTEXT' };
    saveState();
    log('V_RECOVERY_ATR_5M_RECEIVED', { atrPct:round(atrPct), timeframe:'5' });
    return { ok:true, accepted:true, event:'ATR5M_CONTEXT', atrPct:round(atrPct) };
  }

  if (event === 'FVVO_SIGNAL' || event === 'FVVO_OSCILLATOR_SIGNAL' || body.fvvo_signal || body.confidenceSignal || body.rayTradeSignal) {
    const fvvoSignal = normalizeFvvoConfidenceSignal(body.fvvo_signal || body.confidenceSignal || body.rayTradeSignal || body.signal || event);
    const confidenceSide = fvvoConfidenceSide(fvvoSignal);
    const signalState = {
      signal: fvvoSignal,
      side: confidenceSide,
      price: isFiniteNum(price) ? price : null,
      timeframe: String(body.timeframe || body.tf || body.chartTimeframe || '30'),
      at: nowIso(),
      atMs: Date.now(),
      sourceTime: nowMs,
      sourceKind: 'fvvo_oscillator',
      src: normalizeRaySource(body.src || body.source || '') || 'fvvo_oscillator',
      usage: 'MONITOR_ONLY_NOT_USED_FOR_ENTRY',
      raw: compactRaw(body)
    };

    state.latest.fvvoConfidence = state.latest.fvvoConfidence || {};
    state.latest.fvvoConfidence.last = signalState;
    if (confidenceSide === 'BUY') state.latest.fvvoConfidence.lastBuy = signalState;
    else if (confidenceSide === 'SELL') state.latest.fvvoConfidence.lastSell = signalState;
    else if (confidenceSide === 'BULLISH_MOMENTUM') state.latest.fvvoConfidence.lastBullishMomentum = signalState;
    else if (confidenceSide === 'BEARISH_MOMENTUM') state.latest.fvvoConfidence.lastBearishMomentum = signalState;
    else state.latest.fvvoConfidence.lastOther = signalState;

    if (isFiniteNum(price)) rememberRecentPrice(price);

    log('FVVO_CONFIDENCE_SIGNAL_RECEIVED_MONITOR_ONLY', {
      symbol: cfg.symbol,
      signal: signalState.signal,
      side: signalState.side,
      event: event || 'FVVO_SIGNAL',
      timeframe: signalState.timeframe,
      price: signalState.price,
      sourceKind: signalState.sourceKind,
      src: signalState.src,
      usage: signalState.usage,
      note: 'stored_for_entry_block_and_open_trade_guard'
    });

    const exitOut = isFiniteNum(price) ? await evaluatePositionExit(price, 'fvvo_signal') : null;
    saveState();
    return { ok: true, brain: BRAIN, accepted: true, event: 'FVVO_SIGNAL', signal: signalState.signal, side: signalState.side, usage: signalState.usage, exitEval: exitOut, state: publicState() };
  }

  if (event.includes('RAY') || body.ray_signal || body.signal || looksLikeRayAlgoEvent(event)) {
    const signal = normalizeRaySignal(body.ray_signal || body.signal || event || body.alert || body.condition);
    const regime = normalizeRaySignalToRegime(signal, body.rayRegime ?? body.ray_regime);
    const src = normalizeRaySource(body.src || body.source || body.publisherKind || body.publisher_kind || '');
    const externalRayAlgo = isRayAlgoExternal(body, event, signal, src);
    const rayState = {
      signal,
      regime,
      price: isFiniteNum(price) ? price : null,
      timeframe: String(body.timeframe || body.tf || body.chartTimeframe || '30'),
      at: nowIso(),
      atMs: Date.now(),
      sourceTime: nowMs,
      sourceKind: externalRayAlgo ? 'rayalgo_external' : 'ray30_feature',
      src: src || (externalRayAlgo ? 'rayalgo' : 'ray30_feature'),
      external: externalRayAlgo,
      raw: compactRaw(body)
    };

    // Dedicated 3m reversal receiver: NEVER replace the independent 30m RayAlgo context.
    if (externalRayAlgo && String(rayState.timeframe) === cfg.vRayalgoTf) {
      const normalized = String(signal).toUpperCase();
      const bullishChange = /BULLISH.*TREND.*CHANGE|BULLISH_TREND_CHANGE/.test(normalized);
      const bearishChange = /BEARISH.*TREND.*CHANGE|BEARISH_TREND_CHANGE/.test(normalized);
      if (bullishChange) {
        state.vRecovery.rayBull3m = { signal, atMs:Date.now(), price:isFiniteNum(price)?price:null };
        state.vRecovery.observations = [];
        log('V_RECOVERY_RAY3_BULL_CHANGE_RECEIVED', { timeframe:rayState.timeframe, signal, price });
      } else if (bearishChange && cfg.vRayBearReversalCancel) {
        state.vRecovery.rayBull3m = null;
        state.vRecovery.observations = [];
        log('V_RECOVERY_RAY3_BEAR_CHANGE_CANCELLED', { signal });
      } else {
        log('V_RECOVERY_RAY3_OTHER_MONITOR_ONLY', { signal, timeframe:rayState.timeframe });
      }
      // Exit protection still gets to inspect a fresh executable price; a 3m alert is never itself an entry order.
      const liveTick = state.latest && state.latest.tick;
      const evalPrice = liveTick && isFiniteNum(liveTick.price) && Date.now()-liveTick.atMs <= cfg.featureTickMaxAgeSec*1000 ? liveTick.price : price;
      const exitEval = liveTick && isFiniteNum(liveTick.price) && Date.now()-liveTick.atMs <= cfg.featureTickMaxAgeSec*1000 ? await evaluatePositionExit(evalPrice,'ray3_signal') : null;
      saveState();
      return { ok:true,accepted:true,event:'RAYALGO_3M',signal,exitEval };
    }
    if (externalRayAlgo && String(rayState.timeframe) !== '30' && !rayalgoTimeframeAllowed(rayState.timeframe)) {
      log('RAYALGO_UNROUTED_TIMEFRAME_IGNORED', { signal, timeframe:rayState.timeframe });
      return {ok:true,accepted:false,reason:'UNROUTED_RAYALGO_TIMEFRAME'};
    }
    if (externalRayAlgo && cfg.rayalgoExternalAlertsEnabled) {
      const acceptResult = stageRayAlgoExternal(rayState);
      const setupTfAllowed = rayalgoTimeframeAllowed(rayState.timeframe);
      if (!setupTfAllowed) {
        log('RAYALGO_EXTERNAL_SETUP_IGNORED_TIMEFRAME', {
          signal,
          regime,
          timeframe: rayState.timeframe,
          allowedEntryTimeframes: cfg.rayalgoAllowedEntryTimeframes,
          note: 'external RayAlgo state stored for monitoring, but setup not armed for this timeframe'
        });
      }
      log('FVVO_RAYALGO_EXTERNAL_STATE_UPDATED', {
        symbol: cfg.symbol,
        signal,
        regime,
        sourceKind: rayState.sourceKind,
        timeframe: rayState.timeframe,
        price: rayState.price,
        ttlSec: cfg.rayalgoStateMaxAgeSec,
        setupTfAllowed, reception: acceptResult
      });
    } else {
      state.latest.ray30Feature = rayState;
    }

    state.latest.ray30 = activeRayForGate().state || (externalRayAlgo ? null : rayState);
    // Indicator alert close is not necessarily the latest executable tick; never evaluate an open position
    // against a displaced/stale RayAlgo alert price when fresh 15s price already exists.
    const freshTick = state.latest && state.latest.tick;
    const tickFresh = freshTick && isFiniteNum(freshTick.price) && isFiniteNum(freshTick.atMs) &&
      Date.now() - freshTick.atMs <= cfg.featureTickMaxAgeSec * 1000;
    const marketEvalPrice = tickFresh ? freshTick.price : price;
    if (externalRayAlgo && tickFresh && isFiniteNum(price) && Math.abs(pct(price, freshTick.price)) > 0.25) {
      log('RAYALGO_ALERT_PRICE_DIFFERS_FROM_FRESH_TICK', { alertPrice: price, freshTickPrice: freshTick.price, distancePct: round(pct(price, freshTick.price)), action: 'USE_FRESH_TICK_FOR_EXIT_EVALUATION' });
    }
    if (isFiniteNum(marketEvalPrice)) rememberRecentPrice(marketEvalPrice);
    log('FVVO_RAY30_SIGNAL_RECEIVED', {
      symbol: cfg.symbol,
      signal,
      regime,
      event: event || 'RAY30_SIGNAL',
      timeframe: rayState.timeframe,
      price: isFiniteNum(price) ? price : undefined,
      sourceKind: rayState.sourceKind,
      selectedForGate: (state.latest.ray30 && state.latest.ray30.sourceKind) || rayState.sourceKind,
      src: rayState.src
    });
    const evalOut = isFiniteNum(marketEvalPrice) ? await evaluateAll(marketEvalPrice, 'ray30_signal') : [];
    saveState();
    return { ok: true, brain: BRAIN, accepted: true, event: 'RAY30', signal, regime, raySourceKind: rayState.sourceKind, selectedForGate: state.latest.ray30 && state.latest.ray30.sourceKind, eval: evalOut, state: publicState() };
  }

  if (isFiniteNum(price)) {
    state.latest.tick = { price, at: nowIso(), atMs: Date.now(), sourceTime: nowMs, raw: compactRaw(body) };
    rememberRecentPrice(price);
    log('FVVO_FEATURE_TICK_RECEIVED', featureLogPayload(body, event || 'UNKNOWN_WITH_PRICE', price, 'tick', { fallback: true }));
    const evalOut = await evaluateAll(price, 'fallback_price_tick');
    saveState();
    return { ok: true, brain: BRAIN, accepted: true, event: 'PRICE_FALLBACK', price, eval: evalOut, state: publicState() };
  }

  return { ok: true, brain: BRAIN, accepted: false, reason: 'NO_SUPPORTED_EVENT_OR_PRICE', receivedKeys: Object.keys(body) };
}

async function evaluateAll(price, source) {
  const events = [];
  flushPendingRayAlgo();
  const triggerOut = await evaluateStandaloneTrigger(price, source);
  if (triggerOut) events.push(triggerOut);

  const campaignOut = await evaluateCampaigns(price, source);
  events.push(...campaignOut);

  const vOut = await evaluateVRecoveryAutoEntry(price, source);
  if (vOut) events.push(vOut);
  const earlyOut = await evaluateEarlyTurnAutoEntry(price, source);
  if (earlyOut) events.push(earlyOut);
  const autoOut = await evaluateRay30AutoEntry(price, source);
  if (autoOut) events.push(autoOut);

  const exitOut = await evaluatePositionExit(price, source);
  if (exitOut) events.push(exitOut);

  return events;
}

async function evaluateStandaloneTrigger(price, source) {
  if (automaticEntryPaused()) return null;
  const setup = state.priceTrigger;
  if (!setup || setup.status !== 'ARMED') return null;

  if (Date.now() > setup.expiresAtMs) {
    setup.status = 'EXPIRED';
    setup.expiredAt = nowIso();
    log('FVVO_PRICE_TRIGGER_EXPIRED', setupLog(setup, { price, source }));
    return { type: 'price_trigger_expired', id: setup.id };
  }

  const hit = evaluateSetupHit(setup, price);
  if (hit.touch && !setup.touchedZone) {
    setup.touchedZone = true;
    setup.touchedAt = nowIso();
    log('FVVO_PRICE_TRIGGER_ZONE_TOUCHED', setupLog(setup, { price, source }));
  }
  if (hit.enter) {
    setup.status = 'TRIGGERED';
    setup.triggeredAt = nowIso();
    log('FVVO_PRICE_TRIGGER_ENTRY_READY', setupLog(setup, { price, source, reason: hit.reason }));
    const out = await enterLong({ price, source: `price_trigger_${setup.triggerMode}`, campaignId: null, entryRole: setup.entryRole, setup });
    return { type: 'price_trigger_entry', enterResult: out };
  }
  return null;
}

async function evaluateCampaigns(price, source) {
  if (automaticEntryPaused()) return [];
  const outs = [];
  for (const [campaignId, campaign] of Object.entries(state.campaigns || {})) {
    if (!campaign || campaign.status !== 'ARMED') continue;

    let armedRoleCount = 0;
    for (const [role, setup] of Object.entries(campaign.roles || {})) {
      if (!setup || setup.status !== 'ARMED') continue;
      armedRoleCount++;

      if (Date.now() > setup.expiresAtMs) {
        setup.status = 'EXPIRED';
        setup.expiredAt = nowIso();
        log('FVVO_PRICE_TRIGGER_EXPIRED', setupLog(setup, { price, source }));
        log('FVVO_CAMPAIGN_ENTRY_SETUP_EXPIRED', setupLog(setup, { price, source }));
        if (setup.triggerMode === 'breakout_retest_reclaim_zone') {
          log('FVVO_BREAKOUT_RETEST_POST_EXPIRY_SHADOW_ARMED', setupLog(setup, { price, source, shadow: true }));
        }
        outs.push({ type: 'campaign_role_expired', campaignId, role });
        continue;
      }

      const hit = evaluateSetupHit(setup, price);
      if (hit.touch && !setup.touchedZone) {
        setup.touchedZone = true;
        setup.touchedAt = nowIso();
        log('FVVO_CAMPAIGN_ENTRY_ZONE_TOUCHED', setupLog(setup, { price, source }));
      }
      if (hit.enter) {
        setup.status = 'TRIGGERED';
        setup.triggeredAt = nowIso();
        campaign.status = 'TRIGGERED';
        campaign.triggeredRole = role;
        campaign.triggeredAt = nowIso();
        log('FVVO_CAMPAIGN_ENTRY_READY', setupLog(setup, { price, source, reason: hit.reason }));
        const out = await enterLong({ price, source: `campaign_${setup.triggerMode}`, campaignId, entryRole: role, setup });
        outs.push({ type: 'campaign_entry', campaignId, role, enterResult: out });
        break;
      }
    }

    const remaining = Object.values(campaign.roles || {}).filter(s => s && s.status === 'ARMED').length;
    if (remaining === 0 && campaign.status === 'ARMED') {
      campaign.status = 'EXPIRED';
      campaign.expiredAt = nowIso();
    }
  }
  return outs;
}

function evaluateSetupHit(setup, price) {
  const mode = setup.triggerMode;
  const arLow = setup.activationRangeLow;
  const arHigh = setup.activationRangeHigh;
  const rtLow = setup.retestRangeLow;
  const rtHigh = setup.retestRangeHigh;
  const confirm = setup.breakoutConfirmPrice || setup.activationPrice || arHigh || rtHigh;

  if (mode === 'breakout_retest_reclaim_zone') {
    const inRetest = rangeContains(price, rtLow, rtHigh);
    if (inRetest) return { touch: true, enter: false, reason: 'RETEST_ZONE_TOUCHED' };
    if (setup.touchedZone && isFiniteNum(confirm) && price >= confirm) {
      return { touch: false, enter: true, reason: 'BREAKOUT_RETEST_RECLAIM_CONFIRMED' };
    }
    return { touch: false, enter: false, reason: 'WAIT_RETEST_OR_RECLAIM' };
  }

  if (mode === 'confirmed_pullback_reclaim_zone' || mode === 'trailing_dip_reclaim_zone') {
    const inActivation = rangeContains(price, arLow, arHigh) || rangeContains(price, rtLow, rtHigh);
    if (inActivation) return { touch: true, enter: false, reason: 'PULLBACK_ZONE_TOUCHED' };
    if (setup.touchedZone && isFiniteNum(confirm) && price >= confirm) {
      return { touch: false, enter: true, reason: 'PULLBACK_RECLAIM_CONFIRMED' };
    }
    if (!isFiniteNum(arLow) && !isFiniteNum(arHigh) && isFiniteNum(setup.activationPrice) && price >= setup.activationPrice) {
      return { touch: true, enter: true, reason: 'ACTIVATION_PRICE_RECLAIM_CONFIRMED' };
    }
    return { touch: false, enter: false, reason: 'WAIT_PULLBACK_OR_RECLAIM' };
  }

  if (isFiniteNum(setup.activationPrice) && price >= setup.activationPrice) {
    return { touch: true, enter: true, reason: 'ACTIVATION_PRICE_HIT' };
  }

  return { touch: false, enter: false, reason: 'NO_MATCH' };
}

async function enterLong({ price, source, campaignId, entryRole, setup, manual, requestId }) {
  // One authoritative guard: every automatic path ends here, including future scanners.
  // Manual entries remain possible while automatic entry is paused.
  if (!manual && automaticEntryPaused()) {
    log('FVVO_AUTO_ENTRY_BLOCKED_BY_MANUAL_LOCK', { price, source, control: publicAutoEntryControl() });
    return { ok: false, error: 'AUTO_ENTRY_PAUSED', httpStatus: 409, autoEntryControl: publicAutoEntryControl() };
  }
  if (entrySubmissionPending) {
    log('FVVO_ENTER_LONG_BLOCKED_ENTRY_SUBMISSION_PENDING', { price, source });
    return { ok: false, error: 'ENTRY_SUBMISSION_PENDING', httpStatus: 409 };
  }
  if (state.position && state.position.inPosition) {
    log('FVVO_ENTER_LONG_BLOCKED_ALREADY_IN_POSITION', { price, source, campaignId, entryRole, existing: summarizePosition(state.position) });
    return { ok: false, error: 'ALREADY_IN_POSITION', httpStatus: 409, state: publicState() };
  }

  if (manual) {
    cancelOpenSetupsForImmediateManualEntry();
  }

  const entryRequestId = requestId || makeRequestId('enter_long');
  const stopPrice = setup && isFiniteNum(setup.stopPrice) ? setup.stopPrice : null;
  const profitTargetPrice = setup && isFiniteNum(setup.tp1) ? setup.tp1 : null;

  log('FVVO_TRADE_OPEN_PENDING', {
    profile: (setup && setup.raw && setup.raw.profile) || 'SWING_BALANCED_STRUCTURE_EXIT',
    entryPriceReference: price,
    stopPrice,
    profitTargetPrice,
    entrySizeSource: cfg.c3AmountPerTrade ? 'webhook_json' : 'bot_fixed_or_signal_code',
    entryOrderIncludedInWebhook: Boolean(cfg.c3AmountPerTrade),
    dynamicProfitEnabled: true,
    dynamicProfitArmMfePct: cfg.floor1MfePct,
    dynamicProfitMinLockPnlPct: cfg.floor1LockPct,
    requestId: entryRequestId
  });

  let forward;
  entrySubmissionPending = true;
  try {
    forward = await forwardTo3Commas('enter_long', price, { source, campaignId, entryRole, requestId: entryRequestId, setup, reason: source });
  } finally { entrySubmissionPending = false; }
  if (!forward.ok && !forward.dryRun) {
    log('FVVO_ENTER_LONG_C3_FORWARD_FAILED_NO_POSITION_TRACKED', { price, source, campaignId, entryRole, forward });
    return { ok: false, error: 'C3_ENTER_LONG_FORWARD_FAILED', c3Forward: forward, httpStatus: 502, state: publicState() };
  }

  state.position = {
    inPosition: true,
    positionLifecycle: forward.dryRun ? 'ENTRY_DRY_RUN' : 'ENTRY_ACCEPTED_UNVERIFIED_FILL',
    phase: source === 'v_recovery_probation_auto' ? 'V_RECOVERY_PROBATION' : (source === 'early_turn_probation_auto' ? 'EARLY_TURN_PROBATION' : 'LONGHOLD_CONFIRMED'),
    longholdConfirmedAt: ['early_turn_probation_auto','v_recovery_probation_auto'].includes(source) ? null : nowIso(),
    entryPrice: price,
    entryTime: nowIso(),
    entryTimeMs: Date.now(),
    vRecoveryLow: source === 'v_recovery_probation_auto' && state.vRecovery.candidate ? state.vRecovery.candidate.low : null,
    source,
    campaignId: campaignId || null,
    entryRole: entryRole || null,
    peakPrice: price,
    mfePct: 0,
    activeFloorLockPct: null,
    runnerActive: false,
    lastExitReason: null,
    lastC3Entry: forward,
    lastC3Exit: null
  };
  saveState();
  log('FVVO_MANUAL_ONE_STOP_ENTRY_TRACKED', { price, source, campaignId, entryRole, requestId: entryRequestId, fillVerified: false, c3Forward: summarizeForward(forward) });
  return { ok: true, brain: BRAIN, action: 'enter_long', entered: true, price, source, c3Forward: forward, state: publicState() };
}

async function exitLong({ price, reason, manual }) {
  const hadOpenPosition = Boolean(state.position && state.position.inPosition);
  const prev = hadOpenPosition ? { ...state.position } : emptyPosition();
  const exitPrice = isFiniteNum(price)
    ? price
    : (hadOpenPosition ? (state.position.peakPrice || state.position.entryPrice) : latestPrice());

  if (!hadOpenPosition && !manual) {
    return { ok: false, error: 'NO_OPEN_POSITION', reason, httpStatus: 409, state: publicState() };
  }

  if (!hadOpenPosition && manual) {
    log('FVVO_EXIT_LONG_NO_OPEN_POSITION_BUT_FORWARDING_EXIT_ALL', { reason, price: exitPrice });
  }

  const exitRequestId = makeRequestId('exit_long');
  const forward = await forwardTo3Commas('exit_long', exitPrice, { reason, manual, requestId: exitRequestId });
  if (!forward.ok && !forward.dryRun) {
    log('FVVO_EXIT_LONG_C3_FORWARD_FAILED_POSITION_LEFT_ACTIVE', { price: exitPrice, reason, forward, hadOpenPosition });
    return { ok: false, error: 'C3_EXIT_LONG_FORWARD_FAILED_POSITION_LEFT_ACTIVE', c3Forward: forward, httpStatus: 502, positionStillActive: hadOpenPosition, state: publicState() };
  }

  handleRay30PostExitAfterAcceptedExit({ reason, exitPrice, previousPosition: prev });

  state.position = emptyPosition();
  state.position.lastExitReason = reason;
  state.position.lastC3Exit = forward;
  if (manual && cfg.autoEntryPauseAfterManualExit) {
    pauseAutomaticEntries('MANUAL_EXIT_REQUIRES_EXPLICIT_RESUME');
  }
  saveState();
  log('FVVO_MANUAL_EXIT_LONG_ACCEPTED', { price: exitPrice, reason, hadOpenPosition, requestId: exitRequestId, c3Forward: summarizeForward(forward) });
  return { ok: true, brain: BRAIN, action: 'exit_long', exited: true, price: exitPrice, reason, c3Forward: forward, previousPosition: summarizePosition(prev), state: publicState() };
}



function handleRay30PostExitAfterAcceptedExit({ reason, exitPrice, previousPosition }) {
  if (!cfg.ray30ClearSetupOnExit) return;
  const exitProfitPct = (previousPosition && isFiniteNum(previousPosition.entryPrice) && previousPosition.entryPrice > 0 && isFiniteNum(exitPrice))
    ? pct(exitPrice, previousPosition.entryPrice)
    : null;
  const profitLike = isProfitLikeExitReason(reason) || (isFiniteNum(exitProfitPct) && exitProfitPct >= 0);
  if (cfg.ray30ClearSetupOnProfitExitOnly && !profitLike) return;

  const oldSetup = summarizeRay30Setup(state.ray30Setup, 'BEFORE_CLEAR_ON_EXIT');
  const now = Date.now();
  state.ray30Setup = {
    active: false,
    clearedAt: nowIso(),
    clearReason: reason || 'EXIT_LONG_ACCEPTED',
    previousSetup: oldSetup && oldSetup.active ? oldSetup : null
  };
  state.ray30Pullback = { armed: false };
  state.ray30PostExit = {
    active: true,
    at: nowIso(),
    atMs: now,
    reason: reason || 'EXIT_LONG_ACCEPTED',
    exitPrice: isFiniteNum(exitPrice) ? exitPrice : null,
    exitProfitPct: isFiniteNum(exitProfitPct) ? round(exitProfitPct) : null,
    cooldownSec: cfg.ray30PostExitCooldownSec,
    cooldownUntilMs: now + Math.max(0, cfg.ray30PostExitCooldownSec) * 1000,
    cooldownUntil: cfg.ray30PostExitCooldownSec > 0 ? new Date(now + cfg.ray30PostExitCooldownSec * 1000).toISOString() : null,
    requireNewRayalgo: cfg.ray30PostExitRequireNewRayalgoAlert,
    freshRayalgoSatisfiedAt: null,
    freshRayalgoSignal: null
  };
  log('RAY30_SETUP_CLEARED_AFTER_EXIT', {
    reason,
    exitPrice,
    exitProfitPct: isFiniteNum(exitProfitPct) ? round(exitProfitPct) : null,
    clearSetupOnProfitExitOnly: cfg.ray30ClearSetupOnProfitExitOnly,
    cooldownSec: cfg.ray30PostExitCooldownSec,
    cooldownUntil: state.ray30PostExit.cooldownUntil,
    requireNewRayalgo: cfg.ray30PostExitRequireNewRayalgoAlert,
    oldSetup
  });
}

function isProfitLikeExitReason(reason) {
  const r = String(reason || '').toUpperCase();
  return r.includes('FLOOR') || r.includes('LOCK') || r.includes('RUNNER') || r.includes('PROGRESSIVE') || r.includes('PROTECTIVE') || r.includes('PERMANENT');
}

function ray30PostExitStatus() {
  const pe = state.ray30PostExit || null;
  if (!pe || !pe.active) return { active: false, cooldownActive: false, requireNewRayalgo: false };
  const now = Date.now();
  const cooldownActive = Boolean(pe.cooldownUntilMs && now < pe.cooldownUntilMs);
  const requireNewRayalgo = Boolean(cfg.ray30PostExitRequireNewRayalgoAlert && pe.requireNewRayalgo);
  return {
    active: cooldownActive || requireNewRayalgo,
    cooldownActive,
    requireNewRayalgo,
    reason: pe.reason || null,
    exitPrice: pe.exitPrice || null,
    exitProfitPct: pe.exitProfitPct || null,
    cooldownUntil: pe.cooldownUntil || null,
    remainingCooldownSec: cooldownActive ? Math.max(0, Math.ceil((pe.cooldownUntilMs - now) / 1000)) : 0,
    freshRayalgoSatisfiedAt: pe.freshRayalgoSatisfiedAt || null,
    freshRayalgoSignal: pe.freshRayalgoSignal || null
  };
}

function summarizePostExitForStatus() {
  return ray30PostExitStatus();
}

function markFreshRayalgoAfterExit(rayState) {
  if (!state.ray30PostExit || !state.ray30PostExit.active || !state.ray30PostExit.requireNewRayalgo) return;
  const exitAtMs = numVal(state.ray30PostExit.atMs, 0);
  if (rayState && isFiniteNum(rayState.atMs) && rayState.atMs > exitAtMs) {
    state.ray30PostExit.requireNewRayalgo = false;
    state.ray30PostExit.freshRayalgoSatisfiedAt = nowIso();
    state.ray30PostExit.freshRayalgoSignal = rayState.signal || null;
    log('RAY30_POST_EXIT_NEW_RAYALGO_ALERT_ACCEPTED', {
      signal: rayState.signal,
      regime: rayState.regime,
      timeframe: rayState.timeframe,
      price: rayState.price,
      cooldownStatus: ray30PostExitStatus()
    });
  }
}

// v3q: quarantine contradictory opposite RayAlgo condition alerts within one 30m bar.
// A short settlement window prevents the first alert from promoting/closing before an opposite alert arrives.
function rayBarKey(t) { return Math.floor(t / (cfg.rayalgoConflictBarMinutes * 60000)); }
function activeRayAlgoConflict() {
  const c = state.rayalgoSignalGuard && state.rayalgoSignalGuard.conflict;
  return c && c.barKey === rayBarKey(Date.now()) ? { ...c } : null;
}
function applyRayAlgoExternalState(ray) {
  if (!ray || ray.sourceKind !== 'rayalgo_external') return;
  if (activeRayAlgoConflict()) return;
  state.latest.rayalgoExternal = ray;
  promoteEarlyTurnOnExternalBull(ray);
  if (cfg.ray30SetupEntryEnabled && rayalgoTimeframeAllowed(ray.timeframe)) updateRay30EntrySetupFromRayAlgo(ray);
  log('RAYALGO_EXTERNAL_CONFIRMED', { signal: ray.signal, regime: ray.regime, timeframe: ray.timeframe, atMs: ray.atMs, barKey: rayBarKey(ray.atMs) });
}
function stageRayAlgoExternal(ray) {
  if (!cfg.rayalgoConflictGuardEnabled || !rayalgoTimeframeAllowed(ray.timeframe)) {
    applyRayAlgoExternalState(ray); return 'ACCEPTED_NO_GUARD';
  }
  const g = state.rayalgoSignalGuard = state.rayalgoSignalGuard || { pending: null, lastAccepted: null, conflict: null };
  const barKey = rayBarKey(ray.atMs);
  if (g.conflict && g.conflict.barKey !== barKey) g.conflict = null;
  if (g.conflict && g.conflict.barKey === barKey) {
    log('RAYALGO_CONFLICT_ALERT_IGNORED', { signal: ray.signal, barKey });
    return 'BLOCKED_CONFLICT';
  }
  const p = g.pending;
  const prior = (p && rayBarKey(p.atMs) === barKey) ? p : (g.lastAccepted && g.lastAccepted.barKey === barKey ? g.lastAccepted : null);
  const otherRegime = prior && (prior.regime || normalizeRaySignalToRegime(prior.signal));
  if (prior && otherRegime !== ray.regime && ['RAY_BULL','RAY_BEAR'].includes(otherRegime) && ['RAY_BULL','RAY_BEAR'].includes(ray.regime)) {
    g.pending = null;
    g.conflict = { barKey, firstSignal: prior.signal, secondSignal: ray.signal, firstRegime: otherRegime, secondRegime: ray.regime, atMs: Date.now() };
    if (state.latest.rayalgoExternal && rayBarKey(state.latest.rayalgoExternal.atMs) === barKey) state.latest.rayalgoExternal = null;
    const position = state.position;
    if (position && position.inPosition && position.phase === 'LONGHOLD_CONFIRMED' && ['early_turn_probation_auto','v_recovery_probation_auto'].includes(position.source) && position.longholdConfirmedRayBarKey === barKey) {
      position.phase = position.source === 'v_recovery_probation_auto' ? 'V_RECOVERY_PROBATION' : 'EARLY_TURN_PROBATION';
      position.longholdConfirmedAt = null;
      position.longholdConfirmedRayBarKey = null;
      log('EARLY_TURN_LONGHOLD_PROMOTION_REVOKED_ON_RAY_CONFLICT', { barKey, entryPrice: position.entryPrice, mfePct: position.mfePct, note:'NO_EXIT_ORDER_NO_MFE_RESET' });
    }
    state.ray30Setup = { active: false, conflictBarKey: barKey, cancelReason: 'RAYALGO_SAME_BAR_CONFLICT' };
    log('RAYALGO_SAME_BAR_CONFLICT_BLOCK', g.conflict);
    return 'BLOCKED_CONFLICT';
  }
  if (p && rayBarKey(p.atMs) !== barKey) flushPendingRayAlgo(true);
  g.pending = ray;
  log('RAYALGO_EXTERNAL_PENDING_CONFIRM', { signal: ray.signal, regime: ray.regime, barKey, settleSec: cfg.rayalgoConflictSettleSec });
  if (!cfg.rayalgoConflictSettleSec) flushPendingRayAlgo(true);
  return 'PENDING_CONFIRM';
}
function flushPendingRayAlgo(force = false) {
  const g = state.rayalgoSignalGuard;
  if (!g || !g.pending) return;
  if (activeRayAlgoConflict()) { g.pending = null; return; }
  const p = g.pending;
  if (!force && Date.now() - p.atMs < cfg.rayalgoConflictSettleSec * 1000) return;
  g.pending = null;
  g.lastAccepted = { signal: p.signal, regime: p.regime, barKey: rayBarKey(p.atMs), atMs: p.atMs };
  applyRayAlgoExternalState(p);
}
function earlyTurn30mContextStatus() {
  if (activeRayAlgoConflict()) return { ok: false, reason: 'RAYALGO_30M_SIGNAL_CONFLICT' };
  const p = state.rayalgoSignalGuard && state.rayalgoSignalGuard.pending;
  if (p && p.regime === 'RAY_BEAR') return { ok: false, reason: 'PENDING_RAYALGO_BEAR' };
  if (!cfg.earlyTurnRequire30mFeature) return { ok: true, reason: 'CONTEXT_GUARD_DISABLED' };
  const f = state.latest && state.latest.ray30Feature;
  if (!f || !f.atMs) return { ok: false, reason: 'MISSING_30M_FEATURE' };
  const ageSec = (Date.now() - f.atMs) / 1000;
  if (ageSec < 0 || ageSec > cfg.earlyTurnContextMaxAgeSec) return { ok: false, reason: 'STALE_30M_FEATURE', ageSec: roundOrNull(ageSec) };
  if (String(f.timeframe) !== '30') return { ok: false, reason: 'WRONG_30M_FEATURE_TIMEFRAME', timeframe: f.timeframe };
  const regime = normalizeRaySignalToRegime(f.signal, f.regime);
  const ok = regime === 'RAY_NEUTRAL' || regime === 'RAY_BULL' || (cfg.earlyTurnAllowBearExhaustion30m && String(f.signal).toUpperCase() === 'RAY_BEAR_EXHAUSTION');
  return { ok, reason: ok ? 'ALLOWED_30M_CONTEXT' : 'EARLY_TURN_30M_CONTEXT_BLOCKED', regime, signal: f.signal, ageSec: roundOrNull(ageSec) };
}
function earlyTurnVeto(reason, details = {}) {
  const turn = state.earlyTurn;
  if (cfg.earlyTurnDiagnosticsEnabled && turn && turn.lastVeto !== reason) {
    turn.lastVeto = reason;
    log('EARLY_TURN_SCAN_VETO', { reason, ...details });
  }
  return null;
}

// v3p uses actual closed-bar 5m publisher events, NOT synthetic future candles.
function rememberFeature5mBar(price, raw) {
  const history = state.latest.feature5mHistory = state.latest.feature5mHistory || [];
  const key = Number(raw.barTimeMs || raw.bar_time_ms || raw.barTime || 0) || Date.now();
  if (history.length && history[history.length - 1].key === key) return;
  const item = {
    key, atMs: Date.now(), price,
    rsi: numVal(raw.rsi, null), fvvo: numVal(raw.fvvo ?? raw.fvvoValue, null),
    slope: numVal(raw.slope ?? raw.fvvoSlope, null),
    ema8: numVal(raw.ema8 ?? raw.ema_8, null), ema18: numVal(raw.ema18 ?? raw.ema_18, null)
  };
  if (![item.rsi, item.fvvo, item.slope, item.ema8, item.ema18].every(isFiniteNum)) return;
  history.push(item);
  if (history.length > 50) history.splice(0, history.length - 50);
  if (item.rsi < cfg.earlyTurnResetRsi5m || item.fvvo < cfg.earlyTurnResetFvvo5m) {
    const oldLastEntryAtMs = state.earlyTurn && state.earlyTurn.lastEntryAtMs || null;
    state.earlyTurn = { confirmedCandidate: null, confirmCount: 0, firstTickAtMs: null, lastTickAtMs: null, used: false, lastEntryAtMs: oldLastEntryAtMs };
    log('EARLY_TURN_CYCLE_RESET', { price, rsi: item.rsi, fvvo: item.fvvo });
  }
}

function promoteEarlyTurnOnExternalBull(ray) {
  if (!ray || ray.sourceKind !== 'rayalgo_external' || !rayalgoTimeframeAllowed(ray.timeframe)) return;
  if (normalizeRaySignalToRegime(ray.signal, ray.regime) !== 'RAY_BULL') return;
  const p = state.position;
  if (!p || !p.inPosition || !['EARLY_TURN_PROBATION','V_RECOVERY_PROBATION'].includes(p.phase)) return;
  if (!isFiniteNum(p.entryTimeMs) || ray.atMs <= p.entryTimeMs) return;
  p.phase = 'LONGHOLD_CONFIRMED';
  p.longholdConfirmedAt = nowIso();
  p.longholdConfirmedRayBarKey = rayBarKey(ray.atMs);
  log('EARLY_TURN_PROMOTED_TO_LONGHOLD', { entryPrice: p.entryPrice, peakPrice: p.peakPrice, mfePct: round(p.mfePct), at: p.longholdConfirmedAt, raySignal: ray.signal, rayTimeframe: ray.timeframe, note: 'SAME_POSITION_NO_SECOND_ORDER_NO_MFE_RESET' });
  saveState();
}

function earlyTurnProbationFailure(p, price, source) {
  if (!p || !['EARLY_TURN_PROBATION','V_RECOVERY_PROBATION'].includes(p.phase)) return { exit: false };
  if (source !== 'feature_5m') return { exit: false };
  const recent = state.latest.feature5mHistory || [];
  const weak = recent.slice(-cfg.earlyTurnProbationExitConfirmBars);
  if (weak.length < cfg.earlyTurnProbationExitConfirmBars || weak.some(x => !isFiniteNum(x.atMs) || x.atMs < p.entryTimeMs)) return { exit: false };
  const allWeak = weak.every(x => x.rsi <= cfg.earlyTurnProbationExitRsi5m && x.fvvo <= cfg.earlyTurnProbationExitFvvo5m && x.price < x.ema18);
  return allWeak ? { exit: true, reason: p.phase === 'V_RECOVERY_PROBATION' ? 'V_RECOVERY_CONFIRMED_5M_THESIS_FAIL' : 'EARLY_TURN_CONFIRMED_5M_THESIS_FAIL', bars: weak.map(x=>({ rsi:x.rsi, fvvo:x.fvvo, price:x.price })) } : { exit: false };
}

async function evaluateEarlyTurnAutoEntry(price, source) {
  // Live account is hard-disabled even if the environment accidentally enables the feature.
  if (!cfg.earlyTurnEnabled || cfg.executionMode !== 'demo') return null;
  if (!isFiniteNum(price) || (source !== 'feature_tick' && source !== 'feature_5m')) return null;
  if (state.position && state.position.inPosition) return null;
  const pe = ray30PostExitStatus();
  if (pe.cooldownActive || pe.requireNewRayalgo) return null;
  // Early-turn path ends once external 30m RayAlgo has already confirmed bullish.
  // Continue via the unchanged v3o RayAlgo-confirmed entry scanner instead.
  const pendingRay = state.rayalgoSignalGuard && state.rayalgoSignalGuard.pending;
  if (pendingRay && pendingRay.regime === 'RAY_BULL') return earlyTurnVeto('PENDING_EXTERNAL_RAYALGO_BULL');
  const existingRay = state.latest && state.latest.rayalgoExternal;
  if (existingRay && rayalgoTimeframeAllowed(existingRay.timeframe) &&
      normalizeRaySignalToRegime(existingRay.signal, existingRay.regime) === 'RAY_BULL' &&
      isFiniteNum(existingRay.atMs) && Date.now() - existingRay.atMs <= cfg.rayalgoStateMaxAgeSec * 1000) return null;
  const turn = state.earlyTurn;
  if (turn.used) return null; // exactly one early-turn entry per recovery cycle
  if (isFiniteNum(turn.lastEntryAtMs) && Date.now() - turn.lastEntryAtMs < cfg.earlyTurnRetryCooldownSec * 1000) return null;
  const bars = state.latest.feature5mHistory || [];
  if (bars.length < 3) return earlyTurnVeto('MISSING_3_CLOSED_5M_BARS');
  const context = earlyTurn30mContextStatus();
  if (!context.ok) return earlyTurnVeto(context.reason, context);
  const [older, prev, cur] = bars.slice(-3);
  // Only contiguous confirmed 5m candles qualify; never bridge an interrupted TradingView feed.
  const barGapOk = [cur.key - prev.key, prev.key - older.key].every(gap => gap >= 240000 && gap <= 360000);
  if (!barGapOk) return earlyTurnVeto('5M_BARS_NOT_CONSECUTIVE');
  if (Date.now() - cur.atMs > cfg.feature5mMaxAgeSec * 1000) return null;
  const low = Math.min(older.price, prev.price, cur.price);
  const rise = pct(cur.price, low);
  // Two positive closed bars, positive RSI recovery, short EMA close to crossover.
  // Close-based recovery proxy, not an actual candle higher-low (publisher does not send OHLC lows).
  const closeRecovery = prev.price <= older.price || (cur.price > older.price && cur.ema8 >= prev.ema8);
  const fiveReady = closeRecovery && cur.rsi >= cfg.earlyTurnMinRsi5m && cur.rsi <= cfg.earlyTurnMaxRsi5m &&
    cur.fvvo >= cfg.earlyTurnMinFvvo5m && cur.slope >= cfg.earlyTurnMinSlope5m &&
    prev.fvvo > 0 && prev.rsi <= cfg.earlyTurnPrevRsiMax5m && cur.rsi > prev.rsi && cur.price > prev.price &&
    rise >= cfg.earlyTurnMinRiseFromLowPct && rise <= cfg.earlyTurnMaxRiseFromLowPct &&
    cur.price >= cur.ema18 && pct(cur.price, cur.ema18) <= cfg.earlyTurnMaxAboveEma18Pct &&
    cur.ema8 >= cur.ema18 * (1 - cfg.earlyTurnEma8Below18AllowancePct / 100);
  if (!fiveReady) { turn.confirmedCandidate = null; turn.confirmCount = 0; turn.tickConfirmHistory = []; return earlyTurnVeto('5M_RECOVERY_NOT_READY', { prevRsi: roundOrNull(prev.rsi), prevRsiCeiling: cfg.earlyTurnPrevRsiMax5m }); }
  // Initial bearish memory must be old enough to prevent instant catch-the-knife buys.
  const ext = state.latest.rayalgoExternal;
  if (ext && normalizeRaySignalToRegime(ext.signal, ext.regime) === 'RAY_BEAR') {
    const ageSec = (Date.now() - ext.atMs) / 1000;
    if (!Number.isFinite(ageSec) || ageSec < cfg.earlyTurnBearMinAgeSec) return earlyTurnVeto('RECENT_EXTERNAL_RAYALGO_BEAR');
  }
  const block = fvvoLongBlockStatus();
  if (block.blocked) return earlyTurnVeto('RECENT_FVVO_BEARISH_BLOCK');
  if (source !== 'feature_tick') return null;
  const tick = tickGate(price);
  const tickReady = tick.fresh && tick.rsi >= cfg.earlyTurnMinRsi15s && tick.rsi <= cfg.earlyTurnMaxRsi15s &&
    tick.fvvo >= cfg.earlyTurnMinFvvo15s && tick.slope >= cfg.earlyTurnMinTickSlope &&
    (!isFiniteNum(tick.ema18) || price >= tick.ema18) &&
    price <= cur.ema18 * (1 + cfg.earlyTurnMaxAboveEma18Pct / 100);
  // v3q: 3 valid observations of the last 4 ticks (default); do not count duplicate/rapid samples.
  if (turn.confirmedCandidate !== cur.key) {
    turn.confirmedCandidate = cur.key;
    turn.tickConfirmHistory = [];
    turn.confirmCount = 0;
  }
  const now = Date.now();
  turn.tickConfirmHistory = turn.tickConfirmHistory || [];
  if (turn.lastTickAtMs && now - turn.lastTickAtMs < cfg.earlyTurnConfirmTickMinGapSec * 1000) return earlyTurnVeto('WAIT_15S_SEPARATION');
  turn.lastTickAtMs = now;
  turn.tickConfirmHistory.push({ ok: tickReady, atMs: now, positiveSlope: tickReady && tick.slope >= 0 });
  turn.tickConfirmHistory = turn.tickConfirmHistory.slice(-cfg.earlyTurnConfirmWindow);
  const observations = turn.tickConfirmHistory;
  const valid = observations.filter(x => x.ok);
  turn.confirmCount = valid.length;
  const spanSec = valid.length ? (now - valid[0].atMs) / 1000 : 0;
  if (!tickReady || valid.length < cfg.earlyTurnConfirmTicks || spanSec < cfg.earlyTurnConfirmMinSec ||
      (cfg.earlyTurnConfirmPositiveSlope && !valid.some(x => x.positiveSlope))) {
    return earlyTurnVeto('WAIT_15S_CONFIRMATION', { validTicks: valid.length, window: observations.length, needed: cfg.earlyTurnConfirmTicks, minSec: cfg.earlyTurnConfirmMinSec });
  }
  turn.lastVeto = null;
  const details = { price, source, rsi5m:cur.rsi, fvvo5m:cur.fvvo, riseFromLowPct:round(rise), ema8:cur.ema8, ema18:cur.ema18, tickRsi:tick.rsi, tickFvvo:tick.fvvo, observedTicks:turn.confirmCount, mode:'EARLY_TURN_PROBATION', context30m: context, confirmationWindow: cfg.earlyTurnConfirmWindow };
  // Send orders only in DEMO; SHADOW mode can be used for diagnostics.
  if (!cfg.earlyTurnSendOrder || !cfg.ray30AutoEntryEnabled || !cfg.ray30AutoEntrySendOrder) {
    log('EARLY_TURN_SHADOW_READY', details);
    turn.used = true;
    saveState();
    return { type:'early_turn_shadow', decision:'SHADOW_READY' };
  }
  log('EARLY_TURN_PROBATION_ENTRY_READY', details);
  const out = await enterLong({ price, source:'early_turn_probation_auto', campaignId:null, entryRole:'early_turn_probation', setup:{raw:{profile:'EARLY_TURN_PROBATION'}, stopPrice:null, tp1:null} });
  if (out && out.ok) { turn.used = true; turn.lastEntryAtMs = Date.now(); saveState(); }
  return { type:'early_turn_entry', decision:out && out.ok ? 'ENTERED' : 'ENTER_FAILED', out };
}

async function evaluateRay30AutoEntry(price, source) {
  if (!isFiniteNum(price)) return null;

  const scan = buildRay30EntryScan(price, source);
  const shouldLogScan = cfg.ray30EntryScanLogEnabled && shouldLogRay30Scan(scan, source);
  if (shouldLogScan) logRay30EntryScan(scan);

  // Momentum observed but 15s is overheated: arm pullback instead of chasing.
  if (scan.overheated && scan.rayGate.ok && scan.fiveOk.trendOk && scan.externalSetupOk && !(scan.confidenceBlock && scan.confidenceBlock.blocked) && !state.position.inPosition) {
    if (!state.ray30Pullback || !state.ray30Pullback.armed) {
      state.ray30Pullback = {
        armed: true,
        armedAt: nowIso(),
        armedPrice: price,
        highPrice: price,
        reason: '15S_RSI_OVERHEATED_WAIT_PULLBACK',
        source
      };
      log('RAY30_NO_CHASE_OVERHEATED', {
        price,
        source,
        tickRsi: scan.tickOk.rsi,
        threshold: cfg.ray30NoChaseRsi15s,
        action: 'WAIT_PULLBACK_RECLAIM'
      });
      log('RAY30_PULLBACK_ARMED_AFTER_MOMENTUM', {
        price,
        source,
        raySignal: scan.rayGate.signal,
        fiveRsi: scan.fiveOk.rsi,
        fiveAdx: scan.fiveOk.adx,
        tickRsi: scan.tickOk.rsi
      });
    } else if (price > numVal(state.ray30Pullback.highPrice, 0)) {
      state.ray30Pullback.highPrice = price;
    }
    saveState();
    return { type: 'ray30_auto_entry_scan', decision: 'WAIT_PULLBACK', reason: '15S_RSI_OVERHEATED_WAIT_PULLBACK', scan };
  }

  if (scan.pullbackReclaimReady && !scan.pullbackRecoveryReady && (!cfg.rayalgoRequireExternalSetupForEntry || !cfg.ray30SetupEntryEnabled) && !state.position.inPosition) {
    const payload = {
      price,
      source,
      raySignal: scan.rayGate.signal,
      fiveRsi: scan.fiveOk.rsi,
      tickRsi: scan.tickOk.rsi,
      tickFvvo: scan.tickOk.fvvo,
      armedAt: state.ray30Pullback && state.ray30Pullback.armedAt,
      autoEntryEnabled: cfg.ray30AutoEntryEnabled,
      sendOrder: cfg.ray30AutoEntrySendOrder
    };
    if (!cfg.ray30AutoEntryEnabled || !cfg.ray30AutoEntrySendOrder) {
      log('RAY30_PULLBACK_RECLAIM_ENTRY_SHADOW', payload);
      return { type: 'ray30_pullback_reclaim_shadow', decision: 'SHADOW_ENTRY_READY', scan };
    }
    log('RAY30_PULLBACK_RECLAIM_ENTRY_READY', payload);
    state.ray30Pullback.armed = false;
    state.ray30Pullback.completedAt = nowIso();
    const out = await enterLong({
      price,
      source: 'ray30_pullback_reclaim_auto',
      campaignId: null,
      entryRole: 'ray30_pullback_reclaim',
      setup: { raw: { profile: 'RAY30_AUTO_ENTRY' }, stopPrice: null, tp1: null }
    });
    return { type: 'ray30_pullback_reclaim_entry', decision: out.ok ? 'ENTERED' : 'ENTER_FAILED', out, scan };
  }

  if (scan.instantQualifiedReady && !state.position.inPosition) {
    const payload = {
      price,
      source,
      setup: scan.setup,
      raySignal: scan.rayGate.signal,
      fiveRsi: scan.fiveOk.rsi,
      fiveFvvo: scan.fiveOk.fvvo,
      tickRsi: scan.tickOk.rsi,
      tickFvvo: scan.tickOk.fvvo,
      autoEntryEnabled: cfg.ray30AutoEntryEnabled,
      sendOrder: cfg.ray30AutoEntrySendOrder
    };
    if (!cfg.ray30AutoEntryEnabled || !cfg.ray30AutoEntrySendOrder) {
      log('RAY30_INSTANT_QUALIFIED_ENTRY_SHADOW', payload);
      return { type: 'ray30_instant_qualified_shadow', decision: 'SHADOW_ENTRY_READY', scan };
    }
    log('RAY30_INSTANT_QUALIFIED_ENTRY_READY', payload);
    if (state.ray30Setup) state.ray30Setup.completedAt = nowIso();
    const out = await enterLong({
      price,
      source: 'ray30_instant_qualified_auto',
      campaignId: null,
      entryRole: 'ray30_instant_qualified',
      setup: { raw: { profile: 'RAY30_INSTANT_QUALIFIED_AUTO' }, stopPrice: null, tp1: null }
    });
    return { type: 'ray30_instant_qualified_entry', decision: out.ok ? 'ENTERED' : 'ENTER_FAILED', out, scan };
  }

  if (scan.pullbackRecoveryReady && !state.position.inPosition) {
    const payload = {
      price,
      source,
      setup: scan.setup,
      raySignal: scan.rayGate.signal,
      fiveRsi: scan.fiveOk.rsi,
      fiveFvvo: scan.fiveOk.fvvo,
      tickRsi: scan.tickOk.rsi,
      tickFvvo: scan.tickOk.fvvo,
      autoEntryEnabled: cfg.ray30AutoEntryEnabled,
      sendOrder: cfg.ray30AutoEntrySendOrder
    };
    if (!cfg.ray30AutoEntryEnabled || !cfg.ray30AutoEntrySendOrder) {
      log('RAY30_PULLBACK_RECOVERY_ENTRY_SHADOW', payload);
      return { type: 'ray30_pullback_recovery_shadow', decision: 'SHADOW_ENTRY_READY', scan };
    }
    log('RAY30_PULLBACK_RECOVERY_ENTRY_READY', payload);
    if (state.ray30Setup) state.ray30Setup.completedAt = nowIso();
    const out = await enterLong({
      price,
      source: 'ray30_pullback_recovery_auto',
      campaignId: null,
      entryRole: 'ray30_pullback_recovery',
      setup: { raw: { profile: 'RAY30_PULLBACK_RECOVERY_AUTO' }, stopPrice: null, tp1: null }
    });
    return { type: 'ray30_pullback_recovery_entry', decision: out.ok ? 'ENTERED' : 'ENTER_FAILED', out, scan };
  }

  if (scan.breakoutContinuationReady && !state.position.inPosition) {
    const payload = {
      price,
      source,
      setup: scan.setup,
      raySignal: scan.rayGate.signal,
      fiveRsi: scan.fiveOk.rsi,
      fiveFvvo: scan.fiveOk.fvvo,
      tickRsi: scan.tickOk.rsi,
      tickFvvo: scan.tickOk.fvvo,
      autoEntryEnabled: cfg.ray30AutoEntryEnabled,
      sendOrder: cfg.ray30AutoEntrySendOrder
    };
    if (!cfg.ray30AutoEntryEnabled || !cfg.ray30AutoEntrySendOrder) {
      log('RAY30_BREAKOUT_CONTINUATION_ENTRY_SHADOW', payload);
      return { type: 'ray30_breakout_continuation_shadow', decision: 'SHADOW_ENTRY_READY', scan };
    }
    log('RAY30_BREAKOUT_CONTINUATION_ENTRY_READY', payload);
    if (state.ray30Setup) state.ray30Setup.completedAt = nowIso();
    const out = await enterLong({
      price,
      source: 'ray30_breakout_continuation_auto',
      campaignId: null,
      entryRole: 'ray30_breakout_continuation',
      setup: { raw: { profile: 'RAY30_BREAKOUT_CONTINUATION_AUTO' }, stopPrice: null, tp1: null }
    });
    return { type: 'ray30_breakout_continuation_entry', decision: out.ok ? 'ENTERED' : 'ENTER_FAILED', out, scan };
  }

  if (scan.enterReady && !state.position.inPosition) {
    const payload = {
      price,
      source,
      raySignal: scan.rayGate.signal,
      fiveRsi: scan.fiveOk.rsi,
      fiveAdx: scan.fiveOk.adx,
      tickRsi: scan.tickOk.rsi,
      tickFvvo: scan.tickOk.fvvo,
      autoEntryEnabled: cfg.ray30AutoEntryEnabled,
      sendOrder: cfg.ray30AutoEntrySendOrder
    };
    if (!cfg.ray30AutoEntryEnabled || !cfg.ray30AutoEntrySendOrder) {
      log('RAY30_AUTO_ENTRY_READY_SHADOW', payload);
      return { type: 'ray30_auto_entry_shadow', decision: 'SHADOW_ENTRY_READY', scan };
    }
    log('RAY30_AUTO_ENTRY_READY', payload);
    const out = await enterLong({
      price,
      source: 'ray30_auto_entry',
      campaignId: null,
      entryRole: 'ray30_auto',
      setup: { raw: { profile: 'RAY30_AUTO_ENTRY' }, stopPrice: null, tp1: null }
    });
    return { type: 'ray30_auto_entry', decision: out.ok ? 'ENTERED' : 'ENTER_FAILED', out, scan };
  }

  if (scan.decision === 'NO_ENTRY' && shouldLogRay30NoEntry(scan, source)) {
    log('RAY30_ENTRY_NO_ENTRY', compactRay30Scan(scan));
  }
  return { type: 'ray30_auto_entry_scan', decision: scan.decision, reason: scan.reason, scan };
}

function buildRay30EntryScan(price, source) {
  const rayGate = ray30Gate();
  const fiveOk = feature5mGate();
  const tickOk = tickGate(price);
  const inPosition = Boolean(state.position && state.position.inPosition);
  const overheated = isFiniteNum(tickOk.rsi) && tickOk.rsi >= cfg.ray30NoChaseRsi15s;
  const pullback = state.ray30Pullback || { armed: false };
  const setup = updateRay30EntrySetupForScan(price, source, rayGate, fiveOk, tickOk);
  const externalSetupOk = setupAllowsEntry(setup);
  const confidenceBlock = fvvoLongBlockStatus();
  const confidenceBlocked = Boolean(confidenceBlock.blocked);

  const legacyPullbackReclaimReadyRaw = Boolean(
    pullback.armed &&
    rayGate.ok &&
    fiveOk.trendOk &&
    tickOk.fresh &&
    isFiniteNum(tickOk.rsi) && tickOk.rsi >= cfg.ray30MinRsi15s && tickOk.rsi <= cfg.ray30PullbackReclaimMaxRsi15s &&
    isFiniteNum(tickOk.fvvo) && tickOk.fvvo >= cfg.ray30MinFvvo15s &&
    (!isFiniteNum(tickOk.ema18) || price >= tickOk.ema18)
  );

  // v3l hard fix: legacy no-chase pullback reclaim cannot place orders when external setup is required.
  const legacyPullbackReclaimReady = Boolean(
    legacyPullbackReclaimReadyRaw &&
    (!cfg.rayalgoRequireExternalSetupForEntry || !cfg.ray30SetupEntryEnabled) &&
    !confidenceBlocked
  );

  const instantQualifiedReady = Boolean(setup.instantQualifiedReady && externalSetupOk && !confidenceBlocked);
  const pullbackRecoveryReady = Boolean(setup.pullbackRecoveryReady && externalSetupOk && !confidenceBlocked);
  const breakoutContinuationReady = Boolean(setup.breakoutContinuationReady && externalSetupOk && !confidenceBlocked);
  const pullbackReclaimReady = Boolean(legacyPullbackReclaimReady || pullbackRecoveryReady);

  // v3j/v3l: RayAlgo is a setup gate. Direct legacy entry is disabled; setup legs decide entries.
  const directEntryAllowed = !cfg.ray30SetupEntryEnabled && !cfg.rayalgoRequireExternalSetupForEntry;
  const enterReady = Boolean(
    directEntryAllowed &&
    !inPosition &&
    rayGate.ok &&
    fiveOk.ok &&
    tickOk.ok &&
    !overheated &&
    !confidenceBlocked
  );

  let decision = enterReady ? 'ENTER_READY' : 'NO_ENTRY';
  let reason = enterReady ? 'ALL_GATES_OK' : firstFailReason(rayGate, fiveOk, tickOk, inPosition, overheated);
  if (!inPosition && confidenceBlocked && (rayGate.ok || setup.active)) {
    decision = 'ENTRY_BLOCKED';
    reason = confidenceBlock.reason;
  } else if (instantQualifiedReady) {
    decision = 'INSTANT_QUALIFIED_READY';
    reason = 'RAYALGO_BULL_INSTANT_QUALIFIED_READY';
  } else if (pullbackRecoveryReady) {
    decision = 'PULLBACK_RECOVERY_READY';
    reason = 'RAYALGO_BULL_PULLBACK_RECOVERY_READY';
  } else if (breakoutContinuationReady) {
    decision = 'BREAKOUT_CONTINUATION_READY';
    reason = 'RAYALGO_BULL_BREAKOUT_CONTINUATION_READY';
  } else if (legacyPullbackReclaimReady) {
    decision = 'PULLBACK_RECLAIM_READY';
    reason = 'PULLBACK_RECLAIM_AFTER_OVERHEATED_MOMENTUM';
  } else if (cfg.ray30SetupEntryEnabled && !inPosition && rayGate.ok) {
    decision = externalSetupOk ? 'WAIT_SETUP' : 'WAIT_EXTERNAL_SETUP';
    reason = externalSetupOk ? (setup.reason || 'WAITING_PULLBACK_OR_BREAKOUT_SETUP') : 'WAITING_ALLOWED_EXTERNAL_RAYALGO_SETUP';
  } else if (overheated && rayGate.ok && fiveOk.trendOk && externalSetupOk) {
    decision = 'WAIT_PULLBACK';
    reason = '15S_RSI_OVERHEATED_WAIT_PULLBACK';
  }

  return {
    source,
    price,
    decision,
    reason,
    enterReady,
    instantQualifiedReady,
    pullbackReclaimReady,
    legacyPullbackReclaimReady,
    legacyPullbackReclaimReadyRaw,
    pullbackRecoveryReady,
    breakoutContinuationReady,
    externalSetupOk,
    confidenceBlock,
    overheated,
    inPosition,
    autoEntryEnabled: cfg.ray30AutoEntryEnabled,
    autoEntrySendOrder: cfg.ray30AutoEntrySendOrder,
    rayGate,
    fiveOk,
    tickOk,
    setup,
    postExit: ray30PostExitStatus(),
    pullback: summarizePullback(pullback)
  };
}


function updateRay30EntrySetupFromRayAlgo(rayState) {
  if (!rayState || !cfg.ray30SetupEntryEnabled) return;
  const regime = normalizeRaySignalToRegime(rayState.signal, rayState.regime);
  if (regime === 'RAY_BULL') {
    if (!rayalgoTimeframeAllowed(rayState.timeframe)) {
      log('RAYALGO_BULL_SETUP_NOT_ARMED_TIMEFRAME', { signal: rayState.signal, timeframe: rayState.timeframe, allowedEntryTimeframes: cfg.rayalgoAllowedEntryTimeframes });
      return;
    }
    markFreshRayalgoAfterExit(rayState);
    const price = isFiniteNum(rayState.price) ? rayState.price : latestPrice();
    const now = Date.now();
    state.ray30Setup = {
      active: true,
      mode: 'WAIT_INSTANT_PULLBACK_OR_BREAKOUT',
      signal: rayState.signal,
      regime,
      sourceKind: rayState.sourceKind || 'rayalgo_external',
      timeframe: String(rayState.timeframe || cfg.rayalgoSetupTimeframe || '15'),
      rayAt: nowIso(),
      rayAtMs: now,
      rayPrice: isFiniteNum(price) ? price : null,
      highPrice: isFiniteNum(price) ? price : null,
      lowPrice: isFiniteNum(price) ? price : null,
      pullbackSeen: false,
      pullbackLowPrice: null,
      breakoutSeen: false,
      completedAt: null,
      expiresAtMs: now + cfg.ray30SetupTtlSec * 1000
    };
    log('RAYALGO_BULL_SETUP_ARMED', {
      signal: rayState.signal,
      regime,
      price: state.ray30Setup.rayPrice,
      timeframe: state.ray30Setup.timeframe,
      ttlSec: cfg.ray30SetupTtlSec,
      instantMaxAfterRaySec: cfg.ray30InstantMaxAfterRaySec,
      pullbackMinDipPct: cfg.ray30PullbackMinDipPct,
      breakoutMinMoveFromRayPct: cfg.ray30BreakoutMinMoveFromRayPct
    });
  } else if (regime === 'RAY_BEAR') {
    state.ray30Setup = { active: false, cancelledAt: nowIso(), cancelReason: rayState.signal || 'RAY_BEAR' };
    state.ray30Pullback = { armed: false };
    log('RAYALGO_BULL_SETUP_CANCELLED', { signal: rayState.signal, regime, reason: 'RAYALGO_BEAR_SIGNAL' });
  }
}

function updateRay30EntrySetupForScan(price, source, rayGate, fiveOk, tickOk) {
  if (!cfg.ray30SetupEntryEnabled) return { active: false, reason: 'SETUP_ENTRY_DISABLED' };
  const now = Date.now();
  const postExit = ray30PostExitStatus();
  if (postExit.requireNewRayalgo) return { active: false, reason: 'POST_EXIT_REQUIRE_NEW_RAYALGO_ALERT', postExit };
  if (postExit.cooldownActive) return { active: false, reason: 'POST_EXIT_COOLDOWN', postExit };

  if ((!state.ray30Setup || !state.ray30Setup.active) && rayGate.ok && rayGate.sourceKind === 'rayalgo_external') {
    const ext = state.latest && state.latest.rayalgoExternal;
    const lastExit = state.ray30PostExit && state.ray30PostExit.atMs;
    const isOldAlert = cfg.ray30DisallowHistoricalBullRearmAfterExit && isFiniteNum(lastExit) && (!ext || !isFiniteNum(ext.atMs) || ext.atMs <= lastExit);
    if (ext && !isOldAlert) updateRay30EntrySetupFromRayAlgo(ext);
  }

  const s = state.ray30Setup;
  if (!s || !s.active) return { active: false, reason: 'WAITING_RAYALGO_BULL_SETUP' };
  if (s.completedAt) return { active: false, reason: 'SETUP_ALREADY_COMPLETED' };
  if (s.expiresAtMs && now > s.expiresAtMs) {
    s.active = false;
    s.cancelledAt = nowIso();
    s.cancelReason = 'SETUP_EXPIRED';
    return summarizeRay30Setup(s, 'SETUP_EXPIRED');
  }
  if (!rayGate.ok) return summarizeRay30Setup(s, rayGate.reason || 'RAY_GATE_NOT_OK');

  if (isFiniteNum(price)) {
    if (!isFiniteNum(s.rayPrice)) s.rayPrice = price;
    if (!isFiniteNum(s.highPrice) || price > s.highPrice) s.highPrice = price;
    if (!isFiniteNum(s.lowPrice) || price < s.lowPrice) s.lowPrice = price;
  }

  const rayAgeSec = s.rayAtMs ? (now - s.rayAtMs) / 1000 : null;
  const dipFromHighPct = (isFiniteNum(price) && isFiniteNum(s.highPrice) && s.highPrice > 0) ? ((s.highPrice - price) / s.highPrice) * 100 : 0;
  const moveFromRayPct = (isFiniteNum(price) && isFiniteNum(s.rayPrice) && s.rayPrice > 0) ? pct(price, s.rayPrice) : 0;

  const instantSourceOk = !cfg.ray30InstantRequireNext15sTick || source === 'feature_tick';
  const instantAgeOk = isFiniteNum(rayAgeSec) && rayAgeSec <= cfg.ray30InstantMaxAfterRaySec;
  const fiveInstantOk = Boolean(
    fiveOk.fresh &&
    isFiniteNum(fiveOk.rsi) && fiveOk.rsi >= cfg.ray30Instant5mMinRsi && fiveOk.rsi <= cfg.ray30Instant5mMaxRsi &&
    isFiniteNum(fiveOk.adx) && fiveOk.adx >= cfg.ray30MinAdx5m &&
    isFiniteNum(fiveOk.fvvo) && fiveOk.fvvo >= cfg.ray30Instant5mMinFvvo &&
    isFiniteNum(fiveOk.slope) && fiveOk.slope >= cfg.ray30Instant5mMinSlope &&
    (!isFiniteNum(fiveOk.ema18) || !isFiniteNum(fiveOk.price) || fiveOk.price >= fiveOk.ema18) &&
    emaExtensionOk(fiveOk.price, fiveOk.ema8, cfg.ray30InstantMaxExtEma8Pct) &&
    emaExtensionOk(fiveOk.price, fiveOk.ema18, cfg.ray30InstantMaxExtEma18Pct)
  );
  const tickInstantOk = Boolean(
    tickOk.fresh &&
    isFiniteNum(tickOk.rsi) && tickOk.rsi >= cfg.ray30Instant15sMinRsi && tickOk.rsi <= cfg.ray30Instant15sMaxRsi &&
    isFiniteNum(tickOk.fvvo) && tickOk.fvvo >= cfg.ray30Instant15sMinFvvo &&
    isFiniteNum(tickOk.slope) && tickOk.slope >= cfg.ray30Instant15sMinSlope &&
    (!isFiniteNum(tickOk.ema18) || price >= tickOk.ema18) &&
    emaExtensionOk(price, tickOk.ema8, cfg.ray30InstantMaxExtEma8Pct) &&
    emaExtensionOk(price, tickOk.ema18, cfg.ray30InstantMaxExtEma18Pct)
  );
  const instantQualifiedReady = Boolean(
    cfg.ray30InstantQualifiedEntryEnabled &&
    instantSourceOk &&
    instantAgeOk &&
    !s.pullbackSeen &&
    dipFromHighPct < cfg.ray30PullbackMinDipPct &&
    fiveInstantOk &&
    tickInstantOk
  );

  if (!s.pullbackSeen && dipFromHighPct >= cfg.ray30PullbackMinDipPct) {
    s.pullbackSeen = true;
    s.pullbackSeenAt = nowIso();
    s.pullbackLowPrice = price;
    log('RAY30_PULLBACK_SEEN_AFTER_RAYALGO_BULL', { price, highPrice: s.highPrice, dipFromHighPct: round(dipFromHighPct), rayPrice: s.rayPrice, moveFromRayPct: round(moveFromRayPct) });
  }
  if (s.pullbackSeen && isFiniteNum(price) && (!isFiniteNum(s.pullbackLowPrice) || price < s.pullbackLowPrice)) s.pullbackLowPrice = price;

  const fivePullbackOk = Boolean(
    fiveOk.fresh &&
    isFiniteNum(fiveOk.rsi) && fiveOk.rsi >= cfg.ray30Pullback5mMinRsi && fiveOk.rsi <= cfg.ray30MaxRsi5m &&
    isFiniteNum(fiveOk.adx) && fiveOk.adx >= cfg.ray30MinAdx5m &&
    isFiniteNum(fiveOk.fvvo) && fiveOk.fvvo >= cfg.ray30Pullback5mMinFvvo &&
    isFiniteNum(fiveOk.slope) && fiveOk.slope >= cfg.ray30Pullback5mMinSlope &&
    (!cfg.ray30PullbackRequire5mAboveEma18 || !isFiniteNum(fiveOk.ema18) || !isFiniteNum(fiveOk.price) || fiveOk.price >= fiveOk.ema18) &&
    (!cfg.ray30PullbackRequire5mEma8AboveEma18 || !isFiniteNum(fiveOk.ema8) || !isFiniteNum(fiveOk.ema18) || fiveOk.ema8 >= fiveOk.ema18)
  );
  const tickPullbackOk = Boolean(
    tickOk.fresh &&
    isFiniteNum(tickOk.rsi) && tickOk.rsi >= cfg.ray30Pullback15sMinRsi && tickOk.rsi <= cfg.ray30Pullback15sMaxRsi &&
    isFiniteNum(tickOk.fvvo) && tickOk.fvvo >= cfg.ray30Pullback15sMinFvvo &&
    (!isFiniteNum(tickOk.ema18) || price >= tickOk.ema18)
  );
  const pullbackAntiChaseOk = Boolean(
    !cfg.ray30PullbackAntiChaseEnabled ||
    !isFiniteNum(moveFromRayPct) ||
    moveFromRayPct <= cfg.ray30PullbackEntryMaxMoveFromRayPct ||
    (isFiniteNum(dipFromHighPct) && dipFromHighPct >= cfg.ray30PullbackEntryMinDipFromHighPct)
  );
  const pullbackRecoveryReady = Boolean(
    cfg.ray30PullbackEntryEnabled &&
    s.pullbackSeen &&
    dipFromHighPct <= cfg.ray30PullbackMaxDipPct &&
    pullbackAntiChaseOk &&
    fivePullbackOk &&
    tickPullbackOk
  );

  const fiveBreakoutOk = Boolean(
    fiveOk.fresh &&
    isFiniteNum(fiveOk.rsi) && fiveOk.rsi >= cfg.ray30Breakout5mMinRsi && fiveOk.rsi <= cfg.ray30Breakout5mMaxRsi &&
    isFiniteNum(fiveOk.adx) && fiveOk.adx >= cfg.ray30MinAdx5m &&
    isFiniteNum(fiveOk.fvvo) && fiveOk.fvvo >= cfg.ray30Breakout5mMinFvvo &&
    isFiniteNum(fiveOk.slope) && fiveOk.slope >= cfg.ray30Breakout5mMinSlope &&
    (!isFiniteNum(fiveOk.ema18) || !isFiniteNum(fiveOk.price) || fiveOk.price >= fiveOk.ema18)
  );
  const tickBreakoutOk = Boolean(
    tickOk.fresh &&
    isFiniteNum(tickOk.rsi) && tickOk.rsi >= cfg.ray30Breakout15sMinRsi && tickOk.rsi <= cfg.ray30Breakout15sMaxRsi &&
    isFiniteNum(tickOk.fvvo) && tickOk.fvvo >= cfg.ray30Breakout15sMinFvvo &&
    isFiniteNum(tickOk.slope) && tickOk.slope >= cfg.ray30Breakout15sMinSlope &&
    (!isFiniteNum(tickOk.ema18) || price >= tickOk.ema18)
  );
  const breakoutContinuationReady = Boolean(
    cfg.ray30BreakoutEntryEnabled &&
    !s.pullbackSeen &&
    isFiniteNum(rayAgeSec) && rayAgeSec >= cfg.ray30BreakoutMinWaitSec &&
    moveFromRayPct >= cfg.ray30BreakoutMinMoveFromRayPct &&
    fiveBreakoutOk &&
    tickBreakoutOk
  );

  let reason = 'WAITING_INSTANT_PULLBACK_OR_BREAKOUT_SETUP';
  if (instantQualifiedReady) reason = 'INSTANT_QUALIFIED_READY';
  else if (pullbackRecoveryReady) reason = 'PULLBACK_RECOVERY_READY';
  else if (breakoutContinuationReady) reason = 'BREAKOUT_CONTINUATION_READY';
  else if (s.pullbackSeen) reason = !pullbackAntiChaseOk ? 'WAIT_PULLBACK_ANTI_CHASE_DIP' : (!fivePullbackOk ? 'WAIT_PULLBACK_5M_RECOVERY' : (!tickPullbackOk ? 'WAIT_PULLBACK_15S_RECLAIM' : 'WAIT_PULLBACK_RECOVERY'));
  else if (moveFromRayPct >= cfg.ray30BreakoutMinMoveFromRayPct) reason = !fiveBreakoutOk ? 'WAIT_BREAKOUT_5M_CONFIRM' : (!tickBreakoutOk ? 'WAIT_BREAKOUT_15S_CONFIRM' : 'WAIT_BREAKOUT_CONFIRM');
  else if (isFiniteNum(rayAgeSec) && rayAgeSec < cfg.ray30SetupNoImmediateEntrySec) reason = 'NO_IMMEDIATE_ENTRY_AFTER_RAYALGO_BULL';

  return summarizeRay30Setup(s, reason, { rayAgeSec, dipFromHighPct, moveFromRayPct, pullbackAntiChaseOk, instantSourceOk, instantAgeOk, fiveInstantOk, tickInstantOk, instantQualifiedReady, fivePullbackOk, tickPullbackOk, fiveBreakoutOk, tickBreakoutOk, pullbackRecoveryReady, breakoutContinuationReady });
}

function summarizeRay30Setup(s, reason, extra) {
  if (!s) return { active: false, reason: reason || 'NO_SETUP' };
  return Object.assign({
    active: Boolean(s.active),
    mode: s.mode || null,
    signal: s.signal || null,
    sourceKind: s.sourceKind || null,
    timeframe: s.timeframe || null,
    rayAt: s.rayAt || null,
    rayPrice: roundOrNull(s.rayPrice),
    highPrice: roundOrNull(s.highPrice),
    lowPrice: roundOrNull(s.lowPrice),
    pullbackSeen: Boolean(s.pullbackSeen),
    pullbackLowPrice: roundOrNull(s.pullbackLowPrice),
    reason: reason || null
  }, extra || {});
}

function firstFailReason(rayGate, fiveOk, tickOk, inPosition, overheated) {
  if (inPosition) return 'ALREADY_IN_POSITION';
  if (!rayGate.ok) return rayGate.reason || 'RAY30_NOT_OK';
  if (!fiveOk.ok) return fiveOk.reason || 'FEATURE_5M_NOT_OK';
  if (overheated) return '15S_RSI_OVERHEATED_WAIT_PULLBACK';
  if (!tickOk.ok) return tickOk.reason || 'FEATURE_TICK_NOT_OK';
  return 'NO_ENTRY_CONDITIONS';
}

function ray30Gate() {
  if (activeRayAlgoConflict()) return { ok: false, fresh: false, signal: 'CONFLICT', regime: 'RAY_NEUTRAL', sourceKind: 'rayalgo_conflict', ageSec: null, reason: 'RAYALGO_SAME_BAR_CONFLICT' };
  const pendingBear = state.rayalgoSignalGuard && state.rayalgoSignalGuard.pending;
  if (pendingBear && pendingBear.regime === 'RAY_BEAR') return { ok: false, fresh: false, signal: 'PENDING_BEAR', regime: 'RAY_BEAR', sourceKind: 'rayalgo_pending', ageSec: null, reason: 'RAYALGO_PENDING_BEAR_NO_NEW_ENTRY' };
  const selected = activeRayForGate();
  const r = selected.state;
  const ageSec = selected.ageSec;
  const fresh = Boolean(r && selected.fresh);
  const signal = r ? (r.signal || 'UNKNOWN') : 'MISSING';
  const regime = r ? normalizeRaySignalToRegime(signal, r.regime || (r.raw && (r.raw.rayRegime || r.raw.ray_regime))) : 'RAY_NEUTRAL';
  const sourceKind = r ? (r.sourceKind || 'unknown') : 'missing';
  const reasonPrefix = `${sourceKind}:${selected.reason || 'selected'}`;
  if (String(cfg.ray30LongGateMode).toUpperCase() === 'EASY_TEST') {
    return { ok: true, mode: cfg.ray30LongGateMode, fresh, ageSec: roundOrNull(ageSec), signal, regime, sourceKind, selectedReason: selected.reason, reason: fresh ? `EASY_ALLOWED_WITH_RAY_${reasonPrefix}` : 'EASY_ALLOWED_RAY_STALE_OR_MISSING' };
  }
  const ok = fresh && regime === 'RAY_BULL';
  return { ok, mode: cfg.ray30LongGateMode, fresh, ageSec: roundOrNull(ageSec), signal, regime, sourceKind, selectedReason: selected.reason, reason: ok ? `RAY30_BULL_FRESH_${reasonPrefix}` : (!fresh ? 'RAY30_STALE_OR_MISSING' : `RAY30_NOT_BULL_${regime}_${sourceKind}`) };
}

function activeRayForGate() {
  const now = Date.now();
  const ext = state.latest && state.latest.rayalgoExternal;
  const feat = state.latest && (state.latest.ray30Feature || state.latest.ray30);
  const extAgeSec = ext && ext.atMs ? (now - ext.atMs) / 1000 : null;
  const featAgeSec = feat && feat.atMs ? (now - feat.atMs) / 1000 : null;
  const extFresh = Boolean(ext && extAgeSec !== null && extAgeSec <= cfg.rayalgoStateMaxAgeSec);
  const featFresh = Boolean(feat && featAgeSec !== null && featAgeSec <= cfg.ray30MaxRayAgeSec);

  if (cfg.ray30UseRayalgoExternalPriority && cfg.rayalgoStateMemoryEnabled && extFresh) {
    return { state: ext, ageSec: extAgeSec, fresh: true, reason: 'rayalgo_external_priority' };
  }
  if (cfg.ray30FeatureProxyFallbackEnabled && featFresh) {
    return { state: feat, ageSec: featAgeSec, fresh: true, reason: 'ray30_feature_fallback' };
  }
  if (cfg.rayalgoStateMemoryEnabled && ext) {
    return { state: ext, ageSec: extAgeSec, fresh: false, reason: 'rayalgo_external_stale' };
  }
  if (feat) return { state: feat, ageSec: featAgeSec, fresh: false, reason: 'ray30_feature_stale' };
  return { state: null, ageSec: null, fresh: false, reason: 'missing' };
}

function emaExtensionOk(price, ema, maxExtPct) {
  if (!isFiniteNum(price) || !isFiniteNum(ema) || ema <= 0) return true;
  if (price < ema) return false;
  return pct(price, ema) <= maxExtPct;
}

function feature5mGate() {
  const f = state.latest && state.latest.feature5m;
  const raw = f && f.raw ? f.raw : {};
  const ageSec = f && f.atMs ? (Date.now() - f.atMs) / 1000 : null;
  const fresh = Boolean(f && ageSec !== null && ageSec <= cfg.feature5mMaxAgeSec);
  const rsi = numVal(raw.rsi, null);
  const adx = numVal(raw.adx, null);
  const fvvo = numVal(raw.fvvo ?? raw.fvvoValue, null);
  const slope = numVal(raw.slope ?? raw.fvvoSlope, null);
  const ema8 = numVal(raw.ema8 ?? raw.ema_8, null);
  const ema18 = numVal(raw.ema18 ?? raw.ema_18, null);
  const price = f && isFiniteNum(f.price) ? f.price : null;
  const trendOk = Boolean(fresh && isFiniteNum(rsi) && isFiniteNum(adx) && isFiniteNum(fvvo) && rsi >= cfg.ray30MinRsi5m && adx >= cfg.ray30MinAdx5m && fvvo >= cfg.ray30MinFvvo5m && (!isFiniteNum(ema18) || price >= ema18));
  let reason = 'OK';
  if (!fresh) reason = 'MISSING_OR_STALE_5M';
  else if (!isFiniteNum(rsi) || rsi < cfg.ray30MinRsi5m) reason = '5M_RSI_LOW';
  else if (rsi > cfg.ray30MaxRsi5m) reason = '5M_RSI_TOO_HOT_FOR_DIRECT_ENTRY';
  else if (!isFiniteNum(adx) || adx < cfg.ray30MinAdx5m) reason = '5M_ADX_LOW';
  else if (!isFiniteNum(fvvo) || fvvo < cfg.ray30MinFvvo5m) reason = '5M_FVVO_LOW';
  else if (!isFiniteNum(slope) || slope < cfg.ray30MinSlope5m) reason = '5M_SLOPE_NOT_IMPROVING';
  else if (isFiniteNum(ema18) && isFiniteNum(price) && price < ema18) reason = '5M_PRICE_BELOW_EMA18';
  return { ok: reason === 'OK', trendOk, reason, fresh, ageSec: roundOrNull(ageSec), price, rsi, adx, fvvo, slope, ema8, ema18 };
}

function tickGate(currentPrice) {
  const t = state.latest && state.latest.tick;
  const raw = t && t.raw ? t.raw : {};
  const ageSec = t && t.atMs ? (Date.now() - t.atMs) / 1000 : null;
  const fresh = Boolean(t && ageSec !== null && ageSec <= cfg.featureTickMaxAgeSec);
  const rsi = numVal(raw.rsi, null);
  const adx = numVal(raw.adx, null);
  const fvvo = numVal(raw.fvvo ?? raw.fvvoValue, null);
  const slope = numVal(raw.slope ?? raw.fvvoSlope, null);
  const ema8 = numVal(raw.ema8 ?? raw.ema_8, null);
  const ema18 = numVal(raw.ema18 ?? raw.ema_18, null);
  const price = isFiniteNum(currentPrice) ? currentPrice : (t && t.price);
  let reason = 'OK';
  if (!fresh) reason = 'MISSING_OR_STALE_TICK';
  else if (!isFiniteNum(rsi) || rsi < cfg.ray30MinRsi15s) reason = '15S_RSI_LOW';
  else if (rsi > cfg.ray30MaxRsi15s) reason = '15S_RSI_TOO_HOT_DIRECT_ENTRY';
  else if (!isFiniteNum(fvvo) || fvvo < cfg.ray30MinFvvo15s) reason = '15S_FVVO_LOW';
  else if (isFiniteNum(ema18) && isFiniteNum(price) && price < ema18) reason = '15S_PRICE_BELOW_EMA18';
  return { ok: reason === 'OK', reason, fresh, ageSec: roundOrNull(ageSec), price, rsi, adx, fvvo, slope, ema8, ema18 };
}

function summarizePullback(p) {
  if (!p || !p.armed) return { armed: false };
  return {
    armed: true,
    armedAt: p.armedAt || null,
    armedPrice: p.armedPrice || null,
    highPrice: p.highPrice || null,
    reason: p.reason || null,
    source: p.source || null
  };
}

function positionEntryAgeSec(p) {
  if (!p) return null;
  if (isFiniteNum(p.entryTimeMs)) return (Date.now() - p.entryTimeMs) / 1000;
  const parsed = Date.parse(p.entryTime || '');
  return Number.isFinite(parsed) ? (Date.now() - parsed) / 1000 : null;
}


function latestExternalRayBearStatus() {
  if (activeRayAlgoConflict()) return { ok: false, reason: 'RAYALGO_SAME_BAR_CONFLICT_SUPPRESS_EXIT' };
  const ray = state.latest && state.latest.rayalgoExternal;
  if (!ray || ray.sourceKind !== 'rayalgo_external') return { ok: false, reason: 'NO_EXTERNAL_RAYALGO_STATE' };
  const regime = normalizeRaySignalToRegime(ray.signal, ray.regime);
  if (regime !== 'RAY_BEAR') return { ok: false, reason: 'EXTERNAL_RAYALGO_NOT_BEAR', signal: ray.signal, regime };
  if (!rayalgoTimeframeAllowed(ray.timeframe)) return { ok: false, reason: 'RAYALGO_BEAR_TIMEFRAME_NOT_ALLOWED', timeframe: ray.timeframe };
  const ageSec = isFiniteNum(ray.atMs) ? (Date.now() - ray.atMs) / 1000 : null;
  if (!isFiniteNum(ageSec) || ageSec > cfg.rayalgoBearExitMaxAgeSec) {
    return { ok: false, reason: 'RAYALGO_BEAR_STALE', signal: ray.signal, regime, ageSec: roundOrNull(ageSec), maxAgeSec: cfg.rayalgoBearExitMaxAgeSec };
  }
  return { ok: true, ray, signal: ray.signal, regime, ageSec: roundOrNull(ageSec), timeframe: ray.timeframe, price: ray.price };
}

function rayalgoBearExit5mConfirmation(price) {
  const f = state.latest && state.latest.feature5m;
  if (!f || !f.raw || !f.atMs) return { ok: false, reason: 'MISSING_5M_CONFIRMATION' };
  const ageSec = (Date.now() - f.atMs) / 1000;
  if (!isFiniteNum(ageSec) || ageSec > cfg.rayalgoBearExit5mMaxAgeSec) {
    return { ok: false, reason: 'STALE_5M_CONFIRMATION', ageSec: roundOrNull(ageSec), maxAgeSec: cfg.rayalgoBearExit5mMaxAgeSec };
  }
  const raw = f.raw || {};
  const fPrice = isFiniteNum(price) ? price : f.price;
  const rsi = numVal(raw.rsi, null);
  const fvvo = numVal(raw.fvvo ?? raw.fvvoValue, null);
  const slope = numVal(raw.slope ?? raw.fvvoSlope, null);
  const ema8 = numVal(raw.ema8 ?? raw.ema_8, null);
  const ema18 = numVal(raw.ema18 ?? raw.ema_18, null);
  const rayRegime = normalizeRaySignalToRegime(raw.rayRegime || raw.ray_regime || raw.regime || raw.signal, raw.rayRegime || raw.ray_regime);
  const weakness = [];
  if (isFiniteNum(rsi) && rsi < 50) weakness.push('5M_RSI_BELOW_50');
  if (isFiniteNum(fvvo) && fvvo < 0) weakness.push('5M_FVVO_NEGATIVE');
  if (isFiniteNum(slope) && slope < 0) weakness.push('5M_SLOPE_NEGATIVE');
  if (isFiniteNum(fPrice) && isFiniteNum(ema18) && fPrice < ema18) weakness.push('5M_PRICE_BELOW_EMA18');
  if (isFiniteNum(ema8) && isFiniteNum(ema18) && ema8 < ema18) weakness.push('5M_EMA8_BELOW_EMA18');
  if (rayRegime === 'RAY_BEAR') weakness.push('5M_RAY_BEAR');
  return {
    ok: weakness.length > 0,
    reason: weakness.length > 0 ? '5M_BEAR_CONFIRMATION_OK' : '5M_NO_BEAR_CONFIRMATION',
    weakness,
    ageSec: roundOrNull(ageSec),
    price: fPrice,
    rsi: roundOrNull(rsi),
    fvvo: roundOrNull(fvvo),
    slope: roundOrNull(slope),
    ema8: roundOrNull(ema8),
    ema18: roundOrNull(ema18),
    rayRegime
  };
}

function rayalgoBearExitStatus(p, price, profitPct) {
  if (!cfg.rayalgoBearExitEnabled || !p || !p.inPosition) {
    return { exit: false, reason: 'RAYALGO_BEAR_EXIT_DISABLED_OR_FLAT' };
  }
  const bear = latestExternalRayBearStatus();
  if (!bear.ok) return { exit: false, ...bear };
  // Critical: remembered bearish alerts from BEFORE entry are not new thesis failures.
  if (!isFiniteNum(bear.ray.atMs) || !isFiniteNum(p.entryTimeMs) || bear.ray.atMs <= p.entryTimeMs) {
    return { exit: false, reason: 'RAYALGO_BEAR_PREDATES_ENTRY', signal: bear.signal };
  }
  const confirm = cfg.rayalgoBearExitRequire5mConfirm ? rayalgoBearExit5mConfirmation(price) : { ok: true, reason: '5M_CONFIRMATION_NOT_REQUIRED', weakness: [] };
  if (!confirm.ok) return { exit: false, reason: 'RAYALGO_BEAR_WAIT_5M_CONFIRMATION', ray: bear, confirm };
  return {
    exit: true,
    reason: `RAYALGO_BEAR_EXIT_${String(bear.signal || 'RAY_BEAR').toUpperCase()}`,
    signal: bear.signal,
    regime: bear.regime,
    timeframe: bear.timeframe,
    rayAgeSec: bear.ageSec,
    rayPrice: bear.price,
    profitPct: roundOrNull(profitPct),
    confirm
  };
}

function fvvoBearishExitGuardStatus(p, profitPct) {
  if (!cfg.fvvoBearishExitGuardEnabled || !p || !p.inPosition) {
    return { exit: false, reason: 'FVVO_BEARISH_EXIT_GUARD_DISABLED' };
  }
  if (isFiniteNum(profitPct) && profitPct >= cfg.fvvoBearishExitOnlyIfProfitBelowPct) {
    return { exit: false, reason: 'TRADE_PROFIT_ABOVE_BEARISH_EXIT_GUARD', profitPct: round(profitPct), threshold: cfg.fvvoBearishExitOnlyIfProfitBelowPct };
  }
  const conf = (state.latest && state.latest.fvvoConfidence) || {};
  const entryMs = isFiniteNum(p.entryTimeMs) ? p.entryTimeMs : Date.parse(p.entryTime || '');
  if (!Number.isFinite(entryMs)) return { exit: false, reason: 'ENTRY_TIME_MISSING' };
  const now = Date.now();
  const candidates = [
    { key: 'lastSell', label: 'SNIPER_SELL', maxEntrySec: cfg.fvvoExitOnSniperSellWithinEntrySec },
    { key: 'lastBearishMomentum', label: 'BURST_BEARISH', maxEntrySec: cfg.fvvoExitOnBurstBearishWithinEntrySec }
  ];
  for (const c of candidates) {
    const x = conf[c.key];
    if (!x || !x.atMs) continue;
    const signalAfterEntrySec = (x.atMs - entryMs) / 1000;
    const signalAgeSec = (now - x.atMs) / 1000;
    if (signalAfterEntrySec >= 0 && signalAfterEntrySec <= c.maxEntrySec && signalAgeSec <= Math.max(60, c.maxEntrySec)) {
      return {
        exit: true,
        reason: `FVVO_BEARISH_EXIT_${String(x.signal || c.label).toUpperCase()}`,
        signal: x.signal || c.label,
        side: x.side || c.label,
        signalPrice: x.price,
        timeframe: x.timeframe,
        signalAfterEntrySec: roundOrNull(signalAfterEntrySec),
        signalAgeSec: roundOrNull(signalAgeSec),
        profitPct: roundOrNull(profitPct),
        profitThreshold: cfg.fvvoBearishExitOnlyIfProfitBelowPct
      };
    }
  }
  return { exit: false, reason: 'NO_RECENT_POST_ENTRY_BEARISH_FVVO_SIGNAL' };
}

async function evaluatePositionExit(price, source) {
  if (!state.position || !state.position.inPosition) return null;
  const p = state.position;
  const profitPct = pct(price, p.entryPrice);
  if (p.phase === 'V_RECOVERY_PROBATION' && isFiniteNum(p.vRecoveryLow) && price <= p.vRecoveryLow) {
    log('V_RECOVERY_NEW_LOW_THESIS_EXIT', { price, low:p.vRecoveryLow });
    const out = await exitLong({ price, reason:'V_RECOVERY_WASHOUT_LOW_BROKEN' });
    return { type:'exit', reason:'V_RECOVERY_WASHOUT_LOW_BROKEN', out };
  }
  const probationFail = earlyTurnProbationFailure(p, price, source);
  if (probationFail && probationFail.exit) {
    log(p.phase === 'V_RECOVERY_PROBATION' ? 'V_RECOVERY_PROBATION_THESIS_EXIT' : 'EARLY_TURN_PROBATION_THESIS_EXIT', { price, source, profitPct: round(profitPct), ...probationFail });
    const out = await exitLong({ price, reason: probationFail.reason });
    return { type: 'exit', reason: probationFail.reason, out };
  }

  if (!isFiniteNum(p.peakPrice) || price > p.peakPrice) p.peakPrice = price;
  p.mfePct = Math.max(numVal(p.mfePct, 0), pct(p.peakPrice, p.entryPrice));

  const floorInfo = activeFloorResult(p.mfePct, p.activeFloorLockPct);
  const floorLock = floorInfo.lock;
  if (isFiniteNum(floorLock) && (!isFiniteNum(p.activeFloorLockPct) || floorLock > p.activeFloorLockPct)) {
    p.activeFloorLockPct = floorLock;
    p.activeFloorSource = floorInfo.source;
    p.activeFloorDetails = floorInfo;
    log(floorUpgradeLabel(floorInfo.source), {
      entryPrice: p.entryPrice,
      price,
      mfePct: round(p.mfePct),
      activeFloorLockPct: round(floorLock),
      fixedFloorLockPct: roundOrNull(floorInfo.fixedLock),
      dynamicFloorLockPct: roundOrNull(floorInfo.dynamicLock),
      allowedPullbackPct: roundOrNull(floorInfo.allowedPullbackPct),
      band: floorInfo.band,
      bandProgressPct: roundOrNull(floorInfo.bandProgressPct),
      source: floorInfo.source
    });
  }

  if (cfg.runnerEnabled && !p.runnerActive && p.mfePct >= cfg.runnerActivateMfePct) {
    p.runnerActive = true;
    p.activeFloorLockPct = Math.max(numVal(p.activeFloorLockPct, -999), cfg.runnerMinLockPct);
    log('FVVO_RUNNER_ACTIVATED', { entryPrice: p.entryPrice, price, mfePct: round(p.mfePct), runnerMinLockPct: cfg.runnerMinLockPct });
  }

  const drop = recentDropPct(price);
  if (cfg.emergencyDropEnabled && isFiniteNum(drop) && drop >= cfg.emergencyDropPct) {
    const reason = `RAY30_EMERGENCY_DROP_${round(drop)}PCT_FROM_60S_HIGH`;
    log('FVVO_EMERGENCY_DROP_EXIT', { price, source, dropPct: round(drop), threshold: cfg.emergencyDropPct });
    const out = await exitLong({ price, reason });
    return { type: 'exit', reason, out };
  }

  const rayBearGuard = rayalgoBearExitStatus(p, price, profitPct);
  if (rayBearGuard && rayBearGuard.exit) {
    const reason = rayBearGuard.reason;
    log('RAYALGO_BEAR_THESIS_EXIT', { price, source, profitPct: round(profitPct), ...rayBearGuard });
    const out = await exitLong({ price, reason });
    return { type: 'exit', reason, out, guard: rayBearGuard };
  }

  const bearishGuard = fvvoBearishExitGuardStatus(p, profitPct);
  if (bearishGuard && bearishGuard.exit) {
    const reason = bearishGuard.reason;
    log('FVVO_BEARISH_CONFIDENCE_EXIT', { price, source, profitPct: round(profitPct), ...bearishGuard });
    const out = await exitLong({ price, reason });
    return { type: 'exit', reason, out, guard: bearishGuard };
  }

  const entryAgeSec = positionEntryAgeSec(p);
  const earlyFailThreshold = -Math.abs(cfg.ray30EarlyFailExitPct);
  if (cfg.ray30EarlyFailExitEnabled && isFiniteNum(entryAgeSec) && entryAgeSec <= cfg.ray30EarlyFailMaxAgeSec && profitPct <= earlyFailThreshold) {
    const reason = `RAY30_EARLY_FAIL_EXIT_${Math.abs(cfg.ray30EarlyFailExitPct)}PCT`;
    log('FVVO_EARLY_FAIL_EXIT', { price, source, profitPct: round(profitPct), entryAgeSec: round(entryAgeSec), threshold: earlyFailThreshold, maxAgeSec: cfg.ray30EarlyFailMaxAgeSec });
    const out = await exitLong({ price, reason });
    return { type: 'exit', reason, out };
  }

  if (profitPct <= -Math.abs(cfg.stopLossPct)) {
    const reason = `RAY30_STOP_LOSS_${cfg.stopLossPct}PCT`;
    log('FVVO_STOP_LOSS_EXIT', { price, source, profitPct: round(profitPct), threshold: -Math.abs(cfg.stopLossPct) });
    const out = await exitLong({ price, reason });
    return { type: 'exit', reason, out };
  }

  const floorExitMinMfe = floorExitMinMfePct(p.activeFloorSource);
  if (isFiniteNum(p.activeFloorLockPct) && profitPct <= p.activeFloorLockPct && p.mfePct >= floorExitMinMfe) {
    const roundedLock = round(p.activeFloorLockPct);
    const sourceName = floorReasonSource(p.activeFloorSource);
    const reason = `RAY30_${sourceName}_FLOOR_LOCK_${roundedLock}PCT`;
    log(floorExitLabel(p.activeFloorSource), {
      price,
      source,
      profitPct: round(profitPct),
      mfePct: round(p.mfePct),
      activeFloorLockPct: roundedLock,
      activeFloorSource: p.activeFloorSource || 'fixed',
      activeFloorDetails: p.activeFloorDetails || null
    });
    const out = await exitLong({ price, reason });
    return { type: 'exit', reason, out };
  }

  if (p.runnerActive) {
    const giveback = p.mfePct - profitPct;
    if (giveback >= cfg.runnerGivebackPct && profitPct >= cfg.runnerMinLockPct) {
      const reason = `RAY30_RUNNER_GIVEBACK_${cfg.runnerGivebackPct}PCT`;
      log('FVVO_RUNNER_GIVEBACK_EXIT', { price, source, profitPct: round(profitPct), mfePct: round(p.mfePct), giveback: round(giveback) });
      const out = await exitLong({ price, reason });
      return { type: 'exit', reason, out };
    }
  }

  saveState();
  return null;
}

async function forwardTo3Commas(kind, price, meta = {}) {
  const code = kind === 'enter_long' ? cfg.c3EnterLongCode : cfg.c3ExitLongCode;
  const actionName = kind === 'enter_long' ? 'enter_long' : 'exit_long';
  const requestId = meta.requestId || makeRequestId(kind);
  const reason = meta.reason || meta.source || (kind === 'enter_long' ? 'MANUAL_ENTER_LONG' : 'MANUAL_EXIT_LONG');

  if (!cfg.enableHttpForward) return { ok: false, reason: 'ENABLE_HTTP_FORWARD_FALSE', requestId };
  if (cfg.shadowOnly) return { ok: false, reason: 'SHADOW_ONLY_TRUE', requestId };
  if (cfg.executionMode === 'demo' && !cfg.demoForwardAllowed) return { ok: false, reason: 'DEMO_FORWARD_NOT_ALLOWED', requestId };
  if (cfg.executionMode === 'live' && !cfg.liveForwardAllowed) return { ok: false, reason: 'LIVE_FORWARD_NOT_ALLOWED', requestId };
  if (!cfg.c3SignalUrl) return { ok: false, reason: 'C3_SIGNAL_URL_MISSING', requestId };
  if (!code) return { ok: false, reason: `${actionName.toUpperCase()}_CODE_MISSING`, requestId };

  const payload = buildC3Payload(kind, code, price, meta);

  log('C3_FORWARD_SEND', {
    action: actionName,
    reason,
    symbol: cfg.symbol,
    price,
    requestId,
    executionSchema: 'v2_custom_code',
    commandCode: codePrefix(code),
    amountPerTrade: cfg.c3AmountPerTrade ? toMaybeNumber(cfg.c3AmountPerTrade) : undefined,
    amountPerTradeType: cfg.c3AmountPerTradeType || undefined,
    orderType: cfg.c3OrderType || 'market',
    dryRun: cfg.c3DryRun
  });

  if (cfg.logC3PayloadAudit) {
    log('C3_FORWARD_PAYLOAD_AUDIT', {
      requestId,
      action: actionName,
      reason,
      schema: 'v2_custom_code',
      body: maskC3Payload(payload)
    });
  }

  if (cfg.c3DryRun) {
    return { ok: true, dryRun: true, status: 0, payload: maskC3Payload(payload), reason: 'C3_DRY_RUN_TRUE', requestId, sentAt: nowIso(), codePrefix: codePrefix(code) };
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), cfg.c3TimeoutMs);
  try {
    const resp = await fetch(cfg.c3SignalUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) {}
    const contentType = String(resp.headers.get('content-type') || '');
    const htmlResponse = /text\/html/i.test(contentType) || /^\s*<!DOCTYPE html/i.test(text) || /<html[\s>]/i.test(text.slice(0, 200));
    const acceptedMessage = parsed && (parsed.result === 'success' || /accepted/i.test(String(parsed.message || '')));
    const accepted = resp.ok && !htmlResponse && (parsed ? (acceptedMessage || parsed.ok === true || parsed.success === true) : true);
    const result = {
      ok: accepted,
      status: resp.status,
      statusText: resp.statusText,
      contentType,
      validationReason: accepted ? undefined : (htmlResponse ? 'C3_HTML_RESPONSE_NOT_ACCEPTED' : 'C3_RESPONSE_NOT_ACCEPTED'),
      bodyText: text.slice(0, 1000),
      body: parsed,
      sentAt: nowIso(),
      requestId,
      codePrefix: codePrefix(code)
    };
    if (accepted) {
      log('C3_FORWARD_ACCEPTED_UNVERIFIED', { action: actionName, reason, status: resp.status, requestId, responseText: text.slice(0, 500) });
    } else {
      log('C3_FORWARD_NOT_ACCEPTED', { action: actionName, reason, status: resp.status, requestId, validationReason: result.validationReason, contentType, responseText: text.slice(0, 500), hint: htmlResponse ? 'Check C3_SIGNAL_URL. It returned an HTML/help page, so the 3Commas bot probably did not receive the signal.' : 'Check C3 code, amount fields, and 3Commas bot settings.' });
    }
    return result;
  } catch (err) {
    const result = { ok: false, status: 0, error: err.name || 'FETCH_ERROR', message: err.message, sentAt: nowIso(), requestId, codePrefix: codePrefix(code) };
    log('C3_FORWARD_FAIL', { action: actionName, reason, requestId, error: result.error, message: result.message });
    return result;
  } finally {
    clearTimeout(t);
  }
}

function buildC3Payload(kind, code, price, meta) {
  const payload = {
    code,
    orderType: cfg.c3OrderType || 'market'
  };

  // 3Commas JSON Signal Bot requires amountPerTrade + amountPerTradeType for entry JSON mode.
  // Keep them optional so an already fixed-size bot template can still be used.
  if (kind === 'enter_long') {
    if (cfg.c3AmountPerTrade) payload.amountPerTrade = toMaybeNumber(cfg.c3AmountPerTrade);
    if (cfg.c3AmountPerTradeType) payload.amountPerTradeType = cfg.c3AmountPerTradeType;
  }

  if (kind === 'exit_long') {
    payload.reduceOnly = true;
  }

  if (isFiniteNum(price)) {
    payload.triggerPrice = price;
    payload.price = price;
  }

  payload.clientOrderId = `${cfg.symbol.replace(/[^A-Z0-9]/gi, '')}_${kind}_${Date.now()}`;
  payload.comment = `${BRAIN}:${kind}:${meta && meta.source ? meta.source : 'manual'}`;

  return payload;
}

function validateSetup(setup) {
  if (!setup.symbol || normalizeSymbol(setup.symbol) !== normalizeSymbol(cfg.symbol)) {
    return { ok: false, error: 'SYMBOL_REQUIRED', details: { expected: cfg.symbol, received: setup.symbol } };
  }
  if (!['breakout_retest_reclaim_zone', 'confirmed_pullback_reclaim_zone', 'trailing_dip_reclaim_zone'].includes(setup.triggerMode)) {
    return { ok: false, error: 'INVALID_TRIGGER_MODE', details: { triggerMode: setup.triggerMode } };
  }
  if (setup.triggerMode === 'breakout_retest_reclaim_zone') {
    if (!isFiniteNum(setup.breakoutConfirmPrice) || !isFiniteNum(setup.retestRangeLow) || !isFiniteNum(setup.retestRangeHigh)) {
      return { ok: false, error: 'BREAKOUT_SETUP_MISSING_CONFIRM_OR_RETEST_RANGE', details: setupLog(setup) };
    }
  }
  if (setup.triggerMode !== 'breakout_retest_reclaim_zone') {
    const hasRange = isFiniteNum(setup.activationRangeLow) && isFiniteNum(setup.activationRangeHigh);
    const hasActivation = isFiniteNum(setup.activationPrice);
    if (!hasRange && !hasActivation) {
      return { ok: false, error: 'PULLBACK_SETUP_MISSING_ACTIVATION_RANGE_OR_PRICE', details: setupLog(setup) };
    }
  }
  return { ok: true };
}

function publicStatus() {
  return {
    ok: true,
    brain: BRAIN,
    symbol: cfg.symbol,
    executionMode: cfg.executionMode,
    shadowOnly: cfg.shadowOnly,
    manualPath: cfg.manualPath,
    webhookPath: cfg.webhookPath,
    supportedActions: SUPPORTED_MANUAL_ACTIONS,
    autoEntryControl: publicAutoEntryControl(),
    vRecoveryConfig: vRecoveryConfigSummary(),
    forwardConfig: {
      enableHttpForward: cfg.enableHttpForward,
      demoForwardAllowed: cfg.demoForwardAllowed,
      liveForwardAllowed: cfg.liveForwardAllowed,
      c3DryRun: cfg.c3DryRun,
      c3SignalUrlHost: safeHost(cfg.c3SignalUrl),
      hasEnterCode: Boolean(cfg.c3EnterLongCode),
      hasExitCode: Boolean(cfg.c3ExitLongCode),
      c3AmountPerTradeSet: Boolean(cfg.c3AmountPerTrade),
      c3AmountPerTradeType: cfg.c3AmountPerTradeType || null
    },
    riskConfig: {
      ray30LongGateMode: cfg.ray30LongGateMode,
      stopLossPct: cfg.stopLossPct,
      emergencyDropEnabled: cfg.emergencyDropEnabled,
      emergencyDropPct: cfg.emergencyDropPct,
      permanentFloorsEnabled: cfg.permanentFloorsEnabled,
      floors: floorConfigSummary(),
      runnerEnabled: cfg.runnerEnabled
    },
    entryConfig: {
      ray30AutoEntryEnabled: cfg.ray30AutoEntryEnabled,
      ray30AutoEntrySendOrder: cfg.ray30AutoEntrySendOrder,
      ray30EntryScanLogEnabled: cfg.ray30EntryScanLogEnabled,
      ray30EntryScanOnTick: cfg.ray30EntryScanOnTick,
      rsi5m: { min: cfg.ray30MinRsi5m, max: cfg.ray30MaxRsi5m },
      rsi15s: { min: cfg.ray30MinRsi15s, max: cfg.ray30MaxRsi15s },
      noChaseRsi15s: cfg.ray30NoChaseRsi15s,
      pullbackReclaimMaxRsi15s: cfg.ray30PullbackReclaimMaxRsi15s
    },
    rayalgoConfig: {
      externalAlertsEnabled: cfg.rayalgoExternalAlertsEnabled,
      stateMemoryEnabled: cfg.rayalgoStateMemoryEnabled,
      stateMaxAgeSec: cfg.rayalgoStateMaxAgeSec,
      useExternalPriority: cfg.ray30UseRayalgoExternalPriority,
      featureProxyFallbackEnabled: cfg.ray30FeatureProxyFallbackEnabled,
      featureProxyMonitorOnly: cfg.ray30FeatureProxyMonitorOnly,
      requireExternalSetupForEntry: cfg.rayalgoRequireExternalSetupForEntry,
      setupTimeframe: cfg.rayalgoSetupTimeframe,
      allowedEntryTimeframes: cfg.rayalgoAllowedEntryTimeframes,
      pullback5mMinRsi: cfg.ray30Pullback5mMinRsi,
      pullbackRequire5mAboveEma18: cfg.ray30PullbackRequire5mAboveEma18,
      pullbackRequire5mEma8AboveEma18: cfg.ray30PullbackRequire5mEma8AboveEma18,
      clearSetupOnExit: cfg.ray30ClearSetupOnExit,
      postExitCooldownSec: cfg.ray30PostExitCooldownSec,
      postExitRequireNewRayalgoAlert: cfg.ray30PostExitRequireNewRayalgoAlert,
      postExit: summarizePostExitForStatus(),
      activeRay: summarizeActiveRayForStatus()
    },
    logConfig: {
      logEmojiEnabled: cfg.logEmojiEnabled,
      logFeatureTickEnabled: cfg.logFeatureTickEnabled,
      log15sTickEnabled: cfg.log15sTickEnabled,
      log15sTickEveryN: cfg.log15sTickEveryN,
      logFeature5mEnabled: cfg.logFeature5mEnabled,
    logVRecoveryDropDiagnosticEnabled: cfg.logVRecoveryDropDiagnosticEnabled,
      logC3PayloadAudit: cfg.logC3PayloadAudit,
    ray30ScanLogMode: cfg.ray30ScanLogMode,
    ray30NoEntryLogMode: cfg.ray30NoEntryLogMode,
    logReplayCompactEnabled: cfg.logReplayCompactEnabled
    },
    state: publicState()
  };
}

function publicState() {
  return {
    latest: state.latest,
    autoEntryControl: publicAutoEntryControl(),
    vRecovery: summarizeVRecovery(),
    position: summarizePosition(state.position),
    priceTrigger: state.priceTrigger ? summarizeSetup(state.priceTrigger) : null,
    campaigns: summarizeCampaigns(state.campaigns),
    ray30Pullback: summarizePullback(state.ray30Pullback),
    ray30Setup: summarizeRay30Setup(state.ray30Setup, state.ray30Setup && state.ray30Setup.reason),
    fvvoConfidence: summarizeFvvoConfidence(state.latest && state.latest.fvvoConfidence),
    rayalgoSignalGuard: { pending: state.rayalgoSignalGuard && state.rayalgoSignalGuard.pending ? { signal: state.rayalgoSignalGuard.pending.signal, regime: state.rayalgoSignalGuard.pending.regime, atMs: state.rayalgoSignalGuard.pending.atMs } : null, conflict: activeRayAlgoConflict() },
    handoff: state.handoff || { active: false }
  };
}

function summarizeCampaigns(campaigns) {
  const out = {};
  for (const [id, c] of Object.entries(campaigns || {})) {
    out[id] = {
      campaignId: c.campaignId,
      status: c.status,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      triggeredRole: c.triggeredRole,
      roles: Object.fromEntries(Object.entries(c.roles || {}).map(([role, setup]) => [role, summarizeSetup(setup)]))
    };
  }
  return out;
}

function summarizeSetup(setup) {
  if (!setup) return null;
  return {
    id: setup.id,
    campaignId: setup.campaignId,
    entryRole: setup.entryRole,
    triggerMode: setup.triggerMode,
    status: setup.status,
    expiresAt: setup.expiresAt,
    breakoutConfirmPrice: setup.breakoutConfirmPrice,
    activationPrice: setup.activationPrice,
    retestRangeLow: setup.retestRangeLow,
    retestRangeHigh: setup.retestRangeHigh,
    activationRangeLow: setup.activationRangeLow,
    activationRangeHigh: setup.activationRangeHigh,
    stopPrice: setup.stopPrice,
    tp1: setup.tp1,
    tp2: setup.tp2,
    tp3: setup.tp3,
    touchedZone: setup.touchedZone,
    touchedAt: setup.touchedAt
  };
}

function summarizePosition(p) {
  if (!p) return emptyPosition();
  return {
    inPosition: Boolean(p.inPosition),
    positionLifecycle: p.positionLifecycle || null,
    phase: p.phase || null,
    entryPrice: p.entryPrice || null,
    entryTime: p.entryTime || null,
    source: p.source || null,
    campaignId: p.campaignId || null,
    entryRole: p.entryRole || null,
    peakPrice: p.peakPrice || null,
    mfePct: isFiniteNum(p.mfePct) ? round(p.mfePct) : 0,
    activeFloorLockPct: isFiniteNum(p.activeFloorLockPct) ? p.activeFloorLockPct : null,
    longholdConfirmedAt: p.longholdConfirmedAt || null,
    earlyTurnEntry: p.source === 'early_turn_probation_auto',
    runnerActive: Boolean(p.runnerActive),
    lastExitReason: p.lastExitReason || null,
    lastC3Entry: p.lastC3Entry ? summarizeForward(p.lastC3Entry) : null,
    lastC3Exit: p.lastC3Exit ? summarizeForward(p.lastC3Exit) : null
  };
}

function summarizeForward(f) {
  if (!f) return null;
  return {
    ok: Boolean(f.ok),
    dryRun: Boolean(f.dryRun),
    status: f.status,
    statusText: f.statusText,
    reason: f.reason,
    error: f.error,
    message: f.message,
    codePrefix: f.codePrefix,
    sentAt: f.sentAt,
    body: f.body || undefined,
    bodyText: f.bodyText ? String(f.bodyText).slice(0, 300) : undefined
  };
}

function setupLog(setup, extra = {}) {
  return { ...summarizeSetup(setup), ...extra };
}

function emptyPosition() {
  return {
    inPosition: false,
    entryPrice: null,
    entryTime: null,
    entryTimeMs: null,
    source: null,
    campaignId: null,
    entryRole: null,
    peakPrice: null,
    mfePct: 0,
    activeFloorLockPct: null,
    runnerActive: false,
    lastExitReason: null,
    lastC3Entry: null,
    lastC3Exit: null
  };
}

function ensureStateShape() {
  state.latest = state.latest || { tick: null, feature5m: null, ray30: null, ray30Feature: null, rayalgoExternal: null, recentPrices: [] };
  if (typeof state.latest.ray30Feature === 'undefined') state.latest.ray30Feature = null;
  if (typeof state.latest.rayalgoExternal === 'undefined') state.latest.rayalgoExternal = null;
  state.latest.recentPrices = state.latest.recentPrices || [];
  state.latest.feature5mHistory = state.latest.feature5mHistory || [];
  state.vRecovery = state.vRecovery || { priceHistory:[], atr5m:null, candidate:null, rayBull3m:null, observations:[], lastVeto:null, lastEntryAtMs:null };
  state.vRecovery.priceHistory = Array.isArray(state.vRecovery.priceHistory) ? state.vRecovery.priceHistory.slice(-550) : [];
  state.vRecovery.observations = Array.isArray(state.vRecovery.observations) ? state.vRecovery.observations.slice(-cfg.vConfirmWindow) : [];
  state.earlyTurn = state.earlyTurn || { confirmedCandidate: null, confirmCount: 0, firstTickAtMs: null, lastTickAtMs: null, used: false };
  state.rayalgoSignalGuard = state.rayalgoSignalGuard || { pending: null, lastAccepted: null, conflict: null };
  state.position = state.position || emptyPosition();
  state.priceTrigger = state.priceTrigger || null;
  state.campaigns = state.campaigns || {};
  state.ray30Pullback = state.ray30Pullback || { armed: false };
  state.handoff = state.handoff || { active: false, at: null, reason: null };
  if (!state.autoEntryControl || typeof state.autoEntryControl.paused !== 'boolean') {
    state.autoEntryControl = { paused: false, reason: null, updatedAt: null };
  }
}

function automaticEntryPaused() {
  return Boolean(state.autoEntryControl && state.autoEntryControl.paused);
}

function publicAutoEntryControl() {
  return {
    paused: automaticEntryPaused(),
    reason: state.autoEntryControl ? state.autoEntryControl.reason : null,
    updatedAt: state.autoEntryControl ? state.autoEntryControl.updatedAt : null,
    holdOnStartup: cfg.autoEntryHoldOnStartup,
    pauseAfterManualExit: cfg.autoEntryPauseAfterManualExit
  };
}

function pauseAutomaticEntries(reason, options = {}) {
  const prior = state.autoEntryControl || { paused: false, reason: null, updatedAt: null };
  state.autoEntryControl = {
    paused: true,
    reason: options.preserveExistingReason && prior.paused ? prior.reason : reason,
    updatedAt: options.preserveExistingReason && prior.paused ? prior.updatedAt : nowIso()
  };
  // Cancel old pending manual trigger/campaign entry setups; never cancel a tracked position
  // or its autonomous exit management.
  state.priceTrigger = null;
  state.campaigns = {};
  state.ray30Pullback = { armed: false };
  state.ray30Setup = { active: false, clearReason: 'AUTO_ENTRY_PAUSED', clearedAt: nowIso() };
  if (state.vRecovery) { state.vRecovery.rayBull3m = null; state.vRecovery.observations = []; }
  if (state.earlyTurn) {
    state.earlyTurn.confirmedCandidate = null;
    state.earlyTurn.confirmCount = 0;
    state.earlyTurn.firstTickAtMs = null;
    state.earlyTurn.lastTickAtMs = null;
  }
  saveState();
  log('FVVO_AUTO_ENTRY_PAUSED', { control: publicAutoEntryControl(), activePosition: Boolean(state.position && state.position.inPosition) });
}


function loadState() {
  try {
    if (fs.existsSync(cfg.stateFile)) {
      return JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'));
    }
  } catch (err) {
    log('FVVO_STATE_LOAD_FAILED', { stateFile: cfg.stateFile, error: err.message });
  }
  return { latest: { tick: null, feature5m: null, feature5mHistory: [], ray30: null, ray30Feature: null, rayalgoExternal: null, fvvoConfidence: {}, recentPrices: [] }, position: emptyPosition(), priceTrigger: null, campaigns: {}, ray30Pullback: { armed: false }, ray30Setup: { active: false }, handoff: { active: false, at: null, reason: null } };
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true });
    fs.writeFileSync(cfg.stateFile, JSON.stringify(state, null, 2));
  } catch (err) {
    log('FVVO_STATE_SAVE_FAILED', { stateFile: cfg.stateFile, error: err.message });
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 2_000_000) {
        req.destroy();
        reject(new Error('REQUEST_TOO_LARGE'));
      }
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (err) { reject(new Error(`BAD_JSON: ${err.message}`)); }
    });
    req.on('error', reject);
  });
}

function validSecret(body, req, expected) {
  // Never expose a functioning manual/trading webhook without a configured secret.
  if (!expected) return false;
  const got = body.secret || body.webhook_secret || req.headers['x-webhook-secret'] || req.headers['x-manual-secret'];
  return String(got || '') === String(expected);
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body, null, 2));
}

function stripHttpStatus(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const { httpStatus, ...rest } = obj;
  return rest;
}


function normalizeFvvoConfidenceSignal(v) {
  const raw = String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!raw) return 'UNKNOWN';
  if (raw.includes('SNIPER') && raw.includes('BUY')) return 'SNIPER_BUY';
  if (raw.includes('SNIPER') && raw.includes('SELL')) return 'SNIPER_SELL';
  if (raw.includes('BURST') && raw.includes('BULL')) return 'BURST_BULLISH';
  if (raw.includes('BURST') && raw.includes('BEAR')) return 'BURST_BEARISH';
  if (raw.includes('BULLISH') && raw.includes('DIVERGENCE')) return 'BULLISH_DIVERGENCE';
  if (raw.includes('BEARISH') && raw.includes('DIVERGENCE')) return 'BEARISH_DIVERGENCE';
  if (raw === 'BUY') return 'SNIPER_BUY';
  if (raw === 'SELL') return 'SNIPER_SELL';
  return raw;
}

function fvvoConfidenceSide(signal) {
  const s = String(signal || '').toUpperCase();
  if (s.includes('SNIPER_BUY')) return 'BUY';
  if (s.includes('SNIPER_SELL')) return 'SELL';
  if (s.includes('BURST_BULLISH')) return 'BULLISH_MOMENTUM';
  if (s.includes('BURST_BEARISH')) return 'BEARISH_MOMENTUM';
  if (s.includes('BULLISH_DIVERGENCE')) return 'BULLISH_DIVERGENCE';
  if (s.includes('BEARISH_DIVERGENCE')) return 'BEARISH_DIVERGENCE';
  if (s.includes('BUY')) return 'BUY';
  if (s.includes('SELL')) return 'SELL';
  return 'OTHER';
}

function summarizeFvvoConfidence(conf) {
  conf = conf || {};
  function brief(x) {
    if (!x) return null;
    const ageSec = x.atMs ? (Date.now() - x.atMs) / 1000 : null;
    return {
      signal: x.signal,
      side: x.side,
      price: x.price,
      timeframe: x.timeframe,
      at: x.at,
      ageSec: roundOrNull(ageSec),
      fresh: isFiniteNum(ageSec) ? ageSec <= cfg.fvvoConfidenceMaxAgeSec : false,
      usage: x.usage || 'MONITOR_ONLY_NOT_USED_FOR_ENTRY'
    };
  }
  return {
    usage: 'MONITOR_ONLY_NOT_USED_FOR_ENTRY',
    maxAgeSec: cfg.fvvoConfidenceMaxAgeSec,
    last: brief(conf.last),
    lastBuy: brief(conf.lastBuy),
    lastSell: brief(conf.lastSell),
    lastBullishMomentum: brief(conf.lastBullishMomentum),
    lastBearishMomentum: brief(conf.lastBearishMomentum),
    lastOther: brief(conf.lastOther)
  };
}


function parseTimeframeSet(v) {
  return String(v || '')
    .split(',')
    .map(x => String(x || '').trim().toUpperCase())
    .filter(Boolean)
    .map(x => x.replace(/MINUTES?$/, '').replace(/M$/, ''));
}

function normalizeTf(v) {
  return String(v || '').trim().toUpperCase().replace(/MINUTES?$/, '').replace(/M$/, '');
}

function rayalgoTimeframeAllowed(tf) {
  const allowed = parseTimeframeSet(cfg.rayalgoAllowedEntryTimeframes || cfg.rayalgoSetupTimeframe || '15');
  if (!allowed.length || allowed.includes('ANY') || allowed.includes('*')) return true;
  return allowed.includes(normalizeTf(tf));
}

function setupAllowsEntry(setup) {
  if (!cfg.rayalgoRequireExternalSetupForEntry) return true;
  return Boolean(
    setup &&
    setup.active &&
    setup.sourceKind === 'rayalgo_external' &&
    rayalgoTimeframeAllowed(setup.timeframe)
  );
}

function fvvoLongBlockStatus() {
  const now = Date.now();
  const conf = (state.latest && state.latest.fvvoConfidence) || {};
  const blockers = [];
  function addBlocker(key, label, maxAgeSec) {
    const x = conf[key];
    if (!x || !x.atMs) return;
    const ageSec = (now - x.atMs) / 1000;
    if (ageSec <= maxAgeSec) {
      blockers.push({ signal: x.signal || label, side: x.side || label, ageSec: roundOrNull(ageSec), price: x.price, timeframe: x.timeframe, maxAgeSec });
    }
  }
  if (cfg.fvvoBearishBlockLongEnabled) {
    addBlocker('lastSell', 'SNIPER_SELL', cfg.fvvoSniperSellBlockSec);
    addBlocker('lastBearishMomentum', 'BURST_BEARISH', cfg.fvvoBurstBearishBlockSec);
  }
  return {
    blocked: blockers.length > 0,
    blockers,
    reason: blockers.length ? `ENTRY_BLOCKED_RECENT_${String(blockers[0].signal || 'BEARISH_CONFIDENCE').toUpperCase()}` : 'NO_FVVO_BEARISH_BLOCK'
  };
}

function normalizeRaySource(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  if (s.includes('rayalgo') || s === 'ray') return 'rayalgo';
  if (s.includes('ray30') || s.includes('feature')) return 'ray30_feature';
  return s.replace(/[^a-z0-9_:-]/g, '_');
}

function isRayAlgoExternal(body, event, signal, src) {
  if (!cfg.rayalgoExternalAlertsEnabled) return false;
  const normalizedSrc = normalizeRaySource(src || body.src || body.source || '');
  if (normalizedSrc === 'rayalgo') return true;
  if (body.rayExternalMode === true || body.ray_external_mode === true) return true;
  const e = String(event || '').toUpperCase();
  const sig = String(signal || '').toUpperCase();
  // TradingView RayAlgo condition alerts usually send BULLISH/BEARISH event names and do not send src=ray30_feature.
  if (looksLikeRayAlgoEvent(e) && !/RAY30_SIGNAL|RAY30_FEATURE|FEATURE/.test(e)) return true;
  if (/BULLISH_TREND|BEARISH_TREND|TREND_CHANGE|TREND_CONTINUATION/.test(sig) && normalizedSrc !== 'ray30_feature') return true;
  return false;
}

function compactRay30Scan(scan) {
  return {
    source: scan.source,
    price: scan.price,
    decision: scan.decision,
    reason: scan.reason,
    inPosition: scan.inPosition,
    ray: scan.rayGate ? {
      ok: scan.rayGate.ok,
      signal: scan.rayGate.signal,
      regime: scan.rayGate.regime,
      sourceKind: scan.rayGate.sourceKind,
      fresh: scan.rayGate.fresh,
      ageSec: scan.rayGate.ageSec,
      reason: scan.rayGate.reason
    } : null,
    five: scan.fiveOk ? {
      ok: scan.fiveOk.ok,
      trendOk: scan.fiveOk.trendOk,
      reason: scan.fiveOk.reason,
      ageSec: scan.fiveOk.ageSec,
      price: scan.fiveOk.price,
      rsi: roundOrNull(scan.fiveOk.rsi),
      adx: roundOrNull(scan.fiveOk.adx),
      fvvo: roundOrNull(scan.fiveOk.fvvo),
      slope: roundOrNull(scan.fiveOk.slope)
    } : null,
    tick: scan.tickOk ? {
      ok: scan.tickOk.ok,
      reason: scan.tickOk.reason,
      ageSec: scan.tickOk.ageSec,
      price: scan.tickOk.price,
      rsi: roundOrNull(scan.tickOk.rsi),
      adx: roundOrNull(scan.tickOk.adx),
      fvvo: roundOrNull(scan.tickOk.fvvo),
      slope: roundOrNull(scan.tickOk.slope)
    } : null,
    pullback: scan.pullback,
    setup: scan.setup ? {
      active: scan.setup.active,
      sourceKind: scan.setup.sourceKind,
      timeframe: scan.setup.timeframe,
      reason: scan.setup.reason,
      rayPrice: scan.setup.rayPrice,
      highPrice: scan.setup.highPrice,
      lowPrice: scan.setup.lowPrice,
      pullbackSeen: scan.setup.pullbackSeen,
      dipFromHighPct: roundOrNull(scan.setup.dipFromHighPct),
      moveFromRayPct: roundOrNull(scan.setup.moveFromRayPct),
      pullbackRecoveryReady: scan.setup.pullbackRecoveryReady,
      breakoutContinuationReady: scan.setup.breakoutContinuationReady
    } : null,
    confidenceBlock: scan.confidenceBlock || null,
    externalSetupOk: scan.externalSetupOk,
    postExit: scan.postExit && scan.postExit.active ? scan.postExit : undefined
  };
}

function ray30ScanLogKey(scan) {
  return [
    scan.decision,
    scan.reason,
    scan.inPosition ? 'IN' : 'FLAT',
    scan.rayGate && scan.rayGate.signal,
    scan.rayGate && scan.rayGate.regime,
    scan.rayGate && scan.rayGate.sourceKind,
    scan.fiveOk && scan.fiveOk.reason,
    scan.tickOk && scan.tickOk.reason,
    scan.pullback && scan.pullback.armed ? 'PB_ARMED' : 'PB_OFF',
    scan.setup && scan.setup.reason,
    scan.setup && scan.setup.pullbackSeen ? 'SETUP_PB' : 'SETUP_NOPB'
  ].join('|');
}

function shouldLogRay30Scan(scan, source) {
  if (!cfg.ray30EntryScanLogEnabled) return false;
  const mode = String(cfg.ray30ScanLogMode || 'REASON_CHANGE').toUpperCase();
  if (mode === 'OFF' || mode === 'NONE') return false;
  if (mode === 'FULL') {
    const isTickSource = /tick/i.test(String(source || ''));
    return cfg.ray30EntryScanOnTick || !isTickSource || scan.decision !== 'NO_ENTRY';
  }
  if (scan.decision !== 'NO_ENTRY') return true;
  const isTickSource = /tick/i.test(String(source || ''));
  if (!isTickSource) return true;
  const key = ray30ScanLogKey(scan);
  if (mode === 'REASON_CHANGE' || mode === 'COMPACT') {
    if (key === logCounters.lastRay30ScanKey) return false;
    logCounters.lastRay30ScanKey = key;
    return true;
  }
  return false;
}

function logRay30EntryScan(scan) {
  const mode = String(cfg.ray30ScanLogMode || 'REASON_CHANGE').toUpperCase();
  if (mode === 'FULL') log('RAY30_ENTRY_SCAN', scan);
  else log('RAY30_ENTRY_SCAN_COMPACT', compactRay30Scan(scan));
}

function shouldLogRay30NoEntry(scan, source) {
  const mode = String(cfg.ray30NoEntryLogMode || 'OFF').toUpperCase();
  if (mode === 'OFF' || mode === 'NONE') return false;
  if (mode === 'FULL') return true;
  const key = ray30ScanLogKey(scan);
  if (key === logCounters.lastRay30NoEntryKey) return false;
  logCounters.lastRay30NoEntryKey = key;
  return true;
}

function summarizeActiveRayForStatus() {
  const selected = activeRayForGate();
  const r = selected.state;
  return r ? {
    signal: r.signal,
    regime: r.regime,
    sourceKind: r.sourceKind,
    src: r.src,
    fresh: selected.fresh,
    ageSec: roundOrNull(selected.ageSec),
    reason: selected.reason,
    at: r.at || null
  } : { signal: 'MISSING', regime: 'RAY_NEUTRAL', sourceKind: 'missing', fresh: false, ageSec: null, reason: selected.reason };
}

function log(label, data = {}) {
  if (shouldSuppressLog(label, data)) return;
  const icon = cfg.logEmojiEnabled ? `${logIcon(label)} ` : '';
  const payload = { brain: BRAIN, ...data };
  console.log(`${nowIso()} ${icon}${label} | ${JSON.stringify(payload)}`);
}

function shouldSuppressLog(label, data = {}) {
  if (label === 'FVVO_FEATURE_TICK_RECEIVED') {
    if (!cfg.logFeatureTickEnabled) return true;
    const tf = String(data.chartTimeframe || data.timeframe || '').toUpperCase();
    const looks15s = tf === '15S' || tf === '15' || tf === '15SEC' || tf === '15SECOND' || data.sourceKind === 'tick';
    if (looks15s) {
      if (!cfg.log15sTickEnabled) return true;
      logCounters.featureTick15s += 1;
      if ((logCounters.featureTick15s - 1) % cfg.log15sTickEveryN !== 0) return true;
    }
  }
  if (label === 'FVVO_FEATURE_5M_RECEIVED' && !cfg.logFeature5mEnabled) return true;
  return false;
}

function logIcon(label) {
  if (label === 'FVVO_FEATURE_TICK_RECEIVED') return '⚡';
  if (label === 'FVVO_FEATURE_5M_RECEIVED') return '📊';
  if (label === 'FVVO_MANUAL_COMMAND') return '📩';
  if (/RAY30_ENTRY_SCAN/.test(label)) return '🧠';
  if (/RAYALGO_EXTERNAL/.test(label)) return '🟣';
  if (/CONFIDENCE/.test(label)) return '🟡';
  if (/NO_OPEN|EXPIRED|MISSING|NO_ENTRY|WARN|LOAD_FAILED|SAVE_FAILED/.test(label)) return '🟡';
  if (/RAY30_NO_CHASE|RAY30_PULLBACK_ARMED/.test(label)) return '🟠';
  if (/NOT_ACCEPTED|FAIL|ERROR|BLOCKED|CANCEL|STOP_LOSS|DROP|BEAR_EXIT|FLOOR_EXIT/.test(label)) return '🔴';
  if (/PROGRESSIVE_FLOOR|PROTECTIVE_FLOOR/.test(label)) return '🟢';
  if (/C3_FORWARD_SEND|C3_FORWARD_PAYLOAD_AUDIT|C3_FORWARD_ACCEPTED|MANUAL_EXIT_LONG_ACCEPTED/.test(label)) return '🟢';
  if (/ACCEPTED|TRACKED|OPEN|ENTRY_READY|ARMED|ADOPTED/.test(label)) return '🟢';
  if (/RAY30|FVVO_RAY30|RAY|CAMPAIGN/.test(label)) return '🟣';
  return '🔵';
}

function featureLogPayload(body, event, price, sourceKind, extra = {}) {
  return {
    event,
    price,
    ema8: numVal(body.ema8 ?? body.ema_8, null),
    ema18: numVal(body.ema18 ?? body.ema_18, null),
    rsi: numVal(body.rsi, null),
    adx: numVal(body.adx, null),
    fvvo: numVal(body.fvvo ?? body.fvvoValue, null),
    slope: numVal(body.slope ?? body.fvvoSlope, null),
    crossUp: boolish(body.crossUp ?? body.cross_up),
    crossDown: boolish(body.crossDown ?? body.cross_down),
    redPulse: boolish(body.redPulse ?? body.red_pulse),
    yellowPulse: boolish(body.yellowPulse ?? body.yellow_pulse),
    yellowReason: body.yellowReason ?? body.yellow_reason ?? null,
    rayRegime: normalizeRayRegime(body.rayRegime ?? body.ray_regime),
    publisherKind: body.publisherKind ?? body.publisher_kind ?? body.kind ?? null,
    chartTimeframe: body.chartTimeframe ?? body.chart_timeframe ?? body.timeframe ?? (sourceKind === 'feature5m' ? '5' : '15S'),
    barTimeMs: numVal(body.barTimeMs ?? body.bar_time_ms ?? body.time ?? body.timestamp_ms ?? body.timenow, null),
    positionLifecycle: state.position && state.position.inPosition ? (state.position.positionLifecycle || 'ENTRY_ACCEPTED_UNVERIFIED_FILL') : null,
    phase: state.position && state.position.inPosition ? (state.position.phase || 'ONE_STOP_ACTIVE') : null,
    reentryPhase: state.reentryPhase || null,
    priceTriggerState: priceTriggerStateLabel(),
    handoffActive: Boolean(state.handoff && state.handoff.active),
    runnerHoldActive: Boolean(state.position && state.position.runnerActive),
    runnerTightTrailArmed: Boolean(state.position && state.position.runnerActive),
    brainExitManagementActive: Boolean(state.position && state.position.inPosition),
    reconciliationRequired: false,
    sourceKind,
    ...extra
  };
}

function priceTriggerStateLabel() {
  const activeCampaignSetups = Object.values(state.campaigns || {})
    .flatMap(c => Object.values(c.roles || {}))
    .filter(s => s && s.status === 'ARMED').length;
  const count = (state.priceTrigger && state.priceTrigger.status === 'ARMED' ? 1 : 0) + activeCampaignSetups;
  return count > 0 ? `${count}_ARMED` : null;
}

function cancelOpenSetupsForImmediateManualEntry() {
  if (state.priceTrigger && state.priceTrigger.status === 'ARMED') {
    log('FVVO_PRICE_TRIGGER_CANCELLED_BY_IMMEDIATE_MANUAL_ENTRY', setupLog(state.priceTrigger));
    state.priceTrigger.status = 'CANCELLED_BY_IMMEDIATE_MANUAL_ENTRY';
    state.priceTrigger.cancelledAt = nowIso();
  }
  for (const campaign of Object.values(state.campaigns || {})) {
    for (const setup of Object.values(campaign.roles || {})) {
      if (setup && setup.status === 'ARMED') {
        log('FVVO_PRICE_TRIGGER_CANCELLED_BY_IMMEDIATE_MANUAL_ENTRY', setupLog(setup));
        setup.status = 'CANCELLED_BY_IMMEDIATE_MANUAL_ENTRY';
        setup.cancelledAt = nowIso();
      }
    }
    if (campaign.status === 'ARMED') {
      campaign.status = 'CANCELLED_BY_IMMEDIATE_MANUAL_ENTRY';
      campaign.cancelledAt = nowIso();
    }
  }
}

function maskC3Payload(payload) {
  const out = { ...payload };
  if (out.code) out.code = codePrefix(out.code);
  return out;
}

function makeRequestId(prefix) {
  const rand = typeof randomUUID === 'function' ? randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${rand}`;
}

function boolish(v) {
  if (typeof v === 'boolean') return v;
  if (v === null || typeof v === 'undefined' || v === '') return false;
  return boolVal(v, false);
}

function normalizeRayRegime(v) {
  if (v === 1 || v === '1') return 'RAY_BULL';
  if (v === -1 || v === '-1') return 'RAY_BEAR';
  if (v === -2 || v === '-2') return 'RAY_BEAR_EXHAUSTION';
  if (v === 0 || v === '0') return 'RAY_NEUTRAL';
  return v || 'RAY_NEUTRAL';
}

function looksLikeRayAlgoEvent(event) {
  const s = String(event || '').toUpperCase();
  return /BULLISH|BEARISH|TREND_CHANGE|TREND_CONTINUATION|EXHAUSTION|REVERSAL/.test(s);
}

function normalizeRaySignal(v) {
  const s = String(v || '').trim();
  if (!s) return 'RAY_NEUTRAL';
  const u = s.toUpperCase().replace(/\s+/g, '_');
  if (u === 'RAY_BULL' || u === 'BULL') return 'RAY_BULL';
  if (u === 'RAY_BEAR' || u === 'BEAR') return 'RAY_BEAR';
  if (u === 'RAY_BEAR_EXHAUSTION' || u.includes('EXHAUSTION') || u.includes('REVERSAL')) return u.includes('BULL') ? 'BULLISH_REVERSAL' : 'RAY_BEAR_EXHAUSTION';
  return u;
}

function normalizeRaySignalToRegime(signal, explicitRegime) {
  const er = normalizeRayRegime(explicitRegime);
  if (explicitRegime && er !== 'RAY_NEUTRAL') return er;
  const s = String(signal || '').toUpperCase();
  if (s.includes('BEAR_EXHAUSTION') || s.includes('EXHAUSTION') || s.includes('BULLISH_REVERSAL')) return 'RAY_BEAR_EXHAUSTION';
  if (s.includes('BEARISH') || s === 'RAY_BEAR' || s === 'BEAR') return 'RAY_BEAR';
  if (s.includes('BULLISH') || s === 'RAY_BULL' || s === 'BULL') return 'RAY_BULL';
  if (s.includes('NEUTRAL')) return 'RAY_NEUTRAL';
  return er || 'RAY_NEUTRAL';
}

function roundOrNull(v) { return isFiniteNum(v) ? round(v) : null; }

function latestPrice() {
  return (state.latest.tick && state.latest.tick.price) || (state.latest.feature5m && state.latest.feature5m.price) || null;
}

function vRecoveryConfigSummary() {
  return { enabled:cfg.vRecoveryEnabled && cfg.executionMode==='demo', sendOrder:cfg.vRecoverySendOrder,
    dropWindows:[{minutes:30,pct:cfg.vDrop30Pct},{minutes:60,pct:cfg.vDrop60Pct},{minutes:90,pct:cfg.vDrop90Pct}],
    atrMult:cfg.vDropAtrMult, requireRealAtr:cfg.vAtrRequire, rayTimeframe:cfg.vRayalgoTf,
    minBouncePct:cfg.vRecoveryMinBouncePct,maxBouncePct:cfg.vRecoveryMaxBouncePct,
    confirmWindow:cfg.vConfirmWindow,confirmRequired:cfg.vConfirmRequired, confirmationMinSec:cfg.vConfirmMinSec,
    maxCandidateAgeSec:cfg.vRecoveryMaxAgeSec };
}
function summarizeVRecovery() {
  const v=state.vRecovery || {};
  return { candidate:v.candidate || null, atr5m:v.atr5m || null, rayBull3m:v.rayBull3m || null,
    observations:v.observations ? v.observations.length : 0, priceHistoryLength:v.priceHistory ? v.priceHistory.length : 0,
    lastVeto:v.lastVeto || null, lastEntryAtMs:v.lastEntryAtMs || null };
}
function extractRealAtrPct(raw, close) {
  const direct = numVal(raw.atrPct ?? raw.atr_pct ?? raw.atrPercent ?? raw.atr_percent, null);
  if (isFiniteNum(direct) && direct > 0 && direct < 30) return direct;
  const atr = numVal(raw.atr ?? raw.atr5m, null);
  if (isFiniteNum(atr) && atr > 0 && isFiniteNum(close) && close > 0) return 100*atr/close;
  return null;
}
function freshVATR() {
  const a=state.vRecovery && state.vRecovery.atr5m;
  if (!a || !isFiniteNum(a.pct) || a.pct <= 0 || !isFiniteNum(a.atMs) || Date.now()-a.atMs>cfg.vAtrMaxAgeSec*1000) return null;
  return a.pct;
}
// Read-only progress snapshot: does not update any entry, exit, or V-Recovery state.
// Uses the same ordered peak -> subsequent trough calculation as vDropEvidence().
function vRecoveryDropWindowDiagnostic() {
  const now = Date.now();
  const v = state.vRecovery || {};
  const points = Array.isArray(v.priceHistory) ? v.priceHistory : [];
  const atr = freshVATR();
  const cached = v.atr5m || null;
  const atrUsable = isFiniteNum(atr) && atr > 0;
  const atrRequiredMissing = cfg.vAtrRequire && !atrUsable;
  const windows = [
    { minutes:30, fixedPct:cfg.vDrop30Pct },
    { minutes:60, fixedPct:cfg.vDrop60Pct },
    { minutes:90, fixedPct:cfg.vDrop90Pct }
  ].map(({ minutes, fixedPct }) => {
    const samples = points.filter(p => isFiniteNum(p.atMs) && isFiniteNum(p.price) && p.price > 0 && p.atMs >= now - minutes * 60000);
    const requiredPct = atrRequiredMissing ? null : Math.max(fixedPct, cfg.vDropAtrMult * (atr || 0));
    if (samples.length < 2) return {
      windowMin:minutes, fixedPct:round(fixedPct), sampleCount:samples.length,
      dropPct:null, requiredPct:roundOrNull(requiredPct), qualifies:false,
      status:atrRequiredMissing ? 'MISSING_FRESH_5M_ATR' : 'INSUFFICIENT_PRICE_HISTORY'
    };
    let peak = samples[0].price;
    let peakAtMs = samples[0].atMs;
    let best = null;
    for (let i = 1; i < samples.length; i += 1) {
      const p = samples[i];
      if (p.price > peak) { peak = p.price; peakAtMs = p.atMs; }
      const pctDrop = 100 * (peak - p.price) / peak;
      if (!best || pctDrop > best.dropPct) best = { high:peak, low:p.price, highAtMs:peakAtMs, lowAtMs:p.atMs, dropPct:pctDrop };
    }
    const qualifies = requiredPct !== null && best.dropPct >= requiredPct;
    return {
      windowMin:minutes, fixedPct:round(fixedPct), sampleCount:samples.length,
      historySpanMin:round((now - samples[0].atMs)/60000),
      high:round(best.high), low:round(best.low),
      dropPct:round(best.dropPct), requiredPct:roundOrNull(requiredPct),
      qualifies, status:atrRequiredMissing ? 'MISSING_FRESH_5M_ATR' : (qualifies ? 'DROP_QUALIFIED' : 'DROP_BELOW_THRESHOLD')
    };
  });
  return {
    atrPct:atrUsable ? atr : null,
    atrSource:atrUsable && cached ? cached.source : null,
    atrAgeSec:cached && isFiniteNum(cached.atMs) ? round((now-cached.atMs)/1000) : null,
    atrFresh:atrUsable, atrRequired:cfg.vAtrRequire,
    candidateActive:Boolean(v.candidate && !v.candidate.used),
    priceHistoryLength:points.length, windows
  };
}
// Correct ordered peak-to-subsequent-low drawdown, not a high relative to a later low.
function vDropEvidence(points, minutes, fixedDrop, atrPct) {
  const arr=points.filter(x=>x.atMs>=Date.now()-minutes*60000);
  if (arr.length<2) return null;
  let high=arr[0].price, highAtMs=arr[0].atMs, best=null;
  for(let i=1;i<arr.length;i++) {
    const p=arr[i];
    if (p.price>high) { high=p.price; highAtMs=p.atMs; }
    const drop=100*(high-p.price)/high;
    if (!best || drop>best.dropPct) best={ high, highAtMs, low:p.price, lowAtMs:p.atMs, dropPct:drop, minutes };
  }
  const required=Math.max(fixedDrop, cfg.vDropAtrMult*atrPct);
  return best && best.dropPct>=required ? {...best, requiredPct:required, atrPct} : null;
}
function vVeto(reason, extras={}) {
  const v=state.vRecovery;
  if (v.lastVeto!==reason) { log('V_RECOVERY_SCAN_VETO', { reason, ...extras }); v.lastVeto=reason; }
  return null;
}
function observeVRecoveryTick(price, body) {
  if (!cfg.vRecoveryEnabled || cfg.executionMode!=='demo' || !isFiniteNum(price) || price<=0) return;
  const v=state.vRecovery, now=Date.now();
  const timeKey=numVal(body.barTimeMs ?? body.bar_time_ms ?? body.time, now);
  // No same-candle duplicate samples may increase confirmation confidence.
  if (v.priceHistory.length && timeKey && v.priceHistory[v.priceHistory.length-1].sourceKey===timeKey) {
    v.priceHistory[v.priceHistory.length-1].price=price;
  } else v.priceHistory.push({price, atMs:now, sourceKey:timeKey});
  v.priceHistory=v.priceHistory.filter(x=>x.atMs>=now-91*60000).slice(-550);
  if(v.candidate && now-v.candidate.lowAtMs>cfg.vRecoveryMaxAgeSec*1000) {
    log('V_RECOVERY_CANDIDATE_EXPIRED',{low:v.candidate.low,lowAtMs:v.candidate.lowAtMs, windowMin:v.candidate.minutes, high:v.candidate.high, dropPct:round(v.candidate.dropPct), requiredPct:round(v.candidate.requiredPct), maxBouncePct:round(v.candidate.maxBouncePct || 0), lastVeto:v.lastVeto || null, receivedFresh3mBull:Boolean(v.rayBull3m && v.rayBull3m.atMs>=v.candidate.lowAtMs), confirmationSamples:v.observations.length});
    v.candidate=null;v.rayBull3m=null;v.observations=[];
  }
  if(v.candidate && price<v.candidate.low) {
    v.candidate.low=price;v.candidate.lowAtMs=now;v.candidate.dropPct=100*(v.candidate.high-price)/v.candidate.high;v.observations=[];v.rayBull3m=null;
    log('V_RECOVERY_NEW_WASHOUT_LOW',{low:price});
  }
  if (v.candidate && v.candidate.low > 0) v.candidate.maxBouncePct=Math.max(v.candidate.maxBouncePct || 0,pct(price,v.candidate.low));
  const atr=freshVATR();
  // The advertised adaptive formula requires an actual confirmed 5m ATR measurement.
  if (cfg.vAtrRequire && !atr) return;
  const atrReference=atr || 0;
  const windows=[{minutes:30,pct:cfg.vDrop30Pct},{minutes:60,pct:cfg.vDrop60Pct},{minutes:90,pct:cfg.vDrop90Pct}];
  const hits=windows.map(x=>vDropEvidence(v.priceHistory,x.minutes,x.pct,atrReference)).filter(Boolean);
  if (!hits.length || state.position.inPosition) return;
  hits.sort((a,b)=>b.dropPct/b.requiredPct - a.dropPct/a.requiredPct);
  const best=hits[0];
  // Arm only with a low observed AFTER its high, never look into future candles.
  if (!v.candidate || (!v.candidate.used && best.low < v.candidate.low)) {
    v.candidate={...best,armedAtMs:now, used:false};
    v.observations=[];v.rayBull3m=null;
    log('V_RECOVERY_WASHOUT_ARMED', { windowMin:best.minutes,high:best.high,low:best.low,dropPct:round(best.dropPct),requiredPct:round(best.requiredPct),atrPct:round(best.atrPct) });
  }
}
async function evaluateVRecoveryAutoEntry(price, source) {
  if (!cfg.vRecoveryEnabled || cfg.executionMode!=='demo' || source!=='feature_tick') return null;
  const v=state.vRecovery, c=v.candidate;
  if (!c || c.used || !isFiniteNum(price)) return null;
  if (state.position && state.position.inPosition) return null;
  if (automaticEntryPaused()) return vVeto('AUTO_ENTRY_PAUSED');
  if (Date.now()-c.lowAtMs>cfg.vRecoveryMaxAgeSec*1000) return vVeto('CANDIDATE_EXPIRED');
  const pe=ray30PostExitStatus();
  if (pe.cooldownActive || pe.requireNewRayalgo) return vVeto('POST_EXIT_GUARD');
  const atr=freshVATR();
  if (cfg.vAtrRequire && !atr) return vVeto('MISSING_FRESH_REAL_5M_ATR');
  // ATR must not decrease the locked-in qualifying threshold for the armed washout.
  const effectiveReq=Math.max(c.requiredPct,c.minutes===30?cfg.vDrop30Pct:c.minutes===60?cfg.vDrop60Pct:cfg.vDrop90Pct,
    cfg.vDropAtrMult*(atr||0));
  if (c.dropPct < effectiveReq) return vVeto('DROP_BELOW_CURRENT_ADAPTIVE_ATR',{dropPct:round(c.dropPct),requiredPct:round(effectiveReq)});
  const bounce=pct(price,c.low);
  if (bounce<cfg.vRecoveryMinBouncePct) return vVeto('WAIT_RECOVERY_BOUNCE',{bouncePct:round(bounce)});
  if (bounce>cfg.vRecoveryMaxBouncePct) return vVeto('RECOVERY_OVEREXTENDED',{bouncePct:round(bounce)});
  const ray=v.rayBull3m;
  if (!ray || ray.atMs<c.lowAtMs || Date.now()-ray.atMs>cfg.vRayMaxAgeSec*1000) return vVeto('WAIT_FRESH_3M_BULLISH_TREND_CHANGE');
  const ext=state.latest && state.latest.rayalgoExternal;
  if(ext && ext.atMs>ray.atMs && ext.regime==='RAY_BEAR') return vVeto('NEW_30M_BEAR_ALERT_AFTER_3M_BULL');
  const blocked=fvvoLongBlockStatus();
  if(blocked.blocked) return vVeto('RECENT_FVVO_BEARISH_BLOCK',{blockers:blocked.blockers});
  const t=state.latest && state.latest.tick, raw=t && t.raw || {};
  const fresh=t && Date.now()-t.atMs <= cfg.featureTickMaxAgeSec*1000;
  const sourceKey=numVal(raw.barTimeMs ?? raw.bar_time_ms ?? raw.time, t && t.sourceTime);
  const prior=v.observations[v.observations.length-1];
  if (prior && sourceKey && prior.sourceKey===sourceKey) return vVeto('DUPLICATE_15S_CANDLE');
  if (prior && Date.now()-prior.atMs<cfg.vConfirmTickGapSec*1000) return vVeto('WAIT_15S_SEPARATION');
  const rsi=numVal(raw.rsi,null),fvvo=numVal(raw.fvvo ?? raw.fvvoValue,null);
  const ema8=numVal(raw.ema8,null),ema18=numVal(raw.ema18,null);
  const valid=Boolean(fresh && isFiniteNum(rsi) && rsi>=cfg.vMinRsi15s && isFiniteNum(fvvo) && fvvo>=cfg.vMinFvvo15s &&
    (!isFiniteNum(ema8)||price>=ema8) && (!isFiniteNum(ema18)||price>=ema18) && price>c.low);
  v.observations.push({atMs:Date.now(),sourceKey,price,ok:valid});
  v.observations=v.observations.slice(-cfg.vConfirmWindow);
  const obs=v.observations;
  const positive=obs.filter(x=>x.ok);
  const span=positive.length>0?(positive[positive.length-1].atMs-positive[0].atMs)/1000:0;
  if (obs.length<cfg.vConfirmWindow || !valid || positive.length<cfg.vConfirmRequired || span<cfg.vConfirmMinSec)
    return vVeto('WAIT_15S_CONFIRMATION',{positive:positive.length, observed:obs.length, spanSec:span});
  // Micro-breakout confirmation must occur after earlier observations, not from a candle that has yet to close.
  const priorHigh=Math.max(...obs.slice(0,-1).map(x=>x.price));
  const microChase=100*(price-priorHigh)/priorHigh;
  if (price<priorHigh || microChase>cfg.vMaxMicroChasePct) return vVeto('WAIT_MICRO_RECLAIM_OR_TOO_FAR',{priorHigh,deltaPct:round(microChase)});
  if (!cfg.vRecoverySendOrder || !cfg.ray30AutoEntryEnabled || !cfg.ray30AutoEntrySendOrder) {
    log('V_RECOVERY_SHADOW_READY',{price,low:c.low,bouncePct:round(bounce)});
    c.used=true;saveState();return {type:'v_recovery_shadow',decision:'SHADOW_READY'};
  }
  log('V_RECOVERY_ENTRY_READY',{ price,low:c.low,bouncePct:round(bounce),dropPct:round(c.dropPct),windowMin:c.minutes,raySignal:ray.signal,positiveTicks:positive.length,mode:'V_RECOVERY_PROBATION'});
  const out=await enterLong({price,source:'v_recovery_probation_auto',campaignId:null,entryRole:'v_recovery',setup:{raw:{profile:'V_RECOVERY_PROBATION'},stopPrice:null,tp1:null}});
  if(out && out.ok){ c.used=true;v.lastEntryAtMs=Date.now();v.lastVeto=null;saveState(); }
  return {type:'v_recovery_entry',decision:out&&out.ok?'ENTERED':'ENTER_FAILED',out};
}

function rememberRecentPrice(price) {
  const arr = state.latest.recentPrices || [];
  arr.push({ price, atMs: Date.now() });
  const minMs = Date.now() - cfg.emergencyDropWindowSec * 1000;
  state.latest.recentPrices = arr.filter(x => x.atMs >= minMs).slice(-500);
}

function recentDropPct(currentPrice) {
  const arr = state.latest.recentPrices || [];
  if (!arr.length || !isFiniteNum(currentPrice)) return null;
  const high = Math.max(...arr.map(x => x.price).filter(isFiniteNum));
  if (!isFiniteNum(high) || high <= 0) return null;
  return ((high - currentPrice) / high) * 100;
}

function floorUpgradeLabel(source) {
  if (source === 'micro') return 'FVVO_MICRO_FLOOR_LOCK_UPGRADED';
  if (source === 'progressive') return 'FVVO_PROGRESSIVE_FLOOR_LOCK_UPGRADED';
  if (source === 'protective') return 'FVVO_PROTECTIVE_FLOOR_LOCK_UPGRADED';
  return 'FVVO_PERMANENT_FLOOR_LOCK_UPGRADED';
}

function floorExitLabel(source) {
  if (source === 'micro') return 'FVVO_MICRO_FLOOR_EXIT';
  if (source === 'progressive') return 'FVVO_PROGRESSIVE_FLOOR_EXIT';
  if (source === 'protective') return 'FVVO_PROTECTIVE_FLOOR_EXIT';
  return 'FVVO_PERMANENT_FLOOR_EXIT';
}

function floorReasonSource(source) {
  if (source === 'micro') return 'MICRO';
  if (source === 'progressive') return 'PROGRESSIVE';
  if (source === 'protective') return 'PROTECTIVE';
  return 'PERMANENT';
}

function floorExitMinMfePct(source) {
  if (source === 'micro') return cfg.microFloor1MfePct;
  if (source === 'protective') return cfg.protectiveFloor1MfePct;
  if (source === 'progressive') return cfg.progressiveStartMfePct;
  return cfg.floor1MfePct;
}

function activeFloorLock(mfePct) {
  return activeFloorResult(mfePct, null).lock;
}

function fixedFloorLock(mfePct) {
  if (!cfg.permanentFloorsEnabled) return null;
  let lock = null;
  if (mfePct >= cfg.floor1MfePct) lock = cfg.floor1LockPct;
  if (mfePct >= cfg.floor2MfePct) lock = cfg.floor2LockPct;
  if (mfePct >= cfg.floor3MfePct) lock = cfg.floor3LockPct;
  if (mfePct >= cfg.floor4MfePct) lock = cfg.floor4LockPct;
  return lock;
}

function microFloorLock(mfePct) {
  if (!cfg.permanentFloorsEnabled || !cfg.microFloorsEnabled) return null;
  if (!isFiniteNum(mfePct)) return null;
  let lock = null;
  if (mfePct >= cfg.microFloor1MfePct) lock = cfg.microFloor1LockPct;
  if (mfePct >= cfg.microFloor2MfePct) lock = cfg.microFloor2LockPct;
  return lock;
}

function protectiveFloorLock(mfePct) {
  if (!cfg.permanentFloorsEnabled || !cfg.protectiveFloorsEnabled) return null;
  if (!isFiniteNum(mfePct)) return null;
  let lock = null;
  if (mfePct >= cfg.protectiveFloor1MfePct) lock = cfg.protectiveFloor1LockPct;
  if (mfePct >= cfg.protectiveFloor2MfePct) lock = cfg.protectiveFloor2LockPct;
  return lock;
}

function activeFloorResult(mfePct, currentLockPct) {
  const fixedLock = fixedFloorLock(mfePct);
  const microLock = microFloorLock(mfePct);
  const protectiveLock = protectiveFloorLock(mfePct);
  const progressive = progressiveFloorLock(mfePct);
  const candidates = [];
  if (isFiniteNum(fixedLock)) candidates.push({ source: 'fixed', lock: fixedLock });
  if (isFiniteNum(microLock)) candidates.push({ source: 'micro', lock: microLock });
  if (isFiniteNum(protectiveLock)) candidates.push({ source: 'protective', lock: protectiveLock });
  if (progressive && isFiniteNum(progressive.lock)) candidates.push({ ...progressive, source: 'progressive' });
  if (!candidates.length) return { lock: null, fixedLock, microLock, dynamicLock: null, source: null, band: null };

  const best = candidates.reduce((a, b) => (b.lock > a.lock ? b : a));
  let lock = best.lock;
  if (cfg.progressiveNeverLoosen && isFiniteNum(currentLockPct)) lock = Math.max(currentLockPct, lock);

  return {
    lock,
    fixedLock,
    microLock,
    protectiveLock,
    dynamicLock: progressive ? progressive.lock : null,
    allowedPullbackPct: progressive ? progressive.allowedPullbackPct : null,
    band: progressive ? progressive.band : null,
    bandProgressPct: progressive ? progressive.bandProgressPct : null,
    source: best.source
  };
}

function progressiveFloorLock(mfePct) {
  if (!cfg.permanentFloorsEnabled || !cfg.progressiveFloorsEnabled) return null;
  if (!isFiniteNum(mfePct) || mfePct < cfg.progressiveStartMfePct) return null;

  const band = Math.max(2, Math.floor(mfePct));
  const progress = Math.max(0, Math.min(1, mfePct - band));
  const spec = progressiveBandSpec(band);
  if (!spec) return null;

  const allowedPullbackPct = spec.max - ((spec.max - spec.min) * progress);
  const lock = mfePct - allowedPullbackPct;
  return {
    lock,
    allowedPullbackPct,
    band,
    bandProgressPct: progress * 100,
    maxPullbackPct: spec.max,
    minPullbackPct: spec.min
  };
}

function progressiveBandSpec(band) {
  if (band <= 2) return { max: cfg.progressiveBand2MaxPullbackPct, min: cfg.progressiveBand2MinPullbackPct };
  if (band === 3) return { max: cfg.progressiveBand3MaxPullbackPct, min: cfg.progressiveBand3MinPullbackPct };
  if (band === 4) return { max: cfg.progressiveBand4MaxPullbackPct, min: cfg.progressiveBand4MinPullbackPct };
  if (band === 5) return { max: cfg.progressiveBand5MaxPullbackPct, min: cfg.progressiveBand5MinPullbackPct };
  return { max: cfg.progressiveBand6MaxPullbackPct, min: cfg.progressiveBand6MinPullbackPct };
}

function floorConfigSummary() {
  return {
    permanentFloorsEnabled: cfg.permanentFloorsEnabled,
    fixed: [
      { mfePct: cfg.floor1MfePct, lockPct: cfg.floor1LockPct },
      { mfePct: cfg.floor2MfePct, lockPct: cfg.floor2LockPct },
      { mfePct: cfg.floor3MfePct, lockPct: cfg.floor3LockPct },
      { mfePct: cfg.floor4MfePct, lockPct: cfg.floor4LockPct }
    ],
    micro: {
      enabled: cfg.microFloorsEnabled,
      floors: [
        { mfePct: cfg.microFloor1MfePct, lockPct: cfg.microFloor1LockPct },
        { mfePct: cfg.microFloor2MfePct, lockPct: cfg.microFloor2LockPct }
      ]
    },
    protective: {
      enabled: cfg.protectiveFloorsEnabled,
      floors: [
        { mfePct: cfg.protectiveFloor1MfePct, lockPct: cfg.protectiveFloor1LockPct },
        { mfePct: cfg.protectiveFloor2MfePct, lockPct: cfg.protectiveFloor2LockPct }
      ]
    },
    progressive: {
      enabled: cfg.progressiveFloorsEnabled,
      startMfePct: cfg.progressiveStartMfePct,
      neverLoosen: cfg.progressiveNeverLoosen,
      bands: {
        '2': { maxPullbackPct: cfg.progressiveBand2MaxPullbackPct, minPullbackPct: cfg.progressiveBand2MinPullbackPct },
        '3': { maxPullbackPct: cfg.progressiveBand3MaxPullbackPct, minPullbackPct: cfg.progressiveBand3MinPullbackPct },
        '4': { maxPullbackPct: cfg.progressiveBand4MaxPullbackPct, minPullbackPct: cfg.progressiveBand4MinPullbackPct },
        '5': { maxPullbackPct: cfg.progressiveBand5MaxPullbackPct, minPullbackPct: cfg.progressiveBand5MinPullbackPct },
        '6plus': { maxPullbackPct: cfg.progressiveBand6MaxPullbackPct, minPullbackPct: cfg.progressiveBand6MinPullbackPct }
      }
    },
    runner: { enabled: cfg.runnerEnabled, activateMfePct: cfg.runnerActivateMfePct, minLockPct: cfg.runnerMinLockPct, givebackPct: cfg.runnerGivebackPct }
  };
}

function priceFrom(body) {
  return numVal(body.price ?? body.close ?? body.trigger_price ?? body.triggerPrice ?? body.last ?? body.mark_price, null);
}

function pct(price, entry) {
  if (!isFiniteNum(price) || !isFiniteNum(entry) || entry === 0) return 0;
  return ((price - entry) / entry) * 100;
}

function rangeContains(price, low, high) {
  if (!isFiniteNum(price) || !isFiniteNum(low) || !isFiniteNum(high)) return false;
  const lo = Math.min(low, high);
  const hi = Math.max(low, high);
  return price >= lo && price <= hi;
}

function normalizeSymbol(s) {
  return String(s || '').toUpperCase().replace(/^BINANCE:/, '').replace(/[^A-Z0-9]/g, '');
}

function compactRaw(body) {
  const out = {};
  for (const k of Object.keys(body || {})) {
    if (String(k).toLowerCase().includes('secret')) continue;
    const v = body[k];
    if (v === null || typeof v === 'undefined') continue;
    if (typeof v === 'object') continue;
    out[k] = String(v).slice(0, 200);
  }
  return out;
}

function safeHost(url) {
  try { return new URL(url).host; } catch (_) { return 'BAD_URL'; }
}

function codePrefix(code) {
  const s = String(code || '');
  if (!s) return '';
  return `${s.slice(0, 18)}...${s.slice(-6)}`;
}

function intEnv(name, def) { return intVal(env[name], def); }
function numEnv(name, def) { return numVal(env[name], def); }
function boolEnv(name, def) { return boolVal(env[name], def); }
function intVal(v, def) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : def;
}
function numVal(v, def) {
  if (v === null || typeof v === 'undefined' || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function boolVal(v, def) {
  if (v === null || typeof v === 'undefined' || v === '') return def;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return def;
}
function isFiniteNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function toMaybeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}
function round(n) { return Math.round(n * 10000) / 10000; }
function nowIso() { return new Date().toISOString(); }
