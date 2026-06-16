/**
 * risk/risk.service.spec.ts — Sprint 1 Risk Service Tests
 * =========================================================
 * Tests session filter, lot sizing, and risk gate logic.
 * JournalService is mocked so no DB needed.
 */

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RiskService } from './risk.service';
import { JournalService } from '../journal/journal.service';
import { SMCSignal } from '../smc/smc.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockConfig = (overrides: Record<string, string> = {}) => ({
  provide: ConfigService,
  useValue: {
    get: (key: string, def?: any) => {
      const defaults: Record<string, string> = {
        RISK_PCT:             '1',
        MAX_DAILY_LOSS_PCT:   '3',
        MAX_TRADES:           '3',
        MIN_RR:               '2',
        SPREAD_LIMIT:         '30',
        CONFIDENCE_THRESHOLD: '60',
        LONDON_START:         '7',
        LONDON_END:           '16',
        NY_START:             '12',
        NY_END:               '21',
        ...overrides,
      };
      return defaults[key] ?? def;
    },
  },
});

const mockJournal = (dailyPnL = 0) => ({
  provide: JournalService,
  useValue: {
    getDailyPnL: jest.fn().mockResolvedValue(dailyPnL),
  },
});

const mockSignal = (overrides: Partial<SMCSignal> = {}): SMCSignal => ({
  direction: 'BUY',
  bias: 'BULLISH',
  entryPrice: 2000,
  sl: 1990,
  tp: 2020,
  rr: 2,
  confidence: 70,
  reasons: ['Order block', 'BOS'],
  ob: null,
  fvg: null,
  structure: null,
  sweep: null,
  ...overrides,
});

const mockAccount = (balance = 10000, equity = 10000) => ({ balance, equity });

// ─── Setup ────────────────────────────────────────────────────────────────────

async function buildService(configOverrides = {}, dailyPnL = 0): Promise<RiskService> {
  const module = await Test.createTestingModule({
    providers: [
      RiskService,
      mockConfig(configOverrides),
      mockJournal(dailyPnL),
    ],
  }).compile();
  return module.get<RiskService>(RiskService);
}

// ─── calcLotSize ──────────────────────────────────────────────────────────────

describe('calcLotSize', () => {
  let service: RiskService;
  beforeEach(async () => { service = await buildService(); });

  it('is always >= 0.01 (minimum lot)', () => {
    const lots = service.calcLotSize(100, 2000, 1999.99); // tiny balance, tiny SL
    expect(lots).toBeGreaterThanOrEqual(0.01);
  });

  it('scales with balance — double balance → double lots', () => {
    const l1 = service.calcLotSize(10_000, 2000, 1990);
    const l2 = service.calcLotSize(20_000, 2000, 1990);
    expect(l2).toBeCloseTo(l1 * 2, 1);
  });

  it('scales inversely with SL distance — wider SL → fewer lots', () => {
    const l1 = service.calcLotSize(10_000, 2000, 1990); // 10pt SL
    const l2 = service.calcLotSize(10_000, 2000, 1980); // 20pt SL
    expect(l1).toBeGreaterThan(l2);
  });

  it('correct lot for $10k balance, 1% risk, 10pt SL: expect 0.10', () => {
    // riskUSD = 100, slPoints = 100, pipValue = 10 → lots = 100/(100*10) = 0.10
    const lots = service.calcLotSize(10_000, 2000, 1990);
    expect(lots).toBeCloseTo(0.10, 2);
  });

  it('correct lot for $5k balance, 10pt SL: expect 0.05', () => {
    const lots = service.calcLotSize(5_000, 2000, 1990);
    expect(lots).toBeCloseTo(0.05, 2);
  });
});

// ─── isAllowedSession ─────────────────────────────────────────────────────────

describe('isAllowedSession', () => {
  it('returns boolean', async () => {
    const service = await buildService();
    expect(typeof service.isAllowedSession()).toBe('boolean');
  });

  // We can't mock Date easily without jest.spyOn, so we test the logic
  // by checking the return value at the actual current time.
  it('returns false on Saturday', () => {
    // Saturday = 6
    jest.spyOn(Date.prototype, 'getUTCDay').mockReturnValue(6);
    jest.spyOn(Date.prototype, 'getUTCHours').mockReturnValue(10);
    buildService().then(s => {
      expect(s.isAllowedSession()).toBe(false);
    });
    jest.restoreAllMocks();
  });

  it('returns false on Sunday', () => {
    jest.spyOn(Date.prototype, 'getUTCDay').mockReturnValue(0);
    jest.spyOn(Date.prototype, 'getUTCHours').mockReturnValue(10);
    buildService().then(s => {
      expect(s.isAllowedSession()).toBe(false);
    });
    jest.restoreAllMocks();
  });

  it('returns true during London session (09:00 UTC Monday)', async () => {
    jest.spyOn(Date.prototype, 'getUTCDay').mockReturnValue(1);   // Monday
    jest.spyOn(Date.prototype, 'getUTCHours').mockReturnValue(9); // 09:00
    const service = await buildService();
    expect(service.isAllowedSession()).toBe(true);
    jest.restoreAllMocks();
  });

  it('returns false outside sessions (03:00 UTC Wednesday)', async () => {
    jest.spyOn(Date.prototype, 'getUTCDay').mockReturnValue(3);   // Wednesday
    jest.spyOn(Date.prototype, 'getUTCHours').mockReturnValue(3); // 03:00
    const service = await buildService();
    expect(service.isAllowedSession()).toBe(false);
    jest.restoreAllMocks();
  });
});

// ─── riskCheck ────────────────────────────────────────────────────────────────

describe('riskCheck', () => {
  // Force allowed session for all riskCheck tests
  beforeEach(() => {
    jest.spyOn(Date.prototype, 'getUTCDay').mockReturnValue(1);   // Monday
    jest.spyOn(Date.prototype, 'getUTCHours').mockReturnValue(9); // London
  });
  afterEach(() => jest.restoreAllMocks());

  it('passes a clean signal', async () => {
    const service = await buildService();
    const result = await service.riskCheck(mockSignal(), mockAccount(), 0, 10);
    expect(result.ok).toBe(true);
  });

  it('blocks when max trades reached', async () => {
    const service = await buildService({ MAX_TRADES: '2' });
    const result = await service.riskCheck(mockSignal(), mockAccount(), 2, 10);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/max.*trade/i);
  });

  it('blocks when spread too high', async () => {
    const service = await buildService({ SPREAD_LIMIT: '20' });
    const result = await service.riskCheck(mockSignal(), mockAccount(), 0, 25);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/spread/i);
  });

  it('blocks when confidence below threshold', async () => {
    const service = await buildService({ CONFIDENCE_THRESHOLD: '70' });
    const result = await service.riskCheck(
      mockSignal({ confidence: 55 }), mockAccount(), 0, 10,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/confidence/i);
  });

  it('blocks when RR below minimum', async () => {
    const service = await buildService({ MIN_RR: '2' });
    const result = await service.riskCheck(
      mockSignal({ rr: 1.5 }), mockAccount(), 0, 10,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/r[r:]/i);
  });

  it('blocks when daily loss limit hit (getDailyPnL returns large loss)', async () => {
    const service = await buildService({ MAX_DAILY_LOSS_PCT: '3' }, -350); // -$350 on $10k = -3.5%
    const result = await service.riskCheck(mockSignal(), mockAccount(10_000), 0, 10);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/daily loss/i);
  });

  it('returns ok: false with a reason string when blocked', async () => {
    const service = await buildService({ MAX_TRADES: '1' });
    const result = await service.riskCheck(mockSignal(), mockAccount(), 1, 10);
    expect(result.ok).toBe(false);
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });
});
