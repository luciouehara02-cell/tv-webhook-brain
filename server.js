import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const ROUTER_NAME = "TickRouter_v4.1_MANUAL_FVVO_DESTINATION";
const PORT = Number(process.env.PORT || 8080);

const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "");
const BRAIN_SECRET = String(process.env.BRAIN_SECRET || "");
const FORWARD_TIMEOUT_MS = Number(process.env.FORWARD_TIMEOUT_MS || 4000);

const STRICT_DEST_SECRET =
  String(process.env.STRICT_DEST_SECRET || "true").toLowerCase() === "true";

// New dedicated secret route for BrainFVVO_ManualExit.
// This must be the new manual brain's regular WEBHOOK_SECRET,
// never its MANUAL_WEBHOOK_SECRET.
const FVVO_MANUAL_ENTRY_HOST = String(
  process.env.FVVO_MANUAL_ENTRY_HOST ||
    "brainfvvomanualentry-production.up.railway.app"
)
  .trim()
  .toLowerCase();

const ROUTE_SRC_FEATURES_TO_FVVO =
  String(process.env.ROUTE_SRC_FEATURES_TO_FVVO || "false").toLowerCase() ===
  "true";

const FORWARD_FVVO_FAST_TICK_TO_LEGACY =
  String(
    process.env.FORWARD_FVVO_FAST_TICK_TO_LEGACY || "true"
  ).toLowerCase() === "true";

const FORWARD_FVVO_FEATURE_TICK_TO_LEGACY =
  String(
    process.env.FORWARD_FVVO_FEATURE_TICK_TO_LEGACY || "true"
  ).toLowerCase() === "true";

// Keep false for the manual two-level profile.
// FEATURE_TICK_FVVO must not count twice as a feature sample
// and as a separate FAST_TICK_FVVO confirmation.
const FORWARD_FVVO_FEATURE_TICK_AS_FVVO_FAST_TICK =
  String(
    process.env.FORWARD_FVVO_FEATURE_TICK_AS_FVVO_FAST_TICK || "false"
  ).toLowerCase() === "true";

function cleanEnvUrlPart(value) {
  return String(value || "")
    .trim()
    .replace(/^["']+/, "")
    .replace(/["']+$/, "")
    .trim();
}

function parseUrlList(value) {
  return String(value || "")
    .replace(/\r?\n/g, "")
    .split(",")
    .map(cleanEnvUrlPart)
    .filter(Boolean);
}

function parseJsonMap(envName) {
  try {
    const raw = String(process.env[envName] || "").trim();
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    console.error(
      `⚠️ Invalid ${envName} (must be valid JSON). Ignoring.`,
      error?.message || error
    );
    return {};
  }
}

const RAW_BRAIN_URLS = parseUrlList(process.env.BRAIN_URLS || "");
const RAW_FVVO_BRAIN_URLS = parseUrlList(
  process.env.FVVO_BRAIN_URLS || ""
);

// An FVVO URL wins if it accidentally appears in both lists.
const fvvoUrlSet = new Set(
  RAW_FVVO_BRAIN_URLS.map((url) => url.toLowerCase())
);

const BRAIN_URLS = RAW_BRAIN_URLS.filter(
  (url) => !fvvoUrlSet.has(url.toLowerCase())
);

const FVVO_BRAIN_URLS = RAW_FVVO_BRAIN_URLS;

const BRAIN_SECRET_MAP = parseJsonMap("BRAIN_SECRET_MAP_JSON");
const FVVO_SECRET_MAP = parseJsonMap("FVVO_SECRET_MAP_JSON");

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
  return !WEBHOOK_SECRET || extractSecret(payload) === WEBHOOK_SECRET;
}

function hostFromUrl(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

function secretFromEnv(name) {
  return String(process.env[name] || "");
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

  return (
    src === "fvvo_tick" ||
    intent === "fvvo_tick" ||
    event === "FAST_TICK_FVVO"
  );
}

function looksLikeGenericTick(inbound) {
  const src = lowerSrc(inbound);
  const intent = lowerIntent(inbound);
  const event = upperEvent(inbound);

  return (
    src === "tick" ||
    intent === "tick" ||
    event === "FAST_TICK"
  );
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

  return (
    src === "fvvo_feature_5m" ||
    intent === "fvvo_feature_5m" ||
    event === "FEATURE_5M_FVVO" ||
    (ROUTE_SRC_FEATURES_TO_FVVO && src === "features")
  );
}

function getPayloadKind(inbound) {
  if (looksLikeFeatureTickFvvo(inbound)) return "fvvo_feature_tick";
  if (looksLikeFeature5mFvvo(inbound)) return "fvvo_feature_5m";
  if (looksLikeFvvoTick(inbound)) return "fvvo_fast_tick";
  if (looksLikeGenericTick(inbound)) return "generic_tick";
  return "unknown";
}

function normalizeTimeValue(value) {
  const raw = String(value || "").trim();

  if (!raw) return new Date().toISOString();

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : raw;
}

function normalizeTickPayload(inbound) {
  const symbol = String(inbound?.symbol || inbound?.ticker || "").trim();

  const price = Number(
    inbound?.price ??
      inbound?.close ??
      inbound?.lastPrice ??
      inbound?.last ??
      inbound?.c
  );

  const time = normalizeTimeValue(
    inbound?.time ??
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
    symbol,
    price,
    time,
    inboundSrc: String(inbound?.src || ""),
    inboundIntent: String(inbound?.intent || ""),
    inboundEvent: String(inbound?.event || ""),
  };
}

function normalizeFeaturePayload(inbound, kind) {
  const tick = normalizeTickPayload({
    ...inbound,
    time:
      inbound?.time ??
      inbound?.bar_time ??
      inbound?.alert_time ??
      inbound?.timenow ??
      inbound?.timestamp ??
      inbound?.ts,
  });

  return tick.ok ? { ...tick, kind } : tick;
}

function legacySecretFor(url) {
  const host = hostFromUrl(url);
  const lowerUrl = String(url || "").toLowerCase();

  if (host && BRAIN_SECRET_MAP && typeof BRAIN_SECRET_MAP === "object") {
    const mapped = BRAIN_SECRET_MAP[host];

    if (mapped) {
      return {
        secret: String(mapped),
        source: `MAP_JSON:${host}`,
      };
    }
  }

  const knownTargets = [
    ["brainact-production", "BRAIN_SECRET_ACTLONG"],
    ["braindemolong-production", "BRAIN_SECRET_DEMOLONG"],
    ["satisfied-mercy-production", "BRAIN_SECRET_DEMOLONG"],
    ["demophase5-production", "BRAIN_SECRET_DEMOPHASE5"],
    [
      "brainraycontinuation-production",
      "BRAIN_SECRET_BRAINRAYCONTINUATION",
    ],
    [
      "brainraylivecontinuationjs-production",
      "BRAIN_SECRET_LIVE_BRAINRAY",
    ],
    [
      "brainraypapercontinuation-production",
      "BRAIN_SECRET_PAPER_BRAINRAY",
    ],
  ];

  for (const [match, envName] of knownTargets) {
    if (lowerUrl.includes(match)) {
      const secret = secretFromEnv(envName);

      return secret
        ? { secret, source: `ENV:${envName}` }
        : { secret: "", source: `MISSING_ENV:${envName}` };
    }
  }

  if (!STRICT_DEST_SECRET && BRAIN_SECRET) {
    return {
      secret: BRAIN_SECRET,
      source: "ENV:BRAIN_SECRET(default)",
    };
  }

  return {
    secret: "",
    source: STRICT_DEST_SECRET
      ? "STRICT_NO_FALLBACK"
      : "NO_SECRET_AVAILABLE",
  };
}

function fvvoSecretFor(url) {
  const host = hostFromUrl(url);
  const lowerUrl = String(url || "").toLowerCase();

  // Dedicated manual brain: explicit first match so a generic FVVO map
  // cannot accidentally route a different secret to this isolated service.
  if (host && host === FVVO_MANUAL_ENTRY_HOST) {
    const secret = secretFromEnv("BRAIN_SECRET_FVVO_MANUAL_ENTRY");

    return secret
      ? {
          secret,
          source: "ENV:BRAIN_SECRET_FVVO_MANUAL_ENTRY",
        }
      : {
          secret: "",
          source: "MISSING_ENV:BRAIN_SECRET_FVVO_MANUAL_ENTRY",
        };
  }

  if (host && FVVO_SECRET_MAP && typeof FVVO_SECRET_MAP === "object") {
    const mapped = FVVO_SECRET_MAP[host];

    if (mapped) {
      return {
        secret: String(mapped),
        source: `FVVO_MAP_JSON:${host}`,
      };
    }
  }

  if (host && BRAIN_SECRET_MAP && typeof BRAIN_SECRET_MAP === "object") {
    const mapped = BRAIN_SECRET_MAP[host];

    if (mapped) {
      return {
        secret: String(mapped),
        source: `MAP_JSON:${host}`,
      };
    }
  }

  if (lowerUrl.includes("live")) {
    const secret = secretFromEnv("BRAIN_SECRET_FVVO_LIVE");

    return secret
      ? {
          secret,
          source: "ENV:BRAIN_SECRET_FVVO_LIVE",
        }
      : {
          secret: "",
          source: "MISSING_ENV:BRAIN_SECRET_FVVO_LIVE",
        };
  }

  if (
    lowerUrl.includes("demo") ||
    lowerUrl.includes("paper") ||
    lowerUrl.includes("shadow") ||
    lowerUrl.includes("shadw")
  ) {
    const secret = secretFromEnv("BRAIN_SECRET_FVVO_DEMO");

    return secret
      ? {
          secret,
          source: "ENV:BRAIN_SECRET_FVVO_DEMO",
        }
      : {
          secret: "",
          source: "MISSING_ENV:BRAIN_SECRET_FVVO_DEMO",
        };
  }

  const genericFvvoSecret = secretFromEnv("BRAIN_SECRET_FVVO");

  if (genericFvvoSecret) {
    return {
      secret: genericFvvoSecret,
      source: "ENV:BRAIN_SECRET_FVVO",
    };
  }

  if (!STRICT_DEST_SECRET && BRAIN_SECRET) {
    return {
      secret: BRAIN_SECRET,
      source: "ENV:BRAIN_SECRET(default)",
    };
  }

  return {
    secret: "",
    source: STRICT_DEST_SECRET
      ? "STRICT_NO_FVVO_SECRET"
      : "NO_SECRET_AVAILABLE",
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
  const clean = { ...(payload || {}) };

  delete clean.secret;
  delete clean.tv_secret;
  delete clean.token;
  delete clean.passphrase;

  return clean;
}

function buildFvvoFeaturePayload(inbound, feature, secret) {
  const out = {
    ...scrubInboundSecret(inbound),
    secret,
    symbol: feature.symbol,
    price: feature.price,
  };

  if (!out.tf) {
    out.tf = String(inbound?.tf || process.env.ENTRY_TF || "5");
  }

  if (!out.time && feature.time) {
    out.time = feature.time;
  }

  if (feature.kind === "fvvo_feature_tick") {
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await response.text().catch(() => "");

    return {
      url,
      ok: response.ok,
      status: response.status,
      resp: (text || "").slice(0, 400),
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: 0,
      resp: `${error?.name || "Error"}: ${
        error?.message || String(error)
      }`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function invalidDestination(mode, urlRaw) {
  return {
    mode,
    url: urlRaw,
    ok: false,
    status: 0,
    resp: "invalid_destination_url",
  };
}

function missingSecretResult(mode, url, source, type) {
  return {
    mode,
    url,
    ok: false,
    status: 0,
    resp:
      type === "fvvo"
        ? "skipped_missing_fvvo_secret"
        : "skipped_missing_brain_secret",
    skipped: true,
    source,
  };
}

async function forwardLegacyTick(urlRaw, tick) {
  const url = cleanEnvUrlPart(urlRaw);

  if (!hostFromUrl(url)) {
    console.error(`❌ Invalid legacy destination URL -> ${urlRaw}`);
    return invalidDestination("legacy_tick", urlRaw);
  }

  const { secret, source } = legacySecretFor(url);

  if (!secret) {
    console.error(
      `⛔ LEGACY SKIP -> ${url} (missing destination brain secret) source=${source}`
    );

    return missingSecretResult("legacy_tick", url, source, "legacy");
  }

  console.log(
    `🔐 LEGACY_TICK -> ${url} host=${hostFromUrl(
      url
    )} secretSuffix=${String(secret).slice(-6)} ` +
      `symbol=${tick.symbol} price=${tick.price} via=${source}`
  );

  const result = await forwardToBrain(
    url,
    buildLegacyTickPayload(tick, secret),
    FORWARD_TIMEOUT_MS
  );

  return {
    ...result,
    mode: "legacy_tick",
    source,
  };
}

async function forwardFvvoTick(urlRaw, tick) {
  const url = cleanEnvUrlPart(urlRaw);

  if (!hostFromUrl(url)) {
    console.error(`❌ Invalid FVVO destination URL -> ${urlRaw}`);
    return invalidDestination("fvvo_tick", urlRaw);
  }

  const { secret, source } = fvvoSecretFor(url);

  if (!secret) {
    console.error(
      `⛔ FVVO SKIP -> ${url} (missing FVVO destination secret) source=${source}`
    );

    return missingSecretResult("fvvo_tick", url, source, "fvvo");
  }

  console.log(
    `🔐 FVVO_TICK -> ${url} host=${hostFromUrl(
      url
    )} secretSuffix=${String(secret).slice(-6)} ` +
      `event=FAST_TICK_FVVO symbol=${tick.symbol} price=${tick.price} via=${source}`
  );

  const result = await forwardToBrain(
    url,
    buildFvvoTickPayload(tick, secret),
    FORWARD_TIMEOUT_MS
  );

  return {
    ...result,
    mode: "fvvo_tick",
    source,
  };
}

async function forwardFvvoFeature(urlRaw, inbound, feature) {
  const url = cleanEnvUrlPart(urlRaw);

  if (!hostFromUrl(url)) {
    console.error(`❌ Invalid FVVO feature destination URL -> ${urlRaw}`);
    return invalidDestination(feature.kind, urlRaw);
  }

  const { secret, source } = fvvoSecretFor(url);

  if (!secret) {
    console.error(
      `⛔ FVVO FEATURE SKIP -> ${url} (missing FVVO destination secret) source=${source}`
    );

    return missingSecretResult(feature.kind, url, source, "fvvo");
  }

  const out = buildFvvoFeaturePayload(inbound, feature, secret);

  console.log(
    `🔐 FVVO_FEATURE -> ${url} host=${hostFromUrl(
      url
    )} secretSuffix=${String(secret).slice(-6)} ` +
      `event=${out.event} symbol=${feature.symbol} price=${feature.price} via=${source}`
  );

  const result = await forwardToBrain(url, out, FORWARD_TIMEOUT_MS);

  return {
    ...result,
    mode: feature.kind,
    source,
  };
}

function summarizeResults(results, targetCounts) {
  return {
    anyOk: results.some((result) => result.ok),

    legacyOk: results.filter(
      (result) => result.mode === "legacy_tick" && result.ok
    ).length,

    fvvoTickOk: results.filter(
      (result) => result.mode === "fvvo_tick" && result.ok
    ).length,

    featureTickOk: results.filter(
      (result) => result.mode === "fvvo_feature_tick" && result.ok
    ).length,

    feature5mOk: results.filter(
      (result) => result.mode === "fvvo_feature_5m" && result.ok
    ).length,

    ...targetCounts,
  };
}

function logForwardResults(results) {
  for (const result of results) {
    if (result.ok) {
      console.log(
        `✅ Forward OK [${result.mode}] -> ${result.url} | status=${result.status}`
      );
    } else if (result.skipped) {
      console.error(
        `❌ Forward SKIPPED [${result.mode}] -> ${result.url} | ${result.resp} | via=${result.source}`
      );
    } else {
      console.error(
        `❌ Forward FAIL [${result.mode}] -> ${result.url} | status=${result.status} | ${result.resp}`
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
    forwardFvvoFeatureTickToLegacy:
      FORWARD_FVVO_FEATURE_TICK_TO_LEGACY,

    forwardFvvoFeatureTickAsFvvoFastTick:
      FORWARD_FVVO_FEATURE_TICK_AS_FVVO_FAST_TICK,

    supportedEvents: [
      "FAST_TICK / src=tick",
      "FAST_TICK_FVVO",
      "FEATURE_TICK_FVVO -> FVVO feature + optional legacy tick mirror",
      "FEATURE_5M_FVVO",
    ],

    hasBrainSecretMapJson: Boolean(
      Object.keys(BRAIN_SECRET_MAP || {}).length
    ),

    hasFvvoSecretMapJson: Boolean(
      Object.keys(FVVO_SECRET_MAP || {}).length
    ),

    fvvoManualEntryHost: FVVO_MANUAL_ENTRY_HOST,

    perBrainSecrets: {
      hasDefault: Boolean(BRAIN_SECRET),
      hasAct: Boolean(process.env.BRAIN_SECRET_ACTLONG),
      hasDemoLong: Boolean(process.env.BRAIN_SECRET_DEMOLONG),
      hasDemoPhase5: Boolean(process.env.BRAIN_SECRET_DEMOPHASE5),

      hasBrainRayContinuation: Boolean(
        process.env.BRAIN_SECRET_BRAINRAYCONTINUATION
      ),

      hasLiveBrainRay: Boolean(
        process.env.BRAIN_SECRET_LIVE_BRAINRAY
      ),

      hasPaperBrainRay: Boolean(
        process.env.BRAIN_SECRET_PAPER_BRAINRAY
      ),

      hasFvvoDemo: Boolean(process.env.BRAIN_SECRET_FVVO_DEMO),
      hasFvvoLive: Boolean(process.env.BRAIN_SECRET_FVVO_LIVE),

      hasFvvoManualEntry: Boolean(
        process.env.BRAIN_SECRET_FVVO_MANUAL_ENTRY
      ),

      hasFvvoGeneric: Boolean(process.env.BRAIN_SECRET_FVVO),
    },
  });
});

app.post("/webhook", async (req, res) => {
  const inbound = req.body || {};
  const kind = getPayloadKind(inbound);

  if (!inboundSecretOk(inbound)) {
    return res.status(401).json({
      ok: false,
      error: "secret_mismatch",
      kind,
    });
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

      return res.status(400).json({
        ok: false,
        error: tick.error,
        kind,
      });
    }

    const mirrorFvvoFastTickToLegacy =
      kind === "generic_tick" ||
      (kind === "fvvo_fast_tick" &&
        FORWARD_FVVO_FAST_TICK_TO_LEGACY);

    const legacyTargets = mirrorFvvoFastTickToLegacy
      ? BRAIN_URLS.length
      : 0;

    const fvvoTargets = FVVO_BRAIN_URLS.length;

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
        `intent=${tick.inboundIntent || "-"} event=${
          tick.inboundEvent || "-"
        } ` +
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

      return res.status(400).json({
        ok: false,
        error: feature.error,
        kind,
      });
    }

    const mirrorFeatureTickToLegacy =
      kind === "fvvo_feature_tick" &&
      FORWARD_FVVO_FEATURE_TICK_TO_LEGACY;

    const mirrorFeatureTickAsFvvoFastTick =
      kind === "fvvo_feature_tick" &&
      FORWARD_FVVO_FEATURE_TICK_AS_FVVO_FAST_TICK;

    const legacyTargets = mirrorFeatureTickToLegacy
      ? BRAIN_URLS.length
      : 0;

    const fvvoFeatureTargets = FVVO_BRAIN_URLS.length;

    const fvvoFastTickTargets = mirrorFeatureTickAsFvvoFastTick
      ? FVVO_BRAIN_URLS.length
      : 0;

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
        (mirrorFeatureTickToLegacy ||
          mirrorFeatureTickAsFvvoFastTick),
    });

    console.log(
      `📍 ROUTER_IN kind=${kind} src=${feature.inboundSrc || "-"} ` +
        `intent=${feature.inboundIntent || "-"} event=${
          feature.inboundEvent || "-"
        } ` +
        `symbol=${feature.symbol} price=${feature.price} time=${feature.time}`
    );

    const jobs = [
      ...(mirrorFeatureTickToLegacy
        ? BRAIN_URLS.map((url) => forwardLegacyTick(url, feature))
        : []),

      ...FVVO_BRAIN_URLS.map((url) =>
        forwardFvvoFeature(url, inbound, feature)
      ),

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

    const featureOk =
      kind === "fvvo_feature_tick"
        ? summary.featureTickOk
        : summary.feature5mOk;

    console.log(
      `➡️ TickRouter forwarded kind=${kind} symbol=${feature.symbol} price=${feature.price} ` +
        `legacyOk=${summary.legacyOk}/${legacyTargets} ` +
        `fvvoFeatureOk=${featureOk}/${fvvoFeatureTargets} ` +
        `fvvoTickOk=${summary.fvvoTickOk}/${fvvoFastTickTargets} anyOk=${summary.anyOk}`
    );
  }
});

app.listen(PORT, () => {
  console.log(`✅ ${ROUTER_NAME} listening on port ${PORT}`);

  console.log(
    `Legacy brains: ${BRAIN_URLS.join(", ") || "(none)"}`
  );

  console.log(
    `FVVO brains: ${FVVO_BRAIN_URLS.join(", ") || "(none)"}`
  );

  console.log(
    `Inbound secret check: ${WEBHOOK_SECRET ? "ON" : "OFF"}`
  );

  console.log(
    `STRICT_DEST_SECRET=${STRICT_DEST_SECRET ? "true" : "false"}`
  );

  console.log(
    `ROUTE_SRC_FEATURES_TO_FVVO=${
      ROUTE_SRC_FEATURES_TO_FVVO ? "true" : "false"
    }`
  );

  console.log(
    `FORWARD_FVVO_FAST_TICK_TO_LEGACY=${
      FORWARD_FVVO_FAST_TICK_TO_LEGACY ? "true" : "false"
    }`
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
    `BrainSecretMapJSON=${
      Object.keys(BRAIN_SECRET_MAP || {}).length ? "ON" : "OFF"
    }`
  );

  console.log(
    `FvvoSecretMapJSON=${
      Object.keys(FVVO_SECRET_MAP || {}).length ? "ON" : "OFF"
    }`
  );

  console.log(
    `FVVO_MANUAL_ENTRY_HOST=${FVVO_MANUAL_ENTRY_HOST || "(not set)"}`
  );

  console.log(
    `Per-brain secrets set: ACT=${
      process.env.BRAIN_SECRET_ACTLONG ? "YES" : "NO"
    }, ` +
      `DEMO_LONG=${
        process.env.BRAIN_SECRET_DEMOLONG ? "YES" : "NO"
      }, ` +
      `DEMO_PHASE5=${
        process.env.BRAIN_SECRET_DEMOPHASE5 ? "YES" : "NO"
      }, ` +
      `BRAINRAY_CONTINUATION=${
        process.env.BRAIN_SECRET_BRAINRAYCONTINUATION ? "YES" : "NO"
      }, ` +
      `LIVE_BRAINRAY=${
        process.env.BRAIN_SECRET_LIVE_BRAINRAY ? "YES" : "NO"
      }, ` +
      `PAPER_BRAINRAY=${
        process.env.BRAIN_SECRET_PAPER_BRAINRAY ? "YES" : "NO"
      }, ` +
      `FVVO_DEMO=${
        process.env.BRAIN_SECRET_FVVO_DEMO ? "YES" : "NO"
      }, ` +
      `FVVO_LIVE=${
        process.env.BRAIN_SECRET_FVVO_LIVE ? "YES" : "NO"
      }, ` +
      `FVVO_MANUAL_ENTRY=${
        process.env.BRAIN_SECRET_FVVO_MANUAL_ENTRY ? "YES" : "NO"
      }, ` +
      `FVVO_GENERIC=${
        process.env.BRAIN_SECRET_FVVO ? "YES" : "NO"
      }`
  );
});
