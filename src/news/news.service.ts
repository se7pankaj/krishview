/**
 * news/news.service.ts — Forex Factory News Engine
 * ==================================================
 * Fetches the weekly high-impact economic calendar from Forex Factory's
 * free JSON endpoint. Blocks trading within a configurable window
 * before/after high-impact events (NFP, CPI, FOMC, etc.).
 *
 * No API key required. Cache refreshes once per hour.
 * Adds /dashboard/news endpoint so you can see upcoming events on dashboard.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NewsEvent {
  title:      string;
  country:    string;
  date:       string;         // ISO string
  impact:     'High' | 'Medium' | 'Low' | 'Holiday';
  forecast:   string;
  previous:   string;
  minutesTill: number;        // negative = in the past
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);

  // In-memory cache
  private cachedEvents: NewsEvent[] = [];
  private cacheExpiry  = 0;

  /** FF free JSON — publishes this-week's calendar. No auth needed. */
  private readonly FF_URL =
    'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

  /** High-impact currencies we care about for XAUUSD */
  private readonly RELEVANT_COUNTRIES = ['USD', 'XAU', 'US'];

  constructor(private readonly config: ConfigService) {}

  private get blockBefore(): number {
    return parseInt(this.config.get('NEWS_BLOCK_BEFORE_MIN', '30'), 10);
  }
  private get blockAfter(): number {
    return parseInt(this.config.get('NEWS_BLOCK_AFTER_MIN', '15'), 10);
  }

  // ─── Fetch & cache ─────────────────────────────────────────────────────────

  async fetchEvents(): Promise<NewsEvent[]> {
    const now = Date.now();
    if (now < this.cacheExpiry && this.cachedEvents.length) {
      return this.cachedEvents;
    }

    try {
      const resp = await axios.get<any[]>(this.FF_URL, { timeout: 10_000 });
      const raw  = resp.data ?? [];

      this.cachedEvents = raw
        .filter((e: any) => e.impact === 'High')
        .filter((e: any) =>
          this.RELEVANT_COUNTRIES.some(c =>
            (e.country ?? '').toUpperCase().includes(c),
          ),
        )
        .map((e: any) => {
          const eventDate  = new Date(e.date);
          const minutesTill = (eventDate.getTime() - now) / 60_000;
          return {
            title:      e.title ?? 'Unknown',
            country:    e.country ?? '',
            date:       eventDate.toISOString(),
            impact:     e.impact,
            forecast:   e.forecast ?? '',
            previous:   e.previous ?? '',
            minutesTill: +minutesTill.toFixed(1),
          };
        })
        .filter((e: NewsEvent) => e.minutesTill > -120); // drop events > 2h ago

      // Cache for 1 hour
      this.cacheExpiry = now + 60 * 60 * 1000;
      this.logger.log(`News cache refreshed — ${this.cachedEvents.length} high-impact USD events this week`);
    } catch (e: any) {
      this.logger.warn(`News fetch failed: ${e.message} — trading allowed (fail-open)`);
      // Fail open: if we can't reach Forex Factory, don't block trading
    }

    return this.cachedEvents;
  }

  // ─── Core gate ─────────────────────────────────────────────────────────────

  /**
   * Returns true if we are within the news window of a high-impact event.
   * Caller should check this and block trading if true.
   */
  async isNewsWindow(): Promise<{ blocked: boolean; reason: string }> {
    const events = await this.fetchEvents();
    const now    = Date.now();

    for (const event of events) {
      const eventDate   = new Date(event.date).getTime();
      const minutesTill = (eventDate - now) / 60_000;
      const minutesPast = -minutesTill;

      // Block window: 30 min before → 15 min after
      if (minutesTill > 0 && minutesTill <= this.blockBefore) {
        const reason = `High-impact news in ${Math.ceil(minutesTill)} min: ${event.title} (${event.country})`;
        this.logger.warn(`News block: ${reason}`);
        return { blocked: true, reason };
      }
      if (minutesPast >= 0 && minutesPast <= this.blockAfter) {
        const reason = `High-impact news ${Math.ceil(minutesPast)} min ago: ${event.title} — waiting for volatility to settle`;
        this.logger.warn(`News block (post): ${reason}`);
        return { blocked: true, reason };
      }
    }

    return { blocked: false, reason: '' };
  }

  /** Get upcoming high-impact events for dashboard display */
  async getUpcoming(hours = 24): Promise<NewsEvent[]> {
    const events = await this.fetchEvents();
    return events
      .filter(e => e.minutesTill > -60 && e.minutesTill < hours * 60)
      .sort((a, b) => a.minutesTill - b.minutesTill);
  }
}
