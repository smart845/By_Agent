
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

// ==================== КОНФИГ ДЛЯ ХАЙП ПАР ====================
const CONFIG = {
  binanceUrl: 'https://fapi.binance.com/fapi/v1',
  
  // Настройки сканирования
  scanLimit: 50,                   // Сканируем топ-50 по движению
  minPrice: 0.01,                  // Минимальная цена (фильтр мусора)
  maxSignalsPerRun: 5,             // Макс сигналов за раз
  
  // Критерии для "хайп" пар
  min24hChange: 8.0,               // Минимум 8% движения за 24ч
  min24hVolume: 5000000,           // $5M объем (ниже для альтов)
  minVolatility: 4.0,              // Минимум 4% волатильность
  
  // Уровни сигналов
  godTier: {
    confidence: 88,
    qualityScore: 9,
    rrRatio: 4.0,
    confirmations: 5
  },
  premium: {
    confidence: 78,
    qualityScore: 7, 
    rrRatio: 3.2,
    confirmations: 4
  },
  
  // Фьючерсы
  leverage: 10,
  positionSize: 2.5
};

// ==================== TELEGRAM BOT ====================
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  const chatId = ctx.chat.id;
  console.log(`💬 /start от chat ID: ${chatId}`);
  
  ctx.reply(
    `🚀 <b>BINANCE FUTURES HYPE SCANNER</b>\n\n` +
    `📊 Ваш Chat ID: <code>${chatId}</code>\n\n` +
    `🎯 <b>Фокусировка на:</b>\n` +
    `• Топ росту/падению 24h\n` +
    `• Макс волатильность\n` +
    `• Трендовые движения\n` +
    `• Скальпинг 5m/15m\n\n` +
    `🔧 Установите:\n<code>TELEGRAM_CHAT_ID=${chatId}</code>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('chatid', (ctx) => {
  const chatId = ctx.chat.id;
  ctx.reply(`💬 Ваш Chat ID: <code>${chatId}</code>`, { parse_mode: 'HTML' });
});

bot.command('test', async (ctx) => {
  console.log('🧪 Тестовый хайп сигнал...');
  
  const testSignal = {
    pair: 'PEPEUSDT',
    signal: 'LONG', 
    entry: 0.00000852,
    tp: 0.00000915,
    sl: 0.00000820,
    confidence: 91,
    qualityScore: 9,
    rrRatio: 4.5,
    tier: 'GOD TIER',
    timeframe: '5m',
    leverage: 10,
    positionSize: 2.5,
    liqPrice: 0.00000805,
    fundingRate: 0.0012,
    hypeScore: 94,
    trendMomentum: 'STRONG_UP',
    indicators: {
      rsi: 31,
      stochK: 25,
      adx: 48,
      atr: 0.00000045,
      volumeChange: 287,
      priceChange1h: 6.8,
      priceChange4h: 18.2
    },
    confirmations: ['RSI_OVERSOLD', 'BREAKOUT_CONFIRMED', 'VOLUME_SPIKE_300%', 'TREND_ACCELERATION', 'SUPPORT_HOLD'],
    timestamp: new Date()
  };
  
  await sendSignalToTelegram(testSignal);
  ctx.reply('✅ Тестовый хайп сигнал отправлен!');
});

// ==================== ПОИСК ХАЙП ПАР ====================
async function getHypePairs() {
  try {
    console.log('🔍 Поиск самых движущихся пар...');
    
    const url = `${CONFIG.binanceUrl}/ticker/24hr`;
    const response = await axios.get(url);
    
    if (response.status !== 200) {
      throw new Error(`API Error: ${response.status}`);
    }
    
    const allTickers = response.data
      .filter(ticker => {
        const symbol = ticker.symbol;
        const price = parseFloat(ticker.lastPrice);
        const volume = parseFloat(ticker.volume);
        const priceChange = parseFloat(ticker.priceChangePercent);
        const high = parseFloat(ticker.highPrice);
        const low = parseFloat(ticker.lowPrice);
        
        // Фильтры
        if (!symbol.endsWith('USDT')) return false;
        if (price < CONFIG.minPrice) return false;
        if (volume < CONFIG.min24hVolume) return false;
        if (Math.abs(priceChange) < CONFIG.min24hChange) return false;
        
        // Расчет волатильности
        const volatility = ((high - low) / low) * 100;
        if (volatility < CONFIG.minVolatility) return false;
        
        return true;
      })
      .map(ticker => {
        const symbol = ticker.symbol;
        const priceChange = parseFloat(ticker.priceChangePercent);
        const volume = parseFloat(ticker.volume);
        const high = parseFloat(ticker.highPrice);
        const low = parseFloat(ticker.lowPrice);
        
        // Расчет hype score
        const volatility = ((high - low) / low) * 100;
        const volumeScore = Math.min(100, (volume / 50000000) * 100); // Нормируем объем
        const changeScore = Math.min(100, Math.abs(priceChange) * 3); // Увеличиваем вес изменения цены
        const volatilityScore = Math.min(100, volatility * 5); // Увеличиваем вес волатильности
        
        const hypeScore = (changeScore * 0.4) + (volatilityScore * 0.4) + (volumeScore * 0.2);
        
        return {
          symbol,
          priceChange,
          volume,
          volatility,
          hypeScore: Math.round(hypeScore),
          trend: priceChange > 0 ? 'BULLISH' : 'BEARISH'
        };
      })
      .sort((a, b) => b.hypeScore - a.hypeScore)
      .slice(0, CONFIG.scanLimit);
    
    console.log(`✅ Найдено ${allTickers.length} хайп пар`);
    
    // Логируем топ-5
    console.log('🏆 Топ-5 хайп пар:');
    allTickers.slice(0, 5).forEach((pair, index) => {
      console.log(`${index + 1}. ${pair.symbol} - Score: ${pair.hypeScore} | Change: ${pair.priceChange.toFixed(2)}% | Vol: ${pair.volatility.toFixed(2)}%`);
    });
    
    return allTickers.map(pair => pair.symbol);
    
  } catch (error) {
    console.error('❌ Ошибка поиска хайп пар:', error.message);
    // Fallback пары если API недоступно
    return ['BTCUSDT', 'ETHUSDT', 'ADAUSDT', 'DOGEUSDT', 'SOLUSDT', 'AVAXUSDT', 'MATICUSDT', 'DOTUSDT', 'LINKUSDT', 'XRPUSDT'];
  }
}

// ==================== BINANCE API ====================
async function getFuturesData(symbol, interval = '5m', limit = 100) {
  try {
    const url = `${CONFIG.binanceUrl}/klines`;
    const params = { symbol, interval, limit };
    
    const response = await axios.get(url, { params });
    
    if (response.status !== 200) {
      throw new Error(`API Error: ${response.status}`);
    }
    
    const candles = response.data.map(candle => ({
      timestamp: candle[0],
      open: parseFloat(candle[1]),
      high: parseFloat(candle[2]),
      low: parseFloat(candle[3]),
      close: parseFloat(candle[4]),
      volume: parseFloat(candle[5])
    }));
    
    return {
      symbol,
      interval,
      candles,
      currentPrice: candles[candles.length - 1].close,
      volume24h: candles.reduce((sum, candle) => sum + candle.volume, 0) / candles.length * 24
    };
  } catch (error) {
    console.error(`❌ Ошибка данных для ${symbol}:`, error.message);
    return null;
  }
}

async function getFundingRate(symbol) {
  try {
    const url = `${CONFIG.binanceUrl}/premiumIndex`;
    const response = await axios.get(url, { params: { symbol } });
    return parseFloat(response.data.lastFundingRate);
  } catch (error) {
    return 0;
  }
}

// ==================== ПРОДВИНУТЫЕ ИНДИКАТОРЫ ====================
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
  return 100 - 100 / (1 + rs);
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

function calculateStochastic(highs, lows, closes, period = 14) {
  if (closes.length < period) return { k: 50 };
  
  const currentClose = closes[closes.length - 1];
  const periodHigh = Math.max(...highs.slice(-period));
  const periodLow = Math.min(...lows.slice(-period));
  
  if (periodHigh === periodLow) return { k: 50 };
  
  const k = ((currentClose - periodLow) / (periodHigh - periodLow)) * 100;
  return { k: parseFloat(k.toFixed(2)) };
}

function calculateADX(highs, lows, closes, period = 14) {
  if (closes.length < period * 2) return 25;
  
  let plusDM = 0;
  let minusDM = 0;
  
  for (let i = 1; i < period; i++) {
    const highDiff = highs[highs.length - i] - highs[highs.length - i - 1];
    const lowDiff = lows[lows.length - i - 1] - lows[lows.length - i];
    
    if (highDiff > lowDiff && highDiff > 0) plusDM += highDiff;
    if (lowDiff > highDiff && lowDiff > 0) minusDM += lowDiff;
  }
  
  const tr = Math.max(plusDM, minusDM);
  const dx = tr > 0 ? (Math.abs(plusDM - minusDM) / tr) * 100 : 0;
  
  return Math.min(60, 25 + dx * 0.5);
}

function calculateATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return 0;
  
  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    const high = highs[highs.length - i];
    const low = lows[lows.length - i];
    const prevClose = closes[closes.length - i - 1];
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trSum += tr;
  }
  
  return trSum / period;
}

// НОВЫЙ: Анализ объема
function analyzeVolumeSpike(volumes, period = 20) {
  if (volumes.length < period) return 1.0;
  
  const currentVolume = volumes[volumes.length - 1];
  const averageVolume = volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
  
  return currentVolume / averageVolume;
}

// НОВЫЙ: Анализ импульса
function calculateMomentum(prices, period = 10) {
  if (prices.length < period) return 0;
  
  const currentPrice = prices[prices.length - 1];
  const pastPrice = prices[prices.length - period];
  
  return ((currentPrice - pastPrice) / pastPrice) * 100;
}

// ==================== МУЛЬТИТАЙМФРЕЙМ АНАЛИЗ ====================
async function analyzeMultiTimeframe(symbol) {
  const timeframes = {};
  
  for (const tf of ['5m', '15m', '1h']) {
    const data = await getFuturesData(symbol, tf, 100);
    if (!data) continue;
    
    const closes = data.candles.map(c => c.close);
    const highs = data.candles.map(c => c.high);
    const lows = data.candles.map(c => c.low);
    const volumes = data.candles.map(c => c.volume);
    
    timeframes[tf] = {
      price: data.currentPrice,
      volume: data.volume24h,
      rsi: calculateRSI(closes),
      stoch: calculateStochastic(highs, lows, closes),
      adx: calculateADX(highs, lows, closes),
      atr: calculateATR(highs, lows, closes),
      ema20: calculateEMA(closes, 20),
      ema50: calculateEMA(closes, 50),
      volumeSpike: analyzeVolumeSpike(volumes),
      momentum1h: calculateMomentum(closes, 12), // 12*5m = 1h
      momentum4h: calculateMomentum(closes, 48)  // 48*5m = 4h
    };
  }
  
  return timeframes;
}

// ==================== ГЕНЕРАЦИЯ ХАЙП СИГНАЛОВ ====================
function generateHypeSignal(symbol, timeframeData, hypeScore) {
  const currentPrice = timeframeData['5m'].price;
  
  // Собираем данные со всех таймфреймов
  const allRSI = Object.values(timeframeData).map(tf => tf.rsi);
  const allStoch = Object.values(timeframeData).map(tf => tf.stoch.k);
  const allADX = Object.values(timeframeData).map(tf => tf.adx);
  const allVolumeSpike = Object.values(timeframeData).map(tf => tf.volumeSpike);
  
  // Усредненные показатели
  const avgRSI = allRSI.reduce((a, b) => a + b, 0) / allRSI.length;
  const avgStoch = allStoch.reduce((a, b) => a + b, 0) / allStoch.length;
  const avgADX = allADX.reduce((a, b) => a + b, 0) / allADX.length;
  const avgVolumeSpike = allVolumeSpike.reduce((a, b) => a + b, 0) / allVolumeSpike.length;
  
  // Анализ тренда
  const trendAlignment = analyzeTrendAlignment(timeframeData);
  
  // Подсчет качества
  let qualityScore = 0;
  const confirmations = [];
  
  // RSI + Volume Spike комбо
  if (avgRSI < 32 && avgVolumeSpike > 2.0) {
    qualityScore += 3;
    confirmations.push('RSI_OVERSOLD_VOLUME_SPIKE');
  } else if (avgRSI > 68 && avgVolumeSpike > 2.0) {
    qualityScore += 3;
    confirmations.push('RSI_OVERBOUGHT_VOLUME_SPIKE');
  }
  
  // Stochastic экстремумы
  if (avgStoch < 20) {
    qualityScore += 2;
    confirmations.push('STOCH_DEEP_OVERSOLD');
  } else if (avgStoch > 80) {
    qualityScore += 2;
    confirmations.push('STOCH_DEEP_OVERBOUGHT');
  }
  
  // Сильный тренд
  if (avgADX > 40) {
    qualityScore += 2;
    confirmations.push('STRONG_TREND_MOMENTUM');
  }
  
  // Выравнивание трендов
  if (trendAlignment.bullish >= 2) {
    qualityScore += 2;
    confirmations.push('BULLISH_MULTITF_ALIGNMENT');
  } else if (trendAlignment.bearish >= 2) {
    qualityScore += 2;
    confirmations.push('BEARISH_MULTITF_ALIGNMENT');
  }
  
  // Объемный спрейк
  if (avgVolumeSpike > 3.0) {
    qualityScore += 2;
    confirmations.push('VOLUME_SPIKE_300%');
  } else if (avgVolumeSpike > 2.0) {
    qualityScore += 1;
    confirmations.push('VOLUME_SPIKE_200%');
  }
  
  // Импульс
  const momentum = timeframeData['5m'].momentum1h;
  if (Math.abs(momentum) > 5) {
    qualityScore += 1;
    confirmations.push(momentum > 0 ? 'STRONG_UPSIDE_MOMENTUM' : 'STRONG_DOWNSIDE_MOMENTUM');
  }
  
  // Определение сигнала
  let signal = null;
  let confidence = 0;
  
  // LONG сигнал (строгие условия для хайп пар)
  if (avgRSI < 35 && avgStoch < 25 && trendAlignment.bullish >= 2 && avgVolumeSpike > 1.8) {
    signal = 'LONG';
    confidence = Math.min(97, 65 + (35 - avgRSI) * 2 + confirmations.length * 4 + (hypeScore / 10));
  }
  // SHORT сигнал
  else if (avgRSI > 65 && avgStoch > 75 && trendAlignment.bearish >= 2 && avgVolumeSpike > 1.8) {
    signal = 'SHORT';
    confidence = Math.min(97, 65 + (avgRSI - 65) * 2 + confirmations.length * 4 + (hypeScore / 10));
  }
  
  if (!signal || confidence < 75) return null;
  
  // Расчет цен с адаптивным ATR
  const atr = timeframeData['5m'].atr;
  const volatilityMultiplier = hypeScore > 80 ? 2.5 : 2.0; // Больший стоп для высоко-волатильных
  
  let entry, tp, sl, rrRatio;
  
  if (signal === 'LONG') {
    entry = currentPrice;
    sl = entry - (atr * volatilityMultiplier);
    tp = entry + (atr * (volatilityMultiplier * 3)); // RR 1:3
    rrRatio = (tp - entry) / (entry - sl);
  } else {
    entry = currentPrice;
    sl = entry + (atr * volatilityMultiplier);
    tp = entry - (atr * (volatilityMultiplier * 3));
    rrRatio = (entry - tp) / (sl - entry);
  }
  
  if (rrRatio < CONFIG.premium.rrRatio) return null;
  
  // Ликвидационная цена
  const liqPrice = signal === 'LONG' ? sl * 0.99 : sl * 1.01;
  
  // Funding rate
  const fundingRate = getFundingRate(symbol);
  
  // Определение уровня
  const isGodTier = 
    qualityScore >= CONFIG.godTier.qualityScore &&
    confidence >= CONFIG.godTier.confidence &&
    rrRatio >= CONFIG.godTier.rrRatio &&
    confirmations.length >= CONFIG.godTier.confirmations;
  
  const isPremium = 
    qualityScore >= CONFIG.premium.qualityScore &&
    confidence >= CONFIG.premium.confidence &&
    rrRatio >= CONFIG.premium.rrRatio &&
    confirmations.length >= CONFIG.premium.confirmations;
  
  if (!isGodTier && !isPremium) return null;
  
  // Анализ тренда для комментария
  const trendMomentum = timeframeData['5m'].momentum4h > 10 ? 'STRONG_UP' : 
                       timeframeData['5m'].momentum4h < -10 ? 'STRONG_DOWN' : 'CONSOLIDATION';
  
  return {
    pair: symbol,
    signal,
    entry: parseFloat(entry.toFixed(8)),
    tp: parseFloat(tp.toFixed(8)),
    sl: parseFloat(sl.toFixed(8)),
    confidence: Math.round(confidence),
    qualityScore,
    rrRatio: parseFloat(rrRatio.toFixed(2)),
    tier: isGodTier ? 'GOD TIER' : 'PREMIUM',
    timeframe: 'MULTI-TF',
    leverage: CONFIG.leverage,
    positionSize: CONFIG.positionSize,
    liqPrice: parseFloat(liqPrice.toFixed(8)),
    fundingRate: fundingRate,
    hypeScore: hypeScore,
    trendMomentum: trendMomentum,
    indicators: {
      rsi: Math.round(avgRSI),
      stochK: parseFloat(avgStoch.toFixed(2)),
      adx: Math.round(avgADX),
      atr: parseFloat(atr.toFixed(8)),
      volumeChange: Math.round(avgVolumeSpike * 100),
      priceChange1h: parseFloat(timeframeData['5m'].momentum1h.toFixed(2)),
      priceChange4h: parseFloat(timeframeData['5m'].momentum4h.toFixed(2))
    },
    confirmations,
    timestamp: new Date()
  };
}

function analyzeTrendAlignment(timeframeData) {
  let bullish = 0;
  let bearish = 0;
  
  for (const [tf, data] of Object.entries(timeframeData)) {
    if (data.ema20 > data.ema50 && data.ema50 > data.ema100) {
      bullish++;
    } else if (data.ema20 < data.ema50 && data.ema50 < data.ema100) {
      bearish++;
    }
  }
  
  return { bullish, bearish };
}

// ==================== МЕГА ВИЗУАЛ ДЛЯ ХАЙП СИГНАЛОВ ====================
async function sendSignalToTelegram(signal) {
  if (!CHAT_ID) {
    console.log('⚠️ CHAT_ID не установлен. Сигнал не отправлен.');
    return false;
  }
  
  try {
    const tierEmoji = signal.tier === 'GOD TIER' ? '🔥' : '⚡';
    const directionEmoji = signal.signal === 'LONG' ? '🟢' : '🔴';
    const directionText = signal.signal === 'LONG' ? 'LONG' : 'SHORT';
    
    const timestamp = signal.timestamp.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
    
    // Профессиональный комментарий для хайп пар
    const comment = generateHypeComment(signal);
    
    const message = `
${tierEmoji} <b>${signal.tier} HYPE SIGNAL</b> ${tierEmoji}

${directionEmoji} <b>${directionText} ${signal.pair}</b> | ${signal.timeframe}
⭐ <b>Hype Score:</b> ${signal.hypeScore}/100

🎯 <b>ENTRY:</b> <code>${signal.entry}</code>
🏹 <b>TP:</b> <code>${signal.tp}</code> 
🛑 <b>SL:</b> <code>${signal.sl}</code>

📊 <b>R:R Ratio:</b> 1:${signal.rrRatio}
💪 <b>Confidence:</b> ${signal.confidence}%
🏆 <b>Quality:</b> ${signal.qualityScore}/10

⚙️ <b>Leverage:</b> ${signal.leverage}x
💰 <b>Position:</b> ${signal.positionSize}%
💀 <b>Liq Price:</b> ${signal.liqPrice}
📈 <b>Funding:</b> ${(signal.fundingRate * 100).toFixed(4)}%

<b>TECHNICALS:</b>
• RSI: ${signal.indicators.rsi}
• Stoch: ${signal.indicators.stochK}  
• ADX: ${signal.indicators.adx}
• ATR: ${signal.indicators.atr}
• Volume: +${signal.indicators.volumeChange}%
• 1h Change: ${signal.indicators.priceChange1h}%
• 4h Change: ${signal.indicators.priceChange4h}%

<b>CONFIRMATIONS:</b>
${signal.confirmations.map(conf => `✅ ${conf}`).join('\n')}

💡 <b>Analysis:</b> <i>${comment}</i>

⏰ <b>${timestamp}</b>
    `.trim();
    
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log(`✅ Хайп сигнал ${signal.pair} отправлен!`);
    return true;
  } catch (error) {
    console.error('❌ Ошибка отправки:', error.message);
    return false;
  }
}

function generateHypeComment(signal) {
  const comments = [];
  
  if (signal.hypeScore >= 90) {
    comments.push('Экстремальный хайп');
  } else if (signal.hypeScore >= 80) {
    comments.push('Высокий хайп');
  } else {
    comments.push('Хороший хайп');
  }
  
  if (signal.indicators.volumeChange > 300) {
    comments.push('взрывной объем');
  } else if (signal.indicators.volumeChange > 200) {
    comments.push('сильный объем');
  }
  
  if (signal.indicators.priceChange1h > 5) {
    comments.push('резкий рост');
  } else if (signal.indicators.priceChange1h < -5) {
    comments.push('резкое падение');
  }
  
  if (signal.trendMomentum === 'STRONG_UP') {
    comments.push('мощный аптренд');
  } else if (signal.trendMomentum === 'STRONG_DOWN') {
    comments.push('мощный даунтренд');
  }
  
  if (signal.confirmations.includes('VOLUME_SPIKE_300%')) {
    comments.push('институциональный интерес');
  }
  
  return comments.join(', ') + '. Идеально для скальпинга!';
}

// ==================== ОСНОВНАЯ ЛОГИКА ====================
async function generateSignals() {
  console.log('🔍 Поиск хайп сигналов...');
  
  const hypePairs = await getHypePairs();
  const signals = [];
  
  for (const pair of hypePairs) {
    try {
      console.log(`📊 Анализ ${pair}...`);
      
      const multiTFData = await analyzeMultiTimeframe(pair);
      if (!multiTFData || Object.keys(multiTFData).length === 0) continue;
      
      // Получаем hype score для этой пары
      const pairHypeScore = await getPairHypeScore(pair);
      
      const signal = generateHypeSignal(pair, multiTFData, pairHypeScore);
      if (signal) {
        signals.push(signal);
        console.log(`✅ Хайп сигнал для ${pair}: ${signal.signal} (${signal.confidence}%)`);
        
        if (signals.length >= CONFIG.maxSignalsPerRun) break;
      }
      
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (error) {
      console.error(`❌ Ошибка анализа ${pair}:`, error.message);
    }
  }
  
  console.log(`✅ Найдено ${signals.length} хайп сигналов`);
  return signals.sort((a, b) => b.confidence - a.confidence);
}

async function getPairHypeScore(symbol) {
  try {
    const url = `${CONFIG.binanceUrl}/ticker/24hr`;
    const response = await axios.get(url);
    const ticker = response.data.find(t => t.symbol === symbol);
    
    if (!ticker) return 50;
    
    const priceChange = Math.abs(parseFloat(ticker.priceChangePercent));
    const volume = parseFloat(ticker.volume);
    const high = parseFloat(ticker.highPrice);
    const low = parseFloat(ticker.lowPrice);
    const volatility = ((high - low) / low) * 100;
    
    return Math.min(100, (priceChange * 2) + (volatility * 2) + (volume / 10000000));
  } catch (error) {
    return 50;
  }
}

// ==================== CRON ЗАДАЧА ====================
async function runSignalsTask() {
  console.log('\n🔄 === HYPE PAIRS SCANNER ===');
  console.log(`⏰ ${new Date().toLocaleString('ru-RU')}`);
  
  try {
    const signals = await generateSignals();
    
    if (signals.length === 0) {
      console.log('ℹ️ Хайп сигналов не найдено');
      return;
    }
    
    console.log(`📤 Отправка ${signals.length} хайп сигналов...`);
    
    for (const signal of signals) {
      await sendSignalToTelegram(signal);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log('✅ Сканирование хайп пар завершено\n');
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
  }
}

// ==================== ЗАПУСК ====================
async function start() {
  try {
    await bot.telegram.deleteWebhook();
    console.log('✅ Webhook удален');
    
    const botInfo = await bot.telegram.getMe();
    console.log(`✅ Бот @${botInfo.username} запущен`);
    
    bot.launch();
    console.log('✅ Long polling активирован');
    
    // Сканирование каждые 10 минут
    cron.schedule('*/10 * * * *', runSignalsTask);
    console.log('✅ CRON настроен (каждые 10 минут)');
    
    // Первый запуск через 20 секунд
    console.log('⏳ Первое сканирование хайп пар через 20 секунд...\n');
    setTimeout(runSignalsTask, 20000);
    
  } catch (error) {
    console.error('❌ Ошибка запуска:', error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ЗАПУСК
start();
