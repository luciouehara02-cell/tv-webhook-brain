'use strict';
// Pure, tick-driven manual setup evaluator. Runtime confirmation state is held on the pending setup.
const pct=(a,b)=>(b/a-1)*100;
const modes=new Set(['breakout_retest_reclaim_zone','trailing_dip_reclaim_zone','confirmed_pullback_reclaim_zone','hybrid_pullback_reclaim_zone']);
function applies(p){return modes.has(p.triggerMode);}
function step(p,f,now,previous){
 const price=f.price, high=p.activationRangeHigh, low=p.activationRangeLow, confirm=p.breakoutConfirmPrice, stop=p.stopPrice;
 const breakout=p.triggerMode==='breakout_retest_reclaim_zone', deep=p.entryRole==='deep_alternative'||p.triggerMode==='confirmed_pullback_reclaim_zone';
 const s=p.easyEntry||(p.easyEntry={active:false, count:0});
 const result=(reason,extra={})=>({reason,active:s.active,...extra});
 if (![price,high,low,stop,previous].every(Number.isFinite)||high<=low||stop>=low||price<=0) return result('INVALID_LEVELS');
 const stamp=f.barTimeMs;
 if(f.kind!=='FEATURE_TICK_FVVO'||!Number.isFinite(stamp)||stamp>now+2000||now-stamp>60000)return result('WAIT_FRESH_TICK');
 if(Number.isFinite(s.stamp)&&stamp<=s.stamp)return result('DUPLICATE_OR_OLD_TICK');
 const gap=Number.isFinite(s.stamp)&&stamp-s.stamp>45000;
 s.stamp=stamp;
 if(price<=stop && (!breakout || s.active)) return result('STOP_BREACHED',{cancel:true});
 if(gap){s.count=0;s.first=null;s.lastPrice=price;}
 if(!s.active){
  const touched=breakout?Number.isFinite(confirm)&&previous<confirm&&price>=confirm:previous>high&&price<=high;
  if(!touched)return result('WAIT_ACTIVATION');
  Object.assign(s,{active:true,activatedAt:now,low:price,peak:price,count:0,first:null,lastPrice:price,retest:false});
  return result('ACTIVATED');
 }
 if(now-s.activatedAt>7200000){Object.assign(s,{active:false,count:0,first:null});return result('TRACKING_WINDOW_EXPIRED');}
 s.peak=Math.max(s.peak,price);s.low=Math.min(s.low,price);
 if(breakout&&price<confirm)s.retest=true;
 if(breakout&&s.retest&&(s.peak-price)/s.peak*100>1.0){s.count=0;s.first=null;return result("WAIT_BREAKOUT_PULLBACK_LIMIT");}
 const chaseBase=breakout?(s.retest?high:confirm):high;
 const chase=breakout?0.30:0.25;
 const bounce=deep?0.10:0.05;
 const prior=s.lastPrice;s.lastPrice=price;
 // A recovery requires non-falling price and either improving oscillator or a price reclaim of EMA8.
 const momentum=f.redPulse!==true&&((Number.isFinite(f.slope)&&f.slope>0)||(Number.isFinite(f.ema8)&&price>=f.ema8));
 const recovered=breakout&&!s.retest?price>=confirm:(pct(s.low,price)>=bounce-1e-9);
 const inRange=price<=chaseBase*(1+chase/100)+1e-9 && (breakout?(!s.retest?price>=confirm:price>=low):price>=low);
 const adequate=momentum&&recovered&&inRange&&price>=prior; // actual stop distance checked by existing engine
 if(!adequate){s.count=0;s.first=null;return result(!inRange?'WAIT_PRICE_WINDOW':!recovered?'WAIT_BOUNCE':'WAIT_RECOVERY',{low:s.low});}
 if(!s.count)s.first=stamp;s.count++;
 return result(s.count>=2&&stamp-s.first>=12000?'CONFIRMED':'WAIT_SECOND_TICK',{ready:s.count>=2&&stamp-s.first>=12000,count:s.count,low:s.low});
}
module.exports={applies,step};
