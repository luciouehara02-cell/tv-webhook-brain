/**
 * demoShort.js — Railway Brain (SHORT) — DEMO-first (v2.8.1-style state blocks)
 *
 * ✅ Supports your TradingView payload format:
 *    {
 *      "secret": "...",                    // YOUR brain secret (Railway WEBHOOK_SECRET)
 *      "src": "tick" | "heartbeat" | "enter_short" | "exit_short",
 *      "symbol": "BINANCE:SOLUSDT",
 *      "price": "83.60",
 *      "time": "2026-02-22T17:01:03Z",
 *      "exitReason": "ray_exit"            // optional for exit_short
 *    }
 *
 * ✅ Tick refreshes heartbeat automatically (no separate heartbeat alert needed)
 * ✅ Mirror profit lock (trough-based trailing)
 * ✅ Pump protection (optional ind fields)
 * ✅ HTF bearish bias filter (optional htf fields)
 * ✅ Regime gate (optional reg fields)
 *
 * ✅ LIVE 3Commas Signal Bot Webhook POST (no API key signing):
 *    POST https://api.3commas.io/signal_bots/webhooks
 *    { bot_uuid, secret, action: "start_deal" | "close_deal" }
 *
 * Railway Start Command:
 *   node demoShort.js
 */

import express from "express";
import crypto from "crypto";

// -------------------------
// ENV + Tune Variables
// -------------------------
const ENV = {
  PORT: int(process.env.PORT, 8080),

  // Brain webhook
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

  // Regime + HTF gates (optional)
  ENABLE_REGIME_GATE: bool(process.env.ENABLE_REGIME_GATE, true),
  REG_ADX_MIN: num(process.env.REG_ADX_MIN, 18),
  REG_SLOPE_MIN: num(process.env.REG_SLOPE_MIN, 0.08), // bear requires slopePctPerBar <= -min

  ENABLE_HTF_BIAS: bool(process.env.ENABLE_HTF_BIAS, true),

  // 3Commas Signal Bot Webhook (LIVE)
  C3_WEBHOOK_URL: process.env.C3_WEBHOOK_URL || "https://api.3commas.io/signal_bots/webhooks",
  C3_BOT_UUID: process.env.C3_BOT_UUID || "",
  C3_WEBHOOK_SECRET: process.env.C3_WEBHOOK_SECRET || "",
  C3_TIMEOUT_MS: int(process.env.C3_TIMEOUT_MS, 8000),

  // Logging
  LOG_JSON: bool(process.env.LOG_JSON, false),
};

console.log(
  `✅ Brain SHORT DEMO listening. PORT=${ENV.PORT} | ENABLE_POST_3C=${ENV.ENABLE_POST_3C}\n` +
    `Config: READY_TTL_MIN=${ENV.READY_TTL_MIN} | READY_MAX_MOVE_PCT=${ENV.READY_MAX_MOVE_PCT} | COOLDOWN_MIN=${ENV.COOLDOWN_MIN}\n` +
    `Heartbeat: REQUIRE_FRESH_HEARTBEAT=${ENV.REQUIRE_FRESH_HEARTBEAT} | HEARTBEAT_MAX_AGE_SEC=${ENV.HEARTBEAT_MAX_AGE_SEC}\n` +
    `ProfitLock: trigger=${ENV.PROFIT_LOCK_TRIGGER_PCT}% giveback=${ENV.PROFIT_LOCK_GIVEBACK_PCT}% | PumpProtect=${ENV.ENABLE_PUMP_PROTECT}\n` +
    `3Commas: URL=${ENV.C3_WEBHOOK_URL} | BOT_UUID=${ENV.C3_BOT_UUID ? "(set)" : "(missing)"} | SECRET=${ENV.C3_WEBHOOK_SECRET ? "(set)" : "(missing)"} | TIMEOUT_MS=${ENV.C3_TIMEOUT_MS}`
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

app.get("/status", (_req, res) => {
  const p = STATE.POSITION_SHORT;
  const now = Date.now();
  const floor = p?.isOpen
    ? p.trough * (1 + ENV.PROFIT_LOCK_GIVEBACK_PCT / 100)
    : null;

  res.status(200).json({
    ok: true,
    now,
    lastHeartbeatAgeSec: STATE.ACT_SHORT.lastHeartbeatTs
      ? Math.floor((now - STATE.ACT_SHORT.lastHeartbeatTs) / 1000)
      : null,
    ready: STATE.READY_SHORT,
    position: p
      ? {
          isOpen: p.isOpen,
          pair: p.pair,
          entryPrice: p.entryPrice,
          entryTs: p.entryTs,
          trough: p.trough,
          lastPrice: p.lastPrice,
          profitLockArmed: p.profitLockArmed,
          floor: floor,
          lastUpdateTs: p.lastUpdateTs,
        }
      : null,
    cooldownUntil: STATE.ACT_SHORT.cooldownUntil,
    pumpCooldownUntil: STATE.ACT_SHORT.pumpCooldownUntil,
  });
});

app.post(ENV.WEBHOOK_PATH, async (req, res) => {
  try {
    const payload = req.body || {};

    // 1) Auth (Brain secret)
    if (!verifySecret(payload?.secret, ENV.WEBHOOK_SECRET)) {
      log("UNAUTHORIZED", { gotSecret: !!payload?.secret });
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    // 2) Normalize event (supports your src/symbol/time payload)
    const evt = normalizeWebhook(payload);
    log("WEBHOOK_IN", { intent: evt.intent, pair: evt.pair, price: evt.price, ts: evt.ts });

    // Dedup (optional)
    if (evt.eventId && STATE.ACT_SHORT.lastEventId === evt.eventId) {
      log("DEDUP", { eventId: evt.eventId });
      return res.status(200).json({ ok: true, dedup: true });
    }
    if (evt.eventId) STATE.ACT_SHORT.lastEventId = evt.eventId;

    // 3) Heartbeat refresh:
    // Treat ANY tick as a heartbeat refresh (so you don't need separate heartbeat alert)
    if (evt.intent === "tick" || evt.intent === "heartbeat") {
      STATE.ACT_SHORT.lastHeartbeatTs = evt.ts;
    }

    // 4) If position open, update trough/profit-lock on any event with price
    if (STATE.POSITION_SHORT?.isOpen && isFinite(evt.price)) {
      updateShortPositionOnTick(evt.price, evt.ts);
    }

    // 5) Route by intent
    if (evt.intent === "heartbeat") {
      log("HEARTBEAT_OK", { ts: evt.ts, pair: evt.pair, price: evt.price });
      return res.status(200).json({ ok: true, action: "heartbeat" });
    }

    if (evt.intent === "tick") {
      // Auto-exit on profit lock when armed
      if (STATE.POSITION_SHORT?.isOpen) {
        const pl = profitLockExitCheck(evt.price);
        if (pl.shouldExit) {
          const exec = await executeExitShort(evt, `profit_lock_exit:${pl.detail}`);
          return res.status(200).json({
            ok: true,
            action: "exit_short",
            auto: true,
            demo: !ENV.ENABLE_POST_3C,
            exec,
          });
        }
      }
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

  // Heartbeat gate (optional)
  if (ENV.REQUIRE_FRESH_HEARTBEAT) {
    if (!STATE.ACT_SHORT.lastHeartbeatTs) {
      return { allow: false, reason: "no_heartbeat_seen", cooldownMin: 0 };
    }
    const ageMs = now - STATE.ACT_SHORT.lastHeartbeatTs;
    if (ageMs > ENV.HEARTBEAT_MAX_AGE_SEC * 1000) {
      return { allow: false, reason: "heartbeat_stale", cooldownMin: 0 };
    }
  }

  // Cooldowns
  if (now < STATE.ACT_SHORT.cooldownUntil) {
    return { allow: false, reason: "cooldown_active", cooldownMin: 0 };
  }
  if (now < STATE.ACT_SHORT.pumpCooldownUntil) {
    return { allow: false, reason: "pump_cooldown_active", cooldownMin: 0 };
  }

  // If already in a short, ignore
  if (STATE.POSITION_SHORT?.isOpen) {
    return { allow: false, reason: "short_already_open", cooldownMin: 0 };
  }

  // Pump protection (optional indicators)
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

  // HTF bearish bias gate (optional)
  if (ENV.ENABLE_HTF_BIAS) {
    const bias = htfBearishBiasOk(evt);
    if (!bias.ok) {
      return { allow: false, reason: `htf_bias_block:${bias.reason}`, cooldownMin: 0 };
    }
  }

  // Regime gate (optional)
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

  // Explicit exit from signal
  if (evt.exitReason === "ray_exit") {
    return { allow: true, reason: "ray_exit" };
  }

  // Profit-lock exit
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

  // trough is lowest price since entry
  if (typeof p.trough !== "number") p.trough = price;
  p.trough = Math.min(p.trough, price);

  // arm profit lock after trigger achieved
  const triggerAbs = (p.entryPrice * ENV.PROFIT_LOCK_TRIGGER_PCT) / 100;
  const moveInFavor = p.entryPrice - p.trough;

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
// Pump protection (optional)
// Provide ind fields if you want it active:
//   ind.atr, ind.candleRange, ind.rocPct
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
// HTF bearish bias gate (optional)
// Provide htf fields if you want it active:
//   htf.closeBelowEma200 (bool)
//   htf.ema50BelowEma200 (bool) OR htf.rsiBelow50 (bool)
// If missing -> allow
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
// Regime gate (optional)
// Provide reg fields if you want it active:
//   reg.adx (number)
//   reg.slopePctPerBar (number) negative for downtrend
// If missing -> allow
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
// Execution (DEMO/LIVE) + REAL 3Commas webhook POST
// -------------------------
async function executeEnterShort(evt) {
  const ready = STATE.READY_SHORT;
  if (!ready || ready.blocked) return { ok: false, reason: "no_ready" };

  if (evt.ts > ready.expiresAt) {
    clearReady("ready_expired");
    return { ok: false, reason: "ready_expired" };
  }

  // READY_MAX_MOVE_PCT guard
  const movePct = pctDiff(evt.price, ready.signalPrice);
  if (movePct > ENV.READY_MAX_MOVE_PCT) {
    clearReady("ready_max_move_exceeded");
    STATE.ACT_SHORT.cooldownUntil = Math.max(STATE.ACT_SHORT.cooldownUntil, evt.ts + msMin(ENV.COOLDOWN_MIN));
    return { ok: false, reason: `ready_max_move_exceeded(movePct=${round(movePct)}%)` };
  }

  // Open local DEMO position state
  openShortPosition(evt.pair, evt.price, evt.ts);

  // DEMO
  if (!ENV.ENABLE_POST_3C) {
    return { ok: true, demo: true, posted: false, pair: evt.pair, price: evt.price };
  }

  // LIVE: 3Commas Signal Bot webhook
  const payload = build3CommasPayload("enter_short", evt);
  log("3COMMAS_POST", { action: "enter_short", url: ENV.C3_WEBHOOK_URL, payload: { ...payload, secret: "***" } });
  const resp = await postTo3Commas(payload);
  log("3COMMAS_RESP", { action: "enter_short", resp });

  return { ok: true, demo: false, posted: true, resp };
}

async function executeExitShort(evt, reason) {
  // Close local DEMO position state
  closeShortPosition(reason, evt.ts);

  // DEMO
  if (!ENV.ENABLE_POST_3C) {
    return { ok: true, demo: true, posted: false, reason };
  }

  // LIVE: 3Commas Signal Bot webhook
  const payload = build3CommasPayload("exit_short", evt);
  log("3COMMAS_POST", { action: "exit_short", url: ENV.C3_WEBHOOK_URL, payload: { ...payload, secret: "***" } });
  const resp = await postTo3Commas(payload);
  log("3COMMAS_RESP", { action: "exit_short", resp });

  return { ok: true, demo: false, posted: true, resp };
}

function build3CommasPayload(action, evt) {
  // Map to 3Commas signal bot actions
  const mappedAction =
    action === "enter_short" ? "start_deal" :
    action === "exit_short"  ? "close_deal" :
    action;

  return {
    bot_uuid: ENV.C3_BOT_UUID,
    secret: ENV.C3_WEBHOOK_SECRET,
    action: mappedAction,

    // Optional extras (safe; may be ignored)
    pair: evt.pair,
    price: evt.price,
    time: new Date(evt.ts).toISOString(),
  };
}

async function postTo3Commas(payload) {
  if (!ENV.C3_BOT_UUID || !ENV.C3_WEBHOOK_SECRET) {
    return { ok: false, error: "missing_C3_BOT_UUID_or_C3_WEBHOOK_SECRET" };
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ENV.C3_TIMEOUT_MS);

  try {
    const r = await fetch(ENV.C3_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await r.text().catch(() => "");
    return { ok: r.ok, status: r.status, body: text };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
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
  log("POSITION_SHORT_OPEN", {
    isOpen: true,
    pair,
    entryPrice,
    entryTs: ts,
  });
}

function closeShortPosition(reason, ts) {
  const p = STATE.POSITION_SHORT;
  if (!p?.isOpen) return;

  const exitPrice = p.lastPrice ?? NaN;
  const pnlAbs = isFinite(exitPrice) ? p.entryPrice - exitPrice : NaN;

  log("POSITION_SHORT_CLOSE", {
    pair: p.pair,
    entry: p.entryPrice,
    exit: isFinite(exitPrice) ? exitPrice : null,
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
// Normalization (supports your TradingView payload)
// -------------------------
function normalizeWebhook(p) {
  const ts = toMs(p.time || p.timestamp) ?? Date.now();

  // "BINANCE:SOLUSDT" -> "SOLUSDT"
  const rawSymbol = safeStr(p.symbol || p.pair || p.instrument || p.tv_instrument || "UNKNOWN");
  const symNoEx = rawSymbol.includes(":") ? rawSymbol.split(":")[1] : rawSymbol;

  const pair = toBotPair(symNoEx);
  const price = num(p.price ?? p.trigger_price, NaN);

  return {
    eventId: safeStr(p.eventId || ""),
    ts,
    pair,
    price,

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

  // your field: src
  const src = safeStr(p.src || "").toLowerCase();
  if (src === "tick") return "tick";
  if (src === "heartbeat") return "heartbeat";
  if (src === "enter_short" || src === "short") return "enter_short";
  if (src === "exit_short" || src === "close_short") return "exit_short";

  // optional back-compat with your old format
  const action = safeStr(p.action || "").toLowerCase();
  if (action === "ready") return "enter_short";
  if (action === "exit") return "exit_short";

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
