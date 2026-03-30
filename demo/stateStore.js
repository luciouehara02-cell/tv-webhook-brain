import fs from "fs";
import path from "path";
import { CONFIG } from "./config.js";

const STATE_FILE = process.env.BRAIN_STATE_FILE || path.resolve("./brain_state.json");

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
      restoredFromDisk: false,
      stateFile: STATE_FILE,
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

        lastEntryMode: null,
        entryCandidatePrice: null,
      },
    },

    validation: {
      breakout: {
        allowed: false,
        mode: null,
        score: 0,
        chasePct: null,
        reasons: ["not in entry-capable phase"],
        hardReasons: [],
        softReasons: [],
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

      // live sync / recovery
      positionSyncState: "flat",
      pendingLivePosition: null,
      pendingLiveExit: null,
      desyncWarning: null,
      lastPersistedAt: null,
    },

    tick: {
      lastPrice: null,
      lastTime: null,
      count: 0,
    },
  };
}

function stamp() {
  return new Date().toISOString();
}

function mergeInto(target, patch) {
  if (!patch || typeof patch !== "object") return target;
  Object.assign(target, patch);
  return target;
}

function deepMerge(base, saved) {
  const out = structuredClone(base);

  for (const k of Object.keys(saved || {})) {
    if (
      saved[k] &&
      typeof saved[k] === "object" &&
      !Array.isArray(saved[k]) &&
      out[k] &&
      typeof out[k] === "object" &&
      !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(out[k], saved[k]);
    } else {
      out[k] = saved[k];
    }
  }

  return out;
}

function persistState() {
  try {
    const dir = path.dirname(STATE_FILE);
    fs.mkdirSync(dir, { recursive: true });

    const snapshot = structuredClone(STATE);
    snapshot.meta = {
      ...snapshot.meta,
      lastUpdatedAt: stamp(),
    };
    snapshot.execution = {
      ...snapshot.execution,
      lastPersistedAt: stamp(),
    };

    fs.writeFileSync(STATE_FILE, JSON.stringify(snapshot, null, 2), "utf8");
  } catch (err) {
    console.error(`⚠️ STATE PERSIST FAILED | ${err.message}`);
  }
}

function loadPersistedState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return createInitialState();

    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    const merged = deepMerge(createInitialState(), parsed);

    merged.meta = {
      ...merged.meta,
      restoredFromDisk: true,
      stateFile: STATE_FILE,
      lastUpdatedAt: stamp(),
    };

    return merged;
  } catch (err) {
    console.error(`⚠️ STATE RESTORE FAILED | ${err.message}`);
    return createInitialState();
  }
}

let STATE = loadPersistedState();

export function getState() {
  return STATE;
}

export function saveStateNow() {
  persistState();
  return STATE;
}

export function resetState({ deleteFile = false } = {}) {
  STATE = createInitialState();

  if (deleteFile) {
    try {
      if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    } catch (err) {
      console.error(`⚠️ STATE FILE DELETE FAILED | ${err.message}`);
    }
  } else {
    persistState();
  }

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
  persistState();
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
  persistState();
}

export function updateContext(patch) {
  mergeInto(STATE.context, patch);
  STATE.context.updatedAt = stamp();
  STATE.meta.lastUpdatedAt = stamp();
  persistState();
}

export function updateBreakoutSetup(patch) {
  mergeInto(STATE.setups.breakout, patch);
  STATE.setups.breakout.updatedAt = stamp();
  STATE.meta.lastUpdatedAt = stamp();
  persistState();
}

export function updateBreakoutValidation(patch) {
  STATE.validation.breakout = {
    allowed: false,
    mode: null,
    score: 0,
    chasePct: null,
    reasons: [],
    hardReasons: [],
    softReasons: [],
    ...patch,
    updatedAt: stamp(),
  };
  STATE.meta.lastUpdatedAt = stamp();
  persistState();
}

export function updatePosition(patch) {
  mergeInto(STATE.position, patch);
  STATE.meta.lastUpdatedAt = stamp();
  persistState();
}

export function updateExecution(patch) {
  mergeInto(STATE.execution, patch);
  STATE.meta.lastUpdatedAt = stamp();
  persistState();
}

export function markPositionDesync(reason) {
  STATE.execution.desyncWarning = reason;
  STATE.execution.positionSyncState = "desynced";
  STATE.meta.lastUpdatedAt = stamp();
  persistState();
}

export function clearPositionDesync() {
  STATE.execution.desyncWarning = null;
  if (!STATE.position.inPosition) {
    STATE.execution.positionSyncState = "flat";
  }
  STATE.meta.lastUpdatedAt = stamp();
  persistState();
}
