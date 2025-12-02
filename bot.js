import { Telegraf } from 'telegraf';
import axios from 'axios';
import cron from 'node-cron';
import { HttpsProxyAgent } from 'https-proxy-agent';

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
  // Ваш прокси с авторизацией
  PROXY_URL: 'http://14db7c2b55cdd:4693eb6dd0@141.226.244.38:12323',
  
  // Альтернативные API эндпоинты
  apiEndpoints: [
    'https://api.bybit.com',
    'https://api.bytick.com',
    'https://api-testnet.bybit.com'
  ],
  currentEndpointIndex: 0,
  
  // Настройки сканирования
  category: 'spot',
  timeframe: '15',
  topGainers: 25,
  topLosers: 25,
  min24hVolume: 100000,      // 100K USDT
  stopLossPercent: 1.5,
  takeProfitPercent: 3.0,
  minRRRatio: 2.5,
  minConfidence: 55,
  minConfirmations: 2,
  
  // Настройки запросов
  retryAttempts: 3,
  retryDelay: 2000
};

// ==================== УТИЛИТЫ ====================
function getCurrentEndpoint() {
  return CONFIG.apiEndpoints[CONFIG.currentEndpointIndex];
}

function rotateEndpoint() {
  CONFIG.currentEndpointIndex = (CONFIG.currentEndpointIndex + 1) % CONFIG.apiEndpoints.length;
  console.log(`🔄 Смена API endpoint на: ${getCurrentEndpoint()}`);
  return getCurrentEndpoint();
}

// Создаем прокси агент с вашими данными
const proxyAgent = new HttpsProxyAgent(CONFIG.PROXY_URL);

async function makeBybitRequest(url, params = {}) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= CONFIG.retryAttempts; attempt++) {
    try {
      const endpoint = getCurrentEndpoint();
      const fullUrl = `${endpoint}${url}`;
      
      console.log(`📡 Попытка ${attempt}/${CONFIG.retryAttempts}: ${fullUrl}`);
      console.log(`🌐 Используется прокси: 141.226.244.38:12323`);
      
      const config = {
        params,
        timeout: 20000,
        httpsAgent: proxyAgent,
        httpAgent: proxyAgent,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      };
      
      const response = await axios.get(fullUrl, config);
      
      console.log('📊 Ответ API:', {
        retCode: response.data?.retCode,
        retMsg: response.data?.retMsg,
        listCount: response.data?.result?.list?.length || 0
      });
      
      if (response.data?.retCode === 0) {
        console.log(`✅ Успешный запрос к ${endpoint}`);
        return response.data;
      } else {
        const errorMsg = response.data?.retMsg || 'Unknown API error';
        console.log(`⚠️ API вернул ошибку: ${errorMsg}`);
        lastError = new Error(`API Error: ${errorMsg}`);
      }
      
    } catch (error) {
      lastError = error;
      console.error(`❌ Ошибка запроса (попытка ${attempt}):`, error.message);
      
      if (error.response) {
        console.error(`❌ Статус: ${error.response.status}`);
        if (error.response.status === 403 || error.response.status === 429) {
          // При блокировке меняем endpoint
          rotateEndpoint();
        }
      } else if (error.code === 'ECONNREFUSED') {
        console.error('❌ Прокси недоступен');
      }
      
      // Если это не последняя попытка, ждем
      if (attempt < CONFIG.retryAttempts) {
        console.log(`⏳ Повтор через ${CONFIG.retryDelay/1000} сек...`);
        await new Promise(resolve => setTimeout(resolve, CONFIG.retryDelay));
      }
    }
  }
  
  throw lastError || new Error('Не удалось выполнить запрос');
}

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

const bot = new Telegraf(BOT_TOKEN);

// ==================== КОМАНДЫ БОТА ====================
bot.start((ctx) => {
  console.log('📱 Получена команда /start от:', ctx.from.id);
  const welcomeMessage = `🤖 <b>Bybit Scalper Bot v5.0</b>

🎯 <b>Активные индикаторы:</b>
• EMA (9, 21, 50) - Тренд
• RSI (14) - Перекупленность/перепроданность
• MACD (12, 26, 9) - Импульс
• Bollinger Bands (20, 2) - Волатильность
• Stochastic (14, 3, 3) - Моментум
• ATR (14) - Динамические стопы
• Volume Analysis - Объемы

📊 <b>Параметры сканирования:</b>
• Топ 25 растущих монет
• Топ 25 падающих монет
• Минимальный объем: ${(CONFIG.min24hVolume / 1000000).toFixed(2)}M USDT
• Минимум подтверждений: ${CONFIG.minConfirmations}
• R:R соотношение: 1:${CONFIG.minRRRatio}

🌐 <b>Используется прокси:</b>
✅ 141.226.244.38:12323

⏰ <b>Расписание:</b>
Автоматическое сканирование каждые 30 минут

🎖️ <b>Уровни сигналов:</b>
👑 GOD TIER - Уверенность ≥75%
💎 PREMIUM - Уверенность ≥55%

✅ Бот работает на Bybit Spot!`;

  ctx.reply(welcomeMessage, { parse_mode: 'HTML' });
});

bot.command('status', (ctx) => {
  console.log('📱 Получена команда /status от:', ctx.from.id);
  ctx.reply(
    `✅ <b>Бот активен</b>\n\n` +
    `📡 API Endpoint: ${getCurrentEndpoint()}\n` +
    `🌐 Прокси: 141.226.244.38:12323\n` +
    `⏰ Сканирование: каждые 30 минут\n` +
    `🎯 Следующий запуск через: ${getNextScanTime()}\n\n` +
    `📊 Параметры:\n` +
    `• Min Volume: ${(CONFIG.min24hVolume/1000000).toFixed(2)}M USDT\n` +
    `• Min R:R: 1:${CONFIG.minRRRatio}\n` +
    `• Min Confidence: ${CONFIG.minConfidence}%`,
    { parse_mode: 'HTML' }
  );
});

bot.command('test', async (ctx) => {
  console.log('📱 Получена команда /test от:', ctx.from.id);
  try {
    await ctx.reply('🧪 Тестирую подключение к Bybit через прокси...');
    
    const testData = await makeBybitRequest('/v5/market/tickers', {
      category: 'spot',
      limit: 3
    });
    
    if (testData.retCode === 0) {
      await ctx.reply(`✅ Успех! Подключение через прокси работает!`);
      await ctx.reply(`📊 Получено пар: ${testData.result.list?.length || 0}`);
      
      if (testData.result.list && testData.result.list.length > 0) {
        const sample = testData.result.list[0];
        await ctx.reply(
          `Пример пары:\n` +
          `Символ: ${sample.symbol}\n` +
          `Цена: $${sample.lastPrice}\n` +
          `Изменение 24h: ${(sample.price24hPcnt * 100).toFixed(2)}%\n` +
          `Объем: $${(parseFloat(sample.turnover24h) / 1000).toFixed(1)}K`
        );
      }
    } else {
      await ctx.reply(`⚠️ Bybit API вернул: ${testData.retMsg}`);
    }
    
  } catch (error) {
    console.error('❌ Ошибка теста:', error.message);
    await ctx.reply(`❌ Ошибка подключения: ${error.message}`);
  }
});

bot.command('proxy', (ctx) => {
  console.log('📱 Получена команда /proxy от:', ctx.from.id);
  ctx.reply(
    `🌐 <b>Текущие сетевые настройки:</b>\n\n` +
    `✅ <b>Прокси активен:</b>\n` +
    `IP: 141.226.244.38\n` +
    `Port: 12323\n` +
    `Username: 14db7c2b55cdd\n` +
    `Password: ********\n\n` +
    `📡 <b>API Endpoints:</b>\n` +
    `• ${CONFIG.apiEndpoints.join('\n• ')}\n\n` +
    `🔄 <b>Текущий:</b> ${getCurrentEndpoint()}`,
    { parse_mode: 'HTML' }
  );
});

bot.command('scan', async (ctx) => {
  console.log('📱 Получена команда /scan от:', ctx.from.id);
  try {
    await ctx.reply('🔍 Запускаю ручное сканирование через прокси...');
    await runSignalsTask(true);
  } catch (error) {
    console.error('❌ Ошибка ручного сканирования:', error);
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

function getNextScanTime() {
  const now = new Date();
  const minutes = now.getMinutes();
  const nextScan = 30 - (minutes % 30);
  return `${nextScan} мин`;
}

// ==================== ПОЛУЧЕНИЕ ДАННЫХ ====================
async function getTopMovers() {
  try {
    console.log('📡 Запрос данных через прокси...');
    
    const response = await makeBybitRequest('/v5/market/tickers', {
      category: CONFIG.category
    });
    
    if (!response.result || !response.result.list) {
      console.error('❌ Нет данных в ответе');
      return [];
    }
    
    console.log(`✅ Получено ${response.result.list.length} пар`);
    
    // Фильтруем пары
    const usdtPairs = response.result.list.filter(pair => {
      if (!pair.symbol.endsWith('USDT')) return false;
      if (pair.symbol.includes('UP') || pair.symbol.includes('DOWN')) return false;
      if (pair.symbol.includes('BEAR') || pair.symbol.includes('BULL')) return false;
      
      const volume = parseFloat(pair.turnover24h) || 0;
      const price = parseFloat(pair.lastPrice) || 0;
      const change = parseFloat(pair.price24hPcnt) || 0;
      
      return volume >= CONFIG.min24hVolume && 
             price > 0.000001 && 
             Math.abs(change) > 0.001;
    });
    
    console.log(`✅ Отфильтровано ${usdtPairs.length} USDT пар`);
    
    const pairsWithChange = usdtPairs.map(pair => ({
      symbol: pair.symbol,
      change: (parseFloat(pair.price24hPcnt) || 0) * 100,
      volume: parseFloat(pair.turnover24h) || 0,
      price: parseFloat(pair.lastPrice) || 0
    }));
    
    // Сортируем по изменению
    const sorted = pairsWithChange.sort((a, b) => b.change - a.change);
    const topGainers = sorted.slice(0, CONFIG.topGainers);
    const topLosers = sorted.slice(-CONFIG.topLosers).reverse();
    
    if (topGainers.length > 0) {
      console.log(`📈 Топ роста: ${topGainers[0].symbol} +${topGainers[0].change.toFixed(2)}%`);
    }
    if (topLosers.length > 0) {
      console.log(`📉 Топ падения: ${topLosers[0].symbol} ${topLosers[0].change.toFixed(2)}%`);
    }
    
    return [...topGainers, ...topLosers];
  } catch (error) {
    console.error('❌ Ошибка получения данных:', error.message);
    return [];
  }
}

// ==================== АНАЛИЗ СИГНАЛА ====================
async function analyzeSignal(pair) {
  try {
    console.log(`🔍 Анализ: ${pair.symbol} (${pair.change > 0 ? '+' : ''}${pair.change.toFixed(2)}%)`);
    
    // Задержка для избежания лимитов
    await new Promise(resolve => setTimeout(resolve, 800));
    
    const candleResponse = await makeBybitRequest('/v5/market/kline', {
      category: CONFIG.category,
      symbol: pair.symbol,
      interval: CONFIG.timeframe,
      limit: 80
    });
    
    if (!candleResponse.result?.list || candleResponse.result.list.length < 50) {
      return null;
    }
    
    const candles = candleResponse.result.list;
    const reversedCandles = [...candles].reverse();
    
    const closes = reversedCandles.map(c => parseFloat(c[4]));
    const highs = reversedCandles.map(c => parseFloat(c[2]));
    const lows = reversedCandles.map(c => parseFloat(c[3]));
    const volumes = reversedCandles.map(c => parseFloat(c[5]));
    
    if (closes.length < 50) return null;
    
    const currentPrice = closes[closes.length - 1];
    
    // Индикаторы
    const rsi = calculateRSI(closes);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const macd = calculateMACD(closes);
    const bb = calculateBollingerBands(closes);
    const stoch = calculateStochastic(highs, lows, closes);
    const atr = calculateATR(highs, lows, closes);
    const volumeStrength = calculateVolumeStrength(volumes);
    
    // Подтверждения
    const confirmations = [];
    
    if (rsi < 35) confirmations.push('RSI_OVERSOLD');
    if (rsi > 65) confirmations.push('RSI_OVERBOUGHT');
    if (macd.histogram > 0) confirmations.push('MACD_BULLISH');
    if (macd.histogram < 0) confirmations.push('MACD_BEARISH');
    
    if (bb) {
      const bbPosition = (currentPrice - bb.lower) / (bb.upper - bb.lower) * 100;
      if (bbPosition < 25) confirmations.push('BB_OVERSOLD');
      if (bbPosition > 75) confirmations.push('BB_OVERBOUGHT');
    }
    
    if (stoch.k < 25) confirmations.push('STOCH_OVERSOLD');
    if (stoch.k > 75) confirmations.push('STOCH_OVERBOUGHT');
    
    if (ema9 && ema21) {
      if (currentPrice > ema9 && ema9 > ema21) confirmations.push('UPTREND');
      if (currentPrice < ema9 && ema9 < ema21) confirmations.push('DOWNTREND');
    }
    
    if (volumeStrength > 1.3) confirmations.push('HIGH_VOLUME');
    
    if (confirmations.length < CONFIG.minConfirmations) {
      return null;
    }
    
    // Определяем сигнал
    let signal = null;
    let confidence = 0;
    
    const bullishCount = confirmations.filter(c => 
      ['RSI_OVERSOLD', 'MACD_BULLISH', 'BB_OVERSOLD', 'STOCH_OVERSOLD', 'UPTREND'].includes(c)
    ).length;
    
    const bearishCount = confirmations.filter(c => 
      ['RSI_OVERBOUGHT', 'MACD_BEARISH', 'BB_OVERBOUGHT', 'STOCH_OVERBOUGHT', 'DOWNTREND'].includes(c)
    ).length;
    
    if (bullishCount >= 3 && pair.change > -5) {
      signal = 'LONG';
      confidence = Math.min(70 + bullishCount * 5 + (pair.change > 0 ? 5 : 0), 90);
    } else if (bearishCount >= 3 && pair.change < 5) {
      signal = 'SHORT';
      confidence = Math.min(70 + bearishCount * 5 + (pair.change < 0 ? 5 : 0), 90);
    }
    
    if (!signal || confidence < CONFIG.minConfidence) {
      return null;
    }
    
    // Рассчитываем уровни
    const entry = currentPrice;
    let sl, tp, rrRatio;
    
    if (signal === 'LONG') {
      sl = entry * (1 - CONFIG.stopLossPercent / 100);
      const risk = entry - sl;
      tp = entry + (risk * CONFIG.minRRRatio);
      rrRatio = (tp - entry) / (entry - sl);
    } else {
      sl = entry * (1 + CONFIG.stopLossPercent / 100);
      const risk = sl - entry;
      tp = entry - (risk * CONFIG.minRRRatio);
      rrRatio = (entry - tp) / (sl - entry);
    }
    
    if (rrRatio < CONFIG.minRRRatio) {
      return null;
    }
    
    const tier = confidence >= 75 ? 'GOD TIER' : 
                 confidence >= 65 ? 'PREMIUM' : 
                 'STANDARD';
    
    console.log(`✅ СИГНАЛ: ${tier} ${signal} ${pair.symbol} (${confidence}%)`);
    
    return {
      pair: pair.symbol.replace('USDT', '/USDT'),
      signal,
      entry: parseFloat(entry.toFixed(6)),
      tp: parseFloat(tp.toFixed(6)),
      sl: parseFloat(sl.toFixed(6)),
      confidence: Math.round(confidence),
      rrRatio: parseFloat(rrRatio.toFixed(2)),
      tier,
      exchange: 'BYBIT',
      change24h: parseFloat(pair.change.toFixed(2)),
      volume24h: pair.volume,
      indicators: {
        rsi: Math.round(rsi),
        macd_hist: parseFloat(macd.histogram.toFixed(4)),
        stoch_k: stoch.k,
        bb_position: bb ? parseFloat(((currentPrice - bb.lower) / (bb.upper - bb.lower) * 100).toFixed(1)) : null,
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

// ==================== ГЕНЕРАЦИЯ СИГНАЛОВ ====================
async function generateSignals() {
  try {
    console.log('\n🎯 НАЧАЛО СКАНИРОВАНИЯ');
    console.log('='.repeat(60));
    console.log(`⏰ ${new Date().toLocaleString('ru-RU')}`);
    console.log(`🌐 Endpoint: ${getCurrentEndpoint()}`);
    console.log(`🔧 Прокси: 141.226.244.38:12323`);
    console.log('='.repeat(60));
    
    const topMovers = await getTopMovers();
    if (topMovers.length === 0) {
      console.log('❌ Нет данных для анализа');
      return [];
    }
    
    console.log(`📊 Анализ ${topMovers.length} пар...`);
    
    const signals = [];
    
    for (let i = 0; i < topMovers.length; i++) {
      const pair = topMovers[i];
      const signal = await analyzeSignal(pair);
      if (signal) {
        signals.push(signal);
      }
      
      // Задержка между запросами
      if (i < topMovers.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    // Сортируем по уверенности
    signals.sort((a, b) => b.confidence - a.confidence);
    
    console.log('='.repeat(60));
    console.log(`📊 РЕЗУЛЬТАТЫ: ${signals.length} сигналов`);
    signals.forEach((s, i) => {
      console.log(`${i + 1}. ${s.tier} ${s.signal} ${s.pair} (${s.confidence}%, R:R 1:${s.rrRatio})`);
    });
    console.log('='.repeat(60));
    
    return signals.slice(0, 5); // Не более 5 сигналов
  } catch (error) {
    console.error('❌ Ошибка генерации сигналов:', error);
    return [];
  }
}

// ==================== ОТПРАВКА СИГНАЛОВ ====================
async function sendSignalToTelegram(signal) {
  if (!CHAT_ID) {
    console.log('⚠️  CHAT_ID не установлен');
    return false;
  }
  
  try {
    const profitPercent = signal.signal === 'LONG' 
      ? ((signal.tp / signal.entry - 1) * 100).toFixed(2)
      : ((1 - signal.tp / signal.entry) * 100).toFixed(2);
    
    const lossPercent = signal.signal === 'LONG'
      ? ((1 - signal.sl / signal.entry) * 100).toFixed(2)
      : ((signal.sl / signal.entry - 1) * 100).toFixed(2);
    
    const emoji = signal.tier === 'GOD TIER' ? '👑' : '💎';
    
    const message = `
${emoji} <b>${signal.tier} SIGNAL</b>

${signal.signal === 'LONG' ? '🟢' : '🔴'} <b>${signal.signal} ${signal.pair}</b>

📈 <b>24h Change:</b> ${signal.change24h > 0 ? '+' : ''}${signal.change24h}%
💰 <b>24h Volume:</b> $${(signal.volume24h / 1000000).toFixed(2)}M

🎯 <b>Entry:</b> ${signal.entry}
✅ <b>Take Profit:</b> ${signal.tp} (<b>+${profitPercent}%</b>)
🛑 <b>Stop Loss:</b> ${signal.sl} (<b>-${lossPercent}%</b>)

📊 <b>R:R Ratio:</b> 1:${signal.rrRatio}
🔮 <b>Confidence:</b> ${signal.confidence}%

<b>📉 ИНДИКАТОРЫ:</b>
• RSI: ${signal.indicators.rsi}
• MACD Hist: ${signal.indicators.macd_hist}
• Stoch K: ${signal.indicators.stoch_k}
• BB Position: ${signal.indicators.bb_position}%
• Volume: x${signal.indicators.volume_strength}

<b>✅ ПОДТВЕРЖДЕНИЯ:</b>
${signal.confirmations.slice(0, 6).map(c => `• ${c.replace(/_/g, ' ')}`).join('\n')}

⏰ ${signal.timestamp.toLocaleTimeString('ru-RU', {hour: '2-digit', minute:'2-digit'})}
🏦 <b>Exchange: BYBIT SPOT</b>
    `.trim();
    
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log(`✅ Отправлен сигнал: ${signal.pair}`);
    return true;
  } catch (error) {
    console.error('❌ Ошибка отправки:', error.message);
    return false;
  }
}

// ==================== ОСНОВНАЯ ЗАДАЧА ====================
async function runSignalsTask(isManual = false) {
  if (!isManual) {
    console.log('\n' + '█'.repeat(60));
    console.log('🔄 АВТОМАТИЧЕСКОЕ СКАНИРОВАНИЕ');
    console.log(`⏰ ${new Date().toLocaleString('ru-RU')}`);
    console.log('█'.repeat(60));
  }
  
  try {
    const signals = await generateSignals();
    
    if (signals.length === 0) {
      console.log('ℹ️  Сигналов не найдено');
      
      if (CHAT_ID && isManual) {
        await bot.telegram.sendMessage(
          CHAT_ID,
          `ℹ️ <b>Сканирование завершено</b>\n\n` +
          `Сигналов не найдено\n\n` +
          `⏰ ${new Date().toLocaleTimeString('ru-RU')}`,
          { parse_mode: 'HTML' }
        );
      }
      return;
    }
    
    console.log(`📤 Отправка ${signals.length} сигналов...`);
    
    for (const signal of signals) {
      await sendSignalToTelegram(signal);
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    
    console.log(`✅ Сканирование завершено`);
    
  } catch (error) {
    console.error('❌ Ошибка сканирования:', error);
  }
}

// ==================== ЗАПУСК БОТА ====================
async function start() {
  try {
    console.log('\n🔄 Инициализация бота...');
    
    console.log('\n' + '█'.repeat(60));
    console.log('🤖 BYBIT SCALPER BOT v5.0');
    console.log('🌐 С ПРОКСИ ПОДКЛЮЧЕНИЕМ');
    console.log('█'.repeat(60));
    console.log('');
    console.log('📊 КОНФИГУРАЦИЯ:');
    console.log(`   • Прокси: 141.226.244.38:12323`);
    console.log(`   • Endpoint: ${getCurrentEndpoint()}`);
    console.log(`   • Min Volume: ${(CONFIG.min24hVolume/1000000).toFixed(2)}M USDT`);
    console.log(`   • Min R:R: 1:${CONFIG.minRRRatio}`);
    console.log('');
    console.log('⏰ РАСПИСАНИЕ: каждые 30 минут');
    console.log('📱 КОМАНДЫ: /start, /test, /scan, /status, /proxy');
    console.log('█'.repeat(60));
    console.log('');
    
    // Запускаем Telegram бота
    await bot.launch({ dropPendingUpdates: true });
    console.log('✅ Telegram бот запущен');
    
    if (CHAT_ID) {
      try {
        await bot.telegram.sendMessage(
          CHAT_ID,
          `🚀 <b>Bybit Scalper Bot v5.0 запущен!</b>\n\n` +
          `🌐 <b>Используется прокси:</b>\n` +
          `IP: 141.226.244.38\n` +
          `Порт: 12323\n\n` +
          `📊 <b>Параметры:</b>\n` +
          `• Объем > ${(CONFIG.min24hVolume/1000000).toFixed(2)}M USDT\n` +
          `• R:R > 1:${CONFIG.minRRRatio}\n` +
          `• Confidence > ${CONFIG.minConfidence}%\n\n` +
          `⏰ <b>Первое сканирование через 1 минуту</b>\n\n` +
          `📱 Команды: /test /scan /status`,
          { parse_mode: 'HTML' }
        );
        console.log('✅ Стартовое сообщение отправлено');
      } catch (error) {
        console.error('❌ Ошибка отправки:', error.message);
      }
    }
    
    // Планировщик
    cron.schedule('*/30 * * * *', () => {
      console.log(`\n⏰ Запуск по расписанию: ${new Date().toLocaleString('ru-RU')}`);
      runSignalsTask(false);
    });
    
    console.log('⏳ Первое сканирование через 1 минуту...');
    
    setTimeout(() => {
      console.log(`\n🎯 Первое сканирование: ${new Date().toLocaleString('ru-RU')}`);
      runSignalsTask(false);
    }, 60000);
    
  } catch (error) {
    console.error('❌ Ошибка запуска:', error.message);
    process.exit(1);
  }
}

// Обработчики
process.once('SIGINT', () => {
  console.log('\n⚠️  Остановка бота...');
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('\n⚠️  Остановка бота...');
  bot.stop('SIGTERM');
  process.exit(0);
});

start();
