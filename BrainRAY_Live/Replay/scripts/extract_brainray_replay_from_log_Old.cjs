#!/usr/bin/env node
const fs = require("fs");

function usage() {
  console.error("Usage: node extract_brainray_replay_from_log.cjs <input.log> <output.json> <secret> [symbol] [tf] [start_time] [end_time]");
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
  console.error("Invalid start_time: " + startTimeRaw);
  process.exit(1);
}
if (endTimeRaw && endMs == null) {
  console.error("Invalid end_time: " + endTimeRaw);
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
  } catch (e) {
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

  if (line.includes("FEATURE_5M") && payload) {
    pushEvent({
      secret: secret,
      src: "features",
      symbol: symbol,
      tf: tf,
      time: time,
      close: payload.close != null ? payload.close : null,
      ema8: payload.ema8 != null ? payload.ema8 : null,
      ema18: payload.ema18 != null ? payload.ema18 : null,
      ema50: payload.ema50 != null ? payload.ema50 : null,
      rsi: payload.rsi != null ? payload.rsi : null,
      adx: payload.adx != null ? payload.adx : null,
      atrPct: payload.atrPct != null ? payload.atrPct : null
    });
    continue;
  }

  if (line.includes("RAY_BULLISH_TREND_CHANGE") && payload) {
    pushEvent({
      secret: secret,
      src: "ray",
      symbol: symbol,
      tf: tf,
      event: "Bullish Trend Change",
      price: payload.price != null ? payload.price : null,
      time: time
    });
    continue;
  }

  if (line.includes("RAY_BULLISH_TREND_CONTINUATION") && payload) {
    pushEvent({
      secret: secret,
      src: "ray",
      symbol: symbol,
      tf: tf,
      event: "Bullish Trend Continuation",
      price: payload.price != null ? payload.price : null,
      time: time
    });
    continue;
  }

  if (line.includes("RAY_BEARISH_TREND_CHANGE") && payload) {
    pushEvent({
      secret: secret,
      src: "ray",
      symbol: symbol,
      tf: tf,
      event: "Bearish Trend Change",
      price: payload.price != null ? payload.price : null,
      time: time
    });
    continue;
  }

  if (line.includes("RAY_BEARISH_TREND_CONTINUATION") && payload) {
    pushEvent({
      secret: secret,
      src: "ray",
      symbol: symbol,
      tf: tf,
      event: "Bearish Trend Continuation",
      price: payload.price != null ? payload.price : null,
      time: time
    });
    continue;
  }
}

events.sort(function(a, b) {
  const ta = toMs(a.time) || 0;
  const tb = toMs(b.time) || 0;
  return ta - tb;
});

fs.writeFileSync(output, JSON.stringify(events, null, 2));

console.log("Wrote " + events.length + " events to " + output);
console.log("Window start: " + (startTimeRaw || "(none)"));
console.log("Window end:   " + (endTimeRaw || "(none)"));
if (events.length > 0) {
  console.log("First event:  " + events[0].time + " " + events[0].src + " " + (events[0].event || ""));
  console.log("Last event:   " + events[events.length - 1].time + " " + events[events.length - 1].src + " " + (events[events.length - 1].event || ""));
}
