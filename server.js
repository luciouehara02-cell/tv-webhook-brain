/**
 * TickRouter — server.js (Complete, hardened)
 *
 * TradingView -> TickRouter:
 *   - validate WEBHOOK_SECRET (optional but recommended)
 *
 * TickRouter -> Brain(s):
 *   - forward to BRAIN_URLS (comma-separated)
 *   - rewrite payload.secret per-destination using:
 *       BRAIN_SECRET_ACTLONG
 *       BRAIN_SECRET_DEMOLONG
 *       BRAIN_SECRET_DEMOSHORT
 *     fallback to BRAIN_SECRET (default) ONLY if you want (see STRICT_DEST_SECRET)
 *
 * OPTIONAL (recommended):
 *   BRAIN_SECRET_MAP_JSON='{"braindemolong-production.up.railway.app":"DEMO_SECRET","brainact-production.up.railway.app":"ACT_SECRET"}'
 *
 * ENV (Railway Variables):
 *   PORT=8080
 *   WEBHOOK_SECRET=TickRouter_xxx
 *   BRAIN_URLS="https://brainact.../webhook,https://braindemolong.../webhook,https://braindemoshort.../webhook"
 *   FORWARD_TIMEOUT_MS=4000
 *
 *   BRAIN_SECRET=...                         (optional default)
 *   BRAIN_SECRET_ACTLONG=...
 *   BRAIN_SECRET_DEMOLONG=...
 *   BRAIN_SECRET_DEMOSHORT=...
 *
 *   STRICT_DEST_SECRET=true                  (recommended)
 *   BRAIN_SECRET_MAP_JSON=...                (optional, strongest mapping)
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 8080);

const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "");
const BRAIN_SECRET = String(process.env.BRAIN_SECRET || "");
const FORWARD_TIMEOUT_MS = Number(process.env.FORWARD_TIMEOUT_MS || 4000);

// If true: DO NOT fallback to BRAIN_SECRET when a destination-specific secret is missing.
// This prevents “wrong secret forwarded” incidents.
const STRICT_DEST_SECRET = String(process.env.STRICT_DEST_SECRET || "true").toLowerCase() === "true";

const BRAIN_URLS = String(process.env.BRAIN_URLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Optional exact mapping: hostname -> secret
let BRAIN_SECRET_MAP = {};
try {
  const raw = String(process.env.BRAIN_SECRET_MAP_JSON || "").trim();
  if (raw) BRAIN_SECRET_MAP = JSON.parse(raw);
} catch (e) {
  console.error("⚠️ Invalid BRAIN_SECRET_MAP_JSON (must be valid JSON). Ignoring.", e?.message || e);
  BRAIN_SECRET_MAP = {};
}

function extractSecret(payload) {
  return String(payload?.secret ?? payload?.tv_secret ?? payload?.token ?? payload?.passphrase ?? "");
}

function inboundSecretOk(payload) {
  // If WEBHOOK_SECRET not set, accept all (not recommended)
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

/**
 * Decide which Brain secret to use based on destination URL.
 * Priority:
 *  1) BRAIN_SECRET_MAP_JSON hostname exact match
 *  2) known host patterns -> per-brain env vars
 *  3) optional default BRAIN_SECRET (if STRICT_DEST_SECRET=false)
 */
function secretFor(url) {
  const host = hostFromUrl(url);
  const u = String(url).toLowerCase();

  // 1) Exact mapping by hostname
  if (host && BRAIN_SECRET_MAP && typeof BRAIN_SECRET_MAP === "object") {
    const mapped = BRAIN_SECRET_MAP[host];
    if (mapped) {
      return { secret: String(mapped), source: `MAP_JSON:${host}` };
    }
  }

  // 2) Pattern mapping (your current domains)
  if (u.includes("brainact-production")) {
    const s = String(process.env.BRAIN_SECRET_ACTLONG || "");
    if (s) return { secret: s, source: "ENV:BRAIN_SECRET_ACTLONG" };
    return { secret: "", source: "MISSING_ENV:BRAIN_SECRET_ACTLONG" };
  }

  if (u.includes("braindemolong-production") || u.includes("satisfied-mercy-production")) {
    const s = String(process.env.BRAIN_SECRET_DEMOLONG || "");
    if (s) return { secret: s, source: "ENV:BRAIN_SECRET_DEMOLONG" };
    return { secret: "", source: "MISSING_ENV:BRAIN_SECRET_DEMOLONG" };
  }

  if (u.includes("braindemoshort-production")) {
    const s = String(process.env.BRAIN_SECRET_DEMOSHORT || "");
    if (s) return { secret: s, source: "ENV:BRAIN_SECRET_DEMOSHORT" };
    return { secret: "", source: "MISSING_ENV:BRAIN_SECRET_DEMOSHORT" };
  }

  // 3) Default fallback (only if allowed)
  if (!STRICT_DEST_SECRET) {
    if (BRAIN_SECRET) return { secret: BRAIN_SECRET, source: "ENV:BRAIN_SECRET(default)" };
  }

  return { secret: "", source: STRICT_DEST_SECRET ? "STRICT_NO_FALLBACK" : "NO_SECRET_AVAILABLE" };
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

app.get("/", (req, res) => {
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
    },
  });
});

app.post("/webhook", async (req, res) => {
  const inbound = req.body || {};

  // 1) Validate inbound secret (TradingView -> TickRouter)
  if (!inboundSecretOk(inbound)) {
    return res.status(401).json({ ok: false, error: "secret_mismatch" });
  }

  if (!BRAIN_URLS.length) {
    return res.status(500).json({ ok: false, error: "BRAIN_URLS_not_set" });
  }

  // 2) ACK TradingView immediately
  res.status(200).json({ ok: true });

  // 3) Forward async to all brains (with strict per-destination secret)
  const results = await Promise.all(
    BRAIN_URLS.map(async (u) => {
      const out = { ...inbound };

      const { secret, source } = secretFor(u);
      if (!secret) {
        console.error(`⛔ SKIP -> ${u} (missing destination brain secret) source=${source}`);
        return { url: u, ok: false, status: 0, resp: "skipped_missing_brain_secret", skipped: true, source };
      }

      out.secret = secret;

      const suffix = String(secret).slice(-6);
      console.log(`🔐 -> ${u} host=${hostFromUrl(u)} secretSuffix=${suffix} src=${String(inbound?.src || "")} via=${source}`);

      return forwardToBrain(u, out, FORWARD_TIMEOUT_MS);
    })
  );

  const anyOk = results.some((r) => r.ok);

  // 4) Log results
  for (const r of results) {
    if (r.ok) {
      console.log(`✅ Forward OK -> ${r.url} | status=${r.status}`);
    } else if (r.skipped) {
      console.error(`❌ Forward SKIPPED -> ${r.url} | ${r.resp} | via=${r.source}`);
    } else {
      console.error(`❌ Forward FAIL -> ${r.url} | status=${r.status} | ${r.resp}`);
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
  console.log(`SecretMapJSON=${Object.keys(BRAIN_SECRET_MAP || {}).length ? "ON" : "OFF"}`);
  console.log(
    `Per-brain secrets set: ACT=${process.env.BRAIN_SECRET_ACTLONG ? "YES" : "NO"}, ` +
      `DEMO_LONG=${process.env.BRAIN_SECRET_DEMOLONG ? "YES" : "NO"}, ` +
      `DEMO_SHORT=${process.env.BRAIN_SECRET_DEMOSHORT ? "YES" : "NO"}`
  );
});
