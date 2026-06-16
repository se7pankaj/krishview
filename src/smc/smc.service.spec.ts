/**
 * smc/smc.service.spec.ts — Sprint 1 Unit Tests
 * ================================================
 * Tests the full SMC engine without any external dependencies.
 * ConfigService is mocked so no DB / network / MT5 needed.
 */

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SmcService, Candle } from './smc.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal candle */
const candle = (
  close: number,
  high?: number,
  low?: number,
  open?: number,
  time = '2024-01-01T00:00:00Z',
): Candle => ({
  time,
  open:   open  ?? close - 0.5,
  high:   high  ?? close + 1,
  low:    low   ?? close - 1,
  close,
  volume: 1000,
});

/** 200 flat candles — neutral market */
const flatCandles = (price = 2000, count = 200): Candle[] =>
  Array.from({ length: count }, (_, i) =>
    candle(price, price + 2, price - 2, price - 0.1, `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
  );

/** Bullish trend: steadily rising closes */
const bullCandles = (start = 1900, count = 200): Candle[] =>
  Array.from({ length: count }, (_, i) => {
    const price = start + i * 2;
    return candle(price, price + 3, price - 1, price - 1, `2024-01-01T${String(i).padStart(2, '0')}:00:00Z`);
  });

/** Bearish trend: steadily falling closes */
const bearCandles = (start = 2100, count = 200): Candle[] =>
  Array.from({ length: count }, (_, i) => {
    const price = start - i * 2;
    return candle(price, price + 1, price - 3, price + 1, `2024-01-01T${String(i).padStart(2, '0')}:00:00Z`);
  });

// ─── Setup ────────────────────────────────────────────────────────────────────

let service: SmcService;

beforeEach(async () => {
  const module = await Test.createTestingModule({
    providers: [
      SmcService,
      {
        provide: ConfigService,
        useValue: {
          get: (key: string, def?: any) => {
            const map: Record<string, any> = {
              OB_THRESHOLD:         '0.6',
              FVG_MIN_GAP:          '0.5',
              LIQ_PIPS:             '0.5',
              MIN_RR:               '2',
              CONFIDENCE_THRESHOLD: '60',
            };
            return map[key] ?? def;
          },
        },
      },
    ],
  }).compile();

  service = module.get<SmcService>(SmcService);
});

// ─── detectStructure ──────────────────────────────────────────────────────────

describe('detectStructure', () => {
  it('returns an array for any candle set', () => {
    const result = service.detectStructure(flatCandles());
    expect(Array.isArray(result)).toBe(true);
  });

  it('detects at least one BOS in a strong bullish trend', () => {
    const result = service.detectStructure(bullCandles());
    const hasBOS = result.some(s => s.type === 'BOS');
    expect(hasBOS).toBe(true);
  });

  it('every event has required fields', () => {
    const result = service.detectStructure(bullCandles());
    for (const ev of result) {
      expect(ev).toHaveProperty('type');
      expect(ev).toHaveProperty('price');
      expect(ev).toHaveProperty('bias');
      expect(['BOS', 'CHoCH']).toContain(ev.type);
      expect(['BULLISH', 'BEARISH', 'NEUTRAL']).toContain(ev.bias);
    }
  });
});

// ─── getHTFBias ───────────────────────────────────────────────────────────────

describe('getHTFBias', () => {
  it('returns BULLISH for consistently rising candles', () => {
    const bias = service.getHTFBias(bullCandles());
    expect(bias).toBe('BULLISH');
  });

  it('returns BEARISH for consistently falling candles', () => {
    const bias = service.getHTFBias(bearCandles());
    expect(bias).toBe('BEARISH');
  });

  it('returns a valid bias string for any input', () => {
    const bias = service.getHTFBias(flatCandles());
    expect(['BULLISH', 'BEARISH', 'NEUTRAL']).toContain(bias);
  });
});

// ─── detectOrderBlocks ────────────────────────────────────────────────────────

describe('detectOrderBlocks', () => {
  it('returns array for any input', () => {
    expect(Array.isArray(service.detectOrderBlocks(bullCandles()))).toBe(true);
  });

  it('each OB has required shape', () => {
    const obs = service.detectOrderBlocks(bullCandles());
    for (const ob of obs) {
      expect(ob).toHaveProperty('high');
      expect(ob).toHaveProperty('low');
      expect(ob).toHaveProperty('mid');
      expect(ob).toHaveProperty('strength');
      expect(ob.high).toBeGreaterThan(ob.low);
      expect(ob.mid).toBeGreaterThan(ob.low);
      expect(ob.mid).toBeLessThan(ob.high);
    }
  });

  it('OB types are valid', () => {
    const obs = service.detectOrderBlocks(bullCandles());
    for (const ob of obs) {
      expect(['BULLISH_OB', 'BEARISH_OB']).toContain(ob.type);
    }
  });
});

// ─── detectFVGs ───────────────────────────────────────────────────────────────

describe('detectFVGs', () => {
  it('returns array for any input', () => {
    expect(Array.isArray(service.detectFVGs(flatCandles()))).toBe(true);
  });

  it('each FVG has high > low', () => {
    const fvgs = service.detectFVGs(bullCandles());
    for (const fvg of fvgs) {
      expect(fvg.high).toBeGreaterThan(fvg.low);
    }
  });

  it('FVG fillPct is between 0 and 100', () => {
    const fvgs = service.detectFVGs(bullCandles());
    for (const fvg of fvgs) {
      expect(fvg.fillPct).toBeGreaterThanOrEqual(0);
      expect(fvg.fillPct).toBeLessThanOrEqual(100);
    }
  });
});

// ─── detectLiquiditySweeps ────────────────────────────────────────────────────

describe('detectLiquiditySweeps', () => {
  it('returns array for any input', () => {
    expect(Array.isArray(service.detectLiquiditySweeps(flatCandles()))).toBe(true);
  });

  it('sweep types are valid', () => {
    const sweeps = service.detectLiquiditySweeps(bullCandles());
    for (const s of sweeps) {
      expect(['equal_highs', 'equal_lows', 'swing_high', 'swing_low']).toContain(s.type);
    }
  });
});

// ─── premiumDiscount ──────────────────────────────────────────────────────────

describe('premiumDiscount', () => {
  it('returns valid zone for candles above midpoint', () => {
    // Price near top of range → premium
    const candles = Array.from({ length: 50 }, (_, i) => {
      const price = i < 25 ? 1800 + i * 4 : 1900; // rises then stays high
      return candle(price, price + 2, price - 2);
    });
    const pd = service.premiumDiscount(candles);
    expect(['premium', 'discount', 'equilibrium']).toContain(pd.zone);
    expect(pd.pct).toBeGreaterThanOrEqual(0);
    expect(pd.pct).toBeLessThanOrEqual(100);
    expect(pd.swingHigh).toBeGreaterThan(pd.swingLow);
  });

  it('equilibrium is midpoint of swing', () => {
    const candles = flatCandles(2000, 50);
    const pd = service.premiumDiscount(candles);
    const expected = (pd.swingHigh + pd.swingLow) / 2;
    expect(pd.equilibrium).toBeCloseTo(expected, 1);
  });
});

// ─── analyze (integration) ────────────────────────────────────────────────────

describe('analyze (4-layer: D1, H1, M15, M5)', () => {
  it('returns null or a valid SMCSignal', () => {
    const result = service.analyze(
      bullCandles(), flatCandles(2000, 200),
      flatCandles(2000, 200), flatCandles(2000, 150),
    );
    if (result !== null) {
      expect(['BUY', 'SELL']).toContain(result.direction);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(100);
      expect(result.rr).toBeGreaterThan(0);
      expect(Array.isArray(result.reasons)).toBe(true);
    }
  });

  it('signal SL is on correct side of entry for BUY', () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = service.analyze(
        bullCandles(1800 + attempt * 50), flatCandles(2000, 200),
        flatCandles(2000, 200), flatCandles(2000, 150),
      );
      if (result?.direction === 'BUY') {
        expect(result.sl).toBeLessThan(result.entryPrice);
        expect(result.tp).toBeGreaterThan(result.entryPrice);
        return;
      }
    }
  });

  it('signal SL is on correct side of entry for SELL', () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = service.analyze(
        bearCandles(2200 + attempt * 50), flatCandles(2000, 200),
        flatCandles(2000, 200), flatCandles(2000, 150),
      );
      if (result?.direction === 'SELL') {
        expect(result.sl).toBeGreaterThan(result.entryPrice);
        expect(result.tp).toBeLessThan(result.entryPrice);
        return;
      }
    }
  });
});
