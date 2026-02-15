// server.js (Brain v2.2)
// READY-gated execution engine + 3Commas forwarder
// Sequence:
// 1) YY9 sends { "action": "ready", "secret": ... }  -> READY ON
// 2) RayAlgo sends { src:"ray", side:"BUY"/"SELL", symbol:"BINANCE:SOLUSDT", ... }
// 3) Brain forwards to 3Commas webhook:
//    BUY  -> action: "enter_long"
//    SELL -> action: "exit_long"
// 4) READY auto-OFF after exit
// Optional: secret + TTL supported

import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ====================
// CONFIG (Railway Variables)
// ====================
const PORT = process.env.PORT || 3000;

// TradingView -> Railway auth (your Brain secret)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// READY TTL (minutes). If 0 or unset, no expiry.
const READY_TTL_MIN = Number(process.env.READY_TTL_MIN || "30");

// 3Commas forward config
const THREECOMMAS_WEBHOOK_URL = process.env.THREECOMMAS_WEBHOOK_URL || "";
const THREECOMMAS_BOT_UUID = process.env.THREECOMMAS_BOT_UUID || "";
const THREECOMMAS_SECRET = process.env.THREECOMMAS_SECRET || "";

// If you only ever trade one pair, set these (optional).
// If unset, we derive from payload.symbol like "BINANCE:SOLUSDT".
const DEFAULT_TV_EXCHANGE = process.env.DEFAULT_TV_EXCHANGE || "";
const DEFAULT_TV_INSTRUMENT = process.env.DEFAULT_TV_INSTRUMENT || "";

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

function splitTvSymbol(symbol) {
  const raw = String(symbol || "").trim();
  if (!raw) return { ex: "", inst: "" };
  if (raw.includes(":")) {
    const [ex, inst] = raw.split(":");
    return { ex: (ex || "").trim(), inst: (inst || "").trim() };
  }
  // if someone sends "SOLUSDT" only:
  return { ex: "", inst: raw };
}

function missing3cConfig() {
  return !THREECOMMAS_WEBHOOK_URL || !THREECOMMAS_BOT_UUID || !THREECOMMAS_SECRET;
}

async function sendTo3Commas(action, payload) {
  if (missing3cConfig()) {
    console.log(
      "⛔ 3Commas not configured. Missing one of: THREECOMMAS_WEBHOOK_URL / THREECOMMAS_BOT_UUID / THREECOMMAS_SECRET"
    );
    return { ok: false, error: "3commas_not_configured" };
  }

  // Determine exchange/instrument from Ray payload symbol OR defaults
  const { ex, inst } = splitTvSymbol(payload?.symbol);
  const tv_exchange = DEFAULT_TV_EXCHANGE || ex || "BINANCE";
  const tv_instrument = DEFAULT_TV_INSTRUMENT || inst || "SOLUSDT";

  const body = {
    secret: THREECOMMAS_SECRET,
    bot_uuid: THREECOMMAS_BOT_UUID,
    action, // "enter_long" or "exit_long"
    max_lag: "300",
    timestamp: payload?.time || payload?.timestamp || "{{timenow}}",
    trigger_price: String(payload?.price ?? payload?.trigger_price ?? ""),
    tv_exchange,
    tv_instrument
  };

  try {
    const r = await fetch(THREECOMMAS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const text = await r.text();
    console.log(`📨 3Commas POST -> ${action} | status=${r.status} | resp=${text}`);

    return { ok: r.ok, status: r.status, resp: text, sent: body };
  } catch (e) {
    console.log("⛔ 3Commas request failed:", e?.message || e);
    return { ok: false, error: "3commas_request_failed", message: e?.message || String(e) };
  }
}

// ====================
// ROUTES
// ====================
app.get("/", (req, res) => {
  res.send(
    `Brain v2.2 | readyOn=${readyOn} | inPosition=${inPosition} | lastAction=${lastAction}`
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

  // Security (TV -> Railway)
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

      // Approve + forward to 3Commas
      inPosition = true;
      lastAction = "ray_enter_long";
      console.log("🚀 RAY BUY → ENTER LONG");

      const out = await sendTo3Commas("enter_long", payload);
      if (!out.ok) {
        // If 3Commas failed, revert inPosition so next BUY can retry
        inPosition = false;
        lastAction = "ray_enter_long_failed_3c";
        console.log("⛔ enter_long failed -> reverted inPosition=false");
      }

      return res.json({
        ok: out.ok,
        action: "enter_long",
        source: "ray",
        forwarded: out
      });
    }

    // -------- RAY SELL --------
    if (side === "SELL") {
      if (!inPosition) {
        console.log("⛔ Ray SELL ignored (no position)");
        lastAction = "ray_sell_no_position";
        return res.json({ ok: false, blocked: "no_position" });
      }

      // Forward exit first
      lastAction = "ray_exit_long";
      console.log("✅ RAY SELL → EXIT LONG | READY OFF after success");

      const out = await sendTo3Commas("exit_long", payload);

      if (out.ok) {
        inPosition = false;
        readyOn = false;
        readyAtMs = 0;
        console.log("✅ EXIT confirmed by 3Commas | READY OFF");
      } else {
        // If 3Commas failed, keep state so you can retry SELL
        lastAction = "ray_exit_long_failed_3c";
        console.log("⛔ exit_long failed -> keeping inPosition=true and READY unchanged");
      }

      return res.json({
        ok: out.ok,
        action: "exit_long",
        source: "ray",
        forwarded: out,
        readyOn,
        inPosition
      });
    }

    console.log("⚠️ Ray unknown side");
    lastAction = "ray_unknown_side";
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
  // NOTE: This does NOT forward to 3Commas unless you want it to.
  if (action === "enter_long") {
    if (!readyOn || inPosition) {
      console.log("⛔ TV BUY blocked");
      lastAction = "tv_buy_blocked";
      return res.json({ ok: false, blocked: true });
    }
    inPosition = true;
    lastAction = "tv_enter_long";
    console.log("🚀 TV ENTER LONG (local only)");
    return res.json({ ok: true });
  }

  if (action === "exit_long") {
    if (!inPosition) {
      console.log("⛔ TV SELL blocked");
      lastAction = "tv_sell_blocked";
      return res.json({ ok: false, blocked: true });
    }
    inPosition = false;
    readyOn = false;
    readyAtMs = 0;
    lastAction = "tv_exit_long";
    console.log("✅ TV EXIT LONG | READY OFF (local only)");
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
  console.log(`✅ Brain v2.2 listening on port ${PORT}`);
  console.log(
    `Config: READY_TTL_MIN=${READY_TTL_MIN} | WEBHOOK_SECRET=${WEBHOOK_SECRET ? "(set)" : "(not set)"}`
  );
  console.log(
    `3Commas: URL=${THREECOMMAS_WEBHOOK_URL ? "(set)" : "(not set)"} | BOT_UUID=${
      THREECOMMAS_BOT_UUID ? "(set)" : "(not set)"
    } | SECRET=${THREECOMMAS_SECRET ? "(set)" : "(not set)"}`
  );
});
