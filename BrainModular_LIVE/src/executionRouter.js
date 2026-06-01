/**
 * BrainRAY_Continuation_v6.7a_FIRST_ENTRY_QUALITY_FILTER
 * Source behavior: BrainRAY_Continuation_v5.1
 *
 * 3Commas / HTTP forwarding only.
 */

import { CONFIG } from "./config.js";
import { log } from "./stateStore.js";
import { isoNow, symbolParts } from "./utils.js";

const fetchFn = globalThis.fetch;

export function getBotUuid(symbol) {
  return CONFIG.SYMBOL_BOT_MAP[symbol] || "";
}

export async function forward3Commas(action, price, meta = {}, eventIso = isoNow()) {
  if (!CONFIG.ENABLE_HTTP_FORWARD) {
    log("🧪 FORWARD_SKIPPED_DISABLED", { action, price, meta });
    return { ok: true, skipped: true, status: "disabled" };
  }
  if (!fetchFn) {
    log("❌ FORWARD_SKIPPED_NO_FETCH", { action, price, meta });
    return { ok: false, skipped: true, status: "no_fetch", error: "fetch_not_available" };
  }
  const botUuid = getBotUuid(CONFIG.SYMBOL);
  if (!CONFIG.C3_SIGNAL_URL || !CONFIG.C3_SIGNAL_SECRET || !botUuid) {
    log("❌ FORWARD_CONFIG_MISSING", { hasUrl: Boolean(CONFIG.C3_SIGNAL_URL), hasSecret: Boolean(CONFIG.C3_SIGNAL_SECRET), hasBotUuid: Boolean(botUuid), action, price, meta });
    return { ok: false, skipped: true, status: "config_missing", error: "forward_config_missing" };
  }
  const { tv_exchange, tv_instrument } = symbolParts(CONFIG.SYMBOL);
  const payload = {
    secret: CONFIG.C3_SIGNAL_SECRET,
    max_lag: CONFIG.MAX_LAG_SEC,
    timestamp: eventIso,
    trigger_price: String(price),
    tv_exchange,
    tv_instrument,
    action,
    bot_uuid: botUuid,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.C3_TIMEOUT_MS);
  try {
    const res = await fetchFn(CONFIG.C3_SIGNAL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const txt = await res.text().catch(() => "");
    if (res.ok) {
      log("✅ 3COMMAS_FORWARD_OK", { action, status: res.status, price, meta });
      return { ok: true, status: res.status, body: txt };
    }
    log("❌ 3COMMAS_FORWARD_FAIL", { action, status: res.status, body: txt.slice(0, 300), price, meta });
    return { ok: false, status: res.status, body: txt };
  } catch (err) {
    log("❌ 3COMMAS_FORWARD_ERROR", { action, err: String(err?.message || err), price, meta });
    return { ok: false, status: "error", error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}
