/**
 * demoShort.js — Railway Brain (SHORT) — v2.8.1-minimal + (CrashProtect + EquityStab + Adaptive ProfitLock)
 *
 * INPUT (TradingView -> Brain):
 *  {
 *    "secret": "...",                    // WEBHOOK_SECRET
 *    "src": "tick" | "enter_short" | "exit_short",
 *    "symbol": "BINANCE:SOLUSDT",
 *    "price": "83.60",
 *    "time": "2026-02-22T17:01:03Z",
 *    "exitReason": "ray_exit"            // optional for exit_short
 *  }
 *
 * OUTPUT (Brain -> 3Commas Signal Bot Webhook):
 *  POST https://api.3commas.io/signal_bots/webhooks
 *  {
 *    "secret": C3_SIGNAL_SECRET,
 *    "max_lag": "300",
 *    "timestamp": "<ISO>",
 *    "trigger_price": "<string>",
 *    "tv_exchange": "BINANCE",
 *    "tv_instrument": "SOLUSDT",
 *    "action": "enter_short" | "exit_short",
 *    "bot_uuid": C3_BOT_UUID
 *  }
 */

import express from "express";
import crypto from "crypto";

process.on("unhandledRejection", (err) => console.error("[FATAL] unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("[FATAL] uncaughtException:", err));

/* ------------------------- ENV helpers ------------------------- */
function safeStr(x) { return x == null ? "" : String(x); }
function bool(v, d=false) {
  if (v == null) return d;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase().trim();
  if (["1","true","yes","y","on"].includes(s)) return true;
  if (["0","false","no","n","off"].includes(s)) return false;
  return d;
}
function num(v, d=0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function int(v, d=0) { const n = parseInt(String(v), 10); return Number.isFinite(n) ? n : d; }
function toMs(iso) { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; }
function msMin(m) { return Math.floor(m * 60 * 1000); }
function round(x, dp=4) { if (!Number.isFinite(x)) return x; const m=10**dp; return Math.round(x*m)/m; }
function uid() { return crypto.randomBytes(8).toString("hex"); }

/* ------------------------- ENV ------------------------- */
const ENV = {
  PORT: int(process.env.PORT, 8080),
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "CHANGE_ME_TO_RANDOM_40+CHARS",
  WEBHOOK_PATH: process.env.WEBHOOK_PATH || "/webhook",

  ENABLE_POST_3C: bool(process.env.ENABLE_POST_3C, false),

  // Heartbeat
  REQUIRE_FRESH_HEARTBEAT: bool(process.env.REQUIRE_FRESH_HEARTBEAT, true),
  HEARTBEAT_MAX_AGE_SEC: num(process.env.HEARTBEAT_MAX_AGE_SEC, 240),

  // Cooldown
  COOLDOWN_MIN: num(process.env.COOLDOWN_MIN, 3),

  // ProfitLock base (will be adapted)
  PROFIT_LOCK_ENABLED: bool(process.env.PROFIT_LOCK_ENABLED, true),
  PROFIT_LOCK_TRIGGER_PCT: num(process.env.PROFIT_LOCK_TRIGGER_PCT, 0.6),   // base arm %
  PROFIT_LOCK_GIVEBACK_PCT: num(process.env.PROFIT_LOCK_GIVEBACK_PCT, 0.3), // base give %
  PROFIT_LOCK_ADAPTIVE: bool(process.env.PROFIT_LOCK_ADAPTIVE, true),

  // Adaptive multipliers
  TREND_MULT_ARM: num(process.env.TREND_MULT_ARM, 2.2),
  TREND_MULT_GIVE: num(process.env.TREND_MULT_GIVE, 1.2),
  RANGE_MULT_ARM: num(process.env.RANGE_MULT_ARM, 1.4),
  RANGE_MULT_GIVE: num(process.env.RANGE_MULT_GIVE, 0.9),

  // Clamps
  PL_MIN_ARM: num(process.env.PL_MIN_ARM, 0.4),
  PL_MIN_GIVE: num(process.env.PL_MIN_GIVE, 0.3),
  PL_MAX_ARM: num(process.env.PL_MAX_ARM, 3.0),
  PL_MAX_GIVE: num(process.env.PL_MAX_GIVE, 1.5),

  // CrashProtect (dump protection)
  CRASH_PROTECT_ENABLED: bool(process.env.CRASH_PROTECT_ENABLED, true),
  DUMP_1M_PCT: num(process.env.DUMP_1M_PCT, 2.0),
  DUMP_5M_PCT: num(process.env.DUMP_5M_PCT, 4.0),
  CRASH_COOLDOWN_MIN: num(process.env.CRASH_COOLDOWN_MIN, 45),

  // EquityStab (loss streak protection)
  EQUITY_STAB_ENABLED: bool(process.env.EQUITY_STAB_ENABLED, true),
  LOSS2_COOLDOWN_MIN: num(process.env.LOSS2_COOLDOWN_MIN, 15),
  LOSS3_COOLDOWN_MIN: num(process.env.LOSS3_COOLDOWN_MIN, 45),
  CONSERVATIVE_COOLDOWN_MIN: num(process.env.CONSERVATIVE_COOLDOWN_MIN, 45),

  // 3Commas
  C3_WEBHOOK_URL: process.env.C3_WEBHOOK_URL || "https://api.3commas.io/signal_bots/webhooks",
  C3_BOT_UUID: process.env.C3_BOT_UUID || "",
  // accept either name to avoid future confusion
  C3_SIGNAL_SECRET: process.env.C3_SIGNAL_SECRET || process.env.C3_WEBHOOK_SECRET || "",
  C3_MAX_LAG_SEC: String(process.env.C3_MAX_LAG_SEC || "300"),
  C3_TIMEOUT_MS: int(process.env.C3_TIMEOUT_MS, 8000),

  LOG_JSON: bool(process.env.LOG_JSON, true),
};

function log(tag, obj={}) {
  const payload = { tag, t: new Date().toISOString(), ...obj };
  if (ENV.LOG_JSON) console.log(JSON.stringify(payload));
  else console.log(`[${payload.t}] ${tag}`, obj);
}

log("STARTUP_CONFIG", {
  port: ENV.PORT,
  path: ENV.WEBHOOK_PATH,
  enablePost3c: ENV.ENABLE_POST_3C,
  c3_bot_uuid_set: !!ENV.C3_BOT_UUID,
  c3_signal_secret_set: !!ENV.C3_SIGNAL_SECRET,
  crashProtect: ENV.CRASH_PROTECT_ENABLED,
  equityStab: ENV.EQUITY_STAB_ENABLED,
  profitLock: ENV.PROFIT_LOCK_ENABLED,
  adaptivePL: ENV.PROFIT_LOCK_ADAPTIVE,
});

/* ------------------------- Secret check ------------------------- */
function verifySecret(got, expected) {
  const a = Buffer.from(String(got || ""));
  const b = Buffer.from(String(expected || ""));
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

/* ------------------------- STATE (minimal v2.8.1 style) ------------------------- */
const STATE = {
  POSITION_SHORT: null, // { isOpen, exchange, instrument, pair, entryPrice, entryTs, trough, lastPrice, profitLockArmed, lastUpdateTs, plArmPct, plGivePct }
  ACT: {
    lastHeartbeatTs: 0,
    cooldownUntil: 0,
    crashCooldownUntil: 0,
    conservativeUntil: 0,
    lossesInRow: 0,
    lastTradePnlPct: null,
  },
  // tick ring buffers for 1m/5m dump detection + simple regime inference
  TICKS: [], // { ts, price }
};

/* ------------------------- 3Commas payload ------------------------- */
function build3CommasCustomSignal(action, evt) {
  return {
    secret: ENV.C3_SIGNAL_SECRET,
    max_lag: ENV.C3_MAX_LAG_SEC,
    timestamp: new Date(evt.ts).toISOString(),
    trigger_price: String(evt.price),
    tv_exchange: evt.exchange || "BINANCE",
    tv_instrument: evt.instrument, // SOLUSDT
    action, // enter_short / exit_short
    bot_uuid: ENV.C3_BOT_UUID,
  };
}

async function postTo3Commas(payload) {
  if (!ENV.C3_BOT_UUID || !ENV.C3_SIGNAL_SECRET) {
    return { ok: false, error: "missing_C3_BOT_UUID_or_C3_SIGNAL_SECRET" };
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
    const body = await r.text().catch(() => "");
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------- Normalization ------------------------- */
function toBotPair(symNoEx) {
  if (!symNoEx) return "UNKNOWN_PAIR";
  if (symNoEx.includes("_")) return symNoEx;
  const quotes = ["USDT","USD","BUSD","USDC","BTC","ETH"];
  for (const q of quotes) {
    if (symNoEx.endsWith(q) && symNoEx.length > q.length) {
      const base = symNoEx.slice(0, -q.length);
      return `${base}_${q}`;
    }
  }
  return symNoEx;
}

function normalizeWebhook(p) {
  const ts = toMs(p.time || p.timestamp) ?? Date.now();
  const src = safeStr(p.src || p.action || p.intent || "").toLowerCase();

  const rawSymbol = safeStr(p.symbol || "");
  const exchangeFromSymbol = rawSymbol.includes(":") ? rawSymbol.split(":")[0] : "";
  const instrumentFromSymbol = rawSymbol.includes(":") ? rawSymbol.split(":")[1] : rawSymbol;

  const exchange = safeStr(p.tv_exchange || exchangeFromSymbol || "BINANCE");
  const instrument = safeStr(p.tv_instrument || instrumentFromSymbol || "UNKNOWN");
  const pair = toBotPair(instrument);

  const price = num(p.price ?? p.trigger_price, NaN);

  return {
    ts,
    intent: src,
    exchange,
    instrument,
    pair,
    price,
    exitReason: safeStr(p.exitReason || ""),
  };
}

/* ------------------------- Tick storage + CrashProtect ------------------------- */
function pushTick(ts, price) {
  if (!Number.isFinite(price)) return;
  STATE.TICKS.push({ ts, price });

  // keep last 6 minutes
  const cutoff = ts - 6 * 60 * 1000;
  while (STATE.TICKS.length && STATE.TICKS[0].ts < cutoff) STATE.TICKS.shift();
}

function pctChange(from, to) {
  if (!Number.isFinite(from) || from === 0 || !Number.isFinite(to)) return NaN;
  return ((to - from) / from) * 100;
}

function findPriceAtOrBefore(targetTs) {
  // nearest tick at or before targetTs
  for (let i = STATE.TICKS.length - 1; i >= 0; i--) {
    if (STATE.TICKS[i].ts <= targetTs) return STATE.TICKS[i].price;
  }
  return null;
}

function crashProtectCheck(ts, currentPrice) {
  if (!ENV.CRASH_PROTECT_ENABLED) return { block: false, reason: "disabled" };

  const p1 = findPriceAtOrBefore(ts - 60 * 1000);
  const p5 = findPriceAtOrBefore(ts - 5 * 60 * 1000);

  const ch1 = p1 == null ? NaN : pctChange(p1, currentPrice);
  const ch5 = p5 == null ? NaN : pctChange(p5, currentPrice);

  // "dump" means price dropped (negative %). For short entries we want to AVOID entering after a violent dump.
  if (Number.isFinite(ch1) && ch1 <= -ENV.DUMP_1M_PCT) {
    return { block: true, reason: `dump1m(${round(ch1,2)}%)` };
  }
  if (Number.isFinite(ch5) && ch5 <= -ENV.DUMP_5M_PCT) {
    return { block: true, reason: `dump5m(${round(ch5,2)}%)` };
  }
  return { block: false, reason: "ok" };
}

/* ------------------------- Simple regime inference (ticks only) ------------------------- */
function inferRegime(ts, currentPrice) {
  // slope over last 3 minutes + volatility over last 3 minutes
  const p3 = findPriceAtOrBefore(ts - 3 * 60 * 1000);
  if (p3 == null) return { regime: "unknown", slopePct: 0, volPct: 0 };

  const slopePct = pctChange(p3, currentPrice); // over 3m
  // vol as max-min over last 3m
  const cutoff = ts - 3 * 60 * 1000;
  let minP = Infinity, maxP = -Infinity;
  for (const x of STATE.TICKS) {
    if (x.ts >= cutoff) {
      minP = Math.min(minP, x.price);
      maxP = Math.max(maxP, x.price);
    }
  }
  const volPct = (Number.isFinite(minP) && Number.isFinite(maxP) && minP > 0)
    ? ((maxP - minP) / minP) * 100
    : 0;

  // crude: trend if slope dominates vol
  const absSlope = Math.abs(slopePct);
  const regime = absSlope >= Math.max(0.15, volPct * 0.6) ? "trend" : "range";
  return { regime, slopePct, volPct };
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function computeAdaptiveProfitLock(ts, currentPrice) {
  const baseArm = ENV.PROFIT_LOCK_TRIGGER_PCT;
  const baseGive = ENV.PROFIT_LOCK_GIVEBACK_PCT;

  if (!ENV.PROFIT_LOCK_ADAPTIVE) {
    return {
      armPct: clamp(baseArm, ENV.PL_MIN_ARM, ENV.PL_MAX_ARM),
      givePct: clamp(baseGive, ENV.PL_MIN_GIVE, ENV.PL_MAX_GIVE),
      mode: "fixed",
    };
  }

  const { regime } = inferRegime(ts, currentPrice);
  const multArm = regime === "trend" ? ENV.TREND_MULT_ARM : ENV.RANGE_MULT_ARM;
  const multGive = regime === "trend" ? ENV.TREND_MULT_GIVE : ENV.RANGE_MULT_GIVE;

  const armPct = clamp(baseArm * multArm, ENV.PL_MIN_ARM, ENV.PL_MAX_ARM);
  const givePct = clamp(baseGive * multGive, ENV.PL_MIN_GIVE, ENV.PL_MAX_GIVE);

  return { armPct, givePct, mode: regime };
}

/* ------------------------- Profit lock mirror (short) ------------------------- */
function updateShortPositionOnTick(price, ts) {
  const p = STATE.POSITION_SHORT;
  if (!p?.isOpen) return;

  p.lastPrice = price;
  p.lastUpdateTs = ts;
  p.trough = Math.min(p.trough, price);

  if (!ENV.PROFIT_LOCK_ENABLED) return;

  const triggerAbs = (p.entryPrice * p.plArmPct) / 100;
  const moveInFavor = p.entryPrice - p.trough;

  if (!p.profitLockArmed && moveInFavor >= triggerAbs) {
    p.profitLockArmed = true;
    log("PROFIT_LOCK_ARMED", {
      entry: p.entryPrice,
      trough: p.trough,
      moveInFavor: round(moveInFavor, 4),
      armPct: p.plArmPct,
      givePct: p.plGivePct,
      mode: p.plMode,
    });
  }
}

function profitLockExitCheck(currentPrice) {
  const p = STATE.POSITION_SHORT;
  if (!p?.isOpen) return { shouldExit: false, detail: "no_position" };
  if (!ENV.PROFIT_LOCK_ENABLED) return { shouldExit: false, detail: "disabled" };
  if (!p.profitLockArmed) return { shouldExit: false, detail: "not_armed" };
  if (!Number.isFinite(currentPrice)) return { shouldExit: false, detail: "no_price" };

  const floor = p.trough * (1 + p.plGivePct / 100);
  if (currentPrice >= floor) {
    return { shouldExit: true, detail: `price=${round(currentPrice,4)}>=floor=${round(floor,4)} trough=${round(p.trough,4)}` };
  }
  return { shouldExit: false, detail: "hold" };
}

/* ------------------------- EquityStab ------------------------- */
function computeShortPnlPct(entry, exit) {
  // short PnL % approximated by (entry - exit)/entry * 100
  if (!Number.isFinite(entry) || entry === 0 || !Number.isFinite(exit)) return NaN;
  return ((entry - exit) / entry) * 100;
}

function equityStabOnClose(ts, pnlPct) {
  if (!ENV.EQUITY_STAB_ENABLED) return;

  if (!Number.isFinite(pnlPct)) return;

  STATE.ACT.lastTradePnlPct = pnlPct;

  if (pnlPct < 0) STATE.ACT.lossesInRow += 1;
  else STATE.ACT.lossesInRow = 0;

  if (STATE.ACT.lossesInRow >= 3) {
    STATE.ACT.conservativeUntil = Math.max(STATE.ACT.conservativeUntil, ts + msMin(ENV.CONSERVATIVE_COOLDOWN_MIN));
    STATE.ACT.cooldownUntil = Math.max(STATE.ACT.cooldownUntil, ts + msMin(ENV.LOSS3_COOLDOWN_MIN));
    log("EQUITY_STAB", { lossesInRow: STATE.ACT.lossesInRow, action: "loss3_cooldown", cooldownMin: ENV.LOSS3_COOLDOWN_MIN });
  } else if (STATE.ACT.lossesInRow === 2) {
    STATE.ACT.cooldownUntil = Math.max(STATE.ACT.cooldownUntil, ts + msMin(ENV.LOSS2_COOLDOWN_MIN));
    log("EQUITY_STAB", { lossesInRow: STATE.ACT.lossesInRow, action: "loss2_cooldown", cooldownMin: ENV.LOSS2_COOLDOWN_MIN });
  }
}

/* ------------------------- Core gates ------------------------- */
function canEnter(ts) {
  if (ENV.REQUIRE_FRESH_HEARTBEAT) {
    if (!STATE.ACT.lastHeartbeatTs) return { ok: false, reason: "no_heartbeat_seen" };
    const ageMs = ts - STATE.ACT.lastHeartbeatTs;
    if (ageMs > ENV.HEARTBEAT_MAX_AGE_SEC * 1000) return { ok: false, reason: "heartbeat_stale" };
  }

  if (STATE.POSITION_SHORT?.isOpen) return { ok: false, reason: "short_already_open" };

  if (ts < STATE.ACT.cooldownUntil) return { ok: false, reason: "cooldown_active" };
  if (ts < STATE.ACT.crashCooldownUntil) return { ok: false, reason: "crash_cooldown_active" };

  // conservative mode blocks entries too (optional)
  if (ts < STATE.ACT.conservativeUntil) return { ok: false, reason: "conservative_mode" };

  return { ok: true, reason: "ok" };
}

/* ------------------------- Position open/close ------------------------- */
function openShortPosition(evt) {
  const adaptive = computeAdaptiveProfitLock(evt.ts, evt.price);
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
    plArmPct: adaptive.armPct,
    plGivePct: adaptive.givePct,
    plMode: adaptive.mode,
  };
  log("POSITION_SHORT_OPEN", {
    pair: evt.pair,
    exchange: evt.exchange,
    instrument: evt.instrument,
    entryPrice: evt.price,
    entryTs: evt.ts,
    plArmPct: adaptive.armPct,
    plGivePct: adaptive.givePct,
    plMode: adaptive.mode,
  });
}

function closeShortPosition(ts, reason, exitPrice) {
  const p = STATE.POSITION_SHORT;
  if (!p?.isOpen) return;

  const px = Number.isFinite(exitPrice) ? exitPrice : p.lastPrice;
  const pnlPct = computeShortPnlPct(p.entryPrice, px);

  log("POSITION_SHORT_CLOSE", {
    reason,
    pair: p.pair,
    entryPrice: p.entryPrice,
    exitPrice: px,
    trough: p.trough,
    pnlPct: round(pnlPct, 4),
  });

  STATE.POSITION_SHORT = null;

  // base cooldown
  STATE.ACT.cooldownUntil = Math.max(STATE.ACT.cooldownUntil, ts + msMin(ENV.COOLDOWN_MIN));

  // equity stabilization
  equityStabOnClose(ts, pnlPct);
}

/* ------------------------- Express app ------------------------- */
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.status(200).send("OK: Brain SHORT (simple+v2.8.1 blocks)"));

app.get("/status", (_req, res) => {
  const now = Date.now();
  const p = STATE.POSITION_SHORT;
  const floor = p?.isOpen ? p.trough * (1 + (p.plGivePct ?? ENV.PROFIT_LOCK_GIVEBACK_PCT) / 100) : null;
  res.json({
    ok: true,
    now,
    position: p ? { ...p, floor } : null,
    act: STATE.ACT,
    ticks: { count: STATE.TICKS.length, oldestTs: STATE.TICKS[0]?.ts ?? null, newestTs: STATE.TICKS.at(-1)?.ts ?? null },
  });
});

app.post(ENV.WEBHOOK_PATH, async (req, res) => {
  try {
    const body = req.body || {};
    if (!verifySecret(body.secret, ENV.WEBHOOK_SECRET)) {
      log("UNAUTHORIZED", { hasSecret: !!body.secret });
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const evt = normalizeWebhook(body);

    log("WEBHOOK_IN", {
      intent: evt.intent,
      exchange: evt.exchange,
      instrument: evt.instrument,
      pair: evt.pair,
      price: evt.price,
      ts: evt.ts,
    });

    // tick buffer + heartbeat refresh
    if (evt.intent === "tick" && Number.isFinite(evt.price)) {
      STATE.ACT.lastHeartbeatTs = evt.ts;
      pushTick(evt.ts, evt.price);

      if (STATE.POSITION_SHORT?.isOpen) {
        updateShortPositionOnTick(evt.price, evt.ts);
        const pl = profitLockExitCheck(evt.price);
        if (pl.shouldExit) {
          // exit via profit lock
          const resp = await doExit(evt, `profit_lock_exit:${pl.detail}`);
          return res.json({ ok: true, action: "exit_short", auto: true, resp });
        }
      }

      return res.json({ ok: true, action: "tick" });
    }

    // enter_short
    if (evt.intent === "enter_short") {
      // crash protect check (using tick history)
      const crash = crashProtectCheck(evt.ts, evt.price);
      if (crash.block) {
        STATE.ACT.crashCooldownUntil = Math.max(
          STATE.ACT.crashCooldownUntil,
          evt.ts + msMin(ENV.CRASH_COOLDOWN_MIN)
        );
        log("CRASH_PROTECT_BLOCK", { reason: crash.reason, crashCooldownMin: ENV.CRASH_COOLDOWN_MIN });
        return res.json({ ok: true, action: "blocked", reason: `crash_protect:${crash.reason}` });
      }

      const gate = canEnter(evt.ts);
      if (!gate.ok) {
        log("ENTER_BLOCKED", { reason: gate.reason });
        return res.json({ ok: true, action: "blocked", reason: gate.reason });
      }

      openShortPosition(evt);

      if (!ENV.ENABLE_POST_3C) return res.json({ ok: true, action: "enter_short", posted: false });

      const payload = build3CommasCustomSignal("enter_short", evt);
      log("3COMMAS_POST", {
        action: "enter_short",
        url: ENV.C3_WEBHOOK_URL,
        payload: { ...payload, secret: "***" },
      });

      const resp = await postTo3Commas(payload);
      log("3COMMAS_RESP", { action: "enter_short", resp });

      // if 3Commas failed, close internal position (prevents desync)
      if (!resp.ok) {
        closeShortPosition(evt.ts, "3commas_post_failed", evt.price);
        return res.json({ ok: false, action: "enter_short_failed", resp });
      }

      return res.json({ ok: true, action: "enter_short", resp });
    }

    // exit_short
    if (evt.intent === "exit_short") {
      const resp = await doExit(evt, evt.exitReason || "signal_exit");
      return res.json({ ok: true, action: "exit_short", resp });
    }

    return res.status(200).json({ ok: true, action: "ignored", reason: "unknown_intent", got: evt.intent });
  } catch (e) {
    console.error("ERROR in /webhook:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

async function doExit(evt, reason) {
  if (!STATE.POSITION_SHORT?.isOpen) {
    log("EXIT_IGNORED", { reason: "no_open_short", wanted: reason });
    return { ok: true, ignored: true, reason: "no_open_short" };
  }

  // close internal first (so even if 3Commas hangs, state is safe)
  closeShortPosition(evt.ts, reason, evt.price);

  if (!ENV.ENABLE_POST_3C) return { ok: true, posted: false };

  const payload = build3CommasCustomSignal("exit_short", evt);
  log("3COMMAS_POST", { action: "exit_short", url: ENV.C3_WEBHOOK_URL, payload: { ...payload, secret: "***" } });

  const resp = await postTo3Commas(payload);
  log("3COMMAS_RESP", { action: "exit_short", resp });

  return resp;
}

/* ------------------------- START ------------------------- */
app.listen(ENV.PORT, () => {
  log("LISTENING", { port: ENV.PORT, path: ENV.WEBHOOK_PATH });
});
