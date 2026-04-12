#!/usr/bin/env node

/**
 * replay_brainray_case.cjs
 *
 * Replays BrainRAY JSON event cases into a live BrainRAY webhook.
 *
 * Supports 2 timestamp modes:
 * 1) preserve  -> keep original event timestamps from the case file
 * 2) rewrite   -> rewrite timestamps to "now", while preserving spacing between events
 *
 * Default mode: preserve
 *
 * Usage:
 *   node replay_brainray_case.cjs <case.json> <webhook_url>
 *
 * Optional env:
 *   REPLAY_DELAY_MS=600
 *   REPLAY_TIMESTAMP_MODE=preserve
 *   REPLAY_MIN_GAP_MS=200
 *   REPLAY_MAX_GAP_MS=300000
 *
 * Examples:
 *   REPLAY_TIMESTAMP_MODE=preserve node replay_brainray_case.cjs cases/replay_today.json https://.../webhook
 *   REPLAY_TIMESTAMP_MODE=rewrite  node replay_brainray_case.cjs cases/replay_today.json https://.../webhook
 */

const fs = require("fs");

const input = process.argv[2];
const webhookUrl = process.argv[3];

if (!input || !webhookUrl) {
  console.error("Usage: node replay_brainray_case.cjs <case.json> <webhook_url>");
  process.exit(1);
}

const REPLAY_DELAY_MS = Number(process.env.REPLAY_DELAY_MS || 600);
const REPLAY_TIMESTAMP_MODE = String(process.env.REPLAY_TIMESTAMP_MODE || "preserve").toLowerCase();
const REPLAY_MIN_GAP_MS = Number(process.env.REPLAY_MIN_GAP_MS || 200);
const REPLAY_MAX_GAP_MS = Number(process.env.REPLAY_MAX_GAP_MS || 300000);

if (!["preserve", "rewrite"].includes(REPLAY_TIMESTAMP_MODE)) {
  console.error(`Invalid REPLAY_TIMESTAMP_MODE="${REPLAY_TIMESTAMP_MODE}". Use "preserve" or "rewrite".`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFiniteNumber(v) {
  return Number.isFinite(Number(v));
}

function parseIsoMs(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function eventLabel(evt) {
  return String(evt?.event || evt?.signal || evt?.action || "");
}

function eventSource(evt) {
  return String(evt?.src || "");
}

function eventTime(evt) {
  return String(evt?.time || evt?.timestamp || "");
}

function setEventTime(evt, iso) {
  if ("time" in evt || !("timestamp" in evt)) {
    evt.time = iso;
  }
  if ("timestamp" in evt) {
    evt.timestamp = iso;
  }
  return evt;
}

function rewriteEventTimes(events) {
  if (!Array.isArray(events) || events.length === 0) return [];

  const out = [];
  const baseNow = Date.now();

  let firstMs = null;
  let previousEffectiveMs = baseNow;

  for (let i = 0; i < events.length; i += 1) {
    const original = clone(events[i]);
    const currentMs = parseIsoMs(eventTime(original));

    let effectiveMs;

    if (i === 0) {
      effectiveMs = baseNow;
      if (currentMs != null) firstMs = currentMs;
    } else {
      if (currentMs != null && firstMs != null) {
        const prevOriginalMs = parseIsoMs(eventTime(events[i - 1]));
        if (prevOriginalMs != null) {
          let gap = currentMs - prevOriginalMs;

          if (!Number.isFinite(gap) || gap <= 0) {
            gap = REPLAY_DELAY_MS;
          }

          gap = Math.max(REPLAY_MIN_GAP_MS, Math.min(REPLAY_MAX_GAP_MS, gap));
          effectiveMs = previousEffectiveMs + gap;
        } else {
          effectiveMs = previousEffectiveMs + REPLAY_DELAY_MS;
        }
      } else {
        effectiveMs = previousEffectiveMs + REPLAY_DELAY_MS;
      }
    }

    previousEffectiveMs = effectiveMs;
    setEventTime(original, new Date(effectiveMs).toISOString());
    out.push(original);
  }

  return out;
}

function preserveEventTimes(events) {
  return events.map((e) => clone(e));
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text().catch(() => "");
  return {
    status: res.status,
    body: text,
  };
}

function computeInterEventDelay(prevEvt, nextEvt) {
  if (REPLAY_TIMESTAMP_MODE !== "preserve") {
    return REPLAY_DELAY_MS;
  }

  const prevMs = parseIsoMs(eventTime(prevEvt));
  const nextMs = parseIsoMs(eventTime(nextEvt));

  if (prevMs == null || nextMs == null) {
    return REPLAY_DELAY_MS;
  }

  let gap = nextMs - prevMs;
  if (!Number.isFinite(gap) || gap <= 0) {
    return REPLAY_DELAY_MS;
  }

  return Math.max(REPLAY_MIN_GAP_MS, Math.min(REPLAY_MAX_GAP_MS, gap));
}

async function main() {
  const raw = fs.readFileSync(input, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("Case JSON must be an array of events.");
  }

  const events =
    REPLAY_TIMESTAMP_MODE === "rewrite"
      ? rewriteEventTimes(parsed)
      : preserveEventTimes(parsed);

  console.log(`Loaded ${events.length} events from ${input}`);
  console.log(`Posting to ${webhookUrl}`);
  console.log(`Delay between events: ${REPLAY_DELAY_MS} ms`);
  console.log(
    `Timestamp mode: ${
      REPLAY_TIMESTAMP_MODE === "preserve"
        ? "preserve original time"
        : "rewrite to now preserving spacing"
    }`
  );

  for (let i = 0; i < events.length; i += 1) {
    const evt = events[i];
    const src = eventSource(evt);
    const ev = eventLabel(evt);
    const ts = eventTime(evt);

    console.log(`\n[${i + 1}/${events.length}] -> src=${src} event=${ev} time=${ts}`);

    try {
      const resp = await postJson(webhookUrl, evt);
      console.log(`status=${resp.status} body=${resp.body}`);
    } catch (err) {
      console.log(`status=ERR body=${String(err?.message || err)}`);
    }

    if (i < events.length - 1) {
      const delayMs = computeInterEventDelay(events[i], events[i + 1]);
      await sleep(delayMs);
    }
  }

  console.log("\nReplay finished.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
