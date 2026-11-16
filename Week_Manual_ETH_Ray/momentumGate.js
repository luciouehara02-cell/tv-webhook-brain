'use strict';
// Completed 5m feature-clock proxy of rolling 4h price return.
// Rejects unconfirmed, stale, sparse, duplicate and future observations.
const SLOT=300000, WINDOW=48*SLOT;
function create({thresholdPct=1, maxAgeSec=420, enabled=true, shadowOnly=false}={}) {
  let bars=[];
  const config={thresholdPct,maxAgeSec,enabled,shadowOnly};
  function restore(snapshot) {
    bars=[];
    const input=Array.isArray(snapshot?.bars)?snapshot.bars:[];
    for(const b of input) update(b.t,b.price);
  }
  function update(t,price) {
    t=Number(t);price=Number(price);
    if(!Number.isFinite(t)||!Number.isFinite(price)||price<=0||t<1e12||t%SLOT!==0)return {ok:false,reason:'INVALID_5M_BAR'};
    if(bars.length&&t<=bars[bars.length-1].t)return {ok:false,reason:'DUPLICATE_OR_OLDER'};
    if(bars.length&&t-bars[bars.length-1].t!==SLOT) bars=[];
    bars.push({t,price});if(bars.length>49)bars.shift();
    return {ok:true,count:bars.length};
  }
  function decision(at) {
    if(!enabled) return {allowed:true,reason:'DISABLED',count:bars.length};
    at=Number(at);
    const newest=bars[bars.length-1];
    if(!newest||bars.length<49)return {allowed:shadowOnly,reason:'FOUR_HOUR_WARMUP',count:bars.length,required:49,shadowOnly};
    const ageSec=(at-newest.t)/1000;
    if(!Number.isFinite(ageSec)||ageSec < -30||ageSec>maxAgeSec) return {allowed:shadowOnly,reason:'FOUR_HOUR_STALE',ageSec,shadowOnly};
    if(newest.t-bars[0].t!==WINDOW)return {allowed:shadowOnly,reason:'FOUR_HOUR_GAP',shadowOnly};
    const returnPct=100*(newest.price/bars[0].price-1);
    const bearish=returnPct<=-thresholdPct;
    return {allowed:shadowOnly||!bearish,reason:bearish?'FOUR_HOUR_BEARISH':'FOUR_HOUR_CLEAR',returnPct,thresholdPct,ageSec,shadowOnly,barCount:bars.length};
  }
  function snapshot(){return {version:1,bars:bars.slice()};}
  return {update,decision,restore,snapshot,config};
}
module.exports={create};
