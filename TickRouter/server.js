import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const ROUTER_NAME = process.env.ROUTER_NAME || "TickRouter_AltAssets_v1a_ETH_BNB_XRP_3DEST";
const PORT = Number(process.env.PORT || 8080);
const FORWARD_TIMEOUT_MS = Number(process.env.FORWARD_TIMEOUT_MS || 4000);
const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "").trim();
const REQUIRE_INBOUND_SECRET = String(process.env.REQUIRE_INBOUND_SECRET || "false").toLowerCase() === "true";

function clean(value) {
  return String(value || "").trim().replace(/^["']+/, "").replace(/["']+$/, "").trim();
}
function normalizeSymbol(value) { return clean(value).toUpperCase(); }
function parseCsv(value) { return clean(value).replace(/\r?\n/g, "").split(",").map(clean).filter(Boolean); }
function parseSymbolSet(value) { return new Set(parseCsv(value).map(normalizeSymbol)); }
function hostFromUrl(url) { try { return new URL(url).host.toLowerCase(); } catch { return ""; } }

const ALLOWED_SYMBOLS = parseSymbolSet(
  process.env.ALLOWED_SYMBOLS || "BINANCE:ETHUSDT,BINANCE:BNBUSDT,BINANCE:XRPUSDT"
);

function normalizeDestination(index, label, urlEnv, secretEnv, symbolsEnv) {
  const url = clean(process.env[urlEnv] || "");
  const secret = String(process.env[secretEnv] || "").trim();
  const symbols = parseSymbolSet(process.env[symbolsEnv] || "");
  return { index, label, urlEnv, secretEnv, symbolsEnv, url, host: hostFromUrl(url), secret, symbols, enabled: Boolean(url && hostFromUrl(url)) };
}

const DESTINATIONS = [
  normalizeDestination(1, "PRIMARY_MULTI_SWING", "DEST_1_URL", "DEST_1_SECRET", "DEST_1_SYMBOLS"),
  normalizeDestination(2, "SPARE_RAILWAY_1", "DEST_2_URL", "DEST_2_SECRET", "DEST_2_SYMBOLS"),
  normalizeDestination(3, "SPARE_RAILWAY_2", "DEST_3_URL", "DEST_3_SECRET", "DEST_3_SYMBOLS"),
];

function extractInboundSecret(payload) {
  return String(payload?.secret ?? payload?.tv_secret ?? payload?.token ?? payload?.passphrase ?? "");
}
function inboundSecretOk(payload) {
  if (!REQUIRE_INBOUND_SECRET && !WEBHOOK_SECRET) return true;
  return Boolean(WEBHOOK_SECRET) && extractInboundSecret(payload) === WEBHOOK_SECRET;
}
function upperEvent(payload) { return String(payload?.event || "").trim().toUpperCase(); }
function lowerSrc(payload) { return String(payload?.src || "").trim().toLowerCase(); }
function lowerIntent(payload) { return String(payload?.intent || "").trim().toLowerCase(); }

function payloadKind(payload) {
  const event = upperEvent(payload), src = lowerSrc(payload), intent = lowerIntent(payload);
  if (event === "FEATURE_TICK_FVVO" || src === "fvvo_feature_tick" || intent === "fvvo_feature_tick") return "fvvo_feature_tick";
  if (event === "FEATURE_5M_FVVO" || src === "fvvo_feature_5m" || intent === "fvvo_feature_5m" || src === "fvvo") return "fvvo_feature_5m";
  if (event === "FAST_TICK_FVVO" || src === "fvvo_tick" || intent === "fvvo_tick") return "fvvo_fast_tick";
  return "unknown";
}

function scrubInboundSecret(payload) {
  const out = { ...(payload || {}) };
  delete out.secret; delete out.tv_secret; delete out.token; delete out.passphrase;
  return out;
}

function normalizePayload(payload, kind) {
  const symbol = normalizeSymbol(payload?.symbol || payload?.ticker || "");
  const price = Number(payload?.price ?? payload?.close ?? payload?.lastPrice ?? payload?.last ?? payload?.c);
  if (!symbol) return { ok: false, error: "MISSING_SYMBOL" };
  if (!ALLOWED_SYMBOLS.has(symbol)) return { ok: false, error: "SYMBOL_NOT_ALLOWED", symbol, allowedSymbols: [...ALLOWED_SYMBOLS] };
  if (!Number.isFinite(price) || price <= 0) return { ok: false, error: "INVALID_PRICE", symbol };

  const out = scrubInboundSecret(payload);
  out.symbol = symbol;
  out.price = price;
  if (kind === "fvvo_feature_tick") {
    out.event = "FEATURE_TICK_FVVO"; out.src = out.src || "fvvo_feature_tick"; out.intent = out.intent || "fvvo_feature_tick";
  } else if (kind === "fvvo_feature_5m") {
    out.event = "FEATURE_5M_FVVO"; out.src = out.src || "fvvo_feature_5m"; out.intent = out.intent || "fvvo_feature_5m";
  } else if (kind === "fvvo_fast_tick") {
    out.event = "FAST_TICK_FVVO"; out.src = out.src || "fvvo_tick"; out.intent = out.intent || "fvvo_tick";
  }
  return { ok: true, symbol, price, out };
}

function destinationAcceptsSymbol(dest, symbol) {
  if (!dest.enabled) return false;
  if (!dest.symbols.size) return true;
  return dest.symbols.has(symbol);
}
function activeDestinationsFor(symbol) { return DESTINATIONS.filter((d) => destinationAcceptsSymbol(d, symbol)); }

async function forwardOne(dest, normalized, kind) {
  if (!dest.secret) return { label: dest.label, url: dest.url, host: dest.host, ok: false, skipped: true, status: 0, reason: "MISSING_DESTINATION_SECRET", kind };
  const body = { ...normalized.out, secret: dest.secret };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
  try {
    console.log(`🔐 ALT_ROUTER_FORWARD -> ${dest.url} label=${dest.label} event=${body.event || "-"} symbol=${normalized.symbol} price=${normalized.price} secretSuffix=${dest.secret.slice(-6)}`);
    const response = await fetch(dest.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    const text = await response.text().catch(() => "");
    return { label: dest.label, url: dest.url, host: dest.host, ok: response.ok, skipped: false, status: response.status, response: (text || "").slice(0, 500), kind };
  } catch (error) {
    return { label: dest.label, url: dest.url, host: dest.host, ok: false, skipped: false, status: 0, response: `${error?.name || "Error"}: ${error?.message || String(error)}`, kind };
  } finally { clearTimeout(timeout); }
}

function publicDestination(dest) {
  return { index: dest.index, label: dest.label, enabled: dest.enabled, url: dest.url || null, host: dest.host || null, hasSecret: Boolean(dest.secret), symbols: dest.symbols.size ? [...dest.symbols] : ["ALL_ALLOWED_SYMBOLS"] };
}
function healthSnapshot() {
  return {
    ok: true,
    router: ROUTER_NAME,
    allowedSymbols: [...ALLOWED_SYMBOLS],
    supportedEvents: ["FEATURE_TICK_FVVO", "FEATURE_5M_FVVO", "FAST_TICK_FVVO"],
    inboundSecretCheck: REQUIRE_INBOUND_SECRET || Boolean(WEBHOOK_SECRET),
    forwardTimeoutMs: FORWARD_TIMEOUT_MS,
    destinations: DESTINATIONS.map(publicDestination),
  };
}

app.get("/", (_req, res) => res.json(healthSnapshot()));
app.get("/health", (_req, res) => res.json(healthSnapshot()));
app.get("/routes", (_req, res) => {
  const routes = {};
  for (const symbol of ALLOWED_SYMBOLS) routes[symbol] = activeDestinationsFor(symbol).map((d) => ({ label: d.label, url: d.url }));
  res.json({ ok: true, router: ROUTER_NAME, routes });
});

app.post("/webhook", async (req, res) => {
  const inbound = req.body || {};
  const kind = payloadKind(inbound);

  if (!inboundSecretOk(inbound)) return res.status(401).json({ ok: false, error: "INBOUND_SECRET_MISMATCH", kind });
  if (kind === "unknown") return res.status(200).json({ ok: true, ignored: true, reason: "UNSUPPORTED_PAYLOAD_KIND", event: inbound?.event || null, src: inbound?.src || null, symbol: inbound?.symbol || null });

  const normalized = normalizePayload(inbound, kind);
  if (!normalized.ok) return res.status(normalized.error === "SYMBOL_NOT_ALLOWED" ? 403 : 400).json(normalized);

  const destinations = activeDestinationsFor(normalized.symbol);
  if (!destinations.length) return res.status(503).json({ ok: false, error: "NO_ENABLED_DESTINATION_FOR_SYMBOL", symbol: normalized.symbol, configuredDestinations: DESTINATIONS.map(publicDestination) });

  console.log(`📍 ALT_ROUTER_IN kind=${kind} event=${normalized.out.event || "-"} symbol=${normalized.symbol} price=${normalized.price} targets=${destinations.length}`);
  const results = await Promise.all(destinations.map((d) => forwardOne(d, normalized, kind)));

  for (const result of results) {
    if (result.ok) console.log(`✅ ALT_ROUTER_FORWARD_OK [${result.label}] -> ${result.url} status=${result.status} symbol=${normalized.symbol}`);
    else if (result.skipped) console.error(`⛔ ALT_ROUTER_FORWARD_SKIPPED [${result.label}] -> ${result.url} reason=${result.reason} symbol=${normalized.symbol}`);
    else console.error(`❌ ALT_ROUTER_FORWARD_FAIL [${result.label}] -> ${result.url} status=${result.status} symbol=${normalized.symbol} response=${result.response || ""}`);
  }

  const okCount = results.filter((x) => x.ok).length;
  return res.status(okCount > 0 ? 200 : 502).json({
    ok: okCount > 0,
    accepted: okCount > 0,
    router: ROUTER_NAME,
    kind,
    symbol: normalized.symbol,
    price: normalized.price,
    targetCount: destinations.length,
    forwardOk: okCount,
    results: results.map((x) => ({ label: x.label, ok: x.ok, skipped: x.skipped, status: x.status, reason: x.reason || null, response: x.response || "" })),
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ ${ROUTER_NAME} listening on port ${PORT}`);
  console.log(`Allowed symbols: ${[...ALLOWED_SYMBOLS].join(", ")}`);
  console.log(`Inbound secret check: ${REQUIRE_INBOUND_SECRET || WEBHOOK_SECRET ? "ON" : "OFF"}`);
  for (const dest of DESTINATIONS) {
    console.log(`Destination ${dest.index} ${dest.label}: ${dest.enabled ? dest.url : "(disabled)"} secret=${dest.secret ? "YES" : "NO"} symbols=${dest.symbols.size ? [...dest.symbols].join(",") : "ALL_ALLOWED_SYMBOLS"}`);
  }
  console.log("Supported routes: FEATURE_TICK_FVVO, FEATURE_5M_FVVO, FAST_TICK_FVVO");
});
