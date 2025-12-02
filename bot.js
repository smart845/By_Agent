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
  scanInterval: '*/10 * * * *', // Каждые 10 минут
  minChangeForSignal: 2,  // Минимальное изменение для сигнала 2%
  minConfidence: 60,      // Минимальная уверенность 60%
  minVolumeForTop: 500000 // 500K USDT для топа
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
        ticker.price > 0.000001
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
    
    // Для топа используем более высокий минимальный объем
    const filteredPairs = allPairs.filter(pair => 
      pair.volumeValue >= CONFIG.minVolumeForTop
    );
    
    // Сортируем по росту (убывание)
    const gainers = [...filteredPairs]
      .sort((a, b) => b.change - a.change)
      .slice(0, CONFIG.topPairsCount);
    
    // Сортируем по падению (возрастание)
    const losers = [...filteredPairs]
      .sort((a, b) => a.change - b.change)
      .slice(0, CONFIG.topPairsCount);
    
    // Логируем для отладки
    console.log(`📊 Топ-30 роста: ${gainers.length} пар`);
    if (gainers.length > 0) {
      console.log(`📈 Макс рост: ${gainers[0].symbol} ${gainers[0].change.toFixed(2)}%`);
      console.log(`📈 Мин рост: ${gainers[gainers.length-1].symbol} ${gainers[gainers.length-1].change.toFixed(2)}%`);
    }
    
    console.log(`📊 Топ-30 падения: ${losers.length} пар`);
    if (losers.length > 0) {
      console.log(`📉 Макс падение: ${losers[0].symbol} ${losers[0].change.toFixed(2)}%`);
      console.log(`📉 Мин падение: ${losers[losers.length-1].symbol} ${losers[losers.length-1].change.toFixed(2)}%`);
    }
    
    return { gainers, losers };
  } catch (error) {
    console.error('❌ Ошибка получения топ движений:', error.message);
    return { gainers: [], losers: [] };
  }
}

// Получаем пары для сканирования (с сильными движениями)
async function getPairsForScanning() {
  try {
    const allPairs = await getMexcTickers();
    if (allPairs.length === 0) return [];
    
    // Фильтруем пары с сильными движениями
    const strongMovements = allPairs.filter(pair => 
      Math.abs(pair.change) >= CONFIG.minChangeForSignal
    );
    
    console.log(`🔍 Для сканирования: ${strongMovements.length} пар с изменением > ${CONFIG.minChangeForSignal}%`);
    
    if (strongMovements.length < 10) {
      // Если мало сильных движений, берем топ по абсолютному изменению
      const sortedByAbsChange = [...allPairs]
        .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
        .slice(0, 30);
      
      console.log(`📊 Будем сканировать топ-30 по изменению`);
      return sortedByAbsChange;
    }
    
    return strongMovements;
  } catch (error) {
    console.error('❌ Ошибка получения пар для сканирования:', error.message);
    return [];
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
  
  // Упрощенный расчет MACD
  const emaFast = calculateEMA(closes, fast);
  const emaSlow = calculateEMA(closes, slow);
  const macdLine = emaFast - emaSlow;
  
  // Простой сигнал
  const signalLine = calculateEMA(closes.slice(-signal), 9);
  const histogram = macdLine - signalLine;
  
  return { macd: macdLine, signal: signalLine, histogram };
}

function calculateEMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  
  const multiplier = 2 / (period + 1);
  let ema = values[0];
  
  for (let i = 1; i < values.length; i++) {
    ema = (values[i] * multiplier) + (ema * (1 - multiplier));
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

function calculateStochastic(closes, highs, lows, period = 14) {
  if (closes.length < period) return { k: 50, d: 50 };
  
  const currentClose = closes[closes.length - 1];
  const lowestLow = Math.min(...lows.slice(-period));
  const highestHigh = Math.max(...highs.slice(-period));
  
  if (highestHigh === lowestLow) return { k: 50, d: 50 };
  
  const k = ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;
  
  // Упрощенный расчет D как SMA от K
  const kValues = [];
  for (let i = 0; i < 3; i++) {
    if (closes.length - i - period < 0) break;
    const close = closes[closes.length - i - 1];
    const low = Math.min(...lows.slice(closes.length - i - period, closes.length - i));
    const high = Math.max(...highs.slice(closes.length - i - period, closes.length - i));
    kValues.push(((close - low) / (high - low)) * 100);
  }
  
  const d = kValues.length > 0 ? kValues.reduce((a, b) => a + b, 0) / kValues.length : k;
  
  return { k, d };
}

function calculateAverageVolume(volumes, period = 20) {
  if (!volumes || volumes.length < period) return volumes[volumes.length - 1] || 0;
  const recent = volumes.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

// ==================== АНАЛИЗ СИГНАЛА ====================
async function analyzePair(pair) {
  try {
    console.log(`🔍 Анализ ${pair.symbol} (${pair.change > 0 ? '+' : ''}${pair.change.toFixed(2)}%)...`);
    
    // Получаем свечи
    const klines = await getMexcKlines(pair.symbol, '15m', 50);
    if (klines.length < 20) {
      console.log(`⚠️ Недостаточно данных для ${pair.symbol}`);
      return null;
    }
    
    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const volumes = klines.map(k => k.volume);
    
    const currentPrice = closes[closes.length - 1];
    const currentVolume = volumes[volumes.length - 1];
    
    // Рассчитываем индикаторы
    const rsi = calculateRSI(closes);
    const macd = calculateMACD(closes);
    const bb = calculateBollingerBands(closes);
    const stoch = calculateStochastic(closes, highs, lows);
    const avgVolume = calculateAverageVolume(volumes);
    const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;
    
    // Анализ положения цены относительно BB
    const bbPosition = bb.upper !== bb.lower ? 
      ((currentPrice - bb.lower) / (bb.upper - bb.lower)) * 100 : 50;
    
    // Определяем сигнал
    let signal = null;
    let confidence = 0;
    let reasons = [];
    
    // Условия для LONG
    const longConditions = [];
    if (rsi < 35) longConditions.push(`RSI=${Math.round(rsi)} (перепродан)`);
    if (macd.histogram > 0) longConditions.push(`MACD бычий`);
    if (stoch.k < 30) longConditions.push(`Stochastic=${stoch.k.toFixed(1)} (низкий)`);
    if (bbPosition < 30) longConditions.push(`Цена в нижней части BB`);
    if (volumeRatio > 1.5) longConditions.push(`Объем x${volumeRatio.toFixed(1)}`);
    if (pair.change > 0 && Math.abs(pair.change) >= 5) longConditions.push(`Рост ${pair.change.toFixed(1)}%`);
    
    // Условия для SHORT
    const shortConditions = [];
    if (rsi > 65) shortConditions.push(`RSI=${Math.round(rsi)} (перекуплен)`);
    if (macd.histogram < 0) shortConditions.push(`MACD медвежий`);
    if (stoch.k > 70) shortConditions.push(`Stochastic=${stoch.k.toFixed(1)} (высокий)`);
    if (bbPosition > 70) shortConditions.push(`Цена в верхней части BB`);
    if (volumeRatio > 1.5) shortConditions.push(`Объем x${volumeRatio.toFixed(1)}`);
    if (pair.change < 0 && Math.abs(pair.change) >= 5) shortConditions.push(`Падение ${Math.abs(pair.change).toFixed(1)}%`);
    
    // Определяем сигнал на основе условий
    if (longConditions.length >= 2) {
      signal = 'LONG';
      confidence = 50 + (longConditions.length * 5);
      reasons = longConditions;
    }
    
    if (shortConditions.length >= 2) {
      // Если уже есть LONG, сравниваем уверенность
      if (!signal || shortConditions.length > longConditions.length) {
        signal = 'SHORT';
        confidence = 50 + (shortConditions.length * 5);
        reasons = shortConditions;
      }
    }
    
    // Если сильное движение, увеличиваем уверенность
    if (Math.abs(pair.change) >= 8) {
      confidence += 15;
    }
    
    // Проверяем минимальную уверенность
    if (!signal || confidence < CONFIG.minConfidence) {
      console.log(`❌ Нет сигнала для ${pair.symbol} (уверенность: ${confidence}%)`);
      return null;
    }
    
    console.log(`✅ Найден сигнал ${signal} для ${pair.symbol} (${confidence}%)`);
    
    // Рассчитываем уровни
    const entry = currentPrice;
    let tp, sl;
    
    if (signal === 'LONG') {
      // Для LONG стоп на 3% ниже или на минимуме последних свечей
      const recentLow = Math.min(...lows.slice(-10));
      sl = Math.min(recentLow, entry * 0.97);
      tp = entry + (entry - sl) * 2; // R:R 1:2
    } else {
      // Для SHORT стоп на 3% выше или на максимуме последних свечей
      const recentHigh = Math.max(...highs.slice(-10));
      sl = Math.max(recentHigh, entry * 1.03);
      tp = entry - (sl - entry) * 2; // R:R 1:2
    }
    
    const rrRatio = signal === 'LONG' ? 
      ((tp - entry) / (entry - sl)).toFixed(1) : 
      ((entry - tp) / (sl - entry)).toFixed(1);
    
    // Определяем тир сигнала
    let tier = 'STANDARD';
    if (confidence >= 80) tier = 'GOD TIER';
    else if (confidence >= 70) tier = 'PREMIUM';
    
    // Для автосканирования берем только PREMIUM и GOD TIER
    if (tier === 'STANDARD') {
      console.log(`⚠️ Слабый сигнал для ${pair.symbol} (${confidence}%)`);
      return null;
    }
    
    return {
      pair: pair.symbol.replace('USDT', '/USDT'),
      symbol: pair.symbol,
      signal: signal,
      entry: entry.toFixed(8),
      tp: tp.toFixed(8),
      sl: sl.toFixed(8),
      confidence: Math.round(confidence),
      rrRatio: rrRatio,
      tier: tier,
      change24h: pair.change.toFixed(2),
      volume24h: pair.volume,
      rsi: Math.round(rsi),
      macdHistogram: macd.histogram.toFixed(4),
      volumeRatio: volumeRatio.toFixed(1),
      reasons: reasons,
      timestamp: new Date()
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
📊 <b>Сканирование:</b> Пары с движением > ${CONFIG.minChangeForSignal}%
💰 <b>Мин. объем:</b> ${(CONFIG.minVolume/1000).toFixed(0)}K USDT
⏰ <b>Интервал:</b> каждые 10 минут

<b>📈 Индикаторы:</b>
• RSI (14) - перекупленность/перепроданность
• MACD - тренд
• Bollinger Bands - волатильность
• Stochastic - моментум
• Объем торгов

<b>📱 Команды:</b>
/start - информация
/test - проверить API
/scan - сканирование сигналов
/top - топ движений (фильтр по объему)
/status - статус бота
/analyze [пара] - анализ пары

✅ <b>Бот ищет сильные движения!</b>
  `.trim();
  
  ctx.reply(welcome, { parse_mode: 'HTML' });
});

bot.command('top', async (ctx) => {
  console.log('📈 Топ движений...');
  
  try {
    await ctx.reply('📊 Ищу топ движений с объемом > 500K USDT...');
    
    const { gainers, losers } = await getTopMovements();
    
    if (gainers.length === 0 && losers.length === 0) {
      await ctx.reply('❌ Нет данных от MEXC');
      return;
    }
    
    let message = `📈 <b>ТОП РОСТА (24h, объем > 500K)</b>\n\n`;
    
    gainers.slice(0, 8).forEach((t, i) => {
      const change = t.change.toFixed(2);
      const changeText = change >= 0 ? `📈 +${change}%` : `📉 ${change}%`;
      message += `${i+1}. <b>${t.symbol}</b>\n`;
      message += `   💰 $${t.price.toFixed(4)}\n`;
      message += `   ${changeText}\n`;
      message += `   🔄 $${(t.volume/1000000).toFixed(2)}M\n\n`;
    });
    
    message += `📉 <b>ТОП ПАДЕНИЯ (24h, объем > 500K)</b>\n\n`;
    
    losers.slice(0, 8).forEach((t, i) => {
      const change = t.change.toFixed(2);
      const changeText = change >= 0 ? `📈 +${change}%` : `📉 ${change}%`;
      message += `${i+1}. <b>${t.symbol}</b>\n`;
      message += `   💰 $${t.price.toFixed(4)}\n`;
      message += `   ${changeText}\n`;
      message += `   🔄 $${(t.volume/1000000).toFixed(2)}M\n\n`;
    });
    
    message += `\n📊 Всего пар с объемом > 500K: ${gainers.length + losers.length}`;
    message += `\n🎯 Минимальное изменение для сигналов: ${CONFIG.minChangeForSignal}%`;
    
    await ctx.reply(message, { parse_mode: 'HTML' });
    
  } catch (error) {
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('scan', async (ctx) => {
  console.log('🔍 Ручное сканирование...');
  
  try {
    await ctx.reply('🔍 Запускаю сканирование сильных движений...');
    
    const pairsToScan = await getPairsForScanning();
    
    if (pairsToScan.length === 0) {
      await ctx.reply('❌ Нет пар с сильными движениями для анализа');
      return;
    }
    
    await ctx.reply(`📊 Анализирую ${Math.min(pairsToScan.length, 20)} пар...`);
    
    const signals = [];
    let scanned = 0;
    
    // Анализируем пары
    for (const pair of pairsToScan.slice(0, 20)) {
      scanned++;
      const signal = await analyzePair(pair);
      
      if (signal) {
        signals.push(signal);
        console.log(`✅ Найден сигнал ${scanned}/${pairsToScan.length}: ${pair.symbol}`);
      }
      
      // Задержка между запросами
      if (scanned < pairsToScan.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    if (signals.length > 0) {
      // Сортируем по уверенности
      signals.sort((a, b) => b.confidence - a.confidence);
      
      let message = `🎯 <b>НАЙДЕНО СИГНАЛОВ: ${signals.length}</b>\n\n`;
      message += `📊 Просканировано пар: ${scanned}\n\n`;
      
      signals.slice(0, 5).forEach((sig, i) => {
        const emoji = sig.signal === 'LONG' ? '🟢' : '🔴';
        const tierEmoji = sig.tier === 'GOD TIER' ? '👑' : '💎';
        
        message += `${tierEmoji} <b>${sig.tier}</b>\n`;
        message += `${emoji} <b>${sig.signal} ${sig.pair}</b>\n`;
        message += `📈 Изменение: ${sig.change24h > 0 ? '+' : ''}${sig.change24h}%\n`;
        message += `🎯 Вход: $${sig.entry}\n`;
        message += `✅ Тейк: $${sig.tp}\n`;
        message += `🛑 Стоп: $${sig.sl}\n`;
        message += `📊 R:R: 1:${sig.rrRatio}\n`;
        message += `🔮 Уверенность: ${sig.confidence}%\n`;
        message += `📊 RSI: ${sig.rsi}\n`;
        message += `📈 Объем: x${sig.volumeRatio}\n`;
        message += `💎 Причины:\n`;
        sig.reasons.slice(0, 3).forEach(r => message += `• ${r}\n`);
        message += `\n`;
      });
      
      await ctx.reply(message, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(`ℹ️ Сигналов не найдено. Просканировано ${scanned} пар.\nПопробуйте позже или проверьте /top`);
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
      message += `💰 <b>Объем 24h:</b> $${(signal.volume24h / 1000000).toFixed(2)}M\n`;
      message += `📊 <b>RSI:</b> ${signal.rsi}\n`;
      message += `📈 <b>Объем:</b> x${signal.volumeRatio}\n\n`;
      message += `🎯 <b>Вход:</b> $${signal.entry}\n`;
      message += `✅ <b>Тейк-профит:</b> $${signal.tp}\n`;
      message += `🛑 <b>Стоп-лосс:</b> $${signal.sl}\n`;
      message += `📊 <b>R:R:</b> 1:${signal.rrRatio}\n\n`;
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

// Автоматическое сканирование
async function autoScan() {
  console.log('\n🎯 АВТОМАТИЧЕСКОЕ СКАНИРОВАНИЕ');
  console.log('='.repeat(50));
  
  if (!CHAT_ID) {
    console.log('⚠️  CHAT_ID не установлен, пропускаю отправку');
    return;
  }
  
  try {
    // Получаем пары с сильными движениями
    const pairsToScan = await getPairsForScanning();
    
    if (pairsToScan.length === 0) {
      console.log('❌ Нет пар с сильными движениями для анализа');
      return;
    }
    
    console.log(`📊 Найдено ${pairsToScan.length} пар для сканирования`);
    
    const signals = [];
    let scanned = 0;
    
    // Быстрый анализ для автосканирования
    for (const pair of pairsToScan.slice(0, 15)) {
      scanned++;
      
      try {
        // Быстрая проверка - только RSI и объем
        const klines = await getMexcKlines(pair.symbol, '15m', 20);
        if (klines.length < 15) continue;
        
        const closes = klines.map(k => k.close);
        const volumes = klines.map(k => k.volume);
        
        const rsi = calculateRSI(closes);
        const avgVolume = calculateAverageVolume(volumes);
        const volumeRatio = volumes[volumes.length - 1] / avgVolume;
        
        let signal = null;
        let confidence = 0;
        let reasons = [];
        
        // Быстрые условия
        if (rsi < 30 && pair.change > -10) {
          signal = 'LONG';
          confidence = 65;
          reasons.push(`RSI=${Math.round(rsi)} (сильно перепродан)`);
        } else if (rsi > 70 && pair.change < 10) {
          signal = 'SHORT';
          confidence = 65;
          reasons.push(`RSI=${Math.round(rsi)} (сильно перекуплен)`);
        }
        
        // Проверяем объем
        if (volumeRatio > 2) {
          confidence += 15;
          reasons.push(`Объем x${volumeRatio.toFixed(1)}`);
        }
        
        // Проверяем сильное движение
        if (Math.abs(pair.change) >= 8) {
          confidence += 10;
          reasons.push(`${pair.change > 0 ? 'Рост' : 'Падение'} ${Math.abs(pair.change).toFixed(1)}%`);
        }
        
        if (signal && confidence >= 75) {
          const currentPrice = closes[closes.length - 1];
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
          
          console.log(`✅ Найден сигнал для автоотправки: ${pair.symbol} (${confidence}%)`);
        }
        
        // Задержка
        await new Promise(resolve => setTimeout(resolve, 300));
        
      } catch (error) {
        console.error(`❌ Ошибка быстрого анализа ${pair.symbol}:`, error.message);
      }
    }
    
    if (signals.length > 0) {
      console.log(`📊 Найдено ${signals.length} сигналов для автоотправки`);
      
      // Сортируем по уверенности и берем топ-2
      const bestSignals = signals
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 2);
      
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
          await new Promise(resolve => setTimeout(resolve, 2000));
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
    console.log('🚀 Инициализация MEXC Signals Bot...');
    
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
    
    // Настройка планировщика - каждые 10 минут
    cron.schedule(CONFIG.scanInterval, () => {
      const now = new Date();
      console.log(`\n⏰ АВТОСКАНИРОВАНИЕ: ${now.toLocaleTimeString('ru-RU')}`);
      autoScan();
    });
    
    console.log(`⏰ Автосканирование настроено: ${CONFIG.scanInterval}`);
    
    // Первое сканирование через 1 минуту
    setTimeout(() => {
      console.log('\n🎯 ПЕРВОЕ АВТОСКАНИРОВАНИЕ');
      autoScan();
    }, 60000);
    
    // Приветственное сообщение
    if (CHAT_ID) {
      try {
        await bot.telegram.sendMessage(
          CHAT_ID,
          `🤖 <b>MEXC Signals Bot запущен!</b>\n\n` +
          `✅ Telegram: подключено\n` +
          `✅ MEXC API: ${testTickers.length > 0 ? 'работает' : 'проверяется'}\n` +
          `⏰ Автосканирование: каждые 10 минут\n\n` +
          `🏦 Биржа: MEXC Spot\n` +
          `🎯 Цель: Пары с движением > ${CONFIG.minChangeForSignal}%\n` +
          `💰 Мин. объем: ${(CONFIG.minVolume/1000).toFixed(0)}K USDT\n\n` +
          `📱 <b>Команды:</b>\n` +
          `/start - информация\n` +
          `/test - проверить API\n` +
          `/scan - сканирование сигналов\n` +
          `/top - топ движений\n` +
          `/analyze [пара] - анализ пары\n` +
          `/status - статус бота\n\n` +
          `🔄 Первое сканирование через 1 минуту`,
          { parse_mode: 'HTML' }
        );
        console.log('✅ Стартовое сообщение отправлено');
      } catch (error) {
        console.log('⚠️ Не удалось отправить стартовое сообщение');
      }
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('🤖 MEXC SIGNALS BOT ЗАПУЩЕН');
    console.log('='.repeat(50));
    console.log('📱 Команды в Telegram:');
    console.log('   /start    - информация о боте');
    console.log('   /test     - проверка MEXC API');
    console.log('   /scan     - сканирование сигналов');
    console.log('   /top      - топ движений');
    console.log('   /analyze  - анализ конкретной пары');
    console.log('   /status   - статус бота');
    console.log('='.repeat(50));
    console.log(`⏰ Автосканирование: каждые 10 минут`);
    console.log(`🎯 Минимальное изменение: ${CONFIG.minChangeForSignal}%`);
    console.log(`💰 Мин. объем: ${(CONFIG.minVolume/1000).toFixed(0)}K USDT`);
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
