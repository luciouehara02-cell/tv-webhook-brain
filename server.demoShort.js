/**
 * demoShort.js — Railway Brain (SHORT) — DEMO-first
 * v2.8.1-style architecture: READY_SHORT / POSITION_SHORT / ACT_SHORT
 *
 * ✅ DEMO mode by default (no 3Commas POST unless ENABLE_POST_3C=true)
 * ✅ Mirror profit lock (trough-based trailing)
 * ✅ Pump protection (anti-short-squeeze)
 * ✅ HTF bearish bias gate (placeholder hooks)
 * ✅ Regime-aligned gating (placeholder hooks)
 * ✅ Clean 3Commas mapping (enter_short / exit_short)
 *
 * Run:
 *   node demoShort.js
 *
 * Railway:
 *   Start Command: node demoShort.js
 */

import express from "express";
import crypto from "crypto";

// -------------------------
// ENV + "variables" (tune here)
// -------------------------
const ENV = {
  PORT: int(process.env.PORT, 8080),

  // Webhook
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "CHANGE_ME_TO_RANDOM_40+CHARS",
  WEBHOOK_PATH: process.env.WEBHOOK_PATH || "/webhook",

  // DEMO-first (no live posts unless enabled)
  ENABLE_POST_3C: bool(process.env.ENABLE_POST_3C, false),

  // 3Commas (optional in DEMO)
  C3_API_BASE: process.env.C3_API_BASE || "https://api.3commas.io/public/api",
  C3_BOT_ID: process.env.C3_BOT_ID || "", // required for LIVE
  C3_API_KEY: process.env.C3_API_KEY || "",
  C3_API_SECRET: process.env.C3_API_SECRET || "",

  // General controls (v2.8.1 style)
  READY_TTL_MIN: num(process.env.READY_TTL_MIN, 20),            // how long READY stays valid
  READY_MAX_MOVE_PCT: num(process.env.READY_MAX_MOVE_PCT, 0.6), // block if price moved too far since signal
  COOLDOWN_MIN: num(process.env.COOLDOWN_MIN, 3),              // after exit/block

  // Short profit-lock (mirror)
  PROFIT_LOCK_TRIGGER_PCT: num(process.env.PROFIT_LOCK_TRIGGER_PCT, 0.60), // % move in your favor before trailing activates
  PROFIT_LOCK_GIVEBACK_PCT: num(process.env.PROFIT_LOCK_GIVEBACK_PCT, 0.30),// allowed bounce from trough before exit

  // Pump protection (anti short-squeeze)
  ENABLE_PUMP_PROTECT: bool(process.env.ENABLE_PUMP_PROTECT, true),
  PUMP_ATR_MULT: num(process.env.PUMP_ATR_MULT, 1.8),      // candle range > ATR*mult => pump
  PUMP_ROC_PCT: num(process.env.PUMP_ROC_PCT, 0.45),       // fast ROC threshold (TF-dependent)
  PUMP_COOLDOWN_MIN: num(process.env.PUMP_COOLDOWN_MIN, 5),

  // Regime + HTF gates (placeholders: you feed these values from TV)
  ENABLE_REGIME_GATE: bool(process.env.ENABLE_REGIME_GATE, true),
  REG_ADX_MIN: num(process.env.REG_ADX_MIN, 18),
  REG_SLOPE_MIN: num(process.env.REG_SLOPE_MIN, 0.08), // absolute %/bar; for bear we want negative slope <= -min

  ENABLE_HTF_BIAS: bool(process.env.ENABLE_HTF_BIAS, true),

  // Logging
  LOG_JSON: bool(process.env.LOG_JSON, false),
};

console.log(
  `✅ Brain SHORT DEMO listening. PORT=${ENV.PORT} | ENABLE_POST_3C=${ENV.ENABLE_POST_3C}\n` +
  `Config: READY_TTL_MIN=${ENV.READY_TTL_MIN} | READY_MAX_MOVE_PCT=${ENV.READY_MAX_MOVE_PCT} | COOLDOWN_MIN=${ENV.COOLDOWN_MIN}\n` +
  `ProfitLock: trigger=${ENV.PROFIT_LOCK_TRIGGER_PCT}% giveback=${ENV.PROFIT_LOCK_GIVEBACK_PCT}% | PumpProtect=${ENV.ENABLE_PUMP_PROTECT}`
);

// -------------------------
// In-memory state (swap to Redis later if desired)
// -------------------------
const STATE = {
  READY_SHORT: null,    // { id, ts, pair, signalPrice, reason, expiresAt, blocked?: boolean }
  POSITION_SHORT: null, // { isOpen, pair, entryPrice, entryTs, trough, lastPrice, profitLockArmed, lastUpdateTs }
  ACT_SHORT: {
    cooldownUntil: 0,
    pumpCooldownUntil: 0,
    lastEventId: null,
  },
};

// -------------------------
// Express app
// -------------------------
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.status(200).send("OK: Brain SHORT DEMO"));

app.post(ENV.WEBHOOK_PATH, async (req, res) => {
  try {
    const payload = req.body || {};

    // 1) Auth
    if (!verifySecret(payload?.secret, ENV.WEBHOOK_SECRET)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    // 2) Normalize event
    const evt = normalizeWebhook(payload);

    // Dedup basic
    if (evt.eventId && STATE.ACT_SHORT.lastEventId === evt.eventId) {
      log("DEDUP", { eventId: evt.eventId });
      return res.status(200).json({ ok: true, dedup: true });
    }
    if (evt.eventId) STATE.ACT_SHORT.lastEventId = evt.eventId;

    // 3) Update POSITION trough / profit-lock if open (for exit decisions)
    if (STATE.POSITION_SHORT?.isOpen) {
      updateShortPositionOnTick(evt.price, evt.ts);
    }

    // 4) Route by intent
    if (evt.intent === "enter_short") {
      const decision = evaluateEnterShort(evt);

      if (!decision.allow) {
        // record block + start cooldown if configured
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

    } else if (evt.intent === "exit_short") {
      const decision = evaluateExitShort(evt);

      if (!decision.allow) {
        log("IGNORE_EXIT_SHORT", { reason: decision.reason });
        return res.status(200).json({ ok: true, action: "ignored", reason: decision.reason });
      }

      const exec = await executeExitShort(evt, decision.reason);
      return res.status(200).json({ ok: true, action: "exit_short", demo: !ENV.ENABLE_POST_3C, exec });

    } else if (evt.intent === "tick") {
      // No action; we just updated position above
      return res.status(200).json({ ok: true, action: "tick" });

    } else {
      return res.status(400).json({ ok: false, error: "unknown_intent", got: evt.intent });
    }
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

  // A) Cooldowns
  if (now < STATE.ACT_SHORT.cooldownUntil) {
    return { allow: false, reason: "cooldown_active", cooldownMin: 0 };
  }
  if (now < STATE.ACT_SHORT.pumpCooldownUntil) {
    return { allow: false, reason: "pump_cooldown_active", cooldownMin: 0 };
  }

  // B) If already in a short, ignore
  if (STATE.POSITION_SHORT?.isOpen) {
    return { allow: false, reason: "short_already_open", cooldownMin: 0 };
  }

  // C) Pump protection (requires indicators from TV)
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

  // D) HTF bearish bias gate (requires HTF fields from TV)
  if (ENV.ENABLE_HTF_BIAS) {
    const bias = htfBearishBiasOk(evt);
    if (!bias.ok) {
      return { allow: false, reason: `htf_bias_block:${bias.reason}`, cooldownMin: 0 };
    }
  }

  // E) Regime gate (requires ADX + slope fields from TV)
  if (ENV.ENABLE_REGIME_GATE) {
    const reg = regimeBearOk(evt);
    if (!reg.ok) {
      return { allow: false, reason: `regime_block:${reg.reason}`, cooldownMin: 0 };
    }
  }

  // F) READY_MAX_MOVE_PCT is used at execution time (to prevent late fills)
  return { allow: true, reason: "accepted" };
}

function evaluateExitShort(evt) {
  const now = evt.ts;

  if (!STATE.POSITION_SHORT?.isOpen) {
    return { allow: false, reason: "no_open_short" };
  }

  // Exit can be requested explicitly by RayAlgo:
  if (evt.exitReason === "ray_exit") {
    return { allow: true, reason: "ray_exit" };
  }

  // Or we can exit via profit lock (mirror trailing):
  const pl = profitLockExitCheck(evt.price);
  if (pl.shouldExit) {
    return { allow: true, reason: `profit_lock_exit:${pl.detail}` };
  }

  return { allow: false, reason: "no_exit_condition" };
}

// -------------------------
// Position update + Profit lock (mirror)
// -------------------------
function updateShortPositionOnTick(price, ts) {
  const p = STATE.POSITION_SHORT;
  if (!p?.isOpen) return;

  p.lastPrice = price;
  p.lastUpdateTs = ts;

  // trough is lowest price since entry (best profit for short)
  if (typeof p.trough !== "number") p.trough = price;
  p.trough = Math.min(p.trough, price);

  // arm profit lock after trigger achieved
  const trigger = (p.entryPrice * ENV.PROFIT_LOCK_TRIGGER_PCT) / 100;
  const moveInFavor = p.entryPrice - p.trough; // positive if price dropped
  if (!p.profitLockArmed && moveInFavor >= trigger) {
    p.profitLockArmed = true;
    log("PROFIT_LOCK_ARMED", { pair: p.pair, entry: p.entryPrice, trough: p.trough, moveInFavor });
  }
}

function profitLockExitCheck(currentPrice) {
  const p = STATE.POSITION_SHORT;
  if (!p?.isOpen) return { shouldExit: false, detail: "no_position" };
  if (!p.profitLockArmed) return { shouldExit: false, detail: "not_armed" };

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
// Expect these fields from TV webhook (optional but recommended):
//   indicators.atr, indicators.candleRange, indicators.rocPct
// -------------------------
function detectPump(evt) {
  const atr = num(evt.ind?.atr, NaN);
  const range = num(evt.ind?.candleRange, NaN);
  const rocPct = num(evt.ind?.rocPct, NaN);

  // If indicators not supplied, we can't detect pump reliably; default to "no pump"
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

// -------------------------
// HTF bearish bias gate (placeholder)
// Expect fields like:
//   htf.closeBelowEma200 (bool)
//   htf.ema50BelowEma200 (bool) OR htf.rsiBelow50 (bool)
// -------------------------
function htfBearishBiasOk(evt) {
  const htf = evt.htf || {};
  const closeBelow = bool(htf.closeBelowEma200, false);
  const emaBear = bool(htf.ema50BelowEma200, false);
  const rsiBear = bool(htf.rsiBelow50, false);

  if (!closeBelow) return { ok: false, reason: "close_not_below_ema200" };
  if (!(emaBear || rsiBear)) return { ok: false, reason: "no_secondary_bear_confirm" };
  return { ok: true, reason: "ok" };
}

// -------------------------
// Regime gate (placeholder)
// Expect fields like:
//   reg.adx (number)
//   reg.slopePctPerBar (number)  // negative for downtrend
// -------------------------
function regimeBearOk(evt) {
  const reg = evt.reg || {};
  const adx = num(reg.adx, NaN);
  const slope = num(reg.slopePctPerBar, NaN);

  if (!isFinite(adx) || !isFinite(slope)) {
    // if not provided, default to allow (or change to block if you want strict)
    return { ok: true, reason: "no_regime_fields" };
  }

  if (adx < ENV.REG_ADX_MIN) return { ok: false, reason: `adx_low(${adx}<${ENV.REG_ADX_MIN})` };
  if (slope > -ENV.REG_SLOPE_MIN) return { ok: false, reason: `slope_not_bear(${slope} > -${ENV.REG_SLOPE_MIN})` };
  return { ok: true, reason: "ok" };
}

// -------------------------
// Execution (DEMO/LIVE)
// -------------------------
async function executeEnterShort(evt) {
  // READY_MAX_MOVE_PCT guard (prevents late entries)
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

  // DEMO: simulate open position
  openShortPosition(evt.pair, evt.price, evt.ts);

  if (!ENV.ENABLE_POST_3C) {
    return { ok: true, demo: true, posted: false, pair: evt.pair, price: evt.price };
  }

  // LIVE: post to 3Commas (you’ll plug correct endpoint & payload for your bot setup)
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
// 3Commas mapping (keep it simple)
// NOTE: Exact endpoint/payload depends on your 3Commas bot type/config.
// We keep “clean mapping”: action + bot_id + pair.
// -------------------------
function build3CommasPayload(action, evt, reason = "") {
  return {
    action,                 // "enter_short" | "exit_short"
    bot_id: ENV.C3_BOT_ID,  // your signal bot id
    pair: evt.pair,         // e.g. "SOL_USDT" depending on your bot format
    price: evt.price,
    reason,
    ts: evt.ts,
  };
}

async function postTo3Commas(payload) {
  // This is a placeholder stub; wire it to your existing v2.8.1 3Commas POST helper.
  // If you already have axios/fetch signing for 3Commas, drop it here.
  // Return object for logs.
  if (!ENV.C3_API_KEY || !ENV.C3_API_SECRET) {
    return { status: "skipped", error: "missing_3c_keys" };
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
  const pnl = isFinite(exitPrice) ? (p.entryPrice - exitPrice) : NaN;

  log("POSITION_SHORT_CLOSE", {
    pair: p.pair,
    entry: p.entryPrice,
    exit: exitPrice,
    trough: p.trough,
    pnlAbs: pnl,
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
// Webhook normalize
// Expected minimal payload you can send from TradingView:
// {
//   "secret":"...",
//   "timestamp":"2026-02-22T00:00:00Z",
//   "pair":"SOL_USDT",
//   "intent":"enter_short" | "exit_short" | "tick",
//   "price": 84.12,
//   "eventId":"optional-unique-id",
//   "exitReason":"ray_exit", // optional
//   "ind": {"atr":0.35,"candleRange":0.90,"rocPct":0.62}, // optional
//   "htf": {"closeBelowEma200":true,"ema50BelowEma200":true,"rsiBelow50":false}, // optional
//   "reg": {"adx":22,"slopePctPerBar":-0.12} // optional
// }
// -------------------------
function normalizeWebhook(p) {
  const ts = toMs(p.timestamp) ?? Date.now();
  return {
    eventId: safeStr(p.eventId),
    ts,
    pair: safeStr(p.pair || p.instrument || "UNKNOWN_PAIR"),
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
  if (i === "enter_short" || i === "exit_short" || i === "tick") return i;

  // Back-compat helpers:
  // If your RayAlgo webhook uses "signal":"SHORT" etc, map here.
  const sig = safeStr(p.signal || p.action || "").toLowerCase();
  if (sig === "short" || sig === "sell_short" || sig === "enter_short") return "enter_short";
  if (sig === "exit_short" || sig === "close_short" || sig === "buy_to_cover") return "exit_short";

  return "unknown";
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
  // abs % difference between two prices
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

// Heartbeat / health (for monitors)
app.get("/heartbeat", (_req, res) => {
  const now = Date.now();
  res.status(200).json({
    ok: true,
    service: "Brain SHORT DEMO",
    now,
    uptimeSec: Math.floor(process.uptime()),
    ready: !!STATE.READY_SHORT,
    positionOpen: !!STATE.POSITION_SHORT?.isOpen,
    cooldownActive: now < STATE.ACT_SHORT.cooldownUntil,
    pumpCooldownActive: now < STATE.ACT_SHORT.pumpCooldownUntil,
  });
});

app.get("/health", (_req, res) => res.status(200).send("OK"));

