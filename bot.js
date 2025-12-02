import { Telegraf } from 'telegraf';
import axios from 'axios';
import cron from 'node-cron';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

console.log('🔍 Проверка переменных окружения:');
console.log('TELEGRAM_BOT_TOKEN:', BOT_TOKEN ? '✅ Установлен' : '❌ НЕ установлен');
console.log('TELEGRAM_CHAT_ID:', CHAT_ID ? `✅ Установлен (${CHAT_ID})` : '❌ НЕ установлен');

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не установлен!');
  process.exit(1);
}

// ==================== КОНФИГУРАЦИЯ ====================
const CONFIG = {
  baseUrl: 'https://api.bybit.com',
  category: 'spot',
  timeframe: '15',  // 15 минут
  topGainers: 30,
  topLosers: 30,
  min24hVolume: 500000,  // 500K USDT (уменьшено для большего количества пар)
  stopLossPercent: 1.0,   // 1% стоп-лосс
  takeProfitPercent: 3.0, // 3% тейк-профит
  minRRRatio: 3.0,        // 1:3 (уменьшено)
  minConfidence: 60,      // 60% уверенности (уменьшено)
  minConfirmations: 2     // 2 подтверждения (уменьшено)
};

// ==================== ТЕХНИЧЕСКИЕ ИНДИКАТОРЫ ====================

function calculateEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }
  return ema;
}

function calculateRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateMACD(prices) {
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  if (!ema12 || !ema26) return { macd: 0, signal: 0, histogram: 0 };
  const macd = ema12 - ema26;
  
  // Рассчитываем значения MACD за последние периоды
  const macdValues = [];
  for (let i = 26; i < prices.length; i++) {
    const slice = prices.slice(0, i + 1);
    const e12 = calculateEMA(slice, 12);
    const e26 = calculateEMA(slice, 26);
    if (e12 && e26) {
      macdValues.push(e12 - e26);
    }
  }
  
  const signal = macdValues.length >= 9 ? calculateEMA(macdValues, 9) : macd;
  const histogram = macd - signal;
  
  return { 
    macd: parseFloat(macd.toFixed(6)), 
    signal: parseFloat(signal.toFixed(6)), 
    histogram: parseFloat(histogram.toFixed(6)) 
  };
}

function calculateBollingerBands(prices, period = 20, stdDev = 2) {
  if (!prices || prices.length < period) return null;
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: mean + (std * stdDev),
    middle: mean,
    lower: mean - (std * stdDev),
    bandwidth: (std * stdDev * 2) / mean * 100
  };
}

function calculateStochastic(highs, lows, closes, period = 14, kSmooth = 3) {
  if (!highs || highs.length < period) return { k: 50, d: 50 };
  const kValues = [];
  for (let i = period - 1; i < closes.length; i++) {
    const highSlice = highs.slice(i - period + 1, i + 1);
    const lowSlice = lows.slice(i - period + 1, i + 1);
    const currentClose = closes[i];
    const highest = Math.max(...highSlice);
    const lowest = Math.min(...lowSlice);
    if (highest === lowest) {
      kValues.push(50);
    } else {
      kValues.push(((currentClose - lowest) / (highest - lowest)) * 100);
    }
  }
  const k = kValues.length >= kSmooth 
    ? kValues.slice(-kSmooth).reduce((a, b) => a + b, 0) / kSmooth 
    : kValues[kValues.length - 1] || 50;
  const dPeriod = 3;
  const d = kValues.length >= dPeriod
    ? kValues.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod
    : k;
  return { 
    k: parseFloat(k.toFixed(2)), 
    d: parseFloat(d.toFixed(2)) 
  };
}

function calculateATR(highs, lows, closes, period = 14) {
  if (!highs || highs.length < period + 1) return 0;
  const trValues = [];
  for (let i = 1; i < closes.length; i++) {
    const high = highs[i];
    const low = lows[i];
    const prevClose = closes[i - 1];
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trValues.push(tr);
  }
  const recentTR = trValues.slice(-period);
  return recentTR.reduce((a, b) => a + b, 0) / period;
}

function calculateVolumeStrength(volumes, period = 20) {
  if (!volumes || volumes.length < period) return 1;
  const recentVolumes = volumes.slice(-period);
  const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / period;
  const currentVolume = volumes[volumes.length - 1];
  return currentVolume / avgVolume;
}

function calculateADX(highs, lows, closes, period = 14) {
  if (!highs || highs.length < period + 1) return 0;
  const dmPlus = [];
  const dmMinus = [];
  const tr = [];
  for (let i = 1; i < closes.length; i++) {
    const highDiff = highs[i] - highs[i - 1];
    const lowDiff = lows[i - 1] - lows[i];
    dmPlus.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
    dmMinus.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);
    const trueRange = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    tr.push(trueRange);
  }
  const avgDmPlus = dmPlus.slice(-period).reduce((a, b) => a + b, 0) / period;
  const avgDmMinus = dmMinus.slice(-period).reduce((a, b) => a + b, 0) / period;
  const avgTR = tr.slice(-period).reduce((a, b) => a + b, 0) / period;
  if (avgTR === 0) return 0;
  const diPlus = (avgDmPlus / avgTR) * 100;
  const diMinus = (avgDmMinus / avgTR) * 100;
  const dx = Math.abs(diPlus - diMinus) / (diPlus + diMinus) * 100;
  return parseFloat(dx.toFixed(2));
}

const bot = new Telegraf(BOT_TOKEN);

// ==================== КОМАНДЫ БОТА ====================
bot.start((ctx) => {
  console.log('📱 Получена команда /start от:', ctx.from.id);
  const welcomeMessage = `🤖 <b>Bybit Scalper Bot v3.0</b>

🎯 <b>Активные индикаторы:</b>
• EMA (9, 21, 50) - Тренд
• RSI (14) - Перекупленность/перепроданность
• MACD (12, 26, 9) - Импульс
• Bollinger Bands (20, 2) - Волатильность
• Stochastic (14, 3, 3) - Моментум
• ATR (14) - Динамические стопы
• ADX (14) - Сила тренда
• Volume Analysis - Объемы

📊 <b>Параметры сканирования:</b>
• Топ 30 растущих монет
• Топ 30 падающих монет
• Минимальный объем: ${(CONFIG.min24hVolume / 1000000).toFixed(1)}M USDT
• Минимум подтверждений: ${CONFIG.minConfirmations}
• R:R соотношение: 1:${CONFIG.minRRRatio}

⏰ <b>Расписание:</b>
Автоматическое сканирование каждые 15 минут

🎖️ <b>Уровни сигналов:</b>
👑 GOD TIER - Уверенность ≥80%
💎 PREMIUM - Уверенность ≥60%

✅ Бот работает на Bybit Spot!`;

  ctx.reply(welcomeMessage, { parse_mode: 'HTML' });
});

bot.command('status', (ctx) => {
  console.log('📱 Получена команда /status от:', ctx.from.id);
  ctx.reply(
    `✅ <b>Бот активен</b>\n\n` +
    `📡 API: Bybit Public\n` +
    `⏰ Сканирование: каждые 15 минут\n` +
    `🎯 Следующий запуск через: ${getNextScanTime()}`,
    { parse_mode: 'HTML' }
  );
});

bot.command('test', async (ctx) => {
  console.log('📱 Получена команда /test от:', ctx.from.id);
  try {
    await ctx.reply('🧪 Тестирую подключение к Bybit API...');
    
    const response = await axios.get(`${CONFIG.baseUrl}/v5/market/tickers`, {
      params: { 
        category: 'spot',
        limit: 5 
      },
      timeout: 10000,
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    console.log('Bybit API Response:', response.data);
    
    if (response.data && response.data.retCode === 0) {
      await ctx.reply(`✅ Bybit API доступен! Статус: ${response.data.retMsg}`);
      await ctx.reply(`📊 Получено данных: ${response.data.result.list?.length || 0} пар`);
      if (response.data.result.list && response.data.result.list.length > 0) {
        const firstPair = response.data.result.list[0];
        await ctx.reply(
          `Пример пары:\n` +
          `Символ: ${firstPair.symbol}\n` +
          `Цена: ${firstPair.lastPrice}\n` +
          `Изменение 24h: ${(firstPair.price24hPcnt * 100).toFixed(2)}%`
        );
      }
    } else {
      await ctx.reply(`⚠️ Bybit API вернул: ${JSON.stringify(response.data)}`);
    }
    
    await ctx.reply('✅ Тест подключения завершен!');
  } catch (error) {
    console.error('❌ Ошибка теста:', error.message);
    console.error('❌ Полный error:', error);
    
    let errorMessage = `❌ Ошибка подключения: ${error.message}`;
    if (error.response) {
      errorMessage += `\nСтатус: ${error.response.status}`;
      errorMessage += `\nДанные: ${JSON.stringify(error.response.data)}`;
    }
    
    await ctx.reply(errorMessage);
  }
});

bot.command('scan', async (ctx) => {
  console.log('📱 Получена команда /scan от:', ctx.from.id);
  try {
    await ctx.reply('🔍 Запускаю ручное сканирование...');
    await runSignalsTask(true);
    await ctx.reply('✅ Ручное сканирование завершено!');
  } catch (error) {
    console.error('❌ Ошибка ручного сканирования:', error);
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

function getNextScanTime() {
  const now = new Date();
  const minutes = now.getMinutes();
  const nextScan = 15 - (minutes % 15);
  return `${nextScan} мин`;
}

// ==================== ПОЛУЧЕНИЕ ДАННЫХ ====================
async function getTopMovers() {
  try {
    console.log('📡 Запрос данных с Bybit...');
    const response = await axios.get(`${CONFIG.baseUrl}/v5/market/tickers`, {
      params: { 
        category: CONFIG.category 
      },
      timeout: 20000,
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    console.log('🔍 Ответ от Bybit:', {
      retCode: response.data.retCode,
      retMsg: response.data.retMsg,
      listLength: response.data.result?.list?.length || 0
    });
    
    if (response.data.retCode !== 0) {
      console.error('❌ Bybit API ошибка:', response.data.retMsg);
      return [];
    }
    
    if (!response.data.result || !response.data.result.list) {
      console.error('❌ Нет данных в ответе');
      return [];
    }
    
    console.log(`✅ Получено ${response.data.result.list.length} пар с Bybit`);
    
    // Фильтруем пары
    const usdtPairs = response.data.result.list.filter(pair => {
      if (!pair.symbol.endsWith('USDT')) return false;
      if (pair.symbol.includes('UP') || pair.symbol.includes('DOWN')) return false;
      if (pair.symbol.includes('BEAR') || pair.symbol.includes('BULL')) return false;
      
      const volume = parseFloat(pair.turnover24h) || 0;
      const price = parseFloat(pair.lastPrice) || 0;
      const change = parseFloat(pair.price24hPcnt) || 0;
      
      return volume >= CONFIG.min24hVolume && 
             price > 0.000001 && 
             Math.abs(change) > 0.001; // > 0.1% изменение
    });
    
    console.log(`✅ Отфильтровано ${usdtPairs.length} USDT пар с объемом >${(CONFIG.min24hVolume/1000000).toFixed(2)}M`);
    
    const pairsWithChange = usdtPairs.map(pair => ({
      symbol: pair.symbol,
      change: (parseFloat(pair.price24hPcnt) || 0) * 100,
      volume: parseFloat(pair.turnover24h) || 0,
      price: parseFloat(pair.lastPrice) || 0,
      high24h: parseFloat(pair.highPrice24h) || 0,
      low24h: parseFloat(pair.lowPrice24h) || 0
    }));
    
    const sorted = pairsWithChange.sort((a, b) => b.change - a.change);
    const topGainers = sorted.slice(0, CONFIG.topGainers);
    const topLosers = sorted.slice(-CONFIG.topLosers).reverse();
    
    console.log(`✅ Топ роста: ${topGainers.length} пар ${topGainers.length > 0 ? `(${topGainers[0]?.symbol}: +${topGainers[0]?.change?.toFixed(2)}%)` : ''}`);
    console.log(`✅ Топ падения: ${topLosers.length} пар ${topLosers.length > 0 ? `(${topLosers[0]?.symbol}: ${topLosers[0]?.change?.toFixed(2)}%)` : ''}`);
    
    return [...topGainers, ...topLosers];
  } catch (error) {
    console.error('❌ Ошибка получения данных:', error.message);
    if (error.response) {
      console.error('❌ Статус:', error.response.status);
      console.error('❌ Данные:', error.response.data);
    } else if (error.request) {
      console.error('❌ Нет ответа от сервера');
    }
    return [];
  }
}

// ==================== АНАЛИЗ СИГНАЛА ====================
async function analyzeSignal(pair) {
  try {
    console.log(`🔍 Анализ пары: ${pair.symbol} (${pair.change > 0 ? '+' : ''}${pair.change.toFixed(2)}%)`);
    
    // Добавляем небольшую задержку между запросами
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const candleResponse = await axios.get(
      `${CONFIG.baseUrl}/v5/market/kline`,
      { 
        params: {
          category: CONFIG.category,
          symbol: pair.symbol,
          interval: CONFIG.timeframe,
          limit: 100
        },
        timeout: 15000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0'
        }
      }
    );
    
    if (candleResponse.data.retCode !== 0 || !candleResponse.data.result?.list) {
      console.log(`⚠️ Нет данных для ${pair.symbol}: ${candleResponse.data.retMsg}`);
      return null;
    }
    
    const candles = candleResponse.data.result.list;
    if (candles.length < 50) {
      console.log(`⚠️ Недостаточно данных для ${pair.symbol}: ${candles.length} свечей`);
      return null;
    }
    
    // Переворачиваем массив (Bybit возвращает новые данные первыми)
    const reversedCandles = [...candles].reverse();
    
    // Извлекаем данные: [время, открытие, высшая, низшая, закрытие, объем, оборот]
    const closes = reversedCandles.map(c => parseFloat(c[4]));
    const highs = reversedCandles.map(c => parseFloat(c[2]));
    const lows = reversedCandles.map(c => parseFloat(c[3]));
    const volumes = reversedCandles.map(c => parseFloat(c[5]));
    
    if (closes.length < 50) {
      return null;
    }
    
    const currentPrice = closes[closes.length - 1];
    
    // Рассчитываем индикаторы
    const rsi = calculateRSI(closes);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const ema50 = calculateEMA(closes, 50);
    const macd = calculateMACD(closes);
    const bb = calculateBollingerBands(closes);
    const stoch = calculateStochastic(highs, lows, closes);
    const atr = calculateATR(highs, lows, closes);
    const volumeStrength = calculateVolumeStrength(volumes);
    const adx = calculateADX(highs, lows, closes);
    
    // Собираем подтверждения
    const confirmations = [];
    let qualityScore = 0;
    
    // RSI анализ
    if (rsi < 35) {
      confirmations.push('RSI_OVERSOLD');
      qualityScore += 2;
    } else if (rsi > 65) {
      confirmations.push('RSI_OVERBOUGHT');
      qualityScore += 2;
    }
    
    // MACD анализ
    if (macd.histogram > 0) {
      confirmations.push('MACD_POSITIVE');
      qualityScore += 1;
    } else if (macd.histogram < 0) {
      confirmations.push('MACD_NEGATIVE');
      qualityScore += 1;
    }
    
    if (macd.macd > macd.signal) {
      confirmations.push('MACD_CROSS_BULLISH');
      qualityScore += 1;
    } else if (macd.macd < macd.signal) {
      confirmations.push('MACD_CROSS_BEARISH');
      qualityScore += 1;
    }
    
    // Bollinger Bands
    if (bb) {
      const bbPosition = (currentPrice - bb.lower) / (bb.upper - bb.lower) * 100;
      if (bbPosition < 25) {
        confirmations.push('BB_NEAR_LOWER');
        qualityScore += 2;
      } else if (bbPosition > 75) {
        confirmations.push('BB_NEAR_UPPER');
        qualityScore += 2;
      }
    }
    
    // Stochastic
    if (stoch.k < 25) {
      confirmations.push('STOCH_OVERSOLD');
      qualityScore += 2;
    } else if (stoch.k > 75) {
      confirmations.push('STOCH_OVERBOUGHT');
      qualityScore += 2;
    }
    
    // EMA тренд
    if (ema9 && ema21 && ema50) {
      if (currentPrice > ema9 && ema9 > ema21 && ema21 > ema50) {
        confirmations.push('STRONG_UPTREND');
        qualityScore += 3;
      } else if (currentPrice < ema9 && ema9 < ema21 && ema21 < ema50) {
        confirmations.push('STRONG_DOWNTREND');
        qualityScore += 3;
      } else if (ema9 > ema21 && ema21 > ema50) {
        confirmations.push('EMA_BULLISH');
        qualityScore += 2;
      } else if (ema9 < ema21 && ema21 < ema50) {
        confirmations.push('EMA_BEARISH');
        qualityScore += 2;
      }
    }
    
    // Объем
    if (volumeStrength > 1.3) {
      confirmations.push('HIGH_VOLUME');
      qualityScore += 2;
    } else if (volumeStrength < 0.7) {
      confirmations.push('LOW_VOLUME');
      qualityScore -= 1;
    }
    
    // Сила тренда
    if (adx > 25) {
      confirmations.push('STRONG_TREND');
      qualityScore += 2;
    }
    
    // Проверяем минимальное количество подтверждений
    if (confirmations.length < CONFIG.minConfirmations) {
      console.log(`⚠️ ${pair.symbol}: мало подтверждений (${confirmations.length} < ${CONFIG.minConfirmations})`);
      return null;
    }
    
    // Определяем направление сигнала
    let signal = null;
    let confidence = 0;
    
    // Более гибкая логика определения сигнала
    const bullishScore = 
      (pair.change > 0 ? 2 : 0) +
      (rsi < 50 ? 1 : 0) +
      (macd.histogram > 0 ? 2 : 0) +
      (stoch.k < 50 ? 1 : 0) +
      (ema9 && ema21 && currentPrice > ema9 && ema9 > ema21 ? 3 : 0) +
      (volumeStrength > 1.2 ? 2 : 0);
    
    const bearishScore = 
      (pair.change < 0 ? 2 : 0) +
      (rsi > 50 ? 1 : 0) +
      (macd.histogram < 0 ? 2 : 0) +
      (stoch.k > 50 ? 1 : 0) +
      (ema9 && ema21 && currentPrice < ema9 && ema9 < ema21 ? 3 : 0) +
      (volumeStrength > 1.2 ? 2 : 0);
    
    if (bullishScore >= 6) {
      signal = 'LONG';
      confidence = Math.min(
        50 + 
        (40 - Math.min(rsi, 40)) * 0.5 +
        (macd.histogram > 0 ? 15 : 0) +
        (stoch.k < 30 ? 10 : 0) +
        (adx > 20 ? 5 : 0) +
        confirmations.length * 3,
        90
      );
    } else if (bearishScore >= 6) {
      signal = 'SHORT';
      confidence = Math.min(
        50 +
        (Math.max(rsi, 60) - 60) * 0.5 +
        (macd.histogram < 0 ? 15 : 0) +
        (stoch.k > 70 ? 10 : 0) +
        (adx > 20 ? 5 : 0) +
        confirmations.length * 3,
        90
      );
    }
    
    if (!signal || confidence < CONFIG.minConfidence) {
      console.log(`⚠️ ${pair.symbol}: сигнал не определен (доверие: ${confidence.toFixed(0)}%)`);
      return null;
    }
    
    // Рассчитываем уровни входа, стоп-лосса и тейк-профита
    const entry = currentPrice;
    let sl, tp, rrRatio;
    
    if (signal === 'LONG') {
      // Для лонга: стоп-лосс ниже, тейк-профит выше
      const atrBasedSL = entry - (atr * 1.5);
      const fixedSL = entry * (1 - CONFIG.stopLossPercent / 100);
      sl = Math.max(atrBasedSL, fixedSL);
      const risk = entry - sl;
      tp = entry + (risk * CONFIG.minRRRatio);
      rrRatio = (tp - entry) / (entry - sl);
    } else {
      // Для шорта: стоп-лосс выше, тейк-профит ниже
      const atrBasedSL = entry + (atr * 1.5);
      const fixedSL = entry * (1 + CONFIG.stopLossPercent / 100);
      sl = Math.min(atrBasedSL, fixedSL);
      const risk = sl - entry;
      tp = entry - (risk * CONFIG.minRRRatio);
      rrRatio = (entry - tp) / (sl - entry);
    }
    
    // Проверяем соотношение риск/прибыль
    if (rrRatio < CONFIG.minRRRatio) {
      console.log(`⚠️ ${pair.symbol}: плохое R:R (${rrRatio.toFixed(1)} < ${CONFIG.minRRRatio})`);
      return null;
    }
    
    // Определяем уровень сигнала
    const tier = confidence >= 80 ? 'GOD TIER' : 
                 confidence >= 70 ? 'PREMIUM' : 
                 confidence >= 60 ? 'STANDARD' : null;
    
    if (!tier || tier === 'STANDARD') {
      // Для стандартных сигналов можно использовать более строгие критерии
      if (confidence < 65 || rrRatio < 3.5) {
        return null;
      }
    }
    
    console.log(`✅ СИГНАЛ: ${signal} ${pair.symbol} (${confidence.toFixed(0)}%, R:R 1:${rrRatio.toFixed(1)}, ${tier})`);
    
    return {
      pair: pair.symbol.replace('USDT', '/USDT'),
      signal,
      entry: parseFloat(entry.toFixed(8)),
      tp: parseFloat(tp.toFixed(8)),
      sl: parseFloat(sl.toFixed(8)),
      confidence: Math.round(confidence),
      qualityScore: Math.min(qualityScore, 15),
      rrRatio: parseFloat(rrRatio.toFixed(2)),
      tier,
      exchange: 'BYBIT',
      change24h: pair.change,
      volume24h: pair.volume,
      indicators: {
        rsi: Math.round(rsi),
        macd_hist: parseFloat(macd.histogram.toFixed(6)),
        stoch_k: stoch.k,
        stoch_d: stoch.d,
        ema9: ema9 ? parseFloat(ema9.toFixed(8)) : null,
        ema21: ema21 ? parseFloat(ema21.toFixed(8)) : null,
        ema50: ema50 ? parseFloat(ema50.toFixed(8)) : null,
        bb_position: bb ? parseFloat(((currentPrice - bb.lower) / (bb.upper - bb.lower) * 100).toFixed(1)) : null,
        atr: parseFloat(atr.toFixed(8)),
        volume_strength: parseFloat(volumeStrength.toFixed(2)),
        adx: adx
      },
      confirmations,
      timestamp: new Date()
    };
    
  } catch (error) {
    console.error(`❌ Ошибка анализа ${pair.symbol}:`, error.message);
    return null;
  }
}

// ==================== ГЕНЕРАЦИЯ СИГНАЛОВ ====================
async function generateSignals() {
  try {
    console.log('\n🎯 НАЧАЛО СКАНИРОВАНИЯ');
    console.log('='.repeat(60));
    console.log(`⏰ Время: ${new Date().toLocaleString('ru-RU')}`);
    console.log('='.repeat(60));
    
    const topMovers = await getTopMovers();
    if (topMovers.length === 0) {
      console.log('❌ Нет данных для анализа');
      return [];
    }
    
    console.log(`📊 Анализ ${topMovers.length} пар...`);
    
    const signals = [];
    let analyzedCount = 0;
    
    for (const pair of topMovers) {
      analyzedCount++;
      const signal = await analyzeSignal(pair);
      if (signal) {
        signals.push(signal);
      }
      
      // Добавляем задержку чтобы не превысить лимиты API
      if (analyzedCount % 5 === 0) {
        console.log(`⏳ Проанализировано ${analyzedCount}/${topMovers.length} пар`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Сортируем сигналы по уверенности
    signals.sort((a, b) => b.confidence - a.confidence);
    
    console.log('='.repeat(60));
    console.log(`📊 РЕЗУЛЬТАТЫ: Найдено ${signals.length} сигналов`);
    if (signals.length > 0) {
      signals.forEach((s, i) => {
        console.log(`   ${i + 1}. ${s.tier} ${s.signal} ${s.pair}: ${s.confidence}% (R:R 1:${s.rrRatio})`);
      });
    } else {
      console.log('   ℹ️ Сигналов не найдено');
    }
    console.log('='.repeat(60));
    
    return signals.slice(0, 10); // Максимум 10 сигналов за раз
  } catch (error) {
    console.error('❌ Ошибка генерации сигналов:', error);
    console.error('Stack:', error.stack);
    return [];
  }
}

// ==================== ОТПРАВКА В TELEGRAM ====================
async function sendSignalToTelegram(signal) {
  if (!CHAT_ID) {
    console.log('⚠️  CHAT_ID не установлен, пропускаю отправку');
    return false;
  }
  
  try {
    const profitPercent = signal.signal === 'LONG' 
      ? ((signal.tp / signal.entry - 1) * 100).toFixed(2)
      : ((1 - signal.tp / signal.entry) * 100).toFixed(2);
    
    const lossPercent = signal.signal === 'LONG'
      ? ((1 - signal.sl / signal.entry) * 100).toFixed(2)
      : ((signal.sl / signal.entry - 1) * 100).toFixed(2);
    
    const emoji = signal.tier === 'GOD TIER' ? '👑' : signal.tier === 'PREMIUM' ? '💎' : '📊';
    
    const message = `
${emoji} <b>${signal.tier} SIGNAL</b>

${signal.signal === 'LONG' ? '🟢' : '🔴'} <b>${signal.signal} ${signal.pair}</b>

📈 <b>24h Change:</b> ${signal.change24h > 0 ? '+' : ''}${signal.change24h.toFixed(2)}%
💰 <b>24h Volume:</b> $${(signal.volume24h / 1000000).toFixed(2)}M

🎯 <b>Entry:</b> ${signal.entry}
✅ <b>Take Profit:</b> ${signal.tp} (<b>+${profitPercent}%</b>)
🛑 <b>Stop Loss:</b> ${signal.sl} (<b>-${lossPercent}%</b>)

📊 <b>R:R Ratio:</b> 1:${signal.rrRatio}
🔮 <b>Confidence:</b> ${signal.confidence}%
🏆 <b>Quality Score:</b> ${signal.qualityScore}/15

<b>📉 ИНДИКАТОРЫ:</b>
• RSI: ${signal.indicators.rsi}
• MACD Hist: ${signal.indicators.macd_hist}
• Stoch K/D: ${signal.indicators.stoch_k}/${signal.indicators.stoch_d}
• BB Position: ${signal.indicators.bb_position}%
• ATR: ${signal.indicators.atr}
• Volume: x${signal.indicators.volume_strength}
• ADX: ${signal.indicators.adx}

<b>✅ ПОДТВЕРЖДЕНИЯ (${signal.confirmations.length}):</b>
${signal.confirmations.slice(0, 8).map(c => `• ${c.replace(/_/g, ' ')}`).join('\n')}

⏰ ${signal.timestamp.toLocaleTimeString('ru-RU', {hour: '2-digit', minute:'2-digit'})}
🏦 <b>Exchange: BYBIT SPOT</b>
    `.trim();
    
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log(`✅ Отправлен сигнал: ${signal.tier} ${signal.signal} ${signal.pair}`);
    return true;
  } catch (error) {
    console.error('❌ Ошибка отправки в Telegram:', error.message);
    return false;
  }
}

// ==================== ОСНОВНАЯ ЗАДАЧА ====================
async function runSignalsTask(isManual = false) {
  if (!isManual) {
    console.log('\n' + '█'.repeat(60));
    console.log('🔄 ЗАПУСК АВТОМАТИЧЕСКОГО СКАНИРОВАНИЯ');
    console.log(`⏰ ${new Date().toLocaleString('ru-RU')}`);
    console.log('█'.repeat(60));
  }
  
  try {
    const signals = await generateSignals();
    
    if (signals.length === 0) {
      console.log('ℹ️  Сигналов не найдено в текущем сканировании');
      
      if (CHAT_ID && isManual) {
        await bot.telegram.sendMessage(
          CHAT_ID,
          `ℹ️ <b>Сканирование завершено</b>\n\n` +
          `Проанализировано: ${CONFIG.topGainers + CONFIG.topLosers} пар\n` +
          `Сигналов не найдено\n\n` +
          `⏰ ${new Date().toLocaleTimeString('ru-RU')}\n` +
          `🏦 Bybit Spot`,
          { parse_mode: 'HTML' }
        );
      }
      return;
    }
    
    console.log(`📤 Отправка ${signals.length} сигналов в Telegram...`);
    
    let sentCount = 0;
    for (const signal of signals) {
      const sent = await sendSignalToTelegram(signal);
      if (sent) sentCount++;
      
      // Задержка между отправками чтобы не превысить лимиты Telegram
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    
    if (CHAT_ID && isManual) {
      await bot.telegram.sendMessage(
        CHAT_ID,
        `✅ <b>Сканирование завершено</b>\n\n` +
        `Найдено сигналов: ${signals.length}\n` +
        `Отправлено: ${sentCount}\n\n` +
        `⏰ ${new Date().toLocaleTimeString('ru-RU')}\n` +
        `🏦 Bybit Spot`,
        { parse_mode: 'HTML' }
      );
    }
    
    console.log(`✅ Сканирование успешно завершено. Отправлено сигналов: ${sentCount}\n`);
  } catch (error) {
    console.error('❌ Критическая ошибка:', error);
    console.error('Stack:', error.stack);
    
    if (CHAT_ID && isManual) {
      try {
        await bot.telegram.sendMessage(
          CHAT_ID,
          `❌ <b>Ошибка сканирования</b>\n\n${error.message}`,
          { parse_mode: 'HTML' }
        );
      } catch (e) {
        console.error('Не удалось отправить сообщение об ошибке');
      }
    }
  }
}

// ==================== ЗАПУСК БОТА ====================
async function start() {
  try {
    console.log('\n🔄 Инициализация Telegram бота...');
    
    // Устанавливаем обработчики ошибок
    bot.catch((err, ctx) => {
      console.error(`❌ Ошибка Telegram бота:`, err);
      console.error(`Контекст:`, ctx?.updateType);
    });
    
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch({ 
      dropPendingUpdates: true,
      allowedUpdates: ['message', 'callback_query']
    });
    
    console.log('✅ Telegram бот запущен');
    
    console.log('\n' + '█'.repeat(60));
    console.log('🤖 BYBIT SCALPER BOT v3.0 - ЗАПУЩЕН');
    console.log('█'.repeat(60));
    console.log('');
    console.log('⚡ АКТИВНЫЕ ИНДИКАТОРЫ:');
    console.log('   • EMA (9, 21, 50)');
    console.log('   • RSI (14)');
    console.log('   • MACD (12, 26, 9)');
    console.log('   • Bollinger Bands (20, 2)');
    console.log('   • Stochastic (14, 3, 3)');
    console.log('   • ATR (14)');
    console.log('   • ADX (14)');
    console.log('   • Volume Analysis');
    console.log('');
    console.log('📊 ПАРАМЕТРЫ СКАНИРОВАНИЯ:');
    console.log(`   • Топ ${CONFIG.topGainers} растущих`);
    console.log(`   • Топ ${CONFIG.topLosers} падающих`);
    console.log(`   • Минимальный объем: ${(CONFIG.min24hVolume / 1000000).toFixed(2)}M USDT`);
    console.log(`   • Стоп-лосс: ${CONFIG.stopLossPercent}%`);
    console.log(`   • Тейк-профит: ${CONFIG.takeProfitPercent}%`);
    console.log(`   • Min R:R: 1:${CONFIG.minRRRatio}`);
    console.log(`   • Min Confidence: ${CONFIG.minConfidence}%`);
    console.log(`   • Min Confirmations: ${CONFIG.minConfirmations}`);
    console.log('');
    console.log('🏦 БИРЖА: BYBIT SPOT');
    console.log('⏰ РАСПИСАНИЕ: Каждые 15 минут');
    console.log('📱 КОМАНДЫ: /start, /status, /test, /scan');
    console.log('█'.repeat(60));
    console.log('');
    
    if (CHAT_ID) {
      console.log('📤 Отправка стартового сообщения...');
      try {
        await bot.telegram.sendMessage(
          CHAT_ID,
          `🚀 <b>Bybit Scalper Bot v3.0 запущен!</b>\n\n` +
          `✅ Подключение к Telegram: OK\n` +
          `✅ Конфигурация загружена\n\n` +
          `📊 <b>Параметры:</b>\n` +
          `• Объем > ${(CONFIG.min24hVolume / 1000000).toFixed(2)}M USDT\n` +
          `• R:R > 1:${CONFIG.minRRRatio}\n` +
          `• Confidence > ${CONFIG.minConfidence}%\n\n` +
          `⏰ <b>Расписание:</b>\n` +
          `• Автосканирование: каждые 15 мин\n` +
          `• Первое сканирование: через 1 минуту\n\n` +
          `🏦 Биржа: Bybit Spot\n` +
          `Используйте /test для проверки API\n` +
          `Используйте /scan для ручного сканирования`,
          { parse_mode: 'HTML' }
        );
        console.log('✅ Стартовое сообщение отправлено');
      } catch (error) {
        console.error('❌ Ошибка отправки стартового сообщения:', error.message);
      }
    }
    
    // Настраиваем планировщик
    cron.schedule('*/15 * * * *', () => {
      console.log(`\n⏰ Запуск по расписанию: ${new Date().toLocaleString('ru-RU')}`);
      runSignalsTask(false).catch(err => {
        console.error('❌ Ошибка в планировщике:', err);
      });
    });
    
    console.log('⏳ Первое сканирование через 1 минуту...\n');
    
    // Первое сканирование через 1 минуту
    setTimeout(() => {
      console.log(`\n🎯 Запуск первого сканирования: ${new Date().toLocaleString('ru-RU')}`);
      runSignalsTask(false).catch(err => {
        console.error('❌ Ошибка первого сканирования:', err);
      });
    }, 60000);
    
  } catch (error) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА ЗАПУСКА:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

// Обработчики завершения работы
process.once('SIGINT', () => {
  console.log('\n⚠️  Получен сигнал SIGINT, останавливаю бота...');
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('\n⚠️  Получен сигнал SIGTERM, останавливаю бота...');
  bot.stop('SIGTERM');
  process.exit(0);
});

// Обработчик необработанных ошибок
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Необработанная ошибка:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Непойманная ошибка:', error);
});

// Запуск бота
start();
