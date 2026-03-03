/**
 * TickRouter — server.js (Complete) — FIXED
 *
 * Fixes:
 * ✅ NEVER falls back to TickRouter inbound WEBHOOK_SECRET by accident
 * ✅ Forces per-destination secret override (no “random secret after deploy”)
 * ✅ If a brain secret is missing, it SKIPS forwarding to that brain + logs why
 * ✅ Optional: BRAIN_SECRET_DEFAULT for “other brains” (safe), but not required
 *
 * ENV (Railway Variables):
 *   PORT=8080
 *   WEBHOOK_SECRET=TickRouter_xxx
 *   BRAIN_URLS="https://brainact.../webhook,https://satisfied-mercy.../webhook,https://braindemoshort.../webhook"
 *   FORWARD_TIMEOUT_MS=4000
 *
 *   # REQUIRED per-destination secrets (recommended)
 *   BRAIN_SECRET_ACTLONG=ACT_xxx
 *   BRAIN_SECRET_DEMOLONG=DEMO_LONG_xxx
 *   BRAIN_SECRET_DEMOSHORT=DEMO_SHORT_xxx
 *
 *   # OPTIONAL safe default for other brains you may add later
 *   BRAIN_SECRET_DEFAULT=some_other_brain_secret
 *
 * IMPORTANT:
 * - Do NOT set BRAIN_SECRET to WEBHOOK_SECRET.
 * - This version DOES NOT use BRAIN_SECRET at all, to prevent mistakes.
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 8080);

// TradingView -> TickRouter secret
const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "");

// Forwarding settings
const FORWARD_TIMEOUT_MS = Number(process.env.FORWARD_TIMEOUT_MS || 4000);

const BRAIN_URLS = String(process.env.BRAIN_URLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Optional safe default for unknown brains
const BRAIN_SECRET_DEFAULT = String(process.env.BRAIN_SECRET_DEFAULT || "");

// Per-brain secrets
const BRAIN_SECRET_ACTLONG = String(process.env.BRAIN_SECRET_ACTLONG || "");
const BRAIN_SECRET_DEMOLONG = String(process.env.BRAIN_SECRET_DEMOLONG || "");
const BRAIN_SECRET_DEMOSHORT = String(process.env.BRAIN_SECRET_DEMOSHORT || "");

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
  // If WEBHOOK_SECRET not set, accept all (not recommended for prod)
  if (!WEBHOOK_SECRET) return true;
  return extractSecret(payload) === WEBHOOK_SECRET;
}

/**
 * Decide which Brain secret to use based on destination URL.
 * IMPORTANT: no fallback to TickRouter inbound secret.
 */
function secretFor(url) {
  const u = String(url).toLowerCase();

  if (u.includes("brainact-production")) return BRAIN_SECRET_ACTLONG;
  if (u.includes("satisfied-mercy-production")) return BRAIN_SECRET_DEMOLONG;
  if (u.includes("braindemoshort-production")) return BRAIN_SECRET_DEMOSHORT;

  // fallback for any other brain you add (optional)
  return BRAIN_SECRET_DEFAULT;
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
    perBrainSecrets: {
      hasAct: Boolean(BRAIN_SECRET_ACTLONG),
      hasDemoLong: Boolean(BRAIN_SECRET_DEMOLONG),
      hasDemoShort: Boolean(BRAIN_SECRET_DEMOSHORT),
      hasDefault: Boolean(BRAIN_SECRET_DEFAULT),
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

  // 3) Forward async to all brains
  const results = await Promise.all(
    BRAIN_URLS.map(async (u) => {
      const s = secretFor(u);

      // If we don't have a destination secret, do NOT forward (prevents “wrong secret”)
      if (!s) {
        console.error(`⛔ SKIP -> ${u} (missing destination brain secret env var)`);
        return { url: u, ok: false, status: 0, resp: "skipped_missing_brain_secret" };
      }

      // Force destination secret override
      const out = { ...inbound, secret: s };

      // safe debug: suffix only (no full secret)
      const suffix = String(out.secret || "").slice(-6);
      console.log(`🔐 -> ${u} secretSuffix=${suffix} src=${String(inbound?.src || "")}`);

      return forwardToBrain(u, out, FORWARD_TIMEOUT_MS);
    })
  );

  const anyOk = results.some((r) => r.ok);

  // 4) Log results
  for (const r of results) {
    if (r.ok) {
      console.log(`✅ Forward OK -> ${r.url} | status=${r.status}`);
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

  console.log(
    `Per-brain secrets set: ACT=${BRAIN_SECRET_ACTLONG ? "YES" : "NO"}, ` +
      `DEMO_LONG=${BRAIN_SECRET_DEMOLONG ? "YES" : "NO"}, ` +
      `DEMO_SHORT=${BRAIN_SECRET_DEMOSHORT ? "YES" : "NO"}, ` +
      `DEFAULT=${BRAIN_SECRET_DEFAULT ? "YES" : "NO"}`
  );

  // Extra safety warning
  if (WEBHOOK_SECRET && (WEBHOOK_SECRET === BRAIN_SECRET_DEFAULT)) {
    console.log(
      "⚠️ WARNING: WEBHOOK_SECRET equals BRAIN_SECRET_DEFAULT. This is usually a misconfig."
    );
  }
});
