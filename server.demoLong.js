/**
 * Brain v2.9.6-LONG — READY + PendingBUY + ReEntry fix + 3Commas (working payload)
 *
 * INPUT (TickRouter/TradingView -> Brain):
 *  {
 *    "secret": "...",
 *    "src"|"action"|"intent": "tick" | "ready" | "ready_long" | "enter_long" | "exit_long",
 *    "symbol": "BINANCE:SOLUSDT",
 *    "price": "83.60" | "0",
 *    "time": "2026-03-01T21:25:42Z",
 *    "exitReason": "emergency" // optional
 *  }
 *
 * OUTPUT (Brain -> 3Commas Signal Bot Webhook) EXACT format:
 *  {
 *    "secret": "...",
 *    "bot_uuid": "...",
 *    "action": "enter_long" | "exit_long",
 *    "tv_exchange": "BINANCE",
 *    "tv_instrument": "SOLUSDT",
 *    "trigger_price": "82.75",
 *    "timestamp": "2026-03-01T21:25:42Z",
 *    "max_lag": "300"
 *  }
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

function log(tag, obj={}) {
  const payload = { tag, t: new Date().toISOString(), ...obj };
  if (ENV.LOG_JSON) console.log(JSON.stringify(payload));
  else console.log(`[${payload.t}] ${tag}`, obj);
}

/* ------------------------- ENV ------------------------- */
const ENV = {
  PORT: int(process.env.PORT, 8080),
  WEBHOOK_PATH: process.env.WEBHOOK_PATH || "/webhook",
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "CHANGE_ME_TO_RANDOM_40+CHARS",

  LOG_JSON: bool(process.env.LOG_JSON, true),

  // Heartbeat
  REQUIRE_FRESH_HEARTBEAT: bool(process.env.REQUIRE_FRESH_HEARTBEAT, true),
  HEARTBEAT_MAX_AGE_SEC: num(process.env.HEARTBEAT_MAX_AGE_SEC, 240),

  // READY
  READY_TTL_MIN: num(process.env.READY_TTL_MIN, 30),
  READY_MAX_MOVE_PCT: num(process.env.READY_MAX_MOVE_PCT, 1.2),
  READY_AUTOEXPIRE_ENABLED: bool(process.env.READY_AUTOEXPIRE_ENABLED, true),
  READY_AUTOEXPIRE_PCT: num(process.env.READY_AUTOEXPIRE_PCT, 1.2),
  READY_ACCEPT_LEGACY_READY: bool(process.env.READY_ACCEPT_LEGACY_READY, true), // accept action/src "ready"

  // Cooldown
  EXIT_COOLDOWN_MIN: num(process.env.EXIT_COOLDOWN_MIN, 3),

  // PendingBUY
  PENDING_BUY_ENABLED: bool(process.env.PENDING_BUY_ENABLED, true),
  PENDING_BUY_WINDOW_SEC: num(process.env.PENDING_BUY_WINDOW_SEC, 120),
  PENDING_BUY_MAX_READY_DRIFT_PCT: num(process.env.PENDING_BUY_MAX_READY_DRIFT_PCT, 0.30),

  // ReEntry (restore v2.9.4 behavior)
  REENTRY_ENABLED: bool(process.env.REENTRY_ENABLED, true),
  REENTRY_WINDOW_MIN: num(process.env.REENTRY_WINDOW_MIN, 30),
  REENTRY_MAX_TRIES: int(process.env.REENTRY_MAX_TRIES, 1),
  REENTRY_SKIP_START_IF_EXIT_PNL_LE_PCT: num(process.env.REENTRY_SKIP_START_IF_EXIT_PNL_LE_PCT, -0.35),
  REENTRY_CANCEL_ON_BREACH: bool(process.env.REENTRY_CANCEL_ON_BREACH, true),
  REENTRY_REQUIRE_READY: bool(process.env.REENTRY_REQUIRE_READY, false),

  // 3Commas enable
  ENABLE_POST_3C: bool(process.env.ENABLE_POST_3C, false),
  // accept BOTH naming styles:
  C3_WEBHOOK_URL: process.env.C3_WEBHOOK_URL
    || process.env.THREECOMMAS_WEBHOOK_URL
    || "https://api.3commas.io/signal_bots/webhooks",
  C3_BOT_UUID: process.env.C3_BOT_UUID
    || process.env.THREECOMMAS_BOT_UUID
    || "",
  C3_SIGNAL_SECRET: process.env.C3_SIGNAL_SECRET
    || process.env.C3_WEBHOOK_SECRET
    || process.env.THREECOMMAS_SECRET
    || "",
  C3_MAX_LAG_SEC: String(process.env.C3_MAX_LAG_SEC || "300"),
  C3_TIMEOUT_MS: int(process.env.C3_TIMEOUT_MS, 8000),
};

/* ------------------------- secret check ------------------------- */
function verifySecret(got, expected) {
  const a = Buffer.from(String(got || ""));
  const b = Buffer.from(String(expected || ""));
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

/* ------------------------- state ------------------------- */
const STATE = {
  lastTickTs: 0,
  lastTickPrice: NaN,
  lastSymbol: "",

  READY_LONG: null, // {on,id,ts,symbol,readyPrice,expiresAt}
  POSITION_LONG: null, // {isOpen, entryPrice, entryTs, peak, lastPrice, lastUpdateTs}

  // pending entry when price=0 and no ticks yet
  PENDING_BUY: null, // {id, ts, expiresAt, symbol, src, action, requestedPrice, exitReason}

  // cooldown + reentry context
  cooldownUntil: 0,

  lastExit: null, // {ts, symbol, pnlPct, price}
  reentryTriesUsed: 0,
};

/* ------------------------- normalize incoming ------------------------- */
function normalizeIntent(p) {
  const a = safeStr(p.action).toLowerCase().trim();
  const i = safeStr(p.intent).toLowerCase().trim();
  const s = safeStr(p.src).toLowerCase().trim();
  return a || i || s;
}

function parseSymbol(symbol) {
  const raw = safeStr(symbol || "");
  const parts = raw.includes(":") ? raw.split(":") : ["", raw];
  const tv_exchange = (parts[0] || "BINANCE").toUpperCase();
  const tv_instrument = (parts[1] || "UNKNOWN").toUpperCase();
  return { tv_exchange, tv_instrument };
}

function normalizeWebhook(p) {
  const ts = toMs(p.time || p.timestamp) ?? Date.now();
  const intent = normalizeIntent(p);

  const symbol = safeStr(p.symbol || "");
  const { tv_exchange, tv_instrument } = parseSymbol(symbol);

  let price = num(p.price ?? p.trigger_price ?? p.close, NaN);
  // Treat 0 or negative as "not a real price"
  if (!Number.isFinite(price) || price <= 0) price = 0;

  return {
    ts,
    intent,
    symbol,
    tv_exchange,
    tv_instrument,
    price,
    exitReason: safeStr(p.exitReason || p.reason || ""),
  };
}

/* ------------------------- READY helpers ------------------------- */
function clearReady(reason) {
  if (!STATE.READY_LONG) return;
  log("READY_LONG_CLEARED", { reason, ready: STATE.READY_LONG });
  STATE.READY_LONG = null;
}

function setReady(evt, readyPrice) {
  const ttlMs = ENV.READY_TTL_MIN > 0 ? msMin(ENV.READY_TTL_MIN) : 0;
  const expiresAt = ttlMs > 0 ? (evt.ts + ttlMs) : 0;
  STATE.READY_LONG = {
    on: true,
    id: uid(),
    ts: evt.ts,
    symbol: evt.symbol,
    readyPrice,
    expiresAt,
  };
  log("READY_LONG_ON", {
    readyPrice,
    readySymbol: evt.symbol,
    READY_MAX_MOVE_PCT: ENV.READY_MAX_MOVE_PCT,
    READY_AUTOEXPIRE_ENABLED: ENV.READY_AUTOEXPIRE_ENABLED,
    READY_AUTOEXPIRE_PCT: ENV.READY_AUTOEXPIRE_PCT,
  });
}

function readyTTLExpireCheck(nowTs) {
  if (!STATE.READY_LONG?.on) return;
  if (!STATE.READY_LONG.expiresAt) return;
  if (nowTs >= STATE.READY_LONG.expiresAt) clearReady("ttl_expired");
}

function pctDiff(a, b) {
  if (!Number.isFinite(a) || a === 0 || !Number.isFinite(b)) return NaN;
  return (Math.abs(b - a) / Math.abs(a)) * 100.0;
}

function maybeAutoExpireReadyOnTick(evt) {
  if (!ENV.READY_AUTOEXPIRE_ENABLED) return;
  if (!STATE.READY_LONG?.on) return;
  if (STATE.POSITION_LONG?.isOpen) return;
  if (STATE.READY_LONG.symbol !== evt.symbol) return;
  if (!Number.isFinite(evt.price) || evt.price <= 0) return;

  const d = pctDiff(STATE.READY_LONG.readyPrice, evt.price);
  if (Number.isFinite(d) && d > ENV.READY_AUTOEXPIRE_PCT) {
    clearReady(`autoexpire_drift_${round(d,3)}%`);
  }
}

function gateEnterByReady(evt, px) {
  if (!STATE.READY_LONG?.on) return { ok: false, reason: "not_ready_long" };
  if (STATE.READY_LONG.symbol !== evt.symbol) return { ok: false, reason: "ready_symbol_mismatch" };

  const d = pctDiff(STATE.READY_LONG.readyPrice, px);
  if (!Number.isFinite(d)) return { ok: false, reason: "bad_drift_calc" };

  if (d > ENV.READY_MAX_MOVE_PCT) {
    clearReady(`hard_reset_drift_${round(d,3)}%`);
    return { ok: false, reason: `ready_drift_reset_${round(d,3)}%` };
  }
  return { ok: true, reason: "ready_ok", driftPct: d };
}

/* ------------------------- position + PnL ------------------------- */
function computeLongPnlPct(entry, exit) {
  if (!Number.isFinite(entry) || entry === 0 || !Number.isFinite(exit)) return NaN;
  return ((exit - entry) / entry) * 100;
}

function openLong(evt, px) {
  STATE.POSITION_LONG = {
    isOpen: true,
    symbol: evt.symbol,
    entryPrice: px,
    entryTs: evt.ts,
    peak: px,
    lastPrice: px,
    lastUpdateTs: evt.ts,
  };
  log("ENTER_LONG", { symbol: evt.symbol, entryPrice: px, ts: evt.ts });
}

function closeLong(evt, reason, px) {
  const p = STATE.POSITION_LONG;
  if (!p?.isOpen) return;

  const exitPx = Number.isFinite(px) && px > 0 ? px : p.lastPrice;
  const pnlPct = computeLongPnlPct(p.entryPrice, exitPx);

  log("EXIT_LONG", {
    reason,
    symbol: p.symbol,
    entryPrice: p.entryPrice,
    exitPrice: exitPx,
    peak: p.peak,
    pnlPct: round(pnlPct, 4),
  });

  // record last exit for reentry logic
  STATE.lastExit = { ts: evt.ts, symbol: p.symbol, pnlPct, price: exitPx };
  STATE.reentryTriesUsed = 0;

  STATE.POSITION_LONG = null;

  // cooldown starts after exit
  STATE.cooldownUntil = Math.max(STATE.cooldownUntil, evt.ts + msMin(ENV.EXIT_COOLDOWN_MIN));
}

/* ------------------------- reentry classifier (fix) ------------------------- */
function classifyEntry(evt) {
  if (!ENV.REENTRY_ENABLED) return { isReentry: false, reason: "reentry_disabled" };
  if (!STATE.lastExit) return { isReentry: false, reason: "no_last_exit" };
  if (STATE.lastExit.symbol !== evt.symbol) return { isReentry: false, reason: "last_exit_symbol_mismatch" };

  const winMs = msMin(ENV.REENTRY_WINDOW_MIN);
  if (evt.ts > STATE.lastExit.ts + winMs) return { isReentry: false, reason: "reentry_window_passed" };

  if (STATE.reentryTriesUsed >= ENV.REENTRY_MAX_TRIES) return { isReentry: false, reason: "reentry_max_tries" };

  // optional skip if last exit was too negative
  if (Number.isFinite(STATE.lastExit.pnlPct) && STATE.lastExit.pnlPct <= ENV.REENTRY_SKIP_START_IF_EXIT_PNL_LE_PCT) {
    return { isReentry: false, reason: "reentry_skipped_bad_exit" };
  }

  return { isReentry: true, reason: "reentry_ok" };
}

/* ------------------------- canEnter (cooldown bypass for reentry) ------------------------- */
function canEnter(evt, { isReentry } = { isReentry: false }) {
  // heartbeat freshness = based on tick
  if (ENV.REQUIRE_FRESH_HEARTBEAT) {
    if (!STATE.lastTickTs) return { ok: false, reason: "no_tick_seen" };
    const ageMs = evt.ts - STATE.lastTickTs;
    if (ageMs > ENV.HEARTBEAT_MAX_AGE_SEC * 1000) return { ok: false, reason: "tick_stale" };
  }

  if (STATE.POSITION_LONG?.isOpen) return { ok: false, reason: "already_in_position" };

  // ✅ KEY FIX: cooldown blocks normal entries, but not reentry
  if (!isReentry && evt.ts < STATE.cooldownUntil) return { ok: false, reason: "cooldown_active" };

  // if you want: still block reentry when cooldown is huge? keep as-is (bypass)
  return { ok: true, reason: "ok" };
}

/* ------------------------- 3Commas ------------------------- */
async function postTo3Commas(action, evt, px) {
  if (!ENV.ENABLE_POST_3C) return { ok: true, skipped: true, reason: "post3c_disabled" };
  if (!ENV.C3_BOT_UUID || !ENV.C3_SIGNAL_SECRET) {
    return { ok: false, status: 0, body: "missing_C3_BOT_UUID_or_C3_SIGNAL_SECRET" };
  }

  const payload = {
    secret: ENV.C3_SIGNAL_SECRET,
    bot_uuid: ENV.C3_BOT_UUID,
    action,
    tv_exchange: evt.tv_exchange,
    tv_instrument: evt.tv_instrument,
    trigger_price: String(px),
    timestamp: new Date(evt.ts).toISOString(),
    max_lag: ENV.C3_MAX_LAG_SEC,
  };

  log("3COMMAS_POST", { action, url: ENV.C3_WEBHOOK_URL, payload: { ...payload, secret: "***" } });

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
    const resp = { ok: r.ok, status: r.status, body };
    log("3COMMAS_RESP", { action, resp });
    return resp;
  } catch (e) {
    const resp = { ok: false, status: 0, body: String(e?.message || e) };
    log("3COMMAS_RESP", { action, resp });
    return resp;
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------- PendingBUY ------------------------- */
function storePendingBuy(evt, requestedPrice) {
  const expiresAt = evt.ts + (ENV.PENDING_BUY_WINDOW_SEC * 1000);
  STATE.PENDING_BUY = {
    id: uid(),
    ts: evt.ts,
    expiresAt,
    symbol: evt.symbol,
    tv_exchange: evt.tv_exchange,
    tv_instrument: evt.tv_instrument,
    requestedPrice,
    exitReason: evt.exitReason || "pending_buy",
  };
  console.log(`🩷 PendingBUY stored (${ENV.PENDING_BUY_WINDOW_SEC}s) symbol=${evt.symbol} price=${requestedPrice}`);
}

function clearPendingBuy(reason) {
  if (!STATE.PENDING_BUY) return;
  log("PENDING_BUY_CLEARED", { reason, pending: STATE.PENDING_BUY });
  STATE.PENDING_BUY = null;
}

async function maybeExecutePendingBuyOnTick(evt) {
  if (!ENV.PENDING_BUY_ENABLED) return;
  const pb = STATE.PENDING_BUY;
  if (!pb) return;

  if (evt.ts > pb.expiresAt) {
    clearPendingBuy("expired");
    return;
  }
  if (pb.symbol !== evt.symbol) return;
  if (!Number.isFinite(evt.price) || evt.price <= 0) return;

  // If READY exists, ensure drift isn't insane (optional safety)
  if (STATE.READY_LONG?.on && STATE.READY_LONG.symbol === evt.symbol) {
    const d = pctDiff(STATE.READY_LONG.readyPrice, evt.price);
    if (Number.isFinite(d) && d > ENV.PENDING_BUY_MAX_READY_DRIFT_PCT) {
      clearPendingBuy(`ready_drift_too_high_${round(d,3)}%`);
      return;
    }
  }

  // Treat this as an entry attempt using tick price
  const entryEvt = { ...evt, intent: "enter_long" };
  clearPendingBuy("executed_on_tick");
  await handleEnterLong(entryEvt, evt.price, { fromPending: true });
}

/* ------------------------- ENTER/LONG handler ------------------------- */
async function handleEnterLong(evt, px, { fromPending = false } = {}) {
  // Require READY? (configurable)
  if (ENV.REENTRY_REQUIRE_READY === false && ENV.REENTRY_REQUIRE_READY !== true) {
    // no-op (just for clarity)
  }

  // classify entry (reentry or not)
  const cls = classifyEntry(evt);
  const isReentry = cls.isReentry;

  const gate = canEnter(evt, { isReentry });
  if (!gate.ok) {
    log("ENTER_BLOCKED", { reason: gate.reason, isReentry, cls: cls.reason, fromPending });
    return { ok: true, action: "blocked", reason: gate.reason, isReentry };
  }

  // READY gate for normal entries, and optionally for reentry
  if (ENV.REENTRY_REQUIRE_READY || !isReentry) {
    const rg = gateEnterByReady(evt, px);
    if (!rg.ok) {
      log("ENTER_BLOCKED_READY", { reason: rg.reason, isReentry, fromPending });
      return { ok: true, action: "blocked", reason: rg.reason, isReentry };
    }
  }

  // consume READY on accepted entry
  if (STATE.READY_LONG?.on) clearReady(isReentry ? "reentry_entered" : "entered_long");

  // open internal position
  openLong(evt, px);

  // count try if this was reentry
  if (isReentry) STATE.reentryTriesUsed += 1;

  // send to 3Commas
  const resp = await postTo3Commas("enter_long", evt, px);

  // if 3Commas failed, close internal to avoid desync
  if (!resp.ok) {
    closeLong(evt, "3commas_enter_failed", px);
    return { ok: false, action: "enter_long_failed", resp };
  }

  return { ok: true, action: "enter_long", isReentry, resp };
}

/* ------------------------- Express ------------------------- */
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.status(200).send("OK: Brain LONG v2.9.6 (PendingBUY + READY + ReEntry fix)"));

app.get("/status", (_req, res) => {
  res.json({
    ok: true,
    brain: "v2.9.6-LONG",
    now: Date.now(),
    lastTick: { ts: STATE.lastTickTs || null, price: Number.isFinite(STATE.lastTickPrice) ? STATE.lastTickPrice : null, symbol: STATE.lastSymbol || null },
    ready: STATE.READY_LONG || null,
    pendingBuy: STATE.PENDING_BUY || null,
    position: STATE.POSITION_LONG || null,
    cooldownUntil: STATE.cooldownUntil || 0,
    lastExit: STATE.lastExit || null,
    reentryTriesUsed: STATE.reentryTriesUsed,
    env: {
      ENABLE_POST_3C: ENV.ENABLE_POST_3C,
      C3_BOT_UUID_set: !!ENV.C3_BOT_UUID,
      C3_SIGNAL_SECRET_set: !!ENV.C3_SIGNAL_SECRET,
      READY_TTL_MIN: ENV.READY_TTL_MIN,
      READY_MAX_MOVE_PCT: ENV.READY_MAX_MOVE_PCT,
      EXIT_COOLDOWN_MIN: ENV.EXIT_COOLDOWN_MIN,
      REENTRY_ENABLED: ENV.REENTRY_ENABLED,
      REENTRY_WINDOW_MIN: ENV.REENTRY_WINDOW_MIN,
      REENTRY_MAX_TRIES: ENV.REENTRY_MAX_TRIES,
      PENDING_BUY_ENABLED: ENV.PENDING_BUY_ENABLED,
      PENDING_BUY_WINDOW_SEC: ENV.PENDING_BUY_WINDOW_SEC,
    }
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
    readyTTLExpireCheck(evt.ts);

    log("WEBHOOK_IN", { intent: evt.intent, symbol: evt.symbol, price: evt.price, ts: evt.ts });

    // ---- tick ----
    if (evt.intent === "tick") {
      if (evt.symbol) STATE.lastSymbol = evt.symbol;
      if (Number.isFinite(evt.price) && evt.price > 0) STATE.lastTickPrice = evt.price;
      STATE.lastTickTs = evt.ts;

      maybeAutoExpireReadyOnTick(evt);

      // pending buy executes on first tick after stored
      await maybeExecutePendingBuyOnTick(evt);

      // update position peak
      if (STATE.POSITION_LONG?.isOpen && STATE.POSITION_LONG.symbol === evt.symbol && Number.isFinite(evt.price) && evt.price > 0) {
        STATE.POSITION_LONG.lastPrice = evt.price;
        STATE.POSITION_LONG.lastUpdateTs = evt.ts;
        STATE.POSITION_LONG.peak = Math.max(STATE.POSITION_LONG.peak, evt.price);
      }

      return res.json({ ok: true, action: "tick" });
    }

    // ---- ready / ready_long ----
    if (evt.intent === "ready_long" || (ENV.READY_ACCEPT_LEGACY_READY && evt.intent === "ready")) {
      // choose best ready price: if incoming price==0, use lastTickPrice
      const px = (evt.price > 0) ? evt.price : (Number.isFinite(STATE.lastTickPrice) ? STATE.lastTickPrice : 0);

      setReady(evt, px);
      return res.json({ ok: true, action: "ready_long", ready: STATE.READY_LONG });
    }

    // ---- exit_long ----
    if (evt.intent === "exit_long") {
      // choose best exit price: if incoming price==0, use lastTickPrice
      const px = (evt.price > 0) ? evt.price : (Number.isFinite(STATE.lastTickPrice) ? STATE.lastTickPrice : 0);

      closeLong(evt, evt.exitReason || "signal_exit", px);

      // send to 3Commas even if position was not open (idempotent)
      const resp = await postTo3Commas("exit_long", evt, px > 0 ? px : (STATE.lastTickPrice || 0));

      return res.json({ ok: true, action: "exit_long", resp });
    }

    // ---- enter_long ----
    if (evt.intent === "enter_long") {
      // if provided price is 0 -> use lastTickPrice if available
      const px = (evt.price > 0) ? evt.price : (Number.isFinite(STATE.lastTickPrice) ? STATE.lastTickPrice : 0);

      // no ticks yet => store pending buy (executes on first tick)
      if (px <= 0) {
        if (ENV.PENDING_BUY_ENABLED) {
          storePendingBuy(evt, evt.price);
          return res.json({ ok: true, action: "pending_buy_stored" });
        }
        return res.json({ ok: false, action: "enter_long_failed", error: "no_price_and_pending_disabled" });
      }

      // handle enter now
      const out = await handleEnterLong(evt, px, { fromPending: false });
      return res.json(out);
    }

    return res.status(200).json({ ok: true, action: "ignored", reason: "unknown_intent", got: evt.intent });
  } catch (e) {
    console.error("ERROR in /webhook:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ------------------------- BOOT ------------------------- */
log("STARTUP_CONFIG", {
  brain: "v2.9.6-LONG",
  port: ENV.PORT,
  path: ENV.WEBHOOK_PATH,
  enablePost3c: ENV.ENABLE_POST_3C,
  c3_bot_uuid_set: !!ENV.C3_BOT_UUID,
  c3_signal_secret_set: !!ENV.C3_SIGNAL_SECRET,
  readyEnabled: true,
  pendingBuy: ENV.PENDING_BUY_ENABLED,
  reentryEnabled: ENV.REENTRY_ENABLED,
});
console.log(`[BOOT] LONG brain listening soon | WEBHOOK_SECRET suffix=${ENV.WEBHOOK_SECRET.slice(-6)} len=${ENV.WEBHOOK_SECRET.length}`);

app.listen(ENV.PORT, () => {
  log("LISTENING", { port: ENV.PORT, path: ENV.WEBHOOK_PATH, brain: "v2.9.6-LONG" });
});
