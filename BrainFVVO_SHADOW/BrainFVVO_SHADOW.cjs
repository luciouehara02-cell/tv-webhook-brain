//@version=5
indicator("BrainFVVO_v1e PULSE JSON Publisher", overlay=false, max_labels_count=500)

// ============================================================
// BrainFVVO_v1e PULSE JSON Publisher
// ------------------------------------------------------------
// Purpose:
// - Publishes FEATURE_5M_FVVO JSON to Railway.
// - Uses FVVO Flux Oscillator + Band Mean external sources.
// - Converts red/green candidate sources into active + one-candle pulse fields.
// - Default marker output to legacy fvvoRedDot/fvvoGreenDot is Pulse only.
// - For safest testing with BrainFVVO_v1e JS, keep FVVO_DOT_PULSE_USE_IN_LOGIC=false
//   in Railway so pulses are logged but do not affect entry/exit logic.
// ============================================================

// ------------------------------------------------------------
// General inputs
// ------------------------------------------------------------
secretInput = input.string("BrainFVVO_DEMO_40+CHARS_9f8d7c6b5a4e3d2c1b0a", "Webhook Secret")
brainInput  = input.string("BrainFVVO_v1e_PULSE_JSON_Publisher", "Publisher Name")
srcInput    = input.string("fvvo", "Source")
tfInput     = input.string("5", "Entry TF value sent to brain")

// ------------------------------------------------------------
// Feature inputs
// ------------------------------------------------------------
ema8Len  = input.int(8, "EMA8 Length", minval=1)
ema18Len = input.int(18, "EMA18 Length", minval=1)
ema50Len = input.int(50, "EMA50 Length", minval=1)
rsiLen   = input.int(14, "RSI Length", minval=1)
adxLen   = input.int(14, "ADX Length", minval=1)
adxSmth  = input.int(14, "ADX Smoothing", minval=1)
atrLen   = input.int(14, "ATR Length", minval=1)

// ------------------------------------------------------------
// FVVO source inputs
// Set these to RayAlgo FVVO outputs:
//   Value  = FVVO Oscillator 2.0 [RayAlgo]: Flux Oscillator
//   Signal = FVVO Oscillator 2.0 [RayAlgo]: Band Mean (Hidden)
// ------------------------------------------------------------
fvvoValueSource  = input.source(close, "External FVVO Value Source")
fvvoSignalSource = input.source(close, "External FVVO Signal Source")

// ------------------------------------------------------------
// Candidate red/green source inputs
// Recommended current test mapping:
//   Red   = FVVO Oscillator 2.0 [RayAlgo]: Inner Upper (Flag)
//   Green = FVVO Oscillator 2.0 [RayAlgo]: Inner Lower (Flag)
//   Mode  = Above threshold
//   Threshold = 0.5
// ------------------------------------------------------------
manualFvvoRedDot   = input.bool(false, "Manual fvvoRedDot")
manualFvvoGreenDot = input.bool(false, "Manual fvvoGreenDot")

useExternalRedDotSource = input.bool(true, "Use external Red Dot source")
externalRedDotSource    = input.source(close, "External Red Dot Source")
redDotSourceMode        = input.string("Above threshold", "Red Dot Source Mode", options=["Above threshold", "Below threshold", "Non-zero / non-na"])
redDotThreshold         = input.float(0.5, "Red Dot Threshold")

useExternalGreenDotSource = input.bool(true, "Use external Green Dot source")
externalGreenDotSource    = input.source(close, "External Green Dot / Bullish Marker Source")
greenDotSourceMode        = input.string("Above threshold", "Green Dot Source Mode", options=["Above threshold", "Below threshold", "Non-zero / non-na"])
greenDotThreshold         = input.float(0.5, "Green Dot Threshold")

legacyMarkerOutputMode = input.string("Pulse only", "Legacy fvvoRedDot/fvvoGreenDot output", options=["Disabled", "Pulse only", "Active"])

// Optional manual fields kept for compatibility.
manualSniperBuy    = input.bool(false, "Manual sniperBuy")
manualSniperSell   = input.bool(false, "Manual sniperSell")
manualBurstBullish = input.bool(false, "Manual burstBullish")
manualBurstBearish = input.bool(false, "Manual burstBearish")

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
markerActive(src, mode, threshold) =>
    bool result = false
    if mode == "Above threshold"
        result := not na(src) and src > threshold
    else if mode == "Below threshold"
        result := not na(src) and src < threshold
    else
        result := not na(src) and src != 0
    result

b(v) => v ? "true" : "false"
num(v) => na(v) ? "null" : str.tostring(v)

// ------------------------------------------------------------
// Standard features
// ------------------------------------------------------------
ema8  = ta.ema(close, ema8Len)
ema18 = ta.ema(close, ema18Len)
ema50 = ta.ema(close, ema50Len)
rsi   = ta.rsi(close, rsiLen)
[diPlus, diMinus, adx] = ta.dmi(adxLen, adxSmth)
atr = ta.atr(atrLen)
atrPct = close != 0 ? atr / close * 100.0 : na

// ------------------------------------------------------------
// FVVO value/signal
// ------------------------------------------------------------
fvvoValue  = fvvoValueSource
fvvoSignal = fvvoSignalSource
fvvoSlope  = fvvoValue - fvvoValue[1]
fvvoAboveZero = fvvoValue > 0
fvvoCrossUp   = not na(fvvoValue[1]) and fvvoValue[1] <= 0 and fvvoValue > 0
fvvoCrossDown = not na(fvvoValue[1]) and fvvoValue[1] >= 0 and fvvoValue < 0

// ------------------------------------------------------------
// Dot active + pulse
// ------------------------------------------------------------
fvvoRedActive = useExternalRedDotSource ? markerActive(externalRedDotSource, redDotSourceMode, redDotThreshold) : manualFvvoRedDot
fvvoGreenActive = useExternalGreenDotSource ? markerActive(externalGreenDotSource, greenDotSourceMode, greenDotThreshold) : manualFvvoGreenDot

fvvoRedPulse = fvvoRedActive and not fvvoRedActive[1]
fvvoGreenPulse = fvvoGreenActive and not fvvoGreenActive[1]

fvvoRedDotOut = legacyMarkerOutputMode == "Pulse only" ? fvvoRedPulse : legacyMarkerOutputMode == "Active" ? fvvoRedActive : false
fvvoGreenDotOut = legacyMarkerOutputMode == "Pulse only" ? fvvoGreenPulse : legacyMarkerOutputMode == "Active" ? fvvoGreenActive : false

// Keep legacy color fields disabled by default for safer brain behaviour.
fvvoBullishColorOut = false
fvvoBearishColorOut = false

// ------------------------------------------------------------
// JSON builder
// ------------------------------------------------------------
json = "{" +
     "\"secret\":\"" + secretInput + "\"," +
     "\"src\":\"" + srcInput + "\"," +
     "\"brain\":\"" + brainInput + "\"," +
     "\"version\":\"v1e_pulse\"," +
     "\"symbol\":\"{{exchange}}:{{ticker}}\"," +
     "\"tf\":\"" + tfInput + "\"," +
     "\"event\":\"FEATURE_5M_FVVO\"," +
     "\"price\":" + num(close) + "," +
     "\"time\":\"" + str.tostring(time_close) + "\"," +
     "\"open\":" + num(open) + "," +
     "\"high\":" + num(high) + "," +
     "\"low\":" + num(low) + "," +
     "\"close\":" + num(close) + "," +
     "\"ema8\":" + num(ema8) + "," +
     "\"ema18\":" + num(ema18) + "," +
     "\"ema50\":" + num(ema50) + "," +
     "\"rsi\":" + num(rsi) + "," +
     "\"adx\":" + num(adx) + "," +
     "\"atrPct\":" + num(atrPct) + "," +
     "\"fvvoValue\":" + num(fvvoValue) + "," +
     "\"fvvoSignal\":" + num(fvvoSignal) + "," +
     "\"fvvoSlope\":" + num(fvvoSlope) + "," +
     "\"fvvoAboveZero\":" + b(fvvoAboveZero) + "," +
     "\"fvvoCrossUp\":" + b(fvvoCrossUp) + "," +
     "\"fvvoCrossDown\":" + b(fvvoCrossDown) + "," +
     "\"fvvoRedDot\":" + b(fvvoRedDotOut) + "," +
     "\"fvvoGreenDot\":" + b(fvvoGreenDotOut) + "," +
     "\"fvvoRedActive\":" + b(fvvoRedActive) + "," +
     "\"fvvoGreenActive\":" + b(fvvoGreenActive) + "," +
     "\"fvvoRedPulse\":" + b(fvvoRedPulse) + "," +
     "\"fvvoGreenPulse\":" + b(fvvoGreenPulse) + "," +
     "\"fvvoBullishColor\":" + b(fvvoBullishColorOut) + "," +
     "\"fvvoBearishColor\":" + b(fvvoBearishColorOut) + "," +
     "\"sniperBuy\":" + b(manualSniperBuy) + "," +
     "\"sniperSell\":" + b(manualSniperSell) + "," +
     "\"burstBullish\":" + b(manualBurstBullish) + "," +
     "\"burstBearish\":" + b(manualBurstBearish) +
     "}"

if barstate.isconfirmed
    alert(json, alert.freq_once_per_bar_close)

// ------------------------------------------------------------
// Data-window / visual diagnostics
// ------------------------------------------------------------
plot(fvvoValue, "FVVO Value Sent", display=display.data_window)
plot(fvvoSignal, "FVVO Signal Sent", display=display.data_window)
plot(fvvoSlope, "FVVO Slope Sent", display=display.data_window)

plot(fvvoRedActive ? 1 : 0, "FVVO Red Active Sent", display=display.data_window)
plot(fvvoGreenActive ? -1 : 0, "FVVO Green Active Sent", display=display.data_window)
plot(fvvoRedPulse ? 1 : 0, "FVVO Red Pulse Sent", display=display.data_window)
plot(fvvoGreenPulse ? -1 : 0, "FVVO Green Pulse Sent", display=display.data_window)
plot(fvvoRedDotOut ? 1 : 0, "Legacy FVVO Red Dot Out", display=display.data_window)
plot(fvvoGreenDotOut ? -1 : 0, "Legacy FVVO Green Dot Out", display=display.data_window)

plotshape(fvvoRedPulse, title="RED PULSE", style=shape.triangledown, location=location.top, text="RED", size=size.tiny)
plotshape(fvvoGreenPulse, title="GREEN PULSE", style=shape.triangleup, location=location.bottom, text="GREEN", size=size.tiny)
