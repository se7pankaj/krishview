/**
 * analysis/ai-reasoning.service.ts — Claude Sonnet AI Reasoning Layer
 * =====================================================================
 * Receives a structured FeatureSet, builds a tight system + user prompt,
 * calls Anthropic Claude Sonnet 4.6, validates the JSON response, and
 * returns a typed AIRecommendation.
 *
 * Design principle: we never say "analyse this chart image".
 * We feed structured FACTS so Claude reasons over data, not pixels.
 *
 * Mode awareness: the system prompt, layer labels, RR minimum, and confidence
 * threshold all adapt per trading mode (Institutional / Precision / Quick Scalp).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { FeatureSet } from './feature-engine.service';
import { SMCSignal } from '../smc/smc.service';
import { ActiveSymbolService } from '../trading/active-symbol.service';
import { ModeConfig } from '../config/app-config.service';
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

// ─── Mode-specific prompt config ──────────────────────────────────────────────

interface ModePromptConfig {
  /** Human-readable framework string for the system prompt */
  frameworkDesc: string;
  /** Layer labels used in buildPrompt() — index 0=D1(macro), 1=L2, 2=L3, 3=L4, 4=L5 */
  layers: [string, string, string, string, string];
  /** Which TF holds the primary OBs (H4 for Institutional, M30 for Quick Scalp) */
  obLayer: string;
  /** Which TF confirms BOS/CHoCH */
  bosLayer: string;
  /** Session note for system prompt */
  sessionNote: string;
  /** Minimum RR for validate() */
  minRR: number;
  /** Minimum AI confidence for validate() — uses mode.minConfidence */
  minConf: number;
  /** Confidence floor note for rules section */
  confNote: string;
  /** RR rule note */
  rrNote: string;
  /** SL placement rule */
  slNote: string;
}

function getModePromptConfig(mode?: ModeConfig): ModePromptConfig {
  // ── Quick Scalp ────────────────────────────────────────────────────────────
  if (mode?.htfTf === 'H1') {
    return {
      frameworkDesc: 'D1 (macro anchor) → M30 → M15 → M5 → M1',
      layers: ['D1', 'M30', 'M15', 'M5', 'M1'],
      obLayer:     'M30',
      bosLayer:    'M15 or M30',
      sessionNote: 'All weekday hours are valid — no session restriction. Asian, London, and NY sessions all produce valid setups.',
      minRR:       1.5,
      minConf:     mode.minConfidence,
      confNote:    `Never recommend a trade when confidence is below ${mode.minConfidence}.`,
      rrNote:      'Minimum 1.5:1 Risk:Reward. 2:1 preferred where the M30 OB range allows.',
      slNote:      'SL must sit below/above the M30 Order Block or the M15 swing high/low — tight but respected.',
    };
  }

  // ── Precision Scalp ────────────────────────────────────────────────────────
  if (mode?.htfTf === 'H4') {
    return {
      frameworkDesc: 'D1 (macro anchor) → H4 → H1 → M15 → M5 → M1',
      layers: ['D1', 'H4', 'H1', 'M15', 'M1'],
      obLayer:     'H4',
      bosLayer:    'H1 or H4',
      sessionNote: 'Extended hours 06:00–20:00 UTC weekdays. London, London-NY overlap, and NY afternoon are all valid.',
      minRR:       2.0,
      minConf:     mode.minConfidence,
      confNote:    `Never recommend a trade when confidence is below ${mode.minConfidence}.`,
      rrNote:      'Minimum 2:1 Risk:Reward.',
      slNote:      'SL must sit below/above the H4 Order Block.',
    };
  }

  // ── Institutional (default) ───────────────────────────────────────────────
  const minConf = mode?.minConfidence ?? 70;
  return {
    frameworkDesc: 'D1 → H4 → H1 → M15 → M5',
    layers: ['D1', 'H4', 'H1', 'M15', 'M5'],
    obLayer:     'H4',
    bosLayer:    'H1 or H4',
    sessionNote: 'London (07:00–10:00 UTC) and New York (13:00–16:00 UTC) killzones only.',
    minRR:       2.0,
    minConf,
    confNote:    `Never recommend a trade when confidence is below ${minConf}.`,
    rrNote:      'Minimum 2:1 Risk:Reward. Prefer 3:1 on H4 OB setups.',
    slNote:      'SL must sit below/above the H4 Order Block (not just M15) for institution-respected stops.',
  };
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

  // ─── Mode-aware system prompt ──────────────────────────────────────────────

  private buildSystemPrompt(mpc: ModePromptConfig): string {
    const symCfg  = this.activeSymbol.getConfig();
    const sym     = this.activeSymbol.getSymbol();
    const label   = symCfg?.label       ?? sym;
    const desc    = symCfg?.description ?? 'institutional price action';
    const cat     = symCfg?.category    ?? 'forex';

    const sessionLines = symCfg?.sessions
      .map(s => `- ${s.name} (${s.startUtc}:00–${s.endUtc}:00 UTC = ${sessionToUae(s)})`)
      .join('\n') ?? '- London (07–10 UTC)\n- New York (13–17 UTC)';

    const expertise = cat === 'metals'      ? 'precious metals (gold/silver) SMC trader'
                    : cat === 'indices'     ? 'US equity index SMC trader'
                    : cat === 'commodities' ? 'energy commodities (oil) SMC trader'
                    : cat === 'crypto'      ? 'cryptocurrency (Bitcoin) SMC trader'
                    : 'institutional forex SMC trader';

    const [l1, l2, l3, l4, l5] = mpc.layers;

    return `You are an elite institutional ${expertise} with 20+ years experience.
You are currently analysing ${label} (${sym}). ${desc}.
You specialise in Smart Money Concepts (SMC) with a ${mpc.frameworkDesc} framework:
  ${l1}  → Macro bias — D1 EMA200 is the absolute directional boundary (never trade against it)
  ${l2}  → Primary entry zones — ${mpc.obLayer} Order Blocks and FVGs (the smart-money layer)
  ${l3}  → Structural confirmation — BOS / CHoCH required before entry
  ${l4}  → Entry zone refinement — OB / FVG within the ${mpc.obLayer} zone
  ${l5}  → Precise trigger — liquidity sweep + Market Structure Shift (MSS)

Key principles:
- D1 EMA200 is a hard boundary — NEVER trade counter to it regardless of mode.
- ${mpc.obLayer} Order Blocks and FVGs are the PRIMARY entry zones for this mode.
- Previous Day High (PDH) and Previous Day Low (PDL) are key intraday reference levels.
- Active symbol sessions for ${sym}:
${sessionLines}
- ${mpc.sessionNote}
- Only trade WITH the D1 macro bias — the ${l1} layer establishes this.
- Require BOS or CHoCH on ${mpc.bosLayer} before entry — no early entries.

Rules:
1. Only BUY in D1 BULLISH bias when price retests ${mpc.obLayer} discount zone OB/FVG.
2. Only SELL in D1 BEARISH bias when price retests ${mpc.obLayer} premium zone OB/FVG.
3. Require BOS or CHoCH on ${mpc.bosLayer} before entry.
4. ${mpc.confNote}
5. Recommend WAIT if: D1 EMA200 blocks the direction, no ${mpc.obLayer} OB in range, ${mpc.bosLayer} has no structure break, or the session is inactive for this mode.
6. Always give specific numeric entry, SL, and TP levels appropriate for ${sym}.
7. ${mpc.slNote}
8. ${mpc.rrNote}
9. List at least 2 reasons AND at least 1 risk.

Respond ONLY with valid JSON — no prose, no markdown, no text outside the JSON object.`;
  }

  // ─── Mode-aware user prompt ────────────────────────────────────────────────

  private buildPrompt(features: FeatureSet, smcSignal: SMCSignal | null, mpc: ModePromptConfig): string {
    const f   = features;
    const s   = f.smc;
    const m   = f.momentum;
    const fib = f.fibonacci;
    const d1  = f.d1Trend;
    const h4  = f.h4Trend;
    const h1  = f.h1Trend;
    const m15 = f.m15Trend;
    const m5  = f.m5Trend;

    const [l1, l2, l3, l4, l5] = mpc.layers;

    return `Instrument: ${f.symbol}
Current Price: ${f.price}
Timestamp: ${f.timestamp}
Trading Mode: ${mpc.frameworkDesc}

=== SESSION CONTEXT ===
Session Active: ${f.inKillzone} | Current Session: ${f.killzoneName}
Previous Day High (PDH): ${f.pdh} | Previous Day Low (PDL): ${f.pdl} | Previous Day Close (PDC): ${f.pdc}
PDH Distance: ${(f.price - f.pdh).toFixed(2)} pts | PDL Distance: ${(f.price - f.pdl).toFixed(2)} pts

=== 5-LAYER TOP-DOWN ANALYSIS ===

[LAYER 1 — ${l1} Macro Bias (D1 EMA200 Hard Boundary)]
Trend: ${d1.direction.toUpperCase()} | EMA20=${d1.ema20} EMA50=${d1.ema50} EMA200=${d1.ema200}
EMAs Aligned: ${d1.aligned} | EMA200 Distance: ${d1.ema200Distance} ATR
NOTE: This is always real D1 data regardless of trading mode — the macro anchor.

[LAYER 2 — ${l2} Intermediate Bias + PRIMARY ORDER BLOCKS]
Trend: ${h4.direction.toUpperCase()} | EMA20=${h4.ema20} EMA50=${h4.ema50} | Aligned: ${h4.aligned}
${l2} Order Block Present: ${s.h4ObPresent}${s.h4ObPresent ? ` → ${s.h4ObLow}–${s.h4ObHigh}` : ''}
${l2} FVG Present: ${s.h4FvgPresent}${s.h4FvgPresent ? ` → ${s.h4FvgLow}–${s.h4FvgHigh}` : ''}
${l2} Zone: ${s.h4Zone} (${s.h4ZonePct}%)

[LAYER 3 — ${l3} Structural Confirmation]
Trend: ${h1.direction.toUpperCase()} | EMA20=${h1.ema20} EMA50=${h1.ema50} EMA200=${h1.ema200}
BOS: ${s.bos} | CHoCH: ${s.choch} | Last BOS Direction: ${s.lastBosDirection ?? 'none'}
Last Swing High: ${s.lastSwingHigh ?? 'n/a'} | Last Swing Low: ${s.lastSwingLow ?? 'n/a'}

[LAYER 4 — ${l4} Entry Zone Refinement]
Trend: ${m15.direction.toUpperCase()} | EMA20=${m15.ema20} EMA50=${m15.ema50} | Aligned: ${m15.aligned}
${l4} OB: ${s.obPresent}${s.obPresent ? ` (${s.obLow}–${s.obHigh})` : ''} | ${l4} FVG: ${s.fvgPresent}${s.fvgPresent ? ` (${s.fvgLow}–${s.fvgHigh})` : ''}
${l4} Zone: ${s.zone} (${s.zonePct}%)

[LAYER 5 — ${l5} Entry Trigger]
Trend: ${m5.direction.toUpperCase()} | EMA20=${m5.ema20} EMA50=${m5.ema50} | Aligned: ${m5.aligned}
Liquidity Swept: ${s.liquiditySwept}

=== MOMENTUM ===
RSI(14): ${m.rsi} (${m.rsiZone}) | Slope: ${m.rsiTrend}
Bullish Divergence: ${m.bullishDivergence} | Bearish Divergence: ${m.bearishDivergence}
ATR(14): ${m.atr}

=== FIBONACCI (${l4} swing) ===
Swing High: ${fib.swingHigh} | Swing Low: ${fib.swingLow}
38.2%=${fib.level382} | 50%=${fib.level500} | 61.8%=${fib.level618}
Current Zone: ${fib.currentZone}

=== SMC ENGINE SIGNAL (${mpc.frameworkDesc}) ===
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

  // ─── Main entry point ──────────────────────────────────────────────────────

  async analyze(
    features: FeatureSet,
    smcSignal: SMCSignal | null,
    mode?: ModeConfig,
  ): Promise<AIRecommendation | null> {
    if (!this.apiKey) {
      // Explicit disabled state — caller decides whether to block or allow SMC fallback.
      // We throw so analysis.service.ts can log AI_ERROR and block the signal.
      throw new Error('ANTHROPIC_API_KEY not configured — AI analysis unavailable');
    }

    const mpc    = getModePromptConfig(mode);
    const system = this.buildSystemPrompt(mpc);
    const prompt = this.buildPrompt(features, smcSignal, mpc);

    this.logger.log(`AI: Sending ${mode?.label ?? 'Institutional'} analysis to ${this.model}...`);

    // NOTE: No try/catch here — any network error, timeout, credit exhaustion,
    // or JSON parse failure throws and propagates to analysis.service.ts, which
    // blocks the signal with AI_ERROR status. We never silently fall back to
    // SMC-only when the AI layer is expected but unavailable.
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      this.model,
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: prompt }],
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
    // JSON.parse throws on malformed response — propagates to caller as AI_ERROR
    const raw = JSON.parse(jsonStr);

    const usage = resp.data.usage ?? {};
    this.logger.log(
      `AI (Claude/${mode?.label ?? 'Institutional'}): ${raw.decision} | confidence=${raw.confidence} | ` +
      `tokens=${usage.input_tokens}+${usage.output_tokens}`,
    );

    // validate() returns null when AI's own decision fails quality checks
    // (confidence too low for this mode, SL wrong side, RR below mode minimum).
    // null here is a deliberate "no trade" outcome — not an error.
    const validated = this.validate(raw, features.price, mpc);
    if (!validated) return null;

    return {
      ...validated,
      model:            this.model,
      promptTokens:     usage.input_tokens  ?? 0,
      completionTokens: usage.output_tokens ?? 0,
    };
  }

  // ─── Response validation ──────────────────────────────────────────────────

  private validate(
    raw: any,
    currentPrice: number,
    mpc: ModePromptConfig,
  ): Omit<AIRecommendation, 'model' | 'promptTokens' | 'completionTokens'> | null {
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
    const sl   = parseFloat(raw.stopLoss);
    const tp   = parseFloat(raw.takeProfit);
    const conf = parseFloat(raw.confidence);

    if (isNaN(sl) || isNaN(tp) || isNaN(conf)) {
      this.logger.warn('AI response has non-numeric SL/TP/confidence');
      return null;
    }

    // Mode-aware minimum confidence gate
    // (uses the mode's minConfidence so Quick Scalp 58% signals are not rejected)
    if (conf < mpc.minConf) {
      this.logger.log(`AI confidence ${conf}% below mode threshold ${mpc.minConf}% — deliberate WAIT`);
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

    // Mode-aware minimum RR (1.5 for Quick Scalp, 2.0 for Institutional/Precision)
    if (rr < mpc.minRR) {
      this.logger.warn(`AI RR ${rr} is below mode minimum ${mpc.minRR}:1 — deliberate WAIT`);
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
