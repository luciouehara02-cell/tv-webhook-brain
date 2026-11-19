'use strict';
// Pure, tick-driven manual setup evaluator. Runtime confirmation state is held on the pending setup.
const pct=(a,b)=>(b/a-1)*100;
const modes=new Set(['breakout_retest_reclaim_zone','trailing_dip_reclaim_zone','confirmed_pullback_reclaim_zone','hybrid_pullback_reclaim_zone']);
function applies(p){return modes.has(p.triggerMode);}
function step(p,f,now,previous,ctx,hybridMode="baseline"){
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
 // v1d: only manually armed Preferred zone modes change. Hybrid improvement is opt-in.
 const preferred=p.entryRole==='preferred'&&!deep&&!breakout;
 const trailingPreferred=preferred&&p.triggerMode==='trailing_dip_reclaim_zone';
 const hybridConservative=preferred&&p.triggerMode==='hybrid_pullback_reclaim_zone'&&hybridMode==='conservative';
 const optimized=trailingPreferred||hybridConservative;
 const bounce=optimized?0.30:deep?0.10:0.05;
 const fresh5m=Boolean(ctx&&Number.isFinite(ctx.receivedAtMs)&&now>=ctx.receivedAtMs&&now-ctx.receivedAtMs<=420000);
 const bear5m=fresh5m&&String(ctx.rayRegime).includes('BEAR');
 const release=Number.isFinite(f.ema8)&&price>=f.ema8&&Number.isFinite(f.slope)&&f.slope>0&&!String(f.rayRegime).includes('BEAR');
 const guardOk=!optimized||!bear5m||(trailingPreferred&&release);
 const prior=s.lastPrice;s.lastPrice=price;
 // A recovery requires non-falling price and either improving oscillator or a price reclaim of EMA8.
 const momentum=f.redPulse!==true&&((Number.isFinite(f.slope)&&f.slope>0)||(Number.isFinite(f.ema8)&&price>=f.ema8));
 const recovered=breakout&&!s.retest?price>=confirm:(pct(s.low,price)>=bounce-1e-9);
 const inRange=price<=chaseBase*(1+chase/100)+1e-9 && (breakout?(!s.retest?price>=confirm:price>=low):price>=low);
 const adequate=momentum&&recovered&&inRange&&price>=prior&&guardOk; // actual stop distance checked by existing engine
 if(!adequate){s.count=0;s.first=null;return result(!inRange?'WAIT_PRICE_WINDOW':!recovered?'WAIT_BOUNCE':!guardOk?'WAIT_PREFERRED_5M_BEAR_GUARD':'WAIT_RECOVERY',{low:s.low,bounceRequiredPct:bounce,bear5m,fresh5m,guardOk});}
 if(!s.count)s.first=stamp;s.count++;
 return result(s.count>=2&&stamp-s.first>=12000?'CONFIRMED':'WAIT_SECOND_TICK',{ready:s.count>=2&&stamp-s.first>=12000,count:s.count,low:s.low,bounceRequiredPct:bounce,bear5m,fresh5m,guardOk});
}
module.exports={applies,step};
