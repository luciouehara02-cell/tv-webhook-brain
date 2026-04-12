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

#!/usr/bin/env node

const fs = require("fs");

function usage() {
  console.error(
    "Usage: node extract_brainray_replay_from_log.cjs <input.log> <output.json> <secret> [symbol] [tf] [start_time] [end_time]"
  );
  console.error("");
  console.error("Example:");
  console.error(
    'node extract_brainray_replay_from_log.cjs data/BrainRAY_today.log cases/replay_1620.json BrainRAY_Secret_7r2blD9xK5nM6sT3aP8eG7 BINANCE:SOLUSDT 5 2026-04-11T15:00:00Z 2026-04-11T17:00:00Z'
  );
  process.exit(1);
}

const input = process.argv[2];
const output = process.argv[3];
const secret = process.argv[4];
const symbol = process.argv[5] || "BINANCE:SOLUSDT";
const tf = process.argv[6] || "5";
const startTimeRaw = process.argv[7] || "";
const endTimeRaw = process.argv[8] || "";

if (!input || !output || !secret) usage();

function toMs(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

const startMs = toMs(startTimeRaw);
const endMs = toMs(endTimeRaw);

if (startTimeRaw && startMs == null) {
  console.error(`Invalid start_time: ${startTimeRaw}`);
  process.exit(1);
}
if (endTimeRaw && endMs == null) {
  console.error(`Invalid end_time: ${endTimeRaw}`);
  process.exit(1);
}

const raw = fs.readFileSync(input, "utf8");
const lines = raw.split(/\r?\n/);
const events = [];

function parseJsonAfterPipe(line) {
  const idx = line.indexOf("|");
  if (idx === -1) return null;
  const jsonPart = line.slice(idx + 1).trim();
  try {
    return JSON.parse(jsonPart);
  } catch {
    return null;
  }
}

function extractEventTime(line, payload) {
  if (payload && typeof payload.ts === "string" && payload.ts.endsWith("Z")) {
    return payload.ts;
  }
  if (payload && typeof payload.time === "string" && payload.time.endsWith("Z")) {
    return payload.time;
  }

  const matches = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g);
  if (!matches || !matches.length) return null;

  // Prefer the second timestamp in Railway logs:
  // outer Railway timestamp + inner app timestamp
  return matches[matches.length - 1];
}

function withinWindow(iso) {
  const t = toMs(iso);
  if (t == null) return false;
  if (startMs != null && t < startMs) return false;
  if (endMs != null && t > endMs) return false;
  return true;
}

function pushEvent(evt) {
  if (!evt || !evt.time) return;
  if (!withinWindow(evt.time)) return;
  events.push(evt);
}

for (const line of lines) {
  if (!line.trim()) continue;

  const payload = parseJsonAfterPipe(line);
  const time = extractEventTime(line, payload);

  if (!time) continue;

  if (line.includes("📊 FEATURE_5M") && payload) {
    pushEvent({
      secret,
      src: "features",
      symbol,
      tf,
      time,
      close: payload.close ?? null,
      ema8: payload.ema8 ?? null,
      ema18: payload.ema18 ?? null,
      ema50: payload.ema50 ?? null,
      rsi: payload.rsi ?? null,
      adx: payload.adx ?? null,
      atrPct: payload.atrPct ?? null,
    });
    continue;
  }

  if (line.includes("🟢 RAY_BULLISH_TREND_CHANGE") && payload) {
    pushEvent({
      secret,
      src: "ray",
      symbol,
      tf,
      event: "Bullish Trend Change",
      price: payload.price ?? null,
      time,
    });
    continue;
  }

  if (line.includes("🟩 RAY_BULLISH_TREND_CONTINUATION") && payload) {
    pushEvent({
      secret,
      src: "ray",
      symbol,
      tf,
      event: "Bullish Trend Continuation",
      price: payload.price ?? null,
      time,
    });
    continue;
  }

  if (line.includes("🔴 RAY_BEARISH_TREND_CHANGE") && payload) {
    pushEvent({
      secret,
      src: "ray",
      symbol,
      tf,
      event: "Bearish Trend Change",
      price: payload.price ?? null,
      time,
    });
    continue;
  }

  if (line.includes("🟥 RAY_BEARISH_TREND_CONTINUATION") && payload) {
    pushEvent({
      secret,
      src: "ray",
      symbol,
      tf,
      event: "Bearish Trend Continuation",
      price: payload.price ?? null,
      time,
    });
    continue;
  }
}

events.sort((a, b) => {
  const ta = toMs(a.time) || 0;
  const tb = toMs(b.time) || 0;
  return ta - tb;
});

fs.writeFileSync(output, JSON.stringify(events, null, 2));

console.log(`Wrote ${events.length} events to ${output}`);
console.log(`Window start: ${startTimeRaw || "(none)"}`);
console.log(`Window end:   ${endTimeRaw || "(none)"}`);
if (events.length > 0) {
  console.log(`First event:  ${events[0].time} ${events[0].src} ${events[0].event || ""}`.trim());
  console.log(`Last event:   ${events[events.length - 1].time} ${events[events.length - 1].src} ${events[events.length - 1].event || ""}`.trim());
}
