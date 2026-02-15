// server.js (Brain v2.1)
// READY-gated execution engine
// - YY9 sends READY
// - RayAlgo BUY triggers enter_long (ONLY if READY ON)
// - RayAlgo SELL triggers exit_long
// - READY auto-OFF after exit
// - Optional secret + TTL supported

import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ====================
// CONFIG (Railway Variables)
// ====================
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const READY_TTL_MIN = Number(process.env.READY_TTL_MIN || "30");

// ====================
// MEMORY (in-RAM)
// ====================
let readyOn = false;
let readyAtMs = 0;
let inPosition = false;
let lastAction = "none";

// ====================
// HELPERS
// ====================
const nowMs = () => Date.now();

function ttlExpired() {
  if (!READY_TTL_MIN || READY_TTL_MIN <= 0) return false;
  return readyOn && nowMs() - readyAtMs > READY_TTL_MIN * 60 * 1000;
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

function normalizeAction(payload) {
  return payload?.action ? String(payload.action).toLowerCase() : "";
}

function logWebhook(payload) {
  console.log("==== NEW WEBHOOK ====");
  console.log(payload);
}

// ====================
// ROUTES
// ====================
app.get("/", (req, res) => {
  res.send(
    `Brain v2.1 | readyOn=${readyOn} | inPosition=${inPosition} | lastAction=${lastAction}`
  );
});

app.post("/webhook", async (req, res) => {
  const payload = req.body || {};
  logWebhook(payload);

  // READY TTL expiry
  if (ttlExpired()) {
    readyOn = false;
    readyAtMs = 0;
    console.log("🟠 READY expired (TTL)");
  }

  // Security
  if (!checkSecret(payload)) {
    console.log("⛔ Secret mismatch - blocked");
    return res.status(401).json({ ok: false, error: "secret_mismatch" });
  }

  // ====================
  // RAYALGO PAYLOAD
  // ====================
  if (payload?.src === "ray") {
    const side = String(payload.side || "").toUpperCase();
    console.log("Ray side:", side);

    // -------- RAY BUY --------
    if (side === "BUY") {
      if (!readyOn) {
        console.log("⛔ Ray BUY blocked (NOT READY)");
        lastAction = "ray_buy_blocked_not_ready";
        return res.json({ ok: false, blocked: "not_ready" });
      }
      if (inPosition) {
        console.log("⛔ Ray BUY blocked (already in position)");
        lastAction = "ray_buy_blocked_in_position";
        return res.json({ ok: false, blocked: "already_in_position" });
      }

      inPosition = true;
      lastAction = "ray_enter_long";
      console.log("🚀 RAY BUY → ENTER LONG");
      return res.json({ ok: true, action: "enter_long", source: "ray" });
    }

    // -------- RAY SELL --------
    if (side === "SELL") {
      if (!inPosition) {
        console.log("⛔ Ray SELL ignored (no position)");
        lastAction = "ray_sell_no_position";
        return res.json({ ok: false, blocked: "no_position" });
      }

      inPosition = false;
      readyOn = false;
      readyAtMs = 0;
      lastAction = "ray_exit_long";
      console.log("✅ RAY SELL → EXIT LONG | READY OFF");
      return res.json({ ok: true, action: "exit_long", source: "ray" });
    }

    console.log("⚠️ Ray unknown side");
    return res.json({ ok: true, note: "ray_unknown_side" });
  }

  // ====================
  // YY9 / TV PAYLOAD
  // ====================
  const action = normalizeAction(payload);

  // READY
  if (action === "ready") {
    readyOn = true;
    readyAtMs = nowMs();
    lastAction = "ready";
    console.log("🟢 READY ON");
    return res.json({ ok: true, readyOn });
  }

  // OPTIONAL: allow manual TV execution (fallback)
  if (action === "enter_long") {
    if (!readyOn || inPosition) {
      console.log("⛔ TV BUY blocked");
      return res.json({ ok: false, blocked: true });
    }
    inPosition = true;
    lastAction = "tv_enter_long";
    console.log("🚀 TV ENTER LONG");
    return res.json({ ok: true });
  }

  if (action === "exit_long") {
    if (!inPosition) {
      console.log("⛔ TV SELL blocked");
      return res.json({ ok: false, blocked: true });
    }
    inPosition = false;
    readyOn = false;
    readyAtMs = 0;
    lastAction = "tv_exit_long";
    console.log("✅ TV EXIT LONG | READY OFF");
    return res.json({ ok: true });
  }

  console.log("⚠️ Unknown webhook");
  lastAction = "unknown";
  return res.json({ ok: true, note: "unknown" });
});

// ====================
// START
// ====================
app.listen(PORT, () => {
  console.log(`✅ Brain v2.1 listening on port ${PORT}`);
  console.log(
    `Config: READY_TTL_MIN=${READY_TTL_MIN} | WEBHOOK_SECRET=${
      WEBHOOK_SECRET ? "(set)" : "(not set)"
    }`
  );
});
