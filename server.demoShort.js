/**
 * demoShort.js — Railway Brain (SHORT) — DEMO-first (v2.8.1-style state blocks)
 *
 * ✅ Works with your TradingView payload format:
 *    {
 *      "secret": "...",
 *      "src": "tick" | "heartbeat" | "enter_short" | "exit_short",
 *      "symbol": "BINANCE:SOLUSDT",
 *      "price": "83.60",
 *      "time": "2026-02-22T17:01:03Z"
 *    }
 *
 * ✅ Treats TICK as HEARTBEAT refresh (so “not reaching heartbeat” is solved)
 * ✅ Optional heartbeat requirement gate for entries
 * ✅ Mirror profit lock (trough-based trailing)
 * ✅ Pump protection (needs optional ind fields from TV)
 * ✅ HTF bearish bias gate (needs optional htf fields from TV)
 * ✅ Regime gate (needs optional reg fields from TV)
 * ✅ Clean 3Commas mapping (stubbed, DEMO by default)
 *
 * Start:
 *   node demoShort.js
 *
 * Railway:
 *   Start Command: node demoShort.js
 */

import express from "express";
import crypto from "crypto";

// -------------------------
// ENV + Tune Variables
// -------------------------
const ENV = {
  PORT: int(process.env.PORT, 8080),

  // Webhook
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "CHANGE_ME_TO_RANDOM_40+CHARS",
  WEBHOOK_PATH: process.env.WEBHOOK_PATH || "/webhook",

  // DEMO-first
  ENABLE_POST_3C: bool(process.env.ENABLE_POST_3C, false),

  // Heartbeat gate (optional)
  REQUIRE_FRESH_HEARTBEAT: bool(process.env.REQUIRE_FRESH_HEARTBEAT, true),
  HEARTBEAT_MAX_AGE_SEC: num(process.env.HEARTBEAT_MAX_AGE_SEC, 240),

  // General controls (v2.8.1 style)
  READY_TTL_MIN: num(process.env.READY_TTL_MIN, 20),
  READY_MAX_MOVE_PCT: num(process.env.READY_MAX_MOVE_PCT, 0.6),
  COOLDOWN_MIN: num(process.env.COOLDOWN_MIN, 3),

  // Short profit-lock (mirror)
  PROFIT_LOCK_TRIGGER_PCT: num(process.env.PROFIT_LOCK_TRIGGER_PCT, 0.60),
  PROFIT_LOCK_GIVEBACK_PCT: num(process.env.PROFIT_LOCK_GIVEBACK_PCT, 0.30),

  // Pump protection (anti short-squeeze)
  ENABLE_PUMP_PROTECT: bool(process.env.ENABLE_PUMP_PROTECT, true),
  PUMP_ATR_MULT: num(process.env.PUMP_ATR_MULT, 1.8),
  PUMP_ROC_PCT: num(process.env.PUMP_ROC_PCT, 0.45),
  PUMP_COOLDOWN_MIN: num(process.env.PUMP_COOLDOWN_MIN, 5),

  // Regime + HTF gates (placeholders: you can feed from TV)
  ENABLE_REGIME_GATE: bool(process.env.ENABLE_REGIME_GATE, true),
  REG_ADX_MIN: num(process.env.REG_ADX_MIN, 18),
  REG_SLOPE_MIN: num(process.env.REG_SLOPE_MIN, 0.08), // bear requires slopePctPerBar <= -min

  ENABLE_HTF_BIAS: bool(process.env.ENABLE_HTF_BIAS, true),

  // 3Commas (optional in DEMO)
  C3_API_BASE: process.env.C3_API_BASE || "https://api.3commas.io/public/api",
  C3_BOT_ID: process.env.C3_BOT_ID || "",
  C3_API_KEY: process.env.C3_API_KEY || "",
  C3_API_SECRET: process.env.C3_API_SECRET || "",

  // Logging
  LOG_JSON: bool(process.env.LOG_JSON, false),
};

console.log(
  `✅ Brain SHORT DEMO listening. PORT=${ENV.PORT} | ENABLE_POST_3C=${ENV.ENABLE_POST_3C}\n` +
    `Config: READY_TTL_MIN=${ENV.READY_TTL_MIN} | READY_MAX_MOVE_PCT=${ENV.READY_MAX_MOVE_PCT} | COOLDOWN_MIN=${ENV.COOLDOWN_MIN}\n` +
    `Heartbeat: REQUIRE_FRESH_HEARTBEAT=${ENV.REQUIRE_FRESH_HEARTBEAT} | HEARTBEAT_MAX_AGE_SEC=${ENV.HEARTBEAT_MAX_AGE_SEC}\n` +
    `ProfitLock: trigger=${ENV.PROFIT_LOCK_TRIGGER_PCT}% giveback=${ENV.PROFIT_LOCK_GIVEBACK_PCT}% | PumpProtect=${ENV.ENABLE_PUMP_PROTECT}`
);

// -------------------------
// In-memory state (swap to Redis later)
// -------------------------
const STATE = {
  READY_SHORT: null, // { id, ts, pair, signalPrice, reason, expiresAt, blocked?: boolean }
  POSITION_SHORT: null, // { isOpen, pair, entryPrice, entryTs, trough, lastPrice, profitLockArmed, lastUpdateTs }
  ACT_SHORT: {
    cooldownUntil: 0,
    pumpCooldownUntil: 0,
    lastEventId: null,
    lastHeartbeatTs: 0, // refreshed by tick/heartbeat
  },
};

// -------------------------
// Express app
// -------------------------
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.status(200).send("OK: Brain SHORT DEMO"));

// Optional: monitoring endpoint
app.get("/heartbeat", (_req, res) => {
  const now = Date.now();
  res.status(200).json({
    ok: true,
    service: "Brain SHORT DEMO",
    now,
    uptimeSec: Math.floor(process.uptime()),
    lastHeartbeatAgeSec: STATE.ACT_SHORT.lastHeartbeatTs
      ? Math.floor((now - STATE.ACT_SHORT.lastHeartbeatTs) / 1000)
      : null,
    ready: !!STATE.READY_SHORT,
    positionOpen: !!STATE.POSITION_SHORT?.isOpen,
    cooldownActive: now < STATE.ACT_SHORT.cooldownUntil,
    pumpCooldownActive: now < STATE.ACT_SHORT.pumpCooldownUntil,
  });
});

app.post(ENV.WEBHOOK_PATH, async (req, res) => {
  try {
    const payload = req.body || {};

    // 1) Auth
    if (!verifySecret(payload?.secret, ENV.WEBHOOK_SECRET)) {
      log("UNAUTHORIZED", { gotSecret: !!payload?.secret });
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    // 2) Normalize event (supports your src/symbol/time payload)
    const evt = normalizeWebhook(payload);

    // Basic debug
    log("WEBHOOK_IN", { intent: evt.intent, pair: evt.pair, price: evt.price, ts: evt.ts });

    // Dedup (optional)
    if (evt.eventId && STATE.ACT_SHORT.lastEventId === evt.eventId) {
      log("DEDUP", { eventId: evt.eventId });
      return res.status(200).json({ ok: true, dedup: true });
    }
    if (evt.eventId) STATE.ACT_SHORT.lastEventId = evt.eventId;

    // 3) Heartbeat refresh:
    // Treat ANY tick as a heartbeat refresh (recommended so you don't need separate heartbeat alert)
    if (evt.intent === "tick" || evt.intent === "heartbeat") {
      STATE.ACT_SHORT.lastHeartbeatTs = evt.ts;
    }

    // 4) If position open, update trough/profit-lock on tick/any event with price
    if (STATE.POSITION_SHORT?.isOpen && isFinite(evt.price)) {
      updateShortPositionOnTick(evt.price, evt.ts);
    }

    // 5) Route by intent
    if (evt.intent === "heartbeat") {
      log("HEARTBEAT_OK", { ts: evt.ts, pair: evt.pair, price: evt.price });
      return res.status(200).json({ ok: true, action: "heartbeat" });
    }

    if (evt.intent === "tick") {
      // No trade action; it's used to update position + refresh heartbeat
      return res.status(200).json({ ok: true, action: "tick" });
    }

    if (evt.intent === "enter_short") {
      const decision = evaluateEnterShort(evt);

      if (!decision.allow) {
        STATE.READY_SHORT = {
          id: uid(),
          ts: evt.ts,
          pair: evt.pair,
          signalPrice: evt.price,
          reason: decision.reason,
          blocked: true,
          expiresAt: evt.ts + msMin(ENV.READY_TTL_MIN),
        };

        if (decision.cooldownMin) {
          STATE.ACT_SHORT.cooldownUntil = Math.max(
            STATE.ACT_SHORT.cooldownUntil,
            evt.ts + msMin(decision.cooldownMin)
          );
        }

        log("BLOCK_ENTER_SHORT", { pair: evt.pair, price: evt.price, reason: decision.reason });
        return res.status(200).json({ ok: true, action: "blocked", reason: decision.reason });
      }

      // Create READY_SHORT
      STATE.READY_SHORT = {
        id: uid(),
        ts: evt.ts,
        pair: evt.pair,
        signalPrice: evt.price,
        reason: decision.reason || "accepted",
        blocked: false,
        expiresAt: evt.ts + msMin(ENV.READY_TTL_MIN),
      };

      log("READY_SHORT_SET", STATE.READY_SHORT);

      // Execute (DEMO or LIVE)
      const exec = await executeEnterShort(evt);
      return res.status(200).json({ ok: true, action: "enter_short", demo: !ENV.ENABLE_POST_3C, exec });
    }

    if (evt.intent === "exit_short") {
      const decision = evaluateExitShort(evt);

      if (!decision.allow) {
        log("IGNORE_EXIT_SHORT", { reason: decision.reason });
        return res.status(200).json({ ok: true, action: "ignored", reason: decision.reason });
      }

      const exec = await executeExitShort(evt, decision.reason);
      return res.status(200).json({ ok: true, action: "exit_short", demo: !ENV.ENABLE_POST_3C, exec });
    }

    return res.status(400).json({ ok: false, error: "unknown_intent", got: evt.intent });
  } catch (e) {
    console.error("ERROR", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// -------------------------
// Decision logic
// -------------------------
function evaluateEnterShort(evt) {
  const now = evt.ts;

  // A) Heartbeat gate (optional)
  if (ENV.REQUIRE_FRESH_HEARTBEAT) {
    if (!STATE.ACT_SHORT.lastHeartbeatTs) {
      return { allow: false, reason: "no_heartbeat_seen", cooldownMin: 0 };
    }
    const ageMs = now - STATE.ACT_SHORT.lastHeartbeatTs;
    if (ageMs > ENV.HEARTBEAT_MAX_AGE_SEC * 1000) {
      return { allow: false, reason: "heartbeat_stale", cooldownMin: 0 };
    }
  }

  // B) Cooldowns
  if (now < STATE.ACT_SHORT.cooldownUntil) {
    return { allow: false, reason: "cooldown_active", cooldownMin: 0 };
  }
  if (now < STATE.ACT_SHORT.pumpCooldownUntil) {
    return { allow: false, reason: "pump_cooldown_active", cooldownMin: 0 };
  }

  // C) If already in a short, ignore
  if (STATE.POSITION_SHORT?.isOpen) {
    return { allow: false, reason: "short_already_open", cooldownMin: 0 };
  }

  // D) Pump protection (requires optional indicators from TV)
  if (ENV.ENABLE_PUMP_PROTECT) {
    const pump = detectPump(evt);
    if (pump.isPump) {
      STATE.ACT_SHORT.pumpCooldownUntil = Math.max(
        STATE.ACT_SHORT.pumpCooldownUntil,
        now + msMin(ENV.PUMP_COOLDOWN_MIN)
      );
      return { allow: false, reason: `pump_detected:${pump.reason}`, cooldownMin: 0 };
    }
  }

  // E) HTF bearish bias gate (requires optional HTF fields from TV)
  if (ENV.ENABLE_HTF_BIAS) {
    const bias = htfBearishBiasOk(evt);
    if (!bias.ok) {
      return { allow: false, reason: `htf_bias_block:${bias.reason}`, cooldownMin: 0 };
    }
  }

  // F) Regime gate (requires optional ADX + slope fields from TV)
  if (ENV.ENABLE_REGIME_GATE) {
    const reg = regimeBearOk(evt);
    if (!reg.ok) {
      return { allow: false, reason: `regime_block:${reg.reason}`, cooldownMin: 0 };
    }
  }

  return { allow: true, reason: "accepted" };
}

function evaluateExitShort(evt) {
  if (!STATE.POSITION_SHORT?.isOpen) {
    return { allow: false, reason: "no_open_short" };
  }

  // Exit can be requested explicitly by RayAlgo (or your webhook)
  if (evt.exitReason === "ray_exit") {
    return { allow: true, reason: "ray_exit" };
  }

  // Or exit via mirror profit lock
  const pl = profitLockExitCheck(evt.price);
  if (pl.shouldExit) {
    return { allow: true, reason: `profit_lock_exit:${pl.detail}` };
  }

  return { allow: false, reason: "no_exit_condition" };
}

// -------------------------
// Position update + Profit lock (mirror trough trailing)
// -------------------------
function updateShortPositionOnTick(price, ts) {
  const p = STATE.POSITION_SHORT;
  if (!p?.isOpen) return;

  p.lastPrice = price;
  p.lastUpdateTs = ts;

  // trough is lowest price since entry (best profit for short)
  if (typeof p.trough !== "number") p.trough = price;
  p.trough = Math.min(p.trough, price);

  // arm profit lock after trigger achieved:
  // triggerAbs = entryPrice * triggerPct
  const triggerAbs = (p.entryPrice * ENV.PROFIT_LOCK_TRIGGER_PCT) / 100;
  const moveInFavor = p.entryPrice - p.trough; // positive if price dropped
  if (!p.profitLockArmed && moveInFavor >= triggerAbs) {
    p.profitLockArmed = true;
    log("PROFIT_LOCK_ARMED", {
      pair: p.pair,
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

  // Mirror trailing for shorts:
  // floor = trough * (1 + givebackPct)
  const floor = p.trough * (1 + ENV.PROFIT_LOCK_GIVEBACK_PCT / 100);

  if (currentPrice >= floor) {
    return {
      shouldExit: true,
      detail: `price=${round(currentPrice)} >= floor=${round(floor)} | trough=${round(p.trough)} giveback=${ENV.PROFIT_LOCK_GIVEBACK_PCT}%`,
    };
  }
  return { shouldExit: false, detail: `hold | price=${round(currentPrice)} < floor=${round(floor)}` };
}

// -------------------------
// Pump protection (anti squeeze)
// Supports optional fields:
//   ind.atr, ind.candleRange, ind.rocPct
// If missing -> no pump block (DEMO-friendly)
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
    return { isPump: true, reason: `range_gt_atr_mult(range=${range},atr=${atr},mult=${ENV.PUMP_ATR_MULT})` };
  }
  if (rocPct >= ENV.PUMP_ROC_PCT) {
    return { isPump: true, reason: `roc_gt_threshold(rocPct=${rocPct},thr=${ENV.PUMP_ROC_PCT})` };
  }
  return { isPump: false, reason: "ok" };
}

// -------------------------
// HTF bearish bias gate (placeholder)
// Provide these from TV if you want the gate to actually block:
//   htf.closeBelowEma200 (bool)
//   htf.ema50BelowEma200 (bool) OR htf.rsiBelow50 (bool)
// If fields missing -> allow (DEMO-friendly)
// -------------------------
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

// -------------------------
// Regime gate (placeholder)
// Provide these from TV if you want the gate to actually block:
//   reg.adx (number)
//   reg.slopePctPerBar (number) // negative for downtrend
// If missing -> allow (DEMO-friendly)
// -------------------------
function regimeBearOk(evt) {
  const reg = evt.reg || {};
  const hasAny = reg.adx !== undefined || reg.slopePctPerBar !== undefined;

  if (!hasAny) return { ok: true, reason: "no_regime_fields" };

  const adx = num(reg.adx, NaN);
  const slope = num(reg.slopePctPerBar, NaN);

  if (!isFinite(adx) || !isFinite(slope)) {
    return { ok: true, reason: "bad_regime_fields_allow" };
  }

  if (adx < ENV.REG_ADX_MIN) return { ok: false, reason: `adx_low(${adx}<${ENV.REG_ADX_MIN})` };
  if (slope > -ENV.REG_SLOPE_MIN) return { ok: false, reason: `slope_not_bear(${slope} > -${ENV.REG_SLOPE_MIN})` };
  return { ok: true, reason: "ok" };
}

// -------------------------
// Execution (DEMO/LIVE)
// -------------------------
async function executeEnterShort(evt) {
  const ready = STATE.READY_SHORT;
  if (!ready || ready.blocked) return { ok: false, reason: "no_ready" };

  if (evt.ts > ready.expiresAt) {
    clearReady("ready_expired");
    return { ok: false, reason: "ready_expired" };
  }

  // READY_MAX_MOVE_PCT guard (prevents late entries)
  const movePct = pctDiff(evt.price, ready.signalPrice);
  if (movePct > ENV.READY_MAX_MOVE_PCT) {
    clearReady("ready_max_move_exceeded");
    STATE.ACT_SHORT.cooldownUntil = Math.max(STATE.ACT_SHORT.cooldownUntil, evt.ts + msMin(ENV.COOLDOWN_MIN));
    return { ok: false, reason: `ready_max_move_exceeded(movePct=${round(movePct)}%)` };
  }

  // DEMO: simulate open position
  openShortPosition(evt.pair, evt.price, evt.ts);

  if (!ENV.ENABLE_POST_3C) {
    return { ok: true, demo: true, posted: false, pair: evt.pair, price: evt.price };
  }

  // LIVE: wire into your existing v2.8.1 3Commas client
  const payload = build3CommasPayload("enter_short", evt);
  const resp = await postTo3Commas(payload);
  return { ok: true, demo: false, posted: true, resp };
}

async function executeExitShort(evt, reason) {
  // DEMO: close position
  closeShortPosition(reason, evt.ts);

  if (!ENV.ENABLE_POST_3C) {
    return { ok: true, demo: true, posted: false, reason };
  }

  const payload = build3CommasPayload("exit_short", evt, reason);
  const resp = await postTo3Commas(payload);
  return { ok: true, demo: false, posted: true, resp };
}

// -------------------------
// 3Commas mapping (stub)
// Keep “clean mapping”: action + bot_id + pair.
// -------------------------
function build3CommasPayload(action, evt, reason = "") {
  return {
    action, // "enter_short" | "exit_short"
    bot_id: ENV.C3_BOT_ID,
    pair: evt.pair, // e.g. "SOL_USDT"
    price: evt.price,
    reason,
    ts: evt.ts,
  };
}

async function postTo3Commas(payload) {
  // Placeholder: plug your working v2.8.1 signing + endpoint here
  if (!ENV.C3_API_KEY || !ENV.C3_API_SECRET) {
    return { status: "skipped", error: "missing_3c_keys", payload };
  }
  return { status: "todo", note: "wire to your v2.8.1 3Commas client", payload };
}

// -------------------------
// State helpers
// -------------------------
function openShortPosition(pair, entryPrice, ts) {
  STATE.POSITION_SHORT = {
    isOpen: true,
    pair,
    entryPrice,
    entryTs: ts,
    trough: entryPrice,
    lastPrice: entryPrice,
    profitLockArmed: false,
    lastUpdateTs: ts,
  };
  clearReady("entered_short");
  log("POSITION_SHORT_OPEN", STATE.POSITION_SHORT);
}

function closeShortPosition(reason, ts) {
  const p = STATE.POSITION_SHORT;
  if (!p?.isOpen) return;

  const exitPrice = p.lastPrice ?? NaN;
  const pnlAbs = isFinite(exitPrice) ? p.entryPrice - exitPrice : NaN;

  log("POSITION_SHORT_CLOSE", {
    pair: p.pair,
    entry: p.entryPrice,
    exit: exitPrice,
    trough: p.trough,
    pnlAbs: isFinite(pnlAbs) ? round(pnlAbs) : null,
    reason,
  });

  STATE.POSITION_SHORT = null;
  STATE.ACT_SHORT.cooldownUntil = Math.max(STATE.ACT_SHORT.cooldownUntil, ts + msMin(ENV.COOLDOWN_MIN));
}

function clearReady(reason) {
  if (STATE.READY_SHORT) {
    log("READY_SHORT_CLEARED", { reason, ready: STATE.READY_SHORT });
  }
  STATE.READY_SHORT = null;
}

// -------------------------
// Normalization (supports your TV payload)
// -------------------------
function normalizeWebhook(p) {
  const ts = toMs(p.time || p.timestamp) ?? Date.now();

  // "BINANCE:SOLUSDT" -> symNoEx = "SOLUSDT"
  const rawSymbol = safeStr(p.symbol || p.pair || p.instrument || "UNKNOWN");
  const symNoEx = rawSymbol.includes(":") ? rawSymbol.split(":")[1] : rawSymbol;
  const pair = toBotPair(symNoEx);

  return {
    eventId: safeStr(p.eventId || ""),
    ts,
    pair,
    price: num(p.price, NaN),

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

  const src = safeStr(p.src || "").toLowerCase();
  if (src === "tick") return "tick";
  if (src === "heartbeat") return "heartbeat";
  if (src === "enter_short" || src === "short") return "enter_short";
  if (src === "exit_short" || src === "close_short") return "exit_short";

  return "unknown";
}

function toBotPair(symNoEx) {
  if (!symNoEx) return "UNKNOWN_PAIR";
  if (symNoEx.includes("_")) return symNoEx;

  // Common quotes; converts SOLUSDT -> SOL_USDT etc
  const quotes = ["USDT", "USD", "BUSD", "USDC", "BTC", "ETH"];
  for (const q of quotes) {
    if (symNoEx.endsWith(q) && symNoEx.length > q.length) {
      const base = symNoEx.slice(0, -q.length);
      return `${base}_${q}`;
    }
  }
  return symNoEx; // fallback
}

// -------------------------
// Utilities
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
  if (ENV.LOG_JSON) {
    console.log(JSON.stringify({ tag, ts: new Date().toISOString(), ...obj }));
  } else {
    console.log(`[${new Date().toISOString()}] ${tag}`, obj);
  }
}

// -------------------------
// Start server
// -------------------------
app.listen(ENV.PORT, () => {
  console.log(`🚀 Listening on :${ENV.PORT} path=${ENV.WEBHOOK_PATH}`);
});
