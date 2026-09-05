export const n = (v, d = NaN) => Number.isFinite(Number(v)) ? Number(v) : d;
export const isoNow = () => new Date().toISOString();
export const pct = (a, b) => Number.isFinite(a) && a !== 0 ? ((b - a) / a) * 100 : 0;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const normalizeSymbol = (v) => String(v || "").trim().toUpperCase().includes(":") ? String(v).trim().toUpperCase() : `BINANCE:${String(v || "").trim().toUpperCase()}`;
export const symbolParts = (symbol) => { const [tv_exchange, tv_instrument] = normalizeSymbol(symbol).split(":"); return { tv_exchange, tv_instrument }; };
export const eventMs = (v) => { const x = new Date(v || "").getTime(); return Number.isFinite(x) ? x : Date.now(); };
export const ageSecAt = (then, now) => then ? Math.max(0, (eventMs(now) - eventMs(then)) / 1000) : Infinity;
export const keyOf = (p) => String(p.event_id || p.id || `${p.symbol}|${p.tf}|${p.event}|${p.time || p.timestamp}|${p.close || p.price}`);
export function normalizePayload(raw = {}) {
  const p = raw.body && typeof raw.body === "object" ? raw.body : raw;
  return {
    ...p,
    secret: String(p.secret || ""), symbol: normalizeSymbol(p.symbol),
    src: String(p.src || p.source || "").toLowerCase(), event: String(p.event || p.signal || "").toUpperCase(),
    tf: String(p.tf || p.timeframe || ""), time: p.time || p.timestamp || isoNow(),
    price: n(p.price ?? p.close), open: n(p.open), high: n(p.high), low: n(p.low), close: n(p.close ?? p.price),
    ema8: n(p.ema8), ema18: n(p.ema18), ema50: n(p.ema50), rsi: n(p.rsi), adx: n(p.adx), atr: n(p.atr),
    fvvo: n(p.fvvo), fvvoSlope: n(p.fvvoSlope ?? p.slope), confirmed: p.confirmed === undefined ? true : Boolean(p.confirmed)
  };
}
