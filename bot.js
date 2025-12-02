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
  timeframe: '15',  // 15 минут для Bybit
  topGainers: 30,
  topLosers: 30,
  min24hVolume: 3000000,  // 3M USDT
  stopLossPercent: 0.3,
  takeProfitPercent: 1.5,
  minRRRatio: 5.0,
  minConfidence: 75,
  minConfirmations: 3
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
  const macdValues = [];
  for (let i = 26; i < prices.length; i++) {
    const slice = prices.slice(0, i + 1);
    const e12 = calculateEMA(slice, 12);
    const e26 = calculateEMA(slice, 26);
    if (e12 && e26) {
      macdValues.push(e12 - e26);
    }
  }
  const signal = calculateEMA(macdValues, 9) || macd;
  const histogram = macd - signal;
  return { 
    macd: parseFloat(macd.toFixed(8)), 
    signal: parseFloat(signal.toFixed(8)), 
    histogram: parseFloat(histogram.toFixed(8)) 
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
  const welcomeMessage = `🤖 <b>Bybit Scalper Bot v2.0</b>

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
Автоматическое сканирование каждые 20 минут

🎖️ <b>Уровни сигналов:</b>
👑 GOD TIER - Уверенность ≥85%
💎 PREMIUM - Уверенность ≥75%

✅ Бот работает на Bybit Spot!`;

  ctx.reply(welcomeMessage, { parse_mode: 'HTML' });
});

bot.command('status', (ctx) => {
  console.log('📱 Получена команда /status от:', ctx.from.id);
  ctx.reply(
    `✅ <b>Бот активен</b>\n\n` +
    `📡 API: Bybit Public\n` +
    `⏰ Сканирование: каждые 20 минут\n` +
    `🎯 Следующий запуск через: ${getNextScanTime()}`,
    { parse_mode: 'HTML' }
  );
});

bot.command('test', async (ctx) => {
  console.log('📱 Получена команда /test от:', ctx.from.id);
  try {
    await ctx.reply('🧪 Тестирую подключение к Bybit API...');
    
    const response = await axios.get(`${CONFIG.baseUrl}/v5/market/tickers`, {
      params: { category: CONFIG.category, limit: 1 },
      timeout: 10000
    });
    
    if (response.data.retCode === 0) {
      await ctx.reply('✅ Bybit API доступен!');
      await ctx.reply(`📊 Получено данных: ${response.data.result.list.length} пар`);
    } else {
      await ctx.reply(`⚠️ Bybit API вернул код: ${response.data.retCode}`);
    }
    
    await ctx.reply('✅ Все системы работают!');
  } catch (error) {
    console.error('❌ Ошибка теста:', error.message);
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

function getNextScanTime() {
  const now = new Date();
  const minutes = now.getMinutes();
  const nextScan = 20 - (minutes % 20);
  return `${nextScan} мин`;
}

// ==================== ПОЛУЧЕНИЕ ДАННЫХ ====================
async function getTopMovers() {
  try {
    console.log('📡 Запрос данных с Bybit...');
    const response = await axios.get(`${CONFIG.baseUrl}/v5/market/tickers`, {
      params: { category: CONFIG.category },
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });
    
    if (response.data.retCode !== 0) {
      console.error('❌ Bybit API ошибка:', response.data.retMsg);
      return [];
    }
    
    console.log(`✅ Получено ${response.data.result.list.length} пар с Bybit`);
    
    const usdtPairs = response.data.result.list.filter(pair => 
      pair.symbol.endsWith('USDT') &&
      !pair.symbol.includes('UP') &&
      !pair.symbol.includes('DOWN') &&
      !pair.symbol.includes('BEAR') &&
      !pair.symbol.includes('BULL') &&
      parseFloat(pair.turnover24h) >= CONFIG.min24hVolume &&
      parseFloat(pair.lastPrice) > 0 &&
      parseFloat(pair.price24hPcnt) !== 0
    );
    
    console.log(`✅ Отфильтровано ${usdtPairs.length} USDT пар с объемом >${(CONFIG.min24hVolume/1000000).toFixed(1)}M`);
    
    const pairsWithChange = usdtPairs.map(pair => ({
      symbol: pair.symbol,
      change: parseFloat(pair.price24hPcnt) * 100,  // Bybit возвращает в долях (0.05 = 5%)
      volume: parseFloat(pair.turnover24h),
      price: parseFloat(pair.lastPrice)
    }));
    
    const sorted = pairsWithChange.sort((a, b) => b.change - a.change);
    const topGainers = sorted.slice(0, CONFIG.topGainers);
    const topLosers = sorted.slice(-CONFIG.topLosers).reverse();
    
    console.log(`✅ Топ роста: ${topGainers.length} пар (${topGainers[0]?.symbol}: +${topGainers[0]?.change.toFixed(2)}%)`);
    console.log(`✅ Топ падения: ${topLosers.length} пар (${topLosers[0]?.symbol}: ${topLosers[0]?.change.toFixed(2)}%)`);
    
    return [...topGainers, ...topLosers];
  } catch (error) {
    console.error('❌ Ошибка получения данных:', error.message);
    if (error.code === 'ECONNREFUSED') {
      console.error('❌ Соединение отклонено - возможно Bybit API заблокирован');
    } else if (error.code === 'ETIMEDOUT') {
      console.error('❌ Таймаут - сервер не отвечает');
    }
    return [];
  }
}

// ==================== АНАЛИЗ СИГНАЛА ====================
async function analyzeSignal(pair) {
  try {
    const candleResponse = await axios.get(
      `${CONFIG.baseUrl}/v5/market/kline`,
      { 
        params: {
          category: CONFIG.category,
          symbol: pair.symbol,
          interval: CONFIG.timeframe,
          limit: 200
        },
        timeout: 10000
      }
    );
    
    if (candleResponse.data.retCode !== 0 || !candleResponse.data.result.list || candleResponse.data.result.list.length < 50) {
      return null;
    }
    
    // Bybit возвращает данные в обратном порядке (новые первые), нужно перевернуть
    const candles = candleResponse.data.result.list.reverse();
    
    // Формат Bybit: [startTime, open, high, low, close, volume, turnover]
    const closes = candles.map(c => parseFloat(c[4]));
    const highs = candles.map(c => parseFloat(c[2]));
    const lows = candles.map(c => parseFloat(c[3]));
    const volumes = candles.map(c => parseFloat(c[5]));
    
    const currentPrice = closes[closes.length - 1];
    
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
    
    const confirmations = [];
    let qualityScore = 0;
    
    if (rsi < 30) {
      confirmations.push('RSI_OVERSOLD');
      qualityScore += 2;
    } else if (rsi > 70) {
      confirmations.push('RSI_OVERBOUGHT');
      qualityScore += 2;
    }
    
    if (macd.histogram > 0 && macd.macd > macd.signal) {
      confirmations.push('MACD_BULLISH');
      qualityScore += 2;
    } else if (macd.histogram < 0 && macd.macd < macd.signal) {
      confirmations.push('MACD_BEARISH');
      qualityScore += 2;
    }
    
    if (bb) {
      const bbPosition = (currentPrice - bb.lower) / (bb.upper - bb.lower) * 100;
      if (bbPosition < 20) {
        confirmations.push('BB_OVERSOLD');
        qualityScore += 2;
      } else if (bbPosition > 80) {
        confirmations.push('BB_OVERBOUGHT');
        qualityScore += 2;
      }
    }
    
    if (stoch.k < 20 && stoch.d < 20) {
      confirmations.push('STOCH_OVERSOLD');
      qualityScore += 2;
    } else if (stoch.k > 80 && stoch.d > 80) {
      confirmations.push('STOCH_OVERBOUGHT');
      qualityScore += 2;
    }
    
    if (ema9 && ema21 && ema50) {
      if (ema9 > ema21 && ema21 > ema50) {
        confirmations.push('EMA_BULLISH');
        qualityScore += 3;
      } else if (ema9 < ema21 && ema21 < ema50) {
        confirmations.push('EMA_BEARISH');
        qualityScore += 3;
      }
    }
    
    if (volumeStrength > 1.5) {
      confirmations.push('HIGH_VOLUME');
      qualityScore += 1;
    }
    
    if (adx > 25) {
      confirmations.push('STRONG_TREND');
      qualityScore += 2;
    }
    
    if (confirmations.length < CONFIG.minConfirmations) {
      return null;
    }
    
    let signal = null;
    let confidence = 0;
    
    const bullishConditions = [
      pair.change > 2,
      rsi < 40,
      stoch.k < 40,
      macd.histogram > 0,
      ema9 && ema21 && ema9 > ema21,
      volumeStrength > 1.2
    ].filter(Boolean).length;
    
    const bearishConditions = [
      pair.change < -2,
      rsi > 60,
      stoch.k > 60,
      macd.histogram < 0,
      ema9 && ema21 && ema9 < ema21,
      volumeStrength > 1.2
    ].filter(Boolean).length;
    
    if (bullishConditions >= 4) {
      signal = 'LONG';
      confidence = Math.min(
        50 + 
        (40 - rsi) * 1.0 +
        (macd.histogram > 0 ? 10 : 0) +
        (stoch.k < 30 ? 10 : 0) +
        (adx > 25 ? 5 : 0) +
        confirmations.length * 2,
        95
      );
    } else if (bearishConditions >= 4) {
      signal = 'SHORT';
      confidence = Math.min(
        50 +
        (rsi - 60) * 1.0 +
        (macd.histogram < 0 ? 10 : 0) +
        (stoch.k > 70 ? 10 : 0) +
        (adx > 25 ? 5 : 0) +
        confirmations.length * 2,
        95
      );
    }
    
    if (!signal || confidence < CONFIG.minConfidence) {
      return null;
    }
    
    const entry = currentPrice;
    let sl, tp, rrRatio;
    
    if (signal === 'LONG') {
      const atrBasedSL = entry - (atr * 2);
      const fixedSL = entry * (1 - CONFIG.stopLossPercent / 100);
      sl = Math.max(atrBasedSL, fixedSL);
      const risk = entry - sl;
      tp = entry + (risk * CONFIG.minRRRatio);
      rrRatio = (tp - entry) / (entry - sl);
    } else {
      const atrBasedSL = entry + (atr * 2);
      const fixedSL = entry * (1 + CONFIG.stopLossPercent / 100);
      sl = Math.min(atrBasedSL, fixedSL);
      const risk = sl - entry;
      tp = entry - (risk * CONFIG.minRRRatio);
      rrRatio = (entry - tp) / (sl - entry);
    }
    
    if (rrRatio < CONFIG.minRRRatio) {
      return null;
    }
    
    const tier = confidence >= 85 ? 'GOD TIER' : 
                 confidence >= 75 ? 'PREMIUM' : 'STANDARD';
    
    if (tier === 'STANDARD') {
      return null;
    }
    
    console.log(`✅ СИГНАЛ: ${signal} ${pair.symbol} (${confidence.toFixed(0)}%, R:R 1:${rrRatio.toFixed(1)})`);
    
    return {
      pair: pair.symbol.replace('USDT', '/USDT'),
      signal,
      entry: parseFloat(entry.toFixed(8)),
      tp: parseFloat(tp.toFixed(8)),
      sl: parseFloat(sl.toFixed(8)),
      confidence: Math.round(confidence),
      qualityScore: Math.min(qualityScore, 10),
      rrRatio: parseFloat(rrRatio.toFixed(2)),
      tier,
      exchange: 'BYBIT',
      change24h: pair.change,
      volume24h: pair.volume,
      indicators: {
        rsi: Math.round(rsi),
        macd_hist: parseFloat(macd.histogram.toFixed(8)),
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
    
    const topMovers = await getTopMovers();
    if (topMovers.length === 0) {
      console.log('❌ Нет данных для анализа');
      return [];
    }
    
    const signals = [];
    
    for (const pair of topMovers) {
      const signal = await analyzeSignal(pair);
      if (signal) {
        signals.push(signal);
      }
      await new Promise(resolve => setTimeout(resolve, 600));
    }
    
    signals.sort((a, b) => b.confidence - a.confidence);
    
    console.log('='.repeat(60));
    console.log(`📊 РЕЗУЛЬТАТЫ: Найдено ${signals.length} сигналов`);
    signals.forEach((s, i) => {
      console.log(`   ${i + 1}. ${s.signal} ${s.pair}: ${s.confidence}% (R:R 1:${s.rrRatio})`);
    });
    console.log('='.repeat(60));
    
    return signals.slice(0, 5);
  } catch (error) {
    console.error('❌ Ошибка генерации сигналов:', error);
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
    
    const message = `
${signal.tier === 'GOD TIER' ? '👑' : '💎'} <b>${signal.tier} SIGNAL</b>

${signal.signal === 'LONG' ? '🟢' : '🔴'} <b>${signal.signal} ${signal.pair}</b>

📈 <b>24h Change:</b> ${signal.change24h > 0 ? '+' : ''}${signal.change24h.toFixed(2)}%
💰 <b>24h Volume:</b> $${(signal.volume24h / 1000000).toFixed(2)}M

🎯 <b>Entry:</b> ${signal.entry}
✅ <b>Take Profit:</b> ${signal.tp} (<b>+${profitPercent}%</b>)
🛑 <b>Stop Loss:</b> ${signal.sl} (<b>-${lossPercent}%</b>)

📊 <b>R:R Ratio:</b> 1:${signal.rrRatio}
🔮 <b>Confidence:</b> ${signal.confidence}%
🏆 <b>Quality Score:</b> ${signal.qualityScore}/10

<b>📉 ИНДИКАТОРЫ:</b>
• RSI: ${signal.indicators.rsi}
• MACD Hist: ${signal.indicators.macd_hist}
• Stoch K/D: ${signal.indicators.stoch_k}/${signal.indicators.stoch_d}
• BB Position: ${signal.indicators.bb_position}%
• ATR: ${signal.indicators.atr}
• Volume: x${signal.indicators.volume_strength}
• ADX: ${signal.indicators.adx}

<b>✅ ПОДТВЕРЖДЕНИЯ (${signal.confirmations.length}):</b>
${signal.confirmations.slice(0, 6).map(c => `• ${c.replace(/_/g, ' ')}`).join('\n')}

⏰ ${signal.timestamp.toLocaleTimeString('ru-RU', {hour: '2-digit', minute:'2-digit', second: '2-digit'})}
🏦 <b>Exchange: BYBIT SPOT</b>
    `.trim();
    
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log(`✅ Отправлен сигнал: ${signal.signal} ${signal.pair}`);
    return true;
  } catch (error) {
    console.error('❌ Ошибка отправки в Telegram:', error.message);
    return false;
  }
}

// ==================== ОСНОВНАЯ ЗАДАЧА ====================
async function runSignalsTask() {
  console.log('\n' + '█'.repeat(60));
  console.log('🔄 ЗАПУСК АВТОМАТИЧЕСКОГО СКАНИРОВАНИЯ');
  console.log(`⏰ ${new Date().toLocaleString('ru-RU')}`);
  console.log('█'.repeat(60));
  
  try {
    const signals = await generateSignals();
    
    if (signals.length === 0) {
      console.log('ℹ️  Сигналов не найдено в текущем сканировании');
      
      if (CHAT_ID) {
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
    
    for (const signal of signals) {
      await sendSignalToTelegram(signal);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log('✅ Сканирование успешно завершено\n');
  } catch (error) {
    console.error('❌ Критическая ошибка:', error);
    
    if (CHAT_ID) {
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
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch({ dropPendingUpdates: true });
    console.log('✅ Telegram бот запущен');
    
    console.log('\n' + '█'.repeat(60));
    console.log('🤖 BYBIT SCALPER BOT v2.0 - ЗАПУЩЕН');
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
    console.log(`   • Минимальный объем: ${(CONFIG.min24hVolume / 1000000).toFixed(1)}M USDT`);
    console.log(`   • Стоп-лосс: ${CONFIG.stopLossPercent}%`);
    console.log(`   • Тейк-профит: ${CONFIG.takeProfitPercent}%`);
    console.log(`   • Min R:R: 1:${CONFIG.minRRRatio}`);
    console.log(`   • Min Confidence: ${CONFIG.minConfidence}%`);
    console.log(`   • Min Confirmations: ${CONFIG.minConfirmations}`);
    console.log('');
    console.log('🏦 БИРЖА: BYBIT SPOT');
    console.log('⏰ РАСПИСАНИЕ: Каждые 20 минут');
    console.log('█'.repeat(60));
    console.log('');
    
    if (CHAT_ID) {
      console.log('📤 Отправка тестового сообщения...');
      try {
        await bot.telegram.sendMessage(
          CHAT_ID,
          `🚀 <b>Bybit Scalper Bot запущен!</b>\n\n` +
          `✅ Подключение к Telegram: OK\n` +
          `✅ Подключение к Bybit API: Проверяется...\n\n` +
          `⏰ Первое сканирование через 30 секунд\n` +
          `📊 Затем каждые 20 минут автоматически\n\n` +
          `🏦 Биржа: Bybit Spot\n` +
          `Используйте /test для проверки API`,
          { parse_mode: 'HTML' }
        );
        console.log('✅ Тестовое сообщение отправлено');
      } catch (error) {
        console.error('❌ Ошибка отправки тестового сообщения:', error.message);
      }
    }
    
    cron.schedule('*/20 * * * *', runSignalsTask);
    
    console.log('⏳ Первое сканирование через 30 секунд...\n');
    setTimeout(runSignalsTask, 30000);
    
  } catch (error) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА ЗАПУСКА:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

process.once('SIGINT', () => {
  console.log('\n⚠️  Получен сигнал SIGINT, останавливаю бота...');
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  console.log('\n⚠️  Получен сигнал SIGTERM, останавливаю бота...');
  bot.stop('SIGTERM');
});

start();
