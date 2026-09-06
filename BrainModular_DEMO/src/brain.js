import { CONFIG } from "./config.js";
import { S, log } from "./stateStore.js";
import { keyOf, normalizePayload } from "./utils.js";
import { onFeature, onRay, onTick } from "./tradeEngine.js";
export async function handleWebhook(raw) {
  const p = normalizePayload(raw); S.counters.received++;
  const secretOk = p.secret === CONFIG.WEBHOOK_SECRET;
  const symbolOk = p.symbol === CONFIG.SYMBOL;
  if (!secretOk || !symbolOk) {
    S.counters.rejected++;
    log("⛔ WEBHOOK_REJECTED", {
      reason: !secretOk ? "secret_mismatch" : "symbol_mismatch",
      receivedSymbol: p.symbol,
      expectedSymbol: CONFIG.SYMBOL,
      receivedSecretSuffix: p.secret.slice(-6),
      expectedSecretSuffix: CONFIG.WEBHOOK_SECRET.slice(-6),
      src: p.src,
      event: p.event,
      tf: p.tf,
    });
    return { status: 403, body: { ok: false, error: !secretOk ? "secret_mismatch" : "symbol_mismatch" } };
  }
  const key = keyOf(p); if (S.dedup.includes(key)) { S.counters.duplicate++; return { status: 200, body: { ok: true, duplicate: true } }; }
  S.dedup.push(key); if (S.dedup.length > CONFIG.EVENT_DEDUP_LIMIT) S.dedup.shift();
  log("📩 WEBHOOK_ACCEPTED", { src: p.src, event: p.event, tf: p.tf, symbol: p.symbol, price: p.price, time: p.time });
  if (p.src.includes("tick") || p.event.includes("TICK")) await onTick(p);
  else if (p.src.includes("ray") || p.event.includes("TREND") || p.event.includes("BOS")) await onRay(p);
  else if (p.src.includes("feature") || p.event.includes("FEATURE")) await onFeature(p);
  else { log("⚪ UNKNOWN_EVENT", { src: p.src, event: p.event }); return { status: 422, body: { ok: false, error: "unknown_event" } }; }
  return { status: 200, body: { ok: true, phase: S.phase, inPosition: Boolean(S.position) } };
}
