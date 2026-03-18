import express from "express";
import { CONFIG } from "./config.js";
import { processEvent, getBrainState } from "./brain.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

function isAuthorized(payload) {
  if (!CONFIG.WEBHOOK_SECRET) return true;
  return payload?.secret === CONFIG.WEBHOOK_SECRET;
}

app.get("/", (_req, res) => {
  res.status(200).json({
    ok: true,
    brain: CONFIG.BRAIN_VERSION,
    symbol: CONFIG.SYMBOL,
    tf: CONFIG.TF,
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    state: getBrainState(),
  });
});

app.post("/webhook", (req, res) => {
  try {
    const payload = req.body;

    if (!isAuthorized(payload)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    processEvent(payload);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ webhook error", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "internal_error",
    });
  }
});

app.listen(CONFIG.PORT, () => {
  console.log(`🚀 ${CONFIG.BRAIN_VERSION} listening on port ${CONFIG.PORT}`);
});
