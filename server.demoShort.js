import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ==============================
// ENV
// ==============================

const ENV = {
  PORT: process.env.PORT || 8080,

  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,

  ENABLE_POST_3C: process.env.ENABLE_POST_3C === "true",

  C3_WEBHOOK_URL:
    process.env.C3_WEBHOOK_URL ||
    "https://api.3commas.io/signal_bots/webhooks",

  C3_BOT_UUID: process.env.C3_BOT_UUID,
  C3_WEBHOOK_SECRET: process.env.C3_WEBHOOK_SECRET,

  PROFIT_LOCK_TRIGGER_PCT: parseFloat(
    process.env.PROFIT_LOCK_TRIGGER_PCT || 0.6
  ),
  PROFIT_LOCK_GIVEBACK_PCT: parseFloat(
    process.env.PROFIT_LOCK_GIVEBACK_PCT || 0.3
  ),
};

// ==============================
// STATE
// ==============================

let POSITION = null;

// ==============================
// HELPERS
// ==============================

function verifySecret(got, expected) {
  if (!expected) return false;
  return crypto.timingSafeEqual(
    Buffer.from(String(got)),
    Buffer.from(String(expected))
  );
}

function nowISO(ts) {
  return new Date(ts).toISOString();
}

function toPair(raw) {
  if (!raw) return "UNKNOWN";
  if (raw.includes(":")) raw = raw.split(":")[1];
  return raw;
}

// ==============================
// 3COMMAS CUSTOM SIGNAL FORMAT
// ==============================

function build3CommasPayload(action, evt) {
  return {
    secret: ENV.C3_WEBHOOK_SECRET,
    max_lag: "300",
    timestamp: nowISO(evt.ts),
    trigger_price: String(evt.price),
    tv_exchange: evt.exchange || "BINANCE",
    tv_instrument: evt.instrument,
    action: action, // enter_short / exit_short
    bot_uuid: ENV.C3_BOT_UUID,
  };
}

async function postTo3Commas(payload) {
  const res = await fetch(ENV.C3_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const body = await res.text().catch(() => "");

  return {
    ok: res.ok,
    status: res.status,
    body,
  };
}

// ==============================
// WEBHOOK
// ==============================

app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (!verifySecret(body.secret, ENV.WEBHOOK_SECRET)) {
    return res.status(401).json({ ok: false });
  }

  const ts = Date.parse(body.time || body.timestamp) || Date.now();

  const evt = {
    ts,
    price: parseFloat(body.price || body.trigger_price),
    exchange: body.tv_exchange || "BINANCE",
    instrument: toPair(body.symbol || body.tv_instrument),
    intent: body.src || body.action,
  };

  console.log("WEBHOOK_IN", evt);

  // ==============================
  // ENTER SHORT
  // ==============================

  if (evt.intent === "enter_short") {
    if (!POSITION) {
      POSITION = {
        entry: evt.price,
        trough: evt.price,
        entryTs: ts,
        armed: false,
      };

      console.log("POSITION_SHORT_OPEN", POSITION);

      if (ENV.ENABLE_POST_3C) {
        const payload = build3CommasPayload("enter_short", evt);
        console.log("3COMMAS_POST", payload);
        const resp = await postTo3Commas(payload);
        console.log("3COMMAS_RESP", resp);
      }
    }

    return res.json({ ok: true });
  }

  // ==============================
  // EXIT SHORT
  // ==============================

  if (evt.intent === "exit_short") {
    if (POSITION) {
      console.log("POSITION_SHORT_CLOSE");

      if (ENV.ENABLE_POST_3C) {
        const payload = build3CommasPayload("exit_short", evt);
        console.log("3COMMAS_POST", payload);
        const resp = await postTo3Commas(payload);
        console.log("3COMMAS_RESP", resp);
      }

      POSITION = null;
    }

    return res.json({ ok: true });
  }

  // ==============================
  // TICK (heartbeat + profit lock)
  // ==============================

  if (evt.intent === "tick") {
    if (POSITION) {
      POSITION.trough = Math.min(POSITION.trough, evt.price);

      const move =
        ((POSITION.entry - POSITION.trough) / POSITION.entry) * 100;

      if (!POSITION.armed && move >= ENV.PROFIT_LOCK_TRIGGER_PCT) {
        POSITION.armed = true;
        console.log("PROFIT_LOCK_ARMED");
      }

      if (POSITION.armed) {
        const floor =
          POSITION.trough *
          (1 + ENV.PROFIT_LOCK_GIVEBACK_PCT / 100);

        if (evt.price >= floor) {
          console.log("PROFIT_LOCK_EXIT");

          if (ENV.ENABLE_POST_3C) {
            const payload = build3CommasPayload(
              "exit_short",
              evt
            );
            console.log("3COMMAS_POST", payload);
            const resp = await postTo3Commas(payload);
            console.log("3COMMAS_RESP", resp);
          }

          POSITION = null;
        }
      }
    }

    return res.json({ ok: true });
  }

  return res.json({ ok: true });
});

// ==============================
// START
// ==============================

app.listen(ENV.PORT, () => {
  console.log(`SHORT BRAIN LIVE on ${ENV.PORT}`);
});
