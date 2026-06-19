#!/usr/bin/env python3
"""
bridge_mac.py — KrishView MT5 HTTP Bridge for Mac
==================================================
Works with KrishViewBridge.mq5 EA running inside MT5 on Mac.

Architecture:
  NestJS (mt5.service.ts) → HTTP:7654 → THIS SCRIPT → Files/krishview/ ← MT5 EA

The EA writes market data files every second.
This script serves them as JSON HTTP on port 7654 (same API as bridge.py on Windows).
mt5.service.ts requires ZERO changes.

Usage:
  pip3 install flask
  python3 bridge_mac.py

Environment variable (optional override):
  MT5_FILES_DIR=/path/to/MT5/MQL5/Files/krishview  python3 bridge_mac.py
"""

import os
import json
import time
import glob
import logging
from pathlib import Path
from typing import Optional, Dict, Any
from flask import Flask, request, jsonify, abort

# ─── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("KrishViewBridge")

# ─── MT5 Files directory ──────────────────────────────────────────────────────
# Exness MT5 on Mac (via CrossOver/Wine) typically stores MQL5 Files at one of:
#   ~/Library/Application Support/net.metaquotes.metatrader5/MQL5/Files/
#   ~/.wine/drive_c/users/<user>/AppData/Roaming/MetaQuotes/Terminal/<id>/MQL5/Files/
# Override with MT5_FILES_DIR environment variable if path differs.

def _find_mt5_files_dir() -> str:
    """Auto-detect MT5 Files directory on Mac."""
    candidates = [
        # Wine-based MT5 (Exness on Mac — most common)
        Path.home() / "Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/MQL5/Files",
        # Native Mac MT5 app
        Path.home() / "Library/Application Support/net.metaquotes.metatrader5/MQL5/Files",
        # Generic MT5 Mac
        Path.home() / "Library/Application Support/MetaTrader 5/MQL5/Files",
        # CrossOver paths
        *Path.home().glob("Library/Application Support/CrossOver/Bottles/*/drive_c/Program Files/MetaTrader 5/MQL5/Files"),
        # Wine ~/.wine paths
        *Path.home().glob(".wine/drive_c/Program Files/MetaTrader 5/MQL5/Files"),
    ]
    for c in candidates:
        krishview_dir = Path(c) / "krishview"
        if krishview_dir.exists():
            return str(krishview_dir)
        if Path(c).exists():
            return str(Path(c) / "krishview")
    # Fallback to Wine path (most common on Mac)
    return str(Path.home() / "Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/MQL5/Files/krishview")

MT5_FILES_DIR = os.environ.get("MT5_FILES_DIR") or _find_mt5_files_dir()
PORT = int(os.environ.get("PORT", "7654"))

log.info(f"MT5 data directory: {MT5_FILES_DIR}")

app = Flask(__name__)

# ─── File helpers ─────────────────────────────────────────────────────────────

def data_path(filename: str) -> str:
    return os.path.join(MT5_FILES_DIR, filename)

def read_json(filename: str, default: Any = None) -> Optional[Dict]:
    """Read a JSON data file written by the EA."""
    path = data_path(filename)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except json.JSONDecodeError as e:
        log.warning(f"JSON parse error in {filename}: {e}")
        return default

def write_json(filename: str, data: dict):
    """Write a command file for the EA to pick up."""
    os.makedirs(MT5_FILES_DIR, exist_ok=True)
    path = data_path(filename)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)

def wait_for_result(filename: str, timeout_sec: float = 5.0) -> Optional[Dict]:
    """
    Poll for a result file that the EA writes after executing a command.
    The EA picks up commands on every tick (typ. < 1 second on XAUUSD).
    Timeout: 5 seconds is very conservative.
    """
    path = data_path(filename)
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                os.remove(path)
                return data
            except (json.JSONDecodeError, OSError):
                pass  # EA may still be writing — retry
        time.sleep(0.1)
    return None

# ─── GET endpoints ────────────────────────────────────────────────────────────

@app.get("/ping")
def ping():
    acct = read_json("account.json")
    if acct:
        return jsonify({"status": "ok"})
    return jsonify({"status": "error", "msg": "EA not running — no account.json"}), 503


@app.get("/account")
def account():
    data = read_json("account.json")
    if data is None:
        return jsonify({"error": "No account data — is KrishViewBridge EA running in MT5?"}), 503
    return jsonify(data)


@app.get("/price/<symbol>")
def price(symbol: str):
    data = read_json(f"tick_{symbol}.json")
    if data is None:
        return jsonify({"error": f"No tick data for {symbol}"}), 503
    return jsonify(data)


@app.get("/candles")
def candles():
    symbol    = request.args.get("symbol", "XAUUSD")
    timeframe = request.args.get("timeframe", "H1")
    count     = int(request.args.get("count", 200))

    data = read_json(f"candles_{symbol}_{timeframe}.json")
    if data is None:
        return jsonify({
            "candles": [],
            "error": f"No candle data for {symbol} {timeframe} — EA may not have written it yet",
        }), 503

    all_candles = data.get("candles", [])
    # Return the most recent 'count' candles (EA writes oldest-first)
    return jsonify({"candles": all_candles[-count:]})


@app.get("/history_all")
def history_all():
    """All closed deals for the last 90 days, written by WriteHistoryAll in the EA.
    EA refreshes this file on start and every 60 seconds."""
    data = read_json("history_all.json")
    if data is None:
        return jsonify([])   # EA not yet written it — return empty (not error)
    return jsonify(data.get("deals", []))


@app.get("/positions")
def positions():
    symbol = request.args.get("symbol", "XAUUSD")
    data = read_json("positions.json")
    if data is None:
        return jsonify({"positions": []})
    filtered = [p for p in data.get("positions", []) if p.get("symbol") == symbol]
    return jsonify({"positions": filtered})

# ─── POST endpoints ───────────────────────────────────────────────────────────

@app.post("/order")
def order():
    body = request.get_json(force=True)
    if not body:
        return jsonify({"error": "Missing JSON body"}), 400

    write_json("cmd_order.json", body)
    result = wait_for_result("result_order.json")

    if result is None:
        return jsonify({"error": "Order timeout — EA did not respond within 5 s"}), 504
    if not result.get("ok"):
        return jsonify({"error": f"Order rejected by MT5 (error {result.get('error', '?')})"}), 400

    return jsonify({
        "ticket":    result.get("ticket", 0),
        "price":     result.get("price", 0),
        "lots":      result.get("lots", 0),
        "direction": result.get("direction", ""),
        "comment":   result.get("comment", ""),
    })


@app.post("/close")
def close():
    body = request.get_json(force=True)
    if not body:
        return jsonify({"error": "Missing JSON body"}), 400

    write_json("cmd_close.json", body)
    result = wait_for_result("result_close.json")

    if result is None:
        return jsonify({"error": "Close timeout"}), 504
    return jsonify({"ok": result.get("ok", False), "profit": result.get("profit", 0)})


@app.post("/modify")
def modify():
    body = request.get_json(force=True)
    if not body:
        return jsonify({"error": "Missing JSON body"}), 400

    write_json("cmd_modify.json", body)
    result = wait_for_result("result_modify.json")

    if result is None:
        return jsonify({"error": "Modify timeout"}), 504
    return jsonify({"ok": result.get("ok", False)})


@app.post("/partial_close")
def partial_close():
    body = request.get_json(force=True)
    if not body:
        return jsonify({"error": "Missing JSON body"}), 400

    write_json("cmd_partial_close.json", body)
    result = wait_for_result("result_partial_close.json")

    if result is None:
        return jsonify({"error": "Partial close timeout"}), 504
    return jsonify({"ok": result.get("ok", False), "profit": result.get("profit", 0)})


@app.post("/trade_history")
def trade_history():
    body = request.get_json(force=True)
    if not body:
        return jsonify({"error": "Missing JSON body"}), 400

    write_json("cmd_trade_history.json", body)
    result = wait_for_result("result_trade_history.json")

    if result is None:
        return jsonify({"error": "Trade history timeout"}), 504

    return jsonify({
        "ticket":    result.get("ticket", 0),
        "pnl":       result.get("pnl", 0),
        "exitPrice": result.get("exitPrice", 0),
        "exitTime":  result.get("exitTime", ""),
    })

# ─── Health / debug ───────────────────────────────────────────────────────────

@app.get("/debug")
def debug():
    """Check which data files exist and their ages."""
    files = ["account.json", "tick_XAUUSD.json",
             "candles_XAUUSD_D1.json", "candles_XAUUSD_H1.json",
             "candles_XAUUSD_M15.json", "candles_XAUUSD_M5.json",
             "positions.json"]
    status = {}
    for f in files:
        path = data_path(f)
        if os.path.exists(path):
            age = time.time() - os.path.getmtime(path)
            status[f] = f"✅ {age:.1f}s ago"
        else:
            status[f] = "❌ missing"
    return jsonify({"mt5_files_dir": MT5_FILES_DIR, "files": status})

# ─── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    os.makedirs(MT5_FILES_DIR, exist_ok=True)
    log.info(f"KrishView Mac Bridge starting on http://localhost:{PORT}")
    log.info(f"Make sure KrishViewBridge EA is running in MT5!")
    log.info(f"Test: curl http://localhost:{PORT}/ping")
    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True)
