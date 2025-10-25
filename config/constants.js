// config/constants.js
export const CONFIG = {
  BYBIT: {
    API_BASE: 'https://api.bybit.com',
    WS_PUBLIC: 'wss://stream.bybit.com/v5/public/linear',
    WS_PRIVATE: 'wss://stream.bybit.com/v5/private'
  },
  
  ENDPOINTS: {
    TICKERS: '/v5/market/tickers',
    KLINE: '/v5/market/kline', 
    OPEN_INTEREST: '/v5/market/open-interest',
    FUNDING_RATE: '/v5/market/funding/history',
    ORDERBOOK: '/v5/market/orderbook',
    RECENT_TRADES: '/v5/market/recent-trade',
    INSTRUMENTS: '/v5/market/instruments-info'
  },
  
  INTERVALS: {
    OI: ['5min', '15min', '30min', '1h', '4h'],
    AGENT: [5, 10, 15],
    CHART: ['1', '3', '5', '15', '30', '60', '240', 'D']
  },
  
  INDICATORS: {
    RSI_PERIOD: 14,
    EMA_FAST: 9,
    EMA_SLOW: 21,
    EMA_LONG: 50,
    MACD_FAST: 12,
    MACD_SLOW: 26,
    MACD_SIGNAL: 9
  },
  
  THRESHOLDS: {
    HIGH_VOLUME: 1000000,
    HIGH_OI: 50000000,
    ANOMALY_VOLUME: 3.0, // 3x average
    FUNDING_ALERT: 0.001 // 0.1%
  }
};

// Глобальные переменные приложения
export const AppState = {
  currentSymbol: 'BTCUSDT',
  favorites: new Set(),
  activeModule: 'agent',
  wsConnections: new Map(),
  realTimeData: new Map(),
  alerts: new Map(),
  agentPeriodSec: 5, // Default from HTML
  oiInterval: '5min' // Default from HTML
};
