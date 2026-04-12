cat > /workspaces/tv-webhook-brain/BrainRAY/Replay/scripts/extract_brainray_replay_from_log.cjs <<'EOF'
const fs = require("fs");

function usage() {
  console.error(
    "Usage: node extract_brainray_replay_from_log.cjs <input.log> <output.json> <secret> [symbol] [tf]"
  );
  process.exit(1);
}

const input = process.argv[2];
const output = process.argv[3];
const secret = process.argv[4];
const symbol = process.argv[5] || "BINANCE:SOLUSDT";
const tf = process.argv[6] || "5";

if (!input || !output || !secret) usage();

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

function extractEventTime(line) {
  const m = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/g);
  if (!m || !m.length) return null;
  return m[m.length - 1];
}

for (const line of lines) {
  if (!line.trim()) continue;

  const time = extractEventTime(line);
  const payload = parseJsonAfterPipe(line);

  if (line.includes("📊 FEATURE_5M") && payload) {
    events.push({
      secret,
      src: "features",
      symbol,
      tf,
      time,
      open: payload.open ?? null,
      high: payload.high ?? null,
      low: payload.low ?? null,
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
    events.push({
      secret,
      src: "ray",
      symbol,
      tf,
      event: "Bullish Trend Change",
      price: payload.price ?? null,
      time: payload.ts || time,
    });
    continue;
  }

  if (line.includes("🟩 RAY_BULLISH_TREND_CONTINUATION") && payload) {
    events.push({
      secret,
      src: "ray",
      symbol,
      tf,
      event: "Bullish Trend Continuation",
      price: payload.price ?? null,
      time: payload.ts || time,
    });
    continue;
  }

  if (line.includes("🔴 RAY_BEARISH_TREND_CHANGE") && payload) {
    events.push({
      secret,
      src: "ray",
      symbol,
      tf,
      event: "Bearish Trend Change",
      price: payload.price ?? null,
      time: payload.ts || time,
    });
    continue;
  }

  if (line.includes("🟥 RAY_BEARISH_TREND_CONTINUATION") && payload) {
    events.push({
      secret,
      src: "ray",
      symbol,
      tf,
      event: "Bearish Trend Continuation",
      price: payload.price ?? null,
      time: payload.ts || time,
    });
    continue;
  }
}

fs.writeFileSync(output, JSON.stringify(events, null, 2));
console.log(`Wrote ${events.length} events to ${output}`);
EOF
