#!/usr/bin/env node
const fs = require("fs");

function usage() {
  console.error(
    "Usage: node extract_brainray_replay_from_log.cjs <input.log> <output.json> <secret> [symbol] [tf] [start_time] [end_time]"
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

function toIso(ms) {
  return new Date(ms).toISOString();
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

const allEvents = [];

// ------------------------
// thinning config
// ------------------------
const TICK_KEEP_BEFORE_MS = 2 * 60 * 1000;  // 3 min before event
const TICK_KEEP_AFTER_MS = 4 * 60 * 1000;   // 6 min after event
const TICK_MIN_GAP_MS = 45 * 1000;          // keep max 1 tick every 30 sec

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

function extractIsoList(line) {
  return line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g) || [];
}

function normalizeIso(iso) {
  const t = toMs(iso);
  if (t == null) return null;
  return new Date(t).toISOString();
}

function extractEventTime(line, payload) {
  const candidates = [];

  if (payload && typeof payload.time === "string") candidates.push(payload.time);
  if (payload && typeof payload.ts === "string") candidates.push(payload.ts);
  if (payload && typeof payload.timestamp === "string") candidates.push(payload.timestamp);

  for (const c of candidates) {
    const norm = normalizeIso(c);
    if (norm) return norm;
  }

  const matches = extractIsoList(line);
  if (!matches.length) return null;

  const norm = normalizeIso(matches[matches.length - 1]);
  return norm || null;
}

function withinWindow(iso) {
  const t = toMs(iso);
  if (t == null) return false;
  if (startMs != null && t < startMs) return false;
  if (endMs != null && t > endMs) return false;
  return true;
}

function cleanNum(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function pushEvent(evt) {
  if (!evt || !evt.time) return;
  evt.time = normalizeIso(evt.time);
  if (!evt.time) return;
  if (!withinWindow(evt.time)) return;
  allEvents.push(evt);
}

function extractTickFromTextLine(line) {
  const m = line.match(
    /📍\s*TICK\s+([A-Z0-9:_-]+)\s+price=([-+]?\d*\.?\d+)\s+time=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/
  );
  if (!m) return null;

  return {
    secret,
    src: "tick",
    symbol: m[1],
    price: cleanNum(m[2]),
    time: m[3],
  };
}

function extractFvvoFromLine(line, payload, eventName) {
  const time = extractEventTime(line, payload);
  if (!time) return null;
  return {
    secret,
    src: "fvvo",
    symbol,
    tf,
    event: eventName,
    price: payload && payload.price != null ? cleanNum(payload.price) : null,
    time,
  };
}

for (const line of lines) {
  if (!line.trim()) continue;

  const payload = parseJsonAfterPipe(line);
  const time = extractEventTime(line, payload);

  if (line.includes("📍 TICK ")) {
    const tickEvt = extractTickFromTextLine(line);
    if (tickEvt) pushEvent(tickEvt);
    continue;
  }

  if (line.includes("FEATURE_5M") && payload) {
    pushEvent({
      secret,
      src: "features",
      symbol,
      tf,
      time,
      open: payload.open != null ? cleanNum(payload.open) : null,
      high: payload.high != null ? cleanNum(payload.high) : null,
      low: payload.low != null ? cleanNum(payload.low) : null,
      close: payload.close != null ? cleanNum(payload.close) : null,
      ema8: payload.ema8 != null ? cleanNum(payload.ema8) : null,
      ema18: payload.ema18 != null ? cleanNum(payload.ema18) : null,
      ema50: payload.ema50 != null ? cleanNum(payload.ema50) : null,
      rsi: payload.rsi != null ? cleanNum(payload.rsi) : null,
      adx: payload.adx != null ? cleanNum(payload.adx) : null,
      atrPct: payload.atrPct != null ? cleanNum(payload.atrPct) : null,
    });
    continue;
  }

  if (line.includes("RAY_BULLISH_TREND_CHANGE") && payload) {
    pushEvent({
      secret,
      src: "ray",
      symbol,
      tf,
      event: "Bullish Trend Change",
      price: payload.price != null ? cleanNum(payload.price) : null,
      time,
    });
    continue;
  }

  if (line.includes("RAY_BULLISH_TREND_CONTINUATION") && payload) {
    pushEvent({
      secret,
      src: "ray",
      symbol,
      tf,
      event: "Bullish Trend Continuation",
      price: payload.price != null ? cleanNum(payload.price) : null,
      time,
    });
    continue;
  }

  if (line.includes("RAY_BULLISH_BOS") && payload) {
    pushEvent({
      secret,
      src: "ray",
      symbol,
      tf,
      event: "Bullish BOS",
      price: payload.price != null ? cleanNum(payload.price) : null,
      time,
    });
    continue;
  }

  if (line.includes("RAY_BEARISH_TREND_CHANGE") && payload) {
    pushEvent({
      secret,
      src: "ray",
      symbol,
      tf,
      event: "Bearish Trend Change",
      price: payload.price != null ? cleanNum(payload.price) : null,
      time,
    });
    continue;
  }

  if (line.includes("RAY_BEARISH_TREND_CONTINUATION") && payload) {
    pushEvent({
      secret,
      src: "ray",
      symbol,
      tf,
      event: "Bearish Trend Continuation",
      price: payload.price != null ? cleanNum(payload.price) : null,
      time,
    });
    continue;
  }

  if (line.includes("FVVO_SNIPER_BUY")) {
    const evt = extractFvvoFromLine(line, payload, "Sniper Buy Alert");
    if (evt) pushEvent(evt);
    continue;
  }

  if (line.includes("FVVO_SNIPER_SELL")) {
    const evt = extractFvvoFromLine(line, payload, "Sniper Sell Alert");
    if (evt) pushEvent(evt);
    continue;
  }

  if (line.includes("FVVO_BURST_BULLISH")) {
    const evt = extractFvvoFromLine(line, payload, "Burst Bullish Alert");
    if (evt) pushEvent(evt);
    continue;
  }

  if (line.includes("FVVO_BURST_BEARISH")) {
    const evt = extractFvvoFromLine(line, payload, "Burst Bearish Alert");
    if (evt) pushEvent(evt);
    continue;
  }
}

// sort all
allEvents.sort((a, b) => {
  const ta = toMs(a.time) || 0;
  const tb = toMs(b.time) || 0;
  if (ta !== tb) return ta - tb;
  const order = { tick: 1, features: 2, fvvo: 3, ray: 4 };
  return (order[a.src] || 99) - (order[b.src] || 99);
});

// exact dedupe
const deduped = [];
const seen = new Set();

for (const evt of allEvents) {
  const key = JSON.stringify(evt);
  if (seen.has(key)) continue;
  seen.add(key);
  deduped.push(evt);
}

// split
const nonTicks = deduped.filter((e) => e.src !== "tick");
const ticks = deduped.filter((e) => e.src === "tick");

// build keep windows around non-ticks
const windows = nonTicks.map((e) => {
  const t = toMs(e.time);
  return {
    start: t - TICK_KEEP_BEFORE_MS,
    end: t + TICK_KEEP_AFTER_MS,
  };
});

// merge overlapping windows
windows.sort((a, b) => a.start - b.start);
const mergedWindows = [];
for (const w of windows) {
  if (!mergedWindows.length) {
    mergedWindows.push({ ...w });
    continue;
  }
  const last = mergedWindows[mergedWindows.length - 1];
  if (w.start <= last.end) {
    last.end = Math.max(last.end, w.end);
  } else {
    mergedWindows.push({ ...w });
  }
}

function tickInAnyWindow(tickMs) {
  for (const w of mergedWindows) {
    if (tickMs >= w.start && tickMs <= w.end) return true;
    if (tickMs < w.start) return false;
  }
  return false;
}

// thin ticks
const keptTicks = [];
let lastKeptTickMs = null;

for (let i = 0; i < ticks.length; i++) {
  const evt = ticks[i];
  const t = toMs(evt.time);
  if (t == null) continue;
  if (!tickInAnyWindow(t)) continue;

  const prev = ticks[i - 1];
  const next = ticks[i + 1];
  const prevIn = prev ? tickInAnyWindow(toMs(prev.time)) : false;
  const nextIn = next ? tickInAnyWindow(toMs(next.time)) : false;

  const isBoundary = !prevIn || !nextIn;

  if (isBoundary) {
    keptTicks.push(evt);
    lastKeptTickMs = t;
    continue;
  }

  if (lastKeptTickMs == null || t - lastKeptTickMs >= TICK_MIN_GAP_MS) {
    keptTicks.push(evt);
    lastKeptTickMs = t;
  }
}

// ray conflict cleanup by same timestamp
const grouped = new Map();
for (const evt of [...keptTicks, ...nonTicks]) {
  const k = evt.time;
  if (!grouped.has(k)) grouped.set(k, []);
  grouped.get(k).push(evt);
}

function rayPriority(evt) {
  if (evt.src !== "ray") return 0;
  if (evt.event === "Bearish Trend Change") return 50;
  if (evt.event === "Bullish Trend Change") return 40;
  if (evt.event === "Bearish Trend Continuation") return 30;
  if (evt.event === "Bullish Trend Continuation") return 20;
  if (evt.event === "Bullish BOS") return 10;
  return 1;
}

const finalEvents = [];

for (const [, arr] of grouped.entries()) {
  const nonRay = arr.filter((x) => x.src !== "ray");
  const ray = arr.filter((x) => x.src === "ray");

  if (!ray.length) {
    finalEvents.push(...nonRay);
    continue;
  }

  const hasBull = ray.some(
    (x) => x.event === "Bullish Trend Change" || x.event === "Bullish Trend Continuation"
  );
  const hasBear = ray.some(
    (x) => x.event === "Bearish Trend Change" || x.event === "Bearish Trend Continuation"
  );

  let keptRay = ray;

  if (hasBull && hasBear) {
    const bearTc = ray.find((x) => x.event === "Bearish Trend Change");
    const bullTc = ray.find((x) => x.event === "Bullish Trend Change");

    if (bearTc) keptRay = [bearTc];
    else if (bullTc) keptRay = [bullTc];
    else keptRay = [ray.slice().sort((a, b) => rayPriority(b) - rayPriority(a))[0]];
  } else {
    keptRay = [ray.slice().sort((a, b) => rayPriority(b) - rayPriority(a))[0]];
  }

  finalEvents.push(...nonRay, ...keptRay);
}

finalEvents.sort((a, b) => {
  const ta = toMs(a.time) || 0;
  const tb = toMs(b.time) || 0;
  if (ta !== tb) return ta - tb;
  const order = { tick: 1, features: 2, fvvo: 3, ray: 4 };
  return (order[a.src] || 99) - (order[b.src] || 99);
});

fs.writeFileSync(output, JSON.stringify(finalEvents, null, 2));

const counts = finalEvents.reduce((acc, e) => {
  acc[e.src] = (acc[e.src] || 0) + 1;
  return acc;
}, {});

console.log("Wrote " + finalEvents.length + " events to " + output);
console.log("Window start: " + (startTimeRaw || "(none)"));
console.log("Window end:   " + (endTimeRaw || "(none)"));
console.log("Counts:       " + JSON.stringify(counts));
console.log("Tick thinning: before=" + ticks.length + " after=" + keptTicks.length);
console.log(
  "Tick config:   keep_before_ms=" +
    TICK_KEEP_BEFORE_MS +
    " keep_after_ms=" +
    TICK_KEEP_AFTER_MS +
    " min_gap_ms=" +
    TICK_MIN_GAP_MS
);

if (finalEvents.length > 0) {
  console.log(
    "First event:  " +
      finalEvents[0].time +
      " " +
      finalEvents[0].src +
      " " +
      (finalEvents[0].event || "")
  );
  console.log(
    "Last event:   " +
      finalEvents[finalEvents.length - 1].time +
      " " +
      finalEvents[finalEvents.length - 1].src +
      " " +
      (finalEvents[finalEvents.length - 1].event || "")
  );
}
