'use strict';
// Entry-only daily 2-red lock with optional 1H bullish intraday release.
// Uses one 5m price observation per 5m UTC bar. A day is valid iff at least
// 274/288 expected 5m bars including the first and final observations; hourly SMA bars are valid iff all 12 distinct 5m bars seen.
// Green intraday means today's current sampled price > first sampled price;
// this is a *proxy*, not native Binance daily open / OHLCV.
const MS5=300000, H=3600000, D=86400000;
const finite=x=>x!==null&&x!==undefined&&Number.isFinite(Number(x))?Number(x):null;
const freshState=()=>({version:1,phase:'WARMUP',last5mAt:0,day:null,dayBars:0,dayFirst:null,dayLast:null,dayFirstSlot:null,dayLastSlot:null,priorDays:[],hourPending:null,hourHistory:[],lastLockAt:0,lastReleaseAt:0,reason:'STARTUP_WARMUP',lastHourReopenAt:0,historyValidated:false,historyAsOf:0,historySource:null});
const sma=(a,n)=>a.length>=n?a.slice(-n).reduce((x,y)=>x+y,0)/n:null;
function create(opts={}){
 const c={mode:'shadow',greenMinPct:0,releaseType:'sma',releaseConfirmHours:1,require5mBull:true,releaseMin5mRsi:50,requireNoNewLowBars:0,relockBear5mBars:0,cooldownSec:1800,max5mAgeSec:420,failClosedMissingHistory:true,...opts};
 let s=freshState(),recentFive=[],bearConsecutive=0,bullHourConsecutive=0;
 function snapshot(){return JSON.parse(JSON.stringify({...s,recentFive,bearConsecutive,bullHourConsecutive}));}
 function restore(x){s=x&&typeof x==='object'?{...freshState(),...x}:freshState();recentFive=Array.isArray(x?.recentFive)?x.recentFive.slice(-30):[];bearConsecutive=Number(x?.bearConsecutive)||0;bullHourConsecutive=Number(x?.bullHourConsecutive)||0;return context();}
 function context(){return {historyValidated:s.historyValidated,historyAsOf:s.historyAsOf,historySource:s.historySource,phase:s.phase,reason:s.reason,last5mAt:s.last5mAt,day:s.day,dayBars:s.dayBars,priorDays:s.priorDays.slice(-3),hourBars:s.hourHistory.length,lastLockAt:s.lastLockAt,lastReleaseAt:s.lastReleaseAt,bullHourConsecutive};}
 function invalidateHistory(reason='BACKFILL_REQUIRED'){s.historyValidated=false;s.reason=reason;}
 function hydrate(history,at){
  if(!history||!Array.isArray(history.daily)||history.daily.length<7||!Array.isArray(history.hourly)||history.hourly.length<24||!history.currentDay)throw Error('BAD_BACKFILL');
  const days=history.daily.slice(-7).map(k=>({day:k.start,valid:true,red:k.close<k.open,green:k.close>k.open,open:k.open,close:k.close,count:288}));
  for(let i=1;i<days.length;i++)if(days[i].day-days[i-1].day!==D)throw Error('DAILY_GAP');
  if(history.currentDay.start!==Math.floor(at/D)*D)throw Error('CURRENT_DAY_MISMATCH');
  const hours=history.hourly.slice(-30).map(k=>({t:k.start+H,close:k.close}));
  for(let i=1;i<hours.length;i++)if(hours[i].t-hours[i-1].t!==H)throw Error('HOURLY_GAP');
  let lockAt=0;
  for(let i=1;i<days.length;i++)if(days[i-1].red&&days[i].red)lockAt=days[i].day+D;
  // A persisted release after the last known lock can remain open; otherwise lock.
  const validRelease=(s.lastReleaseAt>lockAt&&s.phase==='BULL_RELEASE'&&s.lastReleaseAt<=at);
  const phase=lockAt&&!validRelease?'BEAR_LOCK':s.phase==='BULL_RELEASE'&&validRelease?'BULL_RELEASE':'OPEN';
  s.phase=phase;s.reason=lockAt&&!validRelease?'BACKFILL_TWO_RED_LOCK':'BACKFILL_VALIDATED';
  s.lastLockAt=lockAt||0;
  s.priorDays=days;s.day=history.currentDay.start;s.dayFirst=history.currentDay.open;
  s.dayLast=history.currentDay.close;s.dayBars=0;s.dayFirstSlot=s.day;
  s.dayLastSlot=null;s.hourHistory=hours;s.hourPending=null;
  s.lastHourReopenAt=hours.at(-1).t;
  bullHourConsecutive=0;
  for(let i=17;i<hours.length;i++){
    const prices=hours.slice(0,i+1).map(x=>x.close);
    const ma8=sma(prices,8),ma18=sma(prices,18);
    if(ma8>ma18&&prices.at(-1)>ma18)bullHourConsecutive++;
    else bullHourConsecutive=0;
  }
  recentFive=[];bearConsecutive=0;
  s.historyValidated=true;s.historyAsOf=at;s.historySource=history.provider||'binance';
  return context();
 }
 function needsBackfill(at){return !s.historyValidated||s.day!==Math.floor(at/D)*D;}
 function hourly(){const p=s.hourHistory.map(x=>x.close);const ma8=sma(p,8),ma18=sma(p,18);return {ready:ma8!==null&&ma18!==null,ma8,ma18,price:p.at(-1)||null,bull:ma8!==null&&ma18!==null&&ma8>ma18&&p.at(-1)>ma18};}
 function update(f){
  const t=finite(f.barTimeMs),price=finite(f.price);
  if(t===null||t<=0||price===null||price<=0)return {accepted:false,reason:'INVALID_PRICE_OR_TIME'};
  if(t<=s.last5mAt)return {accepted:false,reason:'DUPLICATE_OR_OLDER'};
  const priorPhase=s.phase,slot=Math.floor(t/MS5)*MS5,day=Math.floor(slot/D)*D,hr=Math.floor(slot/H)*H;
  // Gaps invalidate daily completeness and hourly continuity but do not clear a confirmed lock.
  const continuous=!s.last5mAt||t-s.last5mAt===MS5;
  if(!continuous){s.hourPending=null;s.hourHistory=[];bullHourConsecutive=0;recentFive=[];bearConsecutive=0;}
  if(s.day===null){s.day=day;s.dayBars=0;s.dayFirst=null;s.dayLast=null;s.dayFirstSlot=null;s.dayLastSlot=null;}
  if(day!==s.day){
   const completed=(s.dayBars>=274&&s.dayFirst!==null&&s.dayLast!==null&&s.dayFirstSlot===s.day&&s.dayLastSlot===s.day+D-MS5);
   const daily={day:s.day,valid:completed,red:completed&&s.dayLast<s.dayFirst,green:completed&&s.dayLast>s.dayFirst,open:s.dayFirst,close:s.dayLast,count:s.dayBars};
   // Never infer a 2-day signal across a missing date.
   const prior=s.priorDays.at(-1);
   s.priorDays.push(daily);s.priorDays=s.priorDays.slice(-4);
   if(completed&&daily.red&&prior?.valid&&prior.red&&daily.day-prior.day===D){s.phase='BEAR_LOCK';s.reason='TWO_CONFIRMED_RED_DAYS';s.lastLockAt=day;}
   // A reversal day which closes red must not leave a transient bullish release indefinitely active.
   else if(s.phase==='BULL_RELEASE'&&completed&&daily.red){s.phase='BEAR_LOCK';s.lastLockAt=day;s.reason='RELEASE_DAY_CLOSED_RED';}
   s.day=day;s.dayBars=0;s.dayFirst=null;s.dayLast=null;s.dayFirstSlot=null;s.dayLastSlot=null;
  }
  if(s.dayBars===0&&s.dayFirst===null){s.dayFirst=price;s.dayFirstSlot=slot;}
  s.dayLast=price;s.dayLastSlot=slot;s.dayBars++;s.last5mAt=t;
  const bar={t,price,rsi:finite(f.rsi),fvvo:finite(f.fvvo),slope:finite(f.slope),ema8:finite(f.ema8),ema18:finite(f.ema18),ray:f.rayRegime||''};
  recentFive.push(bar);recentFive=recentFive.slice(-30);
  const bear=bar.ray==='RAY_BEAR'&&bar.ema8!==null&&bar.ema18!==null&&bar.ema8<bar.ema18&&bar.fvvo!==null&&bar.fvvo<0;
  bearConsecutive=bear?bearConsecutive+1:0;
  if(!s.hourPending||s.hourPending.start!==hr){
    if(s.hourPending){const p=s.hourPending;if(p.count===12&&p.last===p.start+11*MS5){s.hourHistory.push({close:p.close,t:p.start+H});s.hourHistory=s.hourHistory.slice(-100);}else{/* partial first hour after Binance bootstrap: skip, preserve valid closed-hour context */}
    }
    s.hourPending={start:hr,count:1,last:slot,close:price};
  }else if(slot>s.hourPending.last){s.hourPending.last=slot;s.hourPending.close=price;s.hourPending.count++;}
  const h=hourly();
  // Hourly confirmation can advance only when a new completed HOUR is available.
  const latestHour=s.hourHistory.at(-1)?.t||0;
  if(latestHour&&latestHour!==s.lastHourReopenAt){s.lastHourReopenAt=latestHour;bullHourConsecutive=h.bull?bullHourConsecutive+1:0;}
  const todayPct=s.dayFirst>0?(price/s.dayFirst-1)*100:0;
  const fiveBull=bar.ema8!==null&&bar.ema18!==null&&bar.ema8>bar.ema18&&bar.rsi!==null&&bar.rsi>=c.releaseMin5mRsi&&bar.fvvo!==null&&bar.fvvo>=0&&bar.ray!=='RAY_BEAR';
  let noLow=true;
  if(c.requireNoNewLowBars>0){const recent=recentFive.slice(-c.requireNoNewLowBars);noLow=recent.length>=c.requireNoNewLowBars&&price>Math.min(...recent.map(x=>x.price));}
  const hourFresh=latestHour>0&&latestHour<=t&&t-latestHour<=2*H;
  const canOpen=hourFresh&&t-s.lastLockAt>=c.cooldownSec*1000&&todayPct>c.greenMinPct&&todayPct>0&&bullHourConsecutive>=c.releaseConfirmHours&&h.bull&&(!c.require5mBull||fiveBull)&&noLow;
  if((s.phase==='BEAR_LOCK'||s.phase==='RECOVERY_WATCH')&&canOpen){s.phase='BULL_RELEASE';s.lastReleaseAt=t;s.reason='INTRADAY_GREEN_1H_SMA_RECOVERY';}
  else if(s.phase==='BEAR_LOCK'&&todayPct>0)s.phase='RECOVERY_WATCH';
  // Avoid chattering between WATCH and LOCK on tiny fluctuations around the daily open.
  if(s.phase==='BULL_RELEASE'&&c.relockBear5mBars>0&&bearConsecutive>=c.relockBear5mBars&&t-s.lastReleaseAt>=c.cooldownSec*1000){s.phase='BEAR_LOCK';s.lastLockAt=t;s.reason='CONFIRMED_5M_RELOCK';}
  // Never auto-open an unvalidated warmup on a feature tick.
  return {accepted:true,changed:priorPhase!==s.phase,...context(),todayPct,hour:h,canOpen};
 }
 function decision(now){if(c.mode==='disabled')return {allowed:true,reason:'DISABLED',phase:s.phase};
  const ageSec=s.last5mAt?(now-s.last5mAt)/1000:Infinity,ready=ageSec>=0&&ageSec<=c.max5mAgeSec;
  const blocking=!s.historyValidated||s.phase==='WARMUP'||s.phase==='BEAR_LOCK'||s.phase==='RECOVERY_WATCH'||(c.failClosedMissingHistory&&!ready);
  return {allowed:c.mode!=='live'||!blocking,wouldAllow:!blocking,phase:s.phase,mode:c.mode,reason:!s.historyValidated?'HISTORY_NOT_VALIDATED':!ready?'FIVE_MINUTE_STALE_OR_MISSING':blocking?'DAILY_BEAR_LOCK':s.phase==='BULL_RELEASE'?'BULL_RELEASE':'NO_DAILY_LOCK',ageSec:Number.isFinite(ageSec)?ageSec:null};
 }
 return {update,decision,restore,snapshot,context,hourly,hydrate,invalidateHistory,needsBackfill,config:c};
}
module.exports={create,sma};
