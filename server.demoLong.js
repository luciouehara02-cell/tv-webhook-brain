/**
 * Brain v2.9.5-LONG (DEMO/ACT compatible)
 * - Handles: tick | ready (ready_long) | enter_long | exit_long
 * - READY gate + drift/TTL + auto-expire
 * - Emergency-friendly: if enter_long arrives with price=0, uses lastTickPrice (no “PendingBUY” delay)
 * - If no tick seen yet, stores PendingBUY for 120s and executes on next tick
 * - 3Commas payload FIXED to match the working format:
 *   { secret, bot_uuid, action, tv_exchange, tv_instrument, trigger_price, timestamp, max_lag }
 *
 * ENV (minimum):
 *  PORT=8080
 *  WEBHOOK_SECRET=...                 // this Brain’s inbound secret
 *  ENABLE_POST_3C=true
 *  C3_BOT_UUID=...
 *  C3_SIGNAL_SECRET=...               // 3Commas signal secret
 *
 * Optional ENV:
 *  WEBHOOK_PATH=/webhook
 *  REQUIRE_FRESH_HEARTBEAT=true
 *  HEARTBEAT_MAX_AGE_SEC=240
 *  READY_ENABLED=true
 *  READY_TTL_MIN=30
 *  READY_MAX_MOVE_PCT=1.2
 *  READY_AUTOEXPIRE_ENABLED=true
 *  READY_AUTOEXPIRE_PCT=1.2
 *  READY_ACCEPT_LEGACY_READY=true     // accept src:"ready" as ready_long
 *  PENDING_TTL_SEC=120
 *  COOLDOWN_MIN=3
 *  LOG_JSON=true
 *  C3_MAX_LAG_SEC=300
 *  C3_TIMEOUT_MS=8000
 */

import express from "express";
import crypto from "crypto";

process.on("unhandledRejection", (err) => console.error("[FATAL] unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("[FATAL] uncaughtException:", err));

/* ------------------------- helpers ------------------------- */
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

function verifySecret(got, expected) {
  const a = Buffer.from(String(got || ""));
  const b = Buffer.from(String(expected || ""));
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}
function extractSecret(payload) {
  return String(payload?.secret ?? payload?.tv_secret ?? payload?.passphrase ?? payload?.token ?? "");
}

function normalizeIntent(p) {
  const a = safeStr(p.action).toLowerCase().trim();
  const i = safeStr(p.intent).toLowerCase().trim();
  const s = safeStr(p.src).toLowerCase().trim();
  return a || i || s;
}

// returns { ex:"BINANCE", inst:"SOLUSDT" } for "BINANCE:SOLUSDT" or {ex:"BINANCE",inst:"SOLUSDT"} for "SOLUSDT"
function splitSymbol(sym) {
  const s = String(sym || "");
  if (s.includes(":")) {
    const [ex, inst] = s.split(":");
    return { ex: ex || "BINANCE", inst: inst || "" };
  }
  return { ex: "BINANCE", inst: s };
}

function normalizeWebhook(p) {
  const ts = toMs(p.time || p.timestamp) ?? Date.now();
  const intent = normalizeIntent(p);

  const rawSymbol = safeStr(p.symbol || "");
  const { ex, inst } = splitSymbol(rawSymbol);

  const exchange = safeStr(p.tv_exchange || ex || "BINANCE");
  const instrument = safeStr(p.tv_instrument || inst || "SOLUSDT");

  // keep original "BINANCE:SOLUSDT" for logging
  const symbol = rawSymbol || `${exchange}:${instrument}`;

  const price = num(p.price ?? p.trigger_price ?? p.close, NaN);

  return {
    ts,
    intent,
    symbol,
    exchange,
    instrument,
    price,
    exitReason: safeStr(p.exitReason || ""),
  };
}

/* ------------------------- ENV ------------------------- */
const ENV = {
  PORT: int(process.env.PORT, 8080),
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "CHANGE_ME_TO_RANDOM_40+CHARS",
  WEBHOOK_PATH: process.env.WEBHOOK_PATH || "/webhook",

  LOG_JSON: bool(process.env.LOG_JSON, true),

  REQUIRE_FRESH_HEARTBEAT: bool(process.env.REQUIRE_FRESH_HEARTBEAT, true),
  HEARTBEAT_MAX_AGE_SEC: num(process.env.HEARTBEAT_MAX_AGE_SEC, 240),

  COOLDOWN_MIN: num(process.env.COOLDOWN_MIN, 3),

  READY_ENABLED: bool(process.env.READY_ENABLED, true),
  READY_TTL_MIN: num(process.env.READY_TTL_MIN, 30),
  READY_MAX_MOVE_PCT: num(process.env.READY_MAX_MOVE_PCT, 1.2),
  READY_AUTOEXPIRE_ENABLED: bool(process.env.READY_AUTOEXPIRE_ENABLED, true),
  READY_AUTOEXPIRE_PCT: num(process.env.READY_AUTOEXPIRE_PCT, 1.2),
  READY_ACCEPT_LEGACY_READY: bool(process.env.READY_ACCEPT_LEGACY_READY, true),

  PENDING_TTL_SEC: num(process.env.PENDING_TTL_SEC, 120),

  ENABLE_POST_3C: bool(process.env.ENABLE_POST_3C, false),
  C3_WEBHOOK_URL: process.env.C3_WEBHOOK_URL || "https://api.3commas.io/signal_bots/webhooks",
  C3_BOT_UUID: process.env.C3_BOT_UUID || "",
  C3_SIGNAL_SECRET: process.env.C3_SIGNAL_SECRET || process.env.C3_WEBHOOK_SECRET || "",
  C3_MAX_LAG_SEC: String(process.env.C3_MAX_LAG_SEC || "300"),
  C3_TIMEOUT_MS: int(process.env.C3_TIMEOUT_MS, 8000),
};

// BOOT log (safe suffix only)
console.log(
  `[BOOT] LONG brain listening soon | WEBHOOK_SECRET suffix=${String(ENV.WEBHOOK_SECRET || "").slice(-6)} len=${String(ENV.WEBHOOK_SECRET || "").length}`
);

function log(tag, obj = {}) {
  const payload = { tag, t: new Date().toISOString(), ...obj };
  if (ENV.LOG_JSON) console.log(JSON.stringify(payload));
  else console.log(`[${payload.t}] ${tag}`, obj);
}

log("STARTUP_CONFIG", {
  brain: "v2.9.5-LONG",
  port: ENV.PORT,
  path: ENV.WEBHOOK_PATH,
  enablePost3c: ENV.ENABLE_POST_3C,
  c3_bot_uuid_set: !!ENV.C3_BOT_UUID,
  c3_signal_secret_set: !!ENV.C3_SIGNAL_SECRET,
  readyEnabled: ENV.READY_ENABLED,
});

/* ------------------------- STATE ------------------------- */
const STATE = {
  lastTickMs: 0,
  lastTickPrice: NaN,
  lastTickSymbol: "",

  READY_LONG: null, // { on,id,ts,symbol,price,expiresAt }
  POSITION_LONG: null, // { isOpen, symbol, entryPrice, entryTs }
  cooldownUntil: 0,

  // pending enter when price is missing/0 AND we have no lastTickPrice
  PENDING_BUY: null, // { id, symbol, ts, expiresAt }
};

/* ------------------------- READY ------------------------- */
function setReadyLong(evt) {
  const ttlMs = ENV.READY_TTL_MIN > 0 ? msMin(ENV.READY_TTL_MIN) : 0;
  const expiresAt = ttlMs > 0 ? evt.ts + ttlMs : 0;
  STATE.READY_LONG = {
    on: true,
    id: uid(),
    ts: evt.ts,
    symbol: evt.symbol,
    price: evt.price,
    expiresAt,
  };
  log("READY_LONG_ON", {
    readyPrice: evt.price,
    readySymbol: evt.symbol,
    READY_MAX_MOVE_PCT: ENV.READY_MAX_MOVE_PCT,
    READY_AUTOEXPIRE_ENABLED: ENV.READY_AUTOEXPIRE_ENABLED,
    READY_AUTOEXPIRE_PCT: ENV.READY_AUTOEXPIRE_PCT,
    expiresAt: expiresAt || null,
  });
}

function clearReady(reason) {
  if (!STATE.READY_LONG) return;
  log("READY_LONG_OFF", { reason, ready: STATE.READY_LONG });
  STATE.READY_LONG = null;
}

function readyTTLExpireCheck(nowTs) {
  if (!ENV.READY_ENABLED) return;
  if (!STATE.READY_LONG?.on) return;
  if (!STATE.READY_LONG.expiresAt) return;
  if (nowTs >= STATE.READY_LONG.expiresAt) clearReady("ttl_expired");
}

function pctDiff(a, b) {
  if (!Number.isFinite(a) || a === 0 || !Number.isFinite(b)) return NaN;
  return (Math.abs(b - a) / Math.abs(a)) * 100.0;
}

function maybeAutoExpireReadyOnTick(evt) {
  if (!ENV.READY_ENABLED) return;
  if (!ENV.READY_AUTOEXPIRE_ENABLED) return;
  if (!STATE.READY_LONG?.on) return;
  if (STATE.POSITION_LONG?.isOpen) return;
  if (!Number.isFinite(evt.price)) return;

  if (STATE.READY_LONG.symbol !== evt.symbol) return;

  const d = pctDiff(STATE.READY_LONG.price, evt.price);
  if (!Number.isFinite(d)) return;

  if (d > ENV.READY_AUTOEXPIRE_PCT) clearReady(`autoexpire_drift_${round(d, 3)}%`);
}

function gateEnterByReady(evt) {
  if (!ENV.READY_ENABLED) return { ok: true, reason: "ready_disabled" };
  if (!STATE.READY_LONG?.on) return { ok: false, reason: "not_ready_long" };

  // heartbeat freshness
  if (ENV.REQUIRE_FRESH_HEARTBEAT) {
    if (!STATE.lastTickMs) return { ok: false, reason: "no_tick_seen" };
    const ageMs = evt.ts - STATE.lastTickMs;
    if (ageMs > ENV.HEARTBEAT_MAX_AGE_SEC * 1000) return { ok: false, reason: "tick_stale" };
  }

  // symbol match
  if (STATE.READY_LONG.symbol !== evt.symbol) return { ok: false, reason: "ready_symbol_mismatch" };

  // drift gate (requires READY price to be non-zero)
  if (!Number.isFinite(STATE.READY_LONG.price) || STATE.READY_LONG.price <= 0 || !Number.isFinite(evt.price)) {
    return { ok: true, reason: "skip_drift_no_ready_price" };
  }

  const d = pctDiff(STATE.READY_LONG.price, evt.price);
  if (!Number.isFinite(d)) return { ok: true, reason: "skip_drift_bad_calc" };

  if (d > ENV.READY_MAX_MOVE_PCT) {
    clearReady(`hard_reset_drift_${round(d,3)}%`);
    return { ok: false, reason: `ready_drift_reset_${round(d,3)}%` };
  }
  return { ok: true, reason: "ready_ok", driftPct: d };
}

/* ------------------------- 3Commas ------------------------- */
async function postTo3Commas(payload) {
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
    return { ok: false, status: 0, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// Build payload EXACTLY like your working PowerShell example
function build3CommasSignal(action, evt) {
  const { ex, inst } = splitSymbol(evt.symbol || `${evt.exchange}:${evt.instrument}`);
  return {
    secret: ENV.C3_SIGNAL_SECRET,
    bot_uuid: ENV.C3_BOT_UUID,
    action, // enter_long | exit_long
    tv_exchange: String(ex || "BINANCE"),
    tv_instrument: String(inst || evt.instrument || "SOLUSDT"),
    trigger_price: String(evt.price),
    timestamp: new Date(evt.ts).toISOString(),
    max_lag: ENV.C3_MAX_LAG_SEC,
  };
}

/* ------------------------- core actions ------------------------- */
function canEnter(ts) {
  if (STATE.POSITION_LONG?.isOpen) return { ok: false, reason: "already_in_long" };
  if (ts < STATE.cooldownUntil) return { ok: false, reason: "cooldown_active" };
  return { ok: true, reason: "ok" };
}

function openLong(evt) {
  STATE.POSITION_LONG = {
    isOpen: true,
    symbol: evt.symbol,
    entryPrice: evt.price,
    entryTs: evt.ts,
  };
  log("POSITION_LONG_OPEN", { symbol: evt.symbol, entryPrice: evt.price, entryTs: evt.ts });
}

function closeLong(ts, reason, exitPrice) {
  const p = STATE.POSITION_LONG;
  if (!p?.isOpen) return;
  log("POSITION_LONG_CLOSE", {
    reason,
    symbol: p.symbol,
    entryPrice: p.entryPrice,
    exitPrice: exitPrice,
    pnlPct: (Number.isFinite(exitPrice) && Number.isFinite(p.entryPrice) && p.entryPrice !== 0)
      ? round(((exitPrice - p.entryPrice) / p.entryPrice) * 100, 4)
      : null,
  });
  STATE.POSITION_LONG = null;
  STATE.cooldownUntil = Math.max(STATE.cooldownUntil, ts + msMin(ENV.COOLDOWN_MIN));
}

function storePendingBuy(evt) {
  const expiresAt = evt.ts + ENV.PENDING_TTL_SEC * 1000;
  STATE.PENDING_BUY = { id: uid(), symbol: evt.symbol, ts: evt.ts, expiresAt };
  log("PENDING_BUY_STORED", { ttlSec: ENV.PENDING_TTL_SEC, symbol: evt.symbol, expiresAt });
}

async function executeEnterLong(evt, why="manual") {
  // READY gate first
  readyTTLExpireCheck(evt.ts);

  const gateCore = canEnter(evt.ts);
  if (!gateCore.ok) {
    log("ENTER_BLOCKED", { reason: gateCore.reason });
    return { ok: true, action: "blocked", reason: gateCore.reason };
  }

  const gateReady = gateEnterByReady(evt);
  if (!gateReady.ok) {
    log("ENTER_BLOCKED_READY", { reason: gateReady.reason });
    return { ok: true, action: "blocked", reason: gateReady.reason };
  }

  // consume ready when entering
  clearReady("entered_long");

  openLong(evt);

  if (!ENV.ENABLE_POST_3C) return { ok: true, action: "enter_long", posted: false };

  if (!ENV.C3_BOT_UUID || !ENV.C3_SIGNAL_SECRET) {
    log("3COMMAS_MISSING_ENV", { bot_uuid_set: !!ENV.C3_BOT_UUID, secret_set: !!ENV.C3_SIGNAL_SECRET });
    // avoid desync: close internal position if cannot post
    closeLong(evt.ts, "missing_3commas_env", evt.price);
    return { ok: false, action: "enter_long_failed", reason: "missing_3commas_env" };
  }

  const out = build3CommasSignal("enter_long", evt);
  console.log("🧾 3Commas OUT enter_long:", { ...out, secret: "***" });

  const resp = await postTo3Commas(out);
  log("3COMMAS_RESP", { action: "enter_long", resp });

  if (!resp.ok) {
    closeLong(evt.ts, "3commas_post_failed", evt.price);
    return { ok: false, action: "enter_long_failed", resp };
  }
  return { ok: true, action: "enter_long", resp };
}

async function executeExitLong(evt, reason="manual") {
  if (!STATE.POSITION_LONG?.isOpen) {
    log("EXIT_IGNORED", { reason: "no_open_long", wanted: reason });
    return { ok: true, ignored: true };
  }

  closeLong(evt.ts, reason, evt.price);

  if (!ENV.ENABLE_POST_3C) return { ok: true, action: "exit_long", posted: false };

  if (!ENV.C3_BOT_UUID || !ENV.C3_SIGNAL_SECRET) {
    log("3COMMAS_MISSING_ENV", { bot_uuid_set: !!ENV.C3_BOT_UUID, secret_set: !!ENV.C3_SIGNAL_SECRET });
    return { ok: false, action: "exit_long_failed", reason: "missing_3commas_env" };
  }

  const out = build3CommasSignal("exit_long", evt);
  console.log("🧾 3Commas OUT exit_long:", { ...out, secret: "***" });

  const resp = await postTo3Commas(out);
  log("3COMMAS_RESP", { action: "exit_long", resp });

  return { ok: true, action: "exit_long", resp };
}

/* ------------------------- Express ------------------------- */
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.status(200).send("OK: Brain LONG v2.9.5"));
app.get("/status", (_req, res) => {
  res.json({
    ok: true,
    now: Date.now(),
    lastTickMs: STATE.lastTickMs,
    lastTickPrice: STATE.lastTickPrice,
    lastTickSymbol: STATE.lastTickSymbol,
    readyLong: STATE.READY_LONG,
    positionLong: STATE.POSITION_LONG,
    cooldownUntil: STATE.cooldownUntil,
    pendingBuy: STATE.PENDING_BUY,
    env: {
      READY_ENABLED: ENV.READY_ENABLED,
      READY_TTL_MIN: ENV.READY_TTL_MIN,
      READY_MAX_MOVE_PCT: ENV.READY_MAX_MOVE_PCT,
      READY_AUTOEXPIRE_ENABLED: ENV.READY_AUTOEXPIRE_ENABLED,
      READY_AUTOEXPIRE_PCT: ENV.READY_AUTOEXPIRE_PCT,
      ENABLE_POST_3C: ENV.ENABLE_POST_3C,
      C3_BOT_UUID_set: !!ENV.C3_BOT_UUID,
      C3_SIGNAL_SECRET_set: !!ENV.C3_SIGNAL_SECRET,
    },
  });
});

app.post(ENV.WEBHOOK_PATH, async (req, res) => {
  try {
    const body = req.body || {};

    const gotSecret = extractSecret(body);
    if (!verifySecret(gotSecret, ENV.WEBHOOK_SECRET)) {
      log("UNAUTHORIZED", { hasSecret: !!gotSecret });
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const evt = normalizeWebhook(body);

    log("WEBHOOK_IN", {
      intent: evt.intent,
      symbol: evt.symbol,
      price: evt.price,
      ts: evt.ts,
    });

    // ---- tick (heartbeat) ----
    if (evt.intent === "tick") {
      if (Number.isFinite(evt.price)) {
        STATE.lastTickMs = evt.ts;
        STATE.lastTickPrice = evt.price;
        STATE.lastTickSymbol = evt.symbol;

        // READY autoexpire based on drift
        maybeAutoExpireReadyOnTick(evt);

        // if pending buy exists and matches symbol and not expired => execute now
        if (STATE.PENDING_BUY?.symbol === evt.symbol) {
          if (evt.ts <= STATE.PENDING_BUY.expiresAt) {
            const pendingId = STATE.PENDING_BUY.id;
            STATE.PENDING_BUY = null;

            // fabricate an enter_long using tick price
            const enterEvt = { ...evt, intent: "enter_long", price: evt.price };
            log("PENDING_BUY_EXECUTE_ON_TICK", { pendingId, price: evt.price, symbol: evt.symbol });

            const resp = await executeEnterLong(enterEvt, "pending_buy_on_tick");
            return res.json({ ok: true, action: "tick+pending_enter_long", resp });
          } else {
            log("PENDING_BUY_EXPIRED", { pending: STATE.PENDING_BUY });
            STATE.PENDING_BUY = null;
          }
        }
      }
      return res.json({ ok: true, action: "tick" });
    }

    // ---- ready (legacy) / ready_long ----
    if (
      evt.intent === "ready_long" ||
      (ENV.READY_ACCEPT_LEGACY_READY && evt.intent === "ready")
    ) {
      if (!ENV.READY_ENABLED) return res.json({ ok: true, action: "ready_ignored", reason: "ready_disabled" });

      // require fresh tick (optional)
      if (ENV.REQUIRE_FRESH_HEARTBEAT) {
        if (!STATE.lastTickMs) {
          log("READY_IGNORED", { reason: "no_tick_seen" });
          return res.json({ ok: true, action: "ready_ignored", reason: "no_tick_seen" });
        }
        const ageMs = evt.ts - STATE.lastTickMs;
        if (ageMs > ENV.HEARTBEAT_MAX_AGE_SEC * 1000) {
          log("READY_IGNORED", { reason: "tick_stale" });
          return res.json({ ok: true, action: "ready_ignored", reason: "tick_stale" });
        }
      }

      setReadyLong(evt);
      return res.json({ ok: true, action: "ready_long", ready: STATE.READY_LONG });
    }

    // ---- enter_long ----
    if (evt.intent === "enter_long") {
      // IMPORTANT: emergency-friendly price handling
      // If price is missing/0, use lastTickPrice immediately (prevents “PendingBUY” unless no tick yet)
      const px =
        (Number.isFinite(evt.price) && evt.price > 0) ? evt.price :
        (Number.isFinite(STATE.lastTickPrice) ? STATE.lastTickPrice : NaN);

      if (!Number.isFinite(px) || px <= 0) {
        // no tick seen yet → pending
        storePendingBuy(evt);
        return res.json({ ok: true, action: "pending_enter_long", ttlSec: ENV.PENDING_TTL_SEC });
      }

      const enterEvt = { ...evt, price: px };
      const resp = await executeEnterLong(enterEvt, evt.exitReason || "signal_enter");
      return res.json(resp);
    }

    // ---- exit_long ----
    if (evt.intent === "exit_long") {
      const px =
        (Number.isFinite(evt.price) && evt.price > 0) ? evt.price :
        (Number.isFinite(STATE.lastTickPrice) ? STATE.lastTickPrice : NaN);

      const exitEvt = { ...evt, price: Number.isFinite(px) ? px : evt.price };
      const resp = await executeExitLong(exitEvt, evt.exitReason || "signal_exit");
      return res.json(resp);
    }

    return res.status(200).json({ ok: true, action: "ignored", reason: "unknown_intent", got: evt.intent });
  } catch (e) {
    console.error("ERROR in webhook:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.listen(ENV.PORT, () => {
  log("LISTENING", { port: ENV.PORT, path: ENV.WEBHOOK_PATH, brain: "v2.9.5-LONG" });
});
