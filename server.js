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
 * - outer quotes around whole BRAIN_URLS
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

const BRAIN_URLS = String(process.env.BRAIN_URLS || "")
  .replace(/\r?\n/g, "")
  .split(",")
  .map(cleanEnvUrlPart)
  .filter(Boolean);

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

function secretFor(url) {
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

  if (u.includes("braindemoshort-production")) {
    const s = secretFromEnv("BRAIN_SECRET_DEMOSHORT");
    if (s) return { secret: s, source: "ENV:BRAIN_SECRET_DEMOSHORT" };
    return { secret: "", source: "MISSING_ENV:BRAIN_SECRET_DEMOSHORT" };
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

app.get("/", (_req, res) => {
  res.json({
    service: "tick-router",
    brains: BRAIN_URLS,
    hasInboundSecret: Boolean(WEBHOOK_SECRET),
    forwardTimeoutMs: FORWARD_TIMEOUT_MS,
    strictDestSecret: STRICT_DEST_SECRET,
    hasSecretMapJson: Boolean(Object.keys(BRAIN_SECRET_MAP || {}).length),
    perBrainSecrets: {
      hasDefault: Boolean(BRAIN_SECRET),
      hasAct: Boolean(process.env.BRAIN_SECRET_ACTLONG),
      hasDemoLong: Boolean(process.env.BRAIN_SECRET_DEMOLONG),
      hasDemoShort: Boolean(process.env.BRAIN_SECRET_DEMOSHORT),
      hasDemoPhase5: Boolean(process.env.BRAIN_SECRET_DEMOPHASE5),
      hasBrainRayContinuation: Boolean(
        process.env.BRAIN_SECRET_BRAINRAYCONTINUATION
      ),
      hasLiveBrainRay: Boolean(process.env.BRAIN_SECRET_LIVE_BRAINRAY),
      hasPaperBrainRay: Boolean(process.env.BRAIN_SECRET_PAPER_BRAINRAY),
    },
  });
});

app.post("/webhook", async (req, res) => {
  const inbound = req.body || {};

  if (!inboundSecretOk(inbound)) {
    return res.status(401).json({ ok: false, error: "secret_mismatch" });
  }

  if (!BRAIN_URLS.length) {
    return res.status(500).json({ ok: false, error: "BRAIN_URLS_not_set" });
  }

  // Respond quickly to TradingView / tick source.
  res.status(200).json({ ok: true });

  const results = await Promise.all(
    BRAIN_URLS.map(async (uRaw) => {
      const u = cleanEnvUrlPart(uRaw);

      if (!hostFromUrl(u)) {
        console.error(`❌ Invalid destination URL -> ${uRaw}`);
        return {
          url: uRaw,
          ok: false,
          status: 0,
          resp: "invalid_destination_url",
        };
      }

      const out = { ...inbound };

      const { secret, source } = secretFor(u);
      if (!secret) {
        console.error(
          `⛔ SKIP -> ${u} (missing destination brain secret) source=${source}`
        );
        return {
          url: u,
          ok: false,
          status: 0,
          resp: "skipped_missing_brain_secret",
          skipped: true,
          source,
        };
      }

      out.secret = secret;

      const suffix = String(secret).slice(-6);
      console.log(
        `🔐 -> ${u} host=${hostFromUrl(u)} secretSuffix=${suffix} src=${String(
          inbound?.src || ""
        )} via=${source}`
      );

      return forwardToBrain(u, out, FORWARD_TIMEOUT_MS);
    })
  );

  const anyOk = results.some((r) => r.ok);

  for (const r of results) {
    if (r.ok) {
      console.log(`✅ Forward OK -> ${r.url} | status=${r.status}`);
    } else if (r.skipped) {
      console.error(
        `❌ Forward SKIPPED -> ${r.url} | ${r.resp} | via=${r.source}`
      );
    } else {
      console.error(
        `❌ Forward FAIL -> ${r.url} | status=${r.status} | ${r.resp}`
      );
    }
  }

  console.log(
    `➡️ TickRouter forwarded src=${String(inbound?.src || "")} symbol=${String(
      inbound?.symbol || ""
    )} anyOk=${anyOk}`
  );
});

app.listen(PORT, () => {
  console.log(`✅ tick-router listening on port ${PORT}`);
  console.log(`Brains: ${BRAIN_URLS.join(", ") || "(none)"}`);
  console.log(`Inbound secret check: ${WEBHOOK_SECRET ? "ON" : "OFF"}`);
  console.log(`STRICT_DEST_SECRET=${STRICT_DEST_SECRET ? "true" : "false"}`);
  console.log(
    `SecretMapJSON=${Object.keys(BRAIN_SECRET_MAP || {}).length ? "ON" : "OFF"}`
  );
  console.log(
    `Per-brain secrets set: ACT=${process.env.BRAIN_SECRET_ACTLONG ? "YES" : "NO"}, ` +
      `DEMO_LONG=${process.env.BRAIN_SECRET_DEMOLONG ? "YES" : "NO"}, ` +
      `DEMO_SHORT=${process.env.BRAIN_SECRET_DEMOSHORT ? "YES" : "NO"}, ` +
      `DEMO_PHASE5=${process.env.BRAIN_SECRET_DEMOPHASE5 ? "YES" : "NO"}, ` +
      `BRAINRAY_CONTINUATION=${
        process.env.BRAIN_SECRET_BRAINRAYCONTINUATION ? "YES" : "NO"
      }, ` +
      `LIVE_BRAINRAY=${process.env.BRAIN_SECRET_LIVE_BRAINRAY ? "YES" : "NO"}, ` +
      `PAPER_BRAINRAY=${process.env.BRAIN_SECRET_PAPER_BRAINRAY ? "YES" : "NO"}`
  );
});
