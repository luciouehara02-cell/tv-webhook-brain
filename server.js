import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const ROUTER_NAME = "TickRouter_v4_FEATURE_TICK_LEGACY_MIRROR";

const PORT = Number(process.env.PORT || 8080);

const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "");
const BRAIN_SECRET = String(process.env.BRAIN_SECRET || "");
const FORWARD_TIMEOUT_MS = Number(process.env.FORWARD_TIMEOUT_MS || 4000);

const STRICT_DEST_SECRET =
  String(process.env.STRICT_DEST_SECRET || "true").toLowerCase() === "true";

/**
 * If true, a payload with src="features" and no event can be routed to FVVO as
 * FEATURE_5M_FVVO. Keep false unless you intentionally send FVVO 5m feature
 * publisher through TickRouter in old src="features" format.
 */
const ROUTE_SRC_FEATURES_TO_FVVO =
  String(process.env.ROUTE_SRC_FEATURES_TO_FVVO || "false").toLowerCase() ===
  "true";

/**
 * When true, an inbound FAST_TICK_FVVO / fvvo_tick payload is also mirrored
 * to legacy BRAIN_URLS using the old legacy tick format:
 * { secret, src:"tick", symbol, price, time }
 *
 * This lets one TradingView FVVO fast-tick alert feed both:
 * - FVVO brains via FVVO_BRAIN_URLS as FAST_TICK_FVVO
 * - legacy/Ray/old brains via BRAIN_URLS as src=tick
 */
const FORWARD_FVVO_FAST_TICK_TO_LEGACY =
  String(process.env.FORWARD_FVVO_FAST_TICK_TO_LEGACY || "true").toLowerCase() ===
  "true";

/**
 * v4 combined-alert mode.
 *
 * When true, one inbound FEATURE_TICK_FVVO alert is forwarded to:
 * - FVVO_BRAIN_URLS as the full FEATURE_TICK_FVVO payload
 * - BRAIN_URLS as a legacy price tick payload: { secret, src:"tick", symbol, price, time }
 *
 * This lets you disable the old separate FAST_TICK_FVVO price alert and run one
 * 15s feature-tick alert that keeps legacy/Ray brains alive with price ticks.
 */
const FORWARD_FVVO_FEATURE_TICK_TO_LEGACY =
  String(process.env.FORWARD_FVVO_FEATURE_TICK_TO_LEGACY || "true").toLowerCase() ===
  "true";

/**
 * Optional compatibility mode. Normally keep false because FVVO brains already
 * receive the full FEATURE_TICK_FVVO payload and v1r can evaluate feature-tick
 * entries/exits from it.
 *
 * Set true only if a FVVO brain still requires old FAST_TICK_FVVO / FVVO_TICK_TAPE
 * handling while you want to run only one TradingView alert.
 */
const FORWARD_FVVO_FEATURE_TICK_AS_FVVO_FAST_TICK =
  String(process.env.FORWARD_FVVO_FEATURE_TICK_AS_FVVO_FAST_TICK || "false").toLowerCase() ===
  "true";

/**
 * Cleans Railway/env formatting mistakes:
 * - outer quotes around whole URL lists
 * - quotes around individual URLs
 * - accidental newlines
 * - extra spaces
 */
function cleanEnvUrlPart(v) {
  return String(v || "")
    .trim()
    .replace(/^["']+/, "")
    .replace(/["']+$/, "")
    .trim();
}

function parseUrlList(envValue) {
  return String(envValue || "")
    .replace(/\r?\n/g, "")
    .split(",")
    .map(cleanEnvUrlPart)
    .filter(Boolean);
}

/**
 * Legacy old-brain targets.
 * These receive old generic tick format:
 * { secret, src:"tick", symbol, price, time }
 */
const RAW_BRAIN_URLS = parseUrlList(process.env.BRAIN_URLS || "");

/**
 * FVVO targets.
 * These can now receive:
 * - FAST_TICK_FVVO
 * - FEATURE_TICK_FVVO
 * - FEATURE_5M_FVVO
 */
const RAW_FVVO_BRAIN_URLS = parseUrlList(process.env.FVVO_BRAIN_URLS || "");

/**
 * Avoid duplicate forwarding if a FVVO URL is accidentally also inside BRAIN_URLS.
 * FVVO_BRAIN_URLS wins.
 */
const fvvoUrlSet = new Set(RAW_FVVO_BRAIN_URLS.map((u) => u.toLowerCase()));
const BRAIN_URLS = RAW_BRAIN_URLS.filter((u) => !fvvoUrlSet.has(u.toLowerCase()));
const FVVO_BRAIN_URLS = RAW_FVVO_BRAIN_URLS;

let BRAIN_SECRET_MAP = {};
try {
  const raw = String(process.env.BRAIN_SECRET_MAP_JSON || "").trim();
  if (raw) BRAIN_SECRET_MAP = JSON.parse(raw);
} catch (e) {
  console.error(
    "⚠️ Invalid BRAIN_SECRET_MAP_JSON (must be valid JSON). Ignoring.",
    e?.message || e
  );
  BRAIN_SECRET_MAP = {};
}

let FVVO_SECRET_MAP = {};
try {
  const raw = String(process.env.FVVO_SECRET_MAP_JSON || "").trim();
  if (raw) FVVO_SECRET_MAP = JSON.parse(raw);
} catch (e) {
  console.error(
    "⚠️ Invalid FVVO_SECRET_MAP_JSON (must be valid JSON). Ignoring.",
    e?.message || e
  );
  FVVO_SECRET_MAP = {};
}

function extractSecret(payload) {
  return String(
    payload?.secret ??
      payload?.tv_secret ??
      payload?.token ??
      payload?.passphrase ??
      ""
  );
}

function inboundSecretOk(payload) {
  if (!WEBHOOK_SECRET) return true;
  return extractSecret(payload) === WEBHOOK_SECRET;
}

function hostFromUrl(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

function secretFromEnv(envName) {
  return String(process.env[envName] || "");
}

function upperEvent(inbound) {
  return String(inbound?.event || "").trim().toUpperCase();
}

function lowerSrc(inbound) {
  return String(inbound?.src || "").trim().toLowerCase();
}

function lowerIntent(inbound) {
  return String(inbound?.intent || "").trim().toLowerCase();
}

function looksLikeFvvoTick(inbound) {
  const src = lowerSrc(inbound);
  const intent = lowerIntent(inbound);
  const event = upperEvent(inbound);

  return src === "fvvo_tick" || intent === "fvvo_tick" || event === "FAST_TICK_FVVO";
}

function looksLikeGenericTick(inbound) {
  const src = lowerSrc(inbound);
  const intent = lowerIntent(inbound);
  const event = upperEvent(inbound);

  return src === "tick" || intent === "tick" || event === "FAST_TICK";
}

function looksLikeFeatureTickFvvo(inbound) {
  const src = lowerSrc(inbound);
  const intent = lowerIntent(inbound);
  const event = upperEvent(inbound);

  return (
    src === "fvvo_feature_tick" ||
    intent === "fvvo_feature_tick" ||
    event === "FEATURE_TICK_FVVO"
  );
}

function looksLikeFeature5mFvvo(inbound) {
  const src = lowerSrc(inbound);
  const intent = lowerIntent(inbound);
  const event = upperEvent(inbound);

  if (
    src === "fvvo_feature_5m" ||
    intent === "fvvo_feature_5m" ||
    event === "FEATURE_5M_FVVO"
  ) {
    return true;
  }

  if (ROUTE_SRC_FEATURES_TO_FVVO && src === "features") {
    return true;
  }

  return false;
}

function getPayloadKind(inbound) {
  if (looksLikeFeatureTickFvvo(inbound)) return "fvvo_feature_tick";
  if (looksLikeFeature5mFvvo(inbound)) return "fvvo_feature_5m";
  if (looksLikeFvvoTick(inbound)) return "fvvo_fast_tick";
  if (looksLikeGenericTick(inbound)) return "generic_tick";
  return "unknown";
}

function normalizeTimeValue(v) {
  const raw = String(v || "").trim();

  if (!raw) return new Date().toISOString();

  // TradingView sometimes gives a clean ISO-ish string already.
  const t = Date.parse(raw);
  if (Number.isFinite(t)) return new Date(t).toISOString();

  return raw;
}

function normalizeTickPayload(inbound) {
  const symbol = String(inbound?.symbol || inbound?.ticker || "").trim();

  const priceRaw =
    inbound?.price ??
    inbound?.close ??
    inbound?.lastPrice ??
    inbound?.last ??
    inbound?.c;

  const price = Number(priceRaw);

  const time = normalizeTimeValue(
    inbound?.time ?? inbound?.timenow ?? inbound?.timestamp ?? inbound?.ts
  );

  if (!symbol) {
    return { ok: false, error: "missing_symbol" };
  }

  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, error: "invalid_price" };
  }

  return {
    ok: true,
    symbol,
    price,
    time,
    inboundSrc: String(inbound?.src || ""),
    inboundIntent: String(inbound?.intent || ""),
    inboundEvent: String(inbound?.event || ""),
  };
}

function normalizeFeaturePayload(inbound, kind) {
  const symbol = String(inbound?.symbol || inbound?.ticker || "").trim();

  const priceRaw =
    inbound?.price ??
    inbound?.close ??
    inbound?.lastPrice ??
    inbound?.last ??
    inbound?.c;

  const price = Number(priceRaw);

  const time = normalizeTimeValue(
    inbound?.time ??
      inbound?.bar_time ??
      inbound?.alert_time ??
      inbound?.timenow ??
      inbound?.timestamp ??
      inbound?.ts
  );

  if (!symbol) {
    return { ok: false, error: "missing_symbol" };
  }

  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, error: "invalid_price" };
  }

  return {
    ok: true,
    kind,
    symbol,
    price,
    time,
    inboundSrc: String(inbound?.src || ""),
    inboundIntent: String(inbound?.intent || ""),
    inboundEvent: String(inbound?.event || ""),
  };
}

function legacySecretFor(url) {
  const host = hostFromUrl(url);
  const u = String(url || "").toLowerCase();

  if (host && BRAIN_SECRET_MAP && typeof BRAIN_SECRET_MAP === "object") {
    const mapped = BRAIN_SECRET_MAP[host];
    if (mapped) {
      return { secret: String(mapped), source: `MAP_JSON:${host}` };
    }
  }

  if (u.includes("brainact-production")) {
    const s = secretFromEnv("BRAIN_SECRET_ACTLONG");
    if (s) return { secret: s, source: "ENV:BRAIN_SECRET_ACTLONG" };
    return { secret: "", source: "MISSING_ENV:BRAIN_SECRET_ACTLONG" };
  }

  if (
    u.includes("braindemolong-production") ||
    u.includes("satisfied-mercy-production")
  ) {
    const s = secretFromEnv("BRAIN_SECRET_DEMOLONG");
    if (s) return { secret: s, source: "ENV:BRAIN_SECRET_DEMOLONG" };
    return { secret: "", source: "MISSING_ENV:BRAIN_SECRET_DEMOLONG" };
  }

  if (u.includes("demophase5-production")) {
    const s = secretFromEnv("BRAIN_SECRET_DEMOPHASE5");
    if (s) return { secret: s, source: "ENV:BRAIN_SECRET_DEMOPHASE5" };
    return { secret: "", source: "MISSING_ENV:BRAIN_SECRET_DEMOPHASE5" };
  }

  // Old / original BrainRAY Continuation
  if (u.includes("brainraycontinuation-production")) {
    const s = secretFromEnv("BRAIN_SECRET_BRAINRAYCONTINUATION");
    if (s) {
      return { secret: s, source: "ENV:BRAIN_SECRET_BRAINRAYCONTINUATION" };
    }
    return {
      secret: "",
      source: "MISSING_ENV:BRAIN_SECRET_BRAINRAYCONTINUATION",
    };
  }

  // Live BrainRAY Continuation JS
  if (u.includes("brainraylivecontinuationjs-production")) {
    const s = secretFromEnv("BRAIN_SECRET_LIVE_BRAINRAY");
    if (s) {
      return { secret: s, source: "ENV:BRAIN_SECRET_LIVE_BRAINRAY" };
    }
    return {
      secret: "",
      source: "MISSING_ENV:BRAIN_SECRET_LIVE_BRAINRAY",
    };
  }

  // Paper / Demo BrainRAY Continuation
  if (u.includes("brainraypapercontinuation-production")) {
    const s = secretFromEnv("BRAIN_SECRET_PAPER_BRAINRAY");
    if (s) {
      return { secret: s, source: "ENV:BRAIN_SECRET_PAPER_BRAINRAY" };
    }
    return {
      secret: "",
      source: "MISSING_ENV:BRAIN_SECRET_PAPER_BRAINRAY",
    };
  }

  // Optional fallback only when strict mode is OFF
  if (!STRICT_DEST_SECRET) {
    if (BRAIN_SECRET) {
      return { secret: BRAIN_SECRET, source: "ENV:BRAIN_SECRET(default)" };
    }
  }

  return {
    secret: "",
    source: STRICT_DEST_SECRET ? "STRICT_NO_FALLBACK" : "NO_SECRET_AVAILABLE",
  };
}

function fvvoSecretFor(url) {
  const host = hostFromUrl(url);
  const u = String(url || "").toLowerCase();

  /**
   * Highest priority: exact host mapping for FVVO.
   * Example Railway env:
   * FVVO_SECRET_MAP_JSON={"your-demo-host.up.railway.app":"DEMO_SECRET","your-live-host.up.railway.app":"LIVE_SECRET"}
   */
  if (host && FVVO_SECRET_MAP && typeof FVVO_SECRET_MAP === "object") {
    const mapped = FVVO_SECRET_MAP[host];
    if (mapped) {
      return { secret: String(mapped), source: `FVVO_MAP_JSON:${host}` };
    }
  }

  /**
   * Second priority: general brain secret map also works for FVVO targets.
   */
  if (host && BRAIN_SECRET_MAP && typeof BRAIN_SECRET_MAP === "object") {
    const mapped = BRAIN_SECRET_MAP[host];
    if (mapped) {
      return { secret: String(mapped), source: `MAP_JSON:${host}` };
    }
  }

  /**
   * Simple auto-detect by URL name.
   * Use these Railway variables:
   * BRAIN_SECRET_FVVO_DEMO
   * BRAIN_SECRET_FVVO_LIVE
   */
  if (u.includes("live")) {
    const s = secretFromEnv("BRAIN_SECRET_FVVO_LIVE");
    if (s) return { secret: s, source: "ENV:BRAIN_SECRET_FVVO_LIVE" };
    return { secret: "", source: "MISSING_ENV:BRAIN_SECRET_FVVO_LIVE" };
  }

  if (
    u.includes("demo") ||
    u.includes("paper") ||
    u.includes("shadow") ||
    u.includes("shadw")
  ) {
    const s = secretFromEnv("BRAIN_SECRET_FVVO_DEMO");
    if (s) return { secret: s, source: "ENV:BRAIN_SECRET_FVVO_DEMO" };
    return { secret: "", source: "MISSING_ENV:BRAIN_SECRET_FVVO_DEMO" };
  }

  /**
   * Optional single FVVO secret fallback.
   */
  const genericFvvoSecret = secretFromEnv("BRAIN_SECRET_FVVO");
  if (genericFvvoSecret) {
    return { secret: genericFvvoSecret, source: "ENV:BRAIN_SECRET_FVVO" };
  }

  if (!STRICT_DEST_SECRET && BRAIN_SECRET) {
    return { secret: BRAIN_SECRET, source: "ENV:BRAIN_SECRET(default)" };
  }

  return {
    secret: "",
    source: STRICT_DEST_SECRET ? "STRICT_NO_FVVO_SECRET" : "NO_SECRET_AVAILABLE",
  };
}

function buildLegacyTickPayload(tick, secret) {
  return {
    secret,
    src: "tick",
    symbol: tick.symbol,
    price: String(tick.price),
    time: tick.time,
  };
}

function buildFvvoTickPayload(tick, secret) {
  return {
    secret,
    event: "FAST_TICK_FVVO",
    src: "fvvo_tick",
    intent: "fvvo_tick",
    symbol: tick.symbol,
    price: tick.price,
    time: tick.time,
  };
}

function scrubInboundSecret(payload) {
  const out = { ...(payload || {}) };
  delete out.secret;
  delete out.tv_secret;
  delete out.token;
  delete out.passphrase;
  return out;
}

function buildFvvoFeaturePayload(inbound, feature, secret) {
  const clean = scrubInboundSecret(inbound);
  const kind = feature.kind;

  const out = {
    ...clean,
    secret,
    symbol: feature.symbol,
    price: feature.price,
  };

  if (!out.tf) out.tf = String(inbound?.tf || process.env.ENTRY_TF || "5");
  if (!out.time && feature.time) out.time = feature.time;

  if (kind === "fvvo_feature_tick") {
    out.event = "FEATURE_TICK_FVVO";
    out.src = out.src || "fvvo_feature_tick";
    out.intent = out.intent || "fvvo_feature_tick";
  } else {
    out.event = "FEATURE_5M_FVVO";
    out.src = out.src || "fvvo_feature_5m";
    out.intent = out.intent || "fvvo_feature_5m";
  }

  return out;
}

async function forwardToBrain(url, payload, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    const text = await resp.text().catch(() => "");

    return {
      url,
      ok: resp.ok,
      status: resp.status,
      resp: (text || "").slice(0, 400),
    };
  } catch (e) {
    return {
      url,
      ok: false,
      status: 0,
      resp: `${e?.name || "Error"}: ${e?.message || String(e)}`,
    };
  } finally {
    clearTimeout(t);
  }
}

async function forwardLegacyTick(urlRaw, tick) {
  const url = cleanEnvUrlPart(urlRaw);

  if (!hostFromUrl(url)) {
    console.error(`❌ Invalid legacy destination URL -> ${urlRaw}`);
    return {
      mode: "legacy_tick",
      url: urlRaw,
      ok: false,
      status: 0,
      resp: "invalid_destination_url",
    };
  }

  const { secret, source } = legacySecretFor(url);

  if (!secret) {
    console.error(
      `⛔ LEGACY SKIP -> ${url} (missing destination brain secret) source=${source}`
    );
    return {
      mode: "legacy_tick",
      url,
      ok: false,
      status: 0,
      resp: "skipped_missing_brain_secret",
      skipped: true,
      source,
    };
  }

  const out = buildLegacyTickPayload(tick, secret);
  const suffix = String(secret).slice(-6);

  console.log(
    `🔐 LEGACY_TICK -> ${url} host=${hostFromUrl(url)} secretSuffix=${suffix} ` +
      `symbol=${tick.symbol} price=${tick.price} via=${source}`
  );

  const r = await forwardToBrain(url, out, FORWARD_TIMEOUT_MS);
  return { ...r, mode: "legacy_tick", source };
}

async function forwardFvvoTick(urlRaw, tick) {
  const url = cleanEnvUrlPart(urlRaw);

  if (!hostFromUrl(url)) {
    console.error(`❌ Invalid FVVO destination URL -> ${urlRaw}`);
    return {
      mode: "fvvo_tick",
      url: urlRaw,
      ok: false,
      status: 0,
      resp: "invalid_destination_url",
    };
  }

  const { secret, source } = fvvoSecretFor(url);

  if (!secret) {
    console.error(
      `⛔ FVVO SKIP -> ${url} (missing FVVO destination secret) source=${source}`
    );
    return {
      mode: "fvvo_tick",
      url,
      ok: false,
      status: 0,
      resp: "skipped_missing_fvvo_secret",
      skipped: true,
      source,
    };
  }

  const out = buildFvvoTickPayload(tick, secret);
  const suffix = String(secret).slice(-6);

  console.log(
    `🔐 FVVO_TICK -> ${url} host=${hostFromUrl(url)} secretSuffix=${suffix} ` +
      `event=FAST_TICK_FVVO symbol=${tick.symbol} price=${tick.price} via=${source}`
  );

  const r = await forwardToBrain(url, out, FORWARD_TIMEOUT_MS);
  return { ...r, mode: "fvvo_tick", source };
}

async function forwardFvvoFeature(urlRaw, inbound, feature) {
  const url = cleanEnvUrlPart(urlRaw);

  if (!hostFromUrl(url)) {
    console.error(`❌ Invalid FVVO feature destination URL -> ${urlRaw}`);
    return {
      mode: feature.kind,
      url: urlRaw,
      ok: false,
      status: 0,
      resp: "invalid_destination_url",
    };
  }

  const { secret, source } = fvvoSecretFor(url);

  if (!secret) {
    console.error(
      `⛔ FVVO FEATURE SKIP -> ${url} (missing FVVO destination secret) source=${source}`
    );
    return {
      mode: feature.kind,
      url,
      ok: false,
      status: 0,
      resp: "skipped_missing_fvvo_secret",
      skipped: true,
      source,
    };
  }

  const out = buildFvvoFeaturePayload(inbound, feature, secret);
  const suffix = String(secret).slice(-6);

  console.log(
    `🔐 FVVO_FEATURE -> ${url} host=${hostFromUrl(url)} secretSuffix=${suffix} ` +
      `event=${out.event} symbol=${feature.symbol} price=${feature.price} via=${source}`
  );

  const r = await forwardToBrain(url, out, FORWARD_TIMEOUT_MS);
  return { ...r, mode: feature.kind, source };
}

function summarizeResults(results, targetCounts) {
  const anyOk = results.some((r) => r.ok);
  const legacyOk = results.filter((r) => r.mode === "legacy_tick" && r.ok).length;
  const fvvoTickOk = results.filter((r) => r.mode === "fvvo_tick" && r.ok).length;
  const featureTickOk = results.filter(
    (r) => r.mode === "fvvo_feature_tick" && r.ok
  ).length;
  const feature5mOk = results.filter(
    (r) => r.mode === "fvvo_feature_5m" && r.ok
  ).length;

  return {
    anyOk,
    legacyOk,
    fvvoTickOk,
    featureTickOk,
    feature5mOk,
    ...targetCounts,
  };
}

function logForwardResults(results) {
  for (const r of results) {
    if (r.ok) {
      console.log(`✅ Forward OK [${r.mode}] -> ${r.url} | status=${r.status}`);
    } else if (r.skipped) {
      console.error(
        `❌ Forward SKIPPED [${r.mode}] -> ${r.url} | ${r.resp} | via=${r.source}`
      );
    } else {
      console.error(
        `❌ Forward FAIL [${r.mode}] -> ${r.url} | status=${r.status} | ${r.resp}`
      );
    }
  }
}

app.get("/", (_req, res) => {
  res.json({
    service: "tick-router",
    routerName: ROUTER_NAME,
    legacyBrains: BRAIN_URLS,
    fvvoBrains: FVVO_BRAIN_URLS,
    rawLegacyBrainsCount: RAW_BRAIN_URLS.length,
    rawFvvoBrainsCount: RAW_FVVO_BRAIN_URLS.length,
    hasInboundSecret: Boolean(WEBHOOK_SECRET),
    forwardTimeoutMs: FORWARD_TIMEOUT_MS,
    strictDestSecret: STRICT_DEST_SECRET,
    routeSrcFeaturesToFvvo: ROUTE_SRC_FEATURES_TO_FVVO,
    forwardFvvoFastTickToLegacy: FORWARD_FVVO_FAST_TICK_TO_LEGACY,
    forwardFvvoFeatureTickToLegacy: FORWARD_FVVO_FEATURE_TICK_TO_LEGACY,
    forwardFvvoFeatureTickAsFvvoFastTick: FORWARD_FVVO_FEATURE_TICK_AS_FVVO_FAST_TICK,
    supportedEvents: [
      "FAST_TICK / src=tick",
      "FAST_TICK_FVVO",
      "FEATURE_TICK_FVVO -> FVVO feature + optional legacy tick mirror",
      "FEATURE_5M_FVVO",
    ],
    hasBrainSecretMapJson: Boolean(Object.keys(BRAIN_SECRET_MAP || {}).length),
    hasFvvoSecretMapJson: Boolean(Object.keys(FVVO_SECRET_MAP || {}).length),
    perBrainSecrets: {
      hasDefault: Boolean(BRAIN_SECRET),
      hasAct: Boolean(process.env.BRAIN_SECRET_ACTLONG),
      hasDemoLong: Boolean(process.env.BRAIN_SECRET_DEMOLONG),
      hasDemoPhase5: Boolean(process.env.BRAIN_SECRET_DEMOPHASE5),
      hasBrainRayContinuation: Boolean(
        process.env.BRAIN_SECRET_BRAINRAYCONTINUATION
      ),
      hasLiveBrainRay: Boolean(process.env.BRAIN_SECRET_LIVE_BRAINRAY),
      hasPaperBrainRay: Boolean(process.env.BRAIN_SECRET_PAPER_BRAINRAY),
      hasFvvoDemo: Boolean(process.env.BRAIN_SECRET_FVVO_DEMO),
      hasFvvoLive: Boolean(process.env.BRAIN_SECRET_FVVO_LIVE),
      hasFvvoGeneric: Boolean(process.env.BRAIN_SECRET_FVVO),
    },
  });
});

app.post("/webhook", async (req, res) => {
  const inbound = req.body || {};
  const kind = getPayloadKind(inbound);

  if (!inboundSecretOk(inbound)) {
    return res.status(401).json({ ok: false, error: "secret_mismatch", kind });
  }

  if (!BRAIN_URLS.length && !FVVO_BRAIN_URLS.length) {
    return res.status(500).json({
      ok: false,
      error: "no_destinations_set",
      detail: "Set BRAIN_URLS and/or FVVO_BRAIN_URLS",
      kind,
    });
  }

  if (kind === "unknown") {
    console.log("ℹ️ Payload ignored: unsupported route", {
      src: inbound?.src,
      intent: inbound?.intent,
      event: inbound?.event,
      symbol: inbound?.symbol,
    });

    return res.status(200).json({
      ok: true,
      ignored: true,
      reason: "unsupported_payload_kind",
      kind,
    });
  }

  if (kind === "generic_tick" || kind === "fvvo_fast_tick") {
    const tick = normalizeTickPayload(inbound);

    if (!tick.ok) {
      console.error("❌ Invalid tick payload", {
        error: tick.error,
        src: inbound?.src,
        intent: inbound?.intent,
        event: inbound?.event,
        symbol: inbound?.symbol,
        price: inbound?.price,
        close: inbound?.close,
      });

      return res.status(400).json({ ok: false, error: tick.error, kind });
    }

    const mirrorFvvoFastTickToLegacy =
      kind === "generic_tick" ||
      (kind === "fvvo_fast_tick" && FORWARD_FVVO_FAST_TICK_TO_LEGACY);

    const legacyTargets = mirrorFvvoFastTickToLegacy ? BRAIN_URLS.length : 0;
    const fvvoTargets = FVVO_BRAIN_URLS.length;

    // Respond quickly to TradingView / tick source.
    res.status(200).json({
      ok: true,
      accepted: true,
      kind,
      symbol: tick.symbol,
      price: tick.price,
      legacyTargets,
      fvvoTargets,
    });

    console.log(
      `📍 ROUTER_IN kind=${kind} src=${tick.inboundSrc || "-"} ` +
        `intent=${tick.inboundIntent || "-"} event=${tick.inboundEvent || "-"} ` +
        `symbol=${tick.symbol} price=${tick.price} time=${tick.time}`
    );

    const jobs = [
      ...(mirrorFvvoFastTickToLegacy
        ? BRAIN_URLS.map((url) => forwardLegacyTick(url, tick))
        : []),
      ...FVVO_BRAIN_URLS.map((url) => forwardFvvoTick(url, tick)),
    ];

    const results = await Promise.all(jobs);
    logForwardResults(results);
    const summary = summarizeResults(results, {
      legacyTargets,
      fvvoTargets,
      featureTargets: 0,
    });

    console.log(
      `➡️ TickRouter forwarded kind=${kind} symbol=${tick.symbol} price=${tick.price} ` +
        `legacyOk=${summary.legacyOk}/${legacyTargets} ` +
        `fvvoTickOk=${summary.fvvoTickOk}/${fvvoTargets} anyOk=${summary.anyOk}`
    );

    return;
  }

  if (kind === "fvvo_feature_tick" || kind === "fvvo_feature_5m") {
    const feature = normalizeFeaturePayload(inbound, kind);

    if (!feature.ok) {
      console.error("❌ Invalid FVVO feature payload", {
        error: feature.error,
        src: inbound?.src,
        intent: inbound?.intent,
        event: inbound?.event,
        symbol: inbound?.symbol,
        price: inbound?.price,
        close: inbound?.close,
      });

      return res.status(400).json({ ok: false, error: feature.error, kind });
    }

    const mirrorFeatureTickToLegacy =
      kind === "fvvo_feature_tick" && FORWARD_FVVO_FEATURE_TICK_TO_LEGACY;

    const mirrorFeatureTickAsFvvoFastTick =
      kind === "fvvo_feature_tick" && FORWARD_FVVO_FEATURE_TICK_AS_FVVO_FAST_TICK;

    const legacyTargets = mirrorFeatureTickToLegacy ? BRAIN_URLS.length : 0;
    const fvvoFeatureTargets = FVVO_BRAIN_URLS.length;
    const fvvoFastTickTargets = mirrorFeatureTickAsFvvoFastTick
      ? FVVO_BRAIN_URLS.length
      : 0;

    // Respond quickly to TradingView. Forwarding continues async after the 200.
    res.status(200).json({
      ok: true,
      accepted: true,
      kind,
      symbol: feature.symbol,
      price: feature.price,
      legacyTargets,
      fvvoFeatureTargets,
      fvvoFastTickTargets,
      combinedAlertMode:
        kind === "fvvo_feature_tick" &&
        (mirrorFeatureTickToLegacy || mirrorFeatureTickAsFvvoFastTick),
    });

    console.log(
      `📍 ROUTER_IN kind=${kind} src=${feature.inboundSrc || "-"} ` +
        `intent=${feature.inboundIntent || "-"} event=${feature.inboundEvent || "-"} ` +
        `symbol=${feature.symbol} price=${feature.price} time=${feature.time}`
    );

    const jobs = [
      ...(mirrorFeatureTickToLegacy
        ? BRAIN_URLS.map((url) => forwardLegacyTick(url, feature))
        : []),
      ...FVVO_BRAIN_URLS.map((url) => forwardFvvoFeature(url, inbound, feature)),
      ...(mirrorFeatureTickAsFvvoFastTick
        ? FVVO_BRAIN_URLS.map((url) => forwardFvvoTick(url, feature))
        : []),
    ];

    const results = await Promise.all(jobs);
    logForwardResults(results);
    const summary = summarizeResults(results, {
      legacyTargets,
      fvvoTargets: fvvoFastTickTargets,
      featureTargets: fvvoFeatureTargets,
    });

    const okCount =
      kind === "fvvo_feature_tick" ? summary.featureTickOk : summary.feature5mOk;

    console.log(
      `➡️ TickRouter forwarded kind=${kind} symbol=${feature.symbol} price=${feature.price} ` +
        `legacyOk=${summary.legacyOk}/${legacyTargets} ` +
        `fvvoFeatureOk=${okCount}/${fvvoFeatureTargets} ` +
        `fvvoTickOk=${summary.fvvoTickOk}/${fvvoFastTickTargets} anyOk=${summary.anyOk}`
    );

    return;
  }
});

app.listen(PORT, () => {
  console.log(`✅ ${ROUTER_NAME} listening on port ${PORT}`);
  console.log(`Legacy brains: ${BRAIN_URLS.join(", ") || "(none)"}`);
  console.log(`FVVO brains: ${FVVO_BRAIN_URLS.join(", ") || "(none)"}`);
  console.log(`Inbound secret check: ${WEBHOOK_SECRET ? "ON" : "OFF"}`);
  console.log(`STRICT_DEST_SECRET=${STRICT_DEST_SECRET ? "true" : "false"}`);
  console.log(`ROUTE_SRC_FEATURES_TO_FVVO=${ROUTE_SRC_FEATURES_TO_FVVO ? "true" : "false"}`);
  console.log(
    `FORWARD_FVVO_FAST_TICK_TO_LEGACY=${FORWARD_FVVO_FAST_TICK_TO_LEGACY ? "true" : "false"}`
  );
  console.log(
    `FORWARD_FVVO_FEATURE_TICK_TO_LEGACY=${
      FORWARD_FVVO_FEATURE_TICK_TO_LEGACY ? "true" : "false"
    }`
  );
  console.log(
    `FORWARD_FVVO_FEATURE_TICK_AS_FVVO_FAST_TICK=${
      FORWARD_FVVO_FEATURE_TICK_AS_FVVO_FAST_TICK ? "true" : "false"
    }`
  );
  console.log(
    "Supported routes: FAST_TICK/src=tick, FAST_TICK_FVVO, FEATURE_TICK_FVVO(+legacy mirror), FEATURE_5M_FVVO"
  );
  console.log(
    `BrainSecretMapJSON=${Object.keys(BRAIN_SECRET_MAP || {}).length ? "ON" : "OFF"}`
  );
  console.log(
    `FvvoSecretMapJSON=${Object.keys(FVVO_SECRET_MAP || {}).length ? "ON" : "OFF"}`
  );
  console.log(
    `Per-brain secrets set: ACT=${process.env.BRAIN_SECRET_ACTLONG ? "YES" : "NO"}, ` +
      `DEMO_LONG=${process.env.BRAIN_SECRET_DEMOLONG ? "YES" : "NO"}, ` +
      `DEMO_PHASE5=${process.env.BRAIN_SECRET_DEMOPHASE5 ? "YES" : "NO"}, ` +
      `BRAINRAY_CONTINUATION=${
        process.env.BRAIN_SECRET_BRAINRAYCONTINUATION ? "YES" : "NO"
      }, ` +
      `LIVE_BRAINRAY=${process.env.BRAIN_SECRET_LIVE_BRAINRAY ? "YES" : "NO"}, ` +
      `PAPER_BRAINRAY=${process.env.BRAIN_SECRET_PAPER_BRAINRAY ? "YES" : "NO"}, ` +
      `FVVO_DEMO=${process.env.BRAIN_SECRET_FVVO_DEMO ? "YES" : "NO"}, ` +
      `FVVO_LIVE=${process.env.BRAIN_SECRET_FVVO_LIVE ? "YES" : "NO"}, ` +
      `FVVO_GENERIC=${process.env.BRAIN_SECRET_FVVO ? "YES" : "NO"}`
  );
});
