'use strict';

/**
 * BrainFVVO_SOL_v3m_RAYALGO_EXTERNAL_SETUP_OPTIMIZED_DEMO
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

const BRAIN = env.BRAIN_NAME || 'BrainFVVO_SOL_v3m_RAYALGO_EXTERNAL_SETUP_OPTIMIZED_DEMO';

const cfg = {
  port: intEnv('PORT', 8080),
  symbol: env.SYMBOL || 'BINANCE:SOLUSDT',
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
  c3AmountPerTrade: env.C3_AMOUNT_PER_TRADE || '',
  c3AmountPerTradeType: env.C3_AMOUNT_PER_TRADE_TYPE || '',
  c3OrderType: env.C3_ORDER_TYPE || 'market',
  stateFile: env.STATE_FILE || '/data/brainfvvo-sol-ray30-longhold-v3m-state.json',
  ray30LongGateMode: env.RAY30_LONG_GATE_MODE || 'RAYALGO_STRICT',
  ray30MaxAgeSec: intEnv('RAY30_MAX_AGE_SEC', 2700),
  feature5mMaxAgeSec: intEnv('FEATURE_5M_MAX_AGE_SEC', 420),
  featureTickMaxAgeSec: intEnv('FEATURE_TICK_MAX_AGE_SEC', 60),
  stopLossPct: numEnv('RAY30_STOP_LOSS_PCT', 0.80),
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
  fvvoSniperSellBlockSec: intEnv('FVVO_SNIPER_SELL_BLOCK_SEC', 1800),
  fvvoBurstBearishBlockSec: intEnv('FVVO_BURST_BEARISH_BLOCK_SEC', 1800),
  fvvoSniperBuyUseForEntry: boolEnv('FVVO_SNIPER_BUY_USE_FOR_ENTRY', false),
  fvvoBurstBullishUseForEntry: boolEnv('FVVO_BURST_BULLISH_USE_FOR_ENTRY', false),

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
  ray30Pullback5mMinRsi: numEnv('RAY30_PULLBACK_5M_MIN_RSI', 50),
  ray30Pullback5mMinFvvo: numEnv('RAY30_PULLBACK_5M_MIN_FVVO', -0.60),
  ray30Pullback5mMinSlope: numEnv('RAY30_PULLBACK_5M_MIN_SLOPE', -0.20),
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
  log15sTickEveryN: Math.max(1, intEnv('LOG_15S_TICK_EVERY_N', 20)),
  logFeature5mEnabled: boolEnv('LOG_FEATURE_5M_ENABLED', true),
  logC3PayloadAudit: boolEnv('LOG_C3_PAYLOAD_AUDIT', true)
};

const SUPPORTED_MANUAL_ACTIONS = [
  'status',
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
    pullbackRequire5mAboveEma18: cfg.ray30PullbackRequire5mAboveEma18,
    pullbackRequire5mEma8AboveEma18: cfg.ray30PullbackRequire5mEma8AboveEma18,
    clearSetupOnExit: cfg.ray30ClearSetupOnExit,
    postExitCooldownSec: cfg.ray30PostExitCooldownSec,
    postExitRequireNewRayalgoAlert: cfg.ray30PostExitRequireNewRayalgoAlert,
    fvvoConfidenceMonitorEnabled: cfg.fvvoConfidenceMonitorEnabled,
    fvvoConfidenceMaxAgeSec: cfg.fvvoConfidenceMaxAgeSec,
    fvvoConfidenceUsage: 'BEARISH_BLOCKERS_ONLY_BUY_MONITOR_ONLY'
  },
  floorConfig: floorConfigSummary(),
  logConfig: {
    logEmojiEnabled: cfg.logEmojiEnabled,
    logFeatureTickEnabled: cfg.logFeatureTickEnabled,
    log15sTickEnabled: cfg.log15sTickEnabled,
    log15sTickEveryN: cfg.log15sTickEveryN,
    logFeature5mEnabled: cfg.logFeature5mEnabled,
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
      log('FVVO_FEATURE_TICK_RECEIVED', featureLogPayload(body, event || body.kind || 'FEATURE_TICK_FVVO', price, 'tick'));
      const evalOut = await evaluateAll(price, 'feature_tick');
      saveState();
      return { ok: true, brain: BRAIN, accepted: true, event: 'FEATURE_TICK_FVVO', price, eval: evalOut, state: publicState() };
    }
  }

  if (event === 'FEATURE_5M_FVVO' || event === 'fvvo_feature_5m' || body.kind === 'fvvo_feature_5m') {
    if (isFiniteNum(price)) {
      state.latest.feature5m = { price, at: nowIso(), atMs: Date.now(), sourceTime: nowMs, raw: compactRaw(body) };
      rememberRecentPrice(price);
      log('FVVO_FEATURE_5M_RECEIVED', featureLogPayload(body, event || body.kind || 'FEATURE_5M_FVVO', price, 'feature5m'));
      const evalOut = await evaluateAll(price, 'feature_5m');
      saveState();
      return { ok: true, brain: BRAIN, accepted: true, event: 'FEATURE_5M_FVVO', price, eval: evalOut, state: publicState() };
    }
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
      note: 'stored_for_validation_only_not_used_for_auto_entry_or_exit'
    });

    saveState();
    return { ok: true, brain: BRAIN, accepted: true, event: 'FVVO_SIGNAL', signal: signalState.signal, side: signalState.side, usage: signalState.usage, state: publicState() };
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

    if (externalRayAlgo && cfg.rayalgoExternalAlertsEnabled) {
      state.latest.rayalgoExternal = rayState;
      const setupTfAllowed = rayalgoTimeframeAllowed(rayState.timeframe);
      if (cfg.ray30SetupEntryEnabled && setupTfAllowed) {
        updateRay30EntrySetupFromRayAlgo(rayState);
      } else if (!setupTfAllowed) {
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
        setupTfAllowed
      });
    } else {
      state.latest.ray30Feature = rayState;
    }

    state.latest.ray30 = activeRayForGate().state || rayState;
    if (isFiniteNum(price)) rememberRecentPrice(price);
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
    const evalOut = isFiniteNum(price) ? await evaluateAll(price, 'ray30_signal') : [];
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
  const triggerOut = await evaluateStandaloneTrigger(price, source);
  if (triggerOut) events.push(triggerOut);

  const campaignOut = await evaluateCampaigns(price, source);
  events.push(...campaignOut);

  const autoOut = await evaluateRay30AutoEntry(price, source);
  if (autoOut) events.push(autoOut);

  const exitOut = await evaluatePositionExit(price, source);
  if (exitOut) events.push(exitOut);

  return events;
}

async function evaluateStandaloneTrigger(price, source) {
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

  const forward = await forwardTo3Commas('enter_long', price, { source, campaignId, entryRole, requestId: entryRequestId, setup, reason: source });
  if (!forward.ok && !forward.dryRun) {
    log('FVVO_ENTER_LONG_C3_FORWARD_FAILED_NO_POSITION_TRACKED', { price, source, campaignId, entryRole, forward });
    return { ok: false, error: 'C3_ENTER_LONG_FORWARD_FAILED', c3Forward: forward, httpStatus: 502, state: publicState() };
  }

  state.position = {
    inPosition: true,
    positionLifecycle: forward.dryRun ? 'ENTRY_DRY_RUN' : 'ENTRY_ACCEPTED_UNVERIFIED_FILL',
    phase: 'ONE_STOP_ACTIVE',
    entryPrice: price,
    entryTime: nowIso(),
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
    if (ext) updateRay30EntrySetupFromRayAlgo(ext);
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
  const pullbackRecoveryReady = Boolean(
    cfg.ray30PullbackEntryEnabled &&
    s.pullbackSeen &&
    dipFromHighPct <= cfg.ray30PullbackMaxDipPct &&
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
  else if (s.pullbackSeen) reason = !fivePullbackOk ? 'WAIT_PULLBACK_5M_RECOVERY' : (!tickPullbackOk ? 'WAIT_PULLBACK_15S_RECLAIM' : 'WAIT_PULLBACK_RECOVERY');
  else if (moveFromRayPct >= cfg.ray30BreakoutMinMoveFromRayPct) reason = !fiveBreakoutOk ? 'WAIT_BREAKOUT_5M_CONFIRM' : (!tickBreakoutOk ? 'WAIT_BREAKOUT_15S_CONFIRM' : 'WAIT_BREAKOUT_CONFIRM');
  else if (isFiniteNum(rayAgeSec) && rayAgeSec < cfg.ray30SetupNoImmediateEntrySec) reason = 'NO_IMMEDIATE_ENTRY_AFTER_RAYALGO_BULL';

  return summarizeRay30Setup(s, reason, { rayAgeSec, dipFromHighPct, moveFromRayPct, instantSourceOk, instantAgeOk, fiveInstantOk, tickInstantOk, instantQualifiedReady, fivePullbackOk, tickPullbackOk, fiveBreakoutOk, tickBreakoutOk, pullbackRecoveryReady, breakoutContinuationReady });
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

async function evaluatePositionExit(price, source) {
  if (!state.position || !state.position.inPosition) return null;
  const p = state.position;
  const profitPct = pct(price, p.entryPrice);

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

  if (profitPct <= -Math.abs(cfg.stopLossPct)) {
    const reason = `RAY30_STOP_LOSS_${cfg.stopLossPct}PCT`;
    log('FVVO_STOP_LOSS_EXIT', { price, source, profitPct: round(profitPct), threshold: -Math.abs(cfg.stopLossPct) });
    const out = await exitLong({ price, reason });
    return { type: 'exit', reason, out };
  }

  if (isFiniteNum(p.activeFloorLockPct) && profitPct <= p.activeFloorLockPct && p.mfePct >= cfg.floor1MfePct) {
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
    position: summarizePosition(state.position),
    priceTrigger: state.priceTrigger ? summarizeSetup(state.priceTrigger) : null,
    campaigns: summarizeCampaigns(state.campaigns),
    ray30Pullback: summarizePullback(state.ray30Pullback),
    ray30Setup: summarizeRay30Setup(state.ray30Setup, state.ray30Setup && state.ray30Setup.reason),
    fvvoConfidence: summarizeFvvoConfidence(state.latest && state.latest.fvvoConfidence),
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
  state.position = state.position || emptyPosition();
  state.priceTrigger = state.priceTrigger || null;
  state.campaigns = state.campaigns || {};
  state.ray30Pullback = state.ray30Pullback || { armed: false };
  state.handoff = state.handoff || { active: false, at: null, reason: null };
}

function loadState() {
  try {
    if (fs.existsSync(cfg.stateFile)) {
      return JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'));
    }
  } catch (err) {
    log('FVVO_STATE_LOAD_FAILED', { stateFile: cfg.stateFile, error: err.message });
  }
  return { latest: { tick: null, feature5m: null, ray30: null, ray30Feature: null, rayalgoExternal: null, fvvoConfidence: {}, recentPrices: [] }, position: emptyPosition(), priceTrigger: null, campaigns: {}, ray30Pullback: { armed: false }, ray30Setup: { active: false }, handoff: { active: false, at: null, reason: null } };
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
  if (!expected) return true;
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
  if (source === 'progressive') return 'FVVO_PROGRESSIVE_FLOOR_LOCK_UPGRADED';
  if (source === 'protective') return 'FVVO_PROTECTIVE_FLOOR_LOCK_UPGRADED';
  return 'FVVO_PERMANENT_FLOOR_LOCK_UPGRADED';
}

function floorExitLabel(source) {
  if (source === 'progressive') return 'FVVO_PROGRESSIVE_FLOOR_EXIT';
  if (source === 'protective') return 'FVVO_PROTECTIVE_FLOOR_EXIT';
  return 'FVVO_PERMANENT_FLOOR_EXIT';
}

function floorReasonSource(source) {
  if (source === 'progressive') return 'PROGRESSIVE';
  if (source === 'protective') return 'PROTECTIVE';
  return 'PERMANENT';
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
  const protectiveLock = protectiveFloorLock(mfePct);
  const progressive = progressiveFloorLock(mfePct);
  const candidates = [];
  if (isFiniteNum(fixedLock)) candidates.push({ source: 'fixed', lock: fixedLock });
  if (isFiniteNum(protectiveLock)) candidates.push({ source: 'protective', lock: protectiveLock });
  if (progressive && isFiniteNum(progressive.lock)) candidates.push({ ...progressive, source: 'progressive' });
  if (!candidates.length) return { lock: null, fixedLock, dynamicLock: null, source: null, band: null };

  const best = candidates.reduce((a, b) => (b.lock > a.lock ? b : a));
  let lock = best.lock;
  if (cfg.progressiveNeverLoosen && isFiniteNum(currentLockPct)) lock = Math.max(currentLockPct, lock);

  return {
    lock,
    fixedLock,
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
