'use strict';

/**
 * BrainFVVO_SOL_v3d_RAY30_PULLBACK_LONGHOLD_DEMO
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

const BRAIN = 'BrainFVVO_SOL_v3d_RAY30_PULLBACK_LONGHOLD_DEMO';

const env = process.env;

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
  stateFile: env.STATE_FILE || '/data/brainfvvo-sol-ray30-longhold-v3d-state.json',
  ray30LongGateMode: env.RAY30_LONG_GATE_MODE || 'EASY_TEST',
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
  floor2LockPct: numEnv('RAY30_FLOOR_2_LOCK_PCT', 0.50),
  floor3MfePct: numEnv('RAY30_FLOOR_3_MFE_PCT', 3.00),
  floor3LockPct: numEnv('RAY30_FLOOR_3_LOCK_PCT', 1.00),
  floor4MfePct: numEnv('RAY30_FLOOR_4_MFE_PCT', 4.00),
  floor4LockPct: numEnv('RAY30_FLOOR_4_LOCK_PCT', 2.00),
  runnerEnabled: boolEnv('RAY30_RUNNER_ENABLED', true),
  runnerActivateMfePct: numEnv('RAY30_RUNNER_ACTIVATE_MFE_PCT', 5.00),
  runnerMinLockPct: numEnv('RAY30_RUNNER_MIN_LOCK_PCT', 3.00),
  runnerGivebackPct: numEnv('RAY30_RUNNER_GIVEBACK_PCT', 1.50),

  // Cosmetic / log controls. Processing still continues when a log stream is disabled.
  logEmojiEnabled: boolEnv('LOG_EMOJI_ENABLED', true),
  logFeatureTickEnabled: boolEnv('LOG_FEATURE_TICK_ENABLED', true),
  log15sTickEnabled: boolEnv('LOG_15S_TICK_ENABLED', true),
  log15sTickEveryN: Math.max(1, intEnv('LOG_15S_TICK_EVERY_N', 1)),
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

const logCounters = { featureTick15s: 0 };

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
  logConfig: {
    logEmojiEnabled: cfg.logEmojiEnabled,
    logFeatureTickEnabled: cfg.logFeatureTickEnabled,
    log15sTickEnabled: cfg.log15sTickEnabled,
    log15sTickEveryN: cfg.log15sTickEveryN,
    logFeature5mEnabled: cfg.logFeature5mEnabled,
    logC3PayloadAudit: cfg.logC3PayloadAudit
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

  if (event.includes('RAY') || body.ray_signal || body.signal) {
    state.latest.ray30 = { signal: body.ray_signal || body.signal || event, at: nowIso(), atMs: Date.now(), raw: compactRaw(body) };
    log('FVVO_RAY30_SIGNAL_RECEIVED', { symbol: cfg.symbol, signal: state.latest.ray30.signal, event });
    saveState();
    return { ok: true, brain: BRAIN, accepted: true, event: 'RAY30', state: publicState() };
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

  state.position = emptyPosition();
  state.position.lastExitReason = reason;
  state.position.lastC3Exit = forward;
  saveState();
  log('FVVO_MANUAL_EXIT_LONG_ACCEPTED', { price: exitPrice, reason, hadOpenPosition, requestId: exitRequestId, c3Forward: summarizeForward(forward) });
  return { ok: true, brain: BRAIN, action: 'exit_long', exited: true, price: exitPrice, reason, c3Forward: forward, previousPosition: summarizePosition(prev), state: publicState() };
}

async function evaluatePositionExit(price, source) {
  if (!state.position || !state.position.inPosition) return null;
  const p = state.position;
  const profitPct = pct(price, p.entryPrice);

  if (!isFiniteNum(p.peakPrice) || price > p.peakPrice) p.peakPrice = price;
  p.mfePct = Math.max(numVal(p.mfePct, 0), pct(p.peakPrice, p.entryPrice));

  const floorLock = activeFloorLock(p.mfePct);
  if (isFiniteNum(floorLock) && (!isFiniteNum(p.activeFloorLockPct) || floorLock > p.activeFloorLockPct)) {
    p.activeFloorLockPct = floorLock;
    log('FVVO_PERMANENT_FLOOR_LOCK_UPGRADED', { entryPrice: p.entryPrice, price, mfePct: round(p.mfePct), activeFloorLockPct: floorLock });
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
    const reason = `RAY30_PERMANENT_FLOOR_LOCK_${p.activeFloorLockPct}PCT`;
    log('FVVO_PERMANENT_FLOOR_EXIT', { price, source, profitPct: round(profitPct), mfePct: round(p.mfePct), activeFloorLockPct: p.activeFloorLockPct });
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
      runnerEnabled: cfg.runnerEnabled
    },
    logConfig: {
      logEmojiEnabled: cfg.logEmojiEnabled,
      logFeatureTickEnabled: cfg.logFeatureTickEnabled,
      log15sTickEnabled: cfg.log15sTickEnabled,
      log15sTickEveryN: cfg.log15sTickEveryN,
      logFeature5mEnabled: cfg.logFeature5mEnabled,
      logC3PayloadAudit: cfg.logC3PayloadAudit
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
  state.latest = state.latest || { tick: null, feature5m: null, ray30: null, recentPrices: [] };
  state.latest.recentPrices = state.latest.recentPrices || [];
  state.position = state.position || emptyPosition();
  state.priceTrigger = state.priceTrigger || null;
  state.campaigns = state.campaigns || {};
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
  return { latest: { tick: null, feature5m: null, ray30: null, recentPrices: [] }, position: emptyPosition(), priceTrigger: null, campaigns: {}, handoff: { active: false, at: null, reason: null } };
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
  if (/C3_FORWARD_SEND|C3_FORWARD_PAYLOAD_AUDIT|C3_FORWARD_ACCEPTED|MANUAL_EXIT_LONG_ACCEPTED/.test(label)) return '🟢';
  if (/NO_OPEN|EXPIRED|MISSING|NO_ENTRY|WARN|LOAD_FAILED|SAVE_FAILED/.test(label)) return '🟡';
  if (/NOT_ACCEPTED|FAIL|ERROR|BLOCKED|CANCEL|STOP|DROP|BEAR/.test(label)) return '🔴';
  if (/ACCEPTED|TRACKED|OPEN|ENTRY_READY|ARMED|ADOPTED/.test(label)) return '🟢';
  if (/RAY|CAMPAIGN/.test(label)) return '🟣';
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
  if (v === 0 || v === '0') return 'RAY_NEUTRAL';
  return v || 'RAY_NEUTRAL';
}

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

function activeFloorLock(mfePct) {
  if (!cfg.permanentFloorsEnabled) return null;
  let lock = null;
  if (mfePct >= cfg.floor1MfePct) lock = cfg.floor1LockPct;
  if (mfePct >= cfg.floor2MfePct) lock = cfg.floor2LockPct;
  if (mfePct >= cfg.floor3MfePct) lock = cfg.floor3LockPct;
  if (mfePct >= cfg.floor4MfePct) lock = cfg.floor4LockPct;
  return lock;
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
