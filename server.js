/**
 * tick-router — fixed
 *
 * TradingView -> TickRouter:
 *   - validates WEBHOOK_SECRET (optional)
 *
 * TickRouter -> Brain(s):
 *   - rewrites payload.secret = BRAIN_SECRET (optional but recommended)
 *   - forwards to all BRAIN_URLS in parallel
 *
 * ENV:
 *   PORT=8080
 *   WEBHOOK_SECRET=TickRouter_...        (secret used by TradingView to call TickRouter) [optional]
 *   BRAIN_SECRET=ACT_...                 (secret Brain expects) [recommended]
 *   BRAIN_URLS="https://brain1.../webhook,https://brain2.../webhook"
 *   FORWARD_TIMEOUT_MS=4000              (optional)
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 8080);

// TradingView -> TickRouter secret (optional)
const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "");

// TickRouter -> Brain secret (recommended)
const BRAIN_SECRET = String(process.env.BRAIN_SECRET || "");

// Comma-separated list of Brain webhook URLs
const BRAIN_URLS = String(process.env.BRAIN_URLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const FORWARD_TIMEOUT_MS = Number(process.env.FORWARD_TIMEOUT_MS || 4000);

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
  // if WEBHOOK_SECRET is not set, accept all (not recommended for prod)
  if (!WEBHOOK_SECRET) return true;
  return extractSecret(payload) === WEBHOOK_SECRET;
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
      resp: text?.slice(0, 500) || "",
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
    hasBrainSecret: Boolean(BRAIN_SECRET),
    forwardTimeoutMs: FORWARD_TIMEOUT_MS,
  });
});

app.post("/webhook", async (req, res) => {
  const inbound = req.body || {};

  // 1) Validate inbound secret (TV -> TickRouter)
  if (!inboundSecretOk(inbound)) {
    return res.status(401).json({ ok: false, error: "secret_mismatch" });
  }

  if (!BRAIN_URLS.length) {
    return res.status(500).json({ ok: false, error: "BRAIN_URLS_not_set" });
  }

  // 2) ACK TradingView immediately (fast 200)
  res.status(200).json({ ok: true });

  // 3) Prepare outbound payload (TickRouter -> Brain)
  const outbound = { ...inbound };

  // Rewrite secret so Brain accepts it
  // If BRAIN_SECRET is empty, keep whatever came in (not recommended)
  if (BRAIN_SECRET) outbound.secret = BRAIN_SECRET;

  // 4) Forward async (do not block TradingView)
  const results = await Promise.all(
    BRAIN_URLS.map((u) => forwardToBrain(u, outbound, FORWARD_TIMEOUT_MS))
  );

  const anyOk = results.some((r) => r.ok);

  // Logs (very important)
  for (const r of results) {
    if (r.ok) {
      console.log(`✅ Forward OK -> ${r.url} | status=${r.status}`);
    } else {
      console.error(`❌ Forward FAIL -> ${r.url} | status=${r.status} | ${r.resp}`);
    }
  }

  // Optional: summary line
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
  console.log(`Brain secret rewrite: ${BRAIN_SECRET ? "ON" : "OFF"}`);
});
