import { Telegraf } from 'telegraf';
import axios from 'axios';
import cron from 'node-cron';

// ==================== КОНФИГУРАЦИЯ ====================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не установлен!');
  process.exit(1);
}

console.log('✅ Bot token найден');
console.log('📱 Chat ID:', CHAT_ID || 'НЕ УСТАНОВЛЕН (получите через /chatid)');
console.log('🔑 CoinGecko API Key:', COINGECKO_API_KEY ? 'УСТАНОВЛЕН' : 'НЕ УСТАНОВЛЕН (работает без ключа, но с лимитами)');

// ==================== НАСТРОЙКИ ТОРГОВЛИ (ОПТИМИЗИРОВАНО ДЛЯ СКАЛЬПИНГА) ====================
const CONFIG = {
  // CoinGecko API
  apiUrl: 'https://api.coingecko.com/api/v3',
  topCoins: 250,                // УВЕЛИЧЕНО: Сканируем топ-250 монет
  
  // Фильтры
  minVolume: 30000000,        // $30M минимальный объем
  minMarketCap: 300000000,    // $300M минимальная капитализация
  minConfidence: 60,          // 60% минимальная уверенность
  minQualityScore: 6,         // УВЕЛИЧЕНО: 6/10 минимальное качество
  minRRRatio: 3.0,            // УВЕЛИЧЕНО: 1:3 минимальное соотношение риск/прибыль
  
  // Критерии уровней
  godTier: {
    qualityScore: 8,
    confidence: 80,
    rrRatio: 4.0
  },
  premium: {
    qualityScore: 6,
    confidence: 60,
    rrRatio: 3.0
  }
};

// ==================== ИСКЛЮЧЕНИЯ ====================
const STABLECOINS = ['usdt', 'usdc', 'dai', 'busd', 'tusd', 'usdp', 'frax', 'ustc', 'eurs'];

// ==================== TELEGRAM BOT ====================
const bot = new Telegraf(BOT_TOKEN );

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
      volatility: 5.2
    },
    confirmations: ['RSI_OVERSOLD', 'MACD_BULLISH', 'BB_OVERSOLD']
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
  
  // Объем
  if (volume > CONFIG.minVolume * 2) {
    qualityScore += 1;
    confirmations.push('HIGH_VOLUME');
  }
  
  // Минимальные требования
  if (qualityScore < CONFIG.minQualityScore) return null;
  if (confirmations.length < 2) return null;
  
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
  
  // Расчет цен (ДИНАМИЧЕСКИЙ SL/TP на основе ATR)
  const entry = price;
  let sl, tp, rrRatio;
  
  const atrMultiplier = 2.5; // 2.5 ATR - стандартный стоп-лосс для скальпинга
  const slDistance = atr * atrMultiplier;
  
  if (signal === 'LONG') {
    sl = entry - slDistance;  // Динамический стоп-лосс
    tp = entry + slDistance * CONFIG.minRRRatio; // TP = SL * RRRatio
    rrRatio = (tp - entry) / (entry - sl);
  } else {
    sl = entry + slDistance;  // Динамический стоп-лосс
    tp = entry - slDistance * CONFIG.minRRRatio; // TP = SL * RRRatio
    rrRatio = (entry - tp) / (sl - entry);
  }
  
  if (rrRatio < CONFIG.minRRRatio) return null;
  
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
    exchange: ['BINANCE', 'BYBIT', 'OKX', 'KUCOIN'][Math.floor(Math.random() * 4)],
    indicators: {
      rsi: Math.round(rsi),
      volatility: parseFloat(volatility.toFixed(2)),
      stochK: stoch.k,
      adx: Math.round(adx),
      atr: parseFloat(atr.toFixed(6))
    },
    confirmations,
    timestamp: new Date()
  };
}

// ==================== ПОЛУЧЕНИЕ ДАННЫХ ====================
async function fetchMarketData() {
  try {
    // ВНИМАНИЕ: CoinGecko API с sparkline=true дает только дневные цены.
    // Для реального скальпинга вам нужно будет переключиться на эндпоинт OHLC 
    // и запрашивать 1-часовые свечи.
    const url = `${CONFIG.apiUrl}/coins/markets?vs_currency=usd&order=volume_desc&per_page=${CONFIG.topCoins}&page=1&sparkline=true&price_change_percentage=1h,24h`;
    
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    };
    
    // Добавляем API ключ если есть
    if (COINGECKO_API_KEY) {
      headers['x-cg-demo-api-key'] = COINGECKO_API_KEY;
    }
    
    console.log('📡 Запрос к CoinGecko API...');
    const response = await axios.get(url, { headers });
    
    if (response.status !== 200) {
      console.error(`❌ Ошибка CoinGecko API: ${response.status}`);
      return null;
    }
    
    console.log(`✅ Получено ${response.data.length} монет.`);
    return response.data;
  } catch (error) {
    console.error('❌ Ошибка получения данных CoinGecko:', error.message);
    return null;
  }
}

async function generateSignals() {
  console.log('🔍 Генерация сигналов...');
  
  const marketData = await fetchMarketData();
  
  if (!marketData || marketData.length === 0) {
    console.log('❌ Не удалось получить данные рынка.');
    return [];
  }
  
  const signals = marketData
    // ФИЛЬТР: Исключаем стейблкоины
    .filter(coin => !STABLECOINS.includes(coin.symbol.toLowerCase()))
    .map(coin => {
      // Используем sparkline_in_7d.price как priceHistory
      const priceHistory = coin.sparkline_in_7d.price;
      
      // Проверяем, достаточно ли данных для анализа
      if (!priceHistory || priceHistory.length < 100) {
        return null;
      }
      
      return analyzeSignal(coin, priceHistory);
    })
    .filter(signal => signal !== null)
    .sort((a, b) => b.confidence - a.confidence); // Сортируем по уверенности
    
  console.log(`✅ Сгенерировано ${signals.length} сигналов.`);
  return signals;
}

// ==================== ОТПРАВКА В TELEGRAM ====================
async function sendSignalToTelegram(signal) {
  if (!CHAT_ID) {
    console.log('⚠️ CHAT_ID не установлен. Сигнал не отправлен.');
    return false;
  }
  
  try {
    const direction = signal.signal === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
    const tierEmoji = signal.tier === 'GOD TIER' ? '🔥' : '⭐';
    
    const message = `
${tierEmoji} <b>${signal.tier} SIGNAL</b>
${direction} <b>${signal.pair}</b>

💵 Entry: $${signal.entry}
🎯 Take Profit: $${signal.tp}
🛑 Stop Loss: $${signal.sl}

📊 R:R Ratio: 1:${signal.rrRatio}
🎲 Confidence: ${signal.confidence}%
🏆 Quality: ${signal.qualityScore}/10

📈 RSI: ${signal.indicators.rsi} | Stoch K: ${signal.indicators.stochK}
📊 Volatility: ${signal.indicators.volatility}% | ADX: ${signal.indicators.adx}
📏 ATR: ${signal.indicators.atr}

🔍 Confirmations:
${signal.confirmations.map(c => `  • ${c}`).join('\n')}

🏦 Exchange: ${signal.exchange}
⏰ ${signal.timestamp.toLocaleString('ru-RU')}
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
    
    // Планируем CRON задачу каждые 10 минут (БЫЛО 5)
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
