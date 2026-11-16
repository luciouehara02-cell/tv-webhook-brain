"use strict";
// Deterministic, fail-closed automatic-entry regime guard; never controls exits.
// Inputs are completed 5m feature observations. Only completed 1h/4h buckets
// are used, so no higher timeframe look-ahead is possible.
const MS5 = 300000, HOUR = 3600000, FOUR = 4*HOUR;
const n = x => Number.isFinite(Number(x)) ? Number(x) : null;
const mk = () => ({version:1, phase:"WARMUP", five:[], hour:[], four:[], pendingH:null, pending4:null, lockAt:0, releaseAt:0, last5mAt:0, lastReason:"INITIAL_WARMUP", lastExceptionAt:0});
function ema(values, period) {
 if(values.length < period) return null;
 let e=values.slice(0,period).reduce((a,b)=>a+b,0)/period, k=2/(period+1);
 for(let i=period;i<values.length;i++) e=values[i]*k+e*(1-k);
 return e;
}
function sma(values, period) { if(values.length<period)return null;return values.slice(-period).reduce((a,b)=>a+b,0)/period; }
function maContext(values) {
 const v=values.map(x=>x.price);
 return { ready:v.length>=19, count:v.length, ema8:ema(v,8), ema18:ema(v,18), prevEma8:v.length>=9?ema(v.slice(0,-1),8):null, sma8:sma(v,8), sma18:sma(v,18), price:v.at(-1)??null };
}
function addBucket(archive, pending, item, duration, limit) {
 const bucket=Math.floor(item.t/duration)*duration;
 if(!pending) return {archive,pending:{bucket, t:item.t, price:item.price, count:1, lastFiveBucket:item.t}};
 if(bucket===pending.bucket) { if(item.t>pending.lastFiveBucket) {pending.price=item.price;pending.lastFiveBucket=item.t;pending.count++;} return {archive,pending}; }
 if(bucket<pending.bucket) return {archive,pending};
 // Require a complete bucket with exact expected 5m observations; do not fill gaps.
 const expected=duration/MS5;
 if(pending.count===expected && pending.lastFiveBucket===pending.bucket+duration-MS5) archive.push({t:pending.bucket+duration,price:pending.price});
 else archive=[]; // continuity failure: prevent stale higher-TF confirmation
 return {archive:archive.slice(-limit),pending:{bucket,t:item.t,price:item.price,count:1,lastFiveBucket:item.t}};
}
function create(config={}) {
 const c={mode:"shadow",lockBars:2,releaseBars:3,minRsi:52,minFvvo:0,minSlope:0,cooldownSec:1800,maxAgeSec:420,require1h:true,
   exceptionMode:"shadow",exceptionDropPct:4,exceptionMaxRsi:55,exceptionMinBouncePct:.4,exceptionCooldownSec:14400,
   releaseType:"sma",recoveryBars:2,fastVMode:"shadow",fastVMinRsi5m:52,fastVMinFvvo5m:0,...config};
 let s=mk();
 function restore(raw) { s=raw&&typeof raw==="object"?{...mk(),...raw}:mk();for(const k of ["five","hour","four"])s[k]=Array.isArray(s[k])?s[k].slice(-600):[];return snapshot(); }
 function snapshot(){return JSON.parse(JSON.stringify(s));}
 function context(){return {phase:s.phase,reason:s.lastReason,last5mAt:s.last5mAt,lockAt:s.lockAt,releaseAt:s.releaseAt,
   fiveCount:s.five.length,hour:maContext(s.hour),four:maContext(s.four)};}
 function update(feature) {
   const t=n(feature.barTimeMs),price=n(feature.price);
   if(!(t>0 && price>0))return {accepted:false,reason:"MISSING_TIME_OR_PRICE"};
   if(t<=s.last5mAt)return {accepted:false,reason:"DUPLICATE_OR_OLDER_5M"};
   const bar={t,price,rsi:n(feature.rsi),fvvo:n(feature.fvvo),slope:n(feature.slope),ema8:n(feature.ema8),ema18:n(feature.ema18),ray:feature.rayRegime||""};
   if(s.last5mAt&&t-s.last5mAt>MS5*2) {s.five=[];s.hour=[];s.four=[];s.pendingH=null;s.pending4=null;s.phase="WARMUP";s.lastReason="5M_GAP_RESET";}
   s.last5mAt=t;s.five.push(bar);s.five=s.five.slice(-120);
   const a=addBucket(s.hour,s.pendingH,bar,HOUR,240);s.hour=a.archive;s.pendingH=a.pending;
   const b=addBucket(s.four,s.pending4,bar,FOUR,120);s.four=b.archive;s.pending4=b.pending;
   const bearish=x=>x.ray==="RAY_BEAR"&&x.ema8!==null&&x.ema18!==null&&x.ema8<x.ema18&&x.fvvo!==null&&x.fvvo<0;
   const bullish=x=>x.ray!=="RAY_BEAR"&&x.ema8!==null&&x.ema18!==null&&x.ema8>x.ema18&&x.price>x.ema18&&x.rsi!==null&&x.rsi>=c.minRsi&&x.fvvo!==null&&x.fvvo>=c.minFvvo&&x.slope!==null&&x.slope>=c.minSlope;
   const last=s.five.slice(-c.lockBars),up=s.five.slice(-c.releaseBars);
   const bear=last.length===c.lockBars&&last.every(bearish);
   const bull=up.length===c.releaseBars&&up.every(bullish);
   const h=maContext(s.hour);
   const hourImprove=h.ready && (c.releaseType==="sma"?h.sma8>h.sma18&&h.price>h.sma18:(h.ema8>h.ema18&&h.price>h.ema18));
   const prior=s.phase;
   if(bear && s.phase!=="BEAR_LOCK") {s.phase="BEAR_LOCK";s.lockAt=t;s.lastReason="CONFIRMED_5M_BEAR";}
   else if(s.phase==="BEAR_LOCK"&&bull) {s.phase="RECOVERY_WATCH";s.lastReason="5M_RECOVERY_WATCH";}
   else if(s.phase==="RECOVERY_WATCH"&&bear) {s.phase="BEAR_LOCK";s.lockAt=t;s.lastReason="RECOVERY_FAILED";}
   else if((s.phase==="RECOVERY_WATCH"||s.phase==="BEAR_LOCK"||s.phase==="WARMUP")&&bull&&hourImprove&&t-s.lockAt>=c.cooldownSec*1000) {s.phase="BULL_RELEASE";s.releaseAt=t;s.lastReason="5M_AND_1H_CONFIRMED";}
   else if(s.phase==="BULL_RELEASE"&&bear) {s.phase="BEAR_LOCK";s.lockAt=t;s.lastReason="BULL_RELEASE_REVOKED";}
   // Clean startup: no automatic entry until a bullish release, if gate is enabled LIVE.
   if(s.phase==="WARMUP"&&bear){s.phase="BEAR_LOCK";s.lockAt=t;s.lastReason="INITIAL_BEAR";}
   return {accepted:true,changed:s.phase!==prior,...context(),bull,bear,hourImprove};
 }
 function decision(now,engine,shock=null) {
   if(c.mode==="disabled")return {allowed:true,mode:c.mode,reason:"DISABLED",phase:s.phase};
   const age=s.last5mAt?(now-s.last5mAt)/1000:Infinity;
   const ready=age>=0&&age<=c.maxAgeSec;
   const bull=s.phase==="BULL_RELEASE" && ready;
   let exception=false;
   if(engine==="V_RECOVERY"&&shock&&c.exceptionMode!=="disabled"){
    const drop=n(shock.dropPct),bounce=n(shock.bouncePct),rsi=n(shock.rsi);
    exception=ready&&drop!==null&&drop>=c.exceptionDropPct&&bounce!==null&&bounce>=c.exceptionMinBouncePct&&rsi!==null&&rsi<=c.exceptionMaxRsi&&now-s.lastExceptionAt>=c.exceptionCooldownSec*1000;
   }
   const last=s.five.at(-1);
   const freshFive=last && now-last.t>=0 && now-last.t<=c.maxAgeSec*1000;
   const fastV=engine==="V_RECOVERY"&&ready&&freshFive&&last.ray!=="RAY_BEAR"&&last.rsi!==null&&last.rsi>=c.fastVMinRsi5m&&last.fvvo!==null&&last.fvvo>c.fastVMinFvvo5m&&last.ema8!==null&&last.ema18!==null&&last.ema8>last.ema18&&last.price>last.ema18;
   // An extreme bounce during a very oversold 5m trend may precede 1H bullish MA.
   // Only the existing V-Recovery order path can use this exception.
   exception=exception && freshFive && last.rsi!==null && last.rsi<=35;
   const exceptionActive=exception&&c.exceptionMode==="live";
   const fastActive=fastV&&c.fastVMode==="live";
   const eligible=bull||exceptionActive||fastActive;
   return {allowed:c.mode!=="live"||eligible,wouldAllow:eligible,phase:s.phase,mode:c.mode,reason:!ready?"5M_STALE_OR_MISSING":bull?"BULL_RELEASE":exceptionActive?"EXTREME_SHOCK_EXCEPTION":fastActive?"FAST_5M_BULL_V_RECOVERY":"BEAR_LOCK_OR_WARMUP",exceptionCandidate:exception,fastVCandidate:!!fastV,exceptionMode:c.exceptionMode,fastVMode:c.fastVMode,ageSec:Number.isFinite(age)?age:null};
 }
 function markException(now){s.lastExceptionAt=now;}
 return {config:c,update,decision,markException,restore,snapshot,context};
}
module.exports={create,ema,sma,maContext};
