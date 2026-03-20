import { CONFIG } from "./config.js";

export async function sendSignalTo3Commas(signalPayload) {
  if (!CONFIG.LIVE_EXECUTION_ENABLED) {
    return {
      ok: false,
      skipped: true,
      reason: "live execution disabled",
    };
  }

  if (!CONFIG.C3_SIGNAL_SECRET || !CONFIG.C3_BOT_UUID) {
    return {
      ok: false,
      skipped: true,
      reason: "missing 3Commas credentials",
    };
  }

  const res = await fetch(CONFIG.C3_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(signalPayload),
  });

  const text = await res.text();

  return {
    ok: res.ok,
    status: res.status,
    responseText: text,
  };
}
