import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ====================
// CONFIG (Railway Variables)
// ====================
const PORT = process.env.PORT || 3000;

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// READY TTL (minutes). 0 = disabled
const READY_TTL_MIN = Number(process.env.READY_TTL_MIN || "0");

// Entry drift gate (Ray BUY must be within this % of latest READY price)
const READY_MAX_MOVE_PCT = Number(process.env.READY_MAX_MOVE_PCT || "1.2");

// Auto-expire drift gate (READY auto-clears if price drifts too far)
const READY_AUTOEXPIRE_PCT = Number(
  process.env.READY_AUTOEXPIRE_PCT || String(READY_MAX_MOVE_PCT)
);
const READY_AUTOEXPIRE_ENABLED =
  String(process.env.READY_AUTOEXPIRE_ENABLED || "true").toLowerCase() === "true";

// Cooldown after exit (minutes). 0 = disabled
const EXIT_COOLDOWN_MIN = Number(process.env.EXIT_COOLDOWN_MIN || "0");

// Heartbeat safety (ticks freshness)
const REQUIRE_FRESH_HEARTBEAT =
  String(process.env.REQUIRE_FRESH_HEARTBEAT || "true").toLowerCase() === "true";
const HEARTBEAT_MAX_AGE_SEC = Number(process.env.HEARTBEAT_MAX_AGE_SEC || "240");

// Profit Lock (trailing) protection
const PROFIT_LOCK_ENABLED =
  String(process.env.PROFIT_LOCK_ENABLED || "true").toLowerCase() === "true";

// Arms profit lock when unrealized profit >= this %
const PROFIT_LOCK_ARM_PCT = Number(process.env.PROFIT_LOCK_ARM_PCT || "0.6");

// Once armed: exit if price gives back this % from peak
const PROFIT_LOCK_GIVEBACK_PCT = Number(process.env.PROFIT_LOCK_GIVEBACK_PCT || "0.35");

// Optional: ignore Ray SELL unless profit >= this % (0 disables)
const PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT = Number(
  process.env.PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT || "0"
);

// 3Commas
const THREECOMMAS_WEBHOOK_URL =
  process.env.THREECOMMAS_WEBHOOK_URL || "https://api.3commas.io/signal_bots/webhooks";
const THREECOMMAS_BOT_UUID = process.env.THREECOMMAS_BOT_UUID || "";
const THREECOMMAS_SECRET = process.env.THREECOMMAS_SECRET || "";
const THREECOMMAS_MAX_LAG = String(process.env.THREECOMMAS_MAX_LAG || "300");
const THREECOMMAS_TIMEOUT_MS = Number(process.env.THREECOMMAS_TIMEOUT_MS || "8000");

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

// Cooldown state
let cooldownUntilMs = 0;

// Heartbeat / price cache
let lastTickMs = 0;
let lastTickSymbol = "";
let lastTickPrice = null;

// Trade tracking for profit lock
let entryPrice = null;
let entrySymbol = "";
let peakPrice = null;
let profitLockArmed = false;

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

function pctProfit(entry, current) {
  if (!Number.isFinite(entry) || entry === 0 || !Number.isFinite(current)) return null;
  return ((current - entry) / entry) * 100.0;
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

function clearPositionContext(reason = "pos_cleared") {
  inPosition = false;
  entryPrice = null;
  entrySymbol = "";
  peakPrice = null;
  profitLockArmed = false;
  console.log(`🧽 POSITION context cleared (${reason})`);
}

function startCooldown(reason = "exit") {
  if (!EXIT_COOLDOWN_MIN || EXIT_COOLDOWN_MIN <= 0) return;
  cooldownUntilMs = nowMs() + EXIT_COOLDOWN_MIN * 60 * 1000;
  console.log(`⏳ Cooldown started (${EXIT_COOLDOWN_MIN} min) reason=${reason}`);
}

function cooldownActive() {
  return cooldownUntilMs && nowMs() < cooldownUntilMs;
}

function ttlExpired() {
  if (!READY_TTL_MIN || READY_TTL_MIN <= 0) return false;
  return readyOn && nowMs() - readyAtMs > READY_TTL_MIN * 60 * 1000;
}

function isHeartbeatFresh() {
  if (!REQUIRE_FRESH_HEARTBEAT) return true;
  if (!lastTickMs) return false;
  return nowMs() - lastTickMs <= HEARTBEAT_MAX_AGE_SEC * 1000;
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

// ---- 3Commas forwarder (with timeout)
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

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), THREECOMMAS_TIMEOUT_MS);

  try {
    const resp = await fetch(THREECOMMAS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await resp.text();
    console.log(
      `📨 3Commas POST -> ${action} | status=${resp.status} | resp=${text || ""}`
    );
    return { ok: resp.ok, status: resp.status, resp: text };
  } catch (e) {
    console.log("⛔ 3Commas POST failed:", e?.name === "AbortError" ? "timeout" : (e?.message || e));
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// Profit lock evaluator (runs on each tick)
async function maybeProfitLockExit(currentPrice, currentSymbol) {
  if (!PROFIT_LOCK_ENABLED) return false;
  if (!inPosition) return false;
  if (!entryPrice || currentPrice == null) return false;
  if (entrySymbol && currentSymbol && entrySymbol !== currentSymbol) return false;

  // update peak
  peakPrice = peakPrice == null ? currentPrice : Math.max(peakPrice, currentPrice);

  const p = pctProfit(entryPrice, currentPrice);
  if (p == null) return false;

  // arm lock
  if (!profitLockArmed && p >= PROFIT_LOCK_ARM_PCT) {
    profitLockArmed = true;
    console.log(`🔒 PROFIT LOCK ARMED at +${p.toFixed(3)}% (>= ${PROFIT_LOCK_ARM_PCT}%)`);
  }

  if (!profitLockArmed) return false;

  // trailing floor from peak
  const floor = peakPrice * (1 - PROFIT_LOCK_GIVEBACK_PCT / 100);
  if (currentPrice <= floor) {
    console.log(
      `🧷 PROFIT LOCK EXIT: price=${currentPrice} <= floor=${floor.toFixed(4)} | peak=${peakPrice} | giveback=${PROFIT_LOCK_GIVEBACK_PCT}%`
    );

    // Exit long immediately (no Ray SELL required)
    lastAction = "profit_lock_exit_long";
    const fwd = await postTo3Commas("exit_long", {
      time: new Date().toISOString(),
      trigger_price: currentPrice,
      tv_exchange: readyMeta?.tv_exchange,
      tv_instrument: readyMeta?.tv_instrument,
    });

    clearReadyContext("profit_lock_exit");
    clearPositionContext("profit_lock_exit");
    startCooldown("profit_lock_exit");
    return { exited: true, threecommas: fwd };
  }

  return false;
}

// ====================
// ROUTES
// ====================
app.get("/", (req, res) => {
  res.json({
    brain: "v2.7",
    readyOn,
    inPosition,
    lastAction,
    READY_TTL_MIN,
    READY_MAX_MOVE_PCT,
    READY_AUTOEXPIRE_ENABLED,
    READY_AUTOEXPIRE_PCT,
    EXIT_COOLDOWN_MIN,
    cooldownActive: cooldownActive(),
    cooldownUntilMs,
    REQUIRE_FRESH_HEARTBEAT,
    HEARTBEAT_MAX_AGE_SEC,
    lastTickMs,
    lastTickSymbol,
    lastTickPrice,
    PROFIT_LOCK_ENABLED,
    PROFIT_LOCK_ARM_PCT,
    PROFIT_LOCK_GIVEBACK_PCT,
    readyPrice,
    readySymbol,
    readyTf,
    entryPrice,
    entrySymbol,
    peakPrice,
    profitLockArmed,
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

  // ---- TICK (heartbeat + auto-expire + profit lock)
  if (payload?.src === "tick" || normalizeAction(payload) === "tick") {
    const tickPx = getTickPrice(payload);
    const tickSym = getSymbolFromPayload(payload);

    if (tickPx == null || !tickSym) {
      console.log("⚠️ Tick ignored (missing price or symbol)");
      return res.json({ ok: true, tick: true, ignored: "missing_fields" });
    }

    // Update heartbeat cache
    lastTickMs = nowMs();
    lastTickSymbol = tickSym;
    lastTickPrice = tickPx;

    // Auto-expire READY if drift too large
    const expired = maybeAutoExpireReady(tickPx, tickSym);

    // Profit lock check (may auto exit)
    const pl = await maybeProfitLockExit(tickPx, tickSym);

    return res.json({ ok: true, tick: true, expired, profit_lock: pl || null, readyOn, inPosition });
  }

  // ---- RAYALGO
  if (payload?.src === "ray") {
    const side = String(payload.side || "").toUpperCase();
    const rayPx = getRayPrice(payload);
    const raySym = getSymbolFromPayload(payload);
    console.log("Ray side:", side, "| symbol:", raySym, "| price:", rayPx);

    if (side === "BUY") {
      if (cooldownActive()) {
        lastAction = "ray_buy_blocked_cooldown";
        return res.json({ ok: false, blocked: "cooldown_active" });
      }

      if (!isHeartbeatFresh()) {
        lastAction = "ray_buy_blocked_stale_heartbeat";
        return res.json({ ok: false, blocked: "stale_heartbeat" });
      }

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
      entryPrice = rayPx;
      entrySymbol = raySym || readySymbol || "";
      peakPrice = rayPx;
      profitLockArmed = false;

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

      // Optional: ignore Ray SELL unless profit >= threshold
      if (PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT > 0) {
        const px = rayPx ?? lastTickPrice;
        const p = pctProfit(entryPrice, px);
        if (p != null && p < PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT) {
          lastAction = "ray_sell_blocked_profit_filter";
          console.log(
            `⛔ Ray SELL ignored: profit ${p.toFixed(3)}% < ${PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT}%`
          );
          return res.json({ ok: false, blocked: "profit_filter", profit_pct: p });
        }
      }

      lastAction = "ray_exit_long";

      const fwd = await postTo3Commas("exit_long", {
        ...payload,
        trigger_price: payload?.price ?? payload?.close ?? "",
        tv_exchange: readyMeta?.tv_exchange,
        tv_instrument: readyMeta?.tv_instrument,
      });

      clearReadyContext("exit_sell");
      clearPositionContext("exit_sell");
      startCooldown("ray_sell");

      console.log("✅ RAY SELL → EXIT LONG | READY OFF (context cleared)");
      return res.json({ ok: true, action: "exit_long", source: "ray", threecommas: fwd });
    }

    lastAction = "ray_unknown_side";
    return res.json({ ok: true, note: "ray_unknown_side" });
  }

  // ---- YY9 READY
  const action = normalizeAction(payload);

  if (action === "ready") {
    if (cooldownActive()) {
      console.log("🟡 READY ignored (cooldown active)");
      lastAction = "ready_ignored_cooldown";
      return res.json({ ok: true, ignored: "cooldown_active" });
    }

    if (!isHeartbeatFresh()) {
      console.log("🟡 READY ignored (stale heartbeat)");
      lastAction = "ready_ignored_stale_heartbeat";
      return res.json({ ok: true, ignored: "stale_heartbeat" });
    }

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
  console.log(`✅ Brain v2.7 listening on port ${PORT}`);
  console.log(
    `Config: READY_TTL_MIN=${READY_TTL_MIN} | READY_MAX_MOVE_PCT=${READY_MAX_MOVE_PCT} | READY_AUTOEXPIRE_ENABLED=${READY_AUTOEXPIRE_ENABLED} | READY_AUTOEXPIRE_PCT=${READY_AUTOEXPIRE_PCT} | EXIT_COOLDOWN_MIN=${EXIT_COOLDOWN_MIN}`
  );
  console.log(
    `Heartbeat: REQUIRE_FRESH_HEARTBEAT=${REQUIRE_FRESH_HEARTBEAT} | HEARTBEAT_MAX_AGE_SEC=${HEARTBEAT_MAX_AGE_SEC}`
  );
  console.log(
    `ProfitLock: ENABLED=${PROFIT_LOCK_ENABLED} | ARM_PCT=${PROFIT_LOCK_ARM_PCT} | GIVEBACK_PCT=${PROFIT_LOCK_GIVEBACK_PCT} | SELL_MIN_ACCEPT_PCT=${PROFIT_LOCK_MIN_PROFIT_TO_ACCEPT_RAY_SELL_PCT}`
  );
  console.log(
    `3Commas: URL=${THREECOMMAS_WEBHOOK_URL} | BOT_UUID=${THREECOMMAS_BOT_UUID ? "(set)" : "(missing)"} | SECRET=${
      THREECOMMAS_SECRET ? "(set)" : "(missing)"
    } | TIMEOUT_MS=${THREECOMMAS_TIMEOUT_MS}`
  );
});
