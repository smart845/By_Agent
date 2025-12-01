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

// ==================== НАСТРОЙКИ ====================
const CONFIG = {
  binanceApi: 'https://api.binance.com/api/v3',
  bybitApi: 'https://api.bybit.com/v5/market',
  
  // Меньше фильтров = больше сигналов
  minVolume: 5000000,      // $5M (снижено)
  minPrice: 0.0001,        // Любая цена
  minConfidence: 50,       // 50% (снижено)
  minQualityScore: 4,      // 4/10 (снижено)
  minRRRatio: 2.0,         // 1:2 (снижено)
  
  // Увеличиваем количество
  coinsToCheck: 50,        // Проверяем 50 монет
  maxSignals: 15,          // Максимум 15 сигналов
  
  // Таймфрейм
  interval: '1h',
  candles: 100
};

// Исключаем только стейблкоины
const STABLECOINS = ['usdt', 'usdc', 'busd', 'dai', 'fdusd'];

// ==================== TELEGRAM BOT ====================
const bot = new Telegraf(BOT_TOKEN);

// Команды (оставляем как было)
bot.start((ctx) => {
  const chatId = ctx.chat.id;
  ctx.reply(
    `🤖 Crypto Signals Bot\n` +
    `📊 Режим: Binance & Bybit\n` +
    `⏰ Каждые 10 минут\n` +
    `💬 Chat ID: <code>${chatId}</code>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('chatid', (ctx) => {
  ctx.reply(`💬 Chat ID: <code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' });
});

bot.command('scan', async (ctx) => {
  ctx.reply('🔍 Ручное сканирование...');
  await runSignalsTask();
});

// ==================== ПРОСТЫЕ АПИ ФУНКЦИИ ====================

// Получаем активные пары с Binance
async function getBinanceCoins() {
  try {
    console.log('📡 Получение монет с Binance...');
    
    // Сначала получаем тикеры с объемами
    const tickers = await axios.get(`${CONFIG.binanceApi}/ticker/24hr`, { timeout: 10000 });
    
    // Фильтруем USDT пары с хорошим объемом
    const usdtPairs = tickers.data
      .filter(t => 
        t.symbol.endsWith('USDT') &&
        parseFloat(t.volume) > CONFIG.minVolume &&
        parseFloat(t.lastPrice) > CONFIG.minPrice
      )
      .map(t => ({
        symbol: t.symbol,
        base: t.symbol.replace('USDT', ''),
        price: parseFloat(t.lastPrice),
        volume: parseFloat(t.volume),
        change: parseFloat(t.priceChangePercent),
        high: parseFloat(t.highPrice),
        low: parseFloat(t.lowPrice),
        exchange: 'BINANCE'
      }))
      .filter(t => !STABLECOINS.includes(t.base.toLowerCase()));
    
    // Сортируем по объему и берем топ
    usdtPairs.sort((a, b) => b.volume - a.volume);
    
    console.log(`✅ Binance: ${usdtPairs.length} пар`);
    return usdtPairs.slice(0, CONFIG.coinsToCheck);
  } catch (error) {
    console.error('❌ Binance error:', error.message);
    return [];
  }
}

// Получаем активные пары с Bybit
async function getBybitCoins() {
  try {
    console.log('📡 Получение монет с Bybit...');
    
    const response = await axios.get(`${CONFIG.bybitApi}/tickers`, {
      params: { category: 'spot' },
      timeout: 10000
    });
    
    if (!response.data?.result?.list) return [];
    
    const usdtPairs = response.data.result.list
      .filter(t => 
        t.symbol.endsWith('USDT') &&
        parseFloat(t.volume24h) > CONFIG.minVolume &&
        parseFloat(t.lastPrice) > CONFIG.minPrice
      )
      .map(t => ({
        symbol: t.symbol,
        base: t.symbol.replace('USDT', ''),
        price: parseFloat(t.lastPrice),
        volume: parseFloat(t.volume24h),
        change: parseFloat(t.price24hPcnt) * 100,
        high: parseFloat(t.highPrice24h),
        low: parseFloat(t.lowPrice24h),
        exchange: 'BYBIT'
      }))
      .filter(t => !STABLECOINS.includes(t.base.toLowerCase()));
    
    usdtPairs.sort((a, b) => b.volume - a.volume);
    
    console.log(`✅ Bybit: ${usdtPairs.length} пар`);
    return usdtPairs.slice(0, CONFIG.coinsToCheck);
  } catch (error) {
    console.error('❌ Bybit error:', error.message);
    return [];
  }
}

// Получаем свечи с биржи (упрощенная версия)
async function getCandles(symbol, exchange) {
  try {
    let url, params;
    
    if (exchange === 'BINANCE') {
      url = `${CONFIG.binanceApi}/klines`;
      params = {
        symbol: symbol,
        interval: CONFIG.interval,
        limit: CONFIG.candles
      };
    } else {
      url = `${CONFIG.bybitApi}/kline`;
      params = {
        category: 'spot',
        symbol: symbol,
        interval: CONFIG.interval === '1h' ? '60' : '15',
        limit: CONFIG.candles
      };
    }
    
    const response = await axios.get(url, { params, timeout: 5000 });
    
    // Преобразуем в массив цен закрытия
    let closes;
    if (exchange === 'BINANCE') {
      closes = response.data.map(c => parseFloat(c[4]));
    } else {
      closes = response.data.result.list.map(c => parseFloat(c[4]));
    }
    
    return closes.filter(price => price > 0);
  } catch (error) {
    // console.log(`⚠️ Нет свечей для ${symbol} на ${exchange}`);
    return null;
  }
}

// ==================== ПРОСТЫЕ ИНДИКАТОРЫ ====================

function calculateRSI(prices, period = 14) {
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
  return 100 - (100 / (1 + rs));
}

function calculateEMA(prices, period) {
  if (prices.length < period) return null;
  
  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }
  
  return ema;
}

function calculateMACD(prices) {
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  
  if (!ema12 || !ema26) return { histogram: 0 };
  
  const macd = ema12 - ema26;
  const signal = calculateEMA(prices.slice(-9), 9) || macd;
  const histogram = macd - signal;
  
  return { histogram };
}

function calculateBB(prices, period = 20) {
  if (prices.length < period) return { upper: null, middle: null, lower: null };
  
  const slice = prices.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  
  return {
    upper: sma + stdDev * 2,
    middle: sma,
    lower: sma - stdDev * 2
  };
}

// ==================== АНАЛИЗ (УПРОЩЕННЫЙ) ====================

async function analyzeCoin(coin) {
  try {
    const { symbol, base, price, exchange, change, volume } = coin;
    
    // Получаем свечи
    const prices = await getCandles(symbol, exchange);
    if (!prices || prices.length < 50) return null;
    
    // Рассчитываем индикаторы
    const rsi = calculateRSI(prices);
    const macd = calculateMACD(prices);
    const bb = calculateBB(prices);
    const ema20 = calculateEMA(prices, 20);
    const ema50 = calculateEMA(prices, 50);
    
    if (!bb.lower || !bb.upper || !ema20 || !ema50) return null;
    
    // Счет качества
    let qualityScore = 0;
    const confirmations = [];
    
    // RSI (самый важный индикатор)
    if (rsi < 30) {
      qualityScore += 3;
      confirmations.push('RSI_OVERSOLD');
    } else if (rsi < 40) {
      qualityScore += 1;
    } else if (rsi > 70) {
      qualityScore += 3;
      confirmations.push('RSI_OVERBOUGHT');
    } else if (rsi > 60) {
      qualityScore += 1;
    }
    
    // Bollinger Bands
    if (price < bb.lower) {
      qualityScore += 2;
      confirmations.push('BB_OVERSOLD');
    } else if (price > bb.upper) {
      qualityScore += 2;
      confirmations.push('BB_OVERBOUGHT');
    }
    
    // MACD
    if (macd.histogram > 0) {
      qualityScore += 1;
      confirmations.push('MACD_POSITIVE');
    } else {
      qualityScore += 1;
      confirmations.push('MACD_NEGATIVE');
    }
    
    // EMA
    if (ema20 > ema50) {
      qualityScore += 1;
      confirmations.push('EMA_BULLISH');
    } else {
      qualityScore += 1;
      confirmations.push('EMA_BEARISH');
    }
    
    // Объем
    if (volume > CONFIG.minVolume * 3) {
      qualityScore += 1;
      confirmations.push('HIGH_VOLUME');
    }
    
    // Минимальные требования
    if (qualityScore < CONFIG.minQualityScore) return null;
    
    // Определяем сигнал (ПРОСТАЯ ЛОГИКА)
    let signal = null;
    let confidence = 0;
    
    // LONG: RSI низкий + цена ниже BB нижней полосы
    if (rsi < 35 && price < bb.lower * 1.02) {
      signal = 'LONG';
      confidence = Math.min(95, 60 + (35 - rsi) * 0.8 + confirmations.length * 3);
    }
    // SHORT: RSI высокий + цена выше BB верхней полосы
    else if (rsi > 65 && price > bb.upper * 0.98) {
      signal = 'SHORT';
      confidence = Math.min(95, 60 + (rsi - 65) * 0.8 + confirmations.length * 3);
    }
    // LONG по тренду: EMA восходящий + MACD положительный
    else if (ema20 > ema50 && macd.histogram > 0 && rsi < 60) {
      signal = 'LONG';
      confidence = Math.min(85, 55 + confirmations.length * 2);
    }
    // SHORT по тренду: EMA нисходящий + MACD отрицательный
    else if (ema20 < ema50 && macd.histogram < 0 && rsi > 40) {
      signal = 'SHORT';
      confidence = Math.min(85, 55 + confirmations.length * 2);
    }
    
    if (!signal || confidence < CONFIG.minConfidence) return null;
    
    // Рассчитываем TP/SL (ПРОСТО)
    const atr = Math.abs(prices[prices.length - 1] - prices[prices.length - 2]) || price * 0.01;
    let sl, tp;
    
    if (signal === 'LONG') {
      sl = price - (atr * 2.0);
      tp = price + (price - sl) * CONFIG.minRRRatio;
    } else {
      sl = price + (atr * 2.0);
      tp = price - (sl - price) * CONFIG.minRRRatio;
    }
    
    const rrRatio = signal === 'LONG' 
      ? (tp - price) / (price - sl)
      : (price - tp) / (sl - price);
    
    if (rrRatio < CONFIG.minRRRatio) return null;
    
    // Определяем уровень
    const tier = confidence >= 70 ? '🔥 PREMIUM' : '⭐ STANDARD';
    
    return {
      pair: `${base}/USDT`,
      symbol: base,
      signal,
      entry: parseFloat(price.toFixed(6)),
      tp: parseFloat(tp.toFixed(6)),
      sl: parseFloat(sl.toFixed(6)),
      confidence: Math.round(confidence),
      qualityScore,
      rrRatio: parseFloat(rrRatio.toFixed(1)),
      tier,
      exchange,
      indicators: {
        rsi: Math.round(rsi),
        bbUpper: parseFloat(bb.upper.toFixed(6)),
        bbLower: parseFloat(bb.lower.toFixed(6)),
        ema20: parseFloat(ema20.toFixed(6)),
        ema50: parseFloat(ema50.toFixed(6))
      },
      confirmations,
      change24h: parseFloat(change.toFixed(2)),
      volume: parseFloat((volume / 1000000).toFixed(1)), // в миллионах
      timestamp: new Date()
    };
    
  } catch (error) {
    // console.log(`⚠️ Ошибка анализа ${coin?.symbol}:`, error.message);
    return null;
  }
}

// ==================== ГЛАВНАЯ ФУНКЦИЯ ====================

async function generateSignals() {
  console.log('\n🔍 Начинаю сканирование...');
  
  try {
    // Получаем монеты с обеих бирж
    const [binanceCoins, bybitCoins] = await Promise.all([
      getBinanceCoins(),
      getBybitCoins()
    ]);
    
    // Объединяем и убираем дубликаты
    const allCoins = [...binanceCoins, ...bybitCoins];
    const uniqueCoins = [];
    const seen = new Set();
    
    for (const coin of allCoins) {
      const key = coin.base.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        uniqueCoins.push(coin);
      }
    }
    
    console.log(`📊 Всего монет для анализа: ${uniqueCoins.length}`);
    
    if (uniqueCoins.length === 0) {
      console.log('❌ Нет монет для анализа');
      return [];
    }
    
    // Анализируем каждую монету (ограниченное количество)
    const signals = [];
    const coinsToAnalyze = uniqueCoins.slice(0, 30); // Анализируем только 30
    
    for (const coin of coinsToAnalyze) {
      try {
        const signal = await analyzeCoin(coin);
        if (signal) {
          signals.push(signal);
          console.log(`✅ Найден сигнал: ${signal.pair} (${signal.signal}) ${signal.confidence}%`);
        }
      } catch (err) {
        // Пропускаем ошибки
      }
      
      // Маленькая пауза
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Сортируем по уверенности
    signals.sort((a, b) => b.confidence - a.confidence);
    
    console.log(`🎯 Найдено сигналов: ${signals.length}`);
    
    // Возвращаем лучшие
    return signals.slice(0, CONFIG.maxSignals);
    
  } catch (error) {
    console.error('❌ Ошибка генерации сигналов:', error.message);
    return [];
  }
}

// ==================== ОТПРАВКА В TELEGRAM ====================

async function sendSignalToTelegram(signal) {
  if (!CHAT_ID) {
    console.log('⚠️ Нет CHAT_ID');
    return false;
  }
  
  try {
    const direction = signal.signal === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
    const change = signal.change24h > 0 ? '📈' : '📉';
    
    const message = `
${signal.tier} ${direction} ${signal.pair}

💵 Цена: $${signal.entry}
${change} 24ч: ${signal.change24h}%
📊 Объём: $${signal.volume}M

🎯 TP: $${signal.tp}
🛑 SL: $${signal.sl}
⚖️ R/R: 1:${signal.rrRatio}

📈 Индикаторы:
RSI: ${signal.indicators.rsi}
BB: $${signal.indicators.bbLower} - $${signal.indicators.bbUpper}
EMA20: $${signal.indicators.ema20}
EMA50: $${signal.indicators.ema50}

✅ Подтверждений: ${signal.confirmations.length}
🏆 Качество: ${signal.qualityScore}/10
📊 Уверенность: ${signal.confidence}%

🏦 Биржа: ${signal.exchange}
⏰ ${signal.timestamp.toLocaleTimeString('ru-RU')}
`.trim();
    
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    return true;
  } catch (error) {
    console.error('❌ Ошибка отправки:', error.message);
    return false;
  }
}

// ==================== ЗАДАЧА ====================

async function runSignalsTask() {
  console.log('\n' + '='.repeat(50));
  console.log('🚀 ЗАПУСК СКАНИРОВАНИЯ');
  console.log('='.repeat(50));
  
  try {
    const signals = await generateSignals();
    
    if (signals.length === 0) {
      console.log('ℹ️ Сигналов не найдено');
      
      // Можно отправлять пустое сообщение или ничего не делать
      if (CHAT_ID && signals.length === 0) {
        await bot.telegram.sendMessage(
          CHAT_ID,
          `🔍 Сканирование ${new Date().toLocaleTimeString('ru-RU')}\n📊 Сигналов не найдено\n🔄 Следующее через 10 мин`,
          { parse_mode: 'HTML' }
        );
      }
      return;
    }
    
    console.log(`📤 Отправляю ${signals.length} сигналов...`);
    
    // Отправляем статус
    if (CHAT_ID) {
      await bot.telegram.sendMessage(
        CHAT_ID,
        `🎯 Найдено ${signals.length} сигналов\n🔥 Лучший: ${signals[0].pair} (${signals[0].confidence}%)\n${'='.repeat(30)}`,
        { parse_mode: 'HTML' }
      );
    }
    
    // Отправляем каждый сигнал
    for (const signal of signals) {
      await sendSignalToTelegram(signal);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log(`✅ Готово! Отправлено ${signals.length} сигналов`);
    
  } catch (error) {
    console.error('❌ Ошибка задачи:', error.message);
  }
}

// ==================== ЗАПУСК ====================

async function start() {
  try {
    console.log('🤖 Запуск бота...');
    
    await bot.telegram.deleteWebhook();
    bot.launch();
    
    console.log('✅ Бот запущен');
    console.log('⏰ CRON каждые 10 минут');
    
    // Запускаем сразу
    setTimeout(runSignalsTask, 3000);
    
    // И по расписанию
    cron.schedule('*/10 * * * *', runSignalsTask);
    
  } catch (error) {
    console.error('❌ Ошибка запуска:', error);
  }
}

// Выключение
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Старт
start();
