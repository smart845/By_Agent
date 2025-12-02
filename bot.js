const { Telegraf } = require('telegraf');
const axios = require('axios');
const cron = require('node-cron');
const talib = require('talib'); // Устанавливаем: npm install talib

// --- Настройки окружения ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

console.log('🤖 Запуск MEXC Futures Signals Bot...');

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('❌ Проверьте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ==================== НАСТРОЙКИ MEXC FUTURES ====================
const CONFIG = {
  exchange: 'MEXC Futures',
  apiUrl: 'https://contract.mexc.com',
  minVolume: 100000,           // 100K USDT
  scanInterval: '*/3 * * * *',  // Каждые 3 минуты
  minChange: 2,                // Минимальное изменение 2%
  minConfidence: 70,           // Минимальная уверенность 70%
  maxSignals: 3,               // Максимум сигналов за сканирование
  scanPairs: 30,               // Сколько пар сканировать (Топ 30 растущих и 30 падающих)
  leverage: 10,                // Рекомендуемое плечо
  riskPerTrade: 1,             // Риск 1% на сделку
  rrRatio: 4,                  // Риск:прибыль 1:4
  timeframes: ['15m', '1h', '4h'] // Анализируемые таймфреймы
};

// Хранилище сигналов (кд 1 час)
const sentSignals = new Map();
const SIGNAL_COOLDOWN = 60 * 60 * 1000;

// ==================== MEXC FUTURES API ====================
async function getFuturesTickers() {
  try {
    console.log('📡 Запрос к MEXC Futures API...');
    
    const response = await axios.get(`${CONFIG.apiUrl}/api/v1/contract/ticker`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });
    
    console.log(`✅ Получено ${response.data.data?.length || 0} фьючерсов`);
    
    if (!response.data.success || !response.data.data) {
      throw new Error('Некорректный ответ от API');
    }
    
    // Фильтруем USDT контракты
    const futures = response.data.data
      .filter(ticker => ticker.symbol.endsWith('USDT'))
      .map(ticker => ({
        symbol: ticker.symbol,
        price: parseFloat(ticker.lastPrice),
        // riseFallRate - это десятичное значение (например, 0.05). Умножаем на 100 для получения %
        change24h: parseFloat(ticker.riseFallRate) * 100, 
        volume24h: parseFloat(ticker.volume24),
        turnover24h: parseFloat(ticker.amount24),
        high24h: parseFloat(ticker.high24),
        low24h: parseFloat(ticker.low24),
        fundingRate: parseFloat(ticker.fundingRate) * 100 || 0
      }))
      .filter(ticker => 
        ticker.turnover24h >= CONFIG.minVolume &&
        Math.abs(ticker.change24h) >= 0.5
      );
    
    console.log(`✅ Отфильтровано ${futures.length} фьючерсов`);
    return futures;
    
  } catch (error) {
    console.error('❌ Ошибка Futures API:', error.message);
    return [];
  }
}

// Получаем Kline данные для фьючерсов
async function getFuturesKlines(symbol, interval = '15m', limit = 100) {
  try {
    const response = await axios.get(`${CONFIG.apiUrl}/api/v1/contract/kline/${symbol}`, {
      params: {
        interval: interval,
        limit: limit
      },
      timeout: 8000
    });
    
    if (!response.data.success || !response.data.data) {
      return [];
    }
    
    return response.data.data.map(k => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      turnover: parseFloat(k[6])
    }));
    
  } catch (error) {
    console.error(`❌ Ошибка Kline ${symbol}:`, error.message);
    return [];
  }
}

// Получаем данные по открытому интересу
async function getOpenInterest(symbol) {
  try {
    const response = await axios.get(`${CONFIG.apiUrl}/api/v1/contract/open_interest/${symbol}`, {
      timeout: 5000
    });
    
    if (response.data.success && response.data.data) {
      return {
        value: parseFloat(response.data.data.sumOpenInterest),
        valueUsd: parseFloat(response.data.data.sumOpenInterestValue)
      };
    }
    return null;
  } catch (error) {
    console.error(`❌ Ошибка Open Interest ${symbol}:`, error.message);
    return null;
  }
}

// ==================== ЛОГИКА СКАНИРОВАНИЯ ====================

/**
 * Получает топ 30 растущих и топ 30 падающих фьючерсов по изменению за 24ч.
 * @returns {Array} Отфильтрованный список фьючерсов.
 */
async function getTopGainersAndLosers() {
  try {
    const futures = await getFuturesTickers();
    if (futures.length === 0) return [];
    
    // Сортируем по изменению 24ч
    futures.sort((a, b) => b.change24h - a.change24h);
    
    const topGainers = futures.slice(0, CONFIG.scanPairs);
    const topLosers = futures.slice(-CONFIG.scanPairs);
    
    // Объединяем и удаляем дубликаты (хотя их быть не должно)
    const combined = [...new Set([...topGainers, ...topLosers])];
    
    console.log(`✅ Выбрано ${topGainers.length} растущих и ${topLosers.length} падающих пар для сканирования.`);
    return combined;
    
  } catch (error) {
    console.error('❌ Ошибка получения топ пар:', error.message);
    return [];
  }
}

// ==================== ТЕХНИЧЕСКИЙ АНАЛИЗ (Сокращено для примера) ====================

// Вспомогательная функция для EMA (Экспоненциальная скользящая средняя)
function calculateEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1];
  // Простая реализация для примера, в реальном коде лучше использовать talib
  const multiplier = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) {
    ema = (closes[i] - ema) * multiplier + ema;
  }
  return ema;
}

// Вспомогательная функция для SMA (Простая скользящая средняя)
function calculateSMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1];
  const recent = closes.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

// Простая реализация RSI
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  // ... (Оригинальная логика RSI)
  return 50; // Заглушка
}

// Простая реализация MACD
function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
  // ... (Оригинальная логика MACD)
  return { macd: 0, signal: 0, histogram: 0, bullish: false, bearish: false }; // Заглушка
}

// Простая реализация Stochastic
function calculateStochastic(highs, lows, closes, period = 14, smoothK = 3, smoothD = 3) {
  // ... (Оригинальная логика Stochastic)
  return { k: 50, d: 50, oversold: false, overbought: false }; // Заглушка
}

// Простая реализация ATR
function calculateATR(highs, lows, closes, period = 14) {
  // ... (Оригинальная логика ATR)
  return 0.001; // Заглушка
}

// Простая реализация определения тренда
function determineTrend(indicators) {
  // ... (Оригинальная логика определения тренда)
  return 'NEUTRAL'; // Заглушка
}

// Простая реализация анализа свечных паттернов
function analyzeCandlePatterns(klines) {
  // ... (Оригинальная логика паттернов)
  return []; // Заглушка
}

// Простая реализация анализа объема
function calculateVolumeAnalysis(volumes) {
  // ... (Оригинальная логика объема)
  return { spike: 'NORMAL' }; // Заглушка
}

// Простая реализация проверки дивергенции
function checkBullishDivergence(prices, rsi, lows) { return false; }
function checkBearishDivergence(prices, rsi, highs) { return false; }


/**
 * Выполняет полный технический анализ для пары.
 * @param {Object} pair - Объект фьючерсной пары.
 * @returns {Object|null} Объект сигнала или null.
 */
async function analyzePair(pair) {
  const now = Date.now();
  if (sentSignals.has(pair.symbol) && (now - sentSignals.get(pair.symbol) < SIGNAL_COOLDOWN)) {
    console.log(`⏳ ${pair.symbol} пропущен (кулдаун)`);
    return null;
  }
  
  try {
    // Получаем данные Klines (15m и 1h)
    const klines15m = await getFuturesKlines(pair.symbol, '15m', 100);
    const klines1h = await getFuturesKlines(pair.symbol, '1h', 100);
    
    if (klines15m.length < 50 || klines1h.length < 50) {
      console.log(`⚠️ Недостаточно данных для ${pair.symbol}`);
      return null;
    }
    
    const closes15m = klines15m.map(k => k.close);
    const highs15m = klines15m.map(k => k.high);
    const lows15m = klines15m.map(k => k.low);
    const volumes15m = klines15m.map(k => k.volume);
    
    const closes1h = klines1h.map(k => k.close);
    const highs1h = klines1h.map(k => k.high);
    const lows1h = klines1h.map(k => k.low);
    
    const currentPrice = pair.price;
    
    // Расчет индикаторов (используем заглушки для примера)
    const indicators = {
      rsi: {
        m15: calculateRSI(closes15m, 14),
        h1: calculateRSI(closes1h, 14),
      },
      macd: { m15: calculateMACD(closes15m) },
      stochastic: { m15: calculateStochastic(highs15m, lows15m, closes15m) },
      atr: calculateATR(highs15m, lows15m, closes15m),
      volume: calculateVolumeAnalysis(volumes15m),
      patterns: analyzeCandlePatterns(klines15m),
      ma: {
        ema9: calculateEMA(closes15m, 9),
        ema21: calculateEMA(closes15m, 21),
        ema50: calculateEMA(closes15m, 50),
      }
    };
    
    // Получаем Open Interest
    const oi = await getOpenInterest(pair.symbol);
    
    // Анализ конвергенции/дивергенции
    const divergence = {
      bullishDivergence: checkBullishDivergence(closes15m, indicators.rsi.m15, lows15m),
      bearishDivergence: checkBearishDivergence(closes15m, indicators.rsi.m15, highs15m)
    };
    
    // Определяем общий тренд
    const trend = determineTrend(indicators);
    
    // Анализируем на сигнал
    const signalAnalysis = analyzeForSignal(pair, currentPrice, indicators, trend, oi, divergence);
    
    if (signalAnalysis) {
      sentSignals.set(pair.symbol, now);
      return {
        ...signalAnalysis,
        indicators: indicators,
        openInterest: oi,
        pair: pair,
        timeframe: '15m',
        leverage: CONFIG.leverage,
        risk: CONFIG.riskPerTrade
      };
    }
    
    return null;
    
  } catch (error) {
    console.error(`❌ Ошибка анализа ${pair.symbol}:`, error.message);
    return null;
  }
}

// ==================== ЛОГИКА СИГНАЛА (RR 1:4) ====================

/**
 * Анализирует пару на предмет сигнала с RR 1:4.
 * @param {Object} pair - Объект фьючерсной пары.
 * @param {number} currentPrice - Текущая цена.
 * @param {Object} indicators - Индикаторы.
 * @param {string} trend - Определенный тренд.
 * @param {Object} oi - Открытый интерес.
 * @param {Object} divergence - Дивергенции.
 * @returns {Object|null} Объект сигнала или null.
 */
function analyzeForSignal(pair, currentPrice, indicators, trend, oi, divergence) {
  let signal = null;
  let confidence = 0;
  let reasons = [];
  let entry = currentPrice;
  
  // УСЛОВИЯ ДЛЯ LONG (RR 1:4)
  // Условия входа: перепроданность, бычий MACD, бычий тренд/дивергенция, высокий объем
  if (indicators.rsi.m15 < 32 && 
      indicators.stochastic.m15?.oversold &&
      indicators.macd.m15?.histogram > 0 &&
      (trend === 'BULLISH' || divergence.bullishDivergence) &&
      indicators.volume?.spike !== 'NORMAL') {
    
    signal = 'LONG';
    
    // Расчет уровней
    // 1. Определяем размер стоп-лосса (SL)
    const atrStop = indicators.atr * 2; // SL в 2 ATR
    const minPercentStop = currentPrice * 0.01; // Минимум 1% стоп
    
    // SL - это минимальное из двух значений (более консервативный стоп)
    const stopLoss = currentPrice - Math.max(atrStop, minPercentStop);
    
    // 2. Рассчитываем расстояние до SL в цене
    const slDistance = currentPrice - stopLoss;
    
    // 3. Рассчитываем Take Profit (TP) с RR 1:4
    const takeProfit = currentPrice + (slDistance * CONFIG.rrRatio);
    
    // 4. Проверка на минимальную пригодность (SL не слишком маленький)
    if (slDistance / currentPrice < 0.005) { // Если SL меньше 0.5%
        console.log(`⚠️ ${pair.symbol} LONG: SL слишком мал (${(slDistance / currentPrice * 100).toFixed(2)}%)`);
        return null;
    }
    
    // Уверенность и причины
    confidence = 70;
    if (indicators.rsi.m15 < 25) { confidence += 10; reasons.push('RSI сильно перепродан'); }
    if (divergence.bullishDivergence) { confidence += 15; reasons.push('Бычья дивергенция RSI'); }
    if (indicators.volume?.spike === 'HIGH_SPIKE') { confidence += 10; reasons.push('Высокий объем'); }
    if (trend === 'BULLISH') { confidence += 5; reasons.push('Общий тренд бычий'); }
    if (indicators.patterns.includes('BULLISH_ENGULFING')) { confidence += 10; reasons.push('Бычий свечной паттерн'); }
    
    return {
      pair: pair.symbol,
      signal: signal,
      entry: entry.toFixed(8),
      tp: takeProfit.toFixed(8),
      sl: stopLoss.toFixed(8),
      confidence: Math.min(confidence, 95),
      rrRatio: CONFIG.rrRatio,
      reasons: reasons,
      change24h: pair.change24h.toFixed(2),
      volume24h: (pair.volume24h / 1000000).toFixed(2),
      fundingRate: pair.fundingRate?.toFixed(4) || '0.0000'
    };
  }
  
  // УСЛОВИЯ ДЛЯ SHORT (RR 1:4)
  // Условия входа: перекупленность, медвежий MACD, медвежий тренд/дивергенция, высокий объем
  if (indicators.rsi.m15 > 68 && 
      indicators.stochastic.m15?.overbought &&
      indicators.macd.m15?.histogram < 0 &&
      (trend === 'BEARISH' || divergence.bearishDivergence) &&
      indicators.volume?.spike !== 'NORMAL') {
    
    signal = 'SHORT';
    
    // Расчет уровней
    // 1. Определяем размер стоп-лосса (SL)
    const atrStop = indicators.atr * 2; // SL в 2 ATR
    const minPercentStop = currentPrice * 0.01; // Минимум 1% стоп
    
    // SL - это максимальное из двух значений (более консервативный стоп)
    const stopLoss = currentPrice + Math.max(atrStop, minPercentStop);
    
    // 2. Рассчитываем расстояние до SL в цене
    const slDistance = stopLoss - currentPrice;
    
    // 3. Рассчитываем Take Profit (TP) с RR 1:4
    const takeProfit = currentPrice - (slDistance * CONFIG.rrRatio);
    
    // 4. Проверка на минимальную пригодность (SL не слишком маленький)
    if (slDistance / currentPrice < 0.005) { // Если SL меньше 0.5%
        console.log(`⚠️ ${pair.symbol} SHORT: SL слишком мал (${(slDistance / currentPrice * 100).toFixed(2)}%)`);
        return null;
    }
    
    // Уверенность и причины
    confidence = 70;
    if (indicators.rsi.m15 > 75) { confidence += 10; reasons.push('RSI сильно перекуплен'); }
    if (divergence.bearishDivergence) { confidence += 15; reasons.push('Медвежья дивергенция RSI'); }
    if (indicators.volume?.spike === 'HIGH_SPIKE') { confidence += 10; reasons.push('Высокий объем'); }
    if (trend === 'BEARISH') { confidence += 5; reasons.push('Общий тренд медвежий'); }
    if (indicators.patterns.includes('BEARISH_ENGULFING')) { confidence += 10; reasons.push('Медвежий свечной паттерн'); }
    
    return {
      pair: pair.symbol,
      signal: signal,
      entry: entry.toFixed(8),
      tp: takeProfit.toFixed(8),
      sl: stopLoss.toFixed(8),
      confidence: Math.min(confidence, 95),
      rrRatio: CONFIG.rrRatio,
      reasons: reasons,
      change24h: pair.change24h.toFixed(2),
      volume24h: (pair.volume24h / 1000000).toFixed(2),
      fundingRate: pair.fundingRate?.toFixed(4) || '0.0000'
    };
  }
  
  return null;
}

// ==================== АВТОМАТИЧЕСКОЕ СКАНИРОВАНИЕ ====================
async function performAutoScan() {
  console.log('\n' + '='.repeat(70));
  console.log('🎯 АВТОМАТИЧЕСКОЕ СКАНИРОВАНИЕ MEXC FUTURES');
  console.log('='.repeat(70));
  
  const startTime = Date.now();
  
  try {
    // Получаем топ 30 растущих и 30 падающих пар для сканирования
    const topPairs = await getTopGainersAndLosers();
    
    if (topPairs.length === 0) {
      console.log('❌ Нет пар для сканирования');
      return;
    }
    
    const signals = [];
    
    // Последовательный анализ пар
    for (const pair of topPairs) {
      const signal = await analyzePair(pair);
      if (signal && signal.confidence >= CONFIG.minConfidence) {
        signals.push(signal);
        if (signals.length >= CONFIG.maxSignals) break;
      }
    }
    
    if (signals.length > 0) {
      console.log(`✅ Найдено ${signals.length} сигналов. Отправка в Telegram...`);
      await sendSignalsToTelegram(signals);
    } else {
      console.log('🔍 Сигналов не найдено.');
    }
    
  } catch (error) {
    console.error('❌ Критическая ошибка сканирования:', error.message);
    await sendErrorMessageToTelegram('Критическая ошибка сканирования: ' + error.message);
  } finally {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`⏱️ Сканирование завершено за ${duration} сек.`);
    console.log('='.repeat(70) + '\n');
  }
}

// ==================== TELEGRAM УТИЛИТЫ ====================

/**
 * Форматирует и отправляет сигналы в Telegram.
 * @param {Array} signals - Список найденных сигналов.
 */
async function sendSignalsToTelegram(signals) {
  let message = `🚨 *НОВЫЕ СИГНАЛЫ MEXC FUTURES* 🚨\n\n`;
  
  signals.forEach((signal, index) => {
    const emoji = signal.signal === 'LONG' ? '🟢' : '🔴';
    const direction = signal.signal === 'LONG' ? 'ПОКУПКА (LONG)' : 'ПРОДАЖА (SHORT)';
    
    message += `${emoji} *СИГНАЛ #${index + 1}: ${signal.pair}*\n`;
    message += `   *Направление:* ${direction}\n`;
    message += `   *Уверенность:* ${signal.confidence}%\n`;
    message += `   *RR Ratio:* 1:${signal.rrRatio}\n`;
    message += `   *Плечо:* до X${CONFIG.leverage}\n`;
    message += `   *Риск на сделку:* ${CONFIG.riskPerTrade}%\n`;
    message += `   *Изменение 24ч:* ${signal.change24h}%\n`;
    message += `   *Объем 24ч (млн):* $${signal.volume24h}M\n`;
    message += `   *Фандинг:* ${signal.fundingRate}%\n`;
    message += `   *Точка входа:* ${signal.entry}\n`;
    message += `   *Take Profit (TP):* ${signal.tp}\n`;
    message += `   *Stop Loss (SL):* ${signal.sl}\n`;
    message += `   *Обоснование:*\n`;
    signal.reasons.forEach(reason => {
      message += `     - ${reason}\n`;
    });
    message += `\n`;
  });
  
  try {
    await bot.telegram.sendMessage(CHAT_ID, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
    console.log('✅ Сигналы успешно отправлены в Telegram.');
  } catch (error) {
    console.error('❌ Ошибка отправки в Telegram:', error.message);
  }
}

/**
 * Отправляет сообщение об ошибке в Telegram.
 * @param {string} errorMessage - Сообщение об ошибке.
 */
async function sendErrorMessageToTelegram(errorMessage) {
  try {
    await bot.telegram.sendMessage(CHAT_ID, `❌ *ОШИБКА БОТА* ❌\n\n${errorMessage}`, {
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('❌ Ошибка отправки сообщения об ошибке:', error.message);
  }
}

// ==================== ЗАПУСК БОТА ====================

// 1. Запуск автоматического сканирования по расписанию
cron.schedule(CONFIG.scanInterval, performAutoScan, {
  scheduled: true,
  timezone: "Europe/Moscow" // Установите ваш часовой пояс
});

console.log(`⏰ Автоматическое сканирование настроено на: ${CONFIG.scanInterval} (каждые 3 минуты)`);

// 2. Запуск бота (для обработки ошибок и поддержания активности)
bot.launch().then(() => {
    console.log('🚀 Telegram Bot запущен и готов к работе.');
}).catch(err => {
    console.error('❌ Ошибка запуска Telegram Bot:', err.message);
});

// Обработка остановки
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Выполняем первое сканирование сразу после запуска
performAutoScan();
