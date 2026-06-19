/**
 * analysis/ai-reasoning.service.ts — Claude Sonnet AI Reasoning Layer
 * =====================================================================
 * Receives a structured FeatureSet, builds a tight system + user prompt,
 * calls Anthropic Claude Sonnet 4.6, validates the JSON response, and
 * returns a typed AIRecommendation.
 *
 * Design principle: we never say "analyse this chart image".
 * We feed structured FACTS so Claude reasons over data, not pixels.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { FeatureSet } from './feature-engine.service';
import { SMCSignal } from '../smc/smc.service';
import { ActiveSymbolService } from '../trading/active-symbol.service';
import { sessionToUae } from '../common/symbol-registry';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AIRecommendation {
  decision:   'BUY' | 'SELL' | 'WAIT';
  confidence: number;           // 0-100
  entry:      string;           // e.g. "2350-2352" or "2351.20"
  entryPrice: number;           // parsed midpoint for execution
  stopLoss:   number;
  takeProfit: number;
  rr:         number;           // risk:reward ratio
  reasons:    string[];
  risks:      string[];
  model:      string;
  promptTokens:     number;
  completionTokens: number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class AiReasoningService {
  private readonly logger = new Logger(AiReasoningService.name);

  constructor(
    private readonly config:       ConfigService,
    private readonly activeSymbol: ActiveSymbolService,
  ) {}

  private get apiKey():  string { return this.config.get<string>('ANTHROPIC_API_KEY', ''); }
  private get model():   string { return this.config.get<string>('CLAUDE_MODEL', 'claude-sonnet-4-6'); }
  private get minConf(): number { return parseFloat(this.config.get<string>('AI_MIN_CONFIDENCE', '70')); }

  // ─── Dynamic system prompt — built per symbol on every call ──────────────

  private get systemPrompt(): string {
    const symCfg  = this.activeSymbol.getConfig();
    const sym     = this.activeSymbol.getSymbol();
    const label   = symCfg?.label       ?? sym;
    const desc    = symCfg?.description ?? 'institutional price action';
    const cat     = symCfg?.category    ?? 'forex';

    // Build session killzone description from registry
    const sessionLines = symCfg?.sessions
      .map(s => `- ${s.name} (${s.startUtc}:00–${s.endUtc}:00 UTC = ${sessionToUae(s)})`)
      .join('\n') ?? '- London (07–10 UTC)\n- New York (13–17 UTC)';

    const expertise = cat === 'metals'      ? 'precious metals (gold/silver) SMC trader'
                    : cat === 'indices'     ? 'US equity index SMC trader'
                    : cat === 'commodities' ? 'energy commodities (oil) SMC trader'
                    : cat === 'crypto'      ? 'cryptocurrency (Bitcoin) SMC trader'
                    : 'institutional forex SMC trader';

    return `You are an elite institutional ${expertise} with 20+ years experience.
You are currently analysing ${label} (${sym}). ${desc}.
You specialise in Smart Money Concepts (SMC) with a 5-layer top-down framework:
  D1  → Macro bias (weekly direction)
  H4  → Intermediate bias + Primary Order Blocks (INSTITUTIONAL MONEY LAYER)
  H1  → Structural confirmation (BOS / CHoCH)
  M15 → Entry zone refinement (FVG / OB within H4 zone)
  M5  → Precise trigger (liquidity sweep + MSS)

Key principles:
- H4 Order Blocks are where institutional players position.
- Previous Day High/Low (PDH/PDL) are key intraday reference levels — respect rejections at these levels.
- Active trading sessions for ${sym}:
${sessionLines}
- Only trade WITH the D1 macro bias — never counter-trend.
- Require H4 or H1 BOS/CHoCH before entry — no early entries.

Rules:
1. Only BUY in D1 BULLISH bias when price retests H4 discount zone OB/FVG.
2. Only SELL in D1 BEARISH bias when price retests H4 premium zone OB/FVG.
3. Require BOS or CHoCH on H1 or H4 before entry.
4. Never recommend a trade when confidence is below 70.
5. Recommend WAIT if bias is NEUTRAL, no H4 OB in range, or killzone inactive.
6. Always give specific numeric entry, SL, TP levels appropriate for ${sym}.
7. SL must sit below/above the H4 Order Block (not just M15) for institution-respected stops.
8. Minimum 2:1 Risk:Reward. Prefer 3:1 on H4 OB setups.
9. List at least 2 reasons AND at least 1 risk.

Respond ONLY with valid JSON — no prose, no markdown, no text outside the JSON object.`;
  }

  // ─── User prompt builder ──────────────────────────────────────────────────

  private buildPrompt(features: FeatureSet, smcSignal: SMCSignal | null): string {
    const f   = features;
    const s   = f.smc;
    const m   = f.momentum;
    const fib = f.fibonacci;
    const d1  = f.d1Trend;
    // h4 declared inline below (needs to be in scope after const h4 = f.h4Trend)
    const h1  = f.h1Trend;
    const m15 = f.m15Trend;
    const m5  = f.m5Trend;

    const h4  = f.h4Trend;

    return `Instrument: ${f.symbol}
Current Price: ${f.price}
Timestamp: ${f.timestamp}

=== SESSION CONTEXT ===
Killzone Active: ${f.inKillzone} | Session: ${f.killzoneName}
Previous Day High (PDH): ${f.pdh} | Previous Day Low (PDL): ${f.pdl} | Previous Day Close (PDC): ${f.pdc}
PDH Distance: ${(f.price - f.pdh).toFixed(2)} pts | PDL Distance: ${(f.price - f.pdl).toFixed(2)} pts

=== 5-LAYER TOP-DOWN ANALYSIS ===

[LAYER 1 — D1 Macro Bias]
Trend: ${d1.direction.toUpperCase()} | EMA20=${d1.ema20} EMA50=${d1.ema50} EMA200=${d1.ema200}
EMAs Aligned: ${d1.aligned} | EMA200 Distance: ${d1.ema200Distance} ATR

[LAYER 2 — H4 Intermediate Bias + PRIMARY ORDER BLOCKS]
Trend: ${h4.direction.toUpperCase()} | EMA20=${h4.ema20} EMA50=${h4.ema50} | Aligned: ${h4.aligned}
H4 Order Block Present: ${s.h4ObPresent}${s.h4ObPresent ? ` → ${s.h4ObLow}–${s.h4ObHigh}` : ''}
H4 FVG Present: ${s.h4FvgPresent}${s.h4FvgPresent ? ` → ${s.h4FvgLow}–${s.h4FvgHigh}` : ''}
H4 Zone: ${s.h4Zone} (${s.h4ZonePct}%)

[LAYER 3 — H1 Structural Confirmation]
Trend: ${h1.direction.toUpperCase()} | EMA20=${h1.ema20} EMA50=${h1.ema50} EMA200=${h1.ema200}
BOS: ${s.bos} | CHoCH: ${s.choch} | Last BOS Direction: ${s.lastBosDirection ?? 'none'}
Last Swing High: ${s.lastSwingHigh ?? 'n/a'} | Last Swing Low: ${s.lastSwingLow ?? 'n/a'}

[LAYER 4 — M15 Entry Zone Refinement]
Trend: ${m15.direction.toUpperCase()} | EMA20=${m15.ema20} EMA50=${m15.ema50} | Aligned: ${m15.aligned}
M15 OB: ${s.obPresent}${s.obPresent ? ` (${s.obLow}–${s.obHigh})` : ''} | M15 FVG: ${s.fvgPresent}${s.fvgPresent ? ` (${s.fvgLow}–${s.fvgHigh})` : ''}
M15 Zone: ${s.zone} (${s.zonePct}%)

[LAYER 5 — M5 Entry Trigger]
Trend: ${m5.direction.toUpperCase()} | EMA20=${m5.ema20} EMA50=${m5.ema50} | Aligned: ${m5.aligned}
Liquidity Swept: ${s.liquiditySwept}

=== MOMENTUM ===
RSI(14): ${m.rsi} (${m.rsiZone}) | Slope: ${m.rsiTrend}
Bullish Divergence: ${m.bullishDivergence} | Bearish Divergence: ${m.bearishDivergence}
ATR(14): ${m.atr}

=== FIBONACCI (M15 swing) ===
Swing High: ${fib.swingHigh} | Swing Low: ${fib.swingLow}
38.2%=${fib.level382} | 50%=${fib.level500} | 61.8%=${fib.level618}
Current Zone: ${fib.currentZone}

=== SMC ENGINE SIGNAL (5-layer) ===
${smcSignal
  ? `Direction: ${smcSignal.direction} | Confidence: ${smcSignal.confidence}% | RR: ${smcSignal.rr}\nEntry: ${smcSignal.entryPrice} | SL: ${smcSignal.sl} | TP: ${smcSignal.tp}\nReasons: ${smcSignal.reasons.join(' | ')}`
  : 'No clear SMC signal detected — recommend WAIT'
}

Provide your recommendation in this EXACT JSON format:
{
  "decision": "BUY" | "SELL" | "WAIT",
  "confidence": <number 0-100>,
  "entry": "<price or range string>",
  "stopLoss": <number>,
  "takeProfit": <number>,
  "reasons": ["<reason1>", "<reason2>"],
  "risks": ["<risk1>"]
}`;
  }

  // ─── Anthropic Claude call ────────────────────────────────────────────────

  async analyze(
    features: FeatureSet,
    smcSignal: SMCSignal | null,
  ): Promise<AIRecommendation | null> {
    if (!this.apiKey) {
      this.logger.warn('ANTHROPIC_API_KEY not set — AI reasoning disabled');
      return null;
    }

    const prompt = this.buildPrompt(features, smcSignal);

    this.logger.log(`AI: Sending analysis to ${this.model}...`);

    let raw: any;
    try {
      const resp = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model:      this.model,
          max_tokens: 1024,
          system:     this.systemPrompt,
          messages: [
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
        },
        {
          headers: {
            'x-api-key':         this.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type':      'application/json',
          },
          timeout: 30_000,
        },
      );

      // Anthropic response: content[0].text
      const content = resp.data.content?.[0]?.text ?? '';
      // Claude may wrap JSON in markdown — strip it
      const jsonStr = content.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      raw = JSON.parse(jsonStr);

      const usage = resp.data.usage ?? {};
      this.logger.log(
        `AI (Claude): ${raw.decision} | confidence=${raw.confidence} | ` +
        `tokens=${usage.input_tokens}+${usage.output_tokens}`,
      );

      // Validate
      const validated = this.validate(raw, features.price);
      if (!validated) return null;

      return {
        ...validated,
        model:            this.model,
        promptTokens:     usage.input_tokens  ?? 0,
        completionTokens: usage.output_tokens ?? 0,
      };
    } catch (e: any) {
      this.logger.error(`AI call failed: ${e?.response?.data?.error?.message ?? e.message}`);
      return null;
    }
  }

  // ─── Response validation ──────────────────────────────────────────────────

  private validate(raw: any, currentPrice: number): Omit<AIRecommendation, 'model' | 'promptTokens' | 'completionTokens'> | null {
    // Required fields
    const required = ['decision', 'confidence', 'entry', 'stopLoss', 'takeProfit', 'reasons', 'risks'];
    for (const field of required) {
      if (raw[field] === undefined || raw[field] === null) {
        this.logger.warn(`AI response missing field: ${field}`);
        return null;
      }
    }

    // Decision must be valid
    if (!['BUY', 'SELL', 'WAIT'].includes(raw.decision)) {
      this.logger.warn(`AI invalid decision: ${raw.decision}`);
      return null;
    }

    if (raw.decision === 'WAIT') {
      return {
        decision: 'WAIT', confidence: raw.confidence, entry: '',
        entryPrice: 0, stopLoss: 0, takeProfit: 0, rr: 0,
        reasons: raw.reasons ?? [], risks: raw.risks ?? [],
      };
    }

    // Numeric checks
    const sl = parseFloat(raw.stopLoss);
    const tp = parseFloat(raw.takeProfit);
    const conf = parseFloat(raw.confidence);

    if (isNaN(sl) || isNaN(tp) || isNaN(conf)) {
      this.logger.warn('AI response has non-numeric SL/TP/confidence');
      return null;
    }

    // Minimum confidence gate
    if (conf < this.minConf) {
      this.logger.log(`AI confidence ${conf}% below threshold ${this.minConf}% — skip`);
      return null;
    }

    // SL/TP direction sanity
    if (raw.decision === 'BUY' && sl >= currentPrice) {
      this.logger.warn(`AI BUY: SL (${sl}) must be below entry (${currentPrice})`);
      return null;
    }
    if (raw.decision === 'SELL' && sl <= currentPrice) {
      this.logger.warn(`AI SELL: SL (${sl}) must be above entry (${currentPrice})`);
      return null;
    }

    // Parse entry midpoint
    const entryStr = String(raw.entry);
    let entryPrice: number;
    if (entryStr.includes('-')) {
      const parts = entryStr.split('-').map(parseFloat);
      entryPrice = (parts[0] + parts[1]) / 2;
    } else {
      entryPrice = parseFloat(entryStr) || currentPrice;
    }

    // RR calculation
    const risk   = Math.abs(entryPrice - sl);
    const reward = Math.abs(tp - entryPrice);
    const rr     = risk > 0 ? +(reward / risk).toFixed(2) : 0;

    if (rr < 2) {
      this.logger.warn(`AI RR ${rr} is below minimum 2:1`);
      return null;
    }

    // Minimum 1 reason + 1 risk
    if (!Array.isArray(raw.reasons) || raw.reasons.length < 1) {
      this.logger.warn('AI response missing reasons');
      return null;
    }
    if (!Array.isArray(raw.risks) || raw.risks.length < 1) {
      this.logger.warn('AI response missing risks');
      return null;
    }

    return {
      decision:   raw.decision,
      confidence: conf,
      entry:      entryStr,
      entryPrice: +entryPrice.toFixed(2),
      stopLoss:   sl,
      takeProfit: tp,
      rr,
      reasons:    raw.reasons,
      risks:      raw.risks,
    };
  }
}
