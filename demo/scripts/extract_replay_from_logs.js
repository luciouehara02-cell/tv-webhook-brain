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

function extractJsonObject(line, marker) {
  const idx = line.indexOf(marker);
  if (idx < 0) return null;

  const start = line.indexOf("{", idx);
  if (start < 0) return null;

  try {
    return JSON.parse(line.slice(start));
  } catch {
    return null;
  }
}

function normalizeFeaturePayload(payload, fallbackTime = null) {
  if (!payload || payload.src !== "features") return null;

  return {
    src: "features",
    symbol: payload.symbol ?? null,
    tf: payload.tf != null ? String(payload.tf) : null,
    time: payload.time ?? fallbackTime,
    open: toNum(payload.open),
    high: toNum(payload.high),
    low: toNum(payload.low),
    close: toNum(payload.close),
    ema8: toNum(payload.ema8),
    ema18: toNum(payload.ema18),
    ema50: toNum(payload.ema50),
    rsi: toNum(payload.rsi),
    atr: toNum(payload.atr),
    atrPct: toNum(payload.atrPct),
    adx: toNum(payload.adx),
    oiTrend: toNum(payload.oiTrend) ?? 0,
    oiDeltaBias: toNum(payload.oiDeltaBias) ?? 0,
    cvdTrend: toNum(payload.cvdTrend) ?? 0,
    liqClusterBelow: toNum(payload.liqClusterBelow) ?? 0,
    priceDropPct: toNum(payload.priceDropPct) ?? 0,
    patternAReady: toNum(payload.patternAReady) ?? 0,
    patternAWatch: toNum(payload.patternAWatch) ?? 0,
  };
}

const bars = [];
const seenKeys = new Set();

let pending = null;

for (const line of lines) {
  const tsMatch = line.match(
    /^\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\]?/
  );
  const logTs = tsMatch ? tsMatch[1] : null;

  // ------------------------------------------------------------
  // Preferred path: direct payload log
  // ------------------------------------------------------------
  if (line.includes("📦 FEATURE PAYLOAD ")) {
    const payload = extractJsonObject(line, "📦 FEATURE PAYLOAD ");
    const event = normalizeFeaturePayload(payload, logTs);

    if (
      event &&
      event.symbol &&
      event.tf &&
      event.time &&
      event.close !== null
    ) {
      const dedupeKey = [
        event.symbol,
        event.tf,
        event.time,
        event.close,
      ].join("|");

      if (!seenKeys.has(dedupeKey)) {
        bars.push(event);
        seenKeys.add(dedupeKey);
      }
    }
    continue;
  }

  // ------------------------------------------------------------
  // Fallback path: older reduced log format
  // ------------------------------------------------------------
  if (line.includes("🧠 Brain Phase 5") && line.includes("| FEATURES |")) {
    const m = line.match(
      /symbol=([A-Z0-9:_-]+)\s+tf=([0-9A-Za-z]+)\s+price=([0-9.]+)\s+regime=([a-z_]+)\s+conf=([0-9.]+)\s+hostile=([01])/i
    );

    if (m) {
      pending = {
        src: "features",
        symbol: m[1],
        tf: String(m[2]),
        time: null,
        open: null,
        high: null,
        low: null,
        close: toNum(m[3]),
        ema8: null,
        ema18: null,
        ema50: null,
        rsi: null,
        atr: null,
        atrPct: null,
        adx: null,
        oiTrend: 0,
        oiDeltaBias: 0,
        cvdTrend: 0,
        liqClusterBelow: 0,
        priceDropPct: 0,
        patternAReady: 0,
        patternAWatch: 0,
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
    pending.oiTrend = toNum(kv.oiTrend) ?? pending.oiTrend;
    pending.cvdTrend = toNum(kv.cvdTrend) ?? pending.cvdTrend;
    continue;
  }

  if (pending && line.includes("📝 STATE SNAPSHOT ")) {
    const snap = extractJsonObject(line, "📝 STATE SNAPSHOT ");
    if (snap) {
      pending.time = snap?.market?.time ?? pending.time;
      pending.open = snap?.features?.open ?? pending.open;
      pending.high = snap?.features?.high ?? pending.high;
      pending.low = snap?.features?.low ?? pending.low;
      pending.atr = snap?.features?.atr ?? pending.atr;
      pending.priceDropPct =
        snap?.features?.priceDropPct ?? pending.priceDropPct;
      pending.oiDeltaBias =
        snap?.features?.oiDeltaBias ?? pending.oiDeltaBias;
      pending.liqClusterBelow =
        snap?.features?.liqClusterBelow ?? pending.liqClusterBelow;
      pending.patternAReady =
        snap?.features?.patternAReady ?? pending.patternAReady;
      pending.patternAWatch =
        snap?.features?.patternAWatch ?? pending.patternAWatch;
    }
    continue;
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
      patternAWatch: pending.patternAWatch ?? 0,
    };

    const dedupeKey = [
      event.symbol,
      event.tf,
      event.time,
      event.close,
    ].join("|");

    if (!seenKeys.has(dedupeKey)) {
      bars.push(event);
      seenKeys.add(dedupeKey);
    }

    pending = null;
  }
}

fs.writeFileSync(OUTPUT, JSON.stringify(bars, null, 2));
console.log(`Wrote ${bars.length} replay bars to ${OUTPUT}`);
