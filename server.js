// server.js (Brain v2.4)
// READY-gated engine + drift controls
// ✅ Hard reset on drift block (Ray BUY)
// ✅ Auto-expire READY when drift breached even without Ray BUY (needs "tick" webhooks)
// ✅ Ignore READY while inPosition
// ✅ READY auto-OFF after SELL
// ✅ Optional secret + TTL supported

import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ====================
// CONFIG (Railway Variables)
// ====================
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const READY_TTL_MIN = Number(process.env.READY_TTL_MIN || "30");

// Entry drift gate (BUY must be within this % of READY price)
const READY_MAX_MOVE_PCT = Number(process.env.READY_MAX_MOVE_PCT || "1.2");

// Auto-expire drift gate (READY is cleared if drift exceeds this % without waiting for BUY)
// If not set, defaults to READY_MAX_MOVE_PCT
const READY_AUTOEXPIRE_PCT = Number(
  process.env.READY_AUTOEXPIRE_PCT || String(READY_MAX_MOVE_PCT)
);

// Enable/disable auto-expire check
const READY_AUTOEXPIRE_ENABLED =
  String(process.env.READY_AUTOEXPIRE_ENABLED || "true").toLowerCase() === "true";

// ====================
// MEMORY (in-RAM)
// ====================
let readyOn = false;
let readyAtMs = 0;
let inPosition = false;
let lastAction = "none";

// READY context
let readyPrice = null; // number
let readySymbol = ""; // e.g. "BINANCE:SOLUSDT"
let readyTf = ""; // optional
let readyMeta = {}; // optional

// ====================
// HELPERS
// ====================
const nowMs = () => Date.now();

function clearReadyContext(reason = "cleared") {
  readyOn = false;
  readyAtMs = 0;
  readyPrice = null;
  readySymbol = "";
  readyTf = "";
  readyMeta = {};
  console.log(`🧹 READY context cleared (${reason})`);
}

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

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function getSymbolFromPayload(payload) {
  // Ray uses payload.symbol like "BINANCE:SOLUSDT"
  if (payload?.symbol) return String(payload.symbol);

  // 3Commas-style fields
  if (payload?.tv_exchange && payload?.tv_instrument) {
    return `${payload.tv_exchange}:${payload.tv_instrument}`;
  }

  // TradingView placeholders sometimes use exchange/ticker
  if (payload?.exchange && payload?.ticker) {
    return `${payload.exchange}:${payload.ticker}`;
  }

  if (payload?.tv_instrument) return String(payload.tv_instrument);
  if (payload?.ticker) return String(payload.ticker);

  return "";
}

function getReadyPrice(payload) {
  return (
    toNum(payload?.trigger_price) ??
    toNum(payload?.price) ??
    toNum(payload?.close) ??
    null
  );
}

function getRayPrice(payload) {
  return toNum(payload?.price) ?? toNum(payload?.close) ?? null;
}

function getTickPrice(payload) {
  // tick payload can use price or close
  return toNum(payload?.price) ?? toNum(payload?.close) ?? null;
}

function pctDiff(a, b) {
  if (!Number.isFinite(a) || a === 0) return null;
  return (Math.abs(b - a) / Math.abs(a)) * 100.0;
}

// Auto-expire READY when drift breached (tick-based)
function maybeAutoExpireReady(currentPrice, currentSymbol) {
  if (!READY_AUTOEXPIRE_ENABLED) return false;
  if (!readyOn) return false;
  if (inPosition) return false; // we ignore READY management while in trade
  if (readyPrice == null || currentPrice == null) return false;

  // optional symbol match
  if (readySymbol && currentSymbol && readySymbol !== currentSymbol) {
    // don't auto-expire based on other symbol ticks
    return false;
  }

  const dPct = pctDiff(readyPrice, currentPrice);
  if (dPct == null) return false;

  if (dPct > READY_AUTOEXPIRE_PCT) {
    console.log(
      `🟠 AUTO-EXPIRE READY: drift ${dPct.toFixed(3)}% > ${READY_AUTOEXPIRE_PCT}%`,
      { readyPrice, currentPrice }
    );
    clearReadyContext("auto_expire_drift");
    lastAction = "ready_autoexpired_drift";
    return true;
  }
  return false;
}

// ====================
// ROUTES
// ====================
app.get("/", (req, res) => {
  res.json({
    brain: "v2.4",
    readyOn,
    inPosition,
    lastAction,
    READY_TTL_MIN,
    READY_MAX_MOVE_PCT,
    READY_AUTOEXPIRE_ENABLED,
    READY_AUTOEXPIRE_PCT,
    readyPrice,
    readySymbol,
    readyTf,
  });
});

app.post("/webhook", async (req, res) => {
  const payload = req.body || {};
  logWebhook(payload);

  // TTL expiry
  if (ttlExpired()) {
    clearReadyContext("ttl_expired");
    lastAction = "ready_ttl_expired";
  }

  // Security
  if (!checkSecret(payload)) {
    console.log("⛔ Secret mismatch - blocked");
    return res.status(401).json({ ok: false, error: "secret_mismatch" });
  }

  // ====================
  // TICK PAYLOAD (auto-expire READY)
  // ====================
  // Send from TradingView every bar (or while READY is on), example below.
  if (payload?.src === "tick" || normalizeAction(payload) === "tick") {
    const tickPx = getTickPrice(payload);
    const tickSym = getSymbolFromPayload(payload);

    const expired = maybeAutoExpireReady(tickPx, tickSym);
    return res.json({
      ok: true,
      tick: true,
      expired,
      readyOn,
      readyPrice,
      readySymbol,
    });
  }

  // ====================
  // RAYALGO PAYLOAD
  // ====================
  if (payload?.src === "ray") {
    const side = String(payload.side || "").toUpperCase();
    const rayPx = getRayPrice(payload);
    const raySym = getSymbolFromPayload(payload);

    console.log("Ray side:", side, "| symbol:", raySym, "| price:", rayPx);

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

      // Symbol consistency check
      if (readySymbol && raySym && readySymbol !== raySym) {
        console.log("⛔ Ray BUY blocked (symbol_mismatch)", {
          readySymbol,
          raySym,
        });
        lastAction = "ray_buy_blocked_symbol_mismatch";
        return res.json({
          ok: false,
          blocked: "symbol_mismatch",
          readySymbol,
          raySym,
        });
      }

      // Price-distance gate
      if (readyPrice == null) {
        console.log("⛔ Ray BUY blocked (missing readyPrice)");
        lastAction = "ray_buy_blocked_missing_ready_price";
        return res.json({ ok: false, blocked: "missing_ready_price" });
      }
      if (rayPx == null) {
        console.log("⛔ Ray BUY blocked (missing ray price)");
        lastAction = "ray_buy_blocked_missing_ray_price";
        return res.json({ ok: false, blocked: "missing_ray_price" });
      }

      const dPct = pctDiff(readyPrice, rayPx);
      if (dPct == null) {
        console.log("⛔ Ray BUY blocked (bad price diff calc)");
        lastAction = "ray_buy_blocked_bad_price_diff";
        return res.json({ ok: false, blocked: "bad_price_diff" });
      }

      // ✅ HARD RESET ON DRIFT BLOCK
      if (dPct > READY_MAX_MOVE_PCT) {
        console.log(
          `⛔ Ray BUY blocked (price drift ${dPct.toFixed(
            3
          )}% > ${READY_MAX_MOVE_PCT}%) — HARD RESET READY`,
          { readyPrice, rayPx }
        );

        clearReadyContext("hard_reset_price_drift");
        lastAction = "ray_buy_blocked_price_drift_reset";

        return res.json({
          ok: false,
          blocked: "price_drift_reset",
          drift_pct: dPct,
          limit_pct: READY_MAX_MOVE_PCT,
          readyPrice_before_reset: readyPrice,
          rayPrice: rayPx,
        });
      }

      // Approve entry
      inPosition = true;
      lastAction = "ray_enter_long";
      console.log(
        `🚀 RAY BUY → ENTER LONG | drift=${dPct.toFixed(3)}% (<= ${READY_MAX_MOVE_PCT}%)`
      );

      // NOTE: If you forward to 3Commas in your deployment, keep that code here.
      return res.json({
        ok: true,
        action: "enter_long",
        source: "ray",
        drift_pct: dPct,
      });
    }

    // -------- RAY SELL --------
    if (side === "SELL") {
      if (!inPosition) {
        console.log("⛔ Ray SELL ignored (no position)");
        lastAction = "ray_sell_no_position";
        return res.json({ ok: false, blocked: "no_position" });
      }

      inPosition = false;

      // After exit: READY OFF + clear context
      clearReadyContext("exit_sell");
      lastAction = "ray_exit_long";
      console.log("✅ RAY SELL → EXIT LONG | READY OFF (context cleared)");
      return res.json({ ok: true, action: "exit_long", source: "ray" });
    }

    console.log("⚠️ Ray unknown side");
    return res.json({ ok: true, note: "ray_unknown_side" });
  }

  // ====================
  // YY9 / TV PAYLOAD
  // ====================
  const action = normalizeAction(payload);

  // READY (IGNORE if already in trade)
  if (action === "ready") {
    if (inPosition) {
      console.log("🟡 READY ignored (already in position)");
      lastAction = "ready_ignored_in_position";
      return res.json({ ok: true, ignored: "in_position" });
    }

    readyOn = true;
    readyAtMs = nowMs();

    readyPrice = getReadyPrice(payload);
    readySymbol = getSymbolFromPayload(payload);
    readyTf = payload?.tf ? String(payload.tf) : "";
    readyMeta = {
      timestamp: payload?.timestamp ?? payload?.time ?? null,
      tv_exchange: payload?.tv_exchange ?? payload?.exchange ?? null,
      tv_instrument: payload?.tv_instrument ?? payload?.ticker ?? null,
    };

    lastAction = "ready";
    console.log("🟢 READY ON", {
      readyPrice,
      readySymbol,
      readyTf,
      READY_MAX_MOVE_PCT,
      READY_AUTOEXPIRE_ENABLED,
      READY_AUTOEXPIRE_PCT,
    });

    return res.json({ ok: true, readyOn, readyPrice, readySymbol, readyTf });
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
    clearReadyContext("tv_exit_long");

    lastAction = "tv_exit_long";
    console.log("✅ TV EXIT LONG | READY OFF (context cleared)");
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
  console.log(`✅ Brain v2.4 listening on port ${PORT}`);
  console.log(
    `Config: READY_TTL_MIN=${READY_TTL_MIN} | READY_MAX_MOVE_PCT=${READY_MAX_MOVE_PCT} | READY_AUTOEXPIRE_ENABLED=${READY_AUTOEXPIRE_ENABLED} | READY_AUTOEXPIRE_PCT=${READY_AUTOEXPIRE_PCT} | WEBHOOK_SECRET=${
      WEBHOOK_SECRET ? "(set)" : "(not set)"
    }`
  );
});
