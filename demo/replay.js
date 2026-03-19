const WEBHOOK_URL = "https://demophase5-production.up.railway.app/webhook";
const SECRET = "Demo_brainPhase5_secret_3x9KpL8zQ2mN7wR4tY6uF1";

const payloads = [
  {
    secret: SECRET,
    src: "features",
    symbol: "BINANCE:SOLUSDT",
    tf: "3",
    time: "2026-03-19T01:30:00Z",
    open: 94.70,
    high: 95.20,
    low: 94.82,
    close: 95.12,
    ema8: 94.90,
    ema18: 94.55,
    ema50: 93.80,
    rsi: 61.4,
    atr: 0.42,
    atrPct: 0.44,
    adx: 24.5,
    oiTrend: 1,
    oiDeltaBias: 1,
    cvdTrend: 1,
    liqClusterBelow: 1,
    priceDropPct: -0.15,
    patternAReady: 0,
    patternAWatch: 1,
  },
  {
    secret: SECRET,
    src: "features",
    symbol: "BINANCE:SOLUSDT",
    tf: "3",
    time: "2026-03-19T01:33:00Z",
    open: 95.10,
    high: 95.18,
    low: 94.91,
    close: 95.00,
    ema8: 94.92,
    ema18: 94.58,
    ema50: 93.84,
    rsi: 59.8,
    atr: 0.41,
    atrPct: 0.43,
    adx: 24.2,
    oiTrend: 1,
    oiDeltaBias: 1,
    cvdTrend: 1,
    liqClusterBelow: 1,
    priceDropPct: -0.10,
    patternAReady: 0,
    patternAWatch: 1,
  },
  {
    secret: SECRET,
    src: "features",
    symbol: "BINANCE:SOLUSDT",
    tf: "3",
    time: "2026-03-19T01:36:00Z",
    open: 95.00,
    high: 95.24,
    low: 94.97,
    close: 95.16,
    ema8: 94.96,
    ema18: 94.61,
    ema50: 93.88,
    rsi: 62.2,
    atr: 0.41,
    atrPct: 0.43,
    adx: 24.8,
    oiTrend: 1,
    oiDeltaBias: 1,
    cvdTrend: 1,
    liqClusterBelow: 1,
    priceDropPct: -0.05,
    patternAReady: 1,
    patternAWatch: 1,
  },
  {
    secret: SECRET,
    src: "features",
    symbol: "BINANCE:SOLUSDT",
    tf: "3",
    time: "2026-03-19T01:39:00Z",
    open: 95.16,
    high: 95.35,
    low: 95.10,
    close: 95.28,
    ema8: 95.01,
    ema18: 94.66,
    ema50: 93.93,
    rsi: 64.0,
    atr: 0.42,
    atrPct: 0.44,
    adx: 25.4,
    oiTrend: 1,
    oiDeltaBias: 1,
    cvdTrend: 1,
    liqClusterBelow: 1,
    priceDropPct: 0.02,
    patternAReady: 1,
    patternAWatch: 1,
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendPayload(payload, index) {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log(`STEP ${index + 1} | status=${res.status} | response=${text}`);
}

async function main() {
  console.log("▶ Starting Phase 5 replay test...");

  for (let i = 0; i < payloads.length; i += 1) {
    console.log(
      `\n📨 Sending step ${i + 1} | time=${payloads[i].time} | close=${payloads[i].close}`
    );
    await sendPayload(payloads[i], i);
    await sleep(1200);
  }

  console.log("\n✅ Replay sequence complete.");
}

main().catch((err) => {
  console.error("❌ Replay failed:", err);
});
