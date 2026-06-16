"""
mt5_bridge/train.py — LightGBM Offline Training Script
========================================================
Run this on ANY machine (Mac or Windows) that has access to your PostgreSQL DB.
Trains a LightGBM binary classifier to predict trade win/loss.
Output: model.pkl  — loaded by bridge.py for /ml/predict

Requirements:
  pip install lightgbm psycopg2-binary pandas scikit-learn joblib

Usage:
  python train.py

Minimum trades: 300. Will warn and exit early if fewer.
"""

import os, sys, json, joblib
import pandas as pd
import numpy as np
import psycopg2
from datetime import datetime

MIN_TRADES = 300
MODEL_PATH = os.path.join(os.path.dirname(__file__), 'model.pkl')

# ── DB Connection ─────────────────────────────────────────────────────────────

DB_CONFIG = {
    'host':     os.getenv('DB_HOST',     'localhost'),
    'port':     int(os.getenv('DB_PORT', '5432')),
    'user':     os.getenv('DB_USERNAME', 'krishview'),
    'password': os.getenv('DB_PASSWORD', 'krishview_password'),
    'dbname':   os.getenv('DB_DATABASE', 'krishview'),
}

# ── Feature extraction ────────────────────────────────────────────────────────

def load_training_data(conn):
    """
    Join trades with analyses to get both outcome (win/loss) and features.
    Only closed trades with an analysisId and non-null features are used.
    """
    sql = """
        SELECT
            t.pnl,
            t.direction,
            t.confidence,
            t.session,
            EXTRACT(HOUR FROM t.open_time)    AS hour_utc,
            EXTRACT(DOW  FROM t.open_time)    AS day_of_week,
            a.features
        FROM trades t
        JOIN analyses a ON a.id = t.analysis_id
        WHERE t.status = 'CLOSED'
          AND t.pnl IS NOT NULL
          AND a.features IS NOT NULL
        ORDER BY t.open_time ASC
    """
    df = pd.read_sql(sql, conn)
    print(f'Loaded {len(df)} closed trades with analysis features')
    return df

def flatten_features(row):
    """Convert JSONB features column + trade columns into a flat numeric row."""
    f = row['features']
    if isinstance(f, str):
        f = json.loads(f)

    htf = f.get('htfTrend', {})
    ltf = f.get('ltfTrend', {})
    mom = f.get('momentum', {})
    smc = f.get('smc', {})
    fib = f.get('fibonacci', {})

    direction = row.get('direction', 'BUY')
    dir_bias  = 1 if direction == 'BUY' else -1
    htf_bias  = 1 if smc.get('bias') == 'BULLISH' else (-1 if smc.get('bias') == 'BEARISH' else 0)

    fib_zone_map = {
        'below-range': 0, '0-23.6%': 1, '23.6-38.2%': 2,
        '38.2-50%': 3, '50-61.8%': 4, '61.8-78.6%': 5,
        '78.6-100%': 6, 'above-range': 7,
    }
    rsi_zone_map = {'oversold': -1, 'neutral': 0, 'overbought': 1}

    return {
        'direction_bias':   dir_bias,
        'htf_bias':         htf_bias,
        'htf_ema_aligned':  1 if htf.get('aligned') else 0,
        'htf_ema200_dist':  htf.get('ema200Distance', 0),
        'ltf_ema_aligned':  1 if ltf.get('aligned') else 0,
        'ltf_ema200_dist':  ltf.get('ema200Distance', 0),
        'rsi':              mom.get('rsi', 50),
        'rsi_zone':         rsi_zone_map.get(mom.get('rsiZone', 'neutral'), 0),
        'bull_divergence':  1 if mom.get('bullishDivergence') else 0,
        'bear_divergence':  1 if mom.get('bearishDivergence') else 0,
        'atr':              mom.get('atr', 5),
        'fib_zone':         fib_zone_map.get(fib.get('currentZone', '38.2-50%'), 3),
        'ob_present':       1 if smc.get('obPresent') else 0,
        'fvg_present':      1 if smc.get('fvgPresent') else 0,
        'liquidity_swept':  1 if smc.get('liquiditySwept') else 0,
        'bos':              1 if smc.get('bos') else 0,
        'choch':            1 if smc.get('choch') else 0,
        'zone_pct':         smc.get('zonePct', 50),
        'confidence':       float(row.get('confidence', 0)),
        'hour_utc':         float(row.get('hour_utc', 12)),
        'day_of_week':      float(row.get('day_of_week', 1)),
    }

# ── Training ──────────────────────────────────────────────────────────────────

def train():
    try:
        import lightgbm as lgb
        from sklearn.model_selection import StratifiedKFold, cross_val_score
        from sklearn.metrics import roc_auc_score
    except ImportError:
        print('Install: pip install lightgbm scikit-learn joblib pandas psycopg2-binary')
        sys.exit(1)

    conn = psycopg2.connect(**DB_CONFIG)
    df   = load_training_data(conn)
    conn.close()

    if len(df) < MIN_TRADES:
        print(f'⚠ Only {len(df)} trades — need at least {MIN_TRADES} to train.')
        print('  Continue collecting trades. Model will be trained automatically later.')
        sys.exit(0)

    # Build feature matrix
    records = [flatten_features(row) for _, row in df.iterrows()]
    X = pd.DataFrame(records)
    y = (df['pnl'].astype(float) > 0).astype(int)  # 1 = win, 0 = loss

    print(f'\nClass distribution: {y.value_counts().to_dict()}')
    print(f'Features: {list(X.columns)}\n')

    # Train LightGBM
    model = lgb.LGBMClassifier(
        n_estimators=200,
        learning_rate=0.05,
        num_leaves=31,
        max_depth=6,
        min_child_samples=10,
        subsample=0.8,
        colsample_bytree=0.8,
        class_weight='balanced',
        random_state=42,
        verbosity=-1,
    )

    # Cross-validation
    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    scores = cross_val_score(model, X, y, cv=cv, scoring='roc_auc')
    print(f'CV AUC: {scores.mean():.3f} ± {scores.std():.3f}')

    # Final fit on all data
    model.fit(X, y)

    # Feature importances
    importances = sorted(
        zip(X.columns, model.feature_importances_),
        key=lambda x: x[1], reverse=True,
    )
    print('\nTop feature importances:')
    for feat, imp in importances[:10]:
        print(f'  {feat:<25} {imp:.1f}')

    # Save model + metadata
    artifact = {
        'model':        model,
        'features':     list(X.columns),
        'trade_count':  len(df),
        'auc':          float(scores.mean()),
        'trained_at':   datetime.utcnow().isoformat(),
        'version':      f'v{len(df)}',
    }
    joblib.dump(artifact, MODEL_PATH)
    print(f'\n✅ Model saved to {MODEL_PATH}')
    print(f'   Trades used: {len(df)} | AUC: {scores.mean():.3f}')
    print(f'\nRestart bridge.py to load the new model.')

if __name__ == '__main__':
    train()
