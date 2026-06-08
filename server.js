import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 8080);

const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "");
const BRAIN_SECRET = String(process.env.BRAIN_SECRET || "");
const FORWARD_TIMEOUT_MS = Number(process.env.FORWARD_TIMEOUT_MS || 4000);

const STRICT_DEST_SECRET =
  String(process.env.STRICT_DEST_SECRET || "true").toLowerCase() === "true";

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
    .replace(/^['"]+/, "")
    .replace(/['"]+$/, "")
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
 * New FVVO fast-exit targets.
 * These receive FVVO tick format:
 * { secret, event:"FAST_TICK_FVVO", src:"fvvo_tick", intent:"fvvo_tick", symbol, price, time }
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

function looksLikeFvvoTick(inbound) {
  const src = String(inbound?.src || "").toLowerCase();
  const intent = String(inbound?.intent || "").toLowerCase();
  const event = String(inbound?.event || "").toUpperCase();

  return src === "fvvo_tick" || intent === "fvvo_tick" || event === "FAST_TICK_FVVO";
}

function looksLikeGenericTick(inbound) {
  const src = String(inbound?.src || "").toLowerCase();
  return src === "tick";
}

function looksLikeTick(inbound) {
  return looksLikeGenericTick(inbound) || looksLikeFvvoTick(inbound);
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
      mode: "legacy",
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
      mode: "legacy",
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
    `🔐 LEGACY -> ${url} host=${hostFromUrl(url)} secretSuffix=${suffix} ` +
      `symbol=${tick.symbol} price=${tick.price} via=${source}`
  );

  const r = await forwardToBrain(url, out, FORWARD_TIMEOUT_MS);
  return { ...r, mode: "legacy", source };
}

async function forwardFvvoTick(urlRaw, tick) {
  const url = cleanEnvUrlPart(urlRaw);

  if (!hostFromUrl(url)) {
    console.error(`❌ Invalid FVVO destination URL -> ${urlRaw}`);
    return {
      mode: "fvvo",
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
      mode: "fvvo",
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
    `🔐 FVVO -> ${url} host=${hostFromUrl(url)} secretSuffix=${suffix} ` +
      `event=FAST_TICK_FVVO symbol=${tick.symbol} price=${tick.price} via=${source}`
  );

  const r = await forwardToBrain(url, out, FORWARD_TIMEOUT_MS);
  return { ...r, mode: "fvvo", source };
}

app.get("/", (_req, res) => {
  res.json({
    service: "tick-router",
    legacyBrains: BRAIN_URLS,
    fvvoBrains: FVVO_BRAIN_URLS,
    rawLegacyBrainsCount: RAW_BRAIN_URLS.length,
    rawFvvoBrainsCount: RAW_FVVO_BRAIN_URLS.length,
    hasInboundSecret: Boolean(WEBHOOK_SECRET),
    forwardTimeoutMs: FORWARD_TIMEOUT_MS,
    strictDestSecret: STRICT_DEST_SECRET,
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

  if (!inboundSecretOk(inbound)) {
    return res.status(401).json({ ok: false, error: "secret_mismatch" });
  }

  if (!BRAIN_URLS.length && !FVVO_BRAIN_URLS.length) {
    return res.status(500).json({
      ok: false,
      error: "no_destinations_set",
      detail: "Set BRAIN_URLS and/or FVVO_BRAIN_URLS",
    });
  }

  if (!looksLikeTick(inbound)) {
    console.log("ℹ️ Non-tick payload ignored", {
      src: inbound?.src,
      intent: inbound?.intent,
      event: inbound?.event,
      symbol: inbound?.symbol,
    });

    return res.status(200).json({
      ok: true,
      ignored: true,
      reason: "non_tick_payload",
    });
  }

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

    return res.status(400).json({
      ok: false,
      error: tick.error,
    });
  }

  // Respond quickly to TradingView / tick source.
  res.status(200).json({
    ok: true,
    accepted: true,
    symbol: tick.symbol,
    price: tick.price,
    legacyTargets: BRAIN_URLS.length,
    fvvoTargets: FVVO_BRAIN_URLS.length,
  });

  console.log(
    `📍 TICK_IN src=${tick.inboundSrc || "-"} intent=${tick.inboundIntent || "-"} ` +
      `event=${tick.inboundEvent || "-"} symbol=${tick.symbol} price=${tick.price} time=${tick.time}`
  );

  const jobs = [
    ...BRAIN_URLS.map((url) => forwardLegacyTick(url, tick)),
    ...FVVO_BRAIN_URLS.map((url) => forwardFvvoTick(url, tick)),
  ];

  const results = await Promise.all(jobs);
  const anyOk = results.some((r) => r.ok);
  const legacyOk = results.filter((r) => r.mode === "legacy" && r.ok).length;
  const fvvoOk = results.filter((r) => r.mode === "fvvo" && r.ok).length;

  for (const r of results) {
    if (r.ok) {
      console.log(
        `✅ Forward OK [${r.mode}] -> ${r.url} | status=${r.status}`
      );
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

  console.log(
    `➡️ TickRouter forwarded symbol=${tick.symbol} price=${tick.price} ` +
      `legacyOk=${legacyOk}/${BRAIN_URLS.length} ` +
      `fvvoOk=${fvvoOk}/${FVVO_BRAIN_URLS.length} anyOk=${anyOk}`
  );
});

app.listen(PORT, () => {
  console.log(`✅ tick-router listening on port ${PORT}`);
  console.log(`Legacy brains: ${BRAIN_URLS.join(", ") || "(none)"}`);
  console.log(`FVVO brains: ${FVVO_BRAIN_URLS.join(", ") || "(none)"}`);
  console.log(`Inbound secret check: ${WEBHOOK_SECRET ? "ON" : "OFF"}`);
  console.log(`STRICT_DEST_SECRET=${STRICT_DEST_SECRET ? "true" : "false"}`);
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
