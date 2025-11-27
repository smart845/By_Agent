
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import cron from 'node-cron';
import { Telegraf } from 'telegraf';
import mongoose from 'mongoose';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files (index.html)
app.use(express.static(__dirname));

// Environment variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/byagent';
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

// Initialize Telegram Bot
const bot = TELEGRAM_BOT_TOKEN ? new Telegraf(TELEGRAM_BOT_TOKEN) : null;

if (bot) {
  console.log('Telegram bot initialized');
} else {
  console.log('Telegram bot NOT initialized, TELEGRAM_BOT_TOKEN is missing');
}

// === TELEGRAM WEBHOOK ROUTE ===
// Webhook, который мы уже указали в Telegram:
// https://by-agent.onrender.com/webhook
if (bot) {
  app.post('/webhook', (req, res) => {
    console.log('Telegram update received:', req.body);
    bot.handleUpdate(req.body);
    res.sendStatus(200);
  });

  // Если хочешь, можно и отсюда выставлять webhook автоматически:
  // const WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL || 'https://by-agent.onrender.com/webhook';
  // bot.telegram.setWebhook(WEBHOOK_URL)
  //   .then(() => console.log('Telegram webhook set to', WEBHOOK_URL))
  //   .catch(err => console.error('Error setting webhook:', err));
}

// MongoDB Models
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
  sentToTelegram: { type: Boolean, default: false }
});

const Signal = mongoose.model('Signal', SignalSchema);

// Конфигурация торговли
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

// Технические индикаторы (аналогично фронтенду)
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

// Улучшенная логика анализа
function analyzeGodTierSignal(coinData, priceHistory = []) {
  const currentPrice = coinData.current_price;
  const change1h = coinData.price_change_percentage_1h_in_currency || 0;
  const change24h = coinData.price_change_percentage_24h || 0;
  const volume = coinData.total_volume;
  const marketCap = coinData.market_cap;
  
  // Строгие фильтры
  if (volume < TRADING_CONFIG.minVolume) return null;
  if (marketCap < TRADING_CONFIG.minMarketCap) return null;
  if (priceHistory.length < 100) return null;
  
  // Расчет индикаторов
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
  
  // Система баллов и подтверждений
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
  
  if (sma20 > sma50 && ema12 > sma20) { 
    qualityScore += 1; confirmations.push('TREND_BULLISH'); 
  } else if (sma20 < sma50 && ema12 < sma20) { 
    qualityScore += 1; confirmations.push('TREND_BEARISH'); 
  }
  
  if (volume > TRADING_CONFIG.minVolume * 1.5) { 
    qualityScore += 1; confirmations.push('HIGH_VOLUME'); 
  }
  
  if (qualityScore < TRADING_CONFIG.minQualityScore || confirmations.length < TRADING_CONFIG.requiredConfirmations) {
    return null;
  }
  
  // Определение сигнала
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
  
  // Расчет точек входа
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

// Получение данных с CoinGecko
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

// Генерация сигналов
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
    
    // Сортировка по качеству
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

// Отправка в Telegram
async function sendToTelegram(signal) {
  if (!bot || !TELEGRAM_CHAT_ID) {
    console.log('Telegram bot not configured');
    return;
  }

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
  `;

  try {
    await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, message);
    console.log(`Signal sent to Telegram: ${signal.pair}`);
    
    // Помечаем сигнал как отправленный
    await Signal.findOneAndUpdate(
      { pair: signal.pair, timestamp: signal.timestamp },
      { sentToTelegram: true },
      { upsert: true, new: true }
    );
  } catch (error) {
    console.error('Ошибка отправки в Telegram:', error.message);
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
    version: '1.0.0'
  });
});

app.post('/api/webhook', async (req, res) => {
  // Webhook для получения сигналов извне
  try {
    const signal = req.body;
    
    // Валидация сигнала
    if (!signal.pair || !signal.signal) {
      return res.status(400).json({ error: 'Invalid signal data' });
    }
    
    // Сохраняем сигнал в базу
    const newSignal = new Signal(signal);
    await newSignal.save();
    
    // Отправляем в Telegram
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

// Запуск сервера
async function startServer() {
  try {
    // Подключаемся к MongoDB
    if (MONGODB_URI) {
      await mongoose.connect(MONGODB_URI);
      console.log('Connected to MongoDB');
    }

    // Запускаем сервер
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 API available at http://localhost:${PORT}/api/signals`);
    });

    // ВАЖНО: bot.launch() больше не вызываем — работаем через webhook
    // if (bot) {
    //   await bot.launch();
    //   console.log('Telegram bot started');
    // }

    // Запускаем крон-задачи
    cron.schedule('*/2 * * * *', async () => {
      console.log('🔄 Generating signals...');
      try {
        const signals = await generateSignals();
        
        // Отправляем только GOD TIER сигналы в Telegram
        const godTierSignals = signals.filter(s => s.isGodTier);
        
        for (const signal of godTierSignals) {
          // Проверяем, не отправляли ли мы уже этот сигнал
          const existing = await Signal.findOne({
            pair: signal.pair,
            sentToTelegram: true,
            timestamp: { $gte: new Date(Date.now() - 30 * 60 * 1000) } // За последние 30 минут
          });
          
          if (!existing) {
            await sendToTelegram(signal);
            // Ждем 1 секунду между сообщениями
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
        
        console.log(`✅ Generated ${signals.length} signals, sent ${godTierSignals.length} to Telegram`);
      } catch (error) {
        console.error('❌ Error in cron job:', error);
      }
    });

    console.log('✅ Cron jobs scheduled');

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
