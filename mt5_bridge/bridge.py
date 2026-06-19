"""
mt5_bridge/bridge.py — MetaTrader 5 REST Bridge
================================================
Supports two modes:

  REAL MODE (default, Windows only):
    python bridge.py
    Requires MetaTrader5 Python library + MT5 terminal running.

  MOCK MODE (Mac/Linux, no MT5 needed):
    python bridge.py --mock
    OR:  MOCK_MODE=true python bridge.py

    Generates realistic XAUUSD candle data locally so you can test
    the full NestJS pipeline (SMC → AI → Telegram → approval) on Mac.

Requirements:
  Real:  pip install flask MetaTrader5 pytz
  Mock:  pip install flask  (that's it)
"""

import argparse, os, sys, random, math, time, joblib, pathlib
from datetime import datetime, timezone, timedelta
from flask import Flask, request, jsonify

# ── Parse flags ───────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description='KrishView MT5 Bridge')
parser.add_argument('--mock', action='store_true',
                    help='Run in mock mode — no MT5 required (Mac/Linux dev)')
args, _ = parser.parse_known_args()

MOCK_MODE = args.mock or os.getenv('MOCK_MODE', '').lower() in ('1', 'true', 'yes')

app = Flask(__name__)

# ── ML Model (loaded at startup, if trained) ──────────────────────────────────
_ml_artifact = None

def load_ml_model():
    global _ml_artifact
    model_path = pathlib.Path(__file__).parent / 'model.pkl'
    if model_path.exists():
        try:
            _ml_artifact = joblib.load(model_path)
            print(f'ML model loaded — trained on {_ml_artifact["trade_count"]} trades, AUC={_ml_artifact["auc"]:.3f}')
        except Exception as e:
            print(f'ML model load failed: {e}')
    else:
        print('ML model not found — /ml/predict will return 503 until train.py is run')

# ══════════════════════════════════════════════════════════════════════════════
#  MOCK IMPLEMENTATION
# ══════════════════════════════════════════════════════════════════════════════

# Shared in-memory state so orders/positions persist across requests
_mock_positions   = {}   # ticket → position dict
_mock_next_ticket = 100001

def _mock_candles(timeframe: str, count: int) -> list:
    """
    Generate structured XAUUSD candles that produce real SMC signals.

    Pattern (repeats every ~60 candles):
      Phase 1 — Bearish leg      : price drops, creating sell-side liquidity lows
      Phase 2 — Liquidity sweep  : one sharp spike below recent lows (stop hunt)
      Phase 3 — Bullish impulse  : strong BOS candles breaking above prior highs
      Phase 4 — Pullback to OB   : gentle retrace to the last bearish OB zone
      Phase 5 — Continuation     : price moves up confirming the BOS + CHoCH

    This guarantees the SMC engine detects: BOS, CHoCH, OB, FVG, and liquidity sweeps.
    The last candles always sit in a pullback-to-OB setup → BUY signal.
    """
    tf_seconds = {
        'M1': 60, 'M5': 300, 'M15': 900, 'M30': 1800,
        'H1': 3600, 'H4': 14400, 'D1': 86400, 'W1': 604800,
    }
    interval = tf_seconds.get(timeframe.upper(), 900)

    now_ts   = int(time.time())
    start_ts = now_ts - (now_ts % interval) - interval * count

    rng   = random.Random(int(now_ts // (interval * count)) )  # changes daily
    price = 2320.0
    candles = []

    CYCLE = 60  # candles per full SMC pattern

    for i in range(count):
        ts_val = start_ts + i * interval
        pos    = i % CYCLE   # position inside the current cycle

        # ── Phase 1 (0–19): Bearish consolidation with lower-highs ──────────
        if pos < 20:
            # Slow grind down — builds sell-side liquidity
            drift = rng.gauss(-0.8, 0.4)          # negative drift
            body  = abs(rng.gauss(1.2, 0.4))
            bullish = rng.random() < 0.35          # mostly bearish candles
            wick_mult = 0.4

        # ── Phase 2 (20–24): Liquidity sweep (sharp spike below lows) ───────
        elif pos < 25:
            drift   = rng.gauss(-3.5, 0.5)        # hard drop = stop hunt
            body    = abs(rng.gauss(3.0, 0.5))
            bullish = pos >= 23                    # last 2 candles: reversal
            wick_mult = 1.2                        # big lower wicks on sweep

        # ── Phase 3 (25–39): Bullish impulse BOS ────────────────────────────
        elif pos < 40:
            drift   = rng.gauss(2.8, 0.5)         # strong up moves = BOS
            body    = abs(rng.gauss(2.5, 0.5))
            bullish = rng.random() < 0.85          # mostly bullish
            wick_mult = 0.25                       # small wicks = conviction

        # ── Phase 4 (40–49): Pullback to Order Block ─────────────────────────
        elif pos < 50:
            drift   = rng.gauss(-0.9, 0.3)        # retrace ~38-50% of leg
            body    = abs(rng.gauss(0.8, 0.3))
            bullish = rng.random() < 0.40
            wick_mult = 0.6

        # ── Phase 5 (50–59): Continuation up from OB ─────────────────────────
        else:
            drift   = rng.gauss(1.8, 0.4)
            body    = abs(rng.gauss(1.5, 0.4))
            bullish = rng.random() < 0.78
            wick_mult = 0.3

        price += drift

        open_p  = round(price, 2)
        close_p = round(price + (body if bullish else -body), 2)
        hi      = round(max(open_p, close_p) + body * wick_mult * rng.uniform(0.5, 1.5), 2)
        lo      = round(min(open_p, close_p) - body * wick_mult * rng.uniform(0.5, 1.5), 2)
        vol     = int(rng.uniform(300, 2500) * (2.5 if 20 <= pos < 40 else 1.0))

        candles.append({
            'time':   datetime.fromtimestamp(ts_val, tz=timezone.utc).isoformat(),
            'open':   open_p,
            'high':   hi,
            'low':    lo,
            'close':  close_p,
            'volume': vol,
        })

        price = close_p

    return candles


def _mock_price() -> dict:
    """Current mid-market price derived from last mock candle."""
    candle = _mock_candles('M1', 1)[-1]
    mid = candle['close']
    spread = 0.3  # typical XAUUSD spread in points
    return {
        'symbol': 'XAUUSD',
        'bid':    round(mid - spread / 2, 2),
        'ask':    round(mid + spread / 2, 2),
        'spread': spread,
        'time':   datetime.now(timezone.utc).isoformat(),
    }


# ── Health ────────────────────────────────────────────────────────────────────

@app.get('/ping')
def ping():
    mode = 'mock' if MOCK_MODE else 'live'
    return jsonify({'ok': True, 'mode': mode, 'time': datetime.utcnow().isoformat()})

# ── Account ───────────────────────────────────────────────────────────────────

@app.get('/account')
def account():
    if MOCK_MODE:
        return jsonify({
            'login':       99999,
            'balance':     10000.0,
            'equity':      10000.0,
            'margin':      0.0,
            'free_margin': 10000.0,
            'currency':    'USD',
            'company':     'Mock Broker (Dev Mode)',
            'server':      'MockServer-Dev',
            'leverage':    100,
        })

    import MetaTrader5 as mt5
    a = mt5.account_info()
    if not a:
        return jsonify({'error': str(mt5.last_error())}), 500
    return jsonify({
        'login': a.login, 'balance': a.balance, 'equity': a.equity,
        'margin': a.margin, 'free_margin': a.margin_free,
        'currency': a.currency, 'company': a.company,
        'server': a.server, 'leverage': a.leverage,
    })

# ── Price ─────────────────────────────────────────────────────────────────────

@app.get('/price/<symbol>')
def price(symbol):
    if MOCK_MODE:
        p = _mock_price()
        p['symbol'] = symbol
        return jsonify(p)

    import MetaTrader5 as mt5
    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        return jsonify({'error': f'No tick for {symbol}'}), 404
    return jsonify({
        'symbol': symbol,
        'bid':    tick.bid,
        'ask':    tick.ask,
        'spread': round((tick.ask - tick.bid) * 10, 1),
        'time':   datetime.fromtimestamp(tick.time, tz=timezone.utc).isoformat(),
    })

# ── Candles ───────────────────────────────────────────────────────────────────

@app.get('/candles')
def candles():
    symbol    = request.args.get('symbol', 'XAUUSD')
    timeframe = request.args.get('timeframe', 'M15')
    count     = int(request.args.get('count', 150))

    if MOCK_MODE:
        return jsonify({'candles': _mock_candles(timeframe, count)})

    import MetaTrader5 as mt5
    def tf_const(tf: str):
        mapping = {
            'M1': mt5.TIMEFRAME_M1,   'M5':  mt5.TIMEFRAME_M5,
            'M15': mt5.TIMEFRAME_M15, 'M30': mt5.TIMEFRAME_M30,
            'H1': mt5.TIMEFRAME_H1,   'H4':  mt5.TIMEFRAME_H4,
            'D1': mt5.TIMEFRAME_D1,   'W1':  mt5.TIMEFRAME_W1,
        }
        return mapping.get(tf.upper(), mt5.TIMEFRAME_M15)

    rates = mt5.copy_rates_from_pos(symbol, tf_const(timeframe), 0, count)
    if rates is None:
        return jsonify({'error': str(mt5.last_error())}), 500

    return jsonify({'candles': [
        {
            'time':   datetime.fromtimestamp(r['time'], tz=timezone.utc).isoformat(),
            'open':   float(r['open']),
            'high':   float(r['high']),
            'low':    float(r['low']),
            'close':  float(r['close']),
            'volume': int(r['tick_volume']),
        }
        for r in rates
    ]})

# ── Positions ─────────────────────────────────────────────────────────────────

@app.get('/positions')
def positions():
    if MOCK_MODE:
        symbol = request.args.get('symbol', 'XAUUSD')
        pos = [p for p in _mock_positions.values() if p['symbol'] == symbol]
        return jsonify({'positions': pos})

    import MetaTrader5 as mt5
    symbol = request.args.get('symbol', 'XAUUSD')
    pos = mt5.positions_get(symbol=symbol) or []
    return jsonify({'positions': [
        {
            'ticket':     p.ticket,
            'symbol':     p.symbol,
            'type':       'BUY' if p.type == mt5.ORDER_TYPE_BUY else 'SELL',
            'lots':       p.volume,
            'open_price': p.price_open,
            'sl':         p.sl,
            'tp':         p.tp,
            'profit':     round(p.profit, 2),
            'magic':      p.magic,
            'comment':    p.comment,
            'open_time':  datetime.fromtimestamp(p.time, tz=timezone.utc).isoformat(),
        }
        for p in pos
    ]})

# ── Place Order ───────────────────────────────────────────────────────────────

@app.post('/order')
def order():
    body    = request.json
    symbol  = body.get('symbol', 'XAUUSD')
    action  = body.get('action', 'BUY').upper()
    lots    = float(body.get('lots', 0.01))
    sl      = float(body.get('sl', 0))
    tp      = float(body.get('tp', 0))
    magic   = int(body.get('magic', 20240101))
    comment = body.get('comment', 'KrishView')

    if MOCK_MODE:
        global _mock_next_ticket
        tick    = _mock_price()
        price_v = tick['ask'] if action == 'BUY' else tick['bid']
        ticket  = _mock_next_ticket
        _mock_next_ticket += 1

        _mock_positions[ticket] = {
            'ticket':     ticket,
            'symbol':     symbol,
            'type':       action,
            'lots':       lots,
            'open_price': price_v,
            'sl':         sl,
            'tp':         tp,
            'profit':     0.0,
            'magic':      magic,
            'comment':    comment,
            'open_time':  datetime.now(timezone.utc).isoformat(),
        }
        print(f'[MOCK] Order placed: #{ticket} {action} {lots} {symbol} @ {price_v}')
        return jsonify({'ticket': ticket, 'price': price_v, 'lots': lots,
                        'direction': action, 'comment': comment})

    import MetaTrader5 as mt5
    tick   = mt5.symbol_info_tick(symbol)
    price_v = tick.ask if action == 'BUY' else tick.bid
    otype  = mt5.ORDER_TYPE_BUY if action == 'BUY' else mt5.ORDER_TYPE_SELL

    req = {
        'action': mt5.TRADE_ACTION_DEAL, 'symbol': symbol,
        'volume': lots, 'type': otype, 'price': price_v,
        'sl': sl, 'tp': tp, 'magic': magic, 'comment': comment,
        'type_time': mt5.ORDER_TIME_GTC, 'type_filling': mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(req)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return jsonify({'error': f'Order failed: {result.retcode} {result.comment}'}), 400

    return jsonify({'ticket': result.order, 'price': result.price,
                    'lots': lots, 'direction': action, 'comment': comment})

# ── Modify SL/TP ─────────────────────────────────────────────────────────────

@app.post('/modify')
def modify():
    body   = request.json
    ticket = int(body['ticket'])
    sl     = float(body['sl'])
    tp     = float(body['tp'])

    if MOCK_MODE:
        if ticket in _mock_positions:
            _mock_positions[ticket]['sl'] = sl
            _mock_positions[ticket]['tp'] = tp
            print(f'[MOCK] Modified #{ticket}: SL={sl} TP={tp}')
        return jsonify({'ok': True})

    import MetaTrader5 as mt5
    result = mt5.order_send({'action': mt5.TRADE_ACTION_SLTP,
                              'position': ticket, 'sl': sl, 'tp': tp})
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return jsonify({'error': f'Modify failed: {result.retcode}'}), 400
    return jsonify({'ok': True})

# ── Close Position ────────────────────────────────────────────────────────────

@app.post('/close')
def close():
    body   = request.json
    ticket = int(body['ticket'])

    if MOCK_MODE:
        pos = _mock_positions.pop(ticket, None)
        if not pos:
            return jsonify({'error': 'Position not found'}), 404
        tick   = _mock_price()
        price_v = tick['bid'] if pos['type'] == 'BUY' else tick['ask']
        # Simulate P&L: (exit - entry) * lots * 100 for gold
        diff   = (price_v - pos['open_price']) if pos['type'] == 'BUY' else (pos['open_price'] - price_v)
        profit = round(diff * pos['lots'] * 100, 2)
        print(f'[MOCK] Closed #{ticket} @ {price_v}, P&L={profit}')
        return jsonify({'ok': True, 'profit': profit})

    import MetaTrader5 as mt5
    pos = mt5.positions_get(ticket=ticket)
    if not pos:
        return jsonify({'error': 'Position not found'}), 404
    p = pos[0]
    price_v = mt5.symbol_info_tick(p.symbol).bid if p.type == mt5.ORDER_TYPE_BUY \
              else mt5.symbol_info_tick(p.symbol).ask
    otype = mt5.ORDER_TYPE_SELL if p.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY
    req = {
        'action': mt5.TRADE_ACTION_DEAL, 'position': ticket,
        'symbol': p.symbol, 'volume': p.volume, 'type': otype, 'price': price_v,
        'magic': p.magic, 'comment': 'KrishView-Close',
        'type_time': mt5.ORDER_TIME_GTC, 'type_filling': mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(req)
    profit = p.profit if result.retcode == mt5.TRADE_RETCODE_DONE else 0
    return jsonify({'ok': result.retcode == mt5.TRADE_RETCODE_DONE, 'profit': round(profit, 2)})

# ── Partial Close ─────────────────────────────────────────────────────────────

@app.post('/partial_close')
def partial_close():
    body   = request.json
    ticket = int(body['ticket'])
    lots   = float(body['lots'])

    if MOCK_MODE:
        pos = _mock_positions.get(ticket)
        if not pos:
            return jsonify({'error': 'Position not found'}), 404
        close_lots = min(lots, pos['lots'])
        pos['lots'] = round(pos['lots'] - close_lots, 2)
        tick   = _mock_price()
        price_v = tick['bid'] if pos['type'] == 'BUY' else tick['ask']
        diff   = (price_v - pos['open_price']) if pos['type'] == 'BUY' else (pos['open_price'] - price_v)
        profit = round(diff * close_lots * 100, 2)
        print(f'[MOCK] Partial close #{ticket}: {close_lots} lots @ {price_v}, P&L={profit}')
        return jsonify({'ok': True, 'profit': profit})

    import MetaTrader5 as mt5
    pos = mt5.positions_get(ticket=ticket)
    if not pos:
        return jsonify({'error': 'Position not found'}), 404
    p = pos[0]
    close_lots = min(lots, p.volume)
    price_v = mt5.symbol_info_tick(p.symbol).bid if p.type == mt5.ORDER_TYPE_BUY \
              else mt5.symbol_info_tick(p.symbol).ask
    otype = mt5.ORDER_TYPE_SELL if p.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY
    req = {
        'action': mt5.TRADE_ACTION_DEAL, 'position': ticket,
        'symbol': p.symbol, 'volume': close_lots, 'type': otype, 'price': price_v,
        'magic': p.magic, 'comment': 'KrishView-PartialTP',
        'type_time': mt5.ORDER_TIME_GTC, 'type_filling': mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(req)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return jsonify({'error': f'Partial close failed: {result.retcode}'}), 400
    return jsonify({'ok': True, 'profit': round(getattr(result, 'profit', 0), 2)})

# ── Trade History / Closed P&L ────────────────────────────────────────────────

@app.post('/trade_history')
def trade_history():
    body   = request.json
    ticket = int(body.get('ticket', 0))

    if MOCK_MODE:
        # Return a simulated closed deal
        profit    = round(random.uniform(-50, 150), 2)
        exit_price = round(_mock_price()['bid'], 2)
        return jsonify({
            'ticket':    ticket,
            'pnl':       profit,
            'exitPrice': exit_price,
            'exitTime':  datetime.now(timezone.utc).isoformat(),
        })

    import MetaTrader5 as mt5

    # Try position lookup first (most reliable — position ticket == position_id in MT5)
    deals = mt5.history_deals_get(position=ticket)
    if not deals:
        # Fallback: deal ticket lookup
        deals = mt5.history_deals_get(ticket=ticket)
    if not deals:
        # Fallback: via order history
        orders = mt5.history_orders_get(position=ticket)
        if orders:
            deals = mt5.history_deals_get(position=orders[0].position_id)
    if not deals:
        return jsonify({'error': f'No deals found for ticket {ticket}'}), 404

    close_deal = next((d for d in reversed(deals) if d.entry == 1), deals[-1])  # 1=DEAL_ENTRY_OUT
    open_deal  = next((d for d in deals if d.entry == 0), None)                 # 0=DEAL_ENTRY_IN
    # Sum profit across all closing deals (handles partial closes)
    total_profit = round(sum(d.profit for d in deals if d.entry == 1), 2)
    return jsonify({
        'ticket':     ticket,
        'pnl':        total_profit,
        'exitPrice':  close_deal.price,
        'entryPrice': open_deal.price if open_deal else 0,
        'exitTime':   datetime.utcfromtimestamp(close_deal.time).isoformat() + 'Z',
    })

# ── All Closed Deals (for history import) ─────────────────────────────────────

@app.get('/history_all')
def history_all():
    """Return all closed deals from MT5 deal history (last 365 days)."""
    if MOCK_MODE:
        return jsonify([])  # No mock history — journal starts fresh

    import MetaTrader5 as mt5
    # MT5 requires naive UTC datetimes (no timezone info)
    from_date = datetime.utcnow() - timedelta(days=365)
    to_date   = datetime.utcnow()
    deals = mt5.history_deals_get(from_date, to_date)
    if deals is None:
        return jsonify([])

    # Group deals by position_id so we can pair entry + exit
    from collections import defaultdict
    by_pos = defaultdict(list)
    for d in deals:
        by_pos[d.position_id].append(d)

    results = []
    for pos_id, pos_deals in by_pos.items():
        # Find the closing deal (DEAL_ENTRY_OUT = 1)
        close_deal = next((d for d in pos_deals if d.entry == 1), None)
        if not close_deal:
            continue
        # Find the opening deal (DEAL_ENTRY_IN = 0) for entry price
        open_deal = next((d for d in pos_deals if d.entry == 0), None)
        entry_price = open_deal.price if open_deal else close_deal.price

        # Closing deal type: 1=SELL closes BUY, 0=BUY closes SELL
        direction = 'BUY' if close_deal.type == 1 else 'SELL'

        results.append({
            'ticket':     pos_id,
            'deal':       close_deal.ticket,
            'symbol':     close_deal.symbol,
            'type':       direction,
            'lots':       close_deal.volume,
            'entryPrice': entry_price,
            'exitPrice':  close_deal.price,
            'pnl':        round(close_deal.profit, 2),
            'exitTime':   datetime.utcfromtimestamp(close_deal.time).isoformat() + 'Z',
        })
    return jsonify(results)

# ── ML Predict ────────────────────────────────────────────────────────────────

@app.post('/ml/predict')
def ml_predict():
    global _ml_artifact
    if _ml_artifact is None:
        return jsonify({'error': 'Model not trained yet. Run train.py after 300+ trades.'}), 503

    body     = request.json or {}
    model    = _ml_artifact['model']
    features = _ml_artifact['features']

    try:
        import pandas as pd
        row  = {feat: float(body.get(feat, 0)) for feat in features}
        X    = pd.DataFrame([row])
        prob = float(model.predict_proba(X)[0][1])
    except Exception as e:
        return jsonify({'error': f'Prediction failed: {str(e)}'}), 500

    return jsonify({
        'win_probability': round(prob, 4),
        'model_version':   _ml_artifact.get('version', 'v1'),
        'trade_count':     _ml_artifact.get('trade_count', 0),
        'trained_at':      _ml_artifact.get('trained_at', ''),
    })

# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    load_ml_model()

    if MOCK_MODE:
        print('=' * 55)
        print('  KrishView Bridge — MOCK MODE (Mac/Linux dev)')
        print('  No MT5 required. Serving synthetic XAUUSD data.')
        print('=' * 55)
    else:
        MT5_LOGIN    = int(os.getenv('MT5_LOGIN', '0'))
        MT5_PASSWORD = os.getenv('MT5_PASSWORD', '')
        MT5_SERVER   = os.getenv('MT5_SERVER', '')

        import MetaTrader5 as mt5, pytz
        if not mt5.initialize():
            print(f'MT5 initialize() failed: {mt5.last_error()}')
            sys.exit(1)
        if MT5_LOGIN:
            ok = mt5.login(MT5_LOGIN, password=MT5_PASSWORD, server=MT5_SERVER)
            if not ok:
                print(f'MT5 login failed: {mt5.last_error()}')
                sys.exit(1)
        info = mt5.account_info()
        print(f'MT5 Bridge ready — #{info.login} {info.server} balance=${info.balance}')

    port = int(os.getenv('BRIDGE_PORT', 7654))
    print(f'Listening on http://0.0.0.0:{port}')
    app.run(host='0.0.0.0', port=port, debug=False)
