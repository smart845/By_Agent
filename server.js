import express from 'express';
import cors from 'cors';
import axios from 'axios';
import cron from 'node-cron';
import { Telegraf } from 'telegraf';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/byagent';
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

// Debug environment variables
console.log('=== ENV VARIABLES ===');
console.log('TELEGRAM_BOT_TOKEN:', TELEGRAM_BOT_TOKEN ? `SET (length: ${TELEGRAM_BOT_TOKEN.length})` : 'MISSING');
// ИСПРАВЛЕНО: Убраны кавычки, которые вводили в заблуждение
console.log('TELEGRAM_CHAT_ID:', TELEGRAM_CHAT_ID ? TELEGRAM_CHAT_ID : 'MISSING');
console.log('MONGODB_URI:', MONGODB_URI ? 'SET' : 'MISSING');
console.log('=====================');

// Initialize Telegram Bot
let bot = null;
let botInfo = null;

if (TELEGRAM_BOT_TOKEN) {
  try {
    bot = new Telegraf(TELEGRAM_BOT_TOKEN);
    
    // Test bot connection and get info
    bot.telegram.getMe()
      .then(info => {
        botInfo = info;
        console.log(`✅ Bot connected: @${info.username} (${info.first_name})`);
        
        // Set up commands
        bot.start((ctx) => {
          const chatId = ctx.chat.id;
          const username = ctx.chat.username ? `@${ctx.chat.username}` : 'No username';
          const firstName = ctx.chat.first_name || 'Unknown';
          
          console.log(`💬 Start command received from chat ID: ${chatId}, User: ${firstName} ${username}`);
          
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
          ctx.reply(
            `💬 Your Chat ID: <code>${chatId}</code>\n\n` +
            `Use this in your environment variables:\n` +
            `<code>TELEGRAM_CHAT_ID=${chatId}</code>`,
            { parse_mode: 'HTML' }
          );
        });

        // Launch bot in webhook mode for Render
        const WEBHOOK_DOMAIN = process.env.RENDER_EXTERNAL_HOSTNAME || 'by-agent.onrender.com';
        const WEBHOOK_URL = `https://${WEBHOOK_DOMAIN}/webhook`;
        
        bot.telegram.setWebhook(WEBHOOK_URL)
          .then(() => console.log(`✅ Webhook set to: ${WEBHOOK_URL}`))
          .catch(err => console.error('❌ Webhook error:', err.message));

      })
      .catch(err => {
        console.error('❌ Bot connection failed:', err.message);
        bot = null;
      });
      
  } catch (error) {
    console.error('❌ Bot initialization failed:', error.message);
    bot = null;
  }
} else {
  console.log('❌ TELEGRAM_BOT_TOKEN not provided');
}

// Webhook route
if (bot) {
  app.post('/webhook', (req, res) => {
    console.log('📨 Telegram webhook received');
    bot.handleUpdate(req.body, res);
  });
}

// MongoDB Models (остается без изменений)
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
  telegramMessageId: String
});

const Signal = mongoose.model('Signal', SignalSchema);

// Конфигурация и индикаторы (остаются без изменений)
const TRADING_CONFIG = {
  baseUrl: 'https://api.coingecko.com/api/v3',
  vsCurrency: 'usd',
  topCoinsCount: 100,
  minVolume: 100000000,
  minMarketCap: 2000000000,
  minRRRatio: 4.5,
  targetWinRate: 0.30,
  minConfidence: 85,
  maxVolatility: 20,
  minQualityScore: 7,
  requiredConfirmations: 4
};

const EXCHANGES = ['BINANCE', 'BYBIT', 'KUCOIN', 'OKX', 'GATE', 'MEXC', 'HUOBI', 'BITGET'];

// [ВСЕ ФУНКЦИИ ИНДИКАТОРОВ ОСТАЮТСЯ БЕЗ ИЗМЕНЕНИЙ]
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
  return 100 - (100 / (1 + rs));
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
  if (prices.length < period) return { upper: null, middle: null, lower: null };
  
  const sma = calculateSMA(prices, period);
  const variance = prices.slice(-period).reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
  const standardDeviation = Math.sqrt(variance);
  
  return {
    upper: sma + (standardDeviation * stdDev),
    middle: sma,
    lower: sma - (standardDeviation * stdDev)
  };
}

function calculateStochastic(prices, period = 14) {
  if (prices.length < period) return { k: 50, d: 50 };
  
  const recentPrices = prices.slice(-period);
  const high = Math.max(...recentPrices);
  const low = Math.min(...recentPrices);
  
  const k = ((prices[prices.length - 1] - low) / (high - low)) * 100;
  const d = calculateSMA(prices.slice(-3).map((p, i, arr) => {
    const slice = arr.slice(Math.max(0, i - 2), i + 1);
    return ((p - Math.min(...slice)) / (Math.max(...slice) - Math.min(...slice))) * 100;
  }), 3) || k;
  
  return { k, d };
}

function calculateVolatility(prices, period = 20) {
  if (prices.length < period) return 0;
  
  const recentPrices = prices.slice(-period);
  const mean = recentPrices.reduce((a, b) => a + b, 0) / period;
  const variance = recentPrices.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  return Math.sqrt(variance) / mean * 100;
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
  
  return ((highest - current) / (highest - lowest)) * -100;
}

function analyzeGodTierSignal(coinData, priceHistory = []) {
  const currentPrice = coinData.current_price;
  const change1h = coinData.price_change_percentage_1h_in_currency || 0;
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
  
  if (rsi < 25) { qualityScore += 2; confirmations.push('RSI_OVERSOLD'); }
  else if (rsi > 75) { qualityScore += 2; confirmations.push('RSI_OVERBOUGHT'); }
  
  if (macd.histogram > 0 && macd.macd > macd.signal) { 
    qualityScore += 1; confirmations.push('MACD_BULLISH'); 
  } else if (macd.histogram < 0 && macd.macd < macd.signal) { 
    qualityScore += 1; confirmations.push('MACD_BEARISH'); 
  }
  
  if (currentPrice < bb.lower && rsi < 35) { 
    qualityScore += 2; confirmations.push('BB_OVERSOLD'); 
  } else if (currentPrice > bb.upper && rsi > 65) { 
    qualityScore += 2; confirmations.push('BB_OVERBOUGHT'); 
  }
  
  if (stoch.k < 20 && stoch.d < 20) { 
    qualityScore += 1; confirmations.push('STOCH_OVERSOLD'); 
  } else if (stoch.k > 80 && stoch.d > 80) { 
    qualityScore += 1; confirmations.push('STOCH_OVERBOUGHT'); 
  }
  
  if (williams < -80) { qualityScore += 1; confirmations.push('WILLIAMS_OVERSOLD'); }
  else if (williams > -20) { qualityScore += 1; confirmations.push('WILLIAMS_OVERBOUGHT'); }
  
  if (sma20 > sma50) { 
    qualityScore += 1; confirmations.push('TREND_BULLISH'); 
  } else if (sma20 < sma50) { 
    qualityScore += 1; confirmations.push('TREND_BEARISH'); 
  }
  
  if (volume > TRADING_CONFIG.minVolume * 1.5) { 
    qualityScore += 1; confirmations.push('HIGH_VOLUME'); 
  }
  
  if (qualityScore < TRADING_CONFIG.minQualityScore || confirmations.length < TRADING_CONFIG.requiredConfirmations) {
    return null;
  }
  
  let signal = null;
  let confidence = 0;
  
  if (rsi < 25 && macd.histogram > 0 && currentPrice < bb.lower && stoch.k < 20) {
    const trendStrength = sma20 > sma50 ? 1.3 : 0.9;
    confidence = Math.min(85 + (25 - rsi) * 2.5 * trendStrength, 98);
    signal = 'LONG';
  } else if (rsi > 75 && macd.histogram < 0 && currentPrice > bb.upper && stoch.k > 80) {
    const trendStrength = sma20 < sma50 ? 1.3 : 0.9;
    confidence = Math.min(85 + (rsi - 75) * 2.5 * trendStrength, 98);
    signal = 'SHORT';
  }
  
  if (!signal || confidence < TRADING_CONFIG.minConfidence) return null;
  
  const entryPrice = currentPrice;
  let stopLoss, takeProfit;
  let rrRatio = 0;
  
  if (signal === 'LONG') {
    stopLoss = entryPrice * (1 - Math.max(atr / entryPrice * 2.5, 0.025));
    takeProfit = entryPrice + (entryPrice - stopLoss) * TRADING_CONFIG.minRRRatio;
    rrRatio = (takeProfit - entryPrice) / (entryPrice - stopLoss);
  } else {
    stopLoss = entryPrice * (1 + Math.max(atr / entryPrice * 2.5, 0.025));
    takeProfit = entryPrice - (stopLoss - entryPrice) * TRADING_CONFIG.minRRRatio;
    rrRatio = (entryPrice - takeProfit) / (stopLoss - entryPrice);
  }
  
  if (rrRatio < TRADING_CONFIG.minRRRatio) return null;
  
  const isGodTier = qualityScore >= 9 && confidence >= 90 && rrRatio >= 5.0;
  
  return {
    pair: `${coinData.symbol.toUpperCase()}/USDT`,
    signal,
    currentPrice: currentPrice,
    entry: entryPrice,
    tp: takeProfit,
    sl: stopLoss,
    confidence: Math.round(confidence),
    exchange: EXCHANGES[Math.floor(Math.random() * EXCHANGES.length)],
    timestamp: new Date(),
    rrRatio: parseFloat(rrRatio.toFixed(2)),
    change24h: change24h,
    expectedWinRate: Math.round(TRADING_CONFIG.targetWinRate * 100),
    rsi: Math.round(rsi),
    volume: volume,
    volatility: parseFloat(volatility.toFixed(2)),
    atr: atr,
    qualityScore: qualityScore,
    confirmations: confirmations,
    isGodTier: isGodTier,
    isPremium: !isGodTier && qualityScore >= 7 && confidence >= 85 && rrRatio >= 4.5
  };
}

async function fetchMarketData() {
  try {
    const url = `${TRADING_CONFIG.baseUrl}/coins/markets` +
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
      if (coin.total_volume >= TRADING_CONFIG.minVolume && 
          coin.market_cap >= TRADING_CONFIG.minMarketCap) {
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

// Улучшенная отправка в Telegram
async function sendToTelegram(signal) {
  if (!bot || !TELEGRAM_CHAT_ID) {
    console.log('❌ Telegram not configured');
    return false;
  }

  try {
    // ИСПРАВЛЕНО: Более надежная обработка Chat ID
    const chatIdString = TELEGRAM_CHAT_ID.trim();
    
    // Проверяем, что chat_id числовой (или строка с числом)
    if (!/^-?\d+$/.test(chatIdString)) {
      console.error(`❌ Invalid TELEGRAM_CHAT_ID format: "${chatIdString}" - must be numeric`);
      return false;
    }
    
    // Явно преобразуем в число для надежности
    const chatId = parseInt(chatIdString, 10);

    const direction = signal.signal === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
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

    console.log(`📤 Sending to chat ID: ${chatId}`);
    
    const sentMessage = await bot.telegram.sendMessage(chatId, message);
    
    console.log(`✅ Signal sent to Telegram! Message ID: ${sentMessage.message_id}`);
    
    // Сохраняем в базу
    if (MONGODB_URI && MONGODB_URI !== 'mongodb://localhost:27017/byagent') {
      await Signal.findOneAndUpdate(
        { 
          pair: signal.pair, 
          timestamp: { 
            $gte: new Date(Date.now() - 10 * 60 * 1000)
          } 
        },
        { 
          sentToTelegram: true, 
          telegramMessageId: sentMessage.message_id,
          ...signal 
        },
        { 
          upsert: true, 
          new: true 
        }
      );
    }
    
    return true;
  } catch (error) {
    console.error('❌ Telegram send error:', error.message);
    if (error.response) {
      console.error('Telegram API Response:', error.response.data);
      
      // Specific error handling
      if (error.response?.data?.description === 'Bad Request: chat not found') {
        console.error('💡 SOLUTION:');
        console.error('1. Go to your bot in Telegram: https://t.me/' + (botInfo?.username || 'your_bot'));
        console.error('2. Send /start command');
        console.error('3. Get your chat ID with /chatid command');
        console.error('4. Update TELEGRAM_CHAT_ID environment variable in Render');
      }
    }
    return false;
  }
}

// API Routes
app.get('/api/signals', async (req, res) => {
  try {
    const signals = await generateSignals();
    res.json({
      success: true,
      data: signals,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
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
      bot_username: botInfo?.username || 'Not connected'
    }
  });
});

// Новый endpoint для получения chat_id
app.get('/api/get-chatid-instructions', (req, res) => {
  const botUsername = botInfo?.username || 'YOUR_BOT_USERNAME';
  
  res.json({
    instructions: [
      `1. Go to your bot: https://t.me/${botUsername}`,
      `2. Send /start command`,
      `3. Send /chatid command to get your Chat ID`,
      `4. Copy the numeric Chat ID`,
      `5. Set environment variable in Render: TELEGRAM_CHAT_ID=your_chat_id`,
      `6. Redeploy your application`
    ],
    current_chat_id: TELEGRAM_CHAT_ID || 'Not set',
    bot_username: botUsername
  });
});

// Тестовый endpoint для отправки сообщения
app.post('/api/test-telegram', async (req, res) => {
  if (!bot || !TELEGRAM_CHAT_ID) {
    return res.status(400).json({ 
      success: false, 
      error: 'Telegram not configured',
      details: {
        bot: !!bot,
        chat_id: !!TELEGRAM_CHAT_ID
      }
    });
  }

  try {
    const testMessage = {
      pair: 'TEST/USDT',
      signal: 'LONG',
      entry: 100.50,
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
      exchange: 'BINANCE'
    };

    console.log('🧪 Sending test message...');
    const success = await sendToTelegram(testMessage);
    
    if (success) {
      res.json({ 
        success: true, 
        message: 'Test message sent successfully to Telegram!' 
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: 'Failed to send test message - check logs for details' 
      });
    }
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.post('/api/webhook', async (req, res) => {
  try {
    const signal = req.body;
    
    if (!signal.pair || !signal.signal) {
      return res.status(400).json({ error: 'Invalid signal data' });
    }
    
    if (MONGODB_URI && MONGODB_URI !== 'mongodb://localhost:27017/byagent') {
      const newSignal = new Signal(signal);
      await newSignal.save();
    }
    
    await sendToTelegram(signal);
    
    res.json({ success: true, message: 'Signal processed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve index.html for root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Функция для выполнения cron-задачи
async function executeCronTask() {
  console.log('🔄 Generating signals...');
  try {
    const signals = await generateSignals();
    
    console.log(`📊 Found ${signals.length} total signals`);
    
    const signalsToSend = signals.filter(s => s.isGodTier || s.isPremium);
    console.log(`🎯 Filtered ${signalsToSend.length} signals to send`);
    
    let sentCount = 0;
    
    for (const signal of signalsToSend) {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      
      let existing = null;
      if (MONGODB_URI && MONGODB_URI !== 'mongodb://localhost:27017/byagent') {
        existing = await Signal.findOne({
          pair: signal.pair,
          sentToTelegram: true,
          timestamp: { $gte: tenMinutesAgo }
        });
      }
      
      if (!existing) {
        console.log(`📨 Sending signal: ${signal.pair} (${signal.signal})`);
        const success = await sendToTelegram(signal);
        if (success) {
          sentCount++;
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } else {
        console.log(`⏭️  Signal already sent: ${signal.pair}`);
      }
    }
    
    console.log(`✅ Generated ${signals.length} signals, sent ${sentCount} to Telegram`);
    
  } catch (error) {
    console.error('❌ Error in cron job:', error);
  }
}

// Запуск сервера
async function startServer() {
  try {
    // Подключаемся к MongoDB
    if (MONGODB_URI && MONGODB_URI !== 'mongodb://localhost:27017/byagent') {
      await mongoose.connect(MONGODB_URI);
      console.log('✅ Connected to MongoDB');
    } else {
      console.log('💡 MongoDB not connected - using in-memory storage');
    }

    // Запускаем сервер
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 API: https://by-agent.onrender.com/api/signals`);
      console.log(`🩺 Health: https://by-agent.onrender.com/api/health`);
      console.log(`💡 Chat ID Instructions: https://by-agent.onrender.com/api/get-chatid-instructions`);
      console.log(`🧪 Test Telegram: POST https://by-agent.onrender.com/api/test-telegram`);
    });

    // Запускаем крон-задачи
    cron.schedule('*/2 * * * *', executeCronTask);
    console.log('✅ Cron job scheduled every 2 minutes');

    // Первый запуск
    setTimeout(executeCronTask, 5000);

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  if (bot) {
    bot.stop();
  }
  await mongoose.connection.close();
  process.exit(0);
});

startServer();
