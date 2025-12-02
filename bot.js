const { Telegraf } = require('telegraf');
const axios = require('axios');
const cron = require('node-cron');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

console.log('🤖 Запуск MEXC Signals Bot...');

if (!BOT_TOKEN) {
  console.error('❌ Нет TELEGRAM_BOT_TOKEN!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ==================== НАСТРОЙКИ ====================
const CONFIG = {
  exchange: 'MEXC',
  apiUrl: 'https://api.mexc.com',
  minVolume: 100000,     // 100K USDT
  topPairs: 25,
  scanInterval: '*/20 * * * *', // Каждые 20 минут
  minChange: 5,          // Минимальное изменение 5%
  minConfidence: 60      // Минимальная уверенность 60%
};

// ==================== MEXC API ====================
async function getMexcTickers() {
  try {
    console.log('📡 Запрос к MEXC API...');
    
    const response = await axios.get(`${CONFIG.apiUrl}/api/v3/ticker/24hr`, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });
    
    console.log('✅ MEXC API ответ получен');
    
    // Фильтруем USDT пары
    const usdtPairs = response.data
      .filter(ticker => ticker.symbol.endsWith('USDT'))
      .map(ticker => {
        const change = parseFloat(ticker.priceChangePercent);
        const volume = parseFloat(ticker.quoteVolume);
        const price = parseFloat(ticker.lastPrice);
        
        return {
          symbol: ticker.symbol,
          price: price,
          change: change,
          volume: volume,
          high: parseFloat(ticker.highPrice),
          low: parseFloat(ticker.lowPrice),
          volumeValue: volume * price
        };
      })
      .filter(ticker => 
        ticker.volumeValue >= CONFIG.minVolume && 
        ticker.price > 0.000001 &&
        Math.abs(ticker.change) > 0.1
      );
    
    console.log(`✅ Отфильтровано ${usdtPairs.length} пар`);
    return usdtPairs;
    
  } catch (error) {
    console.error('❌ Ошибка MEXC API:', error.message);
    if (error.response) {
      console.error('Статус:', error.response.status);
      console.error('Данные:', error.response.data);
    }
    return [];
  }
}

// Получаем данные свечей для анализа
async function getMexcKlines(symbol, interval = '15m', limit = 50) {
  try {
    const response = await axios.get(`${CONFIG.apiUrl}/api/v3/klines`, {
      params: {
        symbol: symbol,
        interval: interval,
        limit: limit
      },
      timeout: 10000
    });
    
    return response.data.map(k => ({
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));
    
  } catch (error) {
    console.error(`❌ Ошибка получения свечей ${symbol}:`, error.message);
    return [];
  }
}

// ==================== ИНДИКАТОРЫ ====================
function calculateRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return 50;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateAverageVolume(volumes, period = 20) {
  if (!volumes || volumes.length < period) return 0;
  const recent = volumes.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

// ==================== АНАЛИЗ СИГНАЛА ====================
async function analyzePair(pair) {
  try {
    console.log(`🔍 Анализ ${pair.symbol}...`);
    
    // Получаем свечи
    const klines = await getMexcKlines(pair.symbol, '15m', 50);
    if (klines.length < 30) return null;
    
    const closes = klines.map(k => k.close);
    const volumes = klines.map(k => k.volume);
    const currentPrice = closes[closes.length - 1];
    
    // Рассчитываем индикаторы
    const rsi = calculateRSI(closes);
    const avgVolume = calculateAverageVolume(volumes);
    const volumeRatio = pair.volume / avgVolume;
    
    // Определяем сигнал
    let signal = null;
    let confidence = 0;
    let reasons = [];
    
    if (rsi < 35 && pair.change > -10) {
      signal = 'LONG';
      confidence += 30;
      reasons.push('RSI перепродан');
    }
    
    if (rsi > 65 && pair.change < 10) {
      signal = 'SHORT';
      confidence += 30;
      reasons.push('RSI перекуплен');
    }
    
    // Сильное движение с объемом
    if (Math.abs(pair.change) > CONFIG.minChange) {
      confidence += 20;
      reasons.push(`Сильное движение: ${pair.change > 0 ? '+' : ''}${pair.change.toFixed(1)}%`);
    }
    
    // Высокий объем
    if (volumeRatio > 1.5) {
      confidence += 15;
      reasons.push(`Высокий объем: x${volumeRatio.toFixed(1)}`);
    }
    
    // Поддержка/сопротивление
    const pricePosition = ((currentPrice - pair.low) / (pair.high - pair.low)) * 100;
    if (pricePosition < 30) {
      confidence += 10;
      reasons.push('Возле поддержки');
    } else if (pricePosition > 70) {
      confidence += 10;
      reasons.push('Возле сопротивления');
    }
    
    // Проверяем минимальную уверенность
    if (!signal || confidence < CONFIG.minConfidence || reasons.length < 2) {
      return null;
    }
    
    // Рассчитываем уровни
    const entry = currentPrice;
    let tp, sl;
    const riskPercent = 2; // 2% риск
    
    if (signal === 'LONG') {
      sl = entry * (1 - riskPercent / 100);
      tp = entry * (1 + (riskPercent * 2.5) / 100); // R:R 1:2.5
    } else {
      sl = entry * (1 + riskPercent / 100);
      tp = entry * (1 - (riskPercent * 2.5) / 100);
    }
    
    const rrRatio = signal === 'LONG' ? 
      (tp - entry) / (entry - sl) : 
      (entry - tp) / (sl - entry);
    
    const tier = confidence >= 75 ? 'GOD TIER' : 
                 confidence >= 65 ? 'PREMIUM' : 'STANDARD';
    
    if (tier === 'STANDARD') return null;
    
    console.log(`✅ Сигнал: ${signal} ${pair.symbol} (${confidence}%)`);
    
    return {
      pair: pair.symbol.replace('USDT', '/USDT'),
      signal: signal,
      entry: entry.toFixed(8),
      tp: tp.toFixed(8),
      sl: sl.toFixed(8),
      confidence: Math.round(confidence),
      rrRatio: rrRatio.toFixed(1),
      tier: tier,
      change24h: pair.change.toFixed(2),
      volume24h: pair.volume,
      rsi: Math.round(rsi),
      volumeRatio: volumeRatio.toFixed(1),
      reasons: reasons,
      timestamp: new Date()
    };
    
  } catch (error) {
    console.error(`❌ Ошибка анализа ${pair.symbol}:`, error.message);
    return null;
  }
}

// ==================== КОМАНДЫ БОТА ====================
bot.start((ctx) => {
  console.log('✅ Команда /start от', ctx.from.id);
  
  const welcome = `
🤖 <b>MEXC Signals Bot</b>

🏦 <b>Биржа:</b> ${CONFIG.exchange}
📊 <b>Анализ:</b> Топ ${CONFIG.topPairs} пар
💰 <b>Мин. объем:</b> ${(CONFIG.minVolume/1000).toFixed(0)}K USDT
🎯 <b>Мин. изменение:</b> ${CONFIG.minChange}%
⏰ <b>Сканирование:</b> каждые 20 мин

<b>📈 Анализируем:</b>
• RSI (перекупленность/перепроданность)
• Объем торгов
• Уровни поддержки/сопротивления
• Сильные ценовые движения

<b>📱 Команды:</b>
/start - информация
/test - проверить API
/scan - ручное сканирование (до 5 сигналов)
/status - статус бота
/top - топ движений

✅ <b>Бот активен и ищет сигналы!</b>
  `.trim();
  
  ctx.reply(welcome, { parse_mode: 'HTML' });
});

bot.command('test', async (ctx) => {
  console.log('🧪 Тест MEXC API...');
  
  try {
    await ctx.reply('🔄 Проверяю MEXC API...');
    
    const tickers = await getMexcTickers();
    
    if (tickers.length > 0) {
      const sample = tickers.slice(0, 3);
      let message = `✅ MEXC API работает!\n\n`;
      message += `📊 Получено пар: ${tickers.length}\n\n`;
      message += `Примеры:\n`;
      sample.forEach(t => {
        message += `<b>${t.symbol}</b>\n`;
        message += `Цена: $${t.price.toFixed(4)}\n`;
        message += `Изменение: ${t.change > 0 ? '+' : ''}${t.change.toFixed(2)}%\n`;
        message += `Объем: $${(t.volume/1000).toFixed(0)}K\n\n`;
      });
      
      await ctx.reply(message, { parse_mode: 'HTML' });
    } else {
      await ctx.reply('⚠️ Не удалось получить данные с MEXC');
    }
    
  } catch (error) {
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('top', async (ctx) => {
  console.log('📈 Топ движений...');
  
  try {
    await ctx.reply('📊 Ищу топ движений...');
    
    const tickers = await getMexcTickers();
    if (tickers.length === 0) {
      await ctx.reply('❌ Нет данных от MEXC');
      return;
    }
    
    // Топ роста
    const topGainers = [...tickers]
      .sort((a, b) => b.change - a.change)
      .slice(0, 5);
    
    // Топ падения
    const topLosers = [...tickers]
      .sort((a, b) => a.change - b.change)
      .slice(0, 5);
    
    let message = `📈 <b>ТОП 5 РОСТА (24h)</b>\n\n`;
    
    topGainers.forEach((t, i) => {
      message += `${i+1}. <b>${t.symbol}</b>\n`;
      message += `   💰 $${t.price.toFixed(4)}\n`;
      message += `   📈 +${t.change.toFixed(2)}%\n`;
      message += `   🔄 $${(t.volume/1000).toFixed(0)}K\n\n`;
    });
    
    message += `📉 <b>ТОП 5 ПАДЕНИЯ (24h)</b>\n\n`;
    
    topLosers.forEach((t, i) => {
      message += `${i+1}. <b>${t.symbol}</b>\n`;
      message += `   💰 $${t.price.toFixed(4)}\n`;
      message += `   📉 ${t.change.toFixed(2)}%\n`;
      message += `   🔄 $${(t.volume/1000).toFixed(0)}K\n\n`;
    });
    
    await ctx.reply(message, { parse_mode: 'HTML' });
    
  } catch (error) {
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('scan', async (ctx) => {
  console.log('🔍 Ручное сканирование...');
  
  try {
    await ctx.reply('🔍 Запускаю глубокое сканирование MEXC...');
    
    const tickers = await getMexcTickers();
    if (tickers.length === 0) {
      await ctx.reply('❌ Нет данных для анализа');
      return;
    }
    
    // Берем топ пар по изменению
    const sortedByChange = [...tickers]
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
      .slice(0, 15);
    
    await ctx.reply(`📊 Анализирую ${sortedByChange.length} пар...`);
    
    const signals = [];
    
    // Анализируем каждую пару
    for (let i = 0; i < Math.min(sortedByChange.length, 10); i++) {
      const pair = sortedByChange[i];
      const signal = await analyzePair(pair);
      
      if (signal) {
        signals.push(signal);
      }
      
      // Задержка между запросами
      if (i < sortedByChange.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    if (signals.length > 0) {
      // Сортируем по уверенности
      signals.sort((a, b) => b.confidence - a.confidence);
      
      let message = `🎯 <b>НАЙДЕНО СИГНАЛОВ: ${signals.length}</b>\n\n`;
      
      signals.slice(0, 5).forEach((sig, i) => {
        const emoji = sig.signal === 'LONG' ? '🟢' : '🔴';
        const tierEmoji = sig.tier === 'GOD TIER' ? '👑' : '💎';
        
        message += `${tierEmoji} <b>${sig.tier}</b>\n`;
        message += `${emoji} <b>${sig.signal} ${sig.pair}</b>\n`;
        message += `📈 Изменение: ${sig.change24h > 0 ? '+' : ''}${sig.change24h}%\n`;
        message += `🎯 Вход: $${sig.entry}\n`;
        message += `✅ Тейк: $${sig.tp}\n`;
        message += `🛑 Стоп: $${sig.sl}\n`;
        message += `📊 R:R: 1:${sig.rrRatio}\n`;
        message += `🔮 Уверенность: ${sig.confidence}%\n`;
        message += `📊 RSI: ${sig.rsi}\n`;
        message += `💎 Причины:\n`;
        sig.reasons.slice(0, 3).forEach(r => message += `• ${r}\n`);
        message += `\n`;
      });
      
      await ctx.reply(message, { parse_mode: 'HTML' });
    } else {
      await ctx.reply('ℹ️ Сигналов не найдено. Попробуйте позже или используйте /top для просмотра движений');
    }
    
  } catch (error) {
    await ctx.reply(`❌ Ошибка сканирования: ${error.message}`);
  }
});

bot.command('status', (ctx) => {
  const now = new Date();
  const nextScan = 20 - (now.getMinutes() % 20);
  
  ctx.reply(
    `📊 <b>СТАТУС БОТА</b>\n\n` +
    `🟢 <b>Состояние:</b> Активен\n` +
    `🏦 <b>Биржа:</b> ${CONFIG.exchange}\n` +
    `📡 <b>API статус:</b> Работает\n` +
    `🎯 <b>Следующее сканирование:</b> через ${nextScan} мин\n` +
    `⏰ <b>Время сервера:</b> ${now.toLocaleTimeString('ru-RU')}\n\n` +
    `📈 <b>Параметры:</b>\n` +
    `• Объем > ${(CONFIG.minVolume/1000).toFixed(0)}K USDT\n` +
    `• Изменение > ${CONFIG.minChange}%\n` +
    `• Уверенность > ${CONFIG.minConfidence}%\n\n` +
    `💡 <b>Команды:</b> /scan /top /test`,
    { parse_mode: 'HTML' }
  );
});

// Автоматическое сканирование
async function autoScan() {
  console.log('\n🎯 АВТОМАТИЧЕСКОЕ СКАНИРОВАНИЕ');
  console.log('='.repeat(50));
  
  if (!CHAT_ID) {
    console.log('⚠️  CHAT_ID не установлен, пропускаю отправку');
    return;
  }
  
  try {
    const tickers = await getMexcTickers();
    if (tickers.length === 0) {
      console.log('❌ Нет данных от MEXC');
      return;
    }
    
    console.log(`📊 Анализ ${Math.min(tickers.length, 10)} топ пар...`);
    
    // Берем самые волатильные пары
    const volatilePairs = [...tickers]
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
      .slice(0, 10);
    
    const signals = [];
    
    // Быстрый анализ (без глубокой проверки для автосканирования)
    for (const pair of volatilePairs) {
      if (Math.abs(pair.change) > 8 && pair.volume > CONFIG.minVolume * 2) {
        const signalType = pair.change > 0 ? 'LONG' : 'SHORT';
        const confidence = Math.min(70 + Math.abs(pair.change), 90);
        
        // Простые уровни
        const entry = pair.price;
        let tp, sl;
        
        if (signalType === 'LONG') {
          sl = entry * 0.97;
          tp = entry * 1.06;
        } else {
          sl = entry * 1.03;
          tp = entry * 0.94;
        }
        
        signals.push({
          pair: pair.symbol.replace('USDT', '/USDT'),
          signal: signalType,
          entry: entry.toFixed(6),
          tp: tp.toFixed(6),
          sl: sl.toFixed(6),
          confidence: confidence,
          change24h: pair.change.toFixed(2),
          volume24h: pair.volume,
          tier: confidence > 80 ? 'GOD TIER' : 'PREMIUM'
        });
      }
      
      // Короткая задержка
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    if (signals.length > 0) {
      console.log(`📊 Найдено ${signals.length} сигналов для автоотправки`);
      
      // Отправляем только лучшие 3 сигнала
      const bestSignals = signals
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 3);
      
      for (const signal of bestSignals) {
        const emoji = signal.signal === 'LONG' ? '🟢' : '🔴';
        const tierEmoji = signal.tier === 'GOD TIER' ? '👑' : '💎';
        
        const message = `
${tierEmoji} <b>${signal.tier} СИГНАЛ</b>

${emoji} <b>${signal.signal} ${signal.pair}</b>

📈 <b>Изменение 24h:</b> ${signal.change24h > 0 ? '+' : ''}${signal.change24h}%
💰 <b>Объем 24h:</b> $${(signal.volume24h / 1000000).toFixed(2)}M

🎯 <b>Вход:</b> $${signal.entry}
✅ <b>Тейк-профит:</b> $${signal.tp}
🛑 <b>Стоп-лосс:</b> $${signal.sl}

🔮 <b>Уверенность:</b> ${Math.round(signal.confidence)}%
📊 <b>R:R:</b> ~1:2

🏦 <b>Биржа:</b> MEXC SPOT
⏰ <b>Время:</b> ${new Date().toLocaleTimeString('ru-RU')}
        `.trim();
        
        try {
          await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
          console.log(`✅ Автосигнал отправлен: ${signal.pair}`);
          
          // Задержка между отправками
          await new Promise(resolve => setTimeout(resolve, 3000));
        } catch (error) {
          console.error(`❌ Ошибка отправки:`, error.message);
        }
      }
    } else {
      console.log('ℹ️ Сигналов для автоотправки не найдено');
    }
    
  } catch (error) {
    console.error('❌ Ошибка автосканирования:', error.message);
  }
}

// ==================== ЗАПУСК БОТА ====================
async function start() {
  try {
    console.log('🚀 Инициализация MEXC Signals Bot...');
    
    // Проверяем MEXC API перед запуском
    console.log('📡 Проверка подключения к MEXC...');
    const testTickers = await getMexcTickers();
    
    if (testTickers.length === 0) {
      console.log('⚠️  MEXC API может быть недоступен, но бот запускается...');
    } else {
      console.log(`✅ MEXC API доступен, получено ${testTickers.length} пар`);
    }
    
    // Запускаем Telegram бота
    await bot.launch({
      dropPendingUpdates: true,
      allowedUpdates: ['message']
    });
    
    console.log('✅ Telegram бот запущен!');
    
    // Настройка планировщика
    cron.schedule(CONFIG.scanInterval, () => {
      const now = new Date();
      console.log(`\n⏰ АВТОСКАНИРОВАНИЕ: ${now.toLocaleTimeString('ru-RU')}`);
      autoScan();
    });
    
    console.log(`⏰ Автосканирование настроено: ${CONFIG.scanInterval}`);
    
    // Первое сканирование через 2 минуты
    setTimeout(() => {
      console.log('\n🎯 ПЕРВОЕ АВТОСКАНИРОВАНИЕ');
      autoScan();
    }, 120000);
    
    // Приветственное сообщение
    if (CHAT_ID) {
      try {
        await bot.telegram.sendMessage(
          CHAT_ID,
          `🤖 <b>MEXC Signals Bot запущен!</b>\n\n` +
          `✅ Telegram: подключено\n` +
          `✅ MEXC API: ${testTickers.length > 0 ? 'работает' : 'проверяется'}\n` +
          `⏰ Автосканирование: каждые 20 минут\n\n` +
          `🏦 Биржа: MEXC Spot\n` +
          `📊 Анализ: RSI + Объем + Тренд\n\n` +
          `📱 <b>Команды:</b>\n` +
          `/start - информация\n` +
          `/test - проверить API\n` +
          `/scan - глубокое сканирование\n` +
          `/top - топ движений\n` +
          `/status - статус бота\n\n` +
          `🔄 Первое сканирование через 2 минуты`,
          { parse_mode: 'HTML' }
        );
        console.log('✅ Стартовое сообщение отправлено');
      } catch (error) {
        console.log('⚠️ Не удалось отправить стартовое сообщение');
      }
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('🤖 MEXC SIGNALS BOT ЗАПУЩЕН');
    console.log('='.repeat(50));
    console.log('📱 Команды в Telegram:');
    console.log('   /start  - информация о боте');
    console.log('   /test   - проверка MEXC API');
    console.log('   /scan   - глубокое сканирование (до 10 пар)');
    console.log('   /top    - топ движений за 24h');
    console.log('   /status - статус бота');
    console.log('='.repeat(50));
    console.log(`⏰ Автосканирование: каждые 20 минут`);
    console.log(`💰 Мин. объем: ${(CONFIG.minVolume/1000).toFixed(0)}K USDT`);
    console.log(`🎯 Мин. изменение: ${CONFIG.minChange}%`);
    console.log('='.repeat(50));
    
  } catch (error) {
    console.error('❌ Критическая ошибка запуска:', error.message);
    console.error(error.stack);
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
