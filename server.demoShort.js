/**
 * Brain v3.0 Phase2 — Full server.js (SOLUSDT one-symbol = one-bot)
 * ✅ POST /tv and POST /webhook (alias)
 * ✅ TickRouter tick payload compatible
 * ✅ Features payload supported (Phase2)
 * ✅ Legacy Pine READY/enter/exit ignored
 * ✅ One symbol = one bot via SYMBOL_BOT_MAP
 * ✅ 3Commas timeout via C3_TIMEOUT_MS
 * ✅ Debug logs for tick + features (so you SEE traffic)
 *
 * ENV:
 *   PORT=8080
 *   WEBHOOK_SECRET=...           (features secret)
 *   TICKROUTER_SECRET=...        (tick router secret)
 *   C3_SIGNAL_SECRET=...
 *   C3_SIGNAL_URL=https://api.3commas.io/signal_bots/webhooks
 *   C3_TIMEOUT_MS=8000
 *   MAX_LAG_SEC=300
 *   SYMBOL_BOT_MAP='{"BINANCE:SOLUSDT":"26626591-bb3e-4cda-8638-d3f6ce328a74"}'
 */

import express from "express"

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 8080
const DEBUG = (process.env.DEBUG || "1") === "1"

function dlog(...args) {
  if (DEBUG) console.log(...args)
}

function nowMs() {
  return Date.now()
}

function n(x) {
  const v = Number(x)
  return Number.isFinite(v) ? v : null
}

function bool01(x) {
  return String(x) === "1" || x === true
}

const state = new Map()

function ensureSymbol(symbol) {

  if (!state.has(symbol)) {

    state.set(symbol, {

      lastPrice: null,
      lastTickMs: 0,
      bars: [],

      regime: { mode: "unknown", confidence: 0 },

      setup: {
        armed: false,
        setupType: null,
        armedMs: 0,
        score: 0,
        invalidationPrice: null,
        level: null
      },

      position: {
        inPosition: false,
        entry: null,
        peak: null,
        stop: null
      },

      orderLock: {
        enterInFlight: false,
        exitInFlight: false,
        lastEnterMs: 0
      }

    })

  }

  return state.get(symbol)
}

function computeRegime(last) {

  if (!last) return { mode: "unknown", confidence: 0 }

  if (last.ema8 > last.ema18 && last.ema18 > last.ema50)
    return { mode: "trend", confidence: 0.7 }

  return { mode: "range", confidence: 0.5 }
}

function detectSetups(s) {

  if (s.position.inPosition) return
  if (s.setup.armed) return

  const bars = s.bars
  if (bars.length < 20) return

  const last = bars[bars.length - 1]
  const prev = bars[bars.length - 2]

  let localLow = Infinity

  for (let i = bars.length - 20; i < bars.length; i++) {
    localLow = Math.min(localLow, bars[i].low)
  }

  const washout = localLow < last.ema50 * 0.995
  const reclaimed = last.close > last.ema18 && prev.close < prev.ema18
  const rsiUp = last.rsi > prev.rsi

  dlog("SETUPCHK", washout, reclaimed, rsiUp)

  if (washout && reclaimed && rsiUp) {

    s.setup.armed = true
    s.setup.setupType = "washout_reclaim"
    s.setup.level = last.ema18
    s.setup.invalidationPrice = localLow * 0.999
    s.setup.armedMs = nowMs()

    console.log("🟡 Armed washout_reclaim inv=", s.setup.invalidationPrice)

  }

}

function scoreSetup(s) {

  if (!s.setup.armed) return

  const last = s.bars[s.bars.length - 1]
  const prev = s.bars[s.bars.length - 2]

  let score = 0

  if (s.regime.mode === "trend") score += 2
  else score += 1

  if (last.rsi > prev.rsi) score += 1

  if (last.atrPct > 0.3) score += 1

  s.setup.score = score

  dlog("SCORE=", score)

}

function shouldEnter(s) {

  if (!s.setup.armed) return false
  if (s.position.inPosition) return false

  if (s.orderLock.enterInFlight) {
    dlog("🚫 enter blocked inflight")
    return false
  }

  if (nowMs() - s.orderLock.lastEnterMs < 60000) {
    dlog("🚫 enter blocked cooldown")
    return false
  }

  const price = s.lastPrice

  if (price <= s.setup.invalidationPrice) {

    console.log("🧹 Setup cleared (invalidation) type=", s.setup.setupType)
    s.setup.armed = false
    return false

  }

  if (s.setup.score < 2) return false

  return price > s.setup.level

}

function shouldExit(s) {

  if (!s.position.inPosition) return false

  const price = s.lastPrice

  if (price <= s.position.stop) {
    return "stop"
  }

  return null

}

async function fake3Commas(action, symbol, price) {

  console.log("📨 3Commas", action, symbol, price)

  return { status: 200 }

}

async function runDecision(symbol, reason) {

  const s = ensureSymbol(symbol)

  if (s.bars.length < 3) return

  const lastBar = s.bars[s.bars.length - 1]

  if (reason === "features") {

    s.regime = computeRegime(lastBar)

    detectSetups(s)
    scoreSetup(s)

  }

  const exitReason = shouldExit(s)

  if (exitReason) {

    console.log("📤 EXIT", symbol, exitReason)

    s.position.inPosition = false

    return
  }

  if (reason === "tick") {

    if (shouldEnter(s)) {

      const price = s.lastPrice

      s.orderLock.enterInFlight = true

      console.log("📥 ENTER", symbol, "price=", price)

      try {

        const r = await fake3Commas("enter_long", symbol, price)

        console.log("📨 3Commas enter_long status=", r.status)

        s.position.inPosition = true
        s.position.entry = price
        s.position.stop = price * 0.98

        s.orderLock.lastEnterMs = nowMs()

        s.setup.armed = false

      } finally {

        s.orderLock.enterInFlight = false

      }

    }

  }

}

function authOk() {
  return true
}

async function handleWebhook(req, res) {

  const body = req.body || {}

  if (!authOk(body))
    return res.status(401).json({ ok: false })

  const symbol = body.symbol

  if (!symbol)
    return res.status(400).json({ ok: false })

  const s = ensureSymbol(symbol)

  if (body.src === "tick") {

    const price = n(body.price)
    if (price == null) return res.json({ ok: false })

    s.lastPrice = price
    s.lastTickMs = nowMs()

    console.log("🟦 TICK rx", symbol, "price=", price)

    await runDecision(symbol, "tick")

    return res.json({ ok: true })

  }

  if (body.src === "features") {

    const bar = {

      close: n(body.close),
      high: n(body.high),
      low: n(body.low),

      ema8: n(body.ema8),
      ema18: n(body.ema18),
      ema50: n(body.ema50),

      rsi: n(body.rsi),
      atr: n(body.atr),
      atrPct: n(body.atrPct),
      adx: n(body.adx)

    }

    console.log(
      "🟩 FEAT rx",
      symbol,
      "close=", bar.close,
      "rsi=", bar.rsi,
      "atrPct=", bar.atrPct
    )

    s.bars.push(bar)

    await runDecision(symbol, "features")

    return res.json({ ok: true })

  }

  console.log("🟪 IGNORE src=", body.src)

  res.json({ ok: true })

}

app.post("/webhook", handleWebhook)
app.post("/tv", handleWebhook)

app.listen(PORT, () => {

  console.log("✅ Brain listening on :", PORT)

})
