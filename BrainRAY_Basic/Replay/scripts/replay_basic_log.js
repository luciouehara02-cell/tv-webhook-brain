/**
 * Replay BrainRAY_Basic horizontal Railway logs into local /webhook.
 *
 * Usage:
 * node Replay/replay_basic_log.js Replay/LogBasic0508A.log http://127.0.0.1:8080/webhook
 */

import fs from "fs";

const file = process.argv[2];
const url = process.argv[3] || "http://127.0.0.1:8080/webhook";

const SECRET =
  process.env.WEBHOOK_SECRET ||
  "CHANGE_ME_TO_RANDOM_40+CHARS_9f8d7c6b5a4e3d2c1b0a";

const SYMBOL = process.env.SYMBOL || "BINANCE:SOLUSDT";

if (!file) {
  console.error("Usage: node Replay/replay_basic_log.js <logfile> [webhook_url]");
  process.exit(1);
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractJsonFromLine(line) {
  const pipe = line.indexOf("|");
  if (pipe < 0) return null;

  const jsonStart = line.indexOf("{", pipe);
  if (jsonStart < 0) return null;

  const jsonText = line.slice(jsonStart).trim();
  return safeJsonParse(jsonText);
}

function mapRaySignal(tag) {
  if (tag.includes("RAY_BULLISH_TREND_CHANGE")) return "Bullish Trend Change";
  if (tag.includes("RAY_BULLISH_BOS")) return "Bullish BOS";
  if (tag.includes("RAY_BULLISH_TREND_CONTINUATION")) return "Bullish Trend Continuation";

  if (tag.includes("RAY_BEARISH_TREND_CHANGE")) return "Bearish Trend Change";
  if (tag.includes("RAY_BEARISH_BOS")) return "Bearish BOS";
  if (tag.includes("RAY_BEARISH_TREND_CONTINUATION")) return "Bearish Trend Continuation";

  return null;
}

function buildPayloadFromLogLine(line) {
  const data = extractJsonFromLine(line);
  if (!data) return null;

  if (line.includes("FEATURE_5M")) {
    return {
      secret: SECRET,
      src: "features",
      symbol: data.symbol || SYMBOL,
      tf: String(data.tf || "5"),
      time: data.ts || data.time || data.featureTime || new Date().toISOString(),
      close: data.close,

      macdLine: data.macdLine,
      macdSignal: data.macdSignal,
      macdHist: data.macdHist,
      macdCrossUpBelowZero: data.macdCrossUpBelowZero,

      ema11: data.ema11,
      ema33: data.ema33,
      rsi12: data.rsi12,
      adx14: data.adx14,
      mfi12: data.mfi12,
    };
  }

  const signal = mapRaySignal(line);
  if (signal) {
    return {
      secret: SECRET,
      src: "rayalgo",
      symbol: data.symbol || SYMBOL,
      signal,
      price: data.price,
      time: data.ts || data.time || new Date().toISOString(),
    };
  }

  return null;
}

async function post(payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return { status: res.status, ok: res.ok, body };
}

const raw = fs.readFileSync(file, "utf8");
const lines = raw.split(/\r?\n/);

const payloads = [];

for (const line of lines) {
  const payload = buildPayloadFromLogLine(line);
  if (payload) payloads.push(payload);
}

console.log(`Loaded ${payloads.length} replay payloads from ${file}`);
console.log(`Posting to ${url}`);

let i = 0;
for (const payload of payloads) {
  i += 1;

  const result = await post(payload);

  const label =
    payload.src === "features"
      ? `FEATURE close=${payload.close}`
      : `${payload.signal} price=${payload.price}`;

  const decision =
    result.body?.decision?.reason ||
    result.body?.pendingResult?.reason ||
    result.body?.reason ||
    "";

  const forwarded = result.body?.forwarded;

  console.log(
    `${String(i).padStart(4, "0")} ${label} | status=${result.status} forwarded=${forwarded} reason=${decision}`
  );
}
