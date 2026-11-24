"use strict";
// BNB daily-swing breakout alternatives. Pure candidate evaluation: NO order placement.
// Time and positions are supplied by the caller; replay and LIVE use identical logic.
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
function pct(a,b) { return a > 0 ? (b/a-1)*100 : Infinity; }
function defaults() { return {
  adaptive:{mode:'shadow', maxMinutes:45, maxChasePct:0.35, minPullbackPct:0.08, bouncePct:0.06, minObservations:2, minSpanSec:12, maxRsi:82, minAdx:24, minFvvo:0.5, minSlope:-0.35, stopCapPct:2.8},
  impulse:{mode:'shadow', maxMinutes:20, maxChasePct:0.85, maxPeakPct:1.6, minPullbackPct:0.12, bouncePct:0.05, minObservations:2, minSpanSec:12, maxRsi:88, minAdx:24, minFvvo:1, minSlope:-0.75, stopCapPct:2.8}
}; }
function step(state, kind, feature, setup, cfg, five) {
  const s=state || {peak:null,low:null,lowAt:0,observations:0,emitted:false};
  const rawTime=num(feature.receivedAtMs), time=rawTime===null?null:Math.max(rawTime,num(setup.breakoutAtMs)||0), price=num(feature.price), confirm=num(setup.confirm), stop=num(setup.stop), high=num(setup.rangeHigh), start=num(setup.breakoutAtMs);
  if(![time,price,confirm,stop,high,start].every(x=>x!==null) || confirm<=0 || price<=0 || price<=stop) return {state:s,reason:'INVALID_INPUT'};
  if(s.emitted) return {state:s,reason:'ALREADY_EMITTED'};
  if(cfg.mode==='disabled') return {state:s,reason:'DISABLED'};
  if(rawTime < start-10000 || time-start > cfg.maxMinutes*60000) return {state:s,reason:'OUTSIDE_WINDOW'};
  if(price<=high) return {state:s,reason:'NORMAL_RETEST_ZONE'};
  s.peak=Math.max(s.peak===null?price:s.peak,price);
  const peakPct=pct(confirm,s.peak), chasePct=pct(confirm,price), stopPct=(price-stop)/price*100;
  if(kind==='impulse' && peakPct>cfg.maxPeakPct) return {state:s,reason:'PEAK_EXCESS',peakPct};
  if(chasePct>cfg.maxChasePct || stopPct>cfg.stopCapPct) return {state:s,reason:chasePct>cfg.maxChasePct?'CHASE_CAP':'STOP_RISK_CAP',chasePct,stopPct};
  const pullback=(s.peak-price)/s.peak*100;
  if(pullback>=cfg.minPullbackPct) {
    if(s.low===null || price<s.low-1e-9) {s.low=price;s.lowAt=time;s.observations=1;}
    else if(time>s.lowAt) s.observations++;
  }
  if(s.low===null) return {state:s,reason:'WAIT_PULLBACK',pullback};
  const bounce=pct(s.low,price);
  if(s.observations<cfg.minObservations || time-s.lowAt<cfg.minSpanSec*1000 || bounce<cfg.bouncePct) return {state:s,reason:'WAIT_RECOVERY',bounce,observations:s.observations};
  const rsi=num(feature.rsi), adx=num(feature.adx),fvvo=num(feature.fvvo),slope=num(feature.slope),ema8=num(feature.ema8),ema18=num(feature.ema18),ray=String(feature.rayRegime||'');
  if([rsi,adx,fvvo,slope,ema8,ema18].some(x=>x===null)||rsi>cfg.maxRsi||adx<cfg.minAdx||fvvo<cfg.minFvvo||slope<cfg.minSlope||price<ema8||ema8<ema18||ray==='RAY_BEAR') return {state:s,reason:'MOMENTUM_VETO',rsi,adx,fvvo,slope};
  // A fresh confirmed 5m strong bear invalidates fast momentum continuation.
  if(five && num(five.receivedAtMs)!==null && time-five.receivedAtMs<=420000 && time>=five.receivedAtMs && String(five.rayRegime)==='RAY_BEAR' && num(five.fvvo)!==null && five.fvvo < -1) return {state:s,reason:'FRESH_5M_BEAR_VETO'};
  s.emitted=true;
  return {state:s,reason:'CANDIDATE',candidate:{kind,price,time,chasePct,stopPct,rsi,adx,fvvo,slope,low:s.low,peak:s.peak,bounce}};
}
module.exports={defaults,step};
