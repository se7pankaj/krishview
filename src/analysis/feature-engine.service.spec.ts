/**
 * analysis/feature-engine.service.spec.ts — Sprint 2 Feature Engine Tests
 * =========================================================================
 * Tests EMA, RSI, ATR, Fibonacci computations.
 * SmcService is mocked — only pure math is tested here.
 */

import { Test } from '@nestjs/testing';
import { FeatureEngineService } from './feature-engine.service';
import { SmcService, Candle } from '../smc/smc.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const candle = (close: number, high?: number, low?: number): Candle => ({
  time:   '2024-01-01T00:00:00Z',
  open:   close - 0.5,
  high:   high ?? close + 1,
  low:    low  ?? close - 1,
  close,
  volume: 1000,
});

/** Flat candles at a fixed price */
const flat = (price: number, n: number): Candle[] =>
  Array.from({ length: n }, () => candle(price));

/** Rising candles */
const rising = (start: number, step: number, n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const p = start + i * step;
    return candle(p, p + 1, p - 1);
  });

/** Falling candles */
const falling = (start: number, step: number, n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const p = start - i * step;
    return candle(p, p + 1, p - 1);
  });

// ─── Mock SmcService ──────────────────────────────────────────────────────────

const mockSmc = {
  getHTFBias:            jest.fn().mockReturnValue('BULLISH'),
  premiumDiscount:       jest.fn().mockReturnValue({ zone: 'discount', pct: 40, swingHigh: 2100, swingLow: 1900, equilibrium: 2000 }),
  detectStructure:       jest.fn().mockReturnValue([]),
  detectLiquiditySweeps: jest.fn().mockReturnValue([]),
};

// ─── Setup ────────────────────────────────────────────────────────────────────

let service: FeatureEngineService;

beforeEach(async () => {
  const module = await Test.createTestingModule({
    providers: [
      FeatureEngineService,
      { provide: SmcService, useValue: mockSmc },
    ],
  }).compile();
  service = module.get<FeatureEngineService>(FeatureEngineService);
});

// ─── EMA ──────────────────────────────────────────────────────────────────────

describe('computeEMA', () => {
  it('flat candles → EMA equals that price', () => {
    const ema = service.computeEMA(flat(2000, 50), 20);
    expect(ema).toBeCloseTo(2000, 1);
  });

  it('EMA20 > price when price falls below flat level', () => {
    const base = flat(2000, 30);
    const drop = falling(1980, 5, 20);
    const candles = [...base, ...drop];
    const ema = service.computeEMA(candles, 20);
    expect(ema).toBeGreaterThan(candles[candles.length - 1].close);
  });

  it('returns at least price of last candle when not enough data', () => {
    const ema = service.computeEMA(flat(2000, 5), 20);
    expect(ema).toBe(2000);
  });

  it('shorter period EMA reacts faster than longer', () => {
    const candles = [...flat(2000, 50), ...rising(2000, 10, 20)];
    const ema20  = service.computeEMA(candles, 20);
    const ema200 = service.computeEMA(candles, 200);
    // 200-period EMA barely moved, 20-period moved more
    expect(ema20).toBeGreaterThan(ema200);
  });
});

// ─── RSI ──────────────────────────────────────────────────────────────────────

describe('computeRSI', () => {
  it('returns 50 when insufficient data', () => {
    expect(service.computeRSI(flat(2000, 5), 14)).toBe(50);
  });

  it('returns 100 for pure upward candles (no losses)', () => {
    const rsi = service.computeRSI(rising(2000, 1, 50), 14);
    expect(rsi).toBe(100);
  });

  it('returns 0 for pure downward candles (no gains)', () => {
    const rsi = service.computeRSI(falling(2000, 1, 50), 14);
    expect(rsi).toBe(0);
  });

  it('flat candles after a run should land near 50', () => {
    const candles = [...rising(1900, 5, 30), ...flat(2050, 30)];
    const rsi = service.computeRSI(candles, 14);
    // Flat after a rise: RSI should drift toward 50
    expect(rsi).toBeGreaterThan(40);
    expect(rsi).toBeLessThan(80);
  });

  it('is always in [0, 100]', () => {
    const candles = [
      ...rising(2000, 3, 20),
      ...falling(2060, 4, 20),
      ...rising(1900, 2, 20),
    ];
    const rsi = service.computeRSI(candles, 14);
    expect(rsi).toBeGreaterThanOrEqual(0);
    expect(rsi).toBeLessThanOrEqual(100);
  });
});

// ─── ATR ──────────────────────────────────────────────────────────────────────

describe('computeATR', () => {
  it('returns 0 for zero-range candles', () => {
    const zeroes = Array.from({ length: 20 }, () =>
      ({ time: '', open: 2000, high: 2000, low: 2000, close: 2000, volume: 0 }),
    );
    expect(service.computeATR(zeroes, 14)).toBe(0);
  });

  it('returns the range for uniform candles (H-L = 10 each)', () => {
    const candles = Array.from({ length: 20 }, () =>
      ({ time: '', open: 2005, high: 2010, low: 2000, close: 2005, volume: 0 }),
    );
    expect(service.computeATR(candles, 14)).toBeCloseTo(10, 1);
  });

  it('is always positive', () => {
    const atr = service.computeATR(rising(2000, 2, 50), 14);
    expect(atr).toBeGreaterThan(0);
  });

  it('wider ranges → higher ATR', () => {
    const narrow = Array.from({ length: 20 }, () =>
      ({ time: '', open: 2000, high: 2005, low: 1995, close: 2000, volume: 0 }),
    );
    const wide = Array.from({ length: 20 }, () =>
      ({ time: '', open: 2000, high: 2050, low: 1950, close: 2000, volume: 0 }),
    );
    expect(service.computeATR(wide, 14)).toBeGreaterThan(service.computeATR(narrow, 14));
  });
});

// ─── Fibonacci ────────────────────────────────────────────────────────────────

describe('computeFibonacci', () => {
  const fiftyCandles = (): Candle[] => [
    ...falling(2100, 4, 25),   // swing low at ~2000
    ...rising(2000, 4, 25),    // swing high at ~2100
  ];

  it('has swingHigh > swingLow', () => {
    const fib = service.computeFibonacci(fiftyCandles());
    expect(fib.swingHigh).toBeGreaterThan(fib.swingLow);
  });

  it('levels are in ascending order', () => {
    const f = service.computeFibonacci(fiftyCandles());
    expect(f.level0).toBeLessThanOrEqual(f.level236);
    expect(f.level236).toBeLessThanOrEqual(f.level382);
    expect(f.level382).toBeLessThanOrEqual(f.level500);
    expect(f.level500).toBeLessThanOrEqual(f.level618);
    expect(f.level618).toBeLessThanOrEqual(f.level786);
    expect(f.level786).toBeLessThanOrEqual(f.level100);
  });

  it('level0 = swingLow, level100 = swingHigh', () => {
    const fib = service.computeFibonacci(fiftyCandles());
    expect(fib.level0).toBeCloseTo(fib.swingLow, 1);
    expect(fib.level100).toBeCloseTo(fib.swingHigh, 1);
  });

  it('50% level is midpoint of range', () => {
    const fib = service.computeFibonacci(fiftyCandles());
    const mid = (fib.swingHigh + fib.swingLow) / 2;
    expect(fib.level500).toBeCloseTo(mid, 1);
  });

  it('currentZone is a non-empty string', () => {
    const fib = service.computeFibonacci(fiftyCandles());
    expect(typeof fib.currentZone).toBe('string');
    expect(fib.currentZone.length).toBeGreaterThan(0);
  });
});

// ─── computeTrend ─────────────────────────────────────────────────────────────

describe('computeTrend', () => {
  it('bullish trend → direction is bullish', () => {
    const candles = rising(1900, 2, 250); // enough for EMA200
    const trend = service.computeTrend(candles, service.computeATR(candles));
    expect(trend.direction).toBe('bullish');
  });

  it('bearish trend → direction is bearish', () => {
    const candles = falling(2100, 2, 250);
    const trend = service.computeTrend(candles, service.computeATR(candles));
    expect(trend.direction).toBe('bearish');
  });

  it('ema200Distance is a number', () => {
    const candles = rising(2000, 1, 250);
    const atr = service.computeATR(candles);
    const trend = service.computeTrend(candles, atr);
    expect(typeof trend.ema200Distance).toBe('number');
  });
});

// ─── compute (full feature set) ───────────────────────────────────────────────

describe('compute (full FeatureSet)', () => {
  it('returns a FeatureSet with required top-level keys', () => {
    const htf = rising(1900, 2, 250);
    const ltf = rising(2000, 1, 150);
    const result = service.compute(htf, ltf, null, 'XAUUSD');
    expect(result).toHaveProperty('symbol', 'XAUUSD');
    expect(result).toHaveProperty('price');
    expect(result).toHaveProperty('htfTrend');
    expect(result).toHaveProperty('ltfTrend');
    expect(result).toHaveProperty('momentum');
    expect(result).toHaveProperty('fibonacci');
    expect(result).toHaveProperty('smc');
  });

  it('price equals last LTF candle close', () => {
    const ltf = rising(2000, 1, 150);
    const result = service.compute(rising(1900, 2, 250), ltf, null, 'XAUUSD');
    expect(result.price).toBe(ltf[ltf.length - 1].close);
  });

  it('smc.bos is boolean', () => {
    const result = service.compute(
      rising(1900, 2, 250),
      rising(2000, 1, 150),
      null,
      'XAUUSD',
    );
    expect(typeof result.smc.bos).toBe('boolean');
  });
});
