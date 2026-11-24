'use strict';
// BNB DAILY breakout fast momentum candidate (no order/network calls). Runs only for
// manually armed breakout_retest_reclaim_zone, before the normal retest wait.
// It intentionally does NOT disable the existing retest, shallow-hold or impulse paths.
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function config() { return {
 mode:'shadow', minObservations:2, minSpanSec:12, maxConfirmSec:75,
 moderateChasePct:0.35, strongChasePct:0.65,
 minAdx:25, strongMinAdx:40, minFvvo:0.5, strongMinFvvo:3.0,
 minSlope:0.0, maxRsiModerate:90, maxRsiStrong:97,
 maxStopRiskPct:2.8, maxBelowEma8Pct:0, fiveMinMaxAgeSec:420, requireFresh5mStrong:true,
 }; }
function step(previous, feature, setup, cfg, five) {
 const s=previous || {observations:0,firstAtMs:null,lastAtMs:null,lastPrice:null,emitted:false};
 if (cfg.mode === 'disabled') return {state:s,reason:'DISABLED'};
 const price=n(feature.price), time=n(feature.receivedAtMs), confirm=n(setup.confirm), stop=n(setup.stop), expiry=n(setup.expiry);
 if ([price,time,confirm,stop].some(x=>x===null) || price<=0 || confirm<=0 || stop<=0 || stop>=price) return {state:s,reason:'INVALID_INPUT'};
 if (s.emitted) return {state:s,reason:'ALREADY_EMITTED'};
 if (expiry!==null && time>expiry) return {state:s,reason:'EXPIRED'};
 if (s.lastAtMs!==null && time<=s.lastAtMs) return {state:s,reason:'DUPLICATE_OR_BACKDATED_TICK'};
 if (price<confirm) {s.observations=0;s.firstAtMs=null;s.lastAtMs=time;s.lastPrice=price;return {state:s,reason:'BELOW_CONFIRM'};}
 if (s.firstAtMs===null) s.firstAtMs=time;
 if (time-s.firstAtMs>cfg.maxConfirmSec*1000) return {state:s,reason:'CONFIRM_WINDOW_EXCEEDED'};
 s.observations++; s.lastAtMs=time; const old=s.lastPrice;s.lastPrice=price;
 if (s.observations<cfg.minObservations || time-s.firstAtMs < cfg.minSpanSec*1000) return {state:s,reason:'WAIT_CONFIRMATION'};
 const chase=(price/confirm-1)*100, risk=(price-stop)/price*100;
 const rsi=n(feature.rsi),adx=n(feature.adx),fvvo=n(feature.fvvo),slope=n(feature.slope),ema8=n(feature.ema8),ema18=n(feature.ema18);
 if ([rsi,adx,fvvo,slope,ema8,ema18].some(x=>x===null)) return {state:s,reason:'MISSING_FEATURE'};
 const strong=chase>cfg.moderateChasePct;
 const cap=strong?cfg.strongChasePct:cfg.moderateChasePct;
 if (chase>cap+1e-9) return {state:s,reason:'CHASE_CAP',chase};
 if (risk>cfg.maxStopRiskPct+1e-9) return {state:s,reason:'STOP_RISK_CAP',risk};
 if (adx<(strong?cfg.strongMinAdx:cfg.minAdx) || fvvo<(strong?cfg.strongMinFvvo:cfg.minFvvo) || rsi>(strong?cfg.maxRsiStrong:cfg.maxRsiModerate) || slope<cfg.minSlope || price+1e-9<ema8*(1-cfg.maxBelowEma8Pct/100) || ema8<ema18 || feature.rayRegime==='RAY_BEAR') return {state:s,reason:'MOMENTUM_VETO',rsi,adx,fvvo,slope};
 // Momentum must be rising at the confirming observation. Reject a fast fade.
 if (old!==null && price<old) return {state:s,reason:'PRICE_FADING'};
 const fiveAt=five?n(five.receivedAtMs):null;
 if (strong && cfg.requireFresh5mStrong && (fiveAt===null || fiveAt>time || time-fiveAt>cfg.fiveMinMaxAgeSec*1000)) return {state:s,reason:'MISSING_FRESH_5M_FOR_STRONG_TIER'};
 if (fiveAt!==null && time>=fiveAt && time-fiveAt<=cfg.fiveMinMaxAgeSec*1000 && five.rayRegime==='RAY_BEAR' && n(five.fvvo)!==null && n(five.fvvo)<-1) return {state:s,reason:'FRESH_5M_BEAR_VETO'};
 s.emitted=true;
 return {state:s,reason:'CANDIDATE',candidate:{price,time,chasePct:chase,stopRiskPct:risk,strongTier:strong,rsi,adx,fvvo,slope,observations:s.observations}};
}
module.exports={config,step};
