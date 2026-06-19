/**
 * common/symbol-registry.ts — Per-Symbol Trading Config
 * =======================================================
 * Each symbol knows its own optimal sessions, spread tolerance,
 * pip value, and display metadata.
 *
 * Sessions are defined in UTC hours. The killzone gate in
 * TradingService reads from this registry based on the active symbol,
 * so switching pairs automatically changes the active window.
 */

export interface SymbolSession {
  name: string;      // e.g. 'London'
  startUtc: number;  // inclusive
  endUtc: number;    // exclusive
}

export interface SymbolConfig {
  symbol:          string;
  label:           string;   // display name
  category:        'metals' | 'forex' | 'indices' | 'commodities' | 'crypto';
  emoji:           string;
  sessions:        SymbolSession[];
  spreadLimit:     number;   // max acceptable spread in broker points
  pipSize:         number;   // minimum price increment (0.0001 forex, 0.01 gold/JPY, 1 indices/BTC)
  pipValuePerLot:  number;   // USD value of 1 pip movement per 1 standard lot — adjust per broker
  description:     string;
}

export const SYMBOL_REGISTRY: Record<string, SymbolConfig> = {

  // ── Metals ──────────────────────────────────────────────────────────────────
  XAUUSD: {
    symbol: 'XAUUSD', label: 'Gold / USD', category: 'metals', emoji: '🥇',
    sessions: [
      { name: 'London',   startUtc: 7,  endUtc: 10 },
      { name: 'New York', startUtc: 13, endUtc: 17 },
    ],
    spreadLimit:    200,    // broker points (0.02–0.05 USD typical)
    pipSize:        0.01,   // minimum price increment
    pipValuePerLot: 1.0,    // $1 per pip per lot (100 oz × $0.01/oz)
    description: 'Best during London open & NY overlap — institutional gold flow',
  },
  XAGUSD: {
    symbol: 'XAGUSD', label: 'Silver / USD', category: 'metals', emoji: '🥈',
    sessions: [
      { name: 'London',   startUtc: 7,  endUtc: 10 },
      { name: 'New York', startUtc: 13, endUtc: 17 },
    ],
    spreadLimit:    500,
    pipSize:        0.001,  // silver quoted to 3 decimal places
    pipValuePerLot: 5.0,    // $5 per pip per lot (5000 oz × $0.001/oz)
    description: 'Follows gold — London and NY sessions',
  },

  // ── Major Forex ──────────────────────────────────────────────────────────────
  EURUSD: {
    symbol: 'EURUSD', label: 'EUR / USD', category: 'forex', emoji: '🇪🇺',
    sessions: [
      { name: 'Pre-London', startUtc: 6,  endUtc: 7  },
      { name: 'London',     startUtc: 7,  endUtc: 10 },
      { name: 'New York',   startUtc: 13, endUtc: 17 },
    ],
    spreadLimit:    20,
    pipSize:        0.0001,
    pipValuePerLot: 10,     // $10 per pip per lot (100k units, 5-digit broker)
    description: 'Highest volume forex pair — best during London & NY open',
  },
  GBPUSD: {
    symbol: 'GBPUSD', label: 'GBP / USD', category: 'forex', emoji: '🇬🇧',
    sessions: [
      { name: 'London',   startUtc: 7,  endUtc: 10 },
      { name: 'New York', startUtc: 13, endUtc: 17 },
    ],
    spreadLimit:    25,
    pipSize:        0.0001,
    pipValuePerLot: 10,
    description: 'High volatility — London open is Cable\'s best window',
  },
  USDJPY: {
    symbol: 'USDJPY', label: 'USD / JPY', category: 'forex', emoji: '🇯🇵',
    sessions: [
      { name: 'Asian',  startUtc: 0, endUtc: 3 },
      { name: 'Tokyo',  startUtc: 0, endUtc: 6 },
      { name: 'London', startUtc: 7, endUtc: 10 },
    ],
    spreadLimit:    15,
    pipSize:        0.01,   // JPY pairs: 2 decimal places
    pipValuePerLot: 9,      // ≈$9 per pip per lot (varies with JPY rate)
    description: 'Best during Asian/Tokyo — JPY pairs move on BoJ sentiment',
  },
  AUDUSD: {
    symbol: 'AUDUSD', label: 'AUD / USD', category: 'forex', emoji: '🇦🇺',
    sessions: [
      { name: 'Sydney', startUtc: 22, endUtc: 24 },  // wraps midnight
      { name: 'Asian',  startUtc: 0,  endUtc: 3  },
      { name: 'London', startUtc: 7,  endUtc: 10 },
    ],
    spreadLimit:    20,
    pipSize:        0.0001,
    pipValuePerLot: 10,
    description: 'Driven by Asian risk sentiment and commodity prices',
  },
  USDCAD: {
    symbol: 'USDCAD', label: 'USD / CAD', category: 'forex', emoji: '🇨🇦',
    sessions: [
      { name: 'London',   startUtc: 7,  endUtc: 10 },
      { name: 'New York', startUtc: 13, endUtc: 17 },
    ],
    spreadLimit:    25,
    pipSize:        0.0001,
    pipValuePerLot: 7.5,    // ≈$7.5 per pip (CAD-denominated, varies with rate)
    description: 'Correlated with oil — NY open is the key session',
  },
  USDCHF: {
    symbol: 'USDCHF', label: 'USD / CHF', category: 'forex', emoji: '🇨🇭',
    sessions: [
      { name: 'London',   startUtc: 7,  endUtc: 10 },
      { name: 'New York', startUtc: 13, endUtc: 17 },
    ],
    spreadLimit:    25,
    pipSize:        0.0001,
    pipValuePerLot: 10,     // ≈$10 per pip (CHF near parity with USD)
    description: 'Safe-haven pair — moves with risk-off flows',
  },
  EURGBP: {
    symbol: 'EURGBP', label: 'EUR / GBP', category: 'forex', emoji: '🇪🇺',
    sessions: [
      { name: 'London', startUtc: 7, endUtc: 12 },
    ],
    spreadLimit:    20,
    pipSize:        0.0001,
    pipValuePerLot: 12.5,   // ≈$12.5 per pip (GBP-denominated at ~1.25 rate)
    description: 'Pure London play — tight range outside European hours',
  },

  // ── Indices ──────────────────────────────────────────────────────────────────
  US30: {
    symbol: 'US30', label: 'Dow Jones', category: 'indices', emoji: '📈',
    sessions: [
      { name: 'Pre-Market', startUtc: 12, endUtc: 13 },
      { name: 'New York',   startUtc: 13, endUtc: 17 },
    ],
    spreadLimit:    300,
    pipSize:        1,      // 1 point minimum
    pipValuePerLot: 1,      // $1 per point per lot (verify with broker)
    description: 'US equity index — NY session and key economic data releases',
  },
  NAS100: {
    symbol: 'NAS100', label: 'NASDAQ 100', category: 'indices', emoji: '💻',
    sessions: [
      { name: 'Pre-Market', startUtc: 12, endUtc: 13 },
      { name: 'New York',   startUtc: 13, endUtc: 17 },
    ],
    spreadLimit:    500,
    pipSize:        1,
    pipValuePerLot: 1,      // $1 per point per lot (verify with broker)
    description: 'Tech-heavy index — most volatile at NY open and earnings',
  },
  SPX500: {
    symbol: 'SPX500', label: 'S&P 500', category: 'indices', emoji: '🏦',
    sessions: [
      { name: 'Pre-Market', startUtc: 12, endUtc: 13 },
      { name: 'New York',   startUtc: 13, endUtc: 17 },
    ],
    spreadLimit:    100,
    pipSize:        0.1,
    pipValuePerLot: 1,      // $1 per 0.1pt per lot (verify with broker)
    description: 'Broad US market index — tracks institutional equity flow',
  },

  // ── Commodities ──────────────────────────────────────────────────────────────
  USOIL: {
    symbol: 'USOIL', label: 'WTI Crude Oil', category: 'commodities', emoji: '🛢️',
    sessions: [
      { name: 'London',   startUtc: 7,  endUtc: 10 },
      { name: 'New York', startUtc: 13, endUtc: 17 },
      // EIA inventory every Wednesday ~14:30 UTC — peak volatility
    ],
    spreadLimit:    300,    // oil spreads are wider than forex
    pipSize:        0.01,   // oil priced in cents (e.g., 75.23)
    pipValuePerLot: 10,     // $10 per pip per lot (1000 barrels × $0.01)
    description: 'WTI crude — London & NY open, extra volatility on EIA inventory Wednesdays',
  },

  // ── Crypto ───────────────────────────────────────────────────────────────────
  BTCUSD: {
    symbol: 'BTCUSD', label: 'Bitcoin / USD', category: 'crypto', emoji: '₿',
    sessions: [
      // BTC trades 24/7 — these are the highest-liquidity windows
      { name: 'Asian',    startUtc: 1,  endUtc: 4  },
      { name: 'London',   startUtc: 7,  endUtc: 10 },
      { name: 'New York', startUtc: 13, endUtc: 17 },
    ],
    spreadLimit:    5000,   // crypto spreads are wide (points, not USD)
    pipSize:        1,      // $1 minimum price increment
    pipValuePerLot: 1,      // $1 per $1 move per lot (1 BTC contract)
    description: 'Bitcoin — 24/7 but institutional flow peaks at London & NY opens',
  },
};

/** All available symbols as an array (for dropdown) */
export const SYMBOL_LIST = Object.values(SYMBOL_REGISTRY);

/**
 * Check if a given UTC hour is inside any of the symbol's sessions.
 * Returns the matching session name or null.
 */
export function getActiveSession(symbol: string, utcHour: number): string | null {
  const cfg = SYMBOL_REGISTRY[symbol];
  if (!cfg) return null;

  for (const s of cfg.sessions) {
    // Handle midnight wrap (e.g. Sydney 22–24 wraps to 22–23:59)
    if (s.startUtc > s.endUtc) {
      if (utcHour >= s.startUtc || utcHour < s.endUtc) return s.name;
    } else {
      if (utcHour >= s.startUtc && utcHour < s.endUtc) return s.name;
    }
  }
  return null;
}

/** Convert UTC hour to UAE time (UTC+4) */
export function utcToUae(utcHour: number): number {
  return (utcHour + 4) % 24;
}

/** Format session times in UAE for display */
export function sessionToUae(session: SymbolSession): string {
  const startUae = utcToUae(session.startUtc);
  const endUae   = utcToUae(session.endUtc);
  const fmt = (h: number) => `${h % 12 || 12}${h < 12 ? 'AM' : 'PM'}`;
  return `${fmt(startUae)}–${fmt(endUae)} UAE`;
}
