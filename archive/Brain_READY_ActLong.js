/**
 * Tick Logger v1.0
 * Based on Brain-style webhook handling, but TICK ONLY.
 *
 * Purpose:
 * - receive 15s tick webhooks
 * - validate secret
 * - filter symbol
 * - print tick logs in Railway
 * - keep short in-memory tick buffer
 * - show simple move stats
 *
 * No trading.
 * No READY.
 * No Ray.
 * No 3Commas.
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const SCRIPT_VERSION = "TickLogger_v1.0";

// ====================
// CONFIG (Railway Variables)
// ====================
const PORT = Number(process.env.PORT || 8080);
const WEBHOOK_PATH = String(process.env.WEBHOOK_PATH || "/webhook");
const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "");
const SYMBOL = String(process.env.SYMBOL || "BINANCE:SOLUSDT").trim().toUpperCase();

const TICK_BUFFER_SEC = Number(process.env.TICK_BUFFER_SEC || "7200"); // 2h
const PRINT_FULL_PAYLOAD =
  String(process.env.PRINT_FULL_PAYLOAD || "false").toLowerCase() === "true";

const TICK_LOG_EVERY_MS = Number(process.env.TICK_LOG_EVERY_MS || "0"); // 0 = every tick
const STATE_LOG_EVERY_MS = Number(process.env.STATE_LOG_EVERY_MS || "60000");

// ====================
// MEMORY
// ====================
let tickCount = 0;
let lastTickMs = 0;
let lastTickSymbol = "";
let lastTickPrice = null;
let lastTickTime = null;
let lastTickLogMs = 0;
let lastStateLogMs = 0;

const tickHistory = new Map();

// ====================
// HELPERS
// ====================
const nowMs = () => Date.now();

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function normalizeIntent(payload) {
  const a = payload?.action ? String(payload.action).toLowerCase() : "";
  const i = payload?.intent ? String(payload.intent).toLowerCase() : "";
  const s = payload?.src ? String(payload.src).toLowerCase() : "";
  if (a) return a;
  if (i) return i;
  if (s) return s;
  return "";
}

function checkSecret(payload) {
  if (!WEBHOOK_SECRET) return true;
  const s =
    payload?.secret ??
    payload?.tv_secret ??
    payload?.token ??
    payload?.passphrase ??
    "";
  return String(s) === String(WEBHOOK_SECRET);
}

function parseSymbol(symbolStr) {
  const s = String(symbolStr || "").trim().toUpperCase();
  if (!s) return { symbol: "", ex: "", ins: "" };
  if (s.includes(":")) {
    const [ex, ins] = s.split(":");
    return { symbol: `${ex}:${ins}`, ex: ex || "", ins: ins || "" };
  }
  return { symbol: s, ex: "", ins: s };
}

function getSymbolFromPayload(payload) {
  if (payload?.symbol) return parseSymbol(payload.symbol).symbol;
  if (payload?.tv_exchange && payload?.tv_instrument)
    return parseSymbol(`${payload.tv_exchange}:${payload.tv_instrument}`).symbol;
  if (payload?.exchange && payload?.ticker)
    return parseSymbol(`${payload.exchange}:${payload.ticker}`).symbol;
  return "";
}

function getTickPrice(payload) {
  return toNum(payload?.price) ?? toNum(payload?.close) ?? null;
}

function getTickTime(payload) {
  return String(payload?.time || payload?.timestamp || new Date().toISOString());
}

function pctMove(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / from) * 100.0;
}

function pushTick(symbol, price, tMs, isoTime) {
  if (!symbol || !Number.isFinite(price) || !Number.isFinite(tMs)) return;
  const arr = tickHistory.get(symbol) || [];
  arr.push({ t: tMs, p: price, iso: isoTime });

  const cutoff = tMs - TICK_BUFFER_SEC * 1000;
  while (arr.length && arr[0].t < cutoff) arr.shift();

  tickHistory.set(symbol, arr);
}

function priceAtOrBefore(symbol, targetMs) {
  const arr = tickHistory.get(symbol);
  if (!arr || arr.length === 0) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].t <= targetMs) return arr[i].p;
  }
  return arr[0]?.p ?? null;
}

function moveStats(symbol) {
  const now = nowMs();
  const pNow = priceAtOrBefore(symbol, now);
  if (!Number.isFinite(pNow)) {
    return {
      move1mPct: null,
      move5mPct: null,
      move15mPct: null,
    };
  }

  const p1m = priceAtOrBefore(symbol, now - 60 * 1000);
  const p5m = priceAtOrBefore(symbol, now - 300 * 1000);
  const p15m = priceAtOrBefore(symbol, now - 900 * 1000);

  return {
    move1mPct: pctMove(p1m, pNow),
    move5mPct: pctMove(p5m, pNow),
    move15mPct: pctMove(p15m, pNow),
  };
}

function historySize(symbol) {
  const arr = tickHistory.get(symbol);
  return arr ? arr.length : 0;
}

function maybeLogTick(symbol, price, isoTime) {
  const now = nowMs();

  if (TICK_LOG_EVERY_MS <= 0) {
    const stats = moveStats(symbol);
    console.log(
      `📍 TICK ${symbol} price=${price} time=${isoTime} count=${tickCount} move1m=${fmtPct(
        stats.move1mPct
      )} move5m=${fmtPct(stats.move5mPct)} move15m=${fmtPct(stats.move15mPct)}`
    );
    return;
  }

  if (!lastTickLogMs || now - lastTickLogMs >= TICK_LOG_EVERY_MS) {
    const stats = moveStats(symbol);
    console.log(
      `📍 TICK ${symbol} price=${price} time=${isoTime} count=${tickCount} move1m=${fmtPct(
        stats.move1mPct
      )} move5m=${fmtPct(stats.move5mPct)} move15m=${fmtPct(stats.move15mPct)}`
    );
    lastTickLogMs = now;
  }
}

function maybeLogState(symbol) {
  const now = nowMs();
  if (!STATE_LOG_EVERY_MS || STATE_LOG_EVERY_MS <= 0) return;
  if (!symbol) return;

  if (!lastStateLogMs || now - lastStateLogMs >= STATE_LOG_EVERY_MS) {
    const stats = moveStats(symbol);
    console.log(
      `📌 STATE ${symbol} ticks=${historySize(symbol)} lastPrice=${lastTickPrice} move1m=${fmtPct(
        stats.move1mPct
      )} move5m=${fmtPct(stats.move5mPct)} move15m=${fmtPct(stats.move15mPct)} lastTickTime=${
        lastTickTime || "na"
      }`
    );
    lastStateLogMs = now;
  }
}

function fmtPct(v) {
  return Number.isFinite(v) ? `${v.toFixed(3)}%` : "na";
}

function statusPayload() {
  const stats = lastTickSymbol ? moveStats(lastTickSymbol) : null;

  return {
    script: SCRIPT_VERSION,
    symbol: SYMBOL,
    webhookPath: WEBHOOK_PATH,
    tickCount,
    lastTickMs,
    lastTickSymbol,
    lastTickPrice,
    lastTickTime,
    tickBufferSec: TICK_BUFFER_SEC,
    printFullPayload: PRINT_FULL_PAYLOAD,
    tickLogEveryMs: TICK_LOG_EVERY_MS,
    stateLogEveryMs: STATE_LOG_EVERY_MS,
    historySize: lastTickSymbol ? historySize(lastTickSymbol) : 0,
    stats: stats || {
      move1mPct: null,
      move5mPct: null,
      move15mPct: null,
    },
  };
}

// ====================
// ROUTES
// ====================
app.get("/", (_req, res) => res.json(statusPayload()));
app.get("/status", (_req, res) => res.json(statusPayload()));

app.post(WEBHOOK_PATH, async (req, res) => {
  const payload = req.body || {};

  if (!checkSecret(payload)) {
    console.log("⛔ Secret mismatch - blocked");
    return res.status(401).json({ ok: false, error: "secret_mismatch" });
  }

  const intent = normalizeIntent(payload);

  if (intent !== "tick") {
    console.log("ℹ️ Non-tick payload ignored", {
      src: payload?.src,
      intent,
      symbol: payload?.symbol || "",
    });
    return res.json({ ok: true, ignored: "non_tick" });
  }

  const tickPx = getTickPrice(payload);
  const tickSym = getSymbolFromPayload(payload);
  const isoTime = getTickTime(payload);
  const tf = String(payload?.tf || "");

  if (tickPx == null || !tickSym) {
    console.log("⚠️ Tick ignored (missing price or symbol)");
    return res.status(400).json({ ok: false, error: "missing_price_or_symbol" });
  }

  if (SYMBOL && tickSym !== SYMBOL) {
    console.log(`🚫 Tick ignored (symbol mismatch) got=${tickSym} expected=${SYMBOL}`);
    return res.json({ ok: true, ignored: "symbol_mismatch", got: tickSym, expected: SYMBOL });
  }

  const tMs = Date.parse(isoTime);
  const tickTsMs = Number.isFinite(tMs) ? tMs : nowMs();

  tickCount += 1;
  lastTickMs = tickTsMs;
  lastTickSymbol = tickSym;
  lastTickPrice = tickPx;
  lastTickTime = isoTime;

  pushTick(tickSym, tickPx, tickTsMs, isoTime);

  if (PRINT_FULL_PAYLOAD) {
    console.log("🧾 FULL TICK PAYLOAD", payload);
  }

  maybeLogTick(tickSym, tickPx, isoTime);
  maybeLogState(tickSym);

  const stats = moveStats(tickSym);

  return res.json({
    ok: true,
    tick: true,
    symbol: tickSym,
    tf,
    price: tickPx,
    time: isoTime,
    count: tickCount,
    stats,
  });
});

// ====================
// START
// ====================
app.listen(PORT, () => {
  console.log(`✅ ${SCRIPT_VERSION} listening on port ${PORT}`);
  console.log(`Path: ${WEBHOOK_PATH}`);
  console.log(`Symbol filter: ${SYMBOL}`);
  console.log(`TickBuffer: TICK_BUFFER_SEC=${TICK_BUFFER_SEC}`);
  console.log(`Logging: TICK_LOG_EVERY_MS=${TICK_LOG_EVERY_MS} | STATE_LOG_EVERY_MS=${STATE_LOG_EVERY_MS}`);
  console.log(`PRINT_FULL_PAYLOAD=${PRINT_FULL_PAYLOAD}`);
  console.log(`Secret: ${WEBHOOK_SECRET ? "(set)" : "(missing/disabled)"}`);
});
