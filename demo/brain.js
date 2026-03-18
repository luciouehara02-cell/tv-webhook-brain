import { getState, updateContext, updateFeatures, updateTick } from "./stateStore.js";
import { calculateRegime } from "./regimeEngine.js";
import { CONFIG } from "./config.js";

function formatNum(v, digits = 2) {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "na";
}

function logSnapshot(tag) {
  const s = getState();

  console.log(
    `🧠 ${CONFIG.BRAIN_VERSION} | ${tag} | symbol=${s.market.symbol} tf=${s.market.tf} price=${formatNum(s.market.price, 4)} regime=${s.context.regime} conf=${formatNum(s.context.confidence, 2)} hostile=${s.context.hostile ? 1 : 0}`
  );

  console.log(
    `📊 FEAT | ema8=${formatNum(s.features.ema8, 4)} ema18=${formatNum(s.features.ema18, 4)} ema50=${formatNum(s.features.ema50, 4)} rsi=${formatNum(s.features.rsi, 2)} adx=${formatNum(s.features.adx, 2)} atrPct=${formatNum(s.features.atrPct, 3)} oiTrend=${s.features.oiTrend ?? "na"} cvdTrend=${s.features.cvdTrend ?? "na"}`
  );

  if (s.context.reasons?.length) {
    console.log(`🧭 CONTEXT | reasons=${s.context.reasons.join(", ")}`);
  }
}

export function processEvent(payload) {
  const src = payload?.src;

  if (src === "tick") {
    updateTick(payload);
  } else if (src === "features") {
    updateFeatures(payload);
  } else {
    console.log(`⚠️ Unknown src=${src ?? "undefined"}`);
    return;
  }

  const state = getState();
  const context = calculateRegime(state);
  updateContext(context);

  logSnapshot(src.toUpperCase());
}

export function getBrainState() {
  return getState();
}
