import { CONFIG } from "./config.js";
import { log } from "./stateStore.js";
import { isoNow, symbolParts } from "./utils.js";
export async function forward3Commas(action, price, meta = {}, timestamp = isoNow()) {
  if (!CONFIG.ENABLE_HTTP_FORWARD) { log("🧪 SHADOW_ACTION", { action, price, meta }); return { ok: true, skipped: true, status: "shadow" }; }
  if (!CONFIG.C3_SIGNAL_URL || !CONFIG.C3_SIGNAL_SECRET || !CONFIG.C3_BOT_UUID) return { ok: false, skipped: true, status: "config_missing" };
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), CONFIG.C3_TIMEOUT_MS);
  try {
    const res = await fetch(CONFIG.C3_SIGNAL_URL, { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ secret: CONFIG.C3_SIGNAL_SECRET, max_lag: CONFIG.MAX_LAG_SEC, timestamp, trigger_price: String(price), ...symbolParts(CONFIG.SYMBOL), action, bot_uuid: CONFIG.C3_BOT_UUID }) });
    const body = await res.text().catch(() => ""); log(res.ok ? "✅ 3COMMAS_FORWARD_OK" : "❌ 3COMMAS_FORWARD_FAIL", { action, status: res.status, body: body.slice(0, 300), meta });
    return { ok: res.ok, status: res.status, body };
  } catch (e) { log("❌ 3COMMAS_FORWARD_ERROR", { action, error: String(e.message || e), meta }); return { ok: false, status: "error" }; }
  finally { clearTimeout(timer); }
}
