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
  // Data-flow note: Precision's htfTf='H4' candles are passed as d1Candles to
  // analysis.run() and overridden by macroCandles (real D1) for the EMA200 anchor.
  // The feature-engine's "h4 slot" holds H1 candles (mode.h4Tf='H1');
  // the "h1 slot" holds M15 candles (mode.confirmTf='M15').
  // Layers here reflect what the feature-engine ACTUALLY computed, not the TF names.
  if (mode?.htfTf === 'H4') {
    return {
      frameworkDesc: 'H4 direction + D1 (macro anchor) → H1 → M15 → M5 → M1',
      layers: ['D1', 'H1', 'M15', 'M5', 'M1'],
      obLayer:     'H1',
      bosLayer:    'M15',
      sessionNote: 'Extended hours 06:00–20:00 UTC weekdays. H4 provides directional bias (shown in SMC signal); H1 Order Blocks are the primary entry zones for this mode.',
      minRR:       2.0,
      minConf:     mode.minConfidence,
      confNote:    `Never recommend a trade when confidence is below ${mode.minConfidence}.`,
      rrNote:      'Minimum 2:1 Risk:Reward.',
      slNote:      'SL must sit below/above the H1 Order Block (the primary money layer for Precision mode).',
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

    return `You are an elite institutional ${expertise} with 20+ years experience in SMC/ICT methodology.
You are analysing ${label} (${sym}). ${desc}.
Your framework: ${mpc.frameworkDesc}

LAYER HIERARCHY:
  ${l1}  → Macro bias anchor — D1 EMA200 is the ABSOLUTE directional boundary. Never trade counter to it.
  ${l2}  → Smart-money layer — ${mpc.obLayer} Order Blocks and FVGs are the PRIMARY entry zones.
  ${l3}  → Structural confirmation — BOS (break of structure) or CHoCH (change of character) REQUIRED.
  ${l4}  → Entry refinement — OB/FVG within the ${mpc.obLayer} zone, confluence with Fibonacci levels.
  ${l5}  → Entry trigger — liquidity sweep (stop hunt) followed by Market Structure Shift (MSS).

SMC PRINCIPLES YOU MUST APPLY:
1. D1 EMA200 = absolute boundary. Price above it → institutional bias is BULLISH (only longs).
   Price below it → institutional bias is BEARISH (only shorts). No exceptions.
2. ${mpc.obLayer} OBs and FVGs are where smart money (banks, HFTs, central banks) have live orders.
   Price returning to an unmitigated OB in the correct direction is the highest-probability entry.
3. PDH and PDL are key institutional reference levels — watch for sweeps and reactions at these levels.
4. Liquidity sweeps at obvious highs/lows (equal highs, equal lows, swing points) precede the real move.
   The sweep hunts retail stop losses, then institutional orders fill on the reversal.
5. Equilibrium (50% of recent swing) is a valid entry for trending markets, not just premium/discount extremes.

ACTIVE SESSIONS FOR ${sym}:
${sessionLines}
${mpc.sessionNote}

RULES — non-negotiable:
R1. BUY only with D1 BULLISH bias AND price in ${l2} discount/equilibrium zone.
R2. SELL only with D1 BEARISH bias AND price in ${l2} premium/equilibrium zone.
R3. Require BOS or CHoCH on ${mpc.bosLayer} — no early entries before structure confirms.
R4. ${mpc.confNote}
R5. ${mpc.slNote}
R6. ${mpc.rrNote}
R7. WAIT if: D1 EMA200 conflicts, no ${mpc.obLayer} OB/FVG in range, no ${mpc.bosLayer} structure break,
    RSI is over-extended (>75 BUY / <25 SELL), or setup convergence across layers is weak.
R8. Provide AT LEAST 2 specific reasons and AT LEAST 1 concrete risk (not generic disclaimers).
R9. Entry, SL, and TP must be PRECISE numeric levels relevant to the current ${sym} price range.

RESPONSE FORMAT — respond ONLY with this JSON. No prose, no markdown, no text outside the JSON:
{
  "decision": "BUY" | "SELL" | "WAIT",
  "confidence": <number 0-100>,
  "entry": "<price or range string e.g. 3310-3315>",
  "stopLoss": <number>,
  "takeProfit": <number>,
  "reasons": ["<reason1>", "<reason2>"],
  "risks": ["<risk1>"]
}`;
  }

  // ─── Mode-aware user prompt (Sonnet 4.6 optimised) ───────────────────────

  private buildPrompt(
    features:               FeatureSet,
    smcSignal:              SMCSignal | null,
    mpc:                    ModePromptConfig,
    confluenceBoostReasons?: string[],
  ): string {
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

    // ── Market regime classification ─────────────────────────────────────────
    const isD1Trending = d1.aligned;
    const isMidTrending = h4.aligned && h1.aligned;
    const regime =
      isD1Trending && isMidTrending ? 'STRONG TREND'   :
      isD1Trending                  ? 'TREND (D1 confirmed, mid-TF choppy)' :
      isMidTrending                 ? 'DEVELOPING TREND (D1 neutral)'       :
      'RANGING / CHOPPY';

    // ── Layer convergence scoring ────────────────────────────────────────────
    // How many of the 5 layers are aligned with the SMC signal direction?
    const dir = smcSignal?.direction;
    let convergence = 0;
    if (dir) {
      const isBull = dir === 'BUY';
      if (isBull ? d1.direction === 'bullish' : d1.direction === 'bearish')   convergence++;
      if (isBull ? h4.direction === 'bullish' : h4.direction === 'bearish')   convergence++;
      if (isBull ? h1.direction === 'bullish' : h1.direction === 'bearish')   convergence++;
      if (isBull ? m15.direction === 'bullish' : m15.direction === 'bearish') convergence++;
      if (isBull ? m5.direction === 'bullish' : m5.direction === 'bearish')   convergence++;
    }

    // ── EMA200 macro verdict ─────────────────────────────────────────────────
    const ema200Side = f.price > d1.ema200 ? 'ABOVE' : 'BELOW';
    const ema200Verdict = ema200Side === 'ABOVE'
      ? '✅ BULLISH bias — longs preferred'
      : '✅ BEARISH bias — shorts preferred';

    // ── Distance to key levels ───────────────────────────────────────────────
    const pdhDist = (f.price - f.pdh).toFixed(2);
    const pdlDist = (f.price - f.pdl).toFixed(2);

    // ── SMC OB/FVG context ───────────────────────────────────────────────────
    const obCtx = s.h4ObPresent
      ? `${l2} OB at ${s.h4ObLow}–${s.h4ObHigh} (mid: ${(((s.h4ObLow??0)+(s.h4ObHigh??0))/2).toFixed(2)})`
      : `No ${l2} OB in range`;
    const fvgCtx = s.h4FvgPresent
      ? `${l2} FVG at ${s.h4FvgLow}–${s.h4FvgHigh}`
      : `No ${l2} FVG in range`;
    const m15ObCtx  = s.obPresent  ? `${l4} OB ${s.obLow}–${s.obHigh}`  : `No ${l4} OB`;
    const m15FvgCtx = s.fvgPresent ? `${l4} FVG ${s.fvgLow}–${s.fvgHigh}` : `No ${l4} FVG`;

    // ── Confluence boosts summary ─────────────────────────────────────────────
    const confLines = confluenceBoostReasons && confluenceBoostReasons.length > 0
      ? confluenceBoostReasons.map(r => `  + ${r}`).join('\n')
      : '  (no additional confluence factors)';

    return `=== MARKET ANALYSIS REQUEST: ${f.symbol} ===
Timestamp: ${f.timestamp}
Current Price: ${f.price}
Trading Framework: ${mpc.frameworkDesc}
Market Regime: ${regime}
Layer Convergence: ${convergence}/5 layers aligned with ${dir ?? 'signal'} direction

━━━ SESSION & KEY LEVELS ━━━
Active Session: ${f.inKillzone ? '✅ YES' : '❌ NO'} | Session: ${f.killzoneName}
PDH: ${f.pdh} (price is ${Number(pdhDist) >= 0 ? '+' : ''}${pdhDist} from PDH)
PDL: ${f.pdl} (price is ${Number(pdlDist) >= 0 ? '+' : ''}${pdlDist} from PDL)
PDC: ${f.pdc}

━━━ LAYER 1 — ${l1} MACRO BIAS (D1 EMA200 = hard boundary) ━━━
Price ${f.price} is ${ema200Side} D1 EMA200 ${d1.ema200} → ${ema200Verdict}
D1 EMA: 20=${d1.ema20} | 50=${d1.ema50} | 200=${d1.ema200}
D1 Stack Aligned: ${d1.aligned} | D1 Direction: ${d1.direction.toUpperCase()}
EMA200 Distance: ${d1.ema200Distance} ATR (> 3 ATR = overextended, expect reversion)

━━━ LAYER 2 — ${l2} PRIMARY ORDER BLOCKS (smart-money layer) ━━━
${obCtx}
${fvgCtx}
${l2} Zone: ${s.h4Zone.toUpperCase()} (${s.h4ZonePct}% of recent swing)
  → PREMIUM (>55%) = ideal SELL zone | DISCOUNT (<45%) = ideal BUY zone | EQUILIBRIUM = fair value
${l2} EMA: 20=${h4.ema20} | 50=${h4.ema50} | Direction: ${h4.direction.toUpperCase()}

━━━ LAYER 3 — ${l3} STRUCTURAL CONFIRMATION ━━━
BOS (Break of Structure): ${s.bos ? '✅ YES — trend continuation confirmed' : '❌ NO'}
CHoCH (Change of Character): ${s.choch ? '✅ YES — potential reversal forming' : '❌ NO'}
Last BOS Direction: ${s.lastBosDirection ?? 'none'}
Last Swing High: ${s.lastSwingHigh ?? 'n/a'} | Last Swing Low: ${s.lastSwingLow ?? 'n/a'}
${l3} EMA: 20=${h1.ema20} | 50=${h1.ema50} | 200=${h1.ema200} | Direction: ${h1.direction.toUpperCase()}

━━━ LAYER 4 — ${l4} ENTRY REFINEMENT ━━━
${m15ObCtx}
${m15FvgCtx}
${l4} Zone: ${s.zone.toUpperCase()} (${s.zonePct}%)
${l4} EMA: 20=${m15.ema20} | 50=${m15.ema50} | Direction: ${m15.direction.toUpperCase()}
Fibonacci (${l4} swing): High=${fib.swingHigh} | Low=${fib.swingLow}
  38.2%=${fib.level382} | 50.0%=${fib.level500} | 61.8%=${fib.level618}
  Current zone: ${fib.currentZone}

━━━ LAYER 5 — ${l5} ENTRY TRIGGER ━━━
Liquidity Swept: ${s.liquiditySwept ? '✅ YES — stop hunt detected, smart money accumulating/distributing' : '❌ NO — no sweep yet'}
${l5} EMA: 20=${m5.ema20} | 50=${m5.ema50} | Direction: ${m5.direction.toUpperCase()}

━━━ MOMENTUM (RSI + Divergence) ━━━
RSI(14): ${m.rsi.toFixed(1)} [${m.rsiZone.toUpperCase()}] | Slope: ${m.rsiTrend.toUpperCase()}
Bullish Divergence: ${m.bullishDivergence ? '✅ YES (price lower-low + RSI higher-low = smart money absorbing)' : 'no'}
Bearish Divergence: ${m.bearishDivergence ? '✅ YES (price higher-high + RSI lower-high = smart money distributing)' : 'no'}
ATR(14): ${m.atr} (use for SL sizing)

━━━ CONFLUENCE FILTERS (pre-applied) ━━━
${confLines}

━━━ SMC ENGINE SIGNAL ━━━
${smcSignal
  ? [
      `Direction: ${smcSignal.direction} | Pre-AI Confidence: ${smcSignal.confidence}%`,
      `Proposed Entry: ${smcSignal.entryPrice} | SL: ${smcSignal.sl} | TP: ${smcSignal.tp} | RR: ${smcSignal.rr}:1`,
      `SMC reasons: ${smcSignal.reasons.join(' | ')}`,
    ].join('\n')
  : '⚠️  No SMC signal — algorithmic analysis found no valid setup. Evaluate if AI sees anything missed.'
}

━━━ YOUR TASK ━━━
Step 1 — ASSESS convergence: Do all 5 layers point the same direction as the SMC signal?
  Are the key gates met: D1 EMA200 ✅, ${l2} OB/FVG in range ✅, ${l3} BOS/CHoCH ✅, liquidity sweep ✅?

Step 2 — CHALLENGE the setup: What could invalidate this trade?
  Is RSI overextended? Is price chopping between levels? Is this against PDH/PDL?
  Has the ${l2} OB already been mitigated (price moved through it significantly)?

Step 3 — DECIDE with your full institutional knowledge:
  If ≥ 3/5 layers converge AND D1 EMA200 confirms AND a ${l2} OB/FVG is in range → consider entering.
  If convergence is weak (< 3/5), or D1 macro conflicts, or no ${l2} zone present → WAIT.

Step 4 — SET LEVELS precisely:
  Entry: around current price or the OB mid-point (specify a 2-5 pt range for limit orders).
  SL: ${mpc.slNote}
  TP: Aim for the opposite premium/discount zone, next structural high/low, or PDH/PDL. ${mpc.rrNote}

Respond ONLY with JSON — no reasoning text, no markdown outside JSON:`;
  }

  // ─── Main entry point ──────────────────────────────────────────────────────

  async analyze(
    features:  FeatureSet,
    smcSignal: SMCSignal | null,
    mode?:     ModeConfig,
    confluenceBoostReasons?: string[],  // passed from analysis.service.ts for AI context
  ): Promise<AIRecommendation | null> {
    if (!this.apiKey) {
      // Explicit disabled state — caller decides whether to block or allow SMC fallback.
      // We throw so analysis.service.ts can log AI_ERROR and block the signal.
      throw new Error('ANTHROPIC_API_KEY not configured — AI analysis unavailable');
    }

    const mpc    = getModePromptConfig(mode);
    const system = this.buildSystemPrompt(mpc);
    const prompt = this.buildPrompt(features, smcSignal, mpc, confluenceBoostReasons);

    this.logger.log(`AI: Sending ${mode?.label ?? 'Institutional'} analysis to ${this.model}...`);

    // NOTE: No try/catch here — any network error, timeout, credit exhaustion,
    // or JSON parse failure throws and propagates to analysis.service.ts, which
    // blocks the signal with AI_ERROR status. We never silently fall back to
    // SMC-only when the AI layer is expected but unavailable.
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      this.model,
        max_tokens: 1500,  // increased — richer prompt + chain-of-thought output
        system,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.15, // lower = more consistent financial decisions
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
