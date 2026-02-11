// server.js (Brain v2) — READY-gated webhook router for TradingView + RayAlgo + 3Commas
import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

// --------------------
// CONFIG (set these in Railway Variables)
// --------------------
const PORT = process.env.PORT || 3000;

// If set, incoming payload.secret must match
const EXPECTED_SECRET = process.env.EXPECTED_SECRET || "";

// If set, Brain will forward to 3Commas webhook URL
// Example: https://3commas.io/trade_signal/trading_view   (or whatever your 3Commas gives you)
const THREECOMMAS_WEBHOOK_URL = process.env.THREECOMMAS_WEBHOOK_URL || "";

// Default bot_uuid if we need to build a 3Commas payload from RayAlgo payloads
const BOT_UUID_DEFAULT = process.env.BOT_UUID_DEFAULT || "";

// READY gate window (seconds). BUY is allowed only if READY happened recently.
const READY_TTL_SEC = Number(process.env.READY_TTL_SEC || 3600); // 1 hour default

// Dedupe window: ignore same action if repeated within N ms
const DEDUPE_MS = Number(process.env.DEDUPE_MS || 8000); // 8s

// Max lag fallback (seconds) if payload.max_lag missing
const MAX_LAG_SEC_DEFAULT = Number(process.env.MAX_LAG_SEC_DEFAULT || 300);

// Optional: allow BUY without READY (set to "true" to disable gating)
const ALLOW_BUY_WITHOUT_READY = (process.env.ALLOW_BUY_WITHOUT_READY || "false").toLowerCase() === "true";

// --------------------
// In-memory state (per symbol+tf)
// NOTE: resets if Railway restarts (ok for v2; later we can persist)
// --------------------
/**
 * state[key] = {
 *   readyUntilMs: number,
 *   last: { action: string, atMs: number }
 * }
 */
const state = new Map();

function nowMs() {
  return Date.now();
}

function asNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

// Build a stable key per market
function buildKey(payload) {
  // Prefer explicit fields
  const tf = String(payload.tf ?? payload.interval ?? "");
  const sym =
    payload.symbol ??
    (payload.tv_exchange && payload.tv_instrument
      ? `${payload.tv_exchange}:${payload.tv_instrument}`
      : payload.tv_instrument ?? payload.ticker ?? payload.instrument ?? "UNKNOWN");

  return `${sym}__tf=${tf || "?"}`;
}

// Normalize BOTH payload formats into one internal event
function normalize(payload) {
  // 1) RayAlgo format
  if (payload && typeof payload === "object" && payload.src === "ray") {
    const side = String(payload.side || "").toUpperCase();
    const action =
      side === "BUY" ? "enter_long" :
      side === "SELL" ? "exit_long" :
      "unknown";

    return {
      source: "ray",
      key: buildKey(payload),
      action,
      symbol: payload.symbol,
      tf: String(payload.tf || ""),
      tsMs: asNumber(payload.time) || nowMs(),
      price: payload.price,
      raw: payload,
    };
  }

  // 2) 3Commas/Brain format
  const action = String(payload.action || "").toLowerCase();
  return {
    source: "tv",
    key: buildKey(payload),
    action, // ready / enter_long / exit_long / etc.
    symbol:
      payload.symbol ??
      (payload.tv_exchange && payload.tv_instrument
        ? `${payload.tv_exchange}:${payload.tv_instrument}`
        : payload.tv_instrument),
    tf: String(payload.tf ?? payload.interval ?? ""),
    tsMs: asNumber(payload.timestamp) || asNumber(payload.timenow) || nowMs(),
    price: payload.trigger_price ?? payload.price ?? payload.close,
    raw: payload,
  };
}

function checkSecret(payload) {
  if (!EXPECTED_SECRET) return { ok: true };
  if (!payload || typeof payload !== "object") return { ok: false, reason: "payload_not_object" };
  if (payload.secret !== EXPECTED_SECRET) return { ok: false, reason: "bad_secret" };
  return { ok: true };
}

function checkLag(payload, event) {
  const maxLagSec = Number(payload.max_lag || MAX_LAG_SEC_DEFAULT);
  const ts = event.tsMs;
  if (!Number.isFinite(ts)) return { ok: true }; // if no ts, don't block
  const lagMs = Math.abs(nowMs() - ts);
  if (lagMs > maxLagSec * 1000) {
    return { ok: false, reason: `lag_too_high (${Math.round(lagMs / 1000)}s > ${maxLagSec}s)` };
  }
  return { ok: true };
}

function getState(key) {
  if (!state.has(key)) {
    state.set(key, {
      readyUntilMs: 0,
      last: { action: "", atMs: 0 },
    });
  }
  return state.get(key);
}

function isDuplicate(st, action) {
  const t = nowMs();
  if (st.last.action === action && (t - st.last.atMs) < DEDUPE_MS) return true;
  return false;
}

function markLast(st, action) {
  st.last = { action, atMs: nowMs() };
}

function setReady(st) {
  st.readyUntilMs = nowMs() + READY_TTL_SEC * 1000;
}

function clearReady(st) {
  st.readyUntilMs = 0;
}

function readyActive(st) {
  return nowMs() <= (st.readyUntilMs || 0);
}

async function forwardTo3Commas(payload) {
  if (!THREECOMMAS_WEBHOOK_URL) {
    return { forwarded: false, reason: "THREECOMMAS_WEBHOOK_URL_not_set" };
  }
  const r = await fetch(THREECOMMAS_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await r.text().catch(() => "");
  return { forwarded: true, status: r.status, response: text.slice(0, 500) };
}

// If we receive RayAlgo payload, we can build a 3Commas payload to send out
function rayTo3Commas(event) {
  const raw = event.raw || {};
  const bot_uuid = raw.bot_uuid || BOT_UUID_DEFAULT;
  return {
    secret: EXPECTED_SECRET || raw.secret, // prefer env secret; fallback raw
    max_lag: String(MAX_LAG_SEC_DEFAULT),
    timestamp: String(nowMs()),
    trigger_price: String(raw.price ?? ""),
    tv_exchange: (raw.symbol || "").includes(":") ? String(raw.symbol).split(":")[0] : "",
    tv_instrument: (raw.symbol || "").includes(":") ? String(raw.symbol).split(":")[1] : String(raw.symbol || ""),
    action: event.action, // enter_long / exit_long
    bot_uuid,
    tf: String(raw.tf || ""),
  };
}

// --------------------
// ROUTES
// --------------------
app.get("/", (_req, res) => {
  res.status(200).send("TV Webhook Brain v2 running");
});

// Optional quick view of one key (don’t expose publicly in production)
app.get("/debug/state", (req, res) => {
  const key = String(req.query.key || "");
  if (!key) return res.json({ ok: true, keys: Array.from(state.keys()).slice(0, 50) });
  const st = state.get(key);
  return res.json({ ok: true, key, state: st || null, now: nowMs() });
});

app.post("/webhook", async (req, res) => {
  console.log("\n==== NEW WEBHOOK ====");
  console.log("Raw:", JSON.stringify(req.body));

  const payload = req.body;

  // Secret check (only if EXPECTED_SECRET is set)
  const sec = checkSecret(payload);
  if (!sec.ok) {
    console.log("Reject:", sec.reason);
    return res.status(401).json({ ok: false, error: sec.reason });
  }

  const event = normalize(payload);
  const st = getState(event.key);

  // Lag check
  const lag = checkLag(payload, event);
  if (!lag.ok) {
    console.log("Ignore:", lag.reason);
    return res.status(200).json({ ok: true, ignored: lag.reason });
  }

  // Normalize actions
  const action = String(event.action || "").toLowerCase();

  // Dedupe
  if (isDuplicate(st, action)) {
    console.log("Ignore: duplicate", action);
    return res.status(200).json({ ok: true, ignored: "duplicate" });
  }

  // Handle READY
  if (action === "ready") {
    setReady(st);
    markLast(st, action);
    console.log(`READY set for key=${event.key} until=${new Date(st.readyUntilMs).toISOString()}`);

    // If you want READY forwarded to 3Commas, uncomment below.
    // const out = await forwardTo3Commas(payload);
    // console.log("Forward READY:", out);

    return res.status(200).json({ ok: true, action: "ready", key: event.key, readyUntilMs: st.readyUntilMs });
  }

  // Handle BUY (enter_long)
  if (action === "enter_long") {
    const canBuy = ALLOW_BUY_WITHOUT_READY || readyActive(st);

    if (!canBuy) {
      console.log(`BLOCK BUY: not ready (key=${event.key})`);
      markLast(st, action);
      return res.status(200).json({ ok: true, blocked: "not_ready", key: event.key });
    }

    // After a BUY is accepted, consume READY (one-shot)
    clearReady(st);
    markLast(st, action);

    let outPayload = payload;
    if (event.source === "ray") outPayload = rayTo3Commas(event);

    console.log("ACCEPT BUY:", { key: event.key, source: event.source, outPayload });

    const fwd = await forwardTo3Commas(outPayload);
    console.log("Forward BUY:", fwd);

    return res.status(200).json({ ok: true, action: "enter_long", key: event.key, forwarded: fwd });
  }

  // Handle SELL (exit_long)
  if (action === "exit_long") {
    // SELL always clears READY (safe reset)
    clearReady(st);
    markLast(st, action);

    let outPayload = payload;
    if (event.source === "ray") outPayload = rayTo3Commas(event);

    console.log("ACCEPT SELL:", { key: event.key, source: event.source, outPayload });

    const fwd = await forwardTo3Commas(outPayload);
    console.log("Forward SELL:", fwd);

    return res.status(200).json({ ok: true, action: "exit_long", key: event.key, forwarded: fwd });
  }

  // Unknown action — just log it
  markLast(st, action || "unknown");
  console.log("Unknown/ignored action:", action);
  return res.status(200).json({ ok: true, ignored: "unknown_action", action, key: event.key });
});

app.listen(PORT, () => {
  console.log(`Brain v2 listening on :${PORT}`);
});
