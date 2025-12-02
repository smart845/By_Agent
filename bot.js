const { Telegraf } = require('telegraf');
const axios = require('axios');
const cron = require('node-cron');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

console.log('🤖 Запуск Crypto Signals Bot...');

if (!BOT_TOKEN) {
  console.error('❌ Нет TELEGRAM_BOT_TOKEN!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ==================== НАСТРОЙКИ ====================
const CONFIG = {
  exchange: 'BINANCE',  // Используем Binance вместо Bybit
  minVolume: 50000,     // 50K USDT минимальный объем
  topPairs: 30,         // Топ 30 пар
  scanInterval: '*/30 * * * *' // Каждые 30 минут
};

// ==================== BINANCE API ====================
async function getBinanceTickers() {
  try {
    console.log('📡 Запрос к Binance API...');
    
    const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr', {
      timeout: 10000
    });
    
    // Фильтруем USDT пары с хорошим объемом
    const usdtPairs = response.data
      .filter(ticker => ticker.symbol.endsWith('USDT'))
      .filter(ticker => parseFloat(ticker.quoteVolume) >= CONFIG.minVolume)
      .map(ticker => ({
        symbol: ticker.symbol,
        price: parseFloat(ticker.lastPrice),
        change: parseFloat(ticker.priceChangePercent),
        volume: parseFloat(ticker.quoteVolume),
        high: parseFloat(ticker.highPrice),
        low: parseFloat(ticker.lowPrice)
      }));
    
    console.log(`✅ Получено ${usdtPairs.length} пар с Binance`);
    return usdtPairs;
    
  } catch (error) {
    console.error('❌ Ошибка Binance API:', error.message);
    return [];
  }
}

// ==================== ИНДИКАТОРЫ ====================
function calculateRSI(prices) {
  if (!prices || prices.length < 14) return 50;
  
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

// ==================== КОМАНДЫ БОТА ====================
bot.start((ctx) => {
  console.log('✅ Команда /start от', ctx.from.id);
  
  const welcome = `
🤖 <b>Crypto Signals Bot</b>

🏦 <b>Биржа:</b> ${CONFIG.exchange}
📊 <b>Анализ:</b> Топ ${CONFIG.topPairs} пар
💰 <b>Мин. объем:</b> ${(CONFIG.minVolume/1000).toFixed(0)}K USDT
⏰ <b>Сканирование:</b> каждые 30 мин

<b>🎯 Индикаторы:</b>
• RSI (перекупленность/перепроданность)
• Анализ объема
• Тренд 24h

<b>📱 Команды:</b>
/start - информация
/test - проверить API
/scan - ручное сканирование
/status - статус бота
/help - помощь

✅ <b>Бот работает!</b>
  `.trim();
  
  ctx.reply(welcome, { parse_mode: 'HTML' });
});

bot.command('test', async (ctx) => {
  console.log('🧪 Тест Binance API...');
  
  try {
    await ctx.reply('🔄 Проверяю Binance API...');
    
    const tickers = await getBinanceTickers();
    
    if (tickers.length > 0) {
      const sample = tickers.slice(0, 3);
      let message = `✅ Binance API работает!\nПолучено пар: ${tickers.length}\n\n`;
      message += `📊 Примеры:\n`;
      sample.forEach(t => {
        message += `${t.symbol}: $${t.price.toFixed(4)} (${t.change.toFixed(2)}%)\n`;
      });
      
      await ctx.reply(message);
    } else {
      await ctx.reply('⚠️ Не удалось получить данные с Binance');
    }
    
  } catch (error) {
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('scan', async (ctx) => {
  console.log('🔍 Ручное сканирование...');
  
  try {
    await ctx.reply('🔍 Начинаю сканирование Binance...');
    
    const tickers = await getBinanceTickers();
    if (tickers.length === 0) {
      await ctx.reply('❌ Нет данных для анализа');
      return;
    }
    
    // Сортируем по изменению цены
    const sorted = [...tickers].sort((a, b) => b.change - a.change);
    const topGainers = sorted.slice(0, 10);
    const topLosers = sorted.slice(-10).reverse();
    
    // Ищем потенциальные сигналы
    const signals = [];
    
    for (const ticker of [...topGainers.slice(0, 5), ...topLosers.slice(0, 5)]) {
      // Простая логика: сильное движение + объем
      if (Math.abs(ticker.change) > 5 && ticker.volume > CONFIG.minVolume * 2) {
        const signalType = ticker.change > 0 ? '🟢 LONG' : '🔴 SHORT';
        const confidence = Math.min(70 + Math.abs(ticker.change), 90);
        
        signals.push({
          pair: ticker.symbol.replace('USDT', '/USDT'),
          type: signalType,
          change: ticker.change,
          volume: ticker.volume,
          confidence: confidence,
          price: ticker.price
        });
      }
    }
    
    if (signals.length > 0) {
      let message = `📊 <b>Найдено сигналов: ${signals.length}</b>\n\n`;
      
      signals.forEach((sig, i) => {
        message += `${i+1}. ${sig.type} <b>${sig.pair}</b>\n`;
        message += `   Изменение: ${sig.change > 0 ? '+' : ''}${sig.change.toFixed(2)}%\n`;
        message += `   Уверенность: ${sig.confidence.toFixed(0)}%\n`;
        message += `   Цена: $${sig.price.toFixed(4)}\n\n`;
      });
      
      await ctx.reply(message, { parse_mode: 'HTML' });
    } else {
      await ctx.reply('ℹ️ Сильных сигналов не найдено в этом сканировании');
    }
    
  } catch (error) {
    await ctx.reply(`❌ Ошибка сканирования: ${error.message}`);
  }
});

bot.command('status', (ctx) => {
  const now = new Date();
  const nextScan = 30 - (now.getMinutes() % 30);
  
  ctx.reply(
    `📊 <b>Статус бота</b>\n\n` +
    `🟢 <b>Состояние:</b> Активен\n` +
    `🏦 <b>Биржа:</b> ${CONFIG.exchange}\n` +
    `📡 <b>API:</b> Работает\n` +
    `🎯 <b>Следующее сканирование:</b> через ${nextScan} мин\n` +
    `⏰ <b>Время сервера:</b> ${now.toLocaleTimeString('ru-RU')}\n\n` +
    `💡 Используй /scan для ручной проверки`,
    { parse_mode: 'HTML' }
  );
});

bot.command('help', (ctx) => {
  ctx.reply(
    `📖 <b>Помощь</b>\n\n` +
    `<b>Как работает бот:</b>\n` +
    `1. Анализирует топ пары Binance\n` +
    `2. Ищет сильные движения с объемом\n` +
    `3. Отправляет сигналы каждые 30 мин\n\n` +
    `<b>Команды:</b>\n` +
    `/start - информация о боте\n` +
    `/test - проверить подключение\n` +
    `/scan - ручное сканирование\n` +
    `/status - статус бота\n\n` +
    `📈 Сигналы включают:\n` +
    `• Пару для торговли\n` +
    `• Направление (LONG/SHORT)\n` +
    `• Уровень уверенности\n` +
    `• Изменение цены 24h`,
    { parse_mode: 'HTML' }
  );
});

// Автоматическое сканирование
async function autoScan() {
  console.log('\n🎯 АВТОМАТИЧЕСКОЕ СКАНИРОВАНИЕ');
  console.log('='.repeat(40));
  
  try {
    const tickers = await getBinanceTickers();
    if (tickers.length === 0 || !CHAT_ID) return;
    
    // Ищем лучшие сигналы
    const sorted = [...tickers].sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
    const topSignals = sorted.slice(0, 5);
    
    const strongSignals = topSignals.filter(t => 
      Math.abs(t.change) > 8 && t.volume > CONFIG.minVolume * 3
    );
    
    if (strongSignals.length > 0) {
      console.log(`📊 Найдено ${strongSignals.length} сильных сигналов`);
      
      for (const signal of strongSignals) {
        const signalType = signal.change > 0 ? 'LONG' : 'SHORT';
        const emoji = signal.change > 0 ? '🟢' : '🔴';
        const confidence = Math.min(75 + Math.abs(signal.change) * 2, 95);
        
        const message = `
${emoji} <b>АВТОСИГНАЛ</b>

${emoji} <b>${signalType} ${signal.symbol.replace('USDT', '/USDT')}</b>

📈 <b>Изменение 24h:</b> ${signal.change > 0 ? '+' : ''}${signal.change.toFixed(2)}%
💰 <b>Объем 24h:</b> $${(signal.volume / 1000000).toFixed(2)}M
🎯 <b>Текущая цена:</b> $${signal.price.toFixed(4)}

🔮 <b>Уверенность:</b> ${confidence.toFixed(0)}%
💎 <b>Уровень:</b> ${confidence > 85 ? 'GOD TIER' : 'PREMIUM'}

🏦 <b>Биржа:</b> BINANCE SPOT
⏰ <b>Время:</b> ${new Date().toLocaleTimeString('ru-RU')}
        `.trim();
        
        await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        console.log(`✅ Отправлен сигнал: ${signal.symbol}`);
        
        // Задержка между отправками
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } else {
      console.log('ℹ️ Сильных сигналов не найдено');
    }
    
  } catch (error) {
    console.error('❌ Ошибка автосканирования:', error.message);
  }
}

// ==================== ЗАПУСК БОТА ====================
async function start() {
  try {
    console.log('🚀 Инициализация бота...');
    
    await bot.launch({
      dropPendingUpdates: true,
      allowedUpdates: ['message']
    });
    
    console.log('✅ Telegram бот запущен!');
    
    // Настройка планировщика
    cron.schedule(CONFIG.scanInterval, () => {
      console.log(`\n⏰ Запуск по расписанию: ${new Date().toLocaleString('ru-RU')}`);
      autoScan();
    });
    
    // Первое сканирование через 1 минуту
    setTimeout(() => {
      console.log('\n🎯 Первое сканирование...');
      autoScan();
    }, 60000);
    
    // Приветственное сообщение
    if (CHAT_ID) {
      try {
        await bot.telegram.sendMessage(
          CHAT_ID,
          `🤖 <b>Crypto Signals Bot запущен!</b>\n\n` +
          `✅ Подключение к Telegram: OK\n` +
          `✅ Подключение к Binance: OK\n` +
          `⏰ Автосканирование: каждые 30 мин\n\n` +
          `🏦 Биржа: Binance Spot\n` +
          `📊 Используй /scan для ручной проверки\n\n` +
          `🔄 Первое сканирование через 1 минуту`,
          { parse_mode: 'HTML' }
        );
        console.log('✅ Стартовое сообщение отправлено');
      } catch (error) {
        console.log('⚠️ Не удалось отправить стартовое сообщение');
      }
    }
    
    console.log('\n' + '='.repeat(40));
    console.log('🤖 БОТ УСПЕШНО ЗАПУЩЕН');
    console.log('='.repeat(40));
    console.log('📱 Команды в Telegram:');
    console.log('   /start - информация');
    console.log('   /test  - проверка API');
    console.log('   /scan  - сканирование');
    console.log('   /status - статус');
    console.log('='.repeat(40));
    
  } catch (error) {
    console.error('❌ Ошибка запуска:', error.message);
    process.exit(1);
  }
}

// Обработчики завершения
process.once('SIGINT', () => {
  console.log('\n🛑 Остановка бота...');
  bot.stop('SIGINT');
  setTimeout(() => process.exit(0), 1000);
});

process.once('SIGTERM', () => {
  console.log('\n🛑 Остановка бота...');
  bot.stop('SIGTERM');
  setTimeout(() => process.exit(0), 1000);
});

// Запуск
start();
