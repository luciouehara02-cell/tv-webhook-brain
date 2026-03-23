import { CONFIG } from "./config.js";

function createInitialState() {
  return {
    market: {
      symbol: CONFIG.SYMBOL,
      tf: CONFIG.TF,
      price: null,
      time: null,
    },

    meta: {
      barIndex: 0,
      lastUpdatedAt: null,
    },

    features: {
      open: null,
      high: null,
      low: null,
      close: null,
      ema8: null,
      ema18: null,
      ema50: null,
      rsi: null,
      atr: null,
      atrPct: null,
      adx: null,
      oiTrend: null,
      oiDeltaBias: null,
      cvdTrend: null,
      liqClusterBelow: null,
      priceDropPct: null,
      patternAReady: null,
      patternAWatch: null,
    },

    context: {
      regime: "unknown",
      confidence: 0,
      hostile: false,
      reasons: [],
      updatedAt: null,
    },

    setups: {
      breakout: {
        phase: "idle",
        startedBar: null,
        phaseBar: null,
        triggerPrice: null,
        breakoutLevel: null,
        retestPrice: null,
        bouncePrice: null,
        score: 0,
        reasons: [],
        lastTransition: null,
        updatedAt: null,

        setupId: null,
        retestLow: null,
        invalidationPrice: null,
        readySinceBar: null,
        expiresAtBar: null,
        bouncePct: null,
        pullbackPct: null,
        chasePct: null,
        qualityFlags: [],
        cancelReason: null,
        consumedAtBar: null,

        bounceBodyPct: null,
        bounceCloseInRangePct: null,
        reclaimPctFromTrigger: null,
        reentryCount: 0,
      },
    },

    validation: {
      breakout: {
        allowed: false,
        reasons: ["not in entry-capable phase"],
        updatedAt: null,
      },
    },

    position: {
      inPosition: false,
      side: null,
      entryPrice: null,
      entryTime: null,
      entrySetupType: null,
      entrySetupId: null,
      peakPrice: null,
      stopPrice: null,
      breakEvenArmed: false,
      trailingActive: false,
      profitLockActive: false,
      lastExitReason: null,
    },

    execution: {
      lastAction: null,
      lastActionAt: null,
      lastEnteredSetupId: null,
      cooldownUntilBar: null,

      lastLiveSendOk: null,
      lastLiveSendAt: null,
      lastLiveResponse: null,
      lastLiveEventKey: null,
      lastLiveGuardrailReason: null,
      lastSignalPayload: null,

      lastFeatureEventKey: null,
    },

    tick: {
      lastPrice: null,
      lastTime: null,
      count: 0,
    },
  };
}

let STATE = createInitialState();

function stamp() {
  return new Date().toISOString();
}

function mergeInto(target, patch) {
  if (!patch || typeof patch !== "object") return target;
  Object.assign(target, patch);
  return target;
}

export function getState() {
  return STATE;
}

export function resetState() {
  STATE = createInitialState();
  return STATE;
}

export function updateTick(payload) {
  STATE.tick.lastPrice = payload?.price ?? STATE.tick.lastPrice;
  STATE.tick.lastTime = payload?.time ?? STATE.tick.lastTime;
  STATE.tick.count = (STATE.tick.count ?? 0) + 1;

  STATE.market.symbol = payload?.symbol ?? STATE.market.symbol;
  STATE.market.tf = payload?.tf ?? STATE.market.tf;
  STATE.market.price = payload?.price ?? STATE.market.price;
  STATE.market.time = payload?.time ?? STATE.market.time;

  STATE.meta.lastUpdatedAt = stamp();
}

export function updateFeatures(payload) {
  mergeInto(STATE.features, {
    open: payload?.open ?? null,
    high: payload?.high ?? null,
    low: payload?.low ?? null,
    close: payload?.close ?? null,
    ema8: payload?.ema8 ?? null,
    ema18: payload?.ema18 ?? null,
    ema50: payload?.ema50 ?? null,
    rsi: payload?.rsi ?? null,
    atr: payload?.atr ?? null,
    atrPct: payload?.atrPct ?? null,
    adx: payload?.adx ?? null,
    oiTrend: payload?.oiTrend ?? null,
    oiDeltaBias: payload?.oiDeltaBias ?? null,
    cvdTrend: payload?.cvdTrend ?? null,
    liqClusterBelow: payload?.liqClusterBelow ?? null,
    priceDropPct: payload?.priceDropPct ?? null,
    patternAReady: payload?.patternAReady ?? null,
    patternAWatch: payload?.patternAWatch ?? null,
  });

  STATE.market.symbol = payload?.symbol ?? STATE.market.symbol;
  STATE.market.tf = payload?.tf ?? STATE.market.tf;
  STATE.market.price = payload?.close ?? STATE.market.price;
  STATE.market.time = payload?.time ?? STATE.market.time;

  STATE.meta.barIndex = (STATE.meta.barIndex ?? 0) + 1;
  STATE.meta.lastUpdatedAt = stamp();
}

export function updateContext(patch) {
  mergeInto(STATE.context, patch);
  STATE.context.updatedAt = stamp();
  STATE.meta.lastUpdatedAt = stamp();
}

export function updateBreakoutSetup(patch) {
  mergeInto(STATE.setups.breakout, patch);
  STATE.setups.breakout.updatedAt = stamp();
  STATE.meta.lastUpdatedAt = stamp();
}

export function updateBreakoutValidation(patch) {
  mergeInto(STATE.validation.breakout, patch);
  STATE.validation.breakout.updatedAt = stamp();
  STATE.meta.lastUpdatedAt = stamp();
}

export function updatePosition(patch) {
  mergeInto(STATE.position, patch);
  STATE.meta.lastUpdatedAt = stamp();
}

export function updateExecution(patch) {
  mergeInto(STATE.execution, patch);
  STATE.meta.lastUpdatedAt = stamp();
}
