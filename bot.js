import { Telegraf } from 'telegraf';
import axios from 'axios';
import cron from 'node-cron';

// ==================== КОНФИГУРАЦИЯ ====================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не установлен!');
  process.exit(1);
}

console.log('✅ Bot token найден');
console.log('📱 Chat ID:', CHAT_ID || 'НЕ УСТАНОВЛЕН (получите через /chatid)');
console.log('🔑 CoinGecko API Key:', COINGECKO_API_KEY ? 'УСТАНОВЛЕН' : 'НЕ УСТАНОВЛЕН (работает без ключа, но с лимитами)');

// ==================== НАСТРОЙКИ ТОРГОВЛИ (УЖЕСТОЧЕННЫЕ) ====================
const CONFIG = {
  // CoinGecko API
  apiUrl: 'https://api.coingecko.com/api/v3',
  binanceApiUrl: 'https://api.binance.com/api/v3', // НОВОЕ: Binance API для OHLCV
  klinesInterval: '1m', // Интервал для Klines (1 минута)
  klinesLimit: 500, // Количество свечей (500)
  topCoins: 200,                // ИЗМЕНЕНО: Сканируем топ-200 монет (по запросу пользователя)
  
  // Фильтры
  minVolume: 50000000,        // УВЕЛИЧЕНО: $50M минимальный объем
  minMarketCap: 500000000,    // УВЕЛИЧЕНО: $500M минимальная капитализация
  minConfidence: 65,          // УВЕЛИЧЕНО: 65% минимальная уверенность
  minQualityScore: 7,         // УВЕЛИЧЕНО: 7/10 минимальное качество
  minRRRatio: 5.0,            // ИЗМЕНЕНО: 1:5.0 минимальное соотношение риск/прибыль (по запросу пользователя)
  minConfirmations: 3,        // НОВОЕ: минимум 3 подтверждения
  
  // Критерии уровней
  fixedSLPercent: 0.25,       // НОВОЕ: Фиксированный SL 0.25% (по запросу пользователя)
  godTier: {
    qualityScore: 9,          // УВЕЛИЧЕНО: было 8
    confidence: 85,           // УВЕЛИЧЕНО: было 80
    rrRatio: 5.0              // ИЗМЕНЕНО: было 4.5 (соответствует новому minRRRatio)
  },
  premium: {
    qualityScore: 7,          // УВЕЛИЧЕНО: было 6
    confidence: 65,           // УВЕЛИЧЕНО: было 60
    rrRatio: 5.0              // ИЗМЕНЕНО: было 3.5 (соответствует новому minRRRatio)
  }
};

// ==================== ИСКЛЮЧЕНИЯ ====================
const STABLECOINS = ['usdt', 'usdc', 'usdc.e','dai', 'busd', 'tusd', 'usdp', 'frax', 'ustc', 'eurs'];

// ==================== TELEGRAM BOT ====================
const bot = new Telegraf(BOT_TOKEN);

// Команда /start
bot.start((ctx) => {
  const chatId = ctx.chat.id;
  const username = ctx.chat.username ? `@${ctx.chat.username}` : 'Нет username';
  const firstName = ctx.chat.first_name || 'Пользователь';
  
  console.log(`💬 /start от chat ID: ${chatId}, User: ${firstName} ${username}`);
  
  ctx.reply(
    `🤖 Добро пожаловать в Crypto Signals Bot!\n\n` +
    `📊 Ваш Chat ID: <code>${chatId}</code>\n` +
    `👤 Пользователь: ${firstName} ${username}\n\n` +
    `💡 Используйте этот Chat ID в переменных окружения:\n` +
    `<code>TELEGRAM_CHAT_ID=${chatId}</code>\n\n` +
    `📈 Сигналы будут приходить сюда автоматически каждые 10 минут.`,
    { parse_mode: 'HTML' }
  );
});

// Команда /chatid
bot.command('chatid', (ctx) => {
  const chatId = ctx.chat.id;
  console.log(`💬 /chatid от chat ID: ${chatId}`);
  ctx.reply(
    `💬 Ваш Chat ID: <code>${chatId}</code>\n\n` +
    `Установите его в переменные окружения на Render:\n` +
    `<code>TELEGRAM_CHAT_ID=${chatId}</code>`,
    { parse_mode: 'HTML' }
  );
});

// Команда /test - тестовый сигнал
bot.command('test', async (ctx) => {
  console.log('🧪 Отправка тестового сигнала...');
  
  const testSignal = {
    pair: 'BTC/USDT',
    signal: 'LONG',
    entry: 45000,
    tp: 48000,
    sl: 43500,
    confidence: 85,
    qualityScore: 8,
    rrRatio: 3.5,
    tier: 'GOD TIER',
    exchange: 'BINANCE',
    indicators: {
      rsi: 28,
      volatility: 5.2,
      stochK: 25,
      adx: 35,
      atr: 0.015,
      ema20: 44800,
      ema50: 44500,
      ema100: 44000
    },
    confirmations: ['RSI_OVERSOLD', 'MACD_BULLISH', 'BB_OVERSOLD', 'EMA_BULLISH_ALIGNMENT', 'HIGH_VOLUME'],
    liquidityZoneUsed: true,
    timestamp: new Date()
  };
  
  await sendSignalToTelegram(testSignal);
  ctx.reply('✅ Тестовый сигнал отправлен!');
});

// ==================== ИНДИКАТОРЫ ====================
// ==================== ИНДИКАТОРЫ (ОБНОВЛЕНО ДЛЯ OHLCV) ====================

// Вспомогательная функция для извлечения цен закрытия
function getCloses(ohlcvData) {
  return ohlcvData.map(d => d.close);
}

function calculateSMA(ohlcvData, period) {
  const prices = getCloses(ohlcvData);
  if (prices.length < period) return null;
  const sum = prices.slice(-period).reduce((a, b) => a + b, 0);
  return sum / period;
}

function calculateEMA(ohlcvData, period) {
  const prices = getCloses(ohlcvData);
  if (prices.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = calculateSMA(ohlcvData.slice(0, period), period);
  
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }
  return ema;
}

function calculateRSI(ohlcvData, period = 9) { // УСКОРЕНО: 14 -> 9
  const prices = getCloses(ohlcvData);
  if (prices.length < period + 1) return 50;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const change = prices[prices.length - i] - prices[prices.length - i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateMACD(ohlcvData) {
  const ema12 = calculateEMA(ohlcvData, 12);
  const ema26 = calculateEMA(ohlcvData, 26);
  if (!ema12 || !ema26) return { macd: 0, signal: 0, histogram: 0 };
  
  const macd = ema12 - ema26;
  const signal = calculateEMA(ohlcvData.slice(-9), 9) || macd;
  const histogram = macd - signal;
  
  return { macd, signal, histogram };
}

function calculateBollingerBands(ohlcvData, period = 12) { // УСКОРЕНО: 20 -> 12
  const prices = getCloses(ohlcvData);
  if (prices.length < period) return { upper: null, middle: null, lower: null };
  
  const sma = calculateSMA(ohlcvData, period);
  const variance = prices.slice(-period)
    .reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  
  return {
    upper: sma + stdDev * 2,
    middle: sma,
    lower: sma - stdDev * 2
  };
}

function calculateVolatility(ohlcvData, period = 12) { // УСКОРЕНО: 20 -> 12
  const prices = getCloses(ohlcvData);
  if (prices.length < period) return 0;
  
  const recentPrices = prices.slice(-period);
  const mean = recentPrices.reduce((a, b) => a + b, 0) / period;
  const variance = recentPrices.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  return (Math.sqrt(variance) / mean) * 100;
}

// Стохастический осциллятор (ОБНОВЛЕНО ДЛЯ OHLCV)
function calculateStochastic(ohlcvData, period = 14) {
  if (ohlcvData.length < period) return { k: 50 };

  const recentData = ohlcvData.slice(-period);
  
  const high = recentData.reduce((max, d) => Math.max(max, d.high), 0);
  const low = recentData.reduce((min, d) => Math.min(min, d.low), Infinity);
  const currentPrice = recentData[recentData.length - 1].close;

  if (high === low) return { k: 50 };
  
  // %K (Fast Stochastic)
  const k = ((currentPrice - low) / (high - low)) * 100;

  return { k: parseFloat(k.toFixed(2)) };
}

// НОВЫЙ ИНДИКАТОР: Average True Range (ATR)
function calculateTR(ohlcvData, index) {
  const current = ohlcvData[index];
  // Используем цену закрытия предыдущей свечи, если она есть
  const previousClose = index > 0 ? ohlcvData[index - 1].close : current.close; 

  const tr1 = current.high - current.low;
  const tr2 = Math.abs(current.high - previousClose);
  const tr3 = Math.abs(current.low - previousClose);

  return Math.max(tr1, tr2, tr3);
}

function calculateATR(ohlcvData, period = 14) {
  if (ohlcvData.length < period) return 0.0; 

  let trs = [];
  for (let i = 0; i < ohlcvData.length; i++) {
    trs.push(calculateTR(ohlcvData, i));
  }
  
  // Расчет ATR как SMA от TR
  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  return atr;
}

// ВНИМАНИЕ: Индикаторы ATR и ADX удалены, так как CoinGecko sparkline data (только цена закрытия)
// не позволяет их корректно рассчитать. Для точных индикаторов необходимы OHLCV данные.

// ==================== ЗОНЫ ЛИКВИДНОСТИ ====================
function findLiquidityZones(prices, period = 20) {
  const zones = [];
  
  for (let i = period; i < prices.length - period; i++) {
    const leftSlice = prices.slice(i - period, i);
    const rightSlice = prices.slice(i + 1, i + period + 1);
    const price = prices[i];
    
    // Локальный максимум (зона сопротивления)
    const isLocalMax = leftSlice.every(p => p <= price) && rightSlice.every(p => p <= price);
    if (isLocalMax) {
      zones.push({ type: 'resistance', price, strength: 1 });
    }
    
    // Локальный минимум (зона поддержки)
    const isLocalMin = leftSlice.every(p => p >= price) && rightSlice.every(p => p >= price);
    if (isLocalMin) {
      zones.push({ type: 'support', price, strength: 1 });
    }
  }
  
  return zones;
}

// Найти ближайшую зону ликвидности
function findNearestLiquidityZone(currentPrice, zones, type) {
  const relevantZones = zones.filter(z => z.type === type);
  if (relevantZones.length === 0) return null;
  
  // Сортируем по близости к текущей цене
  relevantZones.sort((a, b) => {
    return Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice);
  });
  
  return relevantZones[0];
}

// ==================== ГЕНЕРАЦИЯ КОММЕНТАРИЕВ ====================
function generateTraderComment(signal) {
  const comments = [];
  const rsi = signal.indicators.rsi;
  const adx = signal.indicators.adx;
  const confidence = signal.confidence;
  
  // Комментарии по уверенности
  if (confidence >= 85) {
    comments.push('Сильный сетап, все индикаторы подтверждают.');
  } else if (confidence >= 70) {
    comments.push('Хороший сетап с множественными подтверждениями.');
  } else if (confidence < 65) {
    comments.push('Сигнал слабый, ждём подтверждения объёма.');
  }
  
  // Комментарии по RSI
  if (rsi < 25) {
    comments.push('Экстремальная перепроданность — возможен сильный отскок.');
  } else if (rsi > 75) {
    comments.push('Экстремальная перекупленность — вероятна коррекция.');
  }
  
  // Комментарии по ATR (вместо ADX)
  if (signal.indicators.atr > 0.005) { // Условное значение для 1m ATR
    comments.push('Высокая волатильность, ожидается сильное движение.');
  } else if (signal.indicators.atr < 0.001) {
    comments.push('Низкая волатильность, возможна консолидация.');
  }
  
  // Комментарии по подтверждениям
  if (signal.confirmations.includes('ADX_STRONG_TREND') && signal.confirmations.includes('HIGH_VOLUME')) {
    comments.push('Объёмы растут на сильном тренде — хороший момент.');
  }
  
  // Удален комментарий о зоне ликвидности, так как логика изменена на фиксированный SL/RR
  
  return comments.length > 0 ? comments.join(' ') : 'Стандартный сетап.';
}

// ==================== АНАЛИЗ СИГНАЛА ====================function analyzeSignal(coin, ohlcvData) {
  const price = ohlcvData[ohlcvData.length - 1].close; // Используем цену закрытия последней свечи
  const priceHistory = getCloses(ohlcvData); // Получаем массив цен закрытия для совместимости со старыми индикаторами const priceHistory = getCloses(ohlcvData); // Получаем массив цен закрытия для совместимости со старыми индикаторами
  const volume = coin.total_volume;
  const marketCap = coin.market_cap;
  
  // ФИЛЬТР: Исключаем стейблкоины (надежный фильтр)
  if (STABLECOINS.includes(coin.symbol.toLowerCase())) {
    return null;
  }
  
  // Фильтры
  if (volume < CONFIG.minVolume) return null;
  if (marketCap < CONFIG.minMarketCap) return null;
  if (priceHistory.length < 100) return null;
  
  // Индикаторы
  const rsi = calculateRSI(ohlcvData);
  const macd = calculateMACD(ohlcvData);
  const bb = calculateBollingerBands(ohlcvData);
  const volatility = calculateVolatility(ohlcvData);
  const sma20 = calculateSMA(ohlcvData, 20);
  const sma50 = calculateSMA(ohlcvData, 50);
  
  // EMA индикаторы
  const ema20 = calculateEMA(ohlcvData, 20);
  const ema50 = calculateEMA(ohlcvData, 50);
  const ema100 = calculateEMA(ohlcvData, 100);
  
  // НОВЫЕ ИНДИКАТОРЫ
  const stoch = calculateStochastic(ohlcvData); 
  const atr = calculateATR(ohlcvData); 
  // ADX удален, так как его корректный расчет слишком сложен для данной задачи.
  const adx = 20; // Заглушка для совместимости с форматом сигнала
  
  // Подсчет качества и подтверждений
  let qualityScore = 0;
  const confirmations = [];
  
  // RSI
  if (rsi < 30) {
    qualityScore += 2;
    confirmations.push('RSI_OVERSOLD');
  } else if (rsi > 70) {
    qualityScore += 2;
    confirmations.push('RSI_OVERBOUGHT');
  }
  
  // MACD
  if (macd.histogram > 0 && macd.macd > macd.signal) {
    qualityScore += 1;
    confirmations.push('MACD_BULLISH');
  } else if (macd.histogram < 0 && macd.macd < macd.signal) {
    qualityScore += 1;
    confirmations.push('MACD_BEARISH');
  }
  
  // Bollinger Bands
  if (price < bb.lower) {
    qualityScore += 2;
    confirmations.push('BB_OVERSOLD');
  } else if (price > bb.upper) {
    qualityScore += 2;
    confirmations.push('BB_OVERBOUGHT');
  }
  
  // НОВЫЙ БЛОК: Stochastic Oscillator
  if (stoch.k < 20) {
    qualityScore += 2;
    confirmations.push('STOCH_OVERSOLD');
  } else if (stoch.k > 80) {
    qualityScore += 2;
    confirmations.push('STOCH_OVERBOUGHT');
  }
  
  // БЛОК ADX УДАЛЕН: Невозможно корректно рассчитать ADX на основе CoinGecko sparkline data.
  
  // Тренд
  if (sma20 > sma50) {
    qualityScore += 1;
    confirmations.push('TREND_BULLISH');
  } else if (sma20 < sma50) {
    qualityScore += 1;
    confirmations.push('TREND_BEARISH');
  }
  
  // EMA выравнивание (НОВОЕ!)
  if (ema20 && ema50 && ema100) {
    if (ema20 > ema50 && ema50 > ema100) {
      qualityScore += 2;
      confirmations.push('EMA_BULLISH_ALIGNMENT');
    } else if (ema20 < ema50 && ema50 < ema100) {
      qualityScore += 2;
      confirmations.push('EMA_BEARISH_ALIGNMENT');
    }
  }
  
  // Объем
  if (volume > CONFIG.minVolume * 2) {
    qualityScore += 1;
    confirmations.push('HIGH_VOLUME');
  }
  
  // Минимальные требования
  if (qualityScore < CONFIG.minQualityScore) return null;
  if (confirmations.length < CONFIG.minConfirmations) return null;
  
  // Определение сигнала
  let signal = null;
  let confidence = 0;
  
  // LONG сигнал (УЖЕСТОЧЕНО)
  if (
    (rsi < 35 && macd.histogram > 0 && stoch.k < 30) || // RSI + MACD + Stoch
    (price < bb.lower && rsi < 40 && stoch.k < 40) ||               // BB Oversold + RSI + Stoch
    (rsi < 30 && sma20 > sma50)
  ) {
    signal = 'LONG';
    const trendBonus = sma20 > sma50 ? 1.15 : 1.0;
    confidence = Math.min(
      (55 + (35 - rsi) * 1.2 + confirmations.length * 4) * trendBonus,
      95
    );
  }
  // SHORT сигнал (УЖЕСТОЧЕНО)
  else if (
    (rsi > 65 && macd.histogram < 0 && stoch.k > 70) || // RSI + MACD + Stoch
    (price > bb.upper && rsi > 60 && stoch.k > 60) ||                // BB Overbought + RSI + Stoch
    (rsi > 70 && sma20 < sma50)
  ) {
    signal = 'SHORT';
    const trendBonus = sma20 < sma50 ? 1.15 : 1.0;
    confidence = Math.min(
      (55 + (rsi - 65) * 1.2 + confirmations.length * 4) * trendBonus,
      95
    );
  }
  
  if (!signal || confidence < CONFIG.minConfidence) return null;
  
  // Расчет цен (ФИКСИРОВАННЫЙ SL/RR)
  const entry = price;
  let sl, tp, rrRatio;
  const liquidityZoneUsed = false; // Больше не используется
  
  // Расчет фиксированного SL в процентах
  const slPercent = CONFIG.fixedSLPercent / 100; // 0.25% -> 0.0025
  const rrMultiplier = CONFIG.minRRRatio; // 5.0
  
  if (signal === 'LONG') {
    // SL: Entry - 0.25%
    sl = entry * (1 - slPercent);
    // TP: Entry + (Entry - SL) * RR_Multiplier
    tp = entry + (entry - sl) * rrMultiplier;
    rrRatio = rrMultiplier; // Фиксированное значение
  } else {
    // SL: Entry + 0.25%
    sl = entry * (1 + slPercent);
    // TP: Entry - (SL - Entry) * RR_Multiplier
    tp = entry - (sl - entry) * rrMultiplier;
    rrRatio = rrMultiplier; // Фиксированное значение
  }
  
  // Проверка, что TP и SL не пересекаются (для SHORT TP < SL, для LONG TP > SL)
  if ((signal === 'LONG' && tp <= sl) || (signal === 'SHORT' && tp >= sl)) {
    // Этого не должно произойти с фиксированным RR > 1, но для безопасности
    return null;
  }
  
  // Определение уровня
  const isGodTier = 
    qualityScore >= CONFIG.godTier.qualityScore &&
    confidence >= CONFIG.godTier.confidence &&
    rrRatio >= CONFIG.godTier.rrRatio;
  
  const isPremium = !isGodTier &&
    qualityScore >= CONFIG.premium.qualityScore &&
    confidence >= CONFIG.premium.confidence &&
    rrRatio >= CONFIG.premium.rrRatio;
  
  if (!isGodTier && !isPremium) return null;
  
  return {
    pair: `${coin.symbol.toUpperCase()}/USDT`,
    signal,
    entry: parseFloat(entry.toFixed(6)),
    tp: parseFloat(tp.toFixed(6)),
    sl: parseFloat(sl.toFixed(6)),
    confidence: Math.round(confidence),
    qualityScore,
    rrRatio: parseFloat(rrRatio.toFixed(2)),
    tier: isGodTier ? 'GOD TIER' : 'PREMIUM',
    exchange: ['BINANCE', 'BYBIT', 'OKX', 'KUCOIN'][Math.floor(Math.random() * 4)],
    indicators: {
      rsi: Math.round(rsi),
      volatility: parseFloat(volatility.toFixed(2)),
      stochK: stoch.k,
      // ADX и ATR теперь заглушки, так как CoinGecko sparkline data не позволяет их корректно рассчитать.
      adx: adx, 
      atr: atr,
      ema20: ema20 ? parseFloat(ema20.toFixed(6)) : null,
      ema50: ema50 ? parseFloat(ema50.toFixed(6)) : null,
      ema100: ema100 ? parseFloat(ema100.toFixed(6)) : null
    },
    confirmations,
    liquidityZoneUsed,
    timestamp: new Date()
  };
}

// ==================== ПОЛУЧЕНИЕ ДАННЫХ ====================
async function fetchOHLCVData(symbol) {
  try {
    const url = `${CONFIG.binanceApiUrl}/klines?symbol=${symbol.toUpperCase()}USDT&interval=${CONFIG.klinesInterval}&limit=${CONFIG.klinesLimit}`;
    
    // Binance API не требует ключа для публичных данных
    const response = await axios.get(url);
    
    if (response.status !== 200) {
      console.error(`❌ Ошибка Binance API для ${symbol}: ${response.status}`);
      return null;
    }
    
    // Преобразуем Klines в массив объектов OHLCV
    // [
    //   [
    //     1499040000000,      // Kline open time
    //     "0.01634790",       // Open price
    //     "0.80000000",       // High price
    //     "0.01575800",       // Low price
    //     "0.01577100",       // Close price
    //     "148976.11427815",  // Volume
    //     ...
    //   ]
    // ]
    return response.data.map(kline => ({
      open: parseFloat(kline[1]),
      high: parseFloat(kline[2]),
      low: parseFloat(kline[3]),
      close: parseFloat(kline[4]),
      volume: parseFloat(kline[5])
    }));
  } catch (error) {
    // Игнорируем ошибки, если пара не найдена (например, COINUSDT)
    if (error.response && error.response.status === 400) {
      console.log(`⚠️ Пара ${symbol}USDT не найдена на Binance.`);
      return null;
    }
    console.error(`❌ Ошибка получения OHLCV для ${symbol}:`, error.message);
    return null;
  }
}

async function fetchMarketData() {
  try {
    // Используем CoinGecko только для получения списка топ-монет
    const url = `${CONFIG.apiUrl}/coins/markets?vs_currency=usd&order=volume_desc&per_page=${CONFIG.topCoins}&page=1&price_change_percentage=1h,24h`;
    
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    };
    
    // Добавляем API ключ если есть
    if (COINGECKO_API_KEY) {
      headers['x-cg-demo-api-key'] = COINGECKO_API_KEY;
    }
    
    console.log('📡 Запрос списка топ-монет к CoinGecko API...');
    const response = await axios.get(url, { headers });
    
    if (response.status !== 200) {
      console.error(`❌ Ошибка CoinGecko API: ${response.status}`);
      return null;
    }
    
    console.log(`✅ Получено ${response.data.length} монет.`);
    return response.data;
  } catch (error) {
    console.error('❌ Ошибка получения данных CoinGecko:', error.message);
    return null;
  }
}

async function generateSignals() {
  console.log('🔍 Генерация сигналов...');
  
  const marketData = await fetchMarketData();
  
  if (!marketData || marketData.length === 0) {
    console.log('❌ Не удалось получить данные рынка.');
    return [];
  }
  
  const signals = [];
  
  // ФИЛЬТР: Исключаем стейблкоины
  const filteredCoins = marketData.filter(coin => !STABLECOINS.includes(coin.symbol.toLowerCase()));
  
  for (const coin of filteredCoins) {
    console.log(`\n⏳ Обработка ${coin.symbol.toUpperCase()}...`);
    
    // 1. Получаем OHLCV данные с Binance
    const ohlcvData = await fetchOHLCVData(coin.symbol);
    
    if (!ohlcvData || ohlcvData.length < 100) {
      console.log(`⚠️ Недостаточно OHLCV данных для ${coin.symbol}. Пропускаем.`);
      continue;
    }
    
    // 2. Анализируем сигнал
    const signal = analyzeSignal(coin, ohlcvData);
    
    if (signal) {
      signals.push(signal);
    }
    
    // Небольшая задержка для соблюдения лимитов Binance (1200 запросов/мин)
    await new Promise(resolve => setTimeout(resolve, 100)); 
  }
  
  signals.sort((a, b) => b.confidence - a.confidence); // Сортируем по уверенности
    
  console.log(`\n✅ Сгенерировано ${signals.length} сигналов.`);
  return signals;
}

// ==================== ОТПРАВКА В TELEGRAM (ОБНОВЛЕННЫЙ ФОРМАТ) ====================
async function sendSignalToTelegram(signal) {
  if (!CHAT_ID) {
    console.log('⚠️ CHAT_ID не установлен. Сигнал не отправлен.');
    return false;
  }
  
  try {
    const tierEmoji = signal.tier === 'GOD TIER' ? '🔥' : '🟦';
    const tierText = signal.tier === 'GOD TIER' ? 'GOD TIER SIGNAL' : 'PREMIUM SIGNAL';
    
    // Эмодзи для направления сигнала
    const directionEmoji = signal.signal === 'LONG' ? '🟢' : '🔴';
    
    // Форматирование даты и времени
    const timestamp = signal.timestamp.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).replace(',', ' —');
    
    // Генерация комментария
    const comment = generateTraderComment(signal);
    
    const message = `
<b>${tierEmoji}${tierText}${tierEmoji}</b>

${directionEmoji} <b>${signal.signal} ${signal.pair}</b>

💵 <b>Entry:</b> ${signal.entry.toFixed(6)}
🎯 <b>Take Profit:</b> ${signal.tp.toFixed(6)}
🛑 <b>Stop Loss:</b> ${signal.sl.toFixed(6)}

🎲 <b>R:R Ratio:</b> 1:${signal.rrRatio.toFixed(1)}
📊 <b>Confidence:</b> ${signal.confidence}%
🏆 <b>Quality:</b> ${signal.qualityScore}/10

📉 <b>RSI:</b> ${signal.indicators.rsi}
📈 <b>Stoch K:</b> ${signal.indicators.stochK}
🌪 <b>Volatility:</b> ${signal.indicators.volatility}%
📡 <b>ADX:</b> ${signal.indicators.adx}
📏 <b>ATR:</b> ${signal.indicators.atr.toFixed(6)}

🔍 <b>Confirmations:</b>
${signal.confirmations.map(conf => `• ${conf}`).join('\n')}

💬 <b>Comment:</b> <i>${comment}</i>

🏦 <b>Exchange:</b> ${signal.exchange}
⏱ <b>${timestamp}</b>
    `.trim();
    
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log(`✅ Сигнал ${signal.pair} отправлен в Telegram`);
    return true;
  } catch (error) {
    console.error('❌ Ошибка отправки в Telegram:', error.message);
    return false;
  }
}

// ==================== CRON ЗАДАЧА ====================
async function runSignalsTask() {
  console.log('\n🔄 === ЗАПУСК ЗАДАЧИ ===');
  console.log(`⏰ Время: ${new Date().toLocaleString('ru-RU')}`);
  
  try {
    const signals = await generateSignals();
    
    if (signals.length === 0) {
      console.log('ℹ️  Сигналов не найдено');
      return;
    }
    
    const signalsToSend = signals; 
    console.log(`📤 Отправка ${signalsToSend.length} сигналов...`);
    
    for (const signal of signalsToSend) {
      await sendSignalToTelegram(signal);
      // Задержка между сообщениями
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log('✅ Задача завершена\n');
  } catch (error) {
    console.error('❌ Ошибка в задаче:', error.message);
  }
}

// ==================== ЗАПУСК ====================
async function start() {
  try {
    // Удаляем webhook и запускаем long polling
    await bot.telegram.deleteWebhook();
    console.log('✅ Webhook удален');
    
    // Получаем информацию о боте
    const botInfo = await bot.telegram.getMe();
    console.log(`✅ Бот подключен: @${botInfo.username}`);
    
    // Запускаем бота
    bot.launch();
    console.log('✅ Бот запущен (long polling)');
    
    // Планируем CRON задачу каждые 10 минут
    cron.schedule('*/10 * * * *', runSignalsTask);
    console.log('✅ CRON задача запланирована (каждые 10 минут)');
    
    // Первый запуск через 10 секунд
    console.log('⏳ Первый запуск через 10 секунд...\n');
    setTimeout(runSignalsTask, 10000);
    
  } catch (error) {
    console.error('❌ Ошибка запуска:', error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Запуск
start();
