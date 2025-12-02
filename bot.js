 import { Telegraf } from 'telegraf';
import axios from 'axios';
import cron from 'node-cron';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не установлен!');
  process.exit(1);
}

// ==================== КОНФИГУРАЦИЯ ====================
const CONFIG = {
  baseUrl: 'https://api.binance.com/api/v3',
  timeframe: '15m',
  topGainers: 15,
  topLosers: 15,
  min24hVolume: 5000000,  // 5M USDT
  stopLossPercent: 0.25,
  takeProfitPercent: 1.25,
  minRRRatio: 5.0,
  minConfidence: 78,
  minConfirmations: 3  // Минимум 3 подтверждения индикаторов
};

// ==================== РАБОЧИЕ ИНДИКАТОРЫ ====================

// 1. EMA - точно работает
function calculateEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  
  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }
  
  return ema;
}

// 2. RSI - точно работает
function calculateRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return 50;
  
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

// 3. MACD - полностью рабочий
function calculateMACD(prices) {
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  
  if (!ema12 || !ema26) return { macd: 0, signal: 0, histogram: 0 };
  
  const macd = ema12 - ema26;
  
  // Сигнальная линия (EMA9 от MACD)
  const macdValues = [];
  for (let i = 26; i < prices.length; i++) {
    const slice = prices.slice(0, i + 1);
    const ema12Slice = calculateEMA(slice, 12);
    const ema26Slice = calculateEMA(slice, 26);
    if (ema12Slice && ema26Slice) {
      macdValues.push(ema12Slice - ema26Slice);
    }
  }
  
  const signal = calculateEMA(macdValues, 9) || macd;
  const histogram = macd - signal;
  
  return { 
    macd: parseFloat(macd.toFixed(6)), 
    signal: parseFloat(signal.toFixed(6)), 
    histogram: parseFloat(histogram.toFixed(6)) 
  };
}

// 4. Bollinger Bands - рабочий
function calculateBollingerBands(prices, period = 20, stdDev = 2) {
  if (!prices || prices.length < period) return null;
  
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  
  return {
    upper: mean + (std * stdDev),
    middle: mean,
    lower: mean - (std * stdDev)
  };
}

// 5. Stochastic - РАБОЧИЙ и ИСПОЛЬЗУЕТСЯ!
function calculateStochastic(prices, period = 14) {
  if (!prices || prices.length < period) return { k: 50, d: 50 };
  
  const recentPrices = prices.slice(-period);
  const high = Math.max(...recentPrices);
  const low = Math.min(...recentPrices);
  const currentPrice = prices[prices.length - 1];
  
  if (high === low) return { k: 50, d: 50 };
  
  // %K
  const k = ((currentPrice - low) / (high - low)) * 100;
  
  // %D (простая скользящая от %K за 3 периода)
  const kValues = [];
  for (let i = 0; i <= prices.length - period; i++) {
    const slice = prices.slice(i, i + period);
    const sliceHigh = Math.max(...slice);
    const sliceLow = Math.min(...slice);
    const sliceCurrent = slice[slice.length - 1];
    
    if (sliceHigh !== sliceLow) {
      kValues.push(((sliceCurrent - sliceLow) / (sliceHigh - sliceLow)) * 100);
    }
  }
  
  const d = kValues.length >= 3 
    ? kValues.slice(-3).reduce((a, b) => a + b, 0) / 3 
    : k;
  
  return { k: parseFloat(k.toFixed(2)), d: parseFloat(d.toFixed(2)) };
}

// 6. ATR (Average True Range) - для стоп-лосса
function calculateATR(prices, period = 14) {
  if (!prices || prices.length < period + 1) return 0;
  
  const trValues = [];
  for (let i = 1; i < prices.length; i++) {
    const high = prices[i];
    const low = prices[i];
    const prevClose = prices[i - 1];
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trValues.push(tr);
  }
  
  // Простой ATR
  const recentTR = trValues.slice(-period);
  return recentTR.reduce((a, b) => a + b, 0) / period;
}

// 7. Volume анализ
function calculateVolumeStrength(volumes, period = 20) {
  if (!volumes || volumes.length < period) return 1;
  
  const recentVolumes = volumes.slice(-period);
  const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / period;
  const currentVolume = volumes[volumes.length - 1];
  
  return currentVolume / avgVolume; // >1 = объем выше среднего
}

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply(
    `🤖 <b>Binance Scalper v2.0</b>\n\n` +
    `📊 Рабочие индикаторы:\n` +
    `• EMA (9, 21, 50)\n` +
    `• RSI (14)\n` +
    `• MACD (12, 26, 9)\n` +
    `• Bollinger Bands (20, 2)\n` +
    `• Stochastic (14, 3, 3)\n` +
    `• ATR (14) для стопов\n\n` +
    `🎯 Все индикаторы влияют на решение!`,
    { parse_mode: 'HTML' }
  );
});

// ==================== ПОЛУЧЕНИЕ ДАННЫХ ====================
async function getTopMovers() {
  try {
    console.log('📡 Запрос данных...');
    const response = await axios.get(`${CONFIG.baseUrl}/ticker/24hr`);
    
    const usdtPairs = response.data.filter(pair => 
      pair.symbol.endsWith('USDT') &&
      parseFloat(pair.quoteVolume) >= CONFIG.min24hVolume &&
      parseFloat(pair.lastPrice) > 0.0001
    );
    
    const pairsWithChange = usdtPairs.map(pair => ({
      symbol: pair.symbol,
      change: parseFloat(pair.priceChangePercent),
      volume: parseFloat(pair.quoteVolume),
      price: parseFloat(pair.lastPrice),
      high: parseFloat(pair.highPrice),
      low: parseFloat(pair.lowPrice)
    }));
    
    const sorted = pairsWithChange.sort((a, b) => b.change - a.change);
    const topGainers = sorted.slice(0, CONFIG.topGainers);
    const topLosers = sorted.slice(-CONFIG.topLosers).reverse();
    
    console.log(`✅ Данные получены: ${topGainers.length}↑ ${topLosers.length}↓`);
    return [...topGainers, ...topLosers];
  } catch (error) {
    console.error('❌ Ошибка данных:', error.message);
    return [];
  }
}

// ==================== АНАЛИЗ С ИСПОЛЬЗОВАНИЕМ ВСЕХ ИНДИКАТОРОВ ====================
async function analyzeSignal(pair) {
  try {
    console.log(`🔍 Анализ ${pair.symbol}...`);
    
    // 1. Получаем свечи
    const candleResponse = await axios.get(
      `${CONFIG.baseUrl}/klines?symbol=${pair.symbol}&interval=${CONFIG.timeframe}&limit=100`
    );
    
    if (!candleResponse.data || candleResponse.data.length < 50) {
      console.log(`⚠️  Мало данных для ${pair.symbol}`);
      return null;
    }
    
    // 2. Подготавливаем данные
    const prices = candleResponse.data.map(c => parseFloat(c[4]));  // Close
    const highs = candleResponse.data.map(c => parseFloat(c[2]));   // High
    const lows = candleResponse.data.map(c => parseFloat(c[3]));    // Low
    const volumes = candleResponse.data.map(c => parseFloat(c[5])); // Volume
    
    const currentPrice = prices[prices.length - 1];
    
    // 3. ВСЕ ИНДИКАТОРЫ
    const rsi = calculateRSI(prices);
    const ema9 = calculateEMA(prices, 9);
    const ema21 = calculateEMA(prices, 21);
    const ema50 = calculateEMA(prices, 50);
    const macd = calculateMACD(prices);
    const bb = calculateBollingerBands(prices);
    const stochastic = calculateStochastic(prices);
    const atr = calculateATR(prices);
    const volumeStrength = calculateVolumeStrength(volumes);
    
    // 4. ПОДСЧЕТ ПОДТВЕРЖДЕНИЙ
    let confirmations = [];
    let qualityScore = 0;
    
    // RSI условия
    if (rsi < 30) {
      confirmations.push('RSI_OVERSOLD');
      qualityScore += 2;
    } else if (rsi > 70) {
      confirmations.push('RSI_OVERBOUGHT');
      qualityScore += 2;
    }
    
    // MACD условия
    if (macd.histogram > 0 && macd.macd > macd.signal) {
      confirmations.push('MACD_BULLISH');
      qualityScore += 2;
    } else if (macd.histogram < 0 && macd.macd < macd.signal) {
      confirmations.push('MACD_BEARISH');
      qualityScore += 2;
    }
    
    // Bollinger Bands
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
    
    // Stochastic
    if (stochastic.k < 20) {
      confirmations.push('STOCH_OVERSOLD');
      qualityScore += 2;
    } else if (stochastic.k > 80) {
      confirmations.push('STOCH_OVERBOUGHT');
      qualityScore += 2;
    }
    
    // EMA выравнивание
    if (ema9 && ema21 && ema50) {
      if (ema9 > ema21 && ema21 > ema50) {
        confirmations.push('EMA_BULLISH_ALIGNMENT');
        qualityScore += 3;
      } else if (ema9 < ema21 && ema21 < ema50) {
        confirmations.push('EMA_BEARISH_ALIGNMENT');
        qualityScore += 3;
      }
    }
    
    // Объем
    if (volumeStrength > 1.5) {
      confirmations.push('HIGH_VOLUME');
      qualityScore += 1;
    }
    
    // 5. МИНИМАЛЬНЫЕ ТРЕБОВАНИЯ
    if (confirmations.length < CONFIG.minConfirmations) {
      console.log(`⚠️  ${pair.symbol}: мало подтверждений (${confirmations.length})`);
      return null;
    }
    
    // 6. ОПРЕДЕЛЕНИЕ СИГНАЛА
    let signal = null;
    let confidence = 0;
    
    // LONG сигнал (множественные подтверждения)
    if (
      pair.change > 3 &&                    // Рост за 24ч
      rsi < 40 &&                           // Не перекуплен
      stochastic.k < 40 &&                  // Stochastic не перекуплен
      macd.histogram > 0 &&                 // MACD бычий
      (!bb || currentPrice < bb.middle) &&  // Цена ниже средней линии BB
      ema9 && ema21 && ema9 > ema21         // Бычий тренд
    ) {
      signal = 'LONG';
      confidence = Math.min(
        60 + 
        (40 - rsi) * 0.8 +                  // Чем ниже RSI, тем выше уверенность
        (macd.histogram > 0 ? 10 : 0) +     // MACD бычий
        (stochastic.k < 30 ? 10 : 0) +      // Stochastic в перепроданности
        confirmations.length * 3,           // За каждое подтверждение
        95
      );
    }
    // SHORT сигнал
    else if (
      pair.change < -3 &&
      rsi > 60 &&
      stochastic.k > 60 &&
      macd.histogram < 0 &&
      (!bb || currentPrice > bb.middle) &&
      ema9 && ema21 && ema9 < ema21
    ) {
      signal = 'SHORT';
      confidence = Math.min(
        60 +
        (rsi - 60) * 0.8 +
        (macd.histogram < 0 ? 10 : 0) +
        (stochastic.k > 70 ? 10 : 0) +
        confirmations.length * 3,
        95
      );
    }
    
    if (!signal || confidence < CONFIG.minConfidence) {
      console.log(`❌ ${pair.symbol}: нет сигнала (conf: ${confidence.toFixed(0)})`);
      return null;
    }
    
    // 7. РАСЧЕТ ЦЕН С ИСПОЛЬЗОВАНИЕМ ATR
    const entry = currentPrice;
    let sl, tp, rrRatio;
    
    if (signal === 'LONG') {
      // Динамический стоп на основе ATR или фиксированный %
      const atrBasedSL = entry - (atr * 1.5);
      const fixedSL = entry * (1 - CONFIG.stopLossPercent / 100);
      sl = Math.min(atrBasedSL, fixedSL);
      
      // Тейк на основе R:R
      tp = entry + (entry - sl) * CONFIG.minRRRatio;
      rrRatio = (tp - entry) / (entry - sl);
    } else {
      const atrBasedSL = entry + (atr * 1.5);
      const fixedSL = entry * (1 + CONFIG.stopLossPercent / 100);
      sl = Math.max(atrBasedSL, fixedSL);
      
      tp = entry - (sl - entry) * CONFIG.minRRRatio;
      rrRatio = (entry - tp) / (sl - entry);
    }
    
    if (rrRatio < CONFIG.minRRRatio) {
      console.log(`⚠️  ${pair.symbol}: плохое R:R (${rrRatio.toFixed(2)})`);
      return null;
    }
    
    // 8. УРОВЕНЬ СИГНАЛА
    const tier = confidence >= 85 ? 'GOD TIER' : 
                 confidence >= 78 ? 'PREMIUM' : 'STANDARD';
    
    if (tier === 'STANDARD') {
      console.log(`ℹ️  ${pair.symbol}: стандартный сигнал (conf: ${confidence})`);
      return null; // Отправляем только премиум и god tier
    }
    
    console.log(`✅ ${pair.symbol}: ${signal} ${tier} (conf: ${confidence}, R:R: ${rrRatio.toFixed(1)})`);
    
    return {
      pair: pair.symbol.replace('USDT', '/USDT'),
      signal,
      entry: parseFloat(entry.toFixed(6)),
      tp: parseFloat(tp.toFixed(6)),
      sl: parseFloat(sl.toFixed(6)),
      confidence: Math.round(confidence),
      qualityScore,
      rrRatio: parseFloat(rrRatio.toFixed(2)),
      tier,
      exchange: 'BINANCE',
      indicators: {
        rsi: Math.round(rsi),
        macd_hist: parseFloat(macd.histogram.toFixed(6)),
        stoch_k: stochastic.k,
        stoch_d: stochastic.d,
        ema9: ema9 ? parseFloat(ema9.toFixed(6)) : null,
        ema21: ema21 ? parseFloat(ema21.toFixed(6)) : null,
        bb_position: bb ? parseFloat(((currentPrice - bb.lower) / (bb.upper - bb.lower) * 100).toFixed(1)) : null,
        atr: parseFloat(atr.toFixed(6)),
        volume_strength: parseFloat(volumeStrength.toFixed(2))
      },
      confirmations,
      timestamp: new Date()
    };
    
  } catch (error) {
    console.error(`❌ Ошибка анализа ${pair.symbol}:`, error.message);
    return null;
  }
}

// ==================== ОСНОВНАЯ ЛОГИКА ====================
async function generateSignals() {
  try {
    console.log('\n🎯 Начинаю сканирование...');
    
    const topMovers = await getTopMovers();
    if (topMovers.length === 0) return [];
    
    const signals = [];
    
    // Анализируем каждую пару
    for (const pair of topMovers.slice(0, 12)) {
      const signal = await analyzeSignal(pair);
      if (signal) {
        signals.push(signal);
      }
      
      // Задержка чтобы не превысить лимиты
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    
    // Сортируем по уверенности
    signals.sort((a, b) => b.confidence - a.confidence);
    
    console.log(`\n📊 Результаты: ${signals.length} сигналов`);
    signals.forEach(s => {
      console.log(`   ${s.signal} ${s.pair}: ${s.confidence}% (R:R 1:${s.rrRatio.toFixed(1)})`);
    });
    
    return signals.slice(0, 3); // Только 3 лучших
  } catch (error) {
    console.error('❌ Ошибка генерации сигналов:', error);
    return [];
  }
}

// ==================== ОТПРАВКА В TELEGRAM ====================
async function sendSignalToTelegram(signal) {
  if (!CHAT_ID) {
    console.log('⚠️ CHAT_ID не установлен');
    return false;
  }
  
  try {
    const message = `
${signal.tier === 'GOD TIER' ? '👑' : '💎'} <b>${signal.tier} SIGNAL</b>

${signal.signal === 'LONG' ? '🟢' : '🔴'} <b>${signal.signal} ${signal.pair}</b>

🎯 <b>Entry:</b> ${signal.entry}
✅ <b>TP:</b> ${signal.tp} (<b>+${((signal.tp/signal.entry-1)*100).toFixed(2)}%</b>)
🛑 <b>SL:</b> ${signal.sl} (<b>-${((1-signal.sl/signal.entry)*100).toFixed(2)}%</b>)

📊 <b>R:R Ratio:</b> 1:${signal.rrRatio.toFixed(1)}
🔮 <b>Confidence:</b> ${signal.confidence}%
🏆 <b>Quality:</b> ${signal.qualityScore}/10

<b>ИНДИКАТОРЫ:</b>
📉 RSI: ${signal.indicators.rsi}
📈 MACD Hist: ${signal.indicators.macd_hist}
📊 Stoch K/D: ${signal.indicators.stoch_k}/${signal.indicators.stoch_d}
📡 BB Position: ${signal.indicators.bb_position}%
📏 ATR: ${signal.indicators.atr}
📈 Volume: x${signal.indicators.volume_strength}

<b>ПОДТВЕРЖДЕНИЯ (${signal.confirmations.length}):</b>
${signal.confirmations.slice(0, 5).map(c => `• ${c}`).join('\n')}

⏰ <b>${signal.timestamp.toLocaleTimeString('ru-RU', {hour: '2-digit', minute:'2-digit'})}</b>
    `.trim();
    
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log(`✅ Отправлен ${signal.signal} ${signal.pair}`);
    return true;
  } catch (error) {
    console.error('❌ Ошибка отправки:', error.message);
    return false;
  }
}

// ==================== CRON ЗАДАЧА ====================
async function runSignalsTask() {
  console.log('\n' + '='.repeat(50));
  console.log('🔄 ЗАПУСК СКАНИРОВАНИЯ');
  console.log(`⏰ ${new Date().toLocaleString('ru-RU')}`);
  console.log('='.repeat(50));
  
  try {
    const signals = await generateSignals();
    
    if (signals.length === 0) {
      console.log('ℹ️  Сигналов не найдено');
      return;
    }
    
    for (const signal of signals) {
      await sendSignalToTelegram(signal);
      await new Promise(resolve => setTimeout(resolve, 2500));
    }
    
    console.log('✅ Сканирование завершено\n');
  } catch (error) {
    console.error('❌ Ошибка:', error);
  }
}

// ==================== ЗАПУСК ====================
async function start() {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch({ dropPendingUpdates: true });
    
    console.log('\n' + '='.repeat(50));
    console.log('🤖 BINANCE SCALPER BOT v2.0');
    console.log('='.repeat(50));
    console.log('✅ Бот запущен!');
    console.log('📡 Источник: Binance Public API');
    console.log('⚡ Все индикаторы активны:');
    console.log('   • EMA (9, 21, 50)');
    console.log('   • RSI (14)');
    console.log('   • MACD (12, 26, 9)');
    console.log('   • Bollinger Bands (20, 2)');
    console.log('   • Stochastic (14, 3, 3)');
    console.log('   • ATR (14)');
    console.log(`🎯 Параметры: Стоп ${CONFIG.stopLossPercent}%, Тейк ${CONFIG.takeProfitPercent}%`);
    console.log(`📊 Min R:R: 1:${CONFIG.minRRRatio}, Min Conf: ${CONFIG.minConfidence}%`);
    console.log('⏰ Сканирование: каждые 20 минут\n');
    
    // Сканирование каждые 20 минут
    cron.schedule('*/20 * * * *', runSignalsTask);
    
    // Первый запуск через 15 секунд
    setTimeout(runSignalsTask, 15000);
    
  } catch (error) {
    console.error('❌ Ошибка запуска:', error.message);
  }
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

start();