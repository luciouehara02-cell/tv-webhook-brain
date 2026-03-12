'use strict';

/**
 * NodeOI.js
 * ------------------------------------------------------------
 * Open Interest Intelligence module for Brain server
 *
 * Purpose:
 *   - Fetch Binance USDⓈ-M futures public market positioning data
 *   - Compute OI / price / volume features
 *   - Classify market state:
 *       new_longs / short_covering / new_shorts / long_unwind / mixed
 *   - Validate READY trades before sending to 3Commas
 *
 * Works with Node 18+ (native fetch)
 *
 * Suggested usage:
 *   const NodeOI = require('./NodeOI');
 *   const oi = new NodeOI({ symbol: 'SOLUSDT' });
 *   await oi.refresh();
 *   const snap = oi.getSnapshot();
 *   const decision = oi.validateReadySignal({ side: 'long', readyTag: 'READY_long' });
 */

class NodeOI {
  constructor(config = {}) {
    this.cfg = {
      symbol: config.symbol || process.env.OI_SYMBOL || 'SOLUSDT',
      baseUrl: config.baseUrl || process.env.BINANCE_FAPI_BASE || 'https://fapi.binance.com',

      // Polling / history settings
      oiPeriod: config.oiPeriod || process.env.OI_PERIOD || '5m',
      oiLimit: Number(config.oiLimit || process.env.OI_LIMIT || 30),
      klineInterval: config.klineInterval || process.env.OI_KLINE_INTERVAL || '5m',
      klineLimit: Number(config.klineLimit || process.env.OI_KLINE_LIMIT || 30),

      // Feature thresholds
      oiExpandPct: Number(config.oiExpandPct || process.env.OI_EXPAND_PCT || 0.40),      // %
      oiContractPct: Number(config.oiContractPct || process.env.OI_CONTRACT_PCT || -0.25), // %
      priceMovePct: Number(config.priceMovePct || process.env.OI_PRICE_MOVE_PCT || 0.35),  // %
      volSpikeRatio: Number(config.volSpikeRatio || process.env.OI_VOL_SPIKE_RATIO || 1.20),
      breakoutLookback: Number(config.breakoutLookback || process.env.OI_BREAKOUT_LOOKBACK || 12),

      // Confidence scoring
      minConfidence: Number(config.minConfidence || process.env.OI_MIN_CONFIDENCE || 0.60),

      // Optional data toggles
      useGlobalLs: this.#toBool(config.useGlobalLs, process.env.OI_USE_GLOBAL_LS, true),
      useTopTraderLs: this.#toBool(config.useTopTraderLs, process.env.OI_USE_TOP_TRADER_LS, false),
      useFunding: this.#toBool(config.useFunding, process.env.OI_USE_FUNDING, true),

      // Timeout/retries
      timeoutMs: Number(config.timeoutMs || process.env.OI_TIMEOUT_MS || 7000),
      retries: Number(config.retries || process.env.OI_RETRIES || 2),

      // Logging
      debug: this.#toBool(config.debug, process.env.OI_DEBUG, false),
    };

    this.state = {
      ts: 0,
      symbol: this.cfg.symbol,

      markPrice: null,
      priceChange5mPct: null,
      priceChange15mPct: null,

      oiNow: null,
      oiPrev5m: null,
      oiPrev15m: null,
      oiDelta5mPct: null,
      oiDelta15mPct: null,
      oiMean: null,
      oiStd: null,
      oiZScore: null,

      volNow: null,
      volAvg: null,
      volRatio: null,

      breakoutUp: false,
      breakoutDown: false,

      globalLongShortRatio: null,
      topTraderLongShortRatio: null,
      fundingRate: null,

      oiState: 'unknown',
      positioningBias: 'mixed',
      regime: 'unknown',
      confidence: 0,

      raw: {},
      fetchOk: false,
      errors: [],
    };
  }

  #toBool(a, b, fallback = false) {
    if (typeof a === 'boolean') return a;
    if (typeof b === 'string') {
      const v = b.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(v)) return true;
      if (['0', 'false', 'no', 'off'].includes(v)) return false;
    }
    return fallback;
  }

  log(...args) {
    if (this.cfg.debug) console.log('[NodeOI]', ...args);
  }

  async refresh() {
    const errors = [];
    const symbol = this.cfg.symbol;

    try {
      const [
        markPrice,
        oiNow,
        oiHist,
        klines,
        globalLs,
        topTraderLs,
        fundingRate,
      ] = await Promise.all([
        this.fetchMarkPrice(symbol).catch(err => {
          errors.push(`markPrice: ${err.message}`);
          return null;
        }),
        this.fetchCurrentOI(symbol).catch(err => {
          errors.push(`currentOI: ${err.message}`);
          return null;
        }),
        this.fetchOIHistory(symbol, this.cfg.oiPeriod, this.cfg.oiLimit).catch(err => {
          errors.push(`oiHist: ${err.message}`);
          return [];
        }),
        this.fetchKlines(symbol, this.cfg.klineInterval, this.cfg.klineLimit).catch(err => {
          errors.push(`klines: ${err.message}`);
          return [];
        }),
        this.cfg.useGlobalLs
          ? this.fetchGlobalLongShortRatio(symbol, this.cfg.oiPeriod, 2).catch(err => {
              errors.push(`globalLS: ${err.message}`);
              return [];
            })
          : Promise.resolve([]),
        this.cfg.useTopTraderLs
          ? this.fetchTopTraderLongShortPositionRatio(symbol, this.cfg.oiPeriod, 2).catch(err => {
              errors.push(`topTraderLS: ${err.message}`);
              return [];
            })
          : Promise.resolve([]),
        this.cfg.useFunding
          ? this.fetchFundingRate(symbol, 1).catch(err => {
              errors.push(`fundingRate: ${err.message}`);
              return [];
            })
          : Promise.resolve([]),
      ]);

      this.compute({
        markPrice,
        oiNow,
        oiHist,
        klines,
        globalLs,
        topTraderLs,
        fundingRate,
      });

      this.state.errors = errors;
      this.state.fetchOk = errors.length === 0 || !!(oiHist.length && klines.length);
      this.state.ts = Date.now();

      return this.getSnapshot();
    } catch (err) {
      this.state.fetchOk = false;
      this.state.errors = [err.message];
      this.state.ts = Date.now();
      throw err;
    }
  }

  getSnapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  validateReadySignal({ side, readyTag = 'READY', extraFilters = {} } = {}) {
    const s = this.state;
    const sideNorm = String(side || '').toLowerCase();

    const reasons = [];
    let allow = true;
    let score = s.confidence || 0;

    if (!s.fetchOk) {
      allow = false;
      reasons.push('oi_data_unavailable');
    }

    if (sideNorm !== 'long' && sideNorm !== 'short') {
      allow = false;
      reasons.push('invalid_side');
    }

    if (sideNorm === 'long') {
      const positiveBias = ['new_longs', 'short_covering'];
      if (!positiveBias.includes(s.positioningBias)) {
        allow = false;
        reasons.push(`positioning_bias_${s.positioningBias}`);
      }

      if (s.breakoutUp && s.oiDelta5mPct !== null && s.oiDelta5mPct < 0 && s.volRatio < 1.0) {
        allow = false;
        reasons.push('possible_fake_breakout_up');
      }

      if (s.regime === 'long_unwind' || s.regime === 'liq_flush') {
        allow = false;
        reasons.push(`regime_${s.regime}`);
      }
    }

    if (sideNorm === 'short') {
      const negativeBias = ['new_shorts', 'long_unwind'];
      if (!negativeBias.includes(s.positioningBias)) {
        allow = false;
        reasons.push(`positioning_bias_${s.positioningBias}`);
      }

      if (s.breakoutDown && s.oiDelta5mPct !== null && s.oiDelta5mPct < 0 && s.volRatio < 1.0) {
        allow = false;
        reasons.push('possible_fake_breakout_down');
      }

      if (s.regime === 'short_covering' || s.regime === 'squeeze_up') {
        allow = false;
        reasons.push(`regime_${s.regime}`);
      }
    }

    if (typeof extraFilters.minConfidence === 'number' && score < extraFilters.minConfidence) {
      allow = false;
      reasons.push(`confidence_lt_${extraFilters.minConfidence}`);
    } else if (score < this.cfg.minConfidence) {
      allow = false;
      reasons.push(`confidence_lt_${this.cfg.minConfidence}`);
    }

    return {
      tag: readyTag,
      side: sideNorm,
      allow,
      confidence: Number(score.toFixed(3)),
      regime: s.regime,
      oiState: s.oiState,
      positioningBias: s.positioningBias,
      breakoutUp: s.breakoutUp,
      breakoutDown: s.breakoutDown,
      volRatio: s.volRatio,
      oiDelta5mPct: s.oiDelta5mPct,
      reasons,
    };
  }

  compute({ markPrice, oiNow, oiHist, klines, globalLs, topTraderLs, fundingRate }) {
    const s = this.state;

    // ---------- Current price ----------
    s.markPrice = markPrice ? this.#num(markPrice.markPrice || markPrice.price) : null;

    // ---------- OI current ----------
    s.oiNow = oiNow ? this.#num(oiNow.openInterest) : null;

    // ---------- OI history ----------
    const oiSeries = (oiHist || [])
      .map(x => ({
        sumOpenInterest: this.#num(x.sumOpenInterest || x.openInterest),
        sumOpenInterestValue: this.#num(x.sumOpenInterestValue),
        timestamp: Number(x.timestamp || x.time || 0),
      }))
      .filter(x => Number.isFinite(x.sumOpenInterest));

    const oiValues = oiSeries.map(x => x.sumOpenInterest);

    s.oiPrev5m = oiValues.length >= 2 ? oiValues[oiValues.length - 2] : null;
    s.oiPrev15m = oiValues.length >= 4 ? oiValues[oiValues.length - 4] : null;

    if (s.oiNow !== null && s.oiPrev5m) {
      s.oiDelta5mPct = this.#pctChange(s.oiPrev5m, s.oiNow);
    } else if (oiValues.length >= 2) {
      s.oiDelta5mPct = this.#pctChange(oiValues[oiValues.length - 2], oiValues[oiValues.length - 1]);
    } else {
      s.oiDelta5mPct = null;
    }

    if (s.oiNow !== null && s.oiPrev15m) {
      s.oiDelta15mPct = this.#pctChange(s.oiPrev15m, s.oiNow);
    } else if (oiValues.length >= 4) {
      s.oiDelta15mPct = this.#pctChange(oiValues[oiValues.length - 4], oiValues[oiValues.length - 1]);
    } else {
      s.oiDelta15mPct = null;
    }

    s.oiMean = oiValues.length ? this.#mean(oiValues) : null;
    s.oiStd = oiValues.length > 1 ? this.#std(oiValues) : null;
    s.oiZScore =
      Number.isFinite(s.oiNow) && Number.isFinite(s.oiMean) && Number.isFinite(s.oiStd) && s.oiStd > 0
        ? Number(((s.oiNow - s.oiMean) / s.oiStd).toFixed(4))
        : null;

    // ---------- Klines / price / volume ----------
    const candles = (klines || []).map(k => ({
      openTime: Number(k[0]),
      open: this.#num(k[1]),
      high: this.#num(k[2]),
      low: this.#num(k[3]),
      close: this.#num(k[4]),
      volume: this.#num(k[5]),
      closeTime: Number(k[6]),
    }));

    if (candles.length >= 2) {
      const last = candles[candles.length - 1];
      const prev = candles[candles.length - 2];

      s.volNow = last.volume;
      const vols = candles.slice(0, -1).map(c => c.volume).filter(Number.isFinite);
      s.volAvg = vols.length ? this.#mean(vols) : null;
      s.volRatio = s.volNow && s.volAvg ? Number((s.volNow / s.volAvg).toFixed(4)) : null;

      s.priceChange5mPct = this.#pctChange(prev.close, last.close);

      if (candles.length >= 4) {
        const prev15 = candles[candles.length - 4];
        s.priceChange15mPct = this.#pctChange(prev15.close, last.close);
      } else {
        s.priceChange15mPct = null;
      }

      const lb = Math.min(this.cfg.breakoutLookback, candles.length - 1);
      const prior = candles.slice(-1 - lb, -1);
      const priorHigh = Math.max(...prior.map(c => c.high));
      const priorLow = Math.min(...prior.map(c => c.low));

      s.breakoutUp = last.close > priorHigh;
      s.breakoutDown = last.close < priorLow;
    } else {
      s.volNow = null;
      s.volAvg = null;
      s.volRatio = null;
      s.priceChange5mPct = null;
      s.priceChange15mPct = null;
      s.breakoutUp = false;
      s.breakoutDown = false;
    }

    // ---------- Ratios / funding ----------
    s.globalLongShortRatio =
      Array.isArray(globalLs) && globalLs.length
        ? this.#num(globalLs[globalLs.length - 1].longShortRatio)
        : null;

    s.topTraderLongShortRatio =
      Array.isArray(topTraderLs) && topTraderLs.length
        ? this.#num(topTraderLs[topTraderLs.length - 1].longShortRatio)
        : null;

    s.fundingRate =
      Array.isArray(fundingRate) && fundingRate.length
        ? this.#num(fundingRate[fundingRate.length - 1].fundingRate)
        : null;

    // ---------- State classification ----------
    const oi5 = s.oiDelta5mPct;
    const px5 = s.priceChange5mPct;
    const volRatio = s.volRatio || 0;

    s.oiState = this.classifyOIState(oi5);
    s.positioningBias = this.classifyPositioningBias({
      priceChange5mPct: px5,
      oiDelta5mPct: oi5,
      volRatio,
    });

    const regimePack = this.classifyRegime({
      priceChange5mPct: px5,
      oiDelta5mPct: oi5,
      volRatio,
      breakoutUp: s.breakoutUp,
      breakoutDown: s.breakoutDown,
      fundingRate: s.fundingRate,
      globalLongShortRatio: s.globalLongShortRatio,
      topTraderLongShortRatio: s.topTraderLongShortRatio,
    });

    s.regime = regimePack.regime;
    s.confidence = regimePack.confidence;

    s.raw = {
      markPrice,
      oiNow,
      oiHist,
      klines,
      globalLs,
      topTraderLs,
      fundingRate,
    };
  }

  classifyOIState(oiDelta5mPct) {
    if (!Number.isFinite(oiDelta5mPct)) return 'unknown';
    if (oiDelta5mPct >= this.cfg.oiExpandPct) return 'expanding';
    if (oiDelta5mPct <= this.cfg.oiContractPct) return 'contracting';
    return 'flat';
  }

  classifyPositioningBias({ priceChange5mPct, oiDelta5mPct, volRatio }) {
    if (!Number.isFinite(priceChange5mPct) || !Number.isFinite(oiDelta5mPct)) return 'mixed';

    const pxUp = priceChange5mPct >= this.cfg.priceMovePct;
    const pxDn = priceChange5mPct <= -this.cfg.priceMovePct;
    const oiUp = oiDelta5mPct >= this.cfg.oiExpandPct;
    const oiDn = oiDelta5mPct <= this.cfg.oiContractPct;
    const volHot = volRatio >= this.cfg.volSpikeRatio;

    if (pxUp && oiUp) return volHot ? 'new_longs' : 'new_longs';
    if (pxUp && oiDn) return volHot ? 'short_covering' : 'short_covering';
    if (pxDn && oiUp) return volHot ? 'new_shorts' : 'new_shorts';
    if (pxDn && oiDn) return volHot ? 'long_unwind' : 'long_unwind';

    return 'mixed';
  }

  classifyRegime({
    priceChange5mPct,
    oiDelta5mPct,
    volRatio,
    breakoutUp,
    breakoutDown,
    fundingRate,
    globalLongShortRatio,
    topTraderLongShortRatio,
  }) {
    let score = 0.25;
    let regime = 'range';

    const px = priceChange5mPct;
    const oi = oiDelta5mPct;
    const vol = volRatio || 0;

    const pxUp = Number.isFinite(px) && px >= this.cfg.priceMovePct;
    const pxDn = Number.isFinite(px) && px <= -this.cfg.priceMovePct;
    const oiUp = Number.isFinite(oi) && oi >= this.cfg.oiExpandPct;
    const oiDn = Number.isFinite(oi) && oi <= this.cfg.oiContractPct;
    const volHot = vol >= this.cfg.volSpikeRatio;

    if (pxUp && oiUp) {
      regime = breakoutUp ? 'trend_up' : 'new_longs';
      score += 0.25;
    }

    if (pxUp && oiDn) {
      regime = volHot ? 'squeeze_up' : 'short_covering';
      score += 0.25;
    }

    if (pxDn && oiUp) {
      regime = breakoutDown ? 'trend_down' : 'new_shorts';
      score += 0.25;
    }

    if (pxDn && oiDn) {
      regime = volHot ? 'liq_flush' : 'long_unwind';
      score += 0.25;
    }

    if (volHot) score += 0.15;
    if (breakoutUp || breakoutDown) score += 0.10;

    if (Number.isFinite(fundingRate)) {
      // Small contextual score only; do not overfit funding.
      if (regime === 'squeeze_up' && fundingRate > 0) score += 0.05;
      if (regime === 'liq_flush' && fundingRate < 0) score += 0.05;
    }

    if (Number.isFinite(globalLongShortRatio)) {
      if ((regime === 'squeeze_up' || regime === 'short_covering') && globalLongShortRatio < 1) score += 0.05;
      if ((regime === 'liq_flush' || regime === 'long_unwind') && globalLongShortRatio > 1) score += 0.05;
    }

    if (Number.isFinite(topTraderLongShortRatio)) {
      if ((regime === 'trend_up' || regime === 'new_longs') && topTraderLongShortRatio > 1) score += 0.05;
      if ((regime === 'trend_down' || regime === 'new_shorts') && topTraderLongShortRatio < 1) score += 0.05;
    }

    score = Math.max(0, Math.min(0.99, score));

    return {
      regime,
      confidence: Number(score.toFixed(3)),
    };
  }

  async fetchCurrentOI(symbol) {
    return this.#request('/fapi/v1/openInterest', { symbol });
  }

  async fetchOIHistory(symbol, period = '5m', limit = 30) {
    return this.#request('/futures/data/openInterestHist', { symbol, period, limit });
  }

  async fetchMarkPrice(symbol) {
    return this.#request('/fapi/v1/premiumIndex', { symbol });
  }

  async fetchKlines(symbol, interval = '5m', limit = 30) {
    return this.#request('/fapi/v1/klines', { symbol, interval, limit });
  }

  async fetchGlobalLongShortRatio(symbol, period = '5m', limit = 2) {
    return this.#request('/futures/data/globalLongShortAccountRatio', { symbol, period, limit });
  }

  async fetchTopTraderLongShortPositionRatio(symbol, period = '5m', limit = 2) {
    return this.#request('/futures/data/topLongShortPositionRatio', { symbol, period, limit });
  }

  async fetchFundingRate(symbol, limit = 1) {
    return this.#request('/fapi/v1/fundingRate', { symbol, limit });
  }

  async #request(path, params = {}) {
    const url = new URL(path, this.cfg.baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    let lastErr = null;

    for (let attempt = 0; attempt <= this.cfg.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

      try {
        this.log(`GET ${url.toString()}`);

        const res = await fetch(url.toString(), {
          method: 'GET',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
        });

        clearTimeout(timer);

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${res.statusText} ${body}`.trim());
        }

        return await res.json();
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        this.log(`request failed attempt=${attempt + 1} path=${path} err=${err.message}`);

        if (attempt < this.cfg.retries) {
          await this.#sleep(250 * (attempt + 1));
          continue;
        }
      }
    }

    throw lastErr || new Error(`Request failed: ${path}`);
  }

  #sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  #num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  #pctChange(prev, curr) {
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev === 0) return null;
    return Number((((curr - prev) / prev) * 100).toFixed(4));
  }

  #mean(arr) {
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  #std(arr) {
    if (!Array.isArray(arr) || arr.length < 2) return null;
    const mean = this.#mean(arr);
    const variance = arr.reduce((sum, x) => sum + (x - mean) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
  }
}

module.exports = NodeOI;
