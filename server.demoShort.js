//@version=6
indicator("Brain Feature Emitter v1.0 (EMA/RSI/ATR/ADX + TV Flow)", overlay=false, max_bars_back=2000)

// ====================
// Core features
// ====================
ema8  = ta.ema(close, 8)
ema18 = ta.ema(close, 18)
ema50 = ta.ema(close, 50)

rsi = ta.rsi(close, 14)
atr = ta.atr(14)
atrPct = close != 0 ? (atr / close) * 100 : na

adxLen = 14
upMove   = high - high[1]
downMove = low[1] - low
plusDM   = (upMove > downMove and upMove > 0) ? upMove : 0.0
minusDM  = (downMove > upMove and downMove > 0) ? downMove : 0.0
trur     = ta.rma(ta.tr(true), adxLen)
plusDI   = trur != 0 ? 100 * ta.rma(plusDM, adxLen) / trur : na
minusDI  = trur != 0 ? 100 * ta.rma(minusDM, adxLen) / trur : na
dx       = (plusDI + minusDI) != 0 ? 100 * math.abs(plusDI - minusDI) / (plusDI + minusDI) : na
adx      = ta.rma(dx, adxLen)

// ====================
// TV flow proxies
// ====================

// 1) OI trend proxy using participation vs average volume
volAvg20 = ta.sma(volume, 20)
oiTrend = volume > volAvg20 ? 1.0 : 0.0

// 2) OI delta bias proxy using relative volume expansion/contraction
volDeltaPct = volAvg20 > 0 ? ((volume - volAvg20) / volAvg20) * 100 : 0.0
oiDeltaBias =
     volDeltaPct > 25 ? 1.0 :
     volDeltaPct < -15 ? -1.0 : 0.0

// 3) CVD trend proxy
deltaVol =
     close > open ? volume :
     close < open ? -volume : 0.0

cvd = ta.cum(deltaVol)
cvdTrend =
     cvd > cvd[5] ? 1.0 :
     cvd < cvd[5] ? -1.0 : 0.0

// Heartbeat
heartbeat = 1.0

// ====================
// Plot order for webhook placeholders
// ====================
// plot_0  = ema8
// plot_1  = ema18
// plot_2  = ema50
// plot_3  = rsi
// plot_4  = atr
// plot_5  = atrPct
// plot_6  = adx
// plot_7  = oiTrend
// plot_8  = oiDeltaBias
// plot_9  = cvdTrend
// plot_10 = heartbeat

plot(ema8,        "ema8",        display=display.none)
plot(ema18,       "ema18",       display=display.none)
plot(ema50,       "ema50",       display=display.none)
plot(rsi,         "rsi",         display=display.none)
plot(atr,         "atr",         display=display.none)
plot(atrPct,      "atrPct",      display=display.none)
plot(adx,         "adx",         display=display.none)
plot(oiTrend,     "oiTrend",     display=display.none)
plot(oiDeltaBias, "oiDeltaBias", display=display.none)
plot(cvdTrend,    "cvdTrend",    display=display.none)
plot(heartbeat,   "heartbeat",   display=display.none)
