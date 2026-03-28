/**
 * entryEngine.js
 * Brain Phase 5 v5.5
 *
 * LONG ready-entry tightening:
 * - hard block if close below trigger beyond tolerance
 * - hard block if oiTrend <= 0 when flow blocking enabled
 * - keep ema8 > ema18 requirement
 * - keep trend regime requirement
 * - effective score cannot rescue weak reclaim / weak OI setup
 * - backward-compatible export: buildEntryDecision()
 * - do not consume setup unless entry is truly activated / confirmed
 */

export const BRAIN_VERSION = "Brain Phase 5 v5.5";

// ---------------------------
// Helpers
// ---------------------------
function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function boolEnv(name, def = false) {
  const raw = String(process.env[name] ?? (def ? "1" : "0")).trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function numEnv(name, def) {
  const x = Number(process.env[name]);
  return Number.isFinite(x) ? x : def;
}

function pctFrom(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0;
  return ((a - b) / b) * 100;
}

function addUnique(arr, item) {
  if (!arr.includes(item)) arr.push(item);
}

function isTrendRegime(regime) {
  return String(regime || "").toLowerCase() === "trend";
}

// ---------------------------
// Config
// ---------------------------
const DEBUG = boolEnv("DEBUG", true);

const BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE = boolEnv(
  "BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE",
  true
);

const ENTRY_RECLAIM_MIN_PCT = numEnv("ENTRY_RECLAIM_MIN_PCT", 0.05);

const ENTRY_CLOSE_BELOW_TRIGGER_TOL_PCT = numEnv(
  "ENTRY_CLOSE_BELOW_TRIGGER_TOL_PCT",
  0.00
);

const SCORE_ENTER_LONG = numEnv("SCORE_ENTER_LONG", 6);
const ENTER_DEDUP_MS = numEnv("ENTER_DEDUP_MS", 25000);

// ---------------------------
// Logging
// ---------------------------
function dlog(...args) {
  if (DEBUG) console.log(...args);
}

// ---------------------------
// Shared state readers
// ---------------------------
function getTriggerPrice(state = {}) {
  return n(
    state.readyTriggerPrice ??
      state?.setup?.triggerPrice ??
      state?.triggerPrice
  );
}

function getReclaimPct(state = {}, feat = {}) {
  const explicit = state?.reclaimPctFromTrigger ?? state?.setup?.reclaimPctFromTrigger;
  if (Number.isFinite(Number(explicit))) return n(explicit);

  const close = n(feat.close);
  const triggerPrice = getTriggerPrice(state);
  return pctFrom(close, triggerPrice);
}

function getSetupScore(state = {}) {
  return n(state?.setup?.score ?? state?.score ?? 0);
}

// ---------------------------
// Hard gate for LONG ready entry
// ---------------------------
export function canEnterReadyLong({ state = {}, feat = {} }) {
  const reasons = [];

  const close = n(feat.close);
  const ema8 = n(feat.ema8);
  const ema18 = n(feat.ema18);
  const oiTrend = n(feat.oiTrend);
  const regime = String(feat.regime || "range");

  const triggerPrice = getTriggerPrice(state);
  const reclaimPctFromTrigger = getReclaimPct(state, feat);

  const minCloseAllowed =
    triggerPrice * (1 - ENTRY_CLOSE_BELOW_TRIGGER_TOL_PCT / 100);

  // Must be READY long context
  if (!state.readyOn || String(state.readySide || "") !== "long") {
    reasons.push("entry_block_not_ready_long");
  }

  // Must have a valid trigger
  if (!(triggerPrice > 0)) {
    reasons.push("entry_block_missing_trigger");
  }

  // Keep trend regime requirement
  if (!isTrendRegime(regime)) {
    reasons.push("entry_block_not_trend_regime");
  }

  // Keep ema8 > ema18 requirement
  if (!(ema8 > ema18)) {
    reasons.push("entry_block_ema8_not_above_ema18");
  }

  // Hard block: close below trigger
  if (triggerPrice > 0 && close < minCloseAllowed) {
    reasons.push("entry_block_close_below_trigger");
  }

  // Hard block: weak reclaim
  if (reclaimPctFromTrigger < ENTRY_RECLAIM_MIN_PCT) {
    reasons.push("entry_block_reclaim_too_small");
  }

  // Hard block: non-supportive flow
  if (BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE && oiTrend <= 0) {
    reasons.push("entry_block_flow_not_supportive");
  }

  return {
    ok: reasons.length === 0,
    reasons,
    triggerPrice,
    reclaimPctFromTrigger,
    minCloseAllowed
  };
}

// ---------------------------
// Score safety
// ---------------------------
export function getEffectiveEntryScore({ state = {}, feat = {} }) {
  let score = getSetupScore(state);

  const close = n(feat.close);
  const triggerPrice = getTriggerPrice(state);
  const reclaimPctFromTrigger = getReclaimPct(state, feat);
  const oiTrend = n(feat.oiTrend);

  // weak reclaim / weak OI cannot be rescued by score
  if (triggerPrice > 0 && close < triggerPrice) {
    score = Math.min(score, 5);
  }

  if (reclaimPctFromTrigger < ENTRY_RECLAIM_MIN_PCT) {
    score = Math.min(score, 5);
  }

  if (BREAKOUT_BLOCK_IF_FLOW_NOT_SUPPORTIVE && oiTrend <= 0) {
    score = Math.min(score, 5);
  }

  return score;
}

// ---------------------------
// Primary decision function
// ---------------------------
export function decideLongEntry({ state = {}, feat = {}, nowMs = Date.now() }) {
  const gate = canEnterReadyLong({ state, feat });

  const triggerPrice = gate.triggerPrice;
  const close = n(feat.close);
  const oiTrend = n(feat.oiTrend);
  const ema8 = n(feat.ema8);
  const ema18 = n(feat.ema18);
  const regime = String(feat.regime || "range");

  const reasons = [];

  // Hard vetoes first
  if (!gate.ok) {
    for (const r of gate.reasons) addUnique(reasons, r);

    dlog(
      `🚦 ENTRYCHK LONG | close=${close.toFixed(4)} trigger=${triggerPrice.toFixed(4)} ` +
        `reclaimPct=${gate.reclaimPctFromTrigger.toFixed(3)} oiTrend=${oiTrend} ` +
        `ema8=${ema8.toFixed(4)} ema18=${ema18.toFixed(4)} regime=${regime} ` +
        `ok=0 reasons=${reasons.join(",")}`
    );

    return {
      enter: false,
      blocked: true,
      allowed: false,
      side: "long",
      reasons,
      gate,
      score: getEffectiveEntryScore({ state, feat }),
      nowMs
    };
  }

  // Dedupe
  if (n(state.lastEnterAttemptMs) > 0 && nowMs - n(state.lastEnterAttemptMs) < ENTER_DEDUP_MS) {
    addUnique(reasons, "entry_block_dedup");

    return {
      enter: false,
      blocked: true,
      allowed: false,
      side: "long",
      reasons,
      gate,
      score: getEffectiveEntryScore({ state, feat }),
      nowMs
    };
  }

  // Score only after hard structure / flow checks
  const effectiveScore = getEffectiveEntryScore({ state, feat });

  if (effectiveScore < SCORE_ENTER_LONG) {
    addUnique(reasons, "entry_block_score_too_low");

    dlog(
      `🚦 ENTRYCHK LONG | close=${close.toFixed(4)} trigger=${triggerPrice.toFixed(4)} ` +
        `reclaimPct=${gate.reclaimPctFromTrigger.toFixed(3)} oiTrend=${oiTrend} ` +
        `ema8=${ema8.toFixed(4)} ema18=${ema18.toFixed(4)} regime=${regime} ` +
        `ok=0 reasons=${reasons.join(",")} score=${effectiveScore}`
    );

    return {
      enter: false,
      blocked: true,
      allowed: false,
      side: "long",
      reasons,
      gate,
      score: effectiveScore,
      nowMs
    };
  }

  addUnique(reasons, "entry_allowed");

  dlog(
    `🚦 ENTRYCHK LONG | close=${close.toFixed(4)} trigger=${triggerPrice.toFixed(4)} ` +
      `reclaimPct=${gate.reclaimPctFromTrigger.toFixed(3)} oiTrend=${oiTrend} ` +
      `ema8=${ema8.toFixed(4)} ema18=${ema18.toFixed(4)} regime=${regime} ` +
      `ok=1 reasons=${reasons.join(",")} score=${effectiveScore}`
  );

  return {
    enter: true,
    blocked: false,
    allowed: true,
    side: "long",
    reasons,
    gate,
    score: effectiveScore,
    nowMs
  };
}

// ---------------------------
// Backward-compatible export
// entryPolicy.js currently expects this name
// ---------------------------
export function buildEntryDecision(args = {}) {
  return decideLongEntry(args);
}

// ---------------------------
// State transition helpers
// IMPORTANT:
// do not consume setup unless entry truly activated / confirmed
// ---------------------------
export function markEntryAttemptPending({ state = {}, nowMs = Date.now(), plannedPrice }) {
  const next = { ...state };

  next.lastEnterAttemptMs = nowMs;
  next.entryPending = true;
  next.entryPendingSinceMs = nowMs;
  next.entryPlannedPrice = n(plannedPrice);

  // do NOT consume setup here
  // do NOT clear ready here
  // do NOT set inPosition here

  return next;
}

export function markEntryActivated({ state = {}, nowMs = Date.now(), actualPrice }) {
  const next = { ...state };

  next.entryPending = true;
  next.entryActivated = true;
  next.entryActivatedAtMs = nowMs;
  next.entryPrice = n(actualPrice, n(state.entryPlannedPrice));

  // now truly activated
  next.setupConsumed = true;

  return next;
}

export function markPositionConfirmedLong({ state = {}, nowMs = Date.now(), actualPrice }) {
  const next = { ...state };

  next.inPosition = true;
  next.positionSide = "long";
  next.entryPending = false;
  next.entryActivated = true;
  next.entryActivatedAtMs = n(state.entryActivatedAtMs, nowMs);
  next.entryPrice = n(actualPrice, n(state.entryPrice));
  next.positionOpenedAtMs = nowMs;

  next.setupConsumed = true;
  next.readyOn = false;
  next.readySide = null;

  if (next.setup) {
    next.setup = {
      ...next.setup,
      phase: "in_position",
      consumed: true,
      consumedAtMs: nowMs
    };
  }

  return next;
}

export function markEntryFailed({ state = {}, nowMs = Date.now(), reason = "entry_send_failed" }) {
  const next = { ...state };

  next.entryPending = false;
  next.entryActivated = false;
  next.lastEntryFailureAtMs = nowMs;
  next.lastEntryFailureReason = reason;

  // keep setup alive
  next.setupConsumed = false;

  if (next.setup) {
    next.setup = {
      ...next.setup,
      phase: next.readyOn ? "ready" : "watch",
      lastEntryFailureAtMs: nowMs,
      lastEntryFailureReason: reason
    };
  }

  return next;
}

// ---------------------------
// Optional execution helper
// sendEnterLongFn should return { ok: true/false, price? }
// ---------------------------
export async function tryActivateLongEntry({
  state = {},
  feat = {},
  nowMs = Date.now(),
  sendEnterLongFn
}) {
  const decision = decideLongEntry({ state, feat, nowMs });

  if (!decision.enter) {
    return {
      state,
      decision
    };
  }

  let next = markEntryAttemptPending({
    state,
    nowMs,
    plannedPrice: n(feat.close)
  });

  let sendRes = { ok: false };

  try {
    sendRes = await sendEnterLongFn({
      state: next,
      feat,
      decision
    });
  } catch (err) {
    sendRes = {
      ok: false,
      err: err?.message || String(err)
    };
  }

  if (sendRes?.ok) {
    next = markEntryActivated({
      state: next,
      nowMs,
      actualPrice: n(sendRes.price, n(feat.close))
    });
  } else {
    next = markEntryFailed({
      state: next,
      nowMs,
      reason: sendRes?.err || "entry_send_failed"
    });
  }

  return {
    state: next,
    decision,
    sendRes
  };
}

export default {
  BRAIN_VERSION,
  canEnterReadyLong,
  getEffectiveEntryScore,
  decideLongEntry,
  buildEntryDecision,
  markEntryAttemptPending,
  markEntryActivated,
  markPositionConfirmedLong,
  markEntryFailed,
  tryActivateLongEntry
};
