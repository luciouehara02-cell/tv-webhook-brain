import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// comma-separated list of Brain webhook URLs
// example:
// BRAIN_URLS="https://brain-demolong.up.railway.app/webhook,https://brain-actlong.up.railway.app/webhook"
const BRAIN_URLS = String(process.env.BRAIN_URLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function checkSecret(payload) {
  if (!WEBHOOK_SECRET) return true;
  const s =
    payload?.secret ??
    payload?.tv_secret ??
    payload?.token ??
    payload?.passphrase ??
    "";
  return String(s) === String(WEBHOOK_SECRET);
}

async function forward(url, payload) {
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    return { url, ok: resp.ok, status: resp.status, resp: text || "" };
  } catch (e) {
    return { url, ok: false, status: 0, resp: String(e?.message || e) };
  }
}

app.get("/", (req, res) => {
  res.json({
    service: "tick-router",
    brains: BRAIN_URLS,
    hasSecret: Boolean(WEBHOOK_SECRET),
  });
});

app.post("/webhook", async (req, res) => {
  const payload = req.body || {};

  if (!checkSecret(payload)) {
    return res.status(401).json({ ok: false, error: "secret_mismatch" });
  }

  if (!BRAIN_URLS.length) {
    return res.status(500).json({ ok: false, error: "BRAIN_URLS_not_set" });
  }

  // forward to all brains in parallel
  const results = await Promise.all(BRAIN_URLS.map((u) => forward(u, payload)));

  // overall ok if at least one succeeded (or require all, your choice)
  const anyOk = results.some((r) => r.ok);
  res.json({ ok: anyOk, forwarded: results });
});

app.listen(PORT, () => {
  console.log(`✅ tick-router listening on port ${PORT}`);
  console.log(`Brains: ${BRAIN_URLS.join(", ") || "(none)"}`);
});
