import fs from "fs";

const INPUT = process.argv[2] || "./logsanalyze.txt";
const OUTPUT = process.argv[3] || "./replay_today_2026_03_23.json";

const raw = fs.readFileSync(INPUT, "utf8");
const lines = raw.split(/\r?\n/);

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseKeyVals(part) {
  const out = {};
  const re = /([A-Za-z0-9_]+)=(-?\d+(?:\.\d+)?|[A-Za-z0-9:_\-.]+)/g;
  let m;
  while ((m = re.exec(part)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

const bars = [];
let pending = null;

for (const line of lines) {
  const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/);
  const logTs = tsMatch ? tsMatch[1] : null;

  if (line.includes("🧠 Brain Phase 5") && line.includes("| FEATURES |")) {
    const m =
      line.match(/symbol=([A-Z0-9:_-]+)\s+tf=([0-9A-Za-z]+)\s+price=([0-9.]+)\s+regime=([a-z_]+)\s+conf=([0-9.]+)\s+hostile=([01])/i);

    if (m) {
      pending = {
        src: "features",
        symbol: m[1],
        tf: String(m[2]),
        time: null,
        close: toNum(m[3]),
        regimeHint: m[4],
        regimeConfHint: toNum(m[5]),
        hostileHint: Number(m[6]) === 1,
        _logTs: logTs,
      };
    }
    continue;
  }

  if (pending && line.includes("📊 FEAT |")) {
    const kv = parseKeyVals(line);
    pending.close = toNum(kv.close) ?? pending.close;
    pending.ema8 = toNum(kv.ema8);
    pending.ema18 = toNum(kv.ema18);
    pending.ema50 = toNum(kv.ema50);
    pending.rsi = toNum(kv.rsi);
    pending.adx = toNum(kv.adx);
    pending.atrPct = toNum(kv.atrPct);
    pending.oiTrend = toNum(kv.oiTrend);
    pending.cvdTrend = toNum(kv.cvdTrend);
    continue;
  }

  if (pending && line.includes("📝 STATE SNAPSHOT ")) {
    const idx = line.indexOf("{");
    if (idx >= 0) {
      try {
        const snap = JSON.parse(line.slice(idx));
        pending.time = snap?.market?.time ?? pending.time;
        pending.open = snap?.features?.open ?? pending.open ?? pending.close;
        pending.high = snap?.features?.high ?? pending.high ?? pending.close;
        pending.low = snap?.features?.low ?? pending.low ?? pending.close;
        pending.atr = snap?.features?.atr ?? pending.atr ?? null;
        pending.priceDropPct = snap?.features?.priceDropPct ?? pending.priceDropPct ?? 0;
        pending.oiDeltaBias = snap?.features?.oiDeltaBias ?? pending.oiDeltaBias ?? 0;
        pending.liqClusterBelow = snap?.features?.liqClusterBelow ?? pending.liqClusterBelow ?? 0;
        pending.patternAReady = snap?.features?.patternAReady ?? pending.patternAReady ?? 0;
        pending.patternAWatch = snap?.features?.patternAWatch ?? pending.patternAWatch ?? 0;
      } catch {}
    }
  }

  if (pending && line.includes("📍 POSITION |")) {
    if (!pending.time) {
      pending.time = pending._logTs;
    }

    const event = {
      src: "features",
      symbol: pending.symbol,
      tf: pending.tf,
      time: pending.time,
      open: pending.open ?? pending.close,
      high: pending.high ?? pending.close,
      low: pending.low ?? pending.close,
      close: pending.close,
      ema8: pending.ema8 ?? pending.close,
      ema18: pending.ema18 ?? pending.close,
      ema50: pending.ema50 ?? pending.close,
      rsi: pending.rsi ?? 50,
      atr: pending.atr ?? null,
      atrPct: pending.atrPct ?? 0,
      adx: pending.adx ?? 0,
      oiTrend: pending.oiTrend ?? 0,
      oiDeltaBias: pending.oiDeltaBias ?? 0,
      cvdTrend: pending.cvdTrend ?? 0,
      liqClusterBelow: pending.liqClusterBelow ?? 0,
      priceDropPct: pending.priceDropPct ?? 0,
      patternAReady: pending.patternAReady ?? 0,
      patternAWatch: pending.patternAWatch ?? 0
    };

    bars.push(event);
    pending = null;
  }
}

fs.writeFileSync(OUTPUT, JSON.stringify(bars, null, 2));
console.log(`Wrote ${bars.length} replay bars to ${OUTPUT}`);
