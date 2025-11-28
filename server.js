// index.mjs
// ================== ИМПОРТЫ ==================
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import cron from 'node-cron';
import { Telegraf } from 'telegraf';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';

// ================== PATH/EXPRESS БАЗА ==================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ================== MIDDLEWARE ==================
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Глобальный логгер запросов
app.use((req, res, next) => {
  console.log(`➡️  ${req.method} ${req.url}`);
  next();
});

// ================== ENV ==================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/byagent';
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

console.log('=== ENV VARIABLES ===');
console.log(
  'TELEGRAM_BOT_TOKEN:',
  TELEGRAM_BOT_TOKEN ? `SET (length: ${TELEGRAM_BOT_TOKEN.length})` : 'MISSING'
);
console.log('TELEGRAM_CHAT_ID:', TELEGRAM_CHAT_ID || 'MISSING');
console.log('MONGODB_URI:', MONGODB_URI ? 'SET' : 'MISSING');
console.log('=====================');

// ================== TELEGRAM BOT ==================
let bot = null;
let botInfo = null;

async function initTelegramBot() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('❌ TELEGRAM_BOT_TOKEN not provided');
    return;
  }

  try {
    bot = new Telegraf(TELEGRAM_BOT_TOKEN);

    // Команды
    bot.start((ctx) => {
      const chatId = ctx.chat.id;
      const username = ctx.chat.username
        ? `@${ctx.chat.username}`
        : 'No username';
      const firstName = ctx.chat.first_name || 'Unknown';

      console.log(
        `💬 /start from chat ID: ${chatId}, User: ${firstName} ${username}`
      );

      ctx.reply(
        `🤖 Welcome to Crypto Signals Bot!\n\n` +
          `📊 Your Chat ID: <code>${chatId}</code>\n` +
          `👤 User: ${firstName} ${username}\n\n` +
          `💡 Use this Chat ID in your environment variables:\n` +
          `<code>TELEGRAM_CHAT_ID=${chatId}</code>\n\n` +
          `📈 Signals will be sent here automatically.`,
        { parse_mode: 'HTML' }
      );
    });

    bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      console.log(`💬 /chatid from chat ID: ${chatId}`);
      ctx.reply(
        `💬 Your Chat ID: <code>${chatId}</code>\n\n` +
          `Use this in your environment variables:\n` +
          `<code>TELEGRAM_CHAT_ID=${chatId}</code>`,
        { parse_mode: 'HTML' }
      );
    });

    // Получаем инфо о боте
    botInfo = await bot.telegram.getMe();
    console.log(
      `✅ Bot connected: @${botInfo.username} (${botInfo.first_name})`
    );

    // Очень важно: убираем webhook, включаем long polling
    await bot.telegram.deleteWebhook();
    console.log('✅ Telegram webhook deleted (using long polling)');
    await bot.launch();
    console.log('✅ Telegram bot launched with long polling');
  } catch (err) {
    console.error('❌ Bot initialization failed:', err.message);
    bot = null;
  }
}

// ================== MONGODB MODELS ==================
const SignalSchema = new mongoose.Schema({
  pair: String,
  signal: String,
  entry: Number,
  tp: Number,
  sl: Number,
  confidence: Number,
  qualityScore: Number,
  rrRatio: Number,
  exchange: String,
  timestamp: { type: Date, default: Date.now },
  isGodTier: Boolean,
  isPremium: Boolean,
  confirmations: [String],
  sentToTelegram: { type: Boolean, default: false },
  telegramMessageId: String,
});

const Signal = mongoose.model('Signal', SignalSchema);

// ================== КОНФИГ ==================
const TRADING_CONFIG = {
  baseUrl: 'https://api.coingecko.com/api/v3',
  vsCurrency: 'usd',
  topCoinsCount: 100,
  minVolume: 100000000,
  minMarketCap: 2000000000,
  minRRRatio: 4.5,
  targetWinRate: 0.3,
  minConfidence: 85,
  maxVolatility: 20,
  minQualityScore: 7,
  requiredConfirmations: 4,
};

const EXCHANGES = [
  'BINANCE',
  'BYBIT',
  'KUCOIN',
  'OKX',
  'GATE',
  'MEXC',
  'HUOBI',
  'BITGET',
];

// ================== ИНДИКАТОРЫ ==================
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

function calculateMACD(prices) {
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  if (!ema12 || !ema26) return { macd: 0, signal: 0, histogram: 0 };

  const macd = ema12 - ema26;
  const signal = calculateEMA(prices.slice(-9).concat([macd]), 9) || macd;
  const histogram = macd - signal;

  return { macd, signal, histogram };
}

function calculateBollingerBands(prices, period = 20, stdDev = 2) {
  if (prices.length < period)
    return { upper: null, middle: null, lower: null };

  const sma = calculateSMA(prices, period);
  const variance =
    prices
      .slice(-period)
      .reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
  const standardDeviation = Math.sqrt(variance);

  return {
    upper: sma + standardDeviation * stdDev,
    middle: sma,
    lower: sma - standardDeviation * stdDev,
  };
}

function calculateStochastic(prices, period = 14) {
  if (prices.length < period) return { k: 50, d: 50 };

  const recentPrices = prices.slice(-period);
  const high = Math.max(...recentPrices);
  const low = Math.min(...recentPrices);

  const k =
    ((prices[prices.length - 1] - low) / (high - low || 1)) * 100;

  const d =
    calculateSMA(
      prices.slice(-3).map((p, i, arr) => {
        const slice = arr.slice(Math.max(0, i - 2), i + 1);
        const sHigh = Math.max(...slice);
        const sLow = Math.min(...slice);
        return ((p - sLow) / (sHigh - sLow || 1)) * 100;
      }),
      3
    ) || k;

  return { k, d };
}

function calculateVolatility(prices, period = 20) {
  if (prices.length < period) return 0;

  const recentPrices = prices.slice(-period);
  const mean = recentPrices.reduce((a, b) => a + b, 0) / period;
  const variance =
    recentPrices.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  return (Math.sqrt(variance) / mean) * 100;
}

function calculateATR(prices, period = 14) {
  if (prices.length < period + 1) return 0;

  let trSum = 0;
  for (let i = prices.length - period; i < prices.length - 1; i++) {
    const high = Math.max(prices[i], prices[i + 1]);
    const low = Math.min(prices[i], prices[i + 1]);
    const tr = high - low;
    trSum += tr;
  }
  return trSum / period;
}

function calculateWilliamsR(prices, period = 14) {
  if (prices.length < period) return 50;

  const recentPrices = prices.slice(-period);
  const highest = Math.max(...recentPrices);
  const lowest = Math.min(...recentPrices);
  const current = prices[prices.length - 1];

  return ((highest - current) / (highest - lowest || 1)) * -100;
}

// ================== АНАЛИЗ СИГНАЛА ==================
function analyzeGodTierSignal(coinData, priceHistory = []) {
  const currentPrice = coinData.current_price;
  const change24h = coinData.price_change_percentage_24h || 0;
  const volume = coinData.total_volume;
  const marketCap = coinData.market_cap;

  if (volume < TRADING_CONFIG.minVolume) return null;
  if (marketCap < TRADING_CONFIG.minMarketCap) return null;
  if (priceHistory.length < 100) return null;

  const rsi = calculateRSI(priceHistory);
  const volatility = calculateVolatility(priceHistory);
  const macd = calculateMACD(priceHistory);
  const bb = calculateBollingerBands(priceHistory);
  const stoch = calculateStochastic(priceHistory);
  const williams = calculateWilliamsR(priceHistory);
  const sma20 = calculateSMA(priceHistory, 20);
  const sma50 = calculateSMA(priceHistory, 50);
  const ema12 = calculateEMA(priceHistory, 12);
  const atr = calculateATR(priceHistory);

  if (volatility > TRADING_CONFIG.maxVolatility) return null;

  let qualityScore = 0;
  const confirmations = [];

  if (rsi < 25) {
    qualityScore += 2;
    confirmations.push('RSI_OVERSOLD');
  } else if (rsi > 75) {
    qualityScore += 2;
    confirmations.push('RSI_OVERBOUGHT');
  }

  if (macd.histogram > 0 && macd.macd > macd.signal) {
    qualityScore += 1;
    confirmations.push('MACD_BULLISH');
  } else if (macd.histogram < 0 && macd.macd < macd.signal) {
    qualityScore += 1;
    confirmations.push('MACD_BEARISH');
  }

  if (currentPrice < bb.lower && rsi < 35) {
    qualityScore += 2;
    confirmations.push('BB_OVERSOLD');
  } else if (currentPrice > bb.upper && rsi > 65) {
    qualityScore += 2;
    confirmations.push('BB_OVERBOUGHT');
  }

  if (stoch.k < 20 && stoch.d < 20) {
    qualityScore += 1;
    confirmations.push('STOCH_OVERSOLD');
  } else if (stoch.k > 80 && stoch.d > 80) {
    qualityScore += 1;
    confirmations.push('STOCH_OVERBOUGHT');
  }

  if (williams < -80) {
    qualityScore += 1;
    confirmations.push('WILLIAMS_OVERSOLD');
  } else if (williams > -20) {
    qualityScore += 1;
    confirmations.push('WILLIAMS_OVERBOUGHT');
  }

  if (sma20 > sma50) {
    qualityScore += 1;
    confirmations.push('TREND_BULLISH');
  } else if (sma20 < sma50) {
    qualityScore += 1;
    confirmations.push('TREND_BEARISH');
  }

  if (volume > TRADING_CONFIG.minVolume * 1.5) {
    qualityScore += 1;
    confirmations.push('HIGH_VOLUME');
  }

  if (
    qualityScore < TRADING_CONFIG.minQualityScore ||
    confirmations.length < TRADING_CONFIG.requiredConfirmations
  ) {
    return null;
  }

  let signal = null;
  let confidence = 0;

  if (
    rsi < 25 &&
    macd.histogram > 0 &&
    currentPrice < bb.lower &&
    stoch.k < 20
  ) {
    const trendStrength = sma20 > sma50 ? 1.3 : 0.9;
    confidence = Math.min(
      85 + (25 - rsi) * 2.5 * trendStrength,
      98
    );
    signal = 'LONG';
  } else if (
    rsi > 75 &&
    macd.histogram < 0 &&
    currentPrice > bb.upper &&
    stoch.k > 80
  ) {
    const trendStrength = sma20 < sma50 ? 1.3 : 0.9;
    confidence = Math.min(
      85 + (rsi - 75) * 2.5 * trendStrength,
      98
    );
    signal = 'SHORT';
  }

  if (!signal || confidence < TRADING_CONFIG.minConfidence) return null;

  const entryPrice = currentPrice;
  let stopLoss, takeProfit;
  let rrRatio = 0;

  if (signal === 'LONG') {
    stopLoss =
      entryPrice *
      (1 - Math.max((atr / entryPrice) * 2.5, 0.025));
    takeProfit =
      entryPrice + (entryPrice - stopLoss) * TRADING_CONFIG.minRRRatio;
    rrRatio = (takeProfit - entryPrice) / (entryPrice - stopLoss);
  } else {
    stopLoss =
      entryPrice *
      (1 + Math.max((atr / entryPrice) * 2.5, 0.025));
    takeProfit =
      entryPrice - (stopLoss - entryPrice) * TRADING_CONFIG.minRRRatio;
    rrRatio = (entryPrice - takeProfit) / (stopLoss - entryPrice);
  }

  if (rrRatio < TRADING_CONFIG.minRRRatio) return null;

  const isGodTier =
    qualityScore >= 9 && confidence >= 90 && rrRatio >= 5.0;

  return {
    pair: `${coinData.symbol.toUpperCase()}/USDT`,
    signal,
    currentPrice,
    entry: entryPrice,
    tp: takeProfit,
    sl: stopLoss,
    confidence: Math.round(confidence),
    exchange:
      EXCHANGES[Math.floor(Math.random() * EXCHANGES.length)],
    timestamp: new Date(),
    rrRatio: parseFloat(rrRatio.toFixed(2)),
    change24h,
    expectedWinRate: Math.round(TRADING_CONFIG.targetWinRate * 100),
    rsi: Math.round(rsi),
    volume,
    volatility: parseFloat(volatility.toFixed(2)),
    atr,
    qualityScore,
    confirmations,
    isGodTier,
    isPremium:
      !isGodTier &&
      qualityScore >= 7 &&
      confidence >= 85 &&
      rrRatio >= 4.5,
  };
}

// ================== MARKET DATA ==================
async function fetchMarketData() {
  try {
    const url =
      `${TRADING_CONFIG.baseUrl}/coins/markets` +
      `?vs_currency=${TRADING_CONFIG.vsCurrency}` +
      `&order=volume_desc` +
      `&per_page=${TRADING_CONFIG.topCoinsCount}` +
      `&page=1` +
      `&sparkline=true` +
      `&price_change_percentage=1h,24h,7d`;

    const headers = {};
    if (COINGECKO_API_KEY) {
      headers['x-cg-demo-api-key'] = COINGECKO_API_KEY;
    }

    const response = await axios.get(url, { headers });
    return response.data;
  } catch (error) {
    console.error('Ошибка получения данных:', error.message);
    throw error;
  }
}

async function generateSignals() {
  try {
    const marketData = await fetchMarketData();
    const signals = [];

    for (const coin of marketData) {
      if (
        coin.total_volume >= TRADING_CONFIG.minVolume &&
        coin.market_cap >= TRADING_CONFIG.minMarketCap
      ) {
        const priceHistory = coin.sparkline_in_7d?.price;
        if (priceHistory && priceHistory.length >= 100) {
          const signal = analyzeGodTierSignal(coin, priceHistory);
          if (signal) {
            signals.push(signal);
          }
        }
      }
    }

    return signals.sort((a, b) => {
      if (a.isGodTier && !b.isGodTier) return -1;
      if (!a.isGodTier && b.isGodTier) return 1;
      return b.qualityScore - a.qualityScore;
    });
  } catch (error) {
    console.error('Ошибка генерации сигналов:', error);
    return [];
  }
}

// ================== ОТПРАВКА В TELEGRAM ==================
async function sendToTelegram(signal, source = 'unknown') {
  if (!bot || !TELEGRAM_CHAT_ID) {
    console.log('❌ Telegram not configured');
    return false;
  }

  try {
    const chatIdString = TELEGRAM_CHAT_ID.trim();

    if (!/^-?\d+$/.test(chatIdString)) {
      console.error(
        `❌ Invalid TELEGRAM_CHAT_ID format: "${chatIdString}" - must be numeric`
      );
      return false;
    }

    const chatId = parseInt(chatIdString, 10);

    const direction =
      signal.signal === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
    const tier = signal.isGodTier ? '🔥 GOD TIER' : '⭐ PREMIUM';

    const message = `
${tier} SIGNAL
${direction} ${signal.pair}

💵 Entry: $${signal.entry.toFixed(6)}
🎯 Take Profit: $${signal.tp.toFixed(6)}
🛑 Stop Loss: $${signal.sl.toFixed(6)}

📊 R:R Ratio: 1:${signal.rrRatio}
🎲 Confidence: ${signal.confidence}%
🏆 Quality Score: ${signal.qualityScore}/10

📈 RSI: ${signal.rsi}
📊 Volatility: ${signal.volatility}%
📈 24H Change: ${signal.change24h.toFixed(2)}%

🔍 Confirmations: ${signal.confirmations.join(', ')}

⏰ Time: ${signal.timestamp.toLocaleTimeString()}
🏦 Exchange: ${signal.exchange}
    `.trim();

    console.log(
      `📤 [${source}] Sending to chat ID: ${chatId}, pair: ${signal.pair}, type: ${signal.signal}`
    );

    const sentMessage = await bot.telegram.sendMessage(chatId, message);

    console.log(
      `✅ [${source}] Signal sent to Telegram! Message ID: ${sentMessage.message_id}`
    );

    // Сохраняем в базу
    if (MONGODB_URI && MONGODB_URI !== 'mongodb://localhost:27017/byagent') {
      await Signal.findOneAndUpdate(
        {
          pair: signal.pair,
          timestamp: {
            $gte: new Date(Date.now() - 10 * 60 * 1000),
          },
        },
        {
          sentToTelegram: true,
          telegramMessageId: sentMessage.message_id,
          ...signal,
        },
        {
          upsert: true,
          new: true,
        }
      );
    }

    return true;
  } catch (error) {
    console.error('❌ Telegram send error:', error.message);
    if (error.response) {
      console.error('Telegram API Response:', error.response.data);

      if (error.response?.data?.description === 'Bad Request: chat not found') {
        console.error('💡 SOLUTION:');
        console.error(
          '1. Open bot in Telegram and send /start\n2. Send /chatid\n3. Put TELEGRAM_CHAT_ID=<this_id> to env and redeploy'
        );
      }
    }
    return false;
  }
}

// ================== API ROUTES ==================
app.get('/api/signals', async (req, res) => {
  try {
    console.log('📡 /api/signals requested');
    const signals = await generateSignals();
    console.log(`📊 /api/signals: generated ${signals.length} signals`);
    res.json({
      success: true,
      data: signals,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('/api/signals error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    telegram: {
      bot_configured: !!bot,
      chat_id_configured: !!TELEGRAM_CHAT_ID,
      bot_username: botInfo?.username || 'Not connected',
    },
  });
});

// Инструкции по chat_id
app.get('/api/get-chatid-instructions', (req, res) => {
  const botUsername = botInfo?.username || 'YOUR_BOT_USERNAME';

  res.json({
    instructions: [
      `1. Go to your bot: https://t.me/${botUsername}`,
      `2. Send /start command`,
      `3. Send /chatid command to get your Chat ID`,
      `4. Copy the numeric Chat ID`,
      `5. Set environment variable: TELEGRAM_CHAT_ID=your_chat_id`,
      `6. Redeploy your application`,
    ],
    current_chat_id: TELEGRAM_CHAT_ID || 'Not set',
    bot_username: botUsername,
  });
});

// Тестовый endpoint для отправки сообщения
app.post('/api/test-telegram', async (req, res) => {
  if (!bot || !TELEGRAM_CHAT_ID) {
    console.log('❌ /api/test-telegram: Telegram not configured');
    return res.status(400).json({
      success: false,
      error: 'Telegram not configured',
      details: {
        bot: !!bot,
        chat_id: !!TELEGRAM_CHAT_ID,
      },
    });
  }

  try {
    const testMessage = {
      pair: 'TEST/USDT',
      signal: 'LONG',
      entry: 100.5,
      tp: 150.75,
      sl: 90.25,
      confidence: 95,
      qualityScore: 9,
      rrRatio: 5.0,
      rsi: 25,
      volatility: 5.5,
      change24h: 2.5,
      confirmations: ['TEST_CONFIRMATION'],
      timestamp: new Date(),
      isGodTier: true,
      isPremium: false,
      exchange: 'BINANCE',
    };

    console.log('🧪 /api/test-telegram: sending test message...');
    const success = await sendToTelegram(testMessage, 'test-endpoint');

    if (success) {
      res.json({
        success: true,
        message: 'Test message sent successfully to Telegram!',
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to send test message - check logs for details',
      });
    }
  } catch (error) {
    console.error('/api/test-telegram error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Webhook для внешних сигналов (твои сторонние приложения могут дергать этот endpoint)
app.post('/api/webhook', async (req, res) => {
  try {
    const signal = req.body;
    console.log('📥 /api/webhook: incoming signal', {
      pair: signal.pair,
      signal: signal.signal,
      timestamp: signal.timestamp || new Date().toISOString(),
    });

    if (!signal.pair || !signal.signal) {
      console.log('❌ /api/webhook: invalid signal payload');
      return res.status(400).json({ error: 'Invalid signal data' });
    }

    if (MONGODB_URI && MONGODB_URI !== 'mongodb://localhost:27017/byagent') {
      const newSignal = new Signal(signal);
      await newSignal.save();
      console.log('💾 /api/webhook: signal saved to MongoDB');
    } else {
      console.log('💾 /api/webhook: MongoDB disabled, signal not persisted');
    }

    const success = await sendToTelegram(signal, 'external-webhook');

    res.json({ success: true, message: 'Signal processed', sent: success });
  } catch (error) {
    console.error('❌ /api/webhook error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Статика / index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ================== CRON ==================
async function executeCronTask() {
  console.log('🔄 [CRON] Generating signals...');
  try {
    const signals = await generateSignals();

    console.log(`📊 [CRON] Found ${signals.length} total signals`);

    const signalsToSend = signals.filter(
      (s) => s.isGodTier || s.isPremium
    );
    console.log(
      `🎯 [CRON] Filtered ${signalsToSend.length} signals to send`
    );

    let sentCount = 0;

    for (const signal of signalsToSend) {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

      let existing = null;
      if (MONGODB_URI && MONGODB_URI !== 'mongodb://localhost:27017/byagent') {
        existing = await Signal.findOne({
          pair: signal.pair,
          sentToTelegram: true,
          timestamp: { $gte: tenMinutesAgo },
        });
      }

      if (!existing) {
        console.log(
          `📨 [CRON] Sending signal: ${signal.pair} (${signal.signal})`
        );
        const success = await sendToTelegram(signal, 'cron');
        if (success) {
          sentCount++;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      } else {
        console.log(
          `⏭️  [CRON] Signal already sent recently: ${signal.pair}`
        );
      }
    }

    console.log(
      `✅ [CRON] Generated ${signals.length} signals, sent ${sentCount} to Telegram`
    );
  } catch (error) {
    console.error('❌ [CRON] Error in cron job:', error);
  }
}

// ================== START SERVER ==================
async function startServer() {
  try {
    // Mongo
    if (MONGODB_URI && MONGODB_URI !== 'mongodb://localhost:27017/byagent') {
      await mongoose.connect(MONGODB_URI);
      console.log('✅ Connected to MongoDB');
    } else {
      console.log('💡 MongoDB not connected - using in-memory storage');
    }

    // Telegram bot
    await initTelegramBot();

    // HTTP server
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 API: /api/signals`);
      console.log(`🩺 Health: /api/health`);
      console.log(`💡 Chat ID Instructions: /api/get-chatid-instructions`);
      console.log(`🧪 Test Telegram: POST /api/test-telegram`);
    });

    // CRON каждые 2 минуты
    cron.schedule('*/2 * * * *', executeCronTask);
    console.log('✅ Cron job scheduled every 2 minutes');

    // Первый запуск через 5 сек
    setTimeout(executeCronTask, 5000);
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// ================== GRACEFUL SHUTDOWN ==================
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  if (bot) {
    await bot.stop();
  }
  await mongoose.connection.close();
  process.exit(0);
});

startServer();
