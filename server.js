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

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/byagent';
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

const bot = TELEGRAM_BOT_TOKEN ? new Telegraf(TELEGRAM_BOT_TOKEN) : null;
if (!bot) console.log("Telegram BOT NOT INITIALIZED!");

/* ============================================
   🔵  TELEGRAM WEBHOOK (ОСНОВНОЕ ИЗМЕНЕНИЕ)
   ============================================ */
if (bot) {
  app.post('/webhook', (req, res) => {
    bot.handleUpdate(req.body);
    res.sendStatus(200);
  });
}

// ==== Mongoose model ====
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

/* === Indicators omitted here for brevity — I keep them ALL unchanged === */
/* === EVERYTHING FROM INDICATORS TO fetchMarketData(), analyzeGodTierSignal(), generateSignals() — COPY EXACTLY YOUR ORIGINAL CODE === */
/* === I DO NOT MODIFY ANY ANALYTICS, ONLY TELEGRAM-SENDING === */

/* --------------- Отправка в Telegram --------------- */
async function sendToTelegram(signal) {
  if (!bot || !TELEGRAM_CHAT_ID) return;

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

    await Signal.findOneAndUpdate(
      { pair: signal.pair, timestamp: signal.timestamp },
      { sentToTelegram: true },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error("Telegram send error:", err.message);
  }
}

/* ============================================
   🔁 API
   ============================================ */
app.get('/api/signals', async (req, res) => {
  try {
    const signals = await generateSignals();
    res.json({ success: true, data: signals });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/webhook', async (req, res) => {
  try {
    if (!req.body.pair) return res.status(400).json({ error: "Invalid signal" });

    const s = new Signal(req.body);
    await s.save();
    await sendToTelegram(req.body);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ============================================
   🚀 START SERVER + CRON
   ============================================ */
async function startServer() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("MongoDB connected");

    app.listen(PORT, '0.0.0.0', () => {
      console.log("Server running on port", PORT);
    });

    /* ============================================
       🟡  ВАЖНО: bot.launch() УДАЛЁН
       ============================================ */

    /* ============================================
       🔥 CRON — ОТПРАВЛЯЕМ ВСЕ СИГНАЛЫ
       ============================================ */
    cron.schedule("*/2 * * * *", async () => {
      console.log("🔄 Generating signals...");
      try {
        const signals = await generateSignals();

        /* ❗ Отправляем ВСЕ СИГНАЛЫ, а не только GodTier */
        for (const signal of signals) {
          const exists = await Signal.findOne({
            pair: signal.pair,
            sentToTelegram: true,
            timestamp: { $gte: new Date(Date.now() - 30 * 60000) }
          });

          if (!exists) {
            await sendToTelegram(signal);
            await new Promise(r => setTimeout(r, 1000));
          }
        }

        console.log(`✔ Generated ${signals.length} signals, sent ${signals.length} to Telegram`);
      } catch (err) {
        console.error("Cron error:", err.message);
      }
    });

  } catch (err) {
    console.error("Startup failed:", err.message);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  console.log("Shutting down...");
  if (bot) bot.stop();
  await mongoose.connection.close();
  process.exit(0);
});

startServer();
