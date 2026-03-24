import { CONFIG } from "./config.js";

function createInitialState() {
  return {
    market: {
      symbol: CONFIG.SYMBOL,
      tf: CONFIG.TF,
      price: null,
      time: null,
    },

    meta: {
      barIndex: 0,
      lastUpdatedAt: null,
    },

    features: {
      open: null,
      high: null,
      low: null,
      close: null,
      ema8: null,
      ema18: null,
      ema50: null,
      rsi: null,
      atr: null,
      atrPct: null,
      adx: null,
      oiTrend: null,
      oiDeltaBias: null,
      cvdTrend: null,
      liqClusterBelow: null,
      priceDropPct: null,
      patternAReady: null,
      patternAWatch: null,
    },
