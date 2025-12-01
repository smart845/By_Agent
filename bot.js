import { Telegraf } from 'telegraf';
import axios from 'axios';
import cron from 'node-cron';

// ==================== КОНФИГУРАЦИЯ ====================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_API_URL = 'https://api.binance.com/api/v3';
const BYBIT_API_URL = 'https://api.bybit.com/v5/market'; // Для будущей интеграции
const BINANCE_API_KEY = process.env.BINANCE_API_KEY; // Для приватных запросов, если понадобятся

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не установлен!');
  process.exit(1);
}

console.log('✅ Bot token найден');
console.log('📱 Chat ID:', CHAT_ID || 'НЕ УСТАНОВЛЕН (получите через /chatid)');
console.log('🔑 Binance API Key:', BINANCE_API_KEY ? 'УСТАНОВЛЕН' : 'НЕ УСТАНОВЛЕН (для публичных данных не нужен)');

// ==================== НАСТРОЙКИ ТОРГОВЛИ (УЖЕСТОЧЕННЫЕ) ====================
const CONFIG = {
  // API Настройки
  timeframe: '15m',             // НОВОЕ: Интервал для краткосрочной торговли
  limit: 100,                   // Количество свечей для анализа
  topMoversCount: 20,           // Количество топ-монет для сканирования (20 рост + 20 падение)
  
  // Фильтры
  minVolume: 50000000,        // УВЕЛИЧЕНО: $50M минимальный объем
  minMarketCap: 500000000,    // УВЕЛИЧЕНО: $500M минимальная капитализация
  minConfidence: 65,          // УВЕЛИЧЕНО: 65% минимальная уверенность
  minQualityScore: 6,         // СНИЖЕНО: 6/10 минимальное качество (для увеличения количества сигналов)
  minRRRatio: 4.0,            // УВЕЛИЧЕНО: 1:4.0 минимальное соотношение риск/прибыль (Требование пользователя)
  minConfirmations: 2,        // СНИЖЕНО: минимум 2 подтверждения (для увеличения количества сигналов)
  
  // Критерии уровней
  godTier: {
    qualityScore: 9,          // УВЕЛИЧЕНО: было 8
    confidence: 85,           // УВЕЛИЧЕНО: было 80
    rrRatio: 5.0              // УВЕЛИЧЕНО: 1:5.0 для God Tier (для соответствия новому minRRRatio)
  },
  premium: {
    qualityScore: 7,          // УВЕЛИЧЕНО: было 6
    confidence: 65,           // УВЕЛИЧЕНО: было 60
    rrRatio: 3.0              // СНИЖЕНО: 1:3.0 для Premium (для увеличения количества сигналов)
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

function calculateRSI(prices, period = 9) { // УСКОРЕНО: 14 -> 9
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

function calculateBollingerBands(prices, period = 12) { // УСКОРЕНО: 20 -> 12
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

function calculateVolatility(prices, period = 12) { // УСКОРЕНО: 20 -> 12
  if (prices.length < period) return 0;
  
  const recentPrices = prices.slice(-period);
  const mean = recentPrices.reduce((a, b) => a + b, 0) / period;
  const variance = recentPrices.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  return (Math.sqrt(variance) / mean) * 100;
}

// НОВЫЙ ИНДИКАТОР: Стохастический осциллятор
function calculateStochastic(prices, period = 14) {
  if (prices.length < period) return { k: 50 };

  const high = prices.slice(-period).reduce((a, b) => Math.max(a, b));
  const low = prices.slice(-period).reduce((a, b) => Math.min(a, b));
  const currentPrice = prices[prices.length - 1];

  if (high === low) return { k: 50 };
  
  // %K (Fast Stochastic)
  const k = ((currentPrice - low) / (high - low)) * 100;

  return { k: parseFloat(k.toFixed(2)) };
}

// НОВЫЙ ИНДИКАТОР: Average True Range (ATR)
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
  
  // Упрощенный расчет ATR (среднее значение TR)
  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  return atr;
}

// НОВЫЙ ИНДИКАТОР: Упрощенный ADX (для фильтрации силы тренда)
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

function getRandomPhrase(phrases) {
  return phrases[Math.floor(Math.random() * phrases.length)];
}

function generateTraderComment(signal) {
  const comments = [];
  const { rsi, adx, stochK, ema20, ema50, ema100 } = signal.indicators;
  const { confidence, rrRatio, signal: direction, confirmations, liquidityZoneUsed } = signal;
  
  // 1. Комментарий по RR Ratio и Tier
  const rrComment = rrRatio >= CONFIG.godTier.rrRatio ? 
    getRandomPhrase([
      `Сверхвыгодный RR ${rrRatio.toFixed(1)}:1! Это God Tier сетап.`,
      `Фантастический риск/прибыль ${rrRatio.toFixed(1)}:1. Максимальная уверенность.`,
      `RR ${rrRatio.toFixed(1)}:1 — идеальный вход для крупной позиции.`
    ]) :
    getRandomPhrase([
      `Отличный RR ${rrRatio.toFixed(1)}:1. Сетап соответствует Premium-критериям.`,
      `Хорошее соотношение риск/прибыль ${rrRatio.toFixed(1)}:1. Тейк-профит амбициозен.`,
      `Минимальный RR 1:4 подтвержден. Хорошая возможность для входа.`
    ]);
  comments.push(rrComment);
  
  // 2. Комментарий по основному индикатору (RSI/Stoch/BB)
  if (direction === 'LONG') {
    if (confirmations.includes('RSI_OVERSOLD') && confirmations.includes('STOCH_OVERSOLD')) {
      comments.push(getRandomPhrase([
        `Монета находится в зоне экстремальной перепроданности (RSI ${rsi}, Stoch ${stochK}). Ожидаем сильный отскок.`,
        `Двойное подтверждение дна: RSI и Стохастик сигнализируют о скором развороте.`,
        `Цена у нижней границы, RSI и StochK на минимумах. Идеальный момент для покупки.`
      ]));
    } else if (confirmations.includes('BB_OVERSOLD')) {
      comments.push(getRandomPhrase([
        `Цена пробила нижнюю полосу Боллинджера. Вероятен возврат к средней линии.`,
        `Рынок слишком растянут вниз. Ждем коррекции к BB Middle.`,
      ]));
    }
  } else { // SHORT
    if (confirmations.includes('RSI_OVERBOUGHT') && confirmations.includes('STOCH_OVERBOUGHT')) {
      comments.push(getRandomPhrase([
        `Монета в зоне экстремальной перекупленности (RSI ${rsi}, Stoch ${stochK}). Вероятна резкая коррекция.`,
        `Двойное подтверждение вершины: RSI и Стохастик указывают на скорый разворот.`,
        `Цена у верхней границы, RSI и StochK на максимумах. Идеальный момент для продажи.`
      ]));
    } else if (confirmations.includes('BB_OVERBOUGHT')) {
      comments.push(getRandomPhrase([
        `Цена пробила верхнюю полосу Боллинджера. Вероятен возврат к средней линии.`,
        `Рынок слишком растянут вверх. Ждем коррекции к BB Middle.`,
      ]));
    }
  }
  
  // 3. Комментарий по тренду и силе (ADX/EMA/MACD)
  if (adx > 35) {
    comments.push(getRandomPhrase([
      `ADX (${adx}) подтверждает сильный импульс в направлении сделки.`,
      `Тренд мощный, что снижает риск ложного пробоя.`,
    ]));
  } else if (adx < 20) {
    comments.push(getRandomPhrase([
      `ADX (${adx}) указывает на боковое движение. Сделка основана на отскоке от границ.`,
      `Рынок в консолидации. Вход на пробой или отскок от ключевых уровней.`,
    ]));
  }
  
  if (confirmations.includes('EMA_BULLISH_ALIGNMENT') || confirmations.includes('EMA_BEARISH_ALIGNMENT')) {
    comments.push(getRandomPhrase([
      `Выравнивание EMA (20/50/100) подтверждает среднесрочный тренд.`,
      `EMA-лента показывает идеальный порядок. Сильный трендовый сигнал.`,
    ]));
  }
  
  if (confirmations.includes('HIGH_VOLUME')) {
    comments.push(getRandomPhrase([
      `Сигнал сопровождается высоким объемом. Это придает ему дополнительный вес.`,
      `Объем подтверждает движение. Крупные игроки в деле.`,
    ]));
  }
  
  // 4. Комментарий по риск-менеджменту
  if (liquidityZoneUsed) {
    comments.push(getRandomPhrase([
      `Стоп-лосс размещен за ближайшей зоной ликвидности. Это защищает от "выноса".`,
      `SL установлен с учетом структурного уровня поддержки/сопротивления.`,
    ]));
  } else {
    comments.push(getRandomPhrase([
      `Стоп-лосс рассчитан по ATR (${signal.indicators.atr.toFixed(6)}). Учитываем текущую волатильность.`,
      `SL установлен на безопасном расстоянии, исходя из волатильности рынка.`,
    ]));
  }
  
  // 5. Финальный комментарий
  comments.push(getRandomPhrase([
    `Общая уверенность ${confidence}% и ${confirmations.length} подтверждений.`,
    `Отличный сетап, который стоит рассмотреть.`,
    `Все ключевые метрики в зеленой зоне.`,
  ]));
  
  // Объединяем комментарии в один текст
  return comments.join(' ');
}

// ==================== АНАЛИЗ СИГНАЛА ====================
function analyzeSignal(coin, priceHistory) {
  const price = coin.current_price;
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
  const rsi = calculateRSI(priceHistory);
  const macd = calculateMACD(priceHistory);
  const bb = calculateBollingerBands(priceHistory);
  const volatility = calculateVolatility(priceHistory);
  const sma20 = calculateSMA(priceHistory, 20);
  const sma50 = calculateSMA(priceHistory, 50);
  
  // EMA индикаторы (НОВОЕ!)
  const ema20 = calculateEMA(priceHistory, 20);
  const ema50 = calculateEMA(priceHistory, 50);
  const ema100 = calculateEMA(priceHistory, 100);
  
  // НОВЫЕ ИНДИКАТОРЫ
  const stoch = calculateStochastic(priceHistory); 
  const atr = calculateATR(priceHistory); 
  const adx = calculateADX(priceHistory); 
  
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
  
  // НОВЫЙ БЛОК: ADX (Сила тренда)
  if (adx > 30) {
    qualityScore += 2;
    confirmations.push('ADX_STRONG_TREND');
  } else if (adx < 20) {
    confirmations.push('ADX_FLAT_MARKET');
  }
  
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
    (rsi < 35 && macd.histogram > 0 && stoch.k < 30 && adx > 25) || // RSI + MACD + Stoch + Strong Trend
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
    (rsi > 65 && macd.histogram < 0 && stoch.k > 70 && adx > 25) || // RSI + MACD + Stoch + Strong Trend
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
  
  // Расчет цен (УЛУЧШЕННЫЙ с зонами ликвидности)
  const entry = price;
  let sl, tp, rrRatio;
  let liquidityZoneUsed = false;
  
  // Находим зоны ликвидности
  const liquidityZones = findLiquidityZones(priceHistory, 20);
  
  const atrMultiplier = 2.5;
  const slDistance = atr * atrMultiplier;
  
  if (signal === 'LONG') {
    // Базовый стоп-лосс
    let calculatedSL = entry - slDistance;
    
    // Ищем ближайшую зону поддержки ниже цены
    const supportZone = findNearestLiquidityZone(entry, liquidityZones, 'support');
    
    // Если есть зона поддержки и она ниже цены, размещаем стоп чуть ниже неё
    if (supportZone && supportZone.price < entry) {
      const zoneBasedSL = supportZone.price * 0.997; // На 0.3% ниже зоны
      // Используем зону, если она не слишком далеко
      if (entry - zoneBasedSL < slDistance * 1.5) {
        calculatedSL = zoneBasedSL;
        liquidityZoneUsed = true;
      }
    }
    
    sl = calculatedSL;
    tp = entry + (entry - sl) * CONFIG.minRRRatio;
    rrRatio = (tp - entry) / (entry - sl);
  } else {
    // Базовый стоп-лосс
    let calculatedSL = entry + slDistance;
    
    // Ищем ближайшую зону сопротивления выше цены
    const resistanceZone = findNearestLiquidityZone(entry, liquidityZones, 'resistance');
    
    if (resistanceZone && resistanceZone.price > entry) {
      const zoneBasedSL = resistanceZone.price * 1.003; // На 0.3% выше зоны
      if (zoneBasedSL - entry < slDistance * 1.5) {
        calculatedSL = zoneBasedSL;
        liquidityZoneUsed = true;
      }
    }
    
    sl = calculatedSL;
    tp = entry - (sl - entry) * CONFIG.minRRRatio;
    rrRatio = (entry - tp) / (sl - entry);
  }
  
  // Убираем этот фильтр, так как он проверяется ниже в isPremium/isGodTier
  // if (rrRatio < CONFIG.minRRRatio) return null;
  
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
    exchange: signal.exchange || 'BINANCE', // Биржа устанавливается в generateSignals
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
}

// ==================== ПОЛУЧЕНИЕ ДАННЫХ С БИРЖ (BINANCE И BYBIT) ====================

/**
 * Получает список топ-монет (рост и падение) с Binance.
 * @returns {Promise<Array<{symbol: string, price: number, volume: number}>>}
 */
/**
 * Получает список топ-монет (рост и падение) с Binance.
 * @returns {Promise<Array<{symbol: string, price: number, volume: number, exchange: string}>>}
 */
async function fetchBinanceTopMovers() {
  try {
    // 1. Получаем все 24-часовые тикеры
    const url = `${BINANCE_API_URL}/ticker/24hr`;
    console.log('📡 Запрос 24hr тикеров Binance...');
    const response = await axios.get(url);

    if (response.status !== 200) {
      console.error(`❌ Ошибка Binance API (24hr ticker): ${response.status}`);
      return [];
    }

    // 2. Фильтруем только пары к USDT и исключаем стейблкоины
    const usdtPairs = response.data.filter(ticker => 
      ticker.symbol.endsWith('USDT') && 
      !STABLECOINS.some(stable => ticker.symbol.startsWith(stable.toUpperCase()))
    );

    // 3. Сортируем по процентному изменению
    usdtPairs.sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent));

    // 4. Выбираем топ-N роста и топ-N падения
    const topGainers = usdtPairs.slice(0, CONFIG.topMoversCount);
    const topLosers = usdtPairs.slice(-CONFIG.topMoversCount);

    const topMovers = [...topGainers, ...topLosers].map(ticker => ({
      symbol: ticker.symbol,
      price: parseFloat(ticker.lastPrice),
      volume: parseFloat(ticker.quoteVolume), // quoteVolume - объем в USDT
      priceChangePercent: parseFloat(ticker.priceChangePercent)
    }));

    console.log(`✅ Получено ${topMovers.length} топ-монет с Binance.`);
    return topMovers.map(m => ({...m, exchange: 'BINANCE'}));
  } catch (error) {
    console.error('❌ Ошибка получения топ-монет Binance:', error.message);
    return [];
  }
}

/**
 * Получает список топ-монет (рост и падение) с Bybit.
 * @returns {Promise<Array<{symbol: string, price: number, volume: number, exchange: string}>>}
 */
async function fetchBybitTopMovers() {
  try {
    // 1. Получаем все тикеры
    const url = `${BYBIT_API_URL}/tickers?category=spot`;
    console.log('📡 Запрос тикеров Bybit...');
    const response = await axios.get(url);

    if (response.status !== 200 || response.data.retCode !== 0) {
      console.error(`❌ Ошибка Bybit API (tickers): ${response.status} - ${response.data.retMsg}`);
      return [];
    }

    // 2. Фильтруем только пары к USDT и исключаем стейблкоины
    const usdtPairs = response.data.result.list.filter(ticker => 
      ticker.symbol.endsWith('USDT') && 
      !STABLECOINS.some(stable => ticker.symbol.startsWith(stable.toUpperCase()))
    );

    // 3. Сортируем по процентному изменению (price24hPcnt)
    usdtPairs.sort((a, b) => parseFloat(b.price24hPcnt) - parseFloat(a.price24hPcnt));

    // 4. Выбираем топ-N роста и топ-N падения
    const topGainers = usdtPairs.slice(0, CONFIG.topMoversCount);
    const topLosers = usdtPairs.slice(-CONFIG.topMoversCount);

    const topMovers = [...topGainers, ...topLosers].map(ticker => ({
      symbol: ticker.symbol,
      price: parseFloat(ticker.lastPrice),
      volume: parseFloat(ticker.volume24h), // volume24h - объем в базовой валюте
      priceChangePercent: parseFloat(ticker.price24hPcnt) * 100 // Bybit возвращает в долях
    }));

    console.log(`✅ Получено ${topMovers.length} топ-монет с Bybit.`);
    return topMovers.map(m => ({...m, exchange: 'BYBIT'}));
  } catch (error) {
    console.error('❌ Ошибка получения топ-монет Bybit:', error.message);
    return [];
  }
}

/**
 * Получает исторические данные (K-lines) для конкретной пары с Binance.
 * @param {string} symbol - Торговая пара (например, BTCUSDT)
 * @returns {Promise<Array<number>>} - Массив цен закрытия
 */

/**
 * Получает исторические данные (K-lines) для конкретной пары.
 * @param {string} symbol - Торговая пара (например, BTCUSDT)
 * @returns {Promise<Array<number>>} - Массив цен закрытия
 */
async function fetchBinanceKlines(symbol) {
  try {
    const url = `${BINANCE_API_URL}/klines?symbol=${symbol}&interval=${CONFIG.timeframe}&limit=${CONFIG.limit}`;
    console.log(`   -> Запрос K-lines для ${symbol} (${CONFIG.timeframe}) с Binance...`);
    const response = await axios.get(url);

    if (response.status !== 200) {
      console.error(`❌ Ошибка Binance API (Klines): ${response.status}`);
      return [];
    }

    // K-line: [timestamp, open, high, low, close, volume, ...]
    // Нам нужна цена закрытия (индекс 4). Binance возвращает от старого к новому.
    const prices = response.data.map(kline => parseFloat(kline[4]));
    return prices;
  } catch (error) {
    console.error(`❌ Ошибка получения K-lines для ${symbol}:`, error.message);
    return [];
  }
}

/**
 * Получает исторические данные (K-lines) для конкретной пары с Bybit.
 * @param {string} symbol - Торговая пара (например, BTCUSDT)
 * @returns {Promise<Array<number>>} - Массив цен закрытия
 */
async function fetchBybitKlines(symbol) {
  try {
    // Bybit использует интервалы '15', '60' (1h) и т.д.
    const interval = CONFIG.timeframe.replace('m', ''); 
    const url = `${BYBIT_API_URL}/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=${CONFIG.limit}`;
    console.log(`   -> Запрос K-lines для ${symbol} (${CONFIG.timeframe}) с Bybit...`);
    const response = await axios.get(url);

    if (response.status !== 200 || response.data.retCode !== 0) {
      console.error(`❌ Ошибка Bybit API (Klines): ${response.status} - ${response.data.retMsg}`);
      return [];
    }

    // K-line: [timestamp, open, high, low, close, volume, ...]
    // Нам нужна цена закрытия (индекс 4). Bybit возвращает массив массивов-строк.
    // Важно: Bybit возвращает от нового к старому, поэтому используем .reverse()
    const prices = response.data.result.list.map(kline => parseFloat(kline[4])).reverse(); 
    return prices;
  } catch (error) {
    console.error(`❌ Ошибка получения K-lines для ${symbol}:`, error.message);
    return [];
  }
}

async function generateSignals() {
  console.log('🔍 Генерация сигналов...');
  
  // 1. Получаем списки топ-монет с обеих бирж
  const [binanceMovers, bybitMovers] = await Promise.all([
    fetchBinanceTopMovers(),
    fetchBybitTopMovers()
  ]);
  
  const allMovers = [...binanceMovers, ...bybitMovers];
  
  if (allMovers.length === 0) {
    console.log('❌ Не удалось получить данные рынка ни с одной биржи.');
    return [];
  }
  
  const signals = [];
  
  // 2. Итерируемся по всем топ-монетам и получаем K-lines для каждой
  for (const mover of allMovers) {
    let priceHistory = [];
    
    if (mover.exchange === 'BINANCE') {
      priceHistory = await fetchBinanceKlines(mover.symbol);
    } else if (mover.exchange === 'BYBIT') {
      priceHistory = await fetchBybitKlines(mover.symbol);
    }
    
    // Проверяем, достаточно ли данных для анализа
    if (priceHistory.length < CONFIG.limit) {
      console.log(`   -> Недостаточно данных для ${mover.symbol} (${mover.exchange}). Пропуск.`);
      continue;
    }
    
    // Форматируем данные для analyzeSignal
    const coinData = {
      symbol: mover.symbol.replace('USDT', '').toLowerCase(),
      current_price: mover.price,
      total_volume: mover.volume,
      market_cap: CONFIG.minMarketCap + 1, // Игнорируем проверку, т.к. это топ-монеты
      price_change_percentage_24h: mover.priceChangePercent
    };
    
    const signal = analyzeSignal(coinData, priceHistory);
    
    if (signal) {
      // Добавляем информацию о бирже
      signal.exchange = mover.exchange;
      signals.push(signal);
    }
  }
  
  signals.sort((a, b) => b.confidence - a.confidence); // Сортируем по уверенности
    
  console.log(`✅ Сгенерировано ${signals.length} сигналов.`);
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
