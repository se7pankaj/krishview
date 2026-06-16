# KrishView — MT5 Mac Bridge Setup

Connect your local Exness MT5 on Mac to the KrishView NestJS backend.

**Zero changes to `mt5.service.ts` required.** The same `http://localhost:7654` API is served.

---

## How it works

```
NestJS (port 3000)
   ↓  HTTP calls to localhost:7654
bridge_mac.py          ← reads/writes files
   ↓  file system
MQL5/Files/krishview/  ← shared data directory
   ↑  reads/writes files
KrishViewBridge EA     ← runs inside MT5
```

The EA writes market data (candles, tick, account, positions) every second and polls for trade commands. The Python bridge serves those files as the HTTP API that NestJS expects.

---

## Step 1 — Install the EA in MT5

1. Open MT5 on your Mac (Exness terminal)
2. In the menu bar: **File → Open Data Folder**
3. Navigate to `MQL5/Experts/`
4. Copy `KrishViewBridge.mq5` into that folder
5. Back in MT5: press **F5** (or Navigator panel → Refresh)
6. In the Navigator panel: **Expert Advisors → KrishViewBridge**
7. Drag it onto any XAUUSD chart (any timeframe works — M1 recommended for fast tick updates)
8. In the EA settings dialog:
   - Set **Symbol** = `XAUUSD`
   - **Allow live trading** = ✅ (required for order execution)
   - Click **OK**
9. You should see a smiley face 😊 in the chart top-right corner

**Verify the EA is writing files:**
Open Data Folder → `MQL5/Files/krishview/` — you should see `account.json`, `tick_XAUUSD.json`, `candles_XAUUSD_H1.json`, etc.

---

## Step 2 — Find your MT5 Files path (if bridge can't find it)

The bridge auto-detects common paths. If it fails, run:

```bash
# Option A: look inside Exness app
ls ~/Library/"Application Support"/net.metaquotes.metatrader5/MQL5/Files/krishview/

# Option B: look in Wine paths
find ~/Library -name "krishview" -type d 2>/dev/null

# Option C: check inside CrossOver bottle
find ~/Library -path "*/MQL5/Files/krishview" 2>/dev/null
```

Once found, run the bridge with:
```bash
MT5_FILES_DIR=/path/to/found/krishview  python3 bridge_mac.py
```

---

## Step 3 — Run the Python bridge

```bash
cd krishview/api/mt5_bridge

# Install Flask (one time)
pip3 install flask

# Start bridge
python3 bridge_mac.py
```

Expected output:
```
09:15:03 [INFO] MT5 data directory: /Users/you/Library/Application Support/.../krishview
09:15:03 [INFO] KrishView Mac Bridge starting on http://localhost:7654
09:15:03 [INFO] Make sure KrishViewBridge EA is running in MT5!
09:15:03 [INFO] Test: curl http://localhost:7654/ping
```

---

## Step 4 — Verify everything works

```bash
# Should return {"status":"ok"}
curl http://localhost:7654/ping

# Account balance
curl http://localhost:7654/account

# Current price
curl http://localhost:7654/price/XAUUSD

# D1 candles (returns 200 bars)
curl "http://localhost:7654/candles?symbol=XAUUSD&timeframe=D1&count=10"

# Open positions
curl "http://localhost:7654/positions?symbol=XAUUSD"

# Debug: see all file ages
curl http://localhost:7654/debug
```

---

## Step 5 — Start NestJS

```bash
cd krishview/api
npm run start:dev
```

MT5_BRIDGE_URL in `.env` is already `http://localhost:7654` — nothing changes.

---

## Keeping the bridge running

Run both in separate terminals (or use `tmux`):

**Terminal 1 — Bridge:**
```bash
python3 krishview/api/mt5_bridge/bridge_mac.py
```

**Terminal 2 — NestJS:**
```bash
cd krishview/api && npm run start:dev
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `curl /ping` returns 503 | EA not running in MT5, or Files path wrong — check `curl /debug` |
| Candles missing | EA needs time to write initial data — wait 5s after attaching |
| Orders not executing | Enable "Allow live trading" in EA settings + MT5 AutoTrading button |
| Wrong Files path | Set `MT5_FILES_DIR` env var (see Step 2) |
| Flask not found | `pip3 install flask` |

---

## Data refresh rates

| Data | Updated |
|---|---|
| Tick (bid/ask) | Every tick (< 1 second on XAUUSD) |
| Account / Positions | Every 1 second (timer) |
| M5 candles | Every 5-minute candle close |
| M15 candles | Every 15-minute candle close |
| H1 candles | Every hour |
| D1 candles | Every day + on startup |

---

## Command latency (for orders)

NestJS sends `POST /order` → bridge writes `cmd_order.json` → EA reads it on next tick → EA executes → EA writes `result_order.json` → bridge reads it → returns to NestJS.

Typical round-trip: **< 2 seconds** on XAUUSD (active market).
Bridge timeout: **5 seconds** before returning 504.
