/**
 * analysis/ai-reasoning.service.spec.ts — Sprint 2 AI Reasoning Tests
 * =====================================================================
 * Tests the validation layer only — no OpenAI API calls made.
 * ConfigService returns empty OPENAI_API_KEY so analyze() returns null.
 * Private validate() is tested via an exposed wrapper approach:
 * we test through analyze() by mocking axios.
 */

import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AiReasoningService } from './ai-reasoning.service';

// Mock axios before importing to prevent real HTTP calls
jest.mock('axios');
import axios from 'axios';
const mockedAxios = axios as jest.Mocked<typeof axios>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockConfig = (apiKey = 'sk-test-key') => ({
  provide: ConfigService,
  useValue: {
    get: (key: string, def?: any) => {
      const map: Record<string, string> = {
        OPENAI_API_KEY:    apiKey,
        OPENAI_MODEL:      'gpt-4o-mini',
        AI_MIN_CONFIDENCE: '70',
      };
      return map[key] ?? def;
    },
  },
});

const mockFeatures: any = {
  symbol: 'XAUUSD',
  timestamp: '2024-01-01T09:00:00Z',
  price: 2000,
  d1Trend:  { direction: 'bullish', ema20: 1990, ema50: 1985, ema200: 1950, aligned: true, ema200Distance: 2.5 },
  h1Trend:  { direction: 'bullish', ema20: 1997, ema50: 1993, ema200: 1970, aligned: true, ema200Distance: 1.4 },
  m15Trend: { direction: 'bullish', ema20: 1998, ema50: 1995, ema200: 1980, aligned: true, ema200Distance: 1.0 },
  m5Trend:  { direction: 'bullish', ema20: 1999, ema50: 1997, ema200: 1985, aligned: true, ema200Distance: 0.7 },
  momentum: { rsi: 55, rsiZone: 'neutral', rsiTrend: 'rising', bullishDivergence: false, bearishDivergence: false, atr: 5 },
  fibonacci: { swingHigh: 2050, swingLow: 1950, level382: 1988, level500: 2000, level618: 2012, currentZone: '38.2-50%' },
  smc: { bias: 'BULLISH', bos: true, choch: false, lastBosDirection: 'bullish', lastSwingHigh: 2010, lastSwingLow: 1980, obPresent: true, obHigh: 1998, obLow: 1995, fvgPresent: false, fvgHigh: null, fvgLow: null, liquiditySwept: true, zone: 'discount', zonePct: 40 },
};

function makeAxiosResponse(payload: object, promptTokens = 100, completionTokens = 50) {
  return {
    data: {
      choices: [{ message: { content: JSON.stringify(payload) } }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    },
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let service: AiReasoningService;

async function buildService(apiKey = 'sk-test-key'): Promise<AiReasoningService> {
  const module = await Test.createTestingModule({
    providers: [AiReasoningService, mockConfig(apiKey)],
  }).compile();
  return module.get<AiReasoningService>(AiReasoningService);
}

beforeEach(async () => {
  service = await buildService();
  jest.clearAllMocks();
});

// ─── No API key ───────────────────────────────────────────────────────────────

describe('analyze — no API key', () => {
  it('returns null when OPENAI_API_KEY is empty', async () => {
    const s = await buildService('');
    const result = await s.analyze(mockFeatures, null);
    expect(result).toBeNull();
  });
});

// ─── Valid AI responses ───────────────────────────────────────────────────────

describe('analyze — valid responses', () => {
  it('returns AIRecommendation for a clean BUY signal', async () => {
    mockedAxios.post = jest.fn().mockResolvedValue(makeAxiosResponse({
      decision: 'BUY',
      confidence: 80,
      entry: '1998-2000',
      stopLoss: 1988,
      takeProfit: 2025,
      reasons: ['BOS confirmed', 'Order block mitigation'],
      risks: ['CPI news tomorrow'],
    }));

    const result = await service.analyze(mockFeatures, null);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe('BUY');
    expect(result!.confidence).toBe(80);
    expect(result!.stopLoss).toBe(1988);
    expect(result!.takeProfit).toBe(2025);
    expect(result!.rr).toBeGreaterThanOrEqual(2);
    expect(result!.reasons.length).toBeGreaterThanOrEqual(1);
    expect(result!.risks.length).toBeGreaterThanOrEqual(1);
  });

  it('returns AIRecommendation for a clean SELL signal', async () => {
    const sellFeatures = { ...mockFeatures, price: 2020, smc: { ...mockFeatures.smc, zone: 'premium', zonePct: 65 } };
    mockedAxios.post = jest.fn().mockResolvedValue(makeAxiosResponse({
      decision: 'SELL',
      confidence: 75,
      entry: '2018-2020',
      stopLoss: 2030,
      takeProfit: 1998,
      reasons: ['Bearish OB', 'Premium zone'],
      risks: ['Trending market'],
    }));

    const result = await service.analyze(sellFeatures, null);
    expect(result).not.toBeNull();
    expect(result!.decision).toBe('SELL');
    expect(result!.rr).toBeGreaterThanOrEqual(2);
  });

  it('returns null for WAIT decision', async () => {
    mockedAxios.post = jest.fn().mockResolvedValue(makeAxiosResponse({
      decision: 'WAIT',
      confidence: 45,
      entry: '',
      stopLoss: 0,
      takeProfit: 0,
      reasons: ['Market unclear'],
      risks: ['News risk'],
    }));

    const result = await service.analyze(mockFeatures, null);
    expect(result).toBeNull();
  });

  it('includes model and token counts in result', async () => {
    mockedAxios.post = jest.fn().mockResolvedValue(makeAxiosResponse({
      decision: 'BUY',
      confidence: 75,
      entry: '1998',
      stopLoss: 1988,
      takeProfit: 2018,
      reasons: ['BOS', 'OB'],
      risks: ['NFP'],
    }, 120, 60));

    const result = await service.analyze(mockFeatures, null);
    expect(result!.model).toBe('gpt-4o-mini');
    expect(result!.promptTokens).toBe(120);
    expect(result!.completionTokens).toBe(60);
  });
});

// ─── Validation failures ──────────────────────────────────────────────────────

describe('analyze — validation rejects bad responses', () => {
  it('returns null when confidence below threshold (< 70)', async () => {
    mockedAxios.post = jest.fn().mockResolvedValue(makeAxiosResponse({
      decision: 'BUY', confidence: 60,
      entry: '1998', stopLoss: 1988, takeProfit: 2018,
      reasons: ['weak'], risks: ['risk'],
    }));
    expect(await service.analyze(mockFeatures, null)).toBeNull();
  });

  it('returns null when RR < 2', async () => {
    // entry=2000, sl=1996 (4pt), tp=2007 (7pt) → RR=1.75
    mockedAxios.post = jest.fn().mockResolvedValue(makeAxiosResponse({
      decision: 'BUY', confidence: 80,
      entry: '2000', stopLoss: 1996, takeProfit: 2007,
      reasons: ['BOS'], risks: ['news'],
    }));
    expect(await service.analyze(mockFeatures, null)).toBeNull();
  });

  it('returns null when BUY SL is above entry price', async () => {
    mockedAxios.post = jest.fn().mockResolvedValue(makeAxiosResponse({
      decision: 'BUY', confidence: 80,
      entry: '2000', stopLoss: 2010, takeProfit: 2030, // SL above entry = invalid BUY
      reasons: ['BOS'], risks: ['news'],
    }));
    expect(await service.analyze(mockFeatures, null)).toBeNull();
  });

  it('returns null when SELL SL is below entry price', async () => {
    mockedAxios.post = jest.fn().mockResolvedValue(makeAxiosResponse({
      decision: 'SELL', confidence: 80,
      entry: '2020', stopLoss: 2005, takeProfit: 1990, // SL below entry = invalid SELL
      reasons: ['OB'], risks: ['news'],
    }));
    const sellFeatures = { ...mockFeatures, price: 2020 };
    expect(await service.analyze(sellFeatures, null)).toBeNull();
  });

  it('returns null when reasons array is empty', async () => {
    mockedAxios.post = jest.fn().mockResolvedValue(makeAxiosResponse({
      decision: 'BUY', confidence: 80,
      entry: '1998', stopLoss: 1988, takeProfit: 2018,
      reasons: [], risks: ['news'], // empty reasons
    }));
    expect(await service.analyze(mockFeatures, null)).toBeNull();
  });

  it('returns null when risks array is empty', async () => {
    mockedAxios.post = jest.fn().mockResolvedValue(makeAxiosResponse({
      decision: 'BUY', confidence: 80,
      entry: '1998', stopLoss: 1988, takeProfit: 2018,
      reasons: ['BOS'], risks: [], // empty risks
    }));
    expect(await service.analyze(mockFeatures, null)).toBeNull();
  });

  it('returns null for unknown decision value', async () => {
    mockedAxios.post = jest.fn().mockResolvedValue(makeAxiosResponse({
      decision: 'HOLD', confidence: 80,
      entry: '1998', stopLoss: 1988, takeProfit: 2018,
      reasons: ['BOS'], risks: ['news'],
    }));
    expect(await service.analyze(mockFeatures, null)).toBeNull();
  });

  it('returns null when required fields are missing', async () => {
    mockedAxios.post = jest.fn().mockResolvedValue(makeAxiosResponse({
      decision: 'BUY',
      confidence: 80,
      // missing entry, stopLoss, takeProfit, reasons, risks
    }));
    expect(await service.analyze(mockFeatures, null)).toBeNull();
  });

  it('returns null when axios throws (network error)', async () => {
    mockedAxios.post = jest.fn().mockRejectedValue(new Error('Network error'));
    expect(await service.analyze(mockFeatures, null)).toBeNull();
  });
});

// ─── Entry price parsing ──────────────────────────────────────────────────────

describe('entry price parsing', () => {
  it('parses range string like "1998-2000" as midpoint', async () => {
    mockedAxios.post = jest.fn().mockResolvedValue(makeAxiosResponse({
      decision: 'BUY', confidence: 80,
      entry: '1996-2000', stopLoss: 1986, takeProfit: 2020,
      reasons: ['BOS', 'OB'], risks: ['news'],
    }));
    const result = await service.analyze(mockFeatures, null);
    expect(result!.entryPrice).toBeCloseTo(1998, 1); // midpoint of 1996-2000
  });

  it('parses single number entry', async () => {
    mockedAxios.post = jest.fn().mockResolvedValue(makeAxiosResponse({
      decision: 'BUY', confidence: 80,
      entry: '1999.50', stopLoss: 1989, takeProfit: 2019,
      reasons: ['BOS'], risks: ['news'],
    }));
    const result = await service.analyze(mockFeatures, null);
    expect(result!.entryPrice).toBeCloseTo(1999.5, 1);
  });
});
