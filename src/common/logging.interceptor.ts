/**
 * common/logging.interceptor.ts — Global HTTP Request/Response Logger
 * =====================================================================
 * Logs every inbound request and its outcome so you can diagnose
 * issues from the NestJS log alone without touching browser devtools.
 *
 * Log format:
 *   → GET  /dashboard/config
 *   ← GET  /dashboard/config  200  14ms
 *   ✗ GET  /dashboard/smc     500  23ms  Cannot read property 'length' of undefined
 */

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
  HttpException,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { Request, Response } from 'express';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const ctx  = context.switchToHttp();
    const req  = ctx.getRequest<Request>();
    const res  = ctx.getResponse<Response>();

    const method = req.method;
    const url    = req.url;
    const start  = Date.now();

    // Skip noisy static asset requests
    if (url === '/' || url.endsWith('.html') || url.endsWith('.js') || url.endsWith('.css') || url.endsWith('.ico')) {
      return next.handle();
    }

    this.logger.log(`→ ${method.padEnd(4)} ${url}`);

    return next.handle().pipe(
      tap(body => {
        const ms     = Date.now() - start;
        const status = res.statusCode;
        const hint   = summarise(url, body);
        this.logger.log(`← ${method.padEnd(4)} ${url.padEnd(40)} ${status}  ${ms}ms${hint ? `  [${hint}]` : ''}`);
      }),
      catchError(err => {
        const ms      = Date.now() - start;
        const status  = err instanceof HttpException ? err.getStatus() : 500;
        const message = err?.message ?? String(err);
        this.logger.error(
          `✗ ${method.padEnd(4)} ${url.padEnd(40)} ${status}  ${ms}ms  ${message}`,
          err?.stack,
        );
        return throwError(() => err);
      }),
    );
  }
}

/**
 * Build a short one-line summary of the response body so you can see
 * key values in the log without grepping the raw JSON.
 */
function summarise(url: string, body: any): string {
  if (!body || typeof body !== 'object') return '';

  try {
    if (url.includes('/config')) {
      return `tier=${body.tradingTier} thresh=${body.tierThreshold}% testMode=${body.testMode}`;
    }
    if (url.includes('/summary')) {
      return `balance=$${body.balance} dailyPnL=${body.dailyPnL} openPositions=${body.openCount}`;
    }
    if (url.includes('/price')) {
      return `bid=${body.bid} ask=${body.ask} spread=${body.spread}`;
    }
    if (url.includes('/smc')) {
      if (body.error) return `ERROR: ${body.error}`;
      return `dir=${body.direction ?? 'none'} conf=${body.confidence}% bias=${body.bias} zone=${body.zone}`;
    }
    if (url.includes('/analysis/latest')) {
      if (!body?.id) return 'no analysis yet';
      return `id=${body.id} decision=${body.aiDecision} conf=${body.aiConfidence}% status=${body.status}`;
    }
    if (url.includes('/approvals')) {
      const arr = Array.isArray(body) ? body : [];
      return `count=${arr.length}${arr.length ? ' ids=[' + arr.map((a: any) => a.id).join(',') + ']' : ''}`;
    }
    if (url.includes('/positions')) {
      const arr = Array.isArray(body) ? body : [];
      return `openTrades=${arr.length}`;
    }
    if (url.includes('/trades')) {
      const arr = Array.isArray(body) ? body : [];
      return `records=${arr.length}`;
    }
    if (url.includes('/stats')) {
      return `total=${body.total} winRate=${body.winRate}% pnl=${body.totalPnL}`;
    }
    if (url.includes('/news')) {
      const arr = Array.isArray(body) ? body : [];
      const high = arr.filter((e: any) => e.impact === 'High').length;
      return `events=${arr.length} highImpact=${high}`;
    }
    if (url.includes('/trigger')) {
      return `ok=${body.ok}${body.message ? ' msg="' + body.message + '"' : ''}`;
    }
    if (url.includes('/sync-history')) {
      return `ok=${body.ok} totalImported=${body.totalImported}`;
    }
    if (url.includes('/reconcile')) {
      return `ok=${body.ok} fixed=${body.fixed} failed=${body.failed}`;
    }
    if (url.includes('/approve/') || url.includes('/reject/')) {
      return `ok=${body.ok} status=${body.status}`;
    }
    if (url.includes('/debug')) {
      return `blockedAt=${body.blockedAt ?? 'NONE'}`;
    }
    if (url.includes('/health')) {
      return `status=${body.status}`;
    }
  } catch {
    // summarise must never throw
  }
  return '';
}
