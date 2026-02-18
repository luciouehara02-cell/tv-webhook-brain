import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ====================
// CONFIG (Railway Variables)
// ====================
const PORT = process.env.PORT || 3000;

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const READY_TTL_MIN = Number(process.env.READY_TTL_MIN || "0");

// Entry drift gate (BUY must be within this % of READY price)
const READY_MAX_MOVE_PCT = Number(process.env.READY_MAX_MOVE_PCT || "1.2");

// Auto-expire drift gate
const READY_AUTOEXPIRE_PCT = Number(
  process.env.READY_AUTOEXPIRE_PCT || String(READY_MAX_MOVE_PCT)
);
const READY_AUTOEXPIRE_ENABLED =
  String(process.env.READY_AUTOEXPIRE_ENABLED || "true").toLowerCase() === "true";

// 3Commas
const THREECOMMAS_WEBHOOK_URL =
  process.env.THREECOMMAS_WEBHOOK_URL || "https://api.3commas.io/signal_bots/webhooks";
const THREECOMMAS_BOT_UUID = process.env.THREECOMMAS_BOT_UUID || "";
const THREECOMMAS_SECRET = process.env.THREECOMMAS_SECRET || "";
const THREECOMMAS_MAX_LAG = String(process.env.THREECOMMAS_MAX_LAG || "300");

// Optional fallbacks if TV doesn't send these
const THREECOMMAS_TV_EXCHANGE = process.env.THREECOMMAS_TV_EXCHANGE || "";
const THREECOMMAS_TV_INSTRUMENT = process.env.THREECOMMAS_TV_INSTRUMENT || "";

// ====================
// MEMORY (in-RAM)
// ====================
let readyOn = false;
let readyAtMs = 0;
let inPosition = false;
let lastAction = "none";

let readyPrice = null;
let readySymbol = "";
let readyTf = "";
let readyMeta = {};

// ====================
// HELPERS
// ====================
const nowMs = () => Date.now();

function logWebhook(payload) {
  console.log("==== NEW WEBHOOK ====");
  console.log(payload);
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
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

function pctDiff(a, b) {
  if (!Number.isFinite(a) || a === 0) return null;
  return (Math.abs(b - a) / Math.abs(a)) * 100.0;
}

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

function getSymbolFromPayload(payload) {
  if (payload?.symbol) return String(payload.symbol);
  if (payload?.tv_exchange && payload?.tv_instrument)
    return `${payload.tv_exchange}:${payload.tv_instrument}`;
  if (payload?.exchange && payload?.ticker)
    return `${payload.exchange}:${payload.ticker}`;
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
  return toNum(payload?.price) ?? toNum(payload?.close) ?? null;
}

function maybeAutoExpireReady(currentPrice, currentSymbol) {
  if (!READY_AUTOEXPIRE_ENABLED) return false;
  if (!readyOn) return false;
  if (inPosition) return false;
  if (readyPrice == null || currentPrice == null) return false;

  if (readySymbol && currentSymbol && readySymbol !== currentSymbol) return false;

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

// ---- 3Commas forwarder
async function postTo3Commas(action, payload) {
  if (!THREECOMMAS_BOT_UUID || !THREECOMMAS_SECRET) {
    console.log("⚠️ 3Commas not configured (missing BOT_UUID/SECRET) — skipping");
    return { skipped: true };
  }

  const tv_exchange =
    payload?.tv_exchange ??
    payload?.exchange ??
    (readyMeta?.tv_exchange ?? null) ??
    THREECOMMAS_TV_EXCHANGE ??
    null;

  const tv_instrument =
    payload?.tv_instrument ??
    payload?.ticker ??
    (readyMeta?.tv_instrument ?? null) ??
    THREECOMMAS_TV_INSTRUMENT ??
    null;

  const trigger_price =
    toNum(payload?.trigger_price) ??
    toNum(payload?.price) ??
    toNum(payload?.close) ??
    readyPrice ??
    null;

  const body = {
    secret: THREECOMMAS_SECRET,
    max_lag: THREECOMMAS_MAX_LAG,
    timestamp: payload?.timestamp ?? payload?.time ?? new Date().toISOString(),
    trigger_price: trigger_price != null ? String(trigger_price) : "",
    tv_exchange: tv_exchange != null ? String(tv_exchange) : "",
    tv_instrument: tv_instrument != null ? String(tv_instrument) : "",
    action,
    bot_uuid: THREECOMMAS_BOT_UUID,
  };

  try {
    const resp = await fetch(THREECOMMAS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    console.log(`📨 3Commas POST -> ${action} | status=${resp.status} | resp=${text || ""}`);
    return { ok: resp.ok, status: resp.status, resp: text };
  } catch (e) {
    console.log("⛔ 3Commas POST failed:", e?.message || e);
    return { ok: false, error: String(e?.message || e) };
  }
}

// ====================
// ROUTES
// ====================
app.get("/", (req, res) => {
  res.json({
    brain: "v2.5",
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
    threecommas_configured: Boolean(THREECOMMAS_BOT_UUID && THREECOMMAS_SECRET),
  });
});

app.post("/webhook", async (req, res) => {
  const payload = req.body || {};
  logWebhook(payload);

  if (ttlExpired()) {
    clearReadyContext("ttl_expired");
    lastAction = "ready_ttl_expired";
  }

  if (!checkSecret(payload)) {
    console.log("⛔ Secret mismatch - blocked");
    return res.status(401).json({ ok: false, error: "secret_mismatch" });
  }

  // ---- TICK (auto-expire)
  if (payload?.src === "tick" || normalizeAction(payload) === "tick") {
    const tickPx = getTickPrice(payload);
    const tickSym = getSymbolFromPayload(payload);

    // ignore malformed ticks to keep logs clean
    if (tickPx == null || !tickSym) {
      console.log("⚠️ Tick ignored (missing price or symbol)");
      return res.json({ ok: true, tick: true, ignored: "missing_fields" });
    }

    const expired = maybeAutoExpireReady(tickPx, tickSym);
    return res.json({ ok: true, tick: true, expired, readyOn });
  }

  // ---- RAYALGO
  if (payload?.src === "ray") {
    const side = String(payload.side || "").toUpperCase();
    const rayPx = getRayPrice(payload);
    const raySym = getSymbolFromPayload(payload);
    console.log("Ray side:", side, "| symbol:", raySym, "| price:", rayPx);

    if (side === "BUY") {
      if (!readyOn) {
        lastAction = "ray_buy_blocked_not_ready";
        return res.json({ ok: false, blocked: "not_ready" });
      }
      if (inPosition) {
        lastAction = "ray_buy_blocked_in_position";
        return res.json({ ok: false, blocked: "already_in_position" });
      }

      if (readySymbol && raySym && readySymbol !== raySym) {
        lastAction = "ray_buy_blocked_symbol_mismatch";
        return res.json({ ok: false, blocked: "symbol_mismatch", readySymbol, raySym });
      }

      if (readyPrice == null || rayPx == null) {
        lastAction = "ray_buy_blocked_missing_prices";
        return res.json({ ok: false, blocked: "missing_prices" });
      }

      const dPct = pctDiff(readyPrice, rayPx);
      if (dPct == null) {
        lastAction = "ray_buy_blocked_bad_price_diff";
        return res.json({ ok: false, blocked: "bad_price_diff" });
      }

      // HARD RESET ON DRIFT BLOCK
      if (dPct > READY_MAX_MOVE_PCT) {
        console.log(
          `⛔ Ray BUY blocked (drift ${dPct.toFixed(3)}% > ${READY_MAX_MOVE_PCT}%) — HARD RESET READY`
        );
        clearReadyContext("hard_reset_price_drift");
        lastAction = "ray_buy_blocked_price_drift_reset";
        return res.json({ ok: false, blocked: "price_drift_reset", drift_pct: dPct });
      }

      // Approve entry + forward to 3Commas
      inPosition = true;
      lastAction = "ray_enter_long";
      console.log(`🚀 RAY BUY → ENTER LONG | drift=${dPct.toFixed(3)}% (<= ${READY_MAX_MOVE_PCT}%)`);

      const fwd = await postTo3Commas("enter_long", {
        ...payload,
        trigger_price: payload?.price ?? payload?.close ?? readyPrice,
        tv_exchange: readyMeta?.tv_exchange,
        tv_instrument: readyMeta?.tv_instrument,
      });

      return res.json({ ok: true, action: "enter_long", source: "ray", drift_pct: dPct, threecommas: fwd });
    }

    if (side === "SELL") {
      if (!inPosition) {
        lastAction = "ray_sell_no_position";
        return res.json({ ok: false, blocked: "no_position" });
      }

      inPosition = false;
      lastAction = "ray_exit_long";

      const fwd = await postTo3Commas("exit_long", {
        ...payload,
        trigger_price: payload?.price ?? payload?.close ?? "",
        tv_exchange: readyMeta?.tv_exchange,
        tv_instrument: readyMeta?.tv_instrument,
      });

      clearReadyContext("exit_sell");
      console.log("✅ RAY SELL → EXIT LONG | READY OFF (context cleared)");

      return res.json({ ok: true, action: "exit_long", source: "ray", threecommas: fwd });
    }

    lastAction = "ray_unknown_side";
    return res.json({ ok: true, note: "ray_unknown_side" });
  }

  // ---- YY9 READY
  const action = normalizeAction(payload);

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

  lastAction = "unknown";
  return res.json({ ok: true, note: "unknown" });
});

// ====================
// START
// ====================
app.listen(PORT, () => {
  console.log(`✅ Brain v2.5 listening on port ${PORT}`);
  console.log(
    `Config: READY_TTL_MIN=${READY_TTL_MIN} | READY_MAX_MOVE_PCT=${READY_MAX_MOVE_PCT} | READY_AUTOEXPIRE_ENABLED=${READY_AUTOEXPIRE_ENABLED} | READY_AUTOEXPIRE_PCT=${READY_AUTOEXPIRE_PCT} | WEBHOOK_SECRET=${
      WEBHOOK_SECRET ? "(set)" : "(not set)"
    }`
  );
  console.log(
    `3Commas: URL=${THREECOMMAS_WEBHOOK_URL} | BOT_UUID=${THREECOMMAS_BOT_UUID ? "(set)" : "(missing)"} | SECRET=${
      THREECOMMAS_SECRET ? "(set)" : "(missing)"
    }`
  );
});
