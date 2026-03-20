const state = {
  meta: {
    brainVersion: "Brain Phase 5 v5.0",
    startedAt: new Date().toISOString(),
    lastEventAt: null,
    lastEventType: null,
    barIndex: 0,
  },

  market: {
    symbol: "BINANCE:SOLUSDT",
    tf: "3",
    price: null,
    time: null,
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
    },
  },

  validation: {
    breakout: {
      allowed: false,
      reasons: [],
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
  },

  execution: {
    lastAction: null,
    lastActionAt: null,
    lastEnteredSetupId: null,
    cooldownUntilBar: null,
  },
};

function touchMeta(eventType) {
  state.meta.lastEventAt = new Date().toISOString();
  state.meta.lastEventType = eventType;
}

export function updateTick(payload) {
  if (payload?.symbol) state.market.symbol = payload.symbol;
  if (payload?.tf) state.market.tf = String(payload.tf);
  if (payload?.price !== undefined) state.market.price = Number(payload.price);
  if (payload?.time) state.market.time = payload.time;
  touchMeta("tick");
}

export function updateFeatures(payload) {
  if (payload?.symbol) state.market.symbol = payload.symbol;
  if (payload?.tf) state.market.tf = String(payload.tf);

  if (payload?.open !== undefined) state.features.open = Number(payload.open);
  if (payload?.high !== undefined) state.features.high = Number(payload.high);
  if (payload?.low !== undefined) state.features.low = Number(payload.low);
  if (payload?.close !== undefined) state.features.close = Number(payload.close);

  if (payload?.ema8 !== undefined) state.features.ema8 = Number(payload.ema8);
  if (payload?.ema18 !== undefined) state.features.ema18 = Number(payload.ema18);
  if (payload?.ema50 !== undefined) state.features.ema50 = Number(payload.ema50);
  if (payload?.rsi !== undefined) state.features.rsi = Number(payload.rsi);
  if (payload?.atr !== undefined) state.features.atr = Number(payload.atr);
  if (payload?.atrPct !== undefined) state.features.atrPct = Number(payload.atrPct);
  if (payload?.adx !== undefined) state.features.adx = Number(payload.adx);

  if (payload?.oiTrend !== undefined) state.features.oiTrend = Number(payload.oiTrend);
  if (payload?.oiDeltaBias !== undefined) state.features.oiDeltaBias = Number(payload.oiDeltaBias);
  if (payload?.cvdTrend !== undefined) state.features.cvdTrend = Number(payload.cvdTrend);
  if (payload?.liqClusterBelow !== undefined) state.features.liqClusterBelow = Number(payload.liqClusterBelow);
  if (payload?.priceDropPct !== undefined) state.features.priceDropPct = Number(payload.priceDropPct);
  if (payload?.patternAReady !== undefined) state.features.patternAReady = Number(payload.patternAReady);
  if (payload?.patternAWatch !== undefined) state.features.patternAWatch = Number(payload.patternAWatch);

  if (payload?.time) state.market.time = payload.time;

  state.meta.barIndex += 1;
  touchMeta("features");
}

export function updateContext(context) {
  state.context = {
    ...state.context,
    ...context,
    updatedAt: new Date().toISOString(),
  };
}

export function updateBreakoutSetup(patch) {
  state.setups.breakout = {
    ...state.setups.breakout,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

export function updateBreakoutValidation(patch) {
  state.validation.breakout = {
    ...state.validation.breakout,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

export function updatePosition(patch) {
  state.position = {
    ...state.position,
    ...patch,
  };
}

export function updateExecution(patch) {
  state.execution = {
    ...state.execution,
    ...patch,
  };
}

export function getState() {
  return state;
}
