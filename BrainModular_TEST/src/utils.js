/**
 * BrainRAY_Continuation_v6.0_modular
 * Source behavior: BrainRAY_Continuation_v5.1
 *
 * Shared pure helpers only.
 */

export function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}
export function s(v, d = "") {
  return v == null ? d : String(v);
}
export function b(v, d = false) {
  if (v == null) return d;
  const x = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(x)) return true;
  if (["0", "false", "no", "off"].includes(x)) return false;
  return d;
}
export function nowMs() {
  return Date.now();
}
export function isoNow() {
  return new Date().toISOString();
}
export function round4(x) {
  const v = Number(x);
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null;
}
export function pctDiff(from, to) {
  const a = Number(from);
  const b2 = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b2) || a === 0) return 0;
  return ((b2 - a) / a) * 100;
}
export function normalizeSymbol(raw) {
  const v = String(raw || "").trim().toUpperCase();
  if (!v) return "";
  if (v.includes(":")) return v;
  return `BINANCE:${v}`;
}
export function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
export function parseTsMs(iso) {
  const t = new Date(iso || "").getTime();
  return Number.isFinite(t) ? t : null;
}
export function ageSec(iso) {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = parseTsMs(iso);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - t) / 1000);
}
export function symbolParts(symbol) {
  const sym = normalizeSymbol(symbol);
  const [tv_exchange, tv_instrument] = sym.includes(":")
    ? sym.split(":")
    : ["BINANCE", sym];
  return { tv_exchange, tv_instrument };
}
export function pickFirst(obj, keys, def = undefined) {
  for (const k of keys) {
    if (obj?.[k] !== undefined && obj?.[k] !== null && obj?.[k] !== "") return obj[k];
  }
  return def;
}
export function reasonPush(arr, cond, text) {
  if (cond) arr.push(text);
}
export function barTimeKey(iso, tfMin = 5) {
  const t = new Date(iso || Date.now());
  if (!Number.isFinite(t.getTime())) return "na";
  const bucketMs = Math.floor(t.getTime() / (tfMin * 60 * 1000)) * (tfMin * 60 * 1000);
  return new Date(bucketMs).toISOString();
}
export function maxFinite(...vals) {
  const good = vals.filter((v) => Number.isFinite(v));
  return good.length ? Math.max(...good) : NaN;
}
export function isLaunchMode(mode) {
  return [
    "bullish_trend_change_launch_long",
    "bullish_trend_change_launch_long_strong",
    "bullish_trend_change_launch_long_slow_ramp",
    "tick_confirmed_launch_long",
    "tick_confirmed_launch_long_strong",
    "first_bullish_trend_change_immediate_long",
    "first_bullish_trend_change_confirmed_long",
  ].includes(String(mode || ""));
}
export function isProtectedContinuationMode(mode) {
  return [
    "post_exit_continuation_reentry_long",
    "post_exit_continuation_reentry_long_strong",
  ].includes(String(mode || ""));
}
export function isReentryHarvestMode(mode) {
  return [
    "post_exit_continuation_reentry_long",
    "post_exit_continuation_reentry_long_strong",
    "feature_pullback_reclaim_reentry_long_strong",
    "feature_pullback_reclaim_reentry_long",
  ].includes(String(mode || ""));
}
export function isFirstEntryMode(mode) {
  return [
    "first_bullish_trend_change_immediate_long",
    "first_bullish_trend_change_confirmed_long",
  ].includes(String(mode || ""));
}
