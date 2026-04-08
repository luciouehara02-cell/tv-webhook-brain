#!/usr/bin/env node

/**
 * extract_webhooks_from_log.cjs
 *
 * Reconstruct replayable webhook-style events from runtime brain logs.
 *
 * Supports Phase2 / READY-style log summaries such as:
 * - 📩 WEBHOOK src=features signal= symbol=BINANCE:SOLUSDT
 * - 🟩 FEAT rx BINANCE:SOLUSDT close=84.23 ema8=... ema18=... ema50=... rsi=...
 * - 🟦 TICK(3m) BINANCE:SOLUSDT price=84.55 time=2026-04-08T13:13:16.681Z
 *
 * Output format:
 *   <log_timestamp>\t<json_payload>
 *
 * Example:
 *   2026-04-08T13:15:13.175765806Z    {"src":"features","symbol":"BINANCE:SOLUSDT",...}
 *
 * This format is chosen so build_replay_from_log.cjs can still time-filter
 * using the leading timestamp while consuming the reconstructed payload JSON.
 */

const fs = require("fs");
const path = require("path");

function usage() {
  console.error(
    "Usage: node extract_webhooks_from_log.cjs <input.log> <output.log>"
  );
  process.exit(1);
}

if (process.argv.length < 4) usage();

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!fs.existsSync(inputPath)) {
  console.error(`Input file not found: ${inputPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(inputPath, "utf8");
const lines = raw.split(/\r?\n/);

function toNum(v) {
  if (v == null) return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
}

function parseKeyValues(s) {
  const out = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)=([^\s]+)/g;
  let m;
  while ((m = re.exec(s))) {
    out[m[1]] = m[2];
  }
  return out;
}

function parseLeadingTimestamp(line) {
  const m = line.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/
  );
  return m ? m[1] : null;
}

function buildFeatureEvent(logTs, line) {
  // Example:
  // 2026-04-08T13:15:13.175765806Z [inf]  🟩 FEAT rx BINANCE:SOLUSDT close=84.58 ema8=...
  const m = line.match(/🟩 FEAT rx\s+([A-Z0-9:_-]+)\s+(.+)$/);
  if (!m) return null;

  const symbol = m[1];
  const kv = parseKeyValues(m[2]);

  const evt = {
    src: "features",
    symbol,
    tf: "3",

    // Important: synthesize heartbeat so replay can pass fresh-heartbeat gates.
    heartbeat: 1,

    close: toNum(kv.close),
    ema8: toNum(kv.ema8),
    ema18: toNum(kv.ema18),
    ema50: toNum(kv.ema50),
    rsi: toNum(kv.rsi),
    atr: toNum(kv.atr),
    atrPct: toNum(kv.atrPct),
    adx: toNum(kv.adx),

    oiTrend: toNum(kv.oiTrend) ?? 0,
    oiDeltaBias: toNum(kv.oiDeltaBias) ?? 0,
    cvdTrend: toNum(kv.cvdTrend) ?? 0,
    liqClusterBelow: toNum(kv.liqClusterBelow) ?? 0,
    priceDropPct: toNum(kv.priceDropPct) ?? 0,
    patternAReady: toNum(kv.patternAReady) ?? 0,
    patternAWatch: toNum(kv.patternAWatch) ?? 0,

    // Preserve event time for replay consumers that use body.time.
    time: logTs,
  };

  return evt;
}

function buildTickEvent(logTs, line) {
  // Example:
  // 2026-04-08T13:13:16.858762983Z [inf]  🟦 TICK(3m) BINANCE:SOLUSDT price=84.55 time=2026-04-08T13:13:16.681Z
  const m = line.match(
    /🟦 TICK\(3m\)\s+([A-Z0-9:_-]+)\s+price=([^\s]+)\s+time=([^\s]+)/
  );
  if (!m) return null;

  const symbol = m[1];
  const price = toNum(m[2]);
  const eventTime = m[3];

  if (!Number.isFinite(price)) return null;

  return {
    src: "tick",
    symbol,
    tf: "3",
    price,
    time: eventTime || logTs,
  };
}

function sanitizeEvent(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const outputLines = [];
let featureCount = 0;
let tickCount = 0;

for (const line of lines) {
  if (!line.trim()) continue;

  const logTs = parseLeadingTimestamp(line);
  if (!logTs) continue;

  if (line.includes("🟩 FEAT rx ")) {
    const evt = buildFeatureEvent(logTs, line);
    if (evt) {
      outputLines.push(`${logTs}\t${JSON.stringify(sanitizeEvent(evt))}`);
      featureCount += 1;
    }
    continue;
  }

  if (line.includes("🟦 TICK(3m) ")) {
    const evt = buildTickEvent(logTs, line);
    if (evt) {
      outputLines.push(`${logTs}\t${JSON.stringify(sanitizeEvent(evt))}`);
      tickCount += 1;
    }
    continue;
  }
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, outputLines.join("\n") + (outputLines.length ? "\n" : ""));

console.log(`Extracted ${outputLines.length} webhook events`);
console.log(`  features: ${featureCount}`);
console.log(`  ticks:    ${tickCount}`);
console.log(`Saved to ${outputPath}`);
