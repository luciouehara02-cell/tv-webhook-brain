#!/usr/bin/env node
/**
 * extract_replay_from_logs.js
 *
 * ESM version
 *
 * Usage:
 *   node extract_replay_from_logs.js input.log replay_20260328.json
 */

import fs from "fs";

const inputPath = process.argv[2];
const outputPath = process.argv[3] || "replay.json";

if (!inputPath) {
  console.error("Usage: node extract_replay_from_logs.js <input.log> <output.json>");
  process.exit(1);
}

const raw = fs.readFileSync(inputPath, "utf8");
const lines = raw.split(/\r?\n/);

const events = [];
let pendingFeature = null;

function safeNum(v) {
  if (v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function parseIsoPrefix(line) {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}T[^ ]+)/);
  return m ? m[1] : null;
}

function pushPendingFeature() {
  if (!pendingFeature) return;
  if (!pendingFeature.symbol) {
    pendingFeature = null;
    return;
  }

  events.push({
    type: "features",
    ts: pendingFeature.ts,
    body: {
      src: "features",
      symbol: pendingFeature.symbol,
      tf: pendingFeature.tf || "3",
      close: pendingFeature.close,
      ema8: pendingFeature.ema8,
      ema18: pendingFeature.ema18,
      ema50: pendingFeature.ema50,
      rsi: pendingFeature.rsi,
      adx: pendingFeature.adx,
      atr: pendingFeature.atr,
      atrPct: pendingFeature.atrPct,
      heartbeat: pendingFeature.heartbeat ?? 1,
      rayBuy: pendingFeature.rayBuy ?? 0,
      raySell: pendingFeature.raySell ?? 0,
      fwo: pendingFeature.fwo ?? 0,
      oiTrend: pendingFeature.oiTrend ?? 0,
      oiDeltaBias: pendingFeature.oiDeltaBias ?? 0,
      cvdTrend: pendingFeature.cvdTrend ?? 0,
      liqClusterBelow: pendingFeature.liqClusterBelow ?? 0,
      priceDropPct: pendingFeature.priceDropPct ?? 0,
      patternAReady: pendingFeature.patternAReady ?? 0,
      patternAWatch: pendingFeature.patternAWatch ?? 0,
      raySignal: pendingFeature.raySignal || "",
      fwoSignal: pendingFeature.fwoSignal || "",
    },
  });

  pendingFeature = null;
}

for (const line of lines) {
  const isoTs = parseIsoPrefix(line);

  const tickMatch = line.match(
    /TICK\(([^)]+)\)\s+([A-Z0-9:_-]+)\s+price=([0-9.]+)\s+time=([0-9T:.\-Z]+)/
  );
  if (tickMatch) {
    pushPendingFeature();

    const tfRaw = tickMatch[1];
    const symbol = tickMatch[2];
    const price = safeNum(tickMatch[3]);
    const tickTime = tickMatch[4];

    events.push({
      type: "tick",
      ts: tickTime || isoTs,
      body: {
        src: "tick",
        symbol,
        price,
        tf: String(tfRaw).replace("m", ""),
        time: tickTime || isoTs,
      },
    });
    continue;
  }

  const featMatch = line.match(
    /FEAT rx\s+([A-Z0-9:_-]+)\s+close=([^\s]+)\s+ema8=([^\s]+)\s+ema18=([^\s]+)\s+ema50=([^\s]+)\s+rsi=([^\s]+)\s+atr=([^\s]+)\s+atrPct=([^\s]+)\s+adx=([^\s]+)\s+oiTrend=([^\s]+)\s+oiDeltaBias=([^\s]+)\s+cvdTrend=([^\s]+)\s+liqClusterBelow=([^\s]+)\s+priceDropPct=([^\s]+)\s+patternAReady=([^\s]+)\s+patternAWatch=([^\s]+)/
  );

  if (featMatch) {
    pushPendingFeature();

    pendingFeature = {
      ts: isoTs,
      symbol: featMatch[1],
      tf: "3",
      close: safeNum(featMatch[2]),
      ema8: safeNum(featMatch[3]),
      ema18: safeNum(featMatch[4]),
      ema50: safeNum(featMatch[5]),
      rsi: safeNum(featMatch[6]),
      atr: safeNum(featMatch[7]),
      atrPct: safeNum(featMatch[8]),
      adx: safeNum(featMatch[9]),
      oiTrend: safeNum(featMatch[10]) ?? 0,
      oiDeltaBias: safeNum(featMatch[11]) ?? 0,
      cvdTrend: safeNum(featMatch[12]) ?? 0,
      liqClusterBelow: safeNum(featMatch[13]) ?? 0,
      priceDropPct: safeNum(featMatch[14]) ?? 0,
      patternAReady: safeNum(featMatch[15]) ?? 0,
      patternAWatch: safeNum(featMatch[16]) ?? 0,
      heartbeat: 1,
      rayBuy: 0,
      raySell: 0,
      fwo: 0,
      raySignal: "",
      fwoSignal: "",
    };
    continue;
  }

  if (pendingFeature && /ray/i.test(line) && /signal/i.test(line)) {
    if (/buy|bull/i.test(line)) pendingFeature.rayBuy = 1;
    if (/sell|bear/i.test(line)) pendingFeature.raySell = 1;
  }

  if (pendingFeature && /fwo/i.test(line) && /signal/i.test(line)) {
    if (/bull|up|cross/i.test(line)) pendingFeature.fwo = 1;
    if (/bear|down/i.test(line)) pendingFeature.fwo = -1;
  }
}

pushPendingFeature();

events.sort((a, b) => {
  const ta = new Date(a.ts).getTime();
  const tb = new Date(b.ts).getTime();
  return ta - tb;
});

fs.writeFileSync(outputPath, JSON.stringify(events, null, 2));
console.log(`✅ Wrote ${events.length} replay events -> ${outputPath}`);

const counts = events.reduce((acc, e) => {
  acc[e.type] = (acc[e.type] || 0) + 1;
  return acc;
}, {});
console.log("Counts:", counts);
