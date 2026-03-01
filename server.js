/**
 * TickRouter — server.js (Complete)
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
 *     fallback to BRAIN_SECRET (default) if specific not set
 *
 * ENV (Railway Variables):
 *   PORT=8080
 *   WEBHOOK_SECRET=TickRouter_xxx                      (secret used by TradingView)
 *   BRAIN_URLS="https://brainact.../webhook,https://satisfied-mercy.../webhook,https://braindemoshort.../webhook"
 *   FORWARD_TIMEOUT_MS=4000
 *
 *   BRAIN_SECRET=ACT_xxx                               (default fallback)
 *   BRAIN_SECRET_ACTLONG=ACT_xxx
 *   BRAIN_SECRET_DEMOLONG=ACT_xxx or DEMO_LONG_xxx
 *   BRAIN_SECRET_DEMOSHORT=DEMO_SHORT_xxx
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 8080);
const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "");
const BRAIN_SECRET = String(process.env.BRAIN_SECRET || "");
const FORWARD_TIMEOUT_MS = Number(process.env.FORWARD_TIMEOUT_MS || 4000);

const BRAIN_URLS = String(process.env.BRAIN_URLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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
 * This matches your actual domains shown in Railway.
 */
function secretFor(url) {
  const u = String(url).toLowerCase();

  if (u.includes("brainact-production")) {
    return String(process.env.BRAIN_SECRET_ACTLONG || BRAIN_SECRET || "");
  }
  if (u.includes("satisfied-mercy-production")) {
    return String(process.env.BRAIN_SECRET_DEMOLONG || BRAIN_SECRET || "");
  }
  if (u.includes("braindemoshort-production")) {
    return String(process.env.BRAIN_SECRET_DEMOSHORT || BRAIN_SECRET || "");
  }

  // fallback for any other brain you add
  return String(BRAIN_SECRET || "");
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

  // 3) Forward async to all brains
  const results = await Promise.all(
    BRAIN_URLS.map((u) => {
      const out = { ...inbound };

      // rewrite secret for this destination
      const s = secretFor(u);
      if (s) out.secret = s;

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
  console.log(`Default brain secret set: ${BRAIN_SECRET ? "YES" : "NO"}`);
  console.log(
    `Per-brain secrets set: ACT=${process.env.BRAIN_SECRET_ACTLONG ? "YES" : "NO"}, ` +
      `DEMO_LONG=${process.env.BRAIN_SECRET_DEMOLONG ? "YES" : "NO"}, ` +
      `DEMO_SHORT=${process.env.BRAIN_SECRET_DEMOSHORT ? "YES" : "NO"}`
  );
});
