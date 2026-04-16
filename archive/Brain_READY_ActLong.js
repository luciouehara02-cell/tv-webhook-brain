import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 8080);
const WEBHOOK_PATH = String(process.env.WEBHOOK_PATH || "/webhook");

const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "");
const SYMBOL_FILTER = String(process.env.SYMBOL || "BINANCE:SOLUSDT").trim();
const PRINT_FULL_PAYLOAD = String(process.env.PRINT_FULL_PAYLOAD || "0") === "1";

let tickCount = 0;
let lastTickTime = null;
let lastTickPrice = null;

function isoNow() {
  return new Date().toISOString();
}

function n(v, d = NaN) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function s(v, d = "") {
  return v == null ? d : String(v);
}

function normalizeSymbol(raw) {
  const v = s(raw).trim().toUpperCase();
  if (!v) return "";
  if (v.includes(":")) return v;
  return `BINANCE:${v}`;
}

function extractSecret(body) {
  return String(
    body?.secret ??
      body?.tv_secret ??
      body?.webhook_secret ??
      ""
  );
}

function log(msg, obj = null) {
  if (obj) {
    console.log(`${isoNow()} ${msg} | ${JSON.stringify(obj)}`);
  } else {
    console.log(`${isoNow()} ${msg}`);
  }
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "tick_logger",
    symbol: SYMBOL_FILTER,
    path: WEBHOOK_PATH,
    tickCount,
    lastTickTime,
    lastTickPrice,
  });
});

app.get("/status", (_req, res) => {
  res.json({
    ok: true,
    service: "tick_logger",
    symbol: SYMBOL_FILTER,
    path: WEBHOOK_PATH,
    tickCount,
    lastTickTime,
    lastTickPrice,
  });
});

app.post(WEBHOOK_PATH, (req, res) => {
  const body = req.body || {};

  const secret = extractSecret(body);
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    log("⛔ UNAUTHORIZED", {
      src: body?.src,
      symbol: body?.symbol,
    });
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const src = String(body?.src || "").toLowerCase();
  const symbol = normalizeSymbol(body?.symbol);

  if (src !== "tick") {
    log("ℹ️ NON_TICK_IGNORED", {
      src,
      symbol,
    });
    return res.json({ ok: true, ignored: true, reason: "non_tick" });
  }

  if (SYMBOL_FILTER && symbol !== normalizeSymbol(SYMBOL_FILTER)) {
    log("🚫 SYMBOL_IGNORED", {
      got: symbol,
      expected: normalizeSymbol(SYMBOL_FILTER),
    });
    return res.json({ ok: true, ignored: true, reason: "symbol_mismatch" });
  }

  const price = n(body?.price);
  const time = s(body?.time || body?.timestamp || isoNow());
  const tf = s(body?.tf || "");

  if (!Number.isFinite(price)) {
    log("⚠️ BAD_TICK_PRICE", {
      symbol,
      rawPrice: body?.price,
      time,
    });
    return res.status(400).json({ ok: false, error: "bad_tick_price" });
  }

  tickCount += 1;
  lastTickTime = time;
  lastTickPrice = price;

  log("📍 TICK", {
    count: tickCount,
    symbol,
    tf,
    price,
    time,
  });

  if (PRINT_FULL_PAYLOAD) {
    log("🧾 TICK_PAYLOAD", body);
  }

  return res.json({
    ok: true,
    kind: "tick",
    count: tickCount,
    symbol,
    price,
    time,
  });
});

app.listen(PORT, () => {
  log("✅ tick logger listening", {
    port: PORT,
    path: WEBHOOK_PATH,
    symbol: SYMBOL_FILTER,
  });
});
