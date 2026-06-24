/**
 * news/news.service.ts — Forex Factory News Engine
 * ==================================================
 * Fetches the full weekly economic calendar from Forex Factory's
 * free JSON endpoint. Shows ALL impact levels on dashboard (High/Medium/Low).
 * Trade blocking only applies to High-impact USD/XAU events.
 *
 * No API key required. Cache refreshes once per hour.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NewsEvent {
  title:       string;
  country:     string;
  date:        string;          // ISO string
  impact:      'High' | 'Medium' | 'Low' | 'Holiday';
  forecast:    string;
  previous:    string;
  actual:      string;          // populated after event fires
  minutesTill: number;          // negative = in the past
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);

  // Raw cache (all events, all impacts, all currencies)
  private rawCache:    any[]  = [];
  private cacheExpiry = 0;

  /** FF free JSON — publishes this-week's calendar. No auth needed. */
  private readonly FF_URL =
    'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

  /** Currencies relevant to XAUUSD for trade-blocking */
  private readonly BLOCK_COUNTRIES = ['USD', 'XAU', 'US'];

  constructor(private readonly config: ConfigService) {}

  private get blockBefore(): number {
    return parseInt(this.config.get('NEWS_BLOCK_BEFORE_MIN', '30'), 10);
  }
  private get blockAfter(): number {
    return parseInt(this.config.get('NEWS_BLOCK_AFTER_MIN', '30'), 10);
  }

  // ─── Raw fetch & cache ─────────────────────────────────────────────────────

  private async fetchRaw(): Promise<any[]> {
    const now = Date.now();
    if (now < this.cacheExpiry && this.rawCache.length) return this.rawCache;

    try {
      const resp = await axios.get<any[]>(this.FF_URL, { timeout: 10_000 });
      const data = resp.data ?? [];
      if (data.length > 0) {
        this.rawCache    = data;
        this.cacheExpiry = now + 60 * 60 * 1000; // cache 1 hour only when data arrived
        this.logger.log(`News cache refreshed — ${this.rawCache.length} total events this week`);
      } else {
        // API returned empty — retry in 5 minutes, keep stale cache if any
        this.cacheExpiry = now + 5 * 60 * 1000;
        this.logger.warn('News API returned empty array — will retry in 5 minutes');
      }
    } catch (e: any) {
      // On failure, retry in 2 minutes rather than hammering
      this.cacheExpiry = now + 2 * 60 * 1000;
      this.logger.warn(`News fetch failed: ${e.message} — retrying in 2 minutes`);
    }

    return this.rawCache;
  }

  /** Convert raw FF event to NewsEvent with live minutesTill */
  private toEvent(e: any): NewsEvent {
    const eventDate   = new Date(e.date);
    const minutesTill = (eventDate.getTime() - Date.now()) / 60_000;
    return {
      title:       e.title    ?? 'Unknown',
      country:     e.country  ?? '',
      date:        eventDate.toISOString(),
      impact:      e.impact   ?? 'Low',
      forecast:    e.forecast ?? '',
      previous:    e.previous ?? '',
      actual:      e.actual   ?? '',
      minutesTill: +minutesTill.toFixed(1),
    };
  }

  // ─── Core gate (trade blocking — High USD/XAU only) ────────────────────────

  async isNewsWindow(): Promise<{ blocked: boolean; reason: string }> {
    const raw = await this.fetchRaw();
    const now = Date.now();

    for (const e of raw) {
      if (e.impact !== 'High') continue;
      if (!this.BLOCK_COUNTRIES.some(c => (e.country ?? '').toUpperCase().includes(c))) continue;

      const minutesTill = (new Date(e.date).getTime() - now) / 60_000;
      const minutesPast = -minutesTill;

      if (minutesTill > 0 && minutesTill <= this.blockBefore) {
        const reason = `High-impact news in ${Math.ceil(minutesTill)} min: ${e.title} (${e.country})`;
        this.logger.warn(`News block: ${reason}`);
        return { blocked: true, reason };
      }
      if (minutesPast >= 0 && minutesPast <= this.blockAfter) {
        const reason = `High-impact news ${Math.ceil(minutesPast)} min ago: ${e.title} — volatility window`;
        this.logger.warn(`News block (post): ${reason}`);
        return { blocked: true, reason };
      }
    }

    return { blocked: false, reason: '' };
  }

  /**
   * Get ALL upcoming events for dashboard display.
   * All impact levels, all currencies.
   * High-impact events near-term get a warning flag via minutesTill.
   */
  async getUpcoming(hours = 24): Promise<NewsEvent[]> {
    const raw = await this.fetchRaw();
    const cutoffMin = hours * 60;

    return raw
      .map(e => this.toEvent(e))
      .filter(e => e.impact !== 'Holiday')          // skip holidays
      .filter(e => e.minutesTill > -480)            // show up to 8h past
      .filter(e => e.minutesTill < cutoffMin)       // within requested window
      .sort((a, b) => a.minutesTill - b.minutesTill);
  }

  /** High-impact USD events only (used internally for trade blocking logic) */
  async getHighImpactUsd(): Promise<NewsEvent[]> {
    const raw = await this.fetchRaw();
    return raw
      .map(e => this.toEvent(e))
      .filter(e => e.impact === 'High')
      .filter(e => this.BLOCK_COUNTRIES.some(c => (e.country ?? '').toUpperCase().includes(c)))
      .filter(e => e.minutesTill > -120)
      .sort((a, b) => a.minutesTill - b.minutesTill);
  }
}
