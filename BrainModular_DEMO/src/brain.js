import { CONFIG } from "./config.js";
import { S, log } from "./stateStore.js";
import { keyOf, normalizePayload } from "./utils.js";
import { onFeature, onRay, onTick } from "./tradeEngine.js";
export async function handleWebhook(raw) {
  const p = normalizePayload(raw); S.counters.received++;
  if (p.secret !== CONFIG.WEBHOOK_SECRET || p.symbol !== CONFIG.SYMBOL) { S.counters.rejected++; return { status: 403, body: { ok: false, error: "secret_or_symbol" } }; }
  const key = keyOf(p); if (S.dedup.includes(key)) { S.counters.duplicate++; return { status: 200, body: { ok: true, duplicate: true } }; }
  S.dedup.push(key); if (S.dedup.length > CONFIG.EVENT_DEDUP_LIMIT) S.dedup.shift();
  if (p.src.includes("tick") || p.event.includes("TICK")) await onTick(p);
  else if (p.src.includes("ray") || p.event.includes("TREND") || p.event.includes("BOS")) await onRay(p);
  else if (p.src.includes("feature") || p.event.includes("FEATURE")) await onFeature(p);
  else { log("⚪ UNKNOWN_EVENT", { src: p.src, event: p.event }); return { status: 422, body: { ok: false, error: "unknown_event" } }; }
  return { status: 200, body: { ok: true, phase: S.phase, inPosition: Boolean(S.position) } };
}
