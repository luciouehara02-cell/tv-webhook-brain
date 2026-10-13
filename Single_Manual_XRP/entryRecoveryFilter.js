"use strict";
// Runtime-only sequence state: a restart deliberately requires fresh confirmations.
function createRecoveryFilter(mode) {
  mode=String(mode).trim().toUpperCase();
  if(!['OFF','A','B'].includes(mode)) throw Error('ENTRY_RECOVERY_FILTER_MODE must be off, A or B');
  const states=new Map(); let token=0;
  const applies=p=>['trailing_dip_reclaim','trailing_dip_reclaim_zone','confirmed_pullback_reclaim_zone','hybrid_pullback_reclaim_zone','breakout_retest_reclaim_zone'].includes(p.triggerMode);
  return { mode, begin(){token++;}, end(pendings,feature){
    if(feature.kind!=='FEATURE_TICK_FVVO')return;
    const active=new Set(pendings.map(p=>p.id));
    for(const [id,s] of states)if(!active.has(id)||s.token!==token)states.delete(id);
  }, check(p,f,now,path=""){
    if(mode==='OFF'||!applies(p))return {ok:true,reason:'BYPASS',mode};
    if(f.kind!=='FEATURE_TICK_FVVO')return {ok:false,reason:'TICK_REQUIRED',mode};
    let s=states.get(p.id); if(s && s.path!==path){states.delete(p.id);s=null;} const stamp=Number(f.barTimeMs);
    const valid=Number.isFinite(stamp)&&stamp<=now+2000&&now-stamp<=60000;
    const good=[f.price,f.ema8,f.fvvo,f.slope].every(Number.isFinite)&&f.price>f.ema8&&f.fvvo>=0&&f.slope>0&&(mode==='A'||(Number.isFinite(f.ema18)&&f.price>f.ema18));
    if(!valid||!good){states.delete(p.id);return {ok:false,mode,reason:valid?'RECOVERY_CONDITIONS_FAILED':'STALE_OR_INVALID_TICK'};}
    if(s&&stamp<s.stamp){states.delete(p.id);return {ok:false,mode,reason:"OUT_OF_ORDER_TICK_RESET"};}
    if(s&&stamp===s.stamp){s.token=token;return {ok:false,mode,reason:'DUPLICATE_OR_OUT_OF_ORDER_TICK'};}
    if(!s||now-s.last>45000)s={first:now,count:0,path};
    s.count++;s.last=now;s.stamp=stamp;s.token=token;states.set(p.id,s);
    const ok=s.count>=2&&now-s.first>=12000;
    return {ok,mode,reason:ok?'RECOVERY_CONFIRMED':'WAIT_RECOVERY_CONFIRMATION',observations:s.count,spanMs:now-s.first};
  }};
}
module.exports={createRecoveryFilter};
