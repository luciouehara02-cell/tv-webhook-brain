// server.js (Brain v2) — READY-gated webhook router for TradingView + RayAlgo + 3Commas
// - Accepts BOTH payload styles:
//   (A) 3Commas-style: { secret, action: ready|enter_long|exit_long, bot_uuid, ... }
//   (B) RayAlgo-style: { src:"ray", symbol, tf, side:"BUY"|"SELL", time, price }
// - READY gating: will ONLY allow enter_long / Ray BUY when READY has been received.
// - Ray is "confirm-only" (does NOT change position / execute), to avoid conflicts.
// - Position state is driven by 3Commas enter_long / exit_long.
// - Optional security: set WEBHOOK_SECRET to require a shared secret for ALL webhooks.

import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ====================
// CONFIG (Railway Variables)
// ====================
const PORT = process.env.PORT || 3000;

// If set, every webhook must include either:
// - payload.secret === WEBHOOK_SECRET
// - OR payload.tv_secret === WEBHOOK_SECRET
// - OR payload.token === WEBHOOK_SECRET
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// READY auto-expire (minutes). 0 = never expire (not recommended).
const READY_TTL_MIN = Number(process.env.READY_TTL_MIN || "30");

// ====================
// MEMORY (in-RAM)
// ====================
let readyOn = false;
let readyAtMs = 0;

// Position state (driven by 3Commas enter_long / exit_long)
let inPosition = false;
let lastAction = "none";

// ====================
// HELPERS
// ====================
function nowMs() {
  return Date.now();
}

function ttlExpired() {
  if (!READY_TTL_MIN || READY_TTL_MIN <= 0) return false;
  const ageMs = nowMs() - readyAtMs;
  return readyOn && readyAtMs > 0 && ageMs > READY_TTL_MIN * 60 * 1000;
}

function checkSecret(payload) {
  if (!WEBHOOK_SECRET) return true; // secret check disabled
  const s =
    payload?.secret ??
    payload?.tv_secret ??
    payload?.token ??
    payload?.passphrase ??
    "";
  return String(s) === String(WEBHOOK_SECRET);
}

function normalizeAction(payload) {
  // 3Commas style uses payload.action
  const a = payload?.action;
  return a ? String(a).toLowerCase() : "";
}

function logWebhook(payload) {
  console.log("==== NEW WEBHOOK ====");
  console.log(payload);
}

// ====================
// ROUTES
// ====================

// Health check
app.get("/", (req, res) => {
  res
    .status(200)
    .send(
      `TV Webhook Brain running | readyOn=${readyOn} | inPosition=${inPosition} | lastAction=${lastAction}`
    );
});

// Main webhook receiver (TradingView → this URL)
app.post("/webhook", async (req, res) => {
  const payload = req.body || {};
  logWebhook(payload);

  // Expire READY automatically if TTL passed
  if (ttlExpired()) {
    readyOn = false;
    readyAtMs = 0;
    console.log("🟠 READY expired (TTL)");
  }

  // Optional security
  if (!checkSecret(payload)) {
    console.log("⛔ Secret mismatch - blocked");
    return res.status(401).json({ ok: false, error: "secret_mismatch" });
  }

  // ---------- RayAlgo payload (confirm-only) ----------
  if (payload?.src === "ray") {
    const side = String(payload.side || "").toUpperCase();
    console.log("Ray side:", side);

    if (side === "BUY") console.log("🟢 Ray BUY received (confirm only)");
    else if (side === "SELL") console.log("🔴 Ray SELL received (confirm only)");
    else console.log("⚠️ Ray unknown side");

    return res.json({ ok: true, mode: "ray-confirm-only" });
  }

  // ---------- 3Commas / TV payload ----------
  const action = normalizeAction(payload);

  // READY
  if (action === "ready") {
    readyOn = true;
    readyAtMs = nowMs();
    lastAction = "ready";
    console.log("🟢 READY ON");
    return res.json({ ok: true, readyOn, inPosition });
  }

  // ENTER LONG (gated)
  if (action === "enter_long") {
    if (!readyOn) {
      console.log("⛔ BUY blocked (not READY)");
      lastAction = "buy_blocked_not_ready";
      return res.json({ ok: false, blocked: "not_ready" });
    }
    if (inPosition) {
      console.log("⛔ BUY blocked (already in position)");
      lastAction = "buy_blocked_in_position";
      return res.json({ ok: false, blocked: "already_in_position" });
    }

    // Allow entry
    inPosition = true;
    lastAction = "enter_long";
    console.log("🚀 ENTER LONG allowed");
    return res.json({ ok: true, allowed: "enter_long", inPosition });
  }

  // EXIT LONG (allowed only if inPosition)
  if (action === "exit_long") {
    if (!inPosition) {
      console.log("⛔ SELL blocked (no position)");
      lastAction = "sell_blocked_no_position";
      return res.json({ ok: false, blocked: "no_position" });
    }

    // Allow exit + auto turn off READY (so you must re-arm)
    inPosition = false;
    readyOn = false;
    readyAtMs = 0;

    lastAction = "exit_long";
    console.log("✅ EXIT LONG allowed | READY OFF");
    return res.json({ ok: true, allowed: "exit_long", inPosition, readyOn });
  }

  // Unknown payload
  console.log("⚠️ Unknown webhook type/action");
  lastAction = "unknown";
  return res.json({ ok: true, note: "unknown_action_or_payload" });
});

// ====================
// START
// ====================
app.listen(PORT, () => {
  console.log(`✅ Brain v2 listening on port ${PORT}`);
  console.log(
    `Config: READY_TTL_MIN=${READY_TTL_MIN} | WEBHOOK_SECRET=${
      WEBHOOK_SECRET ? "(set)" : "(not set)"
    }`
  );
});
