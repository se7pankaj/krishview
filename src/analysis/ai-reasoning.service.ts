/**
 * analysis/ai-reasoning.service.ts — GPT-4o AI Reasoning Layer
 * =============================================================
 * Receives a structured FeatureSet, builds a tight system + user prompt,
 * calls OpenAI GPT-4o, validates the JSON response, and returns a
 * typed AIRecommendation.
 *
 * Design principle: we never say "analyse this chart image".
 * We feed structured FACTS so GPT reasons over data, not pixels.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { FeatureSet } from './feature-engine.service';
import { SMCSignal } from '../smc/smc.service';

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

  constructor(private readonly config: ConfigService) {}

  private get apiKey():    string { return this.config.get<string>('OPENAI_API_KEY', ''); }
  private get model():     string { return this.config.get<string>('OPENAI_MODEL', 'gpt-4o'); }
  private get minConf():   number { return parseFloat(this.config.get<string>('AI_MIN_CONFIDENCE', '70')); }

  // ─── System prompt ────────────────────────────────────────────────────────

  private readonly SYSTEM_PROMPT = `You are an institutional gold trader with 20 years of experience.
You specialise in XAUUSD using Smart Money Concepts (SMC), multi-timeframe analysis, and strict risk management.

You will receive structured market features — computed facts, not chart images.
Your job is to reason over these facts and produce a precise trading recommendation.

Rules you must follow:
1. Only recommend BUY when price is in a discount zone (below 50% of current range).
2. Only recommend SELL when price is in a premium zone (above 50% of current range).
3. Require Break of Structure (BOS) confirmation before recommending a directional trade.
4. Never recommend a trade when confidence is below 70.
5. Recommend WAIT if conditions are ambiguous, conflicting, or news risk is high.
6. Always provide specific numeric entry, stop loss, and take profit levels.
7. Minimum Risk:Reward ratio of 2:1. Reject setups below this.
8. List at least 2 reasons AND at least 1 risk in every response.

Respond ONLY with a valid JSON object — no prose, no markdown, no explanation outside the JSON.`;

  // ─── User prompt builder ──────────────────────────────────────────────────

  private buildPrompt(features: FeatureSet, smcSignal: SMCSignal | null): string {
    const f   = features;
    const s   = f.smc;
    const m   = f.momentum;
    const fib = f.fibonacci;
    const d1  = f.d1Trend;
    const h1  = f.h1Trend;
    const m15 = f.m15Trend;
    const m5  = f.m5Trend;

    return `Instrument: ${f.symbol}
Current Price: ${f.price}
Timestamp: ${f.timestamp}

=== 4-LAYER TOP-DOWN ANALYSIS ===
[D1  — Direction / Macro Bias]
Trend: ${d1.direction.toUpperCase()} | EMA20=${d1.ema20} EMA50=${d1.ema50} EMA200=${d1.ema200} | Aligned=${d1.aligned} | EMA200 Dist=${d1.ema200Distance} ATR

[H1  — Structural Confirmation (PRIORITY)]
Trend: ${h1.direction.toUpperCase()} | EMA20=${h1.ema20} EMA50=${h1.ema50} EMA200=${h1.ema200} | Aligned=${h1.aligned}
BOS Confirmed: ${s.bos} | CHoCH: ${s.choch} | Last BOS Direction: ${s.lastBosDirection ?? 'none'}
Last Swing High: ${s.lastSwingHigh ?? 'n/a'} | Last Swing Low: ${s.lastSwingLow ?? 'n/a'}

[M15 — Setup Confirmation]
Trend: ${m15.direction.toUpperCase()} | EMA20=${m15.ema20} EMA50=${m15.ema50} | Aligned=${m15.aligned}
Order Block: ${s.obPresent}${s.obPresent ? ` (${s.obLow}–${s.obHigh})` : ''} | FVG: ${s.fvgPresent}${s.fvgPresent ? ` (${s.fvgLow}–${s.fvgHigh})` : ''}
Premium/Discount Zone: ${s.zone} (${s.zonePct}%)

[M5  — Entry Trigger]
Trend: ${m5.direction.toUpperCase()} | EMA20=${m5.ema20} EMA50=${m5.ema50} | Aligned=${m5.aligned}
Liquidity Swept: ${s.liquiditySwept}

=== MOMENTUM (H1) ===
RSI(14): ${m.rsi} (${m.rsiZone}) | Slope: ${m.rsiTrend}
Bullish Divergence: ${m.bullishDivergence} | Bearish Divergence: ${m.bearishDivergence}
ATR(14): ${m.atr}

=== FIBONACCI RETRACEMENT (M15 swing) ===
Swing High: ${fib.swingHigh} | Swing Low: ${fib.swingLow}
38.2%=${fib.level382} | 50%=${fib.level500} | 61.8%=${fib.level618}
Current Zone: ${fib.currentZone}

=== SMC ENGINE SIGNAL ===
${smcSignal
  ? `Direction: ${smcSignal.direction} | Confidence: ${smcSignal.confidence}% | RR: ${smcSignal.rr}\nEntry: ${smcSignal.entryPrice} | SL: ${smcSignal.sl} | TP: ${smcSignal.tp}\nReasons: ${smcSignal.reasons.join(', ')}`
  : 'No clear SMC signal detected'
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

  // ─── OpenAI call ──────────────────────────────────────────────────────────

  async analyze(
    features: FeatureSet,
    smcSignal: SMCSignal | null,
  ): Promise<AIRecommendation | null> {
    if (!this.apiKey) {
      this.logger.warn('OPENAI_API_KEY not set — AI reasoning disabled');
      return null;
    }

    const prompt = this.buildPrompt(features, smcSignal);

    this.logger.log(`AI: Sending analysis to ${this.model}...`);

    let raw: any;
    try {
      const resp = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: this.model,
          messages: [
            { role: 'system', content: this.SYSTEM_PROMPT },
            { role: 'user',   content: prompt },
          ],
          temperature: 0.2,      // low temp = more consistent structured output
          max_tokens:  800,
          response_format: { type: 'json_object' },
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30_000,
        },
      );

      const content = resp.data.choices[0].message.content;
      raw = JSON.parse(content);

      const usage = resp.data.usage ?? {};
      this.logger.log(
        `AI: ${raw.decision} | confidence=${raw.confidence} | ` +
        `tokens=${usage.prompt_tokens}+${usage.completion_tokens}`,
      );

      // Validate
      const validated = this.validate(raw, features.price);
      if (!validated) return null;

      return {
        ...validated,
        model:            this.model,
        promptTokens:     usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
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
