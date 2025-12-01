import { Telegraf } from 'telegraf';
import axios from 'axios';
import cron from 'node-cron';

// ==================== КОНФИГУРАЦИЯ ====================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не установлен!');
  process.exit(1);
}

console.log('✅ Bot token найден');
console.log('📱 Chat ID:', CHAT_ID || 'НЕ УСТАНОВЛЕН (получите через /chatid)');

// ==================== НАСТРОЙКИ ТОРГОВЛИ ====================
const CONFIG = {
  // API Endpoints
  binanceApi: 'https://api.binance.com/api/v3',
  bybitApi: 'https://api.bybit.com/v5/market',
  
  // Количество монет для мониторинга
  topGainers: 30,      // Топ-30 растущих
  topLosers: 30,       // Топ-30 падающих
  maxSignalsPerScan: 10, // Максимум сигналов за сканирование
  
  // Фильтры
  minVolume: 10000000,    // $10M минимальный объем (снижено для больше сигналов)
  minPrice: 0.001,        // Минимальная цена монеты
  minConfidence: 55,      // СНИЖЕНО: 55% минимальная уверенность
  minQualityScore: 5,     // СНИЖЕНО: 5/10 минимальное качество
  minRRRatio: 2.5,        // СНИЖЕНО: 1:2.5 минимальное соотношение риск/прибыль
  
  // Таймфреймы для анализа (используем несколько)
  timeframes: ['15m', '1h', '4h'],
  
  // Критерии уровней
  godTier: {
    qualityScore: 7,      // СНИЖЕНО
    confidence: 75,       // СНИЖЕНО
    rrRatio: 3.0
  },
  premium: {
    qualityScore: 5,      // СНИЖЕНО
    confidence: 55,       // СНИЖЕНО
    rrRatio: 2.5
  }
};

// ==================== ИСКЛЮЧЕНИЯ ====================
const STABLECOINS = ['usdt', 'usdc', 'dai', 'busd', 'tusd', 'usdp', 'frax', 'fdusd', 'tru'];
const EXCLUDED_SYMBOLS = ['btc', 'eth']; // Можно исключить BTC/ETH если нужно больше альтов

// ==================== TELEGRAM BOT ====================
const bot = new Telegraf(BOT_TOKEN);

// Команда /start
bot.start((ctx) => {
  const chatId = ctx.chat.id;
  const username = ctx.chat.username ? `@${ctx.chat.username}` : 'Нет username';
  const firstName = ctx.chat.first_name || 'Пользователь';
  
  console.log(`💬 /start от chat ID: ${chatId}, User: ${firstName} ${username}`);
  
  ctx.reply(
    `🤖 Добро пожаловать в Crypto Signals Bot Pro!\n\n` +
    `📊 Режим: Real-time мониторинг Binance & Bybit\n` +
    `📈 Топ-30 роста/падения + технический анализ\n` +
    `⏰ Интервал: 10 минут\n\n` +
    `💬 Ваш Chat ID: <code>${chatId}</code>\n` +
    `👤 Пользователь: ${firstName} ${username}\n\n` +
    `🔧 Установите Chat ID в Render:\n` +
    `<code>TELEGRAM_CHAT_ID=${chatId}</code>\n\n` +
    `📡 Сигналы начнут приходить автоматически.`,
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

// Команда /scan - ручной запуск сканирования
bot.command('scan', async (ctx) => {
  console.log('🔍 Ручной запуск сканирования...');
  ctx.reply('🔍 Запускаю сканирование рынка...');
  await runSignalsTask();
  ctx.reply('✅ Сканирование завершено!');
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
      trendStrength: 8.5,
      momentum: 7.2,
      volumeRatio: 2.3
    },
    confirmations: ['RSI_OVERSOLD', 'MACD_BULLISH', 'BB_OVERSOLD', 'EMA_BULLISH_ALIGNMENT', 'HIGH_VOLUME'],
    priceAction: ['HAMMER', 'SUPPORT_BOUNCE'],
    timestamp: new Date(),
    change24h: 5.2,
    volume24h: 25000000
  };
  
  await sendSignalToTelegram(testSignal);
  ctx.reply('✅ Тестовый сигнал отправлен!');
});

// ==================== БИРЖЕВЫЕ API ФУНКЦИИ ====================

// Получение топ-монет по росту/падению с Binance
async function fetchBinanceTopMovers(type = 'gainers', limit = 30) {
  try {
    console.log(`📈 Получение топ-${limit} ${type} с Binance...`);
    
    // Получаем все USDT пары
    const exchangeInfo = await axios.get(
      `${CONFIG.binanceApi}/exchangeInfo`,
      { timeout: 10000 }
    );
    
    const usdtPairs = exchangeInfo.data.symbols
      .filter(s => 
        s.quoteAsset === 'USDT' && 
        s.status === 'TRADING' &&
        !STABLECOINS.includes(s.baseAsset.toLowerCase()) &&
        !EXCLUDED_SYMBOLS.includes(s.baseAsset.toLowerCase())
      )
      .map(s => s.symbol);
    
    // Получаем 24hr ticker для всех пар
    const tickers = await axios.get(
      `${CONFIG.binanceApi}/ticker/24hr`,
      { timeout: 15000 }
    );
    
    // Фильтруем и сортируем
    const filteredTickers = tickers.data
      .filter(t => usdtPairs.includes(t.symbol) && parseFloat(t.volume) > CONFIG.minVolume)
      .map(t => ({
        symbol: t.symbol,
        baseAsset: t.symbol.replace('USDT', ''),
        price: parseFloat(t.lastPrice),
        priceChange: parseFloat(t.priceChange),
        priceChangePercent: parseFloat(t.priceChangePercent),
        volume: parseFloat(t.volume),
        quoteVolume: parseFloat(t.quoteVolume),
        high: parseFloat(t.highPrice),
        low: parseFloat(t.lowPrice)
      }));
    
    // Сортируем по проценту изменения
    if (type === 'gainers') {
      filteredTickers.sort((a, b) => b.priceChangePercent - a.priceChangePercent);
    } else {
      filteredTickers.sort((a, b) => a.priceChangePercent - b.priceChangePercent);
    }
    
    const topMovers = filteredTickers.slice(0, limit);
    console.log(`✅ Binance: ${topMovers.length} ${type} получено`);
    
    return topMovers;
  } catch (error) {
    console.error(`❌ Ошибка получения топ-${type} с Binance:`, error.message);
    return [];
  }
}

// Получение топ-монет по росту/падению с Bybit
async function fetchBybitTopMovers(type = 'gainers', limit = 30) {
  try {
    console.log(`📈 Получение топ-${limit} ${type} с Bybit...`);
    
    const category = 'spot'; // spot рынок
    
    // Получаем все тикеры
    const response = await axios.get(
      `${CONFIG.bybitApi}/tickers`,
      {
        params: { category, symbol: '' },
        timeout: 10000
      }
    );
    
    if (!response.data?.result?.list) return [];
    
    // Фильтруем USDT пары и исключаем стейблкоины
    const usdtTickers = response.data.result.list
      .filter(t => 
        t.symbol.endsWith('USDT') &&
        !STABLECOINS.some(stable => t.symbol.toLowerCase().includes(stable)) &&
        parseFloat(t.volume24h) > CONFIG.minVolume
      )
      .map(t => {
        const baseAsset = t.symbol.replace('USDT', '');
        if (EXCLUDED_SYMBOLS.includes(baseAsset.toLowerCase())) return null;
        
        return {
          symbol: t.symbol,
          baseAsset: baseAsset,
          price: parseFloat(t.lastPrice),
          priceChange: parseFloat(t.price24h),
          priceChangePercent: parseFloat((parseFloat(t.price24h) / (parseFloat(t.lastPrice) - parseFloat(t.price24h)) * 100) || 0),
          volume: parseFloat(t.volume24h),
          quoteVolume: parseFloat(t.turnover24h),
          high: parseFloat(t.highPrice24h),
          low: parseFloat(t.lowPrice24h)
        };
      })
      .filter(t => t !== null);
    
    // Сортируем
    if (type === 'gainers') {
      usdtTickers.sort((a, b) => b.priceChangePercent - a.priceChangePercent);
    } else {
      usdtTickers.sort((a, b) => a.priceChangePercent - b.priceChangePercent);
    }
    
    const topMovers = usdtTickers.slice(0, limit);
    console.log(`✅ Bybit: ${topMovers.length} ${type} получено`);
    
    return topMovers;
  } catch (error) {
    console.error(`❌ Ошибка получения топ-${type} с Bybit:`, error.message);
    return [];
  }
}

// Получение OHLC данных с биржи
async function fetchOHLCData(symbol, exchange = 'BINANCE', interval = '1h', limit = 100) {
  try {
    let url, params;
    
    if (exchange === 'BINANCE') {
      url = `${CONFIG.binanceApi}/klines`;
      params = { symbol, interval, limit };
    } else if (exchange === 'BYBIT') {
      url = `${CONFIG.bybitApi}/kline`;
      params = { 
        category: 'spot',
        symbol,
        interval: interval, // Bybit поддерживает 15, 60, 240 и т.д.
        limit 
      };
    } else {
      return null;
    }
    
    const response = await axios.get(url, { params, timeout: 10000 });
    
    if (!response.data || response.data.length === 0) return null;
    
    // Парсим данные в универсальный формат
    let closes, volumes;
    
    if (exchange === 'BINANCE') {
      closes = response.data.map(c => parseFloat(c[4])); // close price
      volumes = response.data.map(c => parseFloat(c[5])); // volume
    } else if (exchange === 'BYBIT') {
      closes = response.data.result.list.map(c => parseFloat(c[4])); // close
      volumes = response.data.result.list.map(c => parseFloat(c[5])); // volume
    }
    
    return {
      prices: closes,
      volumes: volumes,
      exchange: exchange,
      symbol: symbol,
      count: closes.length
    };
  } catch (error) {
    console.error(`❌ Ошибка OHLC ${exchange} ${symbol}:`, error.message);
    return null;
  }
}

// Сбор всех топ-монет с обеих бирж
async function fetchAllTopMovers() {
  try {
    console.log('🔄 Сбор топ-монет со всех бирж...');
    
    // Параллельно получаем данные с обеих бирж
    const [
      binanceGainers,
      binanceLosers,
      bybitGainers,
      bybitLosers
    ] = await Promise.all([
      fetchBinanceTopMovers('gainers', CONFIG.topGainers),
      fetchBinanceTopMovers('losers', CONFIG.topLosers),
      fetchBybitTopMovers('gainers', CONFIG.topGainers),
      fetchBybitTopMovers('losers', CONFIG.topLosers)
    ]);
    
    // Объединяем и убираем дубликаты
    const allMovers = [
      ...binanceGainers.map(m => ({ ...m, exchange: 'BINANCE', type: 'GAINER' })),
      ...binanceLosers.map(m => ({ ...m, exchange: 'BINANCE', type: 'LOSER' })),
      ...bybitGainers.map(m => ({ ...m, exchange: 'BYBIT', type: 'GAINER' })),
      ...bybitLosers.map(m => ({ ...m, exchange: 'BYBIT', type: 'LOSER' }))
    ];
    
    // Убираем дубликаты по символу
    const uniqueMovers = [];
    const seenSymbols = new Set();
    
    for (const mover of allMovers) {
      const symbolKey = `${mover.baseAsset}_${mover.exchange}`;
      if (!seenSymbols.has(symbolKey)) {
        seenSymbols.add(symbolKey);
        uniqueMovers.push(mover);
      }
    }
    
    console.log(`✅ Всего уникальных монет для анализа: ${uniqueMovers.length}`);
    return uniqueMovers;
  } catch (error) {
    console.error('❌ Ошибка сбора топ-монет:', error.message);
    return [];
  }
}

// ==================== ИНДИКАТОРЫ (УЛУЧШЕННЫЕ) ====================
function calculateSMA(prices, period) {
  if (prices.length < period) return null;
  const sum = prices.slice(-period).reduce((a, b) => a + b, 0);
  return sum / period;
}

function calculateEMA(prices, period) {
  if (prices.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = calculateSMA(prices.slice(0, period), period);
  
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }
  return ema;
}

function calculateRSI(prices, period = 9) {
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

function calculateMACD(prices) {
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  if (!ema12 || !ema26) return { macd: 0, signal: 0, histogram: 0 };
  
  const macd = ema12 - ema26;
  const signal = calculateEMA(prices.slice(-9), 9) || macd;
  const histogram = macd - signal;
  
  return { macd, signal, histogram };
}

function calculateBollingerBands(prices, period = 12) {
  if (prices.length < period) return { upper: null, middle: null, lower: null };
  
  const sma = calculateSMA(prices, period);
  const variance = prices.slice(-period)
    .reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  
  return {
    upper: sma + stdDev * 2,
    middle: sma,
    lower: sma - stdDev * 2
  };
}

function calculateVolatility(prices, period = 12) {
  if (prices.length < period) return 0;
  
  const recentPrices = prices.slice(-period);
  const mean = recentPrices.reduce((a, b) => a + b, 0) / period;
  const variance = recentPrices.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  return (Math.sqrt(variance) / mean) * 100;
}

function calculateStochastic(prices, period = 14) {
  if (prices.length < period) return { k: 50 };

  const high = Math.max(...prices.slice(-period));
  const low = Math.min(...prices.slice(-period));
  const currentPrice = prices[prices.length - 1];

  if (high === low) return { k: 50 };
  
  const k = ((currentPrice - low) / (high - low)) * 100;
  return { k: parseFloat(k.toFixed(2)) };
}

function calculateATR(prices, period = 14) {
  if (prices.length < period) return 0.01;

  let trs = [];
  for (let i = 1; i < prices.length; i++) {
    const high = prices[i];
    const low = prices[i];
    const prevClose = prices[i - 1];
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  
  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  return atr;
}

function calculateADX(prices, period = 14) {
  if (prices.length < period * 2) return 20;
  const volatility = calculateVolatility(prices, period);
  return Math.min(50, volatility * 5);
}

// НОВЫЕ ИНДИКАТОРЫ ДЛЯ ЛУЧШЕГО АНАЛИЗА

// Сила тренда (0-10)
function calculateTrendStrength(prices, shortPeriod = 20, longPeriod = 50) {
  const smaShort = calculateSMA(prices, shortPeriod);
  const smaLong = calculateSMA(prices, longPeriod);
  
  if (!smaShort || !smaLong) return 5;
  
  const price = prices[prices.length - 1];
  const trendDirection = smaShort > smaLong ? 1 : -1;
  const distanceFromMA = Math.abs(price - smaShort) / smaShort * 100;
  
  let strength = 5;
  if (trendDirection > 0) {
    strength = 5 + (distanceFromMA / 2);
  } else {
    strength = 5 - (distanceFromMA / 2);
  }
  
  return Math.max(0, Math.min(10, strength));
}

// Моментум (0-10)
function calculateMomentum(prices, period = 10) {
  if (prices.length < period + 1) return 5;
  
  const currentPrice = prices[prices.length - 1];
  const pastPrice = prices[prices.length - period - 1];
  const changePercent = ((currentPrice - pastPrice) / pastPrice) * 100;
  
  // Нормализуем к шкале 0-10
  let momentum = 5 + (changePercent / 2);
  return Math.max(0, Math.min(10, momentum));
}

// Отношение объема к среднему
function calculateVolumeRatio(currentVolume, volumeHistory, period = 20) {
  if (volumeHistory.length < period) return 1;
  
  const avgVolume = volumeHistory.slice(-period).reduce((a, b) => a + b, 0) / period;
  if (avgVolume === 0) return 1;
  
  return currentVolume / avgVolume;
}

// ==================== АНАЛИЗ СИГНАЛА (УЛУЧШЕННЫЙ) ====================
async function analyzeCoinSignal(coinData) {
  try {
    const { symbol, baseAsset, price, volume, exchange, priceChangePercent, high, low } = coinData;
    
    // Проверяем базовые условия
    if (price < CONFIG.minPrice) return null;
    if (volume < CONFIG.minVolume) return null;
    if (STABLECOINS.includes(baseAsset.toLowerCase())) return null;
    
    // Получаем OHLC данные для нескольких таймфреймов
    const ohlcPromises = CONFIG.timeframes.map(tf => 
      fetchOHLCData(symbol, exchange, tf, 100)
    );
    
    const ohlcResults = await Promise.all(ohlcPromises);
    
    // Ищем первый доступный таймфрейм с достаточными данными
    const validOHLC = ohlcResults.find(ohlc => ohlc && ohlc.prices.length >= 50);
    
    if (!validOHLC) {
      console.log(`⚠️ Недостаточно данных для ${symbol} на ${exchange}`);
      return null;
    }
    
    const prices = validOHLC.prices;
    const volumes = validOHLC.volumes || [];
    const currentVolume = volumes.length > 0 ? volumes[volumes.length - 1] : volume;
    
    // Рассчитываем индикаторы
    const rsi = calculateRSI(prices);
    const macd = calculateMACD(prices);
    const bb = calculateBollingerBands(prices);
    const volatility = calculateVolatility(prices);
    const stoch = calculateStochastic(prices);
    const atr = calculateATR(prices);
    const adx = calculateADX(prices);
    const ema20 = calculateEMA(prices, 20);
    const ema50 = calculateEMA(prices, 50);
    const sma20 = calculateSMA(prices, 20);
    const sma50 = calculateSMA(prices, 50);
    
    // Новые индикаторы
    const trendStrength = calculateTrendStrength(prices);
    const momentum = calculateMomentum(prices);
    const volumeRatio = calculateVolumeRatio(currentVolume, volumes);
    
    // Подсчет качества и подтверждений
    let qualityScore = 0;
    const confirmations = [];
    const priceAction = [];
    
    // RSI анализ
    if (rsi < 30) {
      qualityScore += 2;
      confirmations.push('RSI_OVERSOLD');
      priceAction.push('OVERSOLD');
    } else if (rsi < 40) {
      qualityScore += 1;
      confirmations.push('RSI_NEAR_OVERSOLD');
    } else if (rsi > 70) {
      qualityScore += 2;
      confirmations.push('RSI_OVERBOUGHT');
      priceAction.push('OVERBOUGHT');
    } else if (rsi > 60) {
      qualityScore += 1;
      confirmations.push('RSI_NEAR_OVERBOUGHT');
    }
    
    // MACD анализ
    if (macd.histogram > 0 && macd.macd > macd.signal) {
      qualityScore += 2;
      confirmations.push('MACD_BULLISH_CROSS');
      priceAction.push('MACD_BULLISH');
    } else if (macd.histogram < 0 && macd.macd < macd.signal) {
      qualityScore += 2;
      confirmations.push('MACD_BEARISH_CROSS');
      priceAction.push('MACD_BEARISH');
    }
    
    // Bollinger Bands
    if (price < bb.lower) {
      qualityScore += 3;
      confirmations.push('BB_OVERSOLD_EXTREME');
      priceAction.push('BB_OVERSOLD');
    } else if (price < bb.middle * 1.05 && price > bb.lower) {
      qualityScore += 1;
      confirmations.push('BB_LOWER_BAND_TOUCH');
    } else if (price > bb.upper) {
      qualityScore += 3;
      confirmations.push('BB_OVERBOUGHT_EXTREME');
      priceAction.push('BB_OVERBOUGHT');
    } else if (price > bb.middle * 0.95 && price < bb.upper) {
      qualityScore += 1;
      confirmations.push('BB_UPPER_BAND_TOUCH');
    }
    
    // Stochastic
    if (stoch.k < 20) {
      qualityScore += 2;
      confirmations.push('STOCH_OVERSOLD');
    } else if (stoch.k > 80) {
      qualityScore += 2;
      confirmations.push('STOCH_OVERBOUGHT');
    }
    
    // ADX (сила тренда)
    if (adx > 25) {
      qualityScore += 1;
      confirmations.push('TREND_STRONG');
    } else if (adx < 15) {
      confirmations.push('TREND_WEAK');
    }
    
    // EMA/SMA выравнивание
    if (ema20 && ema50) {
      if (ema20 > ema50 && ema50 > price) {
        qualityScore += 2;
        confirmations.push('EMA_BULLISH_STACK');
      } else if (ema20 < ema50 && ema50 < price) {
        qualityScore += 2;
        confirmations.push('EMA_BEARISH_STACK');
      }
    }
    
    // Объемы
    if (volumeRatio > 2) {
      qualityScore += 2;
      confirmations.push('VOLUME_SURGE');
      priceAction.push('HIGH_VOLUME');
    } else if (volumeRatio > 1.5) {
      qualityScore += 1;
      confirmations.push('VOLUME_ABOVE_AVG');
    }
    
    // Тренд
    if (sma20 > sma50) {
      qualityScore += 1;
      confirmations.push('TREND_UP_MAJOR');
    } else if (sma20 < sma50) {
      qualityScore += 1;
      confirmations.push('TREND_DOWN_MAJOR');
    }
    
    // Минимальные требования
    if (qualityScore < CONFIG.minQualityScore) return null;
    if (confirmations.length < 3) return null;
    
    // Определение направления сигнала
    let signal = null;
    let confidence = 0;
    let entry = price;
    
    // УСИЛЕННЫЕ КРИТЕРИИ ДЛЯ LONG
    const longConditions = [
      rsi < 35 && macd.histogram > 0 && stoch.k < 35,
      price < bb.lower && rsi < 40,
      rsi < 32 && ema20 > ema50 && volumeRatio > 1.5,
      stoch.k < 25 && adx > 20 && trendStrength > 6
    ];
    
    // УСИЛЕННЫЕ КРИТЕРИИ ДЛЯ SHORT
    const shortConditions = [
      rsi > 65 && macd.histogram < 0 && stoch.k > 65,
      price > bb.upper && rsi > 60,
      rsi > 68 && ema20 < ema50 && volumeRatio > 1.5,
      stoch.k > 75 && adx > 20 && trendStrength < 4
    ];
    
    if (longConditions.some(condition => condition)) {
      signal = 'LONG';
      confidence = Math.min(
        95,
        50 + 
        (35 - Math.min(rsi, 35)) * 0.8 +
        confirmations.length * 3 +
        (trendStrength - 5) * 2 +
        Math.min(momentum - 5, 3)
      );
    } else if (shortConditions.some(condition => condition)) {
      signal = 'SHORT';
      confidence = Math.min(
        95,
        50 + 
        (Math.max(rsi, 65) - 65) * 0.8 +
        confirmations.length * 3 +
        (5 - trendStrength) * 2 +
        Math.min(5 - momentum, 3)
      );
    }
    
    if (!signal || confidence < CONFIG.minConfidence) return null;
    
    // Расчет TP/SL с улучшенной логикой
    const riskMultiplier = signal === 'LONG' ? 1 : -1;
    const atrMultiplier = 2.5;
    const baseSLDistance = atr * atrMultiplier;
    
    let sl, tp;
    
    if (signal === 'LONG') {
      // Для LONG: SL ниже, TP выше
      sl = entry - baseSLDistance;
      
      // Учитываем ближайший уровень поддержки
      if (bb.lower && bb.lower < entry) {
        sl = Math.min(sl, bb.lower * 0.995);
      }
      
      // Рассчитываем несколько TP
      tp = entry + (entry - sl) * CONFIG.minRRRatio;
      
      // Дополнительный TP для скальпинга
      const tpScalp = entry + (entry - sl) * 1.5;
      
    } else {
      // Для SHORT: SL выше, TP ниже
      sl = entry + baseSLDistance;
      
      // Учитываем ближайший уровень сопротивления
      if (bb.upper && bb.upper > entry) {
        sl = Math.max(sl, bb.upper * 1.005);
      }
      
      tp = entry - (sl - entry) * CONFIG.minRRRatio;
      
      // Дополнительный TP для скальпинга
      const tpScalp = entry - (sl - entry) * 1.5;
    }
    
    const rrRatio = signal === 'LONG' 
      ? (tp - entry) / (entry - sl)
      : (entry - tp) / (sl - entry);
    
    if (rrRatio < CONFIG.minRRRatio) return null;
    
    // Определение уровня сигнала
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
      pair: `${baseAsset}/USDT`,
      symbol: baseAsset,
      signal,
      entry: parseFloat(entry.toFixed(6)),
      tp: parseFloat(tp.toFixed(6)),
      sl: parseFloat(sl.toFixed(6)),
      confidence: Math.round(confidence),
      qualityScore,
      rrRatio: parseFloat(rrRatio.toFixed(2)),
      tier: isGodTier ? 'GOD TIER 🚀' : 'PREMIUM ⭐',
      exchange,
      timeFrame: validOHLC.timeFrame || '1h',
      indicators: {
        rsi: Math.round(rsi),
        volatility: parseFloat(volatility.toFixed(2)),
        stochK: stoch.k,
        adx: Math.round(adx),
        atr: parseFloat(atr.toFixed(6)),
        trendStrength: parseFloat(trendStrength.toFixed(1)),
        momentum: parseFloat(momentum.toFixed(1)),
        volumeRatio: parseFloat(volumeRatio.toFixed(2)),
        ema20: ema20 ? parseFloat(ema20.toFixed(6)) : null,
        ema50: ema50 ? parseFloat(ema50.toFixed(6)) : null,
        bbUpper: bb.upper ? parseFloat(bb.upper.toFixed(6)) : null,
        bbLower: bb.lower ? parseFloat(bb.lower.toFixed(6)) : null
      },
      confirmations,
      priceAction,
      marketData: {
        change24h: parseFloat(priceChangePercent.toFixed(2)),
        volume24h: volume,
        high24h: high,
        low24h: low
      },
      timestamp: new Date()
    };
  } catch (error) {
    console.error(`❌ Ошибка анализа ${coinData?.symbol}:`, error.message);
    return null;
  }
}

// ==================== ГЕНЕРАЦИЯ СИГНАЛОВ ====================
async function generateSignals() {
  console.log('🔍 Запуск сканирования рынка...');
  
  try {
    // Получаем все топ-монеты
    const topMovers = await fetchAllTopMovers();
    
    if (topMovers.length === 0) {
      console.log('❌ Нет данных для анализа');
      return [];
    }
    
    console.log(`📊 Анализирую ${topMovers.length} монет...`);
    
    const signals = [];
    const batchSize = 5;
    
    // Обрабатываем батчами для оптимизации
    for (let i = 0; i < topMovers.length; i += batchSize) {
      const batch = topMovers.slice(i, i + batchSize);
      
      const batchPromises = batch.map(coin => 
        analyzeCoinSignal(coin).catch(err => {
          console.error(`❌ Ошибка в анализе ${coin.symbol}:`, err.message);
          return null;
        })
      );
      
      const batchResults = await Promise.all(batchPromises);
      const validSignals = batchResults.filter(signal => signal !== null);
      
      signals.push(...validSignals);
      
      console.log(`✅ Батч ${Math.floor(i/batchSize)+1}: ${validSignals.length} сигналов`);
      
      // Пауза между батчами
      if (i + batchSize < topMovers.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Сортируем по уверенности и качеству
    signals.sort((a, b) => {
      if (a.tier !== b.tier) {
        return a.tier.includes('🚀') ? -1 : 1;
      }
      return b.confidence - a.confidence;
    });
    
    console.log(`🎯 Всего найдено ${signals.length} сигналов`);
    
    // Ограничиваем количество
    return signals.slice(0, CONFIG.maxSignalsPerScan);
  } catch (error) {
    console.error('❌ Критическая ошибка генерации сигналов:', error);
    return [];
  }
}

// ==================== ОТПРАВКА В TELEGRAM ====================
function generateProfessionalComment(signal) {
  const comments = [];
  
  // Комментарии по уверенности
  if (signal.confidence >= 80) {
    comments.push('ВЫСОКАЯ ВЕРОЯТНОСТЬ — сильное подтверждение индикаторами.');
  } else if (signal.confidence >= 65) {
    comments.push('Хороший сетап с четкими уровнями.');
  }
  
  // Комментарии по RSI
  if (signal.indicators.rsi < 30) {
    comments.push('Экстремальная перепроданность — потенциал для отскока.');
  } else if (signal.indicators.rsi > 70) {
    comments.push('Перекупленность — возможна коррекция.');
  }
  
  // Комментарии по объёмам
  if (signal.indicators.volumeRatio > 2) {
    comments.push('Всплеск объёмов подтверждает движение.');
  }
  
  // Комментарии по тренду
  if (signal.indicators.trendStrength > 7) {
    comments.push('Сильный тренд в пользу сигнала.');
  }
  
  // Комментарии по цене
  if (signal.marketData.change24h > 10) {
    comments.push('Сильный импульс за 24ч.');
  } else if (signal.marketData.change24h < -10) {
    comments.push('Глубокое падение — потенциал для разворота.');
  }
  
  // Если мало комментариев, добавим стандартный
  if (comments.length === 0) {
    comments.push('Технический сетап по индикаторам.');
  }
  
  return comments.join(' ');
}

async function sendSignalToTelegram(signal) {
  if (!CHAT_ID) {
    console.log('⚠️ CHAT_ID не установлен. Сигнал не отправлен.');
    return false;
  }
  
  try {
    const tierEmoji = signal.tier.includes('🚀') ? '🔥' : '⭐';
    const directionEmoji = signal.signal === 'LONG' ? '🟢' : '🔴';
    const changeEmoji = signal.marketData.change24h > 0 ? '📈' : '📉';
    
    const timestamp = signal.timestamp.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    
    const comment = generateProfessionalComment(signal);
    
    const message = `
${tierEmoji} <b>${signal.tier} SIGNAL</b> ${tierEmoji}

${directionEmoji} <b>${signal.signal} ${signal.pair}</b>
🏦 <b>Биржа:</b> ${signal.exchange}
⏰ <b>Таймфрейм:</b> ${signal.timeFrame}

💰 <b>Цена:</b> $${signal.entry.toFixed(6)}
${changeEmoji} <b>24ч:</b> ${signal.marketData.change24h}%
📊 <b>Объём:</b> $${(signal.marketData.volume24h / 1000000).toFixed(1)}M

🎯 <b>Take Profit:</b> $${signal.tp.toFixed(6)}
🛑 <b>Stop Loss:</b> $${signal.sl.toFixed(6)}
⚖️ <b>Risk/Reward:</b> 1:${signal.rrRatio.toFixed(1)}

📈 <b>Технические уровни:</b>
RSI: ${signal.indicators.rsi} | Stoch: ${signal.indicators.stochK}
Vol: ${signal.indicators.volatility}% | ATR: ${signal.indicators.atr.toFixed(6)}
Trend: ${signal.indicators.trendStrength}/10 | Mom: ${signal.indicators.momentum}/10

🔍 <b>Подтверждения:</b>
${signal.confirmations.slice(0, 5).map(c => `• ${c}`).join('\n')}
${signal.confirmations.length > 5 ? `+ ещё ${signal.confirmations.length - 5}` : ''}

💬 <b>Анализ:</b> <i>${comment}</i>

🏆 <b>Качество:</b> ${signal.qualityScore}/10
📊 <b>Уверенность:</b> ${signal.confidence}%

⏱ <b>${timestamp}</b>
<code>------------------------</code>
    `.trim();
    
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log(`✅ Сигнал ${signal.pair} отправлен`);
    return true;
  } catch (error) {
    console.error('❌ Ошибка отправки в Telegram:', error.message);
    return false;
  }
}

// ==================== CRON ЗАДАЧА ====================
async function runSignalsTask() {
  console.log('\n' + '='.repeat(50));
  console.log('🔄 ЗАПУСК СКАНИРОВАНИЯ РЫНКА');
  console.log(`⏰ ${new Date().toLocaleString('ru-RU')}`);
  console.log('='.repeat(50));
  
  try {
    const signals = await generateSignals();
    
    if (signals.length === 0) {
      console.log('ℹ️  Сигналов не найдено в этом цикле');
      
      // Отправляем статус в Telegram
      if (CHAT_ID) {
        await bot.telegram.sendMessage(
          CHAT_ID,
          `🔍 Сканирование завершено\n⏰ ${new Date().toLocaleTimeString('ru-RU')}\n📊 Сигналов не найдено\n🔄 Следующее сканирование через 10 минут`,
          { parse_mode: 'HTML' }
        );
      }
      return;
    }
    
    console.log(`📤 Отправляю ${signals.length} лучших сигналов...`);
    
    // Отправляем общее уведомление
    if (CHAT_ID) {
      await bot.telegram.sendMessage(
        CHAT_ID,
        `🎯 Найдено ${signals.length} сигналов\n📊 Лучший: ${signals[0].pair} (${signals[0].confidence}%)\n${'='.repeat(30)}`,
        { parse_mode: 'HTML' }
      );
    }
    
    // Отправляем каждый сигнал
    for (const signal of signals) {
      await sendSignalToTelegram(signal);
      await new Promise(resolve => setTimeout(resolve, 1500)); // Задержка между сообщениями
    }
    
    console.log(`✅ Отправлено ${signals.length} сигналов`);
    console.log('='.repeat(50) + '\n');
  } catch (error) {
    console.error('❌ Ошибка в задаче сканирования:', error.message);
    
    if (CHAT_ID) {
      await bot.telegram.sendMessage(
        CHAT_ID,
        `⚠️ Ошибка сканирования\n${error.message}\n🔄 Повтор через 10 минут`,
        { parse_mode: 'HTML' }
      );
    }
  }
}

// ==================== ЗАПУСК ====================
async function start() {
  try {
    console.log('🚀 Запуск Crypto Signals Bot Pro...');
    
    // Удаляем webhook и запускаем long polling
    await bot.telegram.deleteWebhook();
    console.log('✅ Webhook удален');
    
    // Получаем информацию о боте
    const botInfo = await bot.telegram.getMe();
    console.log(`🤖 Бот: @${botInfo.username}`);
    console.log(`📊 Режим: Мониторинг Binance & Bybit`);
    console.log(`⏰ Интервал: 10 минут`);
    console.log(`🎯 Цель: Топ-30 роста/падения`);
    
    // Запускаем бота
    bot.launch();
    console.log('✅ Бот запущен (long polling)');
    
    // Планируем CRON задачу каждые 10 минут
    cron.schedule('*/10 * * * *', runSignalsTask);
    console.log('✅ CRON задача запланирована (каждые 10 минут)');
    
    // Первый запуск через 5 секунд
    console.log('⏳ Первый запуск сканирования через 5 секунд...\n');
    setTimeout(runSignalsTask, 5000);
    
  } catch (error) {
    console.error('❌ Критическая ошибка запуска:', error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('\n🛑 Выключение бота...');
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('\n🛑 Выключение бота...');
  bot.stop('SIGTERM');
  process.exit(0);
});

// Запуск приложения
start();
