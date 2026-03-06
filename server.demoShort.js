/**
 * Brain v3.0 Phase2 — FULL FIXED server.js (SOLUSDT one-symbol = one-bot)
 * ✅ Duplicate-enter protection (enterInFlight + lastEnterMs)
 * ✅ Duplicate-exit protection (exitInFlight + lastExitMs)
 * ✅ No setup arming while in position
 * ✅ Setup/scoring ONLY on FEATURES (3m)
 * ✅ Tick path ONLY does entry/exit timing
 * ✅ Tick logging throttled to ~3 minutes (configurable)
 * ✅ /tv and /webhook endpoints
 *
 * ENV (recommended)
 *   PORT=8080
 *   DEBUG=1
 *   WEBHOOK_SECRET=...            (features secret)
 *   TICKROUTER_SECRET=...         (tick router secret)
 *   C3_SIGNAL_SECRET=...
 *   C3_SIGNAL_URL=https://api.3commas.io/signal_bots/webhooks
 *   C3_TIMEOUT_MS=8000
 *   MAX_LAG_SEC=300
 *   SYMBOL_BOT_MAP='{"BINANCE:SOLUSDT":"26626591-bb3e-4cda-8638-d3f6ce328a74"}'
 *
 * Optional
 *   TICK_LOG_EVERY_MS=180000      (3 minutes)
 *   ENTER_DEDUP_MS=60000
 *   EXIT_DEDUP_MS=30000
 */

import express from "express";

// ---------------------------
// Config
// ---------------------------
const PORT = process.env.PORT || 8080;

// Debug toggle
const DEBUG = (process.env.DEBUG || "1") === "1";
function dlog(...args) { if (DEBUG) console.log(...args); }

// Tick log throttling (default 3 minutes)
const TICK_LOG_EVERY_MS = parseInt(
  process.env.TICK_LOG_EVERY_MS || String(3 * 60 * 1000),
  10
);

// Secrets
const BRAIN_SECRET = process.env.WEBHOOK_SECRET || "";          // features
const TICKROUTER_SECRET = process.env.TICKROUTER_SECRET || "";  // ticks

// 3Commas
const C3_SIGNAL_URL =
  process.env.C3_SIGNAL_URL || "https://api.3commas.io/signal_bots/webhooks";
const C3_SIGNAL_SECRET = process.env.C3_SIGNAL_SECRET || "";
const C3_TIMEOUT_MS = parseInt(process.env.C3_TIMEOUT_MS || "8000", 10);
const MAX_LAG_SEC = parseInt(process.env.MAX_LAG_SEC || "300", 10);

// Routing: symbol -> bot_uuid (JSON)
let SYMBOL_BOT_MAP = {};
try {
  SYMBOL_BOT_MAP = JSON.parse(process.env.SYMBOL_BOT_MAP || "{}");
} catch (e) {
  console.error("❌ SYMBOL_BOT_MAP invalid JSON:", e?.message || e);
  SYMBOL_BOT_MAP = {};
}

// Decision tuning
const TICK_MAX_AGE_SEC = parseInt(process.env.TICK_MAX_AGE_SEC || "60", 10);
const SETUP_TTL_SEC = parseInt(process.env.SETUP_TTL_SEC || "1800", 10);
const COOLDOWN_SEC = parseInt(process.env.COOLDOWN_SEC || "180", 10);

const SCORE_ENTER_SMALL = parseInt(process.env.SCORE_ENTER_SMALL || "6", 10);
const SCORE_ENTER_FULL = parseInt(process.env.SCORE_ENTER_FULL || "7", 10);

const PUMP_BLOCK_PCT = parseFloat(process.env.PUMP_BLOCK_PCT || "1.8");
const PUMP_BLOCK_WINDOW_BARS = parseInt(process.env.PUMP_BLOCK_WINDOW_BARS || "3", 10);

const ENTER_DEDUP_MS = parseInt(process.env.ENTER_DEDUP_MS || "60000", 10);
const EXIT_DEDUP_MS = parseInt(process.env.EXIT_DEDUP_MS || "30000", 10);

// ---------------------------
// App
// ---------------------------
const app = express();
app.use(express.json({ limit: "512kb" }));

// ---------------------------
// State
// ---------------------------
const state = new Map();

function nowMs() { return Date.now(); }

function n(x, fallback = null) {
  const v = Number(x);
  return Number.isFinite(v) ? v : fallback;
}

function bool01(x) {
  return String(x || "0") === "1" || x === true;
}

function recently(ts, windowMs) {
  return ts > 0 && (nowMs() - ts) < windowMs;
}

function tvParts(symbol) {
  const [ex, inst] = symbol.includes(":") ? symbol.split(":") : ["BINANCE", symbol];
  return { tv_exchange: ex || "BINANCE", tv_instrument: inst || symbol };
}

function botUuidForSymbol(symbol) {
  return SYMBOL_BOT_MAP?.[symbol] || null;
}

function ensureSymbol(symbol) {
  if (!state.has(symbol)) {
    state.set(symbol, {
      lastTickMs: 0,
      lastPrice: null,
      tickCount: 0,

      // tick log throttle
      lastTickLogMs: 0,

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

      // protects against duplicate enter/exit posts
      orderLock: {
        enterInFlight: false,
        exitInFlight: false,
        lastEnterMs: 0,
        lastExitMs: 0,
      },
    });
  }
  return state.get(symbol);
}

function pruneBars(s, maxBars = 800) {
  if (s.bars.length > maxBars) s.bars.splice(0, s.bars.length - maxBars);
}

function isInCooldown(s) {
  return nowMs() < s.cooldownUntilMs;
}

function startCooldown(s, reason) {
  s.cooldownUntilMs = nowMs() + COOLDOWN_SEC * 1000;
  console.log(`⏳ Cooldown ${COOLDOWN_SEC}s reason=${reason}`);
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

function canUseTick(s) {
  return s.lastPrice != null && (nowMs() - s.lastTickMs) <= TICK_MAX_AGE_SEC * 1000;
}

// ---------------------------
// Engines
// ---------------------------
function computeRegime(lastBar) {
  const ema8 = lastBar.ema8, ema18 = lastBar.ema18, ema50 = lastBar.ema50;
  const adx = lastBar.adx, atrPct = lastBar.atrPct;

  let score = 0;
  if (ema8 != null && ema18 != null && ema50 != null) {
    if (ema8 > ema18 && ema18 > ema50) score += 2;
    const spread = (ema8 - ema50) / ema50;
    if (spread > 0.003) score += 1;
  }
  if (adx != null && adx >= 18) score += 1;
  if (atrPct != null && atrPct >= 0.5) score += 1;

  if (score >= 4) return { mode: "trend", confidence: 0.8 };
  if (score >= 3) return { mode: "trend", confidence: 0.6 };
  if (score >= 2) return { mode: "range", confidence: 0.55 };
  return { mode: "range", confidence: 0.4 };
}

function detectSetups(s) {
  // ✅ FIX: never arm setups while in position
  if (s.position.inPosition) {
    dlog("⏭️ detectSetups skipped: already in position");
    return;
  }
  if (s.setup.armed) return;

  const bars = s.bars;
  if (bars.length < 60) {
    dlog(`⏳ detectSetups waiting bars=${bars.length}/60`);
    return;
  }

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];

  // Setup A: Washout -> Reclaim
  const lookback = 20;
  let localLow = Infinity;
  for (let i = bars.length - lookback; i < bars.length; i++) {
    if (i < 0) continue;
    localLow = Math.min(localLow, bars[i].low);
  }

  const canUseEma = (last.ema18 != null && prev.ema18 != null);
  const wasBelowEma18 = canUseEma ? (prev.close < prev.ema18) : false;
  const reclaimed = canUseEma ? (last.close > last.ema18 && wasBelowEma18) : false;

  const washout = (last.ema50 != null) ? (localLow < last.ema50 * 0.995) : false;
  const rsiUp = (last.rsi != null && prev.rsi != null) ? (last.rsi > prev.rsi) : false;

  dlog(
    `🔎 SETUPCHK localLow=${Number.isFinite(localLow) ? localLow.toFixed(4) : localLow} ` +
    `ema50=${last.ema50 != null ? last.ema50.toFixed(4) : "null"} ` +
    `washout=${washout ? 1 : 0} reclaimed=${reclaimed ? 1 : 0} rsiUp=${rsiUp ? 1 : 0} ` +
    `prevClose=${prev.close} lastClose=${last.close}`
  );

  if (washout && reclaimed && rsiUp) {
    s.setup.armed = true;
    s.setup.setupType = "washout_reclaim";
    s.setup.armedMs = nowMs();
    s.setup.invalidationPrice = localLow * 0.999;
    s.setup.level = last.ema18;
    console.log(`🟡 Armed washout_reclaim inv=${s.setup.invalidationPrice}`);
    return;
  }

  // Setup B: Breakout -> Pullback
  if (s.regime.mode === "trend") {
    const swingLb = 30;
    let swingHigh = -Infinity;
    for (let i = bars.length - swingLb; i < bars.length - 1; i++) {
      if (i < 0) continue;
      swingHigh = Math.max(swingHigh, bars[i].high);
    }
    const breakout = last.close > swingHigh;

    dlog(
      `🔎 BRKCHK swingHigh=${Number.isFinite(swingHigh) ? swingHigh.toFixed(4) : swingHigh} breakout=${breakout ? 1 : 0}`
    );

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
  const ageMs = nowMs() - s.setup.armedMs;
  if (ageMs > s.setup.ttlMs) {
    dlog(`⌛ Setup TTL expired ageSec=${(ageMs / 1000).toFixed(0)}`);
    clearSetup(s, "ttl");
  }
}

function scoreSetup(s) {
  if (!s.setup.armed) return 0;
  const bars = s.bars;
  if (bars.length < 3) return 0;

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];

  let score = 0;
  const add = (nn, label) => {
    score += nn;
    dlog(`   ➕ ${label} +${nn} => ${score}`);
  };

  dlog(`📊 SCORE start type=${s.setup.setupType} reg=${s.regime.mode} conf=${s.regime.confidence}`);

  if (s.regime.mode === "trend") add(Math.round(3 * s.regime.confidence), "regime(trend)");
  else add(Math.round(2 * s.regime.confidence), "regime(range)");

  if (last.atrPct != null) {
    if (last.atrPct >= 0.6) add(2, "atrPct>=0.6");
    else if (last.atrPct >= 0.4) add(1, "atrPct>=0.4");
    else dlog(`   ➕ atrPct low (0) atrPct=${last.atrPct}`);
  } else {
    dlog(`   ➕ atrPct missing (0)`);
  }

  const freshMs = 5 * 60 * 1000;
  if (nowMs() - s.signals.lastRayBuyMs < freshMs) add(3, "fresh ray_buy");
  if (nowMs() - s.signals.lastFwoRecoverMs < freshMs) add(2, "fresh fwo_recover");

  if (last.rsi != null && prev.rsi != null && last.rsi > prev.rsi) add(1, "rsi rising");
  else dlog(`   ➕ rsi not rising (0) last=${last.rsi} prev=${prev.rsi}`);

  const nBars = PUMP_BLOCK_WINDOW_BARS;
  if (bars.length > nBars) {
    const past = bars[bars.length - 1 - nBars];
    const movePct = ((last.close - past.close) / past.close) * 100;
    if (movePct > PUMP_BLOCK_PCT) {
      score -= 3;
      dlog(`   ➖ pump penalty movePct=${movePct.toFixed(2)}% -3 => ${score}`);
    }
  }

  score = Math.max(0, Math.min(10, score));
  s.setup.score = score;
  dlog(`📊 SCORE final=${score}`);
  return score;
}

function sizeFromScore(score) {
  if (score >= SCORE_ENTER_FULL) return 1.0;
  if (score >= SCORE_ENTER_SMALL) return 0.6;
  return 0.0;
}

function shouldEnter(s) {
  if (!s.setup.armed) return false;
  if (s.position.inPosition) return false;
  if (isInCooldown(s)) return false;
  if (!canUseTick(s)) return false;

  // ✅ FIX: hard dedup + inflight lock
  if (s.orderLock.enterInFlight) return false;
  if (recently(s.orderLock.lastEnterMs, ENTER_DEDUP_MS)) return false;

  const price = s.lastPrice;
  const last = s.bars[s.bars.length - 1];

  if (s.setup.invalidationPrice != null && price <= s.setup.invalidationPrice) {
    clearSetup(s, "invalidation");
    return false;
  }

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
    if (!level || last.ema8 == null) return false;
    const nearLevelPct = Math.abs((price - level) / level) * 100;
    const nearEma8Pct = Math.abs((price - last.ema8) / last.ema8) * 100;
    return (nearLevelPct <= 0.20 || nearEma8Pct <= 0.20) && score >= SCORE_ENTER_FULL;
  }

  return false;
}

function exitCheck(s) {
  if (!s.position.inPosition) return null;
  if (!canUseTick(s)) return null;

  // ✅ FIX: hard dedup + inflight lock
  if (s.orderLock.exitInFlight) return null;
  if (recently(s.orderLock.lastExitMs, EXIT_DEDUP_MS)) return null;

  const price = s.lastPrice;
  const last = s.bars[s.bars.length - 1];

  s.position.peak = Math.max(s.position.peak ?? s.position.entry, price);

  if (last.atr != null && s.position.peak != null) {
    const mult = (s.regime.mode === "trend") ? 2.2 : 1.6;
    const newStop = s.position.peak - last.atr * mult;
    if (s.position.stop == null || newStop > s.position.stop) s.position.stop = newStop;
  }

  if (s.position.stop != null && price <= s.position.stop) return "atr_trail_stop";

  if (s.regime.mode === "trend" && last.ema8 != null && last.ema18 != null && last.ema8 < last.ema18) {
    return "trend_fail_ema_cross";
  }

  return null;
}

// ---------------------------
// 3Commas sender
// ---------------------------
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), C3_TIMEOUT_MS);

  try {
    const resp = await fetch(C3_SIGNAL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const body = await resp.text();
    return { status: resp.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------
// Main decision runner
// ---------------------------
async function runDecision(symbol, source) {
  const s = ensureSymbol(symbol);
  if (s.bars.length < 3) return;

  const lastBar = s.bars[s.bars.length - 1];

  // ✅ FIX: only FEATURES updates regime/setup/score
  if (source === "features") {
    s.regime = computeRegime(lastBar);
    dlog(`🧭 REGIME ${symbol} mode=${s.regime.mode} conf=${s.regime.confidence}`);
    expireSetup(s);
    detectSetups(s);
    scoreSetup(s);
  }

  // exits can be checked on both tick + features
  const exitReason = exitCheck(s);
  if (exitReason) {
    const price = s.lastPrice ?? lastBar.close;

    if (s.orderLock.exitInFlight) return;
    if (recently(s.orderLock.lastExitMs, EXIT_DEDUP_MS)) return;

    s.orderLock.exitInFlight = true;

    console.log(`📤 EXIT ${symbol} reason=${exitReason} price=${price}`);
    try {
      const r = await post3C({ action: "exit_long", symbol, price, comment: exitReason });
      console.log(`📨 3Commas exit_long status=${r.status}`);
      s.orderLock.lastExitMs = nowMs();
    } catch (e) {
      console.error("Exit error:", e?.message || e);
      return;
    } finally {
      s.orderLock.exitInFlight = false;
    }

    s.position = { inPosition: false, entry: null, peak: null, stop: null, sizeMult: 0, enteredMs: 0 };
    clearSetup(s, exitReason);
    startCooldown(s, exitReason);
    return;
  }

  // ✅ FIX: only TICK triggers entry timing
  if (source !== "tick") return;

  if (shouldEnter(s)) {
    const price = s.lastPrice ?? lastBar.close;
    const sizeMult = sizeFromScore(s.setup.score);
    if (sizeMult <= 0) return;

    if (s.orderLock.enterInFlight) return;
    if (recently(s.orderLock.lastEnterMs, ENTER_DEDUP_MS)) return;

    s.orderLock.enterInFlight = true;

    const comment = `${s.setup.setupType}|score=${s.setup.score}|reg=${s.regime.mode}`;
    console.log(`📥 ENTER ${symbol} ${comment} price=${price} sizeMult=${sizeMult}`);

    try {
      const r = await post3C({ action: "enter_long", symbol, price, comment });
      console.log(`📨 3Commas enter_long status=${r.status}`);
      s.orderLock.lastEnterMs = nowMs();
    } catch (e) {
      console.error("Entry error:", e?.message || e);
      return;
    } finally {
      s.orderLock.enterInFlight = false;
    }

    s.position.inPosition = true;
    s.position.entry = price;
    s.position.peak = price;
    s.position.sizeMult = sizeMult;
    s.position.enteredMs = nowMs();

    clearSetup(s, "entered");
  }
}

// ---------------------------
// Auth
// ---------------------------
function authOk(body) {
  if (body?.src === "tick" && TICKROUTER_SECRET) return body.secret === TICKROUTER_SECRET;
  if (body?.src === "features" && BRAIN_SECRET) return body.secret === BRAIN_SECRET;
  if (BRAIN_SECRET || TICKROUTER_SECRET) return body.secret === (BRAIN_SECRET || TICKROUTER_SECRET);
  return true;
}

// ---------------------------
// Webhook handler
// ---------------------------
async function handleWebhook(req, res) {
  try {
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
      s.tickCount++;

      // ✅ Throttled tick printing (default 3m)
      const now = nowMs();
      if ((now - (s.lastTickLogMs || 0)) >= TICK_LOG_EVERY_MS) {
        console.log(`🟦 TICK(3m) ${symbol} price=${price} time=${body.time || body.timestamp || ""}`);
        s.lastTickLogMs = now;
      } else {
        dlog(`🟦 tick ${symbol} price=${price}`);
      }

      await runDecision(symbol, "tick");
      return res.json({ ok: true });
    }

    if (body.src === "features") {
      const timeMs =
        body.timestamp ? Date.parse(body.timestamp) :
        body.time ? Date.parse(body.time) :
        nowMs();

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

      console.log(
        `🟩 FEAT rx ${symbol} tf=${body.tf || ""} close=${bar.close} rsi=${bar.rsi} atrPct=${bar.atrPct} ray_buy=${bar.ray_buy ? 1 : 0}`
      );

      s.bars.push(bar);
      pruneBars(s);

      if (bar.ray_buy) s.signals.lastRayBuyMs = nowMs();
      if (bar.ray_sell) s.signals.lastRaySellMs = nowMs();
      if (bar.fwo_recover) s.signals.lastFwoRecoverMs = nowMs();

      if (s.lastPrice == null) s.lastPrice = bar.close;

      await runDecision(symbol, "features");
      return res.json({ ok: true });
    }

    // Ignore unknown src to avoid noise
    console.log(`🟪 IGNORE src=${body.src} symbol=${symbol}`);
    return res.json({ ok: true, ignored: "src_not_supported" });
  } catch (e) {
    console.error("handleWebhook error:", e?.stack || e);
    return res.status(500).json({ ok: false, err: "server error" });
  }
}

// ---------------------------
// Routes
// ---------------------------
app.get("/", (_, res) => {
  res.json({
    ok: true,
    brain: "v3.0-phase2-full-fixed+tick-throttle",
    symbolsMapped: Object.keys(SYMBOL_BOT_MAP).length,
    hasBrainSecret: Boolean(BRAIN_SECRET),
    hasTickRouterSecret: Boolean(TICKROUTER_SECRET),
    debug: DEBUG,
    tickLogEveryMs: TICK_LOG_EVERY_MS,
  });
});

app.post("/tv", handleWebhook);
app.post("/webhook", handleWebhook);

// ---------------------------
// Safety
// ---------------------------
process.on("unhandledRejection", (reason) => console.error("unhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

// ---------------------------
// Start
// ---------------------------
app.listen(PORT, () => {
  console.log(`✅ Brain listening on :${PORT}`);
  console.log(`🧭 SYMBOL_BOT_MAP keys=${Object.keys(SYMBOL_BOT_MAP).length}`);
  console.log(`🐛 DEBUG=${DEBUG ? 1 : 0}`);
  console.log(`🧾 TICK_LOG_EVERY_MS=${TICK_LOG_EVERY_MS}`);
});
