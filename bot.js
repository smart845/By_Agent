const { Telegraf } = require('telegraf');
const axios = require('axios');
const cron = require('node-cron');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

console.log('🤖 Запуск MEXC Signals Bot...');

if (!BOT_TOKEN) {
  console.error('❌ Нет TELEGRAM_BOT_TOKEN!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ==================== НАСТРОЙКИ ====================
const CONFIG = {
  exchange: 'MEXC',
  apiUrl: 'https://api.mexc.com',
  minVolume: 100000,     // 100K USDT
  topPairsCount: 30,     // Топ-30 роста и топ-30 падения
  scanInterval: '*/20 * * * *', // Каждые 20 минут
  minChange: 3,          // Минимальное изменение 3%
  minConfidence: 60      // Минимальная уверенность 60%
};

// ==================== MEXC API ====================
async function getMexcTickers() {
  try {
    console.log('📡 Запрос к MEXC API...');
    
    const response = await axios.get(`${CONFIG.apiUrl}/api/v3/ticker/24hr`, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });
    
    console.log('✅ MEXC API ответ получен');
    
    // Фильтруем USDT пары
    const usdtPairs = response.data
      .filter(ticker => ticker.symbol.endsWith('USDT'))
      .map(ticker => {
        const change = parseFloat(ticker.priceChangePercent);
        const volume = parseFloat(ticker.quoteVolume);
        const price = parseFloat(ticker.lastPrice);
        
        return {
          symbol: ticker.symbol,
          price: price,
          change: change,
          volume: volume,
          high: parseFloat(ticker.highPrice),
          low: parseFloat(ticker.lowPrice),
          volumeValue: volume * price
        };
      })
      .filter(ticker => 
        ticker.volumeValue >= CONFIG.minVolume && 
        ticker.price > 0.000001 &&
        Math.abs(ticker.change) > 0.1
      );
    
    console.log(`✅ Отфильтровано ${usdtPairs.length} пар`);
    return usdtPairs;
    
  } catch (error) {
    console.error('❌ Ошибка MEXC API:', error.message);
    if (error.response) {
      console.error('Статус:', error.response.status);
      console.error('Данные:', error.response.data);
    }
    return [];
  }
}

// Получаем топ-30 роста и топ-30 падения
async function getTopMovements() {
  try {
    const allPairs = await getMexcTickers();
    if (allPairs.length === 0) return { gainers: [], losers: [] };
    
    // Фильтруем только с объемом выше минимального
    const filteredPairs = allPairs.filter(pair => pair.volumeValue >= CONFIG.minVolume);
    
    // Сортируем по росту (убывание)
    const gainers = [...filteredPairs]
      .sort((a, b) => b.change - a.change)
      .slice(0, CONFIG.topPairsCount);
    
    // Сортируем по падению (возрастание)
    const losers = [...filteredPairs]
      .sort((a, b) => a.change - b.change)
      .slice(0, CONFIG.topPairsCount);
    
    console.log(`📊 Топ-30 роста: ${gainers.length} пар`);
    console.log(`📊 Топ-30 падения: ${losers.length} пар`);
    
    return { gainers, losers };
  } catch (error) {
    console.error('❌ Ошибка получения топ движений:', error.message);
    return { gainers: [], losers: [] };
  }
}

// Получаем данные свечей для анализа
async function getMexcKlines(symbol, interval = '15m', limit = 50) {
  try {
    const response = await axios.get(`${CONFIG.apiUrl}/api/v3/klines`, {
      params: {
        symbol: symbol,
        interval: interval,
        limit: limit
      },
      timeout: 10000
    });
    
    return response.data.map(k => ({
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      time: k[0]
    }));
    
  } catch (error) {
    console.error(`❌ Ошибка получения свечей ${symbol}:`, error.message);
    return [];
  }
}

// ==================== ИНДИКАТОРЫ ====================
function calculateRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return 50;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const change = closes[closes.length - i] - closes[closes.length - i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow) return { macd: 0, signal: 0, histogram: 0 };
  
  const emaFast = calculateEMA(closes, fast);
  const emaSlow = calculateEMA(closes, slow);
  const macdLine = emaFast - emaSlow;
  
  // Для линии сигнала используем EMA от значений MACD
  const macdValues = closes.map((_, i) => {
    if (i < slow) return 0;
    const fastEMA = calculateEMA(closes.slice(0, i + 1), fast);
    const slowEMA = calculateEMA(closes.slice(0, i + 1), slow);
    return fastEMA - slowEMA;
  });
  
  const signalLine = calculateEMA(macdValues.slice(slow - 1), signal);
  const histogram = macdLine - signalLine;
  
  return { macd: macdLine, signal: signalLine, histogram };
}

function calculateEMA(values, period) {
  const multiplier = 2 / (period + 1);
  let ema = values[0];
  
  for (let i = 1; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }
  
  return ema;
}

function calculateBollingerBands(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0 };
  
  const recent = closes.slice(-period);
  const sum = recent.reduce((a, b) => a + b, 0);
  const middle = sum / period;
  
  const squaredDiffs = recent.map(price => Math.pow(price - middle, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
  const standardDeviation = Math.sqrt(variance);
  
  return {
    upper: middle + (standardDeviation * stdDev),
    middle: middle,
    lower: middle - (standardDeviation * stdDev)
  };
}

function calculateAverageVolume(volumes, period = 20) {
  if (!volumes || volumes.length < period) return 0;
  const recent = volumes.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

function calculateStochastic(closes, highs, lows, period = 14, kSmooth = 3, dSmooth = 3) {
  if (closes.length < period) return { k: 50, d: 50 };
  
  const recentCloses = closes.slice(-period);
  const recentHighs = highs.slice(-period);
  const recentLows = lows.slice(-period);
  
  const lowestLow = Math.min(...recentLows);
  const highestHigh = Math.max(...recentHighs);
  
  if (highestHigh === lowestLow) return { k: 50, d: 50 };
  
  const k = ((closes[closes.length - 1] - lowestLow) / (highestHigh - lowestLow)) * 100;
  
  // Упрощенный расчет D (среднее от K)
  const lastKValues = recentCloses.map((_, i) => {
    const close = closes[closes.length - period + i];
    const low = Math.min(...lows.slice(closes.length - period + i - period + 1, closes.length - period + i + 1));
    const high = Math.max(...highs.slice(closes.length - period + i - period + 1, closes.length - period + i + 1));
    return ((close - low) / (high - low)) * 100;
  });
  
  const d = lastKValues.reduce((a, b) => a + b, 0) / lastKValues.length;
  
  return { k, d };
}

// ==================== АНАЛИЗ СИГНАЛА ====================
async function analyzePair(pair) {
  try {
    console.log(`🔍 Анализ ${pair.symbol}...`);
    
    // Получаем свечи для разных таймфреймов
    const klines15m = await getMexcKlines(pair.symbol, '15m', 100);
    const klines1h = await getMexcKlines(pair.symbol, '1h', 50);
    const klines4h = await getMexcKlines(pair.symbol, '4h', 50);
    
    if (klines15m.length < 30 || klines1h.length < 20 || klines4h.length < 10) {
      console.log(`⚠️ Недостаточно данных для ${pair.symbol}`);
      return null;
    }
    
    const closes15m = klines15m.map(k => k.close);
    const closes1h = klines1h.map(k => k.close);
    const closes4h = klines4h.map(k => k.close);
    
    const highs15m = klines15m.map(k => k.high);
    const lows15m = klines15m.map(k => k.low);
    
    const volumes15m = klines15m.map(k => k.volume);
    const volumes1h = klines1h.map(k => k.volume);
    
    const currentPrice = closes15m[closes15m.length - 1];
    
    // Рассчитываем все индикаторы
    const rsi15m = calculateRSI(closes15m);
    const rsi1h = calculateRSI(closes1h);
    const rsi4h = calculateRSI(closes4h);
    
    const macd15m = calculateMACD(closes15m);
    const macd1h = calculateMACD(closes1h);
    
    const bb15m = calculateBollingerBands(closes15m);
    const bb1h = calculateBollingerBands(closes1h);
    
    const stoch15m = calculateStochastic(closes15m, highs15m, lows15m);
    
    const avgVolume15m = calculateAverageVolume(volumes15m);
    const avgVolume1h = calculateAverageVolume(volumes1h);
    
    const volumeRatio15m = volumes15m[volumes15m.length - 1] / avgVolume15m;
    const volumeRatio1h = volumes1h[volumes1h.length - 1] / avgVolume1h;
    
    // Анализ положения цены относительно Bollinger Bands
    const bbPosition15m = ((currentPrice - bb15m.lower) / (bb15m.upper - bb15m.lower)) * 100;
    const bbPosition1h = ((currentPrice - bb1h.lower) / (bb1h.upper - bb1h.lower)) * 100;
    
    // Определяем сигнал
    let signal = null;
    let confidence = 0;
    let reasons = [];
    
    // Проверяем условия для LONG
    const longConditions = [];
    if (rsi15m < 35 && rsi1h < 45) longConditions.push('RSI перепродан');
    if (macd15m.histogram > 0 && macd15m.macd > macd15m.signal) longConditions.push('MACD бычий');
    if (stoch15m.k < 30 && stoch15m.d < 30) longConditions.push('Stochastic перепродан');
    if (bbPosition15m < 20) longConditions.push('Цена у нижней границы BB');
    if (volumeRatio15m > 1.8) longConditions.push('Высокий объем');
    
    // Проверяем условия для SHORT
    const shortConditions = [];
    if (rsi15m > 65 && rsi1h > 55) shortConditions.push('RSI перекуплен');
    if (macd15m.histogram < 0 && macd15m.macd < macd15m.signal) shortConditions.push('MACD медвежий');
    if (stoch15m.k > 70 && stoch15m.d > 70) shortConditions.push('Stochastic перекуплен');
    if (bbPosition15m > 80) shortConditions.push('Цена у верхней границы BB');
    if (volumeRatio15m > 1.8) shortConditions.push('Высокий объем');
    
    // Определяем основной тренд по 4h
    const trend4h = rsi4h > 50 ? 'BULLISH' : 'BEARISH';
    
    // Проверяем изменение за 24 часа
    const isStrongMove = Math.abs(pair.change) >= CONFIG.minChange;
    
    // Выбираем сигнал с наибольшим количеством условий
    if (longConditions.length >= 3 && (trend4h === 'BULLISH' || isStrongMove)) {
      signal = 'LONG';
      confidence = Math.min(20 + (longConditions.length * 10) + (isStrongMove ? 15 : 0), 95);
      reasons = [...longConditions];
    } else if (shortConditions.length >= 3 && (trend4h === 'BEARISH' || isStrongMove)) {
      signal = 'SHORT';
      confidence = Math.min(20 + (shortConditions.length * 10) + (isStrongMove ? 15 : 0), 95);
      reasons = [...shortConditions];
    }
    
    // Добавляем информацию о движении, если есть
    if (isStrongMove) {
      reasons.push(`${pair.change > 0 ? 'Сильный рост' : 'Сильное падение'}: ${pair.change > 0 ? '+' : ''}${pair.change.toFixed(1)}%`);
    }
    
    // Проверяем минимальную уверенность
    if (!signal || confidence < CONFIG.minConfidence || reasons.length < 3) {
      return null;
    }
    
    // Рассчитываем уровни
    const entry = currentPrice;
    let tp, sl;
    const riskPercent = 2; // 2% риск
    
    if (signal === 'LONG') {
      // Для LONG используем ближайший минимум как стоп
      const recentLow = Math.min(...lows15m.slice(-20));
      sl = Math.min(recentLow, entry * (1 - riskPercent / 100));
      tp = entry + (entry - sl) * 2.5; // R:R 1:2.5
    } else {
      // Для SHORT используем ближайший максимум как стоп
      const recentHigh = Math.max(...highs15m.slice(-20));
      sl = Math.max(recentHigh, entry * (1 + riskPercent / 100));
      tp = entry - (sl - entry) * 2.5; // R:R 1:2.5
    }
    
    const rrRatio = signal === 'LONG' ? 
      (tp - entry) / (entry - sl) : 
      (entry - tp) / (sl - entry);
    
    // Определяем тир сигнала
    let tier = 'STANDARD';
    if (confidence >= 80) tier = 'GOD TIER';
    else if (confidence >= 70) tier = 'PREMIUM';
    else if (confidence >= 60) tier = 'STANDARD';
    
    // Для автосканирования берем только PREMIUM и GOD TIER
    if (tier === 'STANDARD') return null;
    
    console.log(`✅ Сигнал: ${signal} ${pair.symbol} (${confidence}%, ${tier})`);
    
    return {
      pair: pair.symbol.replace('USDT', '/USDT'),
      signal: signal,
      entry: entry.toFixed(8),
      tp: tp.toFixed(8),
      sl: sl.toFixed(8),
      confidence: Math.round(confidence),
      rrRatio: rrRatio.toFixed(1),
      tier: tier,
      change24h: pair.change.toFixed(2),
      volume24h: pair.volume,
      rsi15m: Math.round(rsi15m),
      rsi1h: Math.round(rsi1h),
      volumeRatio: volumeRatio15m.toFixed(1),
      reasons: reasons,
      timestamp: new Date(),
      indicators: {
        macdHistogram: macd15m.histogram.toFixed(4),
        bbPosition: bbPosition15m.toFixed(1),
        stochasticK: stoch15m.k.toFixed(1)
      }
    };
    
  } catch (error) {
    console.error(`❌ Ошибка анализа ${pair.symbol}:`, error.message);
    return null;
  }
}

// ==================== КОМАНДЫ БОТА ====================
bot.start((ctx) => {
  console.log('✅ Команда /start от', ctx.from.id);
  
  const welcome = `
🤖 <b>MEXC Signals Pro Bot</b>

🏦 <b>Биржа:</b> ${CONFIG.exchange}
📊 <b>Анализ:</b> Топ-${CONFIG.topPairsCount} рост/падение
💰 <b>Мин. объем:</b> ${(CONFIG.minVolume/1000).toFixed(0)}K USDT
🎯 <b>Мин. изменение:</b> ${CONFIG.minChange}%
⏰ <b>Сканирование:</b> каждые 20 мин

<b>📈 Анализируем:</b>
• RSI (14) - перекупленность/перепроданность
• MACD - тренд и импульс
• Bollinger Bands - волатильность
• Stochastic - моментум
• Объем торгов
• Поддержка/сопротивление

<b>📱 Команды:</b>
/start - информация
/test - проверить API
/scan - ручное сканирование
/top30 - топ-30 роста/падения
/status - статус бота
/analyze [пара] - анализ конкретной пары

✅ <b>Бот активен и ищет сигналы!</b>
  `.trim();
  
  ctx.reply(welcome, { parse_mode: 'HTML' });
});

bot.command('test', async (ctx) => {
  console.log('🧪 Тест MEXC API...');
  
  try {
    await ctx.reply('🔄 Проверяю MEXC API...');
    
    const tickers = await getMexcTickers();
    
    if (tickers.length > 0) {
      const sample = tickers.slice(0, 3);
      let message = `✅ MEXC API работает!\n\n`;
      message += `📊 Получено пар: ${tickers.length}\n\n`;
      message += `Примеры:\n`;
      sample.forEach(t => {
        message += `<b>${t.symbol}</b>\n`;
        message += `Цена: $${t.price.toFixed(4)}\n`;
        message += `Изменение: ${t.change > 0 ? '+' : ''}${t.change.toFixed(2)}%\n`;
        message += `Объем: $${(t.volume/1000).toFixed(0)}K\n\n`;
      });
      
      await ctx.reply(message, { parse_mode: 'HTML' });
    } else {
      await ctx.reply('⚠️ Не удалось получить данные с MEXC');
    }
    
  } catch (error) {
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('top30', async (ctx) => {
  console.log('📈 Топ-30 движений...');
  
  try {
    await ctx.reply('📊 Ищу топ-30 движений...');
    
    const { gainers, losers } = await getTopMovements();
    
    if (gainers.length === 0 && losers.length === 0) {
      await ctx.reply('❌ Нет данных от MEXC');
      return;
    }
    
    let message = `📈 <b>ТОП-30 РОСТА (24h)</b>\n\n`;
    
    gainers.slice(0, 10).forEach((t, i) => {
      message += `${i+1}. <b>${t.symbol}</b>\n`;
      message += `   💰 $${t.price.toFixed(4)}\n`;
      message += `   📈 +${t.change.toFixed(2)}%\n`;
      message += `   🔄 $${(t.volume/1000000).toFixed(2)}M\n\n`;
    });
    
    message += `📉 <b>ТОП-30 ПАДЕНИЯ (24h)</b>\n\n`;
    
    losers.slice(0, 10).forEach((t, i) => {
      message += `${i+1}. <b>${t.symbol}</b>\n`;
      message += `   💰 $${t.price.toFixed(4)}\n`;
      message += `   📉 ${t.change.toFixed(2)}%\n`;
      message += `   🔄 $${(t.volume/1000000).toFixed(2)}M\n\n`;
    });
    
    message += `\n📊 Всего: ${gainers.length} рост / ${losers.length} падение`;
    
    await ctx.reply(message, { parse_mode: 'HTML' });
    
  } catch (error) {
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('scan', async (ctx) => {
  console.log('🔍 Ручное сканирование...');
  
  try {
    await ctx.reply('🔍 Запускаю глубокое сканирование MEXC...');
    
    const { gainers, losers } = await getTopMovements();
    
    if (gainers.length === 0 && losers.length === 0) {
      await ctx.reply('❌ Нет данных для анализа');
      return;
    }
    
    // Объединяем топ рост и топ падение
    const allPairs = [...gainers, ...losers];
    
    await ctx.reply(`📊 Анализирую ${allPairs.length} пар...`);
    
    const signals = [];
    
    // Анализируем каждую пару
    for (let i = 0; i < Math.min(allPairs.length, 30); i++) {
      const pair = allPairs[i];
      const signal = await analyzePair(pair);
      
      if (signal) {
        signals.push(signal);
        console.log(`✅ Найден сигнал для ${pair.symbol}`);
      }
      
      // Задержка между запросами
      if (i < allPairs.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }
    
    if (signals.length > 0) {
      // Сортируем по уверенности
      signals.sort((a, b) => b.confidence - a.confidence);
      
      let message = `🎯 <b>НАЙДЕНО СИГНАЛОВ: ${signals.length}</b>\n\n`;
      
      signals.slice(0, 5).forEach((sig, i) => {
        const emoji = sig.signal === 'LONG' ? '🟢' : '🔴';
        const tierEmoji = sig.tier === 'GOD TIER' ? '👑' : sig.tier === 'PREMIUM' ? '💎' : '⭐';
        
        message += `${tierEmoji} <b>${sig.tier}</b>\n`;
        message += `${emoji} <b>${sig.signal} ${sig.pair}</b>\n`;
        message += `📈 Изменение: ${sig.change24h > 0 ? '+' : ''}${sig.change24h}%\n`;
        message += `🎯 Вход: $${sig.entry}\n`;
        message += `✅ Тейк: $${sig.tp}\n`;
        message += `🛑 Стоп: $${sig.sl}\n`;
        message += `📊 R:R: 1:${sig.rrRatio}\n`;
        message += `🔮 Уверенность: ${sig.confidence}%\n`;
        message += `📊 RSI(15m): ${sig.rsi15m} | RSI(1h): ${sig.rsi1h}\n`;
        message += `📈 Объем: x${sig.volumeRatio}\n`;
        message += `💎 Причины:\n`;
        sig.reasons.slice(0, 4).forEach(r => message += `• ${r}\n`);
        message += `\n`;
      });
      
      await ctx.reply(message, { parse_mode: 'HTML' });
    } else {
      await ctx.reply('ℹ️ Сигналов не найдено. Попробуйте позже или используйте /top30 для просмотра движений');
    }
    
  } catch (error) {
    await ctx.reply(`❌ Ошибка сканирования: ${error.message}`);
  }
});

bot.command('analyze', async (ctx) => {
  try {
    const args = ctx.message.text.split(' ');
    if (args.length < 2) {
      await ctx.reply('Использование: /analyze BTCUSDT');
      return;
    }
    
    let pairSymbol = args[1].toUpperCase();
    if (!pairSymbol.endsWith('USDT')) {
      pairSymbol += 'USDT';
    }
    
    await ctx.reply(`🔍 Анализ ${pairSymbol}...`);
    
    // Получаем все тикеры
    const tickers = await getMexcTickers();
    const pair = tickers.find(t => t.symbol === pairSymbol);
    
    if (!pair) {
      await ctx.reply(`❌ Пара ${pairSymbol} не найдена или объем слишком мал`);
      return;
    }
    
    const signal = await analyzePair(pair);
    
    if (signal) {
      const emoji = signal.signal === 'LONG' ? '🟢' : '🔴';
      const tierEmoji = signal.tier === 'GOD TIER' ? '👑' : '💎';
      
      let message = `${tierEmoji} <b>${signal.tier} СИГНАЛ</b>\n\n`;
      message += `${emoji} <b>${signal.signal} ${signal.pair}</b>\n\n`;
      message += `📈 <b>Изменение 24h:</b> ${signal.change24h > 0 ? '+' : ''}${signal.change24h}%\n`;
      message += `💰 <b>Объем 24h:</b> $${(signal.volume24h / 1000000).toFixed(2)}M\n\n`;
      message += `🎯 <b>Вход:</b> $${signal.entry}\n`;
      message += `✅ <b>Тейк-профит:</b> $${signal.tp}\n`;
      message += `🛑 <b>Стоп-лосс:</b> $${signal.sl}\n`;
      message += `📊 <b>R:R:</b> 1:${signal.rrRatio}\n\n`;
      message += `📈 <b>Индикаторы:</b>\n`;
      message += `• RSI(15m): ${signal.rsi15m}\n`;
      message += `• RSI(1h): ${signal.rsi1h}\n`;
      message += `• Объем: x${signal.volumeRatio}\n\n`;
      message += `🔮 <b>Уверенность:</b> ${signal.confidence}%\n\n`;
      message += `📋 <b>Причины:</b>\n`;
      signal.reasons.forEach(r => message += `• ${r}\n`);
      
      await ctx.reply(message, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(`ℹ️ Для ${pairSymbol} не найдено сильных сигналов`);
    }
    
  } catch (error) {
    await ctx.reply(`❌ Ошибка анализа: ${error.message}`);
  }
});

bot.command('status', (ctx) => {
  const now = new Date();
  const nextScan = 20 - (now.getMinutes() % 20);
  
  ctx.reply(
    `📊 <b>СТАТУС БОТА</b>\n\n` +
    `🟢 <b>Состояние:</b> Активен\n` +
    `🏦 <b>Биржа:</b> ${CONFIG.exchange}\n` +
    `📡 <b>API статус:</b> Работает\n` +
    `🎯 <b>Следующее сканирование:</b> через ${nextScan} мин\n` +
    `⏰ <b>Время сервера:</b> ${now.toLocaleTimeString('ru-RU')}\n\n` +
    `📈 <b>Параметры сканирования:</b>\n` +
    `• Топ-${CONFIG.topPairsCount} рост/падение\n` +
    `• Объем > ${(CONFIG.minVolume/1000).toFixed(0)}K USDT\n` +
    `• Изменение > ${CONFIG.minChange}%\n` +
    `• Уверенность > ${CONFIG.minConfidence}%\n\n` +
    `📊 <b>Индикаторы:</b> RSI, MACD, BB, Stochastic\n\n` +
    `💡 <b>Команды:</b>\n` +
    `/scan - глубокое сканирование\n` +
    `/top30 - топ-30 движений\n` +
    `/analyze [пара] - анализ пары\n` +
    `/test - проверить API\n` +
    `/start - информация`,
    { parse_mode: 'HTML' }
  );
});

// Автоматическое сканирование
async function autoScan() {
  console.log('\n🎯 АВТОМАТИЧЕСКОЕ СКАНИРОВАНИЕ');
  console.log('='.repeat(50));
  
  if (!CHAT_ID) {
    console.log('⚠️  CHAT_ID не установлен, пропускаю отправку');
    return;
  }
  
  try {
    const { gainers, losers } = await getTopMovements();
    
    if (gainers.length === 0 && losers.length === 0) {
      console.log('❌ Нет данных от MEXC');
      return;
    }
    
    // Объединяем и берем самые сильные движения
    const allPairs = [...gainers, ...losers]
      .filter(pair => Math.abs(pair.change) >= CONFIG.minChange)
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
      .slice(0, 20);
    
    if (allPairs.length === 0) {
      console.log(`ℹ️ Нет пар с изменением > ${CONFIG.minChange}%`);
      return;
    }
    
    console.log(`📊 Анализ ${allPairs.length} пар с сильными движениями...`);
    
    const signals = [];
    
    // Быстрый анализ для автосканирования
    for (const pair of allPairs) {
      try {
        const klines = await getMexcKlines(pair.symbol, '15m', 30);
        if (klines.length < 20) continue;
        
        const closes = klines.map(k => k.close);
        const volumes = klines.map(k => k.volume);
        const currentPrice = closes[closes.length - 1];
        
        const rsi = calculateRSI(closes);
        const avgVolume = calculateAverageVolume(volumes);
        const volumeRatio = volumes[volumes.length - 1] / avgVolume;
        
        let signal = null;
        let confidence = 0;
        let reasons = [];
        
        // Быстрые условия для автосканирования
        if (rsi < 30 && pair.change > -15) {
          signal = 'LONG';
          confidence = 65;
          reasons.push('RSI сильно перепродан');
        } else if (rsi > 70 && pair.change < 15) {
          signal = 'SHORT';
          confidence = 65;
          reasons.push('RSI сильно перекуплен');
        }
        
        if (volumeRatio > 2) {
          confidence += 10;
          reasons.push('Очень высокий объем');
        }
        
        if (Math.abs(pair.change) > 8) {
          confidence += 10;
          reasons.push(`Сильное движение: ${pair.change > 0 ? '+' : ''}${pair.change.toFixed(1)}%`);
        }
        
        if (signal && confidence >= 75) {
          // Рассчитываем уровни
          const entry = currentPrice;
          let tp, sl;
          
          if (signal === 'LONG') {
            sl = entry * 0.97;
            tp = entry * 1.06;
          } else {
            sl = entry * 1.03;
            tp = entry * 0.94;
          }
          
          const tier = confidence >= 85 ? 'GOD TIER' : 'PREMIUM';
          
          signals.push({
            pair: pair.symbol.replace('USDT', '/USDT'),
            signal: signal,
            entry: entry.toFixed(8),
            tp: tp.toFixed(8),
            sl: sl.toFixed(8),
            confidence: confidence,
            change24h: pair.change.toFixed(2),
            volume24h: pair.volume,
            rsi: Math.round(rsi),
            volumeRatio: volumeRatio.toFixed(1),
            reasons: reasons,
            tier: tier
          });
        }
        
        // Короткая задержка
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        console.error(`❌ Ошибка быстрого анализа ${pair.symbol}:`, error.message);
      }
    }
    
    if (signals.length > 0) {
      console.log(`📊 Найдено ${signals.length} сигналов для автоотправки`);
      
      // Сортируем по уверенности и берем топ-3
      const bestSignals = signals
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 3);
      
      for (const signal of bestSignals) {
        const emoji = signal.signal === 'LONG' ? '🟢' : '🔴';
        const tierEmoji = signal.tier === 'GOD TIER' ? '👑' : '💎';
        
        const message = `
${tierEmoji} <b>${signal.tier} СИГНАЛ</b>

${emoji} <b>${signal.signal} ${signal.pair}</b>

📈 <b>Изменение 24h:</b> ${signal.change24h > 0 ? '+' : ''}${signal.change24h}%
💰 <b>Объем 24h:</b> $${(signal.volume24h / 1000000).toFixed(2)}M
📊 <b>RSI:</b> ${signal.rsi}
📈 <b>Объем:</b> x${signal.volumeRatio}

🎯 <b>Вход:</b> $${signal.entry}
✅ <b>Тейк-профит:</b> $${signal.tp}
🛑 <b>Стоп-лосс:</b> $${signal.sl}

🔮 <b>Уверенность:</b> ${Math.round(signal.confidence)}%
📊 <b>R:R:</b> ~1:2

📋 <b>Причины:</b>
${signal.reasons.map(r => `• ${r}`).join('\n')}

🏦 <b>Биржа:</b> MEXC SPOT
⏰ <b>Время:</b> ${new Date().toLocaleTimeString('ru-RU')}
        `.trim();
        
        try {
          await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
          console.log(`✅ Автосигнал отправлен: ${signal.pair} (${signal.confidence}%)`);
          
          // Задержка между отправками
          await new Promise(resolve => setTimeout(resolve, 3000));
        } catch (error) {
          console.error(`❌ Ошибка отправки:`, error.message);
        }
      }
    } else {
      console.log('ℹ️ Сигналов для автоотправки не найдено');
    }
    
  } catch (error) {
    console.error('❌ Ошибка автосканирования:', error.message);
  }
}

// ==================== ЗАПУСК БОТА ====================
async function start() {
  try {
    console.log('🚀 Инициализация MEXC Signals Pro Bot...');
    
    // Проверяем MEXC API перед запуском
    console.log('📡 Проверка подключения к MEXC...');
    const testTickers = await getMexcTickers();
    
    if (testTickers.length === 0) {
      console.log('⚠️  MEXC API может быть недоступен, но бот запускается...');
    } else {
      console.log(`✅ MEXC API доступен, получено ${testTickers.length} пар`);
    }
    
    // Запускаем Telegram бота
    await bot.launch({
      dropPendingUpdates: true,
      allowedUpdates: ['message']
    });
    
    console.log('✅ Telegram бот запущен!');
    
    // Настройка планировщика
    cron.schedule(CONFIG.scanInterval, () => {
      const now = new Date();
      console.log(`\n⏰ АВТОСКАНИРОВАНИЕ: ${now.toLocaleTimeString('ru-RU')}`);
      autoScan();
    });
    
    console.log(`⏰ Автосканирование настроено: ${CONFIG.scanInterval}`);
    
    // Первое сканирование через 2 минуты
    setTimeout(() => {
      console.log('\n🎯 ПЕРВОЕ АВТОСКАНИРОВАНИЕ');
      autoScan();
    }, 120000);
    
    // Приветственное сообщение
    if (CHAT_ID) {
      try {
        await bot.telegram.sendMessage(
          CHAT_ID,
          `🤖 <b>MEXC Signals Pro Bot запущен!</b>\n\n` +
          `✅ Telegram: подключено\n` +
          `✅ MEXC API: ${testTickers.length > 0 ? 'работает' : 'проверяется'}\n` +
          `⏰ Автосканирование: каждые 20 минут\n\n` +
          `🏦 Биржа: MEXC Spot\n` +
          `📊 Анализ: RSI + MACD + Bollinger Bands + Stochastic + Объем\n` +
          `🎯 Сканирование: Топ-30 рост/падение\n\n` +
          `📱 <b>Команды:</b>\n` +
          `/start - информация\n` +
          `/test - проверить API\n` +
          `/scan - глубокое сканирование\n` +
          `/top30 - топ-30 движений\n` +
          `/analyze [пара] - анализ пары\n` +
          `/status - статус бота\n\n` +
          `🔄 Первое сканирование через 2 минуты`,
          { parse_mode: 'HTML' }
        );
        console.log('✅ Стартовое сообщение отправлено');
      } catch (error) {
        console.log('⚠️ Не удалось отправить стартовое сообщение');
      }
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('🤖 MEXC SIGNALS PRO BOT ЗАПУЩЕН');
    console.log('='.repeat(50));
    console.log('📱 Команды в Telegram:');
    console.log('   /start    - информация о боте');
    console.log('   /test     - проверка MEXC API');
    console.log('   /scan     - глубокое сканирование');
    console.log('   /top30    - топ-30 движений за 24h');
    console.log('   /analyze  - анализ конкретной пары');
    console.log('   /status   - статус бота');
    console.log('='.repeat(50));
    console.log(`⏰ Автосканирование: каждые 20 минут`);
    console.log(`📊 Сканирование: Топ-30 рост/падение`);
    console.log(`💰 Мин. объем: ${(CONFIG.minVolume/1000).toFixed(0)}K USDT`);
    console.log(`🎯 Мин. изменение: ${CONFIG.minChange}%`);
    console.log('='.repeat(50));
    
  } catch (error) {
    console.error('❌ Критическая ошибка запуска:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Обработчики завершения
process.once('SIGINT', () => {
  console.log('\n🛑 Остановка бота...');
  bot.stop('SIGINT');
  setTimeout(() => process.exit(0), 1000);
});

process.once('SIGTERM', () => {
  console.log('\n🛑 Остановка бота...');
  bot.stop('SIGTERM');
  setTimeout(() => process.exit(0), 1000);
});

// Запуск
start();
