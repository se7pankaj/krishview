# KrishView — Sprint 3 & Sprint 4 Implementation Analysis

---

## SPRINT 3

### Feature 1 — News Engine (Forex Factory Event Blocker)

**Problem:** The bot can enter trades minutes before high-impact events (NFP, CPI, FOMC) causing massive volatility losses. This is the most important guard missing from the current stack.

**Design:**

```
NewsService
  ├── fetchEvents()         → scrape/parse Forex Factory calendar
  ├── getUpcomingEvents()   → filter to high-impact, next 60 min
  ├── isNewsWindow()        → true if within ±30 min of event
  └── cacheEvents()         → cache for 1 hour to avoid hammering FF
```

**Implementation approach:**
- **Source:** `https://nfs.faireconomy.media/ff_calendar_thisweek.json` — Forex Factory publishes a JSON endpoint (no scraping needed, no API key).
- **Filter:** `impact === "High"` only. Medium/Low events are ignored.
- **Window:** Block trading from 30 minutes before to 15 minutes after each event.
- **Cache:** Refresh once per hour. Store in a NestJS in-memory cache (Map with TTL).
- **Integration point:** `RiskService.riskCheck()` calls `newsService.isNewsWindow()` as a new gate. If blocked, returns `{ ok: false, reason: 'High-impact news in 25 min: NFP' }`.

**New file:** `src/news/news.service.ts`, `src/news/news.module.ts`

**Entity:** No DB needed — events are ephemeral, cache in memory.

**Example block message to Telegram:**
```
⏸ Signal Skipped
High-impact news in 18 min: US Non-Farm Payrolls
Trading resumes after 15:45 UTC
```

---

### Feature 2 — Active SL Management (Trailing Stop + Break-Even + Partial TP)

**Problem:** `RiskService` already computes `calcTrailingStop()` and `partialTPLevels()` but the monitor loop in `TradingService.monitorOpenTrades()` never calls them. Trades just sit at their original SL/TP until hit.

**Design:**

The monitor loop runs every 30s. For each open trade it should:

```
1. Get current price (bid/ask)
2. Check partialTPLevels — if price hit TP1 (1:1), close 50% of position
3. Check break-even — if price moved 1× ATR in favour, move SL to break-even+1pip
4. Check trailing stop — if price moved 2× ATR in favour, trail SL by 1× ATR
5. Call mt5.modifyPosition(ticket, newSL, tp) if SL changed
```

**Changes to existing files:**
- `trading/trading.service.ts` — expand `monitorOpenTrades()` to call the new logic
- `risk/risk.service.ts` — expose `shouldMoveToBreakEven(trade, currentPrice, atr)` and `calcTrailingStop(trade, currentPrice, atr)` as public methods
- `mt5/mt5.service.ts` — verify `modifyPosition(ticket, sl, tp)` is wired up (it is — already in Sprint 1)
- `journal/entities/trade.entity.ts` — add `trailCount: number` column to track how many times SL was moved

**Logic example:**
```typescript
// In monitorOpenTrades():
const tick   = await mt5.getPrice(symbol);
const price  = trade.direction === 'BUY' ? tick.bid : tick.ask;
const atr    = journal.getLastATR(trade.ticket); // stored at entry
const moved  = trade.direction === 'BUY'
  ? price - trade.entryPrice
  : trade.entryPrice - price;

if (moved >= atr && trade.sl !== trade.entryPrice) {
  // Move to break-even
  const beSL = trade.direction === 'BUY'
    ? trade.entryPrice + 0.1
    : trade.entryPrice - 0.1;
  await mt5.modifyPosition(trade.ticket, beSL, trade.tp);
}

if (moved >= 2 * atr) {
  // Trail by 1 ATR
  const trailSL = trade.direction === 'BUY'
    ? price - atr
    : price + atr;
  if ((trade.direction === 'BUY' && trailSL > trade.sl) ||
      (trade.direction === 'SELL' && trailSL < trade.sl)) {
    await mt5.modifyPosition(trade.ticket, trailSL, trade.tp);
  }
}
```

---

### Feature 3 — P&L Reconciliation (Actual Closed P&L)

**Problem:** When `monitorOpenTrades()` detects a position is gone from MT5, it logs `pnl: 0`. Actual profit/loss is never recorded.

**Solution:**

Add a `/trade_history` endpoint to the Python MT5 bridge, then call it from `Mt5Service`.

**MT5 bridge addition (`bridge.py`):**
```python
@app.route('/trade_history', methods=['POST'])
def trade_history():
    body    = request.json
    ticket  = body.get('ticket')
    history = mt5.history_deals_get(ticket=ticket)
    if not history:
        return jsonify({'error': 'not found'}), 404
    deal = history[-1]  # last deal = close
    return jsonify({
        'ticket': ticket,
        'pnl':    round(deal.profit, 2),
        'exit':   deal.price,
        'time':   deal.time,
    })
```

**NestJS side (`Mt5Service`):**
```typescript
async getClosedDealPnL(ticket: number): Promise<{ pnl: number; exitPrice: number }> {
  const resp = await axios.post(`${this.bridgeUrl}/trade_history`, { ticket });
  return { pnl: resp.data.pnl, exitPrice: resp.data.exit };
}
```

**Monitor loop update:**
```typescript
// Instead of pnl: 0
const deal = await this.mt5.getClosedDealPnL(trade.ticket).catch(() => null);
const pnl  = deal?.pnl ?? 0;
await this.journal.logExit({ ticket: trade.ticket, exitPrice: deal?.exitPrice ?? 0, pnl, closeReason: 'SL_OR_TP' });
```

---

## SPRINT 4

### Feature 1 — Dashboard UI (Dark-themed HTML frontend served from NestJS)

**Design:** Single self-contained HTML file served statically from NestJS. Polls the existing `/dashboard/*` REST endpoints every 5 seconds. No React build step needed — pure HTML/CSS/vanilla JS.

**Serves from:** `GET /` → `dashboard.html`

**Dashboard panels:**
| Panel | Data source | Refresh |
|---|---|---|
| Account balance + equity | `/dashboard/summary` | 5s |
| Daily PnL + win rate | `/dashboard/summary` | 5s |
| Open positions table | `/dashboard/positions` | 5s |
| Recent trades (last 20) | `/dashboard/trades` | 30s |
| SMC state (bias, zone, OBs) | `/dashboard/smc` | 30s |
| Pending approvals | `/dashboard/approvals` (new) | 3s |

**Dark theme:** Same colour scheme as the standalone bot's dashboard — `#0d1117` background, green `#00ff88` for profit, red `#ff4444` for loss.

**NestJS changes:**
- `dashboard/dashboard.controller.ts` — add `GET /dashboard/approvals` (recent pending approvals from `ApprovalService`)
- `main.ts` — add `app.useStaticAssets(path.join(__dirname, '..', 'public'))` and serve `public/index.html`

---

### Feature 2 — Performance Analytics

**New endpoint:** `GET /dashboard/analytics`

**Queries to build on existing `analyses` + `trades` tables:**

```sql
-- Win rate by AI confidence bracket
SELECT
  CASE
    WHEN ai_confidence >= 90 THEN '90-100%'
    WHEN ai_confidence >= 80 THEN '80-89%'
    WHEN ai_confidence >= 70 THEN '70-79%'
    ELSE '<70%'
  END AS bracket,
  COUNT(*) AS total,
  SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
  AVG(pnl) AS avg_pnl
FROM trades t
JOIN analyses a ON a.id = t.analysis_id
GROUP BY bracket;

-- Human override rate (approved vs rejected)
SELECT
  status,
  COUNT(*) AS count,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 1) AS pct
FROM approvals
GROUP BY status;

-- Best performing SMC reasons
SELECT reason, COUNT(*) AS appearances, AVG(pnl) AS avg_pnl
FROM trades t, jsonb_array_elements_text(t.smc_reasons) AS reason
GROUP BY reason ORDER BY avg_pnl DESC;
```

**New file:** `analytics/analytics.service.ts` using TypeORM QueryBuilder or raw SQL via `DataSource.query()`.

---

### Feature 3 — Learning Engine (XGBoost/LightGBM after 300+ trades)

**Architecture:**

```
After 300 closed trades:
  LightGBM trained on:
    features  = analyses.features (JSONB → flatten to numeric columns)
    target    = 1 if trade.pnl > 0 else 0

  Model output:
    probability of win (0–1)
    feature importances

  Used in pipeline:
    AnalysisService.run() → LightGBM.predict(features)
    If ml_confidence < 0.55 → skip (even if GPT-4 says BUY)
    Combined confidence = 0.5 * ai_confidence + 0.5 * ml_confidence * 100
```

**Two-machine design:**
- LightGBM model trained on Mac (Python script, runs weekly via cron)
- Model saved as `model.pkl` and served by a lightweight Flask endpoint alongside `bridge.py` (reuse Windows machine)
- NestJS calls `/ml/predict` on Windows bridge, gets `{ win_probability: 0.72 }` back
- Falls back gracefully if endpoint unavailable

**New files:**
- `ml/ml.service.ts` — HTTP client to ML bridge `/ml/predict`
- `ml/ml.module.ts`
- `mt5_bridge/train.py` — offline training script (runs on Mac with historical trade data exported from DB)
- `mt5_bridge/bridge.py` — add `/ml/predict` route (loads `model.pkl` at startup)

**Training trigger:** Automatic after 300 closed trades (JournalService emits an event, or just check count in AnalysisService).

**Feature columns for ML (all numeric):**
EMA trend alignment (0/1), RSI value, ATR, Fibonacci zone index, OB present (0/1), FVG present (0/1), liquidity swept (0/1), HTF bias (1=bull/-1=bear/0=neutral), confidence, RR, session (0=London/1=NY), hour of day, day of week.

---

## Implementation Order (Recommended)

| Sprint | Feature | Effort | Dependency |
|---|---|---|---|
| 3 | P&L Reconciliation | Low (2 files) | MT5 bridge must be running |
| 3 | Trailing Stop / Break-Even | Medium (3 files modified) | None |
| 3 | News Engine | Medium (2 new files) | None |
| 4 | Dashboard UI | Medium (1 HTML file + 1 route) | Dashboard endpoints exist |
| 4 | Performance Analytics | Medium (1 service + SQL queries) | Need 10+ closed trades |
| 4 | Learning Engine | High (Python training + NestJS ML client) | Need 300+ closed trades |

---

## Files to Create/Modify — Sprint 3

| File | Action |
|---|---|
| `src/news/news.service.ts` | New — Forex Factory fetcher + cache + isNewsWindow() |
| `src/news/news.module.ts` | New |
| `src/risk/risk.service.ts` | Modify — add newsService injection, isNewsWindow check in riskCheck() |
| `src/trading/trading.service.ts` | Modify — monitorOpenTrades() adds trailing stop + break-even logic |
| `src/mt5/mt5.service.ts` | Modify — add getClosedDealPnL() |
| `mt5_bridge/bridge.py` | Modify — add /trade_history endpoint |
| `src/journal/entities/trade.entity.ts` | Modify — add trailCount, lastAtr columns |

## Files to Create/Modify — Sprint 4

| File | Action |
|---|---|
| `public/index.html` | New — dark dashboard UI, polls REST endpoints |
| `src/dashboard/dashboard.controller.ts` | Modify — add /approvals, /analytics endpoints |
| `src/analytics/analytics.service.ts` | New — SQL analytics queries |
| `src/analytics/analytics.module.ts` | New |
| `src/ml/ml.service.ts` | New — HTTP client to ML bridge |
| `src/ml/ml.module.ts` | New |
| `mt5_bridge/train.py` | New — offline LightGBM training script |
| `mt5_bridge/bridge.py` | Modify — add /ml/predict route |
| `src/main.ts` | Modify — serve public/ as static assets |
