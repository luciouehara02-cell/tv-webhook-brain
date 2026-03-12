/**
 * NodeOI.js
 * ESM version for Brain v3.3 integration
 * Purpose:
 *  - Fetch Binance futures OI / price / volume context
 *  - Build cached market-positioning snapshot
 *  - Validate long entries before 3Commas execution
 */

export default class NodeOI {
  constructor(config = {}) {
    this.cfg = {
      symbol: config.symbol || "SOLUSDT",
      baseUrl: config.baseUrl || "https://fapi.binance.com",

      oiPeriod: config.oiPeriod || "5m",
      oiLimit: Number(config.oiLimit || 30),
      klineInterval: config.klineInterval || "5m",
      klineLimit: Number(config.klineLimit || 30),

      oiExpandPct: Number(config.oiExpandPct || 0.40),
      oiContractPct: Number(config.oiContractPct || -0.25),
      priceMovePct: Number(config.priceMovePct || 0.35),
      volSpikeRatio: Number(config.volSpikeRatio || 1.20),
      breakoutLookback: Number(config.breakoutLookback || 12),
      minConfidence: Number(config.minConfidence || 0.60),

      useGlobalLs: Boolean(config.useGlobalLs ?? true),
      useFunding: Boolean(config.useFunding ?? true),

      timeoutMs: Number(config.timeoutMs || 7000),
      retries: Number(config.retries || 2),
      debug: Boolean(config.debug ?? false),
    };

    this.state = {
      ts: 0,
      symbol: this.cfg.symbol,
      fetchOk: false,
      errors: [],

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
      fundingRate: null,

      oiState: "unknown",
      positioningBias: "mixed",
      regime: "unknown",
      confidence: 0,
    };
  }

  log(...args) {
    if (this.cfg.debug) console.log("[NodeOI]", ...args);
  }

  num(v, fallback = null) {
    const x = Number(v);
    return Number.isFinite(x) ? x : fallback;
  }

  pct(prev, curr) {
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev === 0) return null;
    return Number((((curr - prev) / prev) * 100).toFixed(4));
  }

  mean(arr) {
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  std(arr) {
    if (!Array.isArray(arr) || arr.length < 2) return null;
    const m = this.mean(arr);
    const v = arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / arr.length;
    return Math.sqrt(v);
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async request(path, params = {}) {
    const url = new URL(path, this.cfg.baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    let lastErr = null;

    for (let i = 0; i <= this.cfg.retries; i++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

      try {
        const resp = await fetch(url.toString(), {
          method: "GET",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          throw new Error(`HTTP ${resp.status} ${resp.statusText} ${body}`.trim());
        }

        return await resp.json();
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        if (i < this.cfg.retries) await this.sleep(250 * (i + 1));
      }
    }

    throw lastErr || new Error(`request failed: ${path}`);
  }

  async fetchMarkPrice(symbol) {
    return this.request("/fapi/v1/premiumIndex", { symbol });
  }

  async fetchCurrentOI(symbol) {
    return this.request("/fapi/v1/openInterest", { symbol });
  }

  async fetchOIHistory(symbol, period = "5m", limit = 30) {
    return this.request("/futures/data/openInterestHist", { symbol, period, limit });
  }

  async fetchKlines(symbol, interval = "5m", limit = 30) {
    return this.request("/fapi/v1/klines", { symbol, interval, limit });
  }

  async fetchGlobalLongShortRatio(symbol, period = "5m", limit = 2) {
    return this.request("/futures/data/globalLongShortAccountRatio", { symbol, period, limit });
  }

  async fetchFundingRate(symbol, limit = 1) {
    return this.request("/fapi/v1/fundingRate", { symbol, limit });
  }

  classifyOIState(oiDelta5mPct) {
    if (!Number.isFinite(oiDelta5mPct)) return "unknown";
    if (oiDelta5mPct >= this.cfg.oiExpandPct) return "expanding";
    if (oiDelta5mPct <= this.cfg.oiContractPct) return "contracting";
    return "flat";
  }

  classifyPositioningBias({ priceChange5mPct, oiDelta5mPct }) {
    if (!Number.isFinite(priceChange5mPct) || !Number.isFinite(oiDelta5mPct)) return "mixed";

    const pxUp = priceChange5mPct >= this.cfg.priceMovePct;
    const pxDn = priceChange5mPct <= -this.cfg.priceMovePct;
    const oiUp = oiDelta5mPct >= this.cfg.oiExpandPct;
    const oiDn = oiDelta5mPct <= this.cfg.oiContractPct;

    if (pxUp && oiUp) return "new_longs";
    if (pxUp && oiDn) return "short_covering";
    if (pxDn && oiUp) return "new_shorts";
    if (pxDn && oiDn) return "long_unwind";
    return "mixed";
  }

  classifyRegime({ priceChange5mPct, oiDelta5mPct, volRatio, breakoutUp, breakoutDown, fundingRate, globalLongShortRatio }) {
    let regime = "range";
    let score = 0.25;

    const pxUp = Number.isFinite(priceChange5mPct) && priceChange5mPct >= this.cfg.priceMovePct;
    const pxDn = Number.isFinite(priceChange5mPct) && priceChange5mPct <= -this.cfg.priceMovePct;
    const oiUp = Number.isFinite(oiDelta5mPct) && oiDelta5mPct >= this.cfg.oiExpandPct;
    const oiDn = Number.isFinite(oiDelta5mPct) && oiDelta5mPct <= this.cfg.oiContractPct;
    const volHot = Number.isFinite(volRatio) && volRatio >= this.cfg.volSpikeRatio;

    if (pxUp && oiUp) {
      regime = breakoutUp ? "trend_up" : "new_longs";
      score += 0.25;
    } else if (pxUp && oiDn) {
      regime = volHot ? "squeeze_up" : "short_covering";
      score += 0.25;
    } else if (pxDn && oiUp) {
      regime = breakoutDown ? "trend_down" : "new_shorts";
      score += 0.25;
    } else if (pxDn && oiDn) {
      regime = volHot ? "liq_flush" : "long_unwind";
      score += 0.25;
    }

    if (volHot) score += 0.15;
    if (breakoutUp || breakoutDown) score += 0.10;

    if (Number.isFinite(fundingRate)) {
      if (regime === "squeeze_up" && fundingRate > 0) score += 0.05;
      if (regime === "liq_flush" && fundingRate < 0) score += 0.05;
    }

    if (Number.isFinite(globalLongShortRatio)) {
      if ((regime === "squeeze_up" || regime === "short_covering") && globalLongShortRatio < 1) score += 0.05;
      if ((regime === "liq_flush" || regime === "long_unwind") && globalLongShortRatio > 1) score += 0.05;
    }

    score = Math.max(0, Math.min(0.99, score));
    return { regime, confidence: Number(score.toFixed(3)) };
  }

  async refresh() {
    const symbol = this.cfg.symbol;
    const errors = [];

    try {
      const [
        markPrice,
        oiNow,
        oiHist,
        klines,
        globalLs,
        fundingRate,
      ] = await Promise.all([
        this.fetchMarkPrice(symbol).catch((e) => { errors.push(`mark=${e.message}`); return null; }),
        this.fetchCurrentOI(symbol).catch((e) => { errors.push(`oiNow=${e.message}`); return null; }),
        this.fetchOIHistory(symbol, this.cfg.oiPeriod, this.cfg.oiLimit).catch((e) => { errors.push(`oiHist=${e.message}`); return []; }),
        this.fetchKlines(symbol, this.cfg.klineInterval, this.cfg.klineLimit).catch((e) => { errors.push(`klines=${e.message}`); return []; }),
        this.cfg.useGlobalLs
          ? this.fetchGlobalLongShortRatio(symbol, this.cfg.oiPeriod, 2).catch((e) => { errors.push(`gls=${e.message}`); return []; })
          : Promise.resolve([]),
        this.cfg.useFunding
          ? this.fetchFundingRate(symbol, 1).catch((e) => { errors.push(`fund=${e.message}`); return []; })
          : Promise.resolve([]),
      ]);

      const oiSeries = (oiHist || [])
        .map((x) => this.num(x.sumOpenInterest ?? x.openInterest))
        .filter((x) => Number.isFinite(x));

      const candles = (klines || []).map((k) => ({
        open: this.num(k[1]),
        high: this.num(k[2]),
        low: this.num(k[3]),
        close: this.num(k[4]),
        volume: this.num(k[5]),
      }));

      const s = this.state;

      s.ts = Date.now();
      s.errors = errors;
      s.fetchOk = !!(oiSeries.length >= 2 && candles.length >= 2);

      s.markPrice = this.num(markPrice?.markPrice ?? markPrice?.price);
      s.oiNow = this.num(oiNow?.openInterest) ?? (oiSeries.length ? oiSeries[oiSeries.length - 1] : null);
      s.oiPrev5m = oiSeries.length >= 2 ? oiSeries[oiSeries.length - 2] : null;
      s.oiPrev15m = oiSeries.length >= 4 ? oiSeries[oiSeries.length - 4] : null;

      s.oiDelta5mPct = (s.oiNow != null && s.oiPrev5m != null) ? this.pct(s.oiPrev5m, s.oiNow) : null;
      s.oiDelta15mPct = (s.oiNow != null && s.oiPrev15m != null) ? this.pct(s.oiPrev15m, s.oiNow) : null;

      s.oiMean = oiSeries.length ? this.mean(oiSeries) : null;
      s.oiStd = oiSeries.length > 1 ? this.std(oiSeries) : null;
      s.oiZScore =
        Number.isFinite(s.oiNow) && Number.isFinite(s.oiMean) && Number.isFinite(s.oiStd) && s.oiStd > 0
          ? Number(((s.oiNow - s.oiMean) / s.oiStd).toFixed(4))
          : null;

      if (candles.length >= 2) {
        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];

        s.volNow = last.volume;
        const vols = candles.slice(0, -1).map((x) => x.volume).filter((x) => Number.isFinite(x));
        s.volAvg = vols.length ? this.mean(vols) : null;
        s.volRatio = Number.isFinite(s.volNow) && Number.isFinite(s.volAvg) && s.volAvg > 0
          ? Number((s.volNow / s.volAvg).toFixed(4))
          : null;

        s.priceChange5mPct = this.pct(prev.close, last.close);
        s.priceChange15mPct = candles.length >= 4 ? this.pct(candles[candles.length - 4].close, last.close) : null;

        const lb = Math.min(this.cfg.breakoutLookback, candles.length - 1);
        const prior = candles.slice(-1 - lb, -1);
        const priorHigh = Math.max(...prior.map((x) => x.high));
        const priorLow = Math.min(...prior.map((x) => x.low));

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

      s.globalLongShortRatio =
        Array.isArray(globalLs) && globalLs.length
          ? this.num(globalLs[globalLs.length - 1]?.longShortRatio)
          : null;

      s.fundingRate =
        Array.isArray(fundingRate) && fundingRate.length
          ? this.num(fundingRate[fundingRate.length - 1]?.fundingRate)
          : null;

      s.oiState = this.classifyOIState(s.oiDelta5mPct);
      s.positioningBias = this.classifyPositioningBias({
        priceChange5mPct: s.priceChange5mPct,
        oiDelta5mPct: s.oiDelta5mPct,
      });

      const pack = this.classifyRegime({
        priceChange5mPct: s.priceChange5mPct,
        oiDelta5mPct: s.oiDelta5mPct,
        volRatio: s.volRatio,
        breakoutUp: s.breakoutUp,
        breakoutDown: s.breakoutDown,
        fundingRate: s.fundingRate,
        globalLongShortRatio: s.globalLongShortRatio,
      });

      s.regime = pack.regime;
      s.confidence = pack.confidence;

      return this.getSnapshot();
    } catch (e) {
      this.state.ts = Date.now();
      this.state.fetchOk = false;
      this.state.errors = [e.message];
      throw e;
    }
  }

  getSnapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  validateReadySignal({ side = "long", readyTag = "READY", extraFilters = {} } = {}) {
    const s = this.state;
    const reasons = [];
    let allow = true;
    const minConfidence = Number(extraFilters.minConfidence ?? this.cfg.minConfidence);

    if (!s.fetchOk) {
      allow = false;
      reasons.push("oi_data_unavailable");
    }

    if (String(side).toLowerCase() === "long") {
      if (!["new_longs", "short_covering"].includes(s.positioningBias)) {
        allow = false;
        reasons.push(`positioning_bias_${s.positioningBias}`);
      }

      if (s.breakoutUp && Number.isFinite(s.oiDelta5mPct) && s.oiDelta5mPct < 0 && (s.volRatio ?? 0) < 1.0) {
        allow = false;
        reasons.push("possible_fake_breakout_up");
      }

      if (["long_unwind", "liq_flush"].includes(s.regime)) {
        allow = false;
        reasons.push(`regime_${s.regime}`);
      }
    } else {
      allow = false;
      reasons.push("only_long_supported");
    }

    if ((s.confidence ?? 0) < minConfidence) {
      allow = false;
      reasons.push(`confidence_lt_${minConfidence}`);
    }

    return {
      tag: readyTag,
      side,
      allow,
      confidence: Number((s.confidence ?? 0).toFixed(3)),
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
}
