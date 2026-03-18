import fs from "fs";
import fetch from "node-fetch";

const BRAIN_URL = "https://braindemolong-production.up.railway.app/webhook";

const SECRET = "CHANGE_ME_TO_RANDOM_40+CHARS_9f8d7c6b5a4e3d2c1b0a";
const SYMBOL = "BINANCE:SOLUSDT";

// Load historical candles
const candles = JSON.parse(fs.readFileSync("sol_3m_sample.json", "utf8"));

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function sendFeatures(bar) {

  const payload = {
    secret: SECRET,
    src: "features",
    symbol: SYMBOL,
    tf: "3",

    close: bar.close,
    high: bar.high,
    low: bar.low,

    ema8: bar.ema8,
    ema18: bar.ema18,
    ema50: bar.ema50,

    rsi: bar.rsi,
    atr: bar.atr,
    atrPct: bar.atrPct,
    adx: bar.adx,

    ray_buy: 0,
    ray_sell: 0
  };

  await fetch(BRAIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function sendTick(price) {

  const payload = {
    secret: SECRET,
    src: "tick",
    symbol: SYMBOL,
    price: price
  };

  await fetch(BRAIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

async function runReplay() {

  for (const bar of candles) {

    console.log("▶ replay bar", bar.close);

    await sendFeatures(bar);

    // simulate tick movement inside the bar
    await sendTick(bar.low);
    await sleep(200);

    await sendTick(bar.close);
    await sleep(200);

    await sendTick(bar.high);
    await sleep(200);
  }

  console.log("Replay finished");
}

runReplay();
