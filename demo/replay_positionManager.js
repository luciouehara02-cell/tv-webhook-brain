const WEBHOOK_URL = "https://demophase5-production.up.railway.app/webhook";
const SECRET = "Demo_brainPhase5_secret_3x9KpL8zQ2mN7wR4tY6uF1";

const payloads = [
  // 1) Breakout detect
  {
    secret: SECRET,
    src: "features",
    symbol: "BINANCE:SOLUSDT",
    tf: "3",
    time: "2026-03-21T01:30:00Z",
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

  // 2) Retest pending
  {
    secret: SECRET,
    src: "features",
    symbol: "BINANCE:SOLUSDT",
    tf: "3",
    time: "2026-03-21T01:33:00Z",
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

  // 3) Bounce confirmed -> expected early entry
  {
    secret: SECRET,
    src: "features",
    symbol: "BINANCE:SOLUSDT",
    tf: "3",
    time: "2026-03-21T01:36:00Z",
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

  // 4) Strong follow-through -> peak update, maybe BE arm
  {
    secret: SECRET,
    src: "features",
    symbol: "BINANCE:SOLUSDT",
    tf: "3",
    time: "2026-03-21T01:39:00Z",
    open: 95.16,
    high: 95.62,
    low: 95.12,
    close: 95.55,
    ema8: 95.08,
    ema18: 94.72,
    ema50: 93.98,
    rsi: 68.0,
    atr: 0.43,
    atrPct: 0.45,
    adx: 26.2,
    oiTrend: 1,
    oiDeltaBias: 1,
    cvdTrend: 1,
    liqClusterBelow: 0,
    priceDropPct: 0.10,
    patternAReady: 1,
    patternAWatch: 1,
  },

  // 5) More upside -> BE / trail should activate
  {
    secret: SECRET,
    src: "features",
    symbol: "BINANCE:SOLUSDT",
    tf: "3",
    time: "2026-03-21T01:42:00Z",
    open: 95.55,
    high: 95.90,
    low: 95.48,
    close: 95.82,
    ema8: 95.24,
    ema18: 94.86,
    ema50: 94.05,
    rsi: 71.0,
    atr: 0.44,
    atrPct: 0.46,
    adx: 27.0,
    oiTrend: 1,
    oiDeltaBias: 1,
    cvdTrend: 1,
    liqClusterBelow: 0,
    priceDropPct: 0.18,
    patternAReady: 1,
    patternAWatch: 1,
  },

  // 6) New peak -> profit lock may activate
  {
    secret: SECRET,
    src: "features",
    symbol: "BINANCE:SOLUSDT",
    tf: "3",
    time: "2026-03-21T01:45:00Z",
    open: 95.82,
    high: 96.12,
    low: 95.76,
    close: 96.05,
    ema8: 95.44,
    ema18: 95.00,
    ema50: 94.14,
    rsi: 73.5,
    atr: 0.45,
    atrPct: 0.47,
    adx: 28.4,
    oiTrend: 1,
    oiDeltaBias: 1,
    cvdTrend: 1,
    liqClusterBelow: 0,
    priceDropPct: 0.22,
    patternAReady: 1,
    patternAWatch: 1,
  },

  // 7) Pullback, but still above stop -> no exit yet maybe
  {
    secret: SECRET,
    src: "features",
    symbol: "BINANCE:SOLUSDT",
    tf: "3",
    time: "2026-03-21T01:48:00Z",
    open: 96.05,
    high: 96.08,
    low: 95.70,
    close: 95.74,
    ema8: 95.50,
    ema18: 95.08,
    ema50: 94.20,
    rsi: 64.0,
    atr: 0.45,
    atrPct: 0.47,
    adx: 27.5,
    oiTrend: 0,
    oiDeltaBias: 0,
    cvdTrend: 0,
    liqClusterBelow: 0,
    priceDropPct: -0.12,
    patternAReady: 0,
    patternAWatch: 1,
  },

  // 8) Deeper pullback -> should hit stop / EMA18 exit
  {
    secret: SECRET,
    src: "features",
    symbol: "BINANCE:SOLUSDT",
    tf: "3",
    time: "2026-03-21T01:51:00Z",
    open: 95.74,
    high: 95.76,
    low: 95.02,
    close: 95.10,
    ema8: 95.38,
    ema18: 95.16,
    ema50: 94.28,
    rsi: 52.0,
    atr: 0.47,
    atrPct: 0.49,
    adx: 25.2,
    oiTrend: -1,
    oiDeltaBias: -1,
    cvdTrend: -1,
    liqClusterBelow: 1,
    priceDropPct: -0.55,
    patternAReady: 0,
    patternAWatch: 0,
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
  console.log("▶ Starting Position Manager v1 replay...");

  for (let i = 0; i < payloads.length; i += 1) {
    console.log(
      `\n📨 Sending step ${i + 1} | time=${payloads[i].time} | close=${payloads[i].close}`
    );
    await sendPayload(payloads[i], i);
    await sleep(1200);
  }

  console.log("\n✅ Position Manager replay complete.");
}

main().catch((err) => {
  console.error("❌ Replay failed:", err);
});
