import { CONFIG } from "./config.js";
import { S, log, saveState } from "./stateStore.js";
import { ageSecAt, clamp, eventMs, pct } from "./utils.js";
import { forward3Commas } from "./executionRouter.js";
const bull4h = (f) => f && f.close >= f.ema18 && f.ema8 >= f.ema18 && f.rsi >= 50 && f.fvvoSlope >= -0.25;
const bull1h = (f) => f && f.close >= f.ema18 && f.ema8 >= f.ema18 && f.rsi >= 52 && f.adx >= 18 && f.fvvo >= -1;
const valid15 = (f) => f && f.close >= f.ema18 && f.rsi >= 50 && f.adx >= 16 && f.fvvoSlope >= -0.3;
const bullRay1h = () => ["BULLISH_TREND_CHANGE", "BULLISH_TREND_CONTINUATION"].includes(S.ray["60"]?.event);
const fresh = (tf, at) => ageSecAt(S.frames[tf]?.time, at) <= ({ "240": CONFIG.FOUR_H_MAX_AGE_SEC, "60": CONFIG.ONE_H_MAX_AGE_SEC, "15": CONFIG.FIFTEEN_M_MAX_AGE_SEC }[tf] || 900);
async function enter(p, mode) {
  const ms = eventMs(p.time); if (S.position || ms - S.lastEnterMs < CONFIG.ENTRY_DEDUP_MS) return;
  const f1 = S.frames["60"], f15 = S.frames["15"]; const atrPct = f1?.atr > 0 ? f1.atr / p.price * 100 : 1.5;
  const stopPct = clamp(atrPct * CONFIG.STOP_ATR_MULT, CONFIG.STOP_MIN_PCT, CONFIG.STOP_MAX_PCT);
  S.position = { entry: p.price, enteredAt: p.time, mode, initialStop: p.price * (1 - stopPct / 100), stop: p.price * (1 - stopPct / 100), initialRiskPct: stopPct, peak: p.price, bars1h: 0, weak15: 0, last1hLow: f1?.low, setupLow: f15?.low };
  S.phase = "LONG"; S.lastEnterMs = ms; S.counters.entries++; log("🟢 ENTRY_SHADOW", { mode, price: p.price, stop: S.position.stop, stopPct }); await forward3Commas("enter_long", p.price, { mode }, p.time);
}
async function exit(p, reason) {
  if (!S.position || eventMs(p.time) - S.lastExitMs < CONFIG.EXIT_DEDUP_MS) return;
  const pos = S.position, gross = pct(pos.entry, p.price), net = gross - CONFIG.FEE_ROUND_TRIP_PCT;
  const trade = { mode: pos.mode, entry: pos.entry, exit: p.price, enteredAt: pos.enteredAt, exitedAt: p.time, grossPct: gross, netPct: net, reason, hours: (eventMs(p.time) - eventMs(pos.enteredAt)) / 3600000 };
  S.trades.push(trade); S.position = null; S.setup = null; S.phase = "FLAT"; S.lastExitMs = eventMs(p.time); S.counters.exits++; log("🔴 EXIT_SHADOW", trade); await forward3Commas("exit_long", p.price, { reason, netPct: net }, p.time);
}
export async function onFeature(p) {
  if (!["5", "15", "60", "240"].includes(p.tf) || !p.confirmed) return;
  S.previous[p.tf] = S.frames[p.tf]; S.frames[p.tf] = p;
  if (p.tf === "240" && !bull4h(p) && !S.position) { S.phase = "FLAT"; S.setup = null; }
  if (p.tf === "60") {
    if (S.position) { S.position.bars1h++; S.position.last1hLow = p.low; if ((p.close < p.ema18 && p.fvvo < 0 && p.fvvoSlope < 0) || (S.ray["60"]?.event === "BEARISH_TREND_CHANGE" && ageSecAt(S.ray["60"].time, p.time) < 5400)) await exit(p, "ONE_H_THESIS_INVALIDATED"); }
    else if (bull4h(S.frames["240"]) && bull1h(p) && bullRay1h()) S.phase = "ARMED_1H";
  }
  if (p.tf === "15" && S.position) { S.position.weak15 = p.close < p.ema18 && p.fvvoSlope < 0 ? S.position.weak15 + 1 : 0; if (S.position.weak15 >= 2 && ageSecAt(S.position.enteredAt, p.time) <= 43200) await exit(p, "EARLY_15M_FAILURE"); }
  if (p.tf === "5" && !S.position && S.setup && ageSecAt(S.setup.armedAt, p.time) <= CONFIG.SETUP_TTL_MIN * 60 && fresh("240", p.time) && fresh("60", p.time) && fresh("15", p.time)) {
    const prev = S.previous["5"], reclaim = p.close >= p.ema8 && p.ema8 >= p.ema18 && p.rsi >= 52 && p.adx >= 14 && p.fvvoSlope >= 0;
    const touched = prev && (prev.low <= prev.ema8 || prev.close <= prev.ema8); const notExtended = p.atr > 0 && (p.close - p.ema8) <= CONFIG.MAX_ENTRY_EXTENSION_ATR * p.atr;
    if (reclaim && notExtended && (S.setup.mode === "breakout_retest" || touched)) await enter(p, S.setup.mode);
  }
  if (S.position) {
    S.position.peak = Math.max(S.position.peak, p.high || p.price); const runup = pct(S.position.entry, S.position.peak), r = S.position.initialRiskPct;
    if (runup >= r) S.position.stop = Math.max(S.position.stop, S.position.entry * (1 + CONFIG.FEE_ROUND_TRIP_PCT / 100));
    if (runup >= 1.5 * r && p.tf === "60") S.position.stop = Math.max(S.position.stop, p.ema18 - 0.5 * p.atr, p.low - 0.25 * p.atr);
    if (ageSecAt(S.position.enteredAt, p.time) >= CONFIG.CAMPAIGN_MAX_HOURS * 3600 && !(bull4h(S.frames["240"]) && bull1h(S.frames["60"]))) await exit(p, "SEVEN_DAY_REVIEW_WEAK");
  }
  saveState();
}
export async function onRay(p) {
  if (!["15", "60"].includes(p.tf)) return; S.ray[p.tf] = p;
  if (p.tf === "60" && p.event === "BEARISH_TREND_CHANGE" && S.position && fresh("60", p.time) && S.frames["60"].close < S.frames["60"].ema18) await exit({ ...p, price: p.price || S.lastPrice }, "ONE_H_RAY_BEAR_CONFIRMED");
  if (!S.position && bull4h(S.frames["240"]) && bull1h(S.frames["60"]) && bullRay1h() && p.tf === "15" && ["BULLISH_TREND_CHANGE", "BULLISH_TREND_CONTINUATION"].includes(p.event) && valid15(S.frames["15"])) {
    S.setup = { mode: p.event === "BULLISH_TREND_CHANGE" ? "pullback_reclaim" : "breakout_retest", armedAt: p.time, rayPrice: p.price }; S.phase = "SETUP_15M"; log("🟡 SETUP_ARMED", S.setup);
  }
  saveState();
}
export async function onTick(p) { S.lastPrice = p.price; S.lastTickAt = p.time; if (S.position) { S.position.peak = Math.max(S.position.peak, p.price); if (p.price <= S.position.stop) await exit(p, "TICK_HARD_OR_TRAILING_STOP"); } saveState(); }
