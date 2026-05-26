process.env.BRAIN_NAME = "BrainRAY_Continuation_v6.6d_ATR_STRUCTURE_SYNC_ADAPTIVE_TP_TEST";
process.env.ENABLE_HTTP_FORWARD = "false";
process.env.REPLAY_ALLOW_STALE_DATA = "true";
process.env.REPLAY_USE_EVENT_TIME_FOR_POSITION_CLOCK = "true";
process.env.FORWARD_EXIT_WHEN_FLAT = "false";
process.env.FIRST_ENTRY_ENGINE_ENABLED = "true";
process.env.FIRST_ENTRY_IMMEDIATE_MIN_RSI = "55";
process.env.FIRST_ENTRY_IMMEDIATE_MIN_ADX = "14";
process.env.ATR_STRUCTURE_STOP_ENABLED = "true";
process.env.ATR_STOP_APPLY_FIRST_ENTRY = "true";
process.env.ATR_STRUCTURE_USE_RECENT_LOW = "false";
process.env.DYNAMIC_TP_ADAPTIVE_ENABLED = "true";
process.env.DYNAMIC_TP_ADAPTIVE_LOG = "true";
process.env.DYNAMIC_TP_MIN_GROSS_EXIT_PNL_PCT = "0.35";
process.env.FEE_ROUND_TRIP_PCT = "0.15";
process.env.SLIPPAGE_BUFFER_PCT = "0.05";
process.env.DYNAMIC_TP_MIN_NET_EXIT_PNL_PCT = "0.10";

const { handleWebhook } = await import('./src/brain.js');
const { S } = await import('./src/stateStore.js');

function feature(time, open, high, low, close, ema8, ema18, ema50, rsi, adx, atr, atrPct, oiTrend=1, oiDeltaBias=1, cvdTrend=1, barIndex=0) {
  return { src: 'features', symbol: 'BINANCE:SOLUSDT', tf: '5', time, open, high, low, close, ema8, ema18, ema50, rsi, adx, atr, atrPct, atrReady: true, oiTrend, oiDeltaBias, cvdTrend, patternAReady: 0, patternAWatch: 0 };
}
const events = [
  feature('2026-05-26T10:10:00Z',84.49,84.69,84.48,84.65,84.5098,84.4901,84.4692,59.047,13.631,0.1332,0.157,1,1,-1),
  feature('2026-05-26T10:15:00Z',84.66,85.03,84.66,85.00,84.6188,84.5438,84.49,70.222,14.879,0.1508,0.177,1,1,1),
  { src: 'ray', symbol: 'BINANCE:SOLUSDT', tf: '5', event: 'Bullish Trend Change', price: 85.00, time: '2026-05-26T10:20:02Z' },
  { src: 'tick', symbol: 'BINANCE:SOLUSDT', tf: '5', price: 85.37, time: '2026-05-26T10:27:16Z' }, // +0.435%
  { src: 'tick', symbol: 'BINANCE:SOLUSDT', tf: '5', price: 85.52, time: '2026-05-26T10:29:46Z' }, // +0.612% tier1
  feature('2026-05-26T10:25:00Z',85.06,85.57,85.03,85.55,84.9037,84.6992,84.5534,80.052,19.188,0.1812,0.212,1,1,1),
  { src: 'tick', symbol: 'BINANCE:SOLUSDT', tf: '5', price: 85.79, time: '2026-05-26T10:40:00Z' }, // +0.929% peak
  { src: 'fvvo', symbol: 'BINANCE:SOLUSDT', tf: '5', event: 'Sniper Sell Alert', time: '2026-05-26T11:00:02Z' },
  feature('2026-05-26T11:05:00Z',85.63,85.66,85.54,85.55,85.504,85.233,84.8426,71.356,34.237,0.1704,0.199,-1,-1,1),
  { src: 'tick', symbol: 'BINANCE:SOLUSDT', tf: '5', price: 85.49, time: '2026-05-26T11:12:31Z' }, // +0.576%, should adaptive TP exit
];

for (const e of events) handleWebhook(e);
const lines = S.logs.filter(l => /ENTER_LONG|DYNAMIC_TP|ADAPTIVE_TP|EXIT_LONG|LAUNCH_TP/.test(l));
console.log(lines.join('\n'));
console.log('\nFINAL_STATE', JSON.stringify({ inPosition: S.inPosition, lastExitReason: S.lastExitReason, lastExitClass: S.lastExitClass, peakPnlPct: S.peakPnlPct, adaptiveTp: S.adaptiveTp }, null, 2));
