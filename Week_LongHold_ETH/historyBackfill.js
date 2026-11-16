'use strict';
// Binance public spot-market OHLC candles; no API keys, exchange orders, or credentials.
const DAY=86400000,HOUR=3600000;
const endpoint='https://data-api.binance.vision/api/v3/klines';
function parseKlines(raw,interval,now,minimum){
 const duration=interval==='1d'?DAY:HOUR;
 if(!Array.isArray(raw))throw Error('BAD_KLINE_ARRAY');
 const rows=[];
 for(const k of raw){
  if(!Array.isArray(k)||k.length<7)throw Error('BAD_KLINE_SHAPE');
  const start=Number(k[0]),open=Number(k[1]),high=Number(k[2]),low=Number(k[3]),close=Number(k[4]),end=Number(k[6]);
  if(![start,open,high,low,close,end].every(Number.isFinite)||start<1e12||open<=0||close<=0||high<Math.max(open,close)||low>Math.min(open,close)||low<=0||end!==start+duration-1||start%duration!==0)throw Error('BAD_KLINE_VALUE');
  if(rows.length&&start<=rows.at(-1).start)throw Error('UNORDERED_KLINES');
  rows.push({start,open,high,low,close,end,closed:end<now});
 }
 const done=rows.filter(x=>x.closed);
 if(done.length<minimum)throw Error('INSUFFICIENT_COMPLETED_'+interval.toUpperCase());
 const tail=done.slice(-minimum);
 for(let i=1;i<tail.length;i++)if(tail[i].start-tail[i-1].start!==duration)throw Error('KLINE_GAP_'+interval.toUpperCase());
 if(now-(tail.at(-1).end+1)>duration+60000)throw Error('STALE_KLINE_'+interval.toUpperCase());
 return {completed:done,forming:rows.find(x=>!x.closed)||null};
}
async function request(interval,limit,now,{fetchImpl=fetch,timeoutMs=7000}={}){
 const url=`${endpoint}?symbol=ETHUSDT&interval=${interval}&limit=${limit}`;
 const controller=new AbortController();const tm=setTimeout(()=>controller.abort(),timeoutMs);
 try{const response=await fetchImpl(url,{method:'GET',signal:controller.signal,headers:{accept:'application/json'}});
  if(!response.ok)throw Error('BINANCE_HTTP_'+response.status);
  return parseKlines(await response.json(),interval,now,interval==='1d'?7:24);
 }finally{clearTimeout(tm);}
}
async function backfill(now=Date.now(),options={}){
 const [daily,hourly]=await Promise.all([request('1d',10,now,options),request('1h',32,now,options)]);
 // Require a current, correctly aligned daily candle for the intraday green check.
 const today=Math.floor(now/DAY)*DAY;
 if(!daily.forming||daily.forming.start!==today)throw Error('CURRENT_UTC_DAY_CANDLE_MISSING');
 return {daily:daily.completed.slice(-7),hourly:hourly.completed.slice(-30),currentDay:daily.forming,asOf:now,provider:'Binance public spot market data'};
}
module.exports={backfill,parseKlines,request,endpoint};
