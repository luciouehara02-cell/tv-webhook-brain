/**
 * demoShort.js — Railway Brain (SHORT) — v2.8.1-style architecture
 *
 * ✅ Accepts TradingView payloads:
 *   New style:
 *     { secret, src: tick|enter_short|exit_short, symbol:"BINANCE:SOLUSDT", price:"83.2", time:"{{timenow}}" }
 *   Old style (optional compatibility):
 *     { secret, action:"enter_short", tv_exchange, tv_instrument, trigger_price, timestamp }
 *
 * ✅ Tick refreshes heartbeat automatically
 * ✅ READY_SHORT / POSITION_SHORT / ACT_SHORT (v2.8.1 style)
 * ✅ Mirror Profit Lock (trough-based trailing) + auto-exit on tick
 * ✅ Pump protection (optional ind fields)
 * ✅ HTF bearish bias (optional htf fields)
 * ✅ Regime gate (optional reg fields)
 *
 * ✅ 3Commas Custom Signal payload (THIS is the critical fix):
 *   POST https://api.3commas.io/signal_bots/webhooks
 *   {
 *     "secret": "<3commas signal source secret (JWT-like)>",
 *     "max_lag": "300",
 *     "timestamp": "<ISO>",
 *     "trigger_price": "<string>",
 *     "tv_exchange": "BINANCE",
 *     "tv_instrument": "SOLUSDT",
 *     "action": "enter_short" | "exit_short",
 *     "bot_uuid": "<signal bot uuid>"
 *   }
 *
 * Railway Start Command:
 *   node demoShort.js
 */

import express from "express";
import crypto from "crypto";

// -------------------------
// ENV
// -------------------------
const ENV = {
  PORT: int(process.env.PORT, 8080),

  // Brain webhook
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "CHANGE_ME_TO_RANDOM_40+CHARS",
  WEBHOOK_PATH: process.env.WEBHOOK_PATH || "/webhook",

  // DEMO-first toggle
  ENABLE_POST_3C: bool(process.env.ENABLE_POST_3C, false),

  // Heartbeat gate
  REQUIRE_FRESH_HEARTBEAT: bool(process.env.REQUIRE_FRESH_HEARTBEAT, true),
  HEARTBEAT_MAX_AGE_SEC: num(process.env.HEARTBEAT_MAX_AGE_SEC, 240),

  // READY/ACT
  READY_TTL_MIN: num(process.env.READY_TTL_MIN, 20),
  READY_MAX_MOVE_PCT: num(process.env.READY_MAX_MOVE_PCT, 0.6),
  COOLDOWN_MIN: num(process.env.COOLDOWN_MIN, 3),

  // Profit lock (mirror)
  PROFIT_LOCK_TRIGGER_PCT: num(process.env.PROFIT_LOCK_TRIGGER_PCT, 0.60),
  PROFIT_LOCK_GIVEBACK_PCT: num(process.env.PROFIT_LOCK_GIVEBACK_PCT, 0.30),

  // Pump protection
  ENABLE_PUMP_PROTECT: bool(process.env.ENABLE_PUMP_PROTECT, true),
  PUMP_ATR_MULT: num(process.env.PUMP_ATR_MULT, 1.8),
  PUMP_ROC_PCT: num(process.env.PUMP_ROC_PCT, 0.45),
  PUMP_COOLDOWN_MIN: num(process.env.PUMP_COOLDOWN_MIN, 5),

  // Regime / HTF (optional fields)
  ENABLE_REGIME_GATE: bool(process.env.ENABLE_REGIME_GATE, true),
  REG_ADX_MIN: num(process.env.REG_ADX_MIN, 18),
  REG_SLOPE_MIN: num(process.env.REG_SLOPE_MIN, 0.08), // requires slopePctPerBar <= -min

  ENABLE_HTF_BIAS: bool(process.env.ENABLE_HTF_BIAS, true),

  // 3Commas Custom Signal
  C3_WEBHOOK_URL: process.env.C3_WEBHOOK_URL || "https://api.3commas.io/signal_bots/webhooks",
  C3_BOT_UUID: process.env.C3_BOT_UUID || "",
C3_SIGNAL_SECRET:
  process.env.C3_SIGNAL_SECRET ||
  process.env.C3_WEBHOOK_SECRET || "", // <-- 3Commas "secret" (JWT-like)
  C3_MAX_LAG_SEC: String(process.env.C3_MAX_LAG_SEC || "300"),
  C3_TIMEOUT_MS: int(process.env.C3_TIMEOUT_MS, 8000),

  // Logging
  LOG_JSON: bool(process.env.LOG_JSON, false),
};

console.log(
  `✅ Brain SHORT v2.8.1-style listening. PORT=${ENV.PORT} | ENABLE_POST_3C=${ENV.ENABLE_POST_3C}\n` +
    `Config: READY_TTL_MIN=${ENV.READY_TTL_MIN} | READY_MAX_MOVE_PCT=${ENV.READY_MAX_MOVE_PCT} | COOLDOWN_MIN=${ENV.COOLDOWN_MIN}\n` +
    `Heartbeat: REQUIRE_FRESH_HEARTBEAT=${ENV.REQUIRE_FRESH_HEARTBEAT} | HEARTBEAT_MAX_AGE_SEC=${ENV.HEARTBEAT_MAX_AGE_SEC}\n` +
    `ProfitLock: trigger=${ENV.PROFIT_LOCK_TRIGGER_PCT}% giveback=${ENV.PROFIT_LOCK_GIVEBACK_PCT}%\n` +
    `3Commas: URL=${ENV.C3_WEBHOOK_URL} | BOT_UUID=${ENV.C3_BOT_UUID ? "(set)" : "(missing)"} | SIGNAL_SECRET=${ENV.C3_SIGNAL_SECRET ? "(set)" : "(missing)"} | max_lag=${ENV.C3_MAX_LAG_SEC}s`
);

// -------------------------
// STATE
// -------------------------
const STATE = {
  READY_SHORT: null,
  POSITION_SHORT: null,
  ACT_SHORT: {
    cooldownUntil: 0,
    pumpCooldownUntil: 0,
    lastEventId: null,
    lastHeartbeatTs: 0,
  },
};

// -------------------------
// APP
// -------------------------
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.status(200).send("OK: Brain SHORT v2.8.1-style"));

app.get("/heartbeat", (_req, res) => {
  const now = Date.now();
  res.json({
    ok: true,
    now,
    uptimeSec: Math.floor(process.uptime()),
    lastHeartbeatAgeSec: STATE.ACT_SHORT.lastHeartbeatTs
      ? Math.floor((now - STATE.ACT_SHORT.lastHeartbeatTs) / 1000)
      : null,
    positionOpen: !!STATE.POSITION_SHORT?.isOpen,
    ready: !!STATE.READY_SHORT,
    cooldownActive: now < STATE.ACT_SHORT.cooldownUntil,
    pumpCooldownActive: now < STATE.ACT_SHORT.pumpCooldownUntil,
  });
});

app.get("/status", (_req, res) => {
  const p = STATE.POSITION_SHORT;
  const now = Date.now();
  const floor = p?.isOpen ? p.trough * (1 + ENV.PROFIT_LOCK_GIVEBACK_PCT / 100) : null;

  res.json({
    ok: true,
    now,
    ready: STATE.READY_SHORT,
    position: p
      ? {
          isOpen: p.isOpen,
          pair: p.pair,
          exchange: p.exchange,
          instrument: p.instrument,
          entryPrice: p.entryPrice,
          entryTs: p.entryTs,
          trough: p.trough,
          lastPrice: p.lastPrice,
          profitLockArmed: p.profitLockArmed,
          floor,
          lastUpdateTs: p.lastUpdateTs,
        }
      : null,
    act: STATE.ACT_SHORT,
  });
});

app.get("/ready", (_req, res) => {
  res.json({ ok: true, ready: STATE.READY_SHORT });
});

// -------------------------
// WEBHOOK
// -------------------------
app.post(ENV.WEBHOOK_PATH, async (req, res) => {
  try {
    const payload = req.body || {};

    // Brain secret auth
    if (!verifySecret(payload?.secret, ENV.WEBHOOK_SECRET)) {
      log("UNAUTHORIZED", { gotSecret: !!payload?.secret });
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const evt = normalizeWebhook(payload);

    log("WEBHOOK_IN", {
      intent: evt.intent,
      exchange: evt.exchange,
      instrument: evt.instrument,
      pair: evt.pair,
      price: evt.price,
      ts: evt.ts,
    });

    // Dedup
    if (evt.eventId && STATE.ACT_SHORT.lastEventId === evt.eventId) {
      log("DEDUP", { eventId: evt.eventId });
      return res.status(200).json({ ok: true, dedup: true });
    }
    if (evt.eventId) STATE.ACT_SHORT.lastEventId = evt.eventId;

    // Refresh heartbeat on tick/heartbeat
    if (evt.intent === "tick" || evt.intent === "heartbeat") {
      STATE.ACT_SHORT.lastHeartbeatTs = evt.ts;
    }

    // Update position on any priced event
    if (STATE.POSITION_SHORT?.isOpen && isFinite(evt.price)) {
      updateShortPositionOnTick(evt.price, evt.ts);
    }

    // Heartbeat response
    if (evt.intent === "heartbeat") {
      return res.status(200).json({ ok: true, action: "heartbeat" });
    }

    // Tick: auto profit-lock exit
    if (evt.intent === "tick") {
      if (STATE.POSITION_SHORT?.isOpen) {
        const pl = profitLockExitCheck(evt.price);
        if (pl.shouldExit) {
          const exec = await executeExitShort(evt, `profit_lock_exit:${pl.detail}`);
          return res.status(200).json({ ok: true, action: "exit_short", auto: true, exec });
        }
      }
      return res.status(200).json({ ok: true, action: "tick" });
    }

    // Enter short
    if (evt.intent === "enter_short") {
      const decision = evaluateEnterShort(evt);

      if (!decision.allow) {
        STATE.READY_SHORT = {
          id: uid(),
          ts: evt.ts,
          pair: evt.pair,
          exchange: evt.exchange,
          instrument: evt.instrument,
          signalPrice: evt.price,
          reason: decision.reason,
          blocked: true,
          expiresAt: evt.ts + msMin(ENV.READY_TTL_MIN),
        };
        log("BLOCK_ENTER_SHORT", { reason: decision.reason });
        return res.status(200).json({ ok: true, action: "blocked", reason: decision.reason });
      }

      STATE.READY_SHORT = {
        id: uid(),
        ts: evt.ts,
        pair: evt.pair,
        exchange: evt.exchange,
        instrument: evt.instrument,
        signalPrice: evt.price,
        reason: "accepted",
        blocked: false,
        expiresAt: evt.ts + msMin(ENV.READY_TTL_MIN),
      };

      log("READY_SHORT_SET", STATE.READY_SHORT);

      const exec = await executeEnterShort(evt);
      return res.status(200).json({ ok: true, action: "enter_short", exec });
    }

    // Exit short
    if (evt.intent === "exit_short") {
      const decision = evaluateExitShort(evt);
      if (!decision.allow) {
        log("IGNORE_EXIT_SHORT", { reason: decision.reason });
        return res.status(200).json({ ok: true, action: "ignored", reason: decision.reason });
      }

      const exec = await executeExitShort(evt, decision.reason);
      return res.status(200).json({ ok: true, action: "exit_short", exec });
    }

    return res.status(400).json({ ok: false, error: "unknown_intent", got: evt.intent });
  } catch (e) {
    console.error("ERROR", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// -------------------------
// GATING
// -------------------------
function evaluateEnterShort(evt) {
  const now = evt.ts;

  // Heartbeat gate
  if (ENV.REQUIRE_FRESH_HEARTBEAT) {
    if (!STATE.ACT_SHORT.lastHeartbeatTs) return { allow: false, reason: "no_heartbeat_seen" };
    const ageMs = now - STATE.ACT_SHORT.lastHeartbeatTs;
    if (ageMs > ENV.HEARTBEAT_MAX_AGE_SEC * 1000) return { allow: false, reason: "heartbeat_stale" };
  }

  // Cooldowns
  if (now < STATE.ACT_SHORT.cooldownUntil) return { allow: false, reason: "cooldown_active" };
  if (now < STATE.ACT_SHORT.pumpCooldownUntil) return { allow: false, reason: "pump_cooldown_active" };

  // One position at a time
  if (STATE.POSITION_SHORT?.isOpen) return { allow: false, reason: "short_already_open" };

  // Pump protection (optional)
  if (ENV.ENABLE_PUMP_PROTECT) {
    const pump = detectPump(evt);
    if (pump.isPump) {
      STATE.ACT_SHORT.pumpCooldownUntil = Math.max(
        STATE.ACT_SHORT.pumpCooldownUntil,
        now + msMin(ENV.PUMP_COOLDOWN_MIN)
      );
      return { allow: false, reason: `pump_detected:${pump.reason}` };
    }
  }

  // HTF bearish bias (optional)
  if (ENV.ENABLE_HTF_BIAS) {
    const bias = htfBearishBiasOk(evt);
    if (!bias.ok) return { allow: false, reason: `htf_bias_block:${bias.reason}` };
  }

  // Regime gate (optional)
  if (ENV.ENABLE_REGIME_GATE) {
    const reg = regimeBearOk(evt);
    if (!reg.ok) return { allow: false, reason: `regime_block:${reg.reason}` };
  }

  return { allow: true, reason: "accepted" };
}

function evaluateExitShort(evt) {
  if (!STATE.POSITION_SHORT?.isOpen) return { allow: false, reason: "no_open_short" };

  if (evt.exitReason === "ray_exit") return { allow: true, reason: "ray_exit" };

  const pl = profitLockExitCheck(evt.price);
  if (pl.shouldExit) return { allow: true, reason: `profit_lock_exit:${pl.detail}` };

  return { allow: false, reason: "no_exit_condition" };
}

// -------------------------
// PROFIT LOCK (mirror)
// -------------------------
function updateShortPositionOnTick(price, ts) {
  const p = STATE.POSITION_SHORT;
  if (!p?.isOpen) return;

  p.lastPrice = price;
  p.lastUpdateTs = ts;
  p.trough = Math.min(p.trough, price);

  const triggerAbs = (p.entryPrice * ENV.PROFIT_LOCK_TRIGGER_PCT) / 100;
  const moveInFavor = p.entryPrice - p.trough;

  if (!p.profitLockArmed && moveInFavor >= triggerAbs) {
    p.profitLockArmed = true;
    log("PROFIT_LOCK_ARMED", {
      entry: p.entryPrice,
      trough: p.trough,
      moveInFavor: round(moveInFavor),
      triggerAbs: round(triggerAbs),
    });
  }
}

function profitLockExitCheck(currentPrice) {
  const p = STATE.POSITION_SHORT;
  if (!p?.isOpen) return { shouldExit: false, detail: "no_position" };
  if (!p.profitLockArmed) return { shouldExit: false, detail: "not_armed" };
  if (!isFinite(currentPrice)) return { shouldExit: false, detail: "no_price" };

  const floor = p.trough * (1 + ENV.PROFIT_LOCK_GIVEBACK_PCT / 100);
  if (currentPrice >= floor) {
    return {
      shouldExit: true,
      detail: `price=${round(currentPrice)} >= floor=${round(floor)} | trough=${round(p.trough)}`,
    };
  }
  return { shouldExit: false, detail: "hold" };
}

// -------------------------
// OPTIONAL PROTECTIONS (only active if fields provided)
// -------------------------
function detectPump(evt) {
  const ind = evt.ind || {};
  const atr = num(ind.atr, NaN);
  const range = num(ind.candleRange, NaN);
  const rocPct = num(ind.rocPct, NaN);

  if (!isFinite(atr) || !isFinite(range) || !isFinite(rocPct)) {
    return { isPump: false, reason: "no_indicators" };
  }

  if (range >= atr * ENV.PUMP_ATR_MULT) {
    return { isPump: true, reason: `range_gt_atr_mult(range=${range},atr=${atr})` };
  }
  if (rocPct >= ENV.PUMP_ROC_PCT) {
    return { isPump: true, reason: `roc_gt_threshold(rocPct=${rocPct})` };
  }
  return { isPump: false, reason: "ok" };
}

function htfBearishBiasOk(evt) {
  const htf = evt.htf || {};
  const hasAny =
    htf.closeBelowEma200 !== undefined ||
    htf.ema50BelowEma200 !== undefined ||
    htf.rsiBelow50 !== undefined;

  if (!hasAny) return { ok: true, reason: "no_htf_fields" };

  const closeBelow = bool(htf.closeBelowEma200, false);
  const emaBear = bool(htf.ema50BelowEma200, false);
  const rsiBear = bool(htf.rsiBelow50, false);

  if (!closeBelow) return { ok: false, reason: "close_not_below_ema200" };
  if (!(emaBear || rsiBear)) return { ok: false, reason: "no_secondary_bear_confirm" };
  return { ok: true, reason: "ok" };
}

function regimeBearOk(evt) {
  const reg = evt.reg || {};
  const hasAny = reg.adx !== undefined || reg.slopePctPerBar !== undefined;

  if (!hasAny) return { ok: true, reason: "no_regime_fields" };

  const adx = num(reg.adx, NaN);
  const slope = num(reg.slopePctPerBar, NaN);

  if (!isFinite(adx) || !isFinite(slope)) return { ok: true, reason: "bad_regime_fields_allow" };

  if (adx < ENV.REG_ADX_MIN) return { ok: false, reason: `adx_low(${adx}<${ENV.REG_ADX_MIN})` };
  if (slope > -ENV.REG_SLOPE_MIN) return { ok: false, reason: `slope_not_bear(${slope} > -${ENV.REG_SLOPE_MIN})` };
  return { ok: true, reason: "ok" };
}

// -------------------------
// EXECUTION (DEMO + LIVE 3Commas custom format)
// -------------------------
async function executeEnterShort(evt) {
  const ready = STATE.READY_SHORT;
  if (!ready || ready.blocked) return { ok: false, reason: "no_ready" };
  if (evt.ts > ready.expiresAt) {
    clearReady("ready_expired");
    return { ok: false, reason: "ready_expired" };
  }

  const movePct = pctDiff(evt.price, ready.signalPrice);
  if (movePct > ENV.READY_MAX_MOVE_PCT) {
    clearReady("ready_max_move_exceeded");
    STATE.ACT_SHORT.cooldownUntil = Math.max(STATE.ACT_SHORT.cooldownUntil, evt.ts + msMin(ENV.COOLDOWN_MIN));
    return { ok: false, reason: `ready_max_move_exceeded(movePct=${round(movePct)}%)` };
  }

  // Open internal position state
  openShortPosition(evt);

  if (!ENV.ENABLE_POST_3C) return { ok: true, demo: true, posted: false };

  // LIVE: correct 3Commas custom signal payload
   const payload = build3CommasCustomSignal("exit_short", evt);
  log("3COMMAS_POST", { action: "exit_short", url: ENV.C3_WEBHOOK_URL, payload: { ...payload, secret: "***" } });

  const resp = await postTo3Commas(payload);

  log("3COMMAS_RESP", { action: "exit_short", resp });

  return { ok: resp.ok, demo: false, posted: true, resp };

async function executeExitShort(evt, reason) {
  // Close internal position state
  closeShortPosition(reason, evt.ts);

  if (!ENV.ENABLE_POST_3C) return { ok: true, demo: true, posted: false, reason };

  const payload = build3CommasCustomSignal("exit_short", evt);
  log("3COMMAS_POST", { action: "exit_short", url: ENV.C3_WEBHOOK_URL, payload: mask3c(payload) });
  const resp = await postTo3Commas(payload);
  log("3COMMAS_RESP", { action: "exit_short", resp });

  return { ok: true, demo: false, posted: true, resp };
}

// ---- 3Commas custom format builder (FIX) ----
  const payload = build3CommasCustomSignal("enter_short", evt);
  log("3COMMAS_POST", { action: "enter_short", url: ENV.C3_WEBHOOK_URL, payload: { ...payload, secret: "***" } });

  const resp = await postTo3Commas(payload);

  // IMPORTANT: always log response even if ok=false
  log("3COMMAS_RESP", { action: "enter_short", resp });

  return { ok: resp.ok, demo: false, posted: true, resp };
function mask3c(p) {
  return { ...p, secret: "***" };
}

async function postTo3Commas(payload) {
  if (!ENV.C3_BOT_UUID || !ENV.C3_SIGNAL_SECRET) {
    return { ok: false, error: "missing_C3_BOT_UUID_or_C3_SIGNAL_SECRET" };
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ENV.C3_TIMEOUT_MS);
  const t0 = Date.now();

  try {
    const r = await fetch(ENV.C3_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const body = await r.text().catch(() => "");
    return { ok: r.ok, status: r.status, body, dtMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// -------------------------
// POSITION / READY helpers
// -------------------------
function openShortPosition(evt) {
  STATE.POSITION_SHORT = {
    isOpen: true,
    pair: evt.pair,
    exchange: evt.exchange,
    instrument: evt.instrument,
    entryPrice: evt.price,
    entryTs: evt.ts,
    trough: evt.price,
    lastPrice: evt.price,
    profitLockArmed: false,
    lastUpdateTs: evt.ts,
  };
  clearReady("entered_short");
  log("POSITION_SHORT_OPEN", {
    isOpen: true,
    pair: evt.pair,
    exchange: evt.exchange,
    instrument: evt.instrument,
    entryPrice: evt.price,
    entryTs: evt.ts,
  });
}

function closeShortPosition(reason, ts) {
  const p = STATE.POSITION_SHORT;
  if (!p?.isOpen) return;
  log("POSITION_SHORT_CLOSE", { reason, pair: p.pair, entry: p.entryPrice, exit: p.lastPrice, trough: p.trough });
  STATE.POSITION_SHORT = null;
  STATE.ACT_SHORT.cooldownUntil = Math.max(STATE.ACT_SHORT.cooldownUntil, ts + msMin(ENV.COOLDOWN_MIN));
}

function clearReady(reason) {
  if (STATE.READY_SHORT) log("READY_SHORT_CLEARED", { reason, ready: STATE.READY_SHORT });
  STATE.READY_SHORT = null;
}

// -------------------------
// NORMALIZE (supports both formats)
// -------------------------
function normalizeWebhook(p) {
  const ts = toMs(p.time || p.timestamp) ?? Date.now();

  // New style
  const rawSymbol = safeStr(p.symbol || "");
  const symNoEx = rawSymbol.includes(":") ? rawSymbol.split(":")[1] : rawSymbol;

  // Old style
  const tvExchange = safeStr(p.tv_exchange || "");
  const tvInstrument = safeStr(p.tv_instrument || "");

  const exchange = tvExchange || (rawSymbol.includes(":") ? rawSymbol.split(":")[0] : "BINANCE");
  const instrument = tvInstrument || symNoEx || "UNKNOWN";

  // Pair for internal logging (optional)
  const pair = toBotPair(instrument);

  const price = num(p.price ?? p.trigger_price, NaN);

  return {
    eventId: safeStr(p.eventId || ""),
    ts,
    price,
    exchange: exchange || "BINANCE",
    instrument,
    pair,
    intent: normalizeIntent(p.intent, p),
    exitReason: safeStr(p.exitReason || ""),
    ind: p.ind || p.indicators || {},
    htf: p.htf || {},
    reg: p.reg || {},
  };
}

function normalizeIntent(intent, p) {
  const i = safeStr(intent || "").toLowerCase();
  if (["enter_short", "exit_short", "tick", "heartbeat"].includes(i)) return i;

  // New style field
  const src = safeStr(p.src || "").toLowerCase();
  if (src) return src;

  // Old style field
  const action = safeStr(p.action || "").toLowerCase();
  if (action) return action;

  return "unknown";
}

function toBotPair(symNoEx) {
  if (!symNoEx) return "UNKNOWN_PAIR";
  if (symNoEx.includes("_")) return symNoEx;

  const quotes = ["USDT", "USD", "BUSD", "USDC", "BTC", "ETH"];
  for (const q of quotes) {
    if (symNoEx.endsWith(q) && symNoEx.length > q.length) {
      const base = symNoEx.slice(0, -q.length);
      return `${base}_${q}`;
    }
  }
  return symNoEx;
}

// -------------------------
// UTIL
// -------------------------
function verifySecret(got, expected) {
  const a = Buffer.from(String(got || ""));
  const b = Buffer.from(String(expected || ""));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function uid() {
  return crypto.randomBytes(8).toString("hex");
}

function msMin(m) {
  return Math.floor(m * 60 * 1000);
}

function pctDiff(a, b) {
  if (!isFinite(a) || !isFinite(b) || b === 0) return Infinity;
  return Math.abs((a - b) / b) * 100;
}

function toMs(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function safeStr(x) {
  if (x === null || x === undefined) return "";
  return String(x);
}

function bool(v, d = false) {
  if (v === undefined || v === null) return d;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase().trim();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return d;
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function int(v, d = 0) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : d;
}

function round(x, dp = 4) {
  if (!isFinite(x)) return x;
  const m = Math.pow(10, dp);
  return Math.round(x * m) / m;
}

function log(tag, obj = {}) {
  if (ENV.LOG_JSON) console.log(JSON.stringify({ tag, ts: new Date().toISOString(), ...obj }));
  else console.log(`[${new Date().toISOString()}] ${tag}`, obj);
}

// -------------------------
// START
// -------------------------
app.listen(ENV.PORT, () => {
  console.log(`🚀 Listening on :${ENV.PORT} path=${ENV.WEBHOOK_PATH}`);
});
