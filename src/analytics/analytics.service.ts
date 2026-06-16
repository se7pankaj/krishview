/**
 * analytics/analytics.service.ts — Performance Analytics
 * =========================================================
 * SQL queries over the trades + analyses + approvals tables.
 * Results power the dashboard's analytics panel and weekly reports.
 *
 * Sprint 4.2 queries:
 *  • Win rate by AI confidence bracket
 *  • Human override rate (approved / rejected / expired)
 *  • Best performing SMC reasons
 *  • Session performance (London vs NY vs overlap)
 *  • All-time equity curve (cumulative PnL over time)
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

// ─── Result Types ─────────────────────────────────────────────────────────────

export interface ConfidenceBracket {
  bracket:  string;
  total:    number;
  wins:     number;
  losses:   number;
  winRate:  number;
  avgPnl:   number;
}

export interface ApprovalStats {
  status: string;
  count:  number;
  pct:    number;
}

export interface SmcReasonStat {
  reason:   string;
  count:    number;
  avgPnl:   number;
  winRate:  number;
}

export interface SessionStat {
  session:  string;
  total:    number;
  wins:     number;
  avgPnl:   number;
  winRate:  number;
}

export interface EquityPoint {
  date:           string;
  dailyPnl:       number;
  cumulativePnl:  number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    @InjectDataSource()
    private readonly db: DataSource,
  ) {}

  /** Win rate grouped by AI confidence bracket (70-79%, 80-89%, 90-100%) */
  async confidenceBrackets(): Promise<ConfidenceBracket[]> {
    const rows = await this.db.query(`
      SELECT
        CASE
          WHEN t.confidence >= 90 THEN '90-100%'
          WHEN t.confidence >= 80 THEN '80-89%'
          WHEN t.confidence >= 70 THEN '70-79%'
          ELSE '<70%'
        END AS bracket,
        COUNT(*)::int                                        AS total,
        SUM(CASE WHEN t.pnl > 0 THEN 1 ELSE 0 END)::int    AS wins,
        SUM(CASE WHEN t.pnl <= 0 THEN 1 ELSE 0 END)::int   AS losses,
        ROUND(AVG(t.pnl)::numeric, 2)                       AS avg_pnl
      FROM trades t
      WHERE t.status = 'CLOSED'
      GROUP BY bracket
      ORDER BY MIN(t.confidence) DESC
    `);

    return rows.map((r: any) => ({
      bracket:  r.bracket,
      total:    r.total,
      wins:     r.wins,
      losses:   r.losses,
      winRate:  r.total > 0 ? +((r.wins / r.total) * 100).toFixed(1) : 0,
      avgPnl:   +r.avg_pnl,
    }));
  }

  /** Human override rate — how often signals are approved/rejected/expired */
  async approvalStats(): Promise<ApprovalStats[]> {
    const rows = await this.db.query(`
      SELECT
        status,
        COUNT(*)::int AS count
      FROM approvals
      GROUP BY status
      ORDER BY count DESC
    `);

    const total = rows.reduce((s: number, r: any) => s + r.count, 0);
    return rows.map((r: any) => ({
      status: r.status,
      count:  r.count,
      pct:    total > 0 ? +((r.count / total) * 100).toFixed(1) : 0,
    }));
  }

  /**
   * Best performing SMC reasons.
   * Requires the smcReasons JSONB column in trades.
   */
  async smcReasonStats(): Promise<SmcReasonStat[]> {
    const rows = await this.db.query(`
      SELECT
        reason,
        COUNT(*)::int                                       AS count,
        ROUND(AVG(t.pnl)::numeric, 2)                      AS avg_pnl,
        SUM(CASE WHEN t.pnl > 0 THEN 1 ELSE 0 END)::int   AS wins
      FROM trades t,
           jsonb_array_elements_text(t.smc_reasons) AS reason
      WHERE t.status = 'CLOSED'
        AND t.smc_reasons IS NOT NULL
      GROUP BY reason
      HAVING COUNT(*) >= 3
      ORDER BY avg_pnl DESC
      LIMIT 20
    `);

    return rows.map((r: any) => ({
      reason:  r.reason,
      count:   r.count,
      avgPnl:  +r.avg_pnl,
      winRate: r.count > 0 ? +((r.wins / r.count) * 100).toFixed(1) : 0,
    }));
  }

  /** Performance by trading session (London / NY / overlap / Asian) */
  async sessionStats(): Promise<SessionStat[]> {
    const rows = await this.db.query(`
      SELECT
        COALESCE(session, 'unknown')                        AS session,
        COUNT(*)::int                                       AS total,
        SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)::int      AS wins,
        ROUND(AVG(pnl)::numeric, 2)                        AS avg_pnl
      FROM trades
      WHERE status = 'CLOSED'
      GROUP BY session
      ORDER BY avg_pnl DESC
    `);

    return rows.map((r: any) => ({
      session: r.session,
      total:   r.total,
      wins:    r.wins,
      avgPnl:  +r.avg_pnl,
      winRate: r.total > 0 ? +((r.wins / r.total) * 100).toFixed(1) : 0,
    }));
  }

  /** Daily cumulative equity curve — all closed trades grouped by day */
  async equityCurve(): Promise<EquityPoint[]> {
    const rows = await this.db.query(`
      SELECT
        DATE(close_time)              AS date,
        ROUND(SUM(pnl)::numeric, 2)   AS daily_pnl
      FROM trades
      WHERE status = 'CLOSED'
        AND close_time IS NOT NULL
      GROUP BY DATE(close_time)
      ORDER BY date ASC
    `);

    let cum = 0;
    return rows.map((r: any) => {
      cum += parseFloat(r.daily_pnl);
      return {
        date:          r.date,
        dailyPnl:      +r.daily_pnl,
        cumulativePnl: +cum.toFixed(2),
      };
    });
  }

  /** Full analytics bundle for the dashboard endpoint */
  async summary(): Promise<{
    confidence: ConfidenceBracket[];
    approvals:  ApprovalStats[];
    smcReasons: SmcReasonStat[];
    sessions:   SessionStat[];
    equity:     EquityPoint[];
  }> {
    const [confidence, approvals, smcReasons, sessions, equity] = await Promise.all([
      this.confidenceBrackets().catch(() => []),
      this.approvalStats().catch(() => []),
      this.smcReasonStats().catch(() => []),
      this.sessionStats().catch(() => []),
      this.equityCurve().catch(() => []),
    ]);
    return { confidence, approvals, smcReasons, sessions, equity };
  }
}
