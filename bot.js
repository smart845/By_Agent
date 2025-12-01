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

// Бот
const bot = new Telegraf(BOT_TOKEN);

// Команды
bot.start((ctx) => {
  ctx.reply(`🤖 Crypto Signals Bot\nChat ID: <code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' });
});

bot.command('chatid', (ctx) => {
  ctx.reply(`Chat ID: <code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' });
});

bot.command('scan', async (ctx) => {
  ctx.reply('🔍 Сканирую...');
  await runSignalsTask();
});

bot.command('test', async (ctx) => {
  const testSignal = {
    pair: 'TEST/USDT',
    signal: 'LONG',
    entry: 100,
    tp: 110,
    sl: 95,
    confidence: 85,
    rsi: 25,
    exchange: 'BINANCE',
    timestamp: new Date()
  };
  await sendSignal(testSignal);
  ctx.reply('✅ Тест отправлен');
});

// ==================== ПРОСТЕЙШАЯ ЛОГИКА ====================

// 1. Получаем топ монет с Binance
async function getTopCoins() {
  try {
    console.log('📡 Получаю монеты с Binance...');
    
    // Просто берем все тикеры
    const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr', {
      timeout: 10000
    });
    
    // Берем первые 100 USDT пар с объемом > 1M
    const topCoins = response.data
      .filter(ticker => 
        ticker.symbol.endsWith('USDT') &&
        parseFloat(ticker.volume) > 1000000 &&
        parseFloat(ticker.lastPrice) > 0.0001
      )
      .slice(0, 100)
      .map(ticker => ({
        symbol: ticker.symbol,
        price: parseFloat(ticker.lastPrice),
        volume: parseFloat(ticker.volume),
        change24h: parseFloat(ticker.priceChangePercent),
        high: parseFloat(ticker.highPrice),
        low: parseFloat(ticker.lowPrice)
      }));
    
    console.log(`✅ Получено ${topCoins.length} монет`);
    return topCoins;
    
  } catch (error) {
    console.error('❌ Ошибка получения монет:', error.message);
    return [];
  }
}

// 2. Получаем свечи для монеты
async function getCandles(symbol) {
  try {
    const response = await axios.get('https://api.binance.com/api/v3/klines', {
      params: {
        symbol: symbol,
        interval: '1h',
        limit: 100
      },
      timeout: 5000
    });
    
    // Берем только цены закрытия
    return response.data.map(candle => parseFloat(candle[4]));
  } catch (error) {
    return null;
  }
}

// 3. Рассчитываем RSI (упрощенный)
function calculateRSI(prices) {
  if (prices.length < 15) return 50;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = 1; i <= 14; i++) {
    const change = prices[prices.length - i] - prices[prices.length - i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

// 4. Ищем сигналы (ОЧЕНЬ ПРОСТАЯ ЛОГИКА)
async function findSignals(coins) {
  const signals = [];
  
  // Проверяем только первые 30 монет для скорости
  const coinsToCheck = coins.slice(0, 30);
  
  for (const coin of coinsToCheck) {
    try {
      const prices = await getCandles(coin.symbol);
      if (!prices || prices.length < 50) continue;
      
      const rsi = calculateRSI(prices);
      const currentPrice = coin.price;
      
      // ПРОСТЫЕ ПРАВИЛА:
      // 1. Если RSI < 35 -> LONG
      // 2. Если RSI > 65 -> SHORT
      // 3. Если цена упала >10% за 24ч -> потенциал LONG
      // 4. Если цена выросла >10% за 24ч -> потенциал SHORT
      
      let signal = null;
      let confidence = 0;
      
      if (rsi < 35) {
        signal = 'LONG';
        confidence = 60 + (35 - rsi);
      } else if (rsi > 65) {
        signal = 'SHORT';
        confidence = 60 + (rsi - 65);
      } else if (coin.change24h < -10) {
        signal = 'LONG';
        confidence = 55 + Math.abs(coin.change24h) / 2;
      } else if (coin.change24h > 10) {
        signal = 'SHORT';
        confidence = 55 + coin.change24h / 2;
      }
      
      if (signal && confidence > 50) {
        // Простой расчет TP/SL
        const atr = Math.abs(prices[prices.length - 1] - prices[prices.length - 2]) || currentPrice * 0.02;
        let tp, sl;
        
        if (signal === 'LONG') {
          sl = currentPrice * 0.97;
          tp = currentPrice * 1.06;
        } else {
          sl = currentPrice * 1.03;
          tp = currentPrice * 0.94;
        }
        
        signals.push({
          pair: coin.symbol.replace('USDT', '/USDT'),
          symbol: coin.symbol.replace('USDT', ''),
          signal,
          entry: currentPrice,
          tp,
          sl,
          confidence: Math.min(95, Math.round(confidence)),
          rsi: Math.round(rsi),
          change24h: coin.change24h,
          volume: Math.round(coin.volume / 1000000), // в миллионах
          exchange: 'BINANCE',
          timestamp: new Date()
        });
        
        console.log(`✅ Сигнал: ${coin.symbol} ${signal} ${confidence}%`);
      }
      
      // Пауза между запросами
      await new Promise(resolve => setTimeout(resolve, 200));
      
    } catch (error) {
      // Пропускаем ошибки
      continue;
    }
  }
  
  return signals;
}

// 5. Отправка сигнала в Telegram
async function sendSignal(signal) {
  if (!CHAT_ID) {
    console.log('⚠️ Нет CHAT_ID');
    return;
  }
  
  try {
    const emoji = signal.signal === 'LONG' ? '🟢' : '🔴';
    const changeEmoji = signal.change24h > 0 ? '📈' : '📉';
    
    const message = `
${emoji} <b>${signal.signal} ${signal.pair}</b>

💰 Цена: $${signal.entry.toFixed(6)}
${changeEmoji} 24ч: ${signal.change24h.toFixed(2)}%
📊 Объем: $${signal.volume}M

🎯 Take Profit: $${signal.tp.toFixed(6)}
🛑 Stop Loss: $${signal.sl.toFixed(6)}

📉 RSI: ${signal.rsi}
📊 Уверенность: ${signal.confidence}%

🏦 Биржа: ${signal.exchange}
⏰ ${signal.timestamp.toLocaleTimeString('ru-RU')}
    `.trim();
    
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log(`📤 Отправлен: ${signal.pair}`);
    
  } catch (error) {
    console.error('❌ Ошибка отправки:', error.message);
  }
}

// ==================== ОСНОВНАЯ ЗАДАЧА ====================

async function runSignalsTask() {
  console.log('\n' + '='.repeat(50));
  console.log('🚀 ЗАПУСК СКАНИРОВАНИЯ');
  console.log('⏰', new Date().toLocaleTimeString('ru-RU'));
  
  try {
    // 1. Получаем монеты
    const coins = await getTopCoins();
    if (coins.length === 0) {
      console.log('❌ Нет монет');
      return;
    }
    
    // 2. Ищем сигналы
    console.log('🔍 Ищу сигналы...');
    const signals = await findSignals(coins);
    
    // 3. Отправляем
    if (signals.length === 0) {
      console.log('ℹ️ Сигналов не найдено');
      
      // Все равно отправляем сообщение
      if (CHAT_ID) {
        await bot.telegram.sendMessage(
          CHAT_ID,
          `🔍 Сканирование завершено\n⏰ ${new Date().toLocaleTimeString('ru-RU')}\n📊 Проверено: ${coins.length} монет\nℹ️ Сигналов не найдено\n🔄 Следующее: через 10 минут`,
          { parse_mode: 'HTML' }
        );
      }
      
    } else {
      console.log(`🎯 Найдено ${signals.length} сигналов`);
      
      // Сортируем по уверенности
      signals.sort((a, b) => b.confidence - a.confidence);
      
      // Отправляем общее сообщение
      if (CHAT_ID) {
        await bot.telegram.sendMessage(
          CHAT_ID,
          `🎯 НАЙДЕНО ${signals.length} СИГНАЛОВ\n🔥 Лучший: ${signals[0].pair} (${signals[0].confidence}%)\n📊 Всего монет: ${coins.length}\n${'='.repeat(30)}`,
          { parse_mode: 'HTML' }
        );
      }
      
      // Отправляем каждый сигнал
      for (const signal of signals.slice(0, 10)) { // Максимум 10
        await sendSignal(signal);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      console.log(`✅ Отправлено ${Math.min(signals.length, 10)} сигналов`);
    }
    
    console.log('='.repeat(50));
    
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    
    if (CHAT_ID) {
      await bot.telegram.sendMessage(
        CHAT_ID,
        `⚠️ Ошибка сканирования\n${error.message}`,
        { parse_mode: 'HTML' }
      );
    }
  }
}

// ==================== ЗАПУСК ====================

async function start() {
  try {
    console.log('🤖 Запуск бота...');
    
    await bot.telegram.deleteWebhook();
    bot.launch();
    
    console.log('✅ Бот запущен');
    
    // Запускаем сразу
    console.log('⏰ Первое сканирование через 3 секунды...');
    setTimeout(runSignalsTask, 3000);
    
    // И каждые 10 минут
    cron.schedule('*/10 * * * *', runSignalsTask);
    console.log('⏰ CRON: каждые 10 минут');
    
  } catch (error) {
    console.error('❌ Ошибка запуска:', error);
  }
}

// Выключение
process.once('SIGINT', () => {
  console.log('\n🛑 Выключение...');
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('\n🛑 Выключение...');
  bot.stop('SIGTERM');
  process.exit(0);
});

// Запускаем!
start();
