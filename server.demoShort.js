/**
 * Brain v3.0 — Phase 2 (No READY in Pine)
 * One symbol = one bot (routes by symbol->bot_uuid map)
 *
 * INPUTS:
 *  - tick (from shared TickRouter):
 *    { secret, src:"tick", symbol, price, time }
 *
 *  - features (bar close snapshot):
 *    { secret, src:"features", symbol, tf, timestamp, close, high, low,
 *      ema8, ema18, ema50, rsi, atr, atrPct, adx, fwo, ray_buy, ray_sell }
 *
 * LEGACY (ignored):
 *  - { action:"ready", ... }
 *  - { src:"enter_long", ... }
 *  - { intent:"exit_long", ... }
 *
 * OUTPUT (Brain -> 3Commas Signal Bot Webhook):
 *  POST https://api.3commas.io/signal_bots/webhooks
 *   {
 *     secret: C3_SIGNAL_SECRET,
 *     bot_uuid: "<uuid>",
 *     max_lag: "300",
 *     timestamp: "<ISO>",
 *     trigger_price: "<string>",
 *     tv_exchange: "BINANCE",
 *     tv_instrument: "SOLUSDT",
 *     action: "enter_long" | "exit_long",
 *     comment: "..."
 *   }
 */

import express from "express";

const PORT = process.env.PORT || 8080;

// Secrets (separate is best)
const BRAIN_SECRET = process.env.WEBHOOK_SECRET || ""; // for features/events
const TICKROUTER_SECRET = process.env.TICKROUTER_SECRET || ""; // for ticks

// 3Commas
const C3_SIGNAL_URL =
  process.env.C3_SIGNAL_URL || "https://api.3commas.io/signal_bots/webhooks";
const C3_SIGNAL_SECRET = process.env.C3_SIGNAL_SECRET || "";
const MAX_LAG_SEC = parseInt(process.env.MAX_LAG_SEC || "300", 10);

// Symbol->Bot map (JSON string)
const SYMBOL_BOT_MAP_RAW = process.env.SYMBOL_BOT_MAP || "{}";
let SYMBOL_BOT_MAP = {};
try {
  SYMBOL_BOT_MAP = JSON.parse(SYMBOL_BOT_MAP_RAW);
} catch {
  console.error("❌ SYMBOL_BOT_MAP is not valid JSON");
  SYMBOL_BOT_MAP = {};
}

// Execution tuning
const TICK_MAX_AGE_SEC = parseInt(process.env.TICK_MAX_AGE_SEC || "60", 10);
const SETUP_TTL_SEC = parseInt(process.env.SETUP_TTL_SEC || "1800", 10);
const COOLDOWN_SEC = parseInt(process.env.COOLDOWN_SEC || "180", 10);

// Score thresholds
const SCORE_ENTER_FULL = parseInt(process.env.SCORE_ENTER_FULL || "7", 10);
const SCORE_ENTER_SMALL = parseInt(process.env.SCORE_ENTER_SMALL || "6", 10);

// Anti-FOMO / pump penalty
const PUMP_BLOCK_PCT = parseFloat(process.env.PUMP_BLOCK_PCT || "1.8");
const PUMP_BLOCK_WINDOW_BARS = parseInt(process.env.PUMP_BLOCK_WINDOW_BARS || "3", 10);

const app = express();
app.use(express.json({ limit: "512kb" }));

// ------------------------
// State
// ------------------------
const state = new Map();

function nowMs() {
  return Date.now();
}

function n(x, fallback = null) {
  const v = Number(x);
  return Number.isFinite(v) ? v : fallback;
}

function bool01(x) {
  return String(x || "0") === "1" || x === true;
}

function ensureSymbol(symbol) {
  if (!state.has(symbol)) {
    state.set(symbol, {
      lastTickMs: 0,
      lastPrice: null,
      bars: [],
      regime: { mode: "unknown", confidence: 0 },

      setup: {
        armed: false,
        setupType: null,
        armedMs: 0,
        ttlMs: SETUP_TTL_SEC * 1000,
        score: 0,
        invalidationPrice: null,
        level: null,
      },

      position: {
        inPosition: false,
        entry: null,
        peak: null,
        stop: null,
        sizeMult: 0,
        enteredMs: 0,
      },

      cooldownUntilMs: 0,

      signals: {
        lastRayBuyMs: 0,
        lastRaySellMs: 0,
        lastFwoRecoverMs: 0,
      },
    });
  }
  return state.get(symbol);
}

function pruneBars(s, maxBars = 600) {
  if (s.bars.length > maxBars) s.bars.splice(0, s.bars.length - maxBars);
}

function isInCooldown(s) {
  return nowMs() < s.cooldownUntilMs;
}

function startCooldown(s, reason) {
  s.cooldownUntilMs = nowMs() + COOLDOWN_SEC * 1000;
  console.log(`⏳ Cooldown started ${COOLDOWN_SEC}s reason=${reason}`);
}

function clearSetup(s, why) {
  if (s.setup.armed) console.log(`🧹 Setup cleared (${why}) type=${s.setup.setupType}`);
  s.setup.armed = false;
  s.setup.setupType = null;
  s.setup.armedMs = 0;
  s.setup.score = 0;
  s.setup.invalidationPrice = null;
  s.setup.level = null;
}

function tvParts(symbol) {
  const [ex, inst] = symbol.includes(":") ? symbol.split(":") : ["BINANCE", symbol];
  return { tv_exchange: ex || "BINANCE", tv_instrument: inst || symbol };
}

function botUuidForSymbol(symbol) {
  return SYMBOL_BOT_MAP[symbol] || null;
}

// ------------------------
// Engines
// ------------------------
function computeRegime(lastBar) {
  const ema8 = lastBar.ema8, ema18 = lastBar.ema18, ema50 = lastBar.ema50;
  const adx = lastBar.adx, atrPct = lastBar.atrPct;

  let score = 0;
  if (ema8 && ema18 && ema50) {
    if (ema8 > ema18 && ema18 > ema50) score += 2;
    const spread = (ema8 - ema50) / ema50;
    if (spread > 0.003) score += 1;
  }
  if (adx && adx >= 18) score += 1;
  if (atrPct && atrPct >= 0.5) score += 1;

  if (score >= 4) return { mode: "trend", confidence: 0.8 };
  if (score >= 3) return { mode: "trend", confidence: 0.6 };
  if (score >= 2) return { mode: "range", confidence: 0.55 };
  return { mode: "range", confidence: 0.4 };
}

function detectSetups(s) {
  if (s.setup.armed) return;
  const bars = s.bars;
  if (bars.length < 60) return;

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];

  // Setup A: washout -> reclaim
  const lookback = 20;
  let localLow = Infinity;
  for (let i = bars.length - lookback; i < bars.length; i++) {
    if (i < 0) continue;
    localLow = Math.min(localLow, bars[i].low);
  }

  const wasBelowEma18 = prev.close < prev.ema18;
  const reclaimed = last.close > last.ema18 && wasBelowEma18;
  const washout = (last.ema50 != null) ? (localLow < last.ema50 * 0.995) : false;
  const rsiUp = (last.rsi != null && prev.rsi != null) ? (last.rsi > prev.rsi) : false;

  if (washout && reclaimed && rsiUp) {
    s.setup.armed = true;
    s.setup.setupType = "washout_reclaim";
    s.setup.armedMs = nowMs();
    s.setup.invalidationPrice = localLow * 0.999;
    s.setup.level = last.ema18;
    console.log(`🟡 Armed washout_reclaim inv=${s.setup.invalidationPrice}`);
    return;
  }

  // Setup B: breakout -> pullback
  if (s.regime.mode === "trend") {
    const swingLb = 30;
    let swingHigh = -Infinity;
    for (let i = bars.length - swingLb; i < bars.length - 1; i++) {
      if (i < 0) continue;
      swingHigh = Math.max(swingHigh, bars[i].high);
    }
    const breakout = last.close > swingHigh;
    if (breakout) {
      s.setup.armed = true;
      s.setup.setupType = "breakout_pullback";
      s.setup.armedMs = nowMs();
      s.setup.level = swingHigh;
      s.setup.invalidationPrice = (last.ema50 != null) ? (last.ema50 * 0.995) : null;
      console.log(`🟡 Armed breakout_pullback level=${s.setup.level}`);
      return;
    }
  }
}

function expireSetup(s) {
  if (!s.setup.armed) return;
  if (nowMs() - s.setup.armedMs > s.setup.ttlMs) clearSetup(s, "ttl");
}

function scoreSetup(s) {
  if (!s.setup.armed) return 0;
  const bars = s.bars;
  if (bars.length < 3) return 0;

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];

  let score = 0;

  // Regime
  if (s.regime.mode === "trend") score += Math.round(3 * s.regime.confidence);
  else score += Math.round(2 * s.regime.confidence);

  // Vol fit
  if (last.atrPct != null) {
    if (last.atrPct >= 0.6) score += 2;
    else if (last.atrPct >= 0.4) score += 1;
  }

  // Fresh Ray buy (best confirmation)
  const freshMs = 5 * 60 * 1000;
  if (nowMs() - s.signals.lastRayBuyMs < freshMs) score += 3;

  // Fresh FWO recover (optional)
  if (nowMs() - s.signals.lastFwoRecoverMs < freshMs) score += 2;

  // Momentum
  if (last.rsi != null && prev.rsi != null && last.rsi > prev.rsi) score += 1;

  // Pump penalty
  const nBars = PUMP_BLOCK_WINDOW_BARS;
  if (bars.length > nBars) {
    const past = bars[bars.length - 1 - nBars];
    const movePct = ((last.close - past.close) / past.close) * 100;
    if (movePct > PUMP_BLOCK_PCT) score -= 3;
  }

  score = Math.max(0, Math.min(10, score));
  s.setup.score = score;
  return score;
}

function sizeFromScore(score) {
  if (score >= SCORE_ENTER_FULL) return 1.0;
  if (score >= SCORE_ENTER_SMALL) return 0.6;
  return 0.0;
}

function canUseTick(s) {
  return s.lastPrice != null && (nowMs() - s.lastTickMs) <= TICK_MAX_AGE_SEC * 1000;
}

function shouldEnter(s) {
  if (!s.setup.armed) return false;
  if (s.position.inPosition) return false;
  if (isInCooldown(s)) return false;
  if (!canUseTick(s)) return false;

  const price = s.lastPrice;
  const last = s.bars[s.bars.length - 1];

  // Invalidation
  if (s.setup.invalidationPrice != null && price <= s.setup.invalidationPrice) {
    clearSetup(s, "invalidation");
    return false;
  }

  // Score
  const score = s.setup.score;
  if (score < SCORE_ENTER_SMALL) return false;

  if (s.setup.setupType === "washout_reclaim") {
    const level = s.setup.level ?? last.ema18;
    if (!level) return false;
    const chasePct = ((price - level) / level) * 100;
    return price > level && chasePct <= 0.25;
  }

  if (s.setup.setupType === "breakout_pullback") {
    const level = s.setup.level;
    if (!level || !last.ema8) return false;
    const nearLevelPct = Math.abs((price - level) / level) * 100;
    const nearEma8Pct = Math.abs((price - last.ema8) / last.ema8) * 100;
    return (nearLevelPct <= 0.20 || nearEma8Pct <= 0.20) && score >= SCORE_ENTER_FULL;
  }

  return false;
}

function exitCheck(s) {
  if (!s.position.inPosition) return null;
  if (!canUseTick(s)) return null;

  const price = s.lastPrice;
  const last = s.bars[s.bars.length - 1];

  // peak
  s.position.peak = Math.max(s.position.peak ?? s.position.entry, price);

  // ATR trailing
  if (last.atr != null && s.position.peak != null) {
    const mult = (s.regime.mode === "trend") ? 2.2 : 1.6;
    const newStop = s.position.peak - last.atr * mult;
    if (s.position.stop == null || newStop > s.position.stop) s.position.stop = newStop;
  }

  if (s.position.stop != null && price <= s.position.stop) return "atr_trail_stop";

  // trend fail
  if (s.regime.mode === "trend" && last.ema8 != null && last.ema18 != null && last.ema8 < last.ema18) {
    return "trend_fail_ema_cross";
  }

  return null;
}

// ------------------------
// 3Commas
// ------------------------
async function post3C({ action, symbol, price, comment }) {
  if (!C3_SIGNAL_SECRET) throw new Error("Missing C3_SIGNAL_SECRET");

  const bot_uuid = botUuidForSymbol(symbol);
  if (!bot_uuid) throw new Error(`No bot_uuid mapping for symbol=${symbol}`);

  const { tv_exchange, tv_instrument } = tvParts(symbol);

  const payload = {
    secret: C3_SIGNAL_SECRET,
    bot_uuid,
    max_lag: String(MAX_LAG_SEC),
    timestamp: new Date().toISOString(),
    trigger_price: String(price),
    tv_exchange,
    tv_instrument,
    action,
    comment,
  };

  const resp = await fetch(C3_SIGNAL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const body = await resp.text();
  return { status: resp.status, body };
}

// ------------------------
// Decision runner
// ------------------------
async function runDecision(symbol) {
  const s = ensureSymbol(symbol);
  if (s.bars.length < 3) return;

  const lastBar = s.bars[s.bars.length - 1];
  s.regime = computeRegime(lastBar);

  expireSetup(s);
  detectSetups(s);
  scoreSetup(s);

  // Exit first
  const exitReason = exitCheck(s);
  if (exitReason) {
    const price = s.lastPrice ?? lastBar.close;
    console.log(`📤 EXIT ${symbol} reason=${exitReason} price=${price}`);
    try {
      const r = await post3C({ action: "exit_long", symbol, price, comment: exitReason });
      console.log(`📨 3Commas exit_long status=${r.status}`);
    } catch (e) {
      console.error("Exit error:", e);
      return;
    }

    s.position = { inPosition: false, entry: null, peak: null, stop: null, sizeMult: 0, enteredMs: 0 };
    clearSetup(s, exitReason);
    startCooldown(s, exitReason);
    return;
  }

  // Entry
  if (shouldEnter(s)) {
    const price = s.lastPrice ?? lastBar.close;
    const sizeMult = sizeFromScore(s.setup.score);
    if (sizeMult <= 0) return;

    const comment = `${s.setup.setupType}|score=${s.setup.score}|reg=${s.regime.mode}`;
    console.log(`📥 ENTER ${symbol} ${comment} price=${price} sizeMult=${sizeMult}`);

    try {
      const r = await post3C({ action: "enter_long", symbol, price, comment });
      console.log(`📨 3Commas enter_long status=${r.status}`);
    } catch (e) {
      console.error("Entry error:", e);
      return;
    }

    s.position.inPosition = true;
    s.position.entry = price;
    s.position.peak = price;
    s.position.sizeMult = sizeMult;
    s.position.enteredMs = nowMs();

    clearSetup(s, "entered");
  }
}

// ------------------------
// Auth
// ------------------------
function authOk(body) {
  if (body?.src === "tick" && TICKROUTER_SECRET) return body.secret === TICKROUTER_SECRET;
  if (body?.src === "features" && BRAIN_SECRET) return body.secret === BRAIN_SECRET;

  // fallback if you only set one secret
  if (BRAIN_SECRET || TICKROUTER_SECRET) return body.secret === (BRAIN_SECRET || TICKROUTER_SECRET);
  return true;
}

// ------------------------
// Routes
// ------------------------
app.get("/", (_, res) => res.json({ ok: true, brain: "v3.0-phase2-symbol-bot" }));

app.post("/tv", async (req, res) => {
  const body = req.body || {};
  if (!authOk(body)) return res.status(401).json({ ok: false, err: "bad secret" });

  const symbol = body.symbol;
  if (!symbol) return res.status(400).json({ ok: false, err: "missing symbol" });

  // Ignore legacy Pine decision messages
  if (body.action === "ready" || body.src === "enter_long" || body.intent === "exit_long") {
    return res.json({ ok: true, ignored: "legacy_pine_decision" });
  }

  const s = ensureSymbol(symbol);

  if (body.src === "tick") {
    const price = n(body.price);
    if (price == null) return res.status(400).json({ ok: false, err: "bad price" });

    s.lastPrice = price;
    s.lastTickMs = nowMs();

    await runDecision(symbol);
    return res.json({ ok: true });
  }

  if (body.src === "features") {
    const timeMs = body.timestamp ? Date.parse(body.timestamp) : (body.time ? Date.parse(body.time) : nowMs());

    const bar = {
      timeMs,
      close: n(body.close),
      high: n(body.high),
      low: n(body.low),

      ema8: n(body.ema8),
      ema18: n(body.ema18),
      ema50: n(body.ema50),

      rsi: n(body.rsi),
      adx: n(body.adx),
      atr: n(body.atr),
      atrPct: n(body.atrPct),

      fwo: n(body.fwo),

      ray_buy: bool01(body.ray_buy),
      ray_sell: bool01(body.ray_sell),
      fwo_recover: bool01(body.fwo_recover),
    };

    if (bar.close == null || bar.high == null || bar.low == null) {
      return res.status(400).json({ ok: false, err: "bad OHLC" });
    }

    s.bars.push(bar);
    pruneBars(s);

    if (bar.ray_buy) s.signals.lastRayBuyMs = nowMs();
    if (bar.ray_sell) s.signals.lastRaySellMs = nowMs();
    if (bar.fwo_recover) s.signals.lastFwoRecoverMs = nowMs();

    if (s.lastPrice == null) s.lastPrice = bar.close;

    await runDecision(symbol);
    return res.json({ ok: true });
  }

  return res.status(400).json({ ok: false, err: "unknown src" });
});

app.listen(PORT, () => {
  console.log(`✅ Brain v3.0 Phase2 listening on :${PORT}`);
  console.log(`🧭 Symbol->Bot map keys: ${Object.keys(SYMBOL_BOT_MAP).length}`);
});
