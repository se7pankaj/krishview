//+------------------------------------------------------------------+
//|  KrishViewBridge.mq5 — File-IPC bridge for KrishView (Mac)      |
//|  ============================================================     |
//|  Install this EA in MT5 → Experts folder, attach to any chart.   |
//|  It writes market data to Files/krishview/ every second and       |
//|  polls for trade commands written by bridge_mac.py.               |
//|                                                                   |
//|  NO DLLs required — pure MQL5 file I/O, works on Mac via Wine.   |
//+------------------------------------------------------------------+
#property copyright "KrishView"
#property version   "1.00"
#property description "File-IPC bridge for KrishView trading system"
#property strict

//--- Inputs
input string InpSymbol   = "XAUUSD";   // Symbol to export
input int    InpTimerSec = 1;           // Data refresh interval (seconds)

//--- Internal state for TF change detection
datetime g_lastD1  = 0;
datetime g_lastH1  = 0;
datetime g_lastM15 = 0;
datetime g_lastM5  = 0;
int      g_timerCount = 0;   // used to throttle WriteHistoryAll to once per minute

//+------------------------------------------------------------------+
//| EA Init                                                           |
//+------------------------------------------------------------------+
int OnInit()
{
   EventSetTimer(InpTimerSec);

   // Create krishview directory (silently fails if already exists)
   // MT5 will create it when we first write a file with that prefix

   Print("KrishViewBridge: initialising for ", InpSymbol);

   // Write initial full data set on start
   WriteAccount();
   WriteTick(InpSymbol);
   WriteCandles(InpSymbol, PERIOD_D1,  200, "D1");
   WriteCandles(InpSymbol, PERIOD_H1,  200, "H1");
   WriteCandles(InpSymbol, PERIOD_M15, 200, "M15");
   WriteCandles(InpSymbol, PERIOD_M5,  200, "M5");
   WritePositions(InpSymbol);
   WriteHistoryAll(InpSymbol);   // Write full deal history immediately on start

   Print("KrishViewBridge: started. Writing to MQL5/Files/krishview/");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("KrishViewBridge: stopped.");
}

//+------------------------------------------------------------------+
//| OnTick — fast path: tick + command check                          |
//+------------------------------------------------------------------+
void OnTick()
{
   WriteTick(InpSymbol);
   CheckAndExecuteCommands();
}

//+------------------------------------------------------------------+
//| OnTimer — slow path: account, positions, candles                  |
//+------------------------------------------------------------------+
void OnTimer()
{
   WriteAccount();
   WritePositions(InpSymbol);

   // M5 — update every 5 minutes
   datetime m5time = iTime(InpSymbol, PERIOD_M5, 0);
   if (m5time != g_lastM5) {
      g_lastM5 = m5time;
      WriteCandles(InpSymbol, PERIOD_M5, 200, "M5");
   }

   // M15 — update every 15 minutes
   datetime m15time = iTime(InpSymbol, PERIOD_M15, 0);
   if (m15time != g_lastM15) {
      g_lastM15 = m15time;
      WriteCandles(InpSymbol, PERIOD_M15, 200, "M15");
   }

   // H1 — update every hour
   datetime h1time = iTime(InpSymbol, PERIOD_H1, 0);
   if (h1time != g_lastH1) {
      g_lastH1 = h1time;
      WriteCandles(InpSymbol, PERIOD_H1, 200, "H1");
   }

   // D1 — update every day
   datetime d1time = iTime(InpSymbol, PERIOD_D1, 0);
   if (d1time != g_lastD1) {
      g_lastD1 = d1time;
      WriteCandles(InpSymbol, PERIOD_D1, 200, "D1");
   }

   // History — refresh once per minute
   g_timerCount++;
   if (g_timerCount >= 60) {
      g_timerCount = 0;
      WriteHistoryAll(InpSymbol);
   }

   CheckAndExecuteCommands();
}

//+------------------------------------------------------------------+
//| Write account info                                                |
//+------------------------------------------------------------------+
void WriteAccount()
{
   int fh = FileOpen("krishview\\account.json", FILE_WRITE | FILE_TXT | FILE_ANSI);
   if (fh == INVALID_HANDLE) return;

   FileWriteString(fh, StringFormat(
      "{"
         "\"login\":%d,"
         "\"balance\":%.2f,"
         "\"equity\":%.2f,"
         "\"margin\":%.2f,"
         "\"free_margin\":%.2f,"
         "\"currency\":\"%s\","
         "\"company\":\"%s\","
         "\"server\":\"%s\","
         "\"leverage\":%d"
      "}",
      (int)AccountInfoInteger(ACCOUNT_LOGIN),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoDouble(ACCOUNT_MARGIN),
      AccountInfoDouble(ACCOUNT_FREEMARGIN),
      AccountInfoString(ACCOUNT_CURRENCY),
      AccountInfoString(ACCOUNT_COMPANY),
      AccountInfoString(ACCOUNT_SERVER),
      (int)AccountInfoInteger(ACCOUNT_LEVERAGE)
   ));
   FileClose(fh);
}

//+------------------------------------------------------------------+
//| Write latest tick for a symbol                                    |
//+------------------------------------------------------------------+
void WriteTick(string symbol)
{
   MqlTick tick;
   if (!SymbolInfoTick(symbol, tick)) return;

   double spread = (tick.bid > 0) ? ((tick.ask - tick.bid) / _Point) : 0;

   string fname = "krishview\\tick_" + symbol + ".json";
   int fh = FileOpen(fname, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if (fh == INVALID_HANDLE) return;

   FileWriteString(fh, StringFormat(
      "{"
         "\"symbol\":\"%s\","
         "\"bid\":%.5f,"
         "\"ask\":%.5f,"
         "\"spread\":%.1f,"
         "\"time\":\"%s\""
      "}",
      symbol,
      tick.bid,
      tick.ask,
      spread,
      TimeToString(tick.time, TIME_DATE | TIME_SECONDS)
   ));
   FileClose(fh);
}

//+------------------------------------------------------------------+
//| Write candle history for symbol + timeframe                       |
//+------------------------------------------------------------------+
void WriteCandles(string symbol, ENUM_TIMEFRAMES tf, int count, string tfName)
{
   MqlRates rates[];
   int copied = CopyRates(symbol, tf, 0, count, rates);
   if (copied <= 0) {
      Print("KrishViewBridge: CopyRates failed for ", symbol, " ", tfName);
      return;
   }

   string fname = "krishview\\candles_" + symbol + "_" + tfName + ".json";
   int fh = FileOpen(fname, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if (fh == INVALID_HANDLE) return;

   FileWriteString(fh, "{\"candles\":[");

   for (int i = 0; i < copied; i++) {
      if (i > 0) FileWriteString(fh, ",");
      FileWriteString(fh, StringFormat(
         "{"
            "\"time\":\"%s\","
            "\"open\":%.5f,"
            "\"high\":%.5f,"
            "\"low\":%.5f,"
            "\"close\":%.5f,"
            "\"volume\":%d"
         "}",
         TimeToString(rates[i].time, TIME_DATE | TIME_SECONDS),
         rates[i].open,
         rates[i].high,
         rates[i].low,
         rates[i].close,
         (int)rates[i].tick_volume
      ));
   }

   FileWriteString(fh, "]}");
   FileClose(fh);
}

//+------------------------------------------------------------------+
//| Write open positions for a symbol                                 |
//+------------------------------------------------------------------+
void WritePositions(string symbol)
{
   int fh = FileOpen("krishview\\positions.json", FILE_WRITE | FILE_TXT | FILE_ANSI);
   if (fh == INVALID_HANDLE) return;

   FileWriteString(fh, "{\"positions\":[");

   bool first = true;
   int total  = PositionsTotal();

   for (int i = 0; i < total; i++) {
      ulong ticket = PositionGetTicket(i);
      if (!PositionSelectByTicket(ticket)) continue;
      if (PositionGetString(POSITION_SYMBOL) != symbol) continue;

      if (!first) FileWriteString(fh, ",");
      first = false;

      string posType = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? "BUY" : "SELL";

      FileWriteString(fh, StringFormat(
         "{"
            "\"ticket\":%d,"
            "\"symbol\":\"%s\","
            "\"type\":\"%s\","
            "\"lots\":%.2f,"
            "\"open_price\":%.5f,"
            "\"current_price\":%.5f,"
            "\"sl\":%.5f,"
            "\"tp\":%.5f,"
            "\"profit\":%.2f,"
            "\"magic\":%d,"
            "\"comment\":\"%s\","
            "\"open_time\":\"%s\""
         "}",
         (int)ticket,
         PositionGetString(POSITION_SYMBOL),
         posType,
         PositionGetDouble(POSITION_VOLUME),
         PositionGetDouble(POSITION_PRICE_OPEN),
         PositionGetDouble(POSITION_PRICE_CURRENT),
         PositionGetDouble(POSITION_SL),
         PositionGetDouble(POSITION_TP),
         PositionGetDouble(POSITION_PROFIT),
         (int)PositionGetInteger(POSITION_MAGIC),
         PositionGetString(POSITION_COMMENT),
         TimeToString((datetime)PositionGetInteger(POSITION_TIME), TIME_DATE | TIME_SECONDS)
      ));
   }

   FileWriteString(fh, "]}");
   FileClose(fh);
}

//+------------------------------------------------------------------+
//| Poll for and execute pending commands from bridge_mac.py          |
//+------------------------------------------------------------------+
void CheckAndExecuteCommands()
{
   ExecOrder();
   ExecClose();
   ExecModify();
   ExecPartialClose();
   ExecTradeHistory();
}

//--- POST /order
void ExecOrder()
{
   if (!FileIsExist("krishview\\cmd_order.json")) return;

   string json = ReadFile("krishview\\cmd_order.json");
   FileDelete("krishview\\cmd_order.json");

   string symbol  = JsonString(json, "symbol");
   string action  = JsonString(json, "action");
   double lots    = JsonDouble(json, "lots");
   double sl      = JsonDouble(json, "sl");
   double tp      = JsonDouble(json, "tp");
   int    magic   = (int)JsonDouble(json, "magic");
   string comment = JsonString(json, "comment");

   MqlTradeRequest req = {};
   MqlTradeResult  res = {};

   req.action       = TRADE_ACTION_DEAL;
   req.symbol       = symbol;
   req.volume       = lots;
   req.sl           = sl;
   req.tp           = tp;
   req.magic        = magic;
   req.comment      = comment;
   req.type_filling = ORDER_FILLING_RETURN;  // Exness/most brokers: use RETURN not IOC
   req.deviation    = 20;

   if (action == "BUY") {
      req.type  = ORDER_TYPE_BUY;
      req.price = SymbolInfoDouble(symbol, SYMBOL_ASK);
   } else {
      req.type  = ORDER_TYPE_SELL;
      req.price = SymbolInfoDouble(symbol, SYMBOL_BID);
   }

   bool ok = OrderSend(req, res);
   int  err = GetLastError();
   // res.retcode is the actual MT5 server code (10xxx), err is the local MQL5 code
   Print("KrishViewBridge: OrderSend retcode=", res.retcode, " comment=", res.comment, " err=", err);

   int fh = FileOpen("krishview\\result_order.json", FILE_WRITE | FILE_TXT | FILE_ANSI);
   if (fh == INVALID_HANDLE) return;
   FileWriteString(fh, StringFormat(
      "{"
         "\"ok\":%s,"
         "\"ticket\":%d,"
         "\"price\":%.5f,"
         "\"lots\":%.2f,"
         "\"direction\":\"%s\","
         "\"comment\":\"%s\","
         "\"error\":%d,"
         "\"retcode\":%d"
      "}",
      ok ? "true" : "false",
      (int)res.deal,
      res.price,
      lots,
      action,
      comment,
      err,
      (int)res.retcode
   ));
   FileClose(fh);

   if (ok) Print("KrishViewBridge: Order placed ticket=", res.deal, " ", action, " ", lots, " lots");
   else    Print("KrishViewBridge: Order FAILED retcode=", res.retcode, " err=", err);
}

//--- POST /close
void ExecClose()
{
   if (!FileIsExist("krishview\\cmd_close.json")) return;

   string json = ReadFile("krishview\\cmd_close.json");
   FileDelete("krishview\\cmd_close.json");

   ulong ticket = (ulong)JsonDouble(json, "ticket");

   if (!PositionSelectByTicket(ticket)) {
      WriteError("krishview\\result_close.json", "Position not found");
      return;
   }

   string sym    = PositionGetString(POSITION_SYMBOL);
   double lots   = PositionGetDouble(POSITION_VOLUME);
   double profit = PositionGetDouble(POSITION_PROFIT);
   long   magic  = PositionGetInteger(POSITION_MAGIC);

   MqlTradeRequest req = {};
   MqlTradeResult  res = {};

   req.action       = TRADE_ACTION_DEAL;
   req.symbol       = sym;
   req.volume       = lots;
   req.magic        = (int)magic;
   req.position     = ticket;
   req.type_filling = ORDER_FILLING_IOC;
   req.deviation    = 10;

   if (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) {
      req.type  = ORDER_TYPE_SELL;
      req.price = SymbolInfoDouble(sym, SYMBOL_BID);
   } else {
      req.type  = ORDER_TYPE_BUY;
      req.price = SymbolInfoDouble(sym, SYMBOL_ASK);
   }

   bool ok  = OrderSend(req, res);
   int  err = GetLastError();

   int fh = FileOpen("krishview\\result_close.json", FILE_WRITE | FILE_TXT | FILE_ANSI);
   if (fh == INVALID_HANDLE) return;
   FileWriteString(fh, StringFormat(
      "{\"ok\":%s,\"profit\":%.2f,\"error\":%d}",
      ok ? "true" : "false", profit, err
   ));
   FileClose(fh);
}

//--- POST /modify
void ExecModify()
{
   if (!FileIsExist("krishview\\cmd_modify.json")) return;

   string json = ReadFile("krishview\\cmd_modify.json");
   FileDelete("krishview\\cmd_modify.json");

   ulong  ticket = (ulong)JsonDouble(json, "ticket");
   double sl     = JsonDouble(json, "sl");
   double tp     = JsonDouble(json, "tp");

   if (!PositionSelectByTicket(ticket)) {
      WriteError("krishview\\result_modify.json", "Position not found");
      return;
   }

   MqlTradeRequest req = {};
   MqlTradeResult  res = {};

   req.action   = TRADE_ACTION_SLTP;
   req.symbol   = PositionGetString(POSITION_SYMBOL);
   req.sl       = sl;
   req.tp       = tp;
   req.position = ticket;

   bool ok  = OrderSend(req, res);
   int  err = GetLastError();

   int fh = FileOpen("krishview\\result_modify.json", FILE_WRITE | FILE_TXT | FILE_ANSI);
   if (fh == INVALID_HANDLE) return;
   FileWriteString(fh, StringFormat("{\"ok\":%s,\"error\":%d}", ok ? "true" : "false", err));
   FileClose(fh);
}

//--- POST /partial_close
void ExecPartialClose()
{
   if (!FileIsExist("krishview\\cmd_partial_close.json")) return;

   string json = ReadFile("krishview\\cmd_partial_close.json");
   FileDelete("krishview\\cmd_partial_close.json");

   ulong  ticket     = (ulong)JsonDouble(json, "ticket");
   double closeLots  = JsonDouble(json, "lots");

   if (!PositionSelectByTicket(ticket)) {
      WriteError("krishview\\result_partial_close.json", "Position not found");
      return;
   }

   string sym        = PositionGetString(POSITION_SYMBOL);
   double totalLots  = PositionGetDouble(POSITION_VOLUME);
   double profit     = PositionGetDouble(POSITION_PROFIT);
   long   magic      = PositionGetInteger(POSITION_MAGIC);

   // Partial profit estimate (proportional)
   double partialPnl = (totalLots > 0) ? profit * (closeLots / totalLots) : 0;

   MqlTradeRequest req = {};
   MqlTradeResult  res = {};

   req.action       = TRADE_ACTION_DEAL;
   req.symbol       = sym;
   req.volume       = closeLots;
   req.magic        = (int)magic;
   req.position     = ticket;
   req.type_filling = ORDER_FILLING_IOC;
   req.deviation    = 10;

   if (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) {
      req.type  = ORDER_TYPE_SELL;
      req.price = SymbolInfoDouble(sym, SYMBOL_BID);
   } else {
      req.type  = ORDER_TYPE_BUY;
      req.price = SymbolInfoDouble(sym, SYMBOL_ASK);
   }

   bool ok  = OrderSend(req, res);
   int  err = GetLastError();

   int fh = FileOpen("krishview\\result_partial_close.json", FILE_WRITE | FILE_TXT | FILE_ANSI);
   if (fh == INVALID_HANDLE) return;
   FileWriteString(fh, StringFormat(
      "{\"ok\":%s,\"profit\":%.2f,\"error\":%d}",
      ok ? "true" : "false", partialPnl, err
   ));
   FileClose(fh);
}

//--- Write all closed deals to history_all.json (last 90 days)
//    Called from OnTimer once per minute + on EA start
void WriteHistoryAll(string symbol)
{
   datetime from = TimeCurrent() - 90 * 86400;
   if (!HistorySelect(from, TimeCurrent())) {
      Print("WriteHistoryAll: HistorySelect failed");
      return;
   }

   int fh = FileOpen("krishview\\history_all.json", FILE_WRITE | FILE_TXT | FILE_ANSI);
   if (fh == INVALID_HANDLE) return;

   FileWriteString(fh, "{\"deals\":[");

   bool first = true;
   int total  = HistoryDealsTotal();

   for (int i = 0; i < total; i++) {
      ulong deal = HistoryDealGetTicket(i);

      // Only closing deals (DEAL_ENTRY_OUT = position exit)
      if ((ENUM_DEAL_ENTRY)HistoryDealGetInteger(deal, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;

      // Only our symbol
      if (HistoryDealGetString(deal, DEAL_SYMBOL) != symbol) continue;

      long   posId     = HistoryDealGetInteger(deal, DEAL_POSITION_ID);
      string dealType  = (HistoryDealGetInteger(deal, DEAL_TYPE) == DEAL_TYPE_BUY) ? "BUY" : "SELL";
      double lots      = HistoryDealGetDouble(deal, DEAL_VOLUME);
      double exitPrice = HistoryDealGetDouble(deal, DEAL_PRICE);
      double pnl       = HistoryDealGetDouble(deal, DEAL_PROFIT)
                       + HistoryDealGetDouble(deal, DEAL_SWAP)
                       + HistoryDealGetDouble(deal, DEAL_COMMISSION);
      datetime exitTime = (datetime)HistoryDealGetInteger(deal, DEAL_TIME);

      // Find the opening deal for this position to get entry price + type
      double entryPrice = exitPrice;
      string entryType  = dealType;
      for (int j = 0; j < total; j++) {
         ulong oDeal = HistoryDealGetTicket(j);
         if ((ENUM_DEAL_ENTRY)HistoryDealGetInteger(oDeal, DEAL_ENTRY) != DEAL_ENTRY_IN) continue;
         if (HistoryDealGetInteger(oDeal, DEAL_POSITION_ID) != posId) continue;
         entryPrice = HistoryDealGetDouble(oDeal, DEAL_PRICE);
         entryType  = (HistoryDealGetInteger(oDeal, DEAL_TYPE) == DEAL_TYPE_BUY) ? "BUY" : "SELL";
         break;
      }

      if (!first) FileWriteString(fh, ",");
      first = false;

      FileWriteString(fh, StringFormat(
         "{"
            "\"ticket\":%d,"
            "\"deal\":%d,"
            "\"symbol\":\"%s\","
            "\"type\":\"%s\","
            "\"lots\":%.2f,"
            "\"entryPrice\":%.5f,"
            "\"exitPrice\":%.5f,"
            "\"pnl\":%.2f,"
            "\"exitTime\":\"%s\""
         "}",
         (int)posId,
         (int)deal,
         symbol,
         entryType,
         lots,
         entryPrice,
         exitPrice,
         pnl,
         TimeToString(exitTime, TIME_DATE | TIME_SECONDS)
      ));
   }

   FileWriteString(fh, "]}");
   FileClose(fh);
}

//--- POST /trade_history
void ExecTradeHistory()
{
   if (!FileIsExist("krishview\\cmd_trade_history.json")) return;

   string json = ReadFile("krishview\\cmd_trade_history.json");
   FileDelete("krishview\\cmd_trade_history.json");

   long ticket = (long)JsonDouble(json, "ticket");

   // Scan last 90 days of history
   datetime from = TimeCurrent() - 90 * 86400;
   if (!HistorySelect(from, TimeCurrent())) {
      WriteError("krishview\\result_trade_history.json", "HistorySelect failed");
      return;
   }

   double pnl        = 0;
   double exitPrice  = 0;
   string exitTime   = "";
   bool   found      = false;

   int total = HistoryDealsTotal();
   for (int i = 0; i < total; i++) {
      ulong deal = HistoryDealGetTicket(i);
      if (HistoryDealGetInteger(deal, DEAL_POSITION_ID) == ticket &&
          HistoryDealGetInteger(deal, DEAL_ENTRY) == DEAL_ENTRY_OUT) {
         pnl       = HistoryDealGetDouble(deal, DEAL_PROFIT)
                   + HistoryDealGetDouble(deal, DEAL_SWAP)
                   + HistoryDealGetDouble(deal, DEAL_COMMISSION);
         exitPrice = HistoryDealGetDouble(deal, DEAL_PRICE);
         exitTime  = TimeToString((datetime)HistoryDealGetInteger(deal, DEAL_TIME), TIME_DATE | TIME_SECONDS);
         found     = true;
         break;
      }
   }

   int fh = FileOpen("krishview\\result_trade_history.json", FILE_WRITE | FILE_TXT | FILE_ANSI);
   if (fh == INVALID_HANDLE) return;
   FileWriteString(fh, StringFormat(
      "{"
         "\"ticket\":%d,"
         "\"pnl\":%.2f,"
         "\"exitPrice\":%.5f,"
         "\"exitTime\":\"%s\","
         "\"found\":%s"
      "}",
      (int)ticket, pnl, exitPrice, exitTime,
      found ? "true" : "false"
   ));
   FileClose(fh);
}

//+------------------------------------------------------------------+
//| File I/O helpers                                                  |
//+------------------------------------------------------------------+

string ReadFile(string fname)
{
   int fh = FileOpen(fname, FILE_READ | FILE_TXT | FILE_ANSI);
   if (fh == INVALID_HANDLE) return "";
   string content = "";
   while (!FileIsEnding(fh))
      content += FileReadString(fh);
   FileClose(fh);
   return content;
}

void WriteError(string fname, string msg)
{
   int fh = FileOpen(fname, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if (fh == INVALID_HANDLE) return;
   FileWriteString(fh, StringFormat("{\"ok\":false,\"error\":\"%s\"}", msg));
   FileClose(fh);
}

//+------------------------------------------------------------------+
//| Minimal JSON parsers (no library dependency)                      |
//| Handles: "key":"value" and "key":number                          |
//+------------------------------------------------------------------+

string JsonString(string json, string key)
{
   string needle = "\"" + key + "\":\"";
   int pos = StringFind(json, needle);
   if (pos < 0) return "";
   pos += StringLen(needle);
   int end = StringFind(json, "\"", pos);
   if (end < 0) return "";
   return StringSubstr(json, pos, end - pos);
}

double JsonDouble(string json, string key)
{
   string needle = "\"" + key + "\":";
   int pos = StringFind(json, needle);
   if (pos < 0) return 0.0;
   pos += StringLen(needle);
   // Skip any leading whitespace
   while (pos < StringLen(json) && StringGetCharacter(json, pos) == ' ') pos++;
   int start = pos;
   // Read until non-numeric char (digits, dot, minus, e/E for scientific)
   while (pos < StringLen(json)) {
      ushort c = StringGetCharacter(json, pos);
      if (c != '.' && c != '-' && c != 'e' && c != 'E' && (c < '0' || c > '9')) break;
      pos++;
   }
   if (pos == start) return 0.0;
   return StringToDouble(StringSubstr(json, start, pos - start));
}
