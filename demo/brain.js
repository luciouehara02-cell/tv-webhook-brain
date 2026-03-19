import { CONFIG } from "./config.js";
import {
  getState,
  updateBreakoutSetup,
  updateBreakoutValidation,
  updateContext,
  updateFeatures,
  updateTick,
} from "./stateStore.js";
import { calculateRegime } from "./regimeEngine.js";
import { validateBreakout } from "./validationEngine.js";
import { runBreakoutSetup } from "./setupEngine.js";

function formatNum(v, digits = 2) {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "na";
}

function logCore(tag, state) {
  console.log(
    `🧠 ${CONFIG.BRAIN_VERSION} | ${tag} | symbol=${state.market.symbol} tf=${state.market.tf} price=${formatNum(state.market.price, 4)} regime=${state.context.regime} conf=${formatNum(state.context.confidence, 2)} hostile=${state.context.hostile ? 1 : 0}`
  );

  console.log(
    `📊 FEAT | close=${formatNum(state.features.close, 4)} ema8=${formatNum(state.features.ema8, 4)} ema18=${formatNum(state.features.ema18, 4)} ema50=${formatNum(state.features.ema50, 4)} rsi=${formatNum(state.features.rsi, 2)} adx=${formatNum(state.features.adx, 2)} atrPct=${formatNum(state.features.atrPct, 3)} oiTrend=${state.features.oiTrend ?? "na"} cvdTrend=${state.features.cvdTrend ?? "na"}`
  );

  if (state.context.reasons?.length) {
    console.log(`🧭 CONTEXT | reasons=${state.context.reasons.join(", ")}`);
  }
}

function logBreakout(state) {
  const b = state.setups.breakout;
  const v = state.validation.breakout;

  console.log(
    `🟦 BREAKOUT | phase=${b.phase} trigger=${formatNum(b.triggerPrice, 4)} retest=${formatNum(b.retestPrice, 4)} bounce=${formatNum(b.bouncePrice, 4)} score=${b.score} allowed=${v.allowed ? 1 : 0}`
  );

  if (b.reasons?.length) {
    console.log(`🧩 BREAKOUT reasons | ${b.reasons.join(", ")}`);
  }

  if (v.reasons?.length) {
    console.log(`🛡️ VALIDATION | ${v.reasons.join(", ")}`);
  }
}

function logTransition(beforePhase, afterPhase, note) {
  if (beforePhase !== afterPhase) {
    console.log(`🔄 BREAKOUT transition | ${beforePhase} -> ${afterPhase} | ${note}`);
  }
}

export function processEvent(payload) {
  const src = payload?.src;

  if (src === "tick") {
    updateTick(payload);
    const state = getState();
    logCore("TICK", state);
    logBreakout(state);
    return;
  }

  if (src !== "features") {
    console.log(`⚠️ Unknown src=${src ?? "undefined"}`);
    return;
  }

  updateFeatures(payload);

  const state1 = getState();
  const context = calculateRegime(state1);
  updateContext(context);

  const before = getState().setups.breakout.phase;
  const breakoutResult = runBreakoutSetup(getState());

  if (breakoutResult.patch) {
    updateBreakoutSetup(breakoutResult.patch);
  }

  const state2 = getState();

  if (
    state2.setups.breakout.phase === "ready" ||
    state2.setups.breakout.phase === "bounce_confirmed"
  ) {
    const validation = validateBreakout(state2);
    updateBreakoutValidation(validation);
  } else {
    updateBreakoutValidation({
      allowed: false,
      reasons: ["not in entry-capable phase"],
    });
  }

  const state3 = getState();
  const after = state3.setups.breakout.phase;

  logCore("FEATURES", state3);
  console.log(`🔎 SETUP NOTE | ${breakoutResult.note}`);
  logTransition(before, after, breakoutResult.note);
  logBreakout(state3);

  if (CONFIG.LOG_FULL_STATE_ON_TRANSITIONS && before !== after) {
    console.log(
      `📝 STATE SNAPSHOT ${JSON.stringify({
        market: state3.market,
        context: state3.context,
        breakout: state3.setups.breakout,
        validation: state3.validation.breakout,
      })}`
    );
  }
}

export function getBrainState() {
  return getState();
}
