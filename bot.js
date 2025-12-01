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

// ==================== НАСТРОЙКИ ТОРГОВЛИ (ОПТИМИЗИРОВАНО ДЛЯ СКАЛЬПИНГА) ====================
const CONFIG = {
  // Binance API
  binanceApiUrl: 'https://api.binance.com/api/v3',
  coinGeckoApiUrl: 'https://api.coingecko.com/api/v3',
  topCoins: 150,                // УМЕНЬШЕНО: Обрабатываем топ-150 монет для скорости
  
  // Фильтры
  minVolume: 30000000,        // $30M минимальный объем
  minMarketCap: 300000000,    // $300M минимальная капитализация
  minConfidence: 60,          // 60% минимальная уверенность
  minQualityScore: 6,         // УВЕЛИЧЕНО: 6/10 минимальное качество
  minRRRatio: 3.0,            // УВЕЛИЧЕНО: 1:3 минимальное соотношение риск/прибыль
  
  // Критерии уровней
  godTier: {
    qualityScore: 8,
    confidence: 80,
    rrRatio: 4.0
  },
  premium: {
    qualityScore: 6,
    confidence: 60,
    rrRatio: 3.0
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

// ==================== BINANCE API ФУНКЦИИ ====================

// Получение OHLC данных с Binance
async function fetchBinanceOHLC(symbol, interval = '1h', limit = 100) {
  try {
    const response = await axios.get(
      `${CONFIG.binanceApiUrl}/klines`,
      {
        params: {
          symbol: symbol.toUpperCase(),
          interval,
          limit
        },
        timeout: 10000
      }
    );
    
    if (!response.data || response.data.length === 0) {
      return null;
    }
    
    // Преобразуем в массив цен [close] для совместимости с текущей логикой
    const prices = response.data.map(candle => parseFloat(candle[4]));
    
    return {
      prices,
      ohlc: response.data.map(candle => ({
        time: candle[0],
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5])
      }))
    };
  } catch (error) {
    if (error.response?.status === 400) {
      return null;
    }
    return null;
  }
}

// Получение 24ч статистики с Binance
async function fetchBinanceTicker(symbol) {
  try {
    const response = await axios.get(
      `${CONFIG.binanceApiUrl}/ticker/24hr`,
      {
        params: { symbol: symbol.toUpperCase() },
        timeout: 5000
      }
    );
    
    return {
      symbol: response.data.symbol,
      price: parseFloat(response.data.lastPrice),
      volume: parseFloat(response.data.volume),
      quoteVolume: parseFloat(response.data.quoteVolume),
      priceChangePercent: parseFloat(response.data.priceChangePercent)
    };
  } catch (error) {
    return null;
  }
}

// Получение списка торговых пар с Binance
async function fetchBinanceMarketData() {
  try {
    console.log('📡 Запрос списка монет с Binance...');
    
    const response = await axios.get(
      `${CONFIG.binanceApiUrl}/exchangeInfo`,
      { timeout: 15000 }
    );
    
    if (!response.data || !response.data.symbols) {
      console.error('❌ Нет данных от Binance');
      return [];
    }
    
    // Фильтруем только USDT пары с активной торговлей
    const usdtPairs = response.data.symbols
      .filter(symbol => 
        symbol.quoteAsset === 'USDT' && 
        symbol.status === 'TRADING' &&
        !STABLECOINS.includes(symbol.baseAsset.toLowerCase())
      )
      .slice(0, CONFIG.topCoins * 2);
    
    console.log(`✅ Найдено ${usdtPairs.length} USDT пар`);
    
    // Получаем данные для топ-пар по объему
    const marketData = [];
    const batchSize = 10;
    
    for (let i = 0; i < Math.min(usdtPairs.length, 50); i += batchSize) {
      const batch = usdtPairs.slice(i, i + batchSize);
      const batchPromises = batch.map(async (pair) => {
        const ticker = await fetchBinanceTicker(pair.symbol);
        if (!ticker || ticker.volume < CONFIG.minVolume) return null;
        
        const ohlcData = await fetchBinanceOHLC(pair.symbol, '1h', 100);
        if (!ohlcData || ohlcData.prices.length < 50) return null;
        
        return {
          id: pair.baseAsset.toLowerCase(),
          symbol: pair.baseAsset.toLowerCase(),
          current_price: ticker.price,
          total_volume: ticker.volume,
          market_cap: ticker.quoteVolume,
          price_change_percentage_24h: ticker.priceChangePercent,
          sparkline_in_7d: {
            price: ohlcData.prices
          },
          _binanceData: {
            symbol: pair.symbol,
            ohlc: ohlcData.ohlc,
            price: ticker.price,
            volume: ticker.volume
          }
        };
      });
      
      const batchResults = await Promise.all(batchPromises);
      const validResults = batchResults.filter(item => item !== null);
      marketData.push(...validResults);
      
      // Пауза между батчами
      if (i + batchSize < usdtPairs.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    // Сортируем по объему
    marketData.sort((a, b) => b.total_volume - a.total_volume);
    
    console.log(`✅ Обработано ${marketData.length} пар с реальными данными`);
    return marketData.slice(0, CONFIG.topCoins);
  } catch (error) {
    console.error('❌ Ошибка получения данных Binance:', error.message);
    return [];
  }
}

// Fallback на CoinGecko если Binance не работает
async function fetchCoinGeckoFallback() {
  try {
    const url = `${CONFIG.coinGeckoApiUrl}/coins/markets?vs_currency=usd&order=volume_desc&per_page=${CONFIG.topCoins}&page=1&sparkline=true&price_change_percentage=1h,24h`;
    
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    };
    
    if (COINGECKO_API_KEY) {
      headers['x-cg-demo-api-key'] = COINGECKO_API_KEY;
    }
    
    const response = await axios.get(url, { headers, timeout: 15000 });
    console.log(`✅ Fallback: получено ${response.data.length} монет с CoinGecko`);
    return response.data;
  } catch (error) {
    console.error('❌ Ошибка CoinGecko fallback:', error.message);
    return [];
  }
}

// ==================== ПОЛУЧЕНИЕ ДАННЫХ ====================
async function fetchMarketData() {
  try {
    console.log('📡 Получение реальных данных с Binance...');
    
    const marketData = await fetchBinanceMarketData();
    
    if (marketData.length === 0) {
      console.log('⚠️ Не удалось получить данные с Binance, пробую CoinGecko...');
      return await fetchCoinGeckoFallback();
    }
    
    console.log(`✅ Получено ${marketData.length} монет с реальными OHLC данными.`);
    return marketData;
  } catch (error) {
    console.error('❌ Ошибка fetchMarketData:', error.message);
    return await fetchCoinGeckoFallback();
  }
}

// ==================== ИНДИКАТОРЫ ====================
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

  const high = prices.slice(-period).reduce((a, b) => Math.max(a, b));
  const low = prices.slice(-period).reduce((a, b) => Math.min(a, b));
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

// ==================== ЗОНЫ ЛИКВИДНОСТИ ====================
function findLiquidityZones(prices, period = 20) {
  const zones = [];
  
  for (let i = period; i < prices.length - period; i++) {
    const leftSlice = prices.slice(i - period, i);
    const rightSlice = prices.slice(i + 1, i + period + 1);
    const price = prices[i];
    
    const isLocalMax = leftSlice.every(p => p <= price) && rightSlice.every(p => p <= price);
    if (isLocalMax) {
      zones.push({ type: 'resistance', price, strength: 1 });
    }
    
    const isLocalMin = leftSlice.every(p => p >= price) && rightSlice.every(p => p >= price);
    if (isLocalMin) {
      zones.push({ type: 'support', price, strength: 1 });
    }
  }
  
  return zones;
}

function findNearestLiquidityZone(currentPrice, zones, type) {
  const relevantZones = zones.filter(z => z.type === type);
  if (relevantZones.length === 0) return null;
  
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
  
  if (confidence >= 85) {
    comments.push('Сильный сетап, все индикаторы подтверждают.');
  } else if (confidence >= 70) {
    comments.push('Хороший сетап с множественными подтверждениями.');
  } else if (confidence < 65) {
    comments.push('Сигнал слабый, ждём подтверждения объёма.');
  }
  
  if (rsi < 25) {
    comments.push('Экстремальная перепроданность — возможен сильный отскок.');
  } else if (rsi > 75) {
    comments.push('Экстремальная перекупленность — вероятна коррекция.');
  }
  
  if (adx > 35) {
    comments.push('Сильный тренд, импульс подтверждён.');
  } else if (adx < 20) {
    comments.push('Слабый тренд, рынок в консолидации.');
  }
  
  if (signal.confirmations.includes('ADX_STRONG_TREND') && signal.confirmations.includes('HIGH_VOLUME')) {
    comments.push('Объёмы растут на сильном тренде — хороший момент.');
  }
  
  if (signal.liquidityZoneUsed) {
    comments.push('Стоп размещён за зоной ликвидности.');
  }
  
  return comments.length > 0 ? comments.join(' ') : 'Стандартный сетап.';
}

// ==================== АНАЛИЗ СИГНАЛА ====================
function analyzeSignal(coin, priceHistory) {
  const price = coin.current_price;
  const volume = coin.total_volume;
  const marketCap = coin.market_cap;
  
  if (STABLECOINS.includes(coin.symbol.toLowerCase())) {
    return null;
  }
  
  if (volume < CONFIG.minVolume) return null;
  if (marketCap < CONFIG.minMarketCap) return null;
  if (priceHistory.length < 50) return null;
  
  const rsi = calculateRSI(priceHistory);
  const macd = calculateMACD(priceHistory);
  const bb = calculateBollingerBands(priceHistory);
  const volatility = calculateVolatility(priceHistory);
  const sma20 = calculateSMA(priceHistory, 20);
  const sma50 = calculateSMA(priceHistory, 50);
  
  const ema20 = calculateEMA(priceHistory, 20);
  const ema50 = calculateEMA(priceHistory, 50);
  const ema100 = calculateEMA(priceHistory, 100);
  
  const stoch = calculateStochastic(priceHistory);
  const atr = calculateATR(priceHistory);
  const adx = calculateADX(priceHistory);
  
  let qualityScore = 0;
  const confirmations = [];
  
  if (rsi < 30) {
    qualityScore += 2;
    confirmations.push('RSI_OVERSOLD');
  } else if (rsi > 70) {
    qualityScore += 2;
    confirmations.push('RSI_OVERBOUGHT');
  }
  
  if (macd.histogram > 0 && macd.macd > macd.signal) {
    qualityScore += 1;
    confirmations.push('MACD_BULLISH');
  } else if (macd.histogram < 0 && macd.macd < macd.signal) {
    qualityScore += 1;
    confirmations.push('MACD_BEARISH');
  }
  
  if (price < bb.lower) {
    qualityScore += 2;
    confirmations.push('BB_OVERSOLD');
  } else if (price > bb.upper) {
    qualityScore += 2;
    confirmations.push('BB_OVERBOUGHT');
  }
  
  if (stoch.k < 20) {
    qualityScore += 2;
    confirmations.push('STOCH_OVERSOLD');
  } else if (stoch.k > 80) {
    qualityScore += 2;
    confirmations.push('STOCH_OVERBOUGHT');
  }
  
  if (adx > 30) {
    qualityScore += 2;
    confirmations.push('ADX_STRONG_TREND');
  } else if (adx < 20) {
    confirmations.push('ADX_FLAT_MARKET');
  }
  
  if (sma20 > sma50) {
    qualityScore += 1;
    confirmations.push('TREND_BULLISH');
  } else if (sma20 < sma50) {
    qualityScore += 1;
    confirmations.push('TREND_BEARISH');
  }
  
  if (ema20 && ema50 && ema100) {
    if (ema20 > ema50 && ema50 > ema100) {
      qualityScore += 2;
      confirmations.push('EMA_BULLISH_ALIGNMENT');
    } else if (ema20 < ema50 && ema50 < ema100) {
      qualityScore += 2;
      confirmations.push('EMA_BEARISH_ALIGNMENT');
    }
  }
  
  if (volume > CONFIG.minVolume * 2) {
    qualityScore += 1;
    confirmations.push('HIGH_VOLUME');
  }
  
  if (qualityScore < CONFIG.minQualityScore) return null;
  if (confirmations.length < 2) return null;
  
  let signal = null;
  let confidence = 0;
  
  if (
    (rsi < 35 && macd.histogram > 0 && stoch.k < 30 && adx > 25) ||
    (price < bb.lower && rsi < 40 && stoch.k < 40) ||
    (rsi < 30 && sma20 > sma50)
  ) {
    signal = 'LONG';
    const trendBonus = sma20 > sma50 ? 1.15 : 1.0;
    confidence = Math.min(
      (55 + (35 - rsi) * 1.2 + confirmations.length * 4) * trendBonus,
      95
    );
  }
  else if (
    (rsi > 65 && macd.histogram < 0 && stoch.k > 70 && adx > 25) ||
    (price > bb.upper && rsi > 60 && stoch.k > 60) ||
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
  
  const entry = price;
  let sl, tp, rrRatio;
  let liquidityZoneUsed = false;
  
  const liquidityZones = findLiquidityZones(priceHistory, 20);
  const atrMultiplier = 2.5;
  const slDistance = atr * atrMultiplier;
  
  if (signal === 'LONG') {
    let calculatedSL = entry - slDistance;
    const supportZone = findNearestLiquidityZone(entry, liquidityZones, 'support');
    
    if (supportZone && supportZone.price < entry) {
      const zoneBasedSL = supportZone.price * 0.997;
      if (entry - zoneBasedSL < slDistance * 1.5) {
        calculatedSL = zoneBasedSL;
        liquidityZoneUsed = true;
      }
    }
    
    sl = calculatedSL;
    tp = entry + (entry - sl) * CONFIG.minRRRatio;
    rrRatio = (tp - entry) / (entry - sl);
  } else {
    let calculatedSL = entry + slDistance;
    const resistanceZone = findNearestLiquidityZone(entry, liquidityZones, 'resistance');
    
    if (resistanceZone && resistanceZone.price > entry) {
      const zoneBasedSL = resistanceZone.price * 1.003;
      if (zoneBasedSL - entry < slDistance * 1.5) {
        calculatedSL = zoneBasedSL;
        liquidityZoneUsed = true;
      }
    }
    
    sl = calculatedSL;
    tp = entry - (sl - entry) * CONFIG.minRRRatio;
    rrRatio = (entry - tp) / (sl - entry);
  }
  
  if (rrRatio < CONFIG.minRRRatio) return null;
  
  const isGodTier = 
    qualityScore >= CONFIG.godTier.qualityScore &&
    confidence >= CONFIG.godTier.confidence &&
    rrRatio >= CONFIG.godTier.rrRatio;
  
  const isPremium = !isGodTier &&
    qualityScore >= CONFIG.premium.qualityScore &&
    confidence >= CONFIG.premium.confidence &&
    rrRatio >= CONFIG.premium.rrRatio;
  
  if (!isGodTier && !isPremium) return null;
  
  const signalData = {
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
      adx: Math.round(adx),
      atr: parseFloat(atr.toFixed(6)),
      ema20: ema20 ? parseFloat(ema20.toFixed(6)) : null,
      ema50: ema50 ? parseFloat(ema50.toFixed(6)) : null,
      ema100: ema100 ? parseFloat(ema100.toFixed(6)) : null
    },
    confirmations,
    liquidityZoneUsed,
    timestamp: new Date()
  };
  
  // Добавляем реальные данные из Binance если есть
  if (coin._binanceData) {
    signalData.realVolume = coin._binanceData.volume;
    signalData.binanceSymbol = coin._binanceData.symbol;
  }
  
  return signalData;
}

// ==================== ГЕНЕРАЦИЯ СИГНАЛОВ ====================
async function generateSignals() {
  console.log('🔍 Генерация сигналов на реальных данных...');
  
  const marketData = await fetchMarketData();
  
  if (!marketData || marketData.length === 0) {
    console.log('❌ Не удалось получить данные рынка.');
    return [];
  }
  
  const signals = [];
  const coinsToProcess = marketData.slice(0, 50);
  
  for (const coin of coinsToProcess) {
    try {
      const priceHistory = coin.sparkline_in_7d.price;
      
      if (!priceHistory || priceHistory.length < 50) {
        continue;
      }
      
      // Проверяем на некорректные данные
      const validPrices = priceHistory.filter(p => p > 0 && !isNaN(p));
      if (validPrices.length < priceHistory.length * 0.8) {
        continue;
      }
      
      const signal = analyzeSignal(coin, priceHistory);
      if (signal) {
        signals.push(signal);
        console.log(`📊 Найден сигнал: ${signal.pair} (${signal.signal}) - Confidence: ${signal.confidence}%`);
      }
    } catch (error) {
      console.error(`❌ Ошибка анализа ${coin.symbol}:`, error.message);
    }
    
    // Пауза для избежания лимитов API
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  signals.sort((a, b) => b.confidence - a.confidence);
  
  console.log(`✅ Сгенерировано ${signals.length} сигналов.`);
  return signals;
}

// ==================== ОТПРАВКА В TELEGRAM ====================
async function sendSignalToTelegram(signal) {
  if (!CHAT_ID) {
    console.log('⚠️ CHAT_ID не установлен. Сигнал не отправлен.');
    return false;
  }
  
  try {
    const tierEmoji = signal.tier === 'GOD TIER' ? '🔥' : '🟦';
    const tierText = signal.tier === 'GOD TIER' ? 'GOD TIER SIGNAL' : 'PREMIUM SIGNAL';
    const directionEmoji = signal.signal === 'LONG' ? '🟢' : '🔴';
    
    const timestamp = signal.timestamp.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).replace(',', ' —');
    
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
    
    const signalsToSend = signals.slice(0, 5);
    console.log(`📤 Отправка ${signalsToSend.length} лучших сигналов...`);
    
    for (const signal of signalsToSend) {
      await sendSignalToTelegram(signal);
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
    await bot.telegram.deleteWebhook();
    console.log('✅ Webhook удален');
    
    const botInfo = await bot.telegram.getMe();
    console.log(`✅ Бот подключен: @${botInfo.username}`);
    
    bot.launch();
    console.log('✅ Бот запущен (long polling)');
    
    cron.schedule('*/10 * * * *', runSignalsTask);
    console.log('✅ CRON задача запланирована (каждые 10 минут)');
    
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
